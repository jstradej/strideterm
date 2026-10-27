/// <reference types="node" />
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";

export interface GitCacheIdentity {
  checkoutRoot: string;
  gitDir: string;
  commonDir: string;
}
export interface GitCacheSummary {
  branch?: string | null;
  upstream?: string | null;
  ahead?: number;
  behind?: number;
  dirtyCount?: number;
  headOid?: string | null;
}
export interface GitCacheEntry extends GitCacheIdentity {
  rootAliases?: string[];
  validatedAt: number;
  revision: string;
  summary: GitCacheSummary;
  status?: unknown;
}
export type GitCacheSummaryEntry = Omit<GitCacheEntry, "status">;
interface Pending {
  id: number;
  op: string;
  args?: unknown;
}
function safeMessage(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  return value
    .replace(/\b\w+:\/\/[^\s]+/gu, "[redacted-url]")
    .replace(/\b[^\s/@:]+:[^\s/@]+@/gu, "[redacted-credentials]@")
    .replace(/(?:[A-Za-z]:\\|\/)[^\s,;]+/gu, "[redacted-path]")
    .slice(0, 160);
}
function safeCode(value: unknown): string | undefined {
  return typeof value === "string" && /^[A-Z0-9_]{2,40}$/u.test(value) ? value : undefined;
}
const measuredEntryBytes = new WeakMap<GitCacheEntry, number>();
function entryBytes(entry: GitCacheEntry): number {
  return measuredEntryBytes.get(entry) ?? byteSize(entry);
}

