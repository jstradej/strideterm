/* eslint-disable @typescript-eslint/no-explicit-any -- test fixtures poke loosely-typed state and results */
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { AppState, WorkspaceState } from "../../shared/types/state.js";
import { BaseProviderManager } from "../shared/base-manager.js";
import { createOperationRegistry } from "../operation-registry.js";
import { createReviewMetadataStore } from "../review-metadata-store.js";
import { createReviewPrActionService } from "./pr-actions.js";
import { createReviewGitService, isReviewGitGrantLive } from "./service.js";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@e", ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

const WS = "ws-qf";
const BRANCH = "fix/login";
const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true, maxRetries: 5 })));
});

/** A quickfix checkout on a new local branch the bare "remote" does not have yet. */
async function createFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "strideterm-pre-pr-"));
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
  git(root, ["clone", "-q", remote, checkout]);
  git(checkout, ["checkout", "-q", "-b", BRANCH, "origin/main"]);
  git(checkout, ["config", "user.name", "T"]);
  git(checkout, ["config", "user.email", "t@e"]);

  const insertEntry = vi.fn(() => 1);
  const manager = new BaseProviderManager({
    credentialStore: { getSecret: (ref: string) => (ref === "tok" ? "secret-token" : "") } as never,
    reviewStore: { upsertTrackedPullRequest: async () => {} } as never,
    auditLogStore: { logEntry: () => true, insertEntry, finishEntry: () => true },
    createApi: () => ({}),
  });
  manager.providerLabel = "github";
  manager.snapshot.connections = [
    { id: "conn-1", tokenRef: "tok", login: "me", hostUrl: "https://git.example.invalid" },
  ];

  const workspace = {
    id: WS,
    name: BRANCH,
    profileId: "default",
    cwd: checkout,
    panels: [{ id: "panel-1", command: "claude" }],
    review: {
      provider: "github",
      prKey: "",
      connectionId: "conn-1",
      role: "author",
      repository: { id: "", name: "repo", remoteUrl: remote },
      pullRequest: null,
      checkout: { mode: "managed-worktree", rootPath: checkout, cacheRepoPath: checkout },
    },
    quickfix: {
      connectionId: "conn-1",
      projectName: "",
      repositoryId: "",
      repositoryName: "repo",
      remoteUrl: remote,
      baseBranch: "main",
      parentWorkspaceId: "",
      branchName: BRANCH,
    },
  } as unknown as WorkspaceState;
  const state = {
    profiles: [
      { id: "default", name: "Default" },
      { id: "other", name: "Other" },
    ],
    workspaces: [workspace],
  } as unknown as AppState;
  // Like the real store: the mutation applies to a copy that is published only when it did not throw.
  const store = {
    async mutate(mutator: (draft: AppState) => void | Promise<void>) {
      const draft = structuredClone(state);
      await mutator(draft);
      state.workspaces = draft.workspaces;
    },
  };
  manager.setReviewWorkspaceMetadataStore(createReviewMetadataStore(store));
  const current = () => state.workspaces[0] as any;

  const service = createReviewGitService({
    getState: () => state,
    azure: manager,
    github: manager,
    reviewBridgeStore: { markStaleAnchors: vi.fn(), syncPendingDrafts: vi.fn() },
    refreshGit: async () => {},
    refreshAzure: async () => {},
    refreshGitHub: async () => {},
    broadcastState: () => {},
    emit: () => {},
    auditStores: { github: { query: vi.fn(() => ({ entries: [], total: 0 })) } },
    log: { info() {}, warn() {}, error() {} },
  });
  return { root, remote, seed, checkout, state, manager, service, insertEntry, current };
}

type Fixture = Awaited<ReturnType<typeof createFixture>>;

const mcp = {
  profileId: "default",
  requester: { source: "mcp" as const, agent: "claude", panelId: "panel-1" },
};
const ui = { profileId: "default", requester: { source: "ui" as const } };

