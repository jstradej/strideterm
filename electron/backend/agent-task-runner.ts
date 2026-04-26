/// <reference types="node" />
import { randomUUID } from "node:crypto";
import { access, readFile, writeFile, rm } from "node:fs/promises";
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
  MAX_OUTPUT_TAIL,
  FILE_PROMPT_THRESHOLD,
  DEFAULT_SHOWER_INTERVAL,
  taskDir,
  taskDirRel,
  fenceUserInput,
  tailLines,
} from "./agent-task-utils.js";
import {
  buildInitialWorkerPrompt,
  buildRePrompt,
  buildJudgePrompt,
  buildJudgeFeedbackPrompt,
  buildUserFeedbackPrompt,
} from "./agent-task-prompts.js";
import { execCommand } from "./agent-task-exec.js";
import type { ExecResult } from "./agent-task-exec.js";
import {
  cleanupTaskFiles as cleanupTaskFilesImpl,
  clearVerdict,
  ensureGitIgnore,
  readVerdict,
  runBuiltInChecks,
  waitForFile,
  writeTaskFiles,
} from "./agent-task-files.js";
import { ensureGitRepo, getGitContext } from "./agent-task-git.js";
import type { AppState, WorkspaceState } from "../shared/types/state.js";
import type { TaskState } from "../shared/types/task.js";

const log: Logger = getLogger("task-runner");
const COPILOT_PROGRAMMATIC_JUDGE_PROMPT_FILE = "JUDGE_INPUT.md";
const COPILOT_PROGRAMMATIC_JUDGE_TIMEOUT_MS = 180_000;

// ------ Types -------

