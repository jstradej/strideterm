/**
 * The auto-approve checkbox is locked against ARMING it, never against
 * disarming it.
 *
 * A prerequisite that goes missing must not trap an armed bypass: with the
 * Claude hook status at `partial` the `PermissionRequest` entry may well still
 * be registered and approving away, and a checkbox that refuses to be unticked
 * leaves the user no way to stop it from the UI.
 */
import { describe, expect, test, beforeEach, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import SettingsGeneralTab from "./SettingsGeneralTab.vue";

interface FormOverrides {
  agentHook?: boolean;
  autoApprovePermissions?: boolean;
}

function buildForm({ agentHook = true, autoApprovePermissions = false }: FormOverrides = {}) {
  return {
    theme: "dark",
    terminalFontSize: 13,
    externalEditor: "",
    externalPathOpener: { mode: "system", command: "" },
    clipboardImagePasteEnabled: true,
    clipboardImagePasteDir: "",
    remoteAccess: { cloudflaredPath: "" },
    logLevel: "info",
    notifications: {
      promptQuietMs: 900,
      agentQuietMs: 20000,
      agentQuietFastMs: 12000,
      alertCooldownMs: 15000,
      agentsOnly: true,
      subagentCompletion: false,
      shellIntegration: false,
      agentHook,
      debug: false,
      autoApprovePermissions,
    },
  };
}

function mountTab({
  form,
  claudeStatus = "configured",
  isRemote = false,
}: {
  form: ReturnType<typeof buildForm>;
  claudeStatus?: string;
  isRemote?: boolean;
}) {
  return mount(SettingsGeneralTab, {
    props: {
      api: { isRemote, queryApprovalAuditLog: vi.fn().mockResolvedValue({ entries: [], total: 0 }) },
      themes: ["dark", "light"],
      logLevels: ["info", "debug"],
      hookSettings: {
        providers: [
          {
            id: "claude",
            status: claudeStatus,
            label: "Claude Code",
            manual: { type: "claude-doc", path: "~/.claude/settings.json" },
          },
        ],
        statusLabels: {},
      },
    },
    global: { provide: { settingsForm: form } },
  });
}

function autoApproveInput(wrapper: ReturnType<typeof mountTab>) {
  const label = wrapper
    .findAll("label")
    .find((candidate) => candidate.text().includes("Auto-approve permission prompts"));
  if (!label) throw new Error("auto-approve checkbox not found");
  return label.find("input[type='checkbox']");
}

describe("SettingsGeneralTab — auto-approve checkbox", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  test("is enabled when the hook is on and Claude is configured", () => {
    const wrapper = mountTab({ form: buildForm() });
    expect(autoApproveInput(wrapper).attributes("disabled")).toBeUndefined();
  });

  test("cannot be ARMED while its prerequisites are missing", () => {
    const offHook = mountTab({ form: buildForm({ agentHook: false }) });
    expect(autoApproveInput(offHook).attributes("disabled")).toBeDefined();

    const partial = mountTab({ form: buildForm(), claudeStatus: "partial" });
    expect(autoApproveInput(partial).attributes("disabled")).toBeDefined();
  });

  test("an ARMED bypass can always be disarmed, whatever the prerequisites say", () => {
    // With the status at `partial` the PermissionRequest hook may still be
    // registered and approving; refusing the untick leaves no way to stop it.
    const partial = mountTab({ form: buildForm({ autoApprovePermissions: true }), claudeStatus: "partial" });
    expect(autoApproveInput(partial).attributes("disabled")).toBeUndefined();
    expect(partial.text()).toContain("untick it here to disarm");

    const offHook = mountTab({ form: buildForm({ agentHook: false, autoApprovePermissions: true }) });
    expect(autoApproveInput(offHook).attributes("disabled")).toBeUndefined();
  });

  test("a remote client cannot write the field at all, armed or not", () => {
    // `sanitizeSettingsFromRemote` drops it from /api/settings/update, so a
    // tickable box whose Save silently does nothing is worse than no box.
    const wrapper = mountTab({ form: buildForm({ autoApprovePermissions: true }), isRemote: true });
    expect(autoApproveInput(wrapper).attributes("disabled")).toBeDefined();
    expect(wrapper.text()).toContain("Desktop only");
  });
});
