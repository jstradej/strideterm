/// <reference types="node" />
import { EventEmitter } from "node:events";
import os from "node:os";
import { promises as fsp, existsSync } from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pty from "node-pty";
import type { IPty } from "node-pty";
import { Effect, Exit, Scope } from "effect";
import { createSessionId, parseSessionId } from "./default-state.js";
import type { AppState, WorkspaceState, PanelState } from "../shared/types/state.js";
import { APP_CONFIG } from "../../config/app-config.js";
import { getLogger } from "./logger.js";
import { runEffect } from "./effect/runtime.js";
import { PtySpawnError } from "./effect/errors/session-errors.js";
import { tryDirectShellSpawn } from "./direct-shell-spawn.js";
import { applyShellIntegrationLaunch } from "./shell-integration-launch.js";
import type { SshManager } from "./ssh/ssh-manager.js";

const log = getLogger("session-mgr");

/**
 * Resolves the directory containing shell-integration rc scripts. These
 * scripts are sourced by the user's shell (bash/zsh/pwsh) inside the PTY,
 * so the path **must** point to a real on-disk file — paths inside
 * `app.asar/` cannot be sourced (the shell can't read into asar archives
 * and bails with "not a directory").
 *
 * Resolution order:
 *  1. `STRIDETERM_RESOURCES_DIR` env var (set by main.ts; in packaged apps
 *     this is `process.resourcesPath`, where extraResources land).
 *  2. Walk up from this module to the nearest dir that has both
 *     `package.json` and `config/shell-integration/`. Works for TS source,
 *     compiled `dist-electron/`, and tests run from anywhere in the tree.
 *  3. Last-resort static fallback.
 */
function getShellIntegrationDir(): string {
  if (process.env.STRIDETERM_RESOURCES_DIR) {
    return path.join(process.env.STRIDETERM_RESOURCES_DIR, "config", "shell-integration");
  }
  let dir = path.dirname(fileURLToPath(import.meta.url));
  while (dir !== path.dirname(dir)) {
    const candidate = path.join(dir, "config", "shell-integration");
    if (existsSync(candidate)) return candidate;
    dir = path.dirname(dir);
  }
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../config/shell-integration");
}

// ------ Internal types -------

type SessionStatus = "running" | "exited" | "idle";

interface SessionBase {
  id: string;
  workspaceId: string;
  panelId: string;
  title: string;
  command: string;
  cols: number;
  rows: number;
  status: SessionStatus;
}

interface PtySession extends SessionBase {
  kind?: string;
  processHandle: IPty | null;
  cleanupFn?: () => Promise<void>;
  wslDistro?: string | null;
}

interface SshSession extends SessionBase {
  kind: "ssh";
  processHandle: null;
  sshHostId: string | null;
  sshInline: boolean;
}

type RuntimeSession = PtySession | SshSession;

interface SessionEnvContext {
  state: AppState;
  workspace: WorkspaceState;
  panel: PanelState;
  sessionId: string;
}

interface SessionLaunchOverride {
  file?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  command?: string;
  skipCommandInjection?: boolean;
}

interface SessionManagerOpts {
  getSessionEnv?: ((ctx: SessionEnvContext) => Record<string, string>) | null;
  getSessionLaunch?: ((ctx: SessionEnvContext) => SessionLaunchOverride | null) | null;
  sshManager?: SshManager | null;
}

