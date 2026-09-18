/**
 * Regression coverage: RemoteAccessDialog's browseCloudflared used to call
 * api.browseFile directly inside a click handler with no try/catch. A
 * rejected picker promise was an unhandled rejection with no user feedback.
 * It now goes through pickPath(), which surfaces an error toast.
 */
import { describe, expect, test, beforeEach, vi } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import type { VueWrapper } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import type { ComponentPublicInstance } from "vue";
import RemoteAccessDialog from "./RemoteAccessDialog.vue";
import { apiKey } from "../../types/keys.js";
import { useAppStore } from "../../stores/app.js";
import MobileConnectionPanel from "./settings/MobileConnectionPanel.vue";
import { useNotificationStore } from "../../stores/notifications.js";

type MobileConnectionPanelProps = { visible?: boolean };

beforeEach(() => {
  setActivePinia(createPinia());
});

describe("RemoteAccessDialog — browseCloudflared", () => {
  test("a rejecting browseFile shows an error notification instead of throwing", async () => {
    const browseFile = vi.fn().mockRejectedValueOnce(new Error("picker crashed"));
    const wrapper = mount(RemoteAccessDialog, {
      global: { provide: { [apiKey]: { browseFile } } },
    });

    await wrapper
      .findAll(".remote-mode-tab")
      .find((b) => b.text() === "Cloudflare")!
      .trigger("click");
    const browseBtn = wrapper.findAll("button").find((b) => b.text() === "Browse")!;
    await browseBtn.trigger("click");
    await flushPromises();

    expect(browseFile).toHaveBeenCalled();
    const notifications = useNotificationStore();
    expect(notifications.sessions).toHaveLength(1);
    expect(notifications.sessions[0].events[0].title).toBe("Failed to open picker");
  });
});

test("Mobile is the first and default tab, reusing the settings panel", async () => {
  const wrapper = mount(RemoteAccessDialog);
  expect(wrapper.findAll(".remote-mode-tab")[0].text()).toBe("Mobile");
  expect(wrapper.find(".remote-mode-tab--active").text()).toBe("Mobile");
  expect(wrapper.findComponent(MobileConnectionPanel).exists()).toBe(true);
  const mobilePanel = wrapper.findComponent(MobileConnectionPanel) as VueWrapper<
    unknown,
    ComponentPublicInstance<MobileConnectionPanelProps>
  >;
  expect(mobilePanel.props("visible")).toBe(true);
  expect(wrapper.find(".remote-access__hero").exists()).toBe(false);
  expect(wrapper.find(".remote-access__footer").exists()).toBe(false);
  await wrapper
    .findAll(".remote-mode-tab")
    .find((b) => b.text() === "LAN")!
    .trigger("click");
  expect(wrapper.find(".remote-access__hero").exists()).toBe(true);
  expect(wrapper.findComponent(MobileConnectionPanel).exists()).toBe(true);
  expect(mobilePanel.props("visible")).toBe(false);
  wrapper.unmount();
});

test("a new pairing confirmation brings the preserved Mobile panel back into view", async () => {
  const store = useAppStore();
  const wrapper = mount(RemoteAccessDialog, { global: { stubs: { MobileConnectionPanel: true } } });
  await wrapper
    .findAll(".remote-mode-tab")
    .find((button) => button.text() === "LAN")!
    .trigger("click");

  store.mobilePairingSas = { deviceId: "phone-1", label: "Phone", sas: "1234 5678" };
  await flushPromises();

  expect(wrapper.find(".remote-mode-tab--active").text()).toBe("Mobile");
  wrapper.unmount();
});

test("remote clients are not offered desktop mobile pairing", () => {
  const wrapper = mount(RemoteAccessDialog, { global: { provide: { [apiKey]: { isRemote: true } } } });
  expect(wrapper.findComponent(MobileConnectionPanel).exists()).toBe(false);
  expect(wrapper.findAll(".remote-mode-tab").map((b) => b.text())).not.toContain("Mobile");
  wrapper.unmount();
});

test("pause writes only the pause flag and surfaces errors without changing configuration", async () => {
  const store = useAppStore();
  const update = vi.spyOn(store, "updateSettings").mockRejectedValue(new Error("Pause failed"));
  store.payload = {
    appState: {
      settings: { remoteAccess: { enabled: true }, integrations: { mobile: { enabled: true, devices: [] } } },
    },
  } as unknown as NonNullable<typeof store.payload>;
  const wrapper = mount(RemoteAccessDialog, { global: { stubs: { MobileConnectionPanel: true } } });
  await wrapper
    .findAll("button")
    .find((b) => b.text() === "Pause all connections")!
    .trigger("click");
  await flushPromises();
  expect(update).toHaveBeenCalledWith({ remoteAccess: { paused: true } });
  expect(wrapper.text()).toContain("Pause failed");
  expect(store.payload?.appState.settings.remoteAccess.enabled).toBe(true);
  wrapper.unmount();
});
