import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { APP_CONFIG } from "../../config/app-config.js";

const UTF8_DECODER = (() => {
  try {
    return new TextDecoder("utf-8", { fatal: true });
  } catch {
    return null;
  }
})();

const WINDOWS_1250_ENCODER_MAP = (() => {
  try {
    const decoder = new TextDecoder("windows-1250");
    const bytes = Uint8Array.from({ length: 256 }, (_value, index) => index);
    const decoded = decoder.decode(bytes);
    const map = new Map();
    for (let index = 0; index < decoded.length; index += 1) {
      if (!map.has(decoded[index])) {
        map.set(decoded[index], index);
      }
    }
    return map;
  } catch {
    return null;
  }
})();

const MOJIBAKE_MARKER_RE = /[ĂÂÄÅĹâđź]/u;

function defaultCwd() {
  return os.homedir();
}

/**
 * Returns the strIDEterm user-data directory, honoring the STRIDETERM_DATA_DIR
 * env var used by dev1.ps1 and --data-dir. Centralized here so every module
 * that falls back to a "default" path under strIDEterm's data dir picks up the
 * override consistently — otherwise dev instances bleed into ~/.strideterm.
 */
export function strideDataDir() {
  return process.env.STRIDETERM_DATA_DIR
    ? path.resolve(process.env.STRIDETERM_DATA_DIR)
    : path.join(os.homedir(), ".strideterm");
}

function defaultAzureReviewRoot() {
  return path.join(strideDataDir(), "azure-pr");
}

function defaultGitHubReviewRoot() {
  return path.join(strideDataDir(), "github-pr");
}

export function createAccessToken() {
  return randomBytes(18).toString("base64url");
}

function decodeUtf8Mojibake(value) {
  if (!value || !UTF8_DECODER || !WINDOWS_1250_ENCODER_MAP || !MOJIBAKE_MARKER_RE.test(value)) {
    return value;
  }

  const bytes = [];
  for (const character of value) {
    const nextByte = WINDOWS_1250_ENCODER_MAP.get(character);
    if (nextByte == null) {
      return value;
    }
    bytes.push(nextByte);
  }

  try {
    return UTF8_DECODER.decode(Uint8Array.from(bytes));
  } catch {
    return value;
  }
}

function repairVisibleText(value, fallback = "") {
  let current = String(value ?? fallback);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const repaired = decodeUtf8Mojibake(current);
    if (repaired === current) {
      break;
    }
    current = repaired;
  }
  return current;
}

function normalizePanel(panel, panelIndex = 0) {
  return {
    id: panel.id || `panel-${panelIndex + 1}`,
    title: repairVisibleText(panel.title || `Panel ${panelIndex + 1}`),
    command: panel.command || "",
    launch: panel.launch
      ? {
          file: panel.launch.file || "",
          args: [...(panel.launch.args || [])],
        }
      : null,
    shell: panel.shell !== false,
    startup: panel.startup || (panelIndex === 0 ? APP_CONFIG.ui.defaultPanelStartup : APP_CONFIG.ui.manualPanelStartup),
    cwd: panel.cwd || "",
  };
}

const KNOWN_VIEW_PREFIXES = [
  "git:",
  "docker:",
  "azure:",
  "github:",
  "review:",
  "files:",
  "browser:",
  "task-dashboard:",
];
const VALID_SPLIT_LAYOUTS = new Set(["cols", "rows", "top-split"]);

function isKnownPrefixViewId(viewId) {
  return typeof viewId === "string" && KNOWN_VIEW_PREFIXES.some((prefix) => viewId.startsWith(prefix));
}

function isValidWorkspaceViewId(viewId, workspaceId, panels) {
  if (typeof viewId !== "string" || !viewId) return false;
  if (isKnownPrefixViewId(viewId)) return true;
  const sessionPrefix = `${workspaceId}:`;
  if (!viewId.startsWith(sessionPrefix)) return false;
  const panelId = viewId.slice(sessionPrefix.length);
  return panels.some((panel) => panel.id === panelId);
}

