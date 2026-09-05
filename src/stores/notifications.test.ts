import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { setActivePinia, createPinia } from "pinia";
import { useNotificationStore } from "./notifications.js";

describe("notification store (session-grouped)", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    window.localStorage.removeItem("strideterm-notifications");
    window.localStorage.removeItem("strideterm-notifications-v2");
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function addUnique(store: any, overrides = {}) {
    return store.add({
      title: "Test",
      body: "Body",
      kind: "waiting",
      workspaceId: "ws-" + Math.random().toString(36).slice(2, 8),
      viewId: "view-" + Math.random().toString(36).slice(2, 8),
      ...overrides,
    });
  }

  it("starts empty", () => {
    const store = useNotificationStore();
    expect(store.sessions).toEqual([]);
    expect(store.items).toEqual([]);
    expect(store.unreadCount).toBe(0);
    expect(store.panelOpen).toBe(false);
  });

  it("adds a waiting event — session state is waiting, unreadCount=1", () => {
    const store = useNotificationStore();
    addUnique(store, { kind: "waiting" });
    expect(store.sessions).toHaveLength(1);
    expect(store.sessions[0].state).toBe("waiting");
    expect(store.unreadCount).toBe(1);
    expect(store.items).toHaveLength(1);
  });

  it("adds a completed event — session state is finished, unreadCount=1 (waits for Ack)", () => {
    const store = useNotificationStore();
    addUnique(store, { kind: "completed" });
    expect(store.sessions[0].state).toBe("finished");
    // Finished sessions count toward the bell badge until the user acknowledges
    // them via Ack finished.
    expect(store.unreadCount).toBe(1);
  });

  it("groups multiple events for the same session", () => {
    const store = useNotificationStore();
    store.add({ title: "First", body: "a", kind: "waiting", workspaceId: "ws1", viewId: "v1" });
    store.add({ title: "Second", body: "b", kind: "waiting", workspaceId: "ws1", viewId: "v1" });
    expect(store.sessions).toHaveLength(1);
    expect(store.sessions[0].events).toHaveLength(2);
    // Latest event first
    expect(store.sessions[0].events[0].title).toBe("Second");
    // items computed flattens them
    expect(store.items).toHaveLength(2);
  });

  it("urgent event promotes session urgency", () => {
    const store = useNotificationStore();
    store.add({ title: "Idle", kind: "waiting", workspaceId: "ws1", viewId: "v1", urgency: "normal" });
    store.add({ title: "Permission", kind: "waiting", workspaceId: "ws1", viewId: "v1", urgency: "urgent" });
    expect(store.sessions[0].urgency).toBe("urgent");
  });

  it("markRead moves a session to resolved", () => {
    const store = useNotificationStore();
    const entry = addUnique(store, { kind: "waiting", workspaceId: "ws1", viewId: "v1" });
    store.markRead("ws1:v1");
    expect(store.sessions[0].state).toBe("resolved");
    expect(store.unreadCount).toBe(0);
    expect(entry.id).toBeTruthy();
  });

  it("markAllRead resolves waiting + finished sessions", () => {
    const store = useNotificationStore();
    store.add({ title: "A", kind: "waiting", workspaceId: "ws1", viewId: "v1" });
    store.add({ title: "B", kind: "completed", workspaceId: "ws2", viewId: "v2" });
    expect(store.waitingSessions).toHaveLength(1);
    expect(store.finishedSessions).toHaveLength(1);
    store.markAllRead();
    expect(store.waitingSessions).toHaveLength(0);
    expect(store.finishedSessions).toHaveLength(0);
    expect(store.resolvedSessions).toHaveLength(2);
  });

  it("remove by thread id drops the whole session", () => {
    const store = useNotificationStore();
    store.add({ title: "A", kind: "waiting", workspaceId: "ws1", viewId: "v1" });
    store.add({ title: "B", kind: "waiting", workspaceId: "ws1", viewId: "v1" });
    store.remove("ws1:v1");
    expect(store.sessions).toHaveLength(0);
  });

  it("remove by event id (legacy) prunes just the event; session survives if events remain", () => {
    const store = useNotificationStore();
    const first = store.add({ title: "A", kind: "waiting", workspaceId: "ws1", viewId: "v1" });
    store.add({ title: "B", kind: "waiting", workspaceId: "ws1", viewId: "v1" });
    store.remove(first.id);
    expect(store.sessions).toHaveLength(1);
    expect(store.sessions[0].events).toHaveLength(1);
    expect(store.sessions[0].events[0].title).toBe("B");
  });

  it("snooze hides a session for the requested duration", () => {
    const store = useNotificationStore();
    store.add({ title: "A", kind: "waiting", workspaceId: "ws1", viewId: "v1" });
    store.snooze("ws1:v1", 600_000);
    expect(store.sessions[0].snoozedUntil).toBeGreaterThan(Date.now());
  });

  it("toggles panel open/closed", () => {
    const store = useNotificationStore();
    expect(store.panelOpen).toBe(false);
    store.togglePanel();
    expect(store.panelOpen).toBe(true);
    store.togglePanel();
    expect(store.panelOpen).toBe(false);
  });

  it("persists to localStorage v2", () => {
    const store = useNotificationStore();
    store.add({ title: "Saved", kind: "waiting", workspaceId: "ws1", viewId: "v1" });
    const raw = JSON.parse(window.localStorage.getItem("strideterm-notifications-v2") ?? "null");
    expect(raw).toHaveLength(1);
    expect(raw[0].events[0].title).toBe("Saved");
    expect(raw[0].state).toBe("waiting");
  });

  it("newest session floats to the top after new event", () => {
    const store = useNotificationStore();
    store.add({ title: "First", kind: "waiting", workspaceId: "ws1", viewId: "v1" });
    store.add({ title: "Second", kind: "waiting", workspaceId: "ws2", viewId: "v2" });
    expect(store.sessions[0].workspaceId).toBe("ws2");

    // New event on ws1 should move it back to top
    store.add({ title: "Third", kind: "waiting", workspaceId: "ws1", viewId: "v1" });
    expect(store.sessions[0].workspaceId).toBe("ws1");
  });

  describe("persistent toasts (background-error UI)", () => {
    it("starts with no persistent toasts", () => {
      const store = useNotificationStore();
      expect(store.persistentToasts).toEqual([]);
    });

    it("pushPersistentToast adds an entry and returns its id", () => {
      const store = useNotificationStore();
      const id = store.pushPersistentToast({
        title: "Couldn't remove ws",
        body: "EBUSY: file in use",
        copyPath: "C:\\tmp\\worktree-foo",
      });
      expect(id).toBeTruthy();
      expect(store.persistentToasts).toHaveLength(1);
      expect(store.persistentToasts[0].title).toBe("Couldn't remove ws");
      expect(store.persistentToasts[0].copyPath).toBe("C:\\tmp\\worktree-foo");
      expect(store.persistentToasts[0].kind).toBe("error");
    });

    it("dismissPersistentToast removes only the matching entry", () => {
      const store = useNotificationStore();
      const idA = store.pushPersistentToast({ title: "A", body: "a" });
      const idB = store.pushPersistentToast({ title: "B", body: "b" });
      expect(store.persistentToasts).toHaveLength(2);
      store.dismissPersistentToast(idA);
      expect(store.persistentToasts).toHaveLength(1);
      expect(store.persistentToasts[0].title).toBe("B");
      // Idempotent: dismissing a missing id is a no-op
      store.dismissPersistentToast("nope");
      expect(store.persistentToasts).toHaveLength(1);
      store.dismissPersistentToast(idB);
      expect(store.persistentToasts).toHaveLength(0);
    });

    it("mirrors the toast into the dock so dismissing the toast doesn't lose the error", () => {
      const store = useNotificationStore();
      store.pushPersistentToast({
        title: "Disk delete failed",
        body: "Access is denied",
        copyPath: "/tmp/foo",
      });
      // Mirrored event lives in the dock and should include the path so the
      // user can still find it after dismissing the floating toast.
      expect(store.sessions).toHaveLength(1);
      const ev = store.sessions[0].events[0];
      expect(ev.title).toBe("Disk delete failed");
      expect(ev.body).toContain("/tmp/foo");
      expect(ev.kind).toBe("error");
    });

    it("pushPersistentToast defaults kind to error", () => {
      const store = useNotificationStore();
      store.pushPersistentToast({ title: "x", body: "y" });
      expect(store.persistentToasts[0].kind).toBe("error");
    });

    it("pushPersistentToast stamps meta.profileId on the mirrored dock entry", () => {
      // Without the stamp, the mirrored entry falls into the unknown-owner
      // bucket and useNotificationProfileScope shows it in every profile.
      const store = useNotificationStore();
      store.pushPersistentToast({ title: "Failed", body: "boom", profileId: "p1" });
      expect(store.sessions).toHaveLength(1);
      expect(store.sessions[0].meta?.profileId).toBe("p1");
    });

    it("showError stamps meta.profileId on the dock entry", () => {
      const store = useNotificationStore();
      store.showError("Bad", "thing", { profileId: "p2" });
      expect(store.sessions).toHaveLength(1);
      expect(store.sessions[0].meta?.profileId).toBe("p2");
    });

    it("showError without profileId leaves meta.profileId unset (legacy / unknown-owner path)", () => {
      const store = useNotificationStore();
      store.showError("Old caller", "no scope");
      expect(store.sessions).toHaveLength(1);
      expect(store.sessions[0].meta?.profileId).toBeUndefined();
    });
  });

  describe("runWithToast", () => {
    it("returns true and stays silent when the action resolves", async () => {
      const store = useNotificationStore();
      const ok = await store.runWithToast("Save", async () => "result");
      expect(ok).toBe(true);
      expect(store.sessions).toHaveLength(0);
    });

    it("returns false and surfaces an error toast when the action rejects", async () => {
      const store = useNotificationStore();
      const ok = await store.runWithToast("Save prompt failed", async () => {
        throw new Error("disk full");
      });
      expect(ok).toBe(false);
      expect(store.sessions).toHaveLength(1);
      expect(store.sessions[0].events[0].title).toBe("Save prompt failed");
      expect(store.sessions[0].events[0].body).toBe("disk full");
    });

    it("passes profileId through to the error toast for profile-scoped rendering", async () => {
      const store = useNotificationStore();
      await store.runWithToast(
        "Delete failed",
        async () => {
          throw new Error("nope");
        },
        { profileId: "p3" },
      );
      expect(store.sessions[0].meta?.profileId).toBe("p3");
    });
  });

  describe("profile-scoped filters", () => {
    // Sessions are stamped with `meta.profileId` at creation time by the
    // review / pipeline composables. The store-level helpers stay agnostic
    // of the profile concept and just accept a predicate — these tests
    // verify the predicate-aware variants actually scope correctly so a
    // window in profile B can't ack or clear profile A's sessions.

    it("unreadCountFor counts only sessions matching the predicate", () => {
      const store = useNotificationStore();
      store.add({ title: "A", kind: "waiting", workspaceId: "wsA", viewId: "v1", meta: { profileId: "p1" } });
      store.add({ title: "B", kind: "completed", workspaceId: "wsB", viewId: "v2", meta: { profileId: "p2" } });
      store.add({ title: "C", kind: "waiting", workspaceId: "wsC", viewId: "v3", meta: { profileId: "p2" } });
      expect(store.unreadCount).toBe(3);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const inP2 = (s: any) => s.meta?.profileId === "p2";
      expect(store.unreadCountFor(inP2)).toBe(2);
    });

    it("markAllRead with a predicate only resolves matching sessions", () => {
      const store = useNotificationStore();
      store.add({ title: "A", kind: "waiting", workspaceId: "wsA", viewId: "v1", meta: { profileId: "p1" } });
      store.add({ title: "B", kind: "waiting", workspaceId: "wsB", viewId: "v2", meta: { profileId: "p2" } });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      store.markAllRead((s: any) => s.meta?.profileId === "p2");
      const a = store.sessions.find((s) => s.workspaceId === "wsA")!;
      const b = store.sessions.find((s) => s.workspaceId === "wsB")!;
      expect(a.state).toBe("waiting"); // untouched — wrong profile
      expect(b.state).toBe("resolved"); // matched
    });

    it("clearAll with a predicate keeps non-matching sessions", () => {
      const store = useNotificationStore();
      store.add({ title: "A", kind: "waiting", workspaceId: "wsA", viewId: "v1", meta: { profileId: "p1" } });
      store.add({ title: "B", kind: "waiting", workspaceId: "wsB", viewId: "v2", meta: { profileId: "p2" } });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      store.clearAll((s: any) => s.meta?.profileId === "p2");
      expect(store.sessions).toHaveLength(1);
      expect(store.sessions[0].workspaceId).toBe("wsA");
    });

    it("markAllRead with no predicate keeps the legacy global behavior", () => {
      const store = useNotificationStore();
      store.add({ title: "A", kind: "waiting", workspaceId: "wsA", viewId: "v1", meta: { profileId: "p1" } });
      store.add({ title: "B", kind: "completed", workspaceId: "wsB", viewId: "v2", meta: { profileId: "p2" } });
      store.markAllRead();
      expect(store.waitingSessions).toHaveLength(0);
      expect(store.finishedSessions).toHaveLength(0);
    });
  });

  it("clearOnBackend exists and tolerates missing api gracefully", async () => {
    const store = useNotificationStore();
    // No app store api is wired in this test harness — clearOnBackend must
    // resolve cleanly (best-effort) instead of throwing.
    await expect(store.clearOnBackend("ws1:panel1", { dismissed: true })).resolves.toBeUndefined();
    await expect(store.clearOnBackend("ws1:panel2", { dismissed: false })).resolves.toBeUndefined();
    await expect(store.clearOnBackend("ws1:panel3")).resolves.toBeUndefined();
  });

  it("clearOnBackend propagates a real RPC failure so callers can surface it", async () => {
    const store = useNotificationStore();
    const { useAppStore } = await import("./app.js");
    const appStore = useAppStore();
    // A wired RPC that actually rejects must NOT be swallowed — otherwise the
    // caller's runWithToast never fires and the UI resolves a notification
    // whose backend alert is still active.
    vi.spyOn(appStore, "getApi").mockReturnValue(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { clearAlertForSession: () => Promise.reject(new Error("backend unreachable")) } as any,
    );
    await expect(store.clearOnBackend("ws1:panel1", { dismissed: false })).rejects.toThrow("backend unreachable");
  });
});

