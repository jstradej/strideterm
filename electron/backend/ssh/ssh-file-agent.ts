import path from "node:path";
import type { SshFileListing, SshFileTransferRun } from "../../shared/ssh-file-events.js";
import type { AppState, WorkspaceState } from "../../shared/types/state.js";
import { SshFileError } from "./ssh-file-error.js";
import {
  SSH_FILE_AGENT_SESSION_PREFIX,
  type SshFileConnectOptions,
  type SshFileTarget,
} from "./ssh-file-connections.js";
import { createRootsLocalPolicy } from "./ssh-file-local-policy.js";
import { normalizeRemotePath, type SshFileService } from "./ssh-file-service.js";
import type { SshManager } from "./ssh-manager.js";

type HostRecord = NonNullable<ReturnType<SshManager["getHost"]>>;

export const SSH_FILE_AGENT_MAX_RUNNING_TRANSFERS = 2;
export const SSH_FILE_AGENT_MAX_TRANSFER_BYTES = 5 * 1024 * 1024 * 1024;

/** The identity an agent's request is bound to; the broker re-proves it is live before every call. */
export interface SshFileAgentGrant {
  sessionId: string;
  profileId: string;
  workspaceId: string;
}

export interface SshFileAgentTransferInput {
  direction: "upload" | "download";
  hostId: string;
  /** Upload: a local path of the workspace; download: a remote absolute path. */
  source: string;
  /** Upload: a remote absolute directory; download: a local directory of the workspace. */
  destinationDir: string;
  overwrite?: boolean;
}

/** The folders a workspace owns: its own directory, Git roots, and review / quick-fix checkouts. */
export function workspaceRoots(workspace: WorkspaceState): string[] {
  const roots: string[] = [];
  if (workspace.cwd) roots.push(workspace.cwd);
  if (Array.isArray(workspace.gitRoots)) roots.push(...workspace.gitRoots.filter(Boolean));
  const review = (workspace as { review?: { checkout?: { rootPath?: string } } }).review?.checkout?.rootPath;
  if (review) roots.push(review);
  const quickfix = (workspace as { quickfix?: { rootPath?: string } }).quickfix?.rootPath;
  if (quickfix) roots.push(quickfix);
  return roots;
}

/**
 * What an agent holding the SSH tool grant may do with files. It connects on its own to a saved Built-in SSH host
 * (the same hosts `run_ssh_command` may use) and can never be asked a question: a password, passphrase or host-key
 * prompt ends the call with `auth-required`. Local paths are confined to the grant workspace's own folders, and a
 * download never writes into a `.git` directory.
 */
export function createSshFileAgentTools({
  sshManager,
  getState,
  getEffectiveLaunchMode,
  service,
}: {
  sshManager: SshManager;
  getState: () => AppState;
  getEffectiveLaunchMode: (host: HostRecord) => "ssh2" | "system-ssh" | "wsl";
  service: SshFileService;
}) {
  const ownerKeyOf = (grant: SshFileAgentGrant) => `grant:${grant.sessionId}`;

  function hostTarget(hostId: string): SshFileTarget {
    const host = sshManager.getHost(hostId);
    if (!host) {
      throw new SshFileError(
        "unsupported-host",
        "Saved SSH host was not found. Refresh the SSH host list and try again.",
      );
    }
    if (getEffectiveLaunchMode(host) !== "ssh2") {
      throw new SshFileError(
        "unsupported-host",
        "This host uses System SSH or WSL. Agent SSH tools currently support Built-in SSH hosts only.",
      );
    }
    return { hostId: host.id, hostLabel: host.name || host.host, own: { poolKey: host.id, hostId: host.id } };
  }

  function connectOptions(grant: SshFileAgentGrant): SshFileConnectOptions {
    return { allowPrompts: false, ownerKey: ownerKeyOf(grant), sessionPrefix: SSH_FILE_AGENT_SESSION_PREFIX };
  }

  function workspaceOf(grant: SshFileAgentGrant): WorkspaceState {
    const workspace = getState().workspaces.find((item) => item.id === grant.workspaceId);
    if (!workspace || String(workspace.profileId || "default") !== grant.profileId) {
      throw new SshFileError("permission-denied", "The workspace of this tab is no longer available.");
    }
    return workspace;
  }

  /** A relative local path is relative to the workspace folder; an absolute one is judged against its roots. */
  function resolveLocal(workspace: WorkspaceState, value: string): string {
    if (!value || value.includes("\0")) throw new SshFileError("io", "Invalid local path.");
    if (!workspace.cwd && !path.isAbsolute(value)) {
      throw new SshFileError("outside-roots", "This workspace has no folder to resolve a relative path against.");
    }
    return path.resolve(workspace.cwd || path.sep, value);
  }

  return {
    listFiles(grant: SshFileAgentGrant, input: { hostId: string; path?: string }): Promise<SshFileListing> {
      workspaceOf(grant);
      return service.list(hostTarget(input.hostId), connectOptions(grant), input.path);
    },

    /** Validates and starts a transfer and answers at once with its id; progress is read with `transferStatus`. */
    async startTransfer(grant: SshFileAgentGrant, input: SshFileAgentTransferInput): Promise<{ transferId: string }> {
      const workspace = workspaceOf(grant);
      const ownerKey = ownerKeyOf(grant);
      if (service.transfers.runningCount(ownerKey) >= SSH_FILE_AGENT_MAX_RUNNING_TRANSFERS) {
        throw new SshFileError(
          "limit-exceeded",
          `Only ${SSH_FILE_AGENT_MAX_RUNNING_TRANSFERS} transfers may run at once for this tab. Wait for one to finish.`,
        );
      }
      const target = hostTarget(input.hostId);
      const upload = input.direction === "upload";
      const sources = [upload ? resolveLocal(workspace, input.source) : normalizeRemotePath(input.source, "path")];
      const destinationDir = upload
        ? normalizeRemotePath(input.destinationDir, "directory")
        : resolveLocal(workspace, input.destinationDir);
      return service.startTransfer({
        direction: input.direction,
        sources,
        destinationDir,
        conflict: input.overwrite === true ? "overwrite" : "fail",
        profileId: grant.profileId,
        workspaceId: workspace.id,
        source: "mcp",
        ownerKey,
        maxBytes: SSH_FILE_AGENT_MAX_TRANSFER_BYTES,
        local: createRootsLocalPolicy({ roots: () => workspaceRoots(workspaceOf(grant)), protectGit: true }),
        target,
        connect: connectOptions(grant),
      });
    },

    /** Status of a transfer this grant started; another tab's transfer is simply unknown. */
    transferStatus(grant: SshFileAgentGrant, transferId: string): SshFileTransferRun {
      const run =
        service.transfers.ownerOf(transferId) === ownerKeyOf(grant) ? service.transfers.get(transferId) : undefined;
      if (!run) throw new SshFileError("not-found", "Unknown transfer, or it finished more than a day ago.");
      return run;
    },
  };
}

export type SshFileAgentTools = ReturnType<typeof createSshFileAgentTools>;
