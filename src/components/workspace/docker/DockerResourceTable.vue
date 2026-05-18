<template>
  <div class="dr-table">
    <div class="dr-table__scroll">
      <table>
        <thead>
          <tr>
            <th class="dr-table__check">
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
              :class="[
                col.sortable !== false && 'dr-table__th--sortable',
                col.align === 'right' && 'dr-table__th--right',
                sortKey === col.key && 'dr-table__th--active',
              ]"
              :style="col.width ? { width: col.width } : undefined"
              :aria-sort="sortKey === col.key ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none'"
              @click="onSort(col)"
            >
              <span class="dr-table__th-label">{{ col.label }}</span>
              <span v-if="sortKey === col.key" class="dr-table__sort">{{ sortDir === "asc" ? "▲" : "▼" }}</span>
            </th>
            <th v-if="hasRowActions" class="dr-table__actions-head" />
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="row in sortedRows"
            :key="rowId(row)"
            :class="[selectedSet.has(rowId(row)) && 'dr-table__row--selected', rowClass ? rowClass(row) : undefined]"
          >
            <td class="dr-table__check" @click.stop>
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
            <td :colspan="columns.length + (hasRowActions ? 2 : 1)" class="dr-table__empty">
              <slot name="empty">No items.</slot>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>

<script setup lang="ts" generic="T extends object">
import { computed, ref, watch } from "vue";

/**
 * Generic, slot-based table for docker resource lists. Owns its sort state
 * (parent passes `defaultSort`) and selection state (via `v-model:selected`).
 * Per-cell rendering happens through named slots `cell-<column.key>`, so each
 * caller (images / volumes / networks) keeps its bespoke formatting close to
 * the column definition without this component needing to know the row shape.
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
}

const props = defineProps<{
  rows: T[];
  columns: Column<T>[];
  rowId: (row: T) => string;
  defaultSort?: { key: string; dir: "asc" | "desc" };
  selected: Set<string>;
  rowClass?: (row: T) => string | undefined;
  hasRowActions?: boolean;
}>();

const emit = defineEmits<{
  "row-click": [row: T];
  "update:selected": [next: Set<string>];
}>();

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

const selectedSet = computed(() => props.selected);

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
  if (!sortKey.value) return props.rows;
  const col = props.columns.find((c) => c.key === sortKey.value);
  if (!col) return props.rows;
  const dirMul = sortDir.value === "asc" ? 1 : -1;
  return [...props.rows].sort((a, b) => {
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

function toggleRow(id: string): void {
  const next = new Set(props.selected);
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
  () => props.rows.length > 0 && props.rows.every((r) => props.selected.has(props.rowId(r))),
);
const someSelected = computed(() => props.rows.some((r) => props.selected.has(props.rowId(r))));
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
  margin-left: 4px;
  font-size: 9px;
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
