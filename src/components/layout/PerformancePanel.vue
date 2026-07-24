<template>
  <div class="perf">
    <div class="perf__toolbar">
      <span
        class="perf__status"
        :title="
          paused
            ? 'Sampling is paused — no metrics are being collected.'
            : snapshot && snapshot.warmingUp
              ? 'Collecting the first sample — CPU needs two samples before the numbers mean anything.'
              : `Live — this panel re-samples every ${refreshMs / 1000}s while it is open and the window is visible.`
        "
      >
        <span :class="['perf__dot', statusDotClass]" />
        {{ statusLabel }}
      </span>

      <label class="perf__interval" title="How often this panel samples metrics. Stored per client.">
        <span class="perf__interval-label">Every</span>
        <select class="perf__select" :value="refreshMs" @change="onIntervalChange">
          <option v-for="opt in INTERVAL_OPTIONS" :key="opt" :value="opt">{{ opt / 1000 }}s</option>
        </select>
      </label>

      <button
        type="button"
        class="perf__btn"
        title="Pause or resume sampling. While paused the polling timer and this window's terminal diagnostics are turned off entirely."
        @click="togglePause"
      >
        {{ paused ? "Resume" : "Pause" }}
      </button>
      <button
        type="button"
        class="perf__btn"
        :disabled="capturing"
        title="Record a ~6s renderer CPU profile and write a .cpuprofile to the logs dir for offline analysis (same as Ctrl+Shift+F12)."
        @click="captureProfile"
      >
        {{ capturing ? "Recording…" : "Capture CPU profile" }}
      </button>
      <button type="button" class="perf__btn" title="Copy the current diagnostics as JSON." @click="copyDiagnostics">
        {{ copied ? "Copied" : "Copy" }}
      </button>
      <button
        type="button"
        class="perf__btn"
        title="Download the current diagnostics as a JSON file."
        @click="exportDiagnostics"
      >
        Export
      </button>
    </div>

    <div class="perf__body">
      <p v-if="capturedPath" class="perf__note perf__note--ok">
        <span class="perf__note-label">CPU profile saved:</span>
        <span class="perf__note-path" :title="capturedPath">{{ capturedPath }}</span>
        <button
          type="button"
          class="perf__btn perf__btn--inline"
          title="Reveal the .cpuprofile in your OS file manager (Explorer on Windows, Finder on macOS, your file manager on Linux)."
          @click="revealProfile"
        >
          Open folder
        </button>
      </p>
      <p v-else-if="captureStatus" class="perf__note perf__note--info">{{ captureStatus }}</p>
      <p v-if="error" class="perf__note perf__note--warn">{{ error }} · showing last reading</p>

      <div v-if="!snapshot" class="perf__empty">
        <Spinner size="md" />
        <span>Sampling metrics…</span>
      </div>

      <template v-else>
        <p v-if="snapshot.warmingUp" class="perf__note perf__note--info">
          Warming up — CPU percentages need a second sample to be meaningful.
        </p>

        <!-- Summary cards -->
        <div class="perf__cards">
          <div
            class="perf__card"
            title="CPU and working-set memory of the Chromium renderer process that draws THIS window. CPU is a percentage of one core over the last sample (100% ≈ one core fully busy), so a heavy render loop shows up here. The bar is capped at 100%."
          >
            <div class="perf__card-label">This window (renderer)</div>
            <div class="perf__card-value" :class="cpuClass(rendererProc?.cpuPercent)">
              {{ fmtCpu(rendererProc?.cpuPercent) }}
            </div>
            <div class="perf__card-sub">
              {{ rendererProc ? fmtMem(rendererProc.workingSetKb) : "—" }} · pid {{ rendererProc?.pid ?? "—" }}
            </div>
            <div class="perf__bar">
              <div class="perf__bar-fill perf__bar-fill--cpu" :style="{ width: barWidth(rendererProc?.cpuPercent) }" />
            </div>
          </div>
          <div
            class="perf__card"
            title="Combined CPU and working set across every Electron process (main/browser, renderer windows, GPU, utilities). The summed CPU can exceed 100% because each process is measured against its own core; the bar normalises it by the process count."
          >
            <div class="perf__card-label">All Electron processes</div>
            <div class="perf__card-value" :class="cpuClass(snapshot.totalCpuPercent, processCount)">
              {{ fmtCpu(snapshot.totalCpuPercent) }}
            </div>
            <div class="perf__card-sub">
              {{ processCount }} processes · {{ fmtMem(snapshot.totalWorkingSetKb) }} working set
            </div>
            <div class="perf__bar">
              <div
                class="perf__bar-fill perf__bar-fill--cpu"
                :style="{ width: barWidth(snapshot.totalCpuPercent, processCount) }"
              />
            </div>
          </div>
          <div
            class="perf__card"
            title="CPU and working set of the Chromium GPU process that composites terminal output. High values here point at rendering/WebGL cost (or a driver problem) rather than raw terminal data volume. Shows 'n/a' when no separate GPU process exists."
          >
            <div class="perf__card-label">GPU process</div>
            <div class="perf__card-value" :class="cpuClass(gpuProc?.cpuPercent)">
              {{ gpuProc ? fmtCpu(gpuProc.cpuPercent) : "n/a" }}
            </div>
            <div class="perf__card-sub">{{ gpuProc ? fmtMem(gpuProc.workingSetKb) : "no GPU process" }}</div>
            <div class="perf__bar">
              <div class="perf__bar-fill perf__bar-fill--gpu" :style="{ width: barWidth(gpuProc?.cpuPercent) }" />
            </div>
          </div>
          <div
            class="perf__card"
            title="Machine-wide physical RAM in use (total minus free), from the last sample. This is the whole OS, not just this app — context for how much memory headroom is left."
          >
            <div class="perf__card-label">System memory</div>
            <div class="perf__card-value">{{ systemUsedPercent }}%</div>
            <div class="perf__card-sub">
              {{ fmtMem(systemUsedKb) }} / {{ fmtMem(snapshot.systemMemory.totalKb) }} used
            </div>
            <div class="perf__bar">
              <div class="perf__bar-fill perf__bar-fill--mem" :style="{ width: systemUsedPercent + '%' }" />
            </div>
          </div>
        </div>

        <!-- History charts -->
        <div class="perf__charts">
          <div
            class="perf__chart"
            title="This window's renderer CPU over time (one point per sample, newest on the right). A rising trend that never settles is the signature of a runaway render loop. Hover any point for its exact value and how long ago it was taken."
          >
            <div class="perf__chart-head">
              <span class="perf__chart-label">Renderer CPU</span>
              <span class="perf__chart-meta" :title="historyMetaTitle">{{ historyWindowLabel }}</span>
            </div>
            <Sparkline
              :data="rendererCpuHistory"
              :max="cpuChartMax"
              stroke="#63b3ed"
              fill="rgba(99,179,237,0.18)"
              :sample-interval-sec="refreshMs / 1000"
              :value-formatter="fmtCpuChart"
              aria-label="Renderer CPU history"
            />
          </div>
          <div
            class="perf__chart"
            title="Combined CPU across all Electron processes over time. Compare its shape with the renderer chart to tell whether the load is in this window or somewhere else (GPU, main, another window)."
          >
            <div class="perf__chart-head">
              <span class="perf__chart-label">Total app CPU</span>
              <span class="perf__chart-meta" :title="historyMetaTitle">{{ historyWindowLabel }}</span>
            </div>
            <Sparkline
              :data="totalCpuHistory"
              :max="totalCpuChartMax"
              stroke="#b794f4"
              fill="rgba(183,148,244,0.18)"
              :sample-interval-sec="refreshMs / 1000"
              :value-formatter="fmtCpuChart"
              aria-label="Total app CPU history"
            />
          </div>
          <div
            class="perf__chart"
            title="Total working-set memory of the whole app over time (MB). A steadily climbing line that never comes back down suggests a memory leak."
          >
            <div class="perf__chart-head">
              <span class="perf__chart-label">Working set</span>
              <span class="perf__chart-meta" :title="historyMetaTitle">{{ historyWindowLabel }}</span>
            </div>
            <Sparkline
              :data="workingSetHistory"
              :max="memChartMax"
              stroke="#f6ad55"
              fill="rgba(246,173,85,0.18)"
              :sample-interval-sec="refreshMs / 1000"
              :value-formatter="fmtMbChart"
              aria-label="Total working set history"
            />
          </div>
        </div>

        <!-- Terminal diagnostics -->
        <div
          class="perf__section-head"
          title="Renderer-local terminal rendering counters for THIS window, measured over the last sample interval. These never leave the browser — they distinguish 'lots of PTY output' from 'lots of repainting' from 'a WebGL/GPU problem'."
        >
          Terminal activity (this window)
        </div>
        <div v-if="termDiag" class="perf__cards perf__cards--rates">
          <div
            class="perf__mini"
            title="terminal:data chunks received per second across every terminal in this window."
          >
            <span class="perf__mini-value">{{ fmtRate(termDiag.dataChunks) }}</span
            ><span class="perf__mini-label">chunks/s</span>
          </div>
          <div
            class="perf__mini"
            title="Bytes of terminal output received per second (approximated from chunk length). High here + low renders/s = a lot of data the terminal is coalescing efficiently."
          >
            <span class="perf__mini-value">{{ fmtByteRate(termDiag.dataBytes) }}</span
            ><span class="perf__mini-label">data/s</span>
          </div>
          <div
            class="perf__mini"
            title="xterm render events per second — how often the terminal actually repaints. High renders/s at modest data/s means the output is thrashing the renderer."
          >
            <span class="perf__mini-value">{{ fmtRate(termDiag.renderEvents) }}</span
            ><span class="perf__mini-label">renders/s</span>
          </div>
          <div
            class="perf__mini"
            title="Terminal rows repainted per second (summed across every render event). A proxy for how much screen area is being redrawn."
          >
            <span class="perf__mini-value">{{ fmtRate(termDiag.renderedRows) }}</span
            ><span class="perf__mini-label">rows/s</span>
          </div>
          <div
            class="perf__mini"
            title="Real dimension changes / total resize callbacks this interval. Many callbacks but few real changes means resize churn (layout thrashing) without the terminal size actually changing."
          >
            <span class="perf__mini-value">{{ termDiag.resizeChanges }}/{{ termDiag.resizeCallbacks }}</span
            ><span class="perf__mini-label">resizes/calls</span>
          </div>
          <div
            class="perf__mini"
            title="Forced full terminal redraws this interval (after attach or a forced resize). Should be rare while idle."
          >
            <span class="perf__mini-value">{{ termDiag.fullRefreshes }}</span
            ><span class="perf__mini-label">full refreshes</span>
          </div>
          <div class="perf__mini" title="Number of live terminal views currently mounted in this window.">
            <span class="perf__mini-value">{{ termDiag.liveViews }}</span
            ><span class="perf__mini-label">live terminals</span>
          </div>
          <div
            class="perf__mini"
            title="Terminals currently drawing with the GPU (WebGL) renderer vs the DOM fallback. Terminals stuck on DOM scroll less smoothly under heavy output."
          >
            <span class="perf__mini-value">{{ termDiag.webglRenderers }}/{{ termDiag.domRenderers }}</span
            ><span class="perf__mini-label">WebGL/DOM</span>
          </div>
          <div
            class="perf__mini"
            :class="{ 'perf__mini--alert': webglTrouble }"
            title="This interval: WebGL attach failures · GPU context losses · fallbacks to the DOM renderer. Anything non-zero (tile turns red) explains stutter, blank terminals or repeated WebGL↔DOM switching."
          >
            <span class="perf__mini-value"
              >{{ termDiag.webglAttachFailures }}·{{ termDiag.webglContextLosses }}·{{ termDiag.webglFallbacks }}</span
            >
            <span class="perf__mini-label">fail·loss·fallback</span>
          </div>
        </div>
        <div
          v-if="termDiag && termDiag.topSessions.length"
          class="perf__top"
          title="The busiest terminal sessions this interval, ranked by data volume. Use it to see whether one long-running agent is responsible for the load. Session ids only — never terminal contents."
        >
          <div v-for="s in termDiag.topSessions" :key="s.sessionId" class="perf__top-row">
            <span class="perf__top-id" :title="`Session id: ${s.sessionId}`">{{ shortSession(s.sessionId) }}</span>
            <span class="perf__top-stat">{{ fmtRate(s.dataBytes) }} data/s</span>
            <span class="perf__top-stat">{{ fmtRate(s.renderEvents) }} renders/s</span>
          </div>
        </div>

        <!-- Process table -->
        <div
          class="perf__section-head"
          title="Every Electron/Chromium process in the app, sorted by CPU (hottest first). This is the fastest way to see WHICH process is burning CPU — a renderer window, the GPU process, the main/browser process, or a background utility."
        >
          Electron processes
        </div>
        <table class="perf__table">
          <thead>
            <tr>
              <th
                title="Process role: Browser = the main process, Tab = a renderer window, GPU = the compositor, Utility = a background helper (network, audio, …)."
              >
                Type
              </th>
              <th
                class="perf__num"
                title="OS process id. Combine with the process creation time to tell reused PIDs apart across samples."
              >
                PID
              </th>
              <th
                class="perf__num"
                title="Percentage of one CPU core used since the last sample. Can exceed 100% for a multithreaded process."
              >
                CPU
              </th>
              <th
                class="perf__num"
                title="Physical RAM the process currently has mapped (working set). 'priv' is private bytes — memory not shared with other processes (Windows only)."
              >
                Working set
              </th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="p in snapshot.processes"
              :key="`${p.pid}-${p.creationTime}`"
              :class="{ 'perf__row--current': p.isCurrentRenderer }"
              :title="`${p.type}${p.serviceName && p.serviceName !== p.type ? ' · ' + p.serviceName : ''} · pid ${p.pid} · started ${fmtStarted(p.creationTime)}`"
            >
              <td>
                <!-- The service name (e.g. network.mojom.NetworkService) is
                     often long and crowds the row, so it lives in the row's
                     hover tooltip rather than inline. -->
                <span class="perf__ptype">{{ p.type }}</span>
                <span
                  v-if="p.isCurrentRenderer"
                  class="perf__tag"
                  title="The renderer process backing the window you are looking at right now."
                  >this window</span
                >
              </td>
              <td class="perf__num">{{ p.pid }}</td>
              <td class="perf__num" :class="cpuClass(p.cpuPercent)">{{ fmtCpu(p.cpuPercent) }}</td>
              <td class="perf__num">
                {{ fmtMem(p.workingSetKb)
                }}<span v-if="p.privateBytesKb != null" class="perf__psub"> · {{ fmtMem(p.privateBytesKb) }} priv</span>
              </td>
            </tr>
          </tbody>
        </table>
      </template>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, shallowRef, computed, onMounted, onBeforeUnmount } from "vue";
