import type { SandboxPolicyInput } from "./sandbox-policy.js";

/**
 * One launch, described independently of the isolation tool: what to run, what it may read and write,
 * what is protected, which destinations it may reach and what environment it gets. A backend turns it
 * into the `file` / `args` / `env` of the PTY. Paths are in the notation of the machine that runs the
 * sandbox (see `SandboxEnvironment.os`).
 */
export interface SandboxSpec extends Omit<SandboxPolicyInput, "toolConfigDir" | "gateway"> {
  sessionId: string;
  workspaceId: string;
  profileId: string;
  /** What runs inside the sandbox: argv, no shell parsing. */
  command: string[];
  cwd: string;
  /** Environment of the sandboxed process, already stripped of host credentials. */
  env: Record<string, string>;
  /** Per-launch tool configuration written by the launcher before the sandbox starts (no secrets). */
  toolFiles: Array<{ path: string; content: string; removeOnExit?: boolean; root: string; executable?: boolean }>;
  /** Links between folders the launch owns, made by the launcher below `root` and never over an existing entry. */
  /** Folders put in front of PATH inside the sandbox (the launcher's own wrappers). */
  pathPrepend?: string[];
  /** Folders put at the end of PATH inside the sandbox (an agent installer's own folder a login shell leaves out). */
  pathAppend?: string[];
  confinedLinks?: Array<{ link: string; target?: string; targets?: string[]; root: string }>;
  /**
   * Files the launcher copies into a folder the launch owns, once (never over an existing entry): the sandbox's own
   * copy of an agent state file. The first of `sources` that is a plain file is read; nothing is copied when none is.
   */
  seededFiles?: Array<{
    sources: string[];
    dest: string;
    root: string;
    filter?: "claude-state" | "claude-credentials" | "copilot-config" | "json" | "toml" | "env";
    /** Written again on every launch (a sanitized view of the host's file) instead of once. */
    refresh?: boolean;
    /** Environment variable names a sanitized config keeps (the agent's own model sign-in). */
    keepEnv?: string[];
  }>;
  /**
   * Folders of the agent that hold a credential-bearing config file: the launcher makes a real folder below `root`,
   * links every entry of the first existing source into it except the `exclude`d names, and grants exactly those entries.
   */
  confinedMirrors?: Array<{ dir: string; sources: string[]; exclude: string[]; root: string; localSqlite?: boolean }>;
  /** Home folder the agent is told to use (a folder of links), when the sandbox cannot bind the real one's entries. */
  homeOverride?: string;
  /** Current installation's notification script, readable inside the sandbox; replaces stale kept hook paths. */
  notifyScript?: string;
  /**
   * How the sandbox reaches the host gateway; absent when it cannot. A relay's unix socket is placed by the launcher
   * in its own work folder, so only a direct gateway names a socket path.
   */
  gateway?:
    { socketPath: string; relay?: undefined } | { socketPath?: undefined; relay: { tcpHost: string; tcpPort: number } };
}

export interface SandboxLaunch {
  file: string;
  args: string[];
  env: Record<string, string>;
  cwd: string;
}

/** What the machine that runs the sandbox looks like, probed once and cached. */
export interface SandboxEnvironment {
  /** Operating system of the sandbox host (the distro on Windows). */
  os: "linux" | "darwin";
  platform: NodeJS.Platform;
  home: string;
  /** Absolute path of `node` on the sandbox host. */
  nodePath: string;
  /** Absolute path of the sandbox runtime's `dist/index.js` (the pinned version). */
  srtModule: string;
  /** Windows only: the WSL distribution used (undefined = the default one). */
  distro?: string;
  /** Windows only: how a process in WSL reaches the Windows host. */
  hostAddress?: string;
  /** `codex --version` of the sandbox host's own Codex: it, not the Windows one, decides `--no-daemon`. */
  codexVersion?: string;
}

/**
 * What the service needs from an isolation backend. `srt` is the one there is; another (a microVM, a
 * container) is added by implementing this, without touching the service, the gateway or the UI.
 */
export interface SandboxBackend {
  id: string;
  /** The per-session files the backend keeps, in host notation: the denial log the service polls and the decisions it writes. */
  sessionFiles(sessionId: string): { dir: string; denialsFile: string; decisionsDir: string };
  buildLaunch(spec: SandboxSpec, environment: SandboxEnvironment): SandboxLaunch;
  /**
   * Folder, in the sandbox's notation, where the launcher publishes this session's tool settings. strIDEterm
   * owns it and the sandbox may only read it: it must never sit in a place the agent can write.
   */
  toolDir(sessionId: string, environment: SandboxEnvironment): string;
}

export class SandboxUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SandboxUnavailableError";
  }
}
