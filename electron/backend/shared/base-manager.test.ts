import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import { execFileSync } from "node:child_process";
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

describe("BaseProviderManager.syncReviewWorkspace", () => {
  function connectionSnapshot(overrides: Record<string, unknown> = {}) {
    return { id: "conn-1", tokenRef: "tok-ref-1", login: "me@example.com", ...overrides };
  }

  function reviewWorkspace(overrides: Record<string, unknown> = {}) {
    return {
      id: "ws-1",
      cwd: "/repo",
      review: { connectionId: "conn-1", pullRequest: { sourceRefName: "refs/heads/feature" } },
      ...overrides,
    };
  }

  /** Fake `git` invocations for syncReviewWorkspace, keyed by subcommand rather
   * than call order (extraArgs are prepended by runGit — see makeGitFake above). */
  function makeSyncGitFake({
    previousHead = "sha-old",
    finalHead = "sha-new",
    remoteHead = "sha-new",
    statusOutput = "",
    gitDirOutput = "",
    aheadCount = 0,
    behindCount = 1,
    fetchError,
  }: {
    previousHead?: string;
    finalHead?: string;
    remoteHead?: string;
    statusOutput?: string;
    gitDirOutput?: string;
    aheadCount?: number;
    behindCount?: number;
    fetchError?: Error;
  } = {}) {
    let revParseHeadCalls = 0;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- MIGRATION-EXEMPT: test double for execFileText
    return vi.fn(async (_bin: string, args: string[]): Promise<any> => {
      if (args.includes("fetch")) {
        if (fetchError) throw fetchError;
        return { stdout: "", stderr: "" };
      }
      if (args.includes("rev-parse")) {
        if (args.includes("--git-dir")) return { stdout: gitDirOutput, stderr: "" };
        if (args.includes("HEAD")) {
          revParseHeadCalls += 1;
          return { stdout: revParseHeadCalls === 1 ? previousHead : finalHead, stderr: "" };
        }
        return { stdout: remoteHead, stderr: "" };
      }
      if (args.includes("status")) return { stdout: statusOutput, stderr: "" };
      if (args.includes("rev-list")) {
        const range = args[args.length - 1];
        return { stdout: String(range.endsWith("..HEAD") ? aheadCount : behindCount), stderr: "" };
      }
      return { stdout: "", stderr: "" };
    });
  }

  test("already up to date: no dirty/rev-list/merge calls, returns previousHead unchanged", async () => {
    const execFileTextImpl = makeSyncGitFake({ previousHead: "sha-1", remoteHead: "sha-1" });
    const manager = createManager({ execFileTextImpl, secrets: { "tok-ref-1": "tok-123" } });
    manager.snapshot.connections = [connectionSnapshot()];

    const result = await manager.syncReviewWorkspace({ workspace: reviewWorkspace() });

    expect(result).toEqual({
      status: "already-current",
      message: "Already up to date.",
      commitCount: 0,
      headSha: "sha-1",
      previousHeadSha: "sha-1",
    });
    expect(execFileTextImpl.mock.calls.some((call) => call[1].includes("status"))).toBe(false);
    expect(execFileTextImpl.mock.calls.some((call) => call[1].includes("merge"))).toBe(false);
  });

  test("fetches the PR's exact source ref into its tracking ref, not a plain `fetch origin`", async () => {
    const execFileTextImpl = makeSyncGitFake({ previousHead: "sha-old", remoteHead: "sha-old" });
    const manager = createManager({ execFileTextImpl, secrets: { "tok-ref-1": "tok-123" } });
    manager.snapshot.connections = [connectionSnapshot()];

    await manager.syncReviewWorkspace({ workspace: reviewWorkspace() });

    const fetchCall = execFileTextImpl.mock.calls.find((call) => call[1].includes("fetch"));
    expect(fetchCall![1]).toEqual(
      expect.arrayContaining(["fetch", "origin", "+refs/heads/feature:refs/remotes/origin/feature"]),
    );
  });

  test("behind source: fast-forwards via `merge --ff-only` and reports the new HEAD + commit count", async () => {
    const execFileTextImpl = makeSyncGitFake({
      previousHead: "sha-old",
      finalHead: "sha-new",
      remoteHead: "sha-new",
      aheadCount: 0,
      behindCount: 3,
    });
    const manager = createManager({ execFileTextImpl, secrets: { "tok-ref-1": "tok-123" } });
    manager.snapshot.connections = [connectionSnapshot()];

    const result = await manager.syncReviewWorkspace({ workspace: reviewWorkspace() });

    expect(result).toEqual({
      status: "updated",
      message: "Updated 3 commits from origin/feature.",
      commitCount: 3,
      headSha: "sha-new",
      previousHeadSha: "sha-old",
    });
    const mergeCall = execFileTextImpl.mock.calls.find((call) => call[1].includes("merge"));
    expect(mergeCall![1]).toEqual(expect.arrayContaining(["merge", "--ff-only", "refs/remotes/origin/feature"]));
    // Never reset --hard, never rebase, never force-push — only a fast-forward merge.
    expect(execFileTextImpl.mock.calls.some((call) => call[1].includes("reset"))).toBe(false);
    expect(execFileTextImpl.mock.calls.some((call) => call[1].includes("rebase"))).toBe(false);
  });

  test("dirty worktree: refuses to merge and leaves HEAD untouched", async () => {
    const execFileTextImpl = makeSyncGitFake({
      previousHead: "sha-old",
      remoteHead: "sha-new",
      statusOutput: " M some-file.txt\n?? untracked.txt",
      behindCount: 2,
    });
    const manager = createManager({ execFileTextImpl, secrets: { "tok-ref-1": "tok-123" } });
    manager.snapshot.connections = [connectionSnapshot()];

    const result = await manager.syncReviewWorkspace({ workspace: reviewWorkspace() });

    expect(result.status).toBe("dirty");
    expect(result.message).toContain("2 uncommitted changes");
    expect(result.headSha).toBe("sha-old");
    expect(execFileTextImpl.mock.calls.some((call) => call[1].includes("merge"))).toBe(false);
  });

  test("local commits ahead of source: no-op, does not merge", async () => {
    const execFileTextImpl = makeSyncGitFake({
      previousHead: "sha-old",
      remoteHead: "sha-new",
      aheadCount: 2,
      behindCount: 0,
    });
    const manager = createManager({ execFileTextImpl, secrets: { "tok-ref-1": "tok-123" } });
    manager.snapshot.connections = [connectionSnapshot()];

    const result = await manager.syncReviewWorkspace({ workspace: reviewWorkspace() });

    expect(result.status).toBe("ahead");
    expect(execFileTextImpl.mock.calls.some((call) => call[1].includes("merge"))).toBe(false);
  });

  test("diverged history: no-op, does not merge", async () => {
    const execFileTextImpl = makeSyncGitFake({
      previousHead: "sha-old",
      remoteHead: "sha-new",
      aheadCount: 1,
      behindCount: 4,
    });
    const manager = createManager({ execFileTextImpl, secrets: { "tok-ref-1": "tok-123" } });
    manager.snapshot.connections = [connectionSnapshot()];

    const result = await manager.syncReviewWorkspace({ workspace: reviewWorkspace() });

    expect(result.status).toBe("diverged");
    expect(execFileTextImpl.mock.calls.some((call) => call[1].includes("merge"))).toBe(false);
  });

  test("throws the provider-specific connection-not-found message when the PR's connection is missing", async () => {
    const manager = createManager({ execFileTextImpl: vi.fn() });
    manager.connectionNotFoundMessage = "GitHub connection was not found.";

    await expect(
      manager.syncReviewWorkspace({ workspace: reviewWorkspace({ review: { connectionId: "missing" } }) }),
    ).rejects.toThrow("GitHub connection was not found.");
  });

  test("throws a clear error when the PR's source ref is missing/deleted", async () => {
    const manager = createManager({ execFileTextImpl: vi.fn(), secrets: { "tok-ref-1": "tok-123" } });
    manager.snapshot.connections = [connectionSnapshot()];

    await expect(
      manager.syncReviewWorkspace({
        workspace: reviewWorkspace({ review: { connectionId: "conn-1", pullRequest: {} } }),
      }),
    ).rejects.toThrow("Pull request source branch is unknown.");
  });

  test("propagates a comprehensible error when fetching the source ref fails (e.g. branch deleted upstream)", async () => {
    const execFileTextImpl = makeSyncGitFake({
      fetchError: Object.assign(new Error("fetch failed"), {
        stderr: "fatal: couldn't find remote ref refs/heads/feature",
      }),
    });
    const manager = createManager({ execFileTextImpl, secrets: { "tok-ref-1": "tok-123" } });
    manager.snapshot.connections = [connectionSnapshot()];

    await expect(manager.syncReviewWorkspace({ workspace: reviewWorkspace() })).rejects.toThrow(
      "couldn't find remote ref refs/heads/feature",
    );
  });

  test("never logs the PAT or its Basic-auth header", async () => {
    const execFileTextImpl = makeSyncGitFake({
      previousHead: "sha-old",
      remoteHead: "sha-new",
      behindCount: 1,
    });
    const manager = createManager({ execFileTextImpl, secrets: { "tok-ref-1": "super-secret-token" } });
    manager.snapshot.connections = [connectionSnapshot()];
    const debugSpy = vi.spyOn(manager.log, "debug").mockImplementation(() => {});

    await manager.syncReviewWorkspace({ workspace: reviewWorkspace() });

    for (const call of debugSpy.mock.calls) {
      expect(JSON.stringify(call)).not.toContain("super-secret-token");
      expect(JSON.stringify(call)).not.toContain("Basic ");
    }
  });
});

