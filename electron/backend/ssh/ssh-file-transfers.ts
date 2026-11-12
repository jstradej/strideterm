import { randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { SFTPWrapper } from "ssh2";
import {
  SSH_FILE_TRANSFER_FINISHED_CHANNEL,
  SSH_FILE_TRANSFER_PROGRESS_CHANNEL,
  type SshFileDirection,
  type SshFileTransferFinished,
  type SshFileTransferProgress,
  type SshFileTransferResult,
  type SshFileTransferRun,
  type SshFileTransfersState,
} from "../../shared/ssh-file-events.js";
import { getLogger } from "../logger.js";
import { SshFileError, toSshFileError } from "./ssh-file-error.js";
import { ownerForLog, type SshFileLease } from "./ssh-file-connections.js";
import {
  sftpLstat,
  sftpMkdir,
  sftpPosixRename,
  sftpReaddir,
  sftpRename,
  sftpStat,
  sftpSupportsPosixRename,
  sftpUnlink,
  sftpUtimes,
} from "./sftp-promises.js";

const log = getLogger("ssh-file");

export const SSH_FILE_RUN_RETENTION_MS = 24 * 60 * 60 * 1000;
export const SSH_FILE_MAX_LAST_RUNS = 50;
export const SSH_FILE_MAX_FILES = 100_000;
export const SSH_FILE_PROGRESS_INTERVAL_MS = 250;
const MAX_SOURCES = 1000;
const MAX_REPORTED_CONFLICTS = 50;

export type SshFileConflictPolicy = "fail" | "overwrite" | "skip";

/** What the caller's access policy allows on the local disk; the transfer itself never decides this. */
export interface SshFileLocalPolicy {
  /** Throws a coded `SshFileError` when a local path may not be read (upload source). */
  assertReadable(absPath: string): Promise<void>;
  /** Throws a coded `SshFileError` when files may not be written below this local directory. */
  assertWritableDir(absDir: string): Promise<void>;
  /** A reason when a downloaded file or folder of this name must not be created locally, else null. */
  rejectsName?(name: string): string | null;
}

export interface StartSshFileTransfer {
  direction: SshFileDirection;
  /** Local absolute paths (upload) or remote POSIX paths (download). */
  sources: string[];
  /** Remote POSIX directory (upload) or local absolute directory (download). */
  destinationDir: string;
  conflict: SshFileConflictPolicy;
  profileId: string;
  workspaceId: string;
  source: "ui" | "mcp";
  /** Groups transfers for per-caller limits and status scoping (an agent grant, a window). */
  ownerKey: string;
  hostId: string;
  hostLabel: string;
  acquire: () => Promise<SshFileLease>;
  local: SshFileLocalPolicy;
  /** Total-size cap, checked once the tree has been walked. */
  maxBytes?: number;
}

interface PlanItem {
  kind: "dir" | "file";
  src: string;
  dst: string;
  size: number;
  mode: number;
  mtimeMs: number;
}

interface TransferRecord {
  run: SshFileTransferRun;
  ownerKey: string;
  cancelRequested: boolean;
  cancel: () => void;
  done: Promise<void>;
}

/** Calls `emit` at most once per `intervalMs`; `flush` always emits the latest value. */
export function createProgressThrottle<T>(emit: (value: T) => void, now: () => number, intervalMs: number) {
  let last = Number.NEGATIVE_INFINITY;
  let pending: T | undefined;
  let hasPending = false;
  return {
    push(value: T): void {
      pending = value;
      hasPending = true;
      if (now() - last >= intervalMs) this.flush();
    },
    flush(): void {
      if (!hasPending) return;
      hasPending = false;
      last = now();
      emit(pending as T);
    },
  };
}

function remoteBase(remotePath: string): string {
  return path.posix.basename(remotePath);
}

const WINDOWS_DEVICE_NAME = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])$/i;

/**
 * Whether a name read from the remote host can become a local file name as-is. On Windows a `:` would write an
 * NTFS alternate data stream of another file, a device name opens the device, and a trailing dot or space is
 * silently dropped (so `.git.` is `.git`).
 */
