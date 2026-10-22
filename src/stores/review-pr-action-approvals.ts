import { computed, getCurrentScope, onScopeDispose, reactive, ref, watch, type ComputedRef, type Ref } from "vue";
import { reviewPrActionsStateSchema, type ReviewPrActionProposal } from "../../electron/shared/review-pr-actions.js";
import type { Transport } from "../transport.js";
import { rlog } from "../lib/renderer-log.js";

type Context = {
  payload: { readonly value: unknown };
  myActiveProfileId: ComputedRef<string | null> | Ref<string | null>;
  getApi: () => Transport;
};

export function createReviewPrActionApprovals(ctx: Context) {
  const busyProposalIds = reactive(new Set<string>());
  const now = ref(Date.now());
  let expiryTimer: ReturnType<typeof setTimeout> | undefined;
  const pendingProposals = computed<ReviewPrActionProposal[]>(() => {
    const currentTime = now.value;
    const profileId = ctx.myActiveProfileId.value;
    if (!profileId) return [];
    const raw = (ctx.payload.value as { reviewPrActions?: unknown } | null)?.reviewPrActions;
    const parsed = reviewPrActionsStateSchema.safeParse(raw);
    if (!parsed.success) return [];
    return parsed.data.pending.filter(
      (proposal) => proposal.profileId === profileId && Date.parse(proposal.expiresAt) > currentTime,
    );
  });

  watch(
    pendingProposals,
    (proposals) => {
      if (expiryTimer) clearTimeout(expiryTimer);
      const nextExpiry = Math.min(...proposals.map((proposal) => Date.parse(proposal.expiresAt)));
      if (!Number.isFinite(nextExpiry)) return;
      expiryTimer = setTimeout(
        () => {
          now.value = Date.now();
        },
        Math.max(1, Math.min(nextExpiry - Date.now(), 2_147_000_000)),
      );
    },
    { immediate: true },
  );
  if (getCurrentScope()) {
    onScopeDispose(() => {
      if (expiryTimer) clearTimeout(expiryTimer);
      expiryTimer = undefined;
    });
  }

  async function decide(proposal: ReviewPrActionProposal, approved: boolean): Promise<void> {
    if (proposal.profileId !== ctx.myActiveProfileId.value) {
      throw new Error("This pull request approval belongs to another profile.");
    }
    if (!pendingProposals.value.some((item) => item.proposalId === proposal.proposalId)) {
      throw new Error("This pull request proposal is no longer pending. Review the latest proposal first.");
    }
    if (busyProposalIds.has(proposal.proposalId)) return;
    busyProposalIds.add(proposal.proposalId);
    try {
      const api = ctx.getApi();
      if (typeof api.confirmReviewPrAction !== "function") {
        throw new Error("Pull request approval is unavailable on this connection.");
      }
      await api.confirmReviewPrAction({ proposalId: proposal.proposalId, approved });
    } catch (error) {
      rlog("error", "[review-pr-action-approvals] decision request failed", {
        proposalId: proposal.proposalId,
        approved,
        profileId: proposal.profileId,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    } finally {
      busyProposalIds.delete(proposal.proposalId);
    }
  }

  function isBusy(proposalId: string): boolean {
    return busyProposalIds.has(proposalId);
  }

  return {
    pendingProposals,
    approve: (proposal: ReviewPrActionProposal) => decide(proposal, true),
    reject: (proposal: ReviewPrActionProposal) => decide(proposal, false),
    isBusy,
  };
}
