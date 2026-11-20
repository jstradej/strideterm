import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import PeerHostFailure from "./PeerHostFailure.vue";
import BootstrapError from "../layout/BootstrapError.vue";
import { useAppStore } from "../../stores/app.js";
import { useNotificationStore } from "../../stores/notifications.js";
import { peerFailureFrom, type PeerFailure } from "../../peer-link.js";
import { setWindowBackend } from "../../window-backend.js";
import type { LocalProfileOverview, WindowBackend } from "../../../electron/shared/peers.js";

const backend: Extract<WindowBackend, { kind: "peer" }> = {
  kind: "peer",
  hostId: "host-0001",
  hostLabel: "Studio Mac",
  remoteProfileId: "work",
  clientId: "peer-window-0001",
  terminalFontSize: 13,
};

const local = (id: string): LocalProfileOverview => ({
  id,
  name: `Profile ${id}`,
  color: "#fff",
  workspaceCount: 1,
  openWindows: 0,
});

const failure: PeerFailure = peerFailureFrom(
  { state: "not-paired", hostAppVersion: "", localAppVersion: "" },
  "Studio Mac",
  "offline",
);

function errorTitles(): string[] {
  return useNotificationStore().sessions.flatMap((entry) => entry.events.map((event) => event.title));
}

describe("PeerHostFailure", () => {
  const preload = {
    getLocalProfilesOverview: vi.fn(),
    activateLocalProfile: vi.fn(),
    closeWindow: vi.fn(),
    logRenderer: vi.fn(),
  };

  beforeEach(() => {
    setActivePinia(createPinia());
    window.localStorage.removeItem("strideterm-notifications-v2");
    setWindowBackend(backend);
    preload.getLocalProfilesOverview.mockReset().mockResolvedValue([local("a")]);
    preload.activateLocalProfile.mockReset().mockResolvedValue({ reloaded: true });
    preload.closeWindow.mockReset().mockResolvedValue(undefined);
    (window as unknown as Record<string, unknown>).strideterm = preload;
  });
  afterEach(() => {
    delete (window as unknown as Record<string, unknown>).strideterm;
    setWindowBackend({ kind: "local" });
  });

  it("names the host and the reason, in desktop terms", () => {
    const wrapper = mount(PeerHostFailure, { props: { failure } });
    const text = wrapper.text();

    expect(text).toContain("Studio Mac");
    expect(text).toContain("no longer accepts this desktop");
    expect(text).toContain("Pair this desktop");
    expect(text).not.toMatch(/Access token|Reload this page|Retry/i);
    expect(wrapper.find("input").exists()).toBe(false);
  });

  it("Reconnect asks the store, and a failure becomes a toast", async () => {
    const store = useAppStore();
    const reconnect = vi.spyOn(store, "reconnectPeerHost").mockRejectedValue(new Error("link down"));
    const wrapper = mount(PeerHostFailure, { props: { failure } });

    await wrapper.get('[data-testid="peer-failure-reconnect"]').trigger("click");
    await flushPromises();

    expect(reconnect).toHaveBeenCalledOnce();
    expect(errorTitles()).toContain("Could not reconnect");
  });

  it("switches straight to the only local profile", async () => {
    const wrapper = mount(PeerHostFailure, { props: { failure } });

    await wrapper.get('[data-testid="peer-failure-local"]').trigger("click");
    await flushPromises();

    expect(preload.activateLocalProfile).toHaveBeenCalledWith("a");
    expect(wrapper.find('[data-testid="peer-failure-profiles"]').exists()).toBe(false);
  });

  it("lists the local profiles when there are several and activates the picked one", async () => {
    preload.getLocalProfilesOverview.mockResolvedValue([local("a"), local("b")]);
    const wrapper = mount(PeerHostFailure, { props: { failure } });

    await wrapper.get('[data-testid="peer-failure-local"]').trigger("click");
    await flushPromises();
    expect(preload.activateLocalProfile).not.toHaveBeenCalled();
    const picks = wrapper.findAll('[data-testid="peer-failure-profile"]');
    expect(picks).toHaveLength(2);

    await picks[1].trigger("click");
    await flushPromises();
    expect(preload.activateLocalProfile).toHaveBeenCalledWith("b");
  });

  it("reports a failed switch and a failed listing by toast", async () => {
    preload.getLocalProfilesOverview.mockRejectedValueOnce(new Error("no overview"));
    const wrapper = mount(PeerHostFailure, { props: { failure } });
    await wrapper.get('[data-testid="peer-failure-local"]').trigger("click");
    await flushPromises();
    expect(errorTitles()).toContain("Could not list the profiles of this computer");

    preload.activateLocalProfile.mockRejectedValueOnce(new Error("refused"));
    await wrapper.get('[data-testid="peer-failure-local"]').trigger("click");
    await flushPromises();
    expect(errorTitles()).toContain("Could not switch the profile");
    expect(preload.activateLocalProfile).toHaveBeenCalledOnce();
  });

  it("closes the window, and reports a failure to do so", async () => {
    const wrapper = mount(PeerHostFailure, { props: { failure } });
    await wrapper.get('[data-testid="peer-failure-close"]').trigger("click");
    await flushPromises();
    expect(preload.closeWindow).toHaveBeenCalledOnce();

    preload.closeWindow.mockRejectedValueOnce(new Error("busy"));
    await wrapper.get('[data-testid="peer-failure-close"]').trigger("click");
    await flushPromises();
    expect(errorTitles()).toContain("Could not close the window");
  });

  it("is what BootstrapError shows in a peer window: no token form, no reload", () => {
    const wrapper = mount(BootstrapError, { props: { message: "Cannot reach the other computer right now." } });

    expect(wrapper.find('[data-testid="peer-failure"]').exists()).toBe(true);
    expect(wrapper.text()).not.toMatch(/Access token|Reload|Retry|Connect\b/);
    expect(wrapper.find("input").exists()).toBe(false);
  });

  it.each([
    ["offline", { state: "offline" }, "cannot be reached"],
    ["not-paired", { state: "not-paired" }, "no longer accepts this desktop"],
    ["wrong-host", { state: "wrong-host" }, "answers as another strIDEterm"],
    ["version-mismatch", { state: "version-mismatch", hostAppVersion: "2.1.0", localAppVersion: "2.0.0" }, "2.1.0"],
  ] as const)("renders the %s screen", (_reason, host, text) => {
    const next = peerFailureFrom({ hostAppVersion: "", localAppVersion: "", ...host }, "Studio Mac", "offline");
    const wrapper = mount(PeerHostFailure, { props: { failure: next } });
    expect(wrapper.text()).toContain(text);
    expect(wrapper.text()).toContain("Studio Mac");
    expect(wrapper.text()).not.toMatch(/token|reload this page/i);
  });
});

