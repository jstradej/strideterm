<template>
  <div class="git-section">
    <div v-if="isEmptyRepo" data-testid="empty-repo-banner" class="git-info-banner git-info-banner--warn">
      <strong>No commits yet</strong>
      <p>Make your first commit in the Changes tab to get started.</p>
    </div>

    <div v-if="hasNoRemote && !showAllActions" data-testid="no-remote-banner" class="git-info-banner">
      <strong>No remote configured</strong>
      <p>This repo has no remote. Add a remote to enable fetch/pull/push.</p>
    </div>

    <div v-if="isDiverged" data-testid="diverged-banner" class="git-diverged-banner">
      <strong>Upstream has diverged ({{ snapshot.aheadCount }} ahead, {{ snapshot.behindCount }} behind)</strong>
      <p>Pull or rebase if upstream has new work, or force-push if you intentionally rewrote local history.</p>
      <div class="git-diverged-banner__actions">
        <button
          type="button"
          class="button button--ghost"
          :disabled="!!gitUi.busyAction || operation.inProgress"
          title="Open Update Current Branch to pull/rebase"
          @click="gitUiStore.gitSwitchTab(workspaceId, 'branch')"
        >
          Pull / Rebase
        </button>
        <button
          v-if="!isReviewWorkspace"
          type="button"
          data-testid="force-push-button"
          class="button button--ghost button--danger"
          :disabled="!!gitUi.busyAction || operation.inProgress || !!gitUi.pendingAction"
          title="Force-push with lease — aborts if remote was updated since your last fetch"
          @click="
            gitUiStore.confirmForcePushWithLease(
              workspaceId,
              { branch: snapshot.branch, remote: pushRemote, behindCount: snapshot.behindCount },
              snapshot,
            )
          "
        >
          Force push (with lease)
        </button>
      </div>
    </div>

    <GitOperationCard :snapshot="snapshot" :workspace-id="workspaceId" :git-ui="gitUi" />

    <article v-if="showUpdateCurrentBranch" class="git-card" data-testid="update-current-branch-card">
      <div class="section-head">
        <div>
          <p class="eyebrow">Update Current Branch</p>
          <h3>{{ effectiveBaseBranch || "?" }} &rarr; {{ snapshot.branch }}</h3>
        </div>
      </div>
      <div v-if="isReviewWorkspace" class="git-info-banner" data-testid="review-detach-banner">
        <strong>Linked to a PR review</strong>
        <p>
          Rebase, Merge, Push, and Force push are disabled while this workspace is linked to a pull request review.
          Detaching makes it a regular workspace — the PR on the server is not touched.
        </p>
        <button
          type="button"
          data-testid="detach-review-button"
          class="button button--ghost"
          :disabled="!!gitUi.busyAction || detachingReview"
          @click="onDetachReview"
        >
          {{ detachingReview ? "Detaching…" : "Detach from PR review" }}
        </button>
      </div>
      <div class="git-detail-list">
        <span><strong>Current branch:</strong> {{ snapshot.branch }}</span>
        <template v-if="isLinkedWorktree">
          <span class="git-detail-list__row">
            <strong>Base branch:</strong>
            {{ effectiveBaseBranch || "?" }}
          </span>
        </template>
        <GitBaseBranchPicker
          v-else
          :model-value="effectiveBaseBranch"
          :options="baseBranchOptions"
          :default-branch="defaultBranch"
          :default-remote="defaultRemote"
          :remote-names="remoteNames"
          @update:model-value="(v) => gitUiStore.gitSetBaseBranch(workspaceId, v)"
        />
        <span><strong>Upstream:</strong> {{ snapshot.upstream || "none" }}</span>
        <span>
          <strong>Ahead/behind upstream:</strong> {{ snapshot.aheadCount || 0 }} / {{ snapshot.behindCount || 0 }}
        </span>
        <span><strong>Last fetch:</strong> {{ formatDateLabel(snapshot.lastFetchAt) }}</span>
      </div>
      <template v-if="effectiveBaseBranch">
        <p class="git-card__hint git-card__hint--compare" data-testid="base-compare-status">
          <template v-if="baseCompare.loading">Comparing with {{ effectiveBaseBranch }}…</template>
          <template v-else-if="baseCompare.error">{{ baseCompare.error }}</template>
          <template v-else-if="baseCompare.aheadCount === 0 && baseCompare.behindCount === 0">
            Already up to date with {{ effectiveBaseBranch }} — nothing to rebase or merge.
          </template>
          <template v-else>
            Current branch is
            <strong v-if="baseCompare.aheadCount">{{ baseCompare.aheadCount }} ahead</strong>
            <template v-if="baseCompare.aheadCount && baseCompare.behindCount">, </template>
            <strong v-if="baseCompare.behindCount">{{ baseCompare.behindCount }} behind</strong>
            {{ effectiveBaseBranch }}.
          </template>
        </p>
        <div v-if="!isReviewWorkspace" class="git-operation-actions">
          <button
            type="button"
            class="button"
            :disabled="rebaseDisabled"
            :title="rebaseTitle"
            @click="gitUiStore.gitRebaseBase(workspaceId, effectiveBaseBranch)"
          >
            {{ gitUi.busyAction === "rebase" ? "Rebasing…" : `Rebase onto ${effectiveBaseBranch}` }}
          </button>
          <button
            v-if="!isReviewWorkspace"
            type="button"
            class="button button--ghost"
            :disabled="mergeDisabled"
            :title="mergeTitle"
            @click="gitUiStore.gitMergeBase(workspaceId, effectiveBaseBranch)"
          >
            {{ gitUi.busyAction === "merge" ? "Merging…" : `Merge ${effectiveBaseBranch} in` }}
          </button>
        </div>
        <p class="git-card__hint">
          Operations use the local {{ effectiveBaseBranch }} branch. Fetch first to sync with remote.
        </p>
      </template>
      <template v-else>
        <p class="git-card__hint">Select a base branch above to enable rebase/merge operations.</p>
        <p v-if="baseBranchOptions.length === 0" class="git-card__hint">
          No local branches found. Run Fetch to populate remote branches.
          <button
            type="button"
            class="button button--ghost button--small"
            style="margin-left: 6px"
            @click="gitUiStore.gitFetch(workspaceId)"
          >
            Fetch
          </button>
        </p>
      </template>
    </article>

    <article v-if="showStashCard" data-testid="stash-card" class="git-card">
      <div class="section-head">
        <div>
          <p class="eyebrow">Stash</p>
          <h3>
            <button
              type="button"
              class="git-stash-count-link"
              title="Open the Stashes tab for full control over every entry."
              @click="gitUiStore.gitSwitchTab(workspaceId, 'stashes')"
            >
              {{ snapshot.stashCount || 0 }} stash{{ (snapshot.stashCount || 0) !== 1 ? "es" : "" }}
            </button>
          </h3>
        </div>
      </div>
      <div class="git-operation-actions">
        <button
          type="button"
          class="button"
          :disabled="!snapshot.dirty || operation.inProgress"
          title="Open the Changes tab to stash your working tree — pick specific files or stash everything."
          @click="gitUiStore.gitSwitchTab(workspaceId, 'changes')"
        >
          Stash…
        </button>
        <button
          type="button"
          class="button button--ghost"
          :disabled="
            !!(gitUi.busyAction || !(snapshot.stashCount > 0) || !!gitUi.pendingAction || operation.inProgress)
          "
          :title="
            (snapshot.stashCount || 0) > 1
              ? 'Pops the top stash (stash@{0}). For other entries open the Stashes tab.'
              : snapshot.dirty
                ? 'Pop may conflict with local changes'
                : 'Restore the most recent stash entry'
          "
          @click="gitUiStore.gitStashPop(workspaceId)"
        >
          {{ gitUi.busyAction === "stash-pop" ? "Popping…" : "Unstash (pop)" }}
        </button>
      </div>
      <p class="git-card__hint">Stash saves uncommitted changes. Unstash restores the most recent stash entry.</p>
    </article>

    <article v-if="!isLinkedWorktree && !isReviewWorkspace" class="git-card">
      <div class="section-head">
        <div>
          <p class="eyebrow">Switch Branch</p>
          <h3>{{ snapshot.branch }}</h3>
        </div>
      </div>
      <div v-if="snapshot.dirty" class="git-card__hint git-card__hint--warning" style="margin-bottom: 8px">
        Working tree is dirty. Commit or stash changes before switching branches.
      </div>
      <template v-else>
        <div class="git-detail-list" style="margin-bottom: 8px">
          <span class="git-detail-list__row">
            <strong>Checkout:</strong>
            <CustomSelect
              v-model="switchBranchTarget"
              class="git-branch-select"
              placeholder="-- select branch --"
              :options="switchBranchOptionsList"
              searchable
              search-placeholder="Filter branches…"
            />
            <button
              type="button"
              class="button"
              :disabled="!switchBranchTarget || !!gitUi.busyAction"
              title="Run git checkout on the selected branch — switches the working tree to that branch's tip. Aborts if uncommitted changes would be overwritten."
              style="margin-left: 6px"
              @click="onCheckoutBranch"
            >
              {{ gitUi.busyAction === "checkout" ? "Switching…" : "Switch" }}
            </button>
          </span>
        </div>
        <div class="git-detail-list">
          <span class="git-detail-list__row">
            <strong>New branch:</strong>
            <input
              v-model="newBranchName"
              class="git-pr-form__input"
              type="text"
              placeholder="feature/my-branch"
              style="flex: 1; min-width: 120px"
            />
            <button
              type="button"
              class="button button--ghost"
              :disabled="!newBranchName.trim() || !!gitUi.busyAction"
              title="Create a new branch from the current one and switch to it"
              style="margin-left: 6px"
              @click="onCreateBranch"
            >
              {{ gitUi.busyAction === "create-branch" ? "Creating…" : "Create & switch" }}
            </button>
          </span>
        </div>
      </template>
    </article>

    <GitMergeBackCard
      v-if="showMergeBack"
      :snapshot="snapshot"
      :workspace-id="workspaceId"
      :workspaces="workspaces"
      :git-ui="gitUi"
      :effective-base-branch="effectiveBaseBranch"
      :base-branch-options="baseBranchOptions"
      :default-branch="defaultBranch"
      :default-remote="defaultRemote"
      :remote-names="remoteNames"
      :is-linked-worktree="isLinkedWorktree"
    />
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch } from "vue";
import { useGitUiStore } from "../../../stores/git-ui.js";
import { useAppStore } from "../../../stores/app.js";
import GitOperationCard from "./GitOperationCard.vue";
import GitMergeBackCard from "./GitMergeBackCard.vue";
import GitBaseBranchPicker from "./GitBaseBranchPicker.vue";
import CustomSelect from "../../common/CustomSelect.vue";

