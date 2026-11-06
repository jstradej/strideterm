import { describe, expect, it, vi } from "vitest";
import type { JiraPollRequest } from "./jira-polling.js";
import { collectJiraPollSnapshot } from "./jira-polling-runtime.js";

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
const rows = (start: number, count: number) =>
  Array.from({ length: count }, (_, index) => ({
    ref: { issueId: String(start + index), issueKey: `ABC-${start + index}` },
    updated: "2026-10-23T00:00:00Z",
  }));

describe("runtime Jira polling page collector", () => {
  it("includes later pages and marks a complete 150-issue snapshot complete", async () => {
    const searchPage = vi
      .fn()
      .mockResolvedValueOnce({ issues: rows(1, 100), hasMore: true, nextCursor: "page-2" })
      .mockResolvedValueOnce({ issues: rows(101, 50), hasMore: false });
    const result = await collectJiraPollSnapshot(request, searchPage, () => 123);
    expect(result).toMatchObject({ kind: "snapshot", complete: true, observedAt: 123 });
    if (result.kind === "snapshot") expect(result.issues).toHaveLength(150);
    expect(searchPage).toHaveBeenCalledTimes(2);
    expect(searchPage).toHaveBeenNthCalledWith(2, "page-2", 100);
  });

  it("marks capped or request-budget-exhausted membership incomplete", async () => {
    const capped = await collectJiraPollSnapshot(
      { ...request, maxIssues: 120 },
      vi
        .fn()
        .mockResolvedValueOnce({ issues: rows(1, 100), hasMore: true, nextCursor: "page-2" })
        .mockResolvedValueOnce({ issues: rows(101, 20), hasMore: true, nextCursor: "page-3" }),
    );
    expect(capped).toMatchObject({ kind: "snapshot", complete: false });
    const budget = await collectJiraPollSnapshot(
      { ...request, maxRequests: 1 },
      vi.fn().mockResolvedValue({ issues: rows(1, 100), hasMore: true, nextCursor: "page-2" }),
    );
    expect(budget).toMatchObject({ kind: "snapshot", complete: false });
  });
});
