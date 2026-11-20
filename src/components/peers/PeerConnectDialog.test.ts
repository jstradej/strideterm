import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import PeerConnectDialog from "./PeerConnectDialog.vue";
import { useAppStore } from "../../stores/app.js";
import { useNotificationStore } from "../../stores/notifications.js";
import { usePeersStore } from "../../stores/peers.js";
import { setWindowBackend } from "../../window-backend.js";
import { PEER_DEFAULT_PORT, peerConnectSchema, type PeerPairingResult } from "../../../electron/shared/peers.js";

const ATTEMPT = "attempt-0001";
const HOST_ID = "host-0001";

function installBridge(overrides: Record<string, unknown> = {}) {
  const results: Array<(result: PeerPairingResult) => void> = [];
  const bridge = {
    listPeerHosts: vi.fn().mockResolvedValue([]),
    startPeerPairing: vi.fn().mockResolvedValue({
      attemptId: ATTEMPT,
      code: "1234 5678",
      hostId: HOST_ID,
      hostName: "Office",
      hostAppVersion: "1.0.0",
    }),
    cancelPeerPairing: vi.fn().mockResolvedValue(undefined),
    onPeerPairingResult: vi.fn((handler: (result: PeerPairingResult) => void) => {
      results.push(handler);
      return vi.fn();
    }),
    ...overrides,
  };
  (window as unknown as { strideterm: unknown }).strideterm = bridge;
  return { bridge, results };
}

function setLocalVersion(version: string) {
  useAppStore().payload = { meta: { appVersion: version } } as unknown as NonNullable<
    ReturnType<typeof useAppStore>["payload"]
  >;
}

async function submit(wrapper: ReturnType<typeof mount>, address = "office.local", port?: string) {
  await wrapper.find('[data-testid="peer-connect-address"]').setValue(address);
  if (port !== undefined) await wrapper.find('[data-testid="peer-connect-port"]').setValue(port);
  await wrapper.find("form").trigger("submit");
  await flushPromises();
}

beforeEach(() => {
  setActivePinia(createPinia());
  window.localStorage.clear();
  setLocalVersion("1.0.0");
});

afterEach(() => {
  delete (window as unknown as { strideterm?: unknown }).strideterm;
  setWindowBackend({ kind: "local" });
});