function panelViewId(panel, workspaceId) {
  if (!panel) return null;
  if (panel.command === "__task-dashboard__") return `task-dashboard:${panel.id}`;
  if (panel.command === "__files__") return `files:${panel.id}`;
  if (/^https?:\/\//i.test(panel.command || "")) return `browser:${panel.id}`;
  return `${workspaceId}:${panel.id}`;
}

// Rewrites a session-style viewId (`${workspaceId}:${panelId}`) to its canonical
// form when it points to a non-terminal panel (dashboard/files/browser). Older
// state files persisted the session-style id for dashboard panels, which then
// failed to match splitGroup.viewIds and collapsed the layout to solo.
function canonicalizeViewId(viewId, workspaceId, panels) {
  if (typeof viewId !== "string" || !viewId) return viewId;
  if (isKnownPrefixViewId(viewId)) return viewId;
  const sessionPrefix = `${workspaceId}:`;
  if (!viewId.startsWith(sessionPrefix)) return viewId;
  const panelId = viewId.slice(sessionPrefix.length);
  const panel = panels.find((p) => p.id === panelId);
  if (!panel) return viewId;
  return panelViewId(panel, workspaceId);
}

function normalizeWorkspaceUIState(workspace, workspaceId, panels, activePanelId) {
  const activePanel = activePanelId ? panels.find((p) => p.id === activePanelId) : null;
  const fallbackViewId = panelViewId(activePanel, workspaceId);
  const rawViewId = typeof workspace.activeViewId === "string" ? workspace.activeViewId : "";
  const canonicalRaw = canonicalizeViewId(rawViewId, workspaceId, panels);
  const activeViewId = isValidWorkspaceViewId(canonicalRaw, workspaceId, panels) ? canonicalRaw : fallbackViewId;

  const rawLayout = workspace.splitLayout;
  const rawSplitIds = Array.isArray(workspace.splitViewIds) ? workspace.splitViewIds : [];
  const canonicalSplitIds = rawSplitIds
    .map((id) => canonicalizeViewId(id, workspaceId, panels))
    .filter((id) => isValidWorkspaceViewId(id, workspaceId, panels));
  if (!VALID_SPLIT_LAYOUTS.has(rawLayout) || canonicalSplitIds.length < 2) {
    return { activeViewId, splitLayout: null, splitViewIds: [], activeRootPath: workspace.activeRootPath || "" };
  }
  return {
    activeViewId,
    splitLayout: rawLayout,
    splitViewIds: canonicalSplitIds,
    activeRootPath: workspace.activeRootPath || "",
  };
}

export function normalizeWorkspace(workspace, index = 0) {
  const isDockerWorkspace = (workspace.id || "") === "docker" || workspace.kind === "docker";
  const isAzureWorkspace = workspace.kind === "azure";
  const isGitHubWorkspace = workspace.kind === "github";
  const isTaskWorkspace = workspace.kind === "task";
  const rawPanels = isDockerWorkspace
    ? (workspace.panels || []).filter(
        (panel) => !(panel.id === "lazydocker" && panel.command === "lazydocker" && !panel.launch),
      )
    : (workspace.panels || []).filter((panel) => !(panel.id === "git" && !panel.command && !panel.launch));
  const panels = rawPanels.map((panel, panelIndex) => normalizePanel(panel, panelIndex));
  const fallbackPanelId = panels[0]?.id || null;
  const activePanelId = panels.some((panel) => panel.id === workspace.activePanelId)
    ? workspace.activePanelId
    : fallbackPanelId;
  const workspaceId = workspace.id || `workspace-${index + 1}`;
  const { activeViewId, splitLayout, splitViewIds, activeRootPath } = normalizeWorkspaceUIState(
    workspace,
    workspaceId,
    panels,
    activePanelId,
  );

  return {
    id: workspaceId,
    name: repairVisibleText(workspace.name || `Workspace ${index + 1}`),
    icon: repairVisibleText(workspace.icon || APP_CONFIG.ui.defaultProjectIcon),
    color: workspace.color || APP_CONFIG.ui.defaultProjectColor,
    kind: isDockerWorkspace
      ? "docker"
      : isAzureWorkspace
        ? "azure"
        : isGitHubWorkspace
          ? "github"
          : isTaskWorkspace
            ? "task"
            : workspace.kind || APP_CONFIG.ui.defaultProjectKind,
    source: workspace.source === "plugin" ? "plugin" : "manual",
    pluginId: workspace.pluginId || "",
    cwd: workspace.cwd || (isAzureWorkspace || isGitHubWorkspace ? "" : defaultCwd()),
    gitRoots: (function () {
      // Don't allow gitRoots on review workspaces or task workspaces that run in a worktree
      if (isAzureWorkspace || isGitHubWorkspace) return [];
      if (isTaskWorkspace && workspace.task?.worktreeBranch) return [];
      const roots = Array.isArray(workspace.gitRoots) ? workspace.gitRoots.filter(Boolean) : [];
      return roots
        .map((r) => String(r).replace(/\\/g, "/").replace(/\/+$/, ""))
        .filter(Boolean)
        .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "accent" }));
    })(),
    activeRootPath: activeRootPath || "",
    notes: repairVisibleText(workspace.notes || ""),
    profileId: workspace.profileId || "default",
    connectionId: workspace.connectionId || workspace.quickfix?.connectionId || workspace.review?.connectionId || "",
    activePanelId,
    activeViewId,
    splitLayout,
    splitViewIds,
    panels,
    review: workspace.review
      ? {
          provider: workspace.review.provider || "",
          prKey: workspace.review.prKey || "",
          connectionId: workspace.review.connectionId || "",
          orgUrl: workspace.review.orgUrl || "",
          parentWorkspaceId: workspace.review.parentWorkspaceId || "",
          project: workspace.review.project
            ? {
                id: workspace.review.project.id || "",
                name: workspace.review.project.name || "",
              }
            : null,
          repository: workspace.review.repository
            ? {
                id: workspace.review.repository.id || "",
                name: workspace.review.repository.name || "",
                remoteUrl: workspace.review.repository.remoteUrl || "",
              }
            : null,
          pullRequest: workspace.review.pullRequest
            ? {
                id: workspace.review.pullRequest.id || workspace.review.pullRequest.number || 0,
                number: workspace.review.pullRequest.number || workspace.review.pullRequest.id || 0,
                title: workspace.review.pullRequest.title || "",
                status: workspace.review.pullRequest.status || workspace.review.pullRequest.state || "",
                mergeStatus:
                  workspace.review.pullRequest.mergeStatus || workspace.review.pullRequest.mergeableState || "",
                url: workspace.review.pullRequest.url || "",
                webUrl: workspace.review.pullRequest.webUrl || "",
                sourceRefName:
                  workspace.review.pullRequest.sourceRefName || workspace.review.pullRequest.sourceBranch || "",
                targetRefName:
                  workspace.review.pullRequest.targetRefName || workspace.review.pullRequest.targetBranch || "",
              }
            : null,
          role: workspace.review.role || "",
          checkout: workspace.review.checkout
            ? {
                mode: workspace.review.checkout.mode || "",
                rootPath: workspace.review.checkout.rootPath || "",
                cacheRepoPath: workspace.review.checkout.cacheRepoPath || "",
              }
            : null,
        }
      : null,
    quickfix: workspace.quickfix
      ? {
          connectionId: workspace.quickfix.connectionId || "",
          projectName: workspace.quickfix.projectName || "",
          repositoryId: workspace.quickfix.repositoryId || "",
          repositoryName: workspace.quickfix.repositoryName || "",
          remoteUrl: workspace.quickfix.remoteUrl || "",
          baseBranch: workspace.quickfix.baseBranch || "",
          parentWorkspaceId: workspace.quickfix.parentWorkspaceId || "",
        }
      : null,
    starred: Boolean(workspace.starred),
    task: workspace.task
      ? {
          // Spread first: preserves runtime-only properties (promptSent,
          // pausedFromState, showerResumePrompt, etc.) that the task runner
          // sets directly on the object during execution.  Without this,
          // store.mutate() → normalizeState would strip them, causing bugs
          // like duplicate prompt injection on workspace switch.
          ...workspace.task,
          // Normalize/default all persisted properties (overrides spread)
          taskId: workspace.task.taskId || "",
          description: workspace.task.description || "",
          parentWorkspaceId: workspace.task.parentWorkspaceId || "",
          worktreeBase: workspace.task.worktreeBase || "",
          worktreeBranch: workspace.task.worktreeBranch || "",
          workerPanelId: workspace.task.workerPanelId || "",
          judgePanelId: workspace.task.judgePanelId || "",
          maxRounds: workspace.task.maxRounds || 10,
          showerInterval: workspace.task.showerInterval ?? 5,
          state: workspace.task.state || "idle",
          currentRound: workspace.task.currentRound || 0,
          rounds: Array.isArray(workspace.task.rounds) ? workspace.task.rounds : [],
          lastShowerRound: workspace.task.lastShowerRound || 0,
          lastJudgeInstructions: workspace.task.lastJudgeInstructions || "",
          // Provider configs — migrated from panel command strings if absent
          workerProviderConfig: workspace.task.workerProviderConfig || null,
          judgeProviderConfig: workspace.task.judgeProviderConfig || null,
          // Defaults for runtime-only properties (needed when loading from disk
          // where these don't exist; during runtime the spread above preserves them)
          promptSent: workspace.task.promptSent ?? false,
          pausedFromState: workspace.task.pausedFromState ?? "",
          showerResumePrompt: workspace.task.showerResumePrompt ?? "",
          startedAt: workspace.task.startedAt || null,
          totalPausedMs: workspace.task.totalPausedMs || 0,
          pausedAt: workspace.task.pausedAt || null,
          finishedAt: workspace.task.finishedAt || null,
        }
      : null,
  };
}

