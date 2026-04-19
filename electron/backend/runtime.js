import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { watch, readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
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
  AGENT_NAME_RE,
  AGENT_OUTPUT_RE,
  AGENT_OUTPUT_BURST_THRESHOLD,
  HOOK_FALLBACK_SILENCE_MS,
  ATTENTION_MIN_DISPLAY_MS,
  ATTENTION_VISIBILITY_GRACE_MS,
} from "./runtime-utils.js";
import { APP_CONFIG } from "../../config/app-config.js";
import { createVersionChecker } from "./version-checker.js";
import { initLogger, getLogger, setLogLevel, reconfigureLogger } from "./logger.js";

const log = getLogger("runtime");

const require = createRequire(import.meta.url);
const { version: packageVersion = "0.0.0" } = require("../../package.json");
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
export function hasMeaningfulUserInput(data) {
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

function createTunnelOriginUrl(remoteConfig = {}) {
  const rawHost = String(remoteConfig.host || "").trim();
  const host =
    !rawHost || rawHost === "0.0.0.0" ? "127.0.0.1" : rawHost === "::" || rawHost === "[::]" ? "::1" : rawHost;
  const formattedHost = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  return `http://${formattedHost}:${remoteConfig.port}`;
}

// Re-export for consumers that import from runtime.js
export { detectTerminalEnvironmentImpl as detectTerminalEnvironment };

function probeRemoteOrigin(originUrl, timeoutMs = 1200) {
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

async function checkRemoteOrigin(originUrl, { attempts = 16, delayMs = 250, timeoutMs = 1200 } = {}) {
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
    `Remote access origin ${originUrl} is not responding${lastError?.message ? ` (${lastError.message})` : ""}.`,
  );
}

export async function createRuntime({
  userDataPath,
  builtinPluginsDir,
  getThemeSource,
  deferInitialRefresh = false,
  dependencies = {},
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
  async function rmPath(dirPath) {
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
        if (attempt < retryDelays.length && (err.code === "EBUSY" || err.code === "EPERM")) {
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
    defaultApp: process.defaultApp,
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

  function normalizeCwd(cwd) {
    return cwd.replace(/\\/g, "/").toLowerCase();
  }

  function getUrlPort(u) {
    try {
      return new URL(u).port;
    } catch {
      return "";
    }
  }

  function getUrlSid(u) {
    try {
      return new URL(u).searchParams.get("sid") || "";
    } catch {
      return "";
    }
  }

  /** Read the shared file, or return empty object on any error. */
  function readNotifyUrls() {
    try {
      return JSON.parse(readFileSync(notifyUrlsPath, "utf8"));
    } catch {
      return {};
    }
  }

  /** Write the shared file (not atomic — acceptable for this advisory data). */
  function writeNotifyUrls(data) {
    const dir = path.dirname(notifyUrlsPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(notifyUrlsPath, JSON.stringify(data, null, 2), "utf8");
  }

  function registerNotifyUrl(cwd, url) {
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
      log.warn("failed to write notify-urls.json", { err: err.message });
    }
  }

  /** Remove all URLs belonging to our notify server port (called on shutdown). */
  function cleanupNotifyUrls(port) {
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
      log.debug("notify-urls.json cleanup failed", { err: err.message });
    }
  }

  const sessions = new SessionManagerImpl({
    getSessionEnv: ({ workspace, sessionId }) => {
      const env = {};

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
          const provider = getProvider(providerConfig.providerId);
          Object.assign(env, provider.getEnvironment(providerConfig));
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

      if (!["azure-devops", "github"].includes(workspace?.review?.provider) || !workspace.review?.prKey) {
        return env;
      }

      const context = reviewBridgeStore.getPullRequestContext?.(workspace.review.prKey);
      if (!context) {
        return env;
      }

      return {
        ...env,
        STRIDETERM_REVIEW_PROVIDER: context.provider || workspace.review.provider || "azure-devops",
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
    getSessionLaunch: ({ workspace, panel }) => {
      // --- Review workspace: inject MCP bridge ---
      if (!["azure-devops", "github"].includes(workspace?.review?.provider)) {
        return null;
      }

      let context = workspace.review.prKey ? reviewBridgeStore.getPullRequestContext?.(workspace.review.prKey) : null;

      if (!context) {
        const rootPath = reviewBridgeStore.getRootPath?.() || "";
        if (!rootPath) return null;
        context = { rootPath, workspaceId: workspace.id, prKey: "" };
      }

      return buildReviewAgentLaunch({
        workspace,
        panel,
        context,
        processInfo,
      });
    },
  });
  const auditLogDbPath = path.join(reviewBridgeRoot, "azure-audit-log.db");
  const auditLogStore = createAzureAuditLogStore(auditLogDbPath);

  const docker = new DockerManagerImpl();
  const git = new GitManagerImpl({ credentialStore, auditLogStore });
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
  const terminalEnvironment = getTerminalEnvironmentImpl();
  let remoteInfo = null;
  let dockerPoll = null;
  let gitPoll = null;
  const projectAlerts = new Map();
  const attentionContext = createAttentionContext();
  const sessionSignals = new Map();

  // --- Claude CLI availability (persisted; only re-checked when not yet found) ---
  let claudeAvailableCache = getState().settings?.claudeAvailable === true;
  if (!claudeAvailableCache) {
    (async () => {
      try {
        await execFileTextImpl("claude", ["--version"], { timeout: 5000 });
        claudeAvailableCache = true;
        await store.mutate((draft) => {
          draft.settings = draft.settings || {};
          draft.settings.claudeAvailable = true;
        });
      } catch {
        try {
          const which = process.platform === "win32" ? "where" : "which";
          await execFileTextImpl(which, ["claude"], { timeout: 5000 });
          claudeAvailableCache = true;
          await store.mutate((draft) => {
            draft.settings = draft.settings || {};
            draft.settings.claudeAvailable = true;
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
      await store.mutate((draft) => {
        draft.settings = draft.settings || {};
        draft.settings.claudeAvailable = true;
      });
    }
    log.info("recheckClaudeAvailability", { available: claudeAvailableCache });
    return claudeAvailableCache;
  }

  // --- Agent notification hook server ---
  const notifySecret = generateNotifySecret();
  let notifyServerHandle = null;
  let notifyServerStarting = false;

  // --- Agent Task Runner ---
  const taskRunner = new AgentTaskRunner();

  // --- Broadcast coalescing ---
  let broadcastScheduled = false;

  function getState() {
    return store.getState();
  }

  function getNotificationConfig(state = getState()) {
    return state.settings?.notifications || APP_CONFIG.notifications;
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
  async function dispatchAgentHookEvent(event) {
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
        log.warn("probe resolver threw", { err: err.message });
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
    const project = findWorkspace(state, descriptor.workspaceId);
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
      log.warn("taskRunner.onHookEvent threw", { sessionId, hook, subtype, err: err.message });
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
  function applyHookSideEffects(signal, hook, subtype) {
    if (!signal) return;
    if (hook === "UserPromptSubmit") {
      // User started new work — prior idle state is stale.
      signal.lastPromptAt = Date.now();
      signal.busy = false;
      signal.outputBursts = 0;
      signal.waitingRaised = false;
      cancelPromptTimer(signal);
      log.trace("UserPromptSubmit: reset busy/waitingRaised", { sessionId: signal.sessionId });
    }
    // Known no-ops for now (Stop, SubagentStop, Notification) — intentionally
    // do not touch busy here; dispatcher gating handles alerts.
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
        err: error.message,
        stack: error.stack,
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
        log.warn("notify server close error", { err: error.message });
      }
      notifyServerHandle = null;
    }
  }

  function getAzureSettings(state = getState()) {
    return (
      state.settings?.integrations?.azureDevops || {
        enabled: true,
        reviewRoot: path.join(os.homedir(), ".strideterm", "azure-pr"),
        defaultPollSeconds: 120,
        connections: [],
      }
    );
  }

  function getAzureConnections(state = getState()) {
    const all = getAzureSettings(state).connections || [];
    const activeProfile = state.activeProfileId || "default";
    return all.filter((c) => (c.profileId || "default") === activeProfile);
  }

  function getGitHubSettings(state = getState()) {
    return (
      state.settings?.integrations?.github || {
        enabled: true,
        reviewRoot: path.join(os.homedir(), ".strideterm", "github-pr"),
        defaultPollSeconds: 120,
        connections: [],
      }
    );
  }

  function getGitHubConnections(state = getState()) {
    const all = getGitHubSettings(state).connections || [];
    const activeProfile = state.activeProfileId || "default";
    return all.filter((c) => (c.profileId || "default") === activeProfile);
  }

  /**
   * Return all provider connections (Azure DevOps, GitHub, and future GitLab)
   * visible to the active profile.  Each provider stores connections under
   * its own settings key; this helper merges them into a single list so the
   * git tab can offer a unified dropdown.
   */
  function getAllProviderConnections(state = getState()) {
    const activeProfile = state.activeProfileId || "default";
    const matchProfile = (c) => (c.profileId || "default") === activeProfile;

    const azureConns = (getAzureSettings(state).connections || []).filter(matchProfile);
    const githubConns = (getGitHubSettings(state).connections || []).filter(matchProfile);
    return [...azureConns, ...githubConns];
  }

  /**
   * Resolve the provider connection for a workspace's git operations.
   * Returns `null` when the workspace has no connectionId assigned or the
   * connection cannot be found (falls back to system git credentials).
   */
  function resolveGitConnection(workspace) {
    const connectionId =
      workspace?.connectionId || workspace?.review?.connectionId || workspace?.quickfix?.connectionId;
    if (!connectionId) {
      return null;
    }
    const connections = getAllProviderConnections();
    return connections.find((c) => c.id === connectionId && c.enabled !== false) || null;
  }

  function normalizeFsPath(value) {
    const resolved = path.resolve(String(value || "").trim() || ".");
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  }

  function parseAzureReviewWorkspaceHint(workspace) {
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
          .map((workspace) =>
            ["azure-devops", "github"].includes(workspace.review?.provider) ? workspace.review.prKey : "",
          )
          .filter(Boolean),
      ]);
      const pullRequests = {};
      const processInfo = {
        execPath: process.execPath,
        platform: process.platform,
        defaultApp: Boolean(process.defaultApp),
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

  function createAzureWorkspaceReviewPanels(tabTemplates = []) {
    const preferredTemplates = ["shell", "claude", "codex"];
    const selected = [];

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
    createAzureWorkspaceReviewPanels,
    findWorkspace,
  });
  const {
    getAzureWorkspace,
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

  function getPayload() {
    const state = getState();
    return {
      meta: {
        appVersion: packageVersion,
        repositoryUrl: APP_CONFIG.app.repositoryUrl,
        versionCheck: versionChecker.getCachedResult(),
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
      workspace: sessions.getWorkspace(state),
      attention: {
        byWorkspace: Object.fromEntries(projectAlerts.entries()),
        byProject: Object.fromEntries(projectAlerts.entries()),
        activeWorkspace: projectAlerts.get(state.activeWorkspaceId) || null,
        activeProject: projectAlerts.get(state.activeProjectId) || null,
      },
      docker: docker.getSnapshot(),
      git: {
        workspaces: git.getProjectMap(),
        projects: git.getProjectMap(),
        activeWorkspace: git.getSnapshot(state.activeWorkspaceId),
        activeProject: git.getSnapshot(state.activeProjectId),
        connections: getAllProviderConnections(state).map((c) => ({
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
      // Set signal so idle detection tracks the injected prompt correctly
      const signal = sessionSignals.get(sessionId);
      if (signal) {
        signal.busy = true;
        signal.hasUserInput = true;
        signal.waitingRaised = false;
      }
    },
    getState,
    broadcastState,
    raiseAlert({ projectId, panelId, sessionId, title, kind, detail, tier, urgency, exitCode }) {
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

  async function ensureRemoteOriginReady(remoteConfig) {
    const originUrl = createTunnelOriginUrl(remoteConfig);
    await checkRemoteOriginImpl(originUrl);
    return originUrl;
  }

  function clearAlertSession(sessionId) {
    const descriptor = parseSessionId(sessionId);
    if (!descriptor) {
      return false;
    }

    const current = projectAlerts.get(descriptor.workspaceId);
    if (!current?.alerts?.some((alert) => alert.panelId === descriptor.panelId)) {
      return false;
    }

    clearProjectAlerts(descriptor.workspaceId, descriptor.panelId);
    resetSessionSignal(sessionId);
    return true;
  }

  function clearProjectAlerts(projectId, panelId = null) {
    if (!projectId || !projectAlerts.has(projectId)) {
      return;
    }

    if (!panelId) {
      log.trace("clearing all alerts for project", { projectId });
      projectAlerts.delete(projectId);
      return;
    }
    log.trace("clearing alert", { projectId, panelId });

    const current = projectAlerts.get(projectId);
    const nextAlerts = current.alerts.filter((alert) => alert.panelId !== panelId);
    if (!nextAlerts.length) {
      projectAlerts.delete(projectId);
      return;
    }

    projectAlerts.set(projectId, {
      ...current,
      count: nextAlerts.length,
      alerts: nextAlerts,
    });
  }

  function addProjectAlert({
    projectId,
    panelId,
    sessionId,
    title,
    exitCode = null,
    kind = "completed",
    detail = "",
    tier = 1,
    urgency = "normal",
  }) {
    log.debug("addProjectAlert", { projectId, panelId, sessionId, title, kind, tier, urgency, detail, exitCode });
    const current = projectAlerts.get(projectId) || {
      count: 0,
      latestAt: null,
      alerts: [],
    };
    const nextAlerts = [
      {
        projectId,
        panelId,
        sessionId,
        title,
        exitCode,
        kind,
        tier,
        urgency,
        detail,
        at: new Date().toISOString(),
      },
      ...current.alerts.filter((alert) => alert.panelId !== panelId),
    ].slice(0, APP_CONFIG.runtime.projectAlertLimit);

    projectAlerts.set(projectId, {
      count: nextAlerts.length,
      latestAt: nextAlerts[0]?.at || null,
      alerts: nextAlerts,
    });
  }

  function getSessionSignal(sessionId, project, panel) {
    const isNew = !sessionSignals.has(sessionId);
    const current = sessionSignals.get(sessionId) || createSessionSignal(sessionId);
    if (!current.agentLike) {
      const wasAgent = current.agentLike;
      current.agentLike = AGENT_NAME_RE.test(panel?.command || "") || AGENT_NAME_RE.test(panel?.title || "");
      if (!wasAgent && current.agentLike) {
        log.debug("session classified as agent-like", { sessionId, command: panel?.command, title: panel?.title });
      }
    }
    if (isNew) {
      log.trace("session signal created", { sessionId, agentLike: current.agentLike });
    }
    sessionSignals.set(sessionId, current);
    return current;
  }

  /**
   * Phase 2 § 3.2.4. Accumulate typed characters and, on Enter, classify
   * the completed command.  Simple heuristic — handles printable keystrokes
   * and basic backspace; ignores arrow keys / escape sequences (they don't
   * change the command text for classification purposes).
   */
  function updateCommandClassFromInput(signal, data) {
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
  function isInInteractionGrace(signal, notifConfig) {
    if (!signal?.lastUserInteractionAt) return false;
    const graceMs = notifConfig?.userInteractionGraceMs ?? 10_000;
    return Date.now() - signal.lastUserInteractionAt < graceMs;
  }

  function cancelPromptTimer(signal) {
    if (!signal?.promptTimer) {
      return;
    }
    clearTimeout(signal.promptTimer);
    signal.promptTimer = null;
  }

  function resetSessionSignal(sessionId) {
    const signal = sessionSignals.get(sessionId);
    if (!signal) {
      return;
    }
    const wasBusy = signal.busy;
    const wasWaiting = signal.waitingRaised;
    cancelPromptTimer(signal);
    signal.busy = false;
    signal.waitingRaised = false;
    signal.outputBursts = 0;
    signal.lastOutputAt = 0;
    signal.lastHookAlertAt = 0;
    if (wasBusy || wasWaiting) {
      log.trace("session signal reset", { sessionId, wasBusy, wasWaiting });
    }
  }

  function deleteSessionSignal(sessionId) {
    const signal = sessionSignals.get(sessionId);
    cancelPromptTimer(signal);
    sessionSignals.delete(sessionId);
    adaptiveForget(sessionId);
  }

  /**
   * Unified alert primitive — all callers go through here.
   *
   * @param {Object} spec
   * @param {string} spec.sessionId
   * @param {string} spec.projectId
   * @param {string} spec.panelId
   * @param {string} spec.title
   * @param {"waiting"|"completed"|"info"} [spec.kind="waiting"]
   * @param {1|2|3} [spec.tier=1]                 — 1 authoritative (hooks, OSC133;D, BEL, exit, task-runner)
   *                                                 2 strong (explicit patterns, confirmed)
   *                                                 3 weak (silence + pattern heuristic)
   * @param {"normal"|"urgent"} [spec.urgency="normal"]  — urgent bypasses cooldown + waitingRaised latch
   * @param {string} [spec.detail=""]
   * @param {number|null} [spec.exitCode=null]
   * @returns {boolean} true if alert was raised, false if suppressed (e.g. duplicate)
   */
  function raiseAlert({
    sessionId,
    projectId,
    panelId,
    title,
    kind = "waiting",
    tier = 1,
    urgency = "normal",
    detail = "",
    exitCode = null,
  }) {
    const signal = sessionSignals.get(sessionId);

    // Duplicate suppression for "waiting" — each session can have one pending
    // waiting alert at a time.  Urgent bypasses (e.g. permission prompt
    // arrives after an idle prompt within cooldown).
    if (kind === "waiting" && urgency !== "urgent" && signal?.waitingRaised) {
      log.trace("raiseAlert skipped: waiting already raised", { sessionId, detail });
      return false;
    }

    log.info("ALERT raised", { sessionId, projectId, panelId, title, kind, tier, urgency, detail, exitCode });
    // Plan § 3.5: when notifications.debug is on, emit a structured decision
    // trace at info level so users can diagnose false positives without
    // rebuilding with a different log level. Runs only when flag is enabled.
    if (getNotificationConfig().debug) {
      log.info("[notif-debug] alert-raised", {
        sessionId,
        tier,
        urgency,
        kind,
        detail,
        commandClass: signal?.commandClass || "",
        hookCapable: signal?.hookCapable || false,
        outputBursts: signal?.outputBursts || 0,
        lastHookType: signal?.lastHookType || "",
      });
    }
    metricsRecordAlert({ tier, kind, urgency, commandClass: signal?.commandClass || "" });
    addProjectAlert({
      projectId,
      panelId,
      sessionId,
      title,
      kind,
      tier,
      urgency,
      detail,
      exitCode,
    });
    if (signal) {
      if (kind === "waiting") {
        signal.waitingRaised = true;
      }
      signal.busy = false;
      signal.lastAlertAt = Date.now();
      signal.everAlerted = true;
      // Reset output-burst counter so "substantial output since last alert"
      // means output that ARRIVED AFTER the user was alerted. Without this,
      // bursts that led up to the alert (e.g. the response text just before
      // Claude's Stop hook) remain counted, causing the repeat-idle_prompt
      // suppression below to think there's been new activity — so a redundant
      // idle_prompt right after a Stop/completed alert would slip through.
      signal.outputBursts = 0;
    }
    broadcastState();
    return true;
  }

  /**
   * Back-compat wrapper — existing callers that only know about "waiting"
   * alerts keep working.  Prefer `raiseAlert` for new code.
   */
  function raiseWaitingAlert({ sessionId, projectId, panelId, title, detail, urgency = "normal" }) {
    return raiseAlert({
      sessionId,
      projectId,
      panelId,
      title,
      kind: "waiting",
      tier: 1,
      urgency,
      detail,
    });
  }

  function ensureVisibleSession(workspaceId = getState().activeWorkspaceId) {
    const state = getState();
    const workspace = state.workspaces.find((w) => w.id === workspaceId);
    if (!workspace) return null;
    if (workspace.kind === "azure") {
      return null;
    }
    // Start all panels with "default" startup (not just the active one)
    for (const panel of workspace.panels) {
      if (panel.startup === APP_CONFIG.ui.defaultPanelStartup && !/^https?:\/\//i.test(panel.command || "")) {
        sessions.ensureSession(state, `${workspace.id}:${panel.id}`);
      }
    }
    return sessions.resolveDefaultSessionId(state, workspaceId);
  }

  function syncSessionSignalsWithState() {
    const validSessionIds = new Set(
      getState().workspaces.flatMap((workspace) =>
        workspace.panels.map((panel) => createSessionId(workspace.id, panel.id)),
      ),
    );
    for (const sessionId of [...sessionSignals.keys()]) {
      if (!validSessionIds.has(sessionId)) {
        deleteSessionSignal(sessionId);
      }
    }
  }

  function isKnownPluginProject(project) {
    if (!project) {
      return false;
    }
    if (project.source === "plugin" || project.pluginId) {
      return true;
    }

    return pluginManager.getPlugins().some((plugin) => {
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

  function shouldTrackProjectAlert(project, panel) {
    return Boolean(
      project &&
      panel &&
      (project.kind === "terminal" || project.kind === "task") &&
      !isKnownPluginProject(project) &&
      !panel.launch?.file &&
      panel.shell !== false,
    );
  }

  function updateVisibleSessions(nextIds) {
    const prev = attentionContext.visibleSessionIds;
    const next = new Set(nextIds);
    log.trace("updateVisibleSessions", { prev: [...prev], next: [...next] });
    const now = Date.now();
    for (const sessionId of prev) {
      if (!next.has(sessionId)) {
        attentionContext.recentlyVisibleUntil.set(sessionId, now + ATTENTION_VISIBILITY_GRACE_MS);
      }
    }
    for (const sessionId of next) {
      attentionContext.recentlyVisibleUntil.delete(sessionId);
    }
    // Prune expired grace period entries
    for (const [sessionId, until] of attentionContext.recentlyVisibleUntil) {
      if (now >= until) attentionContext.recentlyVisibleUntil.delete(sessionId);
    }
    attentionContext.visibleSessionIds = next;
  }

  function isSessionVisible(sessionId) {
    if (attentionContext.visibleSessionIds.has(sessionId)) return true;
    const until = attentionContext.recentlyVisibleUntil.get(sessionId);
    return until != null && Date.now() < until;
  }

  sessions.on("terminal:data", (payload) => {
    const descriptor = parseSessionId(payload.sessionId);
    const state = getState();
    const project = descriptor ? findWorkspace(state, descriptor.workspaceId) : null;
    const panel = project?.panels.find((item) => item.id === descriptor?.panelId) || null;
    if (descriptor && shouldTrackProjectAlert(project, panel)) {
      const signal = getSessionSignal(payload.sessionId, project, panel);
      const notifConfig = getNotificationConfig(state);
      const rawText = String(payload.data || "");
      const cleanText = stripAnsi(rawText);
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

      // --- OSC 133;D: shell integration command-finished signal ---
      // When a shell with integration (bash/zsh/PowerShell) emits OSC 133;D,
      // the previous command has finished and the shell prompt has returned.
      // This gives us instant, reliable detection for shell-hosted agents.
      if (OSC133_COMMAND_FINISHED_RE.test(rawText)) {
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
          !signal._hookMissingWarned &&
          signal.lastOutputAt > 0 &&
          Date.now() - signal.lastOutputAt < 30_000 &&
          signal.lastAlertAt > 0 &&
          Date.now() - signal.lastAlertAt > 60_000
        ) {
          log.warn("agent session has been active >60s with no hook event — hook may be misconfigured", {
            sessionId: payload.sessionId,
            agentLike: signal.agentLike,
          });
          signal._hookMissingWarned = true;
        }

        if (hooksEnabled) {
          // --- Hook-primary mode: suppress bell/silence, use 2min fallback ---
          // Record output time; the self-rescheduling timer checks this lazily
          // instead of cancel+restart on every PTY chunk.
          signal.lastOutputAt = Date.now();

          if (signal.busy && !inCooldown && signal.hasUserInput && !signal.promptTimer) {
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

            if (signal.busy && !inCooldown && signal.hasUserInput && !hookActive && !signal.promptTimer) {
              // Phase 3 § 3.2.6: adaptive multiplier reduces noise for
              // sessions the user keeps dismissing.
              // For task sessions, use the provider's idleTimeoutMs (e.g. 8s for
              // Codex/Gemini vs the global 20s agentQuietMs).
              const providerIdleMs = taskRunner.getIdleTimeout(payload.sessionId);
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

  sessions.on("terminal:exit", (payload) => {
    log.debug("terminal:exit", {
      sessionId: payload.sessionId,
      exitCode: payload.exitCode,
      intentional: payload.intentional,
    });
    // Notify task runner of session exit
    taskRunner.onSessionExit(payload.sessionId);
    const descriptor = parseSessionId(payload.sessionId);
    const state = getState();
    const project = descriptor ? findWorkspace(state, descriptor.workspaceId) : null;
    const panel = project?.panels.find((item) => item.id === descriptor?.panelId) || null;
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
      classAllowsExit;
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
    deleteSessionSignal(payload.sessionId);
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
  let reviewBridgeWatcher = null;
  let reviewBridgeDebounce = null;
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
  let reviewBridgePoll = setInterval(() => {
    const currentVersion = reviewBridgeStore.getDataVersion?.() || 0;
    if (currentVersion !== reviewBridgeDataVersion) {
      onReviewBridgeChange();
    }
  }, 3000);

  async function refreshDocker() {
    return docker.refresh();
  }

  async function refreshGit(projectId = null) {
    git.invalidateSnapshotCache?.(projectId || null);
    const state = getState();
    const workspaces = state.workspaces.filter(
      (workspace) => (!projectId || workspace.id === projectId) && workspace.kind !== "azure",
    );
    return git.refreshWorkspaces ? git.refreshWorkspaces(workspaces) : git.refreshProjects(workspaces);
  }

  function resolveGitWorkspace(workspaceId = null, projectId = null) {
    const targetWorkspaceId = workspaceId || projectId || getState().activeWorkspaceId || getState().activeProjectId;
    const workspace = findWorkspace(getState(), targetWorkspaceId);
    if (!workspace?.cwd) {
      throw new Error("Workspace not found or has no working directory.");
    }
    return workspace;
  }

  async function runGitWorkspaceAction(workspace, actionPromise) {
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

    const toAdd = [];
    const toRemove = [];
    const toRepair = []; // { id, profileId }

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
            panels: parent.panels.map((p) => ({
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

    await store.mutate((draft) => {
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
        log.warn("worktree sync error", { err: error.message });
      }
    }, APP_CONFIG.runtime.gitPollMs);
  }

  const pluginManager = await createPluginManagerImpl({
    pluginsDir,
    builtinPluginsDir: builtinPluginsDir || null,
    runtime: null, // Will be set after construction
  });

  async function runInitialRefresh() {
    await refreshDocker();
    await refreshGit();
    await refreshAzure();
    scheduleAzurePolling();
    await refreshGitHub();
    scheduleGitHubPolling();
    await syncWorktrees();
    await tunnel.refreshAvailability();
  }

  await ensureNotifyScript(userDataPath).catch(() => {});
  await startAgentNotifyServer();
  ensureDockerPolling();
  ensureGitPolling();
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
    runGitWorkspaceAction,
    syncWorktrees,
  });

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
    getAzureSettings,
    getAzureConnections,
    getGitHubSettings,
    getGitHubConnections,
  });

  return {
    ...providerHandlers,
    ...gitHandlers,
    on(channel, handler) {
      events.on(channel, handler);
      return () => events.off(channel, handler);
    },
    getPayload,
    getRemoteInfo() {
      return remoteInfo;
    },
    setRemoteInfo(nextRemoteInfo) {
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
        log.error("getInitialState failed", { err: error.message });
        throw error;
      }
    },
    async activateWorkspace(workspaceId) {
      await store.mutate((draft) => {
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
            : workspace.panels.map((panel) => createSessionId(workspaceId, panel.id)),
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
    async activateProject(projectId) {
      return this.activateWorkspace(projectId);
    },
    async activateSession(sessionId) {
      const descriptor = parseSessionId(sessionId);
      if (!descriptor) {
        return getPayload();
      }

      await store.mutate((draft) => {
        const workspace = findWorkspace(draft, descriptor.workspaceId);
        if (!workspace) {
          return;
        }

        draft.activeWorkspaceId = descriptor.workspaceId;
        if (workspace.panels.some((panel) => panel.id === descriptor.panelId)) {
          workspace.activePanelId = descriptor.panelId;
          workspace.activeViewId = sessionId;
        }
      });

      sessions.ensureSession(getState(), sessionId);
      broadcastState();
      return getPayload();
    },
    async setWorkspaceUIState(workspaceId, uiState) {
      if (!workspaceId || !uiState || typeof uiState !== "object") {
        return getPayload();
      }
      const { activeViewId, splitLayout, splitViewIds } = uiState;
      let changed = false;
      await store.mutate((draft) => {
        const workspace = findWorkspace(draft, workspaceId);
        if (!workspace) return;
        if (typeof activeViewId === "string") {
          workspace.activeViewId = activeViewId;
          const sessionPrefix = `${workspaceId}:`;
          if (activeViewId.startsWith(sessionPrefix)) {
            const panelId = activeViewId.slice(sessionPrefix.length);
            if (workspace.panels.some((panel) => panel.id === panelId)) {
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
      });
      if (changed) broadcastState();
      return getPayload();
    },
    async saveWorkspace(workspace) {
      // Ensure the working directory exists (create if needed)
      if (workspace.cwd && workspace.kind !== "docker") {
        await mkdir(workspace.cwd, { recursive: true }).catch(() => {});
      }

      await store.mutate((draft) => {
        const normalized = normalizeWorkspace(workspace);
        const index = draft.workspaces.findIndex((item) => item.id === normalized.id);
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
    async saveProject(project) {
      return this.saveWorkspace(project);
    },
    async deleteWorkspace(workspaceId, options = {}) {
      const state = getState();
      const workspace = findWorkspace(state, workspaceId);

      // Clean up task runner files for task workspaces
      if (workspace?.kind === "task" && workspace.task?.taskId && workspace.cwd) {
        taskRunner.stopTask(workspaceId);
        await taskRunner.cleanupTaskFiles(workspace.cwd, workspace.task.taskId);
      }

      await store.mutate((draft) => {
        draft.workspaces = draft.workspaces.filter((item) => item.id !== workspaceId);
        if (draft.activeWorkspaceId === workspaceId) {
          draft.activeWorkspaceId = draft.workspaces[0]?.id || null;
        }
      });

      const sessionsExited = sessions.removeWorkspaceSessions(workspaceId);
      for (const sessionId of [...sessionSignals.keys()]) {
        if (sessionId.startsWith(`${workspaceId}:`)) {
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
            diskDeleteError = `Could not delete ${diskPath}: ${err?.message || err}`;
            log.warn("workspace disk delete failed", { diskPath, err: diskDeleteError });
          } finally {
            pendingWorktreeDeletions.delete(diskPath);
          }
        }
      }

      await refreshGit();
      ensureVisibleSession();
      broadcastState();
      const result = getPayload();
      if (diskDeleteError) {
        result.deleteWorkspaceError = diskDeleteError;
      }
      return result;
    },
    async deleteProject(projectId) {
      return this.deleteWorkspace(projectId);
    },
    async reorderWorkspaces(workspaceIds) {
      await store.mutate((draft) => {
        draft.workspaces = workspaceIds
          .map((id) => draft.workspaces.find((workspace) => workspace.id === id))
          .filter(Boolean);
      });

      broadcastState();
      return getPayload();
    },
    async reorderProjects(projectIds) {
      return this.reorderWorkspaces(projectIds);
    },
    async updateSettings(settings) {
      const previousConfig = getState().settings.remoteAccess;
      await store.mutate((draft) => {
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
        };
        // Keep tabTemplates out of the settings object
        delete draft.settings.tabTemplates;
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
      await store.mutate((draft) => {
        draft.settings.remoteAccess.token = createAccessToken();
      });

      events.emit("remote:config-changed", clone(getState().settings.remoteAccess));
      broadcastState();
      return getPayload();
    },
    closeSession(sessionId) {
      clearAlertSession(sessionId);
      deleteSessionSignal(sessionId);
      sessions.removeSession(sessionId);
      broadcastState();
      return getPayload();
    },
    resizeSession(sessionId, size) {
      sessions.resizeSession(sessionId, size.cols, size.rows);
    },
    writeToSession(sessionId, data) {
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
    notifyAgentHook(sessionId, notificationType = "idle_prompt", hook = "Notification") {
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
    async runHookProbe({ detectStatus, configure }) {
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
      let spawnError = null;
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
        return { ok: false, reason: "spawn-failed", detail: err.message };
      }

      const result = await receivedPromise;
      const elapsedMs = Date.now() - startedAt;

      if (result?.ok) return { ok: true, elapsedMs };
      if (spawnError) {
        return { ok: false, reason: "spawn-error", detail: spawnError.message, elapsedMs };
      }

      // Timeout — surface hook.log tail so the user can see what happened.
      let logTail = "";
      try {
        const logPath = path.join(os.homedir(), ".strideterm", "logs", "hook.log");
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
    clearAlertForSession(sessionId, { dismissed = false } = {}) {
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
    syncAttentionContext({ visibleSessionIds = [], windowFocused = true } = {}) {
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
    async restartSession(sessionId) {
      const descriptor = parseSessionId(sessionId);
      await store.mutate((draft) => {
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
    async dockerAction(action, containerId) {
      const allowedActions = new Set(["start", "stop", "restart", "remove"]);
      if (!allowedActions.has(action)) {
        throw new Error(`Invalid Docker action: ${action}`);
      }
      await docker.performAction(action, containerId);
      return getPayload();
    },
    async openDockerSession({ workspaceId, projectId, containerId, mode }) {
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

      await store.mutate((draft) => {
        const workspace = findWorkspace(draft, targetWorkspaceId);
        if (!workspace) {
          throw new Error("Docker workspace not found.");
        }

        const existing = workspace.panels.find((panel) => panel.id === panelId);
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
          workspace.panels.push(nextPanel);
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
    async openLazydockerSession({ workspaceId, projectId }) {
      const targetWorkspaceId = workspaceId || projectId;
      await refreshDocker();
      const launch = docker.createLazydockerLaunch();
      if (!launch) {
        throw new Error("Lazydocker is not available in the active Docker environment.");
      }

      const panelId = "lazydocker";
      await store.mutate((draft) => {
        const workspace = findWorkspace(draft, targetWorkspaceId);
        if (!workspace) {
          throw new Error("Docker workspace not found.");
        }

        const existing = workspace.panels.find((panel) => panel.id === panelId);
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
          workspace.panels.push(nextPanel);
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
    async openLazygitSession({ workspaceId, projectId }) {
      const targetWorkspaceId = workspaceId || projectId;
      await refreshGit(targetWorkspaceId);
      const launch = git.createLazygitLaunch(targetWorkspaceId);
      if (!launch) {
        throw new Error("Lazygit is not available for this workspace.");
      }

      const panelId = "lazygit";
      await store.mutate((draft) => {
        const workspace = findWorkspace(draft, targetWorkspaceId);
        if (!workspace) {
          throw new Error("Workspace not found.");
        }

        const existing = workspace.panels.find((panel) => panel.id === panelId);
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
          workspace.panels.push(nextPanel);
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
    async createWorktree({ workspaceId, projectId, name }) {
      const targetWorkspaceId = workspaceId || projectId;
      if (!name || !/^[a-zA-Z0-9._-]+$/.test(name)) {
        throw new Error("Worktree name must contain only alphanumeric characters, dots, hyphens, or underscores.");
      }
      const project = findWorkspace(getState(), targetWorkspaceId);
      if (!project?.cwd) throw new Error("Workspace has no working directory");

      const treePath = path.join(project.cwd, ".strideterm", "tree", name);

      // Ensure .strideterm/ in .gitignore
      const gitignorePath = path.join(project.cwd, ".gitignore");
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

      // git worktree add
      await execFileTextImpl("git", ["worktree", "add", treePath, "-b", name], { cwd: project.cwd });

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
        panels: project.panels.map((p) => ({
          ...p,
          id: `panel-${randomUUID()}`,
        })),
      });

      await store.mutate((draft) => {
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
    async saveProfile(profile) {
      await store.mutate((draft) => {
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
    async deleteProfile(profileId) {
      await store.mutate((draft) => {
        draft.profiles = draft.profiles.filter((p) => p.id !== profileId);
        if (draft.profiles.length === 0) {
          draft.profiles.push({ id: "default", name: "Default", workspaceIds: [] });
        }
        if (draft.activeProfileId === profileId) {
          draft.activeProfileId = draft.profiles[0]?.id || "default";
        }
      });
      broadcastState();
      return getPayload();
    },
    async activateProfile(profileId) {
      await store.mutate((draft) => {
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
    getPluginWorkspaceTemplate(pluginId) {
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
      // State is already persisted on each mutate/replace operation.
      // Avoid rewriting the file on shutdown, which can overwrite newer
      // on-disk state if another instance touched it more recently.
      return undefined;
    },
    listRemoteUrls() {
      return remoteInfo?.urls || [];
    },
    getSessionId(workspaceId, panelId) {
      return createSessionId(workspaceId, panelId);
    },
    async checkForUpdates() {
      const result = await versionChecker.checkForUpdates(true);
      broadcastState();
      return result;
    },
    async checkCommand(command) {
      try {
        const cmd = process.platform === "win32" ? "where" : "which";
        await execFileText(cmd, [command], { timeout: 5000 });
        return true;
      } catch (err) {
        log.debug("checkCommand: not found", { command, err: err.error?.message || err.message || "unknown" });
        return false;
      }
    },

    // --- Task runner API ---
    async recheckClaude() {
      const available = await recheckClaudeAvailability();
      return { available, payload: getPayload() };
    },
    async checkProviders() {
      const results = {};
      for (const ProviderClass of getAllProviders()) {
        try {
          results[ProviderClass.id] = await new ProviderClass().checkAvailability();
        } catch (err) {
          results[ProviderClass.id] = { available: false, error: err.message };
        }
      }
      return results;
    },
    // Lightweight probe used by the task workspace dialog to decide whether
    // "Create in git worktree" makes sense for the chosen cwd. Treats any
    // failure (non-existent path, not a git repo, git CLI missing) as
    // "not a repo" — the caller just wants a boolean to gate the checkbox.
    async checkIsGitRepo(cwd) {
      const trimmed = String(cwd || "").trim();
      if (!trimmed) return { isGitRepo: false, reason: "empty" };
      try {
        const { stdout } = await execFileTextImpl("git", ["rev-parse", "--is-inside-work-tree"], { cwd: trimmed });
        return { isGitRepo: stdout.trim() === "true" };
      } catch (err) {
        const stderr = err?.stderr?.trim() || err?.error?.message || "";
        if (stderr.includes("not a git repository")) return { isGitRepo: false, reason: "not-a-repo" };
        // Could not even run git — treat as "unknown" so the dialog stays
        // permissive rather than blocking based on a transient failure.
        return { isGitRepo: false, reason: "error", error: stderr || "unknown error" };
      }
    },
    async createTaskWorkspace(config) {
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
          const stderr = err.stderr?.trim() || err.error?.message || err.message || "";
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

      // Write task files immediately so they're available in the Dashboard.
      // If this fails (disk full, permissions), don't persist a broken workspace.
      try {
        await taskRunner.writeInitialFiles(workspace.cwd, workspace.task);
      } catch (err) {
        log.error("createTaskWorkspace: failed to write initial task files", {
          workspaceId: workspace.id,
          cwd: workspace.cwd,
          err: err.message,
        });
        throw new Error(`Failed to create task files: ${err.message}`, { cause: err });
      }
      // saveWorkspace normalizes and persists
      await this.saveWorkspace(workspace);
      // Activate the new workspace
      await this.activateWorkspace(workspace.id);
      return { workspaceId: workspace.id, cwdWarning, payload: getPayload() };
    },
    async startTask(workspaceId) {
      const result = await taskRunner.startTask(workspaceId);
      return { ok: result, payload: getPayload() };
    },
    stopTask(workspaceId) {
      const result = taskRunner.stopTask(workspaceId);
      return { ok: result, payload: getPayload() };
    },
    pauseTask(workspaceId) {
      const result = taskRunner.pauseTask(workspaceId);
      return { ok: result, payload: getPayload() };
    },
    resumeTask(workspaceId) {
      const result = taskRunner.resumeTask(workspaceId);
      return { ok: result, payload: getPayload() };
    },
    async resetTask(workspaceId) {
      const result = await taskRunner.resetTask(workspaceId);
      return { ok: result, payload: getPayload() };
    },
    getTaskStatus(workspaceId) {
      return taskRunner.getTaskState(workspaceId);
    },
  };
}
