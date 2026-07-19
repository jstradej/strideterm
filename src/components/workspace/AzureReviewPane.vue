<template>
  <div class="workspace-pane__body workspace-pane__body--git">
    <PaneShell
      v-if="showHeader"
      :title="`Review: ${prTitle}`"
      :status="headerStatus"
      :actions="headerActions"
      @action="onHeaderAction"
    />
    <PrePrWorkspaceView v-if="!detail && isPrePrWorkspace" :workspace-id="workspaceId" />
    <div v-else-if="!detail" class="terminal-empty">
      <p>Review workspace</p>
      <small>PR data is loading or not available.</small>
      <button
        type="button"
        class="button"
        style="margin-top: 12px"
        :disabled="busyAction === 'refresh'"
        @click="handleRefresh"
      >
        {{ busyAction === "refresh" ? "Refreshing…" : "Refresh" }}
      </button>
    </div>
    <div
      v-else
      :class="[
        'git-view',
        'review-shell',
        isMobile && menuOpen && 'review-shell--menu-open',
        isMobile && tabsMenuOpen && 'review-shell--tabs-menu-open',
      ]"
    >
      <button
        v-if="isMobile"
        type="button"
        class="review-shell__tabs-trigger"
        :aria-expanded="tabsMenuOpen"
        :aria-label="tabsMenuOpen ? 'Close tabs menu' : 'Open tabs menu'"
        @click="toggleTabsMenu"
      >
        <span class="review-shell__tabs-trigger__label">{{ activeReviewTabInfo.label }}</span>
        <span v-if="activeReviewTabInfo.count != null" class="azure-tab__count">{{ activeReviewTabInfo.count }}</span>
        <span class="review-shell__tabs-trigger__caret" aria-hidden="true">▼</span>
      </button>
      <button
        v-if="isMobile"
        type="button"
        class="review-shell__menu-trigger"
        :aria-expanded="menuOpen"
        :aria-label="menuOpen ? 'Close actions menu' : 'Open actions menu'"
        @click="toggleActionsMenu"
      >
        <span class="review-shell__menu-trigger__dot" aria-hidden="true">⋮</span>
        <span>{{ menuOpen ? "Close" : "Actions" }}</span>
      </button>
      <div
        v-if="isMobile && (menuOpen || tabsMenuOpen)"
        class="review-shell__menu-backdrop"
        aria-hidden="true"
        @click="closeAllMenus"
      ></div>

      <!-- Toolbar -->
      <div class="git-view__toolbar">
        <div class="git-view__summary">
          <span class="workspace-chip"
            ><strong>PR #{{ pullRequest.id }}</strong></span
          >
          <span class="workspace-chip">{{
            isGitHub ? detail.repository?.fullName : `${detail.project?.name} / ${detail.repository?.name}`
          }}</span>
          <span class="workspace-chip">{{ detail.role }}</span>
          <span v-if="checks.failedCount" class="workspace-chip workspace-chip--alert"
            >{{ checks.failedCount }} failed checks</span
          >
          <span v-if="checks.pendingCount" class="workspace-chip">{{ checks.pendingCount }} pending checks</span>
          <span v-if="detail.hasAttention" class="workspace-chip workspace-chip--alert">{{
            detail.attentionReason || "attention"
          }}</span>
          <span v-if="pendingSyncCount" class="workspace-chip">{{ pendingSyncCount }} queued drafts</span>
        </div>
        <div class="git-view__actions" style="margin-left: auto">
          <button
            type="button"
            :class="['button', 'button--ghost', busyAction === 'refresh' && 'button--busy']"
            :disabled="!!busyAction"
            :title="`Fetch the latest PR data from ${isGitHub ? 'GitHub' : 'Azure DevOps'}`"
            @click="handleRefresh"
          >
            {{ busyAction === "refresh" ? "Refreshing…" : "Refresh"
            }}<span v-if="newCommentsCount" class="azure-tab__count" style="margin-left: 4px">{{
              newCommentsCount
            }}</span>
          </button>
          <button
            type="button"
            :class="['button', busyAction === 'pushPublish' && 'button--busy']"
            :disabled="!!busyAction || (!pendingSyncCount && !aheadCount)"
            :title="`Push ${aheadCount} commit${aheadCount !== 1 ? 's' : ''} and publish ${pendingSyncCount} comment${pendingSyncCount !== 1 ? 's' : ''}`"
            @click="handlePushAndPublish"
          >
            {{ busyAction === "pushPublish" ? "Pushing & publishing…" : pushPublishLabel }}
          </button>
          <button
            type="button"
            :class="['button', 'button--ghost', busyAction === 'publish' && 'button--busy']"
            :disabled="!!busyAction || !pendingSyncCount"
            title="Publish queued drafts without pushing"
            @click="handlePublish"
          >
            {{ busyAction === "publish" ? "Publishing…" : "Publish only" }}
          </button>
          <button
            type="button"
            class="button button--ghost"
            title="Open this pull request in the browser"
            @click="openBrowser"
          >
            Browser
          </button>
        </div>
      </div>

      <!-- Toolbar success -->
      <div
        v-if="pushPublishSuccess"
        style="
          padding: 6px 12px;
          font-size: 12px;
          background: rgba(76, 175, 80, 0.08);
          border-bottom: 1px solid var(--border);
          display: flex;
          align-items: center;
          gap: 8px;
        "
      >
        <span style="color: var(--success, #4caf50); font-weight: 600">{{ pushPublishSuccess }}</span>
        <button
          type="button"
          class="button button--ghost"
          style="font-size: 10px; padding: 1px 8px; margin-left: auto"
          @click="pushPublishSuccess = ''"
        >
          Dismiss
        </button>
      </div>
      <!-- Toolbar error -->
      <div
        v-if="toolbarError"
        style="
          padding: 6px 12px;
          font-size: 12px;
          background: rgba(255, 80, 80, 0.08);
          border-bottom: 1px solid var(--border);
          display: flex;
          align-items: center;
          gap: 8px;
        "
      >
        <span style="color: var(--danger, #e53935)">{{ toolbarError }}</span>
        <button
          type="button"
          class="button button--ghost"
          style="font-size: 10px; padding: 1px 8px; margin-left: auto"
          @click="toolbarError = ''"
        >
          Dismiss
        </button>
      </div>

      <!-- Failed sync banner -->
      <div
        v-if="failedSyncItems.length"
        style="
          padding: 4px 12px;
          font-size: 11px;
          background: rgba(255, 80, 80, 0.08);
          border-bottom: 1px solid var(--border);
          display: flex;
          flex-wrap: wrap;
          gap: 6px;
          align-items: center;
        "
      >
        <span class="workspace-chip workspace-chip--alert" style="font-size: 10px">Sync failed</span>
        <span
          v-for="entry in failedSyncItems"
          :key="entry.queueId"
          style="color: var(--muted)"
          :title="entry.lastError || ''"
          >{{ entry.operation || "publish" }} · {{ entry.attempts || 0 }} attempt(s){{
            entry.lastError ? ` — ${entry.lastError.slice(0, 80)}` : ""
          }}</span
        >
        <button
          type="button"
          :class="['button', 'button--ghost', busyAction === 'publish' && 'button--busy']"
          style="font-size: 10px; padding: 1px 8px; margin-left: auto"
          :disabled="!!busyAction"
          title="Retry publishing the failed drafts to Azure DevOps"
          @click="handlePublish"
        >
          {{ busyAction === "publish" ? "Retrying…" : "Retry" }}
        </button>
      </div>

      <!-- Sub-tabs -->
      <div class="review-subtabs">
        <button
          v-for="tab in reviewTabs"
          :key="tab.id"
          type="button"
          :class="[
            'azure-tab',
            reviewUi.activeReviewTab === tab.id && 'azure-tab--active',
            tab.alert && 'azure-tab--alert',
          ]"
          @click="onReviewTabClick(tab.id)"
        >
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
              <div class="section-head" style="padding: 0 6px">
                <div>
                  <p class="eyebrow">Changed files</p>
                  <h3>{{ changedFiles.length }} files</h3>
                </div>
              </div>
              <div v-if="changedFiles.length" class="review-file-tree" style="margin-top: 8px">
                <ReviewFileTree
                  :files="changedFiles"
                  :selected-file="reviewUi.reviewSelectedFile"
                  @select-file="onSelectFile"
                />
              </div>
              <p v-else class="git-card__hint" style="padding: 6px">No changed files found.</p>
            </div>
            <div class="review-files-split__right">
              <div v-if="reviewUi.reviewFileDiffPreview" class="review-diff-toolbar">
                <div class="review-diff-toolbar__title" :title="reviewUi.reviewFileDiffPreview.path">
                  <p class="eyebrow review-diff-toolbar__path">{{ diffFileDir || "Diff" }}</p>
                  <h3 class="review-diff-toolbar__name">{{ diffFileName }}</h3>
                </div>
                <!-- 6.1: per-commit selector. The empty value is the
                     roll-up branch diff ("Final"); each commit option
                     scopes the Monaco view to that commit's changes only. -->
                <CustomSelect
                  v-model="reviewCommitFilter"
                  :options="commitFilterOptions"
                  class="review-diff-toolbar__commit-select"
                />
              </div>
              <ReviewFileDiffPreview
                :diff-preview="reviewUi.reviewFileDiffPreview"
                :monaco-payload="monacoDiffPayload"
                :monaco-loading="monacoDiffLoading"
                empty-hint="Click on a file in the list to view its diff."
              />
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
          :thread-fix-status="threadFixStatus"
          :filter="filter"
          :sort="sort"
          :sort-dir="sortDir"
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
                <div>
                  <p class="eyebrow">Merge Status</p>
                  <h3>{{ conflictInfo.label }}</h3>
                </div>
                <div class="docker-card__actions">
                  <button
                    type="button"
                    :class="['button', 'button--ghost', busyAction === 'refresh' && 'button--busy']"
                    :disabled="!!busyAction"
                    @click="handleRefresh"
                  >
                    {{ busyAction === "refresh" ? "Refreshing…" : "Refresh" }}
                  </button>
                </div>
              </div>
              <div style="display: flex; align-items: center; gap: 10px; padding: 8px 0">
                <span style="font-size: 1.2em; color: #6edfb6">✓</span>
                <p style="margin: 0">
                  <strong>{{ stripRef(pullRequest.sourceRefName) }}</strong> can be merged without conflicts into
                  <strong>{{ stripRef(pullRequest.targetRefName) }}</strong
                  >.
                </p>
              </div>
            </article>
          </div>

          <!-- Has conflicts — split layout like Files tab -->
          <div v-else class="review-files-split">
            <div class="review-files-split__left">
              <div class="review-conflict-banner review-conflict-banner--danger" style="margin: 0 0 8px">
                <span class="review-conflict-banner__icon">✗</span>
                <div>
                  <strong>{{ conflictInfo.label }}</strong>
                  <p class="review-conflict-banner__hint">
                    <code>{{ stripRef(pullRequest.sourceRefName) }}</code> &rarr;
                    <code>{{ stripRef(pullRequest.targetRefName) }}</code>
                  </p>
                </div>
              </div>
              <div class="section-head" style="padding: 0 6px">
                <div>
                  <p class="eyebrow">Affected files</p>
                  <h3>{{ changedFiles.length }} files</h3>
                </div>
              </div>
              <div v-if="changedFiles.length" class="review-file-tree" style="margin-top: 6px">
                <ReviewFileTree
                  :files="changedFiles"
                  :selected-file="reviewUi.reviewSelectedFile"
                  @select-file="onSelectFile"
                />
              </div>
            </div>
            <div class="review-files-split__right">
              <div v-if="reviewUi.reviewFileDiffPreview" class="section-head" style="padding: 0 6px">
                <div>
                  <p class="eyebrow">Diff preview</p>
                  <h3>{{ reviewUi.reviewFileDiffPreview.path }}</h3>
                </div>
              </div>
              <ReviewFileDiffPreview
                :diff-preview="reviewUi.reviewFileDiffPreview"
                :monaco-payload="monacoDiffPayload"
                :monaco-loading="monacoDiffLoading"
                empty-hint="Click a file to see its diff. Resolve conflicts in your local worktree."
              />
            </div>
          </div>
        </template>

        <!-- Pipelines panel -->
        <ReviewPipelinesTab
          v-else-if="activeTab === 'pipelines'"
          :checks="checks"
          :refreshing="refreshingChecks"
          :pr-key="prKey"
          :provider="reviewProvider"
          @refresh="handleRefreshChecks"
        />

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

