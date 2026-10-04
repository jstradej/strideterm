import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { defineComponent, h, nextTick } from "vue";
import DialogOverlay from "./DialogOverlay.vue";
import { useAppStore } from "../../stores/app.js";
import { useSshStore } from "../../stores/ssh.js";
import { apiKey } from "../../types/keys.js";
import SshAuthPrompt from "../ssh/SshAuthPrompt.vue";
import SshHostKeyWarning from "../ssh/SshHostKeyWarning.vue";

let testPinia = createPinia();

function statePayload() {
  const workspace = {
    id: "ws-1",
    name: "Terminal",
    profileId: "profile-1",
    kind: "terminal",
    cwd: "C:/work",
    panels: [],
    activePanelId: "",
  };
  return {
    meta: { appVersion: "test", platform: "win32", repositoryUrl: "", versionCheck: null, recoveryCandidates: [] },
    appState: {
      activeWorkspaceId: workspace.id,
      profiles: [{ id: "profile-1", name: "Default", color: "#fff", workspaceIds: [workspace.id] }],
      workspaces: [workspace],
      windowSlots: [{ id: "window-1", profileId: "profile-1", activeWorkspaceId: workspace.id, activeSessionId: "" }],
      settings: { ssh: { defaultLaunchVia: "system-ssh", requireEncryptedStorage: true } },
      tabTemplates: [],
      ssh: { hosts: [], keys: [], certificates: [], knownHosts: {}, settings: {} },
    },
    workspace: { workspace, project: workspace, sessions: [] },
    attention: { sessions: {}, alerts: [] },
    docker: { available: false, backend: null, contexts: [], containers: [], error: "" },
    git: { workspaces: {}, activeWorkspace: null, connections: [] },
    azureDevops: { inboxItems: [], connections: [], lastUpdatedAt: null, error: "" },
    github: { inboxItems: [], connections: [], lastUpdatedAt: null, error: "" },
    reviewBridge: { sessions: {}, enabled: false },
    plugins: [],
    environment: {},
    remoteAccess: { enabled: false },
    taskRunner: {},
  };
}

function createTransport() {
  const payload = statePayload();
  const api = {
    isRemote: false,
    getState: vi.fn(async () => payload),
    onStateUpdated: (_handler: (_value: unknown) => void) => undefined,
    onConnectionState: (_handler: (_value: unknown) => void) => undefined,
    onSshAuthPrompt: (_handler: (_value: unknown) => void) => undefined,
    onSshAuthPromptCancel: (_handler: (_value: unknown) => void) => undefined,
    onSshHostKeyChange: (_handler: (_value: unknown) => void) => undefined,
    onSshState: (_handler: (_value: unknown) => void) => undefined,
    onSshConnectionState: (_handler: (_value: unknown) => void) => undefined,
    getAgentNotifyHookStatus: vi.fn(async () => ({})),
    getAgentNotifyHookMetrics: vi.fn(async () => null),
    getClaudeHookStatus: vi.fn(async () => ({ status: "configured" })),
    sshCapabilitiesGet: vi.fn(async () => ({
      platform: "win32",
      systemSsh: true,
      safeStorageAvailable: true,
      openSshAgent: true,
      permissions: { canManageHosts: true },
      wsl: { installed: true, distros: ["Ubuntu"] },
    })),
    sshHostsList: vi.fn(async () => []),
    sshHostsCreate: vi.fn(async () => ({ id: "unexpected-create" })),
    sshHostsUpdate: vi.fn(async (payload: { id: string; patch: Record<string, unknown> }) => ({
      ...payload.patch,
      id: payload.id,
    })),
    sshKeysList: vi.fn(async () => []),
    sshKeysGenerate: vi.fn(async () => ({ id: "generated-key", label: "Work laptop" })),
    sshKeysRename: vi.fn(async (_payload: { id: string; label: string }) => null),
    sshCertsList: vi.fn(async () => []),
    sshTestStart: vi.fn(async (_request: { profileId: string; draft: Record<string, unknown> }) => ({
      sessionId: "ssh-test:host-editor-flow",
      mode: "ssh2" as const,
      status: "authenticated" as const,
    })),
    sshTestStop: vi.fn(async () => ({ ok: true })),
    onSshTestState: (_handler: (_value: unknown) => void) => undefined,
    sshKeysTransferStart: vi.fn(async () => ({
      operationId: "ssh-transfer:dialog-flow",
      status: "connecting" as const,
    })),
    sshKeysTransferStop: vi.fn(async () => ({ ok: true })),
    sshAuthAnswer: vi.fn(async () => undefined),
    sshAuthCancel: vi.fn(async () => undefined),
    sshHostKeyAccept: vi.fn(async () => undefined),
    sshHostKeyReject: vi.fn(async () => undefined),
    updateSettings: vi.fn(async () => payload),
    saveWorkspace: vi.fn(async () => {
      throw new Error("Workspace save rejected");
    }),
  };
  return api;
}

async function untilMounted(selector: string) {
  await vi.waitFor(() => expect(document.querySelector(selector)).not.toBeNull(), { timeout: 10_000, interval: 25 });
}

async function untilGone(selector: string) {
  await vi.waitFor(() => expect(document.querySelector(selector)).toBeNull(), { timeout: 10_000, interval: 25 });
}

