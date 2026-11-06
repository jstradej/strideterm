<template>
  <section class="fcp" :class="{ 'fcp--active': active }" :data-active="active" @mousedown="$emit('activate')">
    <div class="fcp__drive">
      <button type="button" class="fcp__drive-btn" title="Go to the workspace root" @click="$emit('go-root')">
        ▣ {{ rootName }}
      </button>
      <button type="button" class="fcp__drive-btn" title="Go to the workspace root" @click="$emit('go-root')">\</button>
      <button
        type="button"
        class="fcp__drive-btn"
        title="Go to the parent folder"
        :disabled="!path"
        @click="$emit('go-up')"
      >
        ..
      </button>
      <FileCommanderLaunchMenu
        class="fcp__drive-btn--first-action"
        :items="shells ?? []"
        :current-key="shellKey"
        label="Open a terminal in this folder"
        menu-label="Choose a shell"
        title="Open {name} in this folder"
        empty-title="No shell available"
        shortcut="Ctrl+Shift+T"
        @pick="(key: string) => $emit('open-terminal', key)"
      >
        &gt;_
      </FileCommanderLaunchMenu>
      <FileCommanderLaunchMenu
        :items="agents ?? []"
        :current-key="agentKey"
        label="Open an agent in this folder"
        menu-label="Choose an agent"
        title="Open {name} in this folder"
        empty-title="No agent available"
        @pick="(key: string) => $emit('open-agent', key)"
      >
        <span class="fcp__emoji">🤖</span>
      </FileCommanderLaunchMenu>
      <button
        type="button"
        class="fcp__drive-btn"
        title="Compare the marked files, or the cursor file with the same name in the other panel (Ctrl+Shift+D)"
        aria-label="Compare files"
        @click="$emit('compare')"
      >
        ⇄
      </button>
    </div>
    <div class="fcp__path" :title="pathLine">{{ pathLine }}</div>
    <div class="fcp__header">
      <button type="button" class="fcp__h fcp__h--name" @click="$emit('sort', 'name')">
        Name{{ indicator("name") }}
      </button>
      <button type="button" class="fcp__h fcp__h--ext" @click="$emit('sort', 'ext')">Ext{{ indicator("ext") }}</button>
      <button type="button" class="fcp__h fcp__h--size" @click="$emit('sort', 'size')">
        Size{{ indicator("size") }}
      </button>
      <button type="button" class="fcp__h fcp__h--date" @click="$emit('sort', 'modified')">
        Date{{ indicator("modified") }}
      </button>
      <span class="fcp__h fcp__h--git">Git</span>
    </div>
    <div ref="body" class="fcp__body" role="listbox" :aria-label="`${side} panel`">
      <div
        v-for="(row, index) in rows"
        :key="row.key"
        class="fcp__row"
        :class="{
          'fcp__row--cursor': index === cursor,
          'fcp__row--marked': marked.has(row.key),
          'fcp__row--dir': row.parent || row.entry?.kind === 'directory',
        }"
        role="option"
        :aria-selected="index === cursor"
        :data-index="index"
        :title="row.entry?.name || '..'"
        :draggable="!row.parent && !!row.entry"
        @dragstart="onRowDragStart(row, $event)"
        @click="$emit('row-click', index, $event)"
        @dblclick="$emit('row-dblclick', index)"
        @contextmenu.prevent="$emit('row-contextmenu', index, $event)"
      >
        <span class="fcp__c fcp__c--name">
          <span class="fcp__icon">{{ row.entry ? iconFor(row.entry) : "↰" }}</span>
          <span class="fcp__name">
            <template v-if="row.parent">[..]</template>
            <template v-else-if="row.entry!.kind === 'directory'">[{{ row.entry!.name }}]</template>
            <template v-else
              ><span class="fcp__base">{{ splitName(row.entry!).base }}</span
              ><span v-if="splitName(row.entry!).ext" class="fcp__dotext"
                >.{{ splitName(row.entry!).ext }}</span
              ></template
            >
          </span>
        </span>
        <span class="fcp__c fcp__c--ext">{{ row.entry ? splitName(row.entry).ext : "" }}</span>
        <span class="fcp__c fcp__c--size">{{ sizeText(row) }}</span>
        <span class="fcp__c fcp__c--date">
          <span class="fcp__date-full">{{ formatCommanderDate(row.entry?.modifiedAt, true) }}</span>
          <span class="fcp__date-short">{{ formatCommanderDate(row.entry?.modifiedAt, false) }}</span>
        </span>
        <span class="fcp__c fcp__c--git" :style="{ color: gitColor(row) }" :title="gitTitle(row)">{{
          gitLetter(row)
        }}</span>
      </div>
      <div v-if="loading && !rows.length" class="fcp__empty">Loading…</div>
      <div v-else-if="!rows.length" class="fcp__empty">Empty</div>
    </div>
    <div class="fcp__status" :class="{ 'fcp__status--error': !!error }" :title="error || statusLine">
      {{ error || statusLine }}
    </div>
    <div v-if="search" class="fcp__search" role="status">Search: {{ search }}</div>
  </section>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { useFileManagerStore } from "../../../stores/file-manager.js";
