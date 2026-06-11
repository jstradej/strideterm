/// <reference types="node" />
import { ipcMain, dialog, BrowserWindow, shell, clipboard, Notification, app } from "electron";
import path, { join } from "node:path";
import { homedir } from "node:os";
import { stat, mkdir, writeFile, readFile } from "node:fs/promises";
import { pathToFileURL, fileURLToPath } from "node:url";
import type { createRuntime } from "./runtime.js";
import { withOperationPromise } from "./effect/runtime.js";
import * as fm from "./file-manager.js";
import { parseCommandTemplate, substituteCommandArg } from "./command-template.js";
import { resolveTerminalOpenAction } from "./terminal-open-action.js";
import { getLogger } from "./logger.js";
import {
  validateIpc,
  workspaceSchema,
  workspaceUIStateSchema,
  projectSchema,
  settingsSchema,
  azureConnectionSchema,
  azureCommentSchema,
  azureVoteSchema,
  azureThreadStatusSchema,
  openPrSchema,
  reviewBridgeDraftSchema,
  reviewBridgeDraftCommentSchema,
  reviewBridgeQueueSchema,
  reviewBridgeDeleteDraftSchema,
  reviewBridgeDeleteCommentSchema,
  reviewBridgeReplyWithChangesSchema,
  reviewBridgeSyncSchema,
  reviewBridgePushAndPublishSchema,
  agentPromptSaveSchema,
  agentPromptDeleteSchema,
  fileListSchema,
  fileReadSchema,
  fileWriteSchema,
  fileCreateSchema,
  fileRenameSchema,
  fileDeleteSchema,
  fileGitIgnoreSchema,
  fileMoveSchema,
  fileGitStatusSchema,
  fileGitRefsSchema,
  fileGitDiffSchema,
  fileCommitFilesSchema,
  fileCommitDiffSchema,
  gitPayloadSchema,
  azurePipelinePayloadSchema,
  gitDiffPreviewSchema,
  gitLogPageSchema,
  gitCommitSchema,
  gitTagSchema,
  gitStashListSchema,
  gitStashFilesSchema,
  gitStashFileDiffSchema,
  gitStashApplySchema,
  gitStashDropSchema,
  gitStashBranchSchema,
  gitStashExportSchema,
  gitStashImportSchema,
  gitBranchListSchema,
  gitBranchDeleteSchema,
  gitRemoteBranchDeleteSchema,
  gitBranchRenameSchema,
  gitCheckoutRemoteSchema,
  gitLogGraphSchema,
  dockerActionSchema,
  dockerSessionSchema,
  dockerLogsOpenSchema,
  dockerLogsUpdateSchema,
  dockerLogsCloseSchema,
  dockerComposeActionSchema,
  dockerInspectSchema,
  dockerTopSchema,
  dockerStatsSchema,
  dockerShellOpenSchema,
  dockerShellWriteSchema,
  dockerShellResizeSchema,
  dockerShellCloseSchema,
  dockerResourceRefSchema,
  dockerRemoveSchema,
  dockerSystemDfSchema,
  dockerPruneSchema,
  dockerVolumeBrowseSchema,
  terminalResizeSchema,
  terminalSessionSchema,
  profileSchema,
  workspaceReorderSchema,
  attentionSyncSchema,
  notificationShowSchema,
  workspacePushOptionsSchema,
  worktreeSchema,
  removeWorktreeSchema,
  quickFixListProjectsSchema,
  quickFixListRepositoriesSchema,
  quickFixListBranchesSchema,
  quickFixCreateSchema,
  azureAuditLogQuerySchema,
  azureAuditLogStatsSchema,
  githubConnectionSchema,
  githubCommentSchema,
  githubReviewSchema,
  githubAuditLogQuerySchema,
  githubAuditLogStatsSchema,
  githubQuickFixListReposSchema,
  githubQuickFixListBranchesSchema,
  githubQuickFixCreateSchema,
  rerunCheckSchema,
  taskWorkspaceCreateSchema,
  taskWorkspaceActionSchema,
  taskRejectVerdictSchema,
  taskResendInstructionSchema,
  taskUpdateDescriptionSchema,
  taskRecoveryResolveSchema,
  telegramConnectionSchema,
  workspaceIdSchema,
  workspaceDeleteOptionsSchema,
  workspaceGridEnableSchema,
  workspaceGridSetLayoutSchema,
  workspaceGridSetCellSchema,
  workspaceGridSwapCellsSchema,
} from "./ipc-schemas.js";
import { shouldShowSystemNotification } from "./notifications/system-notification-dedupe.js";

type Runtime = Awaited<ReturnType<typeof createRuntime>>;

