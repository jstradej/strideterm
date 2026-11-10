import { describe, expect, it, vi } from "vitest";
import {
  JiraPollingService,
  type JiraPollConfig,
  type JiraPollIssue,
  type JiraPollRequest,
  type JiraPollResult,
  type JiraPollingState,
  type JiraPollingStore,
} from "./jira-polling.js";

class MemoryStore implements JiraPollingStore {
  state: JiraPollingState | undefined;
  async load() {
    return structuredClone(this.state);
  }
  async save(state: JiraPollingState) {
    this.state = structuredClone(state);
  }
}

const config = (profileId: string, connectionId: string, queryId: string): JiraPollConfig => ({
  profileId,
  connectionId,
  queryId,
  query: "assignee = currentUser()",
  intervalMs: 5000,
  enabled: true,
});
const issue = (issueId: string, issueKey: string, updatedAt: number): JiraPollIssue => ({
  issueId,
  issueKey,
  updatedAt,
});
const limits = {
  minIntervalMs: 50,
  maxIntervalMs: 10_000,
  overlapMs: 250,
  maxIssues: 3,
  maxRequests: 2,
  maxConcurrentPolls: 1,
};

describe("JiraPollingService", () => {
  it("pollProfileSoon brings forward only this profile's watches that have not polled recently", async () => {
    vi.useFakeTimers();
    try {
      let clock = 10_000;
      const polled: string[] = [];
      const service = new JiraPollingService({
        store: new MemoryStore(),
        poller: async (request) => {
          polled.push(`${request.profileId}/${request.queryId}`);
          return { kind: "snapshot", supported: true, complete: true, observedAt: clock, issues: [] };
        },
        onNotification: () => undefined,
        now: () => clock,
        limits: { ...limits, maxConcurrentPolls: 2 },
      });
      await service.enable(config("profile-a", "jira-a", "query-a"));
      await service.enable(config("profile-b", "jira-b", "query-b"));
      await vi.advanceTimersByTimeAsync(0);
      expect(polled.sort()).toEqual(["profile-a/query-a", "profile-b/query-b"]);
      polled.length = 0;

      clock += 1000;
      expect(await service.pollProfileSoon("profile-a", 2000)).toBe(0);
      await vi.advanceTimersByTimeAsync(0);
      expect(polled).toEqual([]);

      clock += 2000;
      expect(await service.pollProfileSoon("profile-a", 2000)).toBe(1);
      await vi.advanceTimersByTimeAsync(0);
      expect(polled).toEqual(["profile-a/query-a"]);
      service.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not persist or reset a watch when runtime state refresh repeats the same opt-in config", async () => {
    const store = new MemoryStore();
    let saves = 0;
    const save = store.save.bind(store);
    store.save = async (state) => {
      saves += 1;
      await save(state);
    };
    const service = new JiraPollingService({
      store,
      poller: async () => ({ kind: "snapshot", supported: true, complete: true, observedAt: 10, issues: [] }),
      onNotification: () => undefined,
      limits,
    });
    await service.enable(config("profile-a", "jira-a", "query-a"));
    const initialSaves = saves;
    await service.enable(config("profile-a", "jira-a", "query-a"));
    expect(saves).toBe(initialSaves);
    service.dispose();
  });

  it("baselines opt-in membership, emits add/change/removal, overlaps the watermark and deduplicates across restart", async () => {
    const store = new MemoryStore();
    const events: Array<Record<string, unknown>> = [];
    const calls: JiraPollRequest[] = [];
    let clock = 1000;
    const snapshots: JiraPollResult[] = [
      { kind: "snapshot", supported: true, complete: true, observedAt: 1000, issues: [issue("1", "TEST-1", 100)] },
      {
        kind: "snapshot",
        supported: true,
        complete: true,
        observedAt: 1100,
        issues: [
          issue("1", "TEST-1", 105),
          { ...issue("2", "TEST-2", 103), description: "secret issue body" } as JiraPollIssue,
        ],
      },
      {
        kind: "snapshot",
        supported: true,
        complete: true,
        observedAt: 1200,
        issues: [issue("1", "TEST-1", 105), issue("2", "TEST-2", 103)],
      },
      { kind: "snapshot", supported: true, complete: true, observedAt: 1300, issues: [issue("2", "TEST-2", 103)] },
      { kind: "snapshot", supported: true, complete: true, observedAt: 1400, issues: [] },
      { kind: "snapshot", supported: true, complete: true, observedAt: 1500, issues: [issue("2", "TEST-2", 103)] },
      { kind: "snapshot", supported: true, complete: true, observedAt: 1600, issues: [issue("2", "TEST-2", 103)] },
    ];
    const poller = async (request: JiraPollRequest) => {
      calls.push(request);
      return snapshots.shift() ?? { kind: "snapshot", supported: true, complete: true, observedAt: clock, issues: [] };
    };
    let service = new JiraPollingService({
      store,
      poller,
      onNotification: (event) => {
        events.push(event);
      },
      now: () => clock,
      limits,
    });
    await service.enable(config("profile-a", "connection-a", "mine"));
    expect(
      await service.pollNow({ profileId: "profile-a", connectionId: "connection-a", queryId: "mine" }),
    ).toMatchObject({ status: "complete", baseline: true, notifications: 0 });
    clock += 5001;
    expect(
      await service.pollNow({ profileId: "profile-a", connectionId: "connection-a", queryId: "mine" }),
    ).toMatchObject({ status: "complete", notifications: 2 });
    expect(events.map((event) => event.type)).toEqual(["changed", "added"]);
    expect(events[1]).not.toHaveProperty("description");
    expect(Object.keys(events[1]!).sort()).toEqual([
      "connectionId",
      "eventId",
      "issueId",
      "issueKey",
      "observedAt",
      "profileId",
      "queryId",
      "type",
    ]);
    expect(calls[1]?.watermark).toBe(0);
    clock += 5001;
    expect(
      await service.pollNow({ profileId: "profile-a", connectionId: "connection-a", queryId: "mine" }),
    ).toMatchObject({ status: "complete", notifications: 0 });
    clock += 5001;
    expect(
      await service.pollNow({ profileId: "profile-a", connectionId: "connection-a", queryId: "mine" }),
    ).toMatchObject({ status: "complete", notifications: 1 });
    expect(events.at(-1)).toMatchObject({ type: "removed", issueId: "1", issueKey: "TEST-1" });
    clock += 5001;
    expect(
      await service.pollNow({ profileId: "profile-a", connectionId: "connection-a", queryId: "mine" }),
    ).toMatchObject({ status: "complete", notifications: 1 });
    expect(events.at(-1)).toMatchObject({ type: "removed", issueId: "2", issueKey: "TEST-2" });
    service.dispose();

    service = new JiraPollingService({
      store,
      poller,
      onNotification: (event) => {
        events.push(event);
      },
      now: () => clock,
      limits,
    });
    await service.start();
    clock += 5001;
    expect(
      await service.pollNow({ profileId: "profile-a", connectionId: "connection-a", queryId: "mine" }),
    ).toMatchObject({ status: "complete", notifications: 0 });
    clock += 5001;
    expect(
      await service.pollNow({ profileId: "profile-a", connectionId: "connection-a", queryId: "mine" }),
    ).toMatchObject({ status: "complete", notifications: 0 });
    expect(events.filter((event) => event.type === "added" && event.issueId === "2")).toHaveLength(1);
    expect(calls.at(-1)?.watermark).toBe(0);
    service.dispose();
  });

  it("does not infer removals from incomplete snapshots and reports unsupported capability explicitly", async () => {
    const store = new MemoryStore();
    const events: unknown[] = [];
    const statuses: string[] = [];
    let clock = 2000;
    let next: JiraPollResult = {
      kind: "snapshot",
      supported: true,
      complete: true,
      observedAt: clock,
      issues: [issue("1", "TEST-1", 100)],
    };
    const service = new JiraPollingService({
      store,
      poller: async () => next,
      onNotification: (event) => {
        events.push(event);
      },
      onStatus: (status) => {
        statuses.push(status.status);
      },
      now: () => clock,
      limits,
    });
    const key = { profileId: "profile", connectionId: "connection", queryId: "watch" };
    await service.enable(config(key.profileId, key.connectionId, key.queryId));
    await service.pollNow(key);
    clock += 5001;
    next = { kind: "snapshot", supported: true, complete: false, observedAt: clock, issues: [] };
    expect(await service.pollNow(key)).toEqual({ status: "incomplete" });
    expect(events).toHaveLength(0);
    clock += 5001;
    next = { kind: "unsupported", reasonCode: "watcher-data-unavailable" };
    expect(await service.pollNow(key)).toEqual({ status: "unsupported", reasonCode: "watcher-data-unavailable" });
    expect(statuses).toContain("unsupported");
    expect(events).toHaveLength(0);
    service.dispose();
  });

  it("isolates profiles and cancels a connection's scheduled work on disable/delete", async () => {
    const store = new MemoryStore();
    const events: Array<Record<string, unknown>> = [];
    let clock = 3000;
    const poller = async (request: JiraPollRequest): Promise<JiraPollResult> => ({
      kind: "snapshot",
      supported: true,
      complete: true,
      observedAt: clock,
      issues: [
        { issueId: `${request.profileId}-issue`, issueKey: `${request.profileId.toUpperCase()}-1`, updatedAt: clock },
      ],
    });
    const service = new JiraPollingService({
      store,
      poller,
      onNotification: (event) => {
        events.push(event);
      },
      now: () => clock,
      limits,
    });
    await service.enable(config("profile-a", "shared-connection", "query"));
    await service.enable(config("profile-b", "shared-connection", "query"));
    const keyA = { profileId: "profile-a", connectionId: "shared-connection", queryId: "query" };
    const keyB = { profileId: "profile-b", connectionId: "shared-connection", queryId: "query" };
    await service.pollNow(keyA);
    await service.pollNow(keyB);
    await service.removeConnection("profile-a", "shared-connection");
    expect(await service.pollNow(keyA)).toEqual({ status: "disabled" });
    clock += 5001;
    expect(await service.pollNow(keyB)).toMatchObject({ status: "complete" });
    expect(events.every((event) => event.profileId === "profile-b")).toBe(true);
    await service.disableProfile("profile-b");
    expect(await service.pollNow(keyB)).toEqual({ status: "disabled" });
    service.dispose();
  });

  it("honors provider rate limits and passes fixed issue/page budgets to the injected poller", async () => {
    const store = new MemoryStore();
    const requests: JiraPollRequest[] = [];
    const events: unknown[] = [];
    let clock = 4000;
    let polls = 0;
    const service = new JiraPollingService({
      store,
      poller: async (request) => {
        requests.push(request);
        polls += 1;
        if (polls === 1) return { kind: "rate-limited", retryAfterMs: 2000 };
        return {
          kind: "snapshot",
          supported: true,
          complete: true,
          observedAt: clock,
          issues: polls === 2 ? [] : [issue("1", "TEST-1", clock)],
        };
      },
      onNotification: (event) => {
        events.push(event);
      },
      now: () => clock,
      limits,
    });
    const key = { profileId: "profile", connectionId: "connection", queryId: "watch" };
    await service.enable(config(key.profileId, key.connectionId, key.queryId));
    expect(await service.pollNow(key)).toMatchObject({ status: "rate-limited", retryAt: 9000 });
    expect(await service.pollNow(key)).toEqual({ status: "pending" });
    clock = 9000;
    expect(await service.pollNow(key)).toMatchObject({ status: "complete", baseline: true });
    clock += 5001;
    expect(await service.pollNow(key)).toMatchObject({ status: "complete", baseline: false, notifications: 1 });
    expect(events).toHaveLength(1);
    expect(requests[0]).toMatchObject({ maxIssues: 3, maxRequests: 2, overlapMs: 250, watermark: null });
    service.dispose();
  });

  it("never polls a rate-limited watch sooner than a healthy one, and still backs off on repeats", async () => {
    let clock = 1_000_000;
    const service = new JiraPollingService({
      store: new MemoryStore(),
      poller: async () => ({ kind: "rate-limited", retryAfterMs: 1000 }),
      onNotification: () => undefined,
      now: () => clock,
      limits: { ...limits, maxIntervalMs: 60 * 60_000 },
    });
    const key = { profileId: "profile", connectionId: "connection", queryId: "watch" };
    await service.enable(config(key.profileId, key.connectionId, key.queryId));
    const waits: number[] = [];
    for (let i = 0; i < 3; i += 1) {
      const outcome = await service.pollNow(key);
      waits.push((outcome as { retryAt: number }).retryAt - clock);
      clock = (outcome as { retryAt: number }).retryAt;
    }
    expect(waits).toEqual([5000, 10_000, 20_000]);
    service.dispose();
  });

  it("backs off exponentially from the watch interval when Jira sent no Retry-After, without rewriting the state file", async () => {
    const store = new MemoryStore();
    const save = vi.spyOn(store, "save");
    let clock = 1_000_000;
    const service = new JiraPollingService({
      store,
      poller: async () => ({ kind: "rate-limited" }),
      onNotification: () => undefined,
      now: () => clock,
      limits: { ...limits, maxIntervalMs: 60 * 60_000 },
    });
    const key = { profileId: "profile", connectionId: "connection", queryId: "watch" };
    await service.enable(config(key.profileId, key.connectionId, key.queryId));
    save.mockClear();
    const waits: number[] = [];
    for (let i = 0; i < 8; i += 1) {
      const outcome = await service.pollNow(key);
      expect(outcome).toMatchObject({ status: "rate-limited" });
      waits.push((outcome as { retryAt: number }).retryAt - clock);
      clock += waits.at(-1)!;
    }
    expect(waits).toEqual([5000, 10_000, 20_000, 40_000, 80_000, 160_000, 320_000, 640_000]);
    expect(waits.every((wait, index) => index === 0 || wait >= 5000)).toBe(true);
    expect(save).not.toHaveBeenCalled();
    for (let i = 0; i < 3; i += 1) {
      const outcome = await service.pollNow(key);
      const wait = (outcome as { retryAt: number }).retryAt - clock;
      clock += wait;
      expect(wait).toBeLessThanOrEqual(15 * 60_000);
    }
    service.dispose();
  });

  it("starts from an empty state when the stored value is malformed or from a newer version", async () => {
    for (const stored of [
      { version: 2, watches: {}, dedupeIds: [] },
      { version: 1, watches: "x", dedupeIds: [] },
      { version: 1, watches: {}, dedupeIds: "x" },
    ]) {
      const store = new MemoryStore();
      store.state = stored as unknown as JiraPollingState;
      const service = new JiraPollingService({
        store,
        poller: async () => ({ kind: "unsupported", reasonCode: "x" }),
        onNotification: () => undefined,
        limits,
      });
      await expect(service.start()).resolves.toBeUndefined();
      await expect(service.listEnabled()).resolves.toEqual([]);
      service.dispose();
    }
  });

  it("lists only the enabled watches, and a failed load can be retried instead of being cached", async () => {
    const store = new MemoryStore();
    let failures = 1;
    const load = store.load.bind(store);
    store.load = async () => {
      if (failures-- > 0) throw new Error("disk unavailable");
      return load();
    };
    const service = new JiraPollingService({
      store,
      poller: async () => ({ kind: "unsupported", reasonCode: "x" }),
      onNotification: () => undefined,
      limits,
    });
    await expect(service.listEnabled()).rejects.toThrow("disk unavailable");
    await service.enable(config("p1", "c1", "q1"));
    await service.enable(config("p1", "c1", "q2"));
    await service.disable({ profileId: "p1", connectionId: "c1", queryId: "q2" });
    expect((await service.listEnabled()).map((item) => item.queryId)).toEqual(["q1"]);
    service.dispose();
  });
});

describe("JiraPollingService status reporting", () => {
  const key = { profileId: "profile", connectionId: "connection", queryId: "watch" };

  it("reports the failure code and keeps lastSuccessAt / lastError per watch, scoped to a profile", async () => {
    const store = new MemoryStore();
    const statuses: Array<{ status: string; reasonCode?: string }> = [];
    let clock = 10_000;
    let outcome: "ok" | "auth" | "plain" | "rate" = "ok";
    const service = new JiraPollingService({
      store,
      poller: async () => {
        if (outcome === "auth")
          throw Object.assign(new Error("Jira rejected this connection."), { code: "auth-expired" });
        if (outcome === "plain") throw new Error("boom with https://jira.example/?jql=secret");
        if (outcome === "rate") return { kind: "rate-limited", retryAfterMs: 30_000 };
        return { kind: "snapshot", supported: true, complete: true, observedAt: clock, issues: [] };
      },
      onNotification: () => undefined,
      onStatus: (status) => {
        statuses.push({ status: status.status, reasonCode: status.reasonCode });
      },
      now: () => clock,
      limits,
    });
    await service.enable(config(key.profileId, key.connectionId, key.queryId));
    await service.pollNow(key);
    expect(service.getWatchStatuses("profile")).toEqual({
      watch: { connectionId: "connection", status: "idle", lastSuccessAt: 10_000 },
    });

    clock += 5001;
    outcome = "auth";
    expect(await service.pollNow(key)).toEqual({ status: "error" });
    expect(statuses.at(-1)).toEqual({ status: "error", reasonCode: "auth-expired" });
    expect(service.getWatchStatuses("profile").watch).toEqual({
      connectionId: "connection",
      status: "error",
      lastSuccessAt: 10_000,
      lastError: { code: "auth-expired", at: clock },
    });

    clock += 5001;
    outcome = "plain";
    await service.pollNow(key);
    expect(statuses.at(-1)).toEqual({ status: "error", reasonCode: "poll-failed" });
    expect(JSON.stringify(statuses)).not.toContain("secret");

    clock += 5001;
    outcome = "rate";
    await service.pollNow(key);
    expect(service.getWatchStatuses("profile").watch).toMatchObject({
      status: "rate-limited",
      lastError: { code: "rate-limited" },
      retryAt: clock + 10_000,
    });
    expect(service.getWatchStatuses("another-profile")).toEqual({});

    clock += 31_000;
    outcome = "ok";
    await service.pollNow(key);
    expect(service.getWatchStatuses("profile").watch).toEqual({
      connectionId: "connection",
      status: "idle",
      lastSuccessAt: clock,
    });
    await service.disable(key);
    expect(service.getWatchStatuses("profile")).toEqual({});
    service.dispose();
  });
});
