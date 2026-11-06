<template>
  <Teleport to="body">
    <aside
      v-if="issuePreviewVisible && issuePreviewIssue"
      id="jira-issue-preview"
      ref="issuePreviewRef"
      class="jira-issue-preview"
      role="tooltip"
      :style="issuePreviewStyle"
    >
      <strong class="jira-issue-preview__key">{{ issuePreviewIssue.ref.issueKey }}</strong>
      <p class="jira-issue-preview__summary">{{ issuePreviewDetails?.summary || issuePreviewIssue.summary }}</p>
      <div class="jira-issue-preview__meta">
        <span
          class="jira-status-pill"
          :data-tone="
            jiraStatusTone(
              issuePreviewDetails?.status || issuePreviewIssue.status,
              issuePreviewDetails?.statusCategory || issuePreviewIssue.statusCategory,
            )
          "
          >{{ issuePreviewDetails?.status || issuePreviewIssue.status || "Unknown status" }}</span
        >
        <JiraPerson
          :display-name="issuePreviewDetails?.assignee || issuePreviewIssue.assignee"
          size="sm"
          class="jira-issue-preview__person"
        />
        <JiraIssueBadges
          v-if="
            issuePreviewDetails?.issueType ||
            issuePreviewIssue.issueType ||
            issuePreviewDetails?.priority ||
            issuePreviewIssue.priority
          "
          :issue-type="issuePreviewDetails?.issueType || issuePreviewIssue.issueType || 'Unknown type'"
          :priority="issuePreviewDetails?.priority || issuePreviewIssue.priority || 'Unspecified'"
          compact
        />
      </div>
      <p v-if="issuePreviewDetails?.description" class="jira-issue-preview__description">
        {{ issuePreviewDetails.description }}
      </p>
      <p v-if="issuePreviewDetails?.cache?.refreshError" class="jira-issue-preview__loading">
        Showing saved data. {{ issuePreviewDetails.cache.refreshError.message }}
      </p>
      <p v-else-if="issuePreviewLoading" class="jira-issue-preview__loading">Loading issue preview…</p>
      <p v-else-if="issuePreviewError" class="jira-issue-preview__loading">{{ issuePreviewError }}</p>
    </aside>
  </Teleport>
</template>

<script setup lang="ts">
import JiraIssueBadges from "./JiraIssueBadges.vue";
import JiraPerson from "./JiraPerson.vue";
import { jiraStatusTone } from "./jiraPeople";

import { useJiraPaneContext } from "./pane/jira-pane-context.js";

const {
  issuePreviewDetails,
  issuePreviewError,
  issuePreviewIssue,
  issuePreviewLoading,
  issuePreviewRef,
  issuePreviewStyle,
  issuePreviewVisible,
} = useJiraPaneContext();
</script>
