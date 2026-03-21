<template>
  <div class="workspace-pane__body workspace-pane__body--git">
    <PaneShell
      v-if="showHeader"
      :title="`Review: ${prTitle}`"
      :status="headerStatus"
      :actions="headerActions"
      @action="onHeaderAction"
    />
    <div v-if="!detail" class="terminal-empty">
      <p>Review workspace</p>
      <small>PR data is loading or not available.</small>
    </div>
    <div v-else class="git-view review-shell">
      <!-- Toolbar -->
      <div class="git-view__toolbar">
        <div class="git-view__summary">
          <span class="workspace-chip"><strong>PR #{{ pullRequest.id }}</strong></span>
          <span class="workspace-chip">{{ detail.project?.name }} / {{ detail.repository?.name }}</span>
          <span class="workspace-chip">{{ detail.role }}</span>
          <span v-if="checks.failedCount" class="workspace-chip workspace-chip--alert">{{ checks.failedCount }} failed checks</span>
          <span v-if="checks.pendingCount" class="workspace-chip">{{ checks.pendingCount }} pending checks</span>
          <span v-if="detail.hasAttention" class="workspace-chip workspace-chip--alert">{{ detail.attentionReason || 'attention' }}</span>
          <span v-if="pendingSyncCount" class="workspace-chip">{{ pendingSyncCount }} queued drafts</span>
        </div>
        <div class="git-view__actions" style="margin-left:auto;">
          <button type="button" :class="['button', 'button--ghost', busyAction === 'refresh' && 'button--busy']" :disabled="!!busyAction" title="Fetch the latest PR data, threads, and comments from Azure DevOps" @click="handleRefresh">{{ busyAction === 'refresh' ? 'Refreshing…' : 'Refresh' }}<span v-if="newCommentsCount" class="azure-tab__count" style="margin-left:4px;">{{ newCommentsCount }}</span></button>
          <button type="button" :class="['button', 'button--ghost', busyAction === 'markSeen' && 'button--busy']" :disabled="!!busyAction" title="Mark all current activity as seen — clears the new-comments badge and attention indicator" @click="handleMarkSeen">Mark seen</button>
          <button type="button" :class="['button', busyAction === 'publish' && 'button--busy']" :disabled="!!busyAction || !pendingSyncCount" title="Send all queued draft replies to Azure DevOps as real comments" @click="handlePublish">{{ busyAction === 'publish' ? 'Publishing…' : `Publish queued drafts${pendingSyncCount ? ` (${pendingSyncCount})` : ''}` }}</button>
          <button type="button" class="button button--ghost" title="Open this pull request in the browser on Azure DevOps" @click="openBrowser">Browser</button>
        </div>
      </div>

      <!-- Failed sync banner -->
      <div v-if="failedSyncItems.length" style="padding:4px 12px;font-size:11px;background:rgba(255,80,80,0.08);border-bottom:1px solid var(--border);display:flex;flex-wrap:wrap;gap:6px;align-items:center;">
        <span class="workspace-chip workspace-chip--alert" style="font-size:10px;">Sync failed</span>
        <span v-for="entry in failedSyncItems" :key="entry.queueId" style="color:var(--muted);" :title="entry.lastError || ''">{{ entry.operation || 'publish' }} · {{ entry.attempts || 0 }} attempt(s){{ entry.lastError ? ` — ${entry.lastError.slice(0, 80)}` : '' }}</span>
        <button type="button" :class="['button', 'button--ghost', busyAction === 'publish' && 'button--busy']" style="font-size:10px;padding:1px 8px;margin-left:auto;" :disabled="!!busyAction" title="Retry publishing the failed drafts to Azure DevOps" @click="handlePublish">{{ busyAction === 'publish' ? 'Retrying…' : 'Retry' }}</button>
      </div>

      <!-- Sub-tabs -->
      <div class="review-subtabs">
        <button v-for="tab in reviewTabs" :key="tab.id" type="button" :class="['azure-tab', reviewUi.activeReviewTab === tab.id && 'azure-tab--active', tab.alert && 'azure-tab--alert']" @click="gitUiStore.reviewSwitchTab(workspaceId, tab.id)">
          {{ tab.label }}<span v-if="tab.count !== null" class="azure-tab__count">{{ tab.count }}</span>
        </button>
      </div>

      <div class="review-content">
        <!-- Summary panel -->
        <ReviewSummaryTab
          v-if="activeTab === 'summary'"
          :detail="detail"
          :pull-request="pullRequest"
          :reviewers="reviewers"
          :checks="checks"
          :changed-files="changedFiles"
          :pr-key="prKey"
          :workspace-id="workspaceId"
          @new-comment="openAzureComment"
        />

        <!-- Files panel -->
        <template v-else-if="activeTab === 'files'">
          <div class="review-files-split">
            <div class="review-files-split__left">
              <div class="section-head" style="padding:0 6px;"><div><p class="eyebrow">Changed files</p><h3>{{ changedFiles.length }} files</h3></div></div>
              <div v-if="changedFiles.length" class="review-file-tree" style="margin-top:8px;">
                <template v-for="node in fileTree" :key="node.key">
                  <details v-if="node.children" class="review-tree-dir" open>
                    <summary class="review-tree-dir__label"><span class="review-tree-dir__icon"></span><span>{{ node.name }}</span></summary>
                    <template v-for="child in node.children" :key="child.key">
                      <details v-if="child.children" class="review-tree-dir" open style="padding-left:14px;">
                        <summary class="review-tree-dir__label"><span class="review-tree-dir__icon"></span><span>{{ child.name }}</span></summary>
                        <button
                          v-for="leaf in child.children"
                          :key="leaf.key"
                          type="button"
                          :class="['review-tree-file', reviewUi.reviewSelectedFile === leaf.path && 'review-tree-file--active']"
                          style="padding-left:28px;"
                          :title="leaf.path"
                          @click="onSelectFile(leaf.path)"
                        >
                          <span :class="changeTypeClass(leaf.changeType)">{{ changeTypeLabel(leaf.changeType) }}</span>
                          <span class="review-tree-file__name">{{ leaf.name }}</span>
                        </button>
                      </details>
                      <button
                        v-else
                        type="button"
                        :class="['review-tree-file', reviewUi.reviewSelectedFile === child.path && 'review-tree-file--active']"
                        style="padding-left:14px;"
                        :title="child.path"
                        @click="onSelectFile(child.path)"
                      >
                        <span :class="changeTypeClass(child.changeType)">{{ changeTypeLabel(child.changeType) }}</span>
                        <span class="review-tree-file__name">{{ child.name }}</span>
                      </button>
                    </template>
                  </details>
                  <button
                    v-else
                    type="button"
                    :class="['review-tree-file', reviewUi.reviewSelectedFile === node.path && 'review-tree-file--active']"
                    :title="node.path"
                    @click="onSelectFile(node.path)"
                  >
                    <span :class="changeTypeClass(node.changeType)">{{ changeTypeLabel(node.changeType) }}</span>
                    <span class="review-tree-file__name">{{ node.name }}</span>
                  </button>
                </template>
              </div>
              <p v-else class="git-card__hint" style="padding:6px;">No changed files found.</p>
            </div>
            <div class="review-files-split__right">
              <template v-if="reviewUi.reviewFileDiffPreview">
                <div class="section-head" style="padding:0 6px;"><div><p class="eyebrow">Diff preview</p><h3>{{ reviewUi.reviewFileDiffPreview.path }}</h3></div></div>
                <DiffViewer v-if="reviewUi.reviewFileDiffPreview.diff" :diff="reviewUi.reviewFileDiffPreview.diff" />
                <p v-else class="git-card__hint" style="padding:6px;">{{ reviewUi.reviewFileDiffPreview.summary || 'No diff available.' }}</p>
              </template>
              <div v-else class="review-files-empty">
                <p class="eyebrow">Diff preview</p>
                <p class="git-card__hint">Click on a file in the list to view its diff.</p>
              </div>
            </div>
          </div>
        </template>

        <!-- Comments panel -->
        <ReviewCommentsTab
          v-else-if="activeTab === 'comments'"
          :pr-key="prKey"
          :workspace-id="workspaceId"
          :filtered-threads="filteredThreads"
          :filtered-draft-comments="filteredDraftComments"
          :drafts-by-thread="draftsByThread"
          :drafts-by-comment="draftsByComment"
          :thread-index="threadIndex"
          :thread-to-comment-key="threadToCommentKey"
          :filter="filter"
          :sort="sort"
          :search-term="searchTerm"
          :is-filtered="isFiltered"
          :all-drafts="allDrafts"
          :has-clearable="hasClearable"
          :sort-options="sortOptions"
          :total-comment-count="totalCommentCount"
        />

        <!-- Conflicts panel -->
        <template v-else-if="activeTab === 'conflicts'">
          <!-- No conflicts — simple card -->
          <div v-if="!conflictInfo.hasConflicts" class="review-panel">
            <article class="git-card review-card">
              <div class="section-head">
                <div><p class="eyebrow">Merge Status</p><h3>{{ conflictInfo.label }}</h3></div>
                <div class="docker-card__actions">
                  <button type="button" :class="['button', 'button--ghost', busyAction === 'refresh' && 'button--busy']" :disabled="!!busyAction" @click="handleRefresh">{{ busyAction === 'refresh' ? 'Refreshing…' : 'Refresh' }}</button>
                </div>
              </div>
              <div style="display:flex;align-items:center;gap:10px;padding:8px 0;">
                <span style="font-size:1.2em;color:#6edfb6;">✓</span>
                <p style="margin:0;"><strong>{{ stripRef(pullRequest.sourceRefName) }}</strong> can be merged without conflicts into <strong>{{ stripRef(pullRequest.targetRefName) }}</strong>.</p>
              </div>
            </article>
          </div>

          <!-- Has conflicts — split layout like Files tab -->
          <div v-else class="review-files-split">
            <div class="review-files-split__left">
              <div class="review-conflict-banner review-conflict-banner--danger" style="margin:0 0 8px;">
                <span class="review-conflict-banner__icon">✗</span>
                <div>
                  <strong>{{ conflictInfo.label }}</strong>
                  <p class="review-conflict-banner__hint"><code>{{ stripRef(pullRequest.sourceRefName) }}</code> &rarr; <code>{{ stripRef(pullRequest.targetRefName) }}</code></p>
                </div>
              </div>
              <div class="section-head" style="padding:0 6px;"><div><p class="eyebrow">Affected files</p><h3>{{ changedFiles.length }} files</h3></div></div>
              <div v-if="changedFiles.length" class="review-file-tree" style="margin-top:6px;">
                <template v-for="node in fileTree" :key="node.key">
                  <details v-if="node.children" class="review-tree-dir" open>
                    <summary class="review-tree-dir__label"><span class="review-tree-dir__icon"></span><span>{{ node.name }}</span></summary>
                    <template v-for="child in node.children" :key="child.key">
                      <details v-if="child.children" class="review-tree-dir" open style="padding-left:14px;">
                        <summary class="review-tree-dir__label"><span class="review-tree-dir__icon"></span><span>{{ child.name }}</span></summary>
                        <button
                          v-for="leaf in child.children"
                          :key="leaf.key"
                          type="button"
                          :class="['review-tree-file', reviewUi.reviewSelectedFile === leaf.path && 'review-tree-file--active']"
                          style="padding-left:28px;"
                          :title="leaf.path"
                          @click="onSelectFile(leaf.path)"
                        >
                          <span :class="changeTypeClass(leaf.changeType)">{{ changeTypeLabel(leaf.changeType) }}</span>
                          <span class="review-tree-file__name">{{ leaf.name }}</span>
                        </button>
                      </details>
                      <button v-else type="button" :class="['review-tree-file', reviewUi.reviewSelectedFile === child.path && 'review-tree-file--active']" style="padding-left:14px;" :title="child.path" @click="onSelectFile(child.path)">
                        <span :class="changeTypeClass(child.changeType)">{{ changeTypeLabel(child.changeType) }}</span>
                        <span class="review-tree-file__name">{{ child.name }}</span>
                      </button>
                    </template>
                  </details>
                  <button v-else type="button" :class="['review-tree-file', reviewUi.reviewSelectedFile === node.path && 'review-tree-file--active']" :title="node.path" @click="onSelectFile(node.path)">
                    <span :class="changeTypeClass(node.changeType)">{{ changeTypeLabel(node.changeType) }}</span>
                    <span class="review-tree-file__name">{{ node.name }}</span>
                  </button>
                </template>
              </div>
            </div>
            <div class="review-files-split__right">
              <template v-if="reviewUi.reviewFileDiffPreview">
                <div class="section-head" style="padding:0 6px;"><div><p class="eyebrow">Diff preview</p><h3>{{ reviewUi.reviewFileDiffPreview.path }}</h3></div></div>
                <DiffViewer v-if="reviewUi.reviewFileDiffPreview.diff" :diff="reviewUi.reviewFileDiffPreview.diff" />
                <p v-else class="git-card__hint" style="padding:6px;">{{ reviewUi.reviewFileDiffPreview.summary || 'No diff available.' }}</p>
              </template>
              <div v-else class="review-files-empty">
                <p class="eyebrow">Diff preview</p>
                <p class="git-card__hint">Click a file to see its diff. Resolve conflicts in your local worktree.</p>
              </div>
            </div>
          </div>
        </template>

        <!-- Agent panel -->
        <ReviewAgentTab
          v-else-if="activeTab === 'agent'"
          :pr-key="prKey"
          :workspace-id="workspaceId"
          :pull-request="pullRequest"
          :agent-prompts="agentPrompts"
          :mcp-command-line="mcpCommandLine"
          :review-ui="reviewUi"
        />
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, ref } from "vue";
import { useAppStore } from "../../stores/app.js";
import { useGitUiStore } from "../../stores/git-ui.js";
import { useReviewComments } from "../../composables/useReviewComments.js";
import PaneShell from "../layout/PaneShell.vue";
import DiffViewer from "./DiffViewer.vue";
import ReviewSummaryTab from "./azure/ReviewSummaryTab.vue";
import ReviewCommentsTab from "./azure/ReviewCommentsTab.vue";
import ReviewAgentTab from "./azure/ReviewAgentTab.vue";

