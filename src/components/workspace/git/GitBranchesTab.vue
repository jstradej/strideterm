<template>
  <div
    class="git-section git-branches"
    :class="{ 'git-branches--mobile': isMobile, 'git-branches--history': compactHistory }"
  >
    <p v-if="gitUi.tagsError" class="git-branches__pane-error" role="alert">{{ gitUi.tagsError }}</p>
    <!-- Compact toolbar (search + filters + actions).
         Desktop: single row. Mobile: stacked with view-switcher tabs. -->
    <div v-if="compactHistory" class="git-history-picker">
      <div class="git-history-picker__search git-history-picker__search--commits">
        <input
          v-model="historyCommitSearch"
          type="search"
          placeholder="Message, author, or hash…"
          aria-label="Search commits"
        />
      </div>
      <button
        v-if="isMobile"
        type="button"
        class="button button--ghost button--small git-history-picker__toggle"
        :class="{ 'git-history-picker__toggle--active': activeFilterCount > 0 }"
        :aria-expanded="filtersOpen ? 'true' : 'false'"
        aria-controls="git-history-filters"
        @click="filtersOpen = !filtersOpen"
      >
        Filters<span v-if="activeFilterCount" class="git-history-picker__toggle-count">{{ activeFilterCount }}</span>
        <span aria-hidden="true">{{ filtersOpen ? "▴" : "▾" }}</span>
      </button>
      <div
        v-if="!isMobile || filtersOpen"
        id="git-history-filters"
        class="git-history-picker__filters"
        :class="{ 'git-history-picker__filters--mobile': isMobile }"
      >
        <div class="git-history-picker__select">
          <HistoryRangePicker
            :model-value="selectedRef || '__ALL__'"
            :current="branchList.current"
            :favorites="historyPreferences.favorites"
            :recent="historyPreferences.recent"
            :local="historyLocalNames"
            :remotes="historyRemoteNames"
            :remote-names="effectiveRemoteNames"
            :tags="historyTagNames"
            :default-branch="branchList.defaultBranch"
            :default-remote="branchList.defaultRemote"
            :loading-ref="historyLoadingRef"
            @change="onHistoryRefChange"
            @toggle-favorite="toggleHistoryFavorite"
          />
        </div>
        <GitHistoryFilters
          v-model:user-filter="userFilter"
          v-model:date-filter="dateFilter"
          v-model:custom-since="customSince"
          v-model:custom-until="customUntil"
          v-model:paths-filter="pathsFilter"
          v-model:topo-order="topoOrder"
          v-model:view-mode="viewMode"
          v-model:graph-limit="graphLimit"
          v-model:compare-base="compareBase"
          v-model:include-base-updates="includeBaseUpdates"
          :known-authors="knownAuthors"
          :base-branch-options="baseBranchOptions"
          :default-branch="branchList.defaultBranch"
          :default-remote="branchList.defaultRemote"
          :remote-names="effectiveRemoteNames"
          :has-active-filters="hasActiveFilters"
          compact
          @clear="resetFilters"
        />
        <span class="git-history-picker__spacer"></span>
        <button
          v-if="hasActiveFilters || historyCommitSearch || selectedRef || compareBase"
          type="button"
          class="button button--ghost button--small"
          title="Clear the search, branch and all commit filters"
          @click="clearHistoryFilters"
        >
          Clear filters
        </button>
      </div>
    </div>
    <div v-if="compactHistory && historyRefNotice" class="git-history-picker__notice" role="status">
      <span class="git-history-picker__notice-text">{{ historyRefNotice }}</span>
      <button
        type="button"
        class="button button--ghost button--small git-history-picker__notice-dismiss"
        aria-label="Dismiss notice"
        @click="historyRefNotice = ''"
      >
        ✕
      </button>
    </div>
    <div
      v-if="compactHistory && historyCommitSearch && !filteredHistoryCommits.length && !graphLoading && !graphError"
      class="git-history-picker__notice"
      role="status"
    >
      <span class="git-history-picker__notice-text">No commits match “{{ historyCommitSearch }}”.</span>
    </div>
    <div v-if="!compactHistory" class="git-branches__toolbar">
      <div class="git-branches__search">
        <input
          v-model="search"
          type="search"
          class="git-branches__search-input"
          placeholder="Filter branches / commits…"
          aria-label="Filter branches and commits"
        />
        <span v-if="search" class="git-branches__search-clear" role="button" tabindex="0" @click="search = ''">×</span>
      </div>
      <!-- Tree section chips (Local / Remote / Tags). Replace the older
           Remotes checkbox — chips read cleaner and let us add Tags in the
           same control row now that the Tags tab is gone. -->
      <div v-if="!isMobile" class="git-branches__chips" role="group" aria-label="Tree sections">
        <button
          type="button"
          :class="['git-branches__chip', showLocal && 'git-branches__chip--on']"
          title="Show local branches in the tree."
          @click="showLocal = !showLocal"
        >
          Local
        </button>
        <button
          type="button"
          :class="['git-branches__chip', showRemotes && 'git-branches__chip--on']"
          title="Show remote-tracking branches in the tree (and walk them when loading the graph)."
          @click="showRemotes = !showRemotes"
        >
          Remote
        </button>
        <button
          type="button"
          :class="['git-branches__chip', showTags && 'git-branches__chip--on']"
          title="Show tags as a section in the tree."
          @click="showTags = !showTags"
        >
          Tags
        </button>
      </div>
      <label v-if="!isMobile" class="git-branches__filter" title="Show only branches whose tip is reachable from HEAD.">
        <input v-model="showMerged" type="checkbox" />
        Merged only
      </label>
      <CustomSelect
        v-if="!isMobile"
        v-model="branchDateFilter"
        :options="branchDateSelectOptions"
        class="git-branches__cselect git-branches__cselect--date"
      />
      <input
        v-if="!isMobile && branchDateFilter === 'custom'"
        v-model="branchCustomSince"
        type="date"
        class="git-branches__filter-date"
        title="Show only branches updated on or after this date."
      />
      <CustomSelect
        v-if="!isMobile"
        v-model="branchSort"
        :options="branchSortSelectOptions"
        class="git-branches__cselect git-branches__cselect--sort"
      />
      <button
        type="button"
        class="button button--small"
        :disabled="branchesLoading || graphLoading"
        title="Re-list branches and re-read the commit topology. Local only — no fetch."
        @click="refreshAll(true)"
      >
        {{ branchesLoading || graphLoading ? "Loading…" : "Refresh" }}
      </button>
    </div>

    <!-- Mobile view switcher (Tree → Commits → Diff). Hidden on desktop. -->
    <nav
      v-if="isMobile && !historySplit"
      class="git-branches__mobile-tabs"
      role="tablist"
      :aria-label="compactHistory ? 'History view' : 'Branches view'"
    >
      <button
        v-if="!compactHistory"
        type="button"
        :class="['git-branches__mobile-tab', mobileView === 'tree' && 'git-branches__mobile-tab--active']"
        @click="mobileView = 'tree'"
      >
        Tree
      </button>
      <button
        type="button"
        :class="['git-branches__mobile-tab', mobileView === 'commits' && 'git-branches__mobile-tab--active']"
        :disabled="!compactHistory && !selectedRef"
        @click="mobileView = 'commits'"
      >
        Commits<span v-if="selectedRef" class="git-branches__mobile-chip">{{ selectedRef }}</span>
      </button>
      <button
        type="button"
        :class="['git-branches__mobile-tab', mobileView === 'diff' && 'git-branches__mobile-tab--active']"
        :disabled="!selectedHash"
        @click="mobileView = 'diff'"
      >
        Diff
      </button>
    </nav>

    <div v-if="branchesError" class="git-info-banner git-info-banner--warn">
      <strong>Failed to load branches</strong>
      <p>{{ branchesError }}</p>
    </div>

    <!-- Cold-start spinner: visible while the very first branch + graph fetch
         for this workspace is still pending. Subsequent refreshes are
         surfaced inline by GitTreeGraph's own loading state. -->
    <div v-if="isInitialLoading && !compactHistory" class="git-branches__loading" role="status" aria-live="polite">
      <span class="git-branches__spinner" aria-hidden="true"></span>
      <span>Loading branches…</span>
    </div>

    <!-- Inline "new branch" prompt -->
    <div v-if="newBranchVisible" class="git-branches__inline-form">
      <input
        v-model="newBranchName"
        type="text"
        class="git-pr-form__input"
        placeholder="feature/my-branch"
        @keydown.enter="onCreateBranch"
        @keydown.escape="cancelNewBranch"
      />
      <small v-if="startFrom" class="git-branches__form-hint"
        >from <strong>{{ startFrom }}</strong></small
      >
      <button
        type="button"
        class="button button--small"
        :disabled="!newBranchName.trim() || !!gitUi.busyAction"
        @click="onCreateBranch"
      >
        Create
      </button>
      <button type="button" class="button button--ghost button--small" @click="cancelNewBranch">Cancel</button>
    </div>

    <GitOperationCard :snapshot="snapshot" :workspace-id="workspaceId" :git-ui="gitUi" />

    <!-- ===== Desktop: 3-pane (tree | commits | diff) ===== -->
    <div v-if="!isMobile" class="git-branches__body" :class="{ 'git-branches__body--history': compactHistory }">
      <Splitpanes class="default-theme git-branches__panes">
        <Pane v-if="!compactHistory" :size="24" :min-size="18">
          <BranchTreePane
            :tree="branchTree"
            :loading="branchesLoading"
            :selected-ref="selectedRef"
            :head="branchList.current"
            :busy="!!gitUi.busyAction"
            :is-dirty="isDirty"
            :can-create-pr="hasAzureConnection"
            :multi-selected-refs="multiSelectedRefs"
            @select="onSelectRef"
            @multi-toggle="onMultiToggleRef"
            @range-select="onRangeSelectRef"
            @checkout="onCheckout"
            @checkout-remote="onCheckoutRemote"
            @new-from="onNewBranchFrom"
            @rename="onRename"
            @delete="onDeleteLocal"
            @delete-remote="onDeleteRemote"
            @merge="onMergeInto"
            @rebase="onRebaseOnto"
            @create-pr="onCreatePrForBranch"
          />
        </Pane>
        <Pane :size="compactHistory ? 55 : 44" :min-size="compactHistory ? 30 : 28">
          <div class="git-branches__commits-pane">
            <div class="git-branches__pane-head">
              <strong>
                <template v-if="compareBase">{{ compareBase }} … HEAD</template>
                <template v-else-if="selectedRef">Commits on {{ selectedRef }}</template>
                <template v-else>All commits</template>
              </strong>
              <span
                v-if="compactHistory && loadedCount && historyQueryActive"
                class="git-branches__pane-count"
                :title="`${filteredHistoryCommits.length} of ${loadedCount} commit(s) match`"
                >{{ filteredHistoryCommits.length }} of {{ loadedCount }}</span
              >
              <span v-else-if="loadedCount" class="git-branches__pane-count" :title="`${loadedCount} commit(s) shown`"
                >{{ loadedCount }} {{ loadedCount === 1 ? "commit" : "commits" }}</span
              >
              <span
                v-if="compactHistory && baseBranch"
                class="git-branches__pane-vs"
                :title="`New work is measured against ${baseBranch}`"
                >vs {{ baseBranch }}</span
              >
              <template v-if="compareBase">
                <GitDiffStat v-if="compareDiffStat" :stat="compareDiffStat" />
                <span
                  v-if="compareCountsLoading"
                  class="git-branches__pane-count git-branches__pane-count--muted"
                  title="Computing ahead/behind counts…"
                  >ahead/behind …</span
                >
                <template v-else>
                  <span
                    v-if="compareAhead > 0"
                    class="git-branches__pane-count git-branches__pane-count--ahead"
                    :title="`Your branch has ${compareAhead} commit(s) that ${compareBase} doesn't.`"
                    >{{ compareAhead }} ahead</span
                  >
                  <span
                    v-if="compareBehind > 0"
                    class="git-branches__pane-count git-branches__pane-count--behind"
                    :title="behindTooltip"
                    >{{ compareBehind }} behind</span
                  >
                </template>
              </template>
              <span v-if="graphError" class="git-branches__pane-error">— {{ graphError }}</span>
              <Spinner
                v-if="graphLoadingMore"
                size="sm"
                class="git-branches__pane-more"
                title="Loading more commits…"
              />
              <span v-if="selectedRef || compareBase || compactHistory" class="git-branches__pane-spacer"></span>
              <button
                v-if="selectedRef && !compareBase"
                type="button"
                class="button button--ghost button--small"
                title="Clear branch filter — show commits from all refs."
                @click="onSelectRef('')"
              >
                Show all
              </button>
              <button
                v-if="compareBase"
                type="button"
                class="button button--ghost button--small"
                title="Exit compare-with-base mode."
                @click="compareBase = ''"
              >
                Exit compare
              </button>
              <span v-if="compactHistory" class="git-branches__pane-fetch" aria-live="polite"
                >Last fetch: {{ snapshot.lastFetchAt ? formatDateLabel(snapshot.lastFetchAt) : "Unknown" }}</span
              >
            </div>
            <GitHistoryFilters
              v-if="!compactHistory"
              v-model:user-filter="userFilter"
              v-model:date-filter="dateFilter"
              v-model:custom-since="customSince"
              v-model:custom-until="customUntil"
              v-model:paths-filter="pathsFilter"
              v-model:topo-order="topoOrder"
              v-model:view-mode="viewMode"
              v-model:graph-limit="graphLimit"
              v-model:compare-base="compareBase"
              v-model:include-base-updates="includeBaseUpdates"
              :known-authors="knownAuthors"
              :base-branch-options="baseBranchOptions"
              :default-branch="branchList.defaultBranch"
              :default-remote="branchList.defaultRemote"
              :remote-names="effectiveRemoteNames"
              :has-active-filters="hasActiveFilters"
              @clear="resetFilters"
            />
            <div v-if="showCompareEmptyState" class="git-branches__compare-empty" role="status" aria-live="polite">
              <span class="git-branches__compare-empty-icon" aria-hidden="true">✓</span>
              <div class="git-branches__compare-empty-text">
                <strong>No commits ahead of {{ compareBase }}.</strong>
                <span>Your branch has nothing this base doesn't already have.</span>
              </div>
              <button
                v-if="!includeBaseUpdates"
                type="button"
                class="button button--ghost button--small"
                title="Switch to walking base...HEAD so you also see commits on the base since fork."
                @click="includeBaseUpdates = true"
              >
                Include base updates
              </button>
            </div>
            <GitTreeGraph
              v-else-if="viewMode === 'graph'"
              :commits="compactHistory ? filteredHistoryCommits : commits"
              :head="head"
              :refs="refs"
              :selected-hash="selectedHash"
              :selected-hashes="selectedHashes"
              :loading="graphLoading"
              :pending="graphPending"
              :error="graphError"
              :flat="graphFlatMode"
              :history="compactHistory"
              :range-base="compactHistory ? baseBranch : ''"
              :reach-commits="compactHistory ? commits : undefined"
              @select="onSelectCommit"
              @open="onOpenCommitDialog"
              @contextmenu="onCommitContextMenu"
            />
            <div v-else class="git-branches__flat-log">
              <div v-if="graphLoading && !commits.length" class="git-branches__placeholder">
                <Spinner size="sm" label="Loading…" />
              </div>
              <GitCommitLog
                v-else
                :commits="compactHistory ? filteredHistoryCommits : commits"
                :selected-commit="selectedShortHash"
                :ahead-count="0"
                @select="onSelectCommitShort"
                @show-info="onShowCommitInfoFlat"
              />
            </div>
          </div>
        </Pane>
        <Pane :size="compactHistory ? 45 : 32" :min-size="20">
          <div class="git-branches__diff-pane">
            <!-- Commit info header (always visible when a commit is picked) -->
            <div v-if="selectedHash" class="git-branches__commit-summary">
              <div class="git-branches__commit-summary-row">
                <span class="git-branches__commit-hash">{{ shortHashOf(selectedHash) }}</span>
                <span class="git-branches__commit-subject" :title="selectedCommitInfo?.subject || ''">{{
                  selectedCommitInfo?.subject || ""
                }}</span>
                <button
                  type="button"
                  class="button button--ghost button--small"
                  title="Open full commit dialog"
                  @click="onOpenCommitDialog(selectedHash)"
                >
                  Details
                </button>
              </div>
              <div class="git-branches__commit-summary-meta">
                <span v-if="selectedCommitInfo?.author"
                  ><strong>{{ selectedCommitInfo.author }}</strong></span
                >
                <span v-if="selectedCommitInfo?.relativeDate" :title="selectedCommitInfo.isoDate">{{
                  selectedCommitInfo.relativeDate
                }}</span>
                <span
                  v-for="refName in selectedCommitInfo?.refs || []"
                  :key="refName"
                  class="git-branches__commit-ref"
                  >{{ refName }}</span
                >
              </div>
            </div>
            <Splitpanes horizontal class="default-theme git-branches__inner-panes">
              <Pane :size="35" :min-size="18">
                <div class="git-branches__commit-files">
                  <div v-if="!selectedHash" class="git-branches__placeholder">Select a commit to see its files.</div>
                  <div v-else-if="commitFilesLoading" class="git-branches__placeholder">
                    <Spinner size="sm" label="Loading…" />
                  </div>
                  <div v-else-if="commitFilesError" class="git-branches__placeholder">{{ commitFilesError }}</div>
                  <GitChangeTree
                    v-else-if="selectedHash"
                    :files="commitFiles"
                    :selected-path="selectedCommitFile"
                    selected-scope="commit"
                    @select="onSelectCommitFile"
                    @context-menu="onCommitFileContextMenu"
                  />
                </div>
              </Pane>
              <Pane :size="65" :min-size="20">
                <div class="git-branches__commit-diff">
                  <MonacoDiffPanel
                    v-if="selectedCommitFile"
                    :payload="commitDiffPayload"
                    :loading="commitDiffLoading"
                    :popout-title="`${selectedCommitFile} @ ${shortHashOf(selectedHash)}`"
                  />
                  <div v-else class="git-branches__placeholder">
                    {{ selectedHash ? "Pick a file to view its diff." : "" }}
                  </div>
                </div>
              </Pane>
            </Splitpanes>
          </div>
        </Pane>
      </Splitpanes>
    </div>

    <!-- ===== Mobile: stacked single-pane wizard ===== -->
    <div
      v-else
      ref="mobileBody"
      class="git-branches__mobile-body"
      :class="{ 'git-branches__mobile-body--split': historySplit }"
    >
      <BranchTreePane
        v-if="mobileView === 'tree' && !compactHistory"
        :tree="branchTree"
        :loading="branchesLoading"
        :selected-ref="selectedRef"
        :head="branchList.current"
        :busy="!!gitUi.busyAction"
        :is-dirty="isDirty"
        :compact="true"
        :can-create-pr="hasAzureConnection"
        @select="onMobileSelectRef"
        @checkout="onCheckout"
        @checkout-remote="onCheckoutRemote"
        @new-from="onNewBranchFrom"
        @rename="onRename"
        @delete="onDeleteLocal"
        @delete-remote="onDeleteRemote"
        @merge="onMergeInto"
        @rebase="onRebaseOnto"
        @create-pr="onCreatePrForBranch"
      />

      <div
        v-else-if="
          historySplit ? !selectedCommitFile : mobileView === 'commits' || (compactHistory && mobileView !== 'diff')
        "
        class="git-branches__commits-pane"
      >
        <div class="git-branches__pane-head">
          <button
            v-if="!compactHistory"
            type="button"
            class="git-branches__mobile-back"
            title="Back to branch tree"
            @click="mobileView = 'tree'"
          >
            ‹
          </button>
          <strong>{{ selectedRef || "Commits" }}</strong>
          <span v-if="loadedCount" class="git-branches__pane-count">{{ loadedCount }}</span>
        </div>
        <GitTreeGraph
          :commits="compactHistory ? filteredHistoryCommits : commits"
          :head="head"
          :refs="refs"
          :selected-hash="selectedHash"
          :loading="graphLoading"
          :pending="graphPending"
          :error="graphError"
          :compact="true"
          :flat="graphFlatMode"
          :history="compactHistory"
          :range-base="compactHistory ? baseBranch : ''"
          :reach-commits="compactHistory ? commits : undefined"
          @select="onMobileSelectCommit"
          @open="onOpenCommitDialog"
          @contextmenu="onCommitContextMenu"
        />
      </div>

      <div v-if="historySplit || mobileView === 'diff'" class="git-branches__diff-pane git-branches__diff-pane--mobile">
        <div v-if="historySplit && !selectedHash" class="git-branches__placeholder">
          Select a commit to see its files.
        </div>
        <div v-if="!historySplit || selectedHash" class="git-branches__pane-head">
          <button
            v-if="!historySplit || selectedCommitFile"
            type="button"
            class="git-branches__mobile-back"
            title="Back to commits"
            @click="onMobileBackToCommits"
          >
            ‹
          </button>
          <span class="git-branches__commit-hash">{{ shortHashOf(selectedHash) }}</span>
          <span class="git-branches__commit-subject" :title="selectedCommitInfo?.subject || ''">{{
            selectedCommitInfo?.subject || ""
          }}</span>
        </div>
        <div
          v-if="!historySplit || selectedHash"
          class="git-branches__mobile-files"
          :class="{ 'git-branches__mobile-files--only': !selectedCommitFile }"
        >
          <div v-if="commitFilesLoading" class="git-branches__placeholder">
            <Spinner size="sm" label="Loading…" />
          </div>
          <div v-else-if="commitFilesError" class="git-branches__placeholder">{{ commitFilesError }}</div>
          <GitChangeTree
            v-else
            :files="commitFiles"
            :selected-path="selectedCommitFile"
            selected-scope="commit"
            @select="onSelectCommitFile"
            @context-menu="onCommitFileContextMenu"
          />
        </div>
        <div v-if="selectedCommitFile" class="git-branches__commit-diff git-branches__commit-diff--mobile">
          <MonacoDiffPanel
            :payload="commitDiffPayload"
            :loading="commitDiffLoading"
            :initial-inline="mobileDiffInline"
            :popout-title="`${selectedCommitFile} @ ${shortHashOf(selectedHash)}`"
          />
        </div>
      </div>
    </div>

    <GitCommitContextMenu
      v-if="ctxMenu"
      :x="ctxMenu.x"
      :y="ctxMenu.y"
      :short-hash="ctxMenu.shortHash"
      :subject="ctxMenu.subject"
      :items="ctxMenu.items"
      @pick="onMenuPick"
      @close="ctxMenu = null"
    />

    <!-- Commit file context menu (right-click a file in the commit's file tree) -->
    <Teleport to="body">
      <div
        v-if="fileMenu"
        ref="fileMenuRef"
        class="context-menu"
        :style="{ position: 'fixed', left: fileMenu.x + 'px', top: fileMenu.y + 'px', zIndex: 9999 }"
        @click.stop
      >
        <button
          type="button"
          class="context-menu__item"
          title="Copy the file's full absolute path on disk."
          @click="copyAbsolutePath"
        >
          <span class="context-menu__icon">&#x1F4C1;</span><span>Copy absolute path</span>
        </button>
        <button
          type="button"
          class="context-menu__item"
          title="Copy the file's path relative to the repository root."
          @click="copyRelativePath"
        >
          <span class="context-menu__icon">&#x1F4CB;</span><span>Copy relative path</span>
        </button>
      </div>
    </Teleport>
  </div>
</template>

<script setup lang="ts">
import { computed, defineAsyncComponent, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { Splitpanes, Pane } from "splitpanes";
import "splitpanes/dist/splitpanes.css";
import { useAppStore } from "../../../stores/app.js";
import { useGitUiStore } from "../../../stores/git-ui.js";
import { useIsNarrow } from "../../../composables/useIsNarrow.js";
import { useCommitContextMenu } from "../../../composables/useCommitContextMenu.js";
import { useMonacoDiffLoader } from "../../../composables/useMonacoDiffLoader.js";
import { useContextMenu } from "../../../composables/useContextMenu.js";
import GitOperationCard from "./GitOperationCard.vue";
import GitTreeGraph from "./GitTreeGraph.vue";
import GitCommitLog from "./GitCommitLog.vue";
import GitChangeTree from "./GitChangeTree.vue";
import BranchTreePane, { type BranchTreeNode } from "./BranchTreePane.vue";
import CustomSelect from "../../common/CustomSelect.vue";
import Spinner from "../../common/Spinner.vue";
import GitHistoryFilters from "./GitHistoryFilters.vue";
import HistoryRangePicker from "./HistoryRangePicker.vue";
import GitCommitContextMenu from "./GitCommitContextMenu.vue";
import GitDiffStat from "./GitDiffStat.vue";
import { isRemoteRef } from "./base-ref.js";
import { buildBranchForest, type BranchForestNode } from "./branch-forest.js";
import { submitPullRequest } from "./pull-request-submit.js";

const MonacoDiffPanel = defineAsyncComponent(() => import("../../shared/MonacoDiffPanel.vue"));

const props = withDefaults(
  defineProps<{
    workspaceId: string;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    snapshot: Record<string, any>;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    gitUi: Record<string, any>;
    activeRootPath?: string;
    profileId?: string;
    hasAzureConnection?: boolean;
    activeConnectionId?: string;
    baseBranch?: string;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    compare?: Record<string, any>;
    baseBranchOptions?: string[];
    remoteNames?: string[];
    compactHistory?: boolean;
  }>(),
  {
    activeRootPath: "",
    profileId: "default",
    hasAzureConnection: false,
    activeConnectionId: "",
    baseBranch: "",
    compare: () => ({}),
    baseBranchOptions: () => [],
    remoteNames: () => [],
    compactHistory: false,
  },
);

const appStore = useAppStore();
const gitUiStore = useGitUiStore();
const { isMobile } = useIsNarrow();
type GitHistorySelection = ReturnType<typeof gitUiStore.getGitHistorySelection>;
const defaultHistorySelection: GitHistorySelection = {
  ref: "",
  commitSearch: "",
  showRemotes: true,
  userFilter: "",
  dateFilter: "all",
  customSince: "",
  customUntil: "",
  pathsFilter: [],
  topoOrder: false,
  graphLimit: 500,
  compareBase: "",
  includeBaseUpdates: false,
  viewMode: "graph",
};
function historyField<K extends keyof GitHistorySelection>(key: K) {
  return computed({
    get: () =>
      gitUiStore.getGitHistorySelection(props.workspaceId, props.activeRootPath || "", props.profileId || "default")[
        key
      ] ?? defaultHistorySelection[key],
    set: (value: GitHistorySelection[K]) =>
      gitUiStore.setGitHistorySelection(props.workspaceId, props.activeRootPath || "", props.profileId || "default", {
        [key]: value,
      }),
  });
}

const search = ref("");
const showLocal = ref(true);
const showRemotes = historyField("showRemotes");
const showTags = ref(false);
const showMerged = ref(false);
// Filter branches by last-activity date. Cutoff is derived from a unix
// timestamp on each entry (`lastCommitTimestamp`) so we can use the same
// comparison for relative ("last week") and absolute ("since YYYY-MM-DD")
// modes.
const branchDateFilter = ref<"all" | "day" | "week" | "month" | "custom">("all");
const branchCustomSince = ref<string>(""); // YYYY-MM-DD when branchDateFilter === "custom"
// Leaf sort order inside each folder/section. "name" keeps the current
// alphabetic+current-pinned behavior; "newest"/"oldest" sort by
// lastCommitTimestamp.
const branchSort = ref<"name" | "newest" | "oldest">("name");
const newBranchVisible = ref(false);
const newBranchName = ref("");
const startFrom = ref("");

// Mobile-only "wizard" step (tree → commits → diff)
const mobileView = ref<"tree" | "commits" | "diff">("tree");
const filtersOpen = ref(false);

const SHORT_WIDE_QUERY = "(max-height: 500px) and (min-width: 640px)";
const shortWide = ref(false);
let shortWideMql: MediaQueryList | null = null;
function syncShortWide() {
  shortWide.value = !!shortWideMql?.matches;
}
onMounted(() => {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
  shortWideMql = window.matchMedia(SHORT_WIDE_QUERY);
  syncShortWide();
  shortWideMql.addEventListener("change", syncShortWide);
});
onBeforeUnmount(() => shortWideMql?.removeEventListener("change", syncShortWide));
const historySplit = computed(() => isMobile.value && props.compactHistory && shortWide.value);

// Which ref is selected in the branch tree (acts as a graph filter).
// Empty string = no filter (shows the full Log).
const selectedRef = computed({
  get: () =>
    gitUiStore.getGitHistorySelection(props.workspaceId, props.activeRootPath || "", props.profileId || "default").ref,
  set: (ref: string) =>
    gitUiStore.setGitHistorySelection(props.workspaceId, props.activeRootPath || "", props.profileId || "default", {
      ref,
    }),
});
const historyCommitSearch = computed({
  get: () =>
    gitUiStore.getGitHistorySelection(props.workspaceId, props.activeRootPath || "", props.profileId || "default")
      .commitSearch,
  set: (commitSearch: string) =>
    gitUiStore.setGitHistorySelection(props.workspaceId, props.activeRootPath || "", props.profileId || "default", {
      commitSearch,
    }),
});
const historyRefNotice = ref("");
const historyPreferences = computed(() =>
  gitUiStore.getGitHistoryPreferences(props.workspaceId, props.activeRootPath || "", props.profileId || "default"),
);
function toggleHistoryFavorite(ref: string) {
  gitUiStore.toggleGitHistoryFavorite(props.workspaceId, ref, props.activeRootPath || "", props.profileId || "default");
}
const historyLocalNames = computed(() => branchList.value.local.map((branch) => branch.name));
const historyRemoteNames = computed(() => branchList.value.remotes.map((branch) => branch.name));
const historyTagNames = computed(() => tags.value.map((tag) => tag.name));
const historyLoadingRef = computed(() => {
  const ref = selectedRef.value;
  const known =
    !ref ||
    historyLocalNames.value.includes(ref) ||
    historyRemoteNames.value.includes(ref) ||
    historyTagNames.value.includes(ref);
  return !known && (branchesLoading.value || props.gitUi?.tagsLoading) ? ref : "";
});
function onHistoryRefChange(value: string) {
  const selected = value === "__ALL__" ? "" : value;
  onSelectRef(selected);
  gitUiStore.recordGitHistoryRef(props.workspaceId, value, props.activeRootPath || "", props.profileId || "default");
}

// Ctrl/Cmd-click multi-selection of local branches for bulk delete.
// A plain click clears this; Ctrl/Cmd-click toggles a ref in the set.
// We keep the Set in a ref and replace it wholesale to ensure reactivity.
const multiSelectedRefs = ref<Set<string>>(new Set());

const branchesLoading = computed(() => props.gitUi?.branchesLoading === true);
const branchesError = computed(() => String(props.gitUi?.branchesError || ""));

// True while the first branch list AND first graph fetch are both pending —
// we hide the (empty) panes behind a spinner instead of flashing "No commits
// found" / "No branches" during the cold start.
const isInitialLoading = computed(() => {
  const haveBranches = !!props.gitUi?.branchList;
  const haveGraph = (props.gitUi?.graph?.commits?.length ?? 0) > 0 || !!props.gitUi?.graphError;
  return (branchesLoading.value && !haveBranches) || (props.gitUi?.graphLoading === true && !haveGraph);
});

interface LocalBranch {
  name: string;
  isCurrent: boolean;
  upstream: string;
  ahead: number;
  behind: number;
  lastCommit: string;
  lastSubject: string;
  lastAuthor: string;
  lastRelativeDate: string;
  lastCommitTimestamp: number;
  merged: boolean;
  worktreePath?: string;
}
interface RemoteBranch {
  name: string;
  remote: string;
  shortName: string;
  lastCommit: string;
  lastSubject: string;
  lastAuthor: string;
  lastRelativeDate: string;
  lastCommitTimestamp: number;
  isDefault: boolean;
}
interface TagEntry {
  name: string;
  hash?: string;
  shortHash?: string;
  subject?: string;
}

const branchList = computed<{
  current: string;
  upstream: string;
  local: LocalBranch[];
  remotes: RemoteBranch[];
  defaultBranch: string;
  defaultRemote: string;
}>(() => {
  const bl = props.gitUi?.branchList || {};
  return {
    current: bl.current || "",
    upstream: bl.upstream || "",
    local: (bl.local as LocalBranch[]) || [],
    remotes: (bl.remotes as RemoteBranch[]) || [],
    defaultBranch: bl.defaultBranch || "",
    defaultRemote: bl.defaultRemote || "",
  };
});

const tags = computed<TagEntry[]>(() => (props.gitUi?.tags as TagEntry[]) || []);

const isDirty = computed(() => !!props.snapshot?.dirty);

const localShortNames = computed(() => new Set(branchList.value.local.map((b) => b.name)));

// Names of all remotes for the local/remote distinction in BranchSelectPopover.
// Always merge the parent's prop (from snapshot.remotes) with names observed
// in branchList.remotes — `git remote -v` may list a subset (e.g. only
// origin) while the user has tracking branches from other remotes (`vk/…`,
// `jveselka/…`). Union covers both.
const effectiveRemoteNames = computed<string[]>(() => {
  const fromProps = props.remoteNames || [];
  const fromBranchList = branchList.value.remotes.map((r) => r.remote);
  return Array.from(new Set([...fromProps, ...fromBranchList].filter(Boolean)));
});

// --- Build the hierarchical branch tree ----------------------------------
//
// Sections:
//   HEAD          → single node pointing at the current branch
//   Local         → tree of local branches, split by "/" so feature/foo
//                   appears under a collapsible "feature" folder
//   Remote/<r>    → one section per remote name (origin, upstream, …) with
//                   the same `/`-split sub-tree
//   Tags          → flat list of tag names
//
// `search` filters branch/tag names case-insensitively; folders are kept
// when at least one descendant matches.

// Epoch-seconds cutoff for the branch date filter. 0 means "no filter".
// Custom mode reads the date input as local midnight; invalid input → no
// filter rather than dropping every branch silently.
function branchDateCutoff(): number {
  const now = Math.floor(Date.now() / 1000);
  switch (branchDateFilter.value) {
    case "day":
      return now - 86400;
    case "week":
      return now - 7 * 86400;
    case "month":
      return now - 30 * 86400;
    case "custom": {
      if (!branchCustomSince.value) return 0;
      const t = Date.parse(branchCustomSince.value);
      return Number.isNaN(t) ? 0 : Math.floor(t / 1000);
    }
    default:
      return 0;
  }
}

const branchTree = computed<BranchTreeNode[]>(() => {
  const q = search.value.trim().toLowerCase();
  const head = branchList.value.current;
  const cutoff = branchDateCutoff();
  const sortMode = branchSort.value;
  const out: BranchTreeNode[] = [];

  if (head) {
    out.push({
      key: "head",
      kind: "section",
      label: "HEAD (Current Branch)",
      icon: "★",
      children: [
        {
          key: `head:${head}`,
          kind: "branch-local",
          label: head,
          ref: head,
          isCurrent: true,
          upstream: branchList.value.upstream,
          children: [],
        },
      ],
    });
  }

  // Build a `/`-split forest from a list of names, via the shared pure
  // helper in ./branch-forest.ts (also used by BranchSelectPopover.vue).
  type ForestEntry = { shortName: string; ref: string; meta: BranchTreeNode["meta"]; kind: BranchTreeNode["kind"] };

  function toBranchTreeNodes(nodes: BranchForestNode<ForestEntry>[]): BranchTreeNode[] {
    return nodes.map((n) => {
      if (n.kind === "folder") {
        return { key: n.key, kind: "folder", label: n.label, ref: "", children: toBranchTreeNodes(n.children) };
      }
      return {
        key: n.key,
        kind: n.payload.kind,
        label: n.label,
        ref: n.ref,
        isCurrent: n.payload.kind === "branch-local" && n.ref === head,
        meta: n.payload.meta,
        children: [],
      };
    });
  }

  function buildForest(entries: ForestEntry[], keyPrefix: string): BranchTreeNode[] {
    const filtered = q ? entries.filter((e) => e.shortName.toLowerCase().includes(q)) : entries;
    const forest = buildBranchForest(
      filtered.map((entry) => ({ path: entry.shortName, ref: entry.ref, payload: entry })),
      keyPrefix,
      (a, b) => {
        if (sortMode === "newest" || sortMode === "oldest") {
          const ta = a.payload.meta?.lastCommitTimestamp || 0;
          const tb = b.payload.meta?.lastCommitTimestamp || 0;
          if (ta !== tb) return sortMode === "newest" ? tb - ta : ta - tb;
          return a.label.localeCompare(b.label);
        }
        // "name" mode — current branch always floats to the top.
        const aCurrent = a.payload.kind === "branch-local" && a.ref === head;
        const bCurrent = b.payload.kind === "branch-local" && b.ref === head;
        if (aCurrent && !bCurrent) return -1;
        if (!aCurrent && bCurrent) return 1;
        return a.label.localeCompare(b.label);
      },
    );
    return toBranchTreeNodes(forest);
  }

  // ---- Local ----
  if (showLocal.value) {
    const locals = branchList.value.local
      .filter((b) => !showMerged.value || b.merged || b.isCurrent)
      // Date cutoff: drop branches older than the cutoff EXCEPT the current
      // branch — hiding HEAD while it's still checked out is jarring. A
      // timestamp of 0 means "unknown" (old git output); we drop those when
      // the user has actively asked for a recent-activity filter.
      .filter((b) => cutoff === 0 || b.isCurrent || (b.lastCommitTimestamp > 0 && b.lastCommitTimestamp >= cutoff))
      .map((b) => ({
        shortName: b.name,
        ref: b.name,
        kind: "branch-local" as const,
        meta: {
          ahead: b.ahead,
          behind: b.behind,
          upstream: b.upstream,
          merged: b.merged,
          lastCommit: b.lastCommit,
          lastSubject: b.lastSubject,
          lastAuthor: b.lastAuthor,
          lastRelativeDate: b.lastRelativeDate,
          lastCommitTimestamp: b.lastCommitTimestamp,
          isCurrent: b.isCurrent,
          ...(b.worktreePath ? { worktreePath: b.worktreePath } : {}),
        },
      }));
    const localTree = buildForest(locals, "local");
    if (localTree.length) {
      out.push({
        key: "local",
        kind: "section",
        label: "Local",
        icon: "⌥",
        children: localTree,
        meta: { count: locals.length },
      });
    }
  }

  // ---- Remotes ----
  if (showRemotes.value) {
    const byRemote = new Map<string, RemoteBranch[]>();
    for (const r of branchList.value.remotes) {
      // Same cutoff as locals. Remote tips don't have an "isCurrent"
      // escape hatch, so they're filtered strictly.
      if (cutoff !== 0 && !(r.lastCommitTimestamp > 0 && r.lastCommitTimestamp >= cutoff)) continue;
      const list = byRemote.get(r.remote) || [];
      list.push(r);
      byRemote.set(r.remote, list);
    }
    const remoteNames = Array.from(byRemote.keys()).sort();
    for (const remoteName of remoteNames) {
      const entries = byRemote.get(remoteName) || [];
      const mapped = entries.map((r) => ({
        shortName: r.shortName,
        ref: r.name,
        kind: "branch-remote" as const,
        meta: {
          remote: r.remote,
          lastCommit: r.lastCommit,
          lastSubject: r.lastSubject,
          lastAuthor: r.lastAuthor,
          lastRelativeDate: r.lastRelativeDate,
          lastCommitTimestamp: r.lastCommitTimestamp,
          hasLocal: localShortNames.value.has(r.shortName),
          isDefault: r.isDefault,
        },
      }));
      const subTree = buildForest(mapped, `remote:${remoteName}`);
      if (!subTree.length) continue;
      out.push({
        key: `remote:${remoteName}`,
        kind: "section",
        label: `Remote · ${remoteName}`,
        icon: "☁",
        children: subTree,
        meta: { count: entries.length },
      });
    }
  }

  // ---- Tags ----
  const tagNames = showTags.value ? tags.value.map((t) => t.name).filter((n) => !q || n.toLowerCase().includes(q)) : [];
  if (tagNames.length) {
    const mapped = tagNames.map((name) => ({
      shortName: name,
      ref: name,
      kind: "tag" as const,
      meta: { tag: true },
    }));
    out.push({
      key: "tags",
      kind: "section",
      label: "Tags",
      icon: "🏷",
      children: buildForest(mapped, "tag"),
      meta: { count: tagNames.length },
    });
  }

  return out;
});

// --- Commit graph state (per-branch filter applied via gitLoadGraph) ----

interface GraphCommit {
  hash: string;
  shortHash: string;
  parents: string[];
  subject: string;
  author: string;
  relativeDate: string;
  isoDate: string;
  refs: string[];
}

const graphLoading = computed(() => props.gitUi?.graphLoading === true);
const graphLoadingMore = computed(() => props.gitUi?.graphLoadingMore === true);
const graphPending = computed(() => !graphRequested.value && !props.gitUi?.branchList);
const graphError = computed(() => String(props.gitUi?.graphError || ""));
const rawCommits = computed<GraphCommit[]>(() => (props.gitUi?.graph?.commits as GraphCommit[]) || []);
const head = computed(() => String(props.gitUi?.graph?.head || ""));
const refs = computed<Record<string, string>>(() => (props.gitUi?.graph?.refs as Record<string, string>) || {});

// --- Commit-list filters (JetBrains-style) ------------------------------
// All four filters (User / Date / Paths / Sort) hit the backend so the lane
// layout is built from a consistent set of commits. Filtering client-side
// shredded the parent chain — branches that should merge into mainline lost
// their endpoint and rendered as orphan verticals (see the "Filter by user
// breaks the graph" issue).

const userFilter = historyField("userFilter");
const dateFilter = historyField("dateFilter");
const customSince = historyField("customSince"); // YYYY-MM-DD
const customUntil = historyField("customUntil"); // YYYY-MM-DD
const pathsFilter = historyField("pathsFilter");
const topoOrder = historyField("topoOrder");
const graphLimit = historyField("graphLimit");

// "Compare with base" — ported from the History tab. When set, the graph
// walks `base..HEAD` (or `base...HEAD` if includeBaseUpdates is on) instead
// of the whole repo, so the user sees only commits that are part of the
// current branch's diff against base.
const compareBase = historyField("compareBase");
// When on, walk `base...HEAD` (3-dot symmetric difference) instead of
// `base..HEAD`. User sees both their work AND base updates they're missing.
const includeBaseUpdates = historyField("includeBaseUpdates");
// Graph (lanes/topology) vs Flat (plain commit list, History-style). Same
// underlying data — toggle just swaps the renderer.
const viewMode = historyField("viewMode");
// Pick the freshest ahead/behind counts for the CURRENT compareBase.
//
// Two sources:
//   1. props.compare = snapshot.compareWithBase — computed by inspectWorkspace
//      against snapshot.baseBranch (the heuristic / symbolic default).
//   2. gitUi.baseComparison — populated on-demand by gitFetchBaseComparison
//      whenever the user picks a base that the snapshot doesn't already cover.
//
// Whichever one matches `compareBase` wins. If neither matches yet, return
// null so the UI can show a `…` placeholder instead of misleading zeros.
const compareCounts = computed<{ ahead: number; behind: number; ok: boolean } | null>(() => {
  if (!compareBase.value) return null;
  const cmp = props.compare || {};
  if (cmp.baseBranch === compareBase.value && typeof cmp.aheadCount === "number") {
    return { ahead: cmp.aheadCount || 0, behind: cmp.behindCount || 0, ok: true };
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const bc = (props.gitUi?.baseComparison as any) || null;
  if (bc && bc.baseBranch === compareBase.value && bc.ok) {
    return { ahead: bc.aheadCount || 0, behind: bc.behindCount || 0, ok: true };
  }
  return null;
});
const compareAhead = computed<number>(() => compareCounts.value?.ahead ?? 0);
const compareBehind = computed<number>(() => compareCounts.value?.behind ?? 0);
const compareCountsLoading = computed<boolean>(
  () => !!compareBase.value && compareCounts.value === null && !!props.gitUi?.baseComparisonLoading,
);
const behindTooltip = computed<string>(() => {
  const base = compareBase.value;
  const behind = compareBehind.value;
  const hint = includeBaseUpdates.value ? "" : " Turn on 'Include base updates' to see them.";
  return `${base} has ${behind} commit(s) your branch doesn't.${hint}`;
});
const compareDiffStat = computed<Record<string, unknown> | null>(() => {
  const cmp = props.compare || {};
  if (!compareBase.value || cmp.baseBranch !== compareBase.value) return null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return ((cmp as any).diffStat as Record<string, unknown>) || null;
});

// Once branches have loaded (HEAD known), auto-select HEAD in the tree AND
// trigger the initial graph fetch. Per-workspace one-shot — switching back
// to a workspace that's already been initialized won't re-overwrite a
// user's manual pick. Combining the auto-init and the initial fetch in one
// watch avoids the previous "fetch graph with empty branchSpec, then set
// selectedRef = HEAD, then have a stale graph mislabeled" sequence.
const selectedRefInitFor = ref<string>("");
const graphRequested = ref(false);
watch(
  () => [props.workspaceId, branchList.value.current] as const,
  ([workspaceId, current]) => {
    if (!current) return;
    if (selectedRefInitFor.value === workspaceId) return;
    selectedRefInitFor.value = String(workspaceId);
    if (!selectedRef.value) selectedRef.value = String(current);
    refreshGraph();
  },
);

// Fetch ahead/behind counts whenever the user picks a base that isn't the
// snapshot's pre-computed one. Skip when snapshot.compareWithBase already
// covers it — that's authoritative and free.
watch(
  () => [compareBase.value, props.workspaceId] as const,
  ([base]) => {
    if (!base) return;
    if (props.compare?.baseBranch === base) return;
    void gitUiStore.gitFetchBaseComparison(props.workspaceId, base);
  },
  { immediate: true },
);

// Author dropdown is populated from the last unfiltered fetch — we cache it
// in `knownAuthors` so switching User doesn't shrink the dropdown to just
// the currently-selected author. Repopulated whenever we load a graph that
// wasn't itself author-filtered.
const knownAuthors = ref<string[]>([]);
watch(rawCommits, (commits) => {
  if (userFilter.value) return; // current set already narrowed — don't overwrite
  const set = new Set<string>();
  for (const c of commits) if (c.author) set.add(c.author);
  if (set.size) knownAuthors.value = Array.from(set).sort((a, b) => a.localeCompare(b));
});
const branchDateSelectOptions = [
  { value: "all", label: "Updated: Any time" },
  { value: "day", label: "Last day" },
  { value: "week", label: "Last week" },
  { value: "month", label: "Last month" },
  { value: "custom", label: "Since…" },
];

const branchSortSelectOptions = [
  { value: "name", label: "Sort: Name" },
  { value: "newest", label: "Sort: Newest" },
  { value: "oldest", label: "Sort: Oldest" },
];

// Server already filtered by --author, so the rendered commits ARE the raw
// fetch result. No client-side filtering — that would re-fragment the chain.
const commits = computed<GraphCommit[]>(() => rawCommits.value);
const historyQueryActive = computed(() => !!historyCommitSearch.value.trim());
const filteredHistoryCommits = computed(() => {
  const query = historyCommitSearch.value.trim().toLocaleLowerCase();
  if (!query) return commits.value;
  return commits.value.filter((commit) =>
    [commit.hash, commit.shortHash, commit.subject, commit.author].some((value) =>
      String(value || "")
        .toLocaleLowerCase()
        .includes(query),
    ),
  );
});

const loadedCount = computed(() => commits.value.length);

// Distinguishes "branch is up to date with base" from a still-loading or
// errored graph. Without this users see a blank pane and assume the feature
// broke, when in reality they have no commits to show.
const showCompareEmptyState = computed(
  () => !!compareBase.value && !graphLoading.value && !graphError.value && commits.value.length === 0,
);

function resolveDateRange(): { since: string; until: string } {
  if (dateFilter.value === "custom") {
    return { since: customSince.value, until: customUntil.value };
  }
  if (dateFilter.value === "today") return { since: "midnight", until: "" };
  if (dateFilter.value === "week") return { since: "1 week ago", until: "" };
  if (dateFilter.value === "month") return { since: "1 month ago", until: "" };
  return { since: "", until: "" };
}

function resetFilters() {
  userFilter.value = "";
  dateFilter.value = "all";
  customSince.value = "";
  customUntil.value = "";
  pathsFilter.value = [];
  topoOrder.value = false;
}

function clearHistoryFilters() {
  resetFilters();
  compareBase.value = "";
  historyCommitSearch.value = "";
  onSelectRef("");
}

const activeFilterCount = computed(
  () =>
    [
      userFilter.value,
      dateFilter.value !== "all",
      pathsFilter.value.length > 0,
      topoOrder.value,
      selectedRef.value && selectedRef.value !== branchList.value.current,
      compareBase.value,
    ].filter(Boolean).length,
);

const hasActiveFilters = computed(
  () => !!userFilter.value || dateFilter.value !== "all" || pathsFilter.value.length > 0 || topoOrder.value,
);

// User/Path filters drop commits from the middle of the chain, which leaves
// the lane builder with parents it can never reach — branches render as
// orphan verticals. Switch the graph into a flat single-column view in those
// cases; date / sort / branch filters still keep the topology meaningful.
const graphFlatMode = computed(
  () => !!userFilter.value || pathsFilter.value.length > 0 || (props.compactHistory && historyQueryActive.value),
);

const selectedHash = computed(() => String(props.gitUi?.selectedCommit || ""));
const selectedCommitInfo = computed<GraphCommit | null>(
  () => commits.value.find((c) => c.hash === selectedHash.value) || null,
);

function shortHashOf(hash: string): string {
  if (!hash) return "";
  return hash.length > 7 ? hash.slice(0, 7) : hash;
}

function formatDateLabel(value: string | null | undefined): string {
  if (!value) return "Unknown";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Unknown" : date.toLocaleString();
}

function refreshBranches(force = false) {
  gitUiStore.gitListBranches(props.workspaceId, { force });
  if (!tags.value.length && !props.gitUi?.tagsLoading) {
    gitUiStore.gitListTags(props.workspaceId);
  }
}

function refreshGraph(force = false) {
  graphRequested.value = true;
  const { since, until } = resolveDateRange();
  // Compare-with-base wins over a single-branch selection — both translate to
  // git log walk args, and base..HEAD is more specific (and what the user
  // explicitly asked for via the picker). When the user opts in to
  // `includeBaseUpdates`, switch to the 3-dot symmetric difference so commits
  // that landed on base since fork show up alongside the local work.
  let branchSpec = selectedRef.value || "";
  if (compareBase.value) {
    const head = String(props.snapshot?.branch || branchList.value.current || "HEAD");
    const dots = includeBaseUpdates.value ? "..." : "..";
    branchSpec = `${compareBase.value}${dots}${head}`;
  }
  gitUiStore.gitLoadGraph(props.workspaceId, {
    limit: graphLimit.value,
    includeRemotes: showRemotes.value,
    branch: branchSpec,
    sinceDate: since,
    untilDate: until,
    paths: pathsFilter.value,
    topoOrder: topoOrder.value,
    author: userFilter.value,
    force,
  });
}

function refreshAll(force = false) {
  refreshBranches(force);
  refreshGraph(force);
}

// Workspace mount / switch: fetch branches and, when the snapshot already
// knows the current branch, the graph in parallel. Otherwise the watch above
// starts the graph once branchList.current is known.
watch(
  () => [props.workspaceId, props.activeRootPath] as const,
  () => {
    graphRequested.value = false;
    refreshBranches();
    const branch = String(props.snapshot?.branch || "");
    if (!branch || branch === "HEAD") return;
    selectedRefInitFor.value = String(props.workspaceId);
    if (!selectedRef.value && !branchList.value.current) selectedRef.value = branch;
    refreshGraph();
  },
  { immediate: true },
);

// Backend-side filters: refetch when they change. User filter is client-side
// and lives only in `commits` computed — no refetch needed.
//
// Debounced so that typing into the custom-date inputs (one keystroke per
// character) doesn't fire a full `git log` per keystroke; the same handler
// also coalesces rapid filter chip toggles into a single fetch.
let filterDebounceTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleFilteredGraphRefresh() {
  if (filterDebounceTimer) clearTimeout(filterDebounceTimer);
  filterDebounceTimer = setTimeout(() => {
    filterDebounceTimer = null;
    refreshGraph();
  }, 250);
}

watch(
  [
    dateFilter,
    customSince,
    customUntil,
    pathsFilter,
    topoOrder,
    graphLimit,
    userFilter,
    compareBase,
    includeBaseUpdates,
    selectedRef,
    showRemotes,
    () => props.activeRootPath,
  ],
  () => scheduleFilteredGraphRefresh(),
  { deep: true },
);

// Switching compare bases makes "include base updates" meaningless until the
// user re-enables it for the new base — auto-reset on compareBase change.
watch(compareBase, () => {
  includeBaseUpdates.value = false;
});

// After any branch-list refresh, prune selections that point at refs which
// no longer exist (e.g. user just deleted the branch they had selected, so
// the graph would otherwise blow up with `fatal: ambiguous argument …
// unknown revision`). The existing selectedRef watcher then re-runs the
// graph against HEAD.
watch(
  () => [
    branchList.value.local.map((b) => b.name).join("\n"),
    branchList.value.remotes.map((r) => r.name).join("\n"),
    tags.value.map((t) => t.name).join("\n"),
    branchesLoading.value,
    props.gitUi?.tagsLoading === true,
    props.gitUi?.tagsError || "",
  ],
  () => {
    const validRefs = new Set<string>();
    for (const b of branchList.value.local) validRefs.add(b.name);
    for (const r of branchList.value.remotes) validRefs.add(r.name);
    for (const t of tags.value) validRefs.add(t.name);
    validRefs.add("HEAD");
    // Empty arrays can mean the initial reads have not arrived or a read failed.
    // Do not discard a persisted selection until both sources are available.
    const refsReady = !branchesLoading.value && !props.gitUi?.tagsLoading && !props.gitUi?.tagsError;
    if (refsReady && selectedRef.value && !validRefs.has(selectedRef.value)) {
      historyRefNotice.value = `Reference “${selectedRef.value}” is no longer available. Showing all commits.`;
      selectedRef.value = "";
      gitUiStore.gitSelectCommit(props.workspaceId, "");
    }
    if (refsReady && multiSelectedRefs.value.size > 0) {
      let changed = false;
      const next = new Set<string>();
      for (const r of multiSelectedRefs.value) {
        if (validRefs.has(r)) next.add(r);
        else changed = true;
      }
      if (changed) multiSelectedRefs.value = next;
    }
  },
);

watch(
  () => props.gitUi?.historyRefreshToken,
  (token, previous) => {
    if (token !== previous) refreshAll(true);
  },
);

onBeforeUnmount(() => {
  if (filterDebounceTimer) {
    clearTimeout(filterDebounceTimer);
    filterDebounceTimer = null;
  }
});

watch(
  () => props.gitUi?.activeTab,
  (tab) => {
    if (tab !== "branches") return;
    if (!props.gitUi?.branchList) refreshBranches();
    if (!props.gitUi?.graph?.commits?.length) refreshGraph();
  },
);

// --- Branch tree interactions -------------------------------------------

function onSelectRef(ref: string) {
  historyRefNotice.value = "";
  selectedRef.value = ref;
  // A plain (non-Ctrl/Cmd) click clears the multi-selection — Ctrl/Cmd-click
  // emits "multi-toggle" instead, so reaching this handler means the user
  // wants a single-focus selection.
  if (multiSelectedRefs.value.size > 0) multiSelectedRefs.value = new Set();
  // Clear current commit selection so the diff pane doesn't show a commit
  // unrelated to the new branch view. Graph refresh fires via the watcher
  // tuple — no need to call refreshGraph() here.
  gitUiStore.gitSelectCommit(props.workspaceId, "");
}

function onMultiToggleRef(ref: string) {
  const next = new Set(multiSelectedRefs.value);
  // Seed: first Ctrl/Cmd-click after a single selection extends from the
  // current selectedRef. Without this the user would have to Ctrl-click the
  // already-focused branch too — matches VS Code / IntelliJ behaviour.
  if (next.size === 0 && selectedRef.value && selectedRef.value !== ref) {
    const anchorIsLocal = branchList.value.local.some((b) => b.name === selectedRef.value && !b.isCurrent);
    if (anchorIsLocal) next.add(selectedRef.value);
  }
  if (next.has(ref)) next.delete(ref);
  else next.add(ref);
  multiSelectedRefs.value = next;
}

// Flat, deduped list of deletable local refs in tree display order. Used as
// the index space for shift-click range selection.
function collectLocalFlat(nodes: BranchTreeNode[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  function walk(arr: BranchTreeNode[]) {
    for (const n of arr) {
      if (n.kind === "branch-local" && n.ref && !n.isCurrent && !seen.has(n.ref)) {
        seen.add(n.ref);
        out.push(n.ref);
      }
      if (n.children?.length) walk(n.children);
    }
  }
  walk(nodes);
  return out;
}

function onRangeSelectRef(ref: string) {
  const flat = collectLocalFlat(branchTree.value);
  const targetIdx = flat.indexOf(ref);
  if (targetIdx < 0) return; // Target isn't a deletable local branch.
  // Anchor: current single selection if it's a local non-current branch.
  // No anchor (e.g. user shift-clicks first) → fall back to just selecting
  // the clicked ref, so shift+click never silently does nothing.
  const anchor = selectedRef.value;
  const anchorIdx = anchor ? flat.indexOf(anchor) : -1;
  if (anchorIdx < 0) {
    multiSelectedRefs.value = new Set([ref]);
    return;
  }
  const [lo, hi] = anchorIdx <= targetIdx ? [anchorIdx, targetIdx] : [targetIdx, anchorIdx];
  multiSelectedRefs.value = new Set(flat.slice(lo, hi + 1));
}

function onMobileSelectRef(ref: string) {
  onSelectRef(ref);
  if (ref) mobileView.value = "commits";
}

function onNewBranchFrom(ref: string) {
  startFrom.value = ref;
  newBranchName.value = "";
  newBranchVisible.value = true;
}

function cancelNewBranch() {
  newBranchVisible.value = false;
  newBranchName.value = "";
  startFrom.value = "";
}

async function onCreateBranch() {
  const name = newBranchName.value.trim();
  if (!name) return;
  await gitUiStore.gitCreateBranch(props.workspaceId, name, startFrom.value);
  cancelNewBranch();
  refreshAll(true);
}

async function onCheckout(ref: string) {
  await gitUiStore.gitCheckoutBranch(props.workspaceId, ref);
  refreshAll(true);
}

async function onCheckoutRemote(remoteRef: string) {
  const slash = remoteRef.indexOf("/");
  const remoteName = slash >= 0 ? remoteRef.slice(0, slash) : "";
  const shortName = slash >= 0 ? remoteRef.slice(slash + 1) : remoteRef;
  const localBranch = localShortNames.value.has(shortName) ? `${remoteName}-${shortName}` : shortName;
  await gitUiStore.gitCheckoutRemoteBranch(props.workspaceId, remoteRef, localBranch);
  refreshAll(true);
}

function onDeleteLocal(ref: string) {
  // Bulk path: Ctrl/Cmd-clicked one or more branches and the right-click
  // target is in that set. Operate on the whole set instead of just `ref`.
  if (multiSelectedRefs.value.size > 1 && multiSelectedRefs.value.has(ref)) {
    onBulkDeleteLocal(Array.from(multiSelectedRefs.value));
    return;
  }
  const entry = branchList.value.local.find((b) => b.name === ref);
  if (!entry) return;
  // Branch checked out in a worktree can't be deleted via `git branch -d`.
  // Route through the worktree-aware confirm so the user can wipe the
  // worktree directory and the branch ref in one step.
  if (entry.worktreePath) {
    gitUiStore.confirmRemoveWorktreeDeleteBranch(props.workspaceId, {
      worktreePath: entry.worktreePath,
      branch: entry.name,
      branchMerged: entry.merged,
    });
    return;
  }
  const force = !entry.merged;
  const verb = force ? "Force delete" : "Delete";
  appStore.openDialog("ConfirmDialog", {
    eyebrow: "Git",
    title: `${verb} branch?`,
    message: force
      ? `Branch '${entry.name}' has unmerged commits — they will be lost.`
      : `Branch '${entry.name}' will be removed.`,
    confirmLabel: verb,
    danger: true,
    onCancel: () => appStore.closeDialog(),
    onConfirm: async () => {
      appStore.closeDialog();
      await gitUiStore.gitDeleteBranch(props.workspaceId, entry.name, force);
      refreshAll(true);
    },
  });
}

function onBulkDeleteLocal(refs: string[]) {
  // Resolve each ref against the current branchList so we know which are
  // checked out in a worktree (those go through `removeWorktree` instead
  // of `branch -d`) and which have unmerged commits (those need -D / force).
  const entries = refs
    .map((r) => branchList.value.local.find((b) => b.name === r))
    .filter((b): b is LocalBranch => !!b && !b.isCurrent);
  if (!entries.length) return;
  const worktreeEntries = entries.filter((b) => !!b.worktreePath);
  const unmergedEntries = entries.filter((b) => !b.merged);

  // One bulk confirm covers everything — no per-branch prompts during the
  // loop. Mirrors how IDEA handles multi-branch delete.
  const lines: string[] = entries.map((b) => {
    const tags: string[] = [];
    if (b.worktreePath) tags.push("worktree");
    if (!b.merged) tags.push("unmerged");
    return tags.length ? `• ${b.name} (${tags.join(", ")})` : `• ${b.name}`;
  });
  const extras: string[] = [];
  if (worktreeEntries.length) {
    extras.push(
      `${worktreeEntries.length} worktree director${worktreeEntries.length === 1 ? "y" : "ies"} will also be removed.`,
    );
  }
  if (unmergedEntries.length) {
    extras.push(
      `${unmergedEntries.length} branch${unmergedEntries.length === 1 ? " has" : "es have"} unmerged commits — they will be lost.`,
    );
  }
  appStore.openDialog("ConfirmDialog", {
    eyebrow: "Git",
    title: `Delete ${entries.length} branches?`,
    message: [...lines, ...(extras.length ? ["", ...extras] : [])].join("\n"),
    confirmLabel: "Delete all",
    danger: true,
    onCancel: () => appStore.closeDialog(),
    onConfirm: async () => {
      appStore.closeDialog();
      // Sequential — git on one repo serializes index writes anyway, and
      // any per-branch failure leaves the rest in a known state.
      for (const b of entries) {
        if (b.worktreePath) {
          await gitUiStore.gitRemoveWorktree(props.workspaceId, b.worktreePath, true);
        } else {
          await gitUiStore.gitDeleteBranch(props.workspaceId, b.name, !b.merged);
        }
      }
      multiSelectedRefs.value = new Set();
      refreshAll(true);
    },
  });
}

function onDeleteRemote(remoteRef: string) {
  const slash = remoteRef.indexOf("/");
  const remoteName = slash >= 0 ? remoteRef.slice(0, slash) : "origin";
  const shortName = slash >= 0 ? remoteRef.slice(slash + 1) : remoteRef;
  appStore.openDialog("ConfirmDialog", {
    eyebrow: "Git",
    title: "Delete remote branch?",
    message: `Branch '${shortName}' on remote '${remoteName}' will be deleted via git push ${remoteName} :${shortName}. This cannot be undone server-side.`,
    confirmLabel: "Delete",
    danger: true,
    onCancel: () => appStore.closeDialog(),
    onConfirm: async () => {
      appStore.closeDialog();
      await gitUiStore.gitDeleteRemoteBranch(props.workspaceId, shortName, remoteName);
      refreshAll(true);
    },
  });
}

function onRename(ref: string) {
  appStore.openDialog("TextInputDialog", {
    eyebrow: "Git",
    title: `Rename branch '${ref}'`,
    label: "New name",
    value: ref,
    placeholder: "feature/my-branch",
    submitLabel: "Rename",
    onCancel: () => appStore.closeDialog(),
    onSubmit: async (next: string) => {
      appStore.closeDialog();
      const trimmed = next.trim();
      if (!trimmed || trimmed === ref) return;
      await gitUiStore.gitRenameBranch(props.workspaceId, ref, trimmed);
      refreshAll(true);
    },
  });
}

// When the target is a remote-tracking ref (e.g. origin/develop), fetch first
// so the rebase/merge runs against the latest — matches the Update card.
function onMergeInto(ref: string) {
  gitUiStore.gitMergeBase(props.workspaceId, ref, { fetchFirst: isRemoteRef(ref, effectiveRemoteNames.value) });
}

function onRebaseOnto(ref: string) {
  gitUiStore.gitRebaseBase(props.workspaceId, ref, { fetchFirst: isRemoteRef(ref, effectiveRemoteNames.value) });
}

// --- Commit selection + file diff ---------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const commitFiles = ref<any[]>([]);
const commitFilesLoading = ref(false);
const commitFilesError = ref("");
const selectedCommitFile = ref("");
let commitFilesSeq = 0;

// Commit file diff — shared seq-guarded loader (see useMonacoDiffLoader.ts),
// also used by GitChangesTab.vue's working-tree diff.
const commitDiffLoader = useMonacoDiffLoader((hash: string, relativePath: string) => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const api = appStore.getApi() as any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return api.fileCommitDiff({ rootPath: props.activeRootPath, relativePath, hash }) as Promise<any>;
}, "Failed to load commit diff");
const commitDiffPayload = commitDiffLoader.payload;
const commitDiffLoading = commitDiffLoader.loading;

async function loadCommitFiles(hash: string) {
  if (!hash || !props.activeRootPath) {
    commitFiles.value = [];
    return;
  }
  const seq = ++commitFilesSeq;
  commitFilesLoading.value = true;
  commitFilesError.value = "";
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const api = appStore.getApi() as any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = (await api.fileCommitFiles({ rootPath: props.activeRootPath, hash })) as any;
    if (seq !== commitFilesSeq) return;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    commitFiles.value = (result?.files || []).map((f: any) => ({ ...f, scope: "commit" }));
  } catch (err) {
    if (seq !== commitFilesSeq) return;
    commitFiles.value = [];
    commitFilesError.value = (err as Error)?.message || "Failed to load commit files.";
  } finally {
    if (seq === commitFilesSeq) commitFilesLoading.value = false;
  }
}

function loadCommitFileDiff(hash: string, relativePath: string) {
  if (!hash || !relativePath || !props.activeRootPath) {
    commitDiffPayload.value = null;
    return;
  }
  void commitDiffLoader.load(hash, relativePath);
}

// --- Multi-selection (Ctrl/Shift+click in the graph) ---------------------
// The store keeps a single "primary" commit (drives the diff pane); the
// multi-selection is purely local UI state feeding cherry-pick/squash.
const multiSelected = ref<string[]>([]);
const selectionAnchor = ref("");

const selectedHashes = computed(() =>
  multiSelected.value.length ? multiSelected.value : selectedHash.value ? [selectedHash.value] : [],
);

// Drop selected hashes that disappeared from the loaded log (refresh,
// branch/filter switch) so stale hashes can't reach the backend.
watch(commits, (list) => {
  if (!multiSelected.value.length) return;
  const loaded = new Set(list.map((c) => c.hash));
  const pruned = multiSelected.value.filter((hash) => loaded.has(hash));
  if (pruned.length !== multiSelected.value.length) multiSelected.value = pruned.length > 1 ? pruned : [];
});

function onSelectCommit(hash: string, mods?: { ctrl: boolean; shift: boolean }) {
  if (!hash) return;
  if (mods?.ctrl) {
    const base = multiSelected.value.length ? [...multiSelected.value] : selectedHash.value ? [selectedHash.value] : [];
    const idx = base.indexOf(hash);
    if (idx >= 0) base.splice(idx, 1);
    else base.push(hash);
    multiSelected.value = base;
    selectionAnchor.value = hash;
    if (idx < 0) gitUiStore.gitSelectCommit(props.workspaceId, hash);
    return;
  }
  if (mods?.shift) {
    const anchor = selectionAnchor.value || selectedHash.value || hash;
    const list = commits.value;
    const a = list.findIndex((c) => c.hash === anchor);
    const b = list.findIndex((c) => c.hash === hash);
    if (a >= 0 && b >= 0 && a !== b) {
      const [from, to] = a <= b ? [a, b] : [b, a];
      multiSelected.value = list.slice(from, to + 1).map((c) => c.hash);
    } else {
      multiSelected.value = [];
      selectionAnchor.value = hash;
    }
    gitUiStore.gitSelectCommit(props.workspaceId, hash);
    return;
  }
  multiSelected.value = [];
  selectionAnchor.value = hash;
  gitUiStore.gitSelectCommit(props.workspaceId, hash);
}

// GitCommitLog uses shortHash everywhere — bridge to the full-hash store.
const selectedShortHash = computed(() => shortHashOf(selectedHash.value));
function onSelectCommitShort(shortHash: string) {
  if (!shortHash) return;
  const entry = commits.value.find((c) => c.shortHash === shortHash || c.hash === shortHash);
  if (entry) onSelectCommit(entry.hash);
}
function onShowCommitInfoFlat(entry: GraphCommit) {
  onOpenCommitDialog(entry?.hash || entry?.shortHash || "");
}

function onMobileSelectCommit(hash: string) {
  onSelectCommit(hash);
  if (hash) mobileView.value = "diff";
}

watch(
  () => props.compactHistory,
  (compact) => {
    if (compact && mobileView.value === "tree") mobileView.value = "commits";
  },
  { immediate: true },
);

const INLINE_DIFF_BELOW_PX = 600;
const mobileBody = ref<HTMLElement | null>(null);
const mobileDiffInline = ref(false);

function onMobileBackToCommits() {
  if (historySplit.value) selectedCommitFile.value = "";
  else mobileView.value = "commits";
}

function onSelectCommitFile(path: string) {
  if (isMobile.value && !selectedCommitFile.value) {
    const width = mobileBody.value?.clientWidth || window.innerWidth;
    mobileDiffInline.value = width * (historySplit.value ? 0.65 : 1) < INLINE_DIFF_BELOW_PX;
  }
  selectedCommitFile.value = path;
  if (selectedHash.value) loadCommitFileDiff(selectedHash.value, path);
}

function onOpenCommitDialog(hash: string) {
  const entry = commits.value.find((c) => c.hash === hash);
  appStore.openDialog("GitCommitInfoDialog", {
    workspaceId: props.workspaceId,
    rootPath: props.activeRootPath || "",
    hash: entry?.shortHash || hash,
    seed: {
      shortHash: entry?.shortHash || "",
      hash: entry?.hash || hash,
      subject: entry?.subject || "",
      author: entry?.author || "",
      relativeDate: entry?.relativeDate || "",
      refs: (entry?.refs || []).join(", "),
    },
    onClose: () => appStore.closeDialog(),
  });
}

// --- Commit context menu ------------------------------------------------
// Right-click on any commit row in GitTreeGraph opens this menu — see
// useCommitContextMenu() for the single/multi menu construction, squash
// eligibility, and action dispatch (cherry-pick, checkout, tag, PR, …).
const { ctxMenu, onCommitContextMenu, onMenuPick } = useCommitContextMenu({
  workspaceId: computed(() => props.workspaceId),
  commits,
  head,
  multiSelected,
  snapshot: computed(() => props.snapshot),
  hasAzureConnection: computed(() => !!props.hasAzureConnection),
  currentBranch: computed(() => branchList.value.current),
  gitUiStore,
  appStore,
  shortHashOf,
  copyToClipboard,
  refreshAll,
  onOpenCommitDialog,
  openCreatePullRequestDialog,
});

async function copyToClipboard(text: string) {
  if (typeof navigator === "undefined" || !navigator.clipboard) return;
  try {
    await navigator.clipboard.writeText(text);
  } catch (err) {
    const notifStore = (await import("../../../stores/notifications.js")).useNotificationStore();
    notifStore.showError("Copy failed", err || "The browser blocked clipboard access.", {
      workspaceId: props.workspaceId,
    });
  }
}

// --- Commit file context menu (copy absolute / relative path) -----------
const fileMenu = ref<{ x: number; y: number; path: string } | null>(null);
const fileMenuRef = ref<HTMLElement | null>(null);

function onCommitFileContextMenu(payload: { path: string; name: string; kind: "file" | "dir"; x: number; y: number }) {
  fileMenu.value = { x: payload.x, y: payload.y, path: payload.path };
}

// Join the repo-relative path onto activeRootPath using the root's own
// separator, so the absolute path reads natively on Windows and POSIX alike.
function toAbsolutePath(relPath: string): string {
  const root = props.activeRootPath || "";
  if (!root) return relPath;
  const sep = root.includes("\\") ? "\\" : "/";
  const rel = sep === "\\" ? relPath.replace(/\//g, "\\") : relPath;
  return `${root.replace(/[\\/]+$/, "")}${sep}${rel}`;
}

async function copyAbsolutePath() {
  const target = fileMenu.value;
  fileMenu.value = null;
  if (target) await copyToClipboard(toAbsolutePath(target.path));
}

async function copyRelativePath() {
  const target = fileMenu.value;
  fileMenu.value = null;
  if (target) await copyToClipboard(target.path);
}

useContextMenu({
  isOpen: () => !!fileMenu.value,
  menuRef: fileMenuRef,
  onClose: () => {
    fileMenu.value = null;
  },
});

// Branch-tree context menu → "Create pull request…". Routes through the same
// dialog as the commit menu, just with the chosen branch ref as source.
// Strips the remote prefix only when the ref matches an actual remote-tracking
// branch — "feature/login" must NOT be turned into "login".
function onCreatePrForBranch(branchRef: string) {
  const remoteHit = branchList.value.remotes.find((r) => r.name === branchRef);
  const sourceBranch = remoteHit ? remoteHit.shortName : branchRef;
  openCreatePullRequestDialog(sourceBranch);
}

// Build & open the CreatePullRequestDialog. Closes over the local notification
// store so backend failures are surfaced both as inline dialog errors AND as a
// top-level toast — the user can dismiss the dialog and still see what broke.
function openCreatePullRequestDialog(sourceBranchOverride = "") {
  const sourceBranch = sourceBranchOverride || String(props.snapshot?.branch || branchList.value.current || "");
  if (!sourceBranch) {
    void showToast("Cannot create PR — current branch is unknown.", "error");
    return;
  }
  // Kick off branch list fetch immediately; dialog binds to gitUi.remoteBranches.
  if (!props.gitUi.remoteBranches?.length) {
    void gitUiStore.azureListRemoteBranches(props.workspaceId);
  }
  // Target: prefer the symbolic default branch (origin/HEAD) — that's the
  // remote's authoritative "where PRs go". Falls back to the heuristic
  // baseBranch from inspectWorkspace when no symbolic default is configured.
  const defaultTargetBranch = branchList.value.defaultBranch || props.baseBranch || "";
  appStore.openDialog("CreatePullRequestDialog", {
    workspaceId: props.workspaceId,
    sourceBranch,
    defaultTargetBranch,
    remoteBranches: props.gitUi.remoteBranches || [],
    loadingBranches: !!props.gitUi.remoteBranchesLoading,
    provider: "azure",
    onCancel: () => appStore.closeDialog(),
    onRefreshBranches: () => {
      void gitUiStore.azureListRemoteBranches(props.workspaceId);
    },
    onSubmit: async (payload: { title: string; description: string; targetBranch: string; isDraft: boolean }) => {
      const result = await submitPullRequest(
        gitUiStore,
        props.workspaceId,
        {
          title: payload.title,
          description: payload.description,
          sourceBranch,
          targetBranch: payload.targetBranch,
          isDraft: payload.isDraft,
          connectionId: props.activeConnectionId || "",
        },
        props.gitUi,
      );
      if (!result.ok) {
        // Throw so CreatePullRequestDialog's own try/catch shows the error
        // inline and leaves the dialog open for the user to correct title /
        // target and retry — the dialog owns its busy/error lifecycle now.
        throw new Error(result.summary);
      }
      appStore.closeDialog();
      await showToast(result.summary + (result.url ? " Open in browser:" : ""), "success", result.url);
    },
  });
}

async function showToast(body: string, kind: "info" | "error" | "success" = "info", url = "") {
  try {
    const notifStore = (await import("../../../stores/notifications.js")).useNotificationStore();
    const title = kind === "error" ? "Pull request failed" : kind === "success" ? "Pull request created" : "Git";
    const bodyWithUrl = url ? `${body} ${url}` : body;
    if (kind === "error") {
      notifStore.showError(title, bodyWithUrl, { workspaceId: props.workspaceId });
    } else {
      // addEvent surfaces a transient toast + dock entry for success/info paths.
      notifStore.addEvent({
        title,
        body: bodyWithUrl,
        kind: kind === "success" ? "info" : kind,
        tier: 1,
        urgency: "normal",
        workspaceId: props.workspaceId,
        workspaceName: "",
        category: "info",
      });
    }
  } catch (err) {
    console.warn("[branches] toast notification failed:", err);
  }
}

watch(
  () => [selectedHash.value, props.activeRootPath] as const,
  ([hash]) => {
    // A commit SHA can exist in multiple repositories. Treat a root switch as
    // a new read identity even when the selected SHA itself is unchanged.
    commitFilesSeq += 1;
    commitFiles.value = [];
    commitFilesLoading.value = false;
    commitFilesError.value = "";
    selectedCommitFile.value = "";
    commitDiffLoader.clear();
    if (hash) loadCommitFiles(hash);
  },
  { immediate: true },
);
</script>

<style scoped>
.git-branches {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px;
  height: 100%;
  min-height: 0;
}

.git-branches--mobile {
  padding: 6px;
  gap: 6px;
}

.git-branches__toolbar {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  padding: 6px 8px;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: rgba(var(--tint), 0.03);
  flex: 0 0 auto;
}

.git-branches--history {
  padding-top: 0;
}

.git-history-picker {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  border-bottom: 1px solid var(--border);
  background: var(--surface);
  flex-wrap: wrap;
  font-size: 12px;
}

.git-history-picker__select,
.git-history-picker__search {
  display: flex;
  align-items: center;
}

.git-history-picker__search input {
  min-width: 220px;
  max-width: 34vw;
  padding: 5px 8px;
  font-size: 13px;
  line-height: 1.2;
  border: 1px solid var(--border);
  border-radius: 5px;
  background: var(--surface);
  color: var(--text);
}

.git-history-picker__search--commits input {
  min-width: 260px;
}

.git-branches__pane-vs {
  color: var(--muted);
  font-size: 11px;
}

.git-history-picker__filters {
  display: contents;
}

.git-history-picker__filters--mobile {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  flex: 1 0 100%;
}

.git-history-picker__toggle {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  flex: 0 0 auto;
}

.git-history-picker__toggle--active {
  color: var(--accent);
}

.git-history-picker__toggle-count {
  min-width: 16px;
  padding: 0 4px;
  border-radius: 8px;
  background: rgba(255, 164, 36, 0.15);
  font-size: 10px;
  text-align: center;
}

.git-branches--mobile .git-history-picker {
  padding: 4px 6px;
  gap: 6px;
}

.git-branches--mobile .git-history-picker__search {
  flex: 1 1 0;
  min-width: 0;
}

.git-branches--mobile .git-history-picker__search input,
.git-branches--mobile .git-history-picker__search--commits input {
  min-width: 0;
  max-width: none;
  width: 100%;
}

.git-history-picker__spacer {
  flex: 1 1 0;
}

.git-history-picker__sep {
  width: 1px;
  height: 18px;
  background: var(--border);
  flex: 0 0 auto;
}

.git-history-picker .button,
.git-history-picker :deep(.history-range-picker__button),
.git-history-picker__search input {
  height: 28px;
  box-sizing: border-box;
}

.git-branches__pane-fetch {
  margin-left: auto;
  color: var(--muted);
  font-size: 11px;
  text-transform: none;
  letter-spacing: 0;
  white-space: nowrap;
}

.git-branches--mobile .git-branches__toolbar {
  padding: 4px 6px;
  gap: 6px;
}

.git-branches__search {
  position: relative;
  flex: 1 1 180px;
  max-width: 360px;
  min-width: 140px;
}

.git-branches--mobile .git-branches__search {
  max-width: none;
}

.git-branches__search-input {
  width: 100%;
  padding: 4px 26px 4px 8px;
  font-size: 12px;
  background: var(--surface);
  color: var(--text);
  border: 1px solid var(--border);
  border-radius: 3px;
  outline: none;
}

.git-branches__search-input:focus {
  border-color: var(--accent);
}

.git-branches__search-clear {
  position: absolute;
  right: 6px;
  top: 50%;
  transform: translateY(-50%);
  color: var(--muted);
  cursor: pointer;
  font-size: 14px;
  line-height: 1;
  padding: 0 2px;
}
.git-branches__search-clear:hover {
  color: var(--text);
}

.git-branches__filter {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  color: var(--muted);
  cursor: pointer;
  user-select: none;
  white-space: nowrap;
  flex: 0 0 auto;
}

.git-branches__chips {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  flex: 0 0 auto;
}

.git-branches__chip {
  font-size: 11px;
  height: 24px;
  padding: 0 9px;
  border: 1px solid var(--border);
  background: transparent;
  color: var(--muted);
  border-radius: 12px;
  cursor: pointer;
  white-space: nowrap;
  transition:
    background-color 0.12s ease,
    color 0.12s ease,
    border-color 0.12s ease;
}

.git-branches__chip:hover {
  background: rgba(var(--tint), 0.06);
  color: var(--text);
}

.git-branches__chip--on {
  background: rgba(255, 164, 36, 0.18);
  border-color: rgba(255, 164, 36, 0.45);
  color: var(--accent);
}

.git-branches__chip--on:hover {
  background: rgba(255, 164, 36, 0.25);
}

.git-branches__filter input {
  margin: 0;
}

.git-branches__inline-form {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  border: 1px dashed var(--accent);
  border-radius: 4px;
  background: rgba(255, 164, 36, 0.05);
  flex: 0 0 auto;
}

.git-branches__inline-form input[type="text"] {
  flex: 1;
  min-width: 0;
}

.git-branches__form-hint {
  color: var(--muted);
  font-size: 11px;
}

.git-branches__body {
  flex: 1;
  min-height: 0;
  overflow: hidden;
}

.git-branches__body--history {
  flex: 1 1 auto;
  min-height: 0;
}

.git-branches__panes,
.git-branches__inner-panes {
  height: 100%;
  background: transparent !important;
}

:deep(.git-branches__panes.splitpanes > .splitpanes__pane),
:deep(.git-branches__inner-panes.splitpanes > .splitpanes__pane) {
  background: transparent !important;
  overflow: hidden;
}

:deep(.git-branches__panes.splitpanes > .splitpanes__splitter),
:deep(.git-branches__inner-panes.splitpanes > .splitpanes__splitter) {
  background: var(--border) !important;
  min-width: 3px;
  min-height: 3px;
}

:deep(.git-branches__panes.splitpanes > .splitpanes__splitter:hover),
:deep(.git-branches__inner-panes.splitpanes > .splitpanes__splitter:hover) {
  background: var(--accent) !important;
}

.git-branches__commits-pane,
.git-branches__diff-pane {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: rgba(var(--tint), 0.03);
  overflow: hidden;
}

.git-branches__diff-pane {
  border: none;
  background: transparent;
}

.git-branches__commits-pane {
  border: none;
  background: transparent;
}

.git-branches__pane-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  color: var(--muted);
  border-bottom: 1px solid var(--border);
  background: rgba(var(--tint), 0.05);
  flex: 0 0 auto;
}

.git-branches__pane-more {
  opacity: 0.6;
}

.git-branches__pane-head > * {
  flex: 0 0 auto;
  white-space: nowrap;
}

.git-branches__pane-head strong {
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  font-size: 12px;
  color: var(--text);
  text-transform: none;
  letter-spacing: 0;
}

.git-branches__pane-head .git-branches__commit-subject {
  flex: 1 1 0;
  text-transform: none;
  letter-spacing: 0;
}

.git-branches__pane-head .git-branches__pane-fetch {
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}

.git-branches__pane-count {
  font-size: 10px;
  padding: 1px 6px;
  border-radius: 8px;
  background: rgba(255, 164, 36, 0.15);
  color: var(--accent);
  font-variant-numeric: tabular-nums;
}

.git-branches__pane-count--ahead {
  background: rgba(76, 175, 80, 0.18);
  color: #6dc070;
}
.git-branches__pane-count--behind {
  background: rgba(76, 110, 175, 0.22);
  color: #80a8e0;
}
.git-branches__pane-count--muted {
  background: rgba(255, 255, 255, 0.06);
  color: var(--muted);
  font-style: italic;
}

.git-branches__pane-error {
  color: #e07b8e;
  font-size: 11px;
  text-transform: none;
}

.git-branches__pane-spacer {
  flex: 1;
}

.git-branches__filter-date {
  font-size: 12px;
  height: 24px;
  padding: 0 6px;
  border-radius: 4px;
  border: 1px solid var(--border);
  background: rgba(0, 0, 0, 0.25);
  color: var(--text);
  width: 130px;
  font-variant-numeric: tabular-nums;
}

/* Tighten CustomSelect button when used as a filter chip — the component
   defaults to width:100% which would let it grab the whole flex row. */
.git-branches__cselect {
  flex: 0 0 auto;
  width: auto;
}
.git-branches__cselect :deep(.custom-select__button) {
  padding: 3px 8px;
  font-size: 12px;
  background: rgba(0, 0, 0, 0.25);
  height: 24px;
  line-height: 1;
}
.git-branches__cselect--date :deep(.custom-select__button) {
  min-width: 110px;
}
.git-branches__cselect--sort :deep(.custom-select__button) {
  min-width: 110px;
}

.git-branches__loading {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 18px 14px;
  color: var(--muted);
  font-size: 12px;
}

.git-branches__spinner {
  display: inline-block;
  width: 14px;
  height: 14px;
  border: 2px solid rgba(255, 255, 255, 0.18);
  border-top-color: var(--accent);
  border-radius: 50%;
  animation: git-branches-spin 0.8s linear infinite;
}

@keyframes git-branches-spin {
  to {
    transform: rotate(360deg);
  }
}

.git-branches__commits-pane > .git-tree,
.git-branches__commits-pane > :deep(.git-tree) {
  flex: 1;
  min-height: 0;
  border: none;
  border-radius: 0;
}

.git-branches__commit-files,
.git-branches__commit-diff {
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: rgba(var(--tint), 0.03);
}

.git-branches__commit-diff {
  position: relative;
}

.git-branches__commit-diff > * {
  flex: 1;
  min-height: 0;
}

.git-branches__commit-files-head {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  padding: 6px 10px;
  border-bottom: 1px solid var(--border);
  font-size: 11px;
  background: rgba(var(--tint), 0.05);
  flex: 0 0 auto;
}

.git-branches__commit-hash {
  font-family: var(--font-mono, ui-monospace, "SF Mono", monospace);
  font-weight: 600;
  color: var(--accent);
  font-variant-numeric: tabular-nums;
}

.git-branches__commit-subject {
  flex: 1 1 0;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text);
  font-size: 12px;
}

.git-branches__commit-meta {
  flex: 0 0 auto;
  color: var(--muted);
  font-size: 11px;
}

.git-branches__commit-summary {
  flex: 0 0 auto;
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 8px 10px;
  border-bottom: 1px solid var(--border);
  background: rgba(var(--tint), 0.05);
}

.git-branches__commit-summary-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.git-branches__commit-summary-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 10px;
  font-size: 11px;
  color: var(--muted);
}

