<template>
  <div
    class="workspace-pane__body workspace-pane__body--task-dashboard"
    :class="{ 'workspace-pane__body--compact': compact }"
  >
    <div class="td" :class="{ 'td--compact': compact }">
      <!-- Header with controls -->
      <div class="td__header">
        <div class="td__title">
          <h2>{{ headerTitle }}</h2>
          <span class="td__badge" :class="`td__badge--${taskState?.state || 'idle'}`">
            {{ stateLabel }}
          </span>
          <span v-if="showRoundChip" class="td__round">
            Round {{ taskState?.currentRound || 0 }}/{{ taskState?.maxRounds || 10 }}
          </span>
          <span v-if="taskState?.startedAt && taskState.state !== 'idle'" class="td__elapsed" :title="elapsedTitle">
            {{ elapsedFormatted }}
          </span>
        </div>
        <div class="td__controls">
          <!-- Always visible for attached tasks — the sticky Dashboard/Primary
               switcher mobile needs (plan §9.1), since there's no split view
               to fall back on. -->
          <button
            v-if="isAttached && taskState?.state !== 'idle' && sourceWorkspaceAvailable"
            class="button button--ghost button--sm"
            title="Open the Primary conversation this companion loop is attached to"
            @click="onOpenPrimary"
          >
            Open Primary
          </button>
          <button
            v-if="taskState?.state === 'idle' && !primaryMissing"
            class="button button--sm"
            :title="
              isAttached
                ? 'Send the context-capture prompt into the existing Primary conversation'
                : 'Begin the task — sends prompt to Worker and starts the automation loop'
            "
            @click="isAttached ? onStart() : onStartWithBrief(statusTabRef?.briefDraft)"
          >
            {{ isAttached ? "Start capture" : "Start" }}
          </button>
          <button
            v-if="isAttached && taskState?.state === 'brief-ready' && !primaryMissing"
            class="button button--sm"
            :title="`Start the baseline ${companionRoleLabel} evaluation of the work already discussed in the Primary conversation`"
            @click="onStart"
          >
            Start {{ companionRoleLabel }} loop
          </button>
          <button
            v-if="
              !primaryMissing &&
              (taskState?.state === 'paused' || taskState?.state === 'completed' || taskState?.state === 'failed')
            "
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
              taskState?.state === 'refreshing' ||
              (isAttached && taskState?.state === 'capturing-context')
            "
            class="button button--ghost button--sm"
            title="Pause the task — you can Continue or Reset afterwards"
            @click="onStop"
          >
            Pause
          </button>
          <button
            v-if="resendVisible && !primaryMissing"
            class="button button--ghost button--sm"
            :title="`Re-send the last instruction to the ${isAttached ? 'Primary' : 'Worker'} — use if the CLI dropped out of agent mode`"
            @click="onResend('worker')"
          >
            ↻ {{ isAttached ? "Primary" : "Worker" }}
          </button>
          <button
            v-if="resendVisible && !primaryMissing"
            class="button button--ghost button--sm"
            :title="`Re-send the last instruction to the ${isAttached ? companionRoleLabel : 'Judge'} — use if the CLI dropped out of agent mode`"
            @click="onResend('judge')"
          >
            ↻ {{ isAttached ? companionRoleLabel : "Judge" }}
          </button>
          <button
            v-if="!primaryMissing && (taskState?.state === 'completed' || taskState?.state === 'failed')"
            class="button button--ghost button--sm"
            :title="`Override the verdict and send the ${isAttached ? 'Primary' : 'Worker'} back with your own feedback`"
            @click="onRejectVerdict"
          >
            Send back
          </button>
          <button
            v-if="
              !primaryMissing &&
              (taskState?.state === 'paused' ||
                taskState?.state === 'completed' ||
                taskState?.state === 'failed' ||
                (isAttached && taskState?.state === 'brief-ready'))
            "
            class="button button--ghost button--sm"
            :title="
              isAttached
                ? 'Clear all rounds and return to idle — the next Start re-captures context from the Primary conversation'
                : 'Clear all rounds and return to idle — edit the brief in the Task tab, then press Start'
            "
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
          v-if="activeTab === 'status' && !isAttached"
          ref="statusTabRef"
          :task-state="taskState"
          :workspace-cwd="workspace?.cwd || ''"
          :task-id="taskState?.taskId || ''"
          :worker-provider-label="workerProviderLabel"
          :judge-provider-label="judgeProviderLabel"
          @start="onStartWithBrief"
          @start-new="onStartNewRun"
          @reject-verdict="onRejectVerdict"
          @open-assignment="openAssignment"
          @open-config="activeTab = 'config'"
        />

        <TaskDashboardCompanionStatusTab
          v-if="activeTab === 'status' && isAttached"
          :task-state="taskState"
          :workspace-cwd="workspace?.cwd || ''"
          :task-id="taskState?.taskId || ''"
          :source-workspace-available="sourceWorkspaceAvailable"
          @open-primary="onOpenPrimary"
          @open-assignment="openAssignment"
          @start="onStart"
          @reject-verdict="onRejectVerdict"
          @reset="onReset"
          @delete-task="onDeleteTask"
          @answer="onAnswerCompanion"
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
        <div v-if="activeTab === 'config' && !isAttached" class="td__section">
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

        <!-- CONFIG tab — attached mode (plan §3.5) -->
        <div v-if="activeTab === 'config' && isAttached" class="td__section">
          <label class="td__field">
            <span>Primary</span>
            <div class="td__value">
              {{ workerProviderLabel }} (existing conversation)
              <template v-if="sourceWorkspaceAvailable">
                &mdash;
                <button class="td__link-btn" @click="onOpenPrimary">Open conversation</button>
              </template>
              <span v-else class="tdp__source-missing"> — no longer available in this profile</span>
            </div>
          </label>
          <label class="td__field">
            <span>Judge role</span>
            <div class="td__value">{{ companionRoleLabel }}</div>
          </label>
          <label class="td__field">
            <span>Evaluator</span>
            <div class="td__value">{{ judgeProviderLabel }}</div>
          </label>
          <label class="td__field">
            <span>Working directory</span>
            <div class="td__value">
              <code>{{ workspace?.cwd || "" }}</code>
            </div>
          </label>
          <label class="td__field">
            <span>Max rounds</span>
            <div class="td__value">{{ taskState?.maxRounds || 10 }}</div>
          </label>
          <label class="td__field">
            <span>Judge execution</span>
            <div class="td__value">
              Inspect only — never runs project code, builds, tests, or writes source. Isolation:
              <strong>{{ judgeIsolationLabel }}</strong>
            </div>
          </label>
          <label class="td__field">
            <span>Primary permissions</span>
            <div class="td__value">
              Unchanged — this loop never modifies the Primary panel's command or permissions.
            </div>
          </label>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, inject, watch, onUnmounted } from "vue";
