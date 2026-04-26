/// <reference types="node" />
import { ipcMain, dialog, BrowserWindow, shell, Notification, app } from "electron";
import { join } from "node:path";
import type { createRuntime } from "./runtime.js";
import { withOperationPromise } from "./effect/runtime.js";
import * as fm from "./file-manager.js";
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
    ipcMain.handle("state:get", async () => runtime.getInitialState());
  }
  ipcMain.handle("shell:open-external", async (_event, url) => {
    if (typeof url === "string" && /^https?:\/\//i.test(url)) {
      return shell.openExternal(url);
    }
  });
  ipcMain.handle("workspace:activate", async (_event, workspaceId) => runtime.activateWorkspace(workspaceId));
  ipcMain.handle("project:activate", async (_event, projectId) => runtime.activateProject(projectId));
  ipcMain.handle("workspace:save", async (_event, workspace) =>
    runtime.saveWorkspace(validateIpc(workspaceSchema, workspace, "workspace:save")),
  );
  ipcMain.handle("project:save", async (_event, project) =>
    runtime.saveProject(validateIpc(projectSchema, project, "project:save")),
  );
  ipcMain.handle("workspace:delete", async (_event, workspaceId, options) =>
    runtime.deleteWorkspace(workspaceId, options || {}),
  );
  ipcMain.handle("project:delete", async (_event, projectId) => runtime.deleteProject(projectId));
  ipcMain.handle("workspace:reorder", async (_event, workspaceIds) =>
    runtime.reorderWorkspaces(validateIpc(workspaceReorderSchema, workspaceIds, "workspace:reorder")),
  );
  ipcMain.handle("project:reorder", async (_event, projectIds) =>
    runtime.reorderProjects(validateIpc(workspaceReorderSchema, projectIds, "project:reorder")),
  );
  ipcMain.handle("settings:update", async (_event, settings) => {
    const validated = validateIpc(settingsSchema, settings, "settings:update");
    const { payload, remoteAccessChanged } = await runtime.updateSettings(validated);
    return { payload, remoteAccessChanged };
  });
  ipcMain.handle("azure:verify-connection", async (_event, connection) =>
    runtime.verifyAzureConnection(validateIpc(azureConnectionSchema, connection, "azure:verify-connection")),
  );
  ipcMain.handle("azure:save-connection", async (_event, connection) =>
    runtime.saveAzureConnection(validateIpc(azureConnectionSchema, connection, "azure:save-connection")),
  );
  ipcMain.handle("azure:delete-connection", async (_event, connectionId) =>
    runtime.deleteAzureConnection(connectionId),
  );
  ipcMain.handle("azure:refresh", async () => runtime.refreshAzureState());
  ipcMain.handle("azure:audit-log:query", async (_event, payload) =>
    runtime.queryAzureAuditLog(validateIpc(azureAuditLogQuerySchema, payload, "azure:audit-log:query")),
  );
  ipcMain.handle("azure:audit-log:stats", async (_event, payload) =>
    runtime.getAzureAuditStats(validateIpc(azureAuditLogStatsSchema, payload, "azure:audit-log:stats")),
  );
  ipcMain.handle("azure:pull-request:seen", async (_event, prKey) => runtime.markAzurePullRequestSeen(prKey));
  ipcMain.handle("azure:pull-request:open", async (_event, payload) =>
    runtime.openAzurePullRequest(validateIpc(openPrSchema, payload, "azure:pull-request:open")),
  );
  ipcMain.handle("azure:pull-request:comment", async (_event, payload) =>
    runtime.commentAzurePullRequest(validateIpc(azureCommentSchema, payload, "azure:pull-request:comment")),
  );
  ipcMain.handle("azure:pull-request:thread-status", async (_event, payload) =>
    runtime.updateAzureThreadStatus(validateIpc(azureThreadStatusSchema, payload, "azure:pull-request:thread-status")),
  );
  ipcMain.handle("review-bridge:draft-comment:create", async (_event, payload) =>
    runtime.createReviewBridgeDraftComment(
      validateIpc(reviewBridgeDraftCommentSchema, payload, "review-bridge:draft-comment:create"),
    ),
  );
  ipcMain.handle("review-bridge:draft:save", async (_event, payload) =>
    runtime.saveReviewBridgeDraft(validateIpc(reviewBridgeDraftSchema, payload, "review-bridge:draft:save")),
  );
  ipcMain.handle("review-bridge:draft:queue", async (_event, payload) =>
    runtime.queueReviewBridgeDraft(validateIpc(reviewBridgeQueueSchema, payload, "review-bridge:draft:queue")),
  );
  ipcMain.handle("review-bridge:draft:delete", async (_event, payload) =>
    runtime.deleteReviewBridgeDraft(validateIpc(reviewBridgeDeleteDraftSchema, payload, "review-bridge:draft:delete")),
  );
  ipcMain.handle("review-bridge:comment:delete", async (_event, payload) =>
    runtime.deleteReviewBridgeComment(
      validateIpc(reviewBridgeDeleteCommentSchema, payload, "review-bridge:comment:delete"),
    ),
  );
  ipcMain.handle("review-bridge:comment:reply-with-changes", async (_event, payload) =>
    runtime.replyWithCodeChanges(
      validateIpc(reviewBridgeReplyWithChangesSchema, payload, "review-bridge:comment:reply-with-changes"),
    ),
  );
  ipcMain.handle("review-bridge:agent-prompt:save", async (_event, payload) =>
    runtime.saveAgentPrompt(validateIpc(agentPromptSaveSchema, payload, "review-bridge:agent-prompt:save")),
  );
  ipcMain.handle("review-bridge:agent-prompt:delete", async (_event, payload) =>
    runtime.deleteAgentPrompt(validateIpc(agentPromptDeleteSchema, payload, "review-bridge:agent-prompt:delete")),
  );
  ipcMain.handle("review-bridge:agent-prompt:reset", async () => runtime.resetAgentPrompts());
  ipcMain.handle("review-bridge:pull-request:sync", async (_event, payload) =>
    runtime.syncReviewBridgePullRequest(
      validateIpc(reviewBridgeSyncSchema, payload, "review-bridge:pull-request:sync"),
    ),
  );
  ipcMain.handle("review-bridge:pull-request:push-and-publish", async (_event, payload) =>
    runtime.pushAndPublishReview(
      validateIpc(reviewBridgePushAndPublishSchema, payload, "review-bridge:pull-request:push-and-publish"),
    ),
  );

  // --- SSH ---
  ipcMain.handle("ssh:hosts:list", async () => runtime["ssh:hosts:list"]());
  ipcMain.handle("ssh:hosts:create", async (_event, payload) => runtime["ssh:hosts:create"](payload));
  ipcMain.handle("ssh:hosts:update", async (_event, payload) => runtime["ssh:hosts:update"](payload));
  ipcMain.handle("ssh:hosts:delete", async (_event, payload) => runtime["ssh:hosts:delete"](payload));
  ipcMain.handle("ssh:hosts:duplicate", async (_event, payload) => runtime["ssh:hosts:duplicate"](payload));
  ipcMain.handle("ssh:hosts:test", async (_event, payload) => runtime["ssh:hosts:test"](payload));
  ipcMain.handle("ssh:keys:list", async () => runtime["ssh:keys:list"]());
  ipcMain.handle("ssh:keys:import", async (_event, payload) => runtime["ssh:keys:import"](payload));
  ipcMain.handle("ssh:keys:generate", async (_event, payload) => runtime["ssh:keys:generate"](payload));
  ipcMain.handle("ssh:keys:delete", async (_event, payload) => runtime["ssh:keys:delete"](payload));
  ipcMain.handle("ssh:certs:list", async () => runtime["ssh:certs:list"]());
  ipcMain.handle("ssh:certs:import", async (_event, payload) => runtime["ssh:certs:import"](payload));
  ipcMain.handle("ssh:certs:delete", async (_event, payload) => runtime["ssh:certs:delete"](payload));
  ipcMain.handle("ssh:auth:answer", async (_event, payload) => runtime["ssh:auth:answer"](payload));
  ipcMain.handle("ssh:auth:cancel", async (_event, payload) => runtime["ssh:auth:cancel"](payload));
  ipcMain.handle("ssh:host-key:accept", async (_event, payload) => runtime["ssh:host-key:accept"](payload));
  ipcMain.handle("ssh:host-key:reject", async (_event, payload) => runtime["ssh:host-key:reject"](payload));
  ipcMain.handle("ssh:config:preview", async (_event, payload) => runtime["ssh:config:preview"](payload));
  ipcMain.handle("ssh:config:import", async (_event, payload) => runtime["ssh:config:import"](payload));
  ipcMain.handle("ssh:known-hosts:import", async (_event, payload) => runtime["ssh:known-hosts:import"](payload));
  ipcMain.handle("azure:pull-request:vote", async (_event, payload) =>
    runtime.voteAzurePullRequest(validateIpc(azureVoteSchema, payload, "azure:pull-request:vote")),
  );
  ipcMain.handle("azure:workspace:fetch", async (_event, workspaceId) =>
    runtime.fetchAzureReviewWorkspace(workspaceId),
  );
  ipcMain.handle("azure:workspace:rebase", async (_event, workspaceId) =>
    runtime.rebaseAzureReviewWorkspace(workspaceId),
  );
  ipcMain.handle("azure:workspace:push", async (_event, workspaceId, options) =>
    runtime.pushAzureReviewWorkspace(
      workspaceId,
      validateIpc(workspacePushOptionsSchema, options || {}, "azure:workspace:push"),
    ),
  );
  ipcMain.handle("azure:create-pull-request", async (_event, payload) =>
    runtime.azureCreatePullRequest(validateIpc(gitPayloadSchema, payload, "azure:create-pull-request")),
  );
  ipcMain.handle("azure:list-remote-branches", async (_event, payload) =>
    runtime.azureListRemoteBranches(validateIpc(gitPayloadSchema, payload, "azure:list-remote-branches")),
  );
  ipcMain.handle("azure:quickfix:list-projects", async (_event, payload) =>
    runtime.azureQuickFixListProjects(validateIpc(quickFixListProjectsSchema, payload, "azure:quickfix:list-projects")),
  );
  ipcMain.handle("azure:quickfix:list-repositories", async (_event, payload) =>
    runtime.azureQuickFixListRepositories(
      validateIpc(quickFixListRepositoriesSchema, payload, "azure:quickfix:list-repositories"),
    ),
  );
  ipcMain.handle("azure:quickfix:list-branches", async (_event, payload) =>
    runtime.azureQuickFixListBranches(validateIpc(quickFixListBranchesSchema, payload, "azure:quickfix:list-branches")),
  );
  ipcMain.handle("azure:quickfix:create", async (_event, payload) =>
    runtime.azureQuickFixCreate(validateIpc(quickFixCreateSchema, payload, "azure:quickfix:create")),
  );
  ipcMain.handle("azure:rerun-check", async (_event, prKey, checkItem) => {
    const validated = validateIpc(rerunCheckSchema, { prKey, checkItem }, "azure:rerun-check");
    return runtime.rerunAzureCheck(validated.prKey, validated.checkItem);
  });

  // --- GitHub ---
  ipcMain.handle("github:verify-connection", async (_event, connection) =>
    runtime.verifyGitHubConnection(validateIpc(githubConnectionSchema, connection, "github:verify-connection")),
  );
  ipcMain.handle("github:save-connection", async (_event, connection) =>
    runtime.saveGitHubConnection(validateIpc(githubConnectionSchema, connection, "github:save-connection")),
  );
  ipcMain.handle("github:delete-connection", async (_event, connectionId) =>
    runtime.deleteGitHubConnection(connectionId),
  );
  ipcMain.handle("github:refresh", async () => runtime.refreshGitHubState());
  ipcMain.handle("github:audit-log:query", async (_event, payload) =>
    runtime.queryGitHubAuditLog(validateIpc(githubAuditLogQuerySchema, payload, "github:audit-log:query")),
  );
  ipcMain.handle("github:audit-log:stats", async (_event, payload) =>
    runtime.getGitHubAuditStats(validateIpc(githubAuditLogStatsSchema, payload, "github:audit-log:stats")),
  );
  ipcMain.handle("github:pull-request:seen", async (_event, prKey) => runtime.markGitHubPullRequestSeen(prKey));
  ipcMain.handle("github:pull-request:open", async (_event, payload) =>
    runtime.openGitHubPullRequest(validateIpc(openPrSchema, payload, "github:pull-request:open")),
  );
  ipcMain.handle("github:pull-request:comment", async (_event, payload) =>
    runtime.commentGitHubPullRequest(validateIpc(githubCommentSchema, payload, "github:pull-request:comment")),
  );
  ipcMain.handle("github:pull-request:review", async (_event, payload) =>
    runtime.submitGitHubPullRequestReview(validateIpc(githubReviewSchema, payload, "github:pull-request:review")),
  );
  ipcMain.handle("github:rerun-check", async (_event, prKey, checkItem) => {
    const validated = validateIpc(rerunCheckSchema, { prKey, checkItem }, "github:rerun-check");
    return runtime.rerunGitHubCheck(validated.prKey, validated.checkItem);
  });
  ipcMain.handle("github:workspace:fetch", async (_event, workspaceId) =>
    runtime.fetchGitHubReviewWorkspace(workspaceId),
  );
  ipcMain.handle("github:workspace:rebase", async (_event, workspaceId) =>
    runtime.rebaseGitHubReviewWorkspace(workspaceId),
  );
  ipcMain.handle("github:workspace:push", async (_event, workspaceId, options) =>
    runtime.pushGitHubReviewWorkspace(
      workspaceId,
      validateIpc(workspacePushOptionsSchema, options || {}, "github:workspace:push"),
    ),
  );
  ipcMain.handle("github:list-remote-branches", async (_event, payload) =>
    runtime.githubListRemoteBranches(validateIpc(gitPayloadSchema, payload, "github:list-remote-branches")),
  );
  ipcMain.handle("github:create-pull-request", async (_event, payload) =>
    runtime.githubCreatePullRequest(validateIpc(gitPayloadSchema, payload, "github:create-pull-request")),
  );
  ipcMain.handle("github:quickfix:list-repos", async (_event, payload) =>
    runtime.githubQuickFixListRepos(validateIpc(githubQuickFixListReposSchema, payload, "github:quickfix:list-repos")),
  );
  ipcMain.handle("github:quickfix:list-branches", async (_event, payload) =>
    runtime.githubQuickFixListBranches(
      validateIpc(githubQuickFixListBranchesSchema, payload, "github:quickfix:list-branches"),
    ),
  );
  ipcMain.handle("github:quickfix:create", async (_event, payload) =>
    runtime.githubQuickFixCreate(validateIpc(githubQuickFixCreateSchema, payload, "github:quickfix:create")),
  );

  ipcMain.handle("session:activate", async (_event, sessionId) => runtime.activateSession(sessionId));
  ipcMain.handle("workspace:set-ui-state", async (_event, workspaceId, uiState) => {
    const parsed = validateIpc(workspaceUIStateSchema, { workspaceId, uiState }, "workspace:set-ui-state");
    return runtime.setWorkspaceUIState(parsed.workspaceId, parsed.uiState);
  });
  ipcMain.handle("attention:sync", async (_event, payload) =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    runtime.syncAttentionContext(validateIpc(attentionSyncSchema, payload || {}, "attention:sync") as any),
  );
  ipcMain.handle("attention:clear-all", async () => runtime.clearAllAttention());
  ipcMain.handle("attention:clear-session", async (_event, sessionId, options) =>
    runtime.clearAlertForSession(String(sessionId || ""), {
      dismissed: options?.dismissed === true,
    }),
  );
  ipcMain.handle("terminal:restart", async (_event, sessionId) => runtime.restartSession(sessionId));
  ipcMain.handle("terminal:close", async (_event, sessionId) => runtime.closeSession(sessionId));
  ipcMain.handle("remote:token:regenerate", async () => runtime.regenerateRemoteToken());
  ipcMain.handle("tunnel:refresh", async () => runtime.refreshTunnelState());
  ipcMain.handle("tunnel:create", async () => runtime.createCloudflareTunnel());
  ipcMain.handle("tunnel:stop", async () => runtime.stopCloudflareTunnel());
  ipcMain.handle("claude-hook:configure", async () => runtime.configureClaudeHook());
  ipcMain.handle("claude-hook:remove", async () => runtime.removeClaudeHook());
  ipcMain.handle("claude-hook:status", async () => runtime.getClaudeHookStatus());
  ipcMain.handle("claude-hook:test", async () => runtime.testClaudeHook());
  ipcMain.handle("gemini-hook:configure", async () => runtime.configureGeminiHook());
  ipcMain.handle("gemini-hook:remove", async () => runtime.removeGeminiHook());
  ipcMain.handle("gemini-hook:status", async () => runtime.getGeminiHookStatus());
  ipcMain.handle("gemini-hook:test", async () => runtime.testGeminiHook());
  ipcMain.handle("codex-hook:configure", async () => runtime.configureCodexHook());
  ipcMain.handle("codex-hook:remove", async () => runtime.removeCodexHook());
  ipcMain.handle("codex-hook:status", async () => runtime.getCodexHookStatus());
  ipcMain.handle("codex-hook:test", async () => runtime.testCodexHook());
  ipcMain.handle("copilot-hook:configure", async () => runtime.configureCopilotHook());
  ipcMain.handle("copilot-hook:remove", async () => runtime.removeCopilotHook());
  ipcMain.handle("copilot-hook:status", async () => runtime.getCopilotHookStatus());
  ipcMain.handle("copilot-hook:test", async () => runtime.testCopilotHook());
  ipcMain.handle("notifications:metrics", async () => runtime.getNotificationMetrics());

  // --- Task runner ---
  ipcMain.handle("task:recheck-claude", async () => runtime.recheckClaude());
  ipcMain.handle("task:check-providers", async () => runtime.checkProviders());
  ipcMain.handle("task:check-git-repo", async (_event, cwd) => runtime.checkIsGitRepo(String(cwd || "")));
  ipcMain.handle("fs:probe-directory", async (_event, cwd) => runtime.probeDirectory(String(cwd || "")));
  ipcMain.handle("task:create-workspace", async (_event, payload) =>
    runtime.createTaskWorkspace(validateIpc(taskWorkspaceCreateSchema, payload, "task:create-workspace")),
  );
  ipcMain.handle("task:start", async (_event, payload) =>
    runtime.startTask(validateIpc(taskWorkspaceActionSchema, payload, "task:start").workspaceId),
  );
  ipcMain.handle("task:stop", async (_event, payload) =>
    runtime.stopTask(validateIpc(taskWorkspaceActionSchema, payload, "task:stop").workspaceId),
  );
  ipcMain.handle("task:pause", async (_event, payload) =>
    runtime.pauseTask(validateIpc(taskWorkspaceActionSchema, payload, "task:pause").workspaceId),
  );
  ipcMain.handle("task:resume", async (_event, payload) =>
    runtime.resumeTask(validateIpc(taskWorkspaceActionSchema, payload, "task:resume").workspaceId),
  );
  ipcMain.handle("task:reset", async (_event, payload) =>
    runtime.resetTask(validateIpc(taskWorkspaceActionSchema, payload, "task:reset").workspaceId),
  );
  ipcMain.handle("task:reject-verdict", async (_event, payload) => {
    const parsed = validateIpc(taskRejectVerdictSchema, payload, "task:reject-verdict");
    return runtime.rejectTaskVerdict(parsed.workspaceId, parsed.feedback);
  });
  ipcMain.handle("task:status", async (_event, workspaceId) => runtime.getTaskStatus(workspaceId));
  ipcMain.handle("docker:refresh", async () => runtime.refreshDockerState());
  ipcMain.handle("git:refresh", async (_event, projectId) => runtime.refreshGitState(projectId));
  ipcMain.handle("git:fetch", async (_event, payload) => {
    const p = validateIpc(gitPayloadSchema, payload, "git:fetch");
    return withOperationPromise({ workspaceId: p.workspaceId, opId: crypto.randomUUID() }, () => runtime.gitFetch(p));
  });
  ipcMain.handle("git:pull", async (_event, payload) => {
    const p = validateIpc(gitPayloadSchema, payload, "git:pull");
    return withOperationPromise({ workspaceId: p.workspaceId, opId: crypto.randomUUID() }, () => runtime.gitPull(p));
  });
  ipcMain.handle("git:push", async (_event, payload) => {
    const p = validateIpc(gitPayloadSchema, payload, "git:push");
    return withOperationPromise({ workspaceId: p.workspaceId, opId: crypto.randomUUID() }, () => runtime.gitPush(p));
  });
  ipcMain.handle("git:checkout-branch", async (_event, payload) =>
    runtime.gitCheckoutBranch(validateIpc(gitPayloadSchema, payload, "git:checkout-branch")),
  );
  ipcMain.handle("git:create-branch", async (_event, payload) =>
    runtime.gitCreateBranch(validateIpc(gitPayloadSchema, payload, "git:create-branch")),
  );
  ipcMain.handle("git:merge-into-current", async (_event, payload) => {
    const p = validateIpc(gitPayloadSchema, payload, "git:merge-into-current");
    return withOperationPromise({ workspaceId: p.workspaceId, opId: crypto.randomUUID() }, () => runtime.gitMergeIntoCurrent(p));
  });
  ipcMain.handle("git:rebase-onto", async (_event, payload) => {
    const p = validateIpc(gitPayloadSchema, payload, "git:rebase-onto");
    return withOperationPromise({ workspaceId: p.workspaceId, opId: crypto.randomUUID() }, () => runtime.gitRebaseOnto(p));
  });
  ipcMain.handle("git:continue", async (_event, payload) =>
    runtime.gitContinueOperation(validateIpc(gitPayloadSchema, payload, "git:continue")),
  );
  ipcMain.handle("git:abort", async (_event, payload) =>
    runtime.gitAbortOperation(validateIpc(gitPayloadSchema, payload, "git:abort")),
  );
  ipcMain.handle("git:diff-preview", async (_event, payload) =>
    runtime.gitDiffPreview(validateIpc(gitDiffPreviewSchema, payload, "git:diff-preview")),
  );
  ipcMain.handle("git:merge-into-base", async (_event, payload) =>
    runtime.gitMergeCurrentIntoBase(validateIpc(gitPayloadSchema, payload, "git:merge-into-base")),
  );
  ipcMain.handle("git:remove-worktree", async (_event, payload) =>
    runtime.gitRemoveWorktree(validateIpc(removeWorktreeSchema, payload, "git:remove-worktree")),
  );
  ipcMain.handle("git:commit-all", async (_event, payload) =>
    runtime.gitCommitAll(validateIpc(gitCommitSchema, payload, "git:commit-all")),
  );
  ipcMain.handle("git:stash", async (_event, payload) =>
    runtime.gitStash(validateIpc(gitPayloadSchema, payload, "git:stash")),
  );
  ipcMain.handle("git:stash-pop", async (_event, payload) =>
    runtime.gitStashPop(validateIpc(gitPayloadSchema, payload, "git:stash-pop")),
  );
  ipcMain.handle("git:commit-diff", async (_event, payload) =>
    runtime.gitCommitDiff(validateIpc(gitPayloadSchema, payload, "git:commit-diff")),
  );
  ipcMain.handle("git:list-tags", async (_event, payload) =>
    runtime.gitListTags(validateIpc(gitPayloadSchema, payload, "git:list-tags")),
  );
  ipcMain.handle("git:create-tag", async (_event, payload) =>
    runtime.gitCreateTag(validateIpc(gitTagSchema, payload, "git:create-tag")),
  );
  ipcMain.handle("git:delete-tag", async (_event, payload) =>
    runtime.gitDeleteTag(validateIpc(gitTagSchema, payload, "git:delete-tag")),
  );
  ipcMain.handle("git:push-tag", async (_event, payload) =>
    runtime.gitPushTag(validateIpc(gitTagSchema, payload, "git:push-tag")),
  );
  ipcMain.handle("git:push-all-tags", async (_event, payload) =>
    runtime.gitPushAllTags(validateIpc(gitPayloadSchema, payload, "git:push-all-tags")),
  );
  ipcMain.handle("git:delete-remote-tag", async (_event, payload) =>
    runtime.gitDeleteRemoteTag(validateIpc(gitTagSchema, payload, "git:delete-remote-tag")),
  );
  ipcMain.handle("git:force-push-with-lease", async (_event, payload) =>
    runtime.gitForcePushWithLease(validateIpc(gitPayloadSchema, payload, "git:force-push-with-lease")),
  );
  ipcMain.handle("docker:action", async (_event, action, containerId) => {
    const validated = validateIpc(dockerActionSchema, { action, containerId }, "docker:action");
    return runtime.dockerAction(validated.action, validated.containerId);
  });
  ipcMain.handle("docker:open-session", async (_event, payload) =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    runtime.openDockerSession(validateIpc(dockerSessionSchema, payload, "docker:open-session") as any),
  );
  ipcMain.handle("docker:open-lazydocker", async (_event, payload) =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    runtime.openLazydockerSession(validateIpc(gitPayloadSchema, payload, "docker:open-lazydocker") as any),
  );
  ipcMain.handle("git:open-lazygit", async (_event, payload) =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    runtime.openLazygitSession(validateIpc(gitPayloadSchema, payload, "git:open-lazygit") as any),
  );
  ipcMain.handle("git:create-worktree", async (_event, payload) =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    runtime.createWorktree(validateIpc(worktreeSchema, payload, "git:create-worktree") as any),
  );
  ipcMain.handle("plugins:list", async () => runtime.getPlugins());
  ipcMain.handle("plugins:workspace-template", async (_event, pluginId) =>
    runtime.getPluginWorkspaceTemplate(pluginId),
  );
  ipcMain.handle("profile:save", async (_event, profile) =>
    runtime.saveProfile(validateIpc(profileSchema, profile, "profile:save")),
  );
  ipcMain.handle("profile:delete", async (_event, profileId) => runtime.deleteProfile(profileId));
  ipcMain.handle("profile:activate", async (_event, profileId) => runtime.activateProfile(profileId));

  ipcMain.handle("notification:show-system", async (_event, payload) => {
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
  });

  ipcMain.handle("app:check-for-updates", async () => runtime.checkForUpdates());
  ipcMain.handle("app:check-command", async (_event, command) => runtime.checkCommand(command));

  // --- File manager ---
  ipcMain.handle("file:list", async (_event, payload) => {
    const p = validateIpc(fileListSchema, payload, "file:list");
    return fm.listDirectory(p.rootPath, p.relativePath);
  });
  ipcMain.handle("file:tree", async (_event, payload) => {
    const p = validateIpc(fileListSchema, payload, "file:tree");
    return fm.getDirectoryTree(p.rootPath, p.relativePath);
  });
  ipcMain.handle("file:preview", async (_event, payload) => {
    const p = validateIpc(fileReadSchema, payload, "file:preview");
    return fm.readFilePreview(p.rootPath, p.relativePath);
  });
  ipcMain.handle("file:read", async (_event, payload) => {
    const p = validateIpc(fileReadSchema, payload, "file:read");
    return fm.readFileContent(p.rootPath, p.relativePath);
  });
  ipcMain.handle("file:write", async (_event, payload) => {
    const p = validateIpc(fileWriteSchema, payload, "file:write");
    return fm.writeFileContent(p.rootPath, p.relativePath, p.content);
  });
  ipcMain.handle("file:create-file", async (_event, payload) => {
    const p = validateIpc(fileCreateSchema, payload, "file:create-file");
    return fm.createFile(p.rootPath, p.parentPath, p.name);
  });
  ipcMain.handle("file:create-dir", async (_event, payload) => {
    const p = validateIpc(fileCreateSchema, payload, "file:create-dir");
    return fm.createDirectory(p.rootPath, p.parentPath, p.name);
  });
  ipcMain.handle("file:rename", async (_event, payload) => {
    const p = validateIpc(fileRenameSchema, payload, "file:rename");
    return fm.renameEntry(p.rootPath, p.relativePath, p.newName);
  });
  ipcMain.handle("file:delete", async (_event, payload) => {
    const p = validateIpc(fileDeleteSchema, payload, "file:delete");
    return fm.deleteEntry(p.rootPath, p.relativePath);
  });
  ipcMain.handle("file:move", async (_event, payload) => {
    const p = validateIpc(fileMoveSchema, payload, "file:move");
    return fm.moveEntry(p.rootPath, p.fromPath, p.toPath);
  });
  ipcMain.handle("file:copy", async (_event, payload) => {
    const p = validateIpc(fileMoveSchema, payload, "file:copy");
    return fm.copyEntry(p.rootPath, p.fromPath, p.toPath);
  });
  ipcMain.handle("file:open-in-explorer", async (_event, absPath) => {
    if (typeof absPath === "string") shell.showItemInFolder(absPath);
  });
  ipcMain.handle("file:open-in-editor", async (_event, payload) => {
    const { absPath, editor } = payload || {};
    if (typeof absPath !== "string" || !absPath) return { ok: false, error: "Missing absPath" };
    const editorCmd = (typeof editor === "string" && editor.trim()) || "";
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
  });
  ipcMain.handle("file:info", async (_event, payload) => {
    const p = validateIpc(fileReadSchema, payload, "file:info");
    return fm.getFileInfo(p.rootPath, p.relativePath);
  });
  ipcMain.handle("file:git-status", async (_event, payload) => {
    const p = validateIpc(fileGitStatusSchema, payload, "file:git-status");
    return fm.getGitFileStatus(p.rootPath, { includeIgnored: !!p.includeIgnored });
  });
  ipcMain.handle("file:git-refs", async (_event, payload) => {
    const p = validateIpc(fileGitRefsSchema, payload, "file:git-refs");
    return fm.getGitRefs(p.rootPath, p.relativePath || "");
  });
  ipcMain.handle("file:git-diff", async (_event, payload) => {
    const p = validateIpc(fileGitDiffSchema, payload, "file:git-diff");
    return fm.computeFileDiff(p.rootPath, p.relativePath, {
      source: p.source,
      revisionRef: p.revisionRef || "",
    });
  });

  ipcMain.handle("file:commit-files", async (_event, payload) => {
    const p = validateIpc(fileCommitFilesSchema, payload, "file:commit-files");
    return fm.getCommitFiles(p.rootPath, p.hash);
  });

  ipcMain.handle("file:commit-diff", async (_event, payload) => {
    const p = validateIpc(fileCommitDiffSchema, payload, "file:commit-diff");
    return fm.computeCommitFileDiff(p.rootPath, p.relativePath, p.hash);
  });

  ipcMain.handle("dialog:browse-directory", async (_event, defaultPath) => {
    const win = BrowserWindow.getFocusedWindow();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await dialog.showOpenDialog(win as any, {
      properties: ["openDirectory"],
      defaultPath: defaultPath || undefined,
    });
    return result.canceled ? null : result.filePaths[0] || null;
  });

  ipcMain.handle("dialog:browse-file", async (_event, options: { defaultPath?: string; filters?: Electron.FileFilter[] } = {}) => {
    const win = BrowserWindow.getFocusedWindow();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await dialog.showOpenDialog(win as any, {
      properties: ["openFile"],
      defaultPath: options.defaultPath || undefined,
      filters: options.filters || [],
    });
    return result.canceled ? null : result.filePaths[0] || null;
  });

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
    ipcMain.removeHandler("task:create-workspace");
    ipcMain.removeHandler("task:start");
    ipcMain.removeHandler("task:stop");
    ipcMain.removeHandler("task:pause");
    ipcMain.removeHandler("task:resume");
    ipcMain.removeHandler("task:reset");
    ipcMain.removeHandler("task:status");
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
    ipcMain.removeAllListeners("terminal:resize");
    ipcMain.removeAllListeners("terminal:input");
  };
}
