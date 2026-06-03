import { randomUUID } from "node:crypto";
import { findWorkspace } from "./runtime-utils.js";
import { normalizeWorkspace } from "./default-state.js";
import { normalizeConnectionInput } from "./azure-devops-manager.js";
import type { WorkspaceState, AppState } from "../shared/types/state.js";

/**
 * Runtime context subset consumed by Azure DevOps handlers.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyManager = any;

interface AzureHandlerCtx {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  log: any;
  getState: () => AppState;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  store: any;
  azure: AnyManager;
  git: AnyManager;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sessions: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  credentialStore: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  auditLogStore: any;
  getPayload: () => unknown;
  broadcastState: () => void;
  refreshAzure: () => Promise<unknown>;
  refreshGit: (workspaceId?: string | null) => Promise<void>;
  ensureAzureWorkspace: (profileId?: string) => Promise<WorkspaceState>;
  ensureVisibleSession: (workspaceId?: string) => string | null;
  scheduleAzurePolling: () => void;
  resolveGitWorkspace: (workspaceId?: string, projectId?: string) => WorkspaceState;
  resolveGitRootPath: (workspace: WorkspaceState, rawRootPath: string) => string | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getAzureSettings: (state?: AppState) => any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getAzureConnections: (state?: AppState) => any[];
  /** Viewer-aware profile resolution — accepts window slot ids and remote viewer ids. */
  getViewerProfileId: (viewerId?: string) => string | null;
  /** Mirror an activation into a remote viewer's context (no-op for desktop ids). */
  mirrorRemoteViewerWorkspace: (viewerId: string | undefined, workspaceId: string) => void;
}

/**
 * Factory for Azure DevOps API handlers.
 * Extracted from runtime-provider-handlers.js for modularity.
 */
