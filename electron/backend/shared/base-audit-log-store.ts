/// <reference types="node" />
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { getLogger } from "../logger.js";

const log = getLogger("audit-log");

/**
 * Strip sensitive information (tokens) from a URL for safe storage.
 */
function sanitizeUrl(url: string): string {
  try {
    const u = new URL(url);
    u.searchParams.delete("access_token");
    u.searchParams.delete("token");
    return u.toString();
  } catch {
    return url || "";
  }
}

const MAX_RETENTION_DAYS = 30;
/**
 * How many ids one delete may name. SQLite has its own bound-parameter limit
 * and this stays well under it; the viewer pages in far smaller batches, so
 * the cap is a backstop rather than something a user can reach by selecting.
 */
const MAX_DELETE_IDS = 500;

interface ProviderColumn {
  name: string;
  default: string;
}

interface AuditLogEntry {
  timestamp?: string;
  connectionId?: string;
  operation?: string;
  category?: string;
  method?: string;
  url?: string;
  statusCode?: number | null;
  success?: boolean;
  errorMessage?: string | null;
  durationMs?: number | null;
  resourceType?: string;
  resourceId?: string;
  summary?: string;
  userInitiated?: boolean;
  [key: string]: unknown;
}

/**
 * What may be removed from a trail, and nothing wider.
 *
 * Two shapes only — an explicit list of `ids`, or `all: true`. There is no
 * "delete what matches this search", because the row a stale search box would
 * take with it is exactly the row the user did not mean to lose. Both shapes
 * are still narrowed by `providerFilters`, so a per-profile clear can never
 * reach another profile's rows.
 */
interface AuditLogDelete {
  ids?: number[];
  all?: boolean;
  providerFilters?: Record<string, string | number | boolean | null | undefined>;
}

interface AuditLogFilters {
  from?: string;
  to?: string;
  /**
   * Keyset cursors on `id` — exclusive on both ends (`id > afterId`,
   * `id < beforeId`).
   *
   * `from`/`to` are timestamp filters and cannot page this table. They are
   * INCLUSIVE, while the rows come back `ORDER BY id DESC`: a page whose rows
   * all share one millisecond is returned again unchanged when the caller asks
   * for `to: <oldest seen>`, and a row written in the same millisecond as the
   * boundary is either duplicated or skipped depending on which side of the
   * cut it lands. `id` is unique, monotonic and IS the sort key, so a walk
   * keyed on it can neither repeat a page nor step over a row — which is what
   * the notification back-fill needs to prove it closed a gap.
   */
  afterId?: number;
  beforeId?: number;
  category?: string;
  connectionId?: string;
  success?: boolean;
  operation?: string;
  userInitiated?: boolean;
  search?: string;
  limit?: number;
  offset?: number;
  /**
   * Exact-match filters on provider-specific columns, e.g.
   * `{ profile_id: "work" }`. Keys not declared in `providerColumns` are
   * ignored, so a caller can never smuggle SQL through this.
   */
  providerFilters?: Record<string, string>;
}

interface AuditLogStoreConfig {
  tableName: string;
  indexPrefix: string;
  providerColumns: ProviderColumn[];
  mapEntryToProviderValues: (entry: AuditLogEntry) => (string | number | null)[];
  mapRowToProviderFields: (row: Record<string, unknown>) => Record<string, unknown>;
  searchFields: string[];
}

/**
 * Generic audit-log store factory.
 *
 * Provider-specific stores (Azure DevOps, GitHub) call this with a config
 * that describes the table name, extra columns, and field mappings.
 */
