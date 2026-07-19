import { APP_CONFIG } from "../config/app-config.js";
import type { WorkspaceState } from "../electron/shared/types/state.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type WorkspaceWithParentRefs = WorkspaceState & { review?: any; quickfix?: any };

export interface EmptyPanel {
  id: string;
  title: string;
  command: string;
  shell: boolean;
  startup: string;
}

export interface EmptyWorkspace {
  id: string;
  name: string;
  icon: string;
  color: string;
  kind: string;
  source: string;
  pluginId: string;
  cwd: string;
  notes: string;
  activePanelId: string;
  panels: EmptyPanel[];
}

export function createEmptyWorkspace(): EmptyWorkspace {
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
      {
        id: panelId,
        title: APP_CONFIG.ui.defaultPanelTitle,
        command: "",
        shell: true,
        startup: APP_CONFIG.ui.defaultPanelStartup,
      },
    ],
  };
}

export function cloneWorkspace<T>(workspace: T): T {
  return JSON.parse(JSON.stringify(workspace)) as T;
}

/**
 * Resolves the explicit parent workspace id, if any, of a review/quickfix/task
 * child workspace. Used to build the drag-drop reparenting rules and the
 * workspace-tree indent depth from the same notion of "parent".
 */
export function getParentWorkspaceId(ws: WorkspaceWithParentRefs): string | null {
  if (ws.review?.checkout?.mode === "managed-worktree" && ws.review?.parentWorkspaceId) {
    return ws.review.parentWorkspaceId;
  }
  if (ws.quickfix?.parentWorkspaceId) return ws.quickfix.parentWorkspaceId;
  if (ws.task?.parentWorkspaceId) return ws.task.parentWorkspaceId ?? null;
  return null;
}

export function statusTone(status: string): "running" | "error" | "idle" {
  switch (status) {
    case "running":
      return "running";
    case "exited":
      return "error";
    default:
      return "idle";
  }
}
