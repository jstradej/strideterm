import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SANDBOX_GATEWAY_HOST, SANDBOX_SRT_VERSION, type SandboxDeniedRequest } from "../../shared/sandbox.js";
import type { RegistryConnection } from "../../shared/registry.js";
import { SandboxGateway } from "./gateway.js";
import type { RegistryAudit } from "./registry-audit.js";
import type { CommandRunner } from "./sandbox-environment.js";
import { matchesSandboxDomain, SandboxService, type SandboxWorkspaceView } from "./sandbox-service.js";
import { SandboxUnavailableError } from "./types.js";

const READY = `home=/home/dev
node=/usr/bin/node
bwrap=/usr/bin/bwrap
socat=/usr/bin/socat
rg=/usr/bin/rg
pm=apt-get
agent_claude=/usr/bin/claude
agent_codex=/usr/bin/codex
agent_copilot=/usr/bin/copilot
agent_opencode=/usr/bin/opencode
agent_gemini=/usr/bin/gemini
srt_module=/usr/lib/node_modules/@anthropic-ai/sandbox-runtime/dist/index.js
srt_version=${SANDBOX_SRT_VERSION}
wsl_gw=172.20.0.1
`;

const registry: RegistryConnection = {
  id: "r1",
  profileId: "default",
  label: "Corp",
  kind: "maven",
  url: "https://repo.corp.example/maven",
  mode: "mirror",
  authKind: "basic",
  username: "svc",
  npmScope: "",
};

describe("matchesSandboxDomain", () => {
  it("matches exact hosts, wildcard subdomains and ports", () => {
    expect(matchesSandboxDomain("a.example.com", 443, ["a.example.com"])).toBe(true);
    expect(matchesSandboxDomain("b.a.example.com", 443, ["*.example.com"])).toBe(true);
    expect(matchesSandboxDomain("example.com", 443, ["*.example.com"])).toBe(false);
    expect(matchesSandboxDomain("evil-example.com", 443, ["*.example.com"])).toBe(false);
    expect(matchesSandboxDomain("a.example.com", 8443, ["a.example.com:8443"])).toBe(true);
    expect(matchesSandboxDomain("a.example.com", 443, ["a.example.com:8443"])).toBe(false);
    expect(matchesSandboxDomain("a.example.com", null, ["a.example.com:8443"])).toBe(false);
  });
});

/** Unix sockets cannot be created in every test environment (a Windows runner refuses them); the path is all the service needs. */
class StubSocketGateway extends SandboxGateway {
  private stubSocket = "";
  override async listenUnix(socketPath: string): Promise<void> {
    this.stubSocket = socketPath;
  }
  override get socketPath(): string {
    return this.stubSocket;
  }
}

