import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RegistryConnection } from "../../shared/registry.js";
import { SANDBOX_AGENT_IDS, SANDBOX_SRT_VERSION } from "../../shared/sandbox.js";
import https from "node:https";
import { gzipSync, crc32 } from "node:zlib";
import { windowsPathToWsl } from "../../shared/wsl-paths.js";
import { SandboxGateway } from "./gateway.js";
import { execRunner, type CommandRunner } from "./sandbox-environment.js";
import { SandboxService } from "./sandbox-service.js";
import { ensureNotifyScript } from "../claude-hook-config.js";
import { getAgentSandboxProfile, mirrorExclusions, mirroredAgentFolders } from "./agent-profile.js";
import { SANDBOX_LAUNCHER_SOURCE } from "./launcher-script.js";
import { buildSandboxPolicy } from "./sandbox-policy.js";
import { TOOLCHAIN_PROFILES } from "./toolchain-profile.js";

/**
 * Real run through WSL2: the service builds the `wsl.exe` command, the launcher starts the sandbox runtime inside the
 * distro and a shell runs in it. Needs a Windows machine with WSL2, bubblewrap, socat, ripgrep and the pinned sandbox
 * runtime reachable (set STRIDETERM_SANDBOX_SRT_MODULE to its dist/index.js inside the distro when it is not installed
 * globally). Off by default:
 *   STRIDETERM_SANDBOX_E2E=1 npx vitest run --config vitest.backend.config.ts electron/backend/sandbox/sandbox-wsl.e2e.test.ts
 */
const enabled = process.platform === "win32" && process.env.STRIDETERM_SANDBOX_E2E === "1";
const NUL = String.fromCharCode(0);
const REGISTRY_SECRET = "registry-secret";
const REGISTRY_USER = "svc";

/** When the runtime under test sits in the home folder, that one entry is visible by design (it is read-only). */
const srtHomeEntry = /^\/home\/[^/]+\/([^/]+)/u.exec(process.env.STRIDETERM_SANDBOX_SRT_MODULE || "")?.[1] ?? "-none-";

