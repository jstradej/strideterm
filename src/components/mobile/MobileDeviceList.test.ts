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
      .find((button) => button.text() === "Pause device")!
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
      .find((button) => button.text() === "Send test push")!
      .trigger("click");
    expect(push).toHaveBeenCalledWith("phone-1");
    await wrapper
      .findAll("button")
      .find((button) => button.text() === "Revoke")!
      .trigger("click");
    expect(confirm).toHaveBeenCalled();
    expect(revoke).toHaveBeenCalledWith("phone-1");
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
});
