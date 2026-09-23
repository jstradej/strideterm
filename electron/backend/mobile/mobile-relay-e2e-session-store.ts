/// <reference types="node" />
/**
 * In-memory store for DERIVED relay end-to-end encryption session keys (plan 2026-09-23, decision 1),
 * keyed by `deviceId`.
 *
 * `remote.webSession.issue` is where both directional AES-256-GCM keys are actually derived (once
 * the phone's `e2e` acceptance names a live offer from `mobile-relay-e2e-offer-store.ts`) — but the
 * keys are not needed again until the phone's `RelayE2eProxy` actually opens its WSS to
 * `/__relay/viewer` and traffic starts flowing, which happens after the HTTP round trip that issued
 * the ticket has already completed. This store is the handoff between the two moments.
 *
 * WHY DEVICE ID, NOT TICKET ID (the correlation this store originally shipped without — see git
 * history). `mobile-relay-connector.ts` receives an `e2e.open` for a brand-new, otherwise fully
 * opaque stream and has to decide which derived keys apply to it. The relay Worker already
 * verifies `RelayViewerGrantClaims.mobileDeviceId` when a viewer's WSS to `/__relay/viewer`
 * completes its handshake (mirroring how `#bridgeHttp` in today's plaintext path stamps the same
 * verified device id into the header list it builds for the connector) — so it is the relay,
 * never the viewer itself, that stamps the OPTIONAL `d` field on the `e2e.open` frame it forwards.
 * That is routing metadata the relay is already trusted with (plan decision 5); the ticket, by
 * contrast, is a desktop-issued credential the relay never sees at all, so keying this store by
 * ticket id would have left the connector with a correlation nothing could ever supply.
 *
 * A device has at most one live entry: a fresh `remote.webSession.issue` — and therefore a fresh
 * ephemeral pair and a fresh derived key — OVERWRITES whatever this store held for that device
 * before, never accumulates a second one beside it. A straggler frame from an abandoned prior
 * session that still names the old device id fails AEAD authentication against the new key and is
 * refused, not decrypted — the safe outcome for what should be a rare race (the app reconnecting
 * before its previous WebView cleanly closed).
 *
 * TTL is `RELAY_MOBILE_SESSION_ABSOLUTE_TTL_MS` (the relay's own mobile-session absolute lifetime),
 * not the ticket's much shorter TTL — the derived keys must outlive the ticket that produced them
 * for as long as the relay session itself may legitimately run.
 *
 * Runtime use: `mobile-relay-connector.ts` reads this store for each relayed stream, and the relay
 * Worker stamps the verified device id on `e2e.open` so the connector can select the matching keys.
 *
 * INVARIANT (CLAUDE.md "relay session key never leaves the desktop and the phone"): desktop-memory-
 * only, never Firebase, never persisted state, never logged.
 */
import type { RelayE2eKeys } from "./mobile-crypto.js";

export interface RelayE2eSessionStore {
  /** Records the keys derived for `deviceId`, valid for `ttlMs` from now. Overwrites any prior entry. */
  put(deviceId: string, keys: RelayE2eKeys, ttlMs: number): void;
  /** The keys derived for `deviceId`, or null if unknown or expired. */
  get(deviceId: string): RelayE2eKeys | null;
}

export function createRelayE2eSessionStore(now: () => number = () => Date.now()): RelayE2eSessionStore {
  const sessions = new Map<string, { keys: RelayE2eKeys; expiresAt: number }>();

  function pruneExpired(): void {
    const nowMs = now();
    for (const [deviceId, session] of sessions) {
      if (session.expiresAt <= nowMs) sessions.delete(deviceId);
    }
  }

  return {
    put(deviceId, keys, ttlMs) {
      pruneExpired();
      sessions.set(deviceId, { keys, expiresAt: now() + ttlMs });
    },
    get(deviceId) {
      const session = sessions.get(deviceId);
      if (!session) return null;
      if (session.expiresAt <= now()) {
        sessions.delete(deviceId);
        return null;
      }
      return session.keys;
    },
  };
}