export function isSafeLocalName(name: string, platform: NodeJS.Platform = process.platform): boolean {
  if (!name || name === "." || name === ".." || /[\\/\0]/.test(name)) return false;
  if (platform !== "win32") return true;

  return (
    !/[<>:"|?*\x00-\x1f]/.test(name) && !/[. ]$/.test(name) && !WINDOWS_DEVICE_NAME.test(name.split(".")[0]!.trimEnd())
  );
}

function partName(name: string): string {
  return `.${name}.strideterm-${randomBytes(4).toString("hex")}.part`;
}

export function createSshFileTransfers({
  emit,
  now = () => Date.now(),
}: {
  emit: (channel: string, payload: unknown) => void;
  now?: () => number;
}) {
  const records = new Map<string, TransferRecord>();

  function prune(): void {
    const cutoff = now() - SSH_FILE_RUN_RETENTION_MS;
    const finished = [...records.values()]
      .filter((record) => record.run.state !== "running")
      .sort((a, b) => Date.parse(b.run.finishedAt ?? "") - Date.parse(a.run.finishedAt ?? ""));
    finished.forEach((record, index) => {
      const at = record.run.finishedAt ? Date.parse(record.run.finishedAt) : 0;
      if (at < cutoff || index >= SSH_FILE_MAX_LAST_RUNS) records.delete(record.run.transferId);
    });
  }

  async function start(request: StartSshFileTransfer): Promise<{ transferId: string }> {
    if (!request.sources.length || request.sources.length > MAX_SOURCES) {
      throw new SshFileError("limit-exceeded", `Choose between 1 and ${MAX_SOURCES} items to transfer.`);
    }
    const lease = await request.acquire();
    let channel: SFTPWrapper;
    try {
      channel = await lease.openChannel();
    } catch (error) {
      lease.release();
      throw error;
    }
    const transferId = randomUUID();
    let finalized = false;
    const releaseAll = () => {
      if (finalized) return;
      finalized = true;
      try {
        channel.end();
      } catch {
        // already closed
      }
      lease.release();
    };

    try {
      await validateTopLevel(request, channel);
    } catch (error) {
      releaseAll();
      throw toSshFileError(error);
    }

    const startedAt = new Date(now()).toISOString();
    const run: SshFileTransferRun = {
      transferId,
      profileId: request.profileId,
      workspaceId: request.workspaceId,
      direction: request.direction,
      source: request.source,
      hostLabel: request.hostLabel,
      state: "running",
      startedAt,
      finishedAt: null,
      bytesDone: 0,
      bytesTotal: 0,
      filesDone: 0,
      filesTotal: 0,
      currentPath: "",
    };

    let cancelNow: () => void = () => {};
    const cancelled = new Promise<never>((_, reject) => {
      cancelNow = () => reject(new SshFileError("cancelled", "The transfer was cancelled."));
    });
    cancelled.catch(() => {});
    const record: TransferRecord = {
      run,
      ownerKey: request.ownerKey,
      cancelRequested: false,
      cancel: () => {
        if (record.cancelRequested) return;
        record.cancelRequested = true;
        try {
          channel.end();
        } catch {
          // already closed
        }
        cancelNow();
      },
      done: Promise.resolve(),
    };
    records.set(transferId, record);
    log.info("ssh file transfer started", {
      transferId,
      profileId: request.profileId,
      owner: ownerForLog(request.ownerKey),
      hostId: request.hostId,
      direction: request.direction,
      sources: request.sources.length,
      conflict: request.conflict,
      source: request.source,
    });

    const throttle = createProgressThrottle<SshFileTransferProgress>(
      (progress) => emit(SSH_FILE_TRANSFER_PROGRESS_CHANNEL, progress),
      now,
      SSH_FILE_PROGRESS_INTERVAL_MS,
    );
    const publishProgress = () =>
      throttle.push({
        transferId,
        profileId: run.profileId,
        bytesDone: run.bytesDone,
        bytesTotal: run.bytesTotal,
        filesDone: run.filesDone,
        filesTotal: run.filesTotal,
        currentPath: run.currentPath,
      });

    const result: SshFileTransferResult = { files: 0, bytes: 0, skipped: [] };
    record.done = (async () => {
      const tmp: { current: { side: "remote" | "local"; path: string } | null } = { current: null };
      try {
        const executor = new TransferExecutor(request, channel, result, run, publishProgress, cancelled, (next) => {
          tmp.current = next;
        });
        await executor.execute();
        run.state = "succeeded";
      } catch (error) {
        const coded = record.cancelRequested
          ? new SshFileError("cancelled", "The transfer was cancelled.")
          : toSshFileError(error);
        run.state = coded.code === "cancelled" ? "cancelled" : "failed";
        if (run.state === "failed") {
          run.error = {
            code: coded.code,
            message: coded.message,
            ...(coded.conflicts ? { conflicts: coded.conflicts } : {}),
          };
        }
        await removeTemp(tmp.current, request, lease);
      } finally {
        releaseAll();
        run.finishedAt = new Date(now()).toISOString();
        run.result = { ...result, skipped: [...result.skipped] };
        run.currentPath = "";
        throttle.flush();
        const finished: SshFileTransferFinished = {
          transferId,
          profileId: run.profileId,
          workspaceId: run.workspaceId,
          direction: run.direction,
          source: run.source,
          hostLabel: run.hostLabel,
          state: run.state as SshFileTransferFinished["state"],
          startedAt: run.startedAt,
          finishedAt: run.finishedAt,
          result: run.result,
          ...(run.error ? { error: run.error } : {}),
        };
        log.info("ssh file transfer finished", {
          transferId,
          hostId: request.hostId,
          direction: run.direction,
          state: run.state,
          files: result.files,
          bytes: result.bytes,
          skipped: result.skipped.length,
          ...(run.error ? { errorCode: run.error.code } : {}),
        });
        prune();
        emit(SSH_FILE_TRANSFER_FINISHED_CHANNEL, finished);
      }
    })();
    return { transferId };
  }

  async function removeTemp(
    tmp: { side: "remote" | "local"; path: string } | null,
    request: StartSshFileTransfer,
    lease: SshFileLease,
  ): Promise<void> {
    if (!tmp) return;
    try {
      if (tmp.side === "local") {
        await fs.rm(tmp.path, { force: true, maxRetries: 8, retryDelay: 50 });
      } else {
        const fresh = await lease.openChannel();
        try {
          await sftpUnlink(fresh, tmp.path).catch(() => {});
        } finally {
          fresh.end();
        }
      }
    } catch (error) {
      log.warn("ssh file transfer could not remove its temporary file", {
        hostId: request.hostId,
        side: tmp.side,
        err: (error as Error).message,
      });
    }
  }

  async function validateTopLevel(request: StartSshFileTransfer, channel: SFTPWrapper): Promise<void> {
    const conflicts: string[] = [];
    const seen = new Set<string>();
    if (request.direction === "upload") {
      await sftpStat(channel, request.destinationDir).then(
        (stats) => {
          if (!stats.isDirectory()) throw new SshFileError("io", `${request.destinationDir} is not a directory.`);
        },
        (error) => {
          throw error instanceof SshFileError ? error : toSshFileError(error);
        },
      );
      for (const source of request.sources) {
        if (!path.isAbsolute(source)) throw new SshFileError("outside-roots", `Not an absolute local path: ${source}`);
        await request.local.assertReadable(source);
        const stats = await fs.lstat(source).catch((error) => {
          throw toSshFileError(error);
        });
        if (stats.isSymbolicLink()) throw new SshFileError("io", `Symbolic links are not transferred: ${source}`);
        if (!stats.isFile() && !stats.isDirectory()) {
          throw new SshFileError("io", `Not a regular file or folder: ${source}`);
        }
        const name = path.basename(source);
        if (seen.has(name)) throw new SshFileError("conflict", `Two items are named "${name}".`, [name]);
        seen.add(name);
        if (request.conflict === "fail") {
          const target = path.posix.join(request.destinationDir, name);
          if (
            await sftpLstat(channel, target).then(
              () => true,
              () => false,
            )
          )
            conflicts.push(target);
        }
      }
    } else {
      if (!path.isAbsolute(request.destinationDir)) {
        throw new SshFileError("outside-roots", `Not an absolute local path: ${request.destinationDir}`);
      }
      await request.local.assertWritableDir(request.destinationDir);
      const destination = await fs.stat(request.destinationDir).catch((error) => {
        throw toSshFileError(error);
      });
      if (!destination.isDirectory()) throw new SshFileError("io", `${request.destinationDir} is not a directory.`);
      for (const source of request.sources) {
        const stats = await sftpLstat(channel, source).catch((error) => {
          throw toSshFileError(error);
        });
        if (stats.isSymbolicLink()) throw new SshFileError("io", `Symbolic links are not transferred: ${source}`);
        const name = remoteBase(source);
        if (!isSafeLocalName(name)) throw new SshFileError("io", `Cannot download "${source}".`);
        const refused = request.local.rejectsName?.(name);
        if (refused) throw new SshFileError("outside-roots", refused);
        if (seen.has(name)) throw new SshFileError("conflict", `Two items are named "${name}".`, [name]);
        seen.add(name);
        if (request.conflict === "fail") {
          const target = path.join(request.destinationDir, name);
          if (
            await fs.lstat(target).then(
              () => true,
              () => false,
            )
          )
            conflicts.push(target);
        }
      }
    }
    if (conflicts.length) {
      throw new SshFileError(
        "conflict",
        `${conflicts.length} item${conflicts.length === 1 ? "" : "s"} already exist.`,
        conflicts.slice(0, MAX_REPORTED_CONFLICTS),
      );
    }
  }

  return {
    start,

    cancel(transferId: string, scope: { profileId?: string }): boolean {
      const record = records.get(transferId);
      if (!record || record.run.state !== "running") return false;
      if (scope.profileId && record.run.profileId !== scope.profileId) return false;
      record.cancel();
      return true;
    },

    get(transferId: string): SshFileTransferRun | undefined {
      prune();
      const record = records.get(transferId);
      return record ? structuredClone(record.run) : undefined;
    },

    ownerOf(transferId: string): string | undefined {
      return records.get(transferId)?.ownerKey;
    },

    runningCount(ownerKey: string): number {
      let count = 0;
      for (const record of records.values())
        if (record.run.state === "running" && record.ownerKey === ownerKey) count += 1;
      return count;
    },

    getPayload(profileId?: string): SshFileTransfersState {
      prune();
      const all = [...records.values()].map((record) => structuredClone(record.run));
      const scoped = profileId ? all.filter((run) => run.profileId === profileId) : all;
      return {
        running: scoped.filter((run) => run.state === "running"),
        lastRuns: scoped
          .filter((run) => run.state !== "running")
          .sort((a, b) => Date.parse(b.finishedAt ?? "") - Date.parse(a.finishedAt ?? "")),
      };
    },

    /** Resolves when every started transfer has finished (tests, shutdown). */
    async idle(): Promise<void> {
      await Promise.all([...records.values()].map((record) => record.done));
    },

    cancelAll(): void {
      for (const record of records.values()) if (record.run.state === "running") record.cancel();
    },
  };
}

class TransferExecutor {
  private bytesBase = 0;

  constructor(
    private readonly request: StartSshFileTransfer,
    private readonly channel: SFTPWrapper,
    private readonly result: SshFileTransferResult,
    private readonly run: SshFileTransferRun,
    private readonly publish: () => void,
    private readonly cancelled: Promise<never>,
    private readonly setTemp: (tmp: { side: "remote" | "local"; path: string } | null) => void,
  ) {}

  async execute(): Promise<void> {
    const items = await this.race(this.plan());
    this.run.filesTotal = items.filter((item) => item.kind === "file").length;
    this.run.bytesTotal = items.reduce((sum, item) => sum + (item.kind === "file" ? item.size : 0), 0);
    if (this.request.maxBytes !== undefined && this.run.bytesTotal > this.request.maxBytes) {
      throw new SshFileError(
        "limit-exceeded",
        `The transfer is ${this.run.bytesTotal} bytes; the limit is ${this.request.maxBytes} bytes.`,
      );
    }
    this.publish();
    const skippedDirs: string[] = [];
    for (const item of items) {
      if (skippedDirs.some((dir) => this.isInside(item.dst, dir))) continue;
      if (item.kind === "dir") {
        if (!(await this.race(this.ensureDirectory(item)))) skippedDirs.push(item.dst);
      } else {
        await this.race(this.transferFile(item));
      }
    }
  }

  private race<T>(work: Promise<T>): Promise<T> {
    return Promise.race([work, this.cancelled]);
  }

  private isInside(child: string, parent: string): boolean {
    const separator = this.request.direction === "upload" ? "/" : path.sep;
    return child.startsWith(parent.endsWith(separator) ? parent : parent + separator);
  }

  private skip(pathLabel: string, reason: string): void {
    this.result.skipped.push({ path: pathLabel, reason });
  }

  private async plan(): Promise<PlanItem[]> {
    const items: PlanItem[] = [];
    const add = (item: PlanItem) => {
      items.push(item);
      if (items.length > SSH_FILE_MAX_FILES) {
        throw new SshFileError("limit-exceeded", `More than ${SSH_FILE_MAX_FILES} items would be transferred.`);
      }
    };
    for (const source of this.request.sources) {
      if (this.request.direction === "upload") {
        await this.walkLocal(source, path.posix.join(this.request.destinationDir, path.basename(source)), add);
      } else {
        await this.walkRemote(source, path.join(this.request.destinationDir, remoteBase(source)), add);
      }
    }
    return items;
  }

  private async walkLocal(src: string, dst: string, add: (item: PlanItem) => void): Promise<void> {
    const stats = await fs.lstat(src);
    if (stats.isSymbolicLink()) return this.skip(src, "symbolic link");
    if (stats.isDirectory()) {
      add({ kind: "dir", src, dst, size: 0, mode: stats.mode & 0o777, mtimeMs: stats.mtimeMs });
      const names = (await fs.readdir(src)).sort();
      for (const name of names) await this.walkLocal(path.join(src, name), path.posix.join(dst, name), add);
    } else if (stats.isFile()) {
      add({ kind: "file", src, dst, size: stats.size, mode: stats.mode & 0o777, mtimeMs: stats.mtimeMs });
    } else {
      this.skip(src, "not a regular file");
    }
  }

  private async walkRemote(src: string, dst: string, add: (item: PlanItem) => void): Promise<void> {
    const stats = await sftpLstat(this.channel, src);
    const mode = (stats.mode ?? 0) & 0o777;
    const mtimeMs = (stats.mtime ?? 0) * 1000;
    if (stats.isSymbolicLink()) return this.skip(src, "symbolic link");
    if (stats.isDirectory()) {
      add({ kind: "dir", src, dst, size: 0, mode, mtimeMs });
      const entries = (await sftpReaddir(this.channel, src)).filter(
        (entry) => entry.filename !== "." && entry.filename !== "..",
      );
      entries.sort((a, b) => a.filename.localeCompare(b.filename));
      for (const entry of entries) {
        if (!isSafeLocalName(entry.filename)) {
          this.skip(path.posix.join(src, entry.filename), "unsafe file name");
          continue;
        }
        const refused = this.request.local.rejectsName?.(entry.filename);
        if (refused) {
          this.skip(path.posix.join(src, entry.filename), refused);
          continue;
        }
        await this.walkRemote(path.posix.join(src, entry.filename), path.join(dst, entry.filename), add);
      }
    } else if (stats.isFile()) {
      add({ kind: "file", src, dst, size: stats.size ?? 0, mode, mtimeMs });
    } else {
      this.skip(src, "not a regular file");
    }
  }

  private async exists(target: string): Promise<"none" | "file" | "dir" | "other"> {
    try {
      const stats =
        this.request.direction === "upload" ? await sftpLstat(this.channel, target) : await fs.lstat(target);
      if (stats.isDirectory()) return "dir";
      return stats.isFile() ? "file" : "other";
    } catch (error) {
      const coded = toSshFileError(error);
      if (coded.code === "not-found") return "none";
      throw coded;
    }
  }

  /** Creates the directory (mkdir -p for one level; parents were planned first). False when it must be skipped. */
  private async ensureDirectory(item: PlanItem): Promise<boolean> {
    const kind = await this.exists(item.dst);
    if (kind === "dir") {
      if (this.request.direction === "download") {
        const stats = await fs.lstat(item.dst);
        if (stats.isSymbolicLink()) {
          this.skip(item.dst, "symbolic link in destination");
          return false;
        }
        return this.localDirectoryAllowed(item.dst);
      }
      return true;
    }
    if (kind !== "none") {
      this.skip(item.dst, "a file with this name exists");
      return false;
    }
    if (this.request.direction === "upload") {
      await sftpMkdir(this.channel, item.dst, item.mode || 0o755);
      return true;
    }
    await fs.mkdir(item.dst, { mode: item.mode || 0o755 });
    return this.localDirectoryAllowed(item.dst);
  }

  /** The policy judges the real directory: an existing name can be an alias of one it refuses (e.g. `GIT~1`). */
  private async localDirectoryAllowed(dir: string): Promise<boolean> {
    try {
      await this.request.local.assertWritableDir(dir);
      return true;
    } catch (error) {
      if (!(error instanceof SshFileError)) throw error;
      this.skip(dir, error.message);
      return false;
    }
  }

  private async transferFile(item: PlanItem): Promise<void> {
    this.run.currentPath = item.src;
    const existing = await this.exists(item.dst);
    if (existing !== "none") {
      if (this.request.conflict === "fail") {
        throw new SshFileError("conflict", "An item appeared at the destination during the transfer.", [item.dst]);
      }
      if (existing !== "file") {
        this.skip(item.dst, existing === "dir" ? "a folder with this name exists" : "not a regular file");
        return this.advance(item);
      }
      if (this.request.conflict === "skip") {
        this.skip(item.dst, "already exists");
        return this.advance(item);
      }
    }
    if (this.request.direction === "upload") await this.upload(item, existing === "file");
    else await this.download(item);
    this.result.files += 1;
    this.result.bytes += item.size;
    this.advance(item);
  }

  private advance(item: PlanItem): void {
    this.bytesBase += item.size;
    this.run.bytesDone = this.bytesBase;
    this.run.filesDone += 1;
    this.publish();
  }

  private step(item: PlanItem) {
    return (transferred: number) => {
      this.run.bytesDone = Math.min(this.bytesBase + transferred, this.run.bytesTotal);
      this.run.currentPath = item.src;
      this.publish();
    };
  }

  private async upload(item: PlanItem, overwrite: boolean): Promise<void> {
    const dir = path.posix.dirname(item.dst);
    const tmp = path.posix.join(dir, partName(path.posix.basename(item.dst)));
    this.setTemp({ side: "remote", path: tmp });
    const step = this.step(item);
    await new Promise<void>((resolve, reject) => {
      this.channel.fastPut(item.src, tmp, { mode: item.mode || 0o644, step: (done: number) => step(done) }, (error) =>
        error ? reject(error) : resolve(),
      );
    });
    const mtime = Math.floor(item.mtimeMs / 1000);
    await sftpUtimes(this.channel, tmp, mtime, mtime).catch(() => {});
    if (overwrite) {
      if (sftpSupportsPosixRename(this.channel)) await sftpPosixRename(this.channel, tmp, item.dst);
      else {
        await sftpUnlink(this.channel, item.dst);
        await sftpRename(this.channel, tmp, item.dst);
      }
    } else {
      await sftpRename(this.channel, tmp, item.dst);
    }
    this.setTemp(null);
  }

  private async download(item: PlanItem): Promise<void> {
    const tmp = path.join(path.dirname(item.dst), partName(path.basename(item.dst)));
    this.setTemp({ side: "local", path: tmp });
    const step = this.step(item);
    await new Promise<void>((resolve, reject) => {
      this.channel.fastGet(item.src, tmp, { mode: item.mode || 0o644, step: (done: number) => step(done) }, (error) =>
        error ? reject(error) : resolve(),
      );
    });
    const mtime = new Date(item.mtimeMs);
    await fs.utimes(tmp, mtime, mtime).catch(() => {});
    await fs.chmod(tmp, item.mode || 0o644).catch(() => {});
    await fs.rename(tmp, item.dst);
    this.setTemp(null);
  }
}

export type SshFileTransfers = ReturnType<typeof createSshFileTransfers>;
