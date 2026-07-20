<template>
  <div class="pipelines-tab">
    <!-- Summary bar -->
    <div v-if="checks?.items?.length" class="pipelines-summary">
      <span v-if="checks.failedCount" class="pipelines-summary__badge pipelines-summary__badge--failed">
        {{ checks.failedCount }} failed
      </span>
      <span v-if="checks.pendingCount" class="pipelines-summary__badge pipelines-summary__badge--pending">
        {{ checks.pendingCount }} pending
      </span>
      <span v-if="checks.passedCount" class="pipelines-summary__badge pipelines-summary__badge--passed">
        {{ checks.passedCount }} passed
      </span>
      <button
        v-if="refreshable"
        type="button"
        class="button button--ghost button--xs"
        :disabled="refreshing"
        @click="$emit('refresh')"
      >
        {{ refreshing ? "Refreshing…" : "↻ Refresh" }}
      </button>
      <span v-if="polling" class="pipelines-summary__polling" title="Auto-refreshing while checks are pending">
        auto ●
      </span>
    </div>

    <!-- Error banner -->
    <div v-if="rerunError" class="pipelines-error" @click="rerunError = ''">
      {{ rerunError }}
      <small>(click to dismiss)</small>
    </div>

    <!-- Check list -->
    <div v-if="checks?.items?.length" class="pipelines-list">
      <div
        v-for="item in checks.items"
        :key="item.id"
        class="pipeline-item"
        :class="{ 'pipeline-item--expanded': expandedId === item.id }"
        @click="toggleExpand(item)"
      >
        <div class="pipeline-item__header">
          <span :class="['pipeline-item__icon', `pipeline-item__icon--${item.state}`]">
            {{ stateIcon(item.state) }}
          </span>
          <div class="pipeline-item__info">
            <strong class="pipeline-item__name">{{ item.name }}</strong>
            <span class="pipeline-item__state-label">{{ item.stateLabel || item.state }}</span>
            <span v-if="item.finishTime" class="pipeline-item__time" :title="formatFull(item.finishTime)">
              {{ formatRelative(item.finishTime) }}
            </span>
            <span
              v-else-if="item.startTime"
              class="pipeline-item__time pipeline-item__time--running"
              :title="formatFull(item.startTime)"
            >
              started {{ formatRelative(item.startTime) }}
            </span>
          </div>
          <div class="pipeline-item__badges">
            <span v-if="item.optional === true" class="pipeline-item__opt-badge">optional</span>
            <span v-else-if="item.optional === false" class="pipeline-item__opt-badge pipeline-item__opt-badge--req">
              required
            </span>
            <button
              v-if="canRerun(item)"
              class="pipeline-item__rerun"
              title="Trigger this pipeline to run again on the current source commit — only available for checks the upstream provider lets us re-run from this client."
              :disabled="rerunningId === item.id"
              @click.stop="handleRerun(item)"
            >
              {{ rerunningId === item.id ? "…" : "↻" }}
            </button>
            <a
              v-if="item.url"
              class="pipeline-item__link"
              :href="item.url"
              title="Open this build / check in your default web browser (Azure DevOps / GitHub) so you can drill into logs and artifacts."
              @click.stop="openUrl(item.url)"
            >
              ↗
            </a>
          </div>
        </div>

        <!-- Expanded detail -->
        <div v-if="expandedId === item.id" class="pipeline-item__detail">
          <div v-if="item.description" class="pipeline-item__desc">{{ item.description }}</div>
          <div v-if="item.buildInfo" class="pipeline-item__meta">
            <span class="pipeline-item__meta-label">Build</span> {{ item.buildInfo }}
          </div>
          <div v-if="item.source" class="pipeline-item__meta">
            <span class="pipeline-item__meta-label">Source</span> {{ item.source }}
          </div>
          <div v-if="item.startTime || item.finishTime" class="pipeline-item__meta">
            <span v-if="item.startTime">
              <span class="pipeline-item__meta-label">Started</span> {{ formatFull(item.startTime) }}
            </span>
            <span v-if="item.finishTime">
              &ensp;<span class="pipeline-item__meta-label">Finished</span> {{ formatFull(item.finishTime) }}
            </span>
            <span v-if="item.startTime && item.finishTime">
              &ensp;<span class="pipeline-item__meta-label">Duration</span>
              {{ formatDuration(item.startTime, item.finishTime) }}
            </span>
          </div>
          <div v-if="item.errorMessage" class="pipeline-item__error">{{ item.errorMessage }}</div>
        </div>
      </div>
    </div>

    <!-- Empty state -->
    <div v-else class="pipelines-empty">
      <p>No checks configured for this pull request.</p>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, inject, watch, computed, onUnmounted } from "vue";
import { apiKey } from "../../../types/keys.js";
import { formatRelative, formatFull, formatDuration } from "../azure/azurePipelineFormat.js";

interface ChecksData {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  items?: Array<Record<string, any>>;
  failedCount?: number;
  pendingCount?: number;
  passedCount?: number;
}

const props = withDefaults(
  defineProps<{
    checks?: ChecksData;
    refreshable?: boolean;
    refreshing?: boolean;
    prKey?: string;
    provider?: string;
  }>(),
  { checks: () => ({ items: [] }), refreshable: true, refreshing: false, prKey: "", provider: "" },
);

const emit = defineEmits<{ (e: "refresh"): void }>();

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const api = inject<any>(apiKey, null);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const expandedId = ref<any>(null);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const rerunningId = ref<any>(null);
const rerunError = ref<string>("");

// Auto-poll while there are pending checks
let pollTimer: ReturnType<typeof setInterval> | null = null;
const POLL_INTERVAL = 15_000;
const polling = computed(() => pollTimer !== null);

function startPolling() {
  stopPolling();
  pollTimer = setInterval(() => {
    if (!props.refreshing) emit("refresh");
  }, POLL_INTERVAL);
}

function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

watch(
  () => props.checks?.pendingCount,
  (pending) => {
    if ((pending ?? 0) > 0) startPolling();
    else stopPolling();
  },
  { immediate: true },
);

onUnmounted(stopPolling);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toggleExpand(item: Record<string, any>) {
  expandedId.value = expandedId.value === item.id ? null : item.id;
}

function stateIcon(state: unknown) {
  if (state === "succeeded") return "✓";
  if (state === "failed") return "✗";
  if (state === "pending") return "●";
  if (state === "not-applicable") return "–";
  return "?";
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function canRerun(item: Record<string, any>) {
  if (props.provider === "azure-devops") return item.kind === "policy" && !!item.evaluationId;
  if (props.provider === "github") return item.kind === "check" && !!item.checkSuiteId;
  return false;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function handleRerun(item: Record<string, any>) {
  rerunningId.value = item.id;
  rerunError.value = "";
  try {
    if (props.provider === "azure-devops" && api?.rerunAzureCheck) {
      await api.rerunAzureCheck(props.prKey, item);
    } else if (props.provider === "github" && api?.rerunGitHubCheck) {
      await api.rerunGitHubCheck(props.prKey, item);
    }
    emit("refresh");
  } catch (err) {
    rerunError.value = `Re-run failed: ${(err as Error)?.message || "unknown error"}`;
    emit("refresh");
  } finally {
    rerunningId.value = null;
  }
}

function openUrl(url: string) {
  if (api?.openExternal) {
    api.openExternal(url);
  } else if (typeof window !== "undefined") {
    window.open(url, "_blank");
  }
}
</script>
