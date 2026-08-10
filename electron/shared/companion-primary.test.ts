import { describe, test, expect } from "vitest";
import {
  COMPANION_PRIMARY_HOSTED_STATES,
  companionPrimaryHostedPanelIds,
  companionPrimaryViewId,
  effectiveCompanionTask,
  findCompanionPrimaryHost,
  isCompanionPrimaryHosted,
  isCompanionPrimaryViewId,
  parseCompanionPrimaryViewId,
  resolveCompanionPrimaryBinding,
  type CompanionPrimaryWorkspaceLike,
} from "./companion-primary.js";

function sourceWorkspace(overrides: Partial<CompanionPrimaryWorkspaceLike> = {}): CompanionPrimaryWorkspaceLike {
  return {
    id: "ws-source",
    name: "Live conversation",
    kind: "terminal",
    profileId: "default",
    panels: [
      { id: "panel-primary", title: "Claude", command: "claude" },
      { id: "panel-other", title: "Shell", command: "bash" },
    ],
    ...overrides,
  };
}

function taskWorkspace(state: string, overrides: Partial<CompanionPrimaryWorkspaceLike> = {}) {
  return {
    id: "ws-task",
    name: "Reviewer: Live conversation",
    kind: "task",
    profileId: "default",
    panels: [
      { id: "panel-dashboard", title: "Dashboard", command: "__task-dashboard__" },
      { id: "panel-judge", title: "Reviewer", command: "codex" },
    ],
    task: {
      mode: "attached",
      state,
      workerWorkspaceId: "ws-source",
      workerPanelId: "panel-primary",
      companionRole: "reviewer",
    },
    ...overrides,
  } satisfies CompanionPrimaryWorkspaceLike;
}

describe("view id helpers", () => {
  test("round-trips a task workspace id", () => {
    const viewId = companionPrimaryViewId("ws-task");
    expect(viewId).toBe("attached-primary:ws-task");
    expect(isCompanionPrimaryViewId(viewId)).toBe(true);
    expect(parseCompanionPrimaryViewId(viewId)).toBe("ws-task");
  });

  test("does not claim ordinary session or virtual view ids", () => {
    for (const id of ["ws:panel", "task-dashboard:panel", "git:ws", "", null, undefined]) {
      expect(isCompanionPrimaryViewId(id)).toBe(false);
      expect(parseCompanionPrimaryViewId(id)).toBe("");
    }
  });
});

describe("isCompanionPrimaryHosted", () => {
  // Table over every state the runner can produce. Anything not listed as
  // hosted must fail closed — the tab simply stays in its own workspace.
  const HOSTED = [
    "idle",
    "capturing-context",
    "brief-ready",
    "running",
    "evaluating",
    "judge-evaluating",
    "refreshing",
    "awaiting-user",
    "paused",
  ];
  const NOT_HOSTED = ["completed", "failed", "done", "stopped", "showering", "some-future-state", ""];

  for (const state of HOSTED) {
    test(`hosts the Primary in "${state}"`, () => {
      expect(isCompanionPrimaryHosted(taskWorkspace(state).task)).toBe(true);
      expect(COMPANION_PRIMARY_HOSTED_STATES.has(state)).toBe(true);
    });
  }

  for (const state of NOT_HOSTED) {
    test(`returns the Primary in "${state}"`, () => {
      expect(isCompanionPrimaryHosted(taskWorkspace(state).task)).toBe(false);
    });
  }

  test("a standard (non-attached) task never hosts anything", () => {
    expect(
      isCompanionPrimaryHosted({ mode: "standard", state: "running", workerWorkspaceId: "a", workerPanelId: "b" }),
    ).toBe(false);
    expect(isCompanionPrimaryHosted({ state: "running", workerWorkspaceId: "a", workerPanelId: "b" })).toBe(false);
  });

  test("primaryMissing wins over any hosted state", () => {
    const task = { ...taskWorkspace("running").task, primaryMissing: true };
    expect(isCompanionPrimaryHosted(task)).toBe(false);
  });

  test("an incomplete binding never hosts", () => {
    expect(isCompanionPrimaryHosted({ mode: "attached", state: "running", workerPanelId: "p" })).toBe(false);
    expect(isCompanionPrimaryHosted({ mode: "attached", state: "running", workerWorkspaceId: "w" })).toBe(false);
    expect(isCompanionPrimaryHosted(null)).toBe(false);
  });
});

