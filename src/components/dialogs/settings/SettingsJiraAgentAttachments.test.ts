import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, test, vi } from "vitest";
import SettingsJiraAgentAttachments from "./SettingsJiraAgentAttachments.vue";
import { apiKey } from "../../../types/keys.js";
import { useNotificationStore } from "../../../stores/notifications.js";
import { jiraAgentAttachmentLimitsSchema } from "../../../../electron/backend/ipc-schemas.js";

function mountSection(api: Record<string, unknown>, value: unknown = { maxFiles: 20, maxMegabytes: 30 }) {
  return mount(SettingsJiraAgentAttachments, {
    props: { value } as never,
    global: { provide: { [apiKey]: api } },
  });
}

describe("SettingsJiraAgentAttachments", () => {
  beforeEach(() => setActivePinia(createPinia()));

  test("shows the saved limits and saves a payload the real schema accepts", async () => {
    const setJiraAgentAttachmentLimits = vi.fn(async (_payload: unknown) => ({}));
    const wrapper = mountSection({ isRemote: false, setJiraAgentAttachmentLimits });
    const files = wrapper.get('[data-testid="jira-agent-attachments-files"]');
    expect((files.element as HTMLInputElement).value).toBe("20");
    await files.setValue("9999");
    await files.trigger("change");
    await flushPromises();
    expect(setJiraAgentAttachmentLimits).toHaveBeenLastCalledWith({ maxFiles: 500, maxMegabytes: 30 });
    for (const [payload] of setJiraAgentAttachmentLimits.mock.calls)
      expect(jiraAgentAttachmentLimitsSchema.safeParse(payload).success).toBe(true);
    expect(wrapper.get("[role=status]").text()).toBe("Saved");
  });

  test("a failed save reaches the user as an error toast and restores the saved value", async () => {
    const setJiraAgentAttachmentLimits = vi.fn(async () => {
      throw new Error("disk full");
    });
    const wrapper = mountSection({ isRemote: false, setJiraAgentAttachmentLimits });
    const showError = vi.spyOn(useNotificationStore(), "showError");
    const megabytes = wrapper.get('[data-testid="jira-agent-attachments-megabytes"]');
    await megabytes.setValue("80");
    await megabytes.trigger("change");
    await flushPromises();
    expect(showError).toHaveBeenCalled();
    expect((megabytes.element as HTMLInputElement).value).toBe("30");
    expect(wrapper.get("[role=status]").text()).toBe("Not saved");
  });

  test("a remote client sees it disabled with a desktop-only hint and cannot save", async () => {
    const setJiraAgentAttachmentLimits = vi.fn();
    const wrapper = mountSection({ isRemote: true, setJiraAgentAttachmentLimits });
    const files = wrapper.get('[data-testid="jira-agent-attachments-files"]');
    expect(files.attributes("disabled")).toBeDefined();
    expect(wrapper.text()).toContain("Desktop only");
    await files.trigger("change");
    expect(setJiraAgentAttachmentLimits).not.toHaveBeenCalled();
  });
});
