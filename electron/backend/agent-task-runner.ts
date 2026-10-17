/// <reference types="node" />
import { randomUUID } from "node:crypto";
import { access, readFile, writeFile, rm } from "node:fs/promises";
import { watch as fsWatch } from "node:fs";
import type { FSWatcher } from "node:fs";
import path from "node:path";
import { Effect } from "effect";
import { getLogger } from "./logger.js";
import type { Logger } from "./logger.js";
import { runEffect } from "./effect/runtime.js";
import { TaskFileError } from "./effect/errors/task-errors.js";
import { getProvider, parseProviderFromCommand } from "./providers/provider-registry.js";
import type { ParsedProviderConfig } from "./providers/provider-registry.js";
import type { RateLimitMatch } from "./runtime-utils.js";
import {
  VERDICT_FILE,
  TASK_FILE,
  TODO_FILE,
  JUDGE_TODO_FILE,
  WORK_LOCK_FILE,
  TASK_LOG_FILE,
  promptFileFor,
  HANDOFF_FILE,
  CONTEXT_FILE,
  VERIFICATION_FILE,
  MAX_OUTPUT_TAIL,
  FILE_PROMPT_THRESHOLD,
  DEFAULT_SHOWER_INTERVAL,
  taskDir,
  taskDirRel,
  fenceUserInput,
  tailLines,
  companionVerdictContract,
  COMPLETION_REQUIRES_FRESH_VERIFICATION,
} from "./agent-task-utils.js";
import type { CompanionVerdict } from "./agent-task-utils.js";
import {
  buildInitialWorkerPrompt,
  buildRePrompt,
  buildJudgePrompt,
  buildJudgeFeedbackPrompt,
  buildUserFeedbackPrompt,
  buildRecoveryPrompt,
  buildContextCapturePrompt,
  buildCompanionPrompt,
  buildCompanionFeedbackPrompt,
  buildCompanionUserFeedbackPrompt,
  buildVerificationNudgePrompt,
  buildCompletionEvidencePrompt,
  buildCompanionAnswerPrompt,
  buildAttachedCompanionRecoveryPrompt,
} from "./agent-task-prompts.js";
import { execCommand } from "./agent-task-exec.js";
import type { ExecResult } from "./agent-task-exec.js";
import {
  appendUserClarification,
  cleanupTaskFiles as cleanupTaskFilesImpl,
  clearVerdict,
  ensureGitIgnore,
  readCaptureFiles,
  readCompanionVerdict,
  readTaskDescription,
  readTaskMd,
  readVerdict,
  readVerificationRecord,
  runBuiltInChecks,
  taskHasWorkerFile,
  validateCaptureFiles,
  waitForFile,
  writeCompanionInitialFiles,
  writeTaskFiles,
  writeVerificationTemplate,
  writeVerificationTemplateReversibly,
} from "./agent-task-files.js";
import type { VerificationRecord } from "./agent-task-files.js";
import { ensureGitRepo, getGitContext } from "./agent-task-git.js";
import type { AppState, WorkspaceState, RecoveryCandidate } from "../shared/types/state.js";
import type { CompanionRole, TaskState } from "../shared/types/task.js";
import { formatWorkspaceDisplayName } from "../shared/workspace-display.js";
import { sessionIdFor as sharedSessionIdFor } from "../shared/task-states.js";
import type { TaskBindingRole } from "../shared/task-states.js";

const log: Logger = getLogger("task-runner");
const COPILOT_PROGRAMMATIC_JUDGE_PROMPT_FILE = "JUDGE_INPUT.md";
const COPILOT_PROGRAMMATIC_JUDGE_TIMEOUT_MS = 180_000;

// ------ Types -------

/** Full task state as used internally (extends persisted TaskState with runtime fields) */
interface RuntimeTaskState extends TaskState {
  judgeNudged?: boolean;
  // Attached mode only — see docs/agent-task-runner.md.
  /** True once a capture-incomplete nudge has been sent to Primary; a second
   * incomplete idle pauses instead of nudging forever. */
  captureNudged?: boolean;
  /** Which evaluation phase the last companion request was for — read back
   * by #handleCompanionVerdict / recovery to validate the verdict on disk. */
  companionPhase?: "baseline" | "round-review" | "recovery";
  /** How many times the runner has asked the Companion to rewrite a malformed
   * or stale verdict for the CURRENT evaluation. Deliberately not `judgeNudged`:
   * that one boolean is shared with the "no file at all" branch, so a
   * missing-then-malformed sequence used to get zero repair attempts, and one
   * rejection was enough to pause a task the Companion could still have fixed. */
  companionRepairAttempts?: number;
  /** The rejected verdict bytes the last repair request was about. Several idle
   * signals arrive per Companion turn (hook:stop, notification, the watcher
   * backstop) and each re-reads the same unchanged file — without this they
   * would burn the whole repair budget on one rejection. */
  companionRepairFingerprint?: string;
  /** Questions from the last "needs-input" companion verdict, surfaced by
   * the Dashboard and consumed by answerCompanionTask. */
  pendingQuestions?: Array<{ id: string; question: string; whyNeeded: string; options?: string[] }>;
  // showerResumePrompt, pausedFromState, promptSent are already in TaskState
  [key: string]: unknown; // index signature for TaskData compatibility in prompts
}

export const COMPANION_ROLE_DISPLAY_NAMES: Record<CompanionRole, string> = {
  reviewer: "Reviewer",
  planner: "Planner",
  consultant: "Consultant",
  critic: "Critic",
};

/** A workspace that has a task attached (narrowed from WorkspaceState) */
interface TaskWorkspaceState extends WorkspaceState {
  task: RuntimeTaskState;
}

interface TaskOperationContext {
  readonly id: number;
  readonly label: string;
  readonly workspaceId: string;
  readonly taskId: string;
  readonly mode: string;
  readonly lifecycleEpoch: number;
  readonly cwd: string;
  readonly workerPanelId: string;
  readonly judgePanelId: string;
  readonly workerWorkspaceId: string;
  readonly round?: number;
  readonly checksRound: boolean;
  readonly evaluationAttempt?: number;
  readonly checksEvaluationAttempt: boolean;
  readonly sessionEpochs: Record<string, number>;
  /** Which role each `sessionEpochs` key was captured for — diagnostics only. */
  readonly sessionRoles: Readonly<Record<string, TaskBindingRole>>;
  /** Date.now() at capture — lets a refusal report how long the step ran. */
  readonly capturedAt: number;
  /** Set by an operation that races the hook-driven main line by design. */
  readonly expectedRefusal?: ExpectedTaskOperationRefusal;
  rejectedLogged: boolean;
}

/** One identity check a stale task operation failed. Ids, states, counters and
 * (only for the cwd check) paths — never prompt text or terminal content. */
interface TaskOperationCheckFailure {
  readonly check: string;
  readonly expected: unknown;
  readonly actual: unknown;
  readonly sessionId?: string;
  readonly role?: TaskBindingRole;
}

/**
 * A refusal the operation (or one call site) declares normal: a backstop, a
 * timer or a probe that loses to the step it races. When every failed check is
 * in `checks` (or `checks` is omitted), the refusal is logged at debug with
 * `reason` instead of as a possibly stuck task.
 */
interface ExpectedTaskOperationRefusal {
  readonly reason: string;
  readonly checks?: ReadonlySet<string>;
}

/**
 * Checks whose failure means the task itself moved on — disposed runner, a
 * lifecycle advance (start / resume / reset / reject / pause / complete / fail
 * all advance it), the workspace or task gone, or a different task. A step
 * refused for one of these is expected and logs at debug. Any other refusal —
 * a session incarnation (user input into an agent panel, a respawn, a panel
 * closed), a moved panel / cwd / mode, or a state or round the task reached
 * without a lifecycle change — stops the step with nothing else to drive the
 * task, so it logs at warn. See #reportStaleTaskOperation.
 */
const LIFECYCLE_EXPLAINED_CHECKS: ReadonlySet<string> = new Set([
  "disposed",
  "lifecycleEpoch",
  "workspace",
  "task",
  "taskId",
]);

/**
 * The checks another runner step trips when it advances the task — a forward
 * transition (running → evaluating → judge-evaluating → running, the attached
 * equivalents), a new round or a new Companion evaluation attempt. None of them
 * advances the lifecycle epoch. A main-line step holds the ownership guard for
 * its phase, so for it such a change is unexpected and stays a warn; only an
 * operation that races the main line by design (the watcher backstop, the
 * rate-limit confirm window, a replay queued behind a pass) declares it.
 */
const TASK_ADVANCED_CHECKS: ReadonlySet<string> = new Set(["state", "round", "evaluationAttempt"]);

/**
 * Why a pending injection was cancelled, recorded so the step it belonged to
 * can say so when it finds its controller gone. Every reason except the
 * session-level ones is a lifecycle event or a newer injection that takes over.
 */
type InjectionCancelReason =
  | "superseded-by-new-injection"
  | "task-left-active-state"
  | "managed-session-restart"
  | "disposed"
  | "session-exit"
  | "session-reset";

const EXPLAINED_INJECTION_CANCELS: ReadonlySet<InjectionCancelReason> = new Set([
  "superseded-by-new-injection",
  "task-left-active-state",
  "managed-session-restart",
  "disposed",
]);

/** How one runner write (text + Enter) ended — see #deliverRunnerText. */
type RunnerWriteOutcome = "submitted" | "interrupted" | "stopped";

/** What a polite runner write is waiting for — see #politeWaitReason. */
type PoliteWaitReason =
  "dialog-open" | "ui-uncertain" | "user-typing" | "agent-turn" | "agent-answer" | "submit-pending";

/**
 * What the agent's screen shows, as far as the runner can know it:
 *  - "prompt"    — at its prompt (nothing signalled otherwise);
 *  - "dialog"    — a permission / question / elicitation dialog is up;
 *  - "uncertain" — the user pressed Esc twice in a row, which may have
 *    opened a selector where an Enter picks an old message: Claude Code's
 *    rewind picker (two Escs within 800 ms) or Codex's backtrack (two Escs
 *    with no other key between them, however far apart). The runner cannot
 *    see the gap the agent saw, so any two Escs in a row count. Only a
 *    submitted prompt (UserPromptSubmit) or the user's own word settles it
 *    — never a turn-end signal, which might arrive with the selector open.
 * A single Esc only closes a menu, rejects a dialog or interrupts the turn —
 * the agent is back at its prompt after it. Anything but "prompt" blocks
 * every runner write — see #politeWaitReason.
 */
type SessionUiState = "prompt" | "dialog" | "uncertain";

/**
 * What the runner knows about the user's hands in one task session — fed by
 * the user's terminal input (onUserInput) and the idle / hook signals the
 * runner already receives. Diagnostics and polite injection only; never task
 * state, never persisted, never logged as text.
 */
interface SessionUserActivity {
  /** Date.now() of the user's last real keystroke or paste; 0 = never. */
  lastInputAt: number;
  /** The composer probably holds text the user has not submitted. */
  pending: boolean;
  /** Last input character — a backslash or ESC before Enter makes it a newline. */
  lastChar: string;
  /** A turn is running since the last submit seen (the user's, ours, or a hook). */
  turnActive: boolean;
  /** …and that turn answers the user (their Enter, or ours sent on their behalf). */
  userTurn: boolean;
  turnStartedAt: number;
  /** What the agent's screen shows — see SessionUiState. */
  uiState: SessionUiState;
  /** Escs pressed in a row, with no other key (the user's or the runner's) between them. */
  escRun: number;
  /** This session has reported a submitted prompt (its UserPromptSubmit hook works). */
  sawPromptSubmit: boolean;
  /** When the runner's own write was last submitted into this session. */
  lastRunnerSubmitAt: number;
  /** When the agent last reported a submitted prompt (UserPromptSubmit), anyone's. */
  lastPromptSubmitAt: number;
  /** The injection whose /clear still waits for its prompt, and when the /clear went in. */
  clearGeneration: AbortController | null;
  clearedAt: number;
}

/** Idle-signal sources that mean a dialog is waiting on the user, not that the turn ended. */
const DIALOG_IDLE_SOURCES: ReadonlySet<string> = new Set([
  "hook:permission_prompt",
  "hook:elicitation_dialog",
  "hook:elicitation_url_dialog",
  "hook:agent_needs_input",
]);

/** Task states in which runtime-attention.ts holds back a task panel's normal-urgency question. */
const RUNNER_OWNED_TURN_STATES: ReadonlySet<string> = new Set([
  "running",
  "evaluating",
  "judge-evaluating",
  "refreshing",
]);

/** Turn ends the agent reports itself — they also mean no dialog is open. */
const DIALOG_CLOSING_IDLE_SOURCES: ReadonlySet<string> = new Set([
  "hook:stop",
  "hook:idle_prompt",
  "hook:notification",
  "osc133",
]);

/** Idle-signal sources that end the agent's turn: hooks for hook-capable
 * providers, the runtime's silence detection for the others. */
const TURN_END_IDLE_SOURCES: ReadonlySet<string> = new Set([
  "hook:stop",
  "hook:idle_prompt",
  "hook:notification",
  "silence",
  "hook-fallback",
  "osc133",
]);

const BRACKETED_PASTE_START = "\x1b[200~";
const BRACKETED_PASTE_END = "\x1b[201~";

/**
 * Fold one chunk of the user's terminal input into what is known about the
 * agent's composer. Generic across agent TUIs:
 *  - printable text and bracketed-paste content → pending;
 *  - a bare Enter ("\r") → submits it — unless it follows a backslash or ESC,
 *    the newline forms agents accept (backslash+Enter, Alt/Option+Enter);
 *  - Ctrl+C → clears it (or, with nothing typed, interrupts the agent);
 *  - Esc (a lone ESC, not the start of a key sequence) → interrupts the agent
 *    and leaves the composer as it was;
 *  - anything else (arrows, history, editing keys, "\n", CSI-u Shift+Enter,
 *    unknown sequences) → pending.
 * When unsure it says "pending": a false pending only costs an Enter on an
 * empty composer, which agent TUIs ignore, while a false "submitted" would let
 * the runner glue its prompt onto the user's text. `entered` reports any bare
 * Enter (it also answers an open dialog); `submitted` one that sent text.
 * `dismissed` reports Esc or Ctrl+C — both reject an open dialog — `escaped`
 * Esc alone, and `interrupted` that the agent's turn was cut short (no Stop
 * hook follows). `escRun` counts the Escs pressed in a row with no other key
 * between them, across chunks; `doubleEscaped` says it reached two — the one
 * Esc pattern that may open a selector (see SessionUiState).
 */
export function foldTerminalInput(
  state: { pending: boolean; lastChar: string; escRun?: number },
  data: string,
): {
  pending: boolean;
  lastChar: string;
  entered: boolean;
  submitted: boolean;
  dismissed: boolean;
  escaped: boolean;
  interrupted: boolean;
  escRun: number;
  doubleEscaped: boolean;
} {
  let { pending, lastChar } = state;
  let escRun = state.escRun ?? 0;
  let entered = false;
  let submitted = false;
  let dismissed = false;
  let escaped = false;
  let interrupted = false;
  let doubleEscaped = false;
  let index = 0;
  while (index < data.length) {
    if (data.startsWith(BRACKETED_PASTE_START, index)) {
      const end = data.indexOf(BRACKETED_PASTE_END, index + BRACKETED_PASTE_START.length);
      index = end < 0 ? data.length : end + BRACKETED_PASTE_END.length;
      pending = true;
      lastChar = "";
      escRun = 0;
      continue;
    }
    const char = data[index];
    index += 1;
    if (char === "\x03") {
      dismissed = true;
      // With text in the composer Ctrl+C clears it; with none it interrupts.
      if (!pending) interrupted = true;
      pending = false;
      lastChar = "";
      escRun = 0;
      continue;
    }
    // A lone ESC is the Esc key — xterm sends sequences (arrows, Alt+key,
    // Alt+Enter) as one chunk that starts with ESC and goes on.
    if (char === "\x1b" && (index >= data.length || data[index] === "\x1b")) {
      dismissed = true;
      escaped = true;
      interrupted = true;
      lastChar = "";
      escRun += 1;
      if (escRun >= 2) doubleEscaped = true;
      continue;
    }
    escRun = 0;
    if (char === "\r" && lastChar !== "\\" && lastChar !== "\x1b") {
      entered = true;
      if (pending) submitted = true;
      pending = false;
      lastChar = char;
      continue;
    }
    pending = true;
    lastChar = char;
  }
  return { pending, lastChar, entered, submitted, dismissed, escaped, interrupted, escRun, doubleEscaped };
}

type TaskStateKind =
  | "idle"
  | "running"
  | "paused"
  | "evaluating"
  | "judge-evaluating"
  | "refreshing"
  | "completed"
  | "failed"
  // Attached mode (Companion loop) only.
  | "capturing-context"
  | "brief-ready"
  | "awaiting-user";

interface TaskRound {
  round: number;
  startedAt: string;
  checks: CheckResult[];
  judgeVerdict: string | null;
  judgeReason: string;
  action: string;
  [key: string]: unknown;
}

interface CheckResult {
  label: string;
  passed: boolean;
  exitCode?: number;
  outputTail?: string;
}

interface RaiseAlertArgs {
  projectId: string;
  panelId: string;
  sessionId: string;
  title: string;
  kind: string;
  tier: number;
  urgency: string;
  detail: string;
}

interface InjectionStrategy {
  style: string;
  submitDelayMs: number;
  typingGapMs: number;
  clearSettleMs: number;
}

interface RuntimeDeps {
  writeToSession: (sessionId: string, data: string, signal?: AbortSignal) => void;
  getState: () => AppState | null;
  broadcastState: () => void;
  raiseAlert: (alert: RaiseAlertArgs) => void;
  restartSession: (sessionId: string) => Promise<void>;
  /** Persist current in-memory state to disk. Optional — older callers without
   * a save hook fall back to opportunistic persistence via unrelated mutations.
   * Used by setTaskState so a task that flips to "running" actually survives a
   * crash; without this, recovery on next startup wouldn't see the active
   * state because nothing wrote it to disk. */
  saveState?: () => void;
  /** Whether a session is currently producing output / has a sub-agent active.
   * Used by the judge cycle (Krok 2) to avoid giving up while the judge is
   * provably still working. Optional — absent means "unknown", treated as not
   * busy so behaviour matches the pre-feature runner. */
  isSessionBusy?: (sessionId: string) => boolean;
  /** Whether a session has proven it emits completion/UserPromptSubmit hooks.
   * Gates the verified-injection retry loop (Krok 1): only hook-capable
   * providers can confirm a submit, so non-hook providers keep today's
   * fire-and-forget behaviour. Optional — absent means "not hook-capable". */
  isSessionHookCapable?: (sessionId: string) => boolean;
  /** Whether the session's last output looks like a bare shell prompt — i.e.
   * the agent CLI exited back to its parent shell (forced update / crash /
   * stray `exit`) without the PTY itself dying. Used to detect a mid-task
   * dropout and restart the agent. Optional — absent means "can't tell". */
  isAgentDroppedToShell?: (sessionId: string) => boolean;
}

// ------ Module-level pure helpers -------

function quoteShellArg(value: unknown, platform: string = process.platform): string {
  const text = String(value ?? "");
  if (platform === "win32") return `"${text.replace(/"/g, '""')}"`;
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

export function shouldUseProgrammaticCopilotJudge(
  providerConfig: { providerId?: string } | null | undefined,
  platform: string = process.platform,
): boolean {
  return platform === "win32" && providerConfig?.providerId === "copilot";
}

export function buildProgrammaticCopilotJudgeCommand({
  promptPath,
  cwd,
  model,
  platform = process.platform,
}: {
  promptPath: string;
  cwd?: string;
  model?: string;
  platform?: string;
}): string {
  const source =
    platform === "win32" ? `type ${quoteShellArg(promptPath, platform)}` : `cat ${quoteShellArg(promptPath, platform)}`;
  const parts = ["copilot", "-s", "--no-ask-user", "--allow-all-tools"];
  if (cwd) parts.push("--add-dir", quoteShellArg(cwd, platform));
  if (model) parts.push("--model", quoteShellArg(model, platform));
  return `${source} | ${parts.join(" ")}`;
}

// Helper to narrow WorkspaceState to TaskWorkspaceState
function isTaskWorkspace(workspace: WorkspaceState): workspace is TaskWorkspaceState {
  return workspace.kind === "task" && workspace.task != null;
}

interface TaskBinding {
  workspace: TaskWorkspaceState;
  task: RuntimeTaskState;
  role: TaskBindingRole;
}

/**
 * Canonical session id for a task workspace's worker/"Primary" or
 * judge/"Companion" role. The implementation now lives in
 * `electron/shared/task-states.ts` so the renderer's running-agent selector
 * resolves the exact same id; this typed wrapper keeps the runner's call
 * sites (which always hold a narrowed TaskWorkspaceState) unchanged.
 */
export function sessionIdFor(workspace: TaskWorkspaceState, role: TaskBindingRole): string {
  return sharedSessionIdFor(workspace, role);
}

/**
 * Agent Task Runner — orchestrates a worker + judge evaluation loop.
 *
 * Integrates with strideterm's hook-based idle detection: when a worker or
 * judge agent goes idle, runtime calls `onAgentIdle(sessionId)` instead of
 * raising a normal user alert. The task runner then runs verification checks
 * and coordinates the worker–judge cycle.
 */
export class AgentTaskRunner {
  /** workspaceIds currently being evaluated (re-entrance guard) */
  #evaluating = new Set<string>();
  /** Standard evaluation ownership remains distinct from lifecycle epochs. */
  #standardTaskRunGeneration = new Map<string, number>();
  #evaluationOwners = new Map<string, number>();
  /** Lifecycle identity is independent from nested evaluation operation ownership. */
  #taskLifecycleEpoch = new Map<string, number>();
  #sessionIncarnations = new Map<string, number>();
  #managedSessionRestarts = new Map<string, number>();
  #operationSequence = 0;
  /** workspaceIds whose companion verdict is being handled right now — the
   *  attached-mode counterpart of #evaluating. #handleCompanionVerdict awaits
   *  a disk read and (on "continue") a work-lock recreate and a template write
   *  before it moves the task out of judge-evaluating, so two idle signals
   *  arriving back to back would otherwise both pass the state check and each
   *  inject a round into the Primary. */
  #handlingCompanionVerdict = new Map<string, boolean>();
  #companionVerdictOwners = new Map<string, number>();
  /** Turn-boundary idle signals (hook:stop and friends) that arrived while a
   *  NON-boundary pass — idle_prompt / notification, which return without
   *  nudging — held the guard above. Keyed by workspaceId, replayed once that
   *  pass finishes: dropping them leaves the task in judge-evaluating with no
   *  event left to come. Only such upgrades are queued; see the guard. */
  #pendingCompanionVerdict = new Map<string, string>();
  /** workspaceIds with a Send back in flight. rejectTaskVerdict's own state
   *  check can't serialize it: `state` only flips to "running" after the
   *  work-lock recreate awaits, so two fast clicks both pass it, both start a
   *  round, and one's rollback can undo the other's completed send. */
  #rejectingVerdict = new Set<string>();
  #rejectOwners = new Map<string, number>();
  /** per-cwd git init locks to prevent concurrent init */
  #gitInitLocks = new Map<string, Promise<boolean>>();
  /** workspaceIds with a headless programmatic judge in flight */
  #programmaticJudges = new Set<string>();
  #handlingStandardVerdict = new Map<string, { owner: number; idleOnly: boolean }>();
  #pendingStandardVerdict = new Map<string, string>();
  /** scheduled wakeup timers for workspaces in rate-limit hold. Keyed via
   *  #rlKey(workspaceId, role) so the worker and judge schedule/cancel their
   *  resume independently (unifies the former separate worker/judge maps). */
  #rateLimitTimers = new Map<string, NodeJS.Timeout>();
  /** per-(role, workspace) runtime context for the active rate-limit cycle.
   *  Keyed via #rlKey so the worker and judge each get their own retry counter,
   *  sharing the same cap (MAX_RATE_LIMIT_RETRIES) and >12h hard-stop. */
  #rateLimitCtx = new Map<string, { needsRestart: boolean; retries: number }>();
  /** deferred WORK_LOCK-absence checks that override a possibly-false rate-limit hold */
  #workLockOverrideTimers = new Map<string, NodeJS.Timeout>();
  /** recurring WORK_LOCK probes — fire every 30 s while a hold is in effect so a
   * worker that finished after a false-positive detection gets unblocked even if
   * no idle hook ever lands (some Claude versions are unreliable about emitting
   * Stop after the last action). */
  #periodicWorkLockProbeTimers = new Map<string, NodeJS.Timeout>();
  /** Tasks that were in an active state when reconcileOnStartup ran — offered to user for recovery. */
  #startupRecoveryCandidates: RecoveryCandidate[] = [];

  // Injected dependencies (set via init())
  #writeToSession: RuntimeDeps["writeToSession"] | null = null;
  #getState: RuntimeDeps["getState"] | null = null;
  #broadcastState: RuntimeDeps["broadcastState"] | null = null;
  #raiseAlert: RuntimeDeps["raiseAlert"] | null = null;
  #restartSession: RuntimeDeps["restartSession"] | null = null;
  #saveState: RuntimeDeps["saveState"] | null = null;
  #isSessionBusy: RuntimeDeps["isSessionBusy"] | null = null;
  #isSessionHookCapable: RuntimeDeps["isSessionHookCapable"] | null = null;
  #isAgentDroppedToShell: RuntimeDeps["isAgentDroppedToShell"] | null = null;

  /** Last prompt text injected into each session (keyed by sessionId), captured
   * by #injectPrompt. Powers the manual "Resend" buttons and the auto-restart
   * re-injection after a dropout. Holds the ORIGINAL full text (not the
   * file-pointer rewrite), so re-injecting reconstructs PROMPT.md as needed. */
  #lastInjected = new Map<string, string>();
  /** Consecutive auto-restart attempts after a detected agent dropout, keyed by
   * sessionId. Reset to 0 once the agent accepts a prompt again
   * (onUserPromptSubmit). Over MAX_DROPOUT_RESTARTS the task is paused. */
  #dropoutCtx = new Map<string, number>();
  /** Restart-then-re-inject cap for an agent that keeps dropping out of agent
   * mode (e.g. a CLI stuck in a forced-update loop). */
  static MAX_DROPOUT_RESTARTS = 3;

  /** Krok 1 — sessions awaiting a UserPromptSubmit confirmation after an inject.
   * onUserPromptSubmit resolves the waiters for the session. */
  #submitWaiters = new Map<string, Array<() => void>>();
  #injectionAbortControllers = new Map<string, AbortController>();
  #injectionOperations = new Map<string, { operation: TaskOperationContext; expectedState: string } | null>();
  /** Why each cancelled injection was cancelled — see #reportCancelledInjection. */
  #cancelledInjections = new WeakMap<
    AbortController,
    {
      reason: InjectionCancelReason;
      injection: { operation: TaskOperationContext; expectedState: string } | null;
    }
  >();
  #disposed = false;
  /** Krok 8 — fs.watch fallback watchers on task dirs, keyed by workspaceId. */
  #taskDirWatchers = new Map<string, { close: () => void }>();
  /** Krok 9 — per-role rate-limit hold expiry for the judge (worker hold is
   * task.rateLimitedUntil). Keyed by workspaceId. */
  #judgeRateLimitedUntil = new Map<string, number>();
  #judgeRateLimitResumeOwners = new Map<string, number>();
  /** Krok 9c — detection-independent backstop: timestamp of the last prompt
   * injected into the worker session, and the count of consecutive turns that
   * ended almost instantly after it. A run of these is the "Cogitated/Worked
   * for 0s" signature of a rate-limited account that detection missed. */
  #workerInjectAt = new Map<string, number>();
  #shortWorkerTurns = new Map<string, number>();
  static SHORT_WORKER_TURN_MS = 2000;
  static SHORT_WORKER_TURN_THRESHOLD = 3;

  /**
   * Late-init with runtime dependencies (avoids circular refs).
   * Called once from runtime.js after all closures are available.
   */
  init({
    writeToSession,
    getState,
    broadcastState,
    raiseAlert,
    restartSession,
    saveState,
    isSessionBusy,
    isSessionHookCapable,
    isAgentDroppedToShell,
  }: RuntimeDeps): void {
    this.#writeToSession = writeToSession;
    this.#getState = getState;
    this.#broadcastState = broadcastState;
    this.#raiseAlert = raiseAlert;
    this.#restartSession = restartSession;
    this.#saveState = saveState ?? null;
    this.#isSessionBusy = isSessionBusy ?? null;
    this.#isSessionHookCapable = isSessionHookCapable ?? null;
    this.#isAgentDroppedToShell = isAgentDroppedToShell ?? null;

    // Crash-recovery sweep on startup. See #reconcileOnStartup for the full
    // story; the short version is: tasks whose state on disk says they were
    // running when the app last closed get paused and added to a candidate
    // list, which the UI surfaces (or the runtime auto-resolves) so the user
    // can choose whether to re-spawn the agent.
    this.#reconcileOnStartup();
  }

  // ---------------------------------------------------------------------------
  // Crash-recovery sweep
  // ---------------------------------------------------------------------------
  //
  // Why this exists:
  //   When the app closes (Quit / window close / OS reboot / power loss),
  //   every PTY process for a running task agent dies with it. The persisted
  //   AppState on disk, however, still says state="running" (or
  //   "judge-evaluating", etc.) because that flag only flips on explicit
  //   lifecycle events, not on process death.
  //
  //   On the next startup we therefore have a contradiction: state says the
  //   task is mid-flight, but no process exists to drive it forward. If we
  //   leave the contradiction in place, two things break:
  //     1. The task never makes progress — there is no agent to do work.
  //     2. UI shows a misleading "running" badge that never resolves.
  //
  //   #reconcileOnStartup flips every such task to "paused" (recording where
  //   it was) and surfaces the list to the user so they can decide whether
  //   to resume. Resume means: re-spawn the PTY and inject a pure-text
  //   recovery prompt. We do NOT use --continue / --resume / any provider
  //   "context restore" flag — the agent re-orients from the artifacts the
  //   previous round wrote to disk (HANDOFF.md, TODO.md, WORK_LOCK,
  //   verdict.json, git history). See buildRecoveryPrompt for the prompt
  //   text and docs/task-recovery.md for the full protocol.
  // ---------------------------------------------------------------------------

  #reconcileOnStartup(): void {
    const state = this.#getState?.();
    if (!state?.workspaces) return;

    // Which task states qualify as "was running when the app closed"?
    //   running           — worker actively coding
    //   evaluating        — between rounds, runner about to spawn judge
    //   judge-evaluating  — judge actively reviewing
    //   refreshing        — worker after periodic context refresh ("shower")
    //
    // Deliberately EXCLUDED:
    //   paused            — user explicitly paused, don't second-guess them
    //   completed/failed  — terminal verdict already issued; reopening should
    //                       go through "Send Back" with explicit feedback,
    //                       not a silent restart that may overwrite verdict.json
    //   idle              — task never started; nothing to recover
    //   brief-ready/awaiting-user — attached-only, user-facing wait states;
    //                       not mid-flight work, so not swept into recovery.
    const ACTIVE = new Set(["running", "evaluating", "judge-evaluating", "refreshing", "capturing-context"]);

    for (const workspace of state.workspaces) {
      if (!isTaskWorkspace(workspace)) continue;
      if (!ACTIVE.has(workspace.task.state)) continue;

      const previousState = workspace.task.state;
      log.info("reconcileOnStartup: pausing task left in active state", {
        workspaceId: workspace.id,
        previousState,
      });
      workspace.task.pausedFromState = previousState;
      this.#setTaskState(workspace.task, "paused");
      void this.#logTaskEvent(workspace, "task-paused", `Paused on startup (was ${previousState})`);

      this.#startupRecoveryCandidates.push({
        taskId: workspace.task.taskId,
        workspaceId: workspace.id,
        workspaceName: workspace.name ?? "",
        profileId: workspace.profileId ?? "default",
        currentRound: workspace.task.currentRound,
        maxRounds: workspace.task.maxRounds,
        previousState,
      });
    }

    // No broadcastState() here — runtime isn't fully initialized yet
    // (getPayload depends on pluginManager etc.). The corrected state
    // will be included in the first natural broadcast after startup.
  }

  /** Returns tasks that were active when the app was last closed, collected at startup. */
  getStartupRecoveryCandidates(): RecoveryCandidate[] {
    return [...this.#startupRecoveryCandidates];
  }

  // ---------------------------------------------------------------------------
  // Task workspace creation
  // ---------------------------------------------------------------------------

  /**
   * Build a task workspace object (not yet persisted — caller saves via runtime.saveWorkspace).
   */
  createTaskWorkspace({
    state,
    description,
    cwd,
    parentWorkspaceId,
    maxRounds,
    name,
    icon,
    color,
    notes,
    workerCommand,
    judgeCommand,
    workerProvider,
    judgeProvider,
    callerProfileId = "",
    reservedIds,
  }: {
    state: Partial<Pick<AppState, "workspaces" | "windowSlots">>;
    description: string;
    cwd: string;
    parentWorkspaceId: string;
    maxRounds?: number;
    name?: string;
    icon?: string;
    color?: string;
    notes?: string;
    workerCommand?: string;
    judgeCommand?: string;
    workerProvider?: ParsedProviderConfig;
    judgeProvider?: ParsedProviderConfig;
    /** Profile of the window that initiated creation. Used when no parent
     * is provided — picking windowSlots[0] instead silently puts the task
     * on the wrong profile in multi-window setups. */
    callerProfileId?: string;
    /** Ids an orchestrator reserved (and persisted) before creating anything, so a restart can
     * find what a half-finished run made. Never accepted from a client. */
    reservedIds?: { workspaceId: string; taskId: string };
  }): TaskWorkspaceState {
    const workspaceId = reservedIds?.workspaceId ?? `workspace-${randomUUID()}`;
    const dashboardPanelId = `panel-${randomUUID()}`;
    const workerPanelId = `panel-${randomUUID()}`;
    const judgePanelId = `panel-${randomUUID()}`;

    const autoName = description
      ? description.length > 50
        ? description.slice(0, 47) + "..."
        : description
      : "Task workspace";

    // Stable per-parent ordinal: max sibling sequence + 1. "Siblings" are task
    // workspaces with the same parentWorkspaceId (empty string buckets all
    // parentless tasks together — fine, that's not a normal flow). Deletions
    // don't renumber the survivors, which is the whole point — once you've
    // referred to "mhub #3", deleting #2 must not silently turn #3 into #2.
    //
    // We also count *unnumbered* legacy siblings (created before this field
    // existed) so the new task doesn't claim "#1" when there are already
    // three unnumbered "mhub" siblings around — that would read as "the
    // first one" rather than "the newest one". Taking max(numbered max,
    // sibling count) handles both pure-legacy and post-feature populations
    // and any mix of the two.
    //
    // Known limitation: two concurrent createTaskWorkspace calls that read
    // the same state snapshot will both compute the same next ordinal —
    // they'd race and produce two siblings with the same number. We accept
    // this for now (rare; benign visual collision; not data loss); moving
    // the assignment into store.mutate would close the race but expands the
    // diff materially.
    const siblings = (state.workspaces || []).filter(
      (w) => w.kind === "task" && (w.task?.parentWorkspaceId || "") === (parentWorkspaceId || ""),
    );
    const maxSeq = siblings.reduce((max, w) => Math.max(max, w.task?.sequenceNumber || 0), 0);
    const sequenceNumber = Math.max(maxSeq, siblings.length) + 1;

    // Resolve worker provider config: explicit workerProvider > parse workerCommand > Claude default
    const workerProviderConfig: ParsedProviderConfig =
      workerProvider ||
      (workerCommand ? parseProviderFromCommand(workerCommand) : { providerId: "claude", model: "sonnet" });
    const judgeProviderConfig: ParsedProviderConfig =
      judgeProvider ||
      (judgeCommand ? parseProviderFromCommand(judgeCommand) : { providerId: "claude", model: "opus" });

    // Build panel commands from provider config, or use explicit command override
    const wp = getProvider(workerProviderConfig.providerId);
    const jp = getProvider(judgeProviderConfig.providerId);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const wpCtor = wp.constructor as any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const jpCtor = jp.constructor as any;

    const resolvedWorkerCmd =
      workerCommand?.trim() ||
      wp.buildCommand({
        model: workerProviderConfig.model,
        role: "worker",
        extra: (workerProviderConfig as unknown as Record<string, unknown>).extra as Record<string, unknown>,
        skipPermissions:
          ((workerProviderConfig as unknown as Record<string, unknown>).skipPermissions as boolean | undefined) ??
          wpCtor.defaultSkipPermissions ??
          false,
      });
    const resolvedJudgeCmd =
      judgeCommand?.trim() ||
      jp.buildCommand({
        model: judgeProviderConfig.model,
        role: "judge",
        extra: (judgeProviderConfig as unknown as Record<string, unknown>).extra as Record<string, unknown>,
        skipPermissions:
          ((judgeProviderConfig as unknown as Record<string, unknown>).skipPermissions as boolean | undefined) ??
          jpCtor.defaultSkipPermissions ??
          false,
      });

    // Panel titles include provider/model so the user can see at a glance
    const workerTitle = `Worker (${wpCtor.displayName} ${workerProviderConfig.model})`;
    const judgeTitle = `Judge (${jpCtor.displayName} ${judgeProviderConfig.model})`;

    return {
      id: workspaceId,
      name: name?.trim() || autoName,
      icon: icon?.trim() || "\u{1F916}", // 🤖
      // Inherit the parent workspace's accent so task entries visually
      // belong to their parent in the sidebar. Same lookup pattern as
      // profileId below.
      color:
        color || (parentWorkspaceId && state.workspaces?.find((w) => w.id === parentWorkspaceId)?.color) || "#7C4DFF",
      kind: "task",
      source: "manual",
      pluginId: "",
      cwd,
      gitRoots: [],
      activeRootPath: "",
      notes: notes?.trim() || "",
      // Inherit the parent workspace's profile when one is provided —
      // otherwise use the calling viewer's profile. Never windowSlots[0]:
      // with multiple windows (possibly several per profile) the first slot
      // is arbitrary and silently lands the task on the wrong profile. A
      // context-less programmatic create deterministically lands in
      // "default".
      profileId:
        (parentWorkspaceId && state.workspaces?.find((w) => w.id === parentWorkspaceId)?.profileId) ||
        callerProfileId ||
        "default",
      connectionId: "",
      activePanelId: dashboardPanelId,
      activeViewId: null,
      splitLayout: null,
      splitViewIds: [],
      starred: false,
      review: null,
      quickfix: null,

      panels: [
        {
          id: dashboardPanelId,
          title: "Dashboard",
          command: "__task-dashboard__",
          shell: false as unknown as string,
          startup: "none",
        },
        {
          id: workerPanelId,
          title: workerTitle,
          command: resolvedWorkerCmd,
          shell: true as unknown as string,
          startup: "default",
        },
        {
          id: judgePanelId,
          title: judgeTitle,
          command: resolvedJudgeCmd,
          shell: true as unknown as string,
          startup: "default",
        },
      ],
      task: {
        taskId: reservedIds?.taskId ?? randomUUID(),
        description,
        parentWorkspaceId: parentWorkspaceId || "",
        worktreeBase: "",
        worktreeBranch: "",
        workerPanelId,
        judgePanelId,
        maxRounds: maxRounds || 10,
        showerInterval: DEFAULT_SHOWER_INTERVAL,
        state: "idle",
        currentRound: 0,
        rounds: [],
        lastShowerRound: 0,
        lastJudgeInstructions: "",
        workerProviderConfig,
        judgeProviderConfig,
        startedAt: null,
        totalPausedMs: 0,
        pausedAt: null,
        finishedAt: null,
        rateLimitedUntil: null,
        promptSent: false,
        pausedFromState: "",
        showerResumePrompt: "",
        createdAt: new Date().toISOString(),
        sequenceNumber,
      } as RuntimeTaskState,
    };
  }

  /**
   * Write task control files to disk. Called at workspace creation time
   * so files are immediately available in the Dashboard/Files tab.
   */
  async writeInitialFiles(cwd: string, task: RuntimeTaskState): Promise<void> {
    log.info("writing initial task files", {
      cwd,
      taskId: task.taskId,
      hasDescription: !!task.description,
      descriptionLength: (task.description || "").length,
    });
    // Run task file writes and .gitignore setup in parallel using Effect.all.
    await runEffect(
      Effect.all(
        [
          Effect.tryPromise({
            try: () => writeTaskFiles(cwd, task, log),
            catch: (e) => new TaskFileError({ workspaceId: task.taskId, path: cwd, cause: e }),
          }),
          Effect.tryPromise({
            try: () => ensureGitIgnore(cwd, log),
            catch: (e) => new TaskFileError({ workspaceId: task.taskId, path: cwd, cause: e }),
          }),
        ],
        { concurrency: "unbounded" },
      ),
    );
    // Tasks created from now on use the new split format (TASK.md + WORKER.md).
    // Setting the flag here means downstream prompt builders skip the disk
    // probe — and the flag persists with task state across pause/resume.
    task.useWorkerFile = true;
  }

  // ---------------------------------------------------------------------------
  // Task lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Start (or resume) the task — inject initial prompt into worker.
   */
  async startTask(workspaceId: string): Promise<boolean> {
    const workspace = this.#findTaskWorkspace(workspaceId);
    if (workspace) this.#takeUserWordForScreens(workspace, ["worker", "judge"], "start");
    return this.#runUserAction(
      workspaceId,
      "startTask",
      this.#startTask(workspaceId),
      (state) =>
        `The task prompt did not reach the agent (the task is now ${state}). Continue sends it on the agent's next idle, or use Resend.`,
    );
  }

  async #startTask(workspaceId: string): Promise<boolean> {
    const state = this.#getState?.();
    const candidate = state?.workspaces.find((w) => w.id === workspaceId);
    if (!candidate || !isTaskWorkspace(candidate)) {
      log.warn("startTask: workspace not found or not a task workspace", { workspaceId });
      return false;
    }
    let workspace: TaskWorkspaceState = candidate;

    if (workspace.task.mode === "attached") {
      return this.#startAttachedTask(workspace);
    }

    let task = workspace.task;
    if (task.state === "running" || task.state === "evaluating" || task.state === "judge-evaluating") {
      log.debug("startTask: already running", { workspaceId, state: task.state });
      return false;
    }

    this.#advanceTaskLifecycle(workspaceId, "start");
    const initialWorkspace = this.#findTaskWorkspace(workspaceId);
    if (!initialWorkspace || initialWorkspace.task.taskId !== task.taskId) return false;
    workspace = initialWorkspace;
    task = workspace.task;
    const operation = this.#captureTaskOperation(workspace, "start-task");
    let expectedStates: ReadonlySet<string> = new Set([task.state]);
    const refresh = (): boolean => {
      const fresh = this.#currentTaskOperation(operation, expectedStates);
      if (!fresh) return false;
      workspace = fresh;
      task = fresh.task;
      return true;
    };

    // Ensure a git repo exists so the judge can see diffs/status.
    // If the directory has no .git, we run `git init` + initial commit.
    // This is read-only from the perspective of the user's work — we never push.
    await ensureGitRepo(workspace.cwd, { execCommand, gitInitLocks: this.#gitInitLocks, log });
    if (!refresh()) return false;

    // Provider-specific setup (e.g. Gemini writes yolo policy file)
    try {
      const workerProviderConfig = task.workerProviderConfig || { providerId: "claude", model: "sonnet" };
      const judgeProviderConfig = task.judgeProviderConfig || { providerId: "claude", model: "opus" };
      const workerProv = getProvider(workerProviderConfig.providerId);
      await workerProv.beforeStart(workspace.cwd);
      if (!refresh()) return false;
      if (judgeProviderConfig.providerId !== workerProviderConfig.providerId) {
        const judgeProv = getProvider(judgeProviderConfig.providerId);
        await judgeProv.beforeStart(workspace.cwd);
        if (!refresh()) return false;
      }
    } catch (err: unknown) {
      log.warn("startTask: provider beforeStart failed (non-fatal)", {
        workspaceId,
        err: (err as Error)?.message,
      });
    }

    if (!refresh()) return false;
    this.#setTaskState(task, "running");
    expectedStates = new Set(["running"]);
    task.currentRound = 1;
    task.rounds = [];
    this.#ensureRunningRound(task);

    // Refresh task.description from TASK.md so manual edits via the Assignment
    // tab take effect on the next Start. Without this, the user can press
    // Reset, rewrite the brief, press Start — and the worker still gets the
    // original description because the in-memory copy never updates.
    try {
      const fresh = await readTaskDescription(workspace.cwd, task.taskId);
      if (!refresh()) return false;
      if (fresh !== null && fresh !== task.description) {
        log.info("startTask: refreshed description from TASK.md", {
          workspaceId,
          previousLength: (task.description || "").length,
          newLength: fresh.length,
        });
        task.description = fresh;
      }
    } catch (err: unknown) {
      log.warn("startTask: failed to refresh description from disk (using stale)", {
        workspaceId,
        err: (err as Error)?.message,
      });
    }

    // Claude Code is already running (started with the workspace).
    // Send the task prompt now — agent is ready and waiting for input.
    //
    // We always send even when task.description is empty: the prompt template
    // already falls back to "Read the task from <taskDir>/TASK.md" in that case,
    // which is exactly what users expect after they edit TASK.md in the Files
    // tab and press Start. Gating on description meant Start was a silent no-op
    // for that workflow, and only typing directly into the terminal worked.
    if (!refresh()) return false;
    const workerSessionId = `${workspaceId}:${task.workerPanelId}`;
    const useWorkerFile = await this.#ensureFormatFlag(task, workspace);
    if (!refresh()) return false;
    task.useWorkerFile ??= useWorkerFile;

    // After a Reset (or any other path that flips needsContextClear), wipe
    // the Worker and Judge conversational context before we inject the new
    // prompt. This keeps a re-run on a tweaked brief from being shadowed by
    // the agent's memory of the previous attempt. Best-effort — providers
    // that don't recognize `/clear` (none today, but tolerated) just see the
    // command as a stray line and ignore it.
    if (task.needsContextClear) {
      const judgeSessionId = `${workspaceId}:${task.judgePanelId}`;
      try {
        const workerClear = this.#clearSessionContext(workerSessionId, workspace);
        const workerClearController = this.#injectionAbortControllers.get(workerSessionId);
        const judgeClear = this.#clearSessionContext(judgeSessionId, workspace);
        const judgeClearController = this.#injectionAbortControllers.get(judgeSessionId);
        const cleared = await Promise.all([workerClear, judgeClear]);
        if (!refresh()) return false;
        if (
          cleared.some((result) => !result) ||
          (workerClearController && !this.#isCurrentInjection(workerSessionId, workerClearController)) ||
          (judgeClearController && !this.#isCurrentInjection(judgeSessionId, judgeClearController))
        )
          return false;
        log.info("task start: cleared Worker + Judge context after reset", { workspaceId });
        void this.#logTaskEvent(workspace, "context-cleared", "Sent /clear to Worker and Judge before initial prompt");
      } catch (err: unknown) {
        log.warn("task start: context clear failed (proceeding anyway)", {
          workspaceId,
          err: (err as Error)?.message,
        });
      }
      if (!refresh()) return false;
      task.needsContextClear = false;
    }

    if (!refresh()) return false;
    const prompt = buildInitialWorkerPrompt(task);
    if (!(await this.#injectPrompt(workerSessionId, prompt, workspace))) return false;
    if (!refresh()) return false;
    task.promptSent = true;
    const detail = task.description ? "Prompt sent to Worker" : "Prompt sent to Worker (task in TASK.md)";
    log.info("task started, prompt sent to worker", {
      workspaceId,
      taskId: task.taskId,
      hasDescription: !!task.description,
    });
    void this.#logTaskEvent(workspace, "task-started", detail);

    this.#broadcastState!();
    return true;
  }

  stopTask(workspaceId: string): boolean {
    const workspace = this.#findTaskWorkspace(workspaceId);
    if (!workspace) return false;
    this.#cancelTaskInjections(workspace);
    this.#forgetUserActivity(workspace);

    // Krok 4 — record where we paused from so Continue resumes to the right
    // state (e.g. judge-evaluating, so the verdict gets read) rather than
    // always falling back to "running".
    workspace.task.pausedFromState = workspace.task.state;
    this.#setTaskState(workspace.task, "paused");
    this.#evaluating.delete(workspaceId);
    log.info("task stopped (paused)", { workspaceId });
    void this.#logTaskEvent(workspace, "task-stopped");
    this.#broadcastState!();
    return true;
  }

  pauseTask(workspaceId: string): boolean {
    const workspace = this.#findTaskWorkspace(workspaceId);
    if (!workspace) return false;
    // "capturing-context" is attached-only (never produced for standard
    // tasks) — pausing mid-capture is a valid user action (plan §6.1).
    if (
      workspace.task.state !== "running" &&
      workspace.task.state !== "evaluating" &&
      workspace.task.state !== "judge-evaluating" &&
      workspace.task.state !== "refreshing" &&
      workspace.task.state !== "capturing-context"
    )
      return false;

    this.#cancelTaskInjections(workspace);
    this.#forgetUserActivity(workspace);

    // Krok 4 — capture the pre-pause state for a correct Continue.
    workspace.task.pausedFromState = workspace.task.state;
    this.#setTaskState(workspace.task, "paused");
    this.#evaluating.delete(workspaceId);
    log.info("task paused", { workspaceId });
    void this.#logTaskEvent(workspace, "task-paused");
    this.#broadcastState!();
    return true;
  }

  #nextOperationId(): number {
    this.#operationSequence += 1;
    return this.#operationSequence;
  }

  #advanceTaskLifecycle(workspaceId: string, reason: string): number {
    const epoch = (this.#taskLifecycleEpoch.get(workspaceId) || 0) + 1;
    this.#taskLifecycleEpoch.set(workspaceId, epoch);
    this.#standardTaskRunGeneration.set(workspaceId, (this.#standardTaskRunGeneration.get(workspaceId) || 0) + 1);
    this.#evaluating.delete(workspaceId);
    this.#evaluationOwners.delete(workspaceId);
    this.#programmaticJudges.delete(workspaceId);
    this.#handlingStandardVerdict.delete(workspaceId);
    this.#pendingStandardVerdict.delete(workspaceId);
    this.#handlingCompanionVerdict.delete(workspaceId);
    this.#companionVerdictOwners.delete(workspaceId);
    this.#pendingCompanionVerdict.delete(workspaceId);
    this.#judgeRateLimitResumeOwners.delete(workspaceId);
    this.#rejectingVerdict.delete(workspaceId);
    this.#rejectOwners.delete(workspaceId);
    log.debug("task lifecycle advanced", { workspaceId, lifecycleEpoch: epoch, reason });
    return epoch;
  }

  #beginStandardEvaluation(workspaceId: string): number {
    const generation = (this.#standardTaskRunGeneration.get(workspaceId) || 0) + 1;
    this.#standardTaskRunGeneration.set(workspaceId, generation);
    return generation;
  }

  #captureTaskOperation(
    workspace: TaskWorkspaceState,
    label: string,
    {
      round = false,
      evaluationAttempt = false,
      expectedRefusal,
    }: { round?: boolean; evaluationAttempt?: boolean; expectedRefusal?: ExpectedTaskOperationRefusal } = {},
  ): TaskOperationContext {
    const task = workspace.task;
    const workerSessionId = sessionIdFor(workspace, "worker");
    const judgeSessionId = sessionIdFor(workspace, "judge");
    return {
      id: this.#nextOperationId(),
      label,
      workspaceId: workspace.id,
      taskId: task.taskId,
      mode: task.mode || "standard",
      lifecycleEpoch: this.#taskLifecycleEpoch.get(workspace.id) || 0,
      cwd: workspace.cwd,
      workerPanelId: task.workerPanelId,
      judgePanelId: task.judgePanelId,
      workerWorkspaceId: task.workerWorkspaceId || "",
      ...(round ? { round: task.currentRound } : {}),
      checksRound: round,
      ...(evaluationAttempt ? { evaluationAttempt: task.companionEvaluationAttempt } : {}),
      checksEvaluationAttempt: evaluationAttempt,
      sessionEpochs: {
        [workerSessionId]: this.#sessionIncarnations.get(workerSessionId) || 0,
        [judgeSessionId]: this.#sessionIncarnations.get(judgeSessionId) || 0,
      },
      sessionRoles: { [workerSessionId]: "worker", [judgeSessionId]: "judge" },
      capturedAt: Date.now(),
      ...(expectedRefusal ? { expectedRefusal } : {}),
      rejectedLogged: false,
    };
  }

  /**
   * Re-validate a captured operation after an await. Returns the current
   * workspace, or null when any identity check fails — the step must stop.
   * `extraFailures` are checks the caller evaluated itself (the standard run
   * generation); `expectedRefusal` marks a call site whose refusal is the
   * normal answer (a probe) rather than a step being stopped.
   */
  #currentTaskOperation(
    operation: TaskOperationContext,
    expectedStates?: ReadonlySet<string>,
    {
      extraFailures = [],
      expectedRefusal,
    }: {
      extraFailures?: readonly TaskOperationCheckFailure[];
      expectedRefusal?: ExpectedTaskOperationRefusal;
    } = {},
  ): TaskWorkspaceState | null {
    const workspace = this.#findTaskWorkspace(operation.workspaceId);
    const failures = [...this.#staleTaskOperationChecks(operation, workspace, expectedStates), ...extraFailures];
    if (failures.length === 0) return workspace;
    this.#reportStaleTaskOperation(operation, workspace, expectedStates, failures, expectedRefusal);
    return null;
  }

  /** Every identity check `operation` fails against `workspace`, not just the first. */
  #staleTaskOperationChecks(
    operation: TaskOperationContext,
    workspace: TaskWorkspaceState | null,
    expectedStates?: ReadonlySet<string>,
  ): TaskOperationCheckFailure[] {
    const failures: TaskOperationCheckFailure[] = [];
    const fail = (check: string, expected: unknown, actual: unknown): void => {
      failures.push({ check, expected, actual });
    };
    if (this.#disposed) fail("disposed", false, true);
    const lifecycleEpoch = this.#taskLifecycleEpoch.get(operation.workspaceId) || 0;
    if (lifecycleEpoch !== operation.lifecycleEpoch) fail("lifecycleEpoch", operation.lifecycleEpoch, lifecycleEpoch);
    if (!workspace) {
      // #findTaskWorkspace folds "workspace deleted" and "no longer a task
      // workspace" into one null — tell them apart for the log.
      const exists = !!this.#getState?.()?.workspaces.some((candidate) => candidate.id === operation.workspaceId);
      if (exists) fail("task", "present", "missing");
      else fail("workspace", "present", "missing");
      return failures;
    }
    const task = workspace.task;
    if (task.taskId !== operation.taskId) fail("taskId", operation.taskId, task.taskId);
    const mode = task.mode || "standard";
    if (mode !== operation.mode) fail("mode", operation.mode, mode);
    // Paths are logged only here, where they are the failed check itself.
    if (workspace.cwd !== operation.cwd) fail("cwd", operation.cwd, workspace.cwd);
    if (task.workerPanelId !== operation.workerPanelId) {
      fail("workerPanelId", operation.workerPanelId, task.workerPanelId);
    }
    if (task.judgePanelId !== operation.judgePanelId) fail("judgePanelId", operation.judgePanelId, task.judgePanelId);
    const workerWorkspaceId = task.workerWorkspaceId || "";
    if (workerWorkspaceId !== operation.workerWorkspaceId) {
      fail("workerWorkspaceId", operation.workerWorkspaceId, workerWorkspaceId);
    }
    if (operation.checksRound && task.currentRound !== operation.round) {
      fail("round", operation.round, task.currentRound);
    }
    if (operation.checksEvaluationAttempt && task.companionEvaluationAttempt !== operation.evaluationAttempt) {
      fail("evaluationAttempt", operation.evaluationAttempt, task.companionEvaluationAttempt);
    }
    for (const [sessionId, incarnation] of Object.entries(operation.sessionEpochs)) {
      const current = this.#sessionIncarnations.get(sessionId) || 0;
      if (current === incarnation) continue;
      failures.push({
        check: "sessionIncarnation",
        expected: incarnation,
        actual: current,
        sessionId,
        role: operation.sessionRoles[sessionId],
      });
    }
    if (expectedStates && !expectedStates.has(task.state)) fail("state", [...expectedStates], task.state);
    return failures;
  }

  /**
   * Log a refused operation once (`rejectedLogged`), with everything needed to
   * tell from strideterm.log alone which check stopped which step: debug when
   * the refusal is explained — the lifecycle moved on, or the operation / call
   * site declared this refusal normal — and warn otherwise. Ids, states and
   * counters only; paths only for a failed cwd check.
   */
  #reportStaleTaskOperation(
    operation: TaskOperationContext,
    workspace: TaskWorkspaceState | null,
    expectedStates: ReadonlySet<string> | undefined,
    failures: readonly TaskOperationCheckFailure[],
    callSiteExpectedRefusal?: ExpectedTaskOperationRefusal,
    extraExplanation?: string,
  ): void {
    if (operation.rejectedLogged) return;
    operation.rejectedLogged = true;
    const task = workspace?.task;
    const expectedRefusal = callSiteExpectedRefusal ?? operation.expectedRefusal;
    let explainedBy = failures
      .filter((failure) => LIFECYCLE_EXPLAINED_CHECKS.has(failure.check))
      .map((failure) => failure.check);
    if (explainedBy.length === 0 && extraExplanation) explainedBy = [extraExplanation];
    if (
      explainedBy.length === 0 &&
      expectedRefusal &&
      failures.every((failure) => !expectedRefusal.checks || expectedRefusal.checks.has(failure.check))
    ) {
      explainedBy = [expectedRefusal.reason];
    }
    const details = {
      operation: operation.label,
      operationId: operation.id,
      ageMs: Date.now() - operation.capturedAt,
      workspaceId: operation.workspaceId,
      taskId: operation.taskId,
      mode: operation.mode,
      state: task?.state ?? null,
      pausedFromState: task?.pausedFromState || null,
      expectedStates: expectedStates ? [...expectedStates] : null,
      round: { checked: operation.checksRound, expected: operation.round ?? null, current: task?.currentRound ?? null },
      evaluationAttempt: {
        checked: operation.checksEvaluationAttempt,
        expected: operation.evaluationAttempt ?? null,
        current: task?.companionEvaluationAttempt ?? null,
      },
      lifecycleEpoch: {
        expected: operation.lifecycleEpoch,
        current: this.#taskLifecycleEpoch.get(operation.workspaceId) || 0,
      },
      failedChecks: failures,
      explainedBy,
      sessions: Object.entries(operation.sessionEpochs).map(([sessionId, incarnation]) => ({
        sessionId,
        role: operation.sessionRoles[sessionId] ?? null,
        expectedIncarnation: incarnation,
        currentIncarnation: this.#sessionIncarnations.get(sessionId) || 0,
      })),
    };
    if (explainedBy.length > 0) {
      log.debug("task operation rejected as stale", details);
      return;
    }
    // Nothing says the task moved on, yet this step stops here — and nothing
    // else may be left to drive the task out of its current state.
    log.warn("task operation rejected as stale without a lifecycle change", details);
  }

  captureSessionTaskOperation(sessionId: string, label: string): (() => boolean) | null {
    const binding = this.#resolveTaskBinding(sessionId);
    if (!binding) return null;
    const workspace = binding.workspace;
    const task = workspace.task;
    const operation = this.#captureTaskOperation(workspace, label, {
      round: true,
      evaluationAttempt: task.mode === "attached",
      // The caller (the runtime's rate-limit confirm window, 60 s) only asks
      // whether a deferred hand-off still applies. An agent that printed the
      // limit text and then ended its turn moves the task on through the
      // ordinary idle path inside that window — the hand-off is moot then,
      // and the step that advanced the task drives it.
      expectedRefusal: { reason: "task-advanced-before-deferred-action", checks: TASK_ADVANCED_CHECKS },
    });
    const expectedState = task.state;
    return () => this.#currentTaskOperation(operation, new Set([expectedState])) !== null;
  }

  #currentTaskRound(
    operation: TaskOperationContext,
    expectedStates?: ReadonlySet<string>,
  ): { workspace: TaskWorkspaceState; round: TaskRound } | null {
    const workspace = this.#currentTaskOperation(operation, expectedStates);
    if (!workspace || !operation.checksRound) return null;
    const rounds = workspace.task.rounds as unknown as TaskRound[];
    const targetRound = operation.round || 1;
    const round = [...(rounds || [])].reverse().find((candidate) => candidate.round === targetRound);
    return round ? { workspace, round } : null;
  }

  #getCurrentStandardTask(
    workspaceId: string,
    taskId: string,
    currentRound: number,
    generation: number,
    expectedStates: ReadonlySet<string>,
    operation?: TaskOperationContext,
  ): TaskWorkspaceState | null {
    const currentGeneration = this.#standardTaskRunGeneration.get(workspaceId) || 0;
    const workspace = this.#findTaskWorkspace(workspaceId);
    const standardCurrent =
      !this.#disposed &&
      currentGeneration === generation &&
      !!workspace &&
      workspace.task.mode !== "attached" &&
      workspace.task.taskId === taskId &&
      workspace.task.currentRound === currentRound &&
      expectedStates.has(workspace.task.state);
    if (!operation) return standardCurrent ? workspace : null;
    // Run the operation's checks even when the standard ones already failed,
    // so the refusal is logged. Most standard checks repeat the operation's
    // own; pass on only those it cannot see.
    const extraFailures: TaskOperationCheckFailure[] = [];
    if (currentGeneration !== generation) {
      extraFailures.push({ check: "standardRunGeneration", expected: generation, actual: currentGeneration });
    }
    if (workspace) {
      const task = workspace.task;
      if (task.mode === "attached" && operation.mode === "attached") {
        extraFailures.push({ check: "mode", expected: "standard", actual: task.mode });
      }
      if (task.taskId !== taskId && taskId !== operation.taskId) {
        extraFailures.push({ check: "taskId", expected: taskId, actual: task.taskId });
      }
      if (task.currentRound !== currentRound && !(operation.checksRound && operation.round === currentRound)) {
        extraFailures.push({ check: "round", expected: currentRound, actual: task.currentRound });
      }
    }
    const current = this.#currentTaskOperation(operation, expectedStates, { extraFailures });
    return standardCurrent && current === workspace ? workspace : null;
  }

  /**
   * Invalidate pending work and pause active attached tasks when their Primary
   * source disappears; preserve already-paused recovery state and mark the
   * missing source visibly.
   */
  markAttachedSourceMissing(workspaceId: string): void {
    const workspace = this.#findTaskWorkspace(workspaceId);
    if (!workspace || workspace.task.mode !== "attached") return;
    const activeStates = new Set(["running", "evaluating", "judge-evaluating", "refreshing", "capturing-context"]);
    if (activeStates.has(workspace.task.state)) {
      workspace.task.pausedFromState = workspace.task.state;
      this.#setTaskState(workspace.task, "paused");
    } else {
      this.#advanceTaskLifecycle(workspaceId, "attached-source-missing");
      this.#cancelTaskInjections(workspace);
    }
    workspace.task.primaryMissing = true;
    void this.#logTaskEvent(
      workspace,
      "primary-missing",
      "The Primary conversation's workspace or tab no longer exists — recovery could not re-attach it.",
    );
    this.#raiseTaskAlert(
      workspace,
      "failed",
      "Primary conversation no longer exists. Its workspace or tab was closed — this companion task can't continue.",
    );
    this.#broadcastState!();
  }

  /**
   * Single gate in front of every action that drives an attached task forward
   * by injecting into the Primary (Start/Continue/answer). Each of those would
   * otherwise flip the badge to a working state and then write into a session
   * that no longer exists — the injections are fire-and-forget, so the failure
   * would only ever surface in the log.
   *
   * Returns true when the action may proceed. Recovery from a missing Primary
   * is delete-and-recreate (plan §8.7 step 5), so nothing here clears the flag;
   * only a task workspace bound to a live conversation ever gets past it.
   */
  #assertAttachedPrimaryAvailable(workspace: TaskWorkspaceState, action: string): boolean {
    const task = workspace.task;
    if (task.mode !== "attached" || !task.primaryMissing) return true;
    log.warn("attached action refused: Primary is gone", { workspaceId: workspace.id, action });
    void this.#logTaskEvent(
      workspace,
      "attached-action-refused",
      `${action} refused — the Primary conversation no longer exists. Delete this companion task and create a new one against a live conversation.`,
    );
    return false;
  }

  resumeTask(workspaceId: string): boolean {
    const workspace = this.#findTaskWorkspace(workspaceId);
    if (!workspace) return false;
    const resumable = new Set(["paused", "completed", "failed"]);
    if (!resumable.has(workspace.task.state)) return false;
    if (!this.#assertAttachedPrimaryAvailable(workspace, "Continue")) return false;

    const task = workspace.task;
    const previousState = task.state;
    this.#forgetUserActivity(workspace);
    this.#takeUserWordForScreens(workspace, ["worker", "judge"], "continue");
    this.#advanceTaskLifecycle(workspaceId, "resume");
    // Restore to the state we were in before pausing, not always "running".
    // If paused during judge-evaluating, resume to judge-evaluating so the
    // verdict can be read. If paused from capturing-context (attached only),
    // resume there so capture readiness gets re-checked. If paused from
    // evaluating/refreshing, fall back to running (the evaluation was
    // interrupted and needs to restart from the next worker idle).
    const pausedFromState = task.pausedFromState;
    const attachedPauseOrigins = new Set(["judge-evaluating", "capturing-context", "awaiting-user", "brief-ready"]);
    const resumeTo: TaskStateKind = attachedPauseOrigins.has(task.pausedFromState)
      ? (task.pausedFromState as TaskStateKind)
      : "running";
    task.pausedFromState = "";
    task.judgePolicyViolation = false;

    this.#setTaskState(task, resumeTo);
    log.info("task resumed", { workspaceId, previousState, resumeTo });
    void this.#logTaskEvent(workspace, "task-resumed", `Resumed to ${resumeTo}`);
    this.#broadcastState!();
    const resumedWorkspace = this.#findTaskWorkspace(workspaceId);
    if (!resumedWorkspace || resumedWorkspace.task.taskId !== task.taskId) return true;
    const operation = this.#captureTaskOperation(resumedWorkspace, "resume-reconcile", { round: true });

    // Krok 3 — resume actively reconciles against on-disk state instead of
    // passively flipping the badge and waiting for an idle hook that may never
    // arrive (incident A: "nothing happened"). All the disk reads are async, so
    // run it fire-and-forget; resumeTask stays synchronous for its callers.
    this.#reconcileAfterResume(resumedWorkspace, { previousState, pausedFromState, resumeTo }, operation).catch(
      (err: unknown) => {
        log.error("reconcileAfterResume failed", { workspaceId, err: (err as Error)?.message });
      },
    );

    return true;
  }

  /**
   * Krok 3 — drive the loop forward on resume based on what's actually on disk,
   * rather than waiting for an idle hook. Branches (first match wins):
   *
   *   0. showerResumePrompt set → recovery owns injection (deferred idle). Skip.
   *   1. verdict.json present AND the last round has no judgeVerdict → an unread
   *      verdict (possibly written during the pause) → process it, regardless of
   *      where we paused from. (Incident A step 4→6.)
   *   2. resumed to judge-evaluating, no verdict → re-run the full evaluation so
   *      the "all passed" branch rebuilds and injects a self-contained judge
   *      prompt — far better than a context-less nudge to a fresh judge.
   *   3. resumed to running, promptSent:
   *        - WORK_LOCK absent → worker signalled done → evaluate.
   *        - WORK_LOCK present, worker idle → inject a continuation prompt.
   *        - WORK_LOCK present, worker busy → let it run (its hook drives the loop).
   *   4. promptSent === false → late-deliver the initial prompt (old behaviour).
   *
   * Resuming a terminal task (completed/failed) only reconciles an unread
   * verdict; otherwise it leaves the task running for the user (Send Back / Reset
   * are the explicit terminal-task flows).
   */
  async #reconcileAfterResume(
    initialWorkspace: TaskWorkspaceState,
    { previousState, pausedFromState, resumeTo }: { previousState: string; pausedFromState: string; resumeTo: string },
    operation: TaskOperationContext,
  ): Promise<void> {
    let workspace = initialWorkspace;
    let task = workspace.task;
    const workspaceId = operation.workspaceId;
    let expectedStates: ReadonlySet<string> = new Set([resumeTo]);
    const refresh = (): boolean => {
      const fresh = this.#currentTaskOperation(operation, expectedStates);
      if (!fresh) return false;
      workspace = fresh;
      task = fresh.task;
      return true;
    };

    if (task.mode === "attached") {
      return this.#reconcileAttachedAfterResume(workspace, { previousState, pausedFromState, resumeTo }, operation);
    }

    const workerSessionId = `${workspaceId}:${task.workerPanelId}`;

    // 0. Recovery (resolveTaskRecovery) injects via the deferred-idle path — do
    // not double-drive it.
    if (task.showerResumePrompt) {
      void this.#logTaskEvent(
        workspace,
        "task-resumed-reconcile",
        "Recovery prompt pending — deferring to recovery idle path",
      );
      return;
    }

    // 1. Unread verdict on disk — highest priority, independent of pausedFromState.
    const verdict = await readVerdict(workspace.cwd, task.taskId, log);
    if (!refresh()) return;
    const verdictPresent = verdict.reason !== "Judge did not produce a verdict file.";
    const rounds = task.rounds as unknown as TaskRound[];
    const lastRound = rounds?.[rounds.length - 1];
    const lastRoundUnjudged = !lastRound || !lastRound.judgeVerdict;
    if (verdictPresent && lastRoundUnjudged) {
      log.info("reconcileAfterResume: unread verdict on disk — processing", { workspaceId, verdict: verdict.verdict });
      if (task.state !== "judge-evaluating") this.#setTaskState(task, "judge-evaluating");
      expectedStates = new Set(["judge-evaluating"]);
      void this.#logTaskEvent(
        workspace,
        "task-resumed-reconcile",
        `Unread verdict on disk (${verdict.verdict}) — processing it.`,
      );
      this.#broadcastState!();
      await this.#handleJudgeVerdict(workspace, "resume-reconcile", operation);
      return;
    }

    // 2. Was judge-evaluating, no verdict → re-run evaluation to rebuild a
    // self-contained judge prompt (checks pass: WORK_LOCK is gone).
    if (resumeTo === "judge-evaluating" || pausedFromState === "judge-evaluating") {
      log.info("reconcileAfterResume: judge-evaluating with no verdict — re-running evaluation", { workspaceId });
      task.judgeNudged = false;
      if (task.state !== "running") this.#setTaskState(task, "running");
      expectedStates = new Set(["running"]);
      void this.#logTaskEvent(
        workspace,
        "task-resumed-reconcile",
        "No verdict — re-running evaluation to rebuild judge prompt.",
      );
      this.#broadcastState!();
      await this.#evaluateWorker(workspace);
      return;
    }

    // 4. Initial prompt never delivered → send it now (old late-delivery path).
    if (!task.promptSent) {
      log.info("reconcileAfterResume: initial prompt never delivered — injecting", { workspaceId });
      void this.#logTaskEvent(
        workspace,
        "task-resumed-reconcile",
        "Initial prompt was never delivered — injecting now.",
      );
      const prompt = buildInitialWorkerPrompt(task);
      if (!refresh()) return;
      if (!(await this.#injectPrompt(workerSessionId, prompt, workspace))) return;
      if (!refresh()) return;
      task.promptSent = true;
      this.#broadcastState!();
      return;
    }

    // Terminal tasks (completed/failed) with a judged last round: leave running
    // for the user — don't silently re-evaluate. Send Back / Reset are explicit.
    if (previousState === "completed" || previousState === "failed") {
      void this.#logTaskEvent(
        workspace,
        "task-resumed-reconcile",
        `Resumed terminal task (${previousState}); awaiting user.`,
      );
      return;
    }

    // 3. Resumed to running with a prompt already sent — decide by WORK_LOCK.
    const workerDone = await this.isWorkerCompleted(workspaceId);
    if (!refresh()) return;
    if (workerDone) {
      log.info("reconcileAfterResume: WORK_LOCK absent — running evaluation", { workspaceId });
      void this.#logTaskEvent(
        workspace,
        "task-resumed-reconcile",
        "WORK_LOCK absent — worker signalled done; evaluating.",
      );
      await this.#evaluateWorker(workspace);
      return;
    }

    // Work remains. If the worker is provably busy, let its own hook drive the
    // loop; otherwise it's idle and stuck — inject a continuation prompt.
    if (this.#isSessionBusy?.(workerSessionId)) {
      log.info("reconcileAfterResume: worker busy — letting it run", { workspaceId });
      void this.#logTaskEvent(workspace, "task-resumed-reconcile", "Worker busy — letting it continue.");
      return;
    }
    const continuation = task.lastJudgeInstructions
      ? `Continue the task. Outstanding judge feedback to address:\n\n${task.lastJudgeInstructions}`
      : buildRecoveryPrompt({ role: "worker", round: task.currentRound, taskId: task.taskId });
    log.info("reconcileAfterResume: worker idle with work remaining — injecting continuation", { workspaceId });
    void this.#logTaskEvent(
      workspace,
      "task-resumed-reconcile",
      "Worker idle with work remaining — injecting continuation prompt.",
    );
    if (!refresh()) return;
    await this.#injectPrompt(workerSessionId, continuation, workspace);
    if (!refresh()) return;
  }

  /**
   * Reset a task to idle state — clears round history, recreates WORK_LOCK,
   * and returns to a clean starting point. Used for "Reset & Retry".
   */
  async resetTask(workspaceId: string): Promise<boolean> {
    let workspace = this.#findTaskWorkspace(workspaceId);
    if (!workspace) return false;
    // "brief-ready" is attached-only (never produced for standard tasks) —
    // plan §4.13 allows resetting+recreating from that paused-equivalent state.
    const resettable = new Set(["paused", "completed", "failed", "brief-ready"]);
    if (!resettable.has(workspace.task.state)) return false;

    let task = workspace.task;
    this.#cancelTaskInjections(workspace);
    this.#forgetUserActivity(workspace);
    const previousState = task.state;
    const isAttached = task.mode === "attached";
    this.#advanceTaskLifecycle(workspaceId, "reset");
    const operation = this.#captureTaskOperation(workspace, "reset-task");
    const refresh = (): boolean => {
      const fresh = this.#currentTaskOperation(operation, new Set([previousState]));
      if (!fresh) return false;
      workspace = fresh;
      task = fresh.task;
      return true;
    };

    // The ONE step of a reset that can fail is the filesystem one, and it used
    // to run last — after the state had already been flipped to `idle` and the
    // round history wiped. A failure there left a task that was neither reset
    // nor retryable: `idle` is not in `resettable`, so a second Reset was
    // refused outright, and recovery reported `failed` on a task it had
    // already destroyed (V5 review, §"P1 — failed recovery může zanechat task
    // jako running", oprava "fresh musí být transakční").
    //
    // So the file is written FIRST and the destructive mutation is committed
    // only once it is on disk. A failure is then a true no-op: the task keeps
    // its state, its rounds and its resettability, and the caller's `false`
    // means "nothing happened", not "half of it happened".
    if (!isAttached && !(await this.#recreateWorkLock(workspace, "reset"))) {
      log.warn("task reset refused: WORK_LOCK could not be recreated", { workspaceId, previousState });
      void this.#logTaskEvent(
        workspace,
        "task-reset-failed",
        "Reset did not run — WORK_LOCK could not be written. The task is unchanged and can be reset again.",
      );
      return false;
    }

    if (!refresh()) return false;

    this.#setTaskState(task, "idle");
    task.currentRound = 0;
    task.rounds = [];
    task.promptSent = false;
    task.pausedFromState = "";
    task.showerResumePrompt = "";
    task.lastShowerRound = 0;
    task.rateLimitedUntil = null;
    if (isAttached) {
      // Attached Primary is externally owned — Reset must NEVER send /clear
      // to it (plan §8.6). Also clear attached-only round bookkeeping so a
      // fresh capture starts from a clean slate.
      task.captureStartedAt = undefined;
      task.contextApprovedAt = undefined;
      task.companionPhase = undefined;
      task.pendingQuestions = [];
      task.verificationNotRequired = false;
      task.companionEvidence = undefined;
      task.companionLastFeedbackAt = undefined;
      // companionEvaluationAttempt is deliberately NOT reset — it is what makes
      // the previous run's verdict.json (same role, same baseline phase, same
      // round 1) detectable as stale instead of being read as the answer to the
      // first evaluation of the new run. Only the handled marker is dropped.
      task.companionVerdictHandledAttempt = undefined;
      task.captureNudged = false;
      task.judgePolicyViolation = false;
      // primaryMissing is deliberately NOT cleared: Reset re-runs the capture
      // against the same binding, and nothing here re-attaches a Primary that
      // no longer exists. Clearing it only made the task look continuable
      // again — the next Start would inject into a dead session.
      task.repeatedBlockingFindingIds = [];
    } else {
      // Tell the next Start to wipe Worker + Judge conversational context so
      // they don't run on stale memory of the previous attempt — particularly
      // important if the user edits the brief between Reset and Start.
      task.needsContextClear = true;
    }
    // Preserve lastJudgeInstructions — might be useful for next run
    this.#evaluating.delete(workspaceId);
    this.#clearWorkLockOverrideTimer(workspaceId);
    this.#stopPeriodicWorkLockProbe(workspaceId);
    this.#clearRateLimitResumeTimer(workspaceId, "worker");
    this.#rateLimitCtx.delete(this.#rlKey(workspaceId, "worker"));
    // Krok 9 — clear any judge rate-limit hold/timer/retry-ctx too.
    this.#rateLimitCtx.delete(this.#rlKey(workspaceId, "judge"));
    this.#judgeRateLimitedUntil.delete(workspaceId);
    this.#clearRateLimitResumeTimer(workspaceId, "judge");
    // Krok 9c — reset the short-turn heuristic for the fresh attempt.
    this.#workerInjectAt.delete(workspaceId);
    this.#shortWorkerTurns.delete(workspaceId);
    // Drop the per-session last-instruction cache and dropout counters so a
    // fresh run never resends a stale prompt or carries an old restart tally.
    for (const sid of [sessionIdFor(workspace, "worker"), sessionIdFor(workspace, "judge")]) {
      this.#lastInjected.delete(sid);
      this.#dropoutCtx.delete(sid);
    }

    log.info("task reset", { workspaceId, previousState });
    void this.#logTaskEvent(workspace, "task-reset", `Previous state: ${previousState}`);
    this.#broadcastState!();
    return true;
  }

  /**
   * Manually re-send the last instruction we injected into the worker or judge
   * session. Escape hatch for when an agent dropped out of agent mode and the
   * auto-restart didn't (or couldn't) recover — e.g. a CLI sitting at a forced
   * update / login prompt the runner can't drive. Re-injects verbatim via the
   * normal injection path (rebuilding PROMPT.md for long prompts).
   */
  async resendLastInstruction(workspaceId: string, role: "worker" | "judge"): Promise<boolean> {
    const workspace = this.#findTaskWorkspace(workspaceId);
    if (!workspace) return false;
    const sessionId = sessionIdFor(workspace, role);
    const vouched = this.#takeUserWordForScreens(workspace, [role], "resend");
    // A write into this session is already on its way (waiting for the user,
    // or going in) — possibly before any instruction was sent, like the /clear
    // ahead of the first one: a second write beside it would glue the two
    // together in the composer, and it carries the latest instruction anyway.
    if ((this.#deliveriesInFlight.get(sessionId) ?? 0) > 0 || (this.#politeWaits.get(sessionId) ?? 0) > 0) {
      log.info("resendLastInstruction: a delivery to this session is already in progress — not starting another", {
        workspaceId,
        role,
        vouched,
        ...this.#politeLogContext(sessionId),
      });
      const where = this.#panelPhrase(workspace.task, role);
      void this.#logTaskEvent(
        workspace,
        "resend-skipped",
        this.#politeWaitReason(sessionId) === "dialog-open"
          ? `The ${role}'s next write is already waiting — behind a dialog open in ${where}. Answer the dialog there and it goes in.`
          : vouched
            ? `Taken as your word that ${where} is at its prompt: the ${role}'s next write goes in as soon as the panel is free.`
            : `The ${role}'s next write is already on its way — it goes in as soon as the panel is free.`,
      );
      this.#broadcastState!();
      return true;
    }
    const text = this.#lastInjected.get(sessionId);
    if (!text) {
      log.warn("resendLastInstruction: nothing to resend", { workspaceId, role });
      void this.#logTaskEvent(workspace, "resend-skipped", `No previous ${role} instruction to resend yet.`);
      return false;
    }
    log.info("resendLastInstruction: re-injecting last instruction", { workspaceId, role, length: text.length });
    void this.#logTaskEvent(workspace, "resend-instruction", `Manually re-sent the last instruction to the ${role}.`);
    this.#injectPrompt(sessionId, text, workspace).catch((err: unknown) => {
      log.error("resendLastInstruction: inject failed", { workspaceId, role, err: (err as Error)?.message });
    });
    this.#broadcastState!();
    return true;
  }

  /**
   * User rejects the judge's "complete" (or max-rounds "failed") verdict and
   * sends the worker back to the loop with their own feedback. Treated as an
   * override of the last verdict: recreates WORK_LOCK, starts a new round, and
   * injects a user-feedback prompt that tells the worker to re-run the full
   * self-audit and address the feedback plus any additional gaps.
   */
  async rejectTaskVerdict(workspaceId: string, feedback: string): Promise<boolean> {
    const workspace = this.#findTaskWorkspace(workspaceId);
    if (!workspace) return false;
    // Taken synchronously, before the first await below — the dialog leaves its
    // "Send back" button live for the whole request, so a double click delivers
    // two calls in the same tick and the reopenable-state check alone lets both
    // through (see #rejectingVerdict).
    if (this.#rejectingVerdict.has(workspaceId)) {
      log.warn("rejectTaskVerdict: already in flight for this workspace", { workspaceId });
      return false;
    }
    const owner = this.#nextOperationId();
    this.#rejectingVerdict.add(workspaceId);
    this.#rejectOwners.set(workspaceId, owner);
    try {
      return await this.#rejectTaskVerdict(workspace, feedback, owner);
    } finally {
      if (this.#rejectOwners.get(workspaceId) === owner) {
        this.#rejectOwners.delete(workspaceId);
        this.#rejectingVerdict.delete(workspaceId);
      }
    }
  }

  async #rejectTaskVerdict(
    initialWorkspace: TaskWorkspaceState,
    feedback: string,
    rejectOwner: number,
  ): Promise<boolean> {
    let workspace = this.#findTaskWorkspace(initialWorkspace.id);
    if (!workspace || workspace.task.taskId !== initialWorkspace.task.taskId) return false;
    const workspaceId = workspace.id;
    let task = workspace.task;
    const reopenable = new Set(["completed", "failed"]);
    if (!reopenable.has(task.state)) {
      log.warn("rejectTaskVerdict: task not in reopenable state", { workspaceId, state: task.state });
      return false;
    }
    // Send back re-opens a round and injects into the Primary before it can
    // discover the session is gone — same gate as Start/Continue/answer.
    if (!this.#assertAttachedPrimaryAvailable(workspace, "Send back")) return false;
    const trimmed = String(feedback || "").trim();
    if (!trimmed) {
      log.warn("rejectTaskVerdict: empty feedback", { workspaceId });
      return false;
    }

    const previousState = task.state;
    this.#advanceTaskLifecycle(workspaceId, "reject-verdict");
    this.#rejectingVerdict.add(workspaceId);
    this.#rejectOwners.set(workspaceId, rejectOwner);
    workspace = this.#findTaskWorkspace(workspaceId);
    if (!workspace || workspace.task.taskId !== task.taskId) return false;
    task = workspace.task;
    let operation = this.#captureTaskOperation(workspace, "reject-task-verdict", { round: true });
    let expectedStates: ReadonlySet<string> = new Set([previousState]);
    const refresh = (): boolean => {
      const fresh = this.#currentTaskOperation(operation, expectedStates);
      if (!fresh) return false;
      workspace = fresh;
      task = fresh.task;
      return true;
    };

    // Everything below the prompt build mutates the round bookkeeping the
    // prompt itself quotes ("Round N/M"), so the mutation has to come first —
    // and be fully undoable. Restoring only `state` (all this used to do) left
    // the round consumed and the chip pushed, so a retry after a failed
    // injection silently skipped a round and stacked up phantom chips.
    const rounds = task.rounds as unknown as TaskRound[];
    const lastRound = rounds?.[rounds.length - 1];
    const snapshot = {
      currentRound: task.currentRound,
      maxRounds: task.maxRounds,
      lastJudgeInstructions: task.lastJudgeInstructions,
      lastRoundAction: lastRound?.action ?? "",
      roundCount: rounds?.length || 0,
      totalPausedMs: task.totalPausedMs,
      pausedAt: task.pausedAt,
      finishedAt: task.finishedAt,
      companionLastFeedbackAt: task.companionLastFeedbackAt,
    };

    // Single undo path for everything this method touches, disk included —
    // both failure points below (staging the verification artifacts and
    // injecting the prompt) leave the task exactly as they found it.
    let restoreVerification: (() => Promise<void>) | null = null;
    // Returns whether the on-disk evidence made it back. A disk failure there
    // must not cost the in-memory undo as well, so the bookkeeping restore is
    // attempted after the disk operation either way, and the caller tells the
    // user which of the two happened.
    const rollback = async (): Promise<{ verificationRestored: boolean }> => {
      let verificationRestored = true;
      if (!refresh()) return { verificationRestored };
      try {
        if (restoreVerification) {
          await restoreVerification();
          restoreVerification = null;
        }
      } catch (err: unknown) {
        verificationRestored = false;
        restoreVerification = null;
        log.error("rejectTaskVerdict: verification rollback failed", {
          workspaceId,
          err: (err as Error)?.message,
        });
      }
      if (refresh()) {
        task.currentRound = snapshot.currentRound;
        task.maxRounds = snapshot.maxRounds;
        task.lastJudgeInstructions = snapshot.lastJudgeInstructions;
        task.companionLastFeedbackAt = snapshot.companionLastFeedbackAt;
        const currentRounds = task.rounds as unknown as TaskRound[];
        if (currentRounds && currentRounds.length > snapshot.roundCount) currentRounds.length = snapshot.roundCount;
        const currentLastRound = currentRounds?.at(-1);
        if (currentLastRound) currentLastRound.action = snapshot.lastRoundAction;
        this.#setTaskState(task, previousState as TaskStateKind);
        // #setTaskState re-stamps the terminal timing on the way back — restore
        // the original values so the Dashboard's "ended HH:MM" doesn't jump.
        task.totalPausedMs = snapshot.totalPausedMs;
        task.pausedAt = snapshot.pausedAt;
        task.finishedAt = snapshot.finishedAt;
      }
      return { verificationRestored };
    };

    // Idempotent, and the lock is what tells the runner this round is still in
    // progress — a rollback deliberately leaves it in place rather than
    // re-signalling "done" for work the Primary was never asked to redo.
    if (!refresh()) return false;
    const workLockReady = await this.#recreateWorkLock(workspace, "rejectVerdict");
    if (!refresh()) return false;
    if (!workLockReady) {
      const { verificationRestored } = await rollback();
      void this.#logTaskEvent(
        workspace,
        "verdict-reject-failed",
        verificationRestored
          ? "Could not prepare the re-opened round — the verdict stands, try again."
          : `Could not prepare the re-opened round — ${VERIFICATION_FILE} could not be restored. Check it before sending back again.`,
      );
      return false;
    }
    const currentLastRound = (task.rounds as unknown as TaskRound[]).at(-1);
    if (currentLastRound) currentLastRound.action = "re-prompted";

    // User override starts a fresh round. Increment currentRound so the new
    // chip (pushed by ensureRunningRound below) gets the next number. If we
    // hit the max-rounds ceiling (task was failed or completed at the limit),
    // grant one more round's worth so the next eval doesn't immediately fail
    // again — user can Send Back repeatedly.
    task.currentRound = (task.currentRound || 0) + 1;
    if ((task.maxRounds || 0) < task.currentRound) {
      task.maxRounds = task.currentRound;
    }
    task.lastJudgeInstructions = `User override: ${trimmed}`;

    this.#setTaskState(task, "running");
    expectedStates = new Set(["running"]);
    this.#ensureRunningRound(task);
    operation = this.#captureTaskOperation(workspace, "reject-task-verdict", { round: true });

    const useWorkerFile = await this.#ensureFormatFlag(task, workspace);
    if (!refresh()) return false;
    task.useWorkerFile ??= useWorkerFile;
    const prompt =
      task.mode === "attached"
        ? buildCompanionUserFeedbackPrompt(task, trimmed)
        : buildUserFeedbackPrompt(task, trimmed);
    const workerSessionId = sessionIdFor(workspace, "worker");

    if (task.mode === "attached") {
      // Same two artifacts the Companion's own "continue" path hands the
      // Primary: a VERIFICATION.md template tagged for the round it is now
      // working on, and a freshness baseline the next record has to beat.
      // Without them the next round-review would gate on a record still tagged
      // for the round the user just re-opened and burn a nudge cycle.
      //
      // Staged BEFORE the injection, because the Primary may start recording
      // the moment the prompt lands and a template arriving behind it would
      // wipe that record. The template also overwrites the record this round
      // was signed off against, so it is staged reversibly and rolled back
      // together with the round bookkeeping if the send back never lands.
      try {
        if (!refresh()) return false;
        restoreVerification = await writeVerificationTemplateReversibly(
          workspace.cwd,
          task.taskId,
          task.currentRound,
          log,
        );
        if (!refresh()) return false;
      } catch (err: unknown) {
        if (!refresh()) return false;
        log.error("rejectTaskVerdict: verification template write failed", {
          workspaceId,
          err: (err as Error)?.message,
        });
        await rollback();
        void this.#logTaskEvent(
          workspace,
          "verdict-reject-failed",
          "Could not prepare the verification record for the re-opened round — the verdict stands, try again.",
        );
        this.#broadcastState!();
        return false;
      }
      // Template first, baseline second: a baseline older than the template it
      // guards would let the empty template pass as this round's evidence.
      task.companionLastFeedbackAt = new Date().toISOString();
    }

    const target = task.mode === "attached" ? "Primary conversation" : "Worker";
    // A delivery that fails undoes the round, says so on the task log, and —
    // once the user's action has already returned — raises an alert, so the
    // failure reaches them either way.
    const failDelivery = async (err: unknown, afterReturn: boolean): Promise<void> => {
      log.error("rejectTaskVerdict: failed to inject prompt", {
        workspaceId,
        afterReturn,
        err: err instanceof Error ? err.message : err === null ? "not delivered" : String(err),
      });
      const { verificationRestored } = await rollback();
      const message = verificationRestored
        ? `Could not deliver your feedback to the ${target} — the verdict stands, try again.`
        : `Could not deliver your feedback to the ${target} — the verdict stands, but ${VERIFICATION_FILE} could NOT be put back and now holds an empty template. Check it before sending back again.`;
      const current = workspace;
      if (!current) return;
      void this.#logTaskEvent(current, "verdict-reject-failed", message);
      if (afterReturn) this.#raiseTaskAlert(current, "failed", message);
      this.#broadcastState!();
    };

    if (!refresh()) return false;
    // The prompt waits for the user if they are working in the panel — that
    // can take minutes, and the user's own Send back must not: a request with
    // no answer for 30 s is dropped by the mobile relay. Whatever is still
    // undecided once the delivery has to wait goes on in the background, like
    // Resend.
    const settled = this.#injectPrompt(workerSessionId, prompt, workspace).then(
      (delivered) => ({ delivered, err: null as unknown }),
      (err: unknown) => ({ delivered: false, err }),
    );
    const outcome = await this.#awaitUnlessUserDefers(workspaceId, settled);
    if (!outcome.done) {
      log.info("rejectTaskVerdict: feedback queued until the user is done in the panel", {
        workspaceId,
        round: task.currentRound,
        ...this.#politeLogContext(workerSessionId),
      });
      void settled.then(async ({ delivered, err }) => {
        if (delivered) return;
        if (err || refresh() || this.#onlySessionsChanged(operation, expectedStates)) {
          // The task still stands where Send back left it (at most its session
          // was replaced): undo the round and say so.
          const current = this.#findTaskWorkspace(workspaceId);
          if (current && !refresh())
            operation = this.#captureTaskOperation(current, "reject-task-verdict", { round: true });
          await failDelivery(err, true);
          return;
        }
        // The task moved on before the feedback went in (Pause, the session
        // exiting, Reset). Nothing to undo — but the user must know it never
        // arrived; it stays the last instruction, so Resend can deliver it.
        const current = this.#findTaskWorkspace(workspaceId);
        if (!current || current.task.taskId !== operation.taskId) return;
        const message = `Your feedback did not reach the ${target} (the task is now ${current.task.state}). It is kept as the last instruction — use Resend once the ${target} is working again.`;
        log.error("rejectTaskVerdict: feedback was not delivered", {
          workspaceId,
          state: current.task.state,
          ...this.#politeLogContext(workerSessionId),
        });
        void this.#logTaskEvent(current, "verdict-reject-undelivered", message);
        this.#raiseTaskAlert(current, "failed", message);
        this.#broadcastState!();
      });
    } else if (!outcome.value.delivered) {
      if (!refresh()) return false;
      await failDelivery(outcome.value.err, false);
      return false;
    } else if (!refresh()) {
      return false;
    }

    log.info("task verdict rejected by user", { workspaceId, previousState, round: task.currentRound });
    void this.#logTaskEvent(workspace, "verdict-rejected", `User feedback: ${trimmed}`);
    this.#broadcastState!();
    return true;
  }

  // ---------------------------------------------------------------------------
  // Idle detection entry point — called from runtime.js
  // ---------------------------------------------------------------------------

  /**
   * Called when an agent session goes idle (hook, OSC 133, or silence fallback).
   * Returns true if this session belongs to a task workspace and was handled.
   */
  onAgentIdle(sessionId: string, source = "unknown"): boolean {
    const binding = this.#resolveTaskBinding(sessionId);
    if (!binding) {
      log.trace("onAgentIdle: not a task workspace", { sessionId });
      return false;
    }
    const { workspace, task, role } = binding;
    const workspaceId = workspace.id;
    const isWorker = role === "worker";
    const isJudge = role === "judge";
    // Before any state branch: the turn ended whatever the task does with it.
    this.#noteAgentSignal(sessionId, source);
    // A dialog is the agent asking the user something in the middle of its
    // turn — not an idle. Nothing here may treat it as one: no nudge (Claude
    // delivers a message typed mid-turn into the running turn), no evaluation,
    // no round. Not consumed either, so the runtime raises the user's own
    // alert for it — in a task panel nothing else would tell them.
    if (DIALOG_IDLE_SOURCES.has(source)) {
      // A permission prompt is classified urgent, so the runtime's own alert
      // reaches the user. Any other dialog (an MCP elicitation, a session
      // needing input) is a normal-urgency question, which raiseAlert in
      // runtime-attention.ts holds back while the runner owns the turn — and
      // with no runner write waiting, no long-wait warning would follow
      // either. Then the task tells the user itself, at once.
      const runtimeHoldsBack = source !== "hook:permission_prompt" && this.#runtimeHoldsBackQuestions(task, role);
      log.info("onAgentIdle: a dialog waits for the user in a task panel — not the task's idle", {
        sessionId,
        source,
        workspaceId,
        role,
        taskState: task.state,
        runnerAlerts: runtimeHoldsBack,
      });
      if (runtimeHoldsBack) this.#tellUserTaskWaits(sessionId, "dialog-open");
      return false;
    }
    // A runner write is still waiting for the user here, so this idle ends a
    // turn of theirs (or one from before it) — not the agent's answer to the
    // write the task is waiting on. Driving the task with it would start an
    // evaluation, a nudge or the same prompt again ahead of that write.
    if ((this.#politeWaits.get(sessionId) ?? 0) > 0) {
      log.debug("onAgentIdle: a runner write waits for the user in this session — not the task's idle", {
        sessionId,
        source,
        ...this.#politeLogContext(sessionId),
      });
      return true;
    }
    log.debug("onAgentIdle: task workspace found", {
      sessionId,
      workspaceId,
      role,
      taskState: task.state,
      workerPanelId: task.workerPanelId,
      judgePanelId: task.judgePanelId,
      promptSent: task.promptSent,
      currentRound: task.currentRound,
    });

    // Attached (Companion loop) tasks have a materially different lifecycle
    // (no built-in project checks, a Companion-specific verdict schema,
    // externally-owned Primary session) — dispatch entirely to the
    // attached-mode handler so every branch below stays byte-for-byte
    // unchanged for standard tasks.
    if (task.mode === "attached") {
      return this.#onAttachedAgentIdle(workspace, role, sessionId, source);
    }

    // Paused: user might be hands-on (reviewing, resuming, asking questions
    // in the worker/judge panel). Fall through so they can be alerted.
    // See plan § 3.2.d rule 4.
    if (task.state === "paused") {
      log.debug("onAgentIdle: paused task, falling through to user pipeline", { sessionId, taskState: task.state });
      return false;
    }

    // Rate-limit hold: if the worker hit its quota and we're waiting for the
    // reset, don't try to evaluate or re-prompt — the worker can't act yet.
    // The scheduled timer in #scheduleRateLimitResume nudges it when the
    // window expires; if the marker is stale, clear it and proceed normally.
    //
    // Safety net: if the worker actually finished while the hold was set
    // (false-positive rate-limit detection that was confirmed by the silence
    // window — e.g. agent fell quiet right after emitting a code mention of
    // "rate-limited"), the WORK_LOCK file is gone. Schedule an async check;
    // if WORK_LOCK is missing, override the hold and run evaluation so the
    // judge can finally see the finished work. Without this, a misfire
    // silently blocks the judge from ever running.
    if (task.rateLimitedUntil) {
      const until = Date.parse(task.rateLimitedUntil);
      if (Number.isFinite(until) && until > Date.now()) {
        log.debug("onAgentIdle: worker is rate-limited, suppressing", {
          sessionId,
          rateLimitedUntil: task.rateLimitedUntil,
        });
        this.#scheduleWorkLockOverrideCheck(workspaceId, sessionId);
        return true;
      }
      task.rateLimitedUntil = null;
    }

    if (isWorker && task.state === "running") {
      // First idle after start: agent is ready — send the task prompt
      // (like codex-runner's send_keys after detecting idle)
      if (!task.promptSent) {
        // After a shower, use the resume prompt (with handoff context); otherwise initial prompt
        const isResume = !!task.showerResumePrompt;
        const prompt = task.showerResumePrompt || buildInitialWorkerPrompt(task);
        log.info("worker ready, injecting prompt", { workspaceId, sessionId, isResume });
        // Ensure a "running" round chip exists for this iteration — covers
        // description-empty initial inject (idempotent vs. startTask) and the
        // post-shower case where the previous round ended as "shower".
        this.#ensureRunningRound(task);
        this.#injectPrompt(`${workspaceId}:${task.workerPanelId}`, prompt, workspace).catch((err: unknown) => {
          log.error("failed to inject prompt", { workspaceId, err: (err as Error)?.message });
        });
        task.promptSent = true;
        task.showerResumePrompt = ""; // Clear after use
        this.#broadcastState!();
        return true;
      }

      // Dropout guard: the "idle" might actually be the agent CLI having exited
      // back to the shell (forced update / crash). Re-prompting now would type
      // the instruction into a bare shell. Restart the agent instead.
      if (this.#isAgentDroppedToShell?.(sessionId)) {
        this.#handleAgentDropout(workspace, sessionId, "worker").catch((err: unknown) => {
          log.error("handleAgentDropout (worker) error", { workspaceId, err: (err as Error)?.message });
        });
        return true;
      }
      // Reached a normal agent idle (not a shell prompt) → the agent is back to
      // working, so clear any dropout restart tally. Counting only consecutive
      // dropouts that never recover is what makes a flapping CLI hit the cap.
      this.#dropoutCtx.delete(sessionId);

      const elapsedMs = task.startedAt ? Date.now() - (task.startedAt as unknown as number) : 0;
      log.info("worker idle detected, starting evaluation", {
        workspaceId,
        sessionId,
        round: task.currentRound,
        elapsedMs,
        source,
      });
      void this.#logTaskEvent(
        workspace,
        "worker-idle-detected",
        `Worker went idle via ${source} (${(elapsedMs / 1000).toFixed(1)}s since start). Starting checks…`,
      );
      this.#trackShortWorkerTurn(workspace);
      this.#evaluateWorker(workspace).catch((err: unknown) => {
        log.error("evaluateWorker error", { workspaceId, err: (err as Error)?.message });
      });
      return true;
    }

    if (isJudge && task.state === "judge-evaluating") {
      if (this.#programmaticJudges.has(workspaceId)) {
        log.debug("judge idle ignored while programmatic judge is running", { workspaceId, sessionId, source });
        return true;
      }
      // Recovery path: if a recovery prompt is pending, inject it before reading verdict.
      // showerResumePrompt is reused here for judge sessions spawned via resolveTaskRecovery.
      if (task.showerResumePrompt) {
        const prompt = task.showerResumePrompt;
        task.showerResumePrompt = "";
        log.info("judge recovery: injecting recovery prompt on first idle", { workspaceId, sessionId });
        this.#injectPrompt(sessionId, prompt, workspace).catch((err: unknown) => {
          log.error("judge recovery prompt injection failed", { workspaceId, err: (err as Error)?.message });
        });
        this.#broadcastState!();
        return true; // Wait for next idle to read verdict
      }
      // Dropout guard (judge side): a "verdict missing" that's really the judge
      // CLI having exited back to the shell. Restart instead of nudging a shell.
      if (this.#isAgentDroppedToShell?.(sessionId)) {
        this.#handleAgentDropout(workspace, sessionId, "judge").catch((err: unknown) => {
          log.error("handleAgentDropout (judge) error", { workspaceId, err: (err as Error)?.message });
        });
        return true;
      }
      // Normal judge idle (not a shell prompt) → clear any dropout restart tally.
      this.#dropoutCtx.delete(sessionId);

      log.info("judge idle detected, reading verdict", { workspaceId, sessionId, source });
      void this.#logTaskEvent(workspace, "judge-idle-detected", `Judge went idle via ${source}. Reading verdict…`);
      this.#handleJudgeVerdict(workspace, source).catch((err: unknown) => {
        log.error("handleJudgeVerdict error", { workspaceId, err: (err as Error)?.message });
      });
      return true;
    }

    // Worker/judge panel in a non-actionable state: idle/completed/failed
    // (task never started or already finished) or evaluating/refreshing
    // (task is between phases, driven by the runner itself). In all these
    // cases the user hasn't asked for attention on this panel, so we
    // consume the hook event to prevent spurious "waiting for input"
    // notifications from auto-spawned Claude sessions.
    log.debug("onAgentIdle: worker/judge panel in non-actionable state, consuming", {
      sessionId,
      taskState: task.state,
      isWorker,
      isJudge,
    });
    return true;
  }

  /**
   * Called when worker output matches a known rate-limit pattern (Claude
   * Code's `/rate-limit-options` dialog, Codex/Gemini/Copilot exit messages,
   * or a generic keyword). Behaviour:
   *
   *   - Claude Code prompt-limit (`needsConfirm: true`): session is alive and
   *     waiting at the dialog. We press Enter to accept the highlighted
   *     "Stop and wait" default. At resume time we send `continue` (matches
   *     autoclaude / claude-auto-retry; Claude Code does NOT auto-resume on
   *     its own — see anthropics/claude-code#18980, #26789).
   *   - CLI-exit providers (`needsConfirm: false`): the worker process is
   *     dead. We schedule a `restartSession()` at resume time and let
   *     `onAgentIdle` re-inject the task prompt fresh.
   *
   * Retry safety: per-task counter capped at MAX_RETRIES; over the cap we
   * pause the task instead of looping. Each event sends `continue` exactly
   * once — if Claude is still rate-limited after that send, the detector
   * fires again and the cycle reschedules naturally (no separate poll loop,
   * no exponential spam — claude-code#22758 cautions against retry storms).
   *
   * Same-window dedup: redrawn dialogs (UI repaints) won't restack timers.
   */
  /**
   * Krok 9 — role-aware rate-limit entry point. Routes to the worker path or
   * the judge path by panel id. The judge path was previously dropped entirely
   * (incident C: judge stuck at the dialog, verdict never read for 2h+).
   */
  onAgentRateLimited(sessionId: string, match: RateLimitMatch, source = "unknown"): boolean {
    const binding = this.#resolveTaskBinding(sessionId);
    if (!binding) return false;
    if (binding.role === "judge") {
      return this.#handleJudgeRateLimited(binding.workspace, sessionId, match, source);
    }
    return this.onWorkerRateLimited(sessionId, match, source);
  }

  onWorkerRateLimited(sessionId: string, match: RateLimitMatch, source = "unknown"): boolean {
    const binding = this.#resolveTaskBinding(sessionId);
    if (!binding || binding.role !== "worker") return false;
    return this.#handleRateLimited(binding.workspace, sessionId, match, source, "worker");
  }

  /** Attached mode — how many rewrites of a malformed/stale companion verdict
   * the runner asks for before pausing. Only a verdict the Companion actually
   * changed costs an attempt (see companionRepairFingerprint), so this is a
   * budget of genuine tries, not of idle signals. */
  static MAX_COMPANION_VERDICT_REPAIRS = 3;

  /** Static-ish constants attached to the class for easy override in tests. */
  static MAX_RATE_LIMIT_RETRIES = 5;
  static RATE_LIMIT_HARD_STOP_MS = 12 * 60 * 60_000;
  static RATE_LIMIT_RESUME_MARGIN_MS = 60_000;
  static RATE_LIMIT_FALLBACK_DELAYS_MS = [30 * 60_000, 60 * 60_000, 120 * 60_000];

  #fallbackRateLimitReset(retriesSoFar: number): Date {
    const ladder = AgentTaskRunner.RATE_LIMIT_FALLBACK_DELAYS_MS;
    const idx = Math.min(Math.max(retriesSoFar, 0), ladder.length - 1);
    return new Date(Date.now() + ladder[idx]!);
  }

  /**
   * Krok 9b unification — shared dedup/retry-cap/schedule core for both the
   * worker and judge rate-limit paths, keyed throughout via #rlKey(workspaceId,
   * role). The two paths differ in a few respects that are intentionally kept
   * distinct rather than normalized away (see call sites of `role ===`
   * below): where the hold-until value is stored (task.rateLimitedUntil,
   * persisted, for the worker vs. the transient #judgeRateLimitedUntil map for
   * the judge), whether a resume should respawn a CLI-exit session
   * (worker-only — the judge never sets ctx.needsRestart), and the worker-only
   * WORK_LOCK probe/override subsystem (the judge produces no WORK_LOCK).
   * Log/TASK_LOG text is preserved verbatim per role rather than merged.
   */
  #handleRateLimited(
    workspace: TaskWorkspaceState,
    sessionId: string,
    match: RateLimitMatch,
    source: string,
    role: "worker" | "judge",
  ): boolean {
    const workspaceId = workspace.id;
    const task = workspace.task;
    const ctxKey = this.#rlKey(workspaceId, role);
    const ctx = this.#rateLimitCtx.get(ctxKey) ?? { needsRestart: false, retries: 0 };
    const isFirstHit = !this.#rateLimitTimers.has(ctxKey);

    // Resolve resetAt: provider-supplied, or exponential fallback by retry
    // count (30 → 60 → 120 min). Hard ceiling protects against parsing typos
    // ("83 hours") and runaway loops.
    const resetAt = match.resetAt ?? this.#fallbackRateLimitReset(ctx.retries);
    const waitMs = resetAt.getTime() - Date.now();
    if (waitMs > AgentTaskRunner.RATE_LIMIT_HARD_STOP_MS) {
      if (role === "worker") {
        log.error("rate-limit reset > hard stop, pausing task", { workspaceId, waitMs });
        void this.#logTaskEvent(
          workspace,
          "worker-rate-limit-failed",
          `Rate-limit reset is ${(waitMs / 3_600_000).toFixed(1)}h away (over 12h limit). Pausing task.`,
        );
      } else {
        log.error("judge rate-limit reset > hard stop, pausing task", { workspaceId, waitMs });
        void this.#logTaskEvent(
          workspace,
          "judge-rate-limit-failed",
          `Judge rate-limit reset is ${(waitMs / 3_600_000).toFixed(1)}h away (over 12h limit). Pausing.`,
        );
      }
      this.#pauseFromRateLimit(workspace, role, "reset > 12h");
      return true;
    }

    // Same-window dedup: existing hold for this exact reset → keep it. Worker
    // hold lives in the persisted task.rateLimitedUntil (ISO string, parsed);
    // judge hold lives in the transient #judgeRateLimitedUntil map (already a
    // number) — Number.isFinite is a no-op guard for the judge branch (always
    // finite) and the real guard for the worker's Date.parse result.
    const existing =
      role === "worker"
        ? task.rateLimitedUntil
          ? Date.parse(task.rateLimitedUntil)
          : 0
        : (this.#judgeRateLimitedUntil.get(workspaceId) ?? 0);
    if (
      this.#rateLimitTimers.has(ctxKey) &&
      Number.isFinite(existing) &&
      Math.abs(existing - resetAt.getTime()) < 60_000
    ) {
      log.trace(
        role === "worker"
          ? "onWorkerRateLimited: already scheduled for this window"
          : "handleJudgeRateLimited: already scheduled for this window",
        { workspaceId, source },
      );
      return true;
    }

    if (isFirstHit) ctx.retries += 1;
    if (role === "worker") ctx.needsRestart = !match.needsConfirm;
    if (ctx.retries > AgentTaskRunner.MAX_RATE_LIMIT_RETRIES) {
      if (role === "worker") {
        log.error("rate-limit retry cap exceeded, pausing task", { workspaceId, retries: ctx.retries });
        void this.#logTaskEvent(
          workspace,
          "worker-rate-limit-failed",
          `Worker rate-limited ${ctx.retries} times in a row — pausing task. Resume manually when usage frees up.`,
        );
      } else {
        log.error("judge rate-limit retry cap exceeded, pausing task", { workspaceId, retries: ctx.retries });
        void this.#logTaskEvent(
          workspace,
          "judge-rate-limit-failed",
          `Judge rate-limited ${ctx.retries} times in a row — pausing task. Resume manually when usage frees up.`,
        );
      }
      this.#pauseFromRateLimit(workspace, role, "retry cap");
      return true;
    }
    this.#rateLimitCtx.set(ctxKey, ctx);

    if (role === "worker") {
      log.warn("worker rate-limited, scheduling resume", {
        workspaceId,
        sessionId,
        source,
        providerHint: match.providerHint,
        needsConfirm: match.needsConfirm,
        retries: ctx.retries,
        resetAt: resetAt.toISOString(),
        waitMs,
      });
      task.rateLimitedUntil = resetAt.toISOString();
      void this.#logTaskEvent(
        workspace,
        "worker-rate-limited",
        `Worker hit its rate limit (${match.providerHint}, retry ${ctx.retries}/${AgentTaskRunner.MAX_RATE_LIMIT_RETRIES}). Resuming after ${resetAt.toLocaleTimeString()}.`,
      );
      // Periodic WORK_LOCK probe: if this hold is a false positive (worker's
      // own output happened to mention rate-limit terms) and the worker
      // actually finishes during the hold window, the probe will notice
      // WORK_LOCK is gone and unblock the judge — even if no idle hook lands.
      this.#startPeriodicWorkLockProbe(workspaceId);
    } else {
      this.#judgeRateLimitedUntil.set(workspaceId, resetAt.getTime());
      log.warn("judge rate-limited, scheduling resume", {
        workspaceId,
        source,
        providerHint: match.providerHint,
        retries: ctx.retries,
        resetAt: resetAt.toISOString(),
      });
      void this.#logTaskEvent(
        workspace,
        "judge-rate-limited",
        `Judge hit its rate limit (${match.providerHint}, retry ${ctx.retries}/${AgentTaskRunner.MAX_RATE_LIMIT_RETRIES}). Resuming after ${resetAt.toLocaleTimeString()}.`,
      );
    }
    this.#broadcastState!();

    // Confirm prompt (Claude Code only): Enter selects the highlighted default
    // option ("1. Stop and wait for limit to reset"). Worker-only here — the
    // judge dismisses the dialog unconditionally up front, in
    // #handleJudgeRateLimited, before any of the checks above run (see that
    // method's comment for why this divergence is preserved rather than
    // unified: it's an intentional Krok 9b fix for a judge-specific hang).
    if (role === "worker" && match.needsConfirm && this.#writeToSession) {
      this.#pressDialogEnter(workspace, sessionId);
    }

    this.#scheduleRateLimitResume(workspaceId, resetAt, role);
    return true;
  }

  #clearRateLimitResumeTimer(workspaceId: string, role: "worker" | "judge"): void {
    const key = this.#rlKey(workspaceId, role);
    const timer = this.#rateLimitTimers.get(key);
    if (timer) clearTimeout(timer);
    this.#rateLimitTimers.delete(key);
  }

  #scheduleRateLimitResume(workspaceId: string, resetAt: Date, role: "worker" | "judge"): void {
    this.#clearRateLimitResumeTimer(workspaceId, role);
    // Wait until the reset wall-clock plus margin; never less than the
    // margin even if parsing put the target in the past.
    const margin = AgentTaskRunner.RATE_LIMIT_RESUME_MARGIN_MS;
    const waitMs = Math.max(margin, resetAt.getTime() - Date.now() + margin);
    const key = this.#rlKey(workspaceId, role);
    const timer = setTimeout(() => {
      this.#rateLimitTimers.delete(key);
      const resume =
        role === "worker" ? this.#resumeFromRateLimit(workspaceId) : this.#resumeJudgeFromRateLimit(workspaceId);
      resume.catch((err: unknown) => {
        log.error(role === "worker" ? "rate-limit resume failed" : "judge rate-limit resume failed", {
          workspaceId,
          err: (err as Error)?.message,
        });
      });
    }, waitMs);
    if (typeof timer.unref === "function") timer.unref();
    this.#rateLimitTimers.set(key, timer);
  }

  /** Krok 9b unification — shared pause path for both roles (previously
   *  #pauseFromRateLimit / #pauseJudgeFromRateLimit). Worker-only: clears the
   *  WORK_LOCK probe/override subsystem and the persisted task.rateLimitedUntil
   *  field, and captures the CURRENT task.state as pausedFromState. Judge-only:
   *  clears the transient #judgeRateLimitedUntil hold and hardcodes
   *  pausedFromState to "judge-evaluating" (matches the same hardcode used by
   *  the other judge give-up paths in #handleJudgeVerdict, so Continue always
   *  re-reads the verdict). */
  #pauseFromRateLimit(workspace: TaskWorkspaceState, role: "worker" | "judge", reason: string): void {
    const workspaceId = workspace.id;
    this.#clearRateLimitResumeTimer(workspaceId, role);
    this.#rateLimitCtx.delete(this.#rlKey(workspaceId, role));
    if (role === "worker") {
      this.#clearWorkLockOverrideTimer(workspaceId);
      this.#stopPeriodicWorkLockProbe(workspaceId);
      workspace.task.rateLimitedUntil = null;
      workspace.task.pausedFromState = workspace.task.state;
    } else {
      this.#judgeRateLimitedUntil.delete(workspaceId);
      workspace.task.pausedFromState = "judge-evaluating";
    }
    this.#setTaskState(workspace.task, "paused");
    const message =
      role === "worker"
        ? `Rate-limit handling gave up (${reason}) — task paused.`
        : `Judge rate-limit handling gave up (${reason}) — task paused.`;
    this.#raiseTaskAlert(workspace, "failed", message);
    this.#broadcastState!();
  }

  async #resumeFromRateLimit(workspaceId: string): Promise<void> {
    const workspace = this.#findTaskWorkspace(workspaceId);
    if (!workspace) return;
    const task = workspace.task;
    if (!task.rateLimitedUntil) return;
    const operation = this.#captureTaskOperation(workspace, "worker-rate-limit-resume", { round: true });

    const ctx = this.#rateLimitCtx.get(this.#rlKey(workspaceId, "worker"));
    task.rateLimitedUntil = null;
    this.#clearWorkLockOverrideTimer(workspaceId);
    this.#stopPeriodicWorkLockProbe(workspaceId);
    log.info("rate-limit window expired, resuming worker", {
      workspaceId,
      taskState: task.state,
      needsRestart: ctx?.needsRestart,
      retries: ctx?.retries,
    });
    void this.#logTaskEvent(workspace, "worker-rate-limit-resumed", "Rate-limit window expired. Resuming worker…");
    this.#broadcastState!();

    if (task.state !== "running") return;
    const sessionId = sessionIdFor(workspace, "worker");

    if (ctx?.needsRestart) {
      if (task.mode === "attached") {
        // Primary is an EXTERNALLY OWNED session (plan §8.6): a CLI-exit
        // rate-limit means the provider process likely already exited, but
        // the runner must never restart it just to move the task state
        // machine forward — that would destroy the user's live conversation.
        // Treat this exactly like a Primary dropout: pause with an
        // actionable "Open Primary" alert (mirrors #onAttachedAgentIdle's
        // dropout guard) and let the user restart the session themselves if
        // needed; Continue will reorient it from the task files.
        task.pausedFromState = "running";
        this.#setTaskState(task, "paused");
        this.#evaluating.delete(workspaceId);
        void this.#logTaskEvent(
          workspace,
          "primary-dropout",
          "Primary conversation appears to have exited (rate limit) — task paused.",
        );
        this.#raiseTaskAlert(
          workspace,
          "failed",
          "Primary conversation appears to have exited. Open Primary to check, then Continue.",
        );
        this.#broadcastState!();
        return;
      }
      // CLI-exit providers (Codex / Gemini / Copilot): respawn the worker
      // and let onAgentIdle re-inject the initial task prompt when the new
      // session settles.
      if (!this.#restartSession) {
        log.warn("cannot restart session: no restartSession dep", { workspaceId });
        return;
      }
      try {
        await this.#restartTaskSession(sessionId);
        const fresh = this.#currentTaskOperation(operation, new Set(["running"]));
        if (!fresh) return;
        fresh.task.promptSent = false;
        this.#broadcastState!();
      } catch (err) {
        if (!this.#currentTaskOperation(operation, new Set(["running"]))) return;
        log.error("failed to restart worker session after rate-limit", {
          workspaceId,
          err: (err as Error)?.message,
        });
      }
      return;
    }

    // Claude prompt-limit: session is alive, idle at the post-dialog prompt.
    // Send a `continue` resume message (matches autoclaude /
    // claude-auto-retry behaviour; one-shot — if Claude is still rate-limited
    // the detector re-fires and we reschedule).
    const resumePrompt = "continue where you left off. The previous attempt was rate limited.";
    try {
      const fresh = this.#currentTaskOperation(operation, new Set(["running"]));
      if (!fresh) return;
      await this.#injectPrompt(sessionId, resumePrompt, fresh);
    } catch (err) {
      if (!this.#currentTaskOperation(operation, new Set(["running"]))) return;
      log.error("failed to inject continue prompt after rate-limit", {
        workspaceId,
        err: (err as Error)?.message,
      });
    }
  }

  /** Clear the per-workspace retry counter once the worker makes progress. */
  /** Krok 9b — per-role key for #rateLimitCtx so the worker and judge accumulate
   *  retries independently while sharing one cap + hard-stop. */
  #rlKey(workspaceId: string, role: "worker" | "judge"): string {
    return `${role}:${workspaceId}`;
  }

  #clearRateLimitCtx(workspaceId: string): void {
    this.#rateLimitCtx.delete(this.#rlKey(workspaceId, "worker"));
  }

  /**
   * Krok 9c — detection-independent rate-limit backstop. A worker that ends its
   * turn in under ~2s right after each re-prompt is almost certainly hitting an
   * undetected rate limit ("Cogitated/Worked for 0s"); the loop keeps mashing
   * re-prompts blindly (incident C, worker side). We can't safely auto-pause on
   * a heuristic, but we surface a TASK_LOG warning after a run of short turns so
   * the pattern is visible in the audit even when string detection misses it.
   */
  #trackShortWorkerTurn(workspace: TaskWorkspaceState): void {
    const workspaceId = workspace.id;
    const injectAt = this.#workerInjectAt.get(workspaceId);
    if (injectAt && Date.now() - injectAt < AgentTaskRunner.SHORT_WORKER_TURN_MS) {
      const n = (this.#shortWorkerTurns.get(workspaceId) || 0) + 1;
      this.#shortWorkerTurns.set(workspaceId, n);
      // ">3 re-prompts" → warn once when the streak first exceeds the threshold.
      if (n === AgentTaskRunner.SHORT_WORKER_TURN_THRESHOLD + 1) {
        log.warn("worker short-turn streak — possible undetected rate limit", { workspaceId, streak: n });
        void this.#logTaskEvent(
          workspace,
          "worker-short-turns",
          `Worker ended ${n} consecutive turns in under ${AgentTaskRunner.SHORT_WORKER_TURN_MS}ms ("Cogitated/Worked for 0s") — possible undetected rate limit.`,
        );
      }
    } else {
      this.#shortWorkerTurns.delete(workspaceId);
    }
  }

  /**
   * Krok 9b — handle a rate limit hit on the JUDGE session.
   *
   *  - Press Enter on the Claude "/rate-limit-options" dialog so the turn ends
   *    instead of hanging forever (observed 2h+). This happens unconditionally,
   *    before the dedup/hard-stop/cap checks in #handleRateLimited run — unlike
   *    the worker path, where the Enter press only happens on the eventual
   *    normal-schedule branch. That's an intentional Krok 9b divergence (the
   *    judge dialog is the thing that was observed to hang for 2h+), preserved
   *    here rather than folded into the shared core.
   *  - If a verdict is already on disk, the limit is irrelevant — process it
   *    immediately (exactly incident C: verdict written, then limit hit).
   *  - Otherwise set a judge-specific hold (kept separate from the worker hold)
   *    and schedule a resume; reading the verdict stays blocked only while the
   *    verdict is MISSING (see #handleJudgeVerdict).
   */
  #handleJudgeRateLimited(
    workspace: TaskWorkspaceState,
    sessionId: string,
    match: RateLimitMatch,
    source: string,
  ): boolean {
    if (match.needsConfirm && this.#writeToSession) {
      this.#pressDialogEnter(workspace, sessionId);
    }
    return this.#handleRateLimited(workspace, sessionId, match, source, "judge");
  }

  /** Krok 9b/9c — judge hold expired: process a verdict if present, else nudge
   * the judge to continue its evaluation and write the verdict. */
  async #resumeJudgeFromRateLimit(workspaceId: string): Promise<void> {
    const workspace = this.#findTaskWorkspace(workspaceId);
    if (!workspace) return;
    const task = workspace.task;
    const operation = this.#captureTaskOperation(workspace, "judge-rate-limit-resume", {
      round: true,
      evaluationAttempt: task.mode === "attached",
    });
    this.#judgeRateLimitResumeOwners.set(workspaceId, operation.id);
    this.#judgeRateLimitedUntil.delete(workspaceId);
    void this.#logTaskEvent(workspace, "judge-rate-limit-resumed", "Judge rate-limit window expired.");
    this.#broadcastState!();
    if (task.state !== "judge-evaluating") return;

    const judgeSessionId = sessionIdFor(workspace, "judge");
    const resumePrompt = `Continue your evaluation — the previous attempt was rate-limited. When you reach a decision, write your verdict JSON to ${taskDirRel(
      task.taskId,
    )}/${VERDICT_FILE}.`;

    // Attached (Companion loop) tasks must never fall through to the legacy
    // verdict parser/#handleJudgeVerdict (plan §6/§8.4) — the legacy parser
    // accepts a companion "continue" verdict and rejects "needs-input" as
    // invalid, which would drive standard-path re-prompting into a session
    // that doesn't exist for attached tasks.
    if (task.mode === "attached") {
      const result = await readCompanionVerdict(
        workspace.cwd,
        task.taskId,
        this.#companionVerdictExpectation(task),
        log,
      );
      const fresh = this.#currentTaskOperation(operation, new Set(["judge-evaluating"]));
      if (!fresh) return;
      if (result.status === "valid") {
        // Verdict already on disk — process it regardless of the (now-expired) hold.
        await this.#handleCompanionVerdict(fresh, "judge-rate-limit-resume");
        return;
      }
      if (
        this.#judgeRateLimitResumeOwners.get(workspaceId) !== operation.id ||
        this.#judgeRateLimitedUntil.has(workspaceId)
      )
        return;
      await this.#injectPrompt(judgeSessionId, resumePrompt, fresh);
      return;
    }

    const verdict = await readVerdict(workspace.cwd, task.taskId, log);
    const fresh = this.#currentTaskOperation(operation, new Set(["judge-evaluating"]));
    if (!fresh) return;
    if (verdict.reason !== "Judge did not produce a verdict file.") {
      // Verdict already on disk — process it regardless of the (now-expired) hold.
      await this.#handleJudgeVerdict(fresh, "judge-rate-limit-resume");
      return;
    }
    if (
      this.#judgeRateLimitResumeOwners.get(workspaceId) !== operation.id ||
      this.#judgeRateLimitedUntil.has(workspaceId)
    )
      return;
    await this.#injectPrompt(judgeSessionId, resumePrompt, fresh);
  }

  // ---------------------------------------------------------------------------
  // Krok 8 — fs.watch backstop (NOT a replacement for hooks)
  // ---------------------------------------------------------------------------
  // Hooks stay the primary signal. This watcher only covers the case where a
  // hook never arrives (incident C: judge stuck → no Stop) or arrives in the
  // wrong state. It watches the FLAT taskDir non-recursively (recursive fs.watch
  // isn't supported on Linux), debounces the unreliable/duplicated events, and
  // ALWAYS re-verifies real disk state before acting. On a path where events
  // aren't delivered (network shares, \\wsl$), fs.watch errors out and we fall
  // back to a slow poll. Everything is unref()'d so it can't hold the process.

  static WATCH_VERDICT_GRACE_MS = 30_000;
  static WATCH_WORKLOCK_GRACE_MS = 120_000;
  static WATCH_POLL_INTERVAL_MS = 10_000;

  /** Krok 1 — how long to wait for a UserPromptSubmit confirmation before
   *  re-sending Enter, and how many times to re-send. Static so tests can
   *  override the timeout without waiting the full 8s × 3 in real time. */
  static SUBMIT_CONFIRM_TIMEOUT_MS = 8000;
  static MAX_RESUBMITS = 2;

  async #startTaskDirWatcher(workspace: TaskWorkspaceState): Promise<void> {
    const workspaceId = workspace.id;
    if (this.#taskDirWatchers.has(workspaceId)) return; // already watching
    const taskId = workspace.task.taskId;
    const cwd = workspace.cwd;
    const taskOperation = {
      ...this.#captureTaskOperation(workspace, "task-dir-watcher-start", {
        // Started on every move into an active state; a task that left the
        // active states while the dir was probed simply needs no watcher.
        expectedRefusal: { reason: "task-left-active-state", checks: TASK_ADVANCED_CHECKS },
      }),
      sessionEpochs: {},
    };
    const dir = taskDir(workspace.cwd, workspace.task.taskId);
    try {
      await access(dir);
    } catch {
      return; // task dir not initialized — hooks + resume reconcile cover it
    }
    const currentWorkspace = this.#currentTaskOperation(
      taskOperation,
      new Set(["running", "evaluating", "judge-evaluating", "refreshing", "capturing-context"]),
    );
    if (
      this.#disposed ||
      !currentWorkspace ||
      currentWorkspace.task.taskId !== taskId ||
      currentWorkspace.cwd !== cwd ||
      this.#taskDirWatchers.has(workspaceId)
    )
      return;

    let debounceTimer: NodeJS.Timeout | null = null;
    let graceTimer: NodeJS.Timeout | null = null;
    let watcher: FSWatcher | null = null;
    let pollTimer: NodeJS.Timeout | null = null;
    let closed = false;
    let watcherEntry: { close: () => void } | null = null;

    const isCurrent = (): boolean => {
      if (this.#disposed || closed || !watcherEntry || this.#taskDirWatchers.get(workspaceId) !== watcherEntry)
        return false;
      const current = this.#findTaskWorkspace(workspaceId);
      return current?.task.taskId === taskId && current.cwd === cwd;
    };

    const reconcile = () => {
      if (!isCurrent()) return;
      const current = this.#findTaskWorkspace(workspaceId);
      if (!current) return;
      const operation = this.#captureTaskOperation(current, "task-dir-watcher-reconcile", {
        round: true,
        evaluationAttempt: current.task.mode === "attached",
        // A backstop for a hook that never comes. When the hook does come, the
        // step it drives advances the task during the grace window, and this
        // operation is refused — the normal outcome. A session or binding
        // change still warns: then the backstop is gone too.
        expectedRefusal: { reason: "hook-handled-first", checks: TASK_ADVANCED_CHECKS },
      });
      void this.#reconcileFromWatcher(operation, armGrace, isCurrent);
    };

    const armGrace = (delayMs: number, fire: () => Promise<void>) => {
      if (!isCurrent()) return;
      if (graceTimer) return; // one grace window at a time
      graceTimer = setTimeout(() => {
        graceTimer = null;
        if (!isCurrent()) return;
        void fire().catch((err: unknown) =>
          log.debug("watcher grace fire failed", { workspaceId, err: (err as Error)?.message }),
        );
      }, delayMs);
      if (typeof graceTimer.unref === "function") graceTimer.unref();
    };

    const onChange = () => {
      if (closed) return;
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        reconcile();
      }, 500);
      if (typeof debounceTimer.unref === "function") debounceTimer.unref();
    };

    try {
      watcher = fsWatch(dir, { recursive: false }, () => onChange());
      if (typeof watcher.unref === "function") watcher.unref();
      watcher.on("error", (err: unknown) => {
        log.debug("task dir watcher error — falling back to poll", { workspaceId, err: (err as Error)?.message });
        try {
          watcher?.close();
        } catch {
          /* ignore */
        }
        watcher = null;
        if (!closed && !pollTimer) {
          pollTimer = setInterval(onChange, AgentTaskRunner.WATCH_POLL_INTERVAL_MS);
          if (typeof pollTimer.unref === "function") pollTimer.unref();
        }
      });
    } catch (err: unknown) {
      log.debug("fs.watch unavailable — polling task dir", { workspaceId, err: (err as Error)?.message });
      pollTimer = setInterval(onChange, AgentTaskRunner.WATCH_POLL_INTERVAL_MS);
      if (typeof pollTimer.unref === "function") pollTimer.unref();
    }

    watcherEntry = {
      close: () => {
        if (closed) return;
        closed = true;
        if (debounceTimer) clearTimeout(debounceTimer);
        if (graceTimer) clearTimeout(graceTimer);
        if (pollTimer) clearInterval(pollTimer);
        try {
          watcher?.close();
        } catch {
          /* ignore */
        }
      },
    };
    this.#taskDirWatchers.set(workspaceId, watcherEntry);
  }

  #stopTaskDirWatcher(workspaceId: string): void {
    const entry = this.#taskDirWatchers.get(workspaceId);
    if (!entry) return;
    entry.close();
    this.#taskDirWatchers.delete(workspaceId);
  }

  /**
   * Krok 8 — a watcher event fired. Re-verify disk and, if a hook-driven handler
   * should have run but didn't, arm a grace timer that fires the handler only if
   * the situation still holds after the grace (a hook may handle it first).
   */
  async #reconcileFromWatcher(
    operation: TaskOperationContext,
    armGrace: (delayMs: number, fire: () => Promise<void>) => void,
    isCurrentWatcher: () => boolean,
  ): Promise<void> {
    let workspace = this.#currentTaskOperation(operation);
    if (!workspace || !isCurrentWatcher()) return;
    const workspaceId = operation.workspaceId;
    let task = workspace.task;

    if (task.state === "judge-evaluating" && task.mode === "attached") {
      // Attached tasks use a completely different verdict schema/handler —
      // never let the standard verdictSchema/handleJudgeVerdict path near
      // them (it would misparse the companion verdict and, worse, could
      // send a "task ended" stop signal into the externally-owned Primary).
      const result = await readCompanionVerdict(
        workspace.cwd,
        task.taskId,
        this.#companionVerdictExpectation(task),
        log,
      );
      workspace = this.#currentTaskOperation(operation, new Set(["judge-evaluating"]));
      if (!workspace || !isCurrentWatcher()) return;
      task = workspace.task;
      if (result.status !== "valid") return;
      // Per-evaluation marker, not lastRound.judgeVerdict: the same round is
      // evaluated again after a needs-input answer or a withheld completion,
      // and the chip still carries the previous evaluation's verdict — reading
      // that as "already processed" stranded the task in judge-evaluating
      // forever whenever the idle hook was the one that went missing.
      if (this.#companionVerdictAlreadyHandled(task)) return;
      armGrace(AgentTaskRunner.WATCH_VERDICT_GRACE_MS, async () => {
        const ws = this.#currentTaskOperation(operation, new Set(["judge-evaluating"]));
        if (!ws || !isCurrentWatcher()) return;
        if (this.#companionVerdictAlreadyHandled(ws.task)) return; // a hook handled it during the grace
        log.warn("watcher backstop: companion verdict on disk but no idle hook — handling", { workspaceId });
        void this.#logTaskEvent(
          ws,
          "watcher-verdict",
          "Companion verdict detected by watcher (no idle hook) — handling it.",
        );
        await this.#handleCompanionVerdict(ws, "watcher");
      });
      return;
    }

    if (task.state === "judge-evaluating") {
      const verdict = await readVerdict(workspace.cwd, task.taskId, log);
      workspace = this.#currentTaskOperation(operation, new Set(["judge-evaluating"]));
      if (!workspace || !isCurrentWatcher()) return;
      task = workspace.task;
      if (verdict.reason === "Judge did not produce a verdict file.") return;
      const rounds = task.rounds as unknown as TaskRound[];
      const lastRound = rounds?.[rounds.length - 1];
      if (lastRound && lastRound.judgeVerdict) return; // already processed
      armGrace(AgentTaskRunner.WATCH_VERDICT_GRACE_MS, async () => {
        let ws = this.#currentTaskOperation(operation, new Set(["judge-evaluating"]));
        if (!ws || !isCurrentWatcher()) return;
        const r = ws.task.rounds as unknown as TaskRound[];
        const lr = r?.[r.length - 1];
        if (lr && lr.judgeVerdict) return; // a hook handled it during the grace
        const v = await readVerdict(ws.cwd, ws.task.taskId, log);
        ws = this.#currentTaskOperation(operation, new Set(["judge-evaluating"]));
        if (!ws || !isCurrentWatcher()) return;
        if (v.reason === "Judge did not produce a verdict file.") return;
        log.warn("watcher backstop: verdict on disk but no judge hook — handling", { workspaceId });
        void this.#logTaskEvent(ws, "watcher-verdict", "Verdict detected by watcher (no idle hook) — handling it.");
        await this.#handleJudgeVerdict(ws, "watcher");
      });
      return;
    }

    if (task.state === "capturing-context") {
      // Same backstop idea as the verdict branch above: a lost/missed idle
      // hook during capture must not permanently strand the task (plan
      // §8.3). Only arm the grace once the files are ACTUALLY complete —
      // never let the watcher fire a premature nudge for a still-in-progress
      // capture.
      const validation = await validateCaptureFiles(workspace.cwd, task.taskId, {
        sinceIso: task.captureStartedAt || null,
      });
      workspace = this.#currentTaskOperation(operation, new Set(["capturing-context"]));
      if (!workspace || !isCurrentWatcher()) return;
      if (!validation.ok) return;
      armGrace(AgentTaskRunner.WATCH_VERDICT_GRACE_MS, async () => {
        let ws = this.#currentTaskOperation(operation, new Set(["capturing-context"]));
        if (!ws || !isCurrentWatcher()) return;
        const revalidation = await validateCaptureFiles(ws.cwd, ws.task.taskId, {
          sinceIso: ws.task.captureStartedAt || null,
        });
        ws = this.#currentTaskOperation(operation, new Set(["capturing-context"]));
        if (!ws || !isCurrentWatcher()) return;
        if (!revalidation.ok) return; // a hook already handled it during the grace
        log.warn("watcher backstop: capture files complete but no idle hook — handling", { workspaceId });
        void this.#logTaskEvent(
          ws,
          "watcher-capture",
          "CONTEXT.md/HANDOFF.md complete detected by watcher (no idle hook) — handling it.",
        );
        await this.#checkCaptureReadiness(ws, sessionIdFor(ws, "worker"));
      });
      return;
    }

    if (task.state === "running" && task.mode === "attached") {
      // Attached Primary hooks are the app's normal terminal hooks — this is
      // just a backstop for a missed one, same idea as the standard branch
      // below but routed to the companion round gate, never built-in checks.
      if (!(await this.isWorkerCompleted(workspaceId))) return;
      workspace = this.#currentTaskOperation(operation, new Set(["running"]));
      if (!workspace || !isCurrentWatcher()) return;
      armGrace(AgentTaskRunner.WATCH_WORKLOCK_GRACE_MS, async () => {
        let ws = this.#currentTaskOperation(operation, new Set(["running"]));
        if (!ws || !isCurrentWatcher()) return;
        if (this.#evaluating.has(workspaceId)) return;
        if (!(await this.isWorkerCompleted(workspaceId))) return;
        ws = this.#currentTaskOperation(operation, new Set(["running"]));
        if (!ws || !isCurrentWatcher()) return;
        log.warn("watcher backstop: WORK_LOCK absent but no primary hook — evaluating", { workspaceId });
        void this.#logTaskEvent(ws, "watcher-worklock", "WORK_LOCK absent (watcher, no idle hook) — evaluating.");
        await this.#evaluateCompanionRound(ws);
      });
      return;
    }

    if (task.state === "running" && task.promptSent) {
      if (!(await this.isWorkerCompleted(workspaceId))) return;
      workspace = this.#currentTaskOperation(operation, new Set(["running"]));
      if (!workspace || !workspace.task.promptSent || !isCurrentWatcher()) return;
      armGrace(AgentTaskRunner.WATCH_WORKLOCK_GRACE_MS, async () => {
        let ws = this.#currentTaskOperation(operation, new Set(["running"]));
        if (!ws || !isCurrentWatcher() || !ws.task.promptSent) return;
        if (this.#evaluating.has(workspaceId)) return; // a hook started eval already
        if (!(await this.isWorkerCompleted(workspaceId))) return; // lock came back
        ws = this.#currentTaskOperation(operation, new Set(["running"]));
        if (!ws || !isCurrentWatcher() || !ws.task.promptSent) return;
        log.warn("watcher backstop: WORK_LOCK absent but no worker hook — evaluating", { workspaceId });
        void this.#logTaskEvent(ws, "watcher-worklock", "WORK_LOCK absent (watcher, no idle hook) — evaluating.");
        await this.#evaluateWorker(ws);
      });
    }
  }

  /**
   * Whether the worker has signaled completion. WORK_LOCK is the single
   * authoritative bit: the worker is instructed to delete it ONLY when the
   * task is genuinely done. Used by the runtime confirmation timer to skip
   * setting a rate-limit hold when the silence is actually "task finished",
   * and by the in-runner override check that recovers from a hold that was
   * set on a false-positive match. File-system based — no in-memory cache,
   * since the worker writes to disk asynchronously and we want the live state.
   *
   * Requires the task dir itself to exist before we trust the WORK_LOCK
   * absence as a "done" signal. Otherwise a workspace whose cwd has never
   * been initialized (or a unit test pointing at a fake path) would always
   * look "completed" because the dir doesn't exist either.
   */
  async isWorkerCompleted(workspaceId: string): Promise<boolean> {
    const workspace = this.#findTaskWorkspace(workspaceId);
    if (!workspace) return false;
    const task = workspace.task;
    if (!task?.taskId) return false;
    const dir = taskDir(workspace.cwd, task.taskId);
    try {
      await access(dir);
    } catch {
      return false; // task dir missing => can't decide => stay safe
    }
    try {
      await access(path.join(dir, WORK_LOCK_FILE));
      return false; // lock present => worker still has work
    } catch {
      return true; // ENOENT => worker signaled done
    }
  }

  /**
   * Recreate WORK_LOCK before re-prompting the worker for another round.
   *
   * The protocol is: WORK_LOCK present == work remains; worker deletes it ONLY
   * when verification passes. Because the worker removed the file at the end of
   * the previous round, the runtime must put it back before the next round
   * starts — otherwise the worker reads an absent lock at round 2 start and
   * concludes the task is already done. Runtime-owned (not worker-owned) so the
   * "WORK_LOCK absent" check stays a meaningful completion signal.
   */
  // Ensures task.useWorkerFile reflects what's on disk. Probes once per task
  // lifetime — once we know the format we cache it on the task object so
  // subsequent prompt builds in the same round trip skip the fs.access.
  async #ensureFormatFlag(task: TaskState, workspace: TaskWorkspaceState): Promise<boolean> {
    if (task.useWorkerFile !== undefined) return task.useWorkerFile;
    return taskHasWorkerFile(workspace.cwd, task.taskId);
  }

  async #recreateWorkLock(workspace: TaskWorkspaceState, context: string): Promise<boolean> {
    try {
      const dir = taskDir(workspace.cwd, workspace.task.taskId);
      await writeFile(
        path.join(dir, WORK_LOCK_FILE),
        "Work remains. Remove this file only when the task is complete and all verification steps pass.\n",
        "utf8",
      );
      log.debug("WORK_LOCK recreated", { workspaceId: workspace.id, context });
      return true;
    } catch (err: unknown) {
      log.warn("failed to recreate WORK_LOCK", {
        workspaceId: workspace.id,
        context,
        err: (err as Error)?.message,
      });
      return false;
    }
  }

  #clearWorkLockOverrideTimer(workspaceId: string): void {
    const timer = this.#workLockOverrideTimers.get(workspaceId);
    if (!timer) return;
    clearTimeout(timer);
    this.#workLockOverrideTimers.delete(workspaceId);
  }

  // Frequency of the periodic WORK_LOCK probe while a hold is active. Set
  // generously — there's no need to react quickly here; a real rate-limit
  // window is hours, and a false-positive hold just means the user waits up
  // to one probe cycle before the judge starts. 5 min is the sweet spot:
  // far enough apart that fs.access calls don't show up in load, close
  // enough that a finished worker is unblocked within a coffee break.
  static PERIODIC_WORK_LOCK_PROBE_MS = 5 * 60_000;

  /**
   * Periodically poll WORK_LOCK for a workspace under a rate-limit hold so a
   * false-positive that survived all earlier checks doesn't permanently block
   * the judge. The single-shot override fired by onAgentIdle handles the
   * common case (worker hits idle, hook lands, override runs). The periodic
   * probe handles the long tail where no idle hook arrives between
   * "rate-limit confirmed" and "worker actually finished".
   *
   * Self-cancels on every tick when the hold has cleared or the task has
   * moved out of "running", so manual cleanup is only needed when the
   * lifecycle path doesn't trigger another probe tick first.
   */
  #startPeriodicWorkLockProbe(workspaceId: string): void {
    this.#stopPeriodicWorkLockProbe(workspaceId);
    const interval = setInterval(() => {
      const ws = this.#findTaskWorkspace(workspaceId);
      if (!ws || !ws.task.rateLimitedUntil || ws.task.state !== "running") {
        this.#stopPeriodicWorkLockProbe(workspaceId);
        return;
      }
      void this.#performWorkLockOverrideCheck(workspaceId, sessionIdFor(ws, "worker"));
    }, AgentTaskRunner.PERIODIC_WORK_LOCK_PROBE_MS);
    if (typeof interval.unref === "function") interval.unref();
    this.#periodicWorkLockProbeTimers.set(workspaceId, interval);
  }

  #stopPeriodicWorkLockProbe(workspaceId: string): void {
    const t = this.#periodicWorkLockProbeTimers.get(workspaceId);
    if (!t) return;
    clearInterval(t);
    this.#periodicWorkLockProbeTimers.delete(workspaceId);
  }

  /**
   * Schedule a deferred WORK_LOCK check that, if the worker has signalled
   * completion, overrides the rate-limit hold and runs evaluation. The
   * 2 s delay both lets imminent state changes settle (resume timer firing,
   * user pause, etc.) and keeps tests stable — they assert sync state and
   * never wait long enough for the timer to fire.
   */
  #scheduleWorkLockOverrideCheck(workspaceId: string, sessionId: string): void {
    if (this.#workLockOverrideTimers.has(workspaceId)) return;
    const timer = setTimeout(() => {
      void this.#performWorkLockOverrideCheck(workspaceId, sessionId);
    }, 2000);
    if (typeof timer.unref === "function") timer.unref();
    this.#workLockOverrideTimers.set(workspaceId, timer);
  }

  async #performWorkLockOverrideCheck(workspaceId: string, sessionId: string): Promise<void> {
    this.#workLockOverrideTimers.delete(workspaceId);
    const workspace = this.#findTaskWorkspace(workspaceId);
    if (!workspace) return;
    const task = workspace.task;
    if (sessionId !== sessionIdFor(workspace, "worker")) return;
    const operation = this.#captureTaskOperation(workspace, "work-lock-rate-limit-override", { round: true });
    // All of these must still hold for the override to be the right action;
    // otherwise the hold either already cleared, the task moved to a state
    // where evaluation isn't appropriate (paused/completed/failed), or the
    // worker is genuinely still working and will keep the lock around.
    if (!task.rateLimitedUntil) return;
    if (task.state !== "running") return;
    if (!(await this.isWorkerCompleted(workspaceId))) return;
    const fresh = this.#currentTaskOperation(operation, new Set(["running"]));
    if (!fresh || !fresh.task.rateLimitedUntil) return;

    log.warn("rate-limit override: WORK_LOCK absent — worker signaled completion", {
      workspaceId,
      sessionId,
    });
    fresh.task.rateLimitedUntil = null;
    this.#clearRateLimitResumeTimer(workspaceId, "worker");
    this.#rateLimitCtx.delete(this.#rlKey(workspaceId, "worker"));
    this.#stopPeriodicWorkLockProbe(workspaceId);
    void this.#logTaskEvent(
      fresh,
      "worker-rate-limit-overridden",
      "WORK_LOCK absent — worker signaled completion. Clearing rate-limit hold and starting evaluation.",
    );
    this.#broadcastState!();

    try {
      if (!this.#currentTaskOperation(operation, new Set(["running"]))) return;
      await this.#evaluateWorker(fresh);
    } catch (err: unknown) {
      if (!this.#currentTaskOperation(operation)) return;
      log.error("evaluateWorker error during rate-limit override", {
        workspaceId,
        err: (err as Error)?.message,
      });
    }
  }

  /**
   * Called when a session exits — if it's a worker session, pause the task.
   */
  onSessionExit(sessionId: string, intentional = false): void {
    const managedRestart = (this.#managedSessionRestarts.get(sessionId) || 0) > 0;
    if (intentional && managedRestart) {
      this.#cancelSessionInjection(sessionId, "managed-session-restart");
      log.debug("managed task restart exited its previous session generation", { sessionId });
      return;
    }
    this.cancelPendingInput(sessionId, "session-exit");
    if (managedRestart) {
      this.#sessionIncarnations.set(sessionId, (this.#sessionIncarnations.get(sessionId) || 0) + 1);
    }
    const binding = this.#resolveTaskBinding(sessionId);
    if (!binding) return;
    const { workspace, task, role } = binding;
    const workspaceId = workspace.id;

    log.trace("onSessionExit: task session exited", { sessionId, role, taskState: task.state });

    // Note: this fires only when the whole PTY (the shell hosting the agent)
    // dies. The common dropout — the agent CLI exits back to a still-alive
    // shell after a forced update — produces NO process exit and is handled by
    // the shell-prompt guard in onAgentIdle (#handleAgentDropout) instead.
    const ACTIVE = new Set(["running", "evaluating", "judge-evaluating", "refreshing", "capturing-context"]);
    if (role === "worker" && ACTIVE.has(task.state)) {
      // Worker crash → resume to running (re-inject). Krok 3's resume reconcile
      // still processes any verdict left on disk regardless of this value.
      const isAttached = task.mode === "attached";
      task.pausedFromState = "";
      this.#setTaskState(task, "paused");
      this.#evaluating.delete(workspaceId);
      log.warn("worker session exited, task paused", { workspaceId, sessionId, isAttached });
      void this.#logTaskEvent(
        workspace,
        "worker-crashed",
        isAttached
          ? "Primary session exited unexpectedly, task paused"
          : "Worker session exited unexpectedly, task paused",
      );
      this.#raiseTaskAlert(
        workspace,
        "failed",
        isAttached
          ? "Primary conversation exited — task paused. Open Primary to check."
          : "Worker session exited — task paused",
      );
      this.#broadcastState!();
    }
  }

  /**
   * An agent (worker or judge) dropped out of agent mode mid-task: it exited
   * back to the shell (forced auto-update / crash / stray `exit`) while its PTY
   * stayed alive, so there's no process exit — only the shell prompt reappears.
   * Detected by the shell-prompt guard in onAgentIdle.
   * Restart the session and re-inject the last instruction, capped at
   * MAX_DROPOUT_RESTARTS consecutive attempts; over the cap, pause + alert so a
   * CLI stuck in a forced-update loop can't spin forever. The counter resets
   * when the agent next accepts a prompt (onUserPromptSubmit).
   *
   * Re-injection reuses the shower/recovery "inject on next idle" path: the last
   * instruction is stashed in showerResumePrompt and onAgentIdle injects it once
   * the freshly-spawned agent settles (mirrors #resumeFromRateLimit's restart).
   */
  async #handleAgentDropout(workspace: TaskWorkspaceState, sessionId: string, role: "worker" | "judge"): Promise<void> {
    const workspaceId = workspace.id;
    const expectedState = role === "worker" ? "running" : "judge-evaluating";
    const operation = this.#captureTaskOperation(workspace, `${role}-agent-dropout`, { round: true });
    const currentWorkspace = this.#currentTaskOperation(operation, new Set([expectedState]));
    if (!currentWorkspace || sessionId !== sessionIdFor(currentWorkspace, role)) return;
    workspace = currentWorkspace;
    const task = workspace.task;
    const attempt = (this.#dropoutCtx.get(sessionId) ?? 0) + 1;
    this.#dropoutCtx.set(sessionId, attempt);

    log.warn("agent dropped out of agent mode", { workspaceId, sessionId, role, attempt });
    void this.#logTaskEvent(
      workspace,
      "agent-dropout",
      `${role[0].toUpperCase()}${role.slice(1)} CLI dropped back to the shell (forced update / crash). Restart attempt ${attempt}/${AgentTaskRunner.MAX_DROPOUT_RESTARTS}.`,
    );

    if (attempt > AgentTaskRunner.MAX_DROPOUT_RESTARTS) {
      this.#dropoutCtx.delete(sessionId);
      task.pausedFromState = task.state;
      this.#setTaskState(task, "paused");
      this.#evaluating.delete(workspaceId);
      this.#raiseTaskAlert(
        workspace,
        "failed",
        `${role} CLI kept dropping out of agent mode (${AgentTaskRunner.MAX_DROPOUT_RESTARTS}× ) — task paused. Fix the CLI, then Continue or use Resend.`,
      );
      this.#broadcastState!();
      return;
    }

    if (!this.#restartSession) {
      log.warn("cannot restart dropped-out agent: no restartSession dep", { workspaceId, role });
      return;
    }

    // Stash the last instruction so onAgentIdle re-injects it when the new
    // session settles. Worker: promptSent=false routes the worker idle branch
    // back through injection. Judge: the judge idle branch injects
    // showerResumePrompt before reading the verdict.
    const last = this.#lastInjected.get(sessionId) ?? "";
    task.showerResumePrompt = last;
    if (role === "worker") task.promptSent = false;
    this.#broadcastState!();

    try {
      await this.#restartTaskSession(sessionId);
    } catch (err) {
      if (!this.#currentTaskOperation(operation, new Set([expectedState]))) return;
      log.error("failed to restart dropped-out agent", { workspaceId, sessionId, role, err: (err as Error)?.message });
    }
  }

  /**
   * Superset hook-event entry point — dispatcher (notifications/dispatcher.js)
   * calls this FIRST for every hook event. Task runner has first dibs:
   *
   *   Returns true  → consumed, dispatcher SHALL NOT raise a user alert
   *   Returns false → not a task session (or not actionable) — fall through
   *                   to the normal user notification pipeline
   *
   * Delegates to onAgentIdle / onSubagentStop / onUserPromptSubmit based on
   * the hook name.  Unknown hooks are passed through (returns false).
   */
  onHookEvent({ sessionId, hook, subtype }: { sessionId?: string; hook?: string; subtype?: string }): boolean {
    if (!sessionId || !hook) return false;

    switch (hook) {
      case "Notification":
        // Recorded before the attached-judge branch below can consume it: an
        // open dialog must block the runner from pressing Enter for the user.
        // A dialog is not consumed (onAgentIdle returns false for it): the
        // user's own alert has to go out for it.
        this.#noteAgentSignal(sessionId, subtype ? `hook:${subtype}` : "hook:notification");
        if (subtype === "permission_prompt" && this.#handleJudgePermissionPrompt(sessionId)) return true;
        return this.onAgentIdle(sessionId, subtype ? `hook:${subtype}` : "hook:notification");
      case "Stop":
        // Treat assistant-turn end as an idle signal. Task runner checks
        // state/panel and either proceeds with verification or returns false.
        return this.onAgentIdle(sessionId, "hook:stop");
      case "SubagentStop":
        return this.onSubagentStop(sessionId);
      case "UserPromptSubmit":
        return this.onUserPromptSubmit(sessionId);
      default:
        return false;
    }
  }

  /**
   * A permission prompt can only reach the Companion when the user chose NOT to
   * bypass prompts for it in the companion dialog. Nothing can answer that
   * prompt on the loop's behalf, so the evaluation would sit there forever —
   * pause and say so instead of nudging, retrying, or waiting silently. With
   * the bypass enabled (the default for most providers) this never fires.
   */
  #handleJudgePermissionPrompt(sessionId: string): boolean {
    const binding = this.#resolveTaskBinding(sessionId);
    if (!binding || binding.role !== "judge") return false;
    const { workspace, task } = binding;
    if (task.mode !== "attached" || task.state !== "judge-evaluating") return false;

    task.pausedFromState = task.state;
    task.judgePolicyViolation = true;
    this.#setTaskState(task, "paused");
    this.#evaluating.delete(workspace.id);
    const roleLabel = COMPANION_ROLE_DISPLAY_NAMES[task.companionRole as CompanionRole];
    log.warn("attached judge hit a permission prompt during evaluation — paused, nothing can answer it", {
      workspaceId: workspace.id,
      sessionId,
      companionRole: task.companionRole,
    });
    void this.#logTaskEvent(
      workspace,
      "judge-permission-prompt",
      `${roleLabel} is waiting on a permission prompt during evaluation — paused.`,
    );
    this.#raiseTaskAlert(
      workspace,
      "failed",
      `${roleLabel} paused on a permission prompt. Answer it in its panel, then Continue — or recreate the loop with permission prompts bypassed.`,
    );
    this.#broadcastState!();
    return true;
  }

  /**
   * Sub-agent finished — log for the task audit trail. Task runner does
   * not act on this (sub-agent outputs are already aggregated by the parent).
   * Returns true for task workspaces so the dispatcher skips the user alert
   * (SubagentStop is classified system-only anyway, but this keeps the
   * task-workspace branch explicit).
   */
  onSubagentStop(sessionId: string): boolean {
    const parts = sessionId.split(":");
    if (parts.length < 2) return false;
    const workspaceId = parts.slice(0, -1).join(":");
    const workspace = this.#findTaskWorkspace(workspaceId);
    if (!workspace) return false;

    log.trace("onSubagentStop: task session sub-agent stopped", { sessionId });
    void this.#logTaskEvent(workspace, "subagent-stop", "A sub-agent finished");
    return true;
  }

  /**
   * User submitted a new prompt — cancel any pending judge-reprompt work
   * (user is steering the conversation themselves).  Returns true for task
   * workspaces so the dispatcher skips the user alert (UserPromptSubmit is
   * classified system-only; this is belt-and-braces).
   */
  onUserPromptSubmit(sessionId: string): boolean {
    const binding = this.#resolveTaskBinding(sessionId);
    if (!binding) return false;
    const { workspace } = binding;

    log.trace("onUserPromptSubmit: user sent prompt in task workspace", { sessionId });
    // A new turn starts. With no runner write waiting for this confirmation it
    // is the user's own message (submitted in some way the input fold did not
    // recognise as Enter): the composer is empty and the agent answers them.
    const activity = this.#activityFor(sessionId);
    const runnerWaiting = (this.#submitWaiters.get(sessionId)?.length ?? 0) > 0;
    activity.turnActive = true;
    activity.turnStartedAt = Date.now();
    activity.lastPromptSubmitAt = activity.turnStartedAt;
    activity.uiState = "prompt";
    activity.sawPromptSubmit = true;
    const providerKey = this.#promptSubmitProviderKey(sessionId);
    if (providerKey) this.#promptSubmitProviders.add(providerKey);
    if (!runnerWaiting) {
      activity.userTurn = true;
      activity.pending = false;
    }
    // Krok 1 — this hook also fires for prompts WE inject, so it doubles as the
    // submit-confirmation signal: release any waiter parked by #injectPrompt.
    this.#resolveSubmitWaiters(sessionId);
    // If task is paused and user is taking over, leave it paused — don't
    // resume automatically.  The user can click Continue when ready.
    void this.#logTaskEvent(workspace, "user-prompt-submit", "User submitted a prompt");
    return true;
  }

  /**
   * Called from runtime's terminal-input path when the user types or pastes
   * into a task panel (`data` is what they sent; passive terminal reports are
   * filtered out before this).
   *
   * Typing never pauses or stalls a task: it does not touch the task state, the
   * session's incarnation, or any operation in flight. It only records the
   * user's activity, which makes the runner's next write into this session
   * wait politely (see #awaitPoliteWindow) and withholds the Enter of a write
   * that is going in at this very moment.
   */
  onUserInput(sessionId: string, data?: string | Buffer): void {
    if (!this.#resolveTaskBinding(sessionId)) return;
    this.#recordUserInput(sessionId, data);
  }

  // ---------------------------------------------------------------------------
  // State management — timing-aware
  // ---------------------------------------------------------------------------

  /**
   * Set task state with automatic timing tracking.
   * Tracks startedAt, pausedAt, totalPausedMs, finishedAt across all transitions.
   */
  #setTaskState(task: RuntimeTaskState, newState: TaskStateKind): void {
    // "capturing-context" is attached-only and counts as active for elapsed
    // timing (plan §6.1); "brief-ready"/"awaiting-user" deliberately do not.
    const ACTIVE = new Set(["running", "evaluating", "judge-evaluating", "refreshing", "capturing-context"]);
    const prev = task.state;
    if (prev !== newState && (newState === "paused" || newState === "completed" || newState === "failed")) {
      const workspaceId = this.#workspaceIdForTask(task);
      if (workspaceId) this.#advanceTaskLifecycle(workspaceId, `state:${newState}`);
    }
    if (!ACTIVE.has(newState)) {
      const workspace = this.#findTaskWorkspace(this.#workspaceIdForTask(task) ?? "");
      if (workspace) this.#cancelTaskInjections(workspace);
    }
    const now = Date.now();

    // Fresh start from idle
    if (prev === "idle" && ACTIVE.has(newState)) {
      task.startedAt = now as unknown as string;
      task.totalPausedMs = 0;
      task.pausedAt = null;
      task.finishedAt = null;
    }

    // Active → non-active (paused/completed/failed): record pause start
    if (ACTIVE.has(prev) && !ACTIVE.has(newState) && newState !== "idle") {
      task.pausedAt = now as unknown as string;
      if (newState === "completed" || newState === "failed") {
        task.finishedAt = now as unknown as string;
      }
    }

    // Non-active → active (resume): accumulate paused time
    if (!ACTIVE.has(prev) && prev !== "idle" && ACTIVE.has(newState) && task.pausedAt) {
      task.totalPausedMs = (task.totalPausedMs || 0) + (now - (task.pausedAt as unknown as number));
      task.pausedAt = null;
      task.finishedAt = null;
    }

    // Reset to idle: clear timing
    if (newState === "idle") {
      task.startedAt = null;
      task.totalPausedMs = 0;
      task.pausedAt = null;
      task.finishedAt = null;
    }

    task.state = newState;

    // Krok 8 — keep the fs.watch backstop armed only while the task is active.
    const wsId = this.#workspaceIdForTask(task);
    if (wsId) {
      if (ACTIVE.has(newState)) {
        const ws = this.#findTaskWorkspace(wsId);
        if (ws) void this.#startTaskDirWatcher(ws);
      } else {
        this.#stopTaskDirWatcher(wsId);
      }
    }

    // Persist immediately on lifecycle transitions so a hard kill (Force-quit,
    // power loss) doesn't leave the on-disk state stale. Without this, the
    // crash-recovery sweep on next startup wouldn't see the task as ACTIVE
    // because the in-memory "running" flag never reached disk.
    this.#saveState?.();
  }

  /** Resolve the workspaceId owning a given task object (reference equality). */
  #workspaceIdForTask(task: RuntimeTaskState): string | null {
    const state = this.#getState?.();
    const ws = state?.workspaces.find((w) => isTaskWorkspace(w) && w.task === task);
    return ws?.id ?? null;
  }

  /**
   * Ensure a "running" round chip exists for the current worker iteration.
   * Idempotent: if the last round is already "running", returns it; otherwise
   * pushes a fresh round {round: currentRound, action: "running"}. A "round"
   * is one full worker → checks → judge cycle; it only advances when the
   * judge sends the worker back (or the user rejects the verdict). Check
   * failures re-prompt within the same round, so no new chip is pushed.
   */
  #ensureRunningRound(task: RuntimeTaskState): TaskRound {
    const rounds = task.rounds as unknown as TaskRound[];
    const last = rounds?.[rounds.length - 1];
    if (last && last.action === "running") return last;
    const targetRound = task.currentRound || 1;
    // Krok 12 — after a judge-requested → pause → resume sequence the runner
    // can re-enter this for the SAME round number; pushing a fresh chip then
    // renders as a duplicate (ROUNDS "1 1"). Reactivate the existing chip
    // instead. currentRound is always incremented BEFORE ensureRunningRound on
    // a genuine new round, so a real round advance still pushes a new chip.
    if (last && last.round === targetRound) {
      last.action = "running";
      return last;
    }
    const round: TaskRound = {
      round: targetRound,
      startedAt: new Date().toISOString(),
      checks: [],
      judgeVerdict: null,
      judgeReason: "",
      action: "running",
    };
    if (!Array.isArray(task.rounds)) task.rounds = [];
    (task.rounds as unknown as TaskRound[]).push(round);
    return round;
  }

  // ---------------------------------------------------------------------------
  // State queries
  // ---------------------------------------------------------------------------

  getTaskState(workspaceId: string): RuntimeTaskState | null {
    const workspace = this.#findTaskWorkspace(workspaceId);
    return workspace?.task || null;
  }

  /**
   * The roles whose terminal is sitting on a dialog (typically the agent's
   * directory-trust prompt) that only the user can answer. Read from the
   * runner's own per-session screen state, never from terminal text.
   */
  getAwaitingUserRoles(workspaceId: string): Array<"worker" | "judge"> {
    const workspace = this.#findTaskWorkspace(workspaceId);
    if (!workspace || workspace.task.mode === "attached") return [];
    const roles: Array<"worker" | "judge"> = [];
    for (const role of ["worker", "judge"] as const) {
      if (this.#sessionActivity.get(sessionIdFor(workspace, role))?.uiState === "dialog") roles.push(role);
    }
    return roles;
  }

  /**
   * Return the idle timeout (ms) for a given task session, based on the
   * provider configured for that panel (worker or judge).
   */
  getIdleTimeout(sessionId: string): number | null {
    const binding = this.#resolveTaskBinding(sessionId);
    if (!binding) return null;
    const { task, role } = binding;
    // Attached tasks never set workerProviderConfig (the Primary's provider
    // is not ours to manage) — this correctly falls back to null, letting
    // the caller use its generic default idle detection for that session.
    const config = role === "worker" ? task.workerProviderConfig : task.judgeProviderConfig;
    if (!config?.providerId) return null;
    try {
      return getProvider(config.providerId).idleTimeoutMs;
    } catch {
      return null;
    }
  }

  /**
   * Returns serializable snapshot of all task workspaces for payload broadcast.
   */
  getTaskSnapshot(): Record<string, unknown> {
    const state = this.#getState?.();
    const result: Record<string, unknown> = {};
    if (!state) return result;
    for (const workspace of state.workspaces) {
      if (!isTaskWorkspace(workspace)) continue;
      const task = workspace.task;
      result[workspace.id] = {
        taskId: task.taskId,
        description: task.description,
        state: task.state,
        currentRound: task.currentRound,
        maxRounds: task.maxRounds,
        showerInterval: task.showerInterval,
        workerPanelId: task.workerPanelId,
        judgePanelId: task.judgePanelId,
        rounds: task.rounds,
        lastShowerRound: task.lastShowerRound || 0,
        workerProviderConfig: task.workerProviderConfig || null,
        judgeProviderConfig: task.judgeProviderConfig || null,
        judgeExecutionMode: shouldUseProgrammaticCopilotJudge(task.judgeProviderConfig)
          ? "headless-copilot"
          : "interactive",
        judgeProgrammaticRunning: this.#programmaticJudges.has(workspace.id),
        startedAt: task.startedAt || null,
        totalPausedMs: task.totalPausedMs || 0,
        pausedAt: task.pausedAt || null,
        finishedAt: task.finishedAt || null,
        // Attached mode (Companion loop) — undefined/"standard" for every
        // pre-existing task, so this is purely additive for the renderer.
        mode: task.mode || "standard",
        workerWorkspaceId: task.workerWorkspaceId || "",
        companionRole: task.companionRole || null,
        companionFocus: task.companionFocus || "",
        contextApprovedAt: task.contextApprovedAt || null,
        companionPhase: task.companionPhase || null,
        pendingQuestions: task.pendingQuestions || [],
        lastCompanionVerdict: task.lastCompanionVerdict || null,
      };
    }
    return result;
  }

  // ---------------------------------------------------------------------------
  // Worker evaluation
  // ---------------------------------------------------------------------------

  async #evaluateWorker(initialWorkspace: TaskWorkspaceState): Promise<void> {
    const workspace = this.#findTaskWorkspace(initialWorkspace.id);
    if (!workspace || workspace.task.taskId !== initialWorkspace.task.taskId) return;
    const task = workspace.task;
    const workspaceId = workspace.id;

    // Attached (Companion loop) tasks never run project checks or the legacy
    // judge — route to the attached round gate instead (plan §6.2/§8.4). This
    // guard is the single dispatch point for every call site, including the
    // periodic WORK_LOCK probe (#performWorkLockOverrideCheck), which fires on
    // its own timer and isn't gated by onAgentIdle's earlier attached dispatch.
    if (task.mode === "attached") {
      await this.#evaluateCompanionRound(workspace);
      return;
    }

    // Re-entrance guard
    if (this.#evaluating.has(workspaceId)) {
      log.debug("evaluation already in progress", { workspaceId });
      return;
    }

    // Reaching evaluation means the worker produced output — the rate-limit
    // cycle (if any) is over. Clear the retry counter so the next limit hit
    // starts fresh, not accumulating retries from earlier rounds.
    this.#clearRateLimitCtx(workspaceId);

    const generation = this.#beginStandardEvaluation(workspaceId);
    const operation = this.#captureTaskOperation(workspace, "standard-worker-evaluation", { round: true });

    // Effect.acquireRelease ensures #evaluating is always cleared even on
    // unexpected errors — replaces the manual try/finally pattern.
    await runEffect(
      Effect.scoped(
        Effect.acquireRelease(
          Effect.sync(() => {
            if (
              !this.#currentTaskOperation(operation) ||
              this.#standardTaskRunGeneration.get(workspaceId) !== generation ||
              this.#evaluating.has(workspaceId)
            )
              return null;
            this.#evaluating.add(workspaceId);
            this.#evaluationOwners.set(workspaceId, operation.id);
            return operation.id;
          }),
          (owner) =>
            Effect.sync(() => {
              if (owner !== null && this.#evaluationOwners.get(workspaceId) === owner) {
                this.#evaluationOwners.delete(workspaceId);
                this.#evaluating.delete(workspaceId);
                this.#programmaticJudges.delete(workspaceId);
              }
            }),
        ).pipe(
          Effect.flatMap((owner) =>
            owner === null
              ? Effect.succeed(undefined)
              : Effect.promise(() => this.#evaluateWorkerBody(workspace, generation, operation)),
          ),
        ),
      ),
    ).catch((err: unknown) => {
      log.error("evaluateWorker failed", { workspaceId, err: (err as Error)?.message });
      // Krok 4 — capture the state we fell from (evaluating/judge-evaluating) so
      // a later Continue resumes to the right place.
      const current = this.#getCurrentStandardTask(
        workspaceId,
        operation.taskId,
        operation.round ?? 0,
        generation,
        new Set(["evaluating", "judge-evaluating"]),
        operation,
      );
      if (!current) return;
      current.task.pausedFromState = current.task.state;
      this.#setTaskState(current.task, "paused");
      void this.#logTaskEvent(
        current,
        "evaluation-error",
        `Evaluation failed: ${(err as Error)?.message || "unknown"}`,
      );
      this.#broadcastState!();
    });
  }

  async #evaluateWorkerBody(
    initialWorkspace: TaskWorkspaceState,
    generation: number,
    operation: TaskOperationContext,
  ): Promise<void> {
    let workspace = initialWorkspace;
    let task = workspace.task;
    const workspaceId = workspace.id;
    const taskId = task.taskId;
    const runRound = task.currentRound;
    const roundNumber = runRound || 1;
    let round: TaskRound;
    const refresh = (states: ReadonlySet<string>): boolean => {
      const fresh = this.#getCurrentStandardTask(workspaceId, taskId, runRound, generation, states, operation);
      if (!fresh) return false;
      const freshRound = [...(fresh.task.rounds as unknown as TaskRound[])]
        .reverse()
        .find((candidate) => candidate.round === roundNumber);
      if (!freshRound) return false;
      workspace = fresh;
      task = fresh.task;
      round = freshRound;
      return true;
    };

    const evalStart = Date.now();
    const initial = this.#getCurrentStandardTask(
      workspaceId,
      taskId,
      runRound,
      generation,
      new Set([task.state]),
      operation,
    );
    if (!initial) return;
    workspace = initial;
    task = initial.task;
    this.#setTaskState(task, "evaluating");
    this.#broadcastState!();

    // A "running" round was pushed when the worker iteration began (by
    // startTask / onAgentIdle first inject / re-prompt / shower). Reuse it
    // so the chip's identity doesn't change between "currently working" and
    // "being evaluated" — only the action label updates.
    round = this.#ensureRunningRound(task);
    round.action = "evaluating";
    round.checks = [];
    round.judgeVerdict = null;
    round.judgeReason = "";

    // Built-in checks: WORK_LOCK + TODO.md sections (always run, cheap)
    const builtInChecks = await runBuiltInChecks(workspace.cwd, task.taskId, { execCommand, log });
    if (!refresh(new Set(["evaluating"]))) return;
    round.action = "evaluating";
    round.checks = [];
    round.judgeVerdict = null;
    round.judgeReason = "";
    round.checks.push(...(builtInChecks as CheckResult[]));
    this.#broadcastState!(); // Stream built-in results to UI
    for (const c of builtInChecks) {
      log.debug("built-in check", { workspaceId, check: c.label, passed: c.passed });
    }

    // Bail out if user paused/reset during built-in checks
    if (!refresh(new Set(["evaluating"]))) {
      log.info("evaluation interrupted after built-in checks", { workspaceId });
      return;
    }

    // If built-in checks fail (WORK_LOCK present, active TODO items),
    // re-prompt the worker immediately — no need to invoke the judge.
    const allPassed = builtInChecks.every((c) => c.passed);
    if (!allPassed) {
      log.info("built-in checks failed, skipping judge (short-circuit)", {
        workspaceId,
        round: round.round,
        failedChecks: builtInChecks.filter((c) => !c.passed).map((c) => c.label),
      });
    }

    const passedCount = round.checks.filter((c) => c.passed).length;
    const failedCount = round.checks.filter((c) => !c.passed).length;
    const evalMs = Date.now() - evalStart;
    log.info("evaluation round complete", {
      workspaceId,
      round: round.round,
      totalChecks: round.checks.length,
      passed: passedCount,
      failed: failedCount,
      allPassed,
      evalMs,
    });
    const checkSummary = round.checks.map((c) => `${c.passed ? "PASS" : "FAIL"} ${c.label}`).join(", ");
    void this.#logTaskEvent(
      workspace,
      "evaluation-complete",
      `${passedCount}/${round.checks.length} passed (${evalMs}ms). ${checkSummary}`,
    );

    // Final interruption check before acting on results
    if (!refresh(new Set(["evaluating"]))) {
      log.info("evaluation interrupted before acting on results", { workspaceId });
      return;
    }

    if (!allPassed) {
      // Re-prompt worker with failure details — stays WITHIN the same round.
      // A round only advances when the judge sends the worker back; check
      // failures are just another worker attempt in the current round, so we
      // keep the same chip (action flips back to "running" so subsequent
      // #ensureRunningRound calls reuse this entry).
      if (this.#shouldShower(task)) {
        log.info("shower mode triggered before re-prompt", {
          workspaceId,
          round: task.currentRound,
          lastShower: task.lastShowerRound || 0,
        });
        round.action = "shower";
        this.#setTaskState(task, "refreshing");
        void this.#logTaskEvent(
          workspace,
          "shower-started",
          "Refreshing Worker context (killing session, writing handoff)",
        );
        this.#broadcastState!();
        const showerOk = await this.#performShower(workspace);
        if (!refresh(new Set(["refreshing"]))) return;
        if (showerOk) {
          this.#setTaskState(task, "running");
          round.action = "running";
          log.info("shower completed, waiting for refreshed worker", { workspaceId });
          void this.#logTaskEvent(workspace, "shower-completed", "Worker session restarted with fresh context");
        } else {
          log.warn("shower failed, falling back to normal re-prompt", { workspaceId });
          void this.#logTaskEvent(workspace, "shower-failed", "Handoff not written in time, falling back to re-prompt");
          const useWorkerFile = await this.#ensureFormatFlag(task, workspace);
          if (!refresh(new Set(["refreshing"]))) return;
          task.useWorkerFile ??= useWorkerFile;
          const prompt = buildRePrompt(task, round);
          const workerSessionId = `${workspaceId}:${task.workerPanelId}`;
          if (!(await this.#injectPrompt(workerSessionId, prompt, workspace))) return;
          if (!refresh(new Set(["refreshing"]))) return;
          this.#setTaskState(task, "running");
          round.action = "running";
        }
      } else {
        const useWorkerFile = await this.#ensureFormatFlag(task, workspace);
        if (!refresh(new Set(["evaluating"]))) return;
        task.useWorkerFile ??= useWorkerFile;
        const prompt = buildRePrompt(task, round);
        const workerSessionId = `${workspaceId}:${task.workerPanelId}`;
        if (!(await this.#injectPrompt(workerSessionId, prompt, workspace))) return;
        if (!refresh(new Set(["evaluating"]))) return;
        this.#setTaskState(task, "running");
        round.action = "running";
        log.info("worker re-prompted", { workspaceId, round: task.currentRound });
        void this.#logTaskEvent(
          workspace,
          "worker-reprompted",
          "Checks failed, Worker re-prompted with failure details",
        );
      }
    } else {
      // All checks passed — invoke judge (still within the current round;
      // currentRound only advances when the judge says "continue").
      round.action = "judge-requested";

      const judgeSetupStart = Date.now();

      // Krok 5 — don't clear blindly. A verdict file still on disk here was
      // never consumed (a judge wrote it but it wasn't read — e.g. during a
      // pause). Krok 3's resume reconcile handles the common case proactively;
      // as a backstop, log the discarded verdict's reason so an hour of judge
      // work doesn't vanish silently (incident A step 6).
      const staleVerdict = await readVerdict(workspace.cwd, task.taskId, log);
      if (!refresh(new Set(["evaluating"]))) return;
      round.action = "judge-requested";
      if (staleVerdict.reason !== "Judge did not produce a verdict file.") {
        log.warn("evaluateWorkerBody: discarding unconsumed verdict before fresh judge run", {
          workspaceId,
          verdict: staleVerdict.verdict,
        });
        void this.#logTaskEvent(
          workspace,
          "verdict-discarded",
          `Discarded an unconsumed judge verdict (${staleVerdict.verdict}): ${staleVerdict.reason || ""}`,
        );
      }
      // Clear old verdict and nudge flag for fresh judge evaluation
      await clearVerdict(workspace.cwd, task.taskId);
      if (!refresh(new Set(["evaluating"]))) return;
      task.judgeNudged = false;

      // Gather git context so the judge can see actual repo changes
      const gitContext = await getGitContext(workspace.cwd, { execCommand, log });
      if (!refresh(new Set(["evaluating"]))) return;
      const gitContextMs = Date.now() - judgeSetupStart;

      const judgeSessionId = `${workspaceId}:${task.judgePanelId}`;
      const useWorkerFile = await this.#ensureFormatFlag(task, workspace);
      if (!refresh(new Set(["evaluating"]))) return;
      task.useWorkerFile ??= useWorkerFile;
      const judgePrompt = await buildJudgePrompt(task, round, gitContext, workspace.cwd);
      if (!refresh(new Set(["evaluating"]))) return;
      if (shouldUseProgrammaticCopilotJudge(task.judgeProviderConfig)) {
        this.#setTaskState(task, "judge-evaluating");
        this.#programmaticJudges.add(workspaceId);
        this.#broadcastState!();
        void this.#logTaskEvent(
          workspace,
          "judge-requested",
          `All checks passed. Running Copilot judge in programmatic mode on Windows (git: ${gitContextMs}ms)`,
        );
        const judgeResult = await this.#runProgrammaticCopilotJudge(workspace, judgePrompt);
        if (!refresh(new Set(["judge-evaluating"]))) return;
        const totalJudgeMs = Date.now() - judgeSetupStart;
        const judgeSummaryTail = tailLines(judgeResult.stderr || judgeResult.stdout, MAX_OUTPUT_TAIL);
        if (judgeResult.exitCode !== 0) {
          log.warn("programmatic Copilot judge exited non-zero", {
            workspaceId,
            exitCode: judgeResult.exitCode,
            stderr: judgeSummaryTail,
          });
        } else {
          log.info("programmatic Copilot judge completed", { workspaceId, round: task.currentRound, totalJudgeMs });
        }
        void this.#logTaskEvent(
          workspace,
          "judge-programmatic-finished",
          `Copilot judge finished in programmatic mode (${totalJudgeMs}ms, exit ${judgeResult.exitCode})${
            judgeResult.exitCode !== 0 && judgeSummaryTail ? ` — ${judgeSummaryTail}` : ""
          }`,
        );
        task.judgeNudged = true;
        await this.#handleJudgeVerdict(workspace, "programmatic");
        return;
      }

      // Clear judge context for independent evaluation, then inject prompt
      if (!(await this.#clearSessionContext(judgeSessionId, workspace))) return;
      if (!refresh(new Set(["evaluating"]))) return;
      if (!(await this.#injectPrompt(judgeSessionId, judgePrompt, workspace))) return;
      if (!refresh(new Set(["evaluating"]))) return;
      round.action = "judge-requested";
      const totalSetupMs = Date.now() - judgeSetupStart;
      this.#setTaskState(task, "judge-evaluating");
      log.info("judge evaluation requested", { workspaceId, round: task.currentRound, gitContextMs, totalSetupMs });
      void this.#logTaskEvent(
        workspace,
        "judge-requested",
        `All checks passed. Judge prompt injected (git: ${gitContextMs}ms, total setup: ${totalSetupMs}ms)`,
      );
    }

    this.#broadcastState!();
  }

  // ---------------------------------------------------------------------------
  // Judge verdict handling
  // ---------------------------------------------------------------------------

  async #handleJudgeVerdict(
    initialWorkspace: TaskWorkspaceState,
    source = "manual",
    operation?: TaskOperationContext,
  ): Promise<void> {
    let workspace = initialWorkspace;
    let task = workspace.task;
    const workspaceId = workspace.id;
    const taskId = task.taskId;
    const currentRound = task.currentRound;
    const taskOperation =
      operation ?? this.#captureTaskOperation(workspace, `judge-verdict:${source}`, { round: true });
    const initial = this.#currentTaskOperation(taskOperation, new Set(["judge-evaluating"]));
    if (!initial) return;
    workspace = initial;
    task = workspace.task;
    const generation = this.#standardTaskRunGeneration.get(workspaceId) ?? 0;
    const judgeSessionId = `${workspaceId}:${task.judgePanelId}`;
    // Krok 2 — an idle_prompt Notification (Claude's 60s "waiting for input")
    // is NOT proof the turn ended: our prompt may just be sitting unsubmitted in
    // the composer. Treat it as "keep waiting", never as a turn boundary.
    const isIdlePromptOnly = source.includes("idle_prompt") || source.includes("notification");
    const activeVerdict = this.#handlingStandardVerdict.get(workspaceId);
    if (activeVerdict) {
      if (activeVerdict.idleOnly && !isIdlePromptOnly) this.#pendingStandardVerdict.set(workspaceId, source);
      return;
    }
    this.#handlingStandardVerdict.set(workspaceId, { owner: taskOperation.id, idleOnly: isIdlePromptOnly });

    try {
      const verdict = await readVerdict(workspace.cwd, task.taskId, log);
      if (!this.#currentTaskOperation(taskOperation, new Set(["judge-evaluating"]))) return;
      let current = this.#getCurrentStandardTask(
        workspaceId,
        taskId,
        currentRound,
        generation,
        new Set(["judge-evaluating"]),
        taskOperation,
      );
      if (!current) return;
      const verdictMissing = verdict.reason === "Judge did not produce a verdict file.";

      if (verdictMissing) {
        // Krok 9c — under a judge rate-limit hold, the judge can't act until the
        // window resets; wait for the scheduled resume rather than nudging or
        // giving up. (An existing verdict is handled below, regardless of hold.)
        const judgeHold = this.#judgeRateLimitedUntil.get(workspaceId);
        if (judgeHold && judgeHold > Date.now()) {
          log.info("judge verdict missing under rate-limit hold — waiting for resume", { workspaceId });
          return;
        }
        // Don't escalate on a mere idle_prompt — wait for a real Stop. Krok 1's
        // verified submit usually fixes the lost-Enter case the nudge targeted.
        if (isIdlePromptOnly) {
          log.info("judge verdict missing on idle_prompt — waiting for a real Stop", { workspaceId, source });
          return;
        }

        // First real idle without a verdict: nudge once. LLMs sometimes print
        // the verdict as text instead of writing the file. An idle after the
        // user talked to the Judge may answer THEM, not the evaluation — it
        // must not spend the nudge (and then the task) on their Q&A.
        const userInterjected = this.#userInterjected(judgeSessionId);
        if (!current.task.judgeNudged || userInterjected) {
          if (current.task.judgeNudged) {
            log.info("judge verdict missing after the user's own turn — reminding the Judge again", {
              workspaceId,
              source,
              ...this.#politeLogContext(judgeSessionId),
            });
          }
          current.task.judgeNudged = true;
          const dir = taskDirRel(task.taskId);
          // Krok 10 — the example shows "continue", not "complete": a fresh judge
          // with no context tends to copy the example verbatim, and "bias toward
          // continue" (JUDGE_PROMPT.md) means an unsure judge must NOT
          // rubber-stamp unevaluated work as complete.
          const nudge = `You MUST write your verdict to ${dir}/${VERDICT_FILE} as a JSON file now. Use the Write tool or cat/heredoc. Example:\n\n{"verdict": "continue", "reason": "Describe what still needs work."}\n\nWrite the file now.`;
          log.info("judge verdict file missing, sending nudge", { workspaceId });
          void this.#logTaskEvent(workspace, "judge-nudged", "Verdict file missing — reminded Judge to write it");
          current = this.#getCurrentStandardTask(
            workspaceId,
            taskId,
            currentRound,
            generation,
            new Set(["judge-evaluating"]),
            taskOperation,
          );
          if (!current) return;
          if (!(await this.#injectPrompt(judgeSessionId, nudge, current))) return;
          current = this.#getCurrentStandardTask(
            workspaceId,
            taskId,
            currentRound,
            generation,
            new Set(["judge-evaluating"]),
            taskOperation,
          );
          if (!current) return;
          this.#broadcastState!();
          return; // Wait for next judge idle — will re-enter #handleJudgeVerdict
        }

        // Already nudged. Before giving up, check the judge isn't provably still
        // working (subagents running, output in the last 30s). "Judge idle" ≠
        // "judge done" — a premature pause here is incident A.
        if (this.#isSessionBusy?.(judgeSessionId)) {
          log.info("judge verdict still missing but judge is busy — waiting", { workspaceId, source });
          return;
        }

        // Nudged + a real Stop + not busy + still no verdict → give up.
        log.warn("judge verdict file missing after nudge", { workspaceId, round: current.task.currentRound });
        current.task.pausedFromState = "judge-evaluating"; // Krok 4 — resume reads the verdict
        this.#setTaskState(current.task, "paused");
        void this.#logTaskEvent(
          current,
          "judge-give-up",
          "Judge produced no verdict after nudge + Stop (not busy) — pausing.",
        ); // Krok 2/7
        this.#broadcastState!();
        this.#raiseTaskAlert(current, "failed", "Judge did not produce a verdict file");
        return;
      }

      // A real verdict supersedes any judge rate-limit hold (incident C). The
      // judge cycle succeeded → reset its per-role retry counter too.
      this.#judgeRateLimitedUntil.delete(workspaceId);
      this.#clearRateLimitResumeTimer(workspaceId, "judge");
      this.#rateLimitCtx.delete(this.#rlKey(workspaceId, "judge"));

      log.info("judge verdict", { workspaceId, verdict: verdict.verdict, reason: verdict.reason });
      void this.#logTaskEvent(workspace, "judge-verdict", `Verdict: ${verdict.verdict}. ${verdict.reason || ""}`);

      // Bail out if user paused/reset while reading verdict.
      current = this.#getCurrentStandardTask(
        workspaceId,
        taskId,
        currentRound,
        generation,
        new Set(["judge-evaluating"]),
        taskOperation,
      );
      if (!current) return;
      const liveTask = current.task;
      const liveWorkspace = current;

      const rounds = liveTask.rounds as unknown as TaskRound[];
      const lastRound = rounds[rounds.length - 1];
      if (lastRound) {
        lastRound.judgeVerdict = verdict.verdict;
        lastRound.judgeReason = verdict.reason || "";
      }

      if (verdict.verdict === "complete") {
        this.#setTaskState(liveTask, "completed");
        if (lastRound) lastRound.action = "completed";
        log.info("task completed by judge verdict", { workspaceId, rounds: task.currentRound });
        void this.#logTaskEvent(liveWorkspace, "task-completed", verdict.reason || "Judge approved");
        this.#raiseTaskAlert(liveWorkspace, "completed", verdict.reason ? `Judge: ${verdict.reason}` : undefined);
        // Tell the Worker to stop — otherwise Claude Code continues autonomously
        this.#notifyWorkerTaskEnded(liveWorkspace, "completed");
      } else {
        // "continue" — re-prompt worker with judge feedback
        // Preserve judge instructions for shower mode (survives session restart)
        if (verdict.reason) {
          liveTask.lastJudgeInstructions = verdict.reason;
          log.debug("stored judge instructions for potential shower", {
            workspaceId,
            reasonLength: verdict.reason.length,
          });
        }

        if (liveTask.currentRound >= liveTask.maxRounds) {
          this.#setTaskState(liveTask, "failed");
          if (lastRound) lastRound.action = "failed";
          log.info("task failed: max rounds after judge", { workspaceId, rounds: task.currentRound });
          void this.#logTaskEvent(liveWorkspace, "task-failed", `Max rounds after judge. ${verdict.reason || ""}`);
          this.#raiseTaskAlert(liveWorkspace, "failed", `Max rounds reached. Judge: ${verdict.reason || "incomplete"}`);
          this.#notifyWorkerTaskEnded(liveWorkspace, "failed");
        } else {
          // Judge sent the worker back — this starts a new round. The worker
          // removed WORK_LOCK at the end of the previous round (that's how it
          // signaled completion), so put it back BEFORE injecting the prompt.
          // Otherwise the worker reads an absent lock and mistakes the next
          // round for "task already done", refusing to do further work.
          await this.#recreateWorkLock(current, "judgeVerdict-continue");
          current = this.#getCurrentStandardTask(
            workspaceId,
            taskId,
            currentRound,
            generation,
            new Set(["judge-evaluating"]),
            taskOperation,
          );
          if (!current) return;

          const useWorkerFile = await this.#ensureFormatFlag(current.task, current);
          current = this.#getCurrentStandardTask(
            workspaceId,
            taskId,
            currentRound,
            generation,
            new Set(["judge-evaluating"]),
            taskOperation,
          );
          if (!current) return;
          current.task.useWorkerFile ??= useWorkerFile;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const prompt = buildJudgeFeedbackPrompt(current.task, verdict as any);
          const workerSessionId = `${workspaceId}:${task.workerPanelId}`;
          // Clear worker context before each new round so the agent starts fresh
          // without accumulating stale context from prior rounds.
          try {
            if (!(await this.#clearSessionContext(workerSessionId, current))) return;
            current = this.#getCurrentStandardTask(
              workspaceId,
              taskId,
              currentRound,
              generation,
              new Set(["judge-evaluating"]),
              taskOperation,
            );
            if (!current) return;
          } catch (err: unknown) {
            log.warn("worker context clear before new round failed (proceeding)", {
              workspaceId,
              err: (err as Error)?.message,
            });
          }
          current = this.#getCurrentStandardTask(
            workspaceId,
            taskId,
            currentRound,
            generation,
            new Set(["judge-evaluating"]),
            taskOperation,
          );
          if (!current) return;
          if (!(await this.#injectPrompt(workerSessionId, prompt, current))) return;
          current = this.#getCurrentStandardTask(
            workspaceId,
            taskId,
            currentRound,
            generation,
            new Set(["judge-evaluating"]),
            taskOperation,
          );
          if (!current) return;
          this.#setTaskState(current.task, "running");
          const currentLastRound = (current.task.rounds as unknown as TaskRound[]).at(-1);
          if (currentLastRound) currentLastRound.action = "re-prompted";
          current.task.currentRound += 1;
          this.#ensureRunningRound(current.task);
          log.info("worker re-prompted with judge feedback", { workspaceId, round: current.task.currentRound });
          void this.#logTaskEvent(
            current,
            "worker-reprompted",
            `Judge feedback: ${verdict.reason || "continue working"}`,
          );
        }
      }

      this.#broadcastState!();
    } catch (err: unknown) {
      log.error("handleJudgeVerdict failed", { workspaceId, err: (err as Error)?.message });
      const current = this.#getCurrentStandardTask(
        workspaceId,
        taskId,
        currentRound,
        generation,
        new Set(["judge-evaluating"]),
        taskOperation,
      );
      if (!current) return;
      // Krok 4 — resume should re-read the verdict, so record judge-evaluating.
      current.task.pausedFromState = "judge-evaluating";
      this.#setTaskState(current.task, "paused");
      void this.#logTaskEvent(
        current,
        "judge-error",
        `Verdict handling failed: ${(err as Error)?.message || "unknown"}`,
      );
      this.#broadcastState!();
    } finally {
      if (this.#handlingStandardVerdict.get(workspaceId)?.owner === taskOperation.id) {
        this.#handlingStandardVerdict.delete(workspaceId);
        const pending = this.#pendingStandardVerdict.get(workspaceId);
        this.#pendingStandardVerdict.delete(workspaceId);
        // Asked only when a signal was queued — this pass usually just moved
        // the task on itself (judge-evaluating → running, next round). This
        // pass held the verdict guard throughout, so a task that advanced was
        // advanced by it, and the queued signal is moot.
        const current = pending
          ? this.#currentTaskOperation(taskOperation, new Set(["judge-evaluating"]), {
              expectedRefusal: { reason: "verdict-pass-advanced-task", checks: TASK_ADVANCED_CHECKS },
            })
          : null;
        if (pending && current) {
          void this.#handleJudgeVerdict(current, pending).catch((err: unknown) => {
            log.error("queued judge verdict handling failed", { workspaceId, err: (err as Error)?.message });
          });
        }
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Attached mode (Companion loop) — see docs/agent-task-runner.md. These
  // methods are deliberately PARALLEL to the Worker/Judge methods above
  // rather than branching inside them: every entry point that can receive an
  // attached task dispatches here as its very first action, so standard
  // tasks execute the exact same code they always did (plan §14 "Běžné task
  // workspaces se chovají beze změny").
  // ---------------------------------------------------------------------------

  /**
   * Build an attached task workspace object (not yet persisted — caller
   * saves via runtime.saveWorkspace, mirroring createTaskWorkspace). Only
   * Dashboard + Companion panels: there is no Worker panel because the
   * Worker/"Primary" role is an existing, externally-owned session that
   * keeps living in its own workspace (plan §6).
   */
  createCompanionTaskWorkspace({
    state,
    workerWorkspaceId,
    workerPanelId,
    primaryProvider,
    companionRole,
    companionProvider,
    companionCommand,
    focus,
    maxRounds,
    autoStartAfterCapture,
    callerProfileId = "",
  }: {
    state: Partial<Pick<AppState, "workspaces" | "windowSlots">>;
    workerWorkspaceId: string;
    workerPanelId: string;
    /** Informational only (plan §7) — used for injection-strategy/idle-timeout
     * lookups on the existing Primary session. Never used to build a command. */
    primaryProvider?: ParsedProviderConfig | null;
    companionRole: CompanionRole;
    companionProvider: ParsedProviderConfig;
    /** Full CLI command that replaces the one built from companionProvider. */
    companionCommand?: string;
    focus?: string;
    maxRounds?: number;
    /** Skip the "Brief ready" gate — see TaskState.autoStartAfterCapture. */
    autoStartAfterCapture?: boolean;
    callerProfileId?: string;
  }): TaskWorkspaceState {
    const sourceWorkspace = state.workspaces?.find((w) => w.id === workerWorkspaceId);
    if (!sourceWorkspace) {
      throw new Error(`createCompanionTaskWorkspace: source workspace not found: ${workerWorkspaceId}`);
    }
    const sourcePanel = sourceWorkspace.panels?.find((p) => p.id === workerPanelId);
    if (!sourcePanel) {
      throw new Error(`createCompanionTaskWorkspace: source panel not found: ${workerPanelId}`);
    }

    const workspaceId = `workspace-${randomUUID()}`;
    const dashboardPanelId = `panel-${randomUUID()}`;
    const judgePanelId = `panel-${randomUUID()}`;

    const roleLabel = COMPANION_ROLE_DISPLAY_NAMES[companionRole];
    const autoName = `${roleLabel}: ${formatWorkspaceDisplayName(sourceWorkspace)}`;

    // Same stable per-parent ordinal scheme as createTaskWorkspace, scoped by
    // the SOURCE workspace id (companion loops are children of the source,
    // not of each other).
    const siblings = (state.workspaces || []).filter(
      (w) => w.kind === "task" && (w.task?.parentWorkspaceId || "") === workerWorkspaceId,
    );
    const maxSeq = siblings.reduce((max, w) => Math.max(max, w.task?.sequenceNumber || 0), 0);
    const sequenceNumber = Math.max(maxSeq, siblings.length) + 1;

    const jp = getProvider(companionProvider.providerId);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const jpCtor = jp.constructor as any;
    // Same precedence as a standard task's worker/judge: an explicit command
    // wins, otherwise build one from the picked provider. Whether to bypass
    // permission prompts is the user's choice — a companion that has to ask
    // before reading a file cannot run its loop unattended.
    const resolvedJudgeCmd =
      companionCommand?.trim() ||
      jp.buildCommand({
        model: companionProvider.model,
        role: "judge",
        skipPermissions: companionProvider.skipPermissions === true,
      });
    const judgeTitle = `${roleLabel} (${jpCtor.displayName} ${companionProvider.model})`;

    return {
      id: workspaceId,
      name: autoName,
      icon: "\u{1F916}", // 🤖
      color: sourceWorkspace.color || "#7C4DFF",
      kind: "task",
      source: "manual",
      pluginId: "",
      // Effective cwd = the source PANEL's cwd if set, else the source
      // workspace's cwd (plan §7) — a live conversation's cwd may differ
      // from its workspace's nominal cwd (e.g. a manually-cd'd shell tab).
      cwd: sourcePanel.cwd || sourceWorkspace.cwd,
      gitRoots: [],
      activeRootPath: "",
      notes: "",
      profileId: sourceWorkspace.profileId || callerProfileId || "default",
      connectionId: "",
      activePanelId: dashboardPanelId,
      activeViewId: null,
      splitLayout: null,
      splitViewIds: [],
      starred: false,
      review: null,
      quickfix: null,

      panels: [
        {
          id: dashboardPanelId,
          title: "Dashboard",
          command: "__task-dashboard__",
          shell: false as unknown as string,
          startup: "none",
        },
        {
          id: judgePanelId,
          title: judgeTitle,
          command: resolvedJudgeCmd,
          shell: true as unknown as string,
          startup: "default",
        },
      ],
      task: {
        taskId: randomUUID(),
        description: "",
        parentWorkspaceId: workerWorkspaceId,
        worktreeBase: "",
        worktreeBranch: "",
        workerPanelId,
        judgePanelId,
        maxRounds: maxRounds || 10,
        showerInterval: 0, // Shower is disabled for attached tasks (plan §8.6).
        state: "idle",
        currentRound: 0,
        rounds: [],
        lastShowerRound: 0,
        lastJudgeInstructions: "",
        workerProviderConfig: primaryProvider || null,
        // Stored config must agree with the command actually built above, so
        // that a reload or a Continue rebuilds the same agent.
        judgeProviderConfig: { ...companionProvider, skipPermissions: companionProvider.skipPermissions === true },
        startedAt: null,
        totalPausedMs: 0,
        pausedAt: null,
        finishedAt: null,
        rateLimitedUntil: null,
        promptSent: false,
        pausedFromState: "",
        showerResumePrompt: "",
        createdAt: new Date().toISOString(),
        sequenceNumber,
        mode: "attached",
        workerWorkspaceId,
        companionRole,
        companionFocus: focus?.trim() || "",
        autoStartAfterCapture: autoStartAfterCapture === true,
      } as RuntimeTaskState,
    };
  }

  /** Attached counterpart to writeInitialFiles — TASK.md + WORKER.md +
   * JUDGE_PROMPT.md only (no TODO.md/WORK_LOCK; see writeCompanionInitialFiles). */
  async writeCompanionFiles(cwd: string, task: RuntimeTaskState): Promise<void> {
    log.info("writing companion initial files", { cwd, taskId: task.taskId, role: task.companionRole });
    await runEffect(
      Effect.all(
        [
          Effect.tryPromise({
            try: () => writeCompanionInitialFiles(cwd, task, log),
            catch: (e) => new TaskFileError({ workspaceId: task.taskId, path: cwd, cause: e }),
          }),
          Effect.tryPromise({
            try: () => ensureGitIgnore(cwd, log),
            catch: (e) => new TaskFileError({ workspaceId: task.taskId, path: cwd, cause: e }),
          }),
        ],
        { concurrency: "unbounded" },
      ),
    );
  }

  /** Attached counterpart to startTask's body — dispatches by current state
   * instead of always injecting the initial worker prompt. */
  async #startAttachedTask(
    initialWorkspace: TaskWorkspaceState,
    inheritedOperation?: TaskOperationContext,
  ): Promise<boolean> {
    let workspace = initialWorkspace;
    const actionableState = workspace.task.state;
    if (actionableState !== "idle" && actionableState !== "brief-ready") return false;
    if (!this.#assertAttachedPrimaryAvailable(workspace, "Start")) return false;
    if (!inheritedOperation) {
      this.#advanceTaskLifecycle(workspace.id, "attached-start");
      const fresh = this.#findTaskWorkspace(workspace.id);
      if (!fresh || fresh.task.taskId !== workspace.task.taskId) return false;
      workspace = fresh;
    }
    const operation =
      inheritedOperation ??
      this.#captureTaskOperation(workspace, "attached-start", {
        round: workspace.task.state === "brief-ready",
      });
    let task = workspace.task;
    const refresh = (states?: ReadonlySet<string>): boolean => {
      const fresh = this.#currentTaskOperation(operation, states);
      if (!fresh) return false;
      workspace = fresh;
      task = fresh.task;
      return true;
    };
    const workspaceId = workspace.id;

    if (task.state === "idle") {
      const sessionId = sessionIdFor(workspace, "worker");
      this.#setTaskState(task, "capturing-context");
      // Stamped BEFORE the prompt goes out: nothing ever deletes CONTEXT.md /
      // HANDOFF.md, so this is the only thing separating "the Primary just
      // wrote a capture" from "a capture from before the last Reset is still
      // lying on disk".
      task.captureStartedAt = new Date().toISOString();
      const prompt = buildContextCapturePrompt(task);
      try {
        if (!(await this.#injectPrompt(sessionId, prompt, workspace))) return false;
        if (!refresh(new Set(["capturing-context"]))) return false;
      } catch (err: unknown) {
        if (!refresh(new Set(["capturing-context"]))) return false;
        log.error("startAttachedTask: failed to inject capture prompt", {
          workspaceId,
          err: (err as Error)?.message,
        });
        this.#setTaskState(task, "idle");
        task.captureStartedAt = undefined;
        this.#broadcastState!();
        return false;
      }
      log.info("attached task: capture prompt sent to Primary", { workspaceId });
      void this.#logTaskEvent(workspace, "capture-started", "Capture prompt sent to the Primary conversation.");
      this.#broadcastState!();
      return true;
    }

    if (task.state === "brief-ready") {
      task.contextApprovedAt = new Date().toISOString();
      task.currentRound = 1;
      task.rounds = [];
      this.#ensureRunningRound(task);
      this.#setTaskState(task, "evaluating");
      void this.#logTaskEvent(workspace, "baseline-started", "Baseline companion evaluation requested.");
      this.#broadcastState!();
      const evaluationOperation = this.#captureTaskOperation(workspace, "attached-baseline", {
        round: true,
      });
      try {
        await this.#requestCompanionEvaluation(workspace, "baseline", null, evaluationOperation);
      } catch (err: unknown) {
        if (refresh(new Set(["evaluating"]))) {
          this.#setTaskState(task, "brief-ready");
          log.error("startAttachedTask: baseline evaluation failed", {
            workspaceId,
            err: (err as Error)?.message,
          });
          this.#broadcastState!();
        }
        return false;
      }
      return true;
    }

    log.debug("startAttachedTask: no-op for current state", { workspaceId, state: task.state });
    return false;
  }

  /** Attached counterpart to onAgentIdle's dispatch body. */
  #onAttachedAgentIdle(
    workspace: TaskWorkspaceState,
    role: TaskBindingRole,
    sessionId: string,
    source: string,
  ): boolean {
    const task = workspace.task;
    const workspaceId = workspace.id;

    if (task.state === "paused") {
      log.debug("onAttachedAgentIdle: paused task, falling through to user pipeline", {
        sessionId,
        taskState: task.state,
      });
      return false;
    }

    if (role === "worker") {
      if (task.state === "capturing-context") {
        this.#checkCaptureReadiness(workspace, sessionId).catch((err: unknown) => {
          log.error("checkCaptureReadiness error", { workspaceId, err: (err as Error)?.message });
        });
        return true;
      }
      if (task.state === "running") {
        // App-restart recovery (resolveTaskRecovery) stashes a re-orientation
        // prompt here for the freshly re-spawned Primary panel, the same
        // "inject on first idle" pattern the judge branch below uses.
        if (task.showerResumePrompt) {
          const prompt = task.showerResumePrompt;
          task.showerResumePrompt = "";
          this.#injectPrompt(sessionId, prompt, workspace).catch((err: unknown) => {
            log.error("primary recovery prompt injection failed", { workspaceId, err: (err as Error)?.message });
          });
          this.#broadcastState!();
          return true;
        }
        // Dropout guard: the Primary is an EXTERNALLY OWNED session. Unlike
        // the standard worker, the runner never restarts it — that would be
        // touching a conversation the user owns. Pause with an actionable
        // alert instead (plan §8.6).
        if (this.#isAgentDroppedToShell?.(sessionId)) {
          task.pausedFromState = "running";
          this.#setTaskState(task, "paused");
          this.#evaluating.delete(workspaceId);
          void this.#logTaskEvent(
            workspace,
            "primary-dropout",
            "Primary conversation appears to have exited — task paused.",
          );
          this.#raiseTaskAlert(
            workspace,
            "failed",
            "Primary conversation appears to have exited. Open Primary to check, then Continue.",
          );
          this.#broadcastState!();
          return true;
        }
        this.#dropoutCtx.delete(sessionId);
        void this.#logTaskEvent(
          workspace,
          "primary-idle-detected",
          `Primary went idle via ${source}. Checking verification…`,
        );
        this.#evaluateCompanionRound(workspace).catch((err: unknown) => {
          log.error("evaluateCompanionRound error", { workspaceId, err: (err as Error)?.message });
        });
        return true;
      }
      log.debug("onAttachedAgentIdle: primary idle in non-actionable state, consuming", {
        sessionId,
        taskState: task.state,
      });
      return true;
    }

    // role === "judge" (Companion)
    if (task.state === "judge-evaluating") {
      if (this.#programmaticJudges.has(workspaceId)) return true;
      if (task.showerResumePrompt) {
        const prompt = task.showerResumePrompt;
        task.showerResumePrompt = "";
        this.#injectPrompt(sessionId, prompt, workspace).catch((err: unknown) => {
          log.error("companion recovery prompt injection failed", { workspaceId, err: (err as Error)?.message });
        });
        this.#broadcastState!();
        return true;
      }
      if (this.#isAgentDroppedToShell?.(sessionId)) {
        this.#handleAgentDropout(workspace, sessionId, "judge").catch((err: unknown) => {
          log.error("handleAgentDropout (companion) error", { workspaceId, err: (err as Error)?.message });
        });
        return true;
      }
      this.#dropoutCtx.delete(sessionId);
      void this.#logTaskEvent(
        workspace,
        "companion-idle-detected",
        `Companion went idle via ${source}. Reading verdict…`,
      );
      this.#handleCompanionVerdict(workspace, source).catch((err: unknown) => {
        log.error("handleCompanionVerdict error", { workspaceId, err: (err as Error)?.message });
      });
      return true;
    }
    log.debug("onAttachedAgentIdle: companion idle in non-actionable state, consuming", {
      sessionId,
      taskState: task.state,
    });
    return true;
  }

  /**
   * Check whether CONTEXT.md/HANDOFF.md are structurally ready. Nudges once
   * if incomplete; a second incomplete idle pauses with an actionable alert
   * rather than nudging forever (plan §8.3).
   */
  async #checkCaptureReadiness(
    initialWorkspace: TaskWorkspaceState,
    sessionId: string,
    inheritedOperation?: TaskOperationContext,
  ): Promise<void> {
    let workspace = initialWorkspace;
    const operation = inheritedOperation ?? this.#captureTaskOperation(workspace, "capture-readiness");
    let task = workspace.task;
    const refresh = (states: ReadonlySet<string>): boolean => {
      const fresh = this.#currentTaskOperation(operation, states);
      if (!fresh) return false;
      workspace = fresh;
      task = fresh.task;
      return true;
    };
    if (task.state !== "capturing-context") return;
    const validation = await validateCaptureFiles(workspace.cwd, task.taskId, {
      sinceIso: task.captureStartedAt || null,
    });
    // Re-check after the async read: a pause/reset may have landed while we
    // were reading the capture files from disk.
    if (!refresh(new Set(["capturing-context"]))) return;

    if (validation.ok) {
      this.#setTaskState(task, "brief-ready");
      log.info("attached task: capture complete", {
        workspaceId: workspace.id,
        autoStart: task.autoStartAfterCapture === true,
      });
      void this.#logTaskEvent(
        workspace,
        "context-captured",
        task.autoStartAfterCapture
          ? "CONTEXT.md and HANDOFF.md captured — starting the loop without waiting for confirmation."
          : "CONTEXT.md and HANDOFF.md captured — brief ready for review.",
      );
      this.#broadcastState!();
      if (task.autoStartAfterCapture) {
        // Deliberately the very same brief-ready branch the Start button
        // drives: approval timestamp, round bookkeeping and the
        // Primary-availability refusal all stay in one place. brief-ready is
        // set BEFORE this await, so the several idle signals that arrive per
        // Primary turn (hook, notification, watcher backstop) can't each
        // launch a baseline — they all early-return on the state check above.
        // A refusal here leaves the task sitting in brief-ready, which is
        // exactly the manual gate, so nothing is ever stranded.
        const started = await this.#startAttachedTask(workspace);
        if (!this.#currentTaskOperation(operation)) return;
        if (!started) {
          log.warn("attached task: auto-start after capture did not run — brief-ready stands", {
            workspaceId: workspace.id,
          });
        }
      }
      return;
    }

    // A reminder already waiting for the user: this idle has nothing to add.
    if ((this.#politeWaits.get(sessionId) ?? 0) > 0) return;
    // An idle after the user's own turn with the Primary is not the capture
    // turn ending incomplete — remind again instead of pausing on their Q&A.
    if (!task.captureNudged || this.#userInterjected(sessionId)) {
      task.captureNudged = true;
      const staleFiles = [
        validation.contextStale ? CONTEXT_FILE : "",
        validation.handoffStale ? HANDOFF_FILE : "",
      ].filter(Boolean);
      const nudge = `${CONTEXT_FILE}/${HANDOFF_FILE} capture is not complete yet. ${
        validation.contextExists ? "" : `${CONTEXT_FILE} is missing. `
      }${validation.handoffExists ? "" : `${HANDOFF_FILE} is missing. `}${
        staleFiles.length
          ? `${staleFiles.join(" and ")} ${staleFiles.length > 1 ? "are" : "is"} left over from an earlier capture — rewrite ${staleFiles.length > 1 ? "them" : "it"} from your current context. `
          : ""
      }Finish writing both files with every required section (see your capture instructions), then stop.`;
      if (!refresh(new Set(["capturing-context"]))) return;
      try {
        if (!(await this.#injectPrompt(sessionId, nudge, workspace))) return;
      } catch (err: unknown) {
        log.warn("checkCaptureReadiness: nudge injection failed", {
          workspaceId: workspace.id,
          err: (err as Error)?.message,
        });
      }
      if (!this.#currentTaskOperation(operation, new Set(["capturing-context"]))) return;
      void this.#logTaskEvent(workspace, "capture-nudged", "Reminded Primary to finish CONTEXT.md/HANDOFF.md.");
      this.#broadcastState!();
      return;
    }

    task.pausedFromState = "capturing-context";
    this.#setTaskState(task, "paused");
    void this.#logTaskEvent(
      workspace,
      "capture-incomplete",
      "Capture did not complete after a reminder — task paused.",
    );
    this.#raiseTaskAlert(
      workspace,
      "failed",
      "Context capture did not complete. Open Primary, finish CONTEXT.md/HANDOFF.md, then Continue.",
    );
    this.#broadcastState!();
  }

  /**
   * Round-review gate for attached tasks: waits for WORK_LOCK absence (same
   * completion signal as the standard flow), then checks VERIFICATION.md
   * structurally/freshness — NEVER runs a project command (plan §8.4). A
   * missing/invalid/stale record is a Primary-side protocol issue and is
   * nudged directly; the Companion is never spawned for it.
   */
  async #evaluateCompanionRound(
    initialWorkspace: TaskWorkspaceState,
    inheritedOperation?: TaskOperationContext,
  ): Promise<void> {
    let workspace = initialWorkspace;
    const operation =
      inheritedOperation ?? this.#captureTaskOperation(workspace, "attached-round-evaluation", { round: true });
    let task = workspace.task;
    const refresh = (states: ReadonlySet<string>): boolean => {
      const fresh = this.#currentTaskOperation(operation, states);
      if (!fresh) return false;
      workspace = fresh;
      task = fresh.task;
      return true;
    };
    const workspaceId = operation.workspaceId;
    if (!refresh(new Set(["running"]))) return;
    if (this.#evaluating.has(workspaceId)) return;
    this.#clearRateLimitCtx(workspaceId);
    this.#evaluating.add(workspaceId);
    this.#evaluationOwners.set(workspaceId, operation.id);
    try {
      this.#setTaskState(task, "evaluating");
      this.#broadcastState!();

      const workLockGone = await this.isWorkerCompleted(workspaceId);
      if (!refresh(new Set(["evaluating"]))) return;
      if (!workLockGone) {
        // Primary hasn't signalled done yet — nothing to evaluate.
        this.#setTaskState(task, "running");
        this.#broadcastState!();
        return;
      }

      const verification = await readVerificationRecord(workspace.cwd, task.taskId, {
        expectedRound: task.currentRound,
        sinceIso: task.companionLastFeedbackAt || null,
      });
      if (!refresh(new Set(["evaluating"]))) return;

      const structurallyBad =
        verification.status === "missing" || verification.status === "invalid" || verification.status === "stale";
      if (structurallyBad && !task.verificationNotRequired) {
        if (!refresh(new Set(["evaluating"]))) return;
        await this.#recreateWorkLock(workspace, "verification-gate");
        if (!refresh(new Set(["evaluating"]))) return;
        const nudge = buildVerificationNudgePrompt(task, verification);
        if (!(await this.#injectPrompt(sessionIdFor(workspace, "worker"), nudge, workspace))) return;
        if (!refresh(new Set(["evaluating"]))) return;
        this.#setTaskState(task, "running");
        log.info("attached task: verification record not ready, nudged Primary", {
          workspaceId,
          status: verification.status,
        });
        void this.#logTaskEvent(
          workspace,
          "verification-missing",
          `VERIFICATION.md is ${verification.status} — asked Primary to record it before the next companion review.`,
        );
        this.#broadcastState!();
        return;
      }

      await this.#requestCompanionEvaluation(
        workspace,
        "round-review",
        structurallyBad ? null : verification,
        operation,
      );
    } catch (err: unknown) {
      if (refresh(new Set(["evaluating"]))) {
        task.pausedFromState = "evaluating";
        this.#setTaskState(task, "paused");
        log.error("evaluateCompanionRound: evaluation request failed", {
          workspaceId,
          err: (err as Error)?.message,
        });
        this.#broadcastState!();
      }
      throw err;
    } finally {
      if (this.#evaluationOwners.get(workspaceId) === operation.id) {
        this.#evaluationOwners.delete(workspaceId);
        this.#evaluating.delete(workspaceId);
      }
    }
  }

  /** IDs of every blocking finding ever raised for this task, across rounds —
   * used so the Companion prompt can require RESOLVED/STILL OPEN/REOPENED
   * tracking rather than losing history each round (plan §4.15). */
  #collectPreviousCompanionFindingIds(task: RuntimeTaskState): string[] {
    const rounds = (task.rounds as unknown as TaskRound[]) || [];
    const ids = new Set<string>();
    for (const r of rounds) {
      const list = r.companionFindingIds as string[] | undefined;
      if (Array.isArray(list)) for (const id of list) ids.add(id);
    }
    return [...ids];
  }

  /**
   * The identity a verdict on disk must carry to count as the answer to the
   * evaluation currently in flight. role/phase/round are not enough on their
   * own — a `needs-input` answer and a withheld completion both re-evaluate the
   * same phase and round — so the attempt counter is part of it. Every
   * readCompanionVerdict call site goes through here so they can never disagree.
   */
  #companionVerdictExpectation(task: RuntimeTaskState): {
    role: string;
    phase: string;
    round: number;
    evaluationAttempt?: number;
  } {
    return {
      role: task.companionRole || "reviewer",
      phase: task.companionPhase || "baseline",
      round: task.currentRound || 1,
      evaluationAttempt: task.companionEvaluationAttempt,
    };
  }

  /**
   * Has the verdict for the evaluation currently in flight already been
   * processed? Used by the watcher backstop to decide whether a verdict file it
   * found still needs handling.
   */
  #companionVerdictAlreadyHandled(task: RuntimeTaskState): boolean {
    const attempt = task.companionEvaluationAttempt;
    if (attempt === undefined) {
      // Mid-evaluation when the task was upgraded: no attempt was ever handed
      // out, so the round chip's verdict is the only marker that exists.
      const rounds = task.rounds as unknown as TaskRound[];
      return Boolean(rounds?.[rounds.length - 1]?.judgeVerdict);
    }
    return task.companionVerdictHandledAttempt === attempt;
  }

  /** Build + inject the Companion evaluation prompt and move to judge-evaluating. */
  async #requestCompanionEvaluation(
    workspace: TaskWorkspaceState,
    phase: "baseline" | "round-review" | "recovery",
    verification: VerificationRecord | null,
    inheritedOperation?: TaskOperationContext,
  ): Promise<void> {
    if (inheritedOperation) {
      const inheritedWorkspace = this.#currentTaskOperation(inheritedOperation);
      if (!inheritedWorkspace) return;
      workspace = inheritedWorkspace;
    }
    let current = workspace;
    const operation = this.#captureTaskOperation(workspace, `companion-evaluation:${phase}`, { round: true });
    let task = current.task;
    const refresh = (states?: ReadonlySet<string>): boolean => {
      const fresh = this.#currentTaskOperation(operation, states);
      if (!fresh) return false;
      current = fresh;
      task = fresh.task;
      return true;
    };
    const workspaceId = operation.workspaceId;
    if (!refresh()) return;
    const initialState = task.state;
    const allowedStartStates = phase === "recovery" ? new Set(["running", "evaluating"]) : new Set(["evaluating"]);
    if (!allowedStartStates.has(initialState)) return;
    const round = task.currentRound || 1;
    // New evaluation identity. Bumped before the prompt is built so the number
    // the Companion is told to echo is the one every later read expects, and
    // the previous attempt's handled marker no longer matches.
    const evaluationAttempt = (task.companionEvaluationAttempt || 0) + 1;
    task.companionEvaluationAttempt = evaluationAttempt;
    const refreshEvaluation = (): boolean =>
      refresh(new Set([initialState])) && task.companionEvaluationAttempt === evaluationAttempt;

    // TASK.md is re-read on EVERY evaluation: an attached task's in-memory
    // description is always empty, and manual brief edits / appended user
    // clarifications only ever land on disk. A cached copy would quote an
    // empty brief to the evaluator.
    const [gitContext, captured, taskMd] = await Promise.all([
      getGitContext(current.cwd, { execCommand, log }),
      readCaptureFiles(current.cwd, task.taskId),
      readTaskMd(current.cwd, task.taskId),
    ]);
    if (!refreshEvaluation()) return;
    const previousFindingIds = this.#collectPreviousCompanionFindingIds(task);

    const prompt = await buildCompanionPrompt({
      task,
      phase,
      round,
      evaluationAttempt,
      taskMd,
      contextMd: captured.contextMd,
      handoffMd: captured.handoffMd,
      gitContext,
      cwd: current.cwd,
      verification,
      previousFindingIds,
    });
    if (!refreshEvaluation()) return;

    // Evidence ledger for the completion floor: record what this evaluation was
    // actually given, so the verdict's verificationReview can be checked against
    // reality instead of taken at its word (see #handleCompanionVerdict).
    task.companionEvidence = verification
      ? { status: verification.status, mtimeIso: verification.mtimeIso, round: verification.round }
      : { status: "not-provided", mtimeIso: null, round: null };

    const judgeSessionId = sessionIdFor(current, "judge");
    task.judgeNudged = false;
    // A fresh evaluation gets a fresh repair budget — a rejection carried over
    // from the previous one must not pause this evaluation on its first slip.
    task.companionRepairAttempts = 0;
    task.companionRepairFingerprint = undefined;
    task.companionPhase = phase;
    task.companionVerdictHandledAttempt = undefined;
    await clearVerdict(current.cwd, task.taskId);
    if (!refreshEvaluation()) return;
    if (!(await this.#clearSessionContext(judgeSessionId, current))) return;
    if (!refreshEvaluation()) return;
    if (!(await this.#injectPrompt(judgeSessionId, prompt, current))) return;
    if (!refreshEvaluation()) return;
    this.#setTaskState(task, "judge-evaluating");
    log.info("companion evaluation requested", { workspaceId, phase, round, evaluationAttempt });
    void this.#logTaskEvent(
      current,
      "companion-requested",
      `${phase} evaluation requested (round ${round}, attempt ${evaluationAttempt}).`,
    );
    this.#broadcastState!();
  }

  /** Attached counterpart to #handleJudgeVerdict — mode-aware parser, third
   * "needs-input" outcome, and Companion-specific feedback prompt. */
  async #handleCompanionVerdict(
    initialWorkspace: TaskWorkspaceState,
    source = "manual",
    operation?: TaskOperationContext,
  ): Promise<void> {
    let workspace = initialWorkspace;
    const parentOperation = operation;
    const taskOperation = this.#captureTaskOperation(workspace, `companion-verdict:${source}`, {
      round: true,
      evaluationAttempt: true,
    });
    let task = workspace.task;
    const refresh = (states?: ReadonlySet<string>, expectedRefusal?: ExpectedTaskOperationRefusal): boolean => {
      const fresh = this.#currentTaskOperation(taskOperation, states, { expectedRefusal });
      if (!fresh || (parentOperation && !this.#currentTaskOperation(parentOperation, states, { expectedRefusal }))) {
        return false;
      }
      workspace = fresh;
      task = fresh.task;
      return true;
    };
    if (!refresh(new Set(["judge-evaluating"]))) return;
    const workspaceId = taskOperation.workspaceId;
    const judgeSessionId = sessionIdFor(workspace, "judge");
    const isIdlePromptOnly = source.includes("idle_prompt") || source.includes("notification");
    const round = task.currentRound || 1;
    const phase = task.companionPhase || "baseline";
    const role = task.companionRole || "reviewer";
    const expected = this.#companionVerdictExpectation(task);
    // Only mentioned to the Companion when the runner actually tracks one, so a
    // task upgraded mid-evaluation never asks for a number it never handed out.
    const identity =
      expected.evaluationAttempt === undefined
        ? `role "${role}", phase "${phase}", round ${round}`
        : `role "${role}", phase "${phase}", round ${round}, evaluationAttempt ${expected.evaluationAttempt}`;

    // Concurrency guard. The `task.state !== "judge-evaluating"` check below
    // only rejects a SECOND handler that starts after the first one finished —
    // one that starts while the first is still awaiting disk sees the state
    // unchanged, and both go on to inject feedback and bump currentRound.
    //
    // Re-entry that UPGRADES the signal is coalesced rather than dropped: a
    // pass started by idle_prompt/notification is not a turn boundary and
    // returns without nudging, so discarding the hook:stop behind it leaves
    // the task in judge-evaluating with no event left to come. A re-entry of
    // equal authority is still dropped — replaying a second hook:stop behind
    // the nudge the first one just sent reads as "still nothing after the
    // nudge" and would pause the task on its own duplicate.
    const inFlightIdleOnly = this.#handlingCompanionVerdict.get(workspaceId);
    if (inFlightIdleOnly !== undefined) {
      const upgrade = inFlightIdleOnly && !isIdlePromptOnly;
      if (upgrade) this.#pendingCompanionVerdict.set(workspaceId, source);
      log.debug("handleCompanionVerdict already in flight — coalescing re-entry", {
        workspaceId,
        source,
        queued: upgrade,
      });
      return;
    }
    this.#handlingCompanionVerdict.set(workspaceId, isIdlePromptOnly);
    this.#companionVerdictOwners.set(workspaceId, taskOperation.id);

    try {
      const result = await readCompanionVerdict(workspace.cwd, task.taskId, expected, log);
      if (!refresh(new Set(["judge-evaluating"]))) return;

      if (result.status === "missing") {
        if (isIdlePromptOnly) return;
        // As in the standard loop: an idle after the user's own turn with the
        // Companion does not spend the nudge.
        if (!task.judgeNudged || this.#userInterjected(judgeSessionId)) {
          task.judgeNudged = true;
          const dir = taskDirRel(task.taskId);
          const nudge = `You MUST write your verdict to ${dir}/${VERDICT_FILE} now — a schemaVersion 1 JSON object with ${identity}. Write the file now.`;
          if (!(await this.#injectPrompt(judgeSessionId, nudge, workspace))) return;
          if (!refresh(new Set(["judge-evaluating"]))) return;
          void this.#logTaskEvent(
            workspace,
            "companion-nudged",
            "Verdict file missing — reminded Companion to write it.",
          );
          this.#broadcastState!();
          return;
        }
        if (this.#isSessionBusy?.(judgeSessionId)) return;
        log.warn("companion verdict file missing after nudge", { workspaceId, round });
        task.pausedFromState = "judge-evaluating";
        this.#setTaskState(task, "paused");
        void this.#logTaskEvent(
          workspace,
          "companion-give-up",
          "Companion produced no verdict after nudge + Stop — pausing.",
        );
        this.#raiseTaskAlert(workspace, "failed", "Companion did not produce a verdict file");
        this.#broadcastState!();
        return;
      }

      if (result.status === "invalid" || result.status === "stale") {
        if (isIdlePromptOnly) return;
        // Only a verdict the Companion actually rewrote costs an attempt. The
        // same rejected bytes coming back means this is another idle signal for
        // the turn we already answered, not a second failed try.
        const fingerprint = result.raw ?? "";
        const attempts = task.companionRepairAttempts ?? 0;
        const alreadyAsked = task.companionRepairFingerprint === fingerprint;
        // The user talked to the Companion since our last request: this idle
        // may answer them, so ask again without charging an attempt.
        const userInterjected = this.#userInterjected(judgeSessionId);
        if (userInterjected || (!alreadyAsked && attempts < AgentTaskRunner.MAX_COMPANION_VERDICT_REPAIRS)) {
          task.judgeNudged = true;
          if (!userInterjected) task.companionRepairAttempts = attempts + 1;
          task.companionRepairFingerprint = fingerprint;
          const dir = taskDirRel(task.taskId);
          // A malformed verdict gets the field-level contract back. Bare zod
          // messages name the type but not the shape ("expected array, received
          // undefined"), which leaves rewriting it a second guess — the failure
          // that sent one Companion reading strideterm's own sources for the
          // schema. Staleness is a different problem: the shape was fine and
          // only the identity was wrong, so repeating the schema there is noise.
          const detail =
            result.status === "invalid"
              ? `Your verdict file is malformed: ${result.errors.join("; ") || "schema validation failed"}.

Rewrite ${dir}/${VERDICT_FILE} as a single JSON object matching this schema exactly — it is the contract the runner validates against, so do not go looking for it elsewhere:

--- BEGIN VERDICT SCHEMA (JSON Schema, role "${role}") ---
${companionVerdictContract(role)}
--- END VERDICT SCHEMA ---

Cross-field rules the schema above cannot express: "complete" needs empty blockingFindings, empty questions and empty verificationReview.workerActionsRequired; "continue" needs at least one blockingFinding and no questions; "needs-input" needs at least one question; role "planner" must never use "needs-input" and keeps "questions" empty (unresolved items go in roleAnalysis.openQuestions).`
              : `Your verdict file is for a different evaluation than the one requested. Its shape was fine — only the identity is wrong. Rewrite ${dir}/${VERDICT_FILE} with the same content and exactly ${identity}.`;
          // The stale variant is deliberately kept short. Anything over
          // FILE_PROMPT_THRESHOLD is injected as a "read PROMPT.md" pointer,
          // which writes into the watched task dir — needless churn for a nudge
          // whose whole content is four identity fields. The invalid variant
          // carries the schema and is worth that cost.
          const nudge = `${detail}

Write the corrected file, then stop.`;
          if (!(await this.#injectPrompt(judgeSessionId, nudge, workspace))) return;
          if (!refresh(new Set(["judge-evaluating"]))) return;
          void this.#logTaskEvent(
            workspace,
            "companion-verdict-repair",
            `Verdict ${result.status} — asked Companion to rewrite it (attempt ${task.companionRepairAttempts ?? 0}/${AgentTaskRunner.MAX_COMPANION_VERDICT_REPAIRS}).`,
          );
          this.#broadcastState!();
          return;
        }
        if (this.#isSessionBusy?.(judgeSessionId)) return;
        // Unchanged file + an idle Companion means it stopped without fixing
        // anything; an exhausted budget means it kept trying and kept failing.
        // Both are the end of the road for this evaluation.
        log.warn("companion verdict remained invalid/stale after repair request", {
          workspaceId,
          status: result.status,
          attempts,
          errors: result.errors.slice(0, 10),
        });
        task.pausedFromState = "judge-evaluating";
        this.#setTaskState(task, "paused");
        void this.#logTaskEvent(
          workspace,
          "companion-give-up",
          `Companion verdict remained ${result.status} after ${attempts} repair request(s) — pausing.`,
        );
        this.#raiseTaskAlert(workspace, "failed", `Companion verdict file is ${result.status}`);
        this.#broadcastState!();
        return;
      }

      // result.status === "valid"
      const verdict = result.data as CompanionVerdict;
      task.judgeNudged = false;
      task.companionRepairAttempts = 0;
      task.companionRepairFingerprint = undefined;
      if (task.state !== "judge-evaluating") {
        log.info("handleCompanionVerdict interrupted (state changed)", { workspaceId, taskState: task.state });
        return;
      }

      // Handled marker for the watcher backstop. Set here, where the verdict is
      // committed to, and NOT derived from lastRound.judgeVerdict below: that
      // field survives from the previous evaluation of the same round, so it
      // cannot distinguish "already processed" from "second evaluation of this
      // round, verdict still unread".
      task.companionVerdictHandledAttempt = task.companionEvaluationAttempt;

      const rounds = task.rounds as unknown as TaskRound[];
      const lastRound = rounds[rounds.length - 1];
      if (lastRound) {
        lastRound.judgeVerdict = verdict.verdict;
        lastRound.judgeReason = verdict.reason;
        lastRound.companionFindingIds = verdict.blockingFindings.map((f) => f.id);
      }
      // Anti-loop UX signal (plan §4.15): a blocker ID showing up in 3+ rounds
      // without being fixed gets a "Pause and review" hint on the Dashboard.
      // Purely advisory — the runner itself never auto-pauses or changes the
      // verdict because of this.
      const repeatCounts = new Map<string, number>();
      for (const r of rounds) {
        for (const id of new Set((r.companionFindingIds as string[] | undefined) || [])) {
          repeatCounts.set(id, (repeatCounts.get(id) || 0) + 1);
        }
      }
      task.repeatedBlockingFindingIds = [...repeatCounts.entries()].filter(([, count]) => count >= 3).map(([id]) => id);
      // Kept purely for Dashboard rendering (structured report, verification
      // card, role-specific summary) — never consulted by control flow, which
      // always re-reads verdict.json from disk.
      task.lastCompanionVerdict = verdict;
      log.info("companion verdict", { workspaceId, verdict: verdict.verdict, role, round });
      void this.#logTaskEvent(workspace, "companion-verdict", `Verdict: ${verdict.verdict}. ${verdict.reason}`);

      // Scoped to the NEXT round only (see the field's doc comment): re-derived
      // from every verdict rather than latched. Latching it on "not-required"
      // and clearing it only on "fresh" meant one such verdict disabled the
      // verification gate for the rest of the task — and because the gate is
      // what nudges Primary to produce a record, nothing could ever flip it
      // back to "fresh" on its own.
      task.verificationNotRequired = verdict.verificationReview.recordStatus === "not-required";

      const roleLabel = COMPANION_ROLE_DISPLAY_NAMES[role];

      // Completion floor, runtime half. The schema half only constrains what
      // the Companion *claims* in verificationReview.recordStatus — a baseline
      // is handed no record at all, so "fresh" there could be pure assertion.
      // Sign-off has to match the record the runner actually read from disk.
      const observedEvidence = task.companionEvidence?.status || "not-provided";
      if (
        verdict.verdict === "complete" &&
        COMPLETION_REQUIRES_FRESH_VERIFICATION.has(role) &&
        observedEvidence !== "fresh"
      ) {
        await this.#demandCompletionEvidence(workspace, verdict, observedEvidence);
        return;
      }

      if (verdict.verdict === "complete") {
        this.#setTaskState(task, "completed");
        if (lastRound) lastRound.action = "completed";
        log.info("attached task completed by companion verdict", { workspaceId, rounds: task.currentRound });
        void this.#logTaskEvent(workspace, "task-completed", verdict.reason);
        this.#raiseTaskAlert(workspace, "completed", `${roleLabel}: ${verdict.reason}`);
        this.#broadcastState!();
        return;
      }

      if (verdict.verdict === "needs-input") {
        task.pendingQuestions = verdict.questions.map((q) => ({
          id: q.id,
          question: q.question,
          whyNeeded: q.whyNeeded,
          options: q.options,
        }));
        this.#setTaskState(task, "awaiting-user");
        if (lastRound) lastRound.action = "needs-input";
        void this.#logTaskEvent(workspace, "companion-needs-input", verdict.reason);
        this.#raiseTaskAlert(workspace, "failed", `${roleLabel} needs your input: ${verdict.reason}`);
        this.#broadcastState!();
        return;
      }

      // "continue"
      if (verdict.reason) task.lastJudgeInstructions = verdict.reason;
      if (task.currentRound >= task.maxRounds) {
        this.#setTaskState(task, "failed");
        if (lastRound) lastRound.action = "failed";
        log.info("attached task failed: max rounds after companion review", { workspaceId, rounds: task.currentRound });
        void this.#logTaskEvent(workspace, "task-failed", `Max rounds after companion review. ${verdict.reason}`);
        this.#raiseTaskAlert(
          workspace,
          "failed",
          `Max rounds reached. ${roleLabel}: ${verdict.reason || "incomplete"}`,
        );
        this.#broadcastState!();
        return;
      }

      await this.#recreateWorkLock(workspace, "companionVerdict-continue");
      if (!refresh(new Set(["judge-evaluating"]))) return;
      // Template first, baseline second: the baseline is what the next
      // round-review compares the record's mtime against, and a template
      // written after it would beat it and pass as this round's evidence.
      await writeVerificationTemplate(workspace.cwd, task.taskId, task.currentRound + 1, log);
      if (!refresh(new Set(["judge-evaluating"]))) return;
      task.companionLastFeedbackAt = new Date().toISOString();
      const feedbackPrompt = buildCompanionFeedbackPrompt(task, verdict);
      const workerSessionId = sessionIdFor(workspace, "worker");
      // The Primary session is externally owned (plan §8.6) — unlike the
      // standard worker path, it is NEVER cleared between rounds. Clearing it
      // would wipe the user's live conversation, which the whole feature
      // exists to preserve.
      if (!(await this.#injectPrompt(workerSessionId, feedbackPrompt, workspace))) return;
      if (!refresh(new Set(["judge-evaluating"]))) return;
      this.#setTaskState(task, "running");
      const currentRound = this.#currentTaskRound(taskOperation, new Set(["running"]));
      if (currentRound) currentRound.round.action = "re-prompted";
      task.currentRound += 1;
      this.#ensureRunningRound(task);
      log.info("primary re-prompted with companion feedback", { workspaceId, round: task.currentRound });
      void this.#logTaskEvent(workspace, "primary-reprompted", `Companion feedback: ${verdict.reason}`);
      this.#broadcastState!();
    } catch (err: unknown) {
      if (!refresh(new Set(["judge-evaluating"]))) return;
      log.error("handleCompanionVerdict failed", { workspaceId, err: (err as Error)?.message });
      task.pausedFromState = "judge-evaluating";
      this.#setTaskState(task, "paused");
      // The handled marker may already be set for this attempt (it is stamped
      // before the mutations that can throw). Clear it so resuming re-runs the
      // verdict instead of the watcher backstop reading it as done.
      task.companionVerdictHandledAttempt = undefined;
      void this.#logTaskEvent(
        workspace,
        "companion-error",
        `Verdict handling failed: ${(err as Error)?.message || "unknown"}`,
      );
      this.#broadcastState!();
    } finally {
      const ownsVerdict = this.#companionVerdictOwners.get(workspaceId) === taskOperation.id;
      if (ownsVerdict) {
        this.#companionVerdictOwners.delete(workspaceId);
        this.#handlingCompanionVerdict.delete(workspaceId);
      }
      const pending = ownsVerdict ? this.#pendingCompanionVerdict.get(workspaceId) : undefined;
      // Consumed unconditionally — a signal that is no longer relevant (the
      // pass that just finished moved the task on) must not be replayed later.
      if (pending && ownsVerdict) this.#pendingCompanionVerdict.delete(workspaceId);
      // Same as the standard verdict's queued replay: this pass held the guard,
      // so if the task left judge-evaluating (or opened a new attempt) this
      // pass moved it there and the queued signal is moot.
      if (
        pending &&
        ownsVerdict &&
        refresh(new Set(["judge-evaluating"]), {
          reason: "verdict-pass-advanced-task",
          checks: TASK_ADVANCED_CHECKS,
        })
      ) {
        log.debug("replaying coalesced companion idle signal", { workspaceId, source: pending });
        // Caught here rather than left to the caller: this runs inside the
        // finally of a pass that already reported its own outcome.
        await this.#handleCompanionVerdict(workspace, pending, parentOperation).catch((err: unknown) => {
          log.error("coalesced handleCompanionVerdict replay failed", {
            workspaceId,
            err: (err as Error)?.message,
          });
        });
      }
    }
  }

  /**
   * A code-accepting role returned "complete", but the runner never handed
   * that evaluation a fresh VERIFICATION.md — typically a baseline (no record
   * exists yet) or a round the previous verdict declared "not-required".
   *
   * The review itself is kept: no blocking findings are invented and the round
   * is NOT consumed, because this is a missing-evidence gap, not a defect. The
   * Primary is asked to record the evidence for the CURRENT round; the next
   * round-review then evaluates it and can legitimately complete.
   */
  async #demandCompletionEvidence(
    initialWorkspace: TaskWorkspaceState,
    verdict: CompanionVerdict,
    observedEvidence: string,
    inheritedOperation?: TaskOperationContext,
  ): Promise<void> {
    let workspace = initialWorkspace;
    const operation =
      inheritedOperation ?? this.#captureTaskOperation(workspace, "completion-evidence", { round: true });
    let task = workspace.task;
    const refresh = (): boolean => {
      const fresh = this.#currentTaskOperation(operation, new Set(["judge-evaluating"]));
      if (!fresh) return false;
      workspace = fresh;
      task = fresh.task;
      return true;
    };
    if (!refresh()) return;
    const round = task.currentRound || 1;
    const roundRef = this.#currentTaskRound(operation, new Set(["judge-evaluating"]));
    if (roundRef) roundRef.round.action = "verification-required";

    await this.#recreateWorkLock(workspace, "completion-floor");
    if (!refresh()) return;
    // Same round resumes, so the template must be tagged for the round we are
    // staying in — same reasoning as the answerCompanionTask path. Written
    // before the baseline is stamped so the template can never clear the very
    // freshness gate this method exists to enforce.
    await writeVerificationTemplate(workspace.cwd, task.taskId, round, log);
    if (!refresh()) return;
    task.companionLastFeedbackAt = new Date().toISOString();
    if (
      !(await this.#injectPrompt(
        sessionIdFor(workspace, "worker"),
        buildCompletionEvidencePrompt(task, verdict),
        workspace,
      ))
    )
      return;
    if (!refresh()) return;
    this.#setTaskState(task, "running");

    log.info("companion completion withheld: no fresh verification evidence", {
      workspaceId: workspace.id,
      role: verdict.role,
      round,
      observedEvidence,
      claimedRecordStatus: verdict.verificationReview.recordStatus,
    });
    void this.#logTaskEvent(
      workspace,
      "completion-evidence-required",
      `${COMPANION_ROLE_DISPLAY_NAMES[verdict.role]} returned "complete" claiming recordStatus "${verdict.verificationReview.recordStatus}", but the evaluation was given ${observedEvidence === "not-provided" ? "no verification record" : `a ${observedEvidence} verification record`}. Asked Primary to record evidence for round ${round}; the round was not consumed.`,
    );
    this.#broadcastState!();
  }

  /**
   * Attached counterpart to #reconcileAfterResume — same priority ladder,
   * adapted for the Companion verdict schema and the externally-owned
   * Primary (no late-initial-prompt branch: the "initial prompt" for an
   * attached task is the one-time capture prompt, handled by
   * #startAttachedTask, not a resumable per-round send).
   */
  async #reconcileAttachedAfterResume(
    initialWorkspace: TaskWorkspaceState,
    { previousState, pausedFromState, resumeTo }: { previousState: string; pausedFromState: string; resumeTo: string },
    operation: TaskOperationContext,
  ): Promise<void> {
    let workspace = initialWorkspace;
    let task = workspace.task;
    const workspaceId = operation.workspaceId;
    const evaluationAttempt = task.companionEvaluationAttempt;
    let expectedStates: ReadonlySet<string> = new Set([resumeTo]);
    const refresh = (): boolean => {
      const fresh = this.#currentTaskOperation(operation, expectedStates);
      if (!fresh || fresh.task.companionEvaluationAttempt !== evaluationAttempt) return false;
      workspace = fresh;
      task = fresh.task;
      return true;
    };

    if (task.showerResumePrompt) {
      void this.#logTaskEvent(
        workspace,
        "task-resumed-reconcile",
        "Recovery prompt pending — deferring to recovery idle path.",
      );
      return;
    }

    const round = task.currentRound || 1;
    if (
      task.state === "judge-evaluating" ||
      resumeTo === "judge-evaluating" ||
      pausedFromState === "judge-evaluating"
    ) {
      const result = await readCompanionVerdict(
        workspace.cwd,
        task.taskId,
        this.#companionVerdictExpectation(task),
        log,
      );
      if (!refresh()) return;
      if (result.status === "valid") {
        if (task.state !== "judge-evaluating") this.#setTaskState(task, "judge-evaluating");
        expectedStates = new Set(["judge-evaluating"]);
        this.#broadcastState!();
        await this.#handleCompanionVerdict(workspace, "resume-reconcile", operation);
        return;
      }
      task.judgeNudged = false;
      if (task.state !== "judge-evaluating") this.#setTaskState(task, "judge-evaluating");
      expectedStates = new Set(["judge-evaluating"]);
      this.#broadcastState!();
      const prompt = buildAttachedCompanionRecoveryPrompt(task, round);
      if (!refresh()) return;
      await this.#injectPrompt(sessionIdFor(workspace, "judge"), prompt, workspace);
      if (!refresh()) return;
      return;
    }

    if (previousState === "completed" || previousState === "failed" || previousState === "awaiting-user") {
      void this.#logTaskEvent(workspace, "task-resumed-reconcile", `Resumed ${previousState}; awaiting user.`);
      return;
    }

    if (task.state === "capturing-context") {
      if (!refresh()) return;
      await this.#checkCaptureReadiness(workspace, sessionIdFor(workspace, "worker"), operation);
      return;
    }

    if (task.state === "running") {
      if (!refresh()) return;
      await this.#evaluateCompanionRound(workspace, operation);
      return;
    }
    void this.#logTaskEvent(workspace, "task-resumed-reconcile", `Resumed to ${resumeTo}; nothing to reconcile.`);
  }

  /** An answer to this task is still being delivered — answerCompanionTask refuses another. */
  isCompanionAnswerInFlight(workspaceId: string): boolean {
    return this.#answersInFlight.has(workspaceId);
  }

  /**
   * Explicit answer action for an attached task in `awaiting-user`
   * (plan §8.5). Appends the clarification to TASK.md as authoritative
   * scope BEFORE injecting anything into Primary, then resumes the SAME
   * round — a needs-input pause never consumes a round.
   */
  async answerCompanionTask(workspaceId: string, questionIds: string[], answer: string): Promise<boolean> {
    // One answer at a time: a second one would supersede the first delivery
    // and append a second clarification to TASK.md.
    if (this.#answersInFlight.has(workspaceId)) {
      log.warn("answerCompanionTask: an answer is already being delivered", { workspaceId });
      const workspace = this.#findTaskWorkspace(workspaceId);
      if (workspace) {
        void this.#logTaskEvent(
          workspace,
          "companion-answer-rejected",
          "Your previous answer is still on its way to the Primary conversation — it goes in as soon as the panel is free.",
        );
      }
      return false;
    }
    this.#answersInFlight.add(workspaceId);
    const answering = this.#answerCompanionTask(workspaceId, questionIds, answer).finally(() =>
      this.#answersInFlight.delete(workspaceId),
    );
    return this.#runUserAction(
      workspaceId,
      "answerCompanionTask",
      answering,
      (state) =>
        `Your answer did not reach the Primary conversation (the task is now ${state}). The questions stay open — answer again.`,
    );
  }

  async #answerCompanionTask(workspaceId: string, questionIds: string[], answer: string): Promise<boolean> {
    let workspace = this.#findTaskWorkspace(workspaceId);
    if (!workspace) return false;
    const task = workspace.task;
    const taskId = task.taskId;
    if (task.mode !== "attached" || task.state !== "awaiting-user") {
      log.warn("answerCompanionTask: task not awaiting-user", { workspaceId, state: task.state, mode: task.mode });
      return false;
    }
    if (!this.#assertAttachedPrimaryAvailable(workspace, "Send decision")) return false;
    const pending = task.pendingQuestions || [];
    // All-or-nothing: answering resumes the round, and the Dashboard only ever
    // renders questions in "awaiting-user", so a partially answered round would
    // leave the rest pending with no surface left to answer them on. One answer
    // covers the whole round's questions (which is also all the UI can send).
    const answeredIds = new Set(questionIds);
    const coversAll = pending.length > 0 && pending.every((q) => answeredIds.has(q.id));
    if (!coversAll) {
      log.warn("answerCompanionTask: answer does not cover every pending question", {
        workspaceId,
        questionIds,
        pendingIds: pending.map((q) => q.id),
      });
      void this.#logTaskEvent(
        workspace,
        "companion-answer-rejected",
        `An answer must address every open question of this round (${pending.map((q) => q.id).join(", ") || "none pending"}).`,
      );
      return false;
    }
    const trimmed = String(answer || "").trim();
    if (!trimmed) return false;

    this.#advanceTaskLifecycle(workspaceId, "companion-answer");
    workspace = this.#findTaskWorkspace(workspaceId);
    if (!workspace || workspace.task.taskId !== taskId || workspace.task.state !== "awaiting-user") return false;
    const operation = this.#captureTaskOperation(workspace, "companion-answer", { round: true });
    const roundNumber = workspace.task.currentRound || 1;
    const answeredPending = (workspace.task.pendingQuestions || []).map((question) => ({ ...question }));
    const refresh = (): boolean => {
      const fresh = this.#currentTaskOperation(operation, new Set(["awaiting-user"]));
      if (!fresh) return false;
      workspace = fresh;
      return true;
    };
    const now = new Date().toISOString();
    try {
      await appendUserClarification(
        workspace.cwd,
        operation.taskId,
        { timestamp: now, questionIds: answeredPending.map((q) => q.id), answer: trimmed },
        log,
      );
      if (!refresh()) return false;
    } catch (err: unknown) {
      if (!refresh()) return false;
      log.error("answerCompanionTask: failed to append clarification to TASK.md", {
        workspaceId,
        err: (err as Error)?.message,
      });
      return false;
    }

    // Same round resumes, so the Primary owes a verification record tagged for
    // the CURRENT round — the "continue" path hands it a template for round+1,
    // this one has to hand it a template for the round we're staying in, or the
    // freshness gate would reject whatever is on disk and burn a nudge cycle.
    // Template before baseline, so the template itself stays older than the
    // baseline and can't pass as the record. Re-stamped here rather than reusing
    // `now` (taken before the clarification was appended) for the same reason —
    // a baseline older than the template it guards gates nothing.
    if (!refresh()) return false;
    await writeVerificationTemplate(workspace.cwd, operation.taskId, roundNumber, log);
    if (!refresh()) return false;
    const currentTask = workspace.task;
    currentTask.companionLastFeedbackAt = new Date().toISOString();
    await this.#recreateWorkLock(workspace, "companion-answer");
    if (!refresh()) return false;
    const prompt = buildCompanionAnswerPrompt(workspace.task, answeredPending, trimmed);
    const workerSessionId = sessionIdFor(workspace, "worker");
    try {
      if (!(await this.#injectPrompt(workerSessionId, prompt, workspace))) {
        if (this.#onlySessionsChanged(operation, new Set(["awaiting-user"]))) {
          // The Primary's session went away under the delivery; the task is
          // still waiting for this answer.
          log.error("answerCompanionTask: the Primary session ended before the answer went in", { workspaceId });
          const current = this.#findTaskWorkspace(workspaceId);
          if (current) {
            void this.#logTaskEvent(
              current,
              "companion-answer-failed",
              "Could not deliver the answer — the Primary conversation's session ended. The question is still open, answer again.",
            );
          }
        }
        return false;
      }
      if (!refresh()) return false;
    } catch (err: unknown) {
      if (!refresh()) return false;
      // Everything that would strand the user is deferred until the Primary has
      // actually received the answer: the questions stay pending and the task
      // stays awaiting-user, so the Dashboard can retry. Re-answering is safe —
      // appendUserClarification and #recreateWorkLock are both idempotent.
      log.error("answerCompanionTask: failed to inject answer prompt", { workspaceId, err: (err as Error)?.message });
      void this.#logTaskEvent(
        workspace,
        "companion-answer-failed",
        "Could not deliver the answer to the Primary conversation — the question is still open, try again.",
      );
      this.#broadcastState!();
      return false;
    }
    // Every question of this round was covered (checked above), so the queue is
    // empty — cleared only after the Primary actually received the answer.
    workspace.task.pendingQuestions = [];
    const roundRef = this.#currentTaskRound(operation, new Set(["awaiting-user"]));
    if (roundRef) roundRef.round.action = "user-answered";
    this.#setTaskState(workspace.task, "running");
    log.info("answerCompanionTask: answer injected, resuming same round", {
      workspaceId,
      round: workspace.task.currentRound,
      answered: questionIds.length,
    });
    void this.#logTaskEvent(workspace, "user-clarification", `Answered: ${trimmed}`);
    this.#broadcastState!();
    return true;
  }

  async #runProgrammaticCopilotJudge(workspace: TaskWorkspaceState, prompt: string): Promise<ExecResult> {
    const task = workspace.task;
    const operation = this.#captureTaskOperation(workspace, "programmatic-copilot-judge", { round: true });
    const promptPath = path.join(taskDir(workspace.cwd, task.taskId), COPILOT_PROGRAMMATIC_JUDGE_PROMPT_FILE);
    await writeFile(promptPath, prompt, "utf8");
    const fresh = this.#currentTaskOperation(operation, new Set(["judge-evaluating"]));
    if (!fresh) return { exitCode: -1, stdout: "", stderr: "" };
    const command = buildProgrammaticCopilotJudgeCommand({
      promptPath,
      cwd: fresh.cwd,
      model: fresh.task.judgeProviderConfig?.model,
    });
    log.info("running programmatic Copilot judge", {
      workspaceId: fresh.id,
      taskId: fresh.task.taskId,
      promptPath: COPILOT_PROGRAMMATIC_JUDGE_PROMPT_FILE,
      model: fresh.task.judgeProviderConfig?.model || "",
    });
    return execCommand(command, fresh.cwd, COPILOT_PROGRAMMATIC_JUDGE_TIMEOUT_MS);
  }

  /**
   * Remove task files for a workspace. Called when a task workspace is deleted.
   */
  async cleanupTaskFiles(cwd: string, taskId: string): Promise<void> {
    await cleanupTaskFilesImpl(cwd, taskId, log);
  }

  // ---------------------------------------------------------------------------
  // Shower mode — periodic worker context refresh
  // ---------------------------------------------------------------------------

  /**
   * Check if the worker is due for a shower (context refresh).
   * Returns true when enough rounds have elapsed since last shower.
   */
  #shouldShower(task: RuntimeTaskState): boolean {
    const interval = task.showerInterval ?? DEFAULT_SHOWER_INTERVAL;
    if (interval <= 0) return false; // Disabled
    const roundsSinceShower = task.currentRound - (task.lastShowerRound || 0);
    return roundsSinceShower >= interval;
  }

  /**
   * Perform a shower: ask worker to write handoff summary, restart session
   * with fresh context seeded from the handoff file.
   *
   * Inspired by codex-runner's shower mode — prevents context degradation
   * in long-running agent sessions.
   *
   * Flow:
   *  1. Write handoff request to file
   *  2. Inject short directive: "write handoff summary"
   *  3. Wait for handoff file (with timeout)
   *  4. Kill worker session, restart fresh
   *  5. Inject resume prompt with handoff context + last judge instructions
   */
  async #performShower(workspace: TaskWorkspaceState): Promise<boolean> {
    const operation = this.#captureTaskOperation(workspace, "worker-shower", { round: true });
    const initialWorkspace = this.#currentTaskOperation(operation, new Set(["refreshing"]));
    if (!initialWorkspace) return false;
    let task = initialWorkspace.task;
    const workspaceId = initialWorkspace.id;
    const workerSessionId = sessionIdFor(initialWorkspace, "worker");
    const dir = taskDir(initialWorkspace.cwd, task.taskId);
    const relDir = taskDirRel(task.taskId);

    log.info("shower mode: starting worker context refresh", {
      workspaceId,
      round: task.currentRound,
      lastShower: task.lastShowerRound || 0,
    });

    // Step 1: Write handoff request instructions to file
    const handoffRequestPath = path.join(dir, "SHOWER_REQUEST.md");
    const handoffPath = path.join(dir, HANDOFF_FILE);
    const handoffRequest = `# Handoff Request

Write a concise handoff summary to \`${relDir}/${HANDOFF_FILE}\` now.

Include:
1. What you have accomplished so far
2. What remains to be done (reference ${relDir}/TODO.md)
3. Key decisions or context a fresh session would need
4. Any blockers or issues encountered

Use \`cat > ${relDir}/${HANDOFF_FILE} <<'HANDOFF_EOF'\` to write the file.
After writing the file, stop and wait.

Do NOT continue working on the task — only write the handoff summary.`;

    try {
      await writeFile(handoffRequestPath, handoffRequest, "utf8");
    } catch (err: unknown) {
      log.error("shower mode: failed to write handoff request", { workspaceId, err: (err as Error)?.message });
      return false;
    }
    const afterRequestWrite = this.#currentTaskOperation(operation, new Set(["refreshing"]));
    if (!afterRequestWrite) return false;

    // Step 2: Inject short directive to worker.
    // Krok 11 — route through #injectPrompt so the directive uses the
    // per-provider injection strategy and the verified submit + retry (Krok 1),
    // instead of a raw write + fixed 200ms Enter that can drop the Enter.
    const directive = `Read ${relDir}/SHOWER_REQUEST.md and follow it now. Write the handoff summary to ${relDir}/${HANDOFF_FILE}. After the file is written, stop and wait.`;
    if (!(await this.#injectPrompt(workerSessionId, directive, afterRequestWrite))) return false;
    if (!this.#currentTaskOperation(operation, new Set(["refreshing"]))) return false;

    log.debug("shower mode: handoff directive sent, waiting for handoff file", { workspaceId });

    // Step 3: Wait for handoff file (poll with timeout)
    const injection = this.#injectionAbortControllers.get(workerSessionId);
    const handoffWritten = await waitForFile(handoffPath, 120_000); // 2 min timeout
    const afterHandoffWait = this.#currentTaskOperation(operation, new Set(["refreshing"]));
    if (!afterHandoffWait || !injection || !this.#isCurrentInjection(workerSessionId, injection)) {
      return false;
    }
    if (!handoffWritten) {
      log.warn("shower mode: handoff file not written within timeout, skipping shower", { workspaceId });
      // Clean up request file
      await rm(handoffRequestPath, { force: true }).catch(() => {});
      return false;
    }

    log.info("shower mode: handoff file detected, restarting worker session", { workspaceId });

    // Step 4: Restart worker session
    if (!this.#restartSession) {
      log.warn("shower mode: restartSession not available, skipping", { workspaceId });
      return false;
    }
    // The user may be talking to the Worker: the restart would cut them off
    // mid-turn. Let them finish (and get their answer) first — never a pause.
    if (
      this.#politeWaitReason(workerSessionId) !== null &&
      !(await this.#awaitPoliteWindow(workerSessionId, injection))
    ) {
      return false;
    }

    try {
      await this.#restartTaskSession(workerSessionId);
      if (!this.#currentTaskOperation(operation, new Set(["refreshing"]))) return false;
      log.info("shower mode: worker session restarted", { workspaceId });
    } catch (err: unknown) {
      if (!this.#currentTaskOperation(operation, new Set(["refreshing"]))) return false;
      log.error("shower mode: failed to restart worker session", { workspaceId, err: (err as Error)?.message });
      return false;
    }

    // Step 5: Build and inject resume prompt with handoff context
    let handoffContent = "";
    try {
      handoffContent = await readFile(handoffPath, "utf8");
    } catch (err: unknown) {
      if (!this.#currentTaskOperation(operation, new Set(["refreshing"]))) return false;
      log.warn("shower mode: could not read handoff file after restart", { workspaceId, err: (err as Error)?.message });
    }
    const afterHandoffRead = this.#currentTaskOperation(operation, new Set(["refreshing"]));
    if (!afterHandoffRead) return false;
    task = afterHandoffRead.task;

    const resumePrompt = this.#buildShowerResumePrompt(task, handoffContent);

    // Write the resume prompt to the worker's prompt file — it will be
    // injected via file-based prompt when the new session goes idle
    // (promptSent is reset below). Shower only ever refreshes the worker.
    const promptFilePath = path.join(dir, promptFileFor("worker"));
    try {
      await writeFile(promptFilePath, resumePrompt, "utf8");
      log.debug("shower mode: resume prompt written to file", { workspaceId, promptLength: resumePrompt.length });
    } catch (err: unknown) {
      if (!this.#currentTaskOperation(operation, new Set(["refreshing"]))) return false;
      log.warn("shower mode: failed to write resume prompt file", { workspaceId, err: (err as Error)?.message });
    }
    if (!this.#currentTaskOperation(operation, new Set(["refreshing"]))) return false;

    // Wait briefly for the new session to be ready before injecting
    await new Promise((resolve) => setTimeout(resolve, 2000));
    const beforeCommit = this.#currentTaskOperation(operation, new Set(["refreshing"]));
    if (!beforeCommit) return false;
    task = beforeCommit.task;

    // Store the resume prompt so the next onAgentIdle sends it instead of the initial prompt
    task.showerResumePrompt = resumePrompt;
    task.lastShowerRound = task.currentRound;
    task.promptSent = false; // Reset — triggers prompt injection on next idle

    // Clean up ephemeral shower files
    if (!this.#currentTaskOperation(operation, new Set(["refreshing"]))) return false;
    await rm(handoffRequestPath, { force: true }).catch(() => {});

    const completed = this.#currentTaskOperation(operation, new Set(["refreshing"]));
    if (!completed) return false;
    log.info("shower mode: context refresh complete", {
      workspaceId,
      round: completed.task.currentRound,
      handoffLength: handoffContent.length,
    });

    return true;
  }

  /**
   * Build the prompt for a worker session that was just restarted via shower mode.
   * Includes task description, handoff context, and last judge instructions.
   */
  #buildShowerResumePrompt(task: RuntimeTaskState, handoffContent: string): string {
    const dir = taskDirRel(task.taskId);
    const parts = [
      `You are the worker in a supervised coding loop (session refreshed for context clarity).`,
      "",
      `Task:\n${task.description ? fenceUserInput(task.description) : "(See " + dir + "/" + TASK_FILE + ")"}`,
      "",
      "## Handoff from previous session",
      "",
      handoffContent || "(No handoff summary available — read the task files to catch up.)",
      "",
    ];

    if (task.lastJudgeInstructions) {
      parts.push("## Last judge feedback", "", task.lastJudgeInstructions, "");
    }

    parts.push(
      "## Rules",
      `- **Commit your changes** regularly with clear commit messages. The judge reviews git diffs. Do NOT push.`,
      `- Read and obey \`${dir}/${TODO_FILE}\` and \`${dir}/${WORK_LOCK_FILE}\`.`,
      `- Ignore \`${dir}/${JUDGE_TODO_FILE}\` — that file belongs to the judge.`,
      `- Continue working from where the previous session left off.`,
      `- Update \`${dir}/${TODO_FILE}\` as you make progress.`,
      `- Before finishing, complete the verification checklist in \`${dir}/${TASK_FILE}\`.`,
      `- Remove \`${dir}/${WORK_LOCK_FILE}\` only when you have verified everything passes.`,
      `- Do not ask the human whether you should continue. The judge decides that.`,
      `- When you are done, simply stop. A judge will independently verify your work.`,
    );

    return parts.join("\n");
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  #findTaskWorkspace(workspaceId: string): TaskWorkspaceState | null {
    const state = this.#getState?.();
    if (!state) return null;
    const workspace = state.workspaces.find((w) => w.id === workspaceId);
    if (!workspace || !isTaskWorkspace(workspace)) return null;
    return workspace;
  }

  /**
   * Resolve a raw `${workspaceId}:${panelId}` session id to the task
   * workspace/role that owns it. Every hook/lifecycle entry point that only
   * receives a bare sessionId (onAgentIdle, onUserInput, onSessionExit,
   * getIdleTimeout, rate-limit handlers) must go through this instead of
   * re-deriving `#findTaskWorkspace(workspaceId)` + inline panelId
   * comparisons — see plan §8.2 "Binding resolver".
   *
   * Standard tasks: identical fast path to the old inline logic (the session
   * lives IN the task workspace it names). Attached tasks: the worker/
   * "Primary" role lives in a DIFFERENT workspace than the one that owns the
   * Companion loop, so a miss on the fast path falls back to scanning active
   * attached task workspaces bound to this exact external session.
   */
  #resolveTaskBinding(sessionId: string): TaskBinding | null {
    const parts = sessionId.split(":");
    if (parts.length < 2) return null;
    const workspaceId = parts.slice(0, -1).join(":");
    const panelId = parts[parts.length - 1];

    const direct = this.#findTaskWorkspace(workspaceId);
    if (direct) {
      const task = direct.task;
      if (panelId === task.judgePanelId) return { workspace: direct, task, role: "judge" };
      if (task.mode !== "attached" && panelId === task.workerPanelId) {
        return { workspace: direct, task, role: "worker" };
      }
      return null;
    }

    const state = this.#getState?.();
    if (!state) return null;
    const candidates: TaskWorkspaceState[] = [];
    for (const w of state.workspaces) {
      if (!isTaskWorkspace(w)) continue;
      if (w.task.mode !== "attached") continue;
      if (w.task.workerWorkspaceId !== workspaceId) continue;
      if (w.task.workerPanelId !== panelId) continue;
      candidates.push(w);
    }
    if (candidates.length === 0) return null;
    // Creation-time guard (createCompanionTask) prevents more than one active
    // binding per source session; if a stale/terminal duplicate still exists
    // on disk, prefer the most recently created active one so a lookup never
    // silently picks an already-finished companion loop.
    const active = candidates.filter((w) => w.task.state !== "completed" && w.task.state !== "failed");
    const pool = active.length > 0 ? active : candidates;
    pool.sort((a, b) => (b.task.createdAt || "").localeCompare(a.task.createdAt || ""));
    const chosen = pool[0]!;
    return { workspace: chosen, task: chosen.task, role: "worker" };
  }

  /**
   * Send /clear to an agent session to reset its conversation context.
   * Returns a promise that resolves after a short delay to allow the
   * command to be processed before injecting the next prompt.
   *
   * Like every runner write it waits for the user (see #awaitPoliteWindow).
   * The prompt that follows in the same injection re-sends /clear when the
   * user talks to the agent in between (see #needsReclear), so a Judge still
   * evaluates from a clean context after the user's own Q&A.
   */
  async #clearSessionContext(sessionId: string, workspace: TaskWorkspaceState): Promise<boolean> {
    this.#deliveriesInFlight.set(sessionId, (this.#deliveriesInFlight.get(sessionId) ?? 0) + 1);
    try {
      return await this.#clearSessionContextNow(sessionId, workspace);
    } finally {
      const remaining = (this.#deliveriesInFlight.get(sessionId) ?? 1) - 1;
      if (remaining > 0) this.#deliveriesInFlight.set(sessionId, remaining);
      else this.#deliveriesInFlight.delete(sessionId);
    }
  }

  async #clearSessionContextNow(sessionId: string, workspace: TaskWorkspaceState): Promise<boolean> {
    if (!this.#writeToSession) return true;
    if (this.#disposed) return false;
    const generation = this.#beginSessionInjection(sessionId, workspace);
    if (!generation) return false;
    const signal = generation.signal;
    const strategy = this.#resolveInjectionStrategy(sessionId, workspace);
    log.debug("clearing session context", {
      sessionId,
      style: strategy.style,
      clearSettleMs: strategy.clearSettleMs,
    });
    await this.#writeAndSubmit(sessionId, "/clear", strategy, generation, signal, { startsTurn: false });
    if (!this.#isCurrentInjection(sessionId, generation)) return false;
    const activity = this.#activityFor(sessionId);
    activity.clearGeneration = generation;
    activity.clearedAt = Date.now();
    if (strategy.clearSettleMs > 0) {
      if (!(await this.#waitForInjectionDelay(sessionId, generation, strategy.clearSettleMs))) return false;
    }
    return true;
  }

  /**
   * Inject a prompt into a PTY session. For short prompts (< FILE_PROMPT_THRESHOLD
   * chars) paste directly. For longer prompts, write to a file and send a short
   * directive — more reliable and avoids PTY paste issues with large text.
   *
   * Inspired by codex-runner's pattern of writing prompts to files and injecting
   * "Read {file} and follow it now" directives via tmux send_keys.
   */
  async #injectPrompt(sessionId: string, text: string, workspace: TaskWorkspaceState | null): Promise<boolean> {
    this.#deliveriesInFlight.set(sessionId, (this.#deliveriesInFlight.get(sessionId) ?? 0) + 1);
    try {
      return await this.#injectPromptNow(sessionId, text, workspace);
    } finally {
      const remaining = (this.#deliveriesInFlight.get(sessionId) ?? 1) - 1;
      if (remaining > 0) this.#deliveriesInFlight.set(sessionId, remaining);
      else this.#deliveriesInFlight.delete(sessionId);
    }
  }

  async #injectPromptNow(sessionId: string, text: string, workspace: TaskWorkspaceState | null): Promise<boolean> {
    if (!this.#writeToSession || this.#disposed) {
      log.warn("injectPrompt: writeToSession not available", { sessionId });
      return false;
    }

    const generation = this.#beginSessionInjection(sessionId, workspace);
    if (!generation) return false;
    const injectionSignal = generation.signal;

    // Remember the last thing we told this session so the manual "Resend"
    // buttons and the dropout auto-restart can re-send it verbatim.
    this.#lastInjected.set(sessionId, text);

    // Krok 9c — stamp the worker inject time so onAgentIdle can measure how long
    // the next worker turn lasts (the short-turn rate-limit heuristic).
    if (workspace?.task && sessionId === sessionIdFor(workspace, "worker")) {
      this.#workerInjectAt.set(workspace.id, Date.now());
    }

    let injection = text;

    // File-based injection for long prompts. The file is per role — see
    // promptFileFor: the agent reads it on its own schedule, so a shared one
    // could be replaced by the other role's prompt before the read landed.
    if (text.length > FILE_PROMPT_THRESHOLD && workspace?.cwd && workspace?.task?.taskId) {
      const promptFile = promptFileFor(sessionId === sessionIdFor(workspace, "judge") ? "judge" : "worker");
      const promptPath = path.join(taskDir(workspace.cwd, workspace.task.taskId), promptFile);
      const relPromptPath = `${taskDirRel(workspace.task.taskId)}/${promptFile}`;
      try {
        await writeFile(promptPath, text, { encoding: "utf8", signal: injectionSignal });
        if (!this.#isCurrentInjection(sessionId, generation)) return false;
        injection = `Read ${relPromptPath} and follow the instructions in it now.`;
        log.info("prompt written to file for injection", {
          sessionId,
          promptPath: relPromptPath,
          originalLength: text.length,
        });
      } catch (err: unknown) {
        if (!this.#isCurrentInjection(sessionId, generation)) return false;
        // Fall back to direct paste if file write fails
        log.warn("failed to write prompt file, falling back to direct paste", {
          sessionId,
          promptPath,
          err: (err as Error)?.message,
        });
      }
    }

    // Look up per-provider injection style and timings. Ink-based TUIs
    // (GitHub Copilot) need "type" style — streaming chars one at a time
    // bypasses paste detection that would otherwise swallow the trailing \r.
    const strategy = this.#resolveInjectionStrategy(sessionId, workspace);
    log.trace("injectPrompt: writing to PTY", {
      sessionId,
      length: injection.length,
      fileBased: injection !== text,
      style: strategy.style,
      submitDelayMs: strategy.submitDelayMs,
      typingGapMs: strategy.typingGapMs,
    });
    const writeOptions = { reclear: true, startsTurn: true };

    // Krok 1 — verified injection. Hook-capable providers (Claude Code) confirm
    // a submitted prompt by firing UserPromptSubmit; we wait for it and re-send
    // Enter if it doesn't arrive (the "Enter sat in the composer unsubmitted"
    // failure from incident A). Providers without hooks keep today's
    // fire-and-forget behaviour (no wait, no retry).
    const hookCapable = this.#isSessionHookCapable?.(sessionId) ?? false;
    if (!hookCapable) {
      await this.#writeAndSubmit(sessionId, injection, strategy, generation, injectionSignal, writeOptions);
      if (!this.#isCurrentInjection(sessionId, generation)) return false;
      log.debug("prompt injected (unverified — no hooks)", {
        sessionId,
        length: injection.length,
        originalLength: text.length,
        style: strategy.style,
      });
      return true;
    }

    let rewrites = 0;
    for (;;) {
      // The confirmation clock starts when the text actually goes in — after any
      // polite wait, and afresh for a restarted write — so waiting for the user
      // never reads as a lost Enter.
      let confirmation: { promise: Promise<boolean>; cancel: () => void } | null = null;
      await this.#writeAndSubmit(sessionId, injection, strategy, generation, injectionSignal, {
        ...writeOptions,
        beforeWrite: () => {
          confirmation?.cancel();
          confirmation = this.#startSubmitConfirmation(sessionId, AgentTaskRunner.SUBMIT_CONFIRM_TIMEOUT_MS);
        },
      });
      const firstConfirmation = confirmation as { promise: Promise<boolean> } | null;
      if (!this.#isCurrentInjection(sessionId, generation) || !firstConfirmation) return false;
      const outcome = await this.#awaitSubmitConfirmation(
        sessionId,
        generation,
        firstConfirmation.promise,
        injection,
        strategy,
      );
      if (outcome === "rewrite") {
        rewrites += 1;
        if (rewrites <= AgentTaskRunner.MAX_UNCONFIRMED_REWRITES) continue;
        log.warn("injectPrompt: still unconfirmed after rewriting the prompt — assuming it went in", {
          sessionId,
          rewrites,
          ...this.#politeLogContext(sessionId),
        });
        return true;
      }
      if (outcome !== "unconfirmed") return outcome === "confirmed";
      break;
    }
    const MAX_RESUBMITS = AgentTaskRunner.MAX_RESUBMITS;
    log.warn("injectPrompt: submit unconfirmed after retries", { sessionId });
    if (workspace) {
      void this.#logTaskEvent(
        workspace,
        "prompt-submit-unconfirmed",
        `Provider did not confirm prompt submission for ${sessionId.split(":").pop()} after ${MAX_RESUBMITS} re-sends.`,
      );
    }
    return true;
  }

  /**
   * Hook-capable providers: wait for UserPromptSubmit after our Enter, and
   * re-send Enter if it does not come — unless the user has typed into the
   * session since, because that Enter would submit THEIR text. Then the
   * outcome is settled with them (see #settleUnconfirmedSubmit), never just
   * assumed: a lost Enter left our prompt unsubmitted while the task waited
   * for a Stop that could not come.
   */
  async #awaitSubmitConfirmation(
    sessionId: string,
    generation: AbortController,
    firstConfirmation: Promise<boolean>,
    injection: string,
    strategy: InjectionStrategy,
  ): Promise<"confirmed" | "unconfirmed" | "rewrite" | "stopped"> {
    if (await this.#confirmedInjection(sessionId, generation, firstConfirmation, 0, injection, strategy)) {
      return "confirmed";
    }
    for (let attempt = 1; attempt <= AgentTaskRunner.MAX_RESUBMITS; attempt++) {
      if (!this.#isCurrentInjection(sessionId, generation)) return "stopped";
      const enterAt = this.#activityFor(sessionId).lastRunnerSubmitAt;
      // The user typed since our Enter (that Enter would submit THEIR text), or
      // the screen is no longer a prompt (it would answer what is on it).
      if (this.#userTypedSince(sessionId, enterAt) || this.#politeWaitReason(sessionId) !== null) {
        if (!this.#reportsPromptSubmit(sessionId)) {
          // No UserPromptSubmit ever arrived from this provider: a missing one
          // proves nothing, so the prompt may well be in — never write it twice.
          log.info("injectPrompt: submit unconfirmed, but this provider never reports submits — not rewriting", {
            sessionId,
            attempt,
            ...this.#politeLogContext(sessionId),
          });
          // Let the user finish: text they leave behind — ours with it, if our
          // Enter was the one that got lost — is sent for them once the agent
          // is at its prompt.
          if (!(await this.#awaitPoliteWindow(sessionId, generation))) return "stopped";
          return "unconfirmed";
        }
        return this.#settleUnconfirmedSubmit(sessionId, generation, enterAt, attempt);
      }
      const confirmed = this.#waitForSubmitConfirmation(sessionId, AgentTaskRunner.SUBMIT_CONFIRM_TIMEOUT_MS);
      log.warn("injectPrompt: submit not confirmed, re-sending Enter", { sessionId, attempt });
      this.#writeToSession!(sessionId, "\r", generation.signal);
      this.#noteRunnerSubmit(sessionId, true);
      if (await this.#confirmedInjection(sessionId, generation, confirmed, attempt, injection, strategy)) {
        return "confirmed";
      }
    }
    return this.#isCurrentInjection(sessionId, generation) ? "unconfirmed" : "stopped";
  }

  /**
   * Our Enter went unconfirmed and the user has typed since. Let them finish
   * (the polite window also sends text they leave behind, and waits for the
   * answer). Anything submitted after our Enter carried our prompt with it —
   * alone, or together with their keys — so the write is done. Nothing
   * submitted means our text never went in or the user cleared it: write it
   * again.
   */
  async #settleUnconfirmedSubmit(
    sessionId: string,
    generation: AbortController,
    enterAt: number,
    attempt: number,
  ): Promise<"confirmed" | "rewrite" | "stopped"> {
    log.info("injectPrompt: submit unconfirmed and the user is typing — waiting for them before deciding", {
      sessionId,
      attempt,
      ...this.#politeLogContext(sessionId),
    });
    const submittedSinceEnter = () => this.#activityFor(sessionId).lastPromptSubmitAt >= enterAt;
    if (submittedSinceEnter()) return "confirmed";
    if (!(await this.#awaitPoliteWindow(sessionId, generation))) return "stopped";
    if (submittedSinceEnter()) return "confirmed";
    log.info("injectPrompt: the runner's prompt never went in — writing it again", {
      sessionId,
      ...this.#politeLogContext(sessionId),
    });
    return "rewrite";
  }

  async #confirmedInjection(
    sessionId: string,
    generation: AbortController,
    confirmed: Promise<boolean>,
    attempt: number,
    injection: string,
    strategy: InjectionStrategy,
  ): Promise<boolean> {
    const didConfirm = await confirmed;
    if (!this.#isCurrentInjection(sessionId, generation)) return false;
    if (!didConfirm) return false;
    log.debug("prompt injected (submit confirmed)", {
      sessionId,
      attempt,
      length: injection.length,
      style: strategy.style,
    });
    return true;
  }

  /**
   * Krok 1 — register a one-shot waiter that resolves when the session's next
   * UserPromptSubmit hook arrives (via onUserPromptSubmit), or false on timeout.
   */
  #waitForSubmitConfirmation(sessionId: string, timeoutMs: number): Promise<boolean> {
    return this.#startSubmitConfirmation(sessionId, timeoutMs).promise;
  }

  /** Same waiter, with a way to withdraw it (a restarted write starts a fresh one). */
  #startSubmitConfirmation(sessionId: string, timeoutMs: number): { promise: Promise<boolean>; cancel: () => void } {
    let cancel: () => void = () => {};
    const promise = new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (confirmed: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const list = this.#submitWaiters.get(sessionId);
        if (list) {
          const idx = list.indexOf(waiter);
          if (idx >= 0) list.splice(idx, 1);
          if (!list.length) this.#submitWaiters.delete(sessionId);
        }
        resolve(confirmed);
      };
      const waiter = () => finish(true);
      const timer = setTimeout(() => finish(false), timeoutMs);
      const list = this.#submitWaiters.get(sessionId) ?? [];
      list.push(waiter);
      this.#submitWaiters.set(sessionId, list);
      cancel = () => finish(false);
    });
    return { promise, cancel };
  }

  /** Krok 1 — resolve all submit waiters for a session (called on UserPromptSubmit). */
  #resolveSubmitWaiters(sessionId: string): void {
    const list = this.#submitWaiters.get(sessionId);
    if (!list?.length) return;
    this.#submitWaiters.delete(sessionId);
    for (const waiter of list) waiter();
  }

  #beginSessionInjection(
    sessionId: string,
    expectedWorkspace: TaskWorkspaceState | null = null,
  ): AbortController | null {
    const binding = this.#resolveTaskBinding(sessionId);
    if (expectedWorkspace) {
      const bindingFailures = this.#staleInjectionBindingChecks(binding, expectedWorkspace);
      if (bindingFailures.length > 0) {
        this.#logStaleInjectionBinding(sessionId, expectedWorkspace, bindingFailures);
        return null;
      }
    }

    const nextOperation = binding
      ? {
          operation: this.#captureTaskOperation(binding.workspace, `session-injection:${sessionId}`, {
            round: true,
            evaluationAttempt: binding.task.mode === "attached",
          }),
          expectedState: binding.task.state,
        }
      : null;
    const existing = this.#injectionAbortControllers.get(sessionId);
    // A probe, not a step: may the session's previous injection be reused?
    // Usually it finished in an earlier state or round, so it is refused and
    // replaced below — that refusal stops nothing.
    if (
      existing &&
      !existing.signal.aborted &&
      this.#isCurrentInjection(sessionId, existing, { reason: "replaced-by-new-injection" })
    )
      return existing;
    if (existing) this.#cancelSessionInjection(sessionId, "superseded-by-new-injection");
    const controller = new AbortController();
    this.#injectionAbortControllers.set(sessionId, controller);
    this.#injectionOperations.set(sessionId, nextOperation);
    return controller;
  }

  /** Why the session no longer binds to the workspace an injection was made for. */
  #staleInjectionBindingChecks(binding: TaskBinding | null, expected: TaskWorkspaceState): TaskOperationCheckFailure[] {
    const failures: TaskOperationCheckFailure[] = [];
    const fail = (check: string, expectedValue: unknown, actual: unknown): void => {
      failures.push({ check, expected: expectedValue, actual });
    };
    const current = this.#findTaskWorkspace(expected.id);
    if (!current) {
      const exists = !!this.#getState?.()?.workspaces.some((candidate) => candidate.id === expected.id);
      fail(exists ? "task" : "workspace", "present", "missing");
    }
    if (!binding) fail("sessionBinding", expected.id, null);
    else if (binding.workspace.id !== expected.id) fail("sessionBinding", expected.id, binding.workspace.id);
    // What the session resolves to now — or, when it resolves to nothing, the
    // task's own current identity, which shows what moved.
    const subject = binding?.workspace ?? current;
    if (!subject) return failures;
    if (subject.task.taskId !== expected.task.taskId) fail("taskId", expected.task.taskId, subject.task.taskId);
    const mode = subject.task.mode || "standard";
    if (mode !== (expected.task.mode || "standard")) fail("mode", expected.task.mode || "standard", mode);
    if (subject.cwd !== expected.cwd) fail("cwd", expected.cwd, subject.cwd);
    if (subject.task.workerPanelId !== expected.task.workerPanelId) {
      fail("workerPanelId", expected.task.workerPanelId, subject.task.workerPanelId);
    }
    if (subject.task.judgePanelId !== expected.task.judgePanelId) {
      fail("judgePanelId", expected.task.judgePanelId, subject.task.judgePanelId);
    }
    if ((subject.task.workerWorkspaceId || "") !== (expected.task.workerWorkspaceId || "")) {
      fail("workerWorkspaceId", expected.task.workerWorkspaceId || "", subject.task.workerWorkspaceId || "");
    }
    return failures;
  }

  #logStaleInjectionBinding(
    sessionId: string,
    expected: TaskWorkspaceState,
    failures: readonly TaskOperationCheckFailure[],
  ): void {
    const current = this.#findTaskWorkspace(expected.id);
    const explainedBy = failures
      .filter((failure) => LIFECYCLE_EXPLAINED_CHECKS.has(failure.check))
      .map((failure) => failure.check);
    const details = {
      sessionId,
      workspaceId: expected.id,
      taskId: expected.task.taskId,
      mode: expected.task.mode || "standard",
      state: current?.task.state ?? null,
      pausedFromState: current?.task.pausedFromState || null,
      round: { expected: expected.task.currentRound ?? null, current: current?.task.currentRound ?? null },
      lifecycleEpoch: this.#taskLifecycleEpoch.get(expected.id) || 0,
      failedChecks: failures,
      explainedBy,
    };
    if (explainedBy.length > 0) {
      log.debug("task injection rejected for stale workspace binding", details);
      return;
    }
    // The task is still there but the session no longer belongs to it the way
    // the step expected (a moved panel, cwd or Primary): the injection — and
    // the step that wanted it — stops here.
    log.warn("task injection rejected for stale workspace binding", details);
  }

  #isCurrentInjection(
    sessionId: string,
    controller: AbortController,
    expectedRefusal?: ExpectedTaskOperationRefusal,
  ): boolean {
    if (this.#disposed || this.#injectionAbortControllers.get(sessionId) !== controller || controller.signal.aborted) {
      this.#reportCancelledInjection(sessionId, controller);
      return false;
    }
    const operation = this.#injectionOperations.get(sessionId);
    return (
      !operation ||
      this.#currentTaskOperation(operation.operation, new Set([operation.expectedState]), { expectedRefusal }) !== null
    );
  }

  /**
   * An in-flight injection found its controller cancelled. Recorded at
   * cancellation (#cancelSessionInjection) and reported only here, by the step
   * that observes it — a finished injection's leftover controller is cancelled
   * on every keystroke and must not log anything.
   */
  #reportCancelledInjection(sessionId: string, controller: AbortController): void {
    const cancelled = this.#cancelledInjections.get(controller);
    if (!cancelled) return;
    this.#cancelledInjections.delete(controller);
    const { reason, injection } = cancelled;
    if (!injection) {
      log.debug("task injection cancelled", { sessionId, reason });
      return;
    }
    const workspace = this.#findTaskWorkspace(injection.operation.workspaceId);
    const expectedStates = new Set([injection.expectedState]);
    const failures = [
      ...this.#staleTaskOperationChecks(injection.operation, workspace, expectedStates),
      { check: "injection", expected: "current", actual: reason },
    ];
    this.#reportStaleTaskOperation(
      injection.operation,
      workspace,
      expectedStates,
      failures,
      undefined,
      EXPLAINED_INJECTION_CANCELS.has(reason) ? `injection-${reason}` : undefined,
    );
  }

  #cancelSessionInjection(sessionId: string, reason: InjectionCancelReason): void {
    if (
      !this.#injectionAbortControllers.has(sessionId) &&
      !this.#injectionOperations.has(sessionId) &&
      !this.#injectionCancels.has(sessionId) &&
      !this.#submitWaiters.has(sessionId)
    )
      return;
    const controller = this.#injectionAbortControllers.get(sessionId);
    if (controller) {
      this.#cancelledInjections.set(controller, {
        reason,
        injection: this.#injectionOperations.get(sessionId) ?? null,
      });
    }
    this.#injectionAbortControllers.delete(sessionId);
    this.#injectionOperations.delete(sessionId);
    controller?.abort();
    const cancels = this.#injectionCancels.get(sessionId);
    if (cancels) for (const cancel of [...cancels]) cancel();
    const waiters = this.#submitWaiters.get(sessionId);
    if (waiters) {
      this.#submitWaiters.delete(sessionId);
      for (const waiter of waiters) waiter();
    }
  }

  /**
   * The session's process was replaced or went away (respawn, restart, retired
   * panel, exit): cancel whatever the runner was typing into it and cross its
   * incarnation. User input never comes through here — see onUserInput.
   * `reason` is diagnostics only: runtime callers leave the default.
   */
  cancelPendingInput(sessionId: string, reason: "session-exit" | "session-reset" = "session-reset"): void {
    const managedRestart = (this.#managedSessionRestarts.get(sessionId) || 0) > 0;
    // A new process: an empty composer, no turn, no dialog.
    this.#sessionActivity.delete(sessionId);
    // The runner's own restart calls back in here; only input or an exit that
    // arrives during it is something else.
    this.#cancelSessionInjection(
      sessionId,
      managedRestart && reason === "session-reset" ? "managed-session-restart" : reason,
    );
    if (!managedRestart) {
      this.#sessionIncarnations.set(sessionId, (this.#sessionIncarnations.get(sessionId) || 0) + 1);
    }
  }

  async #restartTaskSession(sessionId: string): Promise<void> {
    if (!this.#restartSession) throw new Error("Session restart is unavailable");
    this.#managedSessionRestarts.set(sessionId, (this.#managedSessionRestarts.get(sessionId) || 0) + 1);
    try {
      await this.#restartSession(sessionId);
    } finally {
      const remaining = (this.#managedSessionRestarts.get(sessionId) || 1) - 1;
      if (remaining > 0) this.#managedSessionRestarts.set(sessionId, remaining);
      else this.#managedSessionRestarts.delete(sessionId);
    }
  }

  #waitForInjectionDelay(sessionId: string, controller: AbortController, delayMs: number): Promise<boolean> {
    return new Promise((resolve) => {
      let timer: ReturnType<typeof setTimeout> | null = null;
      const finish = (completed: boolean) => {
        if (timer !== null) clearTimeout(timer);
        timer = null;
        const list = this.#injectionCancels.get(sessionId);
        list?.delete(cancel);
        if (list?.size === 0) this.#injectionCancels.delete(sessionId);
        resolve(completed && this.#isCurrentInjection(sessionId, controller));
      };
      const cancel = () => {
        finish(false);
        // finish(false) never asks #isCurrentInjection, so the step waiting
        // here would stop without a word. Report once the cancelling call has
        // finished (a pause or an incarnation crossing lands after the cancel).
        queueMicrotask(() => this.#reportCancelledInjection(sessionId, controller));
      };
      const cancels = this.#injectionCancels.get(sessionId) ?? new Set<() => void>();
      cancels.add(cancel);
      this.#injectionCancels.set(sessionId, cancels);
      timer = setTimeout(() => finish(true), delayMs);
    });
  }

  #cancelTaskInjections(workspace: TaskWorkspaceState): void {
    this.#cancelSessionInjection(sessionIdFor(workspace, "worker"), "task-left-active-state");
    this.#cancelSessionInjection(sessionIdFor(workspace, "judge"), "task-left-active-state");
  }

  dispose(): void {
    this.#disposed = true;
    for (const watcher of this.#taskDirWatchers.values()) watcher.close();
    this.#taskDirWatchers.clear();
    for (const timer of this.#rateLimitTimers.values()) clearTimeout(timer);
    this.#rateLimitTimers.clear();
    for (const timer of this.#workLockOverrideTimers.values()) clearTimeout(timer);
    this.#workLockOverrideTimers.clear();
    for (const timer of this.#periodicWorkLockProbeTimers.values()) clearInterval(timer);
    this.#periodicWorkLockProbeTimers.clear();
    this.#rateLimitCtx.clear();
    this.#judgeRateLimitedUntil.clear();
    this.#judgeRateLimitResumeOwners.clear();
    this.#dropoutCtx.clear();
    this.#standardTaskRunGeneration.clear();
    this.#taskLifecycleEpoch.clear();
    this.#sessionIncarnations.clear();
    this.#managedSessionRestarts.clear();
    this.#sessionActivity.clear();
    this.#evaluationOwners.clear();
    this.#companionVerdictOwners.clear();
    this.#rejectOwners.clear();
    const sessionIds = new Set([
      ...this.#injectionAbortControllers.keys(),
      ...this.#injectionOperations.keys(),
      ...this.#injectionCancels.keys(),
      ...this.#submitWaiters.keys(),
    ]);
    for (const sessionId of sessionIds) this.#cancelSessionInjection(sessionId, "disposed");
  }

  /**
   * Stream a prompt character-by-character, then send Enter. Used for TUIs
   * that misclassify fast bulk writes as a paste event (Copilot).
   */
  #typeAndSubmit(
    sessionId: string,
    text: string,
    { typingGapMs, submitDelayMs }: { typingGapMs: number; submitDelayMs: number },
    generation: AbortController,
    signal: AbortSignal,
    inputMark: number,
    beforeWrite?: () => void,
  ): Promise<RunnerWriteOutcome> {
    return new Promise((resolve) => {
      let index = 0;
      let timer: ReturnType<typeof setTimeout> | null = null;
      const finish = (outcome: RunnerWriteOutcome) => {
        if (timer !== null) clearTimeout(timer);
        timer = null;
        const list = this.#injectionCancels.get(sessionId);
        list?.delete(cancel);
        if (list?.size === 0) this.#injectionCancels.delete(sessionId);
        resolve(outcome);
      };
      const cancel = () => finish("stopped");
      const cancels = this.#injectionCancels.get(sessionId) ?? new Set<() => void>();
      cancels.add(cancel);
      this.#injectionCancels.set(sessionId, cancels);
      const typeNext = () => {
        if (!this.#isCurrentInjection(sessionId, generation)) {
          finish("stopped");
          return;
        }
        // The user typed between two of our characters, or a dialog came up
        // that our next character would answer: stop at this boundary.
        if (this.#userTypedSince(sessionId, inputMark) || this.#screenNotAtPrompt(sessionId)) {
          finish("interrupted");
          return;
        }
        if (index >= text.length) {
          timer = setTimeout(() => {
            timer = null;
            if (!this.#isCurrentInjection(sessionId, generation)) {
              finish("stopped");
              return;
            }
            if (this.#userTypedSince(sessionId, inputMark) || this.#screenNotAtPrompt(sessionId)) {
              finish("interrupted");
              return;
            }
            log.trace("typeAndSubmit: sending Enter after type complete", { sessionId });
            this.#writeToSession!(sessionId, "\r", signal);
            finish("submitted");
          }, submitDelayMs);
          return;
        }
        if (index === 0) beforeWrite?.();
        this.#writeToSession!(sessionId, text[index], signal);
        index += 1;
        timer = setTimeout(() => {
          timer = null;
          typeNext();
        }, typingGapMs);
      };
      typeNext();
    });
  }

  #injectionCancels = new Map<string, Set<() => void>>();

  /**
   * Send text to a PTY using the provider's preferred strategy and resolve only
   * after the final Enter has been written.
   *
   * Polite: before writing it waits for the user (#prepareRunnerWrite), and if
   * the user types while the text is going in, the Enter is withheld and the
   * whole write starts over from that wait — never given up, never a pause.
   */
  async #writeAndSubmit(
    sessionId: string,
    text: string,
    strategy: InjectionStrategy,
    generation = this.#beginSessionInjection(sessionId) ?? new AbortController(),
    signal = generation.signal,
    {
      reclear = false,
      startsTurn = true,
      beforeWrite,
    }: { reclear?: boolean; startsTurn?: boolean; beforeWrite?: () => void } = {},
  ): Promise<void> {
    for (let restarts = 0; ; restarts += 1) {
      // Checked synchronously so a session nobody is typing in is written to in
      // the same tick, exactly as before polite injection existed.
      if (
        this.#runnerWriteNeedsPreparation(sessionId, generation, reclear) &&
        !(await this.#prepareRunnerWrite(sessionId, generation, strategy, signal, reclear))
      )
        return;
      if (!this.#isCurrentInjection(sessionId, generation)) return;
      const outcome = await this.#deliverRunnerText(
        sessionId,
        text,
        strategy,
        generation,
        signal,
        startsTurn,
        beforeWrite,
      );
      if (outcome !== "interrupted") {
        // The prompt this injection's /clear was waiting for is in: nothing left to re-clear for.
        const activity = this.#activityFor(sessionId);
        if (outcome === "submitted" && startsTurn && activity.clearGeneration === generation) {
          activity.clearGeneration = null;
        }
        return;
      }
      log.info("task injection restarted: the user typed during the runner's write", {
        sessionId,
        restarts: restarts + 1,
        ...this.#politeLogContext(sessionId),
      });
    }
  }

  /**
   * Write `text` and its Enter once. "interrupted" when the user typed while it
   * went in — the Enter is then withheld, because it would submit the user's
   * keys glued to ours. Our text stays in their composer and counts as their
   * pending input from here on.
   */
  #deliverRunnerText(
    sessionId: string,
    text: string,
    strategy: InjectionStrategy,
    generation: AbortController,
    signal: AbortSignal,
    startsTurn: boolean,
    beforeWrite?: () => void,
  ): Promise<RunnerWriteOutcome> {
    const inputMark = this.#sessionActivity.get(sessionId)?.lastInputAt ?? 0;
    const delivered =
      strategy.style === "type"
        ? this.#typeAndSubmit(sessionId, text, strategy, generation, signal, inputMark, beforeWrite)
        : this.#pasteAndSubmit(sessionId, text, strategy, generation, signal, inputMark, beforeWrite);
    return delivered.then((outcome) => {
      if (outcome === "submitted") this.#noteRunnerSubmit(sessionId, startsTurn);
      else if (outcome === "interrupted") this.#activityFor(sessionId).pending = true;
      return outcome;
    });
  }

  #pasteAndSubmit(
    sessionId: string,
    text: string,
    strategy: InjectionStrategy,
    generation: AbortController,
    signal: AbortSignal,
    inputMark: number,
    beforeWrite?: () => void,
  ): Promise<RunnerWriteOutcome> {
    if (!this.#isCurrentInjection(sessionId, generation)) return Promise.resolve("stopped");
    beforeWrite?.();
    this.#writeToSession!(sessionId, text, signal);
    return new Promise((resolve) => {
      let timer: ReturnType<typeof setTimeout> | null = null;
      const finish = (outcome: RunnerWriteOutcome) => {
        if (timer !== null) clearTimeout(timer);
        timer = null;
        const list = this.#injectionCancels.get(sessionId);
        list?.delete(cancel);
        if (list?.size === 0) this.#injectionCancels.delete(sessionId);
        resolve(outcome);
      };
      const cancel = () => finish("stopped");
      const cancels = this.#injectionCancels.get(sessionId) ?? new Set<() => void>();
      cancels.add(cancel);
      this.#injectionCancels.set(sessionId, cancels);
      timer = setTimeout(() => {
        timer = null;
        if (!this.#isCurrentInjection(sessionId, generation)) {
          finish("stopped");
          return;
        }
        if (this.#userTypedSince(sessionId, inputMark) || this.#screenNotAtPrompt(sessionId)) {
          finish("interrupted");
          return;
        }
        log.trace("writeAndSubmit: sending Enter", { sessionId, submitDelay: strategy.submitDelayMs });
        this.#writeToSession!(sessionId, "\r", signal);
        finish("submitted");
      }, strategy.submitDelayMs);
    });
  }

  // ---------------------------------------------------------------------------
  // Polite injection — the user's keystrokes never pause or stall a task
  // ---------------------------------------------------------------------------
  //
  // Typing into a task panel used to pause the task, and (since 3.0.6) to
  // cross the session's incarnation, which silently killed whatever step was in
  // flight. Now a keystroke only (1) defers the runner's next write into that
  // session and (2) withholds the Enter of a write that is going in at that very
  // moment. Before every runner write into a task session:
  //   a. wait until the user has left the session alone for USER_QUIET_MS;
  //   b. if they left text in the composer, submit it for them — only once the
  //      agent's turn is over and never while a dialog is open;
  //   c. wait until the agent has answered that message;
  //   d. write — and start over from (a) if the user types during the write.
  // Every wait ends at once on a lifecycle change: it sleeps on the injection's
  // cancel list, which Pause / Stop / Reset / completion / a retired session
  // all trigger, and re-validates the injection's operation on every tick.

  /** How long the user must have left a session alone before the runner writes into it. */
  static USER_QUIET_MS = 10_000;
  /** How often a polite wait re-checks a session while it waits on the agent or a dialog. */
  static POLITE_POLL_MS = 500;
  /** A turn with no busy output for this long counts as over even without its idle signal. */
  static TURN_QUIET_FALLBACK_MS = 30_000;
  /** A polite wait this long is logged at warn (and again every interval) — never a silent stall. */
  static POLITE_WAIT_WARN_MS = 5 * 60_000;

  #sessionActivity = new Map<string, SessionUserActivity>();
  /** User actions (Start, Send back, answer) waiting on their own runner write, per task workspace. */
  #userActionWaiters = new Map<string, Set<() => void>>();

  /**
   * Await `step` on behalf of a user action — unless one of the task's runner
   * writes starts waiting for the user first: then stop waiting (`done:
   * false`) and let the step finish in the background. A user's click must
   * not hang for as long as they keep typing in a panel; over the mobile relay
   * a request with no answer after 30 s is dropped.
   */
  async #awaitUnlessUserDefers<T>(
    workspaceId: string,
    step: Promise<T>,
  ): Promise<{ done: true; value: T } | { done: false }> {
    let release!: () => void;
    const deferred = new Promise<{ done: false }>((resolve) => (release = () => resolve({ done: false })));
    const waiters = this.#userActionWaiters.get(workspaceId) ?? new Set<() => void>();
    waiters.add(release);
    this.#userActionWaiters.set(workspaceId, waiters);
    try {
      return await Promise.race([step.then((value) => ({ done: true as const, value })), deferred]);
    } finally {
      waiters.delete(release);
      if (waiters.size === 0) this.#userActionWaiters.delete(workspaceId);
    }
  }

  /** A runner write for this session's task started waiting for the user. */
  #releaseUserActionWaiters(sessionId: string): void {
    const workspaceId = this.#resolveTaskBinding(sessionId)?.workspace.id;
    const waiters = workspaceId ? this.#userActionWaiters.get(workspaceId) : undefined;
    if (!waiters) return;
    for (const release of [...waiters]) release();
  }

  /**
   * Run a user action whose runner writes may have to wait for the user. It
   * answers with its own result when that comes quickly; once a write waits,
   * it answers "accepted" and the rest goes on in the background, where a
   * failure is still logged and raised as a task alert.
   */
  async #runUserAction(
    workspaceId: string,
    label: string,
    action: Promise<boolean>,
    lateFailure: (_state: string) => string,
  ): Promise<boolean> {
    const settled = action.then(
      (ok) => ({ ok, err: null as unknown }),
      (err: unknown) => ({ ok: false, err }),
    );
    const outcome = await this.#awaitUnlessUserDefers(workspaceId, settled);
    if (outcome.done) {
      if (outcome.value.err) throw outcome.value.err;
      return outcome.value.ok;
    }
    log.info(`${label}: continuing in the background — a write waits for the user in the panel`, { workspaceId });
    void settled.then(({ ok, err }) => {
      if (ok) return;
      // The user's action already answered "accepted": a failure now must
      // still reach them, not only the log (CLAUDE.md, failed user actions).
      const workspace = this.#findTaskWorkspace(workspaceId);
      log.error(`${label}: did not complete in the background`, {
        workspaceId,
        state: workspace?.task.state ?? null,
        err: err === null ? null : ((err as Error)?.message ?? String(err)),
      });
      if (!workspace) return;
      const message = lateFailure(workspace.task.state);
      void this.#logTaskEvent(workspace, "user-action-failed", message);
      this.#raiseTaskAlert(workspace, "failed", message);
      this.#broadcastState!();
    });
    return true;
  }
  /** Sessions with a runner write currently waiting for the user (count per session). */
  #politeWaits = new Map<string, number>();
  /** Providers whose UserPromptSubmit hook has been seen working (see #reportsPromptSubmit). */
  #promptSubmitProviders = new Set<string>();
  /** Prompt / clear deliveries in flight per session — a Resend must not run beside one. */
  #deliveriesInFlight = new Map<string, number>();
  /** Task workspaces whose Companion answer is being delivered. */
  #answersInFlight = new Set<string>();
  /** A rewritten prompt is retried at most this often when its submit stays unconfirmed. */
  static MAX_UNCONFIRMED_REWRITES = 2;

  #activityFor(sessionId: string): SessionUserActivity {
    let activity = this.#sessionActivity.get(sessionId);
    if (!activity) {
      activity = {
        lastInputAt: 0,
        pending: false,
        lastChar: "",
        turnActive: false,
        userTurn: false,
        turnStartedAt: 0,
        uiState: "prompt",
        escRun: 0,
        sawPromptSubmit: false,
        lastRunnerSubmitAt: 0,
        lastPromptSubmitAt: 0,
        clearGeneration: null,
        clearedAt: 0,
      };
      this.#sessionActivity.set(sessionId, activity);
    }
    return activity;
  }

  /** A dialog or an uncertain screen appeared — no Enter may follow (see the rule). */
  #screenNotAtPrompt(sessionId: string): boolean {
    return (this.#sessionActivity.get(sessionId)?.uiState ?? "prompt") !== "prompt";
  }

  /** Which provider a session runs, for "does its UserPromptSubmit hook work?" — null when unknown. */
  #promptSubmitProviderKey(sessionId: string): string | null {
    const binding = this.#resolveTaskBinding(sessionId);
    if (!binding || binding.task.mode === "attached") return null;
    const config = binding.role === "worker" ? binding.task.workerProviderConfig : binding.task.judgeProviderConfig;
    return config?.providerId || "claude";
  }

  /** UserPromptSubmit is known to reach the runner for this session (or its provider). */
  #reportsPromptSubmit(sessionId: string): boolean {
    if (this.#sessionActivity.get(sessionId)?.sawPromptSubmit) return true;
    const providerKey = this.#promptSubmitProviderKey(sessionId);
    return !!providerKey && this.#promptSubmitProviders.has(providerKey);
  }

  /** The operation is stale only because a session was replaced (respawn, exit). */
  #onlySessionsChanged(operation: TaskOperationContext, expectedStates?: ReadonlySet<string>): boolean {
    const failures = this.#staleTaskOperationChecks(
      operation,
      this.#findTaskWorkspace(operation.workspaceId),
      expectedStates,
    );
    return failures.length > 0 && failures.every((failure) => failure.check === "sessionIncarnation");
  }

  #userTypedSince(sessionId: string, mark: number): boolean {
    const lastInputAt = this.#sessionActivity.get(sessionId)?.lastInputAt ?? 0;
    return lastInputAt > mark;
  }

  /** The user typed into this session after the runner's last write to it — an
   * idle that follows may answer them, not us, so it must not spend a nudge. */
  #userInterjected(sessionId: string): boolean {
    const activity = this.#sessionActivity.get(sessionId);
    return !!activity && activity.lastInputAt > activity.lastRunnerSubmitAt;
  }

  #noteRunnerSubmit(sessionId: string, startsTurn: boolean): void {
    const activity = this.#activityFor(sessionId);
    const now = Date.now();
    activity.lastRunnerSubmitAt = now;
    activity.pending = false;
    activity.lastChar = "\r";
    activity.escRun = 0; // our keys came between: an Esc after them starts a new run
    // A slash command (/clear) is handled by the CLI itself: no agent turn, no Stop.
    if (startsTurn) {
      activity.turnActive = true;
      activity.userTurn = false;
      activity.turnStartedAt = now;
    }
  }

  /** The agent's current turn is over: its idle signal arrived, or it has shown
   * no busy output for TURN_QUIET_FALLBACK_MS (a turn the user interrupted ends
   * without a Stop hook; providers without hooks only ever end this way). */
  #agentTurnEnded(sessionId: string, activity: SessionUserActivity, now: number): boolean {
    if (!activity.turnActive) return true;
    // A dialog is silent: "no output for 30 s" proves nothing then — only the
    // agent's own signals end that turn.
    if (activity.uiState !== "prompt") return false;
    return (
      now - activity.turnStartedAt >= AgentTaskRunner.TURN_QUIET_FALLBACK_MS &&
      !(this.#isSessionBusy?.(sessionId) ?? false)
    );
  }

  /**
   * What the runner's next write into `sessionId` has to wait for, if anything.
   *
   * THE RULE: the runner never answers, accepts, selects or confirms anything
   * on the user's behalf. Every key it sends — its own text, the Enter after
   * it, an Enter for text the user left behind, a key that dismisses a
   * rate-limit dialog — lands on whatever the agent shows. So while a dialog
   * is up, or the screen is uncertain (two Escs in a row: a selector may have
   * opened), nothing is written at all. The wait ends only on a positive
   * signal that the agent is at its prompt (see #noteAgentSignal /
   * #recordUserInput; for an uncertain screen only a submitted prompt) or —
   * for an uncertain screen, never for a dialog — the user's own word for it,
   * a Continue / Resend / Start on the dashboard (#takeUserWordForScreens). It is never given up, warns every
   * POLITE_WAIT_WARN_MS (the first time also on the task's dashboard, see
   * #reportLongPoliteWait), and Pause / Stop / Reset end it at once.
   *
   * The single exception, by design: Claude Code's rate-limit menu, which the
   * runner answers with Enter to take its default choice, "wait for the limit
   * to reset" (#pressDialogEnter). The runner sees that menu in the output —
   * no dialog hook reports it — and a task left on it would never resume.
   */
  #politeWaitReason(sessionId: string, { quietOnly = false }: { quietOnly?: boolean } = {}): PoliteWaitReason | null {
    const activity = this.#sessionActivity.get(sessionId);
    if (!activity) return null;
    if (activity.uiState === "dialog") return "dialog-open";
    if (activity.uiState === "uncertain") return "ui-uncertain";
    if (activity.lastInputAt === 0) return null; // the user never typed here
    const now = Date.now();
    if (now - activity.lastInputAt < AgentTaskRunner.USER_QUIET_MS) return "user-typing";
    if (quietOnly) return null;
    if (activity.pending) {
      if (!this.#agentTurnEnded(sessionId, activity, now)) return "agent-turn";
      return "submit-pending";
    }
    if (activity.turnActive && activity.userTurn && !this.#agentTurnEnded(sessionId, activity, now)) {
      return "agent-answer";
    }
    return null;
  }

  /** The prompt of an injection whose /clear the user talked over gets a fresh /clear first. */
  #needsReclear(sessionId: string, generation: AbortController): boolean {
    const activity = this.#sessionActivity.get(sessionId);
    return !!activity && activity.clearGeneration === generation && activity.lastInputAt > activity.clearedAt;
  }

  #runnerWriteNeedsPreparation(sessionId: string, generation: AbortController, reclear: boolean): boolean {
    return this.#politeWaitReason(sessionId) !== null || (reclear && this.#needsReclear(sessionId, generation));
  }

  /** (a)–(c) above, plus the repeated /clear. False when the injection stopped being current. */
  async #prepareRunnerWrite(
    sessionId: string,
    generation: AbortController,
    strategy: InjectionStrategy,
    signal: AbortSignal,
    reclear: boolean,
  ): Promise<boolean> {
    for (;;) {
      if (!(await this.#awaitPoliteWindow(sessionId, generation))) return false;
      if (!reclear || !this.#needsReclear(sessionId, generation)) return true;
      log.info("task injection: the user talked to the agent after the runner's /clear — clearing again", {
        sessionId,
        ...this.#politeLogContext(sessionId),
      });
      const outcome = await this.#deliverRunnerText(sessionId, "/clear", strategy, generation, signal, false);
      if (outcome === "stopped") return false;
      if (outcome === "submitted") {
        this.#activityFor(sessionId).clearedAt = Date.now();
        if (strategy.clearSettleMs > 0) {
          if (!(await this.#waitForInjectionDelay(sessionId, generation, strategy.clearSettleMs))) return false;
        }
      }
    }
  }

  /**
   * Wait until the runner may write into `sessionId` (steps a–c). Resolves true
   * at once when nothing is in the way; false as soon as the injection stops
   * being current (Pause, Stop, Reset, completion, a retired session).
   * `quietOnly` is for a key that answers an on-screen dialog: it needs only
   * the user's hands off the keyboard, not an idle agent.
   */
  async #awaitPoliteWindow(
    sessionId: string,
    controller: AbortController,
    { quietOnly = false }: { quietOnly?: boolean } = {},
  ): Promise<boolean> {
    this.#politeWaits.set(sessionId, (this.#politeWaits.get(sessionId) ?? 0) + 1);
    try {
      return await this.#politeWaitLoop(sessionId, controller, quietOnly);
    } finally {
      const remaining = (this.#politeWaits.get(sessionId) ?? 1) - 1;
      if (remaining > 0) this.#politeWaits.set(sessionId, remaining);
      else this.#politeWaits.delete(sessionId);
    }
  }

  async #politeWaitLoop(sessionId: string, controller: AbortController, quietOnly: boolean): Promise<boolean> {
    const startedAt = Date.now();
    let deferredFor: PoliteWaitReason | null = null;
    let nextWarnAt = AgentTaskRunner.POLITE_WAIT_WARN_MS;
    for (;;) {
      if (!this.#isCurrentInjection(sessionId, controller)) return false;
      const reason = this.#politeWaitReason(sessionId, { quietOnly });
      if (reason === null) {
        if (deferredFor) {
          log.info("task injection resumed: the user left the session", {
            sessionId,
            waitedMs: Date.now() - startedAt,
            ...this.#politeLogContext(sessionId),
          });
        }
        return true;
      }
      if (reason === "submit-pending") {
        this.#submitPendingInputForUser(sessionId, controller, Date.now() - startedAt);
        continue;
      }
      if (reason !== deferredFor) {
        log.info("task injection deferred: the user is active in the session", {
          sessionId,
          waitingFor: reason,
          ...this.#politeLogContext(sessionId),
        });
        if (deferredFor === null) this.#releaseUserActionWaiters(sessionId);
        deferredFor = reason;
      }
      const waitedMs = Date.now() - startedAt;
      if (waitedMs >= nextWarnAt) {
        log.warn("task injection still waiting for the user", {
          sessionId,
          waitingFor: reason,
          waitedMs,
          ...this.#politeLogContext(sessionId),
        });
        if (nextWarnAt === AgentTaskRunner.POLITE_WAIT_WARN_MS) this.#reportLongPoliteWait(sessionId, reason);
        nextWarnAt += AgentTaskRunner.POLITE_WAIT_WARN_MS;
      }
      const activity = this.#activityFor(sessionId);
      const delay =
        reason === "user-typing"
          ? AgentTaskRunner.USER_QUIET_MS - (Date.now() - activity.lastInputAt)
          : AgentTaskRunner.POLITE_POLL_MS;
      if (!(await this.#waitForInjectionDelay(sessionId, controller, Math.max(1, delay)))) return false;
    }
  }

  /**
   * A runner write has waited POLITE_WAIT_WARN_MS: say so where the user looks,
   * not only in strideterm.log — the task's Activity log says what it waits for
   * and what ends the wait, and when only the user can end it (a dialog, a
   * possible selector) an alert points at the panel.
   */
  #reportLongPoliteWait(sessionId: string, reason: PoliteWaitReason): void {
    log.info("task injection: told the user about a long wait", {
      sessionId,
      waitingFor: reason,
      ...this.#politeLogContext(sessionId),
    });
    this.#tellUserTaskWaits(sessionId, reason);
  }

  /**
   * Tell the user that the task waits on them in a panel: the task's Activity
   * log says what for and what ends the wait, and when only they can end it
   * (a dialog, a possible selector) an urgent alert points at the panel.
   */
  #tellUserTaskWaits(sessionId: string, reason: PoliteWaitReason): void {
    const binding = this.#resolveTaskBinding(sessionId);
    if (!binding) return;
    const { workspace, task, role } = binding;
    const where = this.#panelPhrase(task, role);
    const resend = this.#resendButtonLabel(task, role);
    let message: string;
    switch (reason) {
      case "dialog-open":
        message = `The task is waiting for you: a dialog is open in ${where}, and the runner never answers one for you. Answer it there and the task goes on.`;
        break;
      case "ui-uncertain":
        message = `The task is waiting for you: Esc was pressed twice in ${where}, which may have opened a selector, so the runner types nothing into it. Close it there, then press ${resend} on the dashboard (or send a message in that panel) and the task goes on.`;
        break;
      case "user-typing":
        message = `The task's next step for ${where} waits while you type there — it goes in once you leave the panel alone for ${AgentTaskRunner.USER_QUIET_MS / 1000} s.`;
        break;
      case "agent-turn":
        message = `The task's next step for ${where} waits for the agent's current turn there to end; then the text you left in its composer is sent for you, and the task goes on.`;
        break;
      default:
        message = `The task's next step for ${where} waits until the agent there has answered your message.`;
    }
    void this.#logTaskEvent(workspace, "waiting-for-user", message);
    if (reason === "dialog-open" || reason === "ui-uncertain") {
      this.#raiseAlert?.({
        projectId: workspace.id,
        panelId: role === "worker" ? task.workerPanelId : task.judgePanelId,
        sessionId,
        title: formatWorkspaceDisplayName(workspace),
        kind: "waiting",
        tier: 1,
        // A task stalled on the user: urgent, like a failed task (a normal
        // "waiting" alert is suppressed while the runner owns the turn).
        urgency: "urgent",
        detail: `task-waiting: ${message}`,
      });
    }
    this.#broadcastState?.();
  }

  /**
   * Mirrors the task-panel rule in runtime-attention.ts raiseAlert: a
   * normal-urgency question from the Worker or Judge panel of a task
   * workspace is not shown while the runner owns the turn. An attached
   * task's Primary lives in an ordinary workspace, which the rule never
   * covers.
   */
  #runtimeHoldsBackQuestions(task: RuntimeTaskState, role: "worker" | "judge"): boolean {
    if (task.mode === "attached" && role === "worker") return false;
    return RUNNER_OWNED_TURN_STATES.has(task.state);
  }

  /** The panel of a role, as the user knows it: "the Worker panel", "the Primary conversation"… */
  #panelPhrase(task: RuntimeTaskState, role: "worker" | "judge"): string {
    if (task.mode === "attached") {
      return role === "worker"
        ? "the Primary conversation"
        : `the ${COMPANION_ROLE_DISPLAY_NAMES[task.companionRole as CompanionRole]} panel`;
    }
    return role === "worker" ? "the Worker panel" : "the Judge panel";
  }

  /** The dashboard's Resend button for a role, as TaskDashboardPane labels it. */
  #resendButtonLabel(task: RuntimeTaskState, role: "worker" | "judge"): string {
    if (task.mode === "attached") {
      return role === "worker" ? "↻ Primary" : `↻ ${COMPANION_ROLE_DISPLAY_NAMES[task.companionRole as CompanionRole]}`;
    }
    return role === "worker" ? "↻ Worker" : "↻ Judge";
  }

  /** Step (b): press Enter on the text the user left behind — their message, sent for them. */
  #submitPendingInputForUser(sessionId: string, controller: AbortController, waitedMs: number): void {
    const activity = this.#activityFor(sessionId);
    log.info("task injection: submitted the user's pending input for them", {
      sessionId,
      waitedMs,
      ...this.#politeLogContext(sessionId),
    });
    this.#writeToSession!(sessionId, "\r", controller.signal);
    const now = Date.now();
    activity.pending = false;
    activity.lastChar = "\r";
    activity.escRun = 0;
    activity.turnActive = true;
    activity.userTurn = true;
    activity.turnStartedAt = now;
  }

  /** Ids, states and timings for the polite-injection log lines — never typed or prompt text. */
  #politeLogContext(sessionId: string): Record<string, unknown> {
    const binding = this.#resolveTaskBinding(sessionId);
    const activity = this.#sessionActivity.get(sessionId);
    const now = Date.now();
    return {
      workspaceId: binding?.workspace.id ?? null,
      taskId: binding?.task.taskId ?? null,
      role: binding?.role ?? null,
      state: binding?.task.state ?? null,
      msSinceUserInput: activity?.lastInputAt ? now - activity.lastInputAt : null,
      pendingInput: activity?.pending ?? false,
      turnActive: activity?.turnActive ?? false,
      userTurn: activity?.userTurn ?? false,
      uiState: activity?.uiState ?? "prompt",
    };
  }

  /** Real keystrokes or a paste the user sent into a task session (see onUserInput). */
  #recordUserInput(sessionId: string, data: string | Buffer | undefined): void {
    const activity = this.#activityFor(sessionId);
    activity.lastInputAt = Date.now();
    const text = data === undefined ? undefined : typeof data === "string" ? data : data.toString("binary");
    if (text === undefined) {
      // No bytes to look at: assume they typed something.
      activity.pending = true;
      return;
    }
    const folded = foldTerminalInput(
      { pending: activity.pending, lastChar: activity.lastChar, escRun: activity.escRun },
      text,
    );
    const uiBefore = activity.uiState;
    activity.pending = folded.pending;
    activity.lastChar = folded.lastChar;
    activity.escRun = folded.escRun;
    if (folded.interrupted) {
      // An interrupted turn ends without a Stop hook.
      //
      // Known limitation: Claude Code may put the message whose turn an Esc
      // interrupted back into its composer. The runner sees only the keys,
      // not the screen, so that text is invisible to it: the runner's next
      // write (after the usual quiet) is appended to it and both go in as one
      // message. No agent signal reports a restored composer.
      activity.turnActive = false;
      activity.userTurn = false;
    }
    if (folded.doubleEscaped) {
      // Two Escs in a row may have opened a selector (Claude's rewind picker,
      // Codex's backtrack). Only the agent — or the user's own word — can say
      // it did not (see the rule).
      activity.uiState = "uncertain";
    } else if (folded.dismissed && uiBefore === "dialog") {
      // A single Esc or Ctrl+C rejects the dialog and leaves the agent at its
      // prompt; neither opens anything. (A single Esc on an uncertain screen
      // settles nothing: in Codex's backtrack it steps further back.)
      activity.uiState = "prompt";
    } else if (folded.entered && uiBefore === "dialog") {
      // Enter answered the dialog — the user's own answer. The agent carries
      // on with the turn, which still has to end before the runner writes.
      activity.uiState = "prompt";
      return;
    }
    if (folded.submitted) {
      // The user sent text from where they were. For an agent that reports
      // nothing back (no hooks) that is the only proof there is that the
      // screen was a prompt; one with hooks confirms it with UserPromptSubmit.
      if (uiBefore === "uncertain" && !(this.#isSessionHookCapable?.(sessionId) ?? false)) {
        activity.uiState = "prompt";
      }
      activity.turnActive = true;
      activity.userTurn = true;
      activity.turnStartedAt = activity.lastInputAt;
    }
  }

  /** Turn and dialog bookkeeping from the idle / hook signals the runner already receives. */
  #noteAgentSignal(sessionId: string, source: string): void {
    if (DIALOG_IDLE_SOURCES.has(source)) {
      // Recorded even for a session the user never typed in: the runner's own
      // next write must not land in the dialog either.
      this.#activityFor(sessionId).uiState = "dialog";
      return;
    }
    const activity = this.#sessionActivity.get(sessionId);
    if (!activity) return;
    // A turn end the agent itself reports (Stop, idle_prompt, a shell prompt)
    // closes a dialog; the runtime's silence timers do not — a dialog left
    // open is silent too. Neither settles an uncertain screen: nothing proves
    // an agent says nothing while its selector is open (Claude's rewind
    // picker, Codex's backtrack), and an Enter there picks an old message.
    // Only UserPromptSubmit or the user's own word does (onUserPromptSubmit,
    // #recordUserInput, #takeUserWordForScreens).
    if (DIALOG_CLOSING_IDLE_SOURCES.has(source) && activity.uiState === "dialog") activity.uiState = "prompt";
    if (!TURN_END_IDLE_SOURCES.has(source) || activity.uiState === "dialog") return;
    activity.turnActive = false;
    activity.userTurn = false;
  }

  /**
   * A user action on the task (Pause, Stop, Reset, Continue) forgets the turn
   * the runner believed was running — a lost Stop must not hold the next write
   * back for ever. Never what is on the screen or in the composer: a dialog
   * still open after Continue is still the user's to answer (see the rule).
   */
  #forgetUserActivity(workspace: TaskWorkspaceState): void {
    for (const sessionId of [sessionIdFor(workspace, "worker"), sessionIdFor(workspace, "judge")]) {
      const activity = this.#sessionActivity.get(sessionId);
      if (!activity) continue;
      activity.turnActive = false;
      activity.userTurn = false;
      activity.turnStartedAt = 0;
    }
  }

  /**
   * An explicit dashboard action (Continue, Resend, Start) is the user's word
   * that these panels are at their prompt — it settles an uncertain screen
   * (two Escs: maybe a selector), which no agent signal may ever settle for an
   * agent that reports nothing back. Never a dialog: one the agent reported
   * is still waiting for the user's answer in the panel (see the rule).
   */
  #takeUserWordForScreens(workspace: TaskWorkspaceState, roles: Array<"worker" | "judge">, action: string): boolean {
    let settled = false;
    for (const role of roles) {
      const sessionId = sessionIdFor(workspace, role);
      const activity = this.#sessionActivity.get(sessionId);
      if (!activity || activity.uiState !== "uncertain") continue;
      activity.uiState = "prompt";
      activity.escRun = 0;
      settled = true;
      log.info("task injection: the user's dashboard action vouches the panel is at its prompt", {
        sessionId,
        action,
        ...this.#politeLogContext(sessionId),
      });
    }
    return settled;
  }

  /**
   * Resolve the injection strategy for a given panel session: look up the
   * provider config by panel id and return its style + timings. Falls back
   * to sensible defaults for ad-hoc injections or unknown providers.
   */
  #resolveInjectionStrategy(sessionId: string, workspace: TaskWorkspaceState | null): InjectionStrategy {
    const fallback: InjectionStrategy = { style: "paste", submitDelayMs: 200, typingGapMs: 8, clearSettleMs: 800 };
    if (!workspace?.task) return fallback;
    const panelId = sessionId.split(":").slice(1).join(":");
    let providerConfig: { providerId: string } | null = null;
    if (panelId === workspace.task.workerPanelId) providerConfig = workspace.task.workerProviderConfig;
    else if (panelId === workspace.task.judgePanelId) providerConfig = workspace.task.judgeProviderConfig;
    if (!providerConfig?.providerId) return fallback;
    try {
      const provider = getProvider(providerConfig.providerId);
      return {
        style: provider.promptInjectionStyle ?? fallback.style,
        submitDelayMs: provider.promptSubmitDelayMs ?? fallback.submitDelayMs,
        typingGapMs: provider.promptTypingGapMs ?? fallback.typingGapMs,
        clearSettleMs: provider.clearCommandSettleMs ?? fallback.clearSettleMs,
      };
    } catch {
      return fallback;
    }
  }

  /**
   * Stop the Worker's current activity when the task ends (completed or failed).
   *
   * Sends Ctrl+C to interrupt, then a clear stop message. The conversation
   * context is preserved so the user can still ask the Worker questions
   * about what it did. Background/scheduled tasks are prevented by
   * CLAUDE_CODE_DISABLE_BACKGROUND_TASKS env var set at session startup.
   */
  #notifyWorkerTaskEnded(workspace: TaskWorkspaceState, kind: "completed" | "failed"): void {
    if (!this.#writeToSession) return;
    const operation = this.#captureTaskOperation(workspace, `worker-task-${kind}-notice`, {
      // Best-effort courtesy to a task that has already ended: any refusal
      // (Resume, the user typing into the Worker) makes it moot, and a task in
      // a terminal state has nothing left to be stranded.
      expectedRefusal: { reason: "task-already-ended" },
    });
    const expectedState = new Set([kind]);
    const workerSessionId = sessionIdFor(workspace, "worker");
    if (!this.#currentTaskOperation(operation, expectedState)) return;

    const reason =
      kind === "completed"
        ? "The Judge has approved your work. The task is complete."
        : "The task runner has stopped (max rounds or error).";
    const message = `\nThe task has ended: ${reason} Do not start new work or continue the previous task. Wait for the user.`;
    // The user is working in the Worker panel: no Ctrl+C under their hands —
    // the notice goes in like any other runner write, once they are done.
    if (this.#politeWaitReason(workerSessionId) !== null) {
      void this.#deliverTaskEndedNoticePolitely(workspace, workerSessionId, message);
      return;
    }

    log.info("sending stop signal to Worker", { workspaceId: workspace.id, kind });

    // 1. Ctrl+C to interrupt any running tool/command
    this.#writeToSession(workerSessionId, "\x03");

    // 2. After pause (agent needs time to cancel and return to prompt), write the stop message
    setTimeout(() => {
      if (!this.#currentTaskOperation(operation, expectedState)) return;
      if (this.#politeWaitReason(workerSessionId) !== null) {
        void this.#deliverTaskEndedNoticePolitely(workspace, workerSessionId, message);
        return;
      }
      const inputMark = this.#sessionActivity.get(workerSessionId)?.lastInputAt ?? 0;
      this.#writeToSession!(workerSessionId, message);
      // Send Enter separately after text is written (same pattern as #injectPrompt)
      setTimeout(() => {
        if (!this.#currentTaskOperation(operation, expectedState)) return;
        // The user typed into our half-written notice, or a dialog came up
        // that the Enter would answer: start over politely.
        if (this.#userTypedSince(workerSessionId, inputMark) || this.#screenNotAtPrompt(workerSessionId)) {
          this.#activityFor(workerSessionId).pending = true;
          log.info("task injection restarted: the user typed during the runner's write", {
            sessionId: workerSessionId,
            restarts: 1,
            ...this.#politeLogContext(workerSessionId),
          });
          void this.#deliverTaskEndedNoticePolitely(workspace, workerSessionId, message);
          return;
        }
        this.#writeToSession!(workerSessionId, "\r");
        log.debug("stop message sent to Worker", { workspaceId: workspace.id });
      }, 200);
    }, 2000);
  }

  async #deliverTaskEndedNoticePolitely(
    workspace: TaskWorkspaceState,
    sessionId: string,
    message: string,
  ): Promise<void> {
    const current = this.#findTaskWorkspace(workspace.id);
    if (!current) return;
    const generation = this.#beginSessionInjection(sessionId, current);
    if (!generation) return;
    const strategy = this.#resolveInjectionStrategy(sessionId, current);
    await this.#writeAndSubmit(sessionId, message, strategy, generation, generation.signal);
    if (this.#isCurrentInjection(sessionId, generation)) {
      log.debug("stop message sent to Worker", { workspaceId: workspace.id });
    }
  }

  /**
   * Answer an on-screen dialog with Enter (Claude's rate-limit options, whose
   * default is "wait for the limit to reset") — the one deliberate exception
   * to the rule in #politeWaitReason. Only the user's hands have to be off
   * the keyboard (step a): the agent is not idle while the dialog is up, so
   * waiting for its turn to end would wait forever. A dialog the agent
   * reported, or an uncertain screen, still holds it back.
   */
  #pressDialogEnter(workspace: TaskWorkspaceState, sessionId: string): void {
    if (!this.#writeToSession) return;
    if (this.#politeWaitReason(sessionId, { quietOnly: true }) === null) {
      this.#writeToSession(sessionId, "\r");
      return;
    }
    const generation = this.#beginSessionInjection(sessionId, workspace);
    if (!generation) return;
    void this.#awaitPoliteWindow(sessionId, generation, { quietOnly: true }).then((ready) => {
      if (ready && this.#isCurrentInjection(sessionId, generation)) {
        this.#writeToSession!(sessionId, "\r", generation.signal);
      }
    });
  }

  #formatElapsed(ms: number): string {
    const totalSeconds = Math.round(ms / 1000);
    const h = Math.floor(totalSeconds / 3600);
    const m = Math.floor((totalSeconds % 3600) / 60);
    const s = totalSeconds % 60;
    if (h > 0) return `${h}h ${m}m`;
    if (m > 0) return `${m}m ${s}s`;
    return `${s}s`;
  }

  /**
   * Raise a user-visible alert for a task event.
   */
  #raiseTaskAlert(workspace: TaskWorkspaceState, kind: "completed" | "failed", reason?: string): void {
    if (!this.#raiseAlert) return;
    const task = workspace.task;
    const rounds = task.currentRound || 0;
    const roundLabel = rounds ? `${rounds} round${rounds !== 1 ? "s" : ""}` : "";
    const endTime = task.finishedAt ? (task.finishedAt as unknown as number) : Date.now();
    const elapsedMs = task.startedAt
      ? Math.max(0, endTime - (task.startedAt as unknown as number) - (task.totalPausedMs || 0))
      : 0;
    const elapsedLabel = elapsedMs ? this.#formatElapsed(elapsedMs) : "";
    const statsInfo = [roundLabel, elapsedLabel].filter(Boolean).join(", ");
    const base = reason ? `task-${kind}: ${reason}` : `task-${kind}`;
    const detail = statsInfo ? `${base} — ${statsInfo}` : base;
    // Task completed = normal urgency (you can check it later).
    // Task failed/crashed = urgent — otherwise a broken task sits silent
    // and defeats the point of running it unattended.
    const urgency = kind === "completed" ? "normal" : "urgent";
    log.info("raising task alert", { workspaceId: workspace.id, kind, detail, urgency });
    this.#raiseAlert({
      projectId: workspace.id,
      panelId: task.workerPanelId,
      // Attached-aware: the alert must point at wherever the Primary
      // session actually lives, not always this task workspace's own id.
      sessionId: sessionIdFor(workspace, "worker"),
      title: formatWorkspaceDisplayName(workspace),
      kind: kind === "completed" ? "completed" : "waiting",
      tier: 1,
      urgency,
      detail,
    });
  }

  /**
   * Append a user-facing event to TASK_LOG.jsonl in the task directory.
   * This is NOT the system log (winston) — it's a human-readable audit trail
   * that the user can review in the Dashboard Files tab.
   *
   * Each line is a JSON object: { ts, event, round?, detail? }
   */
  async #logTaskEvent(workspace: TaskWorkspaceState, event: string, detail?: string): Promise<void> {
    const task = workspace?.task;
    if (!workspace?.cwd || !task?.taskId) return;

    const entry: Record<string, unknown> = {
      ts: new Date().toISOString(),
      event,
      round: task.currentRound || 0,
      ...(detail ? { detail } : {}),
    };

    const logPath = path.join(taskDir(workspace.cwd, task.taskId), TASK_LOG_FILE);
    try {
      await writeFile(logPath, JSON.stringify(entry) + "\n", { encoding: "utf8", flag: "a" });
    } catch (err: unknown) {
      log.debug("failed to write task event log", { logPath, err: (err as Error)?.message });
    }
  }
}
