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
  const onSubmit = vi.fn(async () => {});
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

  test("not offered for a task workspace, and its draft carries no flag", async () => {
    const { wrapper } = mountDialog({
      workspace: {
        ...existing,
        kind: "task",
        internalMcpEnabled: true,
        task: { description: "", maxRounds: 10, workerPanelId: "a", judgePanelId: "b" },
      },
    });
    expect(wrapper.find('[data-testid="internal-mcp-checkbox"]').exists()).toBe(false);
  });
});