describe("notification store — profile label in session meta", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    window.localStorage.removeItem("strideterm-notifications-v2");
  });

  it("stores profileId in meta when addEvent is called with meta.profileId", () => {
    const store = useNotificationStore();
    store.add({
      title: "Done",
      kind: "completed",
      workspaceId: "ws1",
      viewId: "ws1:shell",
      meta: { profileId: "profile-a" },
    });
    expect(store.sessions[0].meta?.profileId).toBe("profile-a");
  });

  it("session without profileId in meta falls back to workspace-based resolution", () => {
    const store = useNotificationStore();
    store.add({ title: "Done", kind: "completed", workspaceId: "ws2", viewId: "ws2:shell" });
    // No profileId in meta — resolveSessionProfileId will fall back to workspace map
    expect(store.sessions[0].meta?.profileId).toBeUndefined();
    expect(store.sessions[0].workspaceId).toBe("ws2");
  });
});

describe("notification store — cross-window ack sync (BroadcastChannel)", () => {
  // Mock BroadcastChannel that routes messages between instances in the same
  // JS context (the real one never delivers to the posting context, and jsdom
  // may not provide it at all).
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
        if (inst !== this && inst.name === this.name) {
          inst.onmessage?.({ data });
        }
      }
    }
    close(): void {
      // no-op
    }
  }

  beforeEach(() => {
    setActivePinia(createPinia());
    window.localStorage.removeItem("strideterm-notifications");
    window.localStorage.removeItem("strideterm-notifications-v2");
    MockBroadcastChannel.instances = [];
    MockBroadcastChannel.posted = [];
    vi.stubGlobal("BroadcastChannel", MockBroadcastChannel);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function makeTwoWindows() {
    // Two pinia contexts = two windows. Each store instance creates its own
    // BroadcastChannel through the mocked global.
    const piniaA = createPinia();
    setActivePinia(piniaA);
    const storeA = useNotificationStore();
    const piniaB = createPinia();
    setActivePinia(piniaB);
    const storeB = useNotificationStore();
    return { storeA, storeB };
  }

  const samePayload = {
    title: "Waiting for input",
    body: "Shell in Alpha is waiting.",
    kind: "waiting",
    workspaceId: "ws-1",
    viewId: "ws-1:shell",
    meta: { profileId: "profile-a" },
  };

  it("same alert arriving in two windows creates an unread session in both (arrival is per-window)", () => {
    const { storeA, storeB } = makeTwoWindows();
    storeA.add({ ...samePayload });
    storeB.add({ ...samePayload });
    expect(storeA.unreadCount).toBe(1);
    expect(storeB.unreadCount).toBe(1);
    // Arrival must NOT be broadcast — otherwise the first window would
    // suppress the toast in its same-profile sibling.
    const arrivalMessages = MockBroadcastChannel.posted.filter(
      (m) => (m as { type?: string }).type === "add" || (m as { type?: string }).type === "arrival",
    );
    expect(arrivalMessages).toHaveLength(0);
  });

  it("ack (markRead) in one window resolves the session in the other", () => {
    const { storeA, storeB } = makeTwoWindows();
    storeA.add({ ...samePayload });
    storeB.add({ ...samePayload });

    storeA.markRead("ws-1:ws-1:shell");

    expect(storeA.sessions[0].state).toBe("resolved");
    expect(storeB.sessions[0].state).toBe("resolved");
    expect(storeB.unreadCount).toBe(0);
  });

  it("markAllRead in one window resolves matching sessions in the other", () => {
    const { storeA, storeB } = makeTwoWindows();
    storeA.add({ ...samePayload });
    storeB.add({ ...samePayload });

    storeA.markAllRead();

    expect(storeB.sessions[0].state).toBe("resolved");
  });

  it("snooze in one window propagates snoozedUntil to the other", () => {
    const { storeA, storeB } = makeTwoWindows();
    storeA.add({ ...samePayload });
    storeB.add({ ...samePayload });

    storeA.snooze("ws-1:ws-1:shell", 60_000);

    expect(storeB.sessions[0].snoozedUntil).toBeGreaterThan(Date.now());
  });

  it("clearAll with a filter removes only the matching sessions in the other window", () => {
    const { storeA, storeB } = makeTwoWindows();
    storeA.add({ ...samePayload });
    storeB.add({ ...samePayload });
    // storeB also holds an alert from ANOTHER profile that storeA never saw.
    storeB.add({
      title: "Other profile",
      kind: "waiting",
      workspaceId: "ws-other",
      viewId: "ws-other:shell",
      meta: { profileId: "profile-b" },
    });

    storeA.clearAll((s) => s.meta?.profileId === "profile-a");

    expect(storeA.sessions).toHaveLength(0);
    // storeB lost the profile-a session but keeps its own profile-b session.
    expect(storeB.sessions).toHaveLength(1);
    expect(storeB.sessions[0].meta?.profileId).toBe("profile-b");
  });

  it("remove in one window removes the session in the other", () => {
    const { storeA, storeB } = makeTwoWindows();
    storeA.add({ ...samePayload });
    storeB.add({ ...samePayload });

    storeA.remove("ws-1:ws-1:shell");

    expect(storeB.sessions).toHaveLength(0);
  });

  it("applying a sync message does not echo a broadcast back (no loops)", () => {
    const { storeA } = makeTwoWindows();
    storeA.add({ ...samePayload });
    const postedBefore = MockBroadcastChannel.posted.length;

    storeA._applySyncMessageForTest({ type: "set-state", sessionIds: ["ws-1:ws-1:shell"], state: "resolved" });

    expect(storeA.sessions[0].state).toBe("resolved");
    expect(MockBroadcastChannel.posted.length).toBe(postedBefore);
  });

  it("store works when BroadcastChannel is unavailable", () => {
    vi.unstubAllGlobals();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const original = (globalThis as any).BroadcastChannel;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (globalThis as any).BroadcastChannel;
    try {
      setActivePinia(createPinia());
      const store = useNotificationStore();
      store.add({ ...samePayload });
      store.markRead("ws-1:ws-1:shell");
      expect(store.sessions[0].state).toBe("resolved");
    } finally {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      if (original !== undefined) (globalThis as any).BroadcastChannel = original;
    }
  });
});

