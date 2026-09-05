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
 *
 * Kind awareness:
 *   kind "question"     → three rising tones, sticky OS notification, never
 *                         coalesced — the agent is blocked until it is answered
 */

let audioCtx: AudioContext | null = null;

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

    function tone(startOffset: number, freq: number, dur: number) {
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
 * Question ding: three rising tones (660 -> 880 -> 1100 Hz, ~0.5 s total).
 *
 * Deliberately a different SHAPE from the other two, not just a different
 * pitch — one tone is "something finished", two are "something urgent", three
 * rising ones are "someone is asking you a question". Recognisable without
 * looking at the screen, which is the whole point of the sound.
 */
export function playQuestionDing() {
  try {
    const ctx = getAudioContext();
    if (ctx.state === "suspended") ctx.resume();
    const now = ctx.currentTime;

    function tone(startOffset: number, freq: number, dur: number) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.setValueAtTime(freq, now + startOffset);
      gain.gain.setValueAtTime(0.28, now + startOffset);
      gain.gain.exponentialRampToValueAtTime(0.001, now + startOffset + dur);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now + startOffset);
      osc.stop(now + startOffset + dur);
    }

    tone(0, 660, 0.16);
    tone(0.17, 880, 0.16);
    tone(0.34, 1100, 0.2);
  } catch {
    // Audio not available — silently ignore.
  }
}

/**
 * Show an OS-level notification.
 * Electron → IPC to main process (Electron.Notification).
 * Browser  → Web Notification API (remote mode).
 *
 * `dedupeKey` (the alert's session key) lets the main process collapse
 * identical popups fired by multiple windows of the same profile into one
 * OS notification per app instance. In-app toasts stay per-window.
 */
export function showSystemNotification(
  title: string,
  body: string,
  options: { urgency?: string; dedupeKey?: string; kind?: string } = {},
) {
  // A question needs an answer before the agent moves, so its popup must not
  // auto-dismiss even at "normal" urgency (MCP elicitation, agent_needs_input).
  const urgent = options?.urgency === "urgent";
  const sticky = urgent || options?.kind === "question";

  // Electron mode
  if (window.strideterm?.showSystemNotification) {
    window.strideterm.showSystemNotification({
      title,
      body,
      urgency: urgent ? "urgent" : "normal",
      requireInteraction: sticky,
      dedupeKey: options?.dedupeKey || "",
    });
    return;
  }

  // Remote / browser fallback
  if ("Notification" in window) {
    const browserOpts: NotificationOptions = { body };
    if (sticky) browserOpts.requireInteraction = true;
    // `tag` makes the browser replace an identical pending notification
    // instead of stacking duplicates.
    if (options?.dedupeKey) browserOpts.tag = options.dedupeKey;
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
const lastDingAt = new Map<string, number>();
const COALESCE_WINDOW_MS = 5_000;

function shouldCoalesce(sessionKey: string): boolean {
  if (!sessionKey) return false;
  const last = lastDingAt.get(sessionKey) || 0;
  return Date.now() - last < COALESCE_WINDOW_MS;
}

function recordDing(sessionKey: string): void {
  if (sessionKey) lastDingAt.set(sessionKey, Date.now());
}

/**
 * Fire the right alert based on window focus and tier/urgency.
 *
 * @param title
 * @param body
 * @param meta
 */
export function fireNotificationAlert(
  title: string,
  body: string,
  meta: { tier?: number; urgency?: string; sessionKey?: string; dedupeKey?: string; kind?: string } = {},
) {
  const tier = meta?.tier || 1;
  const urgency = meta?.urgency === "urgent" ? "urgent" : "normal";
  const sessionKey = meta?.sessionKey || "";
  // What the OS-level popup is deduped on. Deliberately NOT the session key:
  // deduping by session merges two DIFFERENT questions in the same panel into
  // one popup, while the thing that actually needs merging is one alert
  // reaching several windows. Callers pass the alert's own id; the session key
  // remains the fallback for callers that have no alert identity.
  const dedupeKey = meta?.dedupeKey || sessionKey;
  const isQuestion = meta?.kind === "question";

  // T3 = heuristic. Too noisy to play sounds / pop system notifications for.
  // The notification still appears in the Notification Center.
  if (tier === 3) return;

  // Coalesce per-session. Urgent overrides coalescing — a permission prompt
  // fired right after an idle alert is important. A question does too: it
  // blocks the agent regardless of its urgency, so swallowing it because an
  // idle alert happened 4 s earlier is exactly the wrong trade.
  const coalesced = urgency !== "urgent" && !isQuestion && shouldCoalesce(sessionKey);

  if (document.hasFocus()) {
    if (!coalesced) {
      if (isQuestion) playQuestionDing();
      else if (urgency === "urgent") playUrgentDing();
      else playDing();
      recordDing(sessionKey);
    }
  } else {
    // System notifications don't auto-play the ding themselves on all OSes,
    // but they're less spammy — fire one regardless unless coalesced.
    if (!coalesced) {
      showSystemNotification(title, body, { urgency, dedupeKey, kind: meta?.kind });
      recordDing(sessionKey);
    }
  }
}
