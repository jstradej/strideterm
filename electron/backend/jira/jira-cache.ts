/// <reference types="node" />
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, renameSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { getLogger } from "../logger.js";

const log = getLogger("jira");

/** The SQLite / OS code of a failure; never its message, which can name file paths. */
function sqliteFields(error: unknown): { code: string; sqliteCode?: number } {
  const e = error as { code?: unknown; errcode?: unknown } | null;
  return {
    code: typeof e?.code === "string" && /^[A-Z][A-Z0-9_]{1,63}$/.test(e.code) ? e.code : "UNKNOWN",
    ...(typeof e?.errcode === "number" ? { sqliteCode: e.errcode } : {}),
  };
}

function unavailable(reason: string, error?: unknown) {
  log.warn("jira cache is unavailable; saved views and cached data are off for this session", {
    reason,
    ...sqliteFields(error),
  });
  return unavailableCache();
}

const SCHEMA_VERSION = 4;
const DEFAULT_TTL_MS = 5 * 60_000;
const DEFAULT_MAX_ENTRIES = 2_000;
const DEFAULT_MAX_ENTRY_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_TOTAL_BYTES = 32 * 1024 * 1024;
const DEFAULT_MAX_RETENTION_MS = 30 * 24 * 60 * 60_000;
const MAX_KEY_LENGTH = 16_384;
const MAX_SCOPE_LENGTH = 4_096;

export interface JiraCacheEntry<T> {
  value: T;
  fetchedAt: number;
  expiresAt: number;
  stale: boolean;
}

export interface JiraCacheOptions {
  now?: () => number;
  defaultTtlMs?: number;
  maxEntries?: number;
  maxEntryBytes?: number;
  maxTotalBytes?: number;
  maxRetentionMs?: number;
}

export interface JiraSavedViewRecord {
  profileId: string;
  workspaceId: string;
  viewId: string;
  value: unknown;
  active: boolean;
}

export interface JiraWorkspaceProjectScopeRecord {
  profileId: string;
  workspaceId: string;
  connectionId: string;
  projectKeys: string[] | null;
}

