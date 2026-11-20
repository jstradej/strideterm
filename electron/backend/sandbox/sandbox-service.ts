import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { SANDBOX_GATEWAY_HOST, type SandboxDeniedRequest, type SandboxStatus } from "../../shared/sandbox.js";
import type { RegistryConnection } from "../../shared/registry.js";
import { getLogger } from "../logger.js";
import { isSandboxedPanel } from "../../shared/sandbox-eligibility.js";
import { GEMINI_SETTINGS_PATH_ENV } from "../agent-mcp-launch.js";
import { detectSandboxAgent, getAgentSandboxProfile } from "./agent-profile.js";
import { SrtBackend, sessionLaunchDir } from "./backend-srt.js";
import { resolveExternalGitDirs } from "./git-dirs.js";
import type { BrokerRouteName, SandboxGateway } from "./gateway.js";
import { SANDBOX_LAUNCHER_HASH, SANDBOX_LAUNCHER_SOURCE } from "./launcher-script.js";
import {
  buildGradleInit,
  buildMavenSettings,
  buildNpmrc,
  buildPipConf,
  mavenArgs,
  type GatewayRegistryEndpoint,
} from "./registry-tool-config.js";
import { sanitizeSandboxEnv } from "./sandbox-env.js";
import {
  bundledRuntimeCopyStep,
  describeSandboxHost,
  execRunner,
  planInstall,
  probeSandboxHost,
  type CommandRunner,
  type HostDescription,
} from "./sandbox-environment.js";
import { detectToolchains, toolchainCacheFolder, toolchainEnv } from "./toolchain-profile.js";
import {
  SandboxUnavailableError,
  type SandboxBackend,
  type SandboxEnvironment,
  type SandboxLaunch,
  type SandboxSpec,
} from "./types.js";
import { homeMirrorEntries } from "./sandbox-policy.js";
import { mirrorExclusions, mirroredAgentFolders } from "./agent-profile.js";
import { WSL_NODE_SHIM } from "./windows-path-shim.js";
import { distroOfPaths, windowsPathToWsl } from "../../shared/wsl-paths.js";

const log = getLogger("sandbox");

export interface SandboxWorkspaceView {
  id: string;
  profileId?: string;
  kind?: string;
  cwd?: string;
  gitRoots?: string[];
  sandboxEnabled?: boolean;
  sandboxAllowedDomains?: string[];
  review?: { checkout?: { rootPath?: string; cacheRepoPath?: string } | null } | null;
}

/**
 * The agent a tab launches when its command starts with that agent's bare executable name (`claude`,
 * `gemini.cmd`). A path or a wrapper (`npx …`) is not judged: the probe finds names on PATH, not what such a
 * command would run, and refusing a launch that would have worked is worse than a plain "command not found".
 */
function bareAgentExecutable(command: string | undefined): string | null {
  const agent = detectSandboxAgent(command);
  const first = String(command || "")
    .trim()
    .split(/\s+/u)[0];
  return agent && new RegExp(`^${agent}(?:\\.(?:exe|cmd|bat|com))?$`, "iu").test(first) ? agent : null;
}

export interface SandboxPanelView {
  id: string;
  command?: string;
  cwd?: string;
  launch?: unknown;
}

export interface SandboxWrapContext {
  sessionId: string;
  workspace: SandboxWorkspaceView;
  panel: SandboxPanelView;
  /** What the session manager would have spawned. */
  launcher: { file: string; args: string[] };
  /** The working directory it would have used. */
  cwd: string;
  /** The environment it would have used, host credentials included — filtered here. */
  env: Record<string, string>;
}

export interface SandboxServiceOptions {
  /** Folder strIDEterm keeps its data in (host notation). */
  dataDir: string;
  gateway: SandboxGateway;
  getRegistries: (profileId: string) => RegistryConnection[];
  getWorkspaceDomains: (workspaceId: string) => string[];
  onDenied: (request: SandboxDeniedRequest) => void;
  onDeniedSettled: (request: SandboxDeniedRequest) => void;
  /** The isolation backend; `srt` unless another one is supplied. */
  backend?: SandboxBackend;
  /** The Windows user's home folder (test seam; defaults to the OS one). */
  windowsHome?: string;
  platform?: NodeJS.Platform;
  run?: CommandRunner;
  /** The sandbox runtime shipped with the app (see `findBundledSandboxRuntime`); none when absent. */
  bundledRuntimeDir?: string | null;
  tmpDir?: string;
  pollMs?: number;
  askTimeoutMs?: number;
  now?: () => number;
}

interface SessionState {
  workspaceId: string;
  profileId: string;
  environment: SandboxEnvironment;
  denialsFile: string;
  decisionsDir: string;
  offset: number;
  extraReadPaths: string[];
  gatewayError?: string;
}

const PROBE_TTL_MS = 60_000;
const COPY_RUNTIME_TIMEOUT_MS = 300_000;
const GATEWAY_START_ATTEMPTS = 3;
const GATEWAY_RETRY_MS = 200;
const SHELL_NAMES = /^(?:pwsh|powershell|cmd|bash|sh|zsh|fish|wsl|nu|dash)(?:\.exe)?$/iu;
const BROKER_ENVS: Array<{ env: string; route: BrokerRouteName }> = [
  { env: "STRIDETERM_INTERNAL_MCP_URL", route: "internal-mcp" },
  { env: "STRIDETERM_REVIEW_GIT_URL", route: "review-git" },
  { env: "STRIDETERM_SSH_MCP_URL", route: "ssh-mcp" },
  { env: "STRIDETERM_NOTIFY_URL", route: "notify" },
];
/** Review bridge variables naming files the draft tools read or write; the sandbox gets exactly those. */
const REVIEW_READ_ENVS = ["STRIDETERM_REVIEW_CLI", "STRIDETERM_REVIEW_BRIEF_MD", "STRIDETERM_REVIEW_BRIEF_JSON"];
const REVIEW_WRITE_ENVS = ["STRIDETERM_REVIEW_DB", "STRIDETERM_REVIEW_STORE_DIR", "STRIDETERM_REVIEW_EXPORT_DIR"];