const props = withDefaults(
  defineProps<{
    workspaceId: string;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    snapshot: Record<string, any>;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    gitUi: Record<string, any>;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    operation: Record<string, any>;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    workspaces?: any[];
    isEmptyRepo?: boolean;
    hasNoRemote?: boolean;
    showAllActions?: boolean;
    isDiverged?: boolean;
    isReviewWorkspace?: boolean;
    isLinkedWorktree?: boolean;
    pushRemote?: string;
    showUpdateCurrentBranch?: boolean;
    showStashCard?: boolean;
    showMergeBack?: boolean;
    effectiveBaseBranch?: string;
    baseBranchOptions?: string[];
    defaultBranch?: string;
    defaultRemote?: string;
    remoteNames?: string[];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    switchBranchOptionsList?: any[];
  }>(),
  {
    workspaces: () => [],
    isEmptyRepo: false,
    hasNoRemote: false,
    showAllActions: false,
    isDiverged: false,
    isReviewWorkspace: false,
    isLinkedWorktree: false,
    pushRemote: "origin",
    showUpdateCurrentBranch: false,
    showStashCard: false,
    showMergeBack: false,
    effectiveBaseBranch: "",
    baseBranchOptions: () => [],
    defaultBranch: "",
    defaultRemote: "",
    remoteNames: () => [],
    switchBranchOptionsList: () => [],
  },
);