describe("PeerConnectDialog", () => {
  test("starts on the address step with the default port and the hint", () => {
    installBridge();
    const wrapper = mount(PeerConnectDialog);
    expect(wrapper.find('[data-testid="peer-connect-port"]').element).toHaveProperty(
      "value",
      String(PEER_DEFAULT_PORT),
    );
    expect(wrapper.text()).toContain("On the other computer, turn on Remote Access → Desktops first.");
    expect(wrapper.find('[data-testid="peer-connect-submit"]').attributes("disabled")).toBeDefined();
  });

  test("validates with the real peerConnectSchema and sends exactly { address, port }", async () => {
    const { bridge } = installBridge();
    const wrapper = mount(PeerConnectDialog);

    await wrapper.find('[data-testid="peer-connect-address"]').setValue("bad host");
    expect(peerConnectSchema.safeParse({ address: "bad host", port: PEER_DEFAULT_PORT }).success).toBe(false);
    expect(wrapper.find('[data-testid="peer-connect-validation"]').text()).toBe("Enter a host name or an IP address.");
    expect(wrapper.find('[data-testid="peer-connect-submit"]').attributes("disabled")).toBeDefined();

    await wrapper.find('[data-testid="peer-connect-address"]').setValue("office.local");
    await wrapper.find('[data-testid="peer-connect-port"]').setValue("70000");
    expect(wrapper.find('[data-testid="peer-connect-validation"]').text()).toBe("Enter a port between 1 and 65535.");

    await wrapper.find('[data-testid="peer-connect-port"]').setValue("43200");
    await wrapper.find("form").trigger("submit");
    await flushPromises();
    const sent = bridge.startPeerPairing.mock.calls[0][0];
    expect(sent).toEqual({ address: "office.local", port: 43200 });
    expect(peerConnectSchema.safeParse(sent).success).toBe(true);
  });

  test("shows the main process sentence in the dialog and keeps the form editable", async () => {
    const { bridge } = installBridge();
    bridge.startPeerPairing.mockRejectedValueOnce(
      new Error("Error invoking remote method 'peers:pair:begin': Error: Nothing is listening at office.local:43124."),
    );
    const wrapper = mount(PeerConnectDialog);
    await submit(wrapper);
    expect(wrapper.find('[data-testid="peer-connect-error"] .dialog__error-text').text()).toBe(
      "Nothing is listening at office.local:43124.",
    );
    const address = wrapper.find('[data-testid="peer-connect-address"]');
    expect((address.element as HTMLInputElement).value).toBe("office.local");
    expect(address.attributes("disabled")).toBeUndefined();

    await wrapper.find("form").trigger("submit");
    await flushPromises();
    expect(bridge.startPeerPairing).toHaveBeenCalledTimes(2);
    expect(wrapper.find('[data-testid="peer-connect-code"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="peer-connect-error"]').exists()).toBe(false);
  });

  test("shows the code, where to type it and the warning about a different request", async () => {
    installBridge();
    const wrapper = mount(PeerConnectDialog);
    await submit(wrapper);
    expect(wrapper.find('[data-testid="peer-connect-code"]').text()).toBe("1234 5678");
    expect(wrapper.text()).toContain("Type this code on Office under Remote Access → Desktops.");
    expect(wrapper.text()).toContain(
      "Only this desktop shows the code. If the other computer shows a different request, reject it there.",
    );
    expect(wrapper.find('[data-testid="peer-connect-waiting"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="peer-connect-version"]').exists()).toBe(false);
  });

  test("hints at a version difference, from the app version in a local window", async () => {
    installBridge({
      startPeerPairing: vi.fn().mockResolvedValue({
        attemptId: ATTEMPT,
        code: "1234 5678",
        hostId: HOST_ID,
        hostName: "Office",
        hostAppVersion: "2.0.0",
      }),
    });
    const wrapper = mount(PeerConnectDialog);
    await submit(wrapper);
    expect(wrapper.find('[data-testid="peer-connect-version"]').text()).toBe(
      "Pairing will work, but both desktops must run the same version to connect (Office runs 2.0.0, this one 1.0.0).",
    );
  });

  test("in an attached window the local version comes from an attached host, and is omitted when unknown", async () => {
    setWindowBackend({
      kind: "peer",
      hostId: HOST_ID,
      hostLabel: "Office",
      remoteProfileId: "p",
      clientId: "c",
      terminalFontSize: 13,
    });
    const start = vi.fn().mockResolvedValue({
      attemptId: ATTEMPT,
      code: "1234 5678",
      hostId: "host-0002",
      hostName: "Lab",
      hostAppVersion: "2.0.0",
    });
    installBridge({
      startPeerPairing: start,
      listPeerHosts: vi.fn().mockResolvedValue([
        {
          id: HOST_ID,
          label: "Office",
          address: "a",
          port: 1,
          hostPublicKey: "k",
          pairedAt: 1,
          state: "online",
          hostAppVersion: "3.0.0",
          localAppVersion: "3.1.0",
          profiles: [],
          checkedAt: 1,
        },
      ]),
    });
    const wrapper = mount(PeerConnectDialog);
    await flushPromises();
    await submit(wrapper);
    expect(wrapper.find('[data-testid="peer-connect-version"]').text()).toContain("Lab runs 2.0.0, this one 3.1.0");

    await wrapper.find('[data-testid="peer-connect-cancel"]').trigger("click");
    await flushPromises();
    usePeersStore().hosts = [];
    await submit(wrapper);
    expect(wrapper.find('[data-testid="peer-connect-version"]').exists()).toBe(false);
  });

  test("approved closes the dialog, toasts, expands the host and reloads hosts", async () => {
    const { bridge, results } = installBridge();
    const wrapper = mount(PeerConnectDialog);
    const peers = usePeersStore();
    peers.setCollapsed(HOST_ID, true);
    await submit(wrapper);
    bridge.listPeerHosts.mockClear();
    results[0]({ attemptId: ATTEMPT, state: "approved", hostId: HOST_ID });
    await flushPromises();
    expect(wrapper.emitted("cancel")).toHaveLength(1);
    expect(peers.isCollapsed(HOST_ID)).toBe(false);
    expect(bridge.listPeerHosts).toHaveBeenCalled();
    expect(useNotificationStore().persistentToasts.map((toast) => toast.title)).toContain("Office attached");
  });

  test.each([
    ["rejected", undefined, "The request was rejected on Office, or the code did not match."],
    ["expired", undefined, "The request timed out."],
    ["failed", "The host stopped answering.", "The host stopped answering."],
  ] as const)("%s shows its message and Try again returns to the address step", async (state, error, message) => {
    const { bridge, results } = installBridge();
    const wrapper = mount(PeerConnectDialog);
    await submit(wrapper);
    results[0]({ attemptId: ATTEMPT, state, ...(error ? { error } : {}) });
    await flushPromises();
    expect(wrapper.find('[data-testid="peer-connect-result"]').text()).toContain(message);
    expect(wrapper.emitted("cancel")).toBeUndefined();

    await wrapper.find('[data-testid="peer-connect-retry"]').trigger("click");
    await flushPromises();
    expect(wrapper.find('[data-testid="peer-connect-address"]').exists()).toBe(true);
    expect((wrapper.find('[data-testid="peer-connect-address"]').element as HTMLInputElement).value).toBe(
      "office.local",
    );
    expect(bridge.cancelPeerPairing).not.toHaveBeenCalled();
  });

  test("cancelled goes back to the address step", async () => {
    const { results } = installBridge();
    const wrapper = mount(PeerConnectDialog);
    await submit(wrapper);
    results[0]({ attemptId: ATTEMPT, state: "cancelled" });
    await flushPromises();
    expect(wrapper.find('[data-testid="peer-connect-address"]').exists()).toBe(true);
  });

  test("events of another attempt are ignored", async () => {
    const { results } = installBridge();
    const wrapper = mount(PeerConnectDialog);
    await submit(wrapper);
    results[0]({ attemptId: "someone-elses", state: "rejected" });
    results[0]({ attemptId: "someone-elses", state: "approved", hostId: "other" });
    await flushPromises();
    expect(wrapper.find('[data-testid="peer-connect-code"]').exists()).toBe(true);
    expect(wrapper.emitted("cancel")).toBeUndefined();
  });

  test("Cancel cancels the attempt and returns to the address step", async () => {
    const { bridge } = installBridge();
    const wrapper = mount(PeerConnectDialog);
    await submit(wrapper);
    await wrapper.find('[data-testid="peer-connect-cancel"]').trigger("click");
    await flushPromises();
    expect(bridge.cancelPeerPairing).toHaveBeenCalledWith(ATTEMPT);
    expect(wrapper.find('[data-testid="peer-connect-address"]').exists()).toBe(true);
  });

  test("closing the dialog during the code step cancels the attempt", async () => {
    const { bridge } = installBridge();
    const wrapper = mount(PeerConnectDialog);
    await submit(wrapper);
    wrapper.unmount();
    await flushPromises();
    expect(bridge.cancelPeerPairing).toHaveBeenCalledTimes(1);
    expect(bridge.cancelPeerPairing).toHaveBeenCalledWith(ATTEMPT);
  });

  test("closing after a finished attempt cancels nothing", async () => {
    const { bridge, results } = installBridge();
    const wrapper = mount(PeerConnectDialog);
    await submit(wrapper);
    results[0]({ attemptId: ATTEMPT, state: "rejected" });
    await flushPromises();
    wrapper.unmount();
    await flushPromises();
    expect(bridge.cancelPeerPairing).not.toHaveBeenCalled();
  });

  test("a failing cancel raises an error toast", async () => {
    const { bridge } = installBridge();
    bridge.cancelPeerPairing.mockRejectedValueOnce(new Error("gone"));
    const wrapper = mount(PeerConnectDialog);
    await submit(wrapper);
    const runWithToast = vi.spyOn(useNotificationStore(), "runWithToast");
    await wrapper.find('[data-testid="peer-connect-cancel"]').trigger("click");
    await flushPromises();
    expect(runWithToast).toHaveBeenCalledWith("Could not cancel the pairing", expect.any(Function));
    expect(useNotificationStore().sessions.length).toBeGreaterThan(0);
  });
});

