<template>
  <div class="td__section">
    <!-- Primary is gone — terminal in EVERY state, so it comes before the
         per-state heroes below. Nothing can be injected into the Primary again
         (the runner refuses Start/Continue/Send decision/Send back outright),
         and Reset doesn't lift the flag, so the only honest action left is to
         delete the task. Any verdict already produced stays readable. -->
    <div v-if="primaryMissing" class="td__hero">
      <div class="td__hero-eyebrow tdc__eyebrow--fail">Primary no longer exists</div>
      <p class="tdc__lead">
        The Primary conversation this {{ companionRoleLabel }} loop was attached to is gone — its workspace or tab was
        closed. Nothing can be sent to it any more, so this task can't continue or be restarted. Delete it and attach a
        fresh loop once you have a live conversation again.
      </p>
      <p v-if="verdict?.reason || lastReason" class="tdc__lead">
        Last {{ companionRoleLabel }} verdict: {{ verdict?.reason || lastReason }}
      </p>
      <CompanionReportSections
        v-if="verdict"
        :verdict="verdict"
        :role="companionRole"
        :repeated-finding-ids="repeatedFindingIds"
      />
      <div class="tdc__hero-actions">
        <button type="button" class="button td__hero-start" @click="$emit('delete-task')">Delete task</button>
      </div>
    </div>

    <!-- capturing-context -->
    <div v-else-if="taskState?.state === 'capturing-context'" class="td__hero">
      <div class="td__hero-eyebrow">Capturing context…</div>
      <p class="tdc__lead">
        Waiting for the Primary conversation to write <code>CONTEXT.md</code> and <code>HANDOFF.md</code> from its own
        context. Nothing in the source code or project is touched during this step.
      </p>
      <button
        v-if="sourceWorkspaceAvailable"
        type="button"
        class="button td__hero-start"
        @click="$emit('open-primary')"
      >
        Open Primary
      </button>
      <p v-else class="tdc__warning">The Primary conversation's workspace is no longer available in this profile.</p>
    </div>

    <!-- brief-ready -->
    <div v-else-if="taskState?.state === 'brief-ready'" class="td__hero">
      <div class="td__hero-eyebrow">Brief ready</div>
      <p class="tdc__lead">
        Review what was captured, then start the baseline {{ companionRoleLabel }} review of the work already discussed
        in the Primary conversation.
      </p>

      <p v-if="contextHasOpenQuestions" class="tdc__warning">
        CONTEXT.md still lists open questions or ambiguities. The {{ companionRoleLabel }} will try to resolve them from
        evidence first — this does not block starting the loop.
      </p>

      <details class="tdc__accordion" open>
        <summary>Your focus <span class="tdc__accordion-file">TASK.md</span></summary>
        <pre class="tdc__preview">{{ taskFocusPreview || "No additional focus specified." }}</pre>
      </details>
      <details class="tdc__accordion" open>
        <summary>Captured context <span class="tdc__accordion-file">CONTEXT.md</span></summary>
        <pre class="tdc__preview">{{ contextPreview || "(not available)" }}</pre>
      </details>
      <details class="tdc__accordion">
        <summary>Current progress <span class="tdc__accordion-file">HANDOFF.md</span></summary>
        <pre class="tdc__preview">{{ handoffPreview || "(not available)" }}</pre>
      </details>

      <div class="tdc__hero-actions">
        <button type="button" class="button td__hero-start" @click="$emit('start')">
          Start {{ companionRoleLabel }} loop
        </button>
        <button type="button" class="td__link-btn" @click="$emit('open-assignment')">Edit before starting</button>
      </div>
    </div>

    <!-- awaiting-user -->
    <div v-else-if="taskState?.state === 'awaiting-user'" class="td__hero tdc__awaiting">
      <div class="td__hero-eyebrow">{{ companionRoleLabel }} needs your input</div>
      <div v-for="q in pendingQuestions" :key="q.id" class="tdc__question-card">
        <p class="tdc__question-id">{{ q.id }}</p>
        <p class="tdc__question-text">{{ q.question }}</p>
        <p class="tdc__question-why">{{ q.whyNeeded }}</p>
        <ul v-if="q.options?.length" class="tdc__question-options">
          <li v-for="(opt, i) in q.options" :key="i">{{ opt }}</li>
        </ul>
      </div>
      <label class="tdc__answer-label">
        <span>Your decision</span>
        <textarea v-model="answerDraft" rows="4" placeholder="Explain the decision the companion should apply…" />
      </label>
      <button type="button" class="button tdc__send-decision" :disabled="!answerDraft.trim()" @click="submitAnswer">
        Send decision
      </button>
    </div>

    <!-- completed / failed — structured report -->
    <div v-else-if="taskState?.state === 'completed' || taskState?.state === 'failed'" class="td__hero tdc__report">
      <div
        class="td__hero-eyebrow"
        :class="taskState?.state === 'completed' ? 'tdc__eyebrow--ok' : 'tdc__eyebrow--fail'"
      >
        {{
          taskState?.state === "completed"
            ? verdict?.advisories?.length
              ? "Completed with advice"
              : "Completed"
            : "Failed — max rounds reached"
        }}
      </div>
      <p class="tdc__lead">{{ verdict?.reason || lastReason || "" }}</p>

      <CompanionReportSections :verdict="verdict" :role="companionRole" :repeated-finding-ids="repeatedFindingIds" />

      <div class="tdc__hero-actions">
        <button type="button" class="td__link-btn" @click="$emit('reject-verdict')">Send back with feedback</button>
        <button type="button" class="td__link-btn" @click="$emit('reset')">Reset &amp; re-capture</button>
      </div>
    </div>

    <!-- paused -->
    <div v-else-if="taskState?.state === 'paused'" class="td__hero">
      <div class="td__hero-eyebrow">{{ pausedEyebrow }}</div>
      <p class="tdc__lead">{{ pausedHint }}</p>
    </div>

    <!-- idle -->
    <div v-else-if="taskState?.state === 'idle'" class="td__hero">
      <div class="td__hero-eyebrow">Not started</div>
      <p class="tdc__lead">
        Press <strong>Start capture</strong> to send a context-capture prompt into the existing Primary conversation.
        Nothing in the project is touched — the Primary only writes CONTEXT.md and HANDOFF.md.
      </p>
    </div>

    <!-- running / evaluating / judge-evaluating — active loop pipeline -->
    <div v-else class="tdc__pipeline-wrap">
      <div class="tdc__pipeline">
        <div
          v-for="step in pipelineSteps"
          :key="step.id"
          class="tdc__pipeline-step"
          :class="`tdc__pipeline-step--${step.status}`"
        >
          <span class="tdc__pipeline-dot" />
          <span class="tdc__pipeline-label">{{ step.label }}</span>
        </div>
      </div>

      <p v-if="completionEvidenceWithheld" class="tdc__warning">
        {{ companionRoleLabel }} found no blockers, but completion has to be signed off against a
        <code>VERIFICATION.md</code> for this round and there was none. Primary was asked to record it — this round was
        not consumed.
      </p>

      <div v-if="verificationCardVisible" class="tdc__verification-card">
        <p class="tdc__verification-status">
          Verification: <strong>{{ verificationStatusLabel }}</strong>
        </p>
        <ul v-if="verdict?.verificationReview?.evidenceReviewed?.length" class="tdc__verification-evidence">
          <li v-for="(line, i) in verdict.verificationReview.evidenceReviewed" :key="i">{{ line }}</li>
        </ul>
        <ul v-if="verdict?.verificationReview?.workerActionsRequired?.length" class="tdc__verification-actions">
          <li v-for="(action, i) in verdict.verificationReview.workerActionsRequired" :key="i">
            <code>{{ action.commandOrCheck }}</code> — {{ action.reason }}
          </li>
        </ul>
      </div>

      <div v-if="verdict && (verdict.blockingFindings?.length || verdict.advisories?.length)" class="tdc__report">
        <CompanionReportSections :verdict="verdict" :role="companionRole" :repeated-finding-ids="repeatedFindingIds" />
      </div>

      <p v-else class="td__empty">
        {{
          taskState?.state === "judge-evaluating"
            ? `${companionRoleLabel} is reviewing the current state…`
            : "Waiting for Primary to signal this round is done…"
        }}
      </p>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, inject, ref, watch } from "vue";