import { useAppStore } from "../../../stores/app.js";
import { runtimeAbsolutePath, setDragPaths } from "../../../lib/terminal-path-drop.js";
import FileCommanderLaunchMenu, { type LaunchItem } from "./FileCommanderLaunchMenu.vue";
import { statusColor, statusTitle } from "./git-status-helpers.js";
import { iconFor } from "./file-icons.js";
import {
  formatBytes,
  formatCommanderDate,
  splitName,
  type CommanderRow,
  type CommanderSortKey,
} from "./commander-helpers.js";

const props = defineProps<{
  rows: CommanderRow[];
  cursor: number;
  marked: Set<string>;
  active: boolean;
  side: "left" | "right";
  path: string;
  rootName: string;
  sortBy: CommanderSortKey;
  sortAsc: boolean;
  loading: boolean;
  error: string;
  search?: string;
  shells?: LaunchItem[];
  shellKey?: string;
  agents?: LaunchItem[];
  agentKey?: string;
}>();

defineEmits<{
  (e: "open-agent", key: string): void;
  (e: "open-terminal", key: string): void;
  (e: "activate"): void;
  (e: "row-click", index: number, event: MouseEvent): void;
  (e: "row-dblclick", index: number): void;
  (e: "row-contextmenu", index: number, event: MouseEvent): void;
  (e: "sort", key: CommanderSortKey): void;
  (e: "go-root"): void;
  (e: "go-up"): void;
  (e: "compare"): void;
}>();

const store = useFileManagerStore();
const appStore = useAppStore();
const body = ref<HTMLElement | null>(null);

function onRowDragStart(row: CommanderRow, event: DragEvent) {
  const dragged = props.marked.has(row.key)
    ? props.rows.filter((candidate) => candidate.entry && props.marked.has(candidate.key))
    : [row];
  const platform = appStore.payload?.meta?.platform || "";
  setDragPaths(
    event.dataTransfer,
    dragged.map((item) => runtimeAbsolutePath(store.rootPath, item.entry!.relativePath, platform)),
  );
}

const pathLine = computed(() => `${props.rootName}${props.path ? `/${props.path}` : ""}/*.*`);

const statusLine = computed(() => {
  let files = 0;
  let dirs = 0;
  let markedFiles = 0;
  let markedDirs = 0;
  let bytes = 0;
  let markedBytes = 0;
  for (const row of props.rows) {
    if (!row.entry) continue;
    const marked = props.marked.has(row.key);
    if (row.entry.kind === "directory") {
      dirs += 1;
      if (marked) markedDirs += 1;
    } else {
      files += 1;
      bytes += row.entry.size || 0;
      if (marked) {
        markedFiles += 1;
        markedBytes += row.entry.size || 0;
      }
    }
  }
  return `${formatBytes(markedBytes)} / ${formatBytes(bytes)} in ${markedFiles} / ${files} files, ${markedDirs} / ${dirs} folders`;
});

