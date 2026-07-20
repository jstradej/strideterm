<template>
  <div class="azure-pipelines">
    <div class="azure-pipelines__toolbar">
      <span class="azure-pipelines__spacer"></span>
      <button
        type="button"
        class="button button--ghost button--xs"
        :disabled="anyLoading"
        title="Re-fetch pipelines for all connections."
        @click="refreshAll"
      >
        {{ anyLoading ? "Refreshing…" : "↻ Refresh" }}
      </button>
    </div>

    <div v-if="errors.length" class="azure-pipelines__errors">
      <div v-for="e in errors" :key="e.label" class="azure-pipelines__error">
        <strong>{{ e.label }}:</strong> {{ e.error }}
      </div>
    </div>

    <div ref="splitRef" class="azure-pipelines__split" :style="{ '--azure-pl-detail-w': detailWidth + 'px' }">
      <div class="azure-pipelines__table-area">
        <DockerResourceTable
          :rows="filteredRows"
          :columns="columns"
          :row-id="rowKey"
          :selectable="false"
          :has-row-actions="true"
          :default-sort="{ key: 'when', dir: 'desc' }"
          :row-class="rowClassFor"
          :pinned-first="inProgressOf"
          persist-key="azure-pipelines"
          :filter-values="colFilters"
          @row-click="selectRow"
          @update:filter="onColFilter"
        >
          <template #cell-status="{ row }">
            <span
              v-if="inProgressOf(row)"
              class="azure-pl-spinner"
              title="Running"
              role="img"
              aria-label="Running"
            ></span>
            <span
              v-else
              :class="['azure-pl-row__icon', `azure-pl-row__icon--${visualOf(row).cls}`]"
              :title="visualOf(row).label"
              >{{ visualOf(row).icon }}</span
            >
          </template>
          <template #cell-name="{ row }">
            <span class="azure-pl-table__name" :title="row.name">{{ row.name }}</span>
            <span v-if="row.folder && row.folder !== '\\'" class="azure-pl-table__folder">{{ row.folder }}</span>
          </template>
          <template #cell-branch="{ row }">
            <span v-if="row.lastRun?.sourceBranch">{{ stripRef(row.lastRun.sourceBranch) }}</span>
            <span v-else class="azure-pl-table__dim">—</span>
          </template>
          <template #cell-who="{ row }">
            <span v-if="row.lastRun?.requestedFor">{{ row.lastRun.requestedFor }}</span>
            <span v-else class="azure-pl-table__dim">—</span>
          </template>
          <template #cell-duration="{ row }">{{ durationOf(row) || "—" }}</template>
          <template #cell-when="{ row }">
            <span :title="fullTimeOf(row)">{{ relativeOf(row) || "—" }}</span>
          </template>
          <template #row-actions="{ row }">
            <a
              v-if="row.webUrl"
              class="azure-pl-table__open"
              title="Open this pipeline in your browser."
              @click.stop.prevent="openUrl(row.webUrl)"
              >↗</a
            >
            <button
              v-if="row.lastRun"
              type="button"
              :class="['button', 'button--ghost', 'button--xs', isDownloading(row.lastRun.id) && 'button--busy']"
              :disabled="isDownloading(row.lastRun.id)"
              title="Download the full raw log of the latest run as a .log file."
              @click.stop="onDownloadLog({ pipeline: row, run: { id: row.lastRun.id } })"
            >
              {{ isDownloading(row.lastRun.id) ? "…" : "↓ Log" }}
            </button>
            <button
              v-if="row.lastRun && runningOf(row)"
              type="button"
              class="button button--ghost button--xs"
              title="Cancel this in-progress run."
              @click.stop="onCancel({ pipeline: row, run: { id: row.lastRun.id } })"
            >
              ⏹
            </button>
            <button
              v-else-if="row.lastRun"
              type="button"
              class="button button--ghost button--xs"
              :disabled="row.queueStatus === 'disabled'"
              :title="
                row.queueStatus === 'disabled'
                  ? 'Disabled — queueing is turned off for this pipeline in Azure DevOps.'
                  : 'Re-run this pipeline — opens a dialog pre-filled with the chosen run.'
              "
              @click.stop="onRerun({ pipeline: row, run: { id: row.lastRun.id } })"
            >
              ▶
            </button>
          </template>
          <template #empty>
            <span v-if="anyLoading && !allRows.length">Loading pipelines…</span>
            <span v-else-if="allRows.length">No pipelines match the current filters.</span>
            <span v-else>No pipelines found.</span>
          </template>
        </DockerResourceTable>
      </div>

      <div
        v-if="selectedPipeline"
        class="azure-pipelines__resizer"
        role="separator"
        aria-orientation="vertical"
        title="Drag to resize the detail panel."
        @pointerdown="startResize"
        @dblclick="resetWidth"
      ></div>

      <AzurePipelineDetailPanel
        v-if="selectedPipeline"
        :pipeline="selectedPipeline"
        :downloading-run-id="downloadingRunId"
        @rerun="onRerun"
        @cancel="onCancel"
        @download-log="onDownloadLog"
        @close="selectedKey = null"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch, inject } from "vue";
