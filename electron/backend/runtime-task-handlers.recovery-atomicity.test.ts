/**
 * V5 review, §"P1 — `failed` recovery může zanechat task jako `running` bez
 * session" and §"Fáze 0 — atomický recovery".
 *
 * V4 made the recovery batch report a truthful per-workspace outcome, but the
 * work behind that outcome was still ordered destructively: `resumeTask()` was
 * called BEFORE the PTY the agent must re-orient in was opened, and
 * `resetTask()` wiped the task record BEFORE writing the file the reset needs.
 * A `failed` outcome could therefore describe a task that was already running
 * with no session, or already emptied and no longer resettable — the dialog
 * said "stayed paused" about a task that had not.
 *
 * The invariant these tests pin down:
 *
 *   outcome `failed` guarantees the candidate is left in a truthful, repeatable
 *   recovery state. A Retry must be possible and a Skip must not leave an
 *   active task or a staged prompt behind.
 *
 * They run the REAL `AgentTaskRunner`, not a boolean double: the previous
 * coverage stubbed `resumeTask: vi.fn(() => false)`, which returns the same
 * value as the real one but performs none of its state mutation — precisely
 * the reason the ordering bug survived a green suite.
 */
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { describe, expect, test, vi, beforeEach, afterEach } from "vitest";
import { AgentTaskRunner } from "./agent-task-runner.js";
import { WORK_LOCK_FILE, taskDir } from "./agent-task-utils.js";
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

let tmpRoot = "";

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "strideterm-recovery-"));
  vi.useFakeTimers();
});

afterEach(async () => {
  vi.clearAllTimers();
  vi.useRealTimers();
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

function standardTaskWorkspace(cwd: string, overrides: AnyApi = {}): AnyApi {
  const { task: taskOverrides, ...rest } = overrides;
  return {
    id: "ws-task",
    name: "Task",
    kind: "task",
    cwd,
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
      pausedFromState: "running",
      promptSent: true,
      showerResumePrompt: "",
      currentRound: 2,
      maxRounds: 5,
      rounds: [{ round: 1, judgeVerdict: "revise" }],
      ...taskOverrides,
    },
    ...rest,
  };
}

function attachedTaskWorkspaces(cwd: string, overrides: AnyApi = {}): AnyApi[] {
  const { task: taskOverrides } = overrides;
  return [
    {
      id: "ws-source",
      name: "Source",
      kind: "manual",
      cwd,
      profileId: "default",
      panels: [{ id: "panel-source", title: "Claude", command: "claude" }],
      task: null,
    },
    {
      id: "ws-task",
      name: "Reviewer: Source",
      kind: "task",
      cwd,
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
        pausedFromState: "running",
        promptSent: true,
        showerResumePrompt: "",
        currentRound: 2,
        maxRounds: 5,
        rounds: [],
        ...taskOverrides,
      },
    },
  ];
}

/**
 * The handlers wired to a REAL `AgentTaskRunner`, exactly as runtime.ts wires
 * them: one shared state object the store mutation and the runner both see, so
 * a state transition the runner performs is visible to the assertions.
 */
function makeRuntime({
  workspaces,
  candidates = [CANDIDATE],
  ensureSession = async () => null,
}: {
  workspaces: AnyApi[];
  candidates?: AnyApi[];
  ensureSession?: (state: AnyApi, sessionId: string) => Promise<unknown>;
}) {
  const state = { workspaces, activeProfileId: "default", profiles: [{ id: "default" }] };
  let recoveryCandidates: AnyApi[] = [...candidates];
  const recordWorkspaceWork = vi.fn(async (_workspaceId: string, _viewerId?: string) => {});

  const taskRunner = new AgentTaskRunner();
  taskRunner.init({
    writeToSession: vi.fn(),
    getState: (() => state) as AnyApi,
    broadcastState: vi.fn(),
    raiseAlert: vi.fn(),
    restartSession: vi.fn(async () => {}),
  } as AnyApi);

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

  const runtime = { ...handlers };
  const taskOf = (id: string) => state.workspaces.find((ws: AnyApi) => ws.id === id)?.task;
  return {
    runtime,
    sessions,
    recordWorkspaceWork,
    task: () => taskOf("ws-task"),
    remainingCandidates: () => recoveryCandidates.map((c: AnyApi) => c.workspaceId),
  };
}

