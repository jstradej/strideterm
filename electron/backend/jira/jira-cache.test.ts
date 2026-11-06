import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { createJiraCache } from "./jira-cache.js";

const roots: string[] = [];
async function tempDb(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "strideterm-jira-cache-"));
  roots.push(root);
  return path.join(root, "jira-cache.sqlite");
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("Jira persistent cache", () => {
  it("removes one key and can invalidate a scope while keeping a key prefix", async () => {
    const cache = createJiraCache(await tempDb());
    for (const key of ["history:a", "issue:1", "issue:2"]) cache.write("scope", key, { key });
    expect(cache.remove("scope", "issue:1")).toBe(true);
    expect(cache.read("scope", "issue:1")).toBeUndefined();
    expect(cache.invalidate("scope", { keepKeyPrefix: "history:" })).toBe(1);
    expect(cache.read("scope", "history:a")).toBeDefined();
    expect(cache.read("scope", "issue:2")).toBeUndefined();
    expect(cache.invalidate("scope")).toBe(1);
    cache.close();
  });

  it("migrates existing saved views to ordered storage and persists reorder across reopen", async () => {
    const dbPath = await tempDb();
    const cache = createJiraCache(dbPath);
    for (const viewId of ["one", "two", "three"])
      expect(
        cache.saveView({ profileId: "p", workspaceId: "w", viewId, value: { viewId }, active: viewId === "two" }),
      ).toBe(true);
    expect(cache.reorderSavedViews("p", "w", ["three", "one", "two"])).toBe(true);
    expect(cache.listSavedViews("p", "w").map((row) => row.viewId)).toEqual(["three", "one", "two"]);
    expect(cache.getActiveView("p", "w")).toBe("two");
    expect(cache.reorderSavedViews("p", "w", ["one", "one", "three"])).toBe(false);
    cache.close();
    const reopened = createJiraCache(dbPath);
    expect(reopened.listSavedViews("p", "w").map((row) => row.viewId)).toEqual(["three", "one", "two"]);
    expect(reopened.getActiveView("p", "w")).toBe("two");
    reopened.close();
  });

  it("persists exact request snapshots across repository restarts", async () => {
    const dbPath = await tempDb();
    let now = 10_000;
    const first = createJiraCache(dbPath, { now: () => now });
    expect(first.write("scope-a", "board|jql=project%3DA|cursor=", { issues: [{ key: "APP-1" }], hasMore: true })).toBe(
      true,
    );
    first.close();

    now += 50;
    const second = createJiraCache(dbPath, { now: () => now });
    expect(second.read("scope-a", "board|jql=project%3DA|cursor=")).toEqual({
      value: { issues: [{ key: "APP-1" }], hasMore: true },
      fetchedAt: 10_000,
      expiresAt: 310_000,
      stale: false,
    });
    expect(second.read("scope-a", "board|jql=project%3DA|cursor=next")).toBeUndefined();
    second.close();
  });

  it("stores workspace project scopes durably and isolates them by profile, workspace, and connection", async () => {
    const dbPath = await tempDb();
    let cache = createJiraCache(dbPath);
    expect(cache.getWorkspaceProjectScope("profile-a", "workspace-a", "jira-a")).toBeUndefined();
    expect(
      cache.setWorkspaceProjectScope({
        profileId: "profile-a",
        workspaceId: "workspace-a",
        connectionId: "jira-a",
        projectKeys: ["OPS", "APP"],
      }),
    ).toBe(true);
    expect(cache.getWorkspaceProjectScope("profile-a", "workspace-a", "jira-a")).toEqual(["APP", "OPS"]);
    expect(cache.getWorkspaceProjectScope("profile-b", "workspace-a", "jira-a")).toBeUndefined();
    expect(cache.getWorkspaceProjectScope("profile-a", "workspace-b", "jira-a")).toBeUndefined();
    expect(cache.getWorkspaceProjectScope("profile-a", "workspace-a", "jira-b")).toBeUndefined();
    cache.close();

    cache = createJiraCache(dbPath);
    expect(cache.getWorkspaceProjectScope("profile-a", "workspace-a", "jira-a")).toEqual(["APP", "OPS"]);
    expect(
      cache.setWorkspaceProjectScope({
        profileId: "profile-a",
        workspaceId: "workspace-a",
        connectionId: "jira-a",
        projectKeys: [],
      }),
    ).toBe(true);
    expect(cache.getWorkspaceProjectScope("profile-a", "workspace-a", "jira-a")).toEqual([]);
    expect(
      cache.setWorkspaceProjectScope({
        profileId: "profile-a",
        workspaceId: "workspace-a",
        connectionId: "jira-a",
        projectKeys: null,
      }),
    ).toBe(true);
    expect(cache.getWorkspaceProjectScope("profile-a", "workspace-a", "jira-a")).toBeUndefined();
    cache.close();
  });

  it("migrates v1 additively and keeps durable views outside cache pruning and invalidation", async () => {
    const dbPath = await tempDb();
    const legacy = new DatabaseSync(dbPath);
    legacy.exec(`CREATE TABLE jira_cache_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO jira_cache_metadata(key,value) VALUES ('schema_version','1');
      CREATE TABLE jira_cache_entries (scope_hash TEXT NOT NULL, cache_key TEXT NOT NULL, value_json TEXT NOT NULL,
        fetched_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, size_bytes INTEGER NOT NULL, PRIMARY KEY(scope_hash,cache_key));
      INSERT INTO jira_cache_entries VALUES ('legacy-hash','history:search', '{}', 1, 2, 2);`);
    legacy.close();
    const cache = createJiraCache(dbPath, { now: () => 10, maxRetentionMs: 1 });
    const view = { viewId: "view-a", kind: "board", connectionId: "jira-a", boardId: 42, title: "Board" };
    expect(
      cache.saveView({
        profileId: "profile-a",
        workspaceId: "workspace-a",
        viewId: "view-a",
        value: view,
        active: true,
      }),
    ).toBe(true);
    expect(
      cache.setWorkspaceProjectScope({
        profileId: "profile-a",
        workspaceId: "workspace-a",
        connectionId: "jira-a",
        projectKeys: [],
      }),
    ).toBe(true);
    expect(cache.invalidate("legacy-scope")).toBe(0);
    expect(cache.retainScopes([])).toBeGreaterThanOrEqual(1);
    cache.prune();
    expect(cache.listSavedViews("profile-a", "workspace-a")).toEqual([
      { profileId: "profile-a", workspaceId: "workspace-a", viewId: "view-a", value: view, active: true },
    ]);
    expect(cache.getActiveView("profile-a", "workspace-a")).toBe("view-a");
    expect(cache.getWorkspaceProjectScope("profile-a", "workspace-a", "jira-a")).toEqual([]);
    cache.close();
    const reopened = createJiraCache(dbPath, { now: () => 10, maxRetentionMs: 1 });
    expect(reopened.listSavedViews("profile-a", "workspace-a")).toMatchObject([
      { viewId: "view-a", value: { boardId: 42 } },
    ]);
    expect(reopened.getActiveView("profile-a", "workspace-a")).toBe("view-a");
    expect(reopened.getWorkspaceProjectScope("profile-a", "workspace-a", "jira-a")).toEqual([]);
    reopened.close();
  });

  it("does not delete a database with an unknown future schema", async () => {
    const dbPath = await tempDb();
    const db = new DatabaseSync(dbPath);
    db.exec(
      "CREATE TABLE jira_cache_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL); INSERT INTO jira_cache_metadata VALUES ('schema_version','99');",
    );
    db.close();
    const cache = createJiraCache(dbPath);
    expect(cache.write("s", "k", { value: 1 })).toBe(false);
    cache.close();
    const preserved = new DatabaseSync(dbPath);
    expect(preserved.prepare("SELECT value FROM jira_cache_metadata WHERE key='schema_version'").get()).toEqual({
      value: "99",
    });
    expect(
      preserved.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='jira_cache_entries'").get(),
    ).toBeUndefined();
    preserved.close();
  });

  it("isolates scopes, hashes scope values at rest, and supports scoped invalidation", async () => {
    const dbPath = await tempDb();
    const cache = createJiraCache(dbPath);
    cache.write("profile:alice|connection:one|principal:acct-a", "issue:42", { summary: "private" });
    cache.write("profile:bob|connection:one|principal:acct-a", "issue:42", { summary: "other" });
    expect(cache.read("profile:alice|connection:one|principal:acct-a", "issue:42")?.value).toEqual({
      summary: "private",
    });
    expect(cache.read("profile:alice|connection:two|principal:acct-a", "issue:42")).toBeUndefined();
    expect(cache.invalidate("profile:alice|connection:one|principal:acct-a")).toBe(1);
    cache.close();

    const db = new DatabaseSync(dbPath);
    const rows = db.prepare("SELECT scope_hash, value_json FROM jira_cache_entries").all() as Array<{
      scope_hash: string;
      value_json: string;
    }>;
    db.close();
    expect(rows).toHaveLength(1);
    expect(rows[0].scope_hash).not.toContain("profile:bob");
    expect(rows[0].value_json).toContain("other");
  });

  it("returns stale values for offline fallback while excluding them from fresh reads", async () => {
    let now = 100;
    const cache = createJiraCache(await tempDb(), { now: () => now, defaultTtlMs: 25 });
    cache.write("scope", "issue:1", { status: "Open" });
    now = 126;
    expect(cache.read("scope", "issue:1")).toBeUndefined();
    expect(cache.readAny("scope", "issue:1")).toEqual({
      value: { status: "Open" },
      fetchedAt: 100,
      expiresAt: 125,
      stale: true,
    });
    cache.close();
  });

  it("preserves expired snapshots for offline fallback until max retention", async () => {
    let now = 100;
    const cache = createJiraCache(await tempDb(), {
      now: () => now,
      defaultTtlMs: 5,
      maxRetentionMs: 30,
    });
    cache.write("scope", "old-page", { issues: ["APP-1"] });
    now = 106;
    cache.write("scope", "new-page", { issues: ["APP-2"] });
    expect(cache.read("scope", "old-page")).toBeUndefined();
    expect(cache.readAny("scope", "old-page")?.stale).toBe(true);
    now = 131;
    expect(cache.readAny("scope", "old-page")).toBeUndefined();
    cache.close();
  });

  it("expires entries and enforces entry-count, byte and per-entry bounds", async () => {
    let now = 1;
    const cache = createJiraCache(await tempDb(), {
      now: () => now,
      defaultTtlMs: 5,
      maxRetentionMs: 5,
      maxEntries: 2,
      maxEntryBytes: 32,
      maxTotalBytes: 20,
    });
    expect(cache.write("s", "too-big", { text: "x".repeat(100) })).toBe(false);
    expect(cache.write("s", "a", { value: "a" })).toBe(true);
    now += 1;
    cache.write("s", "b", { value: "b" });
    expect(cache.read("s", "a")).toBeUndefined();
    expect(cache.read("s", "b")?.value).toEqual({ value: "b" });
    now += 1;
    cache.write("s", "c", { value: "c" });
    expect(cache.read("s", "b")).toBeUndefined();
    expect(cache.read("s", "c")?.value).toEqual({ value: "c" });
    now += 10;
    expect(cache.prune()).toBeGreaterThan(0);
    expect(cache.readAny("s", "c")).toBeUndefined();
    cache.close();
  });

  it("drops obsolete scopes and recovers from a corrupt database file", async () => {
    const dbPath = await tempDb();
    const cache = createJiraCache(dbPath);
    cache.write("keep", "k", { ok: true });
    cache.write("remove", "k", { ok: false });
    expect(cache.retainScopes(["keep"])).toBe(1);
    cache.close();

    await fs.writeFile(dbPath, "this is not a sqlite database");
    const recovered = createJiraCache(dbPath);
    expect(recovered.readAny("keep", "k")).toBeUndefined();
    expect(recovered.write("keep", "k", { recovered: true })).toBe(true);
    expect(recovered.read("keep", "k")?.value).toEqual({ recovered: true });
    recovered.close();
    const files = await fs.readdir(path.dirname(dbPath));
    expect(
      files.some((file) => file.startsWith("jira-cache.sqlite.corrupt-") || file === "jira-cache.sqlite.corrupt"),
    ).toBe(true);
  });

  it("drops malformed JSON entries without breaking other reads", async () => {
    const dbPath = await tempDb();
    const cache = createJiraCache(dbPath);
    cache.write("s", "valid", { ok: true });
    cache.close();
    const db = new DatabaseSync(dbPath);
    db.prepare("UPDATE jira_cache_entries SET value_json = '{bad json' WHERE cache_key = 'valid'").run();
    db.close();
    const reopened = createJiraCache(dbPath);
    expect(reopened.readAny("s", "valid")).toBeUndefined();
    expect(reopened.write("s", "valid", { restored: true })).toBe(true);
    reopened.close();
  });

  it("degrades to a no-op cache when storage cannot be opened", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "strideterm-jira-cache-unavailable-"));
    roots.push(root);
    const blocker = path.join(root, "not-a-directory");
    await fs.writeFile(blocker, "occupied");
    const cache = createJiraCache(path.join(blocker, "jira-cache.sqlite"));
    expect(cache.read("s", "k")).toBeUndefined();
    expect(cache.write("s", "k", { ok: true })).toBe(false);
    expect(cache.invalidate("s")).toBe(0);
    cache.close();
  });

  it("fails closed after a runtime database error so a failed invalidation cannot expose stale rows", async () => {
    const dbPath = await tempDb();
    const cache = createJiraCache(dbPath);
    cache.write("scope", "issue", { summary: "before-write" });
    const db = new DatabaseSync(dbPath);
    db.exec("DROP TABLE jira_cache_entries");
    db.close();
    expect(cache.invalidate("scope")).toBe(0);

    const restored = new DatabaseSync(dbPath);
    restored.exec(`CREATE TABLE jira_cache_entries (
      scope_hash TEXT NOT NULL, cache_key TEXT NOT NULL, value_json TEXT NOT NULL,
      fetched_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, size_bytes INTEGER NOT NULL,
      PRIMARY KEY(scope_hash, cache_key)
    )`);
    restored.close();
    expect(cache.readAny("scope", "issue")).toBeUndefined();
    expect(cache.write("scope", "issue", { summary: "after-write" })).toBe(false);
    cache.close();
  });
});
