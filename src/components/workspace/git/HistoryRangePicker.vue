<template>
  <div ref="rootRef" :class="['history-range-picker', { 'history-range-picker--disabled': disabled }]">
    <button
      ref="buttonRef"
      type="button"
      class="history-range-picker__button"
      aria-label="History reference"
      aria-haspopup="menu"
      :aria-expanded="open ? 'true' : 'false'"
      :data-value="modelValue"
      :title="buttonText"
      :disabled="disabled"
      @click="toggle"
      @keydown="onButtonKeydown"
    >
      <span class="history-range-picker__value">{{ buttonText }}</span>
      <span class="history-range-picker__arrow" aria-hidden="true">▾</span>
    </button>
    <Teleport to="body">
      <div v-if="open" ref="menusRef" @keydown="onMenuKeydown">
        <div
          v-if="mode === 'search'"
          class="history-range-picker__menu history-range-picker__menu--search"
          :style="rootStyle"
        >
          <input
            ref="searchRef"
            v-model="query"
            type="search"
            class="history-range-picker__search"
            placeholder="Branches and tags…"
            aria-label="Search history references"
            @keydown="onSearchKeydown"
          />
          <ul class="history-range-picker__list" role="listbox" tabindex="-1">
            <template v-for="(item, idx) in searchRows" :key="idx">
              <li v-if="item.kind === 'section'" class="history-range-picker__section" role="presentation">
                {{ item.label }}
              </li>
              <li v-else-if="item.kind === 'note'" class="history-range-picker__note" role="presentation">
                {{ item.label }}
              </li>
              <li
                v-else
                role="option"
                :data-index="idx"
                :aria-selected="item.value === modelValue ? 'true' : 'false'"
                :class="[
                  'history-range-picker__row',
                  {
                    'history-range-picker__row--active': searchActive === idx,
                    'history-range-picker__row--selected': item.value === modelValue,
                  },
                ]"
                @mousedown.prevent
                @click="pick(item.value)"
                @mouseenter="searchActive = idx"
              >
                <span class="history-range-picker__label" :title="item.label">{{ item.label }}</span>
              </li>
            </template>
          </ul>
        </div>
        <template v-else>
          <div
            v-for="(items, level) in levels"
            :key="level"
            class="history-range-picker__menu"
            role="menu"
            tabindex="-1"
            :data-level="level"
            :style="level === 0 ? rootStyle : levelStyles[level] || HIDDEN_STYLE"
          >
            <template v-for="(item, i) in items" :key="i">
              <div v-if="item.kind === 'section'" class="history-range-picker__section" role="presentation">
                {{ item.label }}
              </div>
              <div v-else-if="item.kind === 'sep'" class="history-range-picker__sep" role="separator"></div>
              <div v-else-if="item.kind === 'note'" class="history-range-picker__note" role="presentation">
                {{ item.label }}
              </div>
              <div
                v-else
                role="menuitem"
                :data-index="i"
                :aria-haspopup="item.kind === 'sub' ? 'menu' : undefined"
                :aria-expanded="item.kind === 'sub' ? (openPath[level] === i ? 'true' : 'false') : undefined"
                :class="[
                  'history-range-picker__row',
                  {
                    'history-range-picker__row--active': activeLevel === level && activeIdx[level] === i,
                    'history-range-picker__row--open': item.kind === 'sub' && openPath[level] === i,
                    'history-range-picker__row--selected': item.kind === 'leaf' && item.value === modelValue,
                  },
                ]"
                @mousedown.prevent
                @click="activate(level, i)"
                @mouseenter="onRowEnter(level, i)"
              >
                <span v-if="item.kind === 'leaf' && item.star" class="history-range-picker__star" aria-hidden="true"
                  >★</span
                >
                <span class="history-range-picker__label" :title="item.label">{{ item.label }}</span>
                <span v-if="item.kind === 'leaf' && item.suffix" class="history-range-picker__suffix">{{
                  item.suffix
                }}</span>
                <span v-if="item.kind === 'sub'" class="history-range-picker__caret" aria-hidden="true">▸</span>
              </div>
            </template>
          </div>
        </template>
      </div>
    </Teleport>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useDismissable } from "../../../composables/useDismissable.js";
import { buildBranchForest, type BranchForestNode } from "./branch-forest.js";

type MenuItem =
  | { kind: "section"; label: string }
  | { kind: "sep" }
  | { kind: "note"; label: string }
  | { kind: "action"; label: string }
  | { kind: "leaf"; label: string; value: string; star?: boolean; suffix?: string }
  | { kind: "sub"; label: string; children: () => MenuItem[] };