const gitUiStore = useGitUiStore();
const appStore = useAppStore();

const switchBranchTarget = ref("");
const newBranchName = ref("");
const detachingReview = ref(false);

async function onDetachReview() {
  if (detachingReview.value) return;
  const confirmed = await appStore.confirmInApp({
    title: "Detach from PR review?",
    message: "Detach this workspace from its PR review? Git operations will be re-enabled.",
    confirmLabel: "Detach",
  });
  if (!confirmed) return;
  detachingReview.value = true;
  try {
    await appStore.detachWorkspaceReview(props.workspaceId);
  } finally {
    detachingReview.value = false;
  }
}

function formatDateLabel(value: string | undefined | null): string {
  if (!value) return "Not fetched yet";
  try {
    return new Date(value).toLocaleString();
  } catch {
    return value;
  }
}

function onCheckoutBranch() {
  if (switchBranchTarget.value) {
    gitUiStore.gitCheckoutBranch(props.workspaceId, switchBranchTarget.value);
    switchBranchTarget.value = "";
  }
}

function onCreateBranch() {
  const name = newBranchName.value.trim();
  if (name) {
    gitUiStore.gitCreateBranch(props.workspaceId, name, "");
    newBranchName.value = "";
  }
}

// --- Compare against the (possibly overridden) base branch -----------------
//
// snapshot.compareWithBase always reflects snapshot.baseBranch. When the user
// picks a different base in the picker (overrideBaseBranch ≠ snapshot.baseBranch),
// we fetch fresh counts via gitFetchBaseComparison and read them from
// gitUi.baseComparison. Re-fetched on snapshot.lastFetchAt so a Fetch updates
// the chip without the user re-selecting the base.
const baseCompare = computed(() => {
  const base = props.effectiveBaseBranch;
  const loading = !!props.gitUi?.baseComparisonLoading;
  if (!base) return { loading: false, error: "", aheadCount: 0, behindCount: 0 };
  const cached = props.gitUi?.baseComparison;
  if (cached && cached.baseBranch === base) {
    if (!cached.ok) {
      return { loading, error: cached.error || "Failed to compare", aheadCount: 0, behindCount: 0 };
    }
    return { loading, error: "", aheadCount: cached.aheadCount || 0, behindCount: cached.behindCount || 0 };
  }
  // Fall back to the snapshot's compareWithBase if it matches — avoids a flash
  // of "Comparing…" right after switching to this tab when the base hasn't
  // been overridden.
  const snap = props.snapshot;
  if (snap?.compareWithBase?.baseBranch === base) {
    return {
      loading,
      error: "",
      aheadCount: snap.compareWithBase.aheadCount || 0,
      behindCount: snap.compareWithBase.behindCount || 0,
    };
  }
  return { loading: true, error: "", aheadCount: 0, behindCount: 0 };
});

