<template>
  <div class="git-branches__filters" :class="{ 'git-branches__filters--compact': compact }">
    <div v-if="compact" ref="userRoot" class="git-history-menu">
      <button
        ref="userButton"
        type="button"
        class="git-history-menu__button git-branches__user-button"
        :class="userFilter && 'git-branches__sort-active'"
        aria-haspopup="menu"
        :aria-expanded="userOpen ? 'true' : 'false'"
        :title="userButtonText"
        @click="toggleUser"
        @keydown="onButtonKeydown($event, userOpen, openUser)"
      >
        <span class="git-history-menu__value">{{ userButtonText }}</span>
        <span class="git-history-menu__arrow" aria-hidden="true">▾</span>
      </button>
      <Teleport to="body">
        <div
          v-if="userOpen"
          ref="userMenu"
          class="git-history-menu__menu"
          :class="userMode === 'search' && 'git-history-menu__menu--search'"
          :style="userStyle"
          role="menu"
          tabindex="-1"
          @keydown="onUserKeydown"
        >
          <input
            v-if="userMode === 'search'"
            ref="userSearch"
            v-model="userQuery"
            type="search"
            class="git-history-menu__search"
            placeholder="Authors…"
            aria-label="Search authors"
          />
          <div class="git-history-menu__list">
            <template v-for="(row, idx) in userRows" :key="idx">
              <div v-if="row.kind === 'section'" class="git-history-menu__section" role="presentation">
                {{ row.label }}
              </div>
              <div v-else-if="row.kind === 'note'" class="git-history-menu__note" role="presentation">
                {{ row.label }}
              </div>
              <div
                v-else
                role="menuitem"
                :class="[
                  'git-history-menu__row',
                  {
                    'git-history-menu__row--active': userActive === idx,
                    'git-history-menu__row--selected': row.kind === 'author' && row.value === userFilter,
                  },
                ]"
                @mousedown.prevent
                @click="activateUserRow(row)"
                @mouseenter="userActive = idx"
              >
                <span class="git-history-menu__gutter" aria-hidden="true"></span>
                <span class="git-history-menu__label" :title="row.label">{{ row.label }}</span>
              </div>
            </template>
          </div>
        </div>
      </Teleport>
    </div>
    <CustomSelect
      v-else
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
    <div v-if="compact" ref="pathsRoot" class="git-history-menu">
      <button
        ref="pathsButton"
        type="button"
        class="git-history-menu__button git-branches__paths-button"
        :class="pathsFilter.length > 0 && 'git-branches__sort-active'"
        aria-haspopup="dialog"
        :aria-expanded="pathsOpen ? 'true' : 'false'"
        @click="togglePaths"
        @keydown="onButtonKeydown($event, pathsOpen, openPaths)"
      >
        <span class="git-history-menu__value">{{ pathsFilter.length ? `Paths: ${pathsFilter.length}` : "Paths" }}</span>
        <span class="git-history-menu__arrow" aria-hidden="true">▾</span>
      </button>
      <Teleport to="body">
        <div
          v-if="pathsOpen"
          ref="pathsMenu"
          class="git-history-menu__menu git-history-menu__menu--paths"
          :style="pathsStyle"
          role="dialog"
          aria-label="Path filters"
          @keydown.esc.prevent.stop="closePaths(true)"
        >
          <div class="git-history-menu__field">
            <input
              ref="pathsField"
              v-model="pathsInput"
              type="text"
              class="git-history-menu__input"
              aria-label="Add path filter"
              placeholder="Path relative to the repository root…"
              @keydown.enter.prevent="addPathFilter"
            />
            <div class="git-history-menu__hint">Press Enter to add. Commits touching any listed path are shown.</div>
          </div>
          <div class="git-history-menu__list">
            <div
              v-for="p in pathsFilter"
              :key="p"
              class="git-history-menu__row git-history-menu__row--static"
              :title="`Filtering on ${p}`"
            >
              <span class="git-history-menu__gutter" aria-hidden="true"></span>
              <span class="git-history-menu__label">{{ p }}</span>
              <button
                type="button"
                class="git-history-menu__remove"
                :aria-label="`Remove path filter ${p}`"
                @click="removePathFilter(p)"
              >
                ✕
              </button>
            </div>
            <template v-if="recentPathChoices.length">
              <div class="git-history-menu__section" role="presentation">Recent</div>
              <div
                v-for="p in recentPathChoices"
                :key="p"
                class="git-history-menu__row"
                role="button"
                :title="p"
                @click="addPath(p)"
              >
                <span class="git-history-menu__gutter" aria-hidden="true"></span>
                <span class="git-history-menu__label">{{ p }}</span>
              </div>
            </template>
          </div>
        </div>
      </Teleport>
    </div>
    <div v-else class="git-branches__paths-plain">
      <div class="git-branches__filter-paths">
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
      button-title="Choose a base branch to compare with the current checked-out branch (HEAD)."
      class="git-branches__cselect git-branches__cselect--compare"
    />
    <label
      v-if="compareBase"
      class="git-branches__filter git-branches__filter--inline"
      title="Adds commits present only on the selected base branch to the commit history for the checked-out branch. It does not change the diff preview."
    >
      <input
        v-model="includeBaseUpdates"
        type="checkbox"
        title="Adds commits present only on the selected base branch to the commit history for the checked-out branch. It does not change the diff preview."
      />
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
import { computed, nextTick, ref, watch } from "vue";
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