export function createAuditLogStore(databasePath: string, config: AuditLogStoreConfig) {
  const { tableName, indexPrefix, providerColumns, mapEntryToProviderValues, mapRowToProviderFields, searchFields } =
    config;

  mkdirSync(dirname(databasePath), { recursive: true });
  const db = new DatabaseSync(databasePath);

  // Build column definitions for provider-specific fields
  const providerColDefs = providerColumns.map((c) => `${c.name} TEXT NOT NULL DEFAULT ''`).join(",\n      ");
  const providerColNames = providerColumns.map((c) => c.name).join(", ");
  const providerPlaceholders = providerColumns.map(() => "?").join(", ");

  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;

    CREATE TABLE IF NOT EXISTS ${tableName} (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL,
      connection_id TEXT NOT NULL DEFAULT '',
      ${providerColDefs},
      operation TEXT NOT NULL DEFAULT '',
      category TEXT NOT NULL DEFAULT 'read',
      method TEXT NOT NULL DEFAULT 'GET',
      url TEXT NOT NULL DEFAULT '',
      status_code INTEGER,
      success INTEGER NOT NULL DEFAULT 1,
      error_message TEXT,
      duration_ms INTEGER,
      resource_type TEXT DEFAULT '',
      resource_id TEXT DEFAULT '',
      summary TEXT DEFAULT '',
      user_initiated INTEGER NOT NULL DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_${indexPrefix}_timestamp ON ${tableName}(timestamp);
    CREATE INDEX IF NOT EXISTS idx_${indexPrefix}_category ON ${tableName}(category);
    CREATE INDEX IF NOT EXISTS idx_${indexPrefix}_connection ON ${tableName}(connection_id);
  `);

  // `CREATE TABLE IF NOT EXISTS` is a no-op against a database created by an
  // earlier build, so a provider column added later would never exist and
  // every insert would fail with "column count mismatch". Add the missing ones
  // in place — TEXT NOT NULL DEFAULT '' backfills existing rows.
  try {
    const existing = new Set(
      (db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name?: unknown }>).map((c) => String(c.name)),
    );
    for (const column of providerColumns) {
      if (existing.has(column.name)) continue;
      db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${column.name} TEXT NOT NULL DEFAULT ''`);
      log.info("added missing audit column", { tableName, column: column.name });
    }
  } catch (err) {
    log.warn("audit column migration failed", { tableName, err: (err as Error)?.message || String(err) });
  }

  const insertStmt = db.prepare(`
    INSERT INTO ${tableName}
      (timestamp, connection_id, ${providerColNames}, operation, category, method, url,
       status_code, success, error_message, duration_ms, resource_type, resource_id, summary, user_initiated)
    VALUES (?, ?, ${providerPlaceholders}, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const countStmt = db.prepare(`SELECT COUNT(*) as total FROM ${tableName}`);

  /**
   * Insert one entry. Returns whether it was actually written.
   *
   * Most callers log-and-forget (an audit row is a side-effect of an action
   * that already happened), which is why a failure is swallowed and warned
   * rather than thrown. The return value exists for the one caller where the
   * row is a PRECONDITION rather than a record: permission auto-approval
   * refuses to approve anything it could not write down.
   */
  function logEntry(entry: AuditLogEntry): boolean {
    try {
      const providerValues = mapEntryToProviderValues(entry);
      insertStmt.run(
        entry.timestamp || new Date().toISOString(),
        entry.connectionId || "",
        ...providerValues,
        entry.operation || "",
        entry.category || "read",
        entry.method || "GET",
        sanitizeUrl(String(entry.url || "")),
        entry.statusCode ?? null,
        entry.success !== false ? 1 : 0,
        entry.errorMessage || null,
        entry.durationMs ?? null,
        entry.resourceType || "",
        entry.resourceId || "",
        entry.summary || "",
        entry.userInitiated ? 1 : 0,
      );
      return true;
    } catch (err) {
      log.warn("failed to write entry", { err: (err as Error)?.message || String(err) });
      return false;
    }
  }

  function query(filters: AuditLogFilters = {}) {
    const conditions: string[] = [];
    const params: (string | number)[] = [];

    if (filters.from) {
      conditions.push("timestamp >= ?");
      params.push(filters.from);
    }
    if (filters.to) {
      conditions.push("timestamp <= ?");
      params.push(filters.to);
    }
    // Both cursors are exclusive, so a walk that feeds back the id it last saw
    // makes progress by construction. Anything non-numeric is simply no
    // cursor — never a NaN parameter handed to SQLite.
    const afterId = Math.floor(Number(filters.afterId) || 0);
    if (afterId > 0) {
      conditions.push("id > ?");
      params.push(afterId);
    }
    const beforeId = Math.floor(Number(filters.beforeId) || 0);
    if (beforeId > 0) {
      conditions.push("id < ?");
      params.push(beforeId);
    }
    if (filters.category) {
      conditions.push("category = ?");
      params.push(filters.category);
    }
    if (filters.connectionId) {
      conditions.push("connection_id = ?");
      params.push(filters.connectionId);
    }
    if (typeof filters.success === "boolean") {
      conditions.push("success = ?");
      params.push(filters.success ? 1 : 0);
    }
    if (filters.operation) {
      conditions.push("operation = ?");
      params.push(filters.operation);
    }
    if (typeof filters.userInitiated === "boolean") {
      conditions.push("user_initiated = ?");
      params.push(filters.userInitiated ? 1 : 0);
    }
    if (filters.providerFilters) {
      const known = new Set(providerColumns.map((c) => c.name));
      for (const [column, value] of Object.entries(filters.providerFilters)) {
        if (!known.has(column) || value === undefined || value === null) continue;
        conditions.push(`${column} = ?`);
        params.push(String(value));
      }
    }
    if (filters.search) {
      const term = `%${filters.search}%`;
      const allSearchFields = ["operation", ...searchFields, "url", "error_message"];
      conditions.push("(" + allSearchFields.map((f) => `${f} LIKE ?`).join(" OR ") + ")");
      for (let i = 0; i < allSearchFields.length; i++) params.push(term);
    }

    const where = conditions.length ? "WHERE " + conditions.join(" AND ") : "";
    const limit = Math.min(Math.max(Number(filters.limit) || 100, 1), 500);
    const offset = Math.max(Number(filters.offset) || 0, 0);

    const countSql = `SELECT COUNT(*) as total FROM ${tableName} ${where}`;
    const querySql = `SELECT * FROM ${tableName} ${where} ORDER BY id DESC LIMIT ? OFFSET ?`;

    const totalRow = db.prepare(countSql).get(...params) as { total?: number } | undefined;
    const entries = db.prepare(querySql).all(...params, limit, offset) as Record<string, unknown>[];

    return {
      entries: entries.map(formatRow),
      total: totalRow?.total || 0,
    };
  }

  function getStats(filters: Pick<AuditLogFilters, "from" | "connectionId" | "providerFilters"> = {}) {
    const conditions: string[] = [];
    const params: string[] = [];

    if (filters.from) {
      conditions.push("timestamp >= ?");
      params.push(filters.from);
    }
    if (filters.connectionId) {
      conditions.push("connection_id = ?");
      params.push(filters.connectionId);
    }
    if (filters.providerFilters) {
      const known = new Set(providerColumns.map((c) => c.name));
      for (const [column, value] of Object.entries(filters.providerFilters)) {
        if (!known.has(column) || value === undefined || value === null) continue;
        conditions.push(`${column} = ?`);
        params.push(String(value));
      }
    }

    const where = conditions.length ? "WHERE " + conditions.join(" AND ") : "";

    const row = db
      .prepare(
        `
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END) as successCount,
        SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END) as errorCount,
        SUM(CASE WHEN category = 'read' THEN 1 ELSE 0 END) as readCount,
        SUM(CASE WHEN category = 'write' THEN 1 ELSE 0 END) as writeCount,
        ROUND(AVG(duration_ms), 0) as avgDurationMs
      FROM ${tableName} ${where}
    `,
      )
      .get(...params) as
      | {
          total?: number;
          successCount?: number;
          errorCount?: number;
          readCount?: number;
          writeCount?: number;
          avgDurationMs?: number;
        }
      | undefined;

    return {
      total: row?.total || 0,
      successCount: row?.successCount || 0,
      errorCount: row?.errorCount || 0,
      readCount: row?.readCount || 0,
      writeCount: row?.writeCount || 0,
      avgDurationMs: row?.avgDurationMs || 0,
    };
  }

  /**
   * Remove rows the user asked to forget. Returns how many actually went.
   *
   * An empty `ids` deletes NOTHING rather than everything: a caller that meant
   * to name rows and handed over an empty list has a bug, and the friendly
   * reading of that bug is the whole table. Wiping the trail therefore takes
   * an explicit `all: true`.
   *
   * Retention prunes on age and is not this — `prune()` is housekeeping the
   * store does to itself, this is the user deleting evidence they own.
   */
  function deleteEntries({ ids, all = false, providerFilters }: AuditLogDelete = {}): number {
    const conditions: string[] = [];
    const params: (string | number)[] = [];

    const wanted = (Array.isArray(ids) ? ids : [])
      .map((id) => Math.floor(Number(id)))
      .filter((id) => Number.isFinite(id) && id > 0)
      .slice(0, MAX_DELETE_IDS);
    if (wanted.length > 0) {
      conditions.push(`id IN (${wanted.map(() => "?").join(", ")})`);
      params.push(...wanted);
    } else if (!all) {
      return 0;
    }

    if (providerFilters) {
      const known = new Set(providerColumns.map((c) => c.name));
      for (const [column, value] of Object.entries(providerFilters)) {
        if (!known.has(column) || value === undefined || value === null) continue;
        conditions.push(`${column} = ?`);
        params.push(String(value));
      }
    }

    const where = conditions.length ? "WHERE " + conditions.join(" AND ") : "";
    try {
      const result = db.prepare(`DELETE FROM ${tableName} ${where}`).run(...params);
      return Number(result?.changes) || 0;
    } catch (err) {
      log.warn("failed to delete entries", { tableName, err: (err as Error)?.message || String(err) });
      return 0;
    }
  }

  function prune(maxAgeDays = MAX_RETENTION_DAYS): void {
    const days = Math.max(1, Math.floor(maxAgeDays));
    const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
    db.prepare(`DELETE FROM ${tableName} WHERE timestamp < ?`).run(cutoff);
  }

  function getEntryCount(): number {
    return (countStmt.get() as { total?: number } | undefined)?.total || 0;
  }

  function close(): void {
    try {
      db.close();
    } catch {}
  }

  function formatRow(row: Record<string, unknown>) {
    return {
      id: row.id,
      timestamp: row.timestamp,
      connectionId: row.connection_id,
      ...mapRowToProviderFields(row),
      operation: row.operation,
      category: row.category,
      method: row.method,
      url: row.url,
      statusCode: row.status_code,
      success: row.success === 1,
      errorMessage: row.error_message,
      durationMs: row.duration_ms,
      resourceType: row.resource_type,
      resourceId: row.resource_id,
      summary: row.summary,
      userInitiated: row.user_initiated === 1,
    };
  }

  // Prune on startup — never let this crash the store initialization
  try {
    prune();
  } catch (err) {
    log.warn("prune on startup failed", { err: (err as Error)?.message || String(err) });
  }

  return { logEntry, query, getStats, deleteEntries, prune, getEntryCount, close };
}
