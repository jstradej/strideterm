import { createSessionId } from "./default-state.js";
import { findWorkspace } from "./runtime-utils.js";
import { resolveTelegramTaskTarget } from "./telegram-task-resolution.js";
import { resolveTelegramWindow, type TelegramWindowResolution } from "./telegram-window-resolver.js";
import { escapeMarkdown } from "./telegram-manager.js";
import type { Logger } from "./logger.js";
import type { AppState } from "../shared/types/state.js";

/**
 * Runtime context subset consumed by the Telegram command dispatcher.
 * The full runtime ctx is typed as a structural interface so new fields
 * can be added without breaking this module.
 */
interface TelegramDispatchCtx {
  log: Logger;
  getState: () => AppState;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  telegramManager: any;
  /** Live accessor — the runtime object (`_rt`) isn't fully built until createRuntime finishes. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getRt: () => any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sessions: any;
  clearAlertSession: (sessionId: string) => boolean;
  broadcastState: () => void;
  worktreeTreePath: (repoPath: string, branchOrName: string) => string;
  captureMainWindowPng?: (windowId?: string) => Promise<Buffer>;
  ensureWindowForProfile?: (profileId: string) => Promise<string | null>;
}

/**
 * Factory for the Telegram command dispatcher. Extracted from runtime.ts to
 * reduce file size, following the same ctx-factory pattern as
 * runtime-git-handlers.ts / runtime-attention.ts.
 */
export function createTelegramDispatch(ctx: TelegramDispatchCtx) {
  const {
    log,
    getState,
    telegramManager,
    getRt,
    sessions,
    clearAlertSession,
    broadcastState,
    worktreeTreePath,
    captureMainWindowPng,
    ensureWindowForProfile,
  } = ctx;

  // --- Telegram command dispatch ---
  // _rt (via getRt()) is populated at the end of createRuntime(); commands
  // always fire asynchronously (after first Telegram poll), so it's
  // guaranteed set by the time any handler below runs.
  //
  // Telegram passes `profileId` (the user-facing scope) on window-affecting
  // commands; runtime resolves it to a target-window DECISION here so the
  // rest of the dispatch joins the same windowId-based plumbing IPC and
  // remote-server use. Resolution rules live in telegram-window-resolver
  // (pure, unit-tested) — this wrapper handles the side-effectful outcomes:
  // window creation, user-choice prompts, and the audit trail.

  /**
   * Resolve a Telegram command's target window.
   *
   * Outcomes:
   *  - `{ windowId }` — use this window (may be freshly spawned for
   *    "needs-new-window" when the command's policy allows it; `created`
   *    is true in that case so screenshot flows can keep the window as-is).
   *  - `{ windowId: undefined, aborted: false }` — no window required;
   *    legacy primary-window fallback for commands without profile binding.
   *  - `{ aborted: true }` — the caller MUST return; the user has already
   *    been messaged (window picker, workspace picker, or an error).
   */
  async function resolveTelegramWindowTarget(
    cmd: {
      windowId?: string;
      profileId?: string;
      workspaceId?: string;
      sessionId?: string;
      chatId?: string;
    },
    policy: {
      operation: string;
      requiresDesktopWindow?: boolean;
      allowCreateWindow?: boolean;
      requireExplicitWindowWhenAmbiguous?: boolean;
    },
  ): Promise<{ windowId?: string; aborted: boolean; created?: boolean; resolution: TelegramWindowResolution }> {
    const resolution = resolveTelegramWindow(
      {
        windowId: cmd.windowId,
        profileId: cmd.profileId,
        workspaceId: cmd.workspaceId,
        sessionId: cmd.sessionId,
        requiresDesktopWindow: policy.requiresDesktopWindow,
        allowCreateWindow: policy.allowCreateWindow,
        requireExplicitWindowWhenAmbiguous: policy.requireExplicitWindowWhenAmbiguous,
      },
      getState().windowSlots || [],
    );
    // Audit every window decision so "why did the screenshot land in window
    // 2?" is answerable later.
    telegramManager.recordWindowResolution({
      chatId: cmd.chatId,
      operation: policy.operation,
      profileId: cmd.profileId,
      selectedWindowId: resolution.windowId,
      reason: resolution.reason,
      candidateWindowCount: resolution.candidates?.length ?? 0,
    });

    if (resolution.windowId) return { windowId: resolution.windowId, aborted: false, resolution };
    if (resolution.reason === "no-window-required") return { windowId: undefined, aborted: false, resolution };

    if (resolution.reason === "needs-new-window" && cmd.profileId) {
      // The user clicked a Telegram button which is an unambiguous "go
      // here" intent — spawn a normal desktop window for the profile and
      // leave it open (via ensureWindowForProfile).
      if (ensureWindowForProfile) {
        log.info("telegram: profile not open — auto-spawning window", {
          profileId: cmd.profileId,
          chatId: cmd.chatId,
          operation: policy.operation,
        });
        try {
          const newWindowId = await ensureWindowForProfile(String(cmd.profileId));
          if (newWindowId) return { windowId: newWindowId, aborted: false, created: true, resolution };
        } catch (err) {
          log.warn("telegram: ensureWindowForProfile threw", {
            profileId: cmd.profileId,
            err: (err as Error)?.message,
          });
        }
      }
      log.warn("telegram: profile not open and auto-spawn unavailable", {
        profileId: cmd.profileId,
        chatId: cmd.chatId,
      });
      if (cmd.chatId) {
        await telegramManager
          .notifyChat(
            cmd.chatId,
            `⚠️ Could not open a window for profile *${escapeMarkdown(String(cmd.profileId))}*\\.`,
          )
          .catch((err: unknown) => {
            log.warn("telegram: notifyChat (window unavailable) failed", {
              chatId: cmd.chatId,
              profileId: cmd.profileId,
              err: (err as Error)?.message,
            });
          });
      }
      return { aborted: true, resolution };
    }

    // needs-user-choice: never pick a window silently. With candidates,
    // offer the window menu; with none (profile closed and creation not
    // allowed — i.e. screenshot-current), tell the user and offer the
    // workspace picker instead.
    if (cmd.chatId && cmd.profileId) {
      if ((resolution.candidates?.length ?? 0) > 0) {
        await telegramManager
          .promptScreenshotWindowPick(cmd.chatId, String(cmd.profileId), resolution.candidates || [])
          .catch((err: unknown) => {
            log.warn("telegram: promptScreenshotWindowPick failed", {
              chatId: cmd.chatId,
              profileId: cmd.profileId,
              err: (err as Error)?.message,
            });
          });
      } else {
        await telegramManager.promptNoWindowForScreenshot(cmd.chatId, String(cmd.profileId)).catch((err: unknown) => {
          log.warn("telegram: promptNoWindowForScreenshot failed", {
            chatId: cmd.chatId,
            profileId: cmd.profileId,
            err: (err as Error)?.message,
          });
        });
      }
    } else if (cmd.chatId) {
      await telegramManager
        .notifyChat(cmd.chatId, "⚠️ No desktop window available for this action\\.")
        .catch((err: unknown) => {
          log.warn("telegram: notifyChat (no window for action) failed", {
            chatId: cmd.chatId,
            err: (err as Error)?.message,
          });
        });
    }
    return { aborted: true, resolution };
  }

  /**
   * "start-task": create a new task workspace from a Telegram-originated
   * description. Its own named function per the size of this branch —
   * resolves the parent workspace (walking up past PR-review/quickfix/task
   * children), optionally creates a new git worktree, then asks the user
   * via Telegram whether to start the task now or leave it idle.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async function handleStartTask(cmd: any): Promise<void> {
    if (!(cmd.taskDescription && cmd.workspaceId)) return;
    const state = getState();
    // Walk up the parent chain so a Telegram reply originating in a
    // child workspace (PR review, quickfix, or another task) doesn't
    // create a misnested "task of task" or "task of PR review" tree.
    // Pure helper at telegram-task-resolution.ts owns the logic — it
    // also handles the trickier "task ran in a worktree, completed,
    // user replied to the completion notification" case so the new
    // task continues in the same worktree instead of jumping back to
    // the main project root.
    const targetCwdHint = String(cmd.targetCwd || "").trim();
    const resolution = resolveTelegramTaskTarget({
      workspaces: state.workspaces,
      sourceWorkspaceId: cmd.workspaceId,
      targetCwd: targetCwdHint,
    });
    const parentWorkspace = resolution.parentWorkspace;
    if (!parentWorkspace?.cwd) {
      log.warn("telegram: start-task aborted — no valid parent workspace with cwd", {
        originalWorkspaceId: cmd.workspaceId,
      });
      if (cmd.chatId) {
        await telegramManager.notifyChat(
          cmd.chatId,
          "⚠️ Cannot find a suitable parent workspace with `cwd` for the source notification\\. Use `/task` and pick a workspace manually\\.",
        );
      }
      return;
    }
    if (parentWorkspace.id !== cmd.workspaceId) {
      log.warn("telegram: start-task — resolved alert workspace to a higher-up parent", {
        from: cmd.workspaceId,
        to: parentWorkspace.id,
        toName: parentWorkspace.name,
        cwdReason: resolution.cwdReason,
      });
    }
    const resolvedParentId = parentWorkspace.id;
    // Worktree mode: caller can either create a NEW git worktree
    // (useWorktree=true + worktreeBranch), pick an EXISTING worktree
    // (targetCwd overrides parent.cwd), or run the task DIRECTLY in
    // the parent's cwd (default — no worktree). The validation of the
    // branch name happens client-side in telegram-manager; the
    // useWorktree path here just plumbs through.
    const useWorktree = !!cmd.useWorktree;
    const worktreeBranch = cmd.worktreeBranch?.trim() || "";
    if (useWorktree && !worktreeBranch) {
      log.warn("telegram: start-task with useWorktree but no branch", { workspaceId: cmd.workspaceId });
      if (cmd.chatId) {
        await telegramManager.notifyChat(cmd.chatId, "⚠️ Missing branch name for the new worktree\\.");
      }
      return;
    }
    // The task cwd is decided by `resolveTelegramTaskTarget` above:
    //  - explicit `cmd.targetCwd` → used as-is (pick-existing-worktree),
    //  - source workspace's cwd if it differs from the resolved root
    //    (the "completion notification from a worktree task" case the
    //    user reported as buggy),
    //  - resolved root cwd otherwise.
    // For "new worktree" mode we ignore the resolution result and keep
    // the resolved root's cwd as the BASE for the new worktree — the
    // git worktree is always cut off the project root, never off
    // another worktree.
    const taskCwd = useWorktree ? parentWorkspace.cwd : resolution.taskCwd;
    log.warn("telegram: creating task workspace", {
      parentWorkspaceId: resolvedParentId,
      parentName: parentWorkspace.name,
      taskCwd,
      useWorktree,
      worktreeBranch: worktreeBranch || undefined,
      cwdReason: resolution.cwdReason,
      description: cmd.taskDescription?.slice(0, 80),
    });
    // activate:false — Telegram-driven creation must not yank the user
    // out of the workspace they're currently in.
    let result: { workspaceId: string; cwdWarning: string; payload: unknown } | undefined;
    try {
      result = await getRt()?.createTaskWorkspace({
        cwd: taskCwd,
        description: cmd.taskDescription,
        parentWorkspaceId: resolvedParentId,
        activate: false,
        useWorktree,
        worktreeBranch: useWorktree ? worktreeBranch : undefined,
      });
    } catch (err) {
      log.warn("telegram: createTaskWorkspace threw", {
        workspaceId: cmd.workspaceId,
        err: (err as Error).message,
      });
      if (cmd.chatId) {
        await telegramManager.notifyChat(
          cmd.chatId,
          "⚠️ Task creation failed: ` " + (err as Error).message.replace(/`/g, "'") + " `",
        );
      }
      return;
    }
    if (result?.workspaceId) {
      // Don't auto-start. Ask the user via Telegram whether to start
      // the task now or leave it idle so they can edit TASK.md first.
      if (cmd.chatId) {
        const promptCwd = useWorktree ? worktreeTreePath(parentWorkspace.cwd, worktreeBranch) : taskCwd;
        await telegramManager.promptStartAfterCreate({
          chatId: cmd.chatId,
          workspaceId: result.workspaceId,
          description: cmd.taskDescription,
          parentName: parentWorkspace.name,
          cwd: promptCwd,
        });
      } else {
        log.warn("telegram: start-task created workspace but no chatId for follow-up", {
          workspaceId: result.workspaceId,
        });
      }
    } else {
      log.warn("telegram: createTaskWorkspace returned no result", { workspaceId: cmd.workspaceId });
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async function handleStartExistingTask(cmd: any): Promise<void> {
    if (!cmd.workspaceId) return;
    // Defensive guard against accidental object-shaped IDs (older Telegram
    // buffered updates / external callers) — taskRunner.startTask logs the
    // shape it receives, which is how we caught the historical regression.
    const wsId = typeof cmd.workspaceId === "string" ? cmd.workspaceId : "";
    if (!wsId) {
      log.warn("telegram: start-existing-task aborted — workspaceId not a string", {
        workspaceIdType: typeof cmd.workspaceId,
      });
      if (cmd.chatId) {
        await telegramManager.notifyChat(cmd.chatId, "⚠️ Internal error: missing workspaceId\\.");
      }
      return;
    }
    const targetWs = findWorkspace(getState(), wsId);
    if (!targetWs || targetWs.kind !== "task" || !targetWs.task) {
      log.warn("telegram: start-existing-task aborted — workspace not found or not a task", {
        workspaceId: wsId,
        kind: targetWs?.kind,
      });
      if (cmd.chatId) {
        await telegramManager.notifyChat(cmd.chatId, "⚠️ Task workspace not found \\(possibly deleted\\)\\.");
      }
      return;
    }
    log.warn("telegram: starting existing task", { workspaceId: wsId, state: targetWs.task.state });
    // CRITICAL: when the task workspace was created with `activate:false`,
    // its worker/judge PTYs were never spawned. taskRunner.startTask
    // would then write the initial prompt into a non-existent session
    // (silent drop in session-manager.writeToSession), and the user sees
    // a Claude welcome screen with no command — exactly the bug the
    // user reported. Start the PTYs explicitly here, await readiness,
    // and give Claude's TUI a moment to finish rendering its welcome
    // before we inject the prompt.
    const workerPanelId = targetWs.task.workerPanelId;
    const judgePanelId = targetWs.task.judgePanelId;
    const workerSessionId = createSessionId(wsId, workerPanelId);
    const judgeSessionId = createSessionId(wsId, judgePanelId);
    try {
      await sessions.ensureSession(getState(), workerSessionId);
      await sessions.ensureSession(getState(), judgeSessionId);
    } catch (err) {
      log.warn("telegram: failed to ensure task PTY sessions", {
        workspaceId: wsId,
        err: (err as Error).message,
      });
    }
    // Wait for Claude's Ink TUI to finish its initial render. Without
    // this delay the keystrokes get lost in the welcome banner. 2.5s is
    // empirically enough on a fast machine; longer than that just makes
    // the user wait without benefit. Tune via env if it turns out flaky.
    const promptDelayMs = Number(process.env.STRIDETERM_TG_PROMPT_DELAY_MS) || 2500;
    await new Promise((resolve) => setTimeout(resolve, promptDelayMs));
    const ok = await getRt()?.startTask(wsId);
    if (cmd.chatId) {
      await telegramManager.notifyChat(
        cmd.chatId,
        ok?.ok ? "▶️ Task started\\." : "⚠️ Task failed to start \\(check the log\\)\\.",
      );
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async function handlePauseTask(cmd: any): Promise<void> {
    if (!cmd.workspaceId) return;
    log.info("telegram: pause task", { workspaceId: cmd.workspaceId });
    const ok = getRt()?.pauseTask(cmd.workspaceId);
    if (cmd.chatId) {
      await telegramManager.notifyChat(
        cmd.chatId,
        ok?.ok ? "⏸ Task paused\\." : "⚠️ Task is not in a state that can be paused\\.",
      );
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async function handleResumeTask(cmd: any): Promise<void> {
    if (!cmd.workspaceId) return;
    log.info("telegram: resume task", { workspaceId: cmd.workspaceId });
    const ok = await getRt()?.resumeTask(cmd.workspaceId);
    if (cmd.chatId) {
      await telegramManager.notifyChat(
        cmd.chatId,
        ok?.ok ? "▶️ Task resumed\\." : "⚠️ Task cannot be resumed from the current state\\.",
      );
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async function handleStopTask(cmd: any): Promise<void> {
    if (!cmd.workspaceId) return;
    log.info("telegram: stop task", { workspaceId: cmd.workspaceId });
    const ok = getRt()?.stopTask(cmd.workspaceId);
    if (cmd.chatId) {
      await telegramManager.notifyChat(
        cmd.chatId,
        ok?.ok ? "⏹ Task stopped\\." : "⚠️ Task cannot be stopped from the current state\\.",
      );
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async function handleResetTask(cmd: any): Promise<void> {
    if (!cmd.workspaceId) return;
    log.info("telegram: reset task", { workspaceId: cmd.workspaceId });
    const ok = await getRt()?.resetTask(cmd.workspaceId);
    if (cmd.chatId) {
      await telegramManager.notifyChat(
        cmd.chatId,
        ok?.ok ? "🔄 Task reset to IDLE\\." : "⚠️ Task cannot be reset from the current state\\.",
      );
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async function handleUpdateTaskDescription(cmd: any): Promise<void> {
    if (!(cmd.workspaceId && cmd.taskDescription !== undefined)) return;
    log.info("telegram: update task description", {
      workspaceId: cmd.workspaceId,
      followUp: cmd.followUp,
      length: String(cmd.taskDescription).length,
    });
    const updated = await getRt()?.updateTaskDescription(cmd.workspaceId, cmd.taskDescription);
    if (!updated?.ok) {
      if (cmd.chatId) {
        await telegramManager.notifyChat(cmd.chatId, "⚠️ Could not save the task description\\.");
      }
      return;
    }
    // Chained follow-up actions (Edit+Continue / Edit+Start)
    if (cmd.followUp === "resume") {
      const ok = await getRt()?.resumeTask(cmd.workspaceId);
      if (cmd.chatId) {
        await telegramManager.notifyChat(
          cmd.chatId,
          ok?.ok
            ? "📝 Description updated, task resumed\\."
            : "📝 Description updated, but task could not be resumed from the current state\\.",
        );
      }
    } else if (cmd.followUp === "start") {
      // Reset → start sequence so the new description takes effect from
      // round 1 (startTask refreshes description from TASK.md).
      await getRt()?.resetTask(cmd.workspaceId);
      const ok = await getRt()?.startTask(cmd.workspaceId);
      if (cmd.chatId) {
        await telegramManager.notifyChat(
          cmd.chatId,
          ok?.ok
            ? "📝 Description updated, task started\\."
            : "📝 Description updated, but the task could not be started\\.",
        );
      }
    } else {
      if (cmd.chatId) {
        await telegramManager.notifyChat(cmd.chatId, "📝 Task description updated\\.");
      }
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async function handleSendTaskFile(cmd: any): Promise<void> {
    if (!(cmd.workspaceId && cmd.filePath)) return;
    const wsId = String(cmd.workspaceId);
    const ws = findWorkspace(getState(), wsId);
    if (!ws || ws.kind !== "task" || !ws.task) {
      log.warn("telegram: send-task-file aborted — workspace not found or not a task", { workspaceId: wsId });
      if (cmd.chatId) {
        await telegramManager.notifyChat(cmd.chatId, "⚠️ Task workspace not found \\(possibly deleted\\)\\.");
      }
      return;
    }
    if (!ws.cwd) {
      log.warn("telegram: send-task-file aborted — workspace has no cwd", { workspaceId: wsId });
      if (cmd.chatId) {
        await telegramManager.notifyChat(cmd.chatId, "⚠️ Workspace has no cwd\\.");
      }
      return;
    }
    // Resolve the requested path relative to task.cwd, then guard against
    // path-traversal: the resolved absolute path must still live inside
    // the workspace directory. Otherwise a chat user could exfiltrate
    // arbitrary files via `..\..\..\Users\...`.
    const path = await import("node:path");
    const cleanRel = String(cmd.filePath)
      .replace(/^[/\\]+/, "")
      .trim();
    const wsRoot = path.resolve(ws.cwd);
    const requested = path.resolve(wsRoot, cleanRel);
    const wsRootSep = wsRoot.endsWith(path.sep) ? wsRoot : wsRoot + path.sep;
    if (requested !== wsRoot && !requested.startsWith(wsRootSep)) {
      log.warn("telegram: send-task-file rejected — path escapes workspace cwd", {
        workspaceId: wsId,
        requested,
        wsRoot,
      });
      if (cmd.chatId) {
        await telegramManager.notifyChat(
          cmd.chatId,
          "⚠️ Path points outside the task workspace\\. Use a relative path inside `cwd`\\.",
        );
      }
      return;
    }
    log.warn("telegram: sending task file", {
      workspaceId: wsId,
      relPath: cleanRel,
      absolutePath: requested,
    });
    if (cmd.chatId) {
      await telegramManager.sendFile({
        chatId: cmd.chatId,
        absolutePath: requested,
        relPath: cleanRel,
        workspaceName: ws.name,
        mode: cmd.fileMode === "document" ? "document" : "auto",
      });
    }
  }

  /** Shared by "screenshot-current" and "screenshot-workspace". */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async function handleScreenshot(cmd: any): Promise<void> {
    const captureFn = captureMainWindowPng;
    if (!captureFn) {
      log.warn("telegram: screenshot requested but captureMainWindowPng dependency missing");
      if (cmd.chatId) {
        await telegramManager.notifyChat(
          cmd.chatId,
          "⚠️ Screenshot is not available in this instance \\(probably a headless build\\)\\.",
        );
      }
      return;
    }
    // Scope to the user-selected profile's window. With multiple windows
    // per profile, the resolver decides deterministically:
    //  - workspace screenshots prefer the window already showing the
    //    workspace, then the last-focused profile window, and may create
    //    a new window for a closed profile (kept open after capture);
    //  - current-window screenshots never pick one of several windows
    //    silently — the user gets a window menu, and with no window at
    //    all a clear error plus a "Pick workspace" button.
    const target = await resolveTelegramWindowTarget(
      cmd,
      cmd.type === "screenshot-workspace"
        ? { operation: "screenshotWorkspace", requiresDesktopWindow: true, allowCreateWindow: true }
        : {
            operation: "screenshotCurrent",
            requiresDesktopWindow: true,
            requireExplicitWindowWhenAmbiguous: true,
          },
    );
    if (target.aborted) return; // user already messaged (picker or error)
    const targetWindowId = target.windowId;
    const windowWasCreated = target.created === true;
    const preState = getState();
    const slot = targetWindowId ? (preState.windowSlots || []).find((s) => s.id === targetWindowId) : undefined;
    // For per-window screenshots, originalActiveId is the workspace
    // currently shown in THAT window — not the global active. Falling
    // back to global keeps single-window setups working.
    const originalActiveId = slot?.activeWorkspaceId || preState.activeWorkspaceId;
    let targetWsId = "";
    let targetWsName = "current";
    if (cmd.type === "screenshot-workspace" && cmd.workspaceId) {
      targetWsId = String(cmd.workspaceId);
      const targetWs = findWorkspace(getState(), targetWsId);
      if (!targetWs) {
        log.warn("telegram: screenshot-workspace aborted — workspace not found", { workspaceId: targetWsId });
        if (cmd.chatId) {
          await telegramManager.notifyChat(cmd.chatId, "⚠️ Workspace not found\\.");
        }
        return;
      }
      targetWsName = targetWs.name;
      if (targetWsId !== originalActiveId) {
        log.warn("telegram: switching workspace for screenshot", {
          from: originalActiveId,
          to: targetWsId,
          windowId: targetWindowId,
        });
        if (targetWindowId) {
          await getRt()?.activateWorkspaceInWindow(targetWsId, targetWindowId);
        } else {
          await getRt()?.activateWorkspace(targetWsId);
        }
        // Renderer needs time to lay out the panels and finish at least
        // one paint frame before capturePage produces a representative
        // image. 600ms is empirically enough for a typical workspace;
        // configurable for slow machines via env.
        const renderDelayMs = Number(process.env.STRIDETERM_TG_SCREENSHOT_DELAY_MS) || 600;
        await new Promise((resolve) => setTimeout(resolve, renderDelayMs));
      }
    } else if (cmd.type === "screenshot-current" && originalActiveId) {
      const ws = findWorkspace(getState(), originalActiveId);
      targetWsName = ws?.name || "current";
    }

    let png: Buffer;
    try {
      png = await captureFn(targetWindowId);
    } catch (err) {
      log.warn("telegram: screenshot capture failed", { err: (err as Error).message });
      if (cmd.chatId) {
        await telegramManager.notifyChat(cmd.chatId, "⚠️ Could not capture screenshot \\(window unavailable\\)\\.");
      }
      // Still try to switch back so user's UI returns to where they left it.
      if (targetWsId && originalActiveId && targetWsId !== originalActiveId) {
        if (targetWindowId) {
          await getRt()?.activateWorkspaceInWindow(originalActiveId, targetWindowId).catch(() => {});
        } else {
          await getRt()?.activateWorkspace(originalActiveId).catch(() => {});
        }
      }
      return;
    }

    if (cmd.chatId) {
      await telegramManager.sendScreenshotPng(cmd.chatId, png, targetWsName);
    }

    // Switch back to where the user was before. Best-effort — failures
    // are logged but not surfaced to the user (their original workspace
    // is still selectable from the sidebar). A freshly created window
    // stays on the captured workspace ("leave the window open" UX) —
    // there is no previous view to restore in it.
    if (!windowWasCreated && targetWsId && originalActiveId && targetWsId !== originalActiveId) {
      const switchBack = targetWindowId
        ? getRt()?.activateWorkspaceInWindow(originalActiveId, targetWindowId)
        : getRt()?.activateWorkspace(originalActiveId);
      await switchBack?.catch((err: Error) => {
        log.warn("telegram: switch-back after screenshot failed", { err: err.message });
      });
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async function handleOpenPrReview(cmd: any): Promise<void> {
    if (!(cmd.prKey && cmd.provider)) return;
    // Prefer the window that already shows this PR's review workspace,
    // then the last-focused window of the profile; create a new window
    // for a closed profile.
    const reviewWs = getState().workspaces.find(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (w: any) => w.review?.prKey === cmd.prKey,
    );
    const target = await resolveTelegramWindowTarget(
      { ...cmd, workspaceId: reviewWs?.id || cmd.workspaceId },
      { operation: "openPrReview", requiresDesktopWindow: true, allowCreateWindow: true },
    );
    if (target.aborted) return; // user already messaged
    const targetWindowId = target.windowId;
    log.info("telegram: opening PR review from command", {
      prKey: cmd.prKey,
      provider: cmd.provider,
      windowId: targetWindowId,
      resolutionReason: target.resolution.reason,
    });
    if (cmd.provider === "github") {
      await getRt()?.openGitHubPullRequest({ prKey: cmd.prKey }, targetWindowId);
    } else {
      await getRt()?.openAzurePullRequest({ prKey: cmd.prKey }, targetWindowId);
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async function handleDismiss(cmd: any): Promise<void> {
    // For PR alerts, drop from the manager's forwarded-PR LRU so the user
    // can be re-notified later if the PR is re-flagged. For session-bound
    // alerts (shell completion, agent waiting), clear the per-session alert.
    if (cmd.prKey) {
      telegramManager.forgetForwardedPr(cmd.prKey);
      log.info("telegram: dismiss PR alert", { prKey: cmd.prKey });
    }
    if (cmd.workspaceId && cmd.panelId) {
      const sessionId = createSessionId(cmd.workspaceId, cmd.panelId);
      clearAlertSession(sessionId);
    }
    broadcastState();
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async function handleCustomMessage(cmd: any): Promise<void> {
    log.info("telegram: custom-message received", {
      workspaceId: cmd.workspaceId,
      textPreview: String(cmd.taskDescription || "").slice(0, 80),
    });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const DISPATCH_TABLE: Record<string, (cmd: any) => Promise<void>> = {
    "start-task": handleStartTask,
    "start-existing-task": handleStartExistingTask,
    "pause-task": handlePauseTask,
    "resume-task": handleResumeTask,
    "stop-task": handleStopTask,
    "reset-task": handleResetTask,
    "update-task-description": handleUpdateTaskDescription,
    "send-task-file": handleSendTaskFile,
    "screenshot-current": handleScreenshot,
    "screenshot-workspace": handleScreenshot,
    "open-pr-review": handleOpenPrReview,
    dismiss: handleDismiss,
    "custom-message": handleCustomMessage,
  };

  // Named so tests can await a full dispatch via _dispatchTelegramCommandForTest.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async function dispatchTelegramCommand(cmd: any): Promise<void> {
    log.info("telegram: command dispatch", {
      type: cmd.type,
      workspaceId: cmd.workspaceId,
      prKey: cmd.prKey,
      provider: cmd.provider,
      profileId: cmd.profileId,
    });
    try {
      const handler = DISPATCH_TABLE[cmd.type];
      if (handler) await handler(cmd);
    } catch (err) {
      log.warn("telegram: command dispatch error", { type: cmd.type, err: (err as Error).message });
    }
  }

  return { dispatchTelegramCommand };
}