const RECENT_LIMIT = 8;
const RECENT_AUTHORS_KEY = "strideterm:git-history:recent-authors";
const RECENT_PATHS_KEY = "strideterm:git-history:recent-paths";

function loadRecent(key: string): string[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(key) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string").slice(0, RECENT_LIMIT) : [];
  } catch {
    return [];
  }
}

function rememberRecent(key: string, value: string): string[] {
  const next = [value, ...loadRecent(key).filter((v) => v !== value)].slice(0, RECENT_LIMIT);
  try {
    localStorage.setItem(key, JSON.stringify(next));
  } catch {
    // storage unavailable: the list just is not remembered
  }
  return next;
}

function menuPosition(button: HTMLElement | null): Record<string, string> {
  if (!button) return {};
  const rect = button.getBoundingClientRect();
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const flipAbove = vh - rect.bottom - 8 < 200 && rect.top - 8 > vh - rect.bottom - 8;
  return {
    left: `${Math.max(8, Math.min(rect.left, vw - 340))}px`,
    ...(flipAbove ? { bottom: `${vh - rect.top + 3}px` } : { top: `${rect.bottom + 3}px` }),
  };
}

function onButtonKeydown(e: KeyboardEvent, isOpen: boolean, open: () => void) {
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    if (!isOpen) open();
  }
}

type UserRow =
  { kind: "section" | "note" | "clear" | "select"; label: string } | { kind: "author"; label: string; value: string };

const userOpen = ref(false);
const userMode = ref<"menu" | "search">("menu");
const userQuery = ref("");
const userActive = ref(-1);
const userStyle = ref<Record<string, string>>({});
const userRoot = ref<HTMLElement | null>(null);
const userButton = ref<HTMLButtonElement | null>(null);
const userMenu = ref<HTMLElement | null>(null);
const userSearch = ref<HTMLInputElement | null>(null);
const recentAuthors = ref<string[]>([]);

const userButtonText = computed(() => (userFilter.value ? `User: ${userFilter.value}` : "User"));

const userRows = computed<UserRow[]>(() => {
  if (userMode.value === "search") {
    const needle = userQuery.value.trim().toLowerCase();
    const hits = props.knownAuthors.filter((a) => !needle || a.toLowerCase().includes(needle));
    const shown = hits.slice(0, 300).map((a): UserRow => ({ kind: "author", label: a, value: a }));
    if (!shown.length) return [{ kind: "note", label: "No matching authors" }];
    if (hits.length > shown.length) {
      shown.push({ kind: "note", label: `… ${hits.length - shown.length} more — refine the search` });
    }
    return shown;
  }
  const rows: UserRow[] = [];
  if (userFilter.value) rows.push({ kind: "clear", label: "All users" });
  rows.push({ kind: "select", label: "Select…" });
  if (recentAuthors.value.length) {
    rows.push({ kind: "section", label: "Recent" });
    for (const a of recentAuthors.value) rows.push({ kind: "author", label: a, value: a });
  }
  return rows;
});

