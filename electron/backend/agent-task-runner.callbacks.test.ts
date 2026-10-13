import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import nodeFs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { afterEach, describe, expect, test, vi } from "vitest";
import { AgentTaskRunner } from "./agent-task-runner.js";
import { HANDOFF_FILE, VERDICT_FILE, WORK_LOCK_FILE, promptFileFor, taskDir } from "./agent-task-utils.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyApi = any;

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error(`waitFor: condition did not become true within ${timeoutMs}ms`);
}

let tempDirs: string[] = [];
let runners: AgentTaskRunner[] = [];

async function makeRunner() {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "strideterm-runner-callbacks-"));
  tempDirs.push(cwd);
  const runner = new AgentTaskRunner();
  runners.push(runner);
  const workspace = runner.createTaskWorkspace({
    state: {},
    description: "Callback race task",
    cwd,
    parentWorkspaceId: "",
    maxRounds: 3,
  });
  const state = { workspaces: [workspace], activeProfileId: "default", profiles: [{ id: "default" }] };
  const written: Array<{ sessionId: string; data: string }> = [];
  const deps = {
    getState: () => state,
    writeToSession: vi.fn((sessionId: string, data: string) => written.push({ sessionId, data })),
    broadcastState: vi.fn(),
    raiseAlert: vi.fn(),
    restartSession: vi.fn(async () => {}),
    replaceSnapshot: () => {
      state.workspaces = structuredClone(state.workspaces);
      return state.workspaces[0]!;
    },
    written,
  };
  runner.init(deps as AnyApi);
  return { cwd, runner, workspace, deps };
}

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  syncBuiltinESMExports();
  for (const runner of runners) runner.dispose();
  runners = [];
  for (const dir of tempDirs) await fs.rm(dir, { recursive: true, force: true });
  tempDirs = [];
});

