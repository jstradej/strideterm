import { describe, it, expect, beforeEach } from "vitest";
import { setActivePinia, createPinia } from "pinia";
import { useNotificationStore } from "./notifications.js";

describe("notification store", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    window.localStorage.removeItem("strideterm-notifications");
  });

  it("starts with empty items", () => {
    const store = useNotificationStore();
    expect(store.items).toEqual([]);
    expect(store.unreadCount).toBe(0);
    expect(store.panelOpen).toBe(false);
  });

  it("adds a notification and increments unread count", () => {
    const store = useNotificationStore();
    const entry = store.add({ title: "Test", body: "Something happened", kind: "completed" });
    expect(store.items).toHaveLength(1);
    expect(store.unreadCount).toBe(1);
    expect(entry.id).toBeTruthy();
    expect(entry.read).toBe(false);
  });

  it("marks a notification as read", () => {
    const store = useNotificationStore();
    const entry = store.add({ title: "Test", body: "Body" });
    store.markRead(entry.id);
    expect(store.items[0].read).toBe(true);
    expect(store.unreadCount).toBe(0);
  });

  it("marks all as read", () => {
    const store = useNotificationStore();
    store.add({ title: "A", body: "a" });
    store.add({ title: "B", body: "b" });
    expect(store.unreadCount).toBe(2);
    store.markAllRead();
    expect(store.unreadCount).toBe(0);
  });

  it("removes a notification", () => {
    const store = useNotificationStore();
    const entry = store.add({ title: "X", body: "x" });
    store.remove(entry.id);
    expect(store.items).toHaveLength(0);
  });

  it("clears all notifications", () => {
    const store = useNotificationStore();
    store.add({ title: "A", body: "a" });
    store.add({ title: "B", body: "b" });
    store.clearAll();
    expect(store.items).toHaveLength(0);
    expect(store.unreadCount).toBe(0);
  });

  it("toggles panel open/closed", () => {
    const store = useNotificationStore();
    expect(store.panelOpen).toBe(false);
    store.togglePanel();
    expect(store.panelOpen).toBe(true);
    store.togglePanel();
    expect(store.panelOpen).toBe(false);
  });

  it("persists to localStorage", () => {
    const store = useNotificationStore();
    store.add({ title: "Saved", body: "persistent" });
    const raw = JSON.parse(window.localStorage.getItem("strideterm-notifications"));
    expect(raw).toHaveLength(1);
    expect(raw[0].title).toBe("Saved");
  });

  it("limits notifications to 100", () => {
    const store = useNotificationStore();
    for (let i = 0; i < 110; i++) {
      store.add({ title: `N${i}`, body: `body ${i}` });
    }
    expect(store.items.length).toBeLessThanOrEqual(100);
  });

  it("newest notification is first in the list", () => {
    const store = useNotificationStore();
    store.add({ title: "First", body: "a" });
    store.add({ title: "Second", body: "b" });
    expect(store.items[0].title).toBe("Second");
    expect(store.items[1].title).toBe("First");
  });
});