function sizeText(row: CommanderRow) {
  if (row.parent || row.entry?.kind === "directory") return "<DIR>";
  return (row.entry?.size ?? 0).toLocaleString();
}

function indicator(key: CommanderSortKey) {
  if (props.sortBy !== key) return "";
  return props.sortAsc ? " ▲" : " ▼";
}

function gitStatusOf(row: CommanderRow): string | null {
  if (!store.gitIsRepo || !row.entry) return null;
  if (row.entry.kind === "directory") return store.getDirectoryStatusFor(row.entry.relativePath) || null;
  return store.getStatusFor(row.entry.relativePath)?.status || null;
}

const GIT_LETTERS: Record<string, string> = { modified: "M", staged: "S", untracked: "U", conflict: "C" };

function gitLetter(row: CommanderRow) {
  const status = gitStatusOf(row);
  return status ? GIT_LETTERS[status] || "" : "";
}

function gitColor(row: CommanderRow) {
  const status = gitStatusOf(row);
  return status ? statusColor(status) : undefined;
}

function gitTitle(row: CommanderRow) {
  const status = gitStatusOf(row);
  return status ? statusTitle(status) : undefined;
}

function pageSize(): number {
  const container = body.value;
  const row = container?.querySelector<HTMLElement>(".fcp__row");
  if (!container || !row || !row.offsetHeight) return 10;
  return Math.max(1, Math.floor(container.clientHeight / row.offsetHeight) - 1);
}

watch(
  () => [props.cursor, props.rows.length],
  async () => {
    await nextTick();
    body.value?.querySelector<HTMLElement>(`[data-index="${props.cursor}"]`)?.scrollIntoView?.({ block: "nearest" });
  },
);

defineExpose({ pageSize });
</script>

<style scoped>
.fcp {
  position: relative;
  container: fc-panel / inline-size;
  display: flex;
  flex-direction: column;
  height: 100%;
  min-width: 0;
  background: var(--bg);
  color: var(--text);
  font-size: 12px;
  user-select: none;
}

.fcp__drive {
  display: flex;
  flex: 0 0 auto;
  gap: 3px;
  padding: 3px 4px;
  background: var(--panel);
  border-bottom: 1px solid var(--border);
}

.fcp__drive :deep(.fcp__drive-btn) {
  min-width: 0;
  max-width: 60%;
  padding: 1px 8px;
  overflow: hidden;
  border: 1px solid var(--border);
  border-radius: 3px;
  background: transparent;
  color: var(--text);
  font: inherit;
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
  cursor: pointer;
}

.fcp__drive-btn--first-action {
  margin-left: auto;
}

.fcp__drive :deep(.fcp__emoji) {
  margin-right: 6px;
  font-family: "Segoe UI Emoji", "Apple Color Emoji", "Noto Color Emoji", sans-serif;
}

.fcp__drive :deep(.fcp__drive-btn .fcp__emoji) {
  margin-right: 0;
}

.fcp__drive :deep(.fcp__drive-btn:hover:not(:disabled)) {
  background: var(--border);
}

.fcp__drive :deep(.fcp__drive-btn:disabled) {
  opacity: 0.4;
  cursor: default;
}