import { apiKey } from "../../types/keys.js";
import { useAppStore } from "../../stores/app.js";
import { useTaskFiles } from "../../composables/useTaskFiles.js";
import { PROVIDER_CHOICES } from "../../lib/agent-providers.js";
import TaskDashboardHelpTab from "./TaskDashboardHelpTab.vue";
import TaskDashboardStatusTab from "./TaskDashboardStatusTab.vue";
import TaskDashboardCompanionStatusTab from "./TaskDashboardCompanionStatusTab.vue";
import TaskDashboardFilesTab from "./TaskDashboardFilesTab.vue";
import TaskDashboardLogTab from "./TaskDashboardLogTab.vue";

withDefaults(defineProps<{ workspaceId: string; showHeader?: boolean; compact?: boolean }>(), {
  showHeader: false,
  compact: false,
});

const store = useAppStore();
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const api = inject<any>(apiKey);
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

// Same vocabulary as AgentProviderConfig.vue's creation-time picker (plan
// §10) — the Dashboard must keep telling the truth about how much the
// inspect-only contract is actually enforced while the loop is running, not
// just at creation time.
const ISOLATION_LABELS: Record<string, string> = {
  enforced: "Enforced",
  "permission-gated": "Permission-gated",
  "prompt-only": "Prompt-enforced",
};
const judgeIsolationLabel = computed(() => {
  const providerId = taskState.value?.judgeProviderConfig?.providerId;
  const level = PROVIDER_CHOICES.find((c) => c.id === providerId)?.inspectionIsolation || "permission-gated";
  return ISOLATION_LABELS[level] || level;
});

// Attached mode (Companion loop) — plan §3.5/§9: Dashboard uses Primary/role
// labels, never Worker/Judge, and adds three states standard tasks never see.
const isAttached = computed(() => taskState.value?.mode === "attached");
const COMPANION_ROLE_LABELS: Record<string, string> = {
  reviewer: "Reviewer",
  planner: "Planner",
  consultant: "Consultant",
  critic: "Critic",
};
const companionRoleLabel = computed(() => COMPANION_ROLE_LABELS[taskState.value?.companionRole || "reviewer"]);

