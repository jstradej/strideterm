<template>
  <div class="td__section">
    <!-- Pipeline flow — horizontal -->
    <div class="td__pipeline">
      <template v-for="(step, i) in pipelineSteps" :key="step.id">
        <div
          v-if="i > 0"
          class="td__pipe-line"
          :class="{ 'td__pipe-line--done': step.lineDone, 'td__pipe-line--active': step.lineActive }"
        ></div>
        <div class="td__pipe-step" :class="step.classes" :title="step.hint">
          <span class="td__pipe-circle">{{ i + 1 }}</span>
          <span class="td__pipe-name">{{ step.label }}</span>
        </div>
      </template>
      <div
        v-if="taskState?.state && taskState.state !== 'idle'"
        class="td__pipe-loop"
        title="If checks fail, worker is re-prompted"
      >
        &#x21A9;
      </div>
    </div>

    <!-- Rounds — horizontal compact chips -->
    <div v-if="roundsChronological.length" class="td__rounds">
      <span class="td__rounds-label">Rounds</span>
      <div
        v-for="round in roundsChronological"
        :key="round.round"
        class="td__rchip"
        :class="[`td__rchip--${roundStatus(round)}`, { 'td__rchip--selected': selectedRound === round.round }]"
        :title="roundTooltip(round)"
        @click="selectedRound = selectedRound === round.round ? null : round.round"
      >
        {{ round.round }}
      </div>
    </div>

    <!-- Selected round detail (click a chip to expand) -->
    <div v-if="selectedRoundData" class="td__round-detail">
      <div class="td__round-detail-header">
        <strong>Round {{ selectedRoundData.round }}</strong>
        <span class="td__round-action" :class="`td__round-action--${selectedRoundData.action}`">{{
          selectedRoundData.action
        }}</span>
        <time class="td__round-time">{{ formatTime(selectedRoundData.startedAt) }}</time>
        <button class="td__round-close" title="Close" @click="selectedRound = null">&times;</button>
      </div>
      <div v-if="selectedRoundData.checks?.length" class="td__checks">
        <div v-for="check in selectedRoundData.checks" :key="check.label" class="td__check">
          <span :class="check.passed ? 'td__check--pass' : 'td__check--fail'">
            {{ check.passed ? "\u2713" : "\u2717" }}
          </span>
          {{ check.label }}
          <span v-if="!check.passed && check.exitCode != null" class="td__check-code">exit {{ check.exitCode }}</span>
        </div>
        <pre v-if="selectedRoundData.checks.some((c) => !c.passed && c.outputTail)" class="td__output">{{
          selectedRoundData.checks
            .filter((c) => !c.passed && c.outputTail)
            .map((c) => c.outputTail)
            .join("\n")
        }}</pre>
      </div>
      <div v-if="selectedRoundData.judgeVerdict" class="td__verdict">
        Judge: <strong>{{ selectedRoundData.judgeVerdict }}</strong>
        <p v-if="selectedRoundData.judgeReason" class="td__verdict-reason">{{ selectedRoundData.judgeReason }}</p>
      </div>
      <table v-if="selectedRoundEntries.length" class="td__activity-table">
        <thead>
          <tr>
            <th class="td__activity-th td__activity-th--time">Time</th>
            <th class="td__activity-th td__activity-th--event">Event</th>
            <th class="td__activity-th td__activity-th--detail">Detail</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="(entry, i) in selectedRoundEntries"
            :key="i"
            class="td__activity-tr"
            :class="`td__activity-tr--${eventCategory(entry.event)}`"
          >
            <td class="td__activity-td td__activity-td--time">{{ formatTime(entry.ts) }}</td>
            <td class="td__activity-td td__activity-td--event">{{ eventLabel(entry.event) }}</td>
            <td class="td__activity-td td__activity-td--detail" :title="entry.detail">{{ entry.detail || "" }}</td>
          </tr>
        </tbody>
      </table>
    </div>

    <div v-if="!roundsChronological.length && !allLogEntries.length" class="td__empty">
      {{
        taskState?.state === "idle"
          ? "Press Start to begin."
          : taskState?.state === "running"
            ? "Worker is processing..."
            : "Waiting for activity..."
      }}
    </div>
  </div>