/** Full task state as used internally (extends persisted TaskState with runtime fields) */
interface RuntimeTaskState extends TaskState {
  judgeNudged?: boolean;
  // showerResumePrompt, pausedFromState, promptSent are already in TaskState
  [key: string]: unknown; // index signature for TaskData compatibility in prompts
}

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
  | "failed";

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
  /** per-cwd git init locks to prevent concurrent init */
  #gitInitLocks = new Map<string, Promise<boolean>>();
  /** workspaceIds with a headless programmatic judge in flight */
  #programmaticJudges = new Set<string>();
  /** scheduled wakeup timers for workspaces in rate-limit hold */
  #rateLimitTimers = new Map<string, NodeJS.Timeout>();
  /** per-workspace runtime context for the active rate-limit cycle */
  #rateLimitCtx = new Map<string, { needsRestart: boolean; retries: number }>();
  /** deferred WORK_LOCK-absence checks that override a possibly-false rate-limit hold */
  #workLockOverrideTimers = new Map<string, NodeJS.Timeout>();

  // Injected dependencies (set via init())
  #writeToSession: RuntimeDeps["writeToSession"] | null = null;
  #getState: RuntimeDeps["getState"] | null = null;
  #broadcastState: RuntimeDeps["broadcastState"] | null = null;
  #raiseAlert: RuntimeDeps["raiseAlert"] | null = null;
  #restartSession: RuntimeDeps["restartSession"] | null = null;

  /**
   * Late-init with runtime dependencies (avoids circular refs).
   * Called once from runtime.js after all closures are available.
   */
  init({ writeToSession, getState, broadcastState, raiseAlert, restartSession }: RuntimeDeps): void {
    this.#writeToSession = writeToSession;
    this.#getState = getState;
    this.#broadcastState = broadcastState;
    this.#raiseAlert = raiseAlert;
    this.#restartSession = restartSession;

    // Pause any tasks left in active states from a previous session.
    // After an app restart, Claude Code sessions are fresh (no context),
    // so auto-resuming would redo work blindly. The user can explicitly
    // click Continue to resume.
    this.#reconcileOnStartup();
  }

  #reconcileOnStartup(): void {
    const state = this.#getState?.();
    if (!state?.workspaces) return;

    const ACTIVE = new Set(["running", "evaluating", "judge-evaluating", "refreshing"]);

    for (const workspace of state.workspaces) {
      if (!isTaskWorkspace(workspace)) continue;
      if (!ACTIVE.has(workspace.task.state)) continue;

      log.info("reconcileOnStartup: pausing task left in active state", {
        workspaceId: workspace.id,
        previousState: workspace.task.state,
      });
      workspace.task.pausedFromState = "";
      this.#setTaskState(workspace.task, "paused");
      this.#logTaskEvent(workspace, "task-paused", `Paused on startup (was ${workspace.task.state})`);
    }

    // No broadcastState() here — runtime isn't fully initialized yet
    // (getPayload depends on pluginManager etc.). The corrected state
    // will be included in the first natural broadcast after startup.
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
  }: {
    state: Pick<AppState, "activeProfileId">;
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
      color: color || "#7C4DFF",
      kind: "task",
      source: "manual",
      pluginId: "",
      cwd,
      gitRoots: [],
      activeRootPath: "",
      notes: notes?.trim() || "",
      profileId: state.activeProfileId || "default",
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

    // Claude Code is already running (started with the workspace).
    // Send the task prompt now — agent is ready and waiting for input.
    //
    // We always send even when task.description is empty: the prompt template
    // already falls back to "Read the task from <taskDir>/TASK.md" in that case,
    // which is exactly what users expect after they edit TASK.md in the Files
    // tab and press Start. Gating on description meant Start was a silent no-op
    // for that workflow, and only typing directly into the terminal worked.
    const workerSessionId = `${workspaceId}:${task.workerPanelId}`;
    const prompt = buildInitialWorkerPrompt(task);
    await this.#injectPrompt(workerSessionId, prompt, workspace);
    task.promptSent = true;
    const detail = task.description ? "Prompt sent to Worker" : "Prompt sent to Worker (task in TASK.md)";
    log.info("task started, prompt sent to worker", {
      workspaceId,
      taskId: task.taskId,
      hasDescription: !!task.description,
    });
    this.#logTaskEvent(workspace, "task-started", detail);

    this.#broadcastState!();
    return true;
  }

  stopTask(workspaceId: string): boolean {
    const workspace = this.#findTaskWorkspace(workspaceId);
    if (!workspace) return false;

    this.#setTaskState(workspace.task, "paused");
    this.#evaluating.delete(workspaceId);
    log.info("task stopped (paused)", { workspaceId });
    this.#logTaskEvent(workspace, "task-stopped");
    this.#broadcastState!();
    return true;
  }

  pauseTask(workspaceId: string): boolean {
    const workspace = this.#findTaskWorkspace(workspaceId);
    if (!workspace) return false;
    if (
      workspace.task.state !== "running" &&
      workspace.task.state !== "evaluating" &&
      workspace.task.state !== "judge-evaluating" &&
      workspace.task.state !== "refreshing"
    )
      return false;

    this.#setTaskState(workspace.task, "paused");
    this.#evaluating.delete(workspaceId);
    log.info("task paused", { workspaceId });
    this.#logTaskEvent(workspace, "task-paused");
    this.#broadcastState!();
    return true;
  }

  resumeTask(workspaceId: string): boolean {
    const workspace = this.#findTaskWorkspace(workspaceId);
    if (!workspace) return false;
    const resumable = new Set(["paused", "completed", "failed"]);
    if (!resumable.has(workspace.task.state)) return false;

    const task = workspace.task;
    const previousState = task.state;
    // Restore to the state we were in before pausing, not always "running".
    // If paused during judge-evaluating, resume to judge-evaluating so the
    // verdict can be read.  If paused from evaluating/refreshing, fall back
    // to running (the evaluation was interrupted and needs to restart from
    // the next worker idle).
    const resumeTo: TaskStateKind = task.pausedFromState === "judge-evaluating" ? "judge-evaluating" : "running";
    task.pausedFromState = "";

    this.#setTaskState(task, resumeTo);
    log.info("task resumed", { workspaceId, previousState, resumeTo });
    this.#logTaskEvent(workspace, "task-resumed", `Resumed to ${resumeTo}`);
    this.#broadcastState!();

    // If the initial prompt was never delivered (startTask ran with an empty
    // description under the old code path, or the user is resuming a state that
    // never sent a prompt), inject it now. Without this, Resume would flip the
    // state badge to "running" but the Worker would still sit idle waiting.
    if (!task.promptSent && resumeTo === "running") {
      const workerSessionId = `${workspaceId}:${task.workerPanelId}`;
      const prompt = buildInitialWorkerPrompt(task);
      this.#injectPrompt(workerSessionId, prompt, workspace)
        .then(() => {
          task.promptSent = true;
          this.#logTaskEvent(workspace, "prompt-sent", "Prompt delivered on resume");
          this.#broadcastState!();
        })
        .catch((err: unknown) => {
          log.error("late-delivery prompt injection failed", { workspaceId, err: (err as Error)?.message });
        });
    }

    // If resumed to judge-evaluating, the judge's idle hook may have already
    // fired and been ignored while paused.  Proactively try to read the
    // verdict — if the file exists, handle it; otherwise wait for the next hook.
    if (resumeTo === "judge-evaluating") {
      log.info("resumed to judge-evaluating, proactively checking verdict", { workspaceId });
      this.#handleJudgeVerdict(workspace).catch((err: unknown) => {
        log.error("proactive verdict check failed", { workspaceId, err: (err as Error)?.message });
      });
    }

    return true;
  }

  /**
   * Reset a task to idle state — clears round history, recreates WORK_LOCK,
   * and returns to a clean starting point. Used for "Reset & Retry".
   */
  async resetTask(workspaceId: string): Promise<boolean> {
    const workspace = this.#findTaskWorkspace(workspaceId);
    if (!workspace) return false;
    const resettable = new Set(["paused", "completed", "failed"]);
    if (!resettable.has(workspace.task.state)) return false;

    const task = workspace.task;
    const previousState = task.state;

    this.#setTaskState(task, "idle");
    task.currentRound = 0;
    task.rounds = [];
    task.promptSent = false;
    task.pausedFromState = "";
    task.showerResumePrompt = "";
    task.lastShowerRound = 0;
    task.rateLimitedUntil = null;
    // Preserve lastJudgeInstructions — might be useful for next run
    this.#evaluating.delete(workspaceId);
    this.#clearWorkLockOverrideTimer(workspaceId);
    const resumeTimer = this.#rateLimitTimers.get(workspaceId);
    if (resumeTimer) {
      clearTimeout(resumeTimer);
      this.#rateLimitTimers.delete(workspaceId);
    }
    this.#rateLimitCtx.delete(workspaceId);

    // Recreate WORK_LOCK so the next run starts clean
    try {
      const dir = taskDir(workspace.cwd, task.taskId);
      await writeFile(
        path.join(dir, WORK_LOCK_FILE),
        "Work remains. Remove this file only when the task is complete and all verification steps pass.\n",
        "utf8",
      );
      log.debug("WORK_LOCK recreated for reset", { workspaceId });
    } catch (err: unknown) {
      log.warn("failed to recreate WORK_LOCK during reset", { workspaceId, err: (err as Error)?.message });
    }

    log.info("task reset", { workspaceId, previousState });
    this.#logTaskEvent(workspace, "task-reset", `Previous state: ${previousState}`);
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

    const task = workspace.task;
    const reopenable = new Set(["completed", "failed"]);
    if (!reopenable.has(task.state)) {
      log.warn("rejectTaskVerdict: task not in reopenable state", { workspaceId, state: task.state });
      return false;
    }
    const trimmed = String(feedback || "").trim();
    if (!trimmed) {
      log.warn("rejectTaskVerdict: empty feedback", { workspaceId });
      return false;
    }

    const previousState = task.state;
    const lastRound = (task.rounds as unknown as TaskRound[])?.[task.rounds.length - 1];
    if (lastRound) lastRound.action = "re-prompted";

    // Recreate WORK_LOCK so built-in checks behave as usual for the next round.
    try {
      const dir = taskDir(workspace.cwd, task.taskId);
      await writeFile(
        path.join(dir, WORK_LOCK_FILE),
        "Work remains. Remove this file only when the task is complete and all verification steps pass.\n",
        "utf8",
      );
    } catch (err: unknown) {
      log.warn("rejectTaskVerdict: failed to recreate WORK_LOCK", { workspaceId, err: (err as Error)?.message });
    }

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

    const prompt = buildUserFeedbackPrompt(task, trimmed);
    const workerSessionId = `${workspaceId}:${task.workerPanelId}`;
    try {
      await this.#injectPrompt(workerSessionId, prompt, workspace);
    } catch (err: unknown) {
      log.error("rejectTaskVerdict: failed to inject prompt", { workspaceId, err: (err as Error)?.message });
      this.#setTaskState(task, previousState as TaskStateKind);
      this.#broadcastState!();
      return false;
    }

    log.info("task verdict rejected by user", { workspaceId, previousState, round: task.currentRound });
    this.#logTaskEvent(workspace, "verdict-rejected", `User feedback: ${trimmed}`);
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
    const parts = sessionId.split(":");
    if (parts.length < 2) return false;

    const workspaceId = parts.slice(0, -1).join(":");
    const panelId = parts[parts.length - 1];
    const workspace = this.#findTaskWorkspace(workspaceId);
    if (!workspace) {
      log.trace("onAgentIdle: not a task workspace", { sessionId, workspaceId });
      return false;
    }

    const task = workspace.task;
    log.debug("onAgentIdle: task workspace found", {
      sessionId,
      workspaceId,
      panelId,
      taskState: task.state,
      workerPanelId: task.workerPanelId,
      judgePanelId: task.judgePanelId,
      promptSent: task.promptSent,
      currentRound: task.currentRound,
    });

    const isWorker = panelId === task.workerPanelId;
    const isJudge = panelId === task.judgePanelId;

    if (!isWorker && !isJudge) {
      // Arbitrary panel inside a task workspace (e.g. a docs/readme tab the
      // user added manually). Fall through so the user pipeline decides.
      log.debug("onAgentIdle: panel is neither worker nor judge", { sessionId, panelId });
      return false;
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

      const elapsedMs = task.startedAt ? Date.now() - (task.startedAt as unknown as number) : 0;
      log.info("worker idle detected, starting evaluation", {
        workspaceId,
        sessionId,
        round: task.currentRound,
        elapsedMs,
        source,
      });
      this.#logTaskEvent(
        workspace,
        "worker-idle-detected",
        `Worker went idle via ${source} (${(elapsedMs / 1000).toFixed(1)}s since start). Starting checks…`,
      );
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
      log.info("judge idle detected, reading verdict", { workspaceId, sessionId, source });
      this.#logTaskEvent(workspace, "judge-idle-detected", `Judge went idle via ${source}. Reading verdict…`);
      this.#handleJudgeVerdict(workspace).catch((err: unknown) => {
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
      panelId,
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
  onWorkerRateLimited(sessionId: string, match: RateLimitMatch, source = "unknown"): boolean {
    const parts = sessionId.split(":");
    if (parts.length < 2) return false;
    const workspaceId = parts.slice(0, -1).join(":");
    const panelId = parts[parts.length - 1];
    const workspace = this.#findTaskWorkspace(workspaceId);
    if (!workspace) return false;
    const task = workspace.task;
    if (panelId !== task.workerPanelId) return false;

    const ctx = this.#rateLimitCtx.get(workspaceId) ?? { needsRestart: false, retries: 0 };
    const isFirstHit = !this.#rateLimitTimers.has(workspaceId);

    // Resolve resetAt: provider-supplied, or exponential fallback by retry
    // count (30 → 60 → 120 min). Hard ceiling protects against parsing typos
    // ("83 hours") and runaway loops.
    const resetAt = match.resetAt ?? this.#fallbackRateLimitReset(ctx.retries);
    const waitMs = resetAt.getTime() - Date.now();
    if (waitMs > AgentTaskRunner.RATE_LIMIT_HARD_STOP_MS) {
      log.error("rate-limit reset > hard stop, pausing task", { workspaceId, waitMs });
      this.#logTaskEvent(
        workspace,
        "worker-rate-limit-failed",
        `Rate-limit reset is ${(waitMs / 3_600_000).toFixed(1)}h away (over 12h limit). Pausing task.`,
      );
      this.#pauseFromRateLimit(workspace, "reset > 12h");
      return true;
    }

    // Same-window dedup: existing timer for this exact reset → keep it.
    const existing = task.rateLimitedUntil ? Date.parse(task.rateLimitedUntil) : 0;
    if (
      this.#rateLimitTimers.has(workspaceId) &&
      Number.isFinite(existing) &&
      Math.abs(existing - resetAt.getTime()) < 60_000
    ) {
      log.trace("onWorkerRateLimited: already scheduled for this window", { workspaceId, source });
      return true;
    }

    if (isFirstHit) ctx.retries += 1;
    ctx.needsRestart = !match.needsConfirm;
    if (ctx.retries > AgentTaskRunner.MAX_RATE_LIMIT_RETRIES) {
      log.error("rate-limit retry cap exceeded, pausing task", { workspaceId, retries: ctx.retries });
      this.#logTaskEvent(
        workspace,
        "worker-rate-limit-failed",
        `Worker rate-limited ${ctx.retries} times in a row — pausing task. Resume manually when usage frees up.`,
      );
      this.#pauseFromRateLimit(workspace, "retry cap");
      return true;
    }
    this.#rateLimitCtx.set(workspaceId, ctx);

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
    this.#logTaskEvent(
      workspace,
      "worker-rate-limited",
      `Worker hit its rate limit (${match.providerHint}, retry ${ctx.retries}/${AgentTaskRunner.MAX_RATE_LIMIT_RETRIES}). Resuming after ${resetAt.toLocaleTimeString()}.`,
    );
    this.#broadcastState!();

    // Confirm prompt (Claude Code only): Enter selects the highlighted
    // default option ("1. Stop and wait for limit to reset").
    if (match.needsConfirm && this.#writeToSession) {
      this.#writeToSession(sessionId, "\r");
    }

    this.#scheduleRateLimitResume(workspaceId, resetAt);
    return true;
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

  #scheduleRateLimitResume(workspaceId: string, resetAt: Date): void {
    const prev = this.#rateLimitTimers.get(workspaceId);
    if (prev) clearTimeout(prev);
    // Wait until the reset wall-clock plus margin; never less than the
    // margin even if parsing put the target in the past.
    const margin = AgentTaskRunner.RATE_LIMIT_RESUME_MARGIN_MS;
    const waitMs = Math.max(margin, resetAt.getTime() - Date.now() + margin);
    const timer = setTimeout(() => {
      this.#rateLimitTimers.delete(workspaceId);
      this.#resumeFromRateLimit(workspaceId).catch((err: unknown) => {
        log.error("rate-limit resume failed", { workspaceId, err: (err as Error)?.message });
      });
    }, waitMs);
    this.#rateLimitTimers.set(workspaceId, timer);
  }

  #pauseFromRateLimit(workspace: TaskWorkspaceState, reason: string): void {
    const prev = this.#rateLimitTimers.get(workspace.id);
    if (prev) clearTimeout(prev);
    this.#rateLimitTimers.delete(workspace.id);
    this.#rateLimitCtx.delete(workspace.id);
    this.#clearWorkLockOverrideTimer(workspace.id);
    workspace.task.rateLimitedUntil = null;
    workspace.task.pausedFromState = workspace.task.state;
    this.#setTaskState(workspace.task, "paused");
    this.#raiseTaskAlert(workspace, "failed", `Rate-limit handling gave up (${reason}) — task paused.`);
    this.#broadcastState!();
  }

  async #resumeFromRateLimit(workspaceId: string): Promise<void> {
    const workspace = this.#findTaskWorkspace(workspaceId);
    if (!workspace) return;
    const task = workspace.task;
    if (!task.rateLimitedUntil) return;

    const ctx = this.#rateLimitCtx.get(workspaceId);
    task.rateLimitedUntil = null;
    this.#clearWorkLockOverrideTimer(workspaceId);
    log.info("rate-limit window expired, resuming worker", {
      workspaceId,
      taskState: task.state,
      needsRestart: ctx?.needsRestart,
      retries: ctx?.retries,
    });
    this.#logTaskEvent(workspace, "worker-rate-limit-resumed", "Rate-limit window expired. Resuming worker…");
    this.#broadcastState!();

    if (task.state !== "running") return;
    const sessionId = `${workspaceId}:${task.workerPanelId}`;

    if (ctx?.needsRestart) {
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
  #clearRateLimitCtx(workspaceId: string): void {
    this.#rateLimitCtx.delete(workspaceId);
  }

  /**
   * Whether the worker has signaled completion. WORK_LOCK is the single
   * authoritative bit: the worker is instructed to delete it ONLY when the
   * task is genuinely done. Used by the runtime confirmation timer to skip
   * setting a rate-limit hold when the silence is actually "task finished",
   * and by the in-runner override check that recovers from a hold that was
   * set on a false-positive match. File-system based — no in-memory cache,
   * since the worker writes to disk asynchronously and we want the live state.
   */
  async isWorkerCompleted(workspaceId: string): Promise<boolean> {
    const workspace = this.#findTaskWorkspace(workspaceId);
    if (!workspace) return false;
    const task = workspace.task;
    if (!task?.taskId) return false;
    const dir = taskDir(workspace.cwd, task.taskId);
    try {
      await access(path.join(dir, WORK_LOCK_FILE));
      return false; // lock present => worker still has work
    } catch {
      return true; // ENOENT (or unreadable) => worker signaled done
    }
  }

  #clearWorkLockOverrideTimer(workspaceId: string): void {
    const timer = this.#workLockOverrideTimers.get(workspaceId);
    if (!timer) return;
    clearTimeout(timer);
    this.#workLockOverrideTimers.delete(workspaceId);
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
    const resumeTimer = this.#rateLimitTimers.get(workspaceId);
    if (resumeTimer) {
      clearTimeout(resumeTimer);
      this.#rateLimitTimers.delete(workspaceId);
    }
    this.#rateLimitCtx.delete(workspaceId);
    this.#logTaskEvent(
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
    const parts = sessionId.split(":");
    if (parts.length < 2) return;

    const workspaceId = parts.slice(0, -1).join(":");
    const panelId = parts[parts.length - 1];
    const workspace = this.#findTaskWorkspace(workspaceId);
    if (!workspace) return;

    log.trace("onSessionExit: task session exited", { sessionId, panelId, taskState: workspace.task.state });

    const ACTIVE = new Set(["running", "evaluating", "judge-evaluating", "refreshing"]);
    if (panelId === workspace.task.workerPanelId && ACTIVE.has(workspace.task.state)) {
      workspace.task.pausedFromState = "";
      this.#setTaskState(workspace.task, "paused");
      this.#evaluating.delete(workspaceId);
      log.warn("worker session exited, task paused", { workspaceId, sessionId });
      this.#logTaskEvent(workspace, "worker-crashed", "Worker session exited unexpectedly, task paused");
      this.#raiseTaskAlert(workspace, "failed", "Worker session exited — task paused");
      this.#broadcastState!();
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
    this.#logTaskEvent(workspace, "subagent-stop", "A sub-agent finished");
    return true;
  }

  /**
   * User submitted a new prompt — cancel any pending judge-reprompt work
   * (user is steering the conversation themselves).  Returns true for task
   * workspaces so the dispatcher skips the user alert (UserPromptSubmit is
   * classified system-only; this is belt-and-braces).
   */
  onUserPromptSubmit(sessionId: string): boolean {
    const parts = sessionId.split(":");
    if (parts.length < 2) return false;
    const workspaceId = parts.slice(0, -1).join(":");
    const workspace = this.#findTaskWorkspace(workspaceId);
    if (!workspace) return false;

    log.trace("onUserPromptSubmit: user sent prompt in task workspace", { sessionId });
    // If task is paused and user is taking over, leave it paused — don't
    // resume automatically.  The user can click Continue when ready.
    this.#logTaskEvent(workspace, "user-prompt-submit", "User submitted a prompt");
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
    const parts = sessionId.split(":");
    if (parts.length < 2) return;

    const workspaceId = parts.slice(0, -1).join(":");
    const panelId = parts[parts.length - 1];
    const workspace = this.#findTaskWorkspace(workspaceId);
    if (!workspace) return;

    const task = workspace.task;
    // Only pause if input targets the panel that the task runner is actively driving
    const isWorkerInput = panelId === task.workerPanelId;
    const isJudgeInput = panelId === task.judgePanelId;
    const shouldPause =
      ((task.state === "evaluating" || task.state === "refreshing") && isWorkerInput) ||
      (task.state === "judge-evaluating" && isJudgeInput);

    if (shouldPause) {
      task.pausedFromState = task.state;
      this.#setTaskState(task, "paused");
      this.#evaluating.delete(workspaceId);
      log.info("user input detected during evaluation, task paused", {
        workspaceId,
        sessionId,
        panelId,
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
    const ACTIVE = new Set(["running", "evaluating", "judge-evaluating", "refreshing"]);
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
    const round: TaskRound = {
      round: task.currentRound || 1,
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
    const parts = sessionId.split(":");
    if (parts.length < 2) return null;
    const workspaceId = parts.slice(0, -1).join(":");
    const panelId = parts[parts.length - 1];
    const workspace = this.#findTaskWorkspace(workspaceId);
    if (!workspace) return null;
    const task = workspace.task;
    const isWorker = panelId === task.workerPanelId;
    const config = isWorker ? task.workerProviderConfig : task.judgeProviderConfig;
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
      task.pausedFromState = "";
      this.#setTaskState(task, "paused");
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
    this.#logTaskEvent(
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
        this.#logTaskEvent(workspace, "shower-started", "Refreshing Worker context (killing session, writing handoff)");
        this.#broadcastState!();
        const showerOk = await this.#performShower(workspace);
        if (showerOk) {
          this.#setTaskState(task, "running");
          round.action = "running";
          log.info("shower completed, waiting for refreshed worker", { workspaceId });
          this.#logTaskEvent(workspace, "shower-completed", "Worker session restarted with fresh context");
        } else {
          log.warn("shower failed, falling back to normal re-prompt", { workspaceId });
          this.#logTaskEvent(workspace, "shower-failed", "Handoff not written in time, falling back to re-prompt");
          const prompt = buildRePrompt(task, round);
          const workerSessionId = `${workspaceId}:${task.workerPanelId}`;
          await this.#injectPrompt(workerSessionId, prompt, workspace);
          this.#setTaskState(task, "running");
          round.action = "running";
        }
      } else {
        const prompt = buildRePrompt(task, round);
        const workerSessionId = `${workspaceId}:${task.workerPanelId}`;
        await this.#injectPrompt(workerSessionId, prompt, workspace);
        this.#setTaskState(task, "running");
        round.action = "running";
        log.info("worker re-prompted", { workspaceId, round: task.currentRound });
        this.#logTaskEvent(workspace, "worker-reprompted", "Checks failed, Worker re-prompted with failure details");
      }
    } else {
      // All checks passed — invoke judge (still within the current round;
      // currentRound only advances when the judge says "continue").
      round.action = "judge-requested";

      const judgeSetupStart = Date.now();

      // Clear old verdict and nudge flag for fresh judge evaluation
      await clearVerdict(workspace.cwd, task.taskId);
      task.judgeNudged = false;

      // Gather git context so the judge can see actual repo changes
      const gitContext = await getGitContext(workspace.cwd, { execCommand, log });
      const gitContextMs = Date.now() - judgeSetupStart;

      const judgeSessionId = `${workspaceId}:${task.judgePanelId}`;
      const judgePrompt = await buildJudgePrompt(task, round, gitContext, workspace.cwd);
      if (shouldUseProgrammaticCopilotJudge(task.judgeProviderConfig)) {
        this.#setTaskState(task, "judge-evaluating");
        this.#programmaticJudges.add(workspaceId);
        this.#broadcastState!();
        this.#logTaskEvent(
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
        this.#logTaskEvent(
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
        await this.#handleJudgeVerdict(workspace);
        this.#programmaticJudges.delete(workspaceId);
        return;
      }

      // Clear judge context for independent evaluation, then inject prompt
      await this.#clearSessionContext(judgeSessionId, workspace);
      await this.#injectPrompt(judgeSessionId, judgePrompt, workspace);
      const totalSetupMs = Date.now() - judgeSetupStart;
      this.#setTaskState(task, "judge-evaluating");
      log.info("judge evaluation requested", { workspaceId, round: task.currentRound, gitContextMs, totalSetupMs });
      this.#logTaskEvent(
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

  async #handleJudgeVerdict(workspace: TaskWorkspaceState): Promise<void> {
    const task = workspace.task;
    const workspaceId = workspace.id;

    try {
      const verdict = await readVerdict(workspace.cwd, task.taskId, log);

      // If verdict file is missing, nudge the judge once before giving up.
      // LLMs sometimes output the verdict as text instead of writing the file.
      if (verdict.reason === "Judge did not produce a verdict file." && !task.judgeNudged) {
        task.judgeNudged = true;
        const dir = taskDirRel(task.taskId);
        const nudge = `You MUST write your verdict to ${dir}/${VERDICT_FILE} as a JSON file now. Use the Write tool or cat/heredoc. Example:\n\n{"verdict": "complete", "reason": "All requirements met."}\n\nWrite the file now.`;
        const judgeSessionId = `${workspaceId}:${task.judgePanelId}`;
        log.info("judge verdict file missing, sending nudge", { workspaceId });
        this.#logTaskEvent(workspace, "judge-nudged", "Verdict file missing — reminded Judge to write it");
        await this.#injectPrompt(judgeSessionId, nudge, workspace);
        this.#broadcastState!();
        return; // Wait for next judge idle — will re-enter #handleJudgeVerdict
      }

      if (verdict.reason === "Judge did not produce a verdict file.") {
        log.warn("judge verdict file missing after nudge", { workspaceId, round: task.currentRound });
        this.#setTaskState(task, "paused");
        this.#broadcastState!();
        this.#raiseTaskAlert(workspace, "failed", "Judge did not produce a verdict file");
        return;
      }

      log.info("judge verdict", { workspaceId, verdict: verdict.verdict, reason: verdict.reason });
      this.#logTaskEvent(workspace, "judge-verdict", `Verdict: ${verdict.verdict}. ${verdict.reason || ""}`);

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
        this.#logTaskEvent(workspace, "task-completed", verdict.reason || "Judge approved");
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
          this.#logTaskEvent(workspace, "task-failed", `Max rounds after judge. ${verdict.reason || ""}`);
          this.#raiseTaskAlert(workspace, "failed", `Max rounds reached. Judge: ${verdict.reason || "incomplete"}`);
          this.#notifyWorkerTaskEnded(workspace, "failed");
        } else {
          // Judge sent the worker back — this starts a new round.
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const prompt = buildJudgeFeedbackPrompt(task, verdict as any);
          const workerSessionId = `${workspaceId}:${task.workerPanelId}`;
          await this.#injectPrompt(workerSessionId, prompt, workspace);
          this.#setTaskState(task, "running");
          if (lastRound) lastRound.action = "re-prompted";
          task.currentRound += 1;
          this.#ensureRunningRound(task);
          log.info("worker re-prompted with judge feedback", { workspaceId, round: task.currentRound });
          this.#logTaskEvent(workspace, "worker-reprompted", `Judge feedback: ${verdict.reason || "continue working"}`);
        }
      }

      this.#broadcastState!();
    } catch (err: unknown) {
      log.error("handleJudgeVerdict failed", { workspaceId, err: (err as Error)?.message });
      this.#setTaskState(task, "paused");
      this.#broadcastState!();
    }
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
    const interval = task.showerInterval || DEFAULT_SHOWER_INTERVAL;
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
    const workerSessionId = `${workspaceId}:${task.workerPanelId}`;
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

    // Step 2: Inject short directive to worker
    const directive = `Read ${relDir}/SHOWER_REQUEST.md and follow it now. Write the handoff summary to ${relDir}/${HANDOFF_FILE}. After the file is written, stop and wait.`;
    this.#writeToSession!(workerSessionId, directive);
    setTimeout(() => {
      this.#writeToSession!(workerSessionId, "\r");
    }, 200);

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

    await this.#writeAndSubmit(sessionId, injection, strategy);
    log.debug("prompt injected", {
      sessionId,
      length: injection.length,
      originalLength: text.length,
      style: strategy.style,
    });
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

  /**
   * Raise a user-visible alert for a task event.
   */
  #raiseTaskAlert(workspace: TaskWorkspaceState, kind: "completed" | "failed", reason?: string): void {
    if (!this.#raiseAlert) return;
    const task = workspace.task;
    const roundInfo = task.currentRound ? ` after ${task.currentRound} round${task.currentRound !== 1 ? "s" : ""}` : "";
    const detail = reason ? `task-${kind}: ${reason}` : `task-${kind}${roundInfo}`;
    // Task completed = normal urgency (you can check it later).
    // Task failed/crashed = urgent — otherwise a broken task sits silent
    // and defeats the point of running it unattended.
    const urgency = kind === "completed" ? "normal" : "urgent";
    log.info("raising task alert", { workspaceId: workspace.id, kind, detail, urgency });
    this.#raiseAlert({
      projectId: workspace.id,
      panelId: workspace.task.workerPanelId,
      sessionId: `${workspace.id}:${workspace.task.workerPanelId}`,
      title: workspace.name,
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