describe("PeerHostFailure — busy indicators", () => {
  const preload = {
    getLocalProfilesOverview: vi.fn(),
    activateLocalProfile: vi.fn(),
    closeWindow: vi.fn(),
    logRenderer: vi.fn(),
  };

  beforeEach(() => {
    setActivePinia(createPinia());
    window.localStorage.removeItem("strideterm-notifications-v2");
    setWindowBackend(backend);
    preload.getLocalProfilesOverview.mockReset().mockResolvedValue([local("a")]);
    preload.activateLocalProfile.mockReset().mockResolvedValue({ reloaded: true });
    preload.closeWindow.mockReset().mockResolvedValue(undefined);
    (window as unknown as Record<string, unknown>).strideterm = preload;
  });
  afterEach(() => {
    delete (window as unknown as Record<string, unknown>).strideterm;
    setWindowBackend({ kind: "local" });
  });

  const busyButtons = (wrapper: ReturnType<typeof mount>) =>
    wrapper
      .findAll("button")
      .filter((button) => button.attributes("aria-busy") === "true" && button.classes().includes("button--pending"))
      .map((button) => button.attributes("data-testid"));

  function deferred() {
    let resolve!: (_value?: unknown) => void;
    let reject!: (_reason: unknown) => void;
    const promise = new Promise((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  }

  it.each([["resolves"], ["rejects"]])(
    "Reconnect is busy and the other buttons are locked until the call %s",
    async (how) => {
      const call = deferred();
      vi.spyOn(useAppStore(), "reconnectPeerHost").mockReturnValue(call.promise as Promise<void>);
      const wrapper = mount(PeerHostFailure, { props: { failure } });

      await wrapper.get('[data-testid="peer-failure-reconnect"]').trigger("click");
      expect(busyButtons(wrapper)).toEqual(["peer-failure-reconnect"]);
      expect(wrapper.get('[data-testid="peer-failure-local"]').attributes("disabled")).toBeDefined();
      expect(wrapper.get('[data-testid="peer-failure-close"]').attributes("disabled")).toBeDefined();

      if (how === "resolves") call.resolve();
      else call.reject(new Error("link down"));
      await flushPromises();
      expect(busyButtons(wrapper)).toEqual([]);
      expect(wrapper.get('[data-testid="peer-failure-local"]').attributes("disabled")).toBeUndefined();
      if (how === "rejects") expect(errorTitles()).toContain("Could not reconnect");
    },
  );

  it.each([["resolves"], ["rejects"]])(
    "Switch to a local profile is busy while the list loads, until the call %s",
    async (how) => {
      const call = deferred();
      preload.getLocalProfilesOverview.mockReturnValue(call.promise);
      const wrapper = mount(PeerHostFailure, { props: { failure } });

      await wrapper.get('[data-testid="peer-failure-local"]').trigger("click");
      expect(busyButtons(wrapper)).toEqual(["peer-failure-local"]);

      if (how === "resolves") call.resolve([local("a"), local("b")]);
      else call.reject(new Error("no ipc"));
      await flushPromises();
      expect(busyButtons(wrapper)).toEqual([]);
      if (how === "rejects") expect(errorTitles()).toContain("Could not list the profiles of this computer");
      else expect(wrapper.findAll('[data-testid="peer-failure-profile"]')).toHaveLength(2);
    },
  );

  it.each([["resolves"], ["rejects"]])(
    "a listed profile is busy while it is activated, until the call %s",
    async (how) => {
      preload.getLocalProfilesOverview.mockResolvedValue([local("a"), local("b")]);
      const wrapper = mount(PeerHostFailure, { props: { failure } });
      await wrapper.get('[data-testid="peer-failure-local"]').trigger("click");
      await flushPromises();

      const call = deferred();
      preload.activateLocalProfile.mockReturnValue(call.promise);
      const profiles = wrapper.findAll('[data-testid="peer-failure-profile"]');
      await profiles[1].trigger("click");
      expect(busyButtons(wrapper)).toEqual(["peer-failure-profile"]);
      expect(profiles[1].classes()).toContain("button--pending");
      expect(profiles[0].classes()).not.toContain("button--pending");

      if (how === "resolves") call.resolve({ reloaded: true });
      else call.reject(new Error("refused"));
      await flushPromises();
      expect(busyButtons(wrapper)).toEqual([]);
      if (how === "rejects") expect(errorTitles()).toContain("Could not switch the profile");
    },
  );

  it.each([["resolves"], ["rejects"]])("Close window is busy until the call %s", async (how) => {
    const call = deferred();
    preload.closeWindow.mockReturnValue(call.promise);
    const wrapper = mount(PeerHostFailure, { props: { failure } });

    await wrapper.get('[data-testid="peer-failure-close"]').trigger("click");
    expect(busyButtons(wrapper)).toEqual(["peer-failure-close"]);

    if (how === "resolves") call.resolve();
    else call.reject(new Error("cannot close"));
    await flushPromises();
    expect(busyButtons(wrapper)).toEqual([]);
    if (how === "rejects") expect(errorTitles()).toContain("Could not close the window");
  });
});
