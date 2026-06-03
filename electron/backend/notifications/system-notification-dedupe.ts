/**
 * App-level dedupe for OS system notifications.
 *
 * With multiple windows showing the same profile, every unfocused window's
 * renderer fires `notification:show-system` for the same alert — without
 * dedupe the user gets N identical OS popups for one event. In-app toasts
 * stay per-window (each window shows its own); only the OS-level popup is
 * deduped per app instance, keyed by the alert's session key inside a short
 * time window.
 */

const DEDUPE_WINDOW_MS = 5_000;
const MAX_ENTRIES = 500;

const recentByKey = new Map<string, number>();

/**
 * Returns true when a system notification for `dedupeKey` should be shown,
 * recording the timestamp; false when an identical one was shown within the
 * dedupe window. Empty keys are never deduped (callers without a session
 * context keep the old behavior).
 */
export function shouldShowSystemNotification(dedupeKey: string, now = Date.now()): boolean {
  if (!dedupeKey) return true;
  const last = recentByKey.get(dedupeKey);
  if (last !== undefined && now - last < DEDUPE_WINDOW_MS) return false;
  recentByKey.set(dedupeKey, now);
  // Bounded: evict oldest entries so a long-running app doesn't grow forever.
  if (recentByKey.size > MAX_ENTRIES) {
    const oldest = [...recentByKey.entries()].sort((a, b) => a[1] - b[1]).slice(0, recentByKey.size - MAX_ENTRIES);
    for (const [key] of oldest) recentByKey.delete(key);
  }
  return true;
}

/** Test helper: reset the dedupe window. */
export function _resetSystemNotificationDedupeForTest(): void {
  recentByKey.clear();
}
