/**
 * V6 review, §"P1 — recovery `stale` řeší jen sekvenční, ne skutečný
 * multi-window race".
 *
 * `applyTaskRecovery` read `recoveryCandidates` once, before the loop, and
 * then awaited `ensureSession()` / `resetTask()`. Two windows holding the same
 * dialog could therefore both find the same candidate, both act on it, and the
 * loser would finally write a candidate list derived from its own pre-await
 * snapshot — re-inserting a candidate the winner had settled, or resuming a
 * task the winner had just reset. `stale` only ever appeared when the second
 * request STARTED after the first had finished, which was never the failing
 * case.
 *
 * These tests are deterministic: `ensureSession` is gated on a deferred
 * promise, so "the second request waited for the first" is proven by observed
 * ordering, not by a timer. They drive the REAL `AgentTaskRunner` for the same
 * reason the atomicity suite does — a boolean double performs none of the
 * state mutation the invariants are about.
 */
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { describe, expect, test, vi, beforeEach, afterEach } from "vitest";
import { AgentTaskRunner } from "./agent-task-runner.js";
import { taskDir } from "./agent-task-utils.js";
import { createTaskHandlers } from "./runtime-task-handlers.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyApi = any;

function candidateFor(workspaceId: string): AnyApi {
  return {
    taskId: `t-${workspaceId}`,
    workspaceId,
    workspaceName: workspaceId,
    profileId: "default",
    currentRound: 2,
    maxRounds: 5,
    previousState: "running",
  };
}

function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (err: Error) => void } {
  let resolve!: (value: T) => void;
  let reject!: (err: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

let tmpRoot = "";

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "strideterm-recovery-race-"));
  vi.useFakeTimers();
});

afterEach(async () => {
  vi.clearAllTimers();
  vi.useRealTimers();
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

function taskWorkspace(id: string, cwd: string): AnyApi {
  return {
    id,
    name: id,
    kind: "task",
    cwd,
    profileId: "default",
    panels: [
      { id: "panel-worker", title: "Worker", command: "claude" },
      { id: "panel-judge", title: "Judge", command: "claude" },
    ],
    task: {
      taskId: `t-${id}`,
      workerPanelId: "panel-worker",
      judgePanelId: "panel-judge",
      state: "paused",
      pausedFromState: "running",
      promptSent: true,
      showerResumePrompt: "",
      currentRound: 2,
      maxRounds: 5,
      rounds: [{ round: 1, judgeVerdict: "revise" }],
    },
  };
}

/** The handlers wired to a REAL runner, as runtime.ts wires them. */
function makeRuntime({
  workspaces,
  candidates,
  ensureSession = async () => null,
}: {
  workspaces: AnyApi[];
  candidates: AnyApi[];
  ensureSession?: (state: AnyApi, sessionId: string) => Promise<unknown>;
}) {
  const state = { workspaces, activeProfileId: "default", profiles: [{ id: "default" }] };
  let recoveryCandidates: AnyApi[] = [...candidates];
  const recordWorkspaceWork = vi.fn(async (_workspaceId: string, _viewerId?: string) => {});
  const setRecoveryCandidates = vi.fn((next: AnyApi[]) => {
    recoveryCandidates = next;
  });

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
    setRecoveryCandidates,
    recordWorkspaceWork,
  } as AnyApi);

  const runtime = { ...handlers };
  return {
    runtime,
    taskRunner,
    sessions,
    recordWorkspaceWork,
    setRecoveryCandidates,
    task: (id: string) => state.workspaces.find((ws: AnyApi) => ws.id === id)?.task,
    remainingCandidates: () => recoveryCandidates.map((c: AnyApi) => c.workspaceId),
  };
}

/** One task workspace, its task directory created, plus a session gate. */
async function oneTask(gate?: Promise<unknown>) {
  const cwd = path.join(tmpRoot, "standard");
  await fs.mkdir(taskDir(cwd, "t-ws-task"), { recursive: true });
  const seen: string[] = [];
  const fixture = makeRuntime({
    workspaces: [taskWorkspace("ws-task", cwd)],
    candidates: [candidateFor("ws-task")],
    ensureSession: async (_state, sessionId) => {
      seen.push(sessionId);
      if (gate) await gate;
      return null;
    },
  });
  return { ...fixture, cwd, seen };
}

