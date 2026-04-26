<template>
  <div class="workspace-pane__body workspace-pane__body--git">
    <PaneShell
      v-if="showHeader"
      :title="`Review: ${prTitle}`"
      :status="headerStatus"
      :actions="headerActions"
      @action="onHeaderAction"
    />
    <div v-if="!detail && isPrePrWorkspace" class="git-view review-shell" style="overflow-y: auto">
      <div style="padding: 16px 20px; max-width: 720px">
        <div class="section-head">
          <div>
            <p class="eyebrow">New Branch</p>
            <h3>{{ gitSnapshot?.branch || "Working branch" }}</h3>
          </div>
          <button
            type="button"
            class="button button--ghost button--small"
            :disabled="busyAction === 'refresh'"
            @click="handleRefresh"
          >
            {{ busyAction === "refresh" ? "Refreshing…" : "↻ Refresh" }}
          </button>
        </div>

        <!-- Workflow steps -->
        <div style="margin-top: 16px; display: grid; gap: 8px">
          <div :class="['nb-step', hasDirtyOrCommits && 'nb-step--done', !hasDirtyOrCommits && 'nb-step--active']">
            <span class="nb-step__check">{{ hasDirtyOrCommits ? "\u2705" : "\u2B1C" }}</span>
            <div>
              <strong>1. Implement your changes</strong>
              <p>Use the terminal tabs to write code, run tests, and verify your work.</p>
            </div>
          </div>
          <div
            :class="['nb-step', hasCommits && 'nb-step--done', hasDirtyOrCommits && !hasCommits && 'nb-step--active']"
          >
            <span class="nb-step__check">{{ hasCommits ? "\u2705" : "\u2B1C" }}</span>
            <div>
              <strong>2. Commit your changes</strong>
              <p>
                {{
                  gitSnapshot?.dirty
                    ? `You have ${gitSnapshot.dirtyCount} uncommitted file(s).`
                    : hasCommits
                      ? `${gitSnapshot?.aheadCount || 0} commit(s) ready to push.`
                      : "Working tree is clean. Make some changes first."
                }}
              </p>
            </div>
          </div>
          <div :class="['nb-step', hasCommits && 'nb-step--active']">
            <span class="nb-step__check">{{ "\u2B1C" }}</span>
            <div>
              <strong>3. Create a pull request</strong>
              <p>
                {{
                  hasCommits
                    ? "Fill in the form below and create your PR."
                    : "Commit your changes first, then create a PR."
                }}
              </p>
            </div>
          </div>
        </div>

        <!-- Commits -->
        <div v-if="hasCommits" style="margin-top: 20px">
          <p class="eyebrow">Commits ({{ gitSnapshot?.aheadCount || 0 }} ahead of base)</p>
          <div style="margin-top: 6px">
            <GitCommitLog :commits="recentCommits" :ahead-count="gitSnapshot?.aheadCount || 0" selected-commit="" />
          </div>
        </div>

        <!-- PR creation form -->
        <div style="margin-top: 20px; border-top: 1px solid var(--border); padding-top: 16px">
          <p class="eyebrow">Create Pull Request</p>
          <h3 style="margin-top: 4px">
            {{ gitSnapshot?.branch || "?" }} &rarr; {{ prFormTarget || baseBranch || "?" }}
          </h3>
          <div class="git-pr-form" style="margin-top: 12px">
            <label class="git-pr-form__field">
              <span class="git-pr-form__label">Source branch</span>
              <input class="git-pr-form__input" type="text" :value="gitSnapshot?.branch || ''" disabled />
            </label>
            <label class="git-pr-form__field">
              <span class="git-pr-form__label">Target branch</span>
              <CustomSelect
                v-model="prFormTarget"
                class="git-branch-select"
                placeholder="-- select target --"
                :options="prFormTargetOptions"
              />
              <button
                v-if="!prFormLoadingBranches"
                type="button"
                class="button button--ghost button--small"
                style="margin-left: 6px"
                @click="loadPrBranches"
              >
                Load remote branches
              </button>
              <span v-else style="font-size: 12px; color: var(--muted); margin-left: 6px">Loading...</span>
            </label>
            <label class="git-pr-form__field">
              <span class="git-pr-form__label">Title</span>
              <input v-model="prFormTitle" class="git-pr-form__input" type="text" placeholder="Pull request title" />
            </label>
            <label class="git-pr-form__field">
              <span class="git-pr-form__label">Description</span>
              <textarea
                v-model="prFormDescription"
                class="git-pr-form__input git-pr-form__textarea"
                placeholder="Optional description"
                rows="4"
              ></textarea>
            </label>
            <label class="git-pr-form__field" style="flex-direction: row; align-items: center; gap: 8px">
              <input v-model="prFormDraft" type="checkbox" />
              <span>Create as draft</span>
            </label>
            <div class="git-operation-actions">
              <button type="button" class="button" :disabled="!prFormCanSubmit || prFormBusy" @click="handleCreatePr">
                {{ prFormBusy ? "Creating…" : prFormDraft ? "Create Draft Pull Request" : "Create Pull Request" }}
              </button>
            </div>
            <p v-if="prFormResult" :class="['git-card__hint', prFormResult.ok ? '' : 'git-card__hint--warning']">
              {{ prFormResult.summary }}
              <a
                v-if="prFormResult.url"
                :href="prFormResult.url"
                style="color: var(--accent); text-decoration: underline"
                @click.prevent="openExternal(prFormResult.url)"
                >Open in browser</a
              >
            </p>
          </div>
        </div>
      </div>
    </div>
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
    <div v-else class="git-view review-shell">
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
          @click="gitUiStore.reviewSwitchTab(workspaceId, tab.id)"
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
                <template v-for="node in fileTree" :key="node.key">
                  <details v-if="node.children" class="review-tree-dir" open>
                    <summary class="review-tree-dir__label">
                      <span class="review-tree-dir__icon"></span><span>{{ node.name }}</span>
                    </summary>
                    <template v-for="child in node.children" :key="child.key">
                      <details v-if="child.children" class="review-tree-dir" open style="padding-left: 14px">
                        <summary class="review-tree-dir__label">
                          <span class="review-tree-dir__icon"></span><span>{{ child.name }}</span>
                        </summary>
                        <button
                          v-for="leaf in child.children"
                          :key="leaf.key"
                          type="button"
                          :class="[
                            'review-tree-file',
                            reviewUi.reviewSelectedFile === leaf.path && 'review-tree-file--active',
                          ]"
                          style="padding-left: 28px"
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
                        :class="[
                          'review-tree-file',
                          reviewUi.reviewSelectedFile === child.path && 'review-tree-file--active',
                        ]"
                        style="padding-left: 14px"
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
                    :class="[
                      'review-tree-file',
                      reviewUi.reviewSelectedFile === node.path && 'review-tree-file--active',
                    ]"
                    :title="node.path"
                    @click="onSelectFile(node.path)"
                  >
                    <span :class="changeTypeClass(node.changeType)">{{ changeTypeLabel(node.changeType) }}</span>
                    <span class="review-tree-file__name">{{ node.name }}</span>
                  </button>
                </template>
              </div>
              <p v-else class="git-card__hint" style="padding: 6px">No changed files found.</p>
            </div>
            <div class="review-files-split__right">
              <template v-if="reviewUi.reviewFileDiffPreview">
                <div class="section-head" style="padding: 0 6px">
                  <div>
                    <p class="eyebrow">Diff preview</p>
                    <h3>{{ reviewUi.reviewFileDiffPreview.path }}</h3>
                  </div>
                </div>
                <DiffViewer v-if="reviewUi.reviewFileDiffPreview.diff" :diff="reviewUi.reviewFileDiffPreview.diff" />
                <p v-else class="git-card__hint" style="padding: 6px">
                  {{ reviewUi.reviewFileDiffPreview.summary || "No diff available." }}
                </p>
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
                <template v-for="node in fileTree" :key="node.key">
                  <details v-if="node.children" class="review-tree-dir" open>
                    <summary class="review-tree-dir__label">
                      <span class="review-tree-dir__icon"></span><span>{{ node.name }}</span>
                    </summary>
                    <template v-for="child in node.children" :key="child.key">
                      <details v-if="child.children" class="review-tree-dir" open style="padding-left: 14px">
                        <summary class="review-tree-dir__label">
                          <span class="review-tree-dir__icon"></span><span>{{ child.name }}</span>
                        </summary>
                        <button
                          v-for="leaf in child.children"
                          :key="leaf.key"
                          type="button"
                          :class="[
                            'review-tree-file',
                            reviewUi.reviewSelectedFile === leaf.path && 'review-tree-file--active',
                          ]"
                          style="padding-left: 28px"
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
                        :class="[
                          'review-tree-file',
                          reviewUi.reviewSelectedFile === child.path && 'review-tree-file--active',
                        ]"
                        style="padding-left: 14px"
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
                    :class="[
                      'review-tree-file',
                      reviewUi.reviewSelectedFile === node.path && 'review-tree-file--active',
                    ]"
                    :title="node.path"
                    @click="onSelectFile(node.path)"
                  >
                    <span :class="changeTypeClass(node.changeType)">{{ changeTypeLabel(node.changeType) }}</span>
                    <span class="review-tree-file__name">{{ node.name }}</span>
                  </button>
                </template>
              </div>
            </div>
            <div class="review-files-split__right">
              <template v-if="reviewUi.reviewFileDiffPreview">
                <div class="section-head" style="padding: 0 6px">
                  <div>
                    <p class="eyebrow">Diff preview</p>
                    <h3>{{ reviewUi.reviewFileDiffPreview.path }}</h3>
                  </div>
                </div>
                <DiffViewer v-if="reviewUi.reviewFileDiffPreview.diff" :diff="reviewUi.reviewFileDiffPreview.diff" />
                <p v-else class="git-card__hint" style="padding: 6px">
                  {{ reviewUi.reviewFileDiffPreview.summary || "No diff available." }}
                </p>
              </template>
              <div v-else class="review-files-empty">
                <p class="eyebrow">Diff preview</p>
                <p class="git-card__hint">Click a file to see its diff. Resolve conflicts in your local worktree.</p>
              </div>
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
import { useReviewComments } from "../../composables/useReviewComments.js";
import PaneShell from "../layout/PaneShell.vue";
import DiffViewer from "./DiffViewer.vue";
import GitCommitLog from "./git/GitCommitLog.vue";
import ReviewSummaryTab from "./azure/ReviewSummaryTab.vue";
import ReviewCommentsTab from "./azure/ReviewCommentsTab.vue";
import ReviewAgentTab from "./azure/ReviewAgentTab.vue";
import ReviewPipelinesTab from "./shared/ReviewPipelinesTab.vue";
import CustomSelect from "../common/CustomSelect.vue";

