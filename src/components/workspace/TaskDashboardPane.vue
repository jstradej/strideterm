<template>
  <div
    class="workspace-pane__body workspace-pane__body--task-dashboard"
    :class="{ 'workspace-pane__body--compact': compact }"
  >
    <div class="td" :class="{ 'td--compact': compact }">
      <!-- Header with controls -->
      <div class="td__header">
        <div class="td__title">
          <h2>{{ taskState?.description || "Task workspace" }}</h2>
          <span class="td__badge" :class="`td__badge--${taskState?.state || 'idle'}`">
            {{ stateLabel }}
          </span>
          <span v-if="['running', 'evaluating', 'refreshing'].includes(taskState?.state)" class="td__round">
            Round {{ taskState?.currentRound || 0 }}/{{ taskState?.maxRounds || 10 }}
          </span>
          <span v-if="taskState?.startedAt && taskState.state !== 'idle'" class="td__elapsed" :title="elapsedTitle">
            {{ elapsedFormatted }}
          </span>
        </div>
        <div class="td__controls">
          <button
            v-if="taskState?.state === 'idle'"
            class="button button--sm"
            title="Begin the task — sends prompt to Worker and starts the automation loop"
            @click="onStartWithBrief(statusTabRef?.briefDraft?.value)"
          >
            Start
          </button>
          <button
            v-if="taskState?.state === 'paused' || taskState?.state === 'completed' || taskState?.state === 'failed'"
            class="button button--sm"
            title="Resume the task from where it left off — keeps round history and progress"
            @click="onStart"
          >
            Continue
          </button>
          <button
            v-if="
              taskState?.state === 'running' ||
              taskState?.state === 'evaluating' ||
              taskState?.state === 'judge-evaluating' ||
              taskState?.state === 'refreshing'
            "
            class="button button--ghost button--sm"
            title="Pause the task — you can Continue or Reset afterwards"
            @click="onStop"
          >
            Pause
          </button>
          <button
            v-if="taskState?.state === 'completed' || taskState?.state === 'failed'"
            class="button button--ghost button--sm"
            title="Override the verdict and send the Worker back with your own feedback"
            @click="onRejectVerdict"
          >
            Send back
          </button>
          <button
            v-if="taskState?.state === 'paused' || taskState?.state === 'completed' || taskState?.state === 'failed'"
            class="button button--ghost button--sm"
            title="Clear all rounds and return to idle — edit the brief in the Task tab, then press Start"
            @click="onReset"
          >
            Reset
          </button>
        </div>
      </div>

      <!-- Tab bar -->
      <div class="td__tabs">
        <button
          v-for="t in tabs"
          :key="t.id"
          class="td__tab"
          :class="{ 'td__tab--active': activeTab === t.id }"
          @click="activeTab = t.id"
        >
          {{ t.label }}
        </button>
      </div>

      <!-- Tab content -->
      <div class="td__body">
        <TaskDashboardHelpTab v-if="activeTab === 'help'" :task-id="taskState?.taskId" />

        <TaskDashboardStatusTab
          v-if="activeTab === 'status'"
          ref="statusTabRef"
          :task-state="taskState"
          :workspace-cwd="workspace?.cwd || ''"
          :task-id="taskState?.taskId || ''"
          :worker-provider-label="workerProviderLabel"
          :judge-provider-label="judgeProviderLabel"
          @start="onStartWithBrief"
          @open-assignment="openAssignment"
          @open-config="activeTab = 'config'"
        />

        <TaskDashboardFilesTab
          v-if="activeTab === 'files'"
          :task-files="files.taskFiles.value"
          :active-file="files.activeFile.value"
          :active-file-content="files.activeFileContent.value"
          :active-file-dirty="files.activeFileDirty.value"
          :editor-language="files.editorLanguage.value"
          :file-loading="files.fileLoading.value"
          :file-error="files.fileError.value"
          :file-save-status="files.fileSaveStatus.value"
          @switch-file="files.switchFile"
          @mark-dirty="files.markFileDirty"
          @save="files.saveActiveFile"
          @reload="files.reloadActiveFile"
          @update:active-file-content="(v) => (files.activeFileContent.value = v)"
        />

        <TaskDashboardLogTab
          v-if="activeTab === 'log'"
          :task-state="taskState"
          :workspace-cwd="workspace?.cwd || ''"
          :task-id="taskState?.taskId || ''"
        />

        <!-- CONFIG tab (small — stays inline) -->
        <div v-if="activeTab === 'config'" class="td__section">
          <label class="td__field">
            <span>Task description</span>
            <div class="td__value">{{ taskState?.description || "(none — instruct the Worker directly)" }}</div>
          </label>
          <label class="td__field">
            <span>Max rounds</span>
            <div class="td__value">{{ taskState?.maxRounds || 10 }}</div>
          </label>
          <label v-if="taskState?.worktreeBase" class="td__field">
            <span>Git worktree</span>
            <div class="td__value">
              Branch <code>{{ taskState.worktreeBranch }}</code> from
              <code>{{ taskState.worktreeBase }}</code>
            </div>
          </label>
          <label class="td__field">
            <span>Worker agent</span>
            <div class="td__value">{{ workerProviderLabel }}</div>
          </label>
          <label class="td__field">
            <span>Judge agent</span>
            <div class="td__value">{{ judgeProviderLabel }}</div>
          </label>
          <label class="td__field">
            <span>Verification</span>
            <div class="td__value">
              Defined in the &ldquo;Verification before completion&rdquo; section of the <strong>Task</strong> brief
              &mdash;
              <button
                class="td__link-btn"
                @click="
                  activeTab = 'files';
                  files.switchFile('TASK.md');
                "
              >
                edit in Assignment tab
              </button>
            </div>
          </label>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, inject, watch, onUnmounted } from "vue";
