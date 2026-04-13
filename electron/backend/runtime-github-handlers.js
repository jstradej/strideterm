import { randomUUID } from "node:crypto";
import { findWorkspace } from "./runtime-utils.js";
import { normalizeWorkspace } from "./default-state.js";

/**
 * Factory for GitHub API handlers.
 * Extracted from runtime-provider-handlers.js for modularity.
 */
export function createGitHubHandlers(ctx) {
  const {
    getState,
    store,
    github,
    git,
    sessions,
    credentialStore,
    githubAuditLogStore,
    azureReviewStore,
    getPayload,
    broadcastState,
    refreshGitHub,
    refreshGit,
    ensureGitHubWorkspace,
    ensureVisibleSession,
    scheduleGitHubPolling,
    resolveGitWorkspace,
    getGitHubSettings,
    getGitHubConnections,
  } = ctx;

  return {
    async verifyGitHubConnection(connection) {
      return github.verifyConnection(connection);
    },
    async saveGitHubConnection(connection) {
      const { normalizeConnectionInput: normalizeGH, deriveApiBaseUrl } = await import("./github-utils.js");
      const normalizedInput = normalizeGH(connection);
      const connectionId = normalizedInput.id || `gh-${randomUUID()}`;
      const tokenRef = connection.tokenRef || `cred:${connectionId}`;
      const pat = connection.pat || credentialStore.getSecret(tokenRef);
      const verification = await github.verifyConnection({ ...normalizedInput, pat });
      const resolvedProfileId = connection.profileId || getState().activeProfileId || "default";
      const normalizedConnection = {
        id: connectionId,
        label: String(normalizedInput.label || connectionId).trim(),
        hostUrl: String(normalizedInput.hostUrl || "https://github.com")
          .trim()
          .replace(/\/+$/, ""),
        apiBaseUrl: normalizedInput.apiBaseUrl || deriveApiBaseUrl(normalizedInput.hostUrl),
        currentUserLogin: verification.login || normalizedInput.currentUserLogin || "",
        tokenRef,
        enabled: normalizedInput.enabled !== false,
        profileId: resolvedProfileId,
        ownerFilters: Array.isArray(normalizedInput.ownerFilters) ? [...normalizedInput.ownerFilters] : [],
        repositoryFilters: Array.isArray(normalizedInput.repositoryFilters)
          ? [...normalizedInput.repositoryFilters]
          : [],
        pollSeconds: Number(normalizedInput.pollSeconds) || getGitHubSettings().defaultPollSeconds || 120,
        reviewRoot: String(normalizedInput.reviewRoot || getGitHubSettings().reviewRoot || "").trim(),
      };
      if (pat) {
        await credentialStore.setSecret(tokenRef, pat);
      }
      await store.mutate((draft) => {
        const ghSettings = draft.settings.integrations.github;
        ghSettings.reviewRoot = normalizedConnection.reviewRoot || ghSettings.reviewRoot;
        const index = ghSettings.connections.findIndex((c) => c.id === connectionId);
        if (index >= 0) {
          ghSettings.connections[index] = normalizedConnection;
        } else {
          ghSettings.connections.push(normalizedConnection);
        }
      });
      await ensureGitHubWorkspace();
      await refreshGitHub();
      scheduleGitHubPolling();
      broadcastState();
      return { payload: getPayload(), verification };
    },
    async deleteGitHubConnection(connectionId) {
      const connection = getGitHubConnections().find((c) => c.id === connectionId);
      if (connection?.tokenRef) {
        await credentialStore.deleteSecret(connection.tokenRef);
      }
      await store.mutate((draft) => {
        draft.settings.integrations.github.connections = draft.settings.integrations.github.connections.filter(
          (c) => c.id !== connectionId,
        );
      });
      await refreshGitHub();
      scheduleGitHubPolling();
      broadcastState();
      return getPayload();
    },
    async refreshGitHubState() {
      const activeWsId = getState().activeWorkspaceId;
      await refreshGit(activeWsId);
      await refreshGitHub();
      return getPayload();
    },
    queryGitHubAuditLog(filters = {}) {
      return githubAuditLogStore.query(filters);
    },
    getGitHubAuditStats(filters = {}) {
      return githubAuditLogStore.getStats(filters);
    },
    async markGitHubPullRequestSeen(prKey) {
      await github.markPullRequestSeen(prKey);
      return getPayload();
    },
    async openGitHubPullRequest(payload) {
      let result;
      try {
        result = await github.openReviewWorkspace({
          state: getState(),
          prKey: payload.prKey,
          workspaceId: payload.workspaceId || "",
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : err?.stderr || err?.error?.message || String(err);
        throw new Error(message, { cause: err });
      }
      await store.mutate((draft) => {
        const normalized = normalizeWorkspace(result.workspace);
        const index = draft.workspaces.findIndex((ws) => ws.id === normalized.id);
        if (index >= 0) {
          draft.workspaces[index] = normalized;
        } else {
          draft.workspaces.push(normalized);
        }
        draft.activeWorkspaceId = normalized.id;
      });
      await refreshGit(result.workspace.id);
      await github.markPullRequestSeen(payload.prKey);
      await refreshGitHub();
      sessions.syncWithState(getState());
      ensureVisibleSession(result.workspace.id);
      broadcastState();
      return getPayload();
    },
    async commentGitHubPullRequest(payload) {
      await github.addPullRequestComment(payload);
      await refreshGitHub();
      return getPayload();
    },
    async submitGitHubPullRequestReview(payload) {
      await github.submitPullRequestReview(payload);
      await refreshGitHub();
      return getPayload();
    },
    async rerunGitHubCheck(prKey, checkItem) {
      await github.rerunCheck(prKey, checkItem);
      broadcastState();
      return getPayload();
    },
    async fetchGitHubReviewWorkspace(workspaceId) {
      const workspace = findWorkspace(getState(), workspaceId);
      if (!workspace?.review) throw new Error("GitHub review workspace not found.");
      await github.fetchReviewWorkspace({ workspace });
      await refreshGit(workspaceId);
      broadcastState();
      return getPayload();
    },
    async rebaseGitHubReviewWorkspace(workspaceId) {
      const workspace = findWorkspace(getState(), workspaceId);
      if (!workspace?.review) throw new Error("GitHub review workspace not found.");
      await github.rebaseReviewWorkspace({ workspace });
      await refreshGit(workspaceId);
      broadcastState();
      return getPayload();
    },
    async pushGitHubReviewWorkspace(workspaceId, { force = false } = {}) {
      const workspace = findWorkspace(getState(), workspaceId);
      if (!workspace?.review) throw new Error("GitHub review workspace not found.");
      const dirtyState = await git.getCachedWorktreeDirtyState(workspace.cwd);
      if (dirtyState.dirty) {
        throw new Error(
          `Cannot push: ${dirtyState.dirtyCount} uncommitted change${dirtyState.dirtyCount !== 1 ? "s" : ""} in the worktree. ` +
            "Commit your changes first, then try again.",
        );
      }
      const snapshot = git.getSnapshot(workspaceId);
      await github.pushReviewWorkspace({ workspace, force, branch: snapshot?.branch });
      await refreshGit(workspaceId);
      await refreshGitHub();
      return getPayload();
    },
    async githubListRemoteBranches(payload) {
      const workspace = resolveGitWorkspace(payload.workspaceId);
      const connectionId =
        workspace.connectionId || workspace.review?.connectionId || workspace.quickfix?.connectionId || "";
      if (!connectionId) throw new Error("No GitHub connection associated with this workspace.");
      const snapshot = git.getSnapshot(workspace.id);
      const remoteUrl = snapshot?.remotes?.origin || "";
      const match = remoteUrl.match(/github\.com[/:]([^/]+)\/([^/.]+)/);
      if (!match) throw new Error("Cannot determine GitHub owner/repo from remote URL.");
      const branches = await github.listRemoteBranches(connectionId, match[1], match[2]);
      return { branches };
    },
    async githubCreatePullRequest(payload = {}) {
      const workspace = resolveGitWorkspace(payload.workspaceId);
      const connectionId =
        workspace.connectionId || workspace.review?.connectionId || workspace.quickfix?.connectionId || "";
      if (!connectionId) throw new Error("No GitHub connection associated with this workspace.");
      const snapshot = git.getSnapshot(workspace.id);
      if (!snapshot?.available) throw new Error("Git workspace is unavailable.");
      const remoteUrl = snapshot.remotes?.origin || "";
      const match = remoteUrl.match(/github\.com[/:]([^/]+)\/([^/.]+)/);
      if (!match) throw new Error("Cannot determine GitHub owner/repo from remote URL.");
      const owner = match[1];
      const repo = match[2];
      const sourceBranch = payload.sourceBranch || snapshot.branch;
      const result = await github.createPullRequestForWorkspace({
        connectionId,
        owner,
        repo,
        sourceBranch,
        targetBranch: payload.targetBranch,
        title: payload.title,
        description: payload.description || "",
        isDraft: payload.isDraft || false,
      });

      if (workspace.quickfix && result.pullRequestNumber) {
        const { createPullRequestKey: ghPrKey } = await import("./github-utils.js");
        const prKey = ghPrKey(connectionId, owner, repo, result.pullRequestNumber);
        await store.mutate((draft) => {
          const ws = draft.workspaces.find((w) => w.id === workspace.id);
          if (ws) {
            ws.name = `${owner}/${repo} PR #${result.pullRequestNumber}`;
            ws.review = {
              ...(ws.review || {}),
              provider: "github",
              prKey,
              connectionId,
              hostUrl: ws.review?.hostUrl || "",
              parentWorkspaceId: ws.review?.parentWorkspaceId || ws.quickfix?.parentWorkspaceId || "",
              repository: { owner, name: repo, fullName: `${owner}/${repo}`, remoteUrl },
              pullRequest: {
                id: result.pullRequestNumber,
                number: result.pullRequestNumber,
                title: result.title || payload.title || "",
                status: "open",
                mergeStatus: "",
                url: result.url || "",
                webUrl: result.url || "",
                sourceRefName: sourceBranch,
                targetRefName: payload.targetBranch,
              },
              role: "author",
              checkout: ws.review?.checkout || {
                mode: "managed-worktree",
                rootPath: workspace.cwd,
                cacheRepoPath: "",
              },
            };
            ws.quickfix = null;
          }
        });
        await azureReviewStore.upsertTrackedPullRequest(prKey, {
          reviewWorkspaceId: workspace.id,
          lastSeenActivityAt: new Date().toISOString(),
        });

        github.seedPullRequestSummary(prKey, {
          connectionId,
          prKey,
          repository: { owner, name: repo, fullName: `${owner}/${repo}`, remoteUrl },
          pullRequest: {
            id: result.pullRequestNumber,
            number: result.pullRequestNumber,
            title: result.title || payload.title || "",
            status: "open",
            mergeStatus: "",
            url: result.url || "",
            webUrl: result.url || "",
            headSha: "",
            sourceRefName: sourceBranch,
            targetRefName: payload.targetBranch,
          },
          role: "author",
          reviewWorkspaceId: workspace.id,
          lastRemoteActivityAt: new Date().toISOString(),
        });
      }

      await refreshGit(workspace.id);
      await refreshGitHub();
      broadcastState();
      return { result, payload: getPayload() };
    },
    async githubQuickFixListRepos(payload) {
      return { repositories: await github.listQuickFixRepositories(payload.connectionId) };
    },
    async githubQuickFixListBranches(payload) {
      return { branches: await github.listQuickFixBranches(payload.connectionId, payload.owner, payload.repo) };
    },
    async githubQuickFixCreate(payload) {
      const result = await github.openQuickFixWorkspace({
        state: getState(),
        connectionId: payload.connectionId,
        owner: payload.owner,
        repo: payload.repo,
        remoteUrl: payload.remoteUrl,
        baseBranch: payload.baseBranch,
        newBranchName: payload.newBranchName,
      });
      await store.mutate((draft) => {
        const normalized = normalizeWorkspace(result.workspace);
        draft.workspaces.push(normalized);
        draft.activeWorkspaceId = normalized.id;
      });
      await refreshGit(result.workspace.id);
      sessions.syncWithState(getState());
      ensureVisibleSession(result.workspace.id);
      broadcastState();
      return getPayload();
    },
  };
}