describe("recovery concurrency — one workspace is decided by exactly one request", () => {
  test("two simultaneous Continues: one continues, the other waits and gets `stale`", async () => {
    const gate = deferred();
    const { runtime, recordWorkspaceWork, remainingCandidates, task } = await oneTask(gate.promise);

    // Both windows fire before either can finish — the first is parked inside
    // `ensureSession`, exactly where the old snapshot bug lived.
    const first = runtime.resolveTaskRecovery({ "ws-task": "continue" }, "win-A");
    const second = runtime.resolveTaskRecovery({ "ws-task": "continue" }, "win-B");

    gate.resolve();
    const [a, b] = await Promise.all([first, second]);

    expect(a.outcomes).toEqual({ "ws-task": "continued" });
    // The loser is told the truth: settled by somebody else, not "failed".
    expect(b.outcomes).toEqual({ "ws-task": "stale" });
    expect(b.ok).toBe(true);
    // One decision, one stamp — and the candidate does not come back.
    expect(recordWorkspaceWork.mock.calls).toEqual([["ws-task", "win-A"]]);
    expect(remainingCandidates()).toEqual([]);
    expect(task("ws-task").state).toBe("running");
  });

  test("a Continue racing a Skip: the first holder decides, the second is `stale`", async () => {
    const gate = deferred();
    const { runtime, remainingCandidates, task } = await oneTask(gate.promise);

    const continueFirst = runtime.resolveTaskRecovery({ "ws-task": "continue" }, "win-A");
    const skipSecond = runtime.resolveTaskRecovery({ "ws-task": "skip" }, "win-B");

    gate.resolve();
    const [a, b] = await Promise.all([continueFirst, skipSecond]);

    expect(a.outcomes).toEqual({ "ws-task": "continued" });
    expect(b.outcomes).toEqual({ "ws-task": "stale" });
    // The Skip did NOT re-pause a task the Continue had just resumed.
    expect(task("ws-task").state).toBe("running");
    expect(remainingCandidates()).toEqual([]);
  });

  test("a Fresh racing a Continue leaves neither the candidate nor the task in a mixed state", async () => {
    const gate = deferred();
    const { runtime, remainingCandidates, task } = await oneTask(gate.promise);

    const continueFirst = runtime.resolveTaskRecovery({ "ws-task": "continue" }, "win-A");
    const freshSecond = runtime.resolveTaskRecovery({ "ws-task": "fresh" }, "win-B");

    gate.resolve();
    const [a, b] = await Promise.all([continueFirst, freshSecond]);

    expect(a.outcomes).toEqual({ "ws-task": "continued" });
    expect(b.outcomes).toEqual({ "ws-task": "stale" });
    // The reset never ran, so the resumed task keeps its round history.
    expect(task("ws-task").state).toBe("running");
    expect(task("ws-task").currentRound).toBe(2);
    expect(remainingCandidates()).toEqual([]);
  });

  test("the first Continue failing on its PTY lets the second one really retry", async () => {
    const cwd = path.join(tmpRoot, "retry");
    await fs.mkdir(taskDir(cwd, "t-ws-task"), { recursive: true });
    const gate = deferred();
    let attempt = 0;
    const fixture = makeRuntime({
      workspaces: [taskWorkspace("ws-task", cwd)],
      candidates: [candidateFor("ws-task")],
      ensureSession: async () => {
        attempt += 1;
        // The FIRST required session never comes up; the second attempt does.
        if (attempt === 1) {
          await gate.promise;
          throw new Error("pty spawn failed");
        }
        return null;
      },
    });

    const first = fixture.runtime.resolveTaskRecovery({ "ws-task": "continue" }, "win-A");
    const second = fixture.runtime.resolveTaskRecovery({ "ws-task": "continue" }, "win-B");

    gate.resolve();
    const [a, b] = await Promise.all([first, second]);

    expect(a.outcomes).toEqual({ "ws-task": "failed" });
    // A failed candidate STAYS, so the queued request is a genuine retry —
    // never a `stale` that would strand the task paused with nobody able to
    // touch it.
    expect(b.outcomes).toEqual({ "ws-task": "continued" });
    expect(fixture.task("ws-task").state).toBe("running");
    expect(fixture.remainingCandidates()).toEqual([]);
    expect(fixture.recordWorkspaceWork.mock.calls).toEqual([["ws-task", "win-B"]]);
  });

  test("two different workspaces never wait on each other", async () => {
    const cwdA = path.join(tmpRoot, "a");
    const cwdB = path.join(tmpRoot, "b");
    await fs.mkdir(taskDir(cwdA, "t-ws-a"), { recursive: true });
    await fs.mkdir(taskDir(cwdB, "t-ws-b"), { recursive: true });
    const gate = deferred();
    const fixture = makeRuntime({
      workspaces: [taskWorkspace("ws-a", cwdA), taskWorkspace("ws-b", cwdB)],
      candidates: [candidateFor("ws-a"), candidateFor("ws-b")],
      ensureSession: async (_state, sessionId) => {
        if (sessionId.startsWith("ws-a")) await gate.promise;
        return null;
      },
    });

    const blocked = fixture.runtime.resolveTaskRecovery({ "ws-a": "continue" }, "win-A");
    const free = fixture.runtime.resolveTaskRecovery({ "ws-b": "continue" }, "win-B");

    // ws-b finishes while ws-a is still parked on its PTY.
    expect((await free).outcomes).toEqual({ "ws-b": "continued" });
    expect(fixture.task("ws-a").state).toBe("paused");

    gate.resolve();
    expect((await blocked).outcomes).toEqual({ "ws-a": "continued" });
  });

  test("a settlement made while a request waits is never overwritten from its old snapshot", async () => {
    const cwdA = path.join(tmpRoot, "sa");
    const cwdB = path.join(tmpRoot, "sb");
    await fs.mkdir(taskDir(cwdA, "t-ws-a"), { recursive: true });
    await fs.mkdir(taskDir(cwdB, "t-ws-b"), { recursive: true });
    const gate = deferred();
    const fixture = makeRuntime({
      workspaces: [taskWorkspace("ws-a", cwdA), taskWorkspace("ws-b", cwdB)],
      candidates: [candidateFor("ws-a"), candidateFor("ws-b")],
      ensureSession: async (_state, sessionId) => {
        if (sessionId.startsWith("ws-a")) await gate.promise;
        return null;
      },
    });

    const slow = fixture.runtime.resolveTaskRecovery({ "ws-a": "continue" }, "win-A");
    // ws-b is settled entirely while ws-a is still mid-flight.
    await fixture.runtime.resolveTaskRecovery({ "ws-b": "skip" }, "win-B");
    expect(fixture.remainingCandidates()).toEqual(["ws-a"]);

    gate.resolve();
    await slow;

    // ws-b must NOT be back: the removal is computed from the CURRENT list,
    // not from the copy ws-a's request read before its first await.
    expect(fixture.remainingCandidates()).toEqual([]);
  });
});

