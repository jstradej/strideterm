import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, test, vi } from "vitest";
import { createRuntime, detectTerminalEnvironment, hasMeaningfulUserInput } from "./runtime.js";
import { createSessionId, normalizeState } from "./default-state.js";

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
        state = normalizeState(nextState);
        return state;
      });
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async mutate(mutator: any) {
      return enqueue(async () => {
        const draft = structuredClone(state);
        const result = await mutator(draft);
        state = normalizeState(result || draft);
        return state;
      });
    },
    async save() {
      return enqueue(async () => {
        saveCalls += 1;
        return state;
      });
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

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ensureSession(state: any, sessionId: any) {
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
  removeProjectSessions(projectId: any) {
    this.removedProjects.push(projectId);
    for (const sessionId of [...this.sessions.keys()]) {
      if (sessionId.startsWith(`${projectId}:`)) {
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
}

class FakeGitManager extends EventEmitter {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  declare snapshots: Map<any, any>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  declare refreshArgs: any[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  declare actions: any[];

  constructor() {
    super();
    this.snapshots = new Map();
    this.refreshArgs = [];
    this.actions = [];
  }

  getProjectMap() {
    return Object.fromEntries(this.snapshots.entries());
  }

  getSnapshot(projectId: string) {
    return this.snapshots.get(projectId) || null;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async refreshProjects(projects: any[] = []) {
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
  async fetch(workspace: any) {
    this.actions.push({ kind: "fetch", workspaceId: workspace.id });
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
    getThemeSource: () => "light",
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

afterEach(async () => {
  await Promise.all(
    fixtures.splice(0).map(async (fixture) => {
      await fixture.runtime.stop();
      await fs.rm(fixture.userDataPath, { recursive: true, force: true });
    }),
  );
  await Promise.all(tempPaths.splice(0).map((targetPath) => fs.rm(targetPath, { recursive: true, force: true })));
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

  test("closes the review bridge store on shutdown", async () => {
    const fixture = await createFixture();
    await fixture.runtime.stop();

    expect(fixture.reviewBridgeStore.close).toHaveBeenCalledTimes(1);
    await fs.rm(fixture.userDataPath, { recursive: true, force: true });
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

  test("agentNotifyHook info is included in payload", async () => {
    const fixture = await createFixture();
    fixtures.push(fixture);

    const payload = fixture.runtime.getPayload();
    expect(payload.agentNotifyHook).toBeDefined();
    expect(payload.agentNotifyHook.enabled).toBe(true);
    expect(payload.agentNotifyHook.port).toBeGreaterThan(0);
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

    const payload = fixture.runtime.getPayload();
    expect(payload.agentNotifyHook.enabled).toBe(false);
    expect(payload.agentNotifyHook.port).toBeNull();
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
    expect(fixture.runtime.getPayload().agentNotifyHook.enabled).toBe(true);
    const initialPort = fixture.runtime.getPayload().agentNotifyHook.port;
    expect(initialPort).toBeGreaterThan(0);

    // Disable
    await fixture.runtime.updateSettings({
      notifications: { agentHook: false },
    });
    expect(fixture.runtime.getPayload().agentNotifyHook.enabled).toBe(false);
    expect(fixture.runtime.getPayload().agentNotifyHook.port).toBeNull();

    // Re-enable
    await fixture.runtime.updateSettings({
      notifications: { agentHook: true },
    });
    expect(fixture.runtime.getPayload().agentNotifyHook.enabled).toBe(true);
    expect(fixture.runtime.getPayload().agentNotifyHook.port).toBeGreaterThan(0);
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
    const payload = fixture.runtime.getPayload();
    expect(payload.agentNotifyHook.enabled).toBe(true);

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

    expect(fixture.runtime.getPayload().agentNotifyHook.enabled).toBe(false);
    expect(fixture.sessionManager.getSessionEnv).toBeTypeOf("function");

    const env = fixture.sessionManager.getSessionEnv({
      workspace: { id: "proj", cwd: "/tmp/proj" },
      sessionId: "proj:shell",
    });
    expect(env.STRIDETERM_NOTIFY_URL).toBeUndefined();
  });

  test("restarts cloudflare tunnel and emits remote config changes when settings change", async () => {
    const fixture = await createFixture();
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
    const projectWorkspaces = payload.appState.projects!.filter((project) => project.kind !== "azure");
    expect(projectWorkspaces).toHaveLength(2);
    expect(payload.appState.activeProjectId).toBe(projectWorkspaces[1].id);
    expect(projectWorkspaces[1].cwd).toBe(path.join(projectRoot, ".strideterm", "tree", "feature-x"));
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
    const child = payload.appState.projects!.find((p) => p.name === "Stack / feature-x");
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

  test("saves, activates, and deletes profiles while preserving a fallback default profile", async () => {
    const fixture = await createFixture();
    fixtures.push(fixture);

    let payload = await fixture.runtime.saveProfile({
      id: "focus",
      name: "Focus",
      workspaceIds: ["frontend"],
    });
    expect(payload.appState.profiles.some((profile) => profile.id === "focus")).toBe(true);

    payload = await fixture.runtime.activateProfile("focus");
    expect(payload.appState.activeProfileId).toBe("focus");

    payload = await fixture.runtime.deleteProfile("focus");
    expect(payload.appState.activeProfileId).toBe("default");
    expect(payload.appState.profiles).toEqual([
      { id: "default", name: "Default", color: "#ffa424", workspaceIds: [], projectIds: [] },
    ]);
  });

  test("does not rewrite the store during runtime stop", async () => {
    const fixture = await createFixture();
    fixtures.push(fixture);

    expect(fixture.store.saveCalls).toBe(0);
    await fixture.runtime.stop();
    expect(fixture.store.saveCalls).toBe(0);
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

  test("hookCapable agent session does NOT raise T3 silence alert", async () => {
    vi.useFakeTimers();
    try {
      const fixture = await createTwoWorkspaceFixture();
      fixtures.push(fixture);

      await fixture.runtime.syncAttentionContext({ visibleSessionIds: ["frontend:claude"] });
      // Prime the session as agent-like with user input
      fixture.sessionManager.emit("terminal:data", { sessionId: "backend:shell", data: "claude code v1.0\n" });
      await vi.advanceTimersByTimeAsync(16_000);
      fixture.runtime.writeToSession("backend:shell", "do a thing\r");

      // A hook fires once — now signal.hookCapable = true. We clear the
      // alert (simulates user ack'ing) so the next detector cycle starts fresh.
      fixture.runtime.notifyAgentHook("backend:shell", "idle_prompt");
      expect(fixture.runtime.getPayload().attention.byProject.backend).toMatchObject({ count: 1 });
      fixture.runtime.clearAlertForSession("backend:shell", { dismissed: false });

      // Simulate a long burst of output + long silence. Without hookCapable
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
