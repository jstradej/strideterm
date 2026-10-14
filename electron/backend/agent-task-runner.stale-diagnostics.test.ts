/**
 * What strideterm.log says when an async task-runner step refuses to continue.
 *
 * Every await in the runner re-checks the task's identity and stops the step
 * when anything moved. Most refusals are expected (the user paused, the task
 * finished) and stay at debug. A refusal nothing explains — e.g. the user typed
 * into the Judge while an evaluation was running — leaves the task where it was
 * with nothing left to drive it, and must reach the log at warn, saying which
 * check failed. Driven through the REAL runner and the REAL store; the task is
 * started with startTask and advanced by the runner's own hooks and input path.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { syncBuiltinESMExports } from "node:module";
import { afterEach, describe, expect, test, vi } from "vitest";
import { AgentTaskRunner, sessionIdFor } from "./agent-task-runner.js";
import { createStore } from "./store.js";
import { TODO_FILE, WORK_LOCK_FILE, taskDir } from "./agent-task-utils.js";
import type { Logger } from "./logger.js";
import type { WorkspaceState } from "../shared/types/state.js";

type LogCall = { level: string; label: string; message: string; meta?: Record<string, unknown> };
const logCalls = vi.hoisted(() => [] as LogCall[]);
// Records every call and still forwards it to the real logger.
vi.mock("./logger.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./logger.js")>();
  return {
    ...actual,
    getLogger: (label: string): Logger => {
      const real = actual.getLogger(label);
      const capture =
        (level: string, forward: Logger["info"]): Logger["info"] =>
        (message, meta) => {
          logCalls.push({ level, label, message, meta });
          forward(message, meta);
        };
      return {
        error: capture("error", real.error),
        warn: capture("warn", real.warn),
        info: capture("info", real.info),
        debug: capture("debug", real.debug),
        trace: capture("trace", real.trace),
      };
    },
  };
});

const STALE = "task operation rejected as stale";
const STALE_UNEXPLAINED = "task operation rejected as stale without a lifecycle change";
/** Part of the task description, so it is in every prompt the runner builds. */
const PROMPT_MARKER = "PROMPT-TEXT-MARKER-7f3a";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Meta = Record<string, any>;

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
  logCalls.length = 0;
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => (resolve = done));
  return { promise, resolve };
}

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for the task runner");
}

/** Refusal lines (stale operation or cancelled injection) for one workspace. */
function refusals(workspaceId: string): LogCall[] {
  return logCalls.filter(
    (call) => call.label === "task-runner" && call.message.startsWith(STALE) && call.meta?.workspaceId === workspaceId,
  );
}

/** Hold the first read of `filePath` until released — pins the step on an await. */
function holdRead(filePath: string) {
  const entered = deferred();
  const release = deferred();
  const originalReadFile = fs.readFile.bind(fs);
  const spy = vi.spyOn(fs, "readFile").mockImplementation((async (
    ...[file, options]: Parameters<typeof fs.readFile>
  ) => {
    if (String(file) === filePath) {
      entered.resolve();
      await release.promise;
    }
    return originalReadFile(file, options);
  }) as typeof fs.readFile);
  syncBuiltinESMExports();
  cleanups.push(async () => {
    release.resolve();
    spy.mockRestore();
    syncBuiltinESMExports();
  });
  return { entered: entered.promise, release: release.resolve };
}

