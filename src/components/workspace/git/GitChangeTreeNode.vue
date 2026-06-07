<template>
  <li class="gct-node" role="treeitem" :aria-expanded="isDir ? (expanded ? 'true' : 'false') : undefined">
    <div
      :class="[
        'gct-node__row',
        node.kind === 'file' && isSelected && 'gct-node__row--selected',
        node.kind === 'file' && `gct-node__row--git-${node.status}`,
      ]"
      :style="{ paddingLeft: depth * 14 + 6 + 'px' }"
      :title="node.kind === 'file' ? `${statusTitle(node.status)}: ${node.path}` : node.path"
      @click="onClick"
      @contextmenu="onContextMenu"
    >
      <span v-if="isDir" class="gct-node__chevron">{{ expanded ? "▾" : "▸" }}</span>
      <span v-else class="gct-node__chevron gct-node__chevron--leaf"></span>
      <input
        v-if="selectable && node.kind === 'file'"
        type="checkbox"
        class="gct-node__check"
        :checked="isChecked"
        :aria-label="`Select ${node.path} for stashing`"
        @click.stop
        @change="$emit('toggle-select', node.path)"
      />
      <span class="gct-node__icon" aria-hidden="true">{{ isDir ? "📁" : "📄" }}</span>
      <span class="gct-node__name">{{ node.name }}</span>
      <span
        v-if="node.kind === 'file' && node.code"
        class="gct-node__code"
        :style="{ color: statusColor(node.status) }"
        :title="statusTitle(node.status)"
      >
        {{ node.code }}
      </span>
    </div>
    <ul v-if="isDir && expanded && node.children.length" class="gct-node__children">
      <GitChangeTreeNode
        v-for="(child, idx) in node.children"
        :key="child.path + ':' + idx"
        :node="child"
        :depth="depth + 1"
        :selected-path="selectedPath"
        :selected-scope="selectedScope"
        :expanded-set="expandedSet"
        :selectable="selectable"
        :selected-set="selectedSet"
        @toggle="(p) => $emit('toggle', p)"
        @select="(file) => $emit('select', file)"
        @toggle-select="(p) => $emit('toggle-select', p)"
        @context-menu="(p) => $emit('context-menu', p)"
      />
    </ul>
  </li>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { statusColor, statusTitle } from "../file-manager/git-status-helpers.js";

const props = withDefaults(
  defineProps<{
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    node: Record<string, any>;
    depth?: number;
    selectedPath?: string;
    selectedScope?: string;
    expandedSet: Set<string>;
    selectable?: boolean;
    selectedSet?: Set<string>;
  }>(),
  { depth: 0, selectedPath: "", selectedScope: "", selectable: false, selectedSet: () => new Set<string>() },
);

const emit = defineEmits<{
  (e: "toggle", path: string): void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (e: "select", node: Record<string, any>): void;
  (e: "toggle-select", path: string): void;
  (e: "context-menu", payload: { path: string; name: string; kind: "file" | "dir"; x: number; y: number }): void;
}>();

const isDir = computed(() => props.node.kind === "dir");
const expanded = computed(() => props.expandedSet.has(props.node.path as string));
const isSelected = computed(
  () =>
    props.node.kind === "file" && props.selectedPath === props.node.path && props.selectedScope === props.node.scope,
);
const isChecked = computed(() => props.node.kind === "file" && !!props.selectedSet?.has(props.node.path as string));

function onClick() {
  if (isDir.value) emit("toggle", props.node.path as string);
  else emit("select", props.node);
}

function onContextMenu(e: MouseEvent) {
  // Directories in this tree are synthetic groupings, but their path maps to
  // a real directory on disk, so delete / add-to-.gitignore work on them too.
  e.preventDefault();
  emit("context-menu", {
    path: props.node.path as string,
    name: props.node.name as string,
    kind: props.node.kind === "dir" ? "dir" : "file",
    x: e.clientX,
    y: e.clientY,
  });
}
</script>

<style scoped>
.gct-node {
  list-style: none;
}

.gct-node__row {
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

.gct-node__row:hover {
  background: var(--border);
}

.gct-node__row--selected {
  background: rgba(255, 164, 36, 0.16);
  color: var(--accent);
}

.gct-node__row--git-modified {
  border-left: 3px solid var(--fm-status-modified, #d8a14b);
  padding-left: 3px;
}
.gct-node__row--git-staged {
  border-left: 3px solid var(--fm-status-staged, #6cb478);
  padding-left: 3px;
}
.gct-node__row--git-untracked {
  border-left: 3px solid var(--fm-status-untracked, #5e9bd6);
  padding-left: 3px;
}
.gct-node__row--git-conflict {
  border-left: 3px solid var(--fm-status-conflict, #e26b6b);
  padding-left: 3px;
}
.gct-node__row--git-ignored {
  opacity: 0.55;
}

.gct-node__chevron {
  flex-shrink: 0;
  width: 10px;
  font-size: 10px;
  color: var(--muted);
  text-align: center;
}

.gct-node__chevron--leaf {
  visibility: hidden;
}

.gct-node__check {
  flex-shrink: 0;
  width: auto;
  margin: 0 2px 0 0;
  cursor: pointer;
}

.gct-node__icon {
  flex-shrink: 0;
  font-size: 11px;
  opacity: 0.85;
}

.gct-node__name {
  overflow: hidden;
  text-overflow: ellipsis;
}

.gct-node__code {
  margin-left: auto;
  flex-shrink: 0;
  font-size: 10px;
  font-weight: 700;
  padding: 0 4px;
  border-radius: 3px;
  background: rgba(255, 255, 255, 0.06);
  font-variant-numeric: tabular-nums;
}

.gct-node__children {
  list-style: none;
  padding: 0;
  margin: 0;
}
</style>