/** `host` matches a pattern of `host`, `*.host` or either with `:port`. */
export function matchesSandboxDomain(host: string, port: number | null, patterns: string[]): boolean {
  const lowered = host.toLowerCase();
  return patterns.some((raw) => {
    const [pattern, patternPort] = raw.split(/:(?=[0-9]+$)/u);
    if (patternPort !== undefined && port !== null && Number(patternPort) !== port) return false;
    if (patternPort !== undefined && port === null) return false;
    if (pattern.startsWith("*.")) return lowered.endsWith(pattern.slice(1)) && lowered.length > pattern.length - 1;
    return lowered === pattern;
  });
}

export class SandboxService {
  private readonly backend: SandboxBackend;
  private readonly platform: NodeJS.Platform;
  private readonly run: CommandRunner;
  private readonly sessionsDir: string;
  private readonly sessions = new Map<string, SessionState>();
  private readonly requests = new Map<string, SandboxDeniedRequest>();
  private readonly hosts = new Map<string, { at: number; description: HostDescription }>();
  private readonly probes = new Map<string, Promise<HostDescription>>();
  private readonly runtimeCopyAttempted = new Set<string>();
  private poller: ReturnType<typeof setInterval> | null = null;
  private shuttingDown = false;
  private gatewayReady: Promise<void> | null = null;
  private gatewayRelayPort = 0;
  private readonly now: () => number;

  constructor(private readonly options: SandboxServiceOptions) {
    this.platform = options.platform ?? process.platform;
    this.run = options.run ?? execRunner;
    this.now = options.now ?? (() => Date.now());
    this.sessionsDir = path.join(options.dataDir, "sandbox", "sessions");
    this.backend =
      options.backend ??
      new SrtBackend({
        sessionsDir: this.sessionsDir,
        launcherPath: path.join(options.dataDir, "sandbox", `launcher-${SANDBOX_LAUNCHER_HASH}.mjs`),
        askTimeoutMs: options.askTimeoutMs,
      });
  }

  /** The tabs that run inside the sandbox: agents of an isolated workspace, and every Worker/Judge of its tasks. */
  isEligible(workspace: SandboxWorkspaceView | null | undefined, panel: SandboxPanelView): boolean {
    return isSandboxedPanel(workspace, panel);
  }

