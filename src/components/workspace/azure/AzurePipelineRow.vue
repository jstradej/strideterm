<template>
  <article :class="['azure-pl-row', expanded && 'azure-pl-row--expanded']">
    <div
      class="azure-pl-row__main"
      role="button"
      :aria-expanded="expanded"
      :title="expanded ? 'Collapse recent runs.' : 'Show recent runs and per-run detail.'"
      @click="toggleExpand"
    >
      <button
        type="button"
        class="azure-pl-row__expand"
        :aria-expanded="expanded"
        :aria-label="expanded ? 'Hide runs' : 'Show recent runs'"
        @click.stop="toggleExpand"
      >
        <span class="azure-pl-row__caret" aria-hidden="true">{{ expanded ? "▾" : "▸" }}</span>
      </button>

      <span :class="['azure-pl-row__icon', `azure-pl-row__icon--${lastVisual.cls}`]" :title="lastVisual.label">
        {{ lastVisual.icon }}
      </span>

      <div class="azure-pl-row__body">
        <div class="azure-pl-row__line1">
          <span class="azure-pl-row__name" :title="pipeline.name">{{ pipeline.name }}</span>
          <span v-if="pipeline.folder && pipeline.folder !== '\\'" class="azure-pl-row__folder">{{
            pipeline.folder
          }}</span>
        </div>

        <div v-if="pipeline.lastRun" class="azure-pl-row__line2">
          <span class="azure-pl-row__build">#{{ pipeline.lastRun.buildNumber }}</span>
          <span v-if="pipeline.lastRun.sourceBranch" class="azure-pl-row__branch">{{
            stripRef(pipeline.lastRun.sourceBranch)
          }}</span>
          <span v-if="pipeline.lastRun.requestedFor" class="azure-pl-row__who" title="Who triggered the run">
            <span aria-hidden="true">👤</span> {{ pipeline.lastRun.requestedFor }}
          </span>
          <span v-if="lastRunDuration" class="azure-pl-row__dur" title="How long the run took">
            <span aria-hidden="true">⏱</span> {{ lastRunDuration }}
          </span>
          <span
            v-if="lastRunTime"
            class="azure-pl-row__time"
            :title="formatFull(pipeline.lastRun.finishTime || pipeline.lastRun.startTime || pipeline.lastRun.queueTime)"
          >
            {{ lastRunTime }}
          </span>

          <div class="azure-pl-row__actions" @click.stop>
            <a
              v-if="pipeline.webUrl"
              class="azure-pl-row__open"
              title="Open this pipeline in your browser."
              @click.prevent="openUrl(pipeline.webUrl)"
              >↗</a
            >
            <button
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
              v-else
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
        <div v-else class="azure-pl-row__line2 azure-pl-row__last--empty">No runs yet</div>
      </div>
    </div>

    <div v-if="expanded" class="azure-pl-row__runs">
      <div v-if="runsState.loading && !runsState.runs.length" class="azure-pl-row__hint">Loading runs…</div>
      <div v-else-if="runsState.error" class="azure-pl-row__error">{{ runsState.error }}</div>
      <div v-else-if="!runsState.runs.length" class="azure-pl-row__hint">No runs found.</div>
      <ul v-else class="azure-pl-row__run-list">
        <li v-for="run in runsState.runs" :key="run.id" class="azure-pl-run-wrap">
          <div
            :class="['azure-pl-run', isRunOpen(run.id) && 'azure-pl-run--open']"
            role="button"
            :aria-expanded="isRunOpen(run.id)"
            title="Show this run's stages and errors."
            @click="toggleRun(run)"
          >
            <span class="azure-pl-run__caret" aria-hidden="true">{{ isRunOpen(run.id) ? "▾" : "▸" }}</span>
            <span
              :class="['azure-pl-run__icon', `azure-pl-row__icon--${runVisual(run).cls}`]"
              :title="runVisual(run).label"
            >
              {{ runVisual(run).icon }}
            </span>
            <span class="azure-pl-run__name">{{ run.name }}</span>
            <span v-if="run.requestedFor" class="azure-pl-run__who" title="Who triggered the run">
              <span aria-hidden="true">👤</span> {{ run.requestedFor }}
            </span>
            <span v-if="runDuration(run)" class="azure-pl-run__dur" title="How long the run took">
              <span aria-hidden="true">⏱</span> {{ runDuration(run) }}
            </span>
            <span
              v-if="run.finishedDate || run.createdDate"
              class="azure-pl-run__time"
              :title="formatFull(run.finishedDate || run.createdDate)"
            >
              {{ formatRelative(run.finishedDate || run.createdDate) }}
            </span>
            <div class="azure-pl-run__actions" @click.stop>
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
            </div>
          </div>

          <div v-if="isRunOpen(run.id)" class="azure-pl-run__detail">
            <div class="azure-pl-run__detail-meta">
              <span v-if="run.sourceBranch">{{ stripRef(run.sourceBranch) }}</span>
              <span v-if="run.sourceVersion" class="azure-pl-run__commit" :title="run.sourceVersion">{{
                shortSha(run.sourceVersion)
              }}</span>
              <a
                v-if="run.webUrl"
                class="azure-pl-run__link"
                title="Open in browser"
                @click.prevent="openUrl(run.webUrl)"
                >Open in Azure ↗</a
              >
            </div>

            <div v-if="detailOf(run.id).loading" class="azure-pl-row__hint">Loading detail…</div>
            <div v-else-if="detailOf(run.id).error" class="azure-pl-row__error">{{ detailOf(run.id).error }}</div>
            <template v-else>
              <div v-if="stagesOf(run.id).length" class="azure-pl-stages">
                <span
                  v-for="(stage, i) in stagesOf(run.id)"
                  :key="`${run.id}-stage-${i}`"
                  class="azure-pl-stage"
                  :title="stageVisual(stage).label"
                >
                  <span :class="['azure-pl-stage__icon', `azure-pl-row__icon--${stageVisual(stage).cls}`]">{{
                    stageVisual(stage).icon
                  }}</span>
                  {{ stage.name }}
                </span>
              </div>

              <ul v-if="errorsOf(run.id).length" class="azure-pl-errors">
                <li v-for="(err, i) in errorsOf(run.id)" :key="`${run.id}-err-${i}`" class="azure-pl-error">
                  <span class="azure-pl-error__icon">✗</span>
                  <div class="azure-pl-error__body">
                    <div class="azure-pl-error__msg">{{ err.message }}</div>
                    <div v-if="err.context" class="azure-pl-error__ctx">{{ err.context }}</div>
                  </div>
                </li>
              </ul>

              <div v-if="!stagesOf(run.id).length && !errorsOf(run.id).length" class="azure-pl-row__hint">
                No stages or errors reported for this run.
              </div>
            </template>
          </div>
        </li>
      </ul>
    </div>
  </article>