/** A standard task started the way the UI starts one, its Worker prompt sent. */
async function startedTask() {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "strideterm-stale-diagnostics-"));
  cleanups.push(() => fs.rm(cwd, { recursive: true, force: true }));
  await fs.mkdir(path.join(cwd, ".git"), { recursive: true });
  const builder = new AgentTaskRunner();
  const created = builder.createTaskWorkspace({
    state: {},
    description: `Implement the parser. ${PROMPT_MARKER}`,
    cwd,
    parentWorkspaceId: "",
    maxRounds: 3,
  });
  await builder.writeInitialFiles(cwd, created.task);

  const store = await createStore(path.join(cwd, `.state-${randomUUID()}.json`));
  await store.mutate((draft) => {
    draft.workspaces.push(created as unknown as WorkspaceState);
  });
  const written: Array<{ sessionId: string; data: string }> = [];
  const runner = new AgentTaskRunner();
  runner.init({
    writeToSession: vi.fn((sessionId: string, data: string) => {
      written.push({ sessionId, data });
    }),
    getState: () => store.getState(),
    broadcastState: vi.fn(),
    raiseAlert: vi.fn(),
    restartSession: vi.fn(async () => {}),
    isSessionBusy: () => false,
    isSessionHookCapable: () => false,
    isAgentDroppedToShell: () => false,
  });
  cleanups.push(async () => {
    runner.dispose();
    await store.flush();
  });

  const workspaceId = created.id;
  const live = () => store.getState().workspaces.find((ws) => ws.id === workspaceId) as unknown as typeof created;
  expect(await runner.startTask(workspaceId)).toBe(true);
  expect(live().task).toMatchObject({ state: "running", promptSent: true });
  return {
    runner,
    written,
    live,
    workspaceId,
    taskId: created.task.taskId,
    dir: taskDir(cwd, created.task.taskId),
    workerSessionId: sessionIdFor(live(), "worker"),
    judgeSessionId: sessionIdFor(live(), "judge"),
  };
}