.fcp__path {
  flex: 0 0 auto;
  padding: 2px 8px;
  overflow: hidden;
  background: var(--panel);
  color: var(--muted);
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.fcp--active .fcp__path {
  background: var(--accent);
  color: #141416;
}

.fcp__header,
.fcp__row {
  display: grid;
  grid-template-columns: var(--fcp-cols, minmax(0, 1fr) 44px 84px 104px 22px);
  align-items: center;
  column-gap: 6px;
  padding: 0 6px;
}

.fcp__header {
  flex: 0 0 auto;
  border-bottom: 1px solid var(--border);
  background: var(--panel);
}

.fcp__h {
  min-width: 0;
  padding: 2px 0;
  overflow: hidden;
  border: 0;
  background: transparent;
  color: var(--muted);
  font: inherit;
  font-size: 11px;
  text-align: left;
  text-overflow: ellipsis;
  white-space: nowrap;
  cursor: pointer;
}

.fcp__h:hover {
  color: var(--text);
}

.fcp__h--git {
  cursor: default;
  text-align: center;
}

.fcp__h--size,
.fcp__h--date {
  text-align: right;
}

.fcp__body {
  flex: 1 1 auto;
  min-height: 0;
  overflow-x: hidden;
  overflow-y: auto;
}

.fcp__row {
  min-height: 20px;
  line-height: 20px;
  outline: 1px solid transparent;
  outline-offset: -1px;
  cursor: default;
}

.fcp__row:nth-child(even) {
  background: color-mix(in srgb, var(--text) 3%, transparent);
}

.fcp__row:hover {
  background: color-mix(in srgb, var(--text) 6%, transparent);
}

.fcp__row--cursor,
.fcp__row--cursor:hover {
  outline: 1px dotted var(--muted);
}

.fcp--active .fcp__row--cursor,
.fcp--active .fcp__row--cursor:hover {
  background: color-mix(in srgb, var(--accent) 28%, transparent);
  outline: 1px solid var(--accent);
}

.fcp__row--marked {
  color: var(--danger);
  font-weight: 700;
}

.fcp__c {
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
}

.fcp__c--name {
  display: flex;
  align-items: center;
  gap: 5px;
}

.fcp__icon {
  flex: 0 0 16px;
  width: 16px;
  font-size: 11px;
  text-align: center;
}

.fcp__name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.fcp__dotext {
  display: none;
}

.fcp__c--ext {
  color: var(--muted);
}

.fcp__row--marked .fcp__c--ext,
.fcp__row--marked .fcp__c--size,
.fcp__row--marked .fcp__c--date {
  color: inherit;
}

.fcp__c--size,
.fcp__c--date {
  font-variant-numeric: tabular-nums;
  text-align: right;
}

.fcp__c--date {
  color: var(--muted);
}

.fcp__date-short {
  display: none;
}

.fcp__c--git {
  font-size: 11px;
  font-weight: 700;
  text-align: center;
}

.fcp__empty {
  padding: 10px;
  color: var(--muted);
  text-align: center;
}

.fcp__status {
  flex: 0 0 auto;
  padding: 2px 8px;
  overflow: hidden;
  border-top: 1px solid var(--border);
  background: var(--panel);
  color: var(--muted);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.fcp__search {
  position: absolute;
  bottom: 0;
  left: 0;
  max-width: 100%;
  padding: 2px 8px;
  overflow: hidden;
  background: var(--accent);
  color: #141416;
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.fcp__status--error {
  color: var(--danger);
}

@container fc-panel (max-width: 559px) {
  .fcp__header,
  .fcp__row {
    --fcp-cols: minmax(0, 1fr) 84px 72px 22px;
  }

  .fcp__c--ext,
  .fcp__h--ext {
    display: none;
  }

  .fcp__dotext {
    display: inline;
  }

  .fcp__date-full {
    display: none;
  }

  .fcp__date-short {
    display: inline;
  }
}

@container fc-panel (max-width: 359px) {
  .fcp__header,
  .fcp__row {
    --fcp-cols: minmax(0, 1fr) 78px 22px;
  }

  .fcp__c--date,
  .fcp__h--date {
    display: none;
  }
}

@media (pointer: coarse) {
  .fcp__row {
    min-height: 36px;
    line-height: 36px;
  }

  .fcp__drive :deep(.fcp__drive-btn) {
    min-height: 32px;
  }
}
</style>
