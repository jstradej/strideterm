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

  // A pull request nobody can push to again. Both checks are deliberately
  // positive: an unknown/missing state must never read as terminal, or a poll
  // that returned nothing would unlink every attached workspace at once.
  const isTerminalPullRequest: Record<
    string,
    (pullRequest: { status?: string; state?: string } | undefined) => boolean
  > = {
    "azure-devops": (pullRequest) =>
      ["completed", "abandoned"].includes(String(pullRequest?.status || "").toLowerCase()),
    github: (pullRequest) => {
      const state = String(pullRequest?.state || "").toLowerCase();
      return !!state && state !== "open";
    },
  };

  /**
   * Drop the review marker from workspaces that were *attached* to a PR — the
   * user's own long-lived checkout, `checkout.mode === "linked-existing-workspace"`
   * — once that PR reaches a terminal state.
   *
   * Managed review worktrees are deliberately left alone: they exist only for
   * the review, so staying linked after the merge is still correct there.
   *
   * Without this the marker outlives the PR indefinitely. The attach is made
   * while the checkout sits on the PR's source branch; once the PR merges and
   * that branch is deleted, the checkout moves on but keeps a dead Review tab,
   * git write operations stay gated, and every agent tab opened in it is
   * launched with the review MCP bridge wired in.
   */
  async function detachTerminalAttachedReviews(providerKey: string, manager: AnyManager): Promise<void> {
    const isTerminal = isTerminalPullRequest[providerKey];
    if (!isTerminal) return;
    const summaries = manager.getSnapshot()?.pullRequests || {};

    // prKey is captured up front: store.mutate clears workspace.review, and
    // the tracked-store cleanup below still needs the key.
    const detached: Array<{ workspaceId: string; prKey: string }> = [];
    for (const workspace of getState().workspaces || []) {
      const review = workspace.review;
      if (review?.provider !== providerKey || !review.prKey) continue;
      if (review.checkout?.mode !== "linked-existing-workspace") continue;
      if (!isTerminal(summaries[review.prKey]?.pullRequest)) continue;
      detached.push({ workspaceId: workspace.id, prKey: review.prKey });
    }
    if (!detached.length) return;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await store.mutate((draft: any) => {
      for (const { workspaceId } of detached) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const workspace = draft.workspaces.find((entry: any) => entry.id === workspaceId);
        if (workspace) {
          workspace.review = null;
        }
      }
    });

    for (const { workspaceId, prKey } of detached) {
      log.info("detached attached review workspace from a terminal pull request", { workspaceId, prKey });
      // Without this the inbox row still resolves to the workspace we just
      // unlinked and offers "Open" on it.
      try {
        await manager.reviewStore?.upsertTrackedPullRequest(prKey, { reviewWorkspaceId: "" });
      } catch (error) {
        log.warn("could not clear the tracked review workspace after detaching", {
          prKey,
          err: (error as Error)?.message || String(error),
        });
      }
    }
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
    afterSync: async () => {
      await repairAzureReviewWorkspaceMetadata();
      await detachTerminalAttachedReviews("azure-devops", azure);
    },
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
    afterSync: () => detachTerminalAttachedReviews("github", github),
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
