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
    <div v-else class="git-view">
      <div class="git-view__toolbar">
        <div class="git-view__summary">
          <span class="workspace-chip"><strong>{{ snapshot.branch }}</strong> branch</span>
          <span class="workspace-chip"><strong>{{ snapshot.isMainWorktree ? 'main' : 'linked' }}</strong> worktree</span>
          <span class="workspace-chip"><strong>{{ snapshot.aheadCount || 0 }}</strong> ahead</span>
          <span class="workspace-chip"><strong>{{ snapshot.behindCount || 0 }}</strong> behind</span>
          <span class="workspace-chip"><strong>{{ snapshot.dirty ? snapshot.dirtyCount : 0 }}</strong> {{ snapshot.dirty ? 'dirty' : 'clean' }}</span>
          <span v-if="operation.inProgress" class="workspace-chip workspace-chip--alert"><strong>{{ operation.kind }}</strong> in progress</span>
        </div>
        <div class="git-view__actions">
          <button type="button" :class="['button', 'button--ghost', gitUi.busyAction === 'refresh' && 'button--busy']" :disabled="!!gitUi.busyAction" @click="gitUiStore.refreshGit(workspaceId)">{{ gitUi.busyAction === 'refresh' ? 'Refreshing…' : 'Refresh' }}</button>
          <button type="button" :class="['button', 'button--ghost', gitUi.busyAction === 'fetch' && 'button--busy']" :disabled="!!gitUi.busyAction" @click="gitUiStore.gitFetch(workspaceId)">{{ gitUi.busyAction === 'fetch' ? 'Fetching…' : 'Fetch' }}</button>
          <button type="button" class="button button--ghost" @click="onCreateWorktree">New worktree</button>
          <button v-if="snapshot.lazygit?.available" type="button" class="button" style="white-space:nowrap" @click="gitUiStore.openLazygit(workspaceId)">Open Lazygit</button>
          <button v-else type="button" class="button button--ghost" disabled style="white-space:nowrap;border:1px dashed var(--accent);color:var(--accent);opacity:0.9" title="Install lazygit to enable">Install Lazygit</button>
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
          @click="gitUiStore.gitSwitchTab(workspaceId, tab.id)"
        >{{ tab.label }}<span v-if="tab.badge" class="git-tabs__badge">{{ tab.badge }}</span></button>
      </nav>

      <section role="tabpanel" style="min-height:0;overflow:hidden;display:grid;">
        <template v-if="activeTab === 'status'">
          <div class="git-section">
            <!-- Operation card -->
            <GitOperationCard :snapshot="snapshot" :workspace-id="workspaceId" :git-ui="gitUi" />
            <!-- Update current branch -->
            <article class="git-card">
              <div class="section-head">
                <div>
                  <p class="eyebrow">Update Current Branch</p>
                  <h3>{{ baseBranch || '?' }} &rarr; {{ snapshot.branch }}</h3>
                </div>
              </div>
              <div class="git-detail-list">
                <span><strong>Current branch:</strong> {{ snapshot.branch }}</span>
                <span><strong>Base branch (local):</strong> {{ baseBranch || 'not detected' }}</span>
                <span><strong>Upstream:</strong> {{ snapshot.upstream || 'none' }}</span>
                <span><strong>Ahead/behind upstream:</strong> {{ snapshot.aheadCount || 0 }} / {{ snapshot.behindCount || 0 }}</span>
                <span><strong>Last fetch:</strong> {{ formatDateLabel(snapshot.lastFetchAt) }}</span>
              </div>
              <template v-if="baseBranch">
                <div class="git-operation-actions">
                  <button type="button" class="button" :disabled="!!(gitUi.busyAction || operation.inProgress)" @click="gitUiStore.gitRebaseBase(workspaceId, baseBranch)">{{ gitUi.busyAction === 'rebase' ? 'Rebasing…' : `Rebase onto ${baseBranch}` }}</button>
                  <button v-if="!isReviewWorkspace" type="button" class="button button--ghost" :disabled="!!(gitUi.busyAction || operation.inProgress)" @click="gitUiStore.gitMergeBase(workspaceId, baseBranch)">{{ gitUi.busyAction === 'merge' ? 'Merging…' : `Merge ${baseBranch} in` }}</button>
                </div>
                <p class="git-card__hint">Operations use the local {{ baseBranch }} branch. Fetch first to sync with remote.</p>
              </template>
              <p v-else class="git-card__hint">Base branch could not be detected automatically for this repository.</p>
            </article>
            <!-- Merge back card (hidden for review workspaces — merging into target is done via Azure DevOps) -->
            <GitMergeBackCard v-if="!isReviewWorkspace" :snapshot="snapshot" :workspace-id="workspaceId" :workspaces="workspaces" :git-ui="gitUi" />
          </div>
        </template>

        <template v-else-if="activeTab === 'changes'">
          <div class="git-section git-section--changes">
            <div class="git-section__files">
              <article class="git-card">
                <div class="section-head">
                  <div>
                    <p class="eyebrow">Changes</p>
                    <h3>{{ snapshot.dirty ? 'Working tree overview' : 'No local changes' }}</h3>
                  </div>
                </div>
                <GitDiffStat :stat="snapshot.diffStat" />
                <GitChangeList title="Staged" scope="staged" :files="snapshot.staged || []" :selected-diff="gitUi.selectedDiff" :workspace-id="workspaceId" @select="(p, s) => gitUiStore.gitSelectDiff(workspaceId, p, s)" />
                <GitChangeList title="Unstaged" scope="unstaged" :files="unstagedWithConflicts" :selected-diff="gitUi.selectedDiff" :workspace-id="workspaceId" @select="(p, s) => gitUiStore.gitSelectDiff(workspaceId, p, s)" />
                <GitChangeList title="Untracked" scope="untracked" :files="snapshot.untracked || []" :selected-diff="gitUi.selectedDiff" :workspace-id="workspaceId" @select="(p, s) => gitUiStore.gitSelectDiff(workspaceId, p, s)" />
              </article>
            </div>
            <div class="git-section__preview">
              <article class="git-card">
                <div class="section-head">
                  <div>
                    <p class="eyebrow">Diff Preview</p>
                    <h3>{{ gitUi.diffPreview?.path || 'Select a file' }}</h3>
                  </div>
                </div>
                <template v-if="gitUi.diffPreview">
                  <p v-if="gitUi.diffPreview.summary" class="git-card__hint">{{ gitUi.diffPreview.summary }}</p>
                  <DiffViewer :diff="gitUi.diffPreview.diff || ''" />
                </template>
                <p v-else class="git-card__hint">Click a file to load a diff preview.</p>
              </article>
            </div>
          </div>
        </template>

        <template v-else-if="activeTab === 'history'">
          <div class="git-section git-section--history">
            <div class="git-history__header">
              <article class="git-card">
                <div class="section-head">
                  <div>
                    <p class="eyebrow">Compare With Base</p>
                    <h3>{{ baseBranch || 'No base branch' }}</h3>
                  </div>
                </div>
                <GitDiffStat :stat="compare.diffStat" />
                <div class="git-detail-list">
                  <span><strong>Branch commits:</strong> {{ compare.aheadCount || 0 }}</span>
                  <span><strong>Missing from base:</strong> {{ compare.behindCount || 0 }}</span>
                </div>
              </article>
            </div>
            <div class="git-history__panels">
              <div class="git-history__log">
                <GitCommitLog
                  :commits="allCommits"
                  :selected-commit="gitUi.selectedCommit"
                  :ahead-count="snapshot.aheadCount || 0"
                  @select="(hash) => gitUiStore.gitSelectCommit(workspaceId, hash)"
                />
              </div>
              <div class="git-history__detail">
                <template v-if="gitUi.commitDiffPreview">
                  <p v-if="gitUi.commitDiffPreview.summary" class="git-card__hint">{{ gitUi.commitDiffPreview.summary }}</p>
                  <DiffViewer :diff="gitUi.commitDiffPreview.diff || ''" />
                </template>
                <p v-else class="git-card__hint">Select a commit to view its diff.</p>
              </div>
            </div>
          </div>
        </template>

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
              <GitWorktreeList :snapshot="snapshot" :workspaces="workspaces" />
            </article>
          </div>
        </template>
      </section>
    </div>
  </div>
