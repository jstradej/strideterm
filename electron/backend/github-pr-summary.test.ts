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

describe("buildPullRequestSummary (github) — source repository", () => {
  const connection = { id: "github-a", label: "A", hostUrl: "https://github.com", currentUserLogin: "me" };
  const summaryFor = (pr: Record<string, unknown>) =>
    buildPullRequestSummary({
      connection,
      pr,
      reviews: [],
      reviewComments: [],
      issueComments: [],
      requestedReviewers: { users: [], teams: [] },
      workspaces: [],
      gitSnapshots: {},
      activeProfileId: "default",
    }).summary as unknown as { repository: Record<string, unknown>; sourceRepository: Record<string, unknown> | null };

  test("review.repository stays the TARGET (base) repository while sourceRepository is the HEAD repository", () => {
    const { repository, sourceRepository } = summaryFor(
      makePr({
        head: {
          ref: "login-fix",
          sha: "abc123",
          repo: {
            id: 555,
            name: "web-app",
            full_name: "contributor/web-app",
            clone_url: "https://github.com/contributor/web-app.git",
            permissions: { push: false },
          },
        },
        base: {
          ref: "main",
          sha: "def456",
          repo: {
            id: 100,
            name: "web-app",
            owner: { login: "acme" },
            clone_url: "https://github.com/acme/web-app.git",
          },
        },
      }),
    );

    expect(repository).toMatchObject({ fullName: "acme/web-app", remoteUrl: "https://github.com/acme/web-app.git" });
    expect(sourceRepository).toEqual({
      id: "555",
      name: "web-app",
      fullName: "contributor/web-app",
      remoteUrl: "https://github.com/contributor/web-app.git",
      sameAsTarget: false,
      canPush: false,
    });
  });

  test("a branch in the target repository itself is not a fork, and write access is unknown unless reported", () => {
    const { sourceRepository } = summaryFor(
      makePr({
        head: {
          ref: "feature/x",
          sha: "abc123",
          repo: {
            id: 100,
            name: "web-app",
            full_name: "acme/web-app",
            clone_url: "https://github.com/acme/web-app.git",
          },
        },
        base: { ref: "main", sha: "def456", repo: { id: 100, name: "web-app", owner: { login: "acme" } } },
      }),
    );
    expect(sourceRepository).toMatchObject({ id: "100", sameAsTarget: true, canPush: null });
  });

  test("write access the provider reports is carried as-is", () => {
    const { sourceRepository } = summaryFor(
      makePr({
        head: {
          ref: "feature/x",
          sha: "abc123",
          repo: { id: 100, name: "web-app", full_name: "acme/web-app", permissions: { push: true } },
        },
        base: { ref: "main", sha: "def456", repo: { id: 100, name: "web-app", owner: { login: "acme" } } },
      }),
    );
    expect(sourceRepository?.canPush).toBe(true);
  });

  test("a deleted fork leaves nothing to verify a write against", () => {
    const { sourceRepository } = summaryFor(makePr({ head: { ref: "x", sha: "abc123", repo: null } }));
    expect(sourceRepository).toBeNull();
  });
});
