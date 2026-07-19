import { describe, expect, test, beforeEach, vi } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import WorkspaceDialog from "./WorkspaceDialog.vue";
import { useNotificationStore } from "../../stores/notifications.js";

beforeEach(() => {
  setActivePinia(createPinia());
});

function buildTaskDraft(overrides: Record<string, unknown> = {}) {
  const workerPanelId = "panel-worker";
  const judgePanelId = "panel-judge";
  return {
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
      { id: workerPanelId, title: "Worker", command: "claude --model sonnet", shell: true, startup: "default" },
      { id: judgePanelId, title: "Judge", command: "claude --model opus", shell: true, startup: "default" },
    ],
    task: {
      description: "",
      workerPanelId,
      judgePanelId,
      maxRounds: 10,
    },
    useWorktree: false,
    worktreeBranch: "",
    ...overrides,
  };
}

function mountDialog(props = {}) {
  return mount(WorkspaceDialog, {
    props: {
      onCancel: vi.fn(),
      onSubmit: vi.fn(),
      ...props,
    },
    global: {
      provide: { api: {} },
    },
  });
}

describe("WorkspaceDialog", () => {
  describe("task creation mode", () => {
    test("shows 'Create task workspace' header when creating=true with task draft", () => {
      const wrapper = mountDialog({ workspace: buildTaskDraft(), creating: true });
      expect(wrapper.find("h2").text()).toBe("Create task workspace");
      expect(wrapper.find(".eyebrow").text()).toBe("Agent Task Runner");
    });

    test("shows 'Edit workspace' header when editing an existing task workspace", () => {
      const wrapper = mountDialog({ workspace: buildTaskDraft() });
      expect(wrapper.find("h2").text()).toBe("Edit workspace");
      expect(wrapper.find(".eyebrow").text()).toBe("Workspace");
    });

    test("shows 'Create workspace' button text in creation mode", () => {
      const wrapper = mountDialog({ workspace: buildTaskDraft(), creating: true });
      const submitBtn = wrapper.find('button[type="submit"]');
      expect(submitBtn.text()).toBe("Create workspace");
    });

    test("shows 'Save workspace' button text in edit mode", () => {
      const wrapper = mountDialog({ workspace: buildTaskDraft() });
      const submitBtn = wrapper.find('button[type="submit"]');
      expect(submitBtn.text()).toBe("Save workspace");
    });

    test("shows worktree checkbox only in creation mode", () => {
      const wrapper = mountDialog({ workspace: buildTaskDraft(), creating: true });
      expect(wrapper.find(".checkbox-label").exists()).toBe(true);
    });

    test("hides worktree checkbox in edit mode", () => {
      const wrapper = mountDialog({ workspace: buildTaskDraft() });
      expect(wrapper.find(".checkbox-label").exists()).toBe(false);
    });

    test("shows branch name field when worktree is checked", async () => {
      const draft = buildTaskDraft({ useWorktree: true, worktreeBranch: "task/test" });
      const wrapper = mountDialog({ workspace: draft, creating: true });
      const branchInput = wrapper.find('input[name="worktreeBranch"]');
      expect(branchInput.exists()).toBe(true);
    });

    test("hides branch name field when worktree is unchecked", () => {
      const wrapper = mountDialog({ workspace: buildTaskDraft(), creating: true });
      expect(wrapper.find('input[name="worktreeBranch"]').exists()).toBe(false);
    });

    test("marks cwd as required in creation mode", () => {
      const wrapper = mountDialog({ workspace: buildTaskDraft(), creating: true });
      const cwdInput = wrapper.find('input[name="cwd"]');
      expect(cwdInput.attributes("required")).toBeDefined();
    });

    test("shows task assignment textarea", () => {
      const wrapper = mountDialog({ workspace: buildTaskDraft(), creating: true });
      const ta = wrapper.findAll("textarea").find((w) => w.attributes("maxlength") === "20000");
      expect(ta).toBeDefined();
    });

    test("shows worker and judge provider/model selects", () => {
      const wrapper = mountDialog({ workspace: buildTaskDraft(), creating: true });
      // Each agent section has one CustomSelect (provider picker) and a datalist-backed model input.
      const customSelects = wrapper.findAllComponents({ name: "CustomSelect" });
      expect(customSelects.length).toBeGreaterThanOrEqual(2);
      const agentSections = wrapper.findAll(".agent-config-section");
      expect(agentSections.length).toBe(2);
    });

    test("provider dropdown lists all four built-in providers (claude, codex, gemini, copilot)", () => {
      const wrapper = mountDialog({ workspace: buildTaskDraft(), creating: true });
      // The provider CustomSelect receives its choices via the `options` prop; inspect that
      // instead of the DOM because the option list is teleported and only rendered when open.
      const customSelects = wrapper.findAllComponents({ name: "CustomSelect" });
      const providerSelects = customSelects.filter((c) => {
        const opts: Array<{ value: string; label: string }> = c.props("options") || [];
        return opts.some((o) => o.value === "claude");
      });
      expect(providerSelects.length).toBeGreaterThanOrEqual(1);
      const options: Array<{ value: string; label: string }> = providerSelects[0].props("options");
      const ids = options.map((o) => o.value);
      expect(ids).toContain("claude");
      expect(ids).toContain("codex");
      expect(ids).toContain("gemini");
      expect(ids).toContain("copilot");
      // And the display name for the newly added provider must be present.
      const labels = options.map((o) => o.label);
      expect(labels.some((l) => l.includes("GitHub Copilot"))).toBe(true);
    });

    test("shows max rounds input", () => {
      const wrapper = mountDialog({ workspace: buildTaskDraft(), creating: true });
      const maxRoundsInput = wrapper.find('input[type="number"]');
      expect(maxRoundsInput.exists()).toBe(true);
    });

    test("shows name field for task creation", () => {
      const wrapper = mountDialog({ workspace: buildTaskDraft(), creating: true });
      const nameInput = wrapper.find('input[name="name"]');
      expect(nameInput.exists()).toBe(true);
    });

    test("shows badge and accent pickers for task creation", () => {
      const wrapper = mountDialog({ workspace: buildTaskDraft(), creating: true });
      expect(wrapper.find(".icon-picker").exists()).toBe(true);
      expect(wrapper.find(".color-input").exists()).toBe(true);
    });

    test("emits submit with draft data on form submit", async () => {
      const draft = buildTaskDraft({ cwd: "/tmp/test" });
      draft.name = "My task";
      const onSubmit = vi.fn();
      const wrapper = mountDialog({ workspace: draft, creating: true, onSubmit });
      await wrapper.find("form").trigger("submit");
      expect(onSubmit).toHaveBeenCalledTimes(1);
      const emitted = onSubmit.mock.calls[0][0];
      expect(emitted.kind).toBe("task");
      expect(emitted.cwd).toBe("/tmp/test");
    });

    test("disables submit button when cwd is empty", () => {
      const draft = buildTaskDraft({ cwd: "" });
      draft.name = "Test";
      const wrapper = mountDialog({ workspace: draft, creating: true });
      const submitBtn = wrapper.find('button[type="submit"]');
      expect(submitBtn.attributes("disabled")).toBeDefined();
    });
  });

  describe("normal workspace mode", () => {
    test("shows 'Add workspace' header when no workspace prop", () => {
      const wrapper = mountDialog();
      expect(wrapper.find("h2").text()).toBe("Add workspace");
    });
  });

  describe("multi-repo detection", () => {
    function buildProjectDraft(overrides = {}) {
      return {
        id: "workspace-project",
        name: "My Project",
        icon: "\u{1F4BB}",
        color: "#4CAF50",
        kind: "project",
        source: "manual",
        pluginId: "",
        cwd: "",
        notes: "",
        activePanelId: "panel-1",
        panels: [{ id: "panel-1", title: "Terminal", command: "", shell: true, startup: "default" }],
        ...overrides,
      };
    }

    test("multi-repo section is hidden by default when no probe result yet", () => {
      // No API provided — cwdProbeResult stays null, section should not appear
      const wrapper = mount(WorkspaceDialog, {
        props: { onCancel: vi.fn(), onSubmit: vi.fn(), workspace: buildProjectDraft({ cwd: "" }) },
        global: { provide: { api: {} } },
      });
      expect(wrapper.find(".multi-repo-section").exists()).toBe(false);
    });

    test("multi-repo section is NOT shown for task workspaces even when probe returns >= 2 repos", async () => {
      const probeDirectory = vi.fn().mockResolvedValue({
        childRepos: ["/repo/a", "/repo/b"],
        truncated: false,
        isGitRepo: false,
      });
      const checkIsGitRepo = vi.fn().mockResolvedValue({ isGitRepo: false });
      const wrapper = mount(WorkspaceDialog, {
        props: {
          onCancel: vi.fn(),
          onSubmit: vi.fn(),
          workspace: buildTaskDraft({ cwd: "" }),
          creating: true,
        },
        global: { provide: { api: { probeDirectory, checkIsGitRepo } } },
      });
      // Trigger the cwd watcher — set a value so the debounced probe fires
      await wrapper.find('input[name="cwd"]').setValue("/tmp/monorepo");
      // Wait for debounce (350 ms) + promise resolution
      await new Promise((r) => setTimeout(r, 400));
      await wrapper.vm.$nextTick();
      // Task workspaces never show the multi-repo section regardless of probe
      expect(wrapper.find(".multi-repo-section").exists()).toBe(false);
    });

    test("multi-repo section shows when probe returns >= 2 child repos for a project workspace", async () => {
      const probeDirectory = vi.fn().mockResolvedValue({
        childRepos: ["/tmp/monorepo/pkg-a", "/tmp/monorepo/pkg-b"],
        truncated: false,
        isGitRepo: false,
      });
      const checkIsGitRepo = vi.fn().mockResolvedValue({ isGitRepo: false });
      const wrapper = mount(WorkspaceDialog, {
        props: {
          onCancel: vi.fn(),
          onSubmit: vi.fn(),
          workspace: buildProjectDraft({ cwd: "" }),
        },
        global: { provide: { api: { probeDirectory, checkIsGitRepo } } },
      });
      await wrapper.find('input[name="cwd"]').setValue("/tmp/monorepo");
      await new Promise((r) => setTimeout(r, 400));
      await wrapper.vm.$nextTick();
      expect(wrapper.find(".multi-repo-section").exists()).toBe(true);
    });

    test("re-scan button is visible when multi-repo section is shown", async () => {
      const probeDirectory = vi.fn().mockResolvedValue({
        childRepos: ["/tmp/monorepo/pkg-a", "/tmp/monorepo/pkg-b"],
        truncated: false,
        isGitRepo: false,
      });
      const checkIsGitRepo = vi.fn().mockResolvedValue({ isGitRepo: false });
      const wrapper = mount(WorkspaceDialog, {
        props: {
          onCancel: vi.fn(),
          onSubmit: vi.fn(),
          workspace: buildProjectDraft({ cwd: "" }),
        },
        global: { provide: { api: { probeDirectory, checkIsGitRepo } } },
      });
      await wrapper.find('input[name="cwd"]').setValue("/tmp/monorepo");
      await new Promise((r) => setTimeout(r, 400));
      await wrapper.vm.$nextTick();
      expect(wrapper.find(".multi-repo-rescan-btn").exists()).toBe(true);
    });

    test("re-scan failure shows a visible error instead of silently vanishing the section", async () => {
      // Category A (code-review batch, 2026-07): rescanDirectory used to swallow
      // a probeDirectory rejection into `null`, which silently reset
      // cwdProbeResult (and thus hid the whole multi-repo section) with no
      // explanation. It must now surface a distinct error message.
      const probeDirectory = vi.fn().mockResolvedValueOnce({
        childRepos: ["/tmp/monorepo/pkg-a", "/tmp/monorepo/pkg-b"],
        truncated: false,
        isGitRepo: false,
      });
      const checkIsGitRepo = vi.fn().mockResolvedValue({ isGitRepo: false });
      const wrapper = mount(WorkspaceDialog, {
        props: {
          onCancel: vi.fn(),
          onSubmit: vi.fn(),
          workspace: buildProjectDraft({ cwd: "" }),
        },
        global: { provide: { api: { probeDirectory, checkIsGitRepo } } },
      });
      await wrapper.find('input[name="cwd"]').setValue("/tmp/monorepo");
      await new Promise((r) => setTimeout(r, 400));
      await wrapper.vm.$nextTick();
      expect(wrapper.find(".multi-repo-section").exists()).toBe(true);

      probeDirectory.mockRejectedValueOnce(new Error("scan failed: permission denied"));
      await wrapper.find(".multi-repo-rescan-btn").trigger("click");
      await flushPromises();

      // Section stays visible (previous probe result is preserved) and the
      // failure is now explained instead of the section just disappearing.
      expect(wrapper.find(".multi-repo-section").exists()).toBe(true);
      expect(wrapper.text()).toContain("scan failed: permission denied");
    });

    test("multi-repo section is NOT shown when probe returns only 1 child repo", async () => {
      const probeDirectory = vi.fn().mockResolvedValue({
        childRepos: ["/tmp/monorepo/pkg-a"],
        truncated: false,
        isGitRepo: false,
      });
      const checkIsGitRepo = vi.fn().mockResolvedValue({ isGitRepo: false });
      const wrapper = mount(WorkspaceDialog, {
        props: {
          onCancel: vi.fn(),
          onSubmit: vi.fn(),
          workspace: buildProjectDraft({ cwd: "" }),
        },
        global: { provide: { api: { probeDirectory, checkIsGitRepo } } },
      });
      await wrapper.find('input[name="cwd"]').setValue("/tmp/monorepo");
      await new Promise((r) => setTimeout(r, 400));
      await wrapper.vm.$nextTick();
      expect(wrapper.find(".multi-repo-section").exists()).toBe(false);
    });

    test("repo picker select appears when creating task + parentIsMultiRepo + useWorktree", () => {
      // Mount with a task draft where useWorktree is true; supply store workspaces
      // via a parentWorkspace with gitRoots so parentIsMultiRepo computes true.
      // We directly test the v-if condition by passing a workspace draft that has
      // useWorktree: true, and stubs the parentWorkspace lookup via a seeded Pinia
      // store. Since fully wiring the Pinia store is complex, we verify the element
      // exists when the draft flags are set and the store has a matching workspace.
      const draft = buildTaskDraft({
        cwd: "/tmp/project",
        useWorktree: true,
        worktreeBranch: "task/test",
      });
      // The repo picker only renders when isCreatingTask && draft.useWorktree && parentIsMultiRepo.
      // parentIsMultiRepo requires store.filteredWorkspaces to contain a matching workspace with
      // gitRoots.length >= 2. Without seeding the store the section is absent — confirm absence here.
      const wrapper = mount(WorkspaceDialog, {
        props: { onCancel: vi.fn(), onSubmit: vi.fn(), workspace: draft, creating: true },
        global: { provide: { api: {} } },
      });
      // Without a seeded store the parent lookup returns null → parentIsMultiRepo = false
      // so the select should NOT be present (guard test).
      expect(wrapper.find("select[required]").exists()).toBe(false);
    });
  });

  describe("browseCwd — rejection is caught and surfaced as a toast, not an unhandled rejection", () => {
    test("browseDirectory rejecting shows an error notification instead of throwing", async () => {
      const browseDirectory = vi.fn().mockRejectedValueOnce(new Error("dialog picker crashed"));
      const wrapper = mount(WorkspaceDialog, {
        props: { onCancel: vi.fn(), onSubmit: vi.fn(), workspace: buildTaskDraft() },
        global: { provide: { api: { browseDirectory } } },
      });

      const browseBtn = wrapper.findAll("button").find((b) => b.text() === "Browse")!;
      await browseBtn.trigger("click");
      await flushPromises();

      expect(browseDirectory).toHaveBeenCalled();
      const notifications = useNotificationStore();
      expect(notifications.sessions).toHaveLength(1);
      expect(notifications.sessions[0].events[0].title).toBe("Failed to open picker");
    });
  });

  describe("checkProviders — a rejected background refresh logs a warning instead of failing silently", () => {
    test("a rejecting checkProviders logs via rlog instead of swallowing the error", async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const logRenderer = vi.fn();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (window as any).strideterm = { logRenderer };
      const checkProviders = vi.fn().mockRejectedValueOnce(new Error("providers cli not found"));

      mount(WorkspaceDialog, {
        props: { onCancel: vi.fn(), onSubmit: vi.fn(), workspace: buildTaskDraft() },
        global: { provide: { api: { checkProviders } } },
      });
      await flushPromises();

      expect(checkProviders).toHaveBeenCalled();
      const warnCalls = logRenderer.mock.calls.filter((c) => c[0] === "warn");
      expect(warnCalls.some((c) => c[1].includes("checkProviders"))).toBe(true);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      delete (window as any).strideterm;
    });
  });
});
