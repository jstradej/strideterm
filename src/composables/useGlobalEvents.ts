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

  // PTY size is shared across all connected clients (desktop + remote). When
  // another client resized it, our local DOM didn't change, so ResizeObserver
  // doesn't fire — the active client must reclaim its size when the user
  // returns to it. Otherwise the desktop stays "shrunk" until the user wiggles
  // the window.
  function reclaimTerminalSize() {
    if (termStore.views.size > 0) {
      termStore.scheduleAllVisibleResize();
    }
  }

  function handleVisibility() {
    if (document.visibilityState === "visible") {
      reclaimTerminalSize();
    }
  }

  onMounted(() => {
    window.addEventListener("resize", handleResize);
    window.addEventListener("focus", reclaimTerminalSize);
    document.addEventListener("visibilitychange", handleVisibility);
    if (window.visualViewport) {
      window.visualViewport.addEventListener("resize", handleVisualViewportResize);
    }
  });

  onUnmounted(() => {
    window.removeEventListener("resize", handleResize);
    window.removeEventListener("focus", reclaimTerminalSize);
    document.removeEventListener("visibilitychange", handleVisibility);
    if (window.visualViewport) {
      window.visualViewport.removeEventListener("resize", handleVisualViewportResize);
    }
  });
}
