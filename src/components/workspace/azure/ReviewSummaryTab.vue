<template>
  <div class="review-panel">
    <div class="review-grid review-grid--summary">
      <article class="git-card review-card review-card--hero">
        <div class="section-head">
          <div>
            <p class="eyebrow">Overview</p>
            <h3>{{ pullRequest.title || "Azure review" }}</h3>
          </div>
        </div>
        <p v-if="pullRequest.description" class="git-card__hint azure-review__description">
          {{ pullRequest.description }}
        </p>
        <p class="git-card__hint" style="font-family: monospace; font-size: 12px">
          {{ stripRef(pullRequest.sourceRefName) }} &rarr; {{ stripRef(pullRequest.targetRefName) }}
        </p>

        <!-- Author & meta -->
        <div v-if="detail" style="display: flex; flex-wrap: wrap; gap: 6px 16px; padding: 4px 0">
          <span v-if="detail.author" class="review-meta"
            ><span class="review-meta__label">Author</span> {{ detail.author.displayName }}</span
          >
          <span v-if="pullRequest.creationDate" class="review-meta"
            ><span class="review-meta__label">Created</span> {{ formatDate(pullRequest.creationDate) }}</span
          >
          <span
            v-if="pullRequest.isDraft"
            class="workspace-chip"
            style="background: var(--accent); color: var(--bg); font-size: 10px"
            >Draft</span
          >
          <span class="review-meta"
            ><span class="review-meta__label">Status</span> {{ pullRequest.status || "unknown" }}</span
          >
          <span v-if="detail.role" class="review-meta"
            ><span class="review-meta__label">Role</span> {{ detail.role }}</span
          >
        </div>

        <!-- Merge status / Conflicts — always prominent -->
        <div v-if="conflictInfo.hasConflicts" class="review-conflict-banner review-conflict-banner--danger">
          <span class="review-conflict-banner__icon">✗</span>
          <div>
            <strong>{{ conflictInfo.label }}</strong>
            <p class="review-conflict-banner__hint">
              Merge conflicts between <code>{{ stripRef(pullRequest.sourceRefName) }}</code> and
              <code>{{ stripRef(pullRequest.targetRefName) }}</code>
            </p>
            <ul v-if="changedFiles.length" class="review-conflict-files">
              <li v-for="file in changedFiles" :key="file.path">
                <span class="git-status-code">{{ file.changeType || "edit" }}</span>
                <span class="git-list__text git-list__text--path">{{ file.path }}</span>
              </li>
            </ul>
          </div>
        </div>
        <div v-else class="review-conflict-banner review-conflict-banner--ok">
          <span class="review-conflict-banner__icon">✓</span>
          <div>
            <strong>{{ conflictInfo.label }}</strong>
          </div>
        </div>

        <div class="review-section-divider"><span>Review actions</span></div>
        <div class="docker-card__actions docker-card__actions--end">
          <button
            type="button"
            :class="['button', 'button--ghost', busyAction === 'vote-10' && 'button--busy']"
            :disabled="!!busyAction || !canVote"
            :title="voteDisabledTitle('Vote +10: Approve this PR on Azure DevOps. The vote is recorded under your reviewer profile.')"
            @click="handleVote(prKey, 10, 'Approve')"
          >
            {{ busyAction === "vote-10" ? "Approving…" : "Approve" }}
          </button>
          <button
            type="button"
            :class="['button', 'button--ghost', busyAction === 'vote-5' && 'button--busy']"
            :disabled="!!busyAction || !canVote"
            :title="voteDisabledTitle('Vote +5: Approve with suggestions — looks good but has minor feedback that the author can address before merge.')"
            @click="handleVote(prKey, 5, 'Approve')"
          >
            {{ busyAction === "vote-5" ? "Submitting…" : "Approve with suggestions" }}
          </button>
          <button
            type="button"
            :class="['button', 'button--ghost', busyAction === 'vote--5' && 'button--busy']"
            :disabled="!!busyAction || !canVote"
            :title="voteDisabledTitle('Vote -5: Wait for author — changes needed before approval. Author should address comments and re-request review.')"
            @click="handleVote(prKey, -5, 'Wait')"
          >
            {{ busyAction === "vote--5" ? "Submitting…" : "Wait" }}
          </button>
          <button
            type="button"
            :class="['button', 'button--ghost', 'danger', busyAction === 'vote--10' && 'button--busy']"
            :disabled="!!busyAction || !canVote"
            :title="voteDisabledTitle('Vote -10: Reject this PR. Strong signal — only Reset Vote or a new revision can clear it.')"
            @click="handleVote(prKey, -10, 'Reject')"
          >
            {{ busyAction === "vote--10" ? "Rejecting…" : "Reject" }}
          </button>
          <button
            type="button"
            :class="['button', 'button--ghost', busyAction === 'vote-0' && 'button--busy']"
            :disabled="!!busyAction || !canVote"
            :title="voteDisabledTitle('Reset your vote to 0 (no vote) on this PR.')"
            @click="handleVote(prKey, 0, 'Clear')"
          >
            {{ busyAction === "vote-0" ? "Clearing…" : "Clear vote" }}
          </button>
        </div>
        <div class="docker-card__actions">
          <button
            type="button"
            class="button"
            :disabled="!!busyAction"
            title="Create a new draft comment — saved locally, you can edit and publish to Azure later"
            @click="$emit('new-comment')"
          >
            New comment
          </button>
        </div>

        <div class="review-section-divider"><span>Git operations</span></div>
        <div class="docker-card__actions docker-card__actions--end">
          <button
            type="button"
            :class="['button', 'button--ghost', busyAction === 'fetch' && 'button--busy']"
            :disabled="!!busyAction"
            title="Git fetch — refresh remote tracking refs for this review worktree without changing your working tree."
            @click="handleFetch(workspaceId)"
          >
            {{ busyAction === "fetch" ? "Fetching…" : "Fetch" }}
          </button>
          <button
            type="button"
            :class="['button', 'button--ghost', busyAction === 'rebase' && 'button--busy']"
            :disabled="!!busyAction || !canRebase"
            :title="
              !canRebase
                ? 'Rebase is unnecessary — your branch is already up to date with the PR target.'
                : 'Rebase the PR source branch onto the latest PR target branch. Conflicts will be reported in the Conflicts tab.'
            "
            @click="handleRebase(workspaceId)"
          >
            {{ busyAction === "rebase" ? "Rebasing…" : "Rebase on target" }}
          </button>
          <button
            type="button"
            :class="['button', 'button--ghost', busyAction === 'push' && 'button--busy']"
            :disabled="!!busyAction || !canPush"
            :title="
              !canPush
                ? 'Nothing to push — no local commits ahead of the remote tracking branch.'
                : 'Push the local commits of this review worktree to the remote PR branch (fast-forward only).'
            "
            @click="handlePush(workspaceId)"
          >
            {{ busyAction === "push" ? "Pushing…" : "Push branch" }}
          </button>
          <button
            type="button"
            :class="['button', 'button--ghost', busyAction === 'force-push' && 'button--busy']"
            :disabled="!!busyAction || !canForcePush"
            :title="
              !canForcePush
                ? 'Force push is unnecessary — local and remote agree.'
                : 'Force push with --force-with-lease. Use after rebase to update the PR branch; aborts if someone else pushed since your last fetch.'
            "
            @click="handleForcePush(workspaceId)"
          >
            {{ busyAction === "force-push" ? "Force pushing…" : "Force push" }}
          </button>
          <button
            type="button"
            class="button button--ghost"
            :disabled="!!busyAction"
            title="Open Lazygit in a terminal pointed at this review worktree for ad-hoc git operations."
            @click="gitUiStore.openLazygit(workspaceId)"
          >
            Open Lazygit
          </button>
        </div>
        <p v-if="pushError" class="git-card__hint" style="color: var(--danger, #e53935); padding: 4px 0">
          {{ pushError }}
        </p>
      </article>
      <div class="review-sidebar">
        <!-- Checks -->
        <article class="git-card review-card">
          <div class="section-head">
            <div><p class="eyebrow">Checks</p></div>
          </div>
          <template v-if="checks.items?.length">
            <div v-for="item in checks.items" :key="item.id" class="review-check-row">
              <span :class="['review-check-icon', `review-check-icon--${item.state}`]">{{
                checkIcon(item.state)
              }}</span>
              <div>
                <strong style="font-size: 12px">{{ item.name }}</strong>
                <p v-if="item.stateLabel && item.stateLabel !== item.state" class="git-card__hint" style="margin: 0">
                  {{ item.stateLabel }}
                </p>
                <p v-if="item.source" class="git-card__hint" style="margin: 0; font-size: 10px; color: var(--muted)">
                  {{ item.optional ? "optional" : "required" }} &middot; {{ item.source }}
                </p>
              </div>
            </div>
          </template>
          <p v-else class="git-card__hint" style="color: var(--muted)">No checks configured</p>
        </article>
        <!-- Reviewers -->
        <article class="git-card review-card">
          <div class="section-head">
            <div><p class="eyebrow">Reviewers</p></div>
          </div>
          <ul v-if="reviewers.length" class="git-list">
            <li v-for="r in reviewers" :key="r.displayName" style="display: flex; align-items: center; gap: 8px">
              <span :class="['review-vote-badge', `review-vote-badge--${voteClass(r.vote)}`]">{{ r.vote }}</span>
              <div>
                <span class="git-list__text">{{ r.displayName }}</span>
                <br /><small style="color: var(--muted)"
                  >{{ voteLabel(r.vote) }}{{ r.isRequired ? "" : " (optional)" }}</small
                >
              </div>
            </li>
          </ul>
          <p v-else class="git-card__hint" style="color: var(--muted)">No reviewers assigned</p>
        </article>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from "vue";
