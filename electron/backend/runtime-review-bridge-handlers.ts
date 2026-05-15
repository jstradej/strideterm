import type { AppState } from "../shared/types/state.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyManager = any;

interface ReviewBridgeHandlerCtx {
  getState: () => AppState;
  azure: AnyManager;
  github: AnyManager;
  git: AnyManager;
  reviewBridgeStore: AnyManager;
  getPayload: () => unknown;
  broadcastState: () => void;
  refreshAzure: () => Promise<unknown>;
  refreshGitHub: () => Promise<unknown>;
  refreshGit: (workspaceId?: string | null) => Promise<void>;
  /** Throws when the workspace lives in a profile other than the caller
   * window's bound slot. No-op when windowId is missing (legacy / tests). */
  assertWorkspaceInWindowProfile: (workspaceId: string, windowId: string | undefined) => void;
}

/**
 * Factory for Review Bridge API handlers (shared between Azure DevOps + GitHub).
 * Extracted from runtime-provider-handlers.js for modularity.
 */
export function createReviewBridgeHandlers(ctx: ReviewBridgeHandlerCtx) {
  const {
    getState,
    azure,
    github,
    git,
    reviewBridgeStore,
    getPayload,
    broadcastState,
    refreshAzure,
    refreshGitHub,
    refreshGit,
    assertWorkspaceInWindowProfile,
  } = ctx;

  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async createReviewBridgeDraftComment(payload: any, windowId?: string) {
      if (payload?.workspaceId) assertWorkspaceInWindowProfile(String(payload.workspaceId), windowId);
      await reviewBridgeStore.createDraftComment(payload);
      broadcastState();
      return getPayload();
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async saveReviewBridgeDraft(payload: any, windowId?: string) {
      if (payload?.workspaceId) assertWorkspaceInWindowProfile(String(payload.workspaceId), windowId);
      await reviewBridgeStore.saveDraftResponse(payload);
      broadcastState();
      return getPayload();
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async queueReviewBridgeDraft(payload: any, windowId?: string) {
      if (payload?.workspaceId) assertWorkspaceInWindowProfile(String(payload.workspaceId), windowId);
      await reviewBridgeStore.queueDraftResponse(payload);
      broadcastState();
      return getPayload();
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async saveAgentPrompt(payload: any) {
      reviewBridgeStore.saveAgentPrompt(payload);
      broadcastState();
      return getPayload();
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async deleteAgentPrompt(payload: any) {
      reviewBridgeStore.deleteAgentPrompt(payload.promptId);
      broadcastState();
      return getPayload();
    },
    async resetAgentPrompts() {
      reviewBridgeStore.resetAgentPrompts();
      broadcastState();
      return getPayload();
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async replyWithCodeChanges(payload: any, windowId?: string) {
      if (payload?.workspaceId) assertWorkspaceInWindowProfile(String(payload.workspaceId), windowId);
      await reviewBridgeStore.replyWithCodeChanges(payload);
      broadcastState();
      return getPayload();
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async deleteReviewBridgeComment(payload: any, windowId?: string) {
      if (payload?.workspaceId) assertWorkspaceInWindowProfile(String(payload.workspaceId), windowId);
      await reviewBridgeStore.deleteComment(payload);
      broadcastState();
      return getPayload();
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async deleteReviewBridgeDraft(payload: any, windowId?: string) {
      if (payload?.workspaceId) assertWorkspaceInWindowProfile(String(payload.workspaceId), windowId);
      await reviewBridgeStore.deleteDraft(payload);
      broadcastState();
      return getPayload();
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async syncReviewBridgePullRequest(payload: any) {
      const prKey = String(payload?.prKey || "").trim();
      if (!prKey) {
        throw new Error("Pull request key is required.");
      }
      const prData = reviewBridgeStore.getPullRequestContext?.(prKey);
      const isGitHub = prData?.provider === "github" || github.findSummary(prKey);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await reviewBridgeStore.syncPendingDrafts(prKey, async (entry: any) => {
        if (isGitHub) {
          await github.addPullRequestComment({ prKey, body: entry.body });
        } else {
          await azure.addPullRequestComment({
            prKey,
            content: entry.body,
            threadId: entry.remoteThreadId,
            parentCommentId: entry.parentCommentId || 0,
          });
        }
        return {
          publishedAt: new Date().toISOString(),
          threadId: entry.remoteThreadId,
        };
      });
      if (isGitHub) {
        await refreshGitHub();
      } else {
        await refreshAzure();
      }
      broadcastState();
      return getPayload();
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async pushAndPublishReview(payload: any, windowId?: string) {
      const workspaceId = String(payload?.workspaceId || "").trim();
      if (!workspaceId) {
        throw new Error("Workspace ID is required.");
      }
      // pushAndPublishReview hits the git remote AND posts comments to the
      // PR provider — both are externally visible side effects that must
      // never happen from a window bound to another profile.
      assertWorkspaceInWindowProfile(workspaceId, windowId);
      const state = getState();
      const workspace = (state.workspaces || []).find((ws) => ws.id === workspaceId);
      if (!workspace) {
        throw new Error("Workspace was not found.");
      }
      const prKey = workspace.review?.prKey;
      if (!prKey) {
        throw new Error("This workspace is not associated with a pull request.");
      }
      const sourceBranch = String(
        workspace.review?.pullRequest?.sourceRefName ||
          (workspace.review?.pullRequest as unknown as { sourceBranch?: string })?.sourceBranch ||
          "",
      ).replace(/^refs\/heads\//, "");
      const aheadResult = await git
        .execGit(workspace.cwd, ["rev-list", "--count", `refs/remotes/origin/${sourceBranch}..HEAD`])
        .catch(() => ({ stdout: "0" }));
      const commitCount = Number(aheadResult.stdout.trim()) || 0;
      const provider = workspace.review?.provider;
      if (commitCount > 0) {
        const dirtyState = await git.getCachedWorktreeDirtyState(workspace.cwd);
        if (dirtyState.dirty) {
          throw new Error("You have uncommitted changes. Please commit or stash them before pushing.");
        }
        if (provider === "github") {
          await github.pushReviewWorkspace({ workspace });
        } else {
          await azure.pushReviewWorkspace({ workspace });
        }
      }
      const pushOk = true;
      let publishedCount = 0;
      let publishError = "";
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await reviewBridgeStore.syncPendingDrafts(prKey, async (entry: any) => {
          if (provider === "github") {
            await github.addPullRequestComment({ prKey, body: entry.body });
          } else {
            await azure.addPullRequestComment({
              prKey,
              content: entry.body,
              threadId: entry.remoteThreadId,
              parentCommentId: entry.parentCommentId || 0,
            });
          }
          publishedCount += 1;
          return {
            publishedAt: new Date().toISOString(),
            threadId: entry.remoteThreadId,
          };
        });
      } catch (error) {
        publishError = error instanceof Error ? error.message : String(error || "Publish failed.");
      }
      await refreshGit(workspaceId);
      if (provider === "github") {
        await refreshGitHub();
      } else {
        await refreshAzure();
      }
      broadcastState();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = getPayload() as any;
      result.pushAndPublishResult = { commitCount, publishedCount, pushOk, publishError };
      return result;
    },
  };
}