import Spinner from "../common/Spinner.vue";
// Reused generic sparkline (no Docker coupling — pure presentational leaf).
import Sparkline from "../workspace/docker/Sparkline.vue";
import { useAppStore } from "../../stores/app.js";
import { useTerminalStore } from "../../stores/terminal.js";
import { useNotificationStore } from "../../stores/notifications.js";
import { downloadTextFile, readPerfRefreshInterval, writePerfRefreshInterval } from "../../app/helpers.js";
import type { PerformanceSnapshot } from "../../../electron/shared/performance.js";
import type { TerminalDiagnosticsSnapshot } from "../../app/terminal-controller.js";

const HISTORY_LEN = 150; // ~5 min at 2s
const INTERVAL_OPTIONS = [1000, 2000, 5000, 10000];

const appStore = useAppStore();
const terminalStore = useTerminalStore();
const notifications = useNotificationStore();

const snapshot = shallowRef<PerformanceSnapshot | null>(null);
const termDiag = shallowRef<TerminalDiagnosticsSnapshot | null>(null);
const error = ref("");
const paused = ref(false);
const copied = ref(false);
const capturing = ref(false);
const captureStatus = ref("");
const capturedPath = ref("");
const refreshMs = ref(readPerfRefreshInterval());

const rendererCpuHistory = ref<number[]>([]);
const totalCpuHistory = ref<number[]>([]);
const workingSetHistory = ref<number[]>([]); // MB, for a friendlier chart scale