describe("resolveByEngagement — typing acknowledges a session", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    window.localStorage.removeItem("strideterm-notifications-v2");
  });

  function seed(kind: string) {
    const store = useNotificationStore();
    store.add({ title: "T", body: "B", kind, workspaceId: "ws1", viewId: "ws1:panel1" });
    return store;
  }

  it("resolves a finished thread — the completed-agent case", () => {
    const store = seed("completed");
    expect(store.sessions[0].state).toBe("finished");
    expect(store.unreadCount).toBe(1);

    store.resolveByEngagement("ws1:panel1", "y");

    expect(store.sessions[0].state).toBe("resolved");
    expect(store.unreadCount).toBe(0);
  });

  it("resolves a waiting thread", () => {
    const store = seed("waiting");
    store.resolveByEngagement("ws1:panel1", "\r");
    expect(store.sessions[0].state).toBe("resolved");
  });

  it("ignores passive traffic — clicks, wheel and focus do not acknowledge", () => {
    const store = seed("completed");
    store.resolveByEngagement("ws1:panel1", "\x1b[<0;40;12M");
    store.resolveByEngagement("ws1:panel1", "\x1b[<64;10;5M");
    store.resolveByEngagement("ws1:panel1", "\x1b[I");
    store.resolveByEngagement("ws1:panel1", "");
    expect(store.sessions[0].state).toBe("finished");
    expect(store.unreadCount).toBe(1);
  });

  it("ignores emulator replies — resizing the window must not acknowledge", () => {
    const store = seed("completed");
    // What an agent TUI emits when it re-queries the terminal on SIGWINCH.
    store.resolveByEngagement("ws1:panel1", "\x1b[8;40;120t");
    store.resolveByEngagement("ws1:panel1", "\x1b]11;rgb:1e1e/1e1e/1e1e\x1b\\");
    store.resolveByEngagement("ws1:panel1", "\x1b[24;80R");
    store.resolveByEngagement("ws1:panel1", "\x1b[?1;2c");
    expect(store.sessions[0].state).toBe("finished");

    // …but a keystroke in the same burst still counts.
    store.resolveByEngagement("ws1:panel1", "\x1b[24;80Ry");
    expect(store.sessions[0].state).toBe("resolved");
  });

  it("only touches the session that was typed into", () => {
    const store = useNotificationStore();
    store.add({ title: "A", kind: "completed", workspaceId: "ws1", viewId: "ws1:panel1" });
    store.add({ title: "B", kind: "completed", workspaceId: "ws1", viewId: "ws1:panel2" });

    store.resolveByEngagement("ws1:panel1", "x");

    const byView = new Map(store.sessions.map((s) => [s.viewId, s.state]));
    expect(byView.get("ws1:panel1")).toBe("resolved");
    expect(byView.get("ws1:panel2")).toBe("finished");
  });

  it("is a no-op for an unknown or empty session id", () => {
    const store = seed("completed");
    store.resolveByEngagement("ws1:nope", "x");
    store.resolveByEngagement("", "x");
    expect(store.sessions[0].state).toBe("finished");
  });
});

