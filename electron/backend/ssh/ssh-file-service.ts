import path from "node:path";
import type { SFTPWrapper } from "ssh2";
import type { SshFileEntry, SshFileListing } from "../../shared/ssh-file-events.js";
import { SshFileError, toSshFileError } from "./ssh-file-error.js";
import {
  createSshFileConnections,
  type SshFileConnectOptions,
  type SshFileConnections,
  type SshFileTarget,
} from "./ssh-file-connections.js";
import { createSshFileTransfers, type SshFileTransfers, type StartSshFileTransfer } from "./ssh-file-transfers.js";
import {
  sftpLstat,
  sftpMkdir,
  sftpReaddir,
  sftpReadlink,
  sftpRealpath,
  sftpRename,
  sftpRmdir,
  sftpUnlink,
} from "./sftp-promises.js";
import type { SshManager } from "./ssh-manager.js";

export const SSH_FILE_MAX_LIST_ENTRIES = 5000;
export const SSH_FILE_MAX_DELETE_ENTRIES = 100_000;
const MAX_LINK_TARGETS = 200;
const MAX_REMOTE_PATH = 4096;

type HostRecord = NonNullable<ReturnType<SshManager["getHost"]>>;

/** A remote path as the UI / an agent names it: absolute POSIX, normalized, no NUL. Windows OpenSSH is `/C:/...`. */
export function normalizeRemotePath(value: unknown, label = "path"): string {
  if (typeof value !== "string" || !value || value.length > MAX_REMOTE_PATH || value.includes("\0")) {
    throw new SshFileError("io", `Invalid remote ${label}.`);
  }
  if (!value.startsWith("/")) throw new SshFileError("io", `The remote ${label} must be absolute (start with "/").`);
  return path.posix.normalize(value);
}

function entryType(stats: {
  isDirectory(): boolean;
  isFile(): boolean;
  isSymbolicLink(): boolean;
}): SshFileEntry["type"] {
  if (stats.isSymbolicLink()) return "symlink";
  if (stats.isDirectory()) return "dir";
  return stats.isFile() ? "file" : "other";
}

export interface SshFileServiceOptions {
  sshManager: SshManager;
  getEffectiveLaunchMode: (host: HostRecord) => "ssh2" | "system-ssh" | "wsl";
  emit: (channel: string, payload: unknown) => void;
  now?: () => number;
  idleCloseMs?: number;
}

