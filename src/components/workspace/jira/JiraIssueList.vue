<template>
  <section
    v-if="!(boardId && boardMode === 'sprints' && selectedSprintId)"
    ref="jiraResultsRef"
    class="jira-results"
    tabindex="-1"
    aria-label="Jira issues"
    :aria-busy="issuesLoading ? 'true' : undefined"
  >
    <div v-if="issues.length" class="jira-list-toolbar" role="group" aria-label="Filter and sort issues">
      <input
        v-if="!filterSheetMode"
        v-model="issueFilterText"
        class="jira-list-toolbar__search"
        type="search"
        autocomplete="off"
        placeholder="Filter results by key, summary, person or status…"
        aria-label="Filter results"
      />
      <div class="jira-list-toolbar__row">
        <div class="jira-list-toolbar__groups" role="group" aria-label="Filter issues by status">
          <button
            v-for="group in issueStatusGroups"
            :key="group.value"
            class="jira-list-toolbar__group"
            :data-tone="group.tone"
            type="button"
            :aria-pressed="issueStatusFilter === group.value"
            :title="
              group.value === 'all'
                ? 'Show the loaded issues in every status.'
                : `Show only the loaded issues whose status counts as ${group.label}.`
            "
            @click="issueStatusFilter = group.value"
          >
            {{ group.label }} <span>{{ group.count }}</span>
          </button>
        </div>
        <label
          v-if="!filterSheetMode"
          class="jira-list-toolbar__sort"
          title="Sorts the loaded issues. A JQL search on one connection is run again in this order."
          >Sort<CustomSelect v-model="issueSort" :options="issueSortOptions" @change="applyIssueSort"
        /></label>
      </div>
      <JiraResultFacets v-if="!filterSheetMode" />
      <p
        v-if="!filterSheetMode || visibleIssueList.length < issues.length"
        class="jira-list-toolbar__count"
        role="status"
      >
        Showing {{ visibleIssueList.length }} of {{ issues.length }} loaded issues
        <template v-if="visibleIssueList.length < issues.length">
          ·
          <button
            class="button button--ghost button--small"
            type="button"
            title="Clear the text filter, the status group and the facets so every loaded issue shows."
            @click="clearIssueListFilter"
          >
            Clear
          </button>
        </template>
      </p>
    </div>
    <template v-if="!issues.length && contentPending">
      <div class="jira-skeleton" aria-hidden="true">
        <span v-for="row in 4" :key="row" class="jira-skeleton__row"></span>
      </div>
      <span class="jira-sr-only" role="status">Loading Jira issues…</span>
    </template>
    <div v-else-if="!issues.length" class="jira-empty jira-empty--search">
      <strong>{{
        searchFailed ? "Search failed" : searchHasRun ? "No matching Jira issues" : "Find your Jira issues"
      }}</strong>
      <p v-if="!searchFailed">
        {{
          searchHasRun
            ? "These filters are active. Remove one to widen the search."
            : "Search by issue key or words above. Use Advanced search and JQL for precise queries."
        }}
      </p>
      <ul
        v-if="searchHasRun && !searchFailed && hasEmptyResultFilters"
        class="jira-filter-chips"
        aria-label="Active filters"
      >
        <li v-if="emptyResultScope.query">
          <span class="jira-filter-chip" :title="emptyResultScope.jql">
            <span class="jira-filter-chip__text">Query: {{ emptyResultScope.query }}</span>
            <button
              type="button"
              class="jira-filter-chip__remove"
              aria-label="Remove query"
              title="Clear this query and go back to the search box."
              @click="removeSearchQuery"
            >
              ✕
            </button>
          </span>
        </li>
        <li v-if="emptyResultScope.projectKeys.length && connectionId !== '__all__'">
          <span class="jira-filter-chip">
            <span class="jira-filter-chip__text">Projects: {{ emptyResultScope.projectKeys.join(", ") }}</span>
            <button
              type="button"
              class="jira-filter-chip__remove"
              aria-label="Remove project filter"
              :title="`Search every project instead of only ${emptyResultScope.projectKeys.join(', ')}. This view keeps the new scope.`"
              @click="searchAllProjects"
            >
              ✕
            </button>
          </span>
        </li>
      </ul>
      <div class="jira-empty__actions">
        <button
          v-if="searchHasRun && !searchFailed && emptyResultScope.projectKeys.length && connectionId !== '__all__'"
          class="button"
          type="button"
          :title="`Search every project instead of only ${emptyResultScope.projectKeys.join(', ')}. This view keeps the new scope.`"
          @click="searchAllProjects"
        >
          Search all projects
        </button>
        <button
          class="button jira-empty--action"
          type="button"
          title="Move the cursor to the issue search box above. Press / to get there from anywhere in the pane."
          @click="focusQuickSearch"
        >
          {{ searchFailed ? "Focus issue search" : searchHasRun ? "Edit issue search" : "Search by key or words" }}
        </button>
      </div>
    </div>
    <p v-if="searchTruncated" class="jira-help" role="status">
      {{
        connectionId === "__all__"
          ? "Showing up to 50 issues per connection. Load more results to continue."
          : "Jira limited this result set. Refine the JQL to see a narrower set."
      }}
    </p>
    <p v-if="issues.length && !visibleIssueList.length" class="jira-list-toolbar__empty" role="status">
      No loaded issue matches this filter.
      <button
        class="button button--ghost button--small"
        type="button"
        title="Clear the text filter and the status group so every loaded issue shows."
        @click="clearIssueListFilter"
      >
        Clear filter
      </button>
    </p>
    <button
      v-for="issue in visibleIssueList"
      :key="`${issue.ref?.connectionId || ''}:${issue.ref?.issueId || issue.id || issue.ref?.issueKey || issue.key}`"
      type="button"
      class="jira-issue"
      v-bind="navRow(issue)"
      :class="{
        selected:
          (selected?.ref?.connectionId === issue.ref?.connectionId && selected?.ref?.issueId === issue.ref?.issueId) ||
          issuePendingKey === `${issue.ref?.connectionId}:${issue.ref?.issueId}`,
      }"
      :title="`Show the details of ${issue.ref?.issueKey || issue.key}. Use j/k or the arrow keys to move between issues.`"
      @click="openIssue(issue, $event)"
    >
      <span class="jira-issue__topline">
        <JiraIssueBadges
          v-if="issue.issueType"
          :issue-type="issue.issueType"
          only="type"
          minimal
          class="jira-issue__type"
        />
        <JiraIssueBadges v-if="issue.priority" :priority="issue.priority" only="priority" minimal />
        <span class="jira-issue__key">{{ issue.ref?.issueKey || issue.key }}</span>
        <JiraBranchBadge :issue-ref="issue.ref" />
        <span class="jira-status-pill" :data-tone="jiraStatusTone(issue.status, issue.statusCategory)">{{
          issue.status || "Open"
        }}</span>
      </span>
      <strong class="jira-issue__summary" :title="issue.summary || issue.title">{{
        issue.summary || issue.title || issue.ref?.issueKey || issue.key
      }}</strong>
      <span class="jira-issue__footer">
        <JiraPerson :display-name="issue.assignee" size="sm" :me="isOwnJiraAssignee(issue)" />
        <small v-if="issue.sourceLabel">Source: {{ issue.sourceLabel }}</small>
        <time
          v-if="issue.updated"
          class="jira-issue__updated"
          :datetime="issue.updated"
          :title="formatJiraDate(issue.updated)"
          >{{ formatJiraRelativeTime(issue.updated) }}</time
        >
      </span>
    </button>
    <JiraBusyButton
      v-if="searchHasMore && !boardId"
      class="button button--ghost"
      :busy="isBusy('search-more')"
      :disabled="isBusy('search')"
      :title="
        isBusy('search')
          ? 'Wait until the current search finishes.'
          : 'Load the next page of results for this search from Jira.'
      "
      @click="loadMore"
    >
      Load more results
    </JiraBusyButton>
  </section>