<script setup lang="ts">
import { computed, ref, inject, watch } from "vue";
import { useAppStore } from "../../stores/app.js";
import { useGitUiStore } from "../../stores/git-ui.js";
import { useNotificationStore } from "../../stores/notifications.js";
import { useMobileShellMenus } from "../../composables/useMobileShellMenus.js";
import { useReviewComments } from "../../composables/useReviewComments.js";
import { useResourceInterest } from "../../composables/useResourceInterest.js";
import PaneShell from "../layout/PaneShell.vue";
import ReviewSummaryTab from "./azure/ReviewSummaryTab.vue";
import ReviewCommentsTab from "./azure/ReviewCommentsTab.vue";
import ReviewAgentTab from "./azure/ReviewAgentTab.vue";
import ReviewPipelinesTab from "./shared/ReviewPipelinesTab.vue";
import ReviewFileTree from "./azure/ReviewFileTree.vue";
import ReviewFileDiffPreview from "./azure/ReviewFileDiffPreview.vue";
import PrePrWorkspaceView from "./azure/PrePrWorkspaceView.vue";
import CustomSelect from "../common/CustomSelect.vue";

const props = withDefaults(defineProps<{ workspaceId: string; showHeader?: boolean }>(), { showHeader: false });

const appStore = useAppStore();
const gitUiStore = useGitUiStore();
const notifications = useNotificationStore();
const {
  isMobile,
  menuOpen,
  tabsMenuOpen,
  toggleActionsMenu,
  toggleTabsMenu,
  closeAllMenus,
  onTabClick: onReviewTabClick,
} = useMobileShellMenus({
  onSelectTab: (id) => gitUiStore.reviewSwitchTab(props.workspaceId, id),
});

