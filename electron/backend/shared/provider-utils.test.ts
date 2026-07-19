import { describe, expect, it } from "vitest";
import { dedupePrSummaries, buildInboxViews } from "./provider-utils.js";

describe("dedupePrSummaries", () => {
  it("collapses summaries with identical (orgUrl, repoId, prId) keeping the better one", () => {
    const a = {
      prKey: "conn-1::repo-1::42",
      orgUrl: "https://dev.azure.com/org",
      repository: { id: "repo-1" },
      pullRequest: { id: 42 },
      role: "reviewer",
      hasAttention: true,
      lastActivityAt: "2026-05-22T10:00:00Z",
    };
    const b = {
      prKey: "conn-2::repo-1::42",
      orgUrl: "https://dev.azure.com/org",
      repository: { id: "repo-1" },
      pullRequest: { id: 42 },
      role: "other",
      hasAttention: false,
      lastActivityAt: "2026-05-22T11:00:00Z",
    };
    const result = dedupePrSummaries([b, a]);
    expect(result).toHaveLength(1);
    // `a` wins because hasAttention=true beats hasAttention=false even
    // though `b` has a fresher lastActivityAt.
    expect(result[0]).toBe(a);
  });

  it("keeps distinct PRs across different orgs untouched", () => {
    const orgA = {
      prKey: "x",
      orgUrl: "https://dev.azure.com/orgA",
      repository: { id: "repo" },
      pullRequest: { id: 1 },
      hasAttention: false,
      lastActivityAt: "2026-01-01T00:00:00Z",
    };
    const orgB = {
      prKey: "y",
      orgUrl: "https://dev.azure.com/orgB",
      repository: { id: "repo" },
      pullRequest: { id: 1 },
      hasAttention: false,
      lastActivityAt: "2026-01-01T00:00:00Z",
    };
    const result = dedupePrSummaries([orgA, orgB]);
    expect(result).toHaveLength(2);
  });

  it("falls back to role ranking when attention signal is equal", () => {
    const reviewer = {
      prKey: "r",
      orgUrl: "o",
      repository: { id: "1" },
      pullRequest: { id: 7 },
      role: "reviewer",
      hasAttention: false,
      lastActivityAt: "2026-01-01T00:00:00Z",
    };
    const other = {
      prKey: "o",
      orgUrl: "o",
      repository: { id: "1" },
      pullRequest: { id: 7 },
      role: "other",
      hasAttention: false,
      lastActivityAt: "2026-01-01T00:00:00Z",
    };
    const result = dedupePrSummaries([other, reviewer]);
    expect(result).toHaveLength(1);
    expect(result[0]).toBe(reviewer);
  });

  it("uses lastActivityAt as the final tie-breaker", () => {
    const older = {
      prKey: "o",
      orgUrl: "o",
      repository: { id: "1" },
      pullRequest: { id: 9 },
      role: "reviewer",
      hasAttention: true,
      lastActivityAt: "2025-12-01T00:00:00Z",
    };
    const newer = {
      prKey: "n",
      orgUrl: "o",
      repository: { id: "1" },
      pullRequest: { id: 9 },
      role: "reviewer",
      hasAttention: true,
      lastActivityAt: "2026-05-22T00:00:00Z",
    };
    const result = dedupePrSummaries([older, newer, older]);
    expect(result).toHaveLength(1);
    expect(result[0]).toBe(newer);
  });

  it("preserves entries with no canonical key under a synthetic id so they aren't dropped", () => {
    const broken1 = { prKey: "a", orgUrl: "o", repository: {}, pullRequest: {} };
    const broken2 = { prKey: "b", orgUrl: "o", repository: {}, pullRequest: {} };
    const result = dedupePrSummaries([broken1, broken2]);
    expect(result).toHaveLength(2);
  });
});

describe("buildInboxViews", () => {
  it("routes summaries into needsMyReview / myPullRequests by role", () => {
    const reviewerPr = { prKey: "r", role: "reviewer", hasAttention: false, lastActivityAt: "2026-01-01T00:00:00Z" };
    const authorPr = { prKey: "a", role: "author", hasAttention: false, lastActivityAt: "2026-01-01T00:00:00Z" };
    const otherPr = { prKey: "o", role: "other", hasAttention: false, lastActivityAt: "2026-01-01T00:00:00Z" };

    const views = buildInboxViews([reviewerPr, authorPr, otherPr]);

    expect(views.needsMyReview).toEqual([reviewerPr]);
    expect(views.myPullRequests).toEqual([authorPr]);
    // "other"-role summaries land in neither role bucket, but still show up
    // in recentlyUpdated (which is role-agnostic).
    expect(views.recentlyUpdated).toHaveLength(3);
  });

  it("sorts each role bucket by hasAttention first, then most-recent activity", () => {
    const stale = { prKey: "stale", role: "reviewer", hasAttention: false, lastActivityAt: "2026-01-01T00:00:00Z" };
    const fresh = { prKey: "fresh", role: "reviewer", hasAttention: false, lastActivityAt: "2026-03-01T00:00:00Z" };
    const urgent = { prKey: "urgent", role: "reviewer", hasAttention: true, lastActivityAt: "2025-01-01T00:00:00Z" };

    const views = buildInboxViews([stale, fresh, urgent]);

    // urgent wins despite being the oldest, because hasAttention beats recency.
    expect(views.needsMyReview.map((s) => s.prKey)).toEqual(["urgent", "fresh", "stale"]);
  });

  it("sorts recentlyUpdated purely by lastActivityAt, ignoring hasAttention and role", () => {
    const older = { prKey: "older", role: "author", hasAttention: true, lastActivityAt: "2025-01-01T00:00:00Z" };
    const newer = { prKey: "newer", role: "reviewer", hasAttention: false, lastActivityAt: "2026-06-01T00:00:00Z" };

    const views = buildInboxViews([older, newer]);

    expect(views.recentlyUpdated.map((s) => s.prKey)).toEqual(["newer", "older"]);
  });

  it("filters needsAttention to only hasAttention summaries, sorted by recency", () => {
    const attentionOld = { prKey: "old", role: "author", hasAttention: true, lastActivityAt: "2025-01-01T00:00:00Z" };
    const attentionNew = {
      prKey: "new",
      role: "reviewer",
      hasAttention: true,
      lastActivityAt: "2026-06-01T00:00:00Z",
    };
    const noAttention = { prKey: "none", role: "author", hasAttention: false, lastActivityAt: "2026-06-01T00:00:00Z" };

    const views = buildInboxViews([attentionOld, attentionNew, noAttention]);

    expect(views.needsAttention.map((s) => s.prKey)).toEqual(["new", "old"]);
  });

  it("does not mutate the input array (recentlyUpdated sorts a copy)", () => {
    const a = { prKey: "a", role: "author", hasAttention: false, lastActivityAt: "2025-01-01T00:00:00Z" };
    const b = { prKey: "b", role: "author", hasAttention: false, lastActivityAt: "2026-01-01T00:00:00Z" };
    const input = [a, b];

    buildInboxViews(input);

    expect(input).toEqual([a, b]);
  });
});
