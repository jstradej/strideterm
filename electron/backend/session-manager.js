import { EventEmitter, once } from "node:events";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pty from "node-pty";
import { createSessionId, parseSessionId } from "./default-state.js";
import { APP_CONFIG } from "../../config/app-config.js";
import { getLogger } from "./logger.js";

const log = getLogger("session-mgr");

const SHELL_INTEGRATION_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../config/shell-integration",
);

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

function shellBasename(filePath) {
  return path
    .basename(filePath || "")
    .toLowerCase()
    .replace(/\.exe$/, "");
}

/**
 * Build environment variables that auto-source shell integration scripts.
 * Returns an object of env vars to merge, or {} if integration is disabled
 * or the shell type is not recognized.
 */
export function shellIntegrationEnv(launcherFile, enabled = true, currentEnv = process.env) {
  if (!enabled) {
    return {};
  }
  const base = shellBasename(launcherFile);

  if (base === "bash" || base === "sh") {
    const scriptPath = path.join(SHELL_INTEGRATION_DIR, "bash.sh");
    return {
      STRIDETERM_SHELL_INTEGRATION: "1",
      BASH_ENV: scriptPath,
      // Preserve existing PROMPT_COMMAND while injecting our integration source.
      PROMPT_COMMAND: `source "${scriptPath}"` + (currentEnv.PROMPT_COMMAND ? `; ${currentEnv.PROMPT_COMMAND}` : ""),
    };
  }

  if (base === "zsh") {
    const scriptPath = path.join(SHELL_INTEGRATION_DIR, "zsh.sh");
    return {
      STRIDETERM_SHELL_INTEGRATION: "1",
      STRIDETERM_SHELL_INTEGRATION_SCRIPT: scriptPath,
      ...(currentEnv.ZDOTDIR ? { __STRIDETERM_ORIGINAL_ZDOTDIR: currentEnv.ZDOTDIR } : {}),
    };
  }

  if (base === "pwsh" || base === "powershell") {
    const scriptPath = path.join(SHELL_INTEGRATION_DIR, "pwsh.ps1");
    return {
      STRIDETERM_SHELL_INTEGRATION: "1",
      STRIDETERM_SHELL_INTEGRATION_SCRIPT: scriptPath,
    };
  }

  return {};
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
  constructor({ getSessionEnv = null, getSessionLaunch = null } = {}) {
    super();
    this.sessions = new Map();
    this.suppressedExits = new Map();
    this.getSessionEnv = typeof getSessionEnv === "function" ? getSessionEnv : null;
    this.getSessionLaunch = typeof getSessionLaunch === "function" ? getSessionLaunch : null;
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
      sessions: workspace.panels
        .filter((panel) => !isBrowserPanel(panel))
        .map((panel) => {
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

    const activePanelId =
      workspace.activePanelId ||
      workspace.panels.find((panel) => panel.startup !== APP_CONFIG.ui.manualPanelStartup)?.id ||
      workspace.panels[0]?.id;
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

    const launchOverride =
      this.getSessionLaunch?.({
        state,
        workspace,
        panel,
        sessionId: key,
      }) || null;

    const launcher = launchOverride?.file
      ? {
          file: launchOverride.file,
          args: [...(launchOverride.args || [])],
        }
      : panel.launch?.file
        ? {
            file: panel.launch.file,
            args: [...(panel.launch.args || [])],
          }
        : shellConfig();

    const shellIntEnabled = state.settings?.notifications?.shellIntegration !== false;
    const integrationEnv = shellIntegrationEnv(launcher.file, shellIntEnabled);

    log.debug("spawning session", {
      sessionId: key,
      file: launcher.file,
      args: launcher.args,
      cwd: launchOverride?.cwd || workspace.cwd,
      shellIntegration: shellIntEnabled,
    });

    const processHandle = pty.spawn(launcher.file, launcher.args, {
      name: APP_CONFIG.session.termName,
      cols: APP_CONFIG.session.defaultCols,
      rows: APP_CONFIG.session.defaultRows,
      cwd: launchOverride?.cwd || workspace.cwd,
      env: {
        ...process.env,
        ...integrationEnv,
        TERM_PROGRAM: APP_CONFIG.session.termProgram,
        FORCE_COLOR: APP_CONFIG.session.forceColor,
        ...(this.getSessionEnv?.({
          state,
          workspace,
          panel,
          sessionId: key,
        }) || {}),
        ...(launchOverride?.env || {}),
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
      const intentional = this.consumeSuppressedExit(session.id);
      log.debug("session exited", { sessionId: session.id, exitCode, intentional });
      this.emit("terminal:exit", {
        sessionId: session.id,
        exitCode,
        intentional,
      });
    });

    this.sessions.set(key, session);

    const injectedCommand =
      typeof launchOverride?.command === "string" && launchOverride.command.trim()
        ? launchOverride.command
        : !panel.launch?.file && !launchOverride?.file
          ? panel.command
          : "";

    // Auto-source shell integration for zsh and PowerShell.
    // Bash is handled via PROMPT_COMMAND env var; these shells need explicit sourcing.
    const integrationScript = integrationEnv.STRIDETERM_SHELL_INTEGRATION_SCRIPT;
    if (integrationScript && session.status === "running" && session.processHandle) {
      const base = shellBasename(launcher.file);
      let sourceCmd = "";
      if (base === "zsh") {
        sourceCmd = `source "${integrationScript}"`;
      } else if (base === "pwsh" || base === "powershell") {
        sourceCmd = `. "${integrationScript}"`;
      }
      if (sourceCmd) {
        setTimeout(
          () => {
            if (session.status === "running" && session.processHandle) {
              session.processHandle.write(`${sourceCmd}\r`);
            }
          },
          Math.max(APP_CONFIG.session.shellLaunchDelayMs - 10, 10),
        );
      }
    }

    if (!launchOverride?.skipCommandInjection && injectedCommand) {
      setTimeout(() => {
        if (session.status === "running" && session.processHandle) {
          session.processHandle.write(`${injectedCommand}\r`);
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
    try {
      session.processHandle.resize(
        Math.max(cols, APP_CONFIG.session.minCols),
        Math.max(rows, APP_CONFIG.session.minRows),
      );
    } catch (error) {
      log.warn("resize failure", { sessionId, err: error?.message || String(error) });
    }
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
    const exitPromises = [];
    for (const [sessionId, session] of this.sessions.entries()) {
      if (session.workspaceId !== workspaceId) {
        continue;
      }

      if (session.processHandle) {
        this.suppressNextExit(sessionId);
        const handle = session.processHandle;
        exitPromises.push(
          new Promise((resolve) => {
            const timeout = setTimeout(resolve, 5000);
            handle.onExit(() => {
              clearTimeout(timeout);
              resolve();
            });
          }),
        );
        handle.kill();
      }
      this.sessions.delete(sessionId);
    }
    return exitPromises.length ? Promise.all(exitPromises) : Promise.resolve();
  }

  syncWithState(state) {
    const validSessionIds = new Set();
    for (const workspace of state.workspaces || state.projects || []) {
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
