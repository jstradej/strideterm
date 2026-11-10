import { describe, expect, test, vi } from "vitest";
import { createAzureHandlers } from "./runtime-azure-handlers.js";

// refreshAzureState coalesces concurrent refreshes into a single in-flight
// poll. The desktop IPC path dedups via withOperationPromise, but the remote
// /api/azure/refresh route calls refreshAzureState directly — so without this,
// several viewers (or a misbehaving auto-refresh) stacked full git+Azure polls
// that serialized and timed out at the gateway (524). These tests pin the
// coalescing behaviour.
describe("refreshAzureState — concurrent refresh coalescing", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function makeHandlers(overrides: any = {}) {
    const refreshAzure = overrides.refreshAzure ?? vi.fn(async () => {});
    const refreshGit = overrides.refreshGit ?? vi.fn(async () => {});
    const payload = overrides.payload ?? { ok: true };
    const getPayload = overrides.getPayload ?? vi.fn(() => payload);
    const handlers = createAzureHandlers({
      getState: () => ({ activeWorkspaceId: "ws-1" }),
      refreshAzure,
      refreshGit,
      getPayload,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    return { handlers, refreshAzure, refreshGit, getPayload, payload };
  }

  test("overlapping calls share one in-flight refresh and all get the same payload", async () => {
    let resolveAzure: () => void = () => {};
    const azureGate = new Promise<void>((resolve) => {
      resolveAzure = resolve;
    });
    const refreshAzure = vi.fn(() => azureGate);
    const { handlers, refreshGit, payload } = makeHandlers({ refreshAzure });

    // Fire three concurrent refreshes while the Azure poll is still pending.
    const p1 = handlers.refreshAzureState();
    const p2 = handlers.refreshAzureState();
    const p3 = handlers.refreshAzureState();

    resolveAzure();
    const [r1, r2, r3] = await Promise.all([p1, p2, p3]);

    // One shared poll, not three.
    expect(refreshAzure).toHaveBeenCalledTimes(1);
    expect(refreshGit).toHaveBeenCalledTimes(1);
    // Every caller resolves to the same fresh payload.
    expect(r1).toBe(payload);
    expect(r2).toBe(payload);
    expect(r3).toBe(payload);
  });

  test("a refresh issued after the previous one settles runs a fresh poll", async () => {
    const { handlers, refreshAzure, refreshGit } = makeHandlers();

    await handlers.refreshAzureState();
    await handlers.refreshAzureState();

    // The in-flight promise is cleared once settled, so the second call is not
    // wrongly deduped against the first.
    expect(refreshAzure).toHaveBeenCalledTimes(2);
    expect(refreshGit).toHaveBeenCalledTimes(2);
  });

  test("a failed refresh clears the in-flight slot so the next call retries", async () => {
    const refreshAzure = vi.fn().mockRejectedValueOnce(new Error("azure boom")).mockResolvedValueOnce(undefined);
    const { handlers } = makeHandlers({ refreshAzure });

    await expect(handlers.refreshAzureState()).rejects.toThrow("azure boom");
    // Slot cleared in finally → a retry actually re-polls instead of returning
    // the rejected promise forever.
    await expect(handlers.refreshAzureState()).resolves.toBeDefined();
    expect(refreshAzure).toHaveBeenCalledTimes(2);
  });
});

describe("markAzurePullRequestSeen — cross-profile viewer guard (#32/#63)", () => {
  function makeHandlers(callerProfileId: string | null) {
    const markPullRequestSeen = vi.fn(async () => {});
    const handlers = createAzureHandlers({
      azure: { markPullRequestSeen },
      getPayload: () => ({ azureDevops: { pullRequests: { "azure:pr1": { prKey: "azure:pr1", profileId: "p1" } } } }),
      getViewerProfileId: () => callerProfileId,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    return { handlers, markPullRequestSeen };
  }

  test("refuses to mark a PR seen from a window bound to a different profile", async () => {
    const { handlers, markPullRequestSeen } = makeHandlers("p2");
    await expect(handlers.markAzurePullRequestSeen("azure:pr1", "remote:sess-b")).rejects.toThrow(/Cross-profile/);
    expect(markPullRequestSeen).not.toHaveBeenCalled();
  });

  test("allows marking a PR in the caller's own profile", async () => {
    const { handlers, markPullRequestSeen } = makeHandlers("p1");
    await handlers.markAzurePullRequestSeen("azure:pr1", "remote:sess-a");
    expect(markPullRequestSeen).toHaveBeenCalledWith("azure:pr1");
  });

  test("desktop IPC (no viewer id → null profile) is unaffected", async () => {
    const { handlers, markPullRequestSeen } = makeHandlers(null);
    await handlers.markAzurePullRequestSeen("azure:pr1");
    expect(markPullRequestSeen).toHaveBeenCalledWith("azure:pr1");
  });
});

describe("azureCreatePullRequest — a quickfix branch becomes a review workspace", () => {
  const SHA = "a".repeat(40);
  const remoteUrl = "https://dev.azure.com/acme/Platform/_git/web-app";

  async function promote(payload: Record<string, unknown>, quickfixOverrides: Record<string, unknown> = {}) {
    const workspace = {
      id: "ws-qf",
      profileId: "default",
      cwd: "C:/fake/qf",
      review: {
        provider: "azure-devops",
        prKey: "",
        connectionId: "conn-1",
        repository: { id: "repo-1", name: "web-app", remoteUrl },
        pullRequest: null,
        checkout: { mode: "managed-worktree", rootPath: "C:/fake/qf", cacheRepoPath: "" },
      },
      quickfix: {
        connectionId: "conn-1",
        projectName: "Platform",
        repositoryId: "repo-1",
        repositoryName: "web-app",
        remoteUrl,
        baseBranch: "main",
        parentWorkspaceId: "",
        branchName: "fix/login",
        sourceBaselineSha: SHA,
        ...quickfixOverrides,
      },
    };
    const state = { workspaces: [workspace] };
    const handlers = createAzureHandlers({
      getState: () => state,
      store: { mutate: async (mutator: (draft: typeof state) => void) => mutator(state) },
      azure: {
        createPullRequestForWorkspace: vi.fn(async () => ({
          pullRequestId: 9,
          title: "T",
          url: "https://example.invalid/pr/9",
        })),
        buildPrKey: (connectionId: string, repositoryId: string, id: number) => `${connectionId}:${repositoryId}:${id}`,
        reviewStore: { upsertTrackedPullRequest: vi.fn(async () => {}) },
        seedPullRequestSummary: vi.fn(),
      },
      git: { getSnapshot: () => ({ available: true, remotes: { origin: remoteUrl }, branch: "fix/login" }) },
      resolveGitWorkspace: () => workspace,
      resolveGitRootPath: () => "",
      refreshGit: vi.fn(async () => {}),
      refreshAzure: vi.fn(async () => {}),
      broadcastState: vi.fn(),
      getPayload: () => ({}),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    await handlers.azureCreatePullRequest({ workspaceId: "ws-qf", targetBranch: "main", title: "T", ...payload });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return state.workspaces[0] as any;
  }

  test("the pre-PR baseline moves into the review for a PR from the same branch", async () => {
    const promoted = await promote({});
    expect(promoted.quickfix).toBeNull();
    expect(promoted.review).toMatchObject({ prKey: "conn-1:repo-1:9", sourceBaselineSha: SHA });
  });

  test("it is dropped when the PR comes from another branch than the one the baseline was bound to", async () => {
    const promoted = await promote({ sourceBranch: "something-else" });
    expect(promoted.review.prKey).toBe("conn-1:repo-1:9");
    expect(promoted.review.sourceBaselineSha).toBeUndefined();
  });

  test("nothing is invented for a quickfix that had no baseline", async () => {
    const promoted = await promote({}, { sourceBaselineSha: undefined });
    expect(promoted.review.sourceBaselineSha).toBeUndefined();
  });
});
