import { onMounted, onUnmounted } from "vue";
import { useTerminalStore } from "../stores/terminal.js";

export function useGlobalEvents() {
  const termStore = useTerminalStore();

  let viewportTimer = 0;

  function handleResize() {
    if (termStore.views.size > 0) {
      termStore.scheduleAllVisibleResize();
    }
  }

  function handleVisualViewportResize() {
    cancelAnimationFrame(viewportTimer);
    viewportTimer = requestAnimationFrame(() => {
      document.documentElement.style.height = `${window.visualViewport!.height}px`;
      if (termStore.views.size > 0) {
        termStore.scheduleAllVisibleResize();
      }
    });
  }

  onMounted(() => {
    window.addEventListener("resize", handleResize);
    if (window.visualViewport) {
      window.visualViewport.addEventListener("resize", handleVisualViewportResize);
    }
  });

  onUnmounted(() => {
    window.removeEventListener("resize", handleResize);
    if (window.visualViewport) {
      window.visualViewport.removeEventListener("resize", handleVisualViewportResize);
    }
  });
}
