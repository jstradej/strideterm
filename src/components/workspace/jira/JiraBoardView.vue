<template>
  <nav v-if="columnJumpVisible" class="jira-board-jump" aria-label="Board columns">
    <button
      v-for="(column, index) in nativeBoardColumnViews"
      :key="`${column.name}:${column.statusNames.join(',')}`"
      class="jira-board-jump__item"
      :data-tone="column.tone"
      type="button"
      :aria-current="index === currentColumn ? 'true' : undefined"
      :title="`Scroll to the ${column.name} column`"
      @click="jumpToColumn(index)"
    >
      <span class="jira-board-jump__dot" aria-hidden="true" />{{ column.name }}
      <span class="jira-board-jump__count">{{ column.issues.length }}</span>
    </button>
  </nav>
  <div
    v-if="!nativeListPresentation && boardColumns.length"
    ref="splitRef"
    class="jira-board-split"
    :class="{ 'jira-board-split--drawer': boardDrawerMode }"
    :style="boardDrawerMode ? drawer.style.value : undefined"
  >
    <div
      ref="columnsRef"
      class="jira-board-columns"
      role="region"
      aria-label="Board columns and statuses"
      :aria-busy="boardLoading || isBusy('sprint') ? 'true' : undefined"
      @scroll="onColumnsScroll"
    >
      <section
        v-for="column in nativeBoardColumnViews"
        :key="`${column.name}:${column.statusNames.join(',')}`"
        class="jira-board-column"
        :data-tone="column.tone"
        :aria-label="`${column.name} board column`"
      >
        <header class="jira-board-column__header" :title="column.statusNames.join(', ')">
          <span class="jira-board-column__dot" aria-hidden="true" />
          <strong>{{ column.name }}</strong>
          <span class="jira-board-column__count">{{ column.issues.length }}</span>
        </header>
        <p v-if="column.extraStatuses.length" class="jira-board-column__statuses">
          <span v-for="statusName in column.extraStatuses" :key="statusName">{{ statusName }}</span>
        </p>
        <div
          class="jira-board-column__cards"
          role="region"
          tabindex="0"
          :aria-label="`${column.name} issues`"
          @scroll="rememberNativeBoardCardsScroll"
        >
          <button
            v-for="issue in column.issues"
            :key="issue.ref.issueId"
            class="jira-board-issue"
            v-bind="navRow(issue)"
            :class="`jira-board-issue--${classifyJiraIssueType(issue.issueType || '')}`"
            :data-issue-id="issue.ref.issueId"
            :data-done="column.tone === 'done' || undefined"
            type="button"
            :aria-describedby="
              issuePreviewVisible && issuePreviewIssue?.ref.issueId === issue.ref.issueId
                ? 'jira-issue-preview'
                : undefined
            "
            @click="openIssue(issue, $event)"
            @mouseenter="scheduleIssuePreview(issue, $event)"
            @mouseleave="dismissIssuePreview"
            @focus="scheduleIssuePreview(issue, $event)"
            @blur="dismissIssuePreview"
            @keydown.esc="dismissIssuePreview"
          >
            <span class="jira-board-issue__topline">
              <JiraIssueBadges :issue-type="issue.issueType || 'Unknown type'" only="type" minimal />
              <strong class="jira-board-issue__key">{{ issue.ref.issueKey }}</strong>
              <JiraBranchBadge :issue-ref="issue.ref" />
              <JiraIssueBadges v-if="issue.priority" :priority="issue.priority" only="priority" minimal />
            </span>
            <span class="jira-board-issue__summary">{{ issue.summary }}</span>
            <span v-if="cardLabels(issue).length" class="jira-board-issue__labels">
              <span v-for="label in cardLabels(issue).slice(0, 3)" :key="label">{{ label }}</span>
              <span v-if="cardLabels(issue).length > 3">+{{ cardLabels(issue).length - 3 }}</span>
            </span>
            <span class="jira-board-issue__footer">
              <JiraPerson :display-name="issue.assignee" size="sm" :me="isOwnJiraAssignee(issue)" />
            </span>
          </button>
          <p v-if="!column.issues.length && !contentPending" class="jira-board-column__empty">No issues</p>
        </div>
      </section>
    </div>
    <div
      v-if="boardDrawerMode"
      class="jira-board-drawer__resizer"
      role="separator"
      aria-orientation="vertical"
      aria-label="Issue panel width"
      tabindex="0"
      title="Drag to resize the issue panel; double-click to reset."
      v-bind="drawer.aria.value"
      @pointerdown="drawer.startResize"
      @dblclick="drawer.resetWidth"
      @keydown="drawer.onKeydown"
    ></div>
    <aside v-if="boardDrawerMode" class="jira-board-drawer" aria-label="Issue details drawer">
      <JiraIssueDetail />
    </aside>
  </div>
  <p
    v-if="
      activeView === 'board' && boardMode === 'sprints' && selectedSprintId && !sprintIssues.length && !contentPending
    "
    class="jira-board-empty"
    role="status"
  >
    This sprint has no issues.
  </p>
  <section
    v-if="activeView === 'board' && unmappedBoardIssues.length"
    class="jira-board-unmapped"
    aria-label="Issues without a matching board column"
  >
    <h3>Other issues ({{ unmappedBoardIssues.length }})</h3>
    <p>These issues were returned by Jira but do not match a configured column status.</p>
    <button
      v-for="issue in unmappedBoardIssues"
      :key="issue.ref.issueId"
      class="jira-board-issue"
      v-bind="navRow(issue)"
      :class="`jira-board-issue--${classifyJiraIssueType(issue.issueType || '')}`"
      type="button"
      :aria-describedby="
        issuePreviewVisible && issuePreviewIssue?.ref.issueId === issue.ref.issueId ? 'jira-issue-preview' : undefined
      "
      @click="openIssue(issue, $event)"
      @mouseenter="scheduleIssuePreview(issue, $event)"
      @mouseleave="dismissIssuePreview"
      @focus="scheduleIssuePreview(issue, $event)"
      @blur="dismissIssuePreview"
      @keydown.esc="dismissIssuePreview"
    >
      <span class="jira-board-issue__topline">
        <JiraIssueBadges :issue-type="issue.issueType || 'Unknown type'" only="type" minimal />
        <strong class="jira-board-issue__key">{{ issue.ref.issueKey }}</strong>
        <JiraBranchBadge :issue-ref="issue.ref" />
        <JiraIssueBadges v-if="issue.priority" :priority="issue.priority" only="priority" minimal />
      </span>
      <span class="jira-board-issue__summary">{{ issue.summary }}</span>
      <span class="jira-board-issue__footer">
        <span class="jira-status-pill" :data-tone="jiraStatusTone(issue.status, issue.statusCategory)">{{
          issue.status || "Unknown status"
        }}</span>
        <JiraPerson :display-name="issue.assignee" size="sm" :me="isOwnJiraAssignee(issue)" />
      </span>
    </button>
  </section>
  <section
    v-if="
      boardMode === 'sprints' &&
      boardSprints.length &&
      (!selectedSprintId ||
        sprintIssuesTruncated ||
        sprintIssuesHasMore ||
        !boardColumns.length ||
        unmappedBoardIssues.length)
    "
    class="jira-sprints-details"
  >
    <section class="jira-sprints" aria-label="Board sprints">
      <p v-if="!selectedSprintId" class="jira-help" role="status">
        No active sprint is available on this board. Choose a sprint to view its issues.
      </p>
      <p v-if="selectedSprintId && sprintIssuesTruncated" role="status">
        Showing the first page of this sprint. Narrow the filters to see fewer, more relevant issues.
      </p>
      <div v-if="selectedSprintId" class="jira-sprint-issues" aria-label="Issues in selected sprint">
        <template v-if="!boardColumns.length">
          <p v-if="!sprintIssues.length && !contentPending" class="jira-empty">No issues in this sprint.</p>
          <button
            v-for="issue in sprintIssues"
            :key="issue.ref.issueId"
            type="button"
            class="jira-issue"
            v-bind="navRow(issue)"
            :aria-describedby="
              issuePreviewVisible && issuePreviewIssue?.ref.issueId === issue.ref.issueId
                ? 'jira-issue-preview'
                : undefined
            "
            @click="openIssue(issue, $event)"
            @mouseenter="scheduleIssuePreview(issue, $event)"
            @mouseleave="dismissIssuePreview"
            @focus="scheduleIssuePreview(issue, $event)"
            @blur="dismissIssuePreview"
            @keydown.esc="dismissIssuePreview"
          >
            <span class="jira-issue__key">{{ issue.ref.issueKey }}</span
            ><strong>{{ issue.summary }}</strong
            ><small>{{ issue.status }}</small>
          </button>
        </template>
        <div
          v-else-if="unmappedBoardIssues.length"
          class="jira-sprint-issues__unmapped"
          aria-label="Other sprint issues"
        >
          <strong>Other sprint issues</strong>
          <button
            v-for="issue in unmappedBoardIssues"
            :key="issue.ref.issueId"
            type="button"
            class="jira-issue"
            v-bind="navRow(issue)"
            :aria-describedby="
              issuePreviewVisible && issuePreviewIssue?.ref.issueId === issue.ref.issueId
                ? 'jira-issue-preview'
                : undefined
            "
            @click="openIssue(issue, $event)"
            @mouseenter="scheduleIssuePreview(issue, $event)"
            @mouseleave="dismissIssuePreview"
            @focus="scheduleIssuePreview(issue, $event)"
            @blur="dismissIssuePreview"
            @keydown.esc="dismissIssuePreview"
          >
            <span class="jira-issue__key">{{ issue.ref.issueKey }}</span
            ><strong>{{ issue.summary }}</strong
            ><small>{{ issue.status }}</small>
          </button>
        </div>
        <JiraBusyButton
          v-if="sprintIssuesHasMore"
          class="button button--ghost"
          :busy="isBusy('sprint-more')"
          :disabled="isBusy('sprint')"
          :title="
            isBusy('sprint')
              ? 'Wait until this sprint finishes loading.'
              : 'Load the next page of issues in this sprint from Jira.'
          "
          @click="loadMoreSprintIssues"
        >
          Load more sprint issues
        </JiraBusyButton>
      </div>
    </section>
  </section>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import JiraBranchBadge from "./JiraBranchBadge.vue";