import { apiKey } from "../../../types/keys.js";
import DockerResourceTable, { type Column } from "../docker/DockerResourceTable.vue";
import AzurePipelineDetailPanel from "./AzurePipelineDetailPanel.vue";
import {
  statusVisual,
  statusRank,
  isRunning,
  stripRef,
  formatRelative,
  formatFull,
  formatDuration,
  durationMs,
} from "./azurePipelineFormat.js";
import { useAppStore } from "../../../stores/app.js";
import { useAzurePipelinesStore } from "../../../stores/azure-pipelines.js";
import { useNotificationStore } from "../../../stores/notifications.js";
import { downloadTextFile } from "../../../app/helpers.js";
import type { AzurePipelineSummary } from "../../../../electron/shared/types/azure-pipelines.js";

interface PipelineRow extends AzurePipelineSummary {
  connectionLabel: string;
}

const props = defineProps<{ connections: Array<{ id: string; label?: string }>; workspaceId?: string }>();

const appStore = useAppStore();
const store = useAzurePipelinesStore();
const notify = useNotificationStore();
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const api = inject<any>(apiKey, null);

const selectedKey = ref<string | null>(null);
const downloadingRunId = ref<number | string | null>(null);

// --- Per-column filters ---
// Project and connection moved out of the toolbar into the table's filter row;
// the table renders the controls, but the matching stays here (see filteredRows).
const CONN_FILTER_KEY = "azure-pipelines:connectionFilter";

// Many setups register the same pipelines under several connections (e.g. two
// orgs pointing at the same project), so showing "all" duplicates every row.
// Default to a single connection and remember the user's choice; "" = All.
function initialConnectionFilter(): string {
  let saved: string | null = null;
  try {
    saved = localStorage.getItem(CONN_FILTER_KEY);
  } catch {
    // localStorage unavailable — fall through to the default.
  }
  const ids = new Set(props.connections.map((c) => c.id));
  // A prior explicit choice wins: "" (All) or a still-valid connection id.
  if (saved !== null && (saved === "" || ids.has(saved))) return saved;
  // First run / stale id: pick one connection so rows aren't duplicated.
  return props.connections.length > 1 ? props.connections[0].id : "";
}

const colFilters = reactive<Record<string, string>>({
  name: "",
  project: "",
  connection: initialConnectionFilter(),
  branch: "",
  who: "",
  when: "",
});

function onColFilter(key: string, value: string): void {
  colFilters[key] = value;
}

watch(
  () => colFilters.connection,
  (v) => {
    try {
      localStorage.setItem(CONN_FILTER_KEY, v);
    } catch {
      // Non-fatal — choice just won't persist this session.
    }
  },
);

// --- Detail panel width (drag to resize, persisted) ---
const DEFAULT_DETAIL_W = 420;
const MIN_DETAIL_W = 280;
const WIDTH_KEY = "azure-pipelines:detailWidth";
const splitRef = ref<HTMLElement | null>(null);

