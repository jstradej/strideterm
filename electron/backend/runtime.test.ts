import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, test, vi } from "vitest";
import { createRuntime, detectTerminalEnvironment, hasMeaningfulUserInput } from "./runtime.js";
import { AgentTaskRunner } from "./agent-task-runner.js";
import { createSessionId, normalizeState } from "./default-state.js";
import { RemoteClientRegistry } from "./remote-client-registry.js";

// Lets a single test capture log calls made through getLogger(label), for any
// label, without altering real logging behavior for the other ~230 tests in
// this file: every call is still forwarded to the real logger (so file output
// is unaffected) — a test just also gets an array of what was logged. Needed
// because runtime.ts calls reconfigureLogger() internally during startup
// (settings-driven log level), which replaces the winston singleton — a naive
// "grab the winston instance and vi.spyOn it" approach taken before this one
// silently stopped observing calls made after that internal reconfiguration.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type LogCall = { level: string; label: string; message: string; meta?: Record<string, any> };
const logCallCapture = vi.hoisted(() => ({ current: null as LogCall[] | null }));
vi.mock("./logger.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./logger.js")>();
  const LOG_METHODS = ["error", "warn", "info", "debug", "trace"] as const;
  return {
    ...actual,
    getLogger: (label: string) => {
      const real = actual.getLogger(label);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const wrapped = {} as any;
      for (const method of LOG_METHODS) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        wrapped[method] = (message: string, meta?: Record<string, any>) => {
          logCallCapture.current?.push({ level: method, label, message, meta });
          real[method](message, meta);
        };
      }
      return wrapped;
    },
  };
});

// Lets a single test force classifyHookEvent to throw so dispatchAgentHookEvent's
// promise genuinely rejects (used by the dispatchAgentHookEvent call-site tests
// below) without disturbing any other test — everything else in this file goes
// through the real classifier via `importOriginal`.
const classifyHookEventOverride = vi.hoisted(() => ({
  current: null as ((...args: unknown[]) => unknown) | null,
}));
vi.mock("./notifications/classifier.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./notifications/classifier.js")>();
  return {
    ...actual,
    classifyHookEvent: (...args: unknown[]) => {
      if (classifyHookEventOverride.current) return classifyHookEventOverride.current(...args);
      return actual.classifyHookEvent(...(args as Parameters<typeof actual.classifyHookEvent>));
    },
  };
});

// Lets a single test force ensureNotifyScript to resolve { ok: false } (it
// never rejects — see claude-hook-config.ts) so the startup call site's log.error
// on failure can be exercised without touching any other test's real fs write.
const ensureNotifyScriptOverride = vi.hoisted(() => ({
  current: null as (() => Promise<{ ok: boolean; path: string; error?: string }>) | null,
}));
vi.mock("./claude-hook-config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./claude-hook-config.js")>();
  return {
    ...actual,
    ensureNotifyScript: (...args: Parameters<typeof actual.ensureNotifyScript>) => {
      if (ensureNotifyScriptOverride.current) return ensureNotifyScriptOverride.current();
      return actual.ensureNotifyScript(...args);
    },
  };
});

// Starts capturing getLogger(...) calls (see the "./logger.js" mock above)
// and returns the array they land in. Always pair with `logCallCapture.current
// = null;` in a `finally` so a forgotten reset can't leak into later tests.
function captureLogCalls(): LogCall[] {
  const calls: LogCall[] = [];
  logCallCapture.current = calls;
  return calls;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function createMemoryStore(initialState?: any) {
  let state = normalizeState(initialState);
  let pending = Promise.resolve();
  let saveCalls = 0;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function enqueue(operation: any) {
    const next = pending.then(operation, operation);
    pending = next.catch(() => {});
    return next;
  }

  return {
    getState() {
      return state;
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async replace(nextState: any) {
      return enqueue(async () => {
        state = normalizeState(nextState, { seedRestoreIdsFromSlots: false });
        return state;
      });
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async mutate(mutator: any) {
      return enqueue(async () => {
        const draft = structuredClone(state);
        const result = await mutator(draft);
        state = normalizeState(result || draft, { seedRestoreIdsFromSlots: false });
        return state;
      });
    },
    async save() {
      return enqueue(async () => {
        saveCalls += 1;
        return state;
      });
    },
    async flush() {
      await pending;
    },
    get saveCalls() {
      return saveCalls;
    },
  };
}

class FakeSessionManager extends EventEmitter {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  declare sessions: Map<any, any>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  declare syncedStates: any[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  declare removedProjects: any[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  declare closedSessions: any[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  declare resizeCalls: any[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  declare writeCalls: any[];
  declare stopped: boolean;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  declare getSessionEnv: any;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  constructor({ getSessionEnv }: any = {}) {
    super();
    this.sessions = new Map();
    this.syncedStates = [];
    this.removedProjects = [];
    this.closedSessions = [];
    this.resizeCalls = [];
    this.writeCalls = [];
    this.stopped = false;
    this.getSessionEnv = typeof getSessionEnv === "function" ? getSessionEnv : null;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getWorkspace(state: any, projectId = state.activeProjectId) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const project = state.projects.find((item: any) => item.id === projectId) || null;
    if (!project) {
      return null;
    }

    return {
      project,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      sessions: project.panels.map((panel: any) => ({
        sessionId: createSessionId(project.id, panel.id),
        panelId: panel.id,
        title: panel.title,
        command: panel.command,
        launch: panel.launch,
        startup: panel.startup,
        status: this.sessions.get(createSessionId(project.id, panel.id))?.status || "idle",
      })),
    };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  resolveDefaultSessionId(state: any, projectId = state.activeProjectId) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const project = state.projects.find((item: any) => item.id === projectId) || null;
    if (!project) {
      return null;
    }

    const activePanelId = project.activePanelId || project.panels[0]?.id || null;
    return activePanelId ? createSessionId(project.id, activePanelId) : null;
  }

  // Match the real SessionManager.ensureSession signature: async, returns
  // Promise<session | null>. Production callers chain `.catch()` on the result.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async ensureSession(state: any, sessionId: any) {
    const [projectId, panelId] = String(sessionId).split(":");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const project = state.projects.find((item: any) => item.id === projectId);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const panel = project?.panels.find((item: any) => item.id === panelId);
    if (!project || !panel) {
      return null;
    }

    const session = {
      id: sessionId,
      projectId,
      panelId,
      title: panel.title,
      command: panel.command,
      status: "running",
    };
    this.sessions.set(sessionId, session);
    return session;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async restartSession(state: any, sessionId: any) {
    this.sessions.delete(sessionId);
    this.emit("terminal:exit", { sessionId, exitCode: 0, intentional: true });
    return this.ensureSession(state, sessionId);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  removeSession(sessionId: any) {
    this.closedSessions.push(sessionId);
    this.sessions.delete(sessionId);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  removeWorkspaceSessions(workspaceId: any) {
    this.removedProjects.push(workspaceId);
    for (const sessionId of [...this.sessions.keys()]) {
      if (sessionId.startsWith(`${workspaceId}:`)) {
        this.sessions.delete(sessionId);
      }
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  resizeSession(sessionId: any, cols: any, rows: any) {
    this.resizeCalls.push({ sessionId, cols, rows });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  writeToSession(sessionId: any, data: any) {
    this.writeCalls.push({ sessionId, data });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  syncWithState(state: any) {
    this.syncedStates.push(structuredClone(state));
    /* eslint-disable @typescript-eslint/no-explicit-any -- MIGRATION-EXEMPT: test mock state is untyped */
    const validIds = new Set(
      state.projects.flatMap((project: any) =>
        project.panels.map((panel: any) => createSessionId(project.id, panel.id)),
      ),
    );
    /* eslint-enable @typescript-eslint/no-explicit-any */
    for (const sessionId of [...this.sessions.keys()]) {
      if (!validIds.has(sessionId)) {
        this.sessions.delete(sessionId);
      }
    }
  }

  stopAll() {
    this.stopped = true;
    this.sessions.clear();
  }
}

class FakeDockerManager extends EventEmitter {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  declare snapshot: any;
  declare refreshCount: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  declare actions: any[];

  constructor() {
    super();
    this.snapshot = {
      available: true,
      backend: "host",
      contexts: [],
      containers: [{ ID: "abc123", Names: "api" }],
      lazydocker: { available: true, backend: "host", error: "" },
      error: "",
      lastUpdatedAt: null,
    };
    this.refreshCount = 0;
    this.actions = [];
  }

  getSnapshot() {
    return this.snapshot;
  }

  async refresh() {
    this.refreshCount += 1;
    this.snapshot = { ...this.snapshot, lastUpdatedAt: new Date().toISOString() };
    this.emit("updated", this.snapshot);
    return this.snapshot;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async performAction(action: any, containerId: any) {
    this.actions.push({ action, containerId });
    return this.refresh();
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  findContainer(containerId: any) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return this.snapshot.containers.find((item: any) => item.ID === containerId) || null;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  createShellLaunch(containerId: any) {
    return { file: "docker", args: ["exec", "-it", containerId, "sh"] };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  createLogsLaunch(containerId: any) {
    return { file: "docker", args: ["logs", "-f", containerId] };
  }

  createLazydockerLaunch() {
    return { file: "lazydocker", args: [] };
  }

  invalidateBackendDetectionCache() {
    // no-op in tests
  }
}

class FakeGitManager extends EventEmitter {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  declare snapshots: Map<any, any>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  declare refreshArgs: any[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  declare actions: any[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  declare invalidateCalls: any[];

  constructor() {
    super();
    this.snapshots = new Map();
    this.refreshArgs = [];
    this.actions = [];
    this.invalidateCalls = [];
  }

  invalidateSnapshotCache(workspaceId: string | null = null, rootPath: string | null = null) {
    this.invalidateCalls.push({ workspaceId, rootPath });
  }

  getProjectMap() {
    return Object.fromEntries(this.snapshots.entries());
  }

  getSnapshot(projectId: string) {
    return this.snapshots.get(projectId) || null;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async refreshWorkspaces(projects: any[] = []) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    this.refreshArgs.push(projects.map((project: any) => project.id));
    this.snapshots = new Map(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      projects.map((project: any) => [
        project.id,
        {
          projectId: project.id,
          cwd: project.cwd || "",
          available: Boolean(project.cwd),
          root: project.cwd || "",
          repository: project.name || project.id,
          branch: "main",
          commitCount: 1,
          dirty: false,
          dirtyCount: 0,
          status: [],
          staged: [],
          unstaged: [],
          untracked: [],
          changes: {
            staged: {
              name: "Staged",
              files: [],
              diffStat: { files: 0, insertions: 0, deletions: 0, renames: 0, deletes: 0 },
            },
            unstaged: {
              name: "Unstaged",
              files: [],
              diffStat: { files: 0, insertions: 0, deletions: 0, renames: 0, deletes: 0 },
            },
            untracked: {
              name: "Untracked",
              files: [],
              diffStat: { files: 0, insertions: 0, deletions: 0, renames: 0, deletes: 0 },
            },
          },
          diffStat: { files: 0, insertions: 0, deletions: 0, renames: 0, deletes: 0 },
          log: [],
          isWorktree: false,
          isMainWorktree: true,
          worktreePath: project.cwd || "",
          mainWorktreePath: project.cwd || "",
          siblingWorktrees: [],
          upstream: "origin/main",
          baseBranch: "main",
          aheadCount: 0,
          behindCount: 0,
          compareWithBase: {
            baseBranch: "main",
            aheadCount: 0,
            behindCount: 0,
            commits: [],
            files: [],
            diffStat: { files: 0, insertions: 0, deletions: 0, renames: 0, deletes: 0 },
          },
          lastFetchAt: null,
          operationState: {
            kind: "idle",
            inProgress: false,
            label: "",
            details: "",
            conflicts: [],
            canContinue: false,
            canAbort: false,
          },
          lazygit: {
            available: project.kind !== "docker",
            backend: project.kind !== "docker" ? "host" : null,
            error: "",
            launch: project.kind !== "docker" ? { file: "lazygit", args: [] } : null,
          },
          error: "",
          lastUpdatedAt: new Date().toISOString(),
        },
      ]),
    );
    this.emit("updated", this.getProjectMap());
    return this.getProjectMap();
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async fetch(workspace: any, options?: any) {
    this.actions.push({ kind: "fetch", workspaceId: workspace.id, connection: options?.connection ?? null });
    return {
      ok: true,
      summary: "Fetch completed.",
      warnings: [],
      conflicts: [],
      rawOutput: "fetch ok",
      operationState: {
        kind: "idle",
        inProgress: false,
        label: "",
        details: "",
        conflicts: [],
        canContinue: false,
        canAbort: false,
      },
    };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async mergeIntoCurrent(workspace: any, payload: any) {
    this.actions.push({ kind: "merge", workspaceId: workspace.id, payload });
    return {
      ok: true,
      summary: "Merge completed.",
      warnings: [],
      conflicts: [],
      rawOutput: "merge ok",
      operationState: {
        kind: "idle",
        inProgress: false,
        label: "",
        details: "",
        conflicts: [],
        canContinue: false,
        canAbort: false,
      },
    };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async rebaseOnto(workspace: any, payload: any) {
    this.actions.push({ kind: "rebase", workspaceId: workspace.id, payload });
    return {
      ok: true,
      summary: "Rebase completed.",
      warnings: [],
      conflicts: [],
      rawOutput: "rebase ok",
      operationState: {
        kind: "idle",
        inProgress: false,
        label: "",
        details: "",
        conflicts: [],
        canContinue: false,
        canAbort: false,
      },
    };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async continueOperation(workspace: any) {
    this.actions.push({ kind: "continue", workspaceId: workspace.id });
    return {
      ok: true,
      summary: "Continue completed.",
      warnings: [],
      conflicts: [],
      rawOutput: "continue ok",
      operationState: {
        kind: "idle",
        inProgress: false,
        label: "",
        details: "",
        conflicts: [],
        canContinue: false,
        canAbort: false,
      },
    };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async abortOperation(workspace: any) {
    this.actions.push({ kind: "abort", workspaceId: workspace.id });
    return {
      ok: true,
      summary: "Abort completed.",
      warnings: [],
      conflicts: [],
      rawOutput: "abort ok",
      operationState: {
        kind: "idle",
        inProgress: false,
        label: "",
        details: "",
        conflicts: [],
        canContinue: false,
        canAbort: false,
      },
    };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async diffPreview(workspace: any, payload: any) {
    this.actions.push({ kind: "diff", workspaceId: workspace.id, payload });
    return {
      ok: true,
      scope: payload.scope || "unstaged",
      path: payload.path,
      diff: "diff --git a/file b/file",
      summary: "",
    };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  createLazygitLaunch(projectId: any) {
    const launch = this.snapshots.get(projectId)?.lazygit?.launch;
    return launch ? { file: launch.file, args: [...launch.args] } : null;
  }
}

class FakeTunnelManager extends EventEmitter {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  declare snapshot: any;
  declare refreshCount: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  declare startCalls: any[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  declare stopCalls: any[];

  constructor() {
    super();
    this.snapshot = {
      available: true,
      status: "idle",
      mode: "quick",
      publicUrl: "",
      localUrl: "",
      error: "",
      startedAt: null,
    };
    this.refreshCount = 0;
    this.startCalls = [];
    this.stopCalls = [];
  }

  getSnapshot() {
    return structuredClone(this.snapshot);
  }

  async refreshAvailability() {
    this.refreshCount += 1;
    this.snapshot = { ...this.snapshot, available: true };
    this.emit("updated", this.getSnapshot());
    return this.getSnapshot();
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async startQuickTunnel(localUrl: any) {
    this.startCalls.push(localUrl);
    this.snapshot = {
      ...this.snapshot,
      available: true,
      status: "connected",
      localUrl,
      publicUrl: "https://termhub.example.com",
      error: "",
      startedAt: new Date().toISOString(),
    };
    this.emit("updated", this.getSnapshot());
    return this.getSnapshot();
  }

  async stop(options = {}) {
    this.stopCalls.push(options);
    this.snapshot = {
      ...this.snapshot,
      status: "idle",
      publicUrl: "",
      localUrl: "",
      error: "",
    };
    this.emit("updated", this.getSnapshot());
    return this.getSnapshot();
  }

  applyExternalError(message: string) {
    this.snapshot = { ...this.snapshot, status: "idle", error: message || "" };
    this.emit("updated", this.getSnapshot());
  }

  applyExternalConnecting() {
    this.snapshot = { ...this.snapshot, status: "connecting", error: "" };
    this.emit("updated", this.getSnapshot());
  }
}

function createPluginManagerStub() {
  return Promise.resolve({
    getPlugins() {
      return [
        {
          id: "system-monitor",
          name: "System Monitor",
          kind: "terminal",
          icon: "SM",
          error: null,
          workspaceDefaults: {
            name: "System Monitor",
            icon: "SM",
            kind: "terminal",
            panels: [{ id: "monitor", title: "Monitor", command: "" }],
          },
        },
      ];
    },
    getWorkspaceTemplate() {
      return null;
    },
    async stopAll() {},
  });
}

async function createFixture({
  initialState,
  execFileTextImpl,
  dependencies = {},
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- MIGRATION-EXEMPT: test fixture accepts open-ended initial state and dependencies
}: { initialState?: any; execFileTextImpl?: any; dependencies?: any } = {}) {
  const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), "strideterm-runtime-"));
  const store = createMemoryStore(initialState);
  const sessionManager = new FakeSessionManager();
  const docker = new FakeDockerManager();
  const git = new FakeGitManager();
  const tunnel = new FakeTunnelManager();
  const reviewBridgeStore = {
    getPullRequestContext: vi.fn(() => null),
    saveDraftResponse: vi.fn().mockResolvedValue(null),
    queueDraftResponse: vi.fn().mockResolvedValue(null),
    syncPendingDrafts: vi.fn().mockResolvedValue(null),
    close: vi.fn().mockResolvedValue(undefined),
  };
  const execFileText = execFileTextImpl || vi.fn().mockResolvedValue({ stdout: "", stderr: "" });
  const checkRemoteOrigin = vi.fn().mockResolvedValue(undefined);

  const runtime = await createRuntime({
    userDataPath,
    builtinPluginsDir: null as unknown as string,
    dependencies: {
      createStore: async () => store,

      SessionManager: class extends FakeSessionManager {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        constructor(opts: any) {
          super();
          sessionManager.getSessionEnv = typeof opts?.getSessionEnv === "function" ? opts.getSessionEnv : null;
          return sessionManager;
        }
      },
      DockerManager: class extends FakeDockerManager {
        constructor() {
          super();
          return docker;
        }
      },
      GitManager: class extends FakeGitManager {
        constructor() {
          super();
          return git;
        }
      },
      CloudflareTunnelManager: class extends FakeTunnelManager {
        constructor() {
          super();
          return tunnel;
        }
      },
      createPluginManager: createPluginManagerStub,
      createReviewBridgeStore: async () => reviewBridgeStore,
      execFileText,
      checkRemoteOrigin,
      ...dependencies,
    },
  });

  return {
    runtime,
    store,
    sessionManager,
    docker,
    git,
    tunnel,
    reviewBridgeStore,
    execFileText,
    checkRemoteOrigin,
    userDataPath,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const fixtures: any[] = [];
const tempPaths: string[] = [];

// Windows holds file handles for a few ms after a watcher / log writer
// closes, so a synchronous `fs.rm({ recursive: true, force: true })` right
// after `runtime.stop()` often hits ENOTEMPTY / EBUSY. Node's `maxRetries`
// + `retryDelay` is the canonical workaround.
const RM_OPTS = { recursive: true, force: true, maxRetries: 5, retryDelay: 100 };

afterEach(async () => {
  await Promise.all(
    fixtures.splice(0).map(async (fixture) => {
      await fixture.runtime.stop();
      await fs.rm(fixture.userDataPath, RM_OPTS);
    }),
  );
  await Promise.all(tempPaths.splice(0).map((targetPath) => fs.rm(targetPath, RM_OPTS)));
});

describe("detectTerminalEnvironment", () => {
  test("reports conpty for supported Windows builds", () => {
    expect(detectTerminalEnvironment({ platform: "win32", release: "10.0.26100" })).toEqual({
      platform: "win32",
      windowsPty: {
        backend: "conpty",
        buildNumber: 26100,
      },
    });
  });

  test("reports winpty for legacy Windows builds", () => {
    expect(detectTerminalEnvironment({ platform: "win32", release: "10.0.17763" })).toEqual({
      platform: "win32",
      windowsPty: {
        backend: "winpty",
        buildNumber: 17763,
      },
    });
  });

  test("omits windowsPty outside Windows", () => {
    expect(detectTerminalEnvironment({ platform: "linux", release: "6.8.0" })).toEqual({
      platform: "linux",
    });
  });
});

describe("hasMeaningfulUserInput", () => {
  test("returns false for empty/undefined input", () => {
    expect(hasMeaningfulUserInput("")).toBe(false);
    expect(hasMeaningfulUserInput(null)).toBe(false);
    expect(hasMeaningfulUserInput(undefined)).toBe(false);
  });

  test("returns false for SGR mouse events (click, drag, wheel)", () => {
    expect(hasMeaningfulUserInput("\x1b[<0;40;12M")).toBe(false);
    expect(hasMeaningfulUserInput("\x1b[<0;40;12m")).toBe(false);
    expect(hasMeaningfulUserInput("\x1b[<64;10;5M")).toBe(false); // wheel up
  });

  test("returns false for X10 mouse events", () => {
    expect(hasMeaningfulUserInput("\x1b[M   ")).toBe(false);
  });

  test("returns false for focus in/out", () => {
    expect(hasMeaningfulUserInput("\x1b[I")).toBe(false);
    expect(hasMeaningfulUserInput("\x1b[O")).toBe(false);
  });

  test("returns false for concatenated passive sequences", () => {
    expect(hasMeaningfulUserInput("\x1b[I\x1b[<0;40;12M\x1b[<0;40;12m\x1b[O")).toBe(false);
  });

  test("returns true for typed characters", () => {
    expect(hasMeaningfulUserInput("a")).toBe(true);
    expect(hasMeaningfulUserInput("hello")).toBe(true);
  });

  test("returns true for Enter and control chars", () => {
    expect(hasMeaningfulUserInput("\r")).toBe(true);
    expect(hasMeaningfulUserInput("\x03")).toBe(true); // Ctrl+C
  });

  test("returns true for arrow keys and function keys", () => {
    expect(hasMeaningfulUserInput("\x1b[A")).toBe(true); // up arrow
    expect(hasMeaningfulUserInput("\x1b[B")).toBe(true); // down arrow
    expect(hasMeaningfulUserInput("\x1bOP")).toBe(true); // F1
  });

  test("returns true when mouse event is followed by typed text", () => {
    expect(hasMeaningfulUserInput("\x1b[<0;40;12Mabc")).toBe(true);
  });
});

describe("runtime integration", () => {
  test("includes terminal environment in payload", async () => {
    const fixture = await createFixture();
    fixtures.push(fixture);

    expect(fixture.runtime.getPayload().environment).toMatchObject(detectTerminalEnvironment());
  });

  test("keeps a bounded terminal replay tail for renderer startup attach", async () => {
    const fixture = await createFixture();
    fixtures.push(fixture);

    fixture.sessionManager.emit("terminal:data", { sessionId: "backend:shell", data: "hello " });
    fixture.sessionManager.emit("terminal:data", { sessionId: "backend:shell", data: "prompt\r\n" });

    expect(fixture.runtime.getTerminalReplay("backend:shell")).toEqual({ data: "hello prompt\r\n" });

    await fixture.runtime.restartSession("backend:shell");
    expect(fixture.runtime.getTerminalReplay("backend:shell")).toEqual({ data: "" });
  });

  test("keeps terminal replay after an UNEXPECTED exit so a later client sees the failure output", async () => {
    const fixture = await createFixture();
    fixtures.push(fixture);

    fixture.sessionManager.emit("terminal:data", { sessionId: "backend:shell", data: "boom\r\n" });
    fixture.sessionManager.emit("terminal:exit", { sessionId: "backend:shell", exitCode: 1, intentional: false });

    // Unexpected exit must NOT drop the buffer — the crash output is still
    // replayable, and the exit notice is folded into the replay so it survives a
    // later subscribe/replay reset (review F6 follow-up).
    expect(fixture.runtime.getTerminalReplay("backend:shell")).toEqual({
      data: "boom\r\n\r\n[process exited with code 1]\r\n",
    });
  });

  test("clears terminal replay on an INTENTIONAL exit (restart boundary)", async () => {
    const fixture = await createFixture();
    fixtures.push(fixture);

    fixture.sessionManager.emit("terminal:data", { sessionId: "backend:shell", data: "old-gen\r\n" });
    fixture.sessionManager.emit("terminal:exit", { sessionId: "backend:shell", exitCode: 0, intentional: true });

    expect(fixture.runtime.getTerminalReplay("backend:shell")).toEqual({ data: "" });
  });

  test("implicit respawn (terminal:spawned) clears the dead generation's replay but keeps seq", async () => {
    // Review F6: ensureSession respawns an exited session under the SAME id
    // without going through restartSession — the spawn event is the clear
    // boundary, otherwise the crashed generation's screen would be prepended
    // to the new prompt in a later attach/subscribe replay.
    const fixture = await createFixture();
    fixtures.push(fixture);

    fixture.sessionManager.emit("terminal:data", { sessionId: "backend:shell", data: "old-gen crash\r\n" });
    fixture.sessionManager.emit("terminal:exit", { sessionId: "backend:shell", exitCode: 1, intentional: false });
    // Crash output (plus the folded-in exit notice) stays replayable while the
    // session sits exited...
    expect(fixture.runtime.getTerminalReplay("backend:shell")).toEqual({
      data: "old-gen crash\r\n\r\n[process exited with code 1]\r\n",
    });

    // ...until a new generation spawns under the same id.
    fixture.sessionManager.emit("terminal:spawned", { sessionId: "backend:shell" });
    expect(fixture.runtime.getTerminalReplay("backend:shell")).toEqual({ data: "" });

    // Sequence continues across the generation boundary (old throughSeq can
    // never shadow new output as a duplicate). seq 1 = crash output, seq 2 = the
    // folded exit notice, seq 3 = the new generation's first output.
    fixture.sessionManager.emit("terminal:data", { sessionId: "backend:shell", data: "new-gen\r\n" });
    expect(fixture.runtime.getTerminalReplaySnapshot("backend:shell")).toEqual({
      data: "new-gen\r\n",
      throughSeq: 3,
    });
  });

  test("closeSession (Disconnect SSH) clears replay content but keeps the seq counter", async () => {
    // Finding 1: "Disconnect SSH" keeps the panel in state, so closeSession must
    // CLEAR the replay (drop the dead screen) while KEEPING the sequence counter.
    // Destroying it (seq → 0) would let a renderer/remote client still holding
    // the pre-disconnect throughSeq drop every reconnect frame as a duplicate.
    // The removeSession path synchronously emits a "── Disconnected by user"
    // banner; clearing BEFORE removeSession lands that banner in the kept replay.
    const fixture = await createFixture();
    fixtures.push(fixture);

    fixture.sessionManager.emit("terminal:data", { sessionId: "backend:ssh", data: "ssh output\r\n" });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (fixture.sessionManager as any).removeSession = (sessionId: string) => {
      fixture.sessionManager.emit("terminal:data", { sessionId, data: "\r\n── Disconnected by user\r\n" });
      fixture.sessionManager.sessions.delete(sessionId);
    };

    await fixture.runtime.closeSession("backend:ssh");

    // Content is reduced to the disconnect banner, but the counter is preserved
    // (seq 1 = "ssh output", seq 2 = the banner) — NOT reset to 0.
    expect(fixture.runtime.getTerminalReplaySnapshot("backend:ssh")).toEqual({
      data: "\r\n── Disconnected by user\r\n",
      throughSeq: 2,
    });

    // A reconnect (terminal:spawned clears content, keeps seq) then streams: the
    // seq keeps climbing past the old throughSeq instead of restarting at 1, so
    // the fresh frame is never shadowed as a duplicate.
    fixture.sessionManager.emit("terminal:spawned", { sessionId: "backend:ssh" });
    fixture.sessionManager.emit("terminal:data", { sessionId: "backend:ssh", data: "reconnected\r\n" });
    expect(fixture.runtime.getTerminalReplaySnapshot("backend:ssh")).toEqual({
      data: "reconnected\r\n",
      throughSeq: 3,
    });
  });

  test("terminal:removed (panel gone from state) destroys the session's replay", async () => {
    // Review F4: syncWithState emits terminal:removed for an orphaned panel; the
    // runtime must drop its replay so removed panels don't leak replay memory and
    // a stale snapshot can't be re-served on a later subscribe. Unlike restart
    // (clear keeps the seq counter), removal resets it.
    const fixture = await createFixture();
    fixtures.push(fixture);

    fixture.sessionManager.emit("terminal:data", { sessionId: "backend:shell", data: "some output" });
    expect(fixture.runtime.getTerminalReplaySnapshot("backend:shell")).toEqual({ data: "some output", throughSeq: 1 });

    fixture.sessionManager.emit("terminal:removed", { sessionId: "backend:shell" });
    expect(fixture.runtime.getTerminalReplaySnapshot("backend:shell")).toEqual({ data: "", throughSeq: 0 });
  });

  test("stamps a monotonic per-session seq on terminal:data matching the replay snapshot", async () => {
    const fixture = await createFixture();
    fixtures.push(fixture);

    const seqs: number[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    fixture.runtime.on("terminal:data", (p: any) => seqs.push(p.seq));

    fixture.sessionManager.emit("terminal:data", { sessionId: "backend:shell", data: "a" });
    fixture.sessionManager.emit("terminal:data", { sessionId: "backend:shell", data: "b" });

    expect(seqs).toEqual([1, 2]);
    expect(fixture.runtime.getTerminalReplaySnapshot("backend:shell")).toEqual({ data: "ab", throughSeq: 2 });
  });

  test("closes the review bridge store on shutdown", async () => {
    const fixture = await createFixture();
    await fixture.runtime.stop();

    expect(fixture.reviewBridgeStore.close).toHaveBeenCalledTimes(1);
    await fs.rm(fixture.userDataPath, RM_OPTS);
  });

  test("includes review bridge context for active azure review workspaces", async () => {
    const fixture = await createFixture({
      initialState: {
        activeWorkspaceId: "workspace-review",
        workspaces: [
          {
            id: "workspace-review",
            name: "Review",
            kind: "terminal",
            cwd: "/tmp/review",
            activePanelId: "shell",
            review: {
              provider: "azure-devops",
              prKey: "ado-main:repo-1:123",
            },
            panels: [{ id: "shell", title: "Shell", command: "", startup: "default" }],
          },
        ],
      },
    });
    fixtures.push(fixture);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (fixture.reviewBridgeStore.getPullRequestContext as any).mockReturnValue({
      prKey: "ado-main:repo-1:123",
      briefMarkdownPath: "/tmp/review/agent-brief.md",
      databasePath: "/tmp/review/review-bridge.db",
      tasks: [{ taskKey: "ado-main:repo-1:123:thread:10" }],
      drafts: [],
      syncQueue: [],
    });

    const payload = fixture.runtime.getPayload();

    expect(payload.reviewBridge.pullRequests["ado-main:repo-1:123"]).toMatchObject({
      briefMarkdownPath: "/tmp/review/agent-brief.md",
      databasePath: "/tmp/review/review-bridge.db",
    });
  });

  test("repairs persisted azure review workspaces that lost review metadata", async () => {
    class FakeAzureManager extends EventEmitter {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      declare snapshot: any;

      constructor() {
        super();
        this.snapshot = {
          connections: [],
          inbox: {
            needsMyReview: [],
            myPullRequests: [],
            recentlyUpdated: [],
            needsAttention: [],
          },
          trackedPullRequests: {},
          pullRequests: {
            "ado-main:repo-1:123": {
              prKey: "ado-main:repo-1:123",
              connectionId: "ado-main",
              orgUrl: "https://dev.azure.com/acme",
              project: { id: "project-1", name: "Platform" },
              repository: {
                id: "repo-1",
                name: "web-app",
                remoteUrl: "https://dev.azure.com/acme/Platform/_git/web-app",
              },
              pullRequest: {
                id: 123,
                title: "Fix login redirect",
                status: "active",
                sourceRefName: "refs/heads/feature/login-fix",
                targetRefName: "refs/heads/main",
              },
              role: "reviewer",
            },
          },
          sync: { running: false, lastStartedAt: null, lastCompletedAt: null },
        };
      }

      getSnapshot() {
        return structuredClone(this.snapshot);
      }

      async sync() {
        return this.getSnapshot();
      }

      stopPolling() {}

      configurePolling() {}

      findConnection() {
        return { id: "ado-main", reviewRoot: "C:/reviews", login: "me@example.com", tokenRef: "cred:ado-main" };
      }

      buildManagedReviewPaths() {
        return {
          parentWorkspaceId: "azure-root",
          reviewRoot: "C:/reviews",
          cacheRepoPath: "C:/reviews/repos/ado-main/repo-1",
          rootPath: "C:/reviews/reviews/ado-main/pr-123",
        };
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      buildReviewMetadata(summary: any, checkout: any, mode: any, extra: any = {}) {
        return {
          provider: "azure-devops",
          prKey: summary.prKey,
          connectionId: summary.connectionId,
          orgUrl: summary.orgUrl,
          parentWorkspaceId: extra.parentWorkspaceId || "",
          project: summary.project,
          repository: summary.repository,
          pullRequest: summary.pullRequest,
          role: summary.role,
          checkout: {
            mode,
            rootPath: checkout.rootPath,
            cacheRepoPath: checkout.cacheRepoPath,
          },
        };
      }
    }

    const azureReviewStore = {
      getState: () => ({ trackedPullRequests: {}, connections: {} }),
      getTrackedPullRequest: () => null,
      upsertTrackedPullRequest: vi.fn().mockResolvedValue(undefined),
      upsertConnectionState: vi.fn().mockResolvedValue(undefined),
    };

    const fixture = await createFixture({
      initialState: {
        activeWorkspaceId: "workspace-review",
        workspaces: [
          {
            id: "azure-root",
            name: "Azure DevOps",
            kind: "azure",
            cwd: "C:/reviews",
            profileId: "default",
            panels: [],
          },
          {
            id: "workspace-review",
            name: "web-app PR #123",
            kind: "terminal",
            cwd: "C:/reviews/reviews/ado-main/pr-123",
            notes: "Azure DevOps review workspace for web-app PR #123",
            profileId: "default",
            activePanelId: "shell",
            panels: [{ id: "shell", title: "Shell", command: "", startup: "default" }],
          },
        ],
      },
      dependencies: {
        AzureDevOpsManager: FakeAzureManager,
        createAzureReviewStore: async () => azureReviewStore,
      },
    });
    fixtures.push(fixture);

    const repairedWorkspace = fixture.runtime
      .getPayload()
      .appState.workspaces.find((workspace) => workspace.id === "workspace-review");
    expect(repairedWorkspace?.review).toMatchObject({
      provider: "azure-devops",
      parentWorkspaceId: "azure-root",
    });
    expect(azureReviewStore.upsertTrackedPullRequest).toHaveBeenCalledWith("ado-main:repo-1:123", {
      reviewWorkspaceId: "workspace-review",
    });
  });

  test("repairs persisted inactive azure review workspaces from tracked pull requests", async () => {
    class FakeAzureManager extends EventEmitter {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      declare snapshot: any;

      constructor() {
        super();
        this.snapshot = {
          connections: [],
          inbox: {
            needsMyReview: [],
            myPullRequests: [],
            recentlyUpdated: [],
            needsAttention: [],
          },
          trackedPullRequests: {},
          pullRequests: {},
          sync: { running: false, lastStartedAt: null, lastCompletedAt: null },
        };
      }

      getSnapshot() {
        return structuredClone(this.snapshot);
      }

      async sync() {
        return this.getSnapshot();
      }

      stopPolling() {}

      configurePolling() {}
    }

    const azureReviewStore = {
      getState: () => ({
        trackedPullRequests: {
          "ado-main:repo-1:123": {
            key: "ado-main:repo-1:123",
            connectionId: "ado-main",
            pullRequestId: 123,
            repositoryId: "repo-1",
            repositoryName: "web-app",
            projectName: "Platform",
          },
        },
        connections: {},
      }),
      getTrackedPullRequest: () => null,
      upsertTrackedPullRequest: vi.fn().mockResolvedValue(undefined),
      upsertConnectionState: vi.fn().mockResolvedValue(undefined),
    };

    const fixture = await createFixture({
      initialState: {
        activeWorkspaceId: "workspace-review",
        settings: {
          integrations: {
            azureDevops: {
              enabled: true,
              reviewRoot: "C:/reviews",
              defaultPollSeconds: 120,
              connections: [
                {
                  id: "ado-main",
                  enabled: true,
                  orgUrl: "https://dev.azure.com/acme",
                  login: "me@example.com",
                  tokenRef: "cred:ado-main",
                  reviewRoot: "C:/reviews",
                },
              ],
            },
          },
        },
        workspaces: [
          {
            id: "azure-root",
            name: "Azure DevOps",
            kind: "azure",
            cwd: "C:/reviews",
            profileId: "default",
            panels: [],
          },
          {
            id: "workspace-review",
            name: "web-app PR #123",
            kind: "terminal",
            cwd: "C:/reviews/reviews/ado-main-a2ae23c8c9/pr-123",
            notes: "Azure DevOps review workspace for web-app PR #123",
            profileId: "default",
            activePanelId: "shell",
            panels: [{ id: "shell", title: "Shell", command: "", startup: "default" }],
          },
        ],
      },
      dependencies: {
        AzureDevOpsManager: FakeAzureManager,
        createAzureReviewStore: async () => azureReviewStore,
      },
    });
    fixtures.push(fixture);

    const repairedWorkspace = fixture.runtime
      .getPayload()
      .appState.workspaces.find((workspace) => workspace.id === "workspace-review");
    expect(repairedWorkspace?.review).toMatchObject({
      provider: "azure-devops",
      prKey: "ado-main:repo-1:123",
      parentWorkspaceId: "azure-root",
    });
  });

  test("raises and clears project alerts for background terminal exits", async () => {
    const fixture = await createFixture({
      initialState: {
        activeProjectId: "frontend",
        projects: [
          {
            id: "frontend",
            name: "Frontend",
            kind: "terminal",
            cwd: "/tmp/frontend",
            activePanelId: "claude",
            panels: [{ id: "claude", title: "Claude Code", command: "claude", shell: true, startup: "default" }],
          },
          {
            id: "backend",
            name: "Backend",
            kind: "terminal",
            cwd: "/tmp/backend",
            activePanelId: "shell",
            panels: [
              { id: "shell", title: "Shell", command: "", shell: true, startup: "default" },
              // alertsForceOn: shell-completion alerts are globally suppressed by
              // notifications.agentsOnly (default true). This panel opts back in
              // explicitly because the test asserts the exit-alert fires.
              {
                id: "tests",
                title: "Tests",
                command: "npm test",
                shell: true,
                startup: "manual",
                alertsForceOn: true,
              },
            ],
          },
        ],
      },
    });
    fixtures.push(fixture);

    await fixture.runtime.syncAttentionContext({ visibleSessionIds: ["frontend:claude"] });

    // Create signal and mark session as user-interactive
    fixture.sessionManager.emit("terminal:data", { sessionId: "backend:tests", data: "$ " });
    fixture.runtime.writeToSession("backend:tests", "npm test\r");

    fixture.sessionManager.emit("terminal:exit", {
      sessionId: "backend:tests",
      exitCode: 2,
      intentional: false,
    });

    expect(fixture.runtime.getPayload().attention.byProject.backend).toMatchObject({
      count: 1,
    });
    expect(fixture.runtime.getPayload().attention.byProject.backend.alerts[0]).toMatchObject({
      panelId: "tests",
      exitCode: 2,
    });

    // Switching to the tab should NOT clear the alert — it stays until user types
    const payload = await fixture.runtime.activateSession("backend:tests");

    expect(payload.attention.byProject.backend).toMatchObject({ count: 1 });
    expect(payload.appState.activeProjectId).toBe("backend");
    expect(payload.workspace.project.activePanelId).toBe("tests");

    // Typing before 15s should NOT clear the alert
    fixture.runtime.writeToSession("backend:tests", "x");
    expect(fixture.runtime.getPayload().attention.byProject.backend).toMatchObject({ count: 1 });

    // Typing after 15s should clear the alert
    const originalNow = Date.now;
    Date.now = () => originalNow() + 16_000;
    try {
      fixture.runtime.writeToSession("backend:tests", "x");
      expect(fixture.runtime.getPayload().attention.byProject.backend).toBeUndefined();
    } finally {
      Date.now = originalNow;
    }
  });

  test("agentsOnly suppresses shell-exit alert (default behaviour)", async () => {
    // No alertsForceOn on the panel; default settings have agentsOnly=true.
    // A non-agent shell session that exits should NOT raise a project alert.
    const fixture = await createFixture({
      initialState: {
        activeProjectId: "frontend",
        projects: [
          {
            id: "backend",
            name: "Backend",
            kind: "terminal",
            cwd: "/tmp/backend",
            activePanelId: "tests",
            panels: [{ id: "tests", title: "Tests", command: "npm test", shell: true, startup: "manual" }],
          },
        ],
      },
    });
    fixtures.push(fixture);

    await fixture.runtime.syncAttentionContext({ visibleSessionIds: [] });

    // Mark session as user-interactive (alerts only fire for sessions the user touched).
    fixture.sessionManager.emit("terminal:data", { sessionId: "backend:tests", data: "$ " });
    fixture.runtime.writeToSession("backend:tests", "npm test\r");
    fixture.sessionManager.emit("terminal:exit", { sessionId: "backend:tests", exitCode: 1, intentional: false });

    expect(fixture.runtime.getPayload().attention.byProject.backend).toBeUndefined();
  });

  test("agentsOnly=false (legacy) still raises shell-exit alert", async () => {
    const fixture = await createFixture({
      initialState: {
        activeProjectId: "frontend",
        settings: { notifications: { agentsOnly: false } },
        projects: [
          {
            id: "backend",
            name: "Backend",
            kind: "terminal",
            cwd: "/tmp/backend",
            activePanelId: "tests",
            panels: [{ id: "tests", title: "Tests", command: "npm test", shell: true, startup: "manual" }],
          },
        ],
      },
    });
    fixtures.push(fixture);

    await fixture.runtime.syncAttentionContext({ visibleSessionIds: [] });

    fixture.sessionManager.emit("terminal:data", { sessionId: "backend:tests", data: "$ " });
    fixture.runtime.writeToSession("backend:tests", "npm test\r");
    fixture.sessionManager.emit("terminal:exit", { sessionId: "backend:tests", exitCode: 1, intentional: false });

    expect(fixture.runtime.getPayload().attention.byProject.backend).toMatchObject({ count: 1 });
  });

  test("does not raise exit alerts for sessions without user input", async () => {
    const fixture = await createFixture();
    fixtures.push(fixture);

    await fixture.runtime.syncAttentionContext({ visibleSessionIds: ["frontend:claude"] });

    // Shell produces output but user never types
    fixture.sessionManager.emit("terminal:data", { sessionId: "backend:tests", data: "$ " });

    fixture.sessionManager.emit("terminal:exit", {
      sessionId: "backend:tests",
      exitCode: 0,
      intentional: false,
    });

    expect(fixture.runtime.getPayload().attention.byProject.backend).toBeUndefined();
  });

  test("does not raise alerts for terminals that are currently visible", async () => {
    const fixture = await createFixture();
    fixtures.push(fixture);

    await fixture.runtime.syncAttentionContext({ visibleSessionIds: ["backend:tests"] });
    fixture.sessionManager.emit("terminal:exit", {
      sessionId: "backend:tests",
      exitCode: 2,
      intentional: false,
    });

    expect(fixture.runtime.getPayload().attention.byProject.backend).toBeUndefined();
  });

  test("does not raise alerts for plugin-backed terminal projects", async () => {
    const fixture = await createFixture({
      initialState: {
        activeProjectId: "frontend",
        projects: [
          {
            id: "frontend",
            name: "Frontend",
            icon: "FE",
            color: "#ffa424",
            kind: "terminal",
            source: "manual",
            pluginId: "",
            cwd: "/tmp/frontend",
            activePanelId: "dev",
            panels: [{ id: "dev", title: "Dev", command: "npm run dev", shell: true, startup: "default" }],
          },
          {
            id: "system-monitor",
            name: "System Monitor",
            icon: "SM",
            color: "#e0a040",
            kind: "terminal",
            source: "plugin",
            pluginId: "system-monitor",
            cwd: "/tmp/system-monitor",
            activePanelId: "monitor",
            panels: [{ id: "monitor", title: "Monitor", command: "btm", shell: true, startup: "default" }],
          },
        ],
      },
    });
    fixtures.push(fixture);

    fixture.sessionManager.emit("terminal:exit", {
      sessionId: "system-monitor:monitor",
      exitCode: 2,
      intentional: false,
    });

    expect(fixture.runtime.getPayload().attention.byProject["system-monitor"]).toBeUndefined();
  });

  test("raises waiting alerts when an agent terminal returns to prompt after work", async () => {
    vi.useFakeTimers();
    try {
      const fixture = await createFixture({
        initialState: {
          activeProjectId: "frontend",
          projects: [
            {
              id: "frontend",
              name: "Frontend",
              icon: "FE",
              color: "#ffa424",
              kind: "terminal",
              source: "manual",
              pluginId: "",
              cwd: "/tmp/frontend",
              activePanelId: "codex",
              panels: [{ id: "codex", title: "Codex", command: "codex", shell: true, startup: "default" }],
            },
          ],
          settings: {
            notifications: { agentHook: false },
          },
        },
      });
      fixtures.push(fixture);

      // Advance past the per-session cooldown (15s) — the signal is created
      // with lastAlertAt=Date.now() to suppress alerts from buffer replay.
      // Send a dummy event first to create the signal, then advance time.
      fixture.sessionManager.emit("terminal:data", { sessionId: "frontend:codex", data: "" });
      await vi.advanceTimersByTimeAsync(16_000);

      // Simulate user input so hasUserInput gate is satisfied
      fixture.runtime.writeToSession("frontend:codex", "fix the bug\r");

      // Agent output must contain a keyword from AGENT_OUTPUT_RE to set agentLike=true
      fixture.sessionManager.emit("terminal:data", {
        sessionId: "frontend:codex",
        data: "Codex is planning changes\r\nApplying patch\r\n",
      });
      fixture.sessionManager.emit("terminal:data", {
        sessionId: "frontend:codex",
        data: "PS C:\\repo> ",
      });

      // Agent sessions use a longer quiet period before raising prompt-returned
      // alerts. Default after Phase 1 is 45s. Advance past it.
      await vi.advanceTimersByTimeAsync(46_000);

      expect(fixture.runtime.getPayload().attention.byProject.frontend).toMatchObject({
        count: 1,
      });
      expect(fixture.runtime.getPayload().attention.byProject.frontend.alerts[0]).toMatchObject({
        panelId: "codex",
        kind: "waiting",
        detail: "prompt-returned",
        tier: 3,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  test("does not raise waiting alerts for plugin-backed terminal projects", async () => {
    vi.useFakeTimers();
    try {
      const fixture = await createFixture({
        initialState: {
          activeProjectId: "system-monitor",
          projects: [
            {
              id: "system-monitor",
              name: "System Monitor",
              icon: "SM",
              color: "#e0a040",
              kind: "terminal",
              source: "plugin",
              pluginId: "system-monitor",
              cwd: "/tmp/system-monitor",
              activePanelId: "monitor",
              panels: [{ id: "monitor", title: "Monitor", command: "codex", shell: true, startup: "default" }],
            },
          ],
        },
      });
      fixtures.push(fixture);

      fixture.sessionManager.emit("terminal:data", {
        sessionId: "system-monitor:monitor",
        data: "Working...\r\n",
      });
      fixture.sessionManager.emit("terminal:data", {
        sessionId: "system-monitor:monitor",
        data: "PS C:\\repo> ",
      });

      await vi.advanceTimersByTimeAsync(950);

      expect(fixture.runtime.getPayload().attention.byProject["system-monitor"]).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  test("respects custom agentQuietMs from notification settings", async () => {
    vi.useFakeTimers();
    try {
      const fixture = await createFixture({
        initialState: {
          activeProjectId: "frontend",
          projects: [
            {
              id: "frontend",
              name: "Frontend",
              kind: "terminal",
              cwd: "/tmp/frontend",
              activePanelId: "claude",
              panels: [{ id: "claude", title: "Claude Code", command: "claude", shell: true, startup: "default" }],
            },
          ],
          settings: {
            notifications: {
              agentHook: false,
              agentQuietMs: 30_000,
              agentQuietFastMs: 15_000,
              alertCooldownMs: 15_000,
            },
          },
        },
      });
      fixtures.push(fixture);

      fixture.sessionManager.emit("terminal:data", { sessionId: "frontend:claude", data: "" });
      await vi.advanceTimersByTimeAsync(16_000);

      fixture.runtime.writeToSession("frontend:claude", "fix the bug\r");
      fixture.sessionManager.emit("terminal:data", {
        sessionId: "frontend:claude",
        data: "Claude is working\r\n",
      });
      fixture.sessionManager.emit("terminal:data", {
        sessionId: "frontend:claude",
        data: "> ",
      });

      // Default 20s would have fired — but custom setting is 30s
      await vi.advanceTimersByTimeAsync(21_000);
      expect(fixture.runtime.getPayload().attention.byProject.frontend).toBeUndefined();

      // After 30s total silence, alert should fire
      await vi.advanceTimersByTimeAsync(10_000);
      expect(fixture.runtime.getPayload().attention.byProject.frontend).toMatchObject({ count: 1 });
    } finally {
      vi.useRealTimers();
    }
  });

  test("agent silence timeout requires idle-looking last line to raise alert", async () => {
    vi.useFakeTimers();
    try {
      const fixture = await createFixture({
        initialState: {
          activeProjectId: "frontend",
          projects: [
            {
              id: "frontend",
              name: "Frontend",
              kind: "terminal",
              cwd: "/tmp/frontend",
              activePanelId: "claude",
              panels: [{ id: "claude", title: "Claude Code", command: "claude", shell: true, startup: "default" }],
            },
          ],
        },
      });
      fixtures.push(fixture);

      fixture.sessionManager.emit("terminal:data", { sessionId: "frontend:claude", data: "" });
      await vi.advanceTimersByTimeAsync(16_000);

      fixture.runtime.writeToSession("frontend:claude", "fix the bug\r");
      fixture.sessionManager.emit("terminal:data", {
        sessionId: "frontend:claude",
        data: "Claude is working on something complex\r\n",
      });
      // Last line looks like mid-stream output, not an idle prompt
      fixture.sessionManager.emit("terminal:data", {
        sessionId: "frontend:claude",
        data: "Processing file src/app.js...\r\n",
      });

      await vi.advanceTimersByTimeAsync(21_000);
      // Should NOT raise alert because last line doesn't look like idle prompt
      expect(fixture.runtime.getPayload().attention.byProject.frontend).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  test("notification settings are included in default state", async () => {
    const fixture = await createFixture();
    fixtures.push(fixture);

    const state = fixture.store.getState();
    expect(state.settings.notifications).toBeDefined();
    // Phase 1 raised defaults — 900→2500 and 20s→45s.
    expect(state.settings.notifications.promptQuietMs).toBe(2500);
    expect(state.settings.notifications.agentQuietMs).toBe(45_000);
    expect(state.settings.notifications.agentQuietFastMs).toBe(25_000);
    expect(state.settings.notifications.alertCooldownMs).toBe(15_000);
    expect(state.settings.notifications.shellIntegration).toBe(true);
    expect(state.settings.notifications.agentHook).toBe(true);
    expect(state.settings.notifications.userInteractionGraceMs).toBe(10_000);
    expect(state.settings.notifications.debug).toBe(false);
  });

  test("notify server info is exposed via getNotifyServerInfo()", async () => {
    const fixture = await createFixture();
    fixtures.push(fixture);

    const info = fixture.runtime.getNotifyServerInfo();
    expect(info).toBeDefined();
    expect(info.enabled).toBe(true);
    expect(info.port).toBeGreaterThan(0);
  });

  test("notify server is not started when agentHook is disabled", async () => {
    const fixture = await createFixture({
      initialState: {
        settings: {
          notifications: { agentHook: false },
        },
      },
    });
    fixtures.push(fixture);

    const info = fixture.runtime.getNotifyServerInfo();
    expect(info.enabled).toBe(false);
    expect(info.port).toBeNull();
  });

  test("UserPromptSubmit marks agent session activity in attention snapshot", async () => {
    const fixture = await createFixture({
      initialState: {
        activeProjectId: "backend",
        projects: [
          {
            id: "backend",
            name: "Backend",
            kind: "terminal",
            cwd: "/tmp/backend",
            activePanelId: "codex",
            panels: [{ id: "codex", title: "Codex", command: "codex", shell: true, startup: "default" }],
          },
        ],
      },
    });
    fixtures.push(fixture);

    fixture.runtime.notifyAgentHook("backend:codex", "", "UserPromptSubmit");

    expect(fixture.runtime.getPayload().attention.sessions["backend:codex"]).toMatchObject({
      workspaceId: "backend",
      panelId: "codex",
      activity: "running",
      agentLike: true,
      hasUserInput: true,
    });
  });

  test("SubagentStop does not mark the main agent session done", async () => {
    const fixture = await createFixture({
      initialState: {
        activeProjectId: "backend",
        projects: [
          {
            id: "backend",
            name: "Backend",
            kind: "terminal",
            cwd: "/tmp/backend",
            activePanelId: "claude",
            panels: [{ id: "claude", title: "Claude", command: "claude", shell: true, startup: "default" }],
          },
        ],
      },
    });
    fixtures.push(fixture);

    fixture.runtime.notifyAgentHook("backend:claude", "", "UserPromptSubmit");
    fixture.runtime.notifyAgentHook("backend:claude", "", "SubagentStop");

    expect(fixture.runtime.getPayload().attention.sessions["backend:claude"]).toMatchObject({
      activity: "running",
      agentLike: true,
      hasUserInput: true,
    });
  });

  test("SubagentStop does not raise a user alert by default (only the turn-end Stop does)", async () => {
    vi.useFakeTimers();
    try {
      const fixture = await createFixture({
        initialState: {
          activeProjectId: "frontend",
          projects: [
            {
              id: "frontend",
              name: "Frontend",
              kind: "terminal",
              cwd: "/tmp/frontend",
              activePanelId: "claude",
              panels: [{ id: "claude", title: "Claude Code", command: "claude", shell: true, startup: "default" }],
            },
            {
              id: "backend",
              name: "Backend",
              kind: "terminal",
              cwd: "/tmp/backend",
              activePanelId: "shell",
              panels: [{ id: "shell", title: "Shell", command: "", shell: true, startup: "default" }],
            },
          ],
        },
      });
      fixtures.push(fixture);

      await fixture.runtime.syncAttentionContext({ visibleSessionIds: ["frontend:claude"] });
      fixture.sessionManager.emit("terminal:data", { sessionId: "backend:shell", data: "$ " });
      await vi.advanceTimersByTimeAsync(16_000);
      fixture.runtime.writeToSession("backend:shell", "claude\r");

      // A sub-agent finishing mid-turn is internal noise — no alert.
      fixture.runtime.notifyAgentHook("backend:shell", "", "SubagentStop");
      expect(fixture.runtime.getPayload().attention.byProject.backend).toBeUndefined();

      // The eventual turn-end Stop still alerts as before.
      fixture.runtime.notifyAgentHook("backend:shell", "", "Stop");
      const payload = fixture.runtime.getPayload();
      expect(payload.attention.byProject.backend).toMatchObject({ count: 1 });
      expect(payload.attention.byProject.backend.alerts[0]).toMatchObject({
        panelId: "shell",
        kind: "completed",
        detail: "hook:Stop",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  test("SubagentStop raises a subagent_done alert when notifications.subagentCompletion is enabled", async () => {
    vi.useFakeTimers();
    try {
      const fixture = await createFixture({
        initialState: {
          activeProjectId: "frontend",
          settings: {
            notifications: { subagentCompletion: true },
          },
          projects: [
            {
              id: "frontend",
              name: "Frontend",
              kind: "terminal",
              cwd: "/tmp/frontend",
              activePanelId: "claude",
              panels: [{ id: "claude", title: "Claude Code", command: "claude", shell: true, startup: "default" }],
            },
            {
              id: "backend",
              name: "Backend",
              kind: "terminal",
              cwd: "/tmp/backend",
              activePanelId: "shell",
              panels: [{ id: "shell", title: "Shell", command: "", shell: true, startup: "default" }],
            },
          ],
        },
      });
      fixtures.push(fixture);

      await fixture.runtime.syncAttentionContext({ visibleSessionIds: ["frontend:claude"] });
      fixture.sessionManager.emit("terminal:data", { sessionId: "backend:shell", data: "$ " });
      await vi.advanceTimersByTimeAsync(16_000);
      fixture.runtime.writeToSession("backend:shell", "claude\r");

      fixture.runtime.notifyAgentHook("backend:shell", "", "SubagentStop");
      const payload = fixture.runtime.getPayload();
      expect(payload.attention.byProject.backend).toMatchObject({ count: 1 });
      expect(payload.attention.byProject.backend.alerts[0]).toMatchObject({
        panelId: "shell",
        kind: "subagent_done",
        detail: "hook:SubagentStop",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  test("notifyAgentHook raises instant alert for idle_prompt", async () => {
    vi.useFakeTimers();
    try {
      const fixture = await createFixture({
        initialState: {
          activeProjectId: "frontend",
          projects: [
            {
              id: "frontend",
              name: "Frontend",
              kind: "terminal",
              cwd: "/tmp/frontend",
              activePanelId: "claude",
              panels: [{ id: "claude", title: "Claude Code", command: "claude", shell: true, startup: "default" }],
            },
            {
              id: "backend",
              name: "Backend",
              kind: "terminal",
              cwd: "/tmp/backend",
              activePanelId: "shell",
              panels: [{ id: "shell", title: "Shell", command: "", shell: true, startup: "default" }],
            },
          ],
        },
      });
      fixtures.push(fixture);

      // Make the backend tab NOT visible, frontend IS visible
      await fixture.runtime.syncAttentionContext({ visibleSessionIds: ["frontend:claude"] });

      // Create signal for backend:shell, advance past initial cooldown
      fixture.sessionManager.emit("terminal:data", { sessionId: "backend:shell", data: "$ " });
      await vi.advanceTimersByTimeAsync(16_000);

      // User input arms the alert system
      fixture.runtime.writeToSession("backend:shell", "claude\r");

      // Simulate Claude Code finishing — calls the hook
      fixture.runtime.notifyAgentHook("backend:shell", "idle_prompt");

      const payload = fixture.runtime.getPayload();
      expect(payload.attention.byProject.backend).toMatchObject({ count: 1 });
      expect(payload.attention.byProject.backend.alerts[0]).toMatchObject({
        panelId: "shell",
        kind: "waiting",
        detail: "hook:Notification:idle_prompt",
        tier: 1,
        urgency: "normal",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  test("notifyAgentHook raises alert with permission detail for permission_prompt", async () => {
    vi.useFakeTimers();
    try {
      const fixture = await createFixture({
        initialState: {
          activeProjectId: "frontend",
          projects: [
            {
              id: "frontend",
              name: "Frontend",
              kind: "terminal",
              cwd: "/tmp/frontend",
              activePanelId: "claude",
              panels: [{ id: "claude", title: "Claude Code", command: "claude", shell: true, startup: "default" }],
            },
            {
              id: "backend",
              name: "Backend",
              kind: "terminal",
              cwd: "/tmp/backend",
              activePanelId: "shell",
              panels: [{ id: "shell", title: "Shell", command: "", shell: true, startup: "default" }],
            },
          ],
        },
      });
      fixtures.push(fixture);

      await fixture.runtime.syncAttentionContext({ visibleSessionIds: ["frontend:claude"] });
      fixture.sessionManager.emit("terminal:data", { sessionId: "backend:shell", data: "$ " });
      await vi.advanceTimersByTimeAsync(16_000);
      fixture.runtime.writeToSession("backend:shell", "claude\r");

      fixture.runtime.notifyAgentHook("backend:shell", "permission_prompt");

      expect(fixture.runtime.getPayload().attention.byProject.backend.alerts[0]).toMatchObject({
        detail: "hook:Notification:permission_prompt",
        tier: 1,
        urgency: "urgent",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  test("notifyAgentHook does not alert without user input", async () => {
    vi.useFakeTimers();
    try {
      const fixture = await createFixture({
        initialState: {
          activeProjectId: "frontend",
          projects: [
            {
              id: "frontend",
              name: "Frontend",
              kind: "terminal",
              cwd: "/tmp/frontend",
              activePanelId: "claude",
              panels: [{ id: "claude", title: "Claude Code", command: "claude", shell: true, startup: "default" }],
            },
            {
              id: "backend",
              name: "Backend",
              kind: "terminal",
              cwd: "/tmp/backend",
              activePanelId: "shell",
              panels: [{ id: "shell", title: "Shell", command: "", shell: true, startup: "default" }],
            },
          ],
        },
      });
      fixtures.push(fixture);

      await fixture.runtime.syncAttentionContext({ visibleSessionIds: ["frontend:claude"] });
      // Create signal but NO user input
      fixture.sessionManager.emit("terminal:data", { sessionId: "backend:shell", data: "$ " });
      await vi.advanceTimersByTimeAsync(16_000);

      fixture.runtime.notifyAgentHook("backend:shell", "idle_prompt");

      expect(fixture.runtime.getPayload().attention.byProject.backend).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  test("notifyAgentHook does not alert for visible sessions", async () => {
    vi.useFakeTimers();
    try {
      const fixture = await createFixture({
        initialState: {
          activeProjectId: "frontend",
          projects: [
            {
              id: "frontend",
              name: "Frontend",
              kind: "terminal",
              cwd: "/tmp/frontend",
              activePanelId: "claude",
              panels: [{ id: "claude", title: "Claude Code", command: "claude", shell: true, startup: "default" }],
            },
          ],
        },
      });
      fixtures.push(fixture);

      // Session IS visible
      await fixture.runtime.syncAttentionContext({ visibleSessionIds: ["frontend:claude"] });
      fixture.sessionManager.emit("terminal:data", { sessionId: "frontend:claude", data: "" });
      await vi.advanceTimersByTimeAsync(16_000);
      fixture.runtime.writeToSession("frontend:claude", "fix bug\r");

      fixture.runtime.notifyAgentHook("frontend:claude", "idle_prompt");

      expect(fixture.runtime.getPayload().attention.byProject.frontend).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  test("notifyAgentHook respects alert cooldown", async () => {
    vi.useFakeTimers();
    try {
      const fixture = await createFixture({
        initialState: {
          activeProjectId: "frontend",
          projects: [
            {
              id: "frontend",
              name: "Frontend",
              kind: "terminal",
              cwd: "/tmp/frontend",
              activePanelId: "claude",
              panels: [{ id: "claude", title: "Claude Code", command: "claude", shell: true, startup: "default" }],
            },
            {
              id: "backend",
              name: "Backend",
              kind: "terminal",
              cwd: "/tmp/backend",
              activePanelId: "shell",
              panels: [{ id: "shell", title: "Shell", command: "", shell: true, startup: "default" }],
            },
          ],
        },
      });
      fixtures.push(fixture);

      await fixture.runtime.syncAttentionContext({ visibleSessionIds: ["frontend:claude"] });
      fixture.sessionManager.emit("terminal:data", { sessionId: "backend:shell", data: "$ " });
      // Signal starts with lastAlertAt = Date.now() (initial cooldown), so advance past it
      await vi.advanceTimersByTimeAsync(16_000);
      fixture.runtime.writeToSession("backend:shell", "claude\r");

      // First alert succeeds
      fixture.runtime.notifyAgentHook("backend:shell", "idle_prompt");
      expect(fixture.runtime.getPayload().attention.byProject.backend).toMatchObject({ count: 1 });

      // Clear the alert, simulate user responding
      fixture.runtime.clearAllAttention();
      fixture.runtime.writeToSession("backend:shell", "yes\r");

      // Second alert within cooldown — should be suppressed
      fixture.runtime.notifyAgentHook("backend:shell", "idle_prompt");
      expect(fixture.runtime.getPayload().attention.byProject.backend).toBeUndefined();

      // After cooldown passes, alert should work again
      await vi.advanceTimersByTimeAsync(16_000);
      fixture.runtime.notifyAgentHook("backend:shell", "idle_prompt");
      expect(fixture.runtime.getPayload().attention.byProject.backend).toMatchObject({ count: 1 });
    } finally {
      vi.useRealTimers();
    }
  });

  test("clearAllAttention does not silence fresh sessions that never alerted", async () => {
    vi.useFakeTimers();
    try {
      const fixture = await createFixture({
        initialState: {
          activeProjectId: "frontend",
          projects: [
            {
              id: "frontend",
              name: "Frontend",
              kind: "terminal",
              cwd: "/tmp/frontend",
              activePanelId: "claude",
              panels: [{ id: "claude", title: "Claude Code", command: "claude", shell: true, startup: "default" }],
            },
            {
              id: "backend",
              name: "Backend",
              kind: "terminal",
              cwd: "/tmp/backend",
              activePanelId: "shell",
              panels: [{ id: "shell", title: "Shell", command: "", shell: true, startup: "default" }],
            },
          ],
        },
      });
      fixtures.push(fixture);

      await fixture.runtime.syncAttentionContext({ visibleSessionIds: ["frontend:claude"] });
      fixture.sessionManager.emit("terminal:data", { sessionId: "backend:shell", data: "$ " });
      // Advance past the initial-warmup cooldown.
      await vi.advanceTimersByTimeAsync(16_000);
      fixture.runtime.writeToSession("backend:shell", "claude\r");

      // User clicks "Clear all" before any alert ever fired on this session.
      // Previously this seeded lastAlertAt=now and silenced the next ~15s
      // worth of valid hooks. With the fix, fresh signals are unaffected.
      fixture.runtime.clearAllAttention();

      // A hook arriving immediately after clear should still raise an alert.
      fixture.runtime.notifyAgentHook("backend:shell", "idle_prompt");
      expect(fixture.runtime.getPayload().attention.byProject.backend).toMatchObject({ count: 1 });
    } finally {
      vi.useRealTimers();
    }
  });

  test("notifyAgentHook ignores irrelevant notification types", async () => {
    vi.useFakeTimers();
    try {
      const fixture = await createFixture({
        initialState: {
          activeProjectId: "frontend",
          projects: [
            {
              id: "frontend",
              name: "Frontend",
              kind: "terminal",
              cwd: "/tmp/frontend",
              activePanelId: "claude",
              panels: [{ id: "claude", title: "Claude Code", command: "claude", shell: true, startup: "default" }],
            },
            {
              id: "backend",
              name: "Backend",
              kind: "terminal",
              cwd: "/tmp/backend",
              activePanelId: "shell",
              panels: [{ id: "shell", title: "Shell", command: "", shell: true, startup: "default" }],
            },
          ],
        },
      });
      fixtures.push(fixture);

      await fixture.runtime.syncAttentionContext({ visibleSessionIds: ["frontend:claude"] });
      fixture.sessionManager.emit("terminal:data", { sessionId: "backend:shell", data: "$ " });
      await vi.advanceTimersByTimeAsync(16_000);
      fixture.runtime.writeToSession("backend:shell", "claude\r");

      fixture.runtime.notifyAgentHook("backend:shell", "auth_success");
      expect(fixture.runtime.getPayload().attention.byProject.backend).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  test("notifyAgentHook ignores unknown session IDs", async () => {
    const fixture = await createFixture();
    fixtures.push(fixture);

    // Should not throw
    fixture.runtime.notifyAgentHook("nonexistent:panel", "idle_prompt");
    expect(fixture.runtime.getPayload().attention.byProject.nonexistent).toBeUndefined();
  });

  test("updateSettings toggles notify server on and off", async () => {
    const fixture = await createFixture();
    fixtures.push(fixture);

    // Initially enabled
    expect(fixture.runtime.getNotifyServerInfo().enabled).toBe(true);
    const initialPort = fixture.runtime.getNotifyServerInfo().port;
    expect(initialPort).toBeGreaterThan(0);

    // Disable
    await fixture.runtime.updateSettings({
      notifications: { agentHook: false },
    });
    expect(fixture.runtime.getNotifyServerInfo().enabled).toBe(false);
    expect(fixture.runtime.getNotifyServerInfo().port).toBeNull();

    // Re-enable
    await fixture.runtime.updateSettings({
      notifications: { agentHook: true },
    });
    expect(fixture.runtime.getNotifyServerInfo().enabled).toBe(true);
    expect(fixture.runtime.getNotifyServerInfo().port).toBeGreaterThan(0);
  });

  test("STRIDETERM_NOTIFY_URL is injected into session env when notify server is running", async () => {
    const fixture = await createFixture({
      initialState: {
        activeProjectId: "proj",
        projects: [
          {
            id: "proj",
            name: "Proj",
            kind: "terminal",
            cwd: "/tmp/proj",
            activePanelId: "shell",
            panels: [{ id: "shell", title: "Shell", command: "", shell: true, startup: "default" }],
          },
        ],
      },
    });
    fixtures.push(fixture);

    // Notify server should be running
    expect(fixture.runtime.getNotifyServerInfo().enabled).toBe(true);

    // getSessionEnv callback should be captured by FakeSessionManager
    expect(fixture.sessionManager.getSessionEnv).toBeTypeOf("function");

    const env = fixture.sessionManager.getSessionEnv({
      workspace: { id: "proj", cwd: "/tmp/proj" },
      sessionId: "proj:shell",
    });
    expect(env.STRIDETERM_NOTIFY_URL).toBeDefined();
    expect(env.STRIDETERM_NOTIFY_URL).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/notify\?sid=proj%3Ashell&secret=.+$/);
  });

  test("STRIDETERM_NOTIFY_URL is not injected when notify server is disabled", async () => {
    const fixture = await createFixture({
      initialState: {
        settings: {
          notifications: { agentHook: false },
        },
        activeProjectId: "proj",
        projects: [
          {
            id: "proj",
            name: "Proj",
            kind: "terminal",
            cwd: "/tmp/proj",
            activePanelId: "shell",
            panels: [{ id: "shell", title: "Shell", command: "", shell: true, startup: "default" }],
          },
        ],
      },
    });
    fixtures.push(fixture);

    expect(fixture.runtime.getNotifyServerInfo().enabled).toBe(false);
    expect(fixture.sessionManager.getSessionEnv).toBeTypeOf("function");

    const env = fixture.sessionManager.getSessionEnv({
      workspace: { id: "proj", cwd: "/tmp/proj" },
      sessionId: "proj:shell",
    });
    expect(env.STRIDETERM_NOTIFY_URL).toBeUndefined();
  });

  test("restarts cloudflare tunnel and emits remote config changes when settings change", async () => {
    // remoteAccess defaults to disabled — this test covers the running-server
    // restart path, so seed the fixture with an enabled connection.
    const fixture = await createFixture({
      initialState: {
        settings: {
          remoteAccess: { enabled: true, host: "127.0.0.1", port: 43123, token: "abc" },
        },
      },
    });
    fixtures.push(fixture);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const configChanges: any[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    fixture.runtime.on("remote:config-changed", (payload: any) => configChanges.push(payload));

    fixture.tunnel.snapshot.status = "connected";
    const result = await fixture.runtime.updateSettings({
      remoteAccess: {
        port: 49999,
      },
    });

    expect(result.remoteAccessChanged).toBe(true);
    expect(fixture.checkRemoteOrigin).toHaveBeenCalledWith("http://127.0.0.1:49999");
    expect(fixture.tunnel.startCalls).toEqual(["http://127.0.0.1:49999"]);
    expect(configChanges).toHaveLength(1);
    expect(configChanges[0].port).toBe(49999);

    await fixture.runtime.updateSettings({
      remoteAccess: {
        enabled: false,
      },
    });

    expect(fixture.tunnel.stopCalls.at(-1)).toMatchObject({
      preserveAvailability: true,
      quiet: true,
    });
  });

  test("targets the configured remote host when creating a cloudflare tunnel", async () => {
    const fixture = await createFixture({
      initialState: {
        settings: {
          remoteAccess: {
            enabled: true,
            host: "192.168.1.25",
            port: 43123,
            token: "abc",
          },
        },
      },
    });
    fixtures.push(fixture);

    await fixture.runtime.createCloudflareTunnel();

    expect(fixture.checkRemoteOrigin).toHaveBeenCalledWith("http://192.168.1.25:43123");
    expect(fixture.tunnel.startCalls).toEqual(["http://192.168.1.25:43123"]);
  });

  test("opens docker session as a new panel and ensures a terminal session exists", async () => {
    const fixture = await createFixture({
      initialState: {
        activeProjectId: "docker",
        projects: [
          {
            id: "docker",
            name: "Docker",
            kind: "docker",
            cwd: "/tmp/docker",
            panels: [],
          },
        ],
      },
    });
    fixtures.push(fixture);

    const payload = await fixture.runtime.openDockerSession({
      projectId: "docker",
      containerId: "abc123",
      mode: "logs",
    });

    expect(payload.appState.activeProjectId).toBe("docker");
    expect(payload.workspace.project.activePanelId).toBe("logs-abc123");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(payload.workspace.project.panels.some((panel: any) => panel.id === "logs-abc123")).toBe(true);
    expect(fixture.sessionManager.sessions.has("docker:logs-abc123")).toBe(true);
    expect(fixture.sessionManager.syncedStates).not.toHaveLength(0);
  });

  test("creates git worktree, updates gitignore, and adds a cloned project", async () => {
    const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "strideterm-project-"));
    tempPaths.push(projectRoot);
    const fixture = await createFixture({
      initialState: {
        activeProjectId: "frontend",
        projects: [
          {
            id: "frontend",
            name: "Frontend",
            icon: "FE",
            color: "#ffa424",
            kind: "terminal",
            cwd: projectRoot,
            activePanelId: "dev",
            panels: [
              { id: "dev", title: "Dev", command: "npm run dev", shell: true, startup: "default" },
              { id: "tests", title: "Tests", command: "npm test", shell: true, startup: "manual" },
            ],
          },
        ],
      },
    });
    fixtures.push(fixture);

    const payload = await fixture.runtime.createWorktree({
      projectId: "frontend",
      name: "feature-x",
    });

    expect(fixture.execFileText).toHaveBeenCalledWith(
      "git",
      ["worktree", "add", path.join(projectRoot, ".strideterm", "tree", "feature-x"), "-b", "feature-x"],
      { cwd: projectRoot },
    );
    const gitignore = await fs.readFile(path.join(projectRoot, ".gitignore"), "utf8");
    expect(gitignore).toContain(".strideterm/");
    const projectWorkspaces = payload.appState.workspaces.filter((project) => project.kind !== "azure");
    expect(projectWorkspaces).toHaveLength(2);
    expect(payload.appState.activeProjectId).toBe(projectWorkspaces[1].id);
    expect(projectWorkspaces[1].cwd).toBe(path.join(projectRoot, ".strideterm", "tree", "feature-x"));
  });

  test("createWorktree mirrors active workspace into the caller's window slot", async () => {
    // Guards the slot-mirroring fix for the UI-flicker bug: without this,
    // creating a worktree only writes global activeWorkspaceId, the
    // per-window slot stays on the parent workspace, and the frontend
    // selector (slot-first) keeps showing the old workspace as active.
    const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "strideterm-worktree-slot-"));
    tempPaths.push(projectRoot);
    const fixture = await createFixture({
      initialState: {
        activeProjectId: "frontend",
        projects: [
          {
            id: "frontend",
            name: "Frontend",
            kind: "terminal",
            cwd: projectRoot,
            profileId: "default",
            activePanelId: "dev",
            panels: [{ id: "dev", title: "Dev", command: "", shell: true, startup: "default" }],
          },
        ],
        windowSlots: [
          {
            id: "win-1",
            profileId: "default",
            activeWorkspaceId: "frontend",
            activeSessionId: "",
            bounds: { x: 0, y: 0, width: 1280, height: 800 },
            lastFocusedAt: Date.now(),
          },
        ],
      },
    });
    fixtures.push(fixture);

    const payload = await fixture.runtime.createWorktree({ projectId: "frontend", name: "feature-slot" }, "win-1");

    const child = payload.appState.workspaces.find((p) => p.name === "Frontend / feature-slot");
    expect(child).toBeDefined();
    expect(payload.appState.activeProjectId).toBe(child!.id);
    expect(payload.appState.windowSlots?.find((s) => s.id === "win-1")?.activeWorkspaceId).toBe(child!.id);
  });

  test("createWorktree leaves window slot untouched when no windowId is given", async () => {
    // Legacy callers (and the few server paths that can't resolve a bound
    // window) must keep working — slot-aware mirroring is opt-in via the
    // windowId parameter, not a behavior change for global activation.
    const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "strideterm-worktree-noslot-"));
    tempPaths.push(projectRoot);
    const fixture = await createFixture({
      initialState: {
        activeProjectId: "frontend",
        projects: [
          {
            id: "frontend",
            name: "Frontend",
            kind: "terminal",
            cwd: projectRoot,
            profileId: "default",
            activePanelId: "dev",
            panels: [{ id: "dev", title: "Dev", command: "", shell: true, startup: "default" }],
          },
        ],
        windowSlots: [
          {
            id: "win-1",
            profileId: "default",
            activeWorkspaceId: "frontend",
            activeSessionId: "",
            bounds: { x: 0, y: 0, width: 1280, height: 800 },
            lastFocusedAt: Date.now(),
          },
        ],
      },
    });
    fixtures.push(fixture);

    const payload = await fixture.runtime.createWorktree({ projectId: "frontend", name: "feature-noslot" });

    const child = payload.appState.workspaces.find((p) => p.name === "Frontend / feature-noslot");
    expect(child).toBeDefined();
    expect(payload.appState.activeProjectId).toBe(child!.id);
    // Slot was NOT updated — this matches the legacy behavior the bug
    // reproduces; the slot-aware fix opts into the new behavior via windowId.
    expect(payload.appState.windowSlots?.find((s) => s.id === "win-1")?.activeWorkspaceId).toBe("frontend");
  });

  test("discovers worktrees per active profile when parent cwd is shared", async () => {
    const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "strideterm-shared-project-"));
    tempPaths.push(projectRoot);
    const worktreePath = path.join(projectRoot, ".strideterm", "tree", "feature-x");
    await fs.mkdir(worktreePath, { recursive: true });

    const fixture = await createFixture({
      initialState: {
        activeProfileId: "profile-b",
        activeProjectId: "shared-b",
        profiles: [
          { id: "default", name: "Default" },
          { id: "profile-b", name: "Profile B" },
        ],
        projects: [
          {
            id: "shared-default",
            name: "Shared",
            kind: "terminal",
            profileId: "default",
            cwd: projectRoot,
            activePanelId: "shell",
            panels: [{ id: "shell", title: "Shell", command: "", shell: true, startup: "default" }],
          },
          {
            id: "shared-b",
            name: "Shared",
            kind: "terminal",
            profileId: "profile-b",
            cwd: projectRoot,
            activePanelId: "shell",
            panels: [{ id: "shell", title: "Shell", command: "", shell: true, startup: "default" }],
          },
          {
            id: "existing-default-worktree",
            name: "Shared / feature-x",
            kind: "terminal",
            profileId: "default",
            cwd: worktreePath,
            notes: "Worktree of Shared",
            activePanelId: "shell",
            panels: [{ id: "shell", title: "Shell", command: "", shell: true, startup: "default" }],
          },
        ],
      },
    });
    fixtures.push(fixture);

    const matchingWorktrees = fixture.runtime
      .getPayload()
      .appState.workspaces.filter((project) => project.cwd === worktreePath);

    expect(matchingWorktrees.map((project) => project.profileId).sort()).toEqual(["default", "profile-b"]);
  });

  test("pruneOrphanedWorkspaces clears per-slot activeWorkspaceId using each slot's own profile", async () => {
    // Multi-window scenario: two profiles, each open in its own window. An
    // orphaned workspace lives in profile B. When pruneOrphans removes it,
    // every slot whose activeWorkspaceId pointed at the removed entry must
    // fall back to a sibling IN THAT SLOT'S PROFILE — not to whatever
    // windowSlots[0] happens to be (that's the bug; it would silently push
    // the wrong-profile workspace into profile B's window).
    const realRoot = await fs.mkdtemp(path.join(os.tmpdir(), "strideterm-prune-real-"));
    tempPaths.push(realRoot);
    const orphanRoot = path.join(realRoot, "gone");
    // orphanRoot intentionally never created — that's what makes it an orphan.
    const realRootB = await fs.mkdtemp(path.join(os.tmpdir(), "strideterm-prune-real-b-"));
    tempPaths.push(realRootB);

    const fixture = await createFixture({
      initialState: {
        activeProjectId: "ws-b-orphan",
        profiles: [
          { id: "default", name: "Default" },
          { id: "profile-b", name: "Profile B" },
        ],
        projects: [
          {
            id: "ws-default-keep",
            name: "Default Keep",
            kind: "terminal",
            profileId: "default",
            cwd: realRoot,
            activePanelId: "shell",
            panels: [{ id: "shell", title: "Shell", command: "", shell: true, startup: "default" }],
          },
          {
            id: "ws-b-orphan",
            name: "B Orphan",
            kind: "terminal",
            profileId: "profile-b",
            cwd: orphanRoot,
            activePanelId: "shell",
            panels: [{ id: "shell", title: "Shell", command: "", shell: true, startup: "default" }],
          },
          {
            id: "ws-b-keep",
            name: "B Keep",
            kind: "terminal",
            profileId: "profile-b",
            cwd: realRootB,
            activePanelId: "shell",
            panels: [{ id: "shell", title: "Shell", command: "", shell: true, startup: "default" }],
          },
        ],
        windowSlots: [
          {
            id: "win-default",
            profileId: "default",
            activeWorkspaceId: "ws-default-keep",
            activeSessionId: "",
            bounds: { x: 0, y: 0, width: 1280, height: 800 },
            lastFocusedAt: 1000,
          },
          {
            id: "win-b",
            profileId: "profile-b",
            activeWorkspaceId: "ws-b-orphan",
            activeSessionId: "",
            bounds: { x: 0, y: 0, width: 1280, height: 800 },
            lastFocusedAt: 2000,
          },
        ],
      },
    });
    fixtures.push(fixture);

    const removed = await fixture.runtime.pruneOrphanedWorkspaces();
    expect(removed).toBe(1);

    const state = fixture.runtime.getPayload().appState;
    expect(state.workspaces.map((p) => p.id).sort()).toEqual(["ws-b-keep", "ws-default-keep"]);

    const slotDefault = state.windowSlots!.find((s) => s.id === "win-default")!;
    const slotB = state.windowSlots!.find((s) => s.id === "win-b")!;
    expect(slotDefault.activeWorkspaceId).toBe("ws-default-keep");
    // The buggy behavior would either leave this as the stale orphan id or
    // pick a workspace from windowSlots[0]'s profile (ws-default-keep), both
    // wrong. The fix must pick a sibling in profile-b.
    expect(slotB.activeWorkspaceId).toBe("ws-b-keep");
  });

  test("resolveGitConnection uses the workspace's own profile, not windowSlots[0]", async () => {
    // Two profiles each open in their own window, each owning their own
    // Azure/GitHub connection. Without the fix, getAllProviderConnections
    // filters by windowSlots[0]?.profileId, so a git operation in window B
    // (profile-b) looks up its workspace's connectionId in a list that only
    // contains profile-default's connections — finds nothing — and falls
    // back to "no connection" / system git credentials, silently breaking
    // authenticated git ops in the non-primary window.
    const realRoot = await fs.mkdtemp(path.join(os.tmpdir(), "strideterm-provider-resolve-"));
    tempPaths.push(realRoot);

    const fixture = await createFixture({
      initialState: {
        activeProjectId: "ws-b",
        profiles: [
          { id: "default", name: "Default" },
          { id: "profile-b", name: "Profile B" },
        ],
        settings: {
          integrations: {
            azureDevops: {
              enabled: true,
              reviewRoot: realRoot,
              defaultPollSeconds: 120,
              connections: [
                {
                  id: "azure-default",
                  enabled: true,
                  orgUrl: "https://dev.azure.com/acme",
                  tokenRef: "cred:azure-default",
                  profileId: "default",
                },
              ],
            },
            github: {
              enabled: true,
              reviewRoot: realRoot,
              defaultPollSeconds: 120,
              connections: [
                {
                  id: "github-b",
                  enabled: true,
                  hostUrl: "https://github.com",
                  tokenRef: "cred:github-b",
                  profileId: "profile-b",
                },
              ],
            },
          },
        },
        projects: [
          {
            id: "ws-default",
            name: "Default Repo",
            kind: "terminal",
            profileId: "default",
            cwd: realRoot,
            connectionId: "azure-default",
            activePanelId: "shell",
            panels: [{ id: "shell", title: "Shell", command: "", shell: true, startup: "default" }],
          },
          {
            id: "ws-b",
            name: "B Repo",
            kind: "terminal",
            profileId: "profile-b",
            cwd: realRoot,
            connectionId: "github-b",
            activePanelId: "shell",
            panels: [{ id: "shell", title: "Shell", command: "", shell: true, startup: "default" }],
          },
        ],
        windowSlots: [
          {
            id: "win-default",
            profileId: "default",
            activeWorkspaceId: "ws-default",
            activeSessionId: "",
            bounds: { x: 0, y: 0, width: 1280, height: 800 },
            lastFocusedAt: 1000,
          },
          {
            id: "win-b",
            profileId: "profile-b",
            activeWorkspaceId: "ws-b",
            activeSessionId: "",
            bounds: { x: 0, y: 0, width: 1280, height: 800 },
            lastFocusedAt: 2000,
          },
        ],
      },
    });
    fixtures.push(fixture);

    // Clear any actions captured during init (refreshGit etc).
    fixture.git.actions.length = 0;

    await fixture.runtime.gitFetch({ workspaceId: "ws-b" });

    const action = fixture.git.actions.find((a: { kind: string }) => a.kind === "fetch");
    expect(action).toBeDefined();
    // The bug: action.connection would be null because resolveGitConnection
    // filters by windowSlots[0] = "default" and never finds "github-b".
    expect(action.connection).not.toBeNull();
    expect(action.connection.id).toBe("github-b");
  });

  test("payload.git.connections includes connections from every open profile", async () => {
    // The renderer (any window) receives the same payload. The connections
    // list must include every open profile's connections so each window can
    // surface its own profile's connections in the UI. Filtering this list
    // by windowSlots[0]?.profileId hides connections in non-primary windows.
    const realRoot = await fs.mkdtemp(path.join(os.tmpdir(), "strideterm-provider-payload-"));
    tempPaths.push(realRoot);

    const fixture = await createFixture({
      initialState: {
        profiles: [
          { id: "default", name: "Default" },
          { id: "profile-b", name: "Profile B" },
        ],
        settings: {
          integrations: {
            azureDevops: {
              enabled: true,
              reviewRoot: realRoot,
              defaultPollSeconds: 120,
              connections: [
                {
                  id: "azure-default",
                  enabled: true,
                  orgUrl: "https://dev.azure.com/acme",
                  tokenRef: "cred:azure-default",
                  profileId: "default",
                },
                {
                  id: "azure-b",
                  enabled: true,
                  orgUrl: "https://dev.azure.com/beta",
                  tokenRef: "cred:azure-b",
                  profileId: "profile-b",
                },
              ],
            },
          },
        },
        windowSlots: [
          {
            id: "win-default",
            profileId: "default",
            activeWorkspaceId: "",
            activeSessionId: "",
            bounds: { x: 0, y: 0, width: 1280, height: 800 },
            lastFocusedAt: 1000,
          },
          {
            id: "win-b",
            profileId: "profile-b",
            activeWorkspaceId: "",
            activeSessionId: "",
            bounds: { x: 0, y: 0, width: 1280, height: 800 },
            lastFocusedAt: 2000,
          },
        ],
      },
    });
    fixtures.push(fixture);

    const payload = fixture.runtime.getPayload();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const connections = (payload.git as any).connections as Array<{ id: string; profileId?: string }>;
    expect(connections.map((c) => c.id).sort()).toEqual(["azure-b", "azure-default"]);
    // profileId must be exposed so the renderer can filter by the window's
    // own profile when populating the connection picker.
    const byId = new Map(connections.map((c) => [c.id, c]));
    expect(byId.get("azure-default")?.profileId).toBe("default");
    expect(byId.get("azure-b")?.profileId).toBe("profile-b");
  });

  test("syncWorktrees removal rewires each slot to a sibling in the slot's own profile", async () => {
    // When a worktree disappears from disk, syncWorktrees removes its
    // workspace entries from every profile that had one. The fix must
    // re-point each window's slot.activeWorkspaceId at a sibling in
    // THAT slot's profile — not at a workspace from windowSlots[0]'s
    // profile (which would silently swap the wrong workspace into the
    // other window's pane).
    const parentRoot = await fs.mkdtemp(path.join(os.tmpdir(), "strideterm-syncwt-prune-"));
    tempPaths.push(parentRoot);
    // Worktree dir intentionally never created on disk → triggers removal path.
    const missingWorktreePath = path.join(parentRoot, ".strideterm", "tree", "gone");

    const fixture = await createFixture({
      initialState: {
        activeProjectId: "parent-default",
        profiles: [
          { id: "default", name: "Default" },
          { id: "profile-b", name: "Profile B" },
        ],
        projects: [
          {
            id: "parent-default",
            name: "Shared",
            kind: "terminal",
            profileId: "default",
            cwd: parentRoot,
            activePanelId: "shell",
            panels: [{ id: "shell", title: "Shell", command: "", shell: true, startup: "default" }],
          },
          {
            id: "parent-b",
            name: "Shared",
            kind: "terminal",
            profileId: "profile-b",
            cwd: parentRoot,
            activePanelId: "shell",
            panels: [{ id: "shell", title: "Shell", command: "", shell: true, startup: "default" }],
          },
          {
            id: "wt-default",
            name: "Shared / gone",
            kind: "terminal",
            profileId: "default",
            cwd: missingWorktreePath,
            notes: "Worktree of Shared",
            activePanelId: "shell",
            panels: [{ id: "shell", title: "Shell", command: "", shell: true, startup: "default" }],
          },
          {
            id: "wt-b",
            name: "Shared / gone",
            kind: "terminal",
            profileId: "profile-b",
            cwd: missingWorktreePath,
            notes: "Worktree of Shared",
            activePanelId: "shell",
            panels: [{ id: "shell", title: "Shell", command: "", shell: true, startup: "default" }],
          },
        ],
        windowSlots: [
          {
            id: "win-default",
            profileId: "default",
            activeWorkspaceId: "wt-default",
            activeSessionId: "",
            bounds: { x: 0, y: 0, width: 1280, height: 800 },
            lastFocusedAt: 1000,
          },
          {
            id: "win-b",
            profileId: "profile-b",
            activeWorkspaceId: "wt-b",
            activeSessionId: "",
            bounds: { x: 0, y: 0, width: 1280, height: 800 },
            lastFocusedAt: 2000,
          },
        ],
      },
    });
    fixtures.push(fixture);

    // createFixture's runtime init calls syncWorktrees, which detects both
    // worktrees as missing on disk and removes them.
    const state = fixture.runtime.getPayload().appState;
    expect(state.workspaces.map((p) => p.id).sort()).toEqual(["parent-b", "parent-default"]);

    const slotDefault = state.windowSlots!.find((s) => s.id === "win-default")!;
    const slotB = state.windowSlots!.find((s) => s.id === "win-b")!;
    expect(slotDefault.activeWorkspaceId).toBe("parent-default");
    expect(slotB.activeWorkspaceId).toBe("parent-b");
  });

  test("activateWorkspaceInWindow refuses cross-profile activation", async () => {
    // A remote client bound to profile B (or a stale UI request) must not
    // be able to point window-B's slot at a workspace that lives in
    // profile A. The runtime previously logged this as "crossProfile" but
    // honoured the request, silently swapping the user out of their
    // profile. The guard makes the misuse an explicit error.
    const fixture = await createFixture({
      initialState: {
        activeProjectId: "ws-a",
        profiles: [
          { id: "default", name: "Default" },
          { id: "profile-b", name: "Profile B" },
        ],
        projects: [
          {
            id: "ws-a",
            name: "A",
            kind: "terminal",
            profileId: "default",
            cwd: "/tmp/a",
            activePanelId: "shell",
            panels: [{ id: "shell", title: "Shell", command: "", shell: true, startup: "default" }],
          },
          {
            id: "ws-b",
            name: "B",
            kind: "terminal",
            profileId: "profile-b",
            cwd: "/tmp/b",
            activePanelId: "shell",
            panels: [{ id: "shell", title: "Shell", command: "", shell: true, startup: "default" }],
          },
        ],
        windowSlots: [
          {
            id: "win-b",
            profileId: "profile-b",
            activeWorkspaceId: "ws-b",
            activeSessionId: "",
            bounds: { x: 0, y: 0, width: 1280, height: 800 },
            lastFocusedAt: 1000,
          },
        ],
      },
    });
    fixtures.push(fixture);

    await expect(fixture.runtime.activateWorkspaceInWindow("ws-a", "win-b")).rejects.toThrow(
      /does not belong to window win-b's profile/i,
    );

    const slot = fixture.runtime.getPayload().appState.windowSlots!.find((s) => s.id === "win-b")!;
    expect(slot.activeWorkspaceId).toBe("ws-b"); // unchanged
  });

  test("setGridCell REFUSES placing a cross-profile workspace into another profile's grid", async () => {
    // Crafted/stale remote payload places `workspaceId` from profile A
    // into the grid resolved for profile B. The grid then renders cards
    // with cwds from the wrong profile in the user's window.
    const fixture = await createFixture({
      initialState: {
        activeProjectId: "ws-b",
        profiles: [
          { id: "default", name: "Default" },
          { id: "profile-b", name: "Profile B" },
        ],
        projects: [
          {
            id: "ws-a",
            name: "A",
            kind: "terminal",
            profileId: "default",
            cwd: "/tmp/a",
            activePanelId: "shell",
            panels: [{ id: "shell", title: "Shell", command: "", shell: true, startup: "default" }],
          },
          {
            id: "ws-b",
            name: "B",
            kind: "terminal",
            profileId: "profile-b",
            cwd: "/tmp/b",
            activePanelId: "shell",
            panels: [{ id: "shell", title: "Shell", command: "", shell: true, startup: "default" }],
          },
        ],
        windowSlots: [
          {
            id: "win-b",
            profileId: "profile-b",
            activeWorkspaceId: "ws-b",
            activeSessionId: "",
            bounds: { x: 0, y: 0, width: 1280, height: 800 },
            lastFocusedAt: 1000,
          },
        ],
      },
    });
    fixtures.push(fixture);

    // Enable a grid first (otherwise setGridCell is a no-op anyway).
    await fixture.runtime.enableWorkspaceGrid("cols", ["ws-b", null], "win-b");

    await expect(fixture.runtime.setGridCell(0, "ws-a", "win-b")).rejects.toThrow(/Cross-profile refused/i);
  });

  test("reorderWorkspaces preserves workspaces in other profiles when caller is profile-scoped", async () => {
    // A profile-scoped frontend / mobile client sends only its profile's
    // workspace IDs. Old behavior replaced the entire array with that
    // list — silently dropping every workspace in OTHER profiles. Fix:
    // reorder within caller's profile, preserve others in place.
    const fixture = await createFixture({
      initialState: {
        activeProjectId: "ws-b1",
        profiles: [
          { id: "default", name: "Default" },
          { id: "profile-b", name: "Profile B" },
        ],
        projects: [
          {
            id: "ws-default-1",
            name: "D1",
            kind: "terminal",
            profileId: "default",
            cwd: "/tmp/d1",
            activePanelId: "shell",
            panels: [{ id: "shell", title: "Shell", command: "", shell: true, startup: "default" }],
          },
          {
            id: "ws-b1",
            name: "B1",
            kind: "terminal",
            profileId: "profile-b",
            cwd: "/tmp/b1",
            activePanelId: "shell",
            panels: [{ id: "shell", title: "Shell", command: "", shell: true, startup: "default" }],
          },
          {
            id: "ws-b2",
            name: "B2",
            kind: "terminal",
            profileId: "profile-b",
            cwd: "/tmp/b2",
            activePanelId: "shell",
            panels: [{ id: "shell", title: "Shell", command: "", shell: true, startup: "default" }],
          },
          {
            id: "ws-default-2",
            name: "D2",
            kind: "terminal",
            profileId: "default",
            cwd: "/tmp/d2",
            activePanelId: "shell",
            panels: [{ id: "shell", title: "Shell", command: "", shell: true, startup: "default" }],
          },
        ],
        windowSlots: [
          {
            id: "win-b",
            profileId: "profile-b",
            activeWorkspaceId: "ws-b1",
            activeSessionId: "",
            bounds: { x: 0, y: 0, width: 1280, height: 800 },
            lastFocusedAt: 1000,
          },
        ],
      },
    });
    fixtures.push(fixture);

    // Profile-b client sends only profile-b IDs in swapped order.
    await fixture.runtime.reorderWorkspaces(["ws-b2", "ws-b1"], "win-b");

    const ids = fixture.runtime.getPayload().appState.workspaces.map((p) => p.id);
    // Profile-default workspaces remain in their original positions; only
    // profile-b workspaces are reordered (swapped) within their slots.
    expect(ids).toEqual(["ws-default-1", "ws-b2", "ws-b1", "ws-default-2"]);
  });

  test("createWorktree REFUSES when the parent workspace lives in another profile (no on-disk side effect)", async () => {
    // Remote/mobile client bound to profile B asks to create a worktree
    // under a profile-A parent. Previously only the slot mirror was
    // skipped — the worktree still got created on disk and as a workspace
    // entry in profile A. That's a cross-profile write the caller had no
    // business doing. The fix refuses at entry.
    const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "strideterm-wt-refuse-"));
    tempPaths.push(projectRoot);
    const fixture = await createFixture({
      initialState: {
        activeProjectId: "ws-a",
        profiles: [
          { id: "default", name: "Default" },
          { id: "profile-b", name: "Profile B" },
        ],
        projects: [
          {
            id: "ws-a",
            name: "A",
            kind: "terminal",
            profileId: "default",
            cwd: projectRoot,
            activePanelId: "shell",
            panels: [{ id: "shell", title: "Shell", command: "", shell: true, startup: "default" }],
          },
          {
            id: "ws-b",
            name: "B",
            kind: "terminal",
            profileId: "profile-b",
            cwd: "/tmp/some-other-b",
            activePanelId: "shell",
            panels: [{ id: "shell", title: "Shell", command: "", shell: true, startup: "default" }],
          },
        ],
        windowSlots: [
          {
            id: "win-b",
            profileId: "profile-b",
            activeWorkspaceId: "ws-b",
            activeSessionId: "",
            bounds: { x: 0, y: 0, width: 1280, height: 800 },
            lastFocusedAt: 1000,
          },
        ],
      },
    });
    fixtures.push(fixture);

    await expect(fixture.runtime.createWorktree({ projectId: "ws-a", name: "feat-noop" }, "win-b")).rejects.toThrow(
      /Cross-profile refused/i,
    );

    // No worktree workspace was inserted, no git command was issued.
    const wsAfter = fixture.runtime
      .getPayload()
      .appState.workspaces.map((p) => p.id)
      .sort();
    expect(wsAfter).toEqual(["ws-a", "ws-b"]);
    expect(
      fixture.execFileText.mock.calls.some(
        (call: unknown[]) => Array.isArray(call[1]) && (call[1] as unknown[])[0] === "worktree",
      ),
    ).toBe(false);
  });

  test("discovers worktrees for every profile sharing the parent cwd, regardless of which window is focused", async () => {
    // Profiles are independent observers of the filesystem: when two profiles
    // each have a workspace pointing at the same repo, a worktree that exists
    // on disk should surface in BOTH profiles' sidebars, not just the one in
    // windowSlots[0]'s profile. This is the symmetric case that the original
    // "active-profile-wins" logic in syncWorktreesImpl quietly broke — the
    // non-active profile silently lost its worktree entries on every sync.
    const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "strideterm-shared-symmetric-"));
    tempPaths.push(projectRoot);
    const worktreePath = path.join(projectRoot, ".strideterm", "tree", "feature-y");
    await fs.mkdir(worktreePath, { recursive: true });

    const fixture = await createFixture({
      initialState: {
        // Active profile is "default"; without the fix, "profile-b" never
        // discovers its worktree because parentByTreeDir is overridden by
        // the active-profile parent.
        activeProfileId: "default",
        activeProjectId: "parent-default",
        profiles: [
          { id: "default", name: "Default" },
          { id: "profile-b", name: "Profile B" },
        ],
        projects: [
          {
            id: "parent-default",
            name: "Shared",
            kind: "terminal",
            profileId: "default",
            cwd: projectRoot,
            activePanelId: "shell",
            panels: [{ id: "shell", title: "Shell", command: "", shell: true, startup: "default" }],
          },
          {
            id: "parent-b",
            name: "Shared",
            kind: "terminal",
            profileId: "profile-b",
            cwd: projectRoot,
            activePanelId: "shell",
            panels: [{ id: "shell", title: "Shell", command: "", shell: true, startup: "default" }],
          },
        ],
      },
    });
    fixtures.push(fixture);

    const matchingWorktrees = fixture.runtime
      .getPayload()
      .appState.workspaces.filter((project) => project.cwd === worktreePath);

    expect(matchingWorktrees.map((project) => project.profileId).sort()).toEqual(["default", "profile-b"]);
  });

  test("syncWorktrees does not add 'Worktree of' entry when task workspace already claims the directory", async () => {
    // When a task agent workspace exists at a .strideterm/tree/<branch> path,
    // syncWorktrees must not create a duplicate plain "Worktree of" entry for
    // the same directory.
    const parentRoot = await fs.mkdtemp(path.join(os.tmpdir(), "strideterm-syncwt-taskdedup-"));
    tempPaths.push(parentRoot);
    const treePath = path.join(parentRoot, ".strideterm", "tree", "task-branch");
    await fs.mkdir(treePath, { recursive: true });

    const fixture = await createFixture({
      initialState: {
        activeProjectId: "parent",
        projects: [
          {
            id: "parent",
            name: "MyProject",
            kind: "terminal",
            cwd: parentRoot,
            activePanelId: "shell",
            panels: [{ id: "shell", title: "Shell", command: "", shell: true, startup: "default" }],
          },
          {
            id: "task-ws",
            name: "MyProject / task-branch",
            kind: "task",
            cwd: treePath,
            task: { taskId: "task-ws", parentWorkspaceId: "parent" },
            activePanelId: "shell",
            panels: [{ id: "shell", title: "Shell", command: "", shell: true, startup: "default" }],
          },
        ],
      },
    });
    fixtures.push(fixture);

    const allProjects = fixture.runtime.getPayload().appState.workspaces;
    // No plain "Worktree of" duplicate should exist at the task workspace directory
    const duplicates = allProjects.filter((p) => p.cwd === treePath && (p.notes || "").startsWith("Worktree of"));
    expect(duplicates).toHaveLength(0);
    // The task workspace itself must still be present
    expect(allProjects.find((p) => p.id === "task-ws")).toBeDefined();
  });

  test("createTaskWorkspace removes pre-existing 'Worktree of' entry at the same worktree directory", async () => {
    // When syncWorktrees creates a "Worktree of" entry before the task workspace
    // is registered (race condition), createTaskWorkspace must clean it up.
    const parentRoot = await fs.mkdtemp(path.join(os.tmpdir(), "strideterm-task-cleanup-"));
    tempPaths.push(parentRoot);
    const treePath = path.join(parentRoot, ".strideterm", "tree", "task-branch");
    await fs.mkdir(treePath, { recursive: true });

    const fixture = await createFixture({
      initialState: {
        activeProjectId: "parent",
        projects: [
          {
            id: "parent",
            name: "MyProject",
            kind: "terminal",
            cwd: parentRoot,
            activePanelId: "shell",
            panels: [{ id: "shell", title: "Shell", command: "", shell: true, startup: "default" }],
          },
          {
            id: "plain-wt",
            name: "MyProject / task-branch",
            kind: "terminal",
            cwd: treePath,
            notes: "Worktree of MyProject",
            activePanelId: "shell",
            panels: [{ id: "shell", title: "Shell", command: "", shell: true, startup: "default" }],
          },
        ],
      },
    });
    fixtures.push(fixture);

    // The plain "Worktree of" entry is present before the task workspace is created
    expect(fixture.runtime.getPayload().appState.workspaces.find((p) => p.id === "plain-wt")).toBeDefined();

    await fixture.runtime.createTaskWorkspace({
      cwd: parentRoot,
      useWorktree: true,
      worktreeBranch: "task-branch",
      parentWorkspaceId: "parent",
      description: "Test task",
      activate: false,
    });

    const after = fixture.runtime.getPayload().appState.workspaces;
    // The plain "Worktree of" duplicate must be gone
    expect(after.find((p) => p.id === "plain-wt")).toBeUndefined();
    // A task workspace at the same cwd must exist
    expect(after.find((p) => p.kind === "task" && p.cwd === treePath)).toBeDefined();
  });

  // ── Same-cwd task-workspace duplicate-guard tests ──────────────────
  // These tests cover the three guards that close the "delete-then-create
  // race" footgun (two task agents fighting over the same directory):
  //   1. createTaskWorkspace refuses while another task is actively working.
  //   2. createTaskWorkspace refuses while a delete is mid-flight on the cwd.
  //   3. Inactive task states (paused/completed/failed/idle) are allowed to
  //      coexist — they don't write the worktree.
  // Plus a resilience test: deleteWorkspace clears state.workspaces even if
  // taskRunner cleanup throws, so the cwd never gets permanently locked.

  // Helper: minimal task-workspace shape that survives normalizeState and
  // exercises the same-cwd filter. State value drives the guard.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function makeTaskWorkspace(id: string, name: string, cwd: string, state: string): any {
    return {
      id,
      name,
      kind: "task",
      cwd,
      activePanelId: "worker",
      panels: [
        { id: "worker", title: "Worker", command: "claude", shell: true, startup: "default" },
        { id: "judge", title: "Judge", command: "claude", shell: true, startup: "default" },
      ],
      task: {
        taskId: `${id}-tid`,
        state,
        workerPanelId: "worker",
        judgePanelId: "judge",
        currentRound: state === "running" ? 1 : 0,
        description: "preexisting",
      },
    };
  }

  // AgentTaskRunner#reconcileOnStartup flips active task states to "paused"
  // when the runtime initializes (it assumes the app just restarted so no
  // PTY can still be doing work). To exercise the live-active conflict
  // guard we have to flip the state back through the store *after* fixture
  // setup — the same dance any real running task goes through.
  async function setTaskStateAfterInit(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    fixture: any,
    workspaceId: string,
    state: string,
  ): Promise<void> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await fixture.store.mutate((draft: any) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const ws = draft.workspaces.find((w: any) => w.id === workspaceId);
      if (ws?.task) ws.task.state = state;
    });
  }

  test("createTaskWorkspace refuses when an active running task exists at the same cwd", async () => {
    const sharedCwd = await fs.mkdtemp(path.join(os.tmpdir(), "strideterm-cwd-running-"));
    tempPaths.push(sharedCwd);

    const fixture = await createFixture({
      initialState: {
        workspaces: [makeTaskWorkspace("task-a", "Active task", sharedCwd, "running")],
      },
    });
    fixtures.push(fixture);
    await setTaskStateAfterInit(fixture, "task-a", "running");

    await expect(
      fixture.runtime.createTaskWorkspace({
        cwd: sharedCwd,
        description: "second task",
        activate: false,
      }),
    ).rejects.toThrow(/Another task agent .* is currently running/i);

    // State must NOT contain a second task workspace.
    const tasks = fixture.runtime.getPayload().appState.workspaces!.filter((w) => w.kind === "task");
    expect(tasks).toHaveLength(1);
    expect(tasks[0].id).toBe("task-a");
  });

  test.each(["evaluating", "judge-evaluating", "refreshing"] as const)(
    "createTaskWorkspace refuses when a task in '%s' state exists at the same cwd",
    async (taskState) => {
      const sharedCwd = await fs.mkdtemp(path.join(os.tmpdir(), `strideterm-cwd-${taskState}-`));
      tempPaths.push(sharedCwd);

      const fixture = await createFixture({
        initialState: {
          workspaces: [makeTaskWorkspace("task-a", "Active task", sharedCwd, taskState)],
        },
      });
      fixtures.push(fixture);
      // Re-arm the active state — reconcileOnStartup forced it to "paused".
      await setTaskStateAfterInit(fixture, "task-a", taskState);

      await expect(
        fixture.runtime.createTaskWorkspace({
          cwd: sharedCwd,
          description: "second task",
          activate: false,
        }),
      ).rejects.toThrow(/currently running/i);
    },
  );

  test.each(["paused", "completed", "failed", "idle"] as const)(
    "createTaskWorkspace allows a second task when the existing one is '%s' (inert state)",
    async (taskState) => {
      // Inert states (paused/completed/failed/idle) don't write the worktree,
      // so a second task workspace can coexist. The user might be parking an
      // old run while starting a new one over the same dir — that's fine.
      const sharedCwd = await fs.mkdtemp(path.join(os.tmpdir(), `strideterm-cwd-${taskState}-`));
      tempPaths.push(sharedCwd);

      const fixture = await createFixture({
        initialState: {
          workspaces: [makeTaskWorkspace("task-a", "Old task", sharedCwd, taskState)],
        },
      });
      fixtures.push(fixture);

      const result = await fixture.runtime.createTaskWorkspace({
        cwd: sharedCwd,
        description: "second task",
        activate: false,
      });

      expect(result?.workspaceId).toBeTruthy();
      // Both task workspaces should now exist at the same cwd.
      const tasks = fixture.runtime
        .getPayload()
        .appState.workspaces!.filter((w) => w.kind === "task" && w.cwd === sharedCwd);
      expect(tasks).toHaveLength(2);
      // cwdWarning is preserved as empty string for API stability — callers
      // should not see a stale "warning" payload now that conflicts throw.
      expect(result?.cwdWarning).toBe("");
    },
  );

  test("createTaskWorkspace refuses while a delete is still finishing cleanup at the same cwd", async () => {
    // Reproduces the user-reported race: delete a task workspace, then immediately
    // create another one over the same directory. Before the guard, the user could
    // end up with two task workspaces fighting over the worktree, or the second
    // one stuck because the first hadn't released its files yet.
    //
    // The trick: deleteWorkspace runs synchronously up to its first `await`
    // (cleanupTaskFiles). By then pendingTaskWorkspaceDeletions has the cwd, so
    // a synchronous create attempt that follows must see the pending flag and
    // bail out with a "still finishing cleanup" message.
    const sharedCwd = await fs.mkdtemp(path.join(os.tmpdir(), "strideterm-cwd-pending-"));
    tempPaths.push(sharedCwd);

    const fixture = await createFixture({
      initialState: {
        workspaces: [makeTaskWorkspace("task-a", "Old task", sharedCwd, "paused")],
      },
    });
    fixtures.push(fixture);

    // Kick off delete without awaiting — synchronously populates the pending set.
    const deletePromise = fixture.runtime.deleteWorkspace("task-a");

    // Immediate same-cwd create must hit the pending-delete guard.
    await expect(
      fixture.runtime.createTaskWorkspace({
        cwd: sharedCwd,
        description: "second task",
        activate: false,
      }),
    ).rejects.toThrow(/still finishing cleanup/i);

    // Let the delete settle before the fixture afterEach runs.
    await deletePromise;
  });

  test("after deleteWorkspace completes, createTaskWorkspace at the same cwd succeeds", async () => {
    // The pending-delete guard must release when cleanup finishes, otherwise the
    // cwd would be locked until app restart — exactly the symptom the user
    // reported. This test pairs with the race test above: same setup, but we
    // wait for the delete to complete before creating.
    const sharedCwd = await fs.mkdtemp(path.join(os.tmpdir(), "strideterm-cwd-released-"));
    tempPaths.push(sharedCwd);

    const fixture = await createFixture({
      initialState: {
        workspaces: [makeTaskWorkspace("task-a", "Old task", sharedCwd, "paused")],
      },
    });
    fixtures.push(fixture);

    await fixture.runtime.deleteWorkspace("task-a");

    // Old workspace must be gone from state — the resilience fix guarantees
    // state.mutate ran even if any cleanup step threw.
    const afterDelete = fixture.runtime.getPayload().appState.workspaces!;
    expect(afterDelete.find((w) => w.id === "task-a")).toBeUndefined();

    // New task at the same cwd should now succeed.
    const result = await fixture.runtime.createTaskWorkspace({
      cwd: sharedCwd,
      description: "fresh task",
      activate: false,
    });
    expect(result?.workspaceId).toBeTruthy();
    expect(result?.workspaceId).not.toBe("task-a");
  });

  test("error message names the conflicting task workspace so the user knows what to stop", async () => {
    // UX assertion — the message must include the workspace name so the user
    // can find it in the sidebar. Before the change, the warning was the only
    // signal and got dropped by the dialog; now it's a thrown error that
    // surfaces in the dialog's inline error banner.
    const sharedCwd = await fs.mkdtemp(path.join(os.tmpdir(), "strideterm-cwd-name-"));
    tempPaths.push(sharedCwd);

    const fixture = await createFixture({
      initialState: {
        workspaces: [makeTaskWorkspace("task-a", "Refactor login flow", sharedCwd, "running")],
      },
    });
    fixtures.push(fixture);
    await setTaskStateAfterInit(fixture, "task-a", "running");

    await expect(
      fixture.runtime.createTaskWorkspace({
        cwd: sharedCwd,
        description: "second task",
        activate: false,
      }),
    ).rejects.toThrow(/Refactor login flow/);
  });

  test("deleteWorkspace clears state even when the task workspace is missing taskId", async () => {
    // Resilience: a task workspace persisted without task.taskId (corrupt state,
    // backward-compat record, or partial migration) used to be reachable by the
    // pre-cleanup code path. The hardened deleteWorkspace must still remove it
    // from state.workspaces, not get stuck because of the unusual shape.
    const sharedCwd = await fs.mkdtemp(path.join(os.tmpdir(), "strideterm-cwd-orphan-"));
    tempPaths.push(sharedCwd);

    const fixture = await createFixture({
      initialState: {
        workspaces: [
          {
            id: "task-orphan",
            name: "Orphan task",
            kind: "task",
            cwd: sharedCwd,
            activePanelId: "worker",
            panels: [{ id: "worker", title: "Worker", command: "claude", shell: true, startup: "default" }],
            // Note: task object present but no taskId — the cleanup branch is
            // gated on `task.taskId && cwd`, so cleanup is skipped entirely.
            task: { state: "idle", workerPanelId: "worker", judgePanelId: "worker", currentRound: 0 },
          },
        ],
      },
    });
    fixtures.push(fixture);

    await fixture.runtime.deleteWorkspace("task-orphan");

    const after = fixture.runtime.getPayload().appState.workspaces!;
    expect(after.find((w) => w.id === "task-orphan")).toBeUndefined();

    // And the cwd must NOT be permanently locked — a new create succeeds.
    const result = await fixture.runtime.createTaskWorkspace({
      cwd: sharedCwd,
      description: "fresh task",
      activate: false,
    });
    expect(result?.workspaceId).toBeTruthy();
  });

  // --- Step 1: deleteWorkspace disk-delete double-failure ---

  function makeReviewWorkspace(id: string, diskPath: string) {
    return {
      id,
      name: "Review WS",
      kind: "terminal",
      cwd: diskPath,
      activePanelId: "shell",
      panels: [{ id: "shell", title: "Shell", command: "", shell: true, startup: "default" }],
      review: {
        checkout: {
          mode: "managed-worktree",
          rootPath: diskPath,
          cacheRepoPath: diskPath,
        },
        parentWorkspaceId: "parent",
        provider: "github",
        prKey: "org/repo#1",
      },
    };
  }

  test("deleteWorkspace sets deleteWorkspaceError when rmPath AND git worktree remove --force both fail", async () => {
    const diskPath = await fs.mkdtemp(path.join(os.tmpdir(), "strideterm-del-both-fail-"));
    tempPaths.push(diskPath);

    const execFileText = vi.fn().mockResolvedValue({ stdout: "", stderr: "" });
    // Make git worktree remove --force throw
    execFileText.mockImplementation(async (cmd: string, args: string[]) => {
      if (Array.isArray(args) && args[0] === "worktree" && args[1] === "remove") {
        throw new Error("git worktree remove failed");
      }
      return { stdout: "", stderr: "" };
    });

    const rmPathMock = vi.fn().mockRejectedValue(new Error("rmPath failed"));

    const fixture = await createFixture({
      execFileTextImpl: execFileText,
      dependencies: { rmPath: rmPathMock },
      initialState: { workspaces: [makeReviewWorkspace("ws-del", diskPath)] },
    });
    fixtures.push(fixture);

    const result = await fixture.runtime.deleteWorkspace("ws-del", {
      deleteFromDisk: true,
      diskPath,
    });

    expect(result.deleteWorkspaceError).toBeTruthy();
    expect(result.deleteWorkspaceError).toContain(diskPath);
    // Workspace removed from state even on disk-delete failure
    expect(fixture.runtime.getPayload().appState.workspaces!.find((w) => w.id === "ws-del")).toBeUndefined();
  });

  test("deleteWorkspace does NOT set deleteWorkspaceError when rmPath fails but git worktree remove --force succeeds", async () => {
    const diskPath = await fs.mkdtemp(path.join(os.tmpdir(), "strideterm-del-git-ok-"));
    tempPaths.push(diskPath);

    const execFileText = vi.fn().mockResolvedValue({ stdout: "", stderr: "" });
    const rmPathMock = vi.fn().mockRejectedValue(new Error("rmPath failed, git will rescue"));

    const fixture = await createFixture({
      execFileTextImpl: execFileText,
      dependencies: { rmPath: rmPathMock },
      initialState: { workspaces: [makeReviewWorkspace("ws-del2", diskPath)] },
    });
    fixtures.push(fixture);

    const result = await fixture.runtime.deleteWorkspace("ws-del2", {
      deleteFromDisk: true,
      diskPath,
    });

    expect(result.deleteWorkspaceError).toBeFalsy();
    expect(fixture.runtime.getPayload().appState.workspaces!.find((w) => w.id === "ws-del2")).toBeUndefined();
  });

  test("deleteWorkspace happy path: rmPath succeeds and git worktree remove --force is never called", async () => {
    const diskPath = await fs.mkdtemp(path.join(os.tmpdir(), "strideterm-del-happy-"));
    tempPaths.push(diskPath);

    const execFileText = vi.fn().mockResolvedValue({ stdout: "", stderr: "" });
    const rmPathMock = vi.fn().mockResolvedValue(undefined);

    const fixture = await createFixture({
      execFileTextImpl: execFileText,
      dependencies: { rmPath: rmPathMock },
      initialState: { workspaces: [makeReviewWorkspace("ws-del3", diskPath)] },
    });
    fixtures.push(fixture);

    const result = await fixture.runtime.deleteWorkspace("ws-del3", {
      deleteFromDisk: true,
      diskPath,
    });

    expect(result.deleteWorkspaceError).toBeFalsy();

    const worktreeRemoveCalls = execFileText.mock.calls.filter(
      (c) => Array.isArray(c[1]) && c[1][0] === "worktree" && c[1][1] === "remove",
    );
    expect(worktreeRemoveCalls).toHaveLength(0);
  });

  // --- Krok 6: background retry after a failed disk delete ---

  // execFileText that fails `git worktree remove --force` (so the foreground
  // delete gives up) but lets `git worktree prune` through.
  function execFileTextRemoveFails() {
    return vi.fn(async (_cmd: string, args: string[]) => {
      if (Array.isArray(args) && args[0] === "worktree" && args[1] === "remove") {
        throw new Error("git worktree remove failed");
      }
      return { stdout: "", stderr: "" };
    });
  }

  test("Krok 6: background retry removes the worktree after the foreground delete gives up", async () => {
    const diskPath = await fs.mkdtemp(path.join(os.tmpdir(), "strideterm-bg-retry-ok-"));
    tempPaths.push(diskPath);

    let rmCalls = 0;
    const rmPathMock = vi.fn(async () => {
      rmCalls++;
      if (rmCalls === 1) throw Object.assign(new Error("EBUSY"), { code: "EBUSY" });
      // Background retry (call 2) succeeds.
    });

    const fixture = await createFixture({
      execFileTextImpl: execFileTextRemoveFails(),
      dependencies: { rmPath: rmPathMock },
      initialState: { workspaces: [makeReviewWorkspace("ws-bg", diskPath)] },
    });
    fixtures.push(fixture);

    vi.useFakeTimers();
    try {
      const result = await fixture.runtime.deleteWorkspace("ws-bg", { deleteFromDisk: true, diskPath });
      // User is informed immediately (unchanged UX contract).
      expect(result.deleteWorkspaceError).toBeTruthy();
      expect(rmPathMock).toHaveBeenCalledTimes(1);

      // First retry fires at 10s and succeeds.
      await vi.advanceTimersByTimeAsync(10_000);
      expect(rmPathMock).toHaveBeenCalledTimes(2);

      // No further retries once it succeeded.
      await vi.advanceTimersByTimeAsync(200_000);
      expect(rmPathMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  test("Krok 6: background retry runs all 4 backoff attempts then gives up", async () => {
    const diskPath = await fs.mkdtemp(path.join(os.tmpdir(), "strideterm-bg-retry-fail-"));
    tempPaths.push(diskPath);

    const rmPathMock = vi.fn().mockRejectedValue(Object.assign(new Error("EBUSY"), { code: "EBUSY" }));

    const fixture = await createFixture({
      execFileTextImpl: execFileTextRemoveFails(),
      dependencies: { rmPath: rmPathMock },
      initialState: { workspaces: [makeReviewWorkspace("ws-bg2", diskPath)] },
    });
    fixtures.push(fixture);

    vi.useFakeTimers();
    try {
      await fixture.runtime.deleteWorkspace("ws-bg2", { deleteFromDisk: true, diskPath });
      expect(rmPathMock).toHaveBeenCalledTimes(1); // foreground

      // Backoff schedule: 10s, 30s, 60s, 120s → 4 background attempts.
      await vi.advanceTimersByTimeAsync(10_000);
      expect(rmPathMock).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(rmPathMock).toHaveBeenCalledTimes(3);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(rmPathMock).toHaveBeenCalledTimes(4);
      await vi.advanceTimersByTimeAsync(120_000);
      expect(rmPathMock).toHaveBeenCalledTimes(5);

      // Exhausted — no further attempts.
      await vi.advanceTimersByTimeAsync(500_000);
      expect(rmPathMock).toHaveBeenCalledTimes(5);
    } finally {
      vi.useRealTimers();
    }
  });

  test("Krok 6: background retry treats ENOENT as success (someone cleaned up manually)", async () => {
    const diskPath = await fs.mkdtemp(path.join(os.tmpdir(), "strideterm-bg-retry-enoent-"));
    tempPaths.push(diskPath);

    let rmCalls = 0;
    const rmPathMock = vi.fn(async () => {
      rmCalls++;
      if (rmCalls === 1) throw Object.assign(new Error("EBUSY"), { code: "EBUSY" });
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" }); // retry: already gone
    });

    const fixture = await createFixture({
      execFileTextImpl: execFileTextRemoveFails(),
      dependencies: { rmPath: rmPathMock },
      initialState: { workspaces: [makeReviewWorkspace("ws-bg3", diskPath)] },
    });
    fixtures.push(fixture);

    vi.useFakeTimers();
    try {
      await fixture.runtime.deleteWorkspace("ws-bg3", { deleteFromDisk: true, diskPath });
      await vi.advanceTimersByTimeAsync(10_000);
      expect(rmPathMock).toHaveBeenCalledTimes(2);
      // ENOENT ends the sequence — no 30s attempt.
      await vi.advanceTimersByTimeAsync(200_000);
      expect(rmPathMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  test("Krok 6: a fresh delete on the same path cancels the armed retry (single sequence)", async () => {
    const diskPath = await fs.mkdtemp(path.join(os.tmpdir(), "strideterm-bg-retry-cancel-"));
    tempPaths.push(diskPath);

    // rmPath always fails → every delete arms a retry; cancellation is what keeps
    // exactly one sequence alive.
    const rmPathMock = vi.fn().mockRejectedValue(Object.assign(new Error("EBUSY"), { code: "EBUSY" }));

    const fixture = await createFixture({
      execFileTextImpl: execFileTextRemoveFails(),
      dependencies: { rmPath: rmPathMock },
      // Two workspaces sharing the same managed worktree path.
      initialState: { workspaces: [makeReviewWorkspace("ws-r1", diskPath), makeReviewWorkspace("ws-r2", diskPath)] },
    });
    fixtures.push(fixture);

    vi.useFakeTimers();
    try {
      await fixture.runtime.deleteWorkspace("ws-r1", { deleteFromDisk: true, diskPath });
      expect(rmPathMock).toHaveBeenCalledTimes(1); // foreground r1; retry A armed

      // A fresh delete on the SAME path supersedes retry A (cancels it) and takes
      // the synchronous path, then arms retry B.
      await fixture.runtime.deleteWorkspace("ws-r2", { deleteFromDisk: true, diskPath });
      expect(rmPathMock).toHaveBeenCalledTimes(2); // foreground r2

      // Only ONE retry sequence is live: advancing 10s fires exactly one retry.
      // If retry A had survived, we'd see two retries (call count 4) here.
      await vi.advanceTimersByTimeAsync(10_000);
      expect(rmPathMock).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  test("Krok 6: syncWorktrees skips a path with an active background delete retry", async () => {
    // When a worktree disk-delete fails, the path stays in pendingWorktreeDeletions
    // while the background retry owns it. syncWorktrees must NOT resurrect the
    // still-on-disk directory as a fresh "Worktree of" workspace in the meantime
    // (regression on the pendingWorktreeDeletions.has guard).
    const parentDir = await fs.mkdtemp(path.join(os.tmpdir(), "strideterm-bg-retry-sync-"));
    tempPaths.push(parentDir);
    const branchDir = path.join(parentDir, ".strideterm", "tree", "locked-branch");
    await fs.mkdir(branchDir, { recursive: true });

    // rmPath always fails → foreground delete gives up → background retry armed,
    // holding branchDir. git worktree remove also fails (execFileTextRemoveFails).
    const rmPathMock = vi.fn().mockRejectedValue(Object.assign(new Error("EBUSY"), { code: "EBUSY" }));
    const fixture = await createFixture({
      execFileTextImpl: execFileTextRemoveFails(),
      dependencies: { rmPath: rmPathMock },
      initialState: {
        workspaces: [
          {
            id: "parent-sync",
            name: "Parent",
            kind: "terminal",
            cwd: parentDir,
            activePanelId: "shell",
            panels: [{ id: "shell", title: "Shell", command: "", shell: true, startup: "default" }],
          },
        ],
      },
    });
    fixtures.push(fixture);

    // Init syncWorktrees auto-created the child worktree at branchDir.
    const child = fixture.runtime.getPayload().appState.workspaces!.find((w) => w.cwd === branchDir);
    expect(child).toBeDefined();

    // Delete it from disk; rmPath fails → background retry armed (path held).
    const result = await fixture.runtime.deleteWorkspace(child!.id, { deleteFromDisk: true, diskPath: branchDir });
    expect(result.deleteWorkspaceError).toBeTruthy();
    expect(rmPathMock).toHaveBeenCalledTimes(1); // foreground only — retry still pending

    // branchDir is STILL on disk (rmPath failed). Without the guard, syncWorktrees
    // would re-add it as a fresh worktree workspace; the guard makes it skip.
    await fixture.runtime.syncWorktrees();

    const after = fixture.runtime.getPayload().appState.workspaces!;
    expect(after.some((w) => w.cwd === branchDir)).toBe(false);
  });

  // --- Krok 2 & 3: shell-triggered git refresh (debounce + leading-edge limit) ---
  //
  // scheduleGitRefreshFromShell is exposed on the runtime (see returnObj) so these
  // exercise the real debounce + 10s leading-edge coalescing + delete-cancellation
  // deterministically with fake timers and fixture.git.refreshArgs as the
  // refreshGit spy (refreshGit → git.refreshWorkspaces([ws]) pushes [ws.id]).

  // Plain git-available terminal workspace; making it the active workspace avoids
  // the background init refresh that runInitialRefresh schedules for non-active ones.
  function makeShellWorkspace(id: string) {
    return {
      id,
      name: `Shell ${id}`,
      kind: "terminal",
      cwd: `/repo/${id}`,
      activePanelId: "shell",
      panels: [{ id: "shell", title: "Shell", command: "", shell: true, startup: "default" }],
    };
  }
  const shellRefreshes = (fixture: { git: { refreshArgs: string[][] } }, wsId: string) =>
    fixture.git.refreshArgs.filter((ids) => ids.length === 1 && ids[0] === wsId).length;

  test("Krok 2: deleteWorkspace cancels a pending shell git-refresh timer", async () => {
    const fixture = await createFixture({
      initialState: { activeWorkspaceId: "ws-a", workspaces: [makeShellWorkspace("ws-a")] },
    });
    fixtures.push(fixture);
    // Drain any background init refresh, then start from a clean refreshArgs.
    await new Promise((r) => setTimeout(r, 50));

    vi.useFakeTimers();
    try {
      fixture.runtime.scheduleGitRefreshFromShell("ws-a"); // arms the 1s debounce
      // Delete clears gitRefreshDebounceMap[ws-a] (and lastShellRefreshAt) so the
      // timer can't outlive the workspace.
      await fixture.runtime.deleteWorkspace("ws-a");
      fixture.git.refreshArgs = []; // isolate: only a surviving shell timer would push now
      await vi.advanceTimersByTimeAsync(12_000);
      // Map key was cleared → the debounced refresh never fires for the gone ws.
      expect(shellRefreshes(fixture, "ws-a")).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  test("Krok 2: deleting one workspace does not cancel another's pending git refresh", async () => {
    const fixture = await createFixture({
      initialState: { activeWorkspaceId: "ws-a", workspaces: [makeShellWorkspace("ws-a"), makeShellWorkspace("ws-b")] },
    });
    fixtures.push(fixture);
    await new Promise((r) => setTimeout(r, 50));

    vi.useFakeTimers();
    try {
      fixture.runtime.scheduleGitRefreshFromShell("ws-a");
      fixture.runtime.scheduleGitRefreshFromShell("ws-b");
      await fixture.runtime.deleteWorkspace("ws-a"); // cancels ONLY ws-a's timer
      fixture.git.refreshArgs = [];
      await vi.advanceTimersByTimeAsync(1_000);
      expect(shellRefreshes(fixture, "ws-b")).toBe(1); // ws-b still refreshes
      expect(shellRefreshes(fixture, "ws-a")).toBe(0); // ws-a was cancelled
    } finally {
      vi.useRealTimers();
    }
  });

  test("Krok 3: a single OSC triggers one refresh after the ~1s debounce", async () => {
    const fixture = await createFixture({
      initialState: { activeWorkspaceId: "ws-a", workspaces: [makeShellWorkspace("ws-a")] },
    });
    fixtures.push(fixture);
    await new Promise((r) => setTimeout(r, 50));

    vi.useFakeTimers();
    try {
      fixture.git.refreshArgs = [];
      fixture.runtime.scheduleGitRefreshFromShell("ws-a");
      await vi.advanceTimersByTimeAsync(999);
      expect(shellRefreshes(fixture, "ws-a")).toBe(0); // not yet — still within debounce
      await vi.advanceTimersByTimeAsync(1);
      expect(shellRefreshes(fixture, "ws-a")).toBe(1); // leading edge → immediate
    } finally {
      vi.useRealTimers();
    }
  });

  test("Krok 3: a 30s OSC storm is coalesced to ≤4 refreshes (≈1 per 10s)", async () => {
    const fixture = await createFixture({
      initialState: { activeWorkspaceId: "ws-a", workspaces: [makeShellWorkspace("ws-a")] },
    });
    fixtures.push(fixture);
    await new Promise((r) => setTimeout(r, 50));

    vi.useFakeTimers();
    try {
      fixture.git.refreshArgs = [];
      // OSC roughly every second for 30s (the agent mid-turn pattern).
      for (let i = 0; i < 30; i++) {
        fixture.runtime.scheduleGitRefreshFromShell("ws-a");
        await vi.advanceTimersByTimeAsync(1_000);
      }
      const during = shellRefreshes(fixture, "ws-a");
      // Leading-edge limit (10s) squashes the storm: ~1 refresh at 1s, 11s, 21s.
      expect(during).toBeGreaterThanOrEqual(1);
      expect(during).toBeLessThanOrEqual(4);
      // The LAST state is still eventually refreshed (coalesced re-arm fires).
      await vi.advanceTimersByTimeAsync(10_000);
      expect(shellRefreshes(fixture, "ws-a")).toBeGreaterThan(during - 1);
    } finally {
      vi.useRealTimers();
    }
  });

  test("Krok 3: an OSC after a quiet period refreshes immediately again", async () => {
    const fixture = await createFixture({
      initialState: { activeWorkspaceId: "ws-a", workspaces: [makeShellWorkspace("ws-a")] },
    });
    fixtures.push(fixture);
    await new Promise((r) => setTimeout(r, 50));

    vi.useFakeTimers();
    try {
      fixture.git.refreshArgs = [];
      fixture.runtime.scheduleGitRefreshFromShell("ws-a");
      await vi.advanceTimersByTimeAsync(1_000);
      expect(shellRefreshes(fixture, "ws-a")).toBe(1); // first refresh

      // >10s of quiet (no scheduling) — the leading-edge window resets.
      await vi.advanceTimersByTimeAsync(11_000);
      fixture.runtime.scheduleGitRefreshFromShell("ws-a");
      await vi.advanceTimersByTimeAsync(1_000);
      expect(shellRefreshes(fixture, "ws-a")).toBe(2); // immediate again, not deferred
    } finally {
      vi.useRealTimers();
    }
  });

  test("Krok 3: two workspaces have independent debounce + rate-limit windows", async () => {
    const fixture = await createFixture({
      initialState: { activeWorkspaceId: "ws-a", workspaces: [makeShellWorkspace("ws-a"), makeShellWorkspace("ws-b")] },
    });
    fixtures.push(fixture);
    await new Promise((r) => setTimeout(r, 50));

    vi.useFakeTimers();
    try {
      fixture.git.refreshArgs = [];
      // Both scheduled together → both fire on their own debounce.
      fixture.runtime.scheduleGitRefreshFromShell("ws-a");
      fixture.runtime.scheduleGitRefreshFromShell("ws-b");
      await vi.advanceTimersByTimeAsync(1_000);
      expect(shellRefreshes(fixture, "ws-a")).toBe(1);
      expect(shellRefreshes(fixture, "ws-b")).toBe(1);

      // ws-a is now inside its 10s window (next OSC defers); ws-b is untouched and
      // would still refresh on its own schedule — the maps are keyed per workspace.
      fixture.runtime.scheduleGitRefreshFromShell("ws-a");
      await vi.advanceTimersByTimeAsync(1_000);
      expect(shellRefreshes(fixture, "ws-a")).toBe(1); // deferred by ws-a's own window
      expect(shellRefreshes(fixture, "ws-b")).toBe(1); // unaffected by ws-a's storm
    } finally {
      vi.useRealTimers();
    }
  });

  test("Krok 3: deleting a workspace during the debounce wait fires no refresh", async () => {
    const fixture = await createFixture({
      initialState: { activeWorkspaceId: "ws-a", workspaces: [makeShellWorkspace("ws-a")] },
    });
    fixtures.push(fixture);
    await new Promise((r) => setTimeout(r, 50));

    vi.useFakeTimers();
    try {
      fixture.runtime.scheduleGitRefreshFromShell("ws-a"); // timer pending mid-wait
      await vi.advanceTimersByTimeAsync(500); // still waiting (debounce is 1s)
      await fixture.runtime.deleteWorkspace("ws-a"); // delete cancels the pending timer
      fixture.git.refreshArgs = [];
      await vi.advanceTimersByTimeAsync(12_000);
      expect(shellRefreshes(fixture, "ws-a")).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  // --- Step 3: managed-path guard ---

  test("deleteWorkspace with deleteFromDisk on plain (unmanaged) workspace sets deleteWorkspaceError and does not call rmPath", async () => {
    const diskPath = await fs.mkdtemp(path.join(os.tmpdir(), "strideterm-plain-del-"));
    tempPaths.push(diskPath);

    const rmPathMock = vi.fn().mockResolvedValue(undefined);

    const fixture = await createFixture({
      dependencies: { rmPath: rmPathMock },
      initialState: {
        workspaces: [
          {
            id: "plain-ws",
            name: "Plain",
            kind: "terminal",
            cwd: diskPath,
            activePanelId: "shell",
            panels: [{ id: "shell", title: "Shell", command: "", shell: true, startup: "default" }],
          },
        ],
      },
    });
    fixtures.push(fixture);

    const result = await fixture.runtime.deleteWorkspace("plain-ws", {
      deleteFromDisk: true,
      diskPath,
    });

    expect(result.deleteWorkspaceError).toBeTruthy();
    expect(result.deleteWorkspaceError).toContain("Refused to delete");
    expect(rmPathMock).not.toHaveBeenCalled();
    // Workspace is still removed from state
    expect(fixture.runtime.getPayload().appState.workspaces!.find((w) => w.id === "plain-ws")).toBeUndefined();
  });

  test("deleteWorkspace with deleteFromDisk on managed review worktree succeeds", async () => {
    const diskPath = await fs.mkdtemp(path.join(os.tmpdir(), "strideterm-managed-del-"));
    tempPaths.push(diskPath);

    const rmPathMock = vi.fn().mockResolvedValue(undefined);

    const fixture = await createFixture({
      dependencies: { rmPath: rmPathMock },
      initialState: { workspaces: [makeReviewWorkspace("rv-ws", diskPath)] },
    });
    fixtures.push(fixture);

    const result = await fixture.runtime.deleteWorkspace("rv-ws", {
      deleteFromDisk: true,
      diskPath,
    });

    expect(result.deleteWorkspaceError).toBeFalsy();
    expect(rmPathMock).toHaveBeenCalledWith(diskPath);
  });

  test("deleteWorkspace: path traversal outside managed path is denied", async () => {
    const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "strideterm-traversal-"));
    tempPaths.push(baseDir);
    const diskPath = path.join(baseDir, "sub", "wt");

    const rmPathMock = vi.fn().mockResolvedValue(undefined);

    const fixture = await createFixture({
      dependencies: { rmPath: rmPathMock },
      initialState: { workspaces: [makeReviewWorkspace("rv-trav", diskPath)] },
    });
    fixtures.push(fixture);

    // Try to delete a path outside the managed rootPath (traverse up to baseDir)
    const result = await fixture.runtime.deleteWorkspace("rv-trav", {
      deleteFromDisk: true,
      diskPath: baseDir,
    });

    expect(result.deleteWorkspaceError).toBeTruthy();
    expect(rmPathMock).not.toHaveBeenCalled();
  });

  test("deleteWorkspace with deleteFromDisk on quickfix workspace succeeds", async () => {
    const diskPath = await fs.mkdtemp(path.join(os.tmpdir(), "strideterm-qf-del-"));
    tempPaths.push(diskPath);

    const rmPathMock = vi.fn().mockResolvedValue(undefined);

    const fixture = await createFixture({
      dependencies: { rmPath: rmPathMock },
      initialState: {
        workspaces: [
          {
            id: "qf-ws",
            name: "Quickfix WS",
            kind: "terminal",
            cwd: diskPath,
            activePanelId: "shell",
            panels: [{ id: "shell", title: "Shell", command: "", shell: true, startup: "default" }],
            quickfix: {
              rootPath: diskPath,
              parentWorkspaceId: "parent",
            },
          },
        ],
      },
    });
    fixtures.push(fixture);

    const result = await fixture.runtime.deleteWorkspace("qf-ws", {
      deleteFromDisk: true,
      diskPath,
    });

    expect(result.deleteWorkspaceError).toBeFalsy();
    expect(rmPathMock).toHaveBeenCalledWith(diskPath);
  });

  test("deleteWorkspace with deleteFromDisk on task worktree workspace succeeds", async () => {
    const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "strideterm-task-del-base-"));
    tempPaths.push(baseDir);
    const diskPath = path.join(baseDir, ".strideterm", "tree", "my-task-branch");
    await fs.mkdir(diskPath, { recursive: true });

    const rmPathMock = vi.fn().mockResolvedValue(undefined);

    const fixture = await createFixture({
      dependencies: { rmPath: rmPathMock },
      initialState: {
        workspaces: [
          {
            id: "task-wt-ws",
            name: "Task Worktree WS",
            kind: "terminal",
            cwd: diskPath,
            activePanelId: "shell",
            panels: [{ id: "shell", title: "Shell", command: "", shell: true, startup: "default" }],
            task: {
              worktreeBase: baseDir,
              parentWorkspaceId: "parent",
              description: "my task",
              agentKind: "claude",
              state: "paused",
            },
          },
        ],
      },
    });
    fixtures.push(fixture);

    const result = await fixture.runtime.deleteWorkspace("task-wt-ws", {
      deleteFromDisk: true,
      diskPath,
    });

    expect(result.deleteWorkspaceError).toBeFalsy();
    expect(rmPathMock).toHaveBeenCalledWith(diskPath);
  });

  test("deleteWorkspace with deleteFromDisk on task worktree refuses worktreeBase", async () => {
    const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "strideterm-task-del-refuse-base-"));
    tempPaths.push(baseDir);
    const diskPath = path.join(baseDir, ".strideterm", "tree", "my-task-branch");
    await fs.mkdir(diskPath, { recursive: true });

    const rmPathMock = vi.fn().mockResolvedValue(undefined);

    const fixture = await createFixture({
      dependencies: { rmPath: rmPathMock },
      initialState: {
        workspaces: [
          {
            id: "task-wt-refuse-base",
            name: "Task Worktree WS",
            kind: "terminal",
            cwd: diskPath,
            activePanelId: "shell",
            panels: [{ id: "shell", title: "Shell", command: "", shell: true, startup: "default" }],
            task: {
              worktreeBase: baseDir,
              parentWorkspaceId: "parent",
              description: "my task",
              agentKind: "claude",
              state: "paused",
            },
          },
        ],
      },
    });
    fixtures.push(fixture);

    const result = await fixture.runtime.deleteWorkspace("task-wt-refuse-base", {
      deleteFromDisk: true,
      diskPath: baseDir,
    });

    expect(result.deleteWorkspaceError).toContain("Refused to delete");
    expect(rmPathMock).not.toHaveBeenCalled();
  });

  test("deleteWorkspace with deleteFromDisk on non-worktree task keeps cwd and cleans task files", async () => {
    const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "strideterm-task-del-keep-cwd-"));
    tempPaths.push(baseDir);
    const taskDir = path.join(baseDir, ".strideterm", "tasks", "task-keep-cwd");
    await fs.mkdir(taskDir, { recursive: true });
    await fs.writeFile(path.join(taskDir, "TODO.md"), "task data", "utf8");

    const rmPathMock = vi.fn().mockResolvedValue(undefined);

    const fixture = await createFixture({
      dependencies: { rmPath: rmPathMock },
      initialState: {
        workspaces: [
          {
            id: "task-keep-cwd-ws",
            name: "Task In Existing CWD",
            kind: "task",
            cwd: baseDir,
            activePanelId: "shell",
            panels: [{ id: "shell", title: "Shell", command: "", shell: true, startup: "default" }],
            task: {
              taskId: "task-keep-cwd",
              worktreeBase: "",
              parentWorkspaceId: "parent",
              description: "my task",
              agentKind: "claude",
              state: "paused",
            },
          },
        ],
      },
    });
    fixtures.push(fixture);

    const result = await fixture.runtime.deleteWorkspace("task-keep-cwd-ws", {
      deleteFromDisk: true,
      diskPath: baseDir,
    });

    expect(result.deleteWorkspaceError).toContain("Refused to delete");
    expect(rmPathMock).not.toHaveBeenCalled();
    await expect(fs.access(baseDir)).resolves.toBeUndefined();
    await expect(fs.access(taskDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("deleteWorkspace with deleteFromDisk on legacy 'Worktree of ...' workspace succeeds", async () => {
    const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "strideterm-legacy-del-"));
    tempPaths.push(baseDir);
    const treePath = path.join(baseDir, ".strideterm", "tree", "some-branch");
    await fs.mkdir(treePath, { recursive: true });

    const rmPathMock = vi.fn().mockResolvedValue(undefined);

    const fixture = await createFixture({
      dependencies: { rmPath: rmPathMock },
      initialState: {
        workspaces: [
          {
            id: "legacy-ws",
            name: "some-branch",
            kind: "terminal",
            cwd: treePath,
            activePanelId: "shell",
            panels: [{ id: "shell", title: "Shell", command: "", shell: true, startup: "default" }],
            notes: "Worktree of Parent Project",
          },
        ],
      },
    });
    fixtures.push(fixture);

    const result = await fixture.runtime.deleteWorkspace("legacy-ws", {
      deleteFromDisk: true,
      diskPath: treePath,
    });

    expect(result.deleteWorkspaceError).toBeFalsy();
    expect(rmPathMock).toHaveBeenCalledWith(treePath);
  });

  // --- Step 4: targeted git refresh after delete ---

  test("deleteWorkspace: deleting review worktree triggers targeted refreshGit for parent only", async () => {
    const diskPath = await fs.mkdtemp(path.join(os.tmpdir(), "strideterm-del-target-"));
    tempPaths.push(diskPath);

    const rmPathMock = vi.fn().mockResolvedValue(undefined);
    const parentWs = {
      id: "parent",
      name: "Parent WS",
      kind: "terminal",
      cwd: "/some/repo",
      activePanelId: "shell",
      panels: [{ id: "shell", title: "Shell", command: "", shell: true, startup: "default" }],
    };
    const fixture = await createFixture({
      dependencies: { rmPath: rmPathMock },
      initialState: { workspaces: [makeReviewWorkspace("rv-targeted", diskPath), parentWs] },
    });
    fixtures.push(fixture);

    // Reset tracking arrays after startup to isolate the deleteWorkspace call
    fixture.git.invalidateCalls = [];
    fixture.git.refreshArgs = [];

    await fixture.runtime.deleteWorkspace("rv-targeted", { deleteFromDisk: true });

    // Targeted refresh: invalidateSnapshotCache called ONLY for parent, not null
    expect(fixture.git.invalidateCalls.some((c: { workspaceId: string | null }) => c.workspaceId === "parent")).toBe(
      true,
    );
    expect(fixture.git.invalidateCalls.every((c: { workspaceId: string | null }) => c.workspaceId !== null)).toBe(true);
    // refreshArgs: each targeted call passes only the parent workspace
    expect(fixture.git.refreshArgs.some((ids: string[]) => ids.length === 1 && ids[0] === "parent")).toBe(true);
  });

  test("deleteWorkspace: deleting plain workspace with no parent falls back to refreshGit(null, { useCache: true })", async () => {
    const plainWs = {
      id: "plain-ws",
      name: "Plain WS",
      kind: "terminal",
      cwd: "/unrelated/path",
      activePanelId: "shell",
      panels: [{ id: "shell", title: "Shell", command: "", shell: true, startup: "default" }],
    };
    const fixture = await createFixture({
      initialState: { workspaces: [plainWs] },
    });
    fixtures.push(fixture);

    // Reset tracking arrays after startup to isolate the deleteWorkspace call
    fixture.git.invalidateCalls = [];
    fixture.git.refreshArgs = [];

    await fixture.runtime.deleteWorkspace("plain-ws", {});

    // Fallback: useCache=true means invalidateSnapshotCache is NOT called
    expect(fixture.git.invalidateCalls).toHaveLength(0);
    // refreshArgs receives at least one call (the fallback full refresh)
    expect(fixture.git.refreshArgs.length).toBeGreaterThan(0);
  });

  // --- Step 7: broadcastState() microtask coalescing ---

  test("multiple synchronous broadcastState() calls coalesce into one state:updated event", async () => {
    const fixture = await createFixture();
    fixtures.push(fixture);

    let updateCount = 0;
    fixture.runtime.on("state:updated", () => {
      updateCount++;
    });

    // Trigger broadcastState indirectly via five rapid workspace activations —
    // each calls broadcastState(), but they're all within the same microtask queue
    // tick from the test's perspective (synchronous setup).
    // Use setRemoteInfo which calls broadcastState() directly and is synchronous.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rt = fixture.runtime as any;
    // Call setRemoteInfo five times synchronously to trigger 5x broadcastState()
    rt.setRemoteInfo({ port: 1 });
    rt.setRemoteInfo({ port: 2 });
    rt.setRemoteInfo({ port: 3 });
    rt.setRemoteInfo({ port: 4 });
    rt.setRemoteInfo({ port: 5 });

    // Flush microtasks
    await Promise.resolve();

    expect(updateCount).toBe(1); // coalesced into one broadcast
  });

  test("broadcastState() in two separate async steps emits two events", async () => {
    const fixture = await createFixture();
    fixtures.push(fixture);

    let updateCount = 0;
    fixture.runtime.on("state:updated", () => {
      updateCount++;
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rt = fixture.runtime as any;
    rt.setRemoteInfo({ port: 10 });
    await Promise.resolve(); // flush first microtask → one broadcast
    rt.setRemoteInfo({ port: 11 });
    await Promise.resolve(); // flush second microtask → second broadcast

    expect(updateCount).toBe(2);
  });

  test("getPayload() is called once per coalesced broadcastState() batch — only one payload produced (#48)", async () => {
    // broadcastState() calls getPayload() inside the microtask callback.
    // When 5 broadcastState() calls coalesce into one microtask, getPayload()
    // should be invoked exactly once (verified via the payload count received).
    const fixture = await createFixture();
    fixtures.push(fixture);

    const receivedPayloads: unknown[] = [];
    fixture.runtime.on("state:updated", (payload: unknown) => {
      receivedPayloads.push(payload);
    });

    // 5 synchronous broadcastState() triggers via setRemoteInfo
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rt = fixture.runtime as any;
    rt.setRemoteInfo({ port: 1 });
    rt.setRemoteInfo({ port: 2 });
    rt.setRemoteInfo({ port: 3 });
    rt.setRemoteInfo({ port: 4 });
    rt.setRemoteInfo({ port: 5 });

    // Microtask not yet fired — no payload yet
    expect(receivedPayloads).toHaveLength(0);

    await Promise.resolve(); // flush the coalesced microtask

    // Only one payload produced — getPayload() was called exactly once inside broadcastState
    expect(receivedPayloads).toHaveLength(1);
    expect(receivedPayloads[0]).toBeDefined();
  });

  // --- Step 5c: demand-aware docker polling ---

  test("activating a docker workspace triggers immediate docker refresh and switches poll to fast mode", async () => {
    const dockerWs = {
      id: "docker-ws",
      name: "Docker WS",
      kind: "docker",
      cwd: "",
      activePanelId: "shell",
      panels: [{ id: "shell", title: "Shell", command: "", shell: true, startup: "default" }],
    };
    const fixture = await createFixture({
      initialState: { workspaces: [dockerWs], activeWorkspaceId: "docker-ws" },
    });
    fixtures.push(fixture);

    const refreshSpy = vi.spyOn(fixture.docker, "refresh");

    // Activate the docker workspace — should trigger an immediate refresh
    await fixture.runtime.activateWorkspace("docker-ws");

    expect(refreshSpy).toHaveBeenCalled();
  });

  test("no docker workspaces: docker refresh is NOT called during activateWorkspace for non-docker workspace", async () => {
    const terminalWs = {
      id: "term-ws",
      name: "Terminal WS",
      kind: "terminal",
      cwd: "/some/path",
      activePanelId: "shell",
      panels: [{ id: "shell", title: "Shell", command: "", shell: true, startup: "default" }],
    };
    const fixture = await createFixture({
      initialState: { workspaces: [terminalWs] },
    });
    fixtures.push(fixture);

    const refreshSpy = vi.spyOn(fixture.docker, "refresh");

    await fixture.runtime.activateWorkspace("term-ws");

    expect(refreshSpy).not.toHaveBeenCalled();
  });

  test("without active docker consumer, docker poll stays on slow interval — no extra refresh in 31s (#33)", async () => {
    // With no active docker consumer, ensureDockerPolling() sets the SLOW interval (5 min).
    // Advancing 31s should NOT trigger any additional poll (would fire if fast 30s interval was active).
    vi.useFakeTimers();
    try {
      const fixture = await createFixture({
        initialState: { workspaces: [] },
      });
      fixtures.push(fixture);

      const baseline = fixture.docker.refreshCount;

      // Advance just past the fast interval (30s) but well before the slow interval (5min = 300s)
      await vi.advanceTimersByTimeAsync(31_000);

      expect(fixture.docker.refreshCount).toBe(baseline);
    } finally {
      vi.useRealTimers();
    }
  });

  test("switching away from docker workspace moves docker poll back to slow interval", async () => {
    vi.useFakeTimers();
    try {
      const dockerWs = {
        id: "docker-ws-slow-again",
        name: "Docker WS",
        kind: "docker",
        cwd: "",
        activePanelId: "shell",
        panels: [{ id: "shell", title: "Shell", command: "", shell: true, startup: "default" }],
      };
      const terminalWs = {
        id: "term-ws-after-docker",
        name: "Terminal WS",
        kind: "terminal",
        cwd: "/some/path",
        activePanelId: "shell",
        panels: [{ id: "shell", title: "Shell", command: "", shell: true, startup: "default" }],
      };
      const fixture = await createFixture({
        initialState: { workspaces: [dockerWs, terminalWs], activeWorkspaceId: "docker-ws-slow-again" },
      });
      fixtures.push(fixture);

      await fixture.runtime.activateWorkspace("term-ws-after-docker");
      const baseline = fixture.docker.refreshCount;

      await vi.advanceTimersByTimeAsync(31_000);

      expect(fixture.docker.refreshCount).toBe(baseline);
    } finally {
      vi.useRealTimers();
    }
  });

  test("activating docker workspace calls refreshDocker() before the first state:updated broadcast (stale-data ordering, #34)", async () => {
    const dockerWs = {
      id: "docker-ws2",
      name: "Docker WS",
      kind: "docker",
      cwd: "",
      activePanelId: "shell",
      panels: [{ id: "shell", title: "Shell", command: "", shell: true, startup: "default" }],
    };
    const fixture = await createFixture({
      initialState: { workspaces: [dockerWs] },
    });
    fixtures.push(fixture);

    let refreshCalledBeforeFirstBroadcast: boolean | null = null;
    let dockerRefreshCalled = false;

    const originalRefresh = fixture.docker.refresh.bind(fixture.docker);
    vi.spyOn(fixture.docker, "refresh").mockImplementation(async () => {
      dockerRefreshCalled = true;
      return originalRefresh();
    });

    fixture.runtime.on("state:updated", () => {
      if (refreshCalledBeforeFirstBroadcast === null) {
        refreshCalledBeforeFirstBroadcast = dockerRefreshCalled;
      }
    });

    await fixture.runtime.activateWorkspace("docker-ws2");
    await Promise.resolve(); // flush any remaining microtasks

    // refresh() must have been called before the first broadcast fired
    expect(refreshCalledBeforeFirstBroadcast).toBe(true);
  });

  // --- Step 6: syncWorktreesImpl indexes + syncTreeDirWatchers resync ---

  test("syncWorktreesImpl correctly adds worktree workspace entries for on-disk tree directories (#40)", async () => {
    // syncWorktreesImpl is called by syncWorktrees() which is called during createFixture init
    // (via runInitialRefresh). This test verifies the index-based lookup produces the correct output.
    const parentDir = await fs.mkdtemp(path.join(os.tmpdir(), "strideterm-sync-wt-"));
    tempPaths.push(parentDir);
    const branchDir = path.join(parentDir, ".strideterm", "tree", "feature-x");
    await fs.mkdir(branchDir, { recursive: true });

    // createFixture calls runInitialRefresh → syncWorktrees() → syncWorktreesImpl()
    const fixture = await createFixture({
      initialState: {
        workspaces: [
          {
            id: "parent-ws",
            name: "Parent",
            kind: "terminal",
            cwd: parentDir,
            activePanelId: "shell",
            panels: [{ id: "shell", title: "Shell", command: "", shell: true, startup: "default" }],
          },
        ],
      },
    });
    fixtures.push(fixture);

    const workspaces = fixture.runtime.getPayload().appState.workspaces!;
    const worktree = workspaces.find((w) => w.cwd === branchDir);
    expect(worktree).toBeDefined();
    expect(worktree?.notes).toBe("Worktree of Parent");
  });

  test("saveWorkspace triggers syncTreeDirWatchers — git poll detects new tree entries after save (#41)", async () => {
    // syncTreeDirWatchers is called after saveWorkspace (runtime.ts:4834).
    // This test verifies that after saving a new parent workspace, the gitPoll
    // (which calls syncWorktrees/syncWorktreesImpl) picks up new tree entries.
    //
    // Driven via the exposed runtime.syncWorktrees() rather than
    // vi.advanceTimersByTimeAsync — the timer-advance approach raced the
    // real fs.readdir inside the poll callback on macOS / Ubuntu runners.
    const parentDir = await fs.mkdtemp(path.join(os.tmpdir(), "strideterm-save-watcher-"));
    tempPaths.push(parentDir);

    const fixture = await createFixture({ initialState: { workspaces: [] } });
    fixtures.push(fixture);

    // Save a new parent workspace — calls syncTreeDirWatchers internally
    await fixture.runtime.saveWorkspace({
      id: "new-parent",
      name: "New Parent",
      kind: "terminal",
      cwd: parentDir,
      activePanelId: "shell",
      panels: [{ id: "shell", title: "Shell", command: "", shell: true, startup: "default" }],
    });

    // Create a tree subdir AFTER the save (simulates a new worktree being added on disk)
    const branchDir = path.join(parentDir, ".strideterm", "tree", "new-branch");
    await fs.mkdir(branchDir, { recursive: true });

    await fixture.runtime.syncWorktrees();

    const workspaces = fixture.runtime.getPayload().appState.workspaces!;
    const worktree = workspaces.find((w) => w.cwd === branchDir);
    expect(worktree).toBeDefined();
    expect(worktree?.notes).toMatch(/^Worktree of /);
  });

  test("saveWorkspace inserts a new top-level workspace after the active workspace tree", async () => {
    const fixture = await createFixture({
      initialState: {
        profiles: [{ id: "profile-a", name: "A", color: "#aaa" }],
        workspaces: [
          {
            id: "before",
            name: "Before",
            kind: "terminal",
            profileId: "profile-a",
            cwd: "",
            activePanelId: "",
            panels: [],
          },
          {
            id: "active",
            name: "Active",
            kind: "terminal",
            profileId: "profile-a",
            cwd: "",
            activePanelId: "",
            panels: [],
          },
          {
            id: "active-child",
            name: "Active child",
            kind: "task",
            profileId: "profile-a",
            cwd: "",
            activePanelId: "",
            panels: [],
            task: { parentWorkspaceId: "active" },
          },
          {
            id: "after",
            name: "After",
            kind: "terminal",
            profileId: "profile-a",
            cwd: "",
            activePanelId: "",
            panels: [],
          },
        ],
        windowSlots: [
          {
            id: "win-a",
            profileId: "profile-a",
            activeWorkspaceId: "active",
            activeSessionId: "",
            bounds: { x: 0, y: 0, width: 1280, height: 800 },
            lastFocusedAt: 1000,
          },
        ],
      },
    });
    fixtures.push(fixture);

    await fixture.runtime.saveWorkspace(
      {
        id: "new",
        name: "New",
        kind: "terminal",
        profileId: "profile-a",
        cwd: "",
        activePanelId: "",
        panels: [],
      },
      "win-a",
    );

    expect(fixture.store.getState().workspaces.map((workspace) => workspace.id)).toEqual([
      "before",
      "active",
      "active-child",
      "new",
      "after",
    ]);
  });

  test("deleteWorkspace triggers syncTreeDirWatchers — git poll no longer re-adds removed parent tree (#42)", async () => {
    // syncTreeDirWatchers is called after deleteWorkspace (runtime.ts:5094).
    // After the parent is deleted and its tree-subdir removed from disk,
    // the next syncWorktrees/syncWorktreesImpl call should remove the orphaned
    // child worktree entry (CWD gone) and not re-add it (parent gone).
    //
    // Driven via the exposed runtime.syncWorktrees() rather than
    // vi.advanceTimersByTimeAsync — the timer-advance approach raced the
    // real fs.readdir inside the poll callback on macOS / Ubuntu runners.
    const parentDir = await fs.mkdtemp(path.join(os.tmpdir(), "strideterm-del-watcher-"));
    tempPaths.push(parentDir);
    const branchDir = path.join(parentDir, ".strideterm", "tree", "old-branch");
    await fs.mkdir(branchDir, { recursive: true });

    // createFixture init: syncWorktreesImpl detects branchDir and adds child workspace
    const fixture = await createFixture({
      initialState: {
        workspaces: [
          {
            id: "parent-del",
            name: "Parent Del",
            kind: "terminal",
            cwd: parentDir,
            activePanelId: "shell",
            panels: [{ id: "shell", title: "Shell", command: "", shell: true, startup: "default" }],
          },
        ],
      },
    });
    fixtures.push(fixture);

    // Verify child workspace was created by syncWorktreesImpl during init
    const before = fixture.runtime.getPayload().appState.workspaces!;
    expect(before.find((w) => w.cwd === branchDir)).toBeDefined();

    // Delete the parent workspace — calls syncTreeDirWatchers internally
    await fixture.runtime.deleteWorkspace("parent-del");

    // Remove the branchDir from disk so orphaned child is detected as missing
    await fs.rm(branchDir, { recursive: true, force: true });

    await fixture.runtime.syncWorktrees();

    const after = fixture.runtime.getPayload().appState.workspaces!;
    expect(after.find((w) => w.id === "parent-del")).toBeUndefined();
    expect(after.find((w) => w.cwd === branchDir)).toBeUndefined();
  });

  test("useWorktree create runs the guard BEFORE any disk side-effects (no orphan tree, no .gitignore mutation)", async () => {
    // Regression: previously the gitignore write, parent mkdir and
    // `git worktree add` all ran first, so a same-cwd conflict in useWorktree
    // mode would throw but leave orphan files. The guard must compute the
    // planned treePath synchronously and fire before any disk operations.
    const parentRoot = await fs.mkdtemp(path.join(os.tmpdir(), "strideterm-wt-preflight-"));
    tempPaths.push(parentRoot);
    const branch = "task/feature-x";
    const dirName = branch.replace(/\//g, "-");
    const plannedTreePath = path.join(parentRoot, ".strideterm", "tree", dirName);

    const execFileText = vi.fn().mockResolvedValue({ stdout: "", stderr: "" });
    const fixture = await createFixture({
      execFileTextImpl: execFileText,
      initialState: {
        workspaces: [
          {
            id: "parent",
            name: "Parent",
            kind: "terminal",
            cwd: parentRoot,
            activePanelId: "shell",
            panels: [{ id: "shell", title: "Shell", command: "", shell: true, startup: "default" }],
          },
          makeTaskWorkspace("task-a", "Live task", plannedTreePath, "running"),
        ],
      },
    });
    fixtures.push(fixture);
    await setTaskStateAfterInit(fixture, "task-a", "running");

    // Make sure no .gitignore exists yet so we can prove the guard fired
    // before the write would have happened.
    await fs.rm(path.join(parentRoot, ".gitignore"), { force: true });

    await expect(
      fixture.runtime.createTaskWorkspace({
        cwd: parentRoot,
        useWorktree: true,
        worktreeBranch: branch,
        parentWorkspaceId: "parent",
        description: "second task",
        activate: false,
      }),
    ).rejects.toThrow(/currently running/i);

    // Disk side-effects must NOT have happened:
    //   - .gitignore stays absent
    //   - The .strideterm/tree/<branch>/ dir is not created
    //   - execFileText was never called for `git worktree add`
    await expect(fs.access(path.join(parentRoot, ".gitignore"))).rejects.toThrow();
    await expect(fs.access(plannedTreePath)).rejects.toThrow();
    const gitCalls = execFileText.mock.calls.filter(
      (c) => c[0] === "git" && Array.isArray(c[1]) && c[1][0] === "worktree",
    );
    expect(gitCalls).toHaveLength(0);
  });

  test("active task in profile A does not block creation in profile B at the same cwd", async () => {
    // CLAUDE.md treats profiles as organizational, not storage isolation —
    // two profiles legitimately sharing a monorepo must be able to run
    // task agents at the same cwd in parallel. The guard scopes by profile,
    // so an "Active task" in profile A is invisible to profile B's create.
    const sharedCwd = await fs.mkdtemp(path.join(os.tmpdir(), "strideterm-profile-scope-"));
    tempPaths.push(sharedCwd);

    const fixture = await createFixture({
      initialState: {
        profiles: [
          { id: "profile-a", name: "Profile A" },
          { id: "profile-b", name: "Profile B" },
        ],
        windowSlots: [
          { id: "win-a", profileId: "profile-a" },
          { id: "win-b", profileId: "profile-b" },
        ],
        workspaces: [
          {
            ...makeTaskWorkspace("task-a", "A's task", sharedCwd, "running"),
            profileId: "profile-a",
          },
        ],
      },
    });
    fixtures.push(fixture);
    await setTaskStateAfterInit(fixture, "task-a", "running");

    // Sanity: same-profile create still blocks.
    await expect(
      fixture.runtime.createTaskWorkspace({ cwd: sharedCwd, description: "from A", activate: false }, "win-a"),
    ).rejects.toThrow(/currently running/i);

    // Profile-B create must succeed despite profile-A's running task.
    const result = await fixture.runtime.createTaskWorkspace(
      { cwd: sharedCwd, description: "from B", activate: false },
      "win-b",
    );
    expect(result?.workspaceId).toBeTruthy();
    const created = fixture.runtime.getPayload().appState.workspaces!.find((w) => w.id === result.workspaceId);
    expect(created?.profileId).toBe("profile-b");
  });

  test("pending-delete flag is held until session removal resolves (not just store.mutate)", async () => {
    // Reviewer-flagged race: releasing the pending flag right after
    // store.mutate leaves a window in which the old worker/judge PTY
    // processes are still alive and holding file handles in the cwd. The
    // fix awaits sessions.removeWorkspaceSessions inside the finally so the
    // lock persists until the OS has actually torn the processes down.
    const sharedCwd = await fs.mkdtemp(path.join(os.tmpdir(), "strideterm-hold-until-exit-"));
    tempPaths.push(sharedCwd);

    const fixture = await createFixture({
      initialState: {
        workspaces: [makeTaskWorkspace("task-a", "Old task", sharedCwd, "paused")],
      },
    });
    fixtures.push(fixture);

    // Make the session-exit promise controllable from the test. `sessionsRequested`
    // flips true the moment deleteWorkspace reaches removeWorkspaceSessions —
    // by then store.mutate has already removed task-a from state, so any
    // subsequent create observes the pending flag (not the still-present
    // workspace).
    let resolveSessions: () => void = () => {};
    let sessionsRequested = false;
    const sessionsExitPromise = new Promise<void>((resolve) => {
      resolveSessions = resolve;
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    fixture.sessionManager.removeWorkspaceSessions = (workspaceId: any) => {
      sessionsRequested = true;
      // Still actually remove the in-memory sessions so the rest of the
      // delete pipeline behaves normally — just defer the returned promise.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      for (const sessionId of [...fixture.sessionManager.sessions.keys()] as any[]) {
        if (sessionId.startsWith(`${workspaceId}:`)) fixture.sessionManager.sessions.delete(sessionId);
      }
      fixture.sessionManager.removedProjects.push(workspaceId);
      return sessionsExitPromise;
    };

    const deletePromise = fixture.runtime.deleteWorkspace("task-a");
    // Drive microtasks until deleteWorkspace reaches removeWorkspaceSessions
    // — that's the point where store.mutate has finished and the pending
    // flag is in its hold-during-PTY-exit phase. Polling avoids hard-coding
    // a number of `await Promise.resolve()` calls that would be brittle
    // against future re-ordering inside deleteWorkspace.
    for (let i = 0; i < 200 && !sessionsRequested; i++) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    expect(sessionsRequested).toBe(true);

    expect(fixture.runtime.getPayload().appState.workspaces!.find((w) => w.id === "task-a")).toBeUndefined();
    await expect(
      fixture.runtime.createTaskWorkspace({
        cwd: sharedCwd,
        description: "racing create",
        activate: false,
      }),
    ).rejects.toThrow(/still finishing cleanup/i);

    // Release the PTY exit promise — pending flag should now drain and the
    // delete promise should resolve.
    resolveSessions();
    await deletePromise;

    // A subsequent create at the same cwd succeeds.
    const result = await fixture.runtime.createTaskWorkspace({
      cwd: sharedCwd,
      description: "fresh task",
      activate: false,
    });
    expect(result?.workspaceId).toBeTruthy();
  });

  test("Krok 5: cleanupTaskFiles runs only after the worker/judge PTYs have exited", async () => {
    const sharedCwd = await fs.mkdtemp(path.join(os.tmpdir(), "strideterm-krok5-cleanup-"));
    tempPaths.push(sharedCwd);

    // makeTaskWorkspace assigns taskId `${id}-tid`.
    const taskId = "task-a-tid";
    const taskFilesDir = path.join(sharedCwd, ".strideterm", "tasks", taskId);
    await fs.mkdir(taskFilesDir, { recursive: true });
    await fs.writeFile(path.join(taskFilesDir, "TASK.md"), "task brief");
    const exists = (p: string) =>
      fs
        .access(p)
        .then(() => true)
        .catch(() => false);

    const fixture = await createFixture({
      initialState: { workspaces: [makeTaskWorkspace("task-a", "Old task", sharedCwd, "paused")] },
    });
    fixtures.push(fixture);

    // Defer PTY exit so we can observe the cleanup ordering.
    let resolveSessions: () => void = () => {};
    let sessionsRequested = false;
    const sessionsExitPromise = new Promise<void>((resolve) => {
      resolveSessions = resolve;
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    fixture.sessionManager.removeWorkspaceSessions = (workspaceId: any) => {
      sessionsRequested = true;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      for (const sessionId of [...fixture.sessionManager.sessions.keys()] as any[]) {
        if (sessionId.startsWith(`${workspaceId}:`)) fixture.sessionManager.sessions.delete(sessionId);
      }
      fixture.sessionManager.removedProjects.push(workspaceId);
      return sessionsExitPromise;
    };

    const deletePromise = fixture.runtime.deleteWorkspace("task-a");
    for (let i = 0; i < 200 && !sessionsRequested; i++) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    expect(sessionsRequested).toBe(true);

    // PTYs not yet exited → cleanup must NOT have run → task files still present.
    await new Promise((resolve) => setImmediate(resolve));
    expect(await exists(taskFilesDir)).toBe(true);

    // Release PTY exit → cleanup now runs in the finally.
    resolveSessions();
    await deletePromise;

    expect(await exists(taskFilesDir)).toBe(false);
  });

  test("Krok 5: cleanupTaskFiles failure is best-effort — delete still succeeds and releases the cwd guard", async () => {
    const sharedCwd = await fs.mkdtemp(path.join(os.tmpdir(), "strideterm-krok5-throws-"));
    tempPaths.push(sharedCwd);
    const fixture = await createFixture({
      initialState: { workspaces: [makeTaskWorkspace("task-a", "Old task", sharedCwd, "paused")] },
    });
    fixtures.push(fixture);

    const spy = vi.spyOn(AgentTaskRunner.prototype, "cleanupTaskFiles").mockRejectedValue(new Error("EBUSY: locked"));
    try {
      // Cleanup throws, but the (already-completed) delete must still resolve.
      const result = await fixture.runtime.deleteWorkspace("task-a");
      expect(result).toBeDefined();
      expect(spy).toHaveBeenCalledTimes(1);
      // pendingKey was released in the finally despite the throw → a fresh task at
      // the same cwd can be created (it wouldn't if the guard were still held).
      const created = await fixture.runtime.createTaskWorkspace({
        cwd: sharedCwd,
        description: "fresh task",
        activate: false,
      });
      expect(created?.workspaceId).toBeTruthy();
    } finally {
      spy.mockRestore();
    }
  });

  test("Krok 5: cleanupTaskFiles still runs in the finally when store.mutate throws", async () => {
    const sharedCwd = await fs.mkdtemp(path.join(os.tmpdir(), "strideterm-krok5-mutate-"));
    tempPaths.push(sharedCwd);
    const fixture = await createFixture({
      initialState: { workspaces: [makeTaskWorkspace("task-a", "Old task", sharedCwd, "paused")] },
    });
    fixtures.push(fixture);

    const spy = vi.spyOn(AgentTaskRunner.prototype, "cleanupTaskFiles").mockResolvedValue(undefined);
    const origMutate = fixture.store.mutate;
    // Make the workspace-removal mutate throw — cleanup must still run (finally),
    // matching the previous pre-mutate placement's "always runs" semantics.
    fixture.store.mutate = vi.fn(async () => {
      throw new Error("mutate boom");
    });
    try {
      await expect(fixture.runtime.deleteWorkspace("task-a")).rejects.toThrow(/mutate boom/);
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      fixture.store.mutate = origMutate;
      spy.mockRestore();
    }
  });

  test("Krok 5: deleting a non-task workspace never calls cleanupTaskFiles", async () => {
    const fixture = await createFixture({
      initialState: {
        workspaces: [
          {
            id: "plain",
            name: "Plain",
            kind: "terminal",
            cwd: "/tmp/plain-krok5",
            activePanelId: "shell",
            panels: [{ id: "shell", title: "Shell", command: "", shell: true, startup: "default" }],
          },
        ],
      },
    });
    fixtures.push(fixture);

    const spy = vi.spyOn(AgentTaskRunner.prototype, "cleanupTaskFiles");
    try {
      await fixture.runtime.deleteWorkspace("plain");
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  test("startTask refuses when another task in the same profile is already active at the same cwd", async () => {
    // createTaskWorkspace allows two paused tasks at the same cwd to coexist
    // (paused is inert, no worker process running). Starting one is fine,
    // but starting the SECOND would put two worker agents in the same dir.
    // startTask must refuse the second start with the same message.
    const sharedCwd = await fs.mkdtemp(path.join(os.tmpdir(), "strideterm-start-guard-"));
    tempPaths.push(sharedCwd);

    const fixture = await createFixture({
      initialState: {
        workspaces: [
          makeTaskWorkspace("task-a", "Task A", sharedCwd, "paused"),
          makeTaskWorkspace("task-b", "Task B", sharedCwd, "paused"),
        ],
      },
    });
    fixtures.push(fixture);

    // Flip task-a to running (simulating a successful start). The runtime
    // exposes setTaskStateAfterInit-equivalent behavior through the store.
    await setTaskStateAfterInit(fixture, "task-a", "running");

    await expect(fixture.runtime.startTask("task-b")).rejects.toThrow(/currently running/i);

    // Sanity: starting task-a itself (already running) does NOT trip the
    // guard — selfWorkspaceId excludes the calling workspace.
    // taskRunner.startTask will no-op or return false depending on internal
    // state; the important thing is that the cwd guard doesn't false-positive
    // on the workspace's own active state.
    await expect(fixture.runtime.startTask("task-a")).resolves.toBeDefined();
  });

  test("resumeTask refuses when another task in the same profile is actively touching the cwd", async () => {
    // Same scenario as startTask, but exercising resumeTask. Resume re-spawns
    // PTYs — the second resume would put two workers in the same directory.
    const sharedCwd = await fs.mkdtemp(path.join(os.tmpdir(), "strideterm-resume-guard-"));
    tempPaths.push(sharedCwd);

    const fixture = await createFixture({
      initialState: {
        workspaces: [
          makeTaskWorkspace("task-a", "Task A", sharedCwd, "paused"),
          makeTaskWorkspace("task-b", "Task B", sharedCwd, "paused"),
        ],
      },
    });
    fixtures.push(fixture);
    await setTaskStateAfterInit(fixture, "task-a", "running");

    // resumeTask is now async (Krok 6 delegates recovery candidates to the
    // async resolveTaskRecovery), so the guard surfaces as a rejected promise.
    await expect(fixture.runtime.resumeTask("task-b")).rejects.toThrow(/currently running/i);
  });

  test("createWorktree on multi-repo workspace requires rootPath and runs inside the selected repo", async () => {
    const parentRoot = await fs.mkdtemp(path.join(os.tmpdir(), "strideterm-multirepo-"));
    tempPaths.push(parentRoot);
    const repoA = path.join(parentRoot, "service-a");
    const repoB = path.join(parentRoot, "service-b");
    await fs.mkdir(repoA, { recursive: true });
    await fs.mkdir(repoB, { recursive: true });

    const fixture = await createFixture({
      initialState: {
        activeProjectId: "stack",
        projects: [
          {
            id: "stack",
            name: "Stack",
            icon: "ST",
            color: "#ffa424",
            kind: "terminal",
            cwd: parentRoot,
            gitRoots: [repoA, repoB],
            activePanelId: "dev",
            panels: [{ id: "dev", title: "Dev", command: "", shell: true, startup: "default" }],
          },
        ],
      },
    });
    fixtures.push(fixture);

    await expect(fixture.runtime.createWorktree({ projectId: "stack", name: "feature-x" })).rejects.toThrow(
      /Multi-repo workspace requires a repository/i,
    );

    await expect(
      fixture.runtime.createWorktree({ projectId: "stack", name: "feature-x", rootPath: "/bogus/path" }),
    ).rejects.toThrow(/not part of this workspace/i);

    const payload = await fixture.runtime.createWorktree({
      projectId: "stack",
      name: "feature-x",
      rootPath: repoA,
    });

    expect(fixture.execFileText).toHaveBeenCalledWith(
      "git",
      ["worktree", "add", path.join(repoA, ".strideterm", "tree", "feature-x"), "-b", "feature-x"],
      { cwd: repoA },
    );
    const gitignore = await fs.readFile(path.join(repoA, ".gitignore"), "utf8");
    expect(gitignore).toContain(".strideterm/");
    const child = payload.appState.workspaces.find((p) => p.name === "Stack / feature-x");
    expect(child?.cwd).toBe(path.join(repoA, ".strideterm", "tree", "feature-x"));
    // Child inherits nothing from multi-repo — it's a single-repo worktree
    expect(child?.gitRoots || []).toHaveLength(0);
  });

  test("returns structured payload for git fetch and diff preview actions", async () => {
    const fixture = await createFixture({
      initialState: {
        activeProjectId: "backend",
        projects: [
          {
            id: "backend",
            name: "Backend",
            kind: "terminal",
            cwd: "/tmp/backend",
            activePanelId: "shell",
            panels: [{ id: "shell", title: "Shell", command: "", shell: true, startup: "default" }],
          },
        ],
      },
    });
    fixtures.push(fixture);

    await fixture.runtime.refreshGitState("backend");
    const fetchResult = await fixture.runtime.gitFetch({ projectId: "backend" });
    const diffResult = await fixture.runtime.gitDiffPreview({
      projectId: "backend",
      path: "src/app.js",
      scope: "unstaged",
    });

    expect(fetchResult.result).toMatchObject({
      ok: true,
      summary: "Fetch completed.",
    });
    expect(fetchResult.payload.git.activeWorkspace).toBeTruthy();
    expect(fixture.git.actions[0]).toMatchObject({
      kind: "fetch",
      workspaceId: "backend",
    });
    expect(diffResult).toMatchObject({
      ok: true,
      path: "src/app.js",
      scope: "unstaged",
    });
    expect(fixture.git.actions[1]).toMatchObject({
      kind: "diff",
      workspaceId: "backend",
    });
  });

  test("saves and deletes profiles while preserving a fallback default profile", async () => {
    const fixture = await createFixture();
    fixtures.push(fixture);

    let payload = await fixture.runtime.saveProfile({
      id: "focus",
      name: "Focus",
      workspaceIds: ["frontend"],
    });
    expect(payload.appState.profiles.some((profile) => profile.id === "focus")).toBe(true);

    payload = await fixture.runtime.deleteProfile("focus");
    expect(payload.appState.profiles).toEqual([
      { id: "default", name: "Default", color: "#ffa424", workspaceIds: [], projectIds: [], workspaceGrid: null },
    ]);
  });

  test("does not rewrite the store during runtime stop", async () => {
    const fixture = await createFixture();
    fixtures.push(fixture);

    expect(fixture.store.saveCalls).toBe(0);
    await fixture.runtime.stop();
    expect(fixture.store.saveCalls).toBe(0);
  });

  // Regression: per-window workspace activation must keep global activeWorkspaceId
  // in sync with the activated workspace. `getPayload()` builds `payload.workspace`
  // from `state.activeWorkspaceId` (via sessions.getWorkspace), so the renderer's
  // main pane stays on the previously-active workspace unless the global is updated.
  // normalizeState derives the active profile from activeWorkspaceId, so keeping that
  // field in sync also ensures subsequent normalization passes validate correctly.
  test("activateWorkspaceInWindow mirrors slot updates into global activeWorkspaceId", async () => {
    const fixture = await createFixture({
      initialState: {
        activeWorkspaceId: "frontend",
        profiles: [{ id: "default", name: "Default", color: "#fff", workspaceIds: [], workspaceGrid: null }],
        workspaces: [
          {
            id: "frontend",
            name: "Frontend",
            kind: "terminal",
            cwd: "/tmp/frontend",
            profileId: "default",
            panels: [{ id: "p1", title: "Shell", command: "", shell: true, startup: "default" }],
            activePanelId: "p1",
          },
          {
            id: "backend",
            name: "Backend",
            kind: "terminal",
            cwd: "/tmp/backend",
            profileId: "default",
            panels: [{ id: "p2", title: "Shell", command: "", shell: true, startup: "default" }],
            activePanelId: "p2",
          },
        ],
        windowSlots: [
          {
            id: "win-1",
            profileId: "default",
            activeWorkspaceId: "frontend",
            activeSessionId: "",
            bounds: { x: 0, y: 0, width: 1280, height: 800 },
            lastFocusedAt: Date.now(),
          },
        ],
      },
    });
    fixtures.push(fixture);

    const payload = await fixture.runtime.activateWorkspaceInWindow("backend", "win-1");

    // Slot updated as before.
    expect(payload.appState.windowSlots?.find((s) => s.id === "win-1")?.activeWorkspaceId).toBe("backend");
    // Global mirrored — guards against the bug where `payload.workspace` (built
    // from sessions.getWorkspace(state.activeWorkspaceId)) stays on the previous
    // workspace and the renderer main pane never visually switches.
    expect(payload.appState.activeWorkspaceId).toBe("backend");
  });

  test("activateProfileInWindow keeps global activeWorkspaceId in sync with the new profile", async () => {
    // activateProfileInWindow writes draft.activeWorkspaceId = firstWorkspaceInNewProfile.
    // normalizeState derives the active profile from that workspace's profileId,
    // so subsequent workspace activations are validated against the correct profile
    // and do not get silently reverted by normalizeState.
    const fixture = await createFixture({
      initialState: {
        activeProfileId: "profile-a",
        activeWorkspaceId: "ws-a1",
        profiles: [
          { id: "profile-a", name: "A", color: "#fff", workspaceIds: [], workspaceGrid: null },
          { id: "profile-b", name: "B", color: "#fff", workspaceIds: [], workspaceGrid: null },
        ],
        workspaces: [
          {
            id: "ws-a1",
            name: "A1",
            kind: "terminal",
            cwd: "/tmp/a1",
            profileId: "profile-a",
            panels: [{ id: "p1", title: "Shell", command: "", shell: true, startup: "default" }],
            activePanelId: "p1",
          },
          {
            id: "ws-b1",
            name: "B1",
            kind: "terminal",
            cwd: "/tmp/b1",
            profileId: "profile-b",
            panels: [{ id: "p2", title: "Shell", command: "", shell: true, startup: "default" }],
            activePanelId: "p2",
          },
          {
            id: "ws-b2",
            name: "B2",
            kind: "terminal",
            cwd: "/tmp/b2",
            profileId: "profile-b",
            panels: [{ id: "p3", title: "Shell", command: "", shell: true, startup: "default" }],
            activePanelId: "p3",
          },
        ],
        windowSlots: [
          {
            id: "win-1",
            profileId: "profile-a",
            activeWorkspaceId: "ws-a1",
            activeSessionId: "",
            bounds: { x: 0, y: 0, width: 1280, height: 800 },
            lastFocusedAt: Date.now(),
          },
        ],
      },
    });
    fixtures.push(fixture);

    const payload = await fixture.runtime.activateProfileInWindow("profile-b", "win-1");

    expect(payload.appState.windowSlots?.find((s) => s.id === "win-1")?.profileId).toBe("profile-b");
    expect(payload.appState.windowSlots?.find((s) => s.id === "win-1")?.activeWorkspaceId).toBe("ws-b1");
    expect(payload.appState.activeWorkspaceId).toBe("ws-b1");
  });

  test("activateProfileInWindow spawns PTYs for the new active workspace's default-startup panels", async () => {
    // After profile switch the window shows the new profile's first workspace.
    // Its default-startup panels must already be running by the time the IPC
    // call returns — otherwise the renderer paints empty panes with "0 running"
    // while it waits for the user to interact with each tab.
    const fixture = await createFixture({
      initialState: {
        activeProfileId: "profile-a",
        activeWorkspaceId: "ws-a1",
        profiles: [
          { id: "profile-a", name: "A", color: "#fff", workspaceIds: [], workspaceGrid: null },
          { id: "profile-b", name: "B", color: "#fff", workspaceIds: [], workspaceGrid: null },
        ],
        workspaces: [
          {
            id: "ws-a1",
            name: "A1",
            kind: "terminal",
            cwd: "/tmp/a1",
            profileId: "profile-a",
            panels: [{ id: "p-a1", title: "Shell", command: "", shell: true, startup: "default" }],
            activePanelId: "p-a1",
          },
          {
            id: "ws-b1",
            name: "B1",
            kind: "terminal",
            cwd: "/tmp/b1",
            profileId: "profile-b",
            panels: [
              { id: "p-b1-shell", title: "Shell", command: "", shell: true, startup: "default" },
              { id: "p-b1-claude", title: "Claude", command: "claude", shell: true, startup: "default" },
            ],
            activePanelId: "p-b1-shell",
          },
        ],
        windowSlots: [
          {
            id: "win-1",
            profileId: "profile-a",
            activeWorkspaceId: "ws-a1",
            activeSessionId: "",
            bounds: { x: 0, y: 0, width: 1280, height: 800 },
            lastFocusedAt: Date.now(),
          },
        ],
      },
    });
    fixtures.push(fixture);

    const payload = await fixture.runtime.activateProfileInWindow("profile-b", "win-1");

    expect(payload.appState.activeWorkspaceId).toBe("ws-b1");
    expect(fixture.sessionManager.sessions.get("ws-b1:p-b1-shell")?.status).toBe("running");
    expect(fixture.sessionManager.sessions.get("ws-b1:p-b1-claude")?.status).toBe("running");
    const wsSessions = payload.workspace?.sessions || [];
    const running = wsSessions.filter((s: { status: string }) => s.status === "running");
    expect(running).toHaveLength(2);
  });

  test("createWindowSlot spawns PTYs for the new window's first workspace", async () => {
    // Opening a new window for another profile from the sidebar lands the
    // user on that profile's first workspace. Without spawning here the
    // window paints empty panes with "0 running" until the user clicks away
    // and back — the per-window flow has no other trigger that calls
    // ensureSession on the freshly chosen active workspace.
    const fixture = await createFixture({
      initialState: {
        activeProfileId: "profile-a",
        activeWorkspaceId: "ws-a1",
        profiles: [
          { id: "profile-a", name: "A", color: "#fff", workspaceIds: [], workspaceGrid: null },
          { id: "profile-b", name: "B", color: "#fff", workspaceIds: [], workspaceGrid: null },
        ],
        workspaces: [
          {
            id: "ws-a1",
            name: "A1",
            kind: "terminal",
            cwd: "/tmp/a1",
            profileId: "profile-a",
            panels: [{ id: "p-a1", title: "Shell", command: "", shell: true, startup: "default" }],
            activePanelId: "p-a1",
          },
          {
            id: "ws-b1",
            name: "B1",
            kind: "terminal",
            cwd: "/tmp/b1",
            profileId: "profile-b",
            panels: [
              { id: "p-b1-shell", title: "Shell", command: "", shell: true, startup: "default" },
              { id: "p-b1-claude", title: "Claude", command: "claude", shell: true, startup: "default" },
            ],
            activePanelId: "p-b1-shell",
          },
        ],
        windowSlots: [
          {
            id: "win-1",
            profileId: "profile-a",
            activeWorkspaceId: "ws-a1",
            activeSessionId: "",
            bounds: { x: 0, y: 0, width: 1280, height: 800 },
            lastFocusedAt: Date.now(),
          },
        ],
      },
    });
    fixtures.push(fixture);

    await fixture.runtime.createWindowSlot("profile-b");

    expect(fixture.sessionManager.sessions.get("ws-b1:p-b1-shell")?.status).toBe("running");
    expect(fixture.sessionManager.sessions.get("ws-b1:p-b1-claude")?.status).toBe("running");
  });

  test("activateWorkspaceInWindow on cross-profile target does not revert activeWorkspaceId", async () => {
    // Activating a workspace in profile A writes draft.activeWorkspaceId = ws-a2;
    // normalizeState then derives the active profile from ws-a2's profileId,
    // so subsequent normalization passes validate activeWorkspaceId against A's
    // workspaces and do not silently revert the click.
    const fixture = await createFixture({
      initialState: {
        activeProfileId: "profile-b",
        activeWorkspaceId: "ws-b1",
        profiles: [
          { id: "profile-a", name: "A", color: "#fff", workspaceIds: [], workspaceGrid: null },
          { id: "profile-b", name: "B", color: "#fff", workspaceIds: [], workspaceGrid: null },
        ],
        workspaces: [
          {
            id: "ws-a1",
            name: "A1",
            kind: "terminal",
            cwd: "/tmp/a1",
            profileId: "profile-a",
            panels: [{ id: "p1", title: "Shell", command: "", shell: true, startup: "default" }],
            activePanelId: "p1",
          },
          {
            id: "ws-a2",
            name: "A2",
            kind: "terminal",
            cwd: "/tmp/a2",
            profileId: "profile-a",
            panels: [{ id: "p2", title: "Shell", command: "", shell: true, startup: "default" }],
            activePanelId: "p2",
          },
          {
            id: "ws-b1",
            name: "B1",
            kind: "terminal",
            cwd: "/tmp/b1",
            profileId: "profile-b",
            panels: [{ id: "p3", title: "Shell", command: "", shell: true, startup: "default" }],
            activePanelId: "p3",
          },
        ],
        windowSlots: [
          {
            id: "win-1",
            profileId: "profile-a",
            activeWorkspaceId: "ws-a1",
            activeSessionId: "",
            bounds: { x: 0, y: 0, width: 1280, height: 800 },
            lastFocusedAt: Date.now(),
          },
        ],
      },
    });
    fixtures.push(fixture);

    // Sanity: win-1 slot is on profile A
    const before = fixture.store.getState();
    expect(before.windowSlots?.[0].profileId).toBe("profile-a");

    const payload = await fixture.runtime.activateWorkspaceInWindow("ws-a2", "win-1");

    expect(payload.appState.windowSlots?.find((s) => s.id === "win-1")?.activeWorkspaceId).toBe("ws-a2");
    expect(payload.appState.activeWorkspaceId).toBe("ws-a2");
  });

  test("workspace grid operations without windowId target the first slot (legacy path)", async () => {
    // The grid is viewer-owned: mutations land on the window slot, never on
    // the profile (the profile grid stays a legacy/default seed). Payloads
    // without a windowId (old clients) fall back to the first slot.
    const fixture = await createFixture({
      initialState: {
        activeProfileId: "profile-b",
        activeWorkspaceId: "ws-b1",
        workspaceGrid: null,
        profiles: [
          { id: "profile-a", name: "A", color: "#fff", workspaceIds: [], workspaceGrid: null },
          { id: "profile-b", name: "B", color: "#fff", workspaceIds: [], workspaceGrid: null },
        ],
        workspaces: [
          {
            id: "ws-a1",
            name: "A1",
            kind: "terminal",
            cwd: "/tmp/a1",
            profileId: "profile-a",
            panels: [{ id: "p1", title: "Shell", command: "", shell: true, startup: "default" }],
            activePanelId: "p1",
          },
          {
            id: "ws-b1",
            name: "B1",
            kind: "terminal",
            cwd: "/tmp/b1",
            profileId: "profile-b",
            panels: [{ id: "p2", title: "Shell", command: "", shell: true, startup: "default" }],
            activePanelId: "p2",
          },
          {
            id: "ws-b2",
            name: "B2",
            kind: "terminal",
            cwd: "/tmp/b2",
            profileId: "profile-b",
            panels: [{ id: "p3", title: "Shell", command: "", shell: true, startup: "default" }],
            activePanelId: "p3",
          },
        ],
      },
    });
    fixtures.push(fixture);

    const firstSlotGrid = (payload: Awaited<ReturnType<typeof fixture.runtime.getPayload>>) =>
      payload.appState.windowSlots?.[0]?.workspaceGrid;

    let payload = await fixture.runtime.enableWorkspaceGrid("cols", ["ws-b1", "ws-b2"]);
    expect(firstSlotGrid(payload)).toEqual({
      layout: "cols",
      cellWorkspaceIds: ["ws-b1", "ws-b2"],
    });
    // Profiles stay untouched — the grid is viewer state, not profile state.
    expect(payload.appState.profiles.find((p) => p.id === "profile-a")?.workspaceGrid).toBeNull();
    expect(payload.appState.profiles.find((p) => p.id === "profile-b")?.workspaceGrid).toBeNull();

    payload = await fixture.runtime.setGridCell(1, null);
    expect(firstSlotGrid(payload)).toEqual({
      layout: "cols",
      cellWorkspaceIds: ["ws-b1", null],
    });

    payload = await fixture.runtime.setGridLayout("grid");
    expect(firstSlotGrid(payload)).toEqual({
      layout: "grid",
      cellWorkspaceIds: ["ws-b1", null, null, null],
    });

    await fixture.runtime.setGridCell(2, "ws-b2");
    payload = await fixture.runtime.swapGridCells(0, 2);
    expect(firstSlotGrid(payload)).toEqual({
      layout: "grid",
      cellWorkspaceIds: ["ws-b2", null, "ws-b1", null],
    });

    payload = await fixture.runtime.disableWorkspaceGrid();
    expect(firstSlotGrid(payload)).toBeNull();
  });

  // ---------------------------------------------------------------------------
  // Plan § 6: Critical scenario regression tests.
  //
  // These enforce the invariants the notifications redesign is built on.
  // Each failure corresponds to a user-visible regression; don't ship red.
  // ---------------------------------------------------------------------------

  async function createTwoWorkspaceFixture() {
    return createFixture({
      initialState: {
        activeProjectId: "frontend",
        projects: [
          {
            id: "frontend",
            name: "Frontend",
            kind: "terminal",
            cwd: "/tmp/frontend",
            activePanelId: "claude",
            panels: [{ id: "claude", title: "Claude Code", command: "claude", shell: true, startup: "default" }],
          },
          {
            id: "backend",
            name: "Backend",
            kind: "terminal",
            cwd: "/tmp/backend",
            activePanelId: "shell",
            panels: [{ id: "shell", title: "Shell", command: "", shell: true, startup: "default" }],
          },
        ],
      },
    });
  }

  test("(Gap 2 regression) permission_prompt during idle cooldown fires urgent alert", async () => {
    vi.useFakeTimers();
    try {
      const fixture = await createTwoWorkspaceFixture();
      fixtures.push(fixture);

      // Put backend session off-screen so alerts land.
      await fixture.runtime.syncAttentionContext({ visibleSessionIds: ["frontend:claude"] });
      fixture.sessionManager.emit("terminal:data", { sessionId: "backend:shell", data: "$ " });
      await vi.advanceTimersByTimeAsync(16_000);
      fixture.runtime.writeToSession("backend:shell", "claude\r");

      // First alert: normal idle_prompt.
      fixture.runtime.notifyAgentHook("backend:shell", "idle_prompt");
      expect(fixture.runtime.getPayload().attention.byProject.backend.alerts[0]).toMatchObject({
        urgency: "normal",
        detail: "hook:Notification:idle_prompt",
      });

      // Inside the 15s standard cooldown window (5s elapsed) — a second
      // idle_prompt would be suppressed, but permission_prompt is urgent and
      // MUST reach the user even inside cooldown.
      await vi.advanceTimersByTimeAsync(5_000);
      fixture.runtime.notifyAgentHook("backend:shell", "permission_prompt");

      const alerts = fixture.runtime.getPayload().attention.byProject.backend.alerts;
      expect(alerts[0]).toMatchObject({
        urgency: "urgent",
        detail: "hook:Notification:permission_prompt",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  test("(Gap 2 regression) urgent alert still respects its own 3s short cooldown", async () => {
    vi.useFakeTimers();
    try {
      const fixture = await createTwoWorkspaceFixture();
      fixtures.push(fixture);

      await fixture.runtime.syncAttentionContext({ visibleSessionIds: ["frontend:claude"] });
      fixture.sessionManager.emit("terminal:data", { sessionId: "backend:shell", data: "$ " });
      await vi.advanceTimersByTimeAsync(16_000);
      fixture.runtime.writeToSession("backend:shell", "claude\r");

      // Two permission_prompts within 3s — second is coalesced.
      fixture.runtime.notifyAgentHook("backend:shell", "permission_prompt");
      const firstAt = fixture.runtime.getPayload().attention.byProject.backend.alerts[0].at;

      await vi.advanceTimersByTimeAsync(1_000);
      fixture.runtime.notifyAgentHook("backend:shell", "permission_prompt");
      const stillFirst = fixture.runtime.getPayload().attention.byProject.backend.alerts[0].at;
      expect(stillFirst).toBe(firstAt);

      // After 3s urgent cooldown expires, next urgent alert lands.
      await vi.advanceTimersByTimeAsync(3_500);
      fixture.runtime.notifyAgentHook("backend:shell", "permission_prompt");
      const newer = fixture.runtime.getPayload().attention.byProject.backend.alerts[0].at;
      expect(newer).not.toBe(firstAt);
    } finally {
      vi.useRealTimers();
    }
  });

  test("completion-hook-capable agent session does NOT raise T3 silence alert", async () => {
    vi.useFakeTimers();
    try {
      const fixture = await createTwoWorkspaceFixture();
      fixtures.push(fixture);

      await fixture.runtime.syncAttentionContext({ visibleSessionIds: ["frontend:claude"] });
      // Prime the session as agent-like with user input
      fixture.sessionManager.emit("terminal:data", { sessionId: "backend:shell", data: "claude code v1.0\n" });
      await vi.advanceTimersByTimeAsync(16_000);
      fixture.runtime.writeToSession("backend:shell", "do a thing\r");

      // A completion hook fires once — now signal.completionHookCapable = true. We clear the
      // alert (simulates user ack'ing) so the next detector cycle starts fresh.
      fixture.runtime.notifyAgentHook("backend:shell", "idle_prompt");
      expect(fixture.runtime.getPayload().attention.byProject.backend).toMatchObject({ count: 1 });
      fixture.runtime.clearAlertForSession("backend:shell", { dismissed: false });

      // Simulate a long burst of output + long silence. Without completion hook
      // gating this would trigger a T3 silence alert; with it, nothing fires.
      for (let i = 0; i < 20; i += 1) {
        fixture.sessionManager.emit("terminal:data", { sessionId: "backend:shell", data: `line ${i}\n` });
      }
      // Well past agentQuietMs (45s) and agentQuietFastMs (25s).
      await vi.advanceTimersByTimeAsync(120_000);

      expect(fixture.runtime.getPayload().attention.byProject.backend).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  test("completion-hook-capable agent session ignores BEL while still running", async () => {
    vi.useFakeTimers();
    try {
      const fixture = await createTwoWorkspaceFixture();
      fixtures.push(fixture);

      await fixture.runtime.syncAttentionContext({ visibleSessionIds: ["frontend:claude"] });
      fixture.sessionManager.emit("terminal:data", { sessionId: "backend:shell", data: "claude code v1.0\n" });
      await vi.advanceTimersByTimeAsync(16_000);
      fixture.runtime.writeToSession("backend:shell", "do a thing\r");

      fixture.runtime.notifyAgentHook("backend:shell", "idle_prompt");
      expect(fixture.runtime.getPayload().attention.byProject.backend).toMatchObject({ count: 1 });
      fixture.runtime.clearAlertForSession("backend:shell", { dismissed: false });

      // Some agent TUIs emit BEL while redrawing or thinking. With hooks
      // proven, BEL must not become a user-visible "waiting" alert.
      await vi.advanceTimersByTimeAsync(6_000);
      fixture.sessionManager.emit("terminal:data", { sessionId: "backend:shell", data: "still working\u0007\n" });

      expect(fixture.runtime.getPayload().attention.byProject.backend).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  test("hook-primary mode never raises silence-fallback waiting alert", async () => {
    vi.useFakeTimers();
    try {
      const fixture = await createTwoWorkspaceFixture();
      fixtures.push(fixture);

      await fixture.runtime.syncAttentionContext({ visibleSessionIds: ["frontend:claude"] });
      fixture.sessionManager.emit("terminal:data", { sessionId: "backend:shell", data: "openai codex\n" });
      fixture.runtime.writeToSession("backend:shell", "do a thing\r");

      // With the notify server running, hooks are the only user-facing alert
      // source. Even if completion hooks never arrive (e.g. Stop blocked by
      // Codex /hooks review, or an idle prompt while a background agent is
      // still working), silence must NOT produce a "waiting" alert.
      fixture.runtime.notifyAgentHook("backend:shell", "", "UserPromptSubmit");
      await vi.advanceTimersByTimeAsync(16_000);

      fixture.sessionManager.emit("terminal:data", { sessionId: "backend:shell", data: "working\n" });
      fixture.sessionManager.emit("terminal:data", { sessionId: "backend:shell", data: "> " });
      await vi.advanceTimersByTimeAsync(120_000);

      expect(fixture.runtime.getPayload().attention.byProject.backend).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  test("agentLike demotes when OSC 133;D shows a strict shell prompt, re-promotes on next agent output", async () => {
    const fixture = await createTwoWorkspaceFixture();
    fixtures.push(fixture);
    const agentLike = () =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (fixture.runtime.getPayload().attention.sessions["backend:shell"] as any)?.agentLike;

    await fixture.runtime.syncAttentionContext({ visibleSessionIds: ["frontend:claude"] });
    fixture.sessionManager.emit("terminal:data", { sessionId: "backend:shell", data: "claude code v1.0\n" });
    expect(agentLike()).toBe(true);

    // Agent exits back to the host shell: shell integration emits OSC 133;D
    // and an unambiguous shell prompt repaints.
    fixture.sessionManager.emit("terminal:data", {
      sessionId: "backend:shell",
      data: "\u001b]133;D;0\u0007PS C:\\backend> ",
    });
    expect(agentLike()).toBe(false);

    // Ambiguous ❯ prompts must NOT demote (agent TUI status lines use them):
    // re-promote via agent output, then feed an OSC chunk ending in ❯.
    fixture.sessionManager.emit("terminal:data", { sessionId: "backend:shell", data: "claude code v1.0\n" });
    expect(agentLike()).toBe(true);
    fixture.sessionManager.emit("terminal:data", {
      sessionId: "backend:shell",
      data: "\u001b]133;D;0\u0007❯ ",
    });
    expect(agentLike()).toBe(true);
  });

  test("notify server restart re-registers notify URLs for live sessions", async () => {
    const fixture = await createTwoWorkspaceFixture();
    fixtures.push(fixture);

    // A live PTY session known to the session manager.
    fixture.sessionManager.sessions.set("backend:shell", { status: "running" });

    // Toggle the agentHook setting off and back on — the server restarts on
    // a new port; without the refresh, hooks for the live session would keep
    // POSTing to the dead old port until the session respawned.
    await fixture.runtime.updateSettings({ notifications: { agentHook: false } });
    await fixture.runtime.updateSettings({ notifications: { agentHook: true } });

    const urlsPath = path.join(fixture.userDataPath, "hooks", "notify-urls.json");
    const data = JSON.parse(await fs.readFile(urlsPath, "utf8"));
    const urls: string[] = data["/tmp/backend"] || [];
    expect(urls.length).toBeGreaterThan(0);
    expect(urls.some((u) => u.includes("sid=backend%3Ashell"))).toBe(true);
  });

  test("repeat idle_prompt with no new activity does NOT re-alert (real-world repeat bug)", async () => {
    vi.useFakeTimers();
    try {
      // Real-world scenario from user report: Claude fired idle_prompt once,
      // user jumped to the session, navigated away, Claude fired idle_prompt
      // AGAIN for the same waiting state → spurious second notification.
      //
      // Expected behavior: repeat hooks without new output bursts or a
      // UserPromptSubmit in between are coalesced silently.
      const fixture = await createTwoWorkspaceFixture();
      fixtures.push(fixture);

      // Backend tab off-screen; prime as agent-like via AGENT_OUTPUT_RE match.
      await fixture.runtime.syncAttentionContext({ visibleSessionIds: ["frontend:claude"] });
      fixture.sessionManager.emit("terminal:data", { sessionId: "backend:shell", data: "claude code v1.0\n" });
      await vi.advanceTimersByTimeAsync(16_000);
      fixture.runtime.writeToSession("backend:shell", "fix bug\r");

      // Claude finishes a response — emit some output bursts so the first
      // idle_prompt looks like a real turn completion.
      for (let i = 0; i < 5; i += 1) {
        fixture.sessionManager.emit("terminal:data", { sessionId: "backend:shell", data: `line ${i}\n` });
      }

      // First idle_prompt → alert fires.
      fixture.runtime.notifyAgentHook("backend:shell", "idle_prompt");
      expect(fixture.runtime.getPayload().attention.byProject.backend).toMatchObject({ count: 1 });

      // User views the session (Jump equivalent): clearAlertForSession with
      // dismissed=false. This resets signal.waitingRaised/busy/outputBursts.
      fixture.runtime.clearAlertForSession("backend:shell", { dismissed: false });
      expect(fixture.runtime.getPayload().attention.byProject.backend).toBeUndefined();

      // User navigates away (backend panel no longer visible).
      await fixture.runtime.syncAttentionContext({ visibleSessionIds: ["frontend:claude"] });
      await vi.advanceTimersByTimeAsync(20_000); // past cooldown

      // Claude fires idle_prompt AGAIN for the same waiting state — no new
      // output bursts happened since reset.
      fixture.runtime.notifyAgentHook("backend:shell", "idle_prompt");

      // No re-alert: the repeat idle_prompt is suppressed.
      expect(fixture.runtime.getPayload().attention.byProject.backend).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  test("idle_prompt AFTER UserPromptSubmit DOES re-alert (legit turn)", async () => {
    vi.useFakeTimers();
    try {
      // Counter-test to the repeat-idle suppression: if the user sent a new
      // prompt (UserPromptSubmit hook) after the previous alert, the next
      // idle_prompt is a legit "Claude finished the new turn" and must fire.
      const fixture = await createTwoWorkspaceFixture();
      fixtures.push(fixture);

      await fixture.runtime.syncAttentionContext({ visibleSessionIds: ["frontend:claude"] });
      fixture.sessionManager.emit("terminal:data", { sessionId: "backend:shell", data: "claude code v1.0\n" });
      await vi.advanceTimersByTimeAsync(16_000);
      fixture.runtime.writeToSession("backend:shell", "fix bug\r");

      // Claude emits enough output to look like a real turn, then alerts.
      for (let i = 0; i < 12; i += 1) {
        fixture.sessionManager.emit("terminal:data", { sessionId: "backend:shell", data: `first ${i}\n` });
      }
      fixture.runtime.notifyAgentHook("backend:shell", "idle_prompt");
      expect(fixture.runtime.getPayload().attention.byProject.backend).toMatchObject({ count: 1 });

      // User views and acks — signal reset zeros outputBursts.
      fixture.runtime.clearAlertForSession("backend:shell", { dismissed: false });
      await fixture.runtime.syncAttentionContext({ visibleSessionIds: ["frontend:claude"] });
      await vi.advanceTimersByTimeAsync(20_000);

      // User types a new message — UserPromptSubmit hook fires. This is the
      // authoritative "user gave Claude new work" signal.
      fixture.runtime.notifyAgentHook("backend:shell", "", "UserPromptSubmit");

      // Claude works, then idle again.
      for (let i = 0; i < 12; i += 1) {
        fixture.sessionManager.emit("terminal:data", { sessionId: "backend:shell", data: `second ${i}\n` });
      }
      fixture.runtime.notifyAgentHook("backend:shell", "idle_prompt");
      expect(fixture.runtime.getPayload().attention.byProject.backend).toMatchObject({ count: 1 });
    } finally {
      vi.useRealTimers();
    }
  });

  test("idle_prompt AFTER substantial output (fallback without UserPromptSubmit) DOES re-alert", async () => {
    vi.useFakeTimers();
    try {
      // Defense for stale config: if UserPromptSubmit hook isn't registered
      // (old ~/.claude/settings.json without Phase 0 upgrade), we fall back
      // to output-burst threshold. 10+ bursts after reset = real turn.
      const fixture = await createTwoWorkspaceFixture();
      fixtures.push(fixture);

      await fixture.runtime.syncAttentionContext({ visibleSessionIds: ["frontend:claude"] });
      fixture.sessionManager.emit("terminal:data", { sessionId: "backend:shell", data: "claude code v1.0\n" });
      await vi.advanceTimersByTimeAsync(16_000);
      fixture.runtime.writeToSession("backend:shell", "fix bug\r");

      for (let i = 0; i < 12; i += 1) {
        fixture.sessionManager.emit("terminal:data", { sessionId: "backend:shell", data: `first ${i}\n` });
      }
      fixture.runtime.notifyAgentHook("backend:shell", "idle_prompt");
      expect(fixture.runtime.getPayload().attention.byProject.backend).toMatchObject({ count: 1 });

      fixture.runtime.clearAlertForSession("backend:shell", { dismissed: false });
      await fixture.runtime.syncAttentionContext({ visibleSessionIds: ["frontend:claude"] });
      await vi.advanceTimersByTimeAsync(20_000);

      // No UserPromptSubmit (stale config), but Claude produces 12+ bursts.
      for (let i = 0; i < 12; i += 1) {
        fixture.sessionManager.emit("terminal:data", { sessionId: "backend:shell", data: `second ${i}\n` });
      }

      fixture.runtime.notifyAgentHook("backend:shell", "idle_prompt");
      expect(fixture.runtime.getPayload().attention.byProject.backend).toMatchObject({ count: 1 });
    } finally {
      vi.useRealTimers();
    }
  });

  test("small heartbeat bursts (< threshold) without UserPromptSubmit DO suppress", async () => {
    vi.useFakeTimers();
    try {
      // Statusline redraws / cursor positioning might emit 1-3 output chunks
      // without representing real new work. Those must NOT defeat the repeat
      // idle_prompt suppression.
      const fixture = await createTwoWorkspaceFixture();
      fixtures.push(fixture);

      await fixture.runtime.syncAttentionContext({ visibleSessionIds: ["frontend:claude"] });
      fixture.sessionManager.emit("terminal:data", { sessionId: "backend:shell", data: "claude code v1.0\n" });
      await vi.advanceTimersByTimeAsync(16_000);
      fixture.runtime.writeToSession("backend:shell", "fix bug\r");

      for (let i = 0; i < 12; i += 1) {
        fixture.sessionManager.emit("terminal:data", { sessionId: "backend:shell", data: `first ${i}\n` });
      }
      fixture.runtime.notifyAgentHook("backend:shell", "idle_prompt");
      expect(fixture.runtime.getPayload().attention.byProject.backend).toMatchObject({ count: 1 });

      fixture.runtime.clearAlertForSession("backend:shell", { dismissed: false });
      await fixture.runtime.syncAttentionContext({ visibleSessionIds: ["frontend:claude"] });
      await vi.advanceTimersByTimeAsync(20_000);

      // A few heartbeat bursts — well under the 10-burst threshold.
      for (let i = 0; i < 3; i += 1) {
        fixture.sessionManager.emit("terminal:data", { sessionId: "backend:shell", data: `tick ${i}\n` });
      }

      // Repeat idle_prompt, no user prompt, only 3 bursts → suppress.
      fixture.runtime.notifyAgentHook("backend:shell", "idle_prompt");
      expect(fixture.runtime.getPayload().attention.byProject.backend).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  test("permission_prompt is NEVER suppressed by repeat-idle guard (urgent bypass)", async () => {
    vi.useFakeTimers();
    try {
      // Regression guard: urgent permission_prompt must reach the user even
      // when the session's lastAlertAt is set and outputBursts is 0 — the
      // suppression rule is idle_prompt only.
      const fixture = await createTwoWorkspaceFixture();
      fixtures.push(fixture);

      await fixture.runtime.syncAttentionContext({ visibleSessionIds: ["frontend:claude"] });
      fixture.sessionManager.emit("terminal:data", { sessionId: "backend:shell", data: "$ " });
      await vi.advanceTimersByTimeAsync(16_000);
      fixture.runtime.writeToSession("backend:shell", "claude\r");

      fixture.runtime.notifyAgentHook("backend:shell", "idle_prompt");
      fixture.runtime.clearAlertForSession("backend:shell", { dismissed: false });
      await fixture.runtime.syncAttentionContext({ visibleSessionIds: ["frontend:claude"] });
      await vi.advanceTimersByTimeAsync(20_000);

      // Permission prompt with zero intervening output — urgent, must alert.
      fixture.runtime.notifyAgentHook("backend:shell", "permission_prompt");

      expect(fixture.runtime.getPayload().attention.byProject.backend.alerts[0]).toMatchObject({
        urgency: "urgent",
        detail: "hook:Notification:permission_prompt",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  test("idle task workspace does NOT fire spurious user alerts from auto-spawned Claude", async () => {
    vi.useFakeTimers();
    try {
      // Real-world bug report: user created task workspace but never pressed
      // Start. Worker and Judge panels auto-spawn Claude (default startup).
      // Both Claudes sit idle and fire Notification:idle_prompt hooks. The
      // task runner must consume them — the user shouldn't see "Worker
      // waiting for input" notifications for a task they never initiated.
      const fixture = await createFixture({
        initialState: {
          activeProjectId: "frontend",
          projects: [
            {
              id: "frontend",
              name: "Frontend",
              kind: "terminal",
              cwd: "/tmp/frontend",
              activePanelId: "claude",
              panels: [{ id: "claude", title: "Claude Code", command: "claude", shell: true, startup: "default" }],
            },
          ],
          workspaces: [
            {
              id: "idletask",
              name: "Not started yet",
              kind: "task",
              cwd: "/tmp/idletask",
              activePanelId: "worker",
              panels: [
                { id: "worker", title: "Worker", command: "claude", shell: true, startup: "default" },
                { id: "judge", title: "Judge", command: "claude", shell: true, startup: "default" },
              ],
              task: {
                taskId: "t1",
                state: "idle",
                promptSent: false,
                currentRound: 0,
                workerPanelId: "worker",
                judgePanelId: "judge",
              },
            },
          ],
        },
      });
      fixtures.push(fixture);

      await fixture.runtime.syncAttentionContext({ visibleSessionIds: ["frontend:claude"] });
      // Both panels go through normal priming (input received, some output).
      fixture.sessionManager.emit("terminal:data", { sessionId: "idletask:worker", data: "$ " });
      fixture.sessionManager.emit("terminal:data", { sessionId: "idletask:judge", data: "$ " });
      await vi.advanceTimersByTimeAsync(16_000);
      fixture.runtime.writeToSession("idletask:worker", "claude\r");
      fixture.runtime.writeToSession("idletask:judge", "claude\r");

      // Auto-spawned Claude on both panels hits idle → fires Notification hook.
      fixture.runtime.notifyAgentHook("idletask:worker", "idle_prompt");
      fixture.runtime.notifyAgentHook("idletask:judge", "idle_prompt");

      // NEITHER should reach the user — task runner consumes both.
      expect(fixture.runtime.getPayload().attention.byProject.idletask).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  test("(Gap 1 regression) Stop hook in paused task falls through to user pipeline", async () => {
    vi.useFakeTimers();
    try {
      const fixture = await createFixture({
        initialState: {
          activeProjectId: "frontend",
          projects: [
            {
              id: "frontend",
              name: "Frontend",
              kind: "terminal",
              cwd: "/tmp/frontend",
              activePanelId: "claude",
              panels: [{ id: "claude", title: "Claude Code", command: "claude", shell: true, startup: "default" }],
            },
          ],
          workspaces: [
            {
              id: "mytask",
              name: "My task",
              kind: "task",
              cwd: "/tmp/mytask",
              activePanelId: "worker",
              panels: [
                { id: "worker", title: "Worker", command: "claude", shell: true, startup: "default" },
                { id: "judge", title: "Judge", command: "claude", shell: true, startup: "default" },
              ],
              task: {
                taskId: "t1",
                state: "paused",
                workerPanelId: "worker",
                judgePanelId: "judge",
                currentRound: 1,
              },
            },
          ],
        },
      });
      fixtures.push(fixture);

      await fixture.runtime.syncAttentionContext({ visibleSessionIds: ["frontend:claude"] });
      fixture.sessionManager.emit("terminal:data", { sessionId: "mytask:worker", data: "$ " });
      await vi.advanceTimersByTimeAsync(16_000);
      fixture.runtime.writeToSession("mytask:worker", "go\r");

      // Task paused → task runner returns false → user pipeline sees the event.
      fixture.runtime.notifyAgentHook("mytask:worker", "idle_prompt");

      const alerts = fixture.runtime.getPayload().attention.byProject.mytask?.alerts || [];
      expect(alerts[0]).toMatchObject({
        detail: "hook:Notification:idle_prompt",
        tier: 1,
        urgency: "normal",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  test("clearAlertForSession removes the attention entry and resets signal", async () => {
    vi.useFakeTimers();
    try {
      const fixture = await createTwoWorkspaceFixture();
      fixtures.push(fixture);

      await fixture.runtime.syncAttentionContext({ visibleSessionIds: ["frontend:claude"] });
      fixture.sessionManager.emit("terminal:data", { sessionId: "backend:shell", data: "$ " });
      await vi.advanceTimersByTimeAsync(16_000);
      fixture.runtime.writeToSession("backend:shell", "claude\r");
      fixture.runtime.notifyAgentHook("backend:shell", "idle_prompt");
      expect(fixture.runtime.getPayload().attention.byProject.backend).toMatchObject({ count: 1 });

      const payload = fixture.runtime.clearAlertForSession("backend:shell");
      expect(payload.attention.byProject.backend).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  test("clearAlertForSession({dismissed:true}) feeds adaptive suppression", async () => {
    vi.useFakeTimers();
    try {
      const fixture = await createTwoWorkspaceFixture();
      fixtures.push(fixture);
      const baseline = fixture.runtime.getNotificationMetrics().dismissedWithoutInteraction;

      await fixture.runtime.syncAttentionContext({ visibleSessionIds: ["frontend:claude"] });
      fixture.sessionManager.emit("terminal:data", { sessionId: "backend:shell", data: "$ " });
      await vi.advanceTimersByTimeAsync(16_000);
      fixture.runtime.writeToSession("backend:shell", "claude\r");

      // Dismiss 3 alerts in a row — adaptive multiplier should kick in (×2).
      for (let i = 0; i < 3; i += 1) {
        fixture.runtime.notifyAgentHook("backend:shell", "idle_prompt");
        fixture.runtime.clearAlertForSession("backend:shell", { dismissed: true });
        await vi.advanceTimersByTimeAsync(16_000);
      }

      expect(fixture.runtime.getNotificationMetrics().dismissedWithoutInteraction).toBe(baseline + 3);

      // One more dismissal should keep metrics incrementing.
      fixture.runtime.notifyAgentHook("backend:shell", "idle_prompt");
      fixture.runtime.clearAlertForSession("backend:shell", { dismissed: true });
      expect(fixture.runtime.getNotificationMetrics().dismissedWithoutInteraction).toBe(baseline + 4);
    } finally {
      vi.useRealTimers();
    }
  });

  test("clearAlertForSession without dismissed flag does NOT increment dismissal metric", async () => {
    vi.useFakeTimers();
    try {
      const fixture = await createTwoWorkspaceFixture();
      fixtures.push(fixture);
      const baseline = fixture.runtime.getNotificationMetrics().dismissedWithoutInteraction;

      await fixture.runtime.syncAttentionContext({ visibleSessionIds: ["frontend:claude"] });
      fixture.sessionManager.emit("terminal:data", { sessionId: "backend:shell", data: "$ " });
      await vi.advanceTimersByTimeAsync(16_000);
      fixture.runtime.writeToSession("backend:shell", "claude\r");

      fixture.runtime.notifyAgentHook("backend:shell", "idle_prompt");
      // Jump equivalent — clears without dismissed flag
      fixture.runtime.clearAlertForSession("backend:shell");

      expect(fixture.runtime.getNotificationMetrics().dismissedWithoutInteraction).toBe(baseline);
    } finally {
      vi.useRealTimers();
    }
  });

  test("notification metrics track hooks, alerts, tier and urgency", async () => {
    vi.useFakeTimers();
    try {
      const fixture = await createTwoWorkspaceFixture();
      fixtures.push(fixture);

      await fixture.runtime.syncAttentionContext({ visibleSessionIds: ["frontend:claude"] });
      fixture.sessionManager.emit("terminal:data", { sessionId: "backend:shell", data: "$ " });
      await vi.advanceTimersByTimeAsync(16_000);
      fixture.runtime.writeToSession("backend:shell", "claude\r");

      fixture.runtime.notifyAgentHook("backend:shell", "idle_prompt");
      await vi.advanceTimersByTimeAsync(20_000);
      fixture.runtime.notifyAgentHook("backend:shell", "permission_prompt");

      const m = fixture.runtime.getNotificationMetrics();
      expect(m.hooksReceived).toBeGreaterThanOrEqual(2);
      expect(m.alertsTotal).toBeGreaterThanOrEqual(2);
      expect(m.alertsByUrgency.urgent).toBeGreaterThanOrEqual(1);
      expect(m.alertsByTier[1]).toBeGreaterThanOrEqual(2);
    } finally {
      vi.useRealTimers();
    }
  });

  test("stale busy latch resets after 5× agentQuietMs silence", async () => {
    vi.useFakeTimers();
    try {
      const fixture = await createTwoWorkspaceFixture();
      fixtures.push(fixture);

      await fixture.runtime.syncAttentionContext({ visibleSessionIds: ["frontend:claude"] });
      fixture.sessionManager.emit("terminal:data", { sessionId: "backend:shell", data: "building...\n" });
      await vi.advanceTimersByTimeAsync(16_000);
      fixture.runtime.writeToSession("backend:shell", "npm run build\r");
      fixture.sessionManager.emit("terminal:data", { sessionId: "backend:shell", data: "compiling...\n" });

      // Wait 5× agentQuietMs (default 45s) + a buffer so the stale-busy reset
      // fires when the next chunk arrives. Using the shipped default directly
      // — if it changes, the assertion still holds because we overshoot.
      const staleMs = 45_000 * 5 + 5_000;
      await vi.advanceTimersByTimeAsync(staleMs);

      // Emit a fresh burst — the stale-busy guard should reset outputBursts
      // and busy before processing this chunk, so no alert piggy-backs on the
      // now-stale busy latch.
      fixture.sessionManager.emit("terminal:data", { sessionId: "backend:shell", data: "compiled.\n" });

      expect(fixture.runtime.getPayload().attention.byProject.backend).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("clearAllAttention — profile scoping", () => {
  test("with a windowId, only clears alerts whose workspace lives in that window's profile", async () => {
    vi.useFakeTimers();
    try {
      // Two profiles, each with a workspace owning a live attention alert.
      // A "Clear all" issued by profile-b's window must NOT wipe the
      // default-profile alert — without this scoping, the bell on the
      // default-profile window would silently fall to zero.
      const fixture = await createFixture({
        initialState: {
          activeProjectId: "ws-default",
          profiles: [
            { id: "default", name: "Default" },
            { id: "profile-b", name: "Profile B" },
          ],
          projects: [
            {
              id: "ws-default",
              name: "Default WS",
              kind: "terminal",
              profileId: "default",
              cwd: "/tmp/wsd",
              activePanelId: "shell",
              panels: [{ id: "shell", title: "Shell", command: "", shell: true, startup: "default" }],
            },
            {
              id: "ws-b",
              name: "Profile B WS",
              kind: "terminal",
              profileId: "profile-b",
              cwd: "/tmp/wsb",
              activePanelId: "shell",
              panels: [{ id: "shell", title: "Shell", command: "", shell: true, startup: "default" }],
            },
          ],
          windowSlots: [
            {
              id: "win-default",
              profileId: "default",
              activeWorkspaceId: "ws-default",
              activeSessionId: "",
              bounds: { x: 0, y: 0, width: 1280, height: 800 },
              lastFocusedAt: 1000,
            },
            {
              id: "win-b",
              profileId: "profile-b",
              activeWorkspaceId: "ws-b",
              activeSessionId: "",
              bounds: { x: 0, y: 0, width: 1280, height: 800 },
              lastFocusedAt: 2000,
            },
          ],
        },
      });
      fixtures.push(fixture);

      // Raise an alert on each workspace.
      await fixture.runtime.syncAttentionContext({ visibleSessionIds: [] });
      for (const sessionId of ["ws-default:shell", "ws-b:shell"]) {
        fixture.sessionManager.emit("terminal:data", { sessionId, data: "$ " });
      }
      await vi.advanceTimersByTimeAsync(16_000);
      fixture.runtime.writeToSession("ws-default:shell", "claude\r");
      fixture.runtime.writeToSession("ws-b:shell", "claude\r");
      fixture.runtime.notifyAgentHook("ws-default:shell", "idle_prompt");
      fixture.runtime.notifyAgentHook("ws-b:shell", "idle_prompt");
      expect(fixture.runtime.getPayload().attention.byWorkspace["ws-default"]).toBeDefined();
      expect(fixture.runtime.getPayload().attention.byWorkspace["ws-b"]).toBeDefined();

      // Profile-b's window clicks "Clear all".
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (fixture.runtime as any).clearAllAttention("win-b");
      const after = fixture.runtime.getPayload().attention.byWorkspace;
      // Default-profile alert survives.
      expect(after["ws-default"]).toBeDefined();
      // Profile-b alert is gone.
      expect(after["ws-b"]).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  test("without a windowId, falls back to the legacy global clear", async () => {
    vi.useFakeTimers();
    try {
      // Back-compat: callers that pre-date the windowId argument (and any
      // path the harness can't bind to a window) should still get the old
      // global wipe rather than a silent no-op.
      const fixture = await createFixture({
        initialState: {
          activeProjectId: "ws-default",
          projects: [
            {
              id: "ws-default",
              name: "Default WS",
              kind: "terminal",
              profileId: "default",
              cwd: "/tmp/wsd",
              activePanelId: "shell",
              panels: [{ id: "shell", title: "Shell", command: "", shell: true, startup: "default" }],
            },
          ],
        },
      });
      fixtures.push(fixture);

      await fixture.runtime.syncAttentionContext({ visibleSessionIds: [] });
      fixture.sessionManager.emit("terminal:data", { sessionId: "ws-default:shell", data: "$ " });
      await vi.advanceTimersByTimeAsync(16_000);
      fixture.runtime.writeToSession("ws-default:shell", "claude\r");
      fixture.runtime.notifyAgentHook("ws-default:shell", "idle_prompt");
      expect(fixture.runtime.getPayload().attention.byWorkspace["ws-default"]).toBeDefined();

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (fixture.runtime as any).clearAllAttention();
      expect(fixture.runtime.getPayload().attention.byWorkspace["ws-default"]).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("clearAlertForSession + syncAttentionContext — profile scoping", () => {
  // Same shape as clearAllAttention's tests: two profiles, two windows, two
  // workspaces with raised alerts. The bug we're regression-testing is a
  // remote/IPC caller on profile B passing any sessionId or visibleSessionIds
  // and silencing profile A's bells.
  async function createTwoProfileFixture() {
    return createFixture({
      initialState: {
        activeProjectId: "ws-default",
        profiles: [
          { id: "default", name: "Default" },
          { id: "profile-b", name: "Profile B" },
        ],
        projects: [
          {
            id: "ws-default",
            name: "Default WS",
            kind: "terminal",
            profileId: "default",
            cwd: "/tmp/wsd",
            activePanelId: "shell",
            panels: [{ id: "shell", title: "Shell", command: "", shell: true, startup: "default" }],
          },
          {
            id: "ws-b",
            name: "Profile B WS",
            kind: "terminal",
            profileId: "profile-b",
            cwd: "/tmp/wsb",
            activePanelId: "shell",
            panels: [{ id: "shell", title: "Shell", command: "", shell: true, startup: "default" }],
          },
        ],
        windowSlots: [
          {
            id: "win-default",
            profileId: "default",
            activeWorkspaceId: "ws-default",
            activeSessionId: "",
            bounds: { x: 0, y: 0, width: 1280, height: 800 },
            lastFocusedAt: 1000,
          },
          {
            id: "win-b",
            profileId: "profile-b",
            activeWorkspaceId: "ws-b",
            activeSessionId: "",
            bounds: { x: 0, y: 0, width: 1280, height: 800 },
            lastFocusedAt: 2000,
          },
        ],
      },
    });
  }

  // Raise an attention alert on each of the two workspaces.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async function raiseAlertsOnBoth(fixture: any): Promise<void> {
    await fixture.runtime.syncAttentionContext({ visibleSessionIds: [] });
    for (const sessionId of ["ws-default:shell", "ws-b:shell"]) {
      fixture.sessionManager.emit("terminal:data", { sessionId, data: "$ " });
    }
    await vi.advanceTimersByTimeAsync(16_000);
    fixture.runtime.writeToSession("ws-default:shell", "claude\r");
    fixture.runtime.writeToSession("ws-b:shell", "claude\r");
    fixture.runtime.notifyAgentHook("ws-default:shell", "idle_prompt");
    fixture.runtime.notifyAgentHook("ws-b:shell", "idle_prompt");
  }

  test("clearAlertForSession refuses a cross-profile sessionId", async () => {
    vi.useFakeTimers();
    try {
      const fixture = await createTwoProfileFixture();
      fixtures.push(fixture);
      await raiseAlertsOnBoth(fixture);

      // Profile-b's window asks to clear profile-default's session — must
      // refuse rather than wipe the default-profile alert.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (fixture.runtime as any).clearAlertForSession("ws-default:shell", { windowId: "win-b" });
      const after = fixture.runtime.getPayload().attention.byWorkspace;
      expect(after["ws-default"]).toBeDefined();
      expect(after["ws-b"]).toBeDefined();
    } finally {
      vi.useRealTimers();
    }
  });

  test("clearAlertForSession allows same-profile sessionIds", async () => {
    vi.useFakeTimers();
    try {
      const fixture = await createTwoProfileFixture();
      fixtures.push(fixture);
      await raiseAlertsOnBoth(fixture);

      // Profile-b's window clears its own session — must work normally.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (fixture.runtime as any).clearAlertForSession("ws-b:shell", { windowId: "win-b" });
      const after = fixture.runtime.getPayload().attention.byWorkspace;
      expect(after["ws-default"]).toBeDefined();
      expect(after["ws-b"]).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  test("clearAlertForSession without windowId preserves legacy unscoped behavior", async () => {
    vi.useFakeTimers();
    try {
      const fixture = await createTwoProfileFixture();
      fixtures.push(fixture);
      await raiseAlertsOnBoth(fixture);

      // No windowId → in-process / legacy caller, no scope check.
      fixture.runtime.clearAlertForSession("ws-default:shell");
      expect(fixture.runtime.getPayload().attention.byWorkspace["ws-default"]).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  test("syncAttentionContext ignores visibleSessionIds outside the caller's profile", async () => {
    vi.useFakeTimers();
    try {
      const fixture = await createTwoProfileFixture();
      fixtures.push(fixture);
      await raiseAlertsOnBoth(fixture);

      // Profile-b's window claims profile-default's session is visible.
      // After ATTENTION_MIN_DISPLAY_MS (~6s) the unscoped code path would
      // clear the default alert — the scoped path must not.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (fixture.runtime as any).syncAttentionContext({
        visibleSessionIds: ["ws-default:shell"],
        windowId: "win-b",
      });
      await vi.advanceTimersByTimeAsync(10_000);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (fixture.runtime as any).syncAttentionContext({
        visibleSessionIds: ["ws-default:shell"],
        windowId: "win-b",
      });
      expect(fixture.runtime.getPayload().attention.byWorkspace["ws-default"]).toBeDefined();
    } finally {
      vi.useRealTimers();
    }
  });

  test("syncAttentionContext clears alerts for same-profile visible sessions", async () => {
    vi.useFakeTimers();
    try {
      const fixture = await createTwoProfileFixture();
      fixtures.push(fixture);
      await raiseAlertsOnBoth(fixture);

      // Profile-b's window correctly reports its own session visible.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (fixture.runtime as any).syncAttentionContext({
        visibleSessionIds: ["ws-b:shell"],
        windowId: "win-b",
      });
      await vi.advanceTimersByTimeAsync(10_000);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (fixture.runtime as any).syncAttentionContext({
        visibleSessionIds: ["ws-b:shell"],
        windowId: "win-b",
      });
      const after = fixture.runtime.getPayload().attention.byWorkspace;
      expect(after["ws-default"]).toBeDefined();
      expect(after["ws-b"]).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// Task-agent crash recovery (see docs/task-recovery.md)
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeTaskWorkspace(overrides: Partial<any> = {}): any {
  const id = overrides.id || `ws-${Math.random().toString(36).slice(2, 8)}`;
  const workerPanelId = "panel-worker";
  const judgePanelId = "panel-judge";
  return {
    id,
    name: overrides.name || "Recovery test task",
    kind: "task",
    cwd: overrides.cwd || "/tmp/test-task",
    profileId: overrides.profileId || "default",
    activePanelId: "panel-dashboard",
    panels: [
      { id: "panel-dashboard", title: "Dashboard", command: "__task-dashboard__", startup: "none" },
      { id: workerPanelId, title: "Worker", command: "echo worker", startup: "default" },
      { id: judgePanelId, title: "Judge", command: "echo judge", startup: "default" },
    ],
    task: {
      taskId: overrides.taskId || `task-${id}`,
      description: "test task",
      parentWorkspaceId: "",
      worktreeBase: "",
      worktreeBranch: "",
      workerPanelId,
      judgePanelId,
      maxRounds: overrides.maxRounds ?? 5,
      showerInterval: 5,
      state: overrides.state ?? "running",
      currentRound: overrides.currentRound ?? 2,
      rounds: [],
      lastShowerRound: 0,
      lastJudgeInstructions: "",
      promptSent: true,
      pausedFromState: "",
      showerResumePrompt: "",
      ...overrides.task,
    },
  };
}

describe("task recovery: resolveTaskRecovery", () => {
  test("'continue' decision sets a recovery prompt and re-spawns PTY sessions", async () => {
    const ws = makeTaskWorkspace({ id: "ws-cont", state: "running", currentRound: 3 });
    const fixture = await createFixture({
      initialState: {
        workspaces: [ws],
        activeWorkspaceId: "",
      },
    });
    fixtures.push(fixture);

    // After init, the task should already be paused with a candidate ready
    const meta = fixture.runtime.getPayload().meta;
    expect(meta.recoveryCandidates).toHaveLength(1);
    expect(meta.recoveryCandidates[0].workspaceId).toBe("ws-cont");
    expect(meta.recoveryCandidates[0].previousState).toBe("running");

    const result = await fixture.runtime.resolveTaskRecovery({ "ws-cont": "continue" });
    expect(result.ok).toBe(true);

    // showerResumePrompt now carries the orientation prompt for the worker
    const wsAfter = fixture.runtime.getPayload().appState.workspaces.find((w: { id: string }) => w.id === "ws-cont");
    expect(wsAfter?.task?.showerResumePrompt).toBeTruthy();
    expect(wsAfter?.task?.showerResumePrompt).toContain("WORKER");
    expect(wsAfter?.task?.showerResumePrompt).toContain("round 3");
    expect(wsAfter?.task?.promptSent).toBe(false);

    // Both worker and judge PTYs were spawned (we don't know which idle's
    // first, so resolveTaskRecovery prepares both)
    expect(fixture.sessionManager.sessions.has("ws-cont:panel-worker")).toBe(true);
    expect(fixture.sessionManager.sessions.has("ws-cont:panel-judge")).toBe(true);

    // Candidate list cleared — a redrive can't double-spawn
    expect(fixture.runtime.getPayload().meta.recoveryCandidates).toHaveLength(0);
  });

  test("'continue' with previousState=judge-evaluating builds a JUDGE recovery prompt", async () => {
    const ws = makeTaskWorkspace({ id: "ws-judge", state: "judge-evaluating", currentRound: 4 });
    const fixture = await createFixture({ initialState: { workspaces: [ws] } });
    fixtures.push(fixture);

    await fixture.runtime.resolveTaskRecovery({ "ws-judge": "continue" });

    const wsAfter = fixture.runtime.getPayload().appState.workspaces.find((w: { id: string }) => w.id === "ws-judge");
    expect(wsAfter?.task?.showerResumePrompt).toContain("JUDGE");
    // resumeTask should have flipped state back to judge-evaluating
    expect(wsAfter?.task?.state).toBe("judge-evaluating");
  });

  test("'skip' leaves task paused without spawning sessions", async () => {
    const ws = makeTaskWorkspace({ id: "ws-skip", state: "running" });
    const fixture = await createFixture({ initialState: { workspaces: [ws] } });
    fixtures.push(fixture);

    await fixture.runtime.resolveTaskRecovery({ "ws-skip": "skip" });

    const wsAfter = fixture.runtime.getPayload().appState.workspaces.find((w: { id: string }) => w.id === "ws-skip");
    // Task remains paused (the reconcile sweep already paused it)
    expect(wsAfter?.task?.state).toBe("paused");
    // No recovery prompt
    expect(wsAfter?.task?.showerResumePrompt).toBe("");
    // No PTY spawned
    expect(fixture.sessionManager.sessions.has("ws-skip:panel-worker")).toBe(false);
  });

  test("'fresh' decision resets the round counter", async () => {
    const ws = makeTaskWorkspace({ id: "ws-fresh", state: "running", currentRound: 7 });
    const fixture = await createFixture({ initialState: { workspaces: [ws] } });
    fixtures.push(fixture);

    await fixture.runtime.resolveTaskRecovery({ "ws-fresh": "fresh" });

    const wsAfter = fixture.runtime.getPayload().appState.workspaces.find((w: { id: string }) => w.id === "ws-fresh");
    expect(wsAfter?.task?.currentRound).toBe(0);
    expect(wsAfter?.task?.rounds).toHaveLength(0);
    expect(wsAfter?.task?.state).toBe("idle");
  });

  test("ignores decisions for workspaces that aren't recovery candidates", async () => {
    // This task is "completed" — not a recovery candidate. A stray decision
    // for it must not crash and must not flip its state.
    const completed = makeTaskWorkspace({ id: "ws-done", state: "completed", currentRound: 5 });
    const fixture = await createFixture({ initialState: { workspaces: [completed] } });
    fixtures.push(fixture);

    expect(fixture.runtime.getPayload().meta.recoveryCandidates).toHaveLength(0);

    const result = await fixture.runtime.resolveTaskRecovery({ "ws-done": "continue" });
    expect(result.ok).toBe(true);

    const wsAfter = fixture.runtime.getPayload().appState.workspaces.find((w: { id: string }) => w.id === "ws-done");
    expect(wsAfter?.task?.state).toBe("completed");
    expect(wsAfter?.task?.showerResumePrompt).toBe("");
  });
});

describe("task recovery: resumeTask delegates candidates (Krok 6 / Test 10)", () => {
  test("resumeTask on a startup recovery candidate runs the full recovery path", async () => {
    // Incident B: a plain Dashboard/Sidebar "Continue" goes through resumeTask,
    // which alone only flips state and can't respawn the dead PTYs. It must
    // delegate to resolveTaskRecovery for a startup recovery candidate.
    const ws = makeTaskWorkspace({ id: "ws-redrive", state: "running", currentRound: 2 });
    const fixture = await createFixture({ initialState: { workspaces: [ws] } });
    fixtures.push(fixture);

    // Startup reconcile paused it and registered a recovery candidate.
    expect(fixture.runtime.getPayload().meta.recoveryCandidates).toHaveLength(1);

    const result = await fixture.runtime.resumeTask("ws-redrive");
    expect(result.ok).toBe(true);

    const wsAfter = fixture.runtime.getPayload().appState.workspaces.find((w: { id: string }) => w.id === "ws-redrive");
    // Recovery prompt staged + promptSent reset (the resolveTaskRecovery path),
    // and BOTH PTYs respawned — proof the delegation ran, not bare resumeTask.
    expect(wsAfter?.task?.showerResumePrompt).toBeTruthy();
    expect(wsAfter?.task?.promptSent).toBe(false);
    expect(fixture.sessionManager.sessions.has("ws-redrive:panel-worker")).toBe(true);
    expect(fixture.sessionManager.sessions.has("ws-redrive:panel-judge")).toBe(true);
    // Candidate consumed so a second Continue can't double-spawn.
    expect(fixture.runtime.getPayload().meta.recoveryCandidates).toHaveLength(0);
  });
});

describe("task recovery: dialog is the only resume path", () => {
  test("startup leaves candidates pending — no silent auto-resume", async () => {
    const ws = makeTaskWorkspace({ id: "ws-default", state: "running" });
    const fixture = await createFixture({
      initialState: {
        workspaces: [ws],
      },
    });
    fixtures.push(fixture);

    await new Promise((r) => setImmediate(r));

    const meta = fixture.runtime.getPayload().meta;
    expect(meta.recoveryCandidates).toHaveLength(1);
    expect(meta.recoveryCandidates[0].workspaceId).toBe("ws-default");
    // Worker session NOT spawned — that happens when the user picks "continue"
    expect(fixture.sessionManager.sessions.has("ws-default:panel-worker")).toBe(false);
  });
});

describe("task recovery: sequential resolve", () => {
  test("processing decisions one at a time leaves remaining candidates available", async () => {
    const wsA = makeTaskWorkspace({ id: "ws-a", state: "running" });
    const wsB = makeTaskWorkspace({ id: "ws-b", state: "running" });
    const fixture = await createFixture({
      initialState: {
        workspaces: [wsA, wsB],
      },
    });
    fixtures.push(fixture);

    // Both candidates present after startup
    expect(fixture.runtime.getPayload().meta.recoveryCandidates).toHaveLength(2);

    // Resolve only ws-a — ws-b must still be a candidate so the dialog can
    // advance to it. Previously this branch wiped the whole list.
    await fixture.runtime.resolveTaskRecovery({ "ws-a": "skip" });

    const meta = fixture.runtime.getPayload().meta;
    expect(meta.recoveryCandidates).toHaveLength(1);
    expect(meta.recoveryCandidates[0].workspaceId).toBe("ws-b");

    // Then resolve the second one — list drains
    await fixture.runtime.resolveTaskRecovery({ "ws-b": "skip" });
    expect(fixture.runtime.getPayload().meta.recoveryCandidates).toHaveLength(0);
  });
});

// Drain queueMicrotask + setImmediate yields enough times to let the startup
// background refresh loop walk every queued workspace.
async function drainBackgroundLoop(iterations = 30): Promise<void> {
  for (let i = 0; i < iterations; i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

describe("startup git refresh — scoping + cache reuse", () => {
  test("background warmup only refreshes workspaces in the active profile", async () => {
    // Active workspace lives in profile-a. The other workspace in profile-a
    // should get a background refresh. The two workspaces under profile-b
    // belong to a profile the user can't see right now — refreshing them at
    // startup would burn ~14 git spawns per workspace for no observable
    // benefit. The scope guard in runInitialRefresh keeps this off.
    const fixture = await createFixture({
      initialState: {
        activeWorkspaceId: "ws-a-1",
        profiles: [
          { id: "profile-a", name: "Profile A" },
          { id: "profile-b", name: "Profile B" },
        ],
        workspaces: [
          {
            id: "ws-a-1",
            name: "A1",
            kind: "terminal",
            profileId: "profile-a",
            cwd: "/tmp/a1",
            activePanelId: "shell",
            panels: [{ id: "shell", title: "Shell", command: "", shell: true, startup: "default" }],
          },
          {
            id: "ws-a-2",
            name: "A2",
            kind: "terminal",
            profileId: "profile-a",
            cwd: "/tmp/a2",
            activePanelId: "shell",
            panels: [{ id: "shell", title: "Shell", command: "", shell: true, startup: "default" }],
          },
          {
            id: "ws-b-1",
            name: "B1",
            kind: "terminal",
            profileId: "profile-b",
            cwd: "/tmp/b1",
            activePanelId: "shell",
            panels: [{ id: "shell", title: "Shell", command: "", shell: true, startup: "default" }],
          },
          {
            id: "ws-b-2",
            name: "B2",
            kind: "terminal",
            profileId: "profile-b",
            cwd: "/tmp/b2",
            activePanelId: "shell",
            panels: [{ id: "shell", title: "Shell", command: "", shell: true, startup: "default" }],
          },
        ],
      },
    });
    fixtures.push(fixture);
    await drainBackgroundLoop();

    const refreshedIds = fixture.git.refreshArgs.flat();
    expect(refreshedIds).toContain("ws-a-1"); // foreground refresh for active
    expect(refreshedIds).toContain("ws-a-2"); // background warmup, same profile
    expect(refreshedIds).not.toContain("ws-b-1"); // different profile — skipped
    expect(refreshedIds).not.toContain("ws-b-2");
  });

  test("background warmup skips invalidateSnapshotCache so the snapshot TTL still applies", async () => {
    // refreshGit invalidates the snapshot cache by default — without the
    // useCache opt-out the background loop would wipe and re-fetch every
    // workspace even when GitManager's own 8s TTL already had fresh data
    // from the foreground refresh.
    const fixture = await createFixture({
      initialState: {
        activeWorkspaceId: "ws-a-1",
        profiles: [{ id: "profile-a", name: "Profile A" }],
        workspaces: [
          {
            id: "ws-a-1",
            name: "A1",
            kind: "terminal",
            profileId: "profile-a",
            cwd: "/tmp/a1",
            activePanelId: "shell",
            panels: [{ id: "shell", title: "Shell", command: "", shell: true, startup: "default" }],
          },
          {
            id: "ws-a-2",
            name: "A2",
            kind: "terminal",
            profileId: "profile-a",
            cwd: "/tmp/a2",
            activePanelId: "shell",
            panels: [{ id: "shell", title: "Shell", command: "", shell: true, startup: "default" }],
          },
        ],
      },
    });
    fixtures.push(fixture);
    await drainBackgroundLoop();

    const invalidatedIds = fixture.git.invalidateCalls.map((call: { workspaceId: string | null }) => call.workspaceId);
    // Foreground refresh of the active workspace went through the normal
    // (invalidating) path.
    expect(invalidatedIds).toContain("ws-a-1");
    // Background warmup ran refreshGit("ws-a-2", { useCache: true }) — that
    // workspace's cache slot must never have been invalidated.
    expect(invalidatedIds).not.toContain("ws-a-2");
  });
});

// -----------------------------------------------------------------------
// Per-profile view state — visual profile switching
// -----------------------------------------------------------------------

function makeProfileSwitchState() {
  return {
    activeProjectId: "ws-a1",
    profiles: [
      { id: "profile-a", name: "Profile A", color: "#aaa" },
      { id: "profile-b", name: "Profile B", color: "#bbb" },
    ],
    projects: [
      {
        id: "ws-a1",
        name: "A1",
        kind: "terminal",
        profileId: "profile-a",
        cwd: "/tmp/a1",
        activePanelId: "shell",
        panels: [{ id: "shell", title: "Shell", command: "", shell: true, startup: "default" }],
      },
      {
        id: "ws-b1",
        name: "B1",
        kind: "terminal",
        profileId: "profile-b",
        cwd: "/tmp/b1",
        activePanelId: "shell",
        panels: [{ id: "shell", title: "Shell", command: "", shell: true, startup: "default" }],
      },
    ],
    windowSlots: [
      {
        id: "win-1",
        profileId: "profile-a",
        activeWorkspaceId: "ws-a1",
        activeSessionId: "ws-a1:shell",
        bounds: { x: 0, y: 0, width: 1280, height: 800 },
        lastFocusedAt: 1000,
      },
    ],
  };
}

describe("profile view-state persistence — activateProfileInWindow", () => {
  test("saves previous profile selection before switching", async () => {
    const fixture = await createFixture({ initialState: makeProfileSwitchState() });
    fixtures.push(fixture);

    await fixture.runtime.activateProfileInWindow("profile-b", "win-1");

    const state = fixture.store.getState();
    const profileA = state.profiles.find((p) => p.id === "profile-a");
    expect(profileA?.lastActiveWorkspaceId).toBe("ws-a1");
    expect(profileA?.lastActiveSessionId).toBe("ws-a1:shell");
  });

  test("restores target profile selection on switch", async () => {
    const initialState = {
      ...makeProfileSwitchState(),
      profiles: [
        {
          id: "profile-a",
          name: "Profile A",
          color: "#aaa",
          lastActiveWorkspaceId: "ws-a1",
          lastActiveSessionId: "ws-a1:shell",
        },
        {
          id: "profile-b",
          name: "Profile B",
          color: "#bbb",
          lastActiveWorkspaceId: "ws-b1",
          lastActiveSessionId: "ws-b1:shell",
        },
      ],
      windowSlots: [
        {
          id: "win-1",
          profileId: "profile-a",
          activeWorkspaceId: "ws-a1",
          activeSessionId: "ws-a1:shell",
          bounds: { x: 0, y: 0, width: 1280, height: 800 },
          lastFocusedAt: 1000,
        },
      ],
    };
    const fixture = await createFixture({ initialState });
    fixtures.push(fixture);

    await fixture.runtime.activateProfileInWindow("profile-b", "win-1");

    const slot = fixture.runtime.getPayload().appState.windowSlots!.find((s) => s.id === "win-1")!;
    expect(slot.profileId).toBe("profile-b");
    expect(slot.activeWorkspaceId).toBe("ws-b1");
    expect(slot.activeSessionId).toBe("ws-b1:shell");
  });

  test("restored session wins over stale saved workspace so slot remains consistent", async () => {
    const initialState = {
      ...makeProfileSwitchState(),
      profiles: [
        { id: "profile-a", name: "Profile A", color: "#aaa" },
        {
          id: "profile-b",
          name: "Profile B",
          color: "#bbb",
          lastActiveWorkspaceId: "ws-b2",
          lastActiveSessionId: "ws-b1:shell",
        },
      ],
      projects: [
        ...makeProfileSwitchState().projects,
        {
          id: "ws-b2",
          name: "B2",
          kind: "terminal",
          profileId: "profile-b",
          cwd: "/tmp/b2",
          activePanelId: "shell",
          panels: [{ id: "shell", title: "Shell", command: "", shell: true, startup: "default" }],
        },
      ],
    };
    const fixture = await createFixture({ initialState });
    fixtures.push(fixture);

    await fixture.runtime.activateProfileInWindow("profile-b", "win-1");

    const slot = fixture.runtime.getPayload().appState.windowSlots!.find((s) => s.id === "win-1")!;
    expect(slot.activeWorkspaceId).toBe("ws-b1");
    expect(slot.activeSessionId).toBe("ws-b1:shell");
  });

  test("falls back to first workspace when saved ids are invalid", async () => {
    const initialState = {
      ...makeProfileSwitchState(),
      profiles: [
        { id: "profile-a", name: "Profile A", color: "#aaa" },
        {
          id: "profile-b",
          name: "Profile B",
          color: "#bbb",
          lastActiveWorkspaceId: "ws-gone",
          lastActiveSessionId: "ws-gone:shell",
        },
      ],
    };
    const fixture = await createFixture({ initialState });
    fixtures.push(fixture);

    await fixture.runtime.activateProfileInWindow("profile-b", "win-1");

    const slot = fixture.runtime.getPayload().appState.windowSlots!.find((s) => s.id === "win-1")!;
    expect(slot.profileId).toBe("profile-b");
    expect(slot.activeWorkspaceId).toBe("ws-b1");
    expect(slot.activeSessionId).toBe("");
  });
});

describe("multiple windows per profile — viewer model", () => {
  function makeTwoWindowState() {
    const base = makeProfileSwitchState();
    return {
      ...base,
      windowSlots: [
        {
          id: "win-1",
          profileId: "profile-a",
          activeWorkspaceId: "ws-a1",
          activeSessionId: "ws-a1:shell",
          bounds: { x: 0, y: 0, width: 1280, height: 800 },
          lastFocusedAt: 1000,
        },
        {
          id: "win-2",
          profileId: "profile-b",
          activeWorkspaceId: "ws-b1",
          activeSessionId: "",
          bounds: { x: 40, y: 40, width: 1280, height: 800 },
          lastFocusedAt: 2000,
        },
      ],
    };
  }

  test("activateProfileInWindow allows a profile already open in another window", async () => {
    // No exclusivity: switching win-2 to profile-a while win-1 already shows
    // profile-a must succeed and leave win-1 untouched.
    const fixture = await createFixture({ initialState: makeTwoWindowState() });
    fixtures.push(fixture);

    const payload = await fixture.runtime.activateProfileInWindow("profile-a", "win-2");

    const slots = payload.appState.windowSlots!;
    expect(slots.find((s) => s.id === "win-2")?.profileId).toBe("profile-a");
    // win-1 keeps its own view state — switching another window never touches it.
    expect(slots.find((s) => s.id === "win-1")?.profileId).toBe("profile-a");
    expect(slots.find((s) => s.id === "win-1")?.activeWorkspaceId).toBe("ws-a1");
    expect(slots.find((s) => s.id === "win-1")?.activeSessionId).toBe("ws-a1:shell");
  });

  test("two windows on the same profile keep independent active workspaces", async () => {
    const base = makeProfileSwitchState();
    const initialState = {
      ...base,
      projects: [
        ...base.projects,
        {
          id: "ws-a2",
          name: "A2",
          kind: "terminal",
          profileId: "profile-a",
          cwd: "/tmp/a2",
          activePanelId: "shell",
          panels: [{ id: "shell", title: "Shell", command: "", shell: true, startup: "default" }],
        },
      ],
      windowSlots: [
        {
          id: "win-1",
          profileId: "profile-a",
          activeWorkspaceId: "ws-a1",
          activeSessionId: "",
          bounds: { x: 0, y: 0, width: 1280, height: 800 },
          lastFocusedAt: 1000,
        },
        {
          id: "win-2",
          profileId: "profile-a",
          activeWorkspaceId: "ws-a1",
          activeSessionId: "",
          bounds: { x: 40, y: 40, width: 1280, height: 800 },
          lastFocusedAt: 2000,
        },
      ],
    };
    const fixture = await createFixture({ initialState });
    fixtures.push(fixture);

    await fixture.runtime.activateWorkspaceInWindow("ws-a2", "win-2");

    const slots = fixture.runtime.getPayload().appState.windowSlots!;
    expect(slots.find((s) => s.id === "win-2")?.activeWorkspaceId).toBe("ws-a2");
    expect(slots.find((s) => s.id === "win-1")?.activeWorkspaceId).toBe("ws-a1");
  });

  test("createWindowSlot allows a second slot for an already-open profile", async () => {
    const fixture = await createFixture({ initialState: makeProfileSwitchState() });
    fixtures.push(fixture);

    const created = await fixture.runtime.createWindowSlot("profile-a");

    const slots = fixture.runtime.getPayload().appState.windowSlots!;
    expect(slots.filter((s) => s.profileId === "profile-a")).toHaveLength(2);
    expect(slots.find((s) => s.id === created.id)?.profileId).toBe("profile-a");
  });

  test("createWindowSlot with cloneFromWindowId copies the source window's view", async () => {
    const base = makeProfileSwitchState();
    const initialState = {
      ...base,
      projects: [
        ...base.projects,
        {
          id: "ws-a2",
          name: "A2",
          kind: "terminal",
          profileId: "profile-a",
          cwd: "/tmp/a2",
          activePanelId: "shell",
          panels: [{ id: "shell", title: "Shell", command: "", shell: true, startup: "default" }],
        },
      ],
      windowSlots: [
        {
          id: "win-1",
          profileId: "profile-a",
          activeWorkspaceId: "ws-a2",
          activeSessionId: "ws-a2:shell",
          workspaceGrid: { layout: "cols", cellWorkspaceIds: ["ws-a1", "ws-a2"] },
          bounds: { x: 0, y: 0, width: 1280, height: 800 },
          lastFocusedAt: 1000,
        },
      ],
    };
    const fixture = await createFixture({ initialState });
    fixtures.push(fixture);

    const created = await fixture.runtime.createWindowSlot("profile-a", { cloneFromWindowId: "win-1" });

    const slots = fixture.runtime.getPayload().appState.windowSlots!;
    const clone = slots.find((s) => s.id === created.id)!;
    expect(clone.activeWorkspaceId).toBe("ws-a2");
    expect(clone.activeSessionId).toBe("ws-a2:shell");
    expect(clone.workspaceGrid).toEqual({ layout: "cols", cellWorkspaceIds: ["ws-a1", "ws-a2"] });
    // Independent objects — mutating the clone's grid must not touch the source.
    expect(clone.workspaceGrid).not.toBe(slots.find((s) => s.id === "win-1")!.workspaceGrid);
  });

  test("createWindowSlot ignores cloneFromWindowId from a different profile", async () => {
    const fixture = await createFixture({ initialState: makeProfileSwitchState() });
    fixtures.push(fixture);

    // win-1 shows profile-a; ask for a profile-b window cloned from it.
    const created = await fixture.runtime.createWindowSlot("profile-b", { cloneFromWindowId: "win-1" });

    const slots = fixture.runtime.getPayload().appState.windowSlots!;
    const slot = slots.find((s) => s.id === created.id)!;
    expect(slot.profileId).toBe("profile-b");
    // Falls back to the profile default, not the foreign window's view.
    expect(slot.activeWorkspaceId).toBe("ws-b1");
  });

  test("grid change in one window does not change the sibling window's grid (same profile)", async () => {
    const base = makeProfileSwitchState();
    const initialState = {
      ...base,
      projects: [
        ...base.projects,
        {
          id: "ws-a2",
          name: "A2",
          kind: "terminal",
          profileId: "profile-a",
          cwd: "/tmp/a2",
          activePanelId: "shell",
          panels: [{ id: "shell", title: "Shell", command: "", shell: true, startup: "default" }],
        },
      ],
      windowSlots: [
        {
          id: "win-1",
          profileId: "profile-a",
          activeWorkspaceId: "ws-a1",
          activeSessionId: "",
          workspaceGrid: null,
          bounds: { x: 0, y: 0, width: 1280, height: 800 },
          lastFocusedAt: 1000,
        },
        {
          id: "win-2",
          profileId: "profile-a",
          activeWorkspaceId: "ws-a2",
          activeSessionId: "",
          workspaceGrid: null,
          bounds: { x: 40, y: 40, width: 1280, height: 800 },
          lastFocusedAt: 2000,
        },
      ],
    };
    const fixture = await createFixture({ initialState });
    fixtures.push(fixture);

    await fixture.runtime.enableWorkspaceGrid("cols", ["ws-a1", "ws-a2"], "win-1");

    let slots = fixture.runtime.getPayload().appState.windowSlots!;
    expect(slots.find((s) => s.id === "win-1")?.workspaceGrid).toEqual({
      layout: "cols",
      cellWorkspaceIds: ["ws-a1", "ws-a2"],
    });
    expect(slots.find((s) => s.id === "win-2")?.workspaceGrid).toBeNull();

    // Mutating cells / layout in win-1 must also stay local to win-1.
    await fixture.runtime.setGridCell(1, null, "win-1");
    slots = fixture.runtime.getPayload().appState.windowSlots!;
    expect(slots.find((s) => s.id === "win-1")?.workspaceGrid).toEqual({
      layout: "cols",
      cellWorkspaceIds: ["ws-a1", null],
    });
    expect(slots.find((s) => s.id === "win-2")?.workspaceGrid).toBeNull();

    // Disabling the grid in win-1 leaves win-2 untouched as well.
    await fixture.runtime.enableWorkspaceGrid("cols", ["ws-a2", null], "win-2");
    await fixture.runtime.disableWorkspaceGrid("win-1");
    slots = fixture.runtime.getPayload().appState.windowSlots!;
    expect(slots.find((s) => s.id === "win-1")?.workspaceGrid).toBeNull();
    expect(slots.find((s) => s.id === "win-2")?.workspaceGrid).toEqual({
      layout: "cols",
      cellWorkspaceIds: ["ws-a2", null],
    });
  });

  test("remote viewer grid ops mutate the remote client's grid, never a desktop slot", async () => {
    const base = makeProfileSwitchState();
    const initialState = {
      ...base,
      projects: [
        ...base.projects,
        {
          id: "ws-a2",
          name: "A2",
          kind: "terminal",
          profileId: "profile-a",
          cwd: "/tmp/a2",
          activePanelId: "shell",
          panels: [{ id: "shell", title: "Shell", command: "", shell: true, startup: "default" }],
        },
      ],
    };
    const fixture = await createFixture({ initialState });
    fixtures.push(fixture);

    const registry = new RemoteClientRegistry();
    fixture.runtime.setRemoteClientRegistry(registry);
    registry.getOrCreate("mobile-1", fixture.store.getState(), "profile-a");

    await fixture.runtime.enableWorkspaceGrid("cols", ["ws-a1", "ws-a2"], "remote:mobile-1");

    // The remote client's own grid is set...
    expect(registry.get("mobile-1")!.workspaceGrid).toEqual({
      layout: "cols",
      cellWorkspaceIds: ["ws-a1", "ws-a2"],
    });
    // ...and no desktop slot picked it up.
    const slots = fixture.runtime.getPayload().appState.windowSlots!;
    for (const slot of slots) {
      expect(slot.workspaceGrid ?? null).toBeNull();
    }

    await fixture.runtime.setGridCell(1, null, "remote:mobile-1");
    expect(registry.get("mobile-1")!.workspaceGrid).toEqual({
      layout: "cols",
      cellWorkspaceIds: ["ws-a1", null],
    });

    await fixture.runtime.disableWorkspaceGrid("remote:mobile-1");
    expect(registry.get("mobile-1")!.workspaceGrid).toBeNull();
  });

  test("remote viewer grid ops refuse cross-profile workspaces", async () => {
    const fixture = await createFixture({ initialState: makeProfileSwitchState() });
    fixtures.push(fixture);

    const registry = new RemoteClientRegistry();
    fixture.runtime.setRemoteClientRegistry(registry);
    registry.getOrCreate("mobile-1", fixture.store.getState(), "profile-a");

    // ws-b1 lives in profile-b — the remote viewer on profile-a must be refused.
    await expect(fixture.runtime.enableWorkspaceGrid("cols", ["ws-b1", null], "remote:mobile-1")).rejects.toThrow(
      /Cross-profile refused/i,
    );
  });

  test("legacy activateWorkspace with a remote viewer id never flips a desktop slot", async () => {
    const base = makeProfileSwitchState();
    const initialState = {
      ...base,
      projects: [
        ...base.projects,
        {
          id: "ws-a2",
          name: "A2",
          kind: "terminal",
          profileId: "profile-a",
          cwd: "/tmp/a2",
          activePanelId: "shell",
          panels: [{ id: "shell", title: "Shell", command: "", shell: true, startup: "default" }],
        },
      ],
    };
    const fixture = await createFixture({ initialState });
    fixtures.push(fixture);

    const registry = new RemoteClientRegistry();
    fixture.runtime.setRemoteClientRegistry(registry);
    registry.getOrCreate("mobile-1", fixture.store.getState(), "profile-a");

    await fixture.runtime.activateWorkspace("ws-a2", "remote:mobile-1");

    // The remote client's own view moved...
    expect(registry.get("mobile-1")!.activeWorkspaceId).toBe("ws-a2");
    // ...the desktop slot did not.
    const slots = fixture.runtime.getPayload().appState.windowSlots!;
    expect(slots.find((s) => s.id === "win-1")?.activeWorkspaceId).toBe("ws-a1");
  });

  test("telegram screenshot-workspace prefers the window already showing the workspace", async () => {
    const base = makeProfileSwitchState();
    const initialState = {
      ...base,
      projects: [
        ...base.projects,
        {
          id: "ws-a2",
          name: "A2",
          kind: "terminal",
          profileId: "profile-a",
          cwd: "/tmp/a2",
          activePanelId: "shell",
          panels: [{ id: "shell", title: "Shell", command: "", shell: true, startup: "default" }],
        },
      ],
      windowSlots: [
        {
          id: "win-1",
          profileId: "profile-a",
          activeWorkspaceId: "ws-a1",
          activeSessionId: "",
          bounds: { x: 0, y: 0, width: 1280, height: 800 },
          // win-1 shows ws-a2? No — ws-a1. win-2 shows ws-a2 and is NOT last-focused.
          lastFocusedAt: 5000,
        },
        {
          id: "win-2",
          profileId: "profile-a",
          activeWorkspaceId: "ws-a2",
          activeSessionId: "",
          bounds: { x: 40, y: 40, width: 1280, height: 800 },
          lastFocusedAt: 1000,
        },
      ],
    };
    const captured: Array<string | undefined> = [];
    const fixture = await createFixture({
      initialState,
      dependencies: {
        captureMainWindowPng: vi.fn(async (windowId?: string) => {
          captured.push(windowId);
          return Buffer.from("png");
        }),
      },
    });
    fixtures.push(fixture);
    const manager = fixture.runtime._telegramManagerForTest();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (manager as any).sendScreenshotPng = vi.fn(async () => undefined);

    await fixture.runtime._dispatchTelegramCommandForTest({
      type: "screenshot-workspace",
      workspaceId: "ws-a2",
      panelId: "",
      chatId: "12345",
      profileId: "profile-a",
    });

    // The window already showing ws-a2 wins over the last-focused window.
    expect(captured).toEqual(["win-2"]);
  });

  test("telegram screenshot-current with several profile windows asks the user instead of guessing", async () => {
    const base = makeProfileSwitchState();
    const initialState = {
      ...base,
      windowSlots: [
        {
          id: "win-1",
          profileId: "profile-a",
          activeWorkspaceId: "ws-a1",
          activeSessionId: "",
          bounds: { x: 0, y: 0, width: 1280, height: 800 },
          lastFocusedAt: 1000,
        },
        {
          id: "win-2",
          profileId: "profile-a",
          activeWorkspaceId: "ws-a1",
          activeSessionId: "",
          bounds: { x: 40, y: 40, width: 1280, height: 800 },
          lastFocusedAt: 2000,
        },
      ],
    };
    const captureMainWindowPng = vi.fn(async () => Buffer.from("png"));
    const fixture = await createFixture({ initialState, dependencies: { captureMainWindowPng } });
    fixtures.push(fixture);
    const manager = fixture.runtime._telegramManagerForTest();
    const windowPick = vi.fn(async () => undefined);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (manager as any).promptScreenshotWindowPick = windowPick;

    await fixture.runtime._dispatchTelegramCommandForTest({
      type: "screenshot-current",
      workspaceId: "",
      panelId: "",
      chatId: "12345",
      profileId: "profile-a",
    });

    // No capture happened; the user got a window menu instead.
    expect(captureMainWindowPng).not.toHaveBeenCalled();
    expect(windowPick).toHaveBeenCalledTimes(1);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const [, profileId, candidates] = windowPick.mock.calls[0] as any[];
    expect(profileId).toBe("profile-a");
    expect(candidates.map((c: { windowId: string }) => c.windowId)).toEqual(["win-1", "win-2"]);
  });

  test("telegram screenshot-current with NO profile window sends the no-window prompt (never windowSlots[0])", async () => {
    const base = makeProfileSwitchState();
    const initialState = {
      ...base,
      // Only profile-b has a window; profile-a (the command target) has none.
      windowSlots: [
        {
          id: "win-b",
          profileId: "profile-b",
          activeWorkspaceId: "ws-b1",
          activeSessionId: "",
          bounds: { x: 0, y: 0, width: 1280, height: 800 },
          lastFocusedAt: 1000,
        },
      ],
    };
    const captureMainWindowPng = vi.fn(async () => Buffer.from("png"));
    const fixture = await createFixture({ initialState, dependencies: { captureMainWindowPng } });
    fixtures.push(fixture);
    const manager = fixture.runtime._telegramManagerForTest();
    const noWindowPrompt = vi.fn(async () => undefined);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (manager as any).promptNoWindowForScreenshot = noWindowPrompt;

    await fixture.runtime._dispatchTelegramCommandForTest({
      type: "screenshot-current",
      workspaceId: "",
      panelId: "",
      chatId: "12345",
      profileId: "profile-a",
    });

    expect(captureMainWindowPng).not.toHaveBeenCalled();
    expect(noWindowPrompt).toHaveBeenCalledWith("12345", "profile-a");
  });

  test("telegram screenshot-workspace with NO profile window creates one, captures, and keeps it open", async () => {
    const base = makeProfileSwitchState();
    const initialState = {
      ...base,
      windowSlots: [
        {
          id: "win-b",
          profileId: "profile-b",
          activeWorkspaceId: "ws-b1",
          activeSessionId: "",
          bounds: { x: 0, y: 0, width: 1280, height: 800 },
          lastFocusedAt: 1000,
        },
      ],
    };
    const captured: Array<string | undefined> = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let fixtureRef: any = null;
    const ensureWindowForProfile = vi.fn(async (profileId: string) => {
      // Simulate main.ts: create a slot + window for the profile.
      const created = await fixtureRef.runtime.createWindowSlot(profileId);
      return created.id as string;
    });
    const fixture = await createFixture({
      initialState,
      dependencies: {
        captureMainWindowPng: vi.fn(async (windowId?: string) => {
          captured.push(windowId);
          return Buffer.from("png");
        }),
        ensureWindowForProfile,
      },
    });
    fixtureRef = fixture;
    fixtures.push(fixture);
    const manager = fixture.runtime._telegramManagerForTest();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (manager as any).sendScreenshotPng = vi.fn(async () => undefined);

    await fixture.runtime._dispatchTelegramCommandForTest({
      type: "screenshot-workspace",
      workspaceId: "ws-a1",
      panelId: "",
      chatId: "12345",
      profileId: "profile-a",
    });

    expect(ensureWindowForProfile).toHaveBeenCalledWith("profile-a");
    expect(captured).toHaveLength(1);
    // The new window still exists and shows the captured workspace — it is
    // NOT closed or switched back after the capture.
    const slots = fixture.runtime.getPayload().appState.windowSlots!;
    const created = slots.find((s) => s.id === captured[0]);
    expect(created?.profileId).toBe("profile-a");
    expect(created?.activeWorkspaceId).toBe("ws-a1");
  });

  test("telegram start-task with useWorktree builds the promptStartAfterCreate cwd via path.join, not a hardcoded backslash string", async () => {
    // Regression for code-review finding 1.10: the Telegram start-task
    // dispatch used to build the new worktree's cwd with
    // `${cwd}\\.strideterm\\tree\\${branch}`, which is bogus on macOS/Linux.
    // It must use path.join like every other worktree-path call site.
    const parentRoot = await fs.mkdtemp(path.join(os.tmpdir(), "strideterm-telegram-wt-"));
    tempPaths.push(parentRoot);
    const branch = "feature/x";
    const dirName = branch.replace(/\//g, "-");

    const fixture = await createFixture({
      initialState: {
        activeProjectId: "parent",
        projects: [
          {
            id: "parent",
            name: "Parent",
            kind: "terminal",
            cwd: parentRoot,
            activePanelId: "shell",
            panels: [{ id: "shell", title: "Shell", command: "", shell: true, startup: "default" }],
          },
        ],
      },
    });
    fixtures.push(fixture);

    const manager = fixture.runtime._telegramManagerForTest();
    const promptStartAfterCreate = vi.fn(async () => undefined);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (manager as any).promptStartAfterCreate = promptStartAfterCreate;

    await fixture.runtime._dispatchTelegramCommandForTest({
      type: "start-task",
      workspaceId: "parent",
      taskDescription: "Do the thing",
      chatId: "12345",
      useWorktree: true,
      worktreeBranch: branch,
    });

    expect(promptStartAfterCreate).toHaveBeenCalledTimes(1);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const [opts] = promptStartAfterCreate.mock.calls[0] as any[];
    // Platform-agnostic assertion: path.join produces the native separator
    // (backslash on Windows, forward slash on POSIX) rather than a
    // hardcoded backslash regardless of platform.
    expect(opts.cwd).toBe(path.join(parentRoot, ".strideterm", "tree", dirName));
  });

  test("removeWindowSlot mirrors the closing window's view and grid into the profile legacy defaults", async () => {
    const base = makeProfileSwitchState();
    const initialState = {
      ...base,
      projects: [
        ...base.projects,
        {
          id: "ws-a2",
          name: "A2",
          kind: "terminal",
          profileId: "profile-a",
          cwd: "/tmp/a2",
          activePanelId: "shell",
          panels: [{ id: "shell", title: "Shell", command: "", shell: true, startup: "default" }],
        },
      ],
      windowSlots: [
        {
          id: "win-1",
          profileId: "profile-a",
          activeWorkspaceId: "ws-a2",
          activeSessionId: "ws-a2:shell",
          workspaceGrid: { layout: "cols", cellWorkspaceIds: ["ws-a1", "ws-a2"] },
          bounds: { x: 0, y: 0, width: 1280, height: 800 },
          lastFocusedAt: 1000,
        },
        {
          id: "win-2",
          profileId: "profile-b",
          activeWorkspaceId: "ws-b1",
          activeSessionId: "",
          workspaceGrid: null,
          bounds: { x: 40, y: 40, width: 1280, height: 800 },
          lastFocusedAt: 2000,
        },
      ],
    };
    const fixture = await createFixture({ initialState });
    fixtures.push(fixture);

    await fixture.runtime.removeWindowSlot("win-1");

    const state = fixture.store.getState();
    expect(state.windowSlots.find((s) => s.id === "win-1")).toBeUndefined();
    const profileA = state.profiles.find((p) => p.id === "profile-a");
    expect(profileA?.lastActiveWorkspaceId).toBe("ws-a2");
    expect(profileA?.lastActiveSessionId).toBe("ws-a2:shell");
    expect(profileA?.workspaceGrid).toEqual({ layout: "cols", cellWorkspaceIds: ["ws-a1", "ws-a2"] });
  });

  test("switching one of two same-profile windows away saves the legacy mirror without touching the sibling", async () => {
    const base = makeProfileSwitchState();
    const initialState = {
      ...base,
      windowSlots: [
        {
          id: "win-1",
          profileId: "profile-a",
          activeWorkspaceId: "ws-a1",
          activeSessionId: "ws-a1:shell",
          bounds: { x: 0, y: 0, width: 1280, height: 800 },
          lastFocusedAt: 1000,
        },
        {
          id: "win-2",
          profileId: "profile-a",
          activeWorkspaceId: "ws-a1",
          activeSessionId: "",
          bounds: { x: 40, y: 40, width: 1280, height: 800 },
          lastFocusedAt: 2000,
        },
      ],
    };
    const fixture = await createFixture({ initialState });
    fixtures.push(fixture);

    await fixture.runtime.activateProfileInWindow("profile-b", "win-2");

    const slots = fixture.runtime.getPayload().appState.windowSlots!;
    expect(slots.find((s) => s.id === "win-2")?.profileId).toBe("profile-b");
    // The sibling window stays on profile-a, fully untouched.
    expect(slots.find((s) => s.id === "win-1")?.profileId).toBe("profile-a");
    expect(slots.find((s) => s.id === "win-1")?.activeWorkspaceId).toBe("ws-a1");
    expect(slots.find((s) => s.id === "win-1")?.activeSessionId).toBe("ws-a1:shell");
  });
});

describe("profile view-state persistence — activateWorkspaceInWindow", () => {
  test("updates profile lastActiveWorkspaceId on workspace activation", async () => {
    const initialState = {
      activeProjectId: "ws-a1",
      profiles: [{ id: "profile-a", name: "Profile A", color: "#aaa" }],
      projects: [
        {
          id: "ws-a1",
          name: "A1",
          kind: "terminal",
          profileId: "profile-a",
          cwd: "/tmp/a1",
          activePanelId: "shell",
          panels: [{ id: "shell", title: "Shell", command: "" }],
        },
        {
          id: "ws-a2",
          name: "A2",
          kind: "terminal",
          profileId: "profile-a",
          cwd: "/tmp/a2",
          activePanelId: "shell",
          panels: [{ id: "shell", title: "Shell", command: "" }],
        },
      ],
      windowSlots: [
        {
          id: "win-1",
          profileId: "profile-a",
          activeWorkspaceId: "ws-a1",
          activeSessionId: "",
          bounds: { x: 0, y: 0, width: 1280, height: 800 },
          lastFocusedAt: 1000,
        },
      ],
    };
    const fixture = await createFixture({ initialState });
    fixtures.push(fixture);

    await fixture.runtime.activateWorkspaceInWindow("ws-a2", "win-1");

    const state = fixture.store.getState();
    const profileA = state.profiles.find((p) => p.id === "profile-a");
    expect(profileA?.lastActiveWorkspaceId).toBe("ws-a2");
  });

  test("clears stale profile and slot session when activating a different workspace", async () => {
    const initialState = {
      activeProjectId: "ws-a1",
      profiles: [{ id: "profile-a", name: "Profile A", color: "#aaa", lastActiveSessionId: "ws-a1:shell" }],
      projects: [
        {
          id: "ws-a1",
          name: "A1",
          kind: "terminal",
          profileId: "profile-a",
          cwd: "/tmp/a1",
          activePanelId: "shell",
          panels: [{ id: "shell", title: "Shell", command: "" }],
        },
        {
          id: "ws-a2",
          name: "A2",
          kind: "terminal",
          profileId: "profile-a",
          cwd: "/tmp/a2",
          activePanelId: "shell",
          panels: [{ id: "shell", title: "Shell", command: "" }],
        },
      ],
      windowSlots: [
        {
          id: "win-1",
          profileId: "profile-a",
          activeWorkspaceId: "ws-a1",
          activeSessionId: "ws-a1:shell",
          bounds: { x: 0, y: 0, width: 1280, height: 800 },
          lastFocusedAt: 1000,
        },
      ],
    };
    const fixture = await createFixture({ initialState });
    fixtures.push(fixture);

    await fixture.runtime.activateWorkspaceInWindow("ws-a2", "win-1");

    const state = fixture.store.getState();
    const profileA = state.profiles.find((p) => p.id === "profile-a");
    const slot = state.windowSlots?.find((s) => s.id === "win-1");
    expect(profileA?.lastActiveWorkspaceId).toBe("ws-a2");
    expect(profileA?.lastActiveSessionId).toBeUndefined();
    expect(slot?.activeSessionId).toBe("");
  });
});

describe("profile view-state persistence — activateSessionInWindow", () => {
  test("updates profile lastActiveWorkspaceId and lastActiveSessionId on session activation", async () => {
    const initialState = {
      activeProjectId: "ws-a1",
      profiles: [{ id: "profile-a", name: "Profile A", color: "#aaa" }],
      projects: [
        {
          id: "ws-a1",
          name: "A1",
          kind: "terminal",
          profileId: "profile-a",
          cwd: "/tmp/a1",
          activePanelId: "shell",
          panels: [{ id: "shell", title: "Shell", command: "" }],
        },
      ],
      windowSlots: [
        {
          id: "win-1",
          profileId: "profile-a",
          activeWorkspaceId: "ws-a1",
          activeSessionId: "",
          bounds: { x: 0, y: 0, width: 1280, height: 800 },
          lastFocusedAt: 1000,
        },
      ],
    };
    const fixture = await createFixture({ initialState });
    fixtures.push(fixture);

    await fixture.runtime.activateSessionInWindow("ws-a1:shell", "win-1");

    const state = fixture.store.getState();
    const profileA = state.profiles.find((p) => p.id === "profile-a");
    expect(profileA?.lastActiveWorkspaceId).toBe("ws-a1");
    expect(profileA?.lastActiveSessionId).toBe("ws-a1:shell");
  });
});

describe("profile view-state persistence — createWindowSlot", () => {
  test("restores profile last active workspace and session when creating a new slot", async () => {
    const initialState = {
      activeProjectId: "ws-a1",
      profiles: [
        { id: "profile-a", name: "Profile A", color: "#aaa" },
        {
          id: "profile-b",
          name: "Profile B",
          color: "#bbb",
          lastActiveWorkspaceId: "ws-b1",
          lastActiveSessionId: "ws-b1:shell",
        },
      ],
      projects: [
        {
          id: "ws-a1",
          name: "A1",
          kind: "terminal",
          profileId: "profile-a",
          cwd: "/tmp/a1",
          activePanelId: "shell",
          panels: [{ id: "shell", title: "Shell", command: "" }],
        },
        {
          id: "ws-b1",
          name: "B1",
          kind: "terminal",
          profileId: "profile-b",
          cwd: "/tmp/b1",
          activePanelId: "shell",
          panels: [{ id: "shell", title: "Shell", command: "" }],
        },
      ],
      windowSlots: [
        {
          id: "win-1",
          profileId: "profile-a",
          activeWorkspaceId: "ws-a1",
          activeSessionId: "",
          bounds: { x: 0, y: 0, width: 1280, height: 800 },
          lastFocusedAt: 1000,
        },
      ],
    };
    const fixture = await createFixture({ initialState });
    fixtures.push(fixture);

    const result = await fixture.runtime.createWindowSlot("profile-b");

    const slot = fixture.runtime.getPayload().appState.windowSlots!.find((s) => s.id === result.id)!;
    expect(slot.activeWorkspaceId).toBe("ws-b1");
    expect(slot.activeSessionId).toBe("ws-b1:shell");
  });
});

describe("profile view-state persistence — workspace deletion cleanup", () => {
  test("clears profile lastActive ids when the referenced workspace is deleted", async () => {
    const initialState = {
      activeProjectId: "ws-a1",
      profiles: [
        {
          id: "profile-a",
          name: "Profile A",
          color: "#aaa",
          lastActiveWorkspaceId: "ws-a2",
          lastActiveSessionId: "ws-a2:shell",
        },
      ],
      projects: [
        {
          id: "ws-a1",
          name: "A1",
          kind: "terminal",
          profileId: "profile-a",
          cwd: "/tmp/a1",
          activePanelId: "shell",
          panels: [{ id: "shell", title: "Shell", command: "" }],
        },
        {
          id: "ws-a2",
          name: "A2",
          kind: "terminal",
          profileId: "profile-a",
          cwd: "/tmp/a2",
          activePanelId: "shell",
          panels: [{ id: "shell", title: "Shell", command: "" }],
        },
      ],
      windowSlots: [
        {
          id: "win-1",
          profileId: "profile-a",
          activeWorkspaceId: "ws-a1",
          activeSessionId: "",
          bounds: { x: 0, y: 0, width: 1280, height: 800 },
          lastFocusedAt: 1000,
        },
      ],
    };
    const fixture = await createFixture({ initialState });
    fixtures.push(fixture);

    await fixture.runtime.deleteWorkspace("ws-a2", {}, "win-1");

    const state = fixture.store.getState();
    const profileA = state.profiles.find((p) => p.id === "profile-a");
    expect(profileA?.lastActiveWorkspaceId).toBeUndefined();
    expect(profileA?.lastActiveSessionId).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Provider connections are profile-owned (viewer-aware save/delete/open)
// ---------------------------------------------------------------------------

describe("provider connections — profile ownership across viewers", () => {
  class ConnFakeAzureManager extends EventEmitter {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    declare opened: any[];
    constructor() {
      super();
      this.opened = [];
    }
    async verifyConnection() {
      return { ok: true, login: "me@example.com" };
    }
    getSnapshot() {
      return {
        connections: [],
        inbox: { needsMyReview: [], myPullRequests: [], recentlyUpdated: [], needsAttention: [] },
        trackedPullRequests: {},
        pullRequests: {},
        sync: { running: false, lastStartedAt: null, lastCompletedAt: null },
      };
    }
    async sync() {
      return this.getSnapshot();
    }
    stopPolling() {}
    configurePolling() {}
    async markPullRequestSeen() {}
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async openReviewWorkspace({ prKey, callerProfileId }: any) {
      this.opened.push({ prKey, callerProfileId });
      return {
        workspace: {
          id: "ws-review-1",
          name: "web-app PR #123",
          kind: "terminal",
          cwd: "/tmp/review-pr-123",
          profileId: "profile-a",
          activePanelId: "shell",
          panels: [{ id: "shell", title: "Shell", command: "", shell: true, startup: "default" }],
          review: {
            provider: "azure-devops",
            prKey,
            connectionId: "ado-1",
            parentWorkspaceId: "ws-azure",
            checkout: { mode: "managed-worktree" },
          },
        },
      };
    }
  }

  function makeConnectionState() {
    return {
      activeProjectId: "ws-a1",
      profiles: [
        { id: "default", name: "Default", color: "#fff" },
        { id: "profile-a", name: "A", color: "#aaa" },
      ],
      projects: [
        {
          id: "ws-default",
          name: "D",
          kind: "terminal",
          profileId: "default",
          cwd: "/tmp/d",
          activePanelId: "shell",
          panels: [{ id: "shell", title: "Shell", command: "", shell: true, startup: "default" }],
        },
        {
          id: "ws-a1",
          name: "A1",
          kind: "terminal",
          profileId: "profile-a",
          cwd: "/tmp/a1",
          activePanelId: "shell",
          panels: [{ id: "shell", title: "Shell", command: "", shell: true, startup: "default" }],
        },
      ],
      windowSlots: [
        // windowSlots[0] is the DEFAULT profile — the regression these tests
        // pin is "connection silently lands in windowSlots[0]'s profile".
        {
          id: "win-default",
          profileId: "default",
          activeWorkspaceId: "ws-default",
          activeSessionId: "",
          bounds: { x: 0, y: 0, width: 1280, height: 800 },
          lastFocusedAt: 1000,
        },
        {
          id: "win-a",
          profileId: "profile-a",
          activeWorkspaceId: "ws-a1",
          activeSessionId: "",
          bounds: { x: 40, y: 40, width: 1280, height: 800 },
          lastFocusedAt: 2000,
        },
        {
          id: "win-a2",
          profileId: "profile-a",
          activeWorkspaceId: "ws-a1",
          activeSessionId: "",
          bounds: { x: 80, y: 80, width: 1280, height: 800 },
          lastFocusedAt: 3000,
        },
      ],
    };
  }

  test("save connection from a profile-a window stores profileId=profile-a even though windowSlots[0] is default", async () => {
    const fixture = await createFixture({
      initialState: makeConnectionState(),
      dependencies: { AzureDevOpsManager: ConnFakeAzureManager },
    });
    fixtures.push(fixture);

    await fixture.runtime.saveAzureConnection(
      { id: "ado-1", label: "Acme", orgUrl: "https://dev.azure.com/acme", pat: "secret" },
      "win-a",
    );

    const state = fixture.store.getState();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const conn = (state.settings.integrations.azureDevops.connections as any[]).find((c) => c.id === "ado-1");
    expect(conn?.profileId).toBe("profile-a");
    // The inbox workspace landed in the SAME profile…
    const inboxes = state.workspaces.filter((w) => w.kind === "azure");
    expect(inboxes).toHaveLength(1);
    expect(inboxes[0].profileId).toBe("profile-a");
  });

  test("saving from two windows of the same profile does not create a duplicate inbox workspace", async () => {
    const fixture = await createFixture({
      initialState: makeConnectionState(),
      dependencies: { AzureDevOpsManager: ConnFakeAzureManager },
    });
    fixtures.push(fixture);

    await fixture.runtime.saveAzureConnection(
      { id: "ado-1", label: "Acme", orgUrl: "https://dev.azure.com/acme", pat: "secret" },
      "win-a",
    );
    await fixture.runtime.saveAzureConnection(
      { id: "ado-2", label: "Acme 2", orgUrl: "https://dev.azure.com/acme2", pat: "secret" },
      "win-a2",
    );

    const inboxes = fixture.store.getState().workspaces.filter((w) => w.kind === "azure");
    expect(inboxes).toHaveLength(1);
    expect(inboxes[0].profileId).toBe("profile-a");
  });

  test("save connection from a remote viewer whose profile has NO desktop window still lands in that profile", async () => {
    const base = makeConnectionState();
    const initialState = {
      ...base,
      // Only the default-profile window is open; profile-a is desktop-less.
      windowSlots: [base.windowSlots[0]],
    };
    const fixture = await createFixture({
      initialState,
      dependencies: { AzureDevOpsManager: ConnFakeAzureManager },
    });
    fixtures.push(fixture);

    const registry = new RemoteClientRegistry();
    fixture.runtime.setRemoteClientRegistry(registry);
    registry.getOrCreate("mobile-1", fixture.store.getState(), "profile-a");

    await fixture.runtime.saveAzureConnection(
      { id: "ado-1", label: "Acme", orgUrl: "https://dev.azure.com/acme", pat: "secret" },
      "remote:mobile-1",
    );

    const state = fixture.store.getState();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const conn = (state.settings.integrations.azureDevops.connections as any[]).find((c) => c.id === "ado-1");
    expect(conn?.profileId).toBe("profile-a");
    const inboxes = state.workspaces.filter((w) => w.kind === "azure");
    expect(inboxes).toHaveLength(1);
    expect(inboxes[0].profileId).toBe("profile-a");
  });

  test("delete connection from a viewer of another profile is refused", async () => {
    const fixture = await createFixture({
      initialState: makeConnectionState(),
      dependencies: { AzureDevOpsManager: ConnFakeAzureManager },
    });
    fixtures.push(fixture);

    await fixture.runtime.saveAzureConnection(
      { id: "ado-1", label: "Acme", orgUrl: "https://dev.azure.com/acme", pat: "secret" },
      "win-a",
    );

    await expect(fixture.runtime.deleteAzureConnection("ado-1", "win-default")).rejects.toThrow(
      /Cross-profile refused/i,
    );
    // Still present.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const conns = fixture.store.getState().settings.integrations.azureDevops.connections as any[];
    expect(conns.some((c) => c.id === "ado-1")).toBe(true);

    // The owning profile's viewer can delete it.
    await fixture.runtime.deleteAzureConnection("ado-1", "win-a");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const after = fixture.store.getState().settings.integrations.azureDevops.connections as any[];
    expect(after.some((c) => c.id === "ado-1")).toBe(false);
  });

  test("open PR review from window P activates only that window — the sibling window of P stays put", async () => {
    const fixture = await createFixture({
      initialState: makeConnectionState(),
      dependencies: { AzureDevOpsManager: ConnFakeAzureManager },
    });
    fixtures.push(fixture);

    await fixture.runtime.openAzurePullRequest({ prKey: "ado-1:repo:123" }, "win-a");

    const slots = fixture.runtime.getPayload().appState.windowSlots!;
    expect(slots.find((s) => s.id === "win-a")?.activeWorkspaceId).toBe("ws-review-1");
    // The OTHER window of the same profile keeps its own view.
    expect(slots.find((s) => s.id === "win-a2")?.activeWorkspaceId).toBe("ws-a1");
    expect(slots.find((s) => s.id === "win-default")?.activeWorkspaceId).toBe("ws-default");
  });

  test("new PR review is inserted directly below its provider inbox before older reviews", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const initialState: any = makeConnectionState();
    initialState.projects.push(
      {
        id: "ws-azure",
        name: "Azure DevOps",
        kind: "azure",
        profileId: "profile-a",
        cwd: "/tmp/azure",
        activePanelId: "",
        panels: [],
      },
      {
        id: "ws-review-old",
        name: "Old review",
        kind: "terminal",
        profileId: "profile-a",
        cwd: "/tmp/review-old",
        activePanelId: "shell",
        panels: [{ id: "shell", title: "Shell", command: "", shell: true, startup: "default" }],
        review: {
          provider: "azure-devops",
          prKey: "ado-1:repo:122",
          connectionId: "ado-1",
          parentWorkspaceId: "ws-azure",
          checkout: { mode: "managed-worktree" },
        },
      },
    );
    const fixture = await createFixture({
      initialState,
      dependencies: { AzureDevOpsManager: ConnFakeAzureManager },
    });
    fixtures.push(fixture);

    await fixture.runtime.openAzurePullRequest({ prKey: "ado-1:repo:123" }, "win-a");

    expect(
      fixture.store
        .getState()
        .workspaces.filter((workspace) => (workspace.profileId || "default") === "profile-a")
        .map((workspace) => workspace.id),
    ).toEqual(["ws-a1", "ws-azure", "ws-review-1", "ws-review-old"]);
    expect(fixture.store.getState().workspaces[0].id).toBe("ws-default");
  });

  test("open PR review from remote P activates the remote viewer — desktop windows stay where they were", async () => {
    const fixture = await createFixture({
      initialState: makeConnectionState(),
      dependencies: { AzureDevOpsManager: ConnFakeAzureManager },
    });
    fixtures.push(fixture);

    const registry = new RemoteClientRegistry();
    fixture.runtime.setRemoteClientRegistry(registry);
    registry.getOrCreate("mobile-1", fixture.store.getState(), "profile-a");

    await fixture.runtime.openAzurePullRequest({ prKey: "ado-1:repo:123" }, "remote:mobile-1");

    expect(registry.get("mobile-1")!.activeWorkspaceId).toBe("ws-review-1");
    const slots = fixture.runtime.getPayload().appState.windowSlots!;
    expect(slots.find((s) => s.id === "win-a")?.activeWorkspaceId).toBe("ws-a1");
    expect(slots.find((s) => s.id === "win-a2")?.activeWorkspaceId).toBe("ws-a1");
    expect(slots.find((s) => s.id === "win-default")?.activeWorkspaceId).toBe("ws-default");
  });
});

// ---------------------------------------------------------------------------
// Terminal input lease — multiple viewers of one PTY session
// ---------------------------------------------------------------------------

describe("terminal input lease", () => {
  function makeLeaseState() {
    const base = makeProfileSwitchState();
    return {
      ...base,
      windowSlots: [
        {
          id: "win-1",
          profileId: "profile-a",
          activeWorkspaceId: "ws-a1",
          activeSessionId: "ws-a1:shell",
          bounds: { x: 0, y: 0, width: 1280, height: 800 },
          lastFocusedAt: 1000,
        },
        {
          id: "win-2",
          profileId: "profile-a",
          activeWorkspaceId: "ws-a1",
          activeSessionId: "ws-a1:shell",
          bounds: { x: 40, y: 40, width: 1280, height: 800 },
          lastFocusedAt: 2000,
        },
      ],
    };
  }

  test("second viewer typing into a leased session is blocked with the owner label", async () => {
    const fixture = await createFixture({ initialState: makeLeaseState() });
    fixtures.push(fixture);

    // Window 1 types — acquires the lease.
    const first = fixture.runtime.writeToSession("ws-a1:shell", "ls\r", "win-1");
    expect(first).toMatchObject({ ok: true });

    // Window 2 types — blocked, owner identified for the prompt.
    const second = fixture.runtime.writeToSession("ws-a1:shell", "echo hi\r", "win-2");
    expect(second).toMatchObject({ blocked: true, ownerViewerId: "win-1", ownerLabel: "Window 1" });
    // The blocked keystrokes never reached the PTY.
    const written = fixture.sessionManager.writeCalls.filter(
      (w: { sessionId: string }) => w.sessionId === "ws-a1:shell",
    );
    expect(written.map((w: { data: string }) => w.data)).toEqual(["ls\r"]);
  });

  test("same viewer keeps renewing its own lease", async () => {
    const fixture = await createFixture({ initialState: makeLeaseState() });
    fixtures.push(fixture);

    expect(fixture.runtime.writeToSession("ws-a1:shell", "a", "win-1")).toMatchObject({ ok: true });
    expect(fixture.runtime.writeToSession("ws-a1:shell", "b", "win-1")).toMatchObject({ ok: true });
  });

  test("expired lease lets another viewer take over silently", async () => {
    const fixture = await createFixture({ initialState: makeLeaseState() });
    fixtures.push(fixture);

    fixture.runtime.writeToSession("ws-a1:shell", "ls\r", "win-1");
    // Force-expire the lease.
    const leases = fixture.runtime._sessionInputLeasesForTest();
    const lease = leases.get("ws-a1:shell")!;
    leases.set("ws-a1:shell", { ...lease, expiresAt: Date.now() - 1 });

    const result = fixture.runtime.writeToSession("ws-a1:shell", "echo hi\r", "win-2");
    expect(result).toMatchObject({ ok: true });
    expect(leases.get("ws-a1:shell")?.viewerId).toBe("win-2");
  });

  test("takeSessionControl transfers the lease so the new owner can type", async () => {
    const fixture = await createFixture({ initialState: makeLeaseState() });
    fixtures.push(fixture);

    fixture.runtime.writeToSession("ws-a1:shell", "ls\r", "win-1");
    expect(fixture.runtime.writeToSession("ws-a1:shell", "x", "win-2")).toMatchObject({ blocked: true });

    expect(fixture.runtime.takeSessionControl("ws-a1:shell", "win-2")).toEqual({ ok: true });
    expect(fixture.runtime.writeToSession("ws-a1:shell", "x", "win-2")).toMatchObject({ ok: true });
    // Now the ORIGINAL owner is the one that gets blocked.
    expect(fixture.runtime.writeToSession("ws-a1:shell", "y", "win-1")).toMatchObject({
      blocked: true,
      ownerLabel: "Window 2",
    });
  });

  test("mouse-reporting escapes neither grab nor get blocked by the lease (watch-only viewers)", async () => {
    const fixture = await createFixture({ initialState: makeLeaseState() });
    fixtures.push(fixture);

    fixture.runtime.writeToSession("ws-a1:shell", "ls\r", "win-1");
    // Window 2 clicks into the pane to watch — mouse escape sequence only.
    const result = fixture.runtime.writeToSession("ws-a1:shell", "\x1b[<0;10;5M", "win-2");
    expect(result).toMatchObject({ ok: true });
    // Lease still belongs to win-1.
    expect(fixture.runtime._sessionInputLeasesForTest().get("ws-a1:shell")?.viewerId).toBe("win-1");
  });

  test("internal writers (no viewerId — task runner) bypass the lease", async () => {
    const fixture = await createFixture({ initialState: makeLeaseState() });
    fixtures.push(fixture);

    fixture.runtime.writeToSession("ws-a1:shell", "ls\r", "win-1");
    const result = fixture.runtime.writeToSession("ws-a1:shell", "injected prompt\r");
    expect(result).toMatchObject({ ok: true });
  });

  test("remote viewers participate in the lease with a friendly label", async () => {
    const fixture = await createFixture({ initialState: makeLeaseState() });
    fixtures.push(fixture);

    const registry = new RemoteClientRegistry();
    fixture.runtime.setRemoteClientRegistry(registry);
    registry.getOrCreate("mobile-1", fixture.store.getState(), "profile-a");

    fixture.runtime.writeToSession("ws-a1:shell", "ls\r", "remote:mobile-1");
    const blocked = fixture.runtime.writeToSession("ws-a1:shell", "x", "win-1");
    expect(blocked).toMatchObject({ blocked: true, ownerLabel: "a remote client" });
  });
});

// ---------------------------------------------------------------------------
// Profile delete with running task agents — explicit decision required
// ---------------------------------------------------------------------------

describe("deleteProfile with running tasks", () => {
  function makeTaskProfileState() {
    return {
      activeProjectId: "ws-keep",
      profiles: [
        { id: "default", name: "Default", color: "#fff" },
        { id: "profile-tasks", name: "Tasks", color: "#aaa" },
      ],
      projects: [
        {
          id: "ws-keep",
          name: "Keep",
          kind: "terminal",
          profileId: "default",
          cwd: "/tmp/keep",
          activePanelId: "shell",
          panels: [{ id: "shell", title: "Shell", command: "", shell: true, startup: "default" }],
        },
        {
          id: "ws-task",
          name: "Task agent",
          kind: "task",
          profileId: "profile-tasks",
          cwd: "/tmp/task",
          activePanelId: "dashboard",
          panels: [{ id: "dashboard", title: "Dashboard", command: "__task-dashboard__", startup: "none" }],
          task: {
            taskId: "t1",
            description: "Do work",
            state: "running",
            parentWorkspaceId: "",
            workerPanelId: "worker",
            judgePanelId: "judge",
          },
        },
      ],
      // profile-tasks is NOT open in any window (deletable at all).
      windowSlots: [
        {
          id: "win-1",
          profileId: "default",
          activeWorkspaceId: "ws-keep",
          activeSessionId: "",
          bounds: { x: 0, y: 0, width: 1280, height: 800 },
          lastFocusedAt: 1000,
        },
      ],
    };
  }

  // Startup recovery flips active task states to "paused" when the runtime
  // boots (crash-recovery semantics), so re-mark the task as running AFTER
  // fixture startup — the way a live runner would.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async function markTaskRunning(fixture: any) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await fixture.store.mutate((draft: any) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const ws = draft.workspaces.find((w: any) => w.id === "ws-task");
      if (ws?.task) ws.task.state = "running";
    });
  }

  test("refuses without an explicit taskAction", async () => {
    const fixture = await createFixture({ initialState: makeTaskProfileState() });
    fixtures.push(fixture);
    await markTaskRunning(fixture);

    await expect(fixture.runtime.deleteProfile("profile-tasks")).rejects.toThrow(/running task agent/i);
    // Profile untouched.
    expect(fixture.store.getState().profiles.some((p) => p.id === "profile-tasks")).toBe(true);
  });

  test("taskAction 'pause' pauses the tasks and deletes the profile", async () => {
    const fixture = await createFixture({ initialState: makeTaskProfileState() });
    fixtures.push(fixture);
    await markTaskRunning(fixture);

    await fixture.runtime.deleteProfile("profile-tasks", { taskAction: "pause" });

    const state = fixture.store.getState();
    expect(state.profiles.some((p) => p.id === "profile-tasks")).toBe(false);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const taskWs = state.workspaces.find((w) => w.id === "ws-task") as any;
    // The runner pauses the agent (or it was already not running in this
    // fixture environment); it must NOT be left in an active state.
    expect(["paused", "stopped", "idle", "running"]).toContain(taskWs?.task?.state || "idle");
    expect(taskWs?.task?.state === "running").toBe(false);
  });

  test("profile without running tasks deletes without options as before", async () => {
    const base = makeTaskProfileState();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (base.projects[1] as any).task.state = "completed";
    const fixture = await createFixture({ initialState: base });
    fixtures.push(fixture);

    await fixture.runtime.deleteProfile("profile-tasks");
    expect(fixture.store.getState().profiles.some((p) => p.id === "profile-tasks")).toBe(false);
  });
});

describe("syncAttentionContext — per-viewer visibility union (mobile flip-flop regression)", () => {
  // Two viewers (e.g. a desktop window + a mobile/web client) used to share a
  // single global visible-session set, so whichever synced last won. A mobile
  // client on a non-terminal Azure "Review" tab reports [] visible terminals;
  // that [] wiped the desktop's visible terminal out of the global set, and the
  // two viewers flip-flopped it on every sync — re-rendering the mobile and
  // spamming terminal resizes. Visibility is now tracked per viewer and
  // unioned: a session visible in ANY viewer counts as visible.
  //
  // backend:tests deliberately lives in a workspace that is NOT active in any
  // window slot, so nothing but the explicit syncs below marks it visible.
  // The exit alert is gated by !isSessionVisible, so "alert raised" is the
  // observable proxy for "the runtime thinks the session is hidden".
  async function createTwoViewerFixture() {
    return createFixture({
      initialState: {
        activeProjectId: "frontend",
        profiles: [{ id: "default", name: "Default" }],
        projects: [
          {
            id: "frontend",
            name: "Frontend",
            kind: "terminal",
            profileId: "default",
            cwd: "/tmp/frontend",
            activePanelId: "claude",
            panels: [{ id: "claude", title: "Claude", command: "", shell: true, startup: "default" }],
          },
          {
            id: "backend",
            name: "Backend",
            kind: "terminal",
            profileId: "default",
            cwd: "/tmp/backend",
            activePanelId: "tests",
            panels: [
              {
                id: "tests",
                title: "Tests",
                command: "npm test",
                shell: true,
                startup: "manual",
                // Opt back in to shell-exit alerts (globally off via agentsOnly).
                alertsForceOn: true,
              },
            ],
          },
        ],
        windowSlots: [
          {
            id: "win-a",
            profileId: "default",
            activeWorkspaceId: "frontend",
            activeSessionId: "",
            bounds: { x: 0, y: 0, width: 1280, height: 800 },
            lastFocusedAt: 1000,
          },
          {
            id: "win-b",
            profileId: "default",
            activeWorkspaceId: "frontend",
            activeSessionId: "",
            bounds: { x: 0, y: 0, width: 1280, height: 800 },
            lastFocusedAt: 2000,
          },
        ],
      },
    });
  }

  // Drive backend:tests to a non-zero exit after marking it user-interactive.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function runToFailingExit(fixture: any) {
    fixture.sessionManager.emit("terminal:data", { sessionId: "backend:tests", data: "$ " });
    fixture.runtime.writeToSession("backend:tests", "npm test\r");
    fixture.sessionManager.emit("terminal:exit", { sessionId: "backend:tests", exitCode: 2, intentional: false });
  }

  test("a second viewer reporting [] does not wipe the first viewer's visible session", async () => {
    const fixture = await createTwoViewerFixture();
    fixtures.push(fixture);

    // Desktop (win-a) is looking at backend:tests; mobile (win-b) is on a
    // non-terminal review tab and reports nothing visible.
    await fixture.runtime.syncAttentionContext({ visibleSessionIds: ["backend:tests"], windowId: "win-a" });
    await fixture.runtime.syncAttentionContext({ visibleSessionIds: [], windowId: "win-b" });

    runToFailingExit(fixture);

    // Still visible via win-a → no alert. Pre-fix, win-b's [] clobbered the
    // global set and this raised an alert.
    expect(fixture.runtime.getPayload().attention.byProject.backend).toBeUndefined();
  });

  test("order does not matter: the [] viewer syncing last still does not clobber", async () => {
    const fixture = await createTwoViewerFixture();
    fixtures.push(fixture);

    // Reverse order from the previous test: the empty sync arrives last, which
    // under the old last-writer-wins global set was the worst case.
    await fixture.runtime.syncAttentionContext({ visibleSessionIds: [], windowId: "win-b" });
    await fixture.runtime.syncAttentionContext({ visibleSessionIds: ["backend:tests"], windowId: "win-a" });
    await fixture.runtime.syncAttentionContext({ visibleSessionIds: [], windowId: "win-b" });

    runToFailingExit(fixture);

    expect(fixture.runtime.getPayload().attention.byProject.backend).toBeUndefined();
  });

  test("once the only viewer that saw the session drops, it is no longer visible", async () => {
    vi.useFakeTimers();
    try {
      const fixture = await createTwoViewerFixture();
      fixtures.push(fixture);

      await fixture.runtime.syncAttentionContext({ visibleSessionIds: ["backend:tests"], windowId: "win-a" });
      await fixture.runtime.syncAttentionContext({ visibleSessionIds: [], windowId: "win-b" });

      // The viewer that had it visible goes away (window closed / socket dropped).
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (fixture.runtime as any).dropViewerVisibility("win-a");
      // Advance past the 5s visibility grace window so the session is fully hidden.
      await vi.advanceTimersByTimeAsync(6_000);

      runToFailingExit(fixture);

      expect(fixture.runtime.getPayload().attention.byProject.backend).toMatchObject({ count: 1 });
    } finally {
      vi.useRealTimers();
    }
  });

  test("removeWindowSlot drops the closed window's visible-session contribution", async () => {
    vi.useFakeTimers();
    try {
      const fixture = await createTwoViewerFixture();
      fixtures.push(fixture);

      await fixture.runtime.syncAttentionContext({ visibleSessionIds: ["backend:tests"], windowId: "win-a" });

      // Closing the window must remove its visibility contribution, not leave
      // backend:tests pinned "visible" forever (which would suppress its alerts).
      await fixture.runtime.removeWindowSlot("win-a");
      await vi.advanceTimersByTimeAsync(6_000);

      runToFailingExit(fixture);

      expect(fixture.runtime.getPayload().attention.byProject.backend).toMatchObject({ count: 1 });
    } finally {
      vi.useRealTimers();
    }
  });

  test("a real viewer sync supersedes the viewer-less activation primer", async () => {
    vi.useFakeTimers();
    try {
      const fixture = await createTwoViewerFixture();
      fixtures.push(fixture);

      // Viewer-less path (legacy/internal activateWorkspace with no windowId)
      // primes the default bucket with backend:tests visible.
      await fixture.runtime.syncAttentionContext({ visibleSessionIds: ["backend:tests"] });
      // A real viewer (win-a) then reports it is looking at something else.
      // This must drop the primer so backend:tests stops counting as visible
      // — otherwise the primer would suppress its alerts indefinitely.
      await fixture.runtime.syncAttentionContext({ visibleSessionIds: ["frontend:claude"], windowId: "win-a" });
      await vi.advanceTimersByTimeAsync(6_000);

      runToFailingExit(fixture);

      expect(fixture.runtime.getPayload().attention.byProject.backend).toMatchObject({ count: 1 });
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// Regression tests: review-code-quality-2026-07.md — fire-and-forget /
// silently-swallowed catches in runtime.ts now log instead of vanishing.
//
// Several of these spy on the real winston logger rather than mocking
// "./logger.js" wholesale (which would affect every test above). getLogger()
// returns a proxy that dispatches to the CURRENT singleton at call time
// (see logger.ts), so calling reconfigureLogger() here hands back a fresh
// winston.Logger instance that every existing `log = getLogger(...)` proxy
// (including runtime.ts's own module-level `log`) will use for its next
// call — spying on that instance's methods captures runtime.ts's log calls
// without touching how any other test in this file logs.
// ---------------------------------------------------------------------------

describe("ensureSessionSafe — fire-and-forget ensureSession failures are logged, not unhandled", () => {
  test("activateSession: a rejecting ensureSession is caught and logged via log.error", async () => {
    const fixture = await createFixture();
    fixtures.push(fixture);

    fixture.sessionManager.ensureSession = vi.fn().mockRejectedValue(new Error("boom: ensureSession"));

    const calls = captureLogCalls();
    try {
      // No workspace named "proj" needs to exist in state — ensureSessionSafe
      // fires unconditionally regardless of whether the store.mutate lookup
      // found a matching workspace.
      await fixture.runtime.activateSession("proj:shell");
      // Let the fire-and-forget .catch() microtask run.
      await new Promise((r) => setImmediate(r));

      expect(calls).toContainEqual(
        expect.objectContaining({
          level: "error",
          message: "ensureSession failed",
          meta: expect.objectContaining({ sessionId: "proj:shell", err: "boom: ensureSession" }),
        }),
      );
    } finally {
      logCallCapture.current = null;
    }
  });
});

describe("suspectRateLimit — confirm-timer failures are caught, not unhandled", () => {
  test("a throw from taskRunner.onAgentRateLimited inside the confirm timer is caught and logged via log.warn", async () => {
    const onAgentRateLimitedSpy = vi
      .spyOn(AgentTaskRunner.prototype, "onAgentRateLimited")
      .mockImplementation(() => {
        throw new Error("boom: onAgentRateLimited");
      });
    vi.useFakeTimers();
    try {
      const fixture = await createFixture({
        initialState: {
          activeWorkspaceId: "ws",
          workspaces: [
            {
              id: "ws",
              name: "WS",
              kind: "terminal",
              cwd: "/tmp/ws",
              activePanelId: "shell",
              panels: [{ id: "shell", title: "Shell", command: "", shell: true, startup: "default" }],
            },
          ],
        },
      });
      fixtures.push(fixture);

      const calls = captureLogCalls();

      // "HTTP 429" matches the generic-fallback rate-limit detector without
      // any clock-parsing, keeping the trigger deterministic.
      fixture.sessionManager.emit("terminal:data", {
        sessionId: "ws:shell",
        data: "Error: HTTP 429 Too Many Requests\r\n",
      });

      // Advance past the confirm window; the async IIFE body runs on this timer.
      await vi.advanceTimersByTimeAsync(60_000);

      expect(calls).toContainEqual(
        expect.objectContaining({
          level: "warn",
          message: "rate-limit confirm-timer failed",
          meta: expect.objectContaining({ sessionId: "ws:shell", workspaceId: "ws", panelId: "shell" }),
        }),
      );
    } finally {
      logCallCapture.current = null;
      onAgentRateLimitedSpy.mockRestore();
      vi.useRealTimers();
    }
  });
});

describe("dispatchAgentHookEvent call sites — an async rejection is logged via log.warn, not unhandled", () => {
  afterEach(() => {
    classifyHookEventOverride.current = null;
  });

  test("notifyAgentHook (IPC call site): a rejecting dispatch is caught and logged, doesn't crash the caller", async () => {
    const fixture = await createFixture();
    fixtures.push(fixture);

    classifyHookEventOverride.current = () => {
      throw new Error("boom: classifyHookEvent");
    };

    const calls = captureLogCalls();
    try {
      // notifyAgentHook is synchronous (fire-and-forget) — must not throw
      // even though the underlying dispatch rejects.
      expect(() => fixture.runtime.notifyAgentHook("proj:panel", "idle_prompt", "Notification")).not.toThrow();
      await new Promise((r) => setImmediate(r));

      expect(calls).toContainEqual(
        expect.objectContaining({
          level: "warn",
          message: "hook dispatch failed",
          meta: expect.objectContaining({ sessionId: "proj:panel", hook: "Notification" }),
        }),
      );
    } finally {
      logCallCapture.current = null;
    }
  });
});

describe("runShellGitRefresh — a rejecting refreshGit is logged via log.debug", () => {
  test("scheduleGitRefreshFromShell → runShellGitRefresh: a rejecting git.refreshWorkspaces is caught and logged", async () => {
    const fixture = await createFixture({
      initialState: {
        activeWorkspaceId: "ws-a",
        workspaces: [
          {
            id: "ws-a",
            name: "Shell ws-a",
            kind: "terminal",
            cwd: "/repo/ws-a",
            activePanelId: "shell",
            panels: [{ id: "shell", title: "Shell", command: "", shell: true, startup: "default" }],
          },
        ],
      },
    });
    fixtures.push(fixture);
    // Drain the background init refresh before rigging the rejection.
    await new Promise((r) => setTimeout(r, 50));

    fixture.git.refreshWorkspaces = vi.fn().mockRejectedValue(new Error("boom: refreshWorkspaces"));

    const calls = captureLogCalls();
    vi.useFakeTimers();
    try {
      fixture.runtime.scheduleGitRefreshFromShell("ws-a");
      await vi.advanceTimersByTimeAsync(1_000);

      expect(calls).toContainEqual(
        expect.objectContaining({
          level: "debug",
          message: "shell git refresh failed",
          meta: expect.objectContaining({ workspaceId: "ws-a", err: "boom: refreshWorkspaces" }),
        }),
      );
    } finally {
      vi.useRealTimers();
      logCallCapture.current = null;
    }
  });
});

describe("low-severity silent-catch batch — each now logs on failure", () => {
  test("ensureNotifyScript resolving { ok: false } (it never rejects) is logged via log.error", async () => {
    ensureNotifyScriptOverride.current = async () => ({
      ok: false,
      path: "/fake/notify.mjs",
      error: "EACCES: permission denied",
    });

    const calls = captureLogCalls();
    try {
      const fixture = await createFixture();
      fixtures.push(fixture);

      expect(calls).toContainEqual(
        expect.objectContaining({
          level: "error",
          message: "ensureNotifyScript failed — agent hooks may not work",
          meta: expect.objectContaining({ err: "EACCES: permission denied" }),
        }),
      );
    } finally {
      ensureNotifyScriptOverride.current = null;
      logCallCapture.current = null;
    }
  });

  test("broadcastState microtask: a throw from getPayload() (via sessions.getWorkspace) is caught and logged via log.error", async () => {
    const fixture = await createFixture();
    fixtures.push(fixture);

    const calls = captureLogCalls();
    try {
      fixture.sessionManager.getWorkspace = () => {
        throw new Error("boom: getWorkspace");
      };
      // git's "updated" listener calls broadcastState() with nothing else
      // running synchronously afterward — a clean trigger for the queued
      // microtask's own internal getPayload() call, isolated from any other
      // code path that might also call getPayload().
      fixture.git.emit("updated");
      // Let the queued microtask run.
      await new Promise((r) => setImmediate(r));

      expect(calls).toContainEqual(
        expect.objectContaining({
          level: "error",
          message: "broadcastState tick failed",
          meta: expect.objectContaining({ err: expect.stringContaining("boom: getWorkspace") }),
        }),
      );
    } finally {
      logCallCapture.current = null;
    }
  });
});
