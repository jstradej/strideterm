<template>
  <div class="td__section">
    <!-- Idle hero — replaces the empty pipeline + tiny "Press Start" hint with
         a real ready-to-run panel: brief, agents, max rounds, big Start CTA. -->
    <div v-if="showIdleHero" class="td__hero">
      <div class="td__hero-eyebrow">Ready to start</div>

      <div class="td__hero-editor">
        <label class="td__hero-editor-label" for="td-hero-brief">What should the Worker do?</label>
        <textarea
          id="td-hero-brief"
          v-model="briefDraft"
          class="td__hero-textarea"
          rows="4"
          :maxlength="TASK_BRIEF_MAX_CHARS"
          placeholder="e.g. Add input validation to the signup form."
          title="Type the task brief, then press Start (or Ctrl+Enter / Cmd+Enter)"
          @keydown.ctrl.enter.exact.prevent="onStart"
          @keydown.meta.enter.exact.prevent="onStart"
        ></textarea>
        <div class="td__hero-editor-meta">
          <span class="td__hero-editor-tip">{{ TASK_BRIEF_HINT }}</span>
          <span
            class="td__hero-editor-counter"
            :class="{ 'td__hero-editor-counter--near-limit': briefDraft.length > TASK_BRIEF_MAX_CHARS * 0.9 }"
          >
            {{ formatBriefCounter(briefDraft.length) }}
          </span>
        </div>
        <div class="td__hero-editor-hint">
          Edit and press Start &mdash; changes get saved to the brief on the way in. Need more space?
          <button
            type="button"
            class="td__link-btn"
            title="Open the Task tab for a full editor (better for longer briefs)"
            @click="$emit('open-assignment')"
          >
            Open Task tab
          </button>
          .
        </div>
      </div>

      <div class="td__hero-meta">
        <div class="td__hero-meta-item" title="Worker agent — runs the task. Change in the Config tab.">
          <span class="td__hero-meta-label">Worker</span>
          <span class="td__hero-meta-value">{{ workerProviderLabel }}</span>
        </div>
        <div
          class="td__hero-meta-item"
          title="Judge agent — independently verifies completion. Change in the Config tab."
        >
          <span class="td__hero-meta-label">Judge</span>
          <span class="td__hero-meta-value">{{ judgeProviderLabel }}</span>
        </div>
        <div
          class="td__hero-meta-item"
          title="Maximum loop iterations before the task auto-fails. Change in the Config tab."
        >
          <span class="td__hero-meta-label">Max rounds</span>
          <span class="td__hero-meta-value">{{ taskState?.maxRounds || 10 }}</span>
        </div>
      </div>

      <button
        type="button"
        class="button td__hero-start"
        :class="{ 'td__hero-start--disabled': !canStart }"
        :disabled="!canStart"
        :title="
          canStart
            ? 'Begin the task — sends prompt to Worker and starts the automation loop'
            : 'Write a task brief first'
        "
        @click="onStart"
      >
        <span class="td__hero-start-icon" aria-hidden="true">&#9654;</span>
        Start task
      </button>

      <div class="td__hero-footer">
        <button
          type="button"
          class="td__link-btn"
          title="Open the Task tab to write or edit the brief in a full editor"
          @click="$emit('open-assignment')"
        >
          Open Task tab
        </button>
        <span class="td__hero-sep">&middot;</span>
        <button
          type="button"
          class="td__link-btn"
          title="Open the Config tab to change Worker/Judge agents or max rounds"
          @click="$emit('open-config')"
        >
          Adjust config
        </button>
      </div>
    </div>

    <!-- Completion hero — shown after Worker finishes (verdict 'completed' /
         'failed'). Mirrors the idle hero so the user has a clear "what's next"
         affordance instead of staring at a frozen pipeline. Primary action is
         a fresh run with an editable brief; secondary is overriding the judge's
         verdict via Send back. -->
    <div v-if="showCompletionHero" class="td__hero td__hero--done">
      <div class="td__hero-eyebrow" :class="completionEyebrowClass">{{ completionEyebrow }}</div>

      <div class="td__hero-editor">
        <label class="td__hero-editor-label" for="td-done-brief">What's next? Edit the brief and start again:</label>
        <textarea
          id="td-done-brief"
          v-model="briefDraft"
          class="td__hero-textarea"
          rows="4"
          :maxlength="TASK_BRIEF_MAX_CHARS"
          placeholder="e.g. Add input validation to the signup form."
          title="Edit the brief, then press Start new run (or Ctrl+Enter / Cmd+Enter)"
          @keydown.ctrl.enter.exact.prevent="onStartNew"
          @keydown.meta.enter.exact.prevent="onStartNew"
        ></textarea>
        <div class="td__hero-editor-meta">
          <span class="td__hero-editor-tip">{{ TASK_BRIEF_HINT }}</span>
          <span
            class="td__hero-editor-counter"
            :class="{ 'td__hero-editor-counter--near-limit': briefDraft.length > TASK_BRIEF_MAX_CHARS * 0.9 }"
          >
            {{ formatBriefCounter(briefDraft.length) }}
          </span>
        </div>
      </div>

      <div class="td__hero-actions">
        <button
          type="button"
          class="button td__hero-start"
          :class="{ 'td__hero-start--disabled': !canStart }"
          :disabled="!canStart"
          :title="
            canStart
              ? 'Clears rounds and starts a fresh run with the brief above (Ctrl+Enter)'
              : 'Write a task brief first'
          "
          @click="onStartNew"
        >
          <span class="td__hero-start-icon" aria-hidden="true">&#9654;</span>
          Start new run
        </button>
        <button
          type="button"
          class="button button--ghost td__hero-secondary"
          title="Override the verdict and send the Worker back with feedback for one more round — keeps the current history"
          @click="$emit('reject-verdict')"
        >
          Send Worker back
        </button>
      </div>

      <div class="td__hero-footer">
        <button
          type="button"
          class="td__link-btn"
          title="Open the Task tab to write or edit the brief in a full editor"
          @click="$emit('open-assignment')"
        >
          Open Task tab
        </button>
        <span class="td__hero-sep">&middot;</span>
        <button
          type="button"
          class="td__link-btn"
          title="Open the Config tab to change Worker/Judge agents or max rounds"
          @click="$emit('open-config')"
        >
          Adjust config
        </button>
      </div>
    </div>

    <!-- Pipeline flow — horizontal -->
    <div v-if="!showIdleHero" class="td__pipeline">
      <template v-for="(step, i) in pipelineSteps" :key="step.id">
        <div
          v-if="i > 0"
          class="td__pipe-line"
          :class="{ 'td__pipe-line--done': step.lineDone, 'td__pipe-line--active': step.lineActive }"
        ></div>
        <div class="td__pipe-step" :class="step.classes" :title="step.hint">
          <span v-heartbeat="step.active" class="td__pipe-circle">{{ i + 1 }}</span>
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
        v-heartbeat="roundStatus(round) === 'active'"
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
        <button
          type="button"
          class="td__round-close"
          title="Collapse this round's detail panel and return to the round-chip overview."
          @click="selectedRound = null"
        >
          &times;
        </button>
      </div>
      <div v-if="selectedRoundData.checks?.length" class="td__checks">
        <div v-for="check in selectedRoundData.checks" :key="check.label" class="td__check">
          <span :class="check.passed ? 'td__check--pass' : 'td__check--fail'">
            {{ check.passed ? "\u2713" : "\u2717" }}
          </span>
          {{ check.label }}
          <span v-if="!check.passed && check.exitCode != null" class="td__check-code">exit {{ check.exitCode }}</span>
        </div>
        <pre v-if="selectedRoundHasFailedOutput" class="td__output">{{ selectedRoundFailedOutputText }}</pre>
      </div>
      <div v-if="selectedRoundData.judgeVerdict" class="td__verdict">
        Judge: <strong>{{ selectedRoundData.judgeVerdict }}</strong>
        <p v-if="selectedRoundData.judgeReason" class="td__verdict-reason">{{ selectedRoundData.judgeReason }}</p>
      </div>
      <div v-if="hiddenActivityCount" class="td__activity-more">
        Showing the last {{ selectedRoundEntries.length }} of {{ roundEntriesInWindow.length }} entries.
        <button
          type="button"
          class="td__link-btn"
          title="Reveal another page of older entries. Rendering a whole long round here makes the dashboard sluggish — read it in the Log tab instead."
          @click="showOlderActivity"
        >
          Show {{ nextActivityPageSize }} older
        </button>
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

    <div v-if="!showIdleHero && !roundsChronological.length && !allLogEntries.length" class="td__empty">
      {{ taskState?.state === "running" ? "Worker is processing..." : "Waiting for activity..." }}
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, inject, watch } from "vue";
import { apiKey } from "../../types/keys.js";
import { TASK_BRIEF_MAX_CHARS, TASK_BRIEF_HINT, formatBriefCounter } from "../../app/task-brief.js";
import { vHeartbeat } from "../../app/heartbeat-directive.js";
import { useTaskLog, formatTime } from "../../composables/useTaskLog.js";
import { eventLabel, eventCategory } from "../../lib/task-log-labels.js";

