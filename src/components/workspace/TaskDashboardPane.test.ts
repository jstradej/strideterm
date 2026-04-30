import { describe, expect, test, beforeEach } from "vitest";
import { shallowMount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import TaskDashboardPane from "./TaskDashboardPane.vue";
import { useAppStore } from "../../stores/app.js";
import type { StatePayload } from "../../../electron/shared/types/state.js";

/**
 * Component-level coverage for TaskDashboardPane.
 *
 * These replace the e2e checks in test/e2e/advanced.spec.ts that were
 * skipped (TODO(task-dashboard-e2e)) because the chromium runner couldn't
 * reliably bring up the full split layout — Worker/Judge xterms are empty
 * by definition (no agent runs in tests) and that interacted badly with
 * Vite's lazy-chunk loading. At component level the dashboard is just Vue
 * over Pinia state, so we can drive it deterministically with a stub task
 * workspace and assert the same things in milliseconds without touching a
 * browser.
 */

interface TaskOverride {
  state?: string;
  description?: string;
  startedAt?: number | null;
  finishedAt?: number | null;
  pausedAt?: number | null;
  totalPausedMs?: number;
  currentRound?: number;
  maxRounds?: number;
}

function buildTaskWorkspace(taskOverrides: TaskOverride = {}) {
  return {
    id: "ws-task",
    name: "Auth Refactor Task",
    icon: "🤖",
    color: "#7C4DFF",
    kind: "task",
    profileId: "default",
    cwd: "/home/user/projects/myapp",
    activePanelId: "panel-dashboard",
    activeViewId: "task-dashboard:panel-dashboard",
    panels: [
      { id: "panel-dashboard", title: "Dashboard", command: "__task-dashboard__", shell: false, startup: "none" },
      { id: "panel-worker", title: "Worker", command: "claude", shell: true, startup: "default" },
      { id: "panel-judge", title: "Judge", command: "claude", shell: true, startup: "default" },
    ],
    task: {
      taskId: "task-001",
      description: "Refactor the authentication module to use JWT tokens.",
      state: "idle",
      currentRound: 0,
      maxRounds: 8,
      startedAt: null,
      finishedAt: null,
      pausedAt: null,
      totalPausedMs: 0,
      workerProviderConfig: { providerId: "claude", model: "sonnet" },
      judgeProviderConfig: { providerId: "claude", model: "opus" },
      ...taskOverrides,
    },
  };
}

function mountDashboard(taskOverrides: TaskOverride = {}) {
  const ws = buildTaskWorkspace(taskOverrides);
  const appStore = useAppStore();
  appStore.payload = {
    appState: {
      workspaces: [ws],
      activeWorkspaceId: ws.id,
      activeProjectId: ws.id,
      activeProfileId: "default",
      profiles: [{ id: "default", name: "Default", color: "#ffa424", workspaceIds: [ws.id] }],
    },
    workspace: { workspace: ws, project: ws, sessions: [] },
  } as unknown as StatePayload;

  // useTaskFiles reads the injected `api` to load/save TASK.md / JUDGE_PROMPT.md.
  // The composable creates refs eagerly but only touches `api` when the user
  // actually triggers a file action — so a noop stub keeps the component mount
  // hermetic without having to mock every transport method.
  const apiStub = {
    fileRead: () => Promise.resolve({ content: "" }),
    fileWrite: () => Promise.resolve({ ok: true }),
  };

  return shallowMount(TaskDashboardPane, {
    props: { workspaceId: ws.id },
    global: {
      provide: { api: apiStub },
    },
  });
}

beforeEach(() => {
  setActivePinia(createPinia());
});

describe("TaskDashboardPane — header", () => {
  test("renders the task description as the heading", () => {
    const wrapper = mountDashboard({ description: "Refactor the authentication module to use JWT tokens." });
    const heading = wrapper.find(".td__title h2");
    expect(heading.exists()).toBe(true);
    expect(heading.text()).toContain("Refactor the authentication module");
  });

  test("falls back to a generic heading when description is empty", () => {
    const wrapper = mountDashboard({ description: "" });
    const heading = wrapper.find(".td__title h2");
    expect(heading.text()).toBe("Task workspace");
  });

  test("shows the state badge with the right modifier class for idle state", () => {
    const wrapper = mountDashboard({ state: "idle" });
    const badge = wrapper.find(".td__badge");
    expect(badge.exists()).toBe(true);
    expect(badge.classes()).toContain("td__badge--idle");
    expect(badge.text()).toBe("Idle");
  });
});

describe("TaskDashboardPane — control buttons by state", () => {
  test("Start button is visible when the task is idle", () => {
    const wrapper = mountDashboard({ state: "idle" });
    const start = wrapper.findAll("button").find((b) => b.text() === "Start");
    expect(start, "expected a Start button while task is idle").toBeTruthy();
  });

  test("Continue and Reset show when the task is paused (and Start does not)", () => {
    const wrapper = mountDashboard({ state: "paused" });
    const labels = wrapper.findAll("button").map((b) => b.text());
    expect(labels).toContain("Continue");
    expect(labels).toContain("Reset");
    expect(labels).not.toContain("Start");
  });

  test("Pause shows while the task is running", () => {
    const wrapper = mountDashboard({ state: "running" });
    const labels = wrapper.findAll("button").map((b) => b.text());
    expect(labels).toContain("Pause");
    expect(labels).not.toContain("Start");
  });

  test("Send back, Continue and Reset all appear after completion (verdict override flow)", () => {
    const wrapper = mountDashboard({ state: "completed" });
    const labels = wrapper.findAll("button").map((b) => b.text());
    expect(labels).toContain("Send back");
    expect(labels).toContain("Continue");
    expect(labels).toContain("Reset");
  });
});

describe("TaskDashboardPane — tab bar", () => {
  test("Status tab is active by default", () => {
    const wrapper = mountDashboard();
    const activeTab = wrapper.find(".td__tab--active");
    expect(activeTab.exists()).toBe(true);
    expect(activeTab.text()).toBe("Status");
  });

  test("renders all five top-level tabs in the documented order", () => {
    const wrapper = mountDashboard();
    const labels = wrapper.findAll(".td__tab").map((t) => t.text());
    expect(labels).toEqual(["Status", "Assignment", "Config", "Log", "Help"]);
  });

  test("clicking the Assignment tab makes it the active one", async () => {
    const wrapper = mountDashboard();
    const tabs = wrapper.findAll(".td__tab");
    const assignment = tabs.find((t) => t.text() === "Assignment")!;
    await assignment.trigger("click");
    expect(wrapper.find(".td__tab--active").text()).toBe("Assignment");
  });

  test("clicking the Config tab reveals the inline config section", async () => {
    const wrapper = mountDashboard();
    expect(wrapper.find(".td__section").exists()).toBe(false);
    const config = wrapper.findAll(".td__tab").find((t) => t.text() === "Config")!;
    await config.trigger("click");
    expect(wrapper.find(".td__section").exists()).toBe(true);
    // Description and rounds copy through into the config view from task state.
    const sectionText = wrapper.find(".td__section").text();
    expect(sectionText).toContain("Refactor the authentication module");
    expect(sectionText).toContain("8"); // maxRounds default we passed in
  });
});