const props = defineProps({
  workspaceId: { type: String, required: true },
  showHeader: { type: Boolean, default: false },
});

const appStore = useAppStore();
const gitUiStore = useGitUiStore();

// Data selectors
const workspace = computed(() =>
  (appStore.payload?.appState?.workspaces || []).find((ws) => ws.id === props.workspaceId),
);
const prKey = computed(() => workspace.value?.review?.prKey || "");
const detail = computed(() => appStore.payload?.azureDevops?.pullRequests?.[prKey.value] || null);
const pullRequest = computed(() => detail.value?.pullRequest || {});
const reviewBridgeRaw = computed(() => appStore.payload?.reviewBridge?.pullRequests?.[prKey.value] || {});
const reviewBridge = computed(() => ({
  ...reviewBridgeRaw.value,
  agentPrompts: appStore.payload?.reviewBridge?.agentPrompts || [],
}));
const reviewUi = computed(() => gitUiStore.get(props.workspaceId));
const checks = computed(() => detail.value?.checks || {});
const reviewers = computed(() => detail.value?.reviewerSummary?.reviewers || []);
const changedFiles = computed(() => {
  const files = detail.value?.changedFiles || [];
  return files.length ? files : (detail.value?.localChangedFiles || []);
});
const agentPrompts = computed(() => reviewBridge.value.agentPrompts || []);

