import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { getLogger } from "../logger.js";

const log = getLogger("audit-log");

/**
 * Strip sensitive information (tokens) from a URL for safe storage.
 */
function sanitizeUrl(url) {
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
 * Generic audit-log store factory.
 *
 * Provider-specific stores (Azure DevOps, GitHub) call this with a config
 * that describes the table name, extra columns, and field mappings.
 *
 * @param {string} databasePath - Path to the SQLite database file
 * @param {object} config
 * @param {string} config.tableName - SQL table name (e.g. "azure_devops_audit_log")
 * @param {string} config.indexPrefix - Prefix for index names (e.g. "azure_audit")
 * @param {{ name: string, default: string }[]} config.providerColumns
 *    Extra columns between connection_id and operation.
 *    Each entry: { name: "project", default: "''" }
 * @param {(entry: object) => string[]} config.mapEntryToProviderValues
 *    Extract provider column values from a logEntry call argument.
 * @param {(row: object) => object} config.mapRowToProviderFields
 *    Map raw DB row to provider-specific output fields.
 * @param {string[]} config.searchFields
 *    Column names to include in the free-text search LIKE clause,
 *    in addition to the always-included operation, url, error_message.
 */
export function createAuditLogStore(databasePath, config) {
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

  const insertStmt = db.prepare(`
    INSERT INTO ${tableName}
      (timestamp, connection_id, ${providerColNames}, operation, category, method, url,
       status_code, success, error_message, duration_ms, resource_type, resource_id, summary, user_initiated)
    VALUES (?, ?, ${providerPlaceholders}, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const countStmt = db.prepare(`SELECT COUNT(*) as total FROM ${tableName}`);

  function logEntry(entry) {
    try {
      const providerValues = mapEntryToProviderValues(entry);
      insertStmt.run(
        entry.timestamp || new Date().toISOString(),
        entry.connectionId || "",
        ...providerValues,
        entry.operation || "",
        entry.category || "read",
        entry.method || "GET",
        sanitizeUrl(entry.url),
        entry.statusCode ?? null,
        entry.success !== false ? 1 : 0,
        entry.errorMessage || null,
        entry.durationMs ?? null,
        entry.resourceType || "",
        entry.resourceId || "",
        entry.summary || "",
        entry.userInitiated ? 1 : 0,
      );
    } catch (err) {
      log.warn("failed to write entry", { err: err?.message || String(err) });
    }
  }

  function query(filters = {}) {
    const conditions = [];
    const params = [];

    if (filters.from) {
      conditions.push("timestamp >= ?");
      params.push(filters.from);
    }
    if (filters.to) {
      conditions.push("timestamp <= ?");
      params.push(filters.to);
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

    const totalRow = db.prepare(countSql).get(...params);
    const entries = db.prepare(querySql).all(...params, limit, offset);

    return {
      entries: entries.map(formatRow),
      total: totalRow?.total || 0,
    };
  }

  function getStats(filters = {}) {
    const conditions = [];
    const params = [];

    if (filters.from) {
      conditions.push("timestamp >= ?");
      params.push(filters.from);
    }
    if (filters.connectionId) {
      conditions.push("connection_id = ?");
      params.push(filters.connectionId);
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
      .get(...params);

    return {
      total: row?.total || 0,
      successCount: row?.successCount || 0,
      errorCount: row?.errorCount || 0,
      readCount: row?.readCount || 0,
      writeCount: row?.writeCount || 0,
      avgDurationMs: row?.avgDurationMs || 0,
    };
  }

  function prune(maxAgeDays = MAX_RETENTION_DAYS) {
    const days = Math.max(1, Math.floor(maxAgeDays));
    const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
    db.prepare(`DELETE FROM ${tableName} WHERE timestamp < ?`).run(cutoff);
  }

  function getEntryCount() {
    return countStmt.get()?.total || 0;
  }

  function close() {
    try {
      db.close();
    } catch {}
  }

  function formatRow(row) {
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
    log.warn("prune on startup failed", { err: err?.message || String(err) });
  }

  return { logEntry, query, getStats, prune, getEntryCount, close };
}
