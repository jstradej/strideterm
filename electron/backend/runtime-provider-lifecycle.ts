/// <reference types="node" />
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
import { computeMinPollSeconds } from "./shared/runtime-provider-guards.js";
import { APP_CONFIG } from "../../config/app-config.js";
import { getLogger } from "./logger.js";
import type { AppState, WorkspaceState } from "../shared/types/state.js";

const log = getLogger("runtime");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyManager = any;

interface ProviderLifecycleCtx {
  getState: () => AppState;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  store: any;
  azure: AnyManager;
  github: AnyManager;
  git: AnyManager;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  azureReviewStore: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getAzureSettings: (state?: AppState) => any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getAzureConnections: (state?: AppState) => any[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getGitHubSettings: (state?: AppState) => any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getGitHubConnections: (state?: AppState) => any[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  parseAzureReviewWorkspaceHint: (workspace: WorkspaceState) => any;
  normalizeFsPath: (p: string) => string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  createAzureWorkspaceReviewPanels: (templates: any[]) => any[];
  findWorkspace: (state: AppState, workspaceId: string) => WorkspaceState | null;
}

/**
 * @param ctx - Runtime context with shared references
 */
export function createProviderLifecycle(ctx: ProviderLifecycleCtx) {
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

  /**
   * Provider-parametrized ensure/refresh/schedule-polling triplet, shared by
   * Azure DevOps and GitHub. Both providers' inbox workspaces are
   * PROFILE-owned (one per provider per profile, shared by every
   * window/remote viewer of that profile) — callers always pass the owner
   * profile explicitly (connection.profileId / caller viewer profile);
   * "default" is only the legacy no-context fallback, never windowSlots[0],
   * which is arbitrary in a multi-window install.
   */
  function makeProviderLifecycle(descriptor: {
    kind: "azure" | "github";
    logLabel: string;
    reviewProviderKey: string;
    manager: AnyManager;
    name: string;
    icon: string;
    color: string;
    notes: string;
    reviewRootDirName: string;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    getSettings: (state?: AppState) => any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    getConnections: (state?: AppState) => any[];
    afterSync?: () => Promise<unknown>;
  }) {
    function getWorkspace(profileId = "default"): WorkspaceState | null {
      return (
        getState().workspaces.find(
          (workspace) => workspace.kind === descriptor.kind && (workspace.profileId || "default") === profileId,
        ) || null
      );
    }

    async function ensureWorkspace(profileId = "default"): Promise<WorkspaceState> {
      const existing = getWorkspace(profileId);
      log.debug(`ensure${descriptor.logLabel}Workspace: called`, {
        requestedProfileId: profileId,
        existingId: existing?.id || null,
        existingProfileId: existing?.profileId || null,
      });
      if (existing) {
        return existing;
      }

      const panels = createAzureWorkspaceReviewPanels(getState().tabTemplates || []);

      const workspace = normalizeWorkspace({
        id: `workspace-${randomUUID()}`,
        name: descriptor.name,
        icon: descriptor.icon,
        color: descriptor.color,
        kind: descriptor.kind,
        cwd: descriptor.getSettings().reviewRoot || path.join(strideDataDir(), descriptor.reviewRootDirName),
        notes: descriptor.notes,
        profileId,
        panels,
        activePanelId: panels[0]?.id || "",
      });
      log.debug(`ensure${descriptor.logLabel}Workspace: creating`, {
        workspaceId: workspace.id,
        profileId: workspace.profileId,
        cwd: workspace.cwd,
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await store.mutate((draft: any) => {
        draft.workspaces.push(workspace);
        if (!draft.activeWorkspaceId) {
          draft.activeWorkspaceId = workspace.id;
        }
      });
      return workspace as WorkspaceState;
    }

    async function refresh(): Promise<unknown> {
      const state = getState();
      // No activeProfileId: each PR summary is owned by its connection's
      // profile (connection.profileId, "default" for unmigrated legacy
      // connections) — there is no single "active" profile in a multi-window
      // install.
      await descriptor.manager.sync({
        connections: descriptor.getConnections(state),
        workspaces: state.workspaces,
        gitSnapshots: git.getProjectMap(),
      });
      if (descriptor.afterSync) await descriptor.afterSync();

      const refreshedState = getState();
      const activeWorkspace = findWorkspace(refreshedState, refreshedState.activeWorkspaceId);
      if (
        activeWorkspace?.review?.provider === descriptor.reviewProviderKey &&
        activeWorkspace.review.prKey &&
        typeof descriptor.manager.ensurePullRequestDetail === "function"
      ) {
        await descriptor.manager
          .ensurePullRequestDetail(activeWorkspace.review.prKey, {
            workspaces: refreshedState.workspaces,
            force: true,
          })
          .catch(() => {});
      }

      return descriptor.manager.getSnapshot();
    }

    function schedulePolling(): void {
      const settings = descriptor.getSettings();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const enabledConnections = descriptor.getConnections().filter((c: any) => c.enabled !== false);
      if (!settings.enabled || !enabledConnections.length) {
        descriptor.manager.stopPolling();
        return;
      }
      const pollSeconds = computeMinPollSeconds(enabledConnections, settings.defaultPollSeconds);
      descriptor.manager.configurePolling(pollSeconds * 1000, refresh);
    }

    return { getWorkspace, ensureWorkspace, refresh, schedulePolling };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async function repairAzureReviewWorkspaceMetadata(snapshot: any = azure.getSnapshot()): Promise<boolean> {
    const state = getState();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const repairs: any[] = [];
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

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const match = (summaries as any[]).find((summary) => {
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
              // Preserve the reviewer's "Enable editing" opt-in. buildReviewMetadata
              // defaults writable to false, so without threading it through here a
              // periodic refresh would silently re-gate push on a checkout the user
              // just enabled — the workspace.review object is replaced wholesale below.
              writable: workspace.review?.writable === true,
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
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (entry: any) => shortPathKey(entry.id, "connection") === hint.connectionPathKey,
      );
      if (!connection) {
        continue;
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const tracked = (trackedPullRequests as any[]).find(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (entry: any) => entry.connectionId === connection.id && Number(entry.pullRequestId) === hint.prId,
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
          // Preserve the reviewer's "Enable editing" opt-in across this rebuild
          // (see the buildReviewMetadata branch above for why).
          writable: workspace.review?.writable === true,
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

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await store.mutate((draft: any) => {
      for (const repair of repairs) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const workspace = draft.workspaces.find((entry: any) => entry.id === repair.workspaceId);
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

  const azureLifecycle = makeProviderLifecycle({
    kind: "azure",
    logLabel: "Azure",
    reviewProviderKey: "azure-devops",
    manager: azure,
    name: "Azure DevOps",
    icon: "AZ",
    color: "#0078d4",
    notes: "Azure DevOps inbox",
    reviewRootDirName: "azure-pr",
    getSettings: getAzureSettings,
    getConnections: getAzureConnections,
    afterSync: repairAzureReviewWorkspaceMetadata,
  });

  const githubLifecycle = makeProviderLifecycle({
    kind: "github",
    logLabel: "GitHub",
    reviewProviderKey: "github",
    manager: github,
    name: "GitHub",
    icon: "GH",
    color: "#238636",
    notes: "GitHub inbox",
    reviewRootDirName: "github-pr",
    getSettings: getGitHubSettings,
    getConnections: getGitHubConnections,
  });

  return {
    ensureAzureWorkspace: azureLifecycle.ensureWorkspace,
    refreshAzure: azureLifecycle.refresh,
    scheduleAzurePolling: azureLifecycle.schedulePolling,
    ensureGitHubWorkspace: githubLifecycle.ensureWorkspace,
    refreshGitHub: githubLifecycle.refresh,
    scheduleGitHubPolling: githubLifecycle.schedulePolling,
  };
}