let timer: ReturnType<typeof setInterval> | null = null;

function pushHistory(buf: number[], value: number): void {
  buf.push(value);
  if (buf.length > HISTORY_LEN) buf.splice(0, buf.length - HISTORY_LEN);
}

const rendererProc = computed(() => snapshot.value?.processes.find((p) => p.isCurrentRenderer) ?? null);
const gpuProc = computed(() => snapshot.value?.processes.find((p) => p.type === "GPU") ?? null);
const processCount = computed(() => snapshot.value?.processes.length ?? 0);

const systemUsedKb = computed(() => {
  const m = snapshot.value?.systemMemory;
  if (!m) return 0;
  return Math.max(0, m.totalKb - m.freeKb);
});
const systemUsedPercent = computed(() => {
  const total = snapshot.value?.systemMemory.totalKb ?? 0;
  return total > 0 ? Math.round((systemUsedKb.value / total) * 100) : 0;
});

const cpuChartMax = computed(() => niceMax(rendererCpuHistory.value, 100));
const totalCpuChartMax = computed(() => niceMax(totalCpuHistory.value, 100));
const memChartMax = computed(() => niceMax(workingSetHistory.value, 128, 128));

const historyWindowLabel = computed(() => {
  const n = rendererCpuHistory.value.length;
  const sec = Math.round((n * refreshMs.value) / 1000);
  return `${n}/${HISTORY_LEN} · ~${sec}s`;
});
const historyMetaTitle = computed(
  () =>
    `Samples collected / max kept (${HISTORY_LEN}, oldest dropped) · time span these points cover at the current ${refreshMs.value / 1000}s interval.`,
);

