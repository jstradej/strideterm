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
  resolveGitWorkspace: (workspaceId?: string, projectId?: string, windowId?: string) => WorkspaceState;
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
    async gitFetch(payload: any = {}, windowId?: string) {
      const workspace = resolveGitWorkspace(payload.workspaceId, payload.projectId, windowId);
      const connection = resolveGitConnection(workspace);
      const rootPath = resolveRootPath(workspace, payload.rootPath);
      return runGitWorkspaceAction(workspace, git.fetch(workspace, { connection, rootPath }));
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async gitPull(payload: any = {}, windowId?: string) {
      const workspace = resolveGitWorkspace(payload.workspaceId, payload.projectId, windowId);
      const connection = resolveGitConnection(workspace);
      const rootPath = resolveRootPath(workspace, payload.rootPath);
      const stashDirty = Boolean(payload.stashDirty);
      return runGitWorkspaceAction(workspace, git.pull(workspace, { connection, rootPath, stashDirty }));
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async gitPush(payload: any = {}, windowId?: string) {
      const workspace = resolveGitWorkspace(payload.workspaceId, payload.projectId, windowId);
      const connection = resolveGitConnection(workspace);
      const rootPath = resolveRootPath(workspace, payload.rootPath);
      return runGitWorkspaceAction(workspace, git.push(workspace, { connection, rootPath }));
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async gitCheckoutBranch(payload: any = {}, windowId?: string) {
      const workspace = resolveGitWorkspace(payload.workspaceId, payload.projectId, windowId);
      const rootPath = resolveRootPath(workspace, payload.rootPath);
      return runGitWorkspaceAction(workspace, git.checkoutBranch(workspace, { ...payload, rootPath }));
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async gitCreateBranch(payload: any = {}, windowId?: string) {
      const workspace = resolveGitWorkspace(payload.workspaceId, payload.projectId, windowId);
      const rootPath = resolveRootPath(workspace, payload.rootPath);
      return runGitWorkspaceAction(workspace, git.createBranch(workspace, { ...payload, rootPath }));
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async gitMergeIntoCurrent(payload: any = {}, windowId?: string) {
      const workspace = resolveGitWorkspace(payload.workspaceId, payload.projectId, windowId);
      const connection = resolveGitConnection(workspace);
      const rootPath = resolveRootPath(workspace, payload.rootPath);
      return runGitWorkspaceAction(workspace, git.mergeIntoCurrent(workspace, { ...payload, connection, rootPath }));
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async gitRebaseOnto(payload: any = {}, windowId?: string) {
      const workspace = resolveGitWorkspace(payload.workspaceId, payload.projectId, windowId);
      const connection = resolveGitConnection(workspace);
      const rootPath = resolveRootPath(workspace, payload.rootPath);
      return runGitWorkspaceAction(workspace, git.rebaseOnto(workspace, { ...payload, connection, rootPath }));
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async gitCherryPick(payload: any = {}, windowId?: string) {
      const workspace = resolveGitWorkspace(payload.workspaceId, payload.projectId, windowId);
      // Connection is audit-only here (no network) — it routes the operation
      // into the connection's audit log like merge/rebase.
      const connection = resolveGitConnection(workspace);
      const rootPath = resolveRootPath(workspace, payload.rootPath);
      return runGitWorkspaceAction(
        workspace,
        git.cherryPick(workspace, { hashes: payload.hashes, connection, rootPath }),
      );
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async gitSquashCommits(payload: any = {}, windowId?: string) {
      const workspace = resolveGitWorkspace(payload.workspaceId, payload.projectId, windowId);
      const connection = resolveGitConnection(workspace);
      const rootPath = resolveRootPath(workspace, payload.rootPath);
      return runGitWorkspaceAction(
        workspace,
        git.squashCommits(workspace, { hashes: payload.hashes, message: payload.message, connection, rootPath }),
      );
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async gitContinueOperation(payload: any = {}, windowId?: string) {
      const workspace = resolveGitWorkspace(payload.workspaceId, payload.projectId, windowId);
      const rootPath = resolveRootPath(workspace, payload.rootPath);
      return runGitWorkspaceAction(workspace, git.continueOperation(workspace, { rootPath }));
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async gitAbortOperation(payload: any = {}, windowId?: string) {
      const workspace = resolveGitWorkspace(payload.workspaceId, payload.projectId, windowId);
      const rootPath = resolveRootPath(workspace, payload.rootPath);
      return runGitWorkspaceAction(workspace, git.abortOperation(workspace, { rootPath }));
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async gitDiffPreview(payload: any = {}, windowId?: string) {
      const workspace = resolveGitWorkspace(payload.workspaceId, payload.projectId, windowId);
      const rootPath = resolveRootPath(workspace, payload.rootPath);
      return git.diffPreview(workspace, { ...payload, rootPath });
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async gitCompareBranch(payload: any = {}, windowId?: string) {
      const workspace = resolveGitWorkspace(payload.workspaceId, payload.projectId, windowId);
      const rootPath = resolveRootPath(workspace, payload.rootPath);
      return git.compareWithBranch(workspace, { baseBranch: payload.baseBranch || "", rootPath });
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async gitMergeCurrentIntoBase(payload: any = {}, windowId?: string) {
      const workspace = resolveGitWorkspace(payload.workspaceId, payload.projectId, windowId);
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
    async gitRemoveWorktree(payload: any = {}, windowId?: string) {
      const workspace = resolveGitWorkspace(payload.workspaceId, payload.projectId, windowId);
      const rootPath = resolveRootPath(workspace, payload.rootPath);
      const result = await git.removeWorktree(workspace, { ...payload, rootPath });
      await syncWorktrees();
      return { payload: getPayload(), result };
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async gitCommitAll(payload: any = {}, windowId?: string) {
      const workspace = resolveGitWorkspace(payload.workspaceId, payload.projectId, windowId);
      const rootPath = resolveRootPath(workspace, payload.rootPath);
      return runGitWorkspaceAction(workspace, git.commitAll(workspace, { ...payload, rootPath }));
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async gitStash(payload: any = {}, windowId?: string) {
      const workspace = resolveGitWorkspace(payload.workspaceId, payload.projectId, windowId);
      const rootPath = resolveRootPath(workspace, payload.rootPath);
      return runGitWorkspaceAction(workspace, git.stash(workspace, { ...payload, rootPath }));
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async gitStashPop(payload: any = {}, windowId?: string) {
      const workspace = resolveGitWorkspace(payload.workspaceId, payload.projectId, windowId);
      const rootPath = resolveRootPath(workspace, payload.rootPath);
      return runGitWorkspaceAction(workspace, git.stashPop(workspace, { rootPath, ref: payload.ref }));
    },
    // --- Stash detail / lifecycle ---
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async gitListStashes(payload: any = {}, windowId?: string) {
      const workspace = resolveGitWorkspace(payload.workspaceId, payload.projectId, windowId);
      const rootPath = resolveRootPath(workspace, payload.rootPath);
      return git.listStashes(workspace, { rootPath });
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async gitStashFiles(payload: any = {}, windowId?: string) {
      const workspace = resolveGitWorkspace(payload.workspaceId, payload.projectId, windowId);
      const rootPath = resolveRootPath(workspace, payload.rootPath);
      return git.stashFiles(workspace, { rootPath, ref: payload.ref });
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async gitStashFileDiff(payload: any = {}, windowId?: string) {
      const workspace = resolveGitWorkspace(payload.workspaceId, payload.projectId, windowId);
      const rootPath = resolveRootPath(workspace, payload.rootPath);
      return git.stashFileDiff(workspace, { rootPath, ref: payload.ref, relativePath: payload.relativePath });
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async gitStashApply(payload: any = {}, windowId?: string) {
      const workspace = resolveGitWorkspace(payload.workspaceId, payload.projectId, windowId);
      const rootPath = resolveRootPath(workspace, payload.rootPath);
      return runGitWorkspaceAction(workspace, git.stashApply(workspace, { rootPath, ref: payload.ref }));
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async gitStashDrop(payload: any = {}, windowId?: string) {
      const workspace = resolveGitWorkspace(payload.workspaceId, payload.projectId, windowId);
      const rootPath = resolveRootPath(workspace, payload.rootPath);
      return runGitWorkspaceAction(workspace, git.stashDrop(workspace, { rootPath, ref: payload.ref }));
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async gitStashBranch(payload: any = {}, windowId?: string) {
      const workspace = resolveGitWorkspace(payload.workspaceId, payload.projectId, windowId);
      const rootPath = resolveRootPath(workspace, payload.rootPath);
      return runGitWorkspaceAction(
        workspace,
        git.stashBranch(workspace, {
          rootPath,
          ref: payload.ref,
          branchName: payload.branchName,
          switchImmediately: payload.switchImmediately,
        }),
      );
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async gitStashExport(payload: any = {}, windowId?: string) {
      const workspace = resolveGitWorkspace(payload.workspaceId, payload.projectId, windowId);
      const rootPath = resolveRootPath(workspace, payload.rootPath);
      return git.stashExportPatch(workspace, { rootPath, ref: payload.ref });
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async gitStashImport(payload: any = {}, windowId?: string) {
      const workspace = resolveGitWorkspace(payload.workspaceId, payload.projectId, windowId);
      const rootPath = resolveRootPath(workspace, payload.rootPath);
      return runGitWorkspaceAction(
        workspace,
        git.stashImportPatch(workspace, { rootPath, patch: payload.patch, message: payload.message }),
      );
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async gitLogPage(payload: any = {}, windowId?: string) {
      const workspace = resolveGitWorkspace(payload.workspaceId, payload.projectId, windowId);
      const rootPath = resolveRootPath(workspace, payload.rootPath);
      return git.logPage(workspace, {
        rootPath,
        baseBranch: payload.baseBranch || "",
        skip: payload.skip || 0,
        limit: payload.limit || 100,
      });
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async gitCommitDiff(payload: any = {}, windowId?: string) {
      const workspace = resolveGitWorkspace(payload.workspaceId, payload.projectId, windowId);
      const rootPath = resolveRootPath(workspace, payload.rootPath);
      return git.commitDiff(workspace, { ...payload, rootPath });
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async gitCommitInfo(payload: any = {}, windowId?: string) {
      const workspace = resolveGitWorkspace(payload.workspaceId, payload.projectId, windowId);
      const rootPath = resolveRootPath(workspace, payload.rootPath);
      return git.commitInfo(workspace, { hash: payload.hash, rootPath });
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async gitListTags(payload: any = {}, windowId?: string) {
      const workspace = resolveGitWorkspace(payload.workspaceId, payload.projectId, windowId);
      const connection = resolveGitConnection(workspace);
      const rootPath = resolveRootPath(workspace, payload.rootPath);
      return git.listTags(workspace, { connection, rootPath });
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async gitCreateTag(payload: any = {}, windowId?: string) {
      const workspace = resolveGitWorkspace(payload.workspaceId, payload.projectId, windowId);
      const rootPath = resolveRootPath(workspace, payload.rootPath);
      return runGitWorkspaceAction(workspace, git.createTag(workspace, { ...payload, rootPath }));
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async gitDeleteTag(payload: any = {}, windowId?: string) {
      const workspace = resolveGitWorkspace(payload.workspaceId, payload.projectId, windowId);
      const rootPath = resolveRootPath(workspace, payload.rootPath);
      return runGitWorkspaceAction(workspace, git.deleteTag(workspace, { ...payload, rootPath }));
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async gitPushTag(payload: any = {}, windowId?: string) {
      const workspace = resolveGitWorkspace(payload.workspaceId, payload.projectId, windowId);
      const connection = resolveGitConnection(workspace);
      const rootPath = resolveRootPath(workspace, payload.rootPath);
      return runGitWorkspaceAction(workspace, git.pushTag(workspace, { ...payload, connection, rootPath }));
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async gitPushAllTags(payload: any = {}, windowId?: string) {
      const workspace = resolveGitWorkspace(payload.workspaceId, payload.projectId, windowId);
      const connection = resolveGitConnection(workspace);
      const rootPath = resolveRootPath(workspace, payload.rootPath);
      return runGitWorkspaceAction(workspace, git.pushAllTags(workspace, { connection, rootPath }));
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async gitDeleteRemoteTag(payload: any = {}, windowId?: string) {
      const workspace = resolveGitWorkspace(payload.workspaceId, payload.projectId, windowId);
      const connection = resolveGitConnection(workspace);
      const rootPath = resolveRootPath(workspace, payload.rootPath);
      return runGitWorkspaceAction(workspace, git.deleteRemoteTag(workspace, { ...payload, connection, rootPath }));
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async gitForcePushWithLease(payload: any = {}, windowId?: string) {
      const workspace = resolveGitWorkspace(payload.workspaceId, payload.projectId, windowId);
      const connection = resolveGitConnection(workspace);
      const rootPath = resolveRootPath(workspace, payload.rootPath);
      return runGitWorkspaceAction(workspace, git.forcePushWithLease(workspace, { connection, rootPath }));
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async gitListBranches(payload: any = {}, windowId?: string) {
      const workspace = resolveGitWorkspace(payload.workspaceId, payload.projectId, windowId);
      const rootPath = resolveRootPath(workspace, payload.rootPath);
      return git.listBranches(workspace, { rootPath });
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async gitDeleteBranch(payload: any = {}, windowId?: string) {
      const workspace = resolveGitWorkspace(payload.workspaceId, payload.projectId, windowId);
      const rootPath = resolveRootPath(workspace, payload.rootPath);
      return runGitWorkspaceAction(
        workspace,
        git.deleteBranch(workspace, { branch: payload.branch, force: !!payload.force, rootPath }),
      );
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async gitDeleteRemoteBranch(payload: any = {}, windowId?: string) {
      const workspace = resolveGitWorkspace(payload.workspaceId, payload.projectId, windowId);
      const connection = resolveGitConnection(workspace);
      const rootPath = resolveRootPath(workspace, payload.rootPath);
      return runGitWorkspaceAction(
        workspace,
        git.deleteRemoteBranch(workspace, {
          branch: payload.branch,
          remote: payload.remote || "origin",
          connection,
          rootPath,
        }),
      );
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async gitRenameBranch(payload: any = {}, windowId?: string) {
      const workspace = resolveGitWorkspace(payload.workspaceId, payload.projectId, windowId);
      const rootPath = resolveRootPath(workspace, payload.rootPath);
      return runGitWorkspaceAction(
        workspace,
        git.renameBranch(workspace, { branch: payload.branch, newName: payload.newName, rootPath }),
      );
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async gitCheckoutRemoteBranch(payload: any = {}, windowId?: string) {
      const workspace = resolveGitWorkspace(payload.workspaceId, payload.projectId, windowId);
      const rootPath = resolveRootPath(workspace, payload.rootPath);
      return runGitWorkspaceAction(
        workspace,
        git.checkoutRemoteBranch(workspace, {
          remoteBranch: payload.remoteBranch,
          localBranch: payload.localBranch || "",
          rootPath,
        }),
      );
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async gitLogGraph(payload: any = {}, windowId?: string) {
      const workspace = resolveGitWorkspace(payload.workspaceId, payload.projectId, windowId);
      const rootPath = resolveRootPath(workspace, payload.rootPath);
      return git.logGraph(workspace, {
        rootPath,
        limit: payload.limit || 300,
        includeRemotes: payload.includeRemotes !== false,
        branch: payload.branch || "",
        sinceDate: payload.sinceDate || "",
        untilDate: payload.untilDate || "",
        paths: Array.isArray(payload.paths) ? payload.paths : [],
        topoOrder: payload.topoOrder === true,
        author: payload.author || "",
      });
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async gitSkipCommit(payload: any = {}, windowId?: string) {
      const workspace = resolveGitWorkspace(payload.workspaceId, payload.projectId, windowId);
      const rootPath = resolveRootPath(workspace, payload.rootPath);
      return runGitWorkspaceAction(workspace, git.skipCommit(workspace, { rootPath }));
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async gitListConflicts(payload: any = {}, windowId?: string) {
      const workspace = resolveGitWorkspace(payload.workspaceId, payload.projectId, windowId);
      const rootPath = resolveRootPath(workspace, payload.rootPath);
      return git.listConflicts(workspace, { rootPath });
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async gitConflictDetail(payload: any = {}, windowId?: string) {
      const workspace = resolveGitWorkspace(payload.workspaceId, payload.projectId, windowId);
      const rootPath = resolveRootPath(workspace, payload.rootPath);
      return git.conflictDetail(workspace, { filePath: payload.filePath, rootPath });
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async gitResolveConflict(payload: any = {}, windowId?: string) {
      const workspace = resolveGitWorkspace(payload.workspaceId, payload.projectId, windowId);
      const rootPath = resolveRootPath(workspace, payload.rootPath);
      return git.resolveConflict(workspace, {
        filePath: payload.filePath,
        mode: payload.mode,
        content: payload.content,
        rootPath,
      });
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async gitUnresolveConflict(payload: any = {}, windowId?: string) {
      const workspace = resolveGitWorkspace(payload.workspaceId, payload.projectId, windowId);
      const rootPath = resolveRootPath(workspace, payload.rootPath);
      return git.unresolveConflict(workspace, { filePath: payload.filePath, rootPath });
    },
  };
}
