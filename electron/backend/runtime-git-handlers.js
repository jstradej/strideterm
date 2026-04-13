/**
 * Factory for Git operation API handlers.
 * Extracted from runtime.js to reduce file size.
 */
export function createGitHandlers(ctx) {
  const { git, store, getPayload, resolveGitWorkspace, resolveGitConnection, runGitWorkspaceAction, syncWorktrees } =
    ctx;

  return {
    async refreshGitState(projectId = null) {
      await ctx.refreshGit(projectId);
      ctx.broadcastState();
      return getPayload();
    },
    async gitFetch(payload = {}) {
      const workspace = resolveGitWorkspace(payload.workspaceId, payload.projectId);
      const connection = resolveGitConnection(workspace);
      return runGitWorkspaceAction(workspace, git.fetch(workspace, { connection }));
    },
    async gitPull(payload = {}) {
      const workspace = resolveGitWorkspace(payload.workspaceId, payload.projectId);
      const connection = resolveGitConnection(workspace);
      return runGitWorkspaceAction(workspace, git.pull(workspace, { connection }));
    },
    async gitPush(payload = {}) {
      const workspace = resolveGitWorkspace(payload.workspaceId, payload.projectId);
      const connection = resolveGitConnection(workspace);
      return runGitWorkspaceAction(workspace, git.push(workspace, { connection }));
    },
    async gitCheckoutBranch(payload = {}) {
      const workspace = resolveGitWorkspace(payload.workspaceId, payload.projectId);
      return runGitWorkspaceAction(workspace, git.checkoutBranch(workspace, payload));
    },
    async gitCreateBranch(payload = {}) {
      const workspace = resolveGitWorkspace(payload.workspaceId, payload.projectId);
      return runGitWorkspaceAction(workspace, git.createBranch(workspace, payload));
    },
    async gitMergeIntoCurrent(payload = {}) {
      const workspace = resolveGitWorkspace(payload.workspaceId, payload.projectId);
      return runGitWorkspaceAction(workspace, git.mergeIntoCurrent(workspace, payload));
    },
    async gitRebaseOnto(payload = {}) {
      const workspace = resolveGitWorkspace(payload.workspaceId, payload.projectId);
      return runGitWorkspaceAction(workspace, git.rebaseOnto(workspace, payload));
    },
    async gitContinueOperation(payload = {}) {
      const workspace = resolveGitWorkspace(payload.workspaceId, payload.projectId);
      return runGitWorkspaceAction(workspace, git.continueOperation(workspace));
    },
    async gitAbortOperation(payload = {}) {
      const workspace = resolveGitWorkspace(payload.workspaceId, payload.projectId);
      return runGitWorkspaceAction(workspace, git.abortOperation(workspace));
    },
    async gitDiffPreview(payload = {}) {
      const workspace = resolveGitWorkspace(payload.workspaceId, payload.projectId);
      return git.diffPreview(workspace, payload);
    },
    async gitMergeCurrentIntoBase(payload = {}) {
      const workspace = resolveGitWorkspace(payload.workspaceId, payload.projectId);
      const actionResult = await runGitWorkspaceAction(workspace, git.mergeCurrentIntoBase(workspace, payload));
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
      const result = await git.removeWorktree(workspace, payload);
      await syncWorktrees();
      return { payload: getPayload(), result };
    },
    async gitCommitAll(payload = {}) {
      const workspace = resolveGitWorkspace(payload.workspaceId, payload.projectId);
      return runGitWorkspaceAction(workspace, git.commitAll(workspace, payload));
    },
    async gitStash(payload = {}) {
      const workspace = resolveGitWorkspace(payload.workspaceId, payload.projectId);
      return runGitWorkspaceAction(workspace, git.stash(workspace, payload));
    },
    async gitStashPop(payload = {}) {
      const workspace = resolveGitWorkspace(payload.workspaceId, payload.projectId);
      return runGitWorkspaceAction(workspace, git.stashPop(workspace));
    },
    async gitCommitDiff(payload = {}) {
      const workspace = resolveGitWorkspace(payload.workspaceId, payload.projectId);
      return git.commitDiff(workspace, payload);
    },
    async gitListTags(payload = {}) {
      const workspace = resolveGitWorkspace(payload.workspaceId, payload.projectId);
      const connection = resolveGitConnection(workspace);
      return git.listTags(workspace, { connection });
    },
    async gitCreateTag(payload = {}) {
      const workspace = resolveGitWorkspace(payload.workspaceId, payload.projectId);
      return runGitWorkspaceAction(workspace, git.createTag(workspace, payload));
    },
    async gitDeleteTag(payload = {}) {
      const workspace = resolveGitWorkspace(payload.workspaceId, payload.projectId);
      return runGitWorkspaceAction(workspace, git.deleteTag(workspace, payload));
    },
    async gitPushTag(payload = {}) {
      const workspace = resolveGitWorkspace(payload.workspaceId, payload.projectId);
      const connection = resolveGitConnection(workspace);
      return runGitWorkspaceAction(workspace, git.pushTag(workspace, { ...payload, connection }));
    },
    async gitPushAllTags(payload = {}) {
      const workspace = resolveGitWorkspace(payload.workspaceId, payload.projectId);
      const connection = resolveGitConnection(workspace);
      return runGitWorkspaceAction(workspace, git.pushAllTags(workspace, { connection }));
    },
    async gitDeleteRemoteTag(payload = {}) {
      const workspace = resolveGitWorkspace(payload.workspaceId, payload.projectId);
      const connection = resolveGitConnection(workspace);
      return runGitWorkspaceAction(workspace, git.deleteRemoteTag(workspace, { ...payload, connection }));
    },
  };
}