const webglTrouble = computed(
  () => !!termDiag.value && (termDiag.value.webglAttachFailures > 0 || termDiag.value.webglContextLosses > 0),
);

const statusDotClass = computed(() =>
  paused.value ? "perf__dot--paused" : snapshot.value?.warmingUp ? "perf__dot--warming" : "perf__dot--live",
);
const statusLabel = computed(() => (paused.value ? "Paused" : `Live · every ${refreshMs.value / 1000}s`));

function niceMax(data: number[], floor: number, step = 50): number {
  const peak = data.length ? Math.max(...data) : 0;
  return Math.max(floor, Math.ceil(peak / step) * step);
}

// A single renderer/GPU process saturates one core at ~100%. The all-process
// total is normalized against the number of cores it spans so the bar stays
// readable rather than pinning at 100% under multi-process load.
function cpuClass(value: number | undefined | null, denom = 1): string {
  if (value == null) return "";
  const norm = value / denom;
  if (norm >= 70) return "perf__cpu--high";
  if (norm >= 30) return "perf__cpu--mid";
  return "perf__cpu--low";
}
function barWidth(value: number | undefined | null, denom = 1): string {
  if (value == null) return "0%";
  return `${Math.min(100, Math.max(0, value / denom))}%`;
}

function fmtCpu(value: number | undefined | null): string {
  if (value == null) return "—";
  if (snapshot.value?.warmingUp) return "…";
  return `${value.toFixed(value < 10 ? 1 : 0)}%`;
}
function fmtCpuChart(v: number): string {
  return `${v.toFixed(1)}%`;
}
function fmtMem(kb: number): string {
  if (kb >= 1024 * 1024) return `${(kb / 1024 / 1024).toFixed(2)} GB`;
  if (kb >= 1024) return `${(kb / 1024).toFixed(0)} MB`;
  return `${Math.round(kb)} KB`;
}
function fmtMbChart(mb: number): string {
  return mb >= 1024 ? `${(mb / 1024).toFixed(2)} GB` : `${mb.toFixed(0)} MB`;
}
/** Turn an interval delta count into a per-second rate using the diagnostics
 *  snapshot's own intervalMs (independent of the UI poll cadence). */