function userSelectable(row: UserRow | undefined) {
  return !!row && row.kind !== "section" && row.kind !== "note";
}

function firstUserRow() {
  return userRows.value.findIndex(userSelectable);
}

watch(userQuery, () => {
  userActive.value = firstUserRow();
});

function openUser() {
  if (userOpen.value) return;
  closePaths(false);
  userStyle.value = menuPosition(userButton.value);
  recentAuthors.value = loadRecent(RECENT_AUTHORS_KEY);
  userMode.value = "menu";
  userQuery.value = "";
  userOpen.value = true;
  userActive.value = firstUserRow();
  nextTick(() => userMenu.value?.focus());
}

function closeUser(refocus: boolean) {
  if (!userOpen.value) return;
  userOpen.value = false;
  userMode.value = "menu";
  userQuery.value = "";
  if (refocus) userButton.value?.focus();
}

function toggleUser() {
  if (userOpen.value) closeUser(false);
  else openUser();
}

function enterUserSearch() {
  userMode.value = "search";
  userQuery.value = "";
  userActive.value = firstUserRow();
  nextTick(() => userSearch.value?.focus());
}

function pickAuthor(value: string) {
  recentAuthors.value = rememberRecent(RECENT_AUTHORS_KEY, value);
  userFilter.value = value;
  closeUser(true);
}

function activateUserRow(row: UserRow) {
  if (row.kind === "clear") {
    userFilter.value = "";
    closeUser(true);
  } else if (row.kind === "select") enterUserSearch();
  else if (row.kind === "author") pickAuthor(row.value);
}

function moveUser(dir: number) {
  const rows = userRows.value;
  let next = userActive.value + dir;
  while (next >= 0 && next < rows.length && !userSelectable(rows[next])) next += dir;
  if (next < 0 || next >= rows.length) return;
  userActive.value = next;
  nextTick(() =>
    userMenu.value
      ?.querySelector<HTMLElement>(".git-history-menu__row--active")
      ?.scrollIntoView?.({ block: "nearest" }),
  );
}

function onUserKeydown(e: KeyboardEvent) {
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    moveUser(e.key === "ArrowDown" ? 1 : -1);
  } else if (e.key === "Enter") {
    e.preventDefault();
    const row = userRows.value[userActive.value];
    if (row && userSelectable(row)) activateUserRow(row);
  } else if (e.key === "Escape") {
    e.preventDefault();
    e.stopPropagation();
    if (userMode.value === "search") {
      userMode.value = "menu";
      userQuery.value = "";
      userActive.value = firstUserRow();
      nextTick(() => userMenu.value?.focus());
    } else closeUser(true);
  } else if (e.key === "Tab") closeUser(false);
}

const pathsInput = ref("");
const pathsOpen = ref(false);
const pathsStyle = ref<Record<string, string>>({});
const pathsRoot = ref<HTMLElement | null>(null);
const pathsButton = ref<HTMLButtonElement | null>(null);
const pathsMenu = ref<HTMLElement | null>(null);
const pathsField = ref<HTMLInputElement | null>(null);
const recentPaths = ref<string[]>([]);
const recentPathChoices = computed(() => recentPaths.value.filter((p) => !pathsFilter.value.includes(p)));

function openPaths() {
  if (pathsOpen.value) return;
  closeUser(false);
  pathsStyle.value = menuPosition(pathsButton.value);
  recentPaths.value = loadRecent(RECENT_PATHS_KEY);
  pathsOpen.value = true;
  nextTick(() => pathsField.value?.focus());
}

function closePaths(refocus: boolean) {
  if (!pathsOpen.value) return;
  pathsOpen.value = false;
  if (refocus) pathsButton.value?.focus();
}

function togglePaths() {
  if (pathsOpen.value) closePaths(false);
  else openPaths();
}

useDismissable(userOpen, [userRoot, userMenu], { onDismiss: () => closeUser(false), eventName: "mousedown" });
useDismissable(pathsOpen, [pathsRoot, pathsMenu], { onDismiss: () => closePaths(false), eventName: "mousedown" });

const limitOptions = [100, 300, 500, 1000, 2000];

