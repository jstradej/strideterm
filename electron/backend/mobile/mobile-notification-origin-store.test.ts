/**
 * The bounded recording that lets a `{eventId}`-only acknowledgement find its alert.
 *
 * The behaviours worth pinning are the two bounds (age and count) and the fact that eviction order
 * is insertion order — get those wrong and the store either leaks for the life of the process or
 * silently drops acks the command policy still accepts.
 */
import { describe, test, expect } from "vitest";
import { createMobileNotificationOriginStore } from "./mobile-notification-origin-store.js";
import { MAX_COMMAND_TTL_MS } from "./mobile-schemas.js";

function origin(workspaceId: string) {
  return { profileId: "default", workspaceId, panelId: "panel", sessionId: `${workspaceId}:panel` };
}

describe("mobile notification origin store", () => {
  test("hands back what was recorded", () => {
    const store = createMobileNotificationOriginStore();
    store.record("evt-1", origin("ws-1"));
    expect(store.get("evt-1")).toEqual(origin("ws-1"));
    expect(store.get("evt-2")).toBeNull();
  });

  test("forgets an entry once its acknowledgement could no longer arrive", () => {
    // The window is the 24h maximum lifetime COMMAND_POLICY gives notification.acknowledge — a
    // shorter one here would drop acks the policy still accepts.
    let clock = 1_000_000;
    const store = createMobileNotificationOriginStore({ now: () => clock });
    store.record("evt-1", origin("ws-1"));

    clock += MAX_COMMAND_TTL_MS - 1;
    expect(store.get("evt-1")).toEqual(origin("ws-1"));

    clock += 2;
    expect(store.get("evt-1")).toBeNull();
    expect(store.size()).toBe(0);
  });

  test("evicts oldest first when full, so a busy desktop holds a fixed amount of state", () => {
    const store = createMobileNotificationOriginStore({ maxEntries: 3 });
    for (const n of [1, 2, 3, 4]) store.record(`evt-${n}`, origin(`ws-${n}`));

    expect(store.size()).toBe(3);
    expect(store.get("evt-1")).toBeNull();
    expect(store.get("evt-4")).toEqual(origin("ws-4"));
  });

  test("re-recording the same event id refreshes it rather than growing the map", () => {
    // Same logical event sent twice (a resend, a second phone) must not occupy two slots, and the
    // later recording is the one that reflects where the alert is now.
    const store = createMobileNotificationOriginStore({ maxEntries: 2 });
    store.record("evt-1", origin("ws-1"));
    store.record("evt-2", origin("ws-2"));
    store.record("evt-1", origin("ws-1-moved"));

    expect(store.size()).toBe(2);
    expect(store.get("evt-1")).toEqual(origin("ws-1-moved"));

    // evt-1 was re-inserted, so evt-2 is now the oldest and the next arrival evicts IT.
    store.record("evt-3", origin("ws-3"));
    expect(store.get("evt-2")).toBeNull();
    expect(store.get("evt-1")).toEqual(origin("ws-1-moved"));
  });

  test("an empty event id is neither recorded nor looked up", () => {
    const store = createMobileNotificationOriginStore();
    store.record("", origin("ws-1"));
    expect(store.size()).toBe(0);
    expect(store.get("")).toBeNull();
  });
});
