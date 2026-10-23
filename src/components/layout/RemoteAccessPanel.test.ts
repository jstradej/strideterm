import { enableAutoUnmount, mount } from "@vue/test-utils";
import { nextTick } from "vue";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import RemoteAccessPanel from "./RemoteAccessPanel.vue";
import { MOBILE_TRIAL_WARNING_WINDOW_MS } from "../../lib/mobile-access-warning.js";

const mocks = vi.hoisted(() => ({
  openSettingsDialog: vi.fn(),
  openRemoteAccessDialog: vi.fn(),
  copyText: vi.fn(),
  pairAuthorization: "denied" as string,
  entitlement: { state: "active", source: "subscription" } as {
    state: string;
    source: string;
    notAfter?: number;
    renewalAt?: number;
    cancellationAt?: number;
  },
  overviewEntitlement: null as {
    state: string;
    source: string;
    notAfter?: number;
    renewalAt?: number;
    cancellationAt?: number;
  } | null,
  updateAccountState: null as
    | ((
        entitlement: { state: string; source: string; notAfter?: number; renewalAt?: number; cancellationAt?: number },
        overviewEntitlement: {
          state: string;
          source: string;
          notAfter?: number;
          renewalAt?: number;
          cancellationAt?: number;
        } | null,
      ) => void)
    | null,
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

vi.mock("../../stores/account.js", async () => {
  const { ref } = await import("vue");
  const entitlement = ref(mocks.entitlement);
  const overviewEntitlement = ref(mocks.overviewEntitlement);
  mocks.updateAccountState = (nextEntitlement, nextOverviewEntitlement) => {
    entitlement.value = nextEntitlement;
    overviewEntitlement.value = nextOverviewEntitlement;
  };
  return {
    useAccountStore: () => {
      entitlement.value = mocks.entitlement;
      overviewEntitlement.value = mocks.overviewEntitlement;
      return {
        get entitlement() {
          return entitlement.value;
        },
        get overview() {
          return overviewEntitlement.value ? { entitlement: overviewEntitlement.value } : null;
        },
      };
    },
  };
});

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
    mocks.overviewEntitlement = null;
  });

  test("keeps browser sharing status while offering an actionable mobile warning", async () => {
    const wrapper = mount(RemoteAccessPanel);
    const warning = wrapper.find(".remote-pill--mobile-warning");

    expect(wrapper.find(".remote-pill--ok").text()).toBe("public");
    expect(warning.text()).toBe("Mobile · Attention");
    await warning.trigger("click");
    expect(mocks.openSettingsDialog).toHaveBeenCalledWith({ initialTab: "mobile", initialMobileView: "overview" });
  });

  test("expired trial points directly to Account settings", async () => {
    mocks.entitlement = { state: "trial", source: "trial", notAfter: Date.now() - 1 };
    const wrapper = mount(RemoteAccessPanel);
    const warning = wrapper.find(".remote-pill--mobile-warning");

    expect(warning.text()).toBe("Mobile · Ended");
    expect(warning.classes()).toContain("remote-pill--mobile-warning-expired");
    expect(warning.attributes("aria-label")).toContain("The free mobile trial ended");
    await warning.trigger("click");
    expect(mocks.openSettingsDialog).toHaveBeenCalledWith({ initialTab: "mobile", initialMobileView: "account" });
  });

  test("uses the canonical entitlement when the overview summary is missing", async () => {
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
      expect(wrapper.find(".remote-pill--mobile-warning").text()).toMatch(/\d+h \d+m left/);
    } finally {
      wrapper.unmount();
      vi.useRealTimers();
    }
  });

  test("canonical trial without source schedules its expiry warning", async () => {
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
      expect(wrapper.find(".remote-pill--mobile-warning").text()).toMatch(/\d+h \d+m left/);
      await vi.advanceTimersByTimeAsync(MOBILE_TRIAL_WARNING_WINDOW_MS);
      expect(wrapper.find(".remote-pill--mobile-warning").text()).toBe("Mobile · Ended");
    } finally {
      wrapper.unmount();
      vi.useRealTimers();
    }
  });

  test("prefers canonical trial state when the overview entitlement is stale", () => {
    mocks.entitlement = { state: "trial", source: "trial", notAfter: Date.now() - 1 };
    mocks.overviewEntitlement = { state: "active", source: "subscription" };
    const wrapper = mount(RemoteAccessPanel);

    expect(wrapper.find(".remote-pill--mobile-warning-expired").text()).toBe("Mobile · Ended");
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
      expect(warning.text()).toMatch(/\d+h \d+m left/);
      expect(warning.classes()).toContain("remote-pill--mobile-warning-expiring");
      expect(warning.attributes("title")).toContain("The free mobile trial ends in");
      expect(warning.attributes("aria-label")).toBe(warning.attributes("title"));
      await warning.trigger("click");
      expect(mocks.openSettingsDialog).toHaveBeenCalledWith({ initialTab: "mobile", initialMobileView: "account" });
    } finally {
      wrapper.unmount();
      vi.useRealTimers();
    }
  });

  test("finite operator access is red in its final day and shows exact local expiry", async () => {
    vi.useFakeTimers();
    mocks.pairAuthorization = "ok";
    const notAfter = Date.now() + 23 * 60 * 60_000 + 40 * 60_000;
    mocks.entitlement = { state: "active", source: "operator", notAfter };
    const wrapper = mount(RemoteAccessPanel);

    try {
      const warning = wrapper.find(".remote-pill--mobile-warning");
      expect(warning.text()).toBe("23h 40m left");
      expect(warning.classes()).toContain("remote-pill--mobile-warning-critical");
      expect(warning.attributes("title")).toContain(
        new Date(notAfter).toLocaleString(undefined, {
          year: "numeric",
          month: "short",
          day: "numeric",
          hour: "numeric",
          minute: "2-digit",
          timeZoneName: "short",
        }),
      );
    } finally {
      wrapper.unmount();
      vi.useRealTimers();
    }
  });

  test("a server-lapsed finite grant stays ended when its reported deadline is in the future", () => {
    mocks.entitlement = { state: "lapsed", source: "operator", notAfter: Date.now() + 2 * 86_400_000 };
    const wrapper = mount(RemoteAccessPanel);
    const warning = wrapper.find(".remote-pill--mobile-warning");

    expect(warning.text()).toBe("Mobile · Ended");
    expect(warning.classes()).toContain("remote-pill--mobile-warning-expired");
    expect(warning.classes()).not.toContain("remote-pill--mobile-warning-pulse");
    expect(warning.attributes("title")).toContain("Mobile access ended");
  });

  test("warning pulse is brief and repeats after 15 minutes", async () => {
    vi.useFakeTimers();
    mocks.pairAuthorization = "ok";
    mocks.entitlement = { state: "trial", source: "trial", notAfter: Date.now() + 2 * 86_400_000 };
    const wrapper = mount(RemoteAccessPanel);

    try {
      const warning = wrapper.find(".remote-pill--mobile-warning");
      expect(warning.classes()).toContain("remote-pill--mobile-warning-pulse");
      await vi.advanceTimersByTimeAsync(1_200);
      expect(warning.classes()).not.toContain("remote-pill--mobile-warning-pulse");
      await vi.advanceTimersByTimeAsync(15 * 60_000 - 1_200);
      expect(warning.classes()).toContain("remote-pill--mobile-warning-pulse");
    } finally {
      wrapper.unmount();
      vi.useRealTimers();
    }
  });

  test("critical warning pulse is brief and repeats after one hour", async () => {
    vi.useFakeTimers();
    mocks.pairAuthorization = "ok";
    mocks.entitlement = { state: "trial", source: "trial", notAfter: Date.now() + 23 * 60 * 60_000 };
    const wrapper = mount(RemoteAccessPanel);

    try {
      const warning = wrapper.find(".remote-pill--mobile-warning");
      expect(warning.classes()).toContain("remote-pill--mobile-warning-critical");
      expect(warning.classes()).toContain("remote-pill--mobile-warning-pulse");
      await vi.advanceTimersByTimeAsync(1_200);
      expect(warning.classes()).not.toContain("remote-pill--mobile-warning-pulse");
      await vi.advanceTimersByTimeAsync(60 * 60_000 - 1_200);
      expect(warning.classes()).toContain("remote-pill--mobile-warning-pulse");
    } finally {
      wrapper.unmount();
      vi.useRealTimers();
    }
  });

  test("keeps an authorization denial as the warning reason but includes a finite deadline", () => {
    const notAfter = Date.now() + 23 * 60 * 60_000;
    mocks.entitlement = { state: "active", source: "incident", notAfter };
    const wrapper = mount(RemoteAccessPanel);
    const warning = wrapper.find(".remote-pill--mobile-warning");
    expect(warning.text()).toBe("23h 0m left");
    expect(warning.classes()).toContain("remote-pill--mobile-warning-critical");
    expect(warning.classes()).toContain("remote-pill--mobile-warning-pulse");
    expect(warning.attributes("title")).toContain("Mobile access ends in 23h 0m");
    expect(warning.attributes("aria-label")).toBe(warning.attributes("title"));
    expect(mocks.pairAuthorization).toBe("denied");
  });

  test("updates a distant denied-access countdown without pulsing outside the warning window", async () => {
    vi.useFakeTimers();
    mocks.pairAuthorization = "denied";
    mocks.entitlement = { state: "active", source: "operator", notAfter: Date.now() + 5 * 86_400_000 };
    const wrapper = mount(RemoteAccessPanel);

    try {
      const warning = wrapper.find(".remote-pill--mobile-warning");
      expect(warning.text()).toBe("120h 0m left");
      expect(warning.classes()).not.toContain("remote-pill--mobile-warning-pulse");
      await vi.advanceTimersByTimeAsync(60_000);
      await nextTick();
      expect(warning.text()).toBe("119h 59m left");
      expect(warning.classes()).not.toContain("remote-pill--mobile-warning-pulse");
    } finally {
      wrapper.unmount();
      vi.useRealTimers();
    }
  });

  test("shows the cancellation countdown from the global account update without opening Settings", async () => {
    mocks.pairAuthorization = "denied";
    mocks.entitlement = { state: "active", source: "subscription" };
    const wrapper = mount(RemoteAccessPanel);
    const warning = wrapper.find(".remote-pill--mobile-warning");

    expect(warning.text()).toBe("Mobile · Attention");
    const cancellationAt = Date.now() + 15 * 60 * 60_000 + 20 * 60_000;
    mocks.updateAccountState!(
      {
        state: "active",
        source: "subscription",
        renewalAt: cancellationAt + 30 * 86_400_000,
        cancellationAt,
        notAfter: cancellationAt + 3 * 86_400_000,
      },
      null,
    );
    await nextTick();

    expect(warning.text()).toBe("15h 20m left");
    expect(warning.attributes("title")).toContain("Mobile access ends in 15h 20m");
    expect(mocks.openSettingsDialog).not.toHaveBeenCalled();
  });

  test("stops the cancellation countdown at its deadline without claiming active access ended", async () => {
    vi.useFakeTimers();
    mocks.pairAuthorization = "denied";
    const cancellationAt = Date.now() + 1_000;
    mocks.entitlement = {
      state: "active",
      source: "subscription",
      cancellationAt,
      notAfter: cancellationAt + 3 * 86_400_000,
    };
    const wrapper = mount(RemoteAccessPanel);

    try {
      const warning = wrapper.find(".remote-pill--mobile-warning");
      expect(warning.text()).toBe("0h 1m left");
      await vi.advanceTimersByTimeAsync(1_001);
      await nextTick();
      expect(warning.text()).toBe("Mobile · Attention");
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
      expect(wrapper.find(".remote-pill--mobile-warning").text()).toMatch(/\d+h \d+m left/);
      await vi.advanceTimersByTimeAsync(MOBILE_TRIAL_WARNING_WINDOW_MS);
      expect(wrapper.find(".remote-pill--mobile-warning").text()).toBe("Mobile · Ended");
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
      expect(wrapper.find(".remote-pill--mobile-warning").text()).toMatch(/\d+h \d+m left/);
      await vi.advanceTimersByTimeAsync(MOBILE_TRIAL_WARNING_WINDOW_MS);
      expect(wrapper.find(".remote-pill--mobile-warning").text()).toBe("Mobile · Ended");
    } finally {
      wrapper.unmount();
      vi.useRealTimers();
    }
  });
});
