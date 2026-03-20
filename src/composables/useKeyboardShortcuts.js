import { onMounted, onUnmounted } from "vue";
import { useAppStore } from "../stores/app.js";
import { useTerminalStore } from "../stores/terminal.js";

function shortcutTabDirection(event) {
  const key = String(event?.key || "");
  const code = String(event?.code || "");
  if (key === "PageDown" || key === "Next" || code === "PageDown") return 1;
  if (key === "PageUp" || key === "Prior" || code === "PageUp") return -1;
  return 0;
}

export function useKeyboardShortcuts(api, { onNewWorkspace } = {}) {
  const appStore = useAppStore();
  const termStore = useTerminalStore();

  async function handleKeydown(event) {
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

    if (!(event.ctrlKey || event.metaKey)) return;

    if (event.key.toLowerCase() === "n") {
      event.preventDefault();
      onNewWorkspace?.();
      return;
    }

    if (event.key.toLowerCase() === "r" && appStore.activeSessionId) {
      event.preventDefault();
      const nextPayload = await api.restartTerminal(appStore.activeSessionId);
      appStore.payload = nextPayload;
      termStore.focusActiveTerminal();
      return;
    }

    const direction = shortcutTabDirection(event);
    if (direction !== 0) {
      event.preventDefault();
      event.stopImmediatePropagation();
      const tabs = appStore.workspaceTabs;
      if (tabs.length < 2) return;
      const currentIndex = tabs.findIndex((tab) => tab.id === appStore.activeViewId);
      const nextIndex = (currentIndex + direction + tabs.length) % tabs.length;
      await appStore.activateView(tabs[nextIndex].id);
    }
  }

  onMounted(() => {
    window.addEventListener("keydown", handleKeydown, true);
  });

  onUnmounted(() => {
    window.removeEventListener("keydown", handleKeydown, true);
  });
}