const props = withDefaults(
  defineProps<{
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    taskState?: Record<string, any> | null;
    workspaceCwd?: string;
    taskId?: string;
    workerProviderLabel?: string;
    judgeProviderLabel?: string;
  }>(),
  { taskState: null, workspaceCwd: "", taskId: "", workerProviderLabel: "", judgeProviderLabel: "" },
);

const emit = defineEmits<{
  (e: "start", brief?: string): void;
  (e: "start-new", brief?: string): void;
  (e: "reject-verdict"): void;
  (e: "open-assignment"): void;
  (e: "open-config"): void;
}>();

// Hero textarea is always editable so the user can rewrite the brief from
// the idle screen — including after Reset, where the existing description is
// preserved on disk and we want to let them tweak it before re-running.
// Initialize from the persisted description and re-sync if it changes from
// outside (e.g. someone saved the Task tab in another pane). The Pane
// upstream is responsible for diffing against state.description and only
// hitting updateTaskDescription when the brief actually changed.
const briefDraft = ref(props.taskState?.description ?? "");

watch(
  () => props.taskState?.description,
  (desc) => {
    briefDraft.value = desc ?? "";
  },
);

defineExpose({ briefDraft });

function onStart() {
  const draft = briefDraft.value.trim();
  if (draft) {
    emit("start", draft);
  } else {
    emit("start");
  }
}

