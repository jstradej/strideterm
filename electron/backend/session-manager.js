import { EventEmitter, once } from "node:events";
import os from "node:os";
import { promises as fsp } from "node:fs";
import crypto from "node:crypto";
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

async function buildSystemSshArgs(host, credentialStore, { distro = null, sshManager = null } = {}) {
  const args = [];
  if (host.port && host.port !== 22) args.push("-p", String(host.port));
  if (host.username) args.push("-l", host.username);

  if (host.hostKeyPolicy === "strict") {
    args.push("-o", "StrictHostKeyChecking=yes");
  } else if (host.hostKeyPolicy === "accept-new") {
    args.push("-o", "StrictHostKeyChecking=accept-new");
  } else {
    args.push("-o", "StrictHostKeyChecking=accept-new");
  }

  // ProxyJump chain — resolve jump host ids to `user@host:port` strings so
  // system ssh handles the chain itself. Only possible when we have a manager
  // to look up host entries; otherwise skip.
  if (sshManager && Array.isArray(host.jump) && host.jump.length > 0) {
    const chain = [];
    for (const jumpId of host.jump) {
      const j = sshManager.getHost(jumpId);
      if (!j) continue;
      const port = j.port && j.port !== 22 ? `:${j.port}` : "";
      chain.push(`${j.username || "root"}@${j.host}${port}`);
    }
    if (chain.length) args.push("-J", chain.join(","));
  }

  let cleanupFn = async () => {};

  if (host.auth && host.auth.keyRef) {
    const privKey = credentialStore.getSecret(host.auth.keyRef);
    if (privKey) {
      const randomId = crypto.randomBytes(8).toString("hex");

      if (distro) {
        // Writing into the WSL filesystem via UNC respects POSIX permissions;
        // /mnt/c/... mounts ignore chmod and `ssh` refuses 0777 keys.
        const tmpPath = `\\\\wsl$\\${distro}\\tmp\\strideterm-ssh-${randomId}`;
        await fsp.writeFile(tmpPath, privKey, { mode: 0o600 });
        cleanupFn = async () => {
          try {
            await fsp.unlink(tmpPath);
          } catch {}
        };
        args.push("-i", `/tmp/strideterm-ssh-${randomId}`);
      } else {
        const tmpPath = path.join(os.tmpdir(), `strideterm-ssh-${randomId}`);
        await fsp.writeFile(tmpPath, privKey, { mode: 0o600 });
        cleanupFn = async () => {
          try {
            await fsp.unlink(tmpPath);
          } catch {}
        };
        args.push("-i", tmpPath);
      }
    }
  }

  args.push(host.host);
  if (host.advanced?.command) {
    args.push(host.advanced.command);
  }

  return { args, cleanupFn };
}