// Data selectors
const workspace = computed(() =>
  (appStore.payload?.appState?.workspaces || []).find((ws) => ws.id === props.workspaceId),
);
const prKey = computed(() => workspace.value?.review?.prKey || "");
const reviewProvider = computed(() => workspace.value?.review?.provider || "azure-devops");
const isGitHub = computed(() => reviewProvider.value === "github");
const detail = computed(() => {
  const key = prKey.value;
  if (!key) return null;
  if (isGitHub.value) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const raw = (appStore.providerPrDetail("github", key) as any) || null;
    if (!raw) return null;
    // Merge issueComments into threads so useReviewComments sees them
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const issueThreads = (raw.issueComments || []).map((c: any) => ({
      id: c.id,
      status: "active",
      isDeleted: false,
      filePath: "",
      lineStart: null,
      lineEnd: null,
      publishedDate: c.createdAt || null,
      lastUpdatedDate: c.updatedAt || c.createdAt || null,
      comments: [
        {
          id: c.id,
          parentCommentId: 0,
          content: c.body || "",
          publishedDate: c.createdAt || null,
          lastUpdatedDate: c.updatedAt || null,
          commentType: "text",
          author: c.author || {},
        },
      ],
    }));
    return { ...raw, threads: [...(raw.threads || []), ...issueThreads] };
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (appStore.providerPrDetail("azure", key) as any) || null;
});
const pullRequestRaw = computed(() => detail.value?.pullRequest || {});
const pullRequest = computed(() => {
  const pr = pullRequestRaw.value;
  if (isGitHub.value) {
    return {
      ...pr,
      id: pr.number || pr.id,
      isDraft: pr.draft || pr.isDraft,
    };
  }
  return pr;
});
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const reviewBridge = computed(() => (appStore.reviewBridgePr(prKey.value) as any) || {});
// Fetch + keep the PR detail, review-bridge context AND the workspace's git
// snapshot (the pane renders the branch log) current while this pane — which
// handles both Azure and GitHub reviews — is mounted.
useResourceInterest(() => {
  // The Agent tab renders the global agent-prompts list — declare interest in it
  // so a prompt reset/edit invalidates and refetches while the pane is mounted.
  const keys: string[] = ["agent-prompts"];
  if (props.workspaceId) keys.push(`git:${props.workspaceId}`);
  const key = prKey.value;
  if (key) keys.push(isGitHub.value ? `github-pr:${key}` : `azure-pr:${key}`, `review-bridge:${key}`);
  return keys;
});
const reviewUi = computed(() => gitUiStore.get(props.workspaceId));
const checks = computed(() => detail.value?.checks || {});
const refreshingChecks = ref(false);
async function handleRefreshChecks() {
  refreshingChecks.value = true;
  try {
    await notifications.runWithToast("Refresh checks failed", () =>
      isGitHub.value ? appStore.refreshGitHub() : appStore.refreshAzure(),
    );
  } finally {
    refreshingChecks.value = false;
  }
}
const reviewers = computed(() => detail.value?.reviewerSummary?.reviewers || []);
const changedFiles = computed(() => {
  const files = detail.value?.changedFiles || [];
  return files.length ? files : detail.value?.localChangedFiles || [];
});
// agentPrompts are NOT in the slim core (Phase 2) — on remote they arrive with
// the review-bridge detail resource; on desktop from the full payload. The store
// accessor reads whichever applies for this transport.
const agentPrompts = computed(() => appStore.reviewAgentPrompts(prKey.value));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const gitSnapshot = computed(() => appStore.getGitSnapshot(props.workspaceId) as Record<string, any> | null);
const aheadCount = computed(() => gitSnapshot.value?.aheadCount || 0);

