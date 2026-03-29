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
              title="Re-run this check"
              :disabled="rerunningId === item.id"
              @click.stop="handleRerun(item)"
            >
              {{ rerunningId === item.id ? "…" : "↻" }}
            </button>
            <a
              v-if="item.url"
              class="pipeline-item__link"
              :href="item.url"
              title="Open in browser"
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

<script setup>
import { ref, inject, watch, computed, onUnmounted } from "vue";

const props = defineProps({
  checks: { type: Object, default: () => ({ items: [] }) },
  refreshable: { type: Boolean, default: true },
  refreshing: { type: Boolean, default: false },
  prKey: { type: String, default: "" },
  provider: { type: String, default: "" },
});

const emit = defineEmits(["refresh"]);

const api = inject("api", null);
const expandedId = ref(null);
const rerunningId = ref(null);
const rerunError = ref("");

// Auto-poll while there are pending checks
let pollTimer = null;
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
    if (pending > 0) startPolling();
    else stopPolling();
  },
  { immediate: true },
);

onUnmounted(stopPolling);

function toggleExpand(item) {
  expandedId.value = expandedId.value === item.id ? null : item.id;
}

function stateIcon(state) {
  if (state === "succeeded") return "✓";
  if (state === "failed") return "✗";
  if (state === "pending") return "●";
  if (state === "not-applicable") return "–";
  return "?";
}

function canRerun(item) {
  if (props.provider === "azure-devops") return item.kind === "policy" && !!item.evaluationId;
  if (props.provider === "github") return item.kind === "check" && !!item.checkSuiteId;
  return false;
}

async function handleRerun(item) {
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
    rerunError.value = `Re-run failed: ${err?.message || "unknown error"}`;
    emit("refresh");
  } finally {
    rerunningId.value = null;
  }
}

function openUrl(url) {
  if (api?.openExternal) {
    api.openExternal(url);
  } else if (typeof window !== "undefined") {
    window.open(url, "_blank");
  }
}

function formatRelative(dateStr) {
  if (!dateStr) return "";
  const diff = Date.now() - new Date(dateStr).getTime();
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

function formatFull(dateStr) {
  if (!dateStr) return "";
  return new Date(dateStr).toLocaleString();
}

function formatDuration(startStr, endStr) {
  if (!startStr || !endStr) return "";
  const ms = new Date(endStr).getTime() - new Date(startStr).getTime();
  if (ms < 1000) return "<1s";
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ${Math.floor((ms % 60_000) / 1000)}s`;
  return `${Math.floor(ms / 3_600_000)}h ${Math.floor((ms % 3_600_000) / 60_000)}m`;
}
</script>