// "Start new run" from the completion hero — clears rounds and runs again with
// the (possibly edited) brief. The parent owns the reset+update+start sequence;
// here we just hand off the draft. Gated on a non-empty brief, same as idle.
function onStartNew() {
  const draft = briefDraft.value.trim();
  if (!draft) return;
  emit("start-new", draft);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const api = inject<any>(apiKey);
const selectedRound = ref<number | null>(null);

// ── Rounds ────────────────────────────────────────────────────────
const roundsChronological = computed(() => props.taskState?.rounds || []);

// Hero is shown when task is idle and has nothing to display yet (no rounds).
// After Reset, rounds are cleared too, so the hero re-appears on each fresh
// run — matching the "always idle && empty" intent.
const showIdleHero = computed(() => props.taskState?.state === "idle" && !roundsChronological.value.length);

// Completion hero — terminal verdict state. Mirrors idle hero structure so
// the user has a consistent "edit brief + start" affordance instead of
// landing on a static pipeline with no obvious next action.
const showCompletionHero = computed(
  () => props.taskState?.state === "completed" || props.taskState?.state === "failed",
);
const completionEyebrow = computed(() => (props.taskState?.state === "failed" ? "Task failed" : "Task complete"));
const completionEyebrowClass = computed(() =>
  props.taskState?.state === "failed" ? "td__hero-eyebrow--failed" : "td__hero-eyebrow--complete",
);

// Start is gated on having a brief — either in persisted state or freshly
// typed into the inline editor. The textarea is the primary path for new
// tasks; users can still write in the Task tab for longer briefs.
// Textarea is always rendered (initialized from state.description), so the
// draft is the single source of truth for "do we have a brief to start with".
const canStart = computed(() => !!briefDraft.value.trim());

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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return roundsChronological.value.find((r: any) => r.round === selectedRound.value) || null;
});

const selectedRoundHasFailedOutput = computed(() =>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (selectedRoundData.value?.checks || []).some((c: any) => !c.passed && c.outputTail),
);

const selectedRoundFailedOutputText = computed(() =>
  (selectedRoundData.value?.checks || [])
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .filter((c: any) => !c.passed && c.outputTail)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .map((c: any) => c.outputTail)
    .join("\n"),
);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function roundStatus(round: Record<string, any>): string {
  if (round.action === "completed") return "success";
  if (round.action === "failed") return "error";
  if (round.action === "re-prompted") return "warn";
  if (round.action === "judge-requested") return "judge";
  if (round.action === "running" || round.action === "evaluating" || round.action === "shower") return "active";
  return "neutral";
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function roundTooltip(round: Record<string, any>): string {
  const parts = [`Round ${round.round}`];
  if (round.action) parts.push(round.action);
  if (round.checks?.length) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const passed = round.checks.filter((c: any) => c.passed).length;
    parts.push(`${passed}/${round.checks.length} checks passed`);
  }
  if (round.judgeVerdict) parts.push(`Judge: ${round.judgeVerdict}`);
  if (round.judgeReason) parts.push(round.judgeReason);
  return parts.join("\n");
}

