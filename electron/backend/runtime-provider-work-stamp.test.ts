/**
 * V5 review, §"P2 — explicitní práce přímo v provider inboxu se ztrácí
 * z Recent" and the Azure/GitHub activity matrix in §"UX rozhodnutí V5".
 *
 * `recordWorkForPr` resolved the owning workspace from the review marker
 * alone, so a comment, thread status, vote or submitted review the user really
 * sent — but sent straight from the provider inbox, without ever creating a
 * local review workspace — moved no `lastWorkedAt` at all and never appeared
 * in "Recently worked".
 *
 * The fallback added here is narrow on purpose: it credits the provider inbox
 * only when the viewer is actually in it and the PR belongs to that inbox's
 * profile. Background polling, a new PR event and a passive open never reach
 * these handlers, so they still move nothing.
 */
import { describe, expect, test, vi } from "vitest";
import { createAzureHandlers } from "./runtime-azure-handlers.js";
import { createGitHubHandlers } from "./runtime-github-handlers.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyApi = any;

const PR_KEY = "conn-1:repo:30746";

interface Scenario {
  workspaces: AnyApi[];
  activeWorkspaceId?: string;
  prProfileId?: string | null;
  /**
   * Per-window active workspace — the multi-window case the desktop adapter
   * now feeds. `activeWorkspaceId` remains the LEGACY global fallback, so a
   * test can prove a handler is reading the viewer's own context and not it.
   */
  activeByViewer?: Record<string, string>;
  /** The deciding viewer's profile, for the cross-profile refusal guard. */
  viewerProfileId?: string | null;
}

function azureScenario({
  workspaces,
  activeWorkspaceId = "",
  prProfileId = "default",
  activeByViewer,
  viewerProfileId = null,
}: Scenario) {
  const recordWorkspaceWork = vi.fn(async (_workspaceId: string, _viewerId?: string) => {});
  const handlers = createAzureHandlers({
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    getState: () => ({ workspaces }),
    getPayload: () => ({
      azureDevops: { pullRequests: prProfileId === null ? {} : { [PR_KEY]: { profileId: prProfileId } } },
    }),
    getViewerProfileId: () => viewerProfileId,
    getViewerActiveWorkspaceId: (viewerId?: string) =>
      (activeByViewer && viewerId ? activeByViewer[viewerId] : undefined) ?? activeWorkspaceId,
    recordWorkspaceWork,
    azure: {
      addPullRequestComment: vi.fn(async () => {}),
      updateThreadStatus: vi.fn(async () => {}),
      setPullRequestVote: vi.fn(async () => {}),
      markPullRequestSeen: vi.fn(async () => {}),
    },
    refreshAzure: vi.fn(async () => {}),
  } as AnyApi);
  return { handlers, recordWorkspaceWork };
}

function githubScenario({
  workspaces,
  activeWorkspaceId = "",
  prProfileId = "default",
  activeByViewer,
  viewerProfileId = null,
}: Scenario) {
  const recordWorkspaceWork = vi.fn(async (_workspaceId: string, _viewerId?: string) => {});
  const handlers = createGitHubHandlers({
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    getState: () => ({ workspaces }),
    getPayload: () => ({
      github: { pullRequests: prProfileId === null ? {} : { [PR_KEY]: { profileId: prProfileId } } },
    }),
    getViewerProfileId: () => viewerProfileId,
    getViewerActiveWorkspaceId: (viewerId?: string) =>
      (activeByViewer && viewerId ? activeByViewer[viewerId] : undefined) ?? activeWorkspaceId,
    recordWorkspaceWork,
    github: {
      addPullRequestComment: vi.fn(async () => {}),
      submitPullRequestReview: vi.fn(async () => {}),
      markPullRequestSeen: vi.fn(async () => {}),
    },
    refreshGitHub: vi.fn(async () => {}),
  } as AnyApi);
  return { handlers, recordWorkspaceWork };
}

const AZURE_INBOX = { id: "ws-azure", kind: "azure", profileId: "default", name: "Azure DevOps" };
const GITHUB_INBOX = { id: "ws-github", kind: "github", profileId: "default", name: "GitHub" };
const REVIEW_CHILD = { id: "ws-review", kind: "manual", profileId: "default", review: { prKey: PR_KEY } };
const UNRELATED = { id: "ws-other", kind: "manual", profileId: "default", name: "Some project" };

