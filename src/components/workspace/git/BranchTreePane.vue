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
        :expanded="effectiveExpanded"
        :compact="compact"
        :can-create-pr="canCreatePr"
        :multi-selected-refs="multiSelectedRefs"
        @select="(ref) => emit('select', ref)"
        @toggle="onToggle"
        @multi-toggle="(ref) => emit('multi-toggle', ref)"
        @range-select="(ref) => emit('range-select', ref)"
        @checkout="(ref) => emit('checkout', ref)"
        @checkout-remote="(ref) => emit('checkout-remote', ref)"
        @new-from="(ref) => emit('new-from', ref)"
        @rename="(ref) => emit('rename', ref)"
        @delete="(ref) => emit('delete', ref)"
        @delete-remote="(ref) => emit('delete-remote', ref)"
        @merge="(ref) => emit('merge', ref)"
        @rebase="(ref) => emit('rebase', ref)"
        @create-pr="(ref) => emit('create-pr', ref)"
      />
    </ul>
  </div>
</template>

<script setup lang="ts">
import { computed, reactive, watch } from "vue";
import BranchTreeNode from "./BranchTreeNode.vue";
import type { BranchTreeNode as BranchTreeNodeData } from "./branch-tree-types";

// Re-export the named types so existing imports
// (`import BranchTreePane, { type BranchTreeNode } from "./BranchTreePane.vue"`)
// keep working through vue-tsc. Plain `tsc` (used by tsconfig.tests.json)
// can't resolve named exports from `.vue` files, so tests import from
// `./branch-tree-types` directly.
export type { BranchTreeNode, BranchTreeNodeKind, BranchTreeNodeMeta } from "./branch-tree-types";

const props = withDefaults(
  defineProps<{
    tree: BranchTreeNodeData[];
    stateKey?: string;
    searching?: boolean;
    loading?: boolean;
    selectedRef?: string;
    head?: string;
    busy?: boolean;
    isDirty?: boolean;
    compact?: boolean;
    canCreatePr?: boolean;
    multiSelectedRefs?: Set<string>;
  }>(),
  {
    stateKey: "",
    searching: false,
    loading: false,
    selectedRef: "",
    head: "",
    busy: false,
    isDirty: false,
    compact: false,
    canCreatePr: false,
  },
);

const emit = defineEmits<{
  (e: "select", ref: string): void;
  (e: "multi-toggle", ref: string): void;
  (e: "range-select", ref: string): void;
  (e: "checkout", ref: string): void;
  (e: "checkout-remote", ref: string): void;
  (e: "new-from", ref: string): void;
  (e: "rename", ref: string): void;
  (e: "delete", ref: string): void;
  (e: "delete-remote", ref: string): void;
  (e: "merge", ref: string): void;
  (e: "rebase", ref: string): void;
  (e: "create-pr", ref: string): void;
}>();

const expanded = reactive<Record<string, boolean>>(loadExpansion(props.stateKey));
const searchExpansion = reactive<Record<string, boolean>>({});

function loadExpansion(key: string): Record<string, boolean> {
  if (!key) return {};
  try {
    const parsed = JSON.parse(globalThis.localStorage?.getItem(key) || "null");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed).filter((entry): entry is [string, boolean] => typeof entry[1] === "boolean"),
    );
  } catch {
    return {};
  }
}

function persistExpansion() {
  if (!props.stateKey) return;
  try {
    globalThis.localStorage?.setItem(props.stateKey, JSON.stringify(expanded));
  } catch {
    // Expansion remains usable in memory when storage is unavailable.
  }
}

function ensureDefault(nodes: BranchTreeNodeData[]) {
  for (const node of nodes) {
    if (!(node.key in expanded))
      expanded[node.key] = node.kind === "section" && (node.key === "head" || node.key === "important");
    if (node.children?.length) ensureDefault(node.children);
  }
}

const effectiveExpanded = computed(() => {
  if (!props.searching) return expanded;
  const result = { ...expanded };
  function expand(nodes: BranchTreeNodeData[]) {
    for (const node of nodes) {
      if (node.children?.length) {
        result[node.key] = searchExpansion[node.key] ?? true;
        expand(node.children);
      }
    }
  }
  expand(props.tree);
  return result;
});

watch(
  () => props.tree,
  (next) => ensureDefault(next || []),
  { immediate: true, deep: false },
);

watch(
  () => props.searching,
  (searching) => {
    if (searching) return;
    for (const key of Object.keys(searchExpansion)) delete searchExpansion[key];
  },
);

function onToggle(key: string) {
  if (props.searching) {
    searchExpansion[key] = !effectiveExpanded.value[key];
    return;
  }
  expanded[key] = !expanded[key];
  persistExpansion();
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
