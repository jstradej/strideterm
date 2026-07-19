<!--
  Recursive changed-files tree, shared by the Files and Conflicts tabs in
  AzureReviewPane.vue. Replaces two hand-unrolled copies of this markup that
  were each hardcoded to exactly 3 levels deep (dir -> dir -> file), which
  silently truncated any path nested deeper than that. This version
  self-references for nested directories, so it renders correctly at any
  depth.

  The top-level caller passes `files` (the flat changed-files list); the
  tree is built from it once. Recursive calls to render a subtree instead
  pass `nodes` (an already-built subtree) and omit `files`.
-->
<template>
  <template v-for="node in displayNodes" :key="node.key">
    <details v-if="node.children" class="review-tree-dir" open>
      <summary class="review-tree-dir__label" :style="indentStyle(depth)">
        <span class="review-tree-dir__icon"></span><span>{{ node.name }}</span>
      </summary>
      <ReviewFileTree
        :nodes="node.children"
        :selected-file="selectedFile"
        :depth="depth + 1"
        @select-file="$emit('select-file', $event)"
      />
    </details>
    <button
      v-else
      type="button"
      :class="['review-tree-file', selectedFile === node.path && 'review-tree-file--active']"
      :style="indentStyle(depth)"
      :title="node.path"
      @click="$emit('select-file', node.path)"
    >
      <span :class="changeTypeClass(node.changeType)">{{ changeTypeLabel(node.changeType) }}</span>
      <span class="review-tree-file__name">{{ node.name }}</span>
    </button>
  </template>
</template>

<script setup lang="ts">
import { computed } from "vue";
// Self-import for recursion — see https://vuejs.org/guide/components/registration.html#self-registering-components
import ReviewFileTree from "./ReviewFileTree.vue";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type TreeNode = any;

const props = withDefaults(
  defineProps<{
    // Raw changed files — only passed by the top-level caller. Mutually
    // exclusive with `nodes`, which internal recursive calls pass instead.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    files?: Array<Record<string, any>>;
    nodes?: TreeNode[];
    selectedFile?: string;
    depth?: number;
  }>(),
  { files: undefined, nodes: undefined, selectedFile: "", depth: 0 },
);

defineEmits<{ (e: "select-file", path: string): void }>();

// Builds a nested directory tree from a flat list of changed files, e.g.
// [{path: "src/a/b.ts"}, {path: "src/a/c.ts"}] -> a "src/a" dir node with
// two file children. Moved verbatim from AzureReviewPane.vue's old
// `fileTree` computed.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function buildFileTree(files: Array<Record<string, any>>): TreeNode[] {
  if (!files.length) return [];

  // Find common prefix to strip
  const paths = files.map((f) =>
    String(f.path || "")
      .replace(/^\//, "")
      .split("/"),
  );
  let prefix = 0;
  if (paths.length > 1) {
    outer: for (let i = 0; i < (paths[0]?.length || 0) - 1; i++) {
      const seg = paths[0][i];
      for (let j = 1; j < paths.length; j++) {
        if (paths[j][i] !== seg) break outer;
      }
      prefix = i + 1;
    }
  }

  // Build nested map
  const root = new Map();
  for (const file of files) {
    const segs = String(file.path || "")
      .replace(/^\//, "")
      .split("/")
      .slice(prefix);
    let node = root;
    for (let i = 0; i < segs.length - 1; i++) {
      if (!node.has(segs[i])) node.set(segs[i], new Map());
      node = node.get(segs[i]);
    }
    node.set(segs.at(-1), file);
  }

  // Convert to array, collapsing single-child dirs
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function toArray(map: Map<string, any>, pathPrefix = ""): TreeNode[] {
    const result: TreeNode[] = [];
    for (const [name, value] of map) {
      if (value instanceof Map) {
        const items = toArray(value, pathPrefix ? `${pathPrefix}/${name}` : name);
        // Collapse dir with single child dir
        if (items.length === 1 && items[0].children) {
          result.push({ ...items[0], name: `${name}/${items[0].name}`, key: `${pathPrefix}/${name}` });
        } else {
          result.push({ name, key: `${pathPrefix}/${name}`, children: items });
        }
      } else {
        result.push({ name, key: value.path, path: value.path, changeType: value.changeType || "edit" });
      }
    }
    return result;
  }

  return toArray(root);
}

const displayNodes = computed<TreeNode[]>(() => props.nodes ?? buildFileTree(props.files ?? []));

// The original hand-unrolled markup indented depth-1/2 rows with literal
// `padding-left: 14px` / `padding-left: 28px` inline styles on top of the
// 6px base padding already on `.review-tree-dir__label` / `.review-tree-file`.
// This generalizes that to arbitrary depth: each level adds 14px.
function indentStyle(depth: number): Record<string, string> | undefined {
  return depth > 0 ? { paddingLeft: `${depth * 14 + 6}px` } : undefined;
}

function changeTypeClass(t: unknown) {
  return t === "add" ? "diff-add" : t === "delete" ? "diff-del" : "diff-meta";
}
function changeTypeLabel(t: unknown) {
  return t === "add" ? "A" : t === "delete" ? "D" : "M";
}
</script>
