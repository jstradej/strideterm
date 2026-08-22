import { describe, expect, test, beforeEach, afterEach, vi } from "vitest";
import { mount } from "@vue/test-utils";
import type { Ref } from "vue";
import NotificationBell from "./NotificationBell.vue";
import { heartbeatTargetCount, resetHeartbeatForTests } from "../../app/status-heartbeat.js";

/**
 * The toolbar bell is a shared heartbeat target for exactly as long as the
 * active profile has unread notifications. The count badge is the static
 * carrier of that state — the beat only says "still unread".
 */

// The unread count has to be a real Vue ref: the component reads it through a
// computed, which only re-evaluates when a reactive dependency changes. The
// ref is created inside the mock factory (which runs before this module body)
// and handed back out for the tests to drive.
vi.mock("../../stores/notifications.js", async () => {
  const { ref } = await import("vue");
  const unread = ref(0);
  return {
    useNotificationStore: () => ({
      pinned: false,
      unreadCountFor: () => unread.value,
      togglePanel: () => {},
    }),
    unreadForTests: unread,
  };
});

vi.mock("../../composables/useNotificationProfileScope.js", () => ({
  useNotificationProfileScope: () => ({ sessionInActiveProfile: () => true }),
}));

const unread = (
  (await import("../../stores/notifications.js")) as unknown as {
    unreadForTests: Ref<number>;
  }
).unreadForTests;

describe("NotificationBell — shared heartbeat target", () => {
  beforeEach(() => {
    unread.value = 0;
    resetHeartbeatForTests();
  });

  afterEach(() => {
    resetHeartbeatForTests();
  });

  test("no unread notifications means no heartbeat target", () => {
    const wrapper = mount(NotificationBell);

    expect(heartbeatTargetCount()).toBe(0);
    expect(wrapper.get("button").classes()).not.toContain("notification-bell--has-unread");
    expect(wrapper.get(".notification-bell__badge").text()).toBe("");

    wrapper.unmount();
  });

  test("unread > 0 registers the bell and keeps the badge count visible", () => {
    unread.value = 3;
    const wrapper = mount(NotificationBell);

    expect(heartbeatTargetCount()).toBe(1);
    expect(wrapper.get("button").classes()).toContain("notification-bell--has-unread");
    const badge = wrapper.get(".notification-bell__badge");
    expect(badge.text()).toBe("3");
    expect(badge.classes()).toContain("notification-bell__badge--visible");

    wrapper.unmount();
    expect(heartbeatTargetCount()).toBe(0);
  });

  test("unread dropping back to 0 deregisters the same element", async () => {
    unread.value = 2;
    const wrapper = mount(NotificationBell);
    const el = wrapper.get("button").element;
    expect(heartbeatTargetCount()).toBe(1);

    unread.value = 0;
    await wrapper.vm.$nextTick();

    expect(heartbeatTargetCount()).toBe(0);
    // No remount — the binding, not a v-if, drives registration.
    expect(wrapper.get("button").element).toBe(el);
    expect(wrapper.get("button").classes()).not.toContain("notification-bell--has-unread");
    expect(wrapper.get(".notification-bell__badge").text()).toBe("");

    wrapper.unmount();
  });

  test("unread rising from 0 registers without a remount", async () => {
    const wrapper = mount(NotificationBell);
    const el = wrapper.get("button").element;
    expect(heartbeatTargetCount()).toBe(0);

    unread.value = 1;
    await wrapper.vm.$nextTick();

    expect(heartbeatTargetCount()).toBe(1);
    expect(wrapper.get("button").element).toBe(el);

    wrapper.unmount();
  });
});
