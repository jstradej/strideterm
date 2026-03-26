<template>
  <div class="file-list" :class="{ 'file-list--grid': store.viewMode === 'grid' }">
    <!-- Column headers (list mode) -->
    <div v-if="store.viewMode === 'list'" class="file-list__header">
      <span class="file-list__col file-list__col--name" @click="store.toggleSort('name')">
        Name {{ sortIndicator('name') }}
      </span>
      <span class="file-list__col file-list__col--size" @click="store.toggleSort('size')">
        Size {{ sortIndicator('size') }}
      </span>
      <span class="file-list__col file-list__col--modified" @click="store.toggleSort('modified')">
        Modified {{ sortIndicator('modified') }}
      </span>
      <span class="file-list__col file-list__col--type" @click="store.toggleSort('type')">
        Type {{ sortIndicator('type') }}
      </span>
    </div>

    <div class="file-list__body" ref="listBody">
      <!-- Parent directory -->
      <div
        v-if="store.currentPath"
        class="file-list__row file-list__row--parent"
        @dblclick="goUp"
        @click="goUp"
      >
        <span class="file-list__col file-list__col--name">
          <span class="file-list__icon">..</span>
          <span class="file-list__fname">(parent)</span>
        </span>
        <span class="file-list__col file-list__col--size"></span>
        <span class="file-list__col file-list__col--modified"></span>
        <span class="file-list__col file-list__col--type"></span>
      </div>

      <!-- Entries -->
      <FileListItem
        v-for="entry in store.sortedEntries"
        :key="entry.relativePath"
        :entry="entry"
        :selected="store.selectedEntry?.relativePath === entry.relativePath"
        :view-mode="store.viewMode"
        @click="onEntryClick(entry)"
        @dblclick="onEntryDblClick(entry)"
        @contextmenu.prevent="onContextMenu($event, entry)"
      />

      <div v-if="store.loading" class="file-list__loading">Loading...</div>
      <div v-else-if="!store.sortedEntries.length && !store.currentPath" class="file-list__empty">Empty directory</div>
    </div>
  </div>
</template>

<script setup>
import { inject } from "vue";
import { useFileManagerStore } from "../../../stores/file-manager.js";
import FileListItem from "./FileListItem.vue";

const emit = defineEmits(["navigate", "select", "open-edit"]);
const store = useFileManagerStore();

const fmRename = inject("fm-rename", null);
const fmDelete = inject("fm-delete", null);

function sortIndicator(column) {
  if (store.sortBy !== column) return "";
  return store.sortAsc ? "\u25b4" : "\u25be";
}

function goUp() {
  const parts = store.currentPath.split("/").filter(Boolean);
  parts.pop();
  emit("navigate", parts.join("/"));
}

function onEntryClick(entry) {
  if (entry.kind === "directory") {
    emit("navigate", entry.relativePath);
  } else {
    emit("select", entry);
  }
}

function onEntryDblClick(entry) {
  if (entry.kind === "file") {
    emit("open-edit", entry);
  }
}

function onContextMenu(event, entry) {
  // Could be extended with a custom context menu
}
</script>

<style scoped>
.file-list {
  display: flex;
  flex-direction: column;
  min-height: 0;
  overflow: hidden;
  border-bottom: 1px solid var(--border);
}

.file-list__header {
  display: grid;
  grid-template-columns: 1fr 80px 120px 70px;
  gap: 4px;
  padding: 4px 10px;
  font-size: 11px;
  font-weight: 600;
  color: var(--muted);
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
  user-select: none;
}

.file-list__col {
  cursor: pointer;
  white-space: nowrap;
}

.file-list__col--size,
.file-list__col--modified,
.file-list__col--type {
  text-align: right;
}

.file-list__body {
  overflow-y: auto;
  flex: 1;
  min-height: 0;
}

.file-list__row--parent {
  display: grid;
  grid-template-columns: 1fr 80px 120px 70px;
  gap: 4px;
  padding: 2px 10px;
  font-size: 12px;
  cursor: pointer;
  color: var(--muted);
}

.file-list__row--parent:hover {
  background: var(--border);
}

.file-list__icon {
  margin-right: 6px;
}

.file-list__fname {
  overflow: hidden;
  text-overflow: ellipsis;
}

.file-list__loading,
.file-list__empty {
  padding: 16px;
  color: var(--muted);
  font-size: 12px;
  text-align: center;
}

/* Grid mode */
.file-list--grid .file-list__header {
  display: none;
}

.file-list--grid .file-list__body {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  padding: 8px;
  align-content: flex-start;
}

.file-list--grid .file-list__row--parent {
  display: flex;
  width: 90px;
  height: 70px;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  border-radius: 6px;
  font-size: 11px;
}
</style>
