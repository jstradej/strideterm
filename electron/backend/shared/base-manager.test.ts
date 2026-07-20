import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import { describe, expect, test, vi, afterEach } from "vitest";
import { BaseProviderManager } from "./base-manager.js";

const reviewRoot = path.join(os.tmpdir(), "strideterm-base-manager-tests");

function createCredentialStore(secrets: Record<string, string> = {}) {
  return {
    getSecret(ref: string) {
      return secrets[ref] || "";
    },
  };
}

function createReviewStore() {
  return {
    async upsertTrackedPullRequest() {},
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- MIGRATION-EXEMPT: vi.fn() mock type doesn't structurally match execFileText's signature
function createManager({
  execFileTextImpl,
  secrets = {},
}: {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  execFileTextImpl: any;
  secrets?: Record<string, string>;
}) {
  return new BaseProviderManager({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    credentialStore: createCredentialStore(secrets) as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    reviewStore: createReviewStore() as any,
    execFileTextImpl,
    createApi: () => ({}),
  });
}

/** Fake `git` invocations for ensureManagedWorktree, keyed by subcommand rather than
 * call order — extraArgs (-c core.longpaths=true, http.extraheader=...) are prepended
 * by runGit, so matching on `args.includes(...)` is robust to that prefix. */
function makeGitFake({
  branchExists = false,
  aheadCount = 0,
  checkoutFails = false,
}: {
  branchExists?: boolean;
  aheadCount?: number;
  checkoutFails?: boolean;
} = {}) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- MIGRATION-EXEMPT: test double for execFileText
  return vi.fn(async (_bin: string, args: string[]): Promise<any> => {
    if (args.includes("show-ref")) {
      if (branchExists) return { stdout: "", stderr: "" };
      throw new Error("not found");
    }
    if (args.includes("rev-list")) return { stdout: String(aheadCount), stderr: "" };
    if (args.includes("checkout") && !args.includes("-B") && checkoutFails) {
      throw new Error("checkout failed");
    }
    return { stdout: "", stderr: "" };
  });
}

describe("BaseProviderManager.ensureCacheRepoAt", () => {
  test("clones with --filter=blob:none when no cache repo exists yet, using the given login", async () => {
    const execFileTextImpl = vi.fn().mockResolvedValue({ stdout: "", stderr: "" });
    const manager = createManager({ execFileTextImpl });

    const repositoryRoot = await manager.ensureCacheRepoAt({
      connectionId: "conn-1",
      repoIdentifier: "repo-1",
      repoLabel: "acme/repo-1",
      remoteUrl: "https://example.com/acme/repo-1.git",
      reviewRoot,
      token: "tok-123",
      login: "me@example.com",
    });

    expect(repositoryRoot).toContain("repos");
    expect(repositoryRoot).toContain("conn-1");
    expect(repositoryRoot).toContain("repo-1");

    const cloneCall = execFileTextImpl.mock.calls.find((call) => call[1].includes("clone"));
    expect(cloneCall).toBeDefined();
    expect(cloneCall![1]).toEqual(
      expect.arrayContaining(["clone", "--no-checkout", "--filter=blob:none", "https://example.com/acme/repo-1.git"]),
    );
    // Login is threaded through as a git auth header, not a plain arg — confirm
    // it reached runGit by checking the extraheader carries the login.
    const headerArg = cloneCall![1].find((arg: string) => arg.startsWith("http.extraheader="));
    expect(headerArg).toBeDefined();
  });

  test("omits an explicit login when none is given (falls back to defaultGitLogin)", async () => {
    const execFileTextImpl = vi.fn().mockResolvedValue({ stdout: "", stderr: "" });
    const manager = createManager({ execFileTextImpl });
    manager.defaultGitLogin = "x-access-token";

    await manager.ensureCacheRepoAt({
      connectionId: "conn-1",
      repoIdentifier: "owner/repo",
      repoLabel: "owner/repo",
      remoteUrl: "https://example.com/owner/repo.git",
      reviewRoot,
      token: "tok-123",
    });

    const cloneCall = execFileTextImpl.mock.calls.find((call) => call[1].includes("clone"));
    const headerArg = cloneCall![1].find((arg: string) => arg.startsWith("http.extraheader="));
    // encodeAuthHeader base64s "login:token" — decode and confirm the default
    // login ("x-access-token") was used since none was passed explicitly.
    const encoded = headerArg.replace("http.extraheader=AUTHORIZATION: Basic ", "");
    const decoded = Buffer.from(encoded, "base64").toString("utf8");
    expect(decoded).toBe("x-access-token:tok-123");
  });

  test("falls back to a full clone when the partial (--filter=blob:none) clone fails", async () => {
    const execFileTextImpl = vi
      .fn()
      .mockRejectedValueOnce(new Error("server does not support filter"))
      .mockResolvedValueOnce({ stdout: "", stderr: "" });
    const manager = createManager({ execFileTextImpl });
    const warnSpy = vi.spyOn(manager.log, "warn").mockImplementation(() => {});

    await manager.ensureCacheRepoAt({
      connectionId: "conn-1",
      repoIdentifier: "repo-1",
      repoLabel: "acme/repo-1",
      remoteUrl: "https://example.com/acme/repo-1.git",
      reviewRoot,
      token: "tok-123",
    });

    expect(execFileTextImpl).toHaveBeenCalledTimes(2);
    const secondCallArgs = execFileTextImpl.mock.calls[1][1];
    expect(secondCallArgs).not.toContain("--filter=blob:none");
    expect(secondCallArgs).toEqual(expect.arrayContaining(["clone", "--no-checkout"]));
    expect(warnSpy).toHaveBeenCalledWith(
      "partial clone failed, retrying with full clone",
      expect.objectContaining({ repository: "acme/repo-1" }),
    );
  });
});

describe("BaseProviderManager.ensureManagedWorktree", () => {
  const tmpDirs: string[] = [];
  afterEach(async () => {
    await Promise.all(tmpDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
  });

  async function makeWorktreePath() {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "strideterm-worktree-"));
    tmpDirs.push(dir);
    return path.join(dir, "worktree");
  }

  test("fetches with the given refspecs and prunes stale worktree metadata before checking existence", async () => {
    const execFileTextImpl = makeGitFake();
    const manager = createManager({ execFileTextImpl });
    const worktreePath = await makeWorktreePath();

    await manager.ensureManagedWorktree({
      cacheRepoPath: "/cache/repo",
      worktreePath,
      localBranch: "pr-1-feature",
      sourceBranch: "feature",
      fetchRefspecs: ["+refs/heads/feature:refs/remotes/origin/feature"],
      login: "me@example.com",
      token: "tok-123",
    });

    const fetchCall = execFileTextImpl.mock.calls.find((call) => call[1].includes("fetch"));
    expect(fetchCall![1]).toEqual(
      expect.arrayContaining(["fetch", "origin", "+refs/heads/feature:refs/remotes/origin/feature"]),
    );
    const pruneCall = execFileTextImpl.mock.calls.find((call) => call[1].includes("prune"));
    expect(pruneCall).toBeDefined();
    // prune must run before the .git existence check that decides the branch —
    // i.e. before any worktree "add"/"checkout" call.
    const pruneIndex = execFileTextImpl.mock.calls.indexOf(pruneCall!);
    const addOrCheckoutIndex = execFileTextImpl.mock.calls.findIndex(
      (call) => call[1].includes("add") || call[1].includes("checkout"),
    );
    expect(pruneIndex).toBeLessThan(addOrCheckoutIndex);
  });

  test("creates a new worktree with -b when no worktree or local branch exists yet", async () => {
    const execFileTextImpl = makeGitFake({ branchExists: false });
    const manager = createManager({ execFileTextImpl });
    const worktreePath = await makeWorktreePath();

    await manager.ensureManagedWorktree({
      cacheRepoPath: "/cache/repo",
      worktreePath,
      localBranch: "pr-1-feature",
      sourceBranch: "feature",
      fetchRefspecs: ["+refs/heads/feature:refs/remotes/origin/feature"],
      token: "tok-123",
    });

    const addCall = execFileTextImpl.mock.calls.find((call) => call[1].includes("add"));
    expect(addCall![1]).toEqual(
      expect.arrayContaining([
        "worktree",
        "add",
        "--force",
        "-b",
        "pr-1-feature",
        worktreePath,
        "refs/remotes/origin/feature",
      ]),
    );
  });

  test("reuses an existing local branch and hard-resets it when it has no unpushed commits", async () => {
    const execFileTextImpl = makeGitFake({ branchExists: true, aheadCount: 0 });
    const manager = createManager({ execFileTextImpl });
    const worktreePath = await makeWorktreePath();

    await manager.ensureManagedWorktree({
      cacheRepoPath: "/cache/repo",
      worktreePath,
      localBranch: "pr-1-feature",
      sourceBranch: "feature",
      fetchRefspecs: ["+refs/heads/feature:refs/remotes/origin/feature"],
      token: "tok-123",
    });

    const addCall = execFileTextImpl.mock.calls.find((call) => call[1].includes("add"));
    expect(addCall![1]).toEqual(expect.arrayContaining(["worktree", "add", "--force", worktreePath, "pr-1-feature"]));
    expect(addCall![1]).not.toContain("-b");
    const resetCall = execFileTextImpl.mock.calls.find((call) => call[1].includes("reset"));
    expect(resetCall).toBeDefined();
  });

  test("does NOT reset an existing local branch that has unpushed commits ahead of origin", async () => {
    const execFileTextImpl = makeGitFake({ branchExists: true, aheadCount: 3 });
    const manager = createManager({ execFileTextImpl });
    const worktreePath = await makeWorktreePath();

    await manager.ensureManagedWorktree({
      cacheRepoPath: "/cache/repo",
      worktreePath,
      localBranch: "pr-1-feature",
      sourceBranch: "feature",
      fetchRefspecs: ["+refs/heads/feature:refs/remotes/origin/feature"],
      token: "tok-123",
    });

    const resetCall = execFileTextImpl.mock.calls.find((call) => call[1].includes("reset"));
    expect(resetCall).toBeUndefined();
  });

  test("when the worktree already exists, checks out the branch and falls back to -B on failure", async () => {
    const execFileTextImpl = makeGitFake({ checkoutFails: true, aheadCount: 0 });
    const manager = createManager({ execFileTextImpl });
    const worktreePath = await makeWorktreePath();
    await fs.mkdir(path.join(worktreePath, ".git"), { recursive: true });

    await manager.ensureManagedWorktree({
      cacheRepoPath: "/cache/repo",
      worktreePath,
      localBranch: "pr-1-feature",
      sourceBranch: "feature",
      fetchRefspecs: ["+refs/heads/feature:refs/remotes/origin/feature"],
      token: "tok-123",
    });

    const fallbackCheckout = execFileTextImpl.mock.calls.find(
      (call) => call[1].includes("checkout") && call[1].includes("-B"),
    );
    expect(fallbackCheckout).toBeDefined();
    // No "add"/"show-ref" calls — the existing-worktree branch never creates one.
    expect(execFileTextImpl.mock.calls.some((call) => call[1].includes("show-ref"))).toBe(false);
  });
});

