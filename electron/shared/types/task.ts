export interface ProviderConfig {
  providerId: string;
  model: string;
}

export interface TaskVerdict {
  round: number;
  verdict: "pass" | "fail" | "stop";
  reason: string;
  timestamp: string;
}

export interface TaskRound {
  round: number;
  startedAt: string | null;
  finishedAt: string | null;
  verdict: TaskVerdict | null;
}

export type TaskExecutionState =
  | "idle"
  | "running"
  | "paused"
  | "done"
  | "failed"
  | "stopped"
  | "evaluating"
  | "showering"
  // Additional states used by AgentTaskRunner
  | "judge-evaluating"
  | "refreshing"
  | "completed"
  // Attached-mode (Companion loop) states — see docs/agent-task-runner.md
  | "capturing-context"
  | "brief-ready"
  | "awaiting-user"
  | string; // extensible

/** Judge/evaluator persona attached to an existing (external) Primary conversation. */
export type CompanionRole = "reviewer" | "planner" | "consultant" | "critic";

/**
 * How strongly the attached Judge's read-only/no-execution contract is
 * enforced by the underlying provider. Never a claim of an OS-level sandbox —
 * see plan §3.2 "Capability význam". Computed by the provider registry, not
 * user input.
 */
export type JudgeInspectionIsolation = "enforced" | "permission-gated" | "prompt-only";

// ---------------------------------------------------------------------------
// Companion verdict v1 (attached mode) — plain-TS mirror of the backend's
// zod-validated shape (electron/backend/agent-task-utils.ts:companionVerdictSchema).
// Duplicated here (not imported) because shared/types/task.ts must stay
// dependency-free for the frontend bundle; the backend is the sole writer and
// validator, so this is a read-only rendering contract for the Dashboard.
// ---------------------------------------------------------------------------

export interface CompanionFinding {
  id: string;
  title: string;
  category: string;
  evidence: string[];
  impact: string;
  requiredAction: string;
}

export interface CompanionAdvisory {
  id: string;
  title: string;
  evidence: string[];
  recommendation: string;
  tradeoff?: string;
}

export interface CompanionQuestionSnapshot {
  id: string;
  question: string;
  whyNeeded: string;
  options?: string[];
}

export interface VerificationReviewSnapshot {
  recordStatus: "not-required" | "missing" | "stale" | "fresh";
  evidenceReviewed: string[];
  workerActionsRequired: Array<{ commandOrCheck: string; expectedEvidence: string; reason: string }>;
}

export type CompanionRoleAnalysisSnapshot =
  | {
      type: "reviewer";
      requirementAudit: Array<{
        requirement: string;
        status: "verified" | "partial" | "missing" | "unclear";
        evidence: string[];
      }>;
    }
  | {
      type: "critic";
      steelman: string;
      hypotheses: Array<{
        hypothesis: string;
        strength: "verified" | "strong" | "speculative";
        disposition: "blocking" | "advisory" | "disproved";
        evidence: string[];
      }>;
    }
  | {
      type: "planner";
      planDocument: string;
      problemFrame: string;
      userBenefitAssessment: string;
      assumptions: Array<{ assumption: string; rationale: string; riskIfWrong: string }>;
      decisions: Array<{
        decision: string;
        chosenDefault: string;
        rationale: string;
        userBenefit: string;
        alternativesConsidered: string[];
      }>;
      coverageAudit: Array<{ area: string; status: "complete" | "partial" | "not-applicable"; evidence: string }>;
      openQuestions: Array<{
        question: string;
        whyUnresolved: string;
        assumedDefault: string;
        impactIfDifferent: string;
        resolveBy: string;
      }>;
    }
  | {
      type: "consultant";
      objective: string;
      recommendedNextStep: string;
      decisions: Array<{
        decision: string;
        options: Array<{
          option: string;
          benefits: string[];
          costsAndRisks: string[];
          reversibility: "easy" | "moderate" | "hard";
        }>;
        recommendation: string;
      }>;
    };

