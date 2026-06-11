<template>
  <div class="workspace-pane__body workspace-pane__body--git">
    <PaneShell
      v-if="showHeader"
      :title="headerTitle"
      :status="headerStatus"
      :actions="headerActions"
      @action="onHeaderAction"
    />
    <div v-if="!snapshot?.available" class="terminal-empty">
      <p>Git workspace is unavailable</p>
      <small>This workspace is not inside a Git repository.</small>
    </div>
    <div
      v-else
      class="git-view"
      :class="{
        'git-view--menu-open': isMobile && menuOpen,
        'git-view--tabs-menu-open': isMobile && tabsMenuOpen,
      }"
    >
      <button
        v-if="isMobile"
        type="button"
        class="git-view__tabs-trigger"
        :aria-expanded="tabsMenuOpen"
        :aria-label="tabsMenuOpen ? 'Close tabs menu' : 'Open tabs menu'"
        @click="toggleTabsMenu"
      >
        <span class="git-view__tabs-trigger__label">{{ activeTabInfo.label }}</span>
        <span v-if="activeTabInfo.badge" class="git-tabs__badge">{{ activeTabInfo.badge }}</span>
        <span class="git-view__tabs-trigger__caret" aria-hidden="true">▼</span>
      </button>
      <button
        v-if="isMobile"
        type="button"
        class="git-view__menu-trigger"
        :aria-expanded="menuOpen"
        :aria-label="menuOpen ? 'Close actions menu' : 'Open actions menu'"
        @click="toggleActionsMenu"
      >
        <span class="git-view__menu-trigger__dot" aria-hidden="true">⋮</span>
        <span>{{ menuOpen ? "Close" : "Actions" }}</span>
      </button>
      <div
        v-if="isMobile && (menuOpen || tabsMenuOpen)"
        class="git-view__menu-backdrop"
        aria-hidden="true"
        @click="closeAllMenus"
      ></div>
      <div class="git-view__toolbar" @click="onToolbarClick">
        <div class="git-view__summary">
          <!-- Branch chip — detached HEAD gets special styling -->
          <span :class="['workspace-chip', isDetachedHead && 'workspace-chip--warn']">
            <strong>{{ isDetachedHead ? `detached HEAD @ ${snapshot.branch}` : snapshot.branch }}</strong>
            <template v-if="!isDetachedHead"> branch</template>
          </span>
          <span :class="['workspace-chip', isLinkedWorktree && 'workspace-chip--alert']">
            <strong>{{ snapshot.isMainWorktree ? "main" : "linked" }}</strong> worktree
          </span>
          <!-- ahead/behind only when upstream exists -->
          <template v-if="snapshot.upstream">
            <span v-if="snapshot.aheadCount > 0" class="workspace-chip">
              <strong>{{ snapshot.aheadCount }}</strong> ahead
            </span>
            <span v-if="snapshot.behindCount > 0" class="workspace-chip">
              <strong>{{ snapshot.behindCount }}</strong> behind
            </span>
          </template>
          <!-- no-upstream / no-remote contextual chips -->
          <span
            v-if="!snapshot.upstream && remoteCount > 0 && !showAllActions"
            class="workspace-chip workspace-chip--muted"
          >
            no upstream
          </span>
          <span v-if="remoteCount === 0 && !showAllActions" class="workspace-chip workspace-chip--muted">
            no remote
          </span>
          <!-- dirty badge only when actually dirty -->
          <span v-if="snapshot.dirty" class="workspace-chip">
            <strong>{{ snapshot.dirtyCount }}</strong> dirty
          </span>
          <span v-if="operation.inProgress" class="workspace-chip workspace-chip--alert">
            <strong>{{ operation.kind }}</strong> in progress
          </span>
        </div>
        <div class="git-view__actions">
          <!-- Repo picker (multi-root workspaces only) — inline with actions, compact -->
          <label v-if="showRepoPicker" class="git-repo-picker">
            <span class="git-repo-picker__label">Repo</span>
            <CustomSelect
              class="git-repo-picker__select"
              :model-value="activeRootPath"
              :options="repoPickerOptions"
              @change="onRootChange"
            />
            <span class="git-repo-picker__hint">{{ gitRoots.length }}</span>
          </label>
          <!-- Refresh: always visible, never primary -->
          <button
            type="button"
            data-testid="refresh-button"
            :class="['button', 'button--ghost', gitUi.busyAction === 'refresh' && 'button--busy']"
            :disabled="!!gitUi.busyAction"
            title="Re-read this repository's branch, ahead/behind counts, dirty list, worktrees, and tags from disk. No network operations."
            @click="gitUiStore.refreshGit(workspaceId)"
          >
            {{ gitUi.busyAction === "refresh" ? "Refreshing…" : "Refresh" }}
          </button>

          <!-- Fetch: hidden when no remotes (UC-8), never primary -->
          <button
            v-if="showFetch"
            type="button"
            data-testid="fetch-button"
            :class="['button', 'button--ghost', gitUi.busyAction === 'fetch' && 'button--busy']"
            :disabled="!!gitUi.busyAction || !!gitUi.pendingAction || operation.inProgress"
            title="git fetch — download remote refs and tags from origin so the ahead/behind counts update. Working tree, current branch, and uncommitted changes are not touched."
            @click="gitUiStore.gitFetch(workspaceId)"
          >
            {{ gitUi.busyAction === "fetch" ? "Fetching…" : "Fetch" }}
          </button>

          <!-- Pull: hidden when no upstream (UC-1, UC-9) unless showAllActions -->
          <button
            v-if="showPull"
            type="button"
            data-testid="pull-button"
            :class="['button', pullIsPrimary ? '' : 'button--ghost', gitUi.busyAction === 'pull' && 'button--busy']"
            :disabled="pullDisabled"
            :title="pullTooltip"
            @click="gitUiStore.gitPull(workspaceId, { stashDirty: pullStashMode })"
          >
            {{ pullLabel }}
          </button>

          <!-- Push: hidden when detached/review/no-remotes (structural impossibility) -->
          <button
            v-if="showPush"
            type="button"
            data-testid="push-button"
            :class="['button', pushIsPrimary ? '' : 'button--ghost', gitUi.busyAction === 'push' && 'button--busy']"
            :disabled="pushDisabled"
            :title="pushTooltip"
            @click="gitUiStore.gitPush(workspaceId)"
          >
            {{ gitUi.busyAction === "push" ? "Pushing…" : pushLabel }}
          </button>

          <!-- New worktree: hidden when commitCount === 0 (UC-7) unless showAllActions -->
          <button
            v-if="showNewWorktree"
            type="button"
            data-testid="new-worktree-button"
            class="button button--ghost"
            :disabled="!!gitUi.busyAction || !!gitUi.pendingAction || operation.inProgress"
            title="Open the worktree dialog — create a new git worktree off this repository on a new or existing branch and open it as its own workspace, so the main checkout stays untouched."
            @click="onCreateWorktree"
          >
            New worktree
          </button>

          <!-- Open Lazygit: never primary -->
          <button
            v-if="snapshot.lazygit?.available"
            type="button"
            data-testid="lazygit-button"
            class="button button--ghost"
            style="white-space: nowrap"
            title="Open lazygit in a new terminal tab pointed at this repository — full keyboard-driven git TUI for staging, committing, branching, rebasing, and history exploration."
            @click="gitUiStore.openLazygit(workspaceId)"
          >
            Open Lazygit
          </button>
          <button
            v-else
            type="button"
            class="button button--ghost"
            disabled
            style="white-space: nowrap; border: 1px dashed var(--accent); color: var(--accent); opacity: 0.9"
            title="Disabled — lazygit was not detected on PATH. Install it (https://github.com/jesseduffield/lazygit) and restart strIDEterm to enable this button."
          >
            Install Lazygit
          </button>

          <CustomSelect
            v-if="availableConnections.length && !isReviewWorkspace"
            class="git-branch-select"
            :model-value="activeConnectionId"
            :options="connectionOptions"
            @change="onConnectionChange"
          />
        </div>
      </div>

      <!-- Tab nav -->
      <nav class="git-tabs" role="tablist" aria-label="Git sections">
        <button
          v-for="tab in tabs"
          :key="tab.id"
          type="button"
          role="tab"
          :aria-selected="tab.id === activeTab ? 'true' : 'false'"
          :class="['git-tabs__item', tab.id === activeTab && 'git-tabs__item--active']"
          @click="onTabClick(tab.id)"
        >
          {{ tab.label }}<span v-if="tab.badge" class="git-tabs__badge">{{ tab.badge }}</span>
        </button>
      </nav>

      <section
        role="tabpanel"
        :class="['git-view__panel', isSwitchingRepo && 'git-view__panel--busy']"
        style="min-height: 0; overflow: auto; display: flex; flex-direction: column"
      >
        <div v-if="isSwitchingRepo" class="git-view__overlay" aria-hidden="true">
          <div class="git-view__spinner"></div>
        </div>
        <!-- ===== Branch tab ===== -->
        <GitBranchTab
          v-if="activeTab === 'branch'"
          :workspace-id="workspaceId"
          :snapshot="snapshot"
          :git-ui="gitUi"
          :operation="operation"
          :workspaces="workspaces"
          :is-empty-repo="isEmptyRepo"
          :has-no-remote="hasNoRemote"
          :show-all-actions="showAllActions"
          :is-diverged="isDiverged"
          :is-review-workspace="isReviewWorkspace"
          :is-linked-worktree="isLinkedWorktree"
          :push-remote="pushRemote"
          :show-update-current-branch="showUpdateCurrentBranch"
          :show-stash-card="showStashCard"
          :show-merge-back="showMergeBack"
          :effective-base-branch="effectiveBaseBranch"
          :base-branch-options="baseBranchOptions"
          :default-branch="defaultBranch"
          :default-remote="defaultRemote"
          :remote-names="remoteNames"
          :switch-branch-options-list="switchBranchOptionsList"
        />

        <!-- ===== Branches tab (JetBrains-style branch list) ===== -->
        <GitBranchesTab
          v-else-if="activeTab === 'branches'"
          :workspace-id="workspaceId"
          :snapshot="snapshot"
          :git-ui="gitUi"
          :active-root-path="activeRootPath"
          :is-review-workspace="isReviewWorkspace"
          :has-azure-connection="hasAzureConnection"
          :active-connection-id="activeConnectionId"
          :base-branch="effectiveBaseBranch"
          :compare="compare"
          :base-branch-options="baseBranchOptions"
          :default-branch="defaultBranch"
          :default-remote="defaultRemote"
          :remote-names="remoteNames"
        />

        <!-- ===== Changes tab ===== -->
        <GitChangesTab
          v-else-if="activeTab === 'changes'"
          :workspace-id="workspaceId"
          :snapshot="snapshot"
          :git-ui="gitUi"
          :operation="operation"
          :active-root-path="activeRootPath"
          :is-detached-head="isDetachedHead"
          :is-review-workspace="isReviewWorkspace"
        />

        <!-- ===== Stashes tab ===== -->
        <GitStashesTab
          v-else-if="activeTab === 'stashes'"
          :workspace-id="workspaceId"
          :snapshot="snapshot"
          :active-root-path="activeRootPath"
        />

        <!-- ===== Conflicts tab (only while an operation has conflicts) ===== -->
        <GitConflictsTab
          v-else-if="activeTab === 'conflicts'"
          :workspace-id="workspaceId"
          :root-path="activeRootPath"
        />

        <!-- ===== Pull Request tab ===== -->
        <GitPullRequestTab
          v-else-if="activeTab === 'pr'"
          :workspace-id="workspaceId"
          :snapshot="snapshot"
          :git-ui="gitUi"
          :base-branch="baseBranch"
          :has-no-remote="hasNoRemote"
          :has-azure-connection="hasAzureConnection"
          :active-connection-id="activeConnectionId"
          :active-connection-label="activeConnectionLabel"
        />

        <!-- ===== Worktrees tab ===== -->
        <template v-else-if="activeTab === 'worktrees'">
          <div class="git-section">
            <article class="git-card">
              <div class="section-head">
                <div>
                  <p class="eyebrow">Worktree Context</p>
                  <h3>{{ snapshot.repository || snapshot.root }}</h3>
                </div>
              </div>
              <p class="git-card__path">{{ snapshot.root }}</p>
              <div class="git-detail-list">
                <span><strong>Current branch:</strong> {{ snapshot.branch }}</span>
                <span><strong>Main worktree:</strong> {{ snapshot.mainWorktreePath || snapshot.root }}</span>
                <span><strong>Current path:</strong> {{ snapshot.worktreePath || snapshot.root }}</span>
              </div>
              <GitWorktreeList
                :snapshot="snapshot"
                :workspaces="workspaces"
                :workspace-id="workspaceId"
                :git-ui="gitUi"
                :push-remote="pushRemote"
                :is-review-workspace="isReviewWorkspace"
              />
            </article>
            <!-- Confirm dialogs/result banners must render here too — without
              this, Delete on the Worktrees tab silently sets a pending action
              that never surfaces (it only renders inside the Branch tab). -->
            <GitOperationCard :snapshot="snapshot" :workspace-id="workspaceId" :git-ui="gitUi" />
          </div>
        </template>

        <!-- ===== Bulk tab (multi-repo only) ===== -->
        <template v-else-if="activeTab === 'bulk'">
          <BulkRepoTable
            :roots-snapshots="allRootsSnapshots"
            :workspace-id="props.workspaceId"
            :on-fetch-all="onBulkFetchAll"
            :on-pull-all="onBulkPullAll"
            :on-refresh-root="onBulkRefreshRoot"
            :on-pull-root="onBulkPullRoot"
            :on-reveal-root="onBulkRevealRoot"
          />
        </template>
      </section>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useAppStore } from "../../stores/app.js";
