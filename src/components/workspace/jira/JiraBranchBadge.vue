<template>
  <span v-if="title" class="jira-branch-badge" role="img" :aria-label="title" :title="title">
    <JiraMenuIcon name="branch" />
  </span>
</template>

<script setup lang="ts">
import { computed } from "vue";
import JiraMenuIcon from "./JiraMenuIcon.vue";
import { useJiraPaneContext } from "./pane/jira-pane-context.js";

const props = defineProps<{ issueRef?: { connectionId: string; issueId: string } }>();
const { branchWorkspaceTitle } = useJiraPaneContext();
const title = computed(() => branchWorkspaceTitle(props.issueRef));
</script>
