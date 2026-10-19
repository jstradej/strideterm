import { describe, expect, test, vi } from "vitest";
import { GitHubManager } from "./github-manager.js";
import { buildPullRequestSummary } from "./github-pr-summary.js";

function createReviewStore() {
  return {
    getState: () => ({ connections: {}, trackedPullRequests: {} }),
    getTrackedPullRequest: () => null,
    upsertTrackedPullRequest: vi.fn(),
    upsertConnectionState: vi.fn(),
  };
}

function makeManager() {
  return new GitHubManager({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    credentialStore: { getSecret: () => "ghp-token" } as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    reviewStore: createReviewStore() as any,
    fetchImpl: vi.fn() as unknown as typeof fetch,
    execFileTextImpl: vi.fn().mockResolvedValue({ stdout: "", stderr: "" }),
    now: () => new Date("2026-03-17T10:05:00.000Z").getTime(),
  });
}

function summary() {
  return {
    prKey: "github:acme/web:42",
    connectionId: "github-main",
    profileId: "work",
    role: "reviewer",
    repository: { fullName: "acme/web", name: "web" },
    pullRequest: {
      number: 42,
      title: "Fix login redirect",
      webUrl: "https://github.com/acme/web/pull/42",
      updatedAt: "2026-03-17T10:04:00.000Z",
    },
    author: { login: "alice", displayName: "Alice" },
  };
}

function ghComment(id: number, body: string, at: string) {
  return {
    id,
    body,
    created_at: at,
    updated_at: at,
    user: { login: "bob", name: "Bob" },
  };
}