const props = withDefaults(defineProps<{ workspaceId: string; showHeader?: boolean }>(), { showHeader: false });

const appStore = useAppStore();
const gitUiStore = useGitUiStore();

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
    const raw = (appStore.payload?.github as any)?.pullRequests?.[key] || null;
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
  return (appStore.payload?.azureDevops as any)?.pullRequests?.[key] || null;
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
const reviewBridgeRaw = computed(() => (appStore.payload?.reviewBridge as any)?.pullRequests?.[prKey.value] || {});
const reviewBridge = computed(() => ({
  ...reviewBridgeRaw.value,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  agentPrompts: (appStore.payload?.reviewBridge as any)?.agentPrompts || [],
}));
const reviewUi = computed(() => gitUiStore.get(props.workspaceId));
const checks = computed(() => detail.value?.checks || {});
const refreshingChecks = ref(false);
async function handleRefreshChecks() {
  refreshingChecks.value = true;
  try {
    if (isGitHub.value) {
      await appStore.refreshGitHub();
    } else {
      await appStore.refreshAzure();
    }
  } finally {
    refreshingChecks.value = false;
  }
}
const reviewers = computed(() => detail.value?.reviewerSummary?.reviewers || []);
const changedFiles = computed(() => {
  const files = detail.value?.changedFiles || [];
  return files.length ? files : detail.value?.localChangedFiles || [];
});
const agentPrompts = computed(() => reviewBridge.value.agentPrompts || []);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const gitSnapshot = computed(() => appStore.getGitSnapshot(props.workspaceId) as Record<string, any> | null);
const aheadCount = computed(() => gitSnapshot.value?.aheadCount || 0);