describe("SandboxService", () => {
  const dirs: string[] = [];
  let dataDir: string;
  let workspaceDir: string;
  let gateway: SandboxGateway;
  let denied: SandboxDeniedRequest[];
  let settled: SandboxDeniedRequest[];
  let workspaceDomains: string[];
  let probe: string;
  let service: SandboxService;

  const temp = (name: string) => {
    const dir = mkdtempSync(path.join(os.tmpdir(), `sbx-svc-${name}-`));
    dirs.push(dir);
    return dir;
  };
  const run: CommandRunner = async () => ({ code: 0, stdout: probe, stderr: "" });
  const workspace = (overrides: Partial<SandboxWorkspaceView> = {}): SandboxWorkspaceView => ({
    id: "w1",
    profileId: "default",
    kind: "terminal",
    cwd: workspaceDir,
    sandboxEnabled: true,
    ...overrides,
  });
  const panel = { id: "p1", command: "claude --model opus" };
  const baseContext = (overrides: Record<string, unknown> = {}) => ({
    sessionId: "w1:p1",
    workspace: workspace(),
    panel,
    cwd: workspaceDir,
    ...overrides,
  });
  const wrapContext = (env: Record<string, string> = {}) => ({
    ...baseContext(),
    launcher: { file: "/bin/zsh", args: ["-l"] },
    env: {
      PATH: "/usr/bin",
      HOME: "/home/dev",
      TERM: "xterm",
      GITHUB_TOKEN: "ghp_leak",
      ANTHROPIC_API_KEY: "sk-ant",
      STRIDETERM_SESSION_ID: "w1:p1",
      STRIDETERM_SESSION_TOKEN: "tok",
      ...env,
    },
  });
  const launchConfig = (sessionId = "w1:p1") =>
    JSON.parse(
      readFileSync(
        path.join(dataDir, "sandbox", "sessions", sessionId.replace(/[^A-Za-z0-9._-]/gu, "_"), "launch.json"),
        "utf8",
      ),
    );

  beforeEach(() => {
    // Not under the system temp folder: on Linux that is /tmp, which the sandbox grants for writing, and the
    // tests below assert that nothing strIDEterm owns sits under a folder the agent may write.
    const dataRoot = fileURLToPath(new URL("../../../node_modules/.tmp/sbx-svc", import.meta.url));
    mkdirSync(dataRoot, { recursive: true });
    dataDir = mkdtempSync(path.join(dataRoot, "data-"));
    dirs.push(dataDir);
    workspaceDir = temp("ws");
    writeFileSync(path.join(workspaceDir, "package.json"), "{}");
    writeFileSync(path.join(workspaceDir, "pom.xml"), "<project/>");
    probe = READY;
    denied = [];
    settled = [];
    workspaceDomains = [];
    gateway = new StubSocketGateway({
      audit: {
        begin: () => true,
        end: () => undefined,
        flush: () => undefined,
        beginOperation: () => () => undefined,
      } as RegistryAudit,
      resolveRegistry: () => null,
    });
    service = new SandboxService({
      dataDir,
      gateway,
      platform: "linux",
      run,
      tmpDir: temp("tmp"),
      getRegistries: () => [registry],
      getWorkspaceDomains: () => workspaceDomains,
      onDenied: (request) => denied.push(request),
      onDeniedSettled: (request) => settled.push(request),
      askTimeoutMs: 1000,
    });
    service.writeLauncher();
  });

  afterEach(async () => {
    await service.shutdown();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("gives each workspace its own Gradle home outside the shared cache and shares only the downloaded artifacts", async () => {
    writeFileSync(path.join(workspaceDir, "build.gradle"), "");
    const launches: Array<ReturnType<typeof launchConfig>> = [];
    for (const id of ["w1", "w2"]) {
      const sessionId = `${id}:p1`;
      await service.prepare(baseContext({ sessionId, workspace: workspace({ id }) }));
      service.wrap({ ...wrapContext(), ...baseContext({ sessionId, workspace: workspace({ id }) }) });
      launches.push(launchConfig(sessionId));
    }
    const [first, second] = launches;
    const cacheRoot = path.join(dataDir, "sandbox", "cache");
    const gradleHome = (config: (typeof launches)[number]) =>
      config.runtime.filesystem.allowWrite.find(
        (item: string) => item.endsWith(`${path.sep}gradle`) && item.includes("workspace-homes"),
      );
    expect(gradleHome(first)).toBeTruthy();
    expect(gradleHome(first)).not.toBe(gradleHome(second));
    for (const config of launches) {
      const home = gradleHome(config);
      expect(home.startsWith(cacheRoot)).toBe(false);
      // The home is not under any other writable grant, so nothing another workspace may write reaches its init scripts.
      for (const granted of config.runtime.filesystem.allowWrite) {
        if (granted !== home) expect(home.startsWith(`${granted}${path.sep}`)).toBe(false);
      }
      const norm = (value: string) => value.split(String.fromCharCode(92)).join("/");
      const gradleLinks = config.confinedLinks.filter((item: { root: string }) => norm(item.root) === norm(home));
      expect(gradleLinks).toHaveLength(1);
      expect(norm(gradleLinks[0].link)).toBe(norm(path.posix.join(home, "caches", "modules-2")));
      expect(norm(gradleLinks[0].target)).toBe(norm(path.posix.join(cacheRoot, "gradle", "modules-2")));
      expect(config.ensureDirs.map(norm)).toContain(norm(path.posix.join(cacheRoot, "gradle", "modules-2")));
    }
  });

  it("fails closed, naming what is missing, when the sandbox cannot start", async () => {
    probe = "home=/home/dev\nnode=/usr/bin/node\npm=apt-get\n";
    await expect(service.prepare(baseContext())).rejects.toThrow(SandboxUnavailableError);
    await expect(service.prepare(baseContext())).rejects.toThrow(/bubblewrap/);
    expect(service.isSandboxed("w1:p1")).toBe(false);
  });

  describe("the agent CLI of a tab", () => {
    const withoutAgent = (agent: string) => READY.replace(new RegExp(`^agent_${agent}=.*$`, "mu"), `agent_${agent}=`);

    it("refuses to start a tab whose agent is not installed where the sandbox runs, naming it", async () => {
      probe = withoutAgent("claude");
      await expect(service.prepare(baseContext())).rejects.toThrow(SandboxUnavailableError);
      await expect(service.prepare(baseContext())).rejects.toThrow(
        /claude CLI is not installed.*on this machine.*restart the tab/u,
      );
      expect(service.isSandboxed("w1:p1")).toBe(false);
    });

    it("names the WSL distribution on Windows", async () => {
      const win = new SandboxService({
        dataDir,
        gateway,
        platform: "win32",
        run,
        tmpDir: temp("tmpw"),
        getRegistries: () => [],
        getWorkspaceDomains: () => [],
        onDenied: () => undefined,
        onDeniedSettled: () => undefined,
      });
      probe = READY.replace("agent_claude=/usr/bin/claude", "agent_claude=/mnt/c/Users/dev/npm/claude");
      const wslWorkspace = workspace({ cwd: String.raw`\\wsl$\Debian\home\dev\app` });
      await expect(win.prepare(baseContext({ workspace: wslWorkspace, cwd: wslWorkspace.cwd }))).rejects.toThrow(
        /inside WSL \(distribution Debian\)/u,
      );
    });

    it("says so when only the Windows install was found", async () => {
      const win = new SandboxService({
        dataDir,
        gateway,
        platform: "win32",
        run,
        tmpDir: temp("tmpw2"),
        getRegistries: () => [],
        getWorkspaceDomains: () => [],
        onDenied: () => undefined,
        onDeniedSettled: () => undefined,
      });
      probe = READY.replace("agent_claude=/usr/bin/claude", "agent_claude=/mnt/c/Users/dev/npm/claude");
      const wslWorkspace = workspace({ cwd: String.raw`\\wsl$\Debian\home\dev\app` });
      await expect(win.prepare(baseContext({ workspace: wslWorkspace, cwd: wslWorkspace.cwd }))).rejects.toThrow(
        /Only the Windows claude CLI was found.*install claude inside WSL/u,
      );
    });

    it("puts the agent installer's own folder at the end of PATH inside the sandbox", async () => {
      const opencode = { id: "p1", command: "opencode" };
      service.writeLauncher();
      await service.prepare(baseContext({ panel: opencode }));
      service.wrap({ ...wrapContext(), panel: opencode });
      const config = launchConfig();
      expect(config.pathAppend).toEqual(["/home/dev/.opencode/bin"]);
      expect(config.runtime.filesystem.allowRead).toContain("/home/dev/.opencode/bin");
      expect(config.runtime.filesystem.allowWrite).not.toContain("/home/dev/.opencode/bin");
    });

    it("probes again once before refusing, because the user may have just installed it", async () => {
      const counting = vi.fn<CommandRunner>(async () => ({ code: 0, stdout: probe, stderr: "" }));
      service = new SandboxService({
        dataDir,
        gateway,
        platform: "linux",
        run: counting,
        tmpDir: temp("tmp5"),
        getRegistries: () => [],
        getWorkspaceDomains: () => [],
        onDenied: () => undefined,
        onDeniedSettled: () => undefined,
      });
      await service.prepare(baseContext());
      expect(counting).toHaveBeenCalledTimes(1);
      probe = withoutAgent("claude");
      await service.getStatus({ force: true });
      counting.mockClear();
      probe = READY;
      await service.prepare(baseContext({ sessionId: "w1:q" }));
      expect(counting).toHaveBeenCalledTimes(1);
      probe = withoutAgent("claude");
      counting.mockClear();
      await service.getStatus({ force: true });
      await expect(service.prepare(baseContext({ sessionId: "w1:r" }))).rejects.toThrow(/not installed/u);
      expect(counting).toHaveBeenCalledTimes(2);
    });

    it.each(["claude", "claude --model opus", "CLAUDE.CMD --x"])(
      "judges a bare executable name: %s",
      async (command) => {
        probe = withoutAgent("claude");
        await expect(service.prepare(baseContext({ panel: { id: "p", command } }))).rejects.toThrow(/not installed/u);
      },
    );

    it.each([
      "npx claude",
      "/opt/tools/claude",
      String.raw`C:\tools\claude.cmd`,
      '"claude" --x',
      "claudex",
      "my-claude",
    ])("does not judge a path, a wrapper or another name: %s", async (command) => {
      probe = withoutAgent("claude");
      await service.prepare(baseContext({ panel: { id: "p", command } }));
    });

    it("does not judge a task command that is not an agent", async () => {
      probe = withoutAgent("claude");
      await service.prepare(baseContext({ panel: { id: "p", command: "my-wrapper --claude" } }));
    });

    it("ignores the other agents that are missing", async () => {
      probe = withoutAgent("gemini");
      await service.prepare(baseContext());
    });
  });

  it("probes the host once for tabs that start together, and again after a forced check", async () => {
    const counting = vi.fn(run);
    service = new SandboxService({
      dataDir,
      gateway,
      platform: "linux",
      run: counting,
      tmpDir: temp("tmp4"),
      getRegistries: () => [],
      getWorkspaceDomains: () => [],
      onDenied: () => undefined,
      onDeniedSettled: () => undefined,
    });
    await Promise.all([
      service.prepare(baseContext({ sessionId: "w1:a" })),
      service.prepare(baseContext({ sessionId: "w1:b" })),
      service.prepare(baseContext({ sessionId: "w1:c" })),
    ]);
    expect(counting).toHaveBeenCalledTimes(1);
    await service.getStatus();
    expect(counting).toHaveBeenCalledTimes(1);
    await service.getStatus({ force: true });
    expect(counting).toHaveBeenCalledTimes(2);
  });

  it("fails closed when the host does not answer at all", async () => {
    probe = "";
    await expect(service.prepare(baseContext())).rejects.toThrow(/cannot start/);
  });

  it("runs the launcher with the node of the sandbox host and a config it generated itself", async () => {
    await service.prepare(baseContext());
    const launch = service.wrap(wrapContext());
    expect(launch.file).toBe("/usr/bin/node");
    expect(launch.args[0]).toMatch(/launcher-[0-9a-f]{12}\.mjs$/u);
    expect(launch.args[1]).toContain(path.join("sandbox", "sessions"));
    expect(launch.cwd).toBe(workspaceDir);
    const config = launchConfig();
    expect(config.command).toEqual(["/bin/zsh", "-l"]);
    expect(config.srtModule).toBe("/usr/lib/node_modules/@anthropic-ai/sandbox-runtime/dist/index.js");
    expect(config.runtime.filesystem.allowWrite).toContain(workspaceDir);
    expect(config.runtime.filesystem.denyRead).toContain("/home/dev");
    expect(config.runtime.network.allowedDomains).toEqual(
      expect.arrayContaining([
        "api.anthropic.com",
        "registry.npmjs.org",
        "repo.maven.apache.org",
        SANDBOX_GATEWAY_HOST,
      ]),
    );
  });

  it("gives the sandbox no host token: only the allowed names and the agent's own sign-in", async () => {
    await service.prepare(baseContext());
    const launch = service.wrap(wrapContext());
    expect(launch.env).not.toHaveProperty("GITHUB_TOKEN");
    expect(launch.env).toMatchObject({
      ANTHROPIC_API_KEY: "sk-ant",
      STRIDETERM_SESSION_TOKEN: "tok",
      PATH: "/usr/bin",
    });
  });

  it("gives a Claude launch its own copy of .claude.json and no access to the host's file", async () => {
    await service.prepare(baseContext());
    service.wrap(wrapContext({ STRIDETERM_HOST_TOKEN: "inert", STRIDETERM_DATA_DIR: "/host/data" }));
    const config = launchConfig();
    expect(config.homeOverride).toBe(path.join(dataDir, "sandbox", "workspace-homes", "w1", "home"));
    expect(config.seededFiles).toContainEqual({
      sources: ["/home/dev/.claude.json"],
      dest: `${config.homeOverride}/.claude.json`,
      root: config.homeOverride,
      filter: "claude-state",
    });
    const { allowRead, allowWrite, denyWrite } = config.runtime.filesystem;
    for (const list of [allowRead, allowWrite, config.optional.allowRead, config.optional.allowWrite]) {
      expect(list.filter((item: string) => item.endsWith("/.claude.json"))).toEqual([]);
    }
    expect(allowWrite).toContain(config.homeOverride);
    expect(denyWrite).not.toContain("/home/dev/.claude.json");
    expect(config.keepEnv).not.toContain("STRIDETERM_HOST_TOKEN");
    expect(config.keepEnv).not.toContain("STRIDETERM_DATA_DIR");
  });

  it("gives an agent a sanitized view of its config files and grants its folder entry by entry, never whole", async () => {
    await service.prepare(baseContext());
    service.wrap(wrapContext());
    const config = launchConfig();
    expect(config.confinedMirrors).toEqual([
      {
        dir: `${config.homeOverride}/.claude`,
        sources: ["/home/dev/.claude"],
        exclude: ["settings.json", "settings.local.json", ".credentials.json"],
        root: config.homeOverride,
      },
    ]);
    // The mirrored folder is not also linked whole.
    expect(
      config.confinedLinks.find((item: { link: string }) => item.link === `${config.homeOverride}/.claude`),
    ).toBeUndefined();
    for (const name of ["settings.json", "settings.local.json"]) {
      expect(config.seededFiles).toContainEqual({
        sources: [`/home/dev/.claude/${name}`],
        dest: `${config.homeOverride}/.claude/${name}`,
        root: config.homeOverride,
        filter: "json",
        refresh: true,
        keepEnv: expect.arrayContaining(["ANTHROPIC_API_KEY"]),
      });
    }
    // The model login is shared as a copy that holds the model login only; the MCP sign-ins beside it stay on the host.
    expect(config.seededFiles).toContainEqual({
      sources: ["/home/dev/.claude/.credentials.json"],
      dest: `${config.homeOverride}/.claude/.credentials.json`,
      root: config.homeOverride,
      filter: "claude-credentials",
      refresh: true,
      keepEnv: expect.arrayContaining(["ANTHROPIC_API_KEY"]),
    });
    const { allowRead, allowWrite } = config.runtime.filesystem;
    for (const list of [allowRead, allowWrite, config.optional.allowRead, config.optional.allowWrite]) {
      expect(list).not.toContain("/home/dev/.claude");
      expect(list).not.toContain("/home/dev/.claude/.credentials.json");
    }
  });

  it.each([
    ["codex", ".codex", ["config.toml", "hooks.json"]],
    ["copilot", ".copilot", ["mcp-config.json", "config.json"]],
  ])("seeds %s hook stores as sandbox-owned sanitized copies", async (provider, folder, excluded) => {
    await service.prepare(baseContext({ panel: { id: "p", command: provider } }));
    service.wrap({ ...wrapContext(), panel: { id: "p", command: provider } });
    const config = launchConfig();
    const mirror = config.confinedMirrors.find(
      (item: { dir: string }) => item.dir === `${config.homeOverride}/${folder}`,
    );
    expect(mirror.exclude).toEqual(expect.arrayContaining(excluded));
    expect(config.seededFiles).toEqual(
      expect.arrayContaining(
        excluded.map((name) =>
          expect.objectContaining({
            dest: `${config.homeOverride}/${folder}/${name}`,
            filter: name === "config.toml" ? "toml" : name === "config.json" ? "copilot-config" : "json",
            refresh: true,
          }),
        ),
      ),
    );
    expect(config.runtime.filesystem.allowWrite).not.toContain(`/home/dev/${folder}`);
  });

  it("never reads settings from the workspace tree: the config lives in the data directory", async () => {
    mkdirSync(path.join(workspaceDir, ".srt"), { recursive: true });
    writeFileSync(path.join(workspaceDir, ".srt-settings.json"), '{"network":{"allowedDomains":["*"]}}');
    await service.prepare(baseContext());
    const launch = service.wrap(wrapContext());
    expect(launch.args[1].startsWith(dataDir)).toBe(true);
    expect(JSON.stringify(launchConfig())).not.toContain('"*"');
  });

  it("points the broker URLs at the gateway and registers only this session's brokers", async () => {
    await service.prepare(baseContext());
    const launch = service.wrap(
      wrapContext({
        STRIDETERM_NOTIFY_URL: "http://127.0.0.1:5001/notify?sid=w1%3Ap1&secret=sec",
        STRIDETERM_INTERNAL_MCP_URL: "http://127.0.0.1:5002/internal-mcp",
        STRIDETERM_INTERNAL_MCP_CAPABILITY: "c".repeat(43),
        OPENCODE_CONFIG_CONTENT: JSON.stringify({
          mcp: {
            internal: {
              type: "local",
              command: ["node", "bridge.mjs"],
              environment: { STRIDETERM_INTERNAL_MCP_URL: "http://127.0.0.1:5002/internal-mcp" },
            },
          },
        }),
      }),
    );
    expect(launch.env.STRIDETERM_NOTIFY_URL).toMatch(
      new RegExp(`^http://${SANDBOX_GATEWAY_HOST}/broker/[A-Za-z0-9_-]{43}/notify\\?sid=w1%3Ap1&secret=sec$`, "u"),
    );
    expect(launch.env.STRIDETERM_INTERNAL_MCP_URL).toMatch(/\/broker\/[A-Za-z0-9_-]{43}\/internal-mcp$/u);
    expect(launch.env.OPENCODE_CONFIG_CONTENT).toContain(SANDBOX_GATEWAY_HOST);
    expect(launch.env.OPENCODE_CONFIG_CONTENT).not.toContain("127.0.0.1");
    expect(gateway.hasSession("w1:p1")).toBe(true);
    expect(JSON.stringify(launchConfig())).not.toContain("127.0.0.1:5001");
  });

  it("retries a gateway that fails to start, and refuses a gateway-dependent launch when it stays down", async () => {
    let attempts = 0;
    let failures = 2;
    class FlakyGateway extends StubSocketGateway {
      override async listenUnix(socketPath: string): Promise<void> {
        attempts += 1;
        if (failures-- > 0) throw new Error("injected socket bind failure");
        return super.listenUnix(socketPath);
      }
    }
    const build = (flaky: SandboxGateway) =>
      new SandboxService({
        dataDir,
        gateway: flaky,
        platform: "linux",
        run,
        tmpDir: temp("tmp"),
        getRegistries: () => [registry],
        getWorkspaceDomains: () => [],
        onDenied: () => undefined,
        onDeniedSettled: () => undefined,
        askTimeoutMs: 1000,
      });
    const options = {
      audit: {
        begin: () => true,
        end: () => undefined,
        flush: () => undefined,
        beginOperation: () => () => undefined,
      } as RegistryAudit,
      resolveRegistry: () => null,
    };
    const recovering = build(new FlakyGateway(options));
    recovering.writeLauncher();
    await recovering.prepare(baseContext());
    expect(attempts).toBe(3);
    expect(() =>
      recovering.wrap(wrapContext({ STRIDETERM_INTERNAL_MCP_URL: "http://127.0.0.1:5002/internal-mcp" })),
    ).not.toThrow();
    await recovering.shutdown();

    failures = Infinity;
    const broken = build(new FlakyGateway(options));
    broken.writeLauncher();
    await broken.prepare(baseContext());
    expect(() =>
      broken.wrap(wrapContext({ STRIDETERM_INTERNAL_MCP_URL: "http://127.0.0.1:5002/internal-mcp" })),
    ).toThrow(SandboxUnavailableError);
    await broken.shutdown();
  });

  it("generates the tool configuration for the toolchains and registries, without a credential", async () => {
    await service.prepare(baseContext());
    const launch = service.wrap(wrapContext());
    const files = launchConfig().toolFiles as Array<{ path: string; content: string }>;
    const settings = files.find((file) => file.path.endsWith("settings.xml"));
    // Published into the session folder strIDEterm owns, never into /tmp where the agent can plant links.
    expect(settings?.path.replaceAll("\\", "/")).toContain("/sandbox/sessions/");
    expect(settings?.path.startsWith("/tmp/")).toBe(false);
    expect((settings as { root?: string }).root).toBeDefined();
    expect(settings?.content).toContain(`${SANDBOX_GATEWAY_HOST}/registry/`);
    expect(settings?.content).not.toContain("repo.corp.example");
    expect(launch.env.MAVEN_ARGS).toContain("-Dmaven.resolver.transport=wagon");
    expect(launch.env.MAVEN_ARGS).toContain("settings.xml");
    expect(launch.env.npm_config_cache).toContain(path.join("sandbox", "cache").replaceAll("\\", "/").split("/").pop());
    expect(JSON.stringify(files)).not.toContain("svc:");
  });

  it("falls back to the cache and Maven proxy settings when no registry is connected", async () => {
    service = new SandboxService({
      dataDir,
      gateway,
      platform: "linux",
      run,
      tmpDir: temp("tmp2"),
      getRegistries: () => [],
      getWorkspaceDomains: () => [],
      onDenied: () => undefined,
      onDeniedSettled: () => undefined,
    });
    service.writeLauncher();
    await service.prepare(baseContext());
    const launch = service.wrap(wrapContext());
    expect(launch.env.MAVEN_ARGS).toBeDefined();
    expect(launch.env).not.toHaveProperty("NPM_CONFIG_USERCONFIG");
  });

  it("runs whatever backend it is given, so a third one needs no change here", async () => {
    const buildLaunch = vi.fn(() => ({ file: "microvm-launch", args: ["x"], env: {}, cwd: workspaceDir }));
    const files = (sessionId: string) => {
      const dir = path.join(dataDir, "other", sessionId.replace(/[^A-Za-z0-9._-]/gu, "_"));
      return { dir, denialsFile: path.join(dir, "denials.jsonl"), decisionsDir: path.join(dir, "decisions") };
    };
    service = new SandboxService({
      dataDir,
      gateway,
      platform: "linux",
      run,
      backend: { id: "microvm", sessionFiles: files, buildLaunch, toolDir: () => "/tmp/tools" },
      tmpDir: temp("tmp5"),
      getRegistries: () => [],
      getWorkspaceDomains: () => [],
      onDenied: () => undefined,
      onDeniedSettled: () => undefined,
    });
    await service.prepare(baseContext());
    expect(service.wrap(wrapContext())).toMatchObject({ file: "microvm-launch" });
    expect(buildLaunch).toHaveBeenCalledTimes(1);
  });

  it("refuses a workspace folder that does not exist", async () => {
    await service.prepare(baseContext());
    const missing = path.join(workspaceDir, "gone");
    expect(() => service.wrap({ ...wrapContext(), workspace: workspace({ cwd: missing }), cwd: missing })).toThrow(
      /does not exist/,
    );
  });

  describe("destinations the sandbox asks about", () => {
    const denialsFile = () => path.join(dataDir, "sandbox", "sessions", "w1_p1", "denials.jsonl");
    const decisionFile = (id: string) => path.join(dataDir, "sandbox", "sessions", "w1_p1", "decisions", `${id}.json`);
    const ask = (id: string, host: string, port = 443) =>
      writeFileSync(denialsFile(), `${JSON.stringify({ id, host, port, at: Date.now() })}\n`, { flag: "a" });

    beforeEach(async () => {
      await service.prepare(baseContext());
      service.wrap(wrapContext());
    });

    it("raises a request for a destination nothing decides and waits for the user", () => {
      ask("r-1", "Example.org");
      service.pollDenials();
      expect(denied).toHaveLength(1);
      expect(denied[0]).toMatchObject({
        id: "r-1",
        host: "example.org",
        port: 443,
        workspaceId: "w1",
        state: "pending",
      });
      expect(existsSync(decisionFile("r-1"))).toBe(false);
      expect(service.listPending("w1")).toHaveLength(1);
      expect(service.listPending("other")).toHaveLength(0);
    });

    it("answers allow without asking when the workspace already allowed that destination", () => {
      workspaceDomains = ["*.example.org"];
      ask("r-2", "api.example.org");
      service.pollDenials();
      expect(denied).toHaveLength(0);
      expect(JSON.parse(readFileSync(decisionFile("r-2"), "utf8"))).toEqual({ allow: true });
    });

    it("writes the user's decision where the waiting launcher reads it, once", () => {
      ask("r-3", "example.org");
      service.pollDenials();
      expect(service.decide("r-3", false)).toBe(true);
      expect(JSON.parse(readFileSync(decisionFile("r-3"), "utf8"))).toEqual({ allow: false });
      expect(settled[0]).toMatchObject({ id: "r-3", state: "denied" });
      expect(service.decide("r-3", true)).toBe(false);
      expect(service.decide("unknown", true)).toBe(false);
    });

    it("reads each line once and ignores an incomplete one until it is finished", () => {
      writeFileSync(denialsFile(), '{"id":"r-4","host":"a.example.org","port":443', { flag: "a" });
      service.pollDenials();
      expect(denied).toHaveLength(0);
      writeFileSync(denialsFile(), ',"at":1}\n', { flag: "a" });
      service.pollDenials();
      service.pollDenials();
      expect(denied).toHaveLength(1);
    });

    it("drops lines that are not a request, including an id that could name another file", () => {
      writeFileSync(denialsFile(), 'not json\n{"id":"../x","host":"a.example.org"}\n{"id":"ok","host":7}\n', {
        flag: "a",
      });
      service.pollDenials();
      expect(denied).toHaveLength(0);
    });

    it("expires a request nobody answered", () => {
      vi.useFakeTimers();
      try {
        ask("r-5", "slow.example.org");
        service.pollDenials();
        vi.advanceTimersByTime(7000);
        service.pollDenials();
        expect(settled.some((item) => item.id === "r-5" && item.state === "expired")).toBe(true);
        expect(service.decide("r-5", true)).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });

    it("revokes the gateway capability and removes the session's files on release", () => {
      ask("r-6", "example.org");
      service.pollDenials();
      service.release("w1:p1");
      expect(gateway.hasSession("w1:p1")).toBe(false);
      expect(existsSync(path.join(dataDir, "sandbox", "sessions", "w1_p1"))).toBe(false);
      expect(settled.some((item) => item.id === "r-6")).toBe(true);
    });
  });

  it("runs a Windows tab in WSL: wsl.exe, the distro, and only the named variables carried over", async () => {
    if (process.platform !== "win32") return;
    service = new SandboxService({
      dataDir,
      gateway,
      platform: "win32",
      run,
      tmpDir: temp("tmp3"),
      getRegistries: () => [],
      getWorkspaceDomains: () => [],
      onDenied: () => undefined,
      onDeniedSettled: () => undefined,
    });
    service.writeLauncher();
    await service.prepare(baseContext());
    const launch = service.wrap({
      ...wrapContext({ Path: "C:\\Windows", STRIDETERM_SESSION_ID: "w1:p1" }),
      launcher: { file: "C:\\Program Files\\PowerShell\\7\\pwsh.exe", args: ["-NoLogo"] },
    });
    expect(launch.file).toBe("wsl.exe");
    expect(launch.args).toEqual(expect.arrayContaining(["-e", "bash", "-lc", "/usr/bin/node"]));
    expect(launch.args.join(" ")).toContain("/mnt/c/");
    expect(launch.env.WSLENV.split(":")).toContain("STRIDETERM_SESSION_ID");
    expect(launch.env.WSLENV.split(":")).not.toContain("Path");
    const config = launchConfig();
    expect(config.command).toEqual(["bash", "-l"]);
    expect(config.runtime.filesystem.allowWrite[0]).toMatch(/^\/mnt\/c\//u);
    // Hooks registered by the Windows agent configuration name Windows paths: the sandbox's `node` rewrites them.
    const shim = config.toolFiles.find((file: { path: string }) => file.path.endsWith("/bin/node"));
    expect(shim.executable).toBe(true);
    expect(shim.content).toContain("/mnt/");
    expect(config.pathPrepend).toEqual([shim.path.replace(/\/node$/u, "")]);
  });
  it("shares the Windows user's agent sign-in with the distro through links, and keeps the agent's config read-only", async () => {
    if (process.platform !== "win32") return;
    const windowsHome = temp("winhome");
    mkdirSync(path.join(windowsHome, ".claude"));
    writeFileSync(path.join(windowsHome, ".claude.json"), "{}");
    service = new SandboxService({
      dataDir,
      gateway,
      platform: "win32",
      run,
      tmpDir: temp("tmp6"),
      windowsHome,
      getRegistries: () => [],
      getWorkspaceDomains: () => [],
      onDenied: () => undefined,
      onDeniedSettled: () => undefined,
    });
    service.writeLauncher();
    await service.prepare(baseContext());
    service.wrap({
      ...wrapContext({ Path: "C:\\Windows", STRIDETERM_SESSION_ID: "w1:p1" }),
      launcher: { file: "C:\\Program Files\\PowerShell\\7\\pwsh.exe", args: ["-NoLogo"] },
    });
    const config = launchConfig();
    // The sandbox runtime cannot bind a link, so the agent's home is a folder of links the launcher makes.
    expect(config.homeOverride).toBe("/var/tmp/strideterm-sandbox-homes/w1/home");
    const linkFor = (name: string) =>
      config.confinedLinks.find((item: { link: string }) => item.link === `${config.homeOverride}/${name}`);
    // The folder holding settings.json is mirrored, not linked; the distro's own folder wins, the Windows user's is the fallback.
    expect(linkFor(".claude")).toBeUndefined();
    const claude = config.confinedMirrors.find(
      (item: { dir: string }) => item.dir === `${config.homeOverride}/.claude`,
    );
    expect(claude.sources[0]).toBe("/home/dev/.claude");
    expect(claude.sources[1].startsWith("/mnt/c/")).toBe(true);
    expect(claude.sources[1].endsWith("/.claude")).toBe(true);
    expect(claude.exclude).toContain("settings.json");
    expect(claude.root).toBe(config.homeOverride);
    // `.claude.json` also carries configuration the host CLI obeys: it is copied, never linked.
    expect(linkFor(".claude.json")).toBeUndefined();
    const seeded = config.seededFiles.find(
      (item: { dest: string }) => item.dest === `${config.homeOverride}/.claude.json`,
    );
    expect(seeded.sources[0]).toBe("/home/dev/.claude.json");
    expect(seeded.sources[1].startsWith("/mnt/c/")).toBe(true);
    expect(config.runtime.filesystem.allowWrite.some((item: string) => item.endsWith("/.claude.json"))).toBe(false);
    // Only what exists on the Windows side is offered as a fallback.
    expect(linkFor(".config/claude").targets).toEqual(["/home/dev/.config/claude"]);
    // The real distro home is not touched: the sign-in folder is not created empty, and nothing is linked there.
    expect(config.ensureDirs).not.toContain("/home/dev/.claude");
    expect(config.loginLinks).toBeUndefined();
    expect(config.runtime.filesystem.allowWrite).not.toContain(claude.sources[1]);
    expect(config.runtime.filesystem.allowRead).not.toContain(claude.sources[1]);
    expect(config.runtime.filesystem.allowWrite).toContain(config.homeOverride);
    expect(config.optional.denyWrite).toContain(`${claude.sources[1]}/settings.json`);
  });
});
