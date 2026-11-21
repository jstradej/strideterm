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
import PeerHostingPanel from "../peers/PeerHostingPanel.vue";
import { useNotificationStore } from "../../stores/notifications.js";

type MobileConnectionPanelProps = { visible?: boolean; initialView?: string };

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

  store.mobilePairingSas = { deviceId: "phone-1", label: "Phone" };
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

describe("RemoteAccessDialog — network access (opt-in loopback bind)", () => {
  async function openLan(provide: Record<string, unknown> = {}, remoteAccess: Record<string, unknown> = {}) {
    const store = useAppStore();
    store.payload = {
      appState: { settings: { remoteAccess: { enabled: true, host: "0.0.0.0", port: 43123, ...remoteAccess } } },
      remoteAccess: { enabled: true, host: "0.0.0.0", port: 43123, urls: [], tunnel: {} },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
    const updateSettings = vi.spyOn(store, "updateSettings").mockResolvedValue(undefined as never);
    const wrapper = mount(RemoteAccessDialog, { global: { provide: { [apiKey]: provide } } });
    const lan = wrapper.findAll(".remote-mode-tab").find((b) => b.text() === "LAN");
    await lan!.trigger("click");
    return { wrapper, updateSettings };
  }

  test("is checked by default and says the traffic is not encrypted", async () => {
    const { wrapper } = await openLan();
    const box = wrapper.find('[data-testid="network-access"]');
    expect((box.element as HTMLInputElement).checked).toBe(true);
    expect((box.element as HTMLInputElement).disabled).toBe(false);
    expect(wrapper.text()).toContain("Allow access from other devices on the network (LAN, VPN, Tailscale)");
    expect(wrapper.find('[data-testid="network-access-note"]').text()).toContain("not encrypted");
  });

  test("unticking writes networkAccess: false through the desktop settings path", async () => {
    const { wrapper, updateSettings } = await openLan();
    const box = wrapper.find('[data-testid="network-access"]');
    (box.element as HTMLInputElement).checked = false;
    await box.trigger("change");
    expect(updateSettings).toHaveBeenCalledWith({ remoteAccess: { networkAccess: false } });
  });

  test("a stored false renders unticked", async () => {
    const { wrapper } = await openLan({}, { networkAccess: false });
    expect((wrapper.find('[data-testid="network-access"]').element as HTMLInputElement).checked).toBe(false);
  });

  test("a remote client sees the box disabled with a desktop-only hint, and cannot write it", async () => {
    const { wrapper, updateSettings } = await openLan({ isRemote: true });
    const box = wrapper.find('[data-testid="network-access"]');
    expect((box.element as HTMLInputElement).disabled).toBe(true);
    expect(wrapper.find('[data-testid="network-access-note"]').text()).toContain("Desktop only");
    await box.trigger("change");
    expect(updateSettings).not.toHaveBeenCalled();
  });
});

describe("RemoteAccessDialog — quick tunnel note", () => {
  test("the note renders and the tunnel can still be created as before", async () => {
    const store = useAppStore();
    store.payload = {
      appState: { settings: { remoteAccess: { enabled: true, host: "0.0.0.0", port: 43123 } } },
      remoteAccess: { enabled: true, host: "0.0.0.0", port: 43123, urls: [], tunnel: { available: true } },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
    const create = vi.spyOn(store, "createCloudflareTunnel").mockResolvedValue(undefined as never);
    const wrapper = mount(RemoteAccessDialog, { global: { provide: { [apiKey]: {} } } });
    await wrapper
      .findAll(".remote-mode-tab")
      .find((b) => b.text() === "Cloudflare")!
      .trigger("click");
    const note = wrapper.find('[data-testid="quick-tunnel-note"]');
    expect(note.text()).toContain("trycloudflare.com");
    expect(note.text()).toContain("the managed relay is an alternative");
    const button = wrapper.findAll("button").find((b) => b.text() === "Create tunnel")!;
    expect(button.attributes("disabled")).toBeUndefined();
    await button.trigger("click");
    await flushPromises();
    expect(create).toHaveBeenCalled();
  });
});

describe("RemoteAccessDialog — secure storage warning", () => {
  async function mountLan(secureStorage?: { available: boolean }) {
    const store = useAppStore();
    store.payload = {
      appState: { settings: { remoteAccess: { enabled: true, host: "0.0.0.0", port: 43123 } } },
      remoteAccess: { enabled: true, host: "0.0.0.0", port: 43123, urls: [] },
      ...(secureStorage ? { secureStorage } : {}),
    } as unknown as NonNullable<typeof store.payload>;
    const wrapper = mount(RemoteAccessDialog, { global: { stubs: { MobileConnectionPanel: true } } });
    await wrapper
      .findAll(".remote-mode-tab")
      .find((b) => b.text() === "LAN")!
      .trigger("click");
    return wrapper;
  }

  test("is shown above the access token when the OS has no secure storage", async () => {
    const wrapper = await mountLan({ available: false });
    const warning = wrapper.find(".remote-access__footer .remote-access__secure-warning");
    expect(warning.exists()).toBe(true);
    expect(warning.attributes("role")).toBe("alert");
    expect(warning.text()).toContain("Credentials are stored without OS encryption.");
    wrapper.unmount();
  });

  test.each([
    ["available", { available: true }],
    ["absent", undefined],
  ])("is hidden when secure storage is %s", async (_label, secureStorage) => {
    const wrapper = await mountLan(secureStorage);
    expect(wrapper.find(".remote-access__footer").exists()).toBe(true);
    expect(wrapper.find(".remote-access__secure-warning").exists()).toBe(false);
    wrapper.unmount();
  });
});

describe("RemoteAccessDialog — Desktops tab", () => {
  const hostApi = { getPeerHostState: vi.fn().mockResolvedValue(null) };

  test("exists when the transport can host peers and does not depend on browser sharing", async () => {
    const wrapper = mount(RemoteAccessDialog, {
      global: { provide: { [apiKey]: hostApi }, stubs: { MobileConnectionPanel: true, PeerHostingPanel: true } },
    });
    const tab = wrapper.findAll(".remote-mode-tab").find((b) => b.text() === "Desktops");
    expect(tab).toBeTruthy();
    await tab!.trigger("click");
    expect(wrapper.findComponent(PeerHostingPanel).exists()).toBe(true);
    expect(wrapper.find(".remote-access__hero").exists()).toBe(false);
    expect(wrapper.find(".remote-card--disabled").exists()).toBe(false);
    expect(wrapper.text()).not.toContain("Enable browser sharing");
    wrapper.unmount();
  });

  test("is absent without the host methods", () => {
    const wrapper = mount(RemoteAccessDialog, {
      global: { provide: { [apiKey]: {} }, stubs: { MobileConnectionPanel: true } },
    });
    expect(wrapper.findAll(".remote-mode-tab").map((b) => b.text())).not.toContain("Desktops");
    wrapper.unmount();
  });

  test("is absent on a remote client", () => {
    const wrapper = mount(RemoteAccessDialog, { global: { provide: { [apiKey]: { isRemote: true } } } });
    expect(wrapper.findAll(".remote-mode-tab").map((b) => b.text())).not.toContain("Desktops");
    wrapper.unmount();
  });
});

describe("RemoteAccessDialog — browser sessions", () => {
  const session = {
    sessionRef: "a".repeat(64),
    origin: "token",
    remoteAddress: "192.0.2.10",
    createdAt: 100,
    lastSeenAt: 200,
    expiresAt: 1000,
    idleExpiresAt: 800,
  };

  function mountSessions(
    options: {
      remoteAccess?: Record<string, unknown>;
      api?: Record<string, unknown>;
      props?: Record<string, unknown>;
    } = {},
  ) {
    const store = useAppStore();
    store.payload = {
      appState: { settings: { remoteAccess: { enabled: true, ...options.remoteAccess } } },
      remoteAccess: { enabled: true, urls: [], tunnel: {} },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
    const listRemoteSessions = vi.fn(async () => [session]);
    const revokeRemoteSessions = vi.fn(async () => ({ revoked: 1 }));
    const updateSettings = vi.spyOn(store, "updateSettings").mockResolvedValue(undefined as never);
    const wrapper = mount(RemoteAccessDialog, {
      props: options.props,
      global: {
        provide: { [apiKey]: { listRemoteSessions, revokeRemoteSessions, ...options.api } },
        stubs: { MobileConnectionPanel: true },
      },
    });
    return { wrapper, store, listRemoteSessions, revokeRemoteSessions, updateSettings };
  }

  async function openMode(wrapper: VueWrapper, label: string) {
    await wrapper
      .findAll(".remote-mode-tab")
      .find((b) => b.text() === label)!
      .trigger("click");
    await flushPromises();
  }

  test("is shown in LAN, Cloudflare and VPS, not in Mobile or Desktops", async () => {
    const { wrapper } = mountSessions({ api: { getPeerHostState: vi.fn().mockResolvedValue(null) } });
    await flushPromises();
    expect(wrapper.find('[data-testid="remote-sessions"]').exists()).toBe(false);
    for (const label of ["LAN", "Cloudflare", "VPS / Custom"]) {
      await openMode(wrapper, label);
      expect(wrapper.find('[data-testid="remote-sessions"]').exists()).toBe(true);
    }
    await openMode(wrapper, "Desktops");
    expect(wrapper.find('[data-testid="remote-sessions"]').exists()).toBe(false);
    wrapper.unmount();
  });

  test("needs listRemoteSessions and never renders on a remote client", async () => {
    const withoutList = mountSessions({ api: { listRemoteSessions: undefined } });
    await openMode(withoutList.wrapper, "LAN");
    expect(withoutList.wrapper.find('[data-testid="remote-sessions"]').exists()).toBe(false);
    withoutList.wrapper.unmount();

    const remote = mountSessions({ api: { isRemote: true } });
    await flushPromises();
    expect(remote.wrapper.find('[data-testid="remote-sessions"]').exists()).toBe(false);
    expect(remote.listRemoteSessions).not.toHaveBeenCalled();
    remote.wrapper.unmount();
  });

  test("is collapsed with a count, loads and revokes without rendering the session reference", async () => {
    const { wrapper, listRemoteSessions, revokeRemoteSessions } = mountSessions();
    await openMode(wrapper, "LAN");
    expect(listRemoteSessions).toHaveBeenCalled();
    const toggle = wrapper.get('[data-testid="remote-sessions-toggle"]');
    expect(toggle.text()).toBe("Active browser sessions (1)");
    expect(toggle.attributes("aria-expanded")).toBe("false");
    expect(wrapper.text()).not.toContain("192.0.2.10");
    await toggle.trigger("click");
    expect(wrapper.text()).toContain("192.0.2.10");
    expect(wrapper.text()).not.toContain(session.sessionRef);
    await wrapper
      .findAll("button")
      .find((b) => b.text() === "Sign out")!
      .trigger("click");
    await flushPromises();
    expect(revokeRemoteSessions).toHaveBeenCalledWith({ sessionRef: session.sessionRef });
    wrapper.unmount();
  });

  test("a session can be signed out while everything is paused", async () => {
    const { wrapper, revokeRemoteSessions } = mountSessions({ remoteAccess: { paused: true } });
    await openMode(wrapper, "LAN");
    const section = wrapper.get('[data-testid="remote-sessions"]');
    expect(section.element.closest("fieldset")).toBeNull();
    expect(wrapper.get(".remote-access__legacy").attributes("disabled")).toBeDefined();
    await wrapper.get('[data-testid="remote-sessions-toggle"]').trigger("click");
    const signOutAll = wrapper.findAll("button").find((b) => b.text() === "Sign out all")!;
    expect(signOutAll.attributes("disabled")).toBeUndefined();
    await signOutAll.trigger("click");
    await flushPromises();
    expect(revokeRemoteSessions).toHaveBeenCalledWith({ all: true });
    wrapper.unmount();
  });

  test("session length validates, applies only on Apply, and shows a failure in the dialog", async () => {
    const { wrapper, updateSettings } = mountSessions({ props: { focusSessions: true } });
    await openMode(wrapper, "LAN");
    const [idle, absolute] = wrapper.findAll(".remote-sessions__body input");
    const apply = () => wrapper.get('[data-testid="session-ttl-apply"]');
    expect(apply().attributes("disabled")).toBeDefined();

    await idle.setValue(600);
    await absolute.setValue(500);
    expect(wrapper.text()).toContain("Idle timeout cannot exceed the absolute lifetime.");
    expect(apply().attributes("disabled")).toBeDefined();
    await idle.setValue(10);
    await absolute.setValue(1000);
    expect(wrapper.text()).toContain("Idle timeout must be between 15 and 43,200 minutes.");
    await idle.setValue(600);
    await absolute.setValue(200000);
    expect(wrapper.text()).toContain("Absolute lifetime must be between 60 and 129,600 minutes.");
    expect(updateSettings).not.toHaveBeenCalled();

    await absolute.setValue(1000);
    expect(apply().attributes("disabled")).toBeUndefined();
    await apply().trigger("click");
    await flushPromises();
    expect(updateSettings).toHaveBeenCalledWith({
      remoteAccess: { sessionIdleTtlMinutes: 600, sessionAbsoluteTtlMinutes: 1000 },
    });

    updateSettings.mockRejectedValueOnce(new Error("Disk full"));
    await apply().trigger("click");
    await flushPromises();
    expect(wrapper.text()).toContain("Disk full");
    wrapper.unmount();
  });

  test("initialMode, initialMobileView and focusSessions are honoured", async () => {
    const mobile = mountSessions({ props: { initialMode: "mobile", initialMobileView: "account" } });
    const panel = mobile.wrapper.findComponent(MobileConnectionPanel) as VueWrapper<
      unknown,
      ComponentPublicInstance<MobileConnectionPanelProps>
    >;
    expect(panel.props("initialView")).toBe("account");
    mobile.wrapper.unmount();

    const cloudflare = mountSessions({ props: { initialMode: "cloudflare" } });
    expect(cloudflare.wrapper.find(".remote-mode-tab--active").text()).toBe("Cloudflare");
    expect(cloudflare.store.remoteAccessMode).toBe("cloudflare");
    cloudflare.wrapper.unmount();

    const focus = mountSessions({ props: { focusSessions: true } });
    await flushPromises();
    expect(["LAN", "Cloudflare", "VPS / Custom"]).toContain(focus.wrapper.find(".remote-mode-tab--active").text());
    expect(focus.wrapper.get('[data-testid="remote-sessions-toggle"]').attributes("aria-expanded")).toBe("true");
    focus.wrapper.unmount();

    const unavailable = mountSessions({ props: { initialMode: "desktops" } });
    expect(unavailable.wrapper.find(".remote-mode-tab--active").text()).toBe("Mobile");
    unavailable.wrapper.unmount();
  });
});
