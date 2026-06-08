<template>
  <article :class="['azure-pl-row', expanded && 'azure-pl-row--expanded']">
    <div class="azure-pl-row__main">
      <button
        type="button"
        class="azure-pl-row__expand"
        :aria-expanded="expanded"
        :aria-label="expanded ? 'Hide runs' : 'Show recent runs'"
        :title="expanded ? 'Collapse recent runs.' : 'Expand to see recent runs and re-run a specific one.'"
        @click="toggleExpand"
      >
        <span class="azure-pl-row__caret" aria-hidden="true">{{ expanded ? "▾" : "▸" }}</span>
      </button>

      <span :class="['azure-pl-row__icon', `azure-pl-row__icon--${lastVisual.cls}`]" :title="lastVisual.label">
        {{ lastVisual.icon }}
      </span>

      <div class="azure-pl-row__info">
        <button
          type="button"
          class="azure-pl-row__name"
          title="Open this pipeline in your default browser."
          @click="openUrl(pipeline.webUrl)"
        >
          {{ pipeline.name }}
        </button>
        <span v-if="pipeline.folder && pipeline.folder !== '\\'" class="azure-pl-row__folder">{{
          pipeline.folder
        }}</span>
        <span v-if="pipeline.lastRun" class="azure-pl-row__last">
          <span class="azure-pl-row__build">#{{ pipeline.lastRun.buildNumber }}</span>
          <span class="azure-pl-row__branch">{{ stripRef(pipeline.lastRun.sourceBranch) }}</span>
          <span
            v-if="lastRunTime"
            class="azure-pl-row__time"
            :title="formatFull(pipeline.lastRun.finishTime || pipeline.lastRun.startTime || pipeline.lastRun.queueTime)"
          >
            {{ lastRunTime }}
          </span>
        </span>
        <span v-else class="azure-pl-row__last azure-pl-row__last--empty">No runs yet</span>
      </div>

      <div class="azure-pl-row__actions">
        <button
          v-if="pipeline.lastRun"
          type="button"
          :class="['button', 'button--ghost', 'button--xs', isDownloading(pipeline.lastRun.id) && 'button--busy']"
          :disabled="isDownloading(pipeline.lastRun.id)"
          title="Download the full raw log of the latest run as a .log file."
          @click="$emit('download-log', { pipeline, run: { id: pipeline.lastRun.id } })"
        >
          {{ isDownloading(pipeline.lastRun.id) ? "Downloading…" : "↓ Log" }}
        </button>
        <button
          v-if="lastRunRunning"
          type="button"
          class="button button--ghost button--xs"
          title="Cancel this in-progress run."
          @click="$emit('cancel', { pipeline, run: { id: pipeline.lastRun?.id ?? 0 } })"
        >
          ⏹ Cancel
        </button>
        <button
          v-else-if="pipeline.lastRun"
          type="button"
          class="button button--ghost button--xs"
          :disabled="!canQueue"
          :title="rerunTitle"
          @click="$emit('rerun', { pipeline, run: { id: pipeline.lastRun.id } })"
        >
          ▶ Re-run last
        </button>
      </div>
    </div>

    <div v-if="expanded" class="azure-pl-row__runs">
      <div v-if="runsState.loading && !runsState.runs.length" class="azure-pl-row__hint">Loading runs…</div>
      <div v-else-if="runsState.error" class="azure-pl-row__error">{{ runsState.error }}</div>
      <div v-else-if="!runsState.runs.length" class="azure-pl-row__hint">No runs found.</div>
      <ul v-else class="azure-pl-row__run-list">
        <li v-for="run in runsState.runs" :key="run.id" class="azure-pl-run">
          <span
            :class="['azure-pl-run__icon', `azure-pl-row__icon--${runVisual(run).cls}`]"
            :title="runVisual(run).label"
          >
            {{ runVisual(run).icon }}
          </span>
          <span class="azure-pl-run__name">{{ run.name }}</span>
          <span
            v-if="run.finishedDate || run.createdDate"
            class="azure-pl-run__time"
            :title="formatFull(run.finishedDate || run.createdDate)"
          >
            {{ formatRelative(run.finishedDate || run.createdDate) }}
          </span>
          <span class="azure-pl-run__spacer"></span>
          <button
            v-if="isRunning(run.state)"
            type="button"
            class="button button--ghost button--xs"
            title="Cancel this in-progress run."
            @click="$emit('cancel', { pipeline, run: { id: run.id } })"
          >
            ⏹ Cancel
          </button>
          <button
            v-else
            type="button"
            class="button button--ghost button--xs"
            :disabled="!canQueue"
            :title="rerunTitle"
            @click="$emit('rerun', { pipeline, run })"
          >
            ▶ Re-run
          </button>
          <button
            type="button"
            :class="['button', 'button--ghost', 'button--xs', isDownloading(run.id) && 'button--busy']"
            :disabled="isDownloading(run.id)"
            title="Download this run's full raw log."
            @click="$emit('download-log', { pipeline, run: { id: run.id } })"
          >
            {{ isDownloading(run.id) ? "Downloading…" : "↓ Log" }}
          </button>
          <a
            v-if="run.webUrl"
            class="azure-pl-run__link"
            title="Open this run in your browser."
            @click.prevent="openUrl(run.webUrl)"
          >
            ↗
          </a>
        </li>
      </ul>
    </div>
  </article>
