<template>
  <div ref="rootRef" :class="['branch-picker', { 'branch-picker--open': open, 'branch-picker--disabled': disabled }]">
    <button
      ref="buttonRef"
      type="button"
      :class="['branch-picker__button', buttonClass]"
      :disabled="disabled"
      :aria-expanded="open ? 'true' : 'false'"
      aria-haspopup="listbox"
      @click="toggle"
      @keydown="onButtonKeydown"
    >
      <span class="branch-picker__value" :class="{ 'branch-picker__value--placeholder': !buttonText }">
        {{ buttonText || placeholder }}
      </span>
      <span class="branch-picker__arrow" aria-hidden="true">▾</span>
    </button>
    <Teleport to="body">
      <div v-if="open" ref="listRef" class="branch-picker__popover" :style="popoverStyle">
        <input
          ref="searchRef"
          v-model="query"
          type="text"
          class="branch-picker__search"
          :placeholder="searchPlaceholder"
          @keydown="onSearchKeydown"
        />
        <ul class="branch-picker__list" role="listbox" tabindex="-1">
          <li
            v-if="offLabel"
            class="branch-picker__row"
            :class="rowClass(-1, offValue)"
            @mousedown.prevent="select(offValue)"
            @mouseenter="activeIndex = -1"
          >
            <span class="branch-picker__indent" :style="indentStyle(0)" />
            <span class="branch-picker__icon branch-picker__icon--off">∅</span>
            <span class="branch-picker__label">{{ offLabel }}</span>
          </li>
          <template v-for="(row, idx) in visibleRows" :key="row.key">
            <li
              :class="rowClass(idx, row.ref || '', row.isSection)"
              role="option"
              :aria-selected="row.ref === modelValue ? 'true' : 'false'"
              @mousedown.prevent="onRowMousedown(row)"
              @mouseenter="activeIndex = idx"
            >
              <span class="branch-picker__indent" :style="indentStyle(row.depth)" />
              <span v-if="row.isFolder" class="branch-picker__toggle" @mousedown.stop.prevent="toggleFolder(row.key)">{{
                row.expanded ? "▾" : "▸"
              }}</span>
              <span v-else class="branch-picker__toggle branch-picker__toggle--leaf" />
              <span :class="['branch-picker__icon', `branch-picker__icon--${row.iconKind}`]">{{ row.icon }}</span>
              <span class="branch-picker__label" :title="row.title">{{ row.label }}</span>
              <span v-if="row.isSection && row.count != null" class="branch-picker__count">{{ row.count }}</span>
              <span v-if="row.isDefault" class="branch-picker__pill branch-picker__pill--default">default</span>
            </li>
          </template>
          <li v-if="visibleRows.length === 0 && !offLabel" class="branch-picker__empty">No matches</li>
          <li v-else-if="visibleRows.length === 0 && offLabel && query.trim()" class="branch-picker__empty">
            No matches
          </li>
        </ul>
      </div>
    </Teleport>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import { buildBranchForest, type BranchForestNode } from "./branch-forest.js";
import { useDismissable } from "../../../composables/useDismissable.js";

interface Props {
  modelValue?: string;
  options?: string[];
  defaultBranch?: string; // e.g. "master" — short name w/o remote
  defaultRemote?: string; // e.g. "origin"
  remoteNames?: string[]; // names of all configured remotes ("origin", "vk", "jstradej", …)
  placeholder?: string;
  disabled?: boolean;
  buttonClass?: string | string[] | Record<string, boolean>;
  buttonLabelPrefix?: string; // e.g. "Compare: "
  offValue?: string;
  offLabel?: string; // shows a pinned "Off" row at the top when set
  searchPlaceholder?: string;
}

const props = withDefaults(defineProps<Props>(), {
  modelValue: "",
  options: () => [],
  defaultBranch: "",
  defaultRemote: "",
  remoteNames: () => [],
  placeholder: "Select…",
  disabled: false,
  buttonClass: "",
  buttonLabelPrefix: "",
  offValue: "",
  offLabel: "",
  searchPlaceholder: "Filter branches…",
});

const emit = defineEmits<{
  "update:modelValue": [value: string];
  change: [value: string];
}>();

const open = ref(false);
const query = ref("");
const activeIndex = ref(-1);
const rootRef = ref<HTMLElement | null>(null);
const buttonRef = ref<HTMLButtonElement | null>(null);
const listRef = ref<HTMLDivElement | null>(null);
const searchRef = ref<HTMLInputElement | null>(null);
const popoverStyle = ref<Record<string, string>>({});
const collapsed = reactive<Record<string, boolean>>({}); // expand default, collapse on demand