// ── Pipeline ──────────────────────────────────────────────────────
const PIPELINE_ORDER = ["running", "evaluating", "judge-evaluating", "completed"];

function pipelineStatus(stepState: string): string {
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
      active: status === "active",
      classes: { [`td__pipe-step--${status}`]: true },
      lineDone: prevStatus === "done" || prevStatus === "active",
      lineActive: prevStatus === "active",
    };
  });
});

// ── Activity log (compact view of TASK_LOG.jsonl) ─────────────────
// The full log lives in the Log tab; Status shows a tail so the user sees
// what's happening from the moment the task starts without switching tabs.
// Load/parse logic, event labels, and the refresh watch are shared with
// TaskDashboardLogTab.vue via useTaskLog / task-log-labels.
const { logEntries: allLogEntries } = useTaskLog(api, props);

// Filter log entries by the selected round's time window. The backend's
// `round` field on each entry is `task.currentRound || 0`, which jumps at
// different points in the eval pipeline and doesn't cleanly map to round
// chips. A time window between `round.startedAt` and the next round's
// `startedAt` is an accurate, backend-agnostic mapping.
const roundEntriesInWindow = computed(() => {
  const r = selectedRoundData.value;
  if (!r?.startedAt) return [];
  const rounds = roundsChronological.value;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const idx = rounds.findIndex((x: any) => x.round === r.round);
  const startMs = Date.parse(r.startedAt);
  if (Number.isNaN(startMs)) return [];
  const next = rounds[idx + 1];
  const endMs = next?.startedAt ? Date.parse(next.startedAt) : Infinity;
  return allLogEntries.value.filter((e) => {
    const ts = Date.parse(e.ts);
    return !Number.isNaN(ts) && ts >= startMs && ts < endMs;
  });
});

// Render only a tail by default. A long round can hold thousands of entries,
// and this dashboard re-renders on every log poll, so an uncapped v-for keeps
// tens of thousands of elements in the document and pays style/layout for all
// of them on every frame. Older entries are revealed a page at a time — never
// all at once, which would just rebuild the table that caused the problem.
// The Log tab is the place to read a whole round.
const ACTIVITY_ROW_CAP = 200;
const activityRowLimit = ref(ACTIVITY_ROW_CAP);
watch(selectedRound, () => {
  activityRowLimit.value = ACTIVITY_ROW_CAP;
});

const selectedRoundEntries = computed(() => {
  const entries = roundEntriesInWindow.value;
  if (entries.length <= activityRowLimit.value) return entries;
  return entries.slice(-activityRowLimit.value);
});

const hiddenActivityCount = computed(() => roundEntriesInWindow.value.length - selectedRoundEntries.value.length);
const nextActivityPageSize = computed(() => Math.min(hiddenActivityCount.value, ACTIVITY_ROW_CAP));

function showOlderActivity(): void {
  activityRowLimit.value += ACTIVITY_ROW_CAP;
}
</script>

<style scoped>
.td__empty {
  opacity: 0.5;
  padding: 24px 0;
  text-align: center;
}