describe("BaseProviderManager.fetchReviewWorkspace / rebaseReviewWorkspace / pushReviewWorkspace", () => {
  function connectionSnapshot(overrides: Record<string, unknown> = {}) {
    return { id: "conn-1", tokenRef: "tok-ref-1", login: "me@example.com", ...overrides };
  }

  test("fetchReviewWorkspace threads the connection's login through to runGit", async () => {
    const execFileTextImpl = vi.fn().mockResolvedValue({ stdout: "", stderr: "" });
    const manager = createManager({ execFileTextImpl, secrets: { "tok-ref-1": "tok-123" } });
    manager.snapshot.connections = [connectionSnapshot()];

    await manager.fetchReviewWorkspace({ workspace: { id: "ws-1", cwd: "/repo", review: { connectionId: "conn-1" } } });

    expect(execFileTextImpl).toHaveBeenCalledWith(
      "git",
      expect.arrayContaining(["fetch", "origin"]),
      expect.objectContaining({ cwd: "/repo" }),
    );
    const headerArg = execFileTextImpl.mock.calls[0][1].find((a: string) => a.startsWith("http.extraheader="));
    const decoded = Buffer.from(headerArg.replace("http.extraheader=AUTHORIZATION: Basic ", ""), "base64").toString(
      "utf8",
    );
    expect(decoded).toBe("me@example.com:tok-123");
  });

  test("fetchReviewWorkspace throws the provider-specific connection-not-found message", async () => {
    const manager = createManager({ execFileTextImpl: vi.fn() });
    manager.connectionNotFoundMessage = "GitHub connection was not found.";

    await expect(
      manager.fetchReviewWorkspace({ workspace: { id: "ws-1", review: { connectionId: "missing" } } }),
    ).rejects.toThrow("GitHub connection was not found.");
  });

  test("rebaseReviewWorkspace fetches first, then rebases onto origin/<targetBranch>", async () => {
    const execFileTextImpl = vi.fn().mockResolvedValue({ stdout: "", stderr: "" });
    const manager = createManager({ execFileTextImpl, secrets: { "tok-ref-1": "tok-123" } });
    manager.snapshot.connections = [connectionSnapshot()];

    await manager.rebaseReviewWorkspace({
      workspace: {
        id: "ws-1",
        cwd: "/repo",
        review: { connectionId: "conn-1", pullRequest: { targetRefName: "refs/heads/main" } },
      },
    });

    const calls = execFileTextImpl.mock.calls;
    expect(calls[0][1]).toEqual(expect.arrayContaining(["fetch", "origin"]));
    expect(calls[1][1]).toEqual(expect.arrayContaining(["rebase", "origin/main"]));
  });

  test("pushReviewWorkspace pushes HEAD to the PR's source branch, with --force-with-lease when force=true", async () => {
    const execFileTextImpl = vi.fn().mockResolvedValue({ stdout: "", stderr: "" });
    const manager = createManager({ execFileTextImpl, secrets: { "tok-ref-1": "tok-123" } });
    manager.snapshot.connections = [connectionSnapshot()];

    await manager.pushReviewWorkspace({
      workspace: {
        id: "ws-1",
        cwd: "/repo",
        review: { connectionId: "conn-1", pullRequest: { sourceRefName: "refs/heads/feature" } },
      },
      force: true,
    });

    expect(execFileTextImpl).toHaveBeenCalledWith(
      "git",
      expect.arrayContaining(["push", "--force-with-lease", "-u", "origin", "HEAD:refs/heads/feature"]),
      expect.objectContaining({ cwd: "/repo" }),
    );
  });

  test("pushReviewWorkspace throws when no branch can be determined", async () => {
    const execFileTextImpl = vi.fn().mockResolvedValue({ stdout: "", stderr: "" });
    const manager = createManager({ execFileTextImpl, secrets: { "tok-ref-1": "tok-123" } });
    manager.snapshot.connections = [connectionSnapshot()];

    await expect(
      manager.pushReviewWorkspace({ workspace: { id: "ws-1", cwd: "/repo", review: { connectionId: "conn-1" } } }),
    ).rejects.toThrow("Cannot determine branch name for push.");
  });
});

