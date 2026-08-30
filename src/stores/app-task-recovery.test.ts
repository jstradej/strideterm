/**
 * V5 review, §"P2 — recovery kontrakt končí před transportní hranicí".
 *
 * The backend half of V4 made every candidate report a truthful outcome, but
 * the renderer then read that response with two "assume success" defaults:
 *
 *   const outcomes = result?.outcomes || {};
 *   const settled  = decisions.filter((id) => outcomes[id] !== "failed");
 *   return { ok: result?.ok !== false, outcomes };
 *
 * A missing, malformed or empty response therefore meant `ok: true` AND
 * dropped every candidate from the local list, because `undefined !== "failed"`
 * — the same false success, moved one layer up. These tests pin the strict
 * reading: a candidate is dropped only for an outcome that explicitly says it
 * is settled, and anything else is reported as unanswered.
 */
import { describe, expect, test, beforeEach, vi } from "vitest";
import { setActivePinia, createPinia } from "pinia";
import { useAppStore } from "./app.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyApi = any;

const CANDIDATES = [
  { taskId: "t1", workspaceId: "ws-a", workspaceName: "A", profileId: "default", currentRound: 1, maxRounds: 5 },
  { taskId: "t2", workspaceId: "ws-b", workspaceName: "B", profileId: "default", currentRound: 1, maxRounds: 5 },
];

function makeStore(response: AnyApi) {
  const store = useAppStore();
  store.recoveryCandidates = CANDIDATES.map((c) => ({ ...c, previousState: "running" })) as AnyApi;
  const resolveTaskRecovery = vi.fn(async () => response);
  // The store reads `_api` through getApi(); init() is the only writer, and
  // everything it does beyond that is driven by the transport mock below.
  store.init({
    isRemote: false,
    getState: async () => ({ meta: { recoveryCandidates: [] } }),
    onStateUpdated: () => {},
    onConnectionState: () => {},
    resolveTaskRecovery,
  } as AnyApi);
  return { store, resolveTaskRecovery };
}

beforeEach(() => {
  setActivePinia(createPinia());
});

describe("store.resolveTaskRecovery — strict response handling", () => {
  test("a valid response settles exactly the settled outcomes", async () => {
    const { store } = makeStore({
      ok: false,
      outcomes: { "ws-a": "continued", "ws-b": "failed" },
      payload: {},
    });

    const report = await store.resolveTaskRecovery({ "ws-a": "continue", "ws-b": "continue" });

    expect(report.ok).toBe(false);
    expect(report.unanswered).toEqual([]);
    expect(store.recoveryCandidates.map((c) => c.workspaceId)).toEqual(["ws-b"]);
  });

  test("a 'stale' outcome settles the candidate without being an error", async () => {
    const { store } = makeStore({ ok: true, outcomes: { "ws-a": "stale" }, payload: {} });

    const report = await store.resolveTaskRecovery({ "ws-a": "continue" });

    expect(report.ok).toBe(true);
    expect(report.unanswered).toEqual([]);
    expect(store.recoveryCandidates.map((c) => c.workspaceId)).toEqual(["ws-b"]);
  });

  test("an empty outcomes map keeps every candidate and reports them unanswered", async () => {
    const { store } = makeStore({ ok: true, outcomes: {}, payload: {} });

    const report = await store.resolveTaskRecovery({ "ws-a": "continue", "ws-b": "continue" });

    expect(report.ok).toBe(false);
    expect(report.unanswered).toEqual(["ws-a", "ws-b"]);
    expect(store.recoveryCandidates.map((c) => c.workspaceId)).toEqual(["ws-a", "ws-b"]);
  });

  test("a missing response is a protocol failure, not a silent success", async () => {
    const { store } = makeStore(undefined);

    const report = await store.resolveTaskRecovery({ "ws-a": "continue" });

    expect(report.ok).toBe(false);
    expect(report.outcomes).toEqual({});
    expect(report.unanswered).toEqual(["ws-a"]);
    expect(store.recoveryCandidates.map((c) => c.workspaceId)).toEqual(["ws-a", "ws-b"]);
  });

  test("an unrecognised outcome value settles nothing", async () => {
    const { store } = makeStore({ ok: true, outcomes: { "ws-a": "resumed-probably" }, payload: {} });

    const report = await store.resolveTaskRecovery({ "ws-a": "continue" });

    expect(report.ok).toBe(false);
    expect(report.outcomes).toEqual({});
    expect(report.unanswered).toEqual(["ws-a"]);
    expect(store.recoveryCandidates.map((c) => c.workspaceId)).toEqual(["ws-a", "ws-b"]);
  });

  test("`ok` is never inferred from a missing flag — it must be explicitly true", async () => {
    const { store } = makeStore({ outcomes: { "ws-a": "continued" }, payload: {} });

    const report = await store.resolveTaskRecovery({ "ws-a": "continue" });

    // The decision itself was settled, so the candidate goes; but the batch
    // cannot claim success on a response that never said so.
    expect(report.ok).toBe(false);
    expect(store.recoveryCandidates.map((c) => c.workspaceId)).toEqual(["ws-b"]);
  });

  test("a multi-window race: the loser gets 'stale' for its own decision only", async () => {
    const { store } = makeStore({
      ok: true,
      outcomes: { "ws-a": "stale", "ws-b": "continued" },
      payload: {},
    });

    const report = await store.resolveTaskRecovery({ "ws-a": "continue", "ws-b": "continue" });

    expect(report.ok).toBe(true);
    expect(report.outcomes).toEqual({ "ws-a": "stale", "ws-b": "continued" });
    expect(store.recoveryCandidates).toEqual([]);
  });
});