describe.runIf(enabled)("sandbox in WSL2 (end to end)", () => {
  const dirs: string[] = [];
  let service: SandboxService;
  let dataDir: string;
  let workspaceDir: string;
  let registryServer: http.Server;
  let registryRequests: Array<{ url?: string; authorization?: string }>;
  let registries: RegistryConnection[] = [];

  const temp = (name: string) => {
    const dir = mkdtempSync(path.join(os.tmpdir(), `sbx-e2e-${name}-`));
    dirs.push(dir);
    return dir;
  };

  const run: CommandRunner = async (file, args, options) => {
    const result = await execRunner(file, args, options);
    const override = process.env.STRIDETERM_SANDBOX_SRT_MODULE;
    if (!result.stdout.includes("home=")) return result;
    // The tests run a stand-in command under an agent's name, so the agent CLIs need not be installed in the distro.
    const lines = result.stdout
      .split(/\r?\n/u)
      .filter((line) => !/^agent_[a-z]+=/u.test(line) && !(override && /^srt_(module|version)=/u.test(line)))
      .concat(SANDBOX_AGENT_IDS.map((id) => `agent_${id}=/usr/bin/${id}`))
      .concat(override ? [`srt_module=${override}`, `srt_version=${SANDBOX_SRT_VERSION}`] : []);
    return { ...result, stdout: lines.join("\n") };
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
  });

  function context(sessionId: string, cwd = workspaceDir, workspaceId = "e2e") {
    return {
      sessionId,
      workspace: { id: workspaceId, profileId: "default", kind: "terminal", cwd, sandboxEnabled: true },
      panel: { id: "p", command: "claude" },
      cwd,
    };
  }

  /** Runs `script` in an isolated shell; `onTick` runs every 200 ms while it does (the "user" answering requests). */
  async function runShell(
    sessionId: string,
    script: string,
    onTick?: () => void,
    env: Record<string, string> = {},
    cwd = workspaceDir,
    workspaceId = "e2e",
  ) {
    const ctx = context(sessionId, cwd, workspaceId);
    await service.prepare(ctx);
    const launch = service.wrap({ ...ctx, launcher: { file: "pwsh.exe", args: [] }, env: { TERM: "xterm", ...env } });
    return new Promise<string>((resolve) => {
      const child = spawn(launch.file, launch.args, { env: { ...process.env, ...launch.env }, windowsHide: true });
      let output = "";
      child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
      child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));
      const timer = setInterval(() => onTick?.(), 200);
      child.on("close", () => {
        clearInterval(timer);
        resolve(output.replaceAll(NUL, ""));
      });
      child.stdin.end(`${script}\nexit\n`);
    });
  }

  it("runs a shell isolated from the home directory, the host's tokens and the network", async () => {
    const ctx = context("e2e:1");
    await service.prepare(ctx);
    const launch = service.wrap({
      ...ctx,
      launcher: { file: "pwsh.exe", args: [] },
      env: { TERM: "xterm", GITHUB_TOKEN: "host-token-must-not-leak", STRIDETERM_SESSION_ID: "e2e:1" },
    });
    const script = [
      "pwd",
      "cat a.txt",
      "echo wrote > b.txt && echo write-ok",
      "echo x > .claude/y 2>/dev/null && echo claude-writable || echo claude-protected",
      'echo "token=[$GITHUB_TOKEN]"',
      `ls ~ 2>/dev/null | grep -v '^${srtHomeEntry}$' | wc -l | sed "s/^/home-entries=/"`,
      "curl -s -m 6 -o /dev/null -w 'example=%{http_code}\\n' https://example.com 2>&1",
      "exit",
    ].join("\n");
    const result = spawnSync(launch.file, launch.args, {
      input: `${script}\n`,
      encoding: "utf8",
      env: { ...process.env, ...launch.env },
      timeout: 60_000,
    });
    const output = `${result.stdout}\n${result.stderr}`.replaceAll(NUL, "");
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

  it("waits for the user on a destination nothing decides and lets the connection through when they allow it", async () => {
    const output = await runShell(
      "e2e:allow",
      "curl -s -m 20 -o /dev/null -w 'example=%{http_code}\\n' https://example.com 2>&1",
      () => {
        service.pollDenials();
        for (const request of service.listPending("e2e")) service.decide(request.id, true);
      },
    );
    expect(output).toMatch(/example=[1-5][0-9][0-9]/u);
    expect(output).not.toContain("example=000");
  }, 120_000);

  it("reads a private registry through the host gateway, which adds the sign-in the sandbox never sees", async () => {
    registries = [
      {
        id: "r1",
        profileId: "default",
        label: "Corp",
        kind: "maven",
        url: `http://127.0.0.1:${(registryServer.address() as AddressInfo).port}/repo`,
        mode: "mirror",
        authKind: "basic",
        username: REGISTRY_USER,
        npmScope: "",
      },
    ];
    const settings = `${windowsPathToWsl(dataDir)?.path}/sandbox/sessions/e2e_registry/tools/settings.xml`;
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
  }, 120_000);

  /** Runs `script` as the stdin of a non-shell launcher program, so PATH is exactly what the launcher set. */
  async function runAgent(
    svc: SandboxService,
    ctx: ReturnType<typeof context>,
    script: string,
    env: Record<string, string> = {},
  ) {
    await svc.prepare(ctx);
    const launch = svc.wrap({
      ...ctx,
      launcher: { file: "env", args: ["bash", "-s"] },
      env: { TERM: "xterm", ...env },
    });
    return new Promise<string>((resolve) => {
      const child = spawn(launch.file, launch.args, { env: { ...process.env, ...launch.env } });
      let output = "";
      child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
      child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));
      child.on("close", () => resolve(output.replaceAll(NUL, "")));
      child.stdin.end(`${script}\nexit\n`);
    });
  }

  const wslShell = (script: string) =>
    spawnSync("wsl.exe", ["-e", "bash", "-lc", script], {
      encoding: "utf8",
      timeout: 60_000,
      windowsHide: true,
    });

  it.each(["codex", "copilot"])(
    "sanitizes the %s hook store and delivers its trusted notification hook",
    async (provider) => {
      const received: Array<{ body: string }> = [];
      const notify = http.createServer((req, res) => {
        let body = "";
        req.on("data", (chunk: Buffer) => (body += chunk.toString()));
        req.on("end", () => {
          received.push({ body });
          res.end("{}");
        });
      });
      await new Promise<void>((resolve) => notify.listen(0, "127.0.0.1", resolve));
      const isolatedHome = `/var/tmp/sbx-hook-home-${provider}-${Math.random().toString(36).slice(2, 9)}`;
      const windowsHome = temp(`winhome-${provider}-hooks`);
      const hookDir = provider === "codex" ? ".codex" : ".copilot";
      const hookFile = provider === "codex" ? "hooks.json" : "config.json";
      const hooksPath = path.join(windowsHome, hookDir, hookFile);
      const written = await ensureNotifyScript(dataDir);
      expect(written.ok).toBe(true);
      const hook = written.path.split(String.fromCharCode(92)).join("/");
      const notifyCommand = `node "${hook}" Stop`;
      const hookDoc =
        provider === "codex"
          ? {
              hooks: {
                Stop: [
                  {
                    matcher: "",
                    hooks: [
                      { type: "command", command: "echo INERT_NON_MODEL_MCP_SECRET" },
                      { type: "command", command: notifyCommand },
                    ],
                  },
                ],
              },
            }
          : {
              model: "MODEL_SETTING_KEPT",
              lastLoggedInUser: { host: "https://github.com", login: "fixture-user" },
              copilotTokens: { "https://github.com:fixture-user": "MODEL_LOGIN_KEPT" },
              hooks: {
                sessionEnd: [
                  { type: "command", bash: "echo INERT_NON_MODEL_MCP_SECRET" },
                  { type: "command", bash: notifyCommand, powershell: notifyCommand, timeoutSec: 5 },
                ],
              },
            };
      mkdirSync(path.dirname(hooksPath), { recursive: true });
      writeFileSync(hooksPath, JSON.stringify(hookDoc));
      wslShell(`mkdir -p ${isolatedHome}`);
      const isolatedRun: CommandRunner = async (file, args, options) => {
        const result = await run(file, args, options);
        return { ...result, stdout: result.stdout.replace(/^home=.*$/mu, `home=${isolatedHome}`) };
      };
      const linked = new SandboxService({
        dataDir,
        gateway: new SandboxGateway({
          audit: {
            begin: () => true,
            end: () => undefined,
            flush: () => undefined,
            beginOperation: () => () => undefined,
          },
          resolveRegistry: () => null,
        }),
        run: isolatedRun,
        windowsHome,
        getRegistries: () => [],
        getWorkspaceDomains: () => [],
        onDenied: () => undefined,
        onDeniedSettled: () => undefined,
        askTimeoutMs: 4000,
      });
      try {
        linked.writeLauncher();
        const sessionId = `e2e:${provider}-hook-store`;
        const url = `http://127.0.0.1:${(notify.address() as AddressInfo).port}/notify?sid=${encodeURIComponent(sessionId)}`;
        const relativeHooks = provider === "codex" ? `hooks.Stop[0].hooks` : `hooks.sessionEnd`;
        const commandField = provider === "codex" ? "command" : "bash";
        const script = [
          `cmd=$(node -e 'const f=process.env.HOME+"/${hookDir}/${hookFile}";const h=JSON.parse(require("fs").readFileSync(f,"utf8")).${relativeHooks};console.log(h.map(x=>x.${commandField}).filter(Boolean).find(x=>x.includes("hooks/notify.mjs"))||"")')`,
          'echo "registered=$cmd"',
          `grep -q INERT_NON_MODEL_MCP_SECRET "$HOME/${hookDir}/${hookFile}" && echo secret-visible || echo secret-hidden`,
          `echo '{"session_id":"abc"}' | sh -c "$cmd"`,
          'echo "hook-exit=$?"',
          ...(provider === "copilot"
            ? [
                `test "$COPILOT_GITHUB_TOKEN" = MODEL_LOGIN_KEPT && echo login-kept || echo login-lost`,
                `node -e 'const c=JSON.parse(require("fs").readFileSync(process.env.HOME+"/.copilot/config.json","utf8"));if(c.copilotTokens?.["https://github.com:fixture-user"]!=="MODEL_LOGIN_KEPT"||c.lastLoggedInUser?.login!=="fixture-user")process.exit(1)' && echo stored-login-kept || echo stored-login-lost`,
              ]
            : []),
        ].join("\n");
        const output = await runAgent(
          linked,
          { ...context(sessionId), panel: { id: "p", command: provider } },
          script,
          {
            STRIDETERM_NOTIFY_URL: url,
            STRIDETERM_SESSION_ID: sessionId,
            STRIDETERM_SESSION_TOKEN: "tok",
            ...(provider === "copilot" ? { COPILOT_GITHUB_TOKEN: "MODEL_LOGIN_KEPT" } : {}),
          },
        );
        expect(output).toContain("registered=node ");
        expect(output).toContain("secret-hidden");
        expect(output).not.toContain("INERT_NON_MODEL_MCP_SECRET");
        expect(output).toContain("hook-exit=0");
        if (provider === "copilot") {
          expect(output).toContain("login-kept");
          expect(output).toContain("stored-login-kept");
        }
        expect(received, output).toHaveLength(1);
        expect(JSON.parse(received[0].body).hook).toBe("Stop");
        expect(readFileSync(hooksPath, "utf8")).toBe(JSON.stringify(hookDoc));
      } finally {
        notify.close();
        await linked.shutdown();
        if (/^\/var\/tmp\/sbx-hook-home-(?:codex|copilot)-[a-z0-9]+$/u.test(isolatedHome))
          wslShell(`rm -rf ${isolatedHome}`);
      }
    },
    120_000,
  );

  it("runs an agent hook that names a Windows path and delivers it to the notify server through the gateway", async () => {
    const received: Array<{ url?: string; body: string }> = [];
    const notify = http.createServer((req, res) => {
      let body = "";
      req.on("data", (chunk: Buffer) => (body += chunk.toString()));
      req.on("end", () => {
        received.push({ url: req.url, body });
        res.end("{}");
      });
    });
    await new Promise<void>((resolve) => notify.listen(0, "127.0.0.1", () => resolve()));
    try {
      const written = await ensureNotifyScript(dataDir);
      expect(written.ok).toBe(true);
      // The command an agent configuration written on Windows registers: node "C:/.../hooks/notify.mjs" Stop
      const hook = written.path.split(String.fromCharCode(92)).join("/");
      expect(hook).toMatch(/^[A-Za-z]:\//u);
      const sessionId = "e2e:hook";
      const url = `http://127.0.0.1:${(notify.address() as AddressInfo).port}/notify?sid=${encodeURIComponent(sessionId)}`;
      const output = await runAgent(
        service,
        context(sessionId),
        [`echo '{"session_id":"abc"}' | node "${hook}" Stop`, 'echo "hook-exit=$?"'].join("\n"),
        { STRIDETERM_NOTIFY_URL: url, STRIDETERM_SESSION_ID: sessionId, STRIDETERM_SESSION_TOKEN: "tok" },
      );
      expect(output).toContain("hook-exit=0");
      expect(received).toHaveLength(1);
      expect(JSON.parse(received[0].body).hook).toBe("Stop");
    } finally {
      notify.close();
    }
  }, 120_000);

  it("delivers a notification through the hook the agent's own sanitized settings name, found by the agent's config rather than by path", async (testContext) => {
    if (wslShell("[ -e ~/.gemini ] || [ -L ~/.gemini ]").status === 0) return testContext.skip();
    const received: Array<{ url?: string; body: string }> = [];
    const notify = http.createServer((req, res) => {
      let body = "";
      req.on("data", (chunk: Buffer) => (body += chunk.toString()));
      req.on("end", () => {
        received.push({ url: req.url, body });
        res.end("{}");
      });
    });
    await new Promise<void>((resolve) => notify.listen(0, "127.0.0.1", () => resolve()));
    const windowsHome = temp("winhome-hook");
    const written = await ensureNotifyScript(dataDir);
    expect(written.ok).toBe(true);
    const hook = written.path.split(String.fromCharCode(92)).join("/");
    mkdirSync(path.join(windowsHome, ".gemini"));
    writeFileSync(
      path.join(windowsHome, ".gemini", "settings.json"),
      JSON.stringify({
        env: { GITHUB_TOKEN: "INERT_NON_MODEL_MCP_SECRET" },
        hooks: {
          Stop: [
            {
              matcher: "",
              hooks: [
                { type: "command", command: `node "${hook}" Stop`, timeout: 5 },
                { type: "command", command: "echo INERT_NON_MODEL_MCP_SECRET" },
              ],
            },
          ],
        },
      }),
    );
    const linked = new SandboxService({
      dataDir,
      gateway: new SandboxGateway({
        audit: {
          begin: () => true,
          end: () => undefined,
          flush: () => undefined,
          beginOperation: () => () => undefined,
        },
        resolveRegistry: () => null,
      }),
      run,
      windowsHome,
      getRegistries: () => [],
      getWorkspaceDomains: () => [],
      onDenied: () => undefined,
      onDeniedSettled: () => undefined,
      askTimeoutMs: 4000,
    });
    try {
      linked.writeLauncher();
      const sessionId = "e2e:cfg-hook";
      const url = `http://127.0.0.1:${(notify.address() as AddressInfo).port}/notify?sid=${encodeURIComponent(sessionId)}`;
      const output = await runAgent(
        linked,
        { ...context(sessionId), panel: { id: "p", command: "gemini" } },
        [
          // The command is read out of the settings file the agent loads and run as the agent would run it.
          `cmd=$(node -e 'const h=JSON.parse(require("fs").readFileSync(process.env.HOME+"/.gemini/settings.json","utf8")).hooks.Stop[0].hooks;console.log(h.map((x)=>x.command).join("|"))' | cut -d'|' -f1)`,
          'echo "registered=$cmd"',
          `echo '{"session_id":"abc"}' | sh -c "$cmd"`,
          'echo "hook-exit=$?"',
          "grep -q INERT_NON_MODEL_MCP_SECRET ~/.gemini/settings.json && echo secret-visible || echo secret-hidden",
        ].join("\n"),
        { STRIDETERM_NOTIFY_URL: url, STRIDETERM_SESSION_ID: sessionId, STRIDETERM_SESSION_TOKEN: "tok" },
      );
      expect(output).toContain("registered=node ");
      expect(output).toContain("hook-exit=0");
      expect(output).toContain("secret-hidden");
      expect(received, output).toHaveLength(1);
      expect(JSON.parse(received[0].body).hook).toBe("Stop");
    } finally {
      notify.close();
      await linked.shutdown();
    }
  }, 120_000);

  it("shares the Windows agent sign-in on first use, gives the agent a sanitized copy of its settings and leaves the Windows folder's files alone", async (testContext) => {
    // Needs an agent folder the distro does not have of its own (the distro's own would win, by design).
    if (wslShell("[ -e ~/.gemini ] || [ -L ~/.gemini ]").status === 0) return testContext.skip();
    const windowsHome = temp("winhome");
    mkdirSync(path.join(windowsHome, ".gemini"));
    writeFileSync(path.join(windowsHome, ".gemini", "oauth_creds.json"), "synthetic-login");
    writeFileSync(path.join(windowsHome, ".gemini", "settings.json"), "original-settings");
    const linked = new SandboxService({
      dataDir,
      gateway: new SandboxGateway({
        audit: {
          begin: () => true,
          end: () => undefined,
          flush: () => undefined,
          beginOperation: () => () => undefined,
        },
        resolveRegistry: () => null,
      }),
      run,
      windowsHome,
      getRegistries: () => [],
      getWorkspaceDomains: () => [],
      onDenied: () => undefined,
      onDeniedSettled: () => undefined,
      askTimeoutMs: 4000,
    });
    try {
      linked.writeLauncher();
      const ctx = { ...context("e2e:login"), panel: { id: "p", command: "gemini" } };
      const output = await runAgent(
        linked,
        ctx,
        [
          '[ -d ~/.gemini ] && [ ! -L ~/.gemini ] && [ -L ~/.gemini/oauth_creds.json ] && echo "login-is-mirrored"',
          "cat ~/.gemini/oauth_creds.json; echo",
          "grep -q original-settings ~/.gemini/settings.json && echo settings-leaked || echo settings-sanitized",
          "echo changed >> ~/.gemini/settings.json 2>/dev/null && echo own-settings-writable",
          "echo state > ~/.gemini/state.txt && echo state-writable",
        ].join("\n"),
      );
      expect(output).toContain("login-is-mirrored");
      expect(output).toContain("synthetic-login");
      expect(output).toContain("settings-sanitized");
      expect(output).not.toContain("settings-leaked");
      expect(output).toContain("own-settings-writable");
      expect(output).toContain("state-writable");
      expect(readFileSync(path.join(windowsHome, ".gemini", "settings.json"), "utf8")).toBe("original-settings");
      // What the sandbox wrote at the top of its mirror stays in the sandbox's own copy.
      expect(existsSync(path.join(windowsHome, ".gemini", "state.txt"))).toBe(false);
      // Nothing was created in the distro's real home.
      expect(wslShell("[ -e ~/.gemini ] || [ -L ~/.gemini ]").status).not.toBe(0);
    } finally {
      await linked.shutdown();
    }
  }, 120_000);

  it("keeps a native launch's agent config read-only and another workspace's Gradle home out of reach", async (testContext) => {
    const srtModule = process.env.STRIDETERM_SANDBOX_SRT_MODULE;
    if (!srtModule) return testContext.skip();
    const nodePath = wslShell("command -v node").stdout.trim();
    const fixture = `/var/tmp/sbx-native-${Math.random().toString(36).slice(2, 10)}`;
    const gradle = TOOLCHAIN_PROFILES.find((profile) => profile.id === "gradle")!;
    const mine = `${fixture}/homes/mine/gradle`;
    const other = `${fixture}/homes/other/gradle/init.d/x.gradle`;
    const codexConfig = `${fixture}/home/.codex/config.toml`;
    try {
      wslShell(
        `mkdir -p ${fixture}/home/.codex ${fixture}/workspace ${fixture}/homes/other/gradle/init.d ${fixture}/cache ${fixture}/tools ` +
          `&& printf original > ${codexConfig} && printf original > ${other}`,
      );
      const policy = buildSandboxPolicy({
        os: "linux",
        home: `${fixture}/home`,
        roots: [`${fixture}/workspace`],
        gitDirs: [],
        readPaths: [srtModule.split("/").slice(0, -2).join("/")],
        readWritePaths: [],
        workspaceHomes: [mine],
        ensureDirs: [`${fixture}/cache/gradle/modules-2`],
        agent: getAgentSandboxProfile("codex"),
        toolchains: [gradle],
        cacheRoot: `${fixture}/cache`,
        workspaceDomains: [],
        toolConfigDir: `${fixture}/tools`,
      });
      const script = [
        `printf native-write > ${codexConfig} 2>/dev/null && echo codex-config-writable || echo codex-config-protected`,
        `printf poisoned > ${other} 2>/dev/null && echo other-home-writable || echo other-home-protected`,
        `mkdir -p ${mine}/init.d && printf own > ${mine}/init.d/own.gradle && echo own-home-writable`,
        `printf artifact > ${mine}/caches/modules-2/artifact && echo shared-artifacts-writable`,
      ].join("; ");
      const work = temp("native");
      const launcher = path.join(work, "launcher.mjs");
      const config = path.join(work, "launch.json");
      writeFileSync(launcher, SANDBOX_LAUNCHER_SOURCE);
      writeFileSync(
        config,
        JSON.stringify({
          srtModule,
          sessionId: "native",
          askTimeoutMs: 100,
          denialsFile: `${fixture}/denials.jsonl`,
          decisionsDir: `${fixture}/decisions`,
          ensureDirs: policy.ensureDirs,
          toolFiles: [],
          confinedLinks: [
            { link: `${mine}/caches/modules-2`, target: `${fixture}/cache/gradle/modules-2`, root: mine },
          ],
          optional: policy.optional,
          loginLinks: [],
          keepEnv: [],
          unsetEnv: [],
          command: ["/bin/sh", "-c", script],
          runtime: policy.runtime,
        }),
      );
      const toWsl = (file: string) => windowsPathToWsl(file)!.path;
      const result = spawnSync(
        "wsl.exe",
        ["--cd", `${fixture}/workspace`, "-e", "env", `HOME=${fixture}/home`, nodePath, toWsl(launcher), toWsl(config)],
        { encoding: "utf8", timeout: 90_000 },
      );
      const output = `${result.stdout}\n${result.stderr}`.replaceAll(NUL, "");
      expect(output).toContain("codex-config-protected");
      expect(output).toContain("other-home-protected");
      expect(output).toContain("own-home-writable");
      expect(output).toContain("shared-artifacts-writable");
      expect(wslShell(`cat ${codexConfig} ${other}`).stdout).toBe("originaloriginal");
      expect(wslShell(`cat ${fixture}/cache/gradle/modules-2/artifact`).stdout).toBe("artifact");
    } finally {
      if (/^\/var\/tmp\/sbx-native-[a-z0-9]+$/u.test(fixture)) wslShell(`rm -rf ${fixture}`);
    }
  }, 150_000);

  for (const { provider, relative } of [
    { provider: "codex", relative: ".codex/config.toml" },
    { provider: "opencode", relative: ".config/opencode/plugins/evil.js" },
  ])
    it(`does not let a sandboxed ${provider} create host-loaded config that is not there yet`, async (testContext) => {
      const srtModule = process.env.STRIDETERM_SANDBOX_SRT_MODULE;
      if (!srtModule) return testContext.skip();
      const nodePath = wslShell("command -v node").stdout.trim();
      const fixture = `/var/tmp/sbx-absent-${Math.random().toString(36).slice(2, 10)}`;
      const target = `${fixture}/home/${relative}`;
      try {
        wslShell(`mkdir -p ${fixture}/workspace ${fixture}/tools ${fixture}/cache`);
        const policy = buildSandboxPolicy({
          os: "linux",
          home: `${fixture}/home`,
          roots: [`${fixture}/workspace`],
          gitDirs: [],
          readPaths: [srtModule.split("/").slice(0, -2).join("/")],
          readWritePaths: [],
          agent: getAgentSandboxProfile(provider),
          toolchains: [],
          cacheRoot: `${fixture}/cache`,
          workspaceDomains: [],
          toolConfigDir: `${fixture}/tools`,
        });
        const script = `mkdir -p ${path.posix.dirname(target)} 2>/dev/null; printf planted > ${target} 2>/dev/null && echo planted || echo refused`;
        const work = temp("absent");
        const launcher = path.join(work, "launcher.mjs");
        const config = path.join(work, "launch.json");
        writeFileSync(launcher, SANDBOX_LAUNCHER_SOURCE);
        writeFileSync(
          config,
          JSON.stringify({
            srtModule,
            sessionId: "absent",
            askTimeoutMs: 100,
            denialsFile: `${fixture}/denials.jsonl`,
            decisionsDir: `${fixture}/decisions`,
            ensureDirs: policy.ensureDirs,
            toolFiles: [],
            optional: policy.optional,
            loginLinks: [],
            keepEnv: [],
            unsetEnv: [],
            command: ["/bin/sh", "-c", script],
            runtime: policy.runtime,
          }),
        );
        const toWsl = (file: string) => windowsPathToWsl(file)!.path;
        const result = spawnSync(
          "wsl.exe",
          [
            "--cd",
            `${fixture}/workspace`,
            "-e",
            "env",
            `HOME=${fixture}/home`,
            nodePath,
            toWsl(launcher),
            toWsl(config),
          ],
          { encoding: "utf8", timeout: 90_000 },
        );
        const output = `${result.stdout}
${result.stderr}`.replaceAll(NUL, "");
        // The folder is not granted at all: what the script wrote at that path went into the sandbox's own throwaway
        // folder, and the host's path is still not there.
        expect(output).not.toContain("INERT");
        expect(wslShell(`cat ${target} 2>/dev/null; true`).stdout).not.toContain("planted");
        expect(wslShell(`test -e ${target}`).status).not.toBe(0);
      } finally {
        if (fixture.startsWith("/var/tmp/sbx-absent-") && !fixture.includes("..")) wslShell(`rm -rf ${fixture}`);
      }
    }, 150_000);

  it("gives a sandboxed Claude its own .claude.json and leaves the host's MCP definitions and unnamed STRIDETERM_ variables out", async (testContext) => {
    const srtModule = process.env.STRIDETERM_SANDBOX_SRT_MODULE;
    if (!srtModule) return testContext.skip();
    const nodePath = wslShell("command -v node").stdout.trim();
    const fixture = `/var/tmp/sbx-state-${Math.random().toString(36).slice(2, 10)}`;
    const hostFile = `${fixture}/home/.claude.json`;
    const original =
      '{"mcpServers":{"host":{"command":"never-run","env":{"GITHUB_TOKEN":"INERT_NON_MODEL_MCP_SECRET"}}}}';
    try {
      wslShell(`mkdir -p ${fixture}/workspace ${fixture}/tools ${fixture}/cache ${fixture}/home/.claude`);
      wslShell(`printf '%s' '${original}' > ${hostFile}`);
      const sandboxHome = `${fixture}/sandbox-home`;
      const agent = getAgentSandboxProfile("claude");
      const policy = buildSandboxPolicy({
        os: "linux",
        home: `${fixture}/home`,
        roots: [`${fixture}/workspace`],
        gitDirs: [],
        readPaths: [srtModule.split("/").slice(0, -2).join("/")],
        readWritePaths: [],
        workspaceHomes: [sandboxHome],
        agent,
        toolchains: [],
        cacheRoot: `${fixture}/cache`,
        workspaceDomains: [],
        toolConfigDir: `${fixture}/tools`,
      });
      const script = [
        `grep -q INERT_NON_MODEL_MCP_SECRET "$HOME/.claude.json" 2>/dev/null && echo seed-secret-visible || echo seed-secret-absent`,
        `printf '{"own":true}' > "$HOME/.claude.json" 2>/dev/null && echo own-copy-writable || echo own-copy-refused`,
        `grep -q never-run ${hostFile} 2>/dev/null && echo host-readable || echo host-hidden`,
        `printf '{"planted":true}' > ${hostFile} 2>/dev/null`,
        `test -n "$STRIDETERM_HOST_TOKEN" && echo token-leaked || echo token-absent`,
      ].join("; ");
      const work = temp("state");
      const launcher = path.join(work, "launcher.mjs");
      const config = path.join(work, "launch.json");
      writeFileSync(launcher, SANDBOX_LAUNCHER_SOURCE);
      writeFileSync(
        config,
        JSON.stringify({
          srtModule,
          sessionId: "state",
          askTimeoutMs: 100,
          denialsFile: `${fixture}/denials.jsonl`,
          decisionsDir: `${fixture}/decisions`,
          ensureDirs: policy.ensureDirs,
          toolFiles: [],
          confinedLinks: [{ link: `${sandboxHome}/.claude`, target: `${fixture}/home/.claude`, root: sandboxHome }],
          seededFiles: [
            { sources: [hostFile], dest: `${sandboxHome}/.claude.json`, root: sandboxHome, filter: "claude-state" },
          ],
          homeOverride: sandboxHome,
          optional: policy.optional,
          loginLinks: [],
          keepEnv: [],
          unsetEnv: [],
          command: ["/bin/sh", "-c", script],
          runtime: policy.runtime,
        }),
      );
      const toWsl = (file: string) => windowsPathToWsl(file)!.path;
      const result = spawnSync(
        "wsl.exe",
        [
          "--cd",
          `${fixture}/workspace`,
          "-e",
          "env",
          `HOME=${fixture}/home`,
          "STRIDETERM_HOST_TOKEN=inert",
          nodePath,
          toWsl(launcher),
          toWsl(config),
        ],
        { encoding: "utf8", timeout: 90_000 },
      );
      const output = `${result.stdout}
${result.stderr}`.replaceAll(NUL, "");
      expect(output).toContain("seed-secret-absent");
      expect(output).not.toContain("INERT_NON_MODEL_MCP_SECRET");
      expect(output).toContain("own-copy-writable");
      // The sandbox's view of the host home is empty, so whatever it writes there never reaches the host's file.
      expect(output).toContain("host-hidden");
      expect(output).toContain("token-absent");
      expect(wslShell(`cat ${hostFile}`).stdout).toBe(original);
      expect(wslShell(`cat ${sandboxHome}/.claude.json`).stdout).toBe('{"own":true}');
    } finally {
      if (/^\/var\/tmp\/sbx-state-[a-z0-9]+$/u.test(fixture)) wslShell(`rm -rf ${fixture}`);
    }
  }, 150_000);

  // ---- Credentials of tools other than the model, in the agents' shared config folders ---------------------------------
  //
  // Every agent's own folder is shared with the host (one sign-in), and that folder also holds config files that carry
  // other tools' credentials (MCP servers' env and headers, hooks). The sandbox must read the model sign-in and the
  // agent's settings, and nothing else of that.
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

  for (const provider of Object.keys(SHARED_CONFIG_FIXTURES)) {
    it(`keeps a ${provider} agent's other-tool credentials out of the sandbox, and keeps its settings and model sign-in`, async (testContext) => {
      const srtModule = process.env.STRIDETERM_SANDBOX_SRT_MODULE;
      if (!srtModule) return testContext.skip();
      const nodePath = wslShell("command -v node").stdout.trim();
      const fixture = `/var/tmp/sbx-cfg-${Math.random().toString(36).slice(2, 10)}`;
      const spec = SHARED_CONFIG_FIXTURES[provider];
      const hostHome = `${fixture}/home`;
      const sandboxHome = `${fixture}/sandbox-home`;
      const agent = getAgentSandboxProfile(provider)!;
      try {
        wslShell(`mkdir -p ${fixture}/workspace ${fixture}/tools ${fixture}/cache ${hostHome}`);
        for (const [relative, content] of Object.entries(spec.files)) {
          wslShell(`mkdir -p $(dirname ${hostHome}/${relative}) && printf '%s' '${content}' > ${hostHome}/${relative}`);
        }
        if (["codex", "copilot"].includes(provider)) {
          const relative = provider === "codex" ? ".codex/hooks.json" : ".copilot/config.json";
          wslShell(
            `mkdir -p ${sandboxHome}/${path.posix.dirname(relative)} && ln -s ${hostHome}/${relative} ${sandboxHome}/${relative}`,
          );
        }
        const policy = buildSandboxPolicy({
          os: "linux",
          home: hostHome,
          roots: [`${fixture}/workspace`],
          gitDirs: [],
          readPaths: [srtModule.split("/").slice(0, -2).join("/")],
          readWritePaths: [],
          workspaceHomes: [sandboxHome],
          agent,
          toolchains: [],
          cacheRoot: `${fixture}/cache`,
          workspaceDomains: [],
          toolConfigDir: `${fixture}/tools`,
        });
        const mirrored = mirroredAgentFolders(agent);
        const folders = [...new Set([...agent.readHome, ...agent.writeHome])];
        const script = [
          `grep -RqsI INERT_NON_MODEL_MCP_SECRET "$HOME" ${hostHome} 2>/dev/null && echo secret-visible || echo secret-hidden`,
          ...(provider === "copilot"
            ? [
                `test "$COPILOT_GITHUB_TOKEN" = MODEL_LOGIN_KEPT && echo login-kept || echo login-lost`,
                `node -e 'const c=JSON.parse(require("fs").readFileSync(process.env.HOME+"/.copilot/config.json","utf8"));if(c.copilotTokens?.["https://github.com:fixture-user"]!=="MODEL_LOGIN_KEPT")process.exit(1)' && echo stored-login-kept || echo stored-login-lost`,
              ]
            : [`grep -q MODEL_LOGIN_KEPT "$HOME/${spec.login}" 2>/dev/null && echo login-kept || echo login-lost`]),
          `grep -q NONSECRET_SETTING "$HOME/${spec.setting}" 2>/dev/null && echo setting-kept || echo setting-lost`,
          // strIDEterm's own notification hook survives the sanitizing, the other tools' hook does not.
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
          // What lands at the host's path is the sandbox's own throwaway folder: the host's files are compared below.
          ...spec.configs.map((file) => `printf bad >> ${hostHome}/${file} 2>/dev/null; true`),
          `printf '{"own":true}' > "$HOME/${spec.configs[0]}" 2>/dev/null && echo own-copy-writable || echo own-copy-refused`,
        ].join("; ");
        const work = temp(`cfg-${provider}`);
        const launcher = path.join(work, "launcher.mjs");
        const config = path.join(work, "launch.json");
        writeFileSync(launcher, SANDBOX_LAUNCHER_SOURCE);
        writeFileSync(
          config,
          JSON.stringify({
            srtModule,
            sessionId: `cfg-${provider}`,
            askTimeoutMs: 100,
            denialsFile: `${fixture}/denials.jsonl`,
            decisionsDir: `${fixture}/decisions`,
            ensureDirs: policy.ensureDirs,
            toolFiles: [],
            confinedLinks: folders
              .filter((relative) => !mirrored.includes(relative))
              .map((relative) => ({
                link: `${sandboxHome}/${relative}`,
                target: `${hostHome}/${relative}`,
                root: sandboxHome,
              })),
            confinedMirrors: mirrored.map((relative) => ({
              dir: `${sandboxHome}/${relative}`,
              sources: [`${hostHome}/${relative}`],
              exclude: mirrorExclusions(agent, relative),
              root: sandboxHome,
            })),
            seededFiles: (agent.configFiles ?? [])
              .filter((file) => file.format !== "omit")
              .map((file) => ({
                sources: [`${hostHome}/${file.path}`],
                dest: `${sandboxHome}/${file.path}`,
                root: sandboxHome,
                filter: file.format,
                refresh: true,
                keepEnv: agent.loginEnv,
              })),
            homeOverride: sandboxHome,
            optional: policy.optional,
            keepEnv: provider === "copilot" ? ["COPILOT_GITHUB_TOKEN"] : [],
            unsetEnv: [],
            command: ["/bin/sh", "-c", script],
            runtime: policy.runtime,
          }),
        );
        const toWsl = (file: string) => windowsPathToWsl(file)!.path;
        const result = spawnSync(
          "wsl.exe",
          [
            "--cd",
            `${fixture}/workspace`,
            "-e",
            "env",
            `HOME=${hostHome}`,
            ...(provider === "copilot" ? ["COPILOT_GITHUB_TOKEN=MODEL_LOGIN_KEPT"] : []),
            nodePath,
            toWsl(launcher),
            toWsl(config),
          ],
          { encoding: "utf8", timeout: 90_000 },
        );
        const output = `${result.stdout}
${result.stderr}`.replaceAll(NUL, "");
        expect(output).toContain("secret-hidden");
        expect(output).not.toContain("secret-visible");
        expect(output).not.toContain("INERT_NON_MODEL_MCP_SECRET");
        expect(output).toContain("login-kept");
        expect(output).toContain("setting-kept");
        if (["claude", "codex", "copilot"].includes(provider)) expect(output).toContain("trusted-hook-kept");
        if (provider === "copilot") expect(output).toContain("stored-login-kept");
        expect(output).toContain("own-copy-writable");
        for (const [relative, content] of Object.entries(spec.files)) {
          expect(wslShell(`cat ${hostHome}/${relative}`).stdout, relative).toBe(content);
        }
      } finally {
        if (/^\/var\/tmp\/sbx-cfg-[a-z0-9]+$/u.test(fixture)) wslShell(`rm -rf ${fixture}`);
      }
    }, 150_000);
  }

  // ---- Real builds against a private registry, through the generated tool configuration -------------------------
  //
  // The registry below refuses every request without the stored sign-in and names its files by ABSOLUTE URL on
  // its own address, as Nexus and Artifactory do. The sandbox can reach neither: the build can only succeed when the
  // generated settings point the tool at the gateway, the gateway adds the sign-in and the file links come back
  // through the gateway.

  interface PrivateRegistry {
    port: number;
    requests: Array<{ url: string; authorization?: string }>;
    unauthenticated: number;
    close: () => void;
  }

  async function startPrivateRegistry(handlers: (url: string, base: string) => { type: string; body: Buffer } | null) {
    const registry: PrivateRegistry = { port: 0, requests: [], unauthenticated: 0, close: () => undefined };
    const expected = `Basic ${Buffer.from(`${REGISTRY_USER}:${REGISTRY_SECRET}`).toString("base64")}`;
    const server = http.createServer((req, res) => {
      const url = req.url || "/";
      registry.requests.push({ url, authorization: req.headers.authorization });
      if (req.headers.authorization !== expected) {
        registry.unauthenticated += 1;
        res.writeHead(401, { "WWW-Authenticate": 'Basic realm="private"' });
        res.end();
        return;
      }
      const found = handlers(url, `http://127.0.0.1:${registry.port}`);
      if (!found) {
        res.writeHead(404);
        res.end();
        return;
      }
      res.writeHead(200, { "Content-Type": found.type });
      res.end(found.body);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    registry.port = (server.address() as AddressInfo).port;
    registry.close = () => server.close();
    return registry;
  }

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

  function sessionTools(sessionId: string): string {
    return `${windowsPathToWsl(dataDir)?.path}/sandbox/sessions/${sessionId.replace(/[^A-Za-z0-9._-]/gu, "_")}/tools`;
  }

  it("builds a project that depends on a package only the private npm registry has", async () => {
    const lib = tarGz({
      "package/package.json": JSON.stringify({ name: "private-lib", version: "1.0.0", main: "index.js" }),
      "package/index.js": "module.exports = { answer: 42 };\n",
    });
    const registry = await startPrivateRegistry((url, base) => {
      if (url === "/npm/private-lib") {
        return {
          type: "application/json",
          body: Buffer.from(
            JSON.stringify({
              name: "private-lib",
              "dist-tags": { latest: "1.0.0" },
              versions: {
                "1.0.0": {
                  name: "private-lib",
                  version: "1.0.0",
                  dist: { tarball: `${base}/npm/private-lib/-/private-lib-1.0.0.tgz` },
                },
              },
            }),
          ),
        };
      }
      if (url === "/npm/private-lib/-/private-lib-1.0.0.tgz") return { type: "application/octet-stream", body: lib };
      return null;
    });
    try {
      registries = [connectionFor("npm1", "npm", registry.port, "/npm")];
      const project = temp("npm");
      writeFileSync(
        path.join(project, "package.json"),
        JSON.stringify({ name: "app", version: "1.0.0", dependencies: { "private-lib": "1.0.0" } }),
      );
      const output = await runShell(
        "e2e:npm",
        [
          "npm install --no-audit --no-fund --loglevel=error 2>&1 | tail -5",
          'echo "install-exit=${PIPESTATUS[0]}"',
          `node -e "console.log('answer=' + require('private-lib').answer)"`,
          `echo "secret-in-npmrc=$(grep -c ${REGISTRY_SECRET} ${sessionTools("e2e:npm")}/.npmrc)"`,
        ].join("\n"),
        undefined,
        {},
        project,
        "e2e-npm",
      );
      expect(output).toContain("install-exit=0");
      expect(output).toContain("answer=42");
      expect(output).toContain("secret-in-npmrc=0");
      expect(existsSync(path.join(project, "node_modules", "private-lib", "index.js"))).toBe(true);
      // Every request that reached the registry carried the sign-in the gateway added; none came from the sandbox itself.
      expect(registry.unauthenticated).toBe(0);
      expect(registry.requests.map((request) => request.url)).toEqual(
        expect.arrayContaining(["/npm/private-lib", "/npm/private-lib/-/private-lib-1.0.0.tgz"]),
      );
    } finally {
      registry.close();
    }
  }, 300_000);

  it("builds a project that depends on a package only the private pip index has", async (context) => {
    const wheel = zipStore({
      "private_pkg/__init__.py": "ANSWER = 42\n",
      "private_pkg-1.0.dist-info/METADATA": "Metadata-Version: 2.1\nName: private-pkg\nVersion: 1.0\n",
      "private_pkg-1.0.dist-info/WHEEL":
        "Wheel-Version: 1.0\nGenerator: e2e\nRoot-Is-Purelib: true\nTag: py3-none-any\n",
      "private_pkg-1.0.dist-info/RECORD":
        "private_pkg/__init__.py,,\nprivate_pkg-1.0.dist-info/METADATA,,\nprivate_pkg-1.0.dist-info/WHEEL,,\nprivate_pkg-1.0.dist-info/RECORD,,\n",
    });
    const registry = await startPrivateRegistry((url, base) => {
      if (url === "/pip/simple/private-pkg/") {
        return {
          type: "text/html",
          body: Buffer.from(
            `<html><body><a href="${base}/pip/files/private_pkg-1.0-py3-none-any.whl">private_pkg-1.0-py3-none-any.whl</a></body></html>`,
          ),
        };
      }
      if (url === "/pip/files/private_pkg-1.0-py3-none-any.whl")
        return { type: "application/octet-stream", body: wheel };
      return null;
    });
    try {
      registries = [connectionFor("pip1", "pip", registry.port, "/pip")];
      const project = temp("pip");
      writeFileSync(path.join(project, "requirements.txt"), "private-pkg==1.0\n");
      // pip may be installed for the user only (not in the system Python), which the sandbox cannot see: use a staged copy.
      const pipLib = stagePipInDistro();
      const pythonPath = pipLib ? `${pipLib}:` : "";
      const probe = await runShell(
        "e2e:pipprobe",
        `PYTHONPATH=${pythonPath}./deps python3 -m pip --version 2>&1 | head -1`,
        undefined,
        {},
        project,
        "e2e-pip",
      );
      if (!/^pip /mu.test(probe.trim())) {
        context.skip();
        return;
      }
      const output = await runShell(
        "e2e:pip",
        [
          `PYTHONPATH=${pythonPath} python3 -m pip install --target ./deps -r requirements.txt 2>&1 | tail -3`,
          'echo "install-exit=${PIPESTATUS[0]}"',
          `PYTHONPATH=./deps python3 -c "import private_pkg; print('answer=%d' % private_pkg.ANSWER)"`,
          `echo "secret-in-pipconf=$(grep -c ${REGISTRY_SECRET} ${sessionTools("e2e:pip")}/pip.conf)"`,
        ].join("\n"),
        undefined,
        {},
        project,
        "e2e-pip",
      );
      expect(output).toContain("install-exit=0");
      expect(output).toContain("answer=42");
      expect(output).toContain("secret-in-pipconf=0");
      expect(registry.unauthenticated).toBe(0);
    } finally {
      registry.close();
    }
  }, 300_000);

  const MAVEN_POM = `<project xmlns="http://maven.apache.org/POM/4.0.0">
  <modelVersion>4.0.0</modelVersion>
  <groupId>e2e</groupId><artifactId>app</artifactId><version>1.0</version><packaging>jar</packaging>
  <properties><maven.compiler.source>17</maven.compiler.source><maven.compiler.target>17</maven.compiler.target><project.build.sourceEncoding>UTF-8</project.build.sourceEncoding></properties>
  <dependencies><dependency><groupId>org.apache.commons</groupId><artifactId>commons-lang3</artifactId><version>3.14.0</version></dependency></dependencies>
</project>
`;
  const APP_JAVA = `package e2e;
public class App { public static void main(String[] args) { System.out.println(org.apache.commons.lang3.StringUtils.capitalize("built")); } }
`;
  const MAVEN_PROJECT: Record<string, string> = { "pom.xml": MAVEN_POM, "src/main/java/e2e/App.java": APP_JAVA };

  /** A private registry in front of Maven Central: it demands the sign-in, then serves the real artifacts. */
  async function startCentralBackedRegistry(prefix: string, kind: "maven" | "gradle") {
    const registry: PrivateRegistry = { port: 0, requests: [], unauthenticated: 0, close: () => undefined };
    const expected = `Basic ${Buffer.from(`${REGISTRY_USER}:${REGISTRY_SECRET}`).toString("base64")}`;
    const server = http.createServer((req, res) => {
      void (async () => {
        const url = req.url || "/";
        registry.requests.push({ url, authorization: req.headers.authorization });
        if (req.headers.authorization !== expected) {
          registry.unauthenticated += 1;
          res.writeHead(401);
          res.end();
          return;
        }
        if (!url.startsWith(`${prefix}/`)) {
          res.writeHead(404);
          res.end();
          return;
        }
        const upstream = await httpsGet(`https://repo.maven.apache.org/maven2${url.slice(prefix.length)}`);
        res.writeHead(upstream.status, { "Content-Type": upstream.type });
        res.end(upstream.body);
      })().catch((error: unknown) => {
        registry.requests.push({ url: `upstream failed: ${String((error as Error)?.cause ?? error)}` });
        res.writeHead(502);
        res.end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    registry.port = (server.address() as AddressInfo).port;
    registry.close = () => server.close();
    return { registry, connection: connectionFor(`${kind}1`, kind, registry.port, prefix) };
  }

  /** Copies a Windows-side tool installation into the distro's own file system: the sandbox denies /mnt. */
  function stageToolInDistro(windowsDir: string, name: string): string | null {
    if (!existsSync(windowsDir)) return null;
    const target = `/var/tmp/strideterm-e2e-tools/${name}`;
    const source = windowsPathToWsl(windowsDir)?.path;
    const copied = spawnSync(
      "wsl.exe",
      [
        "-e",
        "bash",
        "-c",
        `chmod -R u+w '${target}' 2>/dev/null; rm -rf '${target}' && mkdir -p /var/tmp/strideterm-e2e-tools && cp -r '${source}' '${target}' && chmod -R u+rwX '${target}'`,
      ],
      { encoding: "utf8" },
    );
    return copied.status === 0 ? target : null;
  }

  /** A copy of the user's pip where the sandbox may read it; null when the distro has no pip at all. */
  function stagePipInDistro(): string | null {
    const target = "/var/tmp/strideterm-e2e-tools/pip-lib";
    const staged = spawnSync(
      "wsl.exe",
      [
        "-e",
        "bash",
        "-lc",
        `src=$(ls -d "$HOME"/.local/lib/python3*/site-packages/pip 2>/dev/null | head -1); [ -d "$src" ] || exit 1; ` +
          `chmod -R u+w ${target} 2>/dev/null; rm -rf ${target}; mkdir -p ${target} && cp -r "$src" ${target}/pip && echo ${target}`,
      ],
      { encoding: "utf8" },
    );
    if (staged.status !== 0) return null;
    return staged.stdout.replaceAll(NUL, "").trim().split(/\r?\n/u).pop() || null;
  }

  /** A JDK with `javac` (Gradle insists on one), staged where the sandbox may read it; null when the distro has none. */
  function stageJdkInDistro(): string | null {
    const target = "/var/tmp/strideterm-e2e-tools/jdk";
    const staged = spawnSync(
      "wsl.exe",
      [
        "-e",
        "bash",
        "-lc",
        `if command -v javac >/dev/null 2>&1; then dirname "$(dirname "$(readlink -f "$(command -v javac)")")"; exit 0; fi; ` +
          `src=$(ls -d "$HOME"/sbx-test/jdk21 "$HOME"/jdk* 2>/dev/null | head -1); [ -x "$src/bin/javac" ] || exit 1; ` +
          `chmod -R u+w ${target} 2>/dev/null; rm -rf ${target}; mkdir -p /var/tmp/strideterm-e2e-tools && cp -r "$src" ${target} && echo ${target}`,
      ],
      { encoding: "utf8" },
    );
    if (staged.status !== 0) return null;
    return staged.stdout.replaceAll(NUL, "").trim().split(/\r?\n/u).pop() || null;
  }

  it("builds a Maven project whose plugins and dependencies come from the private registry", async (context) => {
    const maven = stageToolInDistro(
      process.env.STRIDETERM_E2E_MAVEN_HOME || "C:\\Program Files\\apache-maven-3.9.10",
      "maven",
    );
    if (!maven) return context.skip();
    const { registry, connection } = await startCentralBackedRegistry("/maven", "maven");
    try {
      registries = [connection];
      const project = temp("maven");
      for (const [name, content] of Object.entries(MAVEN_PROJECT)) {
        mkdirSync(path.dirname(path.join(project, name)), { recursive: true });
        writeFileSync(path.join(project, name), content);
      }
      const output = await runShell(
        "e2e:maven",
        [
          `${maven}/bin/mvn -B -q package 2>&1 | tail -15`,
          'echo "build-exit=${PIPESTATUS[0]}"',
          `echo "secret-in-settings=$(grep -c ${REGISTRY_SECRET} ${sessionTools("e2e:maven")}/settings.xml)"`,
        ].join("\n"),
        undefined,
        {},
        project,
        "e2e-maven",
      );
      expect(output).toContain("build-exit=0");
      expect(output).toContain("secret-in-settings=0");
      expect(existsSync(path.join(project, "target", "app-1.0.jar"))).toBe(true);
      expect(registry.unauthenticated).toBe(0);
      expect(registry.requests.some((request) => request.url.includes("commons-lang3"))).toBe(true);
    } finally {
      registry.close();
    }
  }, 600_000);

  it("builds a Gradle project whose dependencies come from the private registry", async (context) => {
    const gradle = stageToolInDistro(process.env.STRIDETERM_E2E_GRADLE_HOME || "C:\\accord\\apps\\gradle", "gradle");
    const jdk = stageJdkInDistro();
    if (!gradle || !jdk) return context.skip();
    const { registry, connection } = await startCentralBackedRegistry("/gradle", "gradle");
    try {
      registries = [connection];
      const project = temp("gradle");
      mkdirSync(path.join(project, "src", "main", "java", "e2e"), { recursive: true });
      writeFileSync(path.join(project, "settings.gradle"), "rootProject.name = 'app'\n");
      writeFileSync(
        path.join(project, "build.gradle"),
        "plugins { id 'java' }\ndependencies { implementation 'org.apache.commons:commons-lang3:3.14.0' }\n",
      );
      writeFileSync(
        path.join(project, "src", "main", "java", "e2e", "App.java"),
        MAVEN_PROJECT["src/main/java/e2e/App.java"],
      );
      const output = await runShell(
        "e2e:gradle",
        [
          `export JAVA_HOME=${jdk}; ${gradle}/bin/gradle --no-daemon --console=plain -q build 2>&1 | tail -15`,
          'echo "build-exit=${PIPESTATUS[0]}"',
        ].join("\n"),
        undefined,
        {},
        project,
        "e2e-gradle",
      );
      expect(output).toContain("build-exit=0");
      expect(existsSync(path.join(project, "build", "libs", "app.jar"))).toBe(true);
      expect(registry.unauthenticated).toBe(0);
      expect(registry.requests.some((request) => request.url.includes("commons-lang3"))).toBe(true);
    } finally {
      registry.close();
    }
  }, 600_000);
});

/** A gzip-compressed ustar archive of text files (what `npm pack` makes), without any tool. */
function tarGz(files: Record<string, string>): Buffer {
  const blocks: Buffer[] = [];
  for (const [name, content] of Object.entries(files)) {
    const body = Buffer.from(content);
    const header = Buffer.alloc(512);
    header.write(name, 0, 100, "utf8");
    header.write("0000644\0", 100);
    header.write("0000000\0", 108);
    header.write("0000000\0", 116);
    header.write(`${body.length.toString(8).padStart(11, "0")}\0`, 124);
    header.write(
      `${Math.floor(Date.now() / 1000)
        .toString(8)
        .padStart(11, "0")}\0`,
      136,
    );
    header.write("        ", 148);
    header.write("0", 156);
    header.write("ustar\0", 257);
    header.write("00", 263);
    let sum = 0;
    for (const byte of header) sum += byte;
    header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
    blocks.push(header, body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}

/** A zip archive with stored (uncompressed) entries: enough for a pure-Python wheel. */
function zipStore(files: Record<string, string>): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const nameBytes = Buffer.from(name);
    const body = Buffer.from(content);
    const checksum = crc32(body);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(body.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    parts.push(local, nameBytes, body);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt32LE(checksum, 16);
    entry.writeUInt32LE(body.length, 20);
    entry.writeUInt32LE(body.length, 24);
    entry.writeUInt16LE(nameBytes.length, 28);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, nameBytes);
    offset += local.length + nameBytes.length + body.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, directory, end]);
}

/** A plain HTTPS GET; the backend test setup stubs the global `fetch`, and this test is meant to reach Maven Central. */
function httpsGet(url: string): Promise<{ status: number; type: string; body: Buffer }> {
  return new Promise((resolve, reject) => {
    https
      .get(url, (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () =>
          resolve({
            status: response.statusCode || 502,
            type: String(response.headers["content-type"] || "application/octet-stream"),
            body: Buffer.concat(chunks),
          }),
        );
      })
      .on("error", reject);
  });
}