// ---- Resolve a "fully-qualified" default ref against the options. The
// backend gives us defaultBranch + defaultRemote separately ("master" +
// "origin"); options can hold either form. Try both.
const defaultFullRef = computed<string>(() => {
  if (!props.defaultBranch) return "";
  const full = props.defaultRemote ? `${props.defaultRemote}/${props.defaultBranch}` : "";
  if (full && props.options.includes(full)) return full;
  if (props.options.includes(props.defaultBranch)) return props.defaultBranch;
  return "";
});

// A ref like "origin/master" or "vk/feature/auth" is "remote" — its first
// path segment matches a configured remote name. Plain "develop" or
// "feature/auth" (when "feature" isn't a remote name) is local. This drives
// the icon + colour so the user can visually separate the two without
// reading the full path.
const remoteSet = computed<Set<string>>(() => new Set(props.remoteNames || []));
function isRemoteRef(refOrSegment: string): boolean {
  if (!refOrSegment) return false;
  const firstSlash = refOrSegment.indexOf("/");
  const head = firstSlash >= 0 ? refOrSegment.slice(0, firstSlash) : refOrSegment;
  return remoteSet.value.has(head);
}

// ---- Tree model ---------------------------------------------------------
interface TreeRow {
  key: string;
  depth: number;
  isFolder: boolean;
  isSection?: boolean; // top-level "Local" / "Remote · <name>" header
  expanded: boolean;
  label: string;
  icon: string;
  iconKind: string;
  ref?: string;
  isDefault?: boolean;
  isRemote?: boolean;
  count?: number;
  title: string;
}

interface BuildNode {
  key: string;
  label: string;
  segment: string;
  ref?: string;
  children: BuildNode[];
}

interface SectionNode {
  key: string;
  label: string;
  iconKind: "local-section" | "remote-section";
  count: number;
  children: BuildNode[];
}

// Group refs into sections: "Local" (no remote prefix) and one "Remote · X"
// per configured remote. Inside each section refs are split by "/" into a
// sub-forest as before, but the remote prefix is stripped from labels so
// folders/leaves under "Remote · origin" show "feature/auth" / "master"
// instead of "origin/feature/auth" / "origin/master". The leaf's ref keeps
// the full name so selection still emits the canonical ref.
const sections = computed<SectionNode[]>(() => {
  const dflt = defaultFullRef.value;
  const localBucket: Array<{ fullRef: string; strippedPath: string }> = [];
  const remoteBuckets = new Map<string, Array<{ fullRef: string; strippedPath: string }>>();

  for (const refName of props.options) {
    if (!refName) continue;
    const firstSlash = refName.indexOf("/");
    const head = firstSlash >= 0 ? refName.slice(0, firstSlash) : refName;
    if (firstSlash >= 0 && remoteSet.value.has(head)) {
      const list = remoteBuckets.get(head) || [];
      list.push({ fullRef: refName, strippedPath: refName.slice(firstSlash + 1) });
      remoteBuckets.set(head, list);
    } else {
      localBucket.push({ fullRef: refName, strippedPath: refName });
    }
  }

  // Delegates to the shared pure forest-builder (see ./branch-forest.ts,
  // also used by GitBranchesTab.vue's branch tree) and adapts its generic
  // node shape back to this component's BuildNode.
  function toBuildNodes(nodes: BranchForestNode<null>[]): BuildNode[] {
    return nodes.map((n) =>
      n.kind === "folder"
        ? { key: n.key, label: n.label, segment: n.label, children: toBuildNodes(n.children) }
        : { key: n.key, label: n.label, segment: n.label, ref: n.ref, children: [] },
    );
  }

  function buildForest(entries: Array<{ fullRef: string; strippedPath: string }>, prefix: string): BuildNode[] {
    const forest = buildBranchForest(
      entries.map((e) => ({ path: e.strippedPath, ref: e.fullRef, payload: null })),
      prefix,
      (a, b) => {
        if (a.ref === dflt && b.ref !== dflt) return -1;
        if (b.ref === dflt && a.ref !== dflt) return 1;
        return a.label.localeCompare(b.label);
      },
    );
    return toBuildNodes(forest);
  }

  const out: SectionNode[] = [];
  if (localBucket.length) {
    out.push({
      key: "section:local",
      label: "Local",
      iconKind: "local-section",
      count: localBucket.length,
      children: buildForest(localBucket, "local"),
    });
  }
  // Origin first (the conventional primary), then others alphabetically — same
  // precedence used elsewhere (listBranches, readSymbolicDefault).
  const remoteOrder = Array.from(remoteBuckets.keys()).sort((a, b) => {
    if (a === "origin" && b !== "origin") return -1;
    if (b === "origin" && a !== "origin") return 1;
    return a.localeCompare(b);
  });
  for (const name of remoteOrder) {
    const bucket = remoteBuckets.get(name) || [];
    if (!bucket.length) continue;
    out.push({
      key: `section:remote:${name}`,
      label: `Remote · ${name}`,
      iconKind: "remote-section",
      count: bucket.length,
      children: buildForest(bucket, `remote:${name}`),
    });
  }
  return out;
});