import { useGitUiStore } from "../../stores/git-ui.js";
import PaneShell from "../layout/PaneShell.vue";
import GitBranchTab from "./git/GitBranchTab.vue";
import GitBranchesTab from "./git/GitBranchesTab.vue";
import GitChangesTab from "./git/GitChangesTab.vue";
import GitStashesTab from "./git/GitStashesTab.vue";
import GitConflictsTab from "./git/GitConflictsTab.vue";
import GitPullRequestTab from "./git/GitPullRequestTab.vue";
import GitWorktreeList from "./git/GitWorktreeList.vue";
import GitOperationCard from "./git/GitOperationCard.vue";
import BulkRepoTable from "./git/BulkRepoTable.vue";
import CustomSelect from "../common/CustomSelect.vue";
import { useIsNarrow } from "../../composables/useIsNarrow.js";

const props = withDefaults(defineProps<{ workspaceId: string; showHeader?: boolean }>(), { showHeader: false });

const appStore = useAppStore();
const gitUiStore = useGitUiStore();
const { isMobile } = useIsNarrow();
const menuOpen = ref(false);
const tabsMenuOpen = ref(false);

watch(isMobile, (mobile) => {
  if (!mobile) {
    menuOpen.value = false;
    tabsMenuOpen.value = false;
  }
});

