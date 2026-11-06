import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { createJiraFailureLog, JIRA_STILL_FAILING_LOG_MS } from "./jira-failure-log.js";

describe("jira failure log", () => {
  let now = 0;
  const log = { warn: vi.fn(), info: vi.fn() };
  beforeEach(() => {
    vi.useFakeTimers();
    now = 1_000_000;
    log.warn.mockClear();
    log.info.mockClear();
  });
  afterEach(() => vi.useRealTimers());
  const make = () => createJiraFailureLog(log, { now: () => now });
  const key = { connectionId: "c1", scope: "poll:q1", code: "network" };

  it("logs the first failure and then stays quiet while the same failure persists", () => {
    const failures = make();
    for (let minute = 0; minute < 29; minute += 1) {
      failures.failure(key, { status: 503 });
      now += 60_000;
    }
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn.mock.calls[0][1]).toMatchObject({
      connectionId: "c1",
      scope: "poll:q1",
      code: "network",
      status: 503,
    });
  });

  it("writes one 'still failing' line per interval with the suppressed count", () => {
    const failures = make();
    failures.failure(key);
    for (let i = 0; i < 4; i += 1) failures.failure(key);
    now += JIRA_STILL_FAILING_LOG_MS;
    failures.failure(key);
    expect(log.warn).toHaveBeenCalledTimes(2);
    expect(log.warn.mock.calls[1][0]).toMatch(/still failing/);
    expect(log.warn.mock.calls[1][1]).toMatchObject({ suppressed: 4, failingForMs: JIRA_STILL_FAILING_LOG_MS });
    failures.failure(key);
    expect(log.warn).toHaveBeenCalledTimes(2);
  });

  it("logs again when the code changes and keeps the original start", () => {
    const failures = make();
    failures.failure(key);
    now += 5_000;
    failures.failure({ ...key, code: "auth-expired" });
    expect(log.warn).toHaveBeenCalledTimes(2);
    expect(log.warn.mock.calls[1][1]).toMatchObject({ code: "auth-expired", previousCode: "network" });
  });

  it("logs error -> ok once as info and treats the next failure as new", () => {
    const failures = make();
    failures.recovered("c1", "poll:q1");
    expect(log.info).not.toHaveBeenCalled();
    failures.failure(key);
    now += 7_000;
    failures.recovered("c1", "poll:q1", { op: "poll" });
    failures.recovered("c1", "poll:q1");
    expect(log.info).toHaveBeenCalledTimes(1);
    expect(log.info.mock.calls[0][1]).toMatchObject({ previousCode: "network", failedForMs: 7_000, op: "poll" });
    failures.failure(key);
    expect(log.warn).toHaveBeenCalledTimes(2);
  });

  it("tracks connections and scopes independently", () => {
    const failures = make();
    failures.failure(key);
    failures.failure({ ...key, connectionId: "c2" });
    failures.failure({ ...key, scope: "read" });
    expect(log.warn).toHaveBeenCalledTimes(3);
    failures.forget("c1");
    expect(failures.isFailing("c1", "poll:q1")).toBe(false);
    expect(failures.isFailing("c2", "poll:q1")).toBe(true);
  });

  it("works with fake timers advancing the clock", () => {
    const clock = createJiraFailureLog(log);
    clock.failure(key);
    vi.advanceTimersByTime(JIRA_STILL_FAILING_LOG_MS + 1);
    clock.failure(key);
    expect(log.warn).toHaveBeenCalledTimes(2);
  });
});
