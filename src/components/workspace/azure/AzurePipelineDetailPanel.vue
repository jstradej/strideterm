<template>
  <aside class="azure-pl-detail">
    <header class="azure-pl-detail__head">
      <span
        v-if="lastVisual.cls === 'running'"
        class="azure-pl-spinner"
        :title="lastVisual.label"
        role="img"
        aria-label="Running"
      ></span>
      <span v-else :class="['azure-pl-row__icon', `azure-pl-row__icon--${lastVisual.cls}`]" :title="lastVisual.label">{{
        lastVisual.icon
      }}</span>
      <div class="azure-pl-detail__title">
        <div class="azure-pl-detail__name" :title="pipeline.name">{{ pipeline.name }}</div>
        <div class="azure-pl-detail__sub">
          {{ pipeline.project.name
          }}<span v-if="pipeline.folder && pipeline.folder !== '\\'"> · {{ pipeline.folder }}</span>
        </div>
      </div>
      <a
        v-if="pipeline.webUrl"
        class="azure-pl-detail__open"
        title="Open this pipeline in your browser."
        @click.prevent="openUrl(pipeline.webUrl)"
        >↗</a
      >
      <button
        type="button"
        class="azure-pl-detail__close"
        title="Close detail"
        aria-label="Close detail"
        @click="$emit('close')"
      >
        ✕
      </button>
    </header>

    <div class="azure-pl-detail__body">
      <div v-if="runsState.loading && !runsState.runs.length" class="azure-pl-row__hint">Loading runs…</div>
      <div v-else-if="runsState.error" class="azure-pl-row__error">{{ runsState.error }}</div>
      <div v-else-if="!runsState.runs.length" class="azure-pl-row__hint">No runs found.</div>
      <ul v-else class="azure-pl-detail__runs">
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
              v-if="runVisual(run).cls === 'running'"
              class="azure-pl-spinner"
              :title="runVisual(run).label"
              role="img"
              aria-label="Running"
            ></span>
            <span
              v-else
              :class="['azure-pl-run__icon', `azure-pl-row__icon--${runVisual(run).cls}`]"
              :title="runVisual(run).label"
              >{{ runVisual(run).icon }}</span
            >
            <span class="azure-pl-run__name" :title="run.name">{{ run.name }}</span>
            <!-- These three are fixed grid columns (always rendered, even when
                 empty) so every row's data lines up instead of zig-zagging. -->
            <span class="azure-pl-run__who" :title="run.requestedFor ? `Triggered by ${run.requestedFor}` : ''">
              <template v-if="run.requestedFor"><span aria-hidden="true">👤</span> {{ run.requestedFor }}</template>
            </span>
            <span class="azure-pl-run__dur" title="How long the run took">{{ runDuration(run) }}</span>
            <span class="azure-pl-run__time" :title="formatFull(run.finishedDate || run.createdDate)">{{
              formatRelative(run.finishedDate || run.createdDate)
            }}</span>
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
  </aside>
</template>

<script setup lang="ts">
import { computed, inject, ref, watch } from "vue";
import { apiKey } from "../../../types/keys.js";
import { useAzurePipelinesStore } from "../../../stores/azure-pipelines.js";
import {
  statusVisual,
  isRunning,
  stripRef,
  shortSha,
  formatRelative,
  formatFull,
  formatDuration,
} from "./azurePipelineFormat.js";
import type {
  AzurePipelineSummary,
  AzurePipelineRun,
  AzureRunStage,
  AzureRunError,
} from "../../../../electron/shared/types/azure-pipelines.js";

const props = defineProps<{ pipeline: AzurePipelineSummary; downloadingRunId?: number | string | null }>();

defineEmits<{
  (e: "rerun", payload: { pipeline: AzurePipelineSummary; run: { id: number | string } }): void;
  (e: "cancel", payload: { pipeline: AzurePipelineSummary; run: { id: number | string } }): void;
  (e: "download-log", payload: { pipeline: AzurePipelineSummary; run: { id: number | string } }): void;
  (e: "close"): void;
}>();

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const api = inject<any>(apiKey, null);
const store = useAzurePipelinesStore();

/** Per-run inline detail open state, keyed by run id (string). */
const openRuns = ref<Record<string, boolean>>({});

function isDownloading(id: number | string): boolean {
  return props.downloadingRunId != null && props.downloadingRunId === id;
}

const runsKey = computed(() => `${props.pipeline.connectionId}:${props.pipeline.id}`);
const runsState = computed(
  () => store.runsByPipeline[runsKey.value] || { loading: false, error: "", runs: [] as AzurePipelineRun[] },
);

const canQueue = computed(() => props.pipeline.queueStatus !== "disabled");
const rerunTitle = computed(() =>
  canQueue.value
    ? "Re-run this pipeline — opens a dialog pre-filled with the branch, parameters and variables of the chosen run so you can tweak before queueing."
    : "Disabled — queueing is turned off for this pipeline in Azure DevOps.",
);

const lastVisual = computed(() =>
  props.pipeline.lastRun
    ? statusVisual(props.pipeline.lastRun.status, props.pipeline.lastRun.result)
    : { icon: "○", cls: "none", label: "No runs" },
);

/** When the selected pipeline changes, load its runs and auto-open the latest. */
watch(
  () => props.pipeline.id,
  async () => {
    openRuns.value = {};
    await store.loadRuns(props.pipeline.connectionId, props.pipeline.project.name, props.pipeline.id);
    const runs = runsState.value.runs;
    if (runs.length) openRun(runs[0]);
  },
  { immediate: true },
);

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