export function createDefaultState() {
  const state = {
    activeWorkspaceId: "",
    activeProfileId: "default",
    settings: {
      theme: APP_CONFIG.ui.defaultTheme,
      sidebarWidth: APP_CONFIG.ui.sidebarWidth,
      sidebarCollapsed: APP_CONFIG.ui.sidebarCollapsed,
      logLevel: APP_CONFIG.logging.level,
      notifications: {
        promptQuietMs: APP_CONFIG.notifications.promptQuietMs,
        agentQuietMs: APP_CONFIG.notifications.agentQuietMs,
        agentQuietFastMs: APP_CONFIG.notifications.agentQuietFastMs,
        alertCooldownMs: APP_CONFIG.notifications.alertCooldownMs,
        userInteractionGraceMs: APP_CONFIG.notifications.userInteractionGraceMs,
        shellIntegration: APP_CONFIG.notifications.shellIntegration,
        agentHook: APP_CONFIG.notifications.agentHook,
        debug: APP_CONFIG.notifications.debug,
      },
      remoteAccess: {
        enabled: APP_CONFIG.remoteAccess.enabled,
        host: APP_CONFIG.remoteAccess.host,
        port: APP_CONFIG.remoteAccess.port,
        token: createAccessToken(),
        customPublicUrl: "",
        cloudflaredPath: "",
      },
      taskDefaults: {
        workerProvider: { providerId: "claude", model: "sonnet" },
        judgeProvider: { providerId: "claude", model: "opus" },
      },
      integrations: {
        azureDevops: {
          enabled: true,
          reviewRoot: defaultAzureReviewRoot(),
          defaultPollSeconds: 120,
          connections: [],
        },
        github: {
          enabled: true,
          reviewRoot: defaultGitHubReviewRoot(),
          defaultPollSeconds: 120,
          connections: [],
        },
      },
      git: {
        ui: {
          showAllActions: false,
        },
      },
    },
    tabTemplates: [
      { id: "shell", title: "Shell", command: "", icon: "\u{1F4BB}" },
      { id: "claude", title: "Claude Code", command: "claude", icon: "\u{1F916}" },
      { id: "codex", title: "Codex", command: "codex", icon: "\u{1F9E0}" },
      { id: "gemini", title: "Gemini CLI", command: "gemini", icon: "\u2728" },
      { id: "copilot", title: "GitHub Copilot", command: "copilot", icon: "\u{1F419}" },
      { id: "devserver", title: "Dev Server", command: "npm run dev", icon: "\u{1F680}" },
      { id: "tests", title: "Tests", command: "npm test", icon: "\u{1F9EA}" },
      { id: "docker", title: "Docker Compose", command: "docker compose up", icon: "\u{1F433}" },
      { id: "lazygit", title: "Lazygit", command: "lazygit", icon: "\u{1F500}" },
      { id: "browser", title: "Browser", command: "https://", icon: "\u{1F310}" },
      { id: "files", title: "Files", command: "__files__", icon: "\u{1F4C2}" },
    ],
    profiles: [{ id: "default", name: "Default", color: "#ffa424", workspaceIds: [] }],
    workspaces: [],
  };

  return {
    ...state,
    activeProjectId: state.activeWorkspaceId,
    profiles: state.profiles.map((profile) => ({
      ...profile,
      projectIds: [...profile.workspaceIds],
    })),
    projects: state.workspaces,
  };
}

