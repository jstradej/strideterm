import { describe, expect, test, beforeEach, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import WorkspaceDialog from "./WorkspaceDialog.vue";

beforeEach(() => {
  setActivePinia(createPinia());
});

function buildTaskDraft(overrides = {}) {
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
      const ta = wrapper.findAll("textarea").find((w) => w.attributes("maxlength") === "5000");
      expect(ta).toBeDefined();
    });

    test("shows worker and judge provider/model selects", () => {
      const wrapper = mountDialog({ workspace: buildTaskDraft(), creating: true });
      const selects = wrapper.findAll("select");
      // Expect at least 2 selects: Worker provider + Worker model (+ Judge provider + Judge model)
      expect(selects.length).toBeGreaterThanOrEqual(2);
      const agentSections = wrapper.findAll(".agent-config-section");
      expect(agentSections.length).toBe(2);
    });

    test("provider dropdown lists all four built-in providers (claude, codex, gemini, copilot)", () => {
      const wrapper = mountDialog({ workspace: buildTaskDraft(), creating: true });
      const html = wrapper.html();
      // Provider <option> values come from PROVIDER_CHOICES. Each provider id
      // should appear as an option value in the rendered DOM.
      expect(html).toContain('value="claude"');
      expect(html).toContain('value="codex"');
      expect(html).toContain('value="gemini"');
      expect(html).toContain('value="copilot"');
      // And the display name for the newly added provider must render too
      expect(html).toContain("GitHub Copilot");
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
});
