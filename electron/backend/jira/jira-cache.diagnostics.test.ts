import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createJiraCache } from "./jira-cache.js";
import { JiraWriteJournal, type JiraWriteJournalState, jiraWriteFingerprint } from "./jira-write-journal.js";

const logCalls = vi.hoisted(() => [] as Array<{ level: string; message: string; meta?: Record<string, unknown> }>);
vi.mock("../logger.js", () => {
  const record = (level: string) => (message: string, meta?: Record<string, unknown>) => {
    logCalls.push({ level, message, meta });
  };
  return {
    getLogger: () => ({
      error: record("error"),
      warn: record("warn"),
      info: record("info"),
      debug: record("debug"),
      trace: record("trace"),
    }),
    redactSecrets: (value: string) => value,
  };
});

let directory: string;
beforeEach(async () => {
  logCalls.length = 0;
  directory = await mkdtemp(path.join(tmpdir(), "jira-cache-diagnostics-"));
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe("Jira cache diagnostics", () => {
  it("logs an error naming the backup file when a corrupt database is moved aside", async () => {
    const databasePath = path.join(directory, "jira-cache.sqlite");
    await writeFile(databasePath, "this is definitely not a sqlite database, just text ".repeat(40));
    const cache = createJiraCache(databasePath);
    try {
      const moved = (await readdir(directory)).find((name) => name.includes(".corrupt-"));
      expect(moved).toBeDefined();
      const error = logCalls.find((call) => call.level === "error");
      expect(error?.message).toMatch(/corrupt/);
      expect(String(error?.meta?.backupFile)).toContain(moved!);
      expect(cache.write("scope", "key", { ok: true })).toBe(true);
      expect(logCalls.filter((call) => call.message.includes("unavailable"))).toHaveLength(0);
    } finally {
      cache.close();
    }
  });

  it("logs how many saved views a merged inbox dropped because their ids collided", () => {
    const cache = createJiraCache(path.join(directory, "jira-cache.sqlite"));
    try {
      for (const workspaceId of ["old", "kept"])
        expect(
          cache.saveView({ profileId: "p", workspaceId, viewId: "same", value: { viewId: "same" }, active: false }),
        ).toBe(true);
      expect(cache.saveView({ profileId: "p", workspaceId: "old", viewId: "unique", value: {}, active: false })).toBe(
        true,
      );
      expect(cache.reassignWorkspace("p", "old", "kept")).toBe(true);
      expect(logCalls.find((call) => /dropped/.test(call.message))).toMatchObject({
        level: "warn",
        meta: { dropped: 1 },
      });
    } finally {
      cache.close();
    }
  });

  it("warns once, with a code, when the cache cannot be opened at all", async () => {
    const blocker = path.join(directory, "not-a-directory");
    await writeFile(blocker, "x");
    const cache = createJiraCache(path.join(blocker, "jira-cache.sqlite"));
    expect(cache.write("scope", "key", {})).toBe(false);
    const warns = logCalls.filter((call) => call.level === "warn" && /unavailable/.test(call.message));
    expect(warns).toHaveLength(1);
    expect(warns[0].meta).toMatchObject({ reason: "directory", code: expect.any(String) });
  });

  it("warns once when the database fails after it was opened and the cache switches itself off", async () => {
    const cache = createJiraCache(path.join(directory, "jira-cache.sqlite"));
    expect(cache.write("scope", "key", { a: 1 })).toBe(true);
    expect(logCalls.filter((call) => /switched off/.test(call.message))).toHaveLength(0);
    // Any failure inside a cache call switches the cache off for the session; that is logged once, not per call.
    expect(cache.write("scope", "key", { n: 1n } as never)).toBe(false);
    expect(cache.write("scope", "key", { a: 2 })).toBe(false);
    expect(cache.read("scope", "key")).toBeUndefined();
    const switchedOff = logCalls.filter((call) => /switched off/.test(call.message));
    expect(switchedOff).toHaveLength(1);
    expect(switchedOff[0]).toMatchObject({ level: "warn", meta: { code: expect.any(String) } });
    cache.close();
  });
});

describe("Jira write journal diagnostics", () => {
  const base = {
    profileId: "p1",
    connectionId: "c1",
    issueId: "100",
    issueKey: "APP-1",
    kind: "comment" as const,
    fingerprint: jiraWriteFingerprint({ body: "x" }),
    requester: "Desktop user",
    apiActor: "jira-account:abc",
    metadata: { kind: "comment" as const, bodyHash: "a".repeat(64), submittedAt: 1000 },
  };
  const memoryStore = () => ({
    value: undefined as JiraWriteJournalState | undefined,
    fail: false,
    async load() {
      return this.value && structuredClone(this.value);
    },
    async save(state: JiraWriteJournalState) {
      if (this.fail) throw Object.assign(new Error("keyring locked"), { code: "EKEYRING" });
      this.value = structuredClone(state);
    },
  });

  it("warns when a restart promotes interrupted writes to unknown", async () => {
    const store = memoryStore();
    await new JiraWriteJournal({ store }).begin(base);
    await new JiraWriteJournal({ store }).list({ profileId: "p1" });
    expect(logCalls.find((call) => call.level === "warn")).toMatchObject({
      message: expect.stringContaining("interrupted writes"),
      meta: { count: 1 },
    });
  });

  it("keeps the cause of a persistence failure", async () => {
    const store = memoryStore();
    const journal = new JiraWriteJournal({ store });
    const entry = await journal.begin(base);
    store.fail = true;
    const error = await journal.markSucceeded(entry.id).then(
      () => undefined,
      (reason: unknown) => reason as Error,
    );
    expect(error).toMatchObject({ code: "persistence-failed" });
    expect((error?.cause as { code?: string }).code).toBe("EKEYRING");
  });

  it("stores a code and status as safeCode and accepts it back on load", async () => {
    const store = memoryStore();
    const journal = new JiraWriteJournal({ store });
    const entry = await journal.begin(base);
    await journal.markReconciled(entry.id, "not-applied", "permission-denied:403");
    expect(store.value?.entries[0]).toMatchObject({ state: "reconciled", safeCode: "permission-denied:403" });
    await expect(new JiraWriteJournal({ store }).get(entry.id)).resolves.toMatchObject({
      safeCode: "permission-denied:403",
    });
    const second = await journal.begin({ ...base, issueId: "101" });
    await journal.markFailed(second.id, "not-sent:credential-missing");
    expect(store.value?.entries[1]).toMatchObject({ state: "failed", safeCode: "not-sent:credential-missing" });
  });
});