function toggleActionsMenu() {
  if (menuOpen.value) {
    menuOpen.value = false;
  } else {
    menuOpen.value = true;
    tabsMenuOpen.value = false;
  }
}

function toggleTabsMenu() {
  if (tabsMenuOpen.value) {
    tabsMenuOpen.value = false;
  } else {
    tabsMenuOpen.value = true;
    menuOpen.value = false;
  }
}

function closeAllMenus() {
  menuOpen.value = false;
  tabsMenuOpen.value = false;
}

function onTabClick(id: string) {
  gitUiStore.gitSwitchTab(props.workspaceId, id);
  if (tabsMenuOpen.value) tabsMenuOpen.value = false;
}

function onToolbarClick(e: MouseEvent) {
  if (!isMobile.value || !menuOpen.value) return;
  const target = e.target as Element | null;
  if (!target) return;
  // CustomSelect renders its dropdown via Teleport; clicking its trigger
  // shouldn't dismiss the actions menu.
  if (target.closest(".custom-select")) return;
  if (target.closest("button")) menuOpen.value = false;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- MIGRATION-EXEMPT: git snapshot is an open-ended server JSON blob; typed in shared types but indexed dynamically here
const snapshot = computed<Record<string, any> | null>(
  () => appStore.getActiveGitSnapshot(props.workspaceId) as Record<string, any> | null, // eslint-disable-line @typescript-eslint/no-explicit-any -- MIGRATION-EXEMPT
);
const gitUi = computed(() => gitUiStore.get(props.workspaceId));
const workspaces = computed(() => appStore.filteredWorkspaces);

const workspace = computed(() => (appStore.filteredWorkspaces || []).find((ws) => ws.id === props.workspaceId));
const isReviewWorkspace = computed(() => !!workspace.value?.review?.prKey);

// Multi-repo computed values
const gitRoots = computed(() => workspace.value?.gitRoots || []);
const isMultiRepo = computed(() => gitRoots.value.length >= 2);
const showRepoPicker = computed(() => isMultiRepo.value && !isReviewWorkspace.value);
const activeRootPath = computed(() => gitUiStore.getActiveRoot(props.workspaceId) || snapshot.value?.rootPath || "");
const allRootsSnapshots = computed(() => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const entry = appStore.payload?.git?.workspaces?.[props.workspaceId] as any;
  if (!entry?.roots) return [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return Object.entries(entry.roots).map(([rootPath, snap]: [string, any]) => ({ rootPath, ...snap }));
});
const isLinkedWorktree = computed(() => snapshot.value?.isWorktree && !snapshot.value?.isMainWorktree);
const operation = computed(() => snapshot.value?.operationState || {});
const baseBranch = computed(() => snapshot.value?.baseBranch || snapshot.value?.compareWithBase?.baseBranch || "");
const defaultBranch = computed(() => String(snapshot.value?.defaultBranch || ""));
const defaultRemote = computed(() => String(snapshot.value?.defaultRemote || ""));
// Keys of snapshot.remotes are the real remote names. Skip "pushurl:"/"fetch:"
// suffixed entries that show up in some `git remote -v` parses.
const remoteNames = computed<string[]>(() =>
  Object.keys(snapshot.value?.remotes || {}).filter((k) => k && !k.includes(":")),
);
const compare = computed(() => snapshot.value?.compareWithBase || {});
// The legacy "graph", "tags", and "history" tabs were folded into
// "branches" — anything persisted with those ids is silently redirected so
// users don't land on a blank pane after the consolidation. History was
// the last to go once Branches got the Flat view + Compare picker.
// Conflicts tab appears while an operation reports conflicted paths, or while
// the conflict state is open (covers working-tree conflicts, e.g. stash pop).
const hasConflictsTab = computed(
  () => (operation.value.conflicts?.length ?? 0) > 0 || gitUi.value.conflictDialog?.open === true,
);

const activeTab = computed(() => {
  const t = gitUi.value.activeTab || "branch";
  if (t === "graph" || t === "tags" || t === "history") return "branches";
  // Conflicts tab only exists while conflicts are present — fall back to
  // Overview if the persisted tab outlived the operation.
  if (t === "conflicts" && !hasConflictsTab.value) return "branch";
  return t;
});

const showAllActions = computed(() => appStore.payload?.appState?.settings?.git?.ui?.showAllActions === true);

// Effective base branch: override from UI, or auto-detected
const effectiveBaseBranch = computed(() => gitUi.value.overrideBaseBranch || baseBranch.value);

// Remote / upstream state
const remoteCount = computed(() => Object.keys(snapshot.value?.remotes || {}).filter((k) => !k.includes(":")).length);
const hasNoRemote = computed(() => remoteCount.value === 0);
const isDetachedHead = computed(() => snapshot.value?.branch === "HEAD" || !snapshot.value?.branch);
const isEmptyRepo = computed(() => (snapshot.value?.commitCount || 0) === 0);
const isDiverged = computed(() => {
  const s = snapshot.value;
  return !!(s && s.aheadCount > 0 && s.behindCount > 0 && s.upstream);
});

// Push button state — detect remote name from upstream or remotes list
const pushRemote = computed(() => {
  const s = snapshot.value;
  if (!s) return "origin";
  const remoteNames = Object.keys(s.remotes || {}).filter((k) => !k.includes(":"));
  if (s.upstream) {
    return remoteNames.find((r) => s.upstream.startsWith(`${r}/`)) || remoteNames[0] || "origin";
  }
  return remoteNames[0] || "origin";
});
const upstreamMatchesBranch = computed(() => {
  const s = snapshot.value;
  return s?.upstream === `${pushRemote.value}/${s?.branch}`;
});
const canPush = computed(() => {
  const s = snapshot.value;
  if (!s) return false;
  return s.aheadCount > 0 || !s.upstream || !upstreamMatchesBranch.value;
});

// UC-17: primary button arbitration — at most 1 primary in toolbar
const primaryAction = computed(() => {
  if (showAllActions.value) {
    // legacy: all primary-qualified get primary
    const s = snapshot.value;
    if (!s) return null;
    if (s.behindCount > 0 && !isDiverged.value) return "pull";
    if (s.aheadCount > 0 && s.upstream) return "push";
    return null;
  }
  if (operation.value.inProgress) return null;
  if (gitUi.value.pendingAction) return null;
  if (isDiverged.value) return null;
  if (isDetachedHead.value) return null;
  const s = snapshot.value;
  if (!s) return null;
  if (s.behindCount > 0) return "pull";
  if (s.aheadCount > 0 && s.upstream) return "push";
  return null;
});

// Visibility rules for toolbar buttons
const showFetch = computed(() => showAllActions.value || remoteCount.value > 0);
const showPull = computed(() => {
  if (showAllActions.value) return true;
  return !!snapshot.value?.upstream;
});
const showPush = computed(() => {
  if (isDetachedHead.value) return false; // structural
  if (isReviewWorkspace.value) return false; // structural
  if (hasNoRemote.value) return false; // structural
  return true;
});
const showNewWorktree = computed(() => {
  if (isReviewWorkspace.value) return false;
  return showAllActions.value || (snapshot.value?.commitCount || 0) > 0;
});

// Pull state
const pullIsPrimary = computed(() => primaryAction.value === "pull");
const pullDisabled = computed(() => {
  if (!!gitUi.value.busyAction || operation.value.inProgress || !!gitUi.value.pendingAction) return true;
  if (!snapshot.value?.upstream) return true;
  if (isDetachedHead.value) return true;
  if ((snapshot.value?.behindCount || 0) === 0 && !isDiverged.value) return true;
  return false;
});
// When the working tree is dirty but there is something to pull, offer an
// explicit stash-pull-restore instead of disabling: stash local changes,
// fast-forward, then pop the stash (the backend keeps the stash if the pop
// would need manual conflict resolution).
const pullStashMode = computed(() => {
  const s = snapshot.value;
  if (!s?.dirty) return false;
  if (!s.upstream) return false;
  if (isDetachedHead.value) return false;
  if ((s.behindCount || 0) === 0 && !isDiverged.value) return false;
  return true;
});
const pullLabel = computed(() => {
  if (gitUi.value.busyAction === "pull") return "Pulling…";
  return pullStashMode.value ? "Pull (stash & restore)" : "Pull";
});
const pullTooltip = computed(() => {
  const s = snapshot.value;
  if (!s?.upstream)
    return "Disabled — this branch has no upstream tracking ref. Set one with the Push button (it publishes and tracks at the same time).";
  if (isDetachedHead.value) return "Disabled — HEAD is detached from any branch. Check out a branch first, then pull.";
  if ((s.behindCount || 0) === 0 && !isDiverged.value)
    return "Disabled — local branch is already up to date with upstream; nothing to pull.";
  if (pullStashMode.value)
    return `Stash your uncommitted changes, fast-forward ${s.behindCount} commit${s.behindCount !== 1 ? "s" : ""} from ${s.upstream}, then restore the changes. If the restore conflicts you'll get standard conflict markers to resolve.`;
  return `Run git pull (fast-forward) to bring in ${s.behindCount} commit${s.behindCount !== 1 ? "s" : ""} from ${s.upstream} and update the working tree.`;
});

// Push state
const pushLabel = computed(() => {
  const s = snapshot.value;
  if (!s) return "Push";
  if (!s.upstream || !upstreamMatchesBranch.value) return "Publish branch";
  return "Push";
});
const pushIsPrimary = computed(() => primaryAction.value === "push");
const pushDisabled = computed(() => {
  if (!!gitUi.value.busyAction || operation.value.inProgress || !!gitUi.value.pendingAction) return true;
  if (isDiverged.value && !showAllActions.value) return true;
  if (!canPush.value) return true;
  return false;
});
const pushTooltip = computed(() => {
  const s = snapshot.value;
  if (!s) return "Push the current branch to its remote tracking ref.";
  if (isDiverged.value && !showAllActions.value)
    return "Disabled — local branch has diverged from upstream and a regular push would be rejected. Resolve via the Force push (--force-with-lease) banner above if you intentionally rewrote history.";
  const target = `${pushRemote.value}/${s.branch}`;
  if (!s.upstream || !upstreamMatchesBranch.value) {
    return `Run git push -u ${pushRemote.value} ${s.branch} — publishes the branch and pins ${target} as its upstream tracking ref so future pulls and pushes know where to go.`;
  }
  if (s.aheadCount > 0)
    return `Run git push to send ${s.aheadCount} local commit${s.aheadCount !== 1 ? "s" : ""} to ${target}.`;
  return "Disabled — local branch has nothing ahead of upstream; nothing to push.";
});

// Card visibility
const showStashCard = computed(() => {
  if (isReviewWorkspace.value) return false;
  return showAllActions.value || snapshot.value?.dirty || (snapshot.value?.stashCount || 0) > 0;
});
const showUpdateCurrentBranch = computed(() => {
  if (!snapshot.value) return false;
  if (!showAllActions.value && effectiveBaseBranch.value === snapshot.value.branch) return false;
  return true;
});
const showMergeBack = computed(() => {
  if (isReviewWorkspace.value) return false;
  if (!showAllActions.value) {
    if (!isLinkedWorktree.value) return false;
    if (!effectiveBaseBranch.value) return false;
    if (effectiveBaseBranch.value === snapshot.value?.branch) return false;
  }
  return true;
});

// Multi-repo root picker
const isSwitchingRepo = ref(false);
async function onRootChange(newRoot: string | number) {
  const rootStr = String(newRoot);
  if (rootStr === activeRootPath.value) return;
  isSwitchingRepo.value = true;
  gitUiStore.setActiveRoot(props.workspaceId, rootStr);
  try {
    await gitUiStore.refreshGit(props.workspaceId);
  } finally {
    // Min 180ms visibility so the user sees the transition even on cache-warm switches
    await new Promise((resolve) => setTimeout(resolve, 180));
    isSwitchingRepo.value = false;
  }
}

function formatRootLabel(rootPath: string) {
  if (!rootPath) return "";
  const basename = rootPath.split(/[\\/]/).filter(Boolean).at(-1) || rootPath;
  // collision check: if two roots share the same basename, show parent/basename
  const others = gitRoots.value.filter((r: string) => r !== rootPath);
  const collision = others.some((r: string) => (r.split(/[\\/]/).filter(Boolean).at(-1) || r) === basename);
  if (collision) {
    const parts = rootPath.split(/[\\/]/).filter(Boolean);
    return parts.length >= 2 ? `${parts.at(-2)}/${parts.at(-1)}` : basename;
  }
  return basename;
}

// Branch options for combo box
const baseBranchOptions = computed(() => {
  const names: string[] = snapshot.value?.branchNames || [];
  const current = snapshot.value?.branch || "";
  const filtered = names.filter((n) => n !== current);
  // Put the detected base branch first if present
  const detected = baseBranch.value;
  if (detected && !filtered.includes(detected)) {
    filtered.unshift(detected);
  } else if (detected) {
    const idx = filtered.indexOf(detected);
    if (idx > 0) {
      filtered.splice(idx, 1);
      filtered.unshift(detected);
    }
  }
  return filtered;
});

// Azure DevOps connection detection
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const azureSnapshot = computed<Record<string, any>>(() => (appStore.payload?.azureDevops as any) || {});
const hasAzureConnection = computed(() => {
  const remoteUrl = (snapshot.value?.remotes?.origin || "")
    .toLowerCase()
    .replace(/\.git$/i, "")
    .replace(/\/+$/, "");
  if (!remoteUrl) return false;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const connections: any[] = azureSnapshot.value.connections || [];
  return connections.some(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (c: any) => c.enabled && remoteUrl.startsWith(c.orgUrl?.toLowerCase().replace(/\/+$/, "") || "---"),
  );
});

// Connection selection for authenticated git operations (push/fetch/PR).
// Scope to this workspace's profile — payload.git.connections now contains
// connections from every open profile, so we must filter or the picker
// would show cross-profile entries that resolveGitConnection refuses to
// honour at op time.
const availableConnections = computed(() => {
  const wsProfileId = workspace.value?.profileId || "default";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return ((appStore.payload?.git as any)?.connections || []).filter(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (c: any) => c.enabled && (c.profileId || "default") === wsProfileId,
  );
});
const activeConnectionId = computed(() => workspace.value?.connectionId || "");
const activeConnectionLabel = computed(() => {
  if (!activeConnectionId.value) return "auto-detected";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const found = availableConnections.value.find((c: any) => c.id === activeConnectionId.value);
  return found?.label || activeConnectionId.value;
});

// Branch switcher options (built here so the same data backs both the
// Branch tab subcomponent and any external consumer).
const switchBranchOptions = computed(() => {
  const names: string[] = snapshot.value?.branchNames || [];
  const current = snapshot.value?.branch || "";
  return names.filter((n) => n !== current);
});

// UC-12: auto-dismiss stale pending confirm when snapshot state changes
watch(snapshot, (newSnapshot) => {
  if (newSnapshot && gitUi.value.pendingAction) {
    gitUiStore.dismissStalePending(props.workspaceId, newSnapshot);
  }
});

const tabs = computed(() => {
  const list = [
    { id: "branch", label: "Overview", badge: operation.value.inProgress ? "!" : "" },
    { id: "branches", label: "Branches", badge: "" },
    {
      id: "changes",
      label: "Changes",
      badge: (snapshot.value?.dirtyCount || 0) > 0 ? String(snapshot.value?.dirtyCount ?? 0) : "",
    },
    {
      id: "stashes",
      label: "Stashes",
      badge: (snapshot.value?.stashCount || 0) > 0 ? String(snapshot.value?.stashCount) : "",
    },
    { id: "pr", label: "Pull Request", badge: "" },
    { id: "worktrees", label: "Worktrees", badge: "" },
  ];
  if (isMultiRepo.value) {
    list.push({ id: "bulk", label: "Bulk", badge: "" });
  }
  if (hasConflictsTab.value) {
    const count = operation.value.conflicts?.length ?? 0;
    list.push({ id: "conflicts", label: "Conflicts", badge: count > 0 ? String(count) : "" });
  }
  return list;
});

const activeTabInfo = computed(() => tabs.value.find((t) => t.id === activeTab.value) || tabs.value[0]);

const headerTitle = computed(() => `Git: ${snapshot.value?.branch || props.workspaceId}`);
const headerStatus = computed(() => (snapshot.value?.dirty ? `${snapshot.value.dirtyCount} dirty` : ""));
const headerActions = computed(() => [
  {
    className: "workspace-pane__icon-btn",
    action: "select-tab",
    viewId: `git:${props.workspaceId}`,
    title: "Make the Git pane the active tab — same as left-clicking it in the tab bar.",
    label: "◉",
  },
  {
    className: "workspace-pane__icon-btn workspace-pane__icon-btn--danger",
    action: "close-tab",
    viewId: `git:${props.workspaceId}`,
    title: "Close the Git tab. The pane reopens automatically when you re-activate this workspace.",
    label: "×",
  },
]);

function onHeaderAction(action: { action: string; viewId?: string }) {
  if (action.action === "select-tab") appStore.activateView(action.viewId || "");
  else if (action.action === "close-tab") appStore.closeTab(action.viewId || "");
}

function onCreateWorktree() {
  appStore.createWorktreeWithDialog(props.workspaceId, { preselectedRootPath: activeRootPath.value || "" });
}

function onBulkFetchAll() {
  gitUiStore.bulkFetch(props.workspaceId);
}
function onBulkPullAll() {
  gitUiStore.bulkPull(props.workspaceId);
}
function onBulkRefreshRoot(rootPath: string) {
  gitUiStore.refreshRoot(props.workspaceId, rootPath);
}
function onBulkPullRoot(rootPath: string) {
  gitUiStore.pullRoot(props.workspaceId, rootPath);
}
function onBulkRevealRoot(rootPath: string) {
  gitUiStore.revealRoot(props.workspaceId, rootPath);
}

function onConnectionChange(value: string | number) {
  const existing = (appStore.payload?.appState?.workspaces || []).find((ws) => ws.id === props.workspaceId);
  if (existing) {
    appStore.saveWorkspace({ ...existing, connectionId: String(value) });
  }
}

const repoPickerOptions = computed(() =>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (gitRoots.value as any[]).map((root: any) => ({ value: root, label: formatRootLabel(root) })),
);
const connectionOptions = computed(() => [
  { value: "", label: "System credentials" },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ...availableConnections.value.map((c: any) => ({ value: c.id, label: c.label || c.id })),
]);
const switchBranchOptionsList = computed(() => switchBranchOptions.value.map((b) => ({ value: b, label: b })));
</script>

<style scoped>
.git-repo-picker {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
}

.git-repo-picker__label {
  font-size: 11px;
  color: var(--muted);
  text-transform: uppercase;
  letter-spacing: 0.5px;
  white-space: nowrap;
}

.git-view__actions .git-repo-picker__select {
  width: 180px;
}

.git-repo-picker__hint {
  font-size: 10px;
  color: var(--muted);
  white-space: nowrap;
  opacity: 0.7;
}

.git-view__panel--busy {
  position: relative;
  overflow: hidden;
}
.git-view__overlay {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 10;
  background: rgba(0, 0, 0, 0.55);
  backdrop-filter: blur(1px);
  pointer-events: none;
}
.git-view__spinner {
  width: 32px;
  height: 32px;
  border: 3px solid var(--border);
  border-top-color: var(--accent, #e8a838);
  border-radius: 50%;
  animation: git-spin 0.8s linear infinite;
}
@keyframes git-spin {
  to {
    transform: rotate(360deg);
  }
}

/* Changes tab layout (the rest lives in the tab components themselves so
   scoped styles target their inner DOM correctly). */
:deep(.git-section--changes) {
  display: flex !important;
  flex-direction: column;
  grid-template-columns: none !important;
  grid-template-rows: none !important;
  align-content: stretch;
  flex: 1;
  min-height: 0;
  overflow: hidden;
}
</style>
