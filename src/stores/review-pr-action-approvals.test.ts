import { computed, ref, shallowRef } from "vue";
import { describe, expect, it, vi } from "vitest";
import { reviewPrActionConfirmSchema } from "../../electron/backend/ipc-schemas.js";
import { reviewPrActionProposalSchema, type ReviewPrActionProposal } from "../../electron/shared/review-pr-actions.js";
import { createReviewPrActionApprovals } from "./review-pr-action-approvals.js";

function makeProposal(proposalId: string, profileId = "profile-a"): ReviewPrActionProposal {
  return reviewPrActionProposalSchema.parse({
    proposalId,
    profileId,
    workspaceId: "ws-a",
    provider: "azure-devops",
    prKey: "project/repo/17",
    action: "complete",
    options: { mergeMethod: "squash" },
    title: "Complete pull request",
    message: "Complete PR 17 after a fresh provider check.",
    snapshot: {
      provider: "azure-devops",
      prKey: "project/repo/17",
      connectionId: "connection-1",
      repository: "project/repo",
      number: 17,
      url: "https://dev.azure.com/org/project/_git/repo/pullrequest/17",
      title: "Fix deployment",
      state: "active",
      isDraft: false,
      autoMerge: false,
      source: { repository: "project/repo", branch: "fix/deploy", sha: "head-sha" },
      target: { repository: "project/repo", branch: "main", sha: "target-sha" },
      checks: { state: "success", total: 1, successful: 1, failed: 0, pending: 0, items: [] },
      mergeReadiness: { state: "ready" },
      review: { approvals: 2, changesRequested: 0, requiredApprovals: 2 },
      supportedActions: ["complete"],
    },
    expiresAt: "2999-10-22T12:00:00.000Z",
  });
}

function makeStore(initial: ReviewPrActionProposal[]) {
  const payload = shallowRef<unknown>({ reviewPrActions: { pending: initial } });
  const activeProfileId = ref<string | null>("profile-a");
  const confirmReviewPrAction = vi.fn().mockResolvedValue({ status: "accepted" });
  const store = createReviewPrActionApprovals({
    payload,
    myActiveProfileId: computed(() => activeProfileId.value),
    getApi: () => ({ confirmReviewPrAction }) as never,
  });
  return { store, payload, activeProfileId, confirmReviewPrAction };
}

describe("review PR action approvals", () => {
  it("recovers pending proposals from payloads but never executes from a payload or duplicate update", () => {
    const proposal = makeProposal("proposal-a");
    const { store, payload, confirmReviewPrAction } = makeStore([]);
    expect(store.pendingProposals.value).toEqual([]);

    payload.value = { reviewPrActions: { pending: [proposal] } };
    expect(store.pendingProposals.value).toEqual([proposal]);
    payload.value = { reviewPrActions: { pending: [proposal] } };
    expect(store.pendingProposals.value).toEqual([proposal]);
    expect(confirmReviewPrAction).not.toHaveBeenCalled();
  });

  it("only exposes the active profile and refuses a queued click after switching profiles", async () => {
    const own = makeProposal("proposal-a", "profile-a");
    const other = makeProposal("proposal-b", "profile-b");
    const { store, activeProfileId, confirmReviewPrAction } = makeStore([own, other]);
    expect(store.pendingProposals.value).toEqual([own]);

    activeProfileId.value = "profile-b";
    expect(store.pendingProposals.value).toEqual([other]);
    await expect(store.approve(own)).rejects.toThrow("another profile");
    expect(confirmReviewPrAction).not.toHaveBeenCalled();
  });

  it("requires a new click when the payload replaces a stale proposal with a new id", async () => {
    const stale = makeProposal("proposal-old");
    const fresh = makeProposal("proposal-fresh");
    const { store, payload, confirmReviewPrAction } = makeStore([stale]);

    payload.value = { reviewPrActions: { pending: [fresh] } };
    await expect(store.approve(stale)).rejects.toThrow("no longer pending");
    expect(confirmReviewPrAction).not.toHaveBeenCalled();

    await store.approve(fresh);
    expect(confirmReviewPrAction).toHaveBeenCalledTimes(1);
    expect(reviewPrActionConfirmSchema.safeParse(confirmReviewPrAction.mock.calls[0]?.[0])).toMatchObject({
      success: true,
      data: { proposalId: "proposal-fresh", approved: true },
    });
  });

  it("sends explicit rejection through the same confirmation transport method", async () => {
    const proposal = makeProposal("proposal-a");
    const { store, confirmReviewPrAction } = makeStore([proposal]);
    await store.reject(proposal);
    expect(reviewPrActionConfirmSchema.safeParse(confirmReviewPrAction.mock.calls[0]?.[0])).toMatchObject({
      success: true,
      data: { proposalId: "proposal-a", approved: false },
    });
  });

  it("hides expired proposals recovered from an older payload", () => {
    const expired = reviewPrActionProposalSchema.parse({
      ...makeProposal("expired"),
      expiresAt: "2000-01-01T00:00:00.000Z",
    });
    const { store, confirmReviewPrAction } = makeStore([expired]);
    expect(store.pendingProposals.value).toEqual([]);
    expect(confirmReviewPrAction).not.toHaveBeenCalled();
  });

  it("does not send duplicate decisions while the first transport call is pending", async () => {
    const proposal = makeProposal("proposal-a");
    let release: (_value: unknown) => void = () => {};
    const pendingCall = new Promise((resolve) => (release = resolve));
    const confirmReviewPrAction = vi.fn(() => pendingCall);
    const store = createReviewPrActionApprovals({
      payload: shallowRef<unknown>({ reviewPrActions: { pending: [proposal] } }),
      myActiveProfileId: ref<string | null>("profile-a"),
      getApi: () => ({ confirmReviewPrAction }) as never,
    });

    const first = store.approve(proposal);
    await store.approve(proposal);
    expect(confirmReviewPrAction).toHaveBeenCalledTimes(1);
    release({ status: "accepted" });
    await first;
  });
});
