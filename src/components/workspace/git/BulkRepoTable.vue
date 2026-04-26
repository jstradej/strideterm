<script setup lang="ts">
import { computed, ref } from "vue";

const props = withDefaults(
  defineProps<{
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    rootsSnapshots?: any[];
    workspaceId: string;
    onFetchAll?: (() => void) | null;
    onPullAll?: (() => void) | null;
    onRefreshRoot?: ((rootPath: string) => void) | null;
    onPullRoot?: ((rootPath: string) => void) | null;
    onRevealRoot?: ((rootPath: string) => void) | null;
  }>(),
  {
    rootsSnapshots: () => [],
    onFetchAll: null,
    onPullAll: null,
    onRefreshRoot: null,
    onPullRoot: null,
    onRevealRoot: null,
  },
);

const emit = defineEmits<{
  (e: "fetch-all"): void;
  (e: "pull-all"): void;
  (e: "refresh-root", rootPath: string): void;
  (e: "pull-root", rootPath: string): void;
  (e: "reveal-root", rootPath: string): void;
}>();

function formatRootLabel(rootPath: string) {
  if (!rootPath) return "";
  return rootPath.split(/[\\/]/).filter(Boolean).at(-1) || rootPath;
}

function formatDate(isoString: string) {
  if (!isoString) return "—";
  try {
    const d = new Date(isoString);
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  } catch {
    return "—";
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const anyDirty = computed(() => props.rootsSnapshots.some((s: any) => s.dirty));

// Per-row in-flight state: { [rootPath]: "busy" | "ok" | "error" | null }
const rowState = ref<Record<string, string | null>>({});

function pullAllTitle() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const dirtyCount = props.rootsSnapshots.filter((s: any) => s.dirty).length;
  if (dirtyCount === 0) return "Pull all repositories (fast-forward only)";
  const total = props.rootsSnapshots.length;
  return `${dirtyCount} of ${total} repositories have uncommitted changes. Commit or stash them, or pull each clean repository individually.`;
}

async function runRowAction(rootPath: string, fn: () => Promise<void> | void) {
  rowState.value = { ...rowState.value, [rootPath]: "busy" };
  try {
    await fn();
    rowState.value = { ...rowState.value, [rootPath]: "ok" };
  } catch {
    rowState.value = { ...rowState.value, [rootPath]: "error" };
  } finally {
    setTimeout(() => {
      rowState.value = { ...rowState.value, [rootPath]: null };
    }, 3000);
  }
}

async function onRefreshRow(rootPath: string) {
  const handler = props.onRefreshRoot || (() => emit("refresh-root", rootPath));
  await runRowAction(rootPath, () => handler(rootPath));
}

async function onPullRow(rootPath: string) {
  const handler = props.onPullRoot || (() => emit("pull-root", rootPath));
  await runRowAction(rootPath, () => handler(rootPath));
}

function onRevealRow(rootPath: string) {
  if (props.onRevealRoot) props.onRevealRoot(rootPath);
  else emit("reveal-root", rootPath);
}

async function handleFetchAll() {
  if (props.onFetchAll) await props.onFetchAll();
  else emit("fetch-all");
}

async function handlePullAll() {
  if (props.onPullAll) await props.onPullAll();
  else emit("pull-all");
}
</script>

<template>
  <div class="bulk-repo-table">
    <div class="bulk-repo-table__toolbar">
      <button class="bulk-btn" @click="handleFetchAll">Fetch all</button>
      <button class="bulk-btn" :disabled="anyDirty" :title="pullAllTitle()" @click="handlePullAll">
        Pull all (ff-only)
      </button>
    </div>

    <table class="bulk-repo-table__table">
      <thead>
        <tr>
          <th>Repository</th>
          <th>Branch</th>
          <th>&#8593;</th>
          <th>&#8595;</th>
          <th>Dirty</th>
          <th>Last fetch</th>
          <th>Status</th>
          <th>Actions</th>
        </tr>
      </thead>
      <tbody>
        <tr
          v-for="snap in rootsSnapshots"
          :key="snap.rootPath"
          :class="{ 'is-dirty': snap.dirty, 'is-unavailable': !snap.available }"
        >
          <td class="bulk-repo-table__repo" :title="snap.rootPath">{{ formatRootLabel(snap.rootPath) }}</td>
          <td class="bulk-repo-table__branch">{{ snap.branch || (snap.available ? "—" : "unavailable") }}</td>
          <td class="bulk-repo-table__count">{{ snap.aheadCount ?? "—" }}</td>
          <td class="bulk-repo-table__count">{{ snap.behindCount ?? "—" }}</td>
          <td class="bulk-repo-table__dirty">
            <span v-if="snap.dirty" class="dirty-marker" title="Uncommitted changes">&#9679;</span>
          </td>
          <td class="bulk-repo-table__fetch">{{ snap.lastFetchAt ? formatDate(snap.lastFetchAt) : "—" }}</td>
          <td class="bulk-repo-table__status">
            <span v-if="!snap.available" class="status-unavailable">unavailable</span>
            <span v-else-if="snap.dirty" class="status-dirty" :title="`${snap.dirtyCount} changed file(s)`"
              >{{ snap.dirtyCount }} change(s)</span
            >
            <span v-else class="status-clean">clean</span>
          </td>
          <td class="bulk-repo-table__actions">
            <button
              class="row-btn"
              title="Refresh"
              :disabled="rowState[snap.rootPath] === 'busy'"
              @click="onRefreshRow(snap.rootPath)"
            >
              &#8635;
            </button>
            <button
              class="row-btn"
              title="Pull (fast-forward only)"
              :disabled="snap.dirty || rowState[snap.rootPath] === 'busy'"
              @click="onPullRow(snap.rootPath)"
            >
              &#8595;
            </button>
            <button class="row-btn" title="Open terminal in this directory" @click="onRevealRow(snap.rootPath)">
              &#9654;
            </button>
            <span v-if="rowState[snap.rootPath] === 'ok'" class="row-result row-result--ok" title="Done">&#10003;</span>
            <span v-else-if="rowState[snap.rootPath] === 'error'" class="row-result row-result--error" title="Failed"
              >&#10007;</span
            >
            <span v-else-if="rowState[snap.rootPath] === 'busy'" class="row-result row-result--busy">&hellip;</span>
          </td>
        </tr>
        <tr v-if="!rootsSnapshots.length">
          <td colspan="8" class="bulk-repo-table__empty">No repositories</td>
        </tr>
      </tbody>
    </table>
  </div>
</template>

<style scoped>
.bulk-repo-table {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 8px;
  height: 100%;
  overflow: auto;
}

.bulk-repo-table__toolbar {
  display: flex;
  gap: 8px;
}

.bulk-btn {
  padding: 4px 12px;
  font-size: 12px;
  border: 1px solid var(--border-color, #444);
  border-radius: 3px;
  background: var(--input-bg, #2d2d2d);
  color: var(--text-primary, #ccc);
  cursor: pointer;
}
.bulk-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
.bulk-btn:not(:disabled):hover {
  background: var(--hover-bg, #3d3d3d);
}

.bulk-repo-table__table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
}

.bulk-repo-table__table th,
.bulk-repo-table__table td {
  text-align: left;
  padding: 4px 8px;
  border-bottom: 1px solid var(--border-color, #333);
  white-space: nowrap;
}

.bulk-repo-table__table th {
  color: var(--text-muted, #888);
  font-weight: normal;
}

.bulk-repo-table__count {
  text-align: right;
  width: 30px;
}

.dirty-marker {
  color: var(--warn-color, #f0a);
}
.status-unavailable {
  color: var(--error-color, #f44);
  font-size: 11px;
}
.status-dirty {
  color: var(--warn-color, #fa0);
  font-size: 11px;
}
.status-clean {
  color: var(--success-color, #4a4);
  font-size: 11px;
}
.bulk-repo-table__empty {
  color: var(--text-muted, #666);
  text-align: center;
  padding: 16px;
}
.bulk-repo-table__actions {
  display: flex;
  gap: 2px;
  align-items: center;
}
.row-btn {
  padding: 1px 5px;
  font-size: 11px;
  border: 1px solid var(--border-color, #444);
  border-radius: 3px;
  background: var(--input-bg, #2d2d2d);
  color: var(--text-primary, #ccc);
  cursor: pointer;
  line-height: 1.4;
}
.row-btn:disabled {
  opacity: 0.35;
  cursor: not-allowed;
}
.row-btn:not(:disabled):hover {
  background: var(--hover-bg, #3d3d3d);
}
.row-result {
  font-size: 12px;
  margin-left: 2px;
}
.row-result--ok {
  color: var(--success-color, #4a4);
}
.row-result--error {
  color: var(--error-color, #f44);
}
.row-result--busy {
  color: var(--text-muted, #888);
}
</style>
