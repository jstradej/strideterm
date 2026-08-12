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

// pushAzureReviewWorkspace wires the shared assertWorktreeCleanForPush guard
// (runtime-provider-guards.ts) in front of the real push. The guard itself is
// unit-tested in isolation; these tests pin its actual wiring into this
// handler — that it's called with the review workspace's cwd, that its thrown
// error propagates out of the handler, and that a dirty worktree blocks the
// push from ever reaching azure.pushReviewWorkspace.
describe("pushAzureReviewWorkspace — worktree-clean guard wiring", () => {
  function makeHandlers({ dirty = false, dirtyCount = 0 } = {}) {
    const workspace = { id: "ws-1", cwd: "/repo/ws-1", review: { prKey: "azure:pr1" } };
    const getCachedWorktreeDirtyState = vi.fn(async () => ({ dirty, dirtyCount }));
    const getSnapshot = vi.fn(() => ({ branch: "feature/foo" }));
    const pushReviewWorkspace = vi.fn(async () => {});
    const refreshGit = vi.fn(async () => {});
    const refreshAzure = vi.fn(async () => {});
    const getPayload = vi.fn(() => ({ ok: true }));
    const handlers = createAzureHandlers({
      getState: () => ({ workspaces: [workspace] }),
      git: { getCachedWorktreeDirtyState, getSnapshot },
      azure: { pushReviewWorkspace },
      refreshGit,
      refreshAzure,
      getPayload,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    return {
      handlers,
      workspace,
      getCachedWorktreeDirtyState,
      getSnapshot,
      pushReviewWorkspace,
      refreshGit,
      refreshAzure,
      getPayload,
    };
  }

  test("rejects and never pushes when the worktree has uncommitted changes", async () => {
    const { handlers, workspace, getCachedWorktreeDirtyState, pushReviewWorkspace, refreshGit, refreshAzure } =
      makeHandlers({ dirty: true, dirtyCount: 2 });

    await expect(handlers.pushAzureReviewWorkspace("ws-1")).rejects.toThrow(
      "Cannot push: 2 uncommitted changes in the worktree. Commit your changes first, then try again.",
    );

    expect(getCachedWorktreeDirtyState).toHaveBeenCalledWith(workspace.cwd);
    expect(pushReviewWorkspace).not.toHaveBeenCalled();
    expect(refreshGit).not.toHaveBeenCalled();
    expect(refreshAzure).not.toHaveBeenCalled();
  });

  test("pushes through when the worktree is clean", async () => {
    const { handlers, workspace, pushReviewWorkspace, refreshGit, refreshAzure, getPayload } = makeHandlers({
      dirty: false,
      dirtyCount: 0,
    });

    const result = await handlers.pushAzureReviewWorkspace("ws-1", { force: true });

    expect(pushReviewWorkspace).toHaveBeenCalledWith({ workspace, force: true, branch: "feature/foo" });
    expect(refreshGit).toHaveBeenCalledWith("ws-1");
    expect(refreshAzure).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ ok: true });
    expect(getPayload).toHaveBeenCalled();
  });
});

