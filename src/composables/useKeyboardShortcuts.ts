import { onMounted, onUnmounted } from "vue";
import { useAppStore } from "../stores/app.js";
import { useTerminalStore } from "../stores/terminal.js";
import { useNotificationStore } from "../stores/notifications.js";
import type { Transport } from "../transport.js";
import type { StatePayload } from "../../electron/shared/types/state.js";

function shortcutTabDirection(event: KeyboardEvent): number {
  const key = String(event?.key || "");
  const code = String(event?.code || "");
  if (key === "PageDown" || key === "Next" || code === "PageDown") return 1;
  if (key === "PageUp" || key === "Prior" || code === "PageUp") return -1;
  return 0;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyApi = any;

export function useKeyboardShortcuts(api: Transport, { onNewWorkspace }: { onNewWorkspace?: () => void } = {}) {
  const appStore = useAppStore();
  const termStore = useTerminalStore();
  const notifStore = useNotificationStore();

  async function handleKeydown(event: KeyboardEvent) {
    if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey) {
      const digitMatch = event.code?.match(/^Digit([1-9])$/);
      if (digitMatch) {
        event.preventDefault();
        event.stopImmediatePropagation();
        const workspaces = appStore.filteredWorkspaces;
        const index = parseInt(digitMatch[1], 10) - 1;
        if (index < workspaces.length) {
          await appStore.activateWorkspaceInGrid(workspaces[index].id);
          termStore.focusActiveTerminal();
        }
        return;
      }
    }

    // Ctrl/Cmd+Shift+N — focus the notification dock. When pinned, just
    // focuses; when unpinned, opens the overlay panel and focuses it.
    if ((event.ctrlKey || event.metaKey) && event.shiftKey && !event.altKey && event.key.toLowerCase() === "n") {
      event.preventDefault();
      event.stopImmediatePropagation();
      if (!notifStore.pinned && !notifStore.panelOpen) {
        notifStore.togglePanel();
      }
      notifStore.requestFocus();
      return;
    }

    // Ctrl/Cmd+Shift+G — toggle workspace grid (enable cols with active workspace, or disable)
    if ((event.ctrlKey || event.metaKey) && event.shiftKey && !event.altKey && event.key.toLowerCase() === "g") {
      event.preventDefault();
      event.stopImmediatePropagation();
      if (appStore.isGridVisible) {
        await appStore.disableWorkspaceGrid();
      } else {
        await appStore.enableWorkspaceGrid("grid");
      }
      return;
    }

    // Alt+1..4 — focus grid cell by index
    // Alt+Shift+1..4 — open picker for grid cell by index
    if (event.altKey && !event.ctrlKey && !event.metaKey) {
      const digitMatch = event.code?.match(/^Digit([1-4])$/);
      if (digitMatch && appStore.isGridVisible) {
        event.preventDefault();
        event.stopImmediatePropagation();
        const cellIndex = parseInt(digitMatch[1], 10) - 1;
        if (!event.shiftKey) {
          const grid = appStore.workspaceGrid;
          const wsId = grid?.cellWorkspaceIds?.[cellIndex];
          if (wsId) {
            await appStore.activateWorkspace(wsId);
            termStore.focusActiveTerminal();
          }
        }
        // Alt+Shift+1..4: open picker — handled by focusGridCellPicker event
        // (picker opens on the WorkspaceCell component; dispatch a custom event)
        if (event.shiftKey) {
          window.dispatchEvent(new CustomEvent("open-grid-cell-picker", { detail: { cellIndex } }));
        }
        return;
      }
    }

    // Ctrl+\ — cycle grid layouts when grid exists
    if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.key === "\\") {
      const grid = appStore.workspaceGrid;
      if (grid) {
        event.preventDefault();
        event.stopImmediatePropagation();
        const layouts = ["cols", "rows", "grid", "top-split", "left-split"];
        const currentIdx = layouts.indexOf(grid.layout);
        const nextLayout = layouts[(currentIdx + 1) % layouts.length];
        await appStore.setGridLayout(nextLayout);
        return;
      }
    }

    if (!(event.ctrlKey || event.metaKey)) return;

    // Cmd/Ctrl+Shift+W — close the current window directly (multi-window only)
    if (event.shiftKey && event.key.toLowerCase() === "w" && appStore.myWindowId) {
      event.preventDefault();
      event.stopImmediatePropagation();
      (window as AnyApi).strideterm?.closeWindow?.();
      return;
    }

    // Cmd/Ctrl+W — cascade: close active tab → workspace → window
    if (!event.shiftKey && !event.altKey && event.key.toLowerCase() === "w") {
      const activeWs = (appStore.payload as AnyApi)?.workspace?.workspace || (appStore.payload as AnyApi)?.workspace?.project;
      const activeViewId = appStore.activeViewId;
      const panels: AnyApi[] = activeWs?.panels || [];
      if (activeWs && activeViewId && panels.length > 1) {
        // Multiple panels: close the active tab
        event.preventDefault();
        event.stopImmediatePropagation();
        appStore.closeTab(activeViewId);
        return;
      }
      if (appStore.myWindowId) {
        // Last panel (or no workspace): try to navigate away, else close window
        const others = appStore.filteredWorkspaces.filter((ws: AnyApi) => ws.id !== activeWs?.id);
        if (others.length > 0) {
          // Navigate to the next workspace in this profile
          event.preventDefault();
          event.stopImmediatePropagation();
          await appStore.activateWorkspaceInGrid(others[0].id);
          termStore.focusActiveTerminal();
        } else {
          // No workspaces left in this profile — close the window
          event.preventDefault();
          event.stopImmediatePropagation();
          (window as AnyApi).strideterm?.closeWindow?.();
        }
        return;
      }
      // Single window (no myWindowId) — fall through to browser default
    }

    if (event.key.toLowerCase() === "n") {
      event.preventDefault();
      onNewWorkspace?.();
      return;
    }

    if (event.key.toLowerCase() === "r" && appStore.activeSessionId) {
      event.preventDefault();
      const nextPayload = await api.restartTerminal(appStore.activeSessionId);
      appStore.payload = nextPayload as StatePayload;
      termStore.focusActiveTerminal();
      return;
    }

    const direction = shortcutTabDirection(event);
    if (direction !== 0) {
      event.preventDefault();
      event.stopImmediatePropagation();
      if (event.shiftKey) {
        // Ctrl/Cmd+Shift+PgUp/PgDown — switch workspace. Always cycles through
        // all workspaces sequentially; star filtering happens via display, not navigation.
        const all = appStore.filteredWorkspaces as Array<{ id: string; starred?: boolean }>;
        if (all.length < 2) return;
        const list = all;
        const activeId = appStore.myActiveWorkspaceId || null;
        const currentIdx = list.findIndex((ws) => ws.id === activeId);
        const target =
          currentIdx === -1
            ? direction > 0
              ? list[0]
              : list[list.length - 1]
            : list[(currentIdx + direction + list.length) % list.length];
        await appStore.activateWorkspaceInGrid(target.id);
        termStore.focusActiveTerminal();
        return;
      }
      const tabs = appStore.workspaceTabs;
      if (tabs.length < 2) return;
      const currentIndex = tabs.findIndex((tab) => tab.id === appStore.activeViewId);
      const nextIndex = (currentIndex + direction + tabs.length) % tabs.length;
      await appStore.activateView(tabs[nextIndex].id);
      termStore.focusActiveTerminal();
    }
  }

  onMounted(() => {
    window.addEventListener("keydown", handleKeydown, true);
  });

  onUnmounted(() => {
    window.removeEventListener("keydown", handleKeydown, true);
  });
}