import { useAppStore } from "../../stores/app.js";
import { useTaskFiles } from "../../composables/useTaskFiles.js";
import TaskDashboardHelpTab from "./TaskDashboardHelpTab.vue";
import TaskDashboardStatusTab from "./TaskDashboardStatusTab.vue";
import TaskDashboardFilesTab from "./TaskDashboardFilesTab.vue";
import TaskDashboardLogTab from "./TaskDashboardLogTab.vue";

withDefaults(defineProps<{ workspaceId: string; showHeader?: boolean; compact?: boolean }>(), {
  showHeader: false,
  compact: false,
});

const store = useAppStore();
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const api = inject<any>("api");
const activeTab = ref<string>("status");
const statusTabRef = ref<InstanceType<typeof TaskDashboardStatusTab> | null>(null);

const tabs = [
  { id: "status", label: "Status" },
  { id: "files", label: "Assignment" },
  { id: "config", label: "Config" },
  { id: "log", label: "Log" },
  { id: "help", label: "Help" },
];

const workspace = computed(() => store.activeWorkspace);
const taskState = computed(() => workspace.value?.task || null);

// File editing — delegated to composable
const files = useTaskFiles(api, workspace, taskState);

const PROVIDER_DISPLAY_NAMES = {
  claude: "Claude Code",
  codex: "Codex CLI",
  gemini: "Gemini CLI",
  copilot: "GitHub Copilot",
  opencode: "OpenCode",
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function providerLabel(config: Record<string, any> | null | undefined) {
  if (!config) return "Claude Code (sonnet)";
  const name = (PROVIDER_DISPLAY_NAMES as Record<string, string>)[config.providerId] || config.providerId;
  return config.model ? `${name} (${config.model})` : name;
}

const workerProviderLabel = computed(() => providerLabel(taskState.value?.workerProviderConfig));
const judgeProviderLabel = computed(() => providerLabel(taskState.value?.judgeProviderConfig));

const stateLabel = computed(() => {
  const s = taskState.value?.state;
  if (s === "running") return "Running";
  if (s === "evaluating") return "Evaluating";
  if (s === "judge-evaluating") return "Judge evaluating";
  if (s === "refreshing") return "Refreshing context";
  if (s === "completed") return "Completed";
  if (s === "failed") return "Failed";
  if (s === "paused") return "Paused";
  return "Idle";
});

// ── Elapsed timer ───────────────────────────────────────────────
const ACTIVE_STATES = new Set(["running", "evaluating", "judge-evaluating", "refreshing"]);
const elapsedMs = ref(0);
let elapsedTimer: ReturnType<typeof setInterval> | null = null;

function updateElapsed() {
  const ts = taskState.value;
  if (!ts?.startedAt) {
    elapsedMs.value = 0;
    return;
  }
  const paused = ts.totalPausedMs || 0;
  if (ts.finishedAt) {
    elapsedMs.value = ts.finishedAt - ts.startedAt - paused;
  } else if (ts.pausedAt) {
    elapsedMs.value = ts.pausedAt - ts.startedAt - paused;
  } else {
    elapsedMs.value = Date.now() - ts.startedAt - paused;
  }
}

function startElapsedTimer() {
  stopElapsedTimer();
  updateElapsed();
  elapsedTimer = setInterval(updateElapsed, 1000);
}

function stopElapsedTimer() {
  if (elapsedTimer) {
    clearInterval(elapsedTimer);
    elapsedTimer = null;
  }
}

watch(
  () => taskState.value?.state,
  (state) => {
    if (ACTIVE_STATES.has(state)) {
      startElapsedTimer();
    } else {
      updateElapsed();
      stopElapsedTimer();
    }
  },
  { immediate: true },
);

onUnmounted(stopElapsedTimer);

const elapsedFormatted = computed(() => {
  const ms = elapsedMs.value;
  if (ms <= 0) return "";
  const totalSecs = Math.floor(ms / 1000);
  const h = Math.floor(totalSecs / 3600);
  const m = Math.floor((totalSecs % 3600) / 60);
  const s = totalSecs % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`;
  if (m > 0) return `${m}:${String(s).padStart(2, "0")}`;
  return `${s}s`;
});

const elapsedTitle = computed(() => {
  const ts = taskState.value;
  if (!ts?.startedAt) return "";
  const started = new Date(ts.startedAt).toLocaleTimeString();
  if (ts.finishedAt) {
    const ended = new Date(ts.finishedAt).toLocaleTimeString();
    return `Started ${started}, ended ${ended}`;
  }
  return `Started ${started}`;
});

// Auto-switch to Status tab when task starts running
watch(
  () => taskState.value?.state,
  (state, prev) => {
    if (state === "running" && (!prev || prev === "idle")) {
      activeTab.value = "status";
    }
  },
);

// Auto-load first file when switching to Files tab
watch(activeTab, (tab) => {
  if (tab === "files" && !(files.activeFile.value in files.fileContents.value)) {
    files.loadFile(files.activeFile.value);
  }
});

function wsId(): string | undefined {
  return workspace.value?.id;
}

function openAssignment() {
  activeTab.value = "files";
  files.switchFile("TASK.md");
}

// Hero "Start" carries the textarea contents (always — the textarea is
// initialized from state.description). Persist the brief via the same IPC
// Telegram uses (writes TASK.md and updates state.description), but only
// when it actually differs from the persisted description — pressing Start
// without edits should not trigger a redundant disk write or broadcast.
async function onStartWithBrief(brief?: string) {
  const id = wsId();
  const trimmed = (brief || "").trim();
  const current = (taskState.value?.description || "").trim();
  if (api && id && trimmed && trimmed !== current) {
    try {
      const r = await api.updateTaskDescription({ workspaceId: id, description: trimmed });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const payload = (r as any)?.payload;
      if (payload) store.handleBroadcastPayload(payload);
    } catch (err) {
      console.error("[task-dashboard] save brief before start failed:", err);
      return;
    }
  }
  await onStart();
}

async function onStart() {
  const id = wsId();
  if (!api || !id) return;
  try {
    const s = taskState.value?.state;
    if (s === "paused" || s === "completed" || s === "failed") {
      const r = await api.resumeTask({ workspaceId: id });
      if (r?.payload) store.handleBroadcastPayload(r.payload);
    } else {
      await store.startTaskWithHookCheck(id);
    }
    activeTab.value = "status";
  } catch (err) {
    console.error("[task-dashboard] start/resume failed:", err);
  }
}

async function onStop() {
  const id = wsId();
  if (!api || !id) return;
  try {
    const r = await api.stopTask({ workspaceId: id });
    if (r?.payload) store.handleBroadcastPayload(r.payload);
  } catch (err) {
    console.error("[task-dashboard] stop failed:", err);
  }
}

async function onReset() {
  const id = wsId();
  if (!api || !id) return;
  try {
    const r = await api.resetTask({ workspaceId: id });
    if (r?.payload) store.handleBroadcastPayload(r.payload);
    // Hop to Status so the hero shows up — its inline textarea is the natural
    // place to tweak the brief before the next run. Pre-hero this jumped to
    // Files (Assignment) because that was the only editable surface; Status
    // makes more sense now that editing lives there too.
    activeTab.value = "status";
  } catch (err) {
    console.error("[task-dashboard] reset failed:", err);
  }
}

function onRejectVerdict() {
  const id = wsId();
  if (!api || !id) return;
  const verdictLabel = taskState.value?.state === "failed" ? "Max rounds reached" : "Judge said complete";
  store.openDialog("TextAreaDialog", {
    eyebrow: "Task runner",
    title: "Send Worker back with feedback",
    label: `${verdictLabel} — describe what's still missing so the Worker runs one more round:`,
    placeholder:
      "e.g. The CLAUDE.md section on git polling was not updated; UC-12 auto-dismiss is still not wired to the snapshot watcher.",
    submitLabel: "Send back",
    onCancel: () => store.closeDialog(),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    onSubmit: async (feedback: any) => {
      try {
        const r = await api.rejectTaskVerdict({ workspaceId: id, feedback });
        if (r?.payload) store.handleBroadcastPayload(r.payload);
        activeTab.value = "status";
      } catch (err) {
        console.error("[task-dashboard] reject verdict failed:", err);
      } finally {
        store.closeDialog();
      }
    },
  });
}
</script>

