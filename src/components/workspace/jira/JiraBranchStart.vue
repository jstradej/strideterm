<template>
  <Teleport to="body">
    <div
      v-if="branchDialogOpen && selected.ref"
      class="overlay jira-branch-overlay"
      @click.self="closeBranchStart"
      @keydown.esc.stop="closeBranchStart"
    >
      <JiraStartDevelopmentDialog />
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { computed } from "vue";
import JiraStartDevelopmentDialog from "./JiraStartDevelopmentDialog.vue";
import type { JiraIssue } from "./pane/jira-pane-types.js";
import { useJiraPaneContext } from "./pane/jira-pane-context.js";

const { branchDialogOpen, closeBranchStart, selected: selectedIssue } = useJiraPaneContext();
const selected = computed(() => selectedIssue.value as JiraIssue);
</script>