function loadDetailWidth(): number {
  try {
    const raw = Number(localStorage.getItem(WIDTH_KEY));
    if (Number.isFinite(raw) && raw >= MIN_DETAIL_W) return raw;
  } catch {
    // localStorage unavailable (e.g. SSR / tests) — fall back to default.
  }
  return DEFAULT_DETAIL_W;
}

const detailWidth = ref(loadDetailWidth());

/** Largest panel width that still leaves room for the table (or a fallback). */
function maxDetailWidth(): number {
  const total = splitRef.value?.clientWidth ?? 1200;
  return Math.max(MIN_DETAIL_W, total - 320);
}

function startResize(e: PointerEvent): void {
  e.preventDefault();
  const startX = e.clientX;
  const startW = detailWidth.value;
  const max = maxDetailWidth();
  document.body.style.userSelect = "none";
  document.body.style.cursor = "col-resize";
  function onMove(ev: PointerEvent) {
    // Panel sits on the right, so dragging left (negative dx) widens it.
    const next = startW - (ev.clientX - startX);
    detailWidth.value = Math.min(max, Math.max(MIN_DETAIL_W, next));
  }
  function onUp() {
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    document.body.style.userSelect = "";
    document.body.style.cursor = "";
    try {
      localStorage.setItem(WIDTH_KEY, String(Math.round(detailWidth.value)));
    } catch {
      // Non-fatal — width just won't persist this session.
    }
  }
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
}

function resetWidth(): void {
  detailWidth.value = DEFAULT_DETAIL_W;
  try {
    localStorage.setItem(WIDTH_KEY, String(DEFAULT_DETAIL_W));
  } catch {
    // Non-fatal.
  }
}

function stateOf(connectionId: string) {
  return store.byConnection[connectionId] || { loading: false, error: "", pipelines: [], loaded: false };
}

function connectionLabel(connectionId: string): string {
  return props.connections.find((c) => c.id === connectionId)?.label || connectionId;
}

const anyLoading = computed(() => props.connections.some((c) => stateOf(c.id).loading));

const errors = computed(() =>
  props.connections.map((c) => ({ label: c.label || c.id, error: stateOf(c.id).error })).filter((e) => e.error),
);

/** All pipelines across every connection, flattened into one table. */
const allRows = computed<PipelineRow[]>(() => {
  const rows: PipelineRow[] = [];
  for (const conn of props.connections) {
    for (const pipeline of stateOf(conn.id).pipelines) {
      rows.push({ ...pipeline, connectionLabel: conn.label || conn.id });
    }
  }
  return rows;
});

const allProjects = computed(() => {
  const names = new Set<string>();
  for (const r of allRows.value) names.add(r.project?.name || "(no project)");
  return [...names].sort((a, b) => a.localeCompare(b));
});

function lastRunTimeMs(row: PipelineRow): number {
  const r = row.lastRun;
  const stamp = r?.finishTime || r?.startTime || r?.queueTime;
  const ms = stamp ? new Date(stamp).getTime() : NaN;
  return Number.isNaN(ms) ? 0 : ms;
}

const filteredRows = computed<PipelineRow[]>(() => {
  const maxAgeMs = colFilters.when ? Number(colFilters.when) * 86_400_000 : 0;
  const cutoff = maxAgeMs ? Date.now() - maxAgeMs : 0;
  const fName = colFilters.name.trim().toLowerCase();
  const fBranch = colFilters.branch.trim().toLowerCase();
  const fWho = colFilters.who.trim().toLowerCase();
  return allRows.value.filter((r) => {
    if (colFilters.connection && r.connectionId !== colFilters.connection) return false;
    if (colFilters.project && (r.project?.name || "(no project)") !== colFilters.project) return false;
    if (cutoff && lastRunTimeMs(r) < cutoff) return false;
    if (fName && !r.name.toLowerCase().includes(fName)) return false;
    if (fBranch && !stripRef(r.lastRun?.sourceBranch).toLowerCase().includes(fBranch)) return false;
    if (fWho && !(r.lastRun?.requestedFor || "").toLowerCase().includes(fWho)) return false;
    return true;
  });
});

const projectOptions = computed(() => allProjects.value.map((name) => ({ value: name, label: name })));
const connectionOptions = computed(() => props.connections.map((c) => ({ value: c.id, label: c.label || c.id })));