describe("task-runner stale-operation diagnostics", () => {
  test("a step stopped by Pause is explained by the lifecycle and logs at debug, not warn", async () => {
    const task = await startedTask();
    const todoRead = holdRead(path.join(task.dir, TODO_FILE));

    expect(task.runner.onAgentIdle(task.workerSessionId, "hook:stop")).toBe(true);
    await todoRead.entered; // the evaluation sits in its built-in checks
    expect(task.live().task.state).toBe("evaluating");
    expect(task.runner.pauseTask(task.workspaceId)).toBe(true);
    todoRead.release();
    await waitFor(() =>
      refusals(task.workspaceId).some((call) => call.meta?.operation === "standard-worker-evaluation"),
    );

    const line = refusals(task.workspaceId).find((call) => call.meta?.operation === "standard-worker-evaluation")!;
    expect(line.level).toBe("debug");
    expect(line.message).toBe(STALE);
    const meta = line.meta as Meta;
    expect(meta).toMatchObject({
      taskId: task.taskId,
      mode: "standard",
      state: "paused",
      pausedFromState: "evaluating",
      expectedStates: ["evaluating"],
    });
    expect(meta.explainedBy).toContain("lifecycleEpoch");
    expect(meta.lifecycleEpoch.current).toBe(meta.lifecycleEpoch.expected + 1);
    expect(meta.failedChecks).toEqual(
      expect.arrayContaining([
        { check: "lifecycleEpoch", expected: meta.lifecycleEpoch.expected, actual: meta.lifecycleEpoch.current },
        { check: "state", expected: ["evaluating"], actual: "paused" },
      ]),
    );
    expect(
      logCalls.filter(
        (call) =>
          call.level === "warn" && call.message.startsWith(STALE) && call.meta?.workspaceId === task.workspaceId,
      ),
    ).toEqual([]);
  });

  test("input into the Judge during evaluating is no refusal at all: the evaluation carries on", async () => {
    const task = await startedTask();
    await fs.rm(path.join(task.dir, WORK_LOCK_FILE), { force: true });
    const todoRead = holdRead(path.join(task.dir, TODO_FILE));

    task.runner.onAgentIdle(task.workerSessionId, "hook:stop");
    await todoRead.entered;
    expect(task.live().task.state).toBe("evaluating");
    // The runtime's terminal-input path: the user typed into the Judge panel.
    for (const key of "hello") task.runner.onUserInput(task.judgeSessionId, key);
    todoRead.release();
    // The evaluation reaches the Judge and only waits for the user to finish.
    await waitFor(() =>
      logCalls.some(
        (call) =>
          call.message === "task injection deferred: the user is active in the session" &&
          call.meta?.sessionId === task.judgeSessionId,
      ),
    );

    expect(task.live().task.state).toBe("evaluating");
    expect(refusals(task.workspaceId)).toEqual([]);
  });

  test("a respawned Judge PTY during evaluating stops the evaluation and warns with the session check", async () => {
    const task = await startedTask();
    const todoRead = holdRead(path.join(task.dir, TODO_FILE));

    task.runner.onAgentIdle(task.workerSessionId, "hook:stop");
    await todoRead.entered;
    expect(task.live().task.state).toBe("evaluating");
    // What the runtime calls when the Judge's process is replaced (respawn,
    // restart, retired panel) — the one thing that still crosses a session's
    // incarnation now that typing does not.
    task.runner.cancelPendingInput(task.judgeSessionId);
    expect(task.live().task.state).toBe("evaluating");
    todoRead.release();
    await waitFor(() => refusals(task.workspaceId).length > 0);

    const [line] = refusals(task.workspaceId);
    expect(line.level).toBe("warn");
    expect(line.message).toBe(STALE_UNEXPLAINED);
    const meta = line.meta as Meta;
    expect(meta).toMatchObject({
      operation: "standard-worker-evaluation",
      workspaceId: task.workspaceId,
      taskId: task.taskId,
      mode: "standard",
      state: "evaluating",
      pausedFromState: null,
      expectedStates: ["evaluating"],
      round: { checked: true, expected: 1, current: 1 },
      explainedBy: [],
    });
    expect(meta.operationId).toEqual(expect.any(Number));
    expect(meta.ageMs).toEqual(expect.any(Number));
    expect(meta.lifecycleEpoch.current).toBe(meta.lifecycleEpoch.expected);
    expect(meta.failedChecks).toEqual([
      { check: "sessionIncarnation", expected: 0, actual: 1, sessionId: task.judgeSessionId, role: "judge" },
    ]);
    expect(meta.sessions).toEqual(
      expect.arrayContaining([
        { sessionId: task.judgeSessionId, role: "judge", expectedIncarnation: 0, currentIncarnation: 1 },
        { sessionId: task.workerSessionId, role: "worker", expectedIncarnation: 0, currentIncarnation: 0 },
      ]),
    );
  });

  test("a respawned Judge PTY while the runner clears it warns on the cancelled injection, without prompt text", async () => {
    const task = await startedTask();
    // The Worker finishes the protocol way, so the evaluation goes on to the Judge.
    await fs.rm(path.join(task.dir, WORK_LOCK_FILE), { force: true });

    task.runner.onAgentIdle(task.workerSessionId, "hook:stop");
    const clearIndex = () =>
      task.written.findIndex((entry) => entry.sessionId === task.judgeSessionId && entry.data === "/clear");
    // "/clear" is submitted and the runner waits for it to settle before the
    // Judge prompt — the step's only await is that delay now.
    await waitFor(() =>
      task.written.some(
        (entry, index) =>
          clearIndex() >= 0 && index > clearIndex() && entry.sessionId === task.judgeSessionId && entry.data === "\r",
      ),
    );
    task.runner.cancelPendingInput(task.judgeSessionId);
    await waitFor(() => refusals(task.workspaceId).length > 0);

    const [line] = refusals(task.workspaceId);
    expect(line.level).toBe("warn");
    expect(line.message).toBe(STALE_UNEXPLAINED);
    const meta = line.meta as Meta;
    expect(meta).toMatchObject({
      operation: `session-injection:${task.judgeSessionId}`,
      state: "evaluating",
      expectedStates: ["evaluating"],
      explainedBy: [],
    });
    expect(meta.failedChecks).toEqual(
      expect.arrayContaining([
        { check: "sessionIncarnation", expected: 0, actual: 1, sessionId: task.judgeSessionId, role: "judge" },
        { check: "injection", expected: "current", actual: "session-reset" },
      ]),
    );
    // Ids, states and counters only — never what was (or would be) typed.
    for (const call of refusals(task.workspaceId)) {
      expect(JSON.stringify(call.meta)).not.toContain(PROMPT_MARKER);
      expect(JSON.stringify(call.meta)).not.toContain("Implement the parser");
    }
  });
});
