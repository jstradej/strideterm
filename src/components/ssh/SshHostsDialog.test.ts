import { mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { useAppStore } from "../../stores/app.js";
import { useSshStore } from "../../stores/ssh.js";
import SshHostsDialog from "./SshHostsDialog.vue";
import { flushPromises } from "@vue/test-utils";

vi.mock("../workspace/TerminalPane.vue", () => ({ default: { template: "<div class='terminal-pane-stub' />" } }));

function createTestTransport(
  start: () => Promise<{ sessionId: string; mode: "ssh2" | "system-ssh"; status: "authenticated" | "process-running" }>,
  savedHosts: unknown[] = [],
) {
  return {
    isRemote: false,
    sshHostsList: vi.fn(async () => savedHosts),
    sshKeysList: vi.fn(async () => []),
    sshCertsList: vi.fn(async () => []),
    sshCapabilitiesGet: vi.fn(async () => ({ permissions: { canManageHosts: true }, systemSsh: true })),
    sshTestStart: vi.fn(start),
    sshTestStop: vi.fn(async () => ({ ok: true })),
    onSshTestState: vi.fn(),
    onSshState: vi.fn(),
    onSshConnectionState: vi.fn(),
    onSshAuthPrompt: vi.fn(),
    onSshAuthPromptCancel: vi.fn(),
    onSshHostKeyChange: vi.fn(),
    sshHostsCreate: vi.fn(),
    sshHostsUpdate: vi.fn(),
  };
}

const hosts = [
  { id: "host-1", name: "Production", host: "prod.example.com", auth: { methods: ["agent"] }, advanced: {} },
  { id: "host-2", name: "Staging", host: "staging.example.com", auth: { methods: ["agent"] }, advanced: {} },
];

describe("SshHostsDialog", () => {
  beforeEach(() => setActivePinia(createPinia()));

  test("embedded host book header aligns title, help, search and compact Add Host action", async () => {
    const ssh = useSshStore();
    ssh.hosts = [
      { id: "host-1", name: "Production", host: "prod.example.com" },
      { id: "host-2", name: "Staging", host: "stage.example.com" },
    ] as never;
    ssh.capabilities = { permissions: { canManageHosts: true } } as never;
    const wrapper = mount(SshHostsDialog, { props: { embedded: true } });

    expect(wrapper.get(".ssh-hosts-dialog__toolbar-title h3").text()).toBe("Saved hosts");
    expect(wrapper.get('[aria-label="Saved host book help"]').exists()).toBe(true);
    expect(wrapper.get('[aria-label="Search saved hosts"]').attributes("placeholder")).toBe("Search hosts…");
    expect(wrapper.get(".ssh-hosts-dialog__toolbar-actions .button").classes()).toContain("button--small");
    await wrapper.get('[aria-label="Search saved hosts"]').setValue("prod");
    expect(wrapper.findAll(".ssh-host-card")).toHaveLength(1);
    expect(wrapper.get(".ssh-host-card").text()).toContain("prod.example.com");
    wrapper.unmount();
  });

  test("standalone host management retains its own heading and hides embedded heading", () => {
    const wrapper = mount(SshHostsDialog);
    expect(wrapper.get(".dialog__header h2").text()).toBe("Manage Hosts");
    expect(wrapper.find(".ssh-hosts-dialog__toolbar-title").exists()).toBe(false);
    wrapper.unmount();
  });

  test("canceling the in-app host deletion confirmation leaves the host untouched", async () => {
    const app = useAppStore();
    const confirmInApp = vi.spyOn(app, "confirmInApp").mockResolvedValue(false);
    const nativeConfirm = vi.spyOn(window, "confirm");
    const ssh = useSshStore();
    ssh.capabilities = { permissions: { canManageHosts: true } } as never;
    ssh.hosts = [{ id: "host-1", name: "Production", host: "prod.example.com" } as never];
    const deleteHost = vi.spyOn(ssh, "deleteHost");
    const wrapper = mount(SshHostsDialog);

    await wrapper.get(".ssh-host-card__actions .button--danger").trigger("click");

    expect(confirmInApp).toHaveBeenCalledWith(
      expect.objectContaining({ cancelLabel: "Cancel", confirmLabel: "Delete host", danger: true }),
    );
    expect(deleteHost).not.toHaveBeenCalled();
    expect(nativeConfirm).not.toHaveBeenCalled();
    expect(ssh.hosts).toHaveLength(1);
    wrapper.unmount();
  });

  test("Add Host stops an inline transfer first and stays on the list if stopping fails", async () => {
    const app = useAppStore();
    app.payload = { appState: { settings: { ssh: { defaultLaunchVia: "ssh2" } } } } as never;
    const ssh = useSshStore();
    ssh.capabilities = { permissions: { canManageHosts: true } } as never;
    ssh.hosts = [
      {
        id: "host-1",
        name: "Build",
        host: "build.example.com",
        username: "builder",
        auth: { methods: ["publickey"], keyRef: "key-1" },
        advanced: { launchVia: "ssh2" },
      } as never,
    ];
    ssh.keys = [{ id: "key-1", label: "Build key", publicKey: "ssh-ed25519 AAAA" } as never];
    vi.spyOn(ssh, "startKeyTransfer").mockImplementation(async () => {
      ssh.keyTransferStates = {
        transfer: { operationId: "transfer", hostId: "host-1", keyId: "key-1", status: "connecting" },
      };
      return { operationId: "transfer", status: "connecting" };
    });
    const stop = vi.spyOn(ssh, "stopKeyTransfer").mockRejectedValue(new Error("stop rejected"));
    const wrapper = mount(SshHostsDialog);

    await wrapper
      .findAll(".ssh-host-card__actions button")
      .find((button) => button.text().includes("Transfer public key"))!
      .trigger("click");
    await wrapper.get(".ssh-key-transfer-dialog__footer button.button:not(.button--ghost)").trigger("click");
    await flushPromises();
    await wrapper.get(".ssh-hosts-dialog__toolbar .button").trigger("click");
    await flushPromises();

    expect(stop).toHaveBeenCalledWith("transfer");
    expect(wrapper.find(".ssh-host-editor").exists()).toBe(false);
    expect(wrapper.find(".ssh-key-transfer-dialog--inline").exists()).toBe(true);
    expect(wrapper.text()).toContain("Could not stop the key transfer: stop rejected");
    wrapper.unmount();
  });

  test("tests only the selected host inline and keeps OpenSSH process status neutral", async () => {
    let finishStart!: (result: { sessionId: string; mode: "system-ssh"; status: "process-running" }) => void;
    const api = createTestTransport(
      () =>
        new Promise((resolve) => (finishStart = resolve)) as Promise<{
          sessionId: string;
          mode: "system-ssh";
          status: "process-running";
        }>,
      hosts,
    );
    const app = useAppStore();
    const quickAdd = vi.spyOn(app, "quickAddTemplateTab");
    const ssh = useSshStore();
    ssh.init(api as never);
    ssh.bindEvents();
    ssh.hosts = hosts as never;
    ssh.capabilities = { permissions: { canManageHosts: true }, systemSsh: true } as never;
    const wrapper = mount(SshHostsDialog);
    await flushPromises();

    const cards = wrapper.findAll(".ssh-host-card");
    const firstTest = cards[0].findAll("button").find((button) => button.text().includes("Test connection"))!;
    await firstTest.trigger("click");
    await flushPromises();
    expect(cards[0].text()).toContain("Testing…");
    expect(cards[0].findComponent({ name: "Spinner" }).exists()).toBe(true);
    expect(
      cards[1]
        .findAll("button")
        .find((button) => button.text().includes("Test connection"))
        ?.attributes("disabled"),
    ).toBeDefined();
    expect(cards[1].findComponent({ name: "Spinner" }).exists()).toBe(false);

    finishStart({ sessionId: "ssh-test:row", mode: "system-ssh", status: "process-running" });
    await flushPromises();
    expect(cards[0].text()).toContain("verification is pending");
    expect(cards[0].find(".terminal-pane-stub").exists()).toBe(true);
    expect(cards[0].find(".success").exists()).toBe(false);
    await cards[0]
      .findAll("button")
      .find((button) => button.text() === "Stop test")!
      .trigger("click");
    await flushPromises();

    expect(api.sshTestStop).toHaveBeenCalledWith({ sessionId: "ssh-test:row" });
    expect(cards[0].text()).toContain("SSH process started; authentication was not confirmed.");
    expect(api.sshHostsCreate).not.toHaveBeenCalled();
    expect(api.sshHostsUpdate).not.toHaveBeenCalled();
    expect(quickAdd).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  test("reports Built-in authentication success directly on its row after cleanup", async () => {
    const api = createTestTransport(
      async () => ({
        sessionId: "ssh-test:builtin-row",
        mode: "ssh2",
        status: "authenticated",
      }),
      [hosts[0]],
    );
    const ssh = useSshStore();
    ssh.init(api as never);
    ssh.hosts = [hosts[0]] as never;
    ssh.capabilities = { permissions: { canManageHosts: true } } as never;
    const wrapper = mount(SshHostsDialog);
    await wrapper
      .findAll(".ssh-host-card button")
      .find((button) => button.text().includes("Test connection"))!
      .trigger("click");
    await vi.waitFor(() => expect(wrapper.text()).toContain("Authentication succeeded."));

    expect(api.sshTestStop).toHaveBeenCalledWith({ sessionId: "ssh-test:builtin-row" });
    expect(wrapper.find(".ssh-host-card .ssh-connection-test").exists()).toBe(false);
    expect(wrapper.get(".ssh-host-card__test-result--success").text()).toBe("Authentication succeeded.");
    wrapper.unmount();
  });

  test("keeps a failed test on its host row and retries the same host", async () => {
    const api = createTestTransport(
      async () => ({
        sessionId: "ssh-test:retry-row",
        mode: "ssh2",
        status: "authenticated",
      }),
      [hosts[0]],
    );
    api.sshTestStart.mockRejectedValueOnce(new Error("Connection refused"));
    const ssh = useSshStore();
    ssh.init(api as never);
    ssh.hosts = [hosts[0]] as never;
    ssh.capabilities = { permissions: { canManageHosts: true } } as never;
    const wrapper = mount(SshHostsDialog);

    await wrapper
      .findAll(".ssh-host-card button")
      .find((button) => button.text().includes("Test connection"))!
      .trigger("click");
    await vi.waitFor(() => expect(wrapper.text()).toContain("Connection refused"));
    expect(wrapper.find(".ssh-host-card__test-result--error").exists()).toBe(true);
    await wrapper
      .findAll(".ssh-host-card button")
      .find((button) => button.text().includes("Test again"))!
      .trigger("click");
    await vi.waitFor(() => expect(wrapper.text()).toContain("Authentication succeeded."));

    expect(api.sshTestStart).toHaveBeenCalledTimes(2);
    expect(api.sshTestStop).toHaveBeenCalledWith({ sessionId: "ssh-test:retry-row" });
    wrapper.unmount();
  });

  test("waits for automatic Built-in cleanup already in progress before closing Manage Hosts", async () => {
    const api = createTestTransport(
      async () => ({
        sessionId: "ssh-test-close-parent",
        mode: "ssh2",
        status: "authenticated",
      }),
      [hosts[0]],
    );
    let finishStop!: (result: { ok: true }) => void;
    api.sshTestStop.mockImplementation(() => new Promise((resolve) => (finishStop = resolve)) as Promise<{ ok: true }>);
    const ssh = useSshStore();
    ssh.init(api as never);
    ssh.hosts = [hosts[0]] as never;
    ssh.capabilities = { permissions: { canManageHosts: true } } as never;
    const wrapper = mount(SshHostsDialog);
    await wrapper
      .findAll(".ssh-host-card button")
      .find((button) => button.text().includes("Test connection"))!
      .trigger("click");
    await flushPromises();

    await vi.waitFor(() => expect(api.sshTestStop).toHaveBeenCalled());
    expect(wrapper.find(".dialog__header button").exists()).toBe(false);
    await wrapper.get(".ssh-hosts-dialog__footer button").trigger("click");
    await flushPromises();
    expect(wrapper.emitted("cancel")).toBeFalsy();
    finishStop({ ok: true });
    await vi.waitFor(() => expect(wrapper.emitted("cancel")).toBeTruthy());

    wrapper.unmount();
  });
});
