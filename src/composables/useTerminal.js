import { onMounted } from "vue";
import { useTerminalStore } from "../stores/terminal.js";

/**
 * Manages terminal attachment lifecycle for a single session.
 * Attaches on mount, leaves terminal intact on unmount
 * (terminal lives in the store's views Map until explicitly pruned).
 */
export function useTerminal(sessionId, paneBodyRef) {
  const termStore = useTerminalStore();

  onMounted(() => {
    if (paneBodyRef.value) {
      termStore.attachTerminalPane(sessionId, paneBodyRef.value);
    }
  });

  // No cleanup on unmount — terminal stays in the Map for re-attachment
}