</template>

<script setup lang="ts">
import { computed } from "vue";
import CustomSelect from "../../common/CustomSelect.vue";
import JiraBranchBadge from "./JiraBranchBadge.vue";
import JiraBusyButton from "./JiraBusyButton.vue";
import JiraIssueBadges from "./JiraIssueBadges.vue";
import JiraPerson from "./JiraPerson.vue";
import JiraResultFacets from "./JiraResultFacets.vue";
import { formatJiraRelativeTime, jiraStatusTone } from "./jiraPeople";

import { useJiraPaneContext } from "./pane/jira-pane-context.js";
import { useJiraFilterSheetMode } from "./pane/useJiraFilterSheetMode.js";

const {
  applyIssueSort,
  boardId,
  boardMode,
  clearActiveSearch,
  clearIssueListFilter,
  emptyResultScope,
  formatJiraDate,
  connectionId,
  contentPending,
  focusQuickSearch,
  isBusy,
  isOwnJiraAssignee,
  issueFilterText,
  issueSort,
  issuePendingKey,
  issueSortOptions,
  issueStatusFilter,
  issueStatusGroups,
  issues,
  issuesLoading,
  jiraResultsRef,
  loadMore,
  navRow,
  openIssue,
  searchAllProjects,
  searchFailed,
  searchHasMore,
  searchHasRun,
  searchRefreshing,
  searchTruncated,
  selected,
  selectedSprintId,
  visibleIssueList,
} = useJiraPaneContext();
const filterSheetMode = useJiraFilterSheetMode();

const hasEmptyResultFilters = computed(
  () => Boolean(emptyResultScope.value.query) || emptyResultScope.value.projectKeys.length > 0,
);
function removeSearchQuery() {
  clearActiveSearch();
  focusQuickSearch();
}
</script>
