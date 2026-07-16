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
