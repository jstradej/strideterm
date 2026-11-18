import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RegistryConnection } from "../../shared/registry.js";
import { SANDBOX_AGENT_IDS } from "../../shared/sandbox.js";
import { getAgentSandboxProfile, mirrorExclusions, mirroredAgentFolders } from "./agent-profile.js";
import { SandboxGateway } from "./gateway.js";
import { SANDBOX_LAUNCHER_SOURCE } from "./launcher-script.js";
import { execRunner, type CommandRunner } from "./sandbox-environment.js";
import { buildSandboxPolicy } from "./sandbox-policy.js";
import { SandboxService } from "./sandbox-service.js";

/**
 * Real run on a native macOS or Linux host: the service builds the launch, the launcher starts the sandbox runtime
 * (Seatbelt / bubblewrap) and a shell runs in it. Needs the pinned sandbox runtime where strIDEterm installs it
 * (`~/.local/share/strideterm/sandbox-runtime`, or STRIDETERM_SANDBOX_SRT_MODULE) and, on Linux, bubblewrap, socat and
 * ripgrep. Off by default:
 *   STRIDETERM_SANDBOX_E2E=1 npx vitest run --config vitest.backend.config.ts electron/backend/sandbox/sandbox-native.e2e.test.ts
 *
 * Three scenarios are MANUAL ONLY and never run in CI/CD: they depend on a third-party server (example.com and its
 * certificate chain) or on the developer's own login keychain, so they are not repeatable. They need
 * STRIDETERM_SANDBOX_E2E_MANUAL=1 as well and are skipped whenever CI is set.
 *
 * Isolation of the developer's real data: the SandboxService scenarios run a plain `bash` panel (no agent profile), so
 * the launcher never mirrors or seeds an agent folder and never writes credentials back. The agent-folder scenarios do
 * not use the service at all: they build the policy and the launch file by hand against a FIXTURE home.
 */
const enabled = process.platform !== "win32" && process.env.STRIDETERM_SANDBOX_E2E === "1";
/** Scenarios that reach the internet or the developer's login keychain: run by hand, never in CI/CD. */
const manual = enabled && process.env.STRIDETERM_SANDBOX_E2E_MANUAL === "1" && !process.env.CI;
const REGISTRY_SECRET = "registry-secret";
const REGISTRY_USER = "svc";
const policyOs = process.platform === "darwin" ? "darwin" : "linux";
const realHome = os.homedir();
const srtModule =
  process.env.STRIDETERM_SANDBOX_SRT_MODULE ||
  path.join(
    realHome,
    ".local/share/strideterm/sandbox-runtime/node_modules/@anthropic-ai/sandbox-runtime/dist/index.js",
  );
const srtPresent = existsSync(srtModule);
/** The runtime sits in the home folder, so that one entry is visible by design (it is read-only). */
const srtHomeEntry = path.relative(realHome, srtModule).split(path.sep)[0] || "-none-";

