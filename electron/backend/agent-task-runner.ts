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
  PROMPT_FILE,
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
  writeToSession: (sessionId: string, data: string) => void;
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

type TaskBindingRole = "worker" | "judge";

interface TaskBinding {
  workspace: TaskWorkspaceState;
  task: RuntimeTaskState;
  role: TaskBindingRole;
}

/**
 * Canonical session id for a task workspace's worker/"Primary" or
 * judge/"Companion" role. Standard tasks: both roles live in the task
 * workspace itself, so this returns exactly what every call site used to
 * hardcode inline. Attached (Companion loop) tasks: the worker/"Primary"
 * role is an EXTERNALLY OWNED session living in a different workspace
 * (`task.workerWorkspaceId`) — every write path (inject/clear/restart/alert)
 * must go through this helper instead of hardcoding
 * `${workspace.id}:${task.workerPanelId}`.
 */
export function sessionIdFor(workspace: TaskWorkspaceState, role: TaskBindingRole): string {
  const task = workspace.task;
  if (role === "judge") return `${workspace.id}:${task.judgePanelId}`;
  if (task.mode === "attached" && task.workerWorkspaceId) {
    return `${task.workerWorkspaceId}:${task.workerPanelId}`;
  }
  return `${workspace.id}:${task.workerPanelId}`;
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
  /** workspaceIds whose companion verdict is being handled right now — the
   *  attached-mode counterpart of #evaluating. #handleCompanionVerdict awaits
   *  a disk read and (on "continue") a work-lock recreate and a template write
   *  before it moves the task out of judge-evaluating, so two idle signals
   *  arriving back to back would otherwise both pass the state check and each
   *  inject a round into the Primary. */
  #handlingCompanionVerdict = new Map<string, boolean>();
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
  /** per-cwd git init locks to prevent concurrent init */
  #gitInitLocks = new Map<string, Promise<boolean>>();
  /** workspaceIds with a headless programmatic judge in flight */
  #programmaticJudges = new Set<string>();
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
  /** Krok 8 — fs.watch fallback watchers on task dirs, keyed by workspaceId. */
  #taskDirWatchers = new Map<string, { close: () => void }>();
  /** Krok 9 — per-role rate-limit hold expiry for the judge (worker hold is
   * task.rateLimitedUntil). Keyed by workspaceId. */
  #judgeRateLimitedUntil = new Map<string, number>();
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
  }): TaskWorkspaceState {
    const workspaceId = `workspace-${randomUUID()}`;
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
        taskId: randomUUID(),
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
    const state = this.#getState?.();
    const workspace = state?.workspaces.find((w) => w.id === workspaceId);
    if (!workspace || !isTaskWorkspace(workspace)) {
      log.warn("startTask: workspace not found or not a task workspace", { workspaceId });
      return false;
    }

    if (workspace.task.mode === "attached") {
      return this.#startAttachedTask(workspace);
    }

    const task = workspace.task;
    if (task.state === "running" || task.state === "evaluating" || task.state === "judge-evaluating") {
      log.debug("startTask: already running", { workspaceId, state: task.state });
      return false;
    }

    // Ensure a git repo exists so the judge can see diffs/status.
    // If the directory has no .git, we run `git init` + initial commit.
    // This is read-only from the perspective of the user's work — we never push.
    await ensureGitRepo(workspace.cwd, { execCommand, gitInitLocks: this.#gitInitLocks, log });

    // Provider-specific setup (e.g. Gemini writes yolo policy file)
    try {
      const workerProviderConfig = task.workerProviderConfig || { providerId: "claude", model: "sonnet" };
      const judgeProviderConfig = task.judgeProviderConfig || { providerId: "claude", model: "opus" };
      const workerProv = getProvider(workerProviderConfig.providerId);
      await workerProv.beforeStart(workspace.cwd);
      if (judgeProviderConfig.providerId !== workerProviderConfig.providerId) {
        const judgeProv = getProvider(judgeProviderConfig.providerId);
        await judgeProv.beforeStart(workspace.cwd);
      }
    } catch (err: unknown) {
      log.warn("startTask: provider beforeStart failed (non-fatal)", {
        workspaceId,
        err: (err as Error)?.message,
      });
    }

    this.#setTaskState(task, "running");
    task.currentRound = 1;
    task.rounds = [];
    this.#ensureRunningRound(task);

    // Refresh task.description from TASK.md so manual edits via the Assignment
    // tab take effect on the next Start. Without this, the user can press
    // Reset, rewrite the brief, press Start — and the worker still gets the
    // original description because the in-memory copy never updates.
    try {
      const fresh = await readTaskDescription(workspace.cwd, task.taskId);
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
    const workerSessionId = `${workspaceId}:${task.workerPanelId}`;
    await this.#ensureFormatFlag(task, workspace);

    // After a Reset (or any other path that flips needsContextClear), wipe
    // the Worker and Judge conversational context before we inject the new
    // prompt. This keeps a re-run on a tweaked brief from being shadowed by
    // the agent's memory of the previous attempt. Best-effort — providers
    // that don't recognize `/clear` (none today, but tolerated) just see the
    // command as a stray line and ignore it.
    if (task.needsContextClear) {
      const judgeSessionId = `${workspaceId}:${task.judgePanelId}`;
      try {
        await Promise.all([
          this.#clearSessionContext(workerSessionId, workspace),
          this.#clearSessionContext(judgeSessionId, workspace),
        ]);
        log.info("task start: cleared Worker + Judge context after reset", { workspaceId });
        void this.#logTaskEvent(workspace, "context-cleared", "Sent /clear to Worker and Judge before initial prompt");
      } catch (err: unknown) {
        log.warn("task start: context clear failed (proceeding anyway)", {
          workspaceId,
          err: (err as Error)?.message,
        });
      }
      task.needsContextClear = false;
    }

    const prompt = buildInitialWorkerPrompt(task);
    await this.#injectPrompt(workerSessionId, prompt, workspace);
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

    // Krok 4 — capture the pre-pause state for a correct Continue.
    workspace.task.pausedFromState = workspace.task.state;
    this.#setTaskState(workspace.task, "paused");
    this.#evaluating.delete(workspaceId);
    log.info("task paused", { workspaceId });
    void this.#logTaskEvent(workspace, "task-paused");
    this.#broadcastState!();
    return true;
  }

  /**
   * Called by app-restart recovery (resolveTaskRecovery) when an attached
   * task's source workspace/panel no longer exists. The task is already
   * left paused with pausedFromState set — this just adds the truthful,
   * visible "Primary conversation no longer exists" signal instead of the
   * silent pause that used to be the only trace (plan §8.7 step 5).
   */
  markAttachedSourceMissing(workspaceId: string): void {
    const workspace = this.#findTaskWorkspace(workspaceId);
    if (!workspace || workspace.task.mode !== "attached") return;
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

    // Krok 3 — resume actively reconciles against on-disk state instead of
    // passively flipping the badge and waiting for an idle hook that may never
    // arrive (incident A: "nothing happened"). All the disk reads are async, so
    // run it fire-and-forget; resumeTask stays synchronous for its callers.
    this.#reconcileAfterResume(workspace, { previousState, pausedFromState, resumeTo }).catch((err: unknown) => {
      log.error("reconcileAfterResume failed", { workspaceId, err: (err as Error)?.message });
    });

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
    workspace: TaskWorkspaceState,
    { previousState, pausedFromState, resumeTo }: { previousState: string; pausedFromState: string; resumeTo: string },
  ): Promise<void> {
    const task = workspace.task;
    const workspaceId = workspace.id;

    if (task.mode === "attached") {
      return this.#reconcileAttachedAfterResume(workspace, { previousState, pausedFromState, resumeTo });
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
    const verdictPresent = verdict.reason !== "Judge did not produce a verdict file.";
    const rounds = task.rounds as unknown as TaskRound[];
    const lastRound = rounds?.[rounds.length - 1];
    const lastRoundUnjudged = !lastRound || !lastRound.judgeVerdict;
    if (verdictPresent && lastRoundUnjudged) {
      log.info("reconcileAfterResume: unread verdict on disk — processing", { workspaceId, verdict: verdict.verdict });
      if (task.state !== "judge-evaluating") this.#setTaskState(task, "judge-evaluating");
      void this.#logTaskEvent(
        workspace,
        "task-resumed-reconcile",
        `Unread verdict on disk (${verdict.verdict}) — processing it.`,
      );
      this.#broadcastState!();
      await this.#handleJudgeVerdict(workspace, "resume-reconcile");
      return;
    }

    // 2. Was judge-evaluating, no verdict → re-run evaluation to rebuild a
    // self-contained judge prompt (checks pass: WORK_LOCK is gone).
    if (resumeTo === "judge-evaluating" || pausedFromState === "judge-evaluating") {
      log.info("reconcileAfterResume: judge-evaluating with no verdict — re-running evaluation", { workspaceId });
      task.judgeNudged = false;
      if (task.state !== "running") this.#setTaskState(task, "running");
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
      await this.#injectPrompt(workerSessionId, prompt, workspace);
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
    await this.#injectPrompt(workerSessionId, continuation, workspace);
  }

  /**
   * Reset a task to idle state — clears round history, recreates WORK_LOCK,
   * and returns to a clean starting point. Used for "Reset & Retry".
   */
  async resetTask(workspaceId: string): Promise<boolean> {
    const workspace = this.#findTaskWorkspace(workspaceId);
    if (!workspace) return false;
    // "brief-ready" is attached-only (never produced for standard tasks) —
    // plan §4.13 allows resetting+recreating from that paused-equivalent state.
    const resettable = new Set(["paused", "completed", "failed", "brief-ready"]);
    if (!resettable.has(workspace.task.state)) return false;

    const task = workspace.task;
    const previousState = task.state;
    const isAttached = task.mode === "attached";

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

    if (!isAttached) {
      await this.#recreateWorkLock(workspace, "reset");
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
    this.#rejectingVerdict.add(workspaceId);
    try {
      return await this.#rejectTaskVerdict(workspace, feedback);
    } finally {
      this.#rejectingVerdict.delete(workspaceId);
    }
  }

  async #rejectTaskVerdict(workspace: TaskWorkspaceState, feedback: string): Promise<boolean> {
    const workspaceId = workspace.id;
    const task = workspace.task;
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

    // Everything below the prompt build mutates the round bookkeeping the
    // prompt itself quotes ("Round N/M"), so the mutation has to come first —
    // and be fully undoable. Restoring only `state` (all this used to do) left
    // the round consumed and the chip pushed, so a retry after a failed
    // injection silently skipped a round and stacked up phantom chips.
    const previousState = task.state;
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
    if (lastRound) lastRound.action = "re-prompted";

    // Single undo path for everything this method touches, disk included —
    // both failure points below (staging the verification artifacts and
    // injecting the prompt) leave the task exactly as they found it.
    let restoreVerification: (() => Promise<void>) | null = null;
    // Returns whether the on-disk evidence made it back. A disk failure there
    // must not cost the in-memory undo as well, so the bookkeeping restore runs
    // in `finally` — the task returns to its verdict either way, and the caller
    // tells the user which of the two happened.
    const rollback = async (): Promise<{ verificationRestored: boolean }> => {
      let verificationRestored = true;
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
      } finally {
        task.currentRound = snapshot.currentRound;
        task.maxRounds = snapshot.maxRounds;
        task.lastJudgeInstructions = snapshot.lastJudgeInstructions;
        task.companionLastFeedbackAt = snapshot.companionLastFeedbackAt;
        if (rounds && rounds.length > snapshot.roundCount) rounds.length = snapshot.roundCount;
        if (lastRound) lastRound.action = snapshot.lastRoundAction;
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
    await this.#recreateWorkLock(workspace, "rejectVerdict");

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
    this.#ensureRunningRound(task);

    await this.#ensureFormatFlag(task, workspace);
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
        restoreVerification = await writeVerificationTemplateReversibly(
          workspace.cwd,
          task.taskId,
          task.currentRound,
          log,
        );
      } catch (err: unknown) {
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

    try {
      await this.#injectPrompt(workerSessionId, prompt, workspace);
    } catch (err: unknown) {
      log.error("rejectTaskVerdict: failed to inject prompt", { workspaceId, err: (err as Error)?.message });
      const { verificationRestored } = await rollback();
      const target = task.mode === "attached" ? "Primary conversation" : "Worker";
      void this.#logTaskEvent(
        workspace,
        "verdict-reject-failed",
        verificationRestored
          ? `Could not deliver your feedback to the ${target} — the verdict stands, try again.`
          : `Could not deliver your feedback to the ${target} — the verdict stands, but ${VERIFICATION_FILE} could NOT be put back and now holds an empty template. Check it before sending back again.`,
      );
      this.#broadcastState!();
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
      this.#writeToSession(sessionId, "\r");
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
        await this.#restartSession(sessionId);
        task.promptSent = false;
        this.#broadcastState!();
      } catch (err) {
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
      await this.#injectPrompt(sessionId, resumePrompt, workspace);
    } catch (err) {
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
      this.#writeToSession(sessionId, "\r");
    }
    return this.#handleRateLimited(workspace, sessionId, match, source, "judge");
  }

  /** Krok 9b/9c — judge hold expired: process a verdict if present, else nudge
   * the judge to continue its evaluation and write the verdict. */
  async #resumeJudgeFromRateLimit(workspaceId: string): Promise<void> {
    const workspace = this.#findTaskWorkspace(workspaceId);
    if (!workspace) return;
    const task = workspace.task;
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
      if (result.status === "valid") {
        // Verdict already on disk — process it regardless of the (now-expired) hold.
        await this.#handleCompanionVerdict(workspace, "judge-rate-limit-resume");
        return;
      }
      await this.#injectPrompt(judgeSessionId, resumePrompt, workspace);
      return;
    }

    const verdict = await readVerdict(workspace.cwd, task.taskId, log);
    if (verdict.reason !== "Judge did not produce a verdict file.") {
      // Verdict already on disk — process it regardless of the (now-expired) hold.
      await this.#handleJudgeVerdict(workspace, "judge-rate-limit-resume");
      return;
    }
    await this.#injectPrompt(judgeSessionId, resumePrompt, workspace);
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
    const dir = taskDir(workspace.cwd, workspace.task.taskId);
    try {
      await access(dir);
    } catch {
      return; // task dir not initialized — hooks + resume reconcile cover it
    }

    let debounceTimer: NodeJS.Timeout | null = null;
    let graceTimer: NodeJS.Timeout | null = null;
    let watcher: FSWatcher | null = null;
    let pollTimer: NodeJS.Timeout | null = null;
    let closed = false;

    const armGrace = (delayMs: number, fire: () => Promise<void>) => {
      if (graceTimer) return; // one grace window at a time
      graceTimer = setTimeout(() => {
        graceTimer = null;
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
        void this.#reconcileFromWatcher(workspaceId, armGrace);
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

    this.#taskDirWatchers.set(workspaceId, {
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
    });
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
    workspaceId: string,
    armGrace: (delayMs: number, fire: () => Promise<void>) => void,
  ): Promise<void> {
    const workspace = this.#findTaskWorkspace(workspaceId);
    if (!workspace) return;
    const task = workspace.task;

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
      if (result.status !== "valid") return;
      // Per-evaluation marker, not lastRound.judgeVerdict: the same round is
      // evaluated again after a needs-input answer or a withheld completion,
      // and the chip still carries the previous evaluation's verdict — reading
      // that as "already processed" stranded the task in judge-evaluating
      // forever whenever the idle hook was the one that went missing.
      if (this.#companionVerdictAlreadyHandled(task)) return;
      armGrace(AgentTaskRunner.WATCH_VERDICT_GRACE_MS, async () => {
        const ws = this.#findTaskWorkspace(workspaceId);
        if (!ws || ws.task.state !== "judge-evaluating") return;
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
      if (verdict.reason === "Judge did not produce a verdict file.") return;
      const rounds = task.rounds as unknown as TaskRound[];
      const lastRound = rounds?.[rounds.length - 1];
      if (lastRound && lastRound.judgeVerdict) return; // already processed
      armGrace(AgentTaskRunner.WATCH_VERDICT_GRACE_MS, async () => {
        const ws = this.#findTaskWorkspace(workspaceId);
        if (!ws || ws.task.state !== "judge-evaluating") return;
        const r = ws.task.rounds as unknown as TaskRound[];
        const lr = r?.[r.length - 1];
        if (lr && lr.judgeVerdict) return; // a hook handled it during the grace
        const v = await readVerdict(ws.cwd, ws.task.taskId, log);
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
      if (!validation.ok) return;
      armGrace(AgentTaskRunner.WATCH_VERDICT_GRACE_MS, async () => {
        const ws = this.#findTaskWorkspace(workspaceId);
        if (!ws || ws.task.state !== "capturing-context") return;
        const revalidation = await validateCaptureFiles(ws.cwd, ws.task.taskId, {
          sinceIso: ws.task.captureStartedAt || null,
        });
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
      armGrace(AgentTaskRunner.WATCH_WORKLOCK_GRACE_MS, async () => {
        const ws = this.#findTaskWorkspace(workspaceId);
        if (!ws || ws.task.state !== "running") return;
        if (this.#evaluating.has(workspaceId)) return;
        if (!(await this.isWorkerCompleted(workspaceId))) return;
        log.warn("watcher backstop: WORK_LOCK absent but no primary hook — evaluating", { workspaceId });
        void this.#logTaskEvent(ws, "watcher-worklock", "WORK_LOCK absent (watcher, no idle hook) — evaluating.");
        await this.#evaluateCompanionRound(ws);
      });
      return;
    }

    if (task.state === "running" && task.promptSent) {
      if (!(await this.isWorkerCompleted(workspaceId))) return;
      armGrace(AgentTaskRunner.WATCH_WORKLOCK_GRACE_MS, async () => {
        const ws = this.#findTaskWorkspace(workspaceId);
        if (!ws || ws.task.state !== "running") return;
        if (this.#evaluating.has(workspaceId)) return; // a hook started eval already
        if (!(await this.isWorkerCompleted(workspaceId))) return; // lock came back
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
  async #ensureFormatFlag(task: TaskState, workspace: TaskWorkspaceState): Promise<void> {
    if (task.useWorkerFile === undefined) {
      task.useWorkerFile = await taskHasWorkerFile(workspace.cwd, task.taskId);
    }
  }

  async #recreateWorkLock(workspace: TaskWorkspaceState, context: string): Promise<void> {
    try {
      const dir = taskDir(workspace.cwd, workspace.task.taskId);
      await writeFile(
        path.join(dir, WORK_LOCK_FILE),
        "Work remains. Remove this file only when the task is complete and all verification steps pass.\n",
        "utf8",
      );
      log.debug("WORK_LOCK recreated", { workspaceId: workspace.id, context });
    } catch (err: unknown) {
      log.warn("failed to recreate WORK_LOCK", {
        workspaceId: workspace.id,
        context,
        err: (err as Error)?.message,
      });
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
      void this.#performWorkLockOverrideCheck(workspaceId, "periodic-probe");
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
    // All of these must still hold for the override to be the right action;
    // otherwise the hold either already cleared, the task moved to a state
    // where evaluation isn't appropriate (paused/completed/failed), or the
    // worker is genuinely still working and will keep the lock around.
    if (!task.rateLimitedUntil) return;
    if (task.state !== "running") return;
    if (!(await this.isWorkerCompleted(workspaceId))) return;

    log.warn("rate-limit override: WORK_LOCK absent — worker signaled completion", {
      workspaceId,
      sessionId,
    });
    task.rateLimitedUntil = null;
    this.#clearRateLimitResumeTimer(workspaceId, "worker");
    this.#rateLimitCtx.delete(this.#rlKey(workspaceId, "worker"));
    this.#stopPeriodicWorkLockProbe(workspaceId);
    void this.#logTaskEvent(
      workspace,
      "worker-rate-limit-overridden",
      "WORK_LOCK absent — worker signaled completion. Clearing rate-limit hold and starting evaluation.",
    );
    this.#broadcastState!();

    try {
      await this.#evaluateWorker(workspace);
    } catch (err: unknown) {
      log.error("evaluateWorker error during rate-limit override", {
        workspaceId,
        err: (err as Error)?.message,
      });
    }
  }

  /**
   * Called when a session exits — if it's a worker session, pause the task.
   */
  onSessionExit(sessionId: string): void {
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
      await this.#restartSession(sessionId);
    } catch (err) {
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
    // Krok 1 — this hook also fires for prompts WE inject, so it doubles as the
    // submit-confirmation signal: release any waiter parked by #injectPrompt.
    this.#resolveSubmitWaiters(sessionId);
    // If task is paused and user is taking over, leave it paused — don't
    // resume automatically.  The user can click Continue when ready.
    void this.#logTaskEvent(workspace, "user-prompt-submit", "User submitted a prompt");
    return true;
  }

  /**
   * Called from runtime.writeToSession when user types into a task workspace panel.
   * Auto-pauses the task runner to avoid conflicts with user input.
   *
   * Only pauses when input targets the CURRENTLY ACTIVE agent panel:
   * - evaluating/refreshing → only worker panel input pauses
   * - judge-evaluating → only judge panel input pauses
   * This prevents accidental pauses from clicking on the idle panel
   * (e.g. focus events from xterm.js when switching between panels).
   */
  onUserInput(sessionId: string): void {
    const binding = this.#resolveTaskBinding(sessionId);
    if (!binding) return;
    const { workspace, task, role } = binding;
    const workspaceId = workspace.id;

    // Only pause if input targets the panel that the task runner is actively
    // driving. Attached-only: input into the Primary during capturing-context
    // also pauses the capture (plan §6.2 manual-input rules) — that state
    // never occurs for standard tasks, so this is additive, not a behavior
    // change for them.
    const isWorkerInput = role === "worker";
    const isJudgeInput = role === "judge";
    const shouldPause =
      ((task.state === "evaluating" || task.state === "refreshing" || task.state === "capturing-context") &&
        isWorkerInput) ||
      (task.state === "judge-evaluating" && isJudgeInput);

    if (shouldPause) {
      task.pausedFromState = task.state;
      this.#setTaskState(task, "paused");
      this.#evaluating.delete(workspaceId);
      log.info("user input detected during evaluation, task paused", {
        workspaceId,
        sessionId,
        role,
        pausedFromState: task.pausedFromState,
      });
      this.#broadcastState!();
    }
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
  // Interruption check — used by evaluation loops to bail out early when
  // the user pauses, resets, or the session exits mid-evaluation.
  // ---------------------------------------------------------------------------

  #wasInterrupted(workspaceId: string, expectedStates: Set<string>): boolean {
    if (!this.#evaluating.has(workspaceId)) return true;
    const workspace = this.#findTaskWorkspace(workspaceId);
    if (!workspace) return true;
    return !expectedStates.has(workspace.task.state);
  }

  // ---------------------------------------------------------------------------
  // Worker evaluation
  // ---------------------------------------------------------------------------

  async #evaluateWorker(workspace: TaskWorkspaceState): Promise<void> {
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

    // Effect.acquireRelease ensures #evaluating is always cleared even on
    // unexpected errors — replaces the manual try/finally pattern.
    await runEffect(
      Effect.scoped(
        Effect.acquireRelease(
          Effect.sync(() => {
            this.#evaluating.add(workspaceId);
            return workspaceId;
          }),
          (id) =>
            Effect.sync(() => {
              this.#evaluating.delete(id);
              this.#programmaticJudges.delete(id);
            }),
        ).pipe(Effect.flatMap(() => Effect.promise(() => this.#evaluateWorkerBody(workspace)))),
      ),
    ).catch((err: unknown) => {
      log.error("evaluateWorker failed", { workspaceId, err: (err as Error)?.message });
      // Krok 4 — capture the state we fell from (evaluating/judge-evaluating) so
      // a later Continue resumes to the right place.
      task.pausedFromState = task.state;
      this.#setTaskState(task, "paused");
      void this.#logTaskEvent(
        workspace,
        "evaluation-error",
        `Evaluation failed: ${(err as Error)?.message || "unknown"}`,
      );
      this.#broadcastState!();
    });
  }

  async #evaluateWorkerBody(workspace: TaskWorkspaceState): Promise<void> {
    const task = workspace.task;
    const workspaceId = workspace.id;

    const evalStart = Date.now();
    this.#setTaskState(task, "evaluating");
    this.#broadcastState!();

    // A "running" round was pushed when the worker iteration began (by
    // startTask / onAgentIdle first inject / re-prompt / shower). Reuse it
    // so the chip's identity doesn't change between "currently working" and
    // "being evaluated" — only the action label updates.
    const round = this.#ensureRunningRound(task);
    round.action = "evaluating";
    round.checks = [];
    round.judgeVerdict = null;
    round.judgeReason = "";

    // Built-in checks: WORK_LOCK + TODO.md sections (always run, cheap)
    const builtInChecks = await runBuiltInChecks(workspace.cwd, task.taskId, { execCommand, log });
    round.checks.push(...(builtInChecks as CheckResult[]));
    this.#broadcastState!(); // Stream built-in results to UI
    for (const c of builtInChecks) {
      log.debug("built-in check", { workspaceId, check: c.label, passed: c.passed });
    }

    // Bail out if user paused/reset during built-in checks
    if (this.#wasInterrupted(workspaceId, new Set(["evaluating"]))) {
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
    if (this.#wasInterrupted(workspaceId, new Set(["evaluating"]))) {
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
        if (showerOk) {
          this.#setTaskState(task, "running");
          round.action = "running";
          log.info("shower completed, waiting for refreshed worker", { workspaceId });
          void this.#logTaskEvent(workspace, "shower-completed", "Worker session restarted with fresh context");
        } else {
          log.warn("shower failed, falling back to normal re-prompt", { workspaceId });
          void this.#logTaskEvent(workspace, "shower-failed", "Handoff not written in time, falling back to re-prompt");
          await this.#ensureFormatFlag(task, workspace);
          const prompt = buildRePrompt(task, round);
          const workerSessionId = `${workspaceId}:${task.workerPanelId}`;
          await this.#injectPrompt(workerSessionId, prompt, workspace);
          this.#setTaskState(task, "running");
          round.action = "running";
        }
      } else {
        await this.#ensureFormatFlag(task, workspace);
        const prompt = buildRePrompt(task, round);
        const workerSessionId = `${workspaceId}:${task.workerPanelId}`;
        await this.#injectPrompt(workerSessionId, prompt, workspace);
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
      task.judgeNudged = false;

      // Gather git context so the judge can see actual repo changes
      const gitContext = await getGitContext(workspace.cwd, { execCommand, log });
      const gitContextMs = Date.now() - judgeSetupStart;

      const judgeSessionId = `${workspaceId}:${task.judgePanelId}`;
      await this.#ensureFormatFlag(task, workspace);
      const judgePrompt = await buildJudgePrompt(task, round, gitContext, workspace.cwd);
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
        if (this.#wasInterrupted(workspaceId, new Set(["judge-evaluating"]))) {
          log.info("programmatic judge interrupted before verdict handling", { workspaceId });
          return;
        }
        task.judgeNudged = true;
        await this.#handleJudgeVerdict(workspace, "programmatic");
        this.#programmaticJudges.delete(workspaceId);
        return;
      }

      // Clear judge context for independent evaluation, then inject prompt
      await this.#clearSessionContext(judgeSessionId, workspace);
      await this.#injectPrompt(judgeSessionId, judgePrompt, workspace);
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

  async #handleJudgeVerdict(workspace: TaskWorkspaceState, source = "manual"): Promise<void> {
    const task = workspace.task;
    const workspaceId = workspace.id;
    const judgeSessionId = `${workspaceId}:${task.judgePanelId}`;
    // Krok 2 — an idle_prompt Notification (Claude's 60s "waiting for input")
    // is NOT proof the turn ended: our prompt may just be sitting unsubmitted in
    // the composer. Treat it as "keep waiting", never as a turn boundary.
    const isIdlePromptOnly = source.includes("idle_prompt") || source.includes("notification");

    try {
      const verdict = await readVerdict(workspace.cwd, task.taskId, log);
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
        // the verdict as text instead of writing the file.
        if (!task.judgeNudged) {
          task.judgeNudged = true;
          const dir = taskDirRel(task.taskId);
          // Krok 10 — the example shows "continue", not "complete": a fresh judge
          // with no context tends to copy the example verbatim, and "bias toward
          // continue" (JUDGE_PROMPT.md) means an unsure judge must NOT
          // rubber-stamp unevaluated work as complete.
          const nudge = `You MUST write your verdict to ${dir}/${VERDICT_FILE} as a JSON file now. Use the Write tool or cat/heredoc. Example:\n\n{"verdict": "continue", "reason": "Describe what still needs work."}\n\nWrite the file now.`;
          log.info("judge verdict file missing, sending nudge", { workspaceId });
          void this.#logTaskEvent(workspace, "judge-nudged", "Verdict file missing — reminded Judge to write it");
          await this.#injectPrompt(judgeSessionId, nudge, workspace);
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
        log.warn("judge verdict file missing after nudge", { workspaceId, round: task.currentRound });
        task.pausedFromState = "judge-evaluating"; // Krok 4 — resume reads the verdict
        this.#setTaskState(task, "paused");
        void this.#logTaskEvent(
          workspace,
          "judge-give-up",
          "Judge produced no verdict after nudge + Stop (not busy) — pausing.",
        ); // Krok 2/7
        this.#broadcastState!();
        this.#raiseTaskAlert(workspace, "failed", "Judge did not produce a verdict file");
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
      // Note: #wasInterrupted checks #evaluating set which is only used by
      // #evaluateWorker, so we check the task state directly here.
      if (task.state !== "judge-evaluating") {
        log.info("judge verdict handling interrupted (state changed)", { workspaceId, taskState: task.state });
        return;
      }

      const rounds = task.rounds as unknown as TaskRound[];
      const lastRound = rounds[rounds.length - 1];
      if (lastRound) {
        lastRound.judgeVerdict = verdict.verdict;
        lastRound.judgeReason = verdict.reason || "";
      }

      if (verdict.verdict === "complete") {
        this.#setTaskState(task, "completed");
        if (lastRound) lastRound.action = "completed";
        log.info("task completed by judge verdict", { workspaceId, rounds: task.currentRound });
        void this.#logTaskEvent(workspace, "task-completed", verdict.reason || "Judge approved");
        this.#raiseTaskAlert(workspace, "completed", verdict.reason ? `Judge: ${verdict.reason}` : undefined);
        // Tell the Worker to stop — otherwise Claude Code continues autonomously
        this.#notifyWorkerTaskEnded(workspace, "completed");
      } else {
        // "continue" — re-prompt worker with judge feedback
        // Preserve judge instructions for shower mode (survives session restart)
        if (verdict.reason) {
          task.lastJudgeInstructions = verdict.reason;
          log.debug("stored judge instructions for potential shower", {
            workspaceId,
            reasonLength: verdict.reason.length,
          });
        }

        if (task.currentRound >= task.maxRounds) {
          this.#setTaskState(task, "failed");
          if (lastRound) lastRound.action = "failed";
          log.info("task failed: max rounds after judge", { workspaceId, rounds: task.currentRound });
          void this.#logTaskEvent(workspace, "task-failed", `Max rounds after judge. ${verdict.reason || ""}`);
          this.#raiseTaskAlert(workspace, "failed", `Max rounds reached. Judge: ${verdict.reason || "incomplete"}`);
          this.#notifyWorkerTaskEnded(workspace, "failed");
        } else {
          // Judge sent the worker back — this starts a new round. The worker
          // removed WORK_LOCK at the end of the previous round (that's how it
          // signaled completion), so put it back BEFORE injecting the prompt.
          // Otherwise the worker reads an absent lock and mistakes the next
          // round for "task already done", refusing to do further work.
          await this.#recreateWorkLock(workspace, "judgeVerdict-continue");

          await this.#ensureFormatFlag(task, workspace);
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const prompt = buildJudgeFeedbackPrompt(task, verdict as any);
          const workerSessionId = `${workspaceId}:${task.workerPanelId}`;
          // Clear worker context before each new round so the agent starts fresh
          // without accumulating stale context from prior rounds.
          try {
            await this.#clearSessionContext(workerSessionId, workspace);
          } catch (err: unknown) {
            log.warn("worker context clear before new round failed (proceeding)", {
              workspaceId,
              err: (err as Error)?.message,
            });
          }
          await this.#injectPrompt(workerSessionId, prompt, workspace);
          this.#setTaskState(task, "running");
          if (lastRound) lastRound.action = "re-prompted";
          task.currentRound += 1;
          this.#ensureRunningRound(task);
          log.info("worker re-prompted with judge feedback", { workspaceId, round: task.currentRound });
          void this.#logTaskEvent(
            workspace,
            "worker-reprompted",
            `Judge feedback: ${verdict.reason || "continue working"}`,
          );
        }
      }

      this.#broadcastState!();
    } catch (err: unknown) {
      log.error("handleJudgeVerdict failed", { workspaceId, err: (err as Error)?.message });
      // Krok 4 — resume should re-read the verdict, so record judge-evaluating.
      task.pausedFromState = "judge-evaluating";
      this.#setTaskState(task, "paused");
      void this.#logTaskEvent(
        workspace,
        "judge-error",
        `Verdict handling failed: ${(err as Error)?.message || "unknown"}`,
      );
      this.#broadcastState!();
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
  async #startAttachedTask(workspace: TaskWorkspaceState): Promise<boolean> {
    const task = workspace.task;
    const workspaceId = workspace.id;

    // Both branches below inject into the Primary — neither may run once the
    // conversation this task is bound to is known to be gone.
    if (!this.#assertAttachedPrimaryAvailable(workspace, "Start")) return false;

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
        await this.#injectPrompt(sessionId, prompt, workspace);
      } catch (err: unknown) {
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
      void this.#logTaskEvent(workspace, "baseline-started", "Baseline companion evaluation requested.");
      this.#broadcastState!();
      await this.#requestCompanionEvaluation(workspace, "baseline", null);
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
  async #checkCaptureReadiness(workspace: TaskWorkspaceState, sessionId: string): Promise<void> {
    const task = workspace.task;
    if (task.state !== "capturing-context") return;
    const validation = await validateCaptureFiles(workspace.cwd, task.taskId, {
      sinceIso: task.captureStartedAt || null,
    });
    // Re-check after the async read: a pause/reset may have landed while we
    // were reading the capture files from disk.
    if (task.state !== "capturing-context") return;

    if (validation.ok) {
      this.#setTaskState(task, "brief-ready");
      log.info("attached task: capture complete", { workspaceId: workspace.id });
      void this.#logTaskEvent(
        workspace,
        "context-captured",
        "CONTEXT.md and HANDOFF.md captured — brief ready for review.",
      );
      this.#broadcastState!();
      return;
    }

    if (!task.captureNudged) {
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
      try {
        await this.#injectPrompt(sessionId, nudge, workspace);
      } catch (err: unknown) {
        log.warn("checkCaptureReadiness: nudge injection failed", {
          workspaceId: workspace.id,
          err: (err as Error)?.message,
        });
      }
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
  async #evaluateCompanionRound(workspace: TaskWorkspaceState): Promise<void> {
    const task = workspace.task;
    const workspaceId = workspace.id;
    if (this.#evaluating.has(workspaceId)) return;
    this.#clearRateLimitCtx(workspaceId);
    this.#evaluating.add(workspaceId);
    try {
      this.#setTaskState(task, "evaluating");
      this.#broadcastState!();

      const workLockGone = await this.isWorkerCompleted(workspaceId);
      if (this.#wasInterrupted(workspaceId, new Set(["evaluating"]))) return;
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
      if (this.#wasInterrupted(workspaceId, new Set(["evaluating"]))) return;

      const structurallyBad =
        verification.status === "missing" || verification.status === "invalid" || verification.status === "stale";
      if (structurallyBad && !task.verificationNotRequired) {
        await this.#recreateWorkLock(workspace, "verification-gate");
        const nudge = buildVerificationNudgePrompt(task, verification);
        await this.#injectPrompt(sessionIdFor(workspace, "worker"), nudge, workspace);
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

      await this.#requestCompanionEvaluation(workspace, "round-review", structurallyBad ? null : verification);
    } finally {
      this.#evaluating.delete(workspaceId);
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
  ): Promise<void> {
    const task = workspace.task;
    const workspaceId = workspace.id;
    const round = task.currentRound || 1;
    // New evaluation identity. Bumped before the prompt is built so the number
    // the Companion is told to echo is the one every later read expects, and
    // the previous attempt's handled marker no longer matches.
    const evaluationAttempt = (task.companionEvaluationAttempt || 0) + 1;

    // TASK.md is re-read on EVERY evaluation: an attached task's in-memory
    // description is always empty, and manual brief edits / appended user
    // clarifications only ever land on disk. A cached copy would quote an
    // empty brief to the evaluator.
    const [gitContext, captured, taskMd] = await Promise.all([
      getGitContext(workspace.cwd, { execCommand, log }),
      readCaptureFiles(workspace.cwd, task.taskId),
      readTaskMd(workspace.cwd, task.taskId),
    ]);
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
      cwd: workspace.cwd,
      verification,
      previousFindingIds,
    });

    // Evidence ledger for the completion floor: record what this evaluation was
    // actually given, so the verdict's verificationReview can be checked against
    // reality instead of taken at its word (see #handleCompanionVerdict).
    task.companionEvidence = verification
      ? { status: verification.status, mtimeIso: verification.mtimeIso, round: verification.round }
      : { status: "not-provided", mtimeIso: null, round: null };

    const judgeSessionId = sessionIdFor(workspace, "judge");
    task.judgeNudged = false;
    task.companionPhase = phase;
    task.companionEvaluationAttempt = evaluationAttempt;
    task.companionVerdictHandledAttempt = undefined;
    await clearVerdict(workspace.cwd, task.taskId);
    await this.#clearSessionContext(judgeSessionId, workspace);
    await this.#injectPrompt(judgeSessionId, prompt, workspace);
    this.#setTaskState(task, "judge-evaluating");
    log.info("companion evaluation requested", { workspaceId, phase, round, evaluationAttempt });
    void this.#logTaskEvent(
      workspace,
      "companion-requested",
      `${phase} evaluation requested (round ${round}, attempt ${evaluationAttempt}).`,
    );
    this.#broadcastState!();
  }

  /** Attached counterpart to #handleJudgeVerdict — mode-aware parser, third
   * "needs-input" outcome, and Companion-specific feedback prompt. */
  async #handleCompanionVerdict(workspace: TaskWorkspaceState, source = "manual"): Promise<void> {
    const task = workspace.task;
    const workspaceId = workspace.id;
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

    try {
      const result = await readCompanionVerdict(workspace.cwd, task.taskId, expected, log);

      if (result.status === "missing") {
        if (isIdlePromptOnly) return;
        if (!task.judgeNudged) {
          task.judgeNudged = true;
          const dir = taskDirRel(task.taskId);
          const nudge = `You MUST write your verdict to ${dir}/${VERDICT_FILE} now — a schemaVersion 1 JSON object with ${identity}. Write the file now.`;
          await this.#injectPrompt(judgeSessionId, nudge, workspace);
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
        if (!task.judgeNudged) {
          task.judgeNudged = true;
          const dir = taskDirRel(task.taskId);
          const detail =
            result.status === "invalid"
              ? `Your verdict file is malformed: ${result.errors.join("; ") || "schema validation failed"}.`
              : `Your verdict file is for a different evaluation than the one requested (expected ${identity}).`;
          const nudge = `${detail} Rewrite ${dir}/${VERDICT_FILE} as a single valid schemaVersion 1 JSON object matching exactly ${identity}, then stop.`;
          await this.#injectPrompt(judgeSessionId, nudge, workspace);
          void this.#logTaskEvent(
            workspace,
            "companion-verdict-repair",
            `Verdict ${result.status} — asked Companion to rewrite it.`,
          );
          this.#broadcastState!();
          return;
        }
        if (this.#isSessionBusy?.(judgeSessionId)) return;
        log.warn("companion verdict remained invalid/stale after repair request", {
          workspaceId,
          status: result.status,
        });
        task.pausedFromState = "judge-evaluating";
        this.#setTaskState(task, "paused");
        void this.#logTaskEvent(
          workspace,
          "companion-give-up",
          `Companion verdict remained ${result.status} after a repair request — pausing.`,
        );
        this.#raiseTaskAlert(workspace, "failed", `Companion verdict file is ${result.status}`);
        this.#broadcastState!();
        return;
      }

      // result.status === "valid"
      const verdict = result.data as CompanionVerdict;
      task.judgeNudged = false;
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
      // Template first, baseline second: the baseline is what the next
      // round-review compares the record's mtime against, and a template
      // written after it would beat it and pass as this round's evidence.
      await writeVerificationTemplate(workspace.cwd, task.taskId, task.currentRound + 1, log);
      task.companionLastFeedbackAt = new Date().toISOString();
      const feedbackPrompt = buildCompanionFeedbackPrompt(task, verdict);
      const workerSessionId = sessionIdFor(workspace, "worker");
      // The Primary session is externally owned (plan §8.6) — unlike the
      // standard worker path, it is NEVER cleared between rounds. Clearing it
      // would wipe the user's live conversation, which the whole feature
      // exists to preserve.
      await this.#injectPrompt(workerSessionId, feedbackPrompt, workspace);
      this.#setTaskState(task, "running");
      if (lastRound) lastRound.action = "re-prompted";
      task.currentRound += 1;
      this.#ensureRunningRound(task);
      log.info("primary re-prompted with companion feedback", { workspaceId, round: task.currentRound });
      void this.#logTaskEvent(workspace, "primary-reprompted", `Companion feedback: ${verdict.reason}`);
      this.#broadcastState!();
    } catch (err: unknown) {
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
      this.#handlingCompanionVerdict.delete(workspaceId);
      const pending = this.#pendingCompanionVerdict.get(workspaceId);
      // Consumed unconditionally — a signal that is no longer relevant (the
      // pass that just finished moved the task on) must not be replayed later.
      if (pending) this.#pendingCompanionVerdict.delete(workspaceId);
      if (pending && task.state === "judge-evaluating") {
        log.debug("replaying coalesced companion idle signal", { workspaceId, source: pending });
        // Caught here rather than left to the caller: this runs inside the
        // finally of a pass that already reported its own outcome.
        await this.#handleCompanionVerdict(workspace, pending).catch((err: unknown) => {
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
    workspace: TaskWorkspaceState,
    verdict: CompanionVerdict,
    observedEvidence: string,
  ): Promise<void> {
    const task = workspace.task;
    const round = task.currentRound || 1;
    const rounds = task.rounds as unknown as TaskRound[];
    const lastRound = rounds?.[rounds.length - 1];
    if (lastRound) lastRound.action = "verification-required";

    await this.#recreateWorkLock(workspace, "completion-floor");
    // Same round resumes, so the template must be tagged for the round we are
    // staying in — same reasoning as the answerCompanionTask path. Written
    // before the baseline is stamped so the template can never clear the very
    // freshness gate this method exists to enforce.
    await writeVerificationTemplate(workspace.cwd, task.taskId, round, log);
    task.companionLastFeedbackAt = new Date().toISOString();
    await this.#injectPrompt(
      sessionIdFor(workspace, "worker"),
      buildCompletionEvidencePrompt(task, verdict),
      workspace,
    );
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
    workspace: TaskWorkspaceState,
    { previousState, pausedFromState, resumeTo }: { previousState: string; pausedFromState: string; resumeTo: string },
  ): Promise<void> {
    const task = workspace.task;
    const workspaceId = workspace.id;

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
      if (result.status === "valid") {
        if (task.state !== "judge-evaluating") this.#setTaskState(task, "judge-evaluating");
        this.#broadcastState!();
        await this.#handleCompanionVerdict(workspace, "resume-reconcile");
        return;
      }
      task.judgeNudged = false;
      if (task.state !== "judge-evaluating") this.#setTaskState(task, "judge-evaluating");
      this.#broadcastState!();
      const prompt = buildAttachedCompanionRecoveryPrompt(task, round);
      await this.#injectPrompt(sessionIdFor(workspace, "judge"), prompt, workspace);
      return;
    }

    if (previousState === "completed" || previousState === "failed" || previousState === "awaiting-user") {
      void this.#logTaskEvent(workspace, "task-resumed-reconcile", `Resumed ${previousState}; awaiting user.`);
      return;
    }

    if (task.state === "capturing-context") {
      await this.#checkCaptureReadiness(workspace, sessionIdFor(workspace, "worker"));
      return;
    }

    if (task.state === "running") {
      await this.#evaluateCompanionRound(workspace);
      return;
    }
    void this.#logTaskEvent(workspace, "task-resumed-reconcile", `Resumed to ${resumeTo}; nothing to reconcile.`);
  }

  /**
   * Explicit answer action for an attached task in `awaiting-user`
   * (plan §8.5). Appends the clarification to TASK.md as authoritative
   * scope BEFORE injecting anything into Primary, then resumes the SAME
   * round — a needs-input pause never consumes a round.
   */
  async answerCompanionTask(workspaceId: string, questionIds: string[], answer: string): Promise<boolean> {
    const workspace = this.#findTaskWorkspace(workspaceId);
    if (!workspace) return false;
    const task = workspace.task;
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

    const now = new Date().toISOString();
    try {
      await appendUserClarification(
        workspace.cwd,
        task.taskId,
        { timestamp: now, questionIds: pending.map((q) => q.id), answer: trimmed },
        log,
      );
    } catch (err: unknown) {
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
    await writeVerificationTemplate(workspace.cwd, task.taskId, task.currentRound || 1, log);
    task.companionLastFeedbackAt = new Date().toISOString();
    await this.#recreateWorkLock(workspace, "companion-answer");
    const prompt = buildCompanionAnswerPrompt(task, pending, trimmed);
    const workerSessionId = sessionIdFor(workspace, "worker");
    try {
      await this.#injectPrompt(workerSessionId, prompt, workspace);
    } catch (err: unknown) {
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
    task.pendingQuestions = [];
    const rounds = task.rounds as unknown as TaskRound[];
    const lastRound = rounds?.[rounds.length - 1];
    if (lastRound) lastRound.action = "user-answered";
    this.#setTaskState(task, "running");
    log.info("answerCompanionTask: answer injected, resuming same round", {
      workspaceId,
      round: task.currentRound,
      answered: questionIds.length,
    });
    void this.#logTaskEvent(workspace, "user-clarification", `Answered: ${trimmed}`);
    this.#broadcastState!();
    return true;
  }

  async #runProgrammaticCopilotJudge(workspace: TaskWorkspaceState, prompt: string): Promise<ExecResult> {
    const task = workspace.task;
    const promptPath = path.join(taskDir(workspace.cwd, task.taskId), COPILOT_PROGRAMMATIC_JUDGE_PROMPT_FILE);
    await writeFile(promptPath, prompt, "utf8");
    const command = buildProgrammaticCopilotJudgeCommand({
      promptPath,
      cwd: workspace.cwd,
      model: task.judgeProviderConfig?.model,
    });
    log.info("running programmatic Copilot judge", {
      workspaceId: workspace.id,
      taskId: task.taskId,
      promptPath: COPILOT_PROGRAMMATIC_JUDGE_PROMPT_FILE,
      model: task.judgeProviderConfig?.model || "",
    });
    return execCommand(command, workspace.cwd, COPILOT_PROGRAMMATIC_JUDGE_TIMEOUT_MS);
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
    const task = workspace.task;
    const workspaceId = workspace.id;
    const workerSessionId = sessionIdFor(workspace, "worker");
    const dir = taskDir(workspace.cwd, task.taskId);
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

    // Step 2: Inject short directive to worker.
    // Krok 11 — route through #injectPrompt so the directive uses the
    // per-provider injection strategy and the verified submit + retry (Krok 1),
    // instead of a raw write + fixed 200ms Enter that can drop the Enter.
    const directive = `Read ${relDir}/SHOWER_REQUEST.md and follow it now. Write the handoff summary to ${relDir}/${HANDOFF_FILE}. After the file is written, stop and wait.`;
    await this.#injectPrompt(workerSessionId, directive, workspace);

    log.debug("shower mode: handoff directive sent, waiting for handoff file", { workspaceId });

    // Step 3: Wait for handoff file (poll with timeout)
    const handoffWritten = await waitForFile(handoffPath, 120_000); // 2 min timeout

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

    try {
      await this.#restartSession(workerSessionId);
      log.info("shower mode: worker session restarted", { workspaceId });
    } catch (err: unknown) {
      log.error("shower mode: failed to restart worker session", { workspaceId, err: (err as Error)?.message });
      return false;
    }

    // Step 5: Build and inject resume prompt with handoff context
    let handoffContent = "";
    try {
      handoffContent = await readFile(handoffPath, "utf8");
    } catch (err: unknown) {
      log.warn("shower mode: could not read handoff file after restart", { workspaceId, err: (err as Error)?.message });
    }

    const resumePrompt = this.#buildShowerResumePrompt(task, handoffContent);

    // Write the resume prompt to PROMPT.md — it will be injected via file-based
    // prompt when the new session goes idle (promptSent is reset below).
    const promptFilePath = path.join(dir, PROMPT_FILE);
    try {
      await writeFile(promptFilePath, resumePrompt, "utf8");
      log.debug("shower mode: resume prompt written to file", { workspaceId, promptLength: resumePrompt.length });
    } catch (err: unknown) {
      log.warn("shower mode: failed to write resume prompt file", { workspaceId, err: (err as Error)?.message });
    }

    // Wait briefly for the new session to be ready before injecting
    await new Promise((resolve) => setTimeout(resolve, 2000));

    // Store the resume prompt so the next onAgentIdle sends it instead of the initial prompt
    task.showerResumePrompt = resumePrompt;
    task.lastShowerRound = task.currentRound;
    task.promptSent = false; // Reset — triggers prompt injection on next idle

    // Clean up ephemeral shower files
    await rm(handoffRequestPath, { force: true }).catch(() => {});

    log.info("shower mode: context refresh complete", {
      workspaceId,
      round: task.currentRound,
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
   */
  async #clearSessionContext(sessionId: string, workspace: TaskWorkspaceState): Promise<void> {
    if (!this.#writeToSession) return;
    const strategy = this.#resolveInjectionStrategy(sessionId, workspace);
    log.debug("clearing session context", {
      sessionId,
      style: strategy.style,
      clearSettleMs: strategy.clearSettleMs,
    });
    await this.#writeAndSubmit(sessionId, "/clear", strategy);
    if (strategy.clearSettleMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, strategy.clearSettleMs));
    }
  }

  /**
   * Inject a prompt into a PTY session. For short prompts (< FILE_PROMPT_THRESHOLD
   * chars) paste directly. For longer prompts, write to a file and send a short
   * directive — more reliable and avoids PTY paste issues with large text.
   *
   * Inspired by codex-runner's pattern of writing prompts to files and injecting
   * "Read {file} and follow it now" directives via tmux send_keys.
   */
  async #injectPrompt(sessionId: string, text: string, workspace: TaskWorkspaceState | null): Promise<void> {
    if (!this.#writeToSession) {
      log.warn("injectPrompt: writeToSession not available", { sessionId });
      return;
    }

    // Remember the last thing we told this session so the manual "Resend"
    // buttons and the dropout auto-restart can re-send it verbatim.
    this.#lastInjected.set(sessionId, text);

    // Krok 9c — stamp the worker inject time so onAgentIdle can measure how long
    // the next worker turn lasts (the short-turn rate-limit heuristic).
    if (workspace?.task && sessionId === sessionIdFor(workspace, "worker")) {
      this.#workerInjectAt.set(workspace.id, Date.now());
    }

    let injection = text;

    // File-based injection for long prompts
    if (text.length > FILE_PROMPT_THRESHOLD && workspace?.cwd && workspace?.task?.taskId) {
      const promptPath = path.join(taskDir(workspace.cwd, workspace.task.taskId), PROMPT_FILE);
      const relPromptPath = `${taskDirRel(workspace.task.taskId)}/${PROMPT_FILE}`;
      try {
        await writeFile(promptPath, text, "utf8");
        injection = `Read ${relPromptPath} and follow the instructions in it now.`;
        log.info("prompt written to file for injection", {
          sessionId,
          promptPath: relPromptPath,
          originalLength: text.length,
        });
      } catch (err: unknown) {
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

    // Krok 1 — verified injection. Hook-capable providers (Claude Code) confirm
    // a submitted prompt by firing UserPromptSubmit; we wait for it and re-send
    // Enter if it doesn't arrive (the "Enter sat in the composer unsubmitted"
    // failure from incident A). Providers without hooks keep today's
    // fire-and-forget behaviour (no wait, no retry).
    const hookCapable = this.#isSessionHookCapable?.(sessionId) ?? false;
    if (!hookCapable) {
      await this.#writeAndSubmit(sessionId, injection, strategy);
      log.debug("prompt injected (unverified — no hooks)", {
        sessionId,
        length: injection.length,
        originalLength: text.length,
        style: strategy.style,
      });
      return;
    }

    const SUBMIT_CONFIRM_TIMEOUT_MS = AgentTaskRunner.SUBMIT_CONFIRM_TIMEOUT_MS;
    const MAX_RESUBMITS = AgentTaskRunner.MAX_RESUBMITS;
    for (let attempt = 0; attempt <= MAX_RESUBMITS; attempt++) {
      const confirmed = this.#waitForSubmitConfirmation(sessionId, SUBMIT_CONFIRM_TIMEOUT_MS);
      if (attempt === 0) {
        await this.#writeAndSubmit(sessionId, injection, strategy);
      } else {
        // Text is already in the composer — just re-send Enter.
        log.warn("injectPrompt: submit not confirmed, re-sending Enter", { sessionId, attempt });
        this.#writeToSession!(sessionId, "\r");
      }
      if (await confirmed) {
        log.debug("prompt injected (submit confirmed)", {
          sessionId,
          attempt,
          length: injection.length,
          style: strategy.style,
        });
        return;
      }
    }
    log.warn("injectPrompt: submit unconfirmed after retries", { sessionId });
    if (workspace) {
      void this.#logTaskEvent(
        workspace,
        "prompt-submit-unconfirmed",
        `Provider did not confirm prompt submission for ${sessionId.split(":").pop()} after ${MAX_RESUBMITS} re-sends.`,
      );
    }
  }

  /**
   * Krok 1 — register a one-shot waiter that resolves when the session's next
   * UserPromptSubmit hook arrives (via onUserPromptSubmit), or false on timeout.
   */
  #waitForSubmitConfirmation(sessionId: string, timeoutMs: number): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
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
    });
  }

  /** Krok 1 — resolve all submit waiters for a session (called on UserPromptSubmit). */
  #resolveSubmitWaiters(sessionId: string): void {
    const list = this.#submitWaiters.get(sessionId);
    if (!list?.length) return;
    this.#submitWaiters.delete(sessionId);
    for (const waiter of list) waiter();
  }

  /**
   * Stream a prompt character-by-character, then send Enter. Used for TUIs
   * that misclassify fast bulk writes as a paste event (Copilot).
   */
  #typeAndSubmit(
    sessionId: string,
    text: string,
    { typingGapMs, submitDelayMs }: { typingGapMs: number; submitDelayMs: number },
  ): Promise<void> {
    return new Promise((resolve) => {
      let index = 0;
      const typeNext = () => {
        if (index >= text.length) {
          setTimeout(() => {
            log.trace("typeAndSubmit: sending Enter after type complete", { sessionId });
            this.#writeToSession!(sessionId, "\r");
            resolve();
          }, submitDelayMs);
          return;
        }
        this.#writeToSession!(sessionId, text[index]);
        index += 1;
        setTimeout(typeNext, typingGapMs);
      };
      typeNext();
    });
  }

  /**
   * Send text to a PTY using the provider's preferred strategy and resolve only
   * after the final Enter has been written.
   */
  #writeAndSubmit(sessionId: string, text: string, strategy: InjectionStrategy): Promise<void> {
    if (strategy.style === "type") {
      return this.#typeAndSubmit(sessionId, text, strategy);
    }
    this.#writeToSession!(sessionId, text);
    return new Promise((resolve) => {
      setTimeout(() => {
        log.trace("writeAndSubmit: sending Enter", { sessionId, submitDelay: strategy.submitDelayMs });
        this.#writeToSession!(sessionId, "\r");
        resolve();
      }, strategy.submitDelayMs);
    });
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
    const task = workspace.task;
    const workerSessionId = `${workspace.id}:${task.workerPanelId}`;

    log.info("sending stop signal to Worker", { workspaceId: workspace.id, kind });

    // 1. Ctrl+C to interrupt any running tool/command
    this.#writeToSession(workerSessionId, "\x03");

    // 2. After pause (agent needs time to cancel and return to prompt), write the stop message
    const reason =
      kind === "completed"
        ? "The Judge has approved your work. The task is complete."
        : "The task runner has stopped (max rounds or error).";
    const message = `\nThe task has ended: ${reason} Do not start new work or continue the previous task. Wait for the user.`;
    setTimeout(() => {
      this.#writeToSession!(workerSessionId, message);
      // Send Enter separately after text is written (same pattern as #injectPrompt)
      setTimeout(() => {
        this.#writeToSession!(workerSessionId, "\r");
        log.debug("stop message sent to Worker", { workspaceId: workspace.id });
      }, 200);
    }, 2000);
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
