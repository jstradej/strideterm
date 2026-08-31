import { getAllProviders } from "./providers/provider-registry.js";
import { findWorkspace } from "./runtime-utils.js";
import {
  buildRecoveryPrompt,
  buildAttachedPrimaryRecoveryPrompt,
  buildAttachedCompanionRecoveryPrompt,
} from "./agent-task-prompts.js";
import { updateTaskDescriptionFile } from "./agent-task-files.js";
import { sessionIdFor } from "./agent-task-runner.js";
import { TASK_ACTIVE_STATES } from "../shared/task-states.js";
import { createRecoveryQueue } from "./shared/recovery-queue.js";
import type { Logger } from "./logger.js";
import type {
  AppState,
  RecoveryCandidate,
  RecoveryOrigin,
  RecoveryOutcome,
  RecoveryResult,
  WorkspaceState,
} from "../shared/types/state.js";

/**
 * What `resumeTask` / `resetTask` answer.
 *
 * Both endpoints have two shapes now: an ordinary runner call, and — when the
 * workspace is a startup RECOVERY CANDIDATE — a recovery decision routed
 * through the same executor and the same per-workspace lock as the dialog
 * (V6 review, §"P1 — recovery `stale`", oprava 5 and 6). `outcomes` is present
 * exactly in the second case, so a caller can tell the two apart.
 */
interface TaskActionResult<Payload> {
  ok: boolean;
  outcomes?: Record<string, RecoveryOutcome>;
  payload: Payload;
}

/**
 * Runtime context subset consumed by the task-runner API handlers.
 * The full runtime ctx is typed as a structural interface so new fields
 * can be added without breaking this module. Generic over `Payload` so the
 * handlers below keep getPayload()'s real (inferred) return type instead of
 * widening it to `unknown` — runtime.test.ts asserts on the payload shape.
 */
interface TaskHandlerCtx<Payload> {
  log: Logger;
  getState: () => AppState;
  getPayload: () => Payload;
  broadcastState: () => void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  store: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  taskRunner: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sessions: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  execFileTextImpl: (cmd: string, args: string[], opts?: any) => Promise<{ stdout: string; stderr: string }>;
  recheckClaudeAvailability: () => Promise<boolean>;
  assertWorkspaceInViewerProfile: (workspaceId: string, windowId: string | undefined) => void;
  /** Stamp `lastWorkedAt` after an allowlisted user action succeeded. */
  recordWorkspaceWork: (workspaceId: string, viewerId?: string) => Promise<void>;
  resolveCallerProfileId: (state: AppState, windowId: string | undefined, parentWorkspaceId?: string) => string;
  assertNoConflictingActiveTask: (
    state: AppState,
    intendedCwd: string,
    callerProfileId: string,
    selfWorkspaceId?: string | null,
  ) => void;
  worktreeTreePath: (repoPath: string, branchOrName: string) => string;
  ensureWorktree: (
    repoPath: string,
    branchOrName: string,
    options?: { richErrorHandling?: boolean },
  ) => Promise<string>;
  getRecoveryCandidates: () => RecoveryCandidate[];
  setRecoveryCandidates: (next: RecoveryCandidate[]) => void;
  /**
   * Post-commit teardown + notification-removal event for a workspace that has
   * just been dropped from state. See runtime.ts for the full contract; call
   * only AFTER the mutation commits.
   */
  finalizeWorkspaceRemoval: (workspace: { id: string; profileId: string }) => Promise<void>;
}

/**
 * Factory for the task-runner API handlers (recheckClaude, checkProviders,
 * checkIsGitRepo, probeDirectory, createTaskWorkspace, start/stop/pause/
 * resume/reset-task, updateTaskDescription, rejectTaskVerdict,
 * resendTaskInstruction, getTaskStatus, resolveTaskRecovery). Extracted from
 * runtime.ts to reduce file size, following the same ctx-factory pattern as
 * runtime-git-handlers.ts / runtime-attention.ts.
 *
 * Several handlers below call `this.saveWorkspace` / `this.activateWorkspace`
 * / `this.activateWorkspaceInWindow` / `this.resolveTaskRecovery` — these
 * keep working once this object is spread into the final runtime object,
 * because method-call syntax (`runtime.createTaskWorkspace()`) binds `this`
 * to the full merged object at call time, not to this factory's return value.
 */
