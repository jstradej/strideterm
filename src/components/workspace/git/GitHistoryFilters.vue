<template>
  <div class="git-branches__filters" :class="{ 'git-branches__filters--compact': compact }">
    <CustomSelect
      v-model="userFilter"
      :options="userSelectOptions"
      :searchable="knownAuthors.length > 8"
      search-placeholder="Filter authors…"
      class="git-branches__cselect git-branches__cselect--user"
    />
    <CustomSelect
      v-model="dateFilter"
      :options="dateSelectOptions"
      class="git-branches__cselect git-branches__cselect--date"
    />
    <template v-if="dateFilter === 'custom'">
      <input
        v-model="customSince"
        type="date"
        class="git-branches__filter-date"
        title="Show commits on or after this date"
      />
      <span class="git-branches__filter-sep">→</span>
      <input
        v-model="customUntil"
        type="date"
        class="git-branches__filter-date"
        title="Show commits on or before this date"
      />
    </template>
    <div ref="pathsRoot" :class="compact ? 'git-branches__paths-menu' : 'git-branches__paths-plain'">
      <button
        v-if="compact"
        type="button"
        class="git-branches__paths-button"
        :class="pathsFilter.length > 0 && 'git-branches__sort-active'"
        :aria-expanded="pathsOpen ? 'true' : 'false'"
        @click="pathsOpen = !pathsOpen"
      >
        {{ pathsFilter.length ? `Paths: ${pathsFilter.length}` : "Paths" }}
        <span aria-hidden="true">▾</span>
      </button>
      <div
        v-if="!compact || pathsOpen"
        class="git-branches__filter-paths"
        :class="compact && 'git-branches__paths-popover'"
      >
        <span v-for="p in pathsFilter" :key="p" class="git-branches__path-chip" :title="`Filtering on ${p}`">
          {{ p }}
          <button
            type="button"
            class="git-branches__path-chip-x"
            aria-label="Remove path filter"
            @click="removePathFilter(p)"
          >
            ×
          </button>
        </span>
        <input
          v-model="pathsInput"
          type="text"
          class="git-branches__filter-paths-input"
          placeholder="+ path…"
          title="Limit to commits touching this path (relative). Press Enter to add."
          @keydown.enter.prevent="addPathFilter"
        />
      </div>
    </div>
    <span v-if="compact" class="git-history-picker__sep" aria-hidden="true"></span>
    <button
      type="button"
      class="button button--ghost button--small"
      :class="topoOrder && 'git-branches__sort-active'"
      :title="
        topoOrder
          ? 'Topological order (--topo-order). Click to switch to date order.'
          : 'Date order (--date-order). Click to switch to topological order.'
      "
      @click="topoOrder = !topoOrder"
    >
      Sort: {{ topoOrder ? "Topo" : "Date" }}
    </button>
    <button
      type="button"
      class="button button--ghost button--small"
      :title="
        viewMode === 'graph'
          ? 'Show commits as a flat list (History-style). Same data, simpler view.'
          : 'Show commits as a graph with branch lanes and topology.'
      "
      @click="viewMode = viewMode === 'graph' ? 'flat' : 'graph'"
    >
      View: {{ viewMode === "graph" ? "Graph" : "Flat" }}
    </button>
    <CustomSelect
      v-model="graphLimit"
      :options="limitSelectOptions"
      class="git-branches__cselect git-branches__cselect--limit"
    />
    <BranchSelectPopover
      v-if="baseBranchOptions.length > 0"
      v-model="compareBase"
      :options="baseBranchOptions"
      :default-branch="defaultBranch"
      :default-remote="defaultRemote"
      :remote-names="remoteNames"
      button-label-prefix="Compare: "
      off-label="Compare: off"
      off-value=""
      placeholder="Compare: off"
      search-placeholder="Filter branches…"
      class="git-branches__cselect git-branches__cselect--compare"
    />
    <label
      v-if="compareBase"
      class="git-branches__filter git-branches__filter--inline"
      title="Switch from base..HEAD (only your work) to base...HEAD (your work + commits on base since fork)."
    >
      <input v-model="includeBaseUpdates" type="checkbox" />
      Include base updates
    </label>
    <button
      v-if="!compact"
      type="button"
      class="button button--ghost button--small"
      :disabled="!hasActiveFilters"
      :title="hasActiveFilters ? 'Clear all commit filters' : 'No active filters to clear'"
      @click="onClear"
    >
      Clear
    </button>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from "vue";
import CustomSelect from "../../common/CustomSelect.vue";
import BranchSelectPopover from "./BranchSelectPopover.vue";
import { useDismissable } from "../../../composables/useDismissable.js";

const props = withDefaults(
  defineProps<{
    knownAuthors?: string[];
    baseBranchOptions?: string[];
    defaultBranch?: string;
    defaultRemote?: string;
    remoteNames?: string[];
    hasActiveFilters?: boolean;
    compact?: boolean;
  }>(),
  {
    knownAuthors: () => [],
    baseBranchOptions: () => [],
    defaultBranch: "",
    defaultRemote: "",
    remoteNames: () => [],
    hasActiveFilters: false,
    compact: false,
  },
);

const emit = defineEmits<{ clear: [] }>();

const userFilter = defineModel<string>("userFilter", { default: "" });
const dateFilter = defineModel<string>("dateFilter", { default: "all" });
const customSince = defineModel<string>("customSince", { default: "" });
const customUntil = defineModel<string>("customUntil", { default: "" });
const pathsFilter = defineModel<string[]>("pathsFilter", { default: () => [] });
const topoOrder = defineModel<boolean>("topoOrder", { default: false });
const viewMode = defineModel<"graph" | "flat">("viewMode", { default: "graph" });
const graphLimit = defineModel<number>("graphLimit", { default: 500 });
const compareBase = defineModel<string>("compareBase", { default: "" });
const includeBaseUpdates = defineModel<boolean>("includeBaseUpdates", { default: false });

