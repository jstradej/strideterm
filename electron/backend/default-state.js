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

function defaultRootCwd() {
  return os.homedir();
}

function defaultAzureReviewRoot() {
  return path.join(os.homedir(), ".strideterm", "azure-pr");
}

function defaultGitHubReviewRoot() {
  return path.join(os.homedir(), ".strideterm", "github-pr");
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
  };
}

export function normalizeWorkspace(workspace, index = 0) {
  const isDockerWorkspace = (workspace.id || "") === "docker" || workspace.kind === "docker";
  const isAzureWorkspace = workspace.kind === "azure";
  const isGitHubWorkspace = workspace.kind === "github";
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

  return {
    id: workspace.id || `workspace-${index + 1}`,
    name: repairVisibleText(workspace.name || `Workspace ${index + 1}`),
    icon: repairVisibleText(workspace.icon || APP_CONFIG.ui.defaultProjectIcon),
    color: workspace.color || APP_CONFIG.ui.defaultProjectColor,
    kind: isDockerWorkspace
      ? "docker"
      : isAzureWorkspace
        ? "azure"
        : isGitHubWorkspace
          ? "github"
          : workspace.kind || APP_CONFIG.ui.defaultProjectKind,
    source: workspace.source === "plugin" ? "plugin" : "manual",
    pluginId: workspace.pluginId || "",
    cwd: workspace.cwd || (isAzureWorkspace || isGitHubWorkspace ? "" : defaultCwd()),
    notes: repairVisibleText(workspace.notes || ""),
    profileId: workspace.profileId || "default",
    connectionId: workspace.connectionId || workspace.quickfix?.connectionId || workspace.review?.connectionId || "",
    activePanelId,
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
      remoteAccess: {
        enabled: APP_CONFIG.remoteAccess.enabled,
        host: APP_CONFIG.remoteAccess.host,
        port: APP_CONFIG.remoteAccess.port,
        token: createAccessToken(),
        customPublicUrl: "",
        cloudflaredPath: "",
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
    },
    tabTemplates: [
      { id: "shell", title: "Shell", command: "", icon: "\u{1F4BB}" },
      { id: "claude", title: "Claude Code", command: "claude", icon: "\u{1F916}" },
      { id: "codex", title: "Codex", command: "codex", icon: "\u{1F9E0}" },
      { id: "gemini", title: "Gemini CLI", command: "gemini", icon: "\u2728" },
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
      const parent =
        workspaces.find((candidate) => candidate.name === parentName && candidate.id !== workspace.id) || null;
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
  const profiles = normalizeProfiles(rawState.profiles, defaults);
  const activeProfileId = profiles.some((profile) => profile.id === rawState.activeProfileId)
    ? rawState.activeProfileId
    : profiles[0]?.id || "default";

  const normalizedSettings = {
    ...defaults.settings,
    ...(rawState.settings || {}),
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