// Loosely-typed host record from ssh-manager (not exported from that module)
interface HostRecord {
  id: string;
  host: string;
  port?: number;
  username?: string;
  jump?: string[];
  auth?: {
    keyRef?: string;
    [key: string]: unknown;
  };
  advanced?: {
    command?: string;
    launchVia?: string;
    env?: Record<string, string>;
    wsl?: {
      distro?: string;
      user?: string;
      exec?: string;
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    [key: string]: any;
  };
  hostKeyPolicy?: string;
}

// ------ Helper functions -------

function shellConfig(): { file: string; args: string[] } {
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

function shellBasename(filePath: string): string {
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
export function shellIntegrationEnv(
  launcherFile: string,
  enabled = true,
  currentEnv: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  if (!enabled) {
    return {};
  }
  const base = shellBasename(launcherFile);

  if (base === "bash" || base === "sh") {
    const scriptPath = path.join(getShellIntegrationDir(), "bash.sh");
    return {
      STRIDETERM_SHELL_INTEGRATION: "1",
      BASH_ENV: scriptPath,
      // Preserve existing PROMPT_COMMAND while injecting our integration source.
      PROMPT_COMMAND: `source "${scriptPath}"` + (currentEnv.PROMPT_COMMAND ? `; ${currentEnv.PROMPT_COMMAND}` : ""),
    };
  }

  if (base === "zsh") {
    const scriptPath = path.join(getShellIntegrationDir(), "zsh.sh");
    return {
      STRIDETERM_SHELL_INTEGRATION: "1",
      STRIDETERM_SHELL_INTEGRATION_SCRIPT: scriptPath,
      ...(currentEnv.ZDOTDIR ? { __STRIDETERM_ORIGINAL_ZDOTDIR: currentEnv.ZDOTDIR } : {}),
    };
  }

  if (base === "pwsh" || base === "powershell") {
    const scriptPath = path.join(getShellIntegrationDir(), "pwsh.ps1");
    return {
      STRIDETERM_SHELL_INTEGRATION: "1",
      STRIDETERM_SHELL_INTEGRATION_SCRIPT: scriptPath,
    };
  }

  return {};
}

function findWorkspace(state: AppState, workspaceId: string): WorkspaceState | null {
  const workspaces = state.workspaces || state.projects || [];
  return workspaces.find((workspace) => workspace.id === workspaceId) ?? null;
}

function findPanel(workspace: WorkspaceState | null, panelId: string): PanelState | null {
  return workspace?.panels.find((panel) => panel.id === panelId) ?? null;
}

function isBrowserPanel(panel: PanelState | null): boolean {
  return panel != null && /^https?:\/\//i.test(panel.command || "");
}

interface BuildSshArgsOpts {
  distro?: string | null;
  sshManager?: SshManager | null;
}

interface BuildSshArgsResult {
  args: string[];
  cleanupFn: () => Promise<void>;
}

// Acquires a temporary SSH private-key file and releases (deletes) it when
// the enclosing Effect Scope closes.  The returned object has the filesystem
// path (for passing to ssh -i) and a POSIX alias when writing into WSL UNC.
function acquireSshKeyFile(privKey: string, distro: string | null) {
  const randomId = crypto.randomBytes(8).toString("hex");
  if (distro) {
    const tmpPath = `\\\\wsl$\\${distro}\\tmp\\strideterm-ssh-${randomId}`;
    const posixPath = `/tmp/strideterm-ssh-${randomId}`;
    return Effect.acquireRelease(
      Effect.promise(() => fsp.writeFile(tmpPath, privKey, { mode: 0o600 }).then(() => ({ tmpPath, posixPath }))),
      ({ tmpPath: p }) => Effect.promise(() => fsp.unlink(p).catch(() => {})),
    );
  }
  const tmpPath = path.join(os.tmpdir(), `strideterm-ssh-${randomId}`);
  return Effect.acquireRelease(
    Effect.promise(() =>
      fsp.writeFile(tmpPath, privKey, { mode: 0o600 }).then(() => ({ tmpPath, posixPath: tmpPath })),
    ),
    ({ tmpPath: p }) => Effect.promise(() => fsp.unlink(p).catch(() => {})),
  );
}

async function buildSystemSshArgs(
  host: HostRecord,
  credentialStore: SshManager["credentialStore"],
  { distro = null, sshManager = null }: BuildSshArgsOpts = {},
): Promise<BuildSshArgsResult> {
  const args: string[] = [];
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
    const chain: string[] = [];
    for (const jumpId of host.jump) {
      const j = sshManager.getHost(jumpId);
      if (!j) continue;
      const port = j.port && j.port !== 22 ? `:${j.port}` : "";
      chain.push(`${j.username || "root"}@${j.host}${port}`);
    }
    if (chain.length) args.push("-J", chain.join(","));
  }

  // SSH key temp file: use Effect.acquireRelease inside a long-lived Scope so
  // cleanup (unlink) runs both on PTY exit and on spawn failure.
  let cleanupFn: () => Promise<void> = async () => {};

  if (host.auth && host.auth.keyRef) {
    const privKey = credentialStore.getSecret(host.auth.keyRef);
    if (privKey) {
      // Create a long-lived scope owned by the caller (ensureSystemSshSession /
      // ensureWslSshSession).  The scope is passed back so it can be closed
      // when the PTY exits or immediately when spawn fails.
      const scope = await runEffect(Scope.make());
      const keyFile = await runEffect(
        acquireSshKeyFile(privKey, distro).pipe(Effect.provideService(Scope.Scope, scope)),
      );
      cleanupFn = () => runEffect(Scope.close(scope, Exit.void));
      args.push("-i", keyFile.posixPath);
    }
  }

  args.push(host.host);
  if (host.advanced?.command) {
    args.push(host.advanced.command);
  }

  return { args, cleanupFn };
}

// ------ SessionManager -------

export class SessionManager extends EventEmitter {
  sessions: Map<string, RuntimeSession>;
  startingSessions: Map<string, Promise<RuntimeSession | null>>;
  suppressedExits: Map<string, number>;
  getSessionEnv: ((ctx: SessionEnvContext) => Record<string, string>) | null;
  getSessionLaunch: ((ctx: SessionEnvContext) => SessionLaunchOverride | null) | null;
  sshManager: SshManager | null;

  constructor({ getSessionEnv = null, getSessionLaunch = null, sshManager = null }: SessionManagerOpts = {}) {
    super();
    this.sessions = new Map();
    this.startingSessions = new Map();
    this.suppressedExits = new Map();
    this.getSessionEnv = typeof getSessionEnv === "function" ? getSessionEnv : null;
    this.getSessionLaunch = typeof getSessionLaunch === "function" ? getSessionLaunch : null;
    this.sshManager = sshManager || null;
  }

  async trackSessionStart(
    sessionId: string,
    start: () => Promise<RuntimeSession | null>,
  ): Promise<RuntimeSession | null> {
    const pending = this.startingSessions.get(sessionId);
    if (pending) {
      return pending;
    }

    const started = start();
    this.startingSessions.set(sessionId, started);
    try {
      return await started;
    } finally {
      if (this.startingSessions.get(sessionId) === started) {
        this.startingSessions.delete(sessionId);
      }
    }
  }

  suppressNextExit(sessionId: string): void {
    this.suppressedExits.set(sessionId, (this.suppressedExits.get(sessionId) || 0) + 1);
  }

  consumeSuppressedExit(sessionId: string): boolean {
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

  getWorkspace(
    state: AppState,
    workspaceId: string = state.activeWorkspaceId || state.activeProjectId || "",
  ): {
    workspace: WorkspaceState;
    project: WorkspaceState;
    sessions: Array<{
      sessionId: string;
      panelId: string;
      title: string;
      command: string;
      launch: PanelState["launch"];
      startup: string | undefined;
      status: SessionStatus | "idle";
    }>;
  } | null {
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

  resolveDefaultSessionId(
    state: AppState,
    workspaceId: string = state.activeWorkspaceId || state.activeProjectId || "",
  ): string | null {
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

  async ensureSession(state: AppState, sessionId: string): Promise<RuntimeSession | null> {
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
      return this.trackSessionStart(key, async () => {
        if (!this.sshManager) {
          log.warn("SSH panel launched but sshManager is not wired", { sessionId: key });
          return null;
        }
        // Resolve to a host definition: saved host book entry OR the panel's
        // inline ad-hoc config. Inline wins if both are present (shouldn't
        // happen, but quick-connect editing could leave both temporarily).
        let host: HostRecord | undefined;
        if (panel.launch?.sshInline) {
          host = { id: `inline:${key}`, jump: [], ...panel.launch.sshInline } as unknown as HostRecord;
        } else if (panel.launch?.sshHostId) {
          host = this.sshManager.getHost(panel.launch.sshHostId) as HostRecord | undefined;
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
      });
    }

    const launchOverride =
      this.getSessionLaunch?.({
        state,
        workspace,
        panel,
        sessionId: key,
      }) || null;

    // If panel.command is a bare shell invocation (e.g. `wsl -- bash -lic "…"`,
    // `pwsh -NoLogo`, `bash --login`), spawn that shell as the direct PTY
    // child instead of typing the command into the OS default shell. Avoids
    // the double-PTY layering (ConPTY → default shell → wsl/pwsh/…) that
    // breaks SIGWINCH propagation on Windows — inner shell would otherwise
    // stick at the default 80×24 and `tput lines` would lie.
    const directShellLauncher =
      !launchOverride?.file && !panel.launch?.file ? tryDirectShellSpawn(panel.command) : null;

    let launcher: { file: string; args: string[] } = launchOverride?.file
      ? {
          file: launchOverride.file,
          args: [...(launchOverride.args || [])],
        }
      : panel.launch?.file
        ? {
            file: panel.launch.file,
            args: [...(panel.launch.args || [])],
          }
        : (directShellLauncher ?? shellConfig());

    const shellIntEnabled = state.settings?.notifications?.shellIntegration !== false;
    const baseIntegrationEnv = shellIntegrationEnv(launcher.file, shellIntEnabled);
    // Wire shell-integration into the launcher in the cleanest per-shell way:
    //  - bash/sh: BASH_ENV already invisible, no change
    //  - zsh: ZDOTDIR loader (replaces the visible typed `source <path>`)
    //  - pwsh/powershell: -NoExit -Command "& '<path>'" args (replaces visible `.`)
    // The result tells us whether to skip the legacy typed-source block below.
    const integrationLaunch = applyShellIntegrationLaunch(launcher, baseIntegrationEnv);
    launcher = integrationLaunch.launcher;
    const integrationEnv = integrationLaunch.env;
    const skipTypedSource = integrationLaunch.skipTypedSource;

    // Validate cwd before handing it to pty.spawn — on Windows an invalid
    // cwd produces a cryptic "Cannot create process, error code: 267"
    // (ERROR_DIRECTORY) and the panel stays empty with no obvious hint why.
    // Fallback to the user's home so the shell at least opens; the warning
    // banner below tells the user which dir was missing.
    const requestedCwd = launchOverride?.cwd || panel.cwd || workspace.cwd || "";
    const cwdMissing = requestedCwd && !existsSync(requestedCwd);
    if (cwdMissing) {
      log.error("session cwd missing — falling back to home", {
        sessionId: key,
        requestedCwd,
        fallbackCwd: os.homedir(),
      });
    }
    const effectiveCwd = cwdMissing ? os.homedir() : requestedCwd;

    log.debug("spawning session", {
      sessionId: key,
      file: launcher.file,
      args: launcher.args,
      cwd: effectiveCwd,
      shellIntegration: shellIntEnabled,
    });

    let processHandle: IPty;
    try {
      processHandle = pty.spawn(launcher.file, launcher.args, {
        name: APP_CONFIG.session.termName,
        cols: APP_CONFIG.session.defaultCols,
        rows: APP_CONFIG.session.defaultRows,
        cwd: effectiveCwd,
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
    } catch (error: unknown) {
      const message = (error as Error)?.message || String(error);
      // Logged at error level: a failed spawn leaves the panel showing "0 running"
      // with an empty terminal viewport — visible to the user, so they deserve
      // to see it in the log even when the level is set to "error".
      log.error("PTY spawn failed", { sessionId: key, file: launcher.file, err: message });
      this.emit("terminal:data", {
        sessionId: key,
        data: `\r\n\x1b[31mFailed to launch terminal: ${message}\x1b[0m\r\n`,
      });
      return null;
    }

    const session: PtySession = {
      id: key,
      workspaceId: workspace.id,
      panelId: panel.id,
      title: panel.title,
      command: panel.command,
      cols: (existing as PtySession | undefined)?.cols || APP_CONFIG.session.defaultCols,
      rows: (existing as PtySession | undefined)?.rows || APP_CONFIG.session.defaultRows,
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

    if (cwdMissing) {
      // Surface the fallback in the terminal viewport so the user sees why
      // their prompt opened in $HOME instead of the workspace's cwd.
      setTimeout(
        () => {
          this.emit("terminal:data", {
            sessionId: key,
            data: `\r\n\x1b[33mWarning: workspace cwd "${requestedCwd}" does not exist — opened in ${effectiveCwd}.\x1b[0m\r\n`,
          });
        },
        Math.max(APP_CONFIG.session.shellLaunchDelayMs - 10, 10),
      );
    }

    const injectedCommand =
      typeof launchOverride?.command === "string" && launchOverride.command.trim()
        ? launchOverride.command
        : !panel.launch?.file && !launchOverride?.file && !directShellLauncher
          ? panel.command
          : "";

    // Fallback typed-source path. Only fires for shells we don't know how to
    // integrate cleanly (i.e. neither bash/sh via BASH_ENV, nor zsh via
    // ZDOTDIR loader, nor pwsh via -Command). applyShellIntegrationLaunch
    // returns skipTypedSource=false only in that defensive case.
    const integrationScript = integrationEnv.STRIDETERM_SHELL_INTEGRATION_SCRIPT;
    if (!skipTypedSource && integrationScript && session.status === "running" && session.processHandle) {
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

  async registerProcessSession(
    sessionId: string,
    workspace: WorkspaceState,
    panel: PanelState,
    processHandle: IPty,
    meta: Partial<PtySession>,
  ): Promise<PtySession> {
    const existing = this.sessions.get(sessionId) as PtySession | undefined;
    const session: PtySession = {
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
        meta
          .cleanupFn()
          .catch((err: unknown) => log.warn("ssh key cleanup error", { err: (err as Error)?.message || String(err) }));
      }
    });

    this.sessions.set(sessionId, session);
    return session;
  }

  async ensureSystemSshSession(
    _state: AppState,
    workspace: WorkspaceState,
    panel: PanelState,
    sessionId: string,
    host: HostRecord,
  ): Promise<RuntimeSession | null> {
    const existing = this.sessions.get(sessionId);
    if (existing && existing.status === "running") return existing;

    const { args, cleanupFn } = await buildSystemSshArgs(host, this.sshManager!.credentialStore, {
      sshManager: this.sshManager,
    });
    const sshExec = APP_CONFIG.ssh.systemSshPath || "ssh";

    log.debug("spawning system-ssh session", { sessionId, host: host.host, user: host.username });

    // Effect-based spawn — PtySpawnError carries typed context; cleanup runs
    // automatically via the scope created in buildSystemSshArgs.
    const spawnResult = await runEffect(
      Effect.tryPromise({
        try: () =>
          Promise.resolve(
            pty.spawn(sshExec, args, {
              name: APP_CONFIG.session.termName,
              cols: APP_CONFIG.session.defaultCols,
              rows: APP_CONFIG.session.defaultRows,
              cwd: os.homedir(),
              env: { ...process.env, ...(host.advanced?.env || {}) },
            }),
          ),
        catch: (err) =>
          new PtySpawnError({
            cmd: sshExec,
            args,
            cause: err,
          }),
      }).pipe(
        Effect.tapError((e) =>
          Effect.sync(() => {
            const causeErr = e.cause as { message?: string; code?: string } | undefined;
            const errMsg = causeErr?.message || String(e.cause) || "spawn failed";
            const isMissing = causeErr?.code === "ENOENT" || /file not found/i.test(errMsg);
            log.warn("system-ssh spawn failed", {
              sessionId,
              exec: sshExec,
              error: errMsg,
              hint: isMissing
                ? `Could not find “${sshExec}” on PATH. Configure Settings → SSH → System SSH Binary Path, or install OpenSSH (Windows: Settings → Apps → Optional features → OpenSSH Client).`
                : undefined,
            });
          }),
        ),
      ),
    ).catch(async (err: unknown) => {
      const msg = (err as { cause?: Error })?.cause?.message ?? String(err);
      await cleanupFn();
      this.emit("terminal:data", {
        sessionId,
        data:
          `\r\n\x1b[31m✗ Failed to launch system ssh (${sshExec}): ${msg}\x1b[0m\r\n` +
          `\x1b[90m  Check Settings → SSH → System SSH Binary Path, or install the OpenSSH client.\x1b[0m\r\n`,
      });
      return null;
    });

    if (!spawnResult) return null;

    return this.registerProcessSession(sessionId, workspace, panel, spawnResult, {
      kind: "ssh-system",
      cleanupFn,
    });
  }

  async ensureWslSshSession(
    _state: AppState,
    workspace: WorkspaceState,
    panel: PanelState,
    sessionId: string,
    host: HostRecord,
  ): Promise<RuntimeSession | null> {
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

    const { args: sshArgs, cleanupFn } = await buildSystemSshArgs(host, this.sshManager!.credentialStore, {
      distro,
      sshManager: this.sshManager,
    });

    const args: string[] = [];
    if (distro) args.push("-d", distro);
    if (wslUser) args.push("-u", wslUser);
    args.push("--", innerExec, ...sshArgs);

    log.debug("spawning wsl ssh session", { sessionId, distro, host: host.host });

    const spawnResult = await runEffect(
      Effect.tryPromise({
        try: () =>
          Promise.resolve(
            pty.spawn("wsl.exe", args, {
              name: APP_CONFIG.session.termName,
              cols: APP_CONFIG.session.defaultCols,
              rows: APP_CONFIG.session.defaultRows,
              cwd: os.homedir(),
              env: { ...process.env, WSL_UTF8: "1" },
            }),
          ),
        catch: (err) =>
          new PtySpawnError({
            cmd: "wsl.exe",
            args,
            cause: err,
          }),
      }).pipe(
        Effect.tapError((e) =>
          Effect.sync(() => {
            log.warn("wsl ssh spawn failed", { sessionId, error: String(e.cause) });
          }),
        ),
      ),
    ).catch(async (err: unknown) => {
      const msg = (err as { cause?: Error })?.cause?.message ?? String(err);
      await cleanupFn();
      this.emit("terminal:data", {
        sessionId,
        data:
          `\r\n\x1b[31m✗ Failed to launch wsl.exe: ${msg}\x1b[0m\r\n` +
          `\x1b[90m  Is WSL installed? Run \`wsl --list\` to verify distributions.\x1b[0m\r\n`,
      });
      return null;
    });

    if (!spawnResult) return null;

    return this.registerProcessSession(sessionId, workspace, panel, spawnResult, {
      kind: "ssh-wsl",
      wslDistro: distro,
      cleanupFn,
    });
  }

  async ensureSshSession(
    _state: AppState,
    workspace: WorkspaceState,
    panel: PanelState,
    sessionId: string,
    host: HostRecord,
  ): Promise<RuntimeSession | null> {
    const existing = this.sessions.get(sessionId);
    if (existing && existing.status === "running") {
      return existing;
    }

    const session: SshSession = {
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
      sshHostId: panel.launch?.sshHostId || null,
      sshInline: Boolean(panel.launch?.sshInline),
    };

    // Pick the right argument shape for SshManager: saved host by id, or
    // caller-provided host object for inline ad-hoc.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const createArgs: any = {
      sessionId,
      cols: session.cols,
      rows: session.rows,
      onData: (data: string) => this.emit("terminal:data", { sessionId, data }),
      onExit: ({ exitCode }: { exitCode: number }) => {
        session.status = "exited";
        const intentional = this.consumeSuppressedExit(sessionId);
        this.emit("terminal:exit", { sessionId, exitCode, intentional });
      },
    };
    if (panel.launch?.sshInline) {
      createArgs.inlineHost = panel.launch.sshInline;
    } else {
      createArgs.hostId = panel.launch?.sshHostId;
    }

    try {
      await this.sshManager!.createSession(createArgs);
    } catch (err: unknown) {
      // SshManager already surfaces the failure via the "ssh:connection-state"
      // event and an inline red banner in the terminal — no need to crash the
      // caller (which is frequently a fire-and-forget `ensureSession` from
      // workspace activation). Swallow the rejection here to prevent
      // UnhandledPromiseRejectionWarning while still logging for diagnostics.
      log.warn("SSH session start failed", { sessionId, error: (err as Error)?.message || String(err) });
      return null;
    }
    // Quiet the unused-var lint — host is pre-resolved by ensureSession for
    // logging symmetry with system-ssh/wsl branches; SshManager re-resolves
    // from id or inlineHost itself.
    void host;

    this.sessions.set(sessionId, session);
    return session;
  }

  resizeSession(sessionId: string, cols: number, rows: number): void {
    const session = this.sessions.get(sessionId);
    if (!session || session.status !== "running") {
      return;
    }

    const nextCols = Math.max(cols, APP_CONFIG.session.minCols);
    const nextRows = Math.max(rows, APP_CONFIG.session.minRows);
    if (
      Math.max(session.cols, APP_CONFIG.session.minCols) === nextCols &&
      Math.max(session.rows, APP_CONFIG.session.minRows) === nextRows
    ) {
      return;
    }

    session.cols = nextCols;
    session.rows = nextRows;

    if (session.kind === "ssh") {
      this.sshManager?.resize(sessionId, nextCols, nextRows);
      return;
    }

    const ptySession = session as PtySession;
    if (!ptySession.processHandle) return;

    try {
      ptySession.processHandle.resize(nextCols, nextRows);
    } catch (error: unknown) {
      log.warn("resize failure", { sessionId, err: (error as Error)?.message || String(error) });
    }
  }

  writeToSession(sessionId: string, data: string): void {
    const session = this.sessions.get(sessionId);
    if (!session || session.status !== "running") {
      return;
    }

    if (session.kind === "ssh") {
      this.sshManager?.write(sessionId, data);
      return;
    }

    const ptySession = session as PtySession;
    if (!ptySession.processHandle) return;

    ptySession.processHandle.write(data);
  }

  async restartSession(state: AppState, sessionId: string): Promise<RuntimeSession | null> {
    const current = this.sessions.get(sessionId);
    if (current?.kind === "ssh") {
      await this.sshManager?.stop(sessionId);
    } else {
      const ptySession = current as PtySession | undefined;
      if (ptySession?.processHandle) {
        const processHandle = ptySession.processHandle;
        this.suppressNextExit(sessionId);
        // IPty does not extend EventEmitter so we can't use `once()`.
        // Register an onExit listener and wait; fall back on a 5 s timeout.
        await new Promise<void>((resolve) => {
          const timeout = setTimeout(resolve, 5000);
          processHandle.onExit(() => {
            clearTimeout(timeout);
            resolve();
          });
          processHandle.kill();
        }).catch(() => {});
      }
    }

    this.sessions.delete(sessionId);
    return this.ensureSession(state, sessionId);
  }

  removeSession(sessionId: string): void {
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
    } else {
      const ptySession = session as PtySession;
      if (ptySession.processHandle) {
        this.suppressNextExit(sessionId);
        ptySession.processHandle.kill();
      }
    }
    this.sessions.delete(sessionId);
  }

  removeWorkspaceSessions(workspaceId: string): Promise<void> {
    const exitPromises: Promise<void>[] = [];
    for (const [sessionId, session] of this.sessions.entries()) {
      if (session.workspaceId !== workspaceId) {
        continue;
      }

      if (session.kind === "ssh") {
        const p = this.sshManager?.stop(sessionId).catch(() => {});
        if (p) exitPromises.push(p);
      } else {
        const ptySession = session as PtySession;
        if (ptySession.processHandle) {
          this.suppressNextExit(sessionId);
          const handle = ptySession.processHandle;
          exitPromises.push(
            new Promise<void>((resolve) => {
              const timeout = setTimeout(resolve, 5000);
              handle.onExit(() => {
                clearTimeout(timeout);
                resolve();
              });
            }),
          );
          handle.kill();
        }
      }
      this.sessions.delete(sessionId);
    }
    return exitPromises.length ? Promise.all(exitPromises).then(() => {}) : Promise.resolve();
  }

  syncWithState(state: AppState): void {
    const validSessionIds = new Set<string>();
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
      } else {
        const ptySession = session as PtySession;
        if (ptySession.processHandle) {
          this.suppressNextExit(sessionId);
          ptySession.processHandle.kill();
        }
      }
      this.sessions.delete(sessionId);
    }
  }

  stopAll(): void {
    for (const [sessionId, session] of this.sessions.entries()) {
      if (session.kind === "ssh") {
        this.sshManager?.stop(sessionId).catch(() => {});
      } else {
        const ptySession = session as PtySession;
        if (ptySession.processHandle) {
          this.suppressNextExit(sessionId);
          ptySession.processHandle.kill();
        }
      }
    }
    this.sessions.clear();
    this.suppressedExits.clear();
  }

  // Backward-compatible alias while runtime migration completes.
  removeProjectSessions(workspaceId: string): void {
    this.removeWorkspaceSessions(workspaceId);
  }
}