describe("Azure review mutations — where the work is credited", () => {
  test("a local review workspace keeps priority over the inbox", async () => {
    const { handlers, recordWorkspaceWork } = azureScenario({
      workspaces: [AZURE_INBOX, REVIEW_CHILD],
      activeWorkspaceId: "ws-azure",
    });

    await handlers.commentAzurePullRequest({ prKey: PR_KEY, content: "looks good" }, "win-1");

    expect(recordWorkspaceWork.mock.calls).toEqual([["ws-review", "win-1"]]);
  });

  test("without a local workspace, an action taken IN the inbox credits the provider root", async () => {
    const { handlers, recordWorkspaceWork } = azureScenario({
      workspaces: [AZURE_INBOX],
      activeWorkspaceId: "ws-azure",
    });

    await handlers.commentAzurePullRequest({ prKey: PR_KEY, content: "looks good" }, "win-1");

    expect(recordWorkspaceWork.mock.calls).toEqual([["ws-azure", "win-1"]]);
  });

  test("thread status and vote use the same fallback", async () => {
    const status = azureScenario({ workspaces: [AZURE_INBOX], activeWorkspaceId: "ws-azure" });
    await status.handlers.updateAzureThreadStatus({ prKey: PR_KEY, threadId: 1, status: "closed" }, "win-1");
    expect(status.recordWorkspaceWork.mock.calls).toEqual([["ws-azure", "win-1"]]);

    const vote = azureScenario({ workspaces: [AZURE_INBOX], activeWorkspaceId: "ws-azure" });
    await vote.handlers.voteAzurePullRequest({ prKey: PR_KEY, vote: 10 }, "win-1");
    expect(vote.recordWorkspaceWork.mock.calls).toEqual([["ws-azure", "win-1"]]);
  });

  test("the same action from an unrelated workspace guesses nothing", async () => {
    const { handlers, recordWorkspaceWork } = azureScenario({
      workspaces: [AZURE_INBOX, UNRELATED],
      activeWorkspaceId: "ws-other",
    });

    await handlers.commentAzurePullRequest({ prKey: PR_KEY, content: "looks good" }, "win-1");

    expect(recordWorkspaceWork).not.toHaveBeenCalled();
  });

  test("an inbox in another profile than the PR is never credited", async () => {
    const { handlers, recordWorkspaceWork } = azureScenario({
      workspaces: [{ ...AZURE_INBOX, profileId: "work" }],
      activeWorkspaceId: "ws-azure",
      prProfileId: "default",
    });

    await handlers.commentAzurePullRequest({ prKey: PR_KEY, content: "looks good" }, "win-1");

    expect(recordWorkspaceWork).not.toHaveBeenCalled();
  });

  test("a PR the snapshot does not know is never credited to the inbox", async () => {
    const { handlers, recordWorkspaceWork } = azureScenario({
      workspaces: [AZURE_INBOX],
      activeWorkspaceId: "ws-azure",
      prProfileId: null,
    });

    await handlers.commentAzurePullRequest({ prKey: PR_KEY, content: "looks good" }, "win-1");

    expect(recordWorkspaceWork).not.toHaveBeenCalled();
  });

  test("no viewer context at all stamps nothing", async () => {
    const { handlers, recordWorkspaceWork } = azureScenario({ workspaces: [AZURE_INBOX], activeWorkspaceId: "" });

    await handlers.commentAzurePullRequest({ prKey: PR_KEY, content: "looks good" }, "win-1");

    expect(recordWorkspaceWork).not.toHaveBeenCalled();
  });

  // The activity matrix: acknowledging a PR is a passive open, not work — and
  // a background poll never reaches a handler at all. Only an allowlisted
  // MUTATION moves a timestamp.
  test("marking a PR seen is not work, in either provider", async () => {
    const azure = azureScenario({ workspaces: [AZURE_INBOX, REVIEW_CHILD], activeWorkspaceId: "ws-azure" });
    await azure.handlers.markAzurePullRequestSeen(PR_KEY, "win-1");
    expect(azure.recordWorkspaceWork).not.toHaveBeenCalled();

    const github = githubScenario({ workspaces: [GITHUB_INBOX, REVIEW_CHILD], activeWorkspaceId: "ws-github" });
    await github.handlers.markGitHubPullRequestSeen(PR_KEY, "win-1");
    expect(github.recordWorkspaceWork).not.toHaveBeenCalled();
  });
});

