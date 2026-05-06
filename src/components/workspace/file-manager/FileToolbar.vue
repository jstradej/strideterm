<template>
  <div class="file-toolbar">
    <button
      type="button"
      class="file-toolbar__btn"
      title="Create a new empty file in the current directory — opens an inline name prompt, then creates the file on disk and selects it. Shortcut: Ctrl+N."
      @click="$emit('create-file')"
    >
      + File
    </button>
    <button
      type="button"
      class="file-toolbar__btn"
      title="Create a new empty subdirectory in the current directory — opens an inline name prompt, then makes the folder on disk. Shortcut: Ctrl+Shift+N."
      @click="$emit('create-dir')"
    >
      + Folder
    </button>
    <button
      type="button"
      class="file-toolbar__btn"
      title="Re-read the current directory listing from disk — picks up changes made by other processes (build outputs, git operations, external tools). Shortcut: F5."
      @click="$emit('refresh')"
    >
      ↻
    </button>

    <div class="file-toolbar__search">
      <input
        type="search"
        :value="filterText"
        placeholder="Filter…"
        title="Filter the file list to entries whose name contains this text (case-insensitive). Press Escape to clear the filter."
        class="file-toolbar__search-input"
        @input="$emit('filter', ($event.target as HTMLInputElement).value)"
        @keydown.escape="$emit('filter', '')"
      />
    </div>

    <span
      v-if="gitIsRepo"
      class="file-toolbar__legend"
      :title="`Git status legend for this directory. M = modified, S = staged, U = untracked. ${dirtyCount} file${dirtyCount === 1 ? '' : 's'} currently dirty.`"
    >
      <span class="file-toolbar__legend-item" :style="{ color: 'var(--fm-status-modified, #d8a14b)' }">M</span>
      <span class="file-toolbar__legend-item" :style="{ color: 'var(--fm-status-staged, #6cb478)' }">S</span>
      <span class="file-toolbar__legend-item" :style="{ color: 'var(--fm-status-untracked, #5e9bd6)' }">U</span>
      <span v-if="dirtyCount" class="file-toolbar__count">{{ dirtyCount }} dirty</span>
      <span v-else class="file-toolbar__count file-toolbar__count--clean">clean</span>
    </span>

    <div class="file-toolbar__spacer"></div>

    <button
      type="button"
      class="file-toolbar__btn"
      :class="{ 'file-toolbar__btn--active': showHidden }"
      :title="
        showHidden
          ? 'Hide files and folders that start with a dot (.git, .env, …) — they will be filtered out of the listing.'
          : 'Show files and folders that start with a dot (.git, .env, …) — currently hidden.'
      "
      @click="$emit('toggle-hidden')"
    >
      .*
    </button>
    <button
      type="button"
      class="file-toolbar__btn"
      :title="
        viewMode === 'list'
          ? 'Switch the file list to grid view — large icons in a wrap layout, easier for quick visual scanning of media folders.'
          : 'Switch the file list back to list view — one entry per row with name, size, and git status, easier to read and filter.'
      "
      @click="$emit('toggle-view')"
    >
      {{ viewMode === "list" ? "▦" : "≡" }}
    </button>
  </div>
</template>

<script setup lang="ts">
withDefaults(
  defineProps<{
    showHidden?: boolean;
    viewMode?: string;
    filterText?: string;
    gitIsRepo?: boolean;
    dirtyCount?: number;
  }>(),
  { showHidden: false, viewMode: "list", filterText: "", gitIsRepo: false, dirtyCount: 0 },
);
defineEmits<{
  (e: "create-file"): void;
  (e: "create-dir"): void;
  (e: "refresh"): void;
  (e: "toggle-hidden"): void;
  (e: "toggle-view"): void;
  (e: "filter", value: string): void;
}>();
</script>

<style scoped>
.file-toolbar {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 4px 8px;
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}

.file-toolbar__btn {
  background: none;
  border: 1px solid transparent;
  color: var(--muted);
  font-size: 12px;
  padding: 3px 8px;
  border-radius: 4px;
  cursor: pointer;
  white-space: nowrap;
}

.file-toolbar__btn:hover {
  background: var(--border);
  color: var(--text);
}

.file-toolbar__btn--active {
  color: var(--accent);
}

.file-toolbar__search {
  display: flex;
  align-items: center;
  margin-left: 4px;
}

.file-toolbar__search-input {
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 3px 8px;
  color: var(--text);
  font-size: 12px;
  width: 140px;
  outline: none;
}

.file-toolbar__search-input:focus {
  border-color: var(--accent);
}

.file-toolbar__legend {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  margin-left: 6px;
  font-size: 11px;
}

.file-toolbar__legend-item {
  font-weight: 700;
}

.file-toolbar__count {
  color: var(--muted);
  font-size: 11px;
  margin-left: 4px;
}

.file-toolbar__count--clean {
  color: var(--fm-status-staged, #6cb478);
}

.file-toolbar__spacer {
  flex: 1;
}
</style>