type SearchRow =
  | { kind: "section"; label: string }
  | { kind: "note"; label: string }
  | { kind: "option"; value: string; label: string };

type LeafInfo = { suffix: string };

const props = withDefaults(
  defineProps<{
    modelValue: string;
    current?: string;
    favorites?: string[];
    recent?: string[];
    local?: string[];
    remotes?: string[];
    remoteNames?: string[];
    tags?: string[];
    defaultBranch?: string;
    defaultRemote?: string;
    loadingRef?: string;
    disabled?: boolean;
  }>(),
  {
    current: "",
    favorites: () => [],
    recent: () => [],
    local: () => [],
    remotes: () => [],
    remoteNames: () => [],
    tags: () => [],
    defaultBranch: "",
    defaultRemote: "",
    loadingRef: "",
    disabled: false,
  },
);

const emit = defineEmits<{ change: [value: string] }>();

const ALL = "__ALL__";
const MAX_TAGS = 200;
const MAX_SEARCH_ROWS = 500;
const HOVER_DELAY_MS = 120;
const HIDDEN_STYLE = { left: "-9999px", top: "0" };

const open = ref(false);
const mode = ref<"menu" | "search">("menu");
const openPath = ref<number[]>([]);
const activeLevel = ref(0);
const activeIdx = ref<number[]>([]);
const query = ref("");
const searchActive = ref(-1);
const rootRef = ref<HTMLElement | null>(null);
const buttonRef = ref<HTMLButtonElement | null>(null);
const menusRef = ref<HTMLElement | null>(null);
const searchRef = ref<HTMLInputElement | null>(null);
const rootStyle = ref<Record<string, string>>({});
const levelStyles = ref<Record<number, Record<string, string>>>({});
let hoverTimer: ReturnType<typeof setTimeout> | null = null;

const filterActive = computed(() => props.modelValue !== "" && props.modelValue !== ALL);

const buttonText = computed(() => {
  if (!filterActive.value) return "Branch";
  return `Branch: ${props.modelValue}${props.loadingRef === props.modelValue ? "…" : ""}`;
});

function forestToItems(nodes: BranchForestNode<LeafInfo>[]): MenuItem[] {
  return nodes.map((node): MenuItem => {
    if (node.kind === "folder") return { kind: "sub", label: node.label, children: () => forestToItems(node.children) };
    return { kind: "leaf", label: node.label, value: node.ref, suffix: node.payload.suffix };
  });
}

function localItems(): MenuItem[] {
  const forest = buildBranchForest<LeafInfo>(
    props.local.map((name) => ({
      path: name,
      ref: name,
      payload: { suffix: name === props.current ? " (working branch)" : "" },
    })),
    "local",
    (a, b) => {
      const aCur = a.ref === props.current ? 0 : 1;
      const bCur = b.ref === props.current ? 0 : 1;
      return aCur - bCur || a.label.localeCompare(b.label);
    },
  );
  return forestToItems(forest);
}

function remoteItems(remote: string, refs: string[]): MenuItem[] {
  const prefix = `${remote}/`;
  const defaultRemote = !props.defaultRemote || props.defaultRemote === remote;
  const isDefault = (ref: string) =>
    !!props.defaultBranch && defaultRemote && ref.slice(prefix.length) === props.defaultBranch;
  const forest = buildBranchForest<LeafInfo>(
    refs.map((ref) => ({ path: ref.slice(prefix.length), ref, payload: { suffix: isDefault(ref) ? "default" : "" } })),
    `remote:${remote}`,
    (a, b) => Number(!isDefault(a.ref)) - Number(!isDefault(b.ref)) || a.label.localeCompare(b.label),
  );
  return forestToItems(forest);
}

function tagItems(): MenuItem[] {
  const sorted = [...props.tags].sort((a, b) => a.localeCompare(b));
  const items: MenuItem[] = sorted.slice(0, MAX_TAGS).map((tag) => ({ kind: "leaf", label: tag, value: tag }));
  if (sorted.length > MAX_TAGS) {
    items.push({ kind: "note", label: `… and ${sorted.length - MAX_TAGS} more — use Select…` });
  }
  return items;
}

