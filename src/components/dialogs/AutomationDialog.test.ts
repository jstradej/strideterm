import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { useAppStore } from "../../stores/app.js";
import { automationCreateSchema, automationDefinitionInputSchema } from "../../../electron/shared/automation-api.js";
import AutomationDialog from "./AutomationDialog.vue";
import { AutomationCreationFailed } from "../../stores/automations.js";
import CustomSelect from "../common/CustomSelect.vue";

const parent = {
  id: "project",
  name: "Project",
  cwd: "/repo",
  profileId: "default",
  kind: "manual",
  jiraMcpEnabled: true,
  sshMcpEnabled: false,
  sandboxEnabled: false,
};
function setup(
  onSubmit: ReturnType<typeof vi.fn>,
  parentOverride: Partial<typeof parent> & { gitRoots?: string[] } = {},
) {
  return mount(AutomationDialog, {
    props: { parent: { ...parent, ...parentOverride } as never, onSubmit, onCancel: vi.fn() },
    global: { stubs: { WorkspaceSandboxSection: true } },
  });
}
type SelectProps = { modelValue: unknown; options: Array<{ value: string | number; label: string }> };
const selectProps = (select: { props: () => unknown }) => select.props() as unknown as SelectProps;
function selectWith(wrapper: ReturnType<typeof setup>, value: string) {
  const select = wrapper
    .findAllComponents(CustomSelect)
    .find((candidate) => selectProps(candidate).options.some((option) => option.value === value));
  if (!select) throw new Error(`No select offers "${value}"`);
  return select;
}
describe("AutomationDialog", () => {
  beforeEach(() => setActivePinia(createPinia()));
  it("submits a valid literal prompt and respects the parent's tool grants", async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const wrapper = setup(onSubmit);
    await wrapper.find("input[maxlength='200']").setValue("Daily check");
    await wrapper.find("textarea").setValue("Read everything exactly.\nSecond line.");
    await wrapper.find("form").trigger("submit");
    await flushPromises();
    expect(onSubmit).toHaveBeenCalledOnce();
    const input = onSubmit.mock.calls[0]![0];
    expect(automationDefinitionInputSchema.safeParse(input.definition).success).toBe(true);
    expect(input.definition.prompt).toBe("Read everything exactly.\nSecond line.");
    expect(input.jiraMcpEnabled).toBe(true);
    expect(input.sshMcpEnabled).toBe(false);
    expect(input.testRun).toBeUndefined();
  });
  it("validates and explicitly requests a test run only from Save & test", async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const wrapper = setup(onSubmit);
    const testButton = wrapper.findAll("button").find((button) => button.text() === "Save & test")!;
    await testButton.trigger("click");
    expect(onSubmit).not.toHaveBeenCalled();
    await wrapper.find("input[maxlength='200']").setValue("Test this automation");
    await wrapper.find("textarea").setValue("Report disk usage");
    await testButton.trigger("click");
    await flushPromises();
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ testRun: true }));
    await selectWith(wrapper, "worktree").setValue("worktree");
    expect(testButton.attributes("disabled")).toBeDefined();
  });
  it("keeps an error visible when saving fails", async () => {
    const wrapper = setup(vi.fn().mockRejectedValue(new Error("Changed elsewhere")));
    await wrapper.find("input[maxlength='200']").setValue("Job");
    await wrapper.find("textarea").setValue("prompt");
    await wrapper.find("form").trigger("submit");
    await flushPromises();
    expect(wrapper.get('[role="alert"]').text()).toContain("Changed elsewhere");
    expect(wrapper.find("form").exists()).toBe(true);
  });
  it("submits a worktree request with a stable idempotency key", async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const wrapper = setup(onSubmit);
    await wrapper.find("input[maxlength='200']").setValue("Job");
    await wrapper.find("textarea").setValue("prompt");
    await selectWith(wrapper, "worktree").setValue("worktree");
    await wrapper.find('input[placeholder="automation/my-job"]').setValue("auto/job");
    await wrapper.find("form").trigger("submit");
    await flushPromises();
    const input = onSubmit.mock.calls[0]![0];
    expect(automationCreateSchema.safeParse({ ...input, parentWorkspaceId: parent.id }).success).toBe(true);
    expect(input.checkout).toEqual({ mode: "worktree", branch: "auto/job" });
    expect(input.idempotencyKey).toBeTruthy();
  });
  it("preserves worktree inputs on failure and allows a corrected request with a new key", async () => {
    let reject!: (error: Error) => void;
    const onSubmit = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((_resolve, fail) => {
            reject = fail;
          }),
      )
      .mockResolvedValue(undefined);
    const wrapper = setup(onSubmit);
    await wrapper.find("input[maxlength='200']").setValue("My job");
    await wrapper.find("textarea").setValue("A long prompt that must survive failure");
    await selectWith(wrapper, "worktree").setValue("worktree");
    await wrapper.find('input[placeholder="automation/my-job"]').setValue("auto/existing");
    await wrapper.find("form").trigger("submit");
    expect(wrapper.get("fieldset.automation-form__fields").attributes("disabled")).toBeDefined();
    (wrapper.vm as unknown as { requestClose: () => void }).requestClose();
    expect(wrapper.emitted("cancel")).toBeUndefined();
    reject(new AutomationCreationFailed("Branch already exists; choose another branch."));
    await flushPromises();
    expect(wrapper.get('[role="alert"]').text()).toContain("Branch already exists");
    expect(wrapper.get('[role="alert"]').element.closest(".automation-form__body")).toBeNull();
    expect(wrapper.get("textarea").element.value).toBe("A long prompt that must survive failure");
    expect(wrapper.get<HTMLInputElement>("input[maxlength='200']").element.value).toBe("My job");
    await wrapper.find('input[placeholder="automation/my-job"]').setValue("auto/corrected");
    await wrapper.find("form").trigger("submit");
    await flushPromises();
    expect(onSubmit.mock.calls[1]![0].checkout.branch).toBe("auto/corrected");
    expect(onSubmit.mock.calls[1]![0].idempotencyKey).not.toBe(onSubmit.mock.calls[0]![0].idempotencyKey);
    expect(wrapper.find('[role="alert"]').exists()).toBe(false);
    wrapper.unmount();
  });
  it("retains the request key after an ambiguous connection error", async () => {
    const onSubmit = vi.fn().mockRejectedValueOnce(new Error("Connection lost")).mockResolvedValue(undefined);
    const wrapper = setup(onSubmit);
    await wrapper.find("input[maxlength='200']").setValue("Job");
    await wrapper.find("textarea").setValue("prompt");
    await selectWith(wrapper, "worktree").setValue("worktree");
    await wrapper.find('input[placeholder="automation/my-job"]').setValue("auto/job");
    await wrapper.find("form").trigger("submit");
    await flushPromises();
    await wrapper.find("form").trigger("submit");
    await flushPromises();
    expect(onSubmit.mock.calls[1]![0].idempotencyKey).toBe(onSubmit.mock.calls[0]![0].idempotencyKey);
    wrapper.unmount();
  });
  it("explains event data and literal prompts through accessible help", async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const wrapper = setup(onSubmit);
    await selectWith(wrapper, "event").setValue("event");
    await wrapper.get('[aria-label="Event data and prompt help"]').trigger("click");
    await flushPromises();
    const help = document.body.querySelector('[role="tooltip"][data-open="true"]')!;
    expect(help.textContent).toContain("JSON array");
    expect(help.textContent).toContain("pullRequestNumber");
    expect(help.textContent).toContain("issueKey");
    expect(help.textContent).toContain("no placeholder substitution");
    expect(help.textContent).toContain("Comment bodies, issue descriptions");
    await wrapper.find("input[maxlength='200']").setValue("Events");
    await wrapper.find("textarea").setValue("Read EVENT.json; {{pr.title}} is literal.");
    await wrapper.find("form").trigger("submit");
    await flushPromises();
    expect(onSubmit.mock.calls[0]![0].definition.prompt).toBe("Read EVENT.json; {{pr.title}} is literal.");
    wrapper.unmount();
  });
  it("shows source-specific JSON next to the prompt without opening help", async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const wrapper = setup(onSubmit);
    await selectWith(wrapper, "event").setValue("event");
    const preview = wrapper.get('[aria-label="Event data example"]');
    const readExample = () => JSON.parse(preview.get("pre").text());
    expect(readExample()).toEqual([
      expect.objectContaining({
        source: "github",
        kind: "pr-new",
        pr: expect.objectContaining({
          title: "Fix login redirect",
          pullRequestNumber: 42,
          webUrl: expect.stringContaining("github.com"),
        }),
      }),
    ]);
    await wrapper.find('input[value="pr-check-finished"]').setValue(true);
    await selectWith(wrapper, "pr-check-finished").setValue("pr-check-finished");
    expect(readExample()[0]).toMatchObject({ check: { name: "Unit tests", result: "succeeded" } });
    await selectWith(wrapper, "azure-devops").setValue("azure-devops");
    expect(readExample()[0]).toMatchObject({
      source: "azure-devops",
      pr: { webUrl: expect.stringContaining("dev.azure.com") },
    });
    await selectWith(wrapper, "jira").setValue("jira");
    expect(preview.text()).toContain("Select at least one event kind");
    expect(preview.find("pre").exists()).toBe(false);
    await wrapper.find('input[value="jira-issue-changed"]').setValue(true);
    expect(readExample()[0]).toMatchObject({
      source: "jira",
      kind: "jira-issue-changed",
      jira: { issueKey: "PROJ-123", issueId: "10042" },
    });
    expect(readExample()[0]).not.toHaveProperty("pr");
    expect(preview.text()).toContain("changed fields are not included");
    expect(wrapper.get("textarea").element.value).toBe("");
    expect(onSubmit).not.toHaveBeenCalled();
    wrapper.unmount();
  });
  it("inserts event instructions without replacing the user's prompt", async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const wrapper = setup(onSubmit);
    await wrapper.find("input[maxlength='200']").setValue("My event automation");
    await selectWith(wrapper, "event").setValue("event");
    await wrapper.get("textarea").setValue("Keep this instruction.");
    const editor = wrapper.get("textarea").element;
    editor.setSelectionRange(editor.value.length, editor.value.length);
    await wrapper.get(".event-context__insert").trigger("click");
    expect(editor.value).toMatch(/^Keep this instruction\.\n\nRead EVENT.json/u);
    expect(editor.value).toContain("pr.title, pr.pullRequestNumber");
    await wrapper.find("form").trigger("submit");
    await flushPromises();
    expect(onSubmit.mock.calls[0]![0].definition.prompt).toBe(editor.value);
    wrapper.unmount();
  });
  it("accepts supported PR reviews and rejects incompatible event kinds", async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const wrapper = setup(onSubmit);
    await wrapper.find("input[maxlength='200']").setValue("Review");
    await wrapper.find("textarea").setValue("Review the changes");
    await selectWith(wrapper, "event").setValue("event");
    await selectWith(wrapper, "pr-review").setValue("pr-review");
    expect(wrapper.text()).toContain("review tools only");
    await wrapper.find("form").trigger("submit");
    await flushPromises();
    expect(onSubmit.mock.calls[0]![0].definition.location).toBe("pr-review");
    await wrapper.find('input[value="pr-merged"]').setValue(true);
    await wrapper.find("form").trigger("submit");
    await flushPromises();
    expect(wrapper.get('[role="alert"]').text()).toContain("requires a supported PR event");
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });
  it("clears a Jira query when switching to a different connection", async () => {
    useAppStore().payload = {
      automations: {
        connections: [
          { id: "first", source: "jira", profileId: "default", label: "First" },
          { id: "second", source: "jira", profileId: "default", label: "Second" },
        ],
        queries: [{ id: "query", connectionId: "first", profileId: "default", name: "Watched issues" }],
      },
    } as never;
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const wrapper = setup(onSubmit);
    await wrapper.find("input[maxlength='200']").setValue("Jira job");
    await wrapper.find("textarea").setValue("Check issues");
    await selectWith(wrapper, "event").setValue("event");
    await selectWith(wrapper, "jira").setValue("jira");
    await wrapper.find('input[value="jira-issue-added"]').setValue(true);
    const connection = selectWith(wrapper, "first");
    await connection.setValue("first");
    await selectWith(wrapper, "query").setValue("query");
    await connection.setValue("second");
    await wrapper.find("form").trigger("submit");
    await flushPromises();
    const definition = onSubmit.mock.calls[0]![0].definition;
    expect(automationDefinitionInputSchema.safeParse(definition).success).toBe(true);
    expect(definition.trigger).toMatchObject({ source: "jira", connectionId: "second" });
    expect(definition.trigger.jiraQueryId).toBeUndefined();
  });
  it("requires a repository for a new worktree when the parent has several", async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const wrapper = setup(onSubmit, { gitRoots: ["/repo", "/repo/tools"] });
    await wrapper.find("input[maxlength='200']").setValue("Job");
    await wrapper.find("textarea").setValue("prompt");
    await selectWith(wrapper, "worktree").setValue("worktree");
    await wrapper.find('input[placeholder="automation/my-job"]').setValue("auto/job");
    await wrapper.find("form").trigger("submit");
    await flushPromises();
    expect(onSubmit).not.toHaveBeenCalled();
    expect(wrapper.get('[role="alert"]').text()).toContain("Select a repository");
    await selectWith(wrapper, "/repo/tools").setValue("/repo/tools");
    await wrapper.find("form").trigger("submit");
    await flushPromises();
    expect(onSubmit.mock.calls[0]![0].checkout).toEqual({
      mode: "worktree",
      branch: "auto/job",
      repository: "/repo/tools",
    });
    wrapper.unmount();
  });
  it("clears the effort only when the provider actually changes", async () => {
    const wrapper = setup(vi.fn().mockResolvedValue(undefined));
    await selectWith(wrapper, "xhigh").setValue("high");
    await selectWith(wrapper, "codex").setValue("claude");
    expect(selectProps(selectWith(wrapper, "xhigh")).modelValue).toBe("high");
    await selectWith(wrapper, "codex").setValue("codex");
    expect(selectProps(selectWith(wrapper, "xhigh")).modelValue).toBe("");
    wrapper.unmount();
  });
});