const headerTitle = computed(() => {
  if (isAttached.value) {
    return workspace.value?.name || `${companionRoleLabel.value} loop`;
  }
  return taskState.value?.description || "Task workspace";
});

// Judge-evaluating shows a round chip for attached tasks too (Primary <->
// Companion rounds matter equally there) — added as a separate OR so the
// standard task's existing list/behavior above is untouched.
const showRoundChip = computed(() => {
  const s = taskState.value?.state;
  if (["running", "evaluating", "refreshing"].includes(s || "")) return true;
  return isAttached.value && s === "judge-evaluating";
});

const resendVisible = computed(() => {
  const s = taskState.value?.state || "";
  if (["running", "evaluating", "judge-evaluating", "refreshing", "paused"].includes(s)) return true;
  return isAttached.value && (s === "capturing-context" || s === "awaiting-user");
});

// Set by the backend once the Primary's workspace or panel is known to be gone
// (deleted, or missing at app-restart recovery). Every action that drives an
// attached loop forward is refused from then on, and Reset doesn't lift it, so
// the controls that would only fail silently are hidden rather than offered.
const primaryMissing = computed(() => isAttached.value && Boolean(taskState.value?.primaryMissing));

// The remote payload is already filtered per viewer profile — if the source
// workspace isn't in it (wrong profile, or it was deleted), Open Primary must
// not be offered at all rather than failing silently when clicked. The PANEL
// counts too: deleting just the tab that hosts the conversation leaves the
// workspace in place, and jumping to it would only show a workspace whose
// Primary conversation no longer exists.
const sourceWorkspaceAvailable = computed(() => {
  const sourceWorkspaceId = taskState.value?.workerWorkspaceId;
  if (!sourceWorkspaceId) return false;
  if (primaryMissing.value) return false;
  const sourceWorkspace = (store.payload?.appState?.workspaces || []).find((w) => w.id === sourceWorkspaceId);
  if (!sourceWorkspace) return false;
  const panelId = taskState.value?.workerPanelId;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const panels = (sourceWorkspace as any).panels as Array<{ id: string }> | undefined;
  // Only a payload that carries no panel list AT ALL falls back to the
  // workspace-level answer (older remote payloads), rather than hiding a
  // working button. A list that is present but empty is authoritative: every
  // panel is gone, so the Primary's certainly is.
  if (!panelId || !Array.isArray(panels)) return true;
  return panels.some((p) => p.id === panelId);
});

function onOpenPrimary() {
  const sourceWorkspaceId = taskState.value?.workerWorkspaceId;
  if (sourceWorkspaceId) store.activateWorkspace(sourceWorkspaceId);
}

const stateLabel = computed(() => {
  const s = taskState.value?.state;
  if (s === "capturing-context") return "Capturing context…";
  if (s === "brief-ready") return "Brief ready";
  if (s === "awaiting-user") return `Awaiting your input`;
  if (s === "running") return "Running";
  if (s === "evaluating") return "Evaluating";
  if (s === "judge-evaluating") return isAttached.value ? `${companionRoleLabel.value} evaluating` : "Judge evaluating";
  if (s === "refreshing") return "Refreshing context";
  if (s === "completed") return "Completed";
  if (s === "failed") return "Failed";
  if (s === "paused") return "Paused";
  return "Idle";
});

// ── Elapsed timer ───────────────────────────────────────────────
const ACTIVE_STATES = new Set(["running", "evaluating", "judge-evaluating", "refreshing", "capturing-context"]);
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
      await taskToast("Could not save brief", (err as Error)?.message || "Unknown error");
      return;
    }
  }
  await onStart();
}

// "Start new run" from the completion hero — reset (clear rounds), persist the
// edited brief if it changed, then start fresh. Without the reset the runtime
// would resume the existing task as round N+1; we want a clean slate so the
// user gets the same shape as the initial run.
async function onStartNewRun(brief?: string) {
  const id = wsId();
  if (!api || !id) return;
  const trimmed = (brief || "").trim();
  if (!trimmed) return;
  try {
    const reset = await api.resetTask({ workspaceId: id });
    if (reset?.payload) store.handleBroadcastPayload(reset.payload);
    const current = (taskState.value?.description || "").trim();
    if (trimmed !== current) {
      const r = await api.updateTaskDescription({ workspaceId: id, description: trimmed });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const payload = (r as any)?.payload;
      if (payload) store.handleBroadcastPayload(payload);
    }
    await store.startTaskWithHookCheck(id);
    activeTab.value = "status";
  } catch (err) {
    console.error("[task-dashboard] start-new failed:", err);
    await taskToast("Start failed", (err as Error)?.message || "Unknown error");
  }
}

