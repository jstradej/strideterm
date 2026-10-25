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
          data-testid="update-from-upstream"
          class="button button--ghost"
          :disabled="upstreamUpdateDisabled"
          :title="`Fetch, then ${updateStrategy} ${snapshot.upstream}. This uses the upstream, not the selected base branch.`"
          @click="onUpdateFromUpstream"
        >
          {{ updateStrategy === "merge" ? `Merge ${snapshot.upstream} in` : `Rebase onto ${snapshot.upstream}` }}
        </button>
        <button
          type="button"
          data-testid="force-push-button"
          class="button button--ghost button--danger"
          :disabled="!!gitUi.busyAction || operation.inProgress || !!gitUi.pendingAction || reviewGitBusy"
          title="Force-push with lease — aborts if the remote branch moved away from the commit it was checked against"
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

    <article class="git-card git-card--overview" data-testid="branch-status-card">
      <div class="git-overview__header">
        <div class="git-overview__branch">
          <p class="eyebrow">Branch status</p>
          <h3 :title="snapshot.branch || 'Detached HEAD'">{{ snapshot.branch || "Detached HEAD" }}</h3>
        </div>
        <button
          type="button"
          class="button button--ghost button--small"
          title="Browse, create, or switch branches."
          @click="gitUiStore.gitSwitchTab(workspaceId, 'branches')"
        >
          Manage branches
        </button>
      </div>
      <div class="git-overview__status-grid">
        <div class="git-overview__status">
          <strong>Working tree</strong>
          <span :class="snapshot.dirty ? 'git-overview__status-value--warn' : ''">
            {{ snapshot.dirty ? (snapshot.dirtyCount ? `${snapshot.dirtyCount} changed` : "Changed") : "Clean" }}
          </span>
        </div>
        <div class="git-overview__status">
          <strong>Upstream</strong>
          <template v-if="snapshot.upstream">
            <code :title="snapshot.upstream">{{ snapshot.upstream }}</code>
            <span>{{ snapshot.aheadCount || 0 }} ahead · {{ snapshot.behindCount || 0 }} behind</span>
          </template>
          <span v-else>None configured</span>
        </div>
        <div v-if="snapshot.upstream" class="git-overview__status git-overview__status--muted">
          <strong>Last fetched</strong>
          <span>{{ formatDateLabel(snapshot.lastFetchAt) }}</span>
        </div>
      </div>
      <div v-if="reviewLink" class="git-info-banner" data-testid="review-link-note">
        <strong>Linked to PR #{{ reviewLink.pullRequestId }}</strong>
        <p>
          Push targets <code>{{ reviewLink.sourceBranch }}</code
          >; update targets <code>{{ reviewLink.targetBranch }}</code
          >. Updating never pushes.
        </p>
        <div class="git-diverged-banner__actions">
          <button
            type="button"
            data-testid="detach-review-button"
            class="button button--ghost"
            :disabled="!!gitUi.busyAction || detachingReview"
            title="Unlink this workspace from the PR review. The PR on the server is not touched."
            @click="onDetachReview"
          >
            {{ detachingReview ? "Detaching…" : "Detach from PR review" }}
          </button>
        </div>
      </div>
      <div class="git-overview__update">
        <div class="git-overview__base">
          <template v-if="isLinkedWorktree">
            <strong>Base branch</strong>
            <code :title="effectiveBaseBranch">{{ effectiveBaseBranch || "Not set" }}</code>
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
        </div>
        <template v-if="opRef">
          <p class="git-card__hint git-overview__compare" data-testid="base-compare-status">
            <template v-if="baseCompare.loading">Comparing with {{ opRef }}…</template>
            <template v-else-if="baseCompare.error">Comparison failed: {{ baseCompare.error }}</template>
            <template v-else-if="baseCompare.aheadCount === 0 && baseCompare.behindCount === 0">
              Up to date with {{ opRef }}.
            </template>
            <template v-else>
              Compared with <code>{{ opRef }}</code
              >:
              <strong v-if="baseCompare.aheadCount">{{ baseCompare.aheadCount }} ahead</strong>
              <template v-if="baseCompare.aheadCount && baseCompare.behindCount"> · </template>
              <strong v-if="baseCompare.behindCount">{{ baseCompare.behindCount }} behind</strong>
            </template>
          </p>
          <p class="git-card__hint git-overview__target-note">
            <template v-if="opIsRemote"
              >Update fetches <code>{{ opRef }}</code> first.</template
            >
            <template v-else
              >No remote fetch; updating from local <code>{{ opRef }}</code
              >.</template
            >
          </p>
          <details v-if="hasLocalAndRemote" class="git-overview__advanced">
            <summary>Advanced: use local base</summary>
            <label class="git-base-local-toggle">
              <input type="checkbox" :checked="preferLocalBase" @change="preferLocalBase = !preferLocalBase" />
              <span class="git-base-local-toggle__text">
                Use <code>{{ resolvedBase.localRef }}</code> instead of <code>{{ resolvedBase.remoteRef }}</code> (no
                fetch)
              </span>
            </label>
          </details>
          <div class="git-operation-actions git-update-actions">
            <GitStrategySplitButton
              :strategy="updateStrategy"
              :main-label="isUpdating ? 'Updating…' : updateActionLabel"
              :main-title="updateTitle"
              :disabled="updateDisabled"
              :busy="isUpdating"
              primary
              main-testid="update-from-base"
              caret-testid="update-strategy-caret"
              :options="strategyOptions"
              @run="onUpdateFromBase"
              @update:strategy="selectStrategy"
            />
          </div>
        </template>
        <template v-else>
          <p class="git-card__hint">Select a base branch above to compare or update this branch.</p>
          <p v-if="baseBranchOptions.length === 0" class="git-card__hint">
            No local branches found. Run Fetch to populate remote branches.
          </p>
        </template>
      </div>
    </article>
    <article v-if="showStashCard" data-testid="stash-card" class="git-card git-card--overview-stash">
      <div class="git-overview__stash-summary">
        <div>
          <p class="eyebrow">Stashes</p>
          <button
            v-if="snapshot.stashCount > 0"
            type="button"
            class="git-stash-count-link"
            title="Open Stashes to browse and restore saved work."
            @click="gitUiStore.gitSwitchTab(workspaceId, 'stashes')"
          >
            {{ snapshot.stashCount }} saved {{ snapshot.stashCount === 1 ? "stash" : "stashes" }}
          </button>
          <span v-else class="git-card__hint">No saved stashes</span>
        </div>
        <button
          v-if="snapshot.dirty"
          type="button"
          class="button button--ghost button--small"
          :disabled="operation.inProgress"
          title="Open Changes to choose which files to stash."
          @click="gitUiStore.gitSwitchTab(workspaceId, 'changes')"
        >
          Stash changes…
        </button>
      </div>
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
import { rlog } from "../../../lib/renderer-log.js";
import { useAppStore } from "../../../stores/app.js";
import { useNotificationStore } from "../../../stores/notifications.js";
import { userFacingMessage } from "../../../lib/error-message.js";
import GitStrategySplitButton from "./GitStrategySplitButton.vue";
import type { StrategyOption } from "./update-strategy.js";
import GitOperationCard from "./GitOperationCard.vue";
import GitMergeBackCard from "./GitMergeBackCard.vue";
import GitBaseBranchPicker from "./GitBaseBranchPicker.vue";
import { resolveBaseRef, isRemoteRef } from "./base-ref.js";

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
    longGitOperation?: Record<string, any> | null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    workspaces?: any[];
    isEmptyRepo?: boolean;
    hasNoRemote?: boolean;
    showAllActions?: boolean;
    isDiverged?: boolean;
    reviewLink?: { pullRequestId: string | number; sourceBranch: string; targetBranch: string; role: string } | null;
    isLinkedWorktree?: boolean;
    pushRemote?: string;
    showStashCard?: boolean;
    showMergeBack?: boolean;
    effectiveBaseBranch?: string;
    baseBranchOptions?: string[];
    defaultBranch?: string;
    defaultRemote?: string;
    remoteNames?: string[];
  }>(),
  {
    workspaces: () => [],
    longGitOperation: null,
    isEmptyRepo: false,
    hasNoRemote: false,
    showAllActions: false,
    isDiverged: false,
    reviewLink: null,
    isLinkedWorktree: false,
    pushRemote: "origin",
    showStashCard: false,
    showMergeBack: false,
    effectiveBaseBranch: "",
    baseBranchOptions: () => [],
    defaultBranch: "",
    defaultRemote: "",
    remoteNames: () => [],
  },
);

