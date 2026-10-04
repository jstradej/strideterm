import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { reactive } from "vue";

const { useAppStoreMock } = vi.hoisted(() => ({ useAppStoreMock: vi.fn() }));
vi.mock("../../stores/app.js", () => ({ useAppStore: useAppStoreMock }));

import SshKeyTransferDialog from "./SshKeyTransferDialog.vue";
import { useSshStore } from "../../stores/ssh.js";
import type { SshKeyTransferState } from "../../../electron/shared/types/ssh.js";
import CustomSelect from "../common/CustomSelect.vue";

function makeState(operationId: string, status: SshKeyTransferState["status"]): SshKeyTransferState {
  return { operationId, hostId: "built-in", keyId: "key-1", status };
}

beforeEach(() => {
  setActivePinia(createPinia());
  useAppStoreMock.mockReturnValue(
    reactive({
      isRemoteTransport: false,
      myActiveProfileId: "profile-1",
      payload: { appState: { settings: { ssh: { defaultLaunchVia: "ssh2" } } } },
    }),
  );
  const ssh = useSshStore();
  ssh.keys = [{ id: "key-1", label: "laptop", publicKey: "ssh-ed25519 AAAA" } as never];
  ssh.hosts = [
    {
      id: "built-in",
      name: "Build server",
      host: "build.example.com",
      username: "builder",
      advanced: { launchVia: "ssh2" },
    },
    { id: "system", name: "Production", host: "prod", username: "deploy", advanced: { launchVia: "system-ssh" } },
    { id: "other", name: "Staging", host: "staging.example.com", username: "stage", advanced: { launchVia: "ssh2" } },
  ] as never;
});

async function chooseHost(wrapper: VueWrapper, hostId: string): Promise<void> {
  const picker = wrapper.findComponent(CustomSelect);
  await picker.get(".custom-select__button").trigger("click");
  const label = hostId === "built-in" ? "Build server" : "Staging";
  let option: HTMLElement | undefined;
  await vi.waitFor(() => {
    option = Array.from(document.querySelectorAll<HTMLElement>(".custom-select__option")).find((candidate) =>
      candidate.textContent?.includes(label),
    );
    expect(option).toBeDefined();
  });
  option!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
  await flushPromises();
}

