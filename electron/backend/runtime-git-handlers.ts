import { resolveRootPath as resolveRootPathShared } from "./shared/runtime-provider-guards.js";
import type { WorkspaceState } from "../shared/types/state.js";
import type { OperationRegistry } from "./operation-registry.js";
import { randomUUID } from "node:crypto";

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
  /** Stamp `lastWorkedAt` after an allowlisted user action succeeded. */
  recordWorkspaceWork: (workspaceId: string, viewerId?: string) => Promise<void>;
  refreshGit: (projectId?: string | null) => Promise<void>;
  broadcastState: () => void;
  syncWorktrees: () => Promise<void>;
  /** Emit a live push-progress frame (streamed git output, incl. pre-push hook) to connected clients. */
  emitGitProgress: (payload: { workspaceId: string; rootPath: string; chunk: string }) => void;
  operations: Pick<OperationRegistry, "accept" | "list">;
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
    recordWorkspaceWork,
    syncWorktrees,
    operations,
  } = ctx;

  function resolveRootPath(workspace: WorkspaceState, rawRootPath: string): string {
    return resolveRootPathShared(resolveGitRootPath, workspace, rawRootPath);
  }

  /**
   * Did the git command actually succeed?
   *
   * The manager reports a refused operation as a RESOLVED structured failure
   * (`createStructuredResult({ ok: false, … })`) — a rejected push, an invalid
   * branch name, a checkout blocked by local changes. Treating "the promise
   * resolved" as success therefore stamped `lastWorkedAt` for work that never
   * happened (V3 review, §4 P1).
   *
   * Only an explicit `ok: false` counts as failure: a handful of mutations
   * resolve with a plain payload that carries no status field at all, and for
   * those the resolution IS the success signal.
   */
  function isGitSuccess(result: unknown): boolean {
    if (result && typeof result === "object" && "ok" in result) {
      return Boolean((result as { ok?: unknown }).ok);
    }
    return true;
  }

  function gitFailureMessage(kind: string, result: Record<string, unknown>): string {
    const summary = String(result.summary || `Git ${kind} failed.`).trim();
    const warnings = Array.isArray(result.warnings)
      ? result.warnings.map((warning) => String(warning).trim()).filter(Boolean)
      : [];
    const rawOutput = String(result.rawOutput || "")
      .trim()
      .slice(-6000);
    const operationState = result.operationState as
      { kind?: unknown; inProgress?: unknown; conflicts?: unknown } | undefined;
    const conflicts = Array.isArray(operationState?.conflicts)
      ? operationState.conflicts.map((conflict) => String(conflict)).filter(Boolean)
      : [];
    const authenticationFailed = /authentication failed|\bunauthorized\b|\bforbidden\b|\b401\b|\b403\b/i.test(
      `${summary}\n${rawOutput}`,
    );
    const lines = [authenticationFailed ? `Git ${kind} authentication failed.` : summary];
    if (warnings.length) lines.push(`Warnings:\n${warnings.join("\n")}`);
    if (operationState?.inProgress === true) {
      const operationKind = String(operationState.kind || "Git operation");
      lines.push(`Repository state: ${operationKind} requires manual resolution.`);
    }
    if (conflicts.length) lines.push(`Conflicts:\n${conflicts.join("\n")}`);
    if (rawOutput) lines.push(`Git output:\n${rawOutput}`);
    return lines.join("\n\n");
  }

  /**
   * `runGitWorkspaceAction` for the operations the V2 plan counts as user
   * work: commit, push/pull, checkout/branch, merge/rebase/stash and their
   * immediate relatives. The stamp lands only after the git command resolved
   * AND reported success — a failed push or a refused checkout is not work,
   * and a rejection propagates untouched because the stamp happens after the
   * await.
   *
   * When the stamp does land, the response payload is rebuilt from it: the
   * wrapper used to return the snapshot `runGitWorkspaceAction` captured
   * BEFORE the mutation, so a renderer adopting that response overwrote the
   * fresh broadcast with a pre-stamp state (V3 review, §4 P2).
   *
   * Read-only operations (log, diff, compare, list, stash inspection) keep
   * using the plain `runGitWorkspaceAction`: looking is not working. Stage,
   * unstage and commit-staged APIs use the manager's audited write actions;
   * the legacy selected-path commit retains its existing semantics.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async function runGitWorkspaceMutation(workspace: WorkspaceState, action: Promise<any>, windowId?: string) {
    const response = await runGitWorkspaceAction(workspace, action);
    if (!isGitSuccess(response?.result)) return response;
    await recordWorkspaceWork(workspace.id, windowId);
    return { ...response, payload: getPayload() };
  }

  async function startLongGitAction(
    kind: "fetch" | "pull" | "push",
    workspace: WorkspaceState,
    rootPath: string,
    input: Record<string, unknown>,
    windowId?: string,
  ) {
    const profileId = String(workspace.profileId || "default");
    const idempotencyKey = String(input.idempotencyKey || randomUUID());
    const operationInput = { kind, workspaceId: workspace.id, rootPath, stashDirty: input.stashDirty === true };
    const inputHash = JSON.stringify(operationInput);
    const existing = operations
      .list(profileId)
      .find(
        (record) =>
          record.kind === `git.${kind}` &&
          record.originWorkspaceId === workspace.id &&
          record.intent.rootPath === rootPath &&
          (record.status === "accepted" || record.status === "running"),
      );
    if (existing) {
      if (existing.inputHash !== inputHash) {
        throw new Error(`A Git ${kind} operation is already running for this repository.`);
      }
      return { started: true, operationId: existing.operationId, replayed: true };
    }
    const connection = resolveGitConnection(workspace);
    const accepted = await operations.accept(
      {
        kind: `git.${kind}`,
        profileId,
        originWorkspaceId: workspace.id,
        idempotencyKey,
        inputHash,
        initialStep: kind,
        intent: { workspaceId: workspace.id, rootPath, kind },
      },
      async (handle) => {
        await handle.update({ workspaceId: workspace.id, step: kind });
        const result =
          kind === "fetch"
            ? await runGitWorkspaceAction(workspace, git.fetch(workspace, { connection, rootPath }))
            : kind === "pull"
              ? await runGitWorkspaceMutation(
                  workspace,
                  git.pull(workspace, { connection, rootPath, stashDirty: input.stashDirty === true }),
                  windowId,
                )
              : await runGitWorkspaceMutation(
                  workspace,
                  git.push(workspace, {
                    connection,
                    rootPath,
                    onProgress: (chunk: string) => ctx.emitGitProgress({ workspaceId: workspace.id, rootPath, chunk }),
                  }),
                  windowId,
                );
        if (result?.result?.ok === false) {
          throw new Error(gitFailureMessage(kind, result.result));
        }
        return {
          ok: true,
          summary: String(result?.result?.summary || `${kind} completed.`),
          warnings: Array.isArray(result?.result?.warnings) ? result.result.warnings : [],
        };
      },
    );
    return { started: true, operationId: accepted.record.operationId, replayed: accepted.replayed };
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
      const rootPath = resolveRootPath(workspace, payload.rootPath);
      return startLongGitAction("fetch", workspace, rootPath, payload, windowId);
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async gitPull(payload: any = {}, windowId?: string) {
      const workspace = resolveGitWorkspace(payload.workspaceId, payload.projectId, windowId);
      const rootPath = resolveRootPath(workspace, payload.rootPath);
      return startLongGitAction("pull", workspace, rootPath, payload, windowId);
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async gitPush(payload: any = {}, windowId?: string) {
      const workspace = resolveGitWorkspace(payload.workspaceId, payload.projectId, windowId);
      const rootPath = resolveRootPath(workspace, payload.rootPath);
      return startLongGitAction("push", workspace, rootPath, payload, windowId);
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async gitCheckoutBranch(payload: any = {}, windowId?: string) {
      const workspace = resolveGitWorkspace(payload.workspaceId, payload.projectId, windowId);
      const rootPath = resolveRootPath(workspace, payload.rootPath);
      return runGitWorkspaceMutation(workspace, git.checkoutBranch(workspace, { ...payload, rootPath }), windowId);
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async gitCreateBranch(payload: any = {}, windowId?: string) {
      const workspace = resolveGitWorkspace(payload.workspaceId, payload.projectId, windowId);
      const rootPath = resolveRootPath(workspace, payload.rootPath);
      return runGitWorkspaceMutation(workspace, git.createBranch(workspace, { ...payload, rootPath }), windowId);
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async gitMergeIntoCurrent(payload: any = {}, windowId?: string) {
      const workspace = resolveGitWorkspace(payload.workspaceId, payload.projectId, windowId);
      const connection = resolveGitConnection(workspace);
      const rootPath = resolveRootPath(workspace, payload.rootPath);
      return runGitWorkspaceMutation(
        workspace,
        git.mergeIntoCurrent(workspace, { ...payload, connection, rootPath }),
        windowId,
      );
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async gitRebaseOnto(payload: any = {}, windowId?: string) {
      const workspace = resolveGitWorkspace(payload.workspaceId, payload.projectId, windowId);
      const connection = resolveGitConnection(workspace);
      const rootPath = resolveRootPath(workspace, payload.rootPath);
      return runGitWorkspaceMutation(
        workspace,
        git.rebaseOnto(workspace, { ...payload, connection, rootPath }),
        windowId,
      );
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async gitCherryPick(payload: any = {}, windowId?: string) {
      const workspace = resolveGitWorkspace(payload.workspaceId, payload.projectId, windowId);
      // Connection is audit-only here (no network) — it routes the operation
      // into the connection's audit log like merge/rebase.
      const connection = resolveGitConnection(workspace);
      const rootPath = resolveRootPath(workspace, payload.rootPath);
      return runGitWorkspaceMutation(
        workspace,
        git.cherryPick(workspace, { hashes: payload.hashes, connection, rootPath }),
        windowId,
      );
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async gitSquashCommits(payload: any = {}, windowId?: string) {
      const workspace = resolveGitWorkspace(payload.workspaceId, payload.projectId, windowId);
      const connection = resolveGitConnection(workspace);
      const rootPath = resolveRootPath(workspace, payload.rootPath);
      return runGitWorkspaceMutation(
        workspace,
        git.squashCommits(workspace, { hashes: payload.hashes, message: payload.message, connection, rootPath }),
        windowId,
      );
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async gitContinueOperation(payload: any = {}, windowId?: string) {
      const workspace = resolveGitWorkspace(payload.workspaceId, payload.projectId, windowId);
      const rootPath = resolveRootPath(workspace, payload.rootPath);
      return runGitWorkspaceMutation(workspace, git.continueOperation(workspace, { rootPath }), windowId);
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async gitAbortOperation(payload: any = {}, windowId?: string) {
      const workspace = resolveGitWorkspace(payload.workspaceId, payload.projectId, windowId);
      const rootPath = resolveRootPath(workspace, payload.rootPath);
      return runGitWorkspaceMutation(workspace, git.abortOperation(workspace, { rootPath }), windowId);
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
      const actionResult = await runGitWorkspaceMutation(
        workspace,
        git.mergeCurrentIntoBase(workspace, { ...payload, rootPath }),
        windowId,
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
      return runGitWorkspaceMutation(workspace, git.commitAll(workspace, { ...payload, rootPath }), windowId);
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async gitStageFile(payload: any = {}, windowId?: string) {
      const workspace = resolveGitWorkspace(payload.workspaceId, payload.projectId, windowId);
      const rootPath = resolveRootPath(workspace, payload.rootPath);
      return runGitWorkspaceMutation(workspace, git.stageFile(workspace, { path: payload.path, rootPath }), windowId);
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async gitStageHunk(payload: any = {}, windowId?: string) {
      const workspace = resolveGitWorkspace(payload.workspaceId, payload.projectId, windowId);
      const rootPath = resolveRootPath(workspace, payload.rootPath);
      return runGitWorkspaceMutation(
        workspace,
        git.stageHunk(workspace, {
          path: payload.path,
          action: payload.action,
          scope: payload.scope,
          diffToken: payload.diffToken,
          hunk: payload.hunk,
          rootPath,
        }),
        windowId,
      );
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async gitUnstageFile(payload: any = {}, windowId?: string) {
      const workspace = resolveGitWorkspace(payload.workspaceId, payload.projectId, windowId);
      const rootPath = resolveRootPath(workspace, payload.rootPath);
      return runGitWorkspaceMutation(workspace, git.unstageFile(workspace, { path: payload.path, rootPath }), windowId);
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async gitCommitStaged(payload: any = {}, windowId?: string) {
      const workspace = resolveGitWorkspace(payload.workspaceId, payload.projectId, windowId);
      const rootPath = resolveRootPath(workspace, payload.rootPath);
      return runGitWorkspaceMutation(
        workspace,
        git.commitStaged(workspace, { message: payload.message, rootPath }),
        windowId,
      );
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async gitStash(payload: any = {}, windowId?: string) {
      const workspace = resolveGitWorkspace(payload.workspaceId, payload.projectId, windowId);
      const rootPath = resolveRootPath(workspace, payload.rootPath);
      return runGitWorkspaceMutation(workspace, git.stash(workspace, { ...payload, rootPath }), windowId);
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async gitStashPop(payload: any = {}, windowId?: string) {
      const workspace = resolveGitWorkspace(payload.workspaceId, payload.projectId, windowId);
      const rootPath = resolveRootPath(workspace, payload.rootPath);
      return runGitWorkspaceMutation(workspace, git.stashPop(workspace, { rootPath, ref: payload.ref }), windowId);
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
      return runGitWorkspaceMutation(workspace, git.stashApply(workspace, { rootPath, ref: payload.ref }), windowId);
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async gitStashDrop(payload: any = {}, windowId?: string) {
      const workspace = resolveGitWorkspace(payload.workspaceId, payload.projectId, windowId);
      const rootPath = resolveRootPath(workspace, payload.rootPath);
      return runGitWorkspaceMutation(workspace, git.stashDrop(workspace, { rootPath, ref: payload.ref }), windowId);
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async gitStashBranch(payload: any = {}, windowId?: string) {
      const workspace = resolveGitWorkspace(payload.workspaceId, payload.projectId, windowId);
      const rootPath = resolveRootPath(workspace, payload.rootPath);
      return runGitWorkspaceMutation(
        workspace,
        git.stashBranch(workspace, {
          rootPath,
          ref: payload.ref,
          branchName: payload.branchName,
          switchImmediately: payload.switchImmediately,
        }),
        windowId,
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
      return runGitWorkspaceMutation(
        workspace,
        git.stashImportPatch(workspace, { rootPath, patch: payload.patch, message: payload.message }),
        windowId,
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
      return runGitWorkspaceMutation(workspace, git.createTag(workspace, { ...payload, rootPath }), windowId);
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async gitDeleteTag(payload: any = {}, windowId?: string) {
      const workspace = resolveGitWorkspace(payload.workspaceId, payload.projectId, windowId);
      const rootPath = resolveRootPath(workspace, payload.rootPath);
      return runGitWorkspaceMutation(workspace, git.deleteTag(workspace, { ...payload, rootPath }), windowId);
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async gitPushTag(payload: any = {}, windowId?: string) {
      const workspace = resolveGitWorkspace(payload.workspaceId, payload.projectId, windowId);
      const connection = resolveGitConnection(workspace);
      const rootPath = resolveRootPath(workspace, payload.rootPath);
      return runGitWorkspaceMutation(workspace, git.pushTag(workspace, { ...payload, connection, rootPath }), windowId);
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async gitPushAllTags(payload: any = {}, windowId?: string) {
      const workspace = resolveGitWorkspace(payload.workspaceId, payload.projectId, windowId);
      const connection = resolveGitConnection(workspace);
      const rootPath = resolveRootPath(workspace, payload.rootPath);
      return runGitWorkspaceMutation(workspace, git.pushAllTags(workspace, { connection, rootPath }), windowId);
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async gitDeleteRemoteTag(payload: any = {}, windowId?: string) {
      const workspace = resolveGitWorkspace(payload.workspaceId, payload.projectId, windowId);
      const connection = resolveGitConnection(workspace);
      const rootPath = resolveRootPath(workspace, payload.rootPath);
      return runGitWorkspaceMutation(
        workspace,
        git.deleteRemoteTag(workspace, { ...payload, connection, rootPath }),
        windowId,
      );
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async gitForcePushWithLease(payload: any = {}, windowId?: string) {
      const workspace = resolveGitWorkspace(payload.workspaceId, payload.projectId, windowId);
      const connection = resolveGitConnection(workspace);
      const rootPath = resolveRootPath(workspace, payload.rootPath);
      const onProgress = (chunk: string) => ctx.emitGitProgress({ workspaceId: workspace.id, rootPath, chunk });
      return runGitWorkspaceMutation(
        workspace,
        git.forcePushWithLease(workspace, { connection, rootPath, onProgress }),
        windowId,
      );
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
      return runGitWorkspaceMutation(
        workspace,
        git.deleteBranch(workspace, { branch: payload.branch, force: !!payload.force, rootPath }),
        windowId,
      );
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async gitDeleteRemoteBranch(payload: any = {}, windowId?: string) {
      const workspace = resolveGitWorkspace(payload.workspaceId, payload.projectId, windowId);
      const connection = resolveGitConnection(workspace);
      const rootPath = resolveRootPath(workspace, payload.rootPath);
      return runGitWorkspaceMutation(
        workspace,
        git.deleteRemoteBranch(workspace, {
          branch: payload.branch,
          remote: payload.remote || "origin",
          connection,
          rootPath,
        }),
        windowId,
      );
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async gitRenameBranch(payload: any = {}, windowId?: string) {
      const workspace = resolveGitWorkspace(payload.workspaceId, payload.projectId, windowId);
      const rootPath = resolveRootPath(workspace, payload.rootPath);
      return runGitWorkspaceMutation(
        workspace,
        git.renameBranch(workspace, { branch: payload.branch, newName: payload.newName, rootPath }),
        windowId,
      );
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async gitCheckoutRemoteBranch(payload: any = {}, windowId?: string) {
      const workspace = resolveGitWorkspace(payload.workspaceId, payload.projectId, windowId);
      const rootPath = resolveRootPath(workspace, payload.rootPath);
      return runGitWorkspaceMutation(
        workspace,
        git.checkoutRemoteBranch(workspace, {
          remoteBranch: payload.remoteBranch,
          localBranch: payload.localBranch || "",
          rootPath,
        }),
        windowId,
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
      return runGitWorkspaceMutation(workspace, git.skipCommit(workspace, { rootPath }), windowId);
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
