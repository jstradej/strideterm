<template>
  <div v-if="visibleKeys.length" class="jira-facets" role="group" aria-label="Narrow the loaded issues">
    <template v-for="(key, index) in visibleKeys" :key="key">
      <span v-if="index" class="jira-facets__sep" aria-hidden="true"></span>
      <template v-if="key === 'assignee'">
        <button
          v-for="option in facetOptions.assignee"
          :key="option.value || 'unassigned'"
          class="jira-facet jira-facet--person"
          type="button"
          :aria-label="`${option.value || 'Unassigned'}, ${option.count} loaded`"
          :aria-pressed="issueFacets.assignee === option.value"
          :title="personTitle(option)"
          @click="pick('assignee', option.value)"
        >
          <JiraPerson :display-name="option.value" size="sm" :show-name="false" :me="isMe(option.value)" hide-title />
          <span class="jira-facet__count">{{ option.count }}</span>
        </button>
      </template>
      <template v-else>
        <button
          v-for="option in facetOptions[key]"
          :key="option.value"
          class="jira-facet"
          type="button"
          :aria-pressed="issueFacets[key] === option.value"
          :title="textTitle(key, option)"
          @click="pick(key, option.value)"
        >
          {{ option.value }} <span class="jira-facet__count">{{ option.count }}</span>
        </button>
      </template>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue";
import JiraPerson from "./JiraPerson.vue";
import { JIRA_FACET_KEYS, type JiraFacetKey, type JiraFacetOption } from "./jiraIssueFacets";
import { useJiraPaneContext } from "./pane/jira-pane-context.js";
import type { JiraIssue } from "./pane/jira-pane-types.js";

const { facetOptions, isOwnJiraAssignee, issueFacets } = useJiraPaneContext();

const NOUN: Record<JiraFacetKey, string> = {
  status: "status",
  type: "type",
  priority: "priority",
  assignee: "assignee",
};

const visibleKeys = computed(() =>
  JIRA_FACET_KEYS.filter((key) => facetOptions.value[key].length > 1 || issueFacets.value[key] !== null),
);

function isMe(assignee: string) {
  return isOwnJiraAssignee({ assignee } as JiraIssue);
}
function pick(key: JiraFacetKey, value: string) {
  issueFacets.value = { ...issueFacets.value, [key]: issueFacets.value[key] === value ? null : value };
}
function textTitle(key: JiraFacetKey, option: JiraFacetOption) {
  return issueFacets.value[key] === option.value
    ? `Showing only ${NOUN[key]} ${option.value}. Click again to show every ${NOUN[key]}.`
    : `Show only the loaded issues with ${NOUN[key]} ${option.value}.`;
}
function personTitle(option: JiraFacetOption) {
  const name = option.value || "no assignee";
  return issueFacets.value.assignee === option.value
    ? `Showing only issues of ${name}. Click again to show everyone.`
    : `Show only the loaded issues of ${name} (${option.count}).`;
}
</script>

<style scoped>
.jira-facets {
  grid-column: 1 / -1;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px;
  min-width: 0;
}
.jira-facets__sep {
  width: 1px;
  height: 16px;
  margin: 0 4px;
  background: var(--border);
}
.jira-facet {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 1px 8px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: transparent;
  color: var(--muted);
  font: inherit;
  font-size: 12px;
  line-height: 20px;
  white-space: nowrap;
  cursor: pointer;
}
.jira-facet--person {
  padding: 1px 6px 1px 2px;
  border-radius: 999px;
}
.jira-facet:hover,
.jira-facet:focus-visible {
  border-color: color-mix(in srgb, var(--accent) 45%, var(--border));
  color: var(--text);
}
.jira-facet[aria-pressed="true"] {
  border-color: var(--accent);
  background: color-mix(in srgb, var(--accent) 16%, transparent);
  color: var(--text);
}
.jira-facet__count {
  font-size: 11px;
  opacity: 0.75;
}
.jira-inbox--compact .jira-facets {
  flex-wrap: nowrap;
  overflow-x: auto;
  scrollbar-width: none;
}
</style>
