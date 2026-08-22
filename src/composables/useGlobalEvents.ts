import { onMounted, onUnmounted, watch } from "vue";
import { useTerminalStore } from "../stores/terminal.js";
import { isMobileViewport } from "./useIsNarrow.js";
import { pauseHeartbeat, resumeHeartbeat } from "../app/status-heartbeat.js";

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

  // Drives the `html.app-hidden` animation freeze in base.css and the shared
  // status heartbeat's pause. Desktop windows run with backgroundThrottling
  // disabled, so Chromium keeps a minimized renderer painting at 60 fps —
  // animations and timers otherwise cost real CPU for hours with nothing on
  // screen.
  //
  // Two independent inputs because neither covers both clients: Electron pins
  // document.visibilityState to "visible" when backgroundThrottling is off, so
  // desktop windows only learn about it from main's window:visibility push;
  // remote/mobile browsers have no such push and rely on visibilitychange.
  // Whichever says "hidden" wins.
  //
  // The heartbeat scheduler is told explicitly rather than left to sniff
  // document.visibilityState for exactly that reason: on the desktop the
  // document never reports hidden, so this push is the only signal it gets.
  let windowHidden = false;

  function syncHiddenClass() {
    const hidden = windowHidden || document.visibilityState === "hidden";
    document.documentElement.classList.toggle("app-hidden", hidden);
    if (hidden) pauseHeartbeat();
    else resumeHeartbeat();
  }

  function handleVisibility() {
    syncHiddenClass();
    if (document.visibilityState === "visible") {
      reclaimTerminalSize();
    }
  }

  function handleWindowVisibility(payload: { hidden: boolean }) {
    windowHidden = payload.hidden;
    syncHiddenClass();
    if (!payload.hidden) {
      // Restoring from minimized is a resize as far as the panes are concerned —
      // the same reclaim visibilitychange does for the remote client.
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
    // Desktop only — absent on the remote/mobile client, which uses
    // visibilitychange above. Fire-and-forget: main owns the window's lifetime,
    // so there is nothing to unsubscribe on unmount.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).strideterm?.onWindowVisibility?.(handleWindowVisibility);
    // Mount can happen while already hidden (remote client opened in a
    // background tab).
    syncHiddenClass();
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
    document.documentElement.classList.remove("app-hidden");
    // A torn-down app must not leave the scheduler parked — a remount would
    // register targets that never pulse.
    resumeHeartbeat();
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