export class GitCacheStore {
  private static readonly OP_TIMEOUT_MS = 9_000;
  private static readonly MAX_BUFFER_BYTES = 8 * 1024 * 1024;
  private static readonly MAX_BUFFER_ENTRIES = 1000;
  private worker: Worker | null = null;
  private nextId = 1;
  private pending = new Map<number, (value: unknown) => void>();
  private writes = new Map<string, GitCacheEntry>();
  private writeBytes = 0;
  private inFlightWriteCount = 0;
  private inFlightFlush: Promise<void> | null = null;
  private writeTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  private closeDeadlineExpired = false;
  private readonly ready: Promise<void>;
  private readonly warnedAt = new Map<string, number>();
  private warn(
    message: string,
    operation: string,
    code?: unknown,
    detail?: unknown,
    counts?: { pendingRequests?: number; pendingWrites?: number; inFlightWrites?: number },
  ): void {
    const now = Date.now();
    if (now - (this.warnedAt.get(operation) ?? 0) < 60_000) return;
    this.warnedAt.set(operation, now);
    const safeDetail = safeMessage(detail);
    try {
      this.logger.warn?.(message, {
        operation,
        code: safeCode(code),
        ...(safeDetail ? { detail: safeDetail } : {}),
        ...counts,
      });
    } catch {
      /* logging must not change cache fail-open behavior */
    }
  }
  constructor(
    dataDir: string,
    private readonly logger: { warn?: (message: string, meta?: unknown) => void } = {},
  ) {
    this.ready = (async () => {
      try {
        const dir = path.join(dataDir, "cache");
        await fs.mkdir(dir, { recursive: true });
        const jsUrl = new URL("./git-cache-store-worker.js", import.meta.url);
        let workerUrl = jsUrl;
        try {
          await fs.access(fileURLToPath(jsUrl));
        } catch {
          workerUrl = new URL("./git-cache-store-worker.ts", import.meta.url);
        }
        this.worker = new Worker(workerUrl, {
          workerData: { dbPath: path.join(dir, "git-cache.sqlite") },
          execArgv: workerUrl.pathname.endsWith(".ts") ? ["--import", "tsx"] : undefined,
        });
        if (this.closeDeadlineExpired) {
          const worker = this.worker;
          this.worker = null;
          await worker.terminate();
          return;
        }
        this.worker.unref();
        this.worker.on(
          "message",
          (m: { id: number; op?: string; value?: unknown; errorCode?: string; errorMessage?: string }) => {
            const resolve = this.pending.get(m.id);
            if (!resolve) return;
            this.pending.delete(m.id);
            if (m.errorCode)
              this.warn("Git cache operation failed", m.op ?? "worker request", m.errorCode, m.errorMessage);
            resolve(m.value ?? null);
          },
        );
        this.worker.on("error", (e) => {
          this.warn(
            "Git cache worker failed",
            "worker",
            (e as { code?: unknown }).code,
            e instanceof Error ? e.message : undefined,
          );
          for (const done of this.pending.values()) done(null);
          this.pending.clear();
          this.worker = null;
        });
        this.worker.on("exit", () => {
          if (this.worker) {
            this.warn("Git cache worker exited unexpectedly", "worker", "WORKER_EXIT");
            this.worker = null;
          }
          for (const done of this.pending.values()) done(null);
          this.pending.clear();
        });
        const result = (await this.call("ready")) as { ok?: boolean; code?: string } | null;
        if (!result?.ok) {
          this.logger.warn?.("Git cache database unavailable", { code: safeCode(result?.code) });
          const worker = this.worker;
          this.worker = null;
          await worker.terminate();
        } else if (result.code) {
          this.logger.warn?.("Git cache database recovered", { code: safeCode(result.code) });
        }
      } catch (e) {
        this.logger.warn?.("Git cache unavailable", { code: safeCode((e as { code?: unknown })?.code) });
      }
    })();
  }
  async read(identity: GitCacheIdentity): Promise<GitCacheEntry | null> {
    const pendingWrite = this.writes.get(identityKey(identity));
    if (pendingWrite) return structuredClone(pendingWrite);
    await this.ready;
    if (this.closed || !this.worker) return null;
    return (await this.call("read", identity)) as GitCacheEntry | null;
  }
  async readByRoot(checkoutRoot: string): Promise<GitCacheSummaryEntry | null> {
    await this.ready;
    if (this.closed || !this.worker || !checkoutRoot) return null;
    return (await this.call("readByRoot", checkoutRoot)) as GitCacheSummaryEntry | null;
  }
  write(entry: GitCacheEntry): void {
    if (this.closed) return;
    const copy = boundedEntry(entry);
    if (!copy) return;
    const key = identityKey(entry);
    const prior = this.writes.get(key);
    if (this.writes.size >= GitCacheStore.MAX_BUFFER_ENTRIES && !prior) return;
    if (this.writeBytes - (prior ? entryBytes(prior) : 0) + entryBytes(copy) > GitCacheStore.MAX_BUFFER_BYTES) return;
    if (prior) this.writeBytes -= entryBytes(prior);
    this.writes.set(key, copy);
    this.writeBytes += entryBytes(copy);
    if (!this.writeTimer) {
      this.writeTimer = setTimeout(() => {
        this.writeTimer = null;
        void this.flushWrites();
      }, 150);
      this.writeTimer.unref?.();
    }
  }
  async close(timeoutMs = 10_000): Promise<void> {
    this.closed = true;
    if (this.writeTimer) clearTimeout(this.writeTimer);
    this.writeTimer = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let flushed = false;
    await Promise.race([
      this.ready
        .then(() => this.flushWrites())
        .then(() => {
          flushed = true;
        }),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
      }),
    ]);
    if (timer) clearTimeout(timer);
    if (!flushed) {
      this.closeDeadlineExpired = true;
      this.warn("Git cache close timed out", "close", "TIMEOUT", undefined, {
        pendingRequests: this.pending.size,
        pendingWrites: this.writes.size + this.inFlightWriteCount,
        inFlightWrites: this.inFlightWriteCount,
      });
    }
    const worker = this.worker;
    this.worker = null;
    await worker?.terminate();
  }
  private async flushWrites(): Promise<void> {
    if (this.inFlightFlush) return this.inFlightFlush;
    this.inFlightFlush = (async () => {
      await this.ready;
      while (this.worker && this.writes.size) {
        const batch = [...this.writes.values()];
        this.writes.clear();
        this.writeBytes = 0;
        this.inFlightWriteCount += batch.length;
        let remainingWrites = batch.length;
        try {
          for (const entry of batch) {
            if (!this.worker) break;
            await this.call("write", [entry]);
            this.inFlightWriteCount--;
            remainingWrites--;
          }
        } finally {
          this.inFlightWriteCount -= remainingWrites;
        }
      }
    })().finally(() => {
      this.inFlightFlush = null;
    });
    return this.inFlightFlush;
  }
  private call(op: string, args?: unknown): Promise<unknown> {
    if (!this.worker) return Promise.resolve(null);
    const id = this.nextId++;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        finish(null);
        this.warn("Git cache operation timed out", op, "TIMEOUT");
      }, GitCacheStore.OP_TIMEOUT_MS);
      const finish = (value: unknown) => {
        clearTimeout(timer);
        this.pending.delete(id);
        resolve(value);
      };
      this.pending.set(id, finish);
      try {
        this.worker!.postMessage({ id, op, args } satisfies Pending);
      } catch (error) {
        const caught = error as { name?: unknown; code?: unknown; message?: unknown };
        this.warn(
          "Git cache request could not be sent",
          op,
          caught.code ?? "POST_MESSAGE",
          caught.message ?? caught.name,
        );
        finish(null);
      }
    });
  }
}
function byteSize(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value));
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}
function boundedEntry(entry: GitCacheEntry): GitCacheEntry | null {
  try {
    if (
      !entry ||
      typeof entry.checkoutRoot !== "string" ||
      typeof entry.gitDir !== "string" ||
      typeof entry.commonDir !== "string" ||
      entry.checkoutRoot.length > 16_384 ||
      entry.gitDir.length > 16_384 ||
      entry.commonDir.length > 16_384 ||
      typeof entry.revision !== "string" ||
      !Number.isFinite(entry.validatedAt)
    )
      return null;
    const summary = entry.summary ?? {};
    const allowed = ["branch", "upstream", "ahead", "behind", "dirtyCount", "headOid"] as const;
    const small: GitCacheSummary = {};
    for (const k of allowed) {
      const v = summary[k];
      if (v === undefined) continue;
      if ((k === "branch" || k === "upstream" || k === "headOid") && (typeof v === "string" || v === null)) {
        const text = typeof v === "string" ? v.slice(0, 2048) : v;
        if (typeof text !== "string" || (!text.includes("://") && !/[^/\s]+:[^@\s]+@/u.test(text)))
          (small as Record<string, unknown>)[k] = text;
      } else if (
        (k === "ahead" || k === "behind" || k === "dirtyCount") &&
        typeof v === "number" &&
        Number.isSafeInteger(v) &&
        v >= 0
      ) {
        (small as Record<string, unknown>)[k] = v;
      }
    }
    const copy: GitCacheEntry = {
      checkoutRoot: entry.checkoutRoot.slice(0, 16384),
      gitDir: entry.gitDir.slice(0, 16384),
      commonDir: entry.commonDir.slice(0, 16384),
      rootAliases: sanitizeRootAliases(entry.rootAliases, entry.checkoutRoot),
      validatedAt: entry.validatedAt,
      revision: entry.revision.slice(0, 256),
      summary: small,
    };
    let statusSize = 0;
    if (entry.status !== undefined) {
      const status = sanitizeStatus(entry.status);
      if (status !== undefined) {
        const encoded = JSON.stringify(status);
        statusSize = Buffer.byteLength(encoded);
        if (statusSize <= 4 * 1024 * 1024) copy.status = status;
        else statusSize = 0;
      }
    }
    const totalSize =
      byteSize({
        checkoutRoot: copy.checkoutRoot,
        gitDir: copy.gitDir,
        commonDir: copy.commonDir,
        validatedAt: copy.validatedAt,
        revision: copy.revision,
        summary: copy.summary,
      }) + statusSize;
    if (totalSize > 2 * 1024 * 1024 + 4 * 1024 * 1024) return null;
    measuredEntryBytes.set(copy, totalSize);
    return copy;
  } catch {
    return null;
  }
}
function sanitizeRootAliases(value: unknown, checkoutRoot: string): string[] {
  if (!Array.isArray(value)) return [];
  const result: string[] = [];
  const seen = new Set<string>([checkoutRoot]);
  for (const alias of value) {
    if (typeof alias !== "string" || alias.length === 0 || alias.length > 16_384) continue;
    if (alias.includes("://") || /[^/\s]+:[^@\s]+@/u.test(alias) || seen.has(alias)) continue;
    seen.add(alias);
    result.push(alias);
    if (result.length === 64) break;
  }
  return result;
}
function sanitizeStatus(value: unknown): unknown | undefined {
  const budget = { remaining: 4 * 1024 * 1024 };
  if (Array.isArray(value)) return sanitizeFiles(value, budget);
  if (!value || typeof value !== "object") return undefined;
  const source = value as Record<string, unknown>;
  const result: Record<string, unknown[]> = {};
  for (const key of ["staged", "unstaged", "untracked", "conflicts"]) {
    if (Array.isArray(source[key])) result[key] = sanitizeFiles(source[key] as unknown[], budget);
  }
  return Object.keys(result).length ? result : undefined;
}
function sanitizeFiles(files: unknown[], budget: { remaining: number }): unknown[] {
  const resultFiles: unknown[] = [];
  for (const file of files) {
    if (resultFiles.length >= 100_000 || budget.remaining <= 0) break;
    if (!file || typeof file !== "object" || Array.isArray(file)) continue;
    const source = file as Record<string, unknown>;
    const result: Record<string, string> = {};
    for (const key of ["path", "previousPath", "code", "stagedStatus", "unstagedStatus", "kind", "label"]) {
      const field = source[key];
      if (typeof field === "string")
        result[key] = field.slice(0, key === "path" || key === "previousPath" ? 16_384 : 128);
    }
    if (!result.path) continue;
    const bytes = byteSize(result) + 1;
    if (bytes > budget.remaining) break;
    budget.remaining -= bytes;
    resultFiles.push(result);
  }
  return resultFiles;
}
function identityKey(i: GitCacheIdentity): string {
  return `${i.checkoutRoot}\0${i.gitDir}\0${i.commonDir}`;
}