export interface CompanionVerdictSnapshot {
  schemaVersion: 1;
  role: CompanionRole;
  phase: "baseline" | "round-review" | "recovery";
  round: number;
  /** Which evaluation of that phase+round this verdict answers — see
   * TaskState.companionEvaluationAttempt. Absent only for a verdict written
   * before an in-flight task was upgraded to the attempt-aware protocol. */
  evaluationAttempt?: number;
  verdict: "complete" | "continue" | "needs-input";
  reason: string;
  verificationReview: VerificationReviewSnapshot;
  roleAnalysis: CompanionRoleAnalysisSnapshot;
  blockingFindings: CompanionFinding[];
  advisories: CompanionAdvisory[];
  questions: CompanionQuestionSnapshot[];
}

export interface TaskState {
  taskId: string;
  description: string;
  parentWorkspaceId: string;
  worktreeBase: string;
  worktreeBranch: string;
  workerPanelId: string;
  judgePanelId: string;
  maxRounds: number;
  // ---- Attached mode (Companion loop) metadata. Absent/undefined means
  // "standard" task — see docs/agent-task-runner.md "Companion loop". ----
  /** "standard" (default, Worker+Judge task) or "attached" (Companion loop
   * over an existing live conversation). Absent is treated as "standard". */
  mode?: "standard" | "attached";
  /** Attached only: the id of the *source* workspace whose live conversation
   * is the Primary. `workerPanelId` above is then a panel id that belongs to
   * THIS workspace, not the task workspace — see sessionIdFor(). */
  workerWorkspaceId?: string;
  /** Attached only: which Companion persona is evaluating. */
  companionRole?: CompanionRole;
  /** Attached only: sanitized/fenced optional user focus captured at create time. */
  companionFocus?: string;
  /** Attached only: ISO timestamp set when the capture prompt is injected into
   * the Primary. CONTEXT.md/HANDOFF.md only count as captured when they were
   * written AFTER this instant — otherwise a Reset & Retry would immediately
   * re-accept the previous attempt's capture files (which nothing deletes) as
   * if the Primary had just written them. */
  captureStartedAt?: string;
  /** Attached only: ISO timestamp set when the user confirms the captured
   * brief and starts the baseline Companion evaluation (Brief ready -> Start). */
  contextApprovedAt?: string;
  /** Attached only: ISO timestamp of the last time companion feedback (or the
   * baseline "continue") was injected into the Primary session. Used to
   * decide whether a VERIFICATION.md on disk is fresh (written after this
   * timestamp) or stale (left over from before the feedback that requested it). */
  companionLastFeedbackAt?: string;
  /** Attached only: set when the last Companion verdict's
   * verificationReview.recordStatus was "not-required" (e.g. Planner
   * reviewing a plan document with no code yet) — suppresses the runner's
   * own missing-VERIFICATION.md protocol nudge for the next round until the
   * Companion says otherwise. */
  verificationNotRequired?: boolean;
  /** Attached only: what the runner ACTUALLY handed to the in-flight Companion
   * evaluation as verification evidence, recorded when the evaluation prompt is
   * built. The verdict's own `verificationReview` is only the Companion's
   * claim — a baseline (which is handed no record at all) could otherwise be
   * signed off as "fresh". `#handleCompanionVerdict` checks the claim against
   * this before letting a code-accepting role complete. "not-provided" means
   * no record was passed to that evaluation. */
  companionEvidence?: {
    status: "not-provided" | "missing" | "invalid" | "stale" | "fresh";
    /** mtime of the VERIFICATION.md that was read, ISO — null when none. */
    mtimeIso: string | null;
    /** "Evaluation target: N" the record was tagged for — null when none. */
    round: number | null;
  };
  /** Attached only: set when the runner paused the task because the
   * Judge/Companion hit a permission prompt during evaluation —
   * a signal it tried something outside its allowlisted task-artifact write
   * (plan section 10). Distinguishes this from an ordinary pause/dropout so
   * the Dashboard can say why. Cleared on resume/reset. */
  judgePolicyViolation?: boolean;
  /** Attached only: set by app-restart recovery when the source workspace or
   * panel this task was attached to no longer exists (plan §8.7 step 5) — the
   * Dashboard shows "Primary conversation no longer exists" instead of the
   * generic paused hint. MVP has no interactive reattach; recovery from this
   * is delete-and-recreate once a live conversation exists again. */
  primaryMissing?: boolean;
  /** Attached only: blocking finding IDs that have now appeared in 3 or more
   * rounds without being resolved (plan §4.15) — the Dashboard offers a
   * "Pause and review" hint for these. The runner itself never auto-changes
   * the verdict or pauses because of this; it's advisory to the user only. */
  repeatedBlockingFindingIds?: string[];
  /** Attached only: which evaluation phase the last companion request was
   * for. Read back — together with `companionEvaluationAttempt` below — to
   * validate a verdict on disk belongs to the evaluation that was actually
   * requested (plan §4.4). */
  companionPhase?: "baseline" | "round-review" | "recovery";
  /** Attached only: monotonic counter identifying the evaluation currently in
   * flight, bumped by every companion evaluation request and echoed by the
   * Companion in verdict.json.
   *
   * role+phase+round alone do NOT identify an evaluation: both a `needs-input`
   * answer and a withheld completion re-evaluate the SAME phase and round, so a
   * verdict written late by the previous attempt's turn would otherwise pass
   * every identity check and be processed as the answer to the new one.
   * Deliberately never reset (not even by Reset) — monotonicity is what makes
   * a leftover verdict detectable. */
  companionEvaluationAttempt?: number;
  /** Attached only: the attempt whose verdict has already been processed. The
   * watcher backstop compares this against `companionEvaluationAttempt`; the
   * round chip's `judgeVerdict` cannot serve as that marker, because it stays
   * filled in from the previous evaluation of the same round and would make
   * the backstop skip a genuinely unprocessed verdict. */
  companionVerdictHandledAttempt?: number;
  /** Attached only: outstanding questions from the last "needs-input"
   * companion verdict — rendered by the Dashboard's awaiting-user view and
   * consumed by answerCompanionTask. Empty once answered. */
  pendingQuestions?: Array<{ id: string; question: string; whyNeeded: string; options?: string[] }>;
  /** Attached only: the last VALID companion verdict, kept around purely for
   * Dashboard rendering (structured report, verification card, role-specific
   * summary) — the runner's own control flow only ever reads verdict.json on
   * disk, never this field. Replaced on every fresh valid verdict; a repair
   * nudge for an invalid/stale file does not touch it. */
  lastCompanionVerdict?: CompanionVerdictSnapshot | null;
  showerInterval: number;
  state: TaskExecutionState;
  currentRound: number;
  rounds: TaskRound[];
  lastShowerRound: number;
  lastJudgeInstructions: string;
  workerProviderConfig: ProviderConfig | null;
  judgeProviderConfig: ProviderConfig | null;
  promptSent: boolean;
  pausedFromState: string;
  showerResumePrompt: string;
  startedAt: string | null;
  totalPausedMs: number;
  pausedAt: string | null;
  finishedAt: string | null;
  // ISO timestamp at which a worker rate-limit (Claude Code "You've hit your
  // limit · resets HH:MM") expires. While set in the future, onAgentIdle for
  // the worker is suppressed so the runner doesn't try to evaluate or re-prompt
  // a paused worker. The runner schedules a resume nudge for this time + grace.
  rateLimitedUntil: string | null;
  // Set on first prompt-build after probing disk: true when WORKER.md exists
  // (new split format), false for legacy tasks with rules embedded in TASK.md.
  // Persists for the task's lifetime so prompt builders can branch without
  // re-probing each round.
  useWorkerFile?: boolean;
  // Set to true by resetTask. The next startTask sends `/clear` to the
  // Worker and Judge sessions before injecting prompts so neither agent
  // carries conversational context from the previous run (which would
  // shadow an updated brief or make the worker think work is already done).
  // Cleared after the clears fire so Resume / mid-task starts don't wipe
  // running context.
  needsContextClear?: boolean;
  // ISO timestamp of workspace creation (NOT first start). Used by the sidebar
  // card to render a "2m / 1h / 3d" relative-age chip so multiple agents on
  // the same parent can be told apart at a glance. Optional for backward
  // compatibility with tasks created before this field existed — those just
  // render without the chip.
  createdAt?: string;
  // Stable per-parent ordinal. Assigned at creation as max(siblings) + 1,
  // siblings being other task workspaces with the same parentWorkspaceId.
  // Rendered as " #N" appended to the workspace name in the sidebar. Stable
  // across deletions: removing #2 leaves #1 and #3 unchanged so the user can
  // refer to a task by its number without renumbering surprises. Optional
  // for backward compat — pre-existing tasks render without the suffix.
  sequenceNumber?: number;
}

export interface TaskWorkspace {
  id: string;
  name: string;
  cwd: string;
  task: TaskState;
}