describe("GitHubManager review-activity deltas", () => {
  test("aggregates multiple new issue/review comments on one PR into one event", () => {
    const manager = makeManager();
    const result = manager._detectGitHubReviewActivityDeltas({
      tracked: { lastNotifiedActivityAt: "2026-03-17T10:00:00.000Z" },
      summary: summary(),
      seedingConnection: false,
      internals: {
        myLogin: "me",
        otherIssueComments: [
          ghComment(1, "Issue comment 1", "2026-03-17T10:01:00.000Z"),
          ghComment(2, "Issue comment 2", "2026-03-17T10:02:00.000Z"),
        ],
        otherReviewComments: [
          ghComment(3, "Review comment 3", "2026-03-17T10:03:00.000Z"),
          ghComment(4, "Review comment 4", "2026-03-17T10:04:00.000Z"),
          ghComment(5, "Review comment 5", "2026-03-17T10:05:00.000Z"),
        ],
      },
    });

    const commentEvents = result.events.filter(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (ev: any) => ev.kind === "pr-new-comment" && ev.prKey === "github:acme/web:42",
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const event = commentEvents[0] as any;

    expect(commentEvents).toHaveLength(1);
    expect(event.title).toContain("5 new comments");
    expect(event.body).toContain("Review comment 5");
    expect(event.commentTarget).toEqual({
      kind: "github-review-comment",
      commentId: "5",
      threadId: "5",
    });
    expect(event.at).toBe("2026-03-17T10:05:00.000Z");
  });

  test("targets the newest reply with a provider-specific id namespace", () => {
    const manager = makeManager();
    const result = manager._detectGitHubReviewActivityDeltas({
      tracked: { lastNotifiedActivityAt: "2026-03-17T10:00:00.000Z" },
      summary: summary(),
      seedingConnection: false,
      internals: {
        myLogin: "me",
        otherIssueComments: [ghComment(9, "issue comment", "2026-03-17T10:04:00.000Z")],
        otherReviewComments: [
          {
            ...ghComment(9, "review reply", "2026-03-17T10:05:00.000Z"),
            in_reply_to_id: 4,
          },
        ],
      },
    });
    const event = result.events.find((item) => (item as { kind?: string }).kind === "pr-new-comment") as {
      title: string;
      body: string;
      commentTarget?: unknown;
      at: string;
    };

    expect(event.title).toContain("2 new comments");
    expect(event.body).toContain("review reply");
    expect(event.commentTarget).toEqual({
      kind: "github-review-comment",
      commentId: "9",
      threadId: "4",
    });
    expect(event.at).toBe("2026-03-17T10:05:00.000Z");
  });

  test("emits only foreign comments after identity filtering, even when their login matches mine", () => {
    const manager = makeManager();
    const { summary: prSummary, internals } = buildPullRequestSummary({
      connection: {
        id: "github-main",
        currentUserLogin: "current",
        authenticatedUser: { id: "1", login: "current" },
      },
      pr: {
        number: 42,
        title: "Fix login redirect",
        state: "open",
        created_at: "2026-03-17T08:00:00.000Z",
        updated_at: "2026-03-17T10:00:00.000Z",
        base: { repo: { owner: { login: "acme" }, name: "web" } },
        head: { ref: "feature", sha: "sha" },
        user: { login: "author" },
      },
      issueComments: [
        {
          id: 1,
          body: "mine",
          created_at: "2026-03-17T10:01:00.000Z",
          user: { id: 1, login: "old-login", name: "Me" },
        },
        {
          id: 2,
          body: "foreign comment",
          created_at: "2026-03-17T10:02:00.000Z",
          user: { id: 2, login: "current", name: "Other person" },
        },
      ],
      tracked: { lastSeenActivityAt: "2026-03-17T10:00:00.000Z" },
    });
    const detected = manager._detectGitHubReviewActivityDeltas({
      tracked: { lastNotifiedActivityAt: "2026-03-17T10:00:00.000Z" },
      summary: prSummary,
      seedingConnection: false,
      internals,
    });
    const events = detected.events.filter((event) => (event as { kind?: string }).kind === "pr-new-comment") as Array<{
      title: string;
      body: string;
      commentTarget?: unknown;
    }>;

    expect(prSummary.newCommentsCount).toBe(1);
    expect(events).toHaveLength(1);
    expect(events[0].title).toContain("New comment");
    expect(events[0].body).toContain("foreign comment");
    expect(events[0].body).not.toContain("mine");
    expect(events[0].commentTarget).toEqual({ kind: "github-issue-comment", commentId: "2" });
  });

  test("self-only comments do not create comment events or attention", () => {
    const manager = makeManager();
    const { summary: prSummary, internals } = buildPullRequestSummary({
      connection: {
        id: "github-main",
        currentUserLogin: "current",
        authenticatedUser: { id: "1", login: "current" },
      },
      pr: {
        number: 42,
        title: "Fix login redirect",
        state: "open",
        created_at: "2026-03-17T08:00:00.000Z",
        updated_at: "2026-03-17T10:00:00.000Z",
        base: { repo: { owner: { login: "acme" }, name: "web" } },
        head: { ref: "feature", sha: "sha" },
        user: { login: "current" },
      },
      issueComments: [
        {
          id: 1,
          body: "mine",
          created_at: "2026-03-17T10:01:00.000Z",
          user: { id: 1, login: "current", name: "Me" },
        },
      ],
      tracked: { lastSeenActivityAt: "2026-03-17T10:00:00.000Z" },
    });
    const detected = manager._detectGitHubReviewActivityDeltas({
      tracked: {
        lastNotifiedActivityAt: "2026-03-17T10:00:00.000Z",
        lastDraftState: "ready",
        lastHeadSha: internals.headSha,
        lastReviewStateSignature: internals.reviewStateSignature,
        lastChecksSignature: internals.checksSignature,
      },
      summary: prSummary,
      seedingConnection: false,
      internals,
    });

    expect(prSummary.newCommentsCount).toBe(0);
    expect(prSummary.hasAttention).toBe(false);
    expect(detected.events.filter((event) => (event as { kind?: string }).kind === "pr-new-comment")).toHaveLength(0);
  });
});
