import { getAllProviders } from "./providers/provider-registry.js";
import { findWorkspace } from "./runtime-utils.js";
import {
  buildRecoveryPrompt,
  buildAttachedPrimaryRecoveryPrompt,
  buildAttachedCompanionRecoveryPrompt,
} from "./agent-task-prompts.js";
import { updateTaskDescriptionFile } from "./agent-task-files.js";
import { sessionIdFor } from "./agent-task-runner.js";
import type { Logger } from "./logger.js";
import type { AppState, RecoveryCandidate } from "../shared/types/state.js";

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
    resolveCallerProfileId,
    assertNoConflictingActiveTask,
    worktreeTreePath,
    ensureWorktree,
    getRecoveryCandidates,
    setRecoveryCandidates,
  } = ctx;

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
      // saveWorkspace normalizes and persists
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (this as any).saveWorkspace(workspace);
      // If running in a git worktree, remove any "Worktree of" entry that
      // syncWorktrees may have created for the same directory before the task
      // workspace was registered (race-condition cleanup).
      if (worktreeBase) {
        const taskCwd = workspace.cwd || "";
        await store.mutate((draft: AppState) => {
          draft.workspaces = draft.workspaces.filter(
            (w) => w.id === workspace.id || !(w.cwd === taskCwd && (w.notes || "").startsWith("Worktree of ")),
          );
        });
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
    async resumeTask(workspaceId: any, windowId?: string) {
      assertWorkspaceInViewerProfile(String(workspaceId), windowId);
      const id = String(workspaceId);
      // Krok 6 — a startup recovery candidate needs the FULL recovery path
      // (re-spawn the dead PTYs, stash the recovery prompt, fire the deferred
      // idle). Plain resumeTask only flips state and can't respawn PTYs, so a
      // Dashboard/Sidebar "Continue" on such a task did nothing (incident B).
      // Delegate to resolveTaskRecovery, which owns that path.
      if (getRecoveryCandidates().some((c) => c.workspaceId === id)) {
        log.info("resumeTask: delegating recovery candidate to resolveTaskRecovery", { workspaceId: id });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return (this as any).resolveTaskRecovery({ [id]: "continue" });
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
      return { ok: result, payload: getPayload() };
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async resetTask(workspaceId: any, windowId?: string) {
      assertWorkspaceInViewerProfile(String(workspaceId), windowId);
      const result = await taskRunner.resetTask(workspaceId);
      return { ok: result, payload: getPayload() };
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
      broadcastState();
      return { ok: true, payload: getPayload() };
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async rejectTaskVerdict(workspaceId: any, feedback: any) {
      const result = await taskRunner.rejectTaskVerdict(workspaceId, feedback);
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
     * The candidate list is cleared after we process the batch so a redrive
     * can't double-spawn.
     */
    async resolveTaskRecovery(decisions: Record<string, string>) {
      const processedIds = new Set<string>();
      const recoveryCandidates = getRecoveryCandidates();
      for (const [workspaceId, decision] of Object.entries(decisions)) {
        const candidate = recoveryCandidates.find((c) => c.workspaceId === workspaceId);
        if (!candidate) continue;
        processedIds.add(workspaceId);

        if (decision === "skip") continue;

        try {
          if (decision === "fresh") {
            await taskRunner.resetTask(workspaceId);
            continue;
          }

          // "continue" — build an orientation prompt and resume the agent.
          // pausedFromState was set by #reconcileOnStartup, so resumeTask
          // resumes to the correct role (worker or judge-evaluating).
          const role = candidate.previousState === "judge-evaluating" ? "judge" : "worker";

          const state = getState();
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const ws = state.workspaces.find((w: any) => w.id === workspaceId) as any;

          if (ws?.task?.mode === "attached") {
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
              continue;
            }

            const attachedPrompt =
              role === "worker"
                ? buildAttachedPrimaryRecoveryPrompt(attachedTask, candidate.currentRound)
                : buildAttachedCompanionRecoveryPrompt(attachedTask, candidate.currentRound);

            await store.mutate((draft: AppState) => {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              const dws = draft.workspaces.find((w: any) => w.id === workspaceId);
              if (dws?.task) dws.task.showerResumePrompt = attachedPrompt;
            });

            const ok = taskRunner.resumeTask(workspaceId);
            if (!ok) log.warn("resolveTaskRecovery: resumeTask returned false (attached)", { workspaceId });

            // Only the role that was actually mid-flight needs a fresh PTY:
            // the Companion panel belongs to this task workspace and is
            // always safe to re-spawn; the Primary panel is re-spawned only
            // because it's the SAME pre-existing source panel, not a new one.
            const idleSessionId = sessionIdFor(ws, role);
            await sessions.ensureSession(state, idleSessionId).catch((err: unknown) => {
              log.warn("resolveTaskRecovery: ensureSession (attached) failed", {
                workspaceId,
                role,
                err: (err as Error).message,
              });
            });
            setTimeout(() => {
              try {
                taskRunner.onAgentIdle(idleSessionId, "recovery-deferred");
              } catch (err) {
                log.warn("resolveTaskRecovery: deferred onAgentIdle (attached) threw", {
                  workspaceId,
                  err: (err as Error).message,
                });
              }
            }, 5000);
            continue;
          }

          const recoveryPrompt = buildRecoveryPrompt({
            role,
            round: candidate.currentRound,
            taskId: candidate.taskId,
          });

          // Stash the recovery prompt on the task. We reuse `showerResumePrompt`
          // (originally added for the periodic "fresh-context shower" feature)
          // because both flows want the same thing: replace the next idle's
          // prompt with our text. Setting `promptSent = false` triggers the
          // injection path in onAgentIdle.
          await store.mutate((draft: AppState) => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const dws = draft.workspaces.find((w: any) => w.id === workspaceId);
            if (dws?.task) {
              dws.task.promptSent = false;
              dws.task.showerResumePrompt = recoveryPrompt;
            }
          });

          // Flip the task state from "paused" → "running" / "judge-evaluating"
          // BEFORE spawning the PTYs. If we spawned first, the freshly-started
          // agent's banner-then-idle sequence would fire onAgentIdle while the
          // task was still paused, the handler would bail at its `state ===
          // "paused"` early return, and the recovery prompt would never get
          // injected — the worker would just sit at an empty prompt forever.
          const ok = taskRunner.resumeTask(workspaceId);
          if (!ok) log.warn("resolveTaskRecovery: resumeTask returned false", { workspaceId });

          // Re-spawn PTY sessions for both worker and judge panels. After an
          // app restart the prior PTYs are gone with the parent process. The
          // first idle these new agents emit will hit onAgentIdle with the
          // task already in "running"/"judge-evaluating" state, so the
          // recovery prompt set above gets injected.
          if (ws?.task?.workerPanelId) {
            const workerSessionId = `${workspaceId}:${ws.task.workerPanelId}`;
            await sessions.ensureSession(state, workerSessionId).catch((err: unknown) => {
              log.warn("resolveTaskRecovery: ensureSession (worker) failed", {
                workspaceId,
                err: (err as Error).message,
              });
            });
          }
          if (ws?.task?.judgePanelId) {
            const judgeSessionId = `${workspaceId}:${ws.task.judgePanelId}`;
            await sessions.ensureSession(state, judgeSessionId).catch((err: unknown) => {
              log.warn("resolveTaskRecovery: ensureSession (judge) failed", {
                workspaceId,
                err: (err as Error).message,
              });
            });
          }

          // Force-trigger onAgentIdle a few seconds after spawn instead of
          // waiting for hook-fallback silence (HOOK_FALLBACK_SILENCE_MS = 2 min).
          //
          // Why this is necessary: a freshly-spawned Claude Code session
          // doesn't fire its Stop hook until *after* it processes a turn —
          // there's nothing to stop yet. The runtime treats hook-capable
          // sessions as hook-primary and gates silence detection behind a
          // 2-minute fallback. Without this nudge, the user clicks Resume
          // and sees the agent sit at an empty prompt for two full minutes
          // before the recovery prompt finally gets pasted in. 5 s is enough
          // for Claude Code to render its banner and be ready to accept a
          // paste; onAgentIdle's existing logic does the actual injection.
          if (!ws?.task?.workerPanelId) {
            log.warn("resolveTaskRecovery: ws lookup failed — cannot schedule deferred idle", {
              workspaceId,
              hasWs: !!ws,
              hasTask: !!ws?.task,
              workerPanelId: ws?.task?.workerPanelId,
            });
          }
          if (ws?.task?.workerPanelId) {
            const workerSessionId = `${workspaceId}:${ws.task.workerPanelId}`;
            const role = candidate.previousState === "judge-evaluating" ? "judge" : "worker";
            const idleSessionId =
              role === "judge" && ws.task.judgePanelId ? `${workspaceId}:${ws.task.judgePanelId}` : workerSessionId;
            log.info("resolveTaskRecovery: scheduling deferred idle nudge", {
              workspaceId,
              role,
              idleSessionId,
              delayMs: 5000,
            });
            setTimeout(() => {
              log.info("resolveTaskRecovery: firing deferred onAgentIdle", {
                workspaceId,
                idleSessionId,
              });
              try {
                const handled = taskRunner.onAgentIdle(idleSessionId, "recovery-deferred");
                log.info("resolveTaskRecovery: deferred onAgentIdle returned", {
                  workspaceId,
                  idleSessionId,
                  handled,
                });
              } catch (err) {
                log.warn("resolveTaskRecovery: deferred onAgentIdle threw", {
                  workspaceId,
                  err: (err as Error).message,
                });
              }
            }, 5000);
          }
        } catch (err) {
          log.warn("resolveTaskRecovery: failed for workspace", { workspaceId, err: (err as Error).message });
        }
      }

      // Remove only the candidates we just processed — the dialog calls this
      // method per-decision in sequential mode, so wiping the whole list would
      // make the next call a no-op.
      setRecoveryCandidates(recoveryCandidates.filter((c) => !processedIds.has(c.workspaceId)));
      broadcastState();
      return { ok: true, payload: getPayload() };
    },
  };
}