  isSandboxed(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  /** The probed environment of a prepared session, for code that must translate paths before `wrap`. */
  environmentOf(sessionId: string): SandboxEnvironment | null {
    return this.sessions.get(sessionId)?.environment ?? null;
  }

  /** Further readable paths for a session (the MCP bridge's executable and entry). */
  addReadPaths(sessionId: string, paths: string[]): void {
    const session = this.sessions.get(sessionId);
    if (session) session.extraReadPaths.push(...paths.filter(Boolean));
  }

  private async describeHost(distro: string | undefined, force: boolean): Promise<HostDescription> {
    const key = distro ?? "";
    const cached = this.hosts.get(key);
    if (!force && cached && this.now() - cached.at < PROBE_TTL_MS && cached.description.status.ready) {
      return cached.description;
    }
    // Several tabs of one workspace start together; they share one probe.
    const running = this.probes.get(key);
    if (running) return running;
    const probing = (async () => {
      let probe = await probeSandboxHost({ platform: this.platform, distro, run: this.run });
      let description = describeSandboxHost(this.platform, probe, distro);
      if (await this.copyBundledRuntime(key, distro, probe.reachable, description)) {
        probe = await probeSandboxHost({ platform: this.platform, distro, run: this.run });
        description = describeSandboxHost(this.platform, probe, distro);
      }
      this.hosts.set(key, { at: this.now(), description });
      return description;
    })().finally(() => this.probes.delete(key));
    this.probes.set(key, probing);
    return probing;
  }

  /**
   * The sandbox runtime ships with the app, so copying it is not a decision for the user: it runs once per host and
   * process when Node.js is there and the runtime is missing or of another version (an app update heals itself).
   * Returns whether a copy ran, so the caller probes again.
   */
  private async copyBundledRuntime(
    key: string,
    distro: string | undefined,
    reachable: boolean,
    description: HostDescription,
  ): Promise<boolean> {
    const dir = this.options.bundledRuntimeDir;
    if (!dir || !reachable || this.shuttingDown || this.runtimeCopyAttempted.has(key)) return false;
    const ok = (id: string) => description.status.prerequisites.find((item) => item.id === id)?.ok ?? true;
    if (!ok("wsl") || !ok("node") || ok("srt")) return false;
    const step = bundledRuntimeCopyStep(this.platform, distro, dir);
    if (!step) return false;
    this.runtimeCopyAttempted.add(key);
    const result = await this.run(step.file, step.args, { timeoutMs: COPY_RUNTIME_TIMEOUT_MS });
    if (result.code !== 0) {
      const detail = `${result.stdout}\n${result.stderr}`.replace(/\0/gu, "").trim().slice(-300);
      log.warn("copying the bundled sandbox runtime failed", { code: result.code, detail });
    }
    return true;
  }

  async getStatus(options: { force?: boolean; distro?: string } = {}): Promise<SandboxStatus> {
    return (await this.describeHost(options.distro, options.force === true)).status;
  }

  /** Installs what is missing after the user confirmed. Returns the new status and what could not be done. */
  async installPrerequisites(
    distro?: string,
  ): Promise<{ status: SandboxStatus; log: string[]; manual: string[]; failed: boolean }> {
    const before = await this.describeHost(distro, true);
    const plan = planInstall(
      this.platform,
      before.status,
      before.packageManager,
      distro,
      this.options.bundledRuntimeDir,
    );
    const output: string[] = [];
    let failed = false;
    for (const step of plan.steps) {
      output.push(`> ${step.label}`);
      const result = await this.run(step.file, step.args, { timeoutMs: 600_000 });
      const text = `${result.stdout}\n${result.stderr}`.replace(/\0/gu, "").trim();
      if (text) output.push(text.split("\n").slice(-12).join("\n"));
      if (result.code !== 0) {
        failed = true;
        output.push(`Step failed (${result.code}).`);
        log.warn("sandbox prerequisite install step failed", { step: step.label, code: result.code });
      }
    }
    const after = await this.describeHost(distro, true);
    return { status: after.status, log: output, manual: failed || !after.status.ready ? plan.manual : [], failed };
  }

  /**
   * First half of a launch: proves the sandbox can start. Throws `SandboxUnavailableError` — the tab then
   * fails visibly instead of starting unisolated — and starts the gateway the sandbox reaches the host through.
   */
  async prepare(ctx: Omit<SandboxWrapContext, "launcher" | "env">): Promise<void> {
    this.assertRunning();
    const hostRoots = this.workspaceRoots(ctx.workspace, ctx.cwd);
    let distro: string | undefined;
    try {
      distro = this.platform === "win32" ? distroOfPaths(hostRoots) : undefined;
    } catch (error) {
      throw new SandboxUnavailableError((error as Error).message);
    }
    const agent = bareAgentExecutable(ctx.panel.command);
    const agentFound = (found: HostDescription) => found.status.agents.find((item) => item.id === agent);
    let description = await this.describeHost(distro, false);
    if (agent && description.environment && !agentFound(description)?.ok) {
      // The user may have installed it since the cached probe.
      description = await this.describeHost(distro, true);
    }
    if (!description.environment) {
      const missing = description.status.prerequisites.filter((item) => !item.ok).map((item) => item.label);
      throw new SandboxUnavailableError(
        `The sandbox cannot start: ${missing.join(", ") || "its host is not reachable"}. Open the workspace settings to install what is missing, or turn isolation off.`,
      );
    }
    if (agent && !agentFound(description)?.ok) {
      const where =
        this.platform === "win32" ? `inside WSL${distro ? ` (distribution ${distro})` : ""}` : "on this machine";
      const windowsOnly = agentFound(description)?.windowsOnly === true;
      throw new SandboxUnavailableError(
        windowsOnly
          ? `Only the Windows ${agent} CLI was found. An isolated tab runs ${where} and cannot use it: install ${agent} ${where}, then restart the tab.`
          : `The ${agent} CLI is not installed where the sandbox runs, ${where}. Install it there, then restart the tab.`,
      );
    }
    const environment = description.environment;
    let gatewayError: string | undefined;
    if (description.status.gateway === "available") {
      for (let attempt = 1; attempt <= GATEWAY_START_ATTEMPTS; attempt += 1) {
        try {
          await this.ensureGateway(environment);
          gatewayError = undefined;
          break;
        } catch (error) {
          if (this.shuttingDown) throw error;
          gatewayError = (error as Error).message;
          log.warn("sandbox gateway did not start", { err: gatewayError, attempt });
          if (attempt < GATEWAY_START_ATTEMPTS) await new Promise((resolve) => setTimeout(resolve, GATEWAY_RETRY_MS));
        }
      }
    } else {
      gatewayError = "the gateway is not reachable from the sandbox host";
    }
    this.assertRunning();
    const files = this.backend.sessionFiles(ctx.sessionId);
    this.sessions.set(ctx.sessionId, {
      workspaceId: ctx.workspace.id,
      profileId: String(ctx.workspace.profileId || "default"),
      environment,
      denialsFile: files.denialsFile,
      decisionsDir: files.decisionsDir,
      offset: 0,
      extraReadPaths: [],
      ...(gatewayError ? { gatewayError } : {}),
    });
  }

  private async ensureGateway(environment: SandboxEnvironment): Promise<void> {
    this.assertRunning();
    if (this.gatewayReady) return this.gatewayReady;
    this.gatewayReady = (async () => {
      const gateway = this.options.gateway;
      if (this.platform === "win32") {
        this.gatewayRelayPort = await gateway.listenTcp(environment.hostAddress || "127.0.0.1");
        return;
      }
      const name = `strideterm-gw-${randomUUID().slice(0, 8)}.sock`;
      await gateway.listenUnix(path.join(this.options.tmpDir ?? os.tmpdir(), name));
    })();
    this.gatewayReady.catch(() => {
      this.gatewayReady = null;
    });
    return this.gatewayReady;
  }

  private assertRunning(): void {
    if (this.shuttingDown) throw new SandboxUnavailableError("The sandbox service is shutting down.");
  }

  private workspaceRoots(workspace: SandboxWorkspaceView, cwd: string): string[] {
    const candidates = [workspace.cwd, ...(workspace.gitRoots ?? []), workspace.review?.checkout?.rootPath].filter(
      (value): value is string => typeof value === "string" && value.trim().length > 0,
    );
    const roots = [...new Set(candidates)];
    if (!roots.length && cwd) roots.push(cwd);
    return roots;
  }

  private mapToSandbox(environment: SandboxEnvironment, hostPath: string): string {
    if (environment.platform !== "win32") return hostPath;
    const mapped = windowsPathToWsl(hostPath);
    if (!mapped) throw new SandboxUnavailableError(`The folder ${hostPath} cannot be reached from WSL.`);
    return mapped.path;
  }

  private assertWorkspacePaths(environment: SandboxEnvironment, hostPaths: string[], sandboxPaths: string[]): void {
    const privatePaths = [this.options.dataDir, this.options.windowsHome ?? os.homedir()];
    if (environment.platform !== "win32") privatePaths.push(environment.home);
    const protectedPaths = privatePaths.map(canonicalPath);
    const includesHostPaths = hostPaths
      .map(canonicalPath)
      .some((root) => protectedPaths.some((privatePath) => pathContains(path, root, privatePath)));
    const includesWslHome =
      environment.platform === "win32" && sandboxPaths.some((root) => pathContains(path.posix, root, environment.home));
    if (includesHostPaths || includesWslHome) {
      throw new SandboxUnavailableError(
        "Choose a workspace folder that excludes your home and strIDEterm data directories.",
      );
    }
  }

  /** The command that runs inside the sandbox in place of what the session manager would have spawned. */
  private innerCommand(environment: SandboxEnvironment, launcher: SandboxWrapContext["launcher"]): string[] {
    if (environment.platform !== "win32") return [launcher.file, ...launcher.args];
    const base = launcher.file.split(/[\\/]/u).pop() || "";
    if (SHELL_NAMES.test(base)) return ["bash", "-l"];
    return [base.replace(/\.(?:exe|cmd|bat|com)$/iu, ""), ...launcher.args];
  }

  /**
   * Gemini's per-launch MCP settings are a host file; the sandbox cannot read the host's data folder, so the same
   * document (variable NAMES only) is copied into the launch's own tool folder, which it reads and cannot write.
   */
  private addGeminiSettings(
    ctx: SandboxWrapContext,
    toolDir: string,
    toolFiles: SandboxSpec["toolFiles"],
    env: Record<string, string>,
  ): void {
    const hostPath = ctx.env[GEMINI_SETTINGS_PATH_ENV];
    delete env[GEMINI_SETTINGS_PATH_ENV];
    if (!hostPath) return;
    let content: string;
    try {
      content = readFileSync(hostPath, "utf8");
    } catch (error) {
      throw new SandboxUnavailableError(
        `The Gemini MCP settings for this tab cannot be read: ${(error as Error).message}`,
      );
    }
    const target = path.posix.join(toolDir, "gemini-settings.json");
    toolFiles.push({ path: target, content, root: toolDir });
    env[GEMINI_SETTINGS_PATH_ENV] = target;
  }

  /**
   * Second half of a launch: the PTY command that runs the tab inside the sandbox. Synchronous: everything
   * asynchronous (probe, gateway start) happened in `prepare`.
   */
  wrap(ctx: SandboxWrapContext): SandboxLaunch {
    const session = this.sessions.get(ctx.sessionId);
    if (!session) throw new SandboxUnavailableError("The sandbox was not prepared for this tab.");
    const environment = session.environment;
    const hostRoots = this.workspaceRoots(ctx.workspace, ctx.cwd).filter(statIsDirectory);
    if (!hostRoots.length) throw new SandboxUnavailableError("The workspace folder does not exist.");

    const distro = environment.distro;
    const hostGit = hostRoots.map((root) => resolveExternalGitDirs(root, { wslDistro: distro }));
    const hostGitDirs = hostGit.flatMap((entry) => entry.dirs);
    const toolchains = detectToolchains(hostRoots);
    const agent = getAgentSandboxProfile(detectSandboxAgent(ctx.panel.command) ?? "");
    const roots = hostRoots.map((root) => this.mapToSandbox(environment, root));
    const gitDirs = hostGitDirs.map((dir) => this.mapToSandbox(environment, dir));
    this.assertWorkspacePaths(environment, [...hostRoots, ...hostGitDirs], [...roots, ...gitDirs]);
    const gitPointerFiles = hostGit
      .flatMap((entry) => entry.pointerFiles)
      .map((file) => this.mapToSandbox(environment, file));

    const effectiveCwd = this.pickCwd(environment, hostRoots, ctx.cwd);
    const cacheRoot =
      environment.platform === "win32"
        ? "/var/tmp/strideterm-sandbox-cache"
        : path.join(this.options.dataDir, "sandbox", "cache");
    const toolDir = this.backend.toolDir(ctx.sessionId, environment);

    let env = sanitizeSandboxEnv({ env: ctx.env, platform: this.platform, agent, toolchains, hostEnv: process.env });
    const gatewayInfo = this.registerGatewayFor(ctx, session, env);
    env = gatewayInfo.env;
    if (!gatewayInfo.active) this.refuseWithoutGateway(session, env);

    const toolFiles: SandboxSpec["toolFiles"] = [];
    const extraEnsureDirs: string[] = [];
    this.addGeminiSettings(ctx, toolDir, toolFiles, env);
    for (const profile of toolchains) Object.assign(env, toolchainEnv(cacheRoot, profile));
    // Gradle runs init scripts from its user home, so that home is one workspace's own and sits OUTSIDE the shared
    // cache: a folder every workspace can write must never carry executable configuration another build would load.
    // Only the downloaded artifacts (`modules-2`) are shared, through a link the launcher makes.
    const gradle = toolchains.find((profile) => profile.id === "gradle");
    const confinedLinks: NonNullable<SandboxSpec["confinedLinks"]> = [];
    const workspaceHomes: string[] = [];
    // Tools need an existing writable temp folder: the host's macOS temp tree is outside the grant,
    // and srt's default /tmp/claude may not exist. Give them a workspace-owned folder.
    // Same notation as the home beside it: POSIX inside WSL, the host's own otherwise.
    const pathApi = environment.platform === "win32" ? path.posix : path;
    const tempHome = pathApi.join(pathApi.dirname(this.sandboxHome(environment, ctx.workspace.id)), "tmp");
    workspaceHomes.push(tempHome);
    env.TMPDIR = `${tempHome}/`;
    env.TMP = tempHome;
    env.TEMP = tempHome;
    // srt generates its own TMPDIR assignment from this supported override.
    env.CLAUDE_CODE_TMPDIR = tempHome;
    const gradleHome = this.gradleHome(environment, ctx.workspace.id);
    if (gradle || this.gradleRegistryConfigured(ctx, gatewayInfo.active)) {
      env.GRADLE_USER_HOME = gradleHome;
      workspaceHomes.push(gradleHome);
      const artifacts = path.posix.join(
        gradle ? toolchainCacheFolder(cacheRoot, gradle) : path.posix.join(cacheRoot, "gradle"),
        "modules-2",
      );
      extraEnsureDirs.push(artifacts);
      confinedLinks.push({
        link: path.posix.join(gradleHome, "caches", "modules-2"),
        target: artifacts,
        root: gradleHome,
      });
    }
    this.addRegistryConfig({
      ctx,
      toolchains,
      cacheRoot,
      toolDir,
      toolFiles,
      env,
      hasGateway: gatewayInfo.active,
      gradleHome,
    });

    const pathPrepend: string[] = [];
    if (environment.platform === "win32") {
      const binDir = path.posix.join(toolDir, "bin");
      toolFiles.push({
        path: path.posix.join(binDir, "node"),
        content: WSL_NODE_SHIM,
        root: toolDir,
        executable: true,
      });
      pathPrepend.push(binDir);
    }
    const pathAppend = (agent?.binHome ?? []).map((relative) => path.posix.join(environment.home, relative));

    const { read, write } = this.reviewPaths(ctx.env, environment);
    // The hook script the agent's own config names (notify.mjs) lives in the hook folders; the sandbox reads it, nothing else there.
    const hookDirs = [path.join(this.options.dataDir, "hooks"), path.join(os.homedir(), ".strideterm-hooks")].filter(
      (dir) => existsSync(dir),
    );
    const ownNotifyScript = path.join(this.options.dataDir, "hooks", "notify.mjs");
    const notifyScript = existsSync(ownNotifyScript) ? this.mapToSandbox(environment, ownNotifyScript) : undefined;
    const readPaths = [
      ...read,
      ...hookDirs,
      ...session.extraReadPaths,
      path.posix.dirname(path.posix.dirname(environment.srtModule)),
    ];
    const loginLinks = this.windowsLoginLinks(environment, agent);
    let homeOverride: string | undefined;
    const seededFiles: NonNullable<SandboxSpec["seededFiles"]> = [];
    const stateFiles = agent?.stateFiles ?? [];
    const configFiles = agent?.configFiles ?? [];
    const mirroredFolders = mirroredAgentFolders(agent);
    const confinedMirrors: NonNullable<SandboxSpec["confinedMirrors"]> = [];
    if (loginLinks.length || stateFiles.length || configFiles.length) {
      // The sandbox runtime cannot bind a link, so the agent's home is a folder of links: each entry points at the
      // distro's own folder when there is one, else at the Windows user's (the one sign-in). A state file that also
      // carries configuration the host CLI obeys (`.claude.json`) is not linked but copied: the sandbox keeps its own.
      homeOverride = this.sandboxHome(environment, ctx.workspace.id);
      workspaceHomes.push(homeOverride);
      for (const relative of homeMirrorEntries(agent, toolchains)) {
        const own = path.posix.join(environment.home, relative);
        const windows = loginLinks.find((item) => item.link === own)?.target;
        if (mirroredFolders.includes(relative)) {
          // Holds a config file with other tools' credentials: mirrored entry by entry, never linked whole.
          confinedMirrors.push({
            dir: path.posix.join(homeOverride, relative),
            sources: windows ? [own, windows] : [own],
            exclude: mirrorExclusions(agent, relative),
            root: homeOverride,
            ...(agent?.localSqlite ? { localSqlite: true } : {}),
          });
          continue;
        }
        confinedLinks.push({
          link: path.posix.join(homeOverride, relative),
          targets: windows ? [own, windows] : [own],
          root: homeOverride,
        });
      }
      for (const relative of stateFiles) {
        const windows = this.windowsStateFile(environment, relative);
        seededFiles.push({
          sources: [path.posix.join(environment.home, relative), ...(windows ? [windows] : [])],
          dest: path.posix.join(homeOverride, relative),
          root: homeOverride,
          filter: "claude-state",
        });
      }
      for (const file of configFiles) {
        if (file.format === "omit") continue;
        const windows = this.windowsStateFile(environment, file.path);
        seededFiles.push({
          sources: [path.posix.join(environment.home, file.path), ...(windows ? [windows] : [])],
          dest: path.posix.join(homeOverride, file.path),
          root: homeOverride,
          filter: file.format,
          refresh: true,
          keepEnv: agent?.loginEnv ?? [],
        });
      }
    }
    const spec: SandboxSpec = {
      os: environment.os,
      home: environment.home,
      roots,
      gitDirs,
      gitPointerFiles,
      loginLinks,
      homeOverride,
      notifyScript,
      readPaths: readPaths
        .map((p) => (environment.platform === "win32" ? this.tryMap(environment, p) : p))
        .filter(Boolean),
      readWritePaths: write,
      workspaceHomes,
      ensureDirs: extraEnsureDirs,
      confinedLinks,
      confinedMirrors,
      seededFiles,
      pathPrepend,
      pathAppend,
      agent,
      toolchains,
      cacheRoot,
      workspaceDomains: this.options.getWorkspaceDomains(ctx.workspace.id),
      sessionId: ctx.sessionId,
      workspaceId: ctx.workspace.id,
      profileId: session.profileId,
      command: this.innerCommand(environment, ctx.launcher),
      cwd: effectiveCwd,
      env,
      toolFiles,
      gateway: gatewayInfo.gateway,
    };
    const launch = this.backend.buildLaunch(spec, environment);
    this.startWatching();
    return launch;
  }

  /**
   * On Windows the agent CLI the user is signed in to lives in the Windows profile, while the sandbox's home is the
   * distro's. Each folder or file of the agent profile that exists on the Windows side is the fallback for the distro's
   * own in the sandbox's home (a folder of links, see `wrap`), so there is one sign-in.
   */
  private windowsLoginLinks(
    environment: SandboxEnvironment,
    agent: ReturnType<typeof getAgentSandboxProfile>,
  ): Array<{ link: string; target: string }> {
    if (environment.platform !== "win32" || !agent) return [];
    const userHome = this.options.windowsHome ?? os.homedir();
    const links: Array<{ link: string; target: string }> = [];
    for (const relative of agent.writeHome) {
      const windowsPath = path.win32.join(userHome, ...relative.split("/"));
      if (!existsSync(windowsPath)) continue;
      const target = windowsPathToWsl(windowsPath)?.path;
      if (target) links.push({ link: path.posix.join(environment.home, relative), target });
    }
    return links;
  }

  /** The Windows user's copy of an agent state file, as WSL sees it; undefined when there is none. */
  private windowsStateFile(environment: SandboxEnvironment, relative: string): string | undefined {
    if (environment.platform !== "win32") return undefined;
    const userHome = this.options.windowsHome ?? os.homedir();
    const windowsPath = path.win32.join(userHome, ...relative.split("/"));
    return existsSync(windowsPath) ? windowsPathToWsl(windowsPath)?.path : undefined;
  }

  /** This workspace's own Gradle user home, in the sandbox's notation, outside the shared dependency cache. */
  private gradleHome(environment: SandboxEnvironment, workspaceId: string): string {
    const name = workspaceId.replace(/[^A-Za-z0-9._-]/gu, "_");
    if (environment.platform === "win32") return path.posix.join("/var/tmp/strideterm-sandbox-homes", name, "gradle");
    return path.join(this.options.dataDir, "sandbox", "workspace-homes", name, "gradle");
  }

  /** The folder of links the agent uses as its home when the Windows sign-in is shared or it has a state file of its own, in the sandbox's notation. */
  private sandboxHome(environment: SandboxEnvironment, workspaceId: string): string {
    const name = workspaceId.replace(/[^A-Za-z0-9._-]/gu, "_");
    if (environment.platform !== "win32")
      return path.join(this.options.dataDir, "sandbox", "workspace-homes", name, "home");
    return path.posix.join("/var/tmp/strideterm-sandbox-homes", name, "home");
  }

  private gradleRegistryConfigured(ctx: SandboxWrapContext, hasGateway: boolean): boolean {
    if (!hasGateway) return false;
    const profileId = String(ctx.workspace.profileId || "default");
    return this.options.getRegistries(profileId).some((connection) => connection.kind === "gradle");
  }

  private tryMap(environment: SandboxEnvironment, hostPath: string): string {
    if (hostPath.startsWith("/")) return hostPath;
    return windowsPathToWsl(hostPath)?.path ?? "";
  }

  private pickCwd(environment: SandboxEnvironment, hostRoots: string[], requested: string): string {
    const chosen =
      statIsDirectory(requested) &&
      hostRoots.some((root) => workspacePathContains(environment.platform, root, requested))
        ? requested
        : hostRoots[0];
    return this.mapToSandbox(environment, chosen);
  }

  private reviewPaths(env: Record<string, string>, environment: SandboxEnvironment) {
    const toSandbox = (value: string | undefined, isFile: boolean): string => {
      if (!value) return "";
      const folder = isFile ? path.dirname(value) : value;
      return environment.platform === "win32" ? this.tryMap(environment, folder) : folder;
    };
    const read = REVIEW_READ_ENVS.map((name) => toSandbox(env[name], true)).filter(Boolean);
    const write = REVIEW_WRITE_ENVS.map((name) =>
      toSandbox(env[name], name === "STRIDETERM_REVIEW_DB" || !statIsDirectory(env[name])),
    ).filter(Boolean);
    return { read, write };
  }

  /** Registers the session's brokers with the gateway and rewrites their URLs in the sandbox's environment. */
  private registerGatewayFor(
    ctx: SandboxWrapContext,
    session: SessionState,
    env: Record<string, string>,
  ): { env: Record<string, string>; active: boolean; gateway: SandboxSpec["gateway"] } {
    const gateway = this.options.gateway;
    const relayed = this.platform === "win32";
    const socketPath = relayed ? "" : gateway.socketPath;
    if (relayed ? !this.gatewayRelayPort : !socketPath) {
      return { env, active: false, gateway: undefined };
    }
    const brokers: Partial<Record<BrokerRouteName, string>> = {};
    const mapping: Array<{ from: string; route: BrokerRouteName; query: string }> = [];
    for (const { env: name, route } of BROKER_ENVS) {
      const value = env[name];
      if (!value) continue;
      let parsed: URL;
      try {
        parsed = new URL(value);
      } catch {
        continue;
      }
      if (parsed.hostname !== "127.0.0.1") continue;
      brokers[route] = `${parsed.origin}${parsed.pathname}`;
      mapping.push({ from: value, route, query: parsed.search });
    }
    gateway.registerSession({
      sessionId: ctx.sessionId,
      profileId: session.profileId,
      workspaceId: ctx.workspace.id,
      brokers,
    });
    const rewritten: Record<string, string> = { ...env };
    for (const [name, value] of Object.entries(rewritten)) {
      let next = value;
      for (const entry of mapping) {
        const target = `http://${SANDBOX_GATEWAY_HOST}${gateway.brokerPath(ctx.sessionId, entry.route)}${entry.query}`;
        next = next.split(entry.from).join(target);
      }
      rewritten[name] = next;
    }
    const target: SandboxSpec["gateway"] = relayed
      ? { relay: { tcpHost: session.environment.hostAddress || "127.0.0.1", tcpPort: this.gatewayRelayPort } }
      : { socketPath };
    return { env: rewritten, active: true, gateway: target };
  }

  /** A launch that configured brokers or private registries must not start without the gateway that carries them. */
  private refuseWithoutGateway(session: SessionState, env: Record<string, string>): void {
    const needsBroker = BROKER_ENVS.some(({ env: name }) => {
      try {
        return env[name] ? new URL(env[name]).hostname === "127.0.0.1" : false;
      } catch {
        return false;
      }
    });
    const needsRegistry = this.options.getRegistries(session.profileId).length > 0;
    if (!needsBroker && !needsRegistry) return;
    const needs = [needsBroker ? "agent tools and notifications" : "", needsRegistry ? "private registries" : ""]
      .filter(Boolean)
      .join(" and ");
    throw new SandboxUnavailableError(
      `The sandbox gateway is not running${session.gatewayError ? ` (${session.gatewayError})` : ""}, so ${needs} would be unreachable. Restart the tab to retry, or turn isolation off.`,
    );
  }

  private addRegistryConfig(input: {
    ctx: SandboxWrapContext;
    toolchains: ReturnType<typeof detectToolchains>;
    cacheRoot: string;
    toolDir: string;
    toolFiles: SandboxSpec["toolFiles"];
    env: Record<string, string>;
    hasGateway: boolean;
    gradleHome: string;
  }): void {
    const { ctx, toolchains, cacheRoot, toolDir, toolFiles, env, hasGateway, gradleHome } = input;
    const profileId = String(ctx.workspace.profileId || "default");
    const endpoints: GatewayRegistryEndpoint[] = hasGateway
      ? this.options.getRegistries(profileId).map((connection) => ({
          connection,
          url: `http://${SANDBOX_GATEWAY_HOST}${this.options.gateway.registryPath(ctx.sessionId, connection.id)}`,
        }))
      : [];
    const ids = new Set(toolchains.map((profile) => profile.id));
    const has = (kind: string) => endpoints.some((endpoint) => endpoint.connection.kind === kind);
    if (ids.has("maven") || has("maven")) {
      const settingsPath = path.posix.join(toolDir, "settings.xml");
      toolFiles.push({ path: settingsPath, content: buildMavenSettings(endpoints), root: toolDir });
      const maven = toolchains.find((profile) => profile.id === "maven");
      const repository = path.posix.join(
        maven ? toolchainCacheFolder(cacheRoot, maven) : path.posix.join(cacheRoot, "maven"),
        "repository",
      );
      env.MAVEN_ARGS = [env.MAVEN_ARGS, mavenArgs(settingsPath, repository)].filter(Boolean).join(" ");
    }
    if (has("npm")) {
      const file = path.posix.join(toolDir, ".npmrc");
      toolFiles.push({ path: file, content: buildNpmrc(endpoints), root: toolDir });
      env.NPM_CONFIG_USERCONFIG = file;
    }
    if (has("pip")) {
      const file = path.posix.join(toolDir, "pip.conf");
      toolFiles.push({ path: file, content: buildPipConf(endpoints), root: toolDir });
      env.PIP_CONFIG_FILE = file;
    }
    if (has("gradle")) {
      env.GRADLE_USER_HOME = gradleHome;
      toolFiles.push({
        path: path.posix.join(
          gradleHome,
          "init.d",
          `strideterm-${ctx.sessionId.replace(/[^A-Za-z0-9._-]/gu, "_")}.gradle`,
        ),
        content: buildGradleInit(endpoints),
        removeOnExit: true,
        root: gradleHome,
      });
    }
  }

  private startWatching(): void {
    if (this.poller) return;
    this.poller = setInterval(() => this.pollDenials(), this.options.pollMs ?? 750);
    this.poller.unref?.();
  }

  /** Reads the denial lines the launchers appended since the last look. */
  pollDenials(): void {
    for (const [sessionId, session] of this.sessions) {
      let size: number;
      try {
        size = statSync(session.denialsFile).size;
      } catch {
        continue;
      }
      if (size <= session.offset) continue;
      let content: Buffer;
      try {
        content = readFileSync(session.denialsFile);
      } catch {
        continue;
      }
      const fresh = content.subarray(session.offset);
      const lastNewline = fresh.lastIndexOf(0x0a);
      if (lastNewline < 0) continue;
      session.offset += lastNewline + 1;
      for (const line of fresh
        .subarray(0, lastNewline + 1)
        .toString("utf8")
        .split("\n")) {
        if (!line.trim()) continue;
        this.handleDenialLine(sessionId, session, line);
      }
    }
    this.expireRequests();
  }

  private handleDenialLine(sessionId: string, session: SessionState, line: string): void {
    let parsed: { id?: unknown; host?: unknown; port?: unknown; at?: unknown };
    try {
      parsed = JSON.parse(line);
    } catch {
      return;
    }
    if (typeof parsed.id !== "string" || typeof parsed.host !== "string" || !/^[A-Za-z0-9._-]+$/u.test(parsed.id))
      return;
    const port = typeof parsed.port === "number" ? parsed.port : null;
    const request: SandboxDeniedRequest = {
      id: parsed.id,
      workspaceId: session.workspaceId,
      sessionId,
      host: parsed.host.toLowerCase(),
      port,
      at: typeof parsed.at === "number" ? parsed.at : this.now(),
      state: "pending",
    };
    if (matchesSandboxDomain(request.host, port, this.options.getWorkspaceDomains(session.workspaceId))) {
      request.state = "allowed";
      this.writeDecision(session, request.id, true);
      log.info("sandbox destination already allowed for the workspace", {
        workspaceId: session.workspaceId,
        host: request.host,
      });
      return;
    }
    this.requests.set(request.id, request);
    this.options.onDenied(this.publicRequest(request));
  }

  private publicRequest(request: SandboxDeniedRequest): SandboxDeniedRequest {
    return { ...request };
  }

  private expireRequests(): void {
    const limit = (this.options.askTimeoutMs ?? 90_000) + 5_000;
    for (const request of this.requests.values()) {
      if (request.state === "pending" && this.now() - request.at > limit) {
        request.state = "expired";
        this.options.onDeniedSettled(this.publicRequest(request));
      }
    }
  }

  private writeDecision(session: SessionState, requestId: string, allow: boolean): void {
    mkdirSync(session.decisionsDir, { recursive: true, mode: 0o700 });
    const file = path.join(session.decisionsDir, `${requestId}.json`);
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify({ allow }), { mode: 0o600 });
    renameSync(tmp, file);
  }

