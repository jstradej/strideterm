/// <reference types="node" />
/**
 * In-memory store for relay end-to-end encryption key-exchange offers (plan 2026-09-23, decision 1).
 *
 * `remote.endpoint.request` generates a fresh X25519 ephemeral pair on every `managedRelay` answer
 * and hands the phone the public half plus a `keyId` in the `e2e` block. The private half has to
 * live SOMEWHERE between that answer and the later `remote.webSession.issue` call that names the
 * same `keyId` — this store is that somewhere, deliberately its own module for the same reason
 * `mobile-web-session-ticket-store.ts` is: a single shared instance is constructed once in
 * runtime.ts and handed only to the command dispatcher, which is both the producer and the
 * consumer here (no cross-module cycle risk, just keeping the dispatcher itself from growing a
 * third responsibility).
 *
 * INVARIANT (CLAUDE.md "relay session key never leaves the desktop and the phone"): this store is
 * desktop-memory-only. Never Firebase, never the persisted state JSON, never logged. A restart
 * invalidates every outstanding offer, same as the web-session ticket store — by design.
 *
 * NOT single-use, unlike a ticket. A `remote.endpoint.request` answer is valid for its whole TTL,
 * and the phone may legitimately call `remote.webSession.issue` more than once against the SAME
 * answer (e.g. the WebView reloading) — each such call mints a fresh ticket and derives a fresh
 * pair of directional session keys, but from the SAME desktop ephemeral pair and the same `keyId`,
 * since the plan pins forward secrecy to the ephemeral pair being fresh per `remote.endpoint.request`
 * ANSWER, not per `remote.webSession.issue` CALL. An offer is simply pruned once its own TTL
 * passes, same lazy-eviction-on-lookup approach as the ticket store (this store is smaller still —
 * at most one live offer per connected phone).
 */
import { randomUUID, type KeyObject } from "node:crypto";
import { generateX25519KeyPair, exportRawPublicKey } from "./mobile-crypto.js";

export interface RelayE2eOffer {
  keyId: string;
  desktopEphemeralPub: string;
}

export interface RelayE2eOfferRecord {
  ephemeralPrivateKey: KeyObject;
  desktopEphemeralPub: string;
}

export interface RelayE2eOfferStore {
  /** Generates a fresh ephemeral pair and keyId, valid for `ttlMs` from now. */
  createOffer(ttlMs: number): RelayE2eOffer;
  /** The offer's key material, or null if `keyId` is unknown or has expired. */
  getOffer(keyId: string): RelayE2eOfferRecord | null;
}

export function createRelayE2eOfferStore(now: () => number = () => Date.now()): RelayE2eOfferStore {
  const offers = new Map<string, RelayE2eOfferRecord & { expiresAt: number }>();

  function pruneExpired(): void {
    const nowMs = now();
    for (const [keyId, offer] of offers) {
      if (offer.expiresAt <= nowMs) offers.delete(keyId);
    }
  }

  return {
    createOffer(ttlMs) {
      pruneExpired();
      const pair = generateX25519KeyPair();
      const keyId = randomUUID();
      const desktopEphemeralPub = exportRawPublicKey(pair.publicKey).toString("base64");
      offers.set(keyId, { ephemeralPrivateKey: pair.privateKey, desktopEphemeralPub, expiresAt: now() + ttlMs });
      return { keyId, desktopEphemeralPub };
    },

    getOffer(keyId) {
      const offer = offers.get(keyId);
      if (!offer) return null;
      if (offer.expiresAt <= now()) {
        offers.delete(keyId);
        return null;
      }
      return { ephemeralPrivateKey: offer.ephemeralPrivateKey, desktopEphemeralPub: offer.desktopEphemeralPub };
    },
  };
}