</template>

<script setup>
import { computed, ref, inject, watch } from "vue";

const props = defineProps({
  taskState: { type: Object, default: null },
  workspaceCwd: { type: String, default: "" },
  taskId: { type: String, default: "" },
});

const api = inject("api");
const selectedRound = ref(null);
const logRaw = ref("");

// ── Rounds ────────────────────────────────────────────────────────
const roundsChronological = computed(() => props.taskState?.rounds || []);

// Auto-select the latest round so the user sees what's happening without
// having to click a chip. User can still click another chip to inspect an
// older round; if they close the detail, we re-open the newest on the next
// round change.
watch(
  roundsChronological,
  (rounds, prev) => {
    if (!rounds.length) {
      selectedRound.value = null;
      return;
    }
    const latest = rounds[rounds.length - 1].round;
    const prevLatest = prev?.length ? prev[prev.length - 1].round : null;
    if (selectedRound.value == null || selectedRound.value === prevLatest) {
      selectedRound.value = latest;
    }
  },
  { immediate: true },
);

const selectedRoundData = computed(() => {
  if (selectedRound.value == null) return null;
  return roundsChronological.value.find((r) => r.round === selectedRound.value) || null;
});

function roundStatus(round) {
  if (round.action === "completed") return "success";
  if (round.action === "failed") return "error";
  if (round.action === "re-prompted") return "warn";
  if (round.action === "judge-requested") return "judge";
  if (round.action === "running" || round.action === "evaluating" || round.action === "shower") return "active";
  return "neutral";
}

function roundTooltip(round) {
  const parts = [`Round ${round.round}`];
  if (round.action) parts.push(round.action);
  if (round.checks?.length) {
    const passed = round.checks.filter((c) => c.passed).length;
    parts.push(`${passed}/${round.checks.length} checks passed`);
  }
  if (round.judgeVerdict) parts.push(`Judge: ${round.judgeVerdict}`);
  if (round.judgeReason) parts.push(round.judgeReason);
  return parts.join("\n");
}

// ── Pipeline ──────────────────────────────────────────────────────
const PIPELINE_ORDER = ["running", "evaluating", "judge-evaluating", "completed"];

function pipelineStatus(stepState) {
  const rawState = props.taskState?.state;
  const state = rawState === "refreshing" ? "running" : rawState;
  if (!state || state === "idle") return "waiting";
  if (state === "failed") {
    if (stepState === "completed") return "failed";
    const stateIdx = PIPELINE_ORDER.indexOf("completed");
    const stepIdx = PIPELINE_ORDER.indexOf(stepState);
    return stepIdx < stateIdx ? "done" : "waiting";
  }
  if (state === "paused" && stepState === "running") return "paused";
  if (state === stepState) return "active";
  const stateIdx = PIPELINE_ORDER.indexOf(state);
  const stepIdx = PIPELINE_ORDER.indexOf(stepState);
  if (stateIdx >= 0 && stepIdx >= 0 && stateIdx > stepIdx) return "done";
  return "waiting";
}

const pipelineSteps = computed(() => {
  const s = props.taskState?.state || "idle";
  const stepsRaw = [
    { id: "worker", label: "Worker", pipeState: "running" },
    { id: "checks", label: "Checks", pipeState: "evaluating" },
    { id: "judge", label: "Judge", pipeState: "judge-evaluating" },
    { id: "done", label: s === "failed" ? "Failed" : "Done", pipeState: "completed" },
  ];

  return stepsRaw.map((step, i) => {
    const status = pipelineStatus(step.pipeState);
    const prevStatus = i > 0 ? pipelineStatus(stepsRaw[i - 1].pipeState) : null;

    const hint =
      step.id === "worker"
        ? s === "refreshing"
          ? "Refreshing context..."
          : s === "running"
            ? "Working..."
            : status === "done"
              ? "Done"
              : "Executes the task"
        : step.id === "checks"
          ? s === "evaluating"
            ? "Running checks..."
            : status === "done"
              ? "Passed"
              : "Automated verification"
          : step.id === "judge"
            ? s === "judge-evaluating"
              ? "Evaluating..."
              : status === "done"
                ? "Reviewed"
                : "Independent review"
            : s === "completed"
              ? "Complete!"
              : s === "failed"
                ? "Max rounds or error"
                : "Task completion";

    return {
      ...step,
      hint,
      classes: { [`td__pipe-step--${status}`]: true },
      lineDone: prevStatus === "done" || prevStatus === "active",
      lineActive: prevStatus === "active",
    };
  });
});

