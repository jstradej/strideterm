/**
 * V4 review, §"P1 — task recovery hlásí úspěch a může zapsat práci i po
 * selhání".
 *
 * `resolveTaskRecovery()` used to end with a flat `{ ok: true }` no matter what
 * happened inside, so a refused resume, a dangling attached Primary or a
 * session that never came up all reported success — the candidate was dropped
 * from the recovery list and an explicit Resume stamped `lastWorkedAt` on a
 * workspace whose agent was never brought back.
 *
 * These tests drive the REAL resolver (only the runner and the session manager
 * are doubled, exactly as the runtime wires them), because the previous
 * coverage mocked `resolveTaskRecovery` itself and therefore could not see the
 * paths that produce a false success.
 */
import { describe, expect, test, vi, beforeEach, afterEach } from "vitest";
import { createTaskHandlers } from "./runtime-task-handlers.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyApi = any;

const CANDIDATE = {
  taskId: "t1",
  workspaceId: "ws-task",
  workspaceName: "Task",
  profileId: "default",
  currentRound: 2,
  maxRounds: 5,
  previousState: "running",
};

function standardTaskWorkspace(overrides: AnyApi = {}): AnyApi {
  return {
    id: "ws-task",
    name: "Task",
    kind: "task",
    cwd: "/tmp/task",
    profileId: "default",
    panels: [
      { id: "panel-worker", title: "Worker", command: "claude" },
      { id: "panel-judge", title: "Judge", command: "claude" },
    ],
    task: {
      taskId: "t1",
      workerPanelId: "panel-worker",
      judgePanelId: "panel-judge",
      state: "paused",
      promptSent: true,
      showerResumePrompt: "",
      pausedFromState: "",
      ...overrides.task,
    },
    ...overrides,
  };
}

function attachedSourceWorkspace(overrides: AnyApi = {}): AnyApi {
  return {
    id: "ws-source",
    name: "Source",
    kind: "manual",
    cwd: "/tmp/source",
    profileId: "default",
    panels: [{ id: "panel-source", title: "Claude", command: "claude" }],
    task: null,
    ...overrides,
  };
}

function attachedTaskWorkspace(overrides: AnyApi = {}): AnyApi {
  return {
    id: "ws-task",
    name: "Reviewer: Source",
    kind: "task",
    cwd: "/tmp/source",
    profileId: "default",
    panels: [
      { id: "panel-dashboard", title: "Dashboard", command: "__task-dashboard__" },
      { id: "panel-judge", title: "Reviewer", command: "codex" },
    ],
    task: {
      taskId: "t1",
      mode: "attached",
      workerWorkspaceId: "ws-source",
      workerPanelId: "panel-source",
      judgePanelId: "panel-judge",
      companionRole: "reviewer",
      state: "paused",
      showerResumePrompt: "",
      pausedFromState: "",
      ...overrides.task,
    },
    ...overrides,
  };
}

