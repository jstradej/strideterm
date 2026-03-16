import { APP_CONFIG } from "../config/app-config.js";

export function createEmptyWorkspace() {
  const panelId = `panel-${crypto.randomUUID()}`;
  return {
    id: `workspace-${crypto.randomUUID()}`,
    name: "",
    icon: APP_CONFIG.ui.defaultProjectIcon,
    color: APP_CONFIG.ui.defaultProjectColor,
    kind: APP_CONFIG.ui.defaultProjectKind,
    source: "manual",
    pluginId: "",
    cwd: "",
    notes: "",
    activePanelId: panelId,
    panels: [
      { id: panelId, title: APP_CONFIG.ui.defaultPanelTitle, command: "", shell: true, startup: APP_CONFIG.ui.defaultPanelStartup },
    ],
  };
}

export function cloneWorkspace(workspace) {
  return JSON.parse(JSON.stringify(workspace));
}

export function normalizeWorkspaces(workspaces) {
  return [...workspaces];
}

export function statusTone(status) {
  switch (status) {
    case "running":
      return "running";
    case "exited":
      return "error";
    default:
      return "idle";
  }
}

// Backward-compatible aliases while the migration from project naming completes.
export const createEmptyProject = createEmptyWorkspace;
export const cloneProject = cloneWorkspace;
export const normalizeProjects = normalizeWorkspaces;
