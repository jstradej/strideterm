import path from "node:path";
import { SANDBOX_GATEWAY_HOST, normalizeSandboxDomains } from "../../shared/sandbox.js";
import { mirroredAgentFolders, type AgentSandboxProfile } from "./agent-profile.js";
import { toolchainCacheFolder, type ToolchainProfile } from "./toolchain-profile.js";

/**
 * The sandbox policy for ONE launch, in the notation of the machine that runs the sandbox (the host
 * on Linux and macOS, the WSL distro on Windows). Pure: no file or process access, so it can be tested
 * against exact lists.
 *
 * Reads are open by default in the sandbox runtime, so the home directory and every other place a
 * credential could sit are denied first and what the launch needs is re-allowed by name.
 */

export interface SandboxPolicyInput {
  os: "linux" | "darwin";
  /** Home directory as the sandbox sees it. */
  home: string;
  /** Workspace roots: read and write. */
  roots: string[];
  /** Git directories that sit outside the roots (linked worktrees, a PR cache): read and write. */
  gitDirs: string[];
  /** Files whose content selected `gitDirs` (a linked worktree's `.git` pointer and its back-references): read-only. */
  gitPointerFiles?: string[];
  /**
   * Windows host only: agent folders of the Windows user (their sign-in, sessions), so one login serves both CLIs.
   * `target` is the folder as WSL sees it and is granted by name; `link` is where the agent looks for it in its home,
   * which is NOT the distro's home (the sandbox runtime cannot bind a link there) but the sandbox's own folder of links.
   */
  loginLinks?: Array<{ link: string; target: string }>;
  /** Further readable paths (the MCP bridge entry, the agent executable's folder). */
  readPaths: string[];
  /** Further read-write paths (review store folders). */
  readWritePaths: string[];
  /**
   * Folders only this workspace's launch uses (a per-workspace Gradle user home). Read-write, created before the
   * sandbox starts, and deliberately outside the shared cache: they may carry executable configuration.
   */
  workspaceHomes?: string[];
  /** Further folders to create before the sandbox starts (the shared target of a link). */
  ensureDirs?: string[];
  agent: AgentSandboxProfile | null;
  toolchains: ToolchainProfile[];
  /** Shared dependency cache root; writable and outside the home directory. */
  cacheRoot: string;
  /** Domains from the workspace's own allowlist. */
  workspaceDomains: string[];
  /** Registry or broker destinations beyond the gateway's host (none by default). */
  extraDomains?: string[];
  /** Unix socket of the host gateway; its host name is routed there by the sandbox proxy. */
  gatewaySocket?: string;
  /** Folder the launcher writes per-launch tool config into; the sandbox reads it. */
  toolConfigDir: string;
}

export interface SandboxRuntimeConfigLike {
  network: {
    allowedDomains: string[];
    deniedDomains: string[];
    mitmProxy?: { socketPath: string; domains: string[] };
  };
  filesystem: {
    denyRead: string[];
    allowRead: string[];
    allowWrite: string[];
    denyWrite: string[];
  };
  /** macOS only: an interactive agent and the tools it starts need pseudo-terminal operations inside Seatbelt. */
  allowPty?: boolean;
  /** macOS only: lets the agent reach the system trust service to verify TLS (`AgentSandboxProfile.needsSystemTrust`). */
  enableWeakerNetworkIsolation?: boolean;
}

export interface SandboxPolicy {
  runtime: SandboxRuntimeConfigLike;
  /** Folders the launcher creates (mode 0700) before the sandbox starts, so binding them cannot fail. */
  ensureDirs: string[];
  /** Entries the launcher checks for existence and drops when missing (a fresh machine has no `~/.claude`). */
  optional: { allowRead: string[]; allowWrite: string[]; denyWrite: string[] };
}

/** Tool installations every agent may need, regardless of language: the runtime of npm-distributed agent CLIs. */
const BASE_READ_HOME = [".local/bin", ".nvm", ".volta", ".fnm", ".local/share/fnm", ".npm-global"];

/** Places credentials and other users' data live. Denied wholesale; the launch's own paths are re-allowed. */
const DENIED_LINUX = [
  "/home",
  "/root",
  "/mnt",
  "/media",
  "/run/media",
  "/var/run/docker.sock",
  "/run/docker.sock",
  "/var/lib/docker",
];
const DENIED_DARWIN = ["/Users", "/Volumes", "/var/run/docker.sock"];

/**
 * Project paths the host (or the user's IDE) runs later: read-only for the agent, when they exist.
 * The runtime's own mandatory protections cover the same files when they do not exist yet.
 */
const PROTECTED_PROJECT_PATHS = [".claude", ".mcp.json", ".vscode", ".idea", ".git/hooks", ".git/config"];

/**
 * Files in an agent's own folder that the agent CLI on the HOST runs or obeys later (hooks, MCP servers, permission
 * rules). The sandbox never rewrites them. The ones that can carry other tools' credentials (the profile's
 * `configFiles`) are not even readable there: the sandbox works on a sanitized copy; the rest (hooks, plugins) is read-only.
 */
const PROTECTED_AGENT_CONFIG = [
  "settings.json",
  "settings.local.json",
  "config.toml",
  "hooks.json",
  "config.json",
  "opencode.json",
  "opencode.jsonc",
  "mcp-config.json",
  "hooks",
  "plugins",
  "plugin",
  "extensions",
];

/** Inside a git directory outside the roots (a linked worktree's, a PR cache's) the same two stay read-only. */
const PROTECTED_GIT_DIR_PATHS = ["hooks", "config"];