export class SessionManager extends EventEmitter {
  constructor({ getSessionEnv = null, getSessionLaunch = null, sshManager = null } = {}) {
    super();
    this.sessions = new Map();
    this.suppressedExits = new Map();
    this.getSessionEnv = typeof getSessionEnv === "function" ? getSessionEnv : null;
    this.getSessionLaunch = typeof getSessionLaunch === "function" ? getSessionLaunch : null;
    this.sshManager = sshManager || null;
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

  async ensureSession(state, sessionId) {
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

    if (panel.launch?.kind === "ssh") {
      if (!this.sshManager) {
        log.warn("SSH panel launched but sshManager is not wired", { sessionId: key });
        return null;
      }
      // Resolve to a host definition: saved host book entry OR the panel's
      // inline ad-hoc config. Inline wins if both are present (shouldn't
      // happen, but quick-connect editing could leave both temporarily).
      let host;
      if (panel.launch.sshInline) {
        host = { id: `inline:${key}`, jump: [], ...panel.launch.sshInline };
      } else if (panel.launch.sshHostId) {
        host = this.sshManager.getHost(panel.launch.sshHostId);
        if (!host) {
          log.warn("SSH host not found for panel", { sessionId: key, hostId: panel.launch.sshHostId });
          return null;
        }
      } else {
        log.warn("SSH panel has neither sshHostId nor sshInline", { sessionId: key });
        return null;
      }

      const mode = host.advanced?.launchVia || "ssh2";
      if (mode === "system-ssh") return this.ensureSystemSshSession(state, workspace, panel, key, host);
      if (mode === "wsl") return this.ensureWslSshSession(state, workspace, panel, key, host);
      return this.ensureSshSession(state, workspace, panel, key, host);
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
      cwd: launchOverride?.cwd || panel.cwd || workspace.cwd,
      shellIntegration: shellIntEnabled,
    });

    const processHandle = pty.spawn(launcher.file, launcher.args, {
      name: APP_CONFIG.session.termName,
      cols: APP_CONFIG.session.defaultCols,
      rows: APP_CONFIG.session.defaultRows,
      cwd: launchOverride?.cwd || panel.cwd || workspace.cwd,
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

  async registerProcessSession(sessionId, workspace, panel, processHandle, meta) {
    const existing = this.sessions.get(sessionId);
    const session = {
      id: sessionId,
      workspaceId: workspace.id,
      panelId: panel.id,
      title: panel.title,
      command: panel.command,
      cols: existing?.cols || APP_CONFIG.session.defaultCols,
      rows: existing?.rows || APP_CONFIG.session.defaultRows,
      status: "running",
      processHandle,
      ...meta,
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
      if (meta.cleanupFn) {
        meta.cleanupFn().catch((err) => log.warn("ssh key cleanup error", { err }));
      }
    });

    this.sessions.set(sessionId, session);
    return session;
  }

  async ensureSystemSshSession(state, workspace, panel, sessionId, host) {
    const existing = this.sessions.get(sessionId);
    if (existing && existing.status === "running") return existing;

    const { args, cleanupFn } = await buildSystemSshArgs(host, this.sshManager.credentialStore, {
      sshManager: this.sshManager,
    });
    const sshExec = APP_CONFIG.ssh.systemSshPath || "ssh";

    log.debug("spawning system-ssh session", { sessionId, host: host.host, user: host.username });

    let processHandle;
    try {
      processHandle = pty.spawn(sshExec, args, {
        name: APP_CONFIG.session.termName,
        cols: APP_CONFIG.session.defaultCols,
        rows: APP_CONFIG.session.defaultRows,
        cwd: os.homedir(),
        env: { ...process.env, ...(host.advanced?.env || {}) },
      });
    } catch (err) {
      log.warn("system-ssh spawn failed", { sessionId, exec: sshExec, error: err?.message || String(err) });
      try {
        cleanupFn?.();
      } catch {
        // best effort
      }
      this.emit("terminal:data", {
        sessionId,
        data:
          `\r\n\x1b[31m✗ Failed to launch system ssh (${sshExec}): ${err?.message || err}\x1b[0m\r\n` +
          `\x1b[90m  Check Settings → SSH → System SSH Binary Path, or install the OpenSSH client.\x1b[0m\r\n`,
      });
      return null;
    }

    return this.registerProcessSession(sessionId, workspace, panel, processHandle, {
      kind: "ssh-system",
      cleanupFn,
    });
  }

  async ensureWslSshSession(state, workspace, panel, sessionId, host) {
    const existing = this.sessions.get(sessionId);
    if (existing && existing.status === "running") return existing;

    if (process.platform !== "win32") {
      this.emit("terminal:data", {
        sessionId,
        data: "\r\n\x1b[31m✗ WSL launch mode is Windows-only\x1b[0m\r\n",
      });
      return null;
    }

    const distro = host.advanced?.wsl?.distro || APP_CONFIG.ssh.wslDefaultDistro || null;
    const wslUser = host.advanced?.wsl?.user;
    const innerExec = host.advanced?.wsl?.exec || APP_CONFIG.ssh.wslSshExec || "ssh";

    const { args: sshArgs, cleanupFn } = await buildSystemSshArgs(host, this.sshManager.credentialStore, {
      distro,
      sshManager: this.sshManager,
    });

    const args = [];
    if (distro) args.push("-d", distro);
    if (wslUser) args.push("-u", wslUser);
    args.push("--", innerExec, ...sshArgs);

    log.debug("spawning wsl ssh session", { sessionId, distro, host: host.host });

    let processHandle;
    try {
      processHandle = pty.spawn("wsl.exe", args, {
        name: APP_CONFIG.session.termName,
        cols: APP_CONFIG.session.defaultCols,
        rows: APP_CONFIG.session.defaultRows,
        cwd: os.homedir(),
        env: { ...process.env, WSL_UTF8: "1" },
      });
    } catch (err) {
      log.warn("wsl ssh spawn failed", { sessionId, error: err?.message || String(err) });
      try {
        cleanupFn?.();
      } catch {
        // best effort
      }
      this.emit("terminal:data", {
        sessionId,
        data:
          `\r\n\x1b[31m✗ Failed to launch wsl.exe: ${err?.message || err}\x1b[0m\r\n` +
          `\x1b[90m  Is WSL installed? Run \`wsl --list\` to verify distributions.\x1b[0m\r\n`,
      });
      return null;
    }

    return this.registerProcessSession(sessionId, workspace, panel, processHandle, {
      kind: "ssh-wsl",
      wslDistro: distro,
      cleanupFn,
    });
  }

  async ensureSshSession(state, workspace, panel, sessionId, host) {
    const existing = this.sessions.get(sessionId);
    if (existing && existing.status === "running") {
      return existing;
    }

    const session = {
      id: sessionId,
      workspaceId: workspace.id,
      panelId: panel.id,
      title: panel.title,
      command: panel.command,
      cols: APP_CONFIG.session.defaultCols,
      rows: APP_CONFIG.session.defaultRows,
      status: "running",
      kind: "ssh",
      processHandle: null,
      sshHostId: panel.launch.sshHostId || null,
      sshInline: Boolean(panel.launch.sshInline),
    };

    // Pick the right argument shape for SshManager: saved host by id, or
    // caller-provided host object for inline ad-hoc.
    const createArgs = {
      sessionId,
      cols: session.cols,
      rows: session.rows,
      onData: (data) => this.emit("terminal:data", { sessionId, data }),
      onExit: ({ exitCode }) => {
        session.status = "exited";
        const intentional = this.consumeSuppressedExit(sessionId);
        this.emit("terminal:exit", { sessionId, exitCode, intentional });
      },
    };
    if (panel.launch.sshInline) {
      createArgs.inlineHost = panel.launch.sshInline;
    } else {
      createArgs.hostId = panel.launch.sshHostId;
    }

    try {
      await this.sshManager.createSession(createArgs);
    } catch (err) {
      // SshManager already surfaces the failure via the "ssh:connection-state"
      // event and an inline red banner in the terminal — no need to crash the
      // caller (which is frequently a fire-and-forget `ensureSession` from
      // workspace activation). Swallow the rejection here to prevent
      // UnhandledPromiseRejectionWarning while still logging for diagnostics.
      log.warn("SSH session start failed", { sessionId, error: err?.message || String(err) });
      return null;
    }
    // Quiet the unused-var lint — host is pre-resolved by ensureSession for
    // logging symmetry with system-ssh/wsl branches; SshManager re-resolves
    // from id or inlineHost itself.
    void host;

    this.sessions.set(sessionId, session);
    return session;
  }

  resizeSession(sessionId, cols, rows) {
    const session = this.sessions.get(sessionId);
    if (!session || session.status !== "running") {
      return;
    }

    session.cols = cols;
    session.rows = rows;

    if (session.kind === "ssh") {
      this.sshManager?.resize(sessionId, cols, rows);
      return;
    }

    if (!session.processHandle) return;

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
    if (!session || session.status !== "running") {
      return;
    }

    if (session.kind === "ssh") {
      this.sshManager?.write(sessionId, data);
      return;
    }

    if (!session.processHandle) return;

    session.processHandle.write(data);
  }

  async restartSession(state, sessionId) {
    const current = this.sessions.get(sessionId);
    if (current?.kind === "ssh") {
      await this.sshManager?.stop(sessionId);
    } else if (current?.processHandle) {
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

    if (session.kind === "ssh") {
      this.sshManager?.stop(sessionId).catch(() => {});
      // Banner so Disconnect-SSH has visible feedback — otherwise the tab
      // just looks the same as before.
      this.emit("terminal:data", {
        sessionId,
        data: "\r\n\x1b[90m── Disconnected by user\x1b[0m\r\n",
      });
    } else if (session.processHandle) {
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

      if (session.kind === "ssh") {
        exitPromises.push(this.sshManager?.stop(sessionId).catch(() => {}));
      } else if (session.processHandle) {
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

      if (session.kind === "ssh") {
        this.sshManager?.stop(sessionId).catch(() => {});
      } else if (session.processHandle) {
        this.suppressNextExit(sessionId);
        session.processHandle.kill();
      }
      this.sessions.delete(sessionId);
    }
  }

  stopAll() {
    for (const [sessionId, session] of this.sessions.entries()) {
      if (session.kind === "ssh") {
        this.sshManager?.stop(sessionId).catch(() => {});
      } else if (session.processHandle) {
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