describe("GitHub review mutations — symmetric with Azure", () => {
  test("a local review workspace keeps priority over the inbox", async () => {
    const { handlers, recordWorkspaceWork } = githubScenario({
      workspaces: [GITHUB_INBOX, REVIEW_CHILD],
      activeWorkspaceId: "ws-github",
    });

    await handlers.commentGitHubPullRequest({ prKey: PR_KEY, body: "looks good" }, "win-1");

    expect(recordWorkspaceWork.mock.calls).toEqual([["ws-review", "win-1"]]);
  });

  test("without a local workspace, a comment and a review both credit the provider root", async () => {
    const comment = githubScenario({ workspaces: [GITHUB_INBOX], activeWorkspaceId: "ws-github" });
    await comment.handlers.commentGitHubPullRequest({ prKey: PR_KEY, body: "looks good" }, "win-1");
    expect(comment.recordWorkspaceWork.mock.calls).toEqual([["ws-github", "win-1"]]);

    const review = githubScenario({ workspaces: [GITHUB_INBOX], activeWorkspaceId: "ws-github" });
    await review.handlers.submitGitHubPullRequestReview({ prKey: PR_KEY, event: "APPROVE" }, "win-1");
    expect(review.recordWorkspaceWork.mock.calls).toEqual([["ws-github", "win-1"]]);
  });

  test("an Azure inbox is not a GitHub work target", async () => {
    const { handlers, recordWorkspaceWork } = githubScenario({
      workspaces: [AZURE_INBOX],
      activeWorkspaceId: "ws-azure",
    });

    await handlers.commentGitHubPullRequest({ prKey: PR_KEY, body: "looks good" }, "win-1");

    expect(recordWorkspaceWork).not.toHaveBeenCalled();
  });

  test("the same action from an unrelated workspace guesses nothing", async () => {
    const { handlers, recordWorkspaceWork } = githubScenario({
      workspaces: [GITHUB_INBOX, UNRELATED],
      activeWorkspaceId: "ws-other",
    });

    await handlers.commentGitHubPullRequest({ prKey: PR_KEY, body: "looks good" }, "win-1");

    expect(recordWorkspaceWork).not.toHaveBeenCalled();
  });
});

/**
 * V6 review, §"P1 — desktop Azure/GitHub mutation ztrácí viewer/window
 * kontext", oprava 2–4.
 *
 * The PR snapshot is the AUTHORITY on the profile all of this happens in.
 * The local lookup used to take the first global `review.prKey` match, so a
 * stale or duplicated marker in another profile won ahead of the correct
 * provider root — and because the helper had already committed to it, the
 * fallback never ran and the stamp was simply dropped by `recordWorkspaceWork`'s
 * own cross-profile guard.
 */
