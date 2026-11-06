import { inject, onBeforeUnmount, onMounted, type Ref } from "vue";
import { apiKey } from "../types/keys.js";
import type { Transport } from "../transport.js";
import type { PanelState, WorkspaceState } from "../../electron/shared/types/state.js";
import { useAppStore } from "../stores/app.js";
import { useNotificationStore } from "../stores/notifications.js";
import { useTerminalStore } from "../stores/terminal.js";
import { PATHS_MIME, formatDroppedPaths, readDragPaths, terminalDropKind } from "../lib/terminal-path-drop.js";

const TITLE = "Cannot drop here";

export function useTerminalPathDrop(sessionId: () => string, target: Ref<HTMLElement | null | undefined>) {
  const api = inject<Transport | null>(apiKey, null);
  const appStore = useAppStore();
  const notifications = useNotificationStore();
  const termStore = useTerminalStore();

  function refuse(body: string): void {
    notifications.pushEphemeralToast({ title: TITLE, body, kind: "error", durationMs: 7000 });
  }

  function findPanel(id: string): PanelState | null {
    const separator = id.indexOf(":");
    if (separator <= 0) return null;
    const workspaces = (appStore.payload?.appState?.workspaces || []) as WorkspaceState[];
    const workspace = workspaces.find((ws) => ws?.id === id.slice(0, separator));
    return workspace?.panels?.find((panel) => panel?.id === id.slice(separator + 1)) || null;
  }

  function droppedFilePaths(files: FileList): string[] | null {
    if (api?.isRemote !== false || typeof api.getPathForDroppedFile !== "function") {
      refuse("Dropping files from this computer needs the desktop app. Drag them from the Files tab instead.");
      return null;
    }
    const paths: string[] = [];
    for (const file of Array.from(files)) {
      const path = api.getPathForDroppedFile(file);
      if (!path) {
        refuse(`Could not read the location of "${file.name}".`);
        return null;
      }
      paths.push(path);
    }
    return paths;
  }

  function accepts(event: DragEvent): boolean {
    const types = Array.from(event.dataTransfer?.types || []);
    return types.includes(PATHS_MIME) || types.includes("Files");
  }

  function onDragOver(event: DragEvent): void {
    if (!accepts(event)) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
  }

  function onDrop(event: DragEvent): void {
    if (!accepts(event)) return;
    event.preventDefault();
    event.stopPropagation();
    const dt = event.dataTransfer;
    const paths = readDragPaths(dt) ?? (dt?.files?.length ? droppedFilePaths(dt.files) : null);
    if (!paths) return;
    const id = sessionId();
    const platform = appStore.payload?.meta?.platform || "";
    const formatted = formatDroppedPaths(paths, platform, terminalDropKind(findPanel(id), platform));
    if (!formatted.ok) {
      refuse(formatted.error);
      return;
    }
    if (!termStore.pasteToTerminal(id, formatted.text)) {
      refuse("The terminal is not ready to receive input.");
    }
  }

  onMounted(() => {
    target.value?.addEventListener("dragover", onDragOver);
    target.value?.addEventListener("drop", onDrop);
  });
  onBeforeUnmount(() => {
    target.value?.removeEventListener("dragover", onDragOver);
    target.value?.removeEventListener("drop", onDrop);
  });
}
