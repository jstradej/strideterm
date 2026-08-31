import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { setActivePinia, createPinia } from "pinia";
import { useNotificationStore } from "./notifications.js";

// Mock BroadcastChannel that routes between instances in the same JS context
// (the real one never delivers to the posting context) and records everything
// posted, so a test can assert that a removal broadcast exactly once — or not
// at all.
class MockBroadcastChannel {
  static instances: MockBroadcastChannel[] = [];
  static posted: unknown[] = [];
  name: string;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  constructor(name: string) {
    this.name = name;
    MockBroadcastChannel.instances.push(this);
  }
  postMessage(data: unknown): void {
    MockBroadcastChannel.posted.push(data);
    for (const inst of MockBroadcastChannel.instances) {
      if (inst !== this && inst.name === this.name) inst.onmessage?.({ data });
    }
  }
  close(): void {
    // no-op
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function seed(store: any, workspaceId: string, viewId: string, meta: Record<string, unknown> | null = null): void {
  store.add({ title: "t", body: "b", kind: "waiting", workspaceId, viewId, meta });
}

describe("notification store — target removal", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    window.localStorage.removeItem("strideterm-notifications-v2");
    MockBroadcastChannel.instances = [];
    MockBroadcastChannel.posted = [];
    vi.stubGlobal("BroadcastChannel", MockBroadcastChannel);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("removeByWorkspaceId drops only the target workspace's sessions", () => {
    const store = useNotificationStore();
    seed(store, "ws-1", "ws-1:a");
    seed(store, "ws-1", "ws-1:b");
    seed(store, "ws-2", "ws-2:a");

    store.removeByWorkspaceId("ws-1");

    expect(store.sessions.map((s) => s.workspaceId)).toEqual(["ws-2"]);
  });

  it("removeByWorkspaceId clears resolved history too", () => {
    const store = useNotificationStore();
    seed(store, "ws-1", "ws-1:a");
    store.setState(store.sessions[0].id, "resolved");

    store.removeByWorkspaceId("ws-1");

    expect(store.sessions).toHaveLength(0);
  });

  // The whole reason removeByViewId takes a workspaceId: a view id is only
  // unique within its workspace, so filtering on it alone would take an
  // unrelated workspace's thread down with it.
  it("removeByViewId does not touch the same viewId in another workspace", () => {
    const store = useNotificationStore();
    seed(store, "ws-1", "shared-view");
    seed(store, "ws-2", "shared-view");

    store.removeByViewId("ws-1", "shared-view");

    expect(store.sessions).toHaveLength(1);
    expect(store.sessions[0].workspaceId).toBe("ws-2");
  });

  it("removeByViewId leaves the workspace's other views alone", () => {
    const store = useNotificationStore();
    seed(store, "ws-1", "ws-1:a");
    seed(store, "ws-1", "ws-1:b");

    store.removeByViewId("ws-1", "ws-1:a");

    expect(store.sessions.map((s) => s.viewId)).toEqual(["ws-1:b"]);
  });

  it("ignores empty identifiers", () => {
    const store = useNotificationStore();
    seed(store, "ws-1", "ws-1:a");

    store.removeByWorkspaceId("");
    store.removeByViewId("", "ws-1:a");
    store.removeByViewId("ws-1", "");

    expect(store.sessions).toHaveLength(1);
    expect(MockBroadcastChannel.posted).toHaveLength(0);
  });

  it("a removal that changes something persists and broadcasts exactly once", () => {
    const store = useNotificationStore();
    seed(store, "ws-1", "ws-1:a");
    MockBroadcastChannel.posted = [];

    store.removeByWorkspaceId("ws-1");

    expect(MockBroadcastChannel.posted).toEqual([{ type: "remove-by-workspace", workspaceId: "ws-1" }]);
    expect(JSON.parse(window.localStorage.getItem("strideterm-notifications-v2") || "[]")).toEqual([]);
  });

  // Duplicate delivery is expected: the same removal arrives as the runtime's
  // authoritative event AND as a sibling window's BroadcastChannel echo.
  it("a removal that changes nothing neither persists nor broadcasts", () => {
    const store = useNotificationStore();
    seed(store, "ws-1", "ws-1:a");
    store.removeByWorkspaceId("ws-1");
    MockBroadcastChannel.posted = [];
    const storedBefore = window.localStorage.getItem("strideterm-notifications-v2");
    const setItem = vi.spyOn(window.localStorage, "setItem");

    store.removeByWorkspaceId("ws-1");
    store.removeByViewId("ws-2", "ws-2:a");

    expect(MockBroadcastChannel.posted).toHaveLength(0);
    expect(setItem).not.toHaveBeenCalled();
    expect(window.localStorage.getItem("strideterm-notifications-v2")).toBe(storedBefore);
    setItem.mockRestore();
  });

  it("incoming remove-by-workspace applies without echoing a broadcast", () => {
    const store = useNotificationStore();
    seed(store, "ws-1", "ws-1:a");
    seed(store, "ws-2", "ws-2:a");
    MockBroadcastChannel.posted = [];

    store._applySyncMessageForTest({ type: "remove-by-workspace", workspaceId: "ws-1" });

    expect(store.sessions.map((s) => s.workspaceId)).toEqual(["ws-2"]);
    expect(MockBroadcastChannel.posted).toHaveLength(0);
  });

  it("incoming remove-by-view is keyed on the workspace too, and does not echo", () => {
    const store = useNotificationStore();
    seed(store, "ws-1", "shared-view");
    seed(store, "ws-2", "shared-view");
    MockBroadcastChannel.posted = [];

    store._applySyncMessageForTest({ type: "remove-by-view", workspaceId: "ws-1", viewId: "shared-view" });

    expect(store.sessions.map((s) => s.workspaceId)).toEqual(["ws-2"]);
    expect(MockBroadcastChannel.posted).toHaveLength(0);
  });

  it("a sibling window applies the removal through the real channel", () => {
    const piniaA = createPinia();
    const piniaB = createPinia();
    setActivePinia(piniaA);
    const storeA = useNotificationStore(piniaA);
    setActivePinia(piniaB);
    const storeB = useNotificationStore(piniaB);

    seed(storeA, "ws-1", "ws-1:a");
    seed(storeB, "ws-1", "ws-1:a");
    expect(storeB.sessions).toHaveLength(1);

    storeA.removeByWorkspaceId("ws-1");

    expect(storeB.sessions).toHaveLength(0);
  });
});

describe("notification store — reconcileWorkspaces", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    window.localStorage.removeItem("strideterm-notifications-v2");
    MockBroadcastChannel.instances = [];
    MockBroadcastChannel.posted = [];
    vi.stubGlobal("BroadcastChannel", MockBroadcastChannel);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const desktop = { partialByProfile: false, viewerProfileId: "default" };

  it("a complete payload removes every absent workspace, whatever its profile", () => {
    const store = useNotificationStore();
    seed(store, "ws-live", "ws-live:a", { profileId: "default" });
    seed(store, "ws-gone", "ws-gone:a", { profileId: "default" });
    seed(store, "ws-gone-other", "ws-gone-other:a", { profileId: "work" });
    seed(store, "ws-gone-unstamped", "ws-gone-unstamped:a");

    store.reconcileWorkspaces(new Set(["ws-live"]), desktop);

    expect(store.sessions.map((s) => s.workspaceId)).toEqual(["ws-live"]);
  });

  it("keeps sessions with no workspaceId at all", () => {
    const store = useNotificationStore();
    store.add({ title: "app error", body: "b", kind: "error" });

    store.reconcileWorkspaces(new Set(["ws-live"]), desktop);

    expect(store.sessions).toHaveLength(1);
  });

  // A remote protocol-v2 core carries only the viewer's own profile, so absence
  // proves deletion for that profile and nothing else.
  it("a profile-filtered payload removes only sessions stamped with the viewer's profile", () => {
    const store = useNotificationStore();
    seed(store, "ws-live", "ws-live:a", { profileId: "work" });
    seed(store, "ws-gone-mine", "ws-gone-mine:a", { profileId: "work" });
    seed(store, "ws-gone-foreign", "ws-gone-foreign:a", { profileId: "default" });
    seed(store, "ws-gone-unstamped", "ws-gone-unstamped:a");

    store.reconcileWorkspaces(new Set(["ws-live"]), { partialByProfile: true, viewerProfileId: "work" });

    expect(store.sessions.map((s) => s.workspaceId).sort()).toEqual([
      "ws-gone-foreign",
      "ws-gone-unstamped",
      "ws-live",
    ]);
  });

  it("a profile-filtered payload with no resolvable viewer profile removes nothing", () => {
    const store = useNotificationStore();
    seed(store, "ws-gone", "ws-gone:a", { profileId: "work" });

    store.reconcileWorkspaces(new Set(), { partialByProfile: true, viewerProfileId: null });

    expect(store.sessions).toHaveLength(1);
  });

  it("broadcasts the removed session ids, and stays silent when nothing changed", () => {
    const store = useNotificationStore();
    seed(store, "ws-gone", "ws-gone:a", { profileId: "default" });
    const removedId = store.sessions[0].id;
    MockBroadcastChannel.posted = [];

    store.reconcileWorkspaces(new Set(["ws-live"]), desktop);
    expect(MockBroadcastChannel.posted).toEqual([{ type: "clear-sessions", sessionIds: [removedId] }]);

    MockBroadcastChannel.posted = [];
    store.reconcileWorkspaces(new Set(["ws-live"]), desktop);
    expect(MockBroadcastChannel.posted).toHaveLength(0);
  });
});
