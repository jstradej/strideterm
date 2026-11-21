import { mount, flushPromises, type VueWrapper } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import SettingsDialog from "./SettingsDialog.vue";
import { apiKey } from "../../types/keys.js";
import { useAppStore } from "../../stores/app.js";

type AnySettings = Record<string, unknown>;

beforeEach(() => setActivePinia(createPinia()));

async function mountDialog(
  settings: AnySettings = {},
  apiOverrides: AnySettings = {},
  options: { initialTab?: string; mountGitTab?: boolean } = {},
) {
  const wrapper = mount(SettingsDialog, {
    props: { settings, initialTab: options.initialTab },
    global: {
      provide: {
        [apiKey]: {
          getAgentNotifyHookStatus: async () => ({}),
          getAgentNotifyHookMetrics: async () => null,
          ...apiOverrides,
        },
      },
      stubs: {
        SettingsHookProviderSection: true,
        CustomSelect: true,
        SettingsTemplatesTab: true,
        SettingsGitTab: options.mountGitTab ? false : true,
        SettingsSshTab: true,
        SettingsTelegramTab: true,
        SettingsAboutTab: true,
        JiraInboxPane: true,
      },
    },
  });
  await wrapper.vm.$nextTick();
  return wrapper;
}

function findAgentsOnlyCheckbox(wrapper: VueWrapper) {
  const labels = wrapper.findAll("label.settings-check__row");
  const target = labels.find((label) => label.text().includes("Notify only from AI agents"));
  if (!target) throw new Error("Agents-only checkbox not found");
  return target.find('input[type="checkbox"]');
}

function clickSave(wrapper: VueWrapper) {
  const saveBtn = wrapper.findAll("button").find((b) => b.text() === "Save settings");
  if (!saveBtn) throw new Error("Save button not found");
  return saveBtn.trigger("click");
}

function lastSavedNotifications(wrapper: VueWrapper): Record<string, unknown> {
  const events = wrapper.emitted("save") || [];
  const last = events.at(-1)?.[0] as { notifications?: Record<string, unknown> } | undefined;
  if (!last) throw new Error("No save event emitted");
  return last.notifications ?? {};
}

describe("SettingsDialog — notifications.agentsOnly", () => {
  test("checkbox reflects initial value true", async () => {
    const wrapper = await mountDialog({ notifications: { agentsOnly: true } });
    const checkbox = findAgentsOnlyCheckbox(wrapper);
    expect((checkbox.element as HTMLInputElement).checked).toBe(true);
  });

  test("checkbox reflects initial value false", async () => {
    const wrapper = await mountDialog({ notifications: { agentsOnly: false } });
    const checkbox = findAgentsOnlyCheckbox(wrapper);
    expect((checkbox.element as HTMLInputElement).checked).toBe(false);
  });

  test("checkbox defaults to checked when settings omit agentsOnly", async () => {
    const wrapper = await mountDialog({ notifications: {} });
    const checkbox = findAgentsOnlyCheckbox(wrapper);
    expect((checkbox.element as HTMLInputElement).checked).toBe(true);
  });

  test("Save emits agentsOnly=true when the box stays checked", async () => {
    const wrapper = await mountDialog({ notifications: { agentsOnly: true } });
    await clickSave(wrapper);
    expect(lastSavedNotifications(wrapper).agentsOnly).toBe(true);
  });

  test("Save emits agentsOnly=false when the box starts unchecked", async () => {
    const wrapper = await mountDialog({ notifications: { agentsOnly: false } });
    await clickSave(wrapper);
    expect(lastSavedNotifications(wrapper).agentsOnly).toBe(false);
  });

  test("toggling the checkbox round-trips through Save (false -> true)", async () => {
    const wrapper = await mountDialog({ notifications: { agentsOnly: false } });
    const checkbox = findAgentsOnlyCheckbox(wrapper);
    await checkbox.setValue(true);
    await clickSave(wrapper);
    expect(lastSavedNotifications(wrapper).agentsOnly).toBe(true);
  });

  test("toggling the checkbox round-trips through Save (true -> false)", async () => {
    const wrapper = await mountDialog({ notifications: { agentsOnly: true } });
    const checkbox = findAgentsOnlyCheckbox(wrapper);
    await checkbox.setValue(false);
    await clickSave(wrapper);
    expect(lastSavedNotifications(wrapper).agentsOnly).toBe(false);
  });

  test("Save preserves other notification fields alongside agentsOnly", async () => {
    const wrapper = await mountDialog({
      notifications: {
        agentsOnly: false,
        promptQuietMs: 1234,
        agentHook: true,
        shellIntegration: false,
      },
    });
    await clickSave(wrapper);
    const notifications = lastSavedNotifications(wrapper);
    expect(notifications).toMatchObject({
      agentsOnly: false,
      promptQuietMs: 1234,
      agentHook: true,
      shellIntegration: false,
    });
  });
});

