<template>
  <div class="vol-list">
    <div class="vol-list__toolbar">
      <div class="vol-list__filter">
        <input
          v-model="filter"
          type="text"
          placeholder="Filter volumes…"
          class="vol-list__filter-input"
          spellcheck="false"
          autocomplete="off"
        />
      </div>
      <div class="vol-list__counts">
        <span>{{ filteredRows.length }} / {{ volumes.length }}</span>
        <span v-if="selected.size > 0" class="vol-list__selected">{{ selected.size }} selected</span>
      </div>
      <div class="vol-list__actions">
        <button
          type="button"
          class="button button--ghost button--sm button--danger"
          :disabled="selected.size === 0 || busy"
          @click="askBulkRemove"
        >
          Remove selected
        </button>
        <button
          type="button"
          class="button button--ghost button--sm button--danger"
          :disabled="busy"
          title="docker volume prune — removes volumes not used by any container"
          @click="askPrune"
        >
          Prune unused
        </button>
      </div>
    </div>

    <DockerResourceTable
      :rows="filteredRows"
      :columns="columns"
      :row-id="(r) => r.Name"
      :default-sort="{ key: 'Name', dir: 'asc' }"
      :selected="selected"
      :has-row-actions="true"
      @row-click="onRowClick"
      @update:selected="selected = $event"
    >
      <template #cell-used="{ row }">
        <span v-if="usedByCount(row) > 0" class="vol-list__used-badge" :title="usedByNames(row).join(', ')">
          {{ usedByCount(row) }}
        </span>
        <span v-else class="vol-list__unused" title="Not in use by any container">—</span>
      </template>
      <template #cell-mount="{ row }">
        <span class="vol-list__mount" :title="row.Mountpoint || ''">{{ row.Mountpoint || "—" }}</span>
      </template>
      <template #row-actions="{ row }">
        <button
          type="button"
          class="button button--ghost button--icon-only"
          title="Open detail / browse"
          @click="onRowClick(row)"
        >
          ⤢
        </button>
        <button
          type="button"
          class="button button--ghost button--icon-only button--danger"
          :title="`Remove ${row.Name}`"
          :disabled="busy"
          @click="askRemoveOne(row)"
        >
          ×
        </button>
      </template>
      <template #empty>
        <span v-if="volumes.length === 0">No volumes in this context.</span>
        <span v-else>No volumes match the filter.</span>
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
import type { DockerVolume, DockerContainer } from "../../../../electron/shared/types/state.js";

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

const volumes = computed<DockerVolume[]>(() => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const docker = (appStore.payload as any)?.docker;
  if (!docker?.volumes) return [];
  return (docker.volumes as DockerVolume[]).filter(
    (v) => v.backendId === props.tab.backendId && v.contextName === props.tab.contextName,
  );
});

const containers = computed<DockerContainer[]>(() => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const docker = (appStore.payload as any)?.docker;
  if (!docker?.containers) return [];
  return (docker.containers as DockerContainer[]).filter(
    (c) => c.backendId === props.tab.backendId && c.contextName === props.tab.contextName,
  );
});

const filteredRows = computed(() => {
  const q = filter.value.trim().toLowerCase();
  if (!q) return volumes.value;
  return volumes.value.filter(
    (v) =>
      v.Name.toLowerCase().includes(q) ||
      v.Driver.toLowerCase().includes(q) ||
      (v.Mountpoint ?? "").toLowerCase().includes(q),
  );
});

/**
 * `docker ps --format` puts `Mounts` as a comma-separated list of volume names
 * (named volumes only — anonymous volumes appear by hash). Computing usage from
 * the already-fetched container list avoids an extra per-volume inspect call.
 */
