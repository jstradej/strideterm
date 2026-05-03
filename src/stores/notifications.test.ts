import { describe, it, expect, beforeEach } from "vitest";
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
  });

  it("clearOnBackend exists and tolerates missing api gracefully", async () => {
    const store = useNotificationStore();
    // No app store api is wired in this test harness — clearOnBackend must
    // resolve cleanly (best-effort) instead of throwing.
    await expect(store.clearOnBackend("ws1:panel1", { dismissed: true })).resolves.toBeUndefined();
    await expect(store.clearOnBackend("ws1:panel2", { dismissed: false })).resolves.toBeUndefined();
    await expect(store.clearOnBackend("ws1:panel3")).resolves.toBeUndefined();
  });
});
