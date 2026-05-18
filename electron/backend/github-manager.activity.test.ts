import { describe, expect, test, vi } from "vitest";
import { GitHubManager } from "./github-manager.js";

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
  });
});
