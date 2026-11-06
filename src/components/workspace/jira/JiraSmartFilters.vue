<template>
  <div class="jira-smart-filters" role="group" aria-label="Smart filters">
    <template v-for="(group, index) in groups" :key="group.id">
      <span v-if="index" class="jira-smart-filters__sep" aria-hidden="true"></span>
      <button
        v-for="chip in group.chips"
        :key="chip.id"
        class="jira-smart-chip"
        :class="{ 'jira-smart-chip--blocked': isBlocked(chip.id) }"
        type="button"
        :aria-pressed="smartFilters.includes(chip.id)"
        :aria-disabled="isBlocked(chip.id) ? 'true' : undefined"
        :title="chipTitle(chip.id)"
        @click="onChip(chip.id)"
      >
        {{ chip.label }}
      </button>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue";
import {
  JIRA_SMART_FILTER_GROUPS,
  JIRA_SMART_FILTER_TITLES,
  JIRA_SMART_FILTERS,
  jiraSmartFilterNeedsIdentity,
  type JiraSmartFilterId,
} from "../../../../electron/shared/jira-smart-filters";
import { useJiraPaneContext } from "./pane/jira-pane-context.js";

const { openInlineHumanIdentitySetup, selectedConnection, smartFilters, toggleSmartFilter } = useJiraPaneContext();

const groups = computed(() =>
  JIRA_SMART_FILTER_GROUPS.map((id) => ({ id, chips: JIRA_SMART_FILTERS.filter((chip) => chip.group === id) })),
);
const hasIdentity = computed(() => Boolean(selectedConnection.value?.ownIdentity));

function isBlocked(id: JiraSmartFilterId) {
  return jiraSmartFilterNeedsIdentity(id) && !hasIdentity.value;
}
function chipTitle(id: JiraSmartFilterId) {
  if (isBlocked(id)) return "Tell strIDEterm which Jira user you are first. Click to choose your Jira identity.";
  const active = smartFilters.value.includes(id);
  return active ? `${JIRA_SMART_FILTER_TITLES[id]}. Click again to remove this filter.` : JIRA_SMART_FILTER_TITLES[id];
}
function onChip(id: JiraSmartFilterId) {
  if (isBlocked(id)) openInlineHumanIdentitySetup("list");
  else void toggleSmartFilter(id);
}
</script>

<style scoped>
.jira-smart-filters {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px;
  min-width: 0;
}
.jira-smart-filters__sep {
  width: 1px;
  height: 16px;
  margin: 0 4px;
  background: var(--border);
}
.jira-smart-chip {
  padding: 2px 10px;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: transparent;
  color: var(--muted);
  font: inherit;
  font-size: 12px;
  line-height: 20px;
  white-space: nowrap;
  cursor: pointer;
}
.jira-smart-chip:hover,
.jira-smart-chip:focus-visible {
  border-color: color-mix(in srgb, var(--accent) 45%, var(--border));
  color: var(--text);
}
.jira-smart-chip[aria-pressed="true"] {
  border-color: var(--accent);
  background: color-mix(in srgb, var(--accent) 16%, transparent);
  color: var(--text);
}
.jira-smart-chip--blocked {
  opacity: 0.5;
}
.jira-inbox--compact .jira-smart-filters {
  flex-wrap: nowrap;
  overflow-x: auto;
  scrollbar-width: none;
}
</style>