export function createTaskHandlers<Payload>(ctx: TaskHandlerCtx<Payload>) {
  const {
    log,
    getState,
    getPayload,
    broadcastState,
    store,
    taskRunner,
    sessions,
    execFileTextImpl,
    recheckClaudeAvailability,
    assertWorkspaceInViewerProfile,
    recordWorkspaceWork,
    resolveCallerProfileId,
    assertNoConflictingActiveTask,
    worktreeTreePath,
    ensureWorktree,
    getRecoveryCandidates,
    setRecoveryCandidates,
    finalizeWorkspaceRemoval,
  } = ctx;

  /**
   * Bring up one PTY session for a recovery candidate.
   *
   * `required` separates the session the recovery IS from the one it merely
   * pre-warms: the deferred idle fires on the ROLE's own session, so without
   * it there is nothing for the orientation prompt to be injected into and the
   * candidate has genuinely failed. The other role's PTY is spawned only so
   * the loop can hand over later without a cold start — losing it is a warning
   * and nothing more (V4 review, §"P1", oprava 3).
   */
  async function ensureRecoverySession(
    state: AppState,
    sessionId: string,
    context: { workspaceId: string; role: string; required: boolean },
  ): Promise<boolean> {
    try {
      await sessions.ensureSession(state, sessionId);
      return true;
    } catch (err) {
      log.warn("resolveTaskRecovery: ensureSession failed", {
        ...context,
        sessionId,
        err: (err as Error).message,
      });
      return false;
    }
  }

  /**
   * Commit the two halves of a "continue" — the staged orientation prompt and
   * the paused → active transition — as ONE step, and undo the first half if
   * the second is refused.
   *
   * The prompt MUST be staged before the state flip: `#reconcileAfterResume`
   * branches on `showerResumePrompt` to decide that recovery owns the next
   * injection, so a resume that happened first would take a different branch
   * and inject the wrong thing. But `resumeTask` can still refuse (a state
   * that is not resumable, a missing attached Primary), and leaving the staged
   * prompt behind meant a paused task carried a recovery prompt that would be
   * injected later, during some unrelated action (V5 review, §"P1", oprava 3
   * and 4). So on a refusal the previous `promptSent` / `showerResumePrompt`
   * are put back and the task is exactly where it started.
   *
   * A THROWN `resumeTask` is handled like a refusal, with one exception the
   * response must not lie about: the runner can throw AFTER it has already
   * flipped the task to an active state. Rolling the staged prompt back and
   * reporting `failed` would then leave the dialog claiming a paused,
   * retryable task while the agent is genuinely running (V6 review, §"P1 —
   * recovery `stale`", oprava 7). So the committed state is re-read, and only
   * a task that really is still paused is rolled back.
   *
   * Returns what actually happened:
   *   - `"resumed"`            the runner accepted; the task is running;
   *   - `"active-after-throw"` the runner threw but had already committed the
   *                            active state — the staged prompt belongs to
   *                            the running task and stays;
   *   - `"refused"`            nothing happened; the staging is rolled back.
   */
  async function commitRecoveryResume(
    workspaceId: string,
    staged: { promptSent?: boolean; showerResumePrompt: string },
  ): Promise<"resumed" | "active-after-throw" | "refused"> {
    // Read the fields to restore BEFORE the mutation rather than inside it —
    // there is nothing to roll back to once the draft has been applied.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const before = findWorkspace(getState(), workspaceId) as any;
    const previousPromptSent = !!before?.task?.promptSent;
    const previousResumePrompt = String(before?.task?.showerResumePrompt || "");

    await store.mutate((draft: AppState) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const dws = draft.workspaces.find((w: any) => w.id === workspaceId);
      if (!dws?.task) return;
      if (staged.promptSent !== undefined) dws.task.promptSent = staged.promptSent;
      dws.task.showerResumePrompt = staged.showerResumePrompt;
    });

    let thrown: Error | null = null;
    try {
      if (taskRunner.resumeTask(workspaceId)) return "resumed";
    } catch (err) {
      thrown = err as Error;
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const after = findWorkspace(getState(), workspaceId) as any;
    if (TASK_ACTIVE_STATES.has(String(after?.task?.state || ""))) {
      log.warn("resolveTaskRecovery: resumeTask failed but the task is already active — keeping the staged prompt", {
        workspaceId,
        state: String(after?.task?.state || ""),
        err: thrown?.message,
      });
      return "active-after-throw";
    }

    log.warn("resolveTaskRecovery: resumeTask refused — rolling the staged recovery prompt back", {
      workspaceId,
      err: thrown?.message,
    });
    await store.mutate((draft: AppState) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const dws = draft.workspaces.find((w: any) => w.id === workspaceId);
      if (!dws?.task) return;
      dws.task.promptSent = previousPromptSent;
      dws.task.showerResumePrompt = previousResumePrompt;
    });
    return "refused";
  }

  /**
   * Force-trigger onAgentIdle a few seconds after the resume instead of
   * waiting for hook-fallback silence (HOOK_FALLBACK_SILENCE_MS = 2 min).
   *
   * Why this is necessary: a freshly-spawned Claude Code session doesn't fire
   * its Stop hook until *after* it processes a turn — there's nothing to stop
   * yet. The runtime treats hook-capable sessions as hook-primary and gates
   * silence detection behind a 2-minute fallback. Without this nudge, the user
   * clicks Resume and sees the agent sit at an empty prompt for two full
   * minutes before the recovery prompt finally gets pasted in.
   *
   * The session is now spawned BEFORE the resume (see the preflight in
   * `resolveTaskRecovery`), so the agent's own banner-then-idle may well fire
   * while the task is still paused. That is harmless: both idle handlers fall
   * straight through for a paused task without consuming anything, and this
   * nudge — scheduled only once the resume has actually committed — is what
   * drives the injection.
   */
  function scheduleDeferredIdleNudge(workspaceId: string, idleSessionId: string, role: string): void {
    log.info("resolveTaskRecovery: scheduling deferred idle nudge", {
      workspaceId,
      role,
      idleSessionId,
      delayMs: 5000,
    });
    setTimeout(() => {
      log.info("resolveTaskRecovery: firing deferred onAgentIdle", { workspaceId, idleSessionId });
      try {
        const handled = taskRunner.onAgentIdle(idleSessionId, "recovery-deferred");
        log.info("resolveTaskRecovery: deferred onAgentIdle returned", { workspaceId, idleSessionId, handled });
      } catch (err) {
        log.warn("resolveTaskRecovery: deferred onAgentIdle threw", {
          workspaceId,
          err: (err as Error).message,
        });
      }
    }, 5000);
  }

  /**
   * PER-WORKSPACE recovery serialization.
   *
   * `applyTaskRecovery` used to read `recoveryCandidates` once, before the
   * loop, and then await `ensureSession()` / `resetTask()` — so two windows
   * holding the same dialog could both find the same candidate, both act on
   * it, and the loser would finally write a candidate list derived from its
   * own stale snapshot, re-inserting a candidate the winner had already
   * settled or resuming a task the winner had just reset (V6 review, §"P1 —
   * recovery `stale` řeší jen sekvenční, ne skutečný multi-window race").
   * `stale` only ever appeared when the second request STARTED after the first
   * had finished, which is precisely the case that was never the problem.
   *
   * So every decision path for one workspace id — the dialog's
   * Continue / Start fresh / Skip, the Dashboard's Resume, and Reset — passes
   * through this queue. Requests run in arrival order and never overlap, and
   * the candidate is re-read INSIDE the lock, so the second one sees the
   * world the first one left: settled → `stale`, still failed → a genuine
   * retry.
   *
   * Two different workspace ids never wait on each other — the map is keyed
   * per workspace, and an entry is dropped as soon as nothing is queued behind
   * it, so the map is empty again once the sidebar is idle.
   */
  const recoveryQueue = createRecoveryQueue();

  /**
   * Execute ONE recovery decision. The caller MUST already hold this
   * workspace's lock, and `candidate` MUST have been read inside it.
   *
   * Settling removes the candidate from the CURRENT list rather than from a
   * pre-await copy, so a decision made on a neighbouring workspace while this
   * one was awaiting a PTY is never undone.
   */
  async function settleRecoveryDecision(
    workspaceId: string,
    decision: string,
    candidate: RecoveryCandidate | undefined,
  ): Promise<RecoveryOutcome> {
    const outcome = await runRecoveryDecision(workspaceId, decision, candidate);
    // A FAILED candidate deliberately stays: a half-recovered task that
    // silently vanishes from the dialog is exactly the state the user cannot
    // diagnose, and leaving it is what makes the retry in the matrix possible.
    if (outcome !== "failed" && outcome !== "stale") {
      setRecoveryCandidates(getRecoveryCandidates().filter((c) => c.workspaceId !== workspaceId));
    }
    return outcome;
  }

  async function runRecoveryDecision(
    workspaceId: string,
    decision: string,
    candidate: RecoveryCandidate | undefined,
  ): Promise<RecoveryOutcome> {
    if (!candidate) {
      // Already settled — by this window's own earlier call, or by another
      // window that got there first, possibly while this request was waiting
      // on the lock. Not an error and not work: the renderer may drop it from
      // its list, and nothing is stamped.
      log.info("applyTaskRecovery: no candidate for this workspace (already settled)", { workspaceId, decision });
      return "stale";
    }

    if (decision === "skip") return "skipped";

    try {
      if (decision === "fresh") {
        const reset = await taskRunner.resetTask(workspaceId);
        // The runner refuses a state it cannot reset. That is a real
        // failure, not a quiet no-op that leaves the task where it was.
        if (reset === false) {
          log.warn("resolveTaskRecovery: resetTask refused the task", { workspaceId });
          return "failed";
        }
        return "fresh";
      }

      // "continue" — build an orientation prompt and resume the agent.
      // pausedFromState was set by #reconcileOnStartup, so resumeTask
      // resumes to the correct role (worker or judge-evaluating).
      const role = candidate.previousState === "judge-evaluating" ? "judge" : "worker";

      const state = getState();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const ws = state.workspaces.find((w: any) => w.id === workspaceId) as any;
      if (!ws?.task) {
        // The workspace (or its task) disappeared between the reconcile
        // sweep and this decision — there is nothing left to resume.
        log.warn("resolveTaskRecovery: task workspace no longer exists", { workspaceId, hasWs: !!ws });
        return "failed";
      }

      if (ws.task.mode === "attached") {
        const attachedTask = ws.task;
        // Attached tasks never blindly respawn the externally-owned
        // Primary as if it were a fresh/unrelated panel (plan §8.7 step
        // 5) — they re-spawn the SAME existing source panel only after
        // confirming it (and its workspace) still exist.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const sourceWs = state.workspaces.find((w: any) => w.id === attachedTask.workerWorkspaceId);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const sourcePanelExists = (sourceWs?.panels || []).some((p: any) => p.id === attachedTask.workerPanelId);
        if (!sourceWs || !sourcePanelExists) {
          log.warn("resolveTaskRecovery: attached task's source panel no longer exists", { workspaceId });
          await store.mutate((draft: AppState) => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const dws = draft.workspaces.find((w: any) => w.id === workspaceId);
            if (dws?.task) dws.task.pausedFromState = candidate.previousState;
          });
          // Leave it paused with an actionable, truthful error instead of
          // guessing — "Primary conversation no longer exists".
          taskRunner.markAttachedSourceMissing(workspaceId);
          return "failed";
        }

        // PREFLIGHT, still paused. Only the role that was actually
        // mid-flight needs a fresh PTY: the Companion panel belongs to
        // this task workspace and is always safe to re-spawn; the Primary
        // panel is re-spawned only because it's the SAME pre-existing
        // source panel, not a new one. Its failure fails the candidate —
        // and failing here leaves the task paused and retryable, which is
        // the whole point of doing it before the state flip.
        const idleSessionId = sessionIdFor(ws, role);
        if (!(await ensureRecoverySession(state, idleSessionId, { workspaceId, role, required: true }))) {
          return "failed";
        }

        const attachedPrompt =
          role === "worker"
            ? buildAttachedPrimaryRecoveryPrompt(attachedTask, candidate.currentRound)
            : buildAttachedCompanionRecoveryPrompt(attachedTask, candidate.currentRound);

        const committed = await commitRecoveryResume(workspaceId, { showerResumePrompt: attachedPrompt });
        if (committed === "refused") return "failed";

        scheduleDeferredIdleNudge(workspaceId, idleSessionId, role);
        return "continued";
      }

      // PREFLIGHT, in this order, all of it while the task is still
      // PAUSED (V5 review, §"P1 — failed recovery může zanechat task jako
      // running bez session"): the panel to re-orient in, then the PTY it
      // needs. Both used to run after `resumeTask()` had already flipped
      // the task to running and cleared `pausedFromState`, so a failure
      // reported `failed` while leaving an active task with no session —
      // un-retryable (resume refuses an active task), un-skippable without
      // a RUNNING ghost, and carrying a staged prompt that would be
      // injected into some later, unrelated action.
      //
      // Re-spawning is necessary at all because after an app restart the
      // prior PTYs are gone with the parent process. The REQUIRED one is
      // the role's own session — the deferred idle fires on it and the
      // orientation prompt is injected there — so its failure fails the
      // candidate; the other role's panel is only pre-warmed for the later
      // handover, and is therefore left until after the commit.
      const workerPanelId = String(ws.task.workerPanelId || "");
      const judgePanelId = String(ws.task.judgePanelId || "");
      const requiredPanelId = role === "judge" && judgePanelId ? judgePanelId : workerPanelId;
      if (!requiredPanelId) {
        log.warn("resolveTaskRecovery: no panel to re-orient in — cannot recover", {
          workspaceId,
          role,
          workerPanelId,
          judgePanelId,
        });
        return "failed";
      }
      const idleSessionId = `${workspaceId}:${requiredPanelId}`;
      if (!(await ensureRecoverySession(state, idleSessionId, { workspaceId, role, required: true }))) {
        return "failed";
      }

      // COMMIT. `showerResumePrompt` is reused for the orientation text
      // (it was originally the periodic "fresh-context shower" field —
      // both flows want the same thing: replace the next idle's prompt),
      // and `promptSent = false` is what selects the injection path in
      // onAgentIdle. Staging and the state flip go in together so a
      // refused resume cannot leave the prompt behind.
      const recoveryPrompt = buildRecoveryPrompt({
        role,
        round: candidate.currentRound,
        taskId: candidate.taskId,
      });
      const committed = await commitRecoveryResume(workspaceId, {
        promptSent: false,
        showerResumePrompt: recoveryPrompt,
      });
      if (committed === "refused") return "failed";

      // Best-effort pre-warm of the other role's PTY, after the commit:
      // losing it costs a cold start at the next handover, nothing more.
      const helperPanelId = requiredPanelId === workerPanelId ? judgePanelId : workerPanelId;
      if (helperPanelId) {
        await ensureRecoverySession(state, `${workspaceId}:${helperPanelId}`, {
          workspaceId,
          role,
          required: false,
        });
      }

      scheduleDeferredIdleNudge(workspaceId, idleSessionId, role);
      return "continued";
    } catch (err) {
      // A candidate that threw used to be logged and then counted as part
      // of a successful batch. It is a failure like any other.
      log.warn("resolveTaskRecovery: failed for workspace", { workspaceId, err: (err as Error).message });
      return "failed";
    }
  }

  /**
   * Turn a set of settled outcomes into the response, stamping the work an
   * INTERACTIVE decision represents exactly once.
   *
   * An explicit decision the user made in the recovery dialog is work in the
   * same sense a Dashboard Continue is: `continued` brought the agent back,
   * `fresh` reset the task to a clean, startable state, and both are on the V2
   * work allowlist. `skipped`, `stale` and `failed` changed nothing the user
   * could call working somewhere, so they stamp nothing.
   */
  async function finalizeRecovery(
    outcomes: Record<string, RecoveryOutcome>,
    profileByWorkspace: Map<string, string>,
    options?: { origin?: RecoveryOrigin; viewerId?: string },
  ): Promise<RecoveryResult<Payload>> {
    if (options?.origin === "interactive") {
      const viewerProfileId = options.viewerId ? resolveCallerProfileId(getState(), options.viewerId) : "";
      for (const [workspaceId, outcome] of Object.entries(outcomes)) {
        if (outcome !== "continued" && outcome !== "fresh") continue;
        // The dialog triages candidates from EVERY profile on purpose — that
        // is what its profile badge is for — so a decision on a candidate
        // outside the deciding window's profile is legitimate and must still
        // be credited. Handing `recordWorkspaceWork` the viewer in that case
        // would make it skip the stamp as a cross-profile write, and the
        // work would silently disappear from the owning profile's recent
        // list. Ownership comes from the candidate, so the viewer is passed
        // only when the two agree.
        const candidateProfileId = profileByWorkspace.get(workspaceId) || "";
        const sameProfile = !viewerProfileId || !candidateProfileId || candidateProfileId === viewerProfileId;
        await recordWorkspaceWork(workspaceId, sameProfile ? options.viewerId : undefined);
      }
    }

    broadcastState();
    return {
      ok: Object.values(outcomes).every((outcome) => outcome !== "failed"),
      outcomes,
      payload: getPayload(),
    };
  }

  return {
    async recheckClaude() {
      const available = await recheckClaudeAvailability();
      return { available, payload: getPayload() };
    },
    async checkProviders() {
      const results: Record<string, unknown> = {};
      for (const ProviderClass of getAllProviders()) {
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          results[(ProviderClass as any).id] = await new (ProviderClass as any)().checkAvailability();
        } catch (err) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          results[(ProviderClass as any).id] = { available: false, error: (err as Error).message };
        }
      }
      return results;
    },
    // Lightweight probe used by the task workspace dialog to decide whether
    // "Create in git worktree" makes sense for the chosen cwd. Treats any
    // failure (non-existent path, not a git repo, git CLI missing) as
    // "not a repo" — the caller just wants a boolean to gate the checkbox.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async checkIsGitRepo(cwd: any) {
      const trimmed = String(cwd || "").trim();
      if (!trimmed) return { isGitRepo: false, reason: "empty" };
      try {
        const { stdout } = await execFileTextImpl("git", ["rev-parse", "--is-inside-work-tree"], { cwd: trimmed });
        return { isGitRepo: stdout.trim() === "true" };
      } catch (err) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const stderr = (err as any)?.stderr?.trim() || (err as any)?.error?.message || "";
        if (stderr.includes("not a git repository")) return { isGitRepo: false, reason: "not-a-repo" };
        // Could not even run git — treat as "unknown" so the dialog stays
        // permissive rather than blocking based on a transient failure.
        return { isGitRepo: false, reason: "error", error: stderr || "unknown error" };
      }
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async probeDirectory(cwd: any) {
      const trimmed = String(cwd || "").trim();
      if (!trimmed) return { path: "", isGitRepo: false, childRepos: [], scannedDepth: 0, truncated: false };
      const { probeDirectory: probe } = await import("./fs-probe.js");
      return probe(trimmed);
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async createTaskWorkspace(config: any, windowId?: string) {
      log.info("createTaskWorkspace", {
        cwd: config.cwd,
        hasDescription: !!config.description,
        useWorktree: !!config.useWorktree,
      });
      const state = getState();

      // Refuse upfront if the parent lives in another profile. Without this,
      // a remote/mobile client bound to profile B could spawn a task
      // workspace (and worktree on disk) under a profile-A parent just by
      // passing its ID — the old logic only suppressed the slot mirror.
      if (config.parentWorkspaceId) {
        assertWorkspaceInViewerProfile(config.parentWorkspaceId, windowId);
      }

      // Compute the *intended* effective cwd up-front so the same-cwd guard
      // can fire BEFORE any worktree disk side effects. Previously the
      // gitignore write, parent mkdir, and `git worktree add` all ran first;
      // a same-cwd race in useWorktree mode would leave orphan files behind
      // even though the create ultimately threw.
      let effectiveCwd = config.cwd;
      let worktreeBase = "";
      let worktreeBranch = "";
      let plannedBranch = "";
      let plannedTreePath = "";
      if (config.useWorktree) {
        const branch = (config.worktreeBranch || "").trim();
        if (!branch || !/^[a-zA-Z0-9._/-]+$/.test(branch)) {
          throw new Error(
            "Worktree branch name must contain only alphanumeric characters, dots, hyphens, slashes, or underscores.",
          );
        }
        plannedBranch = branch;
        plannedTreePath = worktreeTreePath(config.cwd, branch);
        effectiveCwd = plannedTreePath;
      }

      // Refuse same-cwd duplicates that would race on the filesystem and
      // produce a stuck UI. Profile-scoped: a task in profile A does not
      // block a task in profile B at the same path (CLAUDE.md: "profiles
      // are organizational, not storage isolation" — users with separate
      // dev/work profiles legitimately share a monorepo).
      const callerProfileId = resolveCallerProfileId(state, windowId, config.parentWorkspaceId);
      assertNoConflictingActiveTask(state, effectiveCwd, callerProfileId);
      // Preserved for the return shape — callers (telegram, etc.) historically
      // received an empty string when no conflict was detected. Always empty
      // now that conflicts throw, but kept for API stability.
      const cwdWarning = "";

      // --- Git worktree mode: actual disk operations (after guard) ---
      if (config.useWorktree) {
        await ensureWorktree(config.cwd, plannedBranch, { richErrorHandling: true });

        worktreeBase = config.cwd;
        worktreeBranch = plannedBranch;
        log.info("createTaskWorkspace: worktree created", {
          treePath: plannedTreePath,
          branch: plannedBranch,
          base: config.cwd,
        });
      }
      const workspace = taskRunner.createTaskWorkspace({
        state,
        description: config.description,
        cwd: effectiveCwd,
        parentWorkspaceId: config.parentWorkspaceId,
        maxRounds: config.maxRounds,
        name: config.name,
        icon: config.icon,
        color: config.color,
        notes: config.notes,
        workerCommand: config.workerCommand,
        judgeCommand: config.judgeCommand,
        workerProvider: config.workerProvider,
        judgeProvider: config.judgeProvider,
        callerProfileId,
      });

      // Store worktree metadata in task object
      if (worktreeBase) {
        workspace.task.worktreeBase = worktreeBase;
        workspace.task.worktreeBranch = worktreeBranch;
      }

      // Inherit gitRoots for non-worktree tasks running inside a multi-repo parent workspace
      if (Array.isArray(config.gitRoots) && config.gitRoots.length >= 2 && !config.useWorktree) {
        workspace.gitRoots = config.gitRoots;
      }

      // Write task files immediately so they're available in the Dashboard.
      // If this fails (disk full, permissions), don't persist a broken workspace.
      try {
        await taskRunner.writeInitialFiles(workspace.cwd, workspace.task);
      } catch (err) {
        log.error("createTaskWorkspace: failed to write initial task files", {
          workspaceId: workspace.id,
          cwd: workspace.cwd,
          err: (err as Error).message,
        });
        throw new Error(`Failed to create task files: ${(err as Error).message}`, { cause: err });
      }
      // saveWorkspace normalizes and persists — and, because this is a NEW
      // workspace, stamps `lastWorkedAt` (V2 plan allowlist: "creating a task
      // workspace"). No second stamp is needed here.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (this as any).saveWorkspace(workspace);
      // If running in a git worktree, remove any "Worktree of" entry that
      // syncWorktrees may have created for the same directory before the task
      // workspace was registered (race-condition cleanup).
      if (worktreeBase) {
        const taskCwd = workspace.cwd || "";
        const taskProfileId = workspace.profileId || "default";
        // Scoped by profile as well as cwd. Two profiles legitimately hold
        // workspaces at the same path (CLAUDE.md: profiles group workspaces,
        // they do not isolate storage), and a cwd-only filter silently deleted
        // the other profile's worktree entry.
        const isReplacedWorktree = (w: WorkspaceState): boolean =>
          w.id !== workspace.id &&
          w.cwd === taskCwd &&
          (w.notes || "").startsWith("Worktree of ") &&
          (w.profileId || "default") === taskProfileId;
        const replaced = getState().workspaces.filter(isReplacedWorktree);
        await store.mutate((draft: AppState) => {
          draft.workspaces = draft.workspaces.filter((w) => !isReplacedWorktree(w));
        });
        // The discovered entry is gone for good — same lifecycle as any other
        // workspace removal, including its notification history.
        for (const removed of replaced) {
          void finalizeWorkspaceRemoval(removed);
        }
      }
      // Activate the new workspace unless the caller explicitly opted out
      // (e.g. Telegram-driven creation, where the user is in another workspace
      // and shouldn't have their UI yanked away). Use the slot-aware variant
      // when the calling window is known — otherwise the global update alone
      // leaves the per-window slot stuck on the previous workspace and the UI
      // flickers (same root cause as openAzurePullRequest).
      if (config.activate !== false) {
        if (windowId) {
          // activateWorkspaceInWindow refuses cross-profile mutation. That's
          // expected when a remote/UI client triggers task creation under a
          // parent in another profile (the new task inherits the parent's
          // profile, not the caller's window). Treat that as "task created
          // but don't yank the slot"; broadcastState so the new entry shows
          // up everywhere it should.
          try {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            await (this as any).activateWorkspaceInWindow(workspace.id, windowId);
          } catch (err) {
            log.info("createTaskWorkspace: skipping slot activation (cross-profile)", {
              workspaceId: workspace.id,
              windowId,
              err: (err as Error).message,
            });
            broadcastState();
          }
        } else {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          await (this as any).activateWorkspace(workspace.id);
        }
      } else {
        broadcastState();
      }
      return { workspaceId: workspace.id, cwdWarning, payload: getPayload() };
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async startTask(workspaceId: any, windowId?: string) {
      assertWorkspaceInViewerProfile(String(workspaceId), windowId);
      // Close the loop: createTaskWorkspace allows multiple inert tasks at the
      // same cwd, so the user could end up with two paused tasks pointing at
      // the same directory. Starting one is fine; starting BOTH would put two
      // worker agents in the same worktree, racing on TASK_LOG.jsonl and
      // source files. Refuse the second start with the same message the
      // create path uses, so the error is consistent across surfaces.
      const state = getState();
      const workspace = findWorkspace(state, String(workspaceId));
      if (workspace?.kind === "task" && workspace.cwd) {
        assertNoConflictingActiveTask(state, workspace.cwd, workspace.profileId || "default", workspace.id);
      }
      const result = await taskRunner.startTask(workspaceId);
      // Starting a task IS work — but only when the runner accepted it.
      if (result) await recordWorkspaceWork(String(workspaceId), windowId);
      return { ok: result, payload: getPayload() };
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    stopTask(workspaceId: any, windowId?: string) {
      assertWorkspaceInViewerProfile(String(workspaceId), windowId);
      const result = taskRunner.stopTask(workspaceId);
      return { ok: result, payload: getPayload() };
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    pauseTask(workspaceId: any, windowId?: string) {
      assertWorkspaceInViewerProfile(String(workspaceId), windowId);
      const result = taskRunner.pauseTask(workspaceId);
      return { ok: result, payload: getPayload() };
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async resumeTask(workspaceId: any, windowId?: string): Promise<TaskActionResult<Payload>> {
      assertWorkspaceInViewerProfile(String(workspaceId), windowId);
      const id = String(workspaceId);
      // Krok 6 — a startup recovery candidate needs the FULL recovery path
      // (re-spawn the dead PTYs, stash the recovery prompt, fire the deferred
      // idle). Plain resumeTask only flips state and can't respawn PTYs, so a
      // Dashboard/Sidebar "Continue" on such a task did nothing (incident B).
      // Delegate to the recovery executor, which owns that path — and, since
      // V6, the per-workspace lock that makes a Dashboard Resume and a dialog
      // Continue on the same task two ordered requests instead of two
      // concurrent ones (V6 review, §"P1 — recovery `stale`", oprava 6). The
      // candidate is re-read inside that lock, so a decision another window
      // settled while this one waited answers `stale` rather than resuming a
      // task that has already been reset.
      if (getRecoveryCandidates().some((c) => c.workspaceId === id)) {
        log.info("resumeTask: delegating recovery candidate to applyTaskRecovery", { workspaceId: id });
        // The result is AWAITED rather than returned directly, so the
        // allowlisted stamp still happens: clicking Continue on a recovery
        // candidate is explicit user work, and returning early skipped it
        // entirely (V3 review, §4 P2).
        //
        // The delegation goes to the INTERNAL executor: this wrapper owns the
        // stamp for its own endpoint, so routing through the interactive one
        // would credit the same click twice (V5 review, §"P1 — recovery dialog
        // obchází work stamp").
        //
        // The gate is this candidate's OWN outcome, not the batch's `ok`: only
        // a genuine "continued" — agent resumed and its session up — is work.
        // A refused resume, a dangling attached Primary or a session that
        // never came up leaves the workspace exactly where it was (V4 review,
        // §"P1 — task recovery hlásí úspěch", oprava 2).
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const recovered = await (this as any).applyTaskRecovery({ [id]: "continue" }, { origin: "internal" });
        if (recovered?.outcomes?.[id] !== "continued") return recovered;
        await recordWorkspaceWork(id, windowId);
        return { ...recovered, payload: getPayload() };
      }
      // Resume re-spawns worker/judge PTYs, so the same guard as startTask
      // applies — refuse if another task in this profile is already actively
      // touching the same cwd.
      const state = getState();
      const workspace = findWorkspace(state, id);
      if (workspace?.kind === "task" && workspace.cwd) {
        assertNoConflictingActiveTask(state, workspace.cwd, workspace.profileId || "default", workspace.id);
      }
      const result = taskRunner.resumeTask(workspaceId);
      if (result) await recordWorkspaceWork(id, windowId);
      return { ok: !!result, payload: getPayload() };
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async resetTask(workspaceId: any, windowId?: string): Promise<TaskActionResult<Payload>> {
      assertWorkspaceInViewerProfile(String(workspaceId), windowId);
      const id = String(workspaceId);
      // Reset used to bypass the recovery executor entirely: it flipped the
      // task to `idle` while the candidate stayed in the dialog, whose next
      // Retry was then refused as a task that no longer needs recovering
      // (V6 review, §"P1 — recovery `stale`", the second gap). A reset of a
      // candidate IS the `fresh` decision, so it takes the same path, the
      // same lock and the same settlement — and, exactly like resumeTask,
      // delegates INTERNALLY and keeps the single stamp here.
      if (getRecoveryCandidates().some((c) => c.workspaceId === id)) {
        log.info("resetTask: delegating recovery candidate to applyTaskRecovery", { workspaceId: id });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const recovered = await (this as any).applyTaskRecovery({ [id]: "fresh" }, { origin: "internal" });
        if (recovered?.outcomes?.[id] !== "fresh") return recovered;
        await recordWorkspaceWork(id, windowId);
        return { ...recovered, payload: getPayload() };
      }
      const result = await taskRunner.resetTask(workspaceId);
      if (result) await recordWorkspaceWork(id, windowId);
      return { ok: !!result, payload: getPayload() };
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async updateTaskDescription(workspaceId: any, description: any, windowId?: string) {
      assertWorkspaceInViewerProfile(String(workspaceId), windowId);
      const id = String(workspaceId || "");
      const desc = String(description ?? "");
      const workspace = findWorkspace(getState(), id);
      if (!workspace || workspace.kind !== "task" || !workspace.task) {
        log.warn("updateTaskDescription: not a task workspace", { workspaceId: id });
        return { ok: false, payload: getPayload() };
      }
      const taskId = workspace.task.taskId;
      const cwd = workspace.cwd;
      try {
        await updateTaskDescriptionFile(cwd, taskId, desc, log);
      } catch (err) {
        log.warn("updateTaskDescription: failed to write TASK.md", {
          workspaceId: id,
          err: (err as Error).message,
        });
        return { ok: false, payload: getPayload() };
      }
      // Mirror the change in memory so the dashboard updates immediately
      // without having to wait for the next startTask refresh.
      await store.mutate((draft: AppState) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const ws = draft.workspaces.find((w: any) => w.id === id);
        if (ws?.task) {
          ws.task.description = desc;
          if (!ws.name || ws.name === "Task workspace") {
            const trimmed = desc.trim();
            if (trimmed) {
              ws.name = trimmed.length > 50 ? trimmed.slice(0, 47) + "..." : trimmed;
            }
          }
        }
      });
      // Editing the brief IS work — the write to TASK.md already succeeded.
      await recordWorkspaceWork(id, windowId);
      broadcastState();
      return { ok: true, payload: getPayload() };
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async rejectTaskVerdict(workspaceId: any, feedback: any) {
      const result = await taskRunner.rejectTaskVerdict(workspaceId, feedback);
      // Rejecting a verdict with feedback is the user answering the loop —
      // work, like answerCompanionTask (V2 plan allowlist).
      if (result) await recordWorkspaceWork(String(workspaceId));
      return { ok: result, payload: getPayload() };
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async resendTaskInstruction(workspaceId: any, role: any) {
      const result = await taskRunner.resendLastInstruction(String(workspaceId), role === "judge" ? "judge" : "worker");
      return { ok: result, payload: getPayload() };
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    getTaskStatus(workspaceId: any) {
      return taskRunner.getTaskState(workspaceId);
    },

    /**
     * Attach a Companion (Reviewer/Planner/Consultant/Critic) to an existing
     * live conversation — plan §8.1. Every authoritative input (source
     * workspace/panel, effective cwd, parent, profile) is derived from
     * `sourceSessionId` server-side; the client cannot supply its own cwd or
     * profile. Creates a new "attached" task workspace with only a Dashboard
     * + Companion panel — the Primary keeps living in its own workspace.
     */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async createCompanionTask(config: any, windowId?: string) {
      const state = getState();
      const sourceSessionId = String(config.sourceSessionId || "");
      const parts = sourceSessionId.split(":");
      if (parts.length < 2) {
        throw new Error('createCompanionTask: sourceSessionId must be "<workspaceId>:<panelId>"');
      }
      const sourceWorkspaceId = parts.slice(0, -1).join(":");
      const sourcePanelId = parts[parts.length - 1];

      // Cross-profile refusal before anything else touches disk/state.
      assertWorkspaceInViewerProfile(sourceWorkspaceId, windowId);

      const sourceWorkspace = findWorkspace(state, sourceWorkspaceId);
      if (!sourceWorkspace) {
        throw new Error("The source conversation's workspace no longer exists.");
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const sourcePanel = (sourceWorkspace.panels || []).find((p: any) => p.id === sourcePanelId);
      if (!sourcePanel) {
        throw new Error("The source conversation's panel no longer exists.");
      }
      // Prefer a genuinely live session over a merely persistent panel — an
      // "existing conversation" that isn't currently running can't receive
      // the capture prompt at all.
      if (!sessions.hasSession(sourceSessionId)) {
        throw new Error("The Primary conversation isn't currently running. Open it and try again.");
      }

      const effectiveCwd = sourcePanel.cwd || sourceWorkspace.cwd;
      const callerProfileId = resolveCallerProfileId(state, windowId, sourceWorkspaceId);
      // Same profile-aware same-cwd guard the standard create path uses.
      assertNoConflictingActiveTask(state, effectiveCwd, callerProfileId);

      // Refuse a second active companion loop over the same source session.
      const duplicate = state.workspaces.find(
        (w) =>
          w.kind === "task" &&
          w.task?.mode === "attached" &&
          w.task.workerWorkspaceId === sourceWorkspaceId &&
          w.task.workerPanelId === sourcePanelId &&
          w.task.state !== "completed" &&
          w.task.state !== "failed",
      );
      if (duplicate) {
        throw new Error(`A companion loop ("${duplicate.name}") is already attached to this conversation.`);
      }

      const workspace = taskRunner.createCompanionTaskWorkspace({
        state,
        workerWorkspaceId: sourceWorkspaceId,
        workerPanelId: sourcePanelId,
        primaryProvider: config.primaryProvider || null,
        companionRole: config.companionRole,
        companionProvider: config.companionProvider,
        companionCommand: config.companionCommand,
        focus: config.focus,
        maxRounds: config.maxRounds,
        autoStartAfterCapture: config.autoStartAfterCapture,
        callerProfileId,
      });

      try {
        await taskRunner.writeCompanionFiles(workspace.cwd, workspace.task);
      } catch (err) {
        log.error("createCompanionTask: failed to write initial companion files", {
          workspaceId: workspace.id,
          cwd: workspace.cwd,
          err: (err as Error).message,
        });
        throw new Error(`Failed to create companion task files: ${(err as Error).message}`, { cause: err });
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (this as any).saveWorkspace(workspace);

      if (config.activate !== false) {
        if (windowId) {
          try {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            await (this as any).activateWorkspaceInWindow(workspace.id, windowId);
          } catch (err) {
            log.info("createCompanionTask: skipping slot activation (cross-profile)", {
              workspaceId: workspace.id,
              windowId,
              err: (err as Error).message,
            });
            broadcastState();
          }
        } else {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          await (this as any).activateWorkspace(workspace.id);
        }
      } else {
        broadcastState();
      }

      return { workspaceId: workspace.id, payload: getPayload() };
    },

    /**
     * Explicit answer action for a `needs-input` companion verdict — the
     * only legitimate way out of `awaiting-user` besides Pause/Reset (plan
     * §8.5). Never a plain Continue, which would bypass the question.
     */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async answerCompanionTask(workspaceId: any, questionIds: any, answer: any, windowId?: string) {
      assertWorkspaceInViewerProfile(String(workspaceId), windowId);
      const ids = Array.isArray(questionIds) ? questionIds.map(String) : [];
      const result = await taskRunner.answerCompanionTask(String(workspaceId), ids, String(answer || ""));
      // Answering a question the task asked for IS work (V2 plan allowlist).
      if (result) await recordWorkspaceWork(String(workspaceId), windowId);
      return { ok: result, payload: getPayload() };
    },

    /**
     * Apply the user's per-task recovery decisions, collected by the dialog
     * (or auto-generated when the dialog is suppressed; see setImmediate at
     * the end of createRuntime).
     *
     * For each candidate:
     *   - "skip"     → leave paused. The task stays in AppState and the user
     *                  can resume it later from the dashboard the normal way.
     *   - "fresh"    → reset rounds and start over (clears history, recreates
     *                  WORK_LOCK). Use when the previous attempt was so broken
     *                  that re-orienting from disk would mislead the agent.
     *   - "continue" → re-spawn worker AND judge PTY sessions, and stash a
     *                  recovery prompt on the task (`showerResumePrompt`).
     *                  When the freshly-spawned agent emits its first idle
     *                  signal, the task runner injects this prompt instead of
     *                  the standard initial prompt — the agent re-orients
     *                  from disk and continues. This is the pure-prompt path:
     *                  no `--continue` flag, no transcript replay.
     *
     * Every processed candidate reports its OWN outcome and `ok` is derived
     * from them, so a refused resume, a dangling attached Primary or a session
     * that never came up can no longer present the batch as a clean success
     * (V4 review, P1 "task recovery hlasi uspech"). A candidate that did not
     * fail leaves the list so a redrive can't double-spawn; a FAILED one
     * deliberately stays, because a half-recovered task that silently vanishes
     * from the dialog is exactly the state the user cannot diagnose.
     *
     * `origin` separates WHO asked from WHAT was done (V5 review, §"P1 —
     * recovery dialog obchází work stamp"). Recovery is only ever entered by a
     * person clicking Resume / Start fresh / Resume all, and that click is
     * work in exactly the same sense the Dashboard's Continue is — but the
     * stamp used to live in the `resumeTask` wrapper, so the dialog's own
     * buttons, which call this method directly, stamped nothing. Now
     * `origin: "interactive"` stamps each `continued` and each `fresh` exactly
     * once; `origin: "internal"` (the `resumeTask` delegation, and any future
     * automatic recovery) stamps nothing and leaves the stamp to its caller,
     * so neither path can double-count.
     *
     * Every REQUESTED id gets an outcome, including one that is no longer a
     * candidate: two windows can hold the same dialog, and the loser used to
     * get a response with its key silently missing, which the renderer read as
     * success. That case is now `stale` — settled, not failed, no stamp.
     */
    async applyTaskRecovery(
      decisions: Record<string, string>,
      options?: { origin?: RecoveryOrigin; viewerId?: string },
    ): Promise<RecoveryResult<Payload>> {
      const outcomes: Record<string, RecoveryOutcome> = {};
      // The candidate list is the AUTHORITY on what each decision targets and
      // who owns it — never the caller's active workspace, a cwd or a name.
      const profileByWorkspace = new Map<string, string>();
      // EVERY requested workspace enters its OWN queue immediately.
      //
      // The batch used to be a sequential `for ... await` over the decisions,
      // which quietly re-serialized what the per-key queue exists to keep
      // apart: `Resume all` waited for the first workspace to finish before
      // the second was even enqueued, so one hanging PTY start stalled every
      // other task in the dialog (V7 review, §"P2 performance/UX — jeden
      // recovery batch blokuje nezávislá workspace"). The queue's scope is the
      // KEY, not the user's click: same id serialized, different ids
      // independent.
      //
      // Each entry still goes through `recoveryQueue.run`, so a second batch
      // naming the same workspace queues behind this one and re-reads the
      // candidate inside the lock — the loser sees the world the winner left
      // and reports `stale`. `Promise.all` preserves request order, so the
      // response and the stamping below stay deterministic, and a candidate
      // that fails is just its own `failed` outcome: it neither delays nor
      // cancels the start or the settlement of any other id.
      const settled = await Promise.all(
        Object.entries(decisions).map(([workspaceId, decision]) =>
          recoveryQueue.run(workspaceId, async () => {
            // The candidate is read INSIDE the lock — a snapshot taken before
            // the first `await` is exactly what made two concurrent decisions
            // possible.
            const candidate = getRecoveryCandidates().find((c) => c.workspaceId === workspaceId);
            const profileId = candidate ? candidate.profileId || "default" : undefined;
            const outcome = await settleRecoveryDecision(workspaceId, decision, candidate);
            return { workspaceId, outcome, profileId };
          }),
        ),
      );
      // Collected only once everything has settled, so nothing is stamped or
      // reported on behalf of a decision still in flight.
      for (const entry of settled) {
        outcomes[entry.workspaceId] = entry.outcome;
        if (entry.profileId !== undefined) profileByWorkspace.set(entry.workspaceId, entry.profileId);
      }
      return finalizeRecovery(outcomes, profileByWorkspace, options);
    },
    /**
     * The INTERACTIVE recovery endpoint — the one the IPC handler and the
     * remote route are wired to, and the only path a human decision travels.
     * `viewerId` is the desktop window id or the remote viewer id, so the
     * stamp is credited in the caller's own context.
     */
    async resolveTaskRecovery(decisions: Record<string, string>, viewerId?: string): Promise<RecoveryResult<Payload>> {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (this as any).applyTaskRecovery(decisions, { origin: "interactive", viewerId });
    },
  };
}