  listPending(workspaceId?: string): SandboxDeniedRequest[] {
    return [...this.requests.values()]
      .filter((request) => request.state === "pending" && (!workspaceId || request.workspaceId === workspaceId))
      .map((request) => this.publicRequest(request));
  }

  /** Pending requests plus recent unanswered automation requests that may still be allowed for future runs. */
  listAutomationRequests(workspaceIds: Set<string>): SandboxDeniedRequest[] {
    const cutoff = this.now() - 24 * 60 * 60_000;
    return [...this.requests.values()]
      .filter(
        (request) =>
          workspaceIds.has(request.workspaceId) &&
          request.at >= cutoff &&
          (request.state === "pending" || request.state === "expired" || request.state === "denied") &&
          !matchesSandboxDomain(request.host, request.port, this.options.getWorkspaceDomains(request.workspaceId)),
      )
      .map((request) => this.publicRequest(request));
  }

  getRequest(requestId: string): SandboxDeniedRequest | null {
    const request = this.requests.get(requestId);
    return request ? this.publicRequest(request) : null;
  }

  /** Answers the sandbox that is waiting on this destination. Returns false for an unknown or settled request. */
  decide(requestId: string, allow: boolean): boolean {
    const request = this.requests.get(requestId);
    if (!request || request.state !== "pending") return false;
    const session = this.sessions.get(request.sessionId);
    if (!session) return false;
    this.writeDecision(session, requestId, allow);
    request.state = allow ? "allowed" : "denied";
    this.options.onDeniedSettled(this.publicRequest(request));
    return true;
  }

