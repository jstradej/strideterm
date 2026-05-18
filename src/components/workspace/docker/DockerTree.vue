<template>
  <div class="docker-tree" role="tree" aria-label="Docker containers">
    <div v-if="nodes.length === 0" class="docker-tree__empty">
      <span class="text-dim">{{ filterActive ? "No matches." : "No containers" }}</span>
    </div>
    <ul v-else class="docker-tree__list">
      <DockerTreeNode
        v-for="node in nodes"
        :key="node.id"
        :node="node"
        :depth="0"
        :selected-id="selectedId"
        @select="onSelect"
        @toggle="treeStore.toggle"
        @context-menu="onContextMenu"
      />
    </ul>
  </div>
</template>

<script setup lang="ts">
import DockerTreeNode from "./DockerTreeNode.vue";
import { useDockerTree } from "../../../stores/docker-tree.js";
import type { TreeNode } from "../../../stores/docker-tree.js";

withDefaults(
  defineProps<{
    nodes: TreeNode[];
    selectedId: string | null;
    filterActive?: boolean;
  }>(),
  { filterActive: false },
);

const emit = defineEmits<{
  select: [node: TreeNode];
  "context-menu": [node: TreeNode];
}>();

const treeStore = useDockerTree();

function onSelect(node: TreeNode): void {
  emit("select", node);
}

function onContextMenu(node: TreeNode): void {
  emit("context-menu", node);
}
</script>

<style scoped>
.docker-tree {
  height: 100%;
  overflow-y: auto;
  padding: 4px 0;
}

.docker-tree__list {
  list-style: none;
  margin: 0;
  padding: 0;
}

.docker-tree__empty {
  padding: 16px;
  font-size: 13px;
  color: var(--text-dim, #888);
}

.text-dim {
  color: var(--text-dim, #888);
}
</style>