/** Home-relative entries a sandbox home that is a folder of links has to mirror: the agent's and the tools' folders. */
export function homeMirrorEntries(agent: AgentSandboxProfile | null, toolchains: ToolchainProfile[]): string[] {
  return unique([
    ...BASE_READ_HOME,
    ...(agent?.readHome ?? []),
    ...(agent?.writeHome ?? []),
    ...toolchains.flatMap((profile) => profile.readHome),
  ]);
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function homeRelative(home: string, relative: string): string {
  return path.posix.join(home, relative);
}

export function buildSandboxPolicy(input: SandboxPolicyInput): SandboxPolicy {
  const home = input.home.replace(/\/+$/u, "");
  const readHome = [
    ...BASE_READ_HOME,
    ...(input.agent?.readHome ?? []),
    ...input.toolchains.flatMap((profile) => profile.readHome),
  ].map((relative) => homeRelative(home, relative));
  const writeHome = (input.agent?.writeHome ?? []).map((relative) => homeRelative(home, relative));
  const cacheFolders = input.toolchains.map((profile) => toolchainCacheFolder(input.cacheRoot, profile));

  const allowedDomains = unique([
    ...(input.agent?.domains ?? []),
    ...input.toolchains.flatMap((profile) => profile.domains),
    ...normalizeSandboxDomains(input.workspaceDomains),
    ...(input.extraDomains ?? []),
    ...(input.gatewaySocket ? [SANDBOX_GATEWAY_HOST] : []),
  ]);

  // A folder with a credential-bearing config file (an MCP server's env, a hook) is never granted whole: the launcher
  // mirrors it, entry by entry, without those files and grants the entries it linked.
  const mirroredOwn = new Set(mirroredAgentFolders(input.agent).map((relative) => homeRelative(home, relative)));
  const mirrored = new Set([
    ...mirroredOwn,
    ...(input.loginLinks ?? []).filter((item) => mirroredOwn.has(item.link)).map((item) => item.target),
  ]);
  const whole = (paths: string[]) => paths.filter((item) => !mirrored.has(item));
  const loginTargets = (input.loginLinks ?? []).map((item) => item.target);
  const workspaceHomes = input.workspaceHomes ?? [];
  // The agent's own folders are shared with the host CLI (Windows: through the links; elsewhere: the home folder
  // itself), so its settings, hooks and MCP servers are read by the sandbox and never rewritten by it.
  const agentFolders = [
    ...(input.agent?.writeHome ?? [])
      .filter((relative) => !relative.endsWith(".json"))
      .map((relative) => homeRelative(home, relative)),
    ...loginTargets,
  ];
  const projectDenyWrite = [
    ...agentFolders.flatMap((folder) => PROTECTED_AGENT_CONFIG.map((name) => path.posix.join(folder, name))),
    ...input.roots.flatMap((root) => PROTECTED_PROJECT_PATHS.map((name) => path.posix.join(root, name))),
    ...input.gitDirs.flatMap((dir) => PROTECTED_GIT_DIR_PATHS.map((name) => path.posix.join(dir, name))),
    ...(input.gitPointerFiles ?? []),
  ];

  const allowRead = unique([
    ...input.roots,
    ...input.gitDirs,
    ...input.readPaths,
    ...input.readWritePaths,
    ...workspaceHomes,
    ...whole(readHome),
    ...whole(writeHome),
    ...whole(loginTargets),
    input.cacheRoot,
    input.toolConfigDir,
  ]);
  const allowWrite = unique([
    ...input.roots,
    ...input.gitDirs,
    ...input.readWritePaths,
    ...workspaceHomes,
    ...whole(writeHome),
    ...whole(loginTargets),
    ...cacheFolders,
    "/tmp",
  ]);

  // A folder the Windows sign-in stands in for must not be created empty first: it would look like the distro's own.
  const linkedNames = new Set((input.loginLinks ?? []).map((item) => item.link));
  const ensureDirs = unique([
    input.cacheRoot,
    ...cacheFolders,
    ...workspaceHomes,
    ...(input.ensureDirs ?? []),
    ...(input.agent?.writeHome ?? [])
      .filter((relative) => !relative.endsWith(".json"))
      .map((relative) => homeRelative(home, relative))
      .filter((folder) => !linkedNames.has(folder)),
  ]);

  const mitmProxy = input.gatewaySocket
    ? { socketPath: input.gatewaySocket, domains: [SANDBOX_GATEWAY_HOST] }
    : undefined;

  return {
    runtime: {
      network: {
        allowedDomains,
        deniedDomains: [],
        ...(mitmProxy ? { mitmProxy } : {}),
      },
      filesystem: {
        denyRead: unique([home, ...(input.os === "darwin" ? DENIED_DARWIN : DENIED_LINUX)]),
        allowRead,
        allowWrite,
        denyWrite: [],
      },
      ...(input.os === "darwin" ? { allowPty: true } : {}),
      ...(input.os === "darwin" && input.agent?.needsSystemTrust ? { enableWeakerNetworkIsolation: true } : {}),
    },
    ensureDirs,
    optional: {
      allowRead: unique([
        ...whole(readHome),
        ...whole(writeHome),
        ...whole(loginTargets),
        ...input.readPaths,
        ...input.gitDirs,
      ]),
      allowWrite: unique([...whole(writeHome), ...whole(loginTargets), ...input.gitDirs, ...input.readWritePaths]),
      denyWrite: projectDenyWrite,
    },
  };
}