import { useAppStore } from "../../../stores/app.js";
import { useGitUiStore } from "../../../stores/git-ui.js";

const props = defineProps<{
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  detail?: Record<string, any> | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  pullRequest: Record<string, any>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  reviewers: Array<Record<string, any>>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  checks: Record<string, any>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  changedFiles: Array<Record<string, any>>;
  prKey: string;
  workspaceId: string;
}>();

defineEmits<{ (e: "new-comment"): void }>();

const appStore = useAppStore();
const gitUiStore = useGitUiStore();

const busyAction = ref<string>("");

// 6.2: surface why a button is disabled. Voting on your own PR is rejected
// by Azure; force-push only makes sense after a rebase or when ahead of
// remote; rebase only makes sense when the branch is behind its target;
// push only makes sense when there are local commits ahead of remote.
const isOwnPr = computed(() => {
  const me = String(props.detail?.currentUserId || props.detail?.connection?.currentUserId || "").toLowerCase();
  const author = String(
    props.pullRequest?.createdBy?.id ||
      props.pullRequest?.createdBy?.uniqueName ||
      props.detail?.author?.id ||
      "",
  ).toLowerCase();
  return !!me && !!author && me === author;
});

const isReviewer = computed(() => {
  const role = String(props.detail?.role || "").toLowerCase();
  if (role === "reviewer") return true;
  return Array.isArray(props.reviewers) && props.reviewers.length > 0;
});

