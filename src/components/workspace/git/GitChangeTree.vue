<template>
  <div class="gct">
    <div v-if="!totalCount" class="gct__empty">No local changes.</div>
    <ul v-else class="gct__list" role="tree">
      <GitChangeTreeNode
        v-for="(child, idx) in tree.children"
        :key="child.path + ':' + idx"
        :node="child"
        :depth="0"
        :selected-path="selectedPath"
        :selected-scope="selectedScope"
        :expanded-set="expandedSet"
        :selectable="selectable"
        :selected-set="selectedSet"
        @toggle="toggle"
        @select="(file) => $emit('select', file.path, file.scope)"
        @toggle-select="(p) => $emit('toggle-select', p)"
        @context-menu="(p) => $emit('context-menu', p)"
      />
    </ul>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import GitChangeTreeNode from "./GitChangeTreeNode.vue";

const props = withDefaults(
  defineProps<{
    // [{ path, status, scope, code }]
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    files?: any[];
    selectedPath?: string;
    selectedScope?: string;
    selectable?: boolean;
    selectedSet?: Set<string>;
  }>(),
  { files: () => [], selectedPath: "", selectedScope: "", selectable: false, selectedSet: () => new Set<string>() },
);

defineEmits<{
  (e: "select", path: string, scope: string): void;
  (e: "toggle-select", path: string): void;
  (e: "context-menu", payload: { path: string; name: string; x: number; y: number }): void;
}>();

const expandedSet = ref(new Set<string>());

const totalCount = computed(() => props.files.length);

const tree = computed(() => buildTree(props.files));

// Whenever the file list changes shape, ensure all directory nodes are expanded
// by default (IntelliJ behaviour — no manual expansion needed for short trees).
watch(
  tree,
  (next) => {
    const set = new Set<string>();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    walkDirs(next, (node: any) => set.add(node.path as string));
    expandedSet.value = set;
  },
  { immediate: true },
);

function toggle(path: string) {
  const set = new Set<string>(expandedSet.value);
  if (set.has(path)) set.delete(path);
  else set.add(path);
  expandedSet.value = set;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function buildTree(files: any[]) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const root: any = { kind: "dir", name: "", path: "", children: [], childMap: new Map() };
  for (const file of files || []) {
    const segments = String(file.path || "")
      .split("/")
      .filter(Boolean);
    if (!segments.length) continue;
    let cursor = root;
    for (let i = 0; i < segments.length - 1; i++) {
      const seg = segments[i];
      let next = cursor.childMap.get(seg);
      if (!next) {
        const dirPath = cursor.path ? `${cursor.path}/${seg}` : seg;
        next = { kind: "dir", name: seg, path: dirPath, children: [], childMap: new Map() };
        cursor.childMap.set(seg, next);
        cursor.children.push(next);
      }
      cursor = next;
    }
    cursor.children.push({
      kind: "file",
      name: segments[segments.length - 1],
      path: file.path,
      status: file.status || normaliseCode(file.code || file.stagedStatus || file.unstagedStatus),
      scope: file.scope,
      code: file.code || file.stagedStatus || file.unstagedStatus || "",
    });
  }
  collapseSingleChildDirs(root);
  sortTree(root);
  return root;
}

// IntelliJ-style: a directory with exactly one child directory and no file
// children is merged with that child ("src" + "components" => "src/components").
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function collapseSingleChildDirs(node: any) {
  if (node.kind !== "dir") return;
  for (const child of node.children) collapseSingleChildDirs(child);
  // Don't collapse the synthetic root.
  if (node === undefined) return;
  for (let i = 0; i < node.children.length; i++) {
    let child = node.children[i];
    while (child.kind === "dir" && child.children.length === 1 && child.children[0].kind === "dir") {
      const grand = child.children[0];
      const merged = {
        kind: "dir",
        name: `${child.name}/${grand.name}`,
        path: grand.path,
        children: grand.children,
      };
      node.children[i] = merged;
      child = merged;
    }
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function sortTree(node: any) {
  if (node.kind !== "dir") return;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  node.children.sort((a: any, b: any) => {
    if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  });
  for (const child of node.children) sortTree(child);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function walkDirs(node: any, fn: (node: any) => void) {
  if (node.kind === "dir") {
    fn(node);
    for (const child of node.children) walkDirs(child, fn);
  }
}

function normaliseCode(code: string) {
  if (!code) return "modified";
  const c = String(code).trim().toUpperCase();
  if (c === "??" || c === "?") return "untracked";
  if (c.startsWith("U") || c === "AA" || c === "DD") return "conflict";
  if (c.startsWith("A")) return "staged";
  if (c.startsWith("D")) return "modified";
  if (c.startsWith("M")) return "modified";
  if (c.startsWith("R") || c.startsWith("C")) return "modified";
  if (c === "!") return "ignored";
  return "modified";
}
</script>

<style scoped>
.gct {
  font-size: 12px;
  user-select: none;
  overflow: auto;
  height: 100%;
  min-height: 0;
}

.gct__empty {
  padding: 12px;
  color: var(--muted);
  font-size: 11px;
  text-align: center;
}

.gct__list {
  list-style: none;
  padding: 4px 0;
  margin: 0;
}
</style>
