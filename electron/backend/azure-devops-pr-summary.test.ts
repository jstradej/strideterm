import { describe, expect, test } from "vitest";
import { buildPullRequestSummary } from "./azure-devops-pr-summary.js";

function makePr(overrides: Record<string, unknown> = {}) {
  return {
    pullRequestId: 42,
    repository: {
      id: "repo-1",
      name: "web-app",
      remoteUrl: "https://dev.azure.com/acme/proj/_git/web-app",
    },
    sourceRefName: "refs/heads/feature/x",
    targetRefName: "refs/heads/main",
    creationDate: "2024-01-01T00:00:00Z",
    title: "Feature X",
    status: "active",
    mergeStatus: "succeeded",
    createdBy: { uniqueName: "someone@example.com" },
    reviewers: [],
    ...overrides,
  };
}

describe("buildPullRequestSummary — profile scoping", () => {
  test("scopes review/matching workspace lookup to the connection's profile, not activeProfileId", () => {
    // Setup: connection lives in profile-b. A review workspace tracking PR
    // 42 lives in profile-b too. The legacy `activeProfileId` is "default"
    // (e.g. windowSlots[0] in a multi-window setup). Without the fix, the
    // summary would filter workspaces to "default" and miss the actual
    // review workspace — the UI then thinks the PR has no associated
    // workspace and the user gets "open new review" instead of focusing
    // the existing one.
    const connection = {
      id: "azure-b",
      label: "Azure B",
      orgUrl: "https://dev.azure.com/acme",
      login: "me@example.com",
      profileId: "profile-b",
    };
    const workspaces = [
      {
        id: "ws-b-review",
        profileId: "profile-b",
        kind: "terminal",
        cwd: "C:/reviews/azure-b/pr-42",
        review: { provider: "azure-devops", prKey: "azure-b:repo-1:42" },
      },
      {
        id: "ws-default-other",
        profileId: "default",
        kind: "terminal",
        cwd: "C:/reviews/azure-default/pr-99",
        review: { provider: "azure-devops", prKey: "azure-default:repo-99:99" },
      },
    ];

    const { summary } = buildPullRequestSummary({
      connection,
      pr: makePr(),
      projectName: "proj",
      threads: [],
      tracked: {},
      workspaces,
      gitSnapshots: {},
      activeProfileId: "default", // intentional mismatch — the bug trigger
    });

    expect(summary.reviewWorkspaceId).toBe("ws-b-review");
    // Profile is exposed on the summary so downstream consumers (Telegram
    // alert dispatch) can route by it instead of guessing from "first
    // matching inbox workspace in any profile".
    expect(summary.profileId).toBe("profile-b");
  });

  test("falls back to activeProfileId when connection has no profileId (legacy data)", () => {
    // Legacy / pre-migration connections may not have profileId. The
    // activeProfileId fallback still keeps the function usable.
    const connection = {
      id: "azure-legacy",
      label: "Legacy",
      orgUrl: "https://dev.azure.com/acme",
      login: "me@example.com",
      // no profileId
    };
    const workspaces = [
      {
        id: "ws-default-review",
        profileId: "default",
        kind: "terminal",
        cwd: "C:/reviews/legacy/pr-42",
        review: { provider: "azure-devops", prKey: "azure-legacy:repo-1:42" },
      },
    ];

    const { summary } = buildPullRequestSummary({
      connection,
      pr: makePr(),
      projectName: "proj",
      threads: [],
      tracked: {},
      workspaces,
      gitSnapshots: {},
      activeProfileId: "default",
    });

    expect(summary.reviewWorkspaceId).toBe("ws-default-review");
  });
});
