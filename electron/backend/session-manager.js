import { EventEmitter, once } from "node:events";
import pty from "node-pty";
import { createSessionId, parseSessionId } from "./default-state.js";
import { APP_CONFIG } from "../../config/app-config.js";

function shellConfig() {
  if (process.platform === "win32") {
    return {
      file: process.env.COMSPEC || APP_CONFIG.session.windowsShellFile,
      args: process.env.COMSPEC ? [] : [...APP_CONFIG.session.windowsShellArgs],
    };
  }

  return {
    file: process.env.SHELL || APP_CONFIG.session.posixShellFile,
    args: [...APP_CONFIG.session.posixShellArgs],
  };
}

function findWorkspace(state, workspaceId) {
  const workspaces = state.workspaces || state.projects || [];
  return workspaces.find((workspace) => workspace.id === workspaceId) || null;
}

function findPanel(workspace, panelId) {
  return workspace?.panels.find((panel) => panel.id === panelId) || null;
}

function isBrowserPanel(panel) {
  return panel && /^https?:\/\//i.test(panel.command || "");
}

export class SessionManager extends EventEmitter {
  constructor() {
    super();
    this.sessions = new Map();
    this.suppressedExits = new Map();
  }

  suppressNextExit(sessionId) {
    this.suppressedExits.set(sessionId, (this.suppressedExits.get(sessionId) || 0) + 1);
  }

  consumeSuppressedExit(sessionId) {
    const current = this.suppressedExits.get(sessionId) || 0;
    if (current <= 0) {
      return false;
    }

    if (current === 1) {
      this.suppressedExits.delete(sessionId);
    } else {
      this.suppressedExits.set(sessionId, current - 1);
    }

    return true;
  }

  getWorkspace(state, workspaceId = state.activeWorkspaceId || state.activeProjectId) {
    const workspace = findWorkspace(state, workspaceId);
    if (!workspace) {
      return null;
    }

    return {
      workspace,
      project: workspace,
      sessions: workspace.panels.filter((panel) => !isBrowserPanel(panel)).map((panel) => {
        const runtimeSession = this.sessions.get(createSessionId(workspace.id, panel.id));
        return {
          sessionId: createSessionId(workspace.id, panel.id),
          panelId: panel.id,
          title: panel.title,
          command: panel.command,
          launch: panel.launch,
          startup: panel.startup,
          status: runtimeSession?.status || "idle",
        };
      }),
    };
  }

  resolveDefaultSessionId(state, workspaceId = state.activeWorkspaceId || state.activeProjectId) {
    const workspace = findWorkspace(state, workspaceId);
    if (!workspace) {
      return null;
    }

    const activePanelId = workspace.activePanelId
      || workspace.panels.find((panel) => panel.startup !== APP_CONFIG.ui.manualPanelStartup)?.id
      || workspace.panels[0]?.id;
    return activePanelId ? createSessionId(workspace.id, activePanelId) : null;
  }

  ensureSession(state, sessionId) {
    const descriptor = parseSessionId(sessionId);
    if (!descriptor) {
      return null;
    }

    const workspace = findWorkspace(state, descriptor.workspaceId);
    const panel = findPanel(workspace, descriptor.panelId);
    if (!workspace || !panel || isBrowserPanel(panel)) {
      return null;
    }

    const key = createSessionId(workspace.id, panel.id);
    const existing = this.sessions.get(key);
    if (existing && existing.status === "running") {
      return existing;
    }

    const launcher = panel.launch?.file
      ? {
          file: panel.launch.file,
          args: [...(panel.launch.args || [])],
        }
      : shellConfig();

    const processHandle = pty.spawn(launcher.file, launcher.args, {
      name: APP_CONFIG.session.termName,
      cols: APP_CONFIG.session.defaultCols,
      rows: APP_CONFIG.session.defaultRows,
      cwd: workspace.cwd,
      env: {
        ...process.env,
        TERM_PROGRAM: APP_CONFIG.session.termProgram,
        FORCE_COLOR: APP_CONFIG.session.forceColor,
      },
    });

    const session = {
      id: key,
      workspaceId: workspace.id,
      panelId: panel.id,
      title: panel.title,
      command: panel.command,
      cols: existing?.cols || APP_CONFIG.session.defaultCols,
      rows: existing?.rows || APP_CONFIG.session.defaultRows,
      status: "running",
      processHandle,
    };

    processHandle.onData((data) => {
      this.emit("terminal:data", { sessionId: session.id, data });
    });

    processHandle.onExit(({ exitCode }) => {
      session.status = "exited";
      session.processHandle = null;
      this.emit("terminal:exit", { sessionId: session.id, exitCode, intentional: this.consumeSuppressedExit(session.id) });
    });

    this.sessions.set(key, session);

    if (!panel.launch?.file && panel.command) {
      setTimeout(() => {
        if (session.status === "running" && session.processHandle) {
          session.processHandle.write(`${panel.command}\r`);
        }
      }, APP_CONFIG.session.shellLaunchDelayMs);
    }

    return session;
  }

  resizeSession(sessionId, cols, rows) {
    const session = this.sessions.get(sessionId);
    if (!session || session.status !== "running" || !session.processHandle) {
      return;
    }

    session.cols = cols;
    session.rows = rows;
    session.processHandle.resize(
      Math.max(cols, APP_CONFIG.session.minCols),
      Math.max(rows, APP_CONFIG.session.minRows),
    );
  }

  writeToSession(sessionId, data) {
    const session = this.sessions.get(sessionId);
    if (!session || session.status !== "running" || !session.processHandle) {
      return;
    }

    session.processHandle.write(data);
  }

  async restartSession(state, sessionId) {
    const current = this.sessions.get(sessionId);
    if (current?.processHandle) {
      const processHandle = current.processHandle;
      this.suppressNextExit(sessionId);
      processHandle.kill();
      await once(processHandle, "exit").catch(() => {});
    }

    this.sessions.delete(sessionId);
    return this.ensureSession(state, sessionId);
  }

  removeSession(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return;
    }
    if (session.processHandle) {
      this.suppressNextExit(sessionId);
      session.processHandle.kill();
    }
    this.sessions.delete(sessionId);
  }

  removeWorkspaceSessions(workspaceId) {
    for (const [sessionId, session] of this.sessions.entries()) {
      if (session.workspaceId !== workspaceId) {
        continue;
      }

      if (session.processHandle) {
        this.suppressNextExit(sessionId);
        session.processHandle.kill();
      }
      this.sessions.delete(sessionId);
    }
  }

  syncWithState(state) {
    const validSessionIds = new Set();
    for (const workspace of (state.workspaces || state.projects || [])) {
      for (const panel of workspace.panels) {
        validSessionIds.add(createSessionId(workspace.id, panel.id));
      }
    }

    for (const [sessionId, session] of this.sessions.entries()) {
      if (validSessionIds.has(sessionId)) {
        continue;
      }

      if (session.processHandle) {
        this.suppressNextExit(sessionId);
        session.processHandle.kill();
      }
      this.sessions.delete(sessionId);
    }
  }

  stopAll() {
    for (const [sessionId, session] of this.sessions.entries()) {
      if (session.processHandle) {
        this.suppressNextExit(sessionId);
        session.processHandle.kill();
      }
    }
    this.sessions.clear();
    this.suppressedExits.clear();
  }

  // Backward-compatible alias while runtime migration completes.
  removeProjectSessions(workspaceId) {
    this.removeWorkspaceSessions(workspaceId);
  }
}
