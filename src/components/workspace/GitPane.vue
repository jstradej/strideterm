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
          <span class="workspace-chip"
            ><strong>{{ snapshot.branch }}</strong> branch</span
          >
          <span :class="['workspace-chip', isLinkedWorktree && 'workspace-chip--alert']"
            ><strong>{{ snapshot.isMainWorktree ? "main" : "linked" }}</strong> worktree</span
          >
          <span class="workspace-chip"
            ><strong>{{ snapshot.aheadCount || 0 }}</strong> ahead</span
          >
          <span class="workspace-chip"
            ><strong>{{ snapshot.behindCount || 0 }}</strong> behind</span
          >
          <span class="workspace-chip"
            ><strong>{{ snapshot.dirty ? snapshot.dirtyCount : 0 }}</strong>
            {{ snapshot.dirty ? "dirty" : "clean" }}</span
          >
          <span v-if="operation.inProgress" class="workspace-chip workspace-chip--alert"
            ><strong>{{ operation.kind }}</strong> in progress</span
          >
        </div>
        <div class="git-view__actions">
          <button
            type="button"
            :class="['button', 'button--ghost', gitUi.busyAction === 'refresh' && 'button--busy']"
            :disabled="!!gitUi.busyAction"
            @click="gitUiStore.refreshGit(workspaceId)"
          >
            {{ gitUi.busyAction === "refresh" ? "Refreshing…" : "Refresh" }}
          </button>
          <button
            type="button"
            :class="['button', 'button--ghost', gitUi.busyAction === 'fetch' && 'button--busy']"
            :disabled="!!gitUi.busyAction"
            @click="gitUiStore.gitFetch(workspaceId)"
          >
            {{ gitUi.busyAction === "fetch" ? "Fetching…" : "Fetch" }}
          </button>
          <button
            v-if="!isLinkedWorktree"
            type="button"
            :class="['button', gitUi.busyAction === 'push' && 'button--busy']"
            :disabled="!!gitUi.busyAction"
            @click="gitUiStore.gitPush(workspaceId)"
          >
            {{ gitUi.busyAction === "push" ? "Pushing…" : "Push" }}
          </button>
          <button type="button" class="button button--ghost" @click="onCreateWorktree">New worktree</button>
          <button
            v-if="snapshot.lazygit?.available"
            type="button"
            class="button"
            style="white-space: nowrap"
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
            title="Install lazygit to enable"
          >
            Install Lazygit
          </button>
          <select
            v-if="availableConnections.length && !isLinkedWorktree"
            class="git-branch-select"
            :value="activeConnectionId"
            title="Git credentials source"
            @change="onConnectionChange"
          >
            <option value="">System credentials</option>
            <option v-for="c in availableConnections" :key="c.id" :value="c.id">{{ c.label || c.id }}</option>
          </select>
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
        >
          {{ tab.label }}<span v-if="tab.badge" class="git-tabs__badge">{{ tab.badge }}</span>
        </button>
      </nav>

      <section role="tabpanel" style="min-height: 0; overflow: auto; display: grid">
        <!-- ===== Branch tab ===== -->
        <template v-if="activeTab === 'branch'">
          <div class="git-section">
            <GitOperationCard :snapshot="snapshot" :workspace-id="workspaceId" :git-ui="gitUi" />

            <!-- Update current branch with base branch selector -->
            <article class="git-card">
              <div class="section-head">
                <div>
                  <p class="eyebrow">Update Current Branch</p>
                  <h3>{{ effectiveBaseBranch || "?" }} &rarr; {{ snapshot.branch }}</h3>
                </div>
              </div>
              <div class="git-detail-list">
                <span><strong>Current branch:</strong> {{ snapshot.branch }}</span>
                <span class="git-detail-list__row">
                  <strong>Base branch:</strong>
                  <template v-if="isLinkedWorktree">{{ effectiveBaseBranch || "?" }}</template>
                  <select v-else class="git-branch-select" :value="effectiveBaseBranch" @change="onBaseBranchChange">
                    <option v-if="!effectiveBaseBranch" value="" disabled>-- select --</option>
                    <option v-for="b in baseBranchOptions" :key="b" :value="b">{{ b }}</option>
                  </select>
                </span>
                <span><strong>Upstream:</strong> {{ snapshot.upstream || "none" }}</span>
                <span
                  ><strong>Ahead/behind upstream:</strong> {{ snapshot.aheadCount || 0 }} /
                  {{ snapshot.behindCount || 0 }}</span
                >
                <span><strong>Last fetch:</strong> {{ formatDateLabel(snapshot.lastFetchAt) }}</span>
              </div>
              <template v-if="effectiveBaseBranch">
                <div class="git-operation-actions">
                  <button
                    type="button"
                    class="button"
                    :disabled="!!(gitUi.busyAction || operation.inProgress)"
                    @click="gitUiStore.gitRebaseBase(workspaceId, effectiveBaseBranch)"
                  >
                    {{ gitUi.busyAction === "rebase" ? "Rebasing…" : `Rebase onto ${effectiveBaseBranch}` }}
                  </button>
                  <button
                    v-if="!isReviewWorkspace"
                    type="button"
                    class="button button--ghost"
                    :disabled="!!(gitUi.busyAction || operation.inProgress)"
                    @click="gitUiStore.gitMergeBase(workspaceId, effectiveBaseBranch)"
                  >
                    {{ gitUi.busyAction === "merge" ? "Merging…" : `Merge ${effectiveBaseBranch} in` }}
                  </button>
                </div>
                <p class="git-card__hint">
                  Operations use the local {{ effectiveBaseBranch }} branch. Fetch first to sync with remote.
                </p>
              </template>
              <p v-else class="git-card__hint">Select a base branch above to enable rebase/merge operations.</p>
            </article>

            <!-- Stash card -->
            <article class="git-card">
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
                  :disabled="!!(gitUi.busyAction || !snapshot.dirty)"
                  @click="gitUiStore.gitStash(workspaceId)"
                >
                  {{ gitUi.busyAction === "stash" ? "Stashing…" : "Stash" }}
                </button>
                <button
                  type="button"
                  class="button button--ghost"
                  :disabled="!!(gitUi.busyAction || !(snapshot.stashCount > 0))"
                  @click="gitUiStore.gitStashPop(workspaceId)"
                >
                  {{ gitUi.busyAction === "stash-pop" ? "Popping…" : "Unstash (pop)" }}
                </button>
              </div>
              <p class="git-card__hint">
                Stash saves uncommitted changes. Unstash restores the most recent stash entry.
              </p>
            </article>

            <!-- Switch / Create branch (main worktree only) -->
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
                    <select v-model="switchBranchTarget" class="git-branch-select">
                      <option value="" disabled>-- select branch --</option>
                      <option v-for="b in switchBranchOptions" :key="b" :value="b">{{ b }}</option>
                    </select>
                    <button
                      type="button"
                      class="button"
                      :disabled="!switchBranchTarget || !!gitUi.busyAction"
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
              v-if="!isReviewWorkspace"
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

        <!-- ===== Changes tab ===== -->
        <template v-else-if="activeTab === 'changes'">
          <div class="git-section git-section--changes">
            <div class="git-section__files">
              <article class="git-card">
                <div class="section-head">
                  <div>
                    <p class="eyebrow">Changes</p>
                    <h3>{{ snapshot.dirty ? "Working tree overview" : "No local changes" }}</h3>
                  </div>
                </div>
                <GitDiffStat :stat="snapshot.diffStat" />
                <GitChangeList
                  title="Staged"
                  scope="staged"
                  :files="snapshot.staged || []"
                  :selected-diff="gitUi.selectedDiff"
                  :workspace-id="workspaceId"
                  @select="(p, s) => gitUiStore.gitSelectDiff(workspaceId, p, s)"
                />
                <GitChangeList
                  title="Unstaged"
                  scope="unstaged"
                  :files="unstagedWithConflicts"
                  :selected-diff="gitUi.selectedDiff"
                  :workspace-id="workspaceId"
                  @select="(p, s) => gitUiStore.gitSelectDiff(workspaceId, p, s)"
                />
                <GitChangeList
                  title="Untracked"
                  scope="untracked"
                  :files="snapshot.untracked || []"
                  :selected-diff="gitUi.selectedDiff"
                  :workspace-id="workspaceId"
                  @select="(p, s) => gitUiStore.gitSelectDiff(workspaceId, p, s)"
                />
              </article>
            </div>
            <div class="git-section__preview">
              <article class="git-card">
                <div class="section-head">
                  <div>
                    <p class="eyebrow">Diff Preview</p>
                    <h3>{{ gitUi.diffPreview?.path || "Select a file" }}</h3>
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

        <!-- ===== History tab ===== -->
        <template v-else-if="activeTab === 'history'">
          <div class="git-section git-section--history">
            <div class="git-history__header">
              <article class="git-card">
                <div class="section-head">
                  <div>
                    <p class="eyebrow">Compare With Base</p>
                    <h3>{{ effectiveBaseBranch || "No base branch" }}</h3>
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
                  <p v-if="gitUi.commitDiffPreview.summary" class="git-card__hint">
                    {{ gitUi.commitDiffPreview.summary }}
                  </p>
                  <DiffViewer :diff="gitUi.commitDiffPreview.diff || ''" />
                </template>
                <p v-else class="git-card__hint">Select a commit to view its diff.</p>
              </div>
            </div>
          </div>
        </template>

        <!-- ===== Pull Request tab ===== -->
        <template v-else-if="activeTab === 'pr'">
          <div class="git-section">
            <article class="git-card">
              <div class="section-head">
                <div>
                  <p class="eyebrow">Create Pull Request</p>
                  <h3>{{ snapshot.branch }} &rarr; {{ prTargetBranch || "?" }}</h3>
                </div>
              </div>
              <div
                v-if="!activeConnectionId && !hasAzureConnection"
                class="git-card__hint git-card__hint--warning"
                style="margin-bottom: 8px"
              >
                No connection selected. Choose a connection in the toolbar dropdown to enable PR creation.
              </div>
              <template v-else>
                <p class="git-card__hint" style="margin-bottom: 8px">
                  Using connection: <strong>{{ activeConnectionLabel }}</strong>
                </p>
                <div class="git-pr-form">
                  <label class="git-pr-form__field">
                    <span class="git-pr-form__label">Source branch</span>
                    <input class="git-pr-form__input" type="text" :value="snapshot.branch" disabled />
                  </label>
                  <label class="git-pr-form__field">
                    <span class="git-pr-form__label">Target branch</span>
                    <select v-model="prTargetBranch" class="git-branch-select">
                      <option value="" disabled>-- select target --</option>
                      <option v-for="b in prTargetOptions" :key="b" :value="b">{{ b }}</option>
                    </select>
                    <button
                      v-if="!gitUi.remoteBranchesLoading"
                      type="button"
                      class="button button--ghost button--small"
                      style="margin-left: 6px"
                      @click="gitUiStore.azureListRemoteBranches(workspaceId)"
                    >
                      Load remote branches
                    </button>
                    <span v-else style="font-size: 12px; color: var(--muted); margin-left: 6px">Loading...</span>
                  </label>
                  <label class="git-pr-form__field">
                    <span class="git-pr-form__label">Title</span>
                    <input v-model="prTitle" class="git-pr-form__input" type="text" placeholder="Pull request title" />
                  </label>
                  <label class="git-pr-form__field">
                    <span class="git-pr-form__label">Description</span>
                    <textarea
                      v-model="prDescription"
                      class="git-pr-form__input git-pr-form__textarea"
                      placeholder="Optional description"
                      rows="4"
                    ></textarea>
                  </label>
                  <div class="git-operation-actions">
                    <button
                      type="button"
                      class="button"
                      :disabled="!prCanSubmit || !!gitUi.busyAction"
                      @click="onCreatePr"
                    >
                      {{ gitUi.busyAction === "create-pr" ? "Creating…" : "Create Pull Request" }}
                    </button>
                  </div>
                  <p v-if="prResult" :class="['git-card__hint', prResult.ok ? '' : 'git-card__hint--warning']">
                    {{ prResult.summary || (prResult.ok ? "Pull request created." : "Failed to create pull request.") }}
                    <a
                      v-if="prResult.url"
                      :href="prResult.url"
                      style="color: var(--accent); text-decoration: underline"
                      @click.prevent="openExternal(prResult.url)"
                      >Open in browser</a
                    >
                  </p>
                </div>
              </template>
            </article>
          </div>
        </template>

        <!-- ===== Tags tab ===== -->
        <template v-else-if="activeTab === 'tags'">
          <div class="git-section">
            <article class="git-card">
              <div class="section-head">
                <div>
                  <p class="eyebrow">Tags</p>
                  <h3>{{ snapshot.branch }} &mdash; {{ (gitUi.tags || []).length }} tag(s)</h3>
                </div>
              </div>
              <GitTagList :workspace-id="workspaceId" :git-ui="gitUi" />
            </article>
          </div>
        </template>

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
              <GitWorktreeList :snapshot="snapshot" :workspaces="workspaces" />
            </article>
          </div>
        </template>
      </section>
    </div>
  </div>