const nothingToRebase = computed(
  () => !baseCompare.value.loading && !baseCompare.value.error && baseCompare.value.behindCount === 0,
);

const rebaseDisabled = computed(() => {
  if (props.gitUi.busyAction || props.operation.inProgress || props.gitUi.pendingAction) return true;
  if (nothingToRebase.value) return true;
  return false;
});
const rebaseTitle = computed(() => {
  if (nothingToRebase.value) return `Already up to date with ${props.effectiveBaseBranch} — nothing to rebase.`;
  return `Rebase current branch onto local ${props.effectiveBaseBranch}`;
});
const mergeDisabled = computed(() => {
  if (props.gitUi.busyAction || props.operation.inProgress || props.gitUi.pendingAction) return true;
  if (nothingToRebase.value) return true;
  return false;
});
const mergeTitle = computed(() => {
  if (nothingToRebase.value) return `Already up to date with ${props.effectiveBaseBranch} — nothing to merge.`;
  return `Merge local ${props.effectiveBaseBranch} into current branch`;
});

watch(
  () => [props.effectiveBaseBranch, props.snapshot?.branch, props.snapshot?.lastFetchAt],
  ([base]) => {
    if (!base) return;
    // Skip the network call when the snapshot already has counts for this
    // exact base — the snapshot is authoritative for the auto-detected base.
    const snap = props.snapshot;
    if (snap?.compareWithBase?.baseBranch === base) return;
    gitUiStore.gitFetchBaseComparison(props.workspaceId, String(base));
  },
  { immediate: true },
);
</script>