function ratePerSec(count: number): number {
  const ms = termDiag.value?.intervalMs;
  if (!ms || ms <= 0) return 0;
  return (count / ms) * 1000;
}
function fmtRate(count: number): string {
  const r = ratePerSec(count);
  if (r === 0) return "0";
  return r < 10 ? r.toFixed(1) : String(Math.round(r));
}
function fmtByteRate(count: number): string {
  const r = ratePerSec(count);
  if (r >= 1024 * 1024) return `${(r / 1024 / 1024).toFixed(1)} MB`;
  if (r >= 1024) return `${(r / 1024).toFixed(1)} KB`;
  return `${Math.round(r)} B`;
}
function shortSession(id: string): string {
  const parts = id.split(":");
  return parts.length > 1 ? parts.slice(-2).join(":") : id;
}
function fmtStarted(creationTime: number): string {
  if (!creationTime) return "unknown";
  try {
    return new Date(creationTime).toLocaleTimeString();
  } catch {
    return "unknown";
  }
}

async function poll(): Promise<void> {
  if (document.visibilityState !== "visible") return;
  try {
    const snap = await appStore.getPerformanceSnapshot();
    if (!snap) {
      error.value = "Performance metrics are unavailable on this connection.";
      return;
    }
    error.value = "";
    snapshot.value = snap;
    const td = terminalStore.getTerminalDiagnostics();
    if (td) termDiag.value = td;
    pushHistory(rendererCpuHistory.value, snap.warmingUp ? 0 : (rendererProc.value?.cpuPercent ?? 0));
    pushHistory(totalCpuHistory.value, snap.warmingUp ? 0 : snap.totalCpuPercent);
    pushHistory(workingSetHistory.value, snap.totalWorkingSetKb / 1024);
  } catch (e) {
    // Keep the last reading and show a brief inline status — never a toast
    // loop while polling.
    error.value = (e as Error)?.message || String(e);
  }
}

