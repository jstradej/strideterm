import { nextTick, onBeforeUnmount, onMounted, watch, type Ref } from "vue";
import { useTerminalStore } from "../stores/terminal.js";

/**
 * Manages terminal attachment lifecycle for a single session.
 *
 * Leaves the terminal view alive in the store on unmount, but detaches its DOM
 * host and observer from the Vue pane so a later mount starts from a clean host.
 *
 * Pass a getter (e.g. `() => props.sessionId`) so the watch fires on prop
 * changes; passing a static string only attaches once at mount.
 */
export function useTerminal(sessionId: string | (() => string), paneBodyRef: Ref<HTMLDivElement | null | undefined>) {
  const termStore = useTerminalStore();
  const getId = typeof sessionId === "function" ? sessionId : () => sessionId;
  let attachRun = 0;
  let attachedId: string | null = null;

  async function attach(): Promise<void> {
    const run = ++attachRun;
    const id = getId();
    await nextTick();
    if (run !== attachRun) {
      return;
    }
    const paneBody = paneBodyRef.value;
    if (id && paneBody) {
      termStore.attachTerminalPane(id, paneBody);
      attachedId = id;
    }
  }

  function detach(): void {
    attachRun += 1;
    if (attachedId) {
      termStore.detachTerminalPane(attachedId, paneBodyRef.value);
      attachedId = null;
    }
  }

  onMounted(() => {
    void attach();
  });
  watch(
    getId,
    (nextId, previousId) => {
      if (nextId === previousId) {
        return;
      }
      detach();
      void attach();
    },
    { flush: "post" },
  );
  onBeforeUnmount(detach);
}
