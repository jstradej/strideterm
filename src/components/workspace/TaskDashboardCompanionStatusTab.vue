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

    <!-- Everything below shares one always-present explanation of the loop's
         position: which step it is on, who it is waiting for, why it is waiting
         and what happens next. The per-state blocks that follow carry only the
         actions and the data, so nothing has to be inferred from a state badge.
         primaryMissing is exempt: its terminal hero above already IS that
         explanation, and there is no loop left to place on the pipeline. -->
    <template v-else>
      <div class="tdc__now">
        <div class="tdc__now-head">
          <span class="td__hero-eyebrow" :class="now.toneClass">{{ now.headline }}</span>
          <span class="tdc__now-actor" :class="`tdc__now-actor--${now.actorKind}`">
            {{ now.actorKind === "none" ? now.actorLabel : `Waiting on ${now.actorLabel}` }}
          </span>
        </div>
        <p class="tdc__now-what">{{ now.what }}</p>
        <p class="tdc__now-line"><span class="tdc__now-key">Why</span>{{ now.why }}</p>
        <p v-if="now.next" class="tdc__now-line"><span class="tdc__now-key">Next</span>{{ now.next }}</p>

        <div class="tdc__pipeline">
          <div
            v-for="step in pipelineSteps"
            :key="step.id"
            class="tdc__pipeline-step"
            :class="`tdc__pipeline-step--${step.status}`"
            :title="step.hint"
          >
            <span class="tdc__pipeline-dot" />
            <span class="tdc__pipeline-label">{{ step.label }}</span>
          </div>
        </div>
      </div>

      <!-- capturing-context -->
      <div v-if="taskState?.state === 'capturing-context'" class="td__hero">
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
        <p v-if="contextHasOpenQuestions" class="tdc__warning">
          CONTEXT.md still lists open questions or ambiguities. The {{ companionRoleLabel }} will try to resolve them
          from evidence first — this does not block starting the loop.
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
        <CompanionReportSections :verdict="verdict" :role="companionRole" :repeated-finding-ids="repeatedFindingIds" />

        <div class="tdc__hero-actions">
          <button type="button" class="td__link-btn" @click="$emit('reject-verdict')">Send back with feedback</button>
          <button type="button" class="td__link-btn" @click="$emit('reset')">Reset &amp; re-capture</button>
        </div>
      </div>

      <!-- running / evaluating / judge-evaluating / refreshing — round detail -->
      <div v-else-if="isLoopState" class="tdc__pipeline-wrap">
        <p v-if="completionEvidenceWithheld" class="tdc__warning">
          {{ companionRoleLabel }} found no blockers, but completion has to be signed off against a
          <code>VERIFICATION.md</code> for this round and there was none. Primary was asked to record it — this round
          was not consumed.
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
          <CompanionReportSections
            :verdict="verdict"
            :role="companionRole"
            :repeated-finding-ids="repeatedFindingIds"
          />
        </div>
      </div>
    </template>
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

// Paused splits into the two halves the panel keeps apart: why the loop is
// sitting still, and what Continue will actually resume into. Which phase it
// stopped in is carried by the pipeline, so neither line repeats it.
const pausedWhy = computed(() => {
  if (props.taskState?.judgePolicyViolation) {
    return `${companionRoleLabel.value} hit a permission prompt during evaluation — it tried something outside its inspect-only scope, so the loop was paused instead of continuing.`;
  }
  return "A paused loop sends nothing to either side — it keeps its rounds and resumes from where it stopped.";
});