export function registerIpc(
  runtime: Runtime,
  emitToRenderer: (channel: string, payload: unknown) => void,
  {
    includeStateGet = true,
    getWindowIdByWebContentsId,
    emitToWindow,
  }: {
    includeStateGet?: boolean;
    getWindowIdByWebContentsId?: (webContentsId: number) => string | undefined;
    emitToWindow?: (windowId: string, channel: string, payload: unknown) => void;
  } = {},
): () => void {
  const subscriptions = [
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    runtime.on("state:updated", (payload: any) => emitToRenderer("state:updated", payload)),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    runtime.on("terminal:data", (payload: any) => emitToRenderer("terminal:data", payload)),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    runtime.on("terminal:exit", (payload: any) => emitToRenderer("terminal:exit", payload)),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    runtime.on("ssh:auth-prompt", (payload: any) => emitToRenderer("ssh:auth-prompt", payload)),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    runtime.on("ssh:host-key-change", (payload: any) => emitToRenderer("ssh:host-key-change", payload)),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    runtime.on("ssh:connection-state", (payload: any) => emitToRenderer("ssh:connection-state", payload)),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    runtime.on("ssh:state", (payload: any) => emitToRenderer("ssh:state", payload)),
  ];

  if (includeStateGet) {
    ipcMain.handle("state:get", async () =>
      withOperationPromise({ opId: "state:get" }, () => runtime.getInitialState()),
    );
  }
  ipcMain.handle("shell:open-external", async (_event, url) =>
    withOperationPromise({ opId: "shell:open-external" }, async () => {
      // Mirror the strict scheme check from main.ts setWindowOpenHandler:
      // parse via WHATWG and require protocol === http:/https: exactly,
      // not just `^https?://` prefix. The bare prefix would let a payload
      // like `https://x#javascript:alert(1)` through without the JS being
      // run by the *opener* — but a malicious renderer can still craft a
      // URL whose registered protocol handler does something dangerous,
      // e.g. `vscode://file/etc/passwd`, and `shell.openExternal` will
      // hand it to the OS-registered handler. Restricting to http(s)
      // shuts that off completely.
      if (typeof url !== "string") return;
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        return;
      }
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return;
      return shell.openExternal(parsed.toString());
    }),
  );

  // Resolve a path captured from terminal output, validate it exists, and
  // dispatch the open action based on the user's `externalPathOpener` setting.
  // Used by the xterm path link provider (TerminalPane → terminal-controller).
  // Same scheme-strict spirit as shell:open-external: the renderer can be
  // tricked into asking us to open arbitrary paths, so we resolve relative
  // paths against the workspace cwd here (not via shell expansion) and stat
  // the result before any open action.
  //
  // Returns:
  //   { ok: true, absPath }                              — opened externally (system / command modes)
  //   { ok: true, absPath, internal: true, line, column } — caller handles in-app navigation
  //   { ok: false, error, absPath? }                      — surface to user via toast
  ipcMain.handle("terminal:open-path", async (_event, payload) =>
    withOperationPromise({ opId: "terminal:open-path" }, async () => {
      const rawPath = typeof payload?.path === "string" ? payload.path : "";
      if (!rawPath) return { ok: false, error: "Missing path" };
      const workspaceCwd = typeof payload?.workspaceCwd === "string" ? payload.workspaceCwd : "";
      const lineNum = typeof payload?.line === "number" ? payload.line : 0;
      const columnNum = typeof payload?.column === "number" ? payload.column : 0;

      let resolved = rawPath;
      if (resolved === "~") {
        resolved = homedir();
      } else if (resolved.startsWith("~/") || resolved.startsWith("~\\")) {
        resolved = path.join(homedir(), resolved.slice(2));
      } else if (!path.isAbsolute(resolved)) {
        const base = workspaceCwd || process.cwd();
        resolved = path.resolve(base, resolved);
      }

      let statResult;
      try {
        statResult = await stat(resolved);
      } catch {
        return { ok: false, error: `File not found: ${resolved}` };
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- runtime payload type is open by design
      const settings = (runtime.getPayload() as any)?.appState?.settings || {};
      const action = resolveTerminalOpenAction({
        isDirectory: statResult.isDirectory(),
        externalEditor: typeof settings.externalEditor === "string" ? settings.externalEditor : "",
        externalPathOpener: settings.externalPathOpener || {},
      });

      // Internal mode: just resolve and let the renderer navigate to its
      // FileManager pane. We don't have a direct way to drive the renderer
      // from main; the renderer reads the `internal: true` flag and dispatches.
      if (action.kind === "internal") {
        return { ok: true, internal: true, absPath: resolved, line: lineNum, column: columnNum };
      }

      // Editor mode: simple `externalEditor` field — tokenised argv-style,
      // file path appended as the last argv slot (no placeholder substitution,
      // no shell). Triggered only for files; directories took the fall-through.
      if (action.kind === "editor") {
        try {
          const { spawn } = await import("node:child_process");
          spawn(action.parsed.binary, [...action.parsed.args, resolved], {
            detached: true,
            stdio: "ignore",
          }).unref();
          return { ok: true, absPath: resolved };
        } catch (err) {
          return {
            ok: false,
            error: `Couldn't run "${action.parsed.binary}": ${(err as Error)?.message || String(err)}`,
            absPath: resolved,
          };
        }
      }

      // Command mode: parse the user's command template and spawn it. The
      // template is tokenised argv-style (no shell), so nothing gets handed
      // to `sh -c`. Placeholders ${path}/${line}/${column} are substituted in
      // each arg after tokenisation, so a malicious filename can't escape
      // its argv slot.
      if (action.kind === "command") {
        const parsed = parseCommandTemplate(action.template);
        if (!parsed) {
          return { ok: false, error: "Invalid command template (empty or unterminated quote)", absPath: resolved };
        }
        const substitutedArgs = parsed.args.map((arg) => substituteCommandArg(arg, resolved, lineNum, columnNum));
        try {
          const { spawn } = await import("node:child_process");
          spawn(parsed.binary, substitutedArgs, { detached: true, stdio: "ignore" }).unref();
          return { ok: true, absPath: resolved };
        } catch (err) {
          return {
            ok: false,
            error: `Couldn't run "${parsed.binary}": ${(err as Error)?.message || String(err)}`,
            absPath: resolved,
          };
        }
      }

      // System default: hand to the OS opener.
      try {
        const result = await shell.openPath(resolved);
        // shell.openPath returns "" on success and the error string on failure.
        if (result) return { ok: false, error: result, absPath: resolved };
        return { ok: true, absPath: resolved };
      } catch (err) {
        return { ok: false, error: (err as Error).message, absPath: resolved };
      }
    }),
  );

  ipcMain.handle("workspace:activate", async (event, workspaceId) => {
    const windowId = getWindowIdByWebContentsId?.(event.sender.id) ?? "";
    return withOperationPromise({ workspaceId: String(workspaceId || ""), opId: "workspace:activate" }, () =>
      windowId ? runtime.activateWorkspaceInWindow(workspaceId, windowId) : runtime.activateWorkspace(workspaceId),
    );
  });
  ipcMain.handle("project:activate", async (event, projectId) => {
    const windowId = getWindowIdByWebContentsId?.(event.sender.id) ?? "";
    return withOperationPromise({ opId: "project:activate" }, () =>
      windowId ? runtime.activateWorkspaceInWindow(projectId, windowId) : runtime.activateProject(projectId),
    );
  });
  ipcMain.handle("workspace:save", async (event, workspace) => {
    const windowId = getWindowIdByWebContentsId?.(event.sender.id) ?? "";
    return withOperationPromise({ opId: "workspace:save" }, () =>
      runtime.saveWorkspace(validateIpc(workspaceSchema, workspace, "workspace:save"), windowId),
    );
  });
  ipcMain.handle("project:save", async (event, project) => {
    const windowId = getWindowIdByWebContentsId?.(event.sender.id) ?? "";
    return withOperationPromise({ opId: "project:save" }, () =>
      runtime.saveProject(validateIpc(projectSchema, project, "project:save"), windowId),
    );
  });
  ipcMain.handle("workspace:delete", async (event, workspaceId, options) => {
    const windowId = getWindowIdByWebContentsId?.(event.sender.id) ?? "";
    const validId = validateIpc(workspaceIdSchema, workspaceId, "workspace:delete.workspaceId");
    const validOpts = validateIpc(workspaceDeleteOptionsSchema, options ?? {}, "workspace:delete.options");
    return withOperationPromise({ workspaceId: validId, opId: "workspace:delete" }, () =>
      runtime.deleteWorkspace(validId, validOpts, windowId),
    );
  });
  ipcMain.handle("project:delete", async (event, projectId) => {
    const windowId = getWindowIdByWebContentsId?.(event.sender.id) ?? "";
    return withOperationPromise({ opId: "project:delete" }, () => runtime.deleteProject(projectId, {}, windowId));
  });
  ipcMain.handle("workspace:reorder", async (event, workspaceIds) => {
    const windowId = getWindowIdByWebContentsId?.(event.sender.id) ?? "";
    return withOperationPromise({ opId: "workspace:reorder" }, () =>
      runtime.reorderWorkspaces(validateIpc(workspaceReorderSchema, workspaceIds, "workspace:reorder"), windowId),
    );
  });
  ipcMain.handle("project:reorder", async (event, projectIds) => {
    const windowId = getWindowIdByWebContentsId?.(event.sender.id) ?? "";
    return withOperationPromise({ opId: "project:reorder" }, () =>
      runtime.reorderProjects(validateIpc(workspaceReorderSchema, projectIds, "project:reorder"), windowId),
    );
  });
  ipcMain.handle("settings:update", async (_event, settings) =>
    withOperationPromise({ opId: "settings:update" }, async () => {
      const validated = validateIpc(settingsSchema, settings, "settings:update");
      const { payload, remoteAccessChanged } = await runtime.updateSettings(validated);
      return { payload, remoteAccessChanged };
    }),
  );
  ipcMain.handle("azure:verify-connection", async (_event, connection) =>
    withOperationPromise({ opId: "azure:verify-connection" }, () =>
      runtime.verifyAzureConnection(validateIpc(azureConnectionSchema, connection, "azure:verify-connection")),
    ),
  );
  ipcMain.handle("azure:save-connection", async (event, connection) => {
    const windowId = getWindowIdByWebContentsId?.(event.sender.id) ?? "";
    return withOperationPromise({ opId: "azure:save-connection" }, () =>
      runtime.saveAzureConnection(validateIpc(azureConnectionSchema, connection, "azure:save-connection"), windowId),
    );
  });
  ipcMain.handle("azure:delete-connection", async (event, connectionId) => {
    const windowId = getWindowIdByWebContentsId?.(event.sender.id) ?? "";
    return withOperationPromise({ opId: "azure:delete-connection" }, () =>
      runtime.deleteAzureConnection(connectionId, windowId),
    );
  });
  ipcMain.handle("azure:refresh", async () =>
    withOperationPromise({ opId: "azure:refresh" }, () => runtime.refreshAzureState()),
  );
  ipcMain.handle("azure:audit-log:query", async (_event, payload) =>
    withOperationPromise({ opId: "azure:audit-log:query" }, () =>
      runtime.queryAzureAuditLog(validateIpc(azureAuditLogQuerySchema, payload, "azure:audit-log:query")),
    ),
  );
  ipcMain.handle("azure:audit-log:stats", async (_event, payload) =>
    withOperationPromise({ opId: "azure:audit-log:stats" }, () =>
      runtime.getAzureAuditStats(validateIpc(azureAuditLogStatsSchema, payload, "azure:audit-log:stats")),
    ),
  );
  ipcMain.handle("azure:pull-request:seen", async (_event, prKey) =>
    withOperationPromise({ opId: "azure:pull-request:seen" }, () => runtime.markAzurePullRequestSeen(prKey)),
  );
  ipcMain.handle("azure:pull-request:open", async (event, payload) => {
    const windowId = getWindowIdByWebContentsId?.(event.sender.id) ?? "";
    return withOperationPromise({ opId: "azure:pull-request:open" }, () =>
      runtime.openAzurePullRequest(validateIpc(openPrSchema, payload, "azure:pull-request:open"), windowId),
    );
  });
  ipcMain.handle("azure:pull-request:comment", async (_event, payload) =>
    withOperationPromise({ opId: "azure:pull-request:comment" }, () =>
      runtime.commentAzurePullRequest(validateIpc(azureCommentSchema, payload, "azure:pull-request:comment")),
    ),
  );
  ipcMain.handle("azure:pull-request:thread-status", async (_event, payload) =>
    withOperationPromise({ opId: "azure:pull-request:thread-status" }, () =>
      runtime.updateAzureThreadStatus(
        validateIpc(azureThreadStatusSchema, payload, "azure:pull-request:thread-status"),
      ),
    ),
  );
  ipcMain.handle("review-bridge:draft-comment:create", async (event, payload) => {
    const windowId = getWindowIdByWebContentsId?.(event.sender.id) ?? "";
    return withOperationPromise({ opId: "review-bridge:draft-comment:create" }, () =>
      runtime.createReviewBridgeDraftComment(
        validateIpc(reviewBridgeDraftCommentSchema, payload, "review-bridge:draft-comment:create"),
        windowId,
      ),
    );
  });
  ipcMain.handle("review-bridge:draft:save", async (event, payload) => {
    const windowId = getWindowIdByWebContentsId?.(event.sender.id) ?? "";
    return withOperationPromise({ opId: "review-bridge:draft:save" }, () =>
      runtime.saveReviewBridgeDraft(
        validateIpc(reviewBridgeDraftSchema, payload, "review-bridge:draft:save"),
        windowId,
      ),
    );
  });
  ipcMain.handle("review-bridge:draft:queue", async (event, payload) => {
    const windowId = getWindowIdByWebContentsId?.(event.sender.id) ?? "";
    return withOperationPromise({ opId: "review-bridge:draft:queue" }, () =>
      runtime.queueReviewBridgeDraft(
        validateIpc(reviewBridgeQueueSchema, payload, "review-bridge:draft:queue"),
        windowId,
      ),
    );
  });
  ipcMain.handle("review-bridge:draft:delete", async (event, payload) => {
    const windowId = getWindowIdByWebContentsId?.(event.sender.id) ?? "";
    return withOperationPromise({ opId: "review-bridge:draft:delete" }, () =>
      runtime.deleteReviewBridgeDraft(
        validateIpc(reviewBridgeDeleteDraftSchema, payload, "review-bridge:draft:delete"),
        windowId,
      ),
    );
  });
  ipcMain.handle("review-bridge:comment:delete", async (event, payload) => {
    const windowId = getWindowIdByWebContentsId?.(event.sender.id) ?? "";
    return withOperationPromise({ opId: "review-bridge:comment:delete" }, () =>
      runtime.deleteReviewBridgeComment(
        validateIpc(reviewBridgeDeleteCommentSchema, payload, "review-bridge:comment:delete"),
        windowId,
      ),
    );
  });
  ipcMain.handle("review-bridge:comment:reply-with-changes", async (event, payload) => {
    const windowId = getWindowIdByWebContentsId?.(event.sender.id) ?? "";
    return withOperationPromise({ opId: "review-bridge:comment:reply-with-changes" }, () =>
      runtime.replyWithCodeChanges(
        validateIpc(reviewBridgeReplyWithChangesSchema, payload, "review-bridge:comment:reply-with-changes"),
        windowId,
      ),
    );
  });
  ipcMain.handle("review-bridge:agent-prompt:save", async (_event, payload) =>
    withOperationPromise({ opId: "review-bridge:agent-prompt:save" }, () =>
      runtime.saveAgentPrompt(validateIpc(agentPromptSaveSchema, payload, "review-bridge:agent-prompt:save")),
    ),
  );
  ipcMain.handle("review-bridge:agent-prompt:delete", async (_event, payload) =>
    withOperationPromise({ opId: "review-bridge:agent-prompt:delete" }, () =>
      runtime.deleteAgentPrompt(validateIpc(agentPromptDeleteSchema, payload, "review-bridge:agent-prompt:delete")),
    ),
  );
  ipcMain.handle("review-bridge:agent-prompt:reset", async () =>
    withOperationPromise({ opId: "review-bridge:agent-prompt:reset" }, () => runtime.resetAgentPrompts()),
  );
  ipcMain.handle("review-bridge:pull-request:sync", async (_event, payload) =>
    withOperationPromise({ opId: "review-bridge:pull-request:sync" }, () =>
      runtime.syncReviewBridgePullRequest(
        validateIpc(reviewBridgeSyncSchema, payload, "review-bridge:pull-request:sync"),
      ),
    ),
  );
  ipcMain.handle("review-bridge:pull-request:push-and-publish", async (event, payload) => {
    const windowId = getWindowIdByWebContentsId?.(event.sender.id) ?? "";
    return withOperationPromise({ opId: "review-bridge:pull-request:push-and-publish" }, () =>
      runtime.pushAndPublishReview(
        validateIpc(reviewBridgePushAndPublishSchema, payload, "review-bridge:pull-request:push-and-publish"),
        windowId,
      ),
    );
  });

  // --- SSH ---
  ipcMain.handle("ssh:hosts:list", async () =>
    withOperationPromise({ opId: "ssh:hosts:list" }, () => runtime["ssh:hosts:list"]()),
  );
  ipcMain.handle("ssh:hosts:create", async (_event, payload) =>
    withOperationPromise({ opId: "ssh:hosts:create" }, () => runtime["ssh:hosts:create"](payload)),
  );
  ipcMain.handle("ssh:hosts:update", async (_event, payload) =>
    withOperationPromise({ opId: "ssh:hosts:update" }, () => runtime["ssh:hosts:update"](payload)),
  );
  ipcMain.handle("ssh:hosts:delete", async (_event, payload) =>
    withOperationPromise({ opId: "ssh:hosts:delete" }, () => runtime["ssh:hosts:delete"](payload)),
  );
  ipcMain.handle("ssh:hosts:duplicate", async (_event, payload) =>
    withOperationPromise({ opId: "ssh:hosts:duplicate" }, () => runtime["ssh:hosts:duplicate"](payload)),
  );
  ipcMain.handle("ssh:hosts:test", async (_event, payload) =>
    withOperationPromise({ opId: "ssh:hosts:test" }, () => runtime["ssh:hosts:test"](payload)),
  );
  ipcMain.handle("ssh:keys:list", async () =>
    withOperationPromise({ opId: "ssh:keys:list" }, () => runtime["ssh:keys:list"]()),
  );
  ipcMain.handle("ssh:keys:import", async (_event, payload) =>
    withOperationPromise({ opId: "ssh:keys:import" }, () => runtime["ssh:keys:import"](payload)),
  );
  ipcMain.handle("ssh:keys:generate", async (_event, payload) =>
    withOperationPromise({ opId: "ssh:keys:generate" }, () => runtime["ssh:keys:generate"](payload)),
  );
  ipcMain.handle("ssh:keys:delete", async (_event, payload) =>
    withOperationPromise({ opId: "ssh:keys:delete" }, () => runtime["ssh:keys:delete"](payload)),
  );
  ipcMain.handle("ssh:certs:list", async () =>
    withOperationPromise({ opId: "ssh:certs:list" }, () => runtime["ssh:certs:list"]()),
  );
  ipcMain.handle("ssh:certs:import", async (_event, payload) =>
    withOperationPromise({ opId: "ssh:certs:import" }, () => runtime["ssh:certs:import"](payload)),
  );
  ipcMain.handle("ssh:certs:delete", async (_event, payload) =>
    withOperationPromise({ opId: "ssh:certs:delete" }, () => runtime["ssh:certs:delete"](payload)),
  );
  ipcMain.handle("ssh:auth:answer", async (_event, payload) =>
    withOperationPromise({ opId: "ssh:auth:answer" }, () => runtime["ssh:auth:answer"](payload)),
  );
  ipcMain.handle("ssh:auth:cancel", async (_event, payload) =>
    withOperationPromise({ opId: "ssh:auth:cancel" }, () => runtime["ssh:auth:cancel"](payload)),
  );
  ipcMain.handle("ssh:host-key:accept", async (_event, payload) =>
    withOperationPromise({ opId: "ssh:host-key:accept" }, () => runtime["ssh:host-key:accept"](payload)),
  );
  ipcMain.handle("ssh:host-key:reject", async (_event, payload) =>
    withOperationPromise({ opId: "ssh:host-key:reject" }, () => runtime["ssh:host-key:reject"](payload)),
  );
  ipcMain.handle("ssh:config:preview", async (_event, payload) =>
    withOperationPromise({ opId: "ssh:config:preview" }, () => runtime["ssh:config:preview"](payload)),
  );
  ipcMain.handle("ssh:config:import", async (_event, payload) =>
    withOperationPromise({ opId: "ssh:config:import" }, () => runtime["ssh:config:import"](payload)),
  );
  ipcMain.handle("ssh:known-hosts:import", async (_event, payload) =>
    withOperationPromise({ opId: "ssh:known-hosts:import" }, () => runtime["ssh:known-hosts:import"](payload)),
  );
  ipcMain.handle("azure:pull-request:vote", async (_event, payload) =>
    withOperationPromise({ opId: "azure:pull-request:vote" }, () =>
      runtime.voteAzurePullRequest(validateIpc(azureVoteSchema, payload, "azure:pull-request:vote")),
    ),
  );
  ipcMain.handle("azure:workspace:fetch", async (_event, workspaceId) =>
    withOperationPromise({ workspaceId: String(workspaceId || ""), opId: "azure:workspace:fetch" }, () =>
      runtime.fetchAzureReviewWorkspace(workspaceId),
    ),
  );
  ipcMain.handle("azure:workspace:rebase", async (_event, workspaceId) =>
    withOperationPromise({ workspaceId: String(workspaceId || ""), opId: "azure:workspace:rebase" }, () =>
      runtime.rebaseAzureReviewWorkspace(workspaceId),
    ),
  );
  ipcMain.handle("azure:workspace:push", async (_event, workspaceId, options) =>
    withOperationPromise({ workspaceId: String(workspaceId || ""), opId: "azure:workspace:push" }, () =>
      runtime.pushAzureReviewWorkspace(
        workspaceId,
        validateIpc(workspacePushOptionsSchema, options || {}, "azure:workspace:push"),
      ),
    ),
  );
  ipcMain.handle("azure:create-pull-request", async (_event, payload) =>
    withOperationPromise({ opId: "azure:create-pull-request" }, () =>
      runtime.azureCreatePullRequest(validateIpc(gitPayloadSchema, payload, "azure:create-pull-request")),
    ),
  );
  ipcMain.handle("azure:list-remote-branches", async (_event, payload) =>
    withOperationPromise({ opId: "azure:list-remote-branches" }, () =>
      runtime.azureListRemoteBranches(validateIpc(gitPayloadSchema, payload, "azure:list-remote-branches")),
    ),
  );
  ipcMain.handle("azure:quickfix:list-projects", async (_event, payload) =>
    withOperationPromise({ opId: "azure:quickfix:list-projects" }, () =>
      runtime.azureQuickFixListProjects(
        validateIpc(quickFixListProjectsSchema, payload, "azure:quickfix:list-projects"),
      ),
    ),
  );
  ipcMain.handle("azure:quickfix:list-repositories", async (_event, payload) =>
    withOperationPromise({ opId: "azure:quickfix:list-repositories" }, () =>
      runtime.azureQuickFixListRepositories(
        validateIpc(quickFixListRepositoriesSchema, payload, "azure:quickfix:list-repositories"),
      ),
    ),
  );
  ipcMain.handle("azure:quickfix:list-branches", async (_event, payload) =>
    withOperationPromise({ opId: "azure:quickfix:list-branches" }, () =>
      runtime.azureQuickFixListBranches(
        validateIpc(quickFixListBranchesSchema, payload, "azure:quickfix:list-branches"),
      ),
    ),
  );
  ipcMain.handle("azure:quickfix:create", async (event, payload) => {
    const windowId = getWindowIdByWebContentsId?.(event.sender.id) ?? "";
    return withOperationPromise({ opId: "azure:quickfix:create" }, () =>
      runtime.azureQuickFixCreate(validateIpc(quickFixCreateSchema, payload, "azure:quickfix:create"), windowId),
    );
  });
  ipcMain.handle("azure:rerun-check", async (_event, prKey, checkItem) =>
    withOperationPromise({ opId: "azure:rerun-check" }, async () => {
      const validated = validateIpc(rerunCheckSchema, { prKey, checkItem }, "azure:rerun-check");
      return runtime.rerunAzureCheck(validated.prKey, validated.checkItem);
    }),
  );
  ipcMain.handle("azure:pipelines:list", async (_event, payload) =>
    withOperationPromise({ opId: "azure:pipelines:list" }, () =>
      runtime.listAzurePipelines(validateIpc(azurePipelinePayloadSchema, payload, "azure:pipelines:list")),
    ),
  );
  ipcMain.handle("azure:pipelines:runs", async (_event, payload) =>
    withOperationPromise({ opId: "azure:pipelines:runs" }, () =>
      runtime.listAzurePipelineRuns(validateIpc(azurePipelinePayloadSchema, payload, "azure:pipelines:runs")),
    ),
  );
  ipcMain.handle("azure:pipelines:run-seed", async (_event, payload) =>
    withOperationPromise({ opId: "azure:pipelines:run-seed" }, () =>
      runtime.getAzurePipelineRunSeed(validateIpc(azurePipelinePayloadSchema, payload, "azure:pipelines:run-seed")),
    ),
  );
  ipcMain.handle("azure:pipelines:run-parameters", async (_event, payload) =>
    withOperationPromise({ opId: "azure:pipelines:run-parameters" }, () =>
      runtime.getAzurePipelineRunParameters(
        validateIpc(azurePipelinePayloadSchema, payload, "azure:pipelines:run-parameters"),
      ),
    ),
  );
  ipcMain.handle("azure:pipelines:refs", async (_event, payload) =>
    withOperationPromise({ opId: "azure:pipelines:refs" }, () =>
      runtime.getAzurePipelineRefs(validateIpc(azurePipelinePayloadSchema, payload, "azure:pipelines:refs")),
    ),
  );
  ipcMain.handle("azure:pipelines:commits", async (_event, payload) =>
    withOperationPromise({ opId: "azure:pipelines:commits" }, () =>
      runtime.getAzurePipelineCommits(validateIpc(azurePipelinePayloadSchema, payload, "azure:pipelines:commits")),
    ),
  );
  ipcMain.handle("azure:pipelines:run", async (_event, payload) =>
    withOperationPromise({ opId: "azure:pipelines:run" }, () =>
      runtime.runAzurePipeline(validateIpc(azurePipelinePayloadSchema, payload, "azure:pipelines:run")),
    ),
  );
  ipcMain.handle("azure:pipelines:run-status", async (_event, payload) =>
    withOperationPromise({ opId: "azure:pipelines:run-status" }, () =>
      runtime.getAzurePipelineRunStatus(validateIpc(azurePipelinePayloadSchema, payload, "azure:pipelines:run-status")),
    ),
  );
  ipcMain.handle("azure:pipelines:cancel", async (_event, payload) =>
    withOperationPromise({ opId: "azure:pipelines:cancel" }, () =>
      runtime.cancelAzureBuild(validateIpc(azurePipelinePayloadSchema, payload, "azure:pipelines:cancel")),
    ),
  );
  ipcMain.handle("azure:pipelines:build-log", async (_event, payload) =>
    withOperationPromise({ opId: "azure:pipelines:build-log" }, () =>
      runtime.getAzureBuildLog(validateIpc(azurePipelinePayloadSchema, payload, "azure:pipelines:build-log")),
    ),
  );
  ipcMain.handle("azure:pipelines:run-detail", async (_event, payload) =>
    withOperationPromise({ opId: "azure:pipelines:run-detail" }, () =>
      runtime.getAzurePipelineRunDetail(validateIpc(azurePipelinePayloadSchema, payload, "azure:pipelines:run-detail")),
    ),
  );

  // --- GitHub ---
  ipcMain.handle("github:verify-connection", async (_event, connection) =>
    withOperationPromise({ opId: "github:verify-connection" }, () =>
      runtime.verifyGitHubConnection(validateIpc(githubConnectionSchema, connection, "github:verify-connection")),
    ),
  );
  ipcMain.handle("github:save-connection", async (event, connection) => {
    const windowId = getWindowIdByWebContentsId?.(event.sender.id) ?? "";
    return withOperationPromise({ opId: "github:save-connection" }, () =>
      runtime.saveGitHubConnection(validateIpc(githubConnectionSchema, connection, "github:save-connection"), windowId),
    );
  });
  ipcMain.handle("github:delete-connection", async (event, connectionId) => {
    const windowId = getWindowIdByWebContentsId?.(event.sender.id) ?? "";
    return withOperationPromise({ opId: "github:delete-connection" }, () =>
      runtime.deleteGitHubConnection(connectionId, windowId),
    );
  });
  ipcMain.handle("github:refresh", async () =>
    withOperationPromise({ opId: "github:refresh" }, () => runtime.refreshGitHubState()),
  );
  ipcMain.handle("github:audit-log:query", async (_event, payload) =>
    withOperationPromise({ opId: "github:audit-log:query" }, () =>
      runtime.queryGitHubAuditLog(validateIpc(githubAuditLogQuerySchema, payload, "github:audit-log:query")),
    ),
  );
  ipcMain.handle("github:audit-log:stats", async (_event, payload) =>
    withOperationPromise({ opId: "github:audit-log:stats" }, () =>
      runtime.getGitHubAuditStats(validateIpc(githubAuditLogStatsSchema, payload, "github:audit-log:stats")),
    ),
  );
  ipcMain.handle("github:pull-request:seen", async (_event, prKey) =>
    withOperationPromise({ opId: "github:pull-request:seen" }, () => runtime.markGitHubPullRequestSeen(prKey)),
  );
  ipcMain.handle("github:pull-request:open", async (event, payload) => {
    const windowId = getWindowIdByWebContentsId?.(event.sender.id) ?? "";
    return withOperationPromise({ opId: "github:pull-request:open" }, () =>
      runtime.openGitHubPullRequest(validateIpc(openPrSchema, payload, "github:pull-request:open"), windowId),
    );
  });
  ipcMain.handle("github:pull-request:comment", async (_event, payload) =>
    withOperationPromise({ opId: "github:pull-request:comment" }, () =>
      runtime.commentGitHubPullRequest(validateIpc(githubCommentSchema, payload, "github:pull-request:comment")),
    ),
  );
  ipcMain.handle("github:pull-request:review", async (_event, payload) =>
    withOperationPromise({ opId: "github:pull-request:review" }, () =>
      runtime.submitGitHubPullRequestReview(validateIpc(githubReviewSchema, payload, "github:pull-request:review")),
    ),
  );
  ipcMain.handle("github:rerun-check", async (_event, prKey, checkItem) =>
    withOperationPromise({ opId: "github:rerun-check" }, async () => {
      const validated = validateIpc(rerunCheckSchema, { prKey, checkItem }, "github:rerun-check");
      return runtime.rerunGitHubCheck(validated.prKey, validated.checkItem);
    }),
  );
  ipcMain.handle("github:workspace:fetch", async (_event, workspaceId) =>
    withOperationPromise({ workspaceId: String(workspaceId || ""), opId: "github:workspace:fetch" }, () =>
      runtime.fetchGitHubReviewWorkspace(workspaceId),
    ),
  );
  ipcMain.handle("github:workspace:rebase", async (_event, workspaceId) =>
    withOperationPromise({ workspaceId: String(workspaceId || ""), opId: "github:workspace:rebase" }, () =>
      runtime.rebaseGitHubReviewWorkspace(workspaceId),
    ),
  );
  ipcMain.handle("github:workspace:push", async (_event, workspaceId, options) =>
    withOperationPromise({ workspaceId: String(workspaceId || ""), opId: "github:workspace:push" }, () =>
      runtime.pushGitHubReviewWorkspace(
        workspaceId,
        validateIpc(workspacePushOptionsSchema, options || {}, "github:workspace:push"),
      ),
    ),
  );
  ipcMain.handle("github:list-remote-branches", async (_event, payload) =>
    withOperationPromise({ opId: "github:list-remote-branches" }, () =>
      runtime.githubListRemoteBranches(validateIpc(gitPayloadSchema, payload, "github:list-remote-branches")),
    ),
  );
  ipcMain.handle("github:create-pull-request", async (_event, payload) =>
    withOperationPromise({ opId: "github:create-pull-request" }, () =>
      runtime.githubCreatePullRequest(validateIpc(gitPayloadSchema, payload, "github:create-pull-request")),
    ),
  );
  ipcMain.handle("github:quickfix:list-repos", async (_event, payload) =>
    withOperationPromise({ opId: "github:quickfix:list-repos" }, () =>
      runtime.githubQuickFixListRepos(
        validateIpc(githubQuickFixListReposSchema, payload, "github:quickfix:list-repos"),
      ),
    ),
  );
  ipcMain.handle("github:quickfix:list-branches", async (_event, payload) =>
    withOperationPromise({ opId: "github:quickfix:list-branches" }, () =>
      runtime.githubQuickFixListBranches(
        validateIpc(githubQuickFixListBranchesSchema, payload, "github:quickfix:list-branches"),
      ),
    ),
  );
  ipcMain.handle("github:quickfix:create", async (event, payload) => {
    const windowId = getWindowIdByWebContentsId?.(event.sender.id) ?? "";
    return withOperationPromise({ opId: "github:quickfix:create" }, () =>
      runtime.githubQuickFixCreate(
        validateIpc(githubQuickFixCreateSchema, payload, "github:quickfix:create"),
        windowId,
      ),
    );
  });

  ipcMain.handle("telegram:verify-connection", async (_event, connection) =>
    withOperationPromise({ opId: "telegram:verify-connection" }, () =>
      runtime.verifyTelegramConnection(validateIpc(telegramConnectionSchema, connection, "telegram:verify-connection")),
    ),
  );
  ipcMain.handle("telegram:detect-chats", async (_event, connection) =>
    withOperationPromise({ opId: "telegram:detect-chats" }, () =>
      runtime.detectTelegramChats(validateIpc(telegramConnectionSchema, connection, "telegram:detect-chats")),
    ),
  );
  ipcMain.handle("telegram:save-connection", async (_event, connection) =>
    withOperationPromise({ opId: "telegram:save-connection" }, () =>
      runtime.saveTelegramConnection(validateIpc(telegramConnectionSchema, connection, "telegram:save-connection")),
    ),
  );
  ipcMain.handle("telegram:delete-connection", async (_event, connectionId) =>
    withOperationPromise({ opId: "telegram:delete-connection" }, () =>
      runtime.deleteTelegramConnection(String(connectionId || "")),
    ),
  );
  ipcMain.handle("telegram:refresh", async () =>
    withOperationPromise({ opId: "telegram:refresh" }, () => runtime.refreshTelegramState()),
  );

  ipcMain.handle("session:activate", async (event, sessionId) => {
    const windowId = getWindowIdByWebContentsId?.(event.sender.id) ?? "";
    return withOperationPromise({ opId: "session:activate" }, () =>
      windowId ? runtime.activateSessionInWindow(sessionId, windowId) : runtime.activateSession(sessionId),
    );
  });
  ipcMain.handle("workspace:set-ui-state", async (event, workspaceId, uiState) =>
    withOperationPromise({ workspaceId: String(workspaceId || ""), opId: "workspace:set-ui-state" }, async () => {
      const parsed = validateIpc(workspaceUIStateSchema, { workspaceId, uiState }, "workspace:set-ui-state");
      const windowId = getWindowIdByWebContentsId?.(event.sender.id) ?? "";
      return runtime.setWorkspaceUIState(parsed.workspaceId, parsed.uiState, windowId);
    }),
  );
  ipcMain.handle("workspace-grid:enable", async (event, payload) =>
    withOperationPromise({ opId: "workspace-grid:enable" }, () => {
      const parsed = validateIpc(workspaceGridEnableSchema, payload, "workspace-grid:enable");
      const windowId = getWindowIdByWebContentsId?.(event.sender.id) ?? "";
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (runtime as any).enableWorkspaceGrid(parsed.layout, parsed.workspaceIds, windowId);
    }),
  );
  ipcMain.handle("workspace-grid:disable", async (event) => {
    const windowId = getWindowIdByWebContentsId?.(event.sender.id) ?? "";
    return withOperationPromise({ opId: "workspace-grid:disable" }, () =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (runtime as any).disableWorkspaceGrid(windowId),
    );
  });
  ipcMain.handle("workspace-grid:set-layout", async (event, payload) =>
    withOperationPromise({ opId: "workspace-grid:set-layout" }, () => {
      const parsed = validateIpc(workspaceGridSetLayoutSchema, payload, "workspace-grid:set-layout");
      const windowId = getWindowIdByWebContentsId?.(event.sender.id) ?? "";
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (runtime as any).setGridLayout(parsed.layout, windowId);
    }),
  );
  ipcMain.handle("workspace-grid:set-cell", async (event, payload) =>
    withOperationPromise({ opId: "workspace-grid:set-cell" }, () => {
      const parsed = validateIpc(workspaceGridSetCellSchema, payload, "workspace-grid:set-cell");
      const windowId = getWindowIdByWebContentsId?.(event.sender.id) ?? "";
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (runtime as any).setGridCell(parsed.cellIndex, parsed.workspaceId, windowId);
    }),
  );
  ipcMain.handle("workspace-grid:swap-cells", async (event, payload) =>
    withOperationPromise({ opId: "workspace-grid:swap-cells" }, () => {
      const parsed = validateIpc(workspaceGridSwapCellsSchema, payload, "workspace-grid:swap-cells");
      const windowId = getWindowIdByWebContentsId?.(event.sender.id) ?? "";
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (runtime as any).swapGridCells(parsed.a, parsed.b, windowId);
    }),
  );
  ipcMain.handle("attention:sync", async (event, payload) => {
    const windowId = getWindowIdByWebContentsId?.(event.sender.id) ?? "";
    return withOperationPromise({ opId: "attention:sync" }, () =>
      runtime.syncAttentionContext({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ...(validateIpc(attentionSyncSchema, payload || {}, "attention:sync") as any),
        windowId: windowId || null,
      }),
    );
  });
  ipcMain.handle("attention:clear-all", async (event) => {
    const windowId = getWindowIdByWebContentsId?.(event.sender.id) ?? "";
    return withOperationPromise({ opId: "attention:clear-all" }, () =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (runtime as any).clearAllAttention(windowId || null),
    );
  });
  ipcMain.handle("attention:clear-session", async (event, sessionId, options) => {
    const windowId = getWindowIdByWebContentsId?.(event.sender.id) ?? "";
    return withOperationPromise({ opId: "attention:clear-session" }, () =>
      runtime.clearAlertForSession(String(sessionId || ""), {
        dismissed: options?.dismissed === true,
        windowId: windowId || null,
      }),
    );
  });
  ipcMain.handle("terminal:restart", async (_event, sessionId) =>
    withOperationPromise({ opId: "terminal:restart" }, () => runtime.restartSession(sessionId)),
  );
  ipcMain.handle("terminal:close", async (_event, sessionId) =>
    withOperationPromise({ opId: "terminal:close" }, () => runtime.closeSession(sessionId)),
  );
  ipcMain.handle("terminal:replay", async (_event, payload) =>
    withOperationPromise({ opId: "terminal:replay" }, () => {
      const parsed = validateIpc(terminalSessionSchema, payload, "terminal:replay");
      return runtime.getTerminalReplay(parsed.sessionId);
    }),
  );
  ipcMain.handle("remote:token:regenerate", async () =>
    withOperationPromise({ opId: "remote:token:regenerate" }, () => runtime.regenerateRemoteToken()),
  );
  ipcMain.handle("tunnel:refresh", async () =>
    withOperationPromise({ opId: "tunnel:refresh" }, () => runtime.refreshTunnelState()),
  );
  ipcMain.handle("tunnel:create", async () =>
    withOperationPromise({ opId: "tunnel:create" }, () => runtime.createCloudflareTunnel()),
  );
  ipcMain.handle("tunnel:stop", async () =>
    withOperationPromise({ opId: "tunnel:stop" }, () => runtime.stopCloudflareTunnel()),
  );
  ipcMain.handle("claude-hook:configure", async () =>
    withOperationPromise({ opId: "claude-hook:configure" }, () => runtime.configureClaudeHook()),
  );
  ipcMain.handle("claude-hook:remove", async () =>
    withOperationPromise({ opId: "claude-hook:remove" }, () => runtime.removeClaudeHook()),
  );
  ipcMain.handle("claude-hook:status", async () =>
    withOperationPromise({ opId: "claude-hook:status" }, () => runtime.getClaudeHookStatus()),
  );
  ipcMain.handle("claude-hook:test", async () =>
    withOperationPromise({ opId: "claude-hook:test" }, () => runtime.testClaudeHook()),
  );
  ipcMain.handle("gemini-hook:configure", async () =>
    withOperationPromise({ opId: "gemini-hook:configure" }, () => runtime.configureGeminiHook()),
  );
  ipcMain.handle("gemini-hook:remove", async () =>
    withOperationPromise({ opId: "gemini-hook:remove" }, () => runtime.removeGeminiHook()),
  );
  ipcMain.handle("gemini-hook:status", async () =>
    withOperationPromise({ opId: "gemini-hook:status" }, () => runtime.getGeminiHookStatus()),
  );
  ipcMain.handle("gemini-hook:test", async () =>
    withOperationPromise({ opId: "gemini-hook:test" }, () => runtime.testGeminiHook()),
  );
  ipcMain.handle("codex-hook:configure", async () =>
    withOperationPromise({ opId: "codex-hook:configure" }, () => runtime.configureCodexHook()),
  );
  ipcMain.handle("codex-hook:remove", async () =>
    withOperationPromise({ opId: "codex-hook:remove" }, () => runtime.removeCodexHook()),
  );
  ipcMain.handle("codex-hook:status", async () =>
    withOperationPromise({ opId: "codex-hook:status" }, () => runtime.getCodexHookStatus()),
  );
  ipcMain.handle("codex-hook:test", async () =>
    withOperationPromise({ opId: "codex-hook:test" }, () => runtime.testCodexHook()),
  );
  ipcMain.handle("copilot-hook:configure", async () =>
    withOperationPromise({ opId: "copilot-hook:configure" }, () => runtime.configureCopilotHook()),
  );
  ipcMain.handle("copilot-hook:remove", async () =>
    withOperationPromise({ opId: "copilot-hook:remove" }, () => runtime.removeCopilotHook()),
  );
  ipcMain.handle("copilot-hook:status", async () =>
    withOperationPromise({ opId: "copilot-hook:status" }, () => runtime.getCopilotHookStatus()),
  );
  ipcMain.handle("copilot-hook:test", async () =>
    withOperationPromise({ opId: "copilot-hook:test" }, () => runtime.testCopilotHook()),
  );
  ipcMain.handle("opencode-hook:configure", async () =>
    withOperationPromise({ opId: "opencode-hook:configure" }, () => runtime.configureOpencodeHook()),
  );
  ipcMain.handle("opencode-hook:remove", async () =>
    withOperationPromise({ opId: "opencode-hook:remove" }, () => runtime.removeOpencodeHook()),
  );
  ipcMain.handle("opencode-hook:status", async () =>
    withOperationPromise({ opId: "opencode-hook:status" }, () => runtime.getOpencodeHookStatus()),
  );
  ipcMain.handle("opencode-hook:test", async () =>
    withOperationPromise({ opId: "opencode-hook:test" }, () => runtime.testOpencodeHook()),
  );
  ipcMain.handle("notifications:metrics", async () =>
    withOperationPromise({ opId: "notifications:metrics" }, () => runtime.getNotificationMetrics()),
  );

  // --- Task runner ---
  ipcMain.handle("task:recheck-claude", async () =>
    withOperationPromise({ opId: "task:recheck-claude" }, () => runtime.recheckClaude()),
  );
  ipcMain.handle("task:check-providers", async () =>
    withOperationPromise({ opId: "task:check-providers" }, () => runtime.checkProviders()),
  );
  ipcMain.handle("task:check-git-repo", async (_event, cwd) =>
    withOperationPromise({ opId: "task:check-git-repo" }, () => runtime.checkIsGitRepo(String(cwd || ""))),
  );
  ipcMain.handle("fs:probe-directory", async (_event, cwd) =>
    withOperationPromise({ opId: "fs:probe-directory" }, () => runtime.probeDirectory(String(cwd || ""))),
  );
  ipcMain.handle("task:create-workspace", async (event, payload) => {
    const windowId = getWindowIdByWebContentsId?.(event.sender.id) ?? "";
    return withOperationPromise({ opId: "task:create-workspace" }, () =>
      runtime.createTaskWorkspace(validateIpc(taskWorkspaceCreateSchema, payload, "task:create-workspace"), windowId),
    );
  });
  ipcMain.handle("task:start", async (event, payload) => {
    const p = validateIpc(taskWorkspaceActionSchema, payload, "task:start");
    const windowId = getWindowIdByWebContentsId?.(event.sender.id) ?? "";
    return withOperationPromise({ workspaceId: p.workspaceId, opId: "task:start" }, () =>
      runtime.startTask(p.workspaceId, windowId),
    );
  });
  ipcMain.handle("task:stop", async (event, payload) => {
    const p = validateIpc(taskWorkspaceActionSchema, payload, "task:stop");
    const windowId = getWindowIdByWebContentsId?.(event.sender.id) ?? "";
    return withOperationPromise({ workspaceId: p.workspaceId, opId: "task:stop" }, () =>
      runtime.stopTask(p.workspaceId, windowId),
    );
  });
  ipcMain.handle("task:pause", async (event, payload) => {
    const p = validateIpc(taskWorkspaceActionSchema, payload, "task:pause");
    const windowId = getWindowIdByWebContentsId?.(event.sender.id) ?? "";
    return withOperationPromise({ workspaceId: p.workspaceId, opId: "task:pause" }, () =>
      runtime.pauseTask(p.workspaceId, windowId),
    );
  });
  ipcMain.handle("task:resume", async (event, payload) => {
    const p = validateIpc(taskWorkspaceActionSchema, payload, "task:resume");
    const windowId = getWindowIdByWebContentsId?.(event.sender.id) ?? "";
    return withOperationPromise({ workspaceId: p.workspaceId, opId: "task:resume" }, () =>
      runtime.resumeTask(p.workspaceId, windowId),
    );
  });
  ipcMain.handle("task:reset", async (event, payload) => {
    const p = validateIpc(taskWorkspaceActionSchema, payload, "task:reset");
    const windowId = getWindowIdByWebContentsId?.(event.sender.id) ?? "";
    return withOperationPromise({ workspaceId: p.workspaceId, opId: "task:reset" }, () =>
      runtime.resetTask(p.workspaceId, windowId),
    );
  });
  ipcMain.handle("task:reject-verdict", async (_event, payload) =>
    withOperationPromise({ opId: "task:reject-verdict" }, async () => {
      const parsed = validateIpc(taskRejectVerdictSchema, payload, "task:reject-verdict");
      return runtime.rejectTaskVerdict(parsed.workspaceId, parsed.feedback);
    }),
  );
  ipcMain.handle("task:resend-instruction", async (_event, payload) =>
    withOperationPromise({ opId: "task:resend-instruction" }, async () => {
      const parsed = validateIpc(taskResendInstructionSchema, payload, "task:resend-instruction");
      return runtime.resendTaskInstruction(parsed.workspaceId, parsed.role);
    }),
  );
  ipcMain.handle("task:update-description", async (event, payload) => {
    const p = validateIpc(taskUpdateDescriptionSchema, payload, "task:update-description");
    const windowId = getWindowIdByWebContentsId?.(event.sender.id) ?? "";
    return withOperationPromise({ workspaceId: p.workspaceId, opId: "task:update-description" }, () =>
      runtime.updateTaskDescription(p.workspaceId, p.description, windowId),
    );
  });
  ipcMain.handle("task:status", async (_event, workspaceId) =>
    withOperationPromise({ workspaceId: String(workspaceId || ""), opId: "task:status" }, () =>
      runtime.getTaskStatus(workspaceId),
    ),
  );
  ipcMain.handle("task-recovery:resolve", async (_event, payload) =>
    withOperationPromise({ opId: "task-recovery:resolve" }, async () => {
      const parsed = validateIpc(taskRecoveryResolveSchema, payload, "task-recovery:resolve");
      return runtime.resolveTaskRecovery(parsed.decisions);
    }),
  );
  ipcMain.handle("docker:refresh", async () =>
    withOperationPromise({ opId: "docker:refresh" }, () => runtime.refreshDockerState()),
  );
  ipcMain.handle("git:refresh", async (_event, projectId) =>
    withOperationPromise({ workspaceId: String(projectId || ""), opId: "git:refresh" }, () =>
      runtime.refreshGitState(projectId),
    ),
  );
  ipcMain.handle("git:fetch", async (_event, payload) => {
    const p = validateIpc(gitPayloadSchema, payload, "git:fetch");
    return withOperationPromise({ workspaceId: p.workspaceId, opId: "git:fetch" }, () => runtime.gitFetch(p));
  });
  ipcMain.handle("git:pull", async (_event, payload) => {
    const p = validateIpc(gitPayloadSchema, payload, "git:pull");
    return withOperationPromise({ workspaceId: p.workspaceId, opId: "git:pull" }, () => runtime.gitPull(p));
  });
  ipcMain.handle("git:push", async (_event, payload) => {
    const p = validateIpc(gitPayloadSchema, payload, "git:push");
    return withOperationPromise({ workspaceId: p.workspaceId, opId: "git:push" }, () => runtime.gitPush(p));
  });
  ipcMain.handle("git:checkout-branch", async (_event, payload) => {
    const p = validateIpc(gitPayloadSchema, payload, "git:checkout-branch");
    return withOperationPromise({ workspaceId: p.workspaceId, opId: "git:checkout-branch" }, () =>
      runtime.gitCheckoutBranch(p),
    );
  });
  ipcMain.handle("git:create-branch", async (_event, payload) => {
    const p = validateIpc(gitPayloadSchema, payload, "git:create-branch");
    return withOperationPromise({ workspaceId: p.workspaceId, opId: "git:create-branch" }, () =>
      runtime.gitCreateBranch(p),
    );
  });
  ipcMain.handle("git:merge-into-current", async (_event, payload) => {
    const p = validateIpc(gitPayloadSchema, payload, "git:merge-into-current");
    return withOperationPromise({ workspaceId: p.workspaceId, opId: "git:merge-into-current" }, () =>
      runtime.gitMergeIntoCurrent(p),
    );
  });
  ipcMain.handle("git:rebase-onto", async (_event, payload) => {
    const p = validateIpc(gitPayloadSchema, payload, "git:rebase-onto");
    return withOperationPromise({ workspaceId: p.workspaceId, opId: "git:rebase-onto" }, () =>
      runtime.gitRebaseOnto(p),
    );
  });
  ipcMain.handle("git:continue", async (_event, payload) => {
    const p = validateIpc(gitPayloadSchema, payload, "git:continue");
    return withOperationPromise({ workspaceId: p.workspaceId, opId: "git:continue" }, () =>
      runtime.gitContinueOperation(p),
    );
  });
  ipcMain.handle("git:abort", async (_event, payload) => {
    const p = validateIpc(gitPayloadSchema, payload, "git:abort");
    return withOperationPromise({ workspaceId: p.workspaceId, opId: "git:abort" }, () => runtime.gitAbortOperation(p));
  });
  ipcMain.handle("git:diff-preview", async (_event, payload) =>
    withOperationPromise({ opId: "git:diff-preview" }, () =>
      runtime.gitDiffPreview(validateIpc(gitDiffPreviewSchema, payload, "git:diff-preview")),
    ),
  );
  ipcMain.handle("git:compare-branch", async (_event, payload) => {
    const p = validateIpc(gitPayloadSchema, payload, "git:compare-branch");
    return withOperationPromise({ workspaceId: p.workspaceId, opId: "git:compare-branch" }, () =>
      runtime.gitCompareBranch(p),
    );
  });
  ipcMain.handle("git:merge-into-base", async (_event, payload) => {
    const p = validateIpc(gitPayloadSchema, payload, "git:merge-into-base");
    return withOperationPromise({ workspaceId: p.workspaceId, opId: "git:merge-into-base" }, () =>
      runtime.gitMergeCurrentIntoBase(p),
    );
  });
  ipcMain.handle("git:remove-worktree", async (_event, payload) => {
    const p = validateIpc(removeWorktreeSchema, payload, "git:remove-worktree");
    return withOperationPromise({ workspaceId: p.workspaceId, opId: "git:remove-worktree" }, () =>
      runtime.gitRemoveWorktree(p),
    );
  });
  ipcMain.handle("git:commit-all", async (_event, payload) =>
    withOperationPromise({ opId: "git:commit-all" }, () =>
      runtime.gitCommitAll(validateIpc(gitCommitSchema, payload, "git:commit-all")),
    ),
  );
  ipcMain.handle("git:stash", async (_event, payload) => {
    const p = validateIpc(gitPayloadSchema, payload, "git:stash");
    return withOperationPromise({ workspaceId: p.workspaceId, opId: "git:stash" }, () => runtime.gitStash(p));
  });
  ipcMain.handle("git:stash-pop", async (_event, payload) => {
    const p = validateIpc(gitPayloadSchema, payload, "git:stash-pop");
    return withOperationPromise({ workspaceId: p.workspaceId, opId: "git:stash-pop" }, () => runtime.gitStashPop(p));
  });
  ipcMain.handle("git:stash-list", async (_event, payload) => {
    const p = validateIpc(gitStashListSchema, payload, "git:stash-list");
    return withOperationPromise({ workspaceId: p.workspaceId, opId: "git:stash-list" }, () =>
      runtime.gitListStashes(p),
    );
  });
  ipcMain.handle("git:stash-files", async (_event, payload) => {
    const p = validateIpc(gitStashFilesSchema, payload, "git:stash-files");
    return withOperationPromise({ workspaceId: p.workspaceId, opId: "git:stash-files" }, () =>
      runtime.gitStashFiles(p),
    );
  });
  ipcMain.handle("git:stash-file-diff", async (_event, payload) => {
    const p = validateIpc(gitStashFileDiffSchema, payload, "git:stash-file-diff");
    return withOperationPromise({ workspaceId: p.workspaceId, opId: "git:stash-file-diff" }, () =>
      runtime.gitStashFileDiff(p),
    );
  });
  ipcMain.handle("git:stash-apply", async (_event, payload) => {
    const p = validateIpc(gitStashApplySchema, payload, "git:stash-apply");
    return withOperationPromise({ workspaceId: p.workspaceId, opId: "git:stash-apply" }, () =>
      runtime.gitStashApply(p),
    );
  });
  ipcMain.handle("git:stash-drop", async (_event, payload) => {
    const p = validateIpc(gitStashDropSchema, payload, "git:stash-drop");
    return withOperationPromise({ workspaceId: p.workspaceId, opId: "git:stash-drop" }, () => runtime.gitStashDrop(p));
  });
  ipcMain.handle("git:stash-branch", async (_event, payload) => {
    const p = validateIpc(gitStashBranchSchema, payload, "git:stash-branch");
    return withOperationPromise({ workspaceId: p.workspaceId, opId: "git:stash-branch" }, () =>
      runtime.gitStashBranch(p),
    );
  });
  ipcMain.handle("git:stash-export", async (_event, payload) => {
    const p = validateIpc(gitStashExportSchema, payload, "git:stash-export");
    return withOperationPromise({ workspaceId: p.workspaceId, opId: "git:stash-export" }, () =>
      runtime.gitStashExport(p),
    );
  });
  ipcMain.handle("git:stash-import", async (_event, payload) => {
    const p = validateIpc(gitStashImportSchema, payload, "git:stash-import");
    return withOperationPromise({ workspaceId: p.workspaceId, opId: "git:stash-import" }, () =>
      runtime.gitStashImport(p),
    );
  });
  ipcMain.handle("git:commit-diff", async (_event, payload) =>
    withOperationPromise({ opId: "git:commit-diff" }, () =>
      runtime.gitCommitDiff(validateIpc(gitPayloadSchema, payload, "git:commit-diff")),
    ),
  );
  ipcMain.handle("git:commit-info", async (_event, payload) =>
    withOperationPromise({ opId: "git:commit-info" }, () =>
      runtime.gitCommitInfo(validateIpc(gitPayloadSchema, payload, "git:commit-info")),
    ),
  );
  ipcMain.handle("git:log-page", async (_event, payload) =>
    withOperationPromise({ opId: "git:log-page" }, () =>
      runtime.gitLogPage(validateIpc(gitLogPageSchema, payload, "git:log-page")),
    ),
  );
  ipcMain.handle("git:list-tags", async (_event, payload) => {
    const p = validateIpc(gitPayloadSchema, payload, "git:list-tags");
    return withOperationPromise({ workspaceId: p.workspaceId, opId: "git:list-tags" }, () => runtime.gitListTags(p));
  });
  ipcMain.handle("git:create-tag", async (_event, payload) => {
    const p = validateIpc(gitTagSchema, payload, "git:create-tag");
    return withOperationPromise({ workspaceId: p.workspaceId, opId: "git:create-tag" }, () => runtime.gitCreateTag(p));
  });
  ipcMain.handle("git:delete-tag", async (_event, payload) => {
    const p = validateIpc(gitTagSchema, payload, "git:delete-tag");
    return withOperationPromise({ workspaceId: p.workspaceId, opId: "git:delete-tag" }, () => runtime.gitDeleteTag(p));
  });
  ipcMain.handle("git:push-tag", async (_event, payload) => {
    const p = validateIpc(gitTagSchema, payload, "git:push-tag");
    return withOperationPromise({ workspaceId: p.workspaceId, opId: "git:push-tag" }, () => runtime.gitPushTag(p));
  });
  ipcMain.handle("git:push-all-tags", async (_event, payload) => {
    const p = validateIpc(gitPayloadSchema, payload, "git:push-all-tags");
    return withOperationPromise({ workspaceId: p.workspaceId, opId: "git:push-all-tags" }, () =>
      runtime.gitPushAllTags(p),
    );
  });
  ipcMain.handle("git:delete-remote-tag", async (_event, payload) => {
    const p = validateIpc(gitTagSchema, payload, "git:delete-remote-tag");
    return withOperationPromise({ workspaceId: p.workspaceId, opId: "git:delete-remote-tag" }, () =>
      runtime.gitDeleteRemoteTag(p),
    );
  });
  ipcMain.handle("git:force-push-with-lease", async (_event, payload) => {
    const p = validateIpc(gitPayloadSchema, payload, "git:force-push-with-lease");
    return withOperationPromise({ workspaceId: p.workspaceId, opId: "git:force-push-with-lease" }, () =>
      runtime.gitForcePushWithLease(p),
    );
  });
  ipcMain.handle("git:list-branches", async (_event, payload) =>
    withOperationPromise({ opId: "git:list-branches" }, () =>
      runtime.gitListBranches(validateIpc(gitBranchListSchema, payload, "git:list-branches")),
    ),
  );
  ipcMain.handle("git:delete-branch", async (_event, payload) => {
    const p = validateIpc(gitBranchDeleteSchema, payload, "git:delete-branch");
    return withOperationPromise({ workspaceId: p.workspaceId, opId: "git:delete-branch" }, () =>
      runtime.gitDeleteBranch(p),
    );
  });
  ipcMain.handle("git:delete-remote-branch", async (_event, payload) => {
    const p = validateIpc(gitRemoteBranchDeleteSchema, payload, "git:delete-remote-branch");
    return withOperationPromise({ workspaceId: p.workspaceId, opId: "git:delete-remote-branch" }, () =>
      runtime.gitDeleteRemoteBranch(p),
    );
  });
  ipcMain.handle("git:rename-branch", async (_event, payload) => {
    const p = validateIpc(gitBranchRenameSchema, payload, "git:rename-branch");
    return withOperationPromise({ workspaceId: p.workspaceId, opId: "git:rename-branch" }, () =>
      runtime.gitRenameBranch(p),
    );
  });
  ipcMain.handle("git:checkout-remote-branch", async (_event, payload) => {
    const p = validateIpc(gitCheckoutRemoteSchema, payload, "git:checkout-remote-branch");
    return withOperationPromise({ workspaceId: p.workspaceId, opId: "git:checkout-remote-branch" }, () =>
      runtime.gitCheckoutRemoteBranch(p),
    );
  });
  ipcMain.handle("git:log-graph", async (_event, payload) =>
    withOperationPromise({ opId: "git:log-graph" }, () =>
      runtime.gitLogGraph(validateIpc(gitLogGraphSchema, payload, "git:log-graph")),
    ),
  );
  ipcMain.handle("git:skip-commit", async (_event, payload) => {
    const p = validateIpc(gitPayloadSchema, payload, "git:skip-commit");
    return withOperationPromise({ workspaceId: p.workspaceId, opId: "git:skip-commit" }, () =>
      runtime.gitSkipCommit(p),
    );
  });
  ipcMain.handle("git:list-conflicts", async (_event, payload) => {
    const p = validateIpc(gitPayloadSchema, payload, "git:list-conflicts");
    return withOperationPromise({ workspaceId: p.workspaceId, opId: "git:list-conflicts" }, () =>
      runtime.gitListConflicts(p),
    );
  });
  ipcMain.handle("git:conflict-detail", async (_event, payload) => {
    const p = validateIpc(gitPayloadSchema, payload, "git:conflict-detail");
    return withOperationPromise({ workspaceId: p.workspaceId, opId: "git:conflict-detail" }, () =>
      runtime.gitConflictDetail(p),
    );
  });
  ipcMain.handle("git:resolve-conflict", async (_event, payload) => {
    const p = validateIpc(gitPayloadSchema, payload, "git:resolve-conflict");
    return withOperationPromise({ workspaceId: p.workspaceId, opId: "git:resolve-conflict" }, () =>
      runtime.gitResolveConflict(p),
    );
  });
  ipcMain.handle("git:unresolve-conflict", async (_event, payload) => {
    const p = validateIpc(gitPayloadSchema, payload, "git:unresolve-conflict");
    return withOperationPromise({ workspaceId: p.workspaceId, opId: "git:unresolve-conflict" }, () =>
      runtime.gitUnresolveConflict(p),
    );
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ipcMain.handle("docker:action", async (_event, actionOrPayload: any, containerIdArg?: any) =>
    withOperationPromise({ opId: "docker:action" }, async () => {
      // Accept both old 2-arg form (action, containerId) and new object form.
      const raw =
        typeof actionOrPayload === "object" && actionOrPayload !== null
          ? actionOrPayload
          : { action: actionOrPayload, containerId: containerIdArg };
      const validated = validateIpc(dockerActionSchema, raw, "docker:action");
      return runtime.dockerAction(validated.action, validated.containerId, validated.backendId, validated.contextName);
    }),
  );
  ipcMain.handle("docker:open-session", async (_event, payload) =>
    withOperationPromise({ opId: "docker:open-session" }, () =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      runtime.openDockerSession(validateIpc(dockerSessionSchema, payload, "docker:open-session") as any),
    ),
  );
  ipcMain.handle("docker:open-lazydocker", async (_event, payload) =>
    withOperationPromise({ opId: "docker:open-lazydocker" }, () =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      runtime.openLazydockerSession(validateIpc(gitPayloadSchema, payload, "docker:open-lazydocker") as any),
    ),
  );
  ipcMain.handle("docker:logs:open", async (_event, payload) =>
    withOperationPromise({ opId: "docker:logs:open" }, async () => {
      const validated = validateIpc(dockerLogsOpenSchema, payload, "docker:logs:open");
      await runtime.dockerLogsOpen(
        validated.sessionId,
        validated.containerId,
        validated.backendId,
        validated.contextName,
        (sessionId: string, data: Buffer) => emitToRenderer("docker:logs:write", { sessionId, data }),
        (sessionId: string, code: number | null) => emitToRenderer("docker:logs:close", { sessionId, code }),
        { timestamps: validated.timestamps, tail: validated.tail },
      );
      return { ok: true };
    }),
  );
  ipcMain.handle("docker:logs:update", async (_event, payload) =>
    withOperationPromise({ opId: "docker:logs:update" }, async () => {
      const v = validateIpc(dockerLogsUpdateSchema, payload, "docker:logs:update");
      const ok = runtime.dockerLogsUpdate(v.sessionId, { timestamps: v.timestamps, tail: v.tail });
      return { ok };
    }),
  );
  ipcMain.handle("docker:logs:close", async (_event, payload) =>
    withOperationPromise({ opId: "docker:logs:close" }, async () => {
      const validated = validateIpc(dockerLogsCloseSchema, payload, "docker:logs:close");
      runtime.dockerLogsClose(validated.sessionId);
      return { ok: true };
    }),
  );
  ipcMain.handle("docker:compose-action", async (_event, payload) =>
    withOperationPromise({ opId: "docker:compose-action" }, async () => {
      const validated = validateIpc(dockerComposeActionSchema, payload, "docker:compose-action");
      return runtime.dockerComposeAction(
        validated.action,
        validated.backendId,
        validated.contextName,
        validated.projectName,
      );
    }),
  );
  ipcMain.handle("docker:inspect", async (_event, payload) =>
    withOperationPromise({ opId: "docker:inspect" }, async () => {
      const v = validateIpc(dockerInspectSchema, payload, "docker:inspect");
      return runtime.dockerInspect(v.containerId, v.backendId, v.contextName);
    }),
  );
  ipcMain.handle("docker:top", async (_event, payload) =>
    withOperationPromise({ opId: "docker:top" }, async () => {
      const v = validateIpc(dockerTopSchema, payload, "docker:top");
      return runtime.dockerTop(v.containerId, v.backendId, v.contextName);
    }),
  );
  ipcMain.handle("docker:stats", async (_event, payload) =>
    withOperationPromise({ opId: "docker:stats" }, async () => {
      const v = validateIpc(dockerStatsSchema, payload, "docker:stats");
      return runtime.dockerStats(v.containerId, v.backendId, v.contextName);
    }),
  );
  ipcMain.handle("docker:shell:open", async (_event, payload) =>
    withOperationPromise({ opId: "docker:shell:open" }, async () => {
      const v = validateIpc(dockerShellOpenSchema, payload, "docker:shell:open");
      await runtime.dockerShellOpen(
        v.sessionId,
        v.containerId,
        v.backendId,
        v.contextName,
        v.cols ?? 80,
        v.rows ?? 24,
        (sid: string, data: string) => emitToRenderer("docker:shell:data", { sessionId: sid, data }),
        (sid: string, code: number | null) => emitToRenderer("docker:shell:close", { sessionId: sid, code }),
      );
      return { ok: true };
    }),
  );
  ipcMain.handle("docker:shell:write", async (_event, payload) =>
    withOperationPromise({ opId: "docker:shell:write" }, async () => {
      const v = validateIpc(dockerShellWriteSchema, payload, "docker:shell:write");
      runtime.dockerShellWrite(v.sessionId, v.data);
      return { ok: true };
    }),
  );
  ipcMain.handle("docker:shell:resize", async (_event, payload) =>
    withOperationPromise({ opId: "docker:shell:resize" }, async () => {
      const v = validateIpc(dockerShellResizeSchema, payload, "docker:shell:resize");
      runtime.dockerShellResize(v.sessionId, v.cols, v.rows);
      return { ok: true };
    }),
  );
  ipcMain.handle("docker:shell:close", async (_event, payload) =>
    withOperationPromise({ opId: "docker:shell:close" }, async () => {
      const v = validateIpc(dockerShellCloseSchema, payload, "docker:shell:close");
      runtime.dockerShellClose(v.sessionId);
      return { ok: true };
    }),
  );
  ipcMain.handle("docker:image:inspect", async (_event, payload) =>
    withOperationPromise({ opId: "docker:image:inspect" }, async () => {
      const v = validateIpc(dockerResourceRefSchema, payload, "docker:image:inspect");
      return runtime.dockerImageInspect(v.resource, v.backendId, v.contextName);
    }),
  );
  ipcMain.handle("docker:volume:inspect", async (_event, payload) =>
    withOperationPromise({ opId: "docker:volume:inspect" }, async () => {
      const v = validateIpc(dockerResourceRefSchema, payload, "docker:volume:inspect");
      return runtime.dockerVolumeInspect(v.resource, v.backendId, v.contextName);
    }),
  );
  ipcMain.handle("docker:network:inspect", async (_event, payload) =>
    withOperationPromise({ opId: "docker:network:inspect" }, async () => {
      const v = validateIpc(dockerResourceRefSchema, payload, "docker:network:inspect");
      return runtime.dockerNetworkInspect(v.resource, v.backendId, v.contextName);
    }),
  );
  ipcMain.handle("docker:image:remove", async (_event, payload) =>
    withOperationPromise({ opId: "docker:image:remove" }, async () => {
      const v = validateIpc(dockerRemoveSchema, payload, "docker:image:remove");
      return runtime.dockerImageRemove(v.resource, v.backendId, v.contextName, !!v.force);
    }),
  );
  ipcMain.handle("docker:volume:remove", async (_event, payload) =>
    withOperationPromise({ opId: "docker:volume:remove" }, async () => {
      const v = validateIpc(dockerRemoveSchema, payload, "docker:volume:remove");
      return runtime.dockerVolumeRemove(v.resource, v.backendId, v.contextName, !!v.force);
    }),
  );
  ipcMain.handle("docker:network:remove", async (_event, payload) =>
    withOperationPromise({ opId: "docker:network:remove" }, async () => {
      const v = validateIpc(dockerRemoveSchema, payload, "docker:network:remove");
      return runtime.dockerNetworkRemove(v.resource, v.backendId, v.contextName);
    }),
  );
  ipcMain.handle("docker:image:pull", async (_event, payload) =>
    withOperationPromise({ opId: "docker:image:pull" }, async () => {
      const v = validateIpc(dockerResourceRefSchema, payload, "docker:image:pull");
      return runtime.dockerImagePull(v.resource, v.backendId, v.contextName);
    }),
  );
  ipcMain.handle("docker:image:prune", async (_event, payload) =>
    withOperationPromise({ opId: "docker:image:prune" }, async () => {
      const v = validateIpc(dockerPruneSchema, payload, "docker:image:prune");
      return runtime.dockerImagePrune(v.backendId, v.contextName, !!v.all);
    }),
  );
  ipcMain.handle("docker:volume:prune", async (_event, payload) =>
    withOperationPromise({ opId: "docker:volume:prune" }, async () => {
      const v = validateIpc(dockerPruneSchema, payload, "docker:volume:prune");
      return runtime.dockerVolumePrune(v.backendId, v.contextName);
    }),
  );
  ipcMain.handle("docker:network:prune", async (_event, payload) =>
    withOperationPromise({ opId: "docker:network:prune" }, async () => {
      const v = validateIpc(dockerPruneSchema, payload, "docker:network:prune");
      return runtime.dockerNetworkPrune(v.backendId, v.contextName);
    }),
  );
  ipcMain.handle("docker:builder:prune", async (_event, payload) =>
    withOperationPromise({ opId: "docker:builder:prune" }, async () => {
      const v = validateIpc(dockerPruneSchema, payload, "docker:builder:prune");
      return runtime.dockerBuilderPrune(v.backendId, v.contextName, !!v.all);
    }),
  );
  ipcMain.handle("docker:system:df", async (_event, payload) =>
    withOperationPromise({ opId: "docker:system:df" }, async () => {
      const v = validateIpc(dockerSystemDfSchema, payload, "docker:system:df");
      return runtime.dockerSystemDf(v.backendId, v.contextName);
    }),
  );
  ipcMain.handle("docker:volume:list", async (_event, payload) =>
    withOperationPromise({ opId: "docker:volume:list" }, async () => {
      const v = validateIpc(dockerVolumeBrowseSchema, payload, "docker:volume:list");
      return runtime.dockerVolumeList(v.volumeName, v.backendId, v.contextName, v.subPath);
    }),
  );
  ipcMain.handle("docker:volume:read", async (_event, payload) =>
    withOperationPromise({ opId: "docker:volume:read" }, async () => {
      const v = validateIpc(dockerVolumeBrowseSchema, payload, "docker:volume:read");
      return runtime.dockerVolumeReadFile(v.volumeName, v.backendId, v.contextName, v.subPath);
    }),
  );
  ipcMain.handle("git:open-lazygit", async (_event, payload) =>
    withOperationPromise({ opId: "git:open-lazygit" }, () =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      runtime.openLazygitSession(validateIpc(gitPayloadSchema, payload, "git:open-lazygit") as any),
    ),
  );
  ipcMain.handle("git:create-worktree", async (event, payload) => {
    const windowId = getWindowIdByWebContentsId?.(event.sender.id) ?? "";
    return withOperationPromise({ opId: "git:create-worktree" }, () =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      runtime.createWorktree(validateIpc(worktreeSchema, payload, "git:create-worktree") as any, windowId),
    );
  });
  ipcMain.handle("plugins:list", async () =>
    withOperationPromise({ opId: "plugins:list" }, () => runtime.getPlugins()),
  );
  ipcMain.handle("plugins:workspace-template", async (_event, pluginId) =>
    withOperationPromise({ opId: "plugins:workspace-template" }, () => runtime.getPluginWorkspaceTemplate(pluginId)),
  );
  ipcMain.handle("profile:save", async (_event, profile) =>
    withOperationPromise({ opId: "profile:save" }, () =>
      runtime.saveProfile(validateIpc(profileSchema, profile, "profile:save")),
    ),
  );
  ipcMain.handle("profile:delete", async (_event, profileId, options) =>
    withOperationPromise({ opId: "profile:delete" }, () =>
      runtime.deleteProfile(profileId, options && typeof options === "object" ? options : {}),
    ),
  );
  ipcMain.handle("profile:activate", async (event, profileId) => {
    const windowId = getWindowIdByWebContentsId?.(event.sender.id) ?? "";
    return withOperationPromise({ opId: "profile:activate" }, () =>
      runtime.activateProfileInWindow(profileId, windowId),
    );
  });

  ipcMain.handle("notification:show-system", async (event, payload) =>
    withOperationPromise({ opId: "notification:show-system" }, async () => {
      if (!Notification.isSupported()) return;
      const validated = validateIpc(notificationShowSchema, payload || {}, "notification:show-system");
      // App-level dedupe: multiple unfocused windows of the same profile fire
      // this for the same alert — only the first popup within the window wins.
      // In-app toasts stay per-window; only the OS popup is deduped.
      if (!shouldShowSystemNotification(validated.dedupeKey || "")) return;
      const urgent = validated.urgency === "urgent" || validated.requireInteraction === true;
      // Route click/flash back to the WINDOW THAT FIRED the notification.
      // Using BrowserWindow.getAllWindows()[0] (the previous behavior) sent
      // the user to whatever window happened to be first in the registry,
      // which in multi-window setups silently jumped them out of the
      // profile they were working in.
      const senderWindow = BrowserWindow.fromWebContents(event.sender);
      const notif = new Notification({
        title: validated.title || "strIDEterm",
        body: validated.body || "",
        icon: join(app.getAppPath(), "assets", "icon.png"),
        // Windows/macOS honor `urgency`; Linux uses `urgency: "critical"`
        urgency: urgent ? "critical" : "normal",
        // On platforms that support it (macOS, some Linux), keeps the
        // notification visible until the user acts on it.
        timeoutType: urgent ? "never" : "default",
      });
      notif.on("click", () => {
        const win = senderWindow && !senderWindow.isDestroyed() ? senderWindow : BrowserWindow.getAllWindows()[0];
        if (win) {
          if (win.isMinimized()) win.restore();
          win.focus();
        }
      });
      notif.show();
      // Extra attention for urgent: flash taskbar until the window gets focus.
      if (urgent) {
        const win = senderWindow && !senderWindow.isDestroyed() ? senderWindow : BrowserWindow.getAllWindows()[0];
        if (win && !win.isFocused() && typeof win.flashFrame === "function") {
          win.flashFrame(true);
        }
      }
    }),
  );

  ipcMain.handle("app:check-for-updates", async () =>
    withOperationPromise({ opId: "app:check-for-updates" }, () => runtime.checkForUpdates()),
  );
  ipcMain.handle("app:check-command", async (_event, command) =>
    withOperationPromise({ opId: "app:check-command" }, () => runtime.checkCommand(command)),
  );

  // --- File manager ---
  ipcMain.handle("file:list", async (_event, payload) =>
    withOperationPromise({ opId: "file:list" }, async () => {
      const p = validateIpc(fileListSchema, payload, "file:list");
      return fm.listDirectory(p.rootPath, p.relativePath);
    }),
  );
  ipcMain.handle("file:tree", async (_event, payload) =>
    withOperationPromise({ opId: "file:tree" }, async () => {
      const p = validateIpc(fileListSchema, payload, "file:tree");
      return fm.getDirectoryTree(p.rootPath, p.relativePath);
    }),
  );
  ipcMain.handle("file:preview", async (_event, payload) =>
    withOperationPromise({ opId: "file:preview" }, async () => {
      const p = validateIpc(fileReadSchema, payload, "file:preview");
      return fm.readFilePreview(p.rootPath, p.relativePath);
    }),
  );
  ipcMain.handle("file:read", async (_event, payload) =>
    withOperationPromise({ opId: "file:read" }, async () => {
      const p = validateIpc(fileReadSchema, payload, "file:read");
      return fm.readFileContent(p.rootPath, p.relativePath);
    }),
  );
  ipcMain.handle("file:write", async (_event, payload) =>
    withOperationPromise({ opId: "file:write" }, async () => {
      const p = validateIpc(fileWriteSchema, payload, "file:write");
      return fm.writeFileContent(p.rootPath, p.relativePath, p.content);
    }),
  );
  ipcMain.handle("file:create-file", async (_event, payload) =>
    withOperationPromise({ opId: "file:create-file" }, async () => {
      const p = validateIpc(fileCreateSchema, payload, "file:create-file");
      return fm.createFile(p.rootPath, p.parentPath, p.name);
    }),
  );
  ipcMain.handle("file:create-dir", async (_event, payload) =>
    withOperationPromise({ opId: "file:create-dir" }, async () => {
      const p = validateIpc(fileCreateSchema, payload, "file:create-dir");
      return fm.createDirectory(p.rootPath, p.parentPath, p.name);
    }),
  );
  ipcMain.handle("file:rename", async (_event, payload) =>
    withOperationPromise({ opId: "file:rename" }, async () => {
      const p = validateIpc(fileRenameSchema, payload, "file:rename");
      return fm.renameEntry(p.rootPath, p.relativePath, p.newName);
    }),
  );
  ipcMain.handle("file:delete", async (_event, payload) =>
    withOperationPromise({ opId: "file:delete" }, async () => {
      const p = validateIpc(fileDeleteSchema, payload, "file:delete");
      return fm.deleteEntry(p.rootPath, p.relativePath);
    }),
  );
  ipcMain.handle("file:git-ignore", async (_event, payload) =>
    withOperationPromise({ opId: "file:git-ignore" }, async () => {
      const p = validateIpc(fileGitIgnoreSchema, payload, "file:git-ignore");
      return fm.addToGitignore(p.rootPath, p.relativePath, p.isDirectory === true);
    }),
  );
  ipcMain.handle("file:move", async (_event, payload) =>
    withOperationPromise({ opId: "file:move" }, async () => {
      const p = validateIpc(fileMoveSchema, payload, "file:move");
      return fm.moveEntry(p.rootPath, p.fromPath, p.toPath);
    }),
  );
  ipcMain.handle("file:copy", async (_event, payload) =>
    withOperationPromise({ opId: "file:copy" }, async () => {
      const p = validateIpc(fileMoveSchema, payload, "file:copy");
      return fm.copyEntry(p.rootPath, p.fromPath, p.toPath);
    }),
  );
  ipcMain.handle("file:open-in-explorer", async (_event, payload) =>
    withOperationPromise({ opId: "file:open-in-explorer" }, async () => {
      const p = validateIpc(fileReadSchema, payload, "file:open-in-explorer");
      const absPath = fm.resolveWorkspaceAbsPath(p.rootPath, p.relativePath);
      shell.showItemInFolder(absPath);
    }),
  );
  ipcMain.handle("file:clipboard-copy", async (_event, payload) =>
    withOperationPromise({ opId: "file:clipboard-copy" }, async () => {
      const p = validateIpc(fileReadSchema, payload, "file:clipboard-copy");
      const absPath = fm.resolveWorkspaceAbsPath(p.rootPath, p.relativePath);
      // Always put the absolute path on the clipboard as plain text — works
      // everywhere as a fallback (paste into a terminal, editor, address bar).
      clipboard.writeText(absPath);
      // Best-effort native "copy file" so OS file managers (Finder, Explorer,
      // GNOME Files, etc.) accept the subsequent paste as a real file copy.
      // Wrapped in try/catch — if a particular Electron build doesn't accept
      // the raw format, the plain-text path above still got copied.
      try {
        if (process.platform === "darwin") {
          // NSPasteboard accepts a single file URL via the public.file-url UTI.
          const fileURL = pathToFileURL(absPath).href;
          clipboard.writeBuffer("public.file-url", Buffer.from(fileURL, "utf8"));
        } else if (process.platform === "win32") {
          // CF_HDROP: DROPFILES header (20 bytes) + UTF-16LE filenames,
          // null-separated and double-null-terminated.
          const header = Buffer.alloc(20);
          header.writeUInt32LE(20, 0); // pFiles offset
          header.writeInt32LE(0, 4); // pt.x
          header.writeInt32LE(0, 8); // pt.y
          header.writeUInt32LE(0, 12); // fNC
          header.writeUInt32LE(1, 16); // fWide = 1 (Unicode)
          const list = Buffer.from(absPath + "\0\0", "utf16le");
          clipboard.writeBuffer("CF_HDROP", Buffer.concat([header, list]));
        } else {
          // Linux/BSD: text/uri-list is the cross-DE standard; GNOME also
          // honors x-special/gnome-copied-files for "Paste" in Files/Nautilus.
          const fileURL = pathToFileURL(absPath).href;
          clipboard.writeBuffer("text/uri-list", Buffer.from(fileURL + "\n", "utf8"));
          clipboard.writeBuffer("x-special/gnome-copied-files", Buffer.from(`copy\n${fileURL}`, "utf8"));
        }
      } catch {
        // Fall back to the plain-text path that was already written above.
      }
    }),
  );
  // Image-aware terminal paste. When the user presses Ctrl/Cmd+V in a
  // terminal and the clipboard holds an image (e.g. Snipping Tool /
  // Print Screen / ShareX / Greenshot), xterm's text-only paste does
  // nothing. This handler returns a usable file path the renderer can
  // type into the terminal instead — Claude Code, Codex, etc. then
  // read the image off disk.
  //
  // Resolution order:
  //   1. If the clipboard already contains a file path (CF_HDROP on
  //      Windows, public.file-url on macOS, text/uri-list on Linux)
  //      that points to an existing image file, return it as-is —
  //      avoids saving the screenshot twice when the source tool
  //      (ShareX etc.) already wrote it to disk.
  //   2. Otherwise read the raw bitmap from the clipboard, save it as
  //      a PNG to ~/Pictures/Screenshots/strideterm-<timestamp>.png
  //      (created if missing) and return the new path.
  //   3. If neither path nor bitmap is in the clipboard, return
  //      { ok: false } so the renderer falls back to plain-text paste.
  ipcMain.handle("clipboard:paste-image", async () =>
    withOperationPromise({ opId: "clipboard:paste-image" }, async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- runtime payload type is open by design
      const settings = (runtime.getPayload() as any)?.appState?.settings || {};
      // Master switch — when off, defense-in-depth bail before we touch
      // the clipboard or the filesystem. The renderer also skips its
      // paste interception in this state, so a well-behaved client never
      // hits this handler; an old/buggy one still can't accidentally
      // write a PNG to disk.
      if (settings.clipboardImagePasteEnabled === false) {
        return { ok: false, reason: "disabled" };
      }

      const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".tif", ".tiff"]);

      function pathFromClipboard(): string | null {
        try {
          if (process.platform === "win32") {
            const buf = clipboard.readBuffer("CF_HDROP");
            if (!buf || buf.length < 20) return null;
            const offset = buf.readUInt32LE(0);
            const wide = buf.readUInt32LE(16) !== 0;
            const tail = buf.subarray(offset);
            const text = wide ? tail.toString("utf16le") : tail.toString("ascii");
            const first = text.split("\0").filter(Boolean)[0];
            return first || null;
          }
          if (process.platform === "darwin") {
            const buf = clipboard.readBuffer("public.file-url");
            if (!buf || buf.length === 0) return null;
            const url = buf.toString("utf8").trim();
            if (!url.startsWith("file:")) return null;
            return fileURLToPath(new URL(url));
          }
          const buf = clipboard.readBuffer("text/uri-list");
          if (!buf || buf.length === 0) return null;
          const first = buf
            .toString("utf8")
            .split("\n")
            .map((s) => s.trim())
            .find((s) => s && !s.startsWith("#"));
          if (!first || !first.startsWith("file:")) return null;
          return fileURLToPath(new URL(first));
        } catch {
          return null;
        }
      }

      const clipPath = pathFromClipboard();
      if (clipPath) {
        const ext = path.extname(clipPath).toLowerCase();
        if (IMAGE_EXTS.has(ext)) {
          try {
            const s = await stat(clipPath);
            if (s.isFile()) {
              return { ok: true, path: clipPath, source: "clipboard-path" };
            }
          } catch {
            // Path was in the clipboard but the file is gone — fall through to bitmap save.
          }
        }
      }

      const img = clipboard.readImage();
      if (img.isEmpty()) {
        return { ok: false, reason: "no-image" };
      }
      // Resolve the target directory. Honour `clipboardImagePasteDir` if
      // the user set it (with `~/` expansion for cross-platform comfort);
      // otherwise fall back to a sensible OS default — macOS users expect
      // screenshots on Desktop, Windows/Linux on Pictures/Screenshots.
      const configured =
        typeof settings.clipboardImagePasteDir === "string" ? settings.clipboardImagePasteDir.trim() : "";
      function osDefaultDir(): string {
        if (process.platform === "darwin") return path.join(homedir(), "Desktop");
        return path.join(homedir(), "Pictures", "Screenshots");
      }
      function expandHome(p: string): string {
        if (p === "~") return homedir();
        if (p.startsWith("~/") || p.startsWith("~\\")) return path.join(homedir(), p.slice(2));
        return p;
      }
      const dir = configured ? expandHome(configured) : osDefaultDir();
      try {
        await mkdir(dir, { recursive: true });
      } catch (err) {
        return { ok: false, reason: `mkdir-failed:${(err as Error)?.message || "unknown"}` };
      }
      // ISO-ish timestamp, filename-safe (no colons/dots).
      const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      const dest = path.join(dir, `strideterm-${ts}.png`);
      try {
        await writeFile(dest, img.toPNG());
      } catch (err) {
        return { ok: false, reason: `write-failed:${(err as Error)?.message || "unknown"}` };
      }
      return { ok: true, path: dest, source: "saved" };
    }),
  );
  ipcMain.handle("file:open-in-editor", async (_event, payload) =>
    withOperationPromise({ opId: "file:open-in-editor" }, async () => {
      const { absPath, editor } = payload || {};
      if (typeof absPath !== "string" || !absPath) return { ok: false, error: "Missing absPath" };
      // Defense in depth: even though this handler is renderer-only (the
      // remote-server stub returns 501), don't make it a free-form
      // command-execution primitive if the renderer is ever XSS'd. Allow
      // only bare command names — no path separators, no quotes, no shell
      // metacharacters that would let an attacker craft `editor=sh -c ...`.
      const rawEditor = typeof editor === "string" ? editor.trim() : "";
      let editorCmd = "";
      if (rawEditor) {
        if (!/^[A-Za-z0-9_+.-]+$/.test(rawEditor)) {
          return { ok: false, error: "Editor command must be a single bare program name (PATH-resolved)" };
        }
        editorCmd = rawEditor;
      }
      const { spawn } = await import("node:child_process");
      try {
        if (editorCmd) {
          spawn(editorCmd, [absPath], { detached: true, stdio: "ignore" }).unref();
        } else {
          // Fallback: open with OS default application
          await shell.openPath(absPath);
        }
        return { ok: true };
      } catch (err) {
        return { ok: false, error: (err as Error).message };
      }
    }),
  );
  ipcMain.handle("file:info", async (_event, payload) =>
    withOperationPromise({ opId: "file:info" }, async () => {
      const p = validateIpc(fileReadSchema, payload, "file:info");
      return fm.getFileInfo(p.rootPath, p.relativePath);
    }),
  );
  ipcMain.handle("file:git-status", async (_event, payload) =>
    withOperationPromise({ opId: "file:git-status" }, async () => {
      const p = validateIpc(fileGitStatusSchema, payload, "file:git-status");
      return fm.getGitFileStatus(p.rootPath, { includeIgnored: !!p.includeIgnored });
    }),
  );
  ipcMain.handle("file:git-refs", async (_event, payload) =>
    withOperationPromise({ opId: "file:git-refs" }, async () => {
      const p = validateIpc(fileGitRefsSchema, payload, "file:git-refs");
      return fm.getGitRefs(p.rootPath, p.relativePath || "");
    }),
  );
  ipcMain.handle("file:git-diff", async (_event, payload) =>
    withOperationPromise({ opId: "file:git-diff" }, async () => {
      const p = validateIpc(fileGitDiffSchema, payload, "file:git-diff");
      return fm.computeFileDiff(p.rootPath, p.relativePath, {
        source: p.source,
        revisionRef: p.revisionRef || "",
      });
    }),
  );

  ipcMain.handle("file:commit-files", async (_event, payload) =>
    withOperationPromise({ opId: "file:commit-files" }, async () => {
      const p = validateIpc(fileCommitFilesSchema, payload, "file:commit-files");
      return fm.getCommitFiles(p.rootPath, p.hash);
    }),
  );

  ipcMain.handle("file:commit-diff", async (_event, payload) =>
    withOperationPromise({ opId: "file:commit-diff" }, async () => {
      const p = validateIpc(fileCommitDiffSchema, payload, "file:commit-diff");
      return fm.computeCommitFileDiff(p.rootPath, p.relativePath, p.hash);
    }),
  );

  ipcMain.handle("dialog:browse-directory", async (event, defaultPath) =>
    withOperationPromise({ opId: "dialog:browse-directory" }, async () => {
      const win = BrowserWindow.fromWebContents(event.sender) ?? BrowserWindow.getFocusedWindow();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = await dialog.showOpenDialog(win as any, {
        properties: ["openDirectory"],
        defaultPath: defaultPath || undefined,
      });
      return result.canceled ? null : result.filePaths[0] || null;
    }),
  );

  ipcMain.handle(
    "dialog:browse-file",
    async (event, options: { defaultPath?: string; filters?: Electron.FileFilter[]; readContent?: boolean } = {}) =>
      withOperationPromise({ opId: "dialog:browse-file" }, async () => {
        const win = BrowserWindow.fromWebContents(event.sender) ?? BrowserWindow.getFocusedWindow();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const result = await dialog.showOpenDialog(win as any, {
          properties: ["openFile"],
          defaultPath: options.defaultPath || undefined,
          filters: options.filters || [],
        });
        const filePath = result.canceled ? null : result.filePaths[0] || null;
        // When the caller asks for the content, read it here. The user picked
        // the file via the native dialog, so it is intentionally NOT subject to
        // the workspace-root allow-list that gates file:read (a patch is
        // commonly opened from Downloads, outside any workspace).
        if (filePath && options.readContent) {
          const content = await readFile(filePath, "utf8");
          return { path: filePath, content };
        }
        return filePath;
      }),
  );

  ipcMain.handle(
    "dialog:save-file",
    async (event, options: { defaultPath?: string; filters?: Electron.FileFilter[]; content?: string } = {}) =>
      withOperationPromise({ opId: "dialog:save-file" }, async () => {
        const win = BrowserWindow.fromWebContents(event.sender) ?? BrowserWindow.getFocusedWindow();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const result = await dialog.showSaveDialog(win as any, {
          defaultPath: options.defaultPath || undefined,
          filters: options.filters || [],
        });
        if (result.canceled || !result.filePath) return null;
        // When the caller supplies `content`, write it to the chosen path here.
        // The user explicitly picked this destination via the native dialog, so
        // it is intentionally NOT subject to the workspace-root allow-list that
        // gates file:write (the patch is commonly saved to Downloads).
        if (typeof options.content === "string") {
          await writeFile(result.filePath, options.content, "utf8");
        }
        return result.filePath;
      }),
  );

  ipcMain.on("terminal:resize", (_event, sessionId, size) => {
    try {
      const validated = validateIpc(terminalResizeSchema, size, "terminal:resize");
      runtime.resizeSession(sessionId, validated);
    } catch {
      // Non-critical: silently ignore malformed resize events
    }
  });

  ipcMain.on("terminal:input", (event, sessionId, data) => {
    if (typeof sessionId === "string" && typeof data === "string") {
      // Pass the caller window as the viewer so the input lease can detect
      // two windows typing into the same PTY. A blocked write notifies the
      // sender, which shows the "Take control?" prompt.
      const windowId = getWindowIdByWebContentsId?.(event.sender.id) ?? "";
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = runtime.writeToSession(sessionId, data, windowId || undefined) as any;
      if (result?.blocked && windowId) {
        emitToWindow?.(windowId, "terminal:input-blocked", {
          sessionId,
          ownerLabel: String(result.ownerLabel || "another window"),
        });
      }
    }
  });

  ipcMain.handle("session:take-control", (event, sessionId) => {
    const windowId = getWindowIdByWebContentsId?.(event.sender.id) ?? "";
    return runtime.takeSessionControl(String(sessionId || ""), windowId);
  });

  // Renderer-side diagnostics (e.g. WebGL pre-flight result) routed into the
  // main-process logger. Validates inputs because the channel is exposed to
  // the renderer and could be flooded by a buggy/compromised page.
  const rendererLog = getLogger("renderer");
  ipcMain.on("log:renderer", (_event, level, message, meta) => {
    if (typeof message !== "string" || message.length === 0 || message.length > 4000) return;
    const safeMeta = meta && typeof meta === "object" && !Array.isArray(meta) ? (meta as Record<string, unknown>) : {};
    switch (level) {
      case "error":
        rendererLog.error(message, safeMeta);
        return;
      case "warn":
        rendererLog.warn(message, safeMeta);
        return;
      case "debug":
        rendererLog.debug(message, safeMeta);
        return;
      case "info":
      default:
        rendererLog.info(message, safeMeta);
    }
  });

  return () => {
    subscriptions.forEach((unsubscribe) => unsubscribe());
    if (includeStateGet) {
      ipcMain.removeHandler("state:get");
    }
    ipcMain.removeHandler("workspace:activate");
    ipcMain.removeHandler("project:activate");
    ipcMain.removeHandler("workspace:save");
    ipcMain.removeHandler("project:save");
    ipcMain.removeHandler("workspace:delete");
    ipcMain.removeHandler("project:delete");
    ipcMain.removeHandler("workspace:reorder");
    ipcMain.removeHandler("project:reorder");
    ipcMain.removeHandler("settings:update");
    ipcMain.removeHandler("azure:verify-connection");
    ipcMain.removeHandler("azure:save-connection");
    ipcMain.removeHandler("azure:delete-connection");
    ipcMain.removeHandler("azure:refresh");
    ipcMain.removeHandler("azure:audit-log:query");
    ipcMain.removeHandler("azure:audit-log:stats");
    ipcMain.removeHandler("azure:pull-request:seen");
    ipcMain.removeHandler("azure:pull-request:open");
    ipcMain.removeHandler("azure:pull-request:comment");
    ipcMain.removeHandler("azure:pull-request:thread-status");
    ipcMain.removeHandler("review-bridge:draft-comment:create");
    ipcMain.removeHandler("review-bridge:draft:save");
    ipcMain.removeHandler("review-bridge:draft:queue");
    ipcMain.removeHandler("review-bridge:draft:delete");
    ipcMain.removeHandler("review-bridge:comment:delete");
    ipcMain.removeHandler("review-bridge:comment:reply-with-changes");
    ipcMain.removeHandler("review-bridge:agent-prompt:save");
    ipcMain.removeHandler("review-bridge:agent-prompt:delete");
    ipcMain.removeHandler("review-bridge:pull-request:sync");
    ipcMain.removeHandler("review-bridge:pull-request:push-and-publish");
    ipcMain.removeHandler("ssh:hosts:list");
    ipcMain.removeHandler("ssh:hosts:create");
    ipcMain.removeHandler("ssh:hosts:update");
    ipcMain.removeHandler("ssh:hosts:delete");
    ipcMain.removeHandler("ssh:hosts:duplicate");
    ipcMain.removeHandler("ssh:hosts:test");
    ipcMain.removeHandler("ssh:keys:list");
    ipcMain.removeHandler("ssh:keys:import");
    ipcMain.removeHandler("ssh:keys:generate");
    ipcMain.removeHandler("ssh:keys:delete");
    ipcMain.removeHandler("ssh:certs:list");
    ipcMain.removeHandler("ssh:certs:import");
    ipcMain.removeHandler("ssh:certs:delete");
    ipcMain.removeHandler("ssh:auth:answer");
    ipcMain.removeHandler("ssh:auth:cancel");
    ipcMain.removeHandler("ssh:host-key:accept");
    ipcMain.removeHandler("ssh:host-key:reject");
    ipcMain.removeHandler("ssh:config:preview");
    ipcMain.removeHandler("ssh:config:import");
    ipcMain.removeHandler("ssh:known-hosts:import");
    ipcMain.removeHandler("azure:pull-request:vote");
    ipcMain.removeHandler("azure:workspace:fetch");
    ipcMain.removeHandler("azure:workspace:rebase");
    ipcMain.removeHandler("azure:workspace:push");
    ipcMain.removeHandler("azure:create-pull-request");
    ipcMain.removeHandler("azure:list-remote-branches");
    ipcMain.removeHandler("azure:quickfix:list-projects");
    ipcMain.removeHandler("azure:quickfix:list-repositories");
    ipcMain.removeHandler("azure:quickfix:list-branches");
    ipcMain.removeHandler("azure:quickfix:create");
    ipcMain.removeHandler("azure:rerun-check");
    ipcMain.removeHandler("github:verify-connection");
    ipcMain.removeHandler("github:save-connection");
    ipcMain.removeHandler("github:delete-connection");
    ipcMain.removeHandler("github:refresh");
    ipcMain.removeHandler("github:audit-log:query");
    ipcMain.removeHandler("github:audit-log:stats");
    ipcMain.removeHandler("github:pull-request:seen");
    ipcMain.removeHandler("github:pull-request:open");
    ipcMain.removeHandler("github:pull-request:comment");
    ipcMain.removeHandler("github:pull-request:review");
    ipcMain.removeHandler("github:rerun-check");
    ipcMain.removeHandler("github:workspace:fetch");
    ipcMain.removeHandler("github:workspace:rebase");
    ipcMain.removeHandler("github:workspace:push");
    ipcMain.removeHandler("github:list-remote-branches");
    ipcMain.removeHandler("github:create-pull-request");
    ipcMain.removeHandler("github:quickfix:list-repos");
    ipcMain.removeHandler("github:quickfix:list-branches");
    ipcMain.removeHandler("github:quickfix:create");
    ipcMain.removeHandler("telegram:verify-connection");
    ipcMain.removeHandler("telegram:detect-chats");
    ipcMain.removeHandler("telegram:save-connection");
    ipcMain.removeHandler("telegram:delete-connection");
    ipcMain.removeHandler("telegram:refresh");
    ipcMain.removeHandler("session:activate");
    ipcMain.removeHandler("workspace:set-ui-state");
    ipcMain.removeHandler("attention:sync");
    ipcMain.removeHandler("attention:clear-all");
    ipcMain.removeHandler("attention:clear-session");
    ipcMain.removeHandler("notifications:metrics");
    ipcMain.removeHandler("terminal:restart");
    ipcMain.removeHandler("terminal:close");
    ipcMain.removeHandler("terminal:replay");
    ipcMain.removeHandler("remote:token:regenerate");
    ipcMain.removeHandler("tunnel:refresh");
    ipcMain.removeHandler("tunnel:create");
    ipcMain.removeHandler("tunnel:stop");
    ipcMain.removeHandler("claude-hook:configure");
    ipcMain.removeHandler("claude-hook:remove");
    ipcMain.removeHandler("claude-hook:status");
    ipcMain.removeHandler("claude-hook:test");
    ipcMain.removeHandler("gemini-hook:configure");
    ipcMain.removeHandler("gemini-hook:remove");
    ipcMain.removeHandler("gemini-hook:status");
    ipcMain.removeHandler("gemini-hook:test");
    ipcMain.removeHandler("codex-hook:configure");
    ipcMain.removeHandler("codex-hook:remove");
    ipcMain.removeHandler("codex-hook:status");
    ipcMain.removeHandler("codex-hook:test");
    ipcMain.removeHandler("copilot-hook:configure");
    ipcMain.removeHandler("copilot-hook:remove");
    ipcMain.removeHandler("copilot-hook:status");
    ipcMain.removeHandler("copilot-hook:test");
    ipcMain.removeHandler("opencode-hook:configure");
    ipcMain.removeHandler("opencode-hook:remove");
    ipcMain.removeHandler("opencode-hook:status");
    ipcMain.removeHandler("opencode-hook:test");
    ipcMain.removeHandler("task:create-workspace");
    ipcMain.removeHandler("task:start");
    ipcMain.removeHandler("task:stop");
    ipcMain.removeHandler("task:pause");
    ipcMain.removeHandler("task:resume");
    ipcMain.removeHandler("task:reset");
    ipcMain.removeHandler("task:status");
    ipcMain.removeHandler("task-recovery:resolve");
    ipcMain.removeHandler("docker:refresh");
    ipcMain.removeHandler("git:refresh");
    ipcMain.removeHandler("git:fetch");
    ipcMain.removeHandler("git:pull");
    ipcMain.removeHandler("git:push");
    ipcMain.removeHandler("git:checkout-branch");
    ipcMain.removeHandler("git:create-branch");
    ipcMain.removeHandler("git:merge-into-current");
    ipcMain.removeHandler("git:rebase-onto");
    ipcMain.removeHandler("git:continue");
    ipcMain.removeHandler("git:abort");
    ipcMain.removeHandler("git:diff-preview");
    ipcMain.removeHandler("git:merge-into-base");
    ipcMain.removeHandler("git:remove-worktree");
    ipcMain.removeHandler("git:commit-all");
    ipcMain.removeHandler("git:stash");
    ipcMain.removeHandler("git:stash-pop");
    ipcMain.removeHandler("git:stash-list");
    ipcMain.removeHandler("git:stash-files");
    ipcMain.removeHandler("git:stash-file-diff");
    ipcMain.removeHandler("git:stash-apply");
    ipcMain.removeHandler("git:stash-drop");
    ipcMain.removeHandler("git:stash-branch");
    ipcMain.removeHandler("git:stash-export");
    ipcMain.removeHandler("git:stash-import");
    ipcMain.removeHandler("git:commit-diff");
    ipcMain.removeHandler("git:commit-info");
    ipcMain.removeHandler("git:log-page");
    ipcMain.removeHandler("docker:action");
    ipcMain.removeHandler("docker:open-session");
    ipcMain.removeHandler("docker:open-lazydocker");
    ipcMain.removeHandler("docker:logs:open");
    ipcMain.removeHandler("docker:logs:close");
    ipcMain.removeHandler("docker:logs:update");
    ipcMain.removeHandler("docker:compose-action");
    ipcMain.removeHandler("docker:inspect");
    ipcMain.removeHandler("docker:top");
    ipcMain.removeHandler("docker:stats");
    ipcMain.removeHandler("docker:shell:open");
    ipcMain.removeHandler("docker:shell:write");
    ipcMain.removeHandler("docker:shell:resize");
    ipcMain.removeHandler("docker:shell:close");
    ipcMain.removeHandler("docker:image:inspect");
    ipcMain.removeHandler("docker:volume:inspect");
    ipcMain.removeHandler("docker:network:inspect");
    ipcMain.removeHandler("docker:image:remove");
    ipcMain.removeHandler("docker:volume:remove");
    ipcMain.removeHandler("docker:network:remove");
    ipcMain.removeHandler("docker:image:pull");
    ipcMain.removeHandler("docker:image:prune");
    ipcMain.removeHandler("docker:volume:prune");
    ipcMain.removeHandler("docker:network:prune");
    ipcMain.removeHandler("docker:builder:prune");
    ipcMain.removeHandler("docker:system:df");
    ipcMain.removeHandler("docker:volume:list");
    ipcMain.removeHandler("docker:volume:read");
    ipcMain.removeHandler("git:open-lazygit");
    ipcMain.removeHandler("git:create-worktree");
    ipcMain.removeHandler("plugins:list");
    ipcMain.removeHandler("plugins:workspace-template");
    ipcMain.removeHandler("profile:save");
    ipcMain.removeHandler("profile:delete");
    ipcMain.removeHandler("profile:activate");
    ipcMain.removeHandler("session:take-control");
    ipcMain.removeHandler("notification:show-system");
    ipcMain.removeHandler("app:check-for-updates");
    ipcMain.removeHandler("app:check-command");
    ipcMain.removeHandler("file:list");
    ipcMain.removeHandler("file:tree");
    ipcMain.removeHandler("file:preview");
    ipcMain.removeHandler("file:read");
    ipcMain.removeHandler("file:write");
    ipcMain.removeHandler("file:create-file");
    ipcMain.removeHandler("file:create-dir");
    ipcMain.removeHandler("file:rename");
    ipcMain.removeHandler("file:delete");
    ipcMain.removeHandler("file:git-ignore");
    ipcMain.removeHandler("file:move");
    ipcMain.removeHandler("file:copy");
    ipcMain.removeHandler("file:open-in-explorer");
    ipcMain.removeHandler("file:clipboard-copy");
    ipcMain.removeHandler("clipboard:paste-image");
    ipcMain.removeHandler("file:open-in-editor");
    ipcMain.removeHandler("file:info");
    ipcMain.removeHandler("file:commit-files");
    ipcMain.removeHandler("file:commit-diff");
    ipcMain.removeHandler("dialog:browse-directory");
    ipcMain.removeHandler("dialog:browse-file");
    ipcMain.removeHandler("dialog:save-file");
    ipcMain.removeHandler("shell:open-external");
    ipcMain.removeHandler("terminal:open-path");
    ipcMain.removeHandler("task:recheck-claude");
    ipcMain.removeHandler("task:check-providers");
    ipcMain.removeHandler("task:check-git-repo");
    ipcMain.removeHandler("fs:probe-directory");
    ipcMain.removeHandler("task:reject-verdict");
    ipcMain.removeHandler("task:resend-instruction");
    ipcMain.removeHandler("git:list-tags");
    ipcMain.removeHandler("git:create-tag");
    ipcMain.removeHandler("git:delete-tag");
    ipcMain.removeHandler("git:push-tag");
    ipcMain.removeHandler("git:push-all-tags");
    ipcMain.removeHandler("git:delete-remote-tag");
    ipcMain.removeHandler("git:force-push-with-lease");
    ipcMain.removeHandler("file:git-status");
    ipcMain.removeHandler("file:git-refs");
    ipcMain.removeHandler("file:git-diff");
    ipcMain.removeHandler("review-bridge:agent-prompt:reset");
    ipcMain.removeAllListeners("terminal:resize");
    ipcMain.removeAllListeners("terminal:input");
    ipcMain.removeAllListeners("log:renderer");
  };
}
