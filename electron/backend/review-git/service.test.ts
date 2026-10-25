/* eslint-disable @typescript-eslint/no-explicit-any -- test fixtures poke loosely-typed state and results */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { AppState, WorkspaceState } from "../../shared/types/state.js";
import { REVIEW_GIT_OPERATION_CHANNEL } from "../../shared/review-git-events.js";
import { BaseProviderManager } from "../shared/base-manager.js";
import { REVIEW_GIT_OPERATION_RETENTION_MS } from "./operations.js";
import { createReviewGitService, isReviewGitGrantLive } from "./service.js";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@e", ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

interface Fixture {
  root: string;
  remote: string;
  seed: string;
  checkout: string;
  state: AppState;
  workspace: WorkspaceState;
  manager: BaseProviderManager;
  events: Array<{ channel: string; payload: any }>;
  broadcasts: { count: number };
  service: ReturnType<typeof createReviewGitService>;
  bridge: {
    markStaleAnchors: ReturnType<typeof vi.fn>;
    syncPendingDrafts: ReturnType<typeof vi.fn>;
  };
  stores: { github: { query: ReturnType<typeof vi.fn> }; system: { query: ReturnType<typeof vi.fn> } };
}

const dirs: string[] = [];

async function createFixture(overrides: { workspaceProfile?: string } = {}): Promise<Fixture> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "strideterm-review-git-service-"));
  dirs.push(root);
  const remote = path.join(root, "remote.git");
  const seed = path.join(root, "seed");
  const checkout = path.join(root, "checkout");
  git(root, ["init", "--bare", "-q", "-b", "main", remote]);
  git(root, ["clone", "-q", remote, seed]);
  await fs.writeFile(path.join(seed, "a.txt"), "one\ntwo\nthree\n");
  git(seed, ["add", "."]);
  git(seed, ["commit", "-q", "-m", "A"]);
  git(seed, ["push", "-q", "origin", "HEAD:refs/heads/main"]);
  git(seed, ["checkout", "-q", "-b", "feature"]);
  await fs.writeFile(path.join(seed, "f.txt"), "f\n");
  git(seed, ["add", "."]);
  git(seed, ["commit", "-q", "-m", "feature 1"]);
  git(seed, ["push", "-q", "origin", "feature"]);
  git(root, ["clone", "-q", remote, checkout]);
  git(checkout, ["checkout", "-q", "-b", "pr-7-feature", "origin/feature"]);
  git(checkout, ["config", "user.name", "T"]);
  git(checkout, ["config", "user.email", "t@e"]);

  const manager = new BaseProviderManager({
    credentialStore: { getSecret: (ref: string) => (ref === "tok" ? "secret-token" : "") } as never,
    reviewStore: { upsertTrackedPullRequest: async () => {} } as never,
    auditLogStore: {
      logEntry: () => true,
      insertEntry: () => 1,
      finishEntry: () => true,
    },
    createApi: () => ({}),
  });
  manager.providerLabel = "github";
  manager.snapshot.connections = [{ id: "conn-1", tokenRef: "tok", login: "me" }];
  const sourceRepository = {
    id: "100",
    name: "repo",
    fullName: "acme/repo",
    remoteUrl: remote,
    sameAsTarget: true,
    canPush: null,
  };
  manager.setReviewWorkspaceMetadataStore({ updateReview: async () => {} });
  const workspace = {
    id: "ws-1",
    name: "repo PR #7",
    profileId: overrides.workspaceProfile || "default",
    cwd: checkout,
    panels: [{ id: "panel-1", command: "claude" }],
    review: {
      provider: "github",
      prKey: "conn-1:repo:7",
      connectionId: "conn-1",
      role: "reviewer",
      repository: { id: "100", name: "repo", remoteUrl: remote },
      sourceRepository,
      sourceBaselineSha: "",
      pullRequest: { id: 7, title: "Fix", sourceRefName: "refs/heads/feature", targetRefName: "refs/heads/main" },
      checkout: { mode: "managed-worktree", rootPath: checkout, cacheRepoPath: checkout },
    },
  } as unknown as WorkspaceState;
  const state = {
    profiles: [
      { id: "default", name: "Default" },
      { id: "other", name: "Other" },
    ],
    workspaces: [workspace],
  } as unknown as AppState;

  const events: Fixture["events"] = [];
  const broadcasts = { count: 0 };
  const bridge = {
    markStaleAnchors: vi.fn(async () => ({ checked: 0, stale: [] })),
    syncPendingDrafts: vi.fn(async () => undefined),
  };
  const stores = {
    github: { query: vi.fn(() => ({ entries: [], total: 0 })) },
    system: { query: vi.fn(() => ({ entries: [], total: 0 })) },
  };
  const service = createReviewGitService({
    getState: () => state,
    azure: manager,
    github: manager,
    reviewBridgeStore: bridge,
    refreshGit: async () => {},
    refreshAzure: async () => {},
    refreshGitHub: async () => {},
    broadcastState: () => {
      broadcasts.count += 1;
    },
    emit: (channel, payload) => events.push({ channel, payload: payload as never }),
    auditStores: { github: stores.github, system: stores.system },
    log: { info() {}, warn() {}, error() {} },
  });
  return { root, remote, seed, checkout, state, workspace, manager, events, broadcasts, service, bridge, stores };
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true, maxRetries: 5 })));
});

