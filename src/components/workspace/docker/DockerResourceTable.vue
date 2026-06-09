<template>
  <div class="dr-table">
    <div class="dr-table__scroll" :style="layoutFixed ? { '--dr-head-h': headHeight + 'px' } : undefined">
      <table ref="tableRef" :class="{ 'dr-table--fixed': layoutFixed }" :style="tableStyle">
        <colgroup>
          <col v-if="showSelect" :style="colStyle('__select')" />
          <col v-for="col in columns" :key="col.key" :style="colStyle(col.key)" />
          <col v-if="hasRowActions" :style="colStyle('__actions')" />
        </colgroup>
        <thead>
          <tr ref="headRowEl">
            <th v-if="showSelect" :ref="(el) => setThEl('__select', el)" class="dr-table__check">
              <input
                type="checkbox"
                :checked="allSelected"
                :indeterminate.prop="someSelected && !allSelected"
                :disabled="rows.length === 0"
                :aria-label="allSelected ? 'Clear selection' : 'Select all rows'"
                @change="toggleAll"
              />
            </th>
            <th
              v-for="col in columns"
              :key="col.key"
              :ref="(el) => setThEl(col.key, el)"
              :class="[
                col.sortable !== false && 'dr-table__th--sortable',
                col.align === 'right' && 'dr-table__th--right',
                sortKey === col.key && 'dr-table__th--active',
              ]"
              :style="col.width ? { width: col.width } : undefined"
              :aria-sort="sortKey === col.key ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none'"
              @click="onSort(col)"
            >
              <div class="dr-table__th-inner">
                <span class="dr-table__th-label">{{ col.label }}</span>
                <span
                  v-if="col.sortable !== false && col.label"
                  class="dr-table__sort"
                  :class="{ 'dr-table__sort--active': sortKey === col.key }"
                  >{{ sortKey === col.key ? (sortDir === "asc" ? "▲" : "▼") : "↕" }}</span
                >
              </div>
              <span
                v-if="resizable && col.resizable !== false"
                class="dr-table__resizer"
                title="Drag to resize · double-click to reset"
                @pointerdown.stop.prevent="startColResize(col.key, $event)"
                @click.stop
                @dblclick.stop="resetColWidth(col.key)"
              ></span>
            </th>
            <th v-if="hasRowActions" :ref="(el) => setThEl('__actions', el)" class="dr-table__actions-head" />
          </tr>
          <tr v-if="hasColumnFilters" class="dr-table__filter-row">
            <th v-if="showSelect" class="dr-table__check"></th>
            <th v-for="col in columns" :key="col.key" :class="[col.align === 'right' && 'dr-table__th--right']">
              <input
                v-if="filterKind(col) === 'text'"
                class="dr-table__filter-input"
                type="search"
                :value="filterValues?.[col.key] ?? ''"
                :placeholder="filterPlaceholder(col)"
                @click.stop
                @input="emit('update:filter', col.key, ($event.target as HTMLInputElement).value)"
              />
              <select
                v-else-if="filterKind(col) === 'select'"
                class="dr-table__filter-select"
                :value="filterValues?.[col.key] ?? ''"
                @click.stop
                @change="emit('update:filter', col.key, ($event.target as HTMLSelectElement).value)"
              >
                <option value="">{{ filterPlaceholder(col) }}</option>
                <option v-for="o in selectOptions(col)" :key="o.value" :value="o.value">{{ o.label }}</option>
              </select>
              <span
                v-if="resizable && col.resizable !== false"
                class="dr-table__resizer"
                title="Drag to resize · double-click to reset"
                @pointerdown.stop.prevent="startColResize(col.key, $event)"
                @click.stop
                @dblclick.stop="resetColWidth(col.key)"
              ></span>
            </th>
            <th v-if="hasRowActions" class="dr-table__actions-head"></th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="row in sortedRows"
            :key="rowId(row)"
            :class="[selectedSet.has(rowId(row)) && 'dr-table__row--selected', rowClass ? rowClass(row) : undefined]"
          >
            <td v-if="showSelect" class="dr-table__check" @click.stop>
              <input
                type="checkbox"
                :checked="selectedSet.has(rowId(row))"
                :aria-label="`Select row ${rowId(row)}`"
                @change="toggleRow(rowId(row))"
              />
            </td>
            <td
              v-for="col in columns"
              :key="col.key"
              :class="[col.align === 'right' && 'dr-table__td--right', col.mono && 'dr-table__td--mono']"
              @click="emit('row-click', row)"
            >
              <slot :name="`cell-${col.key}`" :row="row" :value="getCell(row, col)">
                {{ getCell(row, col) }}
              </slot>
            </td>
            <td v-if="hasRowActions" class="dr-table__actions" @click.stop>
              <slot name="row-actions" :row="row" />
            </td>
          </tr>
          <tr v-if="sortedRows.length === 0">
            <td :colspan="columns.length + (showSelect ? 1 : 0) + (hasRowActions ? 1 : 0)" class="dr-table__empty">
              <slot name="empty">No items.</slot>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>

