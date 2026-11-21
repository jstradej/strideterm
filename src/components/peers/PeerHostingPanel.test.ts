import { beforeEach, describe, expect, test, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import PeerHostingPanel from "./PeerHostingPanel.vue";
import { apiKey } from "../../types/keys.js";
import { useAppStore } from "../../stores/app.js";
import { useNotificationStore } from "../../stores/notifications.js";
import {
  PEER_DEFAULT_PORT,
  peerApproveSchema,
  peerRenameDeviceSchema,
  type PeerHostState,
} from "../../../electron/shared/peers.js";

const PAIRING_ID = "pairing-0001";
const DEVICE_ID = "device-0001";

function makeState(overrides: Partial<PeerHostState> = {}): PeerHostState {
  return {
    hosting: { enabled: false, port: PEER_DEFAULT_PORT },
    instanceId: "instance-0001",
    hostName: "Host",
    encryptionAvailable: true,
    listener: { listening: false, port: 0, addresses: [], error: "" },
    devices: [],
    pending: [],
    ...overrides,
  };
}

const listening = (): PeerHostState =>
  makeState({
    hosting: { enabled: true, port: PEER_DEFAULT_PORT },
    listener: { listening: true, port: PEER_DEFAULT_PORT, addresses: ["192.168.1.5", "10.0.0.7"], error: "" },
  });

const pendingEntry = (sasReady: boolean, appVersion = "1.0.0") => ({
  pairingId: PAIRING_ID,
  deviceId: DEVICE_ID,
  name: "Laptop",
  platform: "darwin",
  appVersion,
  address: "192.168.1.9",
  createdAt: Date.now(),
  sasReady,
});

type Handler = (_payload: unknown) => void;

function setup(initial: PeerHostState) {
  const handlers: { updated: Handler[]; progress: Handler[] } = { updated: [], progress: [] };
  const off = vi.fn();
  const api = {
    getPeerHostState: vi.fn().mockResolvedValue(initial),
    setPeerHosting: vi.fn(),
    approvePeerPairing: vi.fn(),
    rejectPeerPairing: vi.fn().mockResolvedValue(true),
    removePeerDevice: vi.fn().mockResolvedValue(true),
    renamePeerDevice: vi.fn().mockResolvedValue(true),
    onPeersUpdated: vi.fn((h: Handler) => {
      handlers.updated.push(h);
      return off;
    }),
    onPeerPairingProgress: vi.fn((h: Handler) => {
      handlers.progress.push(h);
      return off;
    }),
  };
  const wrapper = mount(PeerHostingPanel, { global: { provide: { [apiKey]: api } } });
  return { api, wrapper, handlers, off };
}

async function typeCode(wrapper: ReturnType<typeof setup>["wrapper"], value: string) {
  const input = wrapper.find('[data-testid="peer-code-input"]');
  await input.setValue(value);
  return input;
}

function setLocalVersion(version: string) {
  useAppStore().payload = { meta: { appVersion: version } } as unknown as NonNullable<
    ReturnType<typeof useAppStore>["payload"]
  >;
}

beforeEach(() => {
  setActivePinia(createPinia());
});

describe("PeerHostingPanel — states", () => {
  test("off: toggle unchecked, no listener section", async () => {
    const { wrapper } = setup(makeState());
    await flushPromises();
    expect((wrapper.find('[data-testid="peer-hosting-toggle"]').element as HTMLInputElement).checked).toBe(false);
    expect(wrapper.find('[data-testid="peer-hosting-listener"]').exists()).toBe(false);
    expect(wrapper.text()).toContain("No desktops paired yet.");
  });

  test("on and listening: port and copyable addresses", async () => {
    const { wrapper } = setup(listening());
    await flushPromises();
    const copyText = vi.spyOn(useAppStore(), "copyText").mockResolvedValue(undefined as never);
    expect(wrapper.text()).toContain(`Listening on port ${PEER_DEFAULT_PORT}`);
    const chips = wrapper.findAll('[data-testid="peer-hosting-address"]');
    expect(chips.map((c) => c.text())).toEqual([`192.168.1.5:${PEER_DEFAULT_PORT}`, `10.0.0.7:${PEER_DEFAULT_PORT}`]);
    await chips[0].trigger("click");
    expect(copyText).toHaveBeenCalledWith(`192.168.1.5:${PEER_DEFAULT_PORT}`);
  });

  test("on but not listening: shows the listener error", async () => {
    const state = makeState({
      hosting: { enabled: true, port: 43124 },
      listener: { listening: false, port: 0, addresses: [], error: "Port 43124 is already in use." },
    });
    const { wrapper } = setup(state);
    await flushPromises();
    expect(wrapper.find('[data-testid="peer-hosting-listener-error"]').text()).toBe("Port 43124 is already in use.");
  });
});

describe("PeerHostingPanel — hosting switch", () => {
  test("turning on sends { enabled, port } and shows the returned state", async () => {
    const { api, wrapper } = setup(makeState());
    api.setPeerHosting.mockResolvedValue(listening());
    await flushPromises();
    const toggle = wrapper.find('[data-testid="peer-hosting-toggle"]');
    (toggle.element as HTMLInputElement).checked = true;
    await toggle.trigger("change");
    await flushPromises();
    expect(api.setPeerHosting).toHaveBeenCalledWith({ enabled: true, port: PEER_DEFAULT_PORT });
    expect((toggle.element as HTMLInputElement).checked).toBe(true);
    expect(wrapper.find('[data-testid="peer-hosting-listener"]').exists()).toBe(true);
  });

  test("controls are disabled while the call is in flight", async () => {
    const { api, wrapper } = setup(makeState());
    let resolve!: (_state: PeerHostState) => void;
    api.setPeerHosting.mockReturnValue(new Promise<PeerHostState>((r) => (resolve = r)));
    await flushPromises();
    const toggle = wrapper.find('[data-testid="peer-hosting-toggle"]');
    (toggle.element as HTMLInputElement).checked = true;
    await toggle.trigger("change");
    expect((toggle.element as HTMLInputElement).disabled).toBe(true);
    expect((wrapper.find('[data-testid="peer-hosting-port"]').element as HTMLInputElement).disabled).toBe(true);
    resolve(listening());
    await flushPromises();
    expect((toggle.element as HTMLInputElement).disabled).toBe(false);
  });

  test("a rejected enable raises an error toast and leaves the toggle off", async () => {
    const { api, wrapper } = setup(makeState());
    api.setPeerHosting.mockRejectedValue(new Error("Secure storage is unavailable"));
    await flushPromises();
    const toggle = wrapper.find('[data-testid="peer-hosting-toggle"]');
    (toggle.element as HTMLInputElement).checked = true;
    await toggle.trigger("change");
    await flushPromises();
    expect((toggle.element as HTMLInputElement).checked).toBe(false);
    expect(useNotificationStore().sessions[0].events[0].title).toBe("Could not turn hosting on");
  });

  test("without secure storage turning on is disabled and a warning is shown; turning off stays possible", async () => {
    const off = setup(makeState({ encryptionAvailable: false }));
    await flushPromises();
    expect((off.wrapper.find('[data-testid="peer-hosting-toggle"]').element as HTMLInputElement).disabled).toBe(true);
    expect(off.wrapper.text()).toContain("Secure storage is required.");

    const on = setup({ ...listening(), encryptionAvailable: false });
    await flushPromises();
    expect((on.wrapper.find('[data-testid="peer-hosting-toggle"]').element as HTMLInputElement).disabled).toBe(false);
  });

  test("an invalid port is not sent", async () => {
    const { api, wrapper } = setup(makeState());
    await flushPromises();
    for (const bad of ["0", "70000", "abc", ""]) {
      await wrapper.find('[data-testid="peer-hosting-port"]').setValue(bad);
      expect(wrapper.find('[data-testid="peer-hosting-port-error"]').exists()).toBe(true);
      expect((wrapper.find('[data-testid="peer-hosting-toggle"]').element as HTMLInputElement).disabled).toBe(true);
      expect((wrapper.find('[data-testid="peer-hosting-port-apply"]').element as HTMLButtonElement).disabled).toBe(
        true,
      );
    }
    expect(api.setPeerHosting).not.toHaveBeenCalled();
  });

  test("applying a new port keeps the current enabled flag", async () => {
    const { api, wrapper } = setup(listening());
    api.setPeerHosting.mockResolvedValue({ ...listening(), hosting: { enabled: true, port: 50000 } });
    await flushPromises();
    await wrapper.find('[data-testid="peer-hosting-port"]').setValue("50000");
    await wrapper.find('[data-testid="peer-hosting-port-apply"]').trigger("click");
    await flushPromises();
    expect(api.setPeerHosting).toHaveBeenCalledWith({ enabled: true, port: 50000 });
  });
});

describe("PeerHostingPanel — pairing requests", () => {
  const withPending = (sasReady: boolean, appVersion?: string): PeerHostState => ({
    ...listening(),
    pending: [pendingEntry(sasReady, appVersion)],
  });

  test("code input formats, gates Approve, and never renders a code", async () => {
    const { wrapper } = setup(withPending(true));
    await flushPromises();
    const approve = wrapper.find('[data-testid="peer-approve"]');
    expect((approve.element as HTMLButtonElement).disabled).toBe(true);
    const input = await typeCode(wrapper, "1234567");
    expect((input.element as HTMLInputElement).value).toBe("1234 567");
    expect((approve.element as HTMLButtonElement).disabled).toBe(true);
    await typeCode(wrapper, "12 34-5678 99");
    expect((input.element as HTMLInputElement).value).toBe("1234 5678");
    expect((approve.element as HTMLButtonElement).disabled).toBe(false);
    expect(wrapper.find('[data-testid="peer-pairing-card"]').text()).not.toMatch(/\d{4}\s?\d{4}(?!\d)/);
  });

  test("the card never contains an 8-digit code before anything is typed", async () => {
    const { wrapper } = setup(withPending(true));
    await flushPromises();
    expect(wrapper.html()).not.toMatch(/\d{4}\s?\d{4}(?!\d)/);
  });

  test("approve sends exactly { pairingId, code }, valid for the schema, and clears the code", async () => {
    const { api, wrapper } = setup(withPending(true));
    api.approvePeerPairing.mockResolvedValue("approved");
    await flushPromises();
    api.getPeerHostState.mockResolvedValue(makeState());
    await typeCode(wrapper, "12345678");
    await wrapper.find('[data-testid="peer-approve"]').trigger("click");
    await flushPromises();
    const payload = api.approvePeerPairing.mock.calls[0][0];
    expect(payload).toEqual({ pairingId: PAIRING_ID, code: "12345678" });
    expect(peerApproveSchema.safeParse(payload).success).toBe(true);
    expect(wrapper.find('[data-testid="peer-pairing-card"]').exists()).toBe(false);
    expect(useNotificationStore().persistentToasts.some((t) => t.body.includes("Laptop"))).toBe(true);
  });

  test("sas-mismatch shows an error state telling the other desktop to start again", async () => {
    const { api, wrapper } = setup(withPending(true));
    api.approvePeerPairing.mockResolvedValue("sas-mismatch");
    await flushPromises();
    api.getPeerHostState.mockResolvedValue(makeState());
    await typeCode(wrapper, "11112222");
    await wrapper.find('[data-testid="peer-approve"]').trigger("click");
    await flushPromises();
    expect(wrapper.find('[data-testid="peer-outcome-mismatch"]').text()).toContain("did not match");
    expect(wrapper.find('[data-testid="peer-code-input"]').exists()).toBe(false);
    await wrapper.find(".peer-card__actions button").trigger("click");
    expect(wrapper.find('[data-testid="peer-pairing-card"]').exists()).toBe(false);
  });

  test("not-found says the request is no longer available", async () => {
    const { api, wrapper } = setup(withPending(true));
    api.approvePeerPairing.mockResolvedValue("not-found");
    await flushPromises();
    await typeCode(wrapper, "11112222");
    await wrapper.find('[data-testid="peer-approve"]').trigger("click");
    await flushPromises();
    expect(wrapper.find('[data-testid="peer-outcome-not-found"]').text()).toBe("This request is no longer available.");
  });

  test("a rejected approve is toasted", async () => {
    const { api, wrapper } = setup(withPending(true));
    api.approvePeerPairing.mockRejectedValue(new Error("boom"));
    await flushPromises();
    await typeCode(wrapper, "11112222");
    await wrapper.find('[data-testid="peer-approve"]').trigger("click");
    await flushPromises();
    expect(useNotificationStore().sessions[0].events[0].title).toBe("Could not approve the pairing");
  });

  test("not sasReady: waiting text and only Reject", async () => {
    const { api, wrapper } = setup(withPending(false));
    await flushPromises();
    expect(wrapper.find('[data-testid="peer-waiting"]').text()).toBe("Waiting for the other desktop…");
    expect(wrapper.find('[data-testid="peer-code-input"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="peer-approve"]').exists()).toBe(false);
    api.getPeerHostState.mockResolvedValue(makeState());
    await wrapper.find('[data-testid="peer-reject"]').trigger("click");
    await flushPromises();
    expect(api.rejectPeerPairing).toHaveBeenCalledWith(PAIRING_ID);
  });

  test("a different app version shows the hint, the same one does not", async () => {
    setLocalVersion("2.0.0");
    const different = setup(withPending(true, "1.0.0"));
    await flushPromises();
    expect(different.wrapper.find('[data-testid="peer-version-hint"]').text()).toContain("same version");

    setLocalVersion("1.0.0");
    const same = setup(withPending(true, "1.0.0"));
    await flushPromises();
    expect(same.wrapper.find('[data-testid="peer-version-hint"]').exists()).toBe(false);
  });
});

describe("PeerHostingPanel — paired desktops", () => {
  const device = {
    id: DEVICE_ID,
    name: "Work laptop",
    platform: "win32",
    publicKey: "k",
    pairedAt: 1,
    lastSeenAt: Date.now() - 5 * 60_000,
    lastAddress: "192.168.1.9",
  };

  test("Rename sends the trimmed name with the device id and reloads", async () => {
    const { api, wrapper } = setup({ ...listening(), devices: [device] });
    await flushPromises();
    await wrapper.find('[data-testid="peer-rename"]').trigger("click");
    const input = wrapper.find('[data-testid="peer-rename-input"]');
    expect((input.element as HTMLInputElement).value).toBe("Work laptop");
    await input.setValue("   ");
    expect(wrapper.find('[data-testid="peer-rename-save"]').attributes("disabled")).toBeDefined();
    await input.setValue("  Desk  ");
    api.getPeerHostState.mockResolvedValue({ ...listening(), devices: [{ ...device, name: "Desk" }] });
    await wrapper.find('[data-testid="peer-rename-form"]').trigger("submit");
    await flushPromises();
    const sent = api.renamePeerDevice.mock.calls[0][0];
    expect(sent).toEqual({ deviceId: DEVICE_ID, name: "Desk" });
    expect(peerRenameDeviceSchema.safeParse(sent).success).toBe(true);
    expect(wrapper.find('[data-testid="peer-rename-form"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="peer-device"]').text()).toContain("Desk");
  });

  test("lists a device and removes it only after confirmation", async () => {
    const { api, wrapper } = setup({ ...listening(), devices: [device] });
    const confirm = vi.spyOn(useAppStore(), "confirmInApp").mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    await flushPromises();
    const row = wrapper.find('[data-testid="peer-device"]');
    expect(row.text()).toContain("Work laptop");
    expect(row.text()).toContain("5 minutes ago");
    expect(row.text()).toContain("192.168.1.9");

    await wrapper.find('[data-testid="peer-remove"]').trigger("click");
    await flushPromises();
    expect(api.removePeerDevice).not.toHaveBeenCalled();

    api.getPeerHostState.mockResolvedValue(listening());
    await wrapper.find('[data-testid="peer-remove"]').trigger("click");
    await flushPromises();
    expect(confirm.mock.calls[1][0].message).toBe(
      "Work laptop will be disconnected at once and has to be paired again.",
    );
    expect(api.removePeerDevice).toHaveBeenCalledWith(DEVICE_ID);
    expect(wrapper.find('[data-testid="peer-device"]').exists()).toBe(false);
  });
});

describe("PeerHostingPanel — live updates", () => {
  test("reloads on both events, and unmount unsubscribes", async () => {
    const { api, wrapper, handlers, off } = setup(makeState());
    await flushPromises();
    expect(api.getPeerHostState).toHaveBeenCalledTimes(1);
    handlers.updated[0]({});
    await flushPromises();
    handlers.progress[0]({});
    await flushPromises();
    expect(api.getPeerHostState).toHaveBeenCalledTimes(3);
    wrapper.unmount();
    expect(off).toHaveBeenCalledTimes(2);
  });
});

describe("PeerHostingPanel — busy indicators", () => {
  const device = {
    id: DEVICE_ID,
    name: "Work laptop",
    platform: "win32",
    publicKey: "k",
    pairedAt: 1,
    lastSeenAt: Date.now(),
    lastAddress: "192.168.1.9",
  };
  const withPending = (sasReady: boolean): PeerHostState => ({ ...listening(), pending: [pendingEntry(sasReady)] });
  const isPending = (button: { classes: () => string[]; attributes: (name: string) => string | undefined }) =>
    button.classes().includes("button--pending") && button.attributes("aria-busy") === "true";

  function deferred<T>() {
    let resolve!: (_value: T) => void;
    let reject!: (_reason: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  }

  test("shows a spinner while the first state loads and a retry when it fails", async () => {
    const first = deferred<PeerHostState>();
    const { api, wrapper } = setup(makeState());
    await flushPromises();
    wrapper.unmount();
    api.getPeerHostState.mockReturnValue(first.promise);
    const again = mount(PeerHostingPanel, { global: { provide: { [apiKey]: api } } });
    await flushPromises();
    expect(again.find('[role="status"]').text()).toContain("Loading…");
    expect(again.find(".spinner").exists()).toBe(true);
    expect(again.text()).not.toContain("No desktops paired yet.");

    first.reject(new Error("offline"));
    await flushPromises();
    expect(again.find(".spinner").exists()).toBe(false);
    expect(again.find('[data-testid="peer-hosting-load-failed"]').exists()).toBe(true);
    expect(useNotificationStore().sessions[0].events[0].title).toBe("Could not load desktop hosting");

    const second = deferred<PeerHostState>();
    api.getPeerHostState.mockReturnValue(second.promise);
    await again.find('[data-testid="peer-hosting-retry"]').trigger("click");
    expect(again.find(".spinner").exists()).toBe(true);
    expect(again.find('[data-testid="peer-hosting-load-failed"]').exists()).toBe(false);
    second.resolve(makeState());
    await flushPromises();
    expect(again.find(".spinner").exists()).toBe(false);
    expect(again.text()).toContain("No desktops paired yet.");
  });

  test.each([["resolves"], ["rejects"]])("the switch shows a spinner at the control until the call %s", async (how) => {
    const { api, wrapper } = setup(makeState());
    const call = deferred<PeerHostState>();
    api.setPeerHosting.mockReturnValue(call.promise);
    await flushPromises();
    const toggle = wrapper.find('[data-testid="peer-hosting-toggle"]');
    (toggle.element as HTMLInputElement).checked = true;
    await toggle.trigger("change");
    expect(wrapper.find('[data-testid="peer-hosting-toggle-busy"]').exists()).toBe(true);
    expect(toggle.attributes("disabled")).toBeDefined();

    if (how === "resolves") call.resolve(listening());
    else call.reject(new Error("no port"));
    await flushPromises();
    expect(wrapper.find('[data-testid="peer-hosting-toggle-busy"]').exists()).toBe(false);
    expect(toggle.attributes("disabled")).toBeUndefined();
    if (how === "rejects") expect(useNotificationStore().sessions[0].events[0].title).toBe("Could not turn hosting on");
  });

  test.each([["resolves"], ["rejects"]])("Apply is busy and cannot be pressed twice until the call %s", async (how) => {
    const { api, wrapper } = setup(listening());
    const call = deferred<PeerHostState>();
    api.setPeerHosting.mockReturnValue(call.promise);
    await flushPromises();
    await wrapper.find('[data-testid="peer-hosting-port"]').setValue("43200");
    const apply = wrapper.find('[data-testid="peer-hosting-port-apply"]');
    await apply.trigger("click");
    expect(isPending(apply)).toBe(true);
    expect(apply.attributes("disabled")).toBeDefined();
    await apply.trigger("click");
    expect(api.setPeerHosting).toHaveBeenCalledTimes(1);

    if (how === "resolves") call.resolve({ ...listening(), hosting: { enabled: true, port: 43200 } });
    else call.reject(new Error("in use"));
    await flushPromises();
    expect(isPending(apply)).toBe(false);
    if (how === "rejects") expect(useNotificationStore().sessions[0].events[0].title).toBe("Could not change the port");
  });

  test.each([
    ["approve", "resolves"],
    ["approve", "rejects"],
    ["reject", "resolves"],
    ["reject", "rejects"],
  ] as const)("%s marks only its own button busy until the call %s", async (action, how) => {
    const { api, wrapper } = setup(withPending(true));
    const call = deferred<unknown>();
    api.approvePeerPairing.mockReturnValue(call.promise);
    api.rejectPeerPairing.mockReturnValue(call.promise);
    await flushPromises();
    await typeCode(wrapper, "11112222");
    const approve = wrapper.find('[data-testid="peer-approve"]');
    const reject = wrapper.find('[data-testid="peer-reject"]');
    await (action === "approve" ? approve : reject).trigger("click");
    expect(isPending(action === "approve" ? approve : reject)).toBe(true);
    expect(isPending(action === "approve" ? reject : approve)).toBe(false);
    expect(approve.attributes("disabled")).toBeDefined();
    expect(reject.attributes("disabled")).toBeDefined();

    if (how === "resolves") {
      api.getPeerHostState.mockResolvedValue(listening());
      call.resolve(action === "approve" ? "approved" : true);
    } else call.reject(new Error("host gone"));
    await flushPromises();
    if (how === "rejects") {
      expect(useNotificationStore().sessions[0].events[0].title).toBe(
        action === "approve" ? "Could not approve the pairing" : "Could not reject the pairing",
      );
      expect(isPending(action === "approve" ? approve : reject)).toBe(false);
    }
  });

  test.each([["resolves"], ["rejects"]])("Remove is busy on its own row until the call %s", async (how) => {
    const { api, wrapper } = setup({ ...listening(), devices: [device] });
    vi.spyOn(useAppStore(), "confirmInApp").mockResolvedValue(true);
    const call = deferred<unknown>();
    api.removePeerDevice.mockReturnValue(call.promise);
    await flushPromises();
    const remove = wrapper.find('[data-testid="peer-remove"]');
    await remove.trigger("click");
    await flushPromises();
    expect(isPending(remove)).toBe(true);
    expect(remove.attributes("disabled")).toBeDefined();

    if (how === "resolves") {
      api.getPeerHostState.mockResolvedValue(listening());
      call.resolve(true);
    } else call.reject(new Error("host gone"));
    await flushPromises();
    if (how === "rejects") {
      expect(isPending(remove)).toBe(false);
      expect(useNotificationStore().sessions[0].events[0].title).toBe("Could not remove the desktop");
    } else expect(wrapper.find('[data-testid="peer-device"]').exists()).toBe(false);
  });

  test("a request still waiting for the other desktop shows a spinner beside the waiting text", async () => {
    const { wrapper } = setup(withPending(false));
    await flushPromises();
    expect(
      wrapper.find('[data-testid="peer-waiting"]').element.parentElement?.querySelector(".spinner"),
    ).not.toBeNull();
  });
});
