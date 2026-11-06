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
        title="Filter files and folders by name in the current list and the explorer tree. A matching folder shows all its contents; folders that were never expanded are not searched. Press Escape to clear."
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
      class="file-toolbar__btn file-toolbar__btn--utility"
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
      v-if="layoutMode === 'browser'"
      type="button"
      class="file-toolbar__btn file-toolbar__btn--utility"
      :title="
        viewMode === 'list'
          ? 'Switch the file list to grid view — large icons in a wrap layout, easier for quick visual scanning of media folders.'
          : 'Switch the file list back to list view — one entry per row with name, size, and git status, easier to read and filter.'
      "
      @click="$emit('toggle-view')"
    >
      {{ viewMode === "list" ? "▦" : "≡" }}
    </button>
    <div class="file-toolbar__layouts" role="group" aria-label="File manager layout">
      <button
        v-for="option in layoutOptions"
        :key="option.mode"
        type="button"
        class="file-toolbar__btn file-toolbar__btn--utility"
        :class="{ 'file-toolbar__btn--active': layoutMode === option.mode }"
        :title="option.title"
        :aria-label="option.label"
        :aria-pressed="layoutMode === option.mode"
        @click="$emit('set-layout', option.mode)"
      >
        {{ option.glyph }}
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
type LayoutMode = "editor" | "browser" | "commander";

const layoutOptions: { mode: LayoutMode; glyph: string; label: string; title: string }[] = [
  {
    mode: "editor",
    glyph: "▤",
    label: "Editor layout",
    title: "Explorer tree and tabbed editor.",
  },
  {
    mode: "browser",
    glyph: "▥",
    label: "Browser layout",
    title: "Folder tree, file list and a preview.",
  },
  {
    mode: "commander",
    glyph: "◫",
    label: "Commander layout",
    title: "Two side-by-side file panels, browsed with the keyboard.",
  },
];

withDefaults(
  defineProps<{
    showHidden?: boolean;
    viewMode?: string;
    filterText?: string;
    gitIsRepo?: boolean;
    dirtyCount?: number;
    layoutMode?: LayoutMode;
  }>(),
  { showHidden: false, viewMode: "list", filterText: "", gitIsRepo: false, dirtyCount: 0 },
);
defineEmits<{
  (e: "create-file"): void;
  (e: "create-dir"): void;
  (e: "refresh"): void;
  (e: "toggle-hidden"): void;
  (e: "toggle-view"): void;
  (e: "set-layout", mode: LayoutMode): void;
  (e: "filter", value: string): void;
}>();
</script>

<style scoped>
.file-toolbar {
  container: file-toolbar / inline-size;
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 4px 8px;
  flex-wrap: wrap;
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
  touch-action: manipulation;
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

.file-toolbar__layouts {
  display: inline-flex;
  gap: 2px;
}

@container file-toolbar (max-width: 560px) {
  .file-toolbar__btn {
    min-width: 36px;
    min-height: 36px;
    padding: 5px 9px;
  }

  .file-toolbar__search {
    order: 1;
    flex: 1 0 100%;
    margin: 0;
  }

  .file-toolbar__search-input {
    width: 100%;
    min-height: 36px;
  }

  .file-toolbar__legend {
    order: 2;
    flex: 1 1 auto;
    min-width: 100px;
    margin-left: 0;
  }

  .file-toolbar__spacer {
    display: none;
  }

  .file-toolbar__btn--utility,
  .file-toolbar__layouts {
    order: 2;
  }
}
</style>
