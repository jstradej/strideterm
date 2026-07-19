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
  // Set by an intentional teardown (restart / disconnect / removal / prune /
  // canceled-start discard) so this session's own onExit reports intentional.
  // A per-object flag — NOT the shared suppressedExits counter used for PTYs:
  // sshManager.stop() may fire no onExit at all for an already-dead session, so
  // an armed counter would go stale and wrongly swallow a LATER unexpected exit
  // under the same id. A fresh reconnect gets a new object that never inherits
  // this flag, so it cannot leak across generations.
  intentionalExit?: boolean;
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

/** Why an in-flight start was invalidated by a teardown that raced its connect. */
type StartCancelReason = "removed" | "disconnected";

/**
 * One generation of an in-flight session start. The cancel reason lives on the
 * record — NOT a shared per-id map — so when several generations of one id exist
 * transiently (an aborted connect being discarded while its reconnect is already
 * chained behind it), each carries its OWN teardown intent. A sibling
 * generation's discard can no longer consume a "removed"/"disconnected" reason
 * that a later teardown recorded against the CURRENT generation.
 *
 * `canceledReason` is consulted when the start resolves (see beginSessionStart):
 * - `"removed"` (panel/workspace deleted, syncWithState prune, shutdown): the
 *   pane is gone → emit terminal:removed so the runtime drops the replay AND the
 *   remote server unsubscribes the id.
 * - `"disconnected"` (removeSession / closeSession — "Disconnect SSH"): the
 *   panel STAYS → must NOT emit terminal:removed, or the remote server would
 *   unsubscribe the still-visible id and a reconnect would never stream.
 */
interface StartRecord {
  promise: Promise<RuntimeSession | null>;
  canceledReason: StartCancelReason | null;
}

export class SessionManager extends EventEmitter {
  sessions: Map<string, RuntimeSession>;
  startingSessions: Map<string, StartRecord>;
  suppressedExits: Map<string, number>;
  /**
   * Session ids whose PTY spawn FAILED (surfaced as terminal:data + null, never
   * inserted into `sessions`). The runtime still records the failure message in
   * its replay store, so these ids must participate in syncWithState's
   * terminal:removed cleanup or their replay leaks once the panel is removed —
   * `sessions` alone would never know they existed.
   */
  failedSpawns: Set<string>;
  getSessionEnv: ((ctx: SessionEnvContext) => Record<string, string>) | null;
  getSessionLaunch: ((ctx: SessionEnvContext) => SessionLaunchOverride | null) | null;
  sshManager: SshManager | null;

  constructor({ getSessionEnv = null, getSessionLaunch = null, sshManager = null }: SessionManagerOpts = {}) {
    super();
    this.sessions = new Map();
    this.startingSessions = new Map();
    this.suppressedExits = new Map();
    this.failedSpawns = new Set();
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
      // A genuine reconnect coalescing into a LIVE (non-aborted) start: share it
      // so two concurrent activations don't open two connections for one id.
      if (pending.canceledReason !== "disconnected") {
        return pending.promise;
      }
      // The in-flight start was aborted by a Disconnect and is being torn down.
      // Do NOT coalesce into the dying connect (the panel would end up
      // disconnected despite the reconnect) and do NOT race a second concurrent
      // connect (for system-ssh / WSL, whose PTYs sshManager.stop() cannot
      // cancel, that would orphan a duplicate PTY and a stale start could later
      // overwrite the live session). Instead SERIALIZE: chain a fresh start after
      // the aborted one has fully settled and been discarded. This chained
      // generation gets its OWN record, so a teardown that lands during the wait
      // is recorded against IT (not consumed by the aborted start's discard —
      // the finding-2 fix). We wait on the aborted start's WRAPPED promise
      // (`pending.promise`), which only resolves after its discard runs.
      const record: StartRecord = {
        canceledReason: null,
        promise: undefined as unknown as Promise<RuntimeSession | null>,
      };
      record.promise = pending.promise
        .catch(() => null)
        .then(() => {
          // A newer teardown/reconnect replaced us in the map → let it own the id.
          if (this.startingSessions.get(sessionId) !== record) return null;
          // A teardown landed on the QUEUED reconnect while it waited for the
          // aborted start to settle → cancel it. Either reason means the user no
          // longer wants THIS reconnect: "removed" (panel/workspace gone) OR
          // "disconnected" (a second Disconnect on the queued reconnect). A
          // restart racing the queue also sets "disconnected" but chains its OWN
          // fresh start, which REPLACES us in the map — already caught above — so
          // reaching here with a non-null reason is always a cancellation, never a
          // live reconnect. Drop the record so a future reconnect is a brand-new
          // start rather than chaining behind this settled one.
          if (record.canceledReason !== null) {
            this.startingSessions.delete(sessionId);
            return null;
          }
          // No teardown landed (reason still null) → this IS the reconnect; start
          // fresh. beginSessionStart overwrites the record with the new generation.
          return this.beginSessionStart(sessionId, start);
        });
      this.startingSessions.set(sessionId, record);
      return record.promise;
    }