const pathsInput = ref("");
const pathsOpen = ref(false);
const pathsRoot = ref<HTMLElement | null>(null);
useDismissable(pathsOpen, pathsRoot, {
  onDismiss: () => {
    pathsOpen.value = false;
  },
});

const limitOptions = [100, 300, 500, 1000, 2000];

const userSelectOptions = computed(() => [
  { value: "", label: props.compact ? "User" : "User: All" },
  ...props.knownAuthors.map((a) => ({ value: a, label: props.compact && a === userFilter.value ? `User: ${a}` : a })),
]);

const dateSelectOptions = computed(() => [
  { value: "all", label: props.compact ? "Date" : "Date: All" },
  ...[
    { value: "today", label: "Today" },
    { value: "week", label: "This week" },
    { value: "month", label: "This month" },
    { value: "custom", label: "Custom…" },
  ].map((o) => ({
    ...o,
    label: props.compact && o.value === dateFilter.value && o.value !== "custom" ? `Date: ${o.label}` : o.label,
  })),
]);

const limitSelectOptions = limitOptions.map((n) => ({ value: n, label: `Limit: ${n.toLocaleString()}` }));

function addPathFilter() {
  const p = pathsInput.value.trim().replace(/^[\\/]+|[\\/]+$/g, "");
  if (!p || p.includes("..")) return;
  if (!pathsFilter.value.includes(p)) pathsFilter.value = [...pathsFilter.value, p];
  pathsInput.value = "";
}

function removePathFilter(p: string) {
  pathsFilter.value = pathsFilter.value.filter((x) => x !== p);
}

function onClear() {
  pathsInput.value = "";
  emit("clear");
}
</script>

<style scoped>
.git-branches__filters {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  padding: 6px 10px;
  border-bottom: 1px solid var(--border);
  background: rgba(var(--tint), 0.02);
  flex: 0 0 auto;
}

.git-branches__filters--compact {
  display: contents;
}

.git-branches__paths-plain {
  display: contents;
}

.git-branches__filter-date {
  font-size: 12px;
  height: 24px;
  padding: 0 6px;
  border-radius: 4px;
  border: 1px solid var(--border);
  background: rgba(0, 0, 0, 0.25);
  color: var(--text);
  width: 130px;
  font-variant-numeric: tabular-nums;
}

.git-branches__cselect {
  flex: 0 0 auto;
  width: auto;
}
.git-branches__cselect :deep(.custom-select__button) {
  padding: 3px 8px;
  font-size: 12px;
  background: rgba(0, 0, 0, 0.25);
  height: 24px;
  line-height: 1;
}
.git-branches__filters--compact .git-branches__cselect :deep(.custom-select__button) {
  height: 28px;
}
.git-branches__cselect--user :deep(.custom-select__button) {
  min-width: 110px;
  max-width: 180px;
}
.git-branches__cselect--date :deep(.custom-select__button) {
  min-width: 110px;
}
.git-branches__filters--compact .git-branches__cselect--user :deep(.custom-select__button),
.git-branches__filters--compact .git-branches__cselect--date :deep(.custom-select__button) {
  min-width: 0;
}
.git-branches__cselect--limit :deep(.custom-select__button) {
  min-width: 110px;
}
.git-branches__cselect--compare :deep(.custom-select__button) {
  min-width: 150px;
  max-width: 220px;
}

.git-branches__filter {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  color: var(--muted);
  cursor: pointer;
  user-select: none;
  white-space: nowrap;
  flex: 0 0 auto;
}

.git-branches__filter input {
  margin: 0;
}

.git-branches__filter-sep {
  color: var(--muted);
  font-size: 11px;
}

.git-branches__filter-paths {
  display: flex;
  align-items: center;
  gap: 4px;
  flex: 1 1 160px;
  min-width: 140px;
  flex-wrap: wrap;
  padding: 2px 4px;
  border: 1px solid var(--border);
  background: rgba(0, 0, 0, 0.25);
  border-radius: 4px;
  min-height: 24px;
}

.git-branches__filter-paths-input {
  flex: 1;
  min-width: 80px;
  border: none;
  background: transparent;
  color: var(--text);
  font-size: 12px;
  outline: none;
  padding: 2px 4px;
}

.git-branches__paths-menu {
  position: relative;
  flex: 0 0 auto;
}

.git-branches__paths-button {
  height: 28px;
  padding: 0 8px;
  font-size: 12px;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: rgba(0, 0, 0, 0.25);
  color: var(--text);
  cursor: pointer;
  white-space: nowrap;
}

.git-branches__paths-popover {
  position: absolute;
  top: calc(100% + 4px);
  left: 0;
  z-index: 30;
  width: 260px;
  background: var(--surface);
  box-shadow: 0 6px 18px rgba(0, 0, 0, 0.35);
}

.git-branches__path-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 1px 4px 1px 6px;
  border-radius: 3px;
  background: rgba(255, 164, 36, 0.18);
  color: var(--accent);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  max-width: 200px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.git-branches__path-chip-x {
  border: none;
  background: transparent;
  color: inherit;
  cursor: pointer;
  font-size: 13px;
  line-height: 1;
  padding: 0 2px;
}

.git-branches__path-chip-x:hover {
  color: #fff;
}

.git-branches__sort-active {
  background: rgba(255, 164, 36, 0.18) !important;
  color: var(--accent) !important;
}

.git-history-picker__sep {
  width: 1px;
  height: 18px;
  background: var(--border);
  flex: 0 0 auto;
}
</style>
