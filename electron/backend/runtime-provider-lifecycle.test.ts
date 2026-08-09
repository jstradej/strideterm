import { describe, expect, test, vi, beforeEach } from "vitest";
import path from "node:path";
import { createProviderLifecycle } from "./runtime-provider-lifecycle.js";
import { strideDataDir } from "./default-state.js";

import type { AppState, WorkspaceState } from "../shared/types/state.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeState(overrides: Record<string, any> = {}): any {
  return {
    workspaces: [],
    activeWorkspaceId: "",
    tabTemplates: [],
    settings: {
      integrations: {
        azureDevops: { enabled: true, reviewRoot: "", defaultPollSeconds: 60, connections: [] },
        github: { enabled: true, reviewRoot: "", defaultPollSeconds: 60, connections: [] },
      },
    },
    ...overrides,
  };
}

function makeCtx(state: ReturnType<typeof makeState>) {
  const azureReviewStore = {
    getState: vi.fn().mockReturnValue({ trackedPullRequests: {} }),
    upsertTrackedPullRequest: vi.fn().mockResolvedValue(undefined),
  };
  const githubReviewStore = {
    upsertTrackedPullRequest: vi.fn().mockResolvedValue(undefined),
  };
  const azure = {
    sync: vi.fn().mockResolvedValue(undefined),
    getSnapshot: vi.fn().mockReturnValue({ pullRequests: {} }),
    ensurePullRequestDetail: vi.fn().mockResolvedValue(undefined),
    stopPolling: vi.fn(),
    configurePolling: vi.fn(),
    buildManagedReviewPaths: vi.fn().mockReturnValue(null),
    buildReviewMetadata: vi.fn(),
    // Both managers expose their tracked-PR store as `.reviewStore` (see
    // BaseProviderManager); the detach pass clears reviewWorkspaceId there.
    reviewStore: azureReviewStore,
  };
  const github = {
    sync: vi.fn().mockResolvedValue(undefined),
    getSnapshot: vi.fn().mockReturnValue({ pullRequests: {} }),
    ensurePullRequestDetail: vi.fn().mockResolvedValue(undefined),
    stopPolling: vi.fn(),
    configurePolling: vi.fn(),
    reviewStore: githubReviewStore,
  };
  const git = { getProjectMap: vi.fn().mockReturnValue({}) };
  const store = {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mutate: vi.fn(async (fn: (draft: any) => void) => {
      fn(state);
    }),
  };

  const ctx = {
    getState: () => state as unknown as AppState,
    store,
    azure,
    github,
    git,
    azureReviewStore,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    getAzureSettings: (s: any = state) => s.settings.integrations.azureDevops,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    getAzureConnections: (s: any = state) => s.settings.integrations.azureDevops.connections,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    getGitHubSettings: (s: any = state) => s.settings.integrations.github,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    getGitHubConnections: (s: any = state) => s.settings.integrations.github.connections,

    parseAzureReviewWorkspaceHint: (_workspace: WorkspaceState) => ({ prId: 0, connectionPathKey: "" }),
    normalizeFsPath: (p: string) => p,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    createAzureWorkspaceReviewPanels: (_templates: any[]) => [{ id: "panel1" }],

    findWorkspace: (s: AppState, workspaceId: string) =>
      (s as unknown as { workspaces: WorkspaceState[] }).workspaces.find((w) => w.id === workspaceId) || null,
  };

  return { ctx, azure, github, git, azureReviewStore, githubReviewStore, store };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function attachedReviewWorkspace(overrides: Record<string, any> = {}): any {
  return {
    id: "ws-attached",
    name: "mhub",
    kind: "terminal",
    cwd: "C:/work/mhub",
    profileId: "default",
    panels: [],
    review: {
      provider: "azure-devops",
      prKey: "ado-main:repo-1:29456",
      role: "author",
      checkout: { mode: "linked-existing-workspace", rootPath: "C:/work/mhub", cacheRepoPath: "" },
    },
    ...overrides,
  };
}

describe("createProviderLifecycle — ensureAzureWorkspace / ensureGitHubWorkspace", () => {
  let state: ReturnType<typeof makeState>;
  beforeEach(() => {
    state = makeState();
  });

  test("ensureAzureWorkspace creates a new azure inbox workspace with provider-specific fields", async () => {
    const { ctx } = makeCtx(state);
    const lifecycle = createProviderLifecycle(ctx);

    const workspace = await lifecycle.ensureAzureWorkspace();

    expect(workspace.kind).toBe("azure");
    expect(workspace.name).toBe("Azure DevOps");
    expect(workspace.icon).toBe("AZ");
    expect(workspace.color).toBe("#0078d4");
    expect(workspace.notes).toBe("Azure DevOps inbox");
    expect(workspace.cwd).toBe(path.join(strideDataDir(), "azure-pr"));
    expect(workspace.profileId).toBe("default");
    expect(state.workspaces).toHaveLength(1);
    expect(state.activeWorkspaceId).toBe(workspace.id);
  });

  test("ensureGitHubWorkspace creates a new github inbox workspace with provider-specific fields", async () => {
    const { ctx } = makeCtx(state);
    const lifecycle = createProviderLifecycle(ctx);

    const workspace = await lifecycle.ensureGitHubWorkspace();

    expect(workspace.kind).toBe("github");
    expect(workspace.name).toBe("GitHub");
    expect(workspace.icon).toBe("GH");
    expect(workspace.color).toBe("#238636");
    expect(workspace.notes).toBe("GitHub inbox");
    expect(workspace.cwd).toBe(path.join(strideDataDir(), "github-pr"));
  });

  test("ensureAzureWorkspace honors a configured reviewRoot instead of the default dir", async () => {
    state.settings.integrations.azureDevops.reviewRoot = "/custom/azure-root";
    const { ctx } = makeCtx(state);
    const lifecycle = createProviderLifecycle(ctx);

    const workspace = await lifecycle.ensureAzureWorkspace();
    expect(workspace.cwd).toBe("/custom/azure-root");
  });

  test("ensureAzureWorkspace returns the existing workspace instead of creating a duplicate", async () => {
    const { ctx, store } = makeCtx(state);
    const lifecycle = createProviderLifecycle(ctx);

    const first = await lifecycle.ensureAzureWorkspace();
    store.mutate.mockClear();
    const second = await lifecycle.ensureAzureWorkspace();

    expect(second.id).toBe(first.id);
    expect(state.workspaces).toHaveLength(1);
    expect(store.mutate).not.toHaveBeenCalled();
  });

  test("ensureAzureWorkspace and ensureGitHubWorkspace are independent per profile/kind", async () => {
    const { ctx } = makeCtx(state);
    const lifecycle = createProviderLifecycle(ctx);

    await lifecycle.ensureAzureWorkspace("teamA");
    await lifecycle.ensureGitHubWorkspace("teamA");

    expect(state.workspaces).toHaveLength(2);
    expect(state.workspaces.find((w: WorkspaceState) => w.kind === "azure")?.profileId).toBe("teamA");
    expect(state.workspaces.find((w: WorkspaceState) => w.kind === "github")?.profileId).toBe("teamA");
  });
});

describe("createProviderLifecycle — refreshAzure / refreshGitHub", () => {
  let state: ReturnType<typeof makeState>;
  beforeEach(() => {
    state = makeState();
  });

  test("refreshAzure syncs against azure connections/workspaces/gitSnapshots and returns the azure snapshot", async () => {
    const { ctx, azure, git } = makeCtx(state);
    state.settings.integrations.azureDevops.connections = [{ id: "conn1" }];
    git.getProjectMap.mockReturnValue({ ws1: {} });
    const lifecycle = createProviderLifecycle(ctx);

    const result = await lifecycle.refreshAzure();

    expect(azure.sync).toHaveBeenCalledWith({
      connections: [{ id: "conn1" }],
      workspaces: state.workspaces,
      gitSnapshots: { ws1: {} },
    });
    expect(result).toEqual({ pullRequests: {} });
  });

  test("refreshGitHub syncs against github connections and does not touch azure's repair hook", async () => {
    const { ctx, github, azure } = makeCtx(state);
    state.settings.integrations.github.connections = [{ id: "gh1" }];
    const lifecycle = createProviderLifecycle(ctx);

    await lifecycle.refreshGitHub();

    expect(github.sync).toHaveBeenCalledWith(
      expect.objectContaining({ connections: [{ id: "gh1" }], workspaces: state.workspaces }),
    );
    // GitHub has no afterSync hook — azure.getSnapshot must not be invoked as
    // a side effect of refreshing GitHub (proves the descriptors don't cross-wire).
    expect(azure.getSnapshot).not.toHaveBeenCalled();
  });

  test("refreshAzure re-fetches PR detail for the active azure review workspace", async () => {
    const { ctx, azure } = makeCtx(state);
    state.workspaces.push({
      id: "ws-review",
      review: { provider: "azure-devops", prKey: "pr:1" },
    });
    state.activeWorkspaceId = "ws-review";
    const lifecycle = createProviderLifecycle(ctx);

    await lifecycle.refreshAzure();

    expect(azure.ensurePullRequestDetail).toHaveBeenCalledWith(
      "pr:1",
      expect.objectContaining({ force: true, workspaces: state.workspaces }),
    );
  });

  test("refreshGitHub does not re-fetch PR detail when the active workspace belongs to azure", async () => {
    const { ctx, github } = makeCtx(state);
    state.workspaces.push({
      id: "ws-review",
      review: { provider: "azure-devops", prKey: "pr:1" },
    });
    state.activeWorkspaceId = "ws-review";
    const lifecycle = createProviderLifecycle(ctx);

    await lifecycle.refreshGitHub();

    expect(github.ensurePullRequestDetail).not.toHaveBeenCalled();
  });
});

describe("createProviderLifecycle — scheduleAzurePolling / scheduleGitHubPolling", () => {
  let state: ReturnType<typeof makeState>;
  beforeEach(() => {
    state = makeState();
  });

  test("stops polling when the azure integration is disabled", () => {
    state.settings.integrations.azureDevops.enabled = false;
    state.settings.integrations.azureDevops.connections = [{ id: "conn1", enabled: true }];
    const { ctx, azure } = makeCtx(state);
    const lifecycle = createProviderLifecycle(ctx);

    lifecycle.scheduleAzurePolling();

    expect(azure.stopPolling).toHaveBeenCalledTimes(1);
    expect(azure.configurePolling).not.toHaveBeenCalled();
  });

  test("stops polling when there are no enabled github connections", () => {
    state.settings.integrations.github.connections = [{ id: "gh1", enabled: false }];
    const { ctx, github } = makeCtx(state);
    const lifecycle = createProviderLifecycle(ctx);

    lifecycle.scheduleGitHubPolling();

    expect(github.stopPolling).toHaveBeenCalledTimes(1);
    expect(github.configurePolling).not.toHaveBeenCalled();
  });

  test("configures polling with the computed interval and the provider's own refresh callback", async () => {
    state.settings.integrations.azureDevops.connections = [{ id: "conn1", enabled: true, pollSeconds: 30 }];
    state.settings.integrations.github.connections = [{ id: "gh1", enabled: true, pollSeconds: 45 }];
    const { ctx, azure, github } = makeCtx(state);
    const lifecycle = createProviderLifecycle(ctx);

    lifecycle.scheduleAzurePolling();
    lifecycle.scheduleGitHubPolling();

    expect(azure.configurePolling).toHaveBeenCalledWith(30_000, expect.any(Function));
    expect(github.configurePolling).toHaveBeenCalledWith(45_000, expect.any(Function));

    // The callback each manager was configured with must be that provider's
    // own refresh — proof the shared factory didn't cross-wire the two.
    const azureCallback = azure.configurePolling.mock.calls[0][1];
    await azureCallback();
    expect(azure.sync).toHaveBeenCalledTimes(1);
    expect(github.sync).not.toHaveBeenCalled();
  });
});

describe("createProviderLifecycle — detaching attached reviews from terminal PRs", () => {
  let state: ReturnType<typeof makeState>;
  beforeEach(() => {
    state = makeState();
  });

  test("clears the review marker and the tracked pointer once the PR is completed", async () => {
    state.workspaces = [attachedReviewWorkspace()];
    const { ctx, azure, azureReviewStore } = makeCtx(state);
    azure.getSnapshot.mockReturnValue({
      pullRequests: { "ado-main:repo-1:29456": { pullRequest: { id: 29456, status: "completed" } } },
    });
    const lifecycle = createProviderLifecycle(ctx);

    await lifecycle.refreshAzure();

    expect(state.workspaces[0].review).toBeNull();
    expect(azureReviewStore.upsertTrackedPullRequest).toHaveBeenCalledWith("ado-main:repo-1:29456", {
      reviewWorkspaceId: "",
    });
  });

  test("abandoned PRs detach too, active ones stay linked", async () => {
    state.workspaces = [
      attachedReviewWorkspace({ id: "ws-abandoned", review: attachedReviewWorkspace().review }),
      attachedReviewWorkspace({
        id: "ws-active",
        review: { ...attachedReviewWorkspace().review, prKey: "ado-main:repo-1:31500" },
      }),
    ];
    const { ctx, azure } = makeCtx(state);
    azure.getSnapshot.mockReturnValue({
      pullRequests: {
        "ado-main:repo-1:29456": { pullRequest: { status: "abandoned" } },
        "ado-main:repo-1:31500": { pullRequest: { status: "active" } },
      },
    });
    const lifecycle = createProviderLifecycle(ctx);

    await lifecycle.refreshAzure();

    expect(state.workspaces[0].review).toBeNull();
    expect(state.workspaces[1].review).not.toBeNull();
  });

  test("leaves managed review worktrees linked — they exist only for the review", async () => {
    state.workspaces = [
      attachedReviewWorkspace({
        id: "ws-managed",
        review: {
          ...attachedReviewWorkspace().review,
          checkout: { mode: "managed-worktree", rootPath: "C:/reviews/pr-29456", cacheRepoPath: "" },
        },
      }),
    ];
    const { ctx, azure } = makeCtx(state);
    azure.getSnapshot.mockReturnValue({
      pullRequests: { "ado-main:repo-1:29456": { pullRequest: { status: "completed" } } },
    });
    const lifecycle = createProviderLifecycle(ctx);

    await lifecycle.refreshAzure();

    expect(state.workspaces[0].review).not.toBeNull();
  });

  test("an absent or stateless summary is never treated as terminal", async () => {
    state.workspaces = [
      attachedReviewWorkspace({ id: "ws-missing" }),
      attachedReviewWorkspace({
        id: "ws-blank",
        review: { ...attachedReviewWorkspace().review, prKey: "ado-main:repo-1:31500" },
      }),
    ];
    const { ctx, azure } = makeCtx(state);
    // A poll that returned nothing useful must not unlink everything at once.
    azure.getSnapshot.mockReturnValue({
      pullRequests: { "ado-main:repo-1:31500": { pullRequest: { status: "" } } },
    });
    const lifecycle = createProviderLifecycle(ctx);

    await lifecycle.refreshAzure();

    expect(state.workspaces[0].review).not.toBeNull();
    expect(state.workspaces[1].review).not.toBeNull();
  });

  test("GitHub uses pullRequest.state: closed detaches, open stays", async () => {
    state.workspaces = [
      attachedReviewWorkspace({
        id: "ws-gh-closed",
        review: {
          ...attachedReviewWorkspace().review,
          provider: "github",
          prKey: "gh-main:acme/web:7",
        },
      }),
      attachedReviewWorkspace({
        id: "ws-gh-open",
        review: {
          ...attachedReviewWorkspace().review,
          provider: "github",
          prKey: "gh-main:acme/web:8",
        },
      }),
    ];
    const { ctx, github, githubReviewStore } = makeCtx(state);
    github.getSnapshot.mockReturnValue({
      pullRequests: {
        "gh-main:acme/web:7": { pullRequest: { state: "closed" } },
        "gh-main:acme/web:8": { pullRequest: { state: "open" } },
      },
    });
    const lifecycle = createProviderLifecycle(ctx);

    await lifecycle.refreshGitHub();

    expect(state.workspaces[0].review).toBeNull();
    expect(state.workspaces[1].review).not.toBeNull();
    expect(githubReviewStore.upsertTrackedPullRequest).toHaveBeenCalledWith("gh-main:acme/web:7", {
      reviewWorkspaceId: "",
    });
  });

  test("an Azure workspace is untouched by the GitHub pass and vice versa", async () => {
    state.workspaces = [attachedReviewWorkspace()];
    const { ctx, github } = makeCtx(state);
    github.getSnapshot.mockReturnValue({
      pullRequests: { "ado-main:repo-1:29456": { pullRequest: { state: "closed" } } },
    });
    const lifecycle = createProviderLifecycle(ctx);

    await lifecycle.refreshGitHub();

    expect(state.workspaces[0].review).not.toBeNull();
  });
});
