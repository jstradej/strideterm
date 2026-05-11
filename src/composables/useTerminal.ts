import { onMounted, watch, type Ref } from "vue";
import { useTerminalStore } from "../stores/terminal.js";

/**
 * Manages terminal attachment lifecycle for a single session.
 *
 * Attaches on mount and re-attaches whenever the sessionId getter returns a
 * new value, so a host that swaps which session it shows (e.g. a workspace-
 * grid cell whose tab strip changed activeViewId) doesn't have to unmount
 * the whole TerminalPane — Vue keeps the same DOM node and we just rebind
 * xterm to the new session's view. Leaves terminal intact on unmount;
 * terminal lives in the store's views Map until explicitly pruned.
 *
 * Pass a getter (e.g. `() => props.sessionId`) so the watch fires on prop
 * changes; passing a static string only attaches once at mount.
 */
export function useTerminal(sessionId: string | (() => string), paneBodyRef: Ref<HTMLDivElement | null | undefined>) {
  const termStore = useTerminalStore();
  const getId = typeof sessionId === "function" ? sessionId : () => sessionId;

  function attach(): void {
    const id = getId();
    if (id && paneBodyRef.value) {
      termStore.attachTerminalPane(id, paneBodyRef.value);
    }
  }

  onMounted(attach);
  watch(getId, attach);
}