const columns = computed<Column<PipelineRow>[]>(() => {
  const cols: Column<PipelineRow>[] = [
    {
      key: "status",
      label: "",
      width: "34px",
      resizable: false,
      sortValue: (r) => statusRank(r.lastRun?.status, r.lastRun?.result),
    },
    {
      key: "name",
      label: "Pipeline",
      getValue: (r) => r.name,
      sortValue: (r) => r.name,
      filter: { kind: "text", placeholder: "name…" },
    },
    {
      key: "project",
      label: "Project",
      getValue: (r) => r.project?.name || "",
      sortValue: (r) => r.project?.name || "",
      filter: { kind: "select", options: projectOptions.value, placeholder: "All projects" },
    },
  ];
  // Filterable inline — shown whenever more than one connection is configured.
  if (props.connections.length > 1) {
    cols.push({
      key: "connection",
      label: "Connection",
      getValue: (r) => r.connectionLabel,
      sortValue: (r) => r.connectionLabel,
      filter: { kind: "select", options: connectionOptions.value, placeholder: "All connections" },
    });
  }
  cols.push(
    {
      key: "branch",
      label: "Branch",
      sortValue: (r) => stripRef(r.lastRun?.sourceBranch),
      filter: { kind: "text", placeholder: "branch…" },
    },
    {
      key: "who",
      label: "By",
      sortValue: (r) => r.lastRun?.requestedFor || "",
      filter: { kind: "text", placeholder: "by…" },
    },
    {
      key: "duration",
      label: "Duration",
      align: "right",
      sortValue: (r) => durationMs(r.lastRun?.startTime, r.lastRun?.finishTime),
    },
    {
      key: "when",
      label: "When",
      align: "right",
      sortValue: (r) => lastRunTimeMs(r),
      filter: {
        kind: "select",
        placeholder: "Any time",
        options: [
          { value: "1", label: "≤ 1 day" },
          { value: "7", label: "≤ 1 week" },
          { value: "30", label: "≤ 1 month" },
          { value: "90", label: "≤ 3 months" },
        ],
      },
    },
  );
  return cols;
});

function rowKey(row: PipelineRow): string {
  return `${row.connectionId}:${row.id}`;
}

const selectedPipeline = computed<PipelineRow | null>(
  () => allRows.value.find((r) => rowKey(r) === selectedKey.value) || null,
);

function selectRow(row: PipelineRow): void {
  selectedKey.value = selectedKey.value === rowKey(row) ? null : rowKey(row);
}

function visualOf(row: PipelineRow) {
  return row.lastRun
    ? statusVisual(row.lastRun.status, row.lastRun.result)
    : { icon: "○", cls: "none", label: "No runs" };
}
function runningOf(row: PipelineRow): boolean {
  return !!row.lastRun && isRunning(row.lastRun.status);
}
/** Strictly in-progress (not just queued) — drives the spinner + top pinning. */
function inProgressOf(row: PipelineRow): boolean {
  return visualOf(row).cls === "running";
}
function rowClassFor(row: PipelineRow): string | undefined {
  const cls: string[] = [];
  if (rowKey(row) === selectedKey.value) cls.push("azure-pl-table__row--active");
  if (inProgressOf(row)) cls.push("azure-pl-table__row--running");
  return cls.join(" ") || undefined;
}
function durationOf(row: PipelineRow): string {
  return row.lastRun ? formatDuration(row.lastRun.startTime, row.lastRun.finishTime) : "";
}
function relativeOf(row: PipelineRow): string {
  const r = row.lastRun;
  return r ? formatRelative(r.finishTime || r.startTime || r.queueTime) : "";
}
function fullTimeOf(row: PipelineRow): string {
  const r = row.lastRun;
  return r ? formatFull(r.finishTime || r.startTime || r.queueTime) : "";
}
function isDownloading(id: number | string): boolean {
  return downloadingRunId.value != null && downloadingRunId.value === id;
}
function openUrl(url?: string) {
  if (!url) return;
  if (api?.openExternal) api.openExternal(url);
  else if (typeof window !== "undefined") window.open(url, "_blank");
}