<script setup lang="ts" generic="T extends object">
import { computed, ref, reactive, watch, onMounted, nextTick } from "vue";

/**
 * Generic, slot-based table for docker resource lists. Owns its sort state
 * (parent passes `defaultSort`) and selection state (via `v-model:selected`).
 * Per-cell rendering happens through named slots `cell-<column.key>`, so each
 * caller (images / volumes / networks) keeps its bespoke formatting close to
 * the column definition without this component needing to know the row shape.
 *
 * Columns can be drag-resized (widths persist via `persistKey`). Filtering is
 * opt-in: a column with a `filter` config renders a control in a second header
 * row, but the *filtering itself stays with the parent* via `filterValues` +
 * the `update:filter` event — the table only surfaces the control.
 */
export interface Column<R> {
  key: string;
  label: string;
  /** Defaults to `true`. Set false to disable sorting for a column. */
  sortable?: boolean;
  align?: "left" | "right";
  width?: string;
  mono?: boolean;
  /** Read the raw cell value. Falls back to row[key] if omitted. */
  getValue?: (row: R) => unknown;
  /** Comparable value for sorting (must be number | string | undefined). */
  sortValue?: (row: R) => number | string | undefined;
  /** Set false to suppress the drag-to-resize handle for this column. */
  resizable?: boolean;
  /**
   * Renders a filter control under the header. The parent owns the value
   * (via `filterValues[key]`) and does the actual filtering.
   */
  filter?:
    | { kind: "text"; placeholder?: string }
    | { kind: "select"; options: { value: string; label: string }[]; placeholder?: string };
}

// NOTE: `selectable`/`resizable` must be declared with explicit `true` defaults
// via withDefaults. They're Boolean props, and Vue casts an *absent* Boolean
// prop to `false` (HTML boolean-attribute semantics) — not `undefined` — so a
// parent that omits them would otherwise silently disable selection/resizing.
const props = withDefaults(
  defineProps<{
    rows: T[];
    columns: Column<T>[];
    rowId: (row: T) => string;
    defaultSort?: { key: string; dir: "asc" | "desc" };
    /** Checkbox selection set. Optional — omit together with `selectable: false`. */
    selected?: Set<string>;
    /** Show the leading checkbox column. Defaults to true. */
    selectable?: boolean;
    rowClass?: (row: T) => string | undefined;
    hasRowActions?: boolean;
    /** Rows for which this returns true are floated to the top, above the column sort. */
    pinnedFirst?: (row: T) => boolean;
    /** Enable drag-to-resize column widths. Defaults to true. */
    resizable?: boolean;
    /** localStorage key suffix to persist column widths. Omit to not persist. */
    persistKey?: string;
    /** Current per-column filter values (owned by the parent), keyed by column.key. */
    filterValues?: Record<string, string>;
  }>(),
  { selectable: true, resizable: true },
);

const showSelect = computed(() => props.selectable !== false);
const resizable = computed(() => props.resizable !== false);
const hasColumnFilters = computed(() => props.columns.some((c) => !!c.filter));

const emit = defineEmits<{
  "row-click": [row: T];
  "update:selected": [next: Set<string>];
  "update:filter": [key: string, value: string];
}>();

// --- Filter control helpers (keep discriminated-union narrowing out of the template) ---
function filterKind(col: Column<T>): "text" | "select" | "" {
  return col.filter?.kind ?? "";
}
function selectOptions(col: Column<T>): { value: string; label: string }[] {
  return col.filter?.kind === "select" ? col.filter.options : [];
}
function filterPlaceholder(col: Column<T>): string {
  return col.filter?.placeholder ?? (col.filter?.kind === "select" ? "All" : "Filter…");
}

