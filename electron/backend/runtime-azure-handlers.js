import { randomUUID } from "node:crypto";
import { findWorkspace } from "./runtime-utils.js";
import { normalizeWorkspace } from "./default-state.js";
import { normalizeConnectionInput } from "./azure-devops-manager.js";

/**
 * Factory for Azure DevOps API handlers.
 * Extracted from runtime-provider-handlers.js for modularity.
 */
export function createAzureHandlers(ctx) {
  const {
    log,
    getState,
    store,
    azure,
    git,
    sessions,
    credentialStore,
    auditLogStore,
    getPayload,
    broadcastState,
    refreshAzure,
    refreshGit,
    ensureAzureWorkspace,
    ensureVisibleSession,
    scheduleAzurePolling,
    resolveGitWorkspace,
    resolveGitRootPath,
    getAzureSettings,
    getAzureConnections,
  } = ctx;

  function resolveRootPath(workspace, rawRootPath) {
    const resolved = resolveGitRootPath(workspace, rawRootPath || "");
    if (rawRootPath && !resolved) {
      throw new Error(`Root path not found in workspace gitRoots: ${rawRootPath}`);
    }
    return resolved || "";
  }

  return {
    async verifyAzureConnection(connection) {
      return azure.verifyConnection(connection);
    },
    async saveAzureConnection(connection) {
      const normalizedInput = normalizeConnectionInput(connection);
      const connectionId = normalizedInput.id || `ado-${randomUUID()}`;
      const tokenRef = connection.tokenRef || `cred:${connectionId}`;
      const pat = connection.pat || credentialStore.getSecret(tokenRef);
      const verification = await azure.verifyConnection({
        ...normalizedInput,
        pat,
      });
      const resolvedProfileId = connection.profileId || getState().activeProfileId || "default";
      const normalizedConnection = {
        id: connectionId,
        label: String(normalizedInput.label || connectionId).trim(),
        orgUrl: String(normalizedInput.orgUrl || "")
          .trim()
          .replace(/\/+$/, ""),
        login: String(normalizedInput.login || "").trim(),
        tokenRef,
        enabled: normalizedInput.enabled !== false,
        profileId: resolvedProfileId,
        projectFilters: Array.isArray(normalizedInput.projectFilters) ? [...normalizedInput.projectFilters] : [],
        repositoryFilters: Array.isArray(normalizedInput.repositoryFilters)
          ? [...normalizedInput.repositoryFilters]
          : [],
        pollSeconds: Number(normalizedInput.pollSeconds) || getAzureSettings().defaultPollSeconds || 120,
        reviewRoot: String(normalizedInput.reviewRoot || getAzureSettings().reviewRoot || "").trim(),
      };

      if (pat) {
        await credentialStore.setSecret(tokenRef, pat);
      }

      await store.mutate((draft) => {
        const azureSettings = draft.settings.integrations.azureDevops;
        azureSettings.reviewRoot = normalizedConnection.reviewRoot || azureSettings.reviewRoot;
        const index = azureSettings.connections.findIndex((entry) => entry.id === connectionId);
        if (index >= 0) {
          azureSettings.connections[index] = normalizedConnection;
        } else {
          azureSettings.connections.push(normalizedConnection);
        }
      });

      await ensureAzureWorkspace();
      await refreshAzure();
      scheduleAzurePolling();
      broadcastState();
      return {
        payload: getPayload(),
        verification,
      };
    },
    async deleteAzureConnection(connectionId) {
      const connection = getAzureConnections().find((entry) => entry.id === connectionId);
      if (connection?.tokenRef) {
        await credentialStore.deleteSecret(connection.tokenRef);
      }
      await store.mutate((draft) => {
        draft.settings.integrations.azureDevops.connections =
          draft.settings.integrations.azureDevops.connections.filter((entry) => entry.id !== connectionId);
      });
      await refreshAzure();
      scheduleAzurePolling();
      broadcastState();
      return getPayload();
    },
    async refreshAzureState() {
      const activeWsId = getState().activeWorkspaceId;
      await refreshGit(activeWsId);
      await refreshAzure();
      return getPayload();
    },
    queryAzureAuditLog(filters = {}) {
      return auditLogStore.query(filters);
    },
    getAzureAuditStats(filters = {}) {
      return auditLogStore.getStats(filters);
    },
    async markAzurePullRequestSeen(prKey) {
      await azure.markPullRequestSeen(prKey);
      return getPayload();
    },
    async openAzurePullRequest(payload) {
      let result;
      try {
        result = await azure.openReviewWorkspace({
          state: getState(),
          prKey: payload.prKey,
          workspaceId: payload.workspaceId || "",
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : err?.stderr || err?.error?.message || String(err);
        log.warn("openAzurePullRequest failed", { prKey: payload.prKey, err: message });
        throw new Error(message, { cause: err });
      }
      await store.mutate((draft) => {
        const normalized = normalizeWorkspace(result.workspace);
        const index = draft.workspaces.findIndex((entry) => entry.id === normalized.id);
        if (index >= 0) {
          draft.workspaces[index] = normalized;
        } else {
          draft.workspaces.push(normalized);
        }
        draft.activeWorkspaceId = normalized.id;
      });
      await refreshGit(result.workspace.id);
      await azure.markPullRequestSeen(payload.prKey);
      await refreshAzure();
      sessions.syncWithState(getState());
      ensureVisibleSession(result.workspace.id);
      broadcastState();
      return getPayload();
    },
    async commentAzurePullRequest(payload) {
      await azure.addPullRequestComment(payload);
      await refreshAzure();
      return getPayload();
    },
    async updateAzureThreadStatus(payload) {
      await azure.updateThreadStatus(payload);
      await refreshAzure();
      return getPayload();
    },
    async voteAzurePullRequest(payload) {
      await azure.setPullRequestVote(payload);
      await refreshAzure();
      return getPayload();
    },
    async rerunAzureCheck(prKey, checkItem) {
      await azure.rerunCheck(prKey, checkItem);
      broadcastState();
      return getPayload();
    },
    async fetchAzureReviewWorkspace(workspaceId, { pullFfOnly = false } = {}) {
      const workspace = findWorkspace(getState(), workspaceId);
      if (!workspace?.review) {
        throw new Error("Azure review workspace not found.");
      }
      await azure.fetchReviewWorkspace({ workspace, pullFfOnly });
      await refreshGit(workspaceId);
      broadcastState();
      return getPayload();
    },
    async rebaseAzureReviewWorkspace(workspaceId) {
      const workspace = findWorkspace(getState(), workspaceId);
      if (!workspace?.review) {
        throw new Error("Azure review workspace not found.");
      }
      await azure.rebaseReviewWorkspace({ workspace });
      await refreshGit(workspaceId);
      broadcastState();
      return getPayload();
    },
    async pushAzureReviewWorkspace(workspaceId, { force = false } = {}) {
      const workspace = findWorkspace(getState(), workspaceId);
      if (!workspace?.review) {
        throw new Error("Azure review workspace not found.");
      }
      const dirtyState = await git.getCachedWorktreeDirtyState(workspace.cwd);
      if (dirtyState.dirty) {
        throw new Error(
          `Cannot push: ${dirtyState.dirtyCount} uncommitted change${dirtyState.dirtyCount !== 1 ? "s" : ""} in the worktree. ` +
            "Commit your changes first, then try again.",
        );
      }
      const snapshot = git.getSnapshot(workspaceId);
      await azure.pushReviewWorkspace({ workspace, force, branch: snapshot?.branch });
      await refreshGit(workspaceId);
      await refreshAzure();
      return getPayload();
    },
    async azureCreatePullRequest(payload = {}) {
      const workspace = resolveGitWorkspace(payload.workspaceId);
      const rootPath = resolveRootPath(workspace, payload.rootPath);
      const snapshot = git.getSnapshot(workspace.id, rootPath);
      if (!snapshot?.available) throw new Error("Git workspace is unavailable.");
      const remoteUrl = snapshot.remotes?.origin || "";
      if (!remoteUrl) throw new Error("No origin remote found for this workspace.");
      const result = await azure.createPullRequestForWorkspace({
        remoteUrl,
        sourceBranch: payload.sourceBranch || snapshot.branch,
        targetBranch: payload.targetBranch,
        title: payload.title,
        description: payload.description || "",
        isDraft: payload.isDraft || false,
        connectionId:
          payload.connectionId ||
          workspace.connectionId ||
          workspace.review?.connectionId ||
          workspace.quickfix?.connectionId ||
          "",
      });

      // Promote quickfix workspace -> full review workspace after PR creation
      if (workspace.quickfix && result.pullRequestId) {
        const qf = workspace.quickfix;
        const prKey = azure.buildPrKey(qf.connectionId, qf.repositoryId, result.pullRequestId);
        await store.mutate((draft) => {
          const ws = draft.workspaces.find((w) => w.id === workspace.id);
          if (ws) {
            ws.name = `${qf.repositoryName} PR #${result.pullRequestId}`;
            ws.review = {
              ...(ws.review || {}),
              provider: "azure-devops",
              prKey,
              connectionId: qf.connectionId,
              orgUrl: ws.review?.orgUrl || "",
              parentWorkspaceId: ws.review?.parentWorkspaceId || qf.parentWorkspaceId || "",
              project: { id: "", name: qf.projectName },
              repository: { id: qf.repositoryId, name: qf.repositoryName, remoteUrl: qf.remoteUrl },
              pullRequest: {
                id: result.pullRequestId,
                title: result.title || payload.title || "",
                status: "active",
                mergeStatus: "",
                url: result.url || "",
                webUrl: result.url || "",
                sourceRefName: `refs/heads/${payload.sourceBranch || snapshot.branch}`,
                targetRefName: `refs/heads/${payload.targetBranch}`,
              },
              role: "author",
              checkout: ws.review?.checkout || {
                mode: "managed-worktree",
                rootPath: rootPath || workspace.cwd,
                cacheRepoPath: "",
              },
            };
            ws.quickfix = null;
          }
        });
        await azure.reviewStore?.upsertTrackedPullRequest(prKey, {
          reviewWorkspaceId: workspace.id,
          lastSeenActivityAt: new Date().toISOString(),
        });

        azure.seedPullRequestSummary(prKey, {
          connectionId: qf.connectionId,
          prKey,
          project: { id: "", name: qf.projectName },
          repository: { id: qf.repositoryId, name: qf.repositoryName, remoteUrl: qf.remoteUrl },
          pullRequest: {
            id: result.pullRequestId,
            title: result.title || payload.title || "",
            status: "active",
            mergeStatus: "",
            url: result.url || "",
            webUrl: result.url || "",
            sourceRefName: `refs/heads/${payload.sourceBranch || snapshot.branch}`,
            targetRefName: `refs/heads/${payload.targetBranch}`,
          },
          role: "author",
          reviewWorkspaceId: workspace.id,
          lastRemoteActivityAt: new Date().toISOString(),
        });
      }

      await refreshGit(workspace.id);
      await refreshAzure();
      broadcastState();
      return { payload: getPayload(), result };
    },
    async azureListRemoteBranches(payload = {}) {
      const workspace = resolveGitWorkspace(payload.workspaceId);
      const rootPath = resolveRootPath(workspace, payload.rootPath);
      const snapshot = git.getSnapshot(workspace.id, rootPath);
      if (!snapshot?.available) throw new Error("Git workspace is unavailable.");
      const remoteUrl = snapshot.remotes?.origin || "";
      if (!remoteUrl) throw new Error("No origin remote found for this workspace.");
      const connection = azure.findConnectionForRemote(remoteUrl);
      if (!connection) return { branches: [] };
      const branches = await azure.listRemoteBranches(connection.id, remoteUrl);
      return { branches };
    },
    async azureQuickFixListProjects(payload = {}) {
      return { projects: await azure.listQuickFixProjects(payload.connectionId) };
    },
    async azureQuickFixListRepositories(payload = {}) {
      return { repositories: await azure.listQuickFixRepositories(payload.connectionId, payload.projectName) };
    },
    async azureQuickFixListBranches(payload = {}) {
      return {
        branches: await azure.listQuickFixBranches(payload.connectionId, payload.projectName, payload.repositoryId),
      };
    },
    async azureQuickFixCreate(payload = {}) {
      let result;
      try {
        result = await azure.openQuickFixWorkspace({
          state: getState(),
          connectionId: payload.connectionId,
          projectName: payload.projectName,
          repositoryId: payload.repositoryId,
          repositoryName: payload.repositoryName,
          remoteUrl: payload.remoteUrl,
          baseBranch: payload.baseBranch,
          newBranchName: payload.newBranchName,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : err?.stderr || err?.error?.message || String(err);
        log.warn("azureQuickFixCreate failed", { repositoryName: payload.repositoryName, err: message });
        throw new Error(message, { cause: err });
      }
      await store.mutate((draft) => {
        const normalized = normalizeWorkspace(result.workspace);
        const parentId = result.parentWorkspaceId;
        if (parentId) {
          let insertIdx = draft.workspaces.findIndex((ws) => ws.id === parentId);
          if (insertIdx >= 0) {
            insertIdx++;
            while (insertIdx < draft.workspaces.length) {
              const ws = draft.workspaces[insertIdx];
              const isChild =
                ws.review?.checkout?.mode === "managed-worktree" ||
                ws.quickfix?.parentWorkspaceId === parentId ||
                ((ws.notes || "").startsWith("Worktree of ") && ws.review?.parentWorkspaceId === parentId);
              if (!isChild) break;
              insertIdx++;
            }
            draft.workspaces.splice(insertIdx, 0, normalized);
          } else {
            draft.workspaces.push(normalized);
          }
        } else {
          draft.workspaces.push(normalized);
        }
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