const rootItems = computed<MenuItem[]>(() => {
  const items: MenuItem[] = [];
  if (filterActive.value) items.push({ kind: "leaf", label: "All branches and tags", value: ALL });
  items.push({ kind: "action", label: "Select…" });
  if (props.recent.length) {
    const recent = props.recent;
    items.push({
      kind: "sub",
      label: "Recent",
      children: () => recent.map((name): MenuItem => ({ kind: "leaf", label: name, value: name })),
    });
  }
  items.push({ kind: "section", label: "Favorites" });
  items.push({ kind: "leaf", label: "HEAD", value: "HEAD", star: true });
  for (const name of props.favorites) {
    if (name !== "HEAD") items.push({ kind: "leaf", label: name, value: name, star: true });
  }
  items.push({ kind: "sep" });
  if (props.local.length) items.push({ kind: "sub", label: "Local", children: localItems });
  for (const remote of props.remoteNames) {
    const refs = props.remotes.filter((name) => name.startsWith(`${remote}/`));
    if (refs.length) items.push({ kind: "sub", label: `${remote}/…`, children: () => remoteItems(remote, refs) });
  }
  if (props.tags.length) items.push({ kind: "sub", label: "Tags", children: tagItems });
  return items;
});

const levels = computed<MenuItem[][]>(() => {
  const out: MenuItem[][] = [rootItems.value];
  for (const idx of openPath.value) {
    const item = out[out.length - 1][idx];
    if (item?.kind !== "sub") break;
    out.push(item.children());
  }
  return out;
});

const searchRows = computed<SearchRow[]>(() => {
  const needle = query.value.trim().toLowerCase();
  const match = (name: string) => !needle || name.toLowerCase().includes(needle);
  const rows: SearchRow[] = [];
  let count = 0;
  let truncated = 0;
  const addGroup = (label: string, names: string[]) => {
    const hits = names.filter(match);
    if (!hits.length) return;
    rows.push({ kind: "section", label });
    for (const value of hits) {
      if (count >= MAX_SEARCH_ROWS) truncated++;
      else {
        rows.push({ kind: "option", value, label: value });
        count++;
      }
    }
  };
  if (match("HEAD")) {
    rows.push({ kind: "option", value: "HEAD", label: "HEAD" });
    count++;
  }
  addGroup("Local", props.local);
  const grouped = new Set<string>();
  for (const remote of props.remoteNames) {
    const names = props.remotes.filter((name) => name.startsWith(`${remote}/`));
    names.forEach((name) => grouped.add(name));
    addGroup(remote, names);
  }
  addGroup(
    "Remotes",
    props.remotes.filter((name) => !grouped.has(name)),
  );
  addGroup("Tags", props.tags);
  if (truncated) rows.push({ kind: "note", label: `… and ${truncated} more — refine the search` });
  return rows;
});

function selectable(item: MenuItem | undefined): boolean {
  return item?.kind === "leaf" || item?.kind === "sub" || item?.kind === "action";
}

function setActive(level: number, index: number): void {
  const next = activeIdx.value.slice(0, level + 1);
  next[level] = index;
  activeIdx.value = next;
}

function clearHover(): void {
  if (hoverTimer) clearTimeout(hoverTimer);
  hoverTimer = null;
}

function pick(value: string): void {
  emit("change", value);
  closeMenu();
  buttonRef.value?.focus();
}

function closeDeeper(level: number): void {
  if (openPath.value.length > level) {
    openPath.value = openPath.value.slice(0, level);
    nextTick(positionLevels);
  }
}

function openSub(level: number, index: number, focusChild: boolean): void {
  const item = levels.value[level]?.[index];
  if (item?.kind !== "sub") return;
  openPath.value = [...openPath.value.slice(0, level), index];
  setActive(level, index);
  if (focusChild) {
    activeLevel.value = level + 1;
    setActive(level + 1, item.children().findIndex(selectable));
  } else {
    activeLevel.value = level;
  }
  nextTick(positionLevels);
}

function activate(level: number, index: number): void {
  clearHover();
  const item = levels.value[level]?.[index];
  if (item?.kind === "leaf") pick(item.value);
  else if (item?.kind === "action") enterSearch();
  else if (item?.kind === "sub") openSub(level, index, true);
}

function onRowEnter(level: number, index: number): void {
  clearHover();
  activeLevel.value = level;
  setActive(level, index);
  const item = levels.value[level]?.[index];
  if (item?.kind === "sub" && openPath.value[level] === index) return;
  hoverTimer = setTimeout(() => {
    hoverTimer = null;
    if (item?.kind === "sub") openSub(level, index, false);
    else closeDeeper(level);
  }, HOVER_DELAY_MS);
}