describe("recovery concurrency — Dashboard Reset and Resume share the executor", () => {
  test("Reset over a recovery candidate runs the `fresh` decision, settles it and stamps once", async () => {
    const { runtime, recordWorkspaceWork, remainingCandidates, task } = await oneTask();

    const result = await runtime.resetTask("ws-task", "win-A");

    expect(result.outcomes).toEqual({ "ws-task": "fresh" });
    // The candidate is gone, so the dialog's next Retry is not refused as a
    // task that no longer needs recovering.
    expect(remainingCandidates()).toEqual([]);
    expect(recordWorkspaceWork.mock.calls).toEqual([["ws-task", "win-A"]]);
    expect(task("ws-task").state).toBe("idle");
    expect(task("ws-task").currentRound).toBe(0);
  });

  test("a Reset racing a dialog Continue is serialised, and only one of them acts", async () => {
    const gate = deferred();
    const { runtime, recordWorkspaceWork, remainingCandidates, task } = await oneTask(gate.promise);

    const dialogContinue = runtime.resolveTaskRecovery({ "ws-task": "continue" }, "win-A");
    const dashboardReset = runtime.resetTask("ws-task", "win-B");

    gate.resolve();
    const [a, b] = await Promise.all([dialogContinue, dashboardReset]);

    expect(a.outcomes).toEqual({ "ws-task": "continued" });
    expect(b.outcomes).toEqual({ "ws-task": "stale" });
    // The reset never wiped the task the Continue had just resumed.
    expect(task("ws-task").state).toBe("running");
    expect(recordWorkspaceWork.mock.calls).toEqual([["ws-task", "win-A"]]);
    expect(remainingCandidates()).toEqual([]);
  });

  test("Resume over a recovery candidate goes through the same queue", async () => {
    const gate = deferred();
    const { runtime, recordWorkspaceWork, remainingCandidates } = await oneTask(gate.promise);

    const dashboardResume = runtime.resumeTask("ws-task", "win-A");
    const dialogContinue = runtime.resolveTaskRecovery({ "ws-task": "continue" }, "win-B");

    gate.resolve();
    const [a, b] = await Promise.all([dashboardResume, dialogContinue]);

    expect(a.outcomes).toEqual({ "ws-task": "continued" });
    expect(b.outcomes).toEqual({ "ws-task": "stale" });
    // Exactly one stamp: the Dashboard wrapper's own, never doubled by the
    // internal executor it delegates to.
    expect(recordWorkspaceWork.mock.calls).toEqual([["ws-task", "win-A"]]);
    expect(remainingCandidates()).toEqual([]);
  });
});

