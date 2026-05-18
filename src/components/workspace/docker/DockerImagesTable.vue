<template>
  <div class="img-list">
    <div class="img-list__toolbar">
      <div class="img-list__filter">
        <input
          v-model="filter"
          type="text"
          placeholder="Filter images…"
          class="img-list__filter-input"
          spellcheck="false"
          autocomplete="off"
        />
      </div>
      <div class="img-list__counts">
        <span>{{ filteredRows.length }} / {{ images.length }}</span>
        <span v-if="selected.size > 0" class="img-list__selected">{{ selected.size }} selected</span>
      </div>
      <div class="img-list__actions">
        <button
          type="button"
          class="button button--ghost button--sm button--danger"
          :disabled="selected.size === 0 || busy"
          :title="selected.size === 0 ? 'Select rows to enable' : `Remove ${selected.size} selected`"
          @click="askBulkRemove"
        >
          Remove selected
        </button>
        <button
          type="button"
          class="button button--ghost button--sm"
          :disabled="danglingCount === 0 || busy"
          :title="
            danglingCount === 0
              ? 'No dangling images to remove'
              : `Remove ${danglingCount} dangling image(s) (untagged & not referenced)`
          "
          @click="askPrune(false)"
        >
          Prune dangling
        </button>
        <button
          type="button"
          class="button button--ghost button--sm button--danger"
          :disabled="busy"
          title="docker image prune --all — removes all images not used by a container"
          @click="askPrune(true)"
        >
          Prune all unused
        </button>
      </div>
    </div>

    <DockerResourceTable
      :rows="filteredRows"
      :columns="columns"
      :row-id="rowKey"
      :default-sort="{ key: 'Size', dir: 'desc' }"
      :selected="selected"
      :has-row-actions="true"
      :row-class="(r) => (isDangling(r) ? 'img-row--dangling' : undefined)"
      @row-click="onRowClick"
      @update:selected="selected = $event"
    >
      <template #cell-repo="{ row }">
        <span class="img-list__repo" :title="row.Repository + ':' + row.Tag">
          <span v-if="isDangling(row)" class="img-list__dangling-badge" title="Dangling: no tag, no container">
            dangling
          </span>
          <span>{{ row.Repository }}</span>
          <span v-if="!hasNoneRepo(row)" class="img-list__tag">:{{ row.Tag }}</span>
        </span>
      </template>
      <template #cell-id="{ row }">
        <span class="img-list__id">{{ shortId(row.ID) }}</span>
      </template>
      <template #cell-used="{ row }">
        <span v-if="usedByCount(row) > 0" class="img-list__used-badge" :title="usedByNames(row).join(', ')">
          {{ usedByCount(row) }}
        </span>
        <span v-else class="img-list__unused">—</span>
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
          class="button button--ghost button--icon-only"
          :title="`Pull ${row.Repository}:${row.Tag}`"
          :disabled="hasNoneRepo(row) || busy"
          @click="pullOne(row)"
        >
          ⇩
        </button>
        <button
          type="button"
          class="button button--ghost button--icon-only button--danger"
          :title="`Remove ${shortId(row.ID)}`"
          :disabled="busy"
          @click="askRemoveOne(row)"
        >
          ×
        </button>
      </template>
      <template #empty>
        <span v-if="images.length === 0">No images in this context.</span>
        <span v-else>No images match the filter.</span>
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
import { parseDockerSize, bulkConfirmMessage, pruneSummary, imageRowKey } from "./dockerListHelpers.js";
import type { DockerImage, DockerContainer } from "../../../../electron/shared/types/state.js";

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

const images = computed<DockerImage[]>(() => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const docker = (appStore.payload as any)?.docker;
  if (!docker?.images) return [];
  return (docker.images as DockerImage[]).filter(
    (i) => i.backendId === props.tab.backendId && i.contextName === props.tab.contextName,
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
  if (!q) return images.value;
  return images.value.filter((i) => {
    return (
      i.Repository.toLowerCase().includes(q) ||
      i.Tag.toLowerCase().includes(q) ||
      i.ID.toLowerCase().includes(q) ||
      `${i.Repository}:${i.Tag}`.toLowerCase().includes(q)
    );
  });
});

