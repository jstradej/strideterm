import { describe, expect, test } from "vitest";
import {
  JiraWriteJournal,
  type JiraWriteJournalState,
  type JiraWriteJournalStore,
  jiraWriteFingerprint,
} from "./jira-write-journal.js";

class MemoryStore implements JiraWriteJournalStore {
  value?: JiraWriteJournalState;
  fail = false;
  async load() {
    return this.value && structuredClone(this.value);
  }
  async save(state: JiraWriteJournalState) {
    if (this.fail) throw new Error("disk unavailable");
    this.value = structuredClone(state);
  }
}

const base = {
  profileId: "p1",
  connectionId: "c1",
  issueId: "100",
  issueKey: "APP-1",
  kind: "comment" as const,
  fingerprint: jiraWriteFingerprint({ body: "private comment body" }),
  requester: "Desktop user",
  apiActor: "jira-account:abc",
  metadata: { kind: "comment" as const, bodyHash: "a".repeat(64), submittedAt: 1000 },
};

describe("Jira write journal", () => {
  test("promotes interrupted pending writes to unknown and blocks duplicates after restart", async () => {
    const store = new MemoryStore();
    const first = new JiraWriteJournal({ store, now: () => 1000 });
    await first.begin(base);
    const restarted = new JiraWriteJournal({ store, now: () => 2000 });
    await expect(restarted.begin(base)).rejects.toMatchObject({ code: "blocked", entry: { state: "unknown" } });
    expect(store.value?.entries[0].safeCode).toBe("interrupted");
  });

  test("only explicit not-applied reconciliation releases a duplicate action", async () => {
    const store = new MemoryStore();
    const journal = new JiraWriteJournal({ store, now: () => 10 });
    const entry = await journal.begin(base);
    await journal.markUnknown(entry.id);
    await expect(journal.begin(base)).rejects.toMatchObject({ code: "blocked" });
    await journal.markReconciled(entry.id, "not-applied");
    await expect(journal.begin(base)).resolves.toMatchObject({ state: "pending" });
  });

  test("absorbs another profile's entries, re-attributed and without duplicating, so unknown ones stay reconcilable", async () => {
    const deletedStore = new MemoryStore();
    const deleted = new JiraWriteJournal({ store: deletedStore, now: () => 10 });
    const entry = await deleted.begin(base);
    await deleted.markUnknown(entry.id);
    const fallbackStore = new MemoryStore();
    const fallback = new JiraWriteJournal({ store: fallbackStore, now: () => 20 });
    const moved = await fallback.absorb(await deleted.exportAll(), "p2");
    expect(moved).toBe(1);
    expect(await fallback.absorb(await deleted.exportAll(), "p2")).toBe(0);
    expect(fallbackStore.value?.entries).toMatchObject([{ id: entry.id, profileId: "p2", state: "unknown" }]);
    await expect(fallback.begin({ ...base, profileId: "p2" })).rejects.toMatchObject({ code: "blocked" });
  });

  test("fails closed on store errors and never persists free-form bodies", async () => {
    const store = new MemoryStore();
    const journal = new JiraWriteJournal({ store });
    const entry = await journal.begin(base);
    expect(JSON.stringify(store.value)).not.toContain("private comment body");
    store.fail = true;
    await expect(journal.markSucceeded(entry.id)).rejects.toMatchObject({ code: "persistence-failed" });
  });

  test("does not evict unresolved entries when the bounded store is full", async () => {
    const store = new MemoryStore();
    const journal = new JiraWriteJournal({ store, maxEntries: 1 });
    const entry = await journal.begin(base);
    await journal.markUnknown(entry.id);
    await expect(
      journal.begin({ ...base, issueId: "101", issueKey: "APP-2", fingerprint: "b".repeat(64) }),
    ).rejects.toMatchObject({ code: "full" });
  });

  test("evicts terminal successes at capacity but keeps unknown entries regardless of age", async () => {
    const store = new MemoryStore();
    let now = 1000;
    const journal = new JiraWriteJournal({ store, maxEntries: 2, now: () => now, retentionMs: 60_000 });
    const first = await journal.begin(base);
    await journal.markSucceeded(first.id);
    now++;
    const second = await journal.begin({ ...base, issueId: "101", issueKey: "APP-2", fingerprint: "b".repeat(64) });
    await journal.markSucceeded(second.id);
    now++;
    const third = await journal.begin({ ...base, issueId: "102", issueKey: "APP-3", fingerprint: "c".repeat(64) });
    expect(third.state).toBe("pending");
    expect(store.value?.entries).toHaveLength(2);
    expect(store.value?.entries.map((entry) => entry.issueId)).toEqual(["101", "102"]);

    await journal.markUnknown(second.id);
    now += 120_000;
    await expect(
      journal.begin({ ...base, issueId: "103", issueKey: "APP-4", fingerprint: "d".repeat(64) }),
    ).rejects.toMatchObject({ code: "full" });
    expect(store.value?.entries.some((entry) => entry.state === "unknown" && entry.issueId === "101")).toBe(true);
  });

  test("action fingerprints ignore object key order", () => {
    expect(jiraWriteFingerprint({ transitionId: "31", fields: { resolution: "done", comment: "x" } })).toBe(
      jiraWriteFingerprint({ fields: { comment: "x", resolution: "done" }, transitionId: "31" }),
    );
  });

  describe("assign and attachment kinds", () => {
    const assign = {
      ...base,
      kind: "assign" as const,
      fingerprint: jiraWriteFingerprint({ kind: "assign", target: "bob", before: "carol" }),
      metadata: { kind: "assign" as const, target: "bob", beforeAssignee: "carol", submittedAt: 1 },
    };
    const attachment = {
      ...base,
      kind: "attachment" as const,
      fingerprint: jiraWriteFingerprint({ kind: "attachment", nameHash: "b".repeat(64), size: 3 }),
      metadata: { kind: "attachment" as const, nameHash: "b".repeat(64), size: 3, beforeCount: 0, submittedAt: 1 },
    };

    test("an unresolved attempt blocks a repeat, a finished one does not", async () => {
      for (const entry of [assign, attachment]) {
        const store = new MemoryStore();
        const journal = new JiraWriteJournal({ store, now: () => 10 });
        const first = await journal.begin(entry);
        await journal.markUnknown(first.id);
        await expect(journal.begin(entry)).rejects.toMatchObject({ code: "blocked" });
        await journal.markReconciled(first.id, "applied");
        await expect(journal.begin(entry)).resolves.toMatchObject({ state: "pending" });
      }
    });

    test("a succeeded set-style write may be done again later, a succeeded comment may not", async () => {
      const journal = new JiraWriteJournal({ store: new MemoryStore(), now: () => 10 });
      const done = await journal.begin(assign);
      await journal.markSucceeded(done.id);
      await expect(journal.begin(assign)).resolves.toMatchObject({ state: "pending" });
      const comment = await journal.begin(base);
      await journal.markSucceeded(comment.id);
      await expect(journal.begin(base)).rejects.toMatchObject({ code: "blocked" });
    });

    test("rejects metadata that does not fit the kind", async () => {
      const journal = new JiraWriteJournal({ store: new MemoryStore(), now: () => 10 });
      await expect(
        journal.begin({ ...assign, metadata: { kind: "assign", target: "bob", submittedAt: 1 } as never }),
      ).rejects.toThrow();
      await expect(
        journal.begin({ ...attachment, metadata: { ...attachment.metadata, nameHash: "not-a-hash" } }),
      ).rejects.toThrow();
    });
  });

  describe("duplicate rules by kind", () => {
    const WINDOW = 2 * 60_000;
    const transition = {
      ...base,
      kind: "transition" as const,
      fingerprint: jiraWriteFingerprint({ transitionId: "31", fields: {} }),
      metadata: {
        kind: "transition" as const,
        transitionId: "31",
        targetStatus: "In Progress",
        beforeStatus: "To Do",
        beforeUpdatedAt: "t",
      },
    };
    const remoteLink = {
      ...base,
      kind: "remote-link" as const,
      fingerprint: jiraWriteFingerprint({ globalId: "g" }),
      metadata: { kind: "remote-link" as const, globalId: "g", submittedAt: 1 },
    };
    const worklog = {
      ...base,
      kind: "worklog" as const,
      fingerprint: jiraWriteFingerprint({ kind: "worklog" }),
      metadata: {
        kind: "worklog" as const,
        fingerprint: "c".repeat(64),
        submittedAt: 1,
        seconds: 60,
        started: "2026-01-01T00:00:00.000+0000",
        commentHash: "d".repeat(64),
      },
    };

    test("a succeeded comment or worklog blocks an identical one only within the window", async () => {
      for (const entry of [base, worklog]) {
        let now = 1000;
        const journal = new JiraWriteJournal({ store: new MemoryStore(), now: () => now });
        const first = await journal.begin(entry);
        await journal.markSucceeded(first.id);
        now += WINDOW - 1;
        await expect(journal.begin(entry)).rejects.toMatchObject({ code: "blocked" });
        now += 1;
        await expect(journal.begin(entry)).resolves.toMatchObject({ state: "pending" });
      }
    });

    test("a pending or unknown comment blocks whatever its age", async () => {
      let now = 1000;
      const journal = new JiraWriteJournal({ store: new MemoryStore(), now: () => now });
      const first = await journal.begin(base);
      await journal.markUnknown(first.id);
      now += 10 * WINDOW;
      await expect(journal.begin(base)).rejects.toMatchObject({ code: "blocked" });
    });

    test("transitions and remote links are repeatable once finished, but not while unresolved", async () => {
      for (const entry of [transition, remoteLink]) {
        const journal = new JiraWriteJournal({ store: new MemoryStore(), now: () => 10 });
        const first = await journal.begin(entry);
        await expect(journal.begin(entry)).rejects.toMatchObject({ code: "blocked" });
        await journal.markSucceeded(first.id);
        await expect(journal.begin(entry)).resolves.toMatchObject({ state: "pending" });
      }
    });
  });

  test("a failed save leaves no phantom pending entry, so the retry is accepted", async () => {
    const store = new MemoryStore();
    const journal = new JiraWriteJournal({ store, now: () => 10 });
    store.fail = true;
    await expect(journal.begin(base)).rejects.toMatchObject({ code: "persistence-failed" });
    store.fail = false;
    await expect(journal.begin(base)).resolves.toMatchObject({ state: "pending" });
    expect(store.value?.entries).toHaveLength(1);
  });

  test("a failed save of a state change leaves the cached entry as it was", async () => {
    const store = new MemoryStore();
    const journal = new JiraWriteJournal({ store, now: () => 10 });
    const entry = await journal.begin(base);
    store.fail = true;
    await expect(journal.markSucceeded(entry.id)).rejects.toMatchObject({ code: "persistence-failed" });
    expect((await journal.get(entry.id))?.state).toBe("pending");
  });
});