</template>

<script setup>
import { computed } from "vue";
import { useAppStore } from "../../stores/app.js";
import { useGitUiStore } from "../../stores/git-ui.js";
import { APP_CONFIG } from "../../../config/app-config.js";
import PaneShell from "../layout/PaneShell.vue";
import DiffViewer from "./DiffViewer.vue";
import GitDiffStat from "./git/GitDiffStat.vue";
import GitChangeList from "./git/GitChangeList.vue";
import GitOperationCard from "./git/GitOperationCard.vue";
import GitMergeBackCard from "./git/GitMergeBackCard.vue";
import GitWorktreeList from "./git/GitWorktreeList.vue";
import GitCommitLog from "./git/GitCommitLog.vue";

const props = defineProps({
  workspaceId: { type: String, required: true },
  showHeader: { type: Boolean, default: false },
});

const appStore = useAppStore();
const gitUiStore = useGitUiStore();

const snapshot = computed(() => appStore.getGitSnapshot(props.workspaceId));
const gitUi = computed(() => gitUiStore.get(props.workspaceId));
const workspaces = computed(() => appStore.filteredWorkspaces);

const workspace = computed(() => (appStore.filteredWorkspaces || []).find((ws) => ws.id === props.workspaceId));
const isReviewWorkspace = computed(() => !!workspace.value?.review?.prKey);
const operation = computed(() => snapshot.value?.operationState || {});
const baseBranch = computed(() => snapshot.value?.baseBranch || snapshot.value?.compareWithBase?.baseBranch || "");
const compare = computed(() => snapshot.value?.compareWithBase || {});
const activeTab = computed(() => gitUi.value.activeTab || "status");

