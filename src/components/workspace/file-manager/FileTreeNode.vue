<template>
  <div class="tree-node">
    <div
      class="tree-node__label"
      :class="{
        'tree-node__label--active': isActive,
        'tree-node__label--selected': isSelected,
        'tree-node__label--drop': isDropTarget,
        [`tree-node__label--git-${gitStatus}`]: !!gitStatus,
      }"
      :style="{ paddingLeft: depth * 14 + 6 + 'px' }"
      :title="gitStatus ? statusTitle(gitStatus) : node.entry.relativePath"
      draggable="true"
      @click="toggleAndNavigate"
      @contextmenu.prevent="showContextMenu"
      @dragstart="onDragStart"
      @dragover.prevent="onDragOver"
      @dragleave="onDragLeave"
      @drop.prevent="onDrop"
    >
      <span class="tree-node__chevron">{{ isExpanded ? "▾" : "▸" }}</span>
      <span class="tree-node__name">{{ node.entry.name }}</span>
      <span
        v-if="gitStatus"
        class="tree-node__status"
        :style="{ color: statusColor(gitStatus) }"
        :aria-label="statusLabel(gitStatus)"
      >
        {{ statusBadge(gitStatus) }}
      </span>
    </div>
    <div v-if="isExpanded && children.length" class="tree-node__children">
      <FileTreeNode v-for="child in children" :key="child.entry.relativePath" :node="child" :depth="depth + 1" />
    </div>
  </div>
</template>

<script setup>
import { computed, inject, ref } from "vue";
import { useFileManagerStore } from "../../../stores/file-manager.js";
import { statusBadge, statusColor, statusLabel, statusTitle } from "./git-status-helpers.js";

const props = defineProps({
  node: { type: Object, required: true },
  depth: { type: Number, default: 0 },
});

const store = useFileManagerStore();
const fmContextMenu = inject("fm-context-menu", null);
const fmDragState = inject("fm-drag-state", null);

const isDropTarget = ref(false);

const isExpanded = computed(() => store.treeNodes.get(props.node.entry.relativePath)?.expanded || false);
const isActive = computed(() => store.currentPath === props.node.entry.relativePath);
const isSelected = computed(() => store.selectedEntry?.relativePath === props.node.entry.relativePath);

const children = computed(() => {
  const path = props.node.entry.relativePath;
  const treeNode = store.treeNodes.get(path);
  return treeNode?.children || props.node.children || [];
});

const gitStatus = computed(() => {
  if (!store.gitIsRepo) return null;
  const path = props.node.entry.relativePath;
  // Directory rollup — show status of dirtiest descendant
  return store.getDirectoryStatusFor(path) || null;
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

function onDragStart(event) {
  if (fmDragState) fmDragState.value = props.node.entry;
  event.dataTransfer.effectAllowed = "move";
  event.dataTransfer.setData("text/plain", props.node.entry.relativePath);
}

function onDragOver(event) {
  if (!fmDragState?.value) return;
  if (fmDragState.value.relativePath === props.node.entry.relativePath) return;
  event.dataTransfer.dropEffect = "move";
  isDropTarget.value = true;
}

function onDragLeave() {
  isDropTarget.value = false;
}

async function onDrop() {
  isDropTarget.value = false;
  const dragged = fmDragState?.value;
  if (!dragged) return;
  await store.moveEntryTo(dragged, props.node.entry.relativePath);
  if (fmDragState) fmDragState.value = null;
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
  position: relative;
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

.tree-node__label--drop {
  outline: 1px dashed var(--accent);
  background: rgba(255, 164, 36, 0.16);
}

.tree-node__label--git-modified {
  border-left: 3px solid var(--fm-status-modified, #d8a14b);
  padding-left: 3px;
}
.tree-node__label--git-staged {
  border-left: 3px solid var(--fm-status-staged, #6cb478);
  padding-left: 3px;
}
.tree-node__label--git-untracked {
  border-left: 3px solid var(--fm-status-untracked, #5e9bd6);
  padding-left: 3px;
}
.tree-node__label--git-conflict {
  border-left: 3px solid var(--fm-status-conflict, #e26b6b);
  padding-left: 3px;
}
.tree-node__label--git-ignored {
  opacity: 0.55;
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

.tree-node__status {
  margin-left: auto;
  flex-shrink: 0;
  font-size: 10px;
  font-weight: 700;
  padding: 0 4px;
  border-radius: 3px;
  background: rgba(255, 255, 255, 0.06);
}
</style>