function enterSearch(): void {
  mode.value = "search";
  query.value = "";
  searchActive.value = searchRows.value.findIndex((row) => row.kind === "option");
  nextTick(() => searchRef.value?.focus());
}

function leaveSearch(): void {
  mode.value = "menu";
  query.value = "";
  nextTick(() => menuEl(0)?.focus());
}

watch(query, () => {
  const rows = searchRows.value;
  const first = query.value.trim() ? rows.findIndex((row) => row.kind === "option" && row.value !== "HEAD") : -1;
  searchActive.value = first >= 0 ? first : rows.findIndex((row) => row.kind === "option");
});

function menuEl(level: number): HTMLElement | null {
  return menusRef.value?.querySelector<HTMLElement>(`[data-level="${level}"]`) ?? null;
}

function positionLevels(): void {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const styles: Record<number, Record<string, string>> = {};
  for (let level = 1; level <= openPath.value.length; level++) {
    const el = menuEl(level);
    const anchor = menuEl(level - 1)?.querySelector<HTMLElement>(`[data-index="${openPath.value[level - 1]}"]`);
    if (!el || !anchor) continue;
    const rect = anchor.getBoundingClientRect();
    const width = el.offsetWidth;
    const height = el.offsetHeight;
    let left = rect.right - 2;
    if (left + width > vw - 8) left = Math.max(8, rect.left - width + 2);
    const top = Math.max(8, Math.min(rect.top - 4, vh - 8 - height));
    styles[level] = { left: `${left}px`, top: `${top}px` };
  }
  levelStyles.value = styles;
}

function updateRootPosition(): void {
  if (!buttonRef.value) return;
  const rect = buttonRef.value.getBoundingClientRect();
  const vh = window.innerHeight;
  const vw = window.innerWidth;
  const spaceBelow = vh - rect.bottom - 8;
  const spaceAbove = rect.top - 8;
  const flipAbove = spaceBelow < 200 && spaceAbove > spaceBelow;
  rootStyle.value = {
    left: `${Math.max(8, Math.min(rect.left, vw - 240))}px`,
    ...(flipAbove ? { bottom: `${vh - rect.top + 3}px` } : { top: `${rect.bottom + 3}px` }),
  };
}

function scrollActiveIntoView(): void {
  const el = menusRef.value?.querySelector<HTMLElement>(".history-range-picker__row--active");
  if (el?.scrollIntoView) el.scrollIntoView({ block: "nearest" });
}

function openMenu(): void {
  if (props.disabled || open.value) return;
  updateRootPosition();
  mode.value = "menu";
  openPath.value = [];
  levelStyles.value = {};
  activeLevel.value = 0;
  activeIdx.value = [];
  open.value = true;
  nextTick(() => menuEl(0)?.focus());
}

function closeMenu(): void {
  if (!open.value) return;
  clearHover();
  open.value = false;
  mode.value = "menu";
  openPath.value = [];
  query.value = "";
}

function toggle(): void {
  if (open.value) closeMenu();
  else openMenu();
}

function move(dir: number): void {
  const level = activeLevel.value;
  const items = levels.value[level] ?? [];
  const cur = activeIdx.value[level] ?? -1;
  let next = cur + dir;
  if (cur < 0 && dir < 0) next = items.length - 1;
  while (next >= 0 && next < items.length && !selectable(items[next])) next += dir;
  if (next < 0 || next >= items.length) return;
  closeDeeper(level + 1);
  setActive(level, next);
  nextTick(scrollActiveIntoView);
}

function closeDeepest(): boolean {
  if (!openPath.value.length) return false;
  openPath.value = openPath.value.slice(0, -1);
  activeLevel.value = openPath.value.length;
  nextTick(positionLevels);
  return true;
}

function onMenuKeydown(e: KeyboardEvent): void {
  if (mode.value !== "menu") return;
  const level = activeLevel.value;
  const index = activeIdx.value[level] ?? -1;
  const item = levels.value[level]?.[index];
  switch (e.key) {
    case "ArrowDown":
    case "ArrowUp":
      e.preventDefault();
      move(e.key === "ArrowDown" ? 1 : -1);
      break;
    case "ArrowRight":
      e.preventDefault();
      if (item?.kind === "sub") openSub(level, index, true);
      break;
    case "ArrowLeft":
      e.preventDefault();
      closeDeepest();
      break;
    case "Enter":
    case " ":
      e.preventDefault();
      if (selectable(item)) activate(level, index);
      break;
    case "Escape":
      e.preventDefault();
      e.stopPropagation();
      if (!closeDeepest()) {
        closeMenu();
        buttonRef.value?.focus();
      }
      break;
    case "Tab":
      closeMenu();
      break;
  }
}