const tabs = computed(() => [
  { id: "status", label: "Status", badge: operation.value.inProgress ? "!" : "" },
  { id: "changes", label: "Changes", badge: (snapshot.value?.dirtyCount || 0) > 0 ? String(snapshot.value.dirtyCount) : "" },
  { id: "history", label: "History", badge: "" },
  { id: "worktrees", label: "Worktrees", badge: "" },
]);

const unstagedWithConflicts = computed(() => [
  ...(snapshot.value?.unstaged || []),
  ...(operation.value.conflicts || []).map((entry) => ({ path: entry, code: "UU" })),
]);

const allCommits = computed(() => {
  const seen = new Set();
  const result = [];
  for (const entry of [...(compare.value.commits || []), ...(snapshot.value?.log || [])]) {
    if (!entry.shortHash || seen.has(entry.shortHash)) continue;
    seen.add(entry.shortHash);
    result.push(entry);
  }
  return result;
});

const headerTitle = computed(() => `Git: ${snapshot.value?.branch || props.workspaceId}`);
const headerStatus = computed(() => snapshot.value?.dirty ? `${snapshot.value.dirtyCount} dirty` : "");
const headerActions = computed(() => [
  { className: "workspace-pane__icon-btn", action: "select-tab", viewId: `git:${props.workspaceId}`, title: "Focus tab", label: "◉" },
  { className: "workspace-pane__icon-btn workspace-pane__icon-btn--danger", action: "close-tab", viewId: `git:${props.workspaceId}`, title: "Close tab", label: "×" },
]);

function formatDateLabel(value) {
  if (!value) return "Not fetched yet";
  try { return new Date(value).toLocaleString(); } catch { return value; }
}

function onHeaderAction(action) {
  if (action.action === "select-tab") appStore.activateView(action.viewId);
  else if (action.action === "close-tab") appStore.closeTab(action.viewId);
}

function onCreateWorktree() {
  appStore.openDialog("TextInputDialog", {
    eyebrow: "Git",
    title: "New worktree",
    label: "Branch name",
    placeholder: "feature/my-branch",
    submitLabel: "Create",
    onSubmit: (name) => appStore.createWorktree(props.workspaceId, name),
  });
}
</script>
