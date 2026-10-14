/**
 * The deferred recovery idle nudge must be judged against the state the
 * resume actually COMMITTED, not one derived from the role.
 *
 * An attached task paused mid-capture is a startup recovery candidate
 * (`#reconcileOnStartup` sweeps `capturing-context`), its role is "worker",
 * and `resumeTask` restores it to `capturing-context`. The nudge used to
 * expect `running` for every worker, so it was always dropped as stale:
 * the dialog reported `continued` while nothing re-checked capture readiness
 * and the Primary sat idle.
 *
 * Driven end to end through the REAL store, runner and handlers — the
 * candidate comes from the runner's own startup sweep, not a fixture, so the
 * test sees the same task shape production does.
 */
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { describe, expect, test, vi, afterEach } from "vitest";
import { AgentTaskRunner } from "./agent-task-runner.js";
import { taskDir } from "./agent-task-utils.js";
import { createTaskHandlers } from "./runtime-task-handlers.js";
import { createStore } from "./store.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyApi = any;

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  vi.clearAllTimers();
  vi.useRealTimers();
  while (cleanups.length) await cleanups.pop()!();
});

/** An attached task that was capturing context when the app last closed. */
async function capturingAttachedTask() {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "strideterm-recovery-nudge-"));
  const cwd = path.join(tmpRoot, "repo");
  await fs.mkdir(taskDir(cwd, "t-attached"), { recursive: true });

  const store = await createStore(path.join(tmpRoot, "state.json"));
  const initial: AnyApi = structuredClone(store.getState());
  initial.workspaces.push(
    {
      id: "ws-src",
      name: "Source",
      cwd,
      profileId: "default",
      panels: [{ id: "panel-primary", title: "Primary", command: "claude" }],
    },
    {
      id: "ws-task",
      name: "Companion",
      kind: "task",
      cwd,
      profileId: "default",
      panels: [{ id: "panel-judge", title: "Companion", command: "claude" }],
      task: {
        taskId: "t-attached",
        mode: "attached",
        workerWorkspaceId: "ws-src",
        workerPanelId: "panel-primary",
        judgePanelId: "panel-judge",
        companionRole: "reviewer",
        state: "capturing-context",
        promptSent: true,
        currentRound: 1,
        maxRounds: 5,
        rounds: [],
      },
    },
  );
  await store.replace(initial);

  const writeToSession = vi.fn();
  const taskRunner = new AgentTaskRunner();
  taskRunner.init({
    writeToSession,
    getState: () => store.getState(),
    broadcastState: vi.fn(),
    raiseAlert: vi.fn(),
    restartSession: vi.fn(async () => {}),
  } as AnyApi);

  let recoveryCandidates = taskRunner.getStartupRecoveryCandidates();
  const handlers: AnyApi = createTaskHandlers({
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn() } as AnyApi,
    getState: () => store.getState(),
    getPayload: () => ({}),
    broadcastState: vi.fn(),
    store,
    taskRunner,
    sessions: { hasSession: vi.fn(() => true), ensureSession: vi.fn(async () => null) },
    execFileTextImpl: vi.fn(async () => ({ stdout: "", stderr: "" })),
    recheckClaudeAvailability: vi.fn(async () => true),
    assertWorkspaceInViewerProfile: vi.fn(),
    recordWorkspaceWork: vi.fn(async () => {}),
    resolveCallerProfileId: vi.fn(() => "default"),
    assertNoConflictingActiveTask: vi.fn(),
    worktreeTreePath: vi.fn(() => ""),
    ensureWorktree: vi.fn(async () => ""),
    getRecoveryCandidates: () => recoveryCandidates,
    setRecoveryCandidates: (next: AnyApi[]) => {
      recoveryCandidates = next;
    },
    finalizeWorkspaceRemoval: vi.fn(async () => {}),
  } as AnyApi);

  cleanups.push(async () => {
    taskRunner.dispose();
    await store.flush();
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  const onAgentIdle = vi.spyOn(taskRunner, "onAgentIdle");
  const task = () => store.getState().workspaces.find((ws) => ws.id === "ws-task")!.task as AnyApi;
  return { handlers, taskRunner, onAgentIdle, writeToSession, task, candidates: () => recoveryCandidates };
}

describe("deferred recovery idle nudge — expected state is the committed resume state", () => {
  test("an attached task recovered into capturing-context gets its nudge and re-checks capture", async () => {
    const { handlers, onAgentIdle, writeToSession, task, candidates } = await capturingAttachedTask();
    expect(candidates().map((c: AnyApi) => [c.workspaceId, c.previousState])).toEqual([
      ["ws-task", "capturing-context"],
    ]);

    vi.useFakeTimers();
    const result = await handlers.resolveTaskRecovery({ "ws-task": "continue" }, "win");
    expect(result.outcomes).toEqual({ "ws-task": "continued" });
    expect(task().state).toBe("capturing-context");

    await vi.advanceTimersByTimeAsync(5_000);

    expect(onAgentIdle).toHaveBeenCalledWith("ws-src:panel-primary", "recovery-deferred");
    await vi.waitFor(() =>
      expect(
        writeToSession.mock.calls.some(
          ([sessionId, data]) =>
            sessionId === "ws-src:panel-primary" && String(data).includes("capture is not complete"),
        ),
      ).toBe(true),
    );
  });

  test("the capturing-context nudge is still dropped once the task moved on", async () => {
    const { handlers, taskRunner, onAgentIdle, task } = await capturingAttachedTask();

    vi.useFakeTimers();
    const result = await handlers.resolveTaskRecovery({ "ws-task": "continue" }, "win");
    expect(result.outcomes).toEqual({ "ws-task": "continued" });

    expect(taskRunner.pauseTask("ws-task")).toBe(true);
    await vi.advanceTimersByTimeAsync(5_000);

    expect(task().state).toBe("paused");
    expect(onAgentIdle).not.toHaveBeenCalledWith("ws-src:panel-primary", "recovery-deferred");
  });
});
