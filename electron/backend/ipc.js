import { ipcMain, dialog, BrowserWindow, shell, Notification, app } from "electron";
import { join } from "node:path";
import * as fm from "./file-manager.js";
import {
  validateIpc,
  workspaceSchema,
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
  gitPayloadSchema,
  gitDiffPreviewSchema,
  gitCommitSchema,
  dockerSessionSchema,
  terminalResizeSchema,
  profileSchema,
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
} from "./ipc-schemas.js";

export function registerIpc(runtime, emitToRenderer, { includeStateGet = true } = {}) {
  const subscriptions = [
    runtime.on("state:updated", (payload) => emitToRenderer("state:updated", payload)),
    runtime.on("terminal:data", (payload) => emitToRenderer("terminal:data", payload)),
    runtime.on("terminal:exit", (payload) => emitToRenderer("terminal:exit", payload)),
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
  ipcMain.handle("workspace:save", async (_event, workspace) => runtime.saveWorkspace(validateIpc(workspaceSchema, workspace, "workspace:save")));
  ipcMain.handle("project:save", async (_event, project) => runtime.saveProject(validateIpc(projectSchema, project, "project:save")));
  ipcMain.handle("workspace:delete", async (_event, workspaceId, options) => runtime.deleteWorkspace(workspaceId, options));
  ipcMain.handle("project:delete", async (_event, projectId) => runtime.deleteProject(projectId));
  ipcMain.handle("workspace:reorder", async (_event, workspaceIds) => runtime.reorderWorkspaces(workspaceIds));
  ipcMain.handle("project:reorder", async (_event, projectIds) => runtime.reorderProjects(projectIds));
  ipcMain.handle("settings:update", async (_event, settings) => {
    const validated = validateIpc(settingsSchema, settings, "settings:update");
    const { payload, remoteAccessChanged } = await runtime.updateSettings(validated);
    return { payload, remoteAccessChanged };
  });
  ipcMain.handle("azure:verify-connection", async (_event, connection) => runtime.verifyAzureConnection(validateIpc(azureConnectionSchema, connection, "azure:verify-connection")));
  ipcMain.handle("azure:save-connection", async (_event, connection) => runtime.saveAzureConnection(validateIpc(azureConnectionSchema, connection, "azure:save-connection")));
  ipcMain.handle("azure:delete-connection", async (_event, connectionId) => runtime.deleteAzureConnection(connectionId));
  ipcMain.handle("azure:refresh", async () => runtime.refreshAzureState());
  ipcMain.handle("azure:audit-log:query", async (_event, payload) => runtime.queryAzureAuditLog(validateIpc(azureAuditLogQuerySchema, payload, "azure:audit-log:query")));
  ipcMain.handle("azure:audit-log:stats", async (_event, payload) => runtime.getAzureAuditStats(validateIpc(azureAuditLogStatsSchema, payload, "azure:audit-log:stats")));
  ipcMain.handle("azure:pull-request:seen", async (_event, prKey) => runtime.markAzurePullRequestSeen(prKey));
  ipcMain.handle("azure:pull-request:open", async (_event, payload) => runtime.openAzurePullRequest(validateIpc(openPrSchema, payload, "azure:pull-request:open")));
  ipcMain.handle("azure:pull-request:comment", async (_event, payload) => runtime.commentAzurePullRequest(validateIpc(azureCommentSchema, payload, "azure:pull-request:comment")));
  ipcMain.handle("azure:pull-request:thread-status", async (_event, payload) => runtime.updateAzureThreadStatus(validateIpc(azureThreadStatusSchema, payload, "azure:pull-request:thread-status")));
  ipcMain.handle("review-bridge:draft-comment:create", async (_event, payload) => runtime.createReviewBridgeDraftComment(validateIpc(reviewBridgeDraftCommentSchema, payload, "review-bridge:draft-comment:create")));
  ipcMain.handle("review-bridge:draft:save", async (_event, payload) => runtime.saveReviewBridgeDraft(validateIpc(reviewBridgeDraftSchema, payload, "review-bridge:draft:save")));
  ipcMain.handle("review-bridge:draft:queue", async (_event, payload) => runtime.queueReviewBridgeDraft(validateIpc(reviewBridgeQueueSchema, payload, "review-bridge:draft:queue")));
  ipcMain.handle("review-bridge:draft:delete", async (_event, payload) => runtime.deleteReviewBridgeDraft(validateIpc(reviewBridgeDeleteDraftSchema, payload, "review-bridge:draft:delete")));
  ipcMain.handle("review-bridge:comment:delete", async (_event, payload) => runtime.deleteReviewBridgeComment(validateIpc(reviewBridgeDeleteCommentSchema, payload, "review-bridge:comment:delete")));
  ipcMain.handle("review-bridge:comment:reply-with-changes", async (_event, payload) => runtime.replyWithCodeChanges(validateIpc(reviewBridgeReplyWithChangesSchema, payload, "review-bridge:comment:reply-with-changes")));
  ipcMain.handle("review-bridge:agent-prompt:save", async (_event, payload) => runtime.saveAgentPrompt(validateIpc(agentPromptSaveSchema, payload, "review-bridge:agent-prompt:save")));
  ipcMain.handle("review-bridge:agent-prompt:delete", async (_event, payload) => runtime.deleteAgentPrompt(validateIpc(agentPromptDeleteSchema, payload, "review-bridge:agent-prompt:delete")));
  ipcMain.handle("review-bridge:agent-prompt:reset", async () => runtime.resetAgentPrompts());
  ipcMain.handle("review-bridge:pull-request:sync", async (_event, payload) => runtime.syncReviewBridgePullRequest(validateIpc(reviewBridgeSyncSchema, payload, "review-bridge:pull-request:sync")));
  ipcMain.handle("review-bridge:pull-request:push-and-publish", async (_event, payload) => runtime.pushAndPublishReview(validateIpc(reviewBridgePushAndPublishSchema, payload, "review-bridge:pull-request:push-and-publish")));
  ipcMain.handle("azure:pull-request:vote", async (_event, payload) => runtime.voteAzurePullRequest(validateIpc(azureVoteSchema, payload, "azure:pull-request:vote")));
  ipcMain.handle("azure:workspace:fetch", async (_event, workspaceId) => runtime.fetchAzureReviewWorkspace(workspaceId));
  ipcMain.handle("azure:workspace:rebase", async (_event, workspaceId) => runtime.rebaseAzureReviewWorkspace(workspaceId));
  ipcMain.handle("azure:workspace:push", async (_event, workspaceId, options) => runtime.pushAzureReviewWorkspace(workspaceId, options));
  ipcMain.handle("azure:create-pull-request", async (_event, payload) => runtime.azureCreatePullRequest(validateIpc(gitPayloadSchema, payload, "azure:create-pull-request")));
  ipcMain.handle("azure:list-remote-branches", async (_event, payload) => runtime.azureListRemoteBranches(validateIpc(gitPayloadSchema, payload, "azure:list-remote-branches")));
  ipcMain.handle("azure:quickfix:list-projects", async (_event, payload) => runtime.azureQuickFixListProjects(validateIpc(quickFixListProjectsSchema, payload, "azure:quickfix:list-projects")));
  ipcMain.handle("azure:quickfix:list-repositories", async (_event, payload) => runtime.azureQuickFixListRepositories(validateIpc(quickFixListRepositoriesSchema, payload, "azure:quickfix:list-repositories")));
  ipcMain.handle("azure:quickfix:list-branches", async (_event, payload) => runtime.azureQuickFixListBranches(validateIpc(quickFixListBranchesSchema, payload, "azure:quickfix:list-branches")));
  ipcMain.handle("azure:quickfix:create", async (_event, payload) => runtime.azureQuickFixCreate(validateIpc(quickFixCreateSchema, payload, "azure:quickfix:create")));

  // --- GitHub ---
  ipcMain.handle("github:verify-connection", async (_event, connection) => runtime.verifyGitHubConnection(validateIpc(githubConnectionSchema, connection, "github:verify-connection")));
  ipcMain.handle("github:save-connection", async (_event, connection) => runtime.saveGitHubConnection(validateIpc(githubConnectionSchema, connection, "github:save-connection")));
  ipcMain.handle("github:delete-connection", async (_event, connectionId) => runtime.deleteGitHubConnection(connectionId));
  ipcMain.handle("github:refresh", async () => runtime.refreshGitHubState());
  ipcMain.handle("github:audit-log:query", async (_event, payload) => runtime.queryGitHubAuditLog(validateIpc(githubAuditLogQuerySchema, payload, "github:audit-log:query")));
  ipcMain.handle("github:audit-log:stats", async (_event, payload) => runtime.getGitHubAuditStats(validateIpc(githubAuditLogStatsSchema, payload, "github:audit-log:stats")));
  ipcMain.handle("github:pull-request:seen", async (_event, prKey) => runtime.markGitHubPullRequestSeen(prKey));
  ipcMain.handle("github:pull-request:open", async (_event, payload) => runtime.openGitHubPullRequest(validateIpc(openPrSchema, payload, "github:pull-request:open")));
  ipcMain.handle("github:pull-request:comment", async (_event, payload) => runtime.commentGitHubPullRequest(validateIpc(githubCommentSchema, payload, "github:pull-request:comment")));
  ipcMain.handle("github:pull-request:review", async (_event, payload) => runtime.submitGitHubPullRequestReview(validateIpc(githubReviewSchema, payload, "github:pull-request:review")));
  ipcMain.handle("github:workspace:fetch", async (_event, workspaceId) => runtime.fetchGitHubReviewWorkspace(workspaceId));
  ipcMain.handle("github:workspace:rebase", async (_event, workspaceId) => runtime.rebaseGitHubReviewWorkspace(workspaceId));
  ipcMain.handle("github:workspace:push", async (_event, workspaceId, options) => runtime.pushGitHubReviewWorkspace(workspaceId, options));

  ipcMain.handle("session:activate", async (_event, sessionId) => runtime.activateSession(sessionId));
  ipcMain.handle("attention:sync", async (_event, payload) => runtime.syncAttentionContext(payload));
  ipcMain.handle("attention:clear-all", async () => runtime.clearAllAttention());
  ipcMain.handle("terminal:restart", async (_event, sessionId) => runtime.restartSession(sessionId));
  ipcMain.handle("terminal:close", async (_event, sessionId) => runtime.closeSession(sessionId));
  ipcMain.handle("remote:token:regenerate", async () => runtime.regenerateRemoteToken());
  ipcMain.handle("tunnel:refresh", async () => runtime.refreshTunnelState());
  ipcMain.handle("tunnel:create", async () => runtime.createCloudflareTunnel());
  ipcMain.handle("tunnel:stop", async () => runtime.stopCloudflareTunnel());
  ipcMain.handle("docker:refresh", async () => runtime.refreshDockerState());
  ipcMain.handle("git:refresh", async (_event, projectId) => runtime.refreshGitState(projectId));
  ipcMain.handle("git:fetch", async (_event, payload) => runtime.gitFetch(validateIpc(gitPayloadSchema, payload, "git:fetch")));
  ipcMain.handle("git:push", async (_event, payload) => runtime.gitPush(validateIpc(gitPayloadSchema, payload, "git:push")));
  ipcMain.handle("git:checkout-branch", async (_event, payload) => runtime.gitCheckoutBranch(validateIpc(gitPayloadSchema, payload, "git:checkout-branch")));
  ipcMain.handle("git:create-branch", async (_event, payload) => runtime.gitCreateBranch(validateIpc(gitPayloadSchema, payload, "git:create-branch")));
  ipcMain.handle("git:merge-into-current", async (_event, payload) => runtime.gitMergeIntoCurrent(validateIpc(gitPayloadSchema, payload, "git:merge-into-current")));
  ipcMain.handle("git:rebase-onto", async (_event, payload) => runtime.gitRebaseOnto(validateIpc(gitPayloadSchema, payload, "git:rebase-onto")));
  ipcMain.handle("git:continue", async (_event, payload) => runtime.gitContinueOperation(validateIpc(gitPayloadSchema, payload, "git:continue")));
  ipcMain.handle("git:abort", async (_event, payload) => runtime.gitAbortOperation(validateIpc(gitPayloadSchema, payload, "git:abort")));
  ipcMain.handle("git:diff-preview", async (_event, payload) => runtime.gitDiffPreview(validateIpc(gitDiffPreviewSchema, payload, "git:diff-preview")));
  ipcMain.handle("git:merge-into-base", async (_event, payload) => runtime.gitMergeCurrentIntoBase(validateIpc(gitPayloadSchema, payload, "git:merge-into-base")));
  ipcMain.handle("git:remove-worktree", async (_event, payload) => runtime.gitRemoveWorktree(validateIpc(removeWorktreeSchema, payload, "git:remove-worktree")));
  ipcMain.handle("git:commit-all", async (_event, payload) => runtime.gitCommitAll(validateIpc(gitCommitSchema, payload, "git:commit-all")));
  ipcMain.handle("git:stash", async (_event, payload) => runtime.gitStash(validateIpc(gitPayloadSchema, payload, "git:stash")));
  ipcMain.handle("git:stash-pop", async (_event, payload) => runtime.gitStashPop(validateIpc(gitPayloadSchema, payload, "git:stash-pop")));
  ipcMain.handle("git:commit-diff", async (_event, payload) => runtime.gitCommitDiff(validateIpc(gitPayloadSchema, payload, "git:commit-diff")));
  ipcMain.handle("docker:action", async (_event, action, containerId) => runtime.dockerAction(action, containerId));
  ipcMain.handle("docker:open-session", async (_event, payload) => runtime.openDockerSession(validateIpc(dockerSessionSchema, payload, "docker:open-session")));
  ipcMain.handle("docker:open-lazydocker", async (_event, payload) => runtime.openLazydockerSession(validateIpc(gitPayloadSchema, payload, "docker:open-lazydocker")));
  ipcMain.handle("git:open-lazygit", async (_event, payload) => runtime.openLazygitSession(validateIpc(gitPayloadSchema, payload, "git:open-lazygit")));
  ipcMain.handle("git:create-worktree", async (_event, payload) => runtime.createWorktree(validateIpc(worktreeSchema, payload, "git:create-worktree")));
  ipcMain.handle("plugins:list", async () => runtime.getPlugins());
  ipcMain.handle("plugins:workspace-template", async (_event, pluginId) => runtime.getPluginWorkspaceTemplate(pluginId));
  ipcMain.handle("profile:save", async (_event, profile) => runtime.saveProfile(validateIpc(profileSchema, profile, "profile:save")));
  ipcMain.handle("profile:delete", async (_event, profileId) => runtime.deleteProfile(profileId));
  ipcMain.handle("profile:activate", async (_event, profileId) => runtime.activateProfile(profileId));

  ipcMain.handle("notification:show-system", async (_event, payload) => {
    if (!Notification.isSupported()) return;
    const notif = new Notification({
      title: payload?.title || "strIDEterm",
      body: payload?.body || "",
      icon: join(app.getAppPath(), "assets", "icon.png"),
    });
    notif.on("click", () => {
      const win = BrowserWindow.getAllWindows()[0];
      if (win) {
        if (win.isMinimized()) win.restore();
        win.focus();
      }
    });
    notif.show();
  });

  // --- File manager ---
  ipcMain.handle("file:list", async (_event, payload) => { const p = validateIpc(fileListSchema, payload, "file:list"); return fm.listDirectory(p.rootPath, p.relativePath); });
  ipcMain.handle("file:tree", async (_event, payload) => { const p = validateIpc(fileListSchema, payload, "file:tree"); return fm.getDirectoryTree(p.rootPath, p.relativePath); });
  ipcMain.handle("file:preview", async (_event, payload) => { const p = validateIpc(fileReadSchema, payload, "file:preview"); return fm.readFilePreview(p.rootPath, p.relativePath); });
  ipcMain.handle("file:read", async (_event, payload) => { const p = validateIpc(fileReadSchema, payload, "file:read"); return fm.readFileContent(p.rootPath, p.relativePath); });
  ipcMain.handle("file:write", async (_event, payload) => { const p = validateIpc(fileWriteSchema, payload, "file:write"); return fm.writeFileContent(p.rootPath, p.relativePath, p.content); });
  ipcMain.handle("file:create-file", async (_event, payload) => { const p = validateIpc(fileCreateSchema, payload, "file:create-file"); return fm.createFile(p.rootPath, p.parentPath, p.name); });
  ipcMain.handle("file:create-dir", async (_event, payload) => { const p = validateIpc(fileCreateSchema, payload, "file:create-dir"); return fm.createDirectory(p.rootPath, p.parentPath, p.name); });
  ipcMain.handle("file:rename", async (_event, payload) => { const p = validateIpc(fileRenameSchema, payload, "file:rename"); return fm.renameEntry(p.rootPath, p.relativePath, p.newName); });
  ipcMain.handle("file:delete", async (_event, payload) => { const p = validateIpc(fileDeleteSchema, payload, "file:delete"); return fm.deleteEntry(p.rootPath, p.relativePath); });
  ipcMain.handle("file:move", async (_event, payload) => { const p = validateIpc(fileMoveSchema, payload, "file:move"); return fm.moveEntry(p.rootPath, p.fromPath, p.toPath); });
  ipcMain.handle("file:copy", async (_event, payload) => { const p = validateIpc(fileMoveSchema, payload, "file:copy"); return fm.copyEntry(p.rootPath, p.fromPath, p.toPath); });
  ipcMain.handle("file:open-in-explorer", async (_event, absPath) => { if (typeof absPath === "string") shell.showItemInFolder(absPath); });
  ipcMain.handle("file:info", async (_event, payload) => { const p = validateIpc(fileReadSchema, payload, "file:info"); return fm.getFileInfo(p.rootPath, p.relativePath); });

  ipcMain.handle("dialog:browse-directory", async (_event, defaultPath) => {
    const win = BrowserWindow.getFocusedWindow();
    const result = await dialog.showOpenDialog(win, {
      properties: ["openDirectory"],
      defaultPath: defaultPath || undefined,
    });
    return result.canceled ? null : result.filePaths[0] || null;
  });

  ipcMain.handle("dialog:browse-file", async (_event, options = {}) => {
    const win = BrowserWindow.getFocusedWindow();
    const result = await dialog.showOpenDialog(win, {
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
    runtime.writeToSession(sessionId, data);
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
    ipcMain.removeHandler("github:workspace:fetch");
    ipcMain.removeHandler("github:workspace:rebase");
    ipcMain.removeHandler("github:workspace:push");
    ipcMain.removeHandler("session:activate");
    ipcMain.removeHandler("attention:sync");
    ipcMain.removeHandler("attention:clear-all");
    ipcMain.removeHandler("terminal:restart");
    ipcMain.removeHandler("terminal:close");
    ipcMain.removeHandler("remote:token:regenerate");
    ipcMain.removeHandler("tunnel:refresh");
    ipcMain.removeHandler("tunnel:create");
    ipcMain.removeHandler("tunnel:stop");
    ipcMain.removeHandler("docker:refresh");
    ipcMain.removeHandler("git:refresh");
    ipcMain.removeHandler("git:fetch");
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
    ipcMain.removeHandler("file:info");
    ipcMain.removeHandler("dialog:browse-directory");
    ipcMain.removeHandler("dialog:browse-file");
    ipcMain.removeHandler("shell:open-external");
    ipcMain.removeAllListeners("terminal:resize");
    ipcMain.removeAllListeners("terminal:input");
  };
}