function start(): void {
  if (timer || paused.value) return;
  terminalStore.setTerminalDiagnosticsEnabled(true);
  void poll();
  timer = setInterval(() => void poll(), refreshMs.value);
}

function stop(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  terminalStore.setTerminalDiagnosticsEnabled(false);
}

function onIntervalChange(event: Event): void {
  const value = Number((event.target as HTMLSelectElement).value);
  if (!INTERVAL_OPTIONS.includes(value)) return;
  refreshMs.value = value;
  writePerfRefreshInterval(value);
  if (timer) {
    clearInterval(timer);
    timer = setInterval(() => void poll(), refreshMs.value);
  }
}

function togglePause(): void {
  paused.value = !paused.value;
  if (paused.value) stop();
  else start();
}

function onVisibilityChange(): void {
  if (document.visibilityState === "visible") {
    if (!paused.value) start();
  } else {
    stop();
  }
}

async function captureProfile(): Promise<void> {
  capturing.value = true;
  captureStatus.value = "Recording ~6s renderer CPU profile…";
  capturedPath.value = "";
  try {
    const res = await appStore.captureRendererCpuProfile();
    if (!res) {
      captureStatus.value = "";
    } else if (res.ok) {
      captureStatus.value = "";
      capturedPath.value = res.path ?? "";
    } else {
      captureStatus.value = "";
      notifications.showError("CPU profile failed", res.error || "Unknown error");
    }
  } catch (e) {
    captureStatus.value = "";
    notifications.showError("CPU profile failed", (e as Error)?.message || String(e));
  } finally {
    capturing.value = false;
  }
}

async function revealProfile(): Promise<void> {
  if (!capturedPath.value) return;
  try {
    const res = await appStore.revealCpuProfile(capturedPath.value);
    if (res && !res.ok) {
      notifications.showError("Could not open folder", res.error || "Unknown error");
    }
  } catch (e) {
    notifications.showError("Could not open folder", (e as Error)?.message || String(e));
  }
}

/** Serialize the current diagnostics. Contains only process metrics + terminal
 *  activity counters + numeric history — never terminal content, env vars, or
 *  other sensitive data. */