  /** The tab's process is gone: revoke its gateway capability and drop its files. */
  release(sessionId: string): void {
    this.options.gateway.revokeSession(sessionId);
    const session = this.sessions.get(sessionId);
    this.sessions.delete(sessionId);
    for (const request of this.requests.values()) {
      if (request.sessionId === sessionId && request.state === "pending") {
        request.state = "expired";
        this.options.onDeniedSettled(this.publicRequest(request));
      }
    }
    if (session) {
      try {
        rmSync(sessionLaunchDir(this.sessionsDir, sessionId), { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    }
    if (!this.sessions.size && this.poller) {
      clearInterval(this.poller);
      this.poller = null;
    }
  }

  /** Writes the launcher script when it is missing or stale. */
  writeLauncher(): string {
    const file = path.join(this.options.dataDir, "sandbox", `launcher-${SANDBOX_LAUNCHER_HASH}.mjs`);
    if (!existsSync(file)) {
      mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      const tmp = `${file}.tmp`;
      writeFileSync(tmp, SANDBOX_LAUNCHER_SOURCE, { mode: 0o600 });
      renameSync(tmp, file);
    }
    return file;
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    if (this.poller) clearInterval(this.poller);
    this.poller = null;
    for (const sessionId of this.sessions.keys()) this.release(sessionId);
    await this.gatewayReady?.catch(() => undefined);
    await this.options.gateway.close();
  }
}

function canonicalPath(target: string): string {
  try {
    return realpathSync(target);
  } catch {
    return path.resolve(target);
  }
}

function pathContains(pathApi: typeof path, root: string, target: string): boolean {
  const relative = pathApi.relative(root, target);
  return relative !== ".." && !relative.startsWith(`..${pathApi.sep}`) && !pathApi.isAbsolute(relative);
}

/** WSL UNC aliases share a namespace within the same distribution. */
export function workspacePathContains(platform: NodeJS.Platform, root: string, target: string): boolean {
  if (platform !== "win32") return pathContains(path, root, target);
  const rootInWsl = windowsPathToWsl(root);
  const targetInWsl = windowsPathToWsl(target);
  if (rootInWsl?.distro && targetInWsl?.distro) {
    return (
      rootInWsl.distro.toLowerCase() === targetInWsl.distro.toLowerCase() &&
      pathContains(path.posix, rootInWsl.path, targetInWsl.path)
    );
  }
  return pathContains(path.win32, root, target);
}

function statIsDirectory(target: string | undefined): boolean {
  if (!target) return false;
  try {
    return statSync(target).isDirectory();
  } catch {
    return false;
  }
}