    // A brand-new start: there is no in-flight generation (concurrent starts are
    // coalesced above), so there is no prior cancel reason to worry about — each
    // reason lives on its own record, which is gone once its start settled.
    return this.beginSessionStart(sessionId, start);
  }

  private beginSessionStart(
    sessionId: string,
    start: () => Promise<RuntimeSession | null>,
  ): Promise<RuntimeSession | null> {
    const started = start();
    const record: StartRecord = {
      canceledReason: null,
      promise: undefined as unknown as Promise<RuntimeSession | null>,
    };
    record.promise = (async () => {
      try {
        const session = await started;
        // If a teardown landed while this connect was in flight, its reason is
        // recorded on THIS record (a sibling generation's discard can't consume
        // it). The resolved start just re-registered state cleanup already
        // removed (an orphan session, or failedSpawns + error replay) — undo it
        // rather than leak a session/replay for a pane that is gone or was
        // disconnected.
        if (record.canceledReason) {
          this.discardCanceledStart(sessionId, session, record.canceledReason);
          return null;
        }
        return session;
      } finally {
        if (this.startingSessions.get(sessionId) === record) {
          this.startingSessions.delete(sessionId);
        }
      }
    })();
    this.startingSessions.set(sessionId, record);
    return record.promise;
  }

  /**
   * Tear down a session/replay that a start produced after a teardown landed.
   * Always stops any live process/connection and drops the session. Replay and
   * subscription cleanup depends on `reason` (see the StartRecord docs). The
   * reason is owned by the resolving start's own record, so nothing to clear
   * here — a chained successor keeps its own, independent record.
   */
  private discardCanceledStart(sessionId: string, session: RuntimeSession | null, reason: StartCancelReason): void {
    const live = session ?? this.sessions.get(sessionId) ?? null;
    if (live) {
      if (live.kind === "ssh") {
        // Discarding a start we asked to tear down → its onExit is intentional,
        // same as any other user-driven stop (see stopSshIntentional).
        (live as SshSession).intentionalExit = true;
        this.sshManager?.stop(sessionId).catch(() => {});
      } else {
        const ptySession = live as PtySession;
        if (ptySession.processHandle) {
          this.suppressNextExit(sessionId);
          ptySession.processHandle.kill();
        }
      }
      this.sessions.delete(sessionId);
    }
    if (reason === "removed") {
      // Panel is gone: drop any failed-spawn marker and tell the runtime to
      // destroy the replay — which also unsubscribes the id on the remote
      // server, correct since the pane no longer exists.
      this.failedSpawns.delete(sessionId);
      this.emit("terminal:removed", { sessionId });
    } else {
      // "disconnected": the panel stays (closeSession/removeSession keeps it and
      // never emits terminal:removed). Emitting it here would unsubscribe the
      // still-visible id on the remote server, freezing a reconnect. Instead
      // keep it subscribed and track the late connect's orphan replay via
      // failedSpawns, so a later panel removal still cleans it and a reconnect
      // clears it via terminal:spawned.
      this.failedSpawns.add(sessionId);
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

  /**
   * Stop a pure ssh2 session (`kind: "ssh"`) as an INTENTIONAL teardown so its
   * onExit reports `intentional: true` — the runtime then clears the replay
   * instead of appending a spurious `[process exited]` line and possibly
   * raising an unexpected-exit alert. Centralizes the marking the PTY path gets
   * from suppressNextExit(): the flag lives on the session object, so it can't
   * go stale if stop() fires no onExit, and never bleeds into a later reconnect
   * (which is a fresh object). Returns the stop() promise for callers that await
   * teardown (restart, workspace removal).
   */
  private stopSshIntentional(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (session?.kind === "ssh") (session as SshSession).intentionalExit = true;
    return this.sshManager?.stop(sessionId).catch(() => {}) ?? Promise.resolve();
  }

  // NOTE (multi-window audit): the state.activeWorkspaceId default below is
  // the LEGACY single-window mirror ("last activation anywhere"). Every
  // UI-triggered call path passes an explicit workspaceId resolved from the
  // caller's viewer (window slot / remote client); the default only feeds
  // the legacy payload.workspace snapshot, which multi-window renderers
  // ignore in favor of their own slot-scoped selection.
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
      // Remember the failed id: the error text below is recorded in the runtime's
      // replay store, but the session is never inserted into `sessions`, so only
      // failedSpawns can drive its terminal:removed cleanup when the panel goes.
      this.failedSpawns.add(key);
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
    // A live session now owns this id → it is no longer a failed-spawn orphan
    // (a retry succeeded); syncWithState will clean it up via `sessions`.
    this.failedSpawns.delete(key);
    // New process generation under this sessionId (fresh spawn OR implicit
    // respawn of an exited session, e.g. via ensureSession on workspace
    // activation). The runtime clears the previous generation's replay on
    // this event — data events dispatch async, so this always precedes the
    // first output of the new process.
    this.emit("terminal:spawned", { sessionId: key });

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
    // A live session now owns this id → it is no longer a failed-spawn orphan
    // (a retry succeeded), same as the local PTY path.
    this.failedSpawns.delete(sessionId);
    // New process generation registered under this sessionId — same replay
    // boundary as the PTY spawn path above.
    this.emit("terminal:spawned", { sessionId });
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
      // No session is ever inserted for a failed spawn, but the error banner
      // below is recorded in the runtime's replay store — only failedSpawns can
      // drive its terminal:removed cleanup once the panel is gone.
      this.failedSpawns.add(sessionId);
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
      // Surfaced as replay-recorded output with no session — mark it so the
      // panel's removal can still reach its replay via failedSpawns cleanup.
      this.failedSpawns.add(sessionId);
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
      // Same as system-ssh: no session, but a replay entry for the banner below.
      this.failedSpawns.add(sessionId);
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
        // Pure ssh2 sessions have no PTY handle and are torn down via
        // sshManager.stop(), so they never arm the PTY suppressNextExit counter.
        // The teardown marks this session object directly instead (see
        // stopSshIntentional); anything else is a genuine unexpected exit.
        const intentional = session.intentionalExit === true;
        this.emit("terminal:exit", { sessionId, exitCode, intentional });
      },
    };
    if (panel.launch?.sshInline) {
      createArgs.inlineHost = panel.launch.sshInline;
    } else {
      createArgs.hostId = panel.launch?.sshHostId;
    }

    // New generation boundary — emitted BEFORE createSession because the
    // onData callback can fire during the await (connection banners) and that
    // output already belongs to the new generation's replay.
    this.emit("terminal:spawned", { sessionId });

    try {
      await this.sshManager!.createSession(createArgs);
    } catch (err: unknown) {
      // SshManager already surfaces the failure via the "ssh:connection-state"
      // event and an inline red banner in the terminal — no need to crash the
      // caller (which is frequently a fire-and-forget `ensureSession` from
      // workspace activation). Swallow the rejection here to prevent
      // UnhandledPromiseRejectionWarning while still logging for diagnostics.
      log.warn("SSH session start failed", { sessionId, error: (err as Error)?.message || String(err) });
      // terminal:spawned was emitted above and SshManager surfaces the failure
      // as an inline red banner (terminal:data) — both leave a replay entry with
      // no session, so mark it for failedSpawns-driven cleanup on panel removal.
      this.failedSpawns.add(sessionId);
      return null;
    }
    // Quiet the unused-var lint — host is pre-resolved by ensureSession for
    // logging symmetry with system-ssh/wsl branches; SshManager re-resolves
    // from id or inlineHost itself.
    void host;

    this.sessions.set(sessionId, session);
    // A live session now owns this id → clear any prior failed-spawn marker.
    this.failedSpawns.delete(sessionId);
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
      await this.stopSshIntentional(sessionId);
    } else if (current) {
      const ptySession = current as PtySession;
      if (ptySession.processHandle) {
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
    } else {
      // No live session yet — the connect is still in flight (an SSH handshake,
      // or a connect parked on a password / MFA / host-key prompt), so it lives
      // in startingSessions, not `sessions`. Without aborting it the ensureSession
      // below merely coalesces into the SAME pending connect and the restart is a
      // silent no-op. Mark the in-flight record "disconnected" (the panel stays)
      // and stop() so a hung prompt is released; trackSessionStart then serializes
      // a FRESH connect behind the aborted one. Never downgrade a "removed"
      // record — a restart racing a panel/workspace prune must not resurrect it.
      const record = this.startingSessions.get(sessionId);
      if (record && record.canceledReason !== "removed") {
        record.canceledReason = "disconnected";
        await (this.sshManager?.stop(sessionId).catch(() => {}) ?? Promise.resolve());
      }
    }

    this.sessions.delete(sessionId);
    return this.ensureSession(state, sessionId);
  }

  removeSession(sessionId: string): void {
    // A start still in flight has not inserted its session yet; tombstone its
    // record so the connect is torn down when it resolves instead of resurrecting
    // a session the user just asked to disconnect. "disconnected", not "removed":
    // the panel stays, so the discard must keep the id subscribed for reconnect.
    // Never downgrade an existing "removed" reason (panel/workspace gone): a stale
    // Disconnect racing a prune must NOT turn a removed pane back into a
    // merely-disconnected one, or the late connect would keep the id subscribed
    // and leak its replay for a pane that no longer exists.
    const startRecord = this.startingSessions.get(sessionId);
    if (startRecord && startRecord.canceledReason !== "removed") {
      startRecord.canceledReason = "disconnected";
      // Actively abort the in-flight connect. The tombstone alone only takes
      // effect when the start RESOLVES, but a connect parked on an SSH
      // password / MFA / host-key prompt never resolves on its own — without
      // stop() it (and its open prompt) would leak past the user's Disconnect.
      // Matches removeWorkspaceSessions / syncWithState. The start STAYS in
      // startingSessions so a racing reconnect chains a fresh start after this
      // aborted one is discarded (see trackSessionStart) rather than running a
      // second connect concurrently.
      this.sshManager?.stop(sessionId).catch(() => {});
    }
    const session = this.sessions.get(sessionId);
    if (!session) {
      return;
    }

    if (session.kind === "ssh") {
      // stopSshIntentional's returned promise never rejects (it swallows its
      // own sshManager.stop() error internally) — fire-and-forget since this
      // method is synchronous.
      void this.stopSshIntentional(sessionId);
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
        exitPromises.push(this.stopSshIntentional(sessionId));
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

    // Failed-spawn ids never entered `sessions`, so the loop above can't reach
    // them. deleteWorkspace/pruneOrphanedWorkspaces clear this workspace's replay
    // wholesale but never call syncWithState, so without this prune a failed
    // spawn's id would linger in the set until some unrelated future
    // syncWithState — a small unbounded leak. No terminal:removed is emitted:
    // the caller drops the workspace's replay wholesale, matching how the live
    // sessions above are removed silently.
    const prefix = `${workspaceId}:`;
    for (const sessionId of this.failedSpawns) {
      if (sessionId.startsWith(prefix)) this.failedSpawns.delete(sessionId);
    }

    // A slow SSH connect for this workspace may still be in flight (not yet in
    // `sessions`, so the loop above missed it). Tombstone it as "removed" so a
    // late resolve is discarded instead of inserting an orphan session / replay
    // for a workspace that has just been deleted, AND actively cancel it: the
    // tombstone alone only fires on resolve, but a connect parked on an SSH
    // password / host-key prompt never resolves on its own, so without the
    // stop() it (and its prompt) would leak past the workspace's deletion.
    for (const [sessionId, record] of this.startingSessions) {
      if (!sessionId.startsWith(prefix)) continue;
      record.canceledReason = "removed";
      this.sshManager?.stop(sessionId).catch(() => {});
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
        void this.stopSshIntentional(sessionId);
      } else {
        const ptySession = session as PtySession;
        if (ptySession.processHandle) {
          this.suppressNextExit(sessionId);
          ptySession.processHandle.kill();
        }
      }
      this.sessions.delete(sessionId);
      // The panel is gone from state entirely (not a restart) → let the runtime
      // drop its replay so removed panels don't leak replay memory and their
      // stale replay can't be re-served on a later subscribe.
      this.emit("terminal:removed", { sessionId });
    }

    // Failed-spawn ids never entered `sessions`, so the loop above can't reach
    // them. Prune the ones whose panel is gone here too, or the runtime's replay
    // entry for the surfaced error message leaks for a pane that no longer exists.
    for (const sessionId of this.failedSpawns) {
      if (validSessionIds.has(sessionId)) continue;
      this.failedSpawns.delete(sessionId);
      this.emit("terminal:removed", { sessionId });
    }

    // In-flight starts whose panel is gone from state: tombstone them as
    // "removed" so a late connect resolving after this prune does not re-insert
    // a session or replay for a panel that no longer exists (the loops above
    // only see `sessions` and `failedSpawns`, never a still-pending start), AND
    // actively cancel them — a connect hung on an SSH prompt never resolves to
    // trigger the tombstone discard, so it would otherwise leak past the prune.
    for (const [sessionId, record] of this.startingSessions) {
      if (validSessionIds.has(sessionId)) continue;
      record.canceledReason = "removed";
      this.sshManager?.stop(sessionId).catch(() => {});
    }
  }

  stopAll(): void {
    for (const [sessionId, session] of this.sessions.entries()) {
      if (session.kind === "ssh") {
        void this.stopSshIntentional(sessionId);
      } else {
        const ptySession = session as PtySession;
        if (ptySession.processHandle) {
          this.suppressNextExit(sessionId);
          ptySession.processHandle.kill();
        }
      }
    }
    // In-flight SSH connects live in startingSessions, not yet in `sessions`, so
    // the loop above misses them. At shutdown an unfinished handshake / open
    // socket would otherwise survive and hold the Node process open (or emit a
    // late event). Abort each, and tombstone it "removed" so a connect that
    // resolves after this can't re-insert a session into the cleared map.
    for (const [sessionId, record] of this.startingSessions) {
      record.canceledReason = "removed";
      this.sshManager?.stop(sessionId).catch(() => {});
    }
    this.sessions.clear();
    this.suppressedExits.clear();
  }
}
