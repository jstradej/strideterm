/**
 * Provider workspace lifecycle management (Azure DevOps + GitHub).
 * Handles ensure/refresh/scheduling and review workspace metadata repair.
 *
 * Extracted from runtime.js following the same ctx factory pattern
 * as runtime-azure-handlers.js and runtime-github-handlers.js.
 */
import path from "node:path";
import { randomUUID } from "node:crypto";
import { normalizeWorkspace, strideDataDir } from "./default-state.js";
import { normalizeReviewRoot, shortPathKey } from "./azure-devops-manager.js";
import { APP_CONFIG } from "../../config/app-config.js";
import { getLogger } from "./logger.js";

const log = getLogger("runtime");

/**
 * @param {object} ctx - Runtime context with shared references
 */
export function createProviderLifecycle(ctx) {
  const {
    getState,
    store,
    azure,
    github,
    git,
    azureReviewStore,
    getAzureSettings,
    getAzureConnections,
    getGitHubSettings,
    getGitHubConnections,
    parseAzureReviewWorkspaceHint,
    normalizeFsPath,
    createAzureWorkspaceReviewPanels,
    findWorkspace,
  } = ctx;

  // --- Azure DevOps ---

  function getAzureWorkspace(profileId = getState().activeProfileId || "default") {
    return (
      getState().workspaces.find(
        (workspace) => workspace.kind === "azure" && (workspace.profileId || "default") === profileId,
      ) || null
    );
  }

  async function ensureAzureWorkspace(profileId = getState().activeProfileId || "default") {
    const existing = getAzureWorkspace(profileId);
    if (existing) {
      return existing;
    }

    const panels = createAzureWorkspaceReviewPanels(getState().tabTemplates || []);

    const workspace = normalizeWorkspace({
      id: `workspace-${randomUUID()}`,
      name: "Azure DevOps",
      icon: "AZ",
      color: "#0078d4",
      kind: "azure",
      cwd: getAzureSettings().reviewRoot || path.join(strideDataDir(), "azure-pr"),
      notes: "Azure DevOps inbox",
      profileId,
      panels,
      activePanelId: panels[0]?.id || "",
    });
    await store.mutate((draft) => {
      draft.workspaces.push(workspace);
      if (!draft.activeWorkspaceId) {
        draft.activeWorkspaceId = workspace.id;
      }
    });
    return workspace;
  }

  async function refreshAzure() {
    const state = getState();
    await azure.sync({
      connections: getAzureConnections(state),
      workspaces: state.workspaces,
      gitSnapshots: git.getProjectMap(),
      activeProfileId: state.activeProfileId || "default",
    });
    await repairAzureReviewWorkspaceMetadata();

    const refreshedState = getState();
    const activeWorkspace = findWorkspace(refreshedState, refreshedState.activeWorkspaceId);
    if (
      activeWorkspace?.review?.provider === "azure-devops" &&
      activeWorkspace.review.prKey &&
      typeof azure.ensurePullRequestDetail === "function"
    ) {
      await azure
        .ensurePullRequestDetail(activeWorkspace.review.prKey, {
          workspaces: refreshedState.workspaces,
          force: true,
        })
        .catch(() => {});
    }

    return azure.getSnapshot();
  }

  async function repairAzureReviewWorkspaceMetadata(snapshot = azure.getSnapshot()) {
    const state = getState();
    const repairs = [];
    const summaries = Object.values(snapshot?.pullRequests || {});
    const trackedPullRequests = Object.values(azureReviewStore.getState().trackedPullRequests || {});

    for (const workspace of state.workspaces || []) {
      const hasAzureReview = workspace.review?.provider === "azure-devops";
      const looksLikeAzureReview = String(workspace.notes || "").startsWith("Azure DevOps review workspace for ");
      if (workspace.kind === "azure" || !workspace.cwd || (!looksLikeAzureReview && !hasAzureReview)) {
        continue;
      }

      if (
        hasAzureReview &&
        workspace.review?.checkout?.mode === "managed-worktree" &&
        workspace.review?.parentWorkspaceId
      ) {
        continue;
      }

      const match = summaries.find((summary) => {
        const paths = azure.buildManagedReviewPaths?.(summary, {
          profileId: workspace.profileId || "default",
          workspaces: state.workspaces,
        });
        return paths && normalizeFsPath(paths.rootPath) === normalizeFsPath(workspace.cwd);
      });
      if (match) {
        const paths = azure.buildManagedReviewPaths(match, {
          profileId: workspace.profileId || "default",
          workspaces: state.workspaces,
        });
        if (!paths) {
          continue;
        }

        repairs.push({
          workspaceId: workspace.id,
          prKey: match.prKey,
          review: azure.buildReviewMetadata(
            match,
            {
              mode: "managed-worktree",
              rootPath: paths.rootPath,
              cacheRepoPath: paths.cacheRepoPath,
            },
            "managed-worktree",
            {
              parentWorkspaceId: paths.parentWorkspaceId || "",
            },
          ),
        });
        continue;
      }

      const hint = parseAzureReviewWorkspaceHint(workspace);
      if (!hint.prId || !hint.connectionPathKey) {
        continue;
      }
      const connection = getAzureConnections(state).find(
        (entry) => shortPathKey(entry.id, "connection") === hint.connectionPathKey,
      );
      if (!connection) {
        continue;
      }
      const tracked = trackedPullRequests.find(
        (entry) => entry.connectionId === connection.id && Number(entry.pullRequestId) === hint.prId,
      );
      if (!tracked) {
        continue;
      }
      const parentAzureWorkspace =
        state.workspaces.find(
          (entry) => entry.kind === "azure" && (entry.profileId || "default") === (workspace.profileId || "default"),
        ) || null;
      const reviewRoot = parentAzureWorkspace?.cwd || connection.reviewRoot || getAzureSettings(state).reviewRoot;
      repairs.push({
        workspaceId: workspace.id,
        prKey: tracked.key,
        review: {
          provider: "azure-devops",
          prKey: tracked.key,
          connectionId: connection.id,
          orgUrl: connection.orgUrl || "",
          parentWorkspaceId: parentAzureWorkspace?.id || "",
          project: {
            id: "",
            name: tracked.projectName || "",
          },
          repository: {
            id: tracked.repositoryId || "",
            name: tracked.repositoryName || "",
            remoteUrl: "",
          },
          pullRequest: {
            id: tracked.pullRequestId || hint.prId,
            title: workspace.name || `PR #${hint.prId}`,
            status: "",
            mergeStatus: "",
            url: "",
            webUrl: "",
            sourceRefName: "",
            targetRefName: "",
          },
          role: "",
          checkout: {
            mode: "managed-worktree",
            rootPath: workspace.cwd,
            cacheRepoPath: path.join(
              normalizeReviewRoot(reviewRoot),
              "repos",
              shortPathKey(connection.id, "connection"),
              shortPathKey(tracked.repositoryId || tracked.repositoryName, "repository"),
            ),
          },
        },
      });
    }

    if (!repairs.length) {
      return false;
    }

    await store.mutate((draft) => {
      for (const repair of repairs) {
        const workspace = draft.workspaces.find((entry) => entry.id === repair.workspaceId);
        if (workspace) {
          workspace.review = repair.review;
        }
      }
    });
    for (const repair of repairs) {
      await azureReviewStore.upsertTrackedPullRequest(repair.prKey, {
        reviewWorkspaceId: repair.workspaceId,
      });
    }
    return true;
  }

  function scheduleAzurePolling() {
    const settings = getAzureSettings();
    const enabledConnections = getAzureConnections().filter((connection) => connection.enabled !== false);
    if (!settings.enabled || !enabledConnections.length) {
      azure.stopPolling();
      return;
    }

    const pollSeconds = Math.max(
      15,
      Math.min(
        ...enabledConnections.map(
          (connection) => Number(connection.pollSeconds) || Number(settings.defaultPollSeconds) || 120,
        ),
      ),
    );
    azure.configurePolling(pollSeconds * 1000, refreshAzure);
  }

  // --- GitHub ---

  function getGitHubWorkspace(profileId = getState().activeProfileId || "default") {
    return (
      getState().workspaces.find((ws) => ws.kind === "github" && (ws.profileId || "default") === profileId) || null
    );
  }

  async function ensureGitHubWorkspace(profileId = getState().activeProfileId || "default") {
    const existing = getGitHubWorkspace(profileId);
    if (existing) return existing;
    const panels = createAzureWorkspaceReviewPanels(getState().tabTemplates || []);
    const workspace = normalizeWorkspace({
      id: `workspace-${randomUUID()}`,
      name: "GitHub",
      icon: "GH",
      color: "#238636",
      kind: "github",
      cwd: getGitHubSettings().reviewRoot || path.join(strideDataDir(), "github-pr"),
      notes: "GitHub inbox",
      profileId,
      panels,
      activePanelId: panels[0]?.id || "",
    });
    await store.mutate((draft) => {
      draft.workspaces.push(workspace);
      if (!draft.activeWorkspaceId) draft.activeWorkspaceId = workspace.id;
    });
    return workspace;
  }

  async function refreshGitHub() {
    const state = getState();
    await github.sync({
      connections: getGitHubConnections(state),
      workspaces: state.workspaces,
      gitSnapshots: git.getProjectMap(),
      activeProfileId: state.activeProfileId || "default",
    });

    const refreshedState = getState();
    const activeWorkspace = findWorkspace(refreshedState, refreshedState.activeWorkspaceId);
    if (
      activeWorkspace?.review?.provider === "github" &&
      activeWorkspace.review.prKey &&
      typeof github.ensurePullRequestDetail === "function"
    ) {
      await github
        .ensurePullRequestDetail(activeWorkspace.review.prKey, {
          workspaces: refreshedState.workspaces,
          force: true,
        })
        .catch(() => {});
    }

    return github.getSnapshot();
  }

  function scheduleGitHubPolling() {
    const settings = getGitHubSettings();
    const enabledConnections = getGitHubConnections().filter((c) => c.enabled !== false);
    if (!settings.enabled || !enabledConnections.length) {
      github.stopPolling();
      return;
    }
    const pollSeconds = Math.max(
      15,
      Math.min(...enabledConnections.map((c) => Number(c.pollSeconds) || Number(settings.defaultPollSeconds) || 120)),
    );
    github.configurePolling(pollSeconds * 1000, refreshGitHub);
  }

  return {
    getAzureWorkspace,
    ensureAzureWorkspace,
    refreshAzure,
    repairAzureReviewWorkspaceMetadata,
    scheduleAzurePolling,
    getGitHubWorkspace,
    ensureGitHubWorkspace,
    refreshGitHub,
    scheduleGitHubPolling,
  };
}