// --- Pre-PR (new branch) state ---
const isPrePrWorkspace = computed(
  () =>
    !workspace.value?.review?.prKey &&
    ["azure-devops", "github"].includes(workspace.value?.review?.provider || ""),
);
const baseBranch = computed(() => workspace.value?.quickfix?.baseBranch || "");
const hasDirtyOrCommits = computed(() => !!(gitSnapshot.value?.dirty || (gitSnapshot.value?.aheadCount || 0) > 0));
const hasCommits = computed(() => (gitSnapshot.value?.aheadCount || 0) > 0);
const recentCommits = computed(() => {
  const log = gitSnapshot.value?.log || [];
  return log;
});
const aheadCommits = computed(() => {
  const log = gitSnapshot.value?.log || [];
  const ahead = gitSnapshot.value?.aheadCount || 0;
  return log.slice(0, ahead);
});

const prFormTarget = ref<string>("");
const prFormTitle = ref<string>("");
const prFormDescription = ref<string>("");
const prFormBranches = ref<string[]>([]);
const prFormLoadingBranches = ref(false);
const prFormBusy = ref(false);
const prFormResult = ref<{ ok: boolean; summary: string; url?: string } | null>(null);
const prFormDraft = ref(false);
let prFormAutoFilled = false;

const prFormCanSubmit = computed(() => prFormTarget.value && prFormTitle.value.trim());

