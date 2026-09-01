import { describe, it, expect } from "vitest";
import { isTaskRunningState, resolveWorkspaceStatusCue } from "./workspace-status.js";

/**
 * V6 review, §"P2 UX — Recent zahazuje kanonický status dot na icon badge".
 *
 * One semantic model for the badge status dot, shared by the canonical
 * workspace card and both activity surfaces. The point of the extraction is
 * that there is exactly ONE table of conditions — these tests pin the meaning
 * so a second copy cannot quietly reappear somewhere with a different answer.
 */
describe("resolveWorkspaceStatusCue", () => {
  it("has no cue for a workspace with no state at all", () => {
    expect(resolveWorkspaceStatusCue({ kind: "terminal" })).toBeNull();
    expect(resolveWorkspaceStatusCue(null)).toBeNull();
    expect(resolveWorkspaceStatusCue(undefined)).toBeNull();
  });

  it("maps every running task state to one pulsing running cue", () => {
    for (const taskState of ["running", "evaluating", "judge-evaluating", "refreshing", "showering"]) {
      expect(resolveWorkspaceStatusCue({ kind: "task", taskState })).toEqual({
        state: "running",
        label: "Running…",
        heartbeat: true,
      });
      expect(isTaskRunningState(taskState)).toBe(true);
    }
  });

  it("maps the settled task states, and merges completed + merged PR into one cue", () => {
    expect(resolveWorkspaceStatusCue({ kind: "task", taskState: "failed" })).toEqual({
      state: "failed",
      label: "Failed",
      heartbeat: false,
    });
    expect(resolveWorkspaceStatusCue({ kind: "task", taskState: "stopped" })).toEqual({
      state: "stopped",
      label: "Stopped",
      heartbeat: false,
    });
    expect(resolveWorkspaceStatusCue({ kind: "task", taskState: "paused" })).toEqual({
      state: "paused",
      label: "Paused",
      heartbeat: false,
    });
    expect(resolveWorkspaceStatusCue({ kind: "task", taskState: "completed" })).toEqual({
      state: "completed",
      label: "Completed",
      heartbeat: false,
    });
    expect(resolveWorkspaceStatusCue({ kind: "task", taskState: "completed", prStatus: "completed" })).toEqual({
      state: "merged",
      label: "Done · PR merged",
      heartbeat: false,
    });
  });

  it("maps the three PR lifecycles", () => {
    expect(resolveWorkspaceStatusCue({ kind: "azure-review", prStatus: "active" })).toEqual({
      state: "pr-active",
      label: "PR open",
      heartbeat: true,
    });
    expect(resolveWorkspaceStatusCue({ kind: "azure-review", prStatus: "completed" })).toEqual({
      state: "merged",
      label: "PR merged",
      heartbeat: false,
    });
    expect(resolveWorkspaceStatusCue({ kind: "azure-review", prStatus: "abandoned" })).toEqual({
      state: "abandoned",
      label: "PR abandoned",
      heartbeat: false,
    });
  });

  /**
   * The case the whole extraction exists for: a hand-opened Claude Code panel
   * must NOT enter the task-only RUNNING section, but its dot on the recent
   * workspace row is stable and stays.
   */
  it("gives a plain agent-like session its own running / done cue", () => {
    expect(
      resolveWorkspaceStatusCue({
        kind: "terminal",
        agentActivityState: "running",
        agentActivityLabel: "Claude Code is working",
      }),
    ).toEqual({ state: "running", label: "Claude Code is working", heartbeat: true });

    expect(resolveWorkspaceStatusCue({ kind: "terminal", agentActivityState: "done" })).toEqual({
      state: "completed",
      label: "Agent finished",
      heartbeat: false,
    });
  });

  it("prefers the task lifecycle over a session and a PR, and a session over a PR", () => {
    expect(
      resolveWorkspaceStatusCue({
        kind: "task",
        taskState: "failed",
        agentActivityState: "done",
        prStatus: "active",
      })?.state,
    ).toBe("failed");

    expect(
      resolveWorkspaceStatusCue({ kind: "terminal", agentActivityState: "running", prStatus: "abandoned" })?.state,
    ).toBe("running");
  });

  /**
   * A task workspace outlives its task: the worktree stays and the user opens
   * a Claude tab in it by hand. That tab shows "running" — the sidebar dot has
   * to pulse with it instead of still reporting the run that ended.
   */
  it("lets a session that is running now outrank a settled task state", () => {
    for (const taskState of ["completed", "failed", "stopped", "paused"]) {
      expect(
        resolveWorkspaceStatusCue({
          kind: "task",
          taskState,
          agentActivityState: "running",
          agentActivityLabel: "Claude Code is working",
        }),
      ).toEqual({ state: "running", label: "Claude Code is working", heartbeat: true });
    }

    // …but a task that is still running keeps its own label.
    expect(
      resolveWorkspaceStatusCue({ kind: "task", taskState: "running", agentActivityState: "running" })?.label,
    ).toBe("Running…");

    // …and a finished session never overwrites the settled outcome.
    expect(resolveWorkspaceStatusCue({ kind: "task", taskState: "failed", agentActivityState: "done" })?.state).toBe(
      "failed",
    );
  });

  /**
   * A non-task workspace that happens to carry a stale `taskState` must not be
   * read as a task — the card has always required `kind === "task"` and the
   * shared resolver keeps that gate.
   */
  it("ignores a task state on a workspace that is not a task", () => {
    expect(resolveWorkspaceStatusCue({ kind: "terminal", taskState: "running" })).toBeNull();
    expect(isTaskRunningState("idle")).toBe(false);
    expect(isTaskRunningState(null)).toBe(false);
  });
});
