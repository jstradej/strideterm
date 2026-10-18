import { beforeEach, describe, expect, it, vi } from "vitest";
import { usePullRequestReviewAction } from "./usePullRequestReviewAction.js";

const target = {
  provider: "github",
  prKey: "org/repo#17",
  kind: "pr-new",
  draftState: "ready",
};

describe("pull request review action", () => {
  beforeEach(() => window.localStorage.removeItem("strideterm-pr-review-starts-v1"));

  it("reuses a persisted idempotency key after an uncertain request failure", async () => {
    const action = usePullRequestReviewAction();
    const startPullRequestReview = vi
      .fn()
      .mockRejectedValueOnce(new Error("connection lost"))
      .mockResolvedValueOnce({ started: true as const, operationId: "operation-1", replayed: false });
    const api = { startPullRequestReview };

    await expect(action.start(target, api)).rejects.toThrow("connection lost");
    const afterFailure = action.recordFor(target);
    expect(afterFailure?.error).toBe("connection lost");

    const accepted = await action.start(target, api);
    expect(startPullRequestReview).toHaveBeenNthCalledWith(2, {
      provider: "github",
      prKey: "org/repo#17",
      idempotencyKey: afterFailure?.idempotencyKey,
    });
    expect(accepted?.operationId).toBe("operation-1");
    expect(JSON.parse(window.localStorage.getItem("strideterm-pr-review-starts-v1") || "{}")).toMatchObject({
      "default|github:org/repo#17:": { operationId: "operation-1" },
    });
  });

  it("keeps accepted operation state until the result can be navigated to", async () => {
    const action = usePullRequestReviewAction();
    const reviewTarget = { ...target, prKey: "org/repo#18" };
    const api = {
      startPullRequestReview: vi.fn(async () => ({
        started: true as const,
        operationId: "operation-2",
        replayed: false,
      })),
    };
    await action.start(reviewTarget, api);

    const reconciled = action.reconcileFinished({
      operationId: "operation-2",
      kind: "review.start",
      result: { workspaceId: "review-ws" },
    });
    expect(reconciled?.workspaceId).toBe("review-ws");
    expect(action.recordFor(reviewTarget)?.operationId).toBe("operation-2");

    action.markNavigated("operation-2");
    expect(action.recordFor(reviewTarget)).toBeUndefined();
  });

  it("returns and reconciles a terminal outcome included in an idempotent replay", async () => {
    const action = usePullRequestReviewAction();
    const reviewTarget = { ...target, prKey: "org/repo#19" };
    const outcome = {
      operationId: "finished-1",
      kind: "review.start",
      profileId: "default",
      finishedAt: new Date().toISOString(),
      result: { workspaceId: "review-ws-2" },
    };
    const api = {
      startPullRequestReview: vi.fn(async () => ({
        started: true as const,
        operationId: "finished-1",
        replayed: true,
        outcome,
      })),
    };

    const accepted = await action.start(reviewTarget, api);
    expect(accepted?.outcome).toEqual(outcome);
    const reconciled = action.reconcileFinished(outcome);
    expect(reconciled?.workspaceId).toBe("review-ws-2");
    expect(reconciled?.operationId).toBe("finished-1");
  });

  it("rotates the key after a terminal failed replay outcome", async () => {
    const action = usePullRequestReviewAction();
    const reviewTarget = { ...target, prKey: "org/repo#20" };
    const outcome = {
      operationId: "finished-failure",
      kind: "review.start",
      profileId: "default",
      finishedAt: new Date().toISOString(),
      error: { code: "failed", message: "Agent unavailable" },
    };
    const api = {
      startPullRequestReview: vi.fn(async () => ({
        started: true as const,
        operationId: "finished-failure",
        replayed: true,
        outcome,
      })),
    };

    const accepted = await action.start(reviewTarget, api);
    const oldKey = accepted?.idempotencyKey;
    expect(action.reconcileFinished(outcome)).toBeNull();
    expect(action.recordFor(reviewTarget)?.error).toBe("Agent unavailable");
    expect(action.recordFor(reviewTarget)?.idempotencyKey).not.toBe(oldKey);
  });

  it("uses a separate retry identity when the pull request head changes", async () => {
    const action = usePullRequestReviewAction();
    const api = {
      startPullRequestReview: vi
        .fn()
        .mockResolvedValueOnce({ started: true as const, operationId: "head-1", replayed: false })
        .mockResolvedValueOnce({ started: true as const, operationId: "head-2", replayed: false }),
    };
    await action.start({ ...target, headSha: "sha-one" }, api);
    await action.start({ ...target, headSha: "sha-two" }, api);
    expect(api.startPullRequestReview.mock.calls[0][0].idempotencyKey).not.toBe(
      api.startPullRequestReview.mock.calls[1][0].idempotencyKey,
    );
  });

  it("offers review only for ready new or newly-ready pull requests", async () => {
    const action = usePullRequestReviewAction();
    const badApi = { startPullRequestReview: vi.fn() };
    await expect(action.start({ ...target, draftState: "draft" }, badApi)).resolves.toBeNull();
    await expect(action.start({ ...target, kind: "comment" }, badApi)).resolves.toBeNull();
    expect(badApi.startPullRequestReview).not.toHaveBeenCalled();
  });
});
