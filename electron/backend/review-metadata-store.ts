import type { AppState, ReviewSourceRepository } from "../shared/types/state.js";
import { reviewSourceIdentityKey } from "../shared/review-source-identity.js";

interface MutableStore {
  mutate: (mutator: (draft: AppState) => void | Promise<void>) => Promise<unknown>;
}

/**
 * Review Git operations record the PR source baseline (and a lazily captured
 * source identity) through normal app state — the same atomic store write as
 * every other change. A write that names an identity the workspace no longer
 * has is refused rather than saved against the wrong source.
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