import JiraBusyButton from "./JiraBusyButton.vue";
import JiraIssueDetail from "./JiraIssueDetail.vue";
import JiraIssueBadges from "./JiraIssueBadges.vue";
import JiraPerson from "./JiraPerson.vue";
import { classifyJiraIssueType } from "./jiraIssueBadges";
import { jiraStatusTone } from "./jiraPeople";
import { useJiraDrawerWidth } from "./pane/useJiraDrawerWidth.js";

import { useJiraPaneContext } from "./pane/jira-pane-context.js";

const {
  activeView,
  boardColumns,
  boardDrawerMode,
  boardLoading,
  boardMode,
  boardSprints,
  cardLabels,
  contentPending,
  dismissIssuePreview,
  isBusy,
  isCompactPane,
  isOwnJiraAssignee,
  issuePreviewIssue,
  issuePreviewVisible,
  loadMoreSprintIssues,
  nativeBoardColumnViews,
  nativeListPresentation,
  navRow,
  openIssue,
  rememberNativeBoardCardsScroll,
  rememberNativeBoardHorizontalScroll,
  scheduleIssuePreview,
  selected,
  selectedSprintId,
  store,
  sprintIssues,
  sprintIssuesHasMore,
  sprintIssuesTruncated,
  unmappedBoardIssues,
} = useJiraPaneContext();