export function createAzureHandlers(ctx: AzureHandlerCtx) {
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
    getViewerProfileId,
    mirrorRemoteViewerWorkspace,
  } = ctx;

  function resolveRootPath(workspace: WorkspaceState, rawRootPath: string): string {
    const resolved = resolveGitRootPath(workspace, rawRootPath || "");
    if (rawRootPath && !resolved) {
      throw new Error(`Root path not found in workspace gitRoots: ${rawRootPath}`);
    }
    return resolved || "";
  }

  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async verifyAzureConnection(connection: any) {
      return azure.verifyConnection(connection);
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async saveAzureConnection(connection: any, windowId?: string) {
      const normalizedInput = normalizeConnectionInput(connection);
      const connectionId = normalizedInput.id || `ado-${randomUUID()}`;
      const tokenRef = connection.tokenRef || `cred:${connectionId}`;
      const pat = connection.pat || credentialStore.getSecret(tokenRef);
      const verification = await azure.verifyConnection({
        ...normalizedInput,
        pat,
      });
      // When the caller's viewer is known (IPC window / remote client), pin
      // the connection's profile to the viewer's profile. Works for remote
      // clients whose profile has no desktop window — the viewer id resolves
      // through the RemoteClientRegistry. No windowSlots[0] fallback: a
      // caller without a viewer context lands in "default" explicitly.
      const callerWindowProfileId = getViewerProfileId(windowId) || "";
      if (callerWindowProfileId && connection.profileId && connection.profileId !== callerWindowProfileId) {
        throw new Error(
          `Cross-profile refused: saveAzureConnection payload targets profile ${connection.profileId}, window ${windowId} is bound to ${callerWindowProfileId}.`,
        );
      }
      const resolvedProfileId = connection.profileId || callerWindowProfileId || "default";
      log.debug("saveAzureConnection: profile resolution", {
        connectionId,
        incomingProfileId: connection.profileId || null,
        callerProfileId: callerWindowProfileId || null,
        resolvedProfileId,
        existingConnectionsForProfile: getAzureConnections(getState()).filter(
          (c: { profileId?: string }) => (c.profileId || "default") === resolvedProfileId,
        ).length,
      });
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

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await store.mutate((draft: any) => {
        const azureSettings = draft.settings.integrations.azureDevops;
        azureSettings.reviewRoot = normalizedConnection.reviewRoot || azureSettings.reviewRoot;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const index = azureSettings.connections.findIndex((entry: any) => entry.id === connectionId);
        if (index >= 0) {
          azureSettings.connections[index] = normalizedConnection;
        } else {
          azureSettings.connections.push(normalizedConnection);
        }
      });

      // Pass the connection's resolved profile so the inbox workspace lands
      // on the same profile as the connection — without this, ensureX defaults
      // to getState().activeProfileId and the workspace ends up invisible
      // on profiles other than the one that happened to be active first.
      const ensuredWorkspace = await ensureAzureWorkspace(resolvedProfileId);
      log.debug("saveAzureConnection: ensured workspace", {
        connectionId,
        resolvedProfileId,
        workspaceId: ensuredWorkspace?.id,
        workspaceProfileId: ensuredWorkspace?.profileId,
        workspaceName: ensuredWorkspace?.name,
        totalAzureWorkspaces: getState().workspaces.filter((w) => w.kind === "azure").length,
      });
      await refreshAzure();
      scheduleAzurePolling();
      broadcastState();
      return {
        payload: getPayload(),
        verification,
      };
    },
    async deleteAzureConnection(connectionId: string, windowId?: string) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const connection = getAzureConnections().find((entry: any) => entry.id === connectionId);
      // Cross-profile refuse: the connection has a profileId; a remote/IPC
      // caller bound to another profile must not be able to delete it.
      if (windowId && connection) {
        const callerProfileId = getViewerProfileId(windowId) || "";
        const connProfileId = (connection as { profileId?: string }).profileId || "default";
        if (callerProfileId && callerProfileId !== connProfileId) {
          throw new Error(
            `Cross-profile refused: connection ${connectionId} is in profile ${connProfileId}, window ${windowId} is bound to ${callerProfileId}.`,
          );
        }
      }
      if (connection?.tokenRef) {
        await credentialStore.deleteSecret(connection.tokenRef);
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await store.mutate((draft: any) => {
        draft.settings.integrations.azureDevops.connections =
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          draft.settings.integrations.azureDevops.connections.filter((entry: any) => entry.id !== connectionId);
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    queryAzureAuditLog(filters: any = {}) {
      return auditLogStore.query(filters);
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    getAzureAuditStats(filters: any = {}) {
      return auditLogStore.getStats(filters);
    },
    async markAzurePullRequestSeen(prKey: string) {
      await azure.markPullRequestSeen(prKey);
      return getPayload();
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async openAzurePullRequest(payload: any, windowId?: string) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let result: any;
      try {
        const state = getState();
        const callerProfileId = getViewerProfileId(windowId) || "";
        result = await azure.openReviewWorkspace({
          state,
          prKey: payload.prKey,
          workspaceId: payload.workspaceId || "",
          callerProfileId,
        });
      } catch (err) {
        const message =
          err instanceof Error ? err.message : (err as any)?.stderr || (err as any)?.error?.message || String(err); // eslint-disable-line @typescript-eslint/no-explicit-any -- MIGRATION-EXEMPT: error shape is unknown at catch boundary
        log.warn("openAzurePullRequest failed", { prKey: payload.prKey, err: message });
        throw new Error(message, { cause: err });
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await store.mutate((draft: any) => {
        const normalized = normalizeWorkspace(result.workspace);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const index = draft.workspaces.findIndex((entry: any) => entry.id === normalized.id);
        if (index >= 0) {
          draft.workspaces[index] = normalized;
        } else {
          draft.workspaces.push(normalized);
        }
        draft.activeWorkspaceId = normalized.id;
        // Mirror activation into the calling window's slot ONLY when the
        // review workspace lives in the same profile as the slot. The
        // review's profile is decided by the connection (see
        // openReviewWorkspace), so a remote client bound to profile B that
        // requests a PR open for a profile-A connection would otherwise
        // swap a profile-A workspace into slot B. Frontend selector prefers
        // slot.activeWorkspaceId, so without the guard the user in window B
        // would silently jump into profile A's review.
        if (windowId) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const slot = (draft.windowSlots || []).find((s: any) => s.id === windowId);
          if (slot && (normalized.profileId || "default") === slot.profileId) {
            slot.activeWorkspaceId = normalized.id;
          } else if (slot) {
            log.info("openAzurePullRequest: skipping slot mirror (cross-profile)", {
              windowId,
              slotProfileId: slot.profileId,
              workspaceProfileId: normalized.profileId || "default",
            });
          }
        }
      });
      // Remote viewer: activate the review in the CALLER's remote context —
      // desktop windows stay where they were.
      mirrorRemoteViewerWorkspace(windowId, result.workspace.id);
      await refreshGit(result.workspace.id);
      await azure.markPullRequestSeen(payload.prKey);
      await refreshAzure();
      sessions.syncWithState(getState());
      ensureVisibleSession(result.workspace.id);
      broadcastState();
      return getPayload();
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async commentAzurePullRequest(payload: any) {
      await azure.addPullRequestComment(payload);
      await refreshAzure();
      return getPayload();
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async updateAzureThreadStatus(payload: any) {
      await azure.updateThreadStatus(payload);
      await refreshAzure();
      return getPayload();
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async voteAzurePullRequest(payload: any) {
      await azure.setPullRequestVote(payload);
      await refreshAzure();
      return getPayload();
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async rerunAzureCheck(prKey: string, checkItem: any) {
      await azure.rerunCheck(prKey, checkItem);
      broadcastState();
      return getPayload();
    },
    async fetchAzureReviewWorkspace(workspaceId: string) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const workspace = findWorkspace(getState() as any, workspaceId) as WorkspaceState | null;
      if (!workspace?.review) {
        throw new Error("Azure review workspace not found.");
      }
      await azure.fetchReviewWorkspace({ workspace });
      await refreshGit(workspaceId);
      broadcastState();
      return getPayload();
    },
    async rebaseAzureReviewWorkspace(workspaceId: string) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const workspace = findWorkspace(getState() as any, workspaceId) as WorkspaceState | null;
      if (!workspace?.review) {
        throw new Error("Azure review workspace not found.");
      }
      await azure.rebaseReviewWorkspace({ workspace });
      await refreshGit(workspaceId);
      broadcastState();
      return getPayload();
    },
    async pushAzureReviewWorkspace(workspaceId: string, { force = false } = {}) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const workspace = findWorkspace(getState() as any, workspaceId) as WorkspaceState | null;
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async azureCreatePullRequest(payload: any = {}) {
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
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await store.mutate((draft: any) => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const ws = draft.workspaces.find((w: any) => w.id === workspace.id);
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async azureListRemoteBranches(payload: any = {}) {
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async azureQuickFixListProjects(payload: any = {}) {
      return { projects: await azure.listQuickFixProjects(payload.connectionId) };
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async azureQuickFixListRepositories(payload: any = {}) {
      return { repositories: await azure.listQuickFixRepositories(payload.connectionId, payload.projectName) };
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async azureQuickFixListBranches(payload: any = {}) {
      return {
        branches: await azure.listQuickFixBranches(payload.connectionId, payload.projectName, payload.repositoryId),
      };
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async azureQuickFixCreate(payload: any = {}, windowId?: string) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let result: any;
      const state = getState();
      const callerProfileId = getViewerProfileId(windowId) || "";
      try {
        result = await azure.openQuickFixWorkspace({
          state,
          connectionId: payload.connectionId,
          projectName: payload.projectName,
          repositoryId: payload.repositoryId,
          repositoryName: payload.repositoryName,
          remoteUrl: payload.remoteUrl,
          baseBranch: payload.baseBranch,
          newBranchName: payload.newBranchName,
          callerProfileId,
        });
      } catch (err) {
        const message =
          err instanceof Error ? err.message : (err as any)?.stderr || (err as any)?.error?.message || String(err); // eslint-disable-line @typescript-eslint/no-explicit-any -- MIGRATION-EXEMPT: error shape is unknown at catch boundary
        log.warn("azureQuickFixCreate failed", { repositoryName: payload.repositoryName, err: message });
        throw new Error(message, { cause: err });
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await store.mutate((draft: any) => {
        const normalized = normalizeWorkspace(result.workspace);
        const parentId = result.parentWorkspaceId;
        if (parentId) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          let insertIdx = draft.workspaces.findIndex((ws: any) => ws.id === parentId);
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
        // See openAzurePullRequest for the cross-profile guard rationale.
        if (windowId) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const slot = (draft.windowSlots || []).find((s: any) => s.id === windowId);
          if (slot && (normalized.profileId || "default") === slot.profileId) {
            slot.activeWorkspaceId = normalized.id;
          } else if (slot) {
            log.info("azureQuickFixCreate: skipping slot mirror (cross-profile)", {
              windowId,
              slotProfileId: slot.profileId,
              workspaceProfileId: normalized.profileId || "default",
            });
          }
        }
      });
      // Remote viewer: activate the quickfix in the CALLER's remote context.
      mirrorRemoteViewerWorkspace(windowId, result.workspace.id);
      await refreshGit(result.workspace.id);
      sessions.syncWithState(getState());
      ensureVisibleSession(result.workspace.id);
      broadcastState();
      return getPayload();
    },
  };
}
