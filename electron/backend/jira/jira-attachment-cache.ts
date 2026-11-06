import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export interface JiraAttachmentCacheEntry {
  mediaType: string;
  bytes: Uint8Array;
}

export interface JiraAttachmentCache {
  get(
    connectionId: string,
    binding: string,
    issueId: string,
    attachmentId: string,
  ): Promise<JiraAttachmentCacheEntry | null>;
  put(
    connectionId: string,
    binding: string,
    issueId: string,
    attachmentId: string,
    entry: JiraAttachmentCacheEntry,
  ): Promise<void>;
  removeConnection(connectionId: string): Promise<void>;
}

const DEFAULT_MAX_TOTAL_BYTES = 200 * 1024 * 1024;
const DEFAULT_MAX_AGE_MS = 7 * 24 * 60 * 60_000;

function sha(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * Bytes are keyed by (connection, credential binding, issue, attachment): the issue is part of the key so a hit
 * never serves an attachment to a caller that named a different issue than the one it was verified against, and the
 * binding (the manager's credential-aware scope) makes a changed credential miss. An entry older than the max age is
 * a miss and is removed. Files are owner-only. Every failure degrades to a cache miss.
 */
export function createJiraAttachmentCache(
  rootDir: string,
  options: { maxTotalBytes?: number; maxAgeMs?: number; now?: () => number } = {},
): JiraAttachmentCache {
  const maxTotalBytes = options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;
  const maxAgeMs = options.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
  const now = options.now ?? Date.now;
  const connectionDir = (connectionId: string) => path.join(rootDir, sha(connectionId));
  const filePath = (connectionId: string, binding: string, issueId: string, attachmentId: string) =>
    path.join(connectionDir(connectionId), sha(JSON.stringify([connectionId, binding, issueId, attachmentId])));

  async function evict(): Promise<void> {
    const files: Array<{ file: string; size: number; mtimeMs: number }> = [];
    for (const dir of await fs.readdir(rootDir, { withFileTypes: true })) {
      if (!dir.isDirectory()) continue;
      const dirPath = path.join(rootDir, dir.name);
      for (const name of await fs.readdir(dirPath)) {
        if (name.endsWith(".tmp")) continue;
        const file = path.join(dirPath, name);
        const stat = await fs.stat(file).catch(() => null);
        if (stat?.isFile()) files.push({ file, size: stat.size, mtimeMs: stat.mtimeMs });
      }
    }
    let total = files.reduce((sum, item) => sum + item.size, 0);
    files.sort((a, b) => a.mtimeMs - b.mtimeMs);
    for (const item of files) {
      if (total <= maxTotalBytes) break;
      await fs.rm(item.file, { force: true });
      total -= item.size;
    }
  }

  return {
    async get(connectionId, binding, issueId, attachmentId) {
      try {
        const file = filePath(connectionId, binding, issueId, attachmentId);
        const data = await fs.readFile(file);
        const newline = data.indexOf(10);
        if (newline <= 0) return null;
        const header = data.subarray(0, newline).toString("utf8");
        const space = header.indexOf(" ");
        const fetchedAt = Number(header.slice(0, space));
        const mediaType = header.slice(space + 1);
        if (space <= 0 || !Number.isFinite(fetchedAt) || !mediaType) return null;
        if (now() - fetchedAt >= maxAgeMs) {
          await fs.rm(file, { force: true });
          return null;
        }
        const touched = new Date();
        await fs.utimes(file, touched, touched).catch(() => undefined);
        return { mediaType, bytes: new Uint8Array(data.subarray(newline + 1)) };
      } catch {
        return null;
      }
    },
    async put(connectionId, binding, issueId, attachmentId, entry) {
      try {
        if (entry.bytes.byteLength > maxTotalBytes || /[\r\n]/.test(entry.mediaType)) return;
        const file = filePath(connectionId, binding, issueId, attachmentId);
        await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
        await fs.chmod(rootDir, 0o700).catch(() => undefined);
        await fs.chmod(path.dirname(file), 0o700).catch(() => undefined);
        const tmp = `${file}.${randomUUID()}.tmp`;
        await fs.writeFile(
          tmp,
          Buffer.concat([Buffer.from(`${now()} ${entry.mediaType}\n`, "utf8"), Buffer.from(entry.bytes)]),
          { mode: 0o600 },
        );
        await fs.rename(tmp, file);
        await evict();
      } catch {
        // A cache write must never fail the request that produced the bytes.
      }
    },
    async removeConnection(connectionId) {
      try {
        await fs.rm(connectionDir(connectionId), { recursive: true, force: true });
      } catch {
        // Best-effort cleanup; entries are keyed by connection and unreachable once it is gone.
      }
    },
  };
}