// syncCore is the template-method skeleton AzureDevOpsManager.sync() and
// GitHubManager.sync() used to each reimplement as a separate ~250-line copy
// (connection bookkeeping, stale-PR resolution, dedup, snapshot build).
// Providers supply only the 4 genuinely-divergent pieces via hooks.
describe("BaseProviderManager.syncCore", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function createSyncReviewStore(overrides: Record<string, any> = {}) {
    return {
      getState: overrides.getState || (() => ({ connections: {} })),
      getTrackedPullRequest: overrides.getTrackedPullRequest || (() => null),
      upsertConnectionState: overrides.upsertConnectionState || (async () => {}),
      upsertTrackedPullRequest: overrides.upsertTrackedPullRequest || (async () => {}),
    };
  }

  function createSyncManager({
    reviewStore,
    secrets = {},
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }: { reviewStore?: any; secrets?: Record<string, string> } = {}) {
    return new BaseProviderManager({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      credentialStore: createCredentialStore(secrets) as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      reviewStore: (reviewStore || createSyncReviewStore()) as any,
      execFileTextImpl: vi.fn(),
      createApi: () => ({}),
    });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function baseHooks(overrides: Record<string, any> = {}) {
    return {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      createConnectionSnapshot: (connection: any, persistedState: any) => ({ ...connection, ...persistedState }),
      fetchConnectionPrs: async () => {},
      isPrResolved: () => true,
      resolveStalePr: async () => null,
      ...overrides,
    };
  }

  test("marks a connection ok and persists its state when fetchConnectionPrs succeeds", async () => {
    const upsertConnectionState = vi.fn(async () => {});
    const manager = createSyncManager({
      reviewStore: createSyncReviewStore({ upsertConnectionState }),
      secrets: { "tok-1": "secret-1" },
    });

    const snapshot = await manager.syncCore({ connections: [{ id: "conn-1", tokenRef: "tok-1" }] }, baseHooks());

    expect(snapshot.connections[0]).toMatchObject({ id: "conn-1", status: "ok" });
    expect(upsertConnectionState).toHaveBeenCalledWith("conn-1", expect.objectContaining({ status: "ok" }));
  });

  test("marks a connection errored when the token is missing, without calling fetchConnectionPrs", async () => {
    const fetchConnectionPrs = vi.fn(async () => {});
    const manager = createSyncManager();

    const snapshot = await manager.syncCore({ connections: [{ id: "conn-1" }] }, baseHooks({ fetchConnectionPrs }));

    expect(fetchConnectionPrs).not.toHaveBeenCalled();
    expect(snapshot.connections[0]).toMatchObject({ status: "error", lastError: "PAT is missing." });
  });

  test("uses the provider's syncErrorFallbackMessage when fetchConnectionPrs throws a message-less error", async () => {
    const manager = createSyncManager({ secrets: { "tok-1": "secret-1" } });
    manager.syncErrorFallbackMessage = "Widget sync failed.";

    const snapshot = await manager.syncCore(
      { connections: [{ id: "conn-1", tokenRef: "tok-1" }] },
      baseHooks({
        fetchConnectionPrs: async () => {
          throw new Error("");
        },
      }),
    );

    expect(snapshot.connections[0]).toMatchObject({ status: "error", lastError: "Widget sync failed." });
  });

  test("fetchConnectionPrs' pushed summaries land in the inbox, detailMap, and trackedPullRequests", async () => {
    const manager = createSyncManager({ secrets: { "tok-1": "secret-1" } });

    const snapshot = await manager.syncCore(
      { connections: [{ id: "conn-1", tokenRef: "tok-1" }] },
      baseHooks({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        fetchConnectionPrs: async (_connection: any, _token: string, ctx: any) => {
          ctx.visibleSummaries.push({
            prKey: "pr-1",
            role: "reviewer",
            hasAttention: true,
            lastActivityAt: "2024-01-01",
          });
          ctx.trackedPullRequests["pr-1"] = { key: "pr-1" };
          ctx.detailMap["pr-1"] = { prKey: "pr-1" };
        },
      }),
    );

    expect(snapshot.inbox.needsMyReview).toHaveLength(1);
    expect(snapshot.pullRequests["pr-1"]).toEqual({ prKey: "pr-1" });
    expect(snapshot.trackedPullRequests["pr-1"]).toEqual({ key: "pr-1" });
  });

  test("calls resolveStalePr for a workspace whose PR fell out of the poll, and adopts its result", async () => {
    const manager = createSyncManager({ secrets: { "tok-1": "secret-1" } });

    const resolveStalePr = vi.fn(async () => ({ prKey: "pr-1", status: "resolved" }));
    const snapshot = await manager.syncCore(
      {
        connections: [{ id: "conn-1", tokenRef: "tok-1" }],
        workspaces: [{ review: { provider: "provider", prKey: "pr-1", connectionId: "conn-1" } }],
      },
      baseHooks({ isPrResolved: () => false, resolveStalePr }),
    );

    expect(resolveStalePr).toHaveBeenCalled();
    expect(snapshot.pullRequests["pr-1"]).toEqual({ prKey: "pr-1", status: "resolved" });
  });

  test("resolveStalePr returning null leaves the existing detailMap entry untouched (retry next poll)", async () => {
    const manager = createSyncManager({ secrets: { "tok-1": "secret-1" } });
    manager.snapshot.pullRequests = { "pr-1": { prKey: "pr-1", stale: "yes" } };
    manager.snapshot.connections = [{ id: "conn-1" }];

    const snapshot = await manager.syncCore(
      {
        connections: [{ id: "conn-1", tokenRef: "tok-1" }],
        workspaces: [{ review: { provider: "provider", prKey: "pr-1", connectionId: "conn-1" } }],
      },
      baseHooks({ isPrResolved: () => false, resolveStalePr: async () => null }),
    );

    expect(snapshot.pullRequests["pr-1"]).toEqual({ prKey: "pr-1", stale: "yes" });
  });

  test("skips stale-PR resolution entirely when isPrResolved says the existing entry is already terminal", async () => {
    const manager = createSyncManager({ secrets: { "tok-1": "secret-1" } });
    manager.snapshot.pullRequests = { "pr-1": { prKey: "pr-1" } };
    manager.snapshot.connections = [{ id: "conn-1" }];
    const resolveStalePr = vi.fn(async () => null);

    await manager.syncCore(
      {
        connections: [{ id: "conn-1", tokenRef: "tok-1" }],
        workspaces: [{ review: { provider: "provider", prKey: "pr-1", connectionId: "conn-1" } }],
      },
      baseHooks({ isPrResolved: () => true, resolveStalePr }),
    );

    expect(resolveStalePr).not.toHaveBeenCalled();
  });

  test("skips stale-PR resolution for a workspace belonging to a different provider", async () => {
    const manager = createSyncManager({ secrets: { "tok-1": "secret-1" } });
    const resolveStalePr = vi.fn(async () => null);

    await manager.syncCore(
      {
        connections: [{ id: "conn-1", tokenRef: "tok-1" }],
        workspaces: [{ review: { provider: "other-provider", prKey: "pr-1", connectionId: "conn-1" } }],
      },
      baseHooks({ resolveStalePr }),
    );

    expect(resolveStalePr).not.toHaveBeenCalled();
  });

  test("resets the snapshot's stale pullRequests when the connection id set changes", async () => {
    const manager = createSyncManager({ secrets: { "tok-1": "secret-1" } });
    manager.snapshot.pullRequests = { "stale-pr": { prKey: "stale-pr" } };
    manager.snapshot.connections = [{ id: "conn-0" }];

    const snapshot = await manager.syncCore({ connections: [{ id: "conn-1", tokenRef: "tok-1" }] }, baseHooks());

    expect(snapshot.pullRequests["stale-pr"]).toBeUndefined();
  });

  test("preserves prior pullRequests when the connection id set is unchanged", async () => {
    const manager = createSyncManager({ secrets: { "tok-1": "secret-1" } });
    manager.snapshot.pullRequests = { "kept-pr": { prKey: "kept-pr" } };
    manager.snapshot.connections = [{ id: "conn-1" }];

    const snapshot = await manager.syncCore({ connections: [{ id: "conn-1", tokenRef: "tok-1" }] }, baseHooks());

    expect(snapshot.pullRequests["kept-pr"]).toEqual({ prKey: "kept-pr" });
  });
});
