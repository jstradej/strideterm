<template>
  <div
    v-if="activeView === 'issues' || (boardIssueDetailOpen && !boardDrawerMode)"
    class="jira-columns"
    :class="{ 'jira-columns--empty': !issues.length && !selected && !issueLoading && !contentPending }"
    :style="boardIssueDetailOpen ? { display: 'grid' } : undefined"
  >
    <JiraIssueList />
    <JiraIssueDetail />
  </div>
</template>

<script setup lang="ts">
import JiraIssueList from "./JiraIssueList.vue";
import JiraIssueDetail from "./JiraIssueDetail.vue";

import { useJiraPaneContext } from "./pane/jira-pane-context.js";

const { activeView, boardDrawerMode, boardIssueDetailOpen, contentPending, issueLoading, issues, selected } =
  useJiraPaneContext();
</script>