// --- Pre-PR (new branch) state ---
const isPrePrWorkspace = computed(
  () => !workspace.value?.review?.prKey && ["azure-devops", "github"].includes(workspace.value?.review?.provider || ""),
);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const api = inject<any>("api");

function openExternal(url: string) {
  if (api?.openExternal) api.openExternal(url);
  else window.open(url, "_blank");
}

const pushPublishLabel = computed(() => {
  const parts = [];
  if (aheadCount.value > 0) parts.push(`Push (${aheadCount.value})`);
  else parts.push("Push");
  if (pendingSyncCount.value > 0) parts.push(`publish (${pendingSyncCount.value})`);
  else parts.push("publish");
  return parts.join(" & ");
});

// PR info
const prTitle = computed(() => pullRequest.value.title || `#${pullRequest.value.id || "?"}`);
const activeTab = computed(() => reviewUi.value.activeReviewTab || "summary");

// Sync state
const syncQueue = computed(() => reviewBridge.value.syncQueue || []);
const pendingSyncCount = computed(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  () => syncQueue.value.filter((item: any) => item.status === "pending" || item.status === "failed").length,
);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const failedSyncItems = computed(() => syncQueue.value.filter((item: any) => item.status === "failed"));
const newCommentsCount = computed(() => detail.value?.newCommentsCount || 0);