function usedByList(vol: DockerVolume): DockerContainer[] {
  const name = vol.Name;
  return containers.value.filter((c) => {
    const mounts = typeof c.Mounts === "string" ? c.Mounts : "";
    return mounts.split(",").some((m) => m.trim() === name);
  });
}
function usedByCount(vol: DockerVolume): number {
  return usedByList(vol).length;
}
function usedByNames(vol: DockerVolume): string[] {
  return usedByList(vol).map((c) => c.Names?.replace(/^\//, "") || c.ID.slice(0, 12));
}

const columns: Column<DockerVolume>[] = [
  { key: "Name", label: "Name", getValue: (r) => r.Name },
  { key: "Driver", label: "Driver", getValue: (r) => r.Driver },
  { key: "mount", label: "Mountpoint", getValue: (r) => r.Mountpoint || "" },
  {
    key: "used",
    label: "Used by",
    align: "right",
    getValue: (r) => usedByCount(r),
    sortValue: (r) => usedByCount(r),
  },
];

function onRowClick(row: DockerVolume): void {
  detailStore.openVolume(props.workspaceId, row.Name, props.tab.backendId, props.tab.contextName);
}

function askRemoveOne(row: DockerVolume): void {
  const used = usedByCount(row);
  const usedNote = used > 0 ? `\nIn use by ${used} container(s) — will be force-removed.` : "";
  pendingConfirm.value = {
    title: "Remove volume?",
    message: `Remove volume ${row.Name}?${usedNote}\n\nVolume contents will be permanently deleted.`,
    run: async () => {
      busy.value = true;
      try {
        await appStore.dockerVolumeRemove(row.Name, props.tab.backendId, props.tab.contextName, used > 0);
      } catch (e) {
        notifications.showError("Failed to remove volume", `${row.Name}: ${(e as Error)?.message || String(e)}`);
      } finally {
        busy.value = false;
      }
    },
  };
}

function askBulkRemove(): void {
  const ids = [...selected.value];
  const rows = volumes.value.filter((v) => ids.includes(v.Name));
  if (rows.length === 0) return;
  pendingConfirm.value = {
    title: `Remove ${rows.length} volume${rows.length === 1 ? "" : "s"}?`,
    message: bulkConfirmMessage(
      "Remove",
      rows.map((r) => r.Name),
      "Volume contents will be permanently deleted. Volumes in use will be force-removed.",
    ),
    run: async () => {
      busy.value = true;
      let failed = 0;
      for (const row of rows) {
        try {
          await appStore.dockerVolumeRemove(row.Name, props.tab.backendId, props.tab.contextName, usedByCount(row) > 0);
        } catch {
          failed++;
        }
      }
      busy.value = false;
      selected.value = new Set();
      if (failed > 0) {
        notifications.showError("Some volumes could not be removed", `${failed} of ${rows.length} failed.`);
      } else {
        notifications.addEvent({
          title: "Volumes removed",
          body: `Removed ${rows.length} volume${rows.length === 1 ? "" : "s"}.`,
          kind: "info",
          category: "system",
        });
      }
    },
  };
}

function askPrune(): void {
  pendingConfirm.value = {
    title: "Prune unused volumes?",
    message:
      "Removes all anonymous and named volumes not used by any container (docker volume prune).\n\nThis permanently deletes volume contents. Cannot be undone.",
    run: async () => {
      busy.value = true;
      try {
        const r = await appStore.dockerVolumePrune(props.tab.backendId, props.tab.contextName);
        notifications.addEvent({
          title: "Volume prune complete",
          body: pruneSummary(r.deletedNames, r.reclaimed),
          kind: "info",
          category: "system",
        });
      } catch (e) {
        notifications.showError("Volume prune failed", (e as Error)?.message || String(e));
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
.vol-list {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  background: #141416;
}

.vol-list__toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  border-bottom: 1px solid var(--border-color, rgba(255, 255, 255, 0.08));
  flex-wrap: wrap;
  flex-shrink: 0;
}

.vol-list__filter {
  flex: 1 1 200px;
  min-width: 160px;
}
.vol-list__filter-input {
  width: 100%;
  padding: 5px 10px;
  border: 1px solid rgba(255, 255, 255, 0.1);
  background: rgba(255, 255, 255, 0.04);
  color: var(--text-primary, #e2e8f0);
  border-radius: 4px;
  font-size: 12px;
  outline: none;
}
.vol-list__filter-input:focus {
  border-color: var(--accent, #63b3ed);
}

.vol-list__counts {
  display: flex;
  gap: 8px;
  font-size: 11px;
  color: var(--text-dim, #888);
  font-variant-numeric: tabular-nums;
}
.vol-list__selected {
  color: var(--accent, #63b3ed);
  font-weight: 600;
}

.vol-list__actions {
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

.vol-list__used-badge {
  background: rgba(99, 179, 237, 0.15);
  color: var(--accent, #63b3ed);
  border: 1px solid rgba(99, 179, 237, 0.4);
  border-radius: 8px;
  padding: 1px 7px;
  font-size: 11px;
  font-weight: 600;
}
.vol-list__unused {
  color: var(--text-dim, #666);
}

.vol-list__mount {
  font-family: "JetBrainsMono NFM", "CaskaydiaCove NFM", "Fira Code", "Consolas", monospace;
  font-size: 11px;
  color: var(--text-dim, #aaa);
  max-width: 300px;
  overflow: hidden;
  text-overflow: ellipsis;
  display: inline-block;
  vertical-align: middle;
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
