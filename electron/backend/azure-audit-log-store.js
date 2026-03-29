import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Classify an Azure DevOps API request by URL pattern and HTTP method.
 * Returns { operation, category, resourceType }.
 */
export function classifyAzureRequest(method, url) {
  const m = method?.toUpperCase() || "GET";
  const p = url || "";

  // Write operations first (POST/PATCH/PUT/DELETE are writes)
  if (m !== "GET") {
    if (p.includes("/threads") && !p.includes("/comments")) {
      if (m === "POST") return { operation: "createThread", category: "write", resourceType: "thread" };
      if (m === "PATCH") return { operation: "updateThread", category: "write", resourceType: "thread" };
    }
    if (p.includes("/comments")) return { operation: "createComment", category: "write", resourceType: "comment" };
    if (p.includes("/reviewers/")) return { operation: "setVote", category: "write", resourceType: "vote" };
    if (p.includes("/pullrequests") && m === "POST")
      return { operation: "createPullRequest", category: "write", resourceType: "pullRequest" };
    if (p.includes("/policy/evaluations") && m === "PATCH")
      return { operation: "reEvaluatePolicy", category: "write", resourceType: "policy" };
    return { operation: `${m.toLowerCase()}Request`, category: "write", resourceType: "" };
  }

  // Read operations (GET)
  if (p.includes("/_apis/projects")) return { operation: "listProjects", category: "read", resourceType: "project" };
  if (p.includes("/pullrequests?") || p.includes("/pullRequests?"))
    return { operation: "listPullRequests", category: "read", resourceType: "pullRequest" };
  if (p.includes("/threads")) return { operation: "listThreads", category: "read", resourceType: "thread" };
  if (p.includes("/iterations") && p.includes("/changes"))
    return { operation: "listIterationChanges", category: "read", resourceType: "file" };
  if (p.includes("/iterations")) return { operation: "listIterations", category: "read", resourceType: "iteration" };
  if (p.includes("/statuses")) return { operation: "listStatuses", category: "read", resourceType: "status" };
  if (p.includes("/policy/evaluations")) return { operation: "listPolicies", category: "read", resourceType: "policy" };
  if (p.includes("/timeline")) return { operation: "fetchBuildTimeline", category: "read", resourceType: "build" };
  if (/\/build\/builds\/\d+\?/.test(p))
    return { operation: "fetchBuildDetail", category: "read", resourceType: "build" };
  if (p.includes("/refs?")) return { operation: "listBranches", category: "read", resourceType: "branch" };
  if (p.includes("/repositories?") || p.includes("/_apis/git/repositories"))
    return { operation: "listRepositories", category: "read", resourceType: "repository" };
  return { operation: "getRequest", category: "read", resourceType: "" };
}

/**
 * Extract organization and project from an Azure DevOps API URL.
 */
export function parseAzureUrl(url) {
  try {
    const u = new URL(url);
    const parts = u.pathname.split("/").filter(Boolean);
    // dev.azure.com/{org}/{project}/_apis/...
    // or {org}.visualstudio.com/{project}/_apis/...
    const apisIndex = parts.indexOf("_apis");
    if (apisIndex >= 1) {
      return {
        organization: u.origin + (apisIndex > 1 ? "/" + parts.slice(0, apisIndex - 1).join("/") : ""),
        project: decodeURIComponent(parts[apisIndex - 1] || ""),
      };
    }
    return { organization: u.origin, project: "" };
  } catch {
    return { organization: "", project: "" };
  }
}

/**
 * Strip sensitive information (tokens) from a URL for safe storage.
 * Azure DevOps uses header-based auth so URLs are generally safe,
 * but this is a precaution.
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

export function createAzureAuditLogStore(databasePath) {
  mkdirSync(dirname(databasePath), { recursive: true });
  const db = new DatabaseSync(databasePath);

  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;

    CREATE TABLE IF NOT EXISTS azure_devops_audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL,
      connection_id TEXT NOT NULL DEFAULT '',
      organization TEXT NOT NULL DEFAULT '',
      project TEXT NOT NULL DEFAULT '',
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

    CREATE INDEX IF NOT EXISTS idx_azure_audit_timestamp ON azure_devops_audit_log(timestamp);
    CREATE INDEX IF NOT EXISTS idx_azure_audit_category ON azure_devops_audit_log(category);
    CREATE INDEX IF NOT EXISTS idx_azure_audit_connection ON azure_devops_audit_log(connection_id);
  `);

  const insertStmt = db.prepare(`
    INSERT INTO azure_devops_audit_log
      (timestamp, connection_id, organization, project, operation, category, method, url,
       status_code, success, error_message, duration_ms, resource_type, resource_id, summary, user_initiated)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const countStmt = db.prepare(`SELECT COUNT(*) as total FROM azure_devops_audit_log`);

  /**
   * Insert an audit log entry.
   */
  function logEntry(entry) {
    try {
      insertStmt.run(
        entry.timestamp || new Date().toISOString(),
        entry.connectionId || "",
        entry.organization || "",
        entry.project || "",
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
      // Never let audit logging break the main flow
      console.warn("[audit-log] Failed to write entry:", err?.message || err);
    }
  }

  /**
   * Query audit log entries with optional filters.
   * @param {object} filters - { from, to, category, connectionId, success, operation, limit, offset }
   * @returns {{ entries: object[], total: number }}
   */
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
      conditions.push(
        "(operation LIKE ? OR project LIKE ? OR organization LIKE ? OR url LIKE ? OR error_message LIKE ?)",
      );
      params.push(term, term, term, term, term);
    }

    const where = conditions.length ? "WHERE " + conditions.join(" AND ") : "";
    const limit = Math.min(Math.max(Number(filters.limit) || 100, 1), 500);
    const offset = Math.max(Number(filters.offset) || 0, 0);

    const countSql = `SELECT COUNT(*) as total FROM azure_devops_audit_log ${where}`;
    const querySql = `SELECT * FROM azure_devops_audit_log ${where} ORDER BY id DESC LIMIT ? OFFSET ?`;

    const totalRow = db.prepare(countSql).get(...params);
    const entries = db.prepare(querySql).all(...params, limit, offset);

    return {
      entries: entries.map(formatRow),
      total: totalRow?.total || 0,
    };
  }

  /**
   * Get summary statistics for the audit log.
   */
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
      FROM azure_devops_audit_log ${where}
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

  /**
   * Delete entries older than maxAgeDays.
   * Uses ISO-8601 string comparison so the timestamp index can be used.
   */
  function prune(maxAgeDays = MAX_RETENTION_DAYS) {
    const days = Math.max(1, Math.floor(maxAgeDays));
    const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
    db.prepare(`DELETE FROM azure_devops_audit_log WHERE timestamp < ?`).run(cutoff);
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
      organization: row.organization,
      project: row.project,
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
    console.warn("[audit-log] Prune on startup failed:", err?.message || err);
  }

  return { logEntry, query, getStats, prune, getEntryCount, close };
}
