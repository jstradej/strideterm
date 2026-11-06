<template>
  <section
    v-if="nativeListPresentation && !boardIssueDetailOpen"
    ref="nativeIssueListRef"
    class="jira-native-issue-list"
    aria-label="Jira issues in this view"
    tabindex="-1"
    :aria-busy="contentPending ? 'true' : undefined"
    @scroll="rememberNativeListScroll"
  >
    <div class="jira-native-issue-list__toolbar">
      <input
        v-model="issueFilterText"
        class="jira-list-toolbar__search"
        type="search"
        autocomplete="off"
        placeholder="Filter results…"
        aria-label="Filter results"
      />
      <p class="jira-native-issue-list__count" role="status">
        Showing {{ nativeVisibleIssues.length }} of {{ nativeIssueSource.length }} loaded issues
      </p>
    </div>
    <template v-if="!nativeIssueSource.length && (contentPending || nativeViewSync?.state === 'syncing')">
      <div class="jira-skeleton" aria-hidden="true">
        <span v-for="row in 4" :key="row" class="jira-skeleton__row"></span>
      </div>
      <span class="jira-sr-only" role="status">Loading issues from Jira…</span>
    </template>
    <p
      v-else-if="
        !contentPending &&
        !nativeVisibleIssues.length &&
        (nativeIssueSource.length > 0 || nativeViewSync?.state !== 'error')
      "
      class="jira-list-toolbar__empty"
      role="status"
    >
      {{ nativeIssueSource.length ? "No issue matches this filter." : "No issues in this view." }}
      <button
        v-if="nativeIssueSource.length"
        class="button button--ghost button--small"
        type="button"
        title="Clear the text filter and the status filter so every loaded issue shows."
        @click="clearNativeIssueFilter"
      >
        Clear filter
      </button>
    </p>
    <button
      v-for="issue in nativeVisibleIssues"
      :key="`${issue.ref.connectionId}:${issue.ref.issueId}`"
      class="jira-issue jira-native-issue-list__item"
      v-bind="navRow(issue)"
      :data-issue-id="issue.ref.issueId"
      :class="{
        selected:
          (selected?.ref?.connectionId === issue.ref.connectionId && selected?.ref?.issueId === issue.ref.issueId) ||
          issuePendingKey === `${issue.ref.connectionId}:${issue.ref.issueId}`,
      }"
      type="button"
      :title="`Show the details of ${issue.ref.issueKey}. Use j/k or the arrow keys to move between issues.`"
      @click="openIssue(issue, $event)"
    >
      <span class="jira-issue__topline">
        <JiraIssueBadges v-if="issue.issueType" :issue-type="issue.issueType" only="type" minimal />
        <strong class="jira-issue__key">{{ issue.ref.issueKey }}</strong>
        <JiraBranchBadge :issue-ref="issue.ref" />
        <span class="jira-status-pill" :data-tone="jiraStatusTone(issue.status, issue.statusCategory)">{{
          issue.status || "Unknown status"
        }}</span>
        <JiraIssueBadges v-if="issue.priority" :priority="issue.priority" only="priority" minimal />
      </span>
      <strong class="jira-native-issue-list__summary" :title="issue.summary">{{
        issue.summary || issue.ref.issueKey
      }}</strong>
      <span class="jira-issue__footer">
        <JiraPerson :display-name="issue.assignee" size="sm" :me="isOwnJiraAssignee(issue)" />
        <time
          v-if="issue.updated"
          class="jira-issue__updated"
          :datetime="issue.updated"
          :title="formatJiraDate(issue.updated)"
          >{{ formatJiraRelativeTime(issue.updated) }}</time
        >
      </span>
    </button>
  </section>
</template>

<script setup lang="ts">
import JiraBranchBadge from "./JiraBranchBadge.vue";
import JiraIssueBadges from "./JiraIssueBadges.vue";
import JiraPerson from "./JiraPerson.vue";
import { formatJiraRelativeTime, jiraStatusTone } from "./jiraPeople";

import { useJiraPaneContext } from "./pane/jira-pane-context.js";

const {
  boardIssueDetailOpen,
  clearNativeIssueFilter,
  contentPending,
  formatJiraDate,
  isOwnJiraAssignee,
  issueFilterText,
  issuePendingKey,
  nativeIssueListRef,
  nativeIssueSource,
  nativeListPresentation,
  nativeViewSync,
  nativeVisibleIssues,
  navRow,
  openIssue,
  rememberNativeListScroll,
  selected,
} = useJiraPaneContext();
</script>
