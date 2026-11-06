<template>
  <button
    class="button button--ghost jira-filter-sheet-toggle"
    type="button"
    :aria-expanded="open ? 'true' : 'false'"
    aria-haspopup="dialog"
    title="Quick filters, narrowing and sort for the loaded issues."
    @click="open ? close() : show()"
  >
    Filters<span v-if="activeCount" class="jira-filter-sheet-toggle__count">{{ activeCount }}</span>
  </button>
  <Teleport v-if="jiraRootRef" :to="jiraRootRef">
    <section
      v-if="open"
      ref="sheetRef"
      class="jira-filter-sheet"
      role="dialog"
      aria-label="Filters"
      tabindex="-1"
      @keydown.esc.stop="close"
    >
      <header class="jira-filter-sheet__head">
        <strong>Filters</strong>
        <button
          v-if="listNarrowed"
          class="button button--ghost button--small"
          type="button"
          title="Clear the text filter, the status group and the facets so every loaded issue shows."
          @click="clearIssueListFilter"
        >
          Clear
        </button>
        <button class="button button--small" type="button" @click="close">Done</button>
      </header>
      <div class="jira-filter-sheet__body">
        <section v-if="smartFiltersAvailable" aria-label="Quick filters">
          <h3>Quick filters</h3>
          <JiraSmartFilters />
        </section>
        <section v-if="issues.length" aria-label="Narrow the loaded issues">
          <h3>Narrow the loaded issues</h3>
          <input
            v-model="issueFilterText"
            class="jira-filter-sheet__search"
            type="search"
            autocomplete="off"
            placeholder="Key, summary, person or status…"
            aria-label="Filter results"
          />
          <JiraResultFacets />
        </section>
        <label
          v-if="issues.length"
          class="jira-filter-sheet__sort"
          title="Sorts the loaded issues. A JQL search on one connection is run again in this order."
          >Sort<CustomSelect v-model="issueSort" :options="issueSortOptions" @change="applyIssueSort"
        /></label>
        <p class="jira-filter-sheet__count" role="status">
          Showing {{ visibleIssueList.length }} of {{ issues.length }} loaded issues
        </p>
      </div>
    </section>
  </Teleport>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import CustomSelect from "../../common/CustomSelect.vue";
import JiraResultFacets from "./JiraResultFacets.vue";
import JiraSmartFilters from "./JiraSmartFilters.vue";
import { useJiraPaneContext } from "./pane/jira-pane-context.js";
import { useJiraFilterSheetMode } from "./pane/useJiraFilterSheetMode.js";

const {
  applyIssueSort,
  clearIssueListFilter,
  connectionId,
  connectionsOnly,
  issueFacets,
  issueFilterText,
  issueSort,
  issueSortOptions,
  issueStatusFilter,
  issues,
  jiraRootRef,
  selected,
  smartFilters,
  visibleIssueList,
} = useJiraPaneContext();
const sheetMode = useJiraFilterSheetMode();
const open = ref(false);
const sheetRef = ref<HTMLElement | null>(null);

const smartFiltersAvailable = computed(
  () => Boolean(connectionId.value) && connectionId.value !== "__all__" && !connectionsOnly.value,
);
const facetCount = computed(() => Object.values(issueFacets.value).filter((value) => value !== null).length);
const activeCount = computed(
  () => smartFilters.value.length + facetCount.value + (issueFilterText.value.trim() ? 1 : 0),
);
const listNarrowed = computed(
  () => facetCount.value > 0 || Boolean(issueFilterText.value.trim()) || issueStatusFilter.value !== "all",
);

function show() {
  open.value = true;
  void nextTick(() => sheetRef.value?.focus({ preventScroll: true }));
}
function close() {
  open.value = false;
}
watch([sheetMode, selected], ([mode, issue]) => {
  if (!mode || issue) close();
});
</script>
