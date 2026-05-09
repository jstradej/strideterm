<template>
  <div class="ws-picker" @click.stop @keydown.esc.stop="$emit('close')">
    <input
      ref="searchRef"
      v-model="query"
      type="text"
      class="ws-picker__search"
      placeholder="Search workspaces…"
      @keydown.esc.stop="$emit('close')"
    />
    <div class="ws-picker__list">
      <template v-for="node in tree" :key="node.id">
        <button
          type="button"
          class="ws-picker__item"
          :class="{ 'ws-picker__item--occupied': occupiedIds.has(node.id) }"
          :style="`--accent:${node.color}`"
          :title="node.name"
          @click="pick(node.id)"
        >
          <span class="ws-picker__indent" :style="`width:${node.depth * 12}px`"></span>
          <span v-if="node.starred" class="ws-picker__star">★</span>
          <span class="ws-picker__icon">{{ node.icon }}</span>
          <span class="ws-picker__name">{{ node.name }}</span>
          <span v-if="node.kindCounts" class="ws-picker__kind-counts">{{ node.kindCounts }}</span>
          <span v-if="node.breadcrumb && query" class="ws-picker__breadcrumb">(under {{ node.breadcrumb }})</span>
          <span v-if="occupiedIds.has(node.id)" class="ws-picker__badge">in grid</span>
        </button>
        <button
          v-if="node.childCount > 0 && query === ''"
          type="button"
          class="ws-picker__toggle"
          :title="collapsed.has(node.id) ? 'Expand' : 'Collapse'"
          @click.stop="toggleCollapse(node.id)"
        >
          {{ collapsed.has(node.id) ? "▶" : "▼" }}
        </button>
      </template>
      <p v-if="tree.length === 0" class="ws-picker__empty">No workspaces found</p>
    </div>
    <div class="ws-picker__footer">
      <button type="button" class="ws-picker__cancel" @click="$emit('close')">Cancel</button>
    </div>
  </div>
  <div class="ws-picker__backdrop" @click="$emit('close')"></div>
</template>

<script setup lang="ts">
import { computed, ref, onMounted } from "vue";
import { useAppStore } from "../../stores/app.js";

const props = defineProps<{
  cellIndex: number;
}>();

const emit = defineEmits<{
  (e: "close"): void;
}>();

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyApi = any;

const store = useAppStore();
const query = ref("");
const collapsed = ref(new Set<string>());
const searchRef = ref<HTMLInputElement | null>(null);

onMounted(() => {
  searchRef.value?.focus();
  // Default: collapse all parents so only root-level entries are visible on open.
  const ws: AnyApi[] = (store.payload as AnyApi)?.appState?.workspaces || [];
  const parentIds = new Set<string>();
  for (const w of ws) {
    const pid = resolveParentId(w, ws);
    if (pid) parentIds.add(pid);
  }
  collapsed.value = parentIds;
});

const allWorkspaces = computed<AnyApi[]>(() => {
  return (store.payload as AnyApi)?.appState?.workspaces || [];
});

const occupiedIds = computed<Set<string>>(() => {
  const grid = store.workspaceGrid;
  if (!grid) return new Set();
  return new Set((grid.cellWorkspaceIds as (string | null)[]).filter(Boolean) as string[]);
});

interface TreeNode {
  id: string;
  name: string;
  icon: string;
  color: string;
  depth: number;
  childCount: number;
  kindCounts: string;
  breadcrumb: string;
  starred: boolean;
}

function getLastActivity(wsId: string, panels: AnyApi[]): number {
  const sessions = (store.payload as AnyApi)?.attention?.sessions || {};
  let latest = 0;
  for (const panel of panels) {
    for (const key of [`${wsId}:${panel.id}`, panel.id]) {
      const s = sessions[key];
      if (s?.lastActivity) {
        const t = new Date(s.lastActivity).getTime();
        if (t > latest) latest = t;
      }
    }
  }
  return latest;
}

function isRunningTask(wsId: string): boolean {
  const tr = (store.payload as AnyApi)?.taskRunner?.[wsId];
  return tr?.state === "running" || tr?.state === "evaluating" || tr?.state === "judge-evaluating";
}

function activityScore(ws: AnyApi): number {
  if (isRunningTask(ws.id)) return Infinity;
  return getLastActivity(ws.id, ws.panels || []);
}