const ui = { profileId: "default", requester: { source: "ui" as const } };

describe("starting an operation", () => {
  test("is validated and authorized synchronously: a bad request throws instead of becoming a failed operation", async () => {
    const f = await createFixture();
    expect(() => f.service.start({ kind: "refresh", workspaceId: "missing" }, ui)).toThrow(
      "Review workspace not found",
    );
    expect(() => f.service.start({ kind: "refresh", workspaceId: "ws-1" }, { ...ui, profileId: "other" })).toThrow(
      "Cross-profile refused",
    );
    expect(() => f.service.start({ kind: "stage", workspaceId: "ws-1" }, ui)).toThrow("At least one path");
    expect(() => f.service.start({ kind: "commit", workspaceId: "ws-1", message: "  " }, ui)).toThrow(
      "commit message is required",
    );
    f.manager.snapshot.connections = [];
    expect(() => f.service.start({ kind: "refresh", workspaceId: "ws-1" }, ui)).toThrow();
    expect(f.service.operations.listForProfile("default")).toEqual([]);
  });

  test("answers at once with an operation id, runs on its own, and reports exactly one result event", async () => {
    const f = await createFixture();
    const started = f.service.start({ kind: "refresh", workspaceId: "ws-1" }, ui);
    expect(started).toEqual({ started: true, operationId: expect.any(String) });
    expect(f.service.stateFor().running.map((run) => run.operationId)).toEqual([started.operationId]);
    expect(f.events).toEqual([]);

    await f.service.operations.idle();

    const finished = f.events.filter((event) => event.channel === REVIEW_GIT_OPERATION_CHANNEL);
    expect(finished).toHaveLength(1);
    expect(finished[0].payload).toMatchObject({
      operationId: started.operationId,
      profileId: "default",
      workspaceId: "ws-1",
      kind: "refresh",
      source: "ui",
      state: "succeeded",
      result: { status: "already-current" },
    });
    expect(f.service.stateFor()).toMatchObject({ running: [], lastRuns: [{ operationId: started.operationId }] });
    expect(f.broadcasts.count).toBeGreaterThan(0);
  });

  test("the audit row of an operation carries the operation id that status, payload and event expose", async () => {
    const f = await createFixture();
    const insertEntry = vi.fn(() => 1);
    (f.manager as unknown as { auditLogStore: { insertEntry: unknown } }).auditLogStore.insertEntry = insertEntry;
    await fs.writeFile(path.join(f.checkout, "n.txt"), "n\n");
    git(f.checkout, ["add", "n.txt"]);
    const proposed = f.service.start({ kind: "commit", workspaceId: "ws-1", message: "audit me" }, ui);
    await f.service.operations.idle();
    const proposal = (
      f.service.lookup(proposed.operationId, "default", "ws-1") as never as {
        operation: { result: { proposal: { proposalId: string } } };
      }
    ).operation.result.proposal;
    const started = f.service.start(
      { kind: "commit", workspaceId: "ws-1", message: "audit me", confirmation: { proposalId: proposal.proposalId } },
      ui,
    );
    await f.service.operations.idle();
    expect(insertEntry).toHaveBeenCalledTimes(1);
    expect((insertEntry.mock.calls[0] as unknown[])[0]).toMatchObject({ operationId: started.operationId });
  });

  test("a failure becomes a failed operation with the error, in the event and in the payload", async () => {
    const f = await createFixture();
    await fs.rm(path.join(f.checkout, ".git"), { recursive: true, force: true });
    const started = f.service.start({ kind: "refresh", workspaceId: "ws-1" }, ui);
    await f.service.operations.idle();
    const event = f.events.find((entry) => entry.channel === REVIEW_GIT_OPERATION_CHANNEL)!.payload;
    expect(event).toMatchObject({ operationId: started.operationId, state: "failed" });
    expect(event.error).toBeTruthy();
    expect(event).not.toHaveProperty("result");
  });

  test("a failed operation reaches strideterm.log, and so does one that did not run", async () => {
    const f = await createFixture();
    const logged: Array<{ level: string; message: string; meta?: Record<string, unknown> }> = [];
    const service = createReviewGitService({
      getState: () => f.state,
      azure: f.manager,
      github: f.manager,
      reviewBridgeStore: f.bridge,
      refreshGit: async () => {},
      refreshAzure: async () => {},
      refreshGitHub: async () => {},
      broadcastState: () => {},
      emit: () => {},
      auditStores: {},
      log: {
        info() {},
        warn: (message, meta) => logged.push({ level: "warn", message, meta }),
        error: (message, meta) => logged.push({ level: "error", message, meta }),
      },
    });
    await fs.writeFile(path.join(f.checkout, "dirty.txt"), "x");
    git(f.seed, ["checkout", "-q", "feature"]);
    await fs.writeFile(path.join(f.seed, "g.txt"), "g");
    git(f.seed, ["add", "."]);
    git(f.seed, ["commit", "-q", "-m", "feature 2"]);
    git(f.seed, ["push", "-q", "origin", "feature"]);
    service.start({ kind: "refresh", workspaceId: "ws-1" }, ui);
    await service.operations.idle();
    expect(logged).toContainEqual(
      expect.objectContaining({
        level: "warn",
        message: "review git operation did not run",
        meta: expect.objectContaining({ status: "blocked", kind: "refresh", source: "ui" }),
      }),
    );

    await fs.rm(path.join(f.checkout, ".git"), { recursive: true, force: true });
    service.start({ kind: "fetch", workspaceId: "ws-1" }, ui);
    await service.operations.idle();
    expect(logged.some((entry) => entry.level === "error" && entry.message === "review git operation failed")).toBe(
      true,
    );
  });

  test("a click repeated while the same operation is running joins it", async () => {
    const f = await createFixture();
    const first = f.service.start({ kind: "refresh", workspaceId: "ws-1" }, ui);
    const second = f.service.start({ kind: "refresh", workspaceId: "ws-1" }, ui);
    expect(second.operationId).toBe(first.operationId);
    await f.service.operations.idle();
  });

  test("an idempotency key makes a retried start return the same operation", async () => {
    const f = await createFixture();
    const caller = { profileId: "default", requester: { source: "mcp" as const, agent: "claude" } };
    const first = f.service.start({ kind: "fetch", workspaceId: "ws-1", idempotencyKey: "key-12345678" }, caller);
    await f.service.operations.idle();
    const retry = f.service.start({ kind: "fetch", workspaceId: "ws-1", idempotencyKey: "key-12345678" }, caller);
    expect(retry.operationId).toBe(first.operationId);
    expect(f.service.operations.listForProfile("default")).toHaveLength(1);
  });

  test("the payload offers a finished operation for 24 hours only", async () => {
    let now = Date.now();
    const f = await createFixture();
    const service = createReviewGitService({
      getState: () => f.state,
      azure: f.manager,
      github: f.manager,
      reviewBridgeStore: f.bridge,
      refreshGit: async () => {},
      refreshAzure: async () => {},
      refreshGitHub: async () => {},
      broadcastState: () => {},
      emit: () => {},
      auditStores: {},
      log: { info() {}, warn() {}, error() {} },
      now: () => now,
    });
    service.start({ kind: "fetch", workspaceId: "ws-1" }, ui);
    await service.operations.idle();
    expect(service.stateFor().lastRuns).toHaveLength(1);
    now += REVIEW_GIT_OPERATION_RETENTION_MS + 1_000;
    expect(service.stateFor().lastRuns).toEqual([]);
  });

  test("lookup answers running, the result, or an explicit unavailable/expired — never a guess", async () => {
    const f = await createFixture();
    const started = f.service.start({ kind: "fetch", workspaceId: "ws-1" }, ui);
    await f.service.operations.idle();
    expect(f.service.lookup(started.operationId, "default", "ws-1")).toMatchObject({ status: "succeeded" });
    expect(f.service.lookup(started.operationId, "other", "ws-1")).toMatchObject({
      status: "unavailable",
      reason: "unknown",
    });
    expect(f.service.lookup("nope", "default")).toMatchObject({ status: "unavailable", reason: "unknown" });
  });
});