// Comments (extracted to composable)
const {
  filteredThreads,
  filteredDraftComments,
  draftsByThread,
  draftsByComment,
  threadIndex,
  threadToCommentKey,
  threadFixStatus,
  filter,
  sort,
  sortDir,
  searchTerm,
  isFiltered,
  totalCommentCount,
  activeCommentCount,
  allDrafts,
  hasClearable,
  sortOptions,
} = useReviewComments(detail, reviewBridge, reviewUi, pullRequest);

// Conflict info
const conflictInfo = computed(() => {
  const status = pullRequest.value.mergeStatus || "";
  const conflictStatuses = ["conflicts", "rejectedByPolicy", "renamedSourceBranch", "manualMergeRequired"];
  const hasConflicts = conflictStatuses.includes(status);
  return {
    hasConflicts,
    label: hasConflicts
      ? "Conflicts detected"
      : status === "succeeded"
        ? "No conflicts"
        : `Status: ${status || "unknown"}`,
  };
});

// Tabs
const reviewTabs = computed(() => [
  { id: "summary", label: "Summary", count: null, alert: false },
  { id: "files", label: "Files", count: changedFiles.value.length, alert: false },
  { id: "comments", label: "Comments", count: activeCommentCount.value || null, alert: false },
  {
    id: "conflicts",
    label: "Conflicts",
    count: conflictInfo.value.hasConflicts ? changedFiles.value.length : 0,
    alert: conflictInfo.value.hasConflicts,
  },
  {
    id: "pipelines",
    label: "Pipelines",
    count: (checks.value.failedCount || 0) + (checks.value.pendingCount || 0) || null,
    alert: (checks.value.failedCount || 0) > 0,
  },
  { id: "agent", label: "Agent", count: null, alert: false },
]);