describe("effectiveCompanionTask", () => {
  test("the live runner state overrides the persisted one", () => {
    const ws = taskWorkspace("idle");
    const merged = effectiveCompanionTask(ws, { "ws-task": { state: "running" } });
    expect(merged?.state).toBe("running");
    expect(merged?.workerPanelId).toBe("panel-primary");
  });

  test("falls back to the persisted task when there is no runner entry", () => {
    expect(effectiveCompanionTask(taskWorkspace("paused"), {})?.state).toBe("paused");
    expect(effectiveCompanionTask(taskWorkspace("paused"))?.state).toBe("paused");
    expect(effectiveCompanionTask(sourceWorkspace())).toBeNull();
  });
});

describe("resolveCompanionPrimaryBinding", () => {
  test("resolves the source session without re-keying anything", () => {
    const workspaces = [sourceWorkspace(), taskWorkspace("running")];
    const binding = resolveCompanionPrimaryBinding(workspaces, null, "ws-task");
    expect(binding).toEqual({
      taskWorkspaceId: "ws-task",
      viewId: "attached-primary:ws-task",
      sourceWorkspaceId: "ws-source",
      sourcePanelId: "panel-primary",
      sourceSessionId: "ws-source:panel-primary",
      companionRole: "reviewer",
      sourceWorkspaceName: "Live conversation",
      sourcePanelTitle: "Claude",
      taskWorkspaceName: "Reviewer: Live conversation",
    });
  });

  test("uses the live task state, not the persisted one", () => {
    const workspaces = [sourceWorkspace(), taskWorkspace("running")];
    expect(resolveCompanionPrimaryBinding(workspaces, { "ws-task": { state: "completed" } }, "ws-task")).toBeNull();
    expect(
      resolveCompanionPrimaryBinding(
        [sourceWorkspace(), taskWorkspace("completed")],
        { "ws-task": { state: "running" } },
        "ws-task",
      ),
    ).not.toBeNull();
  });

  test("returns null when the source workspace is not visible to the caller", () => {
    // Remote clients are handed a profile-scoped workspace list — a task whose
    // source is out of profile must resolve nothing at all.
    expect(resolveCompanionPrimaryBinding([taskWorkspace("running")], null, "ws-task")).toBeNull();
  });

  test("returns null when source and task are in different profiles", () => {
    const workspaces = [sourceWorkspace({ profileId: "other" }), taskWorkspace("running")];
    expect(resolveCompanionPrimaryBinding(workspaces, null, "ws-task")).toBeNull();
  });

  test("returns null when the source panel is gone", () => {
    const workspaces = [sourceWorkspace({ panels: [{ id: "panel-other", title: "Shell" }] }), taskWorkspace("running")];
    expect(resolveCompanionPrimaryBinding(workspaces, null, "ws-task")).toBeNull();
  });

  test("ignores a non-task workspace and unknown ids", () => {
    const workspaces = [sourceWorkspace(), taskWorkspace("running")];
    expect(resolveCompanionPrimaryBinding(workspaces, null, "ws-source")).toBeNull();
    expect(resolveCompanionPrimaryBinding(workspaces, null, "nope")).toBeNull();
    expect(resolveCompanionPrimaryBinding(workspaces, null, "")).toBeNull();
  });
});

describe("reverse lookup from the source workspace", () => {
  test("finds the hosting task for the bound panel only", () => {
    const workspaces = [sourceWorkspace(), taskWorkspace("running")];
    expect(findCompanionPrimaryHost(workspaces, null, "ws-source", "panel-primary")?.taskWorkspaceId).toBe("ws-task");
    expect(findCompanionPrimaryHost(workspaces, null, "ws-source", "panel-other")).toBeNull();
    expect(findCompanionPrimaryHost(workspaces, null, "ws-source")?.taskWorkspaceId).toBe("ws-task");
  });

  test("finds nothing once the loop reaches a terminal state", () => {
    const workspaces = [sourceWorkspace(), taskWorkspace("completed")];
    expect(findCompanionPrimaryHost(workspaces, null, "ws-source", "panel-primary")).toBeNull();
    expect(companionPrimaryHostedPanelIds(workspaces, null, "ws-source").size).toBe(0);
  });

  test("lists exactly the presentation-hidden panels of a source workspace", () => {
    const workspaces = [sourceWorkspace(), taskWorkspace("awaiting-user")];
    expect([...companionPrimaryHostedPanelIds(workspaces, null, "ws-source")]).toEqual(["panel-primary"]);
    expect(companionPrimaryHostedPanelIds(workspaces, null, "ws-task").size).toBe(0);
    expect(companionPrimaryHostedPanelIds(workspaces, null, "").size).toBe(0);
  });
});