describe("read tools", () => {
  test("identity names the PR, the verified source repository, the local branches and the baseline", async () => {
    const f = await createFixture();
    const identity = (await f.service.read({ operation: "identity" }, "ws-1", "default")) as Record<string, any>;
    expect(identity).toMatchObject({
      workspaceId: "ws-1",
      provider: "github",
      prKey: "conn-1:repo:7",
      pullRequestId: 7,
      sourceRef: "refs/heads/feature",
      targetRef: "refs/heads/main",
      sourceBaselineSha: null,
      expectedLocalBranches: ["pr-7-feature", "feature"],
      sourceRepository: { fullName: "acme/repo", sameAsTarget: true },
    });
    expect(identity.sourceIdentity).toContain("github|conn-1|conn-1:repo:7|refs/heads/feature|id:100");
    expect(JSON.stringify(identity)).not.toContain("secret-token");
  });

  test("status reports HEAD, branch binding, changes and any paused operation", async () => {
    const f = await createFixture();
    await fs.writeFile(path.join(f.checkout, "new.txt"), "x");
    const status = (await f.service.read({ operation: "status" }, "ws-1", "default")) as Record<string, any>;
    expect(status).toMatchObject({
      branch: "pr-7-feature",
      onPullRequestBranch: true,
      untracked: 1,
      operationInProgress: null,
      conflictedPaths: [],
    });
    expect(status.headSha).toBe(git(f.checkout, ["rev-parse", "HEAD"]));

    git(f.checkout, ["checkout", "-q", "-b", "develop", "origin/main"]);
    const moved = (await f.service.read({ operation: "status" }, "ws-1", "default")) as Record<string, unknown>;
    expect(moved.onPullRequestBranch).toBe(false);
  });

  test("status counts the isolated one-shot review branch as the pull request's branch", async () => {
    const f = await createFixture();
    const isolated = `pr-7-feature-review-${randomUUID()}`;
    git(f.checkout, ["branch", "-m", isolated]);
    const status = (await f.service.read({ operation: "status" }, "ws-1", "default")) as Record<string, unknown>;
    expect(status).toMatchObject({ branch: isolated, onPullRequestBranch: true });
  });

  test("refs distinguishes the cached tracking refs from the live remote tips", async () => {
    const f = await createFixture();
    git(f.seed, ["checkout", "-q", "feature"]);
    await fs.writeFile(path.join(f.seed, "g.txt"), "g");
    git(f.seed, ["add", "."]);
    git(f.seed, ["commit", "-q", "-m", "feature 2"]);
    git(f.seed, ["push", "-q", "origin", "feature"]);
    const tip = git(f.seed, ["rev-parse", "HEAD"]);

    const cached = (await f.service.read({ operation: "refs" }, "ws-1", "default")) as Record<string, any>;
    expect(cached.trackingSourceSha).not.toBe(tip);
    expect(cached).not.toHaveProperty("live");

    const live = (await f.service.read({ operation: "refs", query: true }, "ws-1", "default")) as Record<string, any>;
    expect(live.live.source).toBe(tip);
  });

  test("diff, history and checks are bounded, repository-relative and read-only", async () => {
    const f = await createFixture();
    await fs.writeFile(path.join(f.checkout, "a.txt"), "one\nTWO\nthree\n");
    const diff = (await f.service.read(
      { operation: "diff", scope: "worktree", path: "a.txt" },
      "ws-1",
      "default",
    )) as Record<string, any>;
    expect(diff.diff).toContain("+TWO");
    await expect(
      f.service.read({ operation: "diff", scope: "worktree", path: "../outside" }, "ws-1", "default"),
    ).rejects.toThrow("not a repository-relative path");
    await expect(
      f.service.read({ operation: "diff", scope: "worktree", path: "/etc/passwd" }, "ws-1", "default"),
    ).rejects.toThrow("not a repository-relative path");

    const history = (await f.service.read(
      { operation: "history", range: "head-vs-target" },
      "ws-1",
      "default",
    )) as Record<string, any>;
    expect(history.commits.map((commit: { subject: string }) => commit.subject)).toEqual(["feature 1"]);

    (f.manager.snapshot.pullRequests as Record<string, unknown>)["conn-1:repo:7"] = { checks: { failedCount: 1 } };
    const checks = (await f.service.read({ operation: "checks" }, "ws-1", "default")) as Record<string, unknown>;
    expect(checks.checks).toEqual({ failedCount: 1 });
  });

  test("checks come from the synced detail even when the inbox summary (which has none) is found first", async () => {
    const f = await createFixture();
    (f.manager.snapshot.pullRequests as Record<string, unknown>)["conn-1:repo:7"] = { checks: { failedCount: 2 } };
    f.manager.findSummary = (() => ({ title: "inbox row without checks" })) as never;
    const checks = (await f.service.read({ operation: "checks" }, "ws-1", "default")) as Record<string, unknown>;
    expect(checks.checks).toEqual({ failedCount: 2 });
  });

  test("head-vs-source compares with the live source commit, and says so when that commit is not fetched yet", async () => {
    const f = await createFixture();
    await fs.writeFile(path.join(f.checkout, "mine.txt"), "mine");
    git(f.checkout, ["add", "."]);
    git(f.checkout, ["commit", "-q", "-m", "mine"]);

    const diff = (await f.service.read({ operation: "diff", scope: "head-vs-source" }, "ws-1", "default")) as Record<
      string,
      any
    >;
    expect(diff.diff).toContain("+mine");
    const history = (await f.service.read(
      { operation: "history", range: "head-vs-source" },
      "ws-1",
      "default",
    )) as Record<string, any>;
    expect(history.commits.map((commit: { subject: string }) => commit.subject)).toEqual(["mine"]);

    // The server moves on; the checkout's tracking ref is now stale and must not be trusted.
    git(f.seed, ["checkout", "-q", "feature"]);
    await fs.writeFile(path.join(f.seed, "later.txt"), "later");
    git(f.seed, ["add", "."]);
    git(f.seed, ["commit", "-q", "-m", "later"]);
    git(f.seed, ["push", "-q", "origin", "feature"]);
    await expect(f.service.read({ operation: "diff", scope: "head-vs-source" }, "ws-1", "default")).rejects.toThrow(
      "not in this checkout yet",
    );
  });

  test("head-vs-target compares with the live target commit, not a stale tracking ref", async () => {
    const f = await createFixture();
    git(f.seed, ["checkout", "-q", "main"]);
    await fs.writeFile(path.join(f.seed, "target-later.txt"), "later");
    git(f.seed, ["add", "."]);
    git(f.seed, ["commit", "-q", "-m", "target later"]);
    git(f.seed, ["push", "-q", "origin", "main"]);
    await expect(f.service.read({ operation: "diff", scope: "head-vs-target" }, "ws-1", "default")).rejects.toThrow(
      "live target commit",
    );
    await expect(f.service.read({ operation: "refs", query: true }, "ws-1", "default")).resolves.toMatchObject({
      targetRef: "refs/heads/main",
    });
  });

  test("conflicts lists the conflicted files with their content", async () => {
    const f = await createFixture();
    git(f.seed, ["checkout", "-q", "main"]);
    await fs.writeFile(path.join(f.seed, "c.txt"), "main\n");
    git(f.seed, ["add", "."]);
    git(f.seed, ["commit", "-q", "-m", "main c"]);
    git(f.seed, ["push", "-q", "origin", "main"]);
    await fs.writeFile(path.join(f.checkout, "c.txt"), "mine\n");
    git(f.checkout, ["add", "."]);
    git(f.checkout, ["commit", "-q", "-m", "mine c"]);
    git(f.checkout, ["fetch", "-q", "origin"]);
    try {
      git(f.checkout, ["rebase", "origin/main"]);
    } catch {
      // expected: conflict
    }
    const conflicts = (await f.service.read({ operation: "conflicts" }, "ws-1", "default")) as Record<string, any>;
    expect(conflicts.operationInProgress).toBe("rebase");
    expect(conflicts.conflictedPaths).toEqual(["c.txt"]);
    expect(conflicts.files[0].content).toContain("<<<<<<<");
    // Reading is allowed while the operation is paused; mutations are not.
    const status = (await f.service.read({ operation: "status" }, "ws-1", "default")) as Record<string, unknown>;
    expect(status.operationInProgress).toBe("rebase");
  });

  test("the audit log is queried per workspace — provider rows for this workspace and its system-credential rows only", async () => {
    const f = await createFixture();
    f.stores.github.query.mockReturnValue({
      total: 1,
      entries: [
        {
          timestamp: "2026-10-17T10:00:00.000Z",
          operation: "gitPush",
          category: "write",
          success: true,
          operationId: "op-1",
          details: JSON.stringify({ requester: { agent: "claude", reportedConsent: "yes" } }),
          url: "https://secret.example/?token=abc",
        },
      ],
    });
    const result = (await f.service.read(
      { operation: "audit-log", limit: 5, category: "write" },
      "ws-1",
      "default",
    )) as Record<string, any>;

    expect(f.stores.github.query).toHaveBeenCalledWith(
      expect.objectContaining({ connectionId: "conn-1", resourceType: "git", resourceId: "ws-1", category: "write" }),
    );
    expect(f.stores.system.query).toHaveBeenCalledWith(expect.objectContaining({ connectionId: "system-ws-1" }));
    expect(result.entries[0]).toMatchObject({ operation: "gitPush", operationId: "op-1" });
    expect(result.entries[0].details.requester.agent).toBe("claude");
    expect(JSON.stringify(result)).not.toContain("secret.example");
  });

  test("every read refuses a workspace outside the capability's profile", async () => {
    const f = await createFixture();
    await expect(f.service.read({ operation: "status" }, "ws-1", "other")).rejects.toThrow("Cross-profile refused");
    await expect(f.service.read({ operation: "status" }, "missing", "default")).rejects.toThrow(
      "Review workspace not found",
    );
  });
});