describe("SSH dialog navigation flow", () => {
  beforeEach(() => {
    testPinia = createPinia();
    setActivePinia(testPinia);
    document.body.innerHTML = "";
    (window as unknown as { strideterm?: { startupFlags?: { windowId?: string } } }).strideterm = {
      startupFlags: { windowId: "window-1" },
    };
  });

  test("returns from key import to the unchanged host draft, then restores host search and Settings draft", async () => {
    const api = createTransport();
    const appStore = useAppStore();
    const sshStore = useSshStore();
    appStore.init(api as never);
    sshStore.init(api as never);
    sshStore.bindEvents();
    await flushPromises();

    appStore.openSettingsDialog({ initialTab: "ssh" });
    const wrapper = mount(DialogOverlay, {
      attachTo: document.body,
      global: { provide: { [apiKey]: api } },
    });
    await untilMounted(".settings-dialog");
    await vi.waitFor(() => expect(document.querySelector(".settings-ssh-tab")).not.toBeNull());

    const defaultMethod = document.querySelector<HTMLButtonElement>(".settings-ssh-tab .custom-select__button");
    expect(defaultMethod?.textContent).toContain("SSH on this computer");
    await defaultMethod!.click();
    await nextTick();
    const builtInOption = Array.from(document.querySelectorAll<HTMLElement>(".custom-select__option")).find((option) =>
      option.textContent?.includes("Built-in SSH"),
    );
    expect(builtInOption).toBeDefined();
    await builtInOption!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    await nextTick();

    const settingsSsh = document.querySelector<HTMLElement>(".settings-ssh-tab")!;
    const hostsTab = settingsSsh.querySelector<HTMLButtonElement>(
      '[role="tab"][aria-controls="ssh-settings-panel-hosts"]',
    );
    await hostsTab!.click();
    await untilMounted(".ssh-hosts-dialog");

    const search = document.querySelector<HTMLInputElement>(".ssh-hosts-dialog__toolbar input")!;
    search.value = "staging-search";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    await nextTick();

    const addHost = document.querySelector<HTMLButtonElement>(".ssh-hosts-dialog__toolbar-actions button")!;
    await addHost.click();
    await untilMounted(".ssh-host-editor");
    const hostInput = document.querySelector<HTMLInputElement>(
      '.ssh-host-editor input[placeholder="server.example.com or prod"]',
    )!;
    hostInput.value = "draft.example.net";
    hostInput.dispatchEvent(new Event("input", { bubbles: true }));
    await nextTick();
    const usernameInput = document.querySelector<HTMLInputElement>('.ssh-host-editor input[placeholder="alice"]')!;
    usernameInput.value = "admin";
    usernameInput.dispatchEvent(new Event("input", { bubbles: true }));
    const displayNameInput = document.querySelector<HTMLInputElement>(
      '.ssh-host-editor input[placeholder="Defaults to host or alias"]',
    )!;
    displayNameInput.value = "Development host";
    displayNameInput.dispatchEvent(new Event("input", { bubbles: true }));
    await nextTick();

    const hostLaunchSelect = document.querySelector<HTMLButtonElement>(".ssh-host-editor .custom-select__button")!;
    await hostLaunchSelect.click();
    const hostBuiltInOption = Array.from(document.querySelectorAll<HTMLElement>(".custom-select__option")).find(
      (option) => option.textContent?.includes("Built-in SSH"),
    );
    expect(hostBuiltInOption).toBeDefined();
    hostBuiltInOption!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    await nextTick();

    const authSelect = document.querySelectorAll<HTMLButtonElement>(".ssh-host-editor .custom-select__button")[1];
    await authSelect.click();
    const keyAuthOption = Array.from(document.querySelectorAll<HTMLElement>(".custom-select__option")).find((option) =>
      option.textContent?.includes("Key stored in strIDEterm"),
    );
    expect(keyAuthOption).toBeDefined();
    keyAuthOption!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    await nextTick();

    const importButton = Array.from(document.querySelectorAll<HTMLButtonElement>(".ssh-host-editor button")).find(
      (button) => button.textContent?.includes("Import…"),
    );
    await importButton!.click();
    await untilMounted(".ssh-key-import");
    expect(appStore.dialogLayers.map((layer) => layer.name)).toEqual(["SettingsDialog"]);
    const keyText = document.querySelector<HTMLTextAreaElement>(".ssh-key-import textarea")!;
    keyText.value = "-----BEGIN OPENSSH PRIVATE KEY-----\nunsaved draft\n-----END OPENSSH PRIVATE KEY-----";
    keyText.dispatchEvent(new Event("input", { bubbles: true }));
    await nextTick();

    const nativeConfirm = vi.spyOn(window, "confirm");
    const importBack = document.querySelector<HTMLButtonElement>(
      ".ssh-key-import .ssh-embedded-header__actions button.button--ghost",
    )!;
    await importBack.click();
    await untilMounted(".confirm-dialog");
    expect(document.querySelector(".ssh-key-import")).not.toBeNull();
    expect(document.querySelector(".confirm-dialog")?.textContent).toContain("Keep editing");
    expect(document.querySelector(".confirm-dialog")?.textContent).toContain("Discard changes");
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await untilGone(".confirm-dialog");
    expect(document.querySelector<HTMLTextAreaElement>(".ssh-key-import textarea")?.value).toContain("unsaved draft");
    await importBack.click();
    await untilMounted(".confirm-dialog");
    const discardImport = Array.from(document.querySelectorAll<HTMLButtonElement>(".confirm-dialog button")).find(
      (button) => button.textContent?.includes("Discard changes"),
    );
    await discardImport!.click();
    await untilGone(".confirm-dialog");
    await untilGone(".ssh-key-import");
    await untilMounted(".ssh-host-editor");
    expect(
      document.querySelector<HTMLInputElement>('.ssh-host-editor input[placeholder="server.example.com or prod"]')
        ?.value,
    ).toBe("draft.example.net");

    api.sshKeysList.mockResolvedValue([
      {
        id: "generated-key",
        label: "Work laptop",
        kind: "ed25519",
        publicKey: "ssh-ed25519 AAAA",
        hasPassphrase: false,
        createdAt: "2026-01-01",
      },
    ] as never);
    const generateButton = Array.from(document.querySelectorAll<HTMLButtonElement>(".ssh-host-editor button")).find(
      (button) => button.textContent?.includes("Generate…"),
    );
    await generateButton!.click();
    await untilMounted(".ssh-key-generate");
    expect(appStore.dialogLayers.map((layer) => layer.name)).toEqual(["SettingsDialog"]);
    const generateKey = Array.from(document.querySelectorAll<HTMLButtonElement>(".ssh-key-generate button")).find(
      (button) => button.textContent?.trim() === "Generate",
    );
    await generateKey!.click();
    await untilGone(".ssh-key-generate");
    await untilMounted(".ssh-host-editor");
    expect(
      document.querySelectorAll<HTMLButtonElement>(".ssh-host-editor .custom-select__button")[2]?.textContent,
    ).toContain("Work laptop");
    expect(
      document.querySelector<HTMLInputElement>('.ssh-host-editor input[placeholder="server.example.com or prod"]')
        ?.value,
    ).toBe("draft.example.net");
    expect(document.querySelector<HTMLInputElement>('.ssh-host-editor input[placeholder="alice"]')?.value).toBe(
      "admin",
    );
    expect(
      document.querySelector<HTMLInputElement>('.ssh-host-editor input[placeholder="Defaults to host or alias"]')
        ?.value,
    ).toBe("Development host");

    const transferButton = Array.from(document.querySelectorAll<HTMLButtonElement>(".ssh-host-editor button")).find(
      (button) => button.textContent?.includes("Transfer public key"),
    );
    expect(transferButton).toBeDefined();
    await transferButton!.click();
    await untilMounted(".ssh-key-transfer-dialog--inline");
    expect(
      document
        .querySelector<HTMLInputElement>('.ssh-host-editor input[placeholder="server.example.com or prod"]')
        ?.closest("fieldset")?.disabled,
    ).toBe(true);
    await document
      .querySelector<HTMLButtonElement>(".ssh-key-transfer-dialog__footer button.button:not(.button--ghost)")!
      .click();
    const testHostButton = () =>
      Array.from(document.querySelectorAll<HTMLButtonElement>(".ssh-host-editor__heading-actions button")).find(
        (button) => button.textContent?.includes("Test connection"),
      )!;
    const saveHostButton = () =>
      Array.from(document.querySelectorAll<HTMLButtonElement>(".ssh-host-editor__heading-actions button")).find(
        (button) => button.textContent?.includes("Save host"),
      )!;
    expect(testHostButton().disabled).toBe(true);
    expect(saveHostButton().disabled).toBe(true);
    await vi.waitFor(() =>
      expect(api.sshKeysTransferStart).toHaveBeenCalledWith({
        profileId: "profile-1",
        keyId: "generated-key",
        draft: expect.objectContaining({
          host: "draft.example.net",
          username: "admin",
          name: "Development host",
          auth: expect.objectContaining({ methods: ["publickey"], keyRef: "generated-key" }),
          advanced: expect.objectContaining({ launchVia: "ssh2" }),
        }),
      }),
    );
    expect(api.sshHostsCreate).not.toHaveBeenCalled();
    const transferOperationId = "ssh-transfer:dialog-flow";
    sshStore.keyTransferStates = {
      [transferOperationId]: {
        operationId: transferOperationId,
        hostId: "ephemeral-draft-target",
        keyId: "generated-key",
        status: "installed",
      },
    };
    await vi.waitFor(() =>
      expect(document.querySelector(".ssh-key-transfer-dialog--inline")?.textContent).toContain(
        "Development host (admin@draft.example.net)",
      ),
    );
    await vi.waitFor(() =>
      expect(document.querySelector(".ssh-key-transfer-dialog--inline")?.textContent).toContain(
        "Public key transferred successfully.",
      ),
    );
    expect(testHostButton().disabled).toBe(false);
    expect(saveHostButton().disabled).toBe(false);
    expect(document.querySelector(".ssh-key-transfer-dialog--inline")?.textContent).toContain("Save this host");
    api.sshKeysTransferStop.mockRejectedValueOnce(new Error("transfer cleanup failed"));
    await testHostButton().click();
    await vi.waitFor(() =>
      expect(document.querySelector(".ssh-key-transfer-dialog--inline [role=alert]")?.textContent).toContain(
        "Could not stop the key transfer",
      ),
    );
    expect(api.sshTestStart).not.toHaveBeenCalled();
    expect(document.querySelector(".ssh-key-transfer-dialog--inline")).not.toBeNull();
    await document.querySelector<HTMLButtonElement>(".ssh-key-transfer-dialog__footer .button--ghost")!.click();
    await untilGone(".ssh-key-transfer-dialog--inline");
    await untilMounted(".ssh-host-editor");
    expect(document.querySelector<HTMLInputElement>('.ssh-host-editor input[placeholder="alice"]')?.value).toBe(
      "admin",
    );
    expect(
      document.querySelector<HTMLInputElement>('.ssh-host-editor input[placeholder="Defaults to host or alias"]')
        ?.value,
    ).toBe("Development host");

    api.sshTestStart.mockResolvedValue({ sessionId: "ssh-test:draft", mode: "ssh2", status: "connecting" } as never);
    await testHostButton().click();
    await untilMounted(".ssh-connection-test");
    expect(api.sshHostsCreate).not.toHaveBeenCalled();
    expect(api.sshTestStart).toHaveBeenCalledWith(
      expect.objectContaining({
        profileId: "profile-1",
        draft: expect.objectContaining({
          host: "draft.example.net",
          username: "admin",
          name: "Development host",
          auth: expect.objectContaining({ methods: ["publickey"], keyRef: "generated-key" }),
        }),
      }),
    );
    await vi.waitFor(() =>
      expect(document.querySelector<HTMLButtonElement>(".ssh-embedded-header__actions button")?.disabled).toBe(false),
    );
    await document.querySelector<HTMLButtonElement>(".ssh-embedded-header__actions button")!.click();
    await vi.waitFor(() => expect(api.sshTestStop).toHaveBeenCalledWith({ sessionId: "ssh-test:draft" }));
    await untilGone(".ssh-connection-test");
    await untilMounted(".ssh-host-editor");

    await document.querySelector<HTMLButtonElement>(".settings-footer .button--ghost")!.click();
    await untilMounted(".confirm-dialog");
    expect(document.querySelector(".settings-dialog")).not.toBeNull();
    await Array.from(document.querySelectorAll<HTMLButtonElement>(".confirm-dialog button"))
      .find((button) => button.textContent?.includes("Keep editing"))!
      .click();
    await untilGone(".confirm-dialog");
    expect(
      document.querySelector<HTMLInputElement>('.ssh-host-editor input[placeholder="server.example.com or prod"]')
        ?.value,
    ).toBe("draft.example.net");
    expect(
      document.querySelectorAll<HTMLButtonElement>(".ssh-host-editor .custom-select__button")[2]?.textContent,
    ).toContain("Work laptop");

    const hostBack = document.querySelector<HTMLButtonElement>(".ssh-host-editor__heading-actions .button--ghost")!;
    await hostBack.click();
    await untilMounted(".confirm-dialog");
    const activeOverlay = document.querySelector<HTMLElement>(".overlay:not(.overlay--inactive)")!;
    activeOverlay.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await untilGone(".confirm-dialog");
    expect(
      document.querySelector<HTMLInputElement>('.ssh-host-editor input[placeholder="server.example.com or prod"]')
        ?.value,
    ).toBe("draft.example.net");
    await hostBack.click();
    await untilMounted(".confirm-dialog");
    const discardHost = Array.from(document.querySelectorAll<HTMLButtonElement>(".confirm-dialog button")).find(
      (button) => button.textContent?.includes("Discard changes"),
    );
    await discardHost!.click();
    await untilGone(".confirm-dialog");
    await untilGone(".ssh-host-editor");
    await untilMounted(".ssh-hosts-dialog");
    expect(document.querySelector<HTMLInputElement>(".ssh-hosts-dialog__toolbar input")?.value).toBe("staging-search");

    const defaultTab = settingsSsh.querySelector<HTMLButtonElement>(
      '[role="tab"][aria-controls="ssh-settings-panel-default"]',
    )!;
    await defaultTab.click();
    await untilGone(".ssh-hosts-dialog");
    await untilMounted(".settings-dialog");
    expect(document.querySelector(".settings-tab-btn--active")?.textContent).toContain("SSH");
    expect(document.querySelector(".settings-ssh-tab .custom-select__button")?.textContent).toContain("Built-in SSH");
    expect(appStore.dialogLayers.map((layer) => layer.name)).toEqual(["SettingsDialog"]);
    expect(nativeConfirm).not.toHaveBeenCalled();

    wrapper.unmount();
  });

  test("Settings close asks before discarding a host draft", async () => {
    const api = createTransport();
    const appStore = useAppStore();
    const sshStore = useSshStore();
    appStore.init(api as never);
    sshStore.init(api as never);
    await flushPromises();
    appStore.openSettingsDialog({ initialTab: "ssh" });
    const wrapper = mount(DialogOverlay, { attachTo: document.body, global: { provide: { [apiKey]: api } } });
    await untilMounted(".settings-dialog");
    await document.querySelector<HTMLButtonElement>('[aria-controls="ssh-settings-panel-hosts"]')!.click();
    await document.querySelector<HTMLButtonElement>(".ssh-hosts-dialog__toolbar-actions button")!.click();
    await untilMounted(".ssh-host-editor");
    const hostInput = document.querySelector<HTMLInputElement>(
      '.ssh-host-editor input[placeholder="server.example.com or prod"]',
    )!;
    hostInput.value = "unsaved.example.net";
    hostInput.dispatchEvent(new Event("input", { bubbles: true }));
    await nextTick();

    const cancelSettings = document.querySelector<HTMLButtonElement>(".settings-footer .button--ghost")!;
    await cancelSettings.click();
    await untilMounted(".confirm-dialog");
    expect(document.querySelector(".settings-dialog")).not.toBeNull();
    await Array.from(document.querySelectorAll<HTMLButtonElement>(".confirm-dialog button"))
      .find((button) => button.textContent?.includes("Keep editing"))!
      .click();
    await untilGone(".confirm-dialog");
    expect(
      document.querySelector<HTMLInputElement>('.ssh-host-editor input[placeholder="server.example.com or prod"]')
        ?.value,
    ).toBe("unsaved.example.net");

    await cancelSettings.click();
    await untilMounted(".confirm-dialog");
    await Array.from(document.querySelectorAll<HTMLButtonElement>(".confirm-dialog button"))
      .find((button) => button.textContent?.includes("Discard changes"))!
      .click();
    await untilGone(".settings-dialog");
    expect(api.updateSettings).not.toHaveBeenCalled();
    expect(appStore.dialogLayers).toHaveLength(0);
    wrapper.unmount();
  });

  test("switching Settings sections guards an unsaved key rename", async () => {
    const api = createTransport();
    api.sshKeysList.mockResolvedValue([
      { id: "key-1", label: "Current label", kind: "ed25519", hasPassphrase: false, createdAt: "2026-01-01" },
    ] as never);
    const appStore = useAppStore();
    const sshStore = useSshStore();
    appStore.init(api as never);
    sshStore.init(api as never);
    await flushPromises();
    appStore.openSettingsDialog({ initialTab: "ssh" });
    const wrapper = mount(DialogOverlay, { attachTo: document.body, global: { provide: { [apiKey]: api } } });
    await untilMounted(".settings-dialog");
    await document.querySelector<HTMLButtonElement>('[aria-controls="ssh-settings-panel-keys"]')!.click();
    await untilMounted(".ssh-key-manager");
    await Array.from(document.querySelectorAll<HTMLButtonElement>(".ssh-key-manager button"))
      .find((button) => button.textContent?.trim() === "Rename")!
      .click();
    await untilMounted(".key-rename-form");
    const labelInput = document.querySelector<HTMLInputElement>(".key-rename-form input")!;
    labelInput.value = "Unsaved label";
    labelInput.dispatchEvent(new Event("input", { bubbles: true }));
    await nextTick();
    const generalTab = document.querySelector<HTMLButtonElement>(".settings-tab-btn:not(.settings-tab-btn--active)")!;
    await generalTab.click();
    await untilMounted(".confirm-dialog");
    expect(document.querySelector(".settings-tab-btn--active")?.textContent).toContain("SSH");
    await Array.from(document.querySelectorAll<HTMLButtonElement>(".confirm-dialog button"))
      .find((button) => button.textContent?.includes("Keep editing"))!
      .click();
    await untilGone(".confirm-dialog");
    expect(document.querySelector<HTMLInputElement>(".key-rename-form input")?.value).toBe("Unsaved label");
    await generalTab.click();
    await untilMounted(".confirm-dialog");
    await Array.from(document.querySelectorAll<HTMLButtonElement>(".confirm-dialog button"))
      .find((button) => button.textContent?.includes("Discard changes"))!
      .click();
    await flushPromises();
    await nextTick();
    await untilMounted(".settings-tab-content");
    expect(document.querySelector(".settings-tab-btn--active")?.textContent).toContain("General");
    expect(api.sshKeysRename).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  test("switching SSH sections stops an active inline host test", async () => {
    const api = createTransport();
    api.sshHostsList.mockResolvedValue([
      {
        id: "host-1",
        name: "Build",
        host: "build.example.net",
        username: "builder",
        createdAt: "2026-01-01",
        updatedAt: "2026-01-01",
        lastConnectedAt: null,
      },
    ] as never);
    api.sshTestStart.mockResolvedValue({ sessionId: "ssh-test:inline", mode: "ssh2", status: "connecting" } as never);
    const appStore = useAppStore();
    const sshStore = useSshStore();
    appStore.init(api as never);
    sshStore.init(api as never);
    await flushPromises();
    appStore.openSettingsDialog({ initialTab: "ssh" });
    const wrapper = mount(DialogOverlay, { attachTo: document.body, global: { provide: { [apiKey]: api } } });
    await untilMounted(".settings-dialog");
    await document.querySelector<HTMLButtonElement>('[aria-controls="ssh-settings-panel-hosts"]')!.click();
    await untilMounted(".ssh-hosts-dialog");
    await Array.from(document.querySelectorAll<HTMLButtonElement>(".ssh-host-card__actions button"))
      .find((button) => button.textContent?.includes("Test connection"))!
      .click();
    await untilMounted(".ssh-connection-test");
    await document.querySelector<HTMLButtonElement>('[aria-controls="ssh-settings-panel-default"]')!.click();
    await vi.waitFor(() => expect(api.sshTestStop).toHaveBeenCalled());
    expect(document.querySelector(".ssh-connection-test")).toBeNull();
    expect(document.querySelector(".settings-tab-btn--active")?.textContent).toContain("SSH");
    wrapper.unmount();
  });

  test("returning from a direct host test restores the unsaved editor and Advanced values", async () => {
    const api = createTransport();
    const appStore = useAppStore();
    const sshStore = useSshStore();
    appStore.init(api as never);
    sshStore.init(api as never);
    await flushPromises();

    appStore.openSettingsDialog({ initialTab: "ssh" });
    const wrapper = mount(DialogOverlay, { attachTo: document.body, global: { provide: { [apiKey]: api } } });
    await untilMounted(".settings-dialog");
    await document.querySelector<HTMLButtonElement>('[aria-controls="ssh-settings-panel-hosts"]')!.click();
    await untilMounted(".ssh-hosts-dialog");
    await document.querySelector<HTMLButtonElement>(".ssh-hosts-dialog__toolbar-actions .button")!.click();
    await untilMounted(".ssh-host-editor");

    const setInput = (selector: string, value: string) => {
      const input = document.querySelector<HTMLInputElement>(selector)!;
      input.value = value;
      input.dispatchEvent(new Event("input", { bubbles: true }));
    };
    setInput('.ssh-host-editor input[placeholder="server.example.com or prod"]', "draft.example.net");
    setInput('.ssh-host-editor input[placeholder="alice"]', "admin");
    setInput('.ssh-host-editor input[placeholder="Defaults to host or alias"]', "Development host");
    await document.querySelector<HTMLElement>(".ssh-host-editor .advanced-options summary")!.click();
    setInput('.ssh-host-editor input[placeholder="Use SSH configuration"]', "2222");

    await Array.from(document.querySelectorAll<HTMLButtonElement>(".ssh-host-editor__heading-actions button"))
      .find((button) => button.textContent?.includes("Test connection"))!
      .click();
    await untilMounted(".ssh-connection-test");
    expect(api.sshHostsCreate).not.toHaveBeenCalled();
    await vi.waitFor(() =>
      expect(document.querySelector<HTMLButtonElement>(".ssh-embedded-header__actions button")?.disabled).toBe(false),
    );
    await document.querySelector<HTMLButtonElement>(".ssh-embedded-header__actions button")!.click();
    await untilGone(".ssh-connection-test");
    await untilMounted(".ssh-host-editor");

    expect(
      document.querySelector<HTMLInputElement>('.ssh-host-editor input[placeholder="server.example.com or prod"]')
        ?.value,
    ).toBe("draft.example.net");
    expect(document.querySelector<HTMLInputElement>('.ssh-host-editor input[placeholder="alice"]')?.value).toBe(
      "admin",
    );
    expect(
      document.querySelector<HTMLInputElement>('.ssh-host-editor input[placeholder="Defaults to host or alias"]')
        ?.value,
    ).toBe("Development host");
    expect(
      document.querySelector<HTMLInputElement>('.ssh-host-editor input[placeholder="Use SSH configuration"]')?.value,
    ).toBe("2222");
    expect(api.sshHostsCreate).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  test("Settings save failure can be retried with the same error and success closes the dialog", async () => {
    const api = createTransport();
    const failure = new Error("Settings write failed");
    api.updateSettings.mockRejectedValue(failure);
    const appStore = useAppStore();
    const sshStore = useSshStore();
    appStore.init(api as never);
    sshStore.init(api as never);
    await flushPromises();

    appStore.openSettingsDialog({ initialTab: "ssh" });
    const wrapper = mount(DialogOverlay, {
      attachTo: document.body,
      global: { provide: { [apiKey]: api } },
    });
    await untilMounted(".settings-dialog");
    const saveButton = () => document.querySelector<HTMLButtonElement>(".settings-footer button:not(.button--ghost)")!;

    saveButton().click();
    await vi.waitFor(() =>
      expect(document.querySelector(".settings-footer .save-error")?.textContent).toBe(failure.message),
    );
    expect(saveButton().disabled).toBe(false);
    expect(appStore.dialogLayers).toHaveLength(1);

    saveButton().click();
    await vi.waitFor(() => expect(api.updateSettings).toHaveBeenCalledTimes(2));
    await vi.waitFor(() =>
      expect(document.querySelector(".settings-footer .save-error")?.textContent).toBe(failure.message),
    );
    expect(saveButton().disabled).toBe(false);
    expect(appStore.dialogLayers).toHaveLength(1);

    api.updateSettings.mockResolvedValue(statePayload() as never);
    saveButton().click();
    await untilGone(".settings-dialog");
    expect(api.updateSettings).toHaveBeenCalledTimes(3);
    expect(appStore.dialogLayers).toHaveLength(0);
    wrapper.unmount();
  });

  test("Transfer public key opens above Keys & Certificates and returns to that list", async () => {
    const api = createTransport();
    api.sshKeysList.mockResolvedValue([
      {
        id: "key-1",
        label: "laptop",
        kind: "ed25519",
        publicKey: "ssh-ed25519 AAAA",
        hasPassphrase: false,
        createdAt: "2026-08-10T12:00:00Z",
      },
    ] as never);
    const appStore = useAppStore();
    const sshStore = useSshStore();
    appStore.init(api as never);
    sshStore.init(api as never);
    sshStore.bindEvents();
    await flushPromises();

    appStore.openSshKeyManager();
    const wrapper = mount(DialogOverlay, {
      attachTo: document.body,
      global: { provide: { [apiKey]: api } },
    });
    await untilMounted(".ssh-key-manager");
    await vi.waitFor(() => expect(document.querySelector(".ssh-key-manager")?.textContent).toContain("laptop"));
    document
      .querySelectorAll<HTMLButtonElement>(".ssh-key-manager button")
      .forEach((button) => button.textContent?.trim() === "Transfer public key…" && button.click());

    await untilMounted(".ssh-key-transfer-dialog");
    expect(appStore.dialogLayers.map((layer) => layer.name)).toEqual(["SshKeyManager", "SshKeyTransferDialog"]);
    expect(appStore.dialogLayers.at(-1)?.props).toMatchObject({ keyId: "key-1", profileId: "profile-1" });
    expect(document.querySelector(".ssh-key-manager")).not.toBeNull();

    document.querySelector<HTMLButtonElement>(".ssh-key-transfer-dialog .dialog__footer .button--ghost")!.click();
    await untilGone(".ssh-key-transfer-dialog");
    expect(appStore.dialogLayers.map((layer) => layer.name)).toEqual(["SshKeyManager"]);
    expect(document.querySelector(".ssh-key-manager")).not.toBeNull();
    wrapper.unmount();
  });

  test("keeps New tab quick-connect input and error visible when workspace creation rejects", async () => {
    const api = createTransport();
    const appStore = useAppStore();
    const sshStore = useSshStore();
    appStore.init(api as never);
    sshStore.init(api as never);
    sshStore.bindEvents();
    await flushPromises();

    appStore.openNewTabDialog("", "SSH draft", "", { tabType: "ssh", sshMode: "quick" });
    const wrapper = mount(DialogOverlay, {
      attachTo: document.body,
      global: { provide: { [apiKey]: api } },
    });
    await untilMounted(".edit-tab-dialog");
    await vi.waitFor(() =>
      expect(document.querySelector<HTMLInputElement>('input[placeholder="bastion.example.com"]')).not.toBeNull(),
    );

    const hostInput = document.querySelector<HTMLInputElement>('input[placeholder="bastion.example.com"]')!;
    hostInput.value = "server.example.net";
    hostInput.dispatchEvent(new Event("input", { bubbles: true }));
    await nextTick();
    await document
      .querySelector<HTMLFormElement>(".edit-tab-dialog form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await vi.waitFor(() =>
      expect(document.querySelector(".edit-tab-dialog .error-msg")?.textContent).toContain("Workspace save rejected"),
    );

    expect(api.saveWorkspace).toHaveBeenCalledTimes(1);
    expect(document.querySelector<HTMLInputElement>(".title-input")?.value).toBe("SSH draft");
    expect(document.querySelector<HTMLInputElement>('input[placeholder="bastion.example.com"]')?.value).toBe(
      "server.example.net",
    );
    expect(document.querySelector(".edit-tab-dialog")).not.toBeNull();
    wrapper.unmount();
  });

  test("returns from testing an existing host draft, then saves the host without opening a tab", async () => {
    const api = createTransport();
    const appStore = useAppStore();
    const sshStore = useSshStore();
    appStore.init(api as never);
    sshStore.init(api as never);
    sshStore.bindEvents();
    await flushPromises();

    const originalHost = {
      id: "host-7",
      name: "Production",
      host: "old.example.net",
      username: "deploy",
      auth: { methods: ["agent"], agent: "auto" },
      advanced: { launchVia: "ssh2", command: "hostname", env: { REGION: "eu" } },
      jump: [],
      tags: ["prod"],
      createdAt: "2025-01-01T00:00:00.000Z",
      updatedAt: "2025-01-01T00:00:00.000Z",
      lastConnectedAt: null,
    };
    const updatedHost = { ...originalHost, host: "new.example.net" };
    api.sshHostsUpdate.mockResolvedValue(updatedHost);
    sshStore.hosts = [originalHost as never];
    const quickAddTemplateTab = vi.spyOn(appStore, "quickAddTemplateTab").mockResolvedValue(undefined);
    appStore.openSshHostEditor(originalHost as never);

    const wrapper = mount(DialogOverlay, {
      attachTo: document.body,
      global: { provide: { [apiKey]: api } },
    });
    await untilMounted(".ssh-host-editor");
    const hostInput = document.querySelector<HTMLInputElement>(
      '.ssh-host-editor input[placeholder="server.example.com or prod"]',
    )!;
    hostInput.value = "new.example.net";
    hostInput.dispatchEvent(new Event("input", { bubbles: true }));
    await nextTick();

    const testButton = Array.from(document.querySelectorAll<HTMLButtonElement>(".ssh-host-editor__footer button")).find(
      (button) => button.textContent?.includes("Test connection"),
    )!;
    await testButton.click();
    await untilMounted(".ssh-connection-test");
    await vi.waitFor(() => expect(document.querySelector(".ssh-connection-test .success")).not.toBeNull());
    expect(api.sshTestStart).toHaveBeenCalledWith({
      profileId: "profile-1",
      draft: expect.objectContaining({
        host: "new.example.net",
        advanced: expect.objectContaining({ launchVia: "ssh2", env: { REGION: "eu" } }),
      }),
    });
    const testDraft = api.sshTestStart.mock.calls[0][0].draft;
    expect((testDraft.advanced as Record<string, unknown>).command).toBeUndefined();
    expect(
      document.querySelector<HTMLInputElement>('.ssh-host-editor input[placeholder="server.example.com or prod"]')
        ?.value,
    ).toBe("new.example.net");

    await document.querySelector<HTMLButtonElement>(".ssh-connection-test__body + .dialog__footer .button")?.click();
    await untilGone(".ssh-connection-test");
    expect(api.sshTestStop).toHaveBeenCalledTimes(1);
    expect(
      document.querySelector<HTMLInputElement>('.ssh-host-editor input[placeholder="server.example.com or prod"]')
        ?.value,
    ).toBe("new.example.net");

    const save = Array.from(document.querySelectorAll<HTMLButtonElement>(".ssh-host-editor__footer button")).find(
      (button) => button.textContent?.trim() === "Save",
    )!;
    await save.click();
    await untilGone(".ssh-host-editor");
    expect(api.sshHostsUpdate).toHaveBeenCalledTimes(1);
    expect(api.sshHostsCreate).not.toHaveBeenCalled();
    expect(quickAddTemplateTab).not.toHaveBeenCalled();
    expect(api.sshHostsUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ id: "host-7", patch: expect.objectContaining({ host: "new.example.net" }) }),
    );
    expect(document.querySelector(".ssh-host-editor .dialog__error")).toBeNull();
    expect(appStore.dialogLayers).toHaveLength(0);
    wrapper.unmount();
  });

  test("key transfer survives queued MFA and host-key prompts, then returns to the same key manager", async () => {
    const api = createTransport();
    api.sshKeysList.mockResolvedValue([
      { id: "key-1", label: "Build key", kind: "ed25519", publicKey: "ssh-ed25519 AAAA" },
    ] as never);
    api.sshHostsList.mockResolvedValue([
      { id: "host-1", name: "Build", host: "build.example.com", username: "builder", advanced: { launchVia: "ssh2" } },
    ] as never);
    const appStore = useAppStore();
    const sshStore = useSshStore();
    appStore.init(api as never);
    sshStore.init(api as never);
    await flushPromises();
    appStore.openSshKeyManager();
    const overlay = mount(DialogOverlay, {
      attachTo: document.body,
      global: { provide: { [apiKey]: api } },
    });
    const PromptOverlays = defineComponent({
      setup() {
        return () =>
          h("div", [
            h(SshAuthPrompt, { prompt: sshStore.authPrompt }),
            h(SshHostKeyWarning, { warning: sshStore.hostKeyWarning }),
          ]);
      },
    });
    const promptOverlays = mount(PromptOverlays, {
      attachTo: document.body,
      global: { plugins: [testPinia] },
    });
    const auth = promptOverlays.getComponent(SshAuthPrompt);
    await untilMounted(".ssh-key-manager");
    await vi.waitFor(() =>
      expect(
        Array.from(document.querySelectorAll(".ssh-key-manager button")).some((button) =>
          button.textContent?.includes("Transfer public key"),
        ),
      ).toBe(true),
    );

    const managerBefore = document.querySelector(".ssh-key-manager");
    const transferButton = Array.from(managerBefore!.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Transfer public key"),
    );
    await transferButton!.click();
    await untilMounted(".ssh-key-transfer-dialog");
    const hostPicker = document.querySelector<HTMLButtonElement>(".ssh-key-transfer-dialog .custom-select__button")!;
    hostPicker.click();
    let hostOption: HTMLElement | undefined;
    await vi.waitFor(() => {
      hostOption = Array.from(document.querySelectorAll<HTMLElement>(".custom-select__option")).find((option) =>
        option.textContent?.includes("Build (builder@build.example.com)"),
      );
      expect(hostOption).toBeDefined();
    });
    hostOption!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    await nextTick();
    const start = Array.from(
      document.querySelectorAll<HTMLButtonElement>(".ssh-key-transfer-dialog .dialog__footer button"),
    ).find((button) => button.textContent?.includes("Start transfer"));
    await start!.click();
    await vi.waitFor(() =>
      expect(api.sshKeysTransferStart).toHaveBeenCalledWith({
        profileId: "profile-1",
        hostId: "host-1",
        keyId: "key-1",
      }),
    );
    const operationId = "ssh-transfer:dialog-flow";
    sshStore.keyTransferStates = {
      [operationId]: { operationId, hostId: "host-1", keyId: "key-1", status: "connecting" },
    };

    api.sshAuthAnswer.mockImplementationOnce(async () => {
      sshStore.enqueueDecision({
        kind: "auth",
        prompt: {
          sessionId: operationId,
          promptId: "mfa-2",
          prompt: { name: "Verification code", prompts: [{ prompt: "Code", echo: false }] },
        },
      });
    });
    sshStore.enqueueDecision({
      kind: "auth",
      prompt: {
        sessionId: operationId,
        promptId: "password-1",
        prompt: { name: "Server password", prompts: [{ prompt: "Password", echo: false }] },
      },
    });
    expect(sshStore.authPrompt?.promptId).toBe("password-1");
    await nextTick();
    expect(document.querySelector(".ssh-key-transfer-dialog")).not.toBeNull();
    expect(
      document.querySelector(".ssh-key-manager")?.closest(".overlay")?.classList.contains("overlay--inactive"),
    ).toBe(true);
    expect(auth.text()).toContain("Server password");
    const firstAnswer = auth.find("input").element as HTMLInputElement;
    firstAnswer.value = "temporary-password";
    firstAnswer.dispatchEvent(new Event("input", { bubbles: true }));
    await nextTick();
    await auth.find(".actions button:last-child").trigger("click");
    await vi.waitFor(() => expect(sshStore.authPrompt?.promptId).toBe("mfa-2"));
    expect(auth.text()).toContain("Verification code");
    expect(document.querySelector(".ssh-key-transfer-dialog")).not.toBeNull();

    api.sshAuthAnswer.mockImplementationOnce(async () => {
      sshStore.enqueueDecision({
        kind: "host-key",
        prompt: {
          sessionId: operationId,
          promptId: "host-key-1",
          keyType: "ssh-ed25519",
          fingerprint: "SHA256:verification",
        },
      });
    });
    const secondAnswer = auth.find("input").element as HTMLInputElement;
    secondAnswer.value = "123456";
    secondAnswer.dispatchEvent(new Event("input", { bubbles: true }));
    await nextTick();
    await auth.find(".actions button:last-child").trigger("click");
    await vi.waitFor(() => expect(sshStore.hostKeyWarning?.promptId).toBe("host-key-1"));
    await vi.waitFor(() => expect(document.querySelector(".ssh-host-key-warning")).not.toBeNull());
    expect(document.querySelector(".ssh-key-transfer-dialog")).not.toBeNull();
    await Array.from(document.querySelectorAll<HTMLButtonElement>(".ssh-host-key-warning button"))
      .find((button) => button.textContent?.includes("Accept once"))!
      .click();
    await vi.waitFor(() => expect(sshStore.hostKeyWarning).toBeNull());
    sshStore.keyTransferStates = {
      [operationId]: { operationId, hostId: "host-1", keyId: "key-1", status: "installed" },
    };
    await vi.waitFor(() =>
      expect(document.querySelector(".ssh-key-transfer-dialog")?.textContent).toContain(
        "Public key transferred successfully. “Build key” can now sign in to Build (builder@build.example.com). Select it in a saved host's Built-in SSH settings to use it.",
      ),
    );

    await document.querySelector<HTMLButtonElement>(".ssh-key-transfer-dialog .dialog__footer .button--ghost")!.click();
    await vi.waitFor(() => expect(document.querySelector(".ssh-key-transfer-dialog")).toBeNull());
    await untilMounted(".ssh-key-manager");
    expect(document.querySelector(".ssh-key-manager")).toBe(managerBefore);
    expect(document.querySelector(".ssh-key-manager")?.textContent).toContain("Build key");
    expect(api.sshKeysTransferStop).toHaveBeenCalledWith({ operationId });

    promptOverlays.unmount();
    overlay.unmount();
  });
});
