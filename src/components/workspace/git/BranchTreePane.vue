<template>
  <div :class="['branch-tree', compact && 'branch-tree--compact', loading && 'branch-tree--loading']">
    <div v-if="loading && !tree.length" class="branch-tree__placeholder">Loading branches…</div>
    <div v-else-if="!tree.length" class="branch-tree__placeholder">No branches found.</div>
    <ul v-else class="branch-tree__root" role="tree" aria-label="Branches">
      <BranchTreeNode
        v-for="node in tree"
        :key="node.key"
        :node="node"
        :depth="0"
        :selected-ref="selectedRef"
        :head="head"
        :busy="busy"
        :is-dirty="isDirty"
        :expanded="expanded"
        :compact="compact"
        @select="(ref) => emit('select', ref)"
        @toggle="onToggle"
        @checkout="(ref) => emit('checkout', ref)"
        @checkout-remote="(ref) => emit('checkout-remote', ref)"
        @new-from="(ref) => emit('new-from', ref)"
        @rename="(ref) => emit('rename', ref)"
        @delete="(ref) => emit('delete', ref)"
        @delete-remote="(ref) => emit('delete-remote', ref)"
        @merge="(ref) => emit('merge', ref)"
        @rebase="(ref) => emit('rebase', ref)"
      />
    </ul>
  </div>
</template>

<script setup lang="ts">
import { reactive, watch } from "vue";
import BranchTreeNode from "./BranchTreeNode.vue";

export interface BranchTreeNodeMeta {
  ahead?: number;
  behind?: number;
  upstream?: string;
  merged?: boolean;
  remote?: string;
  lastCommit?: string;
  lastSubject?: string;
  lastAuthor?: string;
  lastRelativeDate?: string;
  isCurrent?: boolean;
  hasLocal?: boolean;
  count?: number;
  tag?: boolean;
}

export type BranchTreeNodeKind = "section" | "folder" | "branch-local" | "branch-remote" | "tag";

export interface BranchTreeNode {
  key: string;
  kind: BranchTreeNodeKind;
  label: string;
  ref?: string;
  icon?: string;
  isCurrent?: boolean;
  upstream?: string;
  meta?: BranchTreeNodeMeta;
  children?: BranchTreeNode[];
}

const props = withDefaults(
  defineProps<{
    tree: BranchTreeNode[];
    loading?: boolean;
    selectedRef?: string;
    head?: string;
    busy?: boolean;
    isDirty?: boolean;
    compact?: boolean;
  }>(),
  { loading: false, selectedRef: "", head: "", busy: false, isDirty: false, compact: false },
);

const emit = defineEmits<{
  (e: "select", ref: string): void;
  (e: "checkout", ref: string): void;
  (e: "checkout-remote", ref: string): void;
  (e: "new-from", ref: string): void;
  (e: "rename", ref: string): void;
  (e: "delete", ref: string): void;
  (e: "delete-remote", ref: string): void;
  (e: "merge", ref: string): void;
  (e: "rebase", ref: string): void;
}>();

// Persistent collapse state, keyed by node.key. Sections and the first
// folder level start expanded so users see their branches immediately —
// the JetBrains tree does the same. Subsequent folders default to expanded
// as well, but the user can collapse them and the choice sticks.
const expanded = reactive<Record<string, boolean>>({});

function ensureDefault(nodes: BranchTreeNode[]) {
  for (const node of nodes) {
    if (!(node.key in expanded)) expanded[node.key] = true;
    if (node.children?.length) ensureDefault(node.children);
  }
}

watch(
  () => props.tree,
  (next) => ensureDefault(next || []),
  { immediate: true, deep: false },
);

function onToggle(key: string) {
  expanded[key] = !expanded[key];
}
</script>

<style scoped>
.branch-tree {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  overflow: auto;
  background: var(--surface, rgba(0, 0, 0, 0.15));
  border: 1px solid var(--border);
  border-radius: 4px;
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}

.branch-tree--compact {
  font-size: 13px;
}

.branch-tree__root {
  list-style: none;
  margin: 0;
  padding: 4px 0 8px;
  flex: 1;
  min-height: 0;
}

.branch-tree__placeholder {
  display: flex;
  align-items: center;
  justify-content: center;
  flex: 1;
  color: var(--muted);
  font-style: italic;
  padding: 12px;
}
</style>