/* ── Idle hero ────────────────────────────────────────────────── */
.td__hero {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 14px;
  padding: 28px 24px 24px;
  margin: 8px 0 16px;
  border: 1px solid var(--border, #333);
  border-radius: 8px;
  background: radial-gradient(circle at 50% 0%, rgba(255, 164, 36, 0.08), transparent 60%), rgba(255, 255, 255, 0.02);
  text-align: center;
}
.td__hero-eyebrow {
  font-size: 10px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.12em;
  color: var(--muted, #888);
}
.td__hero-desc {
  font-size: 16px;
  font-weight: 600;
  line-height: 1.4;
  color: var(--fg, #ccc);
  max-width: 560px;
}
.td__hero-desc--empty {
  font-weight: 500;
  font-size: 13px;
  opacity: 0.75;
}
.td__hero-editor {
  display: flex;
  flex-direction: column;
  gap: 6px;
  width: 100%;
  max-width: 560px;
  text-align: left;
}
.td__hero-editor-label {
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--muted, #888);
}
.td__hero-textarea {
  width: 100%;
  background: rgba(0, 0, 0, 0.3);
  border: 1px solid var(--border, #333);
  border-radius: 4px;
  padding: 10px 12px;
  font-size: 13px;
  line-height: 1.5;
  color: var(--fg, #ccc);
  font-family: inherit;
  resize: vertical;
  min-height: 80px;
  max-height: 200px;
  transition:
    border-color 0.15s,
    background 0.15s;
}
.td__hero-textarea:focus {
  outline: none;
  border-color: var(--accent, #ffa424);
  background: rgba(0, 0, 0, 0.4);
}
.td__hero-textarea::placeholder {
  color: var(--muted, #888);
  opacity: 0.5;
}
.td__hero-editor-hint {
  font-size: 11px;
  color: var(--muted, #888);
  opacity: 0.8;
}
.td__hero-editor-meta {
  display: flex;
  gap: 12px;
  align-items: flex-start;
  justify-content: space-between;
  font-size: 11px;
  color: var(--muted, #888);
  line-height: 1.4;
}
.td__hero-editor-tip {
  flex: 1;
}
.td__hero-editor-counter {
  flex-shrink: 0;
  font-variant-numeric: tabular-nums;
}
.td__hero-editor-counter--near-limit {
  color: var(--accent, #ffa424);
}
.td__hero-meta {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 8px;
  margin: 4px 0;
}
.td__hero-meta-item {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  padding: 6px 12px;
  border: 1px solid var(--border, #333);
  border-radius: 4px;
  background: rgba(0, 0, 0, 0.2);
  min-width: 100px;
}
.td__hero-meta-label {
  font-size: 9px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--muted, #888);
}
.td__hero-meta-value {
  font-size: 12px;
  font-weight: 600;
  color: var(--fg, #ccc);
}
.td__hero-start {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 10px 22px;
  font-size: 14px;
  font-weight: 700;
  margin-top: 4px;
  box-shadow: 0 2px 14px rgba(255, 164, 36, 0.25);
  transition:
    transform 0.1s,
    box-shadow 0.15s;
}
.td__hero-start:hover:not(:disabled) {
  transform: translateY(-1px);
  box-shadow: 0 4px 18px rgba(255, 164, 36, 0.35);
}
.td__hero-start--disabled,
.td__hero-start:disabled {
  background: rgba(255, 255, 255, 0.06);
  color: var(--muted, #888);
  cursor: not-allowed;
  box-shadow: none;
  filter: grayscale(0.4);
}
.td__hero-start-icon {
  font-size: 11px;
  line-height: 1;
}
.td__hero-footer {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 12px;
  color: var(--muted, #888);
  margin-top: 2px;
}
.td__hero-sep {
  opacity: 0.5;
}
.td__link-btn {
  background: none;
  border: none;
  color: var(--accent, #ffa424);
  cursor: pointer;
  font-size: inherit;
  text-decoration: underline;
  padding: 0;
}
.td__link-btn:hover {
  opacity: 0.8;
}

/* ── Completion hero (variant of .td__hero) ──────────────────── */
/* Tighter padding than idle hero — pipeline + rounds stay visible
   below, so the hero should invite, not dominate. */
.td__hero--done {
  padding: 18px 20px 16px;
  gap: 10px;
  background: radial-gradient(circle at 50% 0%, rgba(60, 200, 120, 0.08), transparent 60%), rgba(255, 255, 255, 0.02);
}
.td__hero-eyebrow--complete {
  color: rgba(60, 200, 120, 0.95);
}
.td__hero-eyebrow--failed {
  color: rgba(230, 110, 110, 0.95);
}
.td__hero-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  align-items: center;
  justify-content: center;
  margin-top: 2px;
}
.td__hero-secondary {
  padding: 9px 16px;
  font-size: 13px;
  font-weight: 600;
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
/* The glow stays static; v-heartbeat adds the short finite pulse to the circle.
   `pointer-events: none` keeps the glow from eating clicks. */
.td__pipe-step--active .td__pipe-circle {
  background: #4caf50;
  color: #fff;
  position: relative;
  --heartbeat-on-opacity: 0.68;
}
.td__pipe-step--active .td__pipe-circle::after {
  content: "";
  position: absolute;
  inset: 0;
  border-radius: 50%;
  box-shadow: 0 0 8px rgba(76, 175, 80, 0.5);
  pointer-events: none;
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
/* Static glow on a pseudo-element for the same reason as .td__pipe-circle
   above; the active chip beats in phase with it via the shared heartbeat.
   `pointer-events: none` so the chip stays clickable through the glow. */
.td__rchip--active {
  background: #4caf50;
  color: #fff;
  position: relative;
  --heartbeat-on-opacity: 0.68;
}
.td__rchip--active::after {
  content: "";
  position: absolute;
  inset: 0;
  border-radius: 50%;
  box-shadow: 0 0 6px rgba(76, 175, 80, 0.5);
  pointer-events: none;
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
.td__activity-more {
  margin-top: 8px;
  font-size: 11px;
  opacity: 0.7;
}
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
