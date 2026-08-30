/**
 * V2 plan, Fáze 3 — the task half of the work allowlist.
 *
 * Task create / start / resume / reset, a user edit of the brief and an answer
 * to a question the loop asked all count as work — but only once the runner
 * has actually accepted the action. A refused or failed one stamps nothing.
 * Everything else the task surface does (pause, stop, status polling) is not
 * work at all.
 */
import { describe, expect, test, vi } from "vitest";
import { createTaskHandlers } from "./runtime-task-handlers.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyApi = any;

const TASK_WORKSPACE = {
  id: "ws-task",
  name: "Task",
  kind: "task",
  cwd: "/tmp/task",
  profileId: "default",
  panels: [{ id: "panel-worker", title: "Worker", command: "claude" }],
  task: { taskId: "t1", description: "old brief", workerPanelId: "panel-worker", judgePanelId: "panel-judge" },
};

function makeHandlers({
  accepted = true,
  recoveryCandidates = [],
  callerProfileId = "default",
}: { accepted?: boolean; recoveryCandidates?: AnyApi[]; callerProfileId?: string } = {}) {
  const recordWorkspaceWork = vi.fn(async (_workspaceId: string, _viewerId?: string) => {});
  const state = { workspaces: [TASK_WORKSPACE] as AnyApi[], profiles: [{ id: "default" }] };
  const taskRunner = {
    startTask: vi.fn(async () => accepted),
    resumeTask: vi.fn(() => accepted),
    resetTask: vi.fn(async () => accepted),
    pauseTask: vi.fn(() => true),
    stopTask: vi.fn(() => true),
    answerCompanionTask: vi.fn(async () => accepted),
    rejectTaskVerdict: vi.fn(async () => accepted),
    getTaskState: vi.fn(() => ({ state: "running" })),
    onAgentIdle: vi.fn(() => true),
  };
  const handlers = createTaskHandlers({
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn() } as AnyApi,
    getState: (() => state) as AnyApi,
    getPayload: () => ({ appState: state }),
    broadcastState: vi.fn(),
    store: { mutate: vi.fn(async () => {}) },
    taskRunner,
    sessions: { hasSession: vi.fn(() => true), ensureSession: vi.fn(async () => null) },
    execFileTextImpl: vi.fn(async () => ({ stdout: "", stderr: "" })),
    recheckClaudeAvailability: vi.fn(async () => true),
    assertWorkspaceInViewerProfile: vi.fn(),
    resolveCallerProfileId: vi.fn(() => callerProfileId),
    assertNoConflictingActiveTask: vi.fn(),
    worktreeTreePath: vi.fn(() => ""),
    ensureWorktree: vi.fn(async () => ""),
    getRecoveryCandidates: () => recoveryCandidates,
    setRecoveryCandidates: vi.fn(),
    recordWorkspaceWork,
  } as AnyApi);
  return { handlers, recordWorkspaceWork, taskRunner };
}