function buildKindCounts(childIds: string[], allWs: AnyApi[]): string {
  const counts: Record<string, number> = {};
  for (const id of childIds) {
    const w = allWs.find((x: AnyApi) => x.id === id);
    if (!w) continue;
    const kind = w.kind || "terminal";
    counts[kind] = (counts[kind] || 0) + 1;
  }
  const parts = Object.entries(counts)
    .filter(([k]) => k !== "terminal" && k !== "manual")
    .map(([k, n]) => `${n} ${k}`);
  return parts.length ? `(${parts.join(", ")})` : "";
}

const tree = computed<TreeNode[]>(() => {
  const ws = allWorkspaces.value;
  const q = query.value.toLowerCase();

  const childrenOf = new Map<string, string[]>();
  const parentOf = new Map<string, string>();

  for (const w of ws) {
    const pid = resolveParentId(w, ws);
    if (pid) {
      parentOf.set(w.id, pid);
      if (!childrenOf.has(pid)) childrenOf.set(pid, []);
      childrenOf.get(pid)!.push(w.id);
    }
  }

  // Sort children of each parent: starred first, then by descending activity
  for (const [pid, kids] of childrenOf.entries()) {
    const sorted = [...kids].sort((a, b) => {
      const wa = ws.find((x: AnyApi) => x.id === a);
      const wb = ws.find((x: AnyApi) => x.id === b);
      const starA = wa?.starred ? 1 : 0;
      const starB = wb?.starred ? 1 : 0;
      if (starB !== starA) return starB - starA;
      return activityScore(wb) - activityScore(wa);
    });
    childrenOf.set(pid, sorted);
  }

  // Filter by query
  let filtered = ws;
  if (q) {
    filtered = ws.filter((w: AnyApi) => w.name?.toLowerCase().includes(q));
  }

  // Build ordered list with depth
  const visited = new Set<string>();
  const result: TreeNode[] = [];

  function visit(id: string, depth: number): void {
    if (visited.has(id)) return;
    visited.add(id);
    const w = ws.find((x: AnyApi) => x.id === id);
    if (!w) return;
    const children = childrenOf.get(id) || [];
    const parentId = parentOf.get(id);
    const parentWs = parentId ? ws.find((x: AnyApi) => x.id === parentId) : null;
    result.push({
      id,
      name: w.name || id,
      icon: w.icon || "",
      color: w.color || "var(--accent)",
      depth,
      childCount: children.length,
      kindCounts: buildKindCounts(children, ws),
      breadcrumb: parentWs?.name || "",
      starred: !!w.starred,
    });
    if (!collapsed.value.has(id) || q) {
      for (const cid of children) visit(cid, depth + 1);
    }
  }

  // Roots: sort roots by starred first, then activity
  const roots = filtered.filter((w: AnyApi) => {
    const pid = parentOf.get(w.id);
    return !pid || !ws.find((x: AnyApi) => x.id === pid);
  });
  roots.sort((a: AnyApi, b: AnyApi) => {
    const starA = a.starred ? 1 : 0;
    const starB = b.starred ? 1 : 0;
    if (starB !== starA) return starB - starA;
    return activityScore(b) - activityScore(a);
  });

  for (const w of roots) {
    visit(w.id, 0);
  }
  // Remaining (children of filtered-out parents)
  for (const w of filtered) {
    if (!visited.has(w.id)) {
      const parentId = parentOf.get(w.id);
      const parentWs = parentId ? ws.find((x: AnyApi) => x.id === parentId) : null;
      result.push({
        id: w.id,
        name: w.name || w.id,
        icon: w.icon || "",
        color: w.color || "var(--accent)",
        depth: 0,
        childCount: 0,
        kindCounts: "",
        breadcrumb: parentWs?.name || "",
        starred: !!w.starred,
      });
    }
  }
  return result;
});

function resolveParentId(ws: AnyApi, allWs: AnyApi[]): string | null {
  if (ws.review?.parentWorkspaceId) return ws.review.parentWorkspaceId;
  if (ws.quickfix?.parentWorkspaceId) return ws.quickfix.parentWorkspaceId;
  if (ws.task?.parentWorkspaceId) return ws.task.parentWorkspaceId;
  if ((ws.notes || "").startsWith("Worktree of ")) {
    const parentName = ws.name.split(" / ")[0];
    const parent = allWs.find((c: AnyApi) => c.name === parentName && c.id !== ws.id);
    return parent?.id || null;
  }
  return null;
}

function toggleCollapse(id: string): void {
  if (collapsed.value.has(id)) collapsed.value.delete(id);
  else collapsed.value.add(id);
}

async function pick(workspaceId: string): Promise<void> {
  await store.setGridCell(props.cellIndex, workspaceId);
  await store.activateWorkspace(workspaceId);
  emit("close");
}
</script>
