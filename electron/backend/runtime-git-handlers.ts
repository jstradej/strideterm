import type { WorkspaceState } from "../shared/types/state.js";

/**
 * Runtime context subset consumed by git handlers.
 * The full runtime ctx is typed as a structural interface so new fields
 * can be added without breaking this module.
 */
interface GitHandlerCtx {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  git: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  store: any;
  getPayload: () => unknown;
  resolveGitWorkspace: (workspaceId?: string, projectId?: string) => WorkspaceState;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  resolveGitConnection: (workspace: WorkspaceState) => any;
  resolveGitRootPath: (workspace: WorkspaceState, rawRootPath: string) => string | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  runGitWorkspaceAction: (workspace: WorkspaceState, action: Promise<any>) => Promise<any>;
  refreshGit: (projectId?: string | null) => Promise<void>;
  broadcastState: () => void;
  syncWorktrees: () => Promise<void>;
}

/**
 * Factory for Git operation API handlers.
 * Extracted from runtime.js to reduce file size.
 */
export function createGitHandlers(ctx: GitHandlerCtx) {
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

  function resolveRootPath(workspace: WorkspaceState, rawRootPath: string): string {
    const validated = resolveGitRootPath(workspace, rawRootPath || "");
    if (rawRootPath && !validated) throw new Error(`Root path not found in workspace gitRoots: ${rawRootPath}`);
    return validated || "";
  }

  return {
    async refreshGitState(projectId: string | null = null) {
      await ctx.refreshGit(projectId);
      ctx.broadcastState();
      return getPayload();
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async gitFetch(payload: any = {}) {
      const workspace = resolveGitWorkspace(payload.workspaceId, payload.projectId);
      const connection = resolveGitConnection(workspace);
      const rootPath = resolveRootPath(workspace, payload.rootPath);
      return runGitWorkspaceAction(workspace, git.fetch(workspace, { connection, rootPath }));
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async gitPull(payload: any = {}) {
      const workspace = resolveGitWorkspace(payload.workspaceId, payload.projectId);
      const connection = resolveGitConnection(workspace);
      const rootPath = resolveRootPath(workspace, payload.rootPath);
      return runGitWorkspaceAction(workspace, git.pull(workspace, { connection, rootPath }));
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async gitPush(payload: any = {}) {
      const workspace = resolveGitWorkspace(payload.workspaceId, payload.projectId);
      const connection = resolveGitConnection(workspace);
      const rootPath = resolveRootPath(workspace, payload.rootPath);
      return runGitWorkspaceAction(workspace, git.push(workspace, { connection, rootPath }));
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async gitCheckoutBranch(payload: any = {}) {
      const workspace = resolveGitWorkspace(payload.workspaceId, payload.projectId);
      const rootPath = resolveRootPath(workspace, payload.rootPath);
      return runGitWorkspaceAction(workspace, git.checkoutBranch(workspace, { ...payload, rootPath }));
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async gitCreateBranch(payload: any = {}) {
      const workspace = resolveGitWorkspace(payload.workspaceId, payload.projectId);
      const rootPath = resolveRootPath(workspace, payload.rootPath);
      return runGitWorkspaceAction(workspace, git.createBranch(workspace, { ...payload, rootPath }));
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async gitMergeIntoCurrent(payload: any = {}) {
      const workspace = resolveGitWorkspace(payload.workspaceId, payload.projectId);
      const rootPath = resolveRootPath(workspace, payload.rootPath);
      return runGitWorkspaceAction(workspace, git.mergeIntoCurrent(workspace, { ...payload, rootPath }));
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async gitRebaseOnto(payload: any = {}) {
      const workspace = resolveGitWorkspace(payload.workspaceId, payload.projectId);
      const rootPath = resolveRootPath(workspace, payload.rootPath);
      return runGitWorkspaceAction(workspace, git.rebaseOnto(workspace, { ...payload, rootPath }));
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async gitContinueOperation(payload: any = {}) {
      const workspace = resolveGitWorkspace(payload.workspaceId, payload.projectId);
      const rootPath = resolveRootPath(workspace, payload.rootPath);
      return runGitWorkspaceAction(workspace, git.continueOperation(workspace, { rootPath }));
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async gitAbortOperation(payload: any = {}) {
      const workspace = resolveGitWorkspace(payload.workspaceId, payload.projectId);
      const rootPath = resolveRootPath(workspace, payload.rootPath);
      return runGitWorkspaceAction(workspace, git.abortOperation(workspace, { rootPath }));
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async gitDiffPreview(payload: any = {}) {
      const workspace = resolveGitWorkspace(payload.workspaceId, payload.projectId);
      const rootPath = resolveRootPath(workspace, payload.rootPath);
      return git.diffPreview(workspace, { ...payload, rootPath });
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async gitMergeCurrentIntoBase(payload: any = {}) {
      const workspace = resolveGitWorkspace(payload.workspaceId, payload.projectId);
      const rootPath = resolveRootPath(workspace, payload.rootPath);
      const actionResult = await runGitWorkspaceAction(
        workspace,
        git.mergeCurrentIntoBase(workspace, { ...payload, rootPath }),
      );
      if (actionResult.result?.ok) {
        await store.mutate((draft: { workspaces: Array<{ id: string; branchMerged?: boolean }> }) => {
          const ws = draft.workspaces.find((w) => w.id === workspace.id);
          if (ws) ws.branchMerged = true;
        });
        actionResult.payload = getPayload();
      }
      return actionResult;
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async gitRemoveWorktree(payload: any = {}) {
      const workspace = resolveGitWorkspace(payload.workspaceId, payload.projectId);
      const rootPath = resolveRootPath(workspace, payload.rootPath);
      const result = await git.removeWorktree(workspace, { ...payload, rootPath });
      await syncWorktrees();
      return { payload: getPayload(), result };
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async gitCommitAll(payload: any = {}) {
      const workspace = resolveGitWorkspace(payload.workspaceId, payload.projectId);
      const rootPath = resolveRootPath(workspace, payload.rootPath);
      return runGitWorkspaceAction(workspace, git.commitAll(workspace, { ...payload, rootPath }));
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async gitStash(payload: any = {}) {
      const workspace = resolveGitWorkspace(payload.workspaceId, payload.projectId);
      const rootPath = resolveRootPath(workspace, payload.rootPath);
      return runGitWorkspaceAction(workspace, git.stash(workspace, { ...payload, rootPath }));
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async gitStashPop(payload: any = {}) {
      const workspace = resolveGitWorkspace(payload.workspaceId, payload.projectId);
      const rootPath = resolveRootPath(workspace, payload.rootPath);
      return runGitWorkspaceAction(workspace, git.stashPop(workspace, { rootPath }));
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async gitLogPage(payload: any = {}) {
      const workspace = resolveGitWorkspace(payload.workspaceId, payload.projectId);
      const rootPath = resolveRootPath(workspace, payload.rootPath);
      return git.logPage(workspace, {
        rootPath,
        baseBranch: payload.baseBranch || "",
        skip: payload.skip || 0,
        limit: payload.limit || 100,
      });
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async gitCommitDiff(payload: any = {}) {
      const workspace = resolveGitWorkspace(payload.workspaceId, payload.projectId);
      const rootPath = resolveRootPath(workspace, payload.rootPath);
      return git.commitDiff(workspace, { ...payload, rootPath });
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async gitListTags(payload: any = {}) {
      const workspace = resolveGitWorkspace(payload.workspaceId, payload.projectId);
      const connection = resolveGitConnection(workspace);
      const rootPath = resolveRootPath(workspace, payload.rootPath);
      return git.listTags(workspace, { connection, rootPath });
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async gitCreateTag(payload: any = {}) {
      const workspace = resolveGitWorkspace(payload.workspaceId, payload.projectId);
      const rootPath = resolveRootPath(workspace, payload.rootPath);
      return runGitWorkspaceAction(workspace, git.createTag(workspace, { ...payload, rootPath }));
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async gitDeleteTag(payload: any = {}) {
      const workspace = resolveGitWorkspace(payload.workspaceId, payload.projectId);
      const rootPath = resolveRootPath(workspace, payload.rootPath);
      return runGitWorkspaceAction(workspace, git.deleteTag(workspace, { ...payload, rootPath }));
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async gitPushTag(payload: any = {}) {
      const workspace = resolveGitWorkspace(payload.workspaceId, payload.projectId);
      const connection = resolveGitConnection(workspace);
      const rootPath = resolveRootPath(workspace, payload.rootPath);
      return runGitWorkspaceAction(workspace, git.pushTag(workspace, { ...payload, connection, rootPath }));
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async gitPushAllTags(payload: any = {}) {
      const workspace = resolveGitWorkspace(payload.workspaceId, payload.projectId);
      const connection = resolveGitConnection(workspace);
      const rootPath = resolveRootPath(workspace, payload.rootPath);
      return runGitWorkspaceAction(workspace, git.pushAllTags(workspace, { connection, rootPath }));
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async gitDeleteRemoteTag(payload: any = {}) {
      const workspace = resolveGitWorkspace(payload.workspaceId, payload.projectId);
      const connection = resolveGitConnection(workspace);
      const rootPath = resolveRootPath(workspace, payload.rootPath);
      return runGitWorkspaceAction(workspace, git.deleteRemoteTag(workspace, { ...payload, connection, rootPath }));
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async gitForcePushWithLease(payload: any = {}) {
      const workspace = resolveGitWorkspace(payload.workspaceId, payload.projectId);
      const connection = resolveGitConnection(workspace);
      const rootPath = resolveRootPath(workspace, payload.rootPath);
      return runGitWorkspaceAction(workspace, git.forcePushWithLease(workspace, { connection, rootPath }));
    },
  };
}
