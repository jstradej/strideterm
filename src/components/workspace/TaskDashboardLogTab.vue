<template>
  <div class="td__section">
    <div v-if="!logEntries.length" class="td__log-empty">
      {{ taskState?.state === "idle" ? "No events yet." : "Events appear here during task execution..." }}
    </div>
    <template v-else>
      <div class="td__log-toolbar">
        <span class="td__log-count">{{ logEntries.length }} events</span>
        <div class="td__log-actions">
          <button class="td__log-btn" title="Copy log to clipboard" @click="copyLog">
            {{ copyFeedback || "Copy" }}
          </button>
          <button class="td__log-btn" title="Save log as text file" @click="saveLog">Save</button>
        </div>
      </div>
      <table class="td__log-table">
        <thead>
          <tr>
            <th class="td__log-th td__log-th--time">Time</th>
            <th class="td__log-th td__log-th--event">Event</th>
            <th class="td__log-th td__log-th--round">R</th>
            <th class="td__log-th td__log-th--detail">Detail</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="(entry, i) in logEntries"
            :key="i"
            class="td__log-row"
            :class="`td__log-row--${eventCategory(entry.event)}`"
          >
            <td class="td__log-td td__log-td--time">{{ formatTime(entry.ts) }}</td>
            <td class="td__log-td td__log-td--event">{{ eventLabel(entry.event) }}</td>
            <td class="td__log-td td__log-td--round">{{ entry.round || "" }}</td>
            <td class="td__log-td td__log-td--detail" :title="entry.detail">{{ entry.detail || "" }}</td>
          </tr>
        </tbody>
      </table>
    </template>
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
const logRaw = ref("");
const copyFeedback = ref("");

// ── Event log from TASK_LOG.jsonl ─────────────────────────────────
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

const logEntries = computed(() => {
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
  "shower-started": "Context refresh",
  "shower-completed": "Refresh done",
  "shower-failed": "Refresh failed",
  "worker-idle-detected": "Worker idle detected",
};

function eventLabel(event) {
  return EVENT_LABELS[event] || event;
}

function eventCategory(event) {
  if (event === "task-completed") return "success";
  if (event === "task-failed" || event === "shower-failed") return "error";
  if (event.startsWith("judge-")) return "judge";
  if (event.startsWith("shower-")) return "shower";
  if (event === "worker-reprompted") return "warn";
  return "info";
}

watch(
  () => props.taskState?.state,
  () => loadLog(),
);
watch(
  () => props.taskState?.currentRound,
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

// ── Log export ────────────────────────────────────────────────────
function formatLogText() {
  return logEntries.value
    .map((entry) => {
      const time = formatTime(entry.ts);
      const label = eventLabel(entry.event);
      const round = entry.round ? `R${entry.round}` : "";
      const detail = entry.detail || "";
      return [time, label, round, detail].filter(Boolean).join("  ");
    })
    .join("\n");
}

async function copyLog() {
  try {
    await navigator.clipboard.writeText(formatLogText());
    copyFeedback.value = "Copied!";
  } catch {
    copyFeedback.value = "Failed";
  }
  setTimeout(() => {
    copyFeedback.value = "";
  }, 2000);
}

function saveLog() {
  const text = formatLogText();
  const blob = new Blob([text], { type: "text/plain" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `task-log-${props.taskId || "export"}.txt`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
</script>

<style scoped>
.td__log-empty {
  opacity: 0.5;
  padding: 24px 0;
  text-align: center;
}
.td__log-toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}
.td__log-count {
  font-size: 11px;
  opacity: 0.5;
}
.td__log-actions {
  margin-left: auto;
  display: flex;
  gap: 4px;
}
.td__log-btn {
  background: rgba(255, 255, 255, 0.06);
  border: 1px solid rgba(255, 255, 255, 0.1);
  color: #aaa;
  font-size: 10px;
  padding: 2px 8px;
  border-radius: 3px;
  cursor: pointer;
  min-width: 42px;
  text-align: center;
  transition:
    background 0.15s,
    color 0.15s;
}
.td__log-btn:hover {
  background: rgba(255, 255, 255, 0.1);
  color: #ddd;
}

/* ── Table ────────────────────────────────────────────────────── */
.td__log-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 11px;
  line-height: 1.4;
  table-layout: fixed;
}
.td__log-th {
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
.td__log-th--time {
  width: 72px;
}
.td__log-th--event {
  width: 120px;
}
.td__log-th--round {
  width: 28px;
  text-align: center;
}
.td__log-th--detail {
  /* takes remaining space */
}
.td__log-td {
  padding: 3px 6px;
  vertical-align: top;
}
.td__log-td--time {
  color: #666;
  font-family: monospace;
  font-size: 10px;
  white-space: nowrap;
}
.td__log-td--event {
  font-weight: 600;
  white-space: nowrap;
}
.td__log-td--round {
  text-align: center;
  font-size: 10px;
  opacity: 0.5;
}
.td__log-td--detail {
  opacity: 0.7;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.td__log-row {
  border-left: 2px solid #444;
}
.td__log-row--success {
  border-left-color: #4caf50;
}
.td__log-row--success .td__log-td--event {
  color: #81c784;
}
.td__log-row--error {
  border-left-color: #e57373;
}
.td__log-row--error .td__log-td--event {
  color: #e57373;
}
.td__log-row--judge {
  border-left-color: #7c4dff;
}
.td__log-row--judge .td__log-td--event {
  color: #b39ddb;
}
.td__log-row--warn {
  border-left-color: #ff9800;
}
.td__log-row--warn .td__log-td--event {
  color: #ffcc80;
}
.td__log-row--shower {
  border-left-color: #29b6f6;
}
.td__log-row--shower .td__log-td--event {
  color: #81d4fa;
}
.td__log-row--info {
  border-left-color: #555;
}
</style>