describe("recovery atomicity — a failed outcome leaves a retryable task", () => {
  test("a required session that never comes up leaves the task PAUSED, unstaged and retryable", async () => {
    const cwd = path.join(tmpRoot, "standard");
    await fs.mkdir(taskDir(cwd, "t1"), { recursive: true });
    const { runtime, task, recordWorkspaceWork, remainingCandidates } = makeRuntime({
      workspaces: [standardTaskWorkspace(cwd)],
      ensureSession: async () => {
        throw new Error("pty spawn failed");
      },
    });

    const result = await runtime.resolveTaskRecovery({ "ws-task": "continue" }, "win-1");

    expect(result.outcomes).toEqual({ "ws-task": "failed" });
    // The whole point: the task never moved. Before the fix it was already
    // `running`, with `pausedFromState` cleared and a prompt staged for the
    // next unrelated idle.
    expect(task().state).toBe("paused");
    expect(task().pausedFromState).toBe("running");
    expect(task().showerResumePrompt).toBe("");
    expect(task().promptSent).toBe(true);
    expect(remainingCandidates()).toEqual(["ws-task"]);
    expect(recordWorkspaceWork).not.toHaveBeenCalled();
  });

  test("the same candidate can be retried, and the second attempt genuinely continues", async () => {
    const cwd = path.join(tmpRoot, "retry");
    await fs.mkdir(taskDir(cwd, "t1"), { recursive: true });
    let failNext = true;
    const { runtime, task, recordWorkspaceWork, remainingCandidates } = makeRuntime({
      workspaces: [standardTaskWorkspace(cwd)],
      ensureSession: async () => {
        if (failNext) throw new Error("pty spawn failed");
        return null;
      },
    });

    const first = await runtime.resolveTaskRecovery({ "ws-task": "continue" }, "win-1");
    expect(first.outcomes).toEqual({ "ws-task": "failed" });

    failNext = false;
    const second = await runtime.resolveTaskRecovery({ "ws-task": "continue" }, "win-1");

    expect(second.ok).toBe(true);
    expect(second.outcomes).toEqual({ "ws-task": "continued" });
    expect(task().state).toBe("running");
    expect(task().showerResumePrompt).toContain("round 2");
    expect(task().promptSent).toBe(false);
    expect(remainingCandidates()).toEqual([]);
    // Exactly one stamp, from the successful attempt only.
    expect(recordWorkspaceWork.mock.calls).toEqual([["ws-task", "win-1"]]);
  });

  test("the same holds for a JUDGE-phase candidate, whose required session is the judge's", async () => {
    const cwd = path.join(tmpRoot, "judge");
    await fs.mkdir(taskDir(cwd, "t1"), { recursive: true });
    const { runtime, sessions, task, remainingCandidates } = makeRuntime({
      workspaces: [standardTaskWorkspace(cwd, { task: { pausedFromState: "judge-evaluating" } })],
      candidates: [{ ...CANDIDATE, previousState: "judge-evaluating" }],
      ensureSession: async (_state: AnyApi, sessionId: string) => {
        if (sessionId === "ws-task:panel-judge") throw new Error("judge pty spawn failed");
        return null;
      },
    });

    const result = await runtime.resolveTaskRecovery({ "ws-task": "continue" }, "win-1");

    expect(result.outcomes).toEqual({ "ws-task": "failed" });
    // The judge's own session is the required one, so its failure fails the
    // candidate — and the worker's PTY is never even pre-warmed, because that
    // only happens after the commit.
    expect(sessions.ensureSession.mock.calls.map((call: AnyApi[]) => call[1])).toEqual(["ws-task:panel-judge"]);
    expect(task().state).toBe("paused");
    expect(task().pausedFromState).toBe("judge-evaluating");
    expect(task().showerResumePrompt).toBe("");
    expect(remainingCandidates()).toEqual(["ws-task"]);
  });

  test("a Skip after a failure leaves no running ghost and no stale prompt", async () => {
    const cwd = path.join(tmpRoot, "skip");
    await fs.mkdir(taskDir(cwd, "t1"), { recursive: true });
    const { runtime, task, recordWorkspaceWork, remainingCandidates } = makeRuntime({
      workspaces: [standardTaskWorkspace(cwd)],
      ensureSession: async () => {
        throw new Error("pty spawn failed");
      },
    });

    await runtime.resolveTaskRecovery({ "ws-task": "continue" }, "win-1");
    const skipped = await runtime.resolveTaskRecovery({ "ws-task": "skip" }, "win-1");

    expect(skipped.outcomes).toEqual({ "ws-task": "skipped" });
    // A task left `running` by the failed attempt would still be in the
    // task-only RUNNING surface with no session behind it.
    expect(task().state).toBe("paused");
    expect(task().showerResumePrompt).toBe("");
    expect(remainingCandidates()).toEqual([]);
    expect(recordWorkspaceWork).not.toHaveBeenCalled();
  });

  test("a resume the runner refuses rolls the staged prompt back", async () => {
    const cwd = path.join(tmpRoot, "refused");
    await fs.mkdir(taskDir(cwd, "t1"), { recursive: true });
    // Another window reset this task between the candidate sweep and the
    // decision: `idle` is not resumable, so the REAL runner refuses.
    const { runtime, task, recordWorkspaceWork, remainingCandidates } = makeRuntime({
      workspaces: [standardTaskWorkspace(cwd, { task: { state: "idle" } })],
    });

    const result = await runtime.resolveTaskRecovery({ "ws-task": "continue" }, "win-1");

    expect(result.outcomes).toEqual({ "ws-task": "failed" });
    expect(task().state).toBe("idle");
    // The staged half of the commit is undone — otherwise the recovery prompt
    // would sit on the task and be injected during some later, unrelated idle.
    expect(task().showerResumePrompt).toBe("");
    expect(task().promptSent).toBe(true);
    expect(remainingCandidates()).toEqual(["ws-task"]);
    expect(recordWorkspaceWork).not.toHaveBeenCalled();
  });

  test("an attached candidate whose required session fails stays paused and unstaged", async () => {
    const cwd = path.join(tmpRoot, "attached");
    await fs.mkdir(taskDir(cwd, "t1"), { recursive: true });
    const { runtime, task, remainingCandidates } = makeRuntime({
      workspaces: attachedTaskWorkspaces(cwd),
      ensureSession: async () => {
        throw new Error("primary pty spawn failed");
      },
    });

    const result = await runtime.resolveTaskRecovery({ "ws-task": "continue" }, "win-1");

    expect(result.outcomes).toEqual({ "ws-task": "failed" });
    expect(task().state).toBe("paused");
    expect(task().pausedFromState).toBe("running");
    expect(task().showerResumePrompt).toBe("");
    expect(remainingCandidates()).toEqual(["ws-task"]);
  });

  test("an attached resume the runner refuses (Primary gone) rolls the staged prompt back", async () => {
    const cwd = path.join(tmpRoot, "attached-refused");
    await fs.mkdir(taskDir(cwd, "t1"), { recursive: true });
    const { runtime, task, remainingCandidates } = makeRuntime({
      workspaces: attachedTaskWorkspaces(cwd, { task: { primaryMissing: true } }),
    });

    const result = await runtime.resolveTaskRecovery({ "ws-task": "continue" }, "win-1");

    expect(result.outcomes).toEqual({ "ws-task": "failed" });
    expect(task().state).toBe("paused");
    expect(task().showerResumePrompt).toBe("");
    expect(remainingCandidates()).toEqual(["ws-task"]);
  });

  test("a 'fresh' whose WORK_LOCK cannot be written changes nothing and stays retryable", async () => {
    // No task dir on disk: the real `#recreateWorkLock` write fails.
    const cwd = path.join(tmpRoot, "fresh-missing-dir");
    const { runtime, task, recordWorkspaceWork, remainingCandidates } = makeRuntime({
      workspaces: [standardTaskWorkspace(cwd)],
    });

    const failed = await runtime.resolveTaskRecovery({ "ws-task": "fresh" }, "win-1");

    expect(failed.ok).toBe(false);
    expect(failed.outcomes).toEqual({ "ws-task": "failed" });
    // The destructive half of a reset never ran, so the task is exactly as it
    // was — and, crucially, still in a state `resetTask` accepts.
    expect(task().state).toBe("paused");
    expect(task().currentRound).toBe(2);
    expect(task().rounds).toHaveLength(1);
    expect(task().promptSent).toBe(true);
    expect(remainingCandidates()).toEqual(["ws-task"]);
    expect(recordWorkspaceWork).not.toHaveBeenCalled();

    // Retry once the directory exists: the same candidate resets for real.
    await fs.mkdir(taskDir(cwd, "t1"), { recursive: true });
    const retried = await runtime.resolveTaskRecovery({ "ws-task": "fresh" }, "win-1");

    expect(retried.outcomes).toEqual({ "ws-task": "fresh" });
    expect(task().state).toBe("idle");
    expect(task().currentRound).toBe(0);
    expect(task().rounds).toEqual([]);
    await expect(fs.readFile(path.join(taskDir(cwd, "t1"), WORK_LOCK_FILE), "utf8")).resolves.toContain("Work remains");
    expect(remainingCandidates()).toEqual([]);
    expect(recordWorkspaceWork.mock.calls).toEqual([["ws-task", "win-1"]]);
  });
});