const activeReviewTabInfo = computed(
  () => reviewTabs.value.find((t) => t.id === activeTab.value) || reviewTabs.value[0],
);

// MCP info for agent tab
const mcpCommandLine = computed(() => {
  const spec = reviewBridge.value.mcpServerSpec || {};
  const cmd = spec.command || "strideterm";
  const args = (spec.args || []).join(" ");
  const env = Object.entries(spec.env || {})
    .map(([k, v]) => `${k}=${v}`)
    .join(" ");
  return [env, cmd, args].filter(Boolean).join(" ");
});

// Header
const headerStatus = computed(() => prTitle.value);
const headerActions = computed(() => [
  {
    className: "workspace-pane__icon-btn",
    action: isGitHub.value ? "refresh-github" : "refresh-azure",
    title: "Refresh",
    label: "↻",
  },
]);

function onHeaderAction(action: { action: string }) {
  if (action.action === "refresh-azure") appStore.refreshAzure();
  if (action.action === "refresh-github") appStore.refreshGitHub();
}

// Auto-refresh when the Review pane becomes the active view.
//
// In-flight guard: a remote refresh hits Azure DevOps / GitHub and can take
// many seconds (a slow poll through a tunnel even times out at the gateway).
// activeViewId can fire repeatedly — e.g. while the view briefly churns — and
// without this guard each fire stacked another refresh, piling up requests
// that all eventually 524'd. Skip if one is already running.
const autoRefreshInFlight = ref(false);
watch(
  () => appStore.activeViewId,
  async (viewId) => {
    if (viewId !== `review:${props.workspaceId}`) return;
    if (autoRefreshInFlight.value) return;
    autoRefreshInFlight.value = true;
    try {
      if (isGitHub.value) {
        await appStore.refreshGitHub();
        if (prKey.value) appStore.markGitHubPrSeen(prKey.value);
      } else {
        await appStore.refreshAzure();
        if (prKey.value) appStore.markAzurePrSeen(prKey.value);
      }
    } catch {
      // Auto-refresh is best-effort. A failed poll (offline, the desktop/local
      // server restarting, a 5xx through the tunnel) must NOT throw out of this
      // watch: an unhandled rejection here trips the ErrorBoundary, which
      // remounts this pane, which re-fires this immediate watch → a crash-loop
      // that also churns the visible-tab set (terminal mounts/unmounts on every
      // cycle). Swallow; the toolbar refresh surfaces errors when the user asks.
    } finally {
      autoRefreshInFlight.value = false;
    }
  },
  { immediate: true },
);