describe("task runner callback freshness", () => {
  test("a newer expired judge resume owns the only fallback injection", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    const { cwd, runner, workspace, deps } = await makeRunner();
    const dir = taskDir(cwd, workspace.task.taskId);
    await fs.mkdir(dir, { recursive: true });
    workspace.task.state = "judge-evaluating";
    workspace.task.currentRound = 1;
    workspace.task.rounds = [
      { round: 1, judgeVerdict: null, checks: [], action: "judge-requested" },
    ] as unknown as typeof workspace.task.rounds;

    const verdictPath = path.join(dir, VERDICT_FILE);
    const firstEntered = deferred<void>();
    const secondEntered = deferred<void>();
    const firstGate = deferred<string>();
    const secondGate = deferred<string>();
    const originalReadFile = fs.readFile.bind(fs);
    let verdictReadCount = 0;
    const readSpy = vi.spyOn(fs, "readFile").mockImplementation(((filePath: nodeFs.PathLike, ...args: unknown[]) => {
      if (String(filePath) === verdictPath) {
        verdictReadCount += 1;
        if (verdictReadCount === 1) {
          firstEntered.resolve();
          return firstGate.promise;
        }
        secondEntered.resolve();
        return secondGate.promise;
      }
      return (originalReadFile as AnyApi)(filePath, ...args);
    }) as AnyApi);
    syncBuiltinESMExports();

    const previousMargin = AgentTaskRunner.RATE_LIMIT_RESUME_MARGIN_MS;
    AgentTaskRunner.RATE_LIMIT_RESUME_MARGIN_MS = 1;
    try {
      const sessionId = `${workspace.id}:${workspace.task.judgePanelId}`;
      const expiredLimit = () =>
        runner.onAgentRateLimited(
          sessionId,
          { resetAt: new Date(Date.now() - 1000), needsConfirm: false, providerHint: "claude" },
          "expired-window",
        );
      expiredLimit();
      await vi.advanceTimersByTimeAsync(1);
      await firstEntered.promise;

      expiredLimit();
      await vi.advanceTimersByTimeAsync(1);
      await secondEntered.promise;
      firstGate.reject(Object.assign(new Error("missing"), { code: "ENOENT" }));
      secondGate.reject(Object.assign(new Error("missing"), { code: "ENOENT" }));
      await new Promise<void>((resolve) => setImmediate(resolve));
      await new Promise<void>((resolve) => setImmediate(resolve));

      const fallbackPrompts = deps.written.filter(
        (entry) => entry.sessionId === sessionId && entry.data.includes("previous attempt was rate-limited"),
      );
      expect(fallbackPrompts).toHaveLength(1);
    } finally {
      AgentTaskRunner.RATE_LIMIT_RESUME_MARGIN_MS = previousMargin;
      firstGate.reject(Object.assign(new Error("missing"), { code: "ENOENT" }));
      secondGate.reject(Object.assign(new Error("missing"), { code: "ENOENT" }));
      readSpy.mockRestore();
      syncBuiltinESMExports();
    }
  });

  test("a valid verdict from the old read still runs while a newer judge hold is pending", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    const { cwd, runner, workspace } = await makeRunner();
    const dir = taskDir(cwd, workspace.task.taskId);
    await fs.mkdir(dir, { recursive: true });
    workspace.task.state = "judge-evaluating";
    workspace.task.currentRound = 1;
    workspace.task.rounds = [
      {
        round: 1,
        startedAt: "",
        checks: [],
        judgeVerdict: null,
        judgeReason: "",
        action: "judge-requested",
      },
    ] as unknown as typeof workspace.task.rounds;
    const verdictContent = JSON.stringify({ verdict: "complete", reason: "verified" });
    const verdictPath = path.join(dir, VERDICT_FILE);
    await fs.writeFile(verdictPath, verdictContent, "utf8");

    const entered = deferred<void>();
    const gate = deferred<string>();
    const secondReadCompleted = deferred<unknown>();
    const originalReadFile = fs.readFile.bind(fs);
    let verdictReadCount = 0;
    const readSpy = vi.spyOn(fs, "readFile").mockImplementation(((filePath: nodeFs.PathLike, ...args: unknown[]) => {
      if (String(filePath) === verdictPath) {
        verdictReadCount += 1;
        if (verdictReadCount === 1) {
          entered.resolve();
          return gate.promise;
        }
        return (originalReadFile as AnyApi)(filePath, ...args)
          .then((value: unknown) => {
            secondReadCompleted.resolve(value);
            return value;
          })
          .catch((error: unknown) => {
            secondReadCompleted.reject(error);
            throw error;
          });
      }
      return (originalReadFile as AnyApi)(filePath, ...args);
    }) as AnyApi);
    syncBuiltinESMExports();

    const previousMargin = AgentTaskRunner.RATE_LIMIT_RESUME_MARGIN_MS;
    AgentTaskRunner.RATE_LIMIT_RESUME_MARGIN_MS = 1;
    try {
      const sessionId = `${workspace.id}:${workspace.task.judgePanelId}`;
      runner.onAgentRateLimited(
        sessionId,
        { resetAt: new Date(Date.now() - 1000), needsConfirm: false, providerHint: "claude" },
        "first-window",
      );
      await vi.advanceTimersByTimeAsync(1);
      await entered.promise;
      runner.onAgentRateLimited(
        sessionId,
        { resetAt: new Date(Date.now() + 60_000), needsConfirm: false, providerHint: "claude" },
        "second-window",
      );

      gate.resolve(verdictContent);
      const secondReadValue = await secondReadCompleted.promise;
      await vi.advanceTimersByTimeAsync(0);
      await Promise.resolve();
      expect(verdictReadCount).toBeGreaterThanOrEqual(2);
      expect(secondReadValue).toBe(verdictContent);
      expect(workspace.task.state).toBe("completed");
      expect(workspace.task.rounds.at(-1)?.judgeVerdict).toBe("complete");
    } finally {
      AgentTaskRunner.RATE_LIMIT_RESUME_MARGIN_MS = previousMargin;
      gate.resolve(verdictContent);
      readSpy.mockRestore();
      syncBuiltinESMExports();
    }
  });

  test.each([60_000, -1_000])(
    "an expired judge hold cannot inject after a newer rate-limit hold arrives during verdict I/O (%i ms reset)",
    async (nextResetInMs) => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
      const { cwd, runner, workspace, deps } = await makeRunner();
      const dir = taskDir(cwd, workspace.task.taskId);
      await fs.mkdir(dir, { recursive: true });
      workspace.task.state = "judge-evaluating";
      workspace.task.currentRound = 1;
      workspace.task.rounds = [
        { round: 1, judgeVerdict: null, checks: [], action: "judge-requested" },
      ] as unknown as typeof workspace.task.rounds;

      const verdictPath = path.join(dir, VERDICT_FILE);
      const entered = deferred<void>();
      const gate = deferred<string>();
      const originalReadFile = fs.readFile.bind(fs);
      const readSpy = vi.spyOn(fs, "readFile").mockImplementation(((filePath: nodeFs.PathLike, ...args: unknown[]) => {
        if (String(filePath) === verdictPath) {
          entered.resolve();
          return gate.promise;
        }
        return (originalReadFile as AnyApi)(filePath, ...args);
      }) as AnyApi);
      syncBuiltinESMExports();

      const previousMargin = AgentTaskRunner.RATE_LIMIT_RESUME_MARGIN_MS;
      AgentTaskRunner.RATE_LIMIT_RESUME_MARGIN_MS = 1;
      try {
        const sessionId = `${workspace.id}:${workspace.task.judgePanelId}`;
        runner.onAgentRateLimited(
          sessionId,
          { resetAt: new Date(Date.now() - 1000), needsConfirm: false, providerHint: "claude" },
          "first-window",
        );
        await vi.advanceTimersByTimeAsync(1);
        await entered.promise;

        runner.onAgentRateLimited(
          sessionId,
          { resetAt: new Date(Date.now() + nextResetInMs), needsConfirm: false, providerHint: "claude" },
          "second-window",
        );
        gate.reject(Object.assign(new Error("missing"), { code: "ENOENT" }));
        await new Promise<void>((resolve) => setImmediate(resolve));

        expect(workspace.task.state).toBe("judge-evaluating");
        expect(deps.writeToSession).not.toHaveBeenCalled();
      } finally {
        AgentTaskRunner.RATE_LIMIT_RESUME_MARGIN_MS = previousMargin;
        gate.reject(Object.assign(new Error("missing"), { code: "ENOENT" }));
        readSpy.mockRestore();
        syncBuiltinESMExports();
      }
    },
  );

  test("judge rate-limit read cannot inject into a task paused while verdict I/O is pending", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    const { cwd, runner, workspace, deps } = await makeRunner();
    const dir = taskDir(cwd, workspace.task.taskId);
    await fs.mkdir(dir, { recursive: true });
    workspace.task.state = "judge-evaluating";
    workspace.task.currentRound = 1;
    workspace.task.rounds = [
      { round: 1, judgeVerdict: null, checks: [], action: "judge-requested" },
    ] as unknown as typeof workspace.task.rounds;

    const verdictPath = path.join(dir, VERDICT_FILE);
    const entered = deferred<void>();
    const gate = deferred<string>();
    const originalReadFile = fs.readFile.bind(fs);
    const readSpy = vi.spyOn(fs, "readFile").mockImplementation(((filePath: nodeFs.PathLike, ...args: unknown[]) => {
      if (String(filePath) === verdictPath) {
        entered.resolve();
        return gate.promise;
      }
      return (originalReadFile as AnyApi)(filePath, ...args);
    }) as AnyApi);
    syncBuiltinESMExports();

    const previousMargin = AgentTaskRunner.RATE_LIMIT_RESUME_MARGIN_MS;
    AgentTaskRunner.RATE_LIMIT_RESUME_MARGIN_MS = 1;
    try {
      runner.onAgentRateLimited(
        `${workspace.id}:${workspace.task.judgePanelId}`,
        { resetAt: new Date(Date.now() - 1000), needsConfirm: false, providerHint: "claude" },
        "callback-race-test",
      );
      await vi.advanceTimersByTimeAsync(1);
      await entered.promise;

      expect(runner.pauseTask(workspace.id)).toBe(true);
      gate.reject(Object.assign(new Error("missing"), { code: "ENOENT" }));
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(workspace.task.state).toBe("paused");
      expect(deps.writeToSession).not.toHaveBeenCalled();
    } finally {
      AgentTaskRunner.RATE_LIMIT_RESUME_MARGIN_MS = previousMargin;
      readSpy.mockRestore();
      syncBuiltinESMExports();
    }
  });

  test.each(["snapshot-clone", "replacement-task", "replacement-binding"] as const)(
    "long prompt write is clone-safe and rejects stale task ownership (%s)",
    async (replacement) => {
      const { cwd, runner, workspace, deps } = await makeRunner();
      const dir = taskDir(cwd, workspace.task.taskId);
      await fs.mkdir(dir, { recursive: true });
      workspace.task.description = "A long task description. ".repeat(80);
      workspace.task.state = "paused";
      workspace.task.pausedFromState = "running";
      workspace.task.promptSent = false;

      const entered = deferred<void>();
      const gate = deferred<void>();
      const promptPath = path.join(dir, promptFileFor("worker"));
      const originalWriteFile = fs.writeFile.bind(fs);
      const writeSpy = vi.spyOn(fs, "writeFile").mockImplementation(((
        filePath: nodeFs.PathLike,
        ...args: unknown[]
      ) => {
        if (String(filePath) === promptPath) {
          entered.resolve();
          return gate.promise;
        }
        return (originalWriteFile as AnyApi)(filePath, ...args);
      }) as AnyApi);
      syncBuiltinESMExports();
      try {
        expect(runner.resumeTask(workspace.id)).toBe(true);
        await entered.promise;
        const current = deps.replaceSnapshot();
        if (replacement === "replacement-task") current.task.taskId = "replacement-task";
        if (replacement === "replacement-binding") current.task.workerPanelId = "replacement-worker";
        gate.resolve();

        if (replacement === "snapshot-clone") {
          await waitFor(() => deps.writeToSession.mock.calls.length > 0);
          expect(deps.writeToSession).toHaveBeenCalledWith(
            `${workspace.id}:${workspace.task.workerPanelId}`,
            expect.stringContaining("Read .strideterm/"),
            expect.anything(),
          );
        } else {
          await new Promise<void>((resolve) => setImmediate(resolve));
          await new Promise<void>((resolve) => setImmediate(resolve));
          expect(deps.writeToSession).not.toHaveBeenCalled();
        }
      } finally {
        gate.resolve();
        writeSpy.mockRestore();
        syncBuiltinESMExports();
      }
    },
  );

  test.each(["before-message", "before-enter"] as const)(
    "a terminal task's delayed stop message and Enter are suppressed after resume (%s)",
    async (resumeAt) => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const { cwd, runner, workspace, deps } = await makeRunner();
      const dir = taskDir(cwd, workspace.task.taskId);
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, VERDICT_FILE), JSON.stringify({ verdict: "complete", reason: "Approved" }));
      await fs.writeFile(path.join(dir, WORK_LOCK_FILE), "work remains", "utf8");
      workspace.task.state = "judge-evaluating";
      workspace.task.promptSent = true;
      workspace.task.currentRound = 1;
      workspace.task.rounds = [
        { round: 1, startedAt: "", checks: [], judgeVerdict: null, judgeReason: "", action: "judge-requested" },
      ] as unknown as typeof workspace.task.rounds;

      runner.onAgentIdle(`${workspace.id}:${workspace.task.judgePanelId}`, "hook:stop");
      await waitFor(() => workspace.task.state === "completed");
      expect(deps.writeToSession.mock.calls.some(([, value]) => value === "\x03")).toBe(true);
      deps.written.length = 0;
      deps.writeToSession.mockClear();

      if (resumeAt === "before-enter") {
        await vi.advanceTimersByTimeAsync(2_000);
        expect(deps.writeToSession).toHaveBeenCalledTimes(1);
        deps.writeToSession.mockClear();
        deps.written.length = 0;
        expect(runner.resumeTask(workspace.id)).toBe(true);
        await vi.advanceTimersByTimeAsync(200);
      } else {
        expect(runner.resumeTask(workspace.id)).toBe(true);
        await vi.advanceTimersByTimeAsync(2_200);
      }

      expect(deps.writeToSession).not.toHaveBeenCalled();
    },
  );

  test.each(["pause", "dispose"] as const)("pending watcher access does not register after %s", async (action) => {
    const { cwd, runner, workspace } = await makeRunner();
    const dir = taskDir(cwd, workspace.task.taskId);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, WORK_LOCK_FILE), "work remains", "utf8");
    workspace.task.state = "paused";
    workspace.task.pausedFromState = "running";
    workspace.task.promptSent = true;

    const entered = deferred<void>();
    const gate = deferred<void>();
    const originalAccess = fs.access.bind(fs);
    const accessSpy = vi.spyOn(fs, "access").mockImplementation(((target: nodeFs.PathLike, ...args: unknown[]) => {
      if (String(target) === dir) {
        entered.resolve();
        return gate.promise;
      }
      return (originalAccess as AnyApi)(target, ...args);
    }) as AnyApi);
    const watchSpy = vi.spyOn(nodeFs, "watch");
    syncBuiltinESMExports();
    try {
      expect(runner.resumeTask(workspace.id)).toBe(true);
      await entered.promise;
      if (action === "pause") expect(runner.pauseTask(workspace.id)).toBe(true);
      else runner.dispose();
      gate.resolve();
      await new Promise<void>((resolve) => setImmediate(resolve));
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(watchSpy).not.toHaveBeenCalled();
    } finally {
      accessSpy.mockRestore();
      watchSpy.mockRestore();
      syncBuiltinESMExports();
    }
  });

  test("shower commits into a replacement snapshot but abandons a paused lifecycle", async () => {
    const { cwd, runner, workspace, deps } = await makeRunner();
    const dir = taskDir(cwd, workspace.task.taskId);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, WORK_LOCK_FILE), "work remains", "utf8");
    await fs.writeFile(path.join(dir, HANDOFF_FILE), "Progress so far.", "utf8");
    workspace.task.state = "running";
    workspace.task.promptSent = true;
    workspace.task.currentRound = 1;
    workspace.task.showerInterval = 1;
    workspace.task.lastShowerRound = 0;

    const restart = deferred<void>();
    let restartStarted!: () => void;
    const started = new Promise<void>((resolve) => (restartStarted = resolve));
    deps.restartSession.mockImplementation(async () => {
      restartStarted();
      await restart.promise;
    });

    runner.onAgentIdle(`${workspace.id}:${workspace.task.workerPanelId}`, "hook:stop");
    await started;
    const replacementSnapshot = deps.replaceSnapshot();
    restart.resolve();
    await waitFor(() => replacementSnapshot.task.lastShowerRound === 1);
    expect(replacementSnapshot.task.showerResumePrompt).toContain("Progress so far.");

    const secondRestart = deferred<void>();
    let secondRestartStarted!: () => void;
    const secondStarted = new Promise<void>((resolve) => (secondRestartStarted = resolve));
    deps.restartSession.mockImplementation(async () => {
      secondRestartStarted();
      await secondRestart.promise;
    });
    replacementSnapshot.task.state = "running";
    replacementSnapshot.task.promptSent = true;
    replacementSnapshot.task.currentRound = 2;
    replacementSnapshot.task.showerInterval = 1;
    replacementSnapshot.task.lastShowerRound = 1;
    await fs.writeFile(path.join(dir, HANDOFF_FILE), "Second handoff.", "utf8");

    runner.onAgentIdle(`${replacementSnapshot.id}:${replacementSnapshot.task.workerPanelId}`, "hook:stop");
    await secondStarted;
    expect(runner.pauseTask(replacementSnapshot.id)).toBe(true);
    secondRestart.resolve();
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(replacementSnapshot.task.state).toBe("paused");
    expect(replacementSnapshot.task.lastShowerRound).toBe(1);
    expect(replacementSnapshot.task.showerResumePrompt).toContain("Progress so far.");
  });
});
