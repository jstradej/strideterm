/**
 * Audio and system notification alerts.
 *
 * Strategy A — focused vs. unfocused:
 *   Focused   → subtle internal ding (Web Audio API, no files needed)
 *   Unfocused → OS-level system notification (carries its own sound)
 */

let audioCtx = null;

function getAudioContext() {
  if (!audioCtx) audioCtx = new AudioContext();
  return audioCtx;
}

/**
 * Synthesize a short, subtle ding — 660→440 Hz sine sweep, 200 ms decay.
 */
export function playDing() {
  try {
    const ctx = getAudioContext();
    if (ctx.state === "suspended") ctx.resume();

    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = "sine";
    osc.frequency.setValueAtTime(660, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(440, ctx.currentTime + 0.2);

    gain.gain.setValueAtTime(0.25, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.2);

    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + 0.2);
  } catch {
    // Audio not available — silently ignore.
  }
}

/**
 * Show an OS-level notification.
 * Electron → IPC to main process (Electron.Notification).
 * Browser  → Web Notification API (remote mode).
 */
export function showSystemNotification(title, body) {
  // Electron mode
  if (window.strideterm?.showSystemNotification) {
    window.strideterm.showSystemNotification({ title, body });
    return;
  }

  // Remote / browser fallback
  if ("Notification" in window) {
    if (Notification.permission === "granted") {
      new Notification(title, { body });
    } else if (Notification.permission !== "denied") {
      Notification.requestPermission().then((perm) => {
        if (perm === "granted") new Notification(title, { body });
      });
    }
  }
}

/**
 * Fire the right alert based on window focus.
 */
export function fireNotificationAlert(title, body) {
  if (document.hasFocus()) {
    playDing();
  } else {
    showSystemNotification(title, body);
  }
}