import { apiKey } from "../../types/keys.js";
import CompanionReportSections from "./CompanionReportSections.vue";

const props = withDefaults(
  defineProps<{
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    taskState?: Record<string, any> | null;
    workspaceCwd?: string;
    taskId?: string;
    sourceWorkspaceAvailable?: boolean;
  }>(),
  { taskState: null, workspaceCwd: "", taskId: "", sourceWorkspaceAvailable: true },
);

const emit = defineEmits<{
  "open-primary": [];
  "open-assignment": [];
  start: [];
  "reject-verdict": [];
  reset: [];
  "delete-task": [];
  answer: [payload: { questionIds: string[]; answer: string }];
}>();

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const api = inject<any>(apiKey);

const COMPANION_ROLE_LABELS: Record<string, string> = {
  reviewer: "Reviewer",
  planner: "Planner",
  consultant: "Consultant",
  critic: "Critic",
};
const companionRole = computed(() => props.taskState?.companionRole || "reviewer");
const companionRoleLabel = computed(() => COMPANION_ROLE_LABELS[companionRole.value] || "Judge");

const verdict = computed(() => props.taskState?.lastCompanionVerdict || null);
const repeatedFindingIds = computed(() => props.taskState?.repeatedBlockingFindingIds || []);
const lastReason = computed(() => {
  const rounds = props.taskState?.rounds || [];
  return rounds[rounds.length - 1]?.judgeReason || "";
});
const pendingQuestions = computed(() => props.taskState?.pendingQuestions || []);

