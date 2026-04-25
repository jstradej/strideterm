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
        @toggle="toggle"
        @select="(file) => $emit('select', file.path, file.scope)"
      />
    </ul>
  </div>
</template>

<script setup>
import { computed, ref, watch } from "vue";
import GitChangeTreeNode from "./GitChangeTreeNode.vue";

const props = defineProps({
  // [{ path, status, scope, code }]
  files: { type: Array, default: () => [] },
  selectedPath: { type: String, default: "" },
  selectedScope: { type: String, default: "" },
});

defineEmits(["select"]);

const expandedSet = ref(new Set());

const totalCount = computed(() => props.files.length);

const tree = computed(() => buildTree(props.files));

// Whenever the file list changes shape, ensure all directory nodes are expanded
// by default (IntelliJ behaviour — no manual expansion needed for short trees).
watch(
  tree,
  (next) => {
    const set = new Set();
    walkDirs(next, (node) => set.add(node.path));
    expandedSet.value = set;
  },
  { immediate: true },
);

function toggle(path) {
  const set = new Set(expandedSet.value);
  if (set.has(path)) set.delete(path);
  else set.add(path);
  expandedSet.value = set;
}

function buildTree(files) {
  const root = { kind: "dir", name: "", path: "", children: [], childMap: new Map() };
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
function collapseSingleChildDirs(node) {
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

function sortTree(node) {
  if (node.kind !== "dir") return;
  node.children.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  });
  for (const child of node.children) sortTree(child);
}

function walkDirs(node, fn) {
  if (node.kind === "dir") {
    fn(node);
    for (const child of node.children) walkDirs(child, fn);
  }
}

function normaliseCode(code) {
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