// PR info
const prTitle = computed(() => pullRequest.value.title || `#${pullRequest.value.id || '?'}`);
const activeTab = computed(() => reviewUi.value.activeReviewTab || "summary");

// Sync state
const syncQueue = computed(() => reviewBridge.value.syncQueue || []);
const pendingSyncCount = computed(() =>
  syncQueue.value.filter((item) => item.status === "pending" || item.status === "failed").length,
);
const failedSyncItems = computed(() => syncQueue.value.filter((item) => item.status === "failed"));
const newCommentsCount = computed(() => detail.value?.newCommentsCount || 0);

// Comments (extracted to composable)
const {
  filteredThreads, filteredDraftComments, draftsByThread, draftsByComment,
  threadIndex, threadToCommentKey, filter, sort, searchTerm,
  isFiltered, totalCommentCount, allDrafts, hasClearable, sortOptions,
} = useReviewComments(detail, reviewBridge, reviewUi, pullRequest);

// Conflict info
const conflictInfo = computed(() => {
  const status = pullRequest.value.mergeStatus || "";
  const conflictStatuses = ["conflicts", "rejectedByPolicy", "renamedSourceBranch", "manualMergeRequired"];
  const hasConflicts = conflictStatuses.includes(status);
  return { hasConflicts, label: hasConflicts ? "Conflicts detected" : (status === "succeeded" ? "No conflicts" : `Status: ${status || "unknown"}`) };
});