describe("PeerConnectDialog — busy indicators", () => {
  const isBusy = (wrapper: ReturnType<typeof mount>) =>
    wrapper.find('[data-testid="peer-connect-submit"]').attributes("aria-busy") === "true";

  test.each([["resolves"], ["rejects"]])(
    "Connect shows what is happening and cannot be pressed twice until the call %s",
    async (how) => {
      let resolve!: (_value: unknown) => void;
      let reject!: (_reason: unknown) => void;
      const { bridge } = installBridge({
        startPeerPairing: vi.fn().mockReturnValue(
          new Promise((res, rej) => {
            resolve = res;
            reject = rej;
          }),
        ),
      });
      const wrapper = mount(PeerConnectDialog);
      await wrapper.find('[data-testid="peer-connect-address"]').setValue("office.local");
      expect(wrapper.find('[data-testid="peer-connect-contacting"]').exists()).toBe(false);
      await wrapper.find("form").trigger("submit");

      const submitButton = wrapper.find('[data-testid="peer-connect-submit"]');
      expect(isBusy(wrapper)).toBe(true);
      expect(submitButton.attributes("disabled")).toBeDefined();
      expect(submitButton.find(".spinner").exists()).toBe(true);
      expect(wrapper.find('[data-testid="peer-connect-contacting"]').text()).toContain("Contacting office.local");
      expect(wrapper.find('[data-testid="peer-connect-address"]').attributes("disabled")).toBeDefined();
      await wrapper.find("form").trigger("submit");
      expect(bridge.startPeerPairing).toHaveBeenCalledTimes(1);

      if (how === "resolves") {
        resolve({
          attemptId: ATTEMPT,
          code: "1234 5678",
          hostId: HOST_ID,
          hostName: "Office",
          hostAppVersion: "1.0.0",
        });
      } else reject(new Error("Nothing is listening at office.local:43124."));
      await flushPromises();
      expect(wrapper.find('[data-testid="peer-connect-contacting"]').exists()).toBe(false);
      if (how === "rejects") {
        expect(isBusy(wrapper)).toBe(false);
        expect(wrapper.find('[data-testid="peer-connect-error"]').text()).toContain("Nothing is listening");
      } else {
        expect(wrapper.find('[data-testid="peer-connect-waiting"] .spinner').exists()).toBe(true);
      }
    },
  );
});
