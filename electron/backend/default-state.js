import os from "node:os";
import { randomBytes } from "node:crypto";
import { APP_CONFIG } from "../../config/app-config.js";

function defaultCwd() {
  return os.homedir();
}

function defaultRootCwd() {
  return os.homedir();
}

export function createAccessToken() {
  return randomBytes(18).toString("base64url");
}

function normalizePanel(panel, panelIndex = 0) {
  return {
    id: panel.id || `panel-${panelIndex + 1}`,
    title: panel.title || `Panel ${panelIndex + 1}`,
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
  const rawPanels = isDockerWorkspace
    ? (workspace.panels || []).filter((panel) => !(panel.id === "lazydocker" && panel.command === "lazydocker" && !panel.launch))
    : (workspace.panels || []).filter((panel) => !(panel.id === "git" && !panel.command && !panel.launch));
  const panels = rawPanels.map((panel, panelIndex) => normalizePanel(panel, panelIndex));
  const fallbackPanelId = panels[0]?.id || null;
  const activePanelId = panels.some((panel) => panel.id === workspace.activePanelId)
    ? workspace.activePanelId
    : fallbackPanelId;

  return {
    id: workspace.id || `workspace-${index + 1}`,
    name: workspace.name || `Workspace ${index + 1}`,
    icon: workspace.icon || APP_CONFIG.ui.defaultProjectIcon,
    color: workspace.color || APP_CONFIG.ui.defaultProjectColor,
    kind: isDockerWorkspace ? "docker" : (workspace.kind || APP_CONFIG.ui.defaultProjectKind),
    source: workspace.source === "plugin" ? "plugin" : "manual",
    pluginId: workspace.pluginId || "",
    cwd: workspace.cwd || defaultCwd(),
    notes: workspace.notes || "",
    profileId: workspace.profileId || "default",
    activePanelId,
    panels,
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
    ],
    profiles: [
      { id: "default", name: "Default", color: "#ffa424", workspaceIds: [] },
    ],
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
          : (Array.isArray(profile.projectIds) ? profile.projectIds : []),
      }))
    : defaults.profiles;
}

/**
 * Ensure worktree children are positioned right after their parent workspace.
 */
function groupWorktrees(workspaces) {
  const children = new Map(); // parentName -> [child workspaces]
  const roots = [];
  for (const ws of workspaces) {
    if ((ws.notes || "").startsWith("Worktree of ")) {
      const parentName = ws.name.split(" / ")[0];
      if (!children.has(parentName)) children.set(parentName, []);
      children.get(parentName).push(ws);
    } else {
      roots.push(ws);
    }
  }
  const result = [];
  for (const ws of roots) {
    result.push(ws);
    const kids = children.get(ws.name);
    if (kids) {
      result.push(...kids);
      children.delete(ws.name);
    }
  }
  // Append any orphaned worktrees (parent missing/renamed)
  for (const kids of children.values()) {
    result.push(...kids);
  }
  return result;
}

export function normalizeState(rawState = {}) {
  const defaults = createDefaultState();
  const rawWorkspaces = rawState.workspaces || rawState.projects || defaults.workspaces;
  const workspaces = groupWorktrees(
    rawWorkspaces.map((workspace, index) => normalizeWorkspace(workspace, index)),
  );
  const profiles = normalizeProfiles(rawState.profiles, defaults);
  const activeProfileId = profiles.some((profile) => profile.id === rawState.activeProfileId)
    ? rawState.activeProfileId
    : profiles[0]?.id || "default";

  // Validate activeWorkspaceId against workspaces in the active profile
  const profileWorkspaces = workspaces.filter((w) => (w.profileId || "default") === activeProfileId);
  const requestedActiveWorkspaceId = rawState.activeWorkspaceId || rawState.activeProjectId;
  const activeWorkspaceId = profileWorkspaces.some((w) => w.id === requestedActiveWorkspaceId)
    ? requestedActiveWorkspaceId
    : profileWorkspaces[0]?.id || "";

  const rawTemplates = rawState.tabTemplates;
  const tabTemplates = Array.isArray(rawTemplates) && rawTemplates.length
    ? rawTemplates.map((tmpl) => ({
        id: tmpl.id || `tmpl-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        title: tmpl.title || "Untitled",
        command: tmpl.command ?? "",
        icon: tmpl.icon || "\u{1F4BB}",
      }))
    : defaults.tabTemplates;

  const normalized = {
    ...defaults,
    ...rawState,
    activeWorkspaceId,
    activeProfileId,
    settings: {
      ...defaults.settings,
      ...(rawState.settings || {}),
      remoteAccess: {
        ...defaults.settings.remoteAccess,
        ...((rawState.settings || {}).remoteAccess || {}),
        host: ((rawState.settings || {}).remoteAccess || {}).host === "127.0.0.1"
          ? "0.0.0.0"
          : (((rawState.settings || {}).remoteAccess || {}).host || defaults.settings.remoteAccess.host),
        token: ((rawState.settings || {}).remoteAccess || {}).token || defaults.settings.remoteAccess.token,
      },
    },
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
