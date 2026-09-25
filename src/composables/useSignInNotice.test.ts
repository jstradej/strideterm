// The handoff back to a person who walked away — which is every person, because the flow told them
// to go and read their mail.

import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { defineComponent, h } from "vue";
import { mount } from "@vue/test-utils";

import { useSignInNotice } from "./useSignInNotice.js";
import { useAccountStore } from "../stores/account.js";
import { useNotificationStore } from "../stores/notifications.js";
import { useAppStore } from "../stores/app.js";
import PersistentToastStack from "../components/layout/PersistentToastStack.vue";

const Host = defineComponent({
  setup() {
    useSignInNotice();
    return () => h("div");
  },
});

/** The sanitized attempt substate, as the backend broadcasts it. */
function attempt(phase: string): Record<string, unknown> {
  return {
    phase,
    email: "owner@example.test",
    purpose: "enrol",
    expiresAt: Date.now() + 600_000,
    canResendAt: Date.now(),
    manualOnly: false,
    sendsUsed: 1,
    sendOutcome: "sent",
  };
}

function setPhase(account: ReturnType<typeof useAccountStore>, phase: string | null): void {
  account.$patch((state) => {
    state.state = {
      ...state.state,
      ...(phase === null ? { auth: undefined } : { auth: attempt(phase) as never }),
    };
  });
}

describe("useSignInNotice", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.restoreAllMocks();
  });

  it("raises one persistent toast when the desktop starts waiting and the panel is elsewhere", async () => {
    const account = useAccountStore();
    const notifications = useNotificationStore();
    const wrapper = mount(Host);

    setPhase(account, "awaiting-link");
    await wrapper.vm.$nextTick();
    // Nothing yet: waiting for somebody to OPEN the link is not waiting on this desktop, and a toast
    // here would fire on every sign-in the moment it started.
    expect(notifications.persistentToasts).toHaveLength(0);

    setPhase(account, "awaiting-confirmation");
    await wrapper.vm.$nextTick();
    expect(notifications.persistentToasts).toHaveLength(1);
    expect(notifications.persistentToasts[0]?.title).toContain("Finish signing in");
    expect(notifications.persistentToasts[0]?.body).toContain("Settings");

    // The address is the customer's own and this renders over whatever they are sharing.
    expect(notifications.persistentToasts[0]?.body).not.toContain("owner@example.test");
    wrapper.unmount();
  });

  it("says nothing to somebody who is already looking at the confirm button", async () => {
    const account = useAccountStore();
    const notifications = useNotificationStore();
    account.setSignInPanelMounted(true);
    const wrapper = mount(Host);

    setPhase(account, "awaiting-confirmation");
    await wrapper.vm.$nextTick();
    expect(notifications.persistentToasts).toHaveLength(0);

    // And it appears the moment they navigate away with the confirmation still outstanding — the
    // ordinary "clicked the link, glanced at the desktop, went back to work" case.
    account.setSignInPanelMounted(false);
    await wrapper.vm.$nextTick();
    expect(notifications.persistentToasts).toHaveLength(1);
    wrapper.unmount();
  });

  it("takes the toast away again when the flow stops waiting, however it stopped", async () => {
    for (const ending of ["verifying", null] as const) {
      setActivePinia(createPinia());
      const account = useAccountStore();
      const notifications = useNotificationStore();
      const wrapper = mount(Host);

      setPhase(account, "awaiting-confirmation");
      await wrapper.vm.$nextTick();
      expect(notifications.persistentToasts).toHaveLength(1);

      // `verifying` is a confirm that has been pressed; `null` is a cancel, an expiry or a new
      // attempt superseding this one. A toast that outlived any of them would point at a button that
      // is no longer there.
      setPhase(account, ending);
      await wrapper.vm.$nextTick();
      expect(notifications.persistentToasts).toHaveLength(0);
      wrapper.unmount();
    }
  });

  it("does not stack a second toast while the first is still standing", async () => {
    const account = useAccountStore();
    const notifications = useNotificationStore();
    const wrapper = mount(Host);

    setPhase(account, "awaiting-confirmation");
    await wrapper.vm.$nextTick();
    // A re-broadcast of the same state — the backend publishes on every mutation — must not be read
    // as a new event.
    account.setSignInPanelMounted(false);
    setPhase(account, "awaiting-confirmation");
    await wrapper.vm.$nextTick();
    expect(notifications.persistentToasts).toHaveLength(1);
    wrapper.unmount();
  });

  it("opens Mobile Account directly when the sign-in notice is clicked", async () => {
    const account = useAccountStore();
    const openSettings = vi.spyOn(useAppStore(), "openSettingsDialog").mockImplementation(() => {});
    const host = mount(Host);
    const stack = mount(PersistentToastStack);

    setPhase(account, "awaiting-confirmation");
    await host.vm.$nextTick();
    await stack.vm.$nextTick();
    await stack.find(".persistent-toast__target").trigger("click");

    expect(openSettings).toHaveBeenCalledWith({ initialTab: "mobile", initialMobileView: "account" });
    stack.unmount();
    host.unmount();
  });
});