// Renders its own terminal hero above every state branch, so the paused hints
// below never have to special-case it.
const primaryMissing = computed(() => Boolean(props.taskState?.primaryMissing));

const pausedEyebrow = computed(() => {
  if (props.taskState?.judgePolicyViolation) return "Paused: policy violation";
  return "Paused";
});

const pausedHint = computed(() => {
  if (props.taskState?.judgePolicyViolation) {
    return `${companionRoleLabel.value} hit a permission prompt during evaluation — it tried something outside its inspect-only scope, so the loop was paused instead of continuing. Check its panel, then Continue to re-run the evaluation.`;
  }
  const from = props.taskState?.pausedFromState || "";
  if (from === "capturing-context") return "Paused while capturing context. Open Primary to check, then Continue.";
  if (from === "judge-evaluating")
    return `Paused while ${companionRoleLabel.value} was evaluating. Continue to resume reading the verdict.`;
  if (from === "awaiting-user") return "Paused while awaiting your input. Continue to answer the open question.";
  return "Continue when ready, or Reset to start over.";
});

// --- Capture preview (brief-ready) — read-only file fetches ----------------

const taskFocusPreview = ref("");
const contextPreview = ref("");
const handoffPreview = ref("");

async function readTaskFile(name: string): Promise<string> {
  if (!api?.fileRead || !props.workspaceCwd || !props.taskId) return "";
  try {
    const result = await api.fileRead({
      rootPath: props.workspaceCwd,
      relativePath: `.strideterm/tasks/${props.taskId}/${name}`,
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return ((result as any)?.content ?? "") as string;
  } catch {
    return "";
  }
}

async function loadCapturePreview() {
  const [focus, context, handoff] = await Promise.all([
    readTaskFile("TASK.md"),
    readTaskFile("CONTEXT.md"),
    readTaskFile("HANDOFF.md"),
  ]);
  taskFocusPreview.value = focus;
  contextPreview.value = context;
  handoffPreview.value = handoff;
}

const contextHasOpenQuestions = computed(() => {
  const marker = "# Open questions or ambiguities";
  const idx = contextPreview.value.indexOf(marker);
  if (idx < 0) return false;
  const rest = contextPreview.value.slice(idx + marker.length).split(/\n#\s/)[0] || "";
  return rest.trim().length > 0 && !/^none\.?$/i.test(rest.trim());
});

watch(
  () => [props.taskState?.state, props.taskId],
  ([state]) => {
    if (state === "brief-ready") void loadCapturePreview();
  },
  { immediate: true },
);

// --- Awaiting-user answer ---------------------------------------------------
// Draft persists in sessionStorage keyed by taskId so a reload (or a mobile
// switch away to Primary and back) doesn't lose what the user was typing —
// plan §9.1. Purely a client-side convenience; it never becomes authoritative
// backend state until Send decision actually submits it.

const answerDraft = ref("");

function answerDraftStorageKey(taskId: string): string {
  return `companion-answer-draft:${taskId}`;
}

watch(
  () => props.taskId,
  (taskId) => {
    if (!taskId) {
      answerDraft.value = "";
      return;
    }
    try {
      answerDraft.value = sessionStorage.getItem(answerDraftStorageKey(taskId)) || "";
    } catch {
      answerDraft.value = "";
    }
  },
  { immediate: true },
);

watch(answerDraft, (val) => {
  if (!props.taskId) return;
  try {
    if (val) sessionStorage.setItem(answerDraftStorageKey(props.taskId), val);
    else sessionStorage.removeItem(answerDraftStorageKey(props.taskId));
  } catch {
    // sessionStorage unavailable (e.g. private browsing) — draft just won't
    // survive a reload; not fatal.
  }
});

function submitAnswer() {
  const text = answerDraft.value.trim();
  if (!text) return;
  const ids = pendingQuestions.value.map((q: { id: string }) => q.id);
  emit("answer", { questionIds: ids, answer: text });
  answerDraft.value = "";
}

// --- Active-loop pipeline ----------------------------------------------------

const PIPELINE_ORDER = ["running", "evaluating", "judge-evaluating"];
function pipelineStatus(stepState: string): string {
  const current = props.taskState?.state === "capturing-context" ? "running" : props.taskState?.state;
  const curIdx = PIPELINE_ORDER.indexOf(current);
  const stepIdx = PIPELINE_ORDER.indexOf(stepState);
  if (curIdx < 0 || stepIdx < 0) return "waiting";
  if (stepIdx < curIdx) return "done";
  if (stepIdx === curIdx) return "active";
  return "waiting";
}

const pipelineSteps = computed(() => [
  { id: "primary", label: "Primary", status: pipelineStatus("running") },
  { id: "verification", label: "Verification", status: pipelineStatus("evaluating") },
  { id: "companion", label: companionRoleLabel.value, status: pipelineStatus("judge-evaluating") },
]);

const verificationCardVisible = computed(() => Boolean(verdict.value?.verificationReview));
const verificationStatusLabel = computed(() => {
  // The runner's own reading of VERIFICATION.md wins over the Companion's
  // claim: the claim is what the completion floor checks, not what happened.
  const status = props.taskState?.companionEvidence?.status || verdict.value?.verificationReview?.recordStatus;
  const labels: Record<string, string> = {
    fresh: "Fresh",
    stale: "Stale",
    missing: "Missing",
    invalid: "Invalid",
    "not-required": "Not required",
    "not-provided": "Not provided",
  };
  return labels[status || ""] || "Unknown";
});

// The runner withheld a "complete" because it had no fresh record to sign off
// against — the loop goes back to running with the round intact, which would
// otherwise be indistinguishable from an ordinary "continue".
const completionEvidenceWithheld = computed(() => {
  const rounds = props.taskState?.rounds || [];
  return rounds[rounds.length - 1]?.action === "verification-required";
});
</script>

<style scoped>
.tdc__lead {
  margin: 0 0 12px;
  font-size: 13px;
  line-height: 1.5;
  opacity: 0.9;
}
.tdc__warning {
  margin: 0 0 12px;
  padding: 8px 10px;
  border-radius: 4px;
  background: rgba(255, 193, 7, 0.12);
  border: 1px solid rgba(255, 193, 7, 0.35);
  font-size: 12px;
}
.tdc__accordion {
  border: 1px solid var(--border, #333);
  border-radius: 4px;
  margin-bottom: 8px;
  padding: 6px 10px;
}
.tdc__accordion summary {
  cursor: pointer;
  font-size: 12px;
  font-weight: 600;
}
.tdc__accordion-file {
  font-weight: 400;
  opacity: 0.6;
  font-size: 11px;
  margin-left: 6px;
}
.tdc__preview {
  white-space: pre-wrap;
  word-break: break-word;
  font-size: 12px;
  line-height: 1.5;
  margin: 8px 0 0;
  max-height: 280px;
  overflow-y: auto;
}
.tdc__hero-actions {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-top: 12px;
  flex-wrap: wrap;
}
.tdc__awaiting {
  border-color: rgba(255, 193, 7, 0.4);
}
.tdc__question-card {
  border: 1px solid var(--border, #333);
  border-radius: 4px;
  padding: 10px 12px;
  margin-bottom: 10px;
}
.tdc__question-id {
  margin: 0 0 4px;
  font-size: 10px;
  font-weight: 700;
  opacity: 0.6;
}
.tdc__question-text {
  margin: 0 0 4px;
  font-size: 13px;
  font-weight: 600;
}
.tdc__question-why {
  margin: 0;
  font-size: 12px;
  opacity: 0.8;
}
.tdc__question-options {
  margin: 6px 0 0;
  padding-left: 18px;
  font-size: 12px;
}
.tdc__answer-label {
  display: block;
  margin-top: 8px;
}
.tdc__answer-label span {
  display: block;
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  opacity: 0.7;
  margin-bottom: 4px;
}
.tdc__answer-label textarea {
  width: 100%;
  box-sizing: border-box;
  resize: vertical;
}
.tdc__send-decision {
  margin-top: 10px;
}
/* Sticky "Send decision" above the mobile input bar + safe-area inset (plan
   §9.1) — on narrow/short viewports the answer action stays reachable
   without scrolling past the question cards. */
@media (max-width: 768px), (max-height: 500px) {
  .tdc__send-decision {
    position: sticky;
    bottom: calc(8px + env(safe-area-inset-bottom));
    width: 100%;
    z-index: 1;
  }
}
.tdc__eyebrow--ok {
  color: #80cbc4;
}
.tdc__eyebrow--fail {
  color: #ef9a9a;
}
.tdc__pipeline-wrap {
  padding: 4px 0;
}
.tdc__pipeline {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 16px;
}
.tdc__pipeline-step {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  opacity: 0.55;
}
.tdc__pipeline-step--active,
.tdc__pipeline-step--done {
  opacity: 1;
}
.tdc__pipeline-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--muted, #666);
}
.tdc__pipeline-step--active .tdc__pipeline-dot {
  background: #e65100;
}
.tdc__pipeline-step--done .tdc__pipeline-dot {
  background: #1b5e20;
}
.tdc__verification-card {
  border: 1px solid var(--border, #333);
  border-radius: 4px;
  padding: 10px 12px;
  margin-bottom: 14px;
  font-size: 12px;
}
.tdc__verification-status {
  margin: 0 0 6px;
}
.tdc__verification-evidence,
.tdc__verification-actions {
  margin: 6px 0 0;
  padding-left: 18px;
}
</style>
