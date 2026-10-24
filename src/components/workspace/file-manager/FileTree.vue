<template>
  <div class="file-tree" role="tree" aria-label="Workspace files">
    <div class="file-tree__root">
      <span class="file-tree__root-icon">▣</span>
      <strong>{{ rootName }}</strong>
      <span class="file-tree__root-path" :title="store.rootPath">{{ store.rootPath }}</span>
    </div>
    <FileTreeNode
      v-for="child in visibleChildren"
      :key="child.entry.relativePath"
      :node="child"
      :depth="0"
      :editor-layout="editorLayout"
      @select-file="$emit('select-file', $event)"
      @navigate-directory="$emit('navigate-directory', $event)"
    />
    <div v-if="!visibleChildren.length" class="file-tree__empty">
      {{ emptyMessage }}
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { useFileManagerStore } from "../../../stores/file-manager.js";
import FileTreeNode from "./FileTreeNode.vue";

const props = withDefaults(defineProps<{ editorLayout?: boolean }>(), { editorLayout: false });
defineEmits<{
  (event: "select-file", entry: { name: string; relativePath: string; kind: string }): void;
  (event: "navigate-directory", entry: { name: string; relativePath: string; kind: string }): void;
}>();
const store = useFileManagerStore();
const rootName = computed(() => store.rootPath.split(/[/\\]/).filter(Boolean).at(-1) || "Workspace");

const rootChildren = computed(() => {
  const root = store.treeNodes.get("");
  return root?.children || [];
});
const visibleChildren = computed(() => {
  const filter = store.filterText.trim().toLowerCase();
  const children = props.editorLayout
    ? rootChildren.value
    : rootChildren.value.filter((node) => node.entry.kind === "directory");
  return filter
    ? children.filter((node) => node.entry.kind === "directory" || node.entry.name.toLowerCase().includes(filter))
    : children;
});
const emptyMessage = computed(() => {
  if (store.filterText) return props.editorLayout ? "No matching files" : "No matching folders";
  return props.editorLayout ? "This folder is empty" : "No folders";
});
</script>

<style scoped>
.file-tree {
  font-size: 13px;
  user-select: none;
}

.file-tree__root {
  display: flex;
  align-items: center;
  gap: 7px;
  min-height: 29px;
  padding: 0 9px 0 10px;
  margin-bottom: 3px;
  color: var(--text);
  font-size: 12px;
  border-bottom: 1px solid color-mix(in srgb, var(--border), transparent 25%);
}

.file-tree__root-icon {
  color: var(--accent);
  font-size: 13px;
}

.file-tree__root-path {
  overflow: hidden;
  margin-left: auto;
  color: var(--muted);
  font-size: 10px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.file-tree__empty {
  padding: 12px;
  color: var(--muted);
  font-size: 11px;
  text-align: center;
}
</style>