describe("push and publish", () => {
  async function withFakePush(
    pushResult: unknown,
    publish: (run: (entry: Record<string, unknown>) => Promise<unknown>) => Promise<void>,
  ) {
    const f = await createFixture();
    const fakeManager = {
      buildReviewSubject: f.manager.buildReviewSubject.bind(f.manager),
      pushReviewWorkspace: vi.fn(async () => pushResult),
      addPullRequestComment: vi.fn(async () => undefined),
      getReviewGitEngine: () => f.manager.getReviewGitEngine(),
      runGit: f.manager.runGit.bind(f.manager),
    };
    f.bridge.syncPendingDrafts.mockImplementation(async (_prKey: string, run: never) => publish(run));
    const service = createReviewGitService({
      getState: () => f.state,
      azure: fakeManager,
      github: fakeManager,
      reviewBridgeStore: f.bridge,
      refreshGit: async () => {},
      refreshAzure: async () => {},
      refreshGitHub: async () => {},
      broadcastState: () => {},
      emit: () => {},
      auditStores: {},
      log: { info() {}, warn() {}, error() {} },
    });
    return { f, fakeManager, service };
  }

  async function runPushAndPublish(service: ReturnType<typeof createReviewGitService>) {
    const started = service.start({ kind: "push-and-publish", workspaceId: "ws-1" }, ui);
    await service.operations.idle();
    const looked = service.lookup(started.operationId, "default", "ws-1");
    return (looked as { operation: { result: any } }).operation.result;
  }

  test("reports the push and each comment on its own: a failing comment never undoes the push", async () => {
    const { service, fakeManager } = await withFakePush({ status: "pushed", message: "Pushed." }, async (run) => {
      await run({ commentKey: "c1", body: "one", remoteThreadId: null, comment: { filePath: "a.txt", lineNumber: 1 } });
      await run({ commentKey: "c2", body: "two", remoteThreadId: null, comment: {} }).catch(() => {});
    });
    fakeManager.addPullRequestComment
      .mockImplementationOnce(async () => undefined)
      .mockRejectedValueOnce(new Error("403 Forbidden"));

    const result = await runPushAndPublish(service);

    expect(result.push).toMatchObject({ status: "pushed" });
    expect(result.publish).toMatchObject({
      attempted: true,
      published: ["c1"],
      failed: [{ commentKey: "c2", error: "403 Forbidden" }],
    });
    expect(fakeManager.pushReviewWorkspace).toHaveBeenCalledTimes(1);
  });

  test("a comment whose inline anchor went stale is refused, not posted at a guessed line", async () => {
    const { service, fakeManager } = await withFakePush({ status: "up-to-date", message: "same" }, async (run) => {
      await run({
        commentKey: "stale",
        body: "text",
        remoteThreadId: null,
        comment: { filePath: "gone.txt", lineNumber: 4, anchorStale: true },
      }).catch(() => {});
    });
    const result = await runPushAndPublish(service);
    expect(fakeManager.addPullRequestComment).not.toHaveBeenCalled();
    expect(result.publish.failed[0].error).toContain("stale");
    expect(result.publish.published).toEqual([]);
  });

  test("a push that is blocked or needs consent publishes nothing", async () => {
    for (const push of [
      { status: "blocked", code: "branch-mismatch", message: "wrong branch" },
      { status: "confirm-required", proposal: { proposalId: "p" } },
    ]) {
      const { service, f } = await withFakePush(push, async () => {});
      const result = await runPushAndPublish(service);
      expect(result.publish).toMatchObject({ attempted: false, published: [], failed: [] });
      expect(f.bridge.syncPendingDrafts).not.toHaveBeenCalled();
    }
  });

  test("a successful push does not re-validate (or heal) inline anchors", async () => {
    const { service, f } = await withFakePush({ status: "pushed", message: "ok" }, async () => {});
    await runPushAndPublish(service);
    expect(f.bridge.markStaleAnchors).not.toHaveBeenCalled();
  });

  describe("anchors after a local rebase", () => {
    async function rebaseWith(
      lineSide: string,
      change: (f: Awaited<ReturnType<typeof createFixture>>) => Promise<void>,
      via: "rebase" | "refresh" | "skip" | "continue" = "rebase",
    ): Promise<
      (anchor: { commentKey: string; filePath: string; lineNumber: number; lineSide?: string }) => Promise<boolean>
    > {
      const f = await createFixture();
      const previousHeadSha = git(f.checkout, ["rev-parse", "HEAD"]).trim();
      const stepping = via === "skip" || via === "continue";
      if (!stepping) await change(f);
      const engineResult = vi.fn(async () => {
        await change(f);
        return { status: via === "skip" ? "skipped" : "continued", message: "ok" };
      });
      const fakeManager = {
        buildReviewSubject: f.manager.buildReviewSubject.bind(f.manager),
        rebaseReviewWorkspace: vi.fn(async () => ({ status: "rebased", message: "ok", previousHeadSha })),
        syncReviewWorkspace: vi.fn(async () => ({ status: "reset", message: "ok", previousHeadSha })),
        getReviewGitEngine: () => ({ skipOperation: engineResult, continueOperation: engineResult }),
        runGit: f.manager.runGit.bind(f.manager),
      };
      const service = createReviewGitService({
        getState: () => f.state,
        azure: fakeManager,
        github: fakeManager,
        reviewBridgeStore: f.bridge,
        refreshGit: async () => {},
        refreshAzure: async () => {},
        refreshGitHub: async () => {},
        broadcastState: () => {},
        emit: () => {},
        auditStores: {},
        log: { info() {}, warn() {}, error() {} },
      });
      service.start({ kind: via, workspaceId: "ws-1" }, ui);
      await service.operations.idle();
      expect(lineSide).toBeTruthy();
      return f.bridge.markStaleAnchors.mock.calls[0][1] as never;
    }
    const insertAtTop = async (f: Awaited<ReturnType<typeof createFixture>>) => {
      const current = await fs.readFile(path.join(f.checkout, "a.txt"), "utf8");
      await fs.writeFile(path.join(f.checkout, "a.txt"), `inserted\n${current}`);
      git(f.checkout, ["commit", "-q", "-am", "insert above"]);
    };

    test("a new-side anchor whose line now holds different code is stale, even though the line still exists", async () => {
      const validator = await rebaseWith("new", insertAtTop);
      expect(await validator({ commentKey: "k", filePath: "a.txt", lineNumber: 2, lineSide: "new" })).toBe(false);
    });

    test.each(["refresh", "skip", "continue"] as const)(
      "a new-side anchor is judged against the old code after %s too",
      async (via) => {
        const validator = await rebaseWith("new", insertAtTop, via);
        expect(await validator({ commentKey: "k", filePath: "a.txt", lineNumber: 2, lineSide: "new" })).toBe(false);
      },
    );

    test("an anchor on code that did not move stays valid", async () => {
      const validator = await rebaseWith("new", async (f) => {
        await fs.appendFile(path.join(f.checkout, "a.txt"), "four\n");
        git(f.checkout, ["commit", "-q", "-am", "append"]);
      });
      expect(await validator({ commentKey: "k", filePath: "a.txt", lineNumber: 2, lineSide: "new" })).toBe(true);
    });

    test("a continued step never reads a stale ORIG_HEAD left by an earlier reset", async () => {
      const f = await createFixture();
      const earlier = git(f.checkout, ["rev-parse", "HEAD"]).trim();
      await insertAtTop(f);
      git(f.checkout, ["update-ref", "ORIG_HEAD", earlier]);
      await fs.appendFile(path.join(f.checkout, "a.txt"), "tail\n");
      const engineResult = vi.fn(async () => {
        git(f.checkout, ["commit", "-q", "-am", "cherry-picked"]);
        return { status: "continued", message: "ok" };
      });
      const fakeManager = {
        buildReviewSubject: f.manager.buildReviewSubject.bind(f.manager),
        getReviewGitEngine: () => ({ continueOperation: engineResult }),
        runGit: f.manager.runGit.bind(f.manager),
      };
      const service = createReviewGitService({
        getState: () => f.state,
        azure: fakeManager,
        github: fakeManager,
        reviewBridgeStore: f.bridge,
        refreshGit: async () => {},
        refreshAzure: async () => {},
        refreshGitHub: async () => {},
        broadcastState: () => {},
        emit: () => {},
        auditStores: {},
        log: { info() {}, warn() {}, error() {} },
      } as never);
      service.start({ kind: "continue", workspaceId: "ws-1" }, ui);
      await service.operations.idle();
      const validator = f.bridge.markStaleAnchors.mock.calls[0][1] as (a: unknown) => Promise<boolean>;
      expect(await validator({ commentKey: "k", filePath: "a.txt", lineNumber: 2, lineSide: "new" })).toBe(true);
    });

    test("an old-side anchor is judged by the file at HEAD only", async () => {
      const validator = await rebaseWith("old", insertAtTop);
      expect(await validator({ commentKey: "k", filePath: "a.txt", lineNumber: 2, lineSide: "old" })).toBe(true);
    });
  });
});

