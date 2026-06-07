import { mount, type VueWrapper } from "@vue/test-utils";
import { describe, expect, test } from "vitest";
import SettingsDialog from "./SettingsDialog.vue";

type AnySettings = Record<string, unknown>;

async function mountDialog(settings: AnySettings = {}) {
  const wrapper = mount(SettingsDialog, {
    props: { settings },
    global: {
      provide: {
        api: {
          getAgentNotifyHookStatus: async () => ({}),
          getAgentNotifyHookMetrics: async () => null,
        },
      },
      stubs: {
        SettingsHookProviderSection: true,
        CustomSelect: true,
        SettingsTemplatesTab: true,
        SettingsGitTab: true,
        SettingsSshTab: true,
        SettingsTelegramTab: true,
        SettingsAboutTab: true,
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
  const saveBtn = wrapper.findAll("button").find((b) => b.text() === "Save");
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
        api: {
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