const splitRef = ref<HTMLElement | null>(null);
const columnsRef = ref<HTMLElement | null>(null);
const drawer = useJiraDrawerWidth(() => store.myActiveProfileId || "default", splitRef);

// A compact board shows about one column at a time, so a row of column chips says where you are and jumps.
const columnJumpVisible = computed(
  () =>
    activeView.value === "board" &&
    isCompactPane.value &&
    !nativeListPresentation.value &&
    !boardDrawerMode.value &&
    boardColumns.value.length > 0 &&
    nativeBoardColumnViews.value.length > 1 &&
    columnsOverflow.value,
);
const currentColumn = ref(0);
const columnsOverflow = ref(false);
let columnsObserver: ResizeObserver | null = null;
function measureColumnsOverflow() {
  const container = columnsRef.value;
  columnsOverflow.value = Boolean(container && container.scrollWidth > container.clientWidth + 2);
}
watch(columnsRef, (container) => {
  columnsObserver?.disconnect();
  columnsObserver = null;
  if (!container || typeof ResizeObserver === "undefined") return;
  columnsObserver = new ResizeObserver(measureColumnsOverflow);
  columnsObserver.observe(container);
  measureColumnsOverflow();
});
watch(
  () => nativeBoardColumnViews.value.length,
  () => void nextTick(measureColumnsOverflow),
);
onBeforeUnmount(() => columnsObserver?.disconnect());
function columnElements() {
  return [...(columnsRef.value?.querySelectorAll<HTMLElement>(":scope > .jira-board-column") ?? [])];
}
function onColumnsScroll(event: Event) {
  rememberNativeBoardHorizontalScroll(event);
  const container = columnsRef.value;
  if (!container) return;
  const columns = columnElements();
  if (container.scrollLeft >= container.scrollWidth - container.clientWidth - 2) {
    currentColumn.value = Math.max(0, columns.length - 1);
    return;
  }
  const left = container.getBoundingClientRect().left;
  let best = 0;
  let bestDistance = Infinity;
  columns.forEach((column, index) => {
    const distance = Math.abs(column.getBoundingClientRect().left - left);
    if (distance < bestDistance) {
      best = index;
      bestDistance = distance;
    }
  });
  currentColumn.value = best;
}
function jumpToColumn(index: number) {
  currentColumn.value = index;
  const container = columnsRef.value;
  const column = columnElements().at(index);
  if (!container || !column) return;
  // Scroll the columns strip only; scrollIntoView would also move the pane and push the chips out of view.
  const left = column.getBoundingClientRect().left - container.getBoundingClientRect().left + container.scrollLeft;
  container.scrollTo?.({ left, behavior: "smooth" });
}

watch(
  () => [boardDrawerMode.value, selected.value?.ref.issueId] as const,
  async ([open, issueId]) => {
    if (!open || !issueId) return;
    await nextTick();
    const card = [...(columnsRef.value?.querySelectorAll<HTMLElement>(".jira-board-issue") ?? [])].find(
      (element) => element.dataset.issueId === issueId,
    );
    (card?.closest(".jira-board-column") as HTMLElement | null)?.scrollIntoView?.({
      block: "nearest",
      inline: "nearest",
    });
  },
);
</script>
