import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { syncBuiltinESMExports } from "node:module";
import { describe, expect, test, vi } from "vitest";
import { AgentTaskRunner, sessionIdFor } from "./agent-task-runner.js";
import { createStore } from "./store.js";
import { CodexProvider } from "./providers/codex-provider.js";
import { CONTEXT_FILE, HANDOFF_FILE, taskDir, WORK_LOCK_FILE } from "./agent-task-utils.js";
import type { WorkspaceState } from "../shared/types/state.js";

type TestStore = Awaited<ReturnType<typeof createStore>>;
type CreatedTaskWorkspace = ReturnType<AgentTaskRunner["createTaskWorkspace"]>;
type TestTaskWorkspace = CreatedTaskWorkspace;
type TestRound = { round: number; action?: string; judgeVerdict?: string; [key: string]: unknown };
type TestRunnerDeps = Parameters<AgentTaskRunner["init"]>[0];

function deferred<T = void>() {
  let resolve!: (_value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for task-runner continuation");
}

function taskWorkspace(getState: TestRunnerDeps["getState"], workspaceId: string): TestTaskWorkspace {
  const workspace = getState()?.workspaces.find((candidate) => candidate.id === workspaceId);
  if (!workspace?.task) throw new Error(`Task workspace not found: ${workspaceId}`);
  return workspace as unknown as TestTaskWorkspace;
}

function testRound(
  round: number,
  action: string,
  extras: Partial<TestRound> = {},
): TestTaskWorkspace["task"]["rounds"][number] {
  return { round, action, ...extras } as unknown as TestTaskWorkspace["task"]["rounds"][number];
}

function roundAction(workspace: TestTaskWorkspace, index = -1): string | undefined {
  return (workspace.task.rounds as unknown as TestRound[]).at(index)?.action;
}

async function setupStoreRunner(workspaces: WorkspaceState[], { hookCapable = false } = {}) {
  const statePath = path.join(workspaces[0].cwd, `.state-${randomUUID()}.json`);
  const store = await createStore(statePath);
  await store.mutate((draft) => {
    draft.workspaces.push(...workspaces);
  });
  const written: Array<{ sessionId: string; data: string }> = [];
  const deps = {
    writeToSession: vi.fn((sessionId: string, data: string) => {
      written.push({ sessionId, data });
    }),
    getState: () => store.getState(),
    broadcastState: vi.fn(),
    raiseAlert: vi.fn(),
    restartSession: vi.fn(async () => {}),
    isSessionBusy: vi.fn(() => false),
    isSessionHookCapable: vi.fn(() => hookCapable),
    isAgentDroppedToShell: vi.fn(() => false),
    written,
    store,
  };
  const runner = new AgentTaskRunner();
  runner.init(deps);
  return { runner, deps, store };
}

async function replaceStoreRoot(store: TestStore): Promise<void> {
  await store.mutate(() => {});
}

function standardWorkspace(runner: AgentTaskRunner, cwd: string, description = "Lifecycle test") {
  return runner.createTaskWorkspace({
    state: {},
    description,
    cwd,
    parentWorkspaceId: "",
    maxRounds: 3,
  });
}

function sourceWorkspace(cwd: string): WorkspaceState {
  return {
    id: "source",
    name: "Source",
    icon: "",
    color: "#123456",
    kind: "manual",
    source: "manual",
    pluginId: "",
    cwd,
    gitRoots: [],
    activeRootPath: "",
    notes: "",
    profileId: "default",
    connectionId: "",
    activePanelId: "primary",
    activeViewId: null,
    splitLayout: null,
    splitViewIds: [],
    starred: false,
    review: null,
    quickfix: null,
    panels: [{ id: "primary", title: "Primary", command: "claude", shell: "true", cwd }],
    task: null,
  };
}

describe("AgentTaskRunner lifecycle freshness", () => {
  test("start continues on the current task after provider setup crosses a normalized store mutation", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "strideterm-lifecycle-start-"));
    const releaseBeforeStart = deferred();
    let beforeStartEntered = false;
    let startResult: boolean | undefined;
    const beforeStart = vi.spyOn(CodexProvider.prototype, "beforeStart").mockImplementation(async () => {
      beforeStartEntered = true;
      await releaseBeforeStart.promise;
    });
    let liveRunner: AgentTaskRunner | undefined;
    try {
      await fs.mkdir(path.join(cwd, ".git"), { recursive: true });
      const runner = new AgentTaskRunner();
      const workspace = standardWorkspace(runner, cwd, "Start lifecycle");
      workspace.task.workerProviderConfig = { providerId: "codex", model: "gpt-5.5" };
      workspace.task.judgeProviderConfig = { providerId: "codex", model: "gpt-5.5" };
      await runner.writeInitialFiles(cwd, workspace.task);
      const runtime = await setupStoreRunner([workspace]);
      liveRunner = runtime.runner;
      const live = () => taskWorkspace(runtime.deps.getState, workspace.id);
      expect(live()).toMatchObject({ kind: "task", task: { state: "idle" } });

      const starting = liveRunner.startTask(workspace.id);
      void starting.then((result) => {
        startResult = result;
      });
      await waitFor(() => beforeStartEntered || startResult !== undefined);
      expect(startResult).toBeUndefined();
      expect(beforeStartEntered).toBe(true);
      await replaceStoreRoot(runtime.store);
      releaseBeforeStart.resolve();
      expect(await starting).toBe(true);

      expect(live().task.state).toBe("running");
      expect(live().task.promptSent).toBe(true);
    } finally {
      releaseBeforeStart.resolve();
      liveRunner?.dispose();
      beforeStart.mockRestore();
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });

  test("standard resume finalizes on the current task across a normalized store mutation", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "strideterm-lifecycle-resume-"));
    let liveRunner: AgentTaskRunner | undefined;
    try {
      const builder = new AgentTaskRunner();
      const original = standardWorkspace(builder, cwd);
      await builder.writeInitialFiles(cwd, original.task);
      original.task.state = "paused";
      original.task.pausedFromState = "running";
      original.task.promptSent = false;
      const { runner: activeRunner, deps, store } = await setupStoreRunner([original], { hookCapable: true });
      liveRunner = activeRunner;
      const workspaceId = original.id;
      const liveBefore = () => taskWorkspace(deps.getState, workspaceId);
      const oldTask = liveBefore().task;
      let rootWasReplaced = false;
      let replacement: Promise<void> | undefined;
      let didInject = false;
      deps.writeToSession.mockImplementation((sessionId: string, data: string) => {
        deps.written.push({ sessionId, data });
        if (sessionId === sessionIdFor(liveBefore(), "worker") && data !== "\r" && !replacement) {
          didInject = true;
          replacement = replaceStoreRoot(store).then(() => {
            rootWasReplaced = true;
          });
        }
      });

      expect(activeRunner.resumeTask(workspaceId)).toBe(true);
      await waitFor(() => didInject);
      await waitFor(() => rootWasReplaced);
      expect(liveBefore().task).not.toBe(oldTask);
      activeRunner.onUserPromptSubmit(sessionIdFor(liveBefore(), "worker"));
      await replacement;
      await waitFor(() => oldTask.promptSent || liveBefore().task.promptSent === true);

      expect(liveBefore().task.state).toBe("running");
      expect(liveBefore().task.promptSent).toBe(true);
      expect(
        deps.written.filter((entry) => entry.sessionId === sessionIdFor(liveBefore(), "worker") && entry.data !== "\r"),
      ).toHaveLength(1);
    } finally {
      liveRunner?.dispose();
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });

  test("standard resume cancellation after a normalized store mutation remains paused", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "strideterm-lifecycle-resume-pause-"));
    let activeRunner: AgentTaskRunner | undefined;
    try {
      const runner = new AgentTaskRunner();
      const original = standardWorkspace(runner, cwd);
      await runner.writeInitialFiles(cwd, original.task);
      original.task.state = "paused";
      original.task.pausedFromState = "running";
      original.task.promptSent = false;
      const { runner: liveRunner, deps, store } = await setupStoreRunner([original], { hookCapable: true });
      activeRunner = liveRunner;
      const workspaceId = original.id;
      const live = () => taskWorkspace(deps.getState, workspaceId);
      let rootWasReplaced = false;
      let replacement: Promise<void> | undefined;
      let didInject = false;
      deps.writeToSession.mockImplementation((sessionId: string, data: string) => {
        deps.written.push({ sessionId, data });
        if (sessionId === sessionIdFor(live(), "worker") && data !== "\r" && !replacement) {
          didInject = true;
          replacement = replaceStoreRoot(store).then(() => {
            rootWasReplaced = true;
          });
        }
      });

      expect(liveRunner.resumeTask(workspaceId)).toBe(true);
      await waitFor(() => didInject);
      await waitFor(() => rootWasReplaced);
      expect(liveRunner.pauseTask(workspaceId)).toBe(true);
      await replacement;
      await Promise.resolve();
      await Promise.resolve();

      expect(live().task.state).toBe("paused");
      expect(live().task.promptSent).toBe(false);
      expect(
        deps.written.some((entry) => entry.sessionId === sessionIdFor(live(), "worker") && entry.data !== "\r"),
      ).toBe(true);
    } finally {
      activeRunner?.dispose();
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });

  test("attached resume completes its capture continuation on the current task after store mutation", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "strideterm-lifecycle-attached-resume-"));
    let readStarted = false;
    let liveRunner: AgentTaskRunner | undefined;
    const releaseRead = deferred();
    const originalReadFile = fs.readFile.bind(fs);
    const readSpy = vi
      .spyOn(fs, "readFile")
      .mockImplementation(async (...[file, options]: Parameters<typeof fs.readFile>) => {
        if (String(file).endsWith(CONTEXT_FILE)) {
          readStarted = true;
          await releaseRead.promise;
        }
        return originalReadFile(file, options);
      });
    syncBuiltinESMExports();
    try {
      const runner = new AgentTaskRunner();
      const source = sourceWorkspace(cwd);
      const companion = runner.createCompanionTaskWorkspace({
        state: { workspaces: [source] },
        workerWorkspaceId: source.id,
        workerPanelId: "primary",
        companionRole: "reviewer",
        companionProvider: { providerId: "codex", model: "gpt-5.5" },
        maxRounds: 3,
      });
      await runner.writeCompanionFiles(cwd, companion.task);
      companion.task.state = "paused";
      companion.task.pausedFromState = "capturing-context";
      companion.task.captureStartedAt = undefined;
      const taskDirPath = taskDir(cwd, companion.task.taskId);
      await fs.writeFile(
        path.join(taskDirPath, "CONTEXT.md"),
        "# Objective\nX\n\n# Confirmed requirements\nX\n\n# Acceptance criteria\nX\n\n# Constraints\nX\n\n# Decisions already made\nX\n\n# Explicit non-goals\nX\n\n# Open questions or ambiguities\nX\n",
        "utf8",
      );
      await fs.writeFile(
        path.join(taskDirPath, "HANDOFF.md"),
        "# Current state\nX\n\n# Work already completed\nX\n\n# Work in progress\nX\n\n# Files and commits touched\nX\n\n# Verification already run\nX\n\n# External or destructive side effects already performed\nX\n\n# Known blockers\nX\n\n# Recommended next step\nX\n",
        "utf8",
      );
      const runtime = await setupStoreRunner([source, companion]);
      liveRunner = runtime.runner;
      const { deps, store } = runtime;
      const workspaceId = companion.id;
      const live = () => taskWorkspace(deps.getState, workspaceId);
      expect(liveRunner.resumeTask(workspaceId)).toBe(true);
      await waitFor(() => readStarted);
      await replaceStoreRoot(store);
      releaseRead.resolve();
      await waitFor(() => live().task.state === "brief-ready");

      expect(live().task.state).toBe("brief-ready");
      expect(live().task.captureStartedAt).toBeUndefined();
      expect(deps.written).toHaveLength(0);
    } finally {
      liveRunner?.dispose();
      releaseRead.resolve();
      readSpy.mockRestore();
      syncBuiltinESMExports();
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });

  test("attached resume cancellation after store mutation remains paused", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "strideterm-lifecycle-attached-pause-"));
    let readStarted = false;
    let readResolved = false;
    let liveRunner: AgentTaskRunner | undefined;
    const releaseRead = deferred();
    const originalReadFile = fs.readFile.bind(fs);
    const readSpy = vi
      .spyOn(fs, "readFile")
      .mockImplementation(async (...[file, options]: Parameters<typeof fs.readFile>) => {
        if (String(file).endsWith(CONTEXT_FILE)) {
          readStarted = true;
          await releaseRead.promise;
        }
        const result = await originalReadFile(file, options);
        if (String(file).endsWith(CONTEXT_FILE)) readResolved = true;
        return result;
      });
    syncBuiltinESMExports();
    try {
      const runner = new AgentTaskRunner();
      const source = sourceWorkspace(cwd);
      const companion = runner.createCompanionTaskWorkspace({
        state: { workspaces: [source] },
        workerWorkspaceId: source.id,
        workerPanelId: "primary",
        companionRole: "reviewer",
        companionProvider: { providerId: "codex", model: "gpt-5.5" },
        maxRounds: 3,
      });
      await runner.writeCompanionFiles(cwd, companion.task);
      companion.task.state = "paused";
      companion.task.pausedFromState = "capturing-context";
      companion.task.captureStartedAt = undefined;
      const taskDirPath = taskDir(cwd, companion.task.taskId);
      await fs.writeFile(
        path.join(taskDirPath, "CONTEXT.md"),
        "# Objective\nX\n\n# Confirmed requirements\nX\n\n# Acceptance criteria\nX\n\n# Constraints\nX\n\n# Decisions already made\nX\n\n# Explicit non-goals\nX\n\n# Open questions or ambiguities\nX\n",
        "utf8",
      );
      await fs.writeFile(
        path.join(taskDirPath, "HANDOFF.md"),
        "# Current state\nX\n\n# Work already completed\nX\n\n# Work in progress\nX\n\n# Files and commits touched\nX\n\n# Verification already run\nX\n\n# External or destructive side effects already performed\nX\n\n# Known blockers\nX\n\n# Recommended next step\nX\n",
        "utf8",
      );
      const runtime = await setupStoreRunner([source, companion], { hookCapable: true });
      liveRunner = runtime.runner;
      const { deps, store } = runtime;
      const workspaceId = companion.id;
      const live = () => taskWorkspace(deps.getState, workspaceId);
      expect(liveRunner.resumeTask(workspaceId)).toBe(true);
      await waitFor(() => readStarted);
      await replaceStoreRoot(store);
      expect(liveRunner.pauseTask(workspaceId)).toBe(true);
      releaseRead.resolve();
      await waitFor(() => readResolved);
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(live().task.state).toBe("paused");
      expect(deps.written).toHaveLength(0);
    } finally {
      liveRunner?.dispose();
      releaseRead.resolve();
      readSpy.mockRestore();
      syncBuiltinESMExports();
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });

  test("companion answer completes on the current task after normalized store mutation", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "strideterm-lifecycle-answer-"));
    let liveRunner: AgentTaskRunner | undefined;
    try {
      const runner = new AgentTaskRunner();
      const source = sourceWorkspace(cwd);
      const companion = runner.createCompanionTaskWorkspace({
        state: { workspaces: [source] },
        workerWorkspaceId: source.id,
        workerPanelId: "primary",
        companionRole: "reviewer",
        companionProvider: { providerId: "codex", model: "gpt-5.5" },
        maxRounds: 3,
      });
      await runner.writeCompanionFiles(cwd, companion.task);
      companion.task.state = "awaiting-user";
      companion.task.pendingQuestions = [{ id: "q1", question: "Proceed?", whyNeeded: "choice", options: [] }];
      companion.task.currentRound = 1;
      companion.task.rounds = [testRound(1, "needs-input", { judgeVerdict: "needs-input" })];
      const runtime = await setupStoreRunner([source, companion]);
      liveRunner = runtime.runner;
      const { deps, store } = runtime;
      const workspaceId = companion.id;
      const live = () => taskWorkspace(deps.getState, workspaceId);
      const primarySessionId = sessionIdFor(live(), "worker");
      let rootWasReplaced = false;
      let replacement: Promise<void> | undefined;
      deps.writeToSession.mockImplementation((sessionId: string, data: string) => {
        deps.written.push({ sessionId, data });
        if (sessionId === primarySessionId && data !== "\r" && !replacement) {
          replacement = replaceStoreRoot(store).then(() => {
            rootWasReplaced = true;
          });
        }
      });

      const answer = liveRunner.answerCompanionTask(workspaceId, ["q1"], "yes");
      await waitFor(() => deps.written.some((entry) => entry.sessionId === primarySessionId && entry.data !== "\r"));
      await waitFor(() => rootWasReplaced);
      await replacement;
      expect(await answer).toBe(true);

      expect(live().task.state).toBe("running");
      expect(live().task.pendingQuestions).toEqual([]);
      expect(roundAction(live())).toBe("user-answered");
    } finally {
      liveRunner?.dispose();
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });

  test("stop cancels an answer held in Primary injection", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "strideterm-lifecycle-answer-stop-"));
    let liveRunner: AgentTaskRunner | undefined;
    let writeStarted = false;
    const releaseWrite = deferred();
    try {
      const builder = new AgentTaskRunner();
      const source = sourceWorkspace(cwd);
      const companion = builder.createCompanionTaskWorkspace({
        state: { workspaces: [source] },
        workerWorkspaceId: source.id,
        workerPanelId: "primary",
        companionRole: "reviewer",
        companionProvider: { providerId: "codex", model: "gpt-5.5" },
        maxRounds: 3,
      });
      await builder.writeCompanionFiles(cwd, companion.task);
      companion.task.state = "awaiting-user";
      companion.task.pendingQuestions = [{ id: "q1", question: "Proceed?", whyNeeded: "choice", options: [] }];
      companion.task.currentRound = 1;
      companion.task.rounds = [testRound(1, "needs-input")];
      const runtime = await setupStoreRunner([source, companion]);
      liveRunner = runtime.runner;
      const { deps } = runtime;
      const live = () => taskWorkspace(deps.getState, companion.id);
      const primarySessionId = sessionIdFor(live(), "worker");
      deps.writeToSession.mockImplementation(async (sessionId: string, data: string) => {
        deps.written.push({ sessionId, data });
        if (sessionId === primarySessionId && data !== "\r" && !writeStarted) {
          writeStarted = true;
          await releaseWrite.promise;
        }
      });

      const answer = liveRunner.answerCompanionTask(companion.id, ["q1"], "yes");
      await waitFor(() => writeStarted);
      expect(liveRunner.stopTask(companion.id)).toBe(true);
      releaseWrite.resolve();
      expect(await answer).toBe(false);

      expect(live().task.state).toBe("paused");
      expect(live().task.pendingQuestions!.map((question) => question.id)).toEqual(["q1"]);
      expect(roundAction(live(), 0)).toBe("needs-input");
    } finally {
      liveRunner?.dispose();
      releaseWrite.resolve();
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });

  test("source loss invalidates an in-flight companion answer before further Primary writes", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "strideterm-lifecycle-source-lost-answer-"));
    let liveRunner: AgentTaskRunner | undefined;
    let writeStarted = false;
    const releaseWrite = deferred();
    try {
      const builder = new AgentTaskRunner();
      const source = sourceWorkspace(cwd);
      const companion = builder.createCompanionTaskWorkspace({
        state: { workspaces: [source] },
        workerWorkspaceId: source.id,
        workerPanelId: "primary",
        companionRole: "reviewer",
        companionProvider: { providerId: "codex", model: "gpt-5.5" },
        maxRounds: 3,
      });
      await builder.writeCompanionFiles(cwd, companion.task);
      companion.task.state = "awaiting-user";
      companion.task.pendingQuestions = [{ id: "q1", question: "Proceed?", whyNeeded: "choice", options: [] }];
      companion.task.currentRound = 1;
      companion.task.rounds = [testRound(1, "needs-input")];
      const runtime = await setupStoreRunner([source, companion]);
      liveRunner = runtime.runner;
      const { deps } = runtime;
      const live = () => taskWorkspace(deps.getState, companion.id);
      const primarySessionId = sessionIdFor(live(), "worker");
      deps.writeToSession.mockImplementation(async (sessionId: string, data: string) => {
        deps.written.push({ sessionId, data });
        if (sessionId === primarySessionId && data !== "\r" && !writeStarted) {
          writeStarted = true;
          await releaseWrite.promise;
        }
      });

      const answer = liveRunner.answerCompanionTask(companion.id, ["q1"], "yes");
      await waitFor(() => writeStarted);
      liveRunner.markAttachedSourceMissing(companion.id);
      const writesAtSourceLoss = deps.written.filter((entry) => entry.sessionId === primarySessionId).length;
      releaseWrite.resolve();
      expect(await answer).toBe(false);
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(live().task.primaryMissing).toBe(true);
      expect(live().task.state).toBe("awaiting-user");
      expect(live().task.pendingQuestions!.map((question) => question.id)).toEqual(["q1"]);
      expect(deps.written.filter((entry) => entry.sessionId === primarySessionId)).toHaveLength(writesAtSourceLoss);
    } finally {
      liveRunner?.dispose();
      releaseWrite.resolve();
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });

  test("a duplicate attached start cannot invalidate the active baseline evaluation", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "strideterm-lifecycle-baseline-"));
    let liveRunner: AgentTaskRunner | undefined;
    let readWasStarted = false;
    const release = deferred();
    const originalReadFile = fs.readFile.bind(fs);
    const readSpy = vi
      .spyOn(fs, "readFile")
      .mockImplementation(async (...[file, options]: Parameters<typeof fs.readFile>) => {
        if (String(file).endsWith(CONTEXT_FILE)) {
          readWasStarted = true;
          await release.promise;
        }
        return originalReadFile(file, options);
      });
    syncBuiltinESMExports();
    try {
      const builder = new AgentTaskRunner();
      const source = sourceWorkspace(cwd);
      const companion = builder.createCompanionTaskWorkspace({
        state: { workspaces: [source] },
        workerWorkspaceId: source.id,
        workerPanelId: "primary",
        companionRole: "reviewer",
        companionProvider: { providerId: "codex", model: "gpt-5.5" },
        maxRounds: 3,
      });
      await builder.writeCompanionFiles(cwd, companion.task);
      companion.task.state = "brief-ready";
      companion.task.currentRound = 0;
      const context = path.join(taskDir(cwd, companion.task.taskId), CONTEXT_FILE);
      const handoff = path.join(taskDir(cwd, companion.task.taskId), HANDOFF_FILE);
      await fs.writeFile(context, "# Objective\nX\n", "utf8");
      await fs.writeFile(handoff, "# Current state\nX\n", "utf8");
      const runtime = await setupStoreRunner([source, companion]);
      liveRunner = runtime.runner;
      const { deps, store } = runtime;
      const live = () => taskWorkspace(deps.getState, companion.id);

      const initialStart = liveRunner.startTask(companion.id);
      await waitFor(() => readWasStarted);
      expect(live().task.state).toBe("evaluating");
      await replaceStoreRoot(store);
      expect(await liveRunner.startTask(companion.id)).toBe(false);
      release.resolve();
      await expect(initialStart).resolves.toBe(true);
      await waitFor(() => live().task.state === "judge-evaluating");

      expect(live().task.companionEvaluationAttempt).toBe(1);
      expect(
        deps.written.some((entry) => entry.sessionId.endsWith(live().task.judgePanelId) && entry.data !== "\r"),
      ).toBe(true);
    } finally {
      liveRunner?.dispose();
      release.resolve();
      readSpy.mockRestore();
      syncBuiltinESMExports();
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });

  test("a companion completion verdict commits after store replacement and raises one alert", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "strideterm-lifecycle-verdict-"));
    let liveRunner: AgentTaskRunner | undefined;
    let readStarted = false;
    const releaseRead = deferred();
    const originalReadFile = fs.readFile.bind(fs);
    const readSpy = vi
      .spyOn(fs, "readFile")
      .mockImplementation(async (...[file, options]: Parameters<typeof fs.readFile>) => {
        if (String(file).endsWith("verdict.json")) {
          readStarted = true;
          await releaseRead.promise;
        }
        return originalReadFile(file, options);
      });
    syncBuiltinESMExports();
    try {
      const builder = new AgentTaskRunner();
      const source = sourceWorkspace(cwd);
      const companion = builder.createCompanionTaskWorkspace({
        state: { workspaces: [source] },
        workerWorkspaceId: source.id,
        workerPanelId: "primary",
        companionRole: "reviewer",
        companionProvider: { providerId: "codex", model: "gpt-5.5" },
        maxRounds: 3,
      });
      await builder.writeCompanionFiles(cwd, companion.task);
      companion.task.state = "judge-evaluating";
      companion.task.currentRound = 1;
      companion.task.companionPhase = "baseline";
      companion.task.companionEvaluationAttempt = 1;
      companion.task.companionEvidence = { status: "fresh", mtimeIso: new Date().toISOString(), round: 1 };
      companion.task.rounds = [testRound(1, "running")];
      await fs.writeFile(
        path.join(taskDir(cwd, companion.task.taskId), "verdict.json"),
        JSON.stringify({
          schemaVersion: 1,
          role: "reviewer",
          phase: "baseline",
          round: 1,
          evaluationAttempt: 1,
          verdict: "complete",
          reason: "done",
          verificationReview: { recordStatus: "fresh", evidenceReviewed: ["npm test"], workerActionsRequired: [] },
          roleAnalysis: {
            type: "reviewer",
            requirementAudit: [{ requirement: "R1", status: "verified", evidence: ["src/a.ts:1"] }],
          },
          blockingFindings: [],
          advisories: [],
          questions: [],
        }),
        "utf8",
      );
      const runtime = await setupStoreRunner([source, companion]);
      liveRunner = runtime.runner;
      const { deps, store } = runtime;
      const live = () => taskWorkspace(deps.getState, companion.id);
      await store.mutate((draft) => {
        const task = draft.workspaces.find((workspace) => workspace.id === companion.id)?.task;
        if (!task) throw new Error("Companion task missing from state");
        task.state = "judge-evaluating";
      });

      expect(liveRunner.onAgentIdle(sessionIdFor(live(), "judge"), "test")).toBe(true);
      await waitFor(() => readStarted);
      await replaceStoreRoot(store);
      releaseRead.resolve();
      await waitFor(() => live().task.state === "completed");

      expect(roundAction(live(), 0)).toBe("completed");
      expect(deps.raiseAlert.mock.calls.filter(([alert]) => alert.kind === "completed")).toHaveLength(1);
    } finally {
      liveRunner?.dispose();
      releaseRead.resolve();
      readSpy.mockRestore();
      syncBuiltinESMExports();
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });

  test("source loss cancels a held companion completion verdict", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "strideterm-lifecycle-source-lost-verdict-"));
    let liveRunner: AgentTaskRunner | undefined;
    let readStarted = false;
    let readSettled = false;
    const releaseRead = deferred();
    const originalReadFile = fs.readFile.bind(fs);
    const readSpy = vi
      .spyOn(fs, "readFile")
      .mockImplementation(async (...[file, options]: Parameters<typeof fs.readFile>) => {
        if (String(file).endsWith("verdict.json")) {
          readStarted = true;
          await releaseRead.promise;
          const result = await originalReadFile(file, options);
          readSettled = true;
          return result;
        }
        return originalReadFile(file, options);
      });
    syncBuiltinESMExports();
    try {
      const builder = new AgentTaskRunner();
      const source = sourceWorkspace(cwd);
      const companion = builder.createCompanionTaskWorkspace({
        state: { workspaces: [source] },
        workerWorkspaceId: source.id,
        workerPanelId: "primary",
        companionRole: "reviewer",
        companionProvider: { providerId: "codex", model: "gpt-5.5" },
        maxRounds: 3,
      });
      await builder.writeCompanionFiles(cwd, companion.task);
      companion.task.state = "judge-evaluating";
      companion.task.currentRound = 1;
      companion.task.companionPhase = "baseline";
      companion.task.companionEvaluationAttempt = 1;
      companion.task.companionEvidence = { status: "fresh", mtimeIso: new Date().toISOString(), round: 1 };
      companion.task.rounds = [testRound(1, "running")];
      await fs.writeFile(
        path.join(taskDir(cwd, companion.task.taskId), "verdict.json"),
        JSON.stringify({
          schemaVersion: 1,
          role: "reviewer",
          phase: "baseline",
          round: 1,
          evaluationAttempt: 1,
          verdict: "complete",
          reason: "done",
          verificationReview: { recordStatus: "fresh", evidenceReviewed: ["npm test"], workerActionsRequired: [] },
          roleAnalysis: {
            type: "reviewer",
            requirementAudit: [{ requirement: "R1", status: "verified", evidence: ["src/a.ts:1"] }],
          },
          blockingFindings: [],
          advisories: [],
          questions: [],
        }),
        "utf8",
      );
      const runtime = await setupStoreRunner([source, companion]);
      liveRunner = runtime.runner;
      const { deps, store } = runtime;
      const live = () => taskWorkspace(deps.getState, companion.id);
      await store.mutate((draft) => {
        const task = draft.workspaces.find((workspace) => workspace.id === companion.id)?.task;
        if (!task) throw new Error("Companion task missing from state");
        task.state = "judge-evaluating";
      });

      expect(liveRunner.onAgentIdle(sessionIdFor(live(), "judge"), "test")).toBe(true);
      await waitFor(() => readStarted);
      liveRunner.markAttachedSourceMissing(companion.id);
      releaseRead.resolve();
      await waitFor(() => readSettled);
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(live().task.primaryMissing).toBe(true);
      expect(live().task.state).toBe("paused");
      expect(live().task.pausedFromState).toBe("judge-evaluating");
      expect(roundAction(live(), 0)).toBe("running");
      expect(deps.raiseAlert.mock.calls.filter(([alert]) => alert.kind === "completed")).toHaveLength(0);
      expect(
        deps.written.filter((entry) => entry.sessionId.endsWith(live().task.workerPanelId) && entry.data !== "\r"),
      ).toHaveLength(0);
    } finally {
      liveRunner?.dispose();
      releaseRead.resolve();
      readSpy.mockRestore();
      syncBuiltinESMExports();
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });

  test("pause cancels a companion verdict continuation held across store replacement", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "strideterm-lifecycle-verdict-pause-"));
    let liveRunner: AgentTaskRunner | undefined;
    let readStarted = false;
    let readSettled = false;
    const releaseRead = deferred();
    const originalReadFile = fs.readFile.bind(fs);
    const readSpy = vi
      .spyOn(fs, "readFile")
      .mockImplementation(async (...[file, options]: Parameters<typeof fs.readFile>) => {
        if (String(file).endsWith("verdict.json")) {
          readStarted = true;
          await releaseRead.promise;
          const result = await originalReadFile(file, options);
          readSettled = true;
          return result;
        }
        return originalReadFile(file, options);
      });
    syncBuiltinESMExports();
    try {
      const builder = new AgentTaskRunner();
      const source = sourceWorkspace(cwd);
      const companion = builder.createCompanionTaskWorkspace({
        state: { workspaces: [source] },
        workerWorkspaceId: source.id,
        workerPanelId: "primary",
        companionRole: "reviewer",
        companionProvider: { providerId: "codex", model: "gpt-5.5" },
        maxRounds: 3,
      });
      await builder.writeCompanionFiles(cwd, companion.task);
      companion.task.state = "judge-evaluating";
      companion.task.currentRound = 1;
      companion.task.companionPhase = "baseline";
      companion.task.companionEvaluationAttempt = 1;
      companion.task.companionEvidence = { status: "fresh", mtimeIso: new Date().toISOString(), round: 1 };
      companion.task.rounds = [testRound(1, "running")];
      await fs.writeFile(
        path.join(taskDir(cwd, companion.task.taskId), "verdict.json"),
        JSON.stringify({
          schemaVersion: 1,
          role: "reviewer",
          phase: "baseline",
          round: 1,
          evaluationAttempt: 1,
          verdict: "complete",
          reason: "done",
          verificationReview: { recordStatus: "fresh", evidenceReviewed: ["npm test"], workerActionsRequired: [] },
          roleAnalysis: {
            type: "reviewer",
            requirementAudit: [{ requirement: "R1", status: "verified", evidence: ["src/a.ts:1"] }],
          },
          blockingFindings: [],
          advisories: [],
          questions: [],
        }),
        "utf8",
      );
      const runtime = await setupStoreRunner([source, companion]);
      liveRunner = runtime.runner;
      const { deps, store } = runtime;
      const live = () => taskWorkspace(deps.getState, companion.id);
      await store.mutate((draft) => {
        const task = draft.workspaces.find((workspace) => workspace.id === companion.id)?.task;
        if (!task) throw new Error("Companion task missing from state");
        task.state = "judge-evaluating";
      });

      expect(liveRunner.onAgentIdle(sessionIdFor(live(), "judge"), "test")).toBe(true);
      await waitFor(() => readStarted);
      await replaceStoreRoot(store);
      expect(liveRunner.pauseTask(companion.id)).toBe(true);
      releaseRead.resolve();
      await waitFor(() => readSettled);
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(live().task.state).toBe("paused");
      expect(roundAction(live(), 0)).toBe("running");
      expect(deps.raiseAlert).not.toHaveBeenCalled();
    } finally {
      liveRunner?.dispose();
      releaseRead.resolve();
      readSpy.mockRestore();
      syncBuiltinESMExports();
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });

  test("reset applies to the current task when its work-lock write crosses a store mutation", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "strideterm-lifecycle-reset-"));
    let interceptLockWrite = false;
    let liveRunner: AgentTaskRunner | undefined;
    let lockWriteStarted = false;
    const releaseLockWrite = deferred();
    const originalWriteFile = fs.writeFile.bind(fs);
    const writeSpy = vi
      .spyOn(fs, "writeFile")
      .mockImplementation(async (...[file, data, options]: Parameters<typeof fs.writeFile>) => {
        if (interceptLockWrite && String(file).endsWith(WORK_LOCK_FILE)) {
          lockWriteStarted = true;
          await releaseLockWrite.promise;
        }
        return originalWriteFile(file, data, options);
      });
    syncBuiltinESMExports();
    try {
      const runner = new AgentTaskRunner();
      const workspace = standardWorkspace(runner, cwd, "Reset lifecycle");
      await runner.writeInitialFiles(cwd, workspace.task);
      workspace.task.state = "paused";
      workspace.task.currentRound = 2;
      workspace.task.rounds = [testRound(1, "completed")];
      const runtime = await setupStoreRunner([workspace]);
      liveRunner = runtime.runner;
      const { deps, store } = runtime;
      const workspaceId = workspace.id;
      const live = () => taskWorkspace(deps.getState, workspaceId);

      interceptLockWrite = true;
      const reset = liveRunner.resetTask(workspaceId);
      await waitFor(() => lockWriteStarted);
      await replaceStoreRoot(store);
      releaseLockWrite.resolve();
      expect(await reset).toBe(true);

      expect(live().task.state).toBe("idle");
      expect(live().task.currentRound).toBe(0);
      expect(live().task.rounds).toEqual([]);
      await expect(fs.access(path.join(taskDir(cwd, live().task.taskId), WORK_LOCK_FILE))).resolves.toBeUndefined();
    } finally {
      liveRunner?.dispose();
      releaseLockWrite.resolve();
      writeSpy.mockRestore();
      syncBuiltinESMExports();
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});
