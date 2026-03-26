import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Classify a GitHub API request by URL pattern and HTTP method.
 * Returns { operation, category, resourceType }.
 */
export function classifyGitHubRequest(method, url) {
  const m = method?.toUpperCase() || "GET";
  const p = url || "";

  if (m !== "GET") {
    if (p.includes("/pulls/") && p.includes("/reviews") && m === "POST") return { operation: "submitReview", category: "write", resourceType: "review" };
    if (p.includes("/issues/") && p.includes("/comments") && m === "POST") return { operation: "createIssueComment", category: "write", resourceType: "comment" };
    if (p.includes("/pulls/") && p.includes("/comments") && m === "POST") return { operation: "createReviewComment", category: "write", resourceType: "reviewComment" };
    if (p.includes("/pulls") && m === "POST") return { operation: "createPullRequest", category: "write", resourceType: "pullRequest" };
    if (p.includes("/pulls/") && (m === "PATCH" || m === "PUT")) return { operation: "updatePullRequest", category: "write", resourceType: "pullRequest" };
    return { operation: `${m.toLowerCase()}Request`, category: "write", resourceType: "" };
  }

  // Read operations (GET)
  if (p.includes("/search/issues")) return { operation: "searchPullRequests", category: "read", resourceType: "pullRequest" };
  if (p.includes("/user") && !p.includes("/users/")) return { operation: "getAuthenticatedUser", category: "read", resourceType: "user" };
  if (p.includes("/pulls/") && p.includes("/files")) return { operation: "listPullRequestFiles", category: "read", resourceType: "file" };
  if (p.includes("/pulls/") && p.includes("/reviews")) return { operation: "listReviews", category: "read", resourceType: "review" };
  if (p.includes("/pulls/") && p.includes("/comments")) return { operation: "listReviewComments", category: "read", resourceType: "reviewComment" };
  if (p.includes("/pulls/") && p.includes("/requested_reviewers")) return { operation: "listRequestedReviewers", category: "read", resourceType: "reviewer" };
  if (p.includes("/issues/") && p.includes("/comments")) return { operation: "listIssueComments", category: "read", resourceType: "comment" };
  if (p.includes("/pulls/")) return { operation: "getPullRequest", category: "read", resourceType: "pullRequest" };
  if (p.includes("/check-runs")) return { operation: "listCheckRuns", category: "read", resourceType: "check" };
  if (p.includes("/status")) return { operation: "getCombinedStatus", category: "read", resourceType: "status" };
  return { operation: "getRequest", category: "read", resourceType: "" };
}

/**
 * Extract owner and repo from a GitHub API URL.
 */
export function parseGitHubUrl(url) {
  try {
    const u = new URL(url);
    const parts = u.pathname.split("/").filter(Boolean);
    // /repos/{owner}/{repo}/...
    const reposIndex = parts.indexOf("repos");
    if (reposIndex >= 0 && parts.length > reposIndex + 2) {
      return {
        owner: decodeURIComponent(parts[reposIndex + 1]),
        repository: decodeURIComponent(parts[reposIndex + 2]),
      };
    }
    // /search/issues or /user
    return { owner: "", repository: "" };
  } catch {
    return { owner: "", repository: "" };
  }
}

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

export function createGitHubAuditLogStore(databasePath) {
  mkdirSync(dirname(databasePath), { recursive: true });
  const db = new DatabaseSync(databasePath);

  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;

    CREATE TABLE IF NOT EXISTS github_audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL,
      connection_id TEXT NOT NULL DEFAULT '',
      owner TEXT NOT NULL DEFAULT '',
      repository TEXT NOT NULL DEFAULT '',
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

    CREATE INDEX IF NOT EXISTS idx_github_audit_timestamp ON github_audit_log(timestamp);
    CREATE INDEX IF NOT EXISTS idx_github_audit_category ON github_audit_log(category);
    CREATE INDEX IF NOT EXISTS idx_github_audit_connection ON github_audit_log(connection_id);
  `);

  const insertStmt = db.prepare(`
    INSERT INTO github_audit_log
      (timestamp, connection_id, owner, repository, operation, category, method, url,
       status_code, success, error_message, duration_ms, resource_type, resource_id, summary, user_initiated)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const countStmt = db.prepare(`SELECT COUNT(*) as total FROM github_audit_log`);

  function logEntry(entry) {
    try {
      insertStmt.run(
        entry.timestamp || new Date().toISOString(),
        entry.connectionId || "",
        entry.owner || "",
        entry.repository || "",
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
      console.warn("[github-audit-log] Failed to write entry:", err?.message || err);
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
      conditions.push("(operation LIKE ? OR owner LIKE ? OR repository LIKE ? OR url LIKE ? OR error_message LIKE ?)");
      params.push(term, term, term, term, term);
    }

    const where = conditions.length ? "WHERE " + conditions.join(" AND ") : "";
    const limit = Math.min(Math.max(Number(filters.limit) || 100, 1), 500);
    const offset = Math.max(Number(filters.offset) || 0, 0);

    const countSql = `SELECT COUNT(*) as total FROM github_audit_log ${where}`;
    const querySql = `SELECT * FROM github_audit_log ${where} ORDER BY id DESC LIMIT ? OFFSET ?`;

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

    const row = db.prepare(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END) as successCount,
        SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END) as errorCount,
        SUM(CASE WHEN category = 'read' THEN 1 ELSE 0 END) as readCount,
        SUM(CASE WHEN category = 'write' THEN 1 ELSE 0 END) as writeCount,
        ROUND(AVG(duration_ms), 0) as avgDurationMs
      FROM github_audit_log ${where}
    `).get(...params);

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
    db.prepare(`DELETE FROM github_audit_log WHERE timestamp < ?`).run(cutoff);
  }

  function getEntryCount() {
    return countStmt.get()?.total || 0;
  }

  function close() {
    try { db.close(); } catch {}
  }

  function formatRow(row) {
    return {
      id: row.id,
      timestamp: row.timestamp,
      connectionId: row.connection_id,
      owner: row.owner,
      repository: row.repository,
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

  try { prune(); } catch (err) {
    console.warn("[github-audit-log] Prune on startup failed:", err?.message || err);
  }

  return { logEntry, query, getStats, prune, getEntryCount, close };
}
