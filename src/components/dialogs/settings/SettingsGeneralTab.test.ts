/**
 * Regression coverage: SettingsGeneralTab has three file/directory picker
 * call sites (browseEditor, browseCloudflared, browseClipboardImageDir) that
 * used to call api.browseFile/browseDirectory directly inside a click
 * handler with no try/catch. A rejected picker promise was an unhandled
 * rejection with no user feedback. They now go through pickPath(), which
 * surfaces an error toast.
 */
import { describe, expect, test, beforeEach, vi } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import SettingsGeneralTab from "./SettingsGeneralTab.vue";
import { useNotificationStore } from "../../../stores/notifications.js";

function buildForm() {
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
      agentHook: false,
      debug: false,
    },
  };
}

function mountTab(api: Record<string, unknown>) {
  return mount(SettingsGeneralTab, {
    props: {
      api,
      themes: ["dark", "light"],
      logLevels: ["info", "debug"],
      hookSettings: { providers: [] },
    },
    global: {
      provide: { settingsForm: buildForm() },
    },
  });
}

function findBrowseButton(wrapper: ReturnType<typeof mountTab>, titleFragment: string) {
  const btn = wrapper
    .findAll("button")
    .find((b) => b.text() === "Browse" && b.attributes("title")?.includes(titleFragment));
  if (!btn) throw new Error(`Browse button with title containing "${titleFragment}" not found`);
  return btn;
}

beforeEach(() => {
  setActivePinia(createPinia());
});

describe("SettingsGeneralTab — picker call sites", () => {
  test("browseEditor: a rejecting browseFile shows an error notification instead of throwing", async () => {
    const browseFile = vi.fn().mockRejectedValueOnce(new Error("picker crashed"));
    const wrapper = mountTab({ browseFile });

    await findBrowseButton(wrapper, "external editor binary").trigger("click");
    await flushPromises();

    expect(browseFile).toHaveBeenCalled();
    const notifications = useNotificationStore();
    expect(notifications.sessions).toHaveLength(1);
    expect(notifications.sessions[0].events[0].title).toBe("Failed to open picker");
  });

  test("browseCloudflared: a rejecting browseFile shows an error notification instead of throwing", async () => {
    const browseFile = vi.fn().mockRejectedValueOnce(new Error("picker crashed"));
    const wrapper = mountTab({ browseFile });

    await findBrowseButton(wrapper, "cloudflared binary").trigger("click");
    await flushPromises();

    expect(browseFile).toHaveBeenCalled();
    const notifications = useNotificationStore();
    expect(notifications.sessions).toHaveLength(1);
    expect(notifications.sessions[0].events[0].title).toBe("Failed to open picker");
  });

  test("browseClipboardImageDir: a rejecting browseDirectory shows an error notification instead of throwing", async () => {
    const browseDirectory = vi.fn().mockRejectedValueOnce(new Error("picker crashed"));
    const wrapper = mountTab({ browseDirectory });

    await findBrowseButton(wrapper, "pasted clipboard screenshots").trigger("click");
    await flushPromises();

    expect(browseDirectory).toHaveBeenCalled();
    const notifications = useNotificationStore();
    expect(notifications.sessions).toHaveLength(1);
    expect(notifications.sessions[0].events[0].title).toBe("Failed to open picker");
  });
});
