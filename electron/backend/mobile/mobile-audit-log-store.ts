/// <reference types="node" />
/**
 * Local mobile audit log — every pairing/command/revocation action, so the
 * user can see what a mobile device did. Mirrors telegram-audit-log-store.ts's
 * persistence approach (node:sqlite, WAL mode, prune-on-startup) for
 * consistency, with its own small schema (see mobile-idempotency-store.ts's
 * header comment for why this doesn't reuse the generic HTTP-shaped
 * shared/base-audit-log-store.ts factory).
 *
 * Hard rule (plan §6/§10.2): this store NEVER persists ciphertext or
 * plaintext payload content — only IDs, status, timestamps, and actor. There
 * is no column here that could hold a command payload, notification body, or
 * envelope ciphertext; logEntry()'s input type has no such field, so a
 * caller cannot accidentally pass one through.
 *
 * Session activity (`session.*` actions, recorded by remote-server.ts for a
 * session minted from a mobile ticket) follows the same rule: metadata only.
 * Terminal input is aggregated to byte/line counts and the typed bytes are
 * never stored; a file row carries the path the client named, never the content.
 *
 * Every row is also handed to an optional file logger (`fileLogger`) so a
 * monitoring agent can tail `mobile-audit.log` without opening SQLite.
 */
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { getLogger } from "../logger.js";

const log = getLogger("mobile-audit-log");

/** plan §12.6: "security/audit metadata: 30 dní". */
const DEFAULT_RETENTION_DAYS = 30;

export type MobileAuditActor = "desktop" | "device";

export interface MobileAuditLogEntry {
  timestamp?: string;
  deviceId: string;
  pairId: string;
  actor: MobileAuditActor;
  /**
   * e.g. "pairing.claimed", "device.revoked", "command.task.pause", "event.sent", and the
   * session-activity rows "session.started", "session.ended", "session.terminal-input", "session.file".
   */
  action: string;
  status: "success" | "failure";
  /** Non-content detail only — e.g. an error code or "device-limit-reached". Never payload text. */
  detail?: string;
  /**
   * Last 8 characters of the command messageId this row is about — enough to correlate a line with the
   * phone's own log without writing the full id. File mirror only; there is no column for it.
   */
  msg?: string;
  /** Age of the envelope in whole seconds when it was refused (expired rejections). File mirror only. */
  ageSeconds?: number;
  /** How many further identical rows a burst suppressed (see the manager's replay summary). File mirror only. */
  suppressed?: number;
}

export interface MobileAuditLogFilters {
  from?: string;
  to?: string;
  deviceId?: string;
  action?: string;
  status?: "success" | "failure";
  limit?: number;
  offset?: number;
}

/** The slice of createAuditLogger()'s result the store needs — a plain text mirror of every row. */
export interface MobileAuditFileLogger {
  info: (message: string, meta?: Record<string, unknown>) => void;
}

export interface MobileAuditLogStoreOptions {
  fileLogger?: MobileAuditFileLogger;
}

export function createMobileAuditLogStore(databasePath: string, options: MobileAuditLogStoreOptions = {}) {
  const { fileLogger } = options;
  mkdirSync(dirname(databasePath), { recursive: true });
  const db = new DatabaseSync(databasePath);

  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;

    CREATE TABLE IF NOT EXISTS mobile_audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL,
      device_id TEXT NOT NULL DEFAULT '',
      pair_id TEXT NOT NULL DEFAULT '',
      actor TEXT NOT NULL DEFAULT 'desktop',
      action TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'success',
      detail TEXT NOT NULL DEFAULT ''
    );

    CREATE INDEX IF NOT EXISTS idx_mobile_audit_timestamp ON mobile_audit_log(timestamp);
    CREATE INDEX IF NOT EXISTS idx_mobile_audit_device ON mobile_audit_log(device_id);
  `);

  const insertStmt = db.prepare(`
    INSERT INTO mobile_audit_log (timestamp, device_id, pair_id, actor, action, status, detail)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const countStmt = db.prepare(`SELECT COUNT(*) as total FROM mobile_audit_log`);

  function logEntry(entry: MobileAuditLogEntry): void {
    try {
      insertStmt.run(
        entry.timestamp || new Date().toISOString(),
        entry.deviceId || "",
        entry.pairId || "",
        entry.actor,
        entry.action,
        entry.status,
        entry.detail || "",
      );
    } catch (err) {
      log.warn("failed to write entry", { err: (err as Error)?.message || String(err) });
    }
    if (!fileLogger) return;
    try {
      fileLogger.info(entry.action, {
        deviceId: entry.deviceId || "",
        pairId: entry.pairId || "",
        actor: entry.actor,
        status: entry.status,
        detail: entry.detail || "",
        ...(entry.msg ? { msg: entry.msg } : {}),
        ...(typeof entry.ageSeconds === "number" ? { ageSeconds: entry.ageSeconds } : {}),
        ...(typeof entry.suppressed === "number" ? { suppressed: entry.suppressed } : {}),
      });
    } catch (err) {
      log.warn("failed to mirror entry to file log", { err: (err as Error)?.message || String(err) });
    }
  }

  function query(filters: MobileAuditLogFilters = {}) {
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
    if (filters.deviceId) {
      conditions.push("device_id = ?");
      params.push(filters.deviceId);
    }
    if (filters.action) {
      conditions.push("action = ?");
      params.push(filters.action);
    }
    if (filters.status) {
      conditions.push("status = ?");
      params.push(filters.status);
    }
    const where = conditions.length ? "WHERE " + conditions.join(" AND ") : "";
    const limit = Math.min(Math.max(Number(filters.limit) || 100, 1), 500);
    const offset = Math.max(Number(filters.offset) || 0, 0);

    const totalRow = db.prepare(`SELECT COUNT(*) as total FROM mobile_audit_log ${where}`).get(...params) as
      { total?: number } | undefined;
    const rows = db
      .prepare(`SELECT * FROM mobile_audit_log ${where} ORDER BY id DESC LIMIT ? OFFSET ?`)
      .all(...params, limit, offset) as Record<string, unknown>[];

    return {
      entries: rows.map((row) => ({
        id: row.id,
        timestamp: row.timestamp,
        deviceId: row.device_id,
        pairId: row.pair_id,
        actor: row.actor,
        action: row.action,
        status: row.status,
        detail: row.detail,
      })),
      total: totalRow?.total || 0,
    };
  }

  function prune(maxAgeDays = DEFAULT_RETENTION_DAYS): void {
    const days = Math.max(1, Math.floor(maxAgeDays));
    const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
    db.prepare(`DELETE FROM mobile_audit_log WHERE timestamp < ?`).run(cutoff);
  }

  function getEntryCount(): number {
    return (countStmt.get() as { total?: number } | undefined)?.total || 0;
  }

  function close(): void {
    try {
      db.close();
    } catch {}
  }

  try {
    prune();
  } catch (err) {
    log.warn("prune on startup failed", { err: (err as Error)?.message || String(err) });
  }

  return { logEntry, query, prune, getEntryCount, close };
}

export type MobileAuditLogStore = ReturnType<typeof createMobileAuditLogStore>;
