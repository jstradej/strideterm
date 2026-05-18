<template>
  <li
    :class="['tree-node', `tree-node--${node.kind}`, `tree-node--${node.status}`, selected && 'tree-node--selected']"
    :style="{ paddingLeft: `${depth * 14 + 8}px` }"
  >
    <div
      class="tree-node__row"
      role="treeitem"
      :aria-expanded="hasChildren ? isExpanded : undefined"
      :aria-selected="node.kind === 'container' ? selected : undefined"
      tabindex="0"
      @click="onRowClick"
      @keydown="onKeyDown"
      @contextmenu.prevent="emit('context-menu', node)"
    >
      <!-- Expand toggle -->
      <span v-if="hasChildren" class="tree-node__toggle" @click.stop="emit('toggle', node.id)">
        {{ isExpanded ? "▼" : "▶" }}
      </span>
      <span v-else class="tree-node__toggle tree-node__toggle--leaf" />

      <!-- Status icon -->
      <span :class="['tree-node__icon', statusIconClass]" :title="statusLabel" />

      <!-- Label -->
      <span class="tree-node__label">{{ node.label }}</span>

      <!-- Meta info for images / volumes / networks (size, driver, ...) -->
      <span
        v-if="node.meta && (node.kind === 'image' || node.kind === 'volume' || node.kind === 'network')"
        class="tree-node__meta"
      >
        {{ node.meta }}
      </span>

      <!-- Health badge — only for non-default states; "healthy" is already
           conveyed by the green status dot, so showing a redundant pill clutters
           the tree (see Screenshot 2026-05-17 203807.png feedback). -->
      <span
        v-if="node.kind === 'container' && (node.health === 'unhealthy' || node.health === 'starting')"
        :class="['tree-node__health', `tree-node__health--${node.health}`]"
        >{{ node.health }}</span
      >
    </div>

    <!-- Children -->
    <ul v-if="hasChildren && isExpanded" role="group" class="tree-node__children">
      <DockerTreeNode
        v-for="child in node.children"
        :key="child.id"
        :node="child"
        :depth="depth + 1"
        :selected-id="selectedId"
        @select="emit('select', $event)"
        @toggle="emit('toggle', $event)"
        @context-menu="emit('context-menu', $event)"
      />
    </ul>
  </li>
</template>

<script setup lang="ts">
import { computed } from "vue";
import type { TreeNode } from "../../../stores/docker-tree.js";
import { useDockerTree } from "../../../stores/docker-tree.js";

const props = defineProps<{
  node: TreeNode;
  depth: number;
  selectedId: string | null;
}>();

const emit = defineEmits<{
  select: [node: TreeNode];
  toggle: [nodeId: string];
  "context-menu": [node: TreeNode];
}>();

const treeStore = useDockerTree();
const hasChildren = computed(() => (props.node.children?.length ?? 0) > 0);
const isExpanded = computed(() => treeStore.isExpandedWithFilter(props.node.id, hasChildren.value));

// Container rows match by ID. Group rows (Images/Volumes/Networks) also
// highlight when their corresponding list tab is active — the parent passes
// the list-tab's matching node id as `selectedId`.
const selected = computed(() => {
  if (props.selectedId == null) return false;
  if (props.node.kind === "container") return props.selectedId === props.node.id;
  if (
    props.node.kind === "images-group" ||
    props.node.kind === "volumes-group" ||
    props.node.kind === "networks-group"
  ) {
    return props.selectedId === props.node.id;
  }
  return false;
});

const statusIconClass = computed(() => {
  if (props.node.status === "unavailable") return "tree-node__icon--unavailable";
  if (props.node.status === "pending") return "tree-node__icon--pending";
  if (props.node.kind === "project" || props.node.kind === "orphans") return "tree-node__icon--project";
  if (props.node.kind === "context" || props.node.kind === "backend") return "tree-node__icon--backend";
  if (props.node.kind === "images-group" || props.node.kind === "image") return "tree-node__icon--image";
  if (props.node.kind === "volumes-group" || props.node.kind === "volume") return "tree-node__icon--volume";
  if (props.node.kind === "networks-group" || props.node.kind === "network") return "tree-node__icon--network";
  // container
  if (props.node.status === "running") {
    if (props.node.health === "unhealthy" || props.node.health === "starting") return "tree-node__icon--warn";
    return "tree-node__icon--running";
  }
  return "tree-node__icon--stopped";
});

const statusLabel = computed(() => {
  if (props.node.error) return props.node.error;
  if (props.node.health && props.node.health !== "none") return props.node.health;
  return props.node.status;
});

