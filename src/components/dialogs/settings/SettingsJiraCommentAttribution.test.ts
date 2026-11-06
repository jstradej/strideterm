import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, test, vi } from "vitest";
import SettingsJiraCommentAttribution from "./SettingsJiraCommentAttribution.vue";
import { apiKey } from "../../../types/keys.js";
import { useNotificationStore } from "../../../stores/notifications.js";
import { jiraCommentAttributionSchema } from "../../../../electron/backend/ipc-schemas.js";

const value = { enabled: true, text: "On behalf of {user} via {account}", position: "before" as const };
const connections = [
  { accountPurpose: "personal", ownIdentity: { displayName: "Jaromír" } },
  { accountPurpose: "technical", verifiedIdentity: { displayName: "Deploy Bot" } },
];

function mountSection(api: Record<string, unknown>, props: Record<string, unknown> = {}) {
  return mount(SettingsJiraCommentAttribution, {
    props: { value, connections, ...props },
    global: { provide: { [apiKey]: api } },
  });
}

describe("SettingsJiraCommentAttribution", () => {
  beforeEach(() => setActivePinia(createPinia()));

  test("renders the controls and a live example from the shared helper", async () => {
    const wrapper = mountSection({ isRemote: false, setJiraCommentAttribution: vi.fn() });
    expect(wrapper.text()).toContain("{user}");
    expect(wrapper.get('[data-testid="jira-attribution-example"]').text()).toBe(
      "On behalf of Jaromír via Deploy Bot\n\nDeployment completed.",
    );
    expect(wrapper.get(".comment-attribution__preview figcaption").text()).toBe("Preview of a comment");
    await wrapper.get('[data-testid="jira-attribution-after"]').setValue(true);
    expect(wrapper.get('[data-testid="jira-attribution-example"]').text()).toMatch(
      /Deployment completed\.\s+On behalf of Jaromír via Deploy Bot$/,
    );
  });

  test("saves a payload the real schema accepts on every control", async () => {
    const setJiraCommentAttribution = vi.fn(async (_payload: unknown) => ({}));
    const wrapper = mountSection({ isRemote: false, setJiraCommentAttribution });
    await wrapper.get('[data-testid="jira-attribution-after"]').setValue(true);
    await flushPromises();
    await wrapper.get('[data-testid="jira-attribution-text"]').setValue("Sent by {account}");
    await wrapper.get('[data-testid="jira-attribution-text"]').trigger("change");
    await flushPromises();
    await wrapper.get('[data-testid="jira-attribution-enabled"]').setValue(false);
    await flushPromises();
    expect(wrapper.get('[data-testid="jira-attribution-before"]').attributes("disabled")).toBeDefined();
    expect(setJiraCommentAttribution).toHaveBeenLastCalledWith({
      enabled: false,
      text: "Sent by {account}",
      position: "after",
    });
    for (const [payload] of setJiraCommentAttribution.mock.calls)
      expect(jiraCommentAttributionSchema.safeParse(payload).success).toBe(true);
    expect(wrapper.get("[role=status]").text()).toBe("Saved");
  });

  test("a failed save reaches the user as an error toast and restores the saved value", async () => {
    const setJiraCommentAttribution = vi.fn(async () => {
      throw new Error("disk full");
    });
    const wrapper = mountSection({ isRemote: false, setJiraCommentAttribution });
    const showError = vi.spyOn(useNotificationStore(), "showError");
    await wrapper.get('[data-testid="jira-attribution-after"]').setValue(true);
    await flushPromises();
    expect(showError).toHaveBeenCalledWith("Failed to save the comment attribution", expect.any(Error));
    expect(wrapper.get("[role=status]").text()).toBe("Not saved");
    expect((wrapper.get('[data-testid="jira-attribution-before"]').element as HTMLInputElement).checked).toBe(true);
  });

  test("is disabled with a desktop-only hint on a remote client", async () => {
    const setJiraCommentAttribution = vi.fn();
    const wrapper = mountSection({ isRemote: true });
    for (const id of ["enabled", "text", "before", "after"])
      expect(wrapper.get(`[data-testid="jira-attribution-${id}"]`).attributes("disabled")).toBeDefined();
    expect(wrapper.text()).toContain("Desktop only");
    await wrapper.get('[data-testid="jira-attribution-after"]').trigger("click");
    expect(setJiraCommentAttribution).not.toHaveBeenCalled();
  });
});