export function createJiraCache(databasePath: string, options: JiraCacheOptions = {}) {
  try {
    mkdirSync(dirname(databasePath), { recursive: true });
  } catch (error) {
    return unavailable("directory", error);
  }
  const now = options.now ?? Date.now;
  const defaultTtlMs = positive(options.defaultTtlMs, DEFAULT_TTL_MS);
  const maxEntries = positiveInt(options.maxEntries, DEFAULT_MAX_ENTRIES);
  const maxTotalBytes = positiveInt(options.maxTotalBytes, DEFAULT_MAX_TOTAL_BYTES);
  const maxEntryBytes = Math.min(positiveInt(options.maxEntryBytes, DEFAULT_MAX_ENTRY_BYTES), maxTotalBytes);
  const maxRetentionMs = positiveInt(options.maxRetentionMs, DEFAULT_MAX_RETENTION_MS);
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(databasePath);
  } catch (error) {
    return unavailable("open", error);
  }

  try {
    db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
    initializeSchema(db);
  } catch (error) {
    try {
      db.close();
    } catch {}
    if (!isCorruptCacheError(error) || /unsupported jira cache schema/i.test(String(error)))
      return unavailable(/unsupported jira cache schema/i.test(String(error)) ? "newer-schema" : "initialize", error);
    // Preserve the original database and journal sidecars for recovery; durable views may live there.
    const backupPath = `${databasePath}.corrupt-${Date.now()}`;
    for (const suffix of ["", "-wal", "-shm"]) {
      if (!existsSync(databasePath + suffix)) continue;
      try {
        renameSync(databasePath + suffix, backupPath + suffix);
      } catch (renameError) {
        return unavailable("corrupt-database-could-not-be-moved", renameError);
      }
    }
    log.error("jira cache database was corrupt and has been moved aside; a new empty one is used", {
      backupFile: backupPath,
      ...sqliteFields(error),
    });
    try {
      db = new DatabaseSync(databasePath);
      db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
      initializeSchema(db);
    } catch (rebuildError) {
      try {
        db.close();
      } catch {}
      return unavailable("rebuild-after-corruption", rebuildError);
    }
  }

  try {
    chmodSync(databasePath, 0o600);
  } catch {}

  const getStmt = db.prepare(
    "SELECT value_json, fetched_at, expires_at FROM jira_cache_entries WHERE scope_hash = ? AND cache_key = ?",
  );
  const putStmt = db.prepare(`
    INSERT INTO jira_cache_entries(scope_hash, cache_key, value_json, fetched_at, expires_at, size_bytes)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(scope_hash, cache_key) DO UPDATE SET
      value_json = excluded.value_json, fetched_at = excluded.fetched_at,
      expires_at = excluded.expires_at, size_bytes = excluded.size_bytes
  `);
  let closed = false;
  let disabled = false;

  function disable(error?: unknown): void {
    if (closed || disabled) return;
    disabled = true;
    log.warn("jira cache was switched off for this session after a database error", sqliteFields(error));
    try {
      db.close();
    } catch {}
  }

  function readAny<T>(scope: string, key: string): JiraCacheEntry<T> | undefined {
    validate(scope, key);
    try {
      if (closed || disabled) return undefined;
      const row = getStmt.get(hashScope(scope), key) as
        { value_json: string; fetched_at: number; expires_at: number } | undefined;
      if (!row || Number(row.fetched_at) + maxRetentionMs <= now()) {
        if (row)
          db.prepare("DELETE FROM jira_cache_entries WHERE scope_hash = ? AND cache_key = ?").run(
            hashScope(scope),
            key,
          );
        return undefined;
      }
      let value: T;
      try {
        value = JSON.parse(row.value_json) as T;
      } catch {
        try {
          db.prepare("DELETE FROM jira_cache_entries WHERE scope_hash = ? AND cache_key = ?").run(
            hashScope(scope),
            key,
          );
        } catch (error) {
          disable(error);
        }
        return undefined;
      }
      return {
        value,
        fetchedAt: Number(row.fetched_at),
        expiresAt: Number(row.expires_at),
        stale: Number(row.expires_at) <= now(),
      };
    } catch (error) {
      disable(error);
      return undefined;
    }
  }

  function read<T>(scope: string, key: string): JiraCacheEntry<T> | undefined {
    const entry = readAny<T>(scope, key);
    return entry && !entry.stale ? entry : undefined;
  }

  function write<T>(scope: string, key: string, value: T, ttlMs = defaultTtlMs): boolean {
    validate(scope, key);
    try {
      if (closed || disabled) return false;
      const encoded = JSON.stringify(value);
      if (typeof encoded !== "string") return false;
      const size = Buffer.byteLength(encoded, "utf8");
      if (size > maxEntryBytes) return false;
      const at = now();
      const ttl = positive(ttlMs, defaultTtlMs);
      putStmt.run(hashScope(scope), key, encoded, at, at + ttl, size);
      prune();
      return true;
    } catch (error) {
      disable(error);
      return false;
    }
  }

  function invalidate(scope: string, options: { keepKeyPrefix?: string } = {}): number {
    if (!scope || scope.length > MAX_SCOPE_LENGTH) return 0;
    try {
      if (closed || disabled) return 0;
      const result = options.keepKeyPrefix
        ? db
            .prepare("DELETE FROM jira_cache_entries WHERE scope_hash = ? AND substr(cache_key, 1, ?) <> ?")
            .run(hashScope(scope), options.keepKeyPrefix.length, options.keepKeyPrefix)
        : db.prepare("DELETE FROM jira_cache_entries WHERE scope_hash = ?").run(hashScope(scope));
      return Number(result.changes) || 0;
    } catch (error) {
      disable(error);
      return 0;
    }
  }

  function remove(scope: string, key: string): boolean {
    validate(scope, key);
    try {
      if (closed || disabled) return false;
      const result = db
        .prepare("DELETE FROM jira_cache_entries WHERE scope_hash = ? AND cache_key = ?")
        .run(hashScope(scope), key);
      return Number(result.changes) > 0;
    } catch (error) {
      disable(error);
      return false;
    }
  }

  function retainScopes(scopes: readonly string[]): number {
    const hashes = [...new Set(scopes.filter((scope) => scope && scope.length <= MAX_SCOPE_LENGTH).map(hashScope))];
    try {
      if (closed || disabled) return 0;
      if (!hashes.length) {
        const result = db.prepare("DELETE FROM jira_cache_entries").run();
        return Number(result.changes) || 0;
      }
      const result = db
        .prepare(`DELETE FROM jira_cache_entries WHERE scope_hash NOT IN (${hashes.map(() => "?").join(",")})`)
        .run(...hashes);
      return Number(result.changes) || 0;
    } catch (error) {
      disable(error);
      return 0;
    }
  }

  function prune(): number {
    try {
      if (closed || disabled) return 0;
      return pruneDatabase();
    } catch (error) {
      disable(error);
      return 0;
    }
  }

  function pruneDatabase(): number {
    const expired = db.prepare("DELETE FROM jira_cache_entries WHERE fetched_at + ? <= ?").run(maxRetentionMs, now());
    let removed = Number(expired.changes) || 0;
    const count = db
      .prepare("SELECT COUNT(*) AS count, COALESCE(SUM(size_bytes), 0) AS bytes FROM jira_cache_entries")
      .get() as {
      count: number;
      bytes: number;
    };
    let excessCount = Math.max(0, Number(count.count) - maxEntries);
    let excessBytes = Math.max(0, Number(count.bytes) - maxTotalBytes);
    while (excessCount > 0 || excessBytes > 0) {
      const row = db
        .prepare("SELECT scope_hash, cache_key, size_bytes FROM jira_cache_entries ORDER BY fetched_at ASC LIMIT 1")
        .get() as { scope_hash: string; cache_key: string; size_bytes: number } | undefined;
      if (!row) break;
      db.prepare("DELETE FROM jira_cache_entries WHERE scope_hash = ? AND cache_key = ?").run(
        row.scope_hash,
        row.cache_key,
      );
      excessCount -= 1;
      excessBytes -= Number(row.size_bytes) || 0;
      removed += 1;
    }
    return removed;
  }

  function close(): void {
    if (closed) return;
    closed = true;
    try {
      db.close();
    } catch {}
  }

  function listSavedViews(profileId: string, workspaceId: string): JiraSavedViewRecord[] {
    try {
      if (closed || disabled) return [];
      const rows = db
        .prepare(
          `SELECT v.profile_id, v.workspace_id, v.view_id, v.value_json,
        COALESCE(s.active_view_id, 'issues') AS active_view_id
        FROM jira_saved_workspace_views v LEFT JOIN jira_workspace_view_state s
        ON s.profile_id = v.profile_id AND s.workspace_id = v.workspace_id
        WHERE v.profile_id = ? AND v.workspace_id = ? ORDER BY v.sort_order ASC, v.created_at ASC, v.view_id ASC`,
        )
        .all(profileId, workspaceId) as Array<{
        profile_id: string;
        workspace_id: string;
        view_id: string;
        value_json: string;
        active_view_id: string;
      }>;
      return rows.flatMap((row) => {
        try {
          return [
            {
              profileId: row.profile_id,
              workspaceId: row.workspace_id,
              viewId: row.view_id,
              value: JSON.parse(row.value_json),
              active: row.view_id === row.active_view_id,
            },
          ];
        } catch {
          return [];
        }
      });
    } catch (error) {
      disable(error);
      return [];
    }
  }

  function saveView(record: JiraSavedViewRecord): boolean {
    try {
      if (closed || disabled) return false;
      const valueJson = JSON.stringify(record.value);
      const at = now();
      db.exec("BEGIN IMMEDIATE");
      db.prepare(
        `INSERT INTO jira_saved_workspace_views(profile_id,workspace_id,view_id,value_json,created_at,updated_at,sort_order)
        VALUES(?,?,?,?,?,?,COALESCE((SELECT MAX(sort_order)+1 FROM jira_saved_workspace_views WHERE profile_id=? AND workspace_id=?),0))
        ON CONFLICT(profile_id,workspace_id,view_id) DO UPDATE SET value_json=excluded.value_json, updated_at=excluded.updated_at`,
      ).run(
        record.profileId,
        record.workspaceId,
        record.viewId,
        valueJson,
        at,
        at,
        record.profileId,
        record.workspaceId,
      );
      if (record.active)
        db.prepare(
          `INSERT INTO jira_workspace_view_state(profile_id,workspace_id,active_view_id,updated_at)
        VALUES(?,?,?,?) ON CONFLICT(profile_id,workspace_id) DO UPDATE SET
        active_view_id=excluded.active_view_id,updated_at=excluded.updated_at`,
        ).run(record.profileId, record.workspaceId, record.viewId, at);
      db.exec("COMMIT");
      return true;
    } catch {
      try {
        db.exec("ROLLBACK");
      } catch {}
      return false;
    }
  }

  function setActiveView(profileId: string, workspaceId: string, viewId: string): boolean {
    try {
      if (closed || disabled) return false;
      if (
        viewId !== "issues" &&
        !db
          .prepare(
            `SELECT 1 AS found FROM jira_saved_workspace_views
        WHERE profile_id=? AND workspace_id=? AND view_id=?`,
          )
          .get(profileId, workspaceId, viewId)
      )
        return false;
      db.prepare(
        `INSERT INTO jira_workspace_view_state(profile_id,workspace_id,active_view_id,updated_at)
        VALUES(?,?,?,?) ON CONFLICT(profile_id,workspace_id) DO UPDATE SET
        active_view_id=excluded.active_view_id,updated_at=excluded.updated_at`,
      ).run(profileId, workspaceId, viewId, now());
      return true;
    } catch (error) {
      disable(error);
      return false;
    }
  }

  function removeSavedView(profileId: string, workspaceId: string, viewId: string): boolean {
    try {
      if (closed || disabled || viewId === "issues") return false;
      db.exec("BEGIN IMMEDIATE");
      const result = db
        .prepare(`DELETE FROM jira_saved_workspace_views WHERE profile_id=? AND workspace_id=? AND view_id=?`)
        .run(profileId, workspaceId, viewId);
      db.prepare(
        `UPDATE jira_workspace_view_state SET active_view_id='issues',updated_at=?
        WHERE profile_id=? AND workspace_id=? AND active_view_id=?`,
      ).run(now(), profileId, workspaceId, viewId);
      db.exec("COMMIT");
      return Number(result.changes) > 0;
    } catch {
      try {
        db.exec("ROLLBACK");
      } catch {}
      return false;
    }
  }

  function reorderSavedViews(profileId: string, workspaceId: string, viewIds: string[]): boolean {
    try {
      if (closed || disabled) return false;
      db.exec("BEGIN IMMEDIATE");
      const rows = db
        .prepare(`SELECT view_id FROM jira_saved_workspace_views WHERE profile_id=? AND workspace_id=?`)
        .all(profileId, workspaceId) as Array<{ view_id: string }>;
      if (
        rows.length !== viewIds.length ||
        new Set(viewIds).size !== viewIds.length ||
        rows.some((row) => !viewIds.includes(row.view_id))
      ) {
        db.exec("ROLLBACK");
        return false;
      }
      const update = db.prepare(
        `UPDATE jira_saved_workspace_views SET sort_order=? WHERE profile_id=? AND workspace_id=? AND view_id=?`,
      );
      viewIds.forEach((viewId, index) => update.run(index, profileId, workspaceId, viewId));
      db.exec("COMMIT");
      return true;
    } catch {
      try {
        db.exec("ROLLBACK");
      } catch {}
      return false;
    }
  }

  function renameSavedView(profileId: string, workspaceId: string, viewId: string, value: unknown): boolean {
    try {
      if (closed || disabled || viewId === "issues") return false;
      const result = db
        .prepare(
          `UPDATE jira_saved_workspace_views SET value_json=? WHERE profile_id=? AND workspace_id=? AND view_id=?`,
        )
        .run(JSON.stringify(value), profileId, workspaceId, viewId);
      return Number(result.changes) > 0;
    } catch {
      return false;
    }
  }

  function getActiveView(profileId: string, workspaceId: string): string {
    try {
      if (closed || disabled) return "issues";
      const row = db
        .prepare(`SELECT active_view_id FROM jira_workspace_view_state WHERE profile_id=? AND workspace_id=?`)
        .get(profileId, workspaceId) as { active_view_id: string } | undefined;
      return row?.active_view_id || "issues";
    } catch (error) {
      disable(error);
      return "issues";
    }
  }

  function getWorkspaceProjectScope(
    profileId: string,
    workspaceId: string,
    connectionId: string,
  ): string[] | undefined {
    try {
      if (closed || disabled) return undefined;
      const row = db
        .prepare(
          `SELECT project_keys_json FROM jira_workspace_project_scope
           WHERE profile_id=? AND workspace_id=? AND connection_id=?`,
        )
        .get(profileId, workspaceId, connectionId) as { project_keys_json: string } | undefined;
      if (!row) return undefined;
      const value: unknown = JSON.parse(row.project_keys_json);
      if (
        !Array.isArray(value) ||
        value.length > 50 ||
        value.some((key) => typeof key !== "string" || !/^[A-Z][A-Z0-9_]{0,19}$/.test(key))
      )
        return undefined;
      return [...new Set(value as string[])].sort();
    } catch {
      return undefined;
    }
  }

  function setWorkspaceProjectScope(record: JiraWorkspaceProjectScopeRecord): boolean {
    try {
      if (closed || disabled) return false;
      if (record.projectKeys === null) {
        db.prepare(
          `DELETE FROM jira_workspace_project_scope WHERE profile_id=? AND workspace_id=? AND connection_id=?`,
        ).run(record.profileId, record.workspaceId, record.connectionId);
      } else {
        db.prepare(
          `INSERT INTO jira_workspace_project_scope(profile_id,workspace_id,connection_id,project_keys_json,updated_at)
           VALUES(?,?,?,?,?) ON CONFLICT(profile_id,workspace_id,connection_id) DO UPDATE SET
           project_keys_json=excluded.project_keys_json, updated_at=excluded.updated_at`,
        ).run(record.profileId, record.workspaceId, record.connectionId, JSON.stringify(record.projectKeys), now());
      }
      return true;
    } catch {
      return false;
    }
  }

  /** Moves every saved view, active-view marker and project scope of one profile to another. */
  function reassignProfile(fromProfileId: string, toProfileId: string): boolean {
    try {
      if (closed || disabled) return false;
      db.exec("BEGIN IMMEDIATE");
      let dropped = 0;
      for (const table of ["jira_saved_workspace_views", "jira_workspace_view_state", "jira_workspace_project_scope"]) {
        const total = db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE profile_id=?`).get(fromProfileId) as {
          n: number;
        };
        const moved = db
          .prepare(`UPDATE OR IGNORE ${table} SET profile_id=? WHERE profile_id=?`)
          .run(toProfileId, fromProfileId);
        dropped += Number(total.n) - Number(moved.changes);
        db.prepare(`DELETE FROM ${table} WHERE profile_id=?`).run(fromProfileId);
      }
      db.exec("COMMIT");
      if (dropped > 0)
        log.warn("jira rows were dropped because the target profile already had the same ids", { dropped });
      return true;
    } catch {
      try {
        db.exec("ROLLBACK");
      } catch {}
      return false;
    }
  }

  /** Moves the saved views of one workspace into another workspace of the same profile (an inbox that was merged away). */
  function reassignWorkspace(profileId: string, fromWorkspaceId: string, toWorkspaceId: string): boolean {
    try {
      if (closed || disabled) return false;
      db.exec("BEGIN IMMEDIATE");
      const total = db
        .prepare(`SELECT COUNT(*) AS n FROM jira_saved_workspace_views WHERE profile_id=? AND workspace_id=?`)
        .get(profileId, fromWorkspaceId) as { n: number };
      const moved = db
        .prepare(`UPDATE OR IGNORE jira_saved_workspace_views SET workspace_id=? WHERE profile_id=? AND workspace_id=?`)
        .run(toWorkspaceId, profileId, fromWorkspaceId);
      for (const table of ["jira_saved_workspace_views", "jira_workspace_view_state", "jira_workspace_project_scope"])
        db.prepare(`DELETE FROM ${table} WHERE profile_id=? AND workspace_id=?`).run(profileId, fromWorkspaceId);
      db.exec("COMMIT");
      const dropped = Number(total.n) - Number(moved.changes);
      if (dropped > 0)
        log.warn("jira saved views were dropped because the kept inbox already had the same ids", { dropped });
      return true;
    } catch {
      try {
        db.exec("ROLLBACK");
      } catch {}
      return false;
    }
  }

  /** Deletes the saved views and project scopes that point at one connection, whatever workspace holds them. */
  function removeConnectionData(connectionId: string): number {
    try {
      if (closed || disabled) return 0;
      const rows = db
        .prepare(`SELECT profile_id, workspace_id, view_id, value_json FROM jira_saved_workspace_views`)
        .all() as Array<{ profile_id: string; workspace_id: string; view_id: string; value_json: string }>;
      let removed = 0;
      db.exec("BEGIN IMMEDIATE");
      for (const row of rows) {
        let match = false;
        try {
          match = (JSON.parse(row.value_json) as { connectionId?: unknown })?.connectionId === connectionId;
        } catch {
          match = false;
        }
        if (!match) continue;
        db.prepare(`DELETE FROM jira_saved_workspace_views WHERE profile_id=? AND workspace_id=? AND view_id=?`).run(
          row.profile_id,
          row.workspace_id,
          row.view_id,
        );
        db.prepare(
          `UPDATE jira_workspace_view_state SET active_view_id='issues',updated_at=?
          WHERE profile_id=? AND workspace_id=? AND active_view_id=?`,
        ).run(now(), row.profile_id, row.workspace_id, row.view_id);
        removed += 1;
      }
      db.prepare(`DELETE FROM jira_workspace_project_scope WHERE connection_id=?`).run(connectionId);
      db.exec("COMMIT");
      return removed;
    } catch {
      try {
        db.exec("ROLLBACK");
      } catch {}
      return 0;
    }
  }

  return {
    read,
    readAny,
    write,
    invalidate,
    remove,
    retainScopes,
    prune,
    reassignProfile,
    reassignWorkspace,
    removeConnectionData,
    listSavedViews,
    saveView,
    setActiveView,
    reorderSavedViews,
    renameSavedView,
    removeSavedView,
    getActiveView,
    getWorkspaceProjectScope,
    setWorkspaceProjectScope,
    close,
  };
}

function unavailableCache() {
  return {
    read: <T>(_scope: string, _key: string): JiraCacheEntry<T> | undefined => undefined,
    readAny: <T>(_scope: string, _key: string): JiraCacheEntry<T> | undefined => undefined,
    write: <T>(_scope: string, _key: string, _value: T, _ttlMs?: number): boolean => false,
    invalidate: (_scope: string, _options?: { keepKeyPrefix?: string }): number => 0,
    remove: (_scope: string, _key: string): boolean => false,
    retainScopes: (_scopes: readonly string[]): number => 0,
    prune: (): number => 0,
    reassignProfile: (_fromProfileId: string, _toProfileId: string): boolean => false,
    reassignWorkspace: (_profileId: string, _fromWorkspaceId: string, _toWorkspaceId: string): boolean => false,
    removeConnectionData: (_connectionId: string): number => 0,
    listSavedViews: (_profileId: string, _workspaceId: string): JiraSavedViewRecord[] => [],
    saveView: (_record: JiraSavedViewRecord): boolean => false,
    setActiveView: (_profileId: string, _workspaceId: string, _viewId: string): boolean => false,
    reorderSavedViews: (_profileId: string, _workspaceId: string, _viewIds: string[]): boolean => false,
    renameSavedView: (_profileId: string, _workspaceId: string, _viewId: string, _value: unknown): boolean => false,
    removeSavedView: (_profileId: string, _workspaceId: string, _viewId: string): boolean => false,
    getActiveView: (_profileId: string, _workspaceId: string): string => "issues",
    getWorkspaceProjectScope: (_profileId: string, _workspaceId: string, _connectionId: string): string[] | undefined =>
      undefined,
    setWorkspaceProjectScope: (_record: JiraWorkspaceProjectScopeRecord): boolean => false,
    close: (): void => undefined,
  };
}

function isCorruptCacheError(error: unknown): boolean {
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  return /not a database|malformed|corrupt|unsupported jira cache schema|file is encrypted/.test(message);
}

function initializeSchema(db: DatabaseSync): void {
  const metadataExists = db
    .prepare("SELECT 1 AS found FROM sqlite_master WHERE type='table' AND name='jira_cache_metadata'")
    .get();
  const existingVersion = metadataExists
    ? (db.prepare("SELECT value FROM jira_cache_metadata WHERE key = 'schema_version'").get() as
        { value: string } | undefined)
    : undefined;
  if (existingVersion && Number(existingVersion.value) > SCHEMA_VERSION)
    throw new Error("Unsupported Jira cache schema.");
  db.exec(`
    CREATE TABLE IF NOT EXISTS jira_cache_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS jira_cache_entries (
      scope_hash TEXT NOT NULL,
      cache_key TEXT NOT NULL,
      value_json TEXT NOT NULL,
      fetched_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      size_bytes INTEGER NOT NULL,
      PRIMARY KEY(scope_hash, cache_key)
    );
    CREATE INDEX IF NOT EXISTS idx_jira_cache_expiry ON jira_cache_entries(expires_at);
    CREATE INDEX IF NOT EXISTS idx_jira_cache_lru ON jira_cache_entries(fetched_at);
    CREATE TABLE IF NOT EXISTS jira_saved_workspace_views (
      profile_id TEXT NOT NULL, workspace_id TEXT NOT NULL, view_id TEXT NOT NULL,
      value_json TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(profile_id, workspace_id, view_id)
    );
    CREATE TABLE IF NOT EXISTS jira_workspace_view_state (
      profile_id TEXT NOT NULL, workspace_id TEXT NOT NULL, active_view_id TEXT NOT NULL,
      updated_at INTEGER NOT NULL, PRIMARY KEY(profile_id, workspace_id)
    );
    CREATE TABLE IF NOT EXISTS jira_workspace_project_scope (
      profile_id TEXT NOT NULL, workspace_id TEXT NOT NULL, connection_id TEXT NOT NULL,
      project_keys_json TEXT NOT NULL, updated_at INTEGER NOT NULL,
      PRIMARY KEY(profile_id, workspace_id, connection_id)
    );
  `);
  const savedViewColumns = db.prepare(`PRAGMA table_info(jira_saved_workspace_views)`).all() as Array<{ name: string }>;
  if (!savedViewColumns.some((column) => column.name === "sort_order"))
    db.exec(`ALTER TABLE jira_saved_workspace_views ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0`);
  const row = db.prepare("SELECT value FROM jira_cache_metadata WHERE key = 'schema_version'").get() as
    { value: string } | undefined;
  if (row && Number(row.value) > SCHEMA_VERSION) throw new Error("Unsupported Jira cache schema.");
  db.prepare("INSERT OR REPLACE INTO jira_cache_metadata(key, value) VALUES ('schema_version', ?)").run(
    String(SCHEMA_VERSION),
  );
}

function hashScope(scope: string): string {
  return createHash("sha256").update(scope, "utf8").digest("hex");
}

function validate(scope: string, key: string): void {
  if (typeof scope !== "string" || !scope || scope.length > MAX_SCOPE_LENGTH)
    throw new Error("Jira cache scope is invalid.");
  if (typeof key !== "string" || !key || key.length > MAX_KEY_LENGTH) throw new Error("Jira cache key is invalid.");
}

function positive(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && Number(value) > 0 ? Number(value) : fallback;
}

function positiveInt(value: number | undefined, fallback: number): number {
  return Math.max(1, Math.floor(positive(value, fallback)));
}
