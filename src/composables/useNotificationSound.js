/**
 * Audio and system notification alerts.
 *
 * Strategy A — focused vs. unfocused:
 *   Focused   → subtle internal ding (Web Audio API, no files needed)
 *   Unfocused → OS-level system notification (carries its own sound)
 *
 * Tier / urgency awareness (Phase 0 § 3.2.i):
 *   tier 3 (heuristic)  → no ding, no system notification (too unreliable)
 *   urgency "urgent"    → two-tone ding, OS notification uses requireInteraction
 *   urgency "normal"    → single tone ding
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
 * Urgent two-tone ding: higher pitch, two short tones to stand out even in
 * a crowded soundscape. ~400 ms total.
 */
export function playUrgentDing() {
  try {
    const ctx = getAudioContext();
    if (ctx.state === "suspended") ctx.resume();
    const now = ctx.currentTime;

    function tone(startOffset, freq, dur) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.setValueAtTime(freq, now + startOffset);
      gain.gain.setValueAtTime(0.3, now + startOffset);
      gain.gain.exponentialRampToValueAtTime(0.001, now + startOffset + dur);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now + startOffset);
      osc.stop(now + startOffset + dur);
    }

    tone(0, 880, 0.18);
    tone(0.2, 1100, 0.22);
  } catch {
    // Audio not available — silently ignore.
  }
}

/**
 * Show an OS-level notification.
 * Electron → IPC to main process (Electron.Notification).
 * Browser  → Web Notification API (remote mode).
 */
export function showSystemNotification(title, body, options = {}) {
  const urgent = options?.urgency === "urgent";

  // Electron mode
  if (window.strideterm?.showSystemNotification) {
    window.strideterm.showSystemNotification({
      title,
      body,
      urgency: urgent ? "urgent" : "normal",
      requireInteraction: urgent,
    });
    return;
  }

  // Remote / browser fallback
  if ("Notification" in window) {
    const browserOpts = { body };
    if (urgent) browserOpts.requireInteraction = true;
    if (Notification.permission === "granted") {
      new Notification(title, browserOpts);
    } else if (Notification.permission !== "denied") {
      Notification.requestPermission().then((perm) => {
        if (perm === "granted") new Notification(title, browserOpts);
      });
    }
  }
}

// Plan § 3.3.6: coalesce — don't play more than one ding per session per 5s.
// Map: sessionKey → timestamp of last ding.
const lastDingAt = new Map();
const COALESCE_WINDOW_MS = 5_000;

function shouldCoalesce(sessionKey) {
  if (!sessionKey) return false;
  const last = lastDingAt.get(sessionKey) || 0;
  return Date.now() - last < COALESCE_WINDOW_MS;
}

function recordDing(sessionKey) {
  if (sessionKey) lastDingAt.set(sessionKey, Date.now());
}

/**
 * Fire the right alert based on window focus and tier/urgency.
 *
 * @param {string} title
 * @param {string} body
 * @param {Object} [meta]
 * @param {1|2|3} [meta.tier=1]
 * @param {"normal"|"urgent"} [meta.urgency="normal"]
 * @param {string} [meta.sessionKey]  — used for per-session sound coalescing
 */
export function fireNotificationAlert(title, body, meta = {}) {
  const tier = meta?.tier || 1;
  const urgency = meta?.urgency === "urgent" ? "urgent" : "normal";
  const sessionKey = meta?.sessionKey || "";

  // T3 = heuristic. Too noisy to play sounds / pop system notifications for.
  // The notification still appears in the Notification Center.
  if (tier === 3) return;

  // Coalesce per-session. Urgent overrides coalescing — a permission prompt
  // fired right after an idle alert is important.
  const coalesced = urgency !== "urgent" && shouldCoalesce(sessionKey);

  if (document.hasFocus()) {
    if (!coalesced) {
      if (urgency === "urgent") playUrgentDing();
      else playDing();
      recordDing(sessionKey);
    }
  } else {
    // System notifications don't auto-play the ding themselves on all OSes,
    // but they're less spammy — fire one regardless unless coalesced.
    if (!coalesced) {
      showSystemNotification(title, body, { urgency });
      recordDing(sessionKey);
    }
  }
}
