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

// The git token travels in the child's GIT_CONFIG_* environment (git >= 2.31) or, on older
// gits, as `-c http.extraheader=…` argv. Returns the decoded "login:token" either way.
function decodeGitAuth(call: unknown[]): string | null {
  const [, args, options] = call as [string, string[], { env?: Record<string, string> }?];
  const argHeader = args.find((a) => a.startsWith("http.extraheader="));
  const header = argHeader?.slice("http.extraheader=".length) ?? options?.env?.GIT_CONFIG_VALUE_0;
  if (!header) return null;
  return Buffer.from(header.replace("AUTHORIZATION: Basic ", ""), "base64").toString("utf8");
}

function createManager({
  execFileTextImpl,
  secrets = {},
  gitVersion = "git version 2.43.0",
}: {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  execFileTextImpl: any;
  secrets?: Record<string, string>;
  gitVersion?: string;
}) {
  return new BaseProviderManager({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    credentialStore: createCredentialStore(secrets) as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    reviewStore: createReviewStore() as any,
    execFileTextImpl,
    gitVersionImpl: async () => gitVersion,
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
    // it reached runGit by checking the header carries the login.
    expect(decodeGitAuth(cloneCall!)).toBe("me@example.com:tok-123");
  });

  test("hands the token to git through GIT_CONFIG_* env, not argv, on git >= 2.31", async () => {
    const execFileTextImpl = vi.fn().mockResolvedValue({ stdout: "", stderr: "" });
    const manager = createManager({ execFileTextImpl });

    await manager.runGit("/repo", ["fetch", "origin"], { login: "me", token: "tok-123" });

    const [, args, options] = execFileTextImpl.mock.calls[0];
    expect(JSON.stringify(args)).not.toMatch(/extraheader|Basic|tok-123/);
    expect(options.env.GIT_CONFIG_COUNT).toBe("1");
    expect(options.env.GIT_CONFIG_KEY_0).toBe("http.extraheader");
    expect(decodeGitAuth(execFileTextImpl.mock.calls[0])).toBe("me:tok-123");
  });

  test("keeps the -c http.extraheader argv path on git 2.30", async () => {
    const execFileTextImpl = vi.fn().mockResolvedValue({ stdout: "", stderr: "" });
    const manager = createManager({ execFileTextImpl, gitVersion: "git version 2.30.2" });

    await manager.runGit("/repo", ["fetch", "origin"], { login: "me", token: "tok-123" });

    const [, args, options] = execFileTextImpl.mock.calls[0];
    expect(args.some((a: string) => a.startsWith("http.extraheader="))).toBe(true);
    expect(options.env.GIT_CONFIG_COUNT).toBeUndefined();
    expect(decodeGitAuth(execFileTextImpl.mock.calls[0])).toBe("me:tok-123");
  });

  test("passes no auth at all when there is no token", async () => {
    const execFileTextImpl = vi.fn().mockResolvedValue({ stdout: "", stderr: "" });
    const manager = createManager({ execFileTextImpl });

    await manager.runGit("/repo", ["status"]);

    expect(decodeGitAuth(execFileTextImpl.mock.calls[0])).toBeNull();
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
    // encodeAuthHeader base64s "login:token" — decode and confirm the default
    // login ("x-access-token") was used since none was passed explicitly.
    expect(decodeGitAuth(cloneCall!)).toBe("x-access-token:tok-123");
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

const GIT_AVAILABLE = (() => {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

function rg(cwd: string, args: string[]): string {
  return execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=t@example.com", ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

/** A bare "remote" with `main` and a `feature` branch, plus helpers that act as the PR author. */
async function createRemote(tempPaths: string[]) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "strideterm-bm-"));
  tempPaths.push(root);
  const remote = path.join(root, "remote.git");
  const seed = path.join(root, "seed");
  rg(root, ["init", "--bare", "-q", "-b", "main", remote]);
  rg(root, ["clone", "-q", remote, seed]);
  await fs.writeFile(path.join(seed, "a.txt"), "a\n");
  rg(seed, ["add", "-A"]);
  rg(seed, ["commit", "-q", "-m", "A"]);
  rg(seed, ["push", "-q", "origin", "HEAD:refs/heads/main"]);
  rg(seed, ["checkout", "-q", "-b", "feature"]);
  await fs.writeFile(path.join(seed, "f.txt"), "f1\n");
  rg(seed, ["add", "-A"]);
  rg(seed, ["commit", "-q", "-m", "feature 1"]);
  rg(seed, ["push", "-q", "origin", "feature"]);
  return {
    root,
    remote,
    seed,
    async authorCommit(message: string): Promise<string> {
      rg(seed, ["checkout", "-q", "feature"]);
      await fs.writeFile(path.join(seed, `${message.replace(/\W+/gu, "_")}.txt`), `${message}\n`);
      rg(seed, ["add", "-A"]);
      rg(seed, ["commit", "-q", "-m", message]);
      rg(seed, ["push", "-q", "origin", "feature"]);
      return rg(seed, ["rev-parse", "HEAD"]);
    },
    remoteFeature: () => rg(remote, ["rev-parse", "refs/heads/feature"]),
  };
}

describe("BaseProviderManager.ensureManagedWorktree", () => {
  const tempPaths: string[] = [];
  afterEach(async () => {
    await Promise.all(tempPaths.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
  });

  async function cacheRepoFor(remote: string): Promise<string> {
    const parent = await fs.mkdtemp(path.join(os.tmpdir(), "strideterm-bm-cache-"));
    tempPaths.push(parent);
    const cache = path.join(parent, "cache");
    rg(parent, ["clone", "-q", "--no-checkout", remote, cache]);
    return cache;
  }

  function ensure(manager: ReturnType<typeof createManager>, cache: string, worktreePath: string) {
    return manager.ensureManagedWorktree({
      cacheRepoPath: cache,
      worktreePath,
      localBranch: "pr-7-feature",
      sourceBranch: "feature",
      fetchRefspecs: ["+refs/heads/feature:refs/remotes/origin/feature", "+refs/heads/main:refs/remotes/origin/main"],
      token: "tok-123",
    });
  }

  function realManager() {
    return new BaseProviderManager({
      credentialStore: createCredentialStore() as unknown as ConstructorParameters<
        typeof BaseProviderManager
      >[0]["credentialStore"],
      reviewStore: createReviewStore() as unknown as ConstructorParameters<
        typeof BaseProviderManager
      >[0]["reviewStore"],
      createApi: () => ({}),
    });
  }

  test.skipIf(!GIT_AVAILABLE)("creates a worktree on a new local branch at the PR source tip", async () => {
    const remote = await createRemote(tempPaths);
    const cache = await cacheRepoFor(remote.remote);
    const worktreePath = path.join(remote.root, "wt");

    await ensure(realManager(), cache, worktreePath);

    expect(rg(worktreePath, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("pr-7-feature");
    expect(rg(worktreePath, ["rev-parse", "HEAD"])).toBe(remote.remoteFeature());
  });

  test.skipIf(!GIT_AVAILABLE)("fast-forwards a reused local branch that is behind, discarding nothing", async () => {
    const remote = await createRemote(tempPaths);
    const cache = await cacheRepoFor(remote.remote);
    const manager = realManager();
    const first = path.join(remote.root, "wt1");
    await ensure(manager, cache, first);
    rg(cache, ["worktree", "remove", "--force", first]);
    const tip = await remote.authorCommit("feature 2");

    const second = path.join(remote.root, "wt2");
    await ensure(manager, cache, second);

    expect(rg(second, ["rev-parse", "HEAD"])).toBe(tip);
  });

  test.skipIf(!GIT_AVAILABLE)(
    "leaves a reused branch with local commits exactly where it is — no baseline proves they are orphans",
    async () => {
      const remote = await createRemote(tempPaths);
      const cache = await cacheRepoFor(remote.remote);
      const manager = realManager();
      const first = path.join(remote.root, "wt1");
      await ensure(manager, cache, first);
      await fs.writeFile(path.join(first, "mine.txt"), "mine\n");
      rg(first, ["add", "-A"]);
      rg(first, ["commit", "-q", "-m", "mine"]);
      const mine = rg(first, ["rev-parse", "HEAD"]);
      rg(cache, ["worktree", "remove", "--force", first]);
      // The author rewrites the branch: the old tip is no longer an ancestor of it.
      rg(remote.seed, ["checkout", "-q", "feature"]);
      rg(remote.seed, ["reset", "-q", "--hard", "main"]);
      rg(remote.seed, ["commit", "-q", "--allow-empty", "-m", "rewritten"]);
      rg(remote.seed, ["push", "-q", "--force", "origin", "feature"]);

      const second = path.join(remote.root, "wt2");
      await ensure(manager, cache, second);

      expect(rg(second, ["rev-parse", "HEAD"])).toBe(mine);
    },
  );

  test.skipIf(!GIT_AVAILABLE)("an existing worktree is checked out again and fast-forwarded when clean", async () => {
    const remote = await createRemote(tempPaths);
    const cache = await cacheRepoFor(remote.remote);
    const manager = realManager();
    const worktreePath = path.join(remote.root, "wt");
    await ensure(manager, cache, worktreePath);
    const tip = await remote.authorCommit("feature 2");

    await ensure(manager, cache, worktreePath);

    expect(rg(worktreePath, ["rev-parse", "HEAD"])).toBe(tip);
  });

  test.skipIf(!GIT_AVAILABLE)("an existing worktree with edits is never moved", async () => {
    const remote = await createRemote(tempPaths);
    const cache = await cacheRepoFor(remote.remote);
    const manager = realManager();
    const worktreePath = path.join(remote.root, "wt");
    await ensure(manager, cache, worktreePath);
    const before = rg(worktreePath, ["rev-parse", "HEAD"]);
    await fs.writeFile(path.join(worktreePath, "f.txt"), "edited\n");
    await remote.authorCommit("feature 2");

    await ensure(manager, cache, worktreePath);

    expect(rg(worktreePath, ["rev-parse", "HEAD"])).toBe(before);
    expect(await fs.readFile(path.join(worktreePath, "f.txt"), "utf8")).toBe("edited\n");
  });
});

describe("BaseProviderManager review Git operations", () => {
  const tempPaths: string[] = [];
  afterEach(async () => {
    await Promise.all(tempPaths.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
  });

  interface AuditRow {
    id: number;
    entry: Record<string, unknown>;
    outcome?: { success: boolean; details?: Record<string, unknown> };
  }

  async function setup({ withSummary = false }: { withSummary?: boolean } = {}) {
    const remote = await createRemote(tempPaths);
    const checkout = path.join(remote.root, "checkout");
    rg(remote.root, ["clone", "-q", remote.remote, checkout]);
    rg(checkout, ["checkout", "-q", "-b", "pr-7-feature", "origin/feature"]);

    const rows: AuditRow[] = [];
    const auditLogStore = {
      logEntry: () => true,
      insertEntry(entry: Record<string, unknown>) {
        rows.push({ id: rows.length + 1, entry });
        return rows.length;
      },
      finishEntry(id: number, outcome: { success: boolean; details?: Record<string, unknown> }) {
        rows[id - 1].outcome = outcome;
        return true;
      },
    };
    const calls: Array<{ args: string[]; env?: Record<string, string> }> = [];
    const execFileTextImpl = vi.fn(
      async (bin: string, args: string[], options?: { cwd?: string; env?: Record<string, string> }) => {
        calls.push({ args, env: options?.env });
        const { execFileText } = await import("../process-utils.js");
        return execFileText(bin, args, options);
      },
    );
    const manager = new BaseProviderManager({
      credentialStore: createCredentialStore({ "tok-ref-1": "super-secret-token" }) as unknown as ConstructorParameters<
        typeof BaseProviderManager
      >[0]["credentialStore"],
      reviewStore: createReviewStore() as unknown as ConstructorParameters<
        typeof BaseProviderManager
      >[0]["reviewStore"],
      auditLogStore,
      execFileTextImpl: execFileTextImpl as unknown as ConstructorParameters<
        typeof BaseProviderManager
      >[0]["execFileTextImpl"],
      createApi: () => ({}),
    });
    manager.providerLabel = "github";
    manager.snapshot.connections = [{ id: "conn-1", tokenRef: "tok-ref-1", login: "me@example.com" }];
    const sourceRepository = {
      id: "100",
      name: "repo",
      fullName: "acme/repo",
      remoteUrl: remote.remote,
      sameAsTarget: true,
      canPush: null,
    };
    if (withSummary) {
      manager.snapshot.pullRequests["conn-1:repo:7"] = { prKey: "conn-1:repo:7", sourceRepository };
    }
    const saved: Array<{ workspaceId: string; patch: Record<string, unknown> }> = [];
    manager.setReviewWorkspaceMetadataStore({
      async updateReview(workspaceId, patch) {
        saved.push({ workspaceId, patch });
      },
    });
    const workspace = {
      id: "ws-1",
      cwd: checkout,
      profileId: "profile-a",
      review: {
        provider: "github",
        prKey: "conn-1:repo:7",
        connectionId: "conn-1",
        role: "reviewer",
        repository: { remoteUrl: remote.remote },
        sourceRepository: withSummary ? null : sourceRepository,
        sourceBaselineSha: "",
        pullRequest: { id: 7, sourceRefName: "refs/heads/feature", targetRefName: "refs/heads/main" },
      },
    };
    return { remote, checkout, manager, workspace, rows, saved, calls };
  }

  test.skipIf(!GIT_AVAILABLE)(
    "sync fast-forwards, records the baseline through the metadata store bound to the source identity",
    async () => {
      const { remote, checkout, manager, workspace, saved } = await setup();
      const tip = await remote.authorCommit("feature 2");

      const result = await manager.syncReviewWorkspace({ workspace });

      expect(result.status).toBe("updated");
      expect(rg(checkout, ["rev-parse", "HEAD"])).toBe(tip);
      expect(saved).toHaveLength(1);
      expect(saved[0].workspaceId).toBe("ws-1");
      expect(saved[0].patch.sourceBaselineSha).toBe(tip);
      expect(saved[0].patch.expectedIdentityKey).toContain("github|conn-1|conn-1:repo:7|refs/heads/feature|id:100");
    },
  );

  test.skipIf(!GIT_AVAILABLE)("writes one audit row per mutation: intent first, outcome on the same row", async () => {
    const { remote, manager, workspace, rows } = await setup();
    await remote.authorCommit("feature 2");

    await manager.syncReviewWorkspace({
      workspace,
      requester: { source: "mcp", agent: "claude", consent: "yes", operationId: "op-9" },
    });

    expect(rows).toHaveLength(1);
    expect(rows[0].entry).toMatchObject({
      connectionId: "conn-1",
      operation: "gitSync-merge",
      category: "write",
      resourceId: "ws-1",
      operationId: "op-9",
    });
    expect(JSON.parse(String(rows[0].entry.details))).toMatchObject({
      workspaceId: "ws-1",
      profileId: "profile-a",
      prKey: "conn-1:repo:7",
      requester: { source: "mcp", agent: "claude", reportedConsent: "yes" },
    });
    expect(rows[0].outcome?.success).toBe(true);
  });

  test.skipIf(!GIT_AVAILABLE)("a manager without an intent-capable audit store refuses to mutate", async () => {
    const { remote, checkout, manager, workspace } = await setup();
    manager.auditLogStore = null;
    await remote.authorCommit("feature 2");
    const before = rg(checkout, ["rev-parse", "HEAD"]);

    const result = await manager.syncReviewWorkspace({ workspace });

    expect(result).toMatchObject({ status: "blocked", code: "audit-unavailable" });
    expect(rg(checkout, ["rev-parse", "HEAD"])).toBe(before);
  });

  test.skipIf(!GIT_AVAILABLE)(
    "falls back to the provider summary's source repository for a legacy workspace",
    async () => {
      const { manager, workspace } = await setup({ withSummary: true });
      const result = await manager.syncReviewWorkspace({ workspace });
      expect(result.status).toBe("already-current");
    },
  );

  test.skipIf(!GIT_AVAILABLE)("push publishes HEAD to the source repository and saves the baseline", async () => {
    const { remote, checkout, manager, workspace, saved } = await setup();
    await fs.writeFile(path.join(checkout, "mine.txt"), "mine\n");
    rg(checkout, ["add", "-A"]);
    rg(checkout, ["commit", "-q", "-m", "mine"]);
    const mine = rg(checkout, ["rev-parse", "HEAD"]);

    const result = await manager.pushReviewWorkspace({ workspace });

    expect(result.status).toBe("pushed");
    expect(remote.remoteFeature()).toBe(mine);
    expect(saved.at(-1)?.patch.sourceBaselineSha).toBe(mine);
  });

  test.skipIf(!GIT_AVAILABLE)("rebase asks first and does not touch the source baseline", async () => {
    const { manager, workspace, saved } = await setup();
    const first = await manager.rebaseReviewWorkspace({ workspace });
    // Based on main already (feature branched from main): nothing to rebase.
    expect(first.status).toBe("up-to-date");
    expect(saved).toEqual([]);
  });

  test.skipIf(!GIT_AVAILABLE)("fetch threads the connection login and token through to git", async () => {
    const { manager, workspace, calls } = await setup();

    await manager.fetchReviewWorkspace({ workspace });

    const fetchCall = calls.find((call) => call.args.includes("fetch"));
    expect(fetchCall).toBeDefined();
    const header = fetchCall!.env?.GIT_CONFIG_VALUE_0;
    expect(Buffer.from(String(header).replace("AUTHORIZATION: Basic ", ""), "base64").toString("utf8")).toBe(
      "me@example.com:super-secret-token",
    );
  });

  test("throws the provider-specific connection-not-found message", async () => {
    const manager = createManager({ execFileTextImpl: vi.fn() });
    manager.connectionNotFoundMessage = "Azure DevOps connection was not found.";
    await expect(
      manager.syncReviewWorkspace({
        workspace: { id: "ws", cwd: "/repo", review: { connectionId: "missing" } },
      }),
    ).rejects.toThrow("Azure DevOps connection was not found.");
  });

  test("a workspace never borrows the credentials of a connection owned by another profile", async () => {
    const manager = createManager({ execFileTextImpl: vi.fn(), secrets: { "tok-ref-1": "token" } });
    manager.snapshot.connections = [{ id: "conn-1", tokenRef: "tok-ref-1", profileId: "profile-b" }];
    await expect(
      manager.pushReviewWorkspace({
        workspace: { id: "ws", cwd: "/repo", profileId: "profile-a", review: { connectionId: "conn-1" } },
      }),
    ).rejects.toThrow("Cross-profile refused");
    // Same profile (or a legacy connection without one) is fine up to the next check.
    expect(() =>
      manager.buildReviewSubject({
        id: "ws",
        cwd: "/repo",
        profileId: "profile-b",
        review: { connectionId: "conn-1", pullRequest: { id: 1 } },
      }),
    ).not.toThrow();
  });

  test("throws when the PAT is missing", async () => {
    const manager = createManager({ execFileTextImpl: vi.fn() });
    manager.snapshot.connections = [{ id: "conn-1", tokenRef: "tok-ref-1" }];
    await expect(
      manager.pushReviewWorkspace({ workspace: { id: "ws", cwd: "/repo", review: { connectionId: "conn-1" } } }),
    ).rejects.toThrow("PAT is missing.");
  });

  test.skipIf(!GIT_AVAILABLE)("never logs the PAT or its Basic-auth header", async () => {
    const { remote, manager, workspace } = await setup();
    await remote.authorCommit("feature 2");
    const debugSpy = vi.spyOn(manager.log, "debug").mockImplementation(() => {});
    const infoSpy = vi.spyOn(manager.log, "info").mockImplementation(() => {});

    await manager.syncReviewWorkspace({ workspace });

    for (const call of [...debugSpy.mock.calls, ...infoSpy.mock.calls]) {
      expect(JSON.stringify(call)).not.toContain("super-secret-token");
      expect(JSON.stringify(call)).not.toContain("Basic ");
    }
  });
});

describe("BaseProviderManager review baseline initialization", () => {
  const tempPaths: string[] = [];
  afterEach(async () => {
    await Promise.all(tempPaths.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
  });

  function openWithCheckout(cwd: string, remoteUrl: string, existingReview?: Record<string, unknown>) {
    const manager = createManager({ execFileTextImpl: undefined as never, secrets: { "cred:conn-1": "pat-123" } });
    manager.parentWorkspaceKind = "provider";
    manager.providerLabel = "github";
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- MIGRATION-EXEMPT: test seeds the snapshot the real sync would fill
    manager.snapshot.connections = [{ id: "conn-1", tokenRef: "cred:conn-1", profileId: "default" }] as any;
    const summary = {
      prKey: "conn-1:repo:7",
      connectionId: "conn-1",
      role: "author",
      repository: { name: "repo", remoteUrl },
      sourceRepository: {
        id: "100",
        name: "repo",
        fullName: "acme/repo",
        remoteUrl,
        sameAsTarget: true,
        canPush: null,
      },
      pullRequest: { id: 7, sourceRefName: "refs/heads/feature", targetRefName: "refs/heads/main" },
      lastRemoteActivityAt: "2026-03-17T09:00:00.000Z",
    };
    const state = {
      tabTemplates: [],
      workspaces: [
        {
          id: "workspace-main",
          profileId: "default",
          cwd,
          panels: [],
          review: existingReview,
        },
      ],
    };
    return manager.openReviewWorkspaceCore(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- MIGRATION-EXEMPT: trimmed state fixture
      { state: state as any, prKey: "conn-1:repo:7", workspaceId: "workspace-main" },
      {
        ensurePullRequestDetail: async () => summary,
        prepareManagedReviewCheckout: vi.fn(),
        buildReviewMetadata: (s, checkout, extra) => ({
          provider: "github",
          prKey: s.prKey,
          connectionId: s.connectionId,
          role: s.role,
          repository: s.repository,
          sourceRepository: s.sourceRepository,
          pullRequest: s.pullRequest,
          checkout,
          ...(extra.previousReview?.sourceBaselineSha
            ? { sourceBaselineSha: extra.previousReview.sourceBaselineSha }
            : {}),
        }),
        formatPrLabel: () => "repo PR #7",
        findWorkspaceForPullRequest: () => null,
      },
    );
  }

  test.skipIf(!GIT_AVAILABLE)(
    '"Work here" onto an existing checkout that is AHEAD of the source still initializes the baseline',
    async () => {
      const remote = await createRemote(tempPaths);
      const checkout = path.join(remote.root, "mine");
      rg(remote.root, ["clone", "-q", remote.remote, checkout]);
      rg(checkout, ["checkout", "-q", "-b", "feature", "origin/feature"]);
      await fs.writeFile(path.join(checkout, "mine.txt"), "mine\n");
      rg(checkout, ["add", "-A"]);
      rg(checkout, ["commit", "-q", "-m", "mine"]);

      const opened = await openWithCheckout(checkout, remote.remote);

      expect(opened.attached).toBe(true);
      expect(opened.workspace.review.sourceBaselineSha).toBe(remote.remoteFeature());
    },
  );

  test.skipIf(!GIT_AVAILABLE)("a checkout that has not incorporated the live tip is left unknown", async () => {
    const remote = await createRemote(tempPaths);
    const checkout = path.join(remote.root, "mine");
    rg(remote.root, ["clone", "-q", remote.remote, checkout]);
    rg(checkout, ["checkout", "-q", "-b", "feature", "origin/feature"]);
    await remote.authorCommit("feature 2");

    const opened = await openWithCheckout(checkout, remote.remote);

    expect(opened.workspace.review.sourceBaselineSha).toBeUndefined();
  });

  test.skipIf(!GIT_AVAILABLE)("an existing baseline is preserved, not re-derived", async () => {
    const remote = await createRemote(tempPaths);
    const checkout = path.join(remote.root, "mine");
    rg(remote.root, ["clone", "-q", remote.remote, checkout]);
    rg(checkout, ["checkout", "-q", "-b", "feature", "origin/feature"]);
    const old = rg(checkout, ["rev-parse", "HEAD"]);
    await remote.authorCommit("feature 2");

    const opened = await openWithCheckout(checkout, remote.remote, {
      provider: "github",
      prKey: "conn-1:repo:7",
      connectionId: "conn-1",
      sourceRepository: {
        id: "100",
        name: "repo",
        fullName: "acme/repo",
        remoteUrl: remote.remote,
        sameAsTarget: true,
        canPush: null,
      },
      pullRequest: { sourceRefName: "refs/heads/feature" },
      sourceBaselineSha: old,
    });

    expect(opened.workspace.review.sourceBaselineSha).toBe(old);
  });
});

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

describe("BaseProviderManager.openReviewWorkspaceCore — forceReview", () => {
  const summary = {
    connectionId: "conn-1",
    role: "author",
    existingWorkspaceId: "workspace-main",
    repository: { name: "web-app" },
    pullRequest: { id: 123, sourceRefName: "refs/heads/feature/login-fix" },
    lastRemoteActivityAt: "2026-03-17T09:00:00.000Z",
  };

  const state = {
    tabTemplates: [],
    workspaces: [
      // The author's own checkout, sitting on the PR's source branch — this is
      // what the row offers as the "Attach" target.
      { id: "workspace-main", profileId: "default", cwd: "/repo", panels: [] },
      { id: "provider-root", kind: "provider", profileId: "default", cwd: reviewRoot, panels: [] },
    ],
  };

  function openWith(forceReview: boolean) {
    const manager = createManager({
      execFileTextImpl: vi.fn().mockResolvedValue({ stdout: "", stderr: "" }),
      secrets: { "cred:conn-1": "pat-123" },
    });
    manager.parentWorkspaceKind = "provider";
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- MIGRATION-EXEMPT: test seeds the snapshot the real sync would fill
    manager.snapshot.connections = [{ id: "conn-1", tokenRef: "cred:conn-1", profileId: "default" }] as any;
    const prepareManagedReviewCheckout = vi.fn().mockResolvedValue({
      mode: "managed-worktree",
      rootPath: path.join(reviewRoot, "reviews", "pr-123"),
      cacheRepoPath: path.join(reviewRoot, "cache", "web-app"),
    });
    return {
      prepareManagedReviewCheckout,
      result: manager.openReviewWorkspaceCore(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- MIGRATION-EXEMPT: trimmed state fixture
        { state: state as any, prKey: "conn-1:repo-1:123", forceReview },
        {
          ensurePullRequestDetail: async () => summary,
          prepareManagedReviewCheckout,
          buildReviewMetadata: (_summary, checkout, extra) => ({ checkout, ...extra }),
          formatPrLabel: () => "web-app PR #123",
          // No workspace is tracking this PR yet — Attach is the only thing on
          // offer, which is exactly the state the Review button exists for.
          findWorkspaceForPullRequest: () => null,
        },
      ),
    };
  }

  test("without the flag an author PR still attaches to the matching workspace", async () => {
    const { result, prepareManagedReviewCheckout } = openWith(false);
    const opened = await result;
    expect(opened.created).toBe(false);
    expect(opened.workspace.id).toBe("workspace-main");
    expect(prepareManagedReviewCheckout).not.toHaveBeenCalled();
  });

  test("forceReview builds a managed checkout instead, leaving the author's workspace alone", async () => {
    const { result, prepareManagedReviewCheckout } = openWith(true);
    const opened = await result;
    expect(opened.created).toBe(true);
    expect(opened.attached).toBe(false);
    expect(opened.workspace.id).not.toBe("workspace-main");
    expect(opened.workspace.cwd).toBe(path.join(reviewRoot, "reviews", "pr-123"));
    expect(prepareManagedReviewCheckout).toHaveBeenCalledTimes(1);
  });
});
