<template>
  <div class="net-list">
    <div class="net-list__toolbar">
      <div class="net-list__filter">
        <input
          v-model="filter"
          type="text"
          placeholder="Filter networks…"
          class="net-list__filter-input"
          spellcheck="false"
          autocomplete="off"
        />
      </div>
      <div class="net-list__counts">
        <span>{{ filteredRows.length }} / {{ networks.length }}</span>
        <span v-if="selected.size > 0" class="net-list__selected">{{ selected.size }} selected</span>
      </div>
      <div class="net-list__actions">
        <button
          type="button"
          class="button button--ghost button--sm button--danger"
          :disabled="removableSelectedCount === 0 || busy"
          :title="
            selected.size === 0
              ? 'Select rows to enable'
              : removableSelectedCount < selected.size
                ? `${selected.size - removableSelectedCount} built-in network(s) will be skipped`
                : `Remove ${removableSelectedCount} selected`
          "
          @click="askBulkRemove"
        >
          Remove selected
        </button>
        <button
          type="button"
          class="button button--ghost button--sm button--danger"
          :disabled="busy"
          title="docker network prune — removes networks not used by any container"
          @click="askPrune"
        >
          Prune unused
        </button>
      </div>
    </div>

    <DockerResourceTable
      :rows="filteredRows"
      :columns="columns"
      :row-id="(r) => r.ID || r.Name"
      :default-sort="{ key: 'Name', dir: 'asc' }"
      persist-key="docker-networks"
      :selected="selected"
      :has-row-actions="true"
      :row-class="(r) => (isProtected(r) ? 'net-row--protected' : undefined)"
      @row-click="onRowClick"
      @update:selected="selected = $event"
    >
      <template #cell-name="{ row }">
        <span>
          {{ row.Name }}
          <span v-if="isProtected(row)" class="net-list__builtin-badge" title="Built-in network — cannot be removed">
            built-in
          </span>
        </span>
      </template>
      <template #cell-id="{ row }">
        <span class="net-list__id">{{ shortId(row.ID) }}</span>
      </template>
      <template #cell-used="{ row }">
        <span v-if="usedByCount(row) > 0" class="net-list__used-badge" :title="usedByNames(row).join(', ')">
          {{ usedByCount(row) }}
        </span>
        <span v-else class="net-list__unused">—</span>
      </template>
      <template #row-actions="{ row }">
        <button
          type="button"
          class="button button--ghost button--icon-only"
          title="Open detail"
          @click="onRowClick(row)"
        >
          ⤢
        </button>
        <button
          type="button"
          class="button button--ghost button--icon-only button--danger"
          :title="isProtected(row) ? 'Built-in networks cannot be removed' : `Remove ${row.Name}`"
          :disabled="busy || isProtected(row)"
          @click="askRemoveOne(row)"
        >
          ×
        </button>
      </template>
      <template #empty>
        <span v-if="networks.length === 0">No networks in this context.</span>
        <span v-else>No networks match the filter.</span>
      </template>
    </DockerResourceTable>

    <teleport to="body">
      <div v-if="pendingConfirm" class="dialog-overlay" @click.self="pendingConfirm = null">
        <ConfirmDialog
          :title="pendingConfirm.title"
          :message="pendingConfirm.message"
          confirm-label="Remove"
          :danger="true"
          @confirm="runPending"
          @cancel="pendingConfirm = null"
        />
      </div>
    </teleport>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from "vue";
import DockerResourceTable, { type Column } from "./DockerResourceTable.vue";
import ConfirmDialog from "../../dialogs/ConfirmDialog.vue";
import { useAppStore } from "../../../stores/app.js";
import { useNotificationStore } from "../../../stores/notifications.js";
import { useDockerDetail, type OpenTab } from "../../../stores/docker-detail.js";
import { bulkConfirmMessage, pruneSummary } from "./dockerListHelpers.js";
import type { DockerNetwork, DockerContainer } from "../../../../electron/shared/types/state.js";

const props = defineProps<{ workspaceId: string; tab: OpenTab }>();

const appStore = useAppStore();
const detailStore = useDockerDetail();
const notifications = useNotificationStore();

const filter = ref("");
const selected = ref<Set<string>>(new Set());
const busy = ref(false);

