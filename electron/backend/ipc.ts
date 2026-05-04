/// <reference types="node" />
import { ipcMain, dialog, BrowserWindow, shell, Notification, app } from "electron";
import { join } from "node:path";
import type { createRuntime } from "./runtime.js";
import { withOperationPromise } from "./effect/runtime.js";
import * as fm from "./file-manager.js";
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
  fileMoveSchema,
  fileGitStatusSchema,
  fileGitRefsSchema,
  fileGitDiffSchema,
  fileCommitFilesSchema,
  fileCommitDiffSchema,
  gitPayloadSchema,
  gitDiffPreviewSchema,
  gitLogPageSchema,
  gitCommitSchema,
  gitTagSchema,
  dockerActionSchema,
  dockerSessionSchema,
  terminalResizeSchema,
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
  taskRecoveryResolveSchema,
  telegramConnectionSchema,
} from "./ipc-schemas.js";

type Runtime = Awaited<ReturnType<typeof createRuntime>>;

export function registerIpc(
  runtime: Runtime,
  emitToRenderer: (channel: string, payload: unknown) => void,
  { includeStateGet = true }: { includeStateGet?: boolean } = {},
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
      if (typeof url === "string" && /^https?:\/\//i.test(url)) {
        return shell.openExternal(url);
      }
    }),
  );
  ipcMain.handle("workspace:activate", async (_event, workspaceId) =>
    withOperationPromise({ workspaceId: String(workspaceId || ""), opId: "workspace:activate" }, () =>
      runtime.activateWorkspace(workspaceId),
    ),
  );
  ipcMain.handle("project:activate", async (_event, projectId) =>
    withOperationPromise({ opId: "project:activate" }, () => runtime.activateProject(projectId)),
  );
  ipcMain.handle("workspace:save", async (_event, workspace) =>
    withOperationPromise({ opId: "workspace:save" }, () =>
      runtime.saveWorkspace(validateIpc(workspaceSchema, workspace, "workspace:save")),
    ),
  );
  ipcMain.handle("project:save", async (_event, project) =>
    withOperationPromise({ opId: "project:save" }, () =>
      runtime.saveProject(validateIpc(projectSchema, project, "project:save")),
    ),
  );
  ipcMain.handle("workspace:delete", async (_event, workspaceId, options) =>
    withOperationPromise({ workspaceId: String(workspaceId || ""), opId: "workspace:delete" }, () =>
      runtime.deleteWorkspace(workspaceId, options || {}),
    ),
  );
  ipcMain.handle("project:delete", async (_event, projectId) =>
    withOperationPromise({ opId: "project:delete" }, () => runtime.deleteProject(projectId)),
  );
  ipcMain.handle("workspace:reorder", async (_event, workspaceIds) =>
    withOperationPromise({ opId: "workspace:reorder" }, () =>
      runtime.reorderWorkspaces(validateIpc(workspaceReorderSchema, workspaceIds, "workspace:reorder")),
    ),
  );
  ipcMain.handle("project:reorder", async (_event, projectIds) =>
    withOperationPromise({ opId: "project:reorder" }, () =>
      runtime.reorderProjects(validateIpc(workspaceReorderSchema, projectIds, "project:reorder")),
    ),
  );
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
  ipcMain.handle("azure:save-connection", async (_event, connection) =>
    withOperationPromise({ opId: "azure:save-connection" }, () =>
      runtime.saveAzureConnection(validateIpc(azureConnectionSchema, connection, "azure:save-connection")),
    ),
  );
  ipcMain.handle("azure:delete-connection", async (_event, connectionId) =>
    withOperationPromise({ opId: "azure:delete-connection" }, () => runtime.deleteAzureConnection(connectionId)),
  );
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
  ipcMain.handle("azure:pull-request:open", async (_event, payload) =>
    withOperationPromise({ opId: "azure:pull-request:open" }, () =>
      runtime.openAzurePullRequest(validateIpc(openPrSchema, payload, "azure:pull-request:open")),
    ),
  );
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
  ipcMain.handle("review-bridge:draft-comment:create", async (_event, payload) =>
    withOperationPromise({ opId: "review-bridge:draft-comment:create" }, () =>
      runtime.createReviewBridgeDraftComment(
        validateIpc(reviewBridgeDraftCommentSchema, payload, "review-bridge:draft-comment:create"),
      ),
    ),
  );
  ipcMain.handle("review-bridge:draft:save", async (_event, payload) =>
    withOperationPromise({ opId: "review-bridge:draft:save" }, () =>
      runtime.saveReviewBridgeDraft(validateIpc(reviewBridgeDraftSchema, payload, "review-bridge:draft:save")),
    ),
  );
  ipcMain.handle("review-bridge:draft:queue", async (_event, payload) =>
    withOperationPromise({ opId: "review-bridge:draft:queue" }, () =>
      runtime.queueReviewBridgeDraft(validateIpc(reviewBridgeQueueSchema, payload, "review-bridge:draft:queue")),
    ),
  );
  ipcMain.handle("review-bridge:draft:delete", async (_event, payload) =>
    withOperationPromise({ opId: "review-bridge:draft:delete" }, () =>
      runtime.deleteReviewBridgeDraft(
        validateIpc(reviewBridgeDeleteDraftSchema, payload, "review-bridge:draft:delete"),
      ),
    ),
  );
  ipcMain.handle("review-bridge:comment:delete", async (_event, payload) =>
    withOperationPromise({ opId: "review-bridge:comment:delete" }, () =>
      runtime.deleteReviewBridgeComment(
        validateIpc(reviewBridgeDeleteCommentSchema, payload, "review-bridge:comment:delete"),
      ),
    ),
  );
  ipcMain.handle("review-bridge:comment:reply-with-changes", async (_event, payload) =>
    withOperationPromise({ opId: "review-bridge:comment:reply-with-changes" }, () =>
      runtime.replyWithCodeChanges(
        validateIpc(reviewBridgeReplyWithChangesSchema, payload, "review-bridge:comment:reply-with-changes"),
      ),
    ),
  );
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
  ipcMain.handle("review-bridge:pull-request:push-and-publish", async (_event, payload) =>
    withOperationPromise({ opId: "review-bridge:pull-request:push-and-publish" }, () =>
      runtime.pushAndPublishReview(
        validateIpc(reviewBridgePushAndPublishSchema, payload, "review-bridge:pull-request:push-and-publish"),
      ),
    ),
  );

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
  ipcMain.handle("azure:quickfix:create", async (_event, payload) =>
    withOperationPromise({ opId: "azure:quickfix:create" }, () =>
      runtime.azureQuickFixCreate(validateIpc(quickFixCreateSchema, payload, "azure:quickfix:create")),
    ),
  );
  ipcMain.handle("azure:rerun-check", async (_event, prKey, checkItem) =>
    withOperationPromise({ opId: "azure:rerun-check" }, async () => {
      const validated = validateIpc(rerunCheckSchema, { prKey, checkItem }, "azure:rerun-check");
      return runtime.rerunAzureCheck(validated.prKey, validated.checkItem);
    }),
  );

  // --- GitHub ---
  ipcMain.handle("github:verify-connection", async (_event, connection) =>
    withOperationPromise({ opId: "github:verify-connection" }, () =>
      runtime.verifyGitHubConnection(validateIpc(githubConnectionSchema, connection, "github:verify-connection")),
    ),
  );
  ipcMain.handle("github:save-connection", async (_event, connection) =>
    withOperationPromise({ opId: "github:save-connection" }, () =>
      runtime.saveGitHubConnection(validateIpc(githubConnectionSchema, connection, "github:save-connection")),
    ),
  );
  ipcMain.handle("github:delete-connection", async (_event, connectionId) =>
    withOperationPromise({ opId: "github:delete-connection" }, () => runtime.deleteGitHubConnection(connectionId)),
  );
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
  ipcMain.handle("github:pull-request:open", async (_event, payload) =>
    withOperationPromise({ opId: "github:pull-request:open" }, () =>
      runtime.openGitHubPullRequest(validateIpc(openPrSchema, payload, "github:pull-request:open")),
    ),
  );
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
  ipcMain.handle("github:quickfix:create", async (_event, payload) =>
    withOperationPromise({ opId: "github:quickfix:create" }, () =>
      runtime.githubQuickFixCreate(validateIpc(githubQuickFixCreateSchema, payload, "github:quickfix:create")),
    ),
  );

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

  ipcMain.handle("session:activate", async (_event, sessionId) =>
    withOperationPromise({ opId: "session:activate" }, () => runtime.activateSession(sessionId)),
  );
  ipcMain.handle("workspace:set-ui-state", async (_event, workspaceId, uiState) =>
    withOperationPromise({ workspaceId: String(workspaceId || ""), opId: "workspace:set-ui-state" }, async () => {
      const parsed = validateIpc(workspaceUIStateSchema, { workspaceId, uiState }, "workspace:set-ui-state");
      return runtime.setWorkspaceUIState(parsed.workspaceId, parsed.uiState);
    }),
  );
  ipcMain.handle("attention:sync", async (_event, payload) =>
    withOperationPromise({ opId: "attention:sync" }, () =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      runtime.syncAttentionContext(validateIpc(attentionSyncSchema, payload || {}, "attention:sync") as any),
    ),
  );
  ipcMain.handle("attention:clear-all", async () =>
    withOperationPromise({ opId: "attention:clear-all" }, () => runtime.clearAllAttention()),
  );
  ipcMain.handle("attention:clear-session", async (_event, sessionId, options) =>
    withOperationPromise({ opId: "attention:clear-session" }, () =>
      runtime.clearAlertForSession(String(sessionId || ""), {
        dismissed: options?.dismissed === true,
      }),
    ),
  );
  ipcMain.handle("terminal:restart", async (_event, sessionId) =>
    withOperationPromise({ opId: "terminal:restart" }, () => runtime.restartSession(sessionId)),
  );
  ipcMain.handle("terminal:close", async (_event, sessionId) =>
    withOperationPromise({ opId: "terminal:close" }, () => runtime.closeSession(sessionId)),
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
  ipcMain.handle("task:create-workspace", async (_event, payload) =>
    withOperationPromise({ opId: "task:create-workspace" }, () =>
      runtime.createTaskWorkspace(validateIpc(taskWorkspaceCreateSchema, payload, "task:create-workspace")),
    ),
  );
  ipcMain.handle("task:start", async (_event, payload) => {
    const p = validateIpc(taskWorkspaceActionSchema, payload, "task:start");
    return withOperationPromise({ workspaceId: p.workspaceId, opId: "task:start" }, () =>
      runtime.startTask(p.workspaceId),
    );
  });
  ipcMain.handle("task:stop", async (_event, payload) => {
    const p = validateIpc(taskWorkspaceActionSchema, payload, "task:stop");
    return withOperationPromise({ workspaceId: p.workspaceId, opId: "task:stop" }, () =>
      runtime.stopTask(p.workspaceId),
    );
  });
  ipcMain.handle("task:pause", async (_event, payload) => {
    const p = validateIpc(taskWorkspaceActionSchema, payload, "task:pause");
    return withOperationPromise({ workspaceId: p.workspaceId, opId: "task:pause" }, () =>
      runtime.pauseTask(p.workspaceId),
    );
  });
  ipcMain.handle("task:resume", async (_event, payload) => {
    const p = validateIpc(taskWorkspaceActionSchema, payload, "task:resume");
    return withOperationPromise({ workspaceId: p.workspaceId, opId: "task:resume" }, () =>
      runtime.resumeTask(p.workspaceId),
    );
  });
  ipcMain.handle("task:reset", async (_event, payload) => {
    const p = validateIpc(taskWorkspaceActionSchema, payload, "task:reset");
    return withOperationPromise({ workspaceId: p.workspaceId, opId: "task:reset" }, () =>
      runtime.resetTask(p.workspaceId),
    );
  });
  ipcMain.handle("task:reject-verdict", async (_event, payload) =>
    withOperationPromise({ opId: "task:reject-verdict" }, async () => {
      const parsed = validateIpc(taskRejectVerdictSchema, payload, "task:reject-verdict");
      return runtime.rejectTaskVerdict(parsed.workspaceId, parsed.feedback);
    }),
  );
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
  ipcMain.handle("docker:action", async (_event, action, containerId) =>
    withOperationPromise({ opId: "docker:action" }, async () => {
      const validated = validateIpc(dockerActionSchema, { action, containerId }, "docker:action");
      return runtime.dockerAction(validated.action, validated.containerId);
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
  ipcMain.handle("git:open-lazygit", async (_event, payload) =>
    withOperationPromise({ opId: "git:open-lazygit" }, () =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      runtime.openLazygitSession(validateIpc(gitPayloadSchema, payload, "git:open-lazygit") as any),
    ),
  );
  ipcMain.handle("git:create-worktree", async (_event, payload) =>
    withOperationPromise({ opId: "git:create-worktree" }, () =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      runtime.createWorktree(validateIpc(worktreeSchema, payload, "git:create-worktree") as any),
    ),
  );
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
  ipcMain.handle("profile:delete", async (_event, profileId) =>
    withOperationPromise({ opId: "profile:delete" }, () => runtime.deleteProfile(profileId)),
  );
  ipcMain.handle("profile:activate", async (_event, profileId) =>
    withOperationPromise({ opId: "profile:activate" }, () => runtime.activateProfile(profileId)),
  );

  ipcMain.handle("notification:show-system", async (_event, payload) =>
    withOperationPromise({ opId: "notification:show-system" }, async () => {
      if (!Notification.isSupported()) return;
      const validated = validateIpc(notificationShowSchema, payload || {}, "notification:show-system");
      const urgent = validated.urgency === "urgent" || validated.requireInteraction === true;
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
        const win = BrowserWindow.getAllWindows()[0];
        if (win) {
          if (win.isMinimized()) win.restore();
          win.focus();
        }
      });
      notif.show();
      // Extra attention for urgent: flash taskbar until the window gets focus.
      if (urgent) {
        const win = BrowserWindow.getAllWindows()[0];
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
  ipcMain.handle("file:open-in-explorer", async (_event, absPath) =>
    withOperationPromise({ opId: "file:open-in-explorer" }, async () => {
      if (typeof absPath === "string") shell.showItemInFolder(absPath);
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

  ipcMain.handle("dialog:browse-directory", async (_event, defaultPath) =>
    withOperationPromise({ opId: "dialog:browse-directory" }, async () => {
      const win = BrowserWindow.getFocusedWindow();
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
    async (_event, options: { defaultPath?: string; filters?: Electron.FileFilter[] } = {}) =>
      withOperationPromise({ opId: "dialog:browse-file" }, async () => {
        const win = BrowserWindow.getFocusedWindow();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const result = await dialog.showOpenDialog(win as any, {
          properties: ["openFile"],
          defaultPath: options.defaultPath || undefined,
          filters: options.filters || [],
        });
        return result.canceled ? null : result.filePaths[0] || null;
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

  ipcMain.on("terminal:input", (_event, sessionId, data) => {
    if (typeof sessionId === "string" && typeof data === "string") {
      runtime.writeToSession(sessionId, data);
    }
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
    ipcMain.removeHandler("git:commit-diff");
    ipcMain.removeHandler("git:commit-info");
    ipcMain.removeHandler("git:log-page");
    ipcMain.removeHandler("docker:action");
    ipcMain.removeHandler("docker:open-session");
    ipcMain.removeHandler("docker:open-lazydocker");
    ipcMain.removeHandler("git:open-lazygit");
    ipcMain.removeHandler("git:create-worktree");
    ipcMain.removeHandler("plugins:list");
    ipcMain.removeHandler("plugins:workspace-template");
    ipcMain.removeHandler("profile:save");
    ipcMain.removeHandler("profile:delete");
    ipcMain.removeHandler("profile:activate");
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
    ipcMain.removeHandler("file:move");
    ipcMain.removeHandler("file:copy");
    ipcMain.removeHandler("file:open-in-explorer");
    ipcMain.removeHandler("file:open-in-editor");
    ipcMain.removeHandler("file:info");
    ipcMain.removeHandler("file:commit-files");
    ipcMain.removeHandler("file:commit-diff");
    ipcMain.removeHandler("dialog:browse-directory");
    ipcMain.removeHandler("dialog:browse-file");
    ipcMain.removeHandler("shell:open-external");
    ipcMain.removeHandler("task:recheck-claude");
    ipcMain.removeHandler("task:check-providers");
    ipcMain.removeHandler("task:check-git-repo");
    ipcMain.removeHandler("fs:probe-directory");
    ipcMain.removeHandler("task:reject-verdict");
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
