import http from "node:http";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { watch } from "node:fs";
import { readFile, writeFile, mkdir, readdir, access } from "node:fs/promises";
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
import { buildReviewAgentLaunch, buildMcpServerSpec } from "./review-bridge-agent-launch.js";
import { AzureDevOpsManager, normalizeConnectionInput, normalizeReviewRoot, shortPathKey } from "./azure-devops-manager.js";
import { APP_CONFIG } from "../../config/app-config.js";

const require = createRequire(import.meta.url);
const { version: packageVersion = "0.0.0" } = require("../../package.json");
const reviewBridgeCliPath = fileURLToPath(new URL("./review-bridge-cli.js", import.meta.url));

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function findWorkspace(state, workspaceId) {
  return state.workspaces.find((workspace) => workspace.id === workspaceId) || null;
}

function createAttentionContext() {
  return {
    visibleSessionIds: new Set(),
    recentlyVisibleUntil: new Map(),
  };
}

const ANSI_ESCAPE_RE = /\u001B\[[0-?]*[ -/]*[@-~]|\u001B\][^\u0007]*(?:\u0007|\u001B\\)|\u009B[0-?]*[ -/]*[@-~]/g;
const AGENT_NAME_RE = /\b(claude|codex|opencode|aider|gemini)\b/i;
const AGENT_OUTPUT_RE = /\b(claude code|openai codex|codex|claude)\b/i;
const PROMPT_QUIET_MS = 900;
const ATTENTION_MIN_DISPLAY_MS = 15_000;
const ATTENTION_VISIBILITY_GRACE_MS = 5_000;
const WAITING_PATTERNS = [
  /\bwaiting for input\b/i,
  /\bneeds your input\b/i,
  /\brequires your input\b/i,
  /\bpermission required\b/i,
  /\bapproval required\b/i,
  /\bapprove\b/i,
  /\bpress enter\b/i,
  /\bpress any key\b/i,
  /\bcontinue\?\s*$/i,
  /\bselect an option\b/i,
  /\bchoose an option\b/i,
  /\bwould you like to\b/i,
  /\bdo you want to\b/i,
  /\[[ yYnN/]+\]/,
];
const PROMPT_PATTERNS = [
  /^PS [^\n>]{0,200}>\s*$/,
  /^(?:\([^)\n]{1,80}\)\s*)?[^$\n]{1,180}[$#]\s*$/,
  /^(?:\([^)\n]{1,80}\)\s*)?.{0,180}[›❯➜]\s*$/,
];

function stripAnsi(value) {
  return String(value || "").replaceAll(ANSI_ESCAPE_RE, "");
}

function lastNonEmptyLine(value) {
  const lines = String(value || "").replaceAll("\r", "\n").split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (lines[index].trim()) {
      return lines[index].trimEnd();
    }
  }
  return "";
}

function matchesPrompt(line) {
  if (!line) {
    return false;
  }
  return PROMPT_PATTERNS_SAFE.some((pattern) => pattern.test(line));
}

function createSessionSignal(sessionId) {
  return {
    sessionId,
    busy: false,
    waitingRaised: false,
    agentLike: false,
    promptTimer: null,
  };
}

const PROMPT_PATTERNS_SAFE = [
  /^PS [^\n>]{0,200}>\s*$/,
  /^[A-Za-z]:[^\n]{0,180}>\s*$/,
  /^(?:\([^)\n]{1,80}\)\s*)?[^$\n]{1,180}[$#]\s*$/,
];

function createTunnelOriginUrl(remoteConfig = {}) {
  const rawHost = String(remoteConfig.host || "").trim();
  const host = !rawHost || rawHost === "0.0.0.0"
    ? "127.0.0.1"
    : (rawHost === "::" || rawHost === "[::]" ? "::1" : rawHost);
  const formattedHost = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  return `http://${formattedHost}:${remoteConfig.port}`;
}

function parseWindowsBuildNumber(release) {
  const normalized = String(release || "").trim();
  if (!normalized) {
    return null;
  }

  const parts = normalized.split(".");
  const buildNumber = Number.parseInt(parts[parts.length - 1], 10);
  return Number.isInteger(buildNumber) ? buildNumber : null;
}

