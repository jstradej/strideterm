<template>
  <div class="gct" :class="{ 'gct--grouped': grouped }">
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
        :context-menu-enabled="contextMenuEnabled"
        :selected-set="selectedSet"
        :grouped="grouped"
        :scope-filter="scopeFilter"
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

interface ScopeEntry {
  scope: string;
  code: string;
  statusTitle: string;
  status: string;
}

interface TreeFile {
  kind: "file";
  name: string;
  path: string;
  status: string;
  scope: string;
  scopes: ScopeEntry[];
  previousPath?: string;
  stagedStatus?: string;
  unstagedStatus?: string;
  code: string;
  statusTitle: string;
  codeColor?: string;
  namePrefix?: string;
}

interface TreeDirectory {
  kind: "dir";
  name: string;
  path: string;
  children: TreeNode[];
  childMap: Map<string, TreeDirectory>;
  fileCount?: number;
}

type TreeNode = TreeFile | TreeDirectory;

function isDirectory(node: TreeNode): node is TreeDirectory {
  return node.kind === "dir";
}

const props = withDefaults(
  defineProps<{
    // [{ path, status, scope, code }]
    files?: Array<Record<string, unknown>>;
    selectedPath?: string;
    selectedScope?: string;
    selectable?: boolean;
    contextMenuEnabled?: boolean;
    grouped?: boolean;
    scopeFilter?: string;
    expandedSet?: Set<string>;
    selectedSet?: Set<string>;
  }>(),
  {
    files: () => [],
    selectedPath: "",
    selectedScope: "",
    selectable: false,
    contextMenuEnabled: true,
    grouped: false,
    scopeFilter: "all",
    selectedSet: () => new Set<string>(),
  },
);

const emit = defineEmits<{
  (e: "update:expandedSet", paths: Set<string>): void;
  (e: "select", path: string, scope: string): void;
  (e: "toggle-select", path: string): void;
  (e: "context-menu", payload: { path: string; name: string; kind: "file" | "dir"; x: number; y: number }): void;
}>();

const localExpandedSet = ref(new Set<string>());
const expandedSet = computed(() => props.expandedSet || localExpandedSet.value);
const knownDirectories = new Set<string>();

const totalCount = computed(() => tree.value.children.length);

const tree = computed(() => buildTree(props.files));

watch(
  tree,
  (next) => {
    const set = new Set<string>(expandedSet.value);
    walkDirs(next, (node) => {
      const path = node.path;
      if (!knownDirectories.has(path)) set.add(path);
      knownDirectories.add(path);
    });
    localExpandedSet.value = set;
    emit("update:expandedSet", set);
  },
  { immediate: true },
);

function toggle(path: string) {
  const set = new Set<string>(expandedSet.value);
  if (set.has(path)) set.delete(path);
  else set.add(path);
  localExpandedSet.value = set;
  emit("update:expandedSet", set);
}

function buildTree(files: Array<Record<string, unknown>>): TreeDirectory {
  const root: TreeDirectory = { kind: "dir", name: "", path: "", children: [], childMap: new Map() };
  for (const file of files || []) {
    if (props.grouped && props.scopeFilter !== "all" && file.scope !== props.scopeFilter) continue;
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
    const filePath = String(file.path || "");
    const existing = props.grouped
      ? cursor.children.find((child): child is TreeFile => child.kind === "file" && child.path === filePath)
      : null;
    const statusValue = String(file.status || "");
    const code = String(file.code || "");
    const stagedStatus = String(file.stagedStatus || "");
    const unstagedStatus = String(file.unstagedStatus || "");
    const scope = String(file.scope || "");
    const path = String(file.path || "");
    const previousPath = typeof file.previousPath === "string" ? file.previousPath : "";
    const status = statusValue || normaliseCode(code || stagedStatus || unstagedStatus);
    const scopeEntry = {
      scope,
      code: scope === "staged" ? stagedStatus || code : unstagedStatus || code,
      statusTitle: String(file.statusTitle || ""),
      status,
    };
    if (existing) {
      if (!existing.scopes.some((entry) => entry.scope === scope)) existing.scopes.push(scopeEntry);
      if (previousPath) existing.previousPath = previousPath;
      if (stagedStatus) existing.stagedStatus = stagedStatus;
      if (unstagedStatus) existing.unstagedStatus = unstagedStatus;
      continue;
    }
    cursor.children.push({
      kind: "file",
      name: segments[segments.length - 1],
      path,
      status,
      scope,
      scopes: [scopeEntry],
      previousPath,
      stagedStatus,
      unstagedStatus,
      code: scopeEntry.code,
      statusTitle: String(file.statusTitle || ""),
      codeColor: typeof file.codeColor === "string" ? file.codeColor : "",
    });
  }
  collapseSingleChildDirs(root);
  if (props.grouped) {
    compactSingleFileDirs(root);
    compactRootBranch(root, "src");
    compactRootBranch(root, "source");
    updateDirectoryCounts(root);
  }
  sortTree(root);
  return root;
}

function compactSingleFileDirs(node: TreeDirectory) {
  for (let i = 0; i < node.children.length; i++) {
    const child = node.children[i];
    if (isDirectory(child)) compactSingleFileDirs(child);
    if (isDirectory(child) && child.children.length === 1 && child.children[0].kind === "file") {
      const file = child.children[0] as TreeFile;
      file.namePrefix = `${child.name}/${file.namePrefix || ""}`;
      node.children[i] = file;
    }
  }
}

function compactRootBranch(root: TreeDirectory, branchName: string) {
  const branch = root.children.find((child): child is TreeDirectory => isDirectory(child) && child.name === branchName);
  if (!branch) return;
  for (const child of branch.children) {
    if (child.kind === "file") child.namePrefix = `${branchName}/${child.namePrefix || ""}`;
    else child.name = `${branchName}/${child.name}`;
  }
  root.children.splice(root.children.indexOf(branch), 1, ...branch.children);
}

function updateDirectoryCounts(node: TreeNode): number {
  if (!isDirectory(node)) return 1;
  node.fileCount = node.children.reduce((count, child) => count + updateDirectoryCounts(child), 0);
  return node.fileCount;
}

// IntelliJ-style: a directory with exactly one child directory and no file
// children is merged with that child ("src" + "components" => "src/components").
function collapseSingleChildDirs(node: TreeDirectory) {
  for (const child of node.children) if (isDirectory(child)) collapseSingleChildDirs(child);
  for (let i = 0; i < node.children.length; i++) {
    let child = node.children[i];
    while (isDirectory(child) && child.children.length === 1 && isDirectory(child.children[0])) {
      const grand = child.children[0];
      const merged: TreeDirectory = {
        kind: "dir",
        name: `${child.name}/${grand.name}`,
        path: grand.path,
        children: grand.children,
        childMap: grand.childMap,
      };
      node.children[i] = merged;
      child = merged;
    }
  }
}

function sortTree(node: TreeDirectory) {
  node.children.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  });
  for (const child of node.children) if (isDirectory(child)) sortTree(child);
}

function walkDirs(node: TreeDirectory, fn: (node: TreeDirectory) => void) {
  if (isDirectory(node)) {
    fn(node);
    for (const child of node.children) if (isDirectory(child)) walkDirs(child, fn);
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