// ── Activity log (compact view of TASK_LOG.jsonl) ─────────────────
// The full log lives in the Log tab; Status shows a tail so the user sees
// what's happening from the moment the task starts without switching tabs.
const EVENT_LABELS = {
  "task-started": "Task started",
  "task-stopped": "Task stopped",
  "task-paused": "Task paused",
  "task-resumed": "Task resumed",
  "task-reset": "Task reset",
  "task-completed": "Task completed",
  "task-failed": "Task failed",
  "evaluation-complete": "Checks finished",
  "worker-reprompted": "Worker re-prompted",
  "judge-requested": "Judge requested",
  "judge-verdict": "Judge verdict",
  "judge-nudged": "Judge nudged",
  "shower-started": "Context refresh",
  "shower-completed": "Refresh done",
  "shower-failed": "Refresh failed",
  "worker-idle-detected": "Worker idle",
  "verdict-rejected": "User rejected verdict",
};

function eventLabel(event) {
  return EVENT_LABELS[event] || event;
}

function eventCategory(event) {
  if (event === "task-completed") return "success";
  if (event === "task-failed" || event === "shower-failed") return "error";
  if (event.startsWith("judge-")) return "judge";
  if (event.startsWith("shower-")) return "shower";
  if (event === "worker-reprompted" || event === "verdict-rejected") return "warn";
  return "info";
}

async function loadLog() {
  if (!api || !props.workspaceCwd || !props.taskId) return;
  try {
    const result = await api.fileRead({
      rootPath: props.workspaceCwd,
      relativePath: `.strideterm/tasks/${props.taskId}/TASK_LOG.jsonl`,
    });
    logRaw.value = result?.content ?? "";
  } catch {
    logRaw.value = "";
  }
}

const allLogEntries = computed(() => {
  if (!logRaw.value) return [];
  return logRaw.value
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
});

// Filter log entries by the selected round's time window. The backend's
// `round` field on each entry is `task.currentRound || 0`, which jumps at
// different points in the eval pipeline and doesn't cleanly map to round
// chips. A time window between `round.startedAt` and the next round's
// `startedAt` is an accurate, backend-agnostic mapping.
const selectedRoundEntries = computed(() => {
  const r = selectedRoundData.value;
  if (!r?.startedAt) return [];
  const rounds = roundsChronological.value;
  const idx = rounds.findIndex((x) => x.round === r.round);
  const startMs = Date.parse(r.startedAt);
  if (Number.isNaN(startMs)) return [];
  const next = rounds[idx + 1];
  const endMs = next?.startedAt ? Date.parse(next.startedAt) : Infinity;
  return allLogEntries.value.filter((e) => {
    const ts = Date.parse(e.ts);
    return !Number.isNaN(ts) && ts >= startMs && ts < endMs;
  });
});

watch(
  () => props.taskState?.state,
  () => loadLog(),
);
watch(
  () => props.taskState?.currentRound,
  () => loadLog(),
);
watch(
  () => props.taskState?.rounds?.length,
  () => loadLog(),
);
watch(
  () => props.taskId,
  (id) => {
    if (id) loadLog();
  },
  { immediate: true },
);

// ── Helpers ───────────────────────────────────────────────────────
function formatTime(iso) {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleTimeString();
  } catch {
    return iso;
  }
}
</script>

<style scoped>
.td__empty {
  opacity: 0.5;
  padding: 24px 0;
  text-align: center;
}