const gitUiStore = useGitUiStore();
const appStore = useAppStore();
const reviewGitBusy = computed(() => appStore.isReviewGitBusy?.(props.workspaceId) === true);
const notifications = useNotificationStore();

const detachingReview = ref(false);

// Update strategy + base resolution. "develop" is ambiguous (local branch vs
// origin/develop); for pulling the base in we prefer the remote-tracking ref so
// the user isn't rebasing onto a stale local branch. preferLocalBase is the
// escape hatch for local-only/offline/deliberate-local cases.
//
// The strategy is persisted (settings.git.ui.updateStrategy), not component
// state: the main button's label names it before the click, and a local ref
// reset to "rebase" on every remount — so what the button did changed silently
// between two visits to this tab. preferLocalBase stays ephemeral on purpose:
// it is the advanced/offline escape hatch, and a persisted one would keep
// rebasing onto a stale local branch without the user noticing.
const updateStrategy = computed<"rebase" | "merge">(
  () => (appStore.payload?.appState?.settings?.git?.ui?.updateStrategy as "rebase" | "merge") || "rebase",
);
const preferLocalBase = ref(false);

const resolvedBase = computed(() =>
  resolveBaseRef(
    props.effectiveBaseBranch,
    (props.snapshot?.branchNames as string[]) || [],
    props.remoteNames || [],
    props.defaultRemote || props.snapshot?.defaultRemote || "",
  ),
);
const opRef = computed(() => {
  const r = resolvedBase.value;
  if (preferLocalBase.value && r.localRef) return r.localRef;
  return r.opRef;
});
const opIsRemote = computed(() => isRemoteRef(opRef.value, props.remoteNames || []));
const hasLocalAndRemote = computed(() => !!resolvedBase.value.localRef && !!resolvedBase.value.remoteRef);

