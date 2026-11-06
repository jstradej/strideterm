import { describe, expect, test } from "vitest";
import { buildPullRequestSummary } from "./azure-devops-pr-summary.js";

function makePr(overrides: Record<string, unknown> = {}) {
  return {
    pullRequestId: 42,
    repository: { id: "repo-1", name: "web-app", remoteUrl: "https://dev.azure.com/acme/proj/_git/web-app" },
    sourceRefName: "refs/heads/feature/x",
    targetRefName: "refs/heads/main",
    creationDate: "2024-01-01T00:00:00Z",
    title: "Feature X",
    status: "active",
    mergeStatus: "succeeded",
    createdBy: { id: "author-1", uniqueName: "someone@example.com" },
    reviewers: [],
    lastMergeSourceCommit: { commitId: "c2", committer: { date: "2026-02-01T00:00:00Z" } },
    ...overrides,
  };
}

describe("buildPullRequestSummary — your move", () => {
  const connection = { id: "azure-a", orgUrl: "https://dev.azure.com/acme", login: "me@example.com" };
  const ME = { id: "me-1", displayName: "Me", uniqueName: "me@example.com" };
  const BOB = { id: "bob-1", displayName: "Bob", uniqueName: "bob@example.com" };
  const group = (id: string, overrides: Record<string, unknown> = {}) => ({
    id,
    displayName: `[Proj]\\${id}`,
    isContainer: true,
    vote: 0,
    ...overrides,
  });
  const comment = (id: number, author: { id: string }, at: string, content = "text") => ({
    id,
    content,
    commentType: "text",
    publishedDate: at,
    lastUpdatedDate: at,
    author,
  });
  const thread = (id: number, status: string, comments: unknown[]) => ({ id, status, comments });

  type Built = {
    role: string;
    hasAttention: boolean;
    attentionReason: string;
    attentionReasons: Array<{ code: string; label: string; ackOnSeen: boolean }>;
    isDirectReviewer: boolean;
    myReviewStatus: string;
    newCommentsCount: number;
    reviewerVia: Array<Record<string, unknown>>;
  };
  const build = (
    options: {
      pr?: Record<string, unknown>;
      threads?: unknown[];
      tracked?: Record<string, unknown>;
      groups?: string[];
    } = {},
  ) => {
    const result = buildPullRequestSummary({
      connection,
      pr: makePr(options.pr),
      projectName: "proj",
      threads: (options.threads || []) as Array<Record<string, unknown>>,
      tracked: options.tracked || {},
      currentUserId: "me-1",
      myGroupIds: options.groups || [],
    });
    return { summary: result.summary as unknown as Built, internals: result.internals };
  };
  const codes = (built: { summary: Built }) => built.summary.attentionReasons.map((reason) => reason.code);

  test("a direct reviewer who has not voted owes a review", () => {
    const { summary } = build({ pr: { reviewers: [{ ...ME, vote: 0 }] } });
    expect(summary).toMatchObject({
      role: "reviewer",
      isDirectReviewer: true,
      myReviewStatus: "pending",
      hasAttention: true,
      attentionReason: "Your review",
    });
    expect(summary.attentionReasons[0]).toEqual({ code: "review-requested", label: "Your review", ackOnSeen: false });
  });

  test("a draft raises no review request", () => {
    const built = build({ pr: { isDraft: true, reviewers: [{ ...ME, vote: 0 }] } });
    expect(built.summary.role).toBe("reviewer");
    expect(built.summary.hasAttention).toBe(false);
    expect(built.summary.attentionReason).toBe("");
  });

  test("a member of a requested group owes a review, naming the group without its project prefix", () => {
    const { summary } = build({ pr: { reviewers: [group("g1")] }, groups: ["G1"] });
    expect(summary).toMatchObject({
      role: "reviewer",
      isDirectReviewer: false,
      myReviewStatus: "pending",
      attentionReason: "Your review · via g1",
    });
    expect(summary.attentionReasons[0].code).toBe("group-review-requested");
  });

  test("a required uncovered group is named before an optional one", () => {
    const { summary } = build({
      pr: { reviewers: [group("g1"), group("g2", { isRequired: true })] },
      groups: ["g1", "g2"],
    });
    expect(summary.attentionReason).toBe("Your review · via g2");
  });

  test("a group a colleague already voted for is covered and raises nothing", () => {
    const { summary } = build({
      pr: { reviewers: [group("g1"), { ...BOB, vote: 10, votedFor: [{ id: "g1", displayName: "g1" }] }] },
      groups: ["g1"],
    });
    expect(summary).toMatchObject({ role: "reviewer", myReviewStatus: "covered", hasAttention: false });
    expect(summary.reviewerVia).toEqual([
      expect.objectContaining({ id: "g1", covered: true, coveredBy: "Bob", vote: 0 }),
    ]);
  });

  test("a group vote alone covers the group without naming a colleague", () => {
    const { summary } = build({ pr: { reviewers: [group("g1", { vote: -5 })] }, groups: ["g1"] });
    expect(summary.myReviewStatus).toBe("covered");
    expect(summary.reviewerVia[0]).toMatchObject({ covered: true, coveredBy: null, vote: -5 });
  });

  test("a colleague with no vote does not cover the group", () => {
    const { summary } = build({
      pr: { reviewers: [group("g1"), { ...BOB, vote: 0, votedFor: [{ id: "g1" }] }] },
      groups: ["g1"],
    });
    expect(summary.myReviewStatus).toBe("pending");
  });

  test("a group the user is not in leaves them an observer", () => {
    const { summary } = build({ pr: { reviewers: [group("g1")] }, groups: ["other"] });
    expect(summary).toMatchObject({ role: "observer", myReviewStatus: "none", hasAttention: false });
    expect(summary.reviewerVia).toEqual([]);
  });

  test("a direct request wins over a covered group", () => {
    const { summary } = build({
      pr: { reviewers: [{ ...ME, vote: 0 }, group("g1", { vote: 10 })] },
      groups: ["g1"],
    });
    expect(summary).toMatchObject({ myReviewStatus: "pending", attentionReason: "Your review" });
  });

  test("a declined or cast vote is not a pending review", () => {
    expect(build({ pr: { reviewers: [{ ...ME, vote: 0, hasDeclined: true }] } }).summary).toMatchObject({
      myReviewStatus: "declined",
      hasAttention: false,
    });
    expect(build({ pr: { reviewers: [{ ...ME, vote: 10 }] } }).summary).toMatchObject({
      myReviewStatus: "voted",
      hasAttention: false,
    });
  });

  test("a push after the user's approval raises attention until the PR is opened", () => {
    const tracked = { reviewerVotes: { "me-1": { vote: 10, commitId: "c1" } } };
    const pr = { reviewers: [{ ...ME, vote: 10 }] };
    const before = build({ pr, tracked });
    expect(codes(before)).toEqual(["push-after-approval"]);
    expect(before.summary.attentionReason).toBe("New push after your approval");
    expect(before.summary.attentionReasons[0].ackOnSeen).toBe(true);

    expect(codes(build({ pr, tracked: { ...tracked, lastSeenActivityAt: "2026-02-01T00:00:00Z" } }))).toEqual([]);
  });

  test("a push after the user asked for changes says so", () => {
    const built = build({
      pr: { reviewers: [{ ...ME, vote: -5 }] },
      tracked: { reviewerVotes: { "me-1": { vote: -5, commitId: "c1" } } },
    });
    expect(built.summary.attentionReason).toBe("Pushed after your feedback");
  });

  test("the first observation of a vote stamps the current commit and raises nothing", () => {
    const built = build({
      pr: {
        reviewers: [
          { ...ME, vote: 10 },
          { ...BOB, vote: 0 },
        ],
      },
    });
    expect(codes(built)).toEqual([]);
    expect(built.internals.reviewerVotes).toEqual({ "me-1": { vote: 10, commitId: "c2" } });
  });

  test("a changed vote is re-stamped, a reset vote is dropped, a removed reviewer is forgotten", () => {
    const tracked = {
      reviewerVotes: {
        "me-1": { vote: 10, commitId: "c1" },
        "bob-1": { vote: -5, commitId: "c1" },
        gone: { vote: 10, commitId: "c1" },
      },
    };
    const built = build({
      pr: {
        reviewers: [
          { ...ME, vote: -5 },
          { ...BOB, vote: 0 },
        ],
      },
      tracked,
    });
    expect(built.internals.reviewerVotes).toEqual({ "me-1": { vote: -5, commitId: "c2" } });
  });

  test("the author hears about changes requested only until the next push", () => {
    const pr = { createdBy: ME, reviewers: [{ ...BOB, vote: -5 }] };
    const waiting = build({ pr, tracked: { reviewerVotes: { "bob-1": { vote: -5, commitId: "c2" } } } });
    expect(waiting.summary).toMatchObject({ role: "author", attentionReason: "Bob: waiting for author" });
    expect(waiting.summary.attentionReasons[0]).toMatchObject({ code: "changes-requested", ackOnSeen: false });

    expect(codes(build({ pr, tracked: { reviewerVotes: { "bob-1": { vote: -5, commitId: "c1" } } } }))).toEqual([]);

    const rejected = build({
      pr: { createdBy: ME, reviewers: [{ ...BOB, vote: -10 }] },
      tracked: { reviewerVotes: { "bob-1": { vote: -10, commitId: "c2" } } },
    });
    expect(rejected.summary.attentionReason).toBe("Rejected by Bob");
  });

  test("the author is told about conflicts and failed merge checks, draft or not", () => {
    expect(build({ pr: { createdBy: ME, isDraft: true, mergeStatus: "conflicts" } }).summary).toMatchObject({
      attentionReason: "Merge conflicts",
    });
    expect(build({ pr: { createdBy: ME, mergeStatus: "rejectedByPolicy" } }).summary).toMatchObject({
      attentionReason: "Merge check failed",
    });
    expect(build({ pr: { createdBy: ME, mergeStatus: "failure" } }).summary.attentionReasons[0].code).toBe(
      "merge-failed",
    );
    expect(build({ pr: { mergeStatus: "conflicts" } }).summary.hasAttention).toBe(false);
  });

  describe("replies", () => {
    const reviewing = { reviewers: [{ ...ME, vote: 10 }] };
    const seen = {
      lastSeenActivityAt: "2026-01-02T00:00:00Z",
      reviewerVotes: { "me-1": { vote: 10, commitId: "c2" } },
    };

    test("a reply in a thread the user took part in", () => {
      const threads = [
        thread(1, "active", [
          comment(1, ME, "2026-01-03T00:00:00Z"),
          comment(2, BOB, "2026-01-04T00:00:00Z"),
          comment(3, BOB, "2026-01-05T00:00:00Z"),
        ]),
      ];
      const built = build({ pr: reviewing, threads, tracked: seen });
      expect(built.summary.attentionReasons).toEqual([{ code: "replies", label: "2 replies to you", ackOnSeen: true }]);
    });

    test("a comment older than the user's own last comment is not a reply", () => {
      const threads = [
        thread(1, "active", [comment(1, BOB, "2026-01-03T00:00:00Z"), comment(2, ME, "2026-01-04T00:00:00Z")]),
      ];
      expect(codes(build({ pr: reviewing, threads, tracked: seen }))).toEqual([]);
    });

    test("a comment in a thread the user is not part of is not a reply", () => {
      const threads = [thread(1, "active", [comment(1, BOB, "2026-01-04T00:00:00Z")])];
      const built = build({ pr: reviewing, threads, tracked: seen });
      expect(codes(built)).toEqual([]);
      expect(built.summary.newCommentsCount).toBe(1);
    });

    test("a mention makes the comment relevant", () => {
      const threads = [
        thread(1, "active", [
          comment(1, BOB, "2026-01-04T00:00:00Z", "ping @<ME-1> please"),
          comment(2, BOB, "2026-01-05T00:00:00Z", "unrelated"),
        ]),
      ];
      expect(build({ pr: reviewing, threads, tracked: seen }).summary.attentionReason).toBe("1 reply to you");
    });

    test("the user's own comment and a resolved thread are not replies", () => {
      const threads = [
        thread(1, "active", [comment(1, ME, "2026-01-04T00:00:00Z")]),
        thread(2, "fixed", [comment(2, ME, "2026-01-03T00:00:00Z"), comment(3, BOB, "2026-01-04T00:00:00Z")]),
      ];
      expect(codes(build({ pr: reviewing, threads, tracked: seen }))).toEqual([]);
    });

    test("the author sees every new comment from others and opening the PR acknowledges them", () => {
      const pr = { createdBy: ME };
      const threads = [thread(1, "pending", [comment(1, BOB, "2026-01-04T00:00:00Z")])];
      expect(build({ pr, threads, tracked: seen }).summary.attentionReasons).toEqual([
        { code: "replies", label: "1 new comment", ackOnSeen: true },
      ]);
      expect(codes(build({ pr, threads, tracked: { lastSeenActivityAt: "2026-01-04T00:00:00Z" } }))).toEqual([]);
    });
  });

  test("an observer is not flagged for the commits of a PR they never opened", () => {
    const { summary } = build({
      pr: { reviewers: [{ ...BOB, vote: 0 }] },
      threads: [thread(1, "active", [comment(1, BOB, "2026-01-04T00:00:00Z")])],
    });
    expect(summary).toMatchObject({ role: "observer", hasAttention: false, attentionReason: "", newCommentsCount: 1 });
    expect(summary.attentionReasons).toEqual([]);
  });

  describe("lastOthersActivityAt (unread)", () => {
    const othersAt = (options: Parameters<typeof build>[0]) =>
      (build(options).summary as unknown as { lastOthersActivityAt: string | null }).lastOthersActivityAt;

    test("the user's own comment and own push do not count", () => {
      expect(
        othersAt({
          pr: {
            creationDate: "2026-01-01T00:00:00Z",
            lastMergeSourceCommit: {
              commitId: "c2",
              committer: { name: "Me", email: "me@example.com", date: "2026-02-01T00:00:00Z" },
            },
          },
          threads: [
            thread(1, "active", [
              comment(1, BOB, "2026-01-10T00:00:00Z"),
              comment(2, { id: "me-1" }, "2026-03-01T00:00:00Z"),
            ]),
          ],
        }),
      ).toBe("2026-01-10T00:00:00.000Z");
    });

    test("someone else's push counts, and the user's own new PR does not", () => {
      const pr = {
        createdBy: { id: "me-1", uniqueName: "me@example.com" },
        creationDate: "2026-01-01T00:00:00Z",
        lastMergeSourceCommit: {
          commitId: "c2",
          committer: { name: "Bob", email: "bob@example.com", date: "2026-02-01T00:00:00Z" },
        },
      };
      expect(othersAt({ pr })).toBe("2026-02-01T00:00:00.000Z");
      expect(
        othersAt({
          pr: {
            ...pr,
            lastMergeSourceCommit: {
              commitId: "c2",
              committer: { email: "me@example.com", date: "2026-02-01T00:00:00Z" },
            },
          },
        }),
      ).toBeNull();
    });
  });
});
