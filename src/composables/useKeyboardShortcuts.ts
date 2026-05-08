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
          await appStore.activateWorkspace(workspaces[index].id);
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

    if (!(event.ctrlKey || event.metaKey)) return;

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
        // Ctrl/Cmd+Shift+PgUp/PgDown — switch workspace.
        // Cycles through starred workspaces if any exist, otherwise all.
        const all = appStore.filteredWorkspaces as Array<{ id: string; starred?: boolean }>;
        if (all.length < 2) return;
        const starred = all.filter((ws) => ws.starred);
        const list = starred.length > 0 ? starred : all;
        const activeId = appStore.payload?.appState?.activeWorkspaceId || null;
        const currentIdx = list.findIndex((ws) => ws.id === activeId);
        const target =
          currentIdx === -1
            ? direction > 0
              ? list[0]
              : list[list.length - 1]
            : list[(currentIdx + direction + list.length) % list.length];
        await appStore.activateWorkspace(target.id);
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