describe("anchors after a REAL paused rebase (real engine)", () => {
  type Validator = (anchor: {
    commentKey: string;
    filePath: string;
    lineNumber: number;
    lineSide: string;
  }) => Promise<boolean>;

  async function pausedRebase(): Promise<Awaited<ReturnType<typeof createFixture>>> {
    const f = await createFixture();
    git(f.seed, ["checkout", "-q", "main"]);
    await fs.writeFile(path.join(f.seed, "a.txt"), "zero\none\ntwo\nthree\n");
    await fs.writeFile(path.join(f.seed, "c.txt"), "main\n");
    git(f.seed, ["add", "."]);
    git(f.seed, ["commit", "-q", "-m", "main"]);
    git(f.seed, ["push", "-q", "origin", "main"]);
    await fs.writeFile(path.join(f.checkout, "c.txt"), "mine\n");
    git(f.checkout, ["add", "."]);
    git(f.checkout, ["commit", "-q", "-m", "mine c"]);
    git(f.checkout, ["fetch", "-q", "origin"]);
    try {
      git(f.checkout, ["-c", "core.editor=true", "rebase", "origin/main"]);
    } catch {
      // the conflict on c.txt is what pauses the rebase
    }
    return f;
  }

  async function confirmed(
    f: Awaited<ReturnType<typeof createFixture>>,
    kind: "continue" | "skip",
  ): Promise<Validator> {
    const first = f.service.start({ kind, workspaceId: "ws-1" }, ui);
    await f.service.operations.idle();
    const proposal = (f.service.lookup(first.operationId, "default", "ws-1") as any).operation.result.proposal;
    expect(proposal?.proposalId).toBeTruthy();
    f.service.start({ kind, workspaceId: "ws-1", confirmation: { proposalId: proposal.proposalId } }, ui);
    await f.service.operations.idle();
    expect(f.bridge.markStaleAnchors).toHaveBeenCalledTimes(1);
    return f.bridge.markStaleAnchors.mock.calls[0][1] as Validator;
  }

  test("continue judges new-side anchors against the pre-rebase HEAD", async () => {
    const f = await pausedRebase();
    await fs.writeFile(path.join(f.checkout, "c.txt"), "resolved\n");
    git(f.checkout, ["add", "c.txt"]);
    const validator = await confirmed(f, "continue");
    expect(await validator({ commentKey: "k", filePath: "a.txt", lineNumber: 2, lineSide: "new" })).toBe(false);
    expect(await validator({ commentKey: "k", filePath: "f.txt", lineNumber: 1, lineSide: "new" })).toBe(true);
  });

  test("skip judges new-side anchors against the pre-rebase HEAD", async () => {
    const f = await pausedRebase();
    const validator = await confirmed(f, "skip");
    expect(await validator({ commentKey: "k", filePath: "a.txt", lineNumber: 2, lineSide: "new" })).toBe(false);
    expect(await validator({ commentKey: "k", filePath: "f.txt", lineNumber: 1, lineSide: "new" })).toBe(true);
  });
});