describe("task handlers — lastWorkedAt stamping", () => {
  test("start / resume / reset stamp the task workspace once the runner accepts", async () => {
    const { handlers, recordWorkspaceWork } = makeHandlers();

    await handlers.startTask("ws-task", "win-1");
    await handlers.resumeTask("ws-task", "win-1");
    await handlers.resetTask("ws-task", "win-1");

    expect(recordWorkspaceWork.mock.calls).toEqual([
      ["ws-task", "win-1"],
      ["ws-task", "win-1"],
      ["ws-task", "win-1"],
    ]);
  });

  test("a runner that refuses the action stamps nothing", async () => {
    const { handlers, recordWorkspaceWork } = makeHandlers({ accepted: false });

    await handlers.startTask("ws-task", "win-1");
    await handlers.resumeTask("ws-task", "win-1");
    await handlers.resetTask("ws-task", "win-1");
    await handlers.answerCompanionTask("ws-task", ["q1"], "yes", "win-1");
    await handlers.rejectTaskVerdict("ws-task", "not good enough");

    expect(recordWorkspaceWork).not.toHaveBeenCalled();
  });

  test("answering a companion question and rejecting a verdict are work", async () => {
    const { handlers, recordWorkspaceWork } = makeHandlers();

    await handlers.answerCompanionTask("ws-task", ["q1"], "yes", "win-1");
    await handlers.rejectTaskVerdict("ws-task", "not good enough");

    expect(recordWorkspaceWork).toHaveBeenCalledTimes(2);
    expect(recordWorkspaceWork.mock.calls[0]).toEqual(["ws-task", "win-1"]);
    expect(recordWorkspaceWork.mock.calls[1][0]).toBe("ws-task");
  });

  // V3 review, §4 P2 — a startup recovery candidate takes the full recovery
  // path, and the branch that delegates to it used to `return` before the
  // stamp, so an explicit Continue on a recovered task looked like navigation.
  const RECOVERY_CANDIDATE = { workspaceId: "ws-task", previousState: "running", currentRound: 1, taskId: "t1" };

  test("an explicit Resume of a recovery candidate stamps the workspace exactly once", async () => {
    const { handlers, recordWorkspaceWork } = makeHandlers({ recoveryCandidates: [RECOVERY_CANDIDATE] });
    const apply = vi
      .spyOn(handlers, "applyTaskRecovery")
      .mockResolvedValue({ ok: true, outcomes: { "ws-task": "continued" }, payload: {} } as AnyApi);

    const result = await handlers.resumeTask("ws-task", "win-1");

    // V5 review, Fáze 1 — the delegation goes to the INTERNAL executor, which
    // stamps nothing; this wrapper owns the single stamp for its own endpoint.
    // Routing through the interactive endpoint would credit one click twice.
    expect(apply).toHaveBeenCalledWith({ "ws-task": "continue" }, { origin: "internal" });
    expect(recordWorkspaceWork.mock.calls).toEqual([["ws-task", "win-1"]]);
    // The response payload is rebuilt after the stamp, so a renderer adopting
    // it cannot roll the fresh timestamp back.
    expect(result.ok).toBe(true);
    expect(result.payload).toBeDefined();
  });

  test("a recovery Resume the recovery path refused stamps nothing", async () => {
    const { handlers, recordWorkspaceWork } = makeHandlers({ recoveryCandidates: [RECOVERY_CANDIDATE] });
    vi.spyOn(handlers, "applyTaskRecovery").mockResolvedValue({
      ok: false,
      outcomes: { "ws-task": "failed" },
      payload: {},
    } as AnyApi);

    await handlers.resumeTask("ws-task", "win-1");

    expect(recordWorkspaceWork).not.toHaveBeenCalled();
  });

  // V4 review, §"P1" oprava 2 — the gate is THIS candidate's own outcome, not
  // the batch's `ok`. A skipped or reset candidate is not a continue, a stale
  // one was settled by somebody else, and a recovery path that answers with no
  // outcome at all is not a continue either.
  test("only a 'continued' outcome stamps — 'skipped', 'fresh', 'stale' and a missing outcome do not", async () => {
    for (const outcome of ["skipped", "fresh", "stale", undefined]) {
      const { handlers, recordWorkspaceWork } = makeHandlers({ recoveryCandidates: [RECOVERY_CANDIDATE] });
      vi.spyOn(handlers, "applyTaskRecovery").mockResolvedValue({
        ok: true,
        outcomes: outcome ? { "ws-task": outcome } : {},
        payload: {},
      } as AnyApi);

      await handlers.resumeTask("ws-task", "win-1");

      expect(recordWorkspaceWork, `outcome=${outcome}`).not.toHaveBeenCalled();
    }
  });

  // V5 review, §"P1 — recovery dialog obchází work stamp": production startup
  // recovery is NOT automatic (runtime.ts only collects candidates), so the
  // dialog's own buttons are the only resume path — and they call the resolver
  // directly. That call is a person deciding, so it must stamp; the internal
  // executor behind it must not.
  test("the interactive endpoint stamps a successful decision; the internal executor stamps nothing", async () => {
    vi.useFakeTimers();
    try {
      const interactive = makeHandlers({ recoveryCandidates: [RECOVERY_CANDIDATE] });
      await interactive.handlers.resolveTaskRecovery({ "ws-task": "continue" }, "win-1");
      expect(interactive.recordWorkspaceWork.mock.calls).toEqual([["ws-task", "win-1"]]);

      const internal = makeHandlers({ recoveryCandidates: [RECOVERY_CANDIDATE] });
      await internal.handlers.applyTaskRecovery({ "ws-task": "continue" }, { origin: "internal" });
      expect(internal.recordWorkspaceWork).not.toHaveBeenCalled();
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  test("an interactive 'fresh' stamps too, and skip / stale / failed never do", async () => {
    vi.useFakeTimers();
    try {
      const fresh = makeHandlers({ recoveryCandidates: [RECOVERY_CANDIDATE] });
      await fresh.handlers.resolveTaskRecovery({ "ws-task": "fresh" }, "win-1");
      expect(fresh.recordWorkspaceWork.mock.calls).toEqual([["ws-task", "win-1"]]);

      const skipped = makeHandlers({ recoveryCandidates: [RECOVERY_CANDIDATE] });
      await skipped.handlers.resolveTaskRecovery({ "ws-task": "skip" }, "win-1");
      expect(skipped.recordWorkspaceWork).not.toHaveBeenCalled();

      // Not a candidate at all — another window already settled it.
      const stale = makeHandlers({ recoveryCandidates: [] });
      const staleResult = await stale.handlers.resolveTaskRecovery({ "ws-task": "continue" }, "win-1");
      expect(staleResult.outcomes).toEqual({ "ws-task": "stale" });
      expect(stale.recordWorkspaceWork).not.toHaveBeenCalled();

      const refused = makeHandlers({ accepted: false, recoveryCandidates: [RECOVERY_CANDIDATE] });
      const refusedResult = await refused.handlers.resolveTaskRecovery({ "ws-task": "fresh" }, "win-1");
      expect(refusedResult.outcomes).toEqual({ "ws-task": "failed" });
      expect(refused.recordWorkspaceWork).not.toHaveBeenCalled();
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  // V5 test matrix: "Resume all → každý `continued` právě jednou, failed/skip
  // bez stampu."
  test("a mixed Resume-all batch stamps each success once and nothing else", async () => {
    vi.useFakeTimers();
    try {
      const candidates = [
        { ...RECOVERY_CANDIDATE, workspaceId: "ws-task" },
        { ...RECOVERY_CANDIDATE, workspaceId: "ws-other" },
        { ...RECOVERY_CANDIDATE, workspaceId: "ws-skipped" },
      ];
      const { handlers, recordWorkspaceWork } = makeHandlers({ recoveryCandidates: candidates });

      const result = await handlers.resolveTaskRecovery(
        { "ws-task": "continue", "ws-other": "continue", "ws-skipped": "skip", "ws-gone": "continue" },
        "win-1",
      );

      // `ws-other` has no workspace in state, so its continue genuinely fails;
      // `ws-gone` is not a candidate at all.
      expect(result.outcomes).toEqual({
        "ws-task": "continued",
        "ws-other": "failed",
        "ws-skipped": "skipped",
        "ws-gone": "stale",
      });
      expect(result.ok).toBe(false);
      expect(recordWorkspaceWork.mock.calls).toEqual([["ws-task", "win-1"]]);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  // The dialog deliberately triages candidates from EVERY profile (its profile
  // badge is for exactly that), so a decision on a foreign-profile candidate
  // must still be credited rather than dropped as a cross-profile stamp.
  test("a candidate outside the deciding window's profile is still stamped", async () => {
    vi.useFakeTimers();
    try {
      const { handlers, recordWorkspaceWork } = makeHandlers({
        recoveryCandidates: [{ ...RECOVERY_CANDIDATE, profileId: "work" }],
        callerProfileId: "default",
      });

      await handlers.resolveTaskRecovery({ "ws-task": "continue" }, "win-1");

      // Stamped WITHOUT the viewer, so `recordWorkspaceWork` cannot skip it as
      // a cross-profile write.
      expect(recordWorkspaceWork.mock.calls).toEqual([["ws-task", undefined]]);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });
  test("pause, stop and status polling are not work", async () => {
    const { handlers, recordWorkspaceWork } = makeHandlers();

    handlers.pauseTask("ws-task", "win-1");
    handlers.stopTask("ws-task", "win-1");
    handlers.getTaskStatus("ws-task");

    expect(recordWorkspaceWork).not.toHaveBeenCalled();
  });
});