describe("SettingsDialog — Git preferences", () => {
  test("saves Git action preferences without the retired shell toggle", async () => {
    const wrapper = await mountDialog(
      { git: { ui: { newView: false, showAllActions: true } } },
      {},
      { initialTab: "git", mountGitTab: true },
    );
    const checkbox = wrapper.find('input[type="checkbox"]');
    expect((checkbox.element as HTMLInputElement).checked).toBe(true);
    await clickSave(wrapper);

    const git = lastSavedPayload(wrapper).git as { ui: { showAllActions: boolean } };
    expect(git.ui).toEqual({ showAllActions: true });
  });
});

describe("SettingsDialog — section navigation", () => {
  test("keeps tab labels accessible alongside decorative icons", async () => {
    const wrapper = await mountDialog({}, { isRemote: false, listRemoteSessions: vi.fn(async () => []) });
    const tabs = wrapper.findAll(".settings-tab-btn");
    expect(tabs.map((tab) => tab.text().trim())).toEqual([
      "General",
      "Tab Templates",
      "Git",
      "Jira",
      "SSH",
      "Telegram",
      "Remote access",
      "About",
    ]);
    expect(tabs.every((tab) => tab.find('svg[aria-hidden="true"]').exists())).toBe(true);
    expect(tabs.every((tab) => tab.attributes("aria-pressed") !== undefined)).toBe(true);
    expect(tabs.find((tab) => tab.text().trim() === "General")?.attributes("aria-pressed")).toBe("true");

    await tabs.find((tab) => tab.text().trim() === "SSH")!.trigger("click");
    expect(tabs.find((tab) => tab.text().trim() === "SSH")?.attributes("aria-pressed")).toBe("true");
    expect(tabs.find((tab) => tab.text().trim() === "General")?.attributes("aria-pressed")).toBe("false");
  });
});

describe("SettingsDialog — Jira connections", () => {
  test("opens the shared connection manager directly without requiring a Jira workspace", async () => {
    const wrapper = await mountDialog({}, {}, { initialTab: "jira" });
    expect(wrapper.get('[data-testid="jira-settings-connections"]').text()).not.toContain("No Jira workspace exists");
    expect(wrapper.get('[data-testid="jira-settings-connections"]').html()).toContain('connectionsonly="true"');
  });

  test("shows the comment attribution section above the connections", async () => {
    const wrapper = await mountDialog(
      { integrations: { jira: { commentAttribution: { enabled: true, text: "Hi {user}", position: "before" } } } },
      { isRemote: false, setJiraCommentAttribution: vi.fn() },
      { initialTab: "jira" },
    );
    const section = wrapper.get('[data-testid="jira-comment-attribution"]');
    expect(section.text()).toContain("Comment attribution for technical accounts");
    expect((section.get("textarea").element as HTMLTextAreaElement).value).toBe("Hi {user}");
  });
});

