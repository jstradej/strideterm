import { describe, it, expect, beforeEach, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { nextTick } from "vue";
import MobileConnectedIndicator from "./MobileConnectedIndicator.vue";
import { useAppStore } from "../../stores/app.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyApi = any;

const SELECTOR = '[data-role="mobile-connected-indicator"]';

function device(deviceId: string, name: string, profileId = "default", startedAt = Date.now() - 60_000) {
  return { deviceId, name, profileId, startedAt };
}

describe("MobileConnectedIndicator", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    (window as AnyApi).strideterm = { startupFlags: { windowId: "win-test" } };
    useAppStore().payload = {
      appState: {
        profiles: [
          { id: "default", name: "Default" },
          { id: "work", name: "Work" },
        ],
        workspaces: [],
        windowSlots: [],
        settings: {},
      },
    } as AnyApi;
  });

  it("renders nothing while no phone is connected", () => {
    const wrapper = mount(MobileConnectedIndicator);
    expect(wrapper.find(SELECTOR).exists()).toBe(false);
  });

  it("appears with one phone, without a count badge, and names it for assistive tech", async () => {
    const store = useAppStore();
    const wrapper = mount(MobileConnectedIndicator);

    store.mobileConnectedDevices = [device("d1", "Pixel 8")];
    await nextTick();

    const button = wrapper.get(SELECTOR);
    expect(button.find(".mobile-connected-indicator__count").exists()).toBe(false);
    expect(button.attributes("aria-label")).toBe("1 phone connected: Pixel 8");
  });

  it("shows a count badge with two phones and lists each one in the tooltip with its profile", () => {
    const store = useAppStore();
    store.mobileConnectedDevices = [device("d1", "Pixel 8"), device("d2", "iPhone 15", "work")];
    const wrapper = mount(MobileConnectedIndicator);

    const button = wrapper.get(SELECTOR);
    expect(button.get(".mobile-connected-indicator__count").text()).toBe("2");
    const lines = button.attributes("title")!.split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^Pixel 8 · Default · since /);
    expect(lines[1]).toMatch(/^iPhone 15 · Work · since /);
    expect(button.attributes("aria-label")).toBe("2 phones connected: Pixel 8, iPhone 15");
  });

  it("falls back to the profile id when the profile is unknown, and disappears when the last phone leaves", async () => {
    const store = useAppStore();
    store.mobileConnectedDevices = [device("d1", "Pixel 8", "gone")];
    const wrapper = mount(MobileConnectedIndicator);
    expect(wrapper.get(SELECTOR).attributes("title")).toContain("Pixel 8 · gone · since ");

    store.mobileConnectedDevices = [];
    await nextTick();
    expect(wrapper.find(SELECTOR).exists()).toBe(false);
  });

  it("opens Settings, Mobile, Phones when clicked", async () => {
    const store = useAppStore();
    const open = vi.spyOn(store, "openSettingsDialog").mockImplementation(() => undefined as AnyApi);
    store.mobileConnectedDevices = [device("d1", "Pixel 8")];
    const wrapper = mount(MobileConnectedIndicator);

    await wrapper.get(SELECTOR).trigger("click");
    expect(open).toHaveBeenCalledWith({ initialTab: "mobile", initialMobileView: "phones" });
  });
});