const prFormTargetOptions = computed(() => prFormBranches.value.map((b) => ({ value: b, label: b })));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const api = inject<any>("api");

function generatePrTitleAndDescription() {
  if (prFormAutoFilled) return;
  const commits = aheadCommits.value;
  if (!commits.length) return;

  if (commits.length === 1) {
    // Single commit: use subject as title
    prFormTitle.value = commits[0].subject || "";
  } else {
    // Multiple commits: use branch name as title, list commits as description
    const branch = gitSnapshot.value?.branch || "";
    // Try to extract meaningful name from branch (e.g., "fix/MSP-12345-some-description" → "MSP-12345 some description")
    const branchSuffix = branch.includes("/") ? branch.split("/").slice(1).join("/") : branch;
    prFormTitle.value = branchSuffix.replace(/[-_]/g, " ").replace(/\s+/g, " ").trim();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    prFormDescription.value = commits.map((c: any) => `- ${c.subject}`).join("\n");
  }
  prFormAutoFilled = true;
}

async function loadPrBranches() {
  prFormLoadingBranches.value = true;
  try {
    const listFn = isGitHub.value ? api.githubListRemoteBranches : api.azureListRemoteBranches;
    const result = await listFn({ workspaceId: props.workspaceId });
    prFormBranches.value = result.branches || [];
    if (!prFormTarget.value) {
      prFormTarget.value =
        prFormBranches.value.find((b) => b === baseBranch.value) ||
        prFormBranches.value.find((b) => b === "develop") ||
        prFormBranches.value.find((b) => b === "main") ||
        prFormBranches.value[0] ||
        "";
    }
    generatePrTitleAndDescription();
  } catch {
    prFormBranches.value = [];
  } finally {
    prFormLoadingBranches.value = false;
  }
}

// Auto-load branches when pre-PR view is active
watch(
  isPrePrWorkspace,
  (active) => {
    if (active && !prFormBranches.value.length) {
      loadPrBranches();
    }
  },
  { immediate: true },
);

// Auto-generate title when commits change
watch(aheadCommits, () => {
  if (isPrePrWorkspace.value && !prFormAutoFilled) {
    generatePrTitleAndDescription();
  }
});