</template>

<script setup>
import { computed, ref, watch } from "vue";
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
import GitTagList from "./git/GitTagList.vue";
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
const isLinkedWorktree = computed(() => snapshot.value?.isWorktree && !snapshot.value?.isMainWorktree);
const operation = computed(() => snapshot.value?.operationState || {});
const baseBranch = computed(() => snapshot.value?.baseBranch || snapshot.value?.compareWithBase?.baseBranch || "");
const compare = computed(() => snapshot.value?.compareWithBase || {});
const activeTab = computed(() => gitUi.value.activeTab || "branch");

// Effective base branch: override from UI, or auto-detected
const effectiveBaseBranch = computed(() => gitUi.value.overrideBaseBranch || baseBranch.value);

// Branch options for combo box
const baseBranchOptions = computed(() => {
  const names = snapshot.value?.branchNames || [];
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
const azureSnapshot = computed(() => appStore.payload?.azureDevops || {});
const hasAzureConnection = computed(() => {
  const remoteUrl = (snapshot.value?.remotes?.origin || "")
    .toLowerCase()
    .replace(/\.git$/i, "")
    .replace(/\/+$/, "");
  if (!remoteUrl) return false;
  const connections = azureSnapshot.value.connections || [];
  return connections.some(
    (c) => c.enabled && remoteUrl.startsWith(c.orgUrl?.toLowerCase().replace(/\/+$/, "") || "---"),
  );
});

// Connection selection for authenticated git operations (push/fetch/PR).
// Reads from git.connections which merges all providers (Azure, future GitHub/GitLab).
const availableConnections = computed(() => (appStore.payload?.git?.connections || []).filter((c) => c.enabled));
const activeConnectionId = computed(() => workspace.value?.connectionId || "");
const activeConnectionLabel = computed(() => {
  if (!activeConnectionId.value) return "auto-detected";
  const found = availableConnections.value.find((c) => c.id === activeConnectionId.value);
  return found?.label || activeConnectionId.value;
});

// Branch switch/create state
const switchBranchTarget = ref("");
const newBranchName = ref("");
const switchBranchOptions = computed(() => {
  const names = snapshot.value?.branchNames || [];
  const current = snapshot.value?.branch || "";
  return names.filter((n) => n !== current);
});

// PR form state
const prTitle = ref("");
const prDescription = ref("");
const prTargetBranch = ref("");
const prResult = ref(null);

// PR target branch options: local branch names + remote branches loaded from Azure
const prTargetOptions = computed(() => {
  const localBranches = (snapshot.value?.branchNames || []).filter(
    (n) => !n.startsWith("origin/") && n !== snapshot.value?.branch,
  );
  const remoteBranches = (gitUi.value.remoteBranches || []).filter((n) => n !== snapshot.value?.branch);
  const merged = [...new Set([...localBranches, ...remoteBranches])];
  // Put common targets first
  const priority = ["develop", "main", "master"];
  merged.sort((a, b) => {
    const aIdx = priority.indexOf(a);
    const bIdx = priority.indexOf(b);
    if (aIdx >= 0 && bIdx >= 0) return aIdx - bIdx;
    if (aIdx >= 0) return -1;
    if (bIdx >= 0) return 1;
    return a.localeCompare(b);
  });
  return merged;
});

const prCanSubmit = computed(() => prTitle.value.trim() && prTargetBranch.value);

// Initialize PR target from base branch
watch(
  baseBranch,
  (val) => {
    if (!prTargetBranch.value && val) {
      const stripped = val.replace(/^origin\//, "");
      prTargetBranch.value = stripped;
    }
  },
  { immediate: true },
);

const tabs = computed(() => {
  const list = [
    { id: "branch", label: "Branch", badge: operation.value.inProgress ? "!" : "" },
    {
      id: "changes",
      label: "Changes",
      badge: (snapshot.value?.dirtyCount || 0) > 0 ? String(snapshot.value.dirtyCount) : "",
    },
    { id: "history", label: "History", badge: "" },
  ];
  if (!isReviewWorkspace.value && !isLinkedWorktree.value) {
    list.push({ id: "pr", label: "Pull Request", badge: "" });
  }
  list.push({ id: "tags", label: "Tags", badge: "" });
  list.push({ id: "worktrees", label: "Worktrees", badge: "" });
  return list;
});

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
const headerStatus = computed(() => (snapshot.value?.dirty ? `${snapshot.value.dirtyCount} dirty` : ""));
const headerActions = computed(() => [
  {
    className: "workspace-pane__icon-btn",
    action: "select-tab",
    viewId: `git:${props.workspaceId}`,
    title: "Focus tab",
    label: "◉",
  },
  {
    className: "workspace-pane__icon-btn workspace-pane__icon-btn--danger",
    action: "close-tab",
    viewId: `git:${props.workspaceId}`,
    title: "Close tab",
    label: "×",
  },
]);

function formatDateLabel(value) {
  if (!value) return "Not fetched yet";
  try {
    return new Date(value).toLocaleString();
  } catch {
    return value;
  }
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

function onBaseBranchChange(event) {
  gitUiStore.gitSetBaseBranch(props.workspaceId, event.target.value);
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
    gitUiStore.gitCreateBranch(props.workspaceId, name);
    newBranchName.value = "";
  }
}

function onConnectionChange(event) {
  const existing = (appStore.payload?.appState?.workspaces || []).find((ws) => ws.id === props.workspaceId);
  if (existing) {
    appStore.saveWorkspace({ ...existing, connectionId: event.target.value });
  }
}

async function onCreatePr() {
  prResult.value = null;
  const payload = await gitUiStore.azureCreatePullRequest(props.workspaceId, {
    title: prTitle.value.trim(),
    description: prDescription.value.trim(),
    sourceBranch: snapshot.value?.branch || "",
    targetBranch: prTargetBranch.value,
    connectionId: activeConnectionId.value || "",
  });
  const result = gitUi.value.lastResult;
  if (result?.ok) {
    prResult.value = { ok: true, summary: `PR #${result.pullRequestId || ""} created.`, url: result.url || "" };
  } else {
    prResult.value = { ok: false, summary: result?.summary || "Failed to create pull request." };
  }
}

function openExternal(url) {
  if (window.strideterm?.openExternal) {
    window.strideterm.openExternal(url);
  } else {
    window.open(url, "_blank");
  }
}
</script>
