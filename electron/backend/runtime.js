import http from "node:http";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { watch } from "node:fs";
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
import { AgentTaskRunner } from "./agent-task-runner.js";
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
  createSessionSignal,
  detectTerminalEnvironment as detectTerminalEnvironmentImpl,
  OSC133_COMMAND_FINISHED_RE,
  AGENT_NAME_RE,
  AGENT_OUTPUT_RE,
  AGENT_OUTPUT_BURST_THRESHOLD,
  HOOK_FALLBACK_SILENCE_MS,
  ATTENTION_MIN_DISPLAY_MS,
  ATTENTION_VISIBILITY_GRACE_MS,
  WAITING_PATTERNS,
} from "./runtime-utils.js";
import { APP_CONFIG } from "../../config/app-config.js";
import { createVersionChecker } from "./version-checker.js";
import { initLogger, getLogger, setLogLevel, reconfigureLogger } from "./logger.js";

const log = getLogger("runtime");

const require = createRequire(import.meta.url);
const { version: packageVersion = "0.0.0" } = require("../../package.json");
const reviewBridgeCliPath = fileURLToPath(new URL("./review-bridge-cli.js", import.meta.url));

// Utilities imported from runtime-utils.js

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

  const sessions = new SessionManagerImpl({
    getSessionEnv: ({ workspace, sessionId }) => {
      const env = {};

      // Disable Claude Code background/scheduled tasks in task workspaces.
      // The task runner controls the lifecycle — autonomous background work
      // would interfere with the worker/judge evaluation cycle.
      if (workspace?.kind === "task") {
        env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS = "1";
      }

      // Agent notification hook URL
      if (notifyServerHandle?.port && sessionId) {
        env.STRIDETERM_NOTIFY_URL = buildNotifyUrl(notifyServerHandle.port, sessionId, notifySecret);
        log.debug("injected STRIDETERM_NOTIFY_URL", { sessionId, port: notifyServerHandle.port });
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

  function handleAgentHookNotification({ sessionId, notificationType }) {
    log.trace("agent hook notification received", { sessionId, notificationType });
    if (!sessionId) {
      log.trace("hook ignored: no sessionId");
      return;
    }
    const signal = sessionSignals.get(sessionId);
    if (!signal) {
      log.trace("hook ignored: no signal for session", { sessionId });
      return;
    }
    if (!signal.hasUserInput) {
      log.trace("hook ignored: no user input yet", {
        sessionId,
        hasUserInput: signal.hasUserInput,
        busy: signal.busy,
        agentLike: signal.agentLike,
      });
      return;
    }
    if (signal.waitingRaised) {
      log.trace("hook ignored: waiting already raised", { sessionId });
      return;
    }

    const relevantTypes = new Set(["idle_prompt", "permission_prompt"]);
    if (!relevantTypes.has(notificationType)) {
      log.debug("hook ignored: irrelevant type", { sessionId, notificationType });
      return;
    }

    const descriptor = parseSessionId(sessionId);
    if (!descriptor) return;

    const state = getState();
    const notifConfig = getNotificationConfig(state);
    const now = Date.now();
    const inCooldown = signal.lastAlertAt > 0 && now - signal.lastAlertAt < notifConfig.alertCooldownMs;
    if (inCooldown) {
      log.debug("hook ignored: cooldown active", {
        sessionId,
        cooldownMs: notifConfig.alertCooldownMs,
        remainingMs: notifConfig.alertCooldownMs - (now - signal.lastAlertAt),
      });
      return;
    }

    signal.lastHookAlertAt = now;
    cancelPromptTimer(signal);

    // Task runner intercept: if session belongs to a running task, let task runner handle it
    if (taskRunner.onAgentIdle(sessionId)) {
      log.debug("hook handled by task runner", { sessionId });
      return;
    }

    if (isSessionVisible(sessionId)) {
      log.trace("hook: session visible, resetting signal", { sessionId });
      resetSessionSignal(sessionId);
      return;
    }

    const project = findWorkspace(state, descriptor.workspaceId);
    const panel = project?.panels.find((p) => p.id === descriptor.panelId) || null;
    const detail = notificationType === "permission_prompt" ? "agent-hook-permission" : "agent-hook-idle";

    log.info("agent hook raising alert", { sessionId, notificationType, detail, title: panel?.title });
    raiseWaitingAlert({
      sessionId,
      projectId: descriptor.workspaceId,
      panelId: descriptor.panelId,
      title: panel?.title || descriptor.panelId,
      detail,
    });
  }

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
      log.info("stopping notify server");
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
    raiseAlert({ projectId, panelId, sessionId, title, kind, detail }) {
      addProjectAlert({ projectId, panelId, sessionId, title, kind, detail });
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

  function addProjectAlert({ projectId, panelId, sessionId, title, exitCode = null, kind = "completed", detail = "" }) {
    log.debug("addProjectAlert", { projectId, panelId, sessionId, title, kind, detail, exitCode });
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
  }

  function raiseWaitingAlert({ sessionId, projectId, panelId, title, detail }) {
    const signal = sessionSignals.get(sessionId);
    if (signal?.waitingRaised) {
      log.trace("raiseWaitingAlert skipped: already raised", { sessionId, detail });
      return false;
    }

    log.info("ALERT raised", { sessionId, projectId, panelId, title, detail, kind: "waiting" });
    addProjectAlert({
      projectId,
      panelId,
      sessionId,
      title,
      kind: "waiting",
      detail,
    });
    if (signal) {
      signal.waitingRaised = true;
      signal.busy = false;
      signal.lastAlertAt = Date.now();
    }
    broadcastState();
    return true;
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
      const lastLineLower = lastLine.toLowerCase();

      if (AGENT_OUTPUT_RE.test(cleanText)) {
        signal.agentLike = true;
      }

      // --- OSC 133;D: shell integration command-finished signal ---
      // When a shell with integration (bash/zsh/PowerShell) emits OSC 133;D,
      // the previous command has finished and the shell prompt has returned.
      // This gives us instant, reliable detection for shell-hosted agents.
      if (OSC133_COMMAND_FINISHED_RE.test(rawText) && signal.hasUserInput) {
        log.trace("OSC 133;D detected", { sessionId: payload.sessionId, busy: signal.busy });
        const now = Date.now();
        const inCooldown = signal.lastAlertAt > 0 && now - signal.lastAlertAt < notifConfig.alertCooldownMs;
        if (signal.busy && !inCooldown) {
          cancelPromptTimer(signal);
          if (taskRunner.onAgentIdle(payload.sessionId)) {
            log.trace("OSC 133;D: task runner handled idle", { sessionId: payload.sessionId });
          } else if (isSessionVisible(payload.sessionId)) {
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
        // Skip normal detection for this chunk — OSC 133;D is authoritative.
      } else if (signal.agentLike) {
        // --- Agent sessions: hook-preferred detection ---
        // When the notify server is running (hooks enabled), we trust hooks
        // as the primary signal and only use a long fallback silence timer.
        // When hooks are NOT available, we fall back to bell + silence detection.
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
              if (signal.lastOutputLine && !matchesAgentIdle(signal.lastOutputLine)) {
                log.trace("agent hook-primary fallback: last line not idle", {
                  sessionId: sid,
                  lastOutputLine: signal.lastOutputLine,
                });
                return;
              }
              // Task runner intercept BEFORE visibility check — task workspaces
              // may be visible while the runner is actively waiting for idle.
              if (taskRunner.onAgentIdle(sid)) {
                log.trace("hook-fallback silence: task runner handled idle", { sessionId: sid });
                return;
              }
              if (isSessionVisible(sid)) {
                log.trace("agent hook-primary fallback: session visible, resetting", { sessionId: sid });
                resetSessionSignal(sid);
                return;
              }
              log.info("agent hook-primary fallback: no hook arrived, raising alert", {
                sessionId: sid,
                fallbackMs: HOOK_FALLBACK_SILENCE_MS,
              });
              raiseWaitingAlert({
                sessionId: sid,
                projectId: descriptor.workspaceId,
                panelId: descriptor.panelId,
                title: panel?.title || descriptor.panelId,
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
              const quietMs =
                signal.outputBursts >= AGENT_OUTPUT_BURST_THRESHOLD
                  ? notifConfig.agentQuietFastMs
                  : notifConfig.agentQuietMs;
              const sid = payload.sessionId;
              signal.promptTimer = setTimeout(function silenceCheck() {
                const silentFor = Date.now() - (signal.lastOutputAt || 0);
                if (silentFor < quietMs) {
                  // Output arrived recently — reschedule for the remaining silence window
                  signal.promptTimer = setTimeout(silenceCheck, quietMs - silentFor);
                  return;
                }
                signal.promptTimer = null;
                if (signal.lastOutputLine && !matchesAgentIdle(signal.lastOutputLine)) {
                  log.trace("agent silence expired but last line not idle", {
                    sessionId: sid,
                    lastOutputLine: signal.lastOutputLine,
                  });
                  return;
                }
                // Task runner intercept BEFORE visibility check
                if (taskRunner.onAgentIdle(sid)) {
                  log.trace("agent silence: task runner handled idle", { sessionId: sid });
                  return;
                }
                if (isSessionVisible(sid)) {
                  log.trace("agent silence: session visible, resetting", { sessionId: sid });
                  resetSessionSignal(sid);
                  return;
                }
                log.debug("agent silence timer triggering alert", {
                  sessionId: sid,
                  quietMs,
                  lastOutputLine: signal.lastOutputLine,
                });
                raiseWaitingAlert({
                  sessionId: sid,
                  projectId: descriptor.workspaceId,
                  panelId: descriptor.panelId,
                  title: panel?.title || descriptor.panelId,
                  detail: "prompt-returned",
                });
              }, quietMs);
            }
          }
        }
      } else {
        // --- Non-agent sessions: prompt-pattern detection ---
        const explicitWaiting =
          rawText.includes("\u0007") || WAITING_PATTERNS.some((pattern) => pattern.test(lastLineLower));
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
            raiseWaitingAlert({
              sessionId: payload.sessionId,
              projectId: descriptor.workspaceId,
              panelId: descriptor.panelId,
              title: panel?.title || descriptor.panelId,
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
          signal.promptTimer = setTimeout(() => {
            signal.promptTimer = null;
            if (isSessionVisible(payload.sessionId)) {
              log.trace("prompt quiet expired: session visible, resetting", { sessionId: payload.sessionId });
              resetSessionSignal(payload.sessionId);
              return;
            }
            log.debug("prompt quiet timer triggering alert", { sessionId: payload.sessionId });
            raiseWaitingAlert({
              sessionId: payload.sessionId,
              projectId: descriptor.workspaceId,
              panelId: descriptor.panelId,
              title: panel?.title || descriptor.panelId,
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
    const shouldRaiseAlert =
      !payload.intentional &&
      descriptor &&
      shouldTrackProjectAlert(project, panel) &&
      signal?.hasUserInput &&
      !isSessionVisible(payload.sessionId);
    if (shouldRaiseAlert) {
      addProjectAlert({
        projectId: descriptor.workspaceId,
        panelId: descriptor.panelId,
        sessionId: payload.sessionId,
        title: panel?.title || descriptor.panelId,
        exitCode: payload.exitCode,
        kind: "completed",
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
        }
      });

      sessions.ensureSession(getState(), sessionId);
      broadcastState();
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
            await new Promise((resolve) => setTimeout(resolve, 1000));

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
              try {
                await execFileTextImpl("git", ["worktree", "prune"], { cwd: gitCwd });
              } catch {}
            }

            if (!gitRemoved) {
              for (let attempt = 0; attempt < 5; attempt++) {
                try {
                  await rm(diskPath, { recursive: true, force: true });
                  break;
                } catch (err) {
                  if (attempt < 4 && (err.code === "EBUSY" || err.code === "EPERM")) {
                    await new Promise((resolve) => setTimeout(resolve, 1500));
                    continue;
                  }
                  diskDeleteError = `Could not delete ${diskPath}: ${err?.message || err}`;
                  log.warn("workspace disk delete failed", { diskPath, err: diskDeleteError });
                }
              }
            }
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
      if (signal) signal.hasUserInput = true;
      // Pause task runner if user types during active evaluation
      taskRunner.onUserInput(sessionId);
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
    notifyAgentHook(sessionId, notificationType = "idle_prompt") {
      log.debug("notifyAgentHook called", { sessionId, notificationType });
      handleAgentHookNotification({ sessionId, notificationType, message: "", title: "" });
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
    syncAttentionContext({ visibleSessionIds = [] } = {}) {
      const nextIds = (Array.isArray(visibleSessionIds) ? visibleSessionIds : [])
        .map((sessionId) => String(sessionId || "").trim())
        .filter(Boolean);
      updateVisibleSessions(nextIds);

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
          // If branch already exists, try without -b (attach to existing branch)
          if (err.message?.includes("already exists") || err.stderr?.includes("already exists")) {
            await execFileTextImpl("git", ["worktree", "add", treePath, branch], { cwd: config.cwd });
          } else {
            throw new Error(`Failed to create git worktree: ${err.message}`, { cause: err });
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