describe("BaseProviderManager.syncReviewWorkspace — real git fixture round-trip", () => {
  const GIT_AVAILABLE = (() => {
    try {
      execFileSync("git", ["--version"], { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  })();

  const tempPaths: string[] = [];
  afterEach(async () => {
    await Promise.all(tempPaths.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
  });

  function rg(cwd: string, args: string[]): string {
    return execFileSync("git", args, { cwd, encoding: "utf8" });
  }

  async function initBareRemote(): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "strideterm-sync-bare-"));
    tempPaths.push(dir);
    rg(dir, ["init", "--bare", "-q"]);
    return dir;
  }

  async function cloneWorkingCopy(bareDir: string): Promise<string> {
    const parent = await fs.mkdtemp(path.join(os.tmpdir(), "strideterm-sync-clone-"));
    tempPaths.push(parent);
    const dest = path.join(parent, "repo");
    rg(parent, ["clone", "-q", bareDir, dest]);
    rg(dest, ["config", "user.email", "t@example.com"]);
    rg(dest, ["config", "user.name", "Test"]);
    rg(dest, ["config", "commit.gpgsign", "false"]);
    rg(dest, ["config", "core.autocrlf", "false"]);
    return dest;
  }

  test.skipIf(!GIT_AVAILABLE)(
    "fast-forwards a real worktree onto the PR source branch's new remote commit",
    async () => {
      const bareDir = await initBareRemote();
      const authorDir = await cloneWorkingCopy(bareDir);

      rg(authorDir, ["checkout", "-b", "feature"]);
      await fs.writeFile(path.join(authorDir, "a.txt"), "one\n");
      rg(authorDir, ["add", "-A"]);
      rg(authorDir, ["commit", "-q", "-m", "feature commit 1"]);
      rg(authorDir, ["push", "-q", "-u", "origin", "feature"]);

      const reviewDir = await cloneWorkingCopy(bareDir);
      rg(reviewDir, ["checkout", "feature"]);
      const previousHead = rg(reviewDir, ["rev-parse", "HEAD"]).trim();

      // Author pushes a new commit to the PR's source branch after the review checkout was created.
      await fs.writeFile(path.join(authorDir, "a.txt"), "one\ntwo\n");
      rg(authorDir, ["add", "-A"]);
      rg(authorDir, ["commit", "-q", "-m", "feature commit 2"]);
      rg(authorDir, ["push", "-q", "origin", "feature"]);
      const authorHead = rg(authorDir, ["rev-parse", "HEAD"]).trim();
      expect(authorHead).not.toBe(previousHead);

      const manager = new BaseProviderManager({
        credentialStore: createCredentialStore({ "tok-ref-1": "tok-123" }) as unknown as ConstructorParameters<
          typeof BaseProviderManager
        >[0]["credentialStore"],
        reviewStore: createReviewStore() as unknown as ConstructorParameters<
          typeof BaseProviderManager
        >[0]["reviewStore"],
        createApi: () => ({}),
      });
      manager.snapshot.connections = [{ id: "conn-1", tokenRef: "tok-ref-1", login: "me@example.com" }];

      const result = await manager.syncReviewWorkspace({
        workspace: {
          id: "ws-1",
          cwd: reviewDir,
          review: { connectionId: "conn-1", pullRequest: { sourceRefName: "refs/heads/feature" } },
        },
      });

      expect(result.status).toBe("updated");
      expect(result.commitCount).toBe(1);
      expect(result.previousHeadSha).toBe(previousHead);
      expect(result.headSha).toBe(authorHead);
      expect(rg(reviewDir, ["rev-parse", "HEAD"]).trim()).toBe(authorHead);

      // Calling it again with nothing new pushed is a no-op.
      const again = await manager.syncReviewWorkspace({
        workspace: {
          id: "ws-1",
          cwd: reviewDir,
          review: { connectionId: "conn-1", pullRequest: { sourceRefName: "refs/heads/feature" } },
        },
      });
      expect(again.status).toBe("already-current");
    },
  );

  test.skipIf(!GIT_AVAILABLE)("refuses to update a dirty review worktree, leaving HEAD untouched", async () => {
    const bareDir = await initBareRemote();
    const authorDir = await cloneWorkingCopy(bareDir);
    rg(authorDir, ["checkout", "-b", "feature"]);
    await fs.writeFile(path.join(authorDir, "a.txt"), "one\n");
    rg(authorDir, ["add", "-A"]);
    rg(authorDir, ["commit", "-q", "-m", "feature commit 1"]);
    rg(authorDir, ["push", "-q", "-u", "origin", "feature"]);

    const reviewDir = await cloneWorkingCopy(bareDir);
    rg(reviewDir, ["checkout", "feature"]);
    const previousHead = rg(reviewDir, ["rev-parse", "HEAD"]).trim();
    await fs.writeFile(path.join(reviewDir, "a.txt"), "dirty local edit\n");

    await fs.writeFile(path.join(authorDir, "a.txt"), "one\ntwo\n");
    rg(authorDir, ["add", "-A"]);
    rg(authorDir, ["commit", "-q", "-m", "feature commit 2"]);
    rg(authorDir, ["push", "-q", "origin", "feature"]);

    const manager = new BaseProviderManager({
      credentialStore: createCredentialStore({ "tok-ref-1": "tok-123" }) as unknown as ConstructorParameters<
        typeof BaseProviderManager
      >[0]["credentialStore"],
      reviewStore: createReviewStore() as unknown as ConstructorParameters<typeof BaseProviderManager>[0]["reviewStore"],
      createApi: () => ({}),
    });
    manager.snapshot.connections = [{ id: "conn-1", tokenRef: "tok-ref-1", login: "me@example.com" }];

    const result = await manager.syncReviewWorkspace({
      workspace: {
        id: "ws-1",
        cwd: reviewDir,
        review: { connectionId: "conn-1", pullRequest: { sourceRefName: "refs/heads/feature" } },
      },
    });

    expect(result.status).toBe("dirty");
    expect(rg(reviewDir, ["rev-parse", "HEAD"]).trim()).toBe(previousHead);
  });

  test.skipIf(!GIT_AVAILABLE)(
    "uses the PR's explicit source ref, not the local branch name or its (missing) upstream",
    async () => {
      const bareDir = await initBareRemote();
      const authorDir = await cloneWorkingCopy(bareDir);
      rg(authorDir, ["checkout", "-b", "feature"]);
      await fs.writeFile(path.join(authorDir, "a.txt"), "one\n");
      rg(authorDir, ["add", "-A"]);
      rg(authorDir, ["commit", "-q", "-m", "feature commit 1"]);
      rg(authorDir, ["push", "-q", "-u", "origin", "feature"]);

      // The managed checkout's local branch is named differently from the PR's
      // source branch (e.g. "pr-42-scratch" vs "feature") and deliberately has
      // no upstream configured (--no-track) — a reused/older worktree may look
      // exactly like this. `@{upstream}` must NOT be consulted anywhere.
      const reviewDir = await cloneWorkingCopy(bareDir);
      rg(reviewDir, ["checkout", "--no-track", "-b", "pr-42-scratch", "origin/feature"]);
      expect(() => rg(reviewDir, ["rev-parse", "--abbrev-ref", "@{upstream}"])).toThrow();
      const previousHead = rg(reviewDir, ["rev-parse", "HEAD"]).trim();

      await fs.writeFile(path.join(authorDir, "a.txt"), "one\ntwo\n");
      rg(authorDir, ["add", "-A"]);
      rg(authorDir, ["commit", "-q", "-m", "feature commit 2"]);
      rg(authorDir, ["push", "-q", "origin", "feature"]);
      const authorHead = rg(authorDir, ["rev-parse", "HEAD"]).trim();

      const manager = new BaseProviderManager({
        credentialStore: createCredentialStore({ "tok-ref-1": "tok-123" }) as unknown as ConstructorParameters<
          typeof BaseProviderManager
        >[0]["credentialStore"],
        reviewStore: createReviewStore() as unknown as ConstructorParameters<
          typeof BaseProviderManager
        >[0]["reviewStore"],
        createApi: () => ({}),
      });
      manager.snapshot.connections = [{ id: "conn-1", tokenRef: "tok-ref-1", login: "me@example.com" }];

      const result = await manager.syncReviewWorkspace({
        workspace: {
          id: "ws-1",
          cwd: reviewDir,
          review: { connectionId: "conn-1", pullRequest: { sourceRefName: "refs/heads/feature" } },
        },
      });

      expect(result.status).toBe("updated");
      expect(result.previousHeadSha).toBe(previousHead);
      expect(result.headSha).toBe(authorHead);
      expect(rg(reviewDir, ["rev-parse", "HEAD"]).trim()).toBe(authorHead);
    },
  );
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