function normalizeProfiles(rawProfiles, defaults) {
  return Array.isArray(rawProfiles) && rawProfiles.length
    ? rawProfiles.map((profile) => ({
        id: profile.id || `profile-${Date.now()}`,
        name: profile.name || "Unnamed",
        color: profile.color || "#ffa424",
        workspaceIds: Array.isArray(profile.workspaceIds)
          ? profile.workspaceIds
          : Array.isArray(profile.projectIds)
            ? profile.projectIds
            : [],
      }))
    : defaults.profiles;
}

/**
 * Ensure child workspaces are positioned right after their parent workspace.
 */
function groupChildWorkspaces(workspaces) {
  const byId = new Map(workspaces.map((workspace) => [workspace.id, workspace]));
  const children = new Map(); // parentId -> [child workspaces]
  const roots = [];

  // Index workspaces by cwd for fast parent lookup via directory path.
  // When multiple workspaces share the same cwd, prefer a same-profile match,
  // so build a Map<cwd, workspace[]> and resolve per-child below.
  const byCwd = new Map();
  for (const workspace of workspaces) {
    if (!workspace.cwd) continue;
    const norm = workspace.cwd.replace(/\\/g, "/").replace(/\/+$/, "");
    if (!byCwd.has(norm)) byCwd.set(norm, []);
    byCwd.get(norm).push(workspace);
  }

  // Also index each workspace's gitRoots so worktree children of multi-repo parents can find their parent
  for (const workspace of workspaces) {
    if (!Array.isArray(workspace.gitRoots)) continue;
    for (const root of workspace.gitRoots) {
      if (!root) continue;
      const norm = root.replace(/\\/g, "/").replace(/\/+$/, "");
      if (!byCwd.has(norm)) byCwd.set(norm, []);
      if (!byCwd.get(norm).includes(workspace)) byCwd.get(norm).push(workspace);
    }
  }

  function findParentByCwd(workspace) {
    const cwd = (workspace.cwd || "").replace(/\\/g, "/").replace(/\/+$/, "");
    const marker = "/.strideterm/tree/";
    const idx = cwd.lastIndexOf(marker);
    if (idx < 0) return null;
    const parentCwd = cwd.slice(0, idx);
    const candidates = byCwd.get(parentCwd);
    if (!candidates) return null;
    const childProfile = workspace.profileId || "default";
    // Exclude task workspaces and other worktree children — only real root workspaces can be parents.
    const isEligibleParent = (c) =>
      c.id !== workspace.id && c.kind !== "task" && !(c.notes || "").startsWith("Worktree of ");
    return (
      candidates.find((c) => isEligibleParent(c) && (c.profileId || "default") === childProfile) ||
      candidates.find((c) => isEligibleParent(c)) ||
      null
    );
  }

  function addChild(parentId, workspace) {
    if (!parentId) {
      roots.push(workspace);
      return;
    }
    if (!children.has(parentId)) {
      children.set(parentId, []);
    }
    children.get(parentId).push(workspace);
  }

  for (const workspace of workspaces) {
    if ((workspace.notes || "").startsWith("Worktree of ")) {
      const parentName = workspace.name.split(" / ")[0];
      const childProfile = workspace.profileId || "default";
      const parent =
        findParentByCwd(workspace) ||
        workspaces.find(
          (candidate) =>
            candidate.name === parentName &&
            candidate.id !== workspace.id &&
            (candidate.profileId || "default") === childProfile,
        ) ||
        workspaces.find((candidate) => candidate.name === parentName && candidate.id !== workspace.id) ||
        null;
      addChild(parent?.id || "", workspace);
      continue;
    }

    if (workspace.review?.provider === "azure-devops" && workspace.review?.checkout?.mode === "managed-worktree") {
      const explicitParent =
        workspace.review.parentWorkspaceId && byId.has(workspace.review.parentWorkspaceId)
          ? workspace.review.parentWorkspaceId
          : "";
      const fallbackParent =
        explicitParent ||
        workspaces.find(
          (candidate) =>
            candidate.kind === "azure" &&
            candidate.id !== workspace.id &&
            (candidate.profileId || "default") === (workspace.profileId || "default"),
        )?.id ||
        "";
      addChild(fallbackParent, workspace);
      continue;
    }

    if (workspace.review?.provider === "github" && workspace.review?.checkout?.mode === "managed-worktree") {
      const explicitParent =
        workspace.review.parentWorkspaceId && byId.has(workspace.review.parentWorkspaceId)
          ? workspace.review.parentWorkspaceId
          : "";
      const fallbackParent =
        explicitParent ||
        workspaces.find(
          (candidate) =>
            candidate.kind === "github" &&
            candidate.id !== workspace.id &&
            (candidate.profileId || "default") === (workspace.profileId || "default"),
        )?.id ||
        "";
      addChild(fallbackParent, workspace);
      continue;
    }

    if (workspace.quickfix?.parentWorkspaceId) {
      const parentId = byId.has(workspace.quickfix.parentWorkspaceId)
        ? workspace.quickfix.parentWorkspaceId
        : workspaces.find(
            (candidate) =>
              candidate.kind === "azure" &&
              candidate.id !== workspace.id &&
              (candidate.profileId || "default") === (workspace.profileId || "default"),
          )?.id || "";
      addChild(parentId, workspace);
      continue;
    }

    if (workspace.task?.parentWorkspaceId) {
      const parentId = byId.has(workspace.task.parentWorkspaceId) ? workspace.task.parentWorkspaceId : "";
      addChild(parentId, workspace);
      continue;
    }

    roots.push(workspace);
  }

  const result = [];
  const appendChildren = (parentId) => {
    const kids = children.get(parentId);
    if (!kids) {
      return;
    }
    for (const child of kids) {
      result.push(child);
      appendChildren(child.id);
    }
    children.delete(parentId);
  };

  for (const workspace of roots) {
    result.push(workspace);
    appendChildren(workspace.id);
  }

  for (const kids of children.values()) {
    result.push(...kids);
  }
  return result;
}

