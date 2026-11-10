import type { AppState, ReviewSourceRepository } from "../shared/types/state.js";
import { PRE_PR_IDENTITY_PREFIX, prePrGrantHolds, reviewSourceIdentityKey } from "../shared/review-source-identity.js";

interface MutableStore {
  mutate: (mutator: (draft: AppState) => void | Promise<void>) => Promise<unknown>;
}

/**
 * Review Git operations record the PR source baseline (and a lazily captured
 * source identity) through normal app state — the same atomic store write as
 * every other change. A write that names an identity the workspace no longer
 * has is refused rather than saved against the wrong source. A quickfix branch
 * without a pull request keeps its baseline on the quickfix; if the PR was
 * created while the operation ran, the same identity check decides whether the
 * baseline belongs on the new review.
 */
export function createReviewMetadataStore(store: MutableStore) {
  return {
    async updateReview(
      workspaceId: string,
      patch: {
        sourceBaselineSha?: string;
        sourceRepository?: ReviewSourceRepository;
        expectedIdentityKey?: string;
      },
    ) {
      await store.mutate((draft: AppState) => {
        const workspace = draft.workspaces.find((item) => item.id === workspaceId);
        if (!workspace?.review) return;
        if (patch.expectedIdentityKey?.startsWith(PRE_PR_IDENTITY_PREFIX)) {
          if (!prePrGrantHolds(patch.expectedIdentityKey, workspace)) {
            throw new Error("The quickfix branch's identity changed while the operation ran; baseline not saved.");
          }
          if (!patch.sourceBaselineSha) return;
          if (workspace.review.prKey) workspace.review.sourceBaselineSha = patch.sourceBaselineSha;
          else if (workspace.quickfix) workspace.quickfix.sourceBaselineSha = patch.sourceBaselineSha;
          return;
        }
        if (patch.sourceRepository && !workspace.review.sourceRepository) {
          workspace.review.sourceRepository = patch.sourceRepository;
        }
        if (patch.expectedIdentityKey && reviewSourceIdentityKey(workspace.review) !== patch.expectedIdentityKey) {
          throw new Error("The pull request's source identity changed while the operation ran; baseline not saved.");
        }
        if (patch.sourceBaselineSha) workspace.review.sourceBaselineSha = patch.sourceBaselineSha;
      });
    },
  };
}