describe("recovery concurrency — a thrown resume never produces a false state", () => {
  test("a runner that throws while the task stays paused rolls the staged prompt back", async () => {
    const { runtime, taskRunner, task } = await oneTask();
    vi.spyOn(taskRunner, "resumeTask").mockImplementation(() => {
      throw new Error("resume exploded");
    });

    const result = await runtime.resolveTaskRecovery({ "ws-task": "continue" }, "win-A");

    expect(result.outcomes).toEqual({ "ws-task": "failed" });
    // `failed` must mean exactly this: paused, unstaged and retryable.
    expect(task("ws-task").state).toBe("paused");
    expect(task("ws-task").showerResumePrompt).toBe("");
    expect(task("ws-task").promptSent).toBe(true);
  });

  test("a runner that throws AFTER committing the active state is not reported as failed", async () => {
    const { runtime, taskRunner, task, remainingCandidates } = await oneTask();
    vi.spyOn(taskRunner, "resumeTask").mockImplementation((workspaceId: string) => {
      // The runner got as far as the state transition, then failed on
      // something later. Claiming `failed / paused` here would have the dialog
      // offering a Retry for an agent that is genuinely running.
      const current = task(workspaceId);
      current.state = "running";
      current.pausedFromState = "";
      throw new Error("post-commit failure");
    });

    const result = await runtime.resolveTaskRecovery({ "ws-task": "continue" }, "win-A");

    expect(result.outcomes).toEqual({ "ws-task": "continued" });
    expect(task("ws-task").state).toBe("running");
    // The staged orientation prompt belongs to the now-running task and stays.
    expect(task("ws-task").showerResumePrompt).toContain("during round 2 of this task");
    expect(remainingCandidates()).toEqual([]);
  });
});

/**
 * V7 review, §"P2 performance/UX — jeden recovery batch blokuje nezávislá
 * workspace".
 *
 * `createRecoveryQueue()` is per-key, and two SEPARATE requests for two
 * workspaces already proved they do not wait on each other. The batch branch
 * did not: `applyTaskRecovery` walked `Object.entries(decisions)` with a
 * sequential `for ... await`, so one `Resume all` enqueued its second
 * workspace only once the first had fully settled. A hanging PTY start on the
 * first candidate stalled every other task in the dialog.
 *
 * These cases drive the batch endpoint itself, with the same deterministic
 * deferred-Promise gating: nothing here depends on a timer.
 */