function makeRuntime({
  workspaces,
  candidates = [CANDIDATE],
  resumeTask = () => true,
  resetTask = async () => true,
  ensureSession = async () => null,
}: {
  workspaces: AnyApi[];
  candidates?: AnyApi[];
  resumeTask?: (workspaceId: string) => boolean;
  resetTask?: (workspaceId: string) => Promise<boolean>;
  ensureSession?: (state: AnyApi, sessionId: string) => Promise<unknown>;
}) {
  const state = { workspaces, activeProfileId: "default", profiles: [{ id: "default" }] };
  let recoveryCandidates: AnyApi[] = [...candidates];
  const recordWorkspaceWork = vi.fn(async (_workspaceId: string, _viewerId?: string) => {});
  const taskRunner = {
    resumeTask: vi.fn(resumeTask),
    resetTask: vi.fn(resetTask),
    markAttachedSourceMissing: vi.fn(),
    onAgentIdle: vi.fn(() => true),
  };
  const sessions = { hasSession: vi.fn(() => true), ensureSession: vi.fn(ensureSession) };
  const handlers = createTaskHandlers({
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn() } as AnyApi,
    getState: (() => state) as AnyApi,
    getPayload: () => ({ appState: state }),
    broadcastState: vi.fn(),
    store: {
      mutate: vi.fn(async (fn: (draft: AnyApi) => void) => {
        fn(state);
      }),
    },
    taskRunner,
    sessions,
    execFileTextImpl: vi.fn(async () => ({ stdout: "", stderr: "" })),
    recheckClaudeAvailability: vi.fn(async () => true),
    assertWorkspaceInViewerProfile: vi.fn(),
    resolveCallerProfileId: vi.fn(() => "default"),
    assertNoConflictingActiveTask: vi.fn(),
    worktreeTreePath: vi.fn(() => ""),
    ensureWorktree: vi.fn(async () => ""),
    getRecoveryCandidates: () => recoveryCandidates,
    setRecoveryCandidates: vi.fn((next: AnyApi[]) => {
      recoveryCandidates = next;
    }),
    recordWorkspaceWork,
  } as AnyApi);

  // `this` at call time must be the full merged runtime, exactly as runtime.ts
  // spreads the handlers in — resumeTask reaches resolveTaskRecovery that way.
  const runtime = { ...handlers };
  return {
    runtime,
    taskRunner,
    sessions,
    recordWorkspaceWork,
    remainingCandidates: () => recoveryCandidates.map((c: AnyApi) => c.workspaceId),
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("resolveTaskRecovery — per-workspace outcomes", () => {
  test("a real resumeTask=false is a failed outcome, keeps the candidate and stamps nothing", async () => {
    const { runtime, recordWorkspaceWork, remainingCandidates } = makeRuntime({
      workspaces: [standardTaskWorkspace()],
      resumeTask: () => false,
    });

    const result = await runtime.resolveTaskRecovery({ "ws-task": "continue" });

    expect(result.ok).toBe(false);
    expect(result.outcomes).toEqual({ "ws-task": "failed" });
    expect(recordWorkspaceWork).not.toHaveBeenCalled();
    // Nothing is lost: the user can still retry or skip it.
    expect(remainingCandidates()).toEqual(["ws-task"]);
  });

  test("an explicit Resume over that same refusal stamps nothing either", async () => {
    const { runtime, recordWorkspaceWork } = makeRuntime({
      workspaces: [standardTaskWorkspace()],
      resumeTask: () => false,
    });

    const result = await runtime.resumeTask("ws-task", "win-1");

    expect(result.ok).toBe(false);
    expect(recordWorkspaceWork).not.toHaveBeenCalled();
  });

  test("an attached task whose source workspace is gone fails instead of reporting success", async () => {
    const { runtime, taskRunner, recordWorkspaceWork, remainingCandidates } = makeRuntime({
      workspaces: [attachedTaskWorkspace()],
    });

    const result = await runtime.resumeTask("ws-task", "win-1");

    expect(result.outcomes).toEqual({ "ws-task": "failed" });
    expect(result.ok).toBe(false);
    expect(taskRunner.markAttachedSourceMissing).toHaveBeenCalledWith("ws-task");
    expect(taskRunner.resumeTask).not.toHaveBeenCalled();
    expect(recordWorkspaceWork).not.toHaveBeenCalled();
    expect(remainingCandidates()).toEqual(["ws-task"]);
  });

  test("an attached task whose bound source PANEL is gone fails the same way", async () => {
    const { runtime, taskRunner, recordWorkspaceWork } = makeRuntime({
      workspaces: [attachedSourceWorkspace({ panels: [] }), attachedTaskWorkspace()],
    });

    const result = await runtime.resumeTask("ws-task", "win-1");

    expect(result.outcomes).toEqual({ "ws-task": "failed" });
    expect(taskRunner.markAttachedSourceMissing).toHaveBeenCalledWith("ws-task");
    expect(recordWorkspaceWork).not.toHaveBeenCalled();
  });

  test("the session the agent must re-orient in failing to spawn is a failure, not a warning", async () => {
    const { runtime, recordWorkspaceWork, remainingCandidates } = makeRuntime({
      workspaces: [standardTaskWorkspace()],
      ensureSession: async (_state, sessionId) => {
        if (sessionId === "ws-task:panel-worker") throw new Error("pty spawn failed");
        return null;
      },
    });

    const result = await runtime.resumeTask("ws-task", "win-1");

    expect(result.outcomes).toEqual({ "ws-task": "failed" });
    expect(recordWorkspaceWork).not.toHaveBeenCalled();
    expect(remainingCandidates()).toEqual(["ws-task"]);
  });

  test("a HELPER session failing to spawn does not bring down a recovery that otherwise worked", async () => {
    // The worker phase only pre-warms the judge PTY; the loop can spawn it
    // later. Losing it must not be reported as a failed recovery.
    const { runtime, recordWorkspaceWork, remainingCandidates } = makeRuntime({
      workspaces: [standardTaskWorkspace()],
      ensureSession: async (_state, sessionId) => {
        if (sessionId === "ws-task:panel-judge") throw new Error("pty spawn failed");
        return null;
      },
    });

    const result = await runtime.resumeTask("ws-task", "win-1");

    expect(result.outcomes).toEqual({ "ws-task": "continued" });
    expect(result.ok).toBe(true);
    expect(recordWorkspaceWork.mock.calls).toEqual([["ws-task", "win-1"]]);
    expect(remainingCandidates()).toEqual([]);
  });

  test("a task with no panel to re-orient in fails rather than resuming into nothing", async () => {
    const { runtime, recordWorkspaceWork } = makeRuntime({
      workspaces: [standardTaskWorkspace({ task: { workerPanelId: "", judgePanelId: "" } })],
    });

    const result = await runtime.resumeTask("ws-task", "win-1");

    expect(result.outcomes).toEqual({ "ws-task": "failed" });
    expect(recordWorkspaceWork).not.toHaveBeenCalled();
  });

  test("a genuine continue reports 'continued', settles the candidate and stamps exactly once", async () => {
    const { runtime, sessions, recordWorkspaceWork, remainingCandidates } = makeRuntime({
      workspaces: [standardTaskWorkspace()],
    });

    const result = await runtime.resumeTask("ws-task", "win-1");

    expect(result.ok).toBe(true);
    expect(result.outcomes).toEqual({ "ws-task": "continued" });
    expect(recordWorkspaceWork.mock.calls).toEqual([["ws-task", "win-1"]]);
    // Both PTYs are prepared, the role's own one included.
    expect(sessions.ensureSession.mock.calls.map((call: AnyApi[]) => call[1]).sort()).toEqual([
      "ws-task:panel-judge",
      "ws-task:panel-worker",
    ]);
    expect(remainingCandidates()).toEqual([]);
  });

  // V5 review, §"P1 — recovery dialog obchází work stamp": there is no
  // automatic startup recovery in production — runtime.ts only COLLECTS the
  // candidates and the dialog is the single resume path — so a direct call to
  // the resolver is a person deciding, and it stamps. The stamp-free variant
  // is the internal executor, which is what `resumeTask` delegates to.
  test("the interactive resolver stamps a successful decision; the internal executor does not", async () => {
    const interactive = makeRuntime({ workspaces: [standardTaskWorkspace()] });
    const interactiveResult = await interactive.runtime.resolveTaskRecovery({ "ws-task": "continue" }, "win-1");
    expect(interactiveResult.outcomes).toEqual({ "ws-task": "continued" });
    expect(interactive.recordWorkspaceWork.mock.calls).toEqual([["ws-task", "win-1"]]);

    const internal = makeRuntime({ workspaces: [standardTaskWorkspace()] });
    const internalResult = await internal.runtime.applyTaskRecovery({ "ws-task": "continue" }, { origin: "internal" });
    expect(internalResult.outcomes).toEqual({ "ws-task": "continued" });
    expect(internal.recordWorkspaceWork).not.toHaveBeenCalled();
  });

  test("a judge-phase candidate re-orients in the JUDGE session", async () => {
    const { runtime, sessions } = makeRuntime({
      workspaces: [standardTaskWorkspace()],
      candidates: [{ ...CANDIDATE, previousState: "judge-evaluating" }],
    });

    const result = await runtime.resolveTaskRecovery({ "ws-task": "continue" });

    expect(result.outcomes).toEqual({ "ws-task": "continued" });
    // The required session comes up FIRST — it is the one the deferred idle
    // fires on; the worker panel is only the pre-warm.
    expect(sessions.ensureSession.mock.calls[0][1]).toBe("ws-task:panel-judge");
  });

  test("'skip' is its own outcome and settles the candidate", async () => {
    const { runtime, taskRunner, remainingCandidates } = makeRuntime({ workspaces: [standardTaskWorkspace()] });

    const result = await runtime.resolveTaskRecovery({ "ws-task": "skip" });

    expect(result).toMatchObject({ ok: true, outcomes: { "ws-task": "skipped" } });
    expect(taskRunner.resumeTask).not.toHaveBeenCalled();
    expect(remainingCandidates()).toEqual([]);
  });

  test("'fresh' reports 'fresh', and a reset the runner refuses reports 'failed'", async () => {
    const okRun = makeRuntime({ workspaces: [standardTaskWorkspace()] });
    expect((await okRun.runtime.resolveTaskRecovery({ "ws-task": "fresh" })).outcomes).toEqual({ "ws-task": "fresh" });
    expect(okRun.remainingCandidates()).toEqual([]);

    const refused = makeRuntime({ workspaces: [standardTaskWorkspace()], resetTask: async () => false });
    const result = await refused.runtime.resolveTaskRecovery({ "ws-task": "fresh" });
    expect(result).toMatchObject({ ok: false, outcomes: { "ws-task": "failed" } });
    expect(refused.remainingCandidates()).toEqual(["ws-task"]);
  });

  test("a candidate that throws is a failure, not a silently successful batch", async () => {
    const { runtime, remainingCandidates } = makeRuntime({
      workspaces: [standardTaskWorkspace()],
      resumeTask: () => {
        throw new Error("runner exploded");
      },
    });

    const result = await runtime.resolveTaskRecovery({ "ws-task": "continue" });

    expect(result).toMatchObject({ ok: false, outcomes: { "ws-task": "failed" } });
    expect(remainingCandidates()).toEqual(["ws-task"]);
  });

  test("a mixed batch reports per-item outcomes and keeps only the failed one", async () => {
    const good = standardTaskWorkspace();
    const bad = standardTaskWorkspace({ id: "ws-bad", name: "Bad", task: { workerPanelId: "", judgePanelId: "" } });
    const { runtime, remainingCandidates } = makeRuntime({
      workspaces: [good, bad],
      candidates: [CANDIDATE, { ...CANDIDATE, workspaceId: "ws-bad", workspaceName: "Bad" }],
    });

    const result = await runtime.resolveTaskRecovery({ "ws-task": "continue", "ws-bad": "continue" });

    expect(result.outcomes).toEqual({ "ws-task": "continued", "ws-bad": "failed" });
    // The whole batch is NOT reported as a success just because one item worked.
    expect(result.ok).toBe(false);
    expect(remainingCandidates()).toEqual(["ws-bad"]);
  });

  test("a decision for a workspace that is not a candidate produces no outcome at all", async () => {
    const { runtime, taskRunner } = makeRuntime({ workspaces: [standardTaskWorkspace()] });

    const result = await runtime.resolveTaskRecovery({ "ws-other": "continue" });

    expect(result).toMatchObject({ ok: true, outcomes: {} });
    expect(taskRunner.resumeTask).not.toHaveBeenCalled();
  });
});