describe("SettingsDialog — remote access overview", () => {
  const mismatchHost = {
    id: "host-mac-1",
    label: "macmini.local",
    address: "macmini.local",
    port: 43444,
    hostPublicKey: "",
    pairedAt: 1,
    state: "version-mismatch",
    hostAppVersion: "2.4.1",
    localAppVersion: "2.4.2",
    profiles: [],
    checkedAt: 1,
  };
  const onlineHost = { ...mismatchHost, id: "host-nas-1", label: "nas.local", state: "online" };

  function seedStore(remoteAccess: Record<string, unknown> = {}) {
    const store = useAppStore();
    store.payload = {
      appState: { settings: { remoteAccess: { enabled: true, ...remoteAccess } } },
      remoteAccess: { enabled: true, urls: [], tunnel: {} },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
    return store;
  }

  function overviewApi(overrides: AnySettings = {}) {
    return {
      isRemote: false,
      listRemoteSessions: vi.fn(async () => [{}, {}]),
      getPeerHostState: vi.fn(async () => ({
        hosting: { enabled: false, port: 43444 },
        instanceId: "x",
        hostName: "this",
        encryptionAvailable: true,
        listener: {},
        devices: [{ id: "d1" }],
        pending: [],
      })),
      ...overrides,
    };
  }

  afterEach(() => {
    delete (window as unknown as { strideterm?: unknown }).strideterm;
  });

  test("replaces the Mobile and Remote access tabs with one Remote access tab", async () => {
    const wrapper = await mountDialog({}, overviewApi({ createMobilePairingInvitation: vi.fn() }));
    const labels = wrapper.findAll(".settings-tab-btn").map((tab) => tab.text().trim());
    expect(labels.filter((label) => label === "Remote access")).toHaveLength(1);
    expect(labels).not.toContain("Mobile");
    wrapper.unmount();
  });

  test("is absent on a remote client, and Save never sends the session length", async () => {
    const wrapper = await mountWithTransport(
      { remoteAccess: { sessionIdleTtlMinutes: 777, sessionAbsoluteTtlMinutes: 9999 } },
      true,
    );
    expect(wrapper.findAll(".settings-tab-btn").some((tab) => tab.text().includes("Remote access"))).toBe(false);
    await clickSave(wrapper);
    expect(lastSavedPayload(wrapper)).not.toHaveProperty("remoteAccess");
    wrapper.unmount();
  });

  test("Save on the desktop no longer carries the session length", async () => {
    const wrapper = await mountDialog({ remoteAccess: { sessionIdleTtlMinutes: 600 } }, overviewApi());
    await clickSave(wrapper);
    expect(lastSavedPayload(wrapper)).not.toHaveProperty("remoteAccess");
    wrapper.unmount();
  });

  test("shows channel status, warnings on top and one row per attached host", async () => {
    seedStore({ paused: true });
    (window as unknown as { strideterm: unknown }).strideterm = {
      listPeerHosts: vi.fn(async () => [mismatchHost, onlineHost]),
    };
    const wrapper = await mountDialog({}, overviewApi(), { initialTab: "remote-access" });
    await flushPromises();
    const text = wrapper.get('[data-testid="remote-overview"]').text();
    expect(text).toContain("All remote access is paused.");
    expect(text).toContain("Hosting is off, but 1 desktop is paired.");
    expect(wrapper.get('[data-testid="remote-row-hosting"]').text()).toContain("Off · 1 paired desktop");
    expect(wrapper.get('[data-testid="remote-row-browser"]').text()).toContain("Sharing on · LAN · 2 active sessions");
    expect(wrapper.get('[data-testid="remote-row-host-host-mac-1"]').text()).toContain(
      "macmini.local · version mismatch (host 2.4.1, here 2.4.2)",
    );
    expect(wrapper.get('[data-testid="remote-row-host-host-nas-1"]').text()).toContain("nas.local · online");
    expect(wrapper.findAll(".remote-overview__warning").map((w) => w.text())).toEqual(
      expect.arrayContaining([expect.stringContaining("macmini.local: version mismatch (host 2.4.1, here 2.4.2)")]),
    );
    wrapper.unmount();
  });

  test("refreshes every attached host's link state when it opens", async () => {
    seedStore();
    const refreshPeerHost = vi.fn(async (hostId: string) => ({
      ...mismatchHost,
      id: hostId,
      state: "version-mismatch",
    }));
    (window as unknown as { strideterm: unknown }).strideterm = {
      listPeerHosts: vi.fn(async () => [mismatchHost, onlineHost]),
      refreshPeerHost,
    };
    const wrapper = await mountDialog({}, overviewApi(), { initialTab: "remote-access" });
    await flushPromises();
    expect(refreshPeerHost.mock.calls.map((call) => call[0]).sort()).toEqual(["host-mac-1", "host-nas-1"]);
    wrapper.unmount();
  });

  test("Open goes to the right tab as a layer over Settings, and back returns to Settings", async () => {
    const store = seedStore();
    store.openSettingsDialog();
    const wrapper = await mountDialog({}, overviewApi(), { initialTab: "remote-access" });
    await flushPromises();

    await wrapper
      .get('[data-testid="remote-row-hosting"]')
      .findAll("button")
      .find((button) => button.text() === "Open")!
      .trigger("click");
    expect(store.dialogLayers.map((layer) => layer.name)).toEqual(["SettingsDialog", "RemoteAccessDialog"]);
    expect(store.dialogLayers.at(-1)!.props).toMatchObject({ initialMode: "desktops" });
    (store.dialogLayers.at(-1)!.props.onClose as () => void)();
    expect(store.dialogLayers.map((layer) => layer.name)).toEqual(["SettingsDialog"]);

    await wrapper.get('[data-testid="remote-open-sessions"]').trigger("click");
    expect(store.dialogLayers.at(-1)!.props).toMatchObject({ initialMode: "lan", focusSessions: true });
    wrapper.unmount();
  });
});

describe("SettingsDialog — notifications.subagentCompletion", () => {
  function findSubagentCheckbox(wrapper: VueWrapper) {
    const labels = wrapper.findAll("label.settings-check__row");
    const target = labels.find((label) => label.text().includes("Notify on sub-agent completion"));
    if (!target) throw new Error("Sub-agent completion checkbox not found");
    return target.find('input[type="checkbox"]');
  }

  test("checkbox defaults to unchecked when settings omit subagentCompletion (opt-in)", async () => {
    const wrapper = await mountDialog({ notifications: {} });
    const checkbox = findSubagentCheckbox(wrapper);
    expect((checkbox.element as HTMLInputElement).checked).toBe(false);
  });

  test("checkbox reflects initial value true", async () => {
    const wrapper = await mountDialog({ notifications: { subagentCompletion: true } });
    const checkbox = findSubagentCheckbox(wrapper);
    expect((checkbox.element as HTMLInputElement).checked).toBe(true);
  });

  test("toggling the checkbox round-trips through Save (false -> true)", async () => {
    const wrapper = await mountDialog({ notifications: { subagentCompletion: false } });
    const checkbox = findSubagentCheckbox(wrapper);
    await checkbox.setValue(true);
    await clickSave(wrapper);
    expect(lastSavedNotifications(wrapper).subagentCompletion).toBe(true);
  });

  test("Save emits subagentCompletion=false by default", async () => {
    const wrapper = await mountDialog({ notifications: {} });
    await clickSave(wrapper);
    expect(lastSavedNotifications(wrapper).subagentCompletion).toBe(false);
  });
});

const FONT_SIZE_STUBS = {
  SettingsHookProviderSection: true,
  CustomSelect: true,
  SettingsTemplatesTab: true,
  SettingsGitTab: true,
  SettingsSshTab: true,
  SettingsTelegramTab: true,
  SettingsAboutTab: true,
};

async function mountWithTransport(settings: AnySettings, isRemote: boolean) {
  const wrapper = mount(SettingsDialog, {
    props: { settings },
    global: {
      provide: {
        [apiKey]: {
          isRemote,
          getAgentNotifyHookStatus: async () => ({}),
          getAgentNotifyHookMetrics: async () => null,
        },
      },
      stubs: FONT_SIZE_STUBS,
    },
  });
  await wrapper.vm.$nextTick();
  return wrapper;
}

function lastSavedPayload(wrapper: VueWrapper): Record<string, unknown> {
  const events = wrapper.emitted("save") || [];
  const last = events.at(-1)?.[0] as Record<string, unknown> | undefined;
  if (!last) throw new Error("No save event emitted");
  return last;
}

describe("SettingsDialog — externalEditor", () => {
  test("Save round-trips externalEditor string", async () => {
    const wrapper = await mountDialog({ externalEditor: "code --wait" });
    await clickSave(wrapper);
    expect(lastSavedPayload(wrapper).externalEditor).toBe("code --wait");
  });

  test("Save emits empty string when settings omit externalEditor", async () => {
    const wrapper = await mountDialog({});
    await clickSave(wrapper);
    expect(lastSavedPayload(wrapper).externalEditor).toBe("");
  });

  test("input updates round-trip through Save", async () => {
    const wrapper = await mountDialog({ externalEditor: "" });
    const input = wrapper.find('input[placeholder^="e.g. code, notepad++"]');
    expect(input.exists()).toBe(true);
    await input.setValue('"C:\\Program Files\\App\\app.exe"');
    await clickSave(wrapper);
    expect(lastSavedPayload(wrapper).externalEditor).toBe('"C:\\Program Files\\App\\app.exe"');
  });
});

describe("SettingsDialog — dead field cleanup", () => {
  test("Save payload no longer contains ssh.allowSystemSshFallback", async () => {
    const wrapper = await mountDialog({
      ssh: { allowSystemSshFallback: true, preferAgent: false },
    });
    await clickSave(wrapper);
    const ssh = lastSavedPayload(wrapper).ssh as Record<string, unknown>;
    expect(ssh).not.toHaveProperty("allowSystemSshFallback");
    expect(ssh.preferAgent).toBe(false);
  });
});

describe("SettingsDialog — terminalFontSize", () => {
  test("desktop: form initializes from terminalFontSizeLocal", async () => {
    const wrapper = await mountWithTransport({ terminalFontSizeLocal: 18 }, false);
    const input = wrapper.find(".settings-input--narrow");
    expect((input.element as HTMLInputElement).value).toBe("18");
  });

  test("remote: form initializes from terminalFontSizeRemote", async () => {
    const wrapper = await mountWithTransport({ terminalFontSizeRemote: 20 }, true);
    const input = wrapper.find(".settings-input--narrow");
    expect((input.element as HTMLInputElement).value).toBe("20");
  });

  test("desktop: Save emits terminalFontSizeLocal and not terminalFontSizeRemote", async () => {
    const wrapper = await mountWithTransport({ terminalFontSizeLocal: 16 }, false);
    await clickSave(wrapper);
    const saved = lastSavedPayload(wrapper);
    expect(saved).toHaveProperty("terminalFontSizeLocal", 16);
    expect(saved).not.toHaveProperty("terminalFontSizeRemote");
  });

  test("remote: Save emits terminalFontSizeRemote and not terminalFontSizeLocal", async () => {
    const wrapper = await mountWithTransport({ terminalFontSizeRemote: 22 }, true);
    await clickSave(wrapper);
    const saved = lastSavedPayload(wrapper);
    expect(saved).toHaveProperty("terminalFontSizeRemote", 22);
    expect(saved).not.toHaveProperty("terminalFontSizeLocal");
  });
});

describe("SettingsDialog — isolateNewWorkspaces", () => {
  const box = '[data-testid="isolate-new-workspaces"]';

  test("desktop: shows the stored value and saves a change", async () => {
    const wrapper = await mountWithTransport({ isolateNewWorkspaces: true }, false);
    expect((wrapper.get(box).element as HTMLInputElement).checked).toBe(true);
    await wrapper.get(box).setValue(false);
    await clickSave(wrapper);
    expect(lastSavedPayload(wrapper)).toHaveProperty("isolateNewWorkspaces", false);
  });

  test("desktop: defaults to off", async () => {
    const wrapper = await mountWithTransport({}, false);
    expect((wrapper.get(box).element as HTMLInputElement).checked).toBe(false);
  });

  test("remote: no checkbox, and a save never carries the key", async () => {
    const wrapper = await mountWithTransport({ isolateNewWorkspaces: true }, true);
    expect(wrapper.find(box).exists()).toBe(false);
    await clickSave(wrapper);
    expect(lastSavedPayload(wrapper)).not.toHaveProperty("isolateNewWorkspaces");
  });
});

describe("SettingsDialog — notifications.autoApprovePermissions", () => {
  // The checkbox only does anything when the notify listener is on AND the
  // Claude Code hooks are actually registered, so an "available" mount has to
  // report both.
  const CLAUDE_CONFIGURED = { getClaudeHookStatus: async () => ({ status: "configured" }) };

  function findAutoApproveRow(wrapper: VueWrapper) {
    const labels = wrapper.findAll("label.settings-check__row");
    const target = labels.find((label) => label.text().includes("Auto-approve permission prompts"));
    if (!target) throw new Error("Auto-approve checkbox not found");
    return target;
  }

  function findAutoApproveCheckbox(wrapper: VueWrapper) {
    return findAutoApproveRow(wrapper).find('input[type="checkbox"]');
  }

  test("defaults to unchecked — the bypass is never armed by omission", async () => {
    const wrapper = await mountDialog({ notifications: {} }, CLAUDE_CONFIGURED);
    expect((findAutoApproveCheckbox(wrapper).element as HTMLInputElement).checked).toBe(false);
  });

  test("reflects an explicitly enabled value", async () => {
    const wrapper = await mountDialog(
      { notifications: { agentHook: true, autoApprovePermissions: true } },
      CLAUDE_CONFIGURED,
    );
    expect((findAutoApproveCheckbox(wrapper).element as HTMLInputElement).checked).toBe(true);
  });

  test("Save emits autoApprovePermissions=false by default", async () => {
    const wrapper = await mountDialog({ notifications: {} }, CLAUDE_CONFIGURED);
    await clickSave(wrapper);
    expect(lastSavedNotifications(wrapper).autoApprovePermissions).toBe(false);
  });

  test("toggling round-trips through Save", async () => {
    const wrapper = await mountDialog({ notifications: { agentHook: true } }, CLAUDE_CONFIGURED);
    await findAutoApproveCheckbox(wrapper).setValue(true);
    await clickSave(wrapper);
    expect(lastSavedNotifications(wrapper).autoApprovePermissions).toBe(true);
  });

  test("is disabled with a hint when the agent notification hook is off", async () => {
    const wrapper = await mountDialog({ notifications: { agentHook: false } }, CLAUDE_CONFIGURED);
    expect((findAutoApproveCheckbox(wrapper).element as HTMLInputElement).disabled).toBe(true);
    expect(wrapper.text()).toContain("Needs Agent notification hook");
  });

  test("is disabled with a hint when the Claude Code hooks are not configured", async () => {
    // Ticking it would change nothing: the decision travels over the
    // PermissionRequest hook, which isn't registered yet.
    const wrapper = await mountDialog(
      { notifications: { agentHook: true } },
      { getClaudeHookStatus: async () => ({ status: "partial" }) },
    );
    expect((findAutoApproveCheckbox(wrapper).element as HTMLInputElement).disabled).toBe(true);
    expect(wrapper.text()).toContain("Needs the Claude Code hooks configured");
  });

  test("the label spells out that this is a bypass", async () => {
    const wrapper = await mountDialog({ notifications: { agentHook: true } }, CLAUDE_CONFIGURED);
    const text = wrapper.text();
    expect(text).toContain("Equivalent to running without permission prompts");
    expect(text).toContain("AskUserQuestion");
    expect(text).toContain("ExitPlanMode");
  });
});

describe("SettingsDialog — auto-approve is desktop-only in the UI too", () => {
  test("a remote client sees the checkbox disabled with a reason, not a Save that does nothing", async () => {
    // The field is dropped by sanitizeSettingsFromRemote, so a tickable box on
    // remote would promise something the server refuses to do.
    const wrapper = await mountDialog(
      { notifications: { agentHook: true } },
      { isRemote: true, getClaudeHookStatus: async () => ({ status: "configured" }) },
    );
    const label = wrapper
      .findAll("label.settings-check__row")
      .find((l) => l.text().includes("Auto-approve permission prompts"));
    const checkbox = label!.find('input[type="checkbox"]');
    expect((checkbox.element as HTMLInputElement).disabled).toBe(true);
    expect(wrapper.text()).toContain("Desktop only");
  });
});

describe("SettingsDialog — credentials tab", () => {
  const tabLabels = (wrapper: VueWrapper) => wrapper.findAll(".settings-tab-btn").map((tab) => tab.text().trim());

  test("appears only when the transport can list credentials, so a remote client never sees it", async () => {
    expect(tabLabels(await mountDialog({}, {}))).not.toContain("Credentials");
    expect(
      tabLabels(
        await mountDialog({}, { listCredentials: vi.fn(async () => ({ rows: [], encryptionAvailable: true })) }),
      ),
    ).toContain("Credentials");
  });

  test("Change on a Jira credential switches to the Jira tab", async () => {
    const wrapper = await mountDialog(
      {},
      { listCredentials: vi.fn(async () => ({ rows: [], encryptionAvailable: true })) },
      { initialTab: "credentials" },
    );
    wrapper.findComponent({ name: "SettingsCredentialsTab" }).vm.$emit("change", { system: "jira", ownerId: "j1" });
    await flushPromises();
    expect(wrapper.find('[data-testid="jira-settings-connections"]').exists()).toBe(true);
  });

  test("Change on an Azure connection opens its dialog, unless Settings has unsaved changes", async () => {
    const wrapper = await mountDialog(
      {},
      { listCredentials: vi.fn(async () => ({ rows: [], encryptionAvailable: true })) },
      { initialTab: "credentials" },
    );
    const app = useAppStore();
    const open = vi.spyOn(app, "openAzureConnectionDialog").mockImplementation(() => undefined);
    const tab = wrapper.findComponent({ name: "SettingsCredentialsTab" });
    tab.vm.$emit("change", { system: "azure", ownerId: "ado-1" });
    await flushPromises();
    expect(open).toHaveBeenCalledWith("ado-1");

    open.mockClear();
    (wrapper.vm as unknown as { $: { setupState: { form: { theme: string } } } }).$.setupState.form.theme = "light";
    tab.vm.$emit("change", { system: "azure", ownerId: "ado-1" });
    await flushPromises();
    expect(open).not.toHaveBeenCalled();
  });
});