const gitSnapshot = computed(() => appStore.getGitSnapshot(props.workspaceId) as Record<string, unknown> | null);
const aheadCount = computed(() => Number((gitSnapshot.value as { aheadCount?: number } | null)?.aheadCount || 0));
const behindCount = computed(() => Number((gitSnapshot.value as { behindCount?: number } | null)?.behindCount || 0));

const voteDisabledReason = computed(() => {
  if (busyAction.value) return "";
  if (isOwnPr.value) return "Azure DevOps does not allow voting on your own pull request.";
  if (!isReviewer.value)
    return "Only assigned reviewers can vote. Add yourself as a reviewer in Azure or via the &quot;Add me&quot; flow.";
  return "";
});
const canVote = computed(() => !voteDisabledReason.value);
const voteDisabledTitle = (base: string) => (voteDisabledReason.value ? voteDisabledReason.value : base);

const canPush = computed(() => aheadCount.value > 0);
const canForcePush = computed(() => aheadCount.value > 0 || behindCount.value > 0);
const canRebase = computed(() => behindCount.value > 0);

const conflictInfo = computed(() => {
  const status = props.pullRequest.mergeStatus || "";
  const conflictStatuses = ["conflicts", "rejectedByPolicy", "renamedSourceBranch", "manualMergeRequired"];
  const hasConflicts = conflictStatuses.includes(status);
  return {
    hasConflicts,
    label: hasConflicts
      ? "Merge conflicts detected"
      : status === "succeeded"
        ? "No merge conflicts"
        : `Merge status: ${status || "unknown"}`,
  };
});

function checkIcon(state: unknown) {
  if (state === "passed" || state === "approved") return "✓";
  if (state === "failed" || state === "rejected") return "✗";
  return "●";
}

function voteClass(vote: unknown): string {
  if ((vote as number) > 0) return "approved";
  if ((vote as number) < 0) return "rejected";
  return "none";
}

function voteLabel(vote: unknown): string {
  if (vote === 10) return "Approved";
  if (vote === 5) return "Approved with suggestions";
  if (vote === -5) return "Waiting for author";
  if (vote === -10) return "Rejected";
  return "No vote yet";
}

function formatDate(iso: unknown): string {
  if (!iso) return "";
  const d = new Date(iso as string);
  return d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

async function handleVote(prKey: string, vote: number, _label: string) {
  busyAction.value = `vote-${vote}`;
  try {
    await appStore.azureVote(prKey, String(vote));
  } finally {
    busyAction.value = "";
  }
}

async function handleFetch(workspaceId: string) {
  busyAction.value = "fetch";
  try {
    await appStore.azureFetchReviewWorkspace(workspaceId);
  } finally {
    busyAction.value = "";
  }
}

async function handleRebase(workspaceId: string) {
  busyAction.value = "rebase";
  try {
    await appStore.azureRebaseReviewWorkspace(workspaceId);
  } finally {
    busyAction.value = "";
  }
}

const pushError = ref<string>("");

async function handlePush(workspaceId: string) {
  busyAction.value = "push";
  pushError.value = "";
  try {
    await appStore.azurePushReviewWorkspace(workspaceId);
  } catch (error) {
    pushError.value = (error as Error)?.message || String(error || "Push failed.");
  } finally {
    busyAction.value = "";
  }
}

async function handleForcePush(workspaceId: string) {
  busyAction.value = "force-push";
  pushError.value = "";
  try {
    await appStore.azurePushReviewWorkspace(workspaceId, { force: true });
  } catch (error) {
    pushError.value = (error as Error)?.message || String(error || "Force push failed.");
  } finally {
    busyAction.value = "";
  }
}

function stripRef(ref: unknown) {
  return String(ref || "").replace(/^refs\/heads\//, "");
}
</script>