// Flatten the section tree to visible rows, honoring collapse state and
// search. Search mode skips sections and shows matching leaves flat.
const visibleRows = computed<TreeRow[]>(() => {
  const q = query.value.trim().toLowerCase();
  const dflt = defaultFullRef.value;
  const rows: TreeRow[] = [];

  if (q) {
    function collect(nodes: BuildNode[]): void {
      for (const n of nodes) {
        if (n.ref) {
          if (n.ref.toLowerCase().includes(q)) {
            const remote = isRemoteRef(n.ref);
            rows.push({
              key: n.key,
              depth: 0,
              isFolder: false,
              expanded: true,
              label: n.ref,
              icon: remote ? "☁" : "⎇",
              iconKind: remote ? "remote" : "branch",
              ref: n.ref,
              isDefault: n.ref === dflt,
              isRemote: remote,
              title: n.ref,
            });
          }
        } else {
          collect(n.children);
        }
      }
    }
    for (const section of sections.value) collect(section.children);
    return rows;
  }

  function walk(nodes: BuildNode[], depth: number, isRemoteContext: boolean): void {
    for (const n of nodes) {
      const isFolder = n.children.length > 0;
      if (isFolder) {
        const expanded = !collapsed[n.key];
        rows.push({
          key: n.key,
          depth,
          isFolder: true,
          expanded,
          label: n.label,
          icon: expanded ? "📂" : "📁",
          iconKind: "folder",
          title: n.label,
        });
        if (expanded) walk(n.children, depth + 1, isRemoteContext);
      } else if (n.ref) {
        rows.push({
          key: n.key,
          depth,
          isFolder: false,
          expanded: true,
          label: n.label,
          icon: isRemoteContext ? "☁" : "⎇",
          iconKind: isRemoteContext ? "remote" : "branch",
          ref: n.ref,
          isDefault: n.ref === dflt,
          isRemote: isRemoteContext,
          title: n.ref,
        });
      }
    }
  }

  for (const section of sections.value) {
    const expanded = !collapsed[section.key];
    rows.push({
      key: section.key,
      depth: 0,
      isFolder: true,
      isSection: true,
      expanded,
      label: section.label,
      icon: section.iconKind === "remote-section" ? "☁" : "⎇",
      iconKind: section.iconKind,
      count: section.count,
      title: section.label,
    });
    if (expanded) walk(section.children, 1, section.iconKind === "remote-section");
  }
  return rows;
});

const buttonText = computed<string>(() => {
  const v = props.modelValue;
  if (!v) return props.offLabel || "";
  return props.buttonLabelPrefix ? `${props.buttonLabelPrefix}${v}` : v;
});

function indentStyle(depth: number): Record<string, string> {
  return { width: `${depth * 12}px` };
}

function rowClass(idx: number, refValue: string, isSection?: boolean): Record<string, boolean> {
  return {
    "branch-picker__row": true,
    "branch-picker__row--section": !!isSection,
    "branch-picker__row--active": activeIndex.value === idx && !isSection,
    "branch-picker__row--selected": !!refValue && refValue === props.modelValue,
    "branch-picker__row--off-selected": idx === -1 && !props.modelValue,
  };
}

function toggleFolder(key: string): void {
  collapsed[key] = !collapsed[key];
}

function onRowMousedown(row: TreeRow): void {
  if (row.isFolder) {
    toggleFolder(row.key);
    return;
  }
  if (row.ref !== undefined) select(row.ref);
}

function select(value: string): void {
  emit("update:modelValue", value);
  emit("change", value);
  closePopover();
  buttonRef.value?.focus();
}

const MAX_LIST_HEIGHT = 320;