// --- Sorting ---
const sortKey = ref<string>(props.defaultSort?.key ?? "");
const sortDir = ref<"asc" | "desc">(props.defaultSort?.dir ?? "asc");

watch(
  () => props.defaultSort,
  (s) => {
    if (s && !sortKey.value) {
      sortKey.value = s.key;
      sortDir.value = s.dir;
    }
  },
  { immediate: true },
);

const selectedSet = computed(() => props.selected ?? new Set<string>());

function getCell(row: T, col: Column<T>): unknown {
  if (col.getValue) return col.getValue(row);
  return (row as Record<string, unknown>)[col.key];
}

function getSortValue(row: T, col: Column<T>): number | string {
  if (col.sortValue) {
    const v = col.sortValue(row);
    if (v === undefined || v === null) return "";
    return v;
  }
  const v = getCell(row, col);
  if (typeof v === "number") return v;
  return v == null ? "" : String(v);
}

const sortedRows = computed(() => {
  const pin = props.pinnedFirst;
  const col = sortKey.value ? props.columns.find((c) => c.key === sortKey.value) : undefined;
  if (!pin && !col) return props.rows;
  const dirMul = sortDir.value === "asc" ? 1 : -1;
  return [...props.rows].sort((a, b) => {
    if (pin) {
      // Pinned rows always sort above unpinned, regardless of the active column.
      const pa = pin(a) ? 0 : 1;
      const pb = pin(b) ? 0 : 1;
      if (pa !== pb) return pa - pb;
    }
    if (!col) return 0;
    const va = getSortValue(a, col);
    const vb = getSortValue(b, col);
    if (typeof va === "number" && typeof vb === "number") return (va - vb) * dirMul;
    return String(va).localeCompare(String(vb), undefined, { numeric: true, sensitivity: "base" }) * dirMul;
  });
});

function onSort(col: Column<T>): void {
  if (col.sortable === false) return;
  if (sortKey.value === col.key) {
    sortDir.value = sortDir.value === "asc" ? "desc" : "asc";
  } else {
    sortKey.value = col.key;
    sortDir.value = col.align === "right" ? "desc" : "asc";
  }
}

// --- Column widths (drag to resize, optionally persisted) ---
// We start in `table-layout: auto` so columns size to content, measure those
// natural widths once real rows have rendered, then switch to `fixed` so the
// widths become draggable. jsdom reports offsetWidth=0, so this stays a no-op
// in unit tests and the table renders in plain auto layout.
const SELECT_KEY = "__select";
const ACTIONS_KEY = "__actions";
const MIN_COL_W = 40;

const tableRef = ref<HTMLTableElement | null>(null);
const headRowEl = ref<HTMLElement | null>(null);
const thEls = new Map<string, HTMLElement>();
const colWidths = reactive<Record<string, number>>({});
const naturalWidths = reactive<Record<string, number>>({});
const layoutFixed = ref(false);
const headHeight = ref(0);

function setThEl(key: string, el: unknown): void {
  if (el instanceof HTMLElement) thEls.set(key, el);
  else thEls.delete(key);
}

const widthKeys = computed<string[]>(() => {
  const keys: string[] = [];
  if (showSelect.value) keys.push(SELECT_KEY);
  for (const c of props.columns) keys.push(c.key);
  if (props.hasRowActions) keys.push(ACTIONS_KEY);
  return keys;
});

const widthStorageKey = computed(() => (props.persistKey ? `dr-table:cols:${props.persistKey}` : ""));

function loadPersisted(): void {
  if (!widthStorageKey.value) return;
  try {
    const raw = localStorage.getItem(widthStorageKey.value);
    if (!raw) return;
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === "number" && Number.isFinite(v) && v >= MIN_COL_W) colWidths[k] = v;
    }
  } catch {
    // Corrupt/unavailable storage — fall back to measuring.
  }
}

function persist(): void {
  if (!widthStorageKey.value) return;
  try {
    localStorage.setItem(widthStorageKey.value, JSON.stringify(colWidths));
  } catch {
    // Non-fatal — widths just won't survive a reload.
  }
}

const allPersisted = computed(() => widthKeys.value.every((k) => colWidths[k] != null));

