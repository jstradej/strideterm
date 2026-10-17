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
  assertWorkspaceInViewerProfile: (workspaceId: string, windowId: string | undefined) => void;
  /** Throws when the PR (by key, either provider) is not in the caller viewer's
   * profile. No-op when windowId is missing (desktop IPC / tests). */
  assertPrInViewerProfile: (prKey: string, windowId: string | undefined) => void;
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
    assertWorkspaceInViewerProfile,
    assertPrInViewerProfile,
  } = ctx;

  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async createReviewBridgeDraftComment(payload: any, windowId?: string) {
      if (payload?.workspaceId) assertWorkspaceInViewerProfile(String(payload.workspaceId), windowId);
      await reviewBridgeStore.createDraftComment(payload);
      broadcastState();
      return getPayload();
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async saveReviewBridgeDraft(payload: any, windowId?: string) {
      if (payload?.workspaceId) assertWorkspaceInViewerProfile(String(payload.workspaceId), windowId);
      await reviewBridgeStore.saveDraftResponse(payload);
      broadcastState();
      return getPayload();
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async queueReviewBridgeDraft(payload: any, windowId?: string) {
      if (payload?.workspaceId) assertWorkspaceInViewerProfile(String(payload.workspaceId), windowId);
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
      if (payload?.workspaceId) assertWorkspaceInViewerProfile(String(payload.workspaceId), windowId);
      await reviewBridgeStore.replyWithCodeChanges(payload);
      broadcastState();
      return getPayload();
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async deleteReviewBridgeComment(payload: any, windowId?: string) {
      if (payload?.workspaceId) assertWorkspaceInViewerProfile(String(payload.workspaceId), windowId);
      await reviewBridgeStore.deleteComment(payload);
      broadcastState();
      return getPayload();
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async deleteReviewBridgeDraft(payload: any, windowId?: string) {
      if (payload?.workspaceId) assertWorkspaceInViewerProfile(String(payload.workspaceId), windowId);
      await reviewBridgeStore.deleteDraft(payload);
      broadcastState();
      return getPayload();
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async syncReviewBridgePullRequest(payload: any, windowId?: string) {
      const prKey = String(payload?.prKey || "").trim();
      if (!prKey) {
        throw new Error("Pull request key is required.");
      }
      // Publishing queued drafts posts comments to the PR provider — refuse a
      // prKey outside the caller viewer's profile.
      assertPrInViewerProfile(prKey, windowId);
      const prData = reviewBridgeStore.getPullRequestContext?.(prKey);
      const isGitHub = prData?.provider === "github" || github.findSummary(prKey);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await reviewBridgeStore.syncPendingDrafts(prKey, async (entry: any) => {
        if (isGitHub) {
          await github.addPullRequestComment({
            prKey,
            body: entry.body,
            threadId: entry.remoteThreadId,
            filePath: entry.comment?.filePath,
            lineNumber: entry.comment?.lineNumber,
            lineSide: entry.comment?.lineSide,
          });
        } else {
          await azure.addPullRequestComment({
            prKey,
            content: entry.body,
            threadId: entry.remoteThreadId,
            parentCommentId: entry.parentCommentId || 0,
            filePath: entry.comment?.filePath,
            lineNumber: entry.comment?.lineNumber,
            lineSide: entry.comment?.lineSide,
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
  };
}
