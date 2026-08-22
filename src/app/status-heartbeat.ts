/**
 * Shared status heartbeat — one renderer-wide scheduler for every "this is
 * still alive" indicator (running task dots, unread bell, pending checks,
 * active pipeline step, live panels).
 *
 * Why this exists instead of CSS animations: an `animation: … infinite` rule
 * keeps the renderer in a continuous frame loop for as long as the element is
 * on screen. Moving such an animation onto a compositor-friendly property
 * (`opacity` / `transform`) removes the main-thread paint, but it does *not*
 * make the animation free — the compositor still produces ~60 frames a second,
 * which is the steady-state CPU floor an idle window was paying for.
 *
 * This module replaces all of them with a single timer that starts one short,
 * finite CSS pulse on every registered element, then removes its trigger class.
 * The renderer sleeps for most of each cycle instead of interpolating forever.
 *
 * Rules the rest of the app relies on:
 *  - exactly one timer no matter how many targets are registered;
 *  - all targets change in the same `requestAnimationFrame`, so they pulse in
 *    phase and read as one heartbeat rather than N independent blinks;
 *  - no timer at all while the registry is empty or the window is hidden;
 *  - no Pinia mutation and no DOM querying on a tick — the registry holds the
 *    elements directly.
 *
 * The presentation lives in `src/styles/base.css` (`.status-heartbeat--on`).
 * Its animation is finite and uses only compositor-friendly properties.
 */

/** Time between two heartbeats. */
export const HEARTBEAT_PERIOD_MS = 1_200;

/** How long `.status-heartbeat--on` stays applied within one period. */
export const HEARTBEAT_ON_MS = 1_050;

/** Class the scheduler toggles on every registered target. */
export const HEARTBEAT_ON_CLASS = "status-heartbeat--on";

const targets = new Set<HTMLElement>();

let cycleTimer: ReturnType<typeof setInterval> | null = null;
let offTimer: ReturnType<typeof setTimeout> | null = null;
let frame = 0;
/** Set by useGlobalEvents when the window is minimized/hidden. */
let hostPaused = false;

/**
 * Electron pins `document.visibilityState` to "visible" while
 * `backgroundThrottling` is disabled, so the document alone cannot tell us a
 * desktop window is minimized — `useGlobalEvents` pushes that in via
 * {@link pauseHeartbeat}. Both inputs are checked: whichever says hidden wins.
 */
function isHidden(): boolean {
  if (hostPaused) return true;
  if (typeof document === "undefined") return false;
  if (document.visibilityState === "hidden") return true;
  return document.documentElement.classList.contains("app-hidden");
}

function clearAllTargets(): void {
  for (const el of targets) {
    el.classList.remove(HEARTBEAT_ON_CLASS);
  }
}

function stopTimer(): void {
  if (cycleTimer !== null) {
    clearInterval(cycleTimer);
    cycleTimer = null;
  }
  if (offTimer !== null) {
    clearTimeout(offTimer);
    offTimer = null;
  }
  if (frame !== 0) {
    cancelAnimationFrame(frame);
    frame = 0;
  }
}

function beat(): void {
  // The window may have gone away between two ticks (the desktop bridge fires
  // asynchronously); stop rather than keep pulsing at nobody.
  if (isHidden()) {
    stopTimer();
    clearAllTargets();
    return;
  }
  frame = requestAnimationFrame(() => {
    frame = 0;
    for (const el of targets) {
      el.classList.add(HEARTBEAT_ON_CLASS);
    }
    offTimer = setTimeout(() => {
      offTimer = null;
      frame = requestAnimationFrame(() => {
        frame = 0;
        clearAllTargets();
      });
    }, HEARTBEAT_ON_MS);
  });
}

function startTimer(): void {
  if (cycleTimer !== null || targets.size === 0 || isHidden()) return;
  cycleTimer = setInterval(beat, HEARTBEAT_PERIOD_MS);
}

/**
 * Register `el` as a heartbeat target. Returns a disposer that removes it
 * again — call it when the indicator stops being active or its component
 * unmounts. The disposer is idempotent and always leaves the element without
 * the pulse class, even when it is torn down mid-"on" phase.
 */
export function registerHeartbeatTarget(el: HTMLElement): () => void {
  targets.add(el);
  startTimer();

  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    targets.delete(el);
    el.classList.remove(HEARTBEAT_ON_CLASS);
    if (targets.size === 0) stopTimer();
  };
}

/** Stop pulsing immediately and clear the class from every target. */
export function pauseHeartbeat(): void {
  hostPaused = true;
  stopTimer();
  clearAllTargets();
}

/** Resume pulsing — a no-op while the registry is empty. */
export function resumeHeartbeat(): void {
  hostPaused = false;
  startTimer();
}

/** Test-only: number of currently registered targets. */
export function heartbeatTargetCount(): number {
  return targets.size;
}

/** Test-only: drop all state so each test starts from a clean singleton. */
export function resetHeartbeatForTests(): void {
  stopTimer();
  clearAllTargets();
  targets.clear();
  hostPaused = false;
}