describe("recovery batch — same key serialised, different keys independent", () => {
  /** Let every already-resolved chain run, without touching the timers. */
  async function flushMicrotasks(times = 50): Promise<void> {
    for (let i = 0; i < times; i += 1) await Promise.resolve();
  }

  /** N task workspaces, each with its task directory, and a per-id session gate. */
  async function tasks(ids: string[], ensureSession?: (state: AnyApi, sessionId: string) => Promise<unknown>) {
    const workspaces: AnyApi[] = [];
    for (const id of ids) {
      const cwd = path.join(tmpRoot, id);
      await fs.mkdir(taskDir(cwd, `t-${id}`), { recursive: true });
      workspaces.push(taskWorkspace(id, cwd));
    }
    return makeRuntime({
      workspaces,
      candidates: ids.map((id) => candidateFor(id)),
      ensureSession,
    });
  }

  test("one Resume all: a blocked workspace does not hold up its neighbour", async () => {
    const gate = deferred();
    const fixture = await tasks(["ws-a", "ws-b"], async (_state, sessionId) => {
      if (sessionId.startsWith("ws-a")) await gate.promise;
      return null;
    });

    // ONE request naming both — the case the sequential loop got wrong.
    const batch = fixture.runtime.resolveTaskRecovery({ "ws-a": "continue", "ws-b": "continue" }, "win-A");
    await flushMicrotasks();

    // ws-b ran to completion while ws-a is still parked on its PTY. Under the
    // sequential loop ws-b was not even enqueued yet.
    expect(fixture.task("ws-b").state).toBe("running");
    expect(fixture.task("ws-a").state).toBe("paused");
    expect(fixture.remainingCandidates()).toEqual(["ws-a"]);

    gate.resolve();
    const result = await batch;

    expect(result.outcomes).toEqual({ "ws-a": "continued", "ws-b": "continued" });
    expect(result.ok).toBe(true);
    expect(fixture.task("ws-a").state).toBe("running");
    expect(fixture.remainingCandidates()).toEqual([]);
  });

  test("the same workspace in two overlapping batches is still FIFO — one settles, one is stale", async () => {
    const gate = deferred();
    const fixture = await tasks(["ws-a", "ws-b", "ws-c"], async (_state, sessionId) => {
      if (sessionId.startsWith("ws-a")) await gate.promise;
      return null;
    });

    const first = fixture.runtime.resolveTaskRecovery({ "ws-a": "continue", "ws-b": "continue" }, "win-A");
    const second = fixture.runtime.resolveTaskRecovery({ "ws-a": "continue", "ws-c": "continue" }, "win-B");

    // Parallelism inside a batch must not weaken the per-key lock: the second
    // batch's ws-a queues behind the first batch's, and its ws-c does not.
    await flushMicrotasks();
    expect(fixture.task("ws-c").state).toBe("running");

    gate.resolve();
    const [a, b] = await Promise.all([first, second]);

    expect(a.outcomes).toEqual({ "ws-a": "continued", "ws-b": "continued" });
    expect(b.outcomes).toEqual({ "ws-a": "stale", "ws-c": "continued" });
    // Exactly one settled outcome for ws-a, so exactly one stamp for it.
    expect(fixture.recordWorkspaceWork.mock.calls).toEqual([
      ["ws-a", "win-A"],
      ["ws-b", "win-A"],
      ["ws-c", "win-B"],
    ]);
    expect(fixture.remainingCandidates()).toEqual([]);
  });

  test("a failing candidate is its own outcome and never cancels its neighbour", async () => {
    const fixture = await tasks(["ws-a", "ws-b"], async (_state, sessionId) => {
      if (sessionId.startsWith("ws-a")) throw new Error("pty spawn failed");
      return null;
    });

    const result = await fixture.runtime.resolveTaskRecovery({ "ws-a": "continue", "ws-b": "continue" }, "win-A");

    // Both are in ONE response, and the failure is local to its own id.
    expect(result.outcomes).toEqual({ "ws-a": "failed", "ws-b": "continued" });
    expect(result.ok).toBe(false);
    expect(fixture.task("ws-a").state).toBe("paused");
    expect(fixture.task("ws-b").state).toBe("running");
    // A failed candidate deliberately stays so the dialog can retry it; the
    // settled one is gone.
    expect(fixture.remainingCandidates()).toEqual(["ws-a"]);
    expect(fixture.recordWorkspaceWork.mock.calls).toEqual([["ws-b", "win-A"]]);
  });

  test("after the batch nothing is left behind: no candidates, one stamp each, no held lock", async () => {
    const fixture = await tasks(["ws-a", "ws-b"]);

    const result = await fixture.runtime.resolveTaskRecovery({ "ws-a": "continue", "ws-b": "continue" }, "win-A");
    expect(result.outcomes).toEqual({ "ws-a": "continued", "ws-b": "continued" });
    expect(fixture.remainingCandidates()).toEqual([]);
    expect(fixture.recordWorkspaceWork.mock.calls).toEqual([
      ["ws-a", "win-A"],
      ["ws-b", "win-A"],
    ]);

    // A redrive finds nothing to do — and is not wedged behind a key the
    // batch failed to release. (`recovery-queue.test.ts` pins the map itself
    // going back to empty; from out here the observable is that this second
    // request resolves at all.)
    const redrive = await fixture.runtime.resolveTaskRecovery({ "ws-a": "continue", "ws-b": "continue" }, "win-A");
    expect(redrive.outcomes).toEqual({ "ws-a": "stale", "ws-b": "stale" });
    expect(redrive.ok).toBe(true);
    // `stale` changed nothing anywhere, so it stamps nothing.
    expect(fixture.recordWorkspaceWork).toHaveBeenCalledTimes(2);
  });
});