</template>

<script setup lang="ts">
import { computed, inject, ref } from "vue";
import { useAzurePipelinesStore } from "../../../stores/azure-pipelines.js";
import type { AzurePipelineSummary, AzurePipelineRun } from "../../../../electron/shared/types/azure-pipelines.js";

const props = defineProps<{ pipeline: AzurePipelineSummary; downloadingRunId?: number | string | null }>();

/** True while the given run's log is being fetched — drives the button spinner. */
function isDownloading(id: number | string): boolean {
  return props.downloadingRunId != null && props.downloadingRunId === id;
}

defineEmits<{
  (e: "rerun", payload: { pipeline: AzurePipelineSummary; run: { id: number | string } }): void;
  (e: "cancel", payload: { pipeline: AzurePipelineSummary; run: { id: number | string } }): void;
  (e: "download-log", payload: { pipeline: AzurePipelineSummary; run: { id: number | string } }): void;
}>();

/** A run/build is in progress until Azure marks it "completed". */
function isRunning(stateOrStatus: string | undefined): boolean {
  const s = String(stateOrStatus || "").toLowerCase();
  return !!s && s !== "completed";
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const api = inject<any>("api", null);
const store = useAzurePipelinesStore();
const expanded = ref(false);

const runsKey = computed(() => `${props.pipeline.connectionId}:${props.pipeline.id}`);
const runsState = computed(
  () => store.runsByPipeline[runsKey.value] || { loading: false, error: "", runs: [] as AzurePipelineRun[] },
);

const canQueue = computed(() => props.pipeline.queueStatus !== "disabled");
const lastRunRunning = computed(() => !!props.pipeline.lastRun && isRunning(props.pipeline.lastRun.status));
const rerunTitle = computed(() =>
  canQueue.value
    ? "Re-run this pipeline — opens a dialog pre-filled with the branch, parameters and variables of the chosen run so you can tweak before queueing."
    : "Disabled — queueing is turned off for this pipeline in Azure DevOps.",
);

function toggleExpand() {
  expanded.value = !expanded.value;
  if (expanded.value) {
    void store.loadRuns(props.pipeline.connectionId, props.pipeline.project.name, props.pipeline.id);
  }
}

function statusVisual(statusOrState: unknown, result: unknown): { icon: string; cls: string; label: string } {
  const s = String(statusOrState || "").toLowerCase();
  const r = String(result || "").toLowerCase();
  if (s === "completed") {
    if (r === "succeeded") return { icon: "✓", cls: "ok", label: "Succeeded" };
    if (r === "partiallysucceeded") return { icon: "!", cls: "warn", label: "Partially succeeded" };
    if (r === "failed") return { icon: "✗", cls: "fail", label: "Failed" };
    if (r === "canceled") return { icon: "⊘", cls: "canceled", label: "Canceled" };
    return { icon: "✓", cls: "ok", label: "Completed" };
  }
  if (s === "inprogress") return { icon: "●", cls: "running", label: "Running" };
  if (s === "notstarted" || s === "postponed") return { icon: "○", cls: "pending", label: "Queued" };
  if (s === "cancelling" || s === "canceling") return { icon: "●", cls: "canceled", label: "Cancelling" };
  return { icon: "○", cls: "none", label: String(statusOrState || "—") };
}

const lastVisual = computed(() =>
  props.pipeline.lastRun
    ? statusVisual(props.pipeline.lastRun.status, props.pipeline.lastRun.result)
    : { icon: "○", cls: "none", label: "No runs" },
);

function runVisual(run: AzurePipelineRun) {
  return statusVisual(run.state, run.result);
}

const lastRunTime = computed(() => {
  const r = props.pipeline.lastRun;
  if (!r) return "";
  return formatRelative(r.finishTime || r.startTime || r.queueTime || "");
});

function stripRef(ref: unknown) {
  return String(ref || "").replace(/^refs\/heads\//, "");
}

function openUrl(url?: string) {
  if (!url) return;
  if (api?.openExternal) api.openExternal(url);
  else if (typeof window !== "undefined") window.open(url, "_blank");
}

function formatRelative(dateStr?: string) {
  if (!dateStr) return "";
  const diff = Date.now() - new Date(dateStr).getTime();
  if (Number.isNaN(diff)) return "";
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

function formatFull(dateStr?: string) {
  if (!dateStr) return "";
  const d = new Date(dateStr);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleString();
}
</script>

<style scoped>
.azure-pl-row {
  border: 1px solid var(--border);
  border-radius: 6px;
  margin-bottom: 6px;
  background: var(--surface, rgba(255, 255, 255, 0.02));
}
.azure-pl-row__main {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
}
.azure-pl-row__expand {
  background: none;
  border: none;
  color: var(--text-muted, #888);
  cursor: pointer;
  padding: 0 2px;
  font-size: 11px;
}
.azure-pl-row__icon {
  width: 18px;
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
.azure-pl-row__icon--none {
  color: var(--text-muted, #888);
}
.azure-pl-row__icon--canceled {
  color: var(--text-muted, #888);
}
.azure-pl-row__info {
  display: flex;
  align-items: baseline;
  gap: 8px;
  flex: 1;
  min-width: 0;
  flex-wrap: wrap;
}
.azure-pl-row__name {
  background: none;
  border: none;
  padding: 0;
  color: var(--text, inherit);
  font-weight: 600;
  cursor: pointer;
  text-align: left;
}
.azure-pl-row__name:hover {
  text-decoration: underline;
}
.azure-pl-row__folder {
  font-size: 11px;
  color: var(--text-muted, #888);
}
.azure-pl-row__last {
  display: inline-flex;
  gap: 8px;
  font-size: 11px;
  color: var(--text-muted, #888);
}
.azure-pl-row__last--empty {
  font-style: italic;
}
.azure-pl-row__build {
  font-variant-numeric: tabular-nums;
}
.azure-pl-row__actions {
  margin-left: auto;
}
.azure-pl-row__runs {
  border-top: 1px solid var(--border);
  padding: 6px 8px 6px 28px;
}
.azure-pl-row__hint {
  font-size: 11px;
  color: var(--text-muted, #888);
}
.azure-pl-row__error {
  font-size: 11px;
  color: var(--danger, #e53935);
  white-space: pre-wrap;
}
.azure-pl-row__run-list {
  list-style: none;
  margin: 0;
  padding: 0;
}
.azure-pl-run {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 3px 0;
  font-size: 12px;
}
.azure-pl-run__icon {
  width: 16px;
  text-align: center;
}
.azure-pl-run__time {
  color: var(--text-muted, #888);
  font-size: 11px;
}
.azure-pl-run__spacer {
  flex: 1;
}
.azure-pl-run__link {
  cursor: pointer;
  color: var(--accent, #3b82f6);
  text-decoration: none;
}
.button--xs {
  font-size: 10px;
  padding: 1px 8px;
}
</style>
