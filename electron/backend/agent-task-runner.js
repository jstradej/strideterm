import { randomUUID } from "node:crypto";
import { exec } from "node:child_process";
import { access, readFile, writeFile, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { getLogger } from "./logger.js";
import {
  VERDICT_FILE,
  TASK_FILE,
  TODO_FILE,
  CRITERIA_FILE,
  JUDGE_TODO_FILE,
  JUDGE_PROMPT_FILE,
  WORK_LOCK_FILE,
  TASK_LOG_FILE,
  PROMPT_FILE,
  HANDOFF_FILE,
  MAX_OUTPUT_TAIL,
  FILE_PROMPT_THRESHOLD,
  DEFAULT_SHOWER_INTERVAL,
  verdictSchema,
  taskDir,
  taskDirRel,
  fenceUserInput,
  tailLines,
  parseTodoSections,
  activeItems,
  parseFinishCriteriaMd,
  checkCommandSafety,
} from "./agent-task-utils.js";
import { detectProjectVerifyCommands, detectStackReviewHints } from "./agent-task-detection.js";
import {
  buildInitialWorkerPrompt,
  buildRePrompt,
  buildJudgePrompt,
  buildJudgeFeedbackPrompt,
} from "./agent-task-prompts.js";

const log = getLogger("task-runner");

/**
 * Agent Task Runner — orchestrates a worker + judge evaluation loop.
 *
 * Integrates with strideterm's hook-based idle detection: when a worker or
 * judge agent goes idle, runtime calls `onAgentIdle(sessionId)` instead of
 * raising a normal user alert. The task runner then runs verification checks
 * and coordinates the worker–judge cycle.
 */
export class AgentTaskRunner {
  /** @type {Set<string>} workspaceIds currently being evaluated (re-entrance guard) */
  #evaluating = new Set();
  /** @type {Map<string, Promise>} per-cwd git init locks to prevent concurrent init */
  #gitInitLocks = new Map();

  // Injected dependencies (set via init())
  #writeToSession = null;
  #getState = null;
  #broadcastState = null;
  #raiseAlert = null;
  #restartSession = null;

  /**
   * Late-init with runtime dependencies (avoids circular refs).
   * Called once from runtime.js after all closures are available.
   */
  init({ writeToSession, getState, broadcastState, raiseAlert, restartSession }) {
    this.#writeToSession = writeToSession;
    this.#getState = getState;
    this.#broadcastState = broadcastState;
    this.#raiseAlert = raiseAlert;
    this.#restartSession = restartSession;
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
  }) {
    const workspaceId = `workspace-${randomUUID()}`;
    const dashboardPanelId = `panel-${randomUUID()}`;
    const workerPanelId = `panel-${randomUUID()}`;
    const judgePanelId = `panel-${randomUUID()}`;

    const autoName = description
      ? description.length > 50
        ? description.slice(0, 47) + "..."
        : description
      : "Task workspace";

    return {
      id: workspaceId,
      name: name?.trim() || autoName,
      icon: icon?.trim() || "\u{1F916}", // 🤖
      color: color || "#7C4DFF",
      kind: "task",
      source: "manual",
      pluginId: "",
      cwd,
      notes: notes?.trim() || "",
      profileId: state.activeProfileId || "default",
      connectionId: "",
      activePanelId: dashboardPanelId,
      panels: [
        { id: dashboardPanelId, title: "Dashboard", command: "__task-dashboard__", shell: false, startup: "none" },
        {
          id: workerPanelId,
          title: "Worker",
          command: workerCommand?.trim() || "claude --dangerously-skip-permissions --model sonnet",
          shell: true,
          startup: "default",
        },
        {
          id: judgePanelId,
          title: "Judge",
          command: judgeCommand?.trim() || "claude --dangerously-skip-permissions --model opus",
          shell: true,
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
        // Finish criteria are read from FINISH_CRITERIA.md at evaluation time (not stored here)
        finishCriteria: { verifyCommands: [], requiredPaths: [], forbiddenPaths: [] },
        maxRounds: maxRounds || 10,
        showerInterval: DEFAULT_SHOWER_INTERVAL,
        state: "idle",
        currentRound: 0,
        rounds: [],
        lastShowerRound: 0, // Track when the last shower happened
        lastJudgeInstructions: "", // Carry judge feedback through showers
        startedAt: null, // Date.now() when task started
        totalPausedMs: 0, // Accumulated pause duration
        pausedAt: null, // Date.now() when current pause began
        finishedAt: null, // Date.now() when completed/failed
      },
    };
  }

  /**
   * Write task control files to disk. Called at workspace creation time
   * so files are immediately available in the Dashboard/Files tab.
   */
  async writeInitialFiles(cwd, task) {
    log.info("writing initial task files", {
      cwd,
      taskId: task.taskId,
      hasDescription: !!task.description,
      descriptionLength: (task.description || "").length,
    });
    await this.#writeTaskFiles(cwd, task);
    await this.#ensureGitIgnore(cwd);
  }

  // ---------------------------------------------------------------------------
  // Task lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Start (or resume) the task — inject initial prompt into worker.
   */
  async startTask(workspaceId) {
    const state = this.#getState();
    const workspace = state.workspaces.find((w) => w.id === workspaceId);
    if (!workspace?.task) {
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
    await this.#ensureGitRepo(workspace.cwd);

    this.#setTaskState(task, "running");
    task.currentRound = 0;
    task.rounds = [];

    // Claude Code is already running (started with the workspace).
    // Send the task prompt now — agent is ready and waiting for input.
    if (task.description) {
      const workerSessionId = `${workspaceId}:${task.workerPanelId}`;
      const prompt = buildInitialWorkerPrompt(task);
      await this.#injectPrompt(workerSessionId, prompt, workspace);
      task.promptSent = true;
      log.info("task started, prompt sent to worker", { workspaceId, taskId: task.taskId });
      this.#logTaskEvent(workspace, "task-started", "Prompt sent to Worker");
    } else {
      task.promptSent = false;
      log.info("task started, no description — waiting for user input", { workspaceId, taskId: task.taskId });
      this.#logTaskEvent(workspace, "task-started", "No description — waiting for user input");
    }

    this.#broadcastState();
    return true;
  }

  stopTask(workspaceId) {
    const workspace = this.#findTaskWorkspace(workspaceId);
    if (!workspace) return false;

    this.#setTaskState(workspace.task, "paused");
    this.#evaluating.delete(workspaceId);
    log.info("task stopped (paused)", { workspaceId });
    this.#logTaskEvent(workspace, "task-stopped");
    this.#broadcastState();
    return true;
  }

  pauseTask(workspaceId) {
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
    this.#broadcastState();
    return true;
  }

  resumeTask(workspaceId) {
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
    const resumeTo = task.pausedFromState === "judge-evaluating" ? "judge-evaluating" : "running";
    task.pausedFromState = "";

    this.#setTaskState(task, resumeTo);
    log.info("task resumed", { workspaceId, previousState, resumeTo });
    this.#logTaskEvent(workspace, "task-resumed", `Resumed to ${resumeTo}`);
    this.#broadcastState();

    // If resumed to judge-evaluating, the judge's idle hook may have already
    // fired and been ignored while paused.  Proactively try to read the
    // verdict — if the file exists, handle it; otherwise wait for the next hook.
    if (resumeTo === "judge-evaluating") {
      log.info("resumed to judge-evaluating, proactively checking verdict", { workspaceId });
      this.#handleJudgeVerdict(workspace).catch((err) => {
        log.error("proactive verdict check failed", { workspaceId, err: err.message });
      });
    }

    return true;
  }

  /**
   * Reset a task to idle state — clears round history, recreates WORK_LOCK,
   * and returns to a clean starting point. Used for "Reset & Retry".
   */
  async resetTask(workspaceId) {
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
    // Preserve lastJudgeInstructions — might be useful for next run
    this.#evaluating.delete(workspaceId);

    // Recreate WORK_LOCK so the next run starts clean
    try {
      const dir = taskDir(workspace.cwd, task.taskId);
      await writeFile(
        path.join(dir, WORK_LOCK_FILE),
        "Work remains. Remove this file only when the finish criteria genuinely pass.\n",
        "utf8",
      );
      log.debug("WORK_LOCK recreated for reset", { workspaceId });
    } catch (err) {
      log.warn("failed to recreate WORK_LOCK during reset", { workspaceId, err: err.message });
    }

    log.info("task reset", { workspaceId, previousState });
    this.#logTaskEvent(workspace, "task-reset", `Previous state: ${previousState}`);
    this.#broadcastState();
    return true;
  }

  // ---------------------------------------------------------------------------
  // Idle detection entry point — called from runtime.js
  // ---------------------------------------------------------------------------

  /**
   * Called when an agent session goes idle (hook, OSC 133, or silence fallback).
   * Returns true if this session belongs to a task workspace and was handled.
   */
  onAgentIdle(sessionId, source = "unknown") {
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

    if (task.state !== "running" && task.state !== "judge-evaluating") {
      log.debug("onAgentIdle: task not in actionable state, ignoring", { sessionId, taskState: task.state });
      return false;
    }

    const isWorker = panelId === task.workerPanelId;
    const isJudge = panelId === task.judgePanelId;

    if (!isWorker && !isJudge) {
      log.debug("onAgentIdle: panel is neither worker nor judge", { sessionId, panelId });
      return false;
    }

    if (isWorker && task.state === "running") {
      // First idle after start: agent is ready — send the task prompt
      // (like codex-runner's send_keys after detecting idle)
      if (!task.promptSent) {
        // After a shower, use the resume prompt (with handoff context); otherwise initial prompt
        const isResume = !!task.showerResumePrompt;
        const prompt = task.showerResumePrompt || buildInitialWorkerPrompt(task);
        log.info("worker ready, injecting prompt", { workspaceId, sessionId, isResume });
        this.#injectPrompt(`${workspaceId}:${task.workerPanelId}`, prompt, workspace).catch((err) => {
          log.error("failed to inject prompt", { workspaceId, err: err.message });
        });
        task.promptSent = true;
        task.showerResumePrompt = ""; // Clear after use
        this.#broadcastState();
        return true;
      }

      const elapsedMs = task.startedAt ? Date.now() - task.startedAt : 0;
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
      this.#evaluateWorker(workspace).catch((err) => {
        log.error("evaluateWorker error", { workspaceId, err: err.message });
      });
      return true;
    }

    if (isJudge && task.state === "judge-evaluating") {
      log.info("judge idle detected, reading verdict", { workspaceId, sessionId, source });
      this.#logTaskEvent(workspace, "judge-idle-detected", `Judge went idle via ${source}. Reading verdict…`);
      this.#handleJudgeVerdict(workspace).catch((err) => {
        log.error("handleJudgeVerdict error", { workspaceId, err: err.message });
      });
      return true;
    }

    return false;
  }

  /**
   * Called when a session exits — if it's a worker session, pause the task.
   */
  onSessionExit(sessionId) {
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
      this.#broadcastState();
    }
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
  onUserInput(sessionId) {
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
      this.#broadcastState();
    }
  }

  // ---------------------------------------------------------------------------
  // State management — timing-aware
  // ---------------------------------------------------------------------------

  /**
   * Set task state with automatic timing tracking.
   * Tracks startedAt, pausedAt, totalPausedMs, finishedAt across all transitions.
   */
  #setTaskState(task, newState) {
    const ACTIVE = new Set(["running", "evaluating", "judge-evaluating", "refreshing"]);
    const prev = task.state;
    const now = Date.now();

    // Fresh start from idle
    if (prev === "idle" && ACTIVE.has(newState)) {
      task.startedAt = now;
      task.totalPausedMs = 0;
      task.pausedAt = null;
      task.finishedAt = null;
    }

    // Active → non-active (paused/completed/failed): record pause start
    if (ACTIVE.has(prev) && !ACTIVE.has(newState) && newState !== "idle") {
      task.pausedAt = now;
      if (newState === "completed" || newState === "failed") {
        task.finishedAt = now;
      }
    }

    // Non-active → active (resume): accumulate paused time
    if (!ACTIVE.has(prev) && prev !== "idle" && ACTIVE.has(newState) && task.pausedAt) {
      task.totalPausedMs = (task.totalPausedMs || 0) + (now - task.pausedAt);
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

  // ---------------------------------------------------------------------------
  // State queries
  // ---------------------------------------------------------------------------

  getTaskState(workspaceId) {
    const workspace = this.#findTaskWorkspace(workspaceId);
    return workspace?.task || null;
  }

  /**
   * Returns serializable snapshot of all task workspaces for payload broadcast.
   */
  getTaskSnapshot() {
    const state = this.#getState();
    const result = {};
    for (const workspace of state.workspaces) {
      if (workspace.kind === "task" && workspace.task) {
        result[workspace.id] = {
          taskId: workspace.task.taskId,
          description: workspace.task.description,
          state: workspace.task.state,
          currentRound: workspace.task.currentRound,
          maxRounds: workspace.task.maxRounds,
          showerInterval: workspace.task.showerInterval,
          workerPanelId: workspace.task.workerPanelId,
          judgePanelId: workspace.task.judgePanelId,
          rounds: workspace.task.rounds,
          lastShowerRound: workspace.task.lastShowerRound || 0,
          startedAt: workspace.task.startedAt || null,
          totalPausedMs: workspace.task.totalPausedMs || 0,
          pausedAt: workspace.task.pausedAt || null,
          finishedAt: workspace.task.finishedAt || null,
        };
      }
    }
    return result;
  }

  // ---------------------------------------------------------------------------
  // Interruption check — used by evaluation loops to bail out early when
  // the user pauses, resets, or the session exits mid-evaluation.
  // ---------------------------------------------------------------------------

  #wasInterrupted(workspaceId, expectedStates) {
    if (!this.#evaluating.has(workspaceId)) return true;
    const workspace = this.#findTaskWorkspace(workspaceId);
    if (!workspace) return true;
    return !expectedStates.has(workspace.task.state);
  }

  // ---------------------------------------------------------------------------
  // Worker evaluation
  // ---------------------------------------------------------------------------

  async #evaluateWorker(workspace) {
    const task = workspace.task;
    const workspaceId = workspace.id;

    // Re-entrance guard
    if (this.#evaluating.has(workspaceId)) {
      log.debug("evaluation already in progress", { workspaceId });
      return;
    }
    this.#evaluating.add(workspaceId);

    try {
      const evalStart = Date.now();
      this.#setTaskState(task, "evaluating");
      this.#broadcastState();

      const round = {
        round: task.currentRound + 1,
        startedAt: new Date().toISOString(),
        checks: [],
        judgeVerdict: null,
        judgeReason: "",
        action: "evaluating",
      };

      // Push round early so UI can show streaming check results
      task.rounds.push(round);

      // Built-in checks: WORK_LOCK + TODO.md sections (always run, cheap)
      const builtInChecks = await this.#runBuiltInChecks(workspace.cwd, task.taskId);
      round.checks.push(...builtInChecks);
      this.#broadcastState(); // Stream built-in results to UI
      for (const c of builtInChecks) {
        log.debug("built-in check", { workspaceId, check: c.label, passed: c.passed });
      }

      // Bail out if user paused/reset during built-in checks
      if (this.#wasInterrupted(workspaceId, new Set(["evaluating"]))) {
        log.info("evaluation interrupted after built-in checks", { workspaceId });
        return;
      }

      // Short-circuit: if built-in checks already fail (WORK_LOCK present,
      // active TODO items), skip expensive verify commands and file checks.
      // Inspired by codex-runner's "completion claim heuristic" — only run
      // the full test/lint suite when the worker signals it thinks it's done.
      const builtInsPassed = builtInChecks.every((c) => c.passed);
      if (!builtInsPassed) {
        log.info("built-in checks failed, skipping verify commands (short-circuit)", {
          workspaceId,
          round: round.round,
          failedChecks: builtInChecks.filter((c) => !c.passed).map((c) => c.label),
        });
      }

      let allPassed = false;

      if (builtInsPassed) {
        // Worker claims completion — run the full verification suite.
        const criteria = await this.#readFinishCriteria(workspace.cwd, task.taskId);
        log.debug("finish criteria loaded", {
          workspaceId,
          verifyCommands: criteria.verifyCommands.length,
          requiredPaths: criteria.requiredPaths.length,
        });

        // Run file existence checks from criteria
        const fileChecks = await this.#runFileChecks(workspace.cwd, criteria);
        round.checks.push(...fileChecks);
        this.#broadcastState(); // Stream file check results to UI

        // Run verify commands one at a time, broadcasting after each
        for (const cmd of criteria.verifyCommands || []) {
          // Safety check: warn about dangerous commands but still run them
          // (user explicitly defined these in FINISH_CRITERIA.md)
          const warnings = checkCommandSafety(cmd.command);
          if (warnings.length > 0) {
            log.warn("verify command flagged as potentially dangerous", {
              workspaceId,
              command: cmd.command,
              warnings,
            });
          }

          const result = await this.#execCommand(cmd.command, workspace.cwd, cmd.timeoutMs || 60_000);
          const check = {
            label: cmd.label || cmd.command,
            passed: result.exitCode === 0,
            exitCode: result.exitCode,
            warning: warnings.length > 0 ? warnings.join(", ") : "",
            outputTail: tailLines(result.stderr || result.stdout, MAX_OUTPUT_TAIL),
          };
          round.checks.push(check);
          log.debug("verify command", {
            workspaceId,
            check: check.label,
            passed: check.passed,
            exitCode: check.exitCode,
          });
          this.#broadcastState(); // Stream each verify result to UI

          // Bail out if user paused/reset while command was running
          if (this.#wasInterrupted(workspaceId, new Set(["evaluating"]))) {
            log.info("evaluation interrupted during verify commands", { workspaceId });
            return;
          }
        }

        allPassed = round.checks.every((c) => c.passed);
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
        // Re-prompt worker with failure details
        round.action = "re-prompted";
        task.currentRound += 1;

        if (task.currentRound >= task.maxRounds) {
          this.#setTaskState(task, "failed");
          round.action = "failed";
          const failedNames = round.checks.filter((c) => !c.passed).map((c) => c.label);
          log.info("task failed: max rounds reached", {
            workspaceId,
            rounds: task.currentRound,
            failedChecks: failedNames,
          });
          this.#logTaskEvent(
            workspace,
            "task-failed",
            `Max rounds (${task.maxRounds}) reached. Failed: ${failedNames.join(", ")}`,
          );
          this.#raiseTaskAlert(
            workspace,
            "failed",
            `Max rounds reached. Failed: ${failedNames.join(", ") || "checks"}`,
          );
          this.#notifyWorkerTaskEnded(workspace, "failed");
        } else {
          // Check if worker is due for a shower (context refresh)
          if (this.#shouldShower(task)) {
            log.info("shower mode triggered before re-prompt", {
              workspaceId,
              round: task.currentRound,
              lastShower: task.lastShowerRound || 0,
            });
            round.action = "shower";
            this.#setTaskState(task, "refreshing");
            this.#logTaskEvent(
              workspace,
              "shower-started",
              "Refreshing Worker context (killing session, writing handoff)",
            );
            this.#broadcastState();
            const showerOk = await this.#performShower(workspace);
            if (showerOk) {
              this.#setTaskState(task, "running");
              log.info("shower completed, waiting for refreshed worker", { workspaceId });
              this.#logTaskEvent(workspace, "shower-completed", "Worker session restarted with fresh context");
            } else {
              log.warn("shower failed, falling back to normal re-prompt", { workspaceId });
              this.#logTaskEvent(workspace, "shower-failed", "Handoff not written in time, falling back to re-prompt");
              const prompt = buildRePrompt(task, round);
              const workerSessionId = `${workspaceId}:${task.workerPanelId}`;
              await this.#injectPrompt(workerSessionId, prompt, workspace);
              this.#setTaskState(task, "running");
            }
          } else {
            const prompt = buildRePrompt(task, round);
            const workerSessionId = `${workspaceId}:${task.workerPanelId}`;
            await this.#injectPrompt(workerSessionId, prompt, workspace);
            this.#setTaskState(task, "running");
            log.info("worker re-prompted", { workspaceId, round: task.currentRound });
            this.#logTaskEvent(
              workspace,
              "worker-reprompted",
              "Checks failed, Worker re-prompted with failure details",
            );
          }
        }
      } else {
        // All checks passed — invoke judge
        round.action = "judge-requested";
        task.currentRound += 1;

        const judgeSetupStart = Date.now();

        // Clear old verdict
        await this.#clearVerdict(workspace.cwd, task.taskId);

        // Gather git context so the judge can see actual repo changes
        const gitContext = await this.#getGitContext(workspace.cwd);
        const gitContextMs = Date.now() - judgeSetupStart;

        // Inject judge evaluation prompt
        const judgeSessionId = `${workspaceId}:${task.judgePanelId}`;
        const judgePrompt = await buildJudgePrompt(task, round, gitContext, workspace.cwd);
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

      this.#broadcastState();
    } catch (err) {
      log.error("evaluateWorker failed", { workspaceId, err: err.message });
      task.pausedFromState = "";
      this.#setTaskState(task, "paused");
      this.#broadcastState();
    } finally {
      this.#evaluating.delete(workspaceId);
    }
  }

  // ---------------------------------------------------------------------------
  // Judge verdict handling
  // ---------------------------------------------------------------------------

  async #handleJudgeVerdict(workspace) {
    const task = workspace.task;
    const workspaceId = workspace.id;

    try {
      const verdict = await this.#readVerdict(workspace.cwd, task.taskId);

      // If verdict file is missing, judge didn't produce one — warn and pause after repeated failures
      if (verdict.reason === "Judge did not produce a verdict file.") {
        log.warn("judge verdict file missing", { workspaceId, round: task.currentRound });
        this.#setTaskState(task, "paused");
        this.#broadcastState();
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

      const lastRound = task.rounds[task.rounds.length - 1];
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
          const prompt = buildJudgeFeedbackPrompt(task, verdict);
          const workerSessionId = `${workspaceId}:${task.workerPanelId}`;
          await this.#injectPrompt(workerSessionId, prompt, workspace);
          this.#setTaskState(task, "running");
          if (lastRound) lastRound.action = "re-prompted";
          log.info("worker re-prompted with judge feedback", { workspaceId, round: task.currentRound });
          this.#logTaskEvent(workspace, "worker-reprompted", `Judge feedback: ${verdict.reason || "continue working"}`);
        }
      }

      this.#broadcastState();
    } catch (err) {
      log.error("handleJudgeVerdict failed", { workspaceId, err: err.message });
      this.#setTaskState(task, "paused");
      this.#broadcastState();
    }
  }

  // ---------------------------------------------------------------------------
  // Built-in checks (WORK_LOCK + TODO.md parsing — inspired by codex-runner)
  // ---------------------------------------------------------------------------

  /**
   * Check WORK_LOCK absence and TODO.md section state.
   * These run on every idle, before verify commands.
   */
  async #runBuiltInChecks(cwd, taskId) {
    const dir = taskDir(cwd, taskId);
    const results = [];

    // WORK_LOCK must be absent for completion
    let lockExists = false;
    try {
      await access(path.join(dir, WORK_LOCK_FILE));
      lockExists = true;
    } catch {
      // Good — no lock
    }
    results.push({
      label: "WORK_LOCK absent",
      passed: !lockExists,
      exitCode: lockExists ? 1 : 0,
      outputTail: lockExists ? "WORK_LOCK exists — worker has not signaled completion. Remove it when done." : "",
    });

    // Parse TODO.md sections
    try {
      const todoContent = await readFile(path.join(dir, TODO_FILE), "utf8");
      const sections = parseTodoSections(todoContent);

      const inProgress = activeItems(sections["In Progress"] || []);
      results.push({
        label: "TODO: In Progress empty",
        passed: inProgress.length === 0,
        exitCode: inProgress.length > 0 ? 1 : 0,
        outputTail: inProgress.length > 0 ? `Active items:\n${inProgress.join("\n")}` : "",
      });

      const blocked = activeItems(sections["Blocked"] || []);
      results.push({
        label: "TODO: Blocked empty",
        passed: blocked.length === 0,
        exitCode: blocked.length > 0 ? 1 : 0,
        outputTail: blocked.length > 0 ? `Blocked items:\n${blocked.join("\n")}` : "",
      });
    } catch {
      results.push({
        label: "TODO.md exists",
        passed: false,
        exitCode: 1,
        outputTail: "TODO.md not found — worker should create and maintain it.",
      });
    }

    // If package-lock.json was modified, run npm audit to catch known CVEs.
    // This is cheap (local DB check, no registry queries) and catches agents
    // that install dependencies with known vulnerabilities.
    const auditCheck = await this.#checkLockfileAudit(cwd);
    if (auditCheck) results.push(auditCheck);

    return results;
  }

  /**
   * If package-lock.json was modified, run `npm audit --audit-level=high`.
   * Returns null if lockfile is unchanged or project doesn't use npm.
   */
  async #checkLockfileAudit(cwd) {
    try {
      await access(path.join(cwd, "package-lock.json"));
    } catch {
      return null;
    }

    // Check if lockfile was modified (working tree or staged)
    const checks = await Promise.all([
      this.#execCommand("git diff --name-only HEAD -- package-lock.json", cwd, 10_000),
      this.#execCommand("git diff --name-only --cached -- package-lock.json", cwd, 10_000),
    ]);
    const dirty = checks.some((r) => r.stdout.trim().includes("package-lock.json"));
    if (!dirty) return null;

    log.info("lockfile modified by agent, running npm audit", { cwd });
    const result = await this.#execCommand("npm audit --audit-level=high", cwd, 60_000);
    return {
      label: "Lockfile security audit",
      passed: result.exitCode === 0,
      exitCode: result.exitCode,
      outputTail:
        result.exitCode === 0
          ? "package-lock.json changed — npm audit passed."
          : tailLines(result.stderr || result.stdout, MAX_OUTPUT_TAIL),
    };
  }

  // ---------------------------------------------------------------------------
  // Verification checks (from FINISH_CRITERIA.md)
  // ---------------------------------------------------------------------------

  async #runFileChecks(cwd, criteria) {
    const results = [];

    for (const filePath of criteria.requiredPaths || []) {
      const fullPath = path.resolve(cwd, filePath);
      let passed = false;
      try {
        await access(fullPath);
        passed = true;
      } catch {
        // File doesn't exist
      }
      results.push({ label: `Required: ${filePath}`, passed, exitCode: passed ? 0 : 1, outputTail: "" });
    }

    for (const filePath of criteria.forbiddenPaths || []) {
      const fullPath = path.resolve(cwd, filePath);
      let exists = false;
      try {
        await access(fullPath);
        exists = true;
      } catch {
        // Good — file doesn't exist
      }
      results.push({
        label: `Forbidden: ${filePath}`,
        passed: !exists,
        exitCode: exists ? 1 : 0,
        outputTail: exists ? "File exists but should not" : "",
      });
    }

    return results;
  }

  #execCommand(command, cwd, timeoutMs) {
    const childPromise = new Promise((resolve) => {
      const child = exec(command, {
        cwd,
        timeout: timeoutMs,
        windowsHide: true,
        maxBuffer: 2 * 1024 * 1024,
        env: { ...process.env, FORCE_COLOR: "0" },
      });

      let stdout = "";
      let stderr = "";

      child.stdout?.on("data", (chunk) => {
        stdout += chunk;
      });
      child.stderr?.on("data", (chunk) => {
        stderr += chunk;
      });
      child.on("close", (code) => {
        resolve({ exitCode: code ?? 1, stdout, stderr });
      });
      child.on("error", (err) => {
        resolve({ exitCode: 1, stdout, stderr: err.message });
      });
    });

    // Hard timeout safety net — resolves even if child process events don't fire
    const hardTimeout = new Promise((resolve) => {
      setTimeout(() => {
        resolve({ exitCode: 1, stdout: "", stderr: `Command timed out after ${timeoutMs}ms` });
      }, timeoutMs + 5000);
    });

    return Promise.race([childPromise, hardTimeout]);
  }

  // ---------------------------------------------------------------------------
  // Verdict file I/O
  // ---------------------------------------------------------------------------

  async #readVerdict(cwd, taskId) {
    const verdictPath = path.join(taskDir(cwd, taskId), VERDICT_FILE);
    try {
      const raw = await readFile(verdictPath, "utf8");
      const data = JSON.parse(raw);
      const parsed = verdictSchema.safeParse(data);
      if (!parsed.success) {
        log.warn("verdict file failed schema validation", {
          verdictPath,
          errors: parsed.error.issues.map((i) => i.message),
        });
        return {
          verdict: "continue",
          reason: `Verdict file has invalid format: ${parsed.error.issues.map((i) => i.message).join(", ")}`,
        };
      }
      log.debug("verdict file parsed", { verdictPath, verdict: parsed.data.verdict });
      return { verdict: parsed.data.verdict, reason: parsed.data.reason };
    } catch (err) {
      if (err.code === "ENOENT") {
        log.warn("verdict file missing — judge did not write it", { verdictPath });
        return { verdict: "continue", reason: "Judge did not produce a verdict file." };
      }
      // JSON parse error or other FS error — verdict file exists but is corrupt
      log.error("verdict file malformed or unreadable", { verdictPath, err: err.message });
      return { verdict: "continue", reason: `Verdict file could not be parsed: ${err.message}` };
    }
  }

  async #clearVerdict(cwd, taskId) {
    const verdictPath = path.join(taskDir(cwd, taskId), VERDICT_FILE);
    try {
      await rm(verdictPath, { force: true });
    } catch {
      // Ignore
    }
  }

  /**
   * Read finish criteria from FINISH_CRITERIA.md at evaluation time.
   *
   * Parses a simple human-friendly markdown format:
   *   ## Verify Commands
   *   - Tests: `npm test`
   *   - Lint: `npm run lint`    (optional timeout: 30s)
   *
   *   ## Required Files
   *   - src/hello.js
   *
   *   ## Forbidden Files
   *   - tmp/debug.log
   */
  async #readFinishCriteria(cwd, taskId) {
    const empty = { verifyCommands: [], requiredPaths: [], forbiddenPaths: [] };
    const filePath = path.join(taskDir(cwd, taskId), CRITERIA_FILE);
    try {
      const raw = await readFile(filePath, "utf8");
      return parseFinishCriteriaMd(raw);
    } catch {
      log.debug("FINISH_CRITERIA.md not found or unreadable", { filePath });
      return empty;
    }
  }

  // ---------------------------------------------------------------------------
  // Task file setup
  // ---------------------------------------------------------------------------

  async #writeTaskFiles(cwd, task) {
    const dir = taskDir(cwd, task.taskId);
    const relDir = taskDirRel(task.taskId);
    await mkdir(dir, { recursive: true });

    // Auto-detect verification commands and technology stack from project files
    const detected = await detectProjectVerifyCommands(cwd);
    const stackHints = await detectStackReviewHints(cwd);
    const now = new Date().toISOString().replace("T", " ").slice(0, 19);

    const descriptionBlock = task.description
      ? task.description
      : `> No task description provided. Instruct the Worker directly in the terminal,
> or write your task here and press Start.`;

    const taskMd = `# Task

> Created: ${now} | Project: ${cwd}

${descriptionBlock}

## Rules

- **Commit your work** regularly with clear, descriptive messages (the judge reviews git diffs)
- Update ${relDir}/${TODO_FILE} as you work (move items between sections)
- Finish criteria and verification commands are in ${relDir}/${CRITERIA_FILE}
- The judge will independently verify your work after automated checks pass
- Focus on completing the task fully — partial completions will be sent back
- Do not push to any remote — the task runner works locally only
- **Do not install new dependencies** unless the task explicitly requires it. If you must add a package, prefer an established version (not the latest release) and pin the exact version (no ^ or ~ prefix)
`;

    const todoMd = `# TODO

> Created: ${now}
>
> The Worker updates this file as it progresses. You can pre-fill items before starting.
> The Task Runner checks that "In Progress" and "Blocked" sections are empty before completion.

## To Do

- [ ] Complete the task described in ${relDir}/${TASK_FILE}

## In Progress

## Done
`;

    const verifyCmds = detected.length
      ? detected.map((cmd) => `- ${cmd.label}: \`${cmd.command}\``).join("\n")
      : `> No commands detected. Add your own below, for example:
>
> \`- Tests: \\\`npm test\\\`\`
> \`- Lint: \\\`npm run lint\\\` (timeout: 30s)\``;

    const criteriaMd = `# Finish Criteria

> Created: ${now} | Project: ${cwd}
>
> The Task Runner reads this file before each evaluation round.
> ${detected.length ? "Commands below were auto-detected from your project." : "Add verification commands that must pass for the task to be considered done."}

## Verify Commands

${verifyCmds}

## Required Files

> List files that must exist when done, one per line: \`- path/to/file\`

## Forbidden Files

> List files that must NOT exist, one per line: \`- path/to/file\`
`;

    // JUDGE_TODO_FILE is intentionally NOT pre-created — the Judge creates it.
    // JUDGE_PROMPT_FILE IS pre-created so users can customize it before starting.

    const workLock = "Work remains. Remove this file only when the finish criteria genuinely pass.\n";

    const stackSection = stackHints.length
      ? `\n## Technology-specific checks\n\n${stackHints.map((h) => `- ${h}`).join("\n")}\n`
      : "";

    const judgePromptMd = `# Judge Instructions

> Edit this file to customize how the Judge evaluates the Worker's output.
> If this file exists, its content replaces the default judge instructions.
> The Judge always receives the task description, check results, and git context
> regardless of what you write here.

## Evaluation steps

1. Read the task description in ${relDir}/${TASK_FILE}
2. **Requirements check**: Go through every requirement point by point — verify each one is actually implemented, not just claimed
3. **Code review**: Read the changed files and check for:
   - Correctness: does the code do what the task asks?
   - Obvious bugs, edge cases, or error handling gaps
   - Code quality: no dead code, no debug leftovers, reasonable naming
   - Consistency with the existing codebase style
   Do NOT nitpick style preferences — focus on real issues
4. Run any checks yourself if needed (read files, run commands)
5. Keep notes in ${relDir}/${JUDGE_TODO_FILE}
6. Write your verdict to ${relDir}/${VERDICT_FILE}:
   - Complete: \`{"verdict": "complete", "reason": "..."}\`
   - Continue: \`{"verdict": "continue", "reason": "..."}\`
   List specific issues with file paths and descriptions
${stackSection}
## Severity guide

- **Blocker** (must fix): broken functionality, security vulnerability, data loss risk, failing tests
- **Major** (should fix): missing error handling, logic bugs, missing edge cases, API contract violations
- **Minor** (nice to fix): naming inconsistencies, dead code, missing types — only flag if egregious
`;

    await Promise.all([
      writeFile(path.join(dir, TASK_FILE), taskMd, "utf8"),
      writeFile(path.join(dir, TODO_FILE), todoMd, "utf8"),
      writeFile(path.join(dir, CRITERIA_FILE), criteriaMd, "utf8"),
      writeFile(path.join(dir, JUDGE_PROMPT_FILE), judgePromptMd, "utf8"),
      // JUDGE_TODO_FILE is intentionally NOT pre-created — Claude Code's
      // Write tool rejects overwrites of existing files unless Read was
      // called first.  Letting the judge create it fresh avoids this.
      writeFile(path.join(dir, WORK_LOCK_FILE), workLock, "utf8"),
    ]);

    log.info("task files written", { dir, detectedCommands: detected.length });
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /**
   * Ensure .strideterm/ is in the project's .gitignore so task files
   * (and other strideterm data like worktrees) don't get committed.
   */
  async #ensureGitIgnore(cwd) {
    const gitignorePath = path.join(cwd, ".gitignore");
    const entry = ".strideterm/";
    try {
      const content = await readFile(gitignorePath, "utf8");
      if (content.includes(entry)) {
        log.trace(".strideterm/ already in .gitignore", { cwd });
        return;
      }
      // Append to existing .gitignore
      const separator = content.endsWith("\n") ? "" : "\n";
      await writeFile(gitignorePath, content + separator + entry + "\n", "utf8");
      log.debug("appended .strideterm/ to .gitignore", { cwd });
    } catch (err) {
      if (err.code === "ENOENT") {
        // No .gitignore — create one
        try {
          await writeFile(gitignorePath, entry + "\n", "utf8");
          log.debug("created .gitignore with .strideterm/ entry", { cwd });
        } catch (writeErr) {
          log.warn("failed to create .gitignore", { cwd, err: writeErr.message });
        }
      } else {
        log.warn("failed to read .gitignore", { cwd, err: err.message });
      }
    }
  }

  /**
   * Remove task files for a workspace. Called when a task workspace is deleted.
   */
  async cleanupTaskFiles(cwd, taskId) {
    if (!cwd || !taskId) {
      log.warn("cleanupTaskFiles: missing cwd or taskId, skipping cleanup", {
        cwd: cwd || "(empty)",
        taskId: taskId || "(empty)",
      });
      return;
    }
    const dir = taskDir(cwd, taskId);
    try {
      await rm(dir, { recursive: true, force: true });
      log.info("task files cleaned up", { dir });
    } catch (err) {
      log.warn("failed to clean up task files", { dir, err: err.message });
    }
  }

  // ---------------------------------------------------------------------------
  // Shower mode — periodic worker context refresh
  // ---------------------------------------------------------------------------

  /**
   * Check if the worker is due for a shower (context refresh).
   * Returns true when enough rounds have elapsed since last shower.
   */
  #shouldShower(task) {
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
  async #performShower(workspace) {
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
    } catch (err) {
      log.error("shower mode: failed to write handoff request", { workspaceId, err: err.message });
      return false;
    }

    // Step 2: Inject short directive to worker
    const directive = `Read ${relDir}/SHOWER_REQUEST.md and follow it now. Write the handoff summary to ${relDir}/${HANDOFF_FILE}. After the file is written, stop and wait.`;
    this.#writeToSession(workerSessionId, directive);
    setTimeout(() => {
      this.#writeToSession(workerSessionId, "\r");
    }, 200);

    log.debug("shower mode: handoff directive sent, waiting for handoff file", { workspaceId });

    // Step 3: Wait for handoff file (poll with timeout)
    const handoffWritten = await this.#waitForFile(handoffPath, 120_000); // 2 min timeout

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
    } catch (err) {
      log.error("shower mode: failed to restart worker session", { workspaceId, err: err.message });
      return false;
    }

    // Step 5: Build and inject resume prompt with handoff context
    let handoffContent = "";
    try {
      handoffContent = await readFile(handoffPath, "utf8");
    } catch (err) {
      log.warn("shower mode: could not read handoff file after restart", { workspaceId, err: err.message });
    }

    const resumePrompt = this.#buildShowerResumePrompt(task, handoffContent);

    // Write the resume prompt to PROMPT.md — it will be injected via file-based
    // prompt when the new session goes idle (promptSent is reset below).
    const promptFilePath = path.join(dir, PROMPT_FILE);
    try {
      await writeFile(promptFilePath, resumePrompt, "utf8");
      log.debug("shower mode: resume prompt written to file", { workspaceId, promptLength: resumePrompt.length });
    } catch (err) {
      log.warn("shower mode: failed to write resume prompt file", { workspaceId, err: err.message });
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
  #buildShowerResumePrompt(task, handoffContent) {
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
      `- Read and obey \`${dir}/${TODO_FILE}\`, \`${dir}/${CRITERIA_FILE}\`, and \`${dir}/${WORK_LOCK_FILE}\`.`,
      `- Ignore \`${dir}/${JUDGE_TODO_FILE}\` — that file belongs to the judge.`,
      `- Continue working from where the previous session left off.`,
      `- Update \`${dir}/${TODO_FILE}\` as you make progress.`,
      `- Remove \`${dir}/${WORK_LOCK_FILE}\` only when the finish criteria genuinely pass.`,
      `- Do not ask the human whether you should continue. The judge decides that.`,
      `- When you are done, simply stop. Automated checks and a judge will verify your work.`,
    );

    return parts.join("\n");
  }

  /**
   * Poll for a file to appear with meaningful content, with timeout.
   * Returns true if file was found and has content, false if timeout.
   */
  async #waitForFile(filePath, timeoutMs = 120_000) {
    const start = Date.now();
    const pollInterval = 3000; // Check every 3 seconds

    while (Date.now() - start < timeoutMs) {
      try {
        await access(filePath);
        const content = await readFile(filePath, "utf8");
        const trimmed = content.trim();
        // Require meaningful content: at least 10 chars and contains
        // word characters (not just whitespace/punctuation/partial writes)
        if (trimmed.length > 10 && /\w/.test(trimmed)) {
          return true;
        }
      } catch {
        // File doesn't exist yet
      }
      await new Promise((resolve) => setTimeout(resolve, pollInterval));
    }

    return false;
  }

  // ---------------------------------------------------------------------------
  // Git context — read-only repo state for judge evaluation
  // ---------------------------------------------------------------------------

  /**
   * Ensure the project directory has a git repo. If not, run `git init`
   * so that git diff/status work for the judge. Never touches remotes.
   */
  async #ensureGitRepo(cwd) {
    const gitDir = path.join(cwd, ".git");
    try {
      await access(gitDir);
      log.trace("git repo exists", { cwd });
      return true; // Already a git repo
    } catch {
      // No .git directory — serialize concurrent init attempts per cwd
      if (this.#gitInitLocks.has(cwd)) {
        log.debug("git init already in progress, waiting", { cwd });
        return this.#gitInitLocks.get(cwd);
      }

      const initPromise = this.#doGitInit(cwd);
      this.#gitInitLocks.set(cwd, initPromise);
      try {
        return await initPromise;
      } finally {
        this.#gitInitLocks.delete(cwd);
      }
    }
  }

  async #doGitInit(cwd) {
    log.info("no git repo found, running git init", { cwd });
    try {
      // Re-check after acquiring lock — another caller may have finished first
      try {
        await access(path.join(cwd, ".git"));
        log.trace("git repo appeared while waiting for lock", { cwd });
        return true;
      } catch {
        // Still no .git — proceed
      }

      const result = await this.#execCommand("git init", cwd, 10_000);
      if (result.exitCode === 0) {
        log.info("git repo initialized", { cwd });
        // Create an initial commit so `git diff` has a baseline
        await this.#execCommand("git add -A", cwd, 10_000);
        await this.#execCommand(
          'git commit -m "Initial commit (auto-created by strideterm task runner)" --allow-empty',
          cwd,
          10_000,
        );
        log.info("initial commit created", { cwd });
        return true;
      }
      log.warn("git init failed", { cwd, exitCode: result.exitCode, stderr: result.stderr });
      return false;
    } catch (err) {
      log.warn("git init error", { cwd, err: err.message });
      return false;
    }
  }

  /**
   * Gather read-only git context for the judge prompt.
   * Returns { status, diffStat, diffNames } — all clipped for prompt size.
   *
   * Inspired by codex-runner's _repo_context() which runs the same three commands.
   * Clips output to prevent huge diffs from bloating the prompt.
   */
  async #getGitContext(cwd) {
    const empty = { status: "Not a git repository.", diffStat: "", diffNames: "" };
    const gitDir = path.join(cwd, ".git");
    try {
      await access(gitDir);
    } catch {
      log.debug("getGitContext: no .git directory", { cwd });
      return empty;
    }

    const MAX_LINES = 80;
    const MAX_CHARS = 5000;

    function clip(text, label = "output") {
      if (!text) return "(clean)";
      const lines = text.split("\n");
      const totalLines = lines.length;
      let clipped =
        totalLines > MAX_LINES
          ? lines.slice(0, MAX_LINES).join("\n") +
            `\n... (${totalLines - MAX_LINES} more lines hidden out of ${totalLines} total ${label} lines)`
          : text;
      if (clipped.length > MAX_CHARS) {
        clipped = clipped.slice(0, MAX_CHARS) + `\n... (${label} truncated at ${MAX_CHARS} chars)`;
      }
      return clipped;
    }

    try {
      const [statusResult, diffStatResult, diffNamesResult] = await Promise.all([
        this.#execCommand("git status --short", cwd, 10_000),
        this.#execCommand("git diff --stat", cwd, 10_000),
        this.#execCommand("git diff --name-only", cwd, 10_000),
      ]);

      const context = {
        status: clip(statusResult.stdout.trim(), "git status"),
        diffStat: clip(diffStatResult.stdout.trim(), "diff stat"),
        diffNames: clip(diffNamesResult.stdout.trim(), "changed files"),
      };

      log.debug("git context gathered", {
        cwd,
        statusLines: statusResult.stdout.split("\n").length,
        diffFiles: diffNamesResult.stdout.split("\n").filter(Boolean).length,
      });

      return context;
    } catch (err) {
      log.warn("failed to gather git context", { cwd, err: err.message });
      return empty;
    }
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  #findTaskWorkspace(workspaceId) {
    const state = this.#getState();
    const workspace = state.workspaces.find((w) => w.id === workspaceId);
    if (!workspace || workspace.kind !== "task" || !workspace.task) return null;
    return workspace;
  }

  /**
   * Inject a prompt into a PTY session. For short prompts (< FILE_PROMPT_THRESHOLD
   * chars) paste directly. For longer prompts, write to a file and send a short
   * directive — more reliable and avoids PTY paste issues with large text.
   *
   * Inspired by codex-runner's pattern of writing prompts to files and injecting
   * "Read {file} and follow it now" directives via tmux send_keys.
   */
  async #injectPrompt(sessionId, text, workspace) {
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
      } catch (err) {
        // Fall back to direct paste if file write fails
        log.warn("failed to write prompt file, falling back to direct paste", {
          sessionId,
          promptPath,
          err: err.message,
        });
      }
    }

    log.trace("injectPrompt: writing to PTY", { sessionId, length: injection.length, fileBased: injection !== text });
    this.#writeToSession(sessionId, injection);
    setTimeout(() => {
      log.trace("injectPrompt: sending Enter after 200ms delay", { sessionId });
      this.#writeToSession(sessionId, "\r");
    }, 200);
    log.debug("prompt injected", { sessionId, length: injection.length, originalLength: text.length });
  }

  /**
   * Stop the Worker's current activity when the task ends (completed or failed).
   *
   * Sends Ctrl+C to interrupt, then a clear stop message. The conversation
   * context is preserved so the user can still ask the Worker questions
   * about what it did. Background/scheduled tasks are prevented by
   * CLAUDE_CODE_DISABLE_BACKGROUND_TASKS env var set at session startup.
   */
  #notifyWorkerTaskEnded(workspace, kind) {
    if (!this.#writeToSession) return;
    const task = workspace.task;
    const workerSessionId = `${workspace.id}:${task.workerPanelId}`;

    log.info("sending stop signal to Worker", { workspaceId: workspace.id, kind });

    // 1. Ctrl+C to interrupt any running tool/command
    this.#writeToSession(workerSessionId, "\x03");

    // 2. After brief pause, tell Claude Code to stop — but keep context intact
    const reason =
      kind === "completed"
        ? "The Judge has approved your work. The task is complete."
        : "The task runner has stopped (max rounds or error).";
    setTimeout(() => {
      this.#writeToSession(
        workerSessionId,
        `\nThe task has ended: ${reason} Do not start new work or continue the previous task. Wait for the user.\r`,
      );
      log.debug("stop message sent to Worker", { workspaceId: workspace.id });
    }, 800);
  }

  /**
   * Raise a user-visible alert for a task event.
   * @param {object} workspace
   * @param {"completed"|"failed"} kind
   * @param {string} [reason] — human-readable context for the notification
   */
  #raiseTaskAlert(workspace, kind, reason) {
    if (!this.#raiseAlert) return;
    const task = workspace.task;
    const roundInfo = task.currentRound ? ` after ${task.currentRound} round${task.currentRound !== 1 ? "s" : ""}` : "";
    const detail = reason ? `task-${kind}: ${reason}` : `task-${kind}${roundInfo}`;
    log.info("raising task alert", { workspaceId: workspace.id, kind, detail });
    this.#raiseAlert({
      projectId: workspace.id,
      panelId: workspace.task.workerPanelId,
      sessionId: `${workspace.id}:${workspace.task.workerPanelId}`,
      title: workspace.name,
      kind: kind === "completed" ? "completed" : "waiting",
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
  async #logTaskEvent(workspace, event, detail) {
    const task = workspace?.task;
    if (!workspace?.cwd || !task?.taskId) return;

    const entry = {
      ts: new Date().toISOString(),
      event,
      round: task.currentRound || 0,
      ...(detail ? { detail } : {}),
    };

    const logPath = path.join(taskDir(workspace.cwd, task.taskId), TASK_LOG_FILE);
    try {
      await writeFile(logPath, JSON.stringify(entry) + "\n", { encoding: "utf8", flag: "a" });
    } catch (err) {
      log.debug("failed to write task event log", { logPath, err: err.message });
    }
  }
}

// Re-export for external consumers
export { parseFinishCriteriaMd, checkCommandSafety } from "./agent-task-utils.js";