interface PendingAction {
  title: string;
  message: string;
  run: () => Promise<void>;
}
const pendingConfirm = ref<PendingAction | null>(null);

/**
 * Docker's three built-in networks. Removing any of them errors out with
 * "is a pre-defined network and cannot be removed" — we skip them upfront
 * in the UI so the user doesn't have to read backend error messages.
 */
const PROTECTED_NAMES = new Set(["bridge", "host", "none"]);
function isProtected(n: DockerNetwork): boolean {
  return PROTECTED_NAMES.has(n.Name);
}

const networks = computed<DockerNetwork[]>(() => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const docker = appStore.dockerState();
  if (!docker?.networks) return [];
  return (docker.networks as DockerNetwork[]).filter(
    (n) => n.backendId === props.tab.backendId && n.contextName === props.tab.contextName,
  );
});

const containers = computed<DockerContainer[]>(() => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const docker = appStore.dockerState();
  if (!docker?.containers) return [];
  return (docker.containers as DockerContainer[]).filter(
    (c) => c.backendId === props.tab.backendId && c.contextName === props.tab.contextName,
  );
});

const filteredRows = computed(() => {
  const q = filter.value.trim().toLowerCase();
  if (!q) return networks.value;
  return networks.value.filter(
    (n) =>
      n.Name.toLowerCase().includes(q) || n.Driver.toLowerCase().includes(q) || (n.ID || "").toLowerCase().includes(q),
  );
});

/**
 * `docker ps --format` includes a `Networks` field as a comma-separated list
 * of network names. Same deal as volumes — we derive usage from existing
 * payload data rather than calling `docker network inspect` per row.
 */
