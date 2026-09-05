/**
 * The toast slot is shared by every source in the app — alert capture,
 * `showError`, the update-available notice, review notifications. Before the
 * queue, whichever wrote last simply overwrote whatever was showing.
 *
 * For a `question` that is a real loss rather than a cosmetic one: its toast
 * is deliberately sticky because the agent is blocked until the user answers,
 * so it must not disappear without ever having been clicked, closed or
 * resolved.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { setActivePinia, createPinia } from "pinia";
import { useNotificationStore } from "./notifications.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toast(id: string, kind: string): any {
  return {
    id,
    title: id,
    body: "",
    kind,
    tier: 1,
    urgency: "normal",
    at: new Date().toISOString(),
    category: "terminal",
  };
}

describe("notification store — toast queue", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    window.localStorage.removeItem("strideterm-notifications-v2");
  });

  it("an unrelated alert does not replace an unanswered question", () => {
    const store = useNotificationStore();
    store.pushToast(toast("question-a", "question"));
    store.pushToast(toast("completed-b", "completed"));

    expect(store.latestToast?.id).toBe("question-a");
    expect(store.toastQueue.map((t) => t.id)).toEqual(["completed-b"]);
  });

  it("dismissing the question promotes the queued toast", () => {
    const store = useNotificationStore();
    store.pushToast(toast("question-a", "question"));
    store.pushToast(toast("completed-b", "completed"));
    store.pushToast(toast("error-c", "error"));

    store.dismissToast();
    expect(store.latestToast?.id).toBe("completed-b");
    store.dismissToast();
    expect(store.latestToast?.id).toBe("error-c");
    store.dismissToast();
    expect(store.latestToast).toBeNull();
  });

  it("a second question queues behind the first rather than erasing it", () => {
    const store = useNotificationStore();
    store.pushToast(toast("question-a", "question"));
    store.pushToast(toast("question-b", "question"));

    expect(store.latestToast?.id).toBe("question-a");
    store.dismissToast();
    expect(store.latestToast?.id).toBe("question-b");
  });

  it("a non-question toast is replaced in place, as before", () => {
    // Only an unanswered question owns the slot; ordinary toasts keep the
    // cheap "newest wins" behaviour and do not accumulate a backlog.
    const store = useNotificationStore();
    store.pushToast(toast("completed-a", "completed"));
    store.pushToast(toast("completed-b", "completed"));

    expect(store.latestToast?.id).toBe("completed-b");
    expect(store.toastQueue).toHaveLength(0);
  });

  it("re-pushing the same toast is not queued behind itself", () => {
    const store = useNotificationStore();
    store.pushToast(toast("question-a", "question"));
    store.pushToast(toast("question-a", "question"));

    expect(store.latestToast?.id).toBe("question-a");
    expect(store.toastQueue).toHaveLength(0);
  });

  it("the queue is bounded — the point is not to replay an evening of alerts", () => {
    const store = useNotificationStore();
    store.pushToast(toast("question-a", "question"));
    for (let i = 0; i < 20; i += 1) store.pushToast(toast(`completed-${i}`, "completed"));

    expect(store.toastQueue).toHaveLength(5);
    // Newest kept: the history dock already holds the rest.
    expect(store.toastQueue.at(-1)?.id).toBe("completed-19");
  });

  it("showError goes through the same protected slot", () => {
    const store = useNotificationStore();
    store.pushToast(toast("question-a", "question"));
    store.showError("Delete failed", "boom", { workspaceId: "ws-a" });

    expect(store.latestToast?.id).toBe("question-a");
    expect(store.toastQueue).toHaveLength(1);
  });
});