export function createSshFileService({
  sshManager,
  getEffectiveLaunchMode,
  emit,
  now,
  idleCloseMs,
}: SshFileServiceOptions) {
  const connections: SshFileConnections = createSshFileConnections({ sshManager, getEffectiveLaunchMode, idleCloseMs });
  const transfers: SshFileTransfers = createSshFileTransfers({ emit, now });

  async function withBrowse<T>(
    target: SshFileTarget,
    options: SshFileConnectOptions,
    work: (sftp: SFTPWrapper) => Promise<T>,
  ): Promise<T> {
    const lease = await connections.acquire(target, options);
    try {
      return await work(await lease.browseChannel());
    } catch (error) {
      throw toSshFileError(error);
    } finally {
      lease.release();
    }
  }

  return {
    connections,
    transfers,

    async realpath(
      target: SshFileTarget,
      options: SshFileConnectOptions,
      remotePath?: string,
    ): Promise<{ path: string }> {
      const requested = remotePath === undefined || remotePath === "." ? "." : normalizeRemotePath(remotePath);
      return withBrowse(target, options, async (sftp) => ({ path: await sftpRealpath(sftp, requested) }));
    },

    async list(target: SshFileTarget, options: SshFileConnectOptions, remotePath?: string): Promise<SshFileListing> {
      const requested = remotePath === undefined || remotePath === "." ? "." : normalizeRemotePath(remotePath);
      return withBrowse(target, options, async (sftp) => {
        const resolved = await sftpRealpath(sftp, requested);
        const names = (await sftpReaddir(sftp, resolved)).filter(
          (entry) => entry.filename !== "." && entry.filename !== "..",
        );
        names.sort((a, b) => a.filename.localeCompare(b.filename));
        const truncated = names.length > SSH_FILE_MAX_LIST_ENTRIES;
        const entries: SshFileEntry[] = names.slice(0, SSH_FILE_MAX_LIST_ENTRIES).map((entry) => ({
          name: entry.filename,
          type: entryType(entry.attrs),
          size: entry.attrs.size ?? 0,
          mtimeMs: (entry.attrs.mtime ?? 0) * 1000,
          mode: (entry.attrs.mode ?? 0) & 0o7777,
        }));
        const links = entries.filter((entry) => entry.type === "symlink").slice(0, MAX_LINK_TARGETS);
        await Promise.all(
          links.map(async (entry) => {
            entry.linkTarget = await sftpReadlink(sftp, path.posix.join(resolved, entry.name)).catch(() => undefined);
          }),
        );
        return { path: resolved, entries, truncated };
      });
    },

    async mkdir(target: SshFileTarget, options: SshFileConnectOptions, remotePath: string): Promise<void> {
      const normalized = normalizeRemotePath(remotePath);
      return withBrowse(target, options, (sftp) => sftpMkdir(sftp, normalized));
    },

    async rename(target: SshFileTarget, options: SshFileConnectOptions, from: string, to: string): Promise<void> {
      const source = normalizeRemotePath(from, "source path");
      const destination = normalizeRemotePath(to, "destination path");
      return withBrowse(target, options, async (sftp) => {
        const taken = await sftpLstat(sftp, destination).then(
          () => true,
          () => false,
        );
        if (taken) throw new SshFileError("conflict", `${destination} already exists.`, [destination]);
        await sftpRename(sftp, source, destination);
      });
    },

    /** Deletes files and (with `recursive`) folders. Symbolic links are removed, never followed. */
    async remove(
      target: SshFileTarget,
      options: SshFileConnectOptions,
      remotePaths: string[],
      { recursive }: { recursive: boolean },
    ): Promise<{ deleted: number }> {
      const normalized = remotePaths.map((value) => normalizeRemotePath(value));
      if (!normalized.length) throw new SshFileError("io", "Nothing to delete.");
      if (normalized.some((value) => value === "/"))
        throw new SshFileError("permission-denied", "Refusing to delete /.");
      return withBrowse(target, options, async (sftp) => {
        let deleted = 0;
        const removeTree = async (remote: string): Promise<void> => {
          const stats = await sftpLstat(sftp, remote);
          if (!stats.isDirectory()) {
            await sftpUnlink(sftp, remote);
            deleted += 1;
          } else {
            if (!recursive) {
              throw new SshFileError("io", `${remote} is a folder; deleting a folder needs recursive confirmation.`);
            }
            const children = (await sftpReaddir(sftp, remote)).filter(
              (entry) => entry.filename !== "." && entry.filename !== "..",
            );
            for (const child of children) await removeTree(path.posix.join(remote, child.filename));
            await sftpRmdir(sftp, remote);
            deleted += 1;
          }
          if (deleted > SSH_FILE_MAX_DELETE_ENTRIES) {
            throw new SshFileError(
              "limit-exceeded",
              `More than ${SSH_FILE_MAX_DELETE_ENTRIES} items; delete in smaller parts.`,
            );
          }
        };
        for (const remote of normalized) await removeTree(remote);
        return { deleted };
      });
    },

    /** Validates and starts a transfer; resolves with its id at once, the run never depends on the caller. */
    async startTransfer(
      request: Omit<StartSshFileTransfer, "acquire" | "hostId" | "hostLabel"> & {
        target: SshFileTarget;
        connect: SshFileConnectOptions;
      },
    ): Promise<{ transferId: string }> {
      const { target, connect, ...rest } = request;
      return transfers.start({
        ...rest,
        hostId: target.hostId,
        hostLabel: target.hostLabel,
        acquire: () => connections.acquire(target, connect),
      });
    },

    close(): void {
      transfers.cancelAll();
      connections.closeAll();
    },
  };
}

export type SshFileService = ReturnType<typeof createSshFileService>;