function buildReport(): string {
  return JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      refreshMs: refreshMs.value,
      process: snapshot.value,
      terminal: termDiag.value,
      history: {
        rendererCpuPercent: rendererCpuHistory.value,
        totalCpuPercent: totalCpuHistory.value,
        workingSetMb: workingSetHistory.value,
      },
    },
    null,
    2,
  );
}

async function copyDiagnostics(): Promise<void> {
  try {
    await navigator.clipboard.writeText(buildReport());
    copied.value = true;
    setTimeout(() => {
      copied.value = false;
    }, 1500);
  } catch (e) {
    notifications.showError("Copy failed", (e as Error)?.message || String(e));
  }
}

function exportDiagnostics(): void {
  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  downloadTextFile(`strideterm-perf-${ts}.json`, buildReport(), "application/json");
}

onMounted(() => {
  document.addEventListener("visibilitychange", onVisibilityChange);
  start();
});

onBeforeUnmount(() => {
  document.removeEventListener("visibilitychange", onVisibilityChange);
  stop();
});
</script>

<style scoped>
.perf {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}

.perf__toolbar {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  padding: 8px 10px;
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}

.perf__status {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--muted);
  margin-right: auto;
}

.perf__dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
}
.perf__dot--live {
  background: var(--success, #4caf50);
  box-shadow: 0 0 6px rgba(76, 175, 80, 0.5);
  animation: perf-pulse 2s ease-in-out infinite;
}
.perf__dot--warming {
  background: var(--accent, #ffa424);
}
.perf__dot--paused {
  background: var(--muted, #888);
}
@keyframes perf-pulse {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.4;
  }
}

.perf__interval {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  color: var(--muted);
}
.perf__select {
  background: rgba(var(--tint), 0.06);
  color: var(--text);
  border: 1px solid var(--border);
  border-radius: 5px;
  padding: 2px 6px;
  font-size: 11px;
  font-family: inherit;
  cursor: pointer;
}

.perf__btn {
  background: rgba(var(--tint), 0.06);
  color: var(--text);
  border: 1px solid var(--border);
  border-radius: 5px;
  padding: 3px 9px;
  font-size: 11px;
  cursor: pointer;
  transition: background 0.15s ease;
}
.perf__btn:hover:not(:disabled) {
  background: rgba(var(--tint), 0.12);
}
.perf__btn:disabled {
  opacity: 0.55;
  cursor: default;
}

.perf__body {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  overflow-x: hidden;
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.perf__empty {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  padding: 40px;
  color: var(--muted);
  font-size: 13px;
}

.perf__note {
  margin: 0;
  padding: 6px 10px;
  border-radius: 6px;
  font-size: 11px;
  line-height: 1.4;
  word-break: break-all;
}
.perf__note--info {
  background: rgba(var(--tint), 0.05);
  color: var(--muted);
}
.perf__note--ok {
  background: rgba(76, 175, 80, 0.12);
  color: var(--success-fg, #6edfb6);
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 4px 8px;
}
.perf__note--warn {
  background: rgba(255, 111, 141, 0.12);
  color: var(--danger-fg, #ff6f8d);
}
.perf__note-label {
  flex-shrink: 0;
}
.perf__note-path {
  flex: 1 1 160px;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text);
  font-family: "JetBrainsMono NFM", "CaskaydiaCove NFM", "Fira Code", "Consolas", monospace;
}
.perf__btn--inline {
  flex-shrink: 0;
  padding: 2px 8px;
  font-size: 10.5px;
}

.perf__cards {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
  gap: 10px;
}
.perf__cards--rates {
  grid-template-columns: repeat(auto-fit, minmax(96px, 1fr));
  gap: 8px;
}

.perf__card {
  background: rgba(var(--tint), 0.03);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 10px 12px;
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-height: 84px;
}
.perf__card-label {
  text-transform: uppercase;
  font-size: 9.5px;
  letter-spacing: 0.5px;
  color: var(--muted);
  font-weight: 600;
}
.perf__card-value {
  font-size: 20px;
  color: var(--text);
  font-variant-numeric: tabular-nums;
  font-family: "JetBrainsMono NFM", "CaskaydiaCove NFM", "Fira Code", "Consolas", monospace;
}
.perf__card-sub {
  font-size: 10.5px;
  color: var(--muted);
  font-variant-numeric: tabular-nums;
}
.perf__bar {
  margin-top: auto;
  height: 4px;
  background: rgba(var(--tint), 0.08);
  border-radius: 2px;
  overflow: hidden;
}
.perf__bar-fill {
  height: 100%;
  border-radius: 2px;
  transition: width 0.4s ease;
}
.perf__bar-fill--cpu {
  background: linear-gradient(90deg, #63b3ed, #4299e1);
}
.perf__bar-fill--gpu {
  background: linear-gradient(90deg, #9f7aea, #805ad5);
}
.perf__bar-fill--mem {
  background: linear-gradient(90deg, #f6ad55, #ed8936);
}

.perf__cpu--low {
  color: var(--success-fg, #6edfb6);
}
.perf__cpu--mid {
  color: var(--accent, #ffa424);
}
.perf__cpu--high {
  color: var(--danger-fg, #ff6f8d);
}

.perf__charts {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 10px;
}
.perf__chart {
  background: rgba(var(--tint), 0.03);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 8px 10px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.perf__chart-head {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  gap: 8px;
}
.perf__chart-label {
  text-transform: uppercase;
  font-size: 9.5px;
  letter-spacing: 0.5px;
  color: var(--muted);
  font-weight: 600;
}
.perf__chart-meta {
  font-size: 9.5px;
  color: var(--muted);
  font-variant-numeric: tabular-nums;
}

.perf__section-head {
  font-size: 11px;
  font-weight: 600;
  color: var(--text);
  text-transform: uppercase;
  letter-spacing: 0.5px;
  margin-top: 2px;
}

.perf__mini {
  background: rgba(var(--tint), 0.03);
  border: 1px solid var(--border);
  border-radius: 7px;
  padding: 8px 6px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  text-align: center;
}
.perf__mini--alert {
  border-color: rgba(255, 111, 141, 0.5);
  background: rgba(255, 111, 141, 0.08);
}
.perf__mini-value {
  font-size: 15px;
  color: var(--text);
  font-variant-numeric: tabular-nums;
  font-family: "JetBrainsMono NFM", "CaskaydiaCove NFM", "Fira Code", "Consolas", monospace;
}
.perf__mini-label {
  font-size: 9px;
  color: var(--muted);
  text-transform: uppercase;
  letter-spacing: 0.3px;
}

.perf__top {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.perf__top-row {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 10.5px;
  color: var(--muted);
  padding: 3px 8px;
  background: rgba(var(--tint), 0.03);
  border-radius: 5px;
  font-variant-numeric: tabular-nums;
}
.perf__top-id {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text);
  font-family: "JetBrainsMono NFM", "CaskaydiaCove NFM", "Fira Code", "Consolas", monospace;
}

.perf__table {
  width: 100%;
  border-collapse: collapse;
  font-size: 11px;
}
.perf__table th {
  text-align: left;
  font-weight: 600;
  color: var(--muted);
  text-transform: uppercase;
  font-size: 9.5px;
  letter-spacing: 0.4px;
  padding: 4px 8px;
  border-bottom: 1px solid var(--border);
}
.perf__table td {
  padding: 5px 8px;
  border-bottom: 1px solid rgba(var(--tint), 0.05);
  color: var(--text);
  font-variant-numeric: tabular-nums;
}
.perf__num {
  text-align: right;
  font-family: "JetBrainsMono NFM", "CaskaydiaCove NFM", "Fira Code", "Consolas", monospace;
}
.perf__row--current {
  background: rgba(var(--tint), 0.05);
}
.perf__ptype {
  font-weight: 600;
}
.perf__tag {
  margin-left: 6px;
  font-size: 9px;
  text-transform: uppercase;
  letter-spacing: 0.3px;
  color: var(--accent, #ffa424);
  border: 1px solid rgba(255, 164, 36, 0.4);
  border-radius: 4px;
  padding: 0 4px;
}
.perf__psub {
  color: var(--muted);
  font-size: 10px;
}
</style>