async function onDetachReview() {
  if (detachingReview.value) return;
  const confirmed = await appStore.confirmInApp({
    title: "Detach from PR review?",
    message:
      "Detach this workspace from its PR review? Git keeps working, but a push will then publish under this checkout's local branch name — it will NOT go to the PR source branch. (Detaching does not touch the PR on the server.)",
    confirmLabel: "Detach",
  });
  if (!confirmed) return;
  detachingReview.value = true;
  try {
    await appStore.detachWorkspaceReview(props.workspaceId);
  } catch (err) {
    rlog("error", "[GitBranchTab] detach from PR review failed", {
      workspaceId: props.workspaceId,
      error: (err as Error)?.message || String(err),
    });
    notifications.pushEphemeralToast({
      title: "Detach failed",
      body: userFacingMessage(err, "Could not detach the workspace from its PR review."),
      kind: "error",
      durationMs: 6000,
    });
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

// --- Compare against the (possibly overridden) base branch -----------------
//
// snapshot.compareWithBase always reflects snapshot.baseBranch. When the user
// picks a different base in the picker (overrideBaseBranch ≠ snapshot.baseBranch),
// we fetch fresh counts via gitFetchBaseComparison and read them from
// gitUi.baseComparison. Re-fetched on snapshot.lastFetchAt so a Fetch updates
// the chip without the user re-selecting the base.
const baseCompare = computed(() => {
  const base = opRef.value;
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

const isUpdating = computed(() => props.gitUi.busyAction === "rebase" || props.gitUi.busyAction === "merge");
// Nothing to pull in when the base has no commits HEAD lacks. The count is
// against the last-known remote ref, so a Fetch can revive it (the watch
// recomputes on snapshot.lastFetchAt).
const nothingToPull = computed(
  () => !baseCompare.value.loading && !baseCompare.value.error && (baseCompare.value.behindCount || 0) === 0,
);
const updateDisabled = computed(
  () => !!props.gitUi.busyAction || props.operation.inProgress || !!props.gitUi.pendingAction || nothingToPull.value,
);
const upstreamUpdateDisabled = computed(
  () =>
    !props.isDiverged ||
    !props.snapshot?.upstream ||
    !!props.gitUi.busyAction ||
    !!props.longGitOperation ||
    props.operation.inProgress ||
    !!props.gitUi.pendingAction ||
    reviewGitBusy.value,
);
const updateActionLabel = computed(() =>
  updateStrategy.value === "merge" ? `Merge ${opRef.value} in` : `Rebase onto ${opRef.value}`,
);
const strategyOptions = computed<StrategyOption[]>(() => [
  {
    value: "rebase",
    label: `Rebase onto ${opRef.value}`,
    title: "Replay your commits on top of the base (linear history, rewrites your commit hashes).",
    testid: "strategy-rebase",
  },
  {
    value: "merge",
    label: `Merge ${opRef.value} in`,
    title: "Merge the base into your branch (keeps history, adds a merge commit).",
    testid: "strategy-merge",
  },
]);
const updateTitle = computed(() => {
  if (nothingToPull.value) {
    return `Already up to date with ${opRef.value} — nothing to integrate.${
      opIsRemote.value ? " Fetch to check for new commits." : ""
    }`;
  }
  const fetchNote = opIsRemote.value ? " — fetches latest first" : " — local branch, no fetch";
  return `${updateActionLabel.value}${fetchNote}`;
});

function onUpdateFromBase() {
  rlog("info", "[GitBranchTab] onUpdateFromBase clicked", {
    workspaceId: props.workspaceId,
    opRef: opRef.value,
    updateStrategy: updateStrategy.value,
    opIsRemote: opIsRemote.value,
    updateDisabled: updateDisabled.value,
    nothingToPull: nothingToPull.value,
    busyAction: props.gitUi.busyAction || "",
    pendingAction: !!props.gitUi.pendingAction,
    operationInProgress: !!props.operation.inProgress,
  });
  if (!opRef.value) {
    rlog("warn", "[GitBranchTab] onUpdateFromBase aborted — empty opRef", { workspaceId: props.workspaceId });
    return;
  }
  const fetchFirst = opIsRemote.value;
  if (updateStrategy.value === "merge") {
    gitUiStore.gitMergeBase(props.workspaceId, opRef.value, { fetchFirst });
  } else {
    gitUiStore.gitRebaseBase(props.workspaceId, opRef.value, { fetchFirst });
  }
}

function onUpdateFromUpstream() {
  if (upstreamUpdateDisabled.value) return;
  if (updateStrategy.value === "merge") {
    gitUiStore.gitMergeBase(props.workspaceId, props.snapshot.upstream, { fetchFirst: true });
  } else {
    gitUiStore.gitRebaseBase(props.workspaceId, props.snapshot.upstream, { fetchFirst: true });
  }
}

// Diagnostic: log the Update button's enabled/disabled state with the reason
// only when it FLIPS — a disabled button swallows the click without firing
// onUpdateFromBase, so this surfaces why "nothing happens" without spamming the
// log on every background poll.
watch(
  () => updateDisabled.value,
  (disabled) => {
    rlog("info", "[GitBranchTab] update-button disabled changed", {
      workspaceId: props.workspaceId,
      disabled,
      opRef: opRef.value,
      nothingToPull: nothingToPull.value,
      behindCount: baseCompare.value.behindCount,
      baseLoading: baseCompare.value.loading,
      baseError: baseCompare.value.error,
      busyAction: props.gitUi.busyAction || "",
      pendingAction: !!props.gitUi.pendingAction,
      operationInProgress: !!props.operation.inProgress,
    });
  },
  { immediate: true },
);

// Split-button dropdown picks the default strategy (updates the main button
// label); the user then clicks the main button to run it — one deliberate
// step for a history-rewriting op. The pick is persisted, so the Pull button
// in the toolbar offers the same one.
function selectStrategy(strategy: "rebase" | "merge") {
  void notifications.runWithToast("Saving the update strategy failed", () =>
    appStore.updateSettings({ git: { ui: { updateStrategy: strategy } } }),
  );
}

watch(
  () => [opRef.value, props.snapshot?.branch, props.snapshot?.lastFetchAt],
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