function usedByList(net: DockerNetwork): DockerContainer[] {
  const name = net.Name;
  return containers.value.filter((c) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const nets = (c as any).Networks;
    if (typeof nets !== "string") return false;
    return nets.split(",").some((s) => s.trim() === name);
  });
}
function usedByCount(net: DockerNetwork): number {
  return usedByList(net).length;
}
function usedByNames(net: DockerNetwork): string[] {
  return usedByList(net).map((c) => c.Names?.replace(/^\//, "") || c.ID.slice(0, 12));
}

function shortId(id: string | undefined): string {
  return (id || "").replace(/^sha256:/, "").slice(0, 12);
}

const columns: Column<DockerNetwork>[] = [
  { key: "name", label: "Name", getValue: (r) => r.Name },
  { key: "id", label: "ID", mono: true, getValue: (r) => shortId(r.ID), sortValue: (r) => r.ID || r.Name },
  { key: "Driver", label: "Driver", getValue: (r) => r.Driver },
  { key: "Scope", label: "Scope", getValue: (r) => r.Scope || "" },
  {
    key: "used",
    label: "Used by",
    align: "right",
    getValue: (r) => usedByCount(r),
    sortValue: (r) => usedByCount(r),
  },
];

const removableSelectedCount = computed(() => {
  let n = 0;
  for (const net of networks.value) {
    if (selected.value.has(net.ID || net.Name) && !isProtected(net)) n++;
  }
  return n;
});

function onRowClick(row: DockerNetwork): void {
  detailStore.openNetwork(props.workspaceId, row.ID, props.tab.backendId, props.tab.contextName, row.Name);
}

function askRemoveOne(row: DockerNetwork): void {
  if (isProtected(row)) return;
  const used = usedByCount(row);
  const usedNote = used > 0 ? `\nIn use by ${used} container(s). Disconnect them first or this will fail.` : "";
  pendingConfirm.value = {
    title: "Remove network?",
    message: `Remove network ${row.Name}?${usedNote}\n\nThis cannot be undone.`,
    run: async () => {
      busy.value = true;
      try {
        await appStore.dockerNetworkRemove(row.ID, props.tab.backendId, props.tab.contextName);
      } catch (e) {
        notifications.showError("Failed to remove network", `${row.Name}: ${(e as Error)?.message || String(e)}`);
      } finally {
        busy.value = false;
      }
    },
  };
}

function askBulkRemove(): void {
  const ids = [...selected.value];
  const rows = networks.value.filter((n) => ids.includes(n.ID || n.Name) && !isProtected(n));
  if (rows.length === 0) return;
  const skipped = selected.value.size - rows.length;
  const suffix = [
    "This cannot be undone.",
    skipped > 0 ? `${skipped} built-in network(s) will be skipped.` : "",
    "Networks in use will fail to remove — disconnect containers first.",
  ]
    .filter(Boolean)
    .join("\n");
  pendingConfirm.value = {
    title: `Remove ${rows.length} network${rows.length === 1 ? "" : "s"}?`,
    message: bulkConfirmMessage(
      "Remove",
      rows.map((r) => r.Name),
      suffix,
    ),
    run: async () => {
      busy.value = true;
      let failed = 0;
      for (const row of rows) {
        try {
          await appStore.dockerNetworkRemove(row.ID, props.tab.backendId, props.tab.contextName);
        } catch {
          failed++;
        }
      }
      busy.value = false;
      selected.value = new Set();
      if (failed > 0) {
        notifications.showError("Some networks could not be removed", `${failed} of ${rows.length} failed.`);
      } else {
        notifications.addEvent({
          title: "Networks removed",
          body: `Removed ${rows.length} network${rows.length === 1 ? "" : "s"}.`,
          kind: "info",
          category: "system",
        });
      }
    },
  };
}

function askPrune(): void {
  pendingConfirm.value = {
    title: "Prune unused networks?",
    message: "Removes all networks not used by at least one container (docker network prune).",
    run: async () => {
      busy.value = true;
      try {
        const r = await appStore.dockerNetworkPrune(props.tab.backendId, props.tab.contextName);
        notifications.addEvent({
          title: "Network prune complete",
          body: pruneSummary(r.deletedNames, r.reclaimed),
          kind: "info",
          category: "system",
        });
      } catch (e) {
        notifications.showError("Network prune failed", (e as Error)?.message || String(e));
      } finally {
        busy.value = false;
      }
    },
  };
}

async function runPending(): Promise<void> {
  const p = pendingConfirm.value;
  pendingConfirm.value = null;
  if (p) await p.run();
}
</script>

<style scoped>
.net-list {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  background: #141416;
}

.net-list__toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  border-bottom: 1px solid var(--border-color, rgba(255, 255, 255, 0.08));
  flex-wrap: wrap;
  flex-shrink: 0;
}

.net-list__filter {
  flex: 1 1 200px;
  min-width: 160px;
}
.net-list__filter-input {
  width: 100%;
  padding: 5px 10px;
  border: 1px solid rgba(255, 255, 255, 0.1);
  background: rgba(255, 255, 255, 0.04);
  color: var(--text-primary, #e2e8f0);
  border-radius: 4px;
  font-size: 12px;
  outline: none;
}
.net-list__filter-input:focus {
  border-color: var(--accent, #63b3ed);
}

.net-list__counts {
  display: flex;
  gap: 8px;
  font-size: 11px;
  color: var(--text-dim, #888);
  font-variant-numeric: tabular-nums;
}
.net-list__selected {
  color: var(--accent, #63b3ed);
  font-weight: 600;
}

.net-list__actions {
  display: flex;
  gap: 6px;
  margin-left: auto;
  flex-wrap: wrap;
}

.button--sm {
  font-size: 11px;
  padding: 3px 9px;
}
.button--icon-only {
  padding: 0;
  width: 22px;
  height: 22px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 13px;
  margin: 0 1px;
}

.net-list__id {
  font-family: "JetBrainsMono NFM", "CaskaydiaCove NFM", "Fira Code", "Consolas", monospace;
  font-size: 11px;
}

.net-list__builtin-badge {
  background: rgba(255, 255, 255, 0.06);
  color: var(--text-dim, #999);
  border: 1px solid rgba(255, 255, 255, 0.15);
  border-radius: 6px;
  padding: 0 5px;
  font-size: 9px;
  text-transform: uppercase;
  letter-spacing: 0.3px;
  margin-left: 6px;
  font-weight: 600;
}

.net-list__used-badge {
  background: rgba(99, 179, 237, 0.15);
  color: var(--accent, #63b3ed);
  border: 1px solid rgba(99, 179, 237, 0.4);
  border-radius: 8px;
  padding: 1px 7px;
  font-size: 11px;
  font-weight: 600;
}
.net-list__unused {
  color: var(--text-dim, #666);
}

:deep(.net-row--protected) {
  opacity: 0.7;
}

.dialog-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
}
</style>
