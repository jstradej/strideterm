import { describe, expect, test } from "vitest";
import { createRelayE2eOfferStore } from "./mobile-relay-e2e-offer-store.js";

describe("mobile-relay-e2e-offer-store", () => {
  test("createOffer returns a fresh keyId and a 32-byte raw public key on every call", () => {
    const store = createRelayE2eOfferStore();
    const first = store.createOffer(60_000);
    const second = store.createOffer(60_000);
    expect(first.keyId).not.toBe(second.keyId);
    expect(first.desktopEphemeralPub).not.toBe(second.desktopEphemeralPub);
    expect(Buffer.from(first.desktopEphemeralPub, "base64")).toHaveLength(32);
  });

  test("getOffer finds a live offer and returns its private key plus the same public key", () => {
    const store = createRelayE2eOfferStore();
    const offer = store.createOffer(60_000);
    const found = store.getOffer(offer.keyId);
    expect(found).not.toBeNull();
    expect(found?.desktopEphemeralPub).toBe(offer.desktopEphemeralPub);
  });

  test("getOffer returns null for an unknown keyId", () => {
    const store = createRelayE2eOfferStore();
    expect(store.getOffer("does-not-exist")).toBeNull();
  });

  test("an offer past its TTL is refused and evicted, never resurrected", () => {
    let clock = 0;
    const store = createRelayE2eOfferStore(() => clock);
    const offer = store.createOffer(1_000);
    clock = 1_001;
    expect(store.getOffer(offer.keyId)).toBeNull();
    // Turning the clock back must not resurrect an evicted offer.
    clock = 500;
    expect(store.getOffer(offer.keyId)).toBeNull();
  });

  test("createOffer prunes expired offers as a side effect", () => {
    let clock = 0;
    const store = createRelayE2eOfferStore(() => clock);
    const stale = store.createOffer(1_000);
    clock = 2_000;
    store.createOffer(60_000); // triggers pruneExpired()
    expect(store.getOffer(stale.keyId)).toBeNull();
  });

  test("an offer is reusable — not consumed by a single getOffer call", () => {
    const store = createRelayE2eOfferStore();
    const offer = store.createOffer(60_000);
    expect(store.getOffer(offer.keyId)).not.toBeNull();
    expect(store.getOffer(offer.keyId)).not.toBeNull();
  });
});
