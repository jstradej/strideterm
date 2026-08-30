import { randomUUID } from "node:crypto";
import { findWorkspace, markWorkspaceWorked } from "./runtime-utils.js";
import { normalizeWorkspace } from "./default-state.js";
import { insertWorkspace } from "./workspace-order.js";
import {
  resolveRootPath as resolveRootPathShared,
  assertPrInViewerProfile as assertPrInViewerProfileShared,
  mirrorActivationIntoSlot,
  assertWorktreeCleanForPush,
  resolveReviewWorkTarget,
} from "./shared/runtime-provider-guards.js";
import type { WorkspaceState, AppState } from "../shared/types/state.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyManager = any;

interface GitHubHandlerCtx {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  log: any;
  getState: () => AppState;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  store: any;
  github: AnyManager;
  git: AnyManager;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sessions: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  credentialStore: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  githubAuditLogStore: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  azureReviewStore: any;
  getPayload: () => unknown;
  broadcastState: () => void;
  refreshGitHub: () => Promise<unknown>;
  refreshGit: (workspaceId?: string | null) => Promise<void>;
  ensureGitHubWorkspace: (profileId?: string) => Promise<WorkspaceState>;
  ensureVisibleSession: (workspaceId?: string) => string | null;
  scheduleGitHubPolling: () => void;
  resolveGitWorkspace: (workspaceId?: string, projectId?: string) => WorkspaceState;
  resolveGitRootPath: (workspace: WorkspaceState, rawRootPath: string) => string | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getGitHubSettings: (state?: AppState) => any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getGitHubConnections: (state?: AppState) => any[];
  /** Viewer-aware profile resolution — accepts window slot ids and remote viewer ids. */
  getViewerProfileId: (viewerId?: string) => string | null;
  getViewerActiveWorkspaceId: (viewerId?: string) => string;
  /** Mirror an activation into a remote viewer's context (no-op for desktop ids). */
  mirrorRemoteViewerWorkspace: (viewerId: string | undefined, workspaceId: string) => void;
  /** Refuse a workspace-id-addressed op when it does not belong to the caller's profile. */
  assertWorkspaceInViewerProfile: (workspaceId: string, windowId?: string) => void;
  /** Stamp `lastWorkedAt` after an allowlisted user action succeeded. */
  recordWorkspaceWork: (workspaceId: string, viewerId?: string) => Promise<void>;
}

/**
 * Factory for GitHub API handlers.
 * Extracted from runtime-provider-handlers.js for modularity.
 */