function shortId(id: string): string {
  return (id || "").replace(/^sha256:/, "").slice(0, 12);
}

/** Re-exposed as a local fn so the template's `:row-id="rowKey"` stays terse. */
const rowKey = imageRowKey;

const NONE = "<" + "none" + ">"; // Split so it never appears as a literal substring in templates that prettier might mis-tokenise.

function isDangling(img: DockerImage): boolean {
  return img.Repository === NONE && img.Tag === NONE;
}

function hasNoneRepo(img: DockerImage): boolean {
  return img.Repository === NONE;
}

const danglingCount = computed(() => images.value.filter(isDangling).length);

/** O(N×M) — fine for typical desktop scale (≤200 images, ≤200 containers). */
function usedByList(img: DockerImage): DockerContainer[] {
  return containers.value.filter(
    (c) => c.ImageID === img.ID || c.Image === `${img.Repository}:${img.Tag}` || c.Image === img.Repository,
  );
}
function usedByCount(img: DockerImage): number {
  return usedByList(img).length;
}
function usedByNames(img: DockerImage): string[] {
  return usedByList(img).map((c) => c.Names?.replace(/^\//, "") || c.ID.slice(0, 12));
}

const columns: Column<DockerImage>[] = [
  { key: "repo", label: "Repository:Tag", getValue: (r) => `${r.Repository}:${r.Tag}` },
  { key: "id", label: "ID", mono: true, getValue: (r) => r.ID, sortValue: (r) => r.ID },
  {
    key: "Size",
    label: "Size",
    align: "right",
    getValue: (r) => r.Size,
    sortValue: (r) => parseDockerSize(r.Size),
  },
  { key: "CreatedSince", label: "Created", getValue: (r) => r.CreatedSince },
  {
    key: "used",
    label: "Used by",
    align: "right",
    getValue: (r) => usedByCount(r),
    sortValue: (r) => usedByCount(r),
  },
];

function onRowClick(row: DockerImage): void {
  const label = hasNoneRepo(row) ? shortId(row.ID) : `${row.Repository}:${row.Tag}`;
  detailStore.openImage(props.workspaceId, row.ID, props.tab.backendId, props.tab.contextName, label);
}

function askRemoveOne(row: DockerImage): void {
  const label = hasNoneRepo(row) ? shortId(row.ID) : `${row.Repository}:${row.Tag}`;
  const used = usedByCount(row);
  const usedNote = used > 0 ? `\nIn use by ${used} container(s) — will be force-removed.` : "";
  pendingConfirm.value = {
    title: "Remove image?",
    message: `Remove ${label}?${usedNote}\n\nThis cannot be undone.`,
    run: async () => {
      busy.value = true;
      try {
        await appStore.dockerImageRemove(row.ID, props.tab.backendId, props.tab.contextName, used > 0);
      } catch (e) {
        notifications.showError("Failed to remove image", `${label}: ${(e as Error)?.message || String(e)}`);
      } finally {
        busy.value = false;
      }
    },
  };
}

function askBulkRemove(): void {
  const keys = selected.value;
  // Selection set holds composite rowKey()s — match them back to image rows.
  // Same image ID can appear under multiple tags; each row in the selection
  // corresponds to one (image, tag) pair and triggers one `docker image rm`.
  const rows = images.value.filter((i) => keys.has(rowKey(i)));
  if (rows.length === 0) return;
  // De-dupe the backend invocations by ID — removing the underlying image
  // also removes its other tags, so a second `rm` for the same ID would 404.
  const uniqueByImageId = new Map<string, DockerImage>();
  for (const r of rows) {
    if (!uniqueByImageId.has(r.ID)) uniqueByImageId.set(r.ID, r);
  }
  const names = rows.map((r) => (hasNoneRepo(r) ? shortId(r.ID) : `${r.Repository}:${r.Tag}`));
  pendingConfirm.value = {
    title: `Remove ${rows.length} image${rows.length === 1 ? "" : "s"}?`,
    message: bulkConfirmMessage(
      "Remove",
      names,
      "This cannot be undone. Images used by containers will be force-removed.",
    ),
    run: async () => {
      busy.value = true;
      let failed = 0;
      for (const row of uniqueByImageId.values()) {
        try {
          await appStore.dockerImageRemove(row.ID, props.tab.backendId, props.tab.contextName, usedByCount(row) > 0);
        } catch {
          failed++;
        }
      }
      busy.value = false;
      selected.value = new Set();
      if (failed > 0) {
        notifications.showError("Some images could not be removed", `${failed} of ${rows.length} failed.`);
      } else {
        notifications.addEvent({
          title: "Images removed",
          body: `Removed ${rows.length} image${rows.length === 1 ? "" : "s"}.`,
          kind: "info",
          category: "system",
        });
      }
    },
  };
}

async function pullOne(row: DockerImage): Promise<void> {
  if (hasNoneRepo(row)) return;
  busy.value = true;
  try {
    await appStore.dockerImagePull(`${row.Repository}:${row.Tag}`, props.tab.backendId, props.tab.contextName);
  } catch (e) {
    notifications.showError(
      "Failed to pull image",
      `${row.Repository}:${row.Tag}: ${(e as Error)?.message || String(e)}`,
    );
  } finally {
    busy.value = false;
  }
}

function askPrune(all: boolean): void {
  pendingConfirm.value = {
    title: all ? "Prune all unused images?" : "Prune dangling images?",
    message: all
      ? "Removes all images not used by any container (docker image prune --all).\n\nThis can free a lot of space but you'll need to re-pull anything you use later."
      : `Removes ${danglingCount.value} dangling image(s): untagged images that no container references.`,
    run: async () => {
      busy.value = true;
      try {
        const r = await appStore.dockerImagePrune(props.tab.backendId, props.tab.contextName, all);
        notifications.addEvent({
          title: "Image prune complete",
          body: pruneSummary(r.deletedNames, r.reclaimed),
          kind: "info",
          category: "system",
        });
      } catch (e) {
        notifications.showError("Image prune failed", (e as Error)?.message || String(e));
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
.img-list {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  background: #141416;
}

.img-list__toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  border-bottom: 1px solid var(--border-color, rgba(255, 255, 255, 0.08));
  flex-wrap: wrap;
  flex-shrink: 0;
}

.img-list__filter {
  flex: 1 1 200px;
  min-width: 160px;
}
.img-list__filter-input {
  width: 100%;
  padding: 5px 10px;
  border: 1px solid rgba(255, 255, 255, 0.1);
  background: rgba(255, 255, 255, 0.04);
  color: var(--text-primary, #e2e8f0);
  border-radius: 4px;
  font-size: 12px;
  outline: none;
}
.img-list__filter-input:focus {
  border-color: var(--accent, #63b3ed);
}

.img-list__counts {
  display: flex;
  gap: 8px;
  font-size: 11px;
  color: var(--text-dim, #888);
  font-variant-numeric: tabular-nums;
}

.img-list__selected {
  color: var(--accent, #63b3ed);
  font-weight: 600;
}

.img-list__actions {
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

.img-list__repo {
  overflow: hidden;
  text-overflow: ellipsis;
  display: inline-block;
  max-width: 100%;
}
.img-list__tag {
  color: #79c0ff;
}
.img-list__id {
  font-family: "JetBrainsMono NFM", "CaskaydiaCove NFM", "Fira Code", "Consolas", monospace;
  font-size: 11px;
}

.img-list__dangling-badge {
  background: rgba(246, 173, 85, 0.18);
  color: var(--color-warn, #f6ad55);
  border: 1px solid rgba(246, 173, 85, 0.45);
  border-radius: 6px;
  padding: 0 5px;
  font-size: 9px;
  text-transform: uppercase;
  letter-spacing: 0.3px;
  margin-right: 6px;
  font-weight: 600;
}

.img-list__used-badge {
  background: rgba(99, 179, 237, 0.15);
  color: var(--accent, #63b3ed);
  border: 1px solid rgba(99, 179, 237, 0.4);
  border-radius: 8px;
  padding: 1px 7px;
  font-size: 11px;
  font-weight: 600;
}
.img-list__unused {
  color: var(--text-dim, #666);
}

:deep(.img-row--dangling) {
  color: rgba(255, 255, 255, 0.6);
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
