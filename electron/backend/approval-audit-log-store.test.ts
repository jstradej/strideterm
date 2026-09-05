import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { afterEach, describe, expect, test } from "vitest";
import { createApprovalAuditLogStore } from "./approval-audit-log-store.js";

const tempDirs: string[] = [];
const stores: Array<{ close(): void }> = [];

afterEach(async () => {
  for (const store of stores.splice(0)) store.close();
  await Promise.all(
    tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })),
  );
});

async function makeStore() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "strideterm-approval-log-"));
  tempDirs.push(dir);
  const store = createApprovalAuditLogStore(path.join(dir, "approval-audit-log.db"));
  stores.push(store);
  return store;
}

const ENTRY = {
  workspaceId: "backend",
  sessionId: "backend:claude",
  toolName: "Bash",
  claudeSessionId: "claude-session-1",
  decisionReason: "global",
  operation: "auto-approve",
  category: "write",
  method: "HOOK",
  resourceType: "permission-request",
  resourceId: "req-1",
  summary: "Bash: chmod +x deploy.sh",
  success: true,
  userInitiated: false,
};

describe("createApprovalAuditLogStore", () => {
  test("round-trips every approval-specific column", async () => {
    const store = await makeStore();
    expect(store.logEntry(ENTRY)).toBe(true);

    const { entries, total } = store.query({});
    expect(total).toBe(1);
    expect(entries[0]).toMatchObject({
      workspaceId: "backend",
      sessionId: "backend:claude",
      toolName: "Bash",
      // The one field that makes an approval findable in the agent's own
      // transcript, since PermissionRequest carries no tool_use_id.
      claudeSessionId: "claude-session-1",
      decisionReason: "global",
      operation: "auto-approve",
      resourceId: "req-1",
      summary: "Bash: chmod +x deploy.sh",
      success: true,
      userInitiated: false,
    });
  });

  test("returns newest first, which is what the Settings viewer shows", async () => {
    const store = await makeStore();
    store.logEntry({ ...ENTRY, resourceId: "req-1", summary: "Bash: first" });
    store.logEntry({ ...ENTRY, resourceId: "req-2", summary: "Bash: second" });

    const { entries } = store.query({});
    expect(entries.map((e) => e.summary)).toEqual(["Bash: second", "Bash: first"]);
  });

  test("search covers the workspace, the tool and the summary", async () => {
    const store = await makeStore();
    store.logEntry({ ...ENTRY, resourceId: "a", toolName: "Bash", summary: "Bash: chmod +x deploy.sh" });
    store.logEntry({
      ...ENTRY,
      resourceId: "b",
      workspaceId: "frontend",
      toolName: "Write",
      summary: "Write: src/app.ts",
    });

    expect(store.query({ search: "chmod" }).total).toBe(1);
    expect(store.query({ search: "Write" }).total).toBe(1);
    expect(store.query({ search: "frontend" }).total).toBe(1);
    expect(store.query({ search: "nothing-here" }).total).toBe(0);
  });

  test("limit and offset page through the log", async () => {
    const store = await makeStore();
    for (let i = 0; i < 5; i++) store.logEntry({ ...ENTRY, resourceId: `req-${i}`, summary: `Bash: cmd-${i}` });

    expect(store.query({ limit: 2 }).entries.map((e) => e.summary)).toEqual(["Bash: cmd-4", "Bash: cmd-3"]);
    expect(store.query({ limit: 2, offset: 2 }).entries.map((e) => e.summary)).toEqual(["Bash: cmd-2", "Bash: cmd-1"]);
    expect(store.query({ limit: 2 }).total).toBe(5);
  });

  test("afterId and beforeId page the log losslessly where a timestamp window cannot", async () => {
    // The Notification Center back-fill needs a cursor that matches the sort.
    // These five rows all carry ONE timestamp — a burst of auto-approvals
    // inside a single turn — so a `to: <oldest seen>` window would hand back
    // the same page forever while the rows underneath went unread.
    const store = await makeStore();
    const stamp = "2026-09-04T10:00:00.000Z";
    for (let i = 0; i < 5; i++) {
      store.logEntry({ ...ENTRY, resourceId: `req-${i}`, summary: `Bash: cmd-${i}`, timestamp: stamp });
    }
    const ids = store.query({}).entries.map((entry) => Number(entry.id));
    expect(ids).toEqual([5, 4, 3, 2, 1]);

    // Both ends exclusive, so a walk that feeds back the id it last saw makes
    // progress by construction.
    expect(store.query({ beforeId: 4, limit: 2 }).entries.map((e) => e.summary)).toEqual([
      "Bash: cmd-2",
      "Bash: cmd-1",
    ]);
    expect(store.query({ afterId: 3 }).entries.map((e) => e.summary)).toEqual(["Bash: cmd-4", "Bash: cmd-3"]);
    expect(store.query({ afterId: 1, beforeId: 4 }).entries.map((e) => e.summary)).toEqual([
      "Bash: cmd-2",
      "Bash: cmd-1",
    ]);
    // `total` counts the whole cursor window, not just the page.
    expect(store.query({ afterId: 1, limit: 2 }).total).toBe(4);
    // The same timestamp filter, for contrast: inclusive, and no way to step.
    expect(store.query({ to: stamp }).total).toBe(5);
  });

  test("a non-numeric cursor is no cursor, never a NaN parameter", async () => {
    const store = await makeStore();
    store.logEntry(ENTRY);
    // The remote route clamps these before they arrive, but the store is the
    // last line: a NaN bound would reach SQLite as an invalid parameter.
    expect(store.query({ afterId: Number.NaN }).total).toBe(1);
    expect(store.query({ beforeId: Number.NaN }).total).toBe(1);
    expect(store.query({ afterId: -5, beforeId: 0 }).total).toBe(1);
  });

  test("stats count the approvals as writes", async () => {
    const store = await makeStore();
    store.logEntry(ENTRY);
    store.logEntry({ ...ENTRY, resourceId: "req-2" });

    expect(store.getStats({})).toMatchObject({ total: 2, successCount: 2, writeCount: 2 });
  });

  test("deleteEntries removes exactly the ids it was given", async () => {
    const store = await makeStore();
    store.logEntry({ ...ENTRY, resourceId: "req-1" });
    store.logEntry({ ...ENTRY, resourceId: "req-2" });
    store.logEntry({ ...ENTRY, resourceId: "req-3" });
    const ids = store.query({}).entries.map((entry) => Number(entry.id));

    expect(store.deleteEntries({ ids: [ids[1]] })).toBe(1);

    const left = store.query({});
    expect(left.total).toBe(2);
    expect(left.entries.map((entry) => entry.id)).toEqual([ids[0], ids[2]]);
  });

  test("an empty ids list deletes nothing — the friendly reading of that bug is the whole table", async () => {
    const store = await makeStore();
    store.logEntry(ENTRY);

    expect(store.deleteEntries({ ids: [] })).toBe(0);
    expect(store.deleteEntries({})).toBe(0);
    // Ids that cannot name a row are the same case, not "no filter".
    expect(store.deleteEntries({ ids: [0, -3, Number.NaN] })).toBe(0);
    expect(store.query({}).total).toBe(1);
  });

  test("all: true clears the trail, and providerFilters keep it to one profile", async () => {
    const store = await makeStore();
    store.logEntry({ ...ENTRY, profileId: "work", resourceId: "w-1" });
    store.logEntry({ ...ENTRY, profileId: "work", resourceId: "w-2" });
    store.logEntry({ ...ENTRY, profileId: "home", resourceId: "h-1" });

    expect(store.deleteEntries({ all: true, providerFilters: { profile_id: "work" } })).toBe(2);

    const left = store.query({});
    expect(left.total).toBe(1);
    // The store's formatter is untyped past the shared columns, so the
    // provider fields are matched rather than indexed.
    expect(left.entries[0]).toMatchObject({ profileId: "home" });

    // Unscoped, it takes the rest.
    expect(store.deleteEntries({ all: true })).toBe(1);
    expect(store.query({}).total).toBe(0);
  });

  test("a named id outside the profile scope is not deleted", async () => {
    const store = await makeStore();
    store.logEntry({ ...ENTRY, profileId: "work", resourceId: "w-1" });
    store.logEntry({ ...ENTRY, profileId: "home", resourceId: "h-1" });
    const home = store.query({ providerFilters: { profile_id: "home" } }).entries[0];

    // Both conditions apply, so a caller scoped to one profile cannot reach
    // another profile's row by naming its id.
    expect(store.deleteEntries({ ids: [Number(home.id)], providerFilters: { profile_id: "work" } })).toBe(0);
    expect(store.query({}).total).toBe(2);
  });

  test("prune drops entries past the retention window", async () => {
    const store = await makeStore();
    store.logEntry({ ...ENTRY, resourceId: "old", timestamp: new Date(Date.now() - 40 * 86_400_000).toISOString() });
    store.logEntry({ ...ENTRY, resourceId: "fresh" });

    store.prune(30);
    const { entries, total } = store.query({});
    expect(total).toBe(1);
    expect(entries[0].resourceId).toBe("fresh");
  });
});
