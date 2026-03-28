<template>
  <div class="file-tree">
    <FileTreeNode v-for="child in rootChildren" :key="child.entry.relativePath" :node="child" :depth="0" />
    <div v-if="!rootChildren.length" class="file-tree__empty">No folders</div>
  </div>
</template>

<script setup>
import { computed } from "vue";
import { useFileManagerStore } from "../../../stores/file-manager.js";
import FileTreeNode from "./FileTreeNode.vue";

const store = useFileManagerStore();

const rootChildren = computed(() => {
  const root = store.treeNodes.get("");
  return root?.children || [];
});
</script>

<style scoped>
.file-tree {
  font-size: 12px;
  user-select: none;
}

.file-tree__empty {
  padding: 12px;
  color: var(--muted);
  font-size: 11px;
  text-align: center;
}
</style>