<style scoped>
/* Make the outer pane body a flex container so .td can flex:1 into a
   definite height. Relying on height: 100% through the .workspace-pane
   grid chain was unreliable in this nested layout. */
.workspace-pane__body--task-dashboard {
  display: flex;
  flex-direction: column;
  height: 100%;
}
.td {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  color: var(--fg, #ccc);
  font-size: 13px;
}
.td__header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  padding: 12px 16px;
  gap: 12px;
  border-bottom: 1px solid var(--border, #333);
}
.td__title {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  min-width: 0;
}
.td__title h2 {
  font-size: 14px;
  font-weight: 600;
  margin: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 350px;
}
.td__badge {
  font-size: 10px;
  font-weight: 700;
  text-transform: uppercase;
  padding: 2px 6px;
  border-radius: 3px;
  letter-spacing: 0.04em;
}
.td__badge--idle {
  background: #555;
  color: #aaa;
}
.td__badge--running {
  background: #1b5e20;
  color: #a5d6a7;
}
.td__badge--evaluating,
.td__badge--judge-evaluating {
  background: #e65100;
  color: #ffcc80;
}
.td__badge--completed {
  background: #004d40;
  color: #80cbc4;
}
.td__badge--failed {
  background: #b71c1c;
  color: #ef9a9a;
}
.td__badge--refreshing {
  background: #0d47a1;
  color: #90caf9;
}
.td__badge--paused {
  background: #4a148c;
  color: #ce93d8;
}
.td__round {
  font-size: 11px;
  opacity: 0.6;
}
.td__elapsed {
  font-size: 11px;
  font-family: monospace;
  color: var(--muted, #888);
  background: rgba(255, 255, 255, 0.04);
  padding: 1px 6px;
  border-radius: 3px;
  letter-spacing: 0.02em;
}
.td__controls {
  display: flex;
  gap: 4px;
  flex-shrink: 0;
}
.td__tabs {
  display: flex;
  border-bottom: 1px solid var(--border, #333);
  padding: 0 16px;
}
.td__tab {
  background: none;
  border: none;
  color: var(--muted, #888);
  font-size: 12px;
  padding: 6px 12px;
  cursor: pointer;
  border-bottom: 2px solid transparent;
  transition:
    color 0.15s,
    border-color 0.15s;
}
.td__tab:hover {
  color: var(--fg, #ccc);
}
.td__tab--active {
  color: var(--fg, #ccc);
  border-bottom-color: var(--accent, #7c4dff);
}
.td__body {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  padding: 16px;
  overflow: hidden;
  scrollbar-width: thin;
  scrollbar-color: rgba(255, 255, 255, 0.15) transparent;
}
/* Non-files tabs need their own scroll container since .td__body is grid
   and doesn't scroll. Files tab hides overflow (inner editor handles it).
   `flex: 1` makes the section claim the full body height — without it
   the section sized to its natural content and left a visible gap below
   in small grid cells where the dashboard didn't fill the row visually. */
.td__body :deep(.td__section) {
  flex: 1;
  overflow-y: auto;
  overflow-x: hidden;
  min-height: 0;
}
.td__body :deep(.td__section--files) {
  overflow: hidden;
}
.td__body :deep(.td__section)::-webkit-scrollbar {
  width: 6px;
}
.td__body :deep(.td__section)::-webkit-scrollbar-thumb {
  background: rgba(255, 255, 255, 0.15);
  border-radius: 3px;
}
.td__field {
  display: block;
  margin-bottom: 12px;
}
.td__field > span {
  display: block;
  font-weight: 600;
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  opacity: 0.6;
  margin-bottom: 3px;
}
.td__value {
  line-height: 1.5;
}
.td__link-btn {
  background: none;
  border: none;
  color: var(--accent, #7c4dff);
  cursor: pointer;
  font-size: inherit;
  text-decoration: underline;
  padding: 0;
}
.td__link-btn:hover {
  opacity: 0.8;
}

/* ── Compact mode (workspace-grid cells) ─────────────────────────────
   Mirrors the mobile.css density conventions: tighter padding, smaller
   fonts, slimmer tab strip. The dashboard's full-width chrome would eat
   ~80 px out of every grid cell — in a 4-cell layout that's a third of
   the cell gone before any content shows. The .compact variant collapses
   it to ~40 px while keeping every action reachable. */
.td--compact .td__header {
  padding: 4px 8px;
  gap: 6px;
}
.td--compact .td__title {
  gap: 5px;
}
.td--compact .td__title h2 {
  font-size: 12px;
  max-width: none;
}
.td--compact .td__badge {
  font-size: 9px;
  padding: 1px 4px;
}
.td--compact .td__round,
.td--compact .td__elapsed {
  font-size: 10px;
}
.td--compact .td__controls {
  gap: 2px;
}
.td--compact .td__controls :deep(.button) {
  padding: 1px 6px;
  font-size: 10px;
  height: auto;
  min-height: 0;
}
.td--compact .td__tabs {
  padding: 0 8px;
}
.td--compact .td__tab {
  padding: 3px 7px;
  font-size: 10px;
}
.td--compact .td__body {
  padding: 8px;
  font-size: 12px;
}
.td--compact :deep(.td__hero) {
  padding: 12px 14px 14px;
  gap: 8px;
  margin: 4px 0 8px;
  border-radius: 5px;
}
.td--compact :deep(.td__hero-eyebrow) {
  font-size: 9px;
}
.td--compact :deep(.td__hero-desc) {
  font-size: 13px;
}
.td--compact :deep(.td__hero-textarea) {
  min-height: 50px;
  font-size: 11px;
  padding: 6px 8px;
}
.td--compact :deep(.td__hero-meta-item) {
  min-width: 70px;
  padding: 4px 8px;
  gap: 1px;
}
.td--compact :deep(.td__hero-meta-label) {
  font-size: 8px;
}
.td--compact :deep(.td__hero-meta-value) {
  font-size: 11px;
}
.td--compact :deep(.td__hero-start) {
  padding: 6px 14px;
  font-size: 12px;
}
.td--compact :deep(.td__field) {
  margin-bottom: 6px;
}
.td--compact :deep(.td__field > span) {
  font-size: 9px;
  margin-bottom: 2px;
}
</style>