// Tabs
const reviewTabs = computed(() => [
  { id: "summary", label: "Summary", count: null, alert: false },
  { id: "files", label: "Files", count: changedFiles.value.length, alert: false },
  { id: "comments", label: "Comments", count: totalCommentCount.value, alert: false },
  { id: "conflicts", label: "Conflicts", count: conflictInfo.value.hasConflicts ? changedFiles.value.length : 0, alert: conflictInfo.value.hasConflicts },
  { id: "agent", label: "Agent", count: null, alert: false },
]);

// MCP info for agent tab
const mcpCommandLine = computed(() => {
  const spec = reviewBridge.value.mcpServerSpec || {};
  const cmd = spec.command || "strideterm";
  const args = (spec.args || []).join(" ");
  const env = Object.entries(spec.env || {}).map(([k, v]) => `${k}=${v}`).join(" ");
  return [env, cmd, args].filter(Boolean).join(" ");
});

// Header
const headerStatus = computed(() => prTitle.value);
const headerActions = computed(() => [
  { className: "workspace-pane__icon-btn", action: "refresh-azure", title: "Refresh", label: "↻" },
]);

function onHeaderAction(action) {
  if (action.action === "refresh-azure") appStore.refreshAzure();
}

// Busy state for async toolbar actions
const busyAction = ref("");