/* ── Horizontal pipeline ──────────────────────────────────────── */
.td__pipeline {
  display: flex;
  align-items: flex-start;
  padding: 8px 0 10px;
  margin-bottom: 4px;
  border-bottom: 1px solid var(--border, #333);
}
.td__pipe-step {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 3px;
  flex-shrink: 0;
}
.td__pipe-circle {
  width: 26px;
  height: 26px;
  border-radius: 50%;
  display: grid;
  place-items: center;
  font-size: 11px;
  font-weight: 700;
  background: #333;
  color: #666;
  flex-shrink: 0;
  transition:
    background 0.2s,
    color 0.2s,
    box-shadow 0.2s;
}
.td__pipe-name {
  font-size: 10px;
  font-weight: 600;
  color: #666;
  transition: color 0.2s;
}
.td__pipe-line {
  flex: 1;
  height: 2px;
  min-width: 16px;
  max-width: 48px;
  background: #333;
  margin: 12px 2px 0; /* vertically center with circles */
  transition: background 0.2s;
}
.td__pipe-line--done {
  background: #4a7c4e;
}
.td__pipe-line--active {
  background: linear-gradient(to right, #4caf50, #333);
}

/* Step states */
.td__pipe-step--waiting .td__pipe-circle {
  background: #333;
  color: #666;
}
.td__pipe-step--active .td__pipe-circle {
  background: #4caf50;
  color: #fff;
  box-shadow: 0 0 8px rgba(76, 175, 80, 0.5);
  animation: pipe-pulse 1.5s ease-in-out infinite;
}
.td__pipe-step--active .td__pipe-name {
  color: #a5d6a7;
}
.td__pipe-step--done .td__pipe-circle {
  background: #2e7d32;
  color: #c8e6c9;
}
.td__pipe-step--done .td__pipe-name {
  color: #81c784;
}
.td__pipe-step--paused .td__pipe-circle {
  background: #7b1fa2;
  color: #e1bee7;
}
.td__pipe-step--paused .td__pipe-name {
  color: #ce93d8;
}
.td__pipe-step--failed .td__pipe-circle {
  background: #c62828;
  color: #ffcdd2;
}
.td__pipe-step--failed .td__pipe-name {
  color: #e57373;
}
@keyframes pipe-pulse {
  0%,
  100% {
    box-shadow: 0 0 8px rgba(76, 175, 80, 0.5);
  }
  50% {
    box-shadow: 0 0 2px rgba(76, 175, 80, 0.2);
  }
}

/* Re-prompt loop indicator */
.td__pipe-loop {
  margin: 6px 0 0 8px;
  opacity: 0.3;
  font-size: 16px;
  color: #888;
  cursor: help;
}

/* ── Rounds — horizontal chips ────────────────────────────────── */
.td__rounds {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 0 8px;
  margin-bottom: 4px;
  border-bottom: 1px solid var(--border, #333);
  flex-wrap: wrap;
}
.td__rounds-label {
  font-size: 10px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: #666;
  margin-right: 2px;
}
.td__rchip {
  width: 24px;
  height: 24px;
  border-radius: 50%;
  display: grid;
  place-items: center;
  font-size: 10px;
  font-weight: 700;
  cursor: pointer;
  transition:
    background 0.15s,
    color 0.15s,
    box-shadow 0.15s;
  background: #333;
  color: #888;
}
.td__rchip:hover {
  box-shadow: 0 0 0 2px rgba(255, 255, 255, 0.15);
}
.td__rchip--selected {
  box-shadow: 0 0 0 2px var(--accent, #ffa424);
}
.td__rchip--success {
  background: #2e7d32;
  color: #c8e6c9;
}
.td__rchip--error {
  background: #c62828;
  color: #ffcdd2;
}
.td__rchip--warn {
  background: #e65100;
  color: #ffcc80;
}
.td__rchip--judge {
  background: #283593;
  color: #9fa8da;
}
.td__rchip--active {
  background: #4caf50;
  color: #fff;
  box-shadow: 0 0 6px rgba(76, 175, 80, 0.5);
  animation: rchip-pulse 1.5s ease-in-out infinite;
}
@keyframes rchip-pulse {
  0%,
  100% {
    box-shadow: 0 0 6px rgba(76, 175, 80, 0.5);
  }
  50% {
    box-shadow: 0 0 2px rgba(76, 175, 80, 0.2);
  }
}
.td__rchip--neutral {
  background: #444;
  color: #999;
}

/* ── Selected round detail (expandable) ───────────────────────── */
.td__round-detail {
  border: 1px solid var(--border, #333);
  border-radius: 6px;
  padding: 8px 12px;
  margin-bottom: 8px;
  background: rgba(255, 255, 255, 0.02);
}
.td__round-detail-header {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 4px;
}
.td__round-close {
  margin-left: auto;
  background: none;
  border: none;
  color: #888;
  font-size: 16px;
  cursor: pointer;
  padding: 0 4px;
  line-height: 1;
}
.td__round-close:hover {
  color: var(--fg, #ccc);
}
.td__round-action {
  font-size: 10px;
  font-weight: 600;
  text-transform: uppercase;
  padding: 1px 5px;
  border-radius: 3px;
}
.td__round-action--re-prompted {
  background: #e65100;
  color: #ffcc80;
}
.td__round-action--judge-requested {
  background: #1a237e;
  color: #9fa8da;
}
.td__round-action--running,
.td__round-action--evaluating,
.td__round-action--shower {
  background: #1b5e20;
  color: #a5d6a7;
}
.td__round-action--completed {
  background: #004d40;
  color: #80cbc4;
}
.td__round-action--failed {
  background: #b71c1c;
  color: #ef9a9a;
}
.td__round-time {
  font-size: 11px;
  opacity: 0.5;
}
.td__checks {
  margin-top: 4px;
}
.td__check {
  margin-bottom: 2px;
}
.td__check--pass {
  color: #81c784;
}
.td__check--fail {
  color: #e57373;
}
.td__check-code {
  font-size: 11px;
  opacity: 0.5;
  margin-left: 4px;
}
.td__output {
  background: rgba(0, 0, 0, 0.3);
  padding: 8px;
  border-radius: 4px;
  font-size: 11px;
  line-height: 1.4;
  max-height: 120px;
  overflow-y: auto;
  white-space: pre-wrap;
  word-break: break-all;
  margin-top: 6px;
}
.td__verdict {
  margin-top: 6px;
  font-size: 12px;
  opacity: 0.8;
}
.td__verdict-reason {
  margin: 4px 0 0;
  font-size: 11px;
  opacity: 0.6;
  line-height: 1.4;
  white-space: pre-wrap;
  word-break: break-word;
}

/* ── Per-round activity table ─────────────────────────────────── */
.td__activity-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 11px;
  line-height: 1.4;
  table-layout: fixed;
  margin-top: 8px;
}
.td__activity-th {
  text-align: left;
  font-size: 10px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.03em;
  color: #666;
  padding: 3px 6px;
  border-bottom: 1px solid var(--border, #333);
  white-space: nowrap;
}
.td__activity-th--time {
  width: 72px;
}
.td__activity-th--event {
  width: 140px;
}
.td__activity-td {
  padding: 3px 6px;
  vertical-align: top;
  border-left: 2px solid #444;
}
.td__activity-td--time {
  color: #666;
  font-family: monospace;
  font-size: 10px;
  white-space: nowrap;
}
.td__activity-td--event {
  font-weight: 600;
  white-space: nowrap;
}
.td__activity-td--detail {
  opacity: 0.7;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.td__activity-tr--success .td__activity-td:first-child {
  border-left-color: #4caf50;
}
.td__activity-tr--success .td__activity-td--event {
  color: #81c784;
}
.td__activity-tr--error .td__activity-td:first-child {
  border-left-color: #e57373;
}
.td__activity-tr--error .td__activity-td--event {
  color: #e57373;
}
.td__activity-tr--judge .td__activity-td:first-child {
  border-left-color: #7c4dff;
}
.td__activity-tr--judge .td__activity-td--event {
  color: #b39ddb;
}
.td__activity-tr--warn .td__activity-td:first-child {
  border-left-color: #ff9800;
}
.td__activity-tr--warn .td__activity-td--event {
  color: #ffcc80;
}
.td__activity-tr--shower .td__activity-td:first-child {
  border-left-color: #29b6f6;
}
.td__activity-tr--shower .td__activity-td--event {
  color: #81d4fa;
}
.td__activity-tr--info .td__activity-td:first-child {
  border-left-color: #555;
}
.td__activity-td:not(:first-child) {
  border-left: none;
}
</style>
