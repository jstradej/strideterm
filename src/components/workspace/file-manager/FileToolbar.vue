<template>
  <div class="file-toolbar">
    <button type="button" class="file-toolbar__btn" title="New File" @click="$emit('create-file')">+ File</button>
    <button type="button" class="file-toolbar__btn" title="New Folder" @click="$emit('create-dir')">+ Folder</button>
    <button type="button" class="file-toolbar__btn" title="Refresh" @click="$emit('refresh')">&#x21bb;</button>
    <div class="file-toolbar__spacer"></div>
    <button
      type="button"
      class="file-toolbar__btn"
      :class="{ 'file-toolbar__btn--active': showHidden }"
      title="Toggle hidden files"
      @click="$emit('toggle-hidden')"
    >.*</button>
    <button type="button" class="file-toolbar__btn" :title="viewMode === 'list' ? 'Grid view' : 'List view'" @click="$emit('toggle-view')">
      {{ viewMode === 'list' ? '\u25a6' : '\u2630' }}
    </button>
  </div>
</template>

<script setup>
defineProps({
  showHidden: { type: Boolean, default: false },
  viewMode: { type: String, default: "list" },
});
defineEmits(["create-file", "create-dir", "refresh", "toggle-hidden", "toggle-view"]);
</script>

<style scoped>
.file-toolbar {
  display: flex;
  align-items: center;
  gap: 2px;
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

.file-toolbar__spacer {
  flex: 1;
}
</style>
