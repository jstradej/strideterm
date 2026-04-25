<template>
  <div class="file-toolbar">
    <button type="button" class="file-toolbar__btn" title="New File (Ctrl+N)" @click="$emit('create-file')">
      + File
    </button>
    <button type="button" class="file-toolbar__btn" title="New Folder (Ctrl+Shift+N)" @click="$emit('create-dir')">
      + Folder
    </button>
    <button type="button" class="file-toolbar__btn" title="Refresh (F5)" @click="$emit('refresh')">↻</button>

    <div class="file-toolbar__search">
      <input
        type="search"
        :value="filterText"
        placeholder="Filter…"
        class="file-toolbar__search-input"
        @input="$emit('filter', $event.target.value)"
        @keydown.escape="$emit('filter', '')"
      />
    </div>

    <span v-if="gitIsRepo" class="file-toolbar__legend" :title="dirtyCount + ' dirty file(s)'">
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
      title="Toggle hidden files"
      @click="$emit('toggle-hidden')"
    >
      .*
    </button>
    <button
      type="button"
      class="file-toolbar__btn"
      :title="viewMode === 'list' ? 'Grid view' : 'List view'"
      @click="$emit('toggle-view')"
    >
      {{ viewMode === "list" ? "▦" : "≡" }}
    </button>
  </div>
</template>

<script setup>
defineProps({
  showHidden: { type: Boolean, default: false },
  viewMode: { type: String, default: "list" },
  filterText: { type: String, default: "" },
  gitIsRepo: { type: Boolean, default: false },
  dirtyCount: { type: Number, default: 0 },
});
defineEmits(["create-file", "create-dir", "refresh", "toggle-hidden", "toggle-view", "filter"]);
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
