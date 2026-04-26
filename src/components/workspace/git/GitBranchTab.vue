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
          @update:model-value="(v) => gitUiStore.gitSetBaseBranch(workspaceId, v)"
        />
        <span><strong>Upstream:</strong> {{ snapshot.upstream || "none" }}</span>
        <span>
          <strong>Ahead/behind upstream:</strong> {{ snapshot.aheadCount || 0 }} / {{ snapshot.behindCount || 0 }}
        </span>
        <span><strong>Last fetch:</strong> {{ formatDateLabel(snapshot.lastFetchAt) }}</span>
      </div>
      <template v-if="effectiveBaseBranch">
        <div v-if="!isReviewWorkspace" class="git-operation-actions">
          <button
            type="button"
            class="button"
            :disabled="!!(gitUi.busyAction || operation.inProgress || !!gitUi.pendingAction)"
            :title="`Rebase current branch onto local ${effectiveBaseBranch}`"
            @click="gitUiStore.gitRebaseBase(workspaceId, effectiveBaseBranch)"
          >
            {{ gitUi.busyAction === "rebase" ? "Rebasing…" : `Rebase onto ${effectiveBaseBranch}` }}
          </button>
          <button
            v-if="!isReviewWorkspace"
            type="button"
            class="button button--ghost"
            :disabled="!!(gitUi.busyAction || operation.inProgress || !!gitUi.pendingAction)"
            :title="`Merge local ${effectiveBaseBranch} into current branch`"
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
          <h3>{{ snapshot.stashCount || 0 }} stash{{ (snapshot.stashCount || 0) !== 1 ? "es" : "" }}</h3>
        </div>
      </div>
      <div class="git-operation-actions">
        <button
          type="button"
          class="button"
          :disabled="!!(gitUi.busyAction || !snapshot.dirty || !!gitUi.pendingAction || operation.inProgress)"
          title="Save uncommitted changes to the stash"
          @click="gitUiStore.gitStash(workspaceId, '')"
        >
          {{ gitUi.busyAction === "stash" ? "Stashing…" : "Stash" }}
        </button>
        <button
          type="button"
          class="button button--ghost"
          :disabled="
            !!(gitUi.busyAction || !(snapshot.stashCount > 0) || !!gitUi.pendingAction || operation.inProgress)
          "
          :title="snapshot.dirty ? 'Pop may conflict with local changes' : 'Restore the most recent stash entry'"
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
            />
            <button
              type="button"
              class="button"
              :disabled="!switchBranchTarget || !!gitUi.busyAction"
              title="Checkout the selected branch"
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
      :is-linked-worktree="isLinkedWorktree"
    />
  </div>
</template>

<script setup lang="ts">
import { ref } from "vue";
import { useGitUiStore } from "../../../stores/git-ui.js";
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
    switchBranchOptionsList: () => [],
  },
);

const gitUiStore = useGitUiStore();

const switchBranchTarget = ref("");
const newBranchName = ref("");

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
</script>