const pausedNext = computed(() => {
  if (props.taskState?.judgePolicyViolation) {
    return `Check the ${companionRoleLabel.value}'s panel, then Continue to re-run the evaluation.`;
  }
  const from = props.taskState?.pausedFromState || "";
  if (from === "capturing-context") return "Open Primary to check what it wrote, then Continue.";
  if (from === "judge-evaluating") return "Continue resumes reading the verdict.";
  if (from === "awaiting-user") return "Continue brings the open question back for your answer.";
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

// --- Pipeline ----------------------------------------------------------------
// Four phases of one round, shown in every state so the loop's position is
// always visible — including before it starts (all waiting) and after it ends
// (all done). Rounds 2..n repeat phases 1-3; the Round chip in the Dashboard
// header carries the count.

const PHASE_CAPTURE = 0;
const PHASE_PRIMARY = 1;
const PHASE_VERIFICATION = 2;
const PHASE_COMPANION = 3;

/** Phase a state sits in, and how many phases are already behind it. */
const PHASE_BY_STATE = new Map<string, { active: number; done: number }>([
  ["idle", { active: -1, done: 0 }],
  ["capturing-context", { active: PHASE_CAPTURE, done: 0 }],
  ["brief-ready", { active: -1, done: 1 }],
  ["running", { active: PHASE_PRIMARY, done: 1 }],
  ["refreshing", { active: PHASE_PRIMARY, done: 1 }],
  ["evaluating", { active: PHASE_VERIFICATION, done: 2 }],
  ["judge-evaluating", { active: PHASE_COMPANION, done: 3 }],
  ["awaiting-user", { active: PHASE_COMPANION, done: 3 }],
  ["completed", { active: -1, done: 4 }],
  ["failed", { active: -1, done: 4 }],
]);

// A paused loop keeps the position it was paused in — "paused" itself says
// nothing about which phase the user will come back to.
const currentPhase = computed(() => {
  const state = props.taskState?.state || "idle";
  const key = state === "paused" ? props.taskState?.pausedFromState || "" : state;
  return PHASE_BY_STATE.get(key) || { active: -1, done: 0 };
});

const pipelineSteps = computed(() => {
  const { active, done } = currentPhase.value;
  const role = companionRoleLabel.value;
  return [
    { id: "capture", label: "Capture", index: PHASE_CAPTURE, hint: "Primary writes CONTEXT.md and HANDOFF.md" },
    { id: "primary", label: "Primary", index: PHASE_PRIMARY, hint: "Primary works, then signals the round is done" },
    {
      id: "verification",
      label: "Verification",
      index: PHASE_VERIFICATION,
      hint: "This round's VERIFICATION.md record is checked",
    },
    { id: "companion", label: role, index: PHASE_COMPANION, hint: `${role} evaluates and returns a verdict` },
  ].map((step) => ({
    ...step,
    status: step.index === active ? "active" : step.index < done ? "done" : "waiting",
  }));
});

const isLoopState = computed(() =>
  ["running", "evaluating", "judge-evaluating", "refreshing"].includes(props.taskState?.state || ""),
);

// --- What is happening, and why ---------------------------------------------
// One explanation per state, in the same four slots every time: the state's
// own name, who the loop is waiting for, why it is waiting there (the condition
// that has to be met), and what happens once it is. Written so the user never
// has to know the runner's vocabulary to follow along.

const PAUSED_PHASE_LABELS: Record<string, string> = {
  "capturing-context": "context capture",
  running: "the Primary's round",
  evaluating: "the verification check",
  "judge-evaluating": "the evaluation",
  "awaiting-user": "your decision",
};

interface NowPanel {
  headline: string;
  /** primary | companion | you | none — drives the actor chip's colour. */
  actorKind: string;
  actorLabel: string;
  what: string;
  why: string;
  next: string;
  toneClass: string;
}

const now = computed<NowPanel>(() => {
  const role = companionRoleLabel.value;
  const state = props.taskState?.state || "idle";
  const round = props.taskState?.currentRound || 0;
  const maxRounds = props.taskState?.maxRounds || 10;
  const reason = verdict.value?.reason || lastReason.value || "";

  switch (state) {
    case "capturing-context":
      return {
        headline: "Capturing context…",
        actorKind: "primary",
        actorLabel: "Primary",
        what: "The Primary conversation is writing CONTEXT.md and HANDOFF.md from its own context.",
        why: `${role} never reads the conversation itself — it works from those two files, so they have to exist before any review can start. Nothing in the project is touched during this step.`,
        next: "Once both files land you can check the brief and start the loop.",
        toneClass: "",
      };
    case "brief-ready":
      return {
        headline: "Brief ready",
        actorKind: "you",
        actorLabel: "you",
        what: "Context is captured and nothing is running.",
        why: "You get the last word on scope before any rounds are spent — what CONTEXT.md says is what the loop will hold the work to.",
        next: `Start ${role} loop runs a baseline review of the work already discussed in the Primary conversation.`,
        toneClass: "",
      };
    case "running":
      return {
        headline: "Primary is working",
        actorKind: "primary",
        actorLabel: "Primary",
        what: reason
          ? `Round ${round}/${maxRounds}: the Primary is addressing the ${role}'s findings.`
          : `Round ${round}/${maxRounds}: the Primary is working on the captured scope.`,
        why: reason
          ? `${role} sent it back: ${reason}`
          : "The loop only advances when the Primary signals its round is done — until then nothing is evaluated.",
        next: `On that signal this round's VERIFICATION.md record is checked, then ${role} evaluates the result.`,
        toneClass: "",
      };
    case "refreshing":
      return {
        headline: "Refreshing context",
        actorKind: "primary",
        actorLabel: "Primary",
        what: "The Primary is re-stating the current context.",
        why: "The captured record drifted from where the work actually is, so it is being brought back up to date before the next review.",
        next: `Back to the ${role} evaluation once the refresh lands.`,
        toneClass: "",
      };
    case "evaluating":
      return {
        headline: "Checking the record",
        actorKind: "companion",
        actorLabel: role,
        what: `Round ${round}/${maxRounds} finished — its VERIFICATION.md record is being checked.`,
        why: "A sign-off only counts against a record written in THIS round; a stale or missing one can't support one.",
        next: `${role} evaluates next and returns continue, complete, or a question for you.`,
        toneClass: "",
      };
    case "judge-evaluating":
      return {
        headline: `${role} is evaluating`,
        actorKind: "companion",
        actorLabel: role,
        what: `${role} is reading the current state of the work and writing a verdict. It inspects only — it never runs project code.`,
        why: `Every round ends with a ${role} verdict; that verdict is what decides whether the Primary gets another round.`,
        next: "Findings go back to the Primary, or the loop signs off, or it stops to ask you something.",
        toneClass: "",
      };
    case "awaiting-user":
      return {
        headline: `${role} needs your input`,
        actorKind: "you",
        actorLabel: "you",
        what: pendingQuestions.value.length
          ? `The loop stopped on ${pendingQuestions.value.length} open question${pendingQuestions.value.length > 1 ? "s" : ""} it will not answer for you.`
          : "The loop stopped for a decision only you can make.",
        why:
          pendingQuestions.value[0]?.whyNeeded ||
          `${role} found more than one defensible answer and won't guess which one you want.`,
        next: "Your decision is passed to the Primary and the loop picks up from there.",
        toneClass: "",
      };
    case "paused": {
      const from = PAUSED_PHASE_LABELS[props.taskState?.pausedFromState || ""] || "";
      return {
        headline: pausedEyebrow.value,
        actorKind: "none",
        actorLabel: "Nothing running",
        what: from ? `Stopped during ${from} — no prompt is in flight.` : "Stopped — no prompt is in flight.",
        why: pausedWhy.value,
        next: pausedNext.value,
        toneClass: props.taskState?.judgePolicyViolation ? "tdc__eyebrow--fail" : "",
      };
    }
    case "completed":
      return {
        headline: verdict.value?.advisories?.length ? "Completed with advice" : "Completed",
        actorKind: "none",
        actorLabel: "Finished",
        what: `${role} signed off after ${round} round${round === 1 ? "" : "s"}. The Primary tab has gone back to its own workspace.`,
        why: reason || `${role} was left with no blocking findings and a verification record to sign off against.`,
        next: "Send back with feedback for one more round, or Reset & re-capture to start from a fresh context.",
        toneClass: "tdc__eyebrow--ok",
      };
    case "failed":
      return {
        headline: "Failed — max rounds reached",
        actorKind: "none",
        actorLabel: "Finished",
        what: `The loop used all ${maxRounds} rounds without ${role} signing off.`,
        why: reason || `${role} still had blocking findings when the last round ran out.`,
        next: "Send back with feedback to give it another round, or Reset & re-capture.",
        toneClass: "tdc__eyebrow--fail",
      };
    default:
      return {
        headline: "Not started",
        actorKind: "you",
        actorLabel: "you",
        what: "Nothing has been sent to the Primary conversation yet.",
        why: `${role} reviews written records rather than the chat log, so the loop opens by asking the Primary to write its own context down.`,
        next: "Start capture sends that one prompt — the Primary only writes CONTEXT.md and HANDOFF.md, nothing in the project is touched.",
        toneClass: "",
      };
  }
});

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
/* Always-present "what is happening, and why" panel. Deliberately the loudest
   thing in the tab: on a three-pane task layout the Dashboard is often the only
   pane the user reads before deciding whether to intervene. */
.tdc__now {
  border: 1px solid var(--border, #333);
  border-left: 3px solid var(--accent, #7c4dff);
  border-radius: 4px;
  padding: 10px 12px;
  margin-bottom: 14px;
}
.tdc__now-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  flex-wrap: wrap;
  margin-bottom: 6px;
}
.tdc__now-actor {
  font-size: 10px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  padding: 2px 7px;
  border-radius: 10px;
  white-space: nowrap;
  background: rgba(255, 255, 255, 0.06);
  color: var(--muted, #888);
}
.tdc__now-actor--primary {
  background: rgba(27, 94, 32, 0.35);
  color: #a5d6a7;
}
.tdc__now-actor--companion {
  background: rgba(230, 81, 0, 0.3);
  color: #ffcc80;
}
.tdc__now-actor--you {
  background: rgba(255, 193, 7, 0.2);
  color: #ffe082;
}
.tdc__now-what {
  margin: 0 0 8px;
  font-size: 13px;
  line-height: 1.5;
  font-weight: 600;
}
.tdc__now-line {
  margin: 0 0 4px;
  font-size: 12px;
  line-height: 1.5;
  opacity: 0.85;
}
/* Fixed-width key column so Why/Next line up as a pair the eye can skim. */
.tdc__now-key {
  display: inline-block;
  min-width: 42px;
  font-size: 10px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  opacity: 0.55;
  margin-right: 4px;
}
.tdc__pipeline-wrap {
  padding: 4px 0;
}
.tdc__pipeline {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  margin-top: 10px;
}
.tdc__pipeline-step {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  opacity: 0.55;
}
/* Connector — reads the row as a sequence rather than four separate chips. */
.tdc__pipeline-step:not(:last-child)::after {
  content: "";
  width: 12px;
  height: 1px;
  background: var(--border, #333);
  margin-left: 2px;
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