const userSelectOptions = computed(() => [
  { value: "", label: "User: All" },
  ...props.knownAuthors.map((a) => ({ value: a, label: a })),
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

function addPath(raw: string) {
  const p = raw.trim().replace(/^[\\/]+|[\\/]+$/g, "");
  if (!p || p.includes("..")) return;
  if (!pathsFilter.value.includes(p)) pathsFilter.value = [...pathsFilter.value, p];
  if (props.compact) recentPaths.value = rememberRecent(RECENT_PATHS_KEY, p);
  pathsInput.value = "";
}

function addPathFilter() {
  addPath(pathsInput.value);
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

.git-history-menu {
  position: relative;
  flex: 0 0 auto;
  max-width: 280px;
}
.git-history-menu__button {
  display: flex;
  align-items: center;
  gap: 6px;
  max-width: 280px;
  padding: 5px 8px;
  background: rgba(var(--tint), 0.04);
  border: 1px solid var(--border);
  border-radius: 3px;
  color: var(--text);
  font: inherit;
  font-size: 13px;
  line-height: 1.2;
  cursor: pointer;
  text-align: left;
}
.git-history-menu__button:hover {
  background: rgba(var(--tint), 0.08);
}
.git-history-menu__button:focus-visible {
  outline: 1px solid var(--accent);
  outline-offset: -1px;
}
.git-history-menu__value {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.git-history-menu__arrow {
  flex-shrink: 0;
  color: var(--muted);
  font-size: 10px;
}
.git-history-menu__menu {
  position: fixed;
  z-index: 10050;
  display: flex;
  flex-direction: column;
  min-width: 200px;
  max-width: 360px;
  max-height: 60vh;
  overflow: hidden;
  padding: 4px 0;
  background: var(--menu-bg);
  border: 1px solid rgba(var(--tint), 0.16);
  border-radius: 4px;
  box-shadow: var(--menu-shadow);
  font-size: 13px;
  outline: none;
}
.git-history-menu__menu--search {
  width: 320px;
  padding: 0;
}
.git-history-menu__menu--paths {
  min-width: 320px;
  max-width: 480px;
}
.git-history-menu__list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 4px 0;
}
.git-history-menu__search {
  flex-shrink: 0;
  padding: 6px 10px;
  background: rgba(var(--tint), 0.05);
  border: 0;
  border-bottom: 1px solid var(--border);
  color: var(--text);
  font: inherit;
  font-size: 13px;
  outline: none;
}
.git-history-menu__search:focus {
  background: rgba(var(--tint), 0.08);
}
.git-history-menu__field {
  flex-shrink: 0;
  padding: 4px 10px 6px;
  border-bottom: 1px solid var(--border);
}
.git-history-menu__input {
  width: 100%;
  box-sizing: border-box;
  padding: 5px 8px;
  background: rgba(var(--tint), 0.05);
  border: 1px solid var(--border);
  border-radius: 3px;
  color: var(--text);
  font: inherit;
  font-size: 13px;
  outline: none;
}
.git-history-menu__input:focus {
  border-color: var(--accent);
}
.git-history-menu__hint {
  margin-top: 4px;
  color: var(--muted);
  font-size: 12px;
}
.git-history-menu__row {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 26px;
  flex-shrink: 0;
  padding: 0 12px 0 8px;
  color: var(--text);
  cursor: pointer;
  white-space: nowrap;
}
.git-history-menu__row--static {
  cursor: default;
}
.git-history-menu__row:hover,
.git-history-menu__row--active {
  background: rgba(var(--tint), 0.1);
}
.git-history-menu__row--selected {
  color: var(--accent);
}
.git-history-menu__gutter {
  flex: 0 0 18px;
  width: 18px;
}
.git-history-menu__label {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}
.git-history-menu__remove {
  flex-shrink: 0;
  border: none;
  background: transparent;
  color: var(--muted);
  cursor: pointer;
  font-size: 12px;
  padding: 0 2px;
}
.git-history-menu__remove:hover {
  color: var(--text);
}
.git-history-menu__section {
  padding: 6px 12px 2px 34px;
  color: var(--muted);
  font-size: 12px;
}
.git-history-menu__note {
  padding: 4px 12px 4px 34px;
  color: var(--muted);
  font-size: 12px;
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