.git-branches__commit-ref {
  font-size: 10px;
  padding: 1px 6px;
  border-radius: 3px;
  background: rgba(76, 175, 80, 0.18);
  color: #6dc070;
  font-weight: 600;
}

.git-branches__placeholder {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  color: var(--muted);
  font-size: 12px;
  font-style: italic;
  padding: 12px;
  text-align: center;
}

.git-history-picker__notice {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 12px;
  font-size: 12px;
  color: var(--muted);
}

.git-history-picker__notice-text {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.git-history-picker__notice-dismiss {
  flex: none;
}

.git-branches__flat-log {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 0 6px 8px;
}

.git-branches__compare-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  flex: 1;
  min-height: 0;
  padding: 24px 16px;
  color: var(--text);
  text-align: center;
}
.git-branches__compare-empty-icon {
  width: 36px;
  height: 36px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  background: rgba(76, 175, 80, 0.18);
  color: #6dc070;
  font-size: 20px;
  font-weight: 700;
}
.git-branches__compare-empty-text {
  display: flex;
  flex-direction: column;
  gap: 2px;
  font-size: 13px;
  max-width: 360px;
}
.git-branches__compare-empty-text span {
  color: var(--muted);
  font-size: 12px;
}

/* ===== Mobile / minimal layout ===== */
.git-branches__mobile-tabs {
  display: flex;
  align-items: stretch;
  gap: 4px;
  flex: 0 0 auto;
}

