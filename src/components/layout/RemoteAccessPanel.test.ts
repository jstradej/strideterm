import { enableAutoUnmount, mount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import RemoteAccessPanel from "./RemoteAccessPanel.vue";
import { MOBILE_TRIAL_WARNING_WINDOW_MS } from "../../lib/mobile-access-warning.js";

const mocks = vi.hoisted(() => ({
  openSettingsDialog: vi.fn(),
  openRemoteAccessDialog: vi.fn(),
  copyText: vi.fn(),
  pairAuthorization: "denied" as string,
  entitlement: { state: "active", source: "subscription" } as { state: string; source: string; notAfter?: number },
}));

enableAutoUnmount(afterEach);

vi.mock("../../stores/app.js", () => ({
  useAppStore: () => ({
    mobileEnabled: true,
    mobileDevices: [],
    mobileConnectionHealth: { running: true, pairAuthorization: mocks.pairAuthorization },
    openSettingsDialog: mocks.openSettingsDialog,
    openRemoteAccessDialog: mocks.openRemoteAccessDialog,
    copyText: mocks.copyText,
  }),
}));

vi.mock("../../stores/account.js", () => ({
  useAccountStore: () => ({ overview: { entitlement: mocks.entitlement } }),
}));

vi.mock("../../composables/useRemoteConnection.js", async () => {
  const { ref } = await import("vue");
  return {
    useRemoteConnection: () => ({
      remoteConfig: ref({ enabled: true }),
      runtimeRemote: ref(null),
      tunnel: ref(null),
      activeShareUrl: ref("https://share.example.test"),
      hasPublicUrl: ref(true),
      hasAnyUrl: ref(true),
      activeError: ref(false),
    }),
  };
});

vi.mock("../../composables/useQrCode.js", async () => {
  const { ref } = await import("vue");
  return { useQrCode: () => ({ qrDataUrl: ref(null) }) };
});

describe("RemoteAccessPanel", () => {
  beforeEach(() => {
    mocks.openSettingsDialog.mockReset();
    mocks.openRemoteAccessDialog.mockReset();
    mocks.pairAuthorization = "denied";
    mocks.entitlement = { state: "active", source: "subscription" };
  });

  test("keeps browser sharing status while offering an actionable mobile warning", async () => {
    const wrapper = mount(RemoteAccessPanel);
    const warning = wrapper.find(".remote-pill--mobile-warning");

    expect(wrapper.find(".remote-pill--ok").text()).toBe("public");
    expect(warning.text()).toBe("Mobile access needs attention");
    await warning.trigger("click");
    expect(mocks.openSettingsDialog).toHaveBeenCalledWith({ initialTab: "mobile", initialMobileView: "overview" });
  });

  test("expired trial points directly to Account settings", async () => {
    mocks.entitlement = { state: "trial", source: "trial", notAfter: Date.now() - 1 };
    const wrapper = mount(RemoteAccessPanel);
    const warning = wrapper.find(".remote-pill--mobile-warning");

    expect(warning.text()).toBe("Mobile trial ended");
    expect(warning.classes()).toContain("remote-pill--mobile-warning-expired");
    await warning.trigger("click");
    expect(mocks.openSettingsDialog).toHaveBeenCalledWith({ initialTab: "mobile", initialMobileView: "account" });
  });

  test("upcoming trial expiration is orange and opens Account settings", async () => {
    vi.useFakeTimers();
    mocks.pairAuthorization = "ok";
    mocks.entitlement = {
      state: "trial",
      source: "trial",
      notAfter: Date.now() + MOBILE_TRIAL_WARNING_WINDOW_MS,
    };
    const wrapper = mount(RemoteAccessPanel);
    try {
      const warning = wrapper.find(".remote-pill--mobile-warning");
      expect(warning.text()).toBe("Mobile trial ends soon");
      expect(warning.classes()).toContain("remote-pill--mobile-warning-expiring");
      expect(warning.attributes("title")).toContain("The free mobile trial ends");
      await warning.trigger("click");
      expect(mocks.openSettingsDialog).toHaveBeenCalledWith({ initialTab: "mobile", initialMobileView: "account" });
    } finally {
      wrapper.unmount();
      vi.useRealTimers();
    }
  });

  test("shows the expiry warning when the authoritative deadline passes while mounted", async () => {
    vi.useFakeTimers();
    mocks.pairAuthorization = "ok";
    mocks.entitlement = {
      state: "trial",
      source: "trial",
      notAfter: Date.now() + MOBILE_TRIAL_WARNING_WINDOW_MS + 1_000,
    };
    const wrapper = mount(RemoteAccessPanel);
    try {
      expect(wrapper.find(".remote-pill--mobile-warning").exists()).toBe(false);
      await vi.advanceTimersByTimeAsync(1_001);
      expect(wrapper.find(".remote-pill--mobile-warning").text()).toBe("Mobile trial ends soon");
      await vi.advanceTimersByTimeAsync(MOBILE_TRIAL_WARNING_WINDOW_MS);
      expect(wrapper.find(".remote-pill--mobile-warning").text()).toBe("Mobile trial ended");
    } finally {
      wrapper.unmount();
      vi.useRealTimers();
    }
  });

  test("re-arms the expiry clock for deadlines beyond the platform timer limit", async () => {
    vi.useFakeTimers();
    mocks.pairAuthorization = "ok";
    mocks.entitlement = {
      state: "trial",
      source: "trial",
      notAfter: Date.now() + 2_147_483_647 + 5_000 + MOBILE_TRIAL_WARNING_WINDOW_MS,
    };
    const wrapper = mount(RemoteAccessPanel);
    try {
      expect(wrapper.find(".remote-pill--mobile-warning").exists()).toBe(false);
      await vi.advanceTimersByTimeAsync(2_147_483_647);
      expect(wrapper.find(".remote-pill--mobile-warning").exists()).toBe(false);
      await vi.advanceTimersByTimeAsync(5_001);
      expect(wrapper.find(".remote-pill--mobile-warning").text()).toBe("Mobile trial ends soon");
      await vi.advanceTimersByTimeAsync(MOBILE_TRIAL_WARNING_WINDOW_MS);
      expect(wrapper.find(".remote-pill--mobile-warning").text()).toBe("Mobile trial ended");
    } finally {
      wrapper.unmount();
      vi.useRealTimers();
    }
  });
});