</template>

<script setup lang="ts">
import { computed, inject, ref } from "vue";
import { useAzurePipelinesStore } from "../../../stores/azure-pipelines.js";
import type {
  AzurePipelineSummary,
  AzurePipelineRun,
  AzureRunStage,
  AzureRunError,
} from "../../../../electron/shared/types/azure-pipelines.js";

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
/** Per-run inline detail open state, keyed by run id (string). */
const openRuns = ref<Record<string, boolean>>({});

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

async function toggleExpand() {
  expanded.value = !expanded.value;
  if (!expanded.value) return;
  await store.loadRuns(props.pipeline.connectionId, props.pipeline.project.name, props.pipeline.id);
  // Auto-open the latest run's detail so a single click already shows it.
  const runs = runsState.value.runs;
  if (runs.length && !Object.values(openRuns.value).some(Boolean)) openRun(runs[0]);
}

function isRunOpen(id: number | string): boolean {
  return !!openRuns.value[String(id)];
}

function openRun(run: AzurePipelineRun): void {
  openRuns.value = { ...openRuns.value, [String(run.id)]: true };
  void store.getRunDetail(props.pipeline.connectionId, props.pipeline.project.name, run.id);
}

function toggleRun(run: AzurePipelineRun): void {
  if (isRunOpen(run.id)) {
    const next = { ...openRuns.value };
    delete next[String(run.id)];
    openRuns.value = next;
  } else {
    openRun(run);
  }
}

function detailOf(id: number | string) {
  return store.detailByRun[`${props.pipeline.connectionId}:${id}`] || { loading: false, error: "", detail: null };
}

function stagesOf(id: number | string): AzureRunStage[] {
  return detailOf(id).detail?.stages || [];
}

function errorsOf(id: number | string): AzureRunError[] {
  return detailOf(id).detail?.errors || [];
}

