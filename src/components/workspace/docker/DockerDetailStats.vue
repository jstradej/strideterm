<template>
  <div class="stats">
    <div class="stats__toolbar">
      <span class="stats__status">
        <span :class="['stats__dot', live ? 'stats__dot--live' : 'stats__dot--paused']" />
        {{ live ? "Live · refresh every 2s" : "Paused" }}
      </span>
      <button type="button" class="button button--ghost button--sm" @click="toggleLive">
        {{ live ? "Pause" : "Resume" }}
      </button>
      <button type="button" class="button button--ghost button--sm" :disabled="loading" @click="loadOnce">
        {{ loading ? "Loading…" : "Refresh" }}
      </button>
      <span v-if="error" class="stats__error">{{ error }}</span>
    </div>
    <div class="stats__body">
      <div v-if="!data && loading" class="stats__loading">
        <Spinner size="md" />
        <span>Reading stats…</span>
      </div>
      <div v-else-if="!data" class="stats__empty">No stats available.</div>
      <template v-else>
        <div class="stats__grid">
          <div class="stats__card">
            <div class="stats__card-label">CPU</div>
            <div class="stats__card-value">{{ data.cpuPerc || "—" }}</div>
            <div class="stats__bar">
              <div class="stats__bar-fill stats__bar-fill--cpu" :style="{ width: cpuPercent + '%' }" />
            </div>
          </div>
          <div class="stats__card">
            <div class="stats__card-label">Memory</div>
            <div class="stats__card-value">{{ data.memPerc || "—" }}</div>
            <div class="stats__card-sub">{{ data.memUsage || "—" }}</div>
            <div class="stats__bar">
              <div class="stats__bar-fill stats__bar-fill--mem" :style="{ width: memPercent + '%' }" />
            </div>
          </div>
          <div class="stats__card">
            <div class="stats__card-label">Network I/O</div>
            <div class="stats__card-value">{{ data.netIO || "—" }}</div>
          </div>
          <div class="stats__card">
            <div class="stats__card-label">Block I/O</div>
            <div class="stats__card-value">{{ data.blockIO || "—" }}</div>
          </div>
          <div class="stats__card">
            <div class="stats__card-label">PIDs</div>
            <div class="stats__card-value">{{ data.pids || "—" }}</div>
          </div>
        </div>

        <div class="stats__charts">
          <div class="stats__chart">
            <div class="stats__chart-header">
              <span class="stats__chart-label">CPU history</span>
              <span class="stats__chart-meta"
                >{{ cpuHistory.length }} / {{ HISTORY_LEN }} samples · ~{{ historyWindowSec }}s</span
              >
            </div>
            <Sparkline
              :data="cpuHistory"
              :max="100"
              stroke="#63b3ed"
              fill="rgba(99,179,237,0.18)"
              :sample-interval-sec="POLL_INTERVAL_SEC"
              :value-formatter="formatPercent"
              aria-label="CPU usage history"
            />
          </div>
          <div class="stats__chart">
            <div class="stats__chart-header">
              <span class="stats__chart-label">Memory history</span>
              <span class="stats__chart-meta">{{ memHistory.length }} / {{ HISTORY_LEN }} samples</span>
            </div>
            <Sparkline
              :data="memHistory"
              :max="100"
              stroke="#f6ad55"
              fill="rgba(246,173,85,0.18)"
              :sample-interval-sec="POLL_INTERVAL_SEC"
              :value-formatter="formatPercent"
              aria-label="Memory usage history"
            />
          </div>
        </div>
      </template>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount, watch } from "vue";
import Spinner from "../../common/Spinner.vue";
import Sparkline from "./Sparkline.vue";
import { useAppStore } from "../../../stores/app.js";

/** Fixed-size ring of samples for the sparkline. ~2 min at 2 s polling. */
const HISTORY_LEN = 60;
/** Polling cadence — kept in a constant so the sparkline tooltip ("Ns ago")
 * stays in sync with the actual sample interval. */
const POLL_INTERVAL_SEC = 2;

function formatPercent(v: number): string {
  return `${v.toFixed(1)}%`;
}

interface StatsRow {
  cpuPerc: string;
  memUsage: string;
  memPerc: string;
  netIO: string;
  blockIO: string;
  pids: string;
}

const props = defineProps<{
  containerId: string;
  backendId: string;
  contextName: string;
  /** Test hook — when provided, render this mock row instead of polling. */
  mockRow?: StatsRow | null;
}>();

const appStore = useAppStore();
const loading = ref(false);
const error = ref<string>("");
const data = ref<StatsRow | null>(null);
const live = ref(true);
let timer: ReturnType<typeof setInterval> | null = null;

const cpuHistory = ref<number[]>([]);
const memHistory = ref<number[]>([]);
const historyWindowSec = computed(() => cpuHistory.value.length * 2);

const cpuPercent = computed(() => parsePerc(data.value?.cpuPerc));
const memPercent = computed(() => parsePerc(data.value?.memPerc));

function pushHistory(buf: number[], value: number): void {
  buf.push(value);
  if (buf.length > HISTORY_LEN) buf.splice(0, buf.length - HISTORY_LEN);
}

