<template>
  <div ref="jiraRootRef" class="workspace-pane__body workspace-pane__body--git jira-inbox jira-inbox--popout">
    <p v-if="error" class="jira-inline-error" role="alert">{{ error }}</p>
    <JiraIssueDetail />
  </div>
</template>

<script setup lang="ts">
import { provide, watch } from "vue";

import JiraIssueDetail from "./jira/JiraIssueDetail.vue";
import { createJiraPaneContext } from "./jira/pane/createJiraPaneContext.js";
import { jiraPaneContextKey } from "./jira/pane/jira-pane-context.js";
import { useNotificationStore } from "../../stores/notifications.js";
import "./jira/jira-inbox.css";

const props = defineProps<{
  profileId: string;
  workspaceId: string;
  issue: { connectionId: string; issueId: string; issueKey: string };
}>();

const ctx = createJiraPaneContext({
  workspaceId: props.workspaceId,
  jiraViewId: "issues",
  showHeader: false,
  connectionsOnly: false,
  detached: true,
  detachedIssue: props.issue,
});
provide(jiraPaneContextKey, ctx);
const { error, jiraRootRef, selected, store } = ctx;
const notifications = useNotificationStore();

watch(error, (text) => {
  if (text)
    notifications.pushEphemeralToast({
      title: `Could not open ${props.issue.issueKey}`,
      body: text,
      kind: "error",
      durationMs: 8000,
    });
});
watch(
  selected,
  (issue) => {
    if (!issue) return;
    const key = issue.ref?.issueKey || issue.key || props.issue.issueKey;
    document.title = issue.summary || issue.title ? `${key} · ${issue.summary || issue.title}` : key;
  },
  { immediate: true },
);
// The window belongs to the profile it was opened in; its Jira calls follow the opener's profile.
watch(
  () => store.myActiveProfileId,
  (profileId) => {
    if (profileId && profileId !== props.profileId) window.close();
  },
);
</script>
