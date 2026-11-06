import { describe, expect, test, beforeEach, vi } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import WorkspaceDialog from "./WorkspaceDialog.vue";
import { apiKey } from "../../types/keys.js";
import { useAppStore } from "../../stores/app.js";

beforeEach(() => {
  setActivePinia(createPinia());
});

function mountDialog(props: Record<string, unknown> = {}) {
  const onSubmit = vi.fn(async (_payload: unknown) => {});
  const wrapper = mount(WorkspaceDialog, {
    props: { onCancel: vi.fn(), onSubmit, ...props },
    global: { provide: { [apiKey]: {} } },
  });
  return { wrapper, onSubmit };
}

const existing = {
  id: "ws-1",
  name: "Project",
  icon: "x",
  color: "#7C4DFF",
  kind: "terminal",
  source: "manual",
  pluginId: "",
  cwd: "/tmp/project",
  notes: "",
  activePanelId: "p1",
  panels: [{ id: "p1", title: "Shell", command: "", shell: true, startup: "default" }],
};

describe("WorkspaceDialog internal MCP option", () => {
  test("defaults to off when creating a workspace", async () => {
    const { wrapper, onSubmit } = mountDialog({ creating: true });
    const box = wrapper.get('[data-testid="internal-mcp-checkbox"]');
    expect((box.element as HTMLInputElement).checked).toBe(false);
    await wrapper.get("input").setValue("Name");
    await wrapper.get("form").trigger("submit");
    await flushPromises();
    expect(onSubmit.mock.calls[0]?.[0]).toMatchObject({ internalMcpEnabled: false });
  });

  test("create: ticking it sends internalMcpEnabled true", async () => {
    const { wrapper, onSubmit } = mountDialog({ creating: true });
    await wrapper.get('[data-testid="internal-mcp-checkbox"]').setValue(true);
    await wrapper.get("form").trigger("submit");
    await flushPromises();
    expect(onSubmit.mock.calls[0]?.[0]).toMatchObject({ internalMcpEnabled: true });
  });

  test("edit: toggles only this workspace's flag in the saved draft and keeps the rest", async () => {
    const { wrapper, onSubmit } = mountDialog({ workspace: { ...existing, internalMcpEnabled: false } });
    const box = wrapper.get('[data-testid="internal-mcp-checkbox"]');
    expect((box.element as HTMLInputElement).checked).toBe(false);
    await box.setValue(true);
    await wrapper.get("form").trigger("submit");
    await flushPromises();
    const sent = onSubmit.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(sent).toMatchObject({ id: "ws-1", name: "Project", cwd: "/tmp/project", internalMcpEnabled: true });
  });

  test("edit: an existing true value is shown and preserved", async () => {
    const { wrapper, onSubmit } = mountDialog({ workspace: { ...existing, internalMcpEnabled: true } });
    expect((wrapper.get('[data-testid="internal-mcp-checkbox"]').element as HTMLInputElement).checked).toBe(true);
    await wrapper.get("form").trigger("submit");
    await flushPromises();
    expect(onSubmit.mock.calls[0]?.[0]).toMatchObject({ internalMcpEnabled: true });
  });

  test("remote transport: checkbox is disabled with a desktop-only hint and the value is unchanged", async () => {
    useAppStore().isRemoteTransport = true;
    const { wrapper, onSubmit } = mountDialog({ workspace: { ...existing, internalMcpEnabled: true } });
    const box = wrapper.get('[data-testid="internal-mcp-checkbox"]');
    expect((box.element as HTMLInputElement).disabled).toBe(true);
    expect(wrapper.text()).toContain("Desktop only");
    await wrapper.get("form").trigger("submit");
    await flushPromises();
    expect(onSubmit.mock.calls[0]?.[0]).toMatchObject({ internalMcpEnabled: true });
  });

  test("task workspaces do not get the generic task MCP flag and Jira access defaults off", async () => {
    const { wrapper } = mountDialog({
      workspace: {
        ...existing,
        kind: "task",
        internalMcpEnabled: true,
        task: { description: "", maxRounds: 10, workerPanelId: "a", judgePanelId: "b" },
      },
    });
    expect(wrapper.find('[data-testid="internal-mcp-checkbox"]').exists()).toBe(false);
    expect((wrapper.get('[data-testid="jira-mcp-checkbox"]').element as HTMLInputElement).checked).toBe(false);
  });

  test.each([["azure"], ["github"]])("offered for a %s inbox as the default for new review children", async (kind) => {
    const { wrapper } = mountDialog({ workspace: { ...existing, kind } });
    expect(wrapper.find('[data-testid="internal-mcp-checkbox"]').exists()).toBe(true);
    expect(wrapper.get(".internal-mcp-hint").text()).toContain(
      "Applies to new workspaces created with New Branch or opened manually for a PR",
    );
  });

  test("offered for a quickfix workspace", async () => {
    const { wrapper } = mountDialog({ workspace: { ...existing, quickfix: { prId: 1 } } });
    expect(wrapper.find('[data-testid="internal-mcp-checkbox"]').exists()).toBe(true);
    expect(wrapper.get(".internal-mcp-hint").text()).toContain("Restart open agent sessions to apply changes");
  });

  test("Jira MCP is a separate opt-in, defaults off, and is saved per terminal workspace", async () => {
    const { wrapper, onSubmit } = mountDialog({ workspace: existing });
    expect((wrapper.get('[data-testid="jira-mcp-checkbox"]').element as HTMLInputElement).checked).toBe(false);
    await wrapper.get('[data-testid="jira-mcp-checkbox"]').setValue(true);
    await wrapper.get("form").trigger("submit");
    await flushPromises();
    expect(onSubmit.mock.calls[0]?.[0]).toMatchObject({ jiraMcpEnabled: true, internalMcpEnabled: false });
  });

  test("Jira MCP flag is preserved on edit and remains separate on eligible task workspaces", async () => {
    const { wrapper, onSubmit } = mountDialog({ workspace: { ...existing, jiraMcpEnabled: true } });
    expect((wrapper.get('[data-testid="jira-mcp-checkbox"]').element as HTMLInputElement).checked).toBe(true);
    await wrapper.get("form").trigger("submit");
    await flushPromises();
    expect(onSubmit.mock.calls[0]?.[0]).toMatchObject({ jiraMcpEnabled: true });
    const task = mountDialog({ workspace: { ...existing, kind: "task", jiraMcpEnabled: true } });
    expect((task.wrapper.get('[data-testid="jira-mcp-checkbox"]').element as HTMLInputElement).checked).toBe(true);
    expect(task.wrapper.find('[data-testid="internal-mcp-checkbox"]').exists()).toBe(false);
    const review = mountDialog({ workspace: { ...existing, kind: "github", jiraMcpEnabled: true } });
    expect(review.wrapper.find('[data-testid="jira-mcp-checkbox"]').exists()).toBe(false);
  });
});