function updatePosition(): void {
  if (!buttonRef.value) return;
  const rect = buttonRef.value.getBoundingClientRect();
  const vh = window.innerHeight;
  const vw = window.innerWidth;
  const spaceBelow = vh - rect.bottom - 8;
  const spaceAbove = rect.top - 8;
  const flipAbove = spaceBelow < Math.min(MAX_LIST_HEIGHT, 200) && spaceAbove > spaceBelow;
  const maxHeight = Math.max(200, Math.min(MAX_LIST_HEIGHT, flipAbove ? spaceAbove : spaceBelow));
  popoverStyle.value = {
    position: "fixed",
    left: `${rect.left}px`,
    minWidth: `${Math.max(220, rect.width)}px`,
    maxWidth: `${Math.max(220, vw - rect.left - 8)}px`,
    width: "max-content",
    maxHeight: `${maxHeight}px`,
    ...(flipAbove ? { bottom: `${vh - rect.top + 3}px` } : { top: `${rect.bottom + 3}px` }),
  };
}

function openPopover(): void {
  if (props.disabled || open.value) return;
  updatePosition();
  open.value = true;
  query.value = "";
  // Set active to the currently-selected row if visible.
  const currentRefIdx = visibleRows.value.findIndex((r) => r.ref === props.modelValue);
  activeIndex.value = currentRefIdx;
  nextTick(() => {
    searchRef.value?.focus();
    scrollActiveIntoView();
  });
}

function closePopover(): void {
  if (!open.value) return;
  open.value = false;
  query.value = "";
  activeIndex.value = -1;
}

function toggle(): void {
  if (open.value) closePopover();
  else openPopover();
}

function scrollActiveIntoView(): void {
  if (!listRef.value || activeIndex.value < 0) return;
  const ul = listRef.value.querySelector(".branch-picker__list");
  if (!ul) return;
  // Account for the optional pinned "Off" row at position 0.
  const offsetForOff = props.offLabel ? 1 : 0;
  const el = ul.children[activeIndex.value + offsetForOff] as HTMLElement | undefined;
  if (el?.scrollIntoView) el.scrollIntoView({ block: "nearest" });
}

function moveActive(dir: number): void {
  const total = visibleRows.value.length;
  if (total === 0) return;
  let next = activeIndex.value + dir;
  // Skip past folders so Enter doesn't accidentally "select" a folder.
  while (next >= 0 && next < total && visibleRows.value[next].isFolder) {
    next += dir;
  }
  if (next < 0) next = 0;
  if (next >= total) next = total - 1;
  activeIndex.value = next;
  scrollActiveIntoView();
}

function commitActive(): void {
  if (activeIndex.value < 0) {
    if (props.offLabel) select(props.offValue);
    return;
  }
  const row = visibleRows.value[activeIndex.value];
  if (!row) return;
  if (row.isFolder) {
    toggleFolder(row.key);
    return;
  }
  if (row.ref !== undefined) select(row.ref);
}

function onButtonKeydown(e: KeyboardEvent): void {
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    if (!open.value) openPopover();
    else moveActive(e.key === "ArrowDown" ? 1 : -1);
  } else if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    if (!open.value) openPopover();
    else commitActive();
  } else if (e.key === "Escape") {
    if (open.value) {
      e.preventDefault();
      e.stopPropagation();
      closePopover();
    }
  } else if (e.key === "Tab") {
    closePopover();
  }
}

function onSearchKeydown(e: KeyboardEvent): void {
  if (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Enter" || e.key === "Escape" || e.key === "Tab") {
    onButtonKeydown(e);
  }
}

useDismissable(open, [rootRef, listRef], { onDismiss: closePopover, eventName: "mousedown" });

function onWindowBlur(): void {
  closePopover();
}

function onReposition(): void {
  if (open.value) updatePosition();
}

watch(query, () => {
  if (!open.value) return;
  const n = visibleRows.value.length;
  activeIndex.value = n > 0 ? 0 : -1;
  // Skip leading folders.
  if (n > 0) {
    while (activeIndex.value < n && visibleRows.value[activeIndex.value].isFolder) activeIndex.value++;
    if (activeIndex.value >= n) activeIndex.value = -1;
  }
  nextTick(() => scrollActiveIntoView());
});

onMounted(() => {
  window.addEventListener("blur", onWindowBlur);
  window.addEventListener("resize", onReposition);
  window.addEventListener("scroll", onReposition, true);
});

onBeforeUnmount(() => {
  window.removeEventListener("blur", onWindowBlur);
  window.removeEventListener("resize", onReposition);
  window.removeEventListener("scroll", onReposition, true);
});

defineExpose({ focus: (): void => buttonRef.value?.focus() });
</script>