export function createGitHubHandlers(ctx: GitHubHandlerCtx) {
  const {
    log,
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
    resolveGitRootPath,
    getGitHubSettings,
    getGitHubConnections,
    getViewerProfileId,
    getViewerActiveWorkspaceId,
    mirrorRemoteViewerWorkspace,
    assertWorkspaceInViewerProfile,
    recordWorkspaceWork,
  } = ctx;

  function resolveRootPath(workspace: WorkspaceState, rawRootPath: string): string {
    return resolveRootPathShared(resolveGitRootPath, workspace, rawRootPath);
  }

  /**
   * Credit a successful review action to the workspace it belongs to: the
   * review workspace this PR is checked out in, or — when there is none and
   * the viewer is acting from this profile's own GitHub inbox — that inbox.
   * Symmetric with the Azure handler; see `resolveReviewWorkTarget` for the
   * rationale and the guards.
   */
  async function recordWorkForPr(prKey: string, windowId?: string): Promise<void> {
    const target = resolveReviewWorkTarget(
      { getState, getPayload, getViewerActiveWorkspaceId, getViewerProfileId },
      { snapshotKey: "github", workspaceKind: "github" },
      prKey,
      windowId,
    );
    if (target) await recordWorkspaceWork(target, windowId);
  }

  /**
   * Refuse a per-PR mutation (mark-seen / comment / review) when the PR does not
   * belong to the calling VIEWER's profile. See
   * shared/runtime-provider-guards.ts#assertPrInViewerProfile for the full
   * rationale — this is a thin per-provider delegate pinned to the "github"
   * payload slice.
   */
  function assertPrInViewerProfile(prKey: string, windowId?: string): void {
    assertPrInViewerProfileShared({ getPayload, getViewerProfileId }, "github", prKey, windowId);
  }

  // Coalesces concurrent "sync review source" calls per workspace — see
  // runtime-azure-handlers.ts's azureSyncInFlight for the full rationale.
  const githubSyncInFlight = new Map<string, Promise<unknown>>();

  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async verifyGitHubConnection(connection: any) {
      return github.verifyConnection(connection);
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async saveGitHubConnection(connection: any, windowId?: string) {
      const { normalizeConnectionInput: normalizeGH, deriveApiBaseUrl } = await import("./github-utils.js");
      const normalizedInput = normalizeGH(connection);
      const connectionId = normalizedInput.id || `gh-${randomUUID()}`;
      const tokenRef = connection.tokenRef || `cred:${connectionId}`;
      const pat = connection.pat || credentialStore.getSecret(tokenRef);
      const verification = await github.verifyConnection({ ...normalizedInput, pat });
      // See saveAzureConnection — same cross-profile guard, viewer-aware
      // (window slot ids and remote viewer ids), no windowSlots[0] fallback.
      const callerWindowProfileId = getViewerProfileId(windowId) || "";
      if (callerWindowProfileId && connection.profileId && connection.profileId !== callerWindowProfileId) {
        throw new Error(
          `Cross-profile refused: saveGitHubConnection payload targets profile ${connection.profileId}, window ${windowId} is bound to ${callerWindowProfileId}.`,
        );
      }
      const resolvedProfileId = connection.profileId || callerWindowProfileId || "default";
      log.debug("saveGitHubConnection: profile resolution", {
        connectionId,
        incomingProfileId: connection.profileId || null,
        callerProfileId: callerWindowProfileId || null,
        resolvedProfileId,
      });
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
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await store.mutate((draft: any) => {
        const ghSettings = draft.settings.integrations.github;
        ghSettings.reviewRoot = normalizedConnection.reviewRoot || ghSettings.reviewRoot;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const index = ghSettings.connections.findIndex((c: any) => c.id === connectionId);
        if (index >= 0) {
          ghSettings.connections[index] = normalizedConnection;
        } else {
          ghSettings.connections.push(normalizedConnection);
        }
      });
      // Pass the resolved profile so the inbox workspace lives on the same
      // profile as the connection (not just whatever profile happens to be
      // active in the UI right now).
      const ensuredWorkspace = await ensureGitHubWorkspace(resolvedProfileId);
      log.debug("saveGitHubConnection: ensured workspace", {
        connectionId,
        resolvedProfileId,
        workspaceId: ensuredWorkspace?.id,
        workspaceProfileId: ensuredWorkspace?.profileId,
      });
      await refreshGitHub();
      scheduleGitHubPolling();
      broadcastState();
      return { payload: getPayload(), verification };
    },
    async deleteGitHubConnection(connectionId: string, windowId?: string) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const connection = getGitHubConnections().find((c: any) => c.id === connectionId);
      // Cross-profile refuse — see deleteAzureConnection for the rationale.
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
        draft.settings.integrations.github.connections = draft.settings.integrations.github.connections.filter(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (c: any) => c.id !== connectionId,
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    queryGitHubAuditLog(filters: any = {}) {
      return githubAuditLogStore.query(filters);
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    getGitHubAuditStats(filters: any = {}) {
      return githubAuditLogStore.getStats(filters);
    },
    async markGitHubPullRequestSeen(prKey: string, windowId?: string) {
      assertPrInViewerProfile(prKey, windowId);
      await github.markPullRequestSeen(prKey);
      return getPayload();
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async openGitHubPullRequest(payload: any, windowId?: string) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let result: any;
      try {
        const state = getState();
        const callerProfileId = getViewerProfileId(windowId) || "";
        result = await github.openReviewWorkspace({
          state,
          prKey: payload.prKey,
          workspaceId: payload.workspaceId || "",
          callerProfileId,
        });
      } catch (err) {
        const message =
          err instanceof Error ? err.message : (err as any)?.stderr || (err as any)?.error?.message || String(err); // eslint-disable-line @typescript-eslint/no-explicit-any -- MIGRATION-EXEMPT: error shape is unknown at catch boundary
        log.warn("openGitHubPullRequest failed", { prKey: payload.prKey, err: message });
        throw new Error(message, { cause: err });
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await store.mutate((draft: any) => {
        const normalized = normalizeWorkspace(result.workspace);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const index = draft.workspaces.findIndex((ws: any) => ws.id === normalized.id);
        if (index >= 0) {
          // Re-opening an existing review workspace is navigation, not work,
          // and must not erase the stamp the workspace already carries.
          const priorWorkedAt = draft.workspaces[index]?.lastWorkedAt;
          if (priorWorkedAt) normalized.lastWorkedAt = priorWorkedAt;
          draft.workspaces[index] = normalized;
        } else {
          insertWorkspace(draft.workspaces, normalized, getViewerActiveWorkspaceId(windowId));
          // Creating a review workspace IS work (V2 plan allowlist).
          markWorkspaceWorked(draft, normalized.id);
        }
        draft.activeWorkspaceId = normalized.id;
        // Mirror only when the review workspace's profile matches the slot's.
        // See shared/runtime-provider-guards.ts#mirrorActivationIntoSlot for
        // the full cross-profile bug story.
        const mirrorResult = mirrorActivationIntoSlot(draft, windowId, normalized);
        if (mirrorResult && !mirrorResult.mirrored) {
          log.info("openGitHubPullRequest: skipping slot mirror (cross-profile)", {
            windowId,
            slotProfileId: mirrorResult.slotProfileId,
            workspaceProfileId: mirrorResult.workspaceProfileId,
          });
        }
      });
      // Remote viewer: activate the review in the CALLER's remote context —
      // desktop windows stay where they were.
      mirrorRemoteViewerWorkspace(windowId, result.workspace.id);
      await refreshGit(result.workspace.id);
      await github.markPullRequestSeen(payload.prKey);
      await refreshGitHub();
      sessions.syncWithState(getState());
      ensureVisibleSession(result.workspace.id);
      broadcastState();
      return getPayload();
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async commentGitHubPullRequest(payload: any, windowId?: string) {
      assertPrInViewerProfile(payload?.prKey, windowId);
      await github.addPullRequestComment(payload);
      // Sending a review comment IS work, credited to the review workspace
      // this PR is checked out in — after the API call succeeded.
      await recordWorkForPr(payload?.prKey, windowId);
      await refreshGitHub();
      return getPayload();
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async submitGitHubPullRequestReview(payload: any, windowId?: string) {
      assertPrInViewerProfile(payload?.prKey, windowId);
      await github.submitPullRequestReview(payload);
      await recordWorkForPr(payload?.prKey, windowId);
      await refreshGitHub();
      return getPayload();
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async rerunGitHubCheck(prKey: string, checkItem: any, windowId?: string) {
      assertPrInViewerProfile(prKey, windowId);
      await github.rerunCheck(prKey, checkItem);
      broadcastState();
      return getPayload();
    },
    async fetchGitHubReviewWorkspace(workspaceId: string) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const workspace = findWorkspace(getState() as any, workspaceId) as WorkspaceState | null;
      if (!workspace?.review) throw new Error("GitHub review workspace not found.");
      await github.fetchReviewWorkspace({ workspace });
      await refreshGit(workspaceId);
      broadcastState();
      return getPayload();
    },
    async rebaseGitHubReviewWorkspace(workspaceId: string) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const workspace = findWorkspace(getState() as any, workspaceId) as WorkspaceState | null;
      if (!workspace?.review) throw new Error("GitHub review workspace not found.");
      await github.rebaseReviewWorkspace({ workspace });
      await refreshGit(workspaceId);
      broadcastState();
      return getPayload();
    },
    async pushGitHubReviewWorkspace(workspaceId: string, { force = false } = {}) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const workspace = findWorkspace(getState() as any, workspaceId) as WorkspaceState | null;
      if (!workspace?.review) throw new Error("GitHub review workspace not found.");
      await assertWorktreeCleanForPush(git, workspace);
      const snapshot = git.getSnapshot(workspaceId);
      await github.pushReviewWorkspace({ workspace, force, branch: snapshot?.branch });
      await refreshGit(workspaceId);
      await refreshGitHub();
      return getPayload();
    },
    /**
     * The Refresh button's git-mutating half — see syncAzureReviewWorkspace
     * in runtime-azure-handlers.ts for the full rationale (shared design).
     */
    async syncGitHubReviewWorkspace(workspaceId: string, windowId?: string) {
      assertWorkspaceInViewerProfile(workspaceId, windowId);
      const inFlight = githubSyncInFlight.get(workspaceId);
      if (inFlight) return inFlight;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const workspace = findWorkspace(getState() as any, workspaceId) as WorkspaceState | null;
      if (!workspace?.review) throw new Error("GitHub review workspace not found.");
      const run = (async () => {
        const result = await github.syncReviewWorkspace({ workspace });
        await refreshGit(workspaceId);
        await refreshGitHub();
        broadcastState();
        return { payload: getPayload(), result };
      })();
      githubSyncInFlight.set(workspaceId, run);
      try {
        return await run;
      } finally {
        githubSyncInFlight.delete(workspaceId);
      }
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async githubListRemoteBranches(payload: any) {
      const workspace = resolveGitWorkspace(payload.workspaceId);
      const connectionId =
        workspace.connectionId || workspace.review?.connectionId || workspace.quickfix?.connectionId || "";
      if (!connectionId) throw new Error("No GitHub connection associated with this workspace.");
      const rootPath = resolveRootPath(workspace, payload.rootPath);
      const snapshot = git.getSnapshot(workspace.id, rootPath);
      const remoteUrl = snapshot?.remotes?.origin || "";
      const match = remoteUrl.match(/github\.com[/:]([^/]+)\/([^/.]+)/);
      if (!match) throw new Error("Cannot determine GitHub owner/repo from remote URL.");
      const branches = await github.listRemoteBranches(connectionId, match[1], match[2]);
      return { branches };
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async githubCreatePullRequest(payload: any = {}) {
      const workspace = resolveGitWorkspace(payload.workspaceId);
      const connectionId =
        workspace.connectionId || workspace.review?.connectionId || workspace.quickfix?.connectionId || "";
      if (!connectionId) throw new Error("No GitHub connection associated with this workspace.");
      const rootPath = resolveRootPath(workspace, payload.rootPath);
      const snapshot = git.getSnapshot(workspace.id, rootPath);
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
        // Owner profile is the WORKSPACE's — the manager refuses connections
        // from other profiles with a clear pointer to the right one.
        workspaceProfileId: workspace.profileId || "default",
      });

      if (workspace.quickfix && result.pullRequestNumber) {
        const { createPullRequestKey: ghPrKey } = await import("./github-utils.js");
        const prKey = ghPrKey(connectionId, owner, repo, result.pullRequestNumber);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await store.mutate((draft: any) => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const ws = draft.workspaces.find((w: any) => w.id === workspace.id);
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
                rootPath: rootPath || workspace.cwd,
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async githubQuickFixListRepos(payload: any) {
      return { repositories: await github.listQuickFixRepositories(payload.connectionId) };
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async githubQuickFixListBranches(payload: any) {
      return { branches: await github.listQuickFixBranches(payload.connectionId, payload.owner, payload.repo) };
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async githubQuickFixCreate(payload: any, windowId?: string) {
      const state = getState();
      const callerProfileId = getViewerProfileId(windowId) || "";
      const result = await github.openQuickFixWorkspace({
        state,
        connectionId: payload.connectionId,
        owner: payload.owner,
        repo: payload.repo,
        remoteUrl: payload.remoteUrl,
        baseBranch: payload.baseBranch,
        newBranchName: payload.newBranchName,
        callerProfileId,
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await store.mutate((draft: any) => {
        const normalized = normalizeWorkspace(result.workspace);
        insertWorkspace(draft.workspaces, normalized, getViewerActiveWorkspaceId(windowId));
        draft.activeWorkspaceId = normalized.id;
        // Creating a quickfix workspace IS work (V2 plan allowlist).
        markWorkspaceWorked(draft, normalized.id);
        // See openAzurePullRequest for the cross-profile guard rationale.
        const mirrorResult = mirrorActivationIntoSlot(draft, windowId, normalized);
        if (mirrorResult && !mirrorResult.mirrored) {
          log.info("githubQuickFixCreate: skipping slot mirror (cross-profile)", {
            windowId,
            slotProfileId: mirrorResult.slotProfileId,
            workspaceProfileId: mirrorResult.workspaceProfileId,
          });
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
