/**
 * A `question` toast is sticky: the agent is blocked until the user answers,
 * so it has no timer and goes away only on click, on close, or when the
 * question it shows is over.
 *
 * "Over" has to be decided per ALERT. The backend keeps one alert per panel,
 * so a second question replaces the first while the panel's thread stays
 * `waiting` — a toast watching the thread would then show a dead question
 * indefinitely (follow-up review, P2-6).
 */
import { describe, it, expect, beforeEach } from "vitest";
import { mount } from "@vue/test-utils";
import { setActivePinia, createPinia } from "pinia";
import { nextTick } from "vue";
import NotificationToast from "./NotificationToast.vue";
import { useNotificationStore } from "../../stores/notifications.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function questionToast(overrides: Record<string, unknown> = {}): any {
  return {
    id: "evt-1",
    kind: "question",
    urgency: "urgent",
    category: "terminal",
    title: "Permission needed: Bash",
    body: "Bash: first",
    viewId: "ws-a:shell",
    sourceAlertId: "alert-1",
    ...overrides,
  };
}

/** A panel with an unanswered question — the thread stays `waiting`. */
function seedWaitingThread(store: ReturnType<typeof useNotificationStore>, sourceAlertId: string) {
  store.addAlertEvent({
    title: "Permission needed: Bash",
    body: "Bash: first",
    kind: "question",
    tier: 1,
    urgency: "urgent",
    workspaceId: "ws-a",
    workspaceName: "Alpha",
    tabName: "Claude Code",
    viewId: "ws-a:shell",
    category: "terminal",
    sourceAlertId,
    occurredAt: new Date().toISOString(),
  });
}

/**
 * App.vue binds `latestToast`, which is null until a toast arrives — the
 * component only becomes visible on that transition, so a test that mounts
 * with the toast already in place would render nothing.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function mountWithToast(toast: any) {
  const wrapper = mount(NotificationToast, { props: { toast: null } });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await wrapper.setProps({ toast } as any);
  await nextTick();
  return wrapper;
}

describe("NotificationToast — sticky question lifecycle", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    window.localStorage.removeItem("strideterm-notifications-v2");
    window.localStorage.removeItem("strideterm-notifications-pinned");
  });

  it("stays while its own alert is still in the payload", async () => {
    const store = useNotificationStore();
    store.setLiveAlertIds(["alert-1"]);
    const wrapper = await mountWithToast(questionToast());

    expect(wrapper.find(".notification-toast").exists()).toBe(true);
    expect(wrapper.emitted("dismissed")).toBeUndefined();
  });

  it("closes when its alert is replaced by the panel's next question", async () => {
    const store = useNotificationStore();
    seedWaitingThread(store, "alert-1");
    store.setLiveAlertIds(["alert-1"]);
    const wrapper = await mountWithToast(questionToast());
    expect(wrapper.emitted("dismissed")).toBeUndefined();

    // Question B on the same panel: the thread is STILL waiting, and under the
    // old thread-state rule this toast would have stayed up forever.
    store.setLiveAlertIds(["alert-2"]);
    await nextTick();

    expect(store.sessions[0].state).toBe("waiting");
    expect(wrapper.emitted("dismissed")).toHaveLength(1);
    expect(wrapper.find(".notification-toast").exists()).toBe(false);
  });

  it("falls back to the thread state for a toast with no alert id", async () => {
    const store = useNotificationStore();
    seedWaitingThread(store, "alert-legacy");
    const wrapper = await mountWithToast(questionToast({ sourceAlertId: undefined }));
    expect(wrapper.emitted("dismissed")).toBeUndefined();

    store.setState(store.sessions[0].id, "resolved");
    await nextTick();

    expect(wrapper.emitted("dismissed")).toHaveLength(1);
  });
});