describe("Review work target — the PR's profile decides", () => {
  const WORK_INBOX = { id: "ws-azure-work", kind: "azure", profileId: "work", name: "Azure DevOps (work)" };
  const STALE_REVIEW_ELSEWHERE = { id: "ws-stale", kind: "manual", profileId: "other", review: { prKey: PR_KEY } };

  test("a stale review marker in another profile loses to the PR's own provider root", async () => {
    const { handlers, recordWorkspaceWork } = azureScenario({
      workspaces: [AZURE_INBOX, STALE_REVIEW_ELSEWHERE],
      activeWorkspaceId: "ws-azure",
      prProfileId: "default",
    });

    await handlers.commentAzurePullRequest({ prKey: PR_KEY, content: "looks good" }, "win-1");

    // Not ws-stale — the fallback is reached instead of being pre-empted.
    expect(recordWorkspaceWork.mock.calls).toEqual([["ws-azure", "win-1"]]);
  });

  test("the review workspace in the PR's own profile still wins over the inbox", async () => {
    const { handlers, recordWorkspaceWork } = azureScenario({
      workspaces: [AZURE_INBOX, STALE_REVIEW_ELSEWHERE, REVIEW_CHILD],
      activeWorkspaceId: "ws-azure",
      prProfileId: "default",
    });

    await handlers.commentAzurePullRequest({ prKey: PR_KEY, content: "looks good" }, "win-1");

    expect(recordWorkspaceWork.mock.calls).toEqual([["ws-review", "win-1"]]);
  });

  test("two windows in two profiles: only the window whose profile owns the PR is credited", async () => {
    // The viewer map is what the desktop IPC adapter now supplies; before V6
    // the handler saw `undefined` and fell back to the legacy global active
    // workspace, which is neither window's.
    const activeByWindow: Record<string, string> = { "win-A": "ws-azure", "win-B": "ws-azure-work" };

    const inWorkWindow = azureScenario({
      workspaces: [AZURE_INBOX, WORK_INBOX],
      activeWorkspaceId: "ws-legacy-active",
      activeByViewer: activeByWindow,
      prProfileId: "work",
    });
    await inWorkWindow.handlers.commentAzurePullRequest({ prKey: PR_KEY, content: "x" }, "win-B");
    expect(inWorkWindow.recordWorkspaceWork.mock.calls).toEqual([["ws-azure-work", "win-B"]]);

    // The same PR, decided from the OTHER window: its inbox is in the wrong
    // profile, so nothing is stamped rather than the wrong root.
    const inDefaultWindow = azureScenario({
      workspaces: [AZURE_INBOX, WORK_INBOX],
      activeWorkspaceId: "ws-legacy-active",
      activeByViewer: activeByWindow,
      prProfileId: "work",
    });
    await inDefaultWindow.handlers.commentAzurePullRequest({ prKey: PR_KEY, content: "x" }, "win-A");
    expect(inDefaultWindow.recordWorkspaceWork).not.toHaveBeenCalled();
  });

  test("GitHub resolves the same way, from the same snapshot authority", async () => {
    const stale = { ...STALE_REVIEW_ELSEWHERE };
    const { handlers, recordWorkspaceWork } = githubScenario({
      workspaces: [GITHUB_INBOX, stale],
      activeWorkspaceId: "ws-github",
      prProfileId: "default",
    });

    await handlers.commentGitHubPullRequest({ prKey: PR_KEY, body: "looks good" }, "win-1");

    expect(recordWorkspaceWork.mock.calls).toEqual([["ws-github", "win-1"]]);
  });

  test("a remote viewer resolves exactly like a desktop window — the routes stay symmetric", async () => {
    const desktop = azureScenario({
      workspaces: [AZURE_INBOX, WORK_INBOX],
      activeWorkspaceId: "ws-legacy-active",
      activeByViewer: { "win-B": "ws-azure-work", "remote:sess-b": "ws-azure-work" },
      prProfileId: "work",
    });
    await desktop.handlers.commentAzurePullRequest({ prKey: PR_KEY, content: "x" }, "win-B");

    const remote = azureScenario({
      workspaces: [AZURE_INBOX, WORK_INBOX],
      activeWorkspaceId: "ws-legacy-active",
      activeByViewer: { "win-B": "ws-azure-work", "remote:sess-b": "ws-azure-work" },
      prProfileId: "work",
    });
    await remote.handlers.commentAzurePullRequest({ prKey: PR_KEY, content: "x" }, "remote:sess-b");

    expect(desktop.recordWorkspaceWork.mock.calls).toEqual([["ws-azure-work", "win-B"]]);
    expect(remote.recordWorkspaceWork.mock.calls).toEqual([["ws-azure-work", "remote:sess-b"]]);
  });

  test("a PR from another profile is refused BEFORE the external mutation", async () => {
    const addPullRequestComment = vi.fn(async () => {});
    const recordWorkspaceWork = vi.fn(async () => {});
    const handlers = createAzureHandlers({
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      getState: () => ({ workspaces: [WORK_INBOX] }),
      getPayload: () => ({ azureDevops: { pullRequests: { [PR_KEY]: { profileId: "work" } } } }),
      // The deciding window is in "default"; the PR belongs to "work". With
      // the window id finally reaching the runtime, this guard can fire at all.
      getViewerProfileId: () => "default",
      getViewerActiveWorkspaceId: () => "ws-azure-work",
      recordWorkspaceWork,
      azure: { addPullRequestComment, markPullRequestSeen: vi.fn(async () => {}) },
      refreshAzure: vi.fn(async () => {}),
    } as AnyApi);

    await expect(handlers.commentAzurePullRequest({ prKey: PR_KEY, content: "x" }, "win-A")).rejects.toThrow(
      /Cross-profile refused/,
    );
    expect(addPullRequestComment).not.toHaveBeenCalled();
    expect(recordWorkspaceWork).not.toHaveBeenCalled();
  });

  /**
   * With no PR in the snapshot there is no authoritative profile, so the
   * VIEWER's is the scope — a stale marker in a third profile must not be
   * picked up, and the inbox fallback stays refused.
   */
  test("an unknown PR scopes the local lookup to the viewer's own profile", async () => {
    const refused = azureScenario({
      workspaces: [AZURE_INBOX, STALE_REVIEW_ELSEWHERE],
      activeWorkspaceId: "ws-azure",
      prProfileId: null,
      viewerProfileId: "default",
    });
    await refused.handlers.commentAzurePullRequest({ prKey: PR_KEY, content: "x" }, "win-1");
    expect(refused.recordWorkspaceWork).not.toHaveBeenCalled();

    const credited = azureScenario({
      workspaces: [AZURE_INBOX, REVIEW_CHILD],
      activeWorkspaceId: "ws-azure",
      prProfileId: null,
      viewerProfileId: "default",
    });
    await credited.handlers.commentAzurePullRequest({ prKey: PR_KEY, content: "x" }, "win-1");
    expect(credited.recordWorkspaceWork.mock.calls).toEqual([["ws-review", "win-1"]]);
  });
});
