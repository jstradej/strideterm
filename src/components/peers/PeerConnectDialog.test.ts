import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import PeerConnectDialog from "./PeerConnectDialog.vue";
import { useAppStore } from "../../stores/app.js";
import { useNotificationStore } from "../../stores/notifications.js";
import { usePeersStore } from "../../stores/peers.js";
import { setWindowBackend } from "../../window-backend.js";
import {
  PEER_DEFAULT_PORT,
  peerConnectSchema,
  type PeerPairingResult,
  type PeerPairingRetrying,
} from "../../../electron/shared/peers.js";

const ATTEMPT = "attempt-0001";
const HOST_ID = "host-0001";

function installBridge(overrides: Record<string, unknown> = {}) {
  const results: Array<(result: PeerPairingResult) => void> = [];
  const retries: Array<(wait: PeerPairingRetrying) => void> = [];
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
    onPeerPairingRetrying: vi.fn((handler: (wait: PeerPairingRetrying) => void) => {
      retries.push(handler);
      return vi.fn();
    }),
    ...overrides,
  };
  (window as unknown as { strideterm: unknown }).strideterm = bridge;
  return { bridge, results, retries };
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

describe("PeerConnectDialog — failure guidance", () => {
  const userAgent = (value: string) => vi.spyOn(window.navigator, "userAgent", "get").mockReturnValue(value);
  const MAC = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36";
  const WINDOWS = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36";

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function failWith(reason: string | undefined, port = "43200") {
    const { results } = installBridge();
    const wrapper = mount(PeerConnectDialog);
    await submit(wrapper, "office.local", port);
    results[0]({ attemptId: ATTEMPT, state: "failed", error: "raw", ...(reason ? { reason } : {}) } as never);
    await flushPromises();
    return wrapper;
  }

  test("refused names the address and what to turn on, without firewall steps", async () => {
    const wrapper = await failWith("refused");
    expect(wrapper.find('[data-testid="peer-connect-result"]').text()).toBe(
      "⚠Nothing is listening at office.local:43200. On the other desktop, turn on hosting in Remote Access → Desktops and check that the port matches.",
    );
    expect(wrapper.find('[data-testid="peer-failure-firewall"]').exists()).toBe(false);
  });

  test("other-program names the address and the port setting", async () => {
    const wrapper = await failWith("other-program");
    expect(wrapper.find('[data-testid="peer-connect-result"]').text()).toContain(
      "Another program answers at office.local:43200, not strIDEterm's desktop link. Check the port set in Remote Access → Desktops on the other desktop.",
    );
    expect(wrapper.find('[data-testid="peer-failure-firewall"]').exists()).toBe(false);
  });

  test.each(["timeout", "unreachable"])("%s explains the firewall and lists every OS with the port", async (reason) => {
    userAgent(WINDOWS);
    const wrapper = await failWith(reason);
    expect(wrapper.find('[data-testid="peer-connect-result"]').text()).toContain(
      "office.local:43200 did not answer. Usually the other desktop's firewall blocks incoming connections, or the two computers are not on the same network.",
    );
    const details = wrapper.find('[data-testid="peer-failure-firewall"]');
    expect(details.text()).toContain("How to allow the connection on the other desktop");
    const text = details.text();
    expect(text).toContain("When Windows asks whether strIDEterm may communicate on networks, allow Private networks.");
    expect(text).toContain(
      'New-NetFirewallRule -DisplayName "strIDEterm desktops" -Direction Inbound -Protocol TCP -LocalPort 43200 -Action Allow -Profile Private',
    );
    expect(text).toContain(
      "System Settings → Network → Firewall → Options… → strIDEterm → Allow incoming connections.",
    );
    expect(text).toContain("sudo ufw allow 43200/tcp");
    expect(text).toContain("sudo firewall-cmd --permanent --add-port=43200/tcp && sudo firewall-cmd --reload");
  });

  test("the Local Network line shows on a Mac", async () => {
    userAgent(MAC);
    const wrapper = await failWith("unreachable");
    expect(wrapper.find('[data-testid="peer-failure-local-network"]').text()).toBe(
      "On this Mac, also check System Settings → Privacy & Security → Local Network: strIDEterm must be allowed to reach devices on the local network.",
    );
  });

  test("the Local Network line is absent on other systems", async () => {
    userAgent(WINDOWS);
    const wrapper = await failWith("timeout");
    expect(wrapper.find('[data-testid="peer-failure-local-network"]').exists()).toBe(false);
  });

  test("the Local Network line is absent for a refused connection on a Mac", async () => {
    userAgent(MAC);
    const wrapper = await failWith("refused");
    expect(wrapper.find('[data-testid="peer-failure-local-network"]').exists()).toBe(false);
  });

  test("a start failure shows its text and the same help, reading the reason from peerError", async () => {
    userAgent(MAC);
    installBridge({
      startPeerPairing: vi.fn().mockRejectedValue(
        Object.assign(new Error("office.local:43200 did not answer. Usually it is the firewall."), {
          code: "unreachable",
          peerError: { code: "unreachable", reason: "timeout" },
        }),
      ),
    });
    const wrapper = mount(PeerConnectDialog);
    await submit(wrapper, "office.local", "43200");
    expect(wrapper.find('[data-testid="peer-connect-error"]').text()).toBe(
      "⚠office.local:43200 did not answer. Usually it is the firewall.",
    );
    expect(wrapper.find('[data-testid="peer-failure-firewall"]').text()).toContain("sudo ufw allow 43200/tcp");
    expect(wrapper.find('[data-testid="peer-failure-local-network"]').exists()).toBe(true);
  });

  test("a trailing tag in the message is no longer read as a reason", async () => {
    installBridge({ startPeerPairing: vi.fn().mockRejectedValue(new Error("It did not answer. [peer:timeout]")) });
    const wrapper = mount(PeerConnectDialog);
    await submit(wrapper, "office.local", "43200");
    expect(wrapper.find('[data-testid="peer-connect-error"]').text()).toContain("[peer:timeout]");
    expect(wrapper.find('[data-testid="peer-failure-help"]').exists()).toBe(false);
  });

  test("shows a muted line while the poll waits, for a rate limit and for a lost connection, and drops it again", async () => {
    const { retries } = installBridge();
    const wrapper = mount(PeerConnectDialog);
    await submit(wrapper, "office.local", "43200");
    const retrying = () => wrapper.find('[data-testid="peer-connect-retrying"]');
    expect(retrying().exists()).toBe(false);

    retries[0]!({ attemptId: ATTEMPT, reason: "rate-limited", retryInMs: 7000 });
    await flushPromises();
    expect(retrying().text()).toBe("The other desktop asked to wait. Trying again in 7 s.");

    retries[0]!({ attemptId: ATTEMPT, reason: "timeout", retryInMs: 4000 });
    await flushPromises();
    expect(retrying().text()).toBe("Lost the connection to the other desktop. Trying again in 4 s.");

    retries[0]!({ attemptId: ATTEMPT, reason: null, retryInMs: 0 });
    await flushPromises();
    expect(retrying().exists()).toBe(false);
  });

  test("a wait that belongs to another attempt is not shown", async () => {
    const { retries } = installBridge();
    const wrapper = mount(PeerConnectDialog);
    await submit(wrapper, "office.local", "43200");
    retries[0]!({ attemptId: "attempt-other", reason: "rate-limited", retryInMs: 3000 });
    await flushPromises();
    expect(wrapper.find('[data-testid="peer-connect-retrying"]').exists()).toBe(false);
  });

  test("a failure without a reason keeps the plain text", async () => {
    const wrapper = await failWith(undefined);
    expect(wrapper.find('[data-testid="peer-connect-result"]').text()).toContain("raw");
    expect(wrapper.find('[data-testid="peer-failure-help"]').exists()).toBe(false);
  });
});
