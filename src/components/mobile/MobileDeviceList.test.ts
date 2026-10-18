import { beforeEach, describe, expect, it, vi } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import MobileDeviceList from "./MobileDeviceList.vue";
import { useAppStore } from "../../stores/app.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyApi = any;
const phone = {
  deviceId: "phone-1",
  label: "Pixel 8",
  platform: "android",
  fingerprint: "AA:BB",
  state: "active",
  revoked: false,
  remoteUiPaused: false,
  lastSeenAt: 1,
  capabilities: ["task.control"],
  profileAllowlist: [],
  excludedProfileIds: [],
};

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("MobileDeviceList", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    (window as AnyApi).strideterm = { startupFlags: { windowId: "win-test" } };
  });

  it("renders the three independent session and recent activity states", async () => {
    const app = useAppStore();
    app.mobileDevices = [phone];
    vi.spyOn(app, "refreshMobileDevices").mockResolvedValue();
    const wrapper = mount(MobileDeviceList, { props: { refreshOnMount: false } });
    expect(wrapper.text()).toContain("last seen");
    app.mobileConnectedDevices = [
      {
        deviceId: "phone-1",
        name: "Pixel 8",
        profileId: "default",
        startedAt: 1,
        remoteUiConnected: true,
        lastForegroundAt: Date.now(),
      },
    ];
    await flushPromises();
    expect(wrapper.text()).toContain("Remote UI recently active");
    app.mobileConnectedDevices = [
      {
        deviceId: "phone-1",
        name: "Pixel 8",
        profileId: "default",
        startedAt: 1,
        remoteUiConnected: true,
        lastForegroundAt: Date.now() - 120_000,
      },
    ];
    await flushPromises();
    expect(wrapper.text()).toContain("Remote UI connected");
    expect(wrapper.text()).not.toContain("Remote UI recently active");
    app.mobileConnectedDevices = [
      {
        deviceId: "phone-1",
        name: "Pixel 8",
        profileId: "default",
        startedAt: 1,
        remoteUiConnected: false,
        lastForegroundAt: null,
      },
    ];
    await flushPromises();
    expect(wrapper.text()).toContain("Session active");
  });

  it("updates relative last-seen text and keeps the exact timestamp in its title", async () => {
    vi.useFakeTimers();
    const lastSeenAt = Date.now() - 44_000;
    const app = useAppStore();
    app.mobileDevices = [{ ...phone, lastSeenAt }];
    vi.spyOn(app, "refreshMobileDevices").mockResolvedValue();
    const wrapper = mount(MobileDeviceList, { props: { refreshOnMount: false } });
    const lastSeen = wrapper
      .findAll(".mobile-device-card__meta span")
      .find((span) => span.text().includes("last seen"))!;

    expect(lastSeen.text()).toBe("last seen just now");
    expect(lastSeen.attributes("title")).toBe(`Last seen: ${new Date(lastSeenAt).toLocaleString()}`);

    await vi.advanceTimersByTimeAsync(16_000);
    expect(lastSeen.text()).toBe("last seen 1 minute ago");

    app.mobileDevices = [{ ...phone, lastSeenAt: Date.now() - 9 * 24 * 60 * 60 * 1000 }];
    await flushPromises();
    expect(lastSeen.text()).toBe("last seen 9 days ago");

    const futureLastSeenAt = Date.now() + 60_000;
    app.mobileDevices = [{ ...phone, lastSeenAt: futureLastSeenAt }];
    await flushPromises();
    expect(lastSeen.text()).toBe("last seen just now");
    expect(lastSeen.attributes("title")).toBe(`Last seen: ${new Date(futureLastSeenAt).toLocaleString()}`);

    app.mobileDevices = [{ ...phone, lastSeenAt: Number.NaN }];
    await flushPromises();
    expect(lastSeen.text()).toBe("last seen never");
    expect(lastSeen.attributes("title")).toBe("Last seen: never");

    wrapper.unmount();
    vi.useRealTimers();
  });

  it("keeps management unavailable on a remote transport", () => {
    const app = useAppStore();
    app.isRemoteTransport = true;
    app.mobileDevices = [phone];
    const wrapper = mount(MobileDeviceList);
    expect(wrapper.text()).toContain("Phone management is available in Settings on the desktop app.");
    expect(wrapper.find("button").exists()).toBe(false);
  });

  it("runs rename, pause, access, test push, and revoke through app actions", async () => {
    const app = useAppStore();
    app.mobileDevices = [phone];
    vi.spyOn(app, "refreshMobileDevices").mockResolvedValue();
    const rename = vi.spyOn(app, "renameMobileDevice").mockResolvedValue();
    const pause = vi.spyOn(app, "setMobileDeviceRemoteUiPaused").mockResolvedValue();
    const access = vi.spyOn(app, "updateMobileDeviceAllowlist").mockResolvedValue();
    const push = vi.spyOn(app, "sendMobileTestPush").mockResolvedValue({ ok: true });
    const confirm = vi.spyOn(app, "confirmInApp").mockResolvedValue(true);
    const revoke = vi.spyOn(app, "revokeMobileDevice").mockResolvedValue();
    const wrapper = mount(MobileDeviceList, {
      props: {
        refreshOnMount: false,
        profiles: [
          { id: "default", name: "Default" },
          { id: "work", name: "Work" },
        ],
      },
    });

    await wrapper
      .findAll("button")
      .find((button) => button.text() === "Rename")!
      .trigger("click");
    await wrapper.find("input[aria-label='Phone name']").setValue("Work phone");
    await wrapper.find("input[aria-label='Phone name']").trigger("keyup.enter");
    expect(rename).toHaveBeenCalledWith("phone-1", "Work phone");

    await wrapper
      .findAll("button")
      .find((button) => button.text() === "Pause")!
      .trigger("click");
    expect(pause).toHaveBeenCalledWith("phone-1", true);
    await wrapper
      .findAll("button")
      .find((button) => button.text() === "Edit access")!
      .trigger("click");
    await wrapper.findAll(".pairing-picker")[0]!.findAll("input")[1]!.setValue(true);
    await wrapper
      .findAll("button")
      .find((button) => button.text() === "Save access")!
      .trigger("click");
    expect(access).toHaveBeenCalledWith("phone-1", expect.objectContaining({ excludedProfileIds: ["work"] }));
    await wrapper
      .findAll("button")
      .find((button) => button.text() === "Test push")!
      .trigger("click");
    expect(push).toHaveBeenCalledWith("phone-1");
    await wrapper
      .findAll("button")
      .find((button) => button.text() === "Revoke")!
      .trigger("click");
    expect(confirm).toHaveBeenCalled();
    expect(revoke).toHaveBeenCalledWith("phone-1");
  });

  it("shows pause and resume icons while preserving pending state and action labels", async () => {
    const app = useAppStore();
    app.mobileDevices = [phone];
    vi.spyOn(app, "refreshMobileDevices").mockResolvedValue();
    const request = deferred();
    vi.spyOn(app, "setMobileDeviceRemoteUiPaused").mockReturnValue(request.promise);
    const wrapper = mount(MobileDeviceList, { props: { refreshOnMount: false } });

    const pauseButton = wrapper.find("button[aria-label='Pause remote UI for this phone']");
    expect(pauseButton.find("svg").exists()).toBe(true);
    await pauseButton.trigger("click");
    const pendingButton = wrapper.find("button[aria-label='Pause remote UI for this phone']");
    expect(pendingButton.text()).toContain("Updating…");
    expect(pendingButton.find(".mobile-device-card__spinner").exists()).toBe(true);
    expect(pendingButton.attributes("disabled")).toBeDefined();

    request.resolve();
    await flushPromises();
    app.mobileDevices = [{ ...phone, remoteUiPaused: true }];
    await flushPromises();
    const resumeButton = wrapper.find("button[aria-label='Resume remote UI for this phone']");
    expect(resumeButton.text()).toContain("Resume");
    expect(resumeButton.find("svg").exists()).toBe(true);
  });

  it("does not revoke when confirmation is cancelled", async () => {
    const app = useAppStore();
    app.mobileDevices = [phone];
    vi.spyOn(app, "refreshMobileDevices").mockResolvedValue();
    vi.spyOn(app, "confirmInApp").mockResolvedValue(false);
    const revoke = vi.spyOn(app, "revokeMobileDevice").mockResolvedValue();
    const wrapper = mount(MobileDeviceList, { props: { refreshOnMount: false } });
    await wrapper
      .findAll("button")
      .find((button) => button.text() === "Revoke")!
      .trigger("click");
    expect(revoke).not.toHaveBeenCalled();
  });

  it("keeps revoke visibly pending and disables device actions until it finishes", async () => {
    const app = useAppStore();
    app.mobileDevices = [phone];
    vi.spyOn(app, "refreshMobileDevices").mockResolvedValue();
    vi.spyOn(app, "confirmInApp").mockResolvedValue(true);
    const request = deferred();
    vi.spyOn(app, "revokeMobileDevice").mockReturnValue(request.promise);
    const wrapper = mount(MobileDeviceList, { props: { refreshOnMount: false } });

    await wrapper
      .findAll("button")
      .find((button) => button.text() === "Revoke")!
      .trigger("click");
    await flushPromises();

    const revoke = wrapper.findAll("button").find((button) => button.text().includes("Revoking"))!;
    expect(revoke.attributes("disabled")).toBeDefined();
    expect(revoke.find(".mobile-device-card__spinner").exists()).toBe(true);
    expect(
      wrapper
        .findAll(".mobile-device-card__actions button")
        .every((button) => button.attributes("disabled") !== undefined),
    ).toBe(true);

    app.mobileDevices = [{ ...phone, revoked: true, state: "revoked" }];
    await flushPromises();
    const revokedCard = wrapper.find(".mobile-device-card--revoked");
    expect(revokedCard.find(".mobile-device-card__pending-status").text()).toContain("Revoking");
    expect(revokedCard.find(".device-item__forget").attributes("disabled")).toBeDefined();

    request.resolve();
    await flushPromises();
    expect(revokedCard.find(".mobile-device-card__pending-status").exists()).toBe(false);
    expect(revokedCard.find(".device-item__forget").attributes("disabled")).toBeUndefined();
  });

  it("shows access synchronization as pending and locks the editor until it finishes", async () => {
    const app = useAppStore();
    app.mobileDevices = [phone];
    vi.spyOn(app, "refreshMobileDevices").mockResolvedValue();
    const request = deferred();
    vi.spyOn(app, "updateMobileDeviceAllowlist").mockReturnValue(request.promise);
    const wrapper = mount(MobileDeviceList, { props: { refreshOnMount: false } });
    await wrapper
      .findAll("button")
      .find((button) => button.text() === "Edit access")!
      .trigger("click");
    await wrapper
      .findAll("button")
      .find((button) => button.text() === "Save access")!
      .trigger("click");

    const save = wrapper.findAll("button").find((button) => button.text().includes("Saving"))!;
    expect(save.attributes("disabled")).toBeDefined();
    expect(save.find(".mobile-device-card__spinner").exists()).toBe(true);
    expect(wrapper.find("fieldset").attributes("disabled")).toBeDefined();

    request.resolve();
    await flushPromises();
    expect(wrapper.find("fieldset").exists()).toBe(false);
  });

  it("keeps rename visibly pending and prevents editing the name until it finishes", async () => {
    const app = useAppStore();
    app.mobileDevices = [phone];
    vi.spyOn(app, "refreshMobileDevices").mockResolvedValue();
    const request = deferred();
    vi.spyOn(app, "renameMobileDevice").mockReturnValue(request.promise);
    const wrapper = mount(MobileDeviceList, { props: { refreshOnMount: false } });
    await wrapper
      .findAll("button")
      .find((button) => button.text() === "Rename")!
      .trigger("click");
    const input = wrapper.find("input[aria-label='Phone name']");
    await input.setValue("Desk phone");
    await input.trigger("keyup.enter");

    const save = wrapper.findAll("button").find((button) => button.text().includes("Saving"))!;
    expect(save.attributes("disabled")).toBeDefined();
    expect(save.find(".mobile-device-card__spinner").exists()).toBe(true);
    expect(input.attributes("disabled")).toBeDefined();

    request.resolve();
    await flushPromises();
    expect(wrapper.find("input[aria-label='Phone name']").exists()).toBe(false);
  });

  it("keeps revoked devices compact with only the forget action", () => {
    const app = useAppStore();
    app.mobileDevices = [
      { ...phone, deviceId: "phone-revoked", label: "Old phone", revoked: true, state: "revoked" },
      phone,
    ];
    vi.spyOn(app, "refreshMobileDevices").mockResolvedValue();
    const wrapper = mount(MobileDeviceList, { props: { refreshOnMount: false } });

    expect(wrapper.find(".mobile-device-card__details").attributes("open")).toBeUndefined();
    expect(wrapper.find(".mobile-device-card--revoked").exists()).toBe(true);
    expect(wrapper.findAll(".mobile-device-card").map((card) => card.find("strong").text())).toEqual([
      "Pixel 8",
      "Old phone",
    ]);
    const revokedCard = wrapper.find(".mobile-device-card--revoked");
    expect(revokedCard.text()).toContain("Revoked");
    expect(revokedCard.text()).not.toContain("Capabilities:");
    expect(revokedCard.find(".mobile-device-card__actions button").exists()).toBe(false);
    expect(revokedCard.find(".device-item__forget").exists()).toBe(true);
    expect(revokedCard.find(".mobile-device-card__label--revoked").exists()).toBe(true);
  });
});
