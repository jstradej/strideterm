import { describe, expect, it, vi } from "vitest";
import type { JiraPollRequest } from "./jira-polling.js";
import { pollJiraQuery } from "./jira-polling-runtime.js";
import { JiraRequestError } from "./jira-request-error.js";

const request: JiraPollRequest = {
  profileId: "p1",
  connectionId: "j1",
  queryId: "q1",
  query: "project=ABC",
  watermark: null,
  overlapMs: 300_000,
  maxIssues: 500,
  maxRequests: 5,
};
const rows = (count: number) =>
  Array.from({ length: count }, (_, index) => ({
    ref: { issueId: String(index + 1), issueKey: `ABC-${index + 1}` },
    updated: "2026-10-23T00:00:00Z",
  }));
const page = (extra: Record<string, unknown> = {}) => ({ issues: rows(2), hasMore: false, cache: {}, ...extra });

describe("polling one saved query", () => {
  it("is complete only when Jira really answered", async () => {
    const result = await pollJiraQuery(
      request,
      async () => page(),
      () => 5,
    );
    expect(result).toMatchObject({ kind: "snapshot", complete: true, observedAt: 5 });
  });

  it("does not take a stale cached page, served because the refresh failed, as a complete poll", async () => {
    const stale = vi.fn(async () =>
      page({ cache: { refreshError: { code: "network", message: "Jira could not be reached while refreshing." } } }),
    );
    await expect(pollJiraQuery(request, stale)).rejects.toMatchObject({ code: "network" });
    const forbidden = vi.fn(async () =>
      page({ cache: { refreshError: { code: "permission-denied", message: "denied" } } }),
    );
    await expect(pollJiraQuery(request, forbidden)).rejects.toBeInstanceOf(JiraRequestError);
  });

  it("answers a rate limit with the poller's own result and honours Retry-After", async () => {
    const stale = vi.fn(async () =>
      page({ cache: { refreshError: { code: "rate-limited", message: "limited", retryAfterMs: 42_000 } } }),
    );
    expect(await pollJiraQuery(request, stale)).toEqual({ kind: "rate-limited", retryAfterMs: 42_000 });
    const thrown = vi.fn(async () => {
      throw new JiraRequestError("rate-limited", "limited", 9_000, 429);
    });
    expect(await pollJiraQuery(request, thrown)).toEqual({ kind: "rate-limited", retryAfterMs: 9_000 });
    const noHint = vi.fn(async () => {
      throw new JiraRequestError("rate-limited", "limited");
    });
    expect(await pollJiraQuery(request, noHint)).toEqual({ kind: "rate-limited" });
  });

  it("lets any other failure through with its code for the service to report", async () => {
    await expect(
      pollJiraQuery(request, async () => {
        throw new JiraRequestError("auth-expired", "expired", undefined, 401);
      }),
    ).rejects.toMatchObject({ code: "auth-expired" });
    await expect(pollJiraQuery(request, async () => null)).rejects.toMatchObject({ code: "unknown" });
  });
});