.git-branches__mobile-tab {
  flex: 1;
  padding: 8px 6px;
  font-size: 12px;
  background: rgba(var(--tint), 0.05);
  color: var(--muted);
  border: 1px solid var(--border);
  border-radius: 4px;
  cursor: pointer;
  text-align: center;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
}

.git-branches__mobile-tab[disabled] {
  opacity: 0.5;
  cursor: not-allowed;
}

.git-branches__mobile-tab--active {
  background: rgba(255, 164, 36, 0.15);
  color: var(--accent);
  border-color: var(--accent);
}

.git-branches__mobile-chip {
  font-size: 10px;
  padding: 0 4px;
  border-radius: 6px;
  background: rgba(255, 255, 255, 0.08);
  color: var(--text);
  max-width: 80px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.git-branches__mobile-body {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.git-branches__mobile-body--split {
  flex-direction: row;
  gap: 6px;
}

.git-branches__mobile-body--split > .git-branches__commits-pane,
.git-branches__mobile-body--split > .git-branches__diff-pane {
  flex: 1 1 0;
  min-width: 0;
}

.git-branches__mobile-back {
  background: transparent;
  border: none;
  color: var(--accent);
  font-size: 18px;
  line-height: 1;
  cursor: pointer;
  padding: 0 4px;
}

.git-branches__diff-pane--mobile {
  gap: 4px;
}

.git-branches__mobile-files {
  flex: 0 0 30%;
  min-height: 96px;
  overflow: auto;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: rgba(var(--tint), 0.03);
}

.git-branches__mobile-files--only {
  flex: 1 1 auto;
}

.git-branches__mobile-body--split > .git-branches__diff-pane--mobile {
  display: grid;
  grid-template-columns: minmax(160px, 33%) minmax(0, 1fr);
  grid-template-rows: auto minmax(0, 1fr);
}

.git-branches__mobile-body--split > .git-branches__diff-pane--mobile > .git-branches__pane-head {
  grid-column: 1 / -1;
}

.git-branches__mobile-body--split > .git-branches__diff-pane--mobile > .git-branches__placeholder {
  grid-column: 1 / -1;
  grid-row: 1 / -1;
}

.git-branches__mobile-body--split > .git-branches__diff-pane--mobile > .git-branches__mobile-files {
  min-height: 0;
}

.git-branches__mobile-body--split > .git-branches__diff-pane--mobile > .git-branches__mobile-files--only {
  grid-column: 1 / -1;
}

.git-branches__commit-diff--mobile {
  flex: 1;
  min-height: 0;
}
</style>
