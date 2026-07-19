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
