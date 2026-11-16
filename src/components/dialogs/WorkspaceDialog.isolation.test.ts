import { describe, expect, test, beforeEach, vi } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import WorkspaceDialog from "./WorkspaceDialog.vue";
import { apiKey } from "../../types/keys.js";
import { useAppStore } from "../../stores/app.js";

beforeEach(() => {
  setActivePinia(createPinia());
});

const status = { platform: "linux", ready: true, prerequisites: [], agents: [], notes: [] };

function mountDialog(props: Record<string, unknown> = {}) {
  const onSubmit = vi.fn(async (_payload: unknown) => {});
  const getSandboxStatus = vi.fn(async () => status);
  const wrapper = mount(WorkspaceDialog, {
    props: { onCancel: vi.fn(), onSubmit, ...props },
    global: { provide: { [apiKey]: { getSandboxStatus } } },
  });
  return { wrapper, onSubmit, getSandboxStatus };
}

function seed(settings: Record<string, unknown>, workspaces: Array<Record<string, unknown>> = []) {
  useAppStore().payload = {
    appState: { settings, workspaces, profiles: [{ id: "default", name: "Default" }] },
  } as never;
}

const sandboxBox = '[data-testid="sandbox-checkbox"]';
const isChecked = (wrapper: ReturnType<typeof mountDialog>["wrapper"]) =>
  (wrapper.get(sandboxBox).element as HTMLInputElement).checked;

describe("WorkspaceDialog: the default for isolating new workspaces", () => {
  test("a new workspace starts isolated when the desktop default says so, and the user can still turn it off", async () => {
    seed({ isolateNewWorkspaces: true });
    const { wrapper, onSubmit } = mountDialog();
    expect(isChecked(wrapper)).toBe(true);
    await wrapper.get(sandboxBox).setValue(false);
    await wrapper.get("input[name='name']").setValue("A");
    await wrapper.get("form").trigger("submit");
    await flushPromises();
    expect(onSubmit.mock.calls[0]?.[0]).toMatchObject({ sandboxEnabled: false });
  });

  test("a new workspace submits sandboxEnabled true when the default is on", async () => {
    seed({ isolateNewWorkspaces: true });
    const { wrapper, onSubmit } = mountDialog();
    await wrapper.get("input[name='name']").setValue("A");
    await wrapper.get("form").trigger("submit");
    await flushPromises();
    expect(onSubmit.mock.calls[0]?.[0]).toMatchObject({ sandboxEnabled: true });
  });

  test("without the default a new workspace starts off", () => {
    seed({ isolateNewWorkspaces: false });
    expect(isChecked(mountDialog().wrapper)).toBe(false);
  });

  test("the default never touches a workspace that already exists", () => {
    seed({ isolateNewWorkspaces: true });
    const { wrapper } = mountDialog({
      workspace: {
        id: "ws-1",
        name: "Old",
        icon: "x",
        color: "#7C4DFF",
        kind: "terminal",
        source: "manual",
        pluginId: "",
        cwd: "/tmp/old",
        notes: "",
        activePanelId: "p1",
        panels: [{ id: "p1", title: "Shell", command: "", shell: true, startup: "default" }],
      },
    });
    expect(isChecked(wrapper)).toBe(false);
  });

  test("a remote client does not apply it", () => {
    useAppStore().isRemoteTransport = true;
    seed({ isolateNewWorkspaces: true });
    expect(isChecked(mountDialog().wrapper)).toBe(false);
  });
});

describe("WorkspaceDialog: isolation of a new task", () => {
  const taskDraft = () => ({
    id: "workspace-test",
    name: "",
    icon: "\u{1F916}",
    color: "#7C4DFF",
    kind: "task",
    source: "manual",
    pluginId: "",
    cwd: "/tmp/project",
    notes: "",
    activePanelId: "panel-dash",
    panels: [
      { id: "panel-dash", title: "Dashboard", command: "__task-dashboard__", shell: false, startup: "none" },
      { id: "panel-worker", title: "Worker", command: "claude --model sonnet", shell: true, startup: "default" },
      { id: "panel-judge", title: "Judge", command: "claude --model opus", shell: true, startup: "default" },
    ],
    task: { description: "", workerPanelId: "panel-worker", judgePanelId: "panel-judge", maxRounds: 10 },
    useWorktree: false,
    worktreeBranch: "",
  });
  const parent = (sandboxEnabled: boolean) => ({
    id: "parent-1",
    name: "Parent",
    kind: "terminal",
    cwd: "/tmp/project",
    profileId: "default",
    sandboxEnabled,
    panels: [],
  });

  test("starts from the workspace it belongs to, and can be turned on when the workspace is not isolated", async () => {
    seed({}, [parent(false)]);
    const { wrapper, onSubmit } = mountDialog({ workspace: taskDraft(), creating: true });
    expect(isChecked(wrapper)).toBe(false);
    expect((wrapper.get(sandboxBox).element as HTMLInputElement).disabled).toBe(false);
    expect(wrapper.get('[data-testid="sandbox-section"]').text()).toContain("Run in isolation");
    await wrapper.get(sandboxBox).setValue(true);
    await wrapper.get("form").trigger("submit");
    await flushPromises();
    expect(onSubmit.mock.calls[0]?.[0]).toMatchObject({
      kind: "task",
      sandboxEnabled: true,
      parentWorkspaceId: "parent-1",
    });
  });

  test("is on and cannot be turned off under an isolated workspace", async () => {
    seed({}, [parent(true)]);
    const { wrapper, onSubmit, getSandboxStatus } = mountDialog({ workspace: taskDraft(), creating: true });
    await flushPromises();
    expect(isChecked(wrapper)).toBe(true);
    expect((wrapper.get(sandboxBox).element as HTMLInputElement).disabled).toBe(true);
    expect(wrapper.get('[data-testid="sandbox-section"]').text()).toContain("its tasks always are");
    expect(getSandboxStatus).toHaveBeenCalled();
    expect(wrapper.find('[data-testid="sandbox-ready"]').exists()).toBe(true);
    await wrapper.get("form").trigger("submit");
    await flushPromises();
    expect(onSubmit.mock.calls[0]?.[0]).toMatchObject({ sandboxEnabled: true });
  });

  test("is locked on a remote client, which still shows the parent's value", () => {
    useAppStore().isRemoteTransport = true;
    seed({}, [parent(true)]);
    const { wrapper, getSandboxStatus } = mountDialog({ workspace: taskDraft(), creating: true });
    expect(isChecked(wrapper)).toBe(true);
    expect((wrapper.get(sandboxBox).element as HTMLInputElement).disabled).toBe(true);
    expect(wrapper.get('[data-testid="sandbox-section"]').text()).toContain("Desktop only");
    expect(getSandboxStatus).not.toHaveBeenCalled();
  });

  test("is not part of editing an existing task", () => {
    seed({}, [parent(true)]);
    const { wrapper } = mountDialog({ workspace: taskDraft() });
    expect(wrapper.find(sandboxBox).exists()).toBe(false);
  });
});
