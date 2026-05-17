import { onMounted, onUnmounted, watch } from "vue";
import { useTerminalStore } from "../stores/terminal.js";
import { isMobileViewport } from "./useIsNarrow.js";

export function useGlobalEvents() {
  const termStore = useTerminalStore();

  let viewportTimer = 0;
  const deferredFitTimers: number[] = [];

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

  // When isMobileViewport flips (window resize crossing 768px, or short
  // landscape phones crossing 500px height), Vue re-renders PaneStage with
  // forceSoloLayout and the CSS media query reflows the grid. The standard
  // `resize` handler already fired its single RAF-scheduled fit by the time
  // that reflow finishes, so FitAddon often measures intermediate dimensions
  // and the resulting fit is wrong (or a no-op on a transiently 0×0 host).
  // Re-fit at 0/120/300 ms after the flip — mirrors scheduleDeferredTerminalFits
  // at the pane level but driven by the viewport-class transition instead of
  // a fresh mount. Solves the "switched to mobile view → terminal renders
  // blank, sometimes recovers after a tap-around" symptom.
  function scheduleMobileTransitionFits() {
    while (deferredFitTimers.length > 0) {
      window.clearTimeout(deferredFitTimers.pop()!);
    }
    const fire = () => {
      if (termStore.views.size > 0) {
        termStore.scheduleAllVisibleResize();
      }
    };
    window.requestAnimationFrame(fire);
    deferredFitTimers.push(window.setTimeout(fire, 120));
    deferredFitTimers.push(window.setTimeout(fire, 300));
  }

  // Orientation change on phones/tablets. Modern browsers also fire `resize`,
  // but some Android WebViews and PWAs only fire `orientationchange`. Rotating
  // usually stays within the mobile viewport class, so the isMobileViewport
  // watcher below may not fire; use the same deferred fits directly.
  function handleOrientationChange() {
    scheduleMobileTransitionFits();
  }

  let stopMobileWatch: (() => void) | null = null;

  onMounted(() => {
    window.addEventListener("resize", handleResize);
    window.addEventListener("focus", reclaimTerminalSize);
    window.addEventListener("orientationchange", handleOrientationChange);
    document.addEventListener("visibilitychange", handleVisibility);
    if (window.visualViewport) {
      window.visualViewport.addEventListener("resize", handleVisualViewportResize);
    }
    stopMobileWatch = watch(isMobileViewport, scheduleMobileTransitionFits);
  });

  onUnmounted(() => {
    window.removeEventListener("resize", handleResize);
    window.removeEventListener("focus", reclaimTerminalSize);
    window.removeEventListener("orientationchange", handleOrientationChange);
    document.removeEventListener("visibilitychange", handleVisibility);
    if (window.visualViewport) {
      window.visualViewport.removeEventListener("resize", handleVisualViewportResize);
    }
    stopMobileWatch?.();
    stopMobileWatch = null;
    while (deferredFitTimers.length > 0) {
      window.clearTimeout(deferredFitTimers.pop()!);
    }
  });
}
