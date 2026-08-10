import { describe, expect, test, beforeEach, vi } from "vitest";
import { shallowMount, mount, flushPromises } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import TaskDashboardPane from "./TaskDashboardPane.vue";
import { apiKey } from "../../types/keys.js";
import TaskDashboardStatusTab from "./TaskDashboardStatusTab.vue";
import TaskDashboardCompanionStatusTab from "./TaskDashboardCompanionStatusTab.vue";
import { useAppStore } from "../../stores/app.js";
import { useNotificationStore } from "../../stores/notifications.js";
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

function mountDashboard(
  taskOverrides: TaskOverride = {},
  options: { full?: boolean; apiOverrides?: Record<string, unknown> } = {},
) {
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
    ...options.apiOverrides,
  };

  // `full: true` performs a real `mount` instead of `shallowMount` — needed
  // for tests that exercise the StatusTab's `defineExpose`d template ref
  // (shallowMount stubs the child, so its exposed state never resolves).
  const mountFn = options.full ? mount : shallowMount;
  return mountFn(TaskDashboardPane, {
    props: { workspaceId: ws.id },
    global: {
      provide: { [apiKey]: apiStub },
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

  // Judge round-5 finding (item 70): commit e27b5e2 gave the Reset button
  // attached-mode wording ("re-captures context from the Primary
  // conversation") with no isAttached guard, so a standard task — which has
  // no Primary conversation or capture step — showed a tooltip describing
  // behavior that cannot happen.
  test("Reset button tooltip describes the standard-mode flow, never a Primary re-capture", () => {
    const wrapper = mountDashboard({ state: "completed" });
    const reset = wrapper.findAll("button").find((b) => b.text() === "Reset")!;
    expect(reset.attributes("title")).toBe(
      "Clear all rounds and return to idle — edit the brief in the Task tab, then press Start",
    );
    expect(reset.attributes("title")).not.toContain("Primary");
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

// Regression coverage for code review finding 1.8: the header "Start" button
// read the StatusTab's exposed `briefDraft` as `statusTabRef?.briefDraft?.value`.
// `defineExpose({ briefDraft })` in TaskDashboardStatusTab.vue already crosses
// the expose boundary unwrapped (Vue's `proxyRefs` unwraps refs on the exposed
// proxy, same as it does for template refs), so the extra `.value` always
// resolved to `undefined` — silently discarding whatever the user typed into
// the hero textarea. shallowMount stubs the child and never exercises the real
// defineExpose boundary, so these use a full `mount`.
describe("TaskDashboardPane — header Start reads the hero brief draft (review 1.8)", () => {
  test("typing a brief into the hero textarea and clicking the header Start button passes the typed text through, not undefined", async () => {
    const updateTaskDescription = vi.fn().mockResolvedValue({ payload: null });
    const wrapper = mountDashboard(
      { state: "idle", description: "" },
      { full: true, apiOverrides: { updateTaskDescription } },
    );

    const textarea = wrapper.find("#td-hero-brief");
    expect(textarea.exists()).toBe(true);
    await textarea.setValue("Implement the new caching layer.");

    const start = wrapper.findAll("button").find((b) => b.text() === "Start")!;
    await start.trigger("click");
    await flushPromises();

    expect(updateTaskDescription).toHaveBeenCalledTimes(1);
    expect(updateTaskDescription).toHaveBeenCalledWith(
      expect.objectContaining({ description: "Implement the new caching layer." }),
    );
  });
});

// Regression coverage for code review finding 1.8, bug #2: onStartWithBrief's
// catch block used to `console.error` and `return` with no user-visible
// feedback. It now routes through the same `taskToast` -> pushEphemeralToast
// pattern the other error paths in this file already use (see onStart,
// onResend).
describe("TaskDashboardPane — onStartWithBrief surfaces failures as a toast (review 1.8)", () => {
  test("a rejected save-brief call surfaces an error toast instead of failing silently", async () => {
    const updateTaskDescription = vi.fn().mockRejectedValue(new Error("network unreachable"));
    const wrapper = mountDashboard(
      { state: "idle", description: "Old brief." },
      { full: true, apiOverrides: { updateTaskDescription } },
    );
    const notificationStore = useNotificationStore();
    const toastSpy = vi.spyOn(notificationStore, "pushEphemeralToast");

    const statusTab = wrapper.findComponent(TaskDashboardStatusTab);
    await statusTab.vm.$emit("start", "A brand new brief that differs from the persisted one.");
    await flushPromises();

    expect(updateTaskDescription).toHaveBeenCalledTimes(1);
    expect(toastSpy).toHaveBeenCalledTimes(1);
    const call = toastSpy.mock.calls[0][0];
    expect(call.kind).toBe("error");
    expect(call.body).toContain("network unreachable");
  });
});

// Category C (code-review batch, 2026-07): onStartNewRun, onStop, onReset and
// onRejectVerdict only did `console.error` on failure, with zero user-visible
// feedback — unlike their already-fixed siblings (onStart, onResend,
// onStartWithBrief) which route through `taskToast`. These four now do too.
describe("TaskDashboardPane — remaining handlers surface failures as a toast", () => {
  test("onStartNewRun: a rejected resetTask surfaces an error toast", async () => {
    const resetTask = vi.fn().mockRejectedValue(new Error("disk full"));
    const wrapper = mountDashboard({ state: "completed" }, { full: true, apiOverrides: { resetTask } });
    const notificationStore = useNotificationStore();
    const toastSpy = vi.spyOn(notificationStore, "pushEphemeralToast");

    const statusTab = wrapper.findComponent(TaskDashboardStatusTab);
    await statusTab.vm.$emit("start-new", "A brand new brief for the next run.");
    await flushPromises();

    expect(resetTask).toHaveBeenCalledTimes(1);
    expect(toastSpy).toHaveBeenCalledTimes(1);
    const call = toastSpy.mock.calls[0][0];
    expect(call.kind).toBe("error");
    expect(call.body).toContain("disk full");
  });

  test("onStop: a rejected stopTask surfaces an error toast", async () => {
    const stopTask = vi.fn().mockRejectedValue(new Error("runtime not responding"));
    const wrapper = mountDashboard({ state: "running" }, { apiOverrides: { stopTask } });
    const notificationStore = useNotificationStore();
    const toastSpy = vi.spyOn(notificationStore, "pushEphemeralToast");

    const pause = wrapper.findAll("button").find((b) => b.text() === "Pause")!;
    await pause.trigger("click");
    await flushPromises();

    expect(stopTask).toHaveBeenCalledTimes(1);
    expect(toastSpy).toHaveBeenCalledTimes(1);
    const call = toastSpy.mock.calls[0][0];
    expect(call.kind).toBe("error");
    expect(call.body).toContain("runtime not responding");
  });

  test("onReset: a rejected resetTask surfaces an error toast", async () => {
    const resetTask = vi.fn().mockRejectedValue(new Error("control file locked"));
    const wrapper = mountDashboard({ state: "paused" }, { apiOverrides: { resetTask } });
    const notificationStore = useNotificationStore();
    const toastSpy = vi.spyOn(notificationStore, "pushEphemeralToast");

    const reset = wrapper.findAll("button").find((b) => b.text() === "Reset")!;
    await reset.trigger("click");
    await flushPromises();

    expect(resetTask).toHaveBeenCalledTimes(1);
    expect(toastSpy).toHaveBeenCalledTimes(1);
    const call = toastSpy.mock.calls[0][0];
    expect(call.kind).toBe("error");
    expect(call.body).toContain("control file locked");
  });

  test("onRejectVerdict: a rejected rejectTaskVerdict surfaces an error toast", async () => {
    const rejectTaskVerdict = vi.fn().mockRejectedValue(new Error("verdict already finalized"));
    const wrapper = mountDashboard({ state: "completed" }, { apiOverrides: { rejectTaskVerdict } });
    const appStore = useAppStore();
    const notificationStore = useNotificationStore();
    const toastSpy = vi.spyOn(notificationStore, "pushEphemeralToast");

    const sendBack = wrapper.findAll("button").find((b) => b.text() === "Send back")!;
    await sendBack.trigger("click");

    // onRejectVerdict opens a TextAreaDialog and does the actual API call from
    // its onSubmit callback — invoke that callback directly, the same way the
    // dialog would after the user types feedback and submits.
    const onSubmit = appStore.overlayProps.onSubmit as (feedback: string) => Promise<void>;
    expect(typeof onSubmit).toBe("function");
    await onSubmit("Please redo the git polling section.");
    await flushPromises();

    expect(rejectTaskVerdict).toHaveBeenCalledTimes(1);
    expect(toastSpy).toHaveBeenCalledTimes(1);
    const call = toastSpy.mock.calls[0][0];
    expect(call.kind).toBe("error");
    expect(call.body).toContain("verdict already finalized");
  });
});

// Plan §14 acceptance criteria: "Dialog i Config explicitně říkají... Dashboard
// používá labely Primary a Reviewer/Planner/Consultant/Critic, nikoli
// Worker/Judge." A standard task must render identically to before — proven
// by every test above still passing unmodified; these prove the attached
// branch is genuinely different and never leaks into the standard one.
describe("TaskDashboardPane — attached mode (Companion loop) labels", () => {
  function mountAttached(
    taskOverrides: Record<string, unknown> = {},
    apiOverrides: Record<string, unknown> = {},
    sourceOverrides: Record<string, unknown> = {},
  ) {
    const ws = {
      id: "ws-companion",
      name: "Reviewer: My Project",
      icon: "🤖",
      color: "#7C4DFF",
      kind: "task",
      profileId: "default",
      cwd: "/home/user/projects/myapp",
      activePanelId: "panel-dashboard",
      panels: [
        { id: "panel-dashboard", title: "Dashboard", command: "__task-dashboard__", shell: false, startup: "none" },
        { id: "panel-judge", title: "Reviewer (Codex)", command: "codex", shell: true, startup: "default" },
      ],
      task: {
        taskId: "task-companion-1",
        mode: "attached",
        workerWorkspaceId: "ws-source",
        workerPanelId: "panel-source",
        companionRole: "reviewer",
        description: "",
        state: "capturing-context",
        currentRound: 0,
        maxRounds: 5,
        startedAt: null,
        finishedAt: null,
        pausedAt: null,
        totalPausedMs: 0,
        judgeProviderConfig: { providerId: "codex", model: "gpt-5.6-sol" },
        ...taskOverrides,
      },
    };
    const appStore = useAppStore();
    appStore.payload = {
      appState: {
        workspaces: [
          ws,
          { id: "ws-source", name: "My Project", kind: "manual", profileId: "default", ...sourceOverrides },
        ],
        activeWorkspaceId: ws.id,
        activeProfileId: "default",
        profiles: [{ id: "default", name: "Default", color: "#ffa424", workspaceIds: [ws.id] }],
      },
      workspace: { workspace: ws, project: ws, sessions: [] },
    } as unknown as StatePayload;
    const apiStub = {
      fileRead: () => Promise.resolve({ content: "" }),
      fileWrite: () => Promise.resolve({ ok: true }),
      ...apiOverrides,
    };
    return mount(TaskDashboardPane, {
      props: { workspaceId: ws.id },
      global: { provide: { [apiKey]: apiStub } },
    });
  }

  test("renders the Companion status tab, never the standard Worker/Judge one", () => {
    const wrapper = mountAttached();
    expect(wrapper.findComponent(TaskDashboardCompanionStatusTab).exists()).toBe(true);
    expect(wrapper.findComponent(TaskDashboardStatusTab).exists()).toBe(false);
  });

  test("state badge shows 'Capturing context…' instead of a generic label", () => {
    const wrapper = mountAttached();
    expect(wrapper.find(".td__badge").text()).toBe("Capturing context…");
  });

  test("header shows an Open Primary control, and resend buttons say Primary/Reviewer, never Worker/Judge", () => {
    const wrapper = mountAttached({ state: "running" });
    const labels = wrapper.findAll("button").map((b) => b.text());
    expect(labels).toContain("Open Primary");
    expect(labels.some((l) => l.includes("↻ Primary"))).toBe(true);
    expect(labels.some((l) => l.includes("↻ Reviewer"))).toBe(true);
    expect(labels.some((l) => l.includes("Worker"))).toBe(false);
    expect(labels.some((l) => l === "↻ Judge")).toBe(false);
  });

  test("brief-ready shows a role-specific 'Start Reviewer loop' button instead of the generic Start", () => {
    const wrapper = mountAttached({ state: "brief-ready" });
    const labels = wrapper.findAll("button").map((b) => b.text());
    expect(labels).toContain("Start Reviewer loop");
    expect(labels).not.toContain("Start");
  });

  test("Config tab shows Primary/Judge role/Evaluator instead of Worker/Judge agent fields", async () => {
    const wrapper = mountAttached({ state: "running" });
    const config = wrapper.findAll(".td__tab").find((t) => t.text() === "Config")!;
    await config.trigger("click");
    const text = wrapper.find(".td__section").text();
    expect(text).toContain("Primary");
    expect(text).toContain("Judge role");
    expect(text).toContain("Evaluator");
    expect(text).toContain("Inspect only");
    expect(text).toContain("Primary permissions");
    expect(text).not.toContain("Worker agent");
    // Truthful ongoing isolation label (plan §10) — not just shown once in
    // the creation dialog. Codex's inspectionIsolation is "permission-gated".
    expect(text).toContain("Isolation:");
    expect(text).toContain("Permission-gated");
  });

  // Judge round-4 finding (item 68): the attached Assignment tab never showed
  // the WORKER.md "Worker rules" artifact (plan §13 Frontend test 6: "Your
  // focus / Context / Worker rules / role customization").
  test("Assignment tab lists Your focus / Context / Worker rules / Handoff / Verification / role customization", async () => {
    const wrapper = mountAttached({ state: "running" });
    await flushPromises();
    const assignment = wrapper.findAll(".td__tab").find((t) => t.text() === "Assignment")!;
    await assignment.trigger("click");
    await flushPromises();
    const labels = wrapper.findAll(".td__file-tab").map((t) => t.text());
    expect(labels).toEqual([
      "Your focus",
      "Context",
      "Worker rules",
      "Handoff",
      "Verification",
      "Reviewer customization",
    ]);
  });

  test("Worker rules tab is hidden until WORKER.md exists on disk", async () => {
    const wrapper = mountAttached(
      { state: "running" },
      {
        fileRead: ({ relativePath }: { relativePath: string }) =>
          relativePath.endsWith("WORKER.md")
            ? Promise.reject(new Error("not found"))
            : Promise.resolve({ content: "" }),
      },
    );
    await flushPromises();
    const assignment = wrapper.findAll(".td__tab").find((t) => t.text() === "Assignment")!;
    await assignment.trigger("click");
    await flushPromises();
    const labels = wrapper.findAll(".td__file-tab").map((t) => t.text());
    expect(labels).not.toContain("Worker rules");
    expect(labels).toEqual(["Your focus", "Context", "Handoff", "Verification", "Reviewer customization"]);
  });

  // Judge round-4 finding (item 69, frontend half): the "Send back" control
  // on a completed/failed attached Dashboard still said "Worker"/"Judge said
  // complete" even though every neighbouring control is already role-aware.
  test.each(["completed", "failed"])(
    "Send back button and dialog use Primary/role labels for an attached %s task",
    async (state) => {
      const wrapper = mountAttached({ state });
      const sendBack = wrapper.findAll("button").find((b) => b.text() === "Send back")!;
      expect(sendBack.attributes("title")).toContain("Primary");
      expect(sendBack.attributes("title")).not.toContain("Worker");

      const appStore = useAppStore();
      await sendBack.trigger("click");

      expect(appStore.overlayProps.title).toBe("Send Primary back with feedback");
      expect(appStore.overlayProps.label as string).toContain("runs one more round");
      expect(appStore.overlayProps.label as string).not.toContain("Worker");
      if (state === "completed") {
        expect(appStore.overlayProps.label as string).toContain("Reviewer said complete");
      }
    },
  );

  // Judge round-5 finding (item 70): the Reset button tooltip must branch on
  // isAttached like every sibling control — this is the attached-mode half of
  // that guard (the standard-mode half is covered in the sibling describe
  // block above).
  test("Reset button tooltip describes the Primary re-capture, never the standard-mode Task-tab flow", () => {
    const wrapper = mountAttached({ state: "completed" });
    const reset = wrapper.findAll("button").find((b) => b.text() === "Reset")!;
    expect(reset.attributes("title")).toContain("Primary conversation");
    expect(reset.attributes("title")).not.toContain("Task tab");
  });

  // Once the Primary is gone the runner refuses Start/Continue/Send back/Send
  // decision outright and Reset doesn't lift the flag — so the header must stop
  // offering controls whose only possible outcome is a silent no-op.
  describe("primaryMissing", () => {
    test.each(["idle", "brief-ready", "paused", "completed", "failed"])("hides every dead control in %s", (state) => {
      const wrapper = mountAttached({ state, primaryMissing: true });
      const labels = wrapper.findAll("button").map((b) => b.text());
      expect(labels).not.toContain("Start capture");
      expect(labels).not.toContain("Start Reviewer loop");
      expect(labels).not.toContain("Continue");
      expect(labels).not.toContain("Send back");
      expect(labels).not.toContain("Reset");
      expect(labels).not.toContain("Open Primary");
      expect(labels.some((l) => l.includes("↻ Primary"))).toBe(false);
      // The Reviewer resend is just as dead: re-running the evaluation only
      // produces a verdict whose every outcome has to reach the Primary.
      expect(labels.some((l) => l.includes("↻ Reviewer"))).toBe(false);
    });

    test("keeps offering them while the Primary is alive", () => {
      const wrapper = mountAttached({ state: "completed" });
      const labels = wrapper.findAll("button").map((b) => b.text());
      expect(labels).toContain("Continue");
      expect(labels).toContain("Send back");
      expect(labels).toContain("Reset");
    });

    test("the hero's Delete task deletes this task workspace, never the Primary's", async () => {
      const wrapper = mountAttached({ state: "paused", primaryMissing: true });
      const appStore = useAppStore();
      const deleteWorkspace = vi.spyOn(appStore, "deleteWorkspace").mockResolvedValue(undefined);
      const deleteBtn = wrapper.findAll("button").find((b) => b.text() === "Delete task")!;
      await deleteBtn.trigger("click");
      await flushPromises();
      expect(deleteWorkspace).toHaveBeenCalledWith("ws-companion");
    });
  });

  // Deleting only the tab that hosts the conversation leaves the source
  // workspace in place, so a workspace-level check alone kept offering a jump
  // to a Primary that no longer exists.
  test("Open Primary is hidden when the source workspace still exists but its Primary panel is gone", () => {
    const wrapper = mountAttached({ state: "running" }, {}, { panels: [{ id: "panel-other" }] });
    expect(wrapper.findAll("button").map((b) => b.text())).not.toContain("Open Primary");
  });

  test("Open Primary is offered when the source panel is still listed", () => {
    const wrapper = mountAttached({ state: "running" }, {}, { panels: [{ id: "panel-source" }] });
    expect(wrapper.findAll("button").map((b) => b.text())).toContain("Open Primary");
  });

  // `panels` is a required field on a workspace, so an empty list is a real
  // answer ("every panel is gone"), not the missing-field case the fallback
  // exists for.
  test("Open Primary is hidden when the source workspace lists no panels at all", () => {
    const wrapper = mountAttached({ state: "running" }, {}, { panels: [] });
    expect(wrapper.findAll("button").map((b) => b.text())).not.toContain("Open Primary");
  });
});