describe("notification store — historical (replayed) events", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    window.localStorage.removeItem("strideterm-notifications");
    window.localStorage.removeItem("strideterm-notifications-v2");
  });

  /** One replayed audit row: a `historical` add with its source order. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function replay(store: any, at: string, rank: number, overrides = {}) {
    return store.add({
      title: "Approval sent",
      kind: "info",
      tier: 3,
      workspaceId: "ws1",
      viewId: "ws1:panel1",
      occurredAt: at,
      historical: true,
      historyRank: rank,
      ...overrides,
    });
  }

  it("places a replayed event by its own time, not at the head", () => {
    const store = useNotificationStore();
    replay(store, "2026-09-03T10:00:02.000Z", 2);
    replay(store, "2026-09-03T10:00:03.000Z", 3);
    // Arrives last but belongs in the middle — a back-fill batch that walks
    // downwards hands the older rows over after the newer ones.
    replay(store, "2026-09-03T10:00:01.000Z", 1);

    expect(store.sessions[0].events.map((event: { at: string }) => event.at)).toEqual([
      "2026-09-03T10:00:03.000Z",
      "2026-09-03T10:00:02.000Z",
      "2026-09-03T10:00:01.000Z",
    ]);
    // `latestAt` follows the newest event, never the last write.
    expect(store.sessions[0].latestAt).toBe("2026-09-03T10:00:03.000Z");
    // `firstAt` follows the oldest, which the replay just moved back.
    expect(store.sessions[0].firstAt).toBe("2026-09-03T10:00:01.000Z");
  });

  it("breaks a same-millisecond tie on the source order", () => {
    const store = useNotificationStore();
    // A burst of auto-approvals inside one turn shares a millisecond, so the
    // timestamp alone cannot order them — the audit row id can.
    replay(store, "2026-09-03T10:00:00.000Z", 7, { body: "seventh" });
    replay(store, "2026-09-03T10:00:00.000Z", 9, { body: "ninth" });
    replay(store, "2026-09-03T10:00:00.000Z", 8, { body: "eighth" });

    expect(store.sessions[0].events.map((event: { body: string }) => event.body)).toEqual([
      "ninth",
      "eighth",
      "seventh",
    ]);
  });

  it("drops the oldest replayed event at the per-session cap, never the newest", () => {
    const store = useNotificationStore();
    // Twenty newer events fill the thread...
    for (let index = 20; index < 40; index += 1) {
      replay(store, `2026-09-03T10:00:00.${String(index).padStart(3, "0")}Z`, index);
    }
    // ...then an older batch arrives, as a continuation always does.
    for (let index = 0; index < 5; index += 1) {
      replay(store, `2026-09-03T10:00:00.${String(index).padStart(3, "0")}Z`, index);
    }

    const events = store.sessions[0].events;
    expect(events).toHaveLength(20);
    expect(events[0].at).toBe("2026-09-03T10:00:00.039Z");
    expect(events[19].at).toBe("2026-09-03T10:00:00.020Z");
    expect(store.sessions[0].latestAt).toBe("2026-09-03T10:00:00.039Z");
  });

  it("drops the oldest replayed session at the session cap, never a newer one", () => {
    const store = useNotificationStore();
    for (let index = 200; index < 400; index += 1) {
      replay(store, `2026-09-03T10:00:00.${String(index).padStart(3, "0")}Z`, index, {
        viewId: `ws1:panel-${index}`,
      });
    }
    expect(store.sessions).toHaveLength(200);

    // An older continuation batch: every one of these is older than all 200,
    // so the cap has to drop THEM rather than the newest threads it holds.
    for (let index = 0; index < 5; index += 1) {
      replay(store, `2026-09-03T10:00:00.${String(index).padStart(3, "0")}Z`, index, {
        viewId: `ws1:panel-${index}`,
      });
    }

    expect(store.sessions).toHaveLength(200);
    expect(store.sessions[0].viewId).toBe("ws1:panel-399");
    expect(store.sessions[199].viewId).toBe("ws1:panel-200");
  });

  it("leaves the live path prepending, however old the event claims to be", () => {
    const store = useNotificationStore();
    store.add({
      title: "A",
      kind: "waiting",
      workspaceId: "ws1",
      viewId: "v1",
      occurredAt: "2026-09-03T10:00:02.000Z",
    });
    // No `historical`: a live arrival is the newest thing in the thread by
    // definition, and its own clock is not evidence to the contrary.
    store.add({
      title: "B",
      kind: "waiting",
      workspaceId: "ws1",
      viewId: "v1",
      occurredAt: "2026-09-03T10:00:01.000Z",
    });

    expect(store.sessions[0].events.map((event: { title: string }) => event.title)).toEqual(["B", "A"]);
    expect(store.sessions[0].latestAt).toBe("2026-09-03T10:00:01.000Z");
  });

  it("makes an event the per-session cap drops a no-op for everything visible", () => {
    const store = useNotificationStore();
    // Twenty kept events, all newer, carrying the labels, category and meta
    // the session must still be showing when this test ends.
    for (let index = 20; index < 40; index += 1) {
      replay(store, `2026-09-03T10:00:00.${String(index).padStart(3, "0")}Z`, index, {
        viewId: "ws1:panel-a",
        workspaceName: "Alpha",
        tabName: "shell",
        category: "approval",
        meta: { profileId: "default", requestId: `req-${index}` },
      });
    }
    // A second, newer thread: the dropped row must not bubble its own thread
    // over this one either.
    replay(store, "2026-09-03T10:00:00.050Z", 50, { viewId: "ws1:panel-b" });
    store.markAllRead();
    expect(store.unreadCount).toBe(0);

    // The continuation batch brings a row older than all twenty kept events.
    replay(store, "2026-09-03T10:00:00.001Z", 1, {
      viewId: "ws1:panel-a",
      workspaceName: "Renamed",
      tabName: "renamed",
      category: "terminal",
      meta: { profileId: "default", requestId: "req-1" },
    });

    const session = store.sessions.find((s: { viewId: string }) => s.viewId === "ws1:panel-a");
    // It is not in the visible history...
    expect(session?.events).toHaveLength(20);
    expect(session?.events.some((event: { at: string }) => event.at === "2026-09-03T10:00:00.001Z")).toBe(false);
    // ...so it changes nothing the user can see: not the state (this is the
    // regression — a row nobody can point at reopened a resolved thread),
    // not the unread count, not the labels, category or meta, and not the
    // thread's place in the list.
    expect(session?.state).toBe("resolved");
    expect(store.unreadCount).toBe(0);
    expect(session?.workspaceName).toBe("Alpha");
    expect(session?.tabName).toBe("shell");
    expect(session?.category).toBe("approval");
    expect(session?.meta?.requestId).toBe("req-39");
    expect(session?.latestAt).toBe("2026-09-03T10:00:00.039Z");
    expect(store.sessions[0].viewId).toBe("ws1:panel-b");
    // `firstAt` is the deliberate exception: the row proves the thread began
    // earlier than history knew, which is a lifetime fact about the thread
    // and not a claim about its current state.
    expect(session?.firstAt).toBe("2026-09-03T10:00:00.001Z");
  });

  it("reports a per-session-cap drop as inserted: false", () => {
    const store = useNotificationStore();
    /** The alert-capture entry point, replaying one audit row. */
    function replayAlert(at: string, rank: number) {
      return store.addAlertEvent({
        title: "Approval sent",
        kind: "info",
        tier: 3,
        workspaceId: "ws1",
        viewId: "ws1:panel1",
        category: "approval",
        meta: { requestId: `req-${rank}` },
        sourceAlertId: `approval:req-${rank}`,
        occurredAt: at,
        historical: true,
        historyRank: rank,
      });
    }
    for (let index = 20; index < 40; index += 1) {
      replayAlert(`2026-09-03T10:00:00.${String(index).padStart(3, "0")}Z`, index);
    }

    // Control: a replay the cap keeps is a real insert.
    expect(replayAlert("2026-09-03T10:00:00.045Z", 45).inserted).toBe(true);
    // The finding: not a duplicate, but not in the history either — the cap
    // dropped it, so `inserted` has to say so.
    expect(replayAlert("2026-09-03T10:00:00.001Z", 1).inserted).toBe(false);
    expect(store.sessions[0].events).toHaveLength(20);
    expect(store.sessions[0].events[19].at).toBe("2026-09-03T10:00:00.021Z");
  });

  it("reports a session-cap drop as inserted: false and leaves the list alone", () => {
    const store = useNotificationStore();
    for (let index = 200; index < 400; index += 1) {
      replay(store, `2026-09-03T10:00:00.${String(index).padStart(3, "0")}Z`, index, {
        viewId: `ws1:panel-${index}`,
      });
    }
    const before = store.sessions.map((s: { viewId: string }) => s.viewId);

    // A brand-new thread, older than all 200 the cap keeps: the slice throws
    // it away, so the store never held it.
    const result = store.addAlertEvent({
      title: "Approval sent",
      kind: "info",
      tier: 3,
      workspaceId: "ws1",
      viewId: "ws1:panel-old",
      category: "approval",
      sourceAlertId: "approval:req-old",
      occurredAt: "2026-09-03T10:00:00.001Z",
      historical: true,
      historyRank: 1,
    });

    expect(result.inserted).toBe(false);
    expect(store.sessions.map((s: { viewId: string }) => s.viewId)).toEqual(before);
  });

  it("keeps a retained mid-thread replay out of the session's newest-event projection", () => {
    const store = useNotificationStore();
    replay(store, "2026-09-03T10:00:03.000Z", 3, {
      workspaceName: "Alpha",
      tabName: "shell",
      category: "approval",
      meta: { requestId: "req-3" },
    });
    store.markAllRead();

    // Older than the head but well inside the cap: real, visible history.
    replay(store, "2026-09-03T10:00:01.000Z", 1, {
      workspaceName: "Renamed",
      tabName: "renamed",
      category: "terminal",
      meta: { requestId: "req-1" },
    });

    const session = store.sessions[0];
    expect(session.events.map((event: { at: string }) => event.at)).toEqual([
      "2026-09-03T10:00:03.000Z",
      "2026-09-03T10:00:01.000Z",
    ]);
    // The session-level projection describes `events[0]`, so an event that
    // did not become the newest one does not rewrite it.
    expect(session.state).toBe("resolved");
    expect(session.workspaceName).toBe("Alpha");
    expect(session.tabName).toBe("shell");
    expect(session.category).toBe("approval");
    expect(session.meta?.requestId).toBe("req-3");
    expect(session.latestAt).toBe("2026-09-03T10:00:03.000Z");
    expect(session.firstAt).toBe("2026-09-03T10:00:01.000Z");
  });

  it("lets a replay that IS the newest event speak for the session", () => {
    const store = useNotificationStore();
    replay(store, "2026-09-03T10:00:01.000Z", 1, { workspaceName: "Alpha", meta: { requestId: "req-1" } });
    store.markAllRead();
    expect(store.sessions[0].state).toBe("resolved");

    // Newer than anything history held — this one is news, and the reopen
    // semantics the back-fill relies on are unchanged.
    replay(store, "2026-09-03T10:00:05.000Z", 5, { workspaceName: "Beta", meta: { requestId: "req-5" } });

    expect(store.sessions[0].state).toBe("finished");
    expect(store.unreadCount).toBe(1);
    expect(store.sessions[0].workspaceName).toBe("Beta");
    expect(store.sessions[0].meta?.requestId).toBe("req-5");
  });
});
