<template>
  <div class="tree-node">
    <div
      class="tree-node__label"
      :class="{
        'tree-node__label--active': isActive,
        'tree-node__label--selected': isSelected,
      }"
      :style="{ paddingLeft: depth * 14 + 6 + 'px' }"
      @click="toggleAndNavigate"
      @contextmenu.prevent="showContextMenu"
    >
      <span class="tree-node__chevron">{{ isExpanded ? "\u25be" : "\u25b8" }}</span>
      <span class="tree-node__name">{{ node.entry.name }}</span>
    </div>
    <div v-if="isExpanded && children.length" class="tree-node__children">
      <FileTreeNode v-for="child in children" :key="child.entry.relativePath" :node="child" :depth="depth + 1" />
    </div>
  </div>
</template>

<script setup>
import { computed, inject } from "vue";
import { useFileManagerStore } from "../../../stores/file-manager.js";

const props = defineProps({
  node: { type: Object, required: true },
  depth: { type: Number, default: 0 },
});

const store = useFileManagerStore();
const fmContextMenu = inject("fm-context-menu", null);

const isExpanded = computed(() => store.treeNodes.get(props.node.entry.relativePath)?.expanded || false);
const isActive = computed(() => store.currentPath === props.node.entry.relativePath);
const isSelected = computed(() => store.selectedEntry?.relativePath === props.node.entry.relativePath);

const children = computed(() => {
  const path = props.node.entry.relativePath;
  const treeNode = store.treeNodes.get(path);
  return treeNode?.children || props.node.children || [];
});

async function toggleAndNavigate() {
  const path = props.node.entry.relativePath;
  if (isExpanded.value) {
    store.collapseTreeNode(path);
  } else {
    await store.expandTreeNode(path);
  }
  store.navigate(path);
}

function showContextMenu(event) {
  if (fmContextMenu) fmContextMenu(event, props.node.entry);
}
</script>

<style scoped>
.tree-node__label {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 2px 8px 2px 6px;
  cursor: pointer;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  border-radius: 3px;
  margin: 0 2px;
}

.tree-node__label:hover {
  background: var(--border);
}

.tree-node__label--active {
  background: rgba(255, 164, 36, 0.12);
  color: var(--accent);
}

.tree-node__label--selected {
  background: rgba(255, 164, 36, 0.08);
}

.tree-node__chevron {
  flex-shrink: 0;
  width: 10px;
  font-size: 10px;
  color: var(--muted);
  text-align: center;
}

.tree-node__name {
  overflow: hidden;
  text-overflow: ellipsis;
}
</style>