// Krok 7 — surface failures to the user instead of swallowing them in console.
async function taskToast(title: string, body: string, kind: "info" | "error" = "error") {
  const { useNotificationStore } = await import("../../stores/notifications.js");
  useNotificationStore().pushEphemeralToast({ title, body, kind, durationMs: 5000 });
}

async function onStart() {
  const id = wsId();
  if (!api || !id) return;
  try {
    const s = taskState.value?.state;
    if (s === "paused" || s === "completed" || s === "failed") {
      const r = await api.resumeTask({ workspaceId: id });
      if (r?.payload) store.handleBroadcastPayload(r.payload);
      if (r && (r as { ok?: boolean }).ok === false) {
        await taskToast("Could not resume task", "The task isn't in a state that can be resumed.");
      }
    } else {
      await store.startTaskWithHookCheck(id);
    }
    activeTab.value = "status";
  } catch (err) {
    console.error("[task-dashboard] start/resume failed:", err);
    await taskToast("Task action failed", (err as Error)?.message || "Unknown error");
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
    await taskToast("Stop failed", (err as Error)?.message || "Unknown error");
  }
}

// Manually re-send the last instruction to the worker/judge — escape hatch for
// when the underlying CLI dropped out of agent mode and didn't auto-recover.
async function onResend(role: "worker" | "judge") {
  const id = wsId();
  if (!api || !id) return;
  try {
    const r = await api.resendTaskInstruction({ workspaceId: id, role });
    if (r?.payload) store.handleBroadcastPayload(r.payload);
    if (r && (r as { ok?: boolean }).ok === false) {
      await taskToast("Nothing to resend", `No previous ${role} instruction has been sent yet.`, "info");
    }
  } catch (err) {
    console.error("[task-dashboard] resend failed:", err);
    await taskToast("Resend failed", (err as Error)?.message || "Unknown error");
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
    await taskToast("Reset failed", (err as Error)?.message || "Unknown error");
  }
}

// Only offered once the Primary is known to be gone: recovery from that is
// delete-and-recreate, so the hero's action deletes this task workspace. Goes
// through the store's normal delete path, which owns the confirm dialog and the
// optimistic sidebar removal — the Primary's own workspace is never touched.
async function onDeleteTask() {
  const id = wsId();
  if (!id) return;
  try {
    await store.deleteWorkspace(id);
  } catch (err) {
    console.error("[task-dashboard] delete task failed:", err);
    await taskToast("Delete failed", (err as Error)?.message || "Unknown error");
  }
}

// Explicit answer action for a `needs-input` companion verdict — the only
// way out of awaiting-user besides Pause/Reset (plan §8.5). Never a plain
// Continue, which would bypass the question.
async function onAnswerCompanion({ questionIds, answer }: { questionIds: string[]; answer: string }) {
  const id = wsId();
  if (!api || !id) return;
  try {
    const r = await api.answerCompanionTask({ workspaceId: id, questionIds, answer });
    if (r?.payload) store.handleBroadcastPayload(r.payload);
    if (r && (r as { ok?: boolean }).ok === false) {
      await taskToast("Could not send decision", "The task may no longer be awaiting your input.");
    }
  } catch (err) {
    console.error("[task-dashboard] answer companion failed:", err);
    await taskToast("Send decision failed", (err as Error)?.message || "Unknown error");
  }
}

function onRejectVerdict() {
  const id = wsId();
  if (!api || !id) return;
  const targetLabel = isAttached.value ? "Primary" : "Worker";
  const verdictLabel =
    taskState.value?.state === "failed"
      ? "Max rounds reached"
      : isAttached.value
        ? `${companionRoleLabel.value} said complete`
        : "Judge said complete";
  store.openDialog("TextAreaDialog", {
    eyebrow: "Task runner",
    title: `Send ${targetLabel} back with feedback`,
    label: `${verdictLabel} — describe what's still missing so the ${targetLabel} runs one more round:`,
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
        await taskToast("Reject verdict failed", (err as Error)?.message || "Unknown error");
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
.tdp__source-missing {
  opacity: 0.6;
  font-style: italic;
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
