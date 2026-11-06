import { beforeEach, describe, expect, test, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import JiraUpdateDialog from "./JiraUpdateDialog.vue";
import CustomSelect from "../common/CustomSelect.vue";
import { useAppStore } from "../../stores/app.js";
import { useNotificationStore } from "../../stores/notifications.js";
import { jiraWriteExecuteSchema, jiraWritePreviewSchema } from "../../../electron/backend/ipc-schemas.js";

const issue = {
  ref: { connectionId: "jira-a", issueId: "1001", issueKey: "ABC-7" },
  summary: "Retry failed deliveries",
  status: "In Progress",
};
const pullRequest = { url: "https://dev.azure.com/acme/_git/orders/pullrequest/42", number: 42, title: "ABC-7: Retry" };

function setup(overrides: Record<string, unknown> = {}) {
  const api = {
    listJiraTransitions: vi.fn(async () => [
      { id: "11", name: "Start review", to: "In Review", requiredFields: [] },
      { id: "21", name: "Resolve", to: "Done", requiredFields: [{ id: "resolution", name: "Resolution" }] },
      { id: "31", name: "Back to open", to: "Open", requiredFields: [] },
    ]),
    previewJiraWrite: vi.fn(async (payload: { action: string }) => ({
      token: `token-${payload.action}`,
      intent: "Report the created pull request on the Jira issue",
      preview: `Preview of ${payload.action}`,
      account: { displayName: "Ann", purpose: "personal" },
    })),
    executeJiraWrite: vi.fn(async (_payload: unknown) => ({ ok: true, data: {} })),
    ...overrides,
  };
  vi.spyOn(useAppStore(), "getApi").mockReturnValue(api as never);
  const onClose = vi.fn();
  const wrapper = mount(JiraUpdateDialog, { props: { issue, pullRequest, onClose } });
  return { api, wrapper, onClose };
}

beforeEach(() => {
  setActivePinia(createPinia());
});

describe("JiraUpdateDialog", () => {
  test("proposes a comment with the PR link, the link itself and the review status; nothing is written before Confirm", async () => {
    const { api, wrapper } = setup();
    await flushPromises();
    expect((wrapper.get("textarea").element as HTMLTextAreaElement).value).toContain(pullRequest.url);
    const select = wrapper.getComponent(CustomSelect) as unknown as { props(key: string): unknown };
    expect(select.props("modelValue")).toBe("11");
    // A transition that needs extra fields cannot be filled in here, so it is not offered.
    expect((select.props("options") as Array<{ value: string }>).map((option) => option.value)).toEqual([
      "",
      "11",
      "31",
    ]);
    expect(wrapper.text()).toContain("1 transition needs extra fields");

    await wrapper.get("form").trigger("submit");
    await flushPromises();
    expect(api.previewJiraWrite.mock.calls.map(([payload]) => (payload as { action: string }).action)).toEqual([
      "comment",
      "remote-link",
      "transition",
    ]);
    for (const [payload] of api.previewJiraWrite.mock.calls)
      expect(jiraWritePreviewSchema.safeParse(payload).success).toBe(true);
    expect(api.executeJiraWrite).not.toHaveBeenCalled();
    expect(wrapper.text()).toContain("Sent to Jira by Ann");
    expect(wrapper.text()).toContain("Preview of transition");

    await wrapper.get("form").trigger("submit");
    await flushPromises();
    expect(api.executeJiraWrite).toHaveBeenCalledTimes(3);
    for (const [payload] of api.executeJiraWrite.mock.calls)
      expect(jiraWriteExecuteSchema.safeParse(payload).success).toBe(true);
    expect(api.executeJiraWrite.mock.calls[2]![0]).toMatchObject({
      action: "transition",
      transitionId: "11",
      confirmation: { token: "token-transition" },
    });
    expect(wrapper.text()).toContain("Status → In Review");
    expect(useNotificationStore().persistentToasts.some((toast) => toast.title === "ABC-7 updated")).toBe(true);
  });

  test("only what is ticked is sent, and a failed write is reported without hiding the ones that worked", async () => {
    const { api, wrapper } = setup({
      executeJiraWrite: vi.fn(async (payload: { action: string }) =>
        payload.action === "comment"
          ? { ok: true, data: {} }
          : { ok: false, error: { code: "permission-denied", message: "Not allowed" } },
      ),
    });
    await flushPromises();
    const [, link] = wrapper.findAll('input[type="checkbox"]');
    await link!.setValue(false);
    await wrapper.getComponent(CustomSelect).vm.$emit("update:modelValue", "");
    await wrapper.get("form").trigger("submit");
    await flushPromises();
    await wrapper.get("form").trigger("submit");
    await flushPromises();
    expect(api.executeJiraWrite.mock.calls.map(([payload]) => (payload as { action: string }).action)).toEqual([
      "comment",
    ]);
    expect(wrapper.get(".jira-update-dialog__results").text()).toContain("Comment");
  });

  test("a refused preview stays in the dialog with the reason", async () => {
    const { wrapper } = setup({ previewJiraWrite: vi.fn(async () => Promise.reject(new Error("Jira is offline"))) });
    await flushPromises();
    await wrapper.get("form").trigger("submit");
    await flushPromises();
    expect(wrapper.get("[role=alert]").text()).toContain("Jira is offline");
    expect(useNotificationStore().persistentToasts.some((toast) => toast.title === "Could not update ABC-7")).toBe(
      true,
    );
  });
});
