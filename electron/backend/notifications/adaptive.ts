/**
 * Adaptive T3 suppression.  Plan § 3.2.6.
 *
 * Tracks how often the user has dismissed (or ignored) silence-based alerts
 * for a given session without interacting.  After a few dismissals we:
 *   - double the silence threshold (to reduce noise)
 *   - after a few more, disable T3 entirely until the user interacts
 *
 * Reset when the user actually interacts with the session (types into it,
 * or the session becomes visible + window focused — both update
 * `lastUserInteractionAt` in the session signal).
 *
 * State is kept in memory only.  Session ids are ephemeral anyway
 * (they die with the PTY), and persistence would add persistence cost
 * without meaningful benefit.
 */

const SOFT_LIMIT = 3; // double threshold
const HARD_LIMIT = 6; // disable T3 entirely

interface AdaptiveEntry {
  dismissCount: number;
  lastInteractionAt: number;
}

// sessionId → { dismissCount, lastInteractionAt }
const state = new Map<string, AdaptiveEntry>();

/**
 * Record that an alert was dismissed/ignored without user interaction.
 * Should be called from the notification-center "dismiss" path or when
 * an alert disappears without having been clicked.
 */
export function recordDismissed(sessionId: string): void {
  if (!sessionId) return;
  const entry = state.get(sessionId) || { dismissCount: 0, lastInteractionAt: 0 };
  entry.dismissCount += 1;
  state.set(sessionId, entry);
}

/**
 * User actually interacted with this session — reset the counter so the
 * session goes back to normal sensitivity.
 */
export function recordInteraction(sessionId: string): void {
  if (!sessionId) return;
  const entry = state.get(sessionId);
  if (!entry) return;
  entry.dismissCount = 0;
  entry.lastInteractionAt = Date.now();
}

/**
 * Called when a session is deleted (PTY exits) — free the slot.
 */
export function forget(sessionId: string): void {
  if (!sessionId) return;
  state.delete(sessionId);
}

/**
 * Returns a multiplier for the silence threshold (≥ 1.0).  Apply like:
 *   effectiveQuietMs = baseQuietMs * adaptiveMultiplier(sessionId)
 */
export function adaptiveMultiplier(sessionId: string): number {
  const entry = state.get(sessionId);
  if (!entry) return 1;
  if (entry.dismissCount >= SOFT_LIMIT) return 2;
  return 1;
}

/**
 * Returns true if T3 is fully disabled for this session because the user
 * keeps ignoring the alerts.
 */
export function isT3Disabled(sessionId: string): boolean {
  const entry = state.get(sessionId);
  if (!entry) return false;
  return entry.dismissCount >= HARD_LIMIT;
}

export interface AdaptiveSnapshot {
  sessionId: string;
  dismissCount: number;
  lastInteractionAt: number;
}

/**
 * Exposed for tests / diagnostics.
 */
export function snapshot(): AdaptiveSnapshot[] {
  return Array.from(state.entries()).map(([sid, entry]) => ({ sessionId: sid, ...entry }));
}

export function _resetForTests(): void {
  state.clear();
}
