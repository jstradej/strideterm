/// <reference types="node" />
/**
 * Bounded durable idempotency ledger for mobile commands (plan §8/§10.2).
 *
 * Mirrors telegram-audit-log-store.ts's persistence approach for
 * consistency: a small `node:sqlite` (DatabaseSync) database under the
 * review-bridge data directory, WAL journal mode, prepared statements, and
 * pruning on startup. The schema itself is bespoke (command lifecycle, not
 * HTTP-request audit rows) — the generic HTTP-shaped
 * shared/base-audit-log-store.ts factory doesn't fit a command ledger, so
 * this module owns its own small schema directly rather than force-fitting
 * mismatched columns onto that factory.
 *
 * Purpose: a restart mid-command must not cause a non-idempotent command
 * (e.g. task.sendInstruction) to be re-executed. mobile-command-dispatch.ts
 * records a "claimed" row before running the side effect, then updates it to
 * a terminal status (or leaves it "claimed" — treated as outcome-unknown on
 * restart — if the process died in between).
 */
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { getLogger } from "../logger.js";
import type { CommandTerminalState } from "./mobile-schemas.js";

const log = getLogger("mobile-idempotency");

/** plan §12.6: "běžný command/result: maximálně 24 hodin". */
const DEFAULT_RETENTION_HOURS = 24;

export interface IdempotencyRecord {
  commandId: string;
  idempotencyKey: string;
  status: "claimed" | CommandTerminalState;
  resultData: Record<string, unknown> | null;
  errorCode: string | null;
  createdAt: string;
  completedAt: string | null;
}

interface IdempotencyRow {
  command_id: string;
  idempotency_key: string;
  status: string;
  result_json: string | null;
  error_code: string | null;
  created_at: string;
  completed_at: string | null;
}

function rowToRecord(row: IdempotencyRow): IdempotencyRecord {
  return {
    commandId: row.command_id,
    idempotencyKey: row.idempotency_key,
    status: row.status as IdempotencyRecord["status"],
    resultData: row.result_json ? (JSON.parse(row.result_json) as Record<string, unknown>) : null,
    errorCode: row.error_code,
    createdAt: row.created_at,
    completedAt: row.completed_at,
  };
}

export function createMobileIdempotencyStore(databasePath: string) {
  mkdirSync(dirname(databasePath), { recursive: true });
  const db = new DatabaseSync(databasePath);

  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;

    CREATE TABLE IF NOT EXISTS mobile_idempotency_ledger (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      command_id TEXT NOT NULL UNIQUE,
      idempotency_key TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'claimed',
      result_json TEXT,
      error_code TEXT,
      created_at TEXT NOT NULL,
      completed_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_mobile_idempotency_key ON mobile_idempotency_ledger(idempotency_key);
    CREATE INDEX IF NOT EXISTS idx_mobile_idempotency_created ON mobile_idempotency_ledger(created_at);
  `);

  const insertClaimedStmt = db.prepare(`
    INSERT INTO mobile_idempotency_ledger (command_id, idempotency_key, status, created_at)
    VALUES (?, ?, 'claimed', ?)
  `);
  const updateResultStmt = db.prepare(`
    UPDATE mobile_idempotency_ledger
    SET status = ?, result_json = ?, error_code = ?, completed_at = ?
    WHERE command_id = ?
  `);
  const byCommandIdStmt = db.prepare(`SELECT * FROM mobile_idempotency_ledger WHERE command_id = ?`);
  const byIdempotencyKeyStmt = db.prepare(
    `SELECT * FROM mobile_idempotency_ledger WHERE idempotency_key = ? ORDER BY id DESC LIMIT 1`,
  );

  function getByCommandId(commandId: string): IdempotencyRecord | null {
    const row = byCommandIdStmt.get(commandId) as IdempotencyRow | undefined;
    return row ? rowToRecord(row) : null;
  }

  function getByIdempotencyKey(idempotencyKey: string): IdempotencyRecord | null {
    const row = byIdempotencyKeyStmt.get(idempotencyKey) as IdempotencyRow | undefined;
    return row ? rowToRecord(row) : null;
  }

  /** Records a command as claimed (side effect about to start). Throws if commandId was already claimed. */
  function recordClaimed(commandId: string, idempotencyKey: string, now = new Date().toISOString()): void {
    insertClaimedStmt.run(commandId, idempotencyKey, now);
  }

  function recordResult(
    commandId: string,
    status: CommandTerminalState,
    resultData: Record<string, unknown> | null,
    errorCode: string | null,
    now = new Date().toISOString(),
  ): void {
    updateResultStmt.run(status, resultData ? JSON.stringify(resultData) : null, errorCode, now, commandId);
  }

  function prune(maxAgeHours = DEFAULT_RETENTION_HOURS): void {
    const hours = Math.max(1, Math.floor(maxAgeHours));
    const cutoff = new Date(Date.now() - hours * 3_600_000).toISOString();
    db.prepare(`DELETE FROM mobile_idempotency_ledger WHERE created_at < ?`).run(cutoff);
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

  return { recordClaimed, recordResult, getByCommandId, getByIdempotencyKey, prune, close };
}

export type MobileIdempotencyStore = ReturnType<typeof createMobileIdempotencyStore>;