function colStyle(key: string): { width: string } | undefined {
  if (!layoutFixed.value) return undefined;
  const w = colWidths[key];
  return w != null ? { width: w + "px" } : undefined;
}

const tableStyle = computed(() => {
  if (!layoutFixed.value) return undefined;
  // Width == sum of column widths so a drag changes exactly that column and
  // doesn't get redistributed back across the others (fixed-layout fill).
  let total = 0;
  for (const k of widthKeys.value) total += colWidths[k] ?? 0;
  return total > 0 ? { width: Math.round(total) + "px" } : undefined;
});

/** Read current rendered widths (only meaningful while in auto layout). */
function measure(): void {
  if (headRowEl.value) headHeight.value = headRowEl.value.offsetHeight;
  for (const key of widthKeys.value) {
    const el = thEls.get(key);
    if (!el) continue;
    const w = el.offsetWidth;
    if (w > 0) {
      naturalWidths[key] = w;
      if (colWidths[key] == null) colWidths[key] = w;
    }
  }
}

function maybeInit(): void {
  if (!resizable.value || layoutFixed.value) return;
  // Defer until real rows have rendered so widths reflect content, unless every
  // column already has a persisted width to fall back on.
  if (props.rows.length === 0 && !allPersisted.value) return;
  measure();
  if (allPersisted.value) layoutFixed.value = true;
}

function forceFix(): void {
  if (layoutFixed.value) return;
  measure();
  for (const k of widthKeys.value) {
    if (colWidths[k] == null) colWidths[k] = thEls.get(k)?.offsetWidth || 120;
  }
  layoutFixed.value = true;
}

function startColResize(key: string, e: PointerEvent): void {
  if (!layoutFixed.value) forceFix();
  const startX = e.clientX;
  const startW = colWidths[key] ?? thEls.get(key)?.offsetWidth ?? 120;
  document.body.style.userSelect = "none";
  document.body.style.cursor = "col-resize";
  function onMove(ev: PointerEvent) {
    colWidths[key] = Math.max(MIN_COL_W, startW + (ev.clientX - startX));
  }
  function onUp() {
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    document.body.style.userSelect = "";
    document.body.style.cursor = "";
    persist();
  }
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
}

function resetColWidth(key: string): void {
  const nat = naturalWidths[key];
  if (nat != null) {
    colWidths[key] = nat;
    persist();
  }
}

onMounted(async () => {
  loadPersisted();
  await nextTick();
  maybeInit();
});

// First data load: measure once rows exist so widths fit their content.
watch(
  () => props.rows.length,
  async () => {
    if (layoutFixed.value) return;
    await nextTick();
    maybeInit();
  },
);

// Columns appearing/disappearing (e.g. an optional "Connection" column). Keyed
// on the joined keys so a parent that rebuilds `columns` each poll doesn't churn.
watch(
  () => widthKeys.value.join("|"),
  async () => {
    await nextTick();
    if (!layoutFixed.value) {
      maybeInit();
      return;
    }
    // Already fixed — give any newly added column a sensible starting width.
    for (const k of widthKeys.value) if (colWidths[k] == null) colWidths[k] = 120;
  },
);

function toggleRow(id: string): void {
  const next = new Set(selectedSet.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  emit("update:selected", next);
}

function toggleAll(): void {
  if (allSelected.value) {
    emit("update:selected", new Set());
  } else {
    emit("update:selected", new Set(props.rows.map(props.rowId)));
  }
}

const allSelected = computed(
  () => props.rows.length > 0 && props.rows.every((r) => selectedSet.value.has(props.rowId(r))),
);
const someSelected = computed(() => props.rows.some((r) => selectedSet.value.has(props.rowId(r))));
</script>

<style scoped>
.dr-table {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}

.dr-table__scroll {
  flex: 1 1 auto;
  min-height: 0;
  overflow: auto;
}

table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
}

.dr-table--fixed {
  table-layout: fixed;
}

