import { APP_CONFIG } from "../config/app-config.js";

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
