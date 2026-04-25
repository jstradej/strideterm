/**
 * Factory for Review Bridge API handlers (shared between Azure DevOps + GitHub).
 * Extracted from runtime-provider-handlers.js for modularity.
 */
export function createReviewBridgeHandlers(ctx) {
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
  } = ctx;

  return {
    async createReviewBridgeDraftComment(payload) {
      await reviewBridgeStore.createDraftComment(payload);
      broadcastState();
      return getPayload();
    },
    async saveReviewBridgeDraft(payload) {
      await reviewBridgeStore.saveDraftResponse(payload);
      broadcastState();
      return getPayload();
    },
    async queueReviewBridgeDraft(payload) {
      await reviewBridgeStore.queueDraftResponse(payload);
      broadcastState();
      return getPayload();
    },
    async saveAgentPrompt(payload) {
      reviewBridgeStore.saveAgentPrompt(payload);
      broadcastState();
      return getPayload();
    },
    async deleteAgentPrompt(payload) {
      reviewBridgeStore.deleteAgentPrompt(payload.promptId);
      broadcastState();
      return getPayload();
    },
    async resetAgentPrompts() {
      reviewBridgeStore.resetAgentPrompts();
      broadcastState();
      return getPayload();
    },
    async replyWithCodeChanges(payload) {
      await reviewBridgeStore.replyWithCodeChanges(payload);
      broadcastState();
      return getPayload();
    },
    async deleteReviewBridgeComment(payload) {
      await reviewBridgeStore.deleteComment(payload);
      broadcastState();
      return getPayload();
    },
    async deleteReviewBridgeDraft(payload) {
      await reviewBridgeStore.deleteDraft(payload);
      broadcastState();
      return getPayload();
    },
    async syncReviewBridgePullRequest(payload) {
      const prKey = String(payload?.prKey || "").trim();
      if (!prKey) {
        throw new Error("Pull request key is required.");
      }
      const prData = reviewBridgeStore.getPullRequestContext?.(prKey);
      const isGitHub = prData?.provider === "github" || github.findSummary(prKey);
      await reviewBridgeStore.syncPendingDrafts(prKey, async (entry) => {
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
    async pushAndPublishReview(payload) {
      const workspaceId = String(payload?.workspaceId || "").trim();
      if (!workspaceId) {
        throw new Error("Workspace ID is required.");
      }
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
        workspace.review?.pullRequest?.sourceRefName || workspace.review?.pullRequest?.sourceBranch || "",
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
        await reviewBridgeStore.syncPendingDrafts(prKey, async (entry) => {
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
      const result = getPayload();
      result.pushAndPublishResult = { commitCount, publishedCount, pushOk, publishError };
      return result;
    },
  };
}