describe.runIf(enabled)("sandbox on a native host (end to end)", () => {
  const dirs: string[] = [];
  const hostCanaries: string[] = [];
  let service: SandboxService;
  let dataDir: string;
  let workspaceDir: string;
  let registryServer: http.Server;
  let registryRequests: Array<{ url?: string; authorization?: string }>;
  let registries: RegistryConnection[] = [];

  /** A temp folder with its symlinks resolved (macOS: /var -> /private/var). */
  const temp = (name: string) => {
    const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), `sbx-e2e-${name}-`)));
    dirs.push(dir);
    return dir;
  };

  const run: CommandRunner = async (file, args, options) => {
    // The probe runs `codex --version`; this test never needs to execute the real agent CLIs.
    const patched = args.map((arg) => arg.replace('"$codex_path" --version', "true"));
    return execRunner(file, patched, options);
  };

  beforeAll(async () => {
    registryRequests = [];
    registryServer = http.createServer((req, res) => {
      registryRequests.push({ url: req.url, authorization: req.headers.authorization });
      res.end("from-the-registry");
    });
    await new Promise<void>((resolve) => registryServer.listen(0, "127.0.0.1", () => resolve()));
    dataDir = temp("data");
    workspaceDir = temp("ws");
    mkdirSync(path.join(workspaceDir, ".claude"));
    writeFileSync(path.join(workspaceDir, "a.txt"), "hello");
    service = new SandboxService({
      dataDir,
      gateway: new SandboxGateway({
        audit: {
          begin: () => true,
          end: () => undefined,
          flush: () => undefined,
          beginOperation: () => () => undefined,
        },
        resolveRegistry: (id) => {
          const connection = registries.find((item) => item.id === id);
          return connection ? { connection, secret: REGISTRY_SECRET } : null;
        },
      }),
      run,
      getRegistries: () => registries,
      getWorkspaceDomains: () => [],
      onDenied: () => undefined,
      onDeniedSettled: () => undefined,
      askTimeoutMs: 4000,
    });
    service.writeLauncher();
  });

  afterAll(async () => {
    registryServer?.close();
    await service?.shutdown();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
    // A canary that reached the real home would be an isolation failure; never leave it behind either way.
    for (const file of hostCanaries.splice(0)) rmSync(file, { force: true });
  });

  /** A plain `bash` panel: no agent profile, so nothing of the developer's agent folders is read or written. */
  function context(sessionId: string, cwd = workspaceDir, workspaceId = "e2e") {
    return {
      sessionId,
      workspace: { id: workspaceId, profileId: "default", kind: "terminal", cwd, sandboxEnabled: true },
      panel: { id: "p", command: "bash" },
      cwd,
    };
  }

  /** Runs `script` in an isolated bash; `onTick` runs every 200 ms while it does (the "user" answering requests). */
  async function runShell(
    sessionId: string,
    script: string,
    onTick?: () => void,
    env: Record<string, string> = {},
    cwd = workspaceDir,
  ) {
    const ctx = context(sessionId, cwd);
    await service.prepare(ctx);
    const launch = service.wrap({
      ...ctx,
      launcher: { file: "/bin/bash", args: [] },
      env: { TERM: "xterm", HOME: realHome, ...env },
    });
    return new Promise<string>((resolve) => {
      const child = spawn(launch.file, launch.args, { env: { ...process.env, ...launch.env }, cwd: launch.cwd });
      let output = "";
      child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
      child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));
      const timer = setInterval(() => onTick?.(), 200);
      const killer = setTimeout(() => child.kill("SIGKILL"), 90_000);
      child.on("close", () => {
        clearInterval(timer);
        clearTimeout(killer);
        resolve(output);
      });
      child.stdin.end(`${script}\nexit\n`);
    });
  }

  it("runs a shell isolated from the home directory, the host's tokens and the network", async () => {
    const output = await runShell(
      "e2e:1",
      [
        "pwd",
        "cat a.txt",
        "echo wrote > b.txt && echo write-ok",
        "echo x > .claude/y 2>/dev/null && echo claude-writable || echo claude-protected",
        'echo "token=[$GITHUB_TOKEN]"',
        `ls ~ 2>&1 >/dev/null | head -1 | sed "s/^/home-ls-stderr: /"`,
        `ls ~ 2>/dev/null | grep -v '^${srtHomeEntry}$' | wc -l | tr -d ' ' | sed "s/^/home-entries=/"`,
        "curl -s -m 6 -o /dev/null -w 'example=%{http_code}\\n' https://example.com 2>&1",
      ].join("\n"),
      undefined,
      { GITHUB_TOKEN: "host-token-must-not-leak", STRIDETERM_SESSION_ID: "e2e:1" },
    );
    expect(output).toContain("hello");
    expect(output).toContain("write-ok");
    expect(output).toContain("claude-protected");
    expect(output).toContain("token=[]");
    expect(output).toContain("home-entries=0");
    expect(output).toMatch(/example=(000|403)/u);
    expect(readFileSync(path.join(workspaceDir, "b.txt"), "utf8").trim()).toBe("wrote");
    // The destination the sandbox was refused is recorded for the user to decide on.
    service.pollDenials();
    expect(service.listPending("e2e").map((request) => request.host)).toContain("example.com");
    expect(existsSync(path.join(dataDir, "sandbox", "sessions"))).toBe(true);
  }, 120_000);

  // ---- Manual only (STRIDETERM_SANDBOX_E2E_MANUAL=1, never in CI/CD) ------------------------------------------------

  /** Answers every pending request with "allow", as the user would. */
  const allowAll = () => {
    service.pollDenials();
    for (const request of service.listPending("e2e")) service.decide(request.id, true);
  };

  // Manual: needs the internet. Certificate verification is off on purpose; this is about the decision reaching the
  // sandbox, and the scenario below is the one about trust.
  it.runIf(manual)(
    "waits for the user on a destination nothing decides and lets the connection through when they allow it",
    async () => {
      const output = await runShell(
        "e2e:allow",
        "curl -sSk -m 20 -o /dev/null -w 'example=%{http_code}\\n' https://example.com 2>&1",
        allowAll,
      );
      expect(output).toMatch(/example=[1-5][0-9][0-9]/u);
    },
    120_000,
  );

  // Manual: needs the internet and depends on example.com's certificate chain. KNOWN TO FAIL ON macOS: the system curl
  // cannot verify that chain inside Seatbelt, while it verifies github.com, registry.npmjs.org, pypi.org and
  // repo.maven.apache.org there. `enableWeakerNetworkIsolation` (trustd) does not change it; the cause is not known.
  it.runIf(manual)(
    "verifies an allowed host's certificate with the system trust store",
    async () => {
      const output = await runShell(
        "e2e:trust",
        "curl -sS -m 20 -o /dev/null -w 'example=%{http_code}\\n' https://example.com 2>&1",
        allowAll,
      );
      expect(output).toMatch(/example=[1-5][0-9][0-9]/u);
    },
    120_000,
  );

  // Manual: adds one throwaway item with a fake value to the developer's login keychain and removes it again. macOS
  // keeps tokens for other services there (Git's osxkeychain helper, agent sign-ins); the sandbox must not read them.
  it.runIf(manual && process.platform === "darwin")(
    "does not hand a secret from the login keychain to the sandbox",
    async (testContext) => {
      const item = `strideterm-sbx-e2e-${randomUUID()}`;
      const fake = `fake-keychain-value-${randomUUID()}`;
      const security = (...args: string[]) =>
        spawnSync("/usr/bin/security", args, { encoding: "utf8", timeout: 20_000 });
      const find = ["find-generic-password", "-a", "e2e", "-s", item, "-w"];
      const added = security("add-generic-password", "-a", "e2e", "-s", item, "-w", fake);
      let output: string;
      try {
        // Without an item the host itself can read back, the assertion below would prove nothing.
        if (added.status !== 0 || security(...find).stdout.trim() !== fake) {
          testContext.skip();
          return;
        }
        output = await runShell("e2e:keychain", `/usr/bin/security ${find.join(" ")} 2>&1; echo "rc=$?"`);
      } finally {
        if (added.status === 0) expect(security("delete-generic-password", "-a", "e2e", "-s", item).status).toBe(0);
      }
      expect(output).toMatch(/rc=\d+/u);
      expect(output).not.toContain(fake);
    },
    120_000,
  );

  function connectionFor(
    id: string,
    kind: RegistryConnection["kind"],
    port: number,
    pathPrefix: string,
  ): RegistryConnection {
    return {
      id,
      profileId: "default",
      label: `Private ${kind}`,
      kind,
      url: `http://127.0.0.1:${port}${pathPrefix}`,
      mode: "mirror",
      authKind: "basic",
      username: REGISTRY_USER,
      npmScope: "",
    };
  }

  const sessionTools = (sessionId: string) =>
    path.join(dataDir, "sandbox", "sessions", sessionId.replace(/[^A-Za-z0-9._-]/gu, "_"), "tools");

  it("reads a private registry through the host gateway, which adds the sign-in the sandbox never sees", async () => {
    registries = [connectionFor("r1", "maven", (registryServer.address() as AddressInfo).port, "/repo")];
    const settings = path.join(sessionTools("e2e:registry"), "settings.xml");
    const output = await runShell(
      "e2e:registry",
      [
        `url=$(grep -o "http://gateway[^<]*" ${settings} | head -1)`,
        'echo "url=$url"',
        'curl -s -m 20 "$url/org/a.jar"',
        "echo",
        `echo "secret-in-config=$(grep -c registry-secret ${settings})"`,
      ].join("\n"),
    );
    expect(output).toContain("from-the-registry");
    expect(registryRequests[0]?.url).toBe("/repo/org/a.jar");
    expect(registryRequests[0]?.authorization).toBe(`Basic ${Buffer.from("svc:registry-secret").toString("base64")}`);
    expect(output).toContain("secret-in-config=0");
  }, 120_000);

  it("keeps the tool configuration where the sandbox can read it but not write it", async () => {
    registries = [connectionFor("m1", "maven", 1, "/maven")];
    const tools = sessionTools("e2e:rotools");
    const output = await runShell(
      "e2e:rotools",
      [
        `cat ${tools}/settings.xml > /dev/null && echo tools-readable`,
        `echo planted > ${tools}/settings.xml 2>/dev/null && echo tools-writable || echo tools-protected`,
        `ln -s /etc ${tools}/link 2>/dev/null && echo link-created || echo link-refused`,
      ].join("\n"),
    );
    expect(output).toContain("tools-readable");
    expect(output).toContain("tools-protected");
    expect(output).toContain("link-refused");
    expect(readFileSync(path.join(tools, "settings.xml"), "utf8")).not.toContain("planted");
    expect(existsSync(path.join(tools, "link"))).toBe(false);
  }, 120_000);

  it("fails visibly on a write outside every grant, and nothing reaches the host", async () => {
    const id = Math.random().toString(36).slice(2, 10);
    // The sibling sits next to the workspace, in a parent folder no grant names.
    const parent = temp("parent");
    const ws = path.join(parent, "ws");
    const sibling = path.join(parent, "sibling");
    mkdirSync(ws);
    mkdirSync(sibling);
    const homeCanary = path.join(realHome, `.strideterm-e2e-canary-${id}`);
    hostCanaries.push(homeCanary);
    const siblingCanary = path.join(sibling, "canary");
    const output = await runShell(
      "e2e:outside",
      [
        `echo x > "$HOME/.strideterm-e2e-canary-${id}" 2>&1 && echo home-write-ok || echo home-write-failed`,
        `echo x > ${siblingCanary} 2>&1 && echo sibling-write-ok || echo sibling-write-failed`,
        `mkdir ${sibling}/dir 2>&1 && echo sibling-mkdir-ok || echo sibling-mkdir-failed`,
        `echo x > ${path.join(parent, "parent-canary")} 2>&1 && echo parent-write-ok || echo parent-write-failed`,
      ].join("\n"),
      undefined,
      {},
      ws,
    );
    expect(output).toContain("home-write-failed");
    expect(output).toContain("sibling-write-failed");
    expect(output).toContain("sibling-mkdir-failed");
    expect(output).toContain("parent-write-failed");
    expect(existsSync(homeCanary)).toBe(false);
    expect(existsSync(siblingCanary)).toBe(false);
    expect(existsSync(path.join(sibling, "dir"))).toBe(false);
    expect(existsSync(path.join(parent, "parent-canary"))).toBe(false);
  }, 120_000);

  // ---- Agent folders: hand-built policy and launch file against a FIXTURE home -------------------------------------
  //
  // These bypass SandboxService on purpose: rewriting the probe's `home=` line would not redirect it completely (the
  // probe script, the `.strideterm-hooks` read grant and the workspace-root guard read the real home). Here every path,
  // including the launcher's HOME, is under a temp folder.

  interface Fixture {
    root: string;
    home: string;
    workspace: string;
    tools: string;
    cache: string;
    sandboxHome: string;
  }

  function makeFixture(name: string): Fixture {
    const root = temp(name);
    const fixture = {
      root,
      home: path.join(root, "home"),
      workspace: path.join(root, "workspace"),
      tools: path.join(root, "tools"),
      cache: path.join(root, "cache"),
      sandboxHome: path.join(root, "sandbox-home"),
    };
    for (const dir of [fixture.home, fixture.workspace, fixture.tools, fixture.cache])
      mkdirSync(dir, { recursive: true });
    return fixture;
  }

  function putFile(file: string, content: string) {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, content);
  }

  /** Runs the launcher by hand, with HOME pointing at the fixture, and returns everything the script printed. */
  function runLauncher(
    fixture: Fixture,
    config: Record<string, unknown>,
    env: Record<string, string> = {},
    timeout = 90_000,
  ): string {
    const launcher = path.join(fixture.root, "launcher.mjs");
    const configFile = path.join(fixture.root, "launch.json");
    writeFileSync(launcher, SANDBOX_LAUNCHER_SOURCE);
    writeFileSync(
      configFile,
      JSON.stringify({
        srtModule,
        sessionId: "fixture",
        askTimeoutMs: 100,
        denialsFile: path.join(fixture.root, "denials.jsonl"),
        decisionsDir: path.join(fixture.root, "decisions"),
        toolFiles: [],
        loginLinks: [],
        keepEnv: [],
        unsetEnv: [],
        ...config,
      }),
    );
    const result = spawnSync(process.execPath, [launcher, configFile], {
      cwd: fixture.workspace,
      encoding: "utf8",
      timeout,
      env: { PATH: process.env.PATH, TERM: "xterm", HOME: fixture.home, ...env },
    });
    return `${result.stdout}\n${result.stderr}`;
  }

  const srtReadPath = path.dirname(path.dirname(srtModule));

  const absentCases = [
    { provider: "codex", relative: ".codex/config.toml" },
    { provider: "opencode", relative: ".config/opencode/plugins/evil.js" },
  ];
  for (const { provider, relative } of absentCases)
    it.runIf(srtPresent)(
      `does not let a sandboxed ${provider} create host-loaded config that is not there yet`,
      () => {
        const fixture = makeFixture(`absent-${provider}`);
        const target = path.join(fixture.home, relative);
        const policy = buildSandboxPolicy({
          os: policyOs,
          home: fixture.home,
          roots: [fixture.workspace],
          gitDirs: [],
          readPaths: [srtReadPath],
          readWritePaths: [],
          agent: getAgentSandboxProfile(provider),
          toolchains: [],
          cacheRoot: fixture.cache,
          workspaceDomains: [],
          toolConfigDir: fixture.tools,
        });
        const script = `mkdir -p ${path.dirname(target)} 2>&1; printf planted > ${target} 2>&1 && echo planted || echo refused`;
        runLauncher(fixture, {
          ensureDirs: policy.ensureDirs,
          optional: policy.optional,
          command: ["/bin/sh", "-c", script],
          runtime: policy.runtime,
        });
        // The launcher may create the agent's own folder (ensureDirs); what matters is that the file is not in it.
        expect(existsSync(target)).toBe(false);
      },
      150_000,
    );

  it.runIf(srtPresent)(
    "gives a sandboxed Claude its own .claude.json and leaves the host's MCP definitions and unnamed STRIDETERM_ variables out",
    () => {
      const fixture = makeFixture("state");
      const hostFile = path.join(fixture.home, ".claude.json");
      const original =
        '{"mcpServers":{"host":{"command":"never-run","env":{"GITHUB_TOKEN":"INERT_NON_MODEL_MCP_SECRET"}}}}';
      mkdirSync(path.join(fixture.home, ".claude"));
      writeFileSync(hostFile, original);
      const agent = getAgentSandboxProfile("claude");
      const policy = buildSandboxPolicy({
        os: policyOs,
        home: fixture.home,
        roots: [fixture.workspace],
        gitDirs: [],
        readPaths: [srtReadPath],
        readWritePaths: [],
        workspaceHomes: [fixture.sandboxHome],
        agent,
        toolchains: [],
        cacheRoot: fixture.cache,
        workspaceDomains: [],
        toolConfigDir: fixture.tools,
      });
      const script = [
        `grep -q INERT_NON_MODEL_MCP_SECRET "$HOME/.claude.json" 2>/dev/null && echo seed-secret-visible || echo seed-secret-absent`,
        `printf '{"own":true}' > "$HOME/.claude.json" 2>/dev/null && echo own-copy-writable || echo own-copy-refused`,
        `grep -q never-run ${hostFile} 2>/dev/null && echo host-readable || echo host-hidden`,
        `printf '{"planted":true}' > ${hostFile} 2>/dev/null; true`,
        `test -n "$STRIDETERM_HOST_TOKEN" && echo token-leaked || echo token-absent`,
      ].join("; ");
      const output = runLauncher(
        fixture,
        {
          ensureDirs: policy.ensureDirs,
          confinedLinks: [
            {
              link: path.join(fixture.sandboxHome, ".claude"),
              target: path.join(fixture.home, ".claude"),
              root: fixture.sandboxHome,
            },
          ],
          seededFiles: [
            {
              sources: [hostFile],
              dest: path.join(fixture.sandboxHome, ".claude.json"),
              root: fixture.sandboxHome,
              filter: "claude-state",
            },
          ],
          homeOverride: fixture.sandboxHome,
          optional: policy.optional,
          command: ["/bin/sh", "-c", script],
          runtime: policy.runtime,
        },
        { STRIDETERM_HOST_TOKEN: "inert" },
      );
      expect(output).toContain("seed-secret-absent");
      expect(output).not.toContain("INERT_NON_MODEL_MCP_SECRET");
      expect(output).toContain("own-copy-writable");
      // Seatbelt reads the host's home by default only where a deny names it: the fixture home is denied by the policy.
      expect(output).toContain("host-hidden");
      expect(output).toContain("token-absent");
      expect(readFileSync(hostFile, "utf8")).toBe(original);
      expect(readFileSync(path.join(fixture.sandboxHome, ".claude.json"), "utf8")).toBe('{"own":true}');
    },
    150_000,
  );

  // ---- Credentials of tools other than the model, in the agents' shared config folders ---------------------------------
  const SHARED_CONFIG_FIXTURES: Record<
    string,
    { files: Record<string, string>; login: string; setting: string; configs: string[] }
  > = {
    codex: {
      files: {
        ".codex/config.toml":
          'keep_me = "NONSECRET_SETTING"\n[mcp_servers.hostGit]\ncommand = "never-run"\n[mcp_servers.hostGit.env]\nGITHUB_TOKEN = "INERT_NON_MODEL_MCP_SECRET"\n',
        ".codex/auth.json": '{"login":"MODEL_LOGIN_KEPT"}',
        ".codex/hooks.json": JSON.stringify({
          hooks: {
            Stop: [
              {
                matcher: "",
                hooks: [
                  { type: "command", command: "echo INERT_NON_MODEL_MCP_SECRET" },
                  { type: "command", command: 'node "/host/.strideterm/hooks/notify.mjs" Stop' },
                ],
              },
            ],
          },
        }),
      },
      login: ".codex/auth.json",
      setting: ".codex/config.toml",
      configs: [".codex/config.toml", ".codex/hooks.json"],
    },
    claude: {
      files: {
        ".claude/settings.json":
          '{"keepMe":"NONSECRET_SETTING","env":{"GITHUB_TOKEN":"INERT_NON_MODEL_MCP_SECRET"},"hooks":{"Stop":[{"matcher":"","hooks":[{"type":"command","command":"echo INERT_NON_MODEL_MCP_SECRET"},{"type":"command","command":"node \\"/host/.strideterm/hooks/notify.mjs\\" Stop"}]}]}}',
        ".claude/settings.local.json":
          '{"mcpServers":{"x":{"headers":{"Authorization":"INERT_NON_MODEL_MCP_SECRET"}}}}',
        ".claude/.credentials.json":
          '{"claudeAiOauth":{"accessToken":"MODEL_LOGIN_KEPT","refreshToken":"r","expiresAt":1},"mcpOAuth":{"hostGit":{"accessToken":"INERT_NON_MODEL_MCP_SECRET"}}}',
      },
      login: ".claude/.credentials.json",
      setting: ".claude/settings.json",
      configs: [".claude/settings.json", ".claude/settings.local.json", ".claude/.credentials.json"],
    },
    gemini: {
      files: {
        ".gemini/settings.json":
          '{"keepMe":"NONSECRET_SETTING","mcpServers":{"hostGit":{"command":"never-run","env":{"GITHUB_TOKEN":"INERT_NON_MODEL_MCP_SECRET"}}}}',
        ".gemini/.env": "GITHUB_TOKEN=INERT_NON_MODEL_MCP_SECRET\nGEMINI_API_KEY=MODEL_LOGIN_KEPT\n",
        ".gemini/oauth_creds.json": '{"login":"MODEL_LOGIN_KEPT"}',
        ".gemini/mcp-oauth-tokens.json": '{"hostGit":{"token":"INERT_NON_MODEL_MCP_SECRET"}}',
      },
      login: ".gemini/oauth_creds.json",
      setting: ".gemini/settings.json",
      configs: [".gemini/settings.json", ".gemini/.env"],
    },
    copilot: {
      files: {
        ".copilot/mcp-config.json":
          '{"keepMe":"NONSECRET_SETTING","mcpServers":{"hostGit":{"command":"never-run","env":{"GITHUB_TOKEN":"INERT_NON_MODEL_MCP_SECRET"}}}}',
        ".copilot/config.json": JSON.stringify({
          model: "MODEL_SETTING_KEPT",
          lastLoggedInUser: { host: "https://github.com", login: "fixture-user" },
          copilotTokens: { "https://github.com:fixture-user": "MODEL_LOGIN_KEPT" },
          hooks: {
            sessionEnd: [
              { type: "command", bash: "echo INERT_NON_MODEL_MCP_SECRET" },
              { type: "command", bash: 'node "/host/.strideterm/hooks/notify.mjs" Stop' },
            ],
          },
        }),
      },
      login: "",
      setting: ".copilot/mcp-config.json",
      configs: [".copilot/mcp-config.json", ".copilot/config.json"],
    },
    opencode: {
      files: {
        ".config/opencode/opencode.json":
          '{"keepMe":"NONSECRET_SETTING","mcp":{"hostGit":{"type":"local","command":["never-run"],"environment":{"GITHUB_TOKEN":"INERT_NON_MODEL_MCP_SECRET"}}}}',
        ".local/share/opencode/auth.json": '{"login":"MODEL_LOGIN_KEPT"}',
        ".local/share/opencode/mcp-auth.json": '{"hostGit":{"tokens":"INERT_NON_MODEL_MCP_SECRET"}}',
      },
      login: ".local/share/opencode/auth.json",
      setting: ".config/opencode/opencode.json",
      configs: [".config/opencode/opencode.json"],
    },
  };
  it("has a fixture for every sandbox agent", () => {
    expect(Object.keys(SHARED_CONFIG_FIXTURES).sort()).toEqual([...SANDBOX_AGENT_IDS].sort());
  });

  for (const provider of Object.keys(SHARED_CONFIG_FIXTURES)) {
    it.runIf(srtPresent)(
      `keeps a ${provider} agent's other-tool credentials out of the sandbox, and keeps its settings and model sign-in`,
      () => {
        const fixture = makeFixture(`cfg-${provider}`);
        const spec = SHARED_CONFIG_FIXTURES[provider];
        const agent = getAgentSandboxProfile(provider)!;
        for (const [relative, content] of Object.entries(spec.files))
          putFile(path.join(fixture.home, relative), content);
        if (["codex", "copilot"].includes(provider)) {
          const relative = provider === "codex" ? ".codex/hooks.json" : ".copilot/config.json";
          mkdirSync(path.dirname(path.join(fixture.sandboxHome, relative)), { recursive: true });
          // symlinkSync via ln keeps this identical to the WSL fixture
          spawnSync("ln", ["-s", path.join(fixture.home, relative), path.join(fixture.sandboxHome, relative)]);
        }
        const policy = buildSandboxPolicy({
          os: policyOs,
          home: fixture.home,
          roots: [fixture.workspace],
          gitDirs: [],
          readPaths: [srtReadPath],
          readWritePaths: [],
          workspaceHomes: [fixture.sandboxHome],
          agent,
          toolchains: [],
          cacheRoot: fixture.cache,
          workspaceDomains: [],
          toolConfigDir: fixture.tools,
        });
        const mirrored = mirroredAgentFolders(agent);
        const folders = [...new Set([...agent.readHome, ...agent.writeHome])];
        const script = [
          `grep -RqsI INERT_NON_MODEL_MCP_SECRET "$HOME" ${fixture.home} 2>/dev/null && echo secret-visible || echo secret-hidden`,
          ...(provider === "copilot"
            ? [
                `test "$COPILOT_GITHUB_TOKEN" = MODEL_LOGIN_KEPT && echo login-kept || echo login-lost`,
                `${JSON.stringify(process.execPath)} -e 'const c=JSON.parse(require("fs").readFileSync(process.env.HOME+"/.copilot/config.json","utf8"));if(c.copilotTokens?.["https://github.com:fixture-user"]!=="MODEL_LOGIN_KEPT")process.exit(1)' && echo stored-login-kept || echo stored-login-lost`,
              ]
            : [`grep -q MODEL_LOGIN_KEPT "$HOME/${spec.login}" 2>/dev/null && echo login-kept || echo login-lost`]),
          `grep -q NONSECRET_SETTING "$HOME/${spec.setting}" 2>/dev/null && echo setting-kept || echo setting-lost`,
          ...(["claude", "codex"].includes(provider)
            ? [
                `grep -Rqs 'hooks/notify.mjs' "$HOME/${provider === "codex" ? ".codex/hooks.json" : spec.setting}" 2>/dev/null && echo trusted-hook-kept || echo trusted-hook-lost`,
              ]
            : []),
          ...(provider === "copilot"
            ? [
                `grep -q 'hooks/notify.mjs' "$HOME/.copilot/config.json" 2>/dev/null && echo trusted-hook-kept || echo trusted-hook-lost`,
              ]
            : []),
          ...spec.configs.map((file) => `printf bad >> ${fixture.home}/${file} 2>/dev/null; true`),
          `printf '{"own":true}' > "$HOME/${spec.configs[0]}" 2>/dev/null && echo own-copy-writable || echo own-copy-refused`,
        ].join("; ");
        const output = runLauncher(
          fixture,
          {
            ensureDirs: policy.ensureDirs,
            confinedLinks: folders
              .filter((relative) => !mirrored.includes(relative))
              .map((relative) => ({
                link: path.join(fixture.sandboxHome, relative),
                target: path.join(fixture.home, relative),
                root: fixture.sandboxHome,
              })),
            confinedMirrors: mirrored.map((relative) => ({
              dir: path.join(fixture.sandboxHome, relative),
              sources: [path.join(fixture.home, relative)],
              exclude: mirrorExclusions(agent, relative),
              root: fixture.sandboxHome,
            })),
            seededFiles: (agent.configFiles ?? [])
              .filter((file) => file.format !== "omit")
              .map((file) => ({
                sources: [path.join(fixture.home, file.path)],
                dest: path.join(fixture.sandboxHome, file.path),
                root: fixture.sandboxHome,
                filter: file.format,
                refresh: true,
                keepEnv: agent.loginEnv,
              })),
            homeOverride: fixture.sandboxHome,
            optional: policy.optional,
            keepEnv: provider === "copilot" ? ["COPILOT_GITHUB_TOKEN"] : [],
            command: ["/bin/sh", "-c", script],
            runtime: policy.runtime,
          },
          provider === "copilot" ? { COPILOT_GITHUB_TOKEN: "MODEL_LOGIN_KEPT" } : {},
        );
        expect(output).toContain("secret-hidden");
        expect(output).not.toContain("secret-visible");
        expect(output).not.toContain("INERT_NON_MODEL_MCP_SECRET");
        expect(output).toContain("login-kept");
        expect(output).toContain("setting-kept");
        if (["claude", "codex", "copilot"].includes(provider)) expect(output).toContain("trusted-hook-kept");
        if (provider === "copilot") expect(output).toContain("stored-login-kept");
        expect(output).toContain("own-copy-writable");
        for (const [relative, content] of Object.entries(spec.files)) {
          expect(readFileSync(path.join(fixture.home, relative), "utf8"), relative).toBe(content);
        }
      },
      150_000,
    );
  }
});