export function normalizeState(rawState = {}) {
  const defaults = createDefaultState();
  const rawWorkspaces = rawState.workspaces || rawState.projects || defaults.workspaces;
  const rawTemplates = rawState.tabTemplates;
  const tabTemplates =
    Array.isArray(rawTemplates) && rawTemplates.length
      ? rawTemplates.map((tmpl) => ({
          id: tmpl.id || `tmpl-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          title: repairVisibleText(tmpl.title || "Untitled"),
          command: tmpl.command ?? "",
          icon: repairVisibleText(tmpl.icon || "\u{1F4BB}"),
        }))
      : defaults.tabTemplates;
  // Ensure the "files" template exists for existing users.
  if (!tabTemplates.some((t) => t.id === "files" || t.command === "__files__")) {
    tabTemplates.push({ id: "files", title: "Files", command: "__files__", icon: "\u{1F4C2}" });
  }
  // Migration for existing users: ensure the "copilot" agent template exists
  // alongside claude/codex/gemini. Insert right after the last built-in agent
  // so the group stays tidy in the Tab picker dropdown.
  if (!tabTemplates.some((t) => t.id === "copilot" || t.command === "copilot")) {
    const copilotTemplate = { id: "copilot", title: "GitHub Copilot", command: "copilot", icon: "\u{1F419}" };
    const anchorIdx = (() => {
      for (const anchor of ["gemini", "codex", "claude"]) {
        const idx = tabTemplates.findIndex((t) => t.id === anchor);
        if (idx >= 0) return idx;
      }
      return -1;
    })();
    if (anchorIdx >= 0) tabTemplates.splice(anchorIdx + 1, 0, copilotTemplate);
    else tabTemplates.push(copilotTemplate);
  }
  const profiles = normalizeProfiles(rawState.profiles, defaults);
  const activeProfileId = profiles.some((profile) => profile.id === rawState.activeProfileId)
    ? rawState.activeProfileId
    : profiles[0]?.id || "default";

  const VALID_LOG_LEVELS = ["error", "warn", "info", "debug", "trace"];
  const rawLogLevel = (rawState.settings || {}).logLevel;
  const rawNotifications = (rawState.settings || {}).notifications || {};
  const normalizedSettings = {
    ...defaults.settings,
    ...(rawState.settings || {}),
    logLevel: VALID_LOG_LEVELS.includes(rawLogLevel) ? rawLogLevel : defaults.settings.logLevel,
    notifications: {
      promptQuietMs:
        Number(rawNotifications.promptQuietMs) > 0
          ? Number(rawNotifications.promptQuietMs)
          : defaults.settings.notifications.promptQuietMs,
      agentQuietMs:
        Number(rawNotifications.agentQuietMs) > 0
          ? Number(rawNotifications.agentQuietMs)
          : defaults.settings.notifications.agentQuietMs,
      agentQuietFastMs:
        Number(rawNotifications.agentQuietFastMs) > 0
          ? Number(rawNotifications.agentQuietFastMs)
          : defaults.settings.notifications.agentQuietFastMs,
      alertCooldownMs:
        Number(rawNotifications.alertCooldownMs) >= 0
          ? Number(rawNotifications.alertCooldownMs)
          : defaults.settings.notifications.alertCooldownMs,
      userInteractionGraceMs:
        Number(rawNotifications.userInteractionGraceMs) >= 0
          ? Number(rawNotifications.userInteractionGraceMs)
          : defaults.settings.notifications.userInteractionGraceMs,
      shellIntegration:
        typeof rawNotifications.shellIntegration === "boolean"
          ? rawNotifications.shellIntegration
          : defaults.settings.notifications.shellIntegration,
      agentHook:
        typeof rawNotifications.agentHook === "boolean"
          ? rawNotifications.agentHook
          : defaults.settings.notifications.agentHook,
      debug:
        typeof rawNotifications.debug === "boolean" ? rawNotifications.debug : defaults.settings.notifications.debug,
    },
    remoteAccess: {
      ...defaults.settings.remoteAccess,
      ...((rawState.settings || {}).remoteAccess || {}),
      host:
        ((rawState.settings || {}).remoteAccess || {}).host === "127.0.0.1"
          ? "0.0.0.0"
          : ((rawState.settings || {}).remoteAccess || {}).host || defaults.settings.remoteAccess.host,
      token: ((rawState.settings || {}).remoteAccess || {}).token || defaults.settings.remoteAccess.token,
    },
    integrations: {
      ...defaults.settings.integrations,
      ...((rawState.settings || {}).integrations || {}),
      azureDevops: {
        ...defaults.settings.integrations.azureDevops,
        ...(((rawState.settings || {}).integrations || {}).azureDevops || {}),
        connections: Array.isArray((((rawState.settings || {}).integrations || {}).azureDevops || {}).connections)
          ? (((rawState.settings || {}).integrations || {}).azureDevops || {}).connections.map((connection, index) => ({
              id: connection.id || `ado-${index + 1}`,
              label: connection.label || connection.id || `Azure ${index + 1}`,
              orgUrl: connection.orgUrl || "",
              login: connection.login || "",
              tokenRef: connection.tokenRef || "",
              enabled: connection.enabled !== false,
              profileId: connection.profileId || "",
              projectFilters: Array.isArray(connection.projectFilters) ? [...connection.projectFilters] : [],
              repositoryFilters: Array.isArray(connection.repositoryFilters) ? [...connection.repositoryFilters] : [],
              pollSeconds:
                Number(connection.pollSeconds) || defaults.settings.integrations.azureDevops.defaultPollSeconds,
              reviewRoot: connection.reviewRoot || defaults.settings.integrations.azureDevops.reviewRoot,
            }))
          : [],
      },
      github: {
        ...defaults.settings.integrations.github,
        ...(((rawState.settings || {}).integrations || {}).github || {}),
        connections: Array.isArray((((rawState.settings || {}).integrations || {}).github || {}).connections)
          ? (((rawState.settings || {}).integrations || {}).github || {}).connections.map((connection, index) => ({
              id: connection.id || `gh-${index + 1}`,
              label: connection.label || connection.id || `GitHub ${index + 1}`,
              hostUrl: connection.hostUrl || "https://github.com",
              apiBaseUrl: connection.apiBaseUrl || "",
              currentUserLogin: connection.currentUserLogin || "",
              tokenRef: connection.tokenRef || "",
              enabled: connection.enabled !== false,
              profileId: connection.profileId || "",
              ownerFilters: Array.isArray(connection.ownerFilters) ? [...connection.ownerFilters] : [],
              repositoryFilters: Array.isArray(connection.repositoryFilters) ? [...connection.repositoryFilters] : [],
              pollSeconds: Number(connection.pollSeconds) || defaults.settings.integrations.github.defaultPollSeconds,
              reviewRoot: connection.reviewRoot || defaults.settings.integrations.github.reviewRoot,
            }))
          : [],
      },
    },
    taskDefaults: {
      ...defaults.settings.taskDefaults,
      ...((rawState.settings || {}).taskDefaults || {}),
      workerProvider: {
        ...defaults.settings.taskDefaults.workerProvider,
        ...(((rawState.settings || {}).taskDefaults || {}).workerProvider || {}),
      },
      judgeProvider: {
        ...defaults.settings.taskDefaults.judgeProvider,
        ...(((rawState.settings || {}).taskDefaults || {}).judgeProvider || {}),
      },
    },
    git: {
      ui: {
        showAllActions:
          typeof (rawState.settings || {}).git?.ui?.showAllActions === "boolean"
            ? (rawState.settings || {}).git.ui.showAllActions
            : defaults.settings.git.ui.showAllActions,
      },
    },
  };
  const workspaces = groupChildWorkspaces(
    rawWorkspaces
      .map((workspace, index) => normalizeWorkspace(workspace, index))
      .map((workspace) => {
        if (workspace.kind === "azure" && !String(workspace.cwd || "").trim()) {
          return {
            ...workspace,
            cwd:
              normalizedSettings.integrations.azureDevops.reviewRoot ||
              defaults.settings.integrations.azureDevops.reviewRoot,
          };
        }
        if (workspace.kind === "github" && !String(workspace.cwd || "").trim()) {
          return {
            ...workspace,
            cwd: normalizedSettings.integrations.github.reviewRoot || defaults.settings.integrations.github.reviewRoot,
          };
        }
        return workspace;
      }),
  );

  // Validate activeWorkspaceId against workspaces in the active profile
  const profileWorkspaces = workspaces.filter((workspace) => (workspace.profileId || "default") === activeProfileId);
  const requestedActiveWorkspaceId = rawState.activeWorkspaceId || rawState.activeProjectId;
  const activeWorkspaceId = profileWorkspaces.some((workspace) => workspace.id === requestedActiveWorkspaceId)
    ? requestedActiveWorkspaceId
    : profileWorkspaces[0]?.id || "";

  // Migrate Azure connections without profileId: assign to the profile that owns
  // the Azure workspace, or fallback to the active profile.
  const azureConnections = normalizedSettings.integrations?.azureDevops?.connections || [];
  const hasUntaggedConnections = azureConnections.some((c) => !c.profileId);
  if (hasUntaggedConnections) {
    const azureWorkspaceProfile = workspaces.find((w) => w.kind === "azure")?.profileId || activeProfileId;
    normalizedSettings.integrations.azureDevops.connections = azureConnections.map((c) =>
      c.profileId ? c : { ...c, profileId: azureWorkspaceProfile },
    );
  }

  const normalized = {
    ...defaults,
    ...rawState,
    activeWorkspaceId,
    activeProfileId,
    settings: normalizedSettings,
    tabTemplates,
    profiles,
    workspaces,
  };

  return {
    ...normalized,
    activeProjectId: normalized.activeWorkspaceId,
    profiles: normalized.profiles.map((profile) => ({
      ...profile,
      projectIds: [...profile.workspaceIds],
    })),
    projects: normalized.workspaces,
  };
}

export function createSessionId(workspaceId, panelId) {
  return `${workspaceId}:${panelId}`;
}

export function parseSessionId(sessionId) {
  const [workspaceId, panelId] = String(sessionId || "").split(":");
  if (!workspaceId || !panelId) {
    return null;
  }

  return { workspaceId, panelId };
}

// Backward-compatible aliases while the wider codebase migrates from project naming.
export const normalizeProject = normalizeWorkspace;