// Busy state for async toolbar actions
const busyAction = ref<string>("");

async function handleRefresh() {
  busyAction.value = "refresh";
  try {
    await notifications.runWithToast("Refresh failed", async () => {
      if (isGitHub.value) {
        await appStore.refreshGitHub();
        if (prKey.value) await appStore.markGitHubPrSeen(prKey.value);
      } else {
        await appStore.refreshAzure();
        if (prKey.value) await appStore.markAzurePrSeen(prKey.value);
      }
    });
  } finally {
    busyAction.value = "";
  }
}

const toolbarError = ref<string>("");

const pushPublishSuccess = ref<string>("");

async function handlePushAndPublish() {
  busyAction.value = "pushPublish";
  toolbarError.value = "";
  pushPublishSuccess.value = "";
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result: any = await appStore.pushAndPublishReview(props.workspaceId);
    const commits = result?.commitCount || 0;
    const published = result?.publishedCount || 0;
    const pubError = result?.publishError || "";
    const parts = [];
    if (commits > 0) parts.push(`${commits} commit${commits !== 1 ? "s" : ""} pushed`);
    else parts.push("Push completed (no new commits)");
    if (published > 0) parts.push(`${published} comment${published !== 1 ? "s" : ""} published`);
    pushPublishSuccess.value = parts.join(", ") + ".";
    if (pubError) {
      // Push succeeded but some comments failed — show both success and error
      toolbarError.value = `Push succeeded, but publishing failed: ${pubError}`;
    }
  } catch (error) {
    // Push itself failed (before any publishing)
    toolbarError.value = (error as Error)?.message || String(error || "Push failed.");
  } finally {
    busyAction.value = "";
  }
}

async function handlePublish() {
  busyAction.value = "publish";
  toolbarError.value = "";
  pushPublishSuccess.value = "";
  try {
    await appStore.syncReviewBridgePullRequest(prKey.value);
  } catch (error) {
    toolbarError.value = (error as Error)?.message || String(error || "Publish failed.");
  } finally {
    busyAction.value = "";
  }
}

// --- Monaco diff state for the review Files tab ---
// We mirror GitChangesTab/GitHistoryTab: load raw left/right content via
// fileGitDiff and feed it to MonacoDiffPanel for word-level diff, side-by-
// side view, change navigation. The unified-text DiffViewer fallback is
// kept around as a safety net for environments where Monaco fails to load.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const monacoDiffPayload = ref<Record<string, any> | null>(null);
const monacoDiffLoading = ref(false);
let monacoDiffSeq = 0;

// When set, we render the per-commit diff for the selected commit instead of
// the rolled-up branch diff. The user requested both views (final state +
// per-commit) on item 6.1.
const reviewCommitFilter = ref<string>("");

const reviewDiffMode = computed<"branch" | "commit">(() => (reviewCommitFilter.value ? "commit" : "branch"));

// Split the diff preview path into "directory" + "file name" so the toolbar
// can show the file name prominently and the directory in a smaller eyebrow.
// Repeating the full path inline made the toolbar wrap to two rows when the
// path was long; splitting + truncating keeps it on one row.
//
// PR/git diff paths normally use forward slashes regardless of OS, but a
// path produced by file-manager on Windows can ride in with `\` separators
// (or mixed). Find the last separator of either flavor.
function lastPathSepIndex(s: string): number {
  return Math.max(s.lastIndexOf("/"), s.lastIndexOf("\\"));
}
const diffFileName = computed(() => {
  const p = String(reviewUi.value?.reviewFileDiffPreview?.path || "");
  const idx = lastPathSepIndex(p);
  return idx >= 0 ? p.slice(idx + 1) : p;
});
const diffFileDir = computed(() => {
  const p = String(reviewUi.value?.reviewFileDiffPreview?.path || "");
  const idx = lastPathSepIndex(p);
  if (idx <= 0) return "";
  // Drop any leading slash/backslash so the eyebrow doesn't start with one.
  return p.slice(0, idx).replace(/^[/\\]+/, "");
});

