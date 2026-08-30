/**
 * Where a notification event came from, so an acknowledgement from the phone can reach it.
 *
 * WHY THIS EXISTS. `notification.acknowledge` carries only `{eventId}` — the sealed command payload
 * is a mirrored, `additionalProperties: false` schema, so the phone cannot tell the desktop WHICH
 * alert it is acknowledging without a protocol change on both sides. But the desktop minted that
 * eventId itself (runtime.ts's raiseAlert wrapper) and knew the workspace and panel at the time, so
 * it can simply remember. That keeps the fix on this side of the wire: no schema change, no
 * drift-check entry, and older phones benefit without an app update.
 *
 * Only alert-backed events get an entry. The PR-review and pipeline forwards emit an
 * ExternalNotificationEvent too, but they never raised an attention alert, so there is nothing for
 * an acknowledgement to clear and `record` is simply never called for them.
 *
 * BOUNDED ON PURPOSE. An entry is dead weight once its command can no longer arrive, so the map is
 * capped two ways: by age (`ttlMs`, matching the 24h maximum lifetime COMMAND_POLICY gives
 * `notification.acknowledge` — a shorter window here would silently drop acks the policy still
 * accepts) and by count, evicting oldest-first. A desktop that raises thousands of alerts a day
 * therefore keeps a fixed, small amount of state rather than a leak that grows with uptime.
 */
import { MAX_COMMAND_TTL_MS } from "./mobile-schemas.js";

/** The alert an event was raised from — enough to name it to `clearAlertForSession`. */
export interface MobileNotificationOrigin {
  /** Profile the workspace belonged to when the event was raised. Re-checked at ack time. */
  profileId: string;
  workspaceId: string;
  panelId: string;
  /** Canonical `workspace:panel` session id, when the alert had one. */
  sessionId: string;
}

export interface MobileNotificationOriginStore {
  record(eventId: string, origin: MobileNotificationOrigin): void;
  get(eventId: string): MobileNotificationOrigin | null;
  /** Test/diagnostic view of how much is being held. */
  size(): number;
}

/** Plenty for a day of alerts on a busy desktop, small enough to be uninteresting in memory. */
const DEFAULT_MAX_ENTRIES = 500;

export function createMobileNotificationOriginStore(
  options: { now?: () => number; maxEntries?: number; ttlMs?: number } = {},
): MobileNotificationOriginStore {
  const now = options.now || Date.now;
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const ttlMs = options.ttlMs ?? MAX_COMMAND_TTL_MS;
  // Insertion-ordered, which is what makes "evict oldest" a plain iteration step.
  const entries = new Map<string, { origin: MobileNotificationOrigin; at: number }>();

  function dropExpired(at: number): void {
    for (const [eventId, entry] of entries) {
      // Insertion order is time order, so the first live entry ends the sweep.
      if (at - entry.at < ttlMs) break;
      entries.delete(eventId);
    }
  }

  return {
    record(eventId, origin) {
      if (!eventId) return;
      const at = now();
      dropExpired(at);
      // Re-insert at the end so the eviction order stays the insertion order.
      entries.delete(eventId);
      entries.set(eventId, { origin, at });
      while (entries.size > maxEntries) {
        const oldest = entries.keys().next();
        if (oldest.done) break;
        entries.delete(oldest.value);
      }
    },
    get(eventId) {
      if (!eventId) return null;
      const at = now();
      dropExpired(at);
      const entry = entries.get(eventId);
      if (!entry) return null;
      return at - entry.at < ttlMs ? entry.origin : null;
    },
    size() {
      dropExpired(now());
      return entries.size;
    },
  };
}
