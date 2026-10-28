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

const checkbox = '[data-testid="ssh-tools-checkbox"]';

describe("WorkspaceDialog SSH tools option", () => {
  test("sits after the internal MCP option and defaults to off when creating a workspace", async () => {
    const { wrapper, onSubmit } = mountDialog({ creating: true });
    const boxes = wrapper.findAll(".internal-mcp-option input[type=checkbox]");
    expect(boxes.map((box) => box.attributes("data-testid"))).toEqual(["internal-mcp-checkbox", "ssh-tools-checkbox"]);
    expect((wrapper.get(checkbox).element as HTMLInputElement).checked).toBe(false);
    await wrapper.get("input").setValue("Name");
    await wrapper.get("form").trigger("submit");
    await flushPromises();
    expect(onSubmit.mock.calls[0]?.[0]).toMatchObject({ sshMcpEnabled: false, internalMcpEnabled: false });
  });

  test("create: ticking it sends sshMcpEnabled true and leaves the internal MCP option alone", async () => {
    const { wrapper, onSubmit } = mountDialog({ creating: true });
    await wrapper.get(checkbox).setValue(true);
    await wrapper.get("form").trigger("submit");
    await flushPromises();
    expect(onSubmit.mock.calls[0]?.[0]).toMatchObject({ sshMcpEnabled: true, internalMcpEnabled: false });
  });

  test("edit: toggles only this workspace's flag in the saved draft and keeps the rest", async () => {
    const { wrapper, onSubmit } = mountDialog({ workspace: { ...existing, sshMcpEnabled: false } });
    const box = wrapper.get(checkbox);
    expect((box.element as HTMLInputElement).checked).toBe(false);
    await box.setValue(true);
    await wrapper.get("form").trigger("submit");
    await flushPromises();
    expect(onSubmit.mock.calls[0]?.[0]).toMatchObject({
      id: "ws-1",
      name: "Project",
      cwd: "/tmp/project",
      sshMcpEnabled: true,
      internalMcpEnabled: false,
    });
  });

  test("edit: an existing true value is shown and preserved", async () => {
    const { wrapper, onSubmit } = mountDialog({ workspace: { ...existing, sshMcpEnabled: true } });
    expect((wrapper.get(checkbox).element as HTMLInputElement).checked).toBe(true);
    await wrapper.get("form").trigger("submit");
    await flushPromises();
    expect(onSubmit.mock.calls[0]?.[0]).toMatchObject({ sshMcpEnabled: true });
  });

  test("explains what the agent gets and how it relates to the per-tab option", () => {
    const { wrapper } = mountDialog({ workspace: existing });
    const hint = wrapper.get(checkbox).element.closest("label")!.textContent || "";
    expect(hint).toContain("Built-in SSH hosts");
    expect(hint).toContain("System SSH or WSL are not offered");
    expect(hint).toContain("SSH tools for this tab");
    expect(hint).toContain("Restart open agent sessions");
  });

  test("remote transport: checkbox is disabled with a desktop-only hint and the value is unchanged", async () => {
    useAppStore().isRemoteTransport = true;
    const { wrapper, onSubmit } = mountDialog({ workspace: { ...existing, sshMcpEnabled: true } });
    const box = wrapper.get(checkbox);
    expect((box.element as HTMLInputElement).disabled).toBe(true);
    expect(box.element.closest("label")!.textContent).toContain("Desktop only");
    await wrapper.get("form").trigger("submit");
    await flushPromises();
    expect(onSubmit.mock.calls[0]?.[0]).toMatchObject({ sshMcpEnabled: true });
  });

  test("not offered for a task workspace, and its draft carries no flag", async () => {
    const { wrapper } = mountDialog({
      workspace: {
        ...existing,
        kind: "task",
        sshMcpEnabled: true,
        task: { description: "", maxRounds: 10, workerPanelId: "a", judgePanelId: "b" },
      },
    });
    expect(wrapper.find(checkbox).exists()).toBe(false);
  });

  test.each([["azure"], ["github"]])("offered for a %s inbox as the default for new review children", async (kind) => {
    const { wrapper } = mountDialog({ workspace: { ...existing, kind } });
    const box = wrapper.find(checkbox);
    expect(box.exists()).toBe(true);
    expect(box.element.closest("label")!.textContent).toContain(
      "Applies to new workspaces created with New Branch or opened manually for a PR",
    );
  });
});
