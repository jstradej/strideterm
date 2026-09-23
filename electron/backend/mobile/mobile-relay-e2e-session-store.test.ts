import { describe, expect, test } from "vitest";
import { createRelayE2eSessionStore } from "./mobile-relay-e2e-session-store.js";
import type { RelayE2eKeys } from "./mobile-crypto.js";

function fakeKeys(seed: number): RelayE2eKeys {
  return {
    desktopToPhone: Buffer.alloc(32, seed),
    phoneToDesktop: Buffer.alloc(32, seed + 1),
  };
}

describe("mobile-relay-e2e-session-store", () => {
  test("put/get round-trips the exact keys for a deviceId", () => {
    const store = createRelayE2eSessionStore();
    const keys = fakeKeys(1);
    store.put("dev-1", keys, 60_000);
    expect(store.get("dev-1")).toEqual(keys);
  });

  test("get returns null for an unknown deviceId", () => {
    const store = createRelayE2eSessionStore();
    expect(store.get("no-such-device")).toBeNull();
  });

  test("two devices keep independent keys", () => {
    const store = createRelayE2eSessionStore();
    store.put("dev-a", fakeKeys(1), 60_000);
    store.put("dev-b", fakeKeys(9), 60_000);
    expect(store.get("dev-a")).toEqual(fakeKeys(1));
    expect(store.get("dev-b")).toEqual(fakeKeys(9));
  });

  test("a fresh put for the same device overwrites the prior entry", () => {
    const store = createRelayE2eSessionStore();
    store.put("dev-1", fakeKeys(1), 60_000);
    store.put("dev-1", fakeKeys(5), 60_000);
    expect(store.get("dev-1")).toEqual(fakeKeys(5));
  });

  test("keys past their TTL are refused and evicted, never resurrected", () => {
    let clock = 0;
    const store = createRelayE2eSessionStore(() => clock);
    store.put("dev-1", fakeKeys(1), 1_000);
    clock = 1_001;
    expect(store.get("dev-1")).toBeNull();
    clock = 500;
    expect(store.get("dev-1")).toBeNull();
  });

  test("put prunes expired entries as a side effect", () => {
    let clock = 0;
    const store = createRelayE2eSessionStore(() => clock);
    store.put("stale-device", fakeKeys(1), 1_000);
    clock = 2_000;
    store.put("fresh-device", fakeKeys(2), 60_000); // triggers pruneExpired()
    expect(store.get("stale-device")).toBeNull();
    expect(store.get("fresh-device")).toEqual(fakeKeys(2));
  });
});