// Commits that introduced changes inside the PR. We surface each in the
// Monaco toolbar's commit selector so the reviewer can flip between final
// state and per-commit context (6.1).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const changedFileCommits = computed<any[]>(() => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const log: any[] = (gitSnapshot.value?.log || []) as any[];
  const ahead = Number(gitSnapshot.value?.aheadCount || 0);
  if (ahead > 0) return log.slice(0, ahead);
  return log.slice(0, 12);
});

const commitFilterOptions = computed(() => {
  const target = stripRef(pullRequest.value?.targetRefName || "") || "base";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const commits = changedFileCommits.value.map((c: any) => ({
    value: String(c.shortHash || ""),
    label: `${String(c.shortHash || "").slice(0, 8)} — ${String(c.subject || "").slice(0, 60)}`,
  }));
  return [{ value: "", label: `Final — vs ${target}` }, ...commits];
});

async function loadMonacoReviewDiff(filePath: string) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const w = workspace.value as any;
  const rootPath = w?.cwd || (w?.gitRoots?.[0] ?? "");
  if (!rootPath || !filePath) {
    monacoDiffPayload.value = null;
    return;
  }
  const seq = ++monacoDiffSeq;
  monacoDiffLoading.value = true;
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const api = appStore.getApi() as any;
    let payload;
    if (reviewDiffMode.value === "commit") {
      payload = await api.fileCommitDiff({ rootPath, relativePath: filePath, hash: reviewCommitFilter.value });
    } else {
      const targetBranch = stripRef(pullRequest.value.targetRefName || "");
      const ref = targetBranch ? `origin/${targetBranch}` : "HEAD";
      payload = await api.fileGitDiff({ rootPath, relativePath: filePath, source: "branch", revisionRef: ref });
    }
    if (seq !== monacoDiffSeq) return;
    monacoDiffPayload.value = payload || null;
  } catch (err) {
    if (seq !== monacoDiffSeq) return;
    monacoDiffPayload.value = {
      ok: false,
      leftError: (err as Error)?.message || "Failed to load diff",
      leftContent: "",
      rightContent: "",
      leftLabel: "",
      rightLabel: "",
      leftMissing: true,
      rightMissing: true,
      language: "plaintext",
    };
  } finally {
    if (seq === monacoDiffSeq) monacoDiffLoading.value = false;
  }
}

function onSelectFile(filePath: string) {
  // Strip leading / for git operations
  const normalized = String(filePath || "").replace(/^\//, "");
  // Pass the PR target branch so the legacy unified-diff fallback uses the
  // correct base.
  const targetBranch = stripRef(pullRequest.value.targetRefName || "");
  gitUiStore.reviewSelectFileDiff(props.workspaceId, normalized, targetBranch);
  loadMonacoReviewDiff(normalized);
}

watch(reviewCommitFilter, () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sel = (reviewUi.value as any)?.reviewSelectedFile;
  if (sel) loadMonacoReviewDiff(String(sel).replace(/^\//, ""));
});

// Helpers
function stripRef(ref: unknown) {
  return String(ref || "").replace(/^refs\/heads\//, "");
}
function openBrowser() {
  const url = pullRequest.value.webUrl || pullRequest.value.url || "";
  if (url) openExternal(url);
}

function openAzureComment() {
  appStore.openDialog("TextAreaDialog", {
    eyebrow: "Review Bridge",
    title: "New comment",
    label: "Comment",
    placeholder: "Write your review comment...",
    submitLabel: "Create & queue",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    onSubmit: (content: any) => {
      appStore.createReviewBridgeDraftComment({
        prKey: prKey.value,
        body: content,
        authorAgent: "human",
        autoQueue: true,
      });
      appStore.closeDialog();
    },
  });
}
</script>
