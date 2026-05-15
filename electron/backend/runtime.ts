/// <reference types="node" />
import http from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { watch, readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from "node:fs";
import type { FSWatcher } from "node:fs";
import { readFile, writeFile, mkdir, readdir, access, rm, rename } from "node:fs/promises";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { createStore } from "./store.js";
import * as fm from "./file-manager.js";
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
import { TelegramManager } from "./telegram-manager.js";
import { resolveTelegramTaskTarget } from "./telegram-task-resolution.js";
import { resolveWindowIdForTelegramCommand } from "./telegram-window-resolver.js";
import { createTelegramAuditLogStore } from "./telegram-audit-log-store.js";
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
import { buildRecoveryPrompt } from "./agent-task-prompts.js";
import type { RecoveryCandidate } from "../shared/types/state.js";
import { updateTaskDescriptionFile } from "./agent-task-files.js";
import { getProvider, getAllProviders } from "./providers/provider-registry.js";
import { classifyHookEvent } from "./notifications/classifier.js";
import type { RemoteClientRegistry } from "./remote-client-registry.js";
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

  /**
   * Returns a PNG buffer of the current Electron window. Wired in main.ts via
   * `mainWindow.webContents.capturePage().toPNG()`. Optional — Telegram
   * `📸 Screenshot` falls back to an error message if not provided (e.g. in
   * the headless remote-only build or in tests). Workspace-targeted captures
   * just call activateWorkspace before invoking this.
   */
  captureMainWindowPng?: (windowId?: string) => Promise<Buffer>;

  /** Emit alert:navigate to the window that owns `profileId` (§4.2). */
  navigateWindowToAlert?: (workspaceId: string, panelId: string, profileId: string) => void;
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

  // Forward reference populated at the end of createRuntime() so async
  // handlers (e.g. Telegram command dispatch) can call runtime methods.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let _rt: any = null;

  // Injected by startRemoteServer after the HTTP server starts.
  let _remoteClientRegistry: RemoteClientRegistry | null = null;

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

  // Forward-declare plugin manager so getPayload() can read it safely even
  // when broadcastState() fires via queueMicrotask during the createRuntime
  // bootstrap (e.g. "logger reconfigured from stored settings" triggers a
  // broadcast while the `await createPluginManagerImpl(...)` below is still
  // pending). Declaring as `const` further down causes a TDZ ReferenceError
  // in those microtasks; a `let` initialized to null lets the nullish check
  // in getPayload do its job until the real manager is assigned.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let pluginManager: any = null;

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
      const t0 = Date.now();
      try {
        await execFileTextImpl("cmd.exe", ["/c", "rd", "/s", "/q", dirPath], { timeout: 30_000 });
        log.debug("rmPath: rd /s /q succeeded", { dirPath, ms: Date.now() - t0 });
        return;
      } catch (err) {
        // rd failed (e.g. locked files, long paths) — fall through to fs.rm with retries
        log.debug("rmPath: rd /s /q failed, falling back to fs.rm", {
          dirPath,
          ms: Date.now() - t0,
          err: (err as Error)?.message?.slice(0, 200) || String(err),
        });
      }
    }

    const retryDelays = [300, 600, 1200];
    for (let attempt = 0; attempt <= retryDelays.length; attempt++) {
      const t0 = Date.now();
      try {
        await rm(dirPath, { recursive: true, force: true });
        log.debug("rmPath: fs.rm succeeded", { dirPath, attempt, ms: Date.now() - t0 });
        return;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (attempt < retryDelays.length && (code === "EBUSY" || code === "EPERM")) {
          log.debug("rmPath: fs.rm hit lock, retrying", {
            dirPath,
            attempt,
            code,
            ms: Date.now() - t0,
            backoffMs: retryDelays[attempt],
          });
          await new Promise((resolve) => setTimeout(resolve, retryDelays[attempt]));
          continue;
        }
        log.debug("rmPath: fs.rm gave up", {
          dirPath,
          attempt,
          code,
          ms: Date.now() - t0,
          err: (err as Error)?.message?.slice(0, 200),
        });
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

  // Populated after taskRunner.init() — see below.
  let _recoveryCandidates: RecoveryCandidate[] = [];

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

  /** Write the shared file atomically via tmp+rename to prevent torn writes. */
  function writeNotifyUrls(data: Record<string, string[]>): void {
    const dir = path.dirname(notifyUrlsPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const tmpPath = `${notifyUrlsPath}.tmp-${process.pid}-${randomUUID()}`;
    writeFileSync(tmpPath, JSON.stringify(data, null, 2), "utf8");
    renameSync(tmpPath, notifyUrlsPath);
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

  // --- Telegram integration ---
  const telegramAuditLogDbPath = path.join(reviewBridgeRoot, "telegram-audit-log.db");
  const telegramAuditLogStore = createTelegramAuditLogStore(telegramAuditLogDbPath);
  const telegramManager = new TelegramManager({ credentialStore, auditLogStore: telegramAuditLogStore });
  telegramManager.setWorkspacesGetter(() =>
    getState().workspaces.map((ws: WorkspaceState) => {
      // Worktree children (created via "Open as worktree") look top-level in
      // the state model — they have no parentWorkspaceId and a kind that's
      // not "task"/"review" — but they are semantically children of their
      // base workspace and live inside its `.strideterm/tree/<branch>` dir.
      // For Telegram /task purposes we treat them like other children so
      // they don't show up as task parent candidates (worktree-of-worktree
      // nesting is confusing and almost never desired).
      const isWorktreeChild = (ws.notes || "").startsWith("Worktree of ");
      return {
        id: ws.id,
        name: ws.name,
        cwd: ws.cwd || "",
        kind: ws.kind || "workspace",
        profileId: ws.profileId || "default",
        notes: ws.notes || "",
        parentWorkspaceId:
          ws.task?.parentWorkspaceId ||
          ws.review?.parentWorkspaceId ||
          ws.quickfix?.parentWorkspaceId ||
          (isWorktreeChild ? "__worktree__" : ""),
        panels: (ws.panels || []).map((p) => ({ id: p.id, title: p.title || p.id })),
        task: ws.task ? { state: ws.task.state || "unknown", description: ws.task.description || "" } : null,
        starred: !!ws.starred,
      };
    }),
  );
  // Use first open window slot's profileId rather than the deprecated global activeProfileId.
  telegramManager.setActiveProfileGetter(() => (getState().windowSlots || [])[0]?.profileId || "default");
  telegramManager.setProfilesGetter(() =>
    (getState().profiles || []).map((p) => ({ id: p.id, name: p.name, color: p.color })),
  );
  telegramManager.setWindowSlotsGetter(() =>
    (getState().windowSlots || []).map((s) => ({ id: s.id, profileId: s.profileId })),
  );
  telegramManager.setPrInfosGetter(() => {
    const state = getState();
    const azurePrs = Object.entries(azure.getSnapshot()?.pullRequests || {}).map(
      ([prKey, summary]: [string, unknown]) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const pr = summary as any;
        const wsId =
          pr?.reviewWorkspaceId ||
          pr?.existingWorkspaceId ||
          state.workspaces.find((w: WorkspaceState) => w.kind === "azure")?.id ||
          "azure";
        return {
          prKey,
          provider: "azure-devops" as const,
          connectionId: pr?.connectionId || "",
          workspaceId: wsId,
          title: pr?.pullRequest?.title || prKey,
          hasAttention: !!pr?.hasAttention,
          attentionReason: pr?.attentionReason || "",
          checksFailedCount: pr?.checks?.failedCount || 0,
          checksPendingCount: pr?.checks?.pendingCount || 0,
          webUrl: pr?.pullRequest?.url || "",
        };
      },
    );
    const githubPrs = Object.entries(github.getSnapshot()?.pullRequests || {}).map(
      ([prKey, summary]: [string, unknown]) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const pr = summary as any;
        const wsId =
          pr?.reviewWorkspaceId ||
          pr?.existingWorkspaceId ||
          state.workspaces.find((w: WorkspaceState) => w.kind === "github")?.id ||
          "github";
        return {
          prKey,
          provider: "github" as const,
          connectionId: pr?.connectionId || "",
          workspaceId: wsId,
          title: pr?.pullRequest?.title || prKey,
          hasAttention: !!pr?.hasAttention,
          attentionReason: pr?.attentionReason || "",
          checksFailedCount: pr?.checks?.failedCount || 0,
          checksPendingCount: pr?.checks?.pendingCount || 0,
          webUrl: pr?.pullRequest?.webUrl || "",
        };
      },
    );
    return [...azurePrs, ...githubPrs];
  });

  // Expose the live LAN/Cloudflare URLs to the Telegram /tunnel command. The
  // remote server pushes URL snapshots via setRemoteInfo as it (re)binds, and
  // tunnel.getSnapshot() carries the current Cloudflare quick-tunnel state.
  // Both are read on demand so /tunnel always reports the latest state.
  telegramManager.setTunnelInfoGetter(() => {
    const state = getState();
    const remote = state.settings?.remoteAccess || {};
    const tunnelSnap = tunnel.getSnapshot();
    const remoteUrls: string[] = Array.isArray(remoteInfo?.urls) ? (remoteInfo!.urls as string[]) : [];
    return {
      remoteEnabled: !!remote.enabled,
      lanUrls: remoteUrls.filter((u) => typeof u === "string" && u.length > 0),
      cloudflareUrl: tunnelSnap?.publicUrl || "",
      remoteToken: remote.token || "",
      cloudflareStatus: tunnelSnap?.status || "idle",
      tunnelMode: APP_CONFIG.tunnel?.mode || "off",
    };
  });

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

  // Tell the file-manager which `rootPath` values are legitimate. Without
  // this hook safePath() rejects every fs request, which is the right
  // default — but here we expose the set of paths the user has actually
  // opened (workspace cwds + any git/review/quickfix roots tied to those
  // workspaces). Anything outside is refused even with a valid token.
  fm.setAllowedRootsResolver(() => {
    const roots: string[] = [];
    for (const ws of getState().workspaces || []) {
      if (ws.cwd) roots.push(ws.cwd);
      if (Array.isArray(ws.gitRoots)) roots.push(...ws.gitRoots.filter(Boolean));
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const review = (ws as any).review?.checkout?.rootPath;
      if (review) roots.push(review);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const quickfix = (ws as any).quickfix?.rootPath;
      if (quickfix) roots.push(quickfix);
    }
    return roots;
  });

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
    signal: { agentLike?: boolean } | null | undefined,

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

    // --- 1. Record on signal (for hook gating in detector) ---
    const state = getState();
    const project = findWorkspace(state, descriptor.workspaceId) as WorkspaceState | null;
    const panel = project?.panels.find((p) => p.id === descriptor.panelId) || null;
    const signal = getSessionSignal(sessionId, project, panel);
    signal.hookCapable = true;
    if (hook === "Notification" || hook === "Stop" || hook === "SubagentStop") {
      signal.completionHookCapable = true;
    }
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
    // Include connections for every profile that is open in some window.
    // Using only windowSlots[0] hid the connection a user just saved when
    // they were in a non-primary window (e.g. saving on profile "asdf" while
    // windowSlots[0] is "default" — `getAzureConnections` returned [] and
    // the snapshot showed "No Azure DevOps connections yet" in every window,
    // even though the connection persisted to disk).
    const openProfileIds = new Set(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (state.windowSlots || []).map((s: any) => String(s?.profileId || "default")),
    );
    if (openProfileIds.size === 0) return all;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return all.filter((c: any) => openProfileIds.has(String(c.profileId || "default")));
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
    // See getAzureConnections for why we union over all open windowSlot
    // profiles rather than just slot[0].
    const openProfileIds = new Set(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (state.windowSlots || []).map((s: any) => String(s?.profileId || "default")),
    );
    if (openProfileIds.size === 0) return all;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return all.filter((c: any) => openProfileIds.has(String(c.profileId || "default")));
  }

  function getTelegramSettings(state = getState()) {
    return (
      state.settings?.integrations?.telegram || {
        enabled: true,
        defaultPollSeconds: 5,
        connections: [],
      }
    );
  }

  function getTelegramConnections(state = getState()) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (getTelegramSettings(state).connections || []) as any[];
  }

  function reconfigureTelegram(state = getState()) {
    const settings = getTelegramSettings(state);
    telegramManager.stop();
    if (!settings.enabled) {
      telegramManager.configure([]);
      return;
    }
    telegramManager.configure(getTelegramConnections(state));
    telegramManager.start();
  }

  /**
   * Return all provider connections (Azure DevOps, GitHub, and future GitLab)
   * visible to any profile currently open in some window. Used for the
   * payload's connection listing — the renderer filters this further by
   * its own window's profile when building the picker.
   *
   * Do NOT use for resolving the connection for a specific workspace's git
   * op — use getProviderConnectionsForProfile(workspace.profileId) instead.
   * Filtering by windowSlots[0]?.profileId (the previous behavior) silently
   * dropped connections that belonged to a non-primary window's profile.
   */
  function getAllProviderConnections(state = getState()) {
    return [...getAzureConnections(state), ...getGitHubConnections(state)];
  }

  /**
   * Return provider connections owned by `profileId`. Right scope for
   * authenticated git operations: a workspace's connection must come from
   * the SAME profile as the workspace, never from "whichever profile happens
   * to be in windowSlots[0]".
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function getProviderConnectionsForProfile(state: AppState, profileId: string): any[] {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const match = (c: any) => (c.profileId || "default") === profileId;
    const azureConns = (getAzureSettings(state).connections || []).filter(match);
    const githubConns = (getGitHubSettings(state).connections || []).filter(match);
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
    const profileId = String(workspace?.profileId || "default");
    const connections = getProviderConnectionsForProfile(getState(), profileId);
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
    raiseAlert: raiseAlertBase,
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

  // Wrap raiseAlert to forward to Telegram and route §4.2 alert navigation.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function raiseAlert(opts: any): boolean {
    const raised = raiseAlertBase(opts);
    if (raised) {
      const state = getState();
      const workspace = state.workspaces.find((w) => w.id === opts.projectId);
      const panel = workspace?.panels.find((p) => p.id === opts.panelId);
      telegramManager
        .forwardAlert({
          alertId: opts.sessionId || `${opts.projectId}:${opts.panelId}`,
          workspaceId: opts.projectId || "",
          panelId: opts.panelId || "",
          workspaceName: workspace?.name || opts.projectId || "",
          panelTitle: panel?.title || opts.panelId || "",
          kind: opts.kind || "info",
          urgency: opts.urgency || "normal",
          title: opts.title || "",
          detail: opts.detail || "",
          workspaceProfileId: (workspace as { profileId?: string } | undefined)?.profileId || "default",
        })
        .catch((err) => {
          log.warn("telegram forwardAlert from raiseAlert failed", {
            kind: opts.kind,
            workspaceId: opts.projectId,
            err: (err as Error).message,
          });
        });
      // §4.2: emit alert:navigate to the window that owns this workspace's profile
      if (opts.projectId && opts.panelId && dependencies.navigateWindowToAlert) {
        const profileId = (workspace as { profileId?: string } | undefined)?.profileId || "default";
        dependencies.navigateWindowToAlert(opts.projectId, opts.panelId, profileId);
      }
    }
    return raised;
  }

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
        recoveryCandidates: _recoveryCandidates,
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
          // profileId is required so the renderer can scope the connection
          // picker to the window's own profile — without it, every window
          // sees the same flat list and a user in profile B could pick a
          // profile-A connection that then fails to resolve at op time.
          profileId: String(c.profileId || "default"),
        })),
      },
      azureDevops: azure.getSnapshot(),
      github: github.getSnapshot(),
      telegram: telegramManager.getSnapshot(),
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
      // Surface OS-keychain availability so Settings can show a banner when
      // we're falling back to base64-on-disk for credentials. The user
      // needs to *see* the downgrade — a one-shot log warning isn't enough,
      // because most users never tail strideterm.log.
      secureStorage: {
        available:
          typeof credentialStore.isEncryptionAvailable === "function" ? credentialStore.isEncryptionAvailable() : true,
      },
    };
  }

  // Dedup of PR keys already forwarded to Telegram is owned by TelegramManager
  // (bounded LRU). Runtime just asks via hasForwardedPr / markPrForwarded.

  function checkAndForwardPrNotificationsToTelegram(): void {
    if (telegramManager.getSnapshot().connections.length === 0) return;
    const state = getState();
    const azureSnapshot = azure.getSnapshot();
    const githubSnapshot = github.getSnapshot();

    // Check Azure PRs with attention
    for (const [prKey, summary] of Object.entries(azureSnapshot?.pullRequests || {})) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const pr = summary as any;
      if (!pr?.hasAttention || telegramManager.hasForwardedPr(prKey)) continue;
      telegramManager.markPrForwarded(prKey);
      // The connection's own profile is the authoritative source — fall
      // back to a profile-scoped Azure inbox only when the PR summary
      // doesn't carry profileId yet (legacy snapshots before the fix).
      // Picking the first state.workspaces match silently routes alerts
      // to whatever inbox sorts first when both profiles host one.
      const prProfileIdHint = (pr?.profileId as string | undefined) || "";
      const azureInboxForProfile = prProfileIdHint
        ? state.workspaces.find(
            (w: WorkspaceState) => w.kind === "azure" && (w.profileId || "default") === prProfileIdHint,
          )
        : null;
      const azureWorkspace = azureInboxForProfile || state.workspaces.find((w: WorkspaceState) => w.kind === "azure");
      // Use review or existing workspace so auto-review can walk up to the parent cwd
      const prWorkspaceId = pr?.reviewWorkspaceId || pr?.existingWorkspaceId || azureWorkspace?.id || "azure";
      const prTitle = pr?.pullRequest?.title || prKey;
      log.info("telegram: forwarding Azure PR notification", { prKey, connectionId: pr?.connectionId });
      const azurePrWs = state.workspaces.find((w) => w.id === prWorkspaceId);
      const azurePrProfileId =
        prProfileIdHint ||
        (azurePrWs as { profileId?: string } | undefined)?.profileId ||
        (azureWorkspace as { profileId?: string } | undefined)?.profileId ||
        "default";
      telegramManager
        .forwardAlert({
          alertId: prKey,
          workspaceId: prWorkspaceId,
          panelId: "inbox",
          workspaceName: azureWorkspace?.name || "Azure DevOps",
          panelTitle: "Inbox",
          kind: "review",
          urgency: "normal",
          title: `PR Review: ${prTitle}`,
          detail: pr?.attentionReason || "Needs review",
          prKey,
          provider: "azure-devops",
          connectionId: pr?.connectionId || "",
          workspaceProfileId: azurePrProfileId,
        })
        .catch((err) => {
          log.warn("telegram: Azure PR forward failed", { prKey, err: (err as Error).message });
        });
    }

    // Check GitHub PRs with attention
    for (const [prKey, summary] of Object.entries(githubSnapshot?.pullRequests || {})) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const pr = summary as any;
      if (!pr?.hasAttention || telegramManager.hasForwardedPr(prKey)) continue;
      telegramManager.markPrForwarded(prKey);
      // See Azure counterpart for the rationale — prefer the connection's
      // profile (carried on the PR summary) when picking the inbox parent.
      const ghPrProfileIdHint = (pr?.profileId as string | undefined) || "";
      const githubInboxForProfile = ghPrProfileIdHint
        ? state.workspaces.find(
            (w: WorkspaceState) => w.kind === "github" && (w.profileId || "default") === ghPrProfileIdHint,
          )
        : null;
      const githubWorkspace =
        githubInboxForProfile || state.workspaces.find((w: WorkspaceState) => w.kind === "github");
      const prWorkspaceId = pr?.reviewWorkspaceId || pr?.existingWorkspaceId || githubWorkspace?.id || "github";
      const prTitle = pr?.pullRequest?.title || prKey;
      log.info("telegram: forwarding GitHub PR notification", { prKey, connectionId: pr?.connectionId });
      const githubPrWs = state.workspaces.find((w) => w.id === prWorkspaceId);
      const githubPrProfileId =
        ghPrProfileIdHint ||
        (githubPrWs as { profileId?: string } | undefined)?.profileId ||
        (githubWorkspace as { profileId?: string } | undefined)?.profileId ||
        "default";
      telegramManager
        .forwardAlert({
          alertId: prKey,
          workspaceId: prWorkspaceId,
          panelId: "inbox",
          workspaceName: githubWorkspace?.name || "GitHub",
          panelTitle: "Inbox",
          kind: "review",
          urgency: "normal",
          title: `PR Review: ${prTitle}`,
          detail: pr?.attentionReason || "Needs review",
          prKey,
          provider: "github",
          connectionId: pr?.connectionId || "",
          workspaceProfileId: githubPrProfileId,
        })
        .catch((err) => {
          log.warn("telegram: GitHub PR forward failed", { prKey, err: (err as Error).message });
        });
    }
  }

  // Track check states per PR for pipeline completion forwarding to Telegram
  const forwardedPipelineChecks = new Map<string, string>(); // prKey:checkId → last forwarded state
  const PIPELINE_CHECK_SEED_MS = 10_000; // don't forward checks that complete in the first 10s (startup)
  const pipelineCheckStartedAt = Date.now();

  function checkAndForwardPipelineNotificationsToTelegram(): void {
    if (telegramManager.getSnapshot().connections.length === 0) return;
    const azureSnapshot = azure.getSnapshot();
    const githubSnapshot = github.getSnapshot();
    const inStartupGrace = Date.now() - pipelineCheckStartedAt < PIPELINE_CHECK_SEED_MS;

    function processPrChecks(
      prs: Record<string, unknown>,
      provider: "azure-devops" | "github",
      workspaceFinder: () => WorkspaceState | undefined,
    ) {
      const state = getState();
      const inboxKind = provider === "azure-devops" ? "azure" : "github";
      for (const [prKey, summary] of Object.entries(prs)) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const pr = summary as any;
        const checks: Array<{ id?: string; state?: string; name?: string }> = pr?.checks?.items || [];
        const prTitle: string = pr?.pullRequest?.title || prKey;
        // Mirror the PR-attention dispatch: prefer the connection's profile
        // (now carried on the summary as pr.profileId) over the first-match
        // inbox lookup. When the PR has no review/existing workspace yet,
        // the old fallback to workspaceFinder() returned whichever inbox
        // sorted first in state.workspaces — silently routing pipeline
        // alerts under the wrong profile.
        const prProfileIdHint = (pr?.profileId as string | undefined) || "";
        const inboxForProfile = prProfileIdHint
          ? state.workspaces.find(
              (w: WorkspaceState) => w.kind === inboxKind && (w.profileId || "default") === prProfileIdHint,
            )
          : undefined;
        const fallbackInbox = workspaceFinder();
        const prWorkspaceId: string =
          pr?.reviewWorkspaceId || pr?.existingWorkspaceId || inboxForProfile?.id || fallbackInbox?.id || provider;
        const prWs = state.workspaces.find((w) => w.id === prWorkspaceId);
        const prProfileId =
          prProfileIdHint ||
          (prWs as { profileId?: string } | undefined)?.profileId ||
          (inboxForProfile as { profileId?: string } | undefined)?.profileId ||
          (fallbackInbox as { profileId?: string } | undefined)?.profileId ||
          "default";

        for (const check of checks) {
          if (!check?.id) continue;
          const key = `${provider}:${prKey}:${check.id}`;
          const prevState = forwardedPipelineChecks.get(key);
          const curState = check.state || "";
          forwardedPipelineChecks.set(key, curState);

          if (inStartupGrace) continue;
          if (prevState === undefined) continue; // first time seeing this check
          const wasRunning = prevState === "pending" || prevState === "";
          const isTerminal = curState === "succeeded" || curState === "failed";
          if (!wasRunning || !isTerminal) continue;

          const checkName = (check as { name?: string; displayName?: string }).name || "Check";
          const icon = curState === "succeeded" ? "✅" : "❌";
          const detail = curState === "succeeded" ? "Passed" : "Failed";
          log.info("telegram: forwarding pipeline check completion", {
            prKey,
            checkName,
            state: curState,
            provider,
          });
          telegramManager
            .forwardAlert({
              alertId: `pipeline:${prKey}:${check.id}`,
              workspaceId: prWorkspaceId,
              panelId: "pipelines",
              workspaceName: prTitle,
              panelTitle: "Pipelines",
              kind: "pipeline",
              urgency: curState === "failed" ? "urgent" : "normal",
              title: `${icon} ${checkName} — ${prTitle}`,
              detail,
              prKey,
              provider,
              connectionId: pr?.connectionId || "",
              workspaceProfileId: prProfileId,
            })
            .catch((err) => {
              log.warn("telegram: pipeline check forward failed", { prKey, err: (err as Error).message });
            });
        }
      }
    }

    processPrChecks(azureSnapshot?.pullRequests || {}, "azure-devops", () =>
      getState().workspaces.find((w: WorkspaceState) => w.kind === "azure"),
    );
    processPrChecks(githubSnapshot?.pullRequests || {}, "github", () =>
      getState().workspaces.find((w: WorkspaceState) => w.kind === "github"),
    );
  }

  function broadcastState() {
    if (broadcastScheduled) return;
    broadcastScheduled = true;
    queueMicrotask(() => {
      broadcastScheduled = false;
      const payload = getPayload();
      events.emit("state:updated", payload);
      checkAndForwardPrNotificationsToTelegram();
      checkAndForwardPipelineNotificationsToTelegram();
    });
  }

  // Debounced persistence — coalesces a burst of in-memory mutations (mostly
  // from agent-task-runner.setTaskState) into a single store.save() so the
  // disk file isn't rewritten dozens of times per second. Used to make task
  // lifecycle transitions durable without paying for atomic writes on every
  // hook event.
  let persistTimer: ReturnType<typeof setTimeout> | null = null;
  function schedulePersist(): void {
    if (persistTimer) return;
    persistTimer = setTimeout(() => {
      persistTimer = null;
      store.save().catch((err: unknown) => {
        log.warn("schedulePersist: save failed", { err: (err as Error)?.message });
      });
    }, 250);
  }

  // --- Telegram command dispatch ---
  // _rt is populated at the end of createRuntime(); commands always fire
  // asynchronously (after first Telegram poll), so _rt is guaranteed set.
  //
  // Telegram passes `profileId` (the user-facing scope) on window-affecting
  // commands; runtime resolves it to a `windowId` here so the rest of the
  // dispatch joins the same windowId-based plumbing IPC and remote-server use.
  // Resolution rules live in telegram-window-resolver (pure, unit-tested).
  const resolveTelegramWindowId = (c: { windowId?: string; profileId?: string }): string | undefined =>
    resolveWindowIdForTelegramCommand(c, getState().windowSlots || []);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  telegramManager.on("command", async (cmd: any) => {
    log.info("telegram: command dispatch", {
      type: cmd.type,
      workspaceId: cmd.workspaceId,
      prKey: cmd.prKey,
      provider: cmd.provider,
      profileId: cmd.profileId,
    });
    try {
      if (cmd.type === "start-task" && cmd.taskDescription && cmd.workspaceId) {
        const state = getState();
        // Walk up the parent chain so a Telegram reply originating in a
        // child workspace (PR review, quickfix, or another task) doesn't
        // create a misnested "task of task" or "task of PR review" tree.
        // Pure helper at telegram-task-resolution.ts owns the logic — it
        // also handles the trickier "task ran in a worktree, completed,
        // user replied to the completion notification" case so the new
        // task continues in the same worktree instead of jumping back to
        // the main project root.
        const targetCwdHint = String(cmd.targetCwd || "").trim();
        const resolution = resolveTelegramTaskTarget({
          workspaces: state.workspaces,
          sourceWorkspaceId: cmd.workspaceId,
          targetCwd: targetCwdHint,
        });
        const parentWorkspace = resolution.parentWorkspace;
        if (!parentWorkspace?.cwd) {
          log.warn("telegram: start-task aborted — no valid parent workspace with cwd", {
            originalWorkspaceId: cmd.workspaceId,
          });
          if (cmd.chatId) {
            await telegramManager.notifyChat(
              cmd.chatId,
              "⚠️ Cannot find a suitable parent workspace with `cwd` for the source notification\\. Use `/task` and pick a workspace manually\\.",
            );
          }
          return;
        }
        if (parentWorkspace.id !== cmd.workspaceId) {
          log.warn("telegram: start-task — resolved alert workspace to a higher-up parent", {
            from: cmd.workspaceId,
            to: parentWorkspace.id,
            toName: parentWorkspace.name,
            cwdReason: resolution.cwdReason,
          });
        }
        const resolvedParentId = parentWorkspace.id;
        if (cmd.agentCommand) {
          // Run user-defined agent command in non-interactive mode.
          //
          // Split the template FIRST, then substitute {task} per token. This
          // keeps the user-supplied taskDescription as a single argv entry
          // even if it contains spaces or shell metacharacters; spawn() runs
          // without a shell so there's no further interpretation.
          // eslint-disable-next-line security/detect-unsafe-regex -- argv tokeniser; alternatives are mutually exclusive on first char so no exponential backtracking
          const argvTpl = String(cmd.agentCommand).match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) || [];
          const argv = argvTpl.map((tok: string) => {
            const stripped = tok.replace(/^["']|["']$/g, "");
            return stripped.includes("{task}") ? stripped.replace(/\{task\}/g, cmd.taskDescription) : stripped;
          });
          const executable = argv[0];
          const args = argv.slice(1);
          if (!executable) {
            log.warn("telegram: agent command empty after parse", { agentCommand: cmd.agentCommand });
            return;
          }
          log.info("telegram: spawning agent command", {
            executable,
            argCount: args.length,
            cwd: parentWorkspace.cwd,
            description: cmd.taskDescription?.slice(0, 80),
          });
          const child = spawn(executable, args, {
            cwd: parentWorkspace.cwd,
            detached: false,
            stdio: "ignore",
          });
          child.on("error", (err) => {
            log.warn("telegram: agent command spawn error", { executable, err: err.message });
          });
          child.on("exit", (code, signalName) => {
            log.info("telegram: agent command exited", { executable, code, signal: signalName });
          });
        } else {
          // Worktree mode: caller can either create a NEW git worktree
          // (useWorktree=true + worktreeBranch), pick an EXISTING worktree
          // (targetCwd overrides parent.cwd), or run the task DIRECTLY in
          // the parent's cwd (default — no worktree). The validation of the
          // branch name happens client-side in telegram-manager; the
          // useWorktree path here just plumbs through.
          const useWorktree = !!cmd.useWorktree;
          const worktreeBranch = cmd.worktreeBranch?.trim() || "";
          if (useWorktree && !worktreeBranch) {
            log.warn("telegram: start-task with useWorktree but no branch", { workspaceId: cmd.workspaceId });
            if (cmd.chatId) {
              await telegramManager.notifyChat(cmd.chatId, "⚠️ Missing branch name for the new worktree\\.");
            }
            return;
          }
          // The task cwd is decided by `resolveTelegramTaskTarget` above:
          //  - explicit `cmd.targetCwd` → used as-is (pick-existing-worktree),
          //  - source workspace's cwd if it differs from the resolved root
          //    (the "completion notification from a worktree task" case the
          //    user reported as buggy),
          //  - resolved root cwd otherwise.
          // For "new worktree" mode we ignore the resolution result and keep
          // the resolved root's cwd as the BASE for the new worktree — the
          // git worktree is always cut off the project root, never off
          // another worktree.
          const taskCwd = useWorktree ? parentWorkspace.cwd : resolution.taskCwd;
          log.warn("telegram: creating task workspace", {
            parentWorkspaceId: resolvedParentId,
            parentName: parentWorkspace.name,
            taskCwd,
            useWorktree,
            worktreeBranch: worktreeBranch || undefined,
            cwdReason: resolution.cwdReason,
            description: cmd.taskDescription?.slice(0, 80),
          });
          // activate:false — Telegram-driven creation must not yank the user
          // out of the workspace they're currently in.
          let result: { workspaceId: string; cwdWarning: string; payload: unknown } | undefined;
          try {
            result = await _rt?.createTaskWorkspace({
              cwd: taskCwd,
              description: cmd.taskDescription,
              parentWorkspaceId: resolvedParentId,
              activate: false,
              useWorktree,
              worktreeBranch: useWorktree ? worktreeBranch : undefined,
            });
          } catch (err) {
            log.warn("telegram: createTaskWorkspace threw", {
              workspaceId: cmd.workspaceId,
              err: (err as Error).message,
            });
            if (cmd.chatId) {
              await telegramManager.notifyChat(
                cmd.chatId,
                "⚠️ Task creation failed: ` " + (err as Error).message.replace(/`/g, "'") + " `",
              );
            }
            return;
          }
          if (result?.workspaceId) {
            // Don't auto-start. Ask the user via Telegram whether to start
            // the task now or leave it idle so they can edit TASK.md first.
            if (cmd.chatId) {
              const promptCwd = useWorktree
                ? `${parentWorkspace.cwd}\\.strideterm\\tree\\${worktreeBranch.replace(/\//g, "-")}`
                : taskCwd;
              await telegramManager.promptStartAfterCreate({
                chatId: cmd.chatId,
                workspaceId: result.workspaceId,
                description: cmd.taskDescription,
                parentName: parentWorkspace.name,
                cwd: promptCwd,
              });
            } else {
              log.warn("telegram: start-task created workspace but no chatId for follow-up", {
                workspaceId: result.workspaceId,
              });
            }
          } else {
            log.warn("telegram: createTaskWorkspace returned no result", { workspaceId: cmd.workspaceId });
          }
        }
      } else if (cmd.type === "start-existing-task" && cmd.workspaceId) {
        // Defensive guard against accidental object-shaped IDs (older Telegram
        // buffered updates / external callers) — taskRunner.startTask logs the
        // shape it receives, which is how we caught the historical regression.
        const wsId = typeof cmd.workspaceId === "string" ? cmd.workspaceId : "";
        if (!wsId) {
          log.warn("telegram: start-existing-task aborted — workspaceId not a string", {
            workspaceIdType: typeof cmd.workspaceId,
          });
          if (cmd.chatId) {
            await telegramManager.notifyChat(cmd.chatId, "⚠️ Internal error: missing workspaceId\\.");
          }
          return;
        }
        const targetWs = findWorkspace(getState(), wsId);
        if (!targetWs || targetWs.kind !== "task" || !targetWs.task) {
          log.warn("telegram: start-existing-task aborted — workspace not found or not a task", {
            workspaceId: wsId,
            kind: targetWs?.kind,
          });
          if (cmd.chatId) {
            await telegramManager.notifyChat(cmd.chatId, "⚠️ Task workspace not found \\(possibly deleted\\)\\.");
          }
          return;
        }
        log.warn("telegram: starting existing task", { workspaceId: wsId, state: targetWs.task.state });
        // CRITICAL: when the task workspace was created with `activate:false`,
        // its worker/judge PTYs were never spawned. taskRunner.startTask
        // would then write the initial prompt into a non-existent session
        // (silent drop in session-manager.writeToSession), and the user sees
        // a Claude welcome screen with no command — exactly the bug the
        // user reported. Start the PTYs explicitly here, await readiness,
        // and give Claude's TUI a moment to finish rendering its welcome
        // before we inject the prompt.
        const workerPanelId = targetWs.task.workerPanelId;
        const judgePanelId = targetWs.task.judgePanelId;
        const workerSessionId = createSessionId(wsId, workerPanelId);
        const judgeSessionId = createSessionId(wsId, judgePanelId);
        try {
          await sessions.ensureSession(getState(), workerSessionId);
          await sessions.ensureSession(getState(), judgeSessionId);
        } catch (err) {
          log.warn("telegram: failed to ensure task PTY sessions", {
            workspaceId: wsId,
            err: (err as Error).message,
          });
        }
        // Wait for Claude's Ink TUI to finish its initial render. Without
        // this delay the keystrokes get lost in the welcome banner. 2.5s is
        // empirically enough on a fast machine; longer than that just makes
        // the user wait without benefit. Tune via env if it turns out flaky.
        const promptDelayMs = Number(process.env.STRIDETERM_TG_PROMPT_DELAY_MS) || 2500;
        await new Promise((resolve) => setTimeout(resolve, promptDelayMs));
        const ok = await _rt?.startTask(wsId);
        if (cmd.chatId) {
          await telegramManager.notifyChat(
            cmd.chatId,
            ok?.ok ? "▶️ Task started\\." : "⚠️ Task failed to start \\(check the log\\)\\.",
          );
        }
      } else if (cmd.type === "pause-task" && cmd.workspaceId) {
        log.info("telegram: pause task", { workspaceId: cmd.workspaceId });
        const ok = _rt?.pauseTask(cmd.workspaceId);
        if (cmd.chatId) {
          await telegramManager.notifyChat(
            cmd.chatId,
            ok?.ok ? "⏸ Task paused\\." : "⚠️ Task is not in a state that can be paused\\.",
          );
        }
      } else if (cmd.type === "resume-task" && cmd.workspaceId) {
        log.info("telegram: resume task", { workspaceId: cmd.workspaceId });
        const ok = _rt?.resumeTask(cmd.workspaceId);
        if (cmd.chatId) {
          await telegramManager.notifyChat(
            cmd.chatId,
            ok?.ok ? "▶️ Task resumed\\." : "⚠️ Task cannot be resumed from the current state\\.",
          );
        }
      } else if (cmd.type === "stop-task" && cmd.workspaceId) {
        log.info("telegram: stop task", { workspaceId: cmd.workspaceId });
        const ok = _rt?.stopTask(cmd.workspaceId);
        if (cmd.chatId) {
          await telegramManager.notifyChat(
            cmd.chatId,
            ok?.ok ? "⏹ Task stopped\\." : "⚠️ Task cannot be stopped from the current state\\.",
          );
        }
      } else if (cmd.type === "reset-task" && cmd.workspaceId) {
        log.info("telegram: reset task", { workspaceId: cmd.workspaceId });
        const ok = await _rt?.resetTask(cmd.workspaceId);
        if (cmd.chatId) {
          await telegramManager.notifyChat(
            cmd.chatId,
            ok?.ok ? "🔄 Task reset to IDLE\\." : "⚠️ Task cannot be reset from the current state\\.",
          );
        }
      } else if (cmd.type === "update-task-description" && cmd.workspaceId && cmd.taskDescription !== undefined) {
        log.info("telegram: update task description", {
          workspaceId: cmd.workspaceId,
          followUp: cmd.followUp,
          length: String(cmd.taskDescription).length,
        });
        const updated = await _rt?.updateTaskDescription(cmd.workspaceId, cmd.taskDescription);
        if (!updated?.ok) {
          if (cmd.chatId) {
            await telegramManager.notifyChat(cmd.chatId, "⚠️ Could not save the task description\\.");
          }
        } else {
          // Chained follow-up actions (Edit+Continue / Edit+Start)
          if (cmd.followUp === "resume") {
            const ok = _rt?.resumeTask(cmd.workspaceId);
            if (cmd.chatId) {
              await telegramManager.notifyChat(
                cmd.chatId,
                ok?.ok
                  ? "📝 Description updated, task resumed\\."
                  : "📝 Description updated, but task could not be resumed from the current state\\.",
              );
            }
          } else if (cmd.followUp === "start") {
            // Reset → start sequence so the new description takes effect from
            // round 1 (startTask refreshes description from TASK.md).
            await _rt?.resetTask(cmd.workspaceId);
            const ok = await _rt?.startTask(cmd.workspaceId);
            if (cmd.chatId) {
              await telegramManager.notifyChat(
                cmd.chatId,
                ok?.ok
                  ? "📝 Description updated, task started\\."
                  : "📝 Description updated, but the task could not be started\\.",
              );
            }
          } else {
            if (cmd.chatId) {
              await telegramManager.notifyChat(cmd.chatId, "📝 Task description updated\\.");
            }
          }
        }
      } else if (cmd.type === "send-task-file" && cmd.workspaceId && cmd.filePath) {
        const wsId = String(cmd.workspaceId);
        const ws = findWorkspace(getState(), wsId);
        if (!ws || ws.kind !== "task" || !ws.task) {
          log.warn("telegram: send-task-file aborted — workspace not found or not a task", { workspaceId: wsId });
          if (cmd.chatId) {
            await telegramManager.notifyChat(cmd.chatId, "⚠️ Task workspace not found \\(possibly deleted\\)\\.");
          }
          return;
        }
        if (!ws.cwd) {
          log.warn("telegram: send-task-file aborted — workspace has no cwd", { workspaceId: wsId });
          if (cmd.chatId) {
            await telegramManager.notifyChat(cmd.chatId, "⚠️ Workspace has no cwd\\.");
          }
          return;
        }
        // Resolve the requested path relative to task.cwd, then guard against
        // path-traversal: the resolved absolute path must still live inside
        // the workspace directory. Otherwise a chat user could exfiltrate
        // arbitrary files via `..\..\..\Users\...`.
        const path = await import("node:path");
        const cleanRel = String(cmd.filePath)
          .replace(/^[/\\]+/, "")
          .trim();
        const wsRoot = path.resolve(ws.cwd);
        const requested = path.resolve(wsRoot, cleanRel);
        const wsRootSep = wsRoot.endsWith(path.sep) ? wsRoot : wsRoot + path.sep;
        if (requested !== wsRoot && !requested.startsWith(wsRootSep)) {
          log.warn("telegram: send-task-file rejected — path escapes workspace cwd", {
            workspaceId: wsId,
            requested,
            wsRoot,
          });
          if (cmd.chatId) {
            await telegramManager.notifyChat(
              cmd.chatId,
              "⚠️ Path points outside the task workspace\\. Use a relative path inside `cwd`\\.",
            );
          }
          return;
        }
        log.warn("telegram: sending task file", {
          workspaceId: wsId,
          relPath: cleanRel,
          absolutePath: requested,
        });
        if (cmd.chatId) {
          await telegramManager.sendFile({
            chatId: cmd.chatId,
            absolutePath: requested,
            relPath: cleanRel,
            workspaceName: ws.name,
            mode: cmd.fileMode === "document" ? "document" : "auto",
          });
        }
      } else if (cmd.type === "screenshot-current" || cmd.type === "screenshot-workspace") {
        const captureFn = dependencies.captureMainWindowPng;
        if (!captureFn) {
          log.warn("telegram: screenshot requested but captureMainWindowPng dependency missing");
          if (cmd.chatId) {
            await telegramManager.notifyChat(
              cmd.chatId,
              "⚠️ Screenshot is not available in this instance \\(probably a headless build\\)\\.",
            );
          }
          return;
        }
        // Scope to the user-selected profile's window. Without this the
        // capture falls back to the primary BrowserWindow even when the user
        // picked a different profile from the Telegram menu, so the screenshot
        // is of the wrong window. See _windowIdForProfile / windowSlots.
        const targetWindowId = resolveTelegramWindowId(cmd);
        const preState = getState();
        const slot = targetWindowId ? (preState.windowSlots || []).find((s) => s.id === targetWindowId) : undefined;
        // For per-window screenshots, originalActiveId is the workspace
        // currently shown in THAT window — not the global active. Falling
        // back to global keeps single-window setups working.
        const originalActiveId = slot?.activeWorkspaceId || preState.activeWorkspaceId;
        let targetWsId = "";
        let targetWsName = "current";
        if (cmd.type === "screenshot-workspace" && cmd.workspaceId) {
          targetWsId = String(cmd.workspaceId);
          const targetWs = findWorkspace(getState(), targetWsId);
          if (!targetWs) {
            log.warn("telegram: screenshot-workspace aborted — workspace not found", { workspaceId: targetWsId });
            if (cmd.chatId) {
              await telegramManager.notifyChat(cmd.chatId, "⚠️ Workspace not found\\.");
            }
            return;
          }
          targetWsName = targetWs.name;
          if (targetWsId !== originalActiveId) {
            log.warn("telegram: switching workspace for screenshot", {
              from: originalActiveId,
              to: targetWsId,
              windowId: targetWindowId,
            });
            if (targetWindowId) {
              await _rt?.activateWorkspaceInWindow(targetWsId, targetWindowId);
            } else {
              await _rt?.activateWorkspace(targetWsId);
            }
            // Renderer needs time to lay out the panels and finish at least
            // one paint frame before capturePage produces a representative
            // image. 600ms is empirically enough for a typical workspace;
            // configurable for slow machines via env.
            const renderDelayMs = Number(process.env.STRIDETERM_TG_SCREENSHOT_DELAY_MS) || 600;
            await new Promise((resolve) => setTimeout(resolve, renderDelayMs));
          }
        } else if (cmd.type === "screenshot-current" && originalActiveId) {
          const ws = findWorkspace(getState(), originalActiveId);
          targetWsName = ws?.name || "current";
        }

        let png: Buffer;
        try {
          png = await captureFn(targetWindowId);
        } catch (err) {
          log.warn("telegram: screenshot capture failed", { err: (err as Error).message });
          if (cmd.chatId) {
            await telegramManager.notifyChat(cmd.chatId, "⚠️ Could not capture screenshot \\(window unavailable\\)\\.");
          }
          // Still try to switch back so user's UI returns to where they left it.
          if (targetWsId && originalActiveId && targetWsId !== originalActiveId) {
            if (targetWindowId) {
              await _rt?.activateWorkspaceInWindow(originalActiveId, targetWindowId).catch(() => {});
            } else {
              await _rt?.activateWorkspace(originalActiveId).catch(() => {});
            }
          }
          return;
        }

        if (cmd.chatId) {
          await telegramManager.sendScreenshotPng(cmd.chatId, png, targetWsName);
        }

        // Switch back to where the user was before. Best-effort — failures
        // are logged but not surfaced to the user (their original workspace
        // is still selectable from the sidebar).
        if (targetWsId && originalActiveId && targetWsId !== originalActiveId) {
          const switchBack = targetWindowId
            ? _rt?.activateWorkspaceInWindow(originalActiveId, targetWindowId)
            : _rt?.activateWorkspace(originalActiveId);
          await switchBack?.catch((err: Error) => {
            log.warn("telegram: switch-back after screenshot failed", { err: err.message });
          });
        }
      } else if (cmd.type === "open-pr-review" && cmd.prKey && cmd.provider) {
        const targetWindowId = resolveTelegramWindowId(cmd);
        log.info("telegram: opening PR review from command", {
          prKey: cmd.prKey,
          provider: cmd.provider,
          windowId: targetWindowId,
        });
        if (cmd.provider === "github") {
          await _rt?.openGitHubPullRequest({ prKey: cmd.prKey }, targetWindowId);
        } else {
          await _rt?.openAzurePullRequest({ prKey: cmd.prKey }, targetWindowId);
        }
      } else if (cmd.type === "dismiss") {
        // For PR alerts, drop from the manager's forwarded-PR LRU so the user
        // can be re-notified later if the PR is re-flagged. For session-bound
        // alerts (shell completion, agent waiting), clear the per-session alert.
        if (cmd.prKey) {
          telegramManager.forgetForwardedPr(cmd.prKey);
          log.info("telegram: dismiss PR alert", { prKey: cmd.prKey });
        }
        if (cmd.workspaceId && cmd.panelId) {
          const sessionId = createSessionId(cmd.workspaceId, cmd.panelId);
          clearAlertSession(sessionId);
        }
        broadcastState();
      } else if (cmd.type === "custom-message") {
        log.info("telegram: custom-message received", {
          workspaceId: cmd.workspaceId,
          textPreview: String(cmd.taskDescription || "").slice(0, 80),
        });
      }
    } catch (err) {
      log.warn("telegram: command dispatch error", { type: cmd.type, err: (err as Error).message });
    }
  });

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
      raiseAlert({
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
    },
    async restartSession(sessionId) {
      await sessions.restartSession(getState(), sessionId);
      resetSessionSignal(sessionId);
    },
    // Debounced persistence trigger. taskRunner mutates state in-memory and
    // relies on opportunistic store.mutate() calls elsewhere to flush to
    // disk. That's flaky for crash recovery: a task that flips to "running"
    // and is then killed before any unrelated mutation runs would never have
    // its active state persisted, so reconcileOnStartup wouldn't see it as a
    // candidate. Schedule an async save so lifecycle transitions reach disk.
    saveState() {
      schedulePersist();
    },
  });

  // Collect tasks that were active when the app last closed.
  // taskRunner.init() ran #reconcileOnStartup, which paused those tasks
  // and built the candidate list. We surface the list to the renderer via
  // meta.recoveryCandidates (see getMeta below) so the dialog can open.
  // The dialog is the only resume path — silent auto-resume was unreliable
  // (the freshly-spawned agent's first idle event sometimes never reached
  // the runner, leaving the task stuck on "running" forever).
  _recoveryCandidates = taskRunner.getStartupRecoveryCandidates();
  if (_recoveryCandidates.length > 0) {
    log.info("startup: found tasks active at last close", {
      count: _recoveryCandidates.length,
    });
  }

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
        } else if (signal.hasUserInput && !signal.agentLike) {
          // OSC 133;D as an alert source is reliable ONLY for real shells
          // (bash / zsh / pwsh / cmd with shell-integration), where the
          // sequence marks a true command-finished boundary. Agent TUIs
          // (Claude Code, Codex, Gemini) emit OSC 133;D multiple times
          // within a single turn — once per UI prompt, tool-permission ask,
          // or status update between tool uses — so treating it as
          // "command finished" produced false-positive "waiting for input"
          // alerts whenever the user briefly looked away mid-turn (the 5s
          // visibility grace expired before the next OSC arrived, then the
          // next OSC fired the alert from the not-visible branch below).
          //
          // For agent sessions, end-of-turn detection flows through hooks
          // (Stop event → classifier → raiseAlert) and the 2-min silence
          // fallback in the agent branches further down. The same long-turn
          // false-positive reasoning the original author already applied to
          // silence detection (see comment in the completion-hook branch below)
          // applies equally to OSC 133;D — extending the guard here closes
          // that gap.
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
        // For shells, OSC 133;D is authoritative — the agent branches below
        // are skipped via the `else if` chain. For agents we entered this
        // block too (status update, task-runner intercept, git refresh) but
        // skipped the alert path above; the `else if` chain still skips the
        // agent branches for OSC chunks, which means busy/output tracking
        // misses chunks that contain OSC. That matches pre-existing behavior
        // and is acceptable because the next non-OSC chunk catches up; if
        // that ever turns out to be observable, refactor to run the agent
        // branches independently of OSC.
        // perf-3: schedule a debounced git refresh if this session is in a git workspace
        if (descriptor?.workspaceId) {
          const wsSnapshot = git.getSnapshot?.(descriptor.workspaceId);
          if (wsSnapshot?.available) {
            scheduleGitRefreshFromShell(descriptor.workspaceId);
          }
        }
      } else if (signal.agentLike && signal.completionHookCapable) {
        // --- Agent sessions with proven hooks: trust them exclusively ---
        // Phase 0 § 3.2.d — a session that has fired a completion/waiting hook
        // uses hooks as its ONLY alert source. Silence-based fallback is
        // off — it's the primary source of false positives during long
        // Claude Code turns. OSC 133;D is no longer an alert source for
        // agents either (see guard in the OSC block above), and BEL is only
        // tracked for diagnostics because agent TUIs can emit it while still
        // working.
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

        if (hasBell) {
          log.trace("agent hook-capable bell ignored", { sessionId: payload.sessionId });
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
          !signal.completionHookCapable &&
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          !(signal as any)._hookMissingWarned &&
          signal.lastOutputAt > 0 &&
          Date.now() - signal.lastOutputAt < 30_000 &&
          signal.lastAlertAt > 0 &&
          Date.now() - signal.lastAlertAt > 60_000
        ) {
          log.warn("agent session has been active >60s with no completion hook event — hook may be misconfigured", {
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

  // 2. PRAGMA data_version polling — reliable fallback, catches anything the watcher misses.
  // 15 s is plenty for a backstop; the fs.watch above covers real-time updates.
  let reviewBridgePoll: ReturnType<typeof setInterval> | null = setInterval(() => {
    const currentVersion = reviewBridgeStore.getDataVersion?.() || 0;
    if (currentVersion !== reviewBridgeDataVersion) {
      onReviewBridgeChange();
    }
  }, 15000);

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

  /**
   * Drop workspaces whose `cwd` no longer exists on disk. Covers the orphan
   * case: user nuked the worktree externally (or a previous deleteFromDisk
   * left only stragglers behind), and the sidebar entry is now useless —
   * nothing in the workspace can be activated when its working directory
   * is gone. `syncWorktrees` already handles this for `notes: "Worktree of"`
   * children; this function extends the same hygiene to task-agent
   * workspaces and any other top-level entry whose cwd has gone missing.
   *
   * Skipped: inbox-only kinds (azure / github), workspaces with no cwd at
   * all, paths currently being deleted by another flow, and any workspace
   * referenced by `_recoveryCandidates` (the user gets the recovery dialog
   * first; resolveTaskRecovery clears the candidate, after which the next
   * prune pass removes it).
   */
  async function pruneOrphanedWorkspaces(): Promise<number> {
    const state = getState();
    const recoveryIds = new Set(_recoveryCandidates.map((c) => c.workspaceId));
    const toRemove: WorkspaceState[] = [];
    for (const ws of state.workspaces) {
      if (!ws.cwd) continue;
      if (ws.kind === "azure" || ws.kind === "github") continue;
      if (recoveryIds.has(ws.id)) continue;
      const resolvedCwd = path.resolve(ws.cwd);
      if (pendingWorktreeDeletions.has(resolvedCwd)) continue;
      try {
        await access(ws.cwd);
      } catch {
        toRemove.push(ws);
      }
    }
    if (toRemove.length === 0) return 0;
    const removeIds = new Set(toRemove.map((w) => w.id));
    await store.mutate((draft: AppState) => {
      draft.workspaces = draft.workspaces.filter((w) => !removeIds.has(w.id));
      // Rewire each affected slot to a sibling in that slot's OWN profile.
      // Picking from windowSlots[0]'s profile would push a wrong-profile
      // workspace into the other window's pane.
      for (const slot of draft.windowSlots || []) {
        if (removeIds.has(slot.activeWorkspaceId)) {
          const sibling = draft.workspaces.find((w) => (w.profileId || "default") === slot.profileId);
          slot.activeWorkspaceId = sibling?.id || "";
        }
      }
      if (removeIds.has(draft.activeWorkspaceId)) {
        // Legacy global field — mirror to the most-recently-focused slot's
        // pick so it tracks user activity rather than slot order.
        const primarySlot = [...(draft.windowSlots || [])].sort(
          (a, b) => (b.lastFocusedAt || 0) - (a.lastFocusedAt || 0),
        )[0];
        const fallbackProfileId = primarySlot?.profileId || "default";
        const fallback = draft.workspaces.find((w) => (w.profileId || "default") === fallbackProfileId);
        draft.activeWorkspaceId = fallback?.id || draft.workspaces[0]?.id || "";
      }
    });
    for (const ws of toRemove) {
      if (ws.kind === "task" && ws.task?.taskId) {
        try {
          taskRunner.stopTask(ws.id);
        } catch {
          /* best-effort; task may already be stopped */
        }
      }
      sessions.removeWorkspaceSessions(ws.id);
      clearProjectAlerts(ws.id);
    }
    log.info("pruneOrphanedWorkspaces removed orphans", {
      count: toRemove.length,
      removed: toRemove.map((w) => ({ id: w.id, name: w.name, cwd: w.cwd, kind: w.kind })),
    });
    ensureVisibleSession();
    broadcastState();
    return toRemove.length;
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

    const toAdd: WorkspaceState[] = [];
    const toRemove: string[] = [];
    const toRepair: Array<{ id: string; profileId: string }> = [];

    // Each parent is an independent observer of its own treeDir on disk.
    // When two profiles both have a workspace at the same cwd, both scan the
    // same directory and each gets its own worktree entries — profiles do
    // not compete for ownership of on-disk worktrees.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const treeDirsScanned = new Map<string, any[]>();
    for (const parent of parents) {
      if (!parent.cwd) continue;
      const treeDir = path.join(parent.cwd, ".strideterm", "tree");
      let entries = treeDirsScanned.get(treeDir);
      if (entries === undefined) {
        try {
          entries = (await readdir(treeDir, { withFileTypes: true })) as unknown as typeof entries;
        } catch {
          entries = [];
        }
        treeDirsScanned.set(treeDir, entries || []);
      }
      const parentProfileId = parent.profileId || "default";
      for (const entry of entries || []) {
        if (!entry.isDirectory()) continue;
        const treePath = path.join(treeDir, entry.name);
        if (pendingWorktreeDeletions.has(path.resolve(treePath))) continue;
        const existing = worktrees.find((w) => w.cwd === treePath && (w.profileId || "default") === parentProfileId);
        if (existing) {
          // Repair profileId if it drifted from parent
          if ((existing.profileId || "default") !== parentProfileId) {
            toRepair.push({ id: existing.id, profileId: parentProfileId });
          }
          continue;
        }
        if (toAdd.some((w) => w.cwd === treePath && (w.profileId || "default") === parentProfileId)) continue;
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
        // Rewire each affected slot to a sibling in that slot's OWN profile.
        for (const slot of draft.windowSlots || []) {
          if (removeSet.has(slot.activeWorkspaceId)) {
            const sibling = draft.workspaces.find((w) => (w.profileId || "default") === slot.profileId);
            slot.activeWorkspaceId = sibling?.id || "";
          }
        }
        if (removeSet.has(draft.activeWorkspaceId)) {
          // Legacy global field — mirror to the most-recently-focused slot.
          const primarySlot = [...(draft.windowSlots || [])].sort(
            (a, b) => (b.lastFocusedAt || 0) - (a.lastFocusedAt || 0),
          )[0];
          const fallbackProfileId = primarySlot?.profileId || "default";
          const fallback = draft.workspaces.find((w) => (w.profileId || "default") === fallbackProfileId);
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

  pluginManager = await createPluginManagerImpl({
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

    // Re-establish Cloudflare tunnel if it was active before the last shutdown.
    // Best-effort — a failure here is non-fatal; the user can create it manually.
    const remoteConfig = getState().settings.remoteAccess;
    if (remoteConfig.enabled && remoteConfig.autoTunnel) {
      ensureRemoteOriginReady(remoteConfig)
        .then((origin) => tunnel.startQuickTunnel(origin))
        .then(() => broadcastState())
        .catch((err: unknown) => {
          log.warn("autoTunnel: failed to re-establish tunnel on startup", {
            err: (err as Error)?.message,
          });
        });
    }

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
  reconfigureTelegram();
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

  // Deferred orphan prune — runs ~5s after startup, non-blocking. Removes
  // workspaces whose cwd is gone (e.g. worktree dirs the user nuked
  // externally, or a previous deleteFromDisk that bailed mid-way and left
  // a state entry pointing at nothing). Delayed so external drives /
  // network mounts have a chance to come up first; skipped while a task
  // recovery dialog is still pending.
  //
  // Gated behind deferInitialRefresh so it only fires in production (Electron
  // main passes deferInitialRefresh: true). Tests run with fake timers and
  // would otherwise advance past the 5s deadline mid-test, prune workspaces
  // whose fixture cwd doesn't exist on disk (e.g. `/tmp/idletask`), and
  // throw off attention/runtime assertions.
  if (deferInitialRefresh) {
    setTimeout(() => {
      pruneOrphanedWorkspaces().catch((err) => {
        log.warn("pruneOrphanedWorkspaces failed", { err: (err as Error)?.message });
      });
    }, 5_000);
  }

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

  function resolveWorkspaceGridProfile(draft: AppState, windowId?: string) {
    const profileId = windowId
      ? (draft.windowSlots || []).find((s) => s.id === windowId)?.profileId
      : (draft.windowSlots || [])[0]?.profileId || "default";
    return profileId ? draft.profiles.find((p) => p.id === profileId) || null : null;
  }

  /**
   * Return the profile a given window is bound to, or null when the window
   * has no slot (legacy / pre-init callers). Helpers below use this to
   * reject cross-profile slot-aware operations before any mutation runs.
   */
  function getWindowProfileId(windowId: string | undefined): string | null {
    if (!windowId) return null;
    const slot = (getState().windowSlots || []).find((s) => s.id === windowId);
    return slot ? slot.profileId : null;
  }

  /**
   * Refuse an operation when its target workspace lives in a different
   * profile than the calling window. Previously these handlers only
   * skipped the slot mirror on cross-profile, but the side effect (new
   * worktree on disk, new task workspace, etc.) still happened in the
   * foreign profile. The remote/mobile contract is "operate on the
   * profile your session is bound to" — silently writing to another one
   * is a bug, not a UX issue.
   *
   * No-op when no windowId is supplied (legacy in-process callers / tests
   * that don't model windows).
   */
  function assertWorkspaceInWindowProfile(workspaceId: string, windowId: string | undefined): void {
    const slotProfileId = getWindowProfileId(windowId);
    if (!slotProfileId) return;
    const ws = getState().workspaces.find((w) => w.id === workspaceId);
    if (!ws) return; // the surrounding op will fail on its own
    const wsProfileId = ws.profileId || "default";
    if (wsProfileId !== slotProfileId) {
      throw new Error(
        `Cross-profile refused: workspace ${workspaceId} is in profile ${wsProfileId}, window ${windowId} is bound to ${slotProfileId}.`,
      );
    }
  }

  /**
   * Same as assertWorkspaceInWindowProfile but for provider connections
   * (Azure / GitHub). The connection's profileId determines which inbox
   * the PR review / quickfix workspace will land under; honouring a
   * request from a different-profile window means the caller is asking
   * us to mutate state in a profile they don't own.
   */
  function assertConnectionInWindowProfile(
    connection: { profileId?: string; id?: string } | null | undefined,
    windowId: string | undefined,
  ): void {
    const slotProfileId = getWindowProfileId(windowId);
    if (!slotProfileId) return;
    if (!connection) return;
    const connProfileId = connection.profileId || "default";
    if (connProfileId !== slotProfileId) {
      throw new Error(
        `Cross-profile refused: connection ${connection.id || "?"} is in profile ${connProfileId}, window ${windowId} is bound to ${slotProfileId}.`,
      );
    }
  }

  const returnObj = {
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

    /** Called by startRemoteServer to hand the registry handle to the runtime. */
    setRemoteClientRegistry(registry: RemoteClientRegistry): void {
      _remoteClientRegistry = registry;
    },

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async activateProfileForRemoteClient(clientId: string, profileId: any): Promise<unknown> {
      if (!_remoteClientRegistry) throw new Error("Remote client registry not initialised");
      _remoteClientRegistry.activateProfile(clientId, profileId, getState());
      broadcastState();
      return _remoteClientRegistry.composePayload(clientId, getPayload());
    },

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async activateWorkspaceForRemoteClient(clientId: string, workspaceId: any): Promise<unknown> {
      if (!_remoteClientRegistry) throw new Error("Remote client registry not initialised");
      _remoteClientRegistry.activateWorkspace(clientId, workspaceId, getState());
      broadcastState();
      return _remoteClientRegistry.composePayload(clientId, getPayload());
    },

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async activateSessionForRemoteClient(clientId: string, workspaceId: any, sessionId: any): Promise<unknown> {
      if (!_remoteClientRegistry) throw new Error("Remote client registry not initialised");
      _remoteClientRegistry.activateSession(clientId, workspaceId, sessionId, getState());
      broadcastState();
      return _remoteClientRegistry.composePayload(clientId, getPayload());
    },

    composeStatePayloadForRemoteClient(clientId: string): unknown {
      if (!_remoteClientRegistry) return getPayload();
      return _remoteClientRegistry.composePayload(clientId, getPayload());
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
    // Exposed for tests and explicit maintenance flows. Removes workspaces
    // whose cwd no longer exists on disk and rewires per-window activeWorkspaceId
    // to a sibling in the same profile.
    async pruneOrphanedWorkspaces(): Promise<number> {
      return pruneOrphanedWorkspaces();
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async activateWorkspace(workspaceId: any) {
      await store.mutate((draft: AppState) => {
        if (draft.workspaces.some((workspace) => workspace.id === workspaceId)) {
          draft.activeWorkspaceId = workspaceId;
          // Also update the first window slot (primary window compat)
          const firstSlot = (draft.windowSlots || [])[0];
          if (firstSlot) firstSlot.activeWorkspaceId = workspaceId;
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
      ensureVisibleSession(workspaceId);
      broadcastState();
      // Refresh git/docker in the background so the IPC response returns
      // immediately; fresh data arrives via their "updated" → broadcastState.
      if (workspace?.kind === "docker") {
        refreshDocker().catch((err: unknown) => {
          log.warn("activateWorkspace: docker refresh failed", { err: (err as Error)?.message });
        });
      }
      refreshGit(workspaceId).catch((err: unknown) => {
        log.warn("activateWorkspace: git refresh failed", { err: (err as Error)?.message });
      });
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
    async enableWorkspaceGrid(layout: any, workspaceIds?: (string | null)[], windowId?: string) {
      await store.mutate((draft: AppState) => {
        const slots = { cols: 2, rows: 2, "top-split": 3, "left-split": 3, grid: 4 }[String(layout)] as
          | number
          | undefined;
        if (!slots) return;
        const ids: (string | null)[] = [];
        for (let i = 0; i < slots; i++) {
          ids.push(workspaceIds?.[i] ?? null);
        }
        const grid = { layout, cellWorkspaceIds: ids };
        const profile = resolveWorkspaceGridProfile(draft, windowId);
        if (profile) profile.workspaceGrid = grid;
        draft.workspaceGrid = grid;
      });
      broadcastState();
      return getPayload();
    },

    async disableWorkspaceGrid(windowId?: string) {
      await store.mutate((draft: AppState) => {
        const profile = resolveWorkspaceGridProfile(draft, windowId);
        if (profile) profile.workspaceGrid = null;
        draft.workspaceGrid = null;
      });
      broadcastState();
      return getPayload();
    },

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async setGridLayout(layout: any, windowId?: string) {
      await store.mutate((draft: AppState) => {
        const profile = resolveWorkspaceGridProfile(draft, windowId);
        const grid = profile && profile.workspaceGrid !== undefined ? profile.workspaceGrid : draft.workspaceGrid;
        if (!grid) return;
        const slots = { cols: 2, rows: 2, "top-split": 3, "left-split": 3, grid: 4 }[String(layout)] as
          | number
          | undefined;
        if (!slots) return;
        const existing = grid.cellWorkspaceIds.filter((id) => id !== null);
        const ids: (string | null)[] = [];
        let taken = 0;
        for (let i = 0; i < slots; i++) {
          ids.push(taken < existing.length ? (existing[taken++] ?? null) : null);
        }
        const updated = { layout, cellWorkspaceIds: ids };
        if (profile) profile.workspaceGrid = updated;
        draft.workspaceGrid = updated;
      });
      broadcastState();
      return getPayload();
    },

    async setGridCell(cellIndex: number, workspaceId: string | null, windowId?: string) {
      // Validate workspace ↔ profile match BEFORE mutation. The grid is
      // per-profile; a stale or crafted remote payload could try to place a
      // workspace from profile A into profile B's grid (different cards
      // would then show up in B's window with cwds the user didn't expect).
      if (workspaceId) {
        const state = getState();
        const gridProfile = resolveWorkspaceGridProfile(state, windowId);
        const gridProfileId = gridProfile?.id || null;
        const ws = state.workspaces.find((w) => w.id === workspaceId);
        if (ws && gridProfileId && (ws.profileId || "default") !== gridProfileId) {
          throw new Error(
            `Cross-profile refused: workspace ${workspaceId} is in profile ${ws.profileId || "default"}, grid belongs to profile ${gridProfileId}.`,
          );
        }
      }
      await store.mutate((draft: AppState) => {
        const profile = resolveWorkspaceGridProfile(draft, windowId);
        // `?? draft.workspaceGrid` would leak the deprecated global (which
        // tracks the GLOBAL activeProfileId, not the slot's) into a window
        // whose profile has its grid explicitly null — mutating the wrong
        // profile's grid. Use the global only when the profile field is
        // truly absent (pre-migration state).
        const grid = profile && profile.workspaceGrid !== undefined ? profile.workspaceGrid : draft.workspaceGrid;
        if (!grid) return;
        const ids = grid.cellWorkspaceIds;
        if (cellIndex < 0 || cellIndex >= ids.length) return;
        if (workspaceId) {
          const existing = ids.indexOf(workspaceId);
          if (existing >= 0 && existing !== cellIndex) ids[existing] = null;
        }
        ids[cellIndex] = workspaceId;
        const allNull = ids.every((id) => id === null);
        if (profile) profile.workspaceGrid = allNull ? null : grid;
        draft.workspaceGrid = allNull ? null : grid;
      });
      broadcastState();
      return getPayload();
    },

    async swapGridCells(a: number, b: number, windowId?: string) {
      await store.mutate((draft: AppState) => {
        const profile = resolveWorkspaceGridProfile(draft, windowId);
        const grid = profile && profile.workspaceGrid !== undefined ? profile.workspaceGrid : draft.workspaceGrid;
        if (!grid) return;
        const ids = grid.cellWorkspaceIds;
        if (a < 0 || a >= ids.length || b < 0 || b >= ids.length || a === b) return;
        const tmp = ids[a];
        ids[a] = ids[b];
        ids[b] = tmp;
        draft.workspaceGrid = grid;
      });
      broadcastState();
      return getPayload();
    },

    // --- Per-window activation methods ---

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async activateWorkspaceInWindow(workspaceId: any, windowId: string) {
      const preState = getState();
      const preSlot = (preState.windowSlots || []).find((s) => s.id === windowId);
      const targetWs = preState.workspaces.find((ws) => ws.id === workspaceId);
      const isCrossProfile = !!(targetWs && preSlot) && (targetWs.profileId || "default") !== preSlot.profileId;
      log.debug("activateWorkspaceInWindow: entry", {
        workspaceId,
        windowId,
        targetWsKind: targetWs?.kind || null,
        targetWsProfileId: targetWs?.profileId || null,
        slotProfileId: preSlot?.profileId || null,
        slotPrevActiveWsId: preSlot?.activeWorkspaceId || null,
        crossProfile: isCrossProfile,
      });
      // Refuse cross-profile activation. The whole purpose of the per-window
      // API is to switch the slot — if the workspace lives in another profile,
      // honouring the request would silently push a foreign-profile workspace
      // into the calling slot. Remote callers can hit this with a crafted /
      // stale workspaceId; the guard converts a silent corruption into an
      // explicit error the caller can catch (see createTaskWorkspace below).
      if (isCrossProfile) {
        throw new Error(
          `Workspace ${workspaceId} (profile ${targetWs?.profileId || "default"}) does not belong to window ${windowId}'s profile (${preSlot?.profileId || "default"}).`,
        );
      }
      await store.mutate((draft: AppState) => {
        const targetWorkspace = draft.workspaces.find((ws) => ws.id === workspaceId);
        if (!targetWorkspace) return;
        // Update per-window slot
        const slot = (draft.windowSlots || []).find((s) => s.id === windowId);
        if (slot) {
          slot.activeWorkspaceId = workspaceId;
        }
        // ALSO mirror to global activeWorkspaceId. `getPayload()` builds the
        // `payload.workspace` snapshot from `sessions.getWorkspace(state)`,
        // which defaults to `state.activeWorkspaceId`. Without this mirror the
        // main pane (and any consumer reading the global field) stays on the
        // previously-active workspace even though slot.activeWorkspaceId moved
        // — the user clicks a card, the slot updates, but the renderer's
        // payload.workspace is still the old one, so nothing visually changes.
        // In multi-window setups this makes the global "track last-activated";
        // each window still drives its own pane via slot.activeWorkspaceId.
        draft.activeWorkspaceId = workspaceId;
      });
      const workspace = findWorkspace(getState(), workspaceId);
      if (workspace) {
        updateVisibleSessions(
          workspace.kind === "azure" || workspace.kind === "github"
            ? []
            : // eslint-disable-next-line @typescript-eslint/no-explicit-any
              workspace.panels.map((panel: any) => createSessionId(workspaceId, panel.id)),
        );
      }
      ensureVisibleSession(workspaceId);
      broadcastState();
      // Refresh git/docker in the background so the IPC response returns
      // immediately; fresh data arrives via their "updated" → broadcastState.
      if (workspace?.kind === "docker") {
        refreshDocker().catch((err: unknown) => {
          log.warn("activateWorkspaceInWindow: docker refresh failed", { err: (err as Error)?.message });
        });
      }
      refreshGit(workspaceId).catch((err: unknown) => {
        log.warn("activateWorkspaceInWindow: git refresh failed", { err: (err as Error)?.message });
      });
      return getPayload();
    },

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async activateSessionInWindow(sessionId: any, windowId: string) {
      const descriptor = parseSessionId(sessionId);
      if (!descriptor) return getPayload();
      await store.mutate((draft: AppState) => {
        const workspace = findWorkspace(draft, descriptor.workspaceId);
        if (!workspace) return;
        const slot = (draft.windowSlots || []).find((s) => s.id === windowId);
        if (slot) {
          slot.activeWorkspaceId = descriptor.workspaceId;
          slot.activeSessionId = sessionId;
        } else {
          draft.activeWorkspaceId = descriptor.workspaceId;
        }
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
    async activateProfileInWindow(profileId: any, windowId: string) {
      const state = getState();
      // Exclusivity check: refuse if profile is already in a DIFFERENT open window
      const existing = (state.windowSlots || []).find((s) => s.profileId === profileId && s.id !== windowId);
      if (existing) {
        // Find window number for user-facing message (1-based creation order)
        const slots = state.windowSlots || [];
        const idx = slots.findIndex((s) => s.id === existing.id);
        throw new Error(`Profile is already open in Window ${idx + 1}. Close that window first.`);
      }
      await store.mutate((draft: AppState) => {
        const targetProfile = draft.profiles.find((p) => p.id === profileId);
        if (!targetProfile) return;
        const profileWorkspaces = draft.workspaces.filter((w) => (w.profileId || "default") === profileId);
        const firstWorkspaceId = profileWorkspaces[0]?.id || "";
        const slot = (draft.windowSlots || []).find((s) => s.id === windowId);
        if (slot) {
          slot.profileId = profileId;
          slot.activeWorkspaceId = firstWorkspaceId;
        }
        draft.activeWorkspaceId = firstWorkspaceId;
      });
      await syncWorktrees();
      sessions.syncWithState(getState());
      ensureVisibleSession();
      await refreshAzure();
      scheduleAzurePolling();
      broadcastState();
      return getPayload();
    },

    // --- Window slot management ---

    async createWindowSlot(
      profileId: string,
    ): Promise<{ id: string; profileId: string; bounds: { x: number; y: number; width: number; height: number } }> {
      const newId = randomUUID();
      // Cascade offset new windows so they don't stack exactly on top of
      // existing ones. Step of 32px is enough to expose the title bar of the
      // window underneath without pushing the new window off-screen for
      // typical 6-slot scenarios. resolveSafeBounds (main.ts) will clamp /
      // re-center if the cascade walks past the work area.
      const existingCount = (getState().windowSlots || []).length;
      const baseX = 100;
      const baseY = 100;
      const step = 32;
      const defaultBounds = {
        x: baseX + existingCount * step,
        y: baseY + existingCount * step,
        width: 1280,
        height: 800,
      };
      await store.mutate((draft: AppState) => {
        if (!Array.isArray(draft.windowSlots)) draft.windowSlots = [];
        draft.windowSlots.push({
          id: newId,
          profileId,
          activeWorkspaceId: draft.workspaces.find((w) => (w.profileId || "default") === profileId)?.id || "",
          activeSessionId: "",
          bounds: { ...defaultBounds },
          lastFocusedAt: Date.now(),
        });
      });
      broadcastState();
      return { id: newId, profileId, bounds: defaultBounds };
    },

    async removeWindowSlot(windowId: string) {
      await store.mutate((draft: AppState) => {
        if (!Array.isArray(draft.windowSlots)) return;
        draft.windowSlots = draft.windowSlots.filter((s) => s.id !== windowId);
      });
      broadcastState();
    },

    async updateWindowSlotBounds(
      windowId: string,
      bounds: { x: number; y: number; width: number; height: number },
      displayId?: number,
    ) {
      await store.mutate((draft: AppState) => {
        const slot = (draft.windowSlots || []).find((s) => s.id === windowId);
        if (slot) {
          slot.bounds = bounds;
          if (displayId !== undefined) slot.displayId = displayId;
        }
      });
      // No broadcast needed for bounds update (not UI-visible)
    },

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async saveWorkspace(workspace: any) {
      log.debug("saveWorkspace: called", {
        workspaceId: workspace?.id,
        name: workspace?.name,
        kind: workspace?.kind,
        incomingProfileId: workspace?.profileId || null,
        stateActiveProfileId: (getState().windowSlots || [])[0]?.profileId || null,
        stateProfileIds: (getState().profiles || []).map((p) => p.id),
      });
      // Ensure the working directory exists (create if needed)
      if (workspace.cwd && workspace.kind !== "docker") {
        await mkdir(workspace.cwd, { recursive: true }).catch(() => {});
      }

      await store.mutate((draft: AppState) => {
        const normalized = normalizeWorkspace(workspace);
        log.debug("saveWorkspace: normalized", {
          workspaceId: normalized.id,
          normalizedProfileId: normalized.profileId,
          incomingProfileId: workspace.profileId || null,
        });
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
        const ws = draft.workspaces.find((item) => item.id === workspaceId);
        draft.workspaces = draft.workspaces.filter((item) => item.id !== workspaceId);
        if (draft.activeWorkspaceId === workspaceId) {
          // Pick next-best in same profile
          const profileId = ws ? ws.profileId || "default" : "default";
          const sibling = draft.workspaces.find((w) => (w.profileId || "default") === profileId);
          draft.activeWorkspaceId = sibling?.id || draft.workspaces[0]?.id || "";
        }
        // Clear workspace from all window slots
        for (const slot of draft.windowSlots || []) {
          if (slot.activeWorkspaceId === workspaceId) {
            const profileId = slot.profileId;
            const sibling = draft.workspaces.find((w) => (w.profileId || "default") === profileId);
            slot.activeWorkspaceId = sibling?.id || "";
          }
        }
        // Clear workspace from per-profile grids
        for (const profile of draft.profiles) {
          if (!profile.workspaceGrid) continue;
          const ids = profile.workspaceGrid.cellWorkspaceIds;
          for (let i = 0; i < ids.length; i++) {
            if (ids[i] === workspaceId) ids[i] = null;
          }
          if (ids.every((id) => id === null)) profile.workspaceGrid = null;
        }
        // Clear from deprecated global grid
        if (draft.workspaceGrid) {
          const ids = draft.workspaceGrid.cellWorkspaceIds;
          for (let i = 0; i < ids.length; i++) {
            if (ids[i] === workspaceId) ids[i] = null;
          }
          if (ids.every((id) => id === null)) draft.workspaceGrid = null;
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
          const tDelete0 = Date.now();
          log.debug("deleteWorkspace: starting disk delete", {
            workspaceId,
            workspaceName: workspace.name,
            diskPath,
            kind: workspace.kind,
            isReview: !!workspace.review,
            isTask: !!workspace.task,
            isQuickfix: !!workspace.quickfix,
          });
          try {
            const tWait0 = Date.now();
            await sessionsExited;
            log.debug("deleteWorkspace: PTY sessions exited", {
              workspaceId,
              waitMs: Date.now() - tWait0,
            });
            // On Windows, agent children (claude.exe, codex.exe, …) spawned by
            // the killed PTY shell may outlive their parent for hundreds of
            // milliseconds while still holding file handles inside the
            // worktree. fs/rd will fail with EBUSY/EPERM until those handles
            // are released. We don't taskkill the tree (too brutal — risks
            // truncated agent state), instead we wait by probing: try to
            // rename diskPath onto itself; on Windows this fails while any
            // handle is open and succeeds once they're all released. Cap the
            // wait at 5s; if it still locks, rmPath's own retry loop will
            // either eventually succeed or the git fallback will run.
            if (process.platform === "win32") {
              const tProbe0 = Date.now();
              const probeTimeout = 5000;
              const probeInterval = 150;
              let probedReady = false;
              while (Date.now() - tProbe0 < probeTimeout) {
                try {
                  // rename(p, p) is a cheap OS-level lock probe — it touches
                  // the directory entry without scanning contents.
                  await rename(diskPath, diskPath);
                  probedReady = true;
                  break;
                } catch {
                  await new Promise((resolve) => setTimeout(resolve, probeInterval));
                }
              }
              log.debug("deleteWorkspace: handle-release probe finished", {
                workspaceId,
                diskPath,
                probeMs: Date.now() - tProbe0,
                released: probedReady,
              });
            }

            const cacheRepoPath = workspace.review?.checkout?.cacheRepoPath || "";
            // Task worktrees store the base repo path explicitly
            const taskWorktreeBase = workspace.task?.worktreeBase || "";
            // workspace.cwd is like /repo/.strideterm/tree/branch-name — 3 levels up to repo root
            const mainWorktreePath = workspace.cwd ? path.resolve(workspace.cwd, "..", "..", "..") : "";
            const gitCwd = cacheRepoPath || taskWorktreeBase || mainWorktreePath;
            log.debug("deleteWorkspace: resolved git cwd", { workspaceId, gitCwd, cacheRepoPath, taskWorktreeBase });
            // Fast path: nuke the directory at the filesystem level, then ask
            // git to prune stale metadata. `git worktree remove --force` walks
            // the tree itself with per-file stat calls — markedly slower than
            // platform-native `rd /s /q` (Windows) or fs.rm (POSIX) when the
            // worktree has a fat node_modules / build dir. The previous order
            // (git first, fs fallback) made every successful delete take the
            // slow path. Only fall back to `git worktree remove --force` if
            // rmPath couldn't finish (e.g. locked files held by AV).
            let rmFailed = false;
            let rmErr: unknown = null;
            const tRm0 = Date.now();
            try {
              await rmPath(diskPath);
              log.debug("deleteWorkspace: rmPath succeeded", { workspaceId, diskPath, ms: Date.now() - tRm0 });
            } catch (err) {
              rmFailed = true;
              rmErr = err;
              log.debug("deleteWorkspace: rmPath failed, trying git worktree remove --force", {
                workspaceId,
                diskPath,
                ms: Date.now() - tRm0,
                err: (err as Error)?.message?.slice(0, 200),
              });
            }
            if (gitCwd) {
              if (rmFailed) {
                const tGit0 = Date.now();
                try {
                  await execFileTextImpl("git", ["worktree", "remove", "--force", diskPath], { cwd: gitCwd });
                  log.debug("deleteWorkspace: git worktree remove --force succeeded", {
                    workspaceId,
                    diskPath,
                    ms: Date.now() - tGit0,
                  });
                } catch (err) {
                  log.warn("deleteWorkspace: git worktree remove --force also failed", {
                    workspaceId,
                    diskPath,
                    ms: Date.now() - tGit0,
                    err: (err as Error)?.message?.slice(0, 200),
                    rmErr: (rmErr as Error)?.message?.slice(0, 200),
                  });
                }
              }
              // Prune the .git/worktrees admin entry. Doesn't need to block
              // the response — it's just metadata cleanup.
              execFileTextImpl("git", ["worktree", "prune"], { cwd: gitCwd }).catch(() => {});
            } else if (rmFailed) {
              // No git cwd to prune from — surface the rm failure.
              throw new Error(`Failed to remove ${diskPath}`);
            }
            log.debug("deleteWorkspace: disk delete complete", {
              workspaceId,
              diskPath,
              totalMs: Date.now() - tDelete0,
              rmFailed,
            });
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
    async reorderWorkspaces(workspaceIds: any, windowId?: string) {
      await store.mutate((draft: AppState) => {
        // Scope the reorder to the caller window's profile. The old logic
        // replaced the entire workspaces array with whatever IDs the caller
        // sent — a profile-scoped frontend or mobile client would then
        // accidentally drop every workspace in OTHER profiles whose IDs it
        // never knew about. Preserve other-profile workspaces in their
        // original positions and only reorder within the caller's profile.
        const callerProfileId = windowId ? (draft.windowSlots || []).find((s) => s.id === windowId)?.profileId : null;
        if (!callerProfileId) {
          // Legacy fallback: no window context known — old global behavior.
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          draft.workspaces = (workspaceIds as any[])
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            .map((id: any) => draft.workspaces.find((workspace) => workspace.id === id))
            .filter(Boolean) as typeof draft.workspaces;
          return;
        }
        // Reorder only within callerProfileId. Other-profile workspaces
        // stay where they were (preserve original slots in draft.workspaces).
        const requested = new Set<string>(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (workspaceIds as any[]).filter((id) => {
            const ws = draft.workspaces.find((w) => w.id === id);
            return ws && (ws.profileId || "default") === callerProfileId;
          }),
        );
        const orderedScoped = (workspaceIds as string[])
          .map((id) => draft.workspaces.find((w) => w.id === id))
          .filter((w): w is (typeof draft.workspaces)[number] => !!w && requested.has(w.id));
        // Preserve workspaces NOT in callerProfileId in their original
        // sequence, and slot the reordered-scoped workspaces into the
        // positions originally held by callerProfile workspaces.
        let scopedCursor = 0;
        const next: typeof draft.workspaces = [];
        for (const ws of draft.workspaces) {
          if ((ws.profileId || "default") === callerProfileId) {
            if (scopedCursor < orderedScoped.length) {
              next.push(orderedScoped[scopedCursor++]);
            }
            // If callerProfile had more workspaces than the caller listed,
            // the remainder is dropped (caller's intent) — but they were
            // still in callerProfileId, so the caller had visibility.
          } else {
            next.push(ws);
          }
        }
        draft.workspaces = next;
      });

      broadcastState();
      return getPayload();
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async reorderProjects(projectIds: any, windowId?: string) {
      return this.reorderWorkspaces(projectIds, windowId);
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

      // Reconfigure Telegram if integrations changed
      reconfigureTelegram(getState());

      broadcastState();
      return { payload: getPayload(), remoteAccessChanged };
    },

    // --- Telegram integration handlers ---

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async verifyTelegramConnection(connection: any) {
      const chatId = String(connection.chatId || "").trim();
      if (!chatId) {
        throw new Error("Chat ID is required.");
      }
      // Edit mode: an empty botToken means "keep the existing one". Fall back
      // to the stored credential keyed by either the explicit botTokenRef or
      // the conventional `cred:<id>` reference.
      let botToken = String(connection.botToken || "").trim();
      if (!botToken) {
        const ref = connection.botTokenRef || (connection.id ? `cred:${connection.id}` : "");
        if (ref) {
          botToken = credentialStore.getSecret(ref) || "";
        }
      }
      if (!botToken) {
        throw new Error("Bot token is required.");
      }
      return telegramManager.verifyConnection({ botToken, chatId });
    },

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async detectTelegramChats(connection: any) {
      // Same edit-mode token fallback as verify.
      let botToken = String(connection.botToken || "").trim();
      if (!botToken) {
        const ref = connection.botTokenRef || (connection.id ? `cred:${connection.id}` : "");
        if (ref) {
          botToken = credentialStore.getSecret(ref) || "";
        }
      }
      if (!botToken) {
        throw new Error("Bot token is required.");
      }
      return telegramManager.detectChats({ botToken });
    },

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async saveTelegramConnection(connection: any) {
      log.info("telegram saveTelegramConnection called", {
        id: connection?.id,
        chatId: connection?.chatId,
        hasBotToken: Boolean(connection?.botToken),
        forwardKindsType: Object.prototype.toString.call(connection?.forwardKinds),
      });
      const connectionId = connection.id || `tg-${randomUUID()}`;
      const botTokenRef = connection.botTokenRef || `cred:${connectionId}`;
      const botToken = connection.botToken || credentialStore.getSecret(botTokenRef);
      const chatId = String(connection.chatId || "").trim();

      if (!chatId) throw new Error("Chat ID is required.");
      if (!botToken && !credentialStore.hasSecret(botTokenRef)) {
        throw new Error("Bot token is required.");
      }

      // Verify the connection works
      const verification = await telegramManager.verifyConnection({
        botToken: botToken || credentialStore.getSecret(botTokenRef),
        chatId,
      });

      if (botToken) {
        await credentialStore.setSecret(botTokenRef, botToken);
      }

      const normalizedConnection = {
        id: connectionId,
        label: String(connection.label || `Telegram ${connectionId}`).trim(),
        botTokenRef,
        chatId,
        enabled: connection.enabled !== false,
        pollSeconds: Number(connection.pollSeconds) || getTelegramSettings().defaultPollSeconds || 5,
        profileId: typeof connection.profileId === "string" ? connection.profileId.trim() : "",
        forwardKinds: Array.isArray(connection.forwardKinds) ? [...connection.forwardKinds] : [],
        agentCommand: typeof connection.agentCommand === "string" ? connection.agentCommand : "",
      };

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await store.mutate((draft: any) => {
        if (!draft.settings.integrations.telegram) {
          draft.settings.integrations.telegram = { enabled: true, defaultPollSeconds: 5, connections: [] };
        }
        const connections = draft.settings.integrations.telegram.connections;
        const index = connections.findIndex((c: any) => c.id === connectionId); // eslint-disable-line @typescript-eslint/no-explicit-any
        if (index >= 0) {
          connections[index] = normalizedConnection;
        } else {
          connections.push(normalizedConnection);
        }
      });

      reconfigureTelegram(getState());
      broadcastState();

      // Preflight: structured-clone the response we hand back to IPC. If
      // something is non-cloneable (Vue Proxy, Map, function, etc.), this
      // throws here with a stack we can log instead of the renderer's
      // opaque "An object could not be cloned." error.
      const response = { payload: getPayload(), verification };
      try {
        structuredClone(response);
      } catch (err) {
        log.warn("telegram saveTelegramConnection: response not cloneable", {
          err: (err as Error).message,
          verificationKeys: Object.keys(verification ?? {}),
        });
        // Fall through with a defensively-cloned response (drops anything
        // structuredClone can't handle by serialising via JSON).
        return JSON.parse(JSON.stringify(response));
      }
      return response;
    },

    async deleteTelegramConnection(connectionId: string) {
      const conn = getTelegramConnections().find((c: any) => c.id === connectionId); // eslint-disable-line @typescript-eslint/no-explicit-any
      if (conn?.botTokenRef) {
        await credentialStore.deleteSecret(conn.botTokenRef).catch(() => {});
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await store.mutate((draft: any) => {
        if (!draft.settings.integrations.telegram) return;
        draft.settings.integrations.telegram.connections =
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          draft.settings.integrations.telegram.connections.filter((c: any) => c.id !== connectionId);
      });
      reconfigureTelegram(getState());
      broadcastState();
      return getPayload();
    },

    async refreshTelegramState() {
      reconfigureTelegram(getState());
      broadcastState();
      return getPayload();
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
        // Only carry the post-clear cooldown on signals that were actually
        // alerting — otherwise a stale buffer replay could re-alert. Fresh
        // signals (never alerted, not waiting) have nothing to suppress, so
        // applying lastAlertAt to them just silences valid future hooks for
        // the next ~15s. Use `everAlerted` (not `lastAlertAt > 0`) because
        // signals are seeded with lastAlertAt=createTime for warmup.
        const wasActive = signal.waitingRaised || signal.everAlerted;
        signal.busy = false;
        signal.waitingRaised = false;
        signal.lastOutputAt = 0;
        if (wasActive) signal.lastAlertAt = now;
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
      // Persist auto-start preference so the tunnel is re-established on next launch.
      await store.mutate((draft: AppState) => {
        draft.settings.remoteAccess.autoTunnel = true;
      });
      return getPayload();
    },
    async stopCloudflareTunnel() {
      await tunnel.stop({ preserveAvailability: true });
      // Clear auto-start preference — user explicitly stopped the tunnel.
      await store.mutate((draft: AppState) => {
        draft.settings.remoteAccess.autoTunnel = false;
      });
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
    async createWorktree(
      {
        workspaceId,
        projectId,
        name,
        rootPath,
      }: {
        workspaceId?: any; // eslint-disable-line @typescript-eslint/no-explicit-any -- MIGRATION-EXEMPT: IPC payload, typed migration pending
        projectId: any; // eslint-disable-line @typescript-eslint/no-explicit-any -- MIGRATION-EXEMPT: IPC payload, typed migration pending
        name: any; // eslint-disable-line @typescript-eslint/no-explicit-any -- MIGRATION-EXEMPT: IPC payload, typed migration pending
        rootPath?: any; // eslint-disable-line @typescript-eslint/no-explicit-any -- MIGRATION-EXEMPT: IPC payload, typed migration pending
      },
      windowId?: string,
    ) {
      const targetWorkspaceId = workspaceId || projectId;
      if (!name || !/^[a-zA-Z0-9._-]+$/.test(name)) {
        throw new Error("Worktree name must contain only alphanumeric characters, dots, hyphens, or underscores.");
      }
      const project = findWorkspace(getState(), targetWorkspaceId);
      if (!project?.cwd) throw new Error("Workspace has no working directory");
      // Refuse upfront if the parent lives in a profile the caller's window
      // isn't bound to — a remote/mobile client must not be able to spawn
      // a worktree on disk in another profile just by passing its ID.
      assertWorkspaceInWindowProfile(targetWorkspaceId, windowId);

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
        // Entry check (assertWorkspaceInWindowProfile) already refused any
        // cross-profile request, so the mirror here is always in-profile.
        if (windowId) {
          const slot = (draft.windowSlots || []).find((s) => s.id === windowId);
          if (slot) slot.activeWorkspaceId = newProject.id;
        }
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
      const state = getState();
      // Refuse if profile is open in any window slot
      const openSlot = (state.windowSlots || []).find((s) => s.profileId === profileId);
      if (openSlot) {
        const slots = state.windowSlots || [];
        const idx = slots.findIndex((s) => s.id === openSlot.id);
        throw new Error(`Profile is open in Window ${idx + 1}. Close that window first.`);
      }
      await store.mutate((draft: AppState) => {
        draft.profiles = draft.profiles.filter((p) => p.id !== profileId);
        if (draft.profiles.length === 0) {
          draft.profiles.push({ id: "default", name: "Default", color: "#6366f1", workspaceIds: [] });
        }
      });
      // Fallback any remote clients that were on the deleted profile.
      _remoteClientRegistry?.fallbackDeletedProfile(profileId, getState());
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
      telegramManager.stop();
      await tunnel.stop({ preserveAvailability: true, quiet: true });
      await pluginManager.stopAll();
      sessions.stopAll();
      await reviewBridgeStore.close?.();
      auditLogStore.close?.();
      githubAuditLogStore.close?.();
      gitAuditLogStore.close?.();
      telegramAuditLogStore.close?.();
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
    async createTaskWorkspace(config: any, windowId?: string) {
      log.info("createTaskWorkspace", {
        cwd: config.cwd,
        hasDescription: !!config.description,
        useWorktree: !!config.useWorktree,
      });
      const state = getState();

      // Refuse upfront if the parent lives in another profile. Without this,
      // a remote/mobile client bound to profile B could spawn a task
      // workspace (and worktree on disk) under a profile-A parent just by
      // passing its ID — the old logic only suppressed the slot mirror.
      if (config.parentWorkspaceId) {
        assertWorkspaceInWindowProfile(config.parentWorkspaceId, windowId);
      }

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

      const callerProfileId = windowId
        ? // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (state.windowSlots || []).find((s: any) => s.id === windowId)?.profileId || ""
        : "";
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
        callerProfileId,
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
      // Activate the new workspace unless the caller explicitly opted out
      // (e.g. Telegram-driven creation, where the user is in another workspace
      // and shouldn't have their UI yanked away). Use the slot-aware variant
      // when the calling window is known — otherwise the global update alone
      // leaves the per-window slot stuck on the previous workspace and the UI
      // flickers (same root cause as openAzurePullRequest).
      if (config.activate !== false) {
        if (windowId) {
          // activateWorkspaceInWindow refuses cross-profile mutation. That's
          // expected when a remote/UI client triggers task creation under a
          // parent in another profile (the new task inherits the parent's
          // profile, not the caller's window). Treat that as "task created
          // but don't yank the slot"; broadcastState so the new entry shows
          // up everywhere it should.
          try {
            await this.activateWorkspaceInWindow(workspace.id, windowId);
          } catch (err) {
            log.info("createTaskWorkspace: skipping slot activation (cross-profile)", {
              workspaceId: workspace.id,
              windowId,
              err: (err as Error).message,
            });
            broadcastState();
          }
        } else {
          await this.activateWorkspace(workspace.id);
        }
      } else {
        broadcastState();
      }
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
    async updateTaskDescription(workspaceId: any, description: any) {
      const id = String(workspaceId || "");
      const desc = String(description ?? "");
      const workspace = findWorkspace(getState(), id);
      if (!workspace || workspace.kind !== "task" || !workspace.task) {
        log.warn("updateTaskDescription: not a task workspace", { workspaceId: id });
        return { ok: false, payload: getPayload() };
      }
      const taskId = workspace.task.taskId;
      const cwd = workspace.cwd;
      try {
        await updateTaskDescriptionFile(cwd, taskId, desc, log);
      } catch (err) {
        log.warn("updateTaskDescription: failed to write TASK.md", {
          workspaceId: id,
          err: (err as Error).message,
        });
        return { ok: false, payload: getPayload() };
      }
      // Mirror the change in memory so the dashboard updates immediately
      // without having to wait for the next startTask refresh.
      await store.mutate((draft: AppState) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const ws = draft.workspaces.find((w: any) => w.id === id);
        if (ws?.task) {
          ws.task.description = desc;
          if (!ws.name || ws.name === "Task workspace") {
            const trimmed = desc.trim();
            if (trimmed) {
              ws.name = trimmed.length > 50 ? trimmed.slice(0, 47) + "..." : trimmed;
            }
          }
        }
      });
      broadcastState();
      return { ok: true, payload: getPayload() };
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

    /**
     * Apply the user's per-task recovery decisions, collected by the dialog
     * (or auto-generated when the dialog is suppressed; see setImmediate at
     * the end of createRuntime).
     *
     * For each candidate:
     *   - "skip"     → leave paused. The task stays in AppState and the user
     *                  can resume it later from the dashboard the normal way.
     *   - "fresh"    → reset rounds and start over (clears history, recreates
     *                  WORK_LOCK). Use when the previous attempt was so broken
     *                  that re-orienting from disk would mislead the agent.
     *   - "continue" → re-spawn worker AND judge PTY sessions, and stash a
     *                  recovery prompt on the task (`showerResumePrompt`).
     *                  When the freshly-spawned agent emits its first idle
     *                  signal, the task runner injects this prompt instead of
     *                  the standard initial prompt — the agent re-orients
     *                  from disk and continues. This is the pure-prompt path:
     *                  no `--continue` flag, no transcript replay.
     *
     * The candidate list is cleared after we process the batch so a redrive
     * can't double-spawn.
     */
    async resolveTaskRecovery(decisions: Record<string, string>) {
      const processedIds = new Set<string>();
      for (const [workspaceId, decision] of Object.entries(decisions)) {
        const candidate = _recoveryCandidates.find((c) => c.workspaceId === workspaceId);
        if (!candidate) continue;
        processedIds.add(workspaceId);

        if (decision === "skip") continue;

        try {
          if (decision === "fresh") {
            await taskRunner.resetTask(workspaceId);
            continue;
          }

          // "continue" — build an orientation prompt and resume the agent.
          // pausedFromState was set by #reconcileOnStartup, so resumeTask
          // resumes to the correct role (worker or judge-evaluating).
          const role = candidate.previousState === "judge-evaluating" ? "judge" : "worker";
          const recoveryPrompt = buildRecoveryPrompt({
            role,
            round: candidate.currentRound,
            taskId: candidate.taskId,
          });

          const state = getState();
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const ws = state.workspaces.find((w: any) => w.id === workspaceId);

          // Stash the recovery prompt on the task. We reuse `showerResumePrompt`
          // (originally added for the periodic "fresh-context shower" feature)
          // because both flows want the same thing: replace the next idle's
          // prompt with our text. Setting `promptSent = false` triggers the
          // injection path in onAgentIdle.
          await store.mutate((draft: AppState) => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const dws = draft.workspaces.find((w: any) => w.id === workspaceId);
            if (dws?.task) {
              dws.task.promptSent = false;
              dws.task.showerResumePrompt = recoveryPrompt;
            }
          });

          // Flip the task state from "paused" → "running" / "judge-evaluating"
          // BEFORE spawning the PTYs. If we spawned first, the freshly-started
          // agent's banner-then-idle sequence would fire onAgentIdle while the
          // task was still paused, the handler would bail at its `state ===
          // "paused"` early return, and the recovery prompt would never get
          // injected — the worker would just sit at an empty prompt forever.
          const ok = taskRunner.resumeTask(workspaceId);
          if (!ok) log.warn("resolveTaskRecovery: resumeTask returned false", { workspaceId });

          // Re-spawn PTY sessions for both worker and judge panels. After an
          // app restart the prior PTYs are gone with the parent process. The
          // first idle these new agents emit will hit onAgentIdle with the
          // task already in "running"/"judge-evaluating" state, so the
          // recovery prompt set above gets injected.
          if (ws?.task?.workerPanelId) {
            const workerSessionId = `${workspaceId}:${ws.task.workerPanelId}`;
            await sessions.ensureSession(state, workerSessionId).catch((err: unknown) => {
              log.warn("resolveTaskRecovery: ensureSession (worker) failed", {
                workspaceId,
                err: (err as Error).message,
              });
            });
          }
          if (ws?.task?.judgePanelId) {
            const judgeSessionId = `${workspaceId}:${ws.task.judgePanelId}`;
            await sessions.ensureSession(state, judgeSessionId).catch((err: unknown) => {
              log.warn("resolveTaskRecovery: ensureSession (judge) failed", {
                workspaceId,
                err: (err as Error).message,
              });
            });
          }

          // Force-trigger onAgentIdle a few seconds after spawn instead of
          // waiting for hook-fallback silence (HOOK_FALLBACK_SILENCE_MS = 2 min).
          //
          // Why this is necessary: a freshly-spawned Claude Code session
          // doesn't fire its Stop hook until *after* it processes a turn —
          // there's nothing to stop yet. The runtime treats hook-capable
          // sessions as hook-primary and gates silence detection behind a
          // 2-minute fallback. Without this nudge, the user clicks Resume
          // and sees the agent sit at an empty prompt for two full minutes
          // before the recovery prompt finally gets pasted in. 5 s is enough
          // for Claude Code to render its banner and be ready to accept a
          // paste; onAgentIdle's existing logic does the actual injection.
          if (!ws?.task?.workerPanelId) {
            log.warn("resolveTaskRecovery: ws lookup failed — cannot schedule deferred idle", {
              workspaceId,
              hasWs: !!ws,
              hasTask: !!ws?.task,
              workerPanelId: ws?.task?.workerPanelId,
            });
          }
          if (ws?.task?.workerPanelId) {
            const workerSessionId = `${workspaceId}:${ws.task.workerPanelId}`;
            const role = candidate.previousState === "judge-evaluating" ? "judge" : "worker";
            const idleSessionId =
              role === "judge" && ws.task.judgePanelId ? `${workspaceId}:${ws.task.judgePanelId}` : workerSessionId;
            log.info("resolveTaskRecovery: scheduling deferred idle nudge", {
              workspaceId,
              role,
              idleSessionId,
              delayMs: 5000,
            });
            setTimeout(() => {
              log.info("resolveTaskRecovery: firing deferred onAgentIdle", {
                workspaceId,
                idleSessionId,
              });
              try {
                const handled = taskRunner.onAgentIdle(idleSessionId, "recovery-deferred");
                log.info("resolveTaskRecovery: deferred onAgentIdle returned", {
                  workspaceId,
                  idleSessionId,
                  handled,
                });
              } catch (err) {
                log.warn("resolveTaskRecovery: deferred onAgentIdle threw", {
                  workspaceId,
                  err: (err as Error).message,
                });
              }
            }, 5000);
          }
        } catch (err) {
          log.warn("resolveTaskRecovery: failed for workspace", { workspaceId, err: (err as Error).message });
        }
      }

      // Remove only the candidates we just processed — the dialog calls this
      // method per-decision in sequential mode, so wiping the whole list would
      // make the next call a no-op.
      _recoveryCandidates = _recoveryCandidates.filter((c) => !processedIds.has(c.workspaceId));
      broadcastState();
      return { ok: true, payload: getPayload() };
    },
  };
  _rt = returnObj;
  return returnObj;
}
