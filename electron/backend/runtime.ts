/// <reference types="node" />
import http from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { watch, readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import type { FSWatcher } from "node:fs";
import { readFile, writeFile, mkdir, readdir, access, rm } from "node:fs/promises";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { createStore } from "./store.js";
import { SessionManager } from "./session-manager.js";
import { createAccessToken, createSessionId, normalizeWorkspace, parseSessionId } from "./default-state.js";
import { execFileText } from "./process-utils.js";
import { DockerManager } from "./docker-manager.js";
import { GitManager } from "./git-manager.js";
import { CloudflareTunnelManager } from "./tunnel-manager.js";
import { createPluginManager } from "./plugin-loader.js";
import { createCredentialStore } from "./credential-store.js";
import { createAzureReviewStore } from "./azure-review-store.js";
import { createReviewBridgeStore } from "./review-bridge-store.js";
import { createAzureAuditLogStore } from "./azure-audit-log-store.js";
import { createGitAuditLogStore } from "./git-audit-log-store.js";
import { buildReviewAgentLaunch, buildMcpServerSpec } from "./review-bridge-agent-launch.js";
import { AzureDevOpsManager } from "./azure-devops-manager.js";
import { GitHubManager } from "./github-manager.js";
import { createGitHubAuditLogStore } from "./github-audit-log-store.js";
import { startNotifyServer, generateNotifySecret, buildNotifyUrl } from "./notify-server.js";
import {
  ensureNotifyScript,
  configureClaudeHook,
  removeClaudeHook,
  detectClaudeHookStatus,
} from "./claude-hook-config.js";
import { configureGeminiHook, removeGeminiHook, detectGeminiHookStatus } from "./gemini-hook-config.js";
import { configureCodexHook, removeCodexHook, detectCodexHookStatus } from "./codex-hook-config.js";
import { configureCopilotHook, removeCopilotHook, detectCopilotHookStatus } from "./copilot-hook-config.js";
import { configureOpencodeHook, removeOpencodeHook, detectOpencodeHookStatus } from "./opencode-hook-config.js";
import { AgentTaskRunner } from "./agent-task-runner.js";
import { getProvider, getAllProviders } from "./providers/provider-registry.js";
import { classifyHookEvent } from "./notifications/classifier.js";
import {
  classifyCommand,
  allowT3ForCommandClass,
  allowExitAlertForCommandClass,
} from "./notifications/command-classifier.js";
import { hasRecentAnimation } from "./notifications/detector-signals.js";
import {
  recordInteraction as adaptiveRecordInteraction,
  recordDismissed as adaptiveRecordDismissed,
  forget as adaptiveForget,
  adaptiveMultiplier,
  isT3Disabled,
} from "./notifications/adaptive.js";
import {
  recordAlert as metricsRecordAlert,
  recordHook as metricsRecordHook,
  recordDismissedWithoutInteraction as metricsRecordDismissed,
  getMetrics,
} from "./notifications/metrics.js";
import { createProviderHandlers } from "./runtime-provider-handlers.js";
import { createGitHandlers } from "./runtime-git-handlers.js";
import { createProviderLifecycle } from "./runtime-provider-lifecycle.js";
import { createSshHandlers } from "./ssh/runtime-ssh-handlers.js";
import { SshManager } from "./ssh/ssh-manager.js";
import {
  clone,
  findWorkspace,
  createAttentionContext,
  stripAnsi,
  lastNonEmptyLine,
  matchesPrompt,
  matchesAgentIdle,
  matchesWaitingPattern,
  createSessionSignal,
  detectTerminalEnvironment as detectTerminalEnvironmentImpl,
  OSC133_COMMAND_FINISHED_RE,
  OSC133_COMMAND_START_RE,
  AGENT_NAME_RE,
  AGENT_OUTPUT_RE,
  AGENT_OUTPUT_BURST_THRESHOLD,
  detectRateLimit,
  HOOK_FALLBACK_SILENCE_MS,
  ATTENTION_MIN_DISPLAY_MS,
  ATTENTION_VISIBILITY_GRACE_MS,
} from "./runtime-utils.js";
import { APP_CONFIG } from "../../config/app-config.js";
// @ts-ignore — version-checker.js will be migrated in a later phase
import { createVersionChecker } from "./version-checker.js";
import { initLogger, getLogger, setLogLevel, reconfigureLogger } from "./logger.js";
import type { Logger } from "./logger.js";
import { createRuntimeAttentionManager } from "./runtime-attention.js";
import type { AppState, WorkspaceState } from "../shared/types/state.js";
import type { NotifyServerHandle } from "./notify-server.js";

const log = getLogger("runtime");

const require = createRequire(import.meta.url);
// Walk up from this file to the nearest package.json. The relative depth differs
// between the TS source (electron/backend/) and the compiled output
// (dist-electron/electron/backend/), so a fixed "../../package.json" only works
// in one of those layouts.
function resolvePackageJsonPath(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  while (true) {
    const candidate = path.join(dir, "package.json");
    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error("Could not locate package.json from runtime.ts");
    dir = parent;
  }
}
const { version: packageVersion = "0.0.0" } = require(resolvePackageJsonPath());
const reviewBridgeCliPath = fileURLToPath(new URL("./review-bridge-cli.js", import.meta.url));

// Utilities imported from runtime-utils.js

/**
 * Returns true if the PTY write data represents a real keypress or pasted text
 * from the user. Returns false if the data is purely passive terminal bookkeeping
 * — mouse tracking, focus in/out, and bracketed-paste markers — which are emitted
 * by xterm.js on clicks and window focus changes without the user actually typing.
 *
 * Used to decide whether a terminal write should pause a running task workspace.
 * Without this filter, clicking into a task panel to watch it would pause the task.
 */
export function hasMeaningfulUserInput(data: string | Buffer | null | undefined): boolean {
  if (!data) return false;
  const str = typeof data === "string" ? data : data.toString("binary");
  // Strip all known passive escape sequences; if anything remains, it's real input.
  const stripped = str
    // SGR mouse: \x1b[<btn;x;yM or m
    .replace(/\x1b\[<\d+;\d+;\d+[Mm]/g, "")
    // X10/normal mouse: \x1b[M followed by 3 bytes (btn, x, y) — any bytes incl newline
    .replace(/\x1b\[M[\s\S]{3}/g, "")
    // xterm highlight mouse: \x1b[T followed by 6 bytes
    .replace(/\x1b\[T[\s\S]{6}/g, "")
    // Focus in / focus out
    .replace(/\x1b\[[IO]/g, "");
  return stripped.length > 0;
}

function createTunnelOriginUrl(remoteConfig: { host?: string; port?: number } = {}): string {
  const rawHost = String(remoteConfig.host || "").trim();
  const host =
    !rawHost || rawHost === "0.0.0.0" ? "127.0.0.1" : rawHost === "::" || rawHost === "[::]" ? "::1" : rawHost;
  const formattedHost = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  return `http://${formattedHost}:${remoteConfig.port}`;
}

// Re-export for consumers that import from runtime.js
export { detectTerminalEnvironmentImpl as detectTerminalEnvironment };

function probeRemoteOrigin(originUrl: string, timeoutMs = 1200): Promise<number> {
  const target = new URL(originUrl);
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        hostname: target.hostname,
        port: target.port,
        path: "/",
        method: "GET",
        timeout: timeoutMs,
      },
      (response) => {
        response.resume();
        response.once("end", () => resolve(response.statusCode || 0));
      },
    );

    request.once("timeout", () => {
      request.destroy(new Error("timed out"));
    });
    request.once("error", reject);
    request.end();
  });
}

async function checkRemoteOrigin(
  originUrl: string,
  { attempts = 16, delayMs = 250, timeoutMs = 1200 } = {},
): Promise<string> {
  let lastError = null;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      await probeRemoteOrigin(originUrl, timeoutMs);
      return originUrl;
    } catch (error) {
      lastError = error;
      if (attempt < attempts - 1) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }

  throw new Error(
    `Remote access origin ${originUrl} is not responding${(lastError as Error)?.message ? ` (${(lastError as Error).message})` : ""}.`,
  );
}

interface RuntimeDependencies {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  createStore?: (...args: any[]) => any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  createCredentialStore?: (...args: any[]) => any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  createAzureReviewStore?: (...args: any[]) => any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  createReviewBridgeStore?: (...args: any[]) => any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  SessionManager?: new (...args: any[]) => any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  DockerManager?: new (...args: any[]) => any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  GitManager?: new (...args: any[]) => any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  CloudflareTunnelManager?: new (...args: any[]) => any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  AzureDevOpsManager?: new (...args: any[]) => any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  GitHubManager?: new (...args: any[]) => any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  createPluginManager?: (...args: any[]) => any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  execFileText?: (...args: any[]) => any;
  checkRemoteOrigin?: typeof checkRemoteOrigin;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getTerminalEnvironment?: (...args: any[]) => any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  safeStorage?: any;

  fetchImpl?: typeof fetch;
}