function onRowClick(): void {
  // Group nodes (Images / Volumes / Networks) open their table view on click,
  // not just expand — the table is the primary way to manage these resources.
  // The chevron still toggles expand for users who want to drill into the
  // tree's per-resource children.
  const isGroup =
    props.node.kind === "images-group" || props.node.kind === "volumes-group" || props.node.kind === "networks-group";
  if (isGroup) {
    emit("select", props.node);
    return;
  }
  if (hasChildren.value) {
    emit("toggle", props.node.id);
  }
  if (props.node.kind === "container" || props.node.kind === "project") {
    emit("select", props.node);
  }
}

function onKeyDown(e: KeyboardEvent): void {
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    onRowClick();
  } else if (e.key === "ArrowRight" && hasChildren.value && !isExpanded.value) {
    e.preventDefault();
    emit("toggle", props.node.id);
  } else if (e.key === "ArrowLeft" && isExpanded.value) {
    e.preventDefault();
    emit("toggle", props.node.id);
  }
}
</script>

<style scoped>
.tree-node {
  list-style: none;
  margin: 0;
  padding: 0;
}

.tree-node__row {
  display: flex;
  align-items: center;
  gap: 4px;
  min-height: 24px;
  cursor: pointer;
  border-radius: 4px;
  padding-right: 8px;
  outline: none;
  user-select: none;
}

/* Bigger touch targets on coarse pointers (phones / tablets). */
@media (pointer: coarse) {
  .tree-node__row {
    min-height: 38px;
  }
  .tree-node__toggle {
    width: 22px;
    font-size: 11px;
  }
  .tree-node__label {
    font-size: 14px;
  }
}

.tree-node__row:hover {
  background: var(--bg-hover, rgba(255, 255, 255, 0.06));
}

.tree-node--selected > .tree-node__row {
  background: var(--accent-subtle, rgba(99, 179, 237, 0.15));
}

.tree-node__row:focus-visible {
  outline: 1px solid var(--accent, #63b3ed);
}

.tree-node__toggle {
  width: 14px;
  font-size: 8px;
  color: var(--text-dim, #888);
  flex-shrink: 0;
  text-align: center;
  line-height: 1;
}
.tree-node__toggle--leaf {
  pointer-events: none;
}

.tree-node__icon {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  flex-shrink: 0;
}

.tree-node__icon--running {
  background: var(--color-success, #48bb78);
}
.tree-node__icon--warn {
  background: var(--color-warn, #f6ad55);
}
.tree-node__icon--stopped {
  background: transparent;
  border: 1.5px solid var(--text-dim, #888);
}
.tree-node__icon--unavailable {
  background: transparent;
  border: 1.5px solid var(--color-error, #fc8181);
}
.tree-node__icon--pending {
  background: var(--text-dim, #888);
  opacity: 0.5;
}
.tree-node__icon--project {
  background: transparent;
  border: 2px solid var(--text-muted, #aaa);
  border-radius: 2px;
}
.tree-node__icon--backend {
  background: var(--text-dim, #888);
  border-radius: 2px;
  width: 10px;
  height: 10px;
}
.tree-node__icon--image {
  background: transparent;
  border: 1.5px dashed var(--text-dim, #aaa);
  border-radius: 2px;
}
.tree-node__icon--volume {
  background: transparent;
  border: 1.5px solid var(--accent, #63b3ed);
  border-radius: 50% 50% 50% 50% / 25% 25% 25% 25%;
}
.tree-node__icon--network {
  background: transparent;
  border: 1.5px solid #d2a8ff;
  /* Six-sided-ish hex hint via clip; cheaper than SVG */
  border-radius: 2px;
  transform: rotate(45deg);
  width: 8px;
  height: 8px;
  margin: 0 1px;
}

.tree-node__meta {
  font-size: 10px;
  color: var(--text-dim, #888);
  flex-shrink: 0;
  font-family: "JetBrainsMono NFM", "CaskaydiaCove NFM", "Fira Code", "Consolas", monospace;
}

.tree-node__label {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
}

.tree-node--context > .tree-node__row .tree-node__label,
.tree-node--backend > .tree-node__row .tree-node__label {
  font-weight: 500;
}

.tree-node--unavailable > .tree-node__row {
  opacity: 0.5;
  cursor: not-allowed;
}

.tree-node__health {
  font-size: 9px;
  letter-spacing: 0.3px;
  text-transform: uppercase;
  padding: 0 5px;
  line-height: 14px;
  border-radius: 7px;
  flex-shrink: 0;
  font-weight: 600;
}
.tree-node__health--unhealthy {
  background: rgba(252, 129, 129, 0.18);
  color: var(--color-error, #fc8181);
  border: 1px solid rgba(252, 129, 129, 0.45);
}
.tree-node__health--starting {
  background: rgba(246, 173, 85, 0.18);
  color: var(--color-warn, #f6ad55);
  border: 1px solid rgba(246, 173, 85, 0.45);
}

.tree-node__children {
  margin: 0;
  padding: 0;
}
</style>