const workspaceName = computed(
  () => appStore.payload?.appState?.workspaces?.find((w) => w.id === props.workspaceId)?.name || "Azure DevOps",
);
const profileId = computed(() => appStore.myActiveProfileId || "default");

function loadAll(force = false) {
  for (const conn of props.connections) void store.load(conn.id, { force });
}

function refreshAll() {
  loadAll(true);
  // Also refresh the open detail panel's runs so a stale spinner clears at once
  // (the per-connection reload above doesn't touch the per-pipeline run list).
  const p = selectedPipeline.value;
  if (p) void store.loadRuns(p.connectionId, p.project.name, p.id, { force: true });
}

watch(
  () => props.connections.map((c) => c.id).join(","),
  () => {
    loadAll(false);
    // If the selected connection was removed, fall back so rows aren't all hidden.
    const ids = new Set(props.connections.map((c) => c.id));
    if (colFilters.connection && !ids.has(colFilters.connection)) {
      colFilters.connection = props.connections.length > 1 ? props.connections[0].id : "";
    }
  },
  { immediate: false },
);

onMounted(() => loadAll(false));

function onRerun({ pipeline, run }: { pipeline: AzurePipelineSummary; run: { id: number | string } }) {
  appStore.openDialog("AzurePipelineRunDialog", {
    connectionId: pipeline.connectionId,
    projectName: pipeline.project.name,
    pipelineId: pipeline.id,
    pipelineName: pipeline.name,
    runId: run.id,
    onCancel: () => appStore.closeDialog(),
    onSubmitted: (newRun: { id?: number; webUrl?: string }) => {
      appStore.closeDialog();
      void store.loadRuns(pipeline.connectionId, pipeline.project.name, pipeline.id, { force: true });
      void store.load(pipeline.connectionId, { force: true });
      notify.pushEphemeralToast({
        title: "Pipeline run queued",
        body: `${pipeline.name} — run #${newRun?.id ?? "?"} started. You'll be notified when it finishes.`,
        kind: "success",
        durationMs: 5000,
      });
      if (newRun?.id != null) {
        store.watchRun({
          connectionId: pipeline.connectionId,
          projectName: pipeline.project.name,
          pipelineId: pipeline.id,
          runId: newRun.id,
          pipelineName: pipeline.name,
          connectionLabel: connectionLabel(pipeline.connectionId),
          workspaceId: props.workspaceId || "",
          workspaceName: workspaceName.value,
          profileId: profileId.value,
        });
      }
    },
  });
}

async function onCancel({ pipeline, run }: { pipeline: AzurePipelineSummary; run: { id: number | string } }) {
  try {
    await store.cancel(pipeline.connectionId, pipeline.project.name, run.id);
    notify.pushEphemeralToast({
      title: "Cancel requested",
      body: `${pipeline.name} — run #${run.id}`,
      kind: "info",
      durationMs: 4000,
    });
  } catch (err) {
    notify.pushPersistentToast({
      title: "Couldn't cancel run",
      body: (err as Error)?.message || "Unknown error",
      kind: "error",
      profileId: profileId.value,
    });
  }
}

async function onDownloadLog({ pipeline, run }: { pipeline: AzurePipelineSummary; run: { id: number | string } }) {
  if (downloadingRunId.value != null) return;
  downloadingRunId.value = run.id;
  const toastId = notify.pushEphemeralToast({
    title: "Preparing log…",
    body: `${pipeline.name} — run #${run.id}`,
    kind: "info",
    durationMs: 0,
  });
  try {
    const text = await store.getBuildLog(pipeline.connectionId, pipeline.project.name, run.id);
    const slug = pipeline.name.replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "") || "pipeline";
    downloadTextFile(`${slug}-run-${run.id}.log`, text, "text/plain;charset=utf-8");
  } catch (err) {
    notify.pushPersistentToast({
      title: "Couldn't download log",
      body: (err as Error)?.message || "Unknown error",
      kind: "error",
      profileId: profileId.value,
    });
  } finally {
    notify.dismissPersistentToast(toastId);
    downloadingRunId.value = null;
  }
}
</script>