export function detectTerminalEnvironment({ platform = process.platform, release = os.release() } = {}) {
  const environment = { platform };
  if (platform !== "win32") {
    return environment;
  }

  const buildNumber = parseWindowsBuildNumber(release);
  if (!Number.isInteger(buildNumber)) {
    return environment;
  }

  return {
    ...environment,
    windowsPty: {
      backend: buildNumber >= 18309 ? "conpty" : "winpty",
      buildNumber,
    },
  };
}

function probeRemoteOrigin(originUrl, timeoutMs = 1200) {
  const target = new URL(originUrl);
  return new Promise((resolve, reject) => {
    const request = http.request({
      hostname: target.hostname,
      port: target.port,
      path: "/",
      method: "GET",
      timeout: timeoutMs,
    }, (response) => {
      response.resume();
      response.once("end", () => resolve(response.statusCode || 0));
    });

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

export async function createRuntime({ userDataPath, builtinPluginsDir, getThemeSource, deferInitialRefresh = false, dependencies = {} }) {
  const createStoreImpl = dependencies.createStore || createStore;
  const createCredentialStoreImpl = dependencies.createCredentialStore || createCredentialStore;
  const createAzureReviewStoreImpl = dependencies.createAzureReviewStore || createAzureReviewStore;
  const createReviewBridgeStoreImpl = dependencies.createReviewBridgeStore || createReviewBridgeStore;
  const SessionManagerImpl = dependencies.SessionManager || SessionManager;
  const DockerManagerImpl = dependencies.DockerManager || DockerManager;
  const GitManagerImpl = dependencies.GitManager || GitManager;
  const TunnelManagerImpl = dependencies.CloudflareTunnelManager || CloudflareTunnelManager;
  const AzureDevOpsManagerImpl = dependencies.AzureDevOpsManager || AzureDevOpsManager;
  const createPluginManagerImpl = dependencies.createPluginManager || createPluginManager;
  const execFileTextImpl = dependencies.execFileText || execFileText;
  const checkRemoteOriginImpl = dependencies.checkRemoteOrigin || checkRemoteOrigin;
  const getTerminalEnvironmentImpl = dependencies.getTerminalEnvironment || detectTerminalEnvironment;
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
  const store = await createStoreImpl(statePath);
  const credentialStore = await createCredentialStoreImpl(credentialsPath, {
    safeStorage: dependencies.safeStorage || null,
  });
  const azureReviewStore = await createAzureReviewStoreImpl(azureReviewPath);
  const reviewBridgeStore = await createReviewBridgeStoreImpl(reviewBridgeRoot);
  const sessions = new SessionManagerImpl({
    getSessionEnv: ({ workspace }) => {
      if (workspace?.review?.provider !== "azure-devops" || !workspace.review?.prKey) {
        return {};
      }

      const context = reviewBridgeStore.getPullRequestContext?.(workspace.review.prKey);
      if (!context) {
        return {};
      }

      return {
        STRIDETERM_REVIEW_PROVIDER: context.provider || "azure-devops",
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
      if (workspace?.review?.provider !== "azure-devops" || !workspace.review?.prKey) {
        return null;
      }

      const context = reviewBridgeStore.getPullRequestContext?.(workspace.review.prKey);
      if (!context) {
        return null;
      }

      return buildReviewAgentLaunch({
        workspace,
        panel,
        context,
        processInfo,
      });
    },
  });
  const docker = new DockerManagerImpl();
  const git = new GitManagerImpl();
  const tunnel = new TunnelManagerImpl();
  const azure = new AzureDevOpsManagerImpl({
    credentialStore,
    reviewStore: azureReviewStore,
    reviewBridgeStore,
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

  function getState() {
    return store.getState();
  }

  function getAzureSettings(state = getState()) {
    return state.settings?.integrations?.azureDevops || {
      enabled: true,
      reviewRoot: path.join(os.homedir(), ".strideterm", "azure-pr"),
      defaultPollSeconds: 120,
      connections: [],
    };
  }

  function getAzureConnections(state = getState()) {
    const all = getAzureSettings(state).connections || [];
    const activeProfile = state.activeProfileId || "default";
    return all.filter((c) => !c.profileId || c.profileId === activeProfile);
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
      connectionPathKey: String(connectionPathKey || "").trim().toLowerCase(),
    };
  }

  function getAzureWorkspace(profileId = getState().activeProfileId || "default") {
    return getState().workspaces.find((workspace) => workspace.kind === "azure" && (workspace.profileId || "default") === profileId) || null;
  }

  function getReviewBridgeSnapshot(state = getState()) {
    try {
      const prKeys = new Set([
        ...Object.keys(azure.getSnapshot().pullRequests || {}),
        ...(state.workspaces || [])
          .map((workspace) => workspace.review?.provider === "azure-devops" ? workspace.review.prKey : "")
          .filter(Boolean),
      ]);
      const pullRequests = {};
      const processInfo = { execPath: process.execPath, platform: process.platform, defaultApp: Boolean(process.defaultApp) };
      for (const prKey of prKeys) {
        const context = reviewBridgeStore.getPullRequestContext?.(prKey);
        if (context) {
          let mcpSpec = null;
          try { mcpSpec = buildMcpServerSpec({ context, processInfo }); } catch {}
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

  async function ensureAzureWorkspace(profileId = getState().activeProfileId || "default") {
    const existing = getAzureWorkspace(profileId);
    if (existing) {
      return existing;
    }

    const panels = createAzureWorkspaceReviewPanels(getState().tabTemplates || []);

    const workspace = normalizeWorkspace({
      id: `workspace-${randomUUID()}`,
      name: "Azure DevOps",
      icon: "AZ",
      color: "#0078d4",
      kind: "azure",
      cwd: getAzureSettings().reviewRoot || path.join(os.homedir(), ".strideterm", "azure-pr"),
      notes: "Azure DevOps inbox",
      profileId,
      panels,
      activePanelId: panels[0]?.id || "",
    });
    await store.mutate((draft) => {
      draft.workspaces.push(workspace);
      if (!draft.activeWorkspaceId) {
        draft.activeWorkspaceId = workspace.id;
      }
    });
    return workspace;
  }

  async function refreshAzure() {
    const state = getState();
    await azure.sync({
      connections: getAzureConnections(state),
      workspaces: state.workspaces,
      gitSnapshots: git.getProjectMap(),
      activeProfileId: state.activeProfileId || "default",
    });
    await repairAzureReviewWorkspaceMetadata();

    const refreshedState = getState();
    const activeWorkspace = findWorkspace(refreshedState, refreshedState.activeWorkspaceId);
    if (
      activeWorkspace?.review?.provider === "azure-devops"
      && activeWorkspace.review.prKey
      && typeof azure.ensurePullRequestDetail === "function"
    ) {
      await azure.ensurePullRequestDetail(activeWorkspace.review.prKey, {
        workspaces: refreshedState.workspaces,
        force: true,
      }).catch(() => {});
    }

    return azure.getSnapshot();
  }

  async function repairAzureReviewWorkspaceMetadata(snapshot = azure.getSnapshot()) {
    const state = getState();
    const repairs = [];
    const summaries = Object.values(snapshot?.pullRequests || {});
    const trackedPullRequests = Object.values(azureReviewStore.getState().trackedPullRequests || {});

    for (const workspace of state.workspaces || []) {
      const hasAzureReview = workspace.review?.provider === "azure-devops";
      const looksLikeAzureReview = String(workspace.notes || "").startsWith("Azure DevOps review workspace for ");
      if (workspace.kind === "azure" || !workspace.cwd || (!looksLikeAzureReview && !hasAzureReview)) {
        continue;
      }

      if (hasAzureReview && workspace.review?.checkout?.mode === "managed-worktree" && workspace.review?.parentWorkspaceId) {
        continue;
      }

      const match = summaries.find((summary) => {
        const paths = azure.buildManagedReviewPaths?.(summary, {
          profileId: workspace.profileId || "default",
          workspaces: state.workspaces,
        });
        return paths && normalizeFsPath(paths.rootPath) === normalizeFsPath(workspace.cwd);
      });
      if (match) {
        const paths = azure.buildManagedReviewPaths(match, {
          profileId: workspace.profileId || "default",
          workspaces: state.workspaces,
        });
        if (!paths) {
          continue;
        }

        repairs.push({
          workspaceId: workspace.id,
          prKey: match.prKey,
          review: azure.buildReviewMetadata(match, {
            mode: "managed-worktree",
            rootPath: paths.rootPath,
            cacheRepoPath: paths.cacheRepoPath,
          }, "managed-worktree", {
            parentWorkspaceId: paths.parentWorkspaceId || "",
          }),
        });
        continue;
      }

      const hint = parseAzureReviewWorkspaceHint(workspace);
      if (!hint.prId || !hint.connectionPathKey) {
        continue;
      }
      const connection = getAzureConnections(state).find((entry) => shortPathKey(entry.id, "connection") === hint.connectionPathKey);
      if (!connection) {
        continue;
      }
      const tracked = trackedPullRequests.find((entry) => (
        entry.connectionId === connection.id && Number(entry.pullRequestId) === hint.prId
      ));
      if (!tracked) {
        continue;
      }
      const parentAzureWorkspace = state.workspaces.find((entry) => (
        entry.kind === "azure" && (entry.profileId || "default") === (workspace.profileId || "default")
      )) || null;
      const reviewRoot = parentAzureWorkspace?.cwd || connection.reviewRoot || getAzureSettings(state).reviewRoot;
      repairs.push({
        workspaceId: workspace.id,
        prKey: tracked.key,
        review: {
          provider: "azure-devops",
          prKey: tracked.key,
          connectionId: connection.id,
          orgUrl: connection.orgUrl || "",
          parentWorkspaceId: parentAzureWorkspace?.id || "",
          project: {
            id: "",
            name: tracked.projectName || "",
          },
          repository: {
            id: tracked.repositoryId || "",
            name: tracked.repositoryName || "",
            remoteUrl: "",
          },
          pullRequest: {
            id: tracked.pullRequestId || hint.prId,
            title: workspace.name || `PR #${hint.prId}`,
            status: "",
            mergeStatus: "",
            url: "",
            webUrl: "",
            sourceRefName: "",
            targetRefName: "",
          },
          role: "",
          checkout: {
            mode: "managed-worktree",
            rootPath: workspace.cwd,
            cacheRepoPath: path.join(
              normalizeReviewRoot(reviewRoot),
              "repos",
              shortPathKey(connection.id, "connection"),
              shortPathKey(tracked.repositoryId || tracked.repositoryName, "repository"),
            ),
          },
        },
      });
    }

    if (!repairs.length) {
      return false;
    }

    await store.mutate((draft) => {
      for (const repair of repairs) {
        const workspace = draft.workspaces.find((entry) => entry.id === repair.workspaceId);
        if (workspace) {
          workspace.review = repair.review;
        }
      }
    });
    for (const repair of repairs) {
      await azureReviewStore.upsertTrackedPullRequest(repair.prKey, {
        reviewWorkspaceId: repair.workspaceId,
      });
    }
    return true;
  }

  function scheduleAzurePolling() {
    const settings = getAzureSettings();
    const enabledConnections = getAzureConnections().filter((connection) => connection.enabled !== false);
    if (!settings.enabled || !enabledConnections.length) {
      azure.stopPolling();
      return;
    }

    const pollSeconds = Math.max(
      15,
      Math.min(
        ...enabledConnections.map((connection) => Number(connection.pollSeconds) || Number(settings.defaultPollSeconds) || 120),
      ),
    );
    azure.configurePolling(pollSeconds * 1000, refreshAzure);
  }

  tunnel.setBinaryPreference?.(getState().settings.remoteAccess.cloudflaredPath || "");

  function getPayload() {
    const state = getState();
    return {
      meta: {
        appVersion: packageVersion,
        repositoryUrl: APP_CONFIG.app.repositoryUrl,
      },
      appState: clone(state),
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
      },
      azureDevops: azure.getSnapshot(),
      reviewBridge: getReviewBridgeSnapshot(state),
      plugins: pluginManager ? pluginManager.getPlugins() : [],
      environment: terminalEnvironment,
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
    };
  }

  function broadcastState() {
    events.emit("state:updated", getPayload());
  }

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
      projectAlerts.delete(projectId);
      return;
    }

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
    const current = sessionSignals.get(sessionId) || createSessionSignal(sessionId);
    if (!current.agentLike) {
      current.agentLike = AGENT_NAME_RE.test(panel?.command || "") || AGENT_NAME_RE.test(panel?.title || "");
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
    cancelPromptTimer(signal);
    signal.busy = false;
    signal.waitingRaised = false;
  }

  function deleteSessionSignal(sessionId) {
    const signal = sessionSignals.get(sessionId);
    cancelPromptTimer(signal);
    sessionSignals.delete(sessionId);
  }

  function raiseWaitingAlert({ sessionId, projectId, panelId, title, detail }) {
    const signal = sessionSignals.get(sessionId);
    if (signal?.waitingRaised) {
      return false;
    }

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
      getState().workspaces.flatMap((workspace) => workspace.panels.map((panel) => createSessionId(workspace.id, panel.id))),
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
      project
      && panel
      && project.kind === "terminal"
      && !isKnownPluginProject(project)
      && !panel.launch?.file
      && panel.shell !== false
    );
  }

  function updateVisibleSessions(nextIds) {
    const prev = attentionContext.visibleSessionIds;
    const next = new Set(nextIds);
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
      const rawText = String(payload.data || "");
      const cleanText = stripAnsi(rawText);
      const lowerText = cleanText.toLowerCase();
      const lastLine = lastNonEmptyLine(cleanText);
      const explicitWaiting = rawText.includes("\u0007") || WAITING_PATTERNS.some((pattern) => pattern.test(lowerText));
      const promptLike = signal.agentLike && matchesPrompt(lastLine);
      const onlyPrompt = promptLike && cleanText.trim() === lastLine.trim();

      if (AGENT_OUTPUT_RE.test(cleanText)) {
        signal.agentLike = true;
      }

      if (cleanText.trim() && !onlyPrompt) {
        signal.busy = true;
        signal.waitingRaised = false;
        cancelPromptTimer(signal);
      }

      if (explicitWaiting) {
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
      } else if (promptLike && signal.busy) {
        cancelPromptTimer(signal);
        signal.promptTimer = setTimeout(() => {
          signal.promptTimer = null;
          if (isSessionVisible(payload.sessionId)) {
            resetSessionSignal(payload.sessionId);
            return;
          }
          raiseWaitingAlert({
            sessionId: payload.sessionId,
            projectId: descriptor.workspaceId,
            panelId: descriptor.panelId,
            title: panel?.title || descriptor.panelId,
            detail: "prompt-returned",
          });
        }, PROMPT_QUIET_MS);
      }
    }

    events.emit("terminal:data", payload);
  });

  sessions.on("terminal:exit", (payload) => {
    const descriptor = parseSessionId(payload.sessionId);
    const state = getState();
    const project = descriptor ? findWorkspace(state, descriptor.workspaceId) : null;
    const panel = project?.panels.find((item) => item.id === descriptor?.panelId) || null;
    const shouldRaiseAlert = !payload.intentional
      && descriptor
      && shouldTrackProjectAlert(project, panel)
      && !isSessionVisible(payload.sessionId);
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
    const state = getState();
    const workspaces = state.workspaces.filter((workspace) => (
      (!projectId || workspace.id === projectId)
      && workspace.kind !== "azure"
    ));
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
    const parents = state.workspaces.filter((workspace) => (
      !(workspace.notes || "").startsWith("Worktree of ")
      && workspace.kind !== "azure"
      && workspace.review?.provider !== "azure-devops"
    ));
    const worktrees = state.workspaces.filter((w) => (w.notes || "").startsWith("Worktree of "));

    // Build parent lookup: treeDir → parent workspace
    const parentByTreeDir = new Map();
    for (const parent of parents) {
      if (!parent.cwd) continue;
      parentByTreeDir.set(path.join(parent.cwd, ".strideterm", "tree"), parent);
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
        const existing = worktrees.find((w) => w.cwd === treePath);
        if (existing) {
          // Repair profileId if it drifted from parent
          if ((existing.profileId || "default") !== (parent.profileId || "default")) {
            toRepair.push({ id: existing.id, profileId: parent.profileId || "default" });
          }
          continue;
        }
        if (toAdd.some((w) => w.cwd === treePath)) continue;
        toAdd.push(normalizeWorkspace({
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
        }));
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
        console.warn(`[runtime] Docker poll error: ${error.message}`);
      });
    }, APP_CONFIG.runtime.dockerPollMs);
  }

  function ensureGitPolling() {
    if (gitPoll) {
      return;
    }

    gitPoll = setInterval(async () => {
      await refreshGit().catch((error) => {
        console.warn(`[runtime] Git poll error: ${error.message}`);
      });
      try {
        if (await syncWorktrees()) {
          sessions.syncWithState(getState());
          broadcastState();
        }
      } catch (error) {
        console.warn(`[runtime] Worktree sync error: ${error.message}`);
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
    await syncWorktrees();
    await tunnel.refreshAvailability();
  }

  ensureDockerPolling();
  ensureGitPolling();
  if (deferInitialRefresh) {
    scheduleAzurePolling();
    runInitialRefresh().then(() => {
      ensureVisibleSession();
      broadcastState();
    }).catch((error) => {
      console.warn(`[runtime] Initial refresh error: ${error.message}`);
      broadcastState();
    });
  } else {
    await runInitialRefresh();
  }

  return {
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
        console.log(`[runtime] Initial state ready: ${payload.appState?.workspaces?.length ?? 0} workspaces`);
        return payload;
      } catch (error) {
        console.error(`[runtime] getInitialState failed: ${error.message}`);
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
        updateVisibleSessions(workspace.kind === "azure" ? [] : workspace.panels.map((panel) => createSessionId(workspaceId, panel.id)));
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
      await store.mutate((draft) => {
        const normalized = normalizeWorkspace(workspace);
        const index = draft.workspaces.findIndex((item) => item.id === normalized.id);
        if (index >= 0) {
          draft.workspaces[index] = normalized;
        } else {
          draft.workspaces.push(normalized);
        }

        if (!draft.activeWorkspaceId) {
          draft.activeWorkspaceId = normalized.id;
        }
      });

      sessions.syncWithState(getState());
      syncSessionSignalsWithState();
      await refreshGit();
      await refreshAzure();
      ensureVisibleSession();
      broadcastState();
      return getPayload();
    },
    async saveProject(project) {
      return this.saveWorkspace(project);
    },
    async deleteWorkspace(workspaceId) {
      await store.mutate((draft) => {
        draft.workspaces = draft.workspaces.filter((item) => item.id !== workspaceId);
        if (draft.activeWorkspaceId === workspaceId) {
          draft.activeWorkspaceId = draft.workspaces[0]?.id || null;
        }
      });

      sessions.removeWorkspaceSessions(workspaceId);
      for (const sessionId of [...sessionSignals.keys()]) {
        if (sessionId.startsWith(`${workspaceId}:`)) {
          deleteSessionSignal(sessionId);
        }
      }
      clearProjectAlerts(workspaceId);
      await refreshGit();
      await refreshAzure();
      ensureVisibleSession();
      broadcastState();
      return getPayload();
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

      sessions.syncWithState(getState());
      syncSessionSignalsWithState();
      await refreshGit();
      await refreshAzure();
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
      } else if (
        tunnel.getSnapshot().status === "connected"
        && tunnelTargetChanged
      ) {
        await tunnel.startQuickTunnel(await ensureRemoteOriginReady(nextConfig));
      }
      if (previousConfig.cloudflaredPath !== nextConfig.cloudflaredPath && tunnel.getSnapshot().status !== "connected") {
        await tunnel.refreshAvailability();
      }
      broadcastState();
      return { payload: getPayload(), remoteAccessChanged };
    },
    async verifyAzureConnection(connection) {
      return azure.verifyConnection(connection);
    },
    async saveAzureConnection(connection) {
      const normalizedInput = normalizeConnectionInput(connection);
      const connectionId = normalizedInput.id || `ado-${randomUUID()}`;
      const tokenRef = connection.tokenRef || `cred:${connectionId}`;
      const pat = connection.pat || credentialStore.getSecret(tokenRef);
      const verification = await azure.verifyConnection({
        ...normalizedInput,
        pat,
      });
      const normalizedConnection = {
        id: connectionId,
        label: String(normalizedInput.label || connectionId).trim(),
        orgUrl: String(normalizedInput.orgUrl || "").trim().replace(/\/+$/, ""),
        login: String(normalizedInput.login || "").trim(),
        tokenRef,
        enabled: normalizedInput.enabled !== false,
        profileId: connection.profileId || getState().activeProfileId || "default",
        projectFilters: Array.isArray(normalizedInput.projectFilters) ? [...normalizedInput.projectFilters] : [],
        repositoryFilters: Array.isArray(normalizedInput.repositoryFilters) ? [...normalizedInput.repositoryFilters] : [],
        pollSeconds: Number(normalizedInput.pollSeconds) || getAzureSettings().defaultPollSeconds || 120,
        reviewRoot: String(normalizedInput.reviewRoot || getAzureSettings().reviewRoot || "").trim(),
      };

      if (pat) {
        await credentialStore.setSecret(tokenRef, pat);
      }

      await store.mutate((draft) => {
        const azureSettings = draft.settings.integrations.azureDevops;
        azureSettings.reviewRoot = normalizedConnection.reviewRoot || azureSettings.reviewRoot;
        const index = azureSettings.connections.findIndex((entry) => entry.id === connectionId);
        if (index >= 0) {
          azureSettings.connections[index] = normalizedConnection;
        } else {
          azureSettings.connections.push(normalizedConnection);
        }
      });

      await ensureAzureWorkspace();
      await refreshAzure();
      scheduleAzurePolling();
      broadcastState();
      return {
        payload: getPayload(),
        verification,
      };
    },
    async deleteAzureConnection(connectionId) {
      const connection = getAzureConnections().find((entry) => entry.id === connectionId);
      if (connection?.tokenRef) {
        await credentialStore.deleteSecret(connection.tokenRef);
      }
      await store.mutate((draft) => {
        draft.settings.integrations.azureDevops.connections = draft.settings.integrations.azureDevops.connections
          .filter((entry) => entry.id !== connectionId);
      });
      await refreshAzure();
      scheduleAzurePolling();
      broadcastState();
      return getPayload();
    },
    async refreshAzureState() {
      await refreshAzure();
      return getPayload();
    },
    async markAzurePullRequestSeen(prKey) {
      await azure.markPullRequestSeen(prKey);
      return getPayload();
    },
    async openAzurePullRequest(payload) {
      let result;
      try {
        result = await azure.openReviewWorkspace({
          state: getState(),
          prKey: payload.prKey,
          workspaceId: payload.workspaceId || "",
        });
      } catch (err) {
        const message = err instanceof Error
          ? err.message
          : (err?.stderr || err?.error?.message || String(err));
        throw new Error(message);
      }
      await store.mutate((draft) => {
        const normalized = normalizeWorkspace(result.workspace);
        const index = draft.workspaces.findIndex((entry) => entry.id === normalized.id);
        if (index >= 0) {
          draft.workspaces[index] = normalized;
        } else {
          draft.workspaces.push(normalized);
        }
        draft.activeWorkspaceId = normalized.id;
      });
      await refreshGit(result.workspace.id);
      await azure.markPullRequestSeen(payload.prKey);
      await refreshAzure();
      sessions.syncWithState(getState());
      ensureVisibleSession(result.workspace.id);
      broadcastState();
      return getPayload();
    },
    async commentAzurePullRequest(payload) {
      await azure.addPullRequestComment(payload);
      await refreshAzure();
      return getPayload();
    },
    async updateAzureThreadStatus(payload) {
      await azure.updateThreadStatus(payload);
      await refreshAzure();
      return getPayload();
    },
    async createReviewBridgeLocalComment(payload) {
      await reviewBridgeStore.createLocalComment(payload);
      broadcastState();
      return getPayload();
    },
    async saveReviewBridgeDraft(payload) {
      await reviewBridgeStore.saveDraftResponse(payload);
      broadcastState();
      return getPayload();
    },
    async queueReviewBridgeDraft(payload) {
      await reviewBridgeStore.queueDraftResponse(payload);
      broadcastState();
      return getPayload();
    },
    async saveAgentPrompt(payload) {
      reviewBridgeStore.saveAgentPrompt(payload);
      broadcastState();
      return getPayload();
    },
    async deleteAgentPrompt(payload) {
      reviewBridgeStore.deleteAgentPrompt(payload.promptId);
      broadcastState();
      return getPayload();
    },
    async deleteReviewBridgeComment(payload) {
      await reviewBridgeStore.deleteComment(payload);
      broadcastState();
      return getPayload();
    },
    async deleteReviewBridgeDraft(payload) {
      await reviewBridgeStore.deleteDraft(payload);
      broadcastState();
      return getPayload();
    },
    async syncReviewBridgePullRequest(payload) {
      const prKey = String(payload?.prKey || "").trim();
      if (!prKey) {
        throw new Error("Pull request key is required.");
      }
      await reviewBridgeStore.syncPendingDrafts(prKey, async (entry) => {
        await azure.addPullRequestComment({
          prKey,
          content: entry.body,
          threadId: entry.remoteThreadId,
          parentCommentId: entry.parentCommentId || 0,
        });
        return {
          publishedAt: new Date().toISOString(),
          threadId: entry.remoteThreadId,
        };
      });
      await refreshAzure();
      broadcastState();
      return getPayload();
    },
    async voteAzurePullRequest(payload) {
      await azure.setPullRequestVote(payload);
      await refreshAzure();
      return getPayload();
    },
    async fetchAzureReviewWorkspace(workspaceId) {
      const workspace = findWorkspace(getState(), workspaceId);
      if (!workspace?.review) {
        throw new Error("Azure review workspace not found.");
      }
      await azure.fetchReviewWorkspace({ workspace });
      await refreshGit(workspaceId);
      await refreshAzure();
      return getPayload();
    },
    async rebaseAzureReviewWorkspace(workspaceId) {
      const workspace = findWorkspace(getState(), workspaceId);
      if (!workspace?.review) {
        throw new Error("Azure review workspace not found.");
      }
      await azure.rebaseReviewWorkspace({ workspace });
      await refreshGit(workspaceId);
      await refreshAzure();
      return getPayload();
    },
    async pushAzureReviewWorkspace(workspaceId) {
      const workspace = findWorkspace(getState(), workspaceId);
      if (!workspace?.review) {
        throw new Error("Azure review workspace not found.");
      }
      await azure.pushReviewWorkspace({ workspace });
      await refreshGit(workspaceId);
      await refreshAzure();
      return getPayload();
    },
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
      const descriptor = parseSessionId(sessionId);
      if (descriptor) {
        const current = projectAlerts.get(descriptor.workspaceId);
        const alert = current?.alerts?.find((a) => a.panelId === descriptor.panelId);
        if (alert && (Date.now() - new Date(alert.at).getTime()) >= ATTENTION_MIN_DISPLAY_MS) {
          clearProjectAlerts(descriptor.workspaceId, descriptor.panelId);
          broadcastState();
        }
      }
      sessions.writeToSession(sessionId, data);
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
        if (alert && (now - new Date(alert.at).getTime()) >= ATTENTION_MIN_DISPLAY_MS) {
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
    async refreshGitState(projectId = null) {
      await refreshGit(projectId);
      await refreshAzure();
      return getPayload();
    },
    async gitFetch(payload = {}) {
      const workspace = resolveGitWorkspace(payload.workspaceId, payload.projectId);
      return runGitWorkspaceAction(workspace, git.fetch(workspace));
    },
    async gitMergeIntoCurrent(payload = {}) {
      const workspace = resolveGitWorkspace(payload.workspaceId, payload.projectId);
      return runGitWorkspaceAction(workspace, git.mergeIntoCurrent(workspace, payload));
    },
    async gitRebaseOnto(payload = {}) {
      const workspace = resolveGitWorkspace(payload.workspaceId, payload.projectId);
      return runGitWorkspaceAction(workspace, git.rebaseOnto(workspace, payload));
    },
    async gitContinueOperation(payload = {}) {
      const workspace = resolveGitWorkspace(payload.workspaceId, payload.projectId);
      return runGitWorkspaceAction(workspace, git.continueOperation(workspace));
    },
    async gitAbortOperation(payload = {}) {
      const workspace = resolveGitWorkspace(payload.workspaceId, payload.projectId);
      return runGitWorkspaceAction(workspace, git.abortOperation(workspace));
    },
    async gitDiffPreview(payload = {}) {
      const workspace = resolveGitWorkspace(payload.workspaceId, payload.projectId);
      return git.diffPreview(workspace, payload);
    },
    async gitMergeCurrentIntoBase(payload = {}) {
      const workspace = resolveGitWorkspace(payload.workspaceId, payload.projectId);
      return runGitWorkspaceAction(workspace, git.mergeCurrentIntoBase(workspace, payload));
    },
    async gitRemoveWorktree(payload = {}) {
      const workspace = resolveGitWorkspace(payload.workspaceId, payload.projectId);
      const result = await git.removeWorktree(workspace, payload);
      await syncWorktrees();
      return { payload: getPayload(), result };
    },
    async gitCommitAll(payload = {}) {
      const workspace = resolveGitWorkspace(payload.workspaceId, payload.projectId);
      return runGitWorkspaceAction(workspace, git.commitAll(workspace, payload));
    },
    async gitCommitDiff(payload = {}) {
      const workspace = resolveGitWorkspace(payload.workspaceId, payload.projectId);
      return git.commitDiff(workspace, payload);
    },
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
      const description = mode === "logs" ? `docker logs -f ${container.Names}` : `docker exec -it ${container.Names} sh`;

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
      await refreshGit();
      await refreshAzure();
      ensureVisibleSession();
      broadcastState();
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
            : (Array.isArray(profile.projectIds) ? profile.projectIds : []),
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
      await tunnel.stop({ preserveAvailability: true, quiet: true });
      await pluginManager.stopAll();
      sessions.stopAll();
      await reviewBridgeStore.close?.();
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
  };
}
