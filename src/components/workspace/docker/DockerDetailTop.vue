<template>
  <div class="top">
    <div class="top__toolbar">
      <button type="button" class="button button--ghost button--sm" :disabled="loading" @click="reload">
        {{ loading ? "Loading…" : "Refresh" }}
      </button>
      <span v-if="rows.length > 0" class="top__count">{{ rows.length }} processes</span>
      <span v-if="error" class="top__error">{{ error }}</span>
    </div>
    <div class="top__body">
      <div v-if="loading" class="top__loading">
        <Spinner size="md" />
        <span>Reading processes…</span>
      </div>
      <table v-else-if="rows.length > 0" class="top__table">
        <thead>
          <tr>
            <th v-for="h in header" :key="h" :title="columnTooltip(h)">{{ h }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(row, idx) in rows" :key="idx">
            <td v-for="(cell, ci) in row" :key="ci" :title="cellTooltip(header[ci], cell)">{{ cell }}</td>
          </tr>
        </tbody>
      </table>
      <div v-else class="top__empty">
        {{ error ? "Failed to read processes." : "Container is not running, or no processes returned." }}
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, watch } from "vue";
import Spinner from "../../common/Spinner.vue";
import { useAppStore } from "../../../stores/app.js";

const props = defineProps<{
  containerId: string;
  backendId: string;
  contextName: string;
  /** Test hook: when provided, use this string as the raw `docker top` output. */
  mockOutput?: string;
}>();

const appStore = useAppStore();
const loading = ref(false);
const error = ref<string>("");
const header = ref<string[]>([]);
const rows = ref<string[][]>([]);

/**
 * Native hover tooltip text for each column of `docker top`. The exact set of
 * columns depends on the host OS (Linux ps vs BusyBox ps), but the union of
 * common headers is small enough to inline. Unknown columns just fall through
 * to showing the header name verbatim.
 */
const COLUMN_TOOLTIPS: Record<string, string> = {
  UID: "User ID (or name) the process runs as",
  USER: "User name the process runs as",
  PID: "Process ID inside the container's PID namespace",
  PPID: "Parent process ID",
  C: "CPU utilization — integer percentage of CPU time used",
  "%CPU": "CPU usage as a percentage",
  "%MEM": "Memory usage as a percentage of the container limit",
  PRI: "Scheduling priority",
  NI: "Nice value (lower = higher scheduling priority)",
  STIME: "Time the process was started",
  START: "Time the process was started",
  TTY: "Controlling terminal, '?' for none",
  TIME: "Total CPU time consumed since start (HH:MM:SS)",
  CMD: "Full command line with arguments",
  COMMAND: "Full command line with arguments",
  VSZ: "Virtual memory size (KiB)",
  RSS: "Resident set size — physical memory currently used (KiB)",
  STAT: "Process state code (R running, S sleep, Z zombie, …)",
  WCHAN: "Kernel function the process is waiting in, '-' if running",
  ELAPSED: "Wall-clock time since process start",
};

function columnTooltip(name: string): string {
  return COLUMN_TOOLTIPS[name] ?? name;
}

/**
 * Per-cell tooltip — repeats the cell value so long CMDs that overflow the
 * column show on hover, and adds the column meaning for context. Empty cells
 * skip the tooltip so we don't surface a bare description for missing data.
 */
function cellTooltip(columnName: string | undefined, value: string): string {
  if (!value || !value.trim()) return "";
  const desc = columnName ? COLUMN_TOOLTIPS[columnName] : null;
  return desc ? `${columnName}: ${desc}\n\n${value}` : value;
}

async function reload(): Promise<void> {
  loading.value = true;
  error.value = "";
  try {
    const raw = props.mockOutput ?? (await appStore.dockerTop(props.containerId, props.backendId, props.contextName));
    const parsed = parseTop(raw);
    header.value = parsed.header;
    rows.value = parsed.rows;
  } catch (e) {
    error.value = (e as Error)?.message || String(e);
    header.value = [];
    rows.value = [];
  } finally {
    loading.value = false;
  }
}

function parseTop(text: string): { header: string[]; rows: string[][] } {
  // `docker top <id>` returns space-padded columns: e.g.
  //   UID    PID    PPID    C    STIME    TTY    TIME    CMD
  //   root   1234   1233    0    10:00    ?      00:00:01 /bin/sh
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) return { header: [], rows: [] };

  // Detect column starts from the header line (run of non-space then space).
  const headerLine = lines[0];
  const cols: number[] = [];
  let inWord = false;
  for (let i = 0; i < headerLine.length; i++) {
    const ch = headerLine[i];
    if (ch !== " " && !inWord) {
      cols.push(i);
      inWord = true;
    } else if (ch === " ") {
      inWord = false;
    }
  }

  function splitAt(line: string, starts: number[]): string[] {
    const out: string[] = [];
    for (let i = 0; i < starts.length; i++) {
      const s = starts[i];
      const e = i + 1 < starts.length ? starts[i + 1] : line.length;
      out.push((line.slice(s, e) ?? "").trim());
    }
    return out;
  }

  const head = splitAt(headerLine, cols);
  // For the last column (typically CMD), prefer the full tail so command args
  // aren't truncated by an inferred fixed width.
  const body = lines.slice(1).map((l) => {
    const parts = splitAt(l, cols);
    if (cols.length > 0) {
      const lastStart = cols[cols.length - 1];
      parts[parts.length - 1] = (l.slice(lastStart) ?? "").trim();
    }
    return parts;
  });
  return { header: head, rows: body };
}

onMounted(() => {
  reload();
});

watch(
  () => [props.containerId, props.mockOutput],
  () => reload(),
);
</script>

<style scoped>
.top {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  background: #141416;
}

.top__toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  border-bottom: 1px solid var(--border-color, rgba(255, 255, 255, 0.06));
  flex-shrink: 0;
}

.top__count {
  font-size: 11px;
  color: var(--text-dim, #888);
}

.top__error {
  color: var(--color-error, #fc8181);
  font-size: 12px;
}

.top__body {
  flex: 1 1 auto;
  min-height: 0;
  overflow: auto;
  -webkit-overflow-scrolling: touch;
}

.top__loading,
.top__empty {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  padding: 30px;
  color: var(--text-dim, #888);
  font-size: 13px;
}

.top__table {
  width: 100%;
  border-collapse: collapse;
  font-family: "JetBrainsMono NFM", "CaskaydiaCove NFM", "Fira Code", "Consolas", monospace;
  font-size: 12px;
}

.top__table th {
  position: sticky;
  top: 0;
  text-align: left;
  font-weight: 600;
  color: var(--text-dim, #aaa);
  background: #1a1a1d;
  padding: 6px 10px;
  border-bottom: 1px solid var(--border-color, rgba(255, 255, 255, 0.08));
  white-space: nowrap;
}

.top__table td {
  padding: 4px 10px;
  color: #d8e4f5;
  white-space: nowrap;
}

.top__table tbody tr:nth-child(odd) {
  background: rgba(255, 255, 255, 0.025);
}

.top__table tbody td:last-child {
  white-space: normal;
  word-break: break-all;
}

.button--sm {
  font-size: 11px;
  padding: 2px 8px;
}
</style>