function runVisual(run: AzurePipelineRun) {
  return statusVisual(run.state, run.result);
}

function stageVisual(stage: AzureRunStage) {
  return statusVisual(stage.state, stage.result);
}

function runDuration(run: AzurePipelineRun): string {
  return formatDuration(run.startTime || run.createdDate, run.finishTime || run.finishedDate);
}

function openUrl(url?: string) {
  if (!url) return;
  if (api?.openExternal) api.openExternal(url);
  else if (typeof window !== "undefined") window.open(url, "_blank");
}
</script>

<style scoped>
.azure-pl-detail {
  display: flex;
  flex-direction: column;
  min-height: 0;
  height: 100%;
  background: var(--surface, rgba(255, 255, 255, 0.02));
}
.azure-pl-detail__head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}
.azure-pl-detail__title {
  flex: 1;
  min-width: 0;
}
.azure-pl-detail__name {
  font-weight: 600;
  color: var(--text, inherit);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.azure-pl-detail__sub {
  font-size: 11px;
  color: var(--text-muted, #888);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.azure-pl-detail__open {
  cursor: pointer;
  color: var(--accent, #3b82f6);
  text-decoration: none;
  font-size: 14px;
}
.azure-pl-detail__close {
  background: none;
  border: none;
  color: var(--text-muted, #888);
  cursor: pointer;
  font-size: 13px;
  padding: 2px 4px;
  line-height: 1;
}
.azure-pl-detail__close:hover {
  color: var(--text, inherit);
}
.azure-pl-detail__body {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 6px 8px;
}

.azure-pl-row__icon {
  width: 18px;
  text-align: center;
  font-weight: 700;
  line-height: 20px;
  flex-shrink: 0;
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
  flex-shrink: 0;
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

.azure-pl-row__hint {
  font-size: 11px;
  color: var(--text-muted, #888);
  padding: 3px 2px;
}
.azure-pl-row__error {
  font-size: 11px;
  color: var(--danger, #e53935);
  white-space: pre-wrap;
  padding: 3px 2px;
}

.azure-pl-detail__runs {
  list-style: none;
  margin: 0;
  padding: 0;
}
.azure-pl-run-wrap {
  border-radius: 6px;
}
/* An expanded run pops out as an accent-bordered card so it's obvious which
   one is open. The open-state tint below is the fallback if :has() is missing. */
.azure-pl-run-wrap:has(.azure-pl-run--open) {
  margin: 4px 0;
  border: 1px solid color-mix(in srgb, var(--accent, #3b82f6), transparent 45%);
  border-left-width: 3px;
  background: var(--surface, rgba(255, 255, 255, 0.02));
  overflow: hidden;
}
/* Grid (not flex) so every column lines up across rows like a table: the
   build number sits in a fixed-width column, so the author/duration/time that
   follow start at the same x instead of zig-zagging with the number's length. */
.azure-pl-run {
  display: grid;
  grid-template-columns: 14px 18px 100px minmax(0, 1fr) 64px 60px auto;
  align-items: center;
  column-gap: 8px;
  padding: 5px 8px;
  font-size: 12px;
  cursor: pointer;
  border-bottom: 1px solid rgba(255, 255, 255, 0.05);
}
.azure-pl-run:hover {
  background: var(--surface-hover, rgba(255, 255, 255, 0.05));
}
/* Narrow (mobile drawer / tight docked) panel: drop the secondary duration and
   time columns so build number, author and the action buttons still fit on one
   line without horizontal scrolling. The split sets container-type: inline-size. */
@container (max-width: 520px) {
  .azure-pl-run {
    grid-template-columns: 14px 18px 92px minmax(0, 1fr) auto;
    column-gap: 6px;
  }
  .azure-pl-run__dur,
  .azure-pl-run__time {
    display: none;
  }
}
.azure-pl-run--open {
  background: var(--accent-subtle, rgba(99, 179, 237, 0.12));
  border-bottom-color: transparent;
}
.azure-pl-run__caret {
  color: var(--text-muted, #888);
  font-size: 10px;
  text-align: center;
}
.azure-pl-run--open .azure-pl-run__caret {
  color: var(--accent, #3b82f6);
}
.azure-pl-run__icon {
  text-align: center;
}
.azure-pl-run__name {
  font-variant-numeric: tabular-nums;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.azure-pl-run__who {
  min-width: 0;
  color: var(--text-muted, #888);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.azure-pl-run__dur,
.azure-pl-run__time {
  color: var(--text-muted, #888);
  white-space: nowrap;
  overflow: hidden;
  text-align: right;
  font-variant-numeric: tabular-nums;
}
.azure-pl-run__actions {
  display: flex;
  align-items: center;
  gap: 6px;
  cursor: default;
  justify-self: end;
}
.azure-pl-run__link {
  cursor: pointer;
  color: var(--accent, #3b82f6);
  text-decoration: none;
}
/* Nested detail visibly belongs to the open run: indented under the name,
   tinted, and divided from the header by a hairline. */
.azure-pl-run__detail {
  padding: 8px 10px 10px 29px;
  background: rgba(255, 255, 255, 0.02);
  border-top: 1px solid rgba(255, 255, 255, 0.06);
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
