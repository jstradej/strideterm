/**
 * Factory for Git operation API handlers.
 * Extracted from runtime.js to reduce file size.
 */
export function createGitHandlers(ctx) {
  const {
    git,
    store,
    getPayload,
    resolveGitWorkspace,
    resolveGitConnection,
    resolveGitRootPath,
    runGitWorkspaceAction,
    syncWorktrees,
  } = ctx;

  function resolveRootPath(workspace, rawRootPath) {
    const validated = resolveGitRootPath(workspace, rawRootPath || "");
    if (rawRootPath && !validated) throw new Error(`Root path not found in workspace gitRoots: ${rawRootPath}`);
    return validated || "";
  }

  return {
    async refreshGitState(projectId = null) {
      await ctx.refreshGit(projectId);
      ctx.broadcastState();
      return getPayload();
    },
    async gitFetch(payload = {}) {
      const workspace = resolveGitWorkspace(payload.workspaceId, payload.projectId);
      const connection = resolveGitConnection(workspace);
      const rootPath = resolveRootPath(workspace, payload.rootPath);
      return runGitWorkspaceAction(workspace, git.fetch(workspace, { connection, rootPath }));
    },
    async gitPull(payload = {}) {
      const workspace = resolveGitWorkspace(payload.workspaceId, payload.projectId);
      const connection = resolveGitConnection(workspace);
      const rootPath = resolveRootPath(workspace, payload.rootPath);
      return runGitWorkspaceAction(workspace, git.pull(workspace, { connection, rootPath }));
    },
    async gitPush(payload = {}) {
      const workspace = resolveGitWorkspace(payload.workspaceId, payload.projectId);
      const connection = resolveGitConnection(workspace);
      const rootPath = resolveRootPath(workspace, payload.rootPath);
      return runGitWorkspaceAction(workspace, git.push(workspace, { connection, rootPath }));
    },
    async gitCheckoutBranch(payload = {}) {
      const workspace = resolveGitWorkspace(payload.workspaceId, payload.projectId);
      const rootPath = resolveRootPath(workspace, payload.rootPath);
      return runGitWorkspaceAction(workspace, git.checkoutBranch(workspace, { ...payload, rootPath }));
    },
    async gitCreateBranch(payload = {}) {
      const workspace = resolveGitWorkspace(payload.workspaceId, payload.projectId);
      const rootPath = resolveRootPath(workspace, payload.rootPath);
      return runGitWorkspaceAction(workspace, git.createBranch(workspace, { ...payload, rootPath }));
    },
    async gitMergeIntoCurrent(payload = {}) {
      const workspace = resolveGitWorkspace(payload.workspaceId, payload.projectId);
      const rootPath = resolveRootPath(workspace, payload.rootPath);
      return runGitWorkspaceAction(workspace, git.mergeIntoCurrent(workspace, { ...payload, rootPath }));
    },
    async gitRebaseOnto(payload = {}) {
      const workspace = resolveGitWorkspace(payload.workspaceId, payload.projectId);
      const rootPath = resolveRootPath(workspace, payload.rootPath);
      return runGitWorkspaceAction(workspace, git.rebaseOnto(workspace, { ...payload, rootPath }));
    },
    async gitContinueOperation(payload = {}) {
      const workspace = resolveGitWorkspace(payload.workspaceId, payload.projectId);
      const rootPath = resolveRootPath(workspace, payload.rootPath);
      return runGitWorkspaceAction(workspace, git.continueOperation(workspace, { rootPath }));
    },
    async gitAbortOperation(payload = {}) {
      const workspace = resolveGitWorkspace(payload.workspaceId, payload.projectId);
      const rootPath = resolveRootPath(workspace, payload.rootPath);
      return runGitWorkspaceAction(workspace, git.abortOperation(workspace, { rootPath }));
    },
    async gitDiffPreview(payload = {}) {
      const workspace = resolveGitWorkspace(payload.workspaceId, payload.projectId);
      const rootPath = resolveRootPath(workspace, payload.rootPath);
      return git.diffPreview(workspace, { ...payload, rootPath });
    },
    async gitMergeCurrentIntoBase(payload = {}) {
      const workspace = resolveGitWorkspace(payload.workspaceId, payload.projectId);
      const rootPath = resolveRootPath(workspace, payload.rootPath);
      const actionResult = await runGitWorkspaceAction(
        workspace,
        git.mergeCurrentIntoBase(workspace, { ...payload, rootPath }),
      );
      if (actionResult.result?.ok) {
        await store.mutate((draft) => {
          const ws = draft.workspaces.find((w) => w.id === workspace.id);
          if (ws) ws.branchMerged = true;
        });
        actionResult.payload = getPayload();
      }
      return actionResult;
    },
    async gitRemoveWorktree(payload = {}) {
      const workspace = resolveGitWorkspace(payload.workspaceId, payload.projectId);
      const rootPath = resolveRootPath(workspace, payload.rootPath);
      const result = await git.removeWorktree(workspace, { ...payload, rootPath });
      await syncWorktrees();
      return { payload: getPayload(), result };
    },
    async gitCommitAll(payload = {}) {
      const workspace = resolveGitWorkspace(payload.workspaceId, payload.projectId);
      const rootPath = resolveRootPath(workspace, payload.rootPath);
      return runGitWorkspaceAction(workspace, git.commitAll(workspace, { ...payload, rootPath }));
    },
    async gitStash(payload = {}) {
      const workspace = resolveGitWorkspace(payload.workspaceId, payload.projectId);
      const rootPath = resolveRootPath(workspace, payload.rootPath);
      return runGitWorkspaceAction(workspace, git.stash(workspace, { ...payload, rootPath }));
    },
    async gitStashPop(payload = {}) {
      const workspace = resolveGitWorkspace(payload.workspaceId, payload.projectId);
      const rootPath = resolveRootPath(workspace, payload.rootPath);
      return runGitWorkspaceAction(workspace, git.stashPop(workspace, { rootPath }));
    },
    async gitCommitDiff(payload = {}) {
      const workspace = resolveGitWorkspace(payload.workspaceId, payload.projectId);
      const rootPath = resolveRootPath(workspace, payload.rootPath);
      return git.commitDiff(workspace, { ...payload, rootPath });
    },
    async gitListTags(payload = {}) {
      const workspace = resolveGitWorkspace(payload.workspaceId, payload.projectId);
      const connection = resolveGitConnection(workspace);
      const rootPath = resolveRootPath(workspace, payload.rootPath);
      return git.listTags(workspace, { connection, rootPath });
    },
    async gitCreateTag(payload = {}) {
      const workspace = resolveGitWorkspace(payload.workspaceId, payload.projectId);
      const rootPath = resolveRootPath(workspace, payload.rootPath);
      return runGitWorkspaceAction(workspace, git.createTag(workspace, { ...payload, rootPath }));
    },
    async gitDeleteTag(payload = {}) {
      const workspace = resolveGitWorkspace(payload.workspaceId, payload.projectId);
      const rootPath = resolveRootPath(workspace, payload.rootPath);
      return runGitWorkspaceAction(workspace, git.deleteTag(workspace, { ...payload, rootPath }));
    },
    async gitPushTag(payload = {}) {
      const workspace = resolveGitWorkspace(payload.workspaceId, payload.projectId);
      const connection = resolveGitConnection(workspace);
      const rootPath = resolveRootPath(workspace, payload.rootPath);
      return runGitWorkspaceAction(workspace, git.pushTag(workspace, { ...payload, connection, rootPath }));
    },
    async gitPushAllTags(payload = {}) {
      const workspace = resolveGitWorkspace(payload.workspaceId, payload.projectId);
      const connection = resolveGitConnection(workspace);
      const rootPath = resolveRootPath(workspace, payload.rootPath);
      return runGitWorkspaceAction(workspace, git.pushAllTags(workspace, { connection, rootPath }));
    },
    async gitDeleteRemoteTag(payload = {}) {
      const workspace = resolveGitWorkspace(payload.workspaceId, payload.projectId);
      const connection = resolveGitConnection(workspace);
      const rootPath = resolveRootPath(workspace, payload.rootPath);
      return runGitWorkspaceAction(workspace, git.deleteRemoteTag(workspace, { ...payload, connection, rootPath }));
    },
    async gitForcePushWithLease(payload = {}) {
      const workspace = resolveGitWorkspace(payload.workspaceId, payload.projectId);
      const connection = resolveGitConnection(workspace);
      const rootPath = resolveRootPath(workspace, payload.rootPath);
      return runGitWorkspaceAction(workspace, git.forcePushWithLease(workspace, { connection, rootPath }));
    },
  };
}