<style scoped>
.azure-pipelines {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}
.azure-pipelines__toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
  flex-shrink: 0;
  flex-wrap: wrap;
}
.azure-pipelines__count {
  font-size: 11px;
  color: var(--text-muted, #888);
  font-variant-numeric: tabular-nums;
}
.azure-pipelines__spacer {
  flex: 1;
}
.azure-pipelines__errors {
  flex-shrink: 0;
  margin-bottom: 8px;
}
.azure-pipelines__error {
  font-size: 12px;
  color: var(--danger, #e53935);
  white-space: pre-wrap;
  padding: 2px 0;
}

.azure-pipelines__split {
  position: relative;
  display: flex;
  flex: 1;
  min-height: 0;
  container-type: inline-size;
  border: 1px solid var(--border);
  border-radius: 6px;
  overflow: hidden;
}
.azure-pipelines__table-area {
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
.azure-pipelines__split :deep(.azure-pl-detail) {
  flex: 0 0 var(--azure-pl-detail-w, 420px);
  min-width: 0;
}
.azure-pipelines__resizer {
  flex: 0 0 5px;
  cursor: col-resize;
  background: var(--border);
  position: relative;
  touch-action: none;
}
.azure-pipelines__resizer::after {
  /* Wider invisible hit area so the 5px handle is easy to grab. */
  content: "";
  position: absolute;
  inset: 0 -3px;
}
.azure-pipelines__resizer:hover,
.azure-pipelines__resizer:active {
  background: var(--accent, #3b82f6);
}

/* On a narrow pane the detail panel overlays the table as a drawer. */
@container (max-width: 720px) {
  .azure-pipelines__resizer {
    display: none;
  }
  .azure-pipelines__split :deep(.azure-pl-detail) {
    position: absolute;
    inset: 0;
    flex-basis: auto;
    width: 100%;
    z-index: 5;
    box-shadow: -8px 0 24px rgba(0, 0, 0, 0.35);
    background: var(--bg, #141416);
  }
}

.azure-pl-row__icon {
  display: inline-block;
  text-align: center;
  font-weight: 700;
}
.azure-pl-row__icon--ok {
  color: var(--success, #2e9e44);
}
.azure-pl-row__icon--fail {
  color: var(--danger, #e53935);
}
.azure-pl-row__icon--warn {
  color: var(--warning, #d18616);
}
.azure-pl-row__icon--running {
  color: var(--accent, #3b82f6);
}
.azure-pl-row__icon--pending,
.azure-pl-row__icon--none,
.azure-pl-row__icon--canceled {
  color: var(--text-muted, #888);
}

/* Spinning ring for in-progress runs (mirrors Azure DevOps' "running" state). */
.azure-pl-spinner {
  display: inline-block;
  width: 12px;
  height: 12px;
  border: 2px solid color-mix(in srgb, var(--accent, #3b82f6), transparent 65%);
  border-top-color: var(--accent, #3b82f6);
  border-radius: 50%;
  animation: azure-pl-spin 0.7s linear infinite;
  vertical-align: middle;
}
@keyframes azure-pl-spin {
  to {
    transform: rotate(360deg);
  }
}

.azure-pl-table__name {
  font-weight: 600;
  color: var(--text, inherit);
}
.azure-pl-table__folder {
  margin-left: 6px;
  font-size: 11px;
  color: var(--text-muted, #888);
}
.azure-pl-table__dim {
  color: var(--text-muted, #888);
  font-style: italic;
}
.azure-pl-table__open {
  cursor: pointer;
  color: var(--accent, #3b82f6);
  text-decoration: none;
  margin-right: 4px;
}
.azure-pipelines__split :deep(.azure-pl-table__row--active) {
  background: var(--accent-subtle, rgba(99, 179, 237, 0.12));
}
.azure-pipelines__split :deep(.azure-pl-table__row--running) {
  background: color-mix(in srgb, var(--accent, #3b82f6), transparent 90%);
}
.button--xs {
  font-size: 10px;
  padding: 1px 8px;
}
</style>
