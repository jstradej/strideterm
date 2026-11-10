import { beforeEach, describe, expect, it, vi } from "vitest";
import { ref } from "vue";
import { resetJiraMyIssuesForTests, useJiraMyIssues } from "./useJiraMyIssues.js";

const answer = (key: string) => ({
  connections: [{ connectionId: "c1", label: "Work", issues: [], hasMore: false, cache: null, key }],
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("useJiraMyIssues", () => {
  beforeEach(() => resetJiraMyIssuesForTests());

  it("returns the in-flight request to every caller, including force, and sends nothing new", async () => {
    const first = deferred<unknown>();
    const getJiraMyIssues = vi.fn().mockReturnValueOnce(first.promise);
    const mine = useJiraMyIssues(() => ({ getJiraMyIssues }), ref("default"));

    const started = mine.load("if-stale");
    const forced = mine.load("force");
    const cacheOnly = mine.load("cache-only");
    first.resolve(answer("a"));

    expect(await Promise.all([started, forced, cacheOnly])).toEqual([
      answer("a").connections,
      answer("a").connections,
      answer("a").connections,
    ]);
    expect(getJiraMyIssues).toHaveBeenCalledTimes(1);
  });

  it("waits for an in-flight cache-only read before asking Jira, and two waiters send one request", async () => {
    const cache = deferred<unknown>();
    const getJiraMyIssues = vi.fn().mockReturnValueOnce(cache.promise).mockResolvedValueOnce(answer("fresh"));
    const mine = useJiraMyIssues(() => ({ getJiraMyIssues }), ref("default"));

    const cached = mine.load("cache-only");
    const staleWaiter = mine.load("if-stale");
    const forceWaiter = mine.load("force");
    await Promise.resolve();
    expect(getJiraMyIssues).toHaveBeenCalledTimes(1);

    cache.reject(new Error("cache read failed"));
    await expect(cached).rejects.toThrow("cache read failed");
    await Promise.all([staleWaiter, forceWaiter]);

    expect(getJiraMyIssues).toHaveBeenCalledTimes(2);
    expect(getJiraMyIssues.mock.calls[1][0]).toEqual({ refresh: "if-stale" });
  });
});