async function handleCreatePr() {
  if (!prFormCanSubmit.value || prFormBusy.value) return;
  prFormBusy.value = true;
  prFormResult.value = null;
  try {
    // Check for unpushed commits
    if (aheadCount.value > 0) {
      const pushConfirmed = window.confirm(
        `You have ${aheadCount.value} unpushed commit(s). Push to remote before creating the PR?`,
      );
      if (!pushConfirmed) {
        prFormResult.value = { ok: false, summary: "Push your commits to remote first, then try again." };
        return;
      }
      if (isGitHub.value) {
        await appStore.githubPushReviewWorkspace(props.workspaceId);
      } else {
        await appStore.azurePushReviewWorkspace(props.workspaceId);
      }
    }

    const createFn = isGitHub.value ? api.githubCreatePullRequest : api.azureCreatePullRequest;
    const { result } = await createFn({
      workspaceId: props.workspaceId,
      targetBranch: prFormTarget.value,
      title: prFormTitle.value.trim(),
      description: prFormDescription.value.trim(),
      isDraft: prFormDraft.value,
    });
    const prId = result.pullRequestNumber || result.pullRequestId;
    prFormResult.value = {
      ok: true,
      summary: `PR #${prId} created.`,
      url: result.url,
    };
  } catch (err) {
    prFormResult.value = { ok: false, summary: (err as Error)?.message || "Failed to create pull request." };
  } finally {
    prFormBusy.value = false;
  }
}

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

// Auto-refresh when the Review pane becomes the active view
watch(
  () => appStore.activeViewId,
  (viewId) => {
    if (viewId === `review:${props.workspaceId}`) {
      if (isGitHub.value) {
        appStore.refreshGitHub();
        if (prKey.value) appStore.markGitHubPrSeen(prKey.value);
      } else {
        appStore.refreshAzure();
        if (prKey.value) appStore.markAzurePrSeen(prKey.value);
      }
    }
  },
  { immediate: true },
);

// Busy state for async toolbar actions
const busyAction = ref<string>("");

async function handleRefresh() {
  busyAction.value = "refresh";
  try {
    if (isGitHub.value) {
      await appStore.refreshGitHub();
      if (prKey.value) await appStore.markGitHubPrSeen(prKey.value);
    } else {
      await appStore.refreshAzure();
      if (prKey.value) await appStore.markAzurePrSeen(prKey.value);
    }
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

// File tree builder — groups files by directory segments
const fileTree = computed(() => {
  const files = changedFiles.value;
  if (!files.length) return [];

  // Find common prefix to strip
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const paths = files.map((f: any) =>
    String(f.path || "")
      .replace(/^\//, "")
      .split("/"),
  );
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
    const segs = String(file.path || "")
      .replace(/^\//, "")
      .split("/")
      .slice(prefix);
    let node = root;
    for (let i = 0; i < segs.length - 1; i++) {
      if (!node.has(segs[i])) node.set(segs[i], new Map());
      node = node.get(segs[i]);
    }
    node.set(segs.at(-1), file);
  }

  // Convert to array, collapsing single-child dirs
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function toArray(map: Map<string, any>, pathPrefix = ""): any[] {
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

function onSelectFile(filePath: string) {
  // Strip leading / for git operations
  const normalized = String(filePath || "").replace(/^\//, "");
  // Pass the PR target branch so diff uses the correct base
  const targetBranch = stripRef(pullRequest.value.targetRefName || "");
  gitUiStore.reviewSelectFileDiff(props.workspaceId, normalized, targetBranch);
}

// Helpers
function stripRef(ref: unknown) {
  return String(ref || "").replace(/^refs\/heads\//, "");
}
function changeTypeClass(t: unknown) {
  return t === "add" ? "diff-add" : t === "delete" ? "diff-del" : "diff-meta";
}
function changeTypeLabel(t: unknown) {
  return t === "add" ? "A" : t === "delete" ? "D" : "M";
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

<style scoped>
.nb-step {
  display: flex;
  gap: 10px;
  padding: 10px 14px;
  border-radius: 6px;
  border: 1px solid var(--border);
  background: rgba(255, 255, 255, 0.03);
  font-size: 13px;
}

.nb-step strong {
  display: block;
}

.nb-step p {
  margin: 2px 0 0;
  font-size: 12px;
  color: var(--muted);
}

.nb-step--done {
  opacity: 0.5;
}

.nb-step--active {
  border-color: var(--accent, #ffa424);
  background: rgba(255, 164, 36, 0.06);
}

.nb-step__check {
  font-size: 16px;
  flex-shrink: 0;
  line-height: 1.2;
}
</style>