describe("SshKeyTransferDialog", () => {
  test("renders inline for a fixed host and stays open if stopping the transfer fails", async () => {
    const ssh = useSshStore();
    vi.spyOn(ssh, "startKeyTransfer").mockImplementation(async () => {
      ssh.keyTransferStates = { inline: makeState("inline", "connecting") };
      return { operationId: "inline", status: "connecting" };
    });
    const stop = vi.spyOn(ssh, "stopKeyTransfer").mockRejectedValueOnce(new Error("stop rejected")).mockResolvedValue();
    const wrapper = mount(SshKeyTransferDialog, {
      props: { keyId: "key-1", profileId: "profile-1", inline: true, initialHostId: "built-in" },
    });

    expect(wrapper.classes()).toContain("ssh-key-transfer-dialog--inline");
    expect(wrapper.find(".dialog__header").exists()).toBe(false);
    expect(wrapper.findComponent(CustomSelect).exists()).toBe(false);
    expect(wrapper.text()).toContain("Target: Build server (builder@build.example.com)");
    await wrapper.get(".ssh-key-transfer-dialog__footer button.button:not(.button--ghost)").trigger("click");
    await flushPromises();
    expect(ssh.startKeyTransfer).toHaveBeenCalledWith({ profileId: "profile-1", hostId: "built-in", keyId: "key-1" });

    const requestClose = wrapper.vm.$.exposed?.requestClose as () => Promise<boolean>;
    await expect(requestClose()).resolves.toBe(false);
    await flushPromises();
    expect(wrapper.emitted("cancel")).toBeUndefined();
    expect(wrapper.text()).toContain("Could not stop the key transfer: stop rejected");

    await expect(requestClose()).resolves.toBe(true);
    expect(stop).toHaveBeenCalledTimes(2);
    expect(wrapper.emitted("cancel")).toHaveLength(1);
    wrapper.unmount();
  });

  test("uses the unsaved draft as a fixed target without requiring or creating a saved host", async () => {
    const ssh = useSshStore();
    vi.spyOn(ssh, "startKeyTransfer").mockImplementation(async () => {
      ssh.keyTransferStates = { draft: makeState("draft", "connecting") };
      return { operationId: "draft", status: "connecting" };
    });
    vi.spyOn(ssh, "stopKeyTransfer").mockResolvedValue();
    const draft = {
      host: "mini.local",
      name: "Personal host",
      username: "js",
      auth: { methods: ["publickey" as const], keyRef: "key-1" },
      advanced: { launchVia: "ssh2" as const, wsl: {} },
    };
    const wrapper = mount(SshKeyTransferDialog, {
      props: { keyId: "key-1", profileId: "profile-1", draft, inline: true },
    });

    expect(wrapper.text()).toContain("Target: Personal host (js@mini.local)");
    expect(wrapper.findComponent(CustomSelect).exists()).toBe(false);
    expect(wrapper.text()).not.toContain("Add a saved host");
    await wrapper.setProps({ draft: { ...draft, name: "js@mini.local" } });
    expect(wrapper.text()).toContain("Target: js@mini.local");
    await wrapper.setProps({ draft });
    await wrapper.get(".ssh-key-transfer-dialog__footer button.button:not(.button--ghost)").trigger("click");
    expect(ssh.startKeyTransfer).toHaveBeenCalledWith({ profileId: "profile-1", keyId: "key-1", draft });
    expect(ssh.hosts).toHaveLength(3);

    await wrapper.get(".ssh-key-transfer-dialog__footer .button--ghost").trigger("click");
    expect(wrapper.emitted("cancel")).toHaveLength(1);
    wrapper.unmount();
  });

  test("restricts target choice to Built-in SSH and reports verification only after the final state", async () => {
    const ssh = useSshStore();
    vi.spyOn(ssh, "startKeyTransfer").mockImplementation(async () => {
      ssh.keyTransferStates = { op1: makeState("op1", "connecting") };
      return { operationId: "op1", status: "connecting" };
    });
    const stop = vi.spyOn(ssh, "stopKeyTransfer").mockResolvedValue();
    const wrapper = mount(SshKeyTransferDialog, { props: { keyId: "key-1", profileId: "profile-1" } });

    const picker = wrapper.findComponent(CustomSelect);
    expect(wrapper.find("label.field").text()).toContain("Saved host");
    await picker.get(".custom-select__button").trigger("click");
    const systemOption = Array.from(document.querySelectorAll<HTMLElement>('[role="option"]')).find((option) =>
      option.textContent?.includes("Production"),
    );
    expect(systemOption?.getAttribute("aria-disabled")).toBe("true");
    const builtInOption = Array.from(document.querySelectorAll<HTMLElement>('[role="option"]')).find((option) =>
      option.textContent?.includes("Build server"),
    );
    builtInOption!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    await flushPromises();
    await chooseHost(wrapper, "built-in");
    await wrapper.get(".dialog__footer button.button:not(.button--ghost)").trigger("click");

    expect(ssh.startKeyTransfer).toHaveBeenCalledWith({ profileId: "profile-1", hostId: "built-in", keyId: "key-1" });
    expect(wrapper.text()).toContain("Connecting to the selected host");
    expect(wrapper.text()).not.toContain("sign-in succeeded");

    ssh.keyTransferStates = { op1: makeState("op1", "verifying") };
    picker.vm.$emit("update:modelValue", "other");
    await flushPromises();
    expect(wrapper.text()).toContain("Checking that the key can sign in");
    expect(wrapper.text()).not.toContain("sign-in succeeded");

    ssh.keyTransferStates = { op1: makeState("op1", "installed") };
    await flushPromises();
    expect(wrapper.text()).toContain(
      "Public key transferred successfully. “laptop” can now sign in to Build server (builder@build.example.com). Select it in a saved host's Built-in SSH settings to use it.",
    );
    await wrapper.get(".dialog__footer .button--ghost").trigger("click");
    expect(stop).toHaveBeenCalledWith("op1");
    expect(wrapper.emitted("cancel")).toHaveLength(1);
    wrapper.unmount();
  });

  test("stopping while start is pending waits for its operation id and cleans it up before closing", async () => {
    const ssh = useSshStore();
    let resolveStart!: (_result: { operationId: string; status: "connecting" }) => void;
    vi.spyOn(ssh, "startKeyTransfer").mockReturnValue(
      new Promise((resolve) => {
        resolveStart = resolve;
      }),
    );
    const stop = vi.spyOn(ssh, "stopKeyTransfer").mockResolvedValue();
    const wrapper = mount(SshKeyTransferDialog, { props: { keyId: "key-1", profileId: "profile-1" } });
    await chooseHost(wrapper, "built-in");

    void wrapper.get(".dialog__footer button.button:not(.button--ghost)").trigger("click");
    await flushPromises();
    void wrapper.get(".dialog__footer .button--ghost").trigger("click");
    await flushPromises();
    expect(wrapper.emitted("cancel")).toBeUndefined();

    resolveStart({ operationId: "op-late", status: "connecting" });
    await vi.waitFor(() => expect(stop).toHaveBeenCalledWith("op-late"));
    await vi.waitFor(() => expect(wrapper.emitted("cancel")).toHaveLength(1));
    wrapper.unmount();
  });

  test("reports a failed verification as partial success without claiming login worked", async () => {
    const ssh = useSshStore();
    vi.spyOn(ssh, "startKeyTransfer").mockImplementation(async () => {
      ssh.keyTransferStates = { partial: makeState("partial", "connecting") };
      return { operationId: "partial", status: "connecting" };
    });
    vi.spyOn(ssh, "stopKeyTransfer").mockResolvedValue();
    const wrapper = mount(SshKeyTransferDialog, { props: { keyId: "key-1", profileId: "profile-1" } });
    await chooseHost(wrapper, "built-in");
    await wrapper.get(".dialog__footer button.button:not(.button--ghost)").trigger("click");
    ssh.keyTransferStates = {
      partial: {
        ...makeState("partial", "verification-failed"),
        remoteMayHaveChanged: true,
        error: "The server requested another login method.",
      },
    };
    await flushPromises();

    expect(wrapper.text()).toContain("public key is installed or already present");
    expect(wrapper.text()).toContain("key-only sign-in could not be verified");
    expect(wrapper.text()).not.toContain("key-only sign-in succeeded");
    wrapper.unmount();
  });

  test("preserves the installed-key result when verification is cancelled afterward", async () => {
    const ssh = useSshStore();
    vi.spyOn(ssh, "startKeyTransfer").mockImplementation(async () => {
      ssh.keyTransferStates = { cancelled: makeState("cancelled", "connecting") };
      return { operationId: "cancelled", status: "connecting" };
    });
    vi.spyOn(ssh, "stopKeyTransfer").mockResolvedValue();
    const wrapper = mount(SshKeyTransferDialog, { props: { keyId: "key-1", profileId: "profile-1" } });
    await chooseHost(wrapper, "built-in");
    await wrapper.get(".dialog__footer button.button:not(.button--ghost)").trigger("click");
    ssh.keyTransferStates = {
      cancelled: {
        ...makeState("cancelled", "cancelled"),
        installed: true,
      },
    };
    await flushPromises();

    expect(wrapper.text()).toContain("Public key is installed or already present; verification was cancelled.");
    expect(wrapper.text()).not.toContain("Transfer cancelled.");
    wrapper.unmount();
  });

  test("profile change stops the active transfer and returns to the key list", async () => {
    const ssh = useSshStore();
    vi.spyOn(ssh, "startKeyTransfer").mockImplementation(async () => {
      ssh.keyTransferStates = { "op-profile": makeState("op-profile", "connecting") };
      return { operationId: "op-profile", status: "connecting" };
    });
    const stop = vi.spyOn(ssh, "stopKeyTransfer").mockResolvedValue();
    const app = useAppStoreMock();
    const wrapper = mount(SshKeyTransferDialog, { props: { keyId: "key-1", profileId: "profile-1" } });
    await chooseHost(wrapper, "built-in");
    await wrapper.get(".dialog__footer button.button:not(.button--ghost)").trigger("click");
    await flushPromises();

    app.myActiveProfileId = "profile-2";
    await vi.waitFor(() => expect(stop).toHaveBeenCalledWith("op-profile"));
    await vi.waitFor(() => expect(wrapper.emitted("cancel")).toHaveLength(1));
    wrapper.unmount();
  });
});
