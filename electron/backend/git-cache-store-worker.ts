/// <reference types="node" />
import { parentPort, workerData } from "node:worker_threads";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";

const FORMAT = 8;
const MIN_MIGRATABLE_FORMAT = 7;
const MAX_SUMMARY_BYTES = 2 * 1024 * 1024;
const MAX_STATUS_BYTES = 4 * 1024 * 1024;
const MAX_DETAIL_BYTES = 1024 * 1024;
const MAX_AGE_MS = 180 * 24 * 60 * 60 * 1000;
type Identity = { checkoutRoot: string; gitDir: string; commonDir: string };
type Entry = Identity & {
  rootAliases?: string[];
  validatedAt: number;
  revision: string;
  summary: unknown;
  status?: unknown;
  detail?: unknown;
};
let db: DatabaseSync | null = null;
let initErrorCode = "";
function safeCode(value: unknown): string {
  return typeof value === "string" && /^[A-Z0-9_]{2,40}$/u.test(value) ? value : "UNKNOWN";
}
function safeMessage(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  return value
    .replace(/\b\w+:\/\/[^\s]+/gu, "[redacted-url]")
    .replace(/\b[^\s/@:]+:[^\s/@]+@/gu, "[redacted-credentials]")
    .replace(/(?:[A-Za-z]:\\|\/)[^\s,;]+/gu, "[redacted-path]")
    .slice(0, 160);
}
function key(e: Identity): string {
  return JSON.stringify([e.checkoutRoot, e.gitDir, e.commonDir]);
}
function sanitizeRootAliases(value: unknown, checkoutRoot: string): string[] {
  if (!Array.isArray(value)) return [];
  const result: string[] = [];
  const seen = new Set<string>([checkoutRoot]);
  for (const alias of value) {
    if (typeof alias !== "string" || !alias || alias.length > 16_384) continue;
    if (alias.includes("://") || /[^/\s]+:[^@\s]+@/u.test(alias) || seen.has(alias)) continue;
    seen.add(alias);
    result.push(alias);
    if (result.length === 64) break;
  }
  return result;
}
function json(v: unknown): string {
  return JSON.stringify(v ?? null);
}
function sanitizeStoredEntry(entry: Entry): Entry {
  const source = entry.summary && typeof entry.summary === "object" ? (entry.summary as Record<string, unknown>) : {};
  const summary: Record<string, string | number | null> = {};
  for (const name of ["branch", "upstream", "ahead", "behind", "dirtyCount", "headOid"]) {
    const value = source[name];
    if ((name === "branch" || name === "upstream" || name === "headOid") && typeof value === "string") {
      const text = value.slice(0, 2048);
      if (!text.includes("://") && !/[^/\s]+:[^@\s]+@/u.test(text)) summary[name] = text;
    } else if ((name === "branch" || name === "upstream" || name === "headOid") && value === null) summary[name] = null;
    else if (
      (name === "ahead" || name === "behind" || name === "dirtyCount") &&
      typeof value === "number" &&
      Number.isSafeInteger(value) &&
      value >= 0
    )
      summary[name] = value;
  }
  const safe: Entry = {
    ...entry,
    rootAliases: sanitizeRootAliases(entry.rootAliases, entry.checkoutRoot),
    summary,
  };
  if (entry.status !== undefined) {
    const budget = { remaining: MAX_STATUS_BYTES };
    const input = entry.status;
    const safeStatus = Array.isArray(input)
      ? sanitizeStoredFiles(input, budget)
      : input && typeof input === "object"
        ? Object.fromEntries(
            ["staged", "unstaged", "untracked", "conflicts"].flatMap((name) =>
              Array.isArray((input as Record<string, unknown>)[name])
                ? [[name, sanitizeStoredFiles((input as Record<string, unknown>)[name] as unknown[], budget)]]
                : [],
            ),
          )
        : undefined;
    if (safeStatus !== undefined && Buffer.byteLength(json(safeStatus)) <= MAX_STATUS_BYTES) safe.status = safeStatus;
    else delete safe.status;
  }
  if (entry.detail !== undefined && (!entry.detail || typeof entry.detail !== "object" || Array.isArray(entry.detail)))
    delete safe.detail;
  return safe;
}
function sanitizeStoredFiles(files: unknown[], budget: { remaining: number }): Record<string, string>[] {
  const resultFiles: Record<string, string>[] = [];
  for (const value of files) {
    if (resultFiles.length >= 100_000 || budget.remaining <= 0) break;
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const source = value as Record<string, unknown>;
    const file: Record<string, string> = {};
    for (const name of ["path", "previousPath", "code", "stagedStatus", "unstagedStatus", "kind", "label"]) {
      if (typeof source[name] === "string")
        file[name] = (source[name] as string).slice(0, name === "path" || name === "previousPath" ? 16_384 : 128);
    }
    if (!file.path) continue;
    const bytes = Buffer.byteLength(json(file)) + 1;
    if (bytes > budget.remaining) break;
    budget.remaining -= bytes;
    resultFiles.push(file);
  }
  return resultFiles;
}
function init(): boolean {
  const dbPath = (workerData as { dbPath: string }).dbPath;
  try {
    db = new DatabaseSync(dbPath);
    const tableCount = db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table'").get() as
      { count?: number } | undefined;
    const hasMeta = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='meta'").get();
    if (Number(tableCount?.count ?? 0) > 0) {
      const version = hasMeta
        ? (db.prepare("SELECT value FROM meta WHERE key='format'").get() as { value?: string } | undefined)
        : undefined;
      const storedFormat = Number(version?.value);
      if (version && storedFormat >= MIN_MIGRATABLE_FORMAT && storedFormat < FORMAT) {
        db.exec("PRAGMA foreign_keys=ON; DROP TABLE IF EXISTS checkout_aliases; DROP TABLE IF EXISTS summaries;");
      } else if (!version || storedFormat !== FORMAT) {
        initErrorCode = "INCOMPATIBLE_FORMAT";
        db.close();
        db = null;
        return false;
      }
    }
    db.exec(
      "PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA journal_size_limit=1048576; PRAGMA max_page_count=2304; CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS summaries (id TEXT PRIMARY KEY, checkout_root TEXT NOT NULL, git_dir TEXT NOT NULL, common_dir TEXT NOT NULL, validated_at INTEGER NOT NULL, revision TEXT NOT NULL, body TEXT NOT NULL, summary_body TEXT NOT NULL, status_body TEXT, bytes INTEGER NOT NULL, summary_bytes INTEGER NOT NULL, alias_bytes INTEGER NOT NULL, status_bytes INTEGER NOT NULL, detail_body TEXT, detail_bytes INTEGER NOT NULL DEFAULT 0); CREATE INDEX IF NOT EXISTS summaries_checkout_root_idx ON summaries(checkout_root); CREATE TABLE IF NOT EXISTS checkout_aliases (alias_root TEXT PRIMARY KEY, entry_id TEXT NOT NULL REFERENCES summaries(id) ON DELETE CASCADE); CREATE INDEX IF NOT EXISTS checkout_aliases_entry_id_idx ON checkout_aliases(entry_id);",
    );
    db.prepare("INSERT OR REPLACE INTO meta(key,value) VALUES('format',?)").run(String(FORMAT));
    return true;
  } catch (error) {
    const err = error as { code?: string; errcode?: number };
    initErrorCode = safeCode(err.code);
    if (
      err.errcode !== 11 &&
      err.errcode !== 26 &&
      err.code !== "ERR_SQLITE_NOTADB" &&
      err.code !== "SQLITE_NOTADB" &&
      err.code !== "SQLITE_CORRUPT" &&
      err.code !== "ERR_SQLITE_CORRUPT"
    ) {
      db = null;
      return false;
    }
    try {
      db?.close();
    } catch {
      /* ignore */
    }
    db = null;
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        fs.unlinkSync(dbPath + suffix);
      } catch {
        /* ignore */
      }
    }
    try {
      db = new DatabaseSync(dbPath);
      db.exec(
        "PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA journal_size_limit=1048576; PRAGMA max_page_count=2304; CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL); CREATE TABLE summaries (id TEXT PRIMARY KEY, checkout_root TEXT NOT NULL, git_dir TEXT NOT NULL, common_dir TEXT NOT NULL, validated_at INTEGER NOT NULL, revision TEXT NOT NULL, body TEXT NOT NULL, summary_body TEXT NOT NULL, status_body TEXT, bytes INTEGER NOT NULL, summary_bytes INTEGER NOT NULL, alias_bytes INTEGER NOT NULL, status_bytes INTEGER NOT NULL, detail_body TEXT, detail_bytes INTEGER NOT NULL DEFAULT 0); CREATE INDEX summaries_checkout_root_idx ON summaries(checkout_root); CREATE TABLE checkout_aliases (alias_root TEXT PRIMARY KEY, entry_id TEXT NOT NULL REFERENCES summaries(id) ON DELETE CASCADE); CREATE INDEX checkout_aliases_entry_id_idx ON checkout_aliases(entry_id);",
      );
      db.prepare("INSERT INTO meta VALUES('format',?)").run(String(FORMAT));
      return true;
    } catch {
      db = null;
      return false;
    }
  }
}
function run(op: string, args: unknown): unknown {
  if (op === "ready") {
    initErrorCode = "";
    return { ok: init(), code: initErrorCode || undefined };
  }
  if (!db) return null;
  if (op === "read") {
    const i = args as Identity;
    const row = db
      .prepare(
        "SELECT body, summary_body, status_body, detail_body, checkout_root, git_dir, common_dir, validated_at, revision FROM summaries WHERE id=? AND validated_at>=?",
      )
      .get(key(i), Date.now() - MAX_AGE_MS) as
      | {
          body?: string;
          summary_body?: string;
          status_body?: string | null;
          detail_body?: string | null;
          checkout_root?: string;
          git_dir?: string;
          common_dir?: string;
          validated_at?: number;
          revision?: string;
        }
      | undefined;
    if (!row?.body || !row.summary_body) return null;
    try {
      const body = JSON.parse(row.body) as Omit<Entry, "summary" | "status">;
      const rootAliases = db
        .prepare("SELECT alias_root FROM checkout_aliases WHERE entry_id=? ORDER BY alias_root LIMIT 64")
        .all(key(i)) as { alias_root: string }[];
      const e = {
        ...body,
        rootAliases: rootAliases.map((row) => row.alias_root),
        summary: JSON.parse(row.summary_body),
        ...(row.status_body ? { status: JSON.parse(row.status_body) } : {}),
        ...(row.detail_body ? { detail: JSON.parse(row.detail_body) } : {}),
      } as Entry;
      if (
        e.checkoutRoot !== i.checkoutRoot ||
        e.gitDir !== i.gitDir ||
        e.commonDir !== i.commonDir ||
        row.checkout_root !== i.checkoutRoot ||
        row.git_dir !== i.gitDir ||
        row.common_dir !== i.commonDir ||
        e.revision !== row.revision ||
        typeof e.summary !== "object" ||
        !e.summary ||
        Array.isArray(e.summary) ||
        typeof e.revision !== "string" ||
        !Number.isFinite(row.validated_at)
      )
        return null;
      e.validatedAt = Number(row.validated_at);
      return sanitizeStoredEntry(e);
    } catch {
      return null;
    }
  }
  if (op === "readByRoot") {
    if (typeof args !== "string" || !args) return null;
    const row = db
      .prepare(
        "SELECT s.summary_body, s.status_body, s.detail_body, s.checkout_root, s.git_dir, s.common_dir, s.validated_at, s.revision, s.id FROM summaries s WHERE (s.checkout_root=? OR s.id IN (SELECT entry_id FROM checkout_aliases WHERE alias_root=?)) AND s.validated_at>=? ORDER BY CASE WHEN s.checkout_root=? THEN 0 ELSE 1 END, s.validated_at DESC, s.id DESC LIMIT 1",
      )
      .get(args, args, Date.now() - MAX_AGE_MS, args) as
      | {
          summary_body?: string;
          status_body?: string | null;
          detail_body?: string | null;
          checkout_root?: string;
          git_dir?: string;
          common_dir?: string;
          validated_at?: number;
          revision?: string;
          id?: string;
        }
      | undefined;
    if (!row?.summary_body || typeof row.checkout_root !== "string" || typeof row.id !== "string") return null;
    try {
      const summary = JSON.parse(row.summary_body) as unknown;
      if (!summary || typeof summary !== "object" || Array.isArray(summary)) return null;
      const rootAliases = db
        .prepare("SELECT alias_root FROM checkout_aliases WHERE entry_id=? ORDER BY alias_root LIMIT 64")
        .all(row.id) as { alias_root: string }[];
      return sanitizeStoredEntry({
        checkoutRoot: row.checkout_root,
        gitDir: String(row.git_dir),
        commonDir: String(row.common_dir),
        rootAliases: rootAliases.map((alias) => alias.alias_root),
        revision: String(row.revision),
        validatedAt: Number(row.validated_at),
        summary,
        ...(row.status_body ? { status: JSON.parse(row.status_body) } : {}),
        ...(row.detail_body ? { detail: JSON.parse(row.detail_body) } : {}),
      });
    } catch {
      return null;
    }
  }
  if (op === "write") {
    const entries = args as Entry[];
    db.exec("BEGIN IMMEDIATE");
    try {
      let didChange = false;
      for (const e of entries) {
        const summary = json(e.summary);
        const status = e.status === undefined ? undefined : json(e.status);
        const detailJson = e.detail === undefined ? undefined : json(e.detail);
        const detail =
          detailJson !== undefined && Buffer.byteLength(detailJson) <= MAX_DETAIL_BYTES ? detailJson : undefined;
        if (
          Buffer.byteLength(summary) > MAX_SUMMARY_BYTES ||
          (status !== undefined && Buffer.byteLength(status) > MAX_STATUS_BYTES)
        )
          continue;
        const body = JSON.stringify({
          checkoutRoot: e.checkoutRoot,
          gitDir: e.gitDir,
          commonDir: e.commonDir,
          validatedAt: e.validatedAt,
          revision: e.revision,
        });
        if (Buffer.byteLength(body) > MAX_SUMMARY_BYTES + MAX_STATUS_BYTES) continue;
        const existing = db.prepare("SELECT revision, validated_at FROM summaries WHERE id=?").get(key(e)) as
          { revision?: string; validated_at?: number } | undefined;
        if (existing?.revision === e.revision) {
          const aliases = mergeAliases(key(e), e.checkoutRoot, e.rootAliases);
          const validatedAt =
            e.validatedAt - Number(existing.validated_at ?? 0) >= 60_000
              ? e.validatedAt
              : Number(existing.validated_at ?? e.validatedAt);
          if (aliases.changed || validatedAt !== existing.validated_at)
            didChange =
              db
                .prepare("UPDATE summaries SET validated_at=?, alias_bytes=? WHERE id=?")
                .run(validatedAt, aliases.bytes, key(e)).changes > 0 || didChange;
          continue;
        }
        const summaryBytes = Buffer.byteLength(json(e.summary));
        const summaryBody = json(e.summary);
        const statusBytes = status === undefined ? 0 : Buffer.byteLength(status);
        const detailBytes = detail === undefined ? 0 : Buffer.byteLength(detail);
        db.prepare(
          "INSERT INTO summaries VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET checkout_root=excluded.checkout_root, git_dir=excluded.git_dir, common_dir=excluded.common_dir, validated_at=excluded.validated_at, revision=excluded.revision, body=excluded.body, summary_body=excluded.summary_body, status_body=excluded.status_body, bytes=excluded.bytes, summary_bytes=excluded.summary_bytes, status_bytes=excluded.status_bytes, detail_body=excluded.detail_body, detail_bytes=excluded.detail_bytes",
        ).run(
          key(e),
          e.checkoutRoot,
          e.gitDir,
          e.commonDir,
          e.validatedAt,
          e.revision,
          body,
          summaryBody,
          status ?? null,
          Buffer.byteLength(body),
          summaryBytes,
          0,
          statusBytes,
          detail ?? null,
          detailBytes,
        );
        const aliases = mergeAliases(key(e), e.checkoutRoot, e.rootAliases);
        db.prepare("UPDATE summaries SET alias_bytes=? WHERE id=?").run(aliases.bytes, key(e));
        didChange = true;
      }
      const cutoff = Date.now() - MAX_AGE_MS;
      didChange = db.prepare("DELETE FROM summaries WHERE validated_at < ?").run(cutoff).changes > 0 || didChange;
      didChange = evictStatus() || didChange;
      didChange = evictSummaries() || didChange;
      db.exec("COMMIT");
      if (didChange)
        try {
          db.exec("PRAGMA wal_checkpoint(PASSIVE)");
        } catch {
          /* committed cache writes remain valid */
        }
    } catch (e) {
      try {
        db.exec("ROLLBACK");
      } catch {
        /* ignore */
      }
      throw e;
    }
    return true;
  }
  return null;
}
function mergeAliases(entryId: string, checkoutRoot: string, input: unknown): { bytes: number; changed: boolean } {
  if (!db) return { bytes: 0, changed: false };
  const previous = db
    .prepare("SELECT alias_root FROM checkout_aliases WHERE entry_id=? ORDER BY alias_root LIMIT 64")
    .all(entryId)
    .map((row) => (row as { alias_root: string }).alias_root);
  const aliases = sanitizeRootAliases([...previous, ...sanitizeRootAliases(input, checkoutRoot)], checkoutRoot);
  const next = new Set(aliases);
  let changed = aliases.length !== previous.length || aliases.some((alias, index) => alias !== previous[index]);

  for (const alias of previous) {
    if (!next.has(alias))
      db.prepare("DELETE FROM checkout_aliases WHERE alias_root=? AND entry_id=?").run(alias, entryId);
  }
  for (const alias of aliases) {
    const owner = db.prepare("SELECT entry_id FROM checkout_aliases WHERE alias_root=?").get(alias) as
      { entry_id?: string } | undefined;
    if (owner?.entry_id === entryId) continue;
    if (owner?.entry_id) {
      db.prepare("UPDATE summaries SET alias_bytes=MAX(0,alias_bytes-?) WHERE id=?").run(
        Buffer.byteLength(alias),
        owner.entry_id,
      );
      db.prepare("DELETE FROM checkout_aliases WHERE alias_root=?").run(alias);
    }
    db.prepare("INSERT INTO checkout_aliases(alias_root,entry_id) VALUES(?,?)").run(alias, entryId);
    changed = true;
  }
  return { bytes: aliases.reduce((sum, alias) => sum + Buffer.byteLength(alias), 0), changed };
}
function evictSummaries(): boolean {
  if (!db) return false;
  let changed = false;
  const totalBytes = () =>
    Number(db!.prepare("SELECT COALESCE(SUM(summary_bytes+alias_bytes),0) AS total FROM summaries").get()?.total ?? 0);
  while (totalBytes() > MAX_SUMMARY_BYTES) {
    const oldest = db
      .prepare("SELECT id, summary_bytes FROM summaries ORDER BY validated_at ASC, id ASC LIMIT 1")
      .get() as { id?: string; summary_bytes?: number } | undefined;
    if (!oldest?.id) break;
    const result = db.prepare("DELETE FROM summaries WHERE id=?").run(oldest.id);
    if (!result.changes) break;
    changed = true;
  }
  return changed;
}
function evictStatus(): boolean {
  if (!db) return false;
  let changed = false;
  const totalBytes = () =>
    Number(db!.prepare("SELECT COALESCE(SUM(status_bytes+detail_bytes),0) AS total FROM summaries").get()?.total ?? 0);
  while (totalBytes() > MAX_STATUS_BYTES) {
    const oldest = db
      .prepare(
        "SELECT id, status_bytes FROM summaries WHERE status_bytes + detail_bytes > 0 ORDER BY validated_at ASC, id ASC LIMIT 1",
      )
      .get() as { id?: string; body?: string; status_bytes?: number } | undefined;
    if (!oldest?.id) break;
    const result = db
      .prepare("UPDATE summaries SET status_body=NULL, status_bytes=0, detail_body=NULL, detail_bytes=0 WHERE id=?")
      .run(oldest.id);
    if (!result.changes) break;
    changed = true;
  }
  return changed;
}
parentPort?.on("message", (m: { id: number; op: string; args?: unknown }) => {
  try {
    parentPort?.postMessage({ id: m.id, value: run(m.op, m.args) });
  } catch (e) {
    parentPort?.postMessage({
      id: m.id,
      op: m.op,
      errorCode: safeCode((e as { code?: unknown }).code),
      errorMessage: safeMessage((e as { message?: unknown }).message),
    });
  }
});