async function run(f: Fixture, input: Record<string, unknown>, caller = mcp): Promise<any> {
  const started = f.service.start({ workspaceId: WS, ...input } as never, caller);
  await f.service.operations.idle();
  const looked = f.service.lookup(started.operationId, "default", WS) as any;
  if (looked.status === "failed") throw new Error(looked.operation.error);
  return looked.operation.result;
}

/** The first call only describes; the continuation names that proposal. */
async function proceed(f: Fixture, input: Record<string, unknown>, caller = mcp): Promise<any> {
  const proposed = await run(f, input, caller);
  expect(proposed.status).toBe("confirm-required");
  return run(f, { ...input, confirmation: { proposalId: proposed.proposal.proposalId } }, caller);
}

async function commitFile(dir: string, name: string, content: string, message: string) {
  await fs.writeFile(path.join(dir, name), content);
  git(dir, ["add", name]);
  git(dir, ["commit", "-q", "-m", message]);
}

const remoteSha = (f: Fixture, branch: string) =>
  git(f.checkout, ["ls-remote", f.remote, `refs/heads/${branch}`]).split(/\s+/u)[0] || "";

describe("a quickfix branch without a pull request: reads", () => {
  test("identity names the recorded branch, the base branch and the pre-PR identity — never a PR", async () => {
    const f = await createFixture();
    const identity = (await f.service.read({ operation: "identity" }, WS, "default")) as any;
    expect(identity).toMatchObject({
      kind: "quickfix-branch",
      prKey: null,
      pullRequestId: null,
      sourceRef: `refs/heads/${BRANCH}`,
      targetRef: "refs/heads/main",
      expectedLocalBranches: [BRANCH],
      sourceBaselineSha: null,
      sourceRepository: { sameAsTarget: true },
    });
    expect(identity.sourceIdentity).toMatch(/^prepr\|github\|conn-1\|refs\/heads\/fix\/login\|/u);
  });

  test("status follows the recorded branch, not whatever is checked out", async () => {
    const f = await createFixture();
    expect(((await f.service.read({ operation: "status" }, WS, "default")) as any).onPullRequestBranch).toBe(true);
    git(f.checkout, ["checkout", "-q", "-b", "other"]);
    expect(((await f.service.read({ operation: "status" }, WS, "default")) as any).onPullRequestBranch).toBe(false);
  });

  test("refs query reports a branch that is not on the remote yet, and the live base tip", async () => {
    const f = await createFixture();
    const refs = (await f.service.read({ operation: "refs", query: true }, WS, "default")) as any;
    expect(refs.live.source).toBeNull();
    expect(refs.live.target).toBe(remoteSha(f, "main"));
    expect(refs.sourceBaselineSha).toBeNull();
  });

  test("checks say there is no pull request, and diff against the unpublished branch says to push", async () => {
    const f = await createFixture();
    expect(((await f.service.read({ operation: "checks" }, WS, "default")) as any).note).toContain(
      "no pull request yet",
    );
    await expect(f.service.read({ operation: "diff", scope: "head-vs-source" }, WS, "default")).rejects.toThrow(
      "not on its remote yet",
    );
  });

  test("a quickfix that predates the recorded branch has no subject: a clear reason, never a guess", async () => {
    const f = await createFixture();
    f.current().quickfix.branchName = "";
    expect(() => f.service.start({ kind: "refresh", workspaceId: WS }, ui)).toThrow("no recorded branch");
    await expect(f.service.read({ operation: "identity" }, WS, "default")).rejects.toThrow("no recorded branch");
  });

  test("the audit log read is scoped to this workspace", async () => {
    const f = await createFixture();
    const result = (await f.service.read({ operation: "audit-log" }, WS, "default")) as any;
    expect(result.total).toBe(0);
  });
});

