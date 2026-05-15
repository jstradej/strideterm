import { describe, expect, test } from "vitest";
import { buildPullRequestSummary } from "./github-pr-summary.js";

function makePr(overrides: Record<string, unknown> = {}) {
  return {
    number: 42,
    title: "Feature X",
    state: "open",
    created_at: "2024-01-01T00:00:00Z",
    updated_at: "2024-01-01T00:00:00Z",
    head: { ref: "feature/x", sha: "abc123", repo: { clone_url: "https://github.com/acme/web-app.git" } },
    base: {
      ref: "main",
      sha: "def456",
      repo: { name: "web-app", owner: { login: "acme" }, clone_url: "https://github.com/acme/web-app.git" },
    },
    user: { login: "someone" },
    ...overrides,
  };
}

describe("buildPullRequestSummary (github) — profile scoping", () => {
  test("scopes review/matching workspace lookup to the connection's profile, not activeProfileId", () => {
    const connection = {
      id: "github-b",
      label: "GitHub B",
      hostUrl: "https://github.com",
      currentUserLogin: "me",
      profileId: "profile-b",
    };
    const workspaces = [
      {
        id: "ws-b-review",
        profileId: "profile-b",
        kind: "terminal",
        cwd: "C:/reviews/github-b/pr-42",
        review: { provider: "github", prKey: "github-b:acme/web-app:42" },
      },
      {
        id: "ws-default-other",
        profileId: "default",
        kind: "terminal",
        cwd: "C:/reviews/github-default/pr-99",
        review: { provider: "github", prKey: "github-default:acme/other:99" },
      },
    ];

    const { summary } = buildPullRequestSummary({
      connection,
      pr: makePr(),
      reviews: [],
      reviewComments: [],
      issueComments: [],
      requestedReviewers: { users: [], teams: [] },
      workspaces,
      gitSnapshots: {},
      activeProfileId: "default",
    });

    expect(summary.reviewWorkspaceId).toBe("ws-b-review");
  });

  test("falls back to activeProfileId when connection has no profileId", () => {
    const connection = {
      id: "github-legacy",
      label: "Legacy",
      hostUrl: "https://github.com",
      currentUserLogin: "me",
    };
    const workspaces = [
      {
        id: "ws-default-review",
        profileId: "default",
        kind: "terminal",
        cwd: "C:/reviews/legacy/pr-42",
        review: { provider: "github", prKey: "github-legacy:acme/web-app:42" },
      },
    ];

    const { summary } = buildPullRequestSummary({
      connection,
      pr: makePr(),
      reviews: [],
      reviewComments: [],
      issueComments: [],
      requestedReviewers: { users: [], teams: [] },
      workspaces,
      gitSnapshots: {},
      activeProfileId: "default",
    });

    expect(summary.reviewWorkspaceId).toBe("ws-default-review");
  });
});
