<template>
  <nav class="jira-view-tabs subtabs" aria-label="Jira views">
    <button
      v-for="tab in tabs"
      :key="tab.id"
      class="jira-view-tab subtabs__tab"
      :class="{ 'jira-view-tab--active subtabs__tab--active': activeView === tab.id }"
      type="button"
      :aria-current="activeView === tab.id ? 'page' : undefined"
      :title="tab.title"
      @click="activeView = tab.id"
    >
      {{ tab.label }}
    </button>
  </nav>
</template>

<script setup lang="ts">
import { useJiraPaneContext } from "./pane/jira-pane-context.js";

const { activeView } = useJiraPaneContext();
const tabs = [
  { id: "issues", label: "Issues", title: "Search and filter Jira issues on the selected connection." },
  { id: "board", label: "Board", title: "Show a Jira board with its columns, sprints and quick filters." },
  { id: "settings", label: "Settings", title: "Manage Jira connections: add, test, edit or disconnect them." },
] as const;
</script>