describe("a quickfix branch without a pull request: grant liveness", () => {
  const session = { status: "running", workspaceId: WS, panelId: "panel-1" };
  function grantFor(f: Fixture) {
    return {
      sessionId: "s1",
      profileId: "default",
      workspaceId: WS,
      panelId: "panel-1",
      prKey: "",
      identityKey: f.service.identityKeyFor(f.current()),
      agent: "claude",
      command: "claude",
    };
  }
  const live = (f: Fixture, grant: ReturnType<typeof grantFor>, over: Record<string, unknown> = {}) =>
    isReviewGitGrantLive({
      state: f.state,
      grant,
      session: session as never,
      agentFor: () => "claude",
      identityKeyFor: (workspace) => f.service.identityKeyFor(workspace),
      ...over,
    });

  test("live for the same workspace, panel, command, agent, running session and branch", async () => {
    const f = await createFixture();
    const grant = grantFor(f);
    expect(grant.identityKey.startsWith("prepr|")).toBe(true);
    expect(live(f, grant)).toBe(true);
  });

  test("dead after the workspace is deleted, the panel command changes, the session ends or the profile goes", async () => {
    const f = await createFixture();
    const grant = grantFor(f);
    expect(live(f, grant, { session: { ...session, status: "exited" } })).toBe(false);
    expect(live(f, grant, { session: undefined })).toBe(false);
    expect(live(f, grant, { agentFor: () => "codex" })).toBe(false);
    f.current().panels[0].command = "codex";
    expect(live(f, grant)).toBe(false);
    f.current().panels[0].command = "claude";
    expect(live(f, grant)).toBe(true);
    f.current().profileId = "other";
    expect(live(f, grant)).toBe(false);
    f.current().profileId = "default";
    f.state.profiles = f.state.profiles.filter((profile) => profile.id !== "default");
    expect(live(f, grant)).toBe(false);
    f.state.profiles.push({ id: "default", name: "Default" } as never);
    f.state.workspaces = [];
    expect(live(f, grant)).toBe(false);
  });

  test("dead when the quickfix's connection, repository or branch differs from what the grant was minted for", async () => {
    const f = await createFixture();
    const grant = grantFor(f);
    const original = structuredClone(f.current());
    for (const change of [
      (ws: any) => (ws.quickfix.branchName = "other-branch"),
      (ws: any) => (ws.quickfix.remoteUrl = "https://example.invalid/evil/repo.git"),
      (ws: any) => (ws.quickfix.repositoryId = "other-repo"),
      (ws: any) => {
        ws.quickfix.connectionId = "conn-2";
        ws.review.connectionId = "conn-2";
      },
      (ws: any) => (ws.review.provider = "azure-devops"),
      (ws: any) => (ws.quickfix.connectionId = "conn-2"),
    ]) {
      f.state.workspaces = [structuredClone(original)];
      change(f.current());
      expect(live(f, grant)).toBe(false);
    }
  });

  test("a grant minted for a pull request is not satisfied by a quickfix workspace, and a pre-PR grant needs an empty PR key", async () => {
    const f = await createFixture();
    expect(
      live(f, {
        ...grantFor(f),
        prKey: "conn-1:repo:9",
        identityKey: "github|conn-1|conn-1:repo:9|refs/heads/fix/login|id:1",
      }),
    ).toBe(false);
    expect(live(f, { ...grantFor(f), prKey: "conn-1:repo:9" })).toBe(false);
  });

  function promote(f: Fixture, review: Record<string, unknown> = {}) {
    const ws = f.current();
    ws.review = {
      ...ws.review,
      prKey: "conn-1:repo:9",
      pullRequest: { id: 9, sourceRefName: BRANCH, targetRefName: "main" },
      ...review,
    };
    ws.quickfix = null;
  }

  test("the grant carries over when the PR is created for the same connection, repository and source ref", async () => {
    const f = await createFixture();
    const grant = grantFor(f);
    promote(f);
    expect(live(f, grant)).toBe(true);
    // ... also once the provider reports the same-repository source, in any spelling of the URL.
    f.current().review.sourceRepository = {
      id: "100",
      name: "repo",
      fullName: "acme/repo",
      remoteUrl: `${f.current().review.repository.remoteUrl}/`,
      sameAsTarget: true,
      canPush: null,
    };
    expect(live(f, grant)).toBe(true);
  });

  test("the grant is dead when the created PR differs: another branch, repository, connection or a fork", async () => {
    const f = await createFixture();
    const grant = grantFor(f);
    const base = structuredClone(f.current());
    const cases: Array<Record<string, unknown>> = [
      { pullRequest: { id: 9, sourceRefName: "refs/heads/elsewhere", targetRefName: "main" } },
      { repository: { id: "", name: "repo", remoteUrl: "https://example.invalid/evil/repo.git" } },
      { connectionId: "conn-2" },
      { provider: "azure-devops" },
      {
        sourceRepository: {
          id: "200",
          name: "repo",
          fullName: "someone/repo",
          remoteUrl: "https://example.invalid/someone/repo.git",
          sameAsTarget: false,
          canPush: true,
        },
      },
    ];
    for (const review of cases) {
      f.state.workspaces = [structuredClone(base)];
      promote(f, review);
      expect(live(f, grant), JSON.stringify(review)).toBe(false);
    }
  });
});