async function handleRefresh() {
  busyAction.value = "refresh";
  try { await appStore.refreshAzure(); }
  finally { busyAction.value = ""; }
}

async function handleMarkSeen() {
  busyAction.value = "markSeen";
  try { await appStore.markAzurePrSeen(prKey.value); }
  finally { busyAction.value = ""; }
}

async function handlePublish() {
  busyAction.value = "publish";
  try { await appStore.syncReviewBridgePullRequest(prKey.value); }
  finally { busyAction.value = ""; }
}

// File tree builder — groups files by directory segments
const fileTree = computed(() => {
  const files = changedFiles.value;
  if (!files.length) return [];

  // Find common prefix to strip
  const paths = files.map((f) => String(f.path || "").replace(/^\//, "").split("/"));
  let prefix = 0;
  if (paths.length > 1) {
    outer: for (let i = 0; i < (paths[0]?.length || 0) - 1; i++) {
      const seg = paths[0][i];
      for (let j = 1; j < paths.length; j++) {
        if (paths[j][i] !== seg) break outer;
      }
      prefix = i + 1;
    }
  }

  // Build nested map
  const root = new Map();
  for (const file of files) {
    const segs = String(file.path || "").replace(/^\//, "").split("/").slice(prefix);
    let node = root;
    for (let i = 0; i < segs.length - 1; i++) {
      if (!node.has(segs[i])) node.set(segs[i], new Map());
      node = node.get(segs[i]);
    }
    node.set(segs.at(-1), file);
  }

  // Convert to array, collapsing single-child dirs
  function toArray(map, pathPrefix = "") {
    const result = [];
    for (const [name, value] of map) {
      if (value instanceof Map) {
        const items = toArray(value, pathPrefix ? `${pathPrefix}/${name}` : name);
        // Collapse dir with single child dir
        if (items.length === 1 && items[0].children) {
          result.push({ ...items[0], name: `${name}/${items[0].name}`, key: `${pathPrefix}/${name}` });
        } else {
          result.push({ name, key: `${pathPrefix}/${name}`, children: items });
        }
      } else {
        result.push({ name, key: value.path, path: value.path, changeType: value.changeType || "edit" });
      }
    }
    return result;
  }

  return toArray(root);
});

function onSelectFile(filePath) {
  // Strip leading / for git operations
  const normalized = String(filePath || "").replace(/^\//, "");
  // Pass the PR target branch so diff uses the correct base
  const targetBranch = stripRef(pullRequest.value.targetRefName || "");
  gitUiStore.reviewSelectFileDiff(props.workspaceId, normalized, targetBranch);
}

// Helpers
function stripRef(ref) { return String(ref || "").replace(/^refs\/heads\//, ""); }
function changeTypeClass(t) { return t === "add" ? "diff-add" : t === "delete" ? "diff-del" : "diff-meta"; }
function changeTypeLabel(t) { return t === "add" ? "A" : t === "delete" ? "D" : "M"; }

function openBrowser() {
  const url = pullRequest.value.webUrl || pullRequest.value.url || "";
  if (url) window.open(url, "_blank", "noopener,noreferrer");
}

function openAzureComment() {
  appStore.openDialog("TextAreaDialog", {
    eyebrow: "Review Bridge",
    title: "New comment",
    label: "Comment",
    placeholder: "Write your review comment...",
    submitLabel: "Create & queue",
    onSubmit: (content) => { appStore.createReviewBridgeDraftComment({ prKey: prKey.value, body: content, authorAgent: "human", autoQueue: true }); appStore.closeDialog(); },
  });
}
</script>