// syncAzureReviewWorkspace is the Refresh button's git-mutating half. Unlike
// fetch/rebase/push (no viewer/profile check at all today, see
// runtime-provider-guards.ts), this new handler must (a) refuse a workspace
// outside the caller's profile, (b) coalesce concurrent calls for the same
// workspace, and (c) return {payload, result} so the renderer can show the
// exact sync outcome.
describe("syncAzureReviewWorkspace — profile guard + in-flight coalescing", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function makeHandlers(overrides: any = {}) {
    const workspace = overrides.workspace ?? {
      id: "ws-1",
      cwd: "/repo/ws-1",
      review: { prKey: "azure:pr1", pullRequest: { sourceRefName: "refs/heads/feature" } },
    };
    const syncResult = overrides.syncResult ?? {
      status: "updated",
      message: "Updated 1 commit from origin/feature.",
      commitCount: 1,
      headSha: "sha-new",
      previousHeadSha: "sha-old",
    };
    const syncReviewWorkspace = overrides.syncReviewWorkspace ?? vi.fn(async () => syncResult);
    const refreshGit = overrides.refreshGit ?? vi.fn(async () => {});
    const refreshAzure = overrides.refreshAzure ?? vi.fn(async () => {});
    const broadcastState = overrides.broadcastState ?? vi.fn();
    const payload = overrides.payload ?? { ok: true };
    const getPayload = overrides.getPayload ?? vi.fn(() => payload);
    const assertWorkspaceInViewerProfile = overrides.assertWorkspaceInViewerProfile ?? vi.fn();
    const handlers = createAzureHandlers({
      getState: () => ({ workspaces: [workspace] }),
      azure: { syncReviewWorkspace },
      refreshGit,
      refreshAzure,
      broadcastState,
      getPayload,
      assertWorkspaceInViewerProfile,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    return {
      handlers,
      workspace,
      syncResult,
      syncReviewWorkspace,
      refreshGit,
      refreshAzure,
      broadcastState,
      getPayload,
      assertWorkspaceInViewerProfile,
      payload,
    };
  }

  test("runs the profile guard before touching git, and propagates its rejection", async () => {
    const assertWorkspaceInViewerProfile = vi.fn(() => {
      throw new Error("Cross-profile refused: workspace ws-1 is not in profile p2.");
    });
    const { handlers, syncReviewWorkspace } = makeHandlers({ assertWorkspaceInViewerProfile });

    await expect(handlers.syncAzureReviewWorkspace("ws-1", "remote:sess-b")).rejects.toThrow(/Cross-profile/);

    expect(assertWorkspaceInViewerProfile).toHaveBeenCalledWith("ws-1", "remote:sess-b");
    expect(syncReviewWorkspace).not.toHaveBeenCalled();
  });

  test("desktop IPC (no viewer id) is unaffected by the guard", async () => {
    const { handlers, syncReviewWorkspace, assertWorkspaceInViewerProfile } = makeHandlers();
    await handlers.syncAzureReviewWorkspace("ws-1");
    expect(assertWorkspaceInViewerProfile).toHaveBeenCalledWith("ws-1", undefined);
    expect(syncReviewWorkspace).toHaveBeenCalledTimes(1);
  });

  test("on success: refreshes git + azure, broadcasts, and returns {payload, result}", async () => {
    const {
      handlers,
      workspace,
      syncReviewWorkspace,
      refreshGit,
      refreshAzure,
      broadcastState,
      getPayload,
      payload,
      syncResult,
    } = makeHandlers();

    const response = await handlers.syncAzureReviewWorkspace("ws-1");

    expect(syncReviewWorkspace).toHaveBeenCalledWith({ workspace });
    expect(refreshGit).toHaveBeenCalledWith("ws-1");
    expect(refreshAzure).toHaveBeenCalledTimes(1);
    expect(broadcastState).toHaveBeenCalledTimes(1);
    expect(getPayload).toHaveBeenCalled();
    expect(response).toEqual({ payload, result: syncResult });
  });

  test("throws when the workspace has no review metadata", async () => {
    const { handlers } = makeHandlers({ workspace: { id: "ws-1", cwd: "/repo" } });
    await expect(handlers.syncAzureReviewWorkspace("ws-1")).rejects.toThrow("Azure review workspace not found.");
  });

  test("overlapping calls for the same workspace share one in-flight sync", async () => {
    let resolveSync: (value: unknown) => void = () => {};
    const gate = new Promise((resolve) => {
      resolveSync = resolve;
    });
    const syncReviewWorkspace = vi.fn(() => gate);
    const { handlers } = makeHandlers({ syncReviewWorkspace });

    const p1 = handlers.syncAzureReviewWorkspace("ws-1");
    const p2 = handlers.syncAzureReviewWorkspace("ws-1");
    resolveSync({
      status: "already-current",
      message: "Already up to date.",
      commitCount: 0,
      headSha: "s",
      previousHeadSha: "s",
    });
    const [r1, r2] = await Promise.all([p1, p2]);

    expect(syncReviewWorkspace).toHaveBeenCalledTimes(1);
    expect(r1).toBe(r2);
  });

  test("a sync issued after the previous one settles runs fresh, not deduped", async () => {
    const { handlers, syncReviewWorkspace } = makeHandlers();
    await handlers.syncAzureReviewWorkspace("ws-1");
    await handlers.syncAzureReviewWorkspace("ws-1");
    expect(syncReviewWorkspace).toHaveBeenCalledTimes(2);
  });
});