describe("capability liveness", () => {
  const grant = {
    sessionId: "ws-1:panel-1",
    profileId: "default",
    workspaceId: "ws-1",
    panelId: "panel-1",
    prKey: "conn-1:repo:7",
    identityKey: "identity-1",
    agent: "claude",
    command: "claude",
  };
  const session = { status: "running", workspaceId: "ws-1", panelId: "panel-1" };
  let state: AppState;
  const check = (overrides: Partial<Parameters<typeof isReviewGitGrantLive>[0]> = {}) =>
    isReviewGitGrantLive({
      state,
      grant,
      session,
      agentFor: () => "claude",
      identityKeyFor: () => "identity-1",
      ...overrides,
    });

  beforeEach(() => {
    state = {
      profiles: [{ id: "default" }],
      workspaces: [
        {
          id: "ws-1",
          profileId: "default",
          panels: [{ id: "panel-1", command: "claude" }],
          review: { prKey: "conn-1:repo:7" },
        },
      ],
    } as unknown as AppState;
  });

  test("is live while the tab, workspace, PR, profile and source identity are all unchanged", () => {
    expect(check()).toBe(true);
  });

  test.each([
    ["the tab was detached from the PR", (s: AppState) => ((s.workspaces[0] as any).review = null)],
    [
      "the workspace now belongs to another PR",
      (s: AppState) => ((s.workspaces[0] as any).review.prKey = "other:pr:1"),
    ],
    ["the workspace moved to another profile", (s: AppState) => ((s.workspaces[0] as any).profileId = "other")],
    ["the profile was deleted", (s: AppState) => ((s.profiles as any[]).length = 0)],
    ["the panel was closed", (s: AppState) => ((s.workspaces[0] as any).panels = [])],
    ["the panel now runs another command", (s: AppState) => ((s.workspaces[0] as any).panels[0].command = "bash")],
    ["the workspace was deleted", (s: AppState) => ((s.workspaces as any[]).length = 0)],
  ])("ends when %s", (_label, mutate) => {
    mutate(state);
    expect(check()).toBe(false);
  });

  test("ends when the PR's source identity changed, or the tab's agent session is no longer running", () => {
    expect(check({ identityKeyFor: () => "identity-2" })).toBe(false);
    expect(check({ session: undefined })).toBe(false);
    expect(check({ session: { ...session, status: "exited" } })).toBe(false);
    expect(check({ session: { ...session, panelId: "panel-2" } })).toBe(false);
    expect(check({ agentFor: () => "codex" })).toBe(false);
  });
  describe("a legacy workspace whose source repository is captured lazily", () => {
    const review = (sourceRepository: unknown, ref = "refs/heads/feature/x") =>
      ({
        provider: "azure",
        connectionId: "conn-1",
        prKey: "conn-1:repo:7",
        pullRequest: { sourceRefName: ref },
        sourceRepository,
      }) as never;
    const service = createReviewGitService({} as never);
    const keyOf = (workspace: unknown) => service.identityKeyFor(workspace as never);
    const mintedFor = (value: unknown) => keyOf({ id: "ws-1", review: value });

    test("keeps its grant when the first operation fills in the source repository", () => {
      const minted = mintedFor(review(null));
      state.workspaces[0]!.review = review({ id: "repo-1" }) as never;
      expect(check({ grant: { ...grant, identityKey: minted }, identityKeyFor: keyOf as never })).toBe(true);
    });

    test("still ends when the PR's source ref changes after the lazy capture", () => {
      const minted = mintedFor(review(null));
      state.workspaces[0]!.review = review({ id: "repo-1" }, "refs/heads/other") as never;
      expect(check({ grant: { ...grant, identityKey: minted }, identityKeyFor: keyOf as never })).toBe(false);
    });

    test("a grant minted with the full identity does not accept another source repository", () => {
      const minted = mintedFor(review({ id: "repo-1" }));
      state.workspaces[0]!.review = review({ id: "repo-2" }) as never;
      expect(check({ grant: { ...grant, identityKey: minted }, identityKeyFor: keyOf as never })).toBe(false);
    });
  });
});