function statusVisual(statusOrState: unknown, result: unknown): { icon: string; cls: string; label: string } {
  const s = String(statusOrState || "").toLowerCase();
  const r = String(result || "").toLowerCase();
  if (s === "completed") {
    if (r === "succeeded") return { icon: "✓", cls: "ok", label: "Succeeded" };
    if (r === "partiallysucceeded") return { icon: "!", cls: "warn", label: "Partially succeeded" };
    if (r === "failed") return { icon: "✗", cls: "fail", label: "Failed" };
    if (r === "canceled") return { icon: "⊘", cls: "canceled", label: "Canceled" };
    if (r === "skipped") return { icon: "–", cls: "pending", label: "Skipped" };
    return { icon: "✓", cls: "ok", label: "Completed" };
  }
  if (s === "inprogress") return { icon: "●", cls: "running", label: "Running" };
  if (s === "notstarted" || s === "postponed" || s === "pending") return { icon: "○", cls: "pending", label: "Queued" };
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

function stageVisual(stage: AzureRunStage) {
  return statusVisual(stage.state, stage.result);
}

const lastRunTime = computed(() => {
  const r = props.pipeline.lastRun;
  if (!r) return "";
  return formatRelative(r.finishTime || r.startTime || r.queueTime || "");
});

const lastRunDuration = computed(() => {
  const r = props.pipeline.lastRun;
  if (!r) return "";
  return formatDuration(r.startTime, r.finishTime);
});

function runDuration(run: AzurePipelineRun): string {
  return formatDuration(run.startTime || run.createdDate, run.finishTime || run.finishedDate);
}

function stripRef(ref: unknown) {
  return String(ref || "").replace(/^refs\/heads\//, "");
}

function shortSha(sha?: string) {
  return sha ? sha.slice(0, 8) : "";
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

function formatDuration(start?: string, finish?: string) {
  if (!start) return "";
  const s = new Date(start).getTime();
  const e = finish ? new Date(finish).getTime() : Date.now();
  if (Number.isNaN(s) || Number.isNaN(e) || e < s) return "";
  let sec = Math.round((e - s) / 1000);
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  sec %= 60;
  if (m < 60) return sec ? `${m}m ${sec}s` : `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
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
.azure-pl-row--expanded {
  border-color: var(--accent, #3b82f6);
}
.azure-pl-row__main {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 6px 8px;
  cursor: pointer;
  border-radius: 6px;
}
.azure-pl-row__main:hover {
  background: var(--surface-hover, rgba(255, 255, 255, 0.05));
}
.azure-pl-row__expand {
  background: none;
  border: none;
  color: var(--text-muted, #888);
  cursor: pointer;
  padding: 0 2px;
  font-size: 11px;
  line-height: 20px;
}
.azure-pl-row__icon {
  width: 18px;
  text-align: center;
  font-weight: 700;
  line-height: 20px;
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
.azure-pl-row__body {
  flex: 1;
  min-width: 0;
}
.azure-pl-row__line1 {
  display: flex;
  align-items: baseline;
  gap: 8px;
}
.azure-pl-row__name {
  font-weight: 600;
  color: var(--text, inherit);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.azure-pl-row__folder {
  font-size: 11px;
  color: var(--text-muted, #888);
  white-space: nowrap;
}
.azure-pl-row__line2 {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-top: 2px;
  font-size: 11px;
  color: var(--text-muted, #888);
  flex-wrap: wrap;
}
.azure-pl-row__last--empty {
  font-style: italic;
}
.azure-pl-row__build {
  font-variant-numeric: tabular-nums;
}
.azure-pl-row__actions,
.azure-pl-run__actions {
  display: flex;
  align-items: center;
  gap: 6px;
  cursor: default;
}
.azure-pl-row__open,
.azure-pl-run__link {
  cursor: pointer;
  color: var(--accent, #3b82f6);
  text-decoration: none;
}
.azure-pl-row__runs {
  border-top: 1px solid var(--border);
  padding: 4px 8px 6px 26px;
}
.azure-pl-row__hint {
  font-size: 11px;
  color: var(--text-muted, #888);
  padding: 3px 0;
}
.azure-pl-row__error {
  font-size: 11px;
  color: var(--danger, #e53935);
  white-space: pre-wrap;
  padding: 3px 0;
}
.azure-pl-row__run-list {
  list-style: none;
  margin: 0;
  padding: 0;
}
.azure-pl-run {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 4px 6px;
  font-size: 12px;
  border-radius: 5px;
  cursor: pointer;
}
.azure-pl-run:hover {
  background: var(--surface-hover, rgba(255, 255, 255, 0.05));
}
.azure-pl-run--open {
  background: var(--surface-hover, rgba(255, 255, 255, 0.04));
}
.azure-pl-run__caret {
  color: var(--text-muted, #888);
  font-size: 10px;
  width: 10px;
}
.azure-pl-run__icon {
  width: 16px;
  text-align: center;
}
.azure-pl-run__name {
  font-variant-numeric: tabular-nums;
}
.azure-pl-run__who,
.azure-pl-run__dur,
.azure-pl-run__time,
.azure-pl-row__who,
.azure-pl-row__dur {
  color: var(--text-muted, #888);
  white-space: nowrap;
}
.azure-pl-run__detail {
  padding: 4px 6px 8px 32px;
}
.azure-pl-run__detail-meta {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 11px;
  color: var(--text-muted, #888);
  margin-bottom: 6px;
}
.azure-pl-run__commit {
  font-family: var(--mono, monospace);
}
.azure-pl-stages {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 14px;
  margin-bottom: 8px;
}
.azure-pl-stage {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
}
.azure-pl-stage__icon {
  font-weight: 700;
}
.azure-pl-errors {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.azure-pl-error {
  display: flex;
  gap: 8px;
  font-size: 11px;
}
.azure-pl-error__icon {
  color: var(--danger, #e53935);
  font-weight: 700;
  flex: 0 0 auto;
}
.azure-pl-error__body {
  min-width: 0;
}
.azure-pl-error__msg {
  color: var(--text, inherit);
  word-break: break-word;
}
.azure-pl-error__ctx {
  color: var(--text-muted, #888);
  margin-top: 1px;
}
.button--xs {
  font-size: 10px;
  padding: 1px 8px;
}
</style>
