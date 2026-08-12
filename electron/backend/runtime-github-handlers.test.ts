import { describe, expect, test, vi } from "vitest";
import { createGitHubHandlers } from "./runtime-github-handlers.js";

// The GitHub per-PR mutations (mark-seen / comment / submit-review) moved into
// slotAwareRoute this round, so the runtime now receives the caller's viewer id
// and must refuse a PR outside that viewer's profile — otherwise a remote client
// bound to profile B could clear badges on / comment on / review a profile-A PR
// it sees in the global snapshot (#32/#58/#63).
describe("GitHub per-PR mutations — cross-profile viewer guard", () => {
  function makeHandlers(callerProfileId: string | null) {
    const markPullRequestSeen = vi.fn(async () => {});
    const addPullRequestComment = vi.fn(async () => {});
    const submitPullRequestReview = vi.fn(async () => {});
    const refreshGitHub = vi.fn(async () => {});
    const handlers = createGitHubHandlers({
      github: { markPullRequestSeen, addPullRequestComment, submitPullRequestReview },
      refreshGitHub,
      getPayload: () => ({ github: { pullRequests: { "gh:pr1": { prKey: "gh:pr1", profileId: "p1" } } } }),
      getViewerProfileId: () => callerProfileId,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    return { handlers, markPullRequestSeen, addPullRequestComment, submitPullRequestReview };
  }

  test("mark-seen / comment / review are refused from a different-profile window", async () => {
    const { handlers, markPullRequestSeen, addPullRequestComment, submitPullRequestReview } = makeHandlers("p2");
    await expect(handlers.markGitHubPullRequestSeen("gh:pr1", "remote:sess-b")).rejects.toThrow(/Cross-profile/);
    await expect(handlers.commentGitHubPullRequest({ prKey: "gh:pr1", body: "x" }, "remote:sess-b")).rejects.toThrow(
      /Cross-profile/,
    );
    await expect(
      handlers.submitGitHubPullRequestReview({ prKey: "gh:pr1", event: "APPROVE" }, "remote:sess-b"),
    ).rejects.toThrow(/Cross-profile/);
    expect(markPullRequestSeen).not.toHaveBeenCalled();
    expect(addPullRequestComment).not.toHaveBeenCalled();
    expect(submitPullRequestReview).not.toHaveBeenCalled();
  });

  test("allowed for the caller's own profile", async () => {
    const { handlers, markPullRequestSeen, addPullRequestComment, submitPullRequestReview } = makeHandlers("p1");
    await handlers.markGitHubPullRequestSeen("gh:pr1", "remote:sess-a");
    await handlers.commentGitHubPullRequest({ prKey: "gh:pr1", body: "x" }, "remote:sess-a");
    await handlers.submitGitHubPullRequestReview({ prKey: "gh:pr1", event: "APPROVE" }, "remote:sess-a");
    expect(markPullRequestSeen).toHaveBeenCalledWith("gh:pr1");
    expect(addPullRequestComment).toHaveBeenCalledTimes(1);
    expect(submitPullRequestReview).toHaveBeenCalledTimes(1);
  });

  test("desktop IPC (no viewer id → null profile) is unaffected", async () => {
    const { handlers, markPullRequestSeen } = makeHandlers(null);
    await handlers.markGitHubPullRequestSeen("gh:pr1");
    expect(markPullRequestSeen).toHaveBeenCalledWith("gh:pr1");
  });
});

// pushGitHubReviewWorkspace wires the shared assertWorktreeCleanForPush guard
// (runtime-provider-guards.ts) in front of the real push. The guard itself is
// unit-tested in isolation; these tests pin its actual wiring into this
// handler — that it's called with the review workspace's cwd, that its thrown
// error propagates out of the handler, and that a dirty worktree blocks the
// push from ever reaching github.pushReviewWorkspace.
describe("pushGitHubReviewWorkspace — worktree-clean guard wiring", () => {
  function makeHandlers({ dirty = false, dirtyCount = 0 } = {}) {
    const workspace = { id: "ws-1", cwd: "/repo/ws-1", review: { prKey: "gh:pr1" } };
    const getCachedWorktreeDirtyState = vi.fn(async () => ({ dirty, dirtyCount }));
    const getSnapshot = vi.fn(() => ({ branch: "feature/foo" }));
    const pushReviewWorkspace = vi.fn(async () => {});
    const refreshGit = vi.fn(async () => {});
    const refreshGitHub = vi.fn(async () => {});
    const getPayload = vi.fn(() => ({ ok: true }));
    const handlers = createGitHubHandlers({
      getState: () => ({ workspaces: [workspace] }),
      git: { getCachedWorktreeDirtyState, getSnapshot },
      github: { pushReviewWorkspace },
      refreshGit,
      refreshGitHub,
      getPayload,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    return {
      handlers,
      workspace,
      getCachedWorktreeDirtyState,
      getSnapshot,
      pushReviewWorkspace,
      refreshGit,
      refreshGitHub,
      getPayload,
    };
  }

  test("rejects and never pushes when the worktree has uncommitted changes", async () => {
    const { handlers, workspace, getCachedWorktreeDirtyState, pushReviewWorkspace, refreshGit, refreshGitHub } =
      makeHandlers({ dirty: true, dirtyCount: 2 });

    await expect(handlers.pushGitHubReviewWorkspace("ws-1")).rejects.toThrow(
      "Cannot push: 2 uncommitted changes in the worktree. Commit your changes first, then try again.",
    );

    expect(getCachedWorktreeDirtyState).toHaveBeenCalledWith(workspace.cwd);
    expect(pushReviewWorkspace).not.toHaveBeenCalled();
    expect(refreshGit).not.toHaveBeenCalled();
    expect(refreshGitHub).not.toHaveBeenCalled();
  });

  test("pushes through when the worktree is clean", async () => {
    const { handlers, workspace, pushReviewWorkspace, refreshGit, refreshGitHub, getPayload } = makeHandlers({
      dirty: false,
      dirtyCount: 0,
    });

    const result = await handlers.pushGitHubReviewWorkspace("ws-1", { force: true });

    expect(pushReviewWorkspace).toHaveBeenCalledWith({ workspace, force: true, branch: "feature/foo" });
    expect(refreshGit).toHaveBeenCalledWith("ws-1");
    expect(refreshGitHub).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ ok: true });
    expect(getPayload).toHaveBeenCalled();
  });
});

// syncGitHubReviewWorkspace mirrors syncAzureReviewWorkspace (see
// runtime-azure-handlers.test.ts for the full rationale).
describe("syncGitHubReviewWorkspace — profile guard + in-flight coalescing", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function makeHandlers(overrides: any = {}) {
    const workspace = overrides.workspace ?? {
      id: "ws-1",
      cwd: "/repo/ws-1",
      review: { prKey: "gh:pr1", pullRequest: { sourceRefName: "refs/heads/feature" } },
    };
    const syncResult = overrides.syncResult ?? {
      status: "updated",
      message: "Updated 1 commit from origin/feature.",
      commitCount: 1,
      headSha: "sha-new",
      previousHeadSha: "sha-old",
    };
    const syncReviewWorkspace = overrides.syncReviewWorkspace ?? vi.fn(async () => syncResult);
    const refreshGit = overrides.refreshGit ?? vi.fn(async () => {});
    const refreshGitHub = overrides.refreshGitHub ?? vi.fn(async () => {});
    const broadcastState = overrides.broadcastState ?? vi.fn();
    const payload = overrides.payload ?? { ok: true };
    const getPayload = overrides.getPayload ?? vi.fn(() => payload);
    const assertWorkspaceInViewerProfile = overrides.assertWorkspaceInViewerProfile ?? vi.fn();
    const handlers = createGitHubHandlers({
      getState: () => ({ workspaces: [workspace] }),
      github: { syncReviewWorkspace },
      refreshGit,
      refreshGitHub,
      broadcastState,
      getPayload,
      assertWorkspaceInViewerProfile,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    return {
      handlers,
      workspace,
      syncResult,
      syncReviewWorkspace,
      refreshGit,
      refreshGitHub,
      broadcastState,
      getPayload,
      assertWorkspaceInViewerProfile,
      payload,
    };
  }

  test("runs the profile guard before touching git, and propagates its rejection", async () => {
    const assertWorkspaceInViewerProfile = vi.fn(() => {
      throw new Error("Cross-profile refused: workspace ws-1 is not in profile p2.");
    });
    const { handlers, syncReviewWorkspace } = makeHandlers({ assertWorkspaceInViewerProfile });

    await expect(handlers.syncGitHubReviewWorkspace("ws-1", "remote:sess-b")).rejects.toThrow(/Cross-profile/);

    expect(assertWorkspaceInViewerProfile).toHaveBeenCalledWith("ws-1", "remote:sess-b");
    expect(syncReviewWorkspace).not.toHaveBeenCalled();
  });

  test("on success: refreshes git + github, broadcasts, and returns {payload, result}", async () => {
    const { handlers, workspace, syncReviewWorkspace, refreshGit, refreshGitHub, broadcastState, getPayload, payload, syncResult } =
      makeHandlers();

    const response = await handlers.syncGitHubReviewWorkspace("ws-1");

    expect(syncReviewWorkspace).toHaveBeenCalledWith({ workspace });
    expect(refreshGit).toHaveBeenCalledWith("ws-1");
    expect(refreshGitHub).toHaveBeenCalledTimes(1);
    expect(broadcastState).toHaveBeenCalledTimes(1);
    expect(getPayload).toHaveBeenCalled();
    expect(response).toEqual({ payload, result: syncResult });
  });

  test("throws when the workspace has no review metadata", async () => {
    const { handlers } = makeHandlers({ workspace: { id: "ws-1", cwd: "/repo" } });
    await expect(handlers.syncGitHubReviewWorkspace("ws-1")).rejects.toThrow("GitHub review workspace not found.");
  });

  test("overlapping calls for the same workspace share one in-flight sync", async () => {
    let resolveSync: (value: unknown) => void = () => {};
    const gate = new Promise((resolve) => {
      resolveSync = resolve;
    });
    const syncReviewWorkspace = vi.fn(() => gate);
    const { handlers } = makeHandlers({ syncReviewWorkspace });

    const p1 = handlers.syncGitHubReviewWorkspace("ws-1");
    const p2 = handlers.syncGitHubReviewWorkspace("ws-1");
    resolveSync({ status: "already-current", message: "Already up to date.", commitCount: 0, headSha: "s", previousHeadSha: "s" });
    const [r1, r2] = await Promise.all([p1, p2]);

    expect(syncReviewWorkspace).toHaveBeenCalledTimes(1);
    expect(r1).toBe(r2);
  });
});
