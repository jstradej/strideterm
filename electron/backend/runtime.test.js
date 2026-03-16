import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, test, vi } from "vitest";
import { createRuntime, detectTerminalEnvironment } from "./runtime.js";
import { createSessionId, normalizeState } from "./default-state.js";

function createMemoryStore(initialState) {
  let state = normalizeState(initialState);
  let pending = Promise.resolve();

  function enqueue(operation) {
    const next = pending.then(operation, operation);
    pending = next.catch(() => {});
    return next;
  }

  return {
    getState() {
      return state;
    },
    async replace(nextState) {
      return enqueue(async () => {
        state = normalizeState(nextState);
        return state;
      });
    },
    async mutate(mutator) {
      return enqueue(async () => {
        const draft = structuredClone(state);
        const result = await mutator(draft);
        state = normalizeState(result || draft);
        return state;
      });
    },
    async save() {
      return enqueue(async () => state);
    },
  };
}

class FakeSessionManager extends EventEmitter {
  constructor() {
    super();
    this.sessions = new Map();
    this.syncedStates = [];
    this.removedProjects = [];
    this.closedSessions = [];
    this.resizeCalls = [];
    this.writeCalls = [];
    this.stopped = false;
  }

  getWorkspace(state, projectId = state.activeProjectId) {
    const project = state.projects.find((item) => item.id === projectId) || null;
    if (!project) {
      return null;
    }

    return {
      project,
      sessions: project.panels.map((panel) => ({
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

  resolveDefaultSessionId(state, projectId = state.activeProjectId) {
    const project = state.projects.find((item) => item.id === projectId) || null;
    if (!project) {
      return null;
    }

    const activePanelId = project.activePanelId || project.panels[0]?.id || null;
    return activePanelId ? createSessionId(project.id, activePanelId) : null;
  }

  ensureSession(state, sessionId) {
    const [projectId, panelId] = String(sessionId).split(":");
    const project = state.projects.find((item) => item.id === projectId);
    const panel = project?.panels.find((item) => item.id === panelId);
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

  async restartSession(state, sessionId) {
    this.sessions.delete(sessionId);
    this.emit("terminal:exit", { sessionId, exitCode: 0, intentional: true });
    return this.ensureSession(state, sessionId);
  }

  removeSession(sessionId) {
    this.closedSessions.push(sessionId);
    this.sessions.delete(sessionId);
  }

  removeProjectSessions(projectId) {
    this.removedProjects.push(projectId);
    for (const sessionId of [...this.sessions.keys()]) {
      if (sessionId.startsWith(`${projectId}:`)) {
        this.sessions.delete(sessionId);
      }
    }
  }

  resizeSession(sessionId, cols, rows) {
    this.resizeCalls.push({ sessionId, cols, rows });
  }

  writeToSession(sessionId, data) {
    this.writeCalls.push({ sessionId, data });
  }

  syncWithState(state) {
    this.syncedStates.push(structuredClone(state));
    const validIds = new Set(state.projects.flatMap((project) => project.panels.map((panel) => createSessionId(project.id, panel.id))));
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
  constructor() {
    super();
    this.snapshot = {
      available: true,
      backend: "host",
      contexts: [],
      containers: [
        { ID: "abc123", Names: "api" },
      ],
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

  async performAction(action, containerId) {
    this.actions.push({ action, containerId });
    return this.refresh();
  }

  findContainer(containerId) {
    return this.snapshot.containers.find((item) => item.ID === containerId) || null;
  }

  createShellLaunch(containerId) {
    return { file: "docker", args: ["exec", "-it", containerId, "sh"] };
  }

  createLogsLaunch(containerId) {
    return { file: "docker", args: ["logs", "-f", containerId] };
  }

  createLazydockerLaunch() {
    return { file: "lazydocker", args: [] };
  }
}

class FakeGitManager extends EventEmitter {
  constructor() {
    super();
    this.snapshots = new Map();
    this.refreshArgs = [];
  }

  getProjectMap() {
    return Object.fromEntries(this.snapshots.entries());
  }

  getSnapshot(projectId) {
    return this.snapshots.get(projectId) || null;
  }

  async refreshProjects(projects = []) {
    this.refreshArgs.push(projects.map((project) => project.id));
    this.snapshots = new Map(projects.map((project) => [
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
        log: [],
        lazygit: {
          available: project.kind !== "docker",
          backend: project.kind !== "docker" ? "host" : null,
          error: "",
          launch: project.kind !== "docker" ? { file: "lazygit", args: [] } : null,
        },
        error: "",
        lastUpdatedAt: new Date().toISOString(),
      },
    ]));
    this.emit("updated", this.getProjectMap());
    return this.getProjectMap();
  }

  createLazygitLaunch(projectId) {
    const launch = this.snapshots.get(projectId)?.lazygit?.launch;
    return launch ? { file: launch.file, args: [...launch.args] } : null;
  }
}

class FakeTunnelManager extends EventEmitter {
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

  async startQuickTunnel(localUrl) {
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
            panels: [
              { id: "monitor", title: "Monitor", command: "" },
            ],
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

async function createFixture({ initialState, execFileTextImpl } = {}) {
  const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), "strideterm-runtime-"));
  const store = createMemoryStore(initialState);
  const sessionManager = new FakeSessionManager();
  const docker = new FakeDockerManager();
  const git = new FakeGitManager();
  const tunnel = new FakeTunnelManager();
  const execFileText = execFileTextImpl || vi.fn().mockResolvedValue({ stdout: "", stderr: "" });
  const checkRemoteOrigin = vi.fn().mockResolvedValue(undefined);

  const runtime = await createRuntime({
    userDataPath,
    builtinPluginsDir: null,
    getThemeSource: () => "light",
    dependencies: {
      createStore: async () => store,
      SessionManager: class extends FakeSessionManager {
        constructor() {
          return sessionManager;
        }
      },
      DockerManager: class extends FakeDockerManager {
        constructor() {
          return docker;
        }
      },
      GitManager: class extends FakeGitManager {
        constructor() {
          return git;
        }
      },
      CloudflareTunnelManager: class extends FakeTunnelManager {
        constructor() {
          return tunnel;
        }
      },
      createPluginManager: createPluginManagerStub,
      execFileText,
      checkRemoteOrigin,
    },
  });

  return {
    runtime,
    store,
    sessionManager,
    docker,
    git,
    tunnel,
    execFileText,
    checkRemoteOrigin,
    userDataPath,
  };
}

const fixtures = [];
const tempPaths = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map(async (fixture) => {
    await fixture.runtime.stop();
    await fs.rm(fixture.userDataPath, { recursive: true, force: true });
  }));
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

describe("runtime integration", () => {
  test("includes terminal environment in payload", async () => {
    const fixture = await createFixture();
    fixtures.push(fixture);

    expect(fixture.runtime.getPayload().environment).toEqual(detectTerminalEnvironment());
  });

  test("raises and clears project alerts for background terminal exits", async () => {
    const fixture = await createFixture();
    fixtures.push(fixture);

    await fixture.runtime.syncAttentionContext({ visibleSessionIds: ["frontend:claude"] });

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

    const payload = await fixture.runtime.activateSession("backend:tests");

    expect(payload.attention.byProject.backend).toBeUndefined();
    expect(payload.appState.activeProjectId).toBe("backend");
    expect(payload.workspace.project.activePanelId).toBe("tests");
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
            panels: [
              { id: "dev", title: "Dev", command: "npm run dev", shell: true, startup: "default" },
            ],
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
            panels: [
              { id: "monitor", title: "Monitor", command: "btm", shell: true, startup: "default" },
            ],
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
              panels: [
                { id: "codex", title: "Codex", command: "codex", shell: true, startup: "default" },
              ],
            },
          ],
        },
      });
      fixtures.push(fixture);

      fixture.sessionManager.emit("terminal:data", {
        sessionId: "frontend:codex",
        data: "Planning changes\r\nApplying patch\r\n",
      });
      fixture.sessionManager.emit("terminal:data", {
        sessionId: "frontend:codex",
        data: "PS C:\\repo> ",
      });

      await vi.advanceTimersByTimeAsync(950);

      expect(fixture.runtime.getPayload().attention.byProject.frontend).toMatchObject({
        count: 1,
      });
      expect(fixture.runtime.getPayload().attention.byProject.frontend.alerts[0]).toMatchObject({
        panelId: "codex",
        kind: "waiting",
        detail: "prompt-returned",
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
              panels: [
                { id: "monitor", title: "Monitor", command: "codex", shell: true, startup: "default" },
              ],
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

  test("restarts cloudflare tunnel and emits remote config changes when settings change", async () => {
    const fixture = await createFixture();
    fixtures.push(fixture);
    const configChanges = [];
    fixture.runtime.on("remote:config-changed", (payload) => configChanges.push(payload));

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
    const fixture = await createFixture();
    fixtures.push(fixture);

    const payload = await fixture.runtime.openDockerSession({
      projectId: "docker",
      containerId: "abc123",
      mode: "logs",
    });

    expect(payload.appState.activeProjectId).toBe("docker");
    expect(payload.workspace.project.activePanelId).toBe("logs-abc123");
    expect(payload.workspace.project.panels.some((panel) => panel.id === "logs-abc123")).toBe(true);
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
    expect(payload.appState.projects).toHaveLength(2);
    expect(payload.appState.activeProjectId).toBe(payload.appState.projects[1].id);
    expect(payload.appState.projects[1].cwd).toBe(path.join(projectRoot, ".strideterm", "tree", "feature-x"));
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
});