function moveSearch(dir: number): void {
  const rows = searchRows.value;
  let next = searchActive.value + dir;
  while (next >= 0 && next < rows.length && rows[next].kind !== "option") next += dir;
  if (next < 0 || next >= rows.length) return;
  searchActive.value = next;
  nextTick(scrollActiveIntoView);
}

function onSearchKeydown(e: KeyboardEvent): void {
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    moveSearch(e.key === "ArrowDown" ? 1 : -1);
  } else if (e.key === "Enter") {
    e.preventDefault();
    const row = searchRows.value[searchActive.value];
    if (row?.kind === "option") pick(row.value);
  } else if (e.key === "Escape") {
    e.preventDefault();
    e.stopPropagation();
    leaveSearch();
  } else if (e.key === "Backspace" && !query.value) {
    e.preventDefault();
    leaveSearch();
  } else if (e.key === "Tab") {
    closeMenu();
  }
}

function onButtonKeydown(e: KeyboardEvent): void {
  if (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    if (!open.value) openMenu();
  } else if (e.key === "Escape" && open.value) {
    e.preventDefault();
    e.stopPropagation();
    closeMenu();
  } else if (e.key === "Tab") {
    closeMenu();
  }
}

useDismissable(open, [rootRef, menusRef], { onDismiss: closeMenu, eventName: "mousedown" });

function onReposition(): void {
  if (!open.value) return;
  updateRootPosition();
  nextTick(positionLevels);
}

onMounted(() => {
  window.addEventListener("blur", closeMenu);
  window.addEventListener("resize", onReposition);
});

onBeforeUnmount(() => {
  clearHover();
  window.removeEventListener("blur", closeMenu);
  window.removeEventListener("resize", onReposition);
});
</script>

<style scoped>
.history-range-picker {
  position: relative;
  display: inline-block;
  max-width: 280px;
}
.history-range-picker__button {
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
.history-range-picker__button:hover:not(:disabled) {
  background: rgba(var(--tint), 0.08);
}
.history-range-picker__button:focus-visible {
  outline: 1px solid var(--accent);
  outline-offset: -1px;
}
.history-range-picker__button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.history-range-picker__value {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: inherit;
  text-transform: none;
  letter-spacing: normal;
  color: inherit;
}
.history-range-picker__arrow {
  flex-shrink: 0;
  color: var(--muted);
  font-size: 10px;
  text-transform: none;
  letter-spacing: normal;
}
.history-range-picker__menu {
  position: fixed;
  z-index: 10050;
  display: flex;
  flex-direction: column;
  min-width: 200px;
  max-width: 360px;
  max-height: 60vh;
  overflow-y: auto;
  padding: 4px 0;
  background: var(--panel-elevated);
  border: 1px solid var(--border);
  border-radius: 4px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.5);
  font-size: 13px;
  outline: none;
}
.history-range-picker__menu--search {
  width: 320px;
  padding: 0;
  overflow: hidden;
}
.history-range-picker__search {
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
.history-range-picker__search:focus {
  background: rgba(var(--tint), 0.08);
}
.history-range-picker__list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  margin: 0;
  padding: 4px 0;
  list-style: none;
}
.history-range-picker__row {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  color: var(--text);
  cursor: pointer;
  white-space: nowrap;
}
.history-range-picker__row--active,
.history-range-picker__row--open {
  background: rgba(var(--tint), 0.12);
}
.history-range-picker__row--selected {
  color: var(--accent);
  font-weight: 600;
}
.history-range-picker__label {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}
.history-range-picker__star {
  flex-shrink: 0;
  color: var(--accent);
}
.history-range-picker__suffix {
  flex-shrink: 0;
  color: var(--muted);
  font-weight: 400;
}
.history-range-picker__caret {
  flex-shrink: 0;
  color: var(--muted);
  font-size: 10px;
}
.history-range-picker__section {
  padding: 6px 10px 4px;
  color: var(--muted);
  font-size: 10px;
  letter-spacing: 0.5px;
  text-transform: uppercase;
  font-weight: 700;
}
.history-range-picker__note {
  padding: 6px 10px;
  color: var(--muted);
  font-size: 12px;
}
.history-range-picker__sep {
  height: 1px;
  margin: 4px 0;
  background: var(--border);
}
</style>