thead th {
  position: sticky;
  top: 0;
  z-index: 1;
  background: #1c1c20;
  text-align: left;
  font-weight: 600;
  font-size: 11px;
  letter-spacing: 0.3px;
  text-transform: uppercase;
  color: var(--text-dim, #aaa);
  padding: 8px 10px;
  border-bottom: 1px solid var(--border-color, rgba(255, 255, 255, 0.1));
  white-space: nowrap;
  user-select: none;
}

.dr-table__th-inner {
  display: flex;
  align-items: center;
  gap: 4px;
  width: 100%;
  min-width: 0;
}
.dr-table__th-label {
  overflow: hidden;
  text-overflow: ellipsis;
}
.dr-table__th--right .dr-table__th-inner {
  justify-content: flex-end;
}

.dr-table__th--right {
  text-align: right;
}
.dr-table__th--sortable {
  cursor: pointer;
}
.dr-table__th--sortable:hover {
  color: var(--text-primary, #e2e8f0);
}
.dr-table__th--active {
  color: var(--accent, #63b3ed);
}
.dr-table__sort {
  flex: none;
  font-size: 9px;
  color: var(--text-dim, #666);
}
.dr-table__sort--active {
  color: var(--accent, #63b3ed);
}

/* Drag handle pinned to the right edge of each header cell. It must sit fully
   INSIDE the cell (right: 0, no negative overflow): a handle that straddles the
   border overlaps the next sticky <th>, and that sibling — its own stacking
   context, painted later — covers the overhanging half, so half the handle
   stops receiving pointer events. Keeping it inside keeps the whole strip
   grabbable. top/bottom (not height:100%) so the grab area fills the cell — a
   percentage height resolves to 0 inside a table cell, leaving nothing to grab. */
.dr-table__resizer {
  position: absolute;
  top: 0;
  bottom: 0;
  right: 0;
  width: 12px;
  z-index: 3;
  cursor: col-resize;
  touch-action: none;
}
/* Faint always-visible grip so the column is discoverably resizable; full row
   height (in both header rows) so it reads as one continuous divider rather than
   short dashes, and brightens to the accent on hover/drag. */
.dr-table__resizer::after {
  content: "";
  position: absolute;
  top: 0;
  bottom: 0;
  right: 4px;
  width: 2px;
  background: var(--border-color, rgba(255, 255, 255, 0.16));
}
.dr-table__resizer:hover::after,
.dr-table__resizer:active::after {
  background: var(--accent, #63b3ed);
}

/* Second header row: per-column filter controls. */
.dr-table__filter-row th {
  top: var(--dr-head-h, 32px);
  padding: 4px 6px;
  border-bottom: 1px solid var(--border-color, rgba(255, 255, 255, 0.08));
}
.dr-table__filter-input,
.dr-table__filter-select {
  width: 100%;
  box-sizing: border-box;
  font-size: 11px;
  padding: 2px 6px;
  border: 1px solid rgba(255, 255, 255, 0.12);
  background: rgba(255, 255, 255, 0.04);
  color: var(--text-primary, #e2e8f0);
  border-radius: 4px;
  outline: none;
  text-transform: none;
  font-weight: 400;
  letter-spacing: 0;
}
.dr-table__filter-input:focus,
.dr-table__filter-select:focus {
  border-color: var(--accent, #63b3ed);
}

.dr-table__check {
  width: 32px;
  text-align: center;
  padding: 6px 4px;
}
.dr-table__check input {
  cursor: pointer;
  width: 14px;
  height: 14px;
}

.dr-table__actions-head {
  width: 1%;
}

tbody td {
  padding: 6px 10px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.04);
  color: var(--text-primary, #d8e4f5);
  vertical-align: middle;
  white-space: nowrap;
}

/* In fixed layout, clip overflowing cell text to the (resizable) column width. */
.dr-table--fixed tbody td {
  overflow: hidden;
  text-overflow: ellipsis;
}
.dr-table--fixed tbody td.dr-table__actions,
.dr-table--fixed tbody td.dr-table__check {
  overflow: visible;
}

tbody tr {
  cursor: pointer;
}

tbody tr:hover {
  background: rgba(255, 255, 255, 0.03);
}

.dr-table__row--selected {
  background: var(--accent-subtle, rgba(99, 179, 237, 0.12));
}

.dr-table__td--right {
  text-align: right;
  font-variant-numeric: tabular-nums;
}

.dr-table__td--mono {
  font-family: "JetBrainsMono NFM", "CaskaydiaCove NFM", "Fira Code", "Consolas", monospace;
  color: #79c0ff;
}

.dr-table__actions {
  text-align: right;
  cursor: default;
}

.dr-table__empty {
  text-align: center;
  padding: 32px 12px !important;
  color: var(--text-dim, #888);
  font-style: italic;
}
</style>