<style scoped>
.branch-picker {
  position: relative;
  display: inline-block;
  width: 100%;
}
.branch-picker__button {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  width: 100%;
  padding: 4px 8px;
  background: rgba(0, 0, 0, 0.25);
  border: 1px solid var(--border);
  border-radius: 3px;
  color: var(--text);
  font: inherit;
  font-size: 12px;
  line-height: 1.2;
  height: 24px;
  cursor: pointer;
  text-align: left;
}
.branch-picker__button:hover:not(:disabled) {
  background: rgba(var(--tint), 0.08);
}
.branch-picker__button:focus-visible {
  outline: 1px solid var(--accent);
  outline-offset: -1px;
}
.branch-picker--disabled .branch-picker__button,
.branch-picker__button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.branch-picker__value {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.branch-picker__value--placeholder {
  color: var(--muted);
}
.branch-picker__arrow {
  flex-shrink: 0;
  color: var(--muted);
  font-size: 10px;
}
.branch-picker__popover {
  z-index: 10050;
  display: flex;
  flex-direction: column;
  background: var(--panel-elevated, #1d2026);
  border: 1px solid var(--border);
  border-radius: 4px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.5);
  font-size: 12px;
  overflow: hidden;
}
.branch-picker__search {
  flex-shrink: 0;
  padding: 6px 10px;
  background: rgba(var(--tint), 0.05);
  border: 0;
  border-bottom: 1px solid var(--border);
  color: var(--text);
  font: inherit;
  font-size: 12px;
  outline: none;
}
.branch-picker__search:focus {
  background: rgba(var(--tint), 0.08);
}
.branch-picker__list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  margin: 0;
  padding: 4px 0;
  list-style: none;
  font-variant-numeric: tabular-nums;
}
.branch-picker__empty {
  padding: 10px;
  color: var(--muted);
  font-style: italic;
  text-align: center;
}
.branch-picker__row {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 3px 8px;
  color: var(--text);
  cursor: pointer;
  white-space: nowrap;
}
.branch-picker__row--active:not(.branch-picker__row--selected):not(.branch-picker__row--off-selected) {
  background: rgba(var(--tint), 0.12);
}
.branch-picker__row--selected,
.branch-picker__row--off-selected {
  background: rgba(255, 164, 36, 0.18);
  color: var(--accent);
  font-weight: 600;
}
.branch-picker__indent {
  flex: 0 0 auto;
}
.branch-picker__toggle {
  flex: 0 0 12px;
  width: 12px;
  text-align: center;
  color: var(--muted);
  font-size: 10px;
}
.branch-picker__toggle--leaf {
  visibility: hidden;
}
.branch-picker__icon {
  flex: 0 0 14px;
  width: 14px;
  text-align: center;
  font-size: 12px;
  color: var(--muted);
}
.branch-picker__icon--branch {
  color: #6dc070;
}
.branch-picker__icon--remote {
  color: #80a8e0;
}
.branch-picker__icon--folder {
  color: var(--muted);
}
.branch-picker__icon--off {
  color: var(--muted);
}
.branch-picker__icon--local-section {
  color: #6dc070;
}
.branch-picker__icon--remote-section {
  color: #80a8e0;
}

.branch-picker__row--section {
  padding-top: 6px;
  padding-bottom: 6px;
  border-top: 1px solid var(--border);
  background: rgba(255, 255, 255, 0.025);
  color: var(--muted);
  font-size: 10px;
  letter-spacing: 0.5px;
  text-transform: uppercase;
  font-weight: 700;
  cursor: pointer;
}
.branch-picker__row--section:first-child {
  border-top: none;
}
/* Even when the user is keyboard-navigating, sections shouldn't look picked. */
.branch-picker__row--section.branch-picker__row--selected,
.branch-picker__row--section.branch-picker__row--off-selected {
  background: rgba(255, 255, 255, 0.025);
  color: var(--muted);
}

.branch-picker__count {
  flex: 0 0 auto;
  font-size: 10px;
  padding: 0 6px;
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.08);
  color: var(--muted);
  font-variant-numeric: tabular-nums;
}
.branch-picker__label {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}
.branch-picker__pill {
  flex: 0 0 auto;
  font-size: 10px;
  padding: 0 6px;
  border-radius: 8px;
  background: rgba(var(--tint), 0.12);
  color: var(--muted);
}
.branch-picker__pill--default {
  background: rgba(76, 175, 80, 0.18);
  color: #6dc070;
  font-weight: 600;
  letter-spacing: 0.3px;
}
</style>