describe("a quickfix branch without a pull request: operations on a real repository", () => {
  test("push publishes the new branch: proposal first for an agent, then the continuation; the baseline follows the exact HEAD", async () => {
    const f = await createFixture();
    await commitFile(f.checkout, "n.txt", "n\n", "local");
    const head = git(f.checkout, ["rev-parse", "HEAD"]);
    expect(remoteSha(f, BRANCH)).toBe("");

    const proposed = await run(f, { kind: "push" });
    expect(proposed.status).toBe("confirm-required");
    expect(proposed.proposal).toMatchObject({ kind: "push", title: `Publish ${BRANCH}?` });
    expect(proposed.proposal.facts).toMatchObject({ headSha: head, liveSha: null, published: false });
    expect(proposed.proposal.affectedTotal).toBe(1);
    expect(remoteSha(f, BRANCH)).toBe("");
    expect(f.insertEntry).not.toHaveBeenCalled();
    expect(f.current().quickfix.sourceBaselineSha).toBeUndefined();

    const pushed = await run(f, { kind: "push", confirmation: { proposalId: proposed.proposal.proposalId } });
    expect(pushed).toMatchObject({ status: "pushed", headSha: head });
    expect(remoteSha(f, BRANCH)).toBe(head);
    expect(f.current().quickfix.sourceBaselineSha).toBe(head);
    // The audit row: intent before, no PR key, the recorded branch.
    expect(f.insertEntry).toHaveBeenCalledTimes(1);
    const row = (f.insertEntry.mock.calls[0] as unknown[])[0] as any;
    expect(row).toMatchObject({ operation: "gitPush", resourceType: "git", resourceId: WS });
    expect(JSON.parse(row.details)).toMatchObject({
      prKey: "",
      sourceRef: `refs/heads/${BRANCH}`,
      requester: { source: "mcp", agent: "claude" },
    });
  });

  test("a stale push proposal returns a NEW proposal instead of pushing", async () => {
    const f = await createFixture();
    await commitFile(f.checkout, "n.txt", "n\n", "local");
    const proposed = await run(f, { kind: "push" });
    await commitFile(f.checkout, "m.txt", "m\n", "second");
    const again = await run(f, { kind: "push", confirmation: { proposalId: proposed.proposal.proposalId } });
    expect(again.status).toBe("confirm-required");
    expect(again.stale).toBe(true);
    expect(again.proposal.proposalId).not.toBe(proposed.proposal.proposalId);
    expect(remoteSha(f, BRANCH)).toBe("");
  });

  test("push on the wrong branch is branch-mismatch, and a PR alias is not accepted for a quickfix", async () => {
    const f = await createFixture();
    await commitFile(f.checkout, "n.txt", "n\n", "local");
    git(f.checkout, ["checkout", "-q", "-b", "other"]);
    expect((await run(f, { kind: "push" })).code).toBe("branch-mismatch");
    git(f.checkout, ["checkout", "-q", "-b", "pr-9-fix-login"]);
    expect((await run(f, { kind: "push" })).code).toBe("branch-mismatch");
    expect(remoteSha(f, "other")).toBe("");
  });

  test("the UI's push (its own explicit action) publishes without a proposal", async () => {
    const f = await createFixture();
    await commitFile(f.checkout, "n.txt", "n\n", "local");
    expect((await run(f, { kind: "push" }, ui as never)).status).toBe("pushed");
    expect(remoteSha(f, BRANCH)).toBe(git(f.checkout, ["rev-parse", "HEAD"]));
  });

  test("refresh of a branch the remote does not have is blocked and points at push; it never touches the baseline", async () => {
    const f = await createFixture();
    const result = await run(f, { kind: "refresh" });
    expect(result).toMatchObject({ status: "blocked", code: "branch-not-published" });
    expect(result.guidance).toContain("push");
    expect(f.current().quickfix.sourceBaselineSha).toBeUndefined();
  });

  test("fetch and commit do not advance the baseline; a refresh that updates does", async () => {
    const f = await createFixture();
    await commitFile(f.checkout, "n.txt", "n\n", "local");
    await proceed(f, { kind: "push" });
    const published = git(f.checkout, ["rev-parse", "HEAD"]);
    expect(f.current().quickfix.sourceBaselineSha).toBe(published);

    // Someone else adds a commit to the branch on the server.
    git(f.seed, ["fetch", "-q", "origin", BRANCH]);
    git(f.seed, ["checkout", "-q", "-b", "peer", `origin/${BRANCH}`]);
    await commitFile(f.seed, "peer.txt", "p\n", "peer");
    git(f.seed, ["push", "-q", "origin", `peer:refs/heads/${BRANCH}`]);
    const serverTip = git(f.seed, ["rev-parse", "HEAD"]);

    expect((await run(f, { kind: "fetch" })).status).toBe("fetched");
    expect(f.current().quickfix.sourceBaselineSha).toBe(published);
    await fs.writeFile(path.join(f.checkout, "c.txt"), "c\n");
    git(f.checkout, ["add", "c.txt"]);
    const committed = await proceed(f, { kind: "commit", message: "mine" });
    expect(committed.status).toBe("committed");
    expect(f.current().quickfix.sourceBaselineSha).toBe(published);

    // A refresh now finds a diverged branch (local commit + server commit): nothing is discarded unasked.
    expect((await run(f, { kind: "refresh" })).status).toBe("confirm-required");
    expect(f.current().quickfix.sourceBaselineSha).toBe(published);

    // Without the local commit the refresh fast-forwards and the baseline moves to the live tip.
    git(f.checkout, ["reset", "-q", "--hard", published]);
    const refreshed = await run(f, { kind: "refresh" });
    expect(refreshed).toMatchObject({ status: "updated" });
    expect(f.current().quickfix.sourceBaselineSha).toBe(serverTip);
  });

  test("rebase onto the base branch: proposal first, then it rewrites only the local branch", async () => {
    const f = await createFixture();
    await commitFile(f.checkout, "n.txt", "n\n", "local");
    await commitFile(f.seed, "base.txt", "b\n", "base moves");
    git(f.seed, ["push", "-q", "origin", "HEAD:refs/heads/main"]);
    const before = git(f.checkout, ["rev-parse", "HEAD"]);

    const proposed = await run(f, { kind: "rebase" });
    expect(proposed.status).toBe("confirm-required");
    expect(proposed.proposal.kind).toBe("rebase");
    expect(proposed.proposal.message).toContain("does not push anything");
    expect(git(f.checkout, ["rev-parse", "HEAD"])).toBe(before);

    const rebased = await run(f, { kind: "rebase", confirmation: { proposalId: proposed.proposal.proposalId } });
    expect(rebased.status).toBe("rebased");
    expect(git(f.checkout, ["rev-parse", "HEAD~1"])).toBe(git(f.seed, ["rev-parse", "HEAD"]));
    expect(remoteSha(f, BRANCH)).toBe("");
    expect(f.current().quickfix.sourceBaselineSha).toBeUndefined();
  });

  test("a rebase that conflicts stops, can be aborted, and can be resolved and continued — each behind a proposal", async () => {
    const f = await createFixture();
    await fs.writeFile(path.join(f.checkout, "a.txt"), "one\nLOCAL\nthree\n");
    git(f.checkout, ["commit", "-q", "-am", "local edit"]);
    await fs.writeFile(path.join(f.seed, "a.txt"), "one\nSEED\nthree\n");
    git(f.seed, ["commit", "-q", "-am", "seed edit"]);
    git(f.seed, ["push", "-q", "origin", "HEAD:refs/heads/main"]);
    const before = git(f.checkout, ["rev-parse", "HEAD"]);

    const conflict = await proceed(f, { kind: "rebase" });
    expect(conflict).toMatchObject({ status: "conflict", operation: "rebase", conflictedPaths: ["a.txt"] });

    const aborted = await proceed(f, { kind: "abort" });
    expect(aborted.status).toBe("aborted");
    expect(git(f.checkout, ["rev-parse", "HEAD"])).toBe(before);

    expect((await proceed(f, { kind: "rebase" })).status).toBe("conflict");
    await fs.writeFile(path.join(f.checkout, "a.txt"), "one\nBOTH\nthree\n");
    git(f.checkout, ["add", "a.txt"]);
    const continued = await proceed(f, { kind: "continue" });
    expect(continued.status).toBe("continued");
    expect(git(f.checkout, ["show", "HEAD:a.txt"])).toContain("BOTH");
  });

  test("stage and commit are proposal-first for an agent and are audited", async () => {
    const f = await createFixture();
    await fs.writeFile(path.join(f.checkout, "n.txt"), "n\n");
    const staged = await proceed(f, { kind: "stage", paths: ["n.txt"] });
    expect(staged.status).toBe("staged");
    const head = git(f.checkout, ["rev-parse", "HEAD"]);
    const proposed = await run(f, { kind: "commit", message: "agent commit" });
    expect(proposed.status).toBe("confirm-required");
    expect(git(f.checkout, ["rev-parse", "HEAD"])).toBe(head);
    const committed = await run(f, {
      kind: "commit",
      message: "agent commit",
      confirmation: { proposalId: proposed.proposal.proposalId },
    });
    expect(committed.status).toBe("committed");
    expect(f.insertEntry).toHaveBeenCalledTimes(2);
  });

  test("force push is blocked while the branch is not on the remote: nothing to lease against, use push", async () => {
    const f = await createFixture();
    await commitFile(f.checkout, "n.txt", "n\n", "local");
    const result = await run(f, { kind: "force-push" });
    expect(result).toMatchObject({ status: "blocked", code: "branch-not-published" });
    expect(result.guidance).toContain("push");
    expect(remoteSha(f, BRANCH)).toBe("");
  });

  async function publishThenRewrite(f: Fixture) {
    await commitFile(f.checkout, "n.txt", "n\n", "local");
    await proceed(f, { kind: "push" });
    await commitFile(f.seed, "base.txt", "b\n", "base moves");
    git(f.seed, ["push", "-q", "origin", "HEAD:refs/heads/main"]);
    expect((await proceed(f, { kind: "rebase" })).status).toBe("rebased");
  }

  test("force push after a rebase: proposal first, leases the live SHA, and replaces the remote branch", async () => {
    const f = await createFixture();
    await publishThenRewrite(f);
    const published = f.current().quickfix.sourceBaselineSha as string;
    expect(remoteSha(f, BRANCH)).toBe(published);

    // A regular push of the rewritten branch is refused: it has diverged.
    expect((await run(f, { kind: "push" })).code).toBe("not-fast-forward");

    const proposed = await run(f, { kind: "force-push" });
    expect(proposed.status).toBe("confirm-required");
    expect(proposed.proposal.kind).toBe("force-push");
    expect(proposed.proposal.facts).toMatchObject({ liveSha: published });
    expect(remoteSha(f, BRANCH)).toBe(published);

    const forced = await run(f, { kind: "force-push", confirmation: { proposalId: proposed.proposal.proposalId } });
    expect(forced.status).toBe("pushed");
    const head = git(f.checkout, ["rev-parse", "HEAD"]);
    expect(remoteSha(f, BRANCH)).toBe(head);
    expect(f.current().quickfix.sourceBaselineSha).toBe(head);
  });

  test("force push whose remote branch moved since the proposal is a new proposal; nothing is overwritten", async () => {
    const f = await createFixture();
    await publishThenRewrite(f);
    const proposed = await run(f, { kind: "force-push" });
    expect(proposed.status).toBe("confirm-required");

    git(f.seed, ["fetch", "-q", "origin", BRANCH]);
    git(f.seed, ["checkout", "-q", "-b", "peer", `origin/${BRANCH}`]);
    await commitFile(f.seed, "peer.txt", "p\n", "peer");
    git(f.seed, ["push", "-q", "origin", `peer:refs/heads/${BRANCH}`]);
    const moved = git(f.seed, ["rev-parse", "HEAD"]);

    const again = await run(f, { kind: "force-push", confirmation: { proposalId: proposed.proposal.proposalId } });
    expect(again).toMatchObject({ status: "confirm-required", stale: true });
    expect(again.proposal.facts).toMatchObject({ liveSha: moved, serverMovedSinceBaseline: true });
    expect(remoteSha(f, BRANCH)).toBe(moved);
  });

  test("publishing drafts is not an operation of a quickfix branch", async () => {
    const f = await createFixture();
    expect(() => f.service.start({ kind: "push-and-publish", workspaceId: WS }, ui)).toThrow("no pull request yet");
    expect(() => f.service.start({ kind: "force-push-and-publish", workspaceId: WS }, ui)).toThrow(
      "no pull request yet",
    );
  });

  test("an operation never reaches another profile's quickfix", async () => {
    const f = await createFixture();
    expect(() => f.service.start({ kind: "fetch", workspaceId: WS }, { ...ui, profileId: "other" })).toThrow(
      "Cross-profile refused",
    );
  });
});

describe("a quickfix branch without a pull request: PR actions", () => {
  test("inspect and propose answer that there is no pull request yet instead of crashing", async () => {
    const f = await createFixture();
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "strideterm-pre-pr-ops-"));
    dirs.push(dir);
    const noop = { trace() {}, debug() {}, info() {}, warn() {}, error() {} };
    const actions = createReviewPrActionService({
      getState: () => f.state as never,
      locate: (workspaceId, profileId) => f.service.locate(workspaceId, profileId),
      operations: createOperationRegistry({
        dir: path.join(dir, "operations"),
        log: noop,
        emitFinished() {},
        onChange() {},
      }),
      auditStores: {},
      refreshAzure: async () => {},
      refreshGitHub: async () => {},
      broadcastState() {},
      log: noop,
    });
    await expect(actions.startInspection(WS, "default", "inspect-key-1")).rejects.toThrow("no pull request yet");
    await expect(
      actions.startProposal({ action: "merge", options: {}, idempotencyKey: "proposal-key-1" } as never, {
        profileId: "default",
        workspaceId: WS,
        requester: { source: "mcp", agent: "claude", panelId: "panel-1" },
      }),
    ).rejects.toThrow("no pull request yet");
  });
});