function parsePerc(raw: string | undefined): number {
  if (!raw) return 0;
  const n = parseFloat(raw.replace("%", "").trim());
  if (Number.isNaN(n)) return 0;
  return Math.max(0, Math.min(100, n));
}

async function loadOnce(): Promise<void> {
  if (props.mockRow !== undefined) {
    data.value = props.mockRow;
    recordHistory(props.mockRow);
    return;
  }
  loading.value = true;
  error.value = "";
  try {
    data.value = await appStore.dockerStats(props.containerId, props.backendId, props.contextName);
    if (data.value) recordHistory(data.value);
  } catch (e) {
    error.value = (e as Error)?.message || String(e);
  } finally {
    loading.value = false;
  }
}

function recordHistory(row: StatsRow | null): void {
  if (!row) return;
  pushHistory(cpuHistory.value, parsePerc(row.cpuPerc));
  pushHistory(memHistory.value, parsePerc(row.memPerc));
}

function start(): void {
  if (timer) return;
  loadOnce();
  if (props.mockRow !== undefined) return; // no polling in test mode
  timer = setInterval(loadOnce, POLL_INTERVAL_SEC * 1000);
}

function stop(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

function toggleLive(): void {
  live.value = !live.value;
  if (live.value) start();
  else stop();
}

onMounted(() => {
  if (live.value) start();
});

onBeforeUnmount(() => {
  stop();
});

watch(
  () => [props.containerId, props.mockRow],
  () => {
    // New container = new history, otherwise we'd mix samples from two containers.
    cpuHistory.value = [];
    memHistory.value = [];
    stop();
    if (live.value) start();
  },
);
</script>

<style scoped>
.stats {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  background: #141416;
}

.stats__toolbar {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 10px;
  border-bottom: 1px solid var(--border-color, rgba(255, 255, 255, 0.06));
  flex-shrink: 0;
}

.stats__status {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--text-dim, #aaa);
  margin-right: auto;
}

.stats__dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
}

.stats__dot--live {
  background: var(--color-success, #48bb78);
  box-shadow: 0 0 6px rgba(72, 187, 120, 0.5);
  animation: pulse 2s ease-in-out infinite;
}

@keyframes pulse {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.4;
  }
}

.stats__dot--paused {
  background: var(--text-dim, #888);
}

.stats__error {
  color: var(--color-error, #fc8181);
  font-size: 12px;
}

.stats__body {
  flex: 1 1 auto;
  min-height: 0;
  overflow: auto;
  padding: 14px;
}

.stats__loading,
.stats__empty {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  padding: 30px;
  color: var(--text-dim, #888);
  font-size: 13px;
}

.stats__grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 12px;
}

.stats__charts {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
  gap: 12px;
  margin-top: 14px;
}

.stats__chart {
  background: rgba(255, 255, 255, 0.03);
  border: 1px solid var(--border-color, rgba(255, 255, 255, 0.07));
  border-radius: 6px;
  padding: 10px 12px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.stats__chart-header {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  gap: 8px;
}

.stats__chart-label {
  text-transform: uppercase;
  font-size: 10px;
  letter-spacing: 0.6px;
  color: var(--text-dim, #888);
  font-weight: 600;
}

.stats__chart-meta {
  font-size: 10px;
  color: var(--text-dim, #888);
  font-family: "JetBrainsMono NFM", "CaskaydiaCove NFM", "Fira Code", "Consolas", monospace;
  font-variant-numeric: tabular-nums;
}

@media (max-width: 480px) {
  .stats__grid {
    grid-template-columns: 1fr 1fr;
    gap: 8px;
  }
  .stats__card {
    padding: 10px 12px;
    min-height: 78px;
  }
  .stats__card-value {
    font-size: 17px;
  }
}

.stats__card {
  background: rgba(255, 255, 255, 0.03);
  border: 1px solid var(--border-color, rgba(255, 255, 255, 0.07));
  border-radius: 6px;
  padding: 12px 14px;
  min-height: 86px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.stats__card-label {
  text-transform: uppercase;
  font-size: 10px;
  letter-spacing: 0.6px;
  color: var(--text-dim, #888);
  font-weight: 600;
}

.stats__card-value {
  font-family: "JetBrainsMono NFM", "CaskaydiaCove NFM", "Fira Code", "Consolas", monospace;
  font-size: 20px;
  color: #d8e4f5;
  font-variant-numeric: tabular-nums;
}

.stats__card-sub {
  font-size: 11px;
  color: var(--text-dim, #888);
  font-family: "JetBrainsMono NFM", "CaskaydiaCove NFM", "Fira Code", "Consolas", monospace;
}

.stats__bar {
  margin-top: auto;
  height: 4px;
  background: rgba(255, 255, 255, 0.06);
  border-radius: 2px;
  overflow: hidden;
}

.stats__bar-fill {
  height: 100%;
  transition: width 0.4s ease;
  border-radius: 2px;
}

.stats__bar-fill--cpu {
  background: linear-gradient(90deg, #63b3ed, #4299e1);
}

.stats__bar-fill--mem {
  background: linear-gradient(90deg, #f6ad55, #ed8936);
}

.button--sm {
  font-size: 11px;
  padding: 2px 8px;
}
</style>