export async function createRuntime({
  userDataPath,
  builtinPluginsDir,
  getThemeSource,
  deferInitialRefresh = false,
  dependencies = {},
}: {
  userDataPath: string;
  builtinPluginsDir?: string;
  getThemeSource?: () => string;
  deferInitialRefresh?: boolean;
  dependencies?: RuntimeDependencies;
}) {
  // Logger must init before anything else logs
  initLogger();
  log.info("createRuntime starting", { userDataPath, deferInitialRefresh });

  const createStoreImpl = dependencies.createStore || createStore;
  const createCredentialStoreImpl = dependencies.createCredentialStore || createCredentialStore;
  const createAzureReviewStoreImpl = dependencies.createAzureReviewStore || createAzureReviewStore;
  const createReviewBridgeStoreImpl = dependencies.createReviewBridgeStore || createReviewBridgeStore;
  const SessionManagerImpl = dependencies.SessionManager || SessionManager;
  const DockerManagerImpl = dependencies.DockerManager || DockerManager;
  const GitManagerImpl = dependencies.GitManager || GitManager;
  const TunnelManagerImpl = dependencies.CloudflareTunnelManager || CloudflareTunnelManager;
  const AzureDevOpsManagerImpl = dependencies.AzureDevOpsManager || AzureDevOpsManager;
  const GitHubManagerImpl = dependencies.GitHubManager || GitHubManager;
  const createPluginManagerImpl = dependencies.createPluginManager || createPluginManager;
  const execFileTextImpl = dependencies.execFileText || execFileText;

  // Platform-optimized recursive directory removal.
  // On Windows, Node's fs.rm is slow on NTFS due to per-file stat calls. The
  // built-in `rd /s /q` operates at the filesystem driver level and is much
  // faster for large trees.  Falls back to fs.rm on other platforms and when
  // `rd` fails (e.g. path too long, permissions).
  async function rmPath(dirPath: string): Promise<void> {
    // On Windows, try the fast native path first (once — if it fails due to
    // locked files, retrying it won't help; let the retry loop use fs.rm which
    // gives us proper EBUSY/EPERM error codes for the backoff logic).
    if (process.platform === "win32") {
      try {
        await execFileTextImpl("cmd.exe", ["/c", "rd", "/s", "/q", dirPath], { timeout: 30_000 });
        return;
      } catch {
        // rd failed (e.g. locked files, long paths) — fall through to fs.rm with retries
      }
    }

    const retryDelays = [300, 600, 1200];
    for (let attempt = 0; attempt <= retryDelays.length; attempt++) {
      try {
        await rm(dirPath, { recursive: true, force: true });
        return;
      } catch (err) {
        if (
          attempt < retryDelays.length &&
          ((err as NodeJS.ErrnoException).code === "EBUSY" || (err as NodeJS.ErrnoException).code === "EPERM")
        ) {
          await new Promise((resolve) => setTimeout(resolve, retryDelays[attempt]));
          continue;
        }
        throw err;
      }
    }
  }

  const checkRemoteOriginImpl = dependencies.checkRemoteOrigin || checkRemoteOrigin;
  const getTerminalEnvironmentImpl = dependencies.getTerminalEnvironment || detectTerminalEnvironmentImpl;
  const statePath = path.join(userDataPath, "strideterm-state.json");
  const credentialsPath = path.join(userDataPath, "credentials.json");
  const azureReviewPath = path.join(userDataPath, "azure-review.json");
  const reviewBridgeRoot = path.join(userDataPath, "review-bridge");
  const processInfo = {
    execPath: process.execPath,
    argv: process.argv,
    defaultApp: (process as NodeJS.Process & { defaultApp?: boolean }).defaultApp,
  };
  const pluginsDir = path.join(userDataPath, "plugins");
  const [store, credentialStore, azureReviewStore, reviewBridgeStore] = await Promise.all([
    createStoreImpl(statePath),
    createCredentialStoreImpl(credentialsPath, {
      safeStorage: dependencies.safeStorage || null,
    }),
    createAzureReviewStoreImpl(azureReviewPath),
    createReviewBridgeStoreImpl(reviewBridgeRoot),
  ]);

  // Apply persisted log level from stored user config (user setting > ENV var > default "warn")
  const storedLogLevel = store.getState().settings?.logLevel;
  if (storedLogLevel) {
    reconfigureLogger({ level: storedLogLevel });
    log.info("logger reconfigured from stored settings", { level: storedLogLevel });
  }

  // ---------------------------------------------------------------------------
  // Notify URL file registration — Claude Code hooks don't inherit parent env
  // vars, so we write URLs to a JSON file that the hook script reads.
  //
  // Multiple strideterm instances (exe + dev, different profiles) may share
  // this file.  Each URL embeds the notify server port, so entries from
  // different instances don't conflict.  On startup we purge stale entries
  // from OUR port (previous run on same port) but leave other ports alone.
  // ---------------------------------------------------------------------------
  const notifyUrlsPath = path.join(userDataPath, "hooks", "notify-urls.json");

  function normalizeCwd(cwd: string): string {
    return cwd.replace(/\\/g, "/").toLowerCase();
  }

  function getUrlPort(u: string): string {
    try {
      return new URL(u).port;
    } catch {
      return "";
    }
  }

  function getUrlSid(u: string): string {
    try {
      return new URL(u).searchParams.get("sid") || "";
    } catch {
      return "";
    }
  }

  /** Read the shared file, or return empty object on any error. */
  function readNotifyUrls(): Record<string, string[]> {
    try {
      return JSON.parse(readFileSync(notifyUrlsPath, "utf8")) as Record<string, string[]>;
    } catch {
      return {};
    }
  }

  /** Write the shared file (not atomic — acceptable for this advisory data). */
  function writeNotifyUrls(data: Record<string, string[]>): void {
    const dir = path.dirname(notifyUrlsPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(notifyUrlsPath, JSON.stringify(data, null, 2), "utf8");
  }

  function registerNotifyUrl(cwd: string, url: string): void {
    const key = normalizeCwd(cwd);
    const myPort = getUrlPort(url);
    const mySid = getUrlSid(url);

    // Read current file (may contain entries from other instances)
    const data = readNotifyUrls();
    if (!data[key]) data[key] = [];

    // Remove stale entry for same sessionId, keep entries from other instances
    data[key] = data[key].filter((u) => getUrlSid(u) !== mySid);
    data[key].push(url);

    try {
      writeNotifyUrls(data);
      log.debug("notify-urls.json updated", { cwd: key, urls: data[key].length, port: myPort });
    } catch (err) {
      log.warn("failed to write notify-urls.json", { err: (err as Error).message });
    }
  }

  /** Remove all URLs belonging to our notify server port (called on shutdown). */
  function cleanupNotifyUrls(port: number): void {
    try {
      const data = readNotifyUrls();
      const portStr = String(port);
      let removed = 0;
      for (const key of Object.keys(data)) {
        const before = data[key].length;
        data[key] = data[key].filter((u) => getUrlPort(u) !== portStr);
        removed += before - data[key].length;
        if (data[key].length === 0) delete data[key];
      }
      if (removed > 0) {
        writeNotifyUrls(data);
        log.debug("notify-urls.json cleanup", { port: portStr, removed });
      }
    } catch (err) {
      log.debug("notify-urls.json cleanup failed", { err: (err as Error).message });
    }
  }

  const sshManager = new SshManager({ store, credentialStore, logger: log });

  const sessions = new SessionManagerImpl({
    sshManager,
    getSessionEnv: ({
      workspace,
      sessionId,
    }: {
      workspace: WorkspaceState | null | undefined;
      sessionId: string | null | undefined;
    }) => {
      const env: Record<string, string> = {};

      // Set provider-specific environment variables for task workspace sessions.
      // CLAUDE_CODE_DISABLE_BACKGROUND_TASKS is Claude-specific — only inject it
      // for Claude provider sessions, not Codex or Gemini.
      if (workspace?.kind === "task" && workspace.task) {
        const panelId = sessionId ? sessionId.split(":").pop() : "";
        const isWorker = panelId === workspace.task.workerPanelId;
        const providerConfig = isWorker
          ? workspace.task.workerProviderConfig || { providerId: "claude" }
          : workspace.task.judgeProviderConfig || { providerId: "claude" };
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const provider = getProvider(providerConfig.providerId as any);
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          Object.assign(env, provider.getEnvironment(providerConfig as any));
        } catch {
          // Unknown provider — fall back to Claude defaults for backward compat
          env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS = "1";
        }
      }

      // Agent notification hook URL — set in env (for non-Claude-Code agents)
      // AND write to notify-urls.json (for Claude Code hooks, which don't inherit
      // parent env vars — only CLAUDE_* vars are passed to hook processes).
      if (notifyServerHandle?.port && sessionId) {
        const notifyUrl = buildNotifyUrl(notifyServerHandle.port, sessionId, notifySecret);
        env.STRIDETERM_NOTIFY_URL = notifyUrl;
        log.debug("injected STRIDETERM_NOTIFY_URL", { sessionId, port: notifyServerHandle.port });
        if (workspace?.cwd) {
          registerNotifyUrl(workspace.cwd, notifyUrl);
        }
      } else if (sessionId) {
        log.debug("STRIDETERM_NOTIFY_URL not injected (notify server not running)", { sessionId });
      }

      if (!["azure-devops", "github"].includes(workspace?.review?.provider ?? "") || !workspace?.review?.prKey) {
        return env;
      }

      const context = reviewBridgeStore.getPullRequestContext?.(workspace.review!.prKey!);
      if (!context) {
        return env;
      }

      return {
        ...env,
        STRIDETERM_REVIEW_PROVIDER: context.provider || workspace.review!.provider || "azure-devops",
        STRIDETERM_REVIEW_PR_KEY: context.prKey,
        STRIDETERM_REVIEW_ROOT: context.rootPath,
        STRIDETERM_REVIEW_DB: context.databasePath,
        STRIDETERM_REVIEW_STORE_DIR: context.exportDir,
        STRIDETERM_REVIEW_EXPORT_DIR: context.exportDir,
        STRIDETERM_REVIEW_BRIEF_MD: context.briefMarkdownPath,
        STRIDETERM_REVIEW_BRIEF_JSON: context.briefJsonPath,
        STRIDETERM_REVIEW_CLI: reviewBridgeCliPath,
        STRIDETERM_REVIEW_WORKSPACE_ID: workspace.id,
      };
    },
    getSessionLaunch: ({ workspace, panel }: { workspace: WorkspaceState | null | undefined; panel: unknown }) => {
      // --- Review workspace: inject MCP bridge ---
      if (!["azure-devops", "github"].includes(workspace?.review?.provider ?? "")) {
        return null;
      }

      let context = workspace!.review!.prKey
        ? reviewBridgeStore.getPullRequestContext?.(workspace!.review!.prKey)
        : null;

      if (!context) {
        const rootPath = reviewBridgeStore.getRootPath?.() || "";
        if (!rootPath) return null;
        context = { rootPath, workspaceId: workspace!.id, prKey: "" };
      }

      return buildReviewAgentLaunch({
        workspace: workspace as WorkspaceState,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        panel: panel as any,
        context,
        processInfo,
      });
    },
  });
  const auditLogDbPath = path.join(reviewBridgeRoot, "azure-audit-log.db");
  const auditLogStore = createAzureAuditLogStore(auditLogDbPath);
  const gitAuditLogDbPath = path.join(reviewBridgeRoot, "git-audit-log.db");
  const gitAuditLogStore = createGitAuditLogStore(gitAuditLogDbPath);

  const docker = new DockerManagerImpl();
  const git = new GitManagerImpl({ credentialStore, auditLogStore, gitAuditLogStore });
  const tunnel = new TunnelManagerImpl();
  const azure = new AzureDevOpsManagerImpl({
    credentialStore,
    reviewStore: azureReviewStore,
    reviewBridgeStore,
    auditLogStore,
    fetchImpl: dependencies.fetchImpl || globalThis.fetch,
    execFileTextImpl,
  });
  const githubAuditLogDbPath = path.join(reviewBridgeRoot, "github-audit-log.db");
  const githubAuditLogStore = createGitHubAuditLogStore(githubAuditLogDbPath);
  const github = new GitHubManagerImpl({
    credentialStore,
    reviewStore: azureReviewStore,
    reviewBridgeStore,
    auditLogStore: githubAuditLogStore,
    fetchImpl: dependencies.fetchImpl || globalThis.fetch,
    execFileTextImpl,
  });
  const events = new EventEmitter();
  // Forward SSH events onto the runtime event bus so Electron IPC and the
  // remote WebSocket relay can pick them up via runtime.on("ssh:*", …).
  for (const channel of ["ssh:auth-prompt", "ssh:host-key-change", "ssh:connection-state", "ssh:state"]) {
    sshManager.on(channel, (payload) => events.emit(channel, payload));
  }
  const terminalEnvironment = getTerminalEnvironmentImpl();
  let remoteInfo: Record<string, unknown> | null = null;
  let dockerPoll: ReturnType<typeof setInterval> | null = null;
  let gitPoll: ReturnType<typeof setInterval> | null = null;
  const attentionContext = createAttentionContext();

  // --- Claude CLI availability (persisted; only re-checked when not yet found) ---
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let claudeAvailableCache = (getState().settings as any)?.claudeAvailable === true;
  if (!claudeAvailableCache) {
    (async () => {
      try {
        await execFileTextImpl("claude", ["--version"], { timeout: 5000 });
        claudeAvailableCache = true;
        await store.mutate((draft: AppState) => {
          draft.settings = draft.settings || {};
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (draft.settings as any).claudeAvailable = true;
        });
      } catch {
        try {
          const which = process.platform === "win32" ? "where" : "which";
          await execFileTextImpl(which, ["claude"], { timeout: 5000 });
          claudeAvailableCache = true;
          await store.mutate((draft: AppState) => {
            draft.settings = draft.settings || {};
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (draft.settings as any).claudeAvailable = true;
          });
        } catch {
          claudeAvailableCache = false;
          log.info("Claude Code CLI not found on PATH");
        }
      }
    })();
  }

  async function recheckClaudeAvailability() {
    try {
      await execFileTextImpl("claude", ["--version"], { timeout: 5000 });
      claudeAvailableCache = true;
    } catch {
      try {
        const which = process.platform === "win32" ? "where" : "which";
        await execFileTextImpl(which, ["claude"], { timeout: 5000 });
        claudeAvailableCache = true;
      } catch {
        claudeAvailableCache = false;
      }
    }
    if (claudeAvailableCache) {
      await store.mutate((draft: AppState) => {
        draft.settings = draft.settings || {};
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (draft.settings as any).claudeAvailable = true;
      });
    }
    log.info("recheckClaudeAvailability", { available: claudeAvailableCache });
    return claudeAvailableCache;
  }

  // --- Agent notification hook server ---
  const notifySecret = generateNotifySecret();
  let notifyServerHandle: NotifyServerHandle | null = null;
  let notifyServerStarting = false;

  // --- Agent Task Runner ---
  const taskRunner = new AgentTaskRunner();

  // --- Broadcast coalescing ---
  let broadcastScheduled = false;

  function getState(): AppState {
    return store.getState() as AppState;
  }

  function getNotificationConfig(state = getState()) {
    return state.settings?.notifications || APP_CONFIG.notifications;
  }

  /**
   * Decide whether a shell-completion alert (OSC 133;D, prompt-pattern, shell
   * exit) should reach the user. Agent sessions always pass — this gate only
   * filters non-agent paths. The user can opt back in per-panel via
   * `panel.alertsForceOn` for cases like a long-running build script in a
   * shell tab where they DO want the "command finished" ping.
   */
  function isShellAlertAllowed(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    signal: { agentLike?: boolean } | null | undefined,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    panel: { alertsForceOn?: boolean } | null | undefined,
    state = getState(),
  ): boolean {
    if (signal?.agentLike) return true;
    if (panel?.alertsForceOn) return true;
    return !getNotificationConfig(state).agentsOnly;
  }

  // One-shot listeners used by testClaudeHook() to confirm end-to-end
  // round-trip: notify.mjs → notify-server → dispatcher.
  // Key = probe_id, value = resolve callback.  Cleared on resolution or timeout.
  const hookProbeListeners = new Map();

  /**
   * Dispatch a Claude Code hook event (Phase 0 § 3.2.b).
   *
   * Pipeline:
   *   1. Record on session signal (hookCapable, lastHookAt, lastHookType).
   *   2. Task runner first dibs (onHookEvent) — task workspaces own their
   *      sessions and must not be alerted through the user pipeline.
   *   3. Classify via classifyHookEvent → user-facing or system-only.
   *   4. Side-effects (e.g. UserPromptSubmit resets busy, lastPromptAt).
   *   5. User-level gating: hasUserInput, visibility, cooldown (urgent bypasses).
   *   6. Raise T1 alert at classified urgency.
   *
   * Accepts the new shape {sessionId, hook, subtype, payload} plus the legacy
   * {sessionId, notificationType} for back-compat with the IPC helper.
   */
  async function dispatchAgentHookEvent(
    event:
      | {
          sessionId?: string;
          hook?: string;
          subtype?: string;
          notificationType?: string;
          payload?: Record<string, unknown>;
        }
      | null
      | undefined,
  ) {
    const sessionId = event?.sessionId || "";
    const hook = event?.hook || "Notification";
    const subtype = event?.subtype || event?.notificationType || "";

    log.debug("agent hook event received", { sessionId, hook, subtype });
    metricsRecordHook(hook);

    // --- Short-circuit: probe events from testClaudeHook() ---
    // These never reach task runner or user pipeline.  They exist only to
    // confirm that notify.mjs can successfully POST to notify-server and
    // be dispatched.  Payload carries { probe_id: "<uuid>" }.
    const probeId = event?.payload?.probe_id;
    if (probeId && hookProbeListeners.has(probeId)) {
      const resolve = hookProbeListeners.get(probeId);
      hookProbeListeners.delete(probeId);
      log.debug("hook probe received", { probeId, sessionId });
      try {
        resolve({ ok: true, sessionId, hook, subtype });
      } catch (err) {
        log.warn("probe resolver threw", { err: (err as Error).message });
      }
      return;
    }

    if (!sessionId) {
      log.debug("hook ignored: no sessionId");
      return;
    }

    const descriptor = parseSessionId(sessionId);
    if (!descriptor) {
      log.debug("hook ignored: unparseable sessionId", { sessionId });
      return;
    }

    // --- 1. Record on signal (for hookCapable gating in detector) ---
    const state = getState();
    const project = findWorkspace(state, descriptor.workspaceId) as WorkspaceState | null;
    const panel = project?.panels.find((p) => p.id === descriptor.panelId) || null;
    const signal = getSessionSignal(sessionId, project, panel);
    signal.hookCapable = true;
    signal.lastHookAt = Date.now();
    signal.lastHookType = subtype ? `${hook}:${subtype}` : hook;

    // --- 2. Task runner first dibs ---
    try {
      const consumed = taskRunner.onHookEvent({ sessionId, hook, subtype });
      if (consumed) {
        log.info("hook consumed by task runner", { sessionId, hook, subtype });
        signal.lastHookAlertAt = Date.now();
        cancelPromptTimer(signal);
        return;
      }
    } catch (err) {
      log.warn("taskRunner.onHookEvent threw", { sessionId, hook, subtype, err: (err as Error).message });
      // Fall through to user pipeline — task runner errors must not eat events.
    }

    // --- 3. Classify ---
    const classification = classifyHookEvent(hook, subtype);

    // --- 4. Side-effects for system-only events (applied regardless of gating) ---
    applyHookSideEffects(signal, hook, subtype);

    if (!classification.userFacing) {
      log.trace("hook system-only — no user alert", { sessionId, hook, subtype });
      return;
    }

    // --- 5. User-level gating ---
    if (!signal.hasUserInput) {
      log.debug("hook ignored: no user input yet", { sessionId, hook, subtype });
      return;
    }
    if (signal.waitingRaised && classification.urgency !== "urgent") {
      log.debug("hook ignored: waiting already raised (not urgent)", { sessionId, hook });
      return;
    }
    if (isSessionVisible(sessionId)) {
      log.trace("hook: session visible, resetting signal", { sessionId });
      resetSessionSignal(sessionId);
      return;
    }

    const notifConfig = getNotificationConfig(state);
    const now = Date.now();
    const cooldownMs = notifConfig.alertCooldownMs;
    const urgentCooldownMs = 3_000; // urgent has its own short cooldown, see plan § 3.2.c
    const effectiveCooldown = classification.urgency === "urgent" ? urgentCooldownMs : cooldownMs;
    const inCooldown = signal.lastAlertAt > 0 && now - signal.lastAlertAt < effectiveCooldown;
    if (inCooldown) {
      log.debug("hook ignored: cooldown active", {
        sessionId,
        urgency: classification.urgency,
        remainingMs: effectiveCooldown - (now - signal.lastAlertAt),
      });
      return;
    }

    // Repeat idle_prompt suppression: Claude Code occasionally re-fires
    // `Notification:idle_prompt` for the SAME waiting state (e.g. on focus
    // changes, periodic heartbeats, statusline redraws). If nothing the user
    // cares about has happened since the last alert, the second hook is
    // redundant noise.
    //
    // "Nothing happened" means ALL of:
    //   1. User has not submitted a new prompt to Claude since the last
    //      alert (`lastPromptAt <= lastAlertAt`). UserPromptSubmit is the
    //      authoritative "user sent work" signal — if they haven't, Claude
    //      is still in the same waiting state.
    //   2. Claude has not emitted substantial output since last alert
    //      (`outputBursts < 10`). Tiny status-line heartbeats bump bursts
    //      by 1-2, but a real new response is 20+ chunks; threshold of 10
    //      distinguishes them.
    //
    // Gated by `agentLike` so non-agent sessions (which don't track
    // outputBursts in the detector) aren't affected.
    //
    // Urgent (permission_prompt) always bypasses — those are blockers.
    const userSubmittedSinceAlert = signal.lastPromptAt > 0 && signal.lastPromptAt > signal.lastAlertAt;
    const substantialOutputSinceAlert = signal.outputBursts >= 10;
    if (
      hook === "Notification" &&
      subtype === "idle_prompt" &&
      classification.urgency !== "urgent" &&
      signal.agentLike &&
      signal.everAlerted &&
      !userSubmittedSinceAlert &&
      !substantialOutputSinceAlert
    ) {
      log.debug("hook ignored: repeat idle_prompt with no intervening activity", {
        sessionId,
        lastAlertAgeMs: now - signal.lastAlertAt,
        outputBursts: signal.outputBursts,
        userSubmittedSinceAlert,
      });
      return;
    }

    signal.lastHookAlertAt = now;
    cancelPromptTimer(signal);

    // --- 6. Raise T1 alert ---
    log.info("agent hook raising alert", {
      sessionId,
      hook,
      subtype,
      urgency: classification.urgency,
      detail: classification.detail,
    });
    raiseAlert({
      sessionId,
      projectId: descriptor.workspaceId,
      panelId: descriptor.panelId,
      title: panel?.title || descriptor.panelId,
      kind: classification.kind,
      tier: classification.tier ?? 1,
      urgency: classification.urgency,
      detail: classification.detail,
    });
  }

  /**
   * Side-effects applied to a session signal based on hook type.
   * Runs whether the event is user-facing or system-only.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function applyHookSideEffects(signal: any, hook: string, subtype: string) {
    if (!signal) return;
    if (hook === "UserPromptSubmit") {
      // User started new work — prior idle state is stale.
      signal.lastPromptAt = Date.now();
      signal.busy = false;
      signal.outputBursts = 0;
      signal.waitingRaised = false;
      cancelPromptTimer(signal);
      setSessionActivity(signal, "running");
      log.trace("UserPromptSubmit: reset busy/waitingRaised", { sessionId: signal.sessionId });
    } else if (hook === "Stop" || hook === "SubagentStop") {
      // Agent finished its turn — flash a "done" chip then fade to idle.
      setSessionActivity(signal, "done", { exitCode: 0 });
    }
    // Notification is informational only — leave chip state untouched; it
    // typically means "waiting for input" mid-turn, not a turn boundary.
    void subtype;
  }

  // Back-compat alias for IPC helper `notifyAgentHook`.
  const handleAgentHookNotification = dispatchAgentHookEvent;

  async function startAgentNotifyServer() {
    const state = getState();
    const enabled = state.settings?.notifications?.agentHook !== false;
    if (!enabled) {
      log.debug("notify server disabled by settings");
      return;
    }
    if (notifyServerHandle || notifyServerStarting) {
      log.trace("notify server already running/starting");
      return;
    }
    notifyServerStarting = true;
    try {
      notifyServerHandle = await startNotifyServer({
        secret: notifySecret,
        onNotification: handleAgentHookNotification,
        logger: log,
      });
      log.info("notify server started", { port: notifyServerHandle.port });
    } catch (error) {
      log.warn("notify server failed to start (silence detection still active)", {
        err: (error as Error).message,
        stack: (error as Error).stack,
      });
      notifyServerHandle = null;
    } finally {
      notifyServerStarting = false;
    }
  }

  async function stopAgentNotifyServer() {
    if (notifyServerHandle) {
      const port = notifyServerHandle.port;
      log.info("stopping notify server", { port });
      cleanupNotifyUrls(port);
      try {
        await notifyServerHandle.close();
      } catch (error) {
        log.warn("notify server close error", { err: (error as Error).message });
      }
      notifyServerHandle = null;
    }
  }

  function getAzureSettings(state = getState()) {
    return (
      state.settings?.integrations?.azureDevops || {
        enabled: true,
        reviewRoot: path.join(userDataPath, "azure-pr"),
        defaultPollSeconds: 120,
        connections: [],
      }
    );
  }

  function getAzureConnections(state = getState()) {
    const all = getAzureSettings(state).connections || [];
    const activeProfile = state.activeProfileId || "default";
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return all.filter((c: any) => (c.profileId || "default") === activeProfile);
  }

  function getGitHubSettings(state = getState()) {
    return (
      state.settings?.integrations?.github || {
        enabled: true,
        reviewRoot: path.join(userDataPath, "github-pr"),
        defaultPollSeconds: 120,
        connections: [],
      }
    );
  }

  function getGitHubConnections(state = getState()) {
    const all = getGitHubSettings(state).connections || [];
    const activeProfile = state.activeProfileId || "default";
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return all.filter((c: any) => (c.profileId || "default") === activeProfile);
  }

  /**
   * Return all provider connections (Azure DevOps, GitHub, and future GitLab)
   * visible to the active profile.  Each provider stores connections under
   * its own settings key; this helper merges them into a single list so the
   * git tab can offer a unified dropdown.
   */
  function getAllProviderConnections(state = getState()) {
    const activeProfile = state.activeProfileId || "default";
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const matchProfile = (c: any) => (c.profileId || "default") === activeProfile;

    const azureConns = (getAzureSettings(state).connections || []).filter(matchProfile);
    const githubConns = (getGitHubSettings(state).connections || []).filter(matchProfile);
    return [...azureConns, ...githubConns];
  }

  /**
   * Resolve the provider connection for a workspace's git operations.
   * Returns `null` when the workspace has no connectionId assigned or the
   * connection cannot be found (falls back to system git credentials).
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function resolveGitConnection(workspace: any) {
    const connectionId =
      workspace?.connectionId || workspace?.review?.connectionId || workspace?.quickfix?.connectionId;
    if (!connectionId) {
      return null;
    }
    const connections = getAllProviderConnections();
    return connections.find((c) => c.id === connectionId && c.enabled !== false) || null;
  }

  function normalizeFsPath(value: string): string {
    const resolved = path.resolve(String(value || "").trim() || ".");
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function parseAzureReviewWorkspaceHint(workspace: any) {
    const cwd = String(workspace?.cwd || "");
    const cwdMatch = cwd.match(/[\\/]pr-(\d+)(?:[\\/]|$)/i);
    const nameMatch = String(workspace?.name || "").match(/\bPR\s*#(\d+)\b/i);
    const prId = Number.parseInt(cwdMatch?.[1] || nameMatch?.[1] || "", 10);
    const connectionPathKey = cwdMatch ? path.basename(path.dirname(cwd)) : "";
    return {
      prId: Number.isInteger(prId) ? prId : null,
      connectionPathKey: String(connectionPathKey || "")
        .trim()
        .toLowerCase(),
    };
  }

  function getReviewBridgeSnapshot(state = getState()) {
    try {
      const prKeys = new Set([
        ...Object.keys(azure.getSnapshot().pullRequests || {}),
        ...Object.keys(github.getSnapshot().pullRequests || {}),
        ...(state.workspaces || [])
          .map((workspace: WorkspaceState) =>
            ["azure-devops", "github"].includes(workspace.review?.provider ?? "") ? workspace.review!.prKey : "",
          )
          .filter(Boolean),
      ]);
      const pullRequests: Record<string, unknown> = {};
      const processInfo = {
        execPath: process.execPath,
        platform: process.platform,
        defaultApp: Boolean((process as NodeJS.Process & { defaultApp?: boolean }).defaultApp),
      };
      for (const prKey of prKeys) {
        const context = reviewBridgeStore.getPullRequestContext?.(prKey);
        if (context) {
          let mcpSpec = null;
          try {
            mcpSpec = buildMcpServerSpec({ context, processInfo });
          } catch {}
          pullRequests[prKey] = {
            ...context,
            cliPath: reviewBridgeCliPath,
            mcpServerSpec: mcpSpec,
          };
        }
      }
      return {
        rootPath: reviewBridgeStore.getRootPath?.() || reviewBridgeRoot,
        databasePath: reviewBridgeStore.getDatabasePath?.() || "",
        pullRequests,
        agentPrompts: reviewBridgeStore.getAgentPrompts?.() || [],
      };
    } catch {
      // Store may be closed during shutdown
      return { rootPath: reviewBridgeRoot, databasePath: "", pullRequests: {}, agentPrompts: [] };
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function createAzureWorkspaceReviewPanels(tabTemplates: any[] = []) {
    const preferredTemplates = ["shell", "claude", "codex"];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const selected: any[] = [];

    for (const templateId of preferredTemplates) {
      const template = tabTemplates.find((entry) => entry.id === templateId);
      if (template) {
        selected.push(template);
      }
    }
    if (!selected.length) {
      selected.push(...tabTemplates.slice(0, 3));
    }
    if (!selected.length) {
      selected.push(
        { title: "Shell", command: "" },
        { title: "Claude Code", command: "claude" },
        { title: "Codex", command: "codex" },
      );
    }

    return selected.map((template, index) => ({
      id: `panel-${randomUUID()}`,
      title: template.title || (index === 0 ? "Shell" : `Panel ${index + 1}`),
      command: template.command || "",
      shell: true,
      startup: template.startup || (index === 0 ? APP_CONFIG.ui.defaultPanelStartup : APP_CONFIG.ui.manualPanelStartup),
    }));
  }

  // --- Provider workspace lifecycle (extracted to runtime-provider-lifecycle.js) ---
  const providerLifecycle = createProviderLifecycle({
    getState,
    store,
    azure,
    github,
    git,
    azureReviewStore,
    getAzureSettings,
    getAzureConnections,
    getGitHubSettings,
    getGitHubConnections,
    parseAzureReviewWorkspaceHint,
    normalizeFsPath,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    createAzureWorkspaceReviewPanels: createAzureWorkspaceReviewPanels as (templates: any[]) => any[],
    findWorkspace: findWorkspace as unknown as (state: AppState, workspaceId: string) => WorkspaceState | null,
  });
  const {
    ensureAzureWorkspace,
    refreshAzure,
    scheduleAzurePolling,
    ensureGitHubWorkspace,
    refreshGitHub,
    scheduleGitHubPolling,
  } = providerLifecycle;

  tunnel.setBinaryPreference?.(getState().settings.remoteAccess.cloudflaredPath || "");

  const versionChecker = createVersionChecker({
    currentVersion: packageVersion,
    repositoryUrl: APP_CONFIG.app.repositoryUrl,
    userDataPath,
  });

  const {
    projectAlerts,
    sessionSignals,
    getAttentionSnapshot,
    cancelPromptTimer,
    resetSessionSignal,
    deleteSessionSignal,
    addProjectAlert,
    clearProjectAlerts,
    clearAlertSession,
    getSessionSignal,
    raiseAlert,
    raiseWaitingAlert,
    ensureVisibleSession,
    syncSessionSignalsWithState,
    shouldTrackProjectAlert,
    updateVisibleSessions,
    isSessionVisible,
    markSessionPromptInjected,
  } = createRuntimeAttentionManager({
    log,
    getState,
    sessions,
    createSessionId,
    parseSessionId,
    getNotificationConfig,
    createSessionSignal,
    adaptiveForget,
    metricsRecordAlert,
    APP_CONFIG,
    AGENT_NAME_RE,
    ATTENTION_VISIBILITY_GRACE_MS,
    attentionContext,
    broadcastState,
    isKnownPluginProject,
  });

  // --- Tab activity chip state ----------------------------------------
  // Drives the small status label on each tab. Independent from signal.busy
  // (which governs notifications). Transitions:
  //   idle  --OSC133;C / UserPromptSubmit-->   running
  //   running --OSC133;D / Stop-->              done (+exit code)
  //   done  --after ACTIVITY_FADE_MS-->         idle
  // Sessions without shell integration and no hooks simply stay "idle" —
  // showing no chip is preferable to a misleading permanent "running" label.
  const ACTIVITY_FADE_MS = 3000;
  const activityFadeTimers = new Map();

  function scheduleActivityFade(sessionId: string): void {
    const prior = activityFadeTimers.get(sessionId);
    if (prior) clearTimeout(prior);
    const timer = setTimeout(() => {
      activityFadeTimers.delete(sessionId);
      const signal = sessionSignals.get(sessionId);
      if (!signal) return;
      if (signal.activity === "done") {
        signal.activity = "idle";
        broadcastState();
      }
    }, ACTIVITY_FADE_MS);
    activityFadeTimers.set(sessionId, timer);
  }

  function clearActivityFade(sessionId: string): void {
    const prior = activityFadeTimers.get(sessionId);
    if (prior) {
      clearTimeout(prior);
      activityFadeTimers.delete(sessionId);
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function setSessionActivity(signal: any, activity: string, { exitCode = null as number | null } = {}): void {
    if (!signal) return;
    if (signal.activity === activity && activity !== "done") return;
    signal.activity = activity;
    if (activity === "done") {
      signal.lastExitCode = exitCode;
      signal.lastCommandFinishedAt = Date.now();
      scheduleActivityFade(signal.sessionId);
    } else {
      clearActivityFade(signal.sessionId);
    }
    broadcastState();
  }

  function getPayload() {
    const state = getState();
    return {
      meta: {
        appVersion: packageVersion,
        repositoryUrl: APP_CONFIG.app.repositoryUrl,
        versionCheck: versionChecker.getCachedResult(),
        platform: process.platform,
      },
      appState: (() => {
        const cloned = clone(state);
        // Filter connections to active profile only
        if (cloned.settings?.integrations?.azureDevops) {
          cloned.settings.integrations.azureDevops.connections = getAzureConnections(state);
        }
        if (cloned.settings?.integrations?.github) {
          cloned.settings.integrations.github.connections = getGitHubConnections(state);
        }
        return cloned;
      })(),
      workspace: (() => {
        const ws = sessions.getWorkspace(state);
        if (ws?.sessions) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          ws.sessions = ws.sessions.map((s: any) => {
            const signal = sessionSignals.get(s.sessionId);
            if (!signal) return s;
            return {
              ...s,
              activity: signal.activity || "idle",
              lastExitCode: signal.lastExitCode,
              lastCommandFinishedAt: signal.lastCommandFinishedAt || 0,
            };
          });
        }
        return ws;
      })(),
      attention: getAttentionSnapshot(state),
      docker: docker.getSnapshot(),
      git: {
        workspaces: git.getProjectMap(),
        projects: git.getProjectMap(),
        activeWorkspace: git.getSnapshot(state.activeWorkspaceId),
        activeProject: git.getSnapshot(state.activeProjectId),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        connections: getAllProviderConnections(state).map((c: any) => ({
          id: c.id,
          label: c.label || c.id,
          provider: c.provider || "azure-devops",
          enabled: c.enabled !== false,
        })),
      },
      azureDevops: azure.getSnapshot(),
      github: github.getSnapshot(),
      reviewBridge: getReviewBridgeSnapshot(state),
      plugins: pluginManager ? pluginManager.getPlugins() : [],
      environment: { ...terminalEnvironment, claudeAvailable: claudeAvailableCache },
      themeSource: getThemeSource?.() || "dark",
      remoteAccess: {
        ...(remoteInfo || {
          enabled: false,
          host: state.settings.remoteAccess.host,
          port: state.settings.remoteAccess.port,
          urls: [],
        }),
        tunnel: tunnel.getSnapshot(),
      },
      agentNotifyHook: {
        enabled: notifyServerHandle != null,
        port: notifyServerHandle?.port || null,
      },
      taskRunner: taskRunner.getTaskSnapshot(),
    };
  }

  function broadcastState() {
    if (broadcastScheduled) return;
    broadcastScheduled = true;
    queueMicrotask(() => {
      broadcastScheduled = false;
      const payload = getPayload();
      events.emit("state:updated", payload);
    });
  }

  // --- Task runner init (needs broadcastState and sessions) ---
  taskRunner.init({
    writeToSession(sessionId, data) {
      sessions.writeToSession(sessionId, data);
      markSessionPromptInjected(sessionId);
    },
    getState,
    broadcastState,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    raiseAlert({ projectId, panelId, sessionId, title, kind, detail, tier, urgency, exitCode }: any) {
      // Task runner completions/failures are authoritative — always T1.
      // `failed` variants are urgent so the user notices a broken task.
      const inferredUrgency = urgency || (kind === "waiting" || kind === "completed" ? "normal" : "urgent");
      addProjectAlert({
        projectId,
        panelId,
        sessionId,
        title,
        kind,
        detail,
        tier: tier ?? 1,
        urgency: inferredUrgency,
        exitCode,
      });
      broadcastState();
    },
    async restartSession(sessionId) {
      await sessions.restartSession(getState(), sessionId);
      resetSessionSignal(sessionId);
    },
  });

  async function ensureRemoteOriginReady(remoteConfig: { host?: string; port?: number }): Promise<string> {
    const originUrl = createTunnelOriginUrl(remoteConfig);
    await checkRemoteOriginImpl(originUrl);
    return originUrl;
  }

  /**
   * Phase 2 § 3.2.4. Accumulate typed characters and, on Enter, classify
   * the completed command.  Simple heuristic — handles printable keystrokes
   * and basic backspace; ignores arrow keys / escape sequences (they don't
   * change the command text for classification purposes).
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function updateCommandClassFromInput(signal: any, data: any) {
    if (!signal || !data) return;
    for (const ch of String(data)) {
      if (ch === "\r" || ch === "\n") {
        const cmd = signal.inputBuffer.trim();
        signal.inputBuffer = "";
        if (cmd) {
          const cls = classifyCommand(cmd);
          signal.commandClass = cls;
          signal.currentCommand = cmd.slice(0, 120);
          log.debug("command classified", { sessionId: signal.sessionId, cls, cmd: signal.currentCommand });
        }
      } else if (ch === "\u007f" || ch === "\b") {
        // Backspace / DEL — trim last char
        signal.inputBuffer = signal.inputBuffer.slice(0, -1);
      } else if (ch === "\u0003" || ch === "\u0004") {
        // Ctrl-C / Ctrl-D — abandon buffer and reset class
        signal.inputBuffer = "";
        signal.commandClass = "";
        signal.currentCommand = "";
      } else if (ch >= " " && ch !== "\u001b") {
        // Printable ASCII + beyond (printable). Skip ESC sequences.
        signal.inputBuffer += ch;
        // Hard cap — we don't need more than 200 chars for classification
        if (signal.inputBuffer.length > 200) signal.inputBuffer = signal.inputBuffer.slice(-200);
      }
    }
  }

  /**
   * Plan Phase 1 § 4.7 / Phase 2 § 3.2.5.
   * Was the user actively typing in this session within the grace window?
   * Used to suppress silence-based (T3) alerts — if the user interacted
   * seconds ago, they are obviously present and don't need a notification.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function isInInteractionGrace(signal: any, notifConfig: any) {
    if (!signal?.lastUserInteractionAt) return false;
    const graceMs = notifConfig?.userInteractionGraceMs ?? 10_000;
    return Date.now() - signal.lastUserInteractionAt < graceMs;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function isKnownPluginProject(project: any) {
    if (!project) {
      return false;
    }
    if (project.source === "plugin" || project.pluginId) {
      return true;
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return pluginManager.getPlugins().some((plugin: any) => {
      if (plugin.error || !plugin.workspaceDefaults) {
        return false;
      }
      const template = plugin.workspaceDefaults;
      const templateName = template.name || plugin.name;
      const templateIcon = template.icon || plugin.icon || APP_CONFIG.ui.defaultProjectIcon;
      const templateKind = template.kind || plugin.kind || APP_CONFIG.ui.defaultProjectKind;
      return templateName === project.name && templateIcon === project.icon && templateKind === project.kind;
    });
  }

  // perf-3: per-workspace debounce map for git refresh triggered by OSC 133;D
  const gitRefreshDebounceMap = new Map();
  function scheduleGitRefreshFromShell(workspaceId: string) {
    const existing = gitRefreshDebounceMap.get(workspaceId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      gitRefreshDebounceMap.delete(workspaceId);
      refreshGit(workspaceId).catch(() => {});
      broadcastState();
    }, 1000);
    gitRefreshDebounceMap.set(workspaceId, timer);
  }

  // Per-session dedup for rate-limit alerts. The same banner can scroll
  // multiple times in the agent's output and we only want one alert per
  // window. Also covers redrawn TUIs (Claude's prompt-limit dialog repaints).
  const lastRateLimitAlertAt = new Map<string, number>();
  const RATE_LIMIT_ALERT_DEDUP_MS = 60_000;

  /**
   * Raise an urgent waiting-alert when ANY agent (task worker or plain
   * terminal) hits its provider's rate limit. The detail string format
   * `rate-limited:<provider>[, resumes <time>]` is what the frontend
   * notification capture parses to render the user-facing message.
   */
  function raiseRateLimitAlert(
    sessionId: string,
    workspaceId: string,
    panelId: string,
    panelTitle: string,
    match: import("./runtime-utils.js").RateLimitMatch,
  ): void {
    const now = Date.now();
    const last = lastRateLimitAlertAt.get(sessionId) || 0;
    if (now - last < RATE_LIMIT_ALERT_DEDUP_MS) return;
    lastRateLimitAlertAt.set(sessionId, now);

    const resetSuffix = match.resetAt ? `, resumes ${match.resetAt.toLocaleTimeString()}` : "";
    const detail = `rate-limited:${match.providerHint}${resetSuffix}`;

    log.warn("rate-limit alert raised", {
      sessionId,
      workspaceId,
      providerHint: match.providerHint,
      needsConfirm: match.needsConfirm,
      resetAt: match.resetAt?.toISOString() || null,
    });

    raiseAlert({
      sessionId,
      projectId: workspaceId,
      panelId,
      title: panelTitle,
      kind: "waiting",
      tier: 1,
      urgency: "urgent",
      detail,
      exitCode: null,
    });
  }

  // Two-stage rate-limit confirmation. Regex matching against agent output
  // is inherently fragile — the worker editing rate-limit-related code emits
  // diff lines, comments, and test output that contain the exact phrases the
  // detectors look for. Stage 1 marks the session as "suspected" without
  // raising any alert or setting task.rateLimitedUntil. Stage 2 fires after
  // a confirmation window and checks whether the agent actually went quiet
  // (real rate limit) or kept producing output (false positive).
  //
  // The alternative — firing immediately on first match — locked up a real
  // task run when the worker's own diff scrolled "the runner was rate-limited"
  // through stdout. The user explicitly chose latency over premature action.
  interface RateLimitSuspicion {
    match: import("./runtime-utils.js").RateLimitMatch;
    workspaceId: string;
    panelId: string;
    panelTitle: string;
    suspectedAt: number;
    lastOutputAt: number;
    timer: ReturnType<typeof setTimeout>;
  }
  const rateLimitSuspicions = new Map<string, RateLimitSuspicion>();
  // Window after a match during which the session is observed before the
  // alert fires. 60 s outlasts even long extended-thinking pauses (Claude's
  // deeper reasoning modes routinely sit silent 30–45 s mid-turn) — anything
  // shorter false-confirmed when the worker happened to pause right after
  // emitting code that mentioned rate-limit terms. Latency cost on a real
  // rate-limit (which lasts hours) is negligible.
  const RATE_LIMIT_CONFIRM_WINDOW_MS = 60_000;
  // Output is allowed to trail the match for this long (TUI repaint, the
  // tail end of the same buffer) without flipping to "agent kept working".
  const RATE_LIMIT_TRAILING_TOLERANCE_MS = 5_000;

  function trackRateLimitOutput(sessionId: string, now: number): void {
    const suspicion = rateLimitSuspicions.get(sessionId);
    if (suspicion) suspicion.lastOutputAt = now;
  }

  function clearRateLimitSuspicion(sessionId: string): void {
    const suspicion = rateLimitSuspicions.get(sessionId);
    if (!suspicion) return;
    clearTimeout(suspicion.timer);
    rateLimitSuspicions.delete(sessionId);
  }

  function suspectRateLimit(
    sessionId: string,
    workspaceId: string,
    panelId: string,
    panelTitle: string,
    match: import("./runtime-utils.js").RateLimitMatch,
  ): void {
    if (rateLimitSuspicions.has(sessionId)) return; // already observing this session
    const now = Date.now();
    const timer = setTimeout(() => {
      void (async () => {
        const s = rateLimitSuspicions.get(sessionId);
        if (!s) return;
        rateLimitSuspicions.delete(sessionId);
        const trailingMs = s.lastOutputAt - s.suspectedAt;
        if (trailingMs > RATE_LIMIT_TRAILING_TOLERANCE_MS) {
          log.debug("rate-limit suspicion dropped: agent kept working past silence window", {
            sessionId,
            trailingMs,
            providerHint: s.match.providerHint,
          });
          return;
        }

        // Silence detected — but verify with WORK_LOCK before declaring it
        // a rate-limit. If the worker has already deleted WORK_LOCK, the
        // silence is "task finished", not "quota hit", and we must not
        // raise an alert or set rateLimitedUntil (which would block the
        // judge from running). Run the existing idle pipeline instead.
        try {
          if (await taskRunner.isWorkerCompleted(s.workspaceId)) {
            log.warn("rate-limit suspicion overridden by WORK_LOCK absence on confirm", {
              sessionId,
              providerHint: s.match.providerHint,
            });
            taskRunner.onAgentIdle(sessionId, "rate-limit-override-on-confirm");
            return;
          }
        } catch (err) {
          // isWorkerCompleted is best-effort; on error fall through to the
          // original alert path so we don't silently lose a real rate-limit.
          log.debug("isWorkerCompleted threw on confirm — proceeding with alert", {
            sessionId,
            err: (err as Error)?.message,
          });
        }

        log.warn("rate-limit confirmed after silence window", {
          sessionId,
          trailingMs,
          providerHint: s.match.providerHint,
        });
        raiseRateLimitAlert(sessionId, s.workspaceId, s.panelId, s.panelTitle, s.match);
        // Hand off to the task runner only AFTER confirmation. For non-task
        // sessions this is a no-op; for task workers it sets rateLimitedUntil
        // and schedules the auto-resume timer. Deferring this is the whole
        // point of the two-stage check — premature handoff is what blocks
        // the judge when the original match was a false positive.
        taskRunner.onWorkerRateLimited(sessionId, s.match, "output-detect-confirmed");
      })();
    }, RATE_LIMIT_CONFIRM_WINDOW_MS);
    rateLimitSuspicions.set(sessionId, {
      match,
      workspaceId,
      panelId,
      panelTitle,
      suspectedAt: now,
      lastOutputAt: now,
      timer,
    });
    log.debug("rate-limit suspected, waiting for confirmation", {
      sessionId,
      providerHint: match.providerHint,
      windowMs: RATE_LIMIT_CONFIRM_WINDOW_MS,
    });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sessions.on("terminal:data", (payload: any) => {
    const descriptor = parseSessionId(payload.sessionId);
    const state = getState();
    const project = descriptor ? (findWorkspace(state, descriptor.workspaceId) as WorkspaceState | null) : null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const panel = (project as any)?.panels?.find((item: any) => item.id === descriptor?.panelId) || null;
    const rawText = String(payload.data || "");
    const cleanText = rawText ? stripAnsi(rawText) : "";

    // Rate-limit detection runs for ANY agent in ANY tab — Docker shells,
    // plugin panels, plain terminals, task workers. Hitting a provider limit
    // is a user-visible event regardless of where the agent is running, and
    // the existing `shouldTrackProjectAlert` gate (further down) excludes
    // some of those panel kinds. Detection happens before the gate so all
    // sessions are covered. A match here is only a SUSPICION — confirmation
    // happens after a silence window so a banner scrolled through during
    // unrelated work doesn't fire an alert and lock up the task runner.
    trackRateLimitOutput(payload.sessionId, Date.now());
    if (descriptor && project && panel && cleanText) {
      const rateLimitMatch = detectRateLimit(cleanText);
      if (rateLimitMatch) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const panelTitle = ((panel as any).title as string) || descriptor.panelId;
        suspectRateLimit(payload.sessionId, descriptor.workspaceId, descriptor.panelId, panelTitle, rateLimitMatch);
      }
    }

    if (descriptor && shouldTrackProjectAlert(project, panel)) {
      const signal = getSessionSignal(payload.sessionId, project, panel);
      const notifConfig = getNotificationConfig(state);
      const lastLine = lastNonEmptyLine(cleanText);

      if (AGENT_OUTPUT_RE.test(cleanText)) {
        signal.agentLike = true;
      }

      // Phase 2 § 3.2.7 bullet 1: if the session has been genuinely silent
      // for longer than 5× agentQuietMs, reset the busy latch. The next burst
      // starts fresh, so a stale "busy" from hours ago can't piggy-back a
      // false positive onto a small, unrelated output blip.
      if (signal.busy && signal.lastOutputAt > 0) {
        const idleFor = Date.now() - signal.lastOutputAt;
        const staleThreshold = 5 * notifConfig.agentQuietMs;
        if (idleFor > staleThreshold) {
          log.debug("resetting stale busy latch after long silence", {
            sessionId: payload.sessionId,
            idleMs: idleFor,
            thresholdMs: staleThreshold,
          });
          cancelPromptTimer(signal);
          signal.busy = false;
          signal.outputBursts = 0;
          signal.waitingRaised = false;
        }
      }

      // Phase 3 § 3.2.2: track animation activity for T3 suppression
      if (hasRecentAnimation(rawText)) {
        signal.lastAnimationAt = Date.now();
      }

      // --- OSC 133;C: command submitted (shell-integration) ---
      // Mark the tab as "running". No alert semantics, no interaction with
      // signal.busy — this is purely the UI chip.
      if (OSC133_COMMAND_START_RE.test(rawText)) {
        setSessionActivity(signal, "running");
      }

      // --- OSC 133;D: shell integration command-finished signal ---
      // When a shell with integration (bash/zsh/PowerShell) emits OSC 133;D,
      // the previous command has finished and the shell prompt has returned.
      // This gives us instant, reliable detection for shell-hosted agents.
      const osc133FinishedMatch = rawText.match(OSC133_COMMAND_FINISHED_RE);
      if (osc133FinishedMatch) {
        const exitCode = osc133FinishedMatch[1] != null ? Number(osc133FinishedMatch[1]) : 0;
        setSessionActivity(signal, "done", { exitCode });
        log.debug("OSC 133;D detected", {
          sessionId: payload.sessionId,
          busy: signal.busy,
          hasUserInput: signal.hasUserInput,
        });
        // Task runner intercept FIRST — bypass hasUserInput/cooldown guards
        if (taskRunner.onAgentIdle(payload.sessionId, "osc133")) {
          log.debug("OSC 133;D: task runner handled idle", { sessionId: payload.sessionId });
          cancelPromptTimer(signal);
        } else if (signal.hasUserInput) {
          const now = Date.now();
          const inCooldown = signal.lastAlertAt > 0 && now - signal.lastAlertAt < notifConfig.alertCooldownMs;
          if (signal.busy && !inCooldown) {
            cancelPromptTimer(signal);
            if (isSessionVisible(payload.sessionId)) {
              log.trace("OSC 133;D: session visible, resetting", { sessionId: payload.sessionId });
              resetSessionSignal(payload.sessionId);
            } else if (!isShellAlertAllowed(signal, panel, state)) {
              log.trace("OSC 133;D: shell-only alert suppressed by agentsOnly setting", {
                sessionId: payload.sessionId,
              });
              cancelPromptTimer(signal);
            } else {
              log.debug("OSC 133;D triggering alert", { sessionId: payload.sessionId });
              raiseWaitingAlert({
                sessionId: payload.sessionId,
                projectId: descriptor.workspaceId,
                panelId: descriptor.panelId,
                title: panel?.title || descriptor.panelId,
                detail: "osc133-finished",
              });
            }
          } else if (inCooldown) {
            log.trace("OSC 133;D: cooldown active, skipping", {
              sessionId: payload.sessionId,
              remainingMs: notifConfig.alertCooldownMs - (now - signal.lastAlertAt),
            });
          }
        }
        // Skip normal detection for this chunk — OSC 133;D is authoritative.
        // perf-3: schedule a debounced git refresh if this session is in a git workspace
        if (descriptor?.workspaceId) {
          const wsSnapshot = git.getSnapshot?.(descriptor.workspaceId);
          if (wsSnapshot?.available) {
            scheduleGitRefreshFromShell(descriptor.workspaceId);
          }
        }
      } else if (signal.agentLike && signal.hookCapable) {
        // --- Agent sessions with proven hooks: trust them exclusively ---
        // Phase 0 § 3.2.d — a session that has fired at least one hook event
        // uses hooks as its ONLY alert source (plus BEL / OSC 133;D already
        // handled above).  Silence-based fallback is off — it's the primary
        // source of false positives during long Claude Code turns.
        const now = Date.now();
        const inCooldown = signal.lastAlertAt > 0 && now - signal.lastAlertAt < notifConfig.alertCooldownMs;
        const hasBell = rawText.includes("\u0007");

        // Still track busy so task runner sees activity; still update
        // lastOutputLine so any future hook-fallback logic has context.
        if (cleanText.trim()) {
          signal.busy = true;
          signal.outputBursts += 1;
        }
        if (lastLine) {
          signal.lastOutputLine = lastLine;
        }
        signal.lastOutputAt = Date.now();

        // BEL is a legacy T1 signal (some agents emit it alongside hooks).
        // Keep honoring it — cheap, authoritative, no false positives.
        if (hasBell && !inCooldown && signal.hasUserInput) {
          cancelPromptTimer(signal);
          if (isSessionVisible(payload.sessionId)) {
            resetSessionSignal(payload.sessionId);
          } else {
            raiseWaitingAlert({
              sessionId: payload.sessionId,
              projectId: descriptor.workspaceId,
              panelId: descriptor.panelId,
              title: panel?.title || descriptor.panelId,
              detail: "bell-hookcapable",
            });
          }
        }
        // No silence timer, no hook-fallback: hooks are the source of truth.
      } else if (signal.agentLike) {
        // --- Agent sessions without proven hooks: fallback path ---
        // Either hooks haven't fired yet (first turn) or config is broken.
        // We keep bell + silence detection as safety net.
        const now = Date.now();
        const inCooldown = signal.lastAlertAt > 0 && now - signal.lastAlertAt < notifConfig.alertCooldownMs;
        const hasBell = rawText.includes("\u0007");
        const hooksEnabled = notifyServerHandle != null;

        if (hasBell) {
          log.debug("bell character detected in agent session", { sessionId: payload.sessionId, hooksEnabled });
        }

        // Track output activity regardless of detection mode.
        if (cleanText.trim()) {
          signal.busy = true;
          signal.outputBursts += 1;
        }
        if (lastLine) {
          signal.lastOutputLine = lastLine;
        }

        // Log a one-shot warning if an agent session has been busy for a long
        // time with no hook ever arriving — almost always a config issue.
        if (
          signal.busy &&
          !signal.hookCapable &&
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          !(signal as any)._hookMissingWarned &&
          signal.lastOutputAt > 0 &&
          Date.now() - signal.lastOutputAt < 30_000 &&
          signal.lastAlertAt > 0 &&
          Date.now() - signal.lastAlertAt > 60_000
        ) {
          log.warn("agent session has been active >60s with no hook event — hook may be misconfigured", {
            sessionId: payload.sessionId,
            agentLike: signal.agentLike,
          });
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (signal as any)._hookMissingWarned = true;
        }

        if (hooksEnabled) {
          // --- Hook-primary mode: suppress bell/silence, use 2min fallback ---
          // Record output time; the self-rescheduling timer checks this lazily
          // instead of cancel+restart on every PTY chunk.
          signal.lastOutputAt = Date.now();

          // Task sessions bypass the hasUserInput gate — the runner has its
          // own state machine and must be notified even if nothing has been
          // typed into the PTY yet (e.g. task started with no description,
          // waiting for the first idle so we can inject "read TASK.md").
          const isTaskSession = taskRunner.getIdleTimeout(payload.sessionId) != null;
          if (signal.busy && !inCooldown && (signal.hasUserInput || isTaskSession) && !signal.promptTimer) {
            const sid = payload.sessionId;
            signal.promptTimer = setTimeout(function hookFallbackCheck() {
              const silentFor = Date.now() - (signal.lastOutputAt || 0);
              if (silentFor < HOOK_FALLBACK_SILENCE_MS) {
                // Output arrived recently — reschedule for the remaining silence window
                signal.promptTimer = setTimeout(hookFallbackCheck, HOOK_FALLBACK_SILENCE_MS - silentFor);
                return;
              }
              signal.promptTimer = null;
              // Task runner intercept FIRST — task workspaces have their own
              // validation (WORK_LOCK, TODO checks) so they don't need the
              // idle-pattern guard.  Claude Code's statusbar line doesn't match
              // AGENT_IDLE_PATTERNS, which would block task detection otherwise.
              if (taskRunner.onAgentIdle(sid, "hook-fallback")) {
                log.info("hook-fallback silence: task runner handled idle", { sessionId: sid });
                return;
              }
              if (signal.lastOutputLine && !matchesAgentIdle(signal.lastOutputLine)) {
                log.trace("agent hook-primary fallback: last line not idle", {
                  sessionId: sid,
                  lastOutputLine: signal.lastOutputLine,
                });
                return;
              }
              if (isSessionVisible(sid)) {
                log.trace("agent hook-primary fallback: session visible, resetting", { sessionId: sid });
                resetSessionSignal(sid);
                return;
              }
              // Plan Phase 1 § 4.7: user was actively typing in this session
              // very recently — they are not gone, don't alert.
              if (isInInteractionGrace(signal, notifConfig)) {
                log.trace("agent hook-primary fallback: user interacted recently", { sessionId: sid });
                return;
              }
              if (!allowT3ForCommandClass(signal.commandClass)) {
                log.trace("agent hook-primary fallback: command class suppresses T3", {
                  sessionId: sid,
                  commandClass: signal.commandClass,
                });
                return;
              }
              log.info("agent hook-primary fallback: no hook arrived, raising T3 alert", {
                sessionId: sid,
                fallbackMs: HOOK_FALLBACK_SILENCE_MS,
              });
              raiseAlert({
                sessionId: sid,
                projectId: descriptor.workspaceId,
                panelId: descriptor.panelId,
                title: panel?.title || descriptor.panelId,
                kind: "waiting",
                tier: 3,
                urgency: "normal",
                detail: "hook-fallback",
              });
            }, HOOK_FALLBACK_SILENCE_MS);
          }
        } else {
          // --- No-hook fallback: bell + silence detection (original behavior) ---
          if (hasBell && !inCooldown && signal.hasUserInput) {
            cancelPromptTimer(signal);
            if (isSessionVisible(payload.sessionId)) {
              log.trace("bell: session visible, resetting", { sessionId: payload.sessionId });
              resetSessionSignal(payload.sessionId);
            } else {
              raiseWaitingAlert({
                sessionId: payload.sessionId,
                projectId: descriptor.workspaceId,
                panelId: descriptor.panelId,
                title: panel?.title || descriptor.panelId,
                detail: "explicit-input",
              });
            }
          } else {
            // Record output time; the self-rescheduling timer checks this lazily
            // instead of cancel+restart on every PTY chunk.
            signal.lastOutputAt = Date.now();

            const hookActive = signal.lastHookAlertAt > 0 && Date.now() - signal.lastHookAlertAt < 60_000;

            // Task sessions bypass hasUserInput — runner needs the idle tick
            // even without prior PTY input (e.g. description-less task waiting
            // for first idle to inject "read TASK.md").
            const providerIdleMs = taskRunner.getIdleTimeout(payload.sessionId);
            const isTaskSession = providerIdleMs != null;
            if (
              signal.busy &&
              !inCooldown &&
              (signal.hasUserInput || isTaskSession) &&
              !hookActive &&
              !signal.promptTimer
            ) {
              // Phase 3 § 3.2.6: adaptive multiplier reduces noise for
              // sessions the user keeps dismissing.
              // For task sessions, use the provider's idleTimeoutMs (e.g. 8s for
              // Codex/Gemini vs the global 20s agentQuietMs).
              const baseQuietMs =
                providerIdleMs != null
                  ? providerIdleMs
                  : signal.outputBursts >= AGENT_OUTPUT_BURST_THRESHOLD
                    ? notifConfig.agentQuietFastMs
                    : notifConfig.agentQuietMs;
              const quietMs = baseQuietMs * adaptiveMultiplier(payload.sessionId);
              const sid = payload.sessionId;
              signal.promptTimer = setTimeout(function silenceCheck() {
                const silentFor = Date.now() - (signal.lastOutputAt || 0);
                if (silentFor < quietMs) {
                  // Output arrived recently — reschedule for the remaining silence window
                  signal.promptTimer = setTimeout(silenceCheck, quietMs - silentFor);
                  return;
                }
                signal.promptTimer = null;
                // Task runner intercept FIRST (same rationale as hook-fallback path)
                if (taskRunner.onAgentIdle(sid, "silence")) {
                  log.info("agent silence: task runner handled idle", { sessionId: sid });
                  return;
                }
                if (signal.lastOutputLine && !matchesAgentIdle(signal.lastOutputLine)) {
                  log.trace("agent silence expired but last line not idle", {
                    sessionId: sid,
                    lastOutputLine: signal.lastOutputLine,
                  });
                  return;
                }
                if (isSessionVisible(sid)) {
                  log.trace("agent silence: session visible, resetting", { sessionId: sid });
                  resetSessionSignal(sid);
                  return;
                }
                if (isInInteractionGrace(signal, notifConfig)) {
                  log.trace("agent silence: user interacted recently, suppressing T3", { sessionId: sid });
                  return;
                }
                if (!allowT3ForCommandClass(signal.commandClass)) {
                  log.trace("agent silence: command class suppresses T3", {
                    sessionId: sid,
                    commandClass: signal.commandClass,
                  });
                  return;
                }
                if (isT3Disabled(sid)) {
                  log.trace("agent silence: T3 disabled by adaptive suppression", { sessionId: sid });
                  return;
                }
                // Phase 3 § 3.2.2: program was animating recently — not idle
                if (signal.lastAnimationAt > 0 && Date.now() - signal.lastAnimationAt < 2_000) {
                  log.trace("agent silence: animation still active, suppressing T3", { sessionId: sid });
                  return;
                }
                log.debug("agent silence timer triggering T3 alert", {
                  sessionId: sid,
                  quietMs,
                  lastOutputLine: signal.lastOutputLine,
                });
                raiseAlert({
                  sessionId: sid,
                  projectId: descriptor.workspaceId,
                  panelId: descriptor.panelId,
                  title: panel?.title || descriptor.panelId,
                  kind: "waiting",
                  tier: 3,
                  urgency: "normal",
                  detail: "prompt-returned",
                });
              }, quietMs);
            }
          }
        }
      } else if (!isShellAlertAllowed(signal, panel, state)) {
        // --- Non-agent shell session, agentsOnly suppresses ---
        // Skip prompt-pattern / WAITING_PATTERNS detection entirely. The user
        // doesn't want shell-completion pings on this panel. Still track
        // busy/output bookkeeping so exit-alert gating works correctly —
        // only alert raising is gated.
        if (cleanText.trim()) {
          signal.busy = true;
          cancelPromptTimer(signal);
        }
      } else {
        // --- Non-agent sessions: prompt-pattern detection ---
        // Plan Phase 1 § 4.1: end-of-line anchored WAITING_PATTERNS only.
        // Use the raw lastLine (with case) — patterns are /i anyway, and
        // lowercasing was belt-and-braces that hid nothing useful.
        const explicitWaiting = rawText.includes("\u0007") || matchesWaitingPattern(lastLine);
        const promptLike = matchesPrompt(lastLine);
        const onlyPrompt = promptLike && cleanText.trim() === lastLine.trim();

        if (cleanText.trim() && !onlyPrompt) {
          signal.busy = true;
          cancelPromptTimer(signal);
        }

        const now = Date.now();
        const inCooldown = signal.lastAlertAt > 0 && now - signal.lastAlertAt < notifConfig.alertCooldownMs;

        if (explicitWaiting && !inCooldown && signal.hasUserInput) {
          log.debug("explicit waiting pattern detected", { sessionId: payload.sessionId, lastLine });
          cancelPromptTimer(signal);
          if (isSessionVisible(payload.sessionId)) {
            resetSessionSignal(payload.sessionId);
          } else {
            // T2: pattern confirmation, not a silence heuristic.
            raiseAlert({
              sessionId: payload.sessionId,
              projectId: descriptor.workspaceId,
              panelId: descriptor.panelId,
              title: panel?.title || descriptor.panelId,
              kind: "waiting",
              tier: 2,
              urgency: "normal",
              detail: "explicit-input",
            });
          }
        } else if (promptLike && signal.busy && !inCooldown && signal.hasUserInput) {
          log.trace("prompt-like pattern detected, starting quiet timer", {
            sessionId: payload.sessionId,
            promptQuietMs: notifConfig.promptQuietMs,
            lastLine,
          });
          cancelPromptTimer(signal);
          const sid = payload.sessionId;
          signal.promptTimer = setTimeout(() => {
            signal.promptTimer = null;
            if (isSessionVisible(sid)) {
              log.trace("prompt quiet expired: session visible, resetting", { sessionId: sid });
              resetSessionSignal(sid);
              return;
            }
            if (isInInteractionGrace(signal, notifConfig)) {
              log.trace("prompt quiet: user interacted recently, suppressing T3", { sessionId: sid });
              return;
            }
            if (!allowT3ForCommandClass(signal.commandClass)) {
              log.trace("prompt quiet: command class suppresses T3", {
                sessionId: sid,
                commandClass: signal.commandClass,
              });
              return;
            }
            if (isT3Disabled(sid)) {
              log.trace("prompt quiet: T3 disabled by adaptive suppression", { sessionId: sid });
              return;
            }
            if (signal.lastAnimationAt > 0 && Date.now() - signal.lastAnimationAt < 2_000) {
              log.trace("prompt quiet: animation still active, suppressing T3", { sessionId: sid });
              return;
            }
            log.debug("prompt quiet timer triggering T3 alert", { sessionId: sid });
            raiseAlert({
              sessionId: sid,
              projectId: descriptor.workspaceId,
              panelId: descriptor.panelId,
              title: panel?.title || descriptor.panelId,
              kind: "waiting",
              tier: 3,
              urgency: "normal",
              detail: "prompt-returned",
            });
          }, notifConfig.promptQuietMs);
        }
      }
    }

    events.emit("terminal:data", payload);
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sessions.on("terminal:exit", (payload: any) => {
    log.debug("terminal:exit", {
      sessionId: payload.sessionId,
      exitCode: payload.exitCode,
      intentional: payload.intentional,
    });
    // Notify task runner of session exit
    taskRunner.onSessionExit(payload.sessionId);
    const descriptor = parseSessionId(payload.sessionId);
    const state = getState();
    const project = descriptor ? (findWorkspace(state, descriptor.workspaceId) as WorkspaceState | null) : null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const panel = (project as any)?.panels?.find((item: any) => item.id === descriptor?.panelId) || null;
    const signal = descriptor ? sessionSignals.get(payload.sessionId) : null;
    // Phase 2 § 3.2.4: exit alerts suppressed for shell class — shells exit
    // when the user types `exit` themselves; alerting is noise.
    const classAllowsExit = allowExitAlertForCommandClass(signal?.commandClass || "");
    const shouldRaiseAlert =
      !payload.intentional &&
      descriptor &&
      shouldTrackProjectAlert(project, panel) &&
      signal?.hasUserInput &&
      !isSessionVisible(payload.sessionId) &&
      classAllowsExit &&
      isShellAlertAllowed(signal, panel, state);
    if (shouldRaiseAlert) {
      raiseAlert({
        projectId: descriptor.workspaceId,
        panelId: descriptor.panelId,
        sessionId: payload.sessionId,
        title: panel?.title || descriptor.panelId,
        exitCode: payload.exitCode,
        kind: "completed",
        tier: 1,
        urgency: "normal",
        detail: `exit:${signal?.commandClass || "shell"}`,
      });
    }
    clearActivityFade(payload.sessionId);
    deleteSessionSignal(payload.sessionId);
    lastRateLimitAlertAt.delete(payload.sessionId);
    clearRateLimitSuspicion(payload.sessionId);
    events.emit("terminal:exit", payload);
    broadcastState();
  });

  docker.on("updated", () => {
    broadcastState();
  });

  git.on("updated", () => {
    broadcastState();
  });

  azure.on("updated", () => {
    broadcastState();
  });

  github.on("updated", () => {
    broadcastState();
  });

  tunnel.on("updated", () => {
    broadcastState();
  });

  // Detect external review bridge changes (MCP agents writing drafts).
  // Uses fs.watch for instant notification + PRAGMA data_version polling as reliable fallback.
  let reviewBridgeWatcher: FSWatcher | null = null;
  let reviewBridgeDebounce: ReturnType<typeof setTimeout> | null = null;
  let reviewBridgeDataVersion = reviewBridgeStore.getDataVersion?.() || 0;

  function onReviewBridgeChange() {
    if (reviewBridgeDebounce) clearTimeout(reviewBridgeDebounce);
    reviewBridgeDebounce = setTimeout(() => {
      reviewBridgeDebounce = null;
      reviewBridgeDataVersion = reviewBridgeStore.getDataVersion?.() || 0;
      broadcastState();
    }, 100);
  }

  // 1. fs.watch on signal file — instant but unreliable on Windows
  const reviewBridgeSignalPath = reviewBridgeStore.getSignalPath?.() || "";
  if (reviewBridgeSignalPath) {
    writeFile(reviewBridgeSignalPath, "0").catch(() => {});
    try {
      reviewBridgeWatcher = watch(reviewBridgeSignalPath, () => onReviewBridgeChange());
      reviewBridgeWatcher.on("error", () => {});
    } catch {
      // fs.watch not available
    }
  }

  // 2. PRAGMA data_version polling — reliable fallback, catches anything the watcher misses
  let reviewBridgePoll: ReturnType<typeof setInterval> | null = setInterval(() => {
    const currentVersion = reviewBridgeStore.getDataVersion?.() || 0;
    if (currentVersion !== reviewBridgeDataVersion) {
      onReviewBridgeChange();
    }
  }, 3000);

  async function refreshDocker() {
    return docker.refresh();
  }

  async function refreshGit(projectId: string | null = null) {
    git.invalidateSnapshotCache?.(projectId || null);
    const state = getState();
    const workspaces = state.workspaces.filter(
      (workspace) => (!projectId || workspace.id === projectId) && workspace.kind !== "azure",
    );
    return git.refreshWorkspaces ? git.refreshWorkspaces(workspaces) : git.refreshProjects(workspaces);
  }

  function resolveGitWorkspace(workspaceId: string | null = null, projectId: string | null = null): WorkspaceState {
    const targetWorkspaceId = workspaceId || projectId || getState().activeWorkspaceId || getState().activeProjectId;
    const workspace = findWorkspace(getState(), targetWorkspaceId as string) as WorkspaceState | null;
    if (!workspace?.cwd) {
      throw new Error("Workspace not found or has no working directory.");
    }
    return workspace;
  }

  function resolveGitRootPath(workspace: WorkspaceState, rootPath: string): string | null {
    const roots = workspace.gitRoots || [];
    if (!rootPath) {
      return roots[0] || "";
    }
    if (!roots.length) return rootPath; // single-repo, accept any rootPath
    if (roots.includes(rootPath)) return rootPath;
    // normalize comparison
    const normalized = rootPath.replace(/\\/g, "/").replace(/\/+$/, "");
    const match = roots.find((r: string) => r.replace(/\\/g, "/").replace(/\/+$/, "") === normalized);
    if (match) return match;
    return null; // rootPath not in gitRoots — reject
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async function runGitWorkspaceAction(workspace: WorkspaceState, actionPromise: Promise<any>) {
    const result = await actionPromise;
    await refreshGit(workspace.id);
    return {
      payload: getPayload(),
      result,
    };
  }

  const pendingWorktreeDeletions = new Set(); // paths being deleted — skip in syncWorktrees
  let syncWorktreesRunning = false;
  async function syncWorktrees() {
    if (syncWorktreesRunning) return false;
    syncWorktreesRunning = true;
    try {
      return await syncWorktreesImpl();
    } finally {
      syncWorktreesRunning = false;
    }
  }

  async function syncWorktreesImpl() {
    const state = getState();
    const parents = state.workspaces.filter(
      (workspace) =>
        !(workspace.notes || "").startsWith("Worktree of ") &&
        workspace.kind !== "azure" &&
        workspace.review?.provider !== "azure-devops",
    );
    const worktrees = state.workspaces.filter((w) => (w.notes || "").startsWith("Worktree of "));

    // Build parent lookup: treeDir → parent workspace
    // When multiple workspaces share the same cwd (across profiles),
    // prefer the one in the active profile so new worktrees land in
    // the correct sidebar section.
    const activeProfileId = state.activeProfileId || "default";
    const parentByTreeDir = new Map();
    for (const parent of parents) {
      if (!parent.cwd) continue;
      const treeDir = path.join(parent.cwd, ".strideterm", "tree");
      const existing = parentByTreeDir.get(treeDir);
      if (!existing || (parent.profileId || "default") === activeProfileId) {
        parentByTreeDir.set(treeDir, parent);
      }
    }

    const toAdd: WorkspaceState[] = [];
    const toRemove: string[] = [];
    const toRepair: Array<{ id: string; profileId: string }> = [];

    // Discover new worktrees on disk
    for (const [treeDir, parent] of parentByTreeDir) {
      let entries;
      try {
        entries = await readdir(treeDir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const treePath = path.join(treeDir, entry.name);
        if (pendingWorktreeDeletions.has(path.resolve(treePath))) continue;
        const existing = worktrees.find((w) => w.cwd === treePath);
        if (existing) {
          // Repair profileId if it drifted from parent
          if ((existing.profileId || "default") !== (parent.profileId || "default")) {
            toRepair.push({ id: existing.id, profileId: parent.profileId || "default" });
          }
          continue;
        }
        if (toAdd.some((w) => w.cwd === treePath)) continue;
        toAdd.push(
          normalizeWorkspace({
            id: `workspace-${randomUUID()}`,
            name: `${parent.name} / ${entry.name}`,
            icon: parent.icon,
            color: parent.color,
            kind: parent.kind,
            source: parent.source,
            pluginId: parent.pluginId,
            profileId: parent.profileId,
            cwd: treePath,
            notes: `Worktree of ${parent.name}`,
            activePanelId: "",
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            panels: parent.panels.map((p: any) => ({
              ...p,
              id: `panel-${randomUUID()}`,
            })),
          }),
        );
      }
    }

    // Remove worktrees whose directories no longer exist on disk
    for (const wt of worktrees) {
      if (!wt.cwd) continue;
      try {
        await access(wt.cwd);
      } catch {
        toRemove.push(wt.id);
      }
    }

    if (toAdd.length === 0 && toRemove.length === 0 && toRepair.length === 0) return false;

    await store.mutate((draft: AppState) => {
      if (toRemove.length > 0) {
        const removeSet = new Set(toRemove);
        draft.workspaces = draft.workspaces.filter((w) => !removeSet.has(w.id));
        if (removeSet.has(draft.activeWorkspaceId)) {
          const activeProfileId = draft.activeProfileId || "default";
          const fallback = draft.workspaces.find((w) => (w.profileId || "default") === activeProfileId);
          draft.activeWorkspaceId = fallback?.id || draft.workspaces[0]?.id || "";
        }
      }
      for (const repair of toRepair) {
        const ws = draft.workspaces.find((w) => w.id === repair.id);
        if (ws) ws.profileId = repair.profileId;
      }
      for (const workspace of toAdd) {
        draft.workspaces.push(workspace);
      }
    });

    return true;
  }

  function ensureDockerPolling() {
    if (dockerPoll) {
      return;
    }

    dockerPoll = setInterval(() => {
      refreshDocker().catch((error) => {
        log.warn("docker poll error", { err: error.message });
      });
    }, APP_CONFIG.runtime.dockerPollMs);
  }

  function ensureGitPolling() {
    if (gitPoll) {
      return;
    }

    gitPoll = setInterval(async () => {
      try {
        if (await syncWorktrees()) {
          sessions.syncWithState(getState());
          broadcastState();
        }
      } catch (error) {
        log.warn("worktree sync error", { err: (error as Error).message });
      }
    }, APP_CONFIG.runtime.gitPollMs);
  }

  // perf-4: fs.watch on .strideterm/tree/ per parent workspace
  // Debounced watcher map: treeDir → { watcher, debounceTimer }
  const treeDirWatchers = new Map();
  const TREE_WATCH_DEBOUNCE_MS = 500;

  function startTreeDirWatcher(treeDir: string) {
    if (treeDirWatchers.has(treeDir)) return;
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    try {
      const watcher = watch(treeDir, { persistent: false }, () => {
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(async () => {
          debounceTimer = null;
          try {
            if (await syncWorktrees()) {
              sessions.syncWithState(getState());
              broadcastState();
            }
          } catch {
            // Non-fatal
          }
        }, TREE_WATCH_DEBOUNCE_MS);
      });
      watcher.on("error", () => {
        treeDirWatchers.delete(treeDir);
      });
      treeDirWatchers.set(treeDir, {
        watcher,
        get debounceTimer() {
          return debounceTimer;
        },
      });
    } catch {
      // treeDir may not exist yet — polling backstop will catch it
    }
  }

  function stopTreeDirWatcher(treeDir: string) {
    const entry = treeDirWatchers.get(treeDir);
    if (entry) {
      try {
        entry.watcher.close();
      } catch {
        /* ignore */
      }
      treeDirWatchers.delete(treeDir);
    }
  }

  function syncTreeDirWatchers() {
    const state = getState();
    const parents = state.workspaces.filter(
      (ws) =>
        !(ws.notes || "").startsWith("Worktree of ") &&
        ws.kind !== "azure" &&
        ws.review?.provider !== "azure-devops" &&
        ws.cwd,
    );
    const activeDirs = new Set(parents.map((ws) => path.join(ws.cwd, ".strideterm", "tree")));
    // Stop watchers for removed parents
    for (const dir of treeDirWatchers.keys()) {
      if (!activeDirs.has(dir)) stopTreeDirWatcher(dir);
    }
    // Start watchers for new parents
    for (const dir of activeDirs) {
      if (!treeDirWatchers.has(dir)) startTreeDirWatcher(dir);
    }
  }

  const pluginManager = await createPluginManagerImpl({
    pluginsDir,
    builtinPluginsDir: builtinPluginsDir || null,
    runtime: null, // Will be set after construction
  });

  async function runInitialRefresh() {
    await refreshDocker();
    // perf-1: eager refresh only the active workspace; background-refresh the rest
    const activeId = getState().activeWorkspaceId;
    if (activeId) {
      await refreshGit(activeId);
    } else {
      await refreshGit();
    }
    await refreshAzure();
    scheduleAzurePolling();
    await refreshGitHub();
    scheduleGitHubPolling();
    await syncWorktrees();
    await tunnel.refreshAvailability();

    // Background: inspect remaining workspaces so they don't block first render
    if (activeId) {
      queueMicrotask(async () => {
        const others = getState().workspaces.filter(
          (ws) => ws.id !== activeId && ws.kind !== "azure" && ws.kind !== "github",
        );
        for (const ws of others) {
          try {
            await refreshGit(ws.id);
            broadcastState();
          } catch {
            // Non-fatal — background refresh; user can click Refresh if needed
          }
          await new Promise((r) => setImmediate(r));
        }
      });
    }
  }

  await ensureNotifyScript(userDataPath).catch(() => {});
  await startAgentNotifyServer();
  ensureDockerPolling();
  ensureGitPolling();
  syncTreeDirWatchers();
  if (deferInitialRefresh) {
    scheduleAzurePolling();
    scheduleGitHubPolling();
    runInitialRefresh()
      .then(() => {
        ensureVisibleSession();
        broadcastState();
      })
      .catch((error) => {
        log.warn("initial refresh error", { err: error.message });
        broadcastState();
      });
  } else {
    await runInitialRefresh();
  }

  // Deferred version check — runs 10s after startup, non-blocking.
  setTimeout(() => {
    versionChecker
      .checkForUpdates()
      .then(() => broadcastState())
      .catch(() => {});
  }, 10_000);

  // --- Extracted handler groups ---
  const gitHandlers = createGitHandlers({
    git,
    store,
    getPayload,
    broadcastState,
    refreshGit,
    resolveGitWorkspace,
    resolveGitConnection,
    resolveGitRootPath,
    runGitWorkspaceAction,
    syncWorktrees: async () => {
      await syncWorktrees();
    },
  });

  const sshHandlers = createSshHandlers({ sshManager, store, credentialStore, broadcastState });

  const providerHandlers = createProviderHandlers({
    log,
    getState,
    store,
    azure,
    github,
    git,
    sessions,
    credentialStore,
    auditLogStore,
    githubAuditLogStore,
    azureReviewStore,
    reviewBridgeStore,
    getPayload,
    broadcastState,
    refreshAzure,
    refreshGitHub,
    refreshGit,
    ensureAzureWorkspace,
    ensureGitHubWorkspace,
    ensureVisibleSession,
    scheduleAzurePolling,
    scheduleGitHubPolling,
    resolveGitWorkspace,
    resolveGitRootPath,
    getAzureSettings,
    getAzureConnections,
    getGitHubSettings,
    getGitHubConnections,
  });

  return {
    ...providerHandlers,
    ...gitHandlers,
    ...sshHandlers,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    on(channel: any, handler: any) {
      events.on(channel, handler);
      return () => events.off(channel, handler);
    },
    getPayload,
    getRemoteInfo() {
      return remoteInfo;
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    setRemoteInfo(nextRemoteInfo: any) {
      remoteInfo = nextRemoteInfo;
      broadcastState();
    },
    async getInitialState() {
      try {
        if (findWorkspace(getState(), getState().activeWorkspaceId)?.kind === "docker") {
          await refreshDocker();
        }
        await refreshGit(getState().activeWorkspaceId);
        await syncWorktrees();
        ensureVisibleSession();
        const payload = getPayload();
        log.info("initial state ready", { workspaceCount: payload.appState?.workspaces?.length ?? 0 });
        return payload;
      } catch (error) {
        log.error("getInitialState failed", { err: (error as Error).message });
        throw error;
      }
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async activateWorkspace(workspaceId: any) {
      await store.mutate((draft: AppState) => {
        if (draft.workspaces.some((workspace) => workspace.id === workspaceId)) {
          draft.activeWorkspaceId = workspaceId;
        }
      });
      // Proactively update visible sessions BEFORE starting terminals,
      // so terminal startup output doesn't trigger false alerts
      const workspace = findWorkspace(getState(), workspaceId);
      if (workspace) {
        updateVisibleSessions(
          workspace.kind === "azure" || workspace.kind === "github"
            ? []
            : // eslint-disable-next-line @typescript-eslint/no-explicit-any -- MIGRATION-EXEMPT: panel type is widened in this workspace variant
              workspace.panels.map((panel: any) => createSessionId(workspaceId, panel.id)),
        );
      }
      if (workspace?.kind === "docker") {
        await refreshDocker();
      }
      await refreshGit(workspaceId);
      ensureVisibleSession(workspaceId);
      broadcastState();
      return getPayload();
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async activateProject(projectId: any) {
      return this.activateWorkspace(projectId);
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async activateSession(sessionId: any) {
      const descriptor = parseSessionId(sessionId);
      if (!descriptor) {
        return getPayload();
      }

      await store.mutate((draft: AppState) => {
        const workspace = findWorkspace(draft, descriptor.workspaceId);
        if (!workspace) {
          return;
        }

        draft.activeWorkspaceId = descriptor.workspaceId;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        if ((workspace as any).panels?.some((panel: any) => panel.id === descriptor.panelId)) {
          workspace.activePanelId = descriptor.panelId;
          workspace.activeViewId = sessionId;
        }
      });

      sessions.ensureSession(getState(), sessionId);
      broadcastState();
      return getPayload();
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async setWorkspaceUIState(workspaceId: any, uiState: any) {
      if (!workspaceId || !uiState || typeof uiState !== "object") {
        return getPayload();
      }
      const { activeViewId, splitLayout, splitViewIds, activeRootPath } = uiState;
      let changed = false;
      await store.mutate((draft: AppState) => {
        const workspace = findWorkspace(draft, workspaceId);
        if (!workspace) return;
        if (typeof activeViewId === "string") {
          workspace.activeViewId = activeViewId;
          const sessionPrefix = `${workspaceId}:`;
          if (activeViewId.startsWith(sessionPrefix)) {
            const panelId = activeViewId.slice(sessionPrefix.length);
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            if ((workspace as any).panels?.some((panel: any) => panel.id === panelId)) {
              workspace.activePanelId = panelId;
            }
          }
          changed = true;
        }
        if (splitLayout === null || typeof splitLayout === "string") {
          workspace.splitLayout = splitLayout || null;
          workspace.splitViewIds = Array.isArray(splitViewIds) ? [...splitViewIds] : [];
          changed = true;
        }
        if (typeof activeRootPath === "string") {
          workspace.activeRootPath = activeRootPath;
          changed = true;
        }
      });
      if (changed) broadcastState();
      return getPayload();
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async saveWorkspace(workspace: any) {
      // Ensure the working directory exists (create if needed)
      if (workspace.cwd && workspace.kind !== "docker") {
        await mkdir(workspace.cwd, { recursive: true }).catch(() => {});
      }

      await store.mutate((draft: AppState) => {
        const normalized = normalizeWorkspace(workspace);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const index = draft.workspaces.findIndex((item: any) => item.id === normalized.id);
        if (index >= 0) {
          draft.workspaces[index] = normalized;
        } else {
          // Insert child workspaces right after their parent instead of at the end
          const parentId =
            normalized.task?.parentWorkspaceId ||
            normalized.review?.parentWorkspaceId ||
            normalized.quickfix?.parentWorkspaceId ||
            "";
          const parentIdx = parentId ? draft.workspaces.findIndex((item) => item.id === parentId) : -1;
          if (parentIdx >= 0) {
            // Find last consecutive child of this parent to insert after the group
            let insertAt = parentIdx + 1;
            while (insertAt < draft.workspaces.length) {
              const ws = draft.workspaces[insertAt];
              const wsParent =
                ws.task?.parentWorkspaceId || ws.review?.parentWorkspaceId || ws.quickfix?.parentWorkspaceId || "";
              if (wsParent !== parentId) break;
              insertAt++;
            }
            draft.workspaces.splice(insertAt, 0, normalized);
          } else {
            draft.workspaces.push(normalized);
          }
        }

        if (!draft.activeWorkspaceId) {
          draft.activeWorkspaceId = normalized.id;
        }
      });

      sessions.syncWithState(getState());
      syncSessionSignalsWithState();
      await refreshGit(workspace.id || null);
      ensureVisibleSession();
      broadcastState();
      refreshAzure().catch(() => {});
      return getPayload();
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async saveProject(project: any) {
      return this.saveWorkspace(project);
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async deleteWorkspace(workspaceId: any, options: any = {}) {
      const state = getState();
      const workspace = findWorkspace(state, workspaceId);

      // Clean up task runner files for task workspaces
      if (workspace?.kind === "task" && workspace.task?.taskId && workspace.cwd) {
        taskRunner.stopTask(workspaceId);
        await taskRunner.cleanupTaskFiles(workspace.cwd, workspace.task.taskId);
      }

      await store.mutate((draft: AppState) => {
        draft.workspaces = draft.workspaces.filter((item) => item.id !== workspaceId);
        if (draft.activeWorkspaceId === workspaceId) {
          draft.activeWorkspaceId = draft.workspaces[0]?.id || "";
        }
      });

      const sessionsExited = sessions.removeWorkspaceSessions(workspaceId);
      for (const sessionId of [...sessionSignals.keys()]) {
        if (sessionId.startsWith(`${workspaceId}:`)) {
          clearActivityFade(sessionId);
          deleteSessionSignal(sessionId);
        }
      }
      clearProjectAlerts(workspaceId);
      ensureVisibleSession();
      broadcastState();

      // Delete worktree files from disk if requested
      let diskDeleteError = "";
      if (options.deleteFromDisk && workspace) {
        const allowedPaths = [workspace.review?.checkout?.rootPath, workspace.cwd, workspace.quickfix?.rootPath]
          .map((p) => (p ? path.resolve(String(p).trim()) : ""))
          .filter(Boolean);
        const requestedPath = path.resolve(String(options.diskPath || allowedPaths[0] || "").trim());
        const diskPath = allowedPaths.includes(requestedPath) ? requestedPath : "";
        if (diskPath && path.isAbsolute(diskPath)) {
          pendingWorktreeDeletions.add(diskPath);
          try {
            await sessionsExited;
            // Short delay for Windows NTFS to release file handles after PTY exit.
            // macOS/Linux release handles synchronously on process exit — no delay needed.
            if (process.platform === "win32") {
              await new Promise((resolve) => setTimeout(resolve, 200));
            }

            const cacheRepoPath = workspace.review?.checkout?.cacheRepoPath || "";
            // Task worktrees store the base repo path explicitly
            const taskWorktreeBase = workspace.task?.worktreeBase || "";
            // workspace.cwd is like /repo/.strideterm/tree/branch-name — 3 levels up to repo root
            const mainWorktreePath = workspace.cwd ? path.resolve(workspace.cwd, "..", "..", "..") : "";
            const gitCwd = cacheRepoPath || taskWorktreeBase || mainWorktreePath;
            let gitRemoved = false;
            if (gitCwd) {
              try {
                await execFileTextImpl("git", ["worktree", "remove", "--force", diskPath], { cwd: gitCwd });
                gitRemoved = true;
              } catch {}
              // Prune doesn't need to block — it just cleans up stale admin refs
              execFileTextImpl("git", ["worktree", "prune"], { cwd: gitCwd }).catch(() => {});
            }

            if (!gitRemoved) {
              await rmPath(diskPath);
            }
          } catch (err) {
            diskDeleteError = `Could not delete ${diskPath}: ${(err as any)?.message || err}`; // eslint-disable-line @typescript-eslint/no-explicit-any -- MIGRATION-EXEMPT: unknown catch shape
            log.warn("workspace disk delete failed", { diskPath, err: diskDeleteError });
          } finally {
            pendingWorktreeDeletions.delete(diskPath);
          }
        }
      }

      await refreshGit();
      ensureVisibleSession();
      broadcastState();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result: any = getPayload();
      if (diskDeleteError) {
        result.deleteWorkspaceError = diskDeleteError;
      }
      return result;
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async deleteProject(projectId: any) {
      return this.deleteWorkspace(projectId);
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async reorderWorkspaces(workspaceIds: any) {
      await store.mutate((draft: AppState) => {
        draft.workspaces = workspaceIds
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          .map((id: any) => draft.workspaces.find((workspace) => workspace.id === id))
          .filter(Boolean);
      });

      broadcastState();
      return getPayload();
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async reorderProjects(projectIds: any) {
      return this.reorderWorkspaces(projectIds);
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async updateSettings(settings: any) {
      const previousConfig = getState().settings.remoteAccess;
      await store.mutate((draft: AppState) => {
        if (settings.tabTemplates) {
          draft.tabTemplates = settings.tabTemplates;
        }
        draft.settings = {
          ...draft.settings,
          ...settings,
          remoteAccess: {
            ...draft.settings.remoteAccess,
            ...(settings.remoteAccess || {}),
          },
          notifications: {
            ...draft.settings.notifications,
            ...(settings.notifications || {}),
          },
          git: {
            ...draft.settings.git,
            ...(settings.git || {}),
            ui: {
              ...(draft.settings.git?.ui || {}),
              ...(settings.git?.ui || {}),
            },
          },
        };
        // Keep tabTemplates out of the settings object
        delete (draft.settings as any).tabTemplates; // eslint-disable-line @typescript-eslint/no-explicit-any -- MIGRATION-EXEMPT: immer draft index signature
      });

      const nextConfig = getState().settings.remoteAccess;
      tunnel.setBinaryPreference?.(nextConfig.cloudflaredPath || "");
      const remoteAccessChanged = JSON.stringify(previousConfig) !== JSON.stringify(nextConfig);
      const tunnelTargetChanged = previousConfig.port !== nextConfig.port || previousConfig.host !== nextConfig.host;
      if (remoteAccessChanged) {
        events.emit("remote:config-changed", clone(nextConfig));
      }
      if (!nextConfig.enabled) {
        await tunnel.stop({ preserveAvailability: true, quiet: true });
      } else if (tunnel.getSnapshot().status === "connected" && tunnelTargetChanged) {
        await tunnel.startQuickTunnel(await ensureRemoteOriginReady(nextConfig));
      }
      if (
        previousConfig.cloudflaredPath !== nextConfig.cloudflaredPath &&
        tunnel.getSnapshot().status !== "connected"
      ) {
        await tunnel.refreshAvailability();
      }

      // Apply log level change at runtime
      const newLogLevel = getState().settings?.logLevel;
      if (newLogLevel) {
        setLogLevel(newLogLevel);
      }

      // Start/stop notify server based on agentHook setting
      const agentHookEnabled = getState().settings?.notifications?.agentHook !== false;
      if (agentHookEnabled && !notifyServerHandle) {
        await startAgentNotifyServer();
      } else if (!agentHookEnabled && notifyServerHandle) {
        await stopAgentNotifyServer();
      }

      broadcastState();
      return { payload: getPayload(), remoteAccessChanged };
    },
    // Azure, GitHub, and Review Bridge handlers provided by providerHandlers (spread above)

    async regenerateRemoteToken() {
      await store.mutate((draft: AppState) => {
        draft.settings.remoteAccess.token = createAccessToken();
      });

      events.emit("remote:config-changed", clone(getState().settings.remoteAccess));
      broadcastState();
      return getPayload();
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    closeSession(sessionId: any) {
      clearAlertSession(sessionId);
      clearActivityFade(sessionId);
      deleteSessionSignal(sessionId);
      sessions.removeSession(sessionId);
      broadcastState();
      return getPayload();
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    resizeSession(sessionId: any, size: any) {
      sessions.resizeSession(sessionId, size.cols, size.rows);
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    writeToSession(sessionId: any, data: any) {
      resetSessionSignal(sessionId);
      const signal = sessionSignals.get(sessionId);
      if (signal && !signal.hasUserInput) {
        log.debug("first user input recorded", { sessionId });
      }
      if (signal) {
        signal.hasUserInput = true;
        // Plan Phase 1 § 4.7: records the moment of active user engagement
        // with THIS session. Detector uses it to suppress T3 alerts within
        // the grace window (userInteractionGraceMs).
        signal.lastUserInteractionAt = Date.now();
        // Phase 2 § 3.2.4: accumulate keystrokes so we can classify the
        // command when Enter is pressed. Filter control characters — we
        // only care about the command text itself.
        updateCommandClassFromInput(signal, data);
        // Phase 3 § 3.2.6: active user interaction resets adaptive counter
        adaptiveRecordInteraction(sessionId);
      }
      // Pause task runner only on real typing — mouse clicks and focus events
      // emit escape sequences too (e.g. \x1b[<0;x;yM) and would otherwise pause
      // the task just because the user clicked into the panel to watch.
      if (hasMeaningfulUserInput(data)) {
        taskRunner.onUserInput(sessionId);
      }
      const descriptor = parseSessionId(sessionId);
      if (descriptor) {
        const current = projectAlerts.get(descriptor.workspaceId);
        const alert = current?.alerts?.find((a) => a.panelId === descriptor.panelId);
        if (alert && Date.now() - new Date(alert.at).getTime() >= ATTENTION_MIN_DISPLAY_MS) {
          clearProjectAlerts(descriptor.workspaceId, descriptor.panelId);
          broadcastState();
        }
      }
      sessions.writeToSession(sessionId, data);
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    notifyAgentHook(sessionId: any, notificationType = "idle_prompt", hook = "Notification") {
      log.debug("notifyAgentHook called", { sessionId, hook, notificationType });
      dispatchAgentHookEvent({
        sessionId,
        hook,
        subtype: notificationType,
        notificationType,
        payload: {},
      });
    },
    async configureClaudeHook() {
      return configureClaudeHook(userDataPath);
    },
    async removeClaudeHook() {
      return removeClaudeHook();
    },
    async getClaudeHookStatus() {
      return detectClaudeHookStatus(userDataPath);
    },
    async configureGeminiHook() {
      return configureGeminiHook(userDataPath);
    },
    async removeGeminiHook() {
      return removeGeminiHook();
    },
    async getGeminiHookStatus() {
      return detectGeminiHookStatus(userDataPath);
    },
    async configureCodexHook() {
      return configureCodexHook(userDataPath);
    },
    async removeCodexHook() {
      return removeCodexHook();
    },
    async getCodexHookStatus() {
      return detectCodexHookStatus(userDataPath);
    },
    async configureCopilotHook() {
      return configureCopilotHook(userDataPath);
    },
    async removeCopilotHook() {
      return removeCopilotHook();
    },
    async getCopilotHookStatus() {
      return detectCopilotHookStatus(userDataPath);
    },
    async configureOpencodeHook() {
      return configureOpencodeHook(userDataPath);
    },
    async removeOpencodeHook() {
      return removeOpencodeHook();
    },
    async getOpencodeHookStatus() {
      return detectOpencodeHookStatus(userDataPath);
    },
    /**
     * Expose notification-pipeline metrics for the About dialog / diagnostics.
     * Pure read — returns a snapshot.
     */
    getNotificationMetrics() {
      return getMetrics();
    },
    /**
     * End-to-end probe of a notification hook pipeline (Claude or Gemini).
     *
     * Spawns the installed notify.mjs with synthetic stdin containing a
     * probe UUID. Waits up to 2s for the dispatcher to receive it.
     * Returns { ok, elapsedMs?, reason?, logTail? }.
     *
     * Provider-neutral — both Claude and Gemini use the same notify.mjs;
     * this helper just needs a detect/configure pair for the requested
     * provider.
     */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async runHookProbe({ detectStatus, configure }: { detectStatus: any; configure: any }) {
      const status = await detectStatus(userDataPath);
      if (status.status === "error") {
        return { ok: false, reason: "config-error", detail: status.error };
      }
      if (status.status !== "configured") {
        const cfg = await configure(userDataPath);
        if (!cfg.ok) return { ok: false, reason: "configure-failed", detail: cfg.error };
      }

      if (!notifyServerHandle) await startAgentNotifyServer();
      if (!notifyServerHandle) return { ok: false, reason: "notify-server-unavailable" };

      const probeId = randomUUID();
      const probeSessionId = `probe:${probeId}`;
      const probeUrl = buildNotifyUrl(notifyServerHandle.port, probeSessionId, notifySecret);

      const receivedPromise = new Promise((resolve) => {
        hookProbeListeners.set(probeId, resolve);
        setTimeout(() => {
          if (hookProbeListeners.has(probeId)) {
            hookProbeListeners.delete(probeId);
            resolve({ ok: false, reason: "timeout" });
          }
        }, 2000);
      });

      // Override STRIDETERM_NOTIFY_URL so the probe doesn't rely on
      // CLAUDE_PROJECT_DIR / notify-urls.json resolution.
      const scriptPath = path.join(userDataPath, "hooks", "notify.mjs");
      const startedAt = Date.now();
      let spawnError: Error | null = null;
      try {
        const child = spawn(process.execPath, [scriptPath, "Notification"], {
          env: {
            ...process.env,
            ELECTRON_RUN_AS_NODE: "1",
            STRIDETERM_NOTIFY_URL: probeUrl,
            CLAUDE_PROJECT_DIR: "",
          },
          stdio: ["pipe", "ignore", "ignore"],
        });
        child.on("error", (err) => {
          spawnError = err;
        });
        child.stdin.write(JSON.stringify({ notification_type: "probe", probe_id: probeId }));
        child.stdin.end();
      } catch (err) {
        hookProbeListeners.delete(probeId);
        return { ok: false, reason: "spawn-failed", detail: (err as Error).message };
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- MIGRATION-EXEMPT: untyped probe result from dynamic hook spawn
      const result = (await receivedPromise) as any;
      const elapsedMs = Date.now() - startedAt;

      if (result?.ok) return { ok: true, elapsedMs };
      if (spawnError) {
        return { ok: false, reason: "spawn-error", detail: (spawnError as Error).message, elapsedMs };
      }

      // Timeout — surface hook.log tail so the user can see what happened.
      let logTail = "";
      try {
        const logPath = path.join(userDataPath, "logs", "hook.log");
        const raw = await readFile(logPath, "utf8");
        logTail = raw.split("\n").slice(-10).join("\n");
      } catch {
        /* no log yet */
      }
      return { ok: false, reason: "timeout", elapsedMs, logTail };
    },
    async testClaudeHook() {
      return this.runHookProbe({ detectStatus: detectClaudeHookStatus, configure: configureClaudeHook });
    },
    async testGeminiHook() {
      return this.runHookProbe({ detectStatus: detectGeminiHookStatus, configure: configureGeminiHook });
    },
    async testCodexHook() {
      return this.runHookProbe({ detectStatus: detectCodexHookStatus, configure: configureCodexHook });
    },
    async testCopilotHook() {
      return this.runHookProbe({ detectStatus: detectCopilotHookStatus, configure: configureCopilotHook });
    },
    async testOpencodeHook() {
      return this.runHookProbe({ detectStatus: detectOpencodeHookStatus, configure: configureOpencodeHook });
    },
    /**
     * Clear a single session's alert entry. Called from the notification
     * center when the user clicks Jump or Dismiss — without this, the tab
     * badge stays lit after the UI-side notification is removed.
     * Plan § 3.3.3.
     *
     * @param {string} sessionId
     * @param {Object} [options]
     * @param {boolean} [options.dismissed=false]
     *   true  → user clicked "Dismiss" (no engagement). Feeds adaptive
     *           suppression (§ 3.2.6) so a session that keeps getting
     *           dismissed without interaction goes quieter on its own.
     *   false → user clicked "Jump" or alert auto-cleared. Treated as
     *           engagement — resets the adaptive dismiss counter.
     */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    clearAlertForSession(sessionId: any, { dismissed = false } = {}) {
      if (!sessionId) return getPayload();
      const descriptor = parseSessionId(sessionId);
      if (!descriptor) return getPayload();
      log.debug("clearAlertForSession", { sessionId, dismissed });
      clearProjectAlerts(descriptor.workspaceId, descriptor.panelId);
      resetSessionSignal(sessionId);
      if (dismissed) {
        adaptiveRecordDismissed(sessionId);
        metricsRecordDismissed();
      } else {
        adaptiveRecordInteraction(sessionId);
      }
      broadcastState();
      return getPayload();
    },
    clearAllAttention() {
      log.debug("clearing all attention alerts");
      projectAlerts.clear();
      const now = Date.now();
      for (const [, signal] of sessionSignals) {
        cancelPromptTimer(signal);
        signal.busy = false;
        signal.waitingRaised = false;
        signal.lastOutputAt = 0;
        signal.lastAlertAt = now;
      }
      broadcastState();
      return getPayload();
    },
    syncAttentionContext({
      visibleSessionIds = [],
      windowFocused = true,
    }: { visibleSessionIds?: string[]; windowFocused?: boolean } = {}) {
      const nextIds = (Array.isArray(visibleSessionIds) ? visibleSessionIds : [])
        .map((sessionId) => String(sessionId || "").trim())
        .filter(Boolean);
      updateVisibleSessions(nextIds);

      // Phase 2 § 3.2.5: if the window is focused, a visible session counts
      // as active user interaction — updates lastUserInteractionAt so
      // silence timers for other (also visible) sessions don't fire as the
      // user scrolls between tabs.
      if (windowFocused) {
        const now = Date.now();
        for (const sid of nextIds) {
          const signal = sessionSignals.get(sid);
          if (signal) signal.lastUserInteractionAt = now;
        }
      }

      // Clear alerts for visible sessions that have been shown long enough
      const now = Date.now();
      let changed = false;
      for (const sessionId of attentionContext.visibleSessionIds) {
        const descriptor = parseSessionId(sessionId);
        if (!descriptor) continue;
        const current = projectAlerts.get(descriptor.workspaceId);
        const alert = current?.alerts?.find((a) => a.panelId === descriptor.panelId);
        if (alert && now - new Date(alert.at).getTime() >= ATTENTION_MIN_DISPLAY_MS) {
          clearProjectAlerts(descriptor.workspaceId, descriptor.panelId);
          resetSessionSignal(sessionId);
          changed = true;
        }
      }
      if (changed) broadcastState();

      return getPayload();
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async restartSession(sessionId: any) {
      const descriptor = parseSessionId(sessionId);
      await store.mutate((draft: AppState) => {
        if (!descriptor) {
          return;
        }

        const workspace = findWorkspace(draft, descriptor.workspaceId);
        if (!workspace) {
          return;
        }

        draft.activeWorkspaceId = descriptor.workspaceId;
        workspace.activePanelId = descriptor.panelId;
      });

      await sessions.restartSession(getState(), sessionId);
      if (descriptor) {
        clearProjectAlerts(descriptor.workspaceId, descriptor.panelId);
      }
      resetSessionSignal(sessionId);
      broadcastState();
      return getPayload();
    },
    async refreshDockerState() {
      await refreshDocker();
      return getPayload();
    },
    // Git handlers provided by gitHandlers (spread above)

    async refreshTunnelState() {
      await tunnel.refreshAvailability();
      return getPayload();
    },
    async createCloudflareTunnel() {
      const remoteConfig = getState().settings.remoteAccess;
      if (!remoteConfig.enabled) {
        throw new Error("Enable LAN remote access before creating a Cloudflare tunnel.");
      }

      await tunnel.startQuickTunnel(await ensureRemoteOriginReady(remoteConfig));
      return getPayload();
    },
    async stopCloudflareTunnel() {
      await tunnel.stop({ preserveAvailability: true });
      return getPayload();
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async dockerAction(action: any, containerId: any) {
      const allowedActions = new Set(["start", "stop", "restart", "remove"]);
      if (!allowedActions.has(action)) {
        throw new Error(`Invalid Docker action: ${action}`);
      }
      await docker.performAction(action, containerId);
      return getPayload();
    },
    async openDockerSession({
      workspaceId,
      projectId,
      containerId,
      mode,
    }: {
      workspaceId?: any; // eslint-disable-line @typescript-eslint/no-explicit-any -- MIGRATION-EXEMPT: IPC payload, typed migration pending
      projectId: any; // eslint-disable-line @typescript-eslint/no-explicit-any -- MIGRATION-EXEMPT: IPC payload, typed migration pending
      containerId: any; // eslint-disable-line @typescript-eslint/no-explicit-any -- MIGRATION-EXEMPT: IPC payload, typed migration pending
      mode: any; // eslint-disable-line @typescript-eslint/no-explicit-any -- MIGRATION-EXEMPT: IPC payload, typed migration pending
    }) {
      const targetWorkspaceId = workspaceId || projectId;
      await refreshDocker();
      const container = docker.findContainer(containerId);
      if (!container) {
        throw new Error("Docker container not found.");
      }

      const launch = mode === "logs" ? docker.createLogsLaunch(containerId) : docker.createShellLaunch(containerId);
      if (!launch) {
        throw new Error("Docker backend is not available.");
      }

      const panelId = `${mode}-${containerId}`;
      const title = mode === "logs" ? `${container.Names} logs` : `${container.Names} shell`;
      const description =
        mode === "logs" ? `docker logs -f ${container.Names}` : `docker exec -it ${container.Names} sh`;

      await store.mutate((draft: AppState) => {
        const workspace = findWorkspace(draft, targetWorkspaceId);
        if (!workspace) {
          throw new Error("Docker workspace not found.");
        }

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const existing = (workspace as any).panels?.find((panel: any) => panel.id === panelId);
        const nextPanel = {
          id: panelId,
          title,
          command: description,
          launch,
          shell: true,
          startup: APP_CONFIG.ui.manualPanelStartup,
        };

        if (existing) {
          Object.assign(existing, nextPanel);
        } else {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (workspace as any).panels?.push(nextPanel);
        }

        draft.activeWorkspaceId = targetWorkspaceId;
        workspace.activePanelId = panelId;
      });

      sessions.syncWithState(getState());
      sessions.ensureSession(getState(), createSessionId(targetWorkspaceId, panelId));
      clearProjectAlerts(targetWorkspaceId, panelId);
      broadcastState();
      return getPayload();
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async openLazydockerSession({ workspaceId, projectId }: { workspaceId?: any; projectId: any }) {
      const targetWorkspaceId = workspaceId || projectId;
      await refreshDocker();
      const launch = docker.createLazydockerLaunch();
      if (!launch) {
        throw new Error("Lazydocker is not available in the active Docker environment.");
      }

      const panelId = "lazydocker";
      await store.mutate((draft: AppState) => {
        const workspace = findWorkspace(draft, targetWorkspaceId);
        if (!workspace) {
          throw new Error("Docker workspace not found.");
        }

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const existing = (workspace as any).panels?.find((panel: any) => panel.id === panelId);
        const nextPanel = {
          id: panelId,
          title: "Lazydocker",
          command: "lazydocker",
          launch,
          shell: true,
          startup: APP_CONFIG.ui.manualPanelStartup,
        };

        if (existing) {
          Object.assign(existing, nextPanel);
        } else {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (workspace as any).panels?.push(nextPanel);
        }

        draft.activeWorkspaceId = targetWorkspaceId;
        workspace.activePanelId = panelId;
      });

      sessions.syncWithState(getState());
      sessions.ensureSession(getState(), createSessionId(targetWorkspaceId, panelId));
      clearProjectAlerts(targetWorkspaceId, panelId);
      broadcastState();
      return getPayload();
    },
    async openLazygitSession({
      workspaceId,
      projectId,
      rootPath,
    }: {
      workspaceId?: any; // eslint-disable-line @typescript-eslint/no-explicit-any -- MIGRATION-EXEMPT: IPC payload, typed migration pending
      projectId: any; // eslint-disable-line @typescript-eslint/no-explicit-any -- MIGRATION-EXEMPT: IPC payload, typed migration pending
      rootPath: any; // eslint-disable-line @typescript-eslint/no-explicit-any -- MIGRATION-EXEMPT: IPC payload, typed migration pending
    }) {
      const targetWorkspaceId = workspaceId || projectId;
      await refreshGit(targetWorkspaceId);
      const launch = git.createLazygitLaunch(targetWorkspaceId, rootPath || null);
      if (!launch) {
        throw new Error("Lazygit is not available for this workspace.");
      }

      const panelId = "lazygit";
      await store.mutate((draft: AppState) => {
        const workspace = findWorkspace(draft, targetWorkspaceId);
        if (!workspace) {
          throw new Error("Workspace not found.");
        }

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const existing = (workspace as any).panels?.find((panel: any) => panel.id === panelId);
        const nextPanel = {
          id: panelId,
          title: "Lazygit",
          command: "lazygit",
          launch,
          shell: true,
          startup: APP_CONFIG.ui.manualPanelStartup,
        };

        if (existing) {
          Object.assign(existing, nextPanel);
        } else {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (workspace as any).panels?.push(nextPanel);
        }

        draft.activeWorkspaceId = targetWorkspaceId;
        workspace.activePanelId = panelId;
      });

      sessions.syncWithState(getState());
      sessions.ensureSession(getState(), createSessionId(targetWorkspaceId, panelId));
      clearProjectAlerts(targetWorkspaceId, panelId);
      broadcastState();
      return getPayload();
    },
    async createWorktree({
      workspaceId,
      projectId,
      name,
      rootPath,
    }: {
      workspaceId?: any; // eslint-disable-line @typescript-eslint/no-explicit-any -- MIGRATION-EXEMPT: IPC payload, typed migration pending
      projectId: any; // eslint-disable-line @typescript-eslint/no-explicit-any -- MIGRATION-EXEMPT: IPC payload, typed migration pending
      name: any; // eslint-disable-line @typescript-eslint/no-explicit-any -- MIGRATION-EXEMPT: IPC payload, typed migration pending
      rootPath?: any; // eslint-disable-line @typescript-eslint/no-explicit-any -- MIGRATION-EXEMPT: IPC payload, typed migration pending
    }) {
      const targetWorkspaceId = workspaceId || projectId;
      if (!name || !/^[a-zA-Z0-9._-]+$/.test(name)) {
        throw new Error("Worktree name must contain only alphanumeric characters, dots, hyphens, or underscores.");
      }
      const project = findWorkspace(getState(), targetWorkspaceId);
      if (!project?.cwd) throw new Error("Workspace has no working directory");

      // Multi-repo: a rootPath must be chosen. Single-repo: fall back to workspace cwd.
      const normalizePath = (p: string) =>
        String(p || "")
          .replace(/\\/g, "/")
          .replace(/\/+$/, "");
      const gitRoots = Array.isArray(project.gitRoots) ? project.gitRoots.filter(Boolean) : [];
      let repoPath = rootPath || "";
      if (gitRoots.length >= 2) {
        if (!repoPath) {
          throw new Error("Multi-repo workspace requires a repository to be selected for the worktree.");
        }
        const normRepo = normalizePath(repoPath);
        const normRoots = gitRoots.map(normalizePath);
        if (!normRoots.includes(normRepo) && normRepo !== normalizePath(project.cwd)) {
          throw new Error(`Selected repository ${repoPath} is not part of this workspace.`);
        }
      } else if (!repoPath) {
        repoPath = project.cwd;
      }

      const treePath = path.join(repoPath, ".strideterm", "tree", name);

      // Ensure .strideterm/ in .gitignore (inside the chosen repo)
      const gitignorePath = path.join(repoPath, ".gitignore");
      let gitignoreContent = "";
      try {
        gitignoreContent = await readFile(gitignorePath, "utf-8");
      } catch {}
      if (!gitignoreContent.split(/\r?\n/).some((line) => line.trim() === ".strideterm/")) {
        const separator = gitignoreContent.length && !gitignoreContent.endsWith("\n") ? "\n" : "";
        await writeFile(gitignorePath, gitignoreContent + separator + ".strideterm/\n", "utf-8");
      }

      // Ensure directory exists for worktree
      await mkdir(path.dirname(treePath), { recursive: true });

      // git worktree add — run inside the chosen repo root, not the workspace parent
      await execFileTextImpl("git", ["worktree", "add", treePath, "-b", name], { cwd: repoPath });

      // Create subproject cloning parent panels
      const newProject = normalizeWorkspace({
        id: `workspace-${randomUUID()}`,
        name: `${project.name} / ${name}`,
        icon: project.icon,
        color: project.color,
        kind: project.kind,
        source: project.source,
        pluginId: project.pluginId,
        profileId: project.profileId,
        connectionId: project.connectionId || "",
        cwd: treePath,
        notes: `Worktree of ${project.name}`,
        activePanelId: "",
        panels:
          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- MIGRATION-EXEMPT: project is server state JSON, typed migration pending
          (project as any).panels?.map((p: any) => ({
            ...p,
            id: `panel-${randomUUID()}`,
          })) || [],
      });

      await store.mutate((draft: AppState) => {
        // Insert worktree right after parent (and any existing sibling worktrees)
        const parentIndex = draft.workspaces.findIndex((w) => w.id === targetWorkspaceId);
        if (parentIndex >= 0) {
          const prefix = project.name + " / ";
          let insertAt = parentIndex + 1;
          while (
            insertAt < draft.workspaces.length &&
            draft.workspaces[insertAt].name.startsWith(prefix) &&
            (draft.workspaces[insertAt].notes || "").startsWith("Worktree of ")
          ) {
            insertAt++;
          }
          draft.workspaces.splice(insertAt, 0, newProject);
        } else {
          draft.workspaces.push(newProject);
        }
        draft.activeWorkspaceId = newProject.id;
      });

      sessions.syncWithState(getState());
      await refreshGit(newProject.id);
      ensureVisibleSession();
      broadcastState();
      refreshAzure().catch(() => {});
      return getPayload();
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async saveProfile(profile: any) {
      await store.mutate((draft: AppState) => {
        const index = draft.profiles.findIndex((p) => p.id === profile.id);
        const normalized = {
          id: profile.id || `profile-${randomUUID()}`,
          name: profile.name || "Unnamed",
          color: profile.color || "#ffa424",
          workspaceIds: Array.isArray(profile.workspaceIds)
            ? profile.workspaceIds
            : Array.isArray(profile.projectIds)
              ? profile.projectIds
              : [],
        };
        if (index >= 0) {
          draft.profiles[index] = normalized;
        } else {
          draft.profiles.push(normalized);
        }
      });
      broadcastState();
      return getPayload();
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async deleteProfile(profileId: any) {
      await store.mutate((draft: AppState) => {
        draft.profiles = draft.profiles.filter((p) => p.id !== profileId);
        if (draft.profiles.length === 0) {
          draft.profiles.push({ id: "default", name: "Default", color: "#6366f1", workspaceIds: [] });
        }
        if (draft.activeProfileId === profileId) {
          draft.activeProfileId = draft.profiles[0]?.id || "default";
        }
      });
      broadcastState();
      return getPayload();
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async activateProfile(profileId: any) {
      await store.mutate((draft: AppState) => {
        if (draft.profiles.some((p) => p.id === profileId)) {
          draft.activeProfileId = profileId;
          // Set activeWorkspaceId to first workspace in new profile (or null)
          const profileWorkspaces = draft.workspaces.filter((w) => (w.profileId || "default") === profileId);
          const firstId = profileWorkspaces[0]?.id || "";
          draft.activeWorkspaceId = firstId;
          draft.activeProjectId = firstId;
        }
      });
      await syncWorktrees();
      sessions.syncWithState(getState());
      ensureVisibleSession();
      await refreshAzure();
      scheduleAzurePolling();
      broadcastState();
      return getPayload();
    },
    getPlugins() {
      return pluginManager.getPlugins();
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    getPluginWorkspaceTemplate(pluginId: any) {
      return pluginManager.getWorkspaceTemplate(pluginId);
    },
    async stop() {
      log.info("runtime shutting down");
      // Stop the notify server first so no new callbacks arrive
      // while we clear session signals below.
      await stopAgentNotifyServer();
      for (const signal of sessionSignals.values()) {
        cancelPromptTimer(signal);
      }
      sessionSignals.clear();
      if (dockerPoll) {
        clearInterval(dockerPoll);
        dockerPoll = null;
      }
      if (gitPoll) {
        clearInterval(gitPoll);
        gitPoll = null;
      }
      if (reviewBridgeWatcher) {
        reviewBridgeWatcher.close();
        reviewBridgeWatcher = null;
      }
      if (reviewBridgePoll) {
        clearInterval(reviewBridgePoll);
        reviewBridgePoll = null;
      }
      azure.stopPolling();
      github.stopPolling();
      await tunnel.stop({ preserveAvailability: true, quiet: true });
      await pluginManager.stopAll();
      sessions.stopAll();
      await reviewBridgeStore.close?.();
      auditLogStore.close?.();
      githubAuditLogStore.close?.();
      gitAuditLogStore.close?.();
      // State is already persisted on each mutate/replace operation.
      // Avoid rewriting the file on shutdown, which can overwrite newer
      // on-disk state if another instance touched it more recently.
      return undefined;
    },
    listRemoteUrls() {
      return remoteInfo?.urls || [];
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    getSessionId(workspaceId: any, panelId: any) {
      return createSessionId(workspaceId, panelId);
    },
    async checkForUpdates() {
      const result = await versionChecker.checkForUpdates(true);
      broadcastState();
      return result;
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async checkCommand(command: any) {
      try {
        const cmd = process.platform === "win32" ? "where" : "which";
        await execFileText(cmd, [command], { timeout: 5000 });
        return true;
      } catch (err) {
        log.debug("checkCommand: not found", {
          command,
          err: (err as any)?.error?.message || (err as Error).message || "unknown", // eslint-disable-line @typescript-eslint/no-explicit-any -- MIGRATION-EXEMPT: error shape is unknown at catch boundary
        });
        return false;
      }
    },

    // --- Task runner API ---
    async recheckClaude() {
      const available = await recheckClaudeAvailability();
      return { available, payload: getPayload() };
    },
    async checkProviders() {
      const results: Record<string, unknown> = {};
      for (const ProviderClass of getAllProviders()) {
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          results[(ProviderClass as any).id] = await new (ProviderClass as any)().checkAvailability();
        } catch (err) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          results[(ProviderClass as any).id] = { available: false, error: (err as Error).message };
        }
      }
      return results;
    },
    // Lightweight probe used by the task workspace dialog to decide whether
    // "Create in git worktree" makes sense for the chosen cwd. Treats any
    // failure (non-existent path, not a git repo, git CLI missing) as
    // "not a repo" — the caller just wants a boolean to gate the checkbox.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async checkIsGitRepo(cwd: any) {
      const trimmed = String(cwd || "").trim();
      if (!trimmed) return { isGitRepo: false, reason: "empty" };
      try {
        const { stdout } = await execFileTextImpl("git", ["rev-parse", "--is-inside-work-tree"], { cwd: trimmed });
        return { isGitRepo: stdout.trim() === "true" };
      } catch (err) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const stderr = (err as any)?.stderr?.trim() || (err as any)?.error?.message || "";
        if (stderr.includes("not a git repository")) return { isGitRepo: false, reason: "not-a-repo" };
        // Could not even run git — treat as "unknown" so the dialog stays
        // permissive rather than blocking based on a transient failure.
        return { isGitRepo: false, reason: "error", error: stderr || "unknown error" };
      }
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async probeDirectory(cwd: any) {
      const trimmed = String(cwd || "").trim();
      if (!trimmed) return { path: "", isGitRepo: false, childRepos: [], scannedDepth: 0, truncated: false };
      const { probeDirectory: probe } = await import("./fs-probe.js");
      return probe(trimmed);
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async createTaskWorkspace(config: any) {
      log.info("createTaskWorkspace", {
        cwd: config.cwd,
        hasDescription: !!config.description,
        useWorktree: !!config.useWorktree,
      });
      const state = getState();

      let effectiveCwd = config.cwd;
      let worktreeBase = "";
      let worktreeBranch = "";

      // --- Git worktree mode ---
      if (config.useWorktree) {
        const branch = (config.worktreeBranch || "").trim();
        if (!branch || !/^[a-zA-Z0-9._/-]+$/.test(branch)) {
          throw new Error(
            "Worktree branch name must contain only alphanumeric characters, dots, hyphens, slashes, or underscores.",
          );
        }
        // The flat segment used for the directory name (replace / with -)
        const dirName = branch.replace(/\//g, "-");
        const treePath = path.join(config.cwd, ".strideterm", "tree", dirName);

        // Ensure .strideterm/ in .gitignore
        const gitignorePath = path.join(config.cwd, ".gitignore");
        let gitignoreContent = "";
        try {
          gitignoreContent = await readFile(gitignorePath, "utf-8");
        } catch {}
        if (!gitignoreContent.split(/\r?\n/).some((line) => line.trim() === ".strideterm/")) {
          const separator = gitignoreContent.length && !gitignoreContent.endsWith("\n") ? "\n" : "";
          await writeFile(gitignorePath, gitignoreContent + separator + ".strideterm/\n", "utf-8");
        }

        // Ensure parent directory exists
        await mkdir(path.dirname(treePath), { recursive: true });

        // Create the git worktree with a new branch
        try {
          await execFileTextImpl("git", ["worktree", "add", treePath, "-b", branch], { cwd: config.cwd });
        } catch (err) {
          // execFileText rejects with { error, stdout, stderr } — the useful
          // message lives in stderr. err.message is undefined here, so don't
          // rely on it for either the branch-exists fallback or the user error.
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const stderr = (err as any)?.stderr?.trim() || (err as any)?.error?.message || (err as Error).message || "";
          if (stderr.includes("already exists")) {
            await execFileTextImpl("git", ["worktree", "add", treePath, branch], { cwd: config.cwd });
          } else if (stderr.includes("not a git repository")) {
            // Most common user mistake — surface a clear, actionable message.
            throw new Error(
              `"${config.cwd}" is not a git repository. Initialize with \`git init\` there, or disable "Use git worktree" in the task dialog.`,
              { cause: err },
            );
          } else {
            throw new Error(`Failed to create git worktree: ${stderr || "unknown error"}`, { cause: err });
          }
        }

        worktreeBase = config.cwd;
        worktreeBranch = branch;
        effectiveCwd = treePath;
        log.info("createTaskWorkspace: worktree created", { treePath, branch, base: config.cwd });
      }

      // Check for other task workspaces with the same effective cwd that are currently active
      const normalizedCwd = String(effectiveCwd || "")
        .replace(/[\\/]+$/, "")
        .toLowerCase();
      const conflicting = state.workspaces.filter(
        (ws) =>
          ws.kind === "task" &&
          ws.task &&
          ws.task.state !== "idle" &&
          String(ws.cwd || "")
            .replace(/[\\/]+$/, "")
            .toLowerCase() === normalizedCwd,
      );
      let cwdWarning = "";
      if (conflicting.length > 0) {
        cwdWarning = `Another task workspace ("${conflicting[0].name}") is active on the same directory. Running both may cause conflicts with tests and file operations.`;
        log.warn("createTaskWorkspace: duplicate cwd detected", {
          cwd: effectiveCwd,
          conflictingWorkspaces: conflicting.map((ws) => ws.id),
        });
      }

      const workspace = taskRunner.createTaskWorkspace({
        state,
        description: config.description,
        cwd: effectiveCwd,
        parentWorkspaceId: config.parentWorkspaceId,
        maxRounds: config.maxRounds,
        name: config.name,
        icon: config.icon,
        color: config.color,
        notes: config.notes,
        workerCommand: config.workerCommand,
        judgeCommand: config.judgeCommand,
        workerProvider: config.workerProvider,
        judgeProvider: config.judgeProvider,
      });

      // Store worktree metadata in task object
      if (worktreeBase) {
        workspace.task.worktreeBase = worktreeBase;
        workspace.task.worktreeBranch = worktreeBranch;
      }

      // Inherit gitRoots for non-worktree tasks running inside a multi-repo parent workspace
      if (Array.isArray(config.gitRoots) && config.gitRoots.length >= 2 && !config.useWorktree) {
        workspace.gitRoots = config.gitRoots;
      }

      // Write task files immediately so they're available in the Dashboard.
      // If this fails (disk full, permissions), don't persist a broken workspace.
      try {
        await taskRunner.writeInitialFiles(workspace.cwd, workspace.task);
      } catch (err) {
        log.error("createTaskWorkspace: failed to write initial task files", {
          workspaceId: workspace.id,
          cwd: workspace.cwd,
          err: (err as Error).message,
        });
        throw new Error(`Failed to create task files: ${(err as Error).message}`, { cause: err });
      }
      // saveWorkspace normalizes and persists
      await this.saveWorkspace(workspace);
      // Activate the new workspace
      await this.activateWorkspace(workspace.id);
      return { workspaceId: workspace.id, cwdWarning, payload: getPayload() };
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async startTask(workspaceId: any) {
      const result = await taskRunner.startTask(workspaceId);
      return { ok: result, payload: getPayload() };
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    stopTask(workspaceId: any) {
      const result = taskRunner.stopTask(workspaceId);
      return { ok: result, payload: getPayload() };
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    pauseTask(workspaceId: any) {
      const result = taskRunner.pauseTask(workspaceId);
      return { ok: result, payload: getPayload() };
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    resumeTask(workspaceId: any) {
      const result = taskRunner.resumeTask(workspaceId);
      return { ok: result, payload: getPayload() };
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async resetTask(workspaceId: any) {
      const result = await taskRunner.resetTask(workspaceId);
      return { ok: result, payload: getPayload() };
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async rejectTaskVerdict(workspaceId: any, feedback: any) {
      const result = await taskRunner.rejectTaskVerdict(workspaceId, feedback);
      return { ok: result, payload: getPayload() };
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    getTaskStatus(workspaceId: any) {
      return taskRunner.getTaskState(workspaceId);
    },
  };
}
