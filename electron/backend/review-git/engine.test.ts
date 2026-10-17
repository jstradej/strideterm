import { execFile } from "node:child_process";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createReviewGitEngine, managedReviewBranchAlias, type ReviewGitAuditEntry } from "./engine.js";
import { createReviewGitLocks } from "./locks.js";
import type { GitRun } from "./inspect.js";
import type { ReviewGitResult, ReviewGitSubject } from "./types.js";

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await execFileAsync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", ...args], {
    cwd,
    windowsHide: true,
  });
  return String(result.stdout).trim();
}

const runGit: GitRun = async (cwd, args) => {
  try {
    const result = await execFileAsync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", ...args], {
      cwd,
      windowsHide: true,
    });
    return { stdout: String(result.stdout), stderr: String(result.stderr) };
  } catch (error) {
    const err = error as { stderr?: string; message?: string };
    throw new Error(String(err.stderr || err.message || "git failed").trim(), { cause: error });
  }
};

interface Fixture {
  root: string;
  remote: string;
  seed: string;
  checkout: string;
  subject: ReviewGitSubject;
  audit: {
    entries: ReviewGitAuditEntry[];
    finished: Array<{ outcome: string; success: boolean }>;
    failBegin: boolean;
    failFinish: boolean;
  };
  baselines: string[];
  persistFails: { value: boolean };
  engine: ReturnType<typeof createReviewGitEngine>;
  commitOnRemote(message: string): Promise<string>;
  forceRemoteTo(sha: string): Promise<void>;
  commitLocal(message: string, file?: string): Promise<string>;
  head(): Promise<string>;
  remoteSha(): Promise<string>;
  setGit(wrapper: (inner: GitRun) => GitRun): void;
}

let fixtures: Fixture[] = [];

async function createFixture({ role = "reviewer" }: { role?: string } = {}): Promise<Fixture> {
  const root = await mkdtemp(path.join(os.tmpdir(), "strideterm-review-git-"));
  const remote = path.join(root, "remote.git");
  const seed = path.join(root, "seed");
  const checkout = path.join(root, "checkout");
  await git(root, ["init", "--bare", "-b", "main", remote]);
  await git(root, ["clone", remote, seed]);
  await writeFile(path.join(seed, "a.txt"), "a\n");
  await git(seed, ["add", "."]);
  await git(seed, ["commit", "-m", "A"]);
  await git(seed, ["push", "origin", "HEAD:refs/heads/main"]);
  await git(seed, ["checkout", "-b", "feature"]);
  await writeFile(path.join(seed, "f.txt"), "f1\n");
  await git(seed, ["add", "."]);
  await git(seed, ["commit", "-m", "feature 1"]);
  await git(seed, ["push", "origin", "feature"]);
  await git(root, ["clone", remote, checkout]);
  await git(checkout, ["checkout", "-b", managedReviewBranchAlias(7, "refs/heads/feature"), "origin/feature"]);

  const baselines: string[] = [];
  const persistFails = { value: false };
  const audit: Fixture["audit"] = { entries: [], finished: [], failBegin: false, failFinish: false };
  let gitImpl: GitRun = runGit;
  const subject: ReviewGitSubject = {
    workspaceId: "ws-1",
    profileId: "default",
    cwd: checkout,
    provider: "github",
    connectionId: "conn-1",
    prKey: "conn-1:repo:7",
    prId: 7,
    role,
    sourceRefName: "refs/heads/feature",
    targetRefName: "refs/heads/main",
    sourceRepository: {
      id: "100",
      name: "repo",
      fullName: "acme/repo",
      remoteUrl: remote,
      sameAsTarget: true,
      canPush: null,
    },
    targetRemoteUrl: remote,
    baselineSha: "",
    checkout: { mode: "managed-worktree", rootPath: checkout, cacheRepoPath: checkout },
    auth: { token: "token" },
  };
  const engine = createReviewGitEngine({
    git: (cwd, args, auth) => gitImpl(cwd, args, auth),
    locks: createReviewGitLocks(),
    audit: {
      begin(entry) {
        if (audit.failBegin) return null;
        audit.onBegin?.();
        audit.entries.push(entry);
        return { index: audit.entries.length - 1 };
      },
      finish(_handle, outcome) {
        if (audit.failFinish) return false;
        audit.finished.push({ outcome: outcome.outcome, success: outcome.success });
        return true;
      },
    },
    async persistBaseline(_subject, sha) {
      if (persistFails.value) throw new Error("disk full");
      baselines.push(sha);
    },
    log: { info() {}, warn() {} },
  });

  const fixture: Fixture = {
    root,
    remote,
    seed,
    checkout,
    subject,
    audit,
    baselines,
    persistFails,
    engine,
    async commitOnRemote(message) {
      await git(seed, ["checkout", "feature"]);
      await writeFile(path.join(seed, `${message.replace(/\W+/gu, "_")}.txt`), `${message}\n`);
      await git(seed, ["add", "."]);
      await git(seed, ["commit", "-m", message]);
      await git(seed, ["push", "origin", "feature"]);
      return git(seed, ["rev-parse", "HEAD"]);
    },
    async forceRemoteTo(sha) {
      await git(seed, ["push", "--force", "origin", `${sha}:refs/heads/feature`]);
    },
    async commitLocal(message, file = "local.txt") {
      await writeFile(path.join(checkout, file), `${message}\n`);
      await git(checkout, ["add", "."]);
      await git(checkout, ["commit", "-m", message]);
      return git(checkout, ["rev-parse", "HEAD"]);
    },
    head: () => git(checkout, ["rev-parse", "HEAD"]),
    remoteSha: async () => (await git(remote, ["rev-parse", "refs/heads/feature"])).trim(),
    setGit(wrapper) {
      gitImpl = wrapper(runGit);
    },
  };
  fixtures.push(fixture);
  return fixture;
}

const requester = { source: "mcp" as const, agent: "claude", consent: "user said yes" };

function expectStatus<S extends ReviewGitResult["status"]>(
  result: ReviewGitResult,
  status: S,
): Extract<ReviewGitResult, { status: S }> {
  expect(result.status, JSON.stringify(result)).toBe(status);
  return result as Extract<ReviewGitResult, { status: S }>;
}

beforeEach(() => {
  fixtures = [];
});

afterEach(async () => {
  for (const fixture of fixtures) await rm(fixture.root, { recursive: true, force: true, maxRetries: 5 });
});

describe("refresh", () => {
  test("HEAD equal to the live source: no movement, baseline initialized", async () => {
    const f = await createFixture();
    const result = expectStatus(await f.engine.refresh(f.subject, requester), "already-current");
    expect(result.headSha).toBe(await f.remoteSha());
    expect(f.baselines).toEqual([await f.remoteSha()]);
  });

  test("behind the live source: fast-forwards automatically and advances the baseline", async () => {
    const f = await createFixture();
    f.subject.baselineSha = await f.head();
    const tip = await f.commitOnRemote("feature 2");
    const result = expectStatus(await f.engine.refresh(f.subject, requester), "updated");
    expect(result.commitCount).toBe(1);
    expect(await f.head()).toBe(tip);
    expect(f.baselines).toEqual([tip]);
  });

  test("local commits ahead, remote unchanged: reports ahead and initializes a missing baseline", async () => {
    const f = await createFixture();
    await f.commitLocal("mine");
    const result = expectStatus(await f.engine.refresh(f.subject, requester), "ahead");
    expect(result.message).toContain("1 commit ahead");
    expect(f.baselines).toEqual([await f.remoteSha()]);
  });

  test.each(["reviewer", "author"])(
    "source rewritten while a clean HEAD still equals the baseline: resets automatically (%s)",
    async (role) => {
      const f = await createFixture({ role });
      const oldHead = await f.head();
      f.subject.baselineSha = oldHead;
      await git(f.seed, ["checkout", "feature"]);
      await git(f.seed, ["reset", "--hard", "main"]);
      await writeFile(path.join(f.seed, "rewritten.txt"), "r\n");
      await git(f.seed, ["add", "."]);
      await git(f.seed, ["commit", "-m", "rewritten"]);
      await git(f.seed, ["push", "--force", "origin", "feature"]);
      const rewritten = await f.remoteSha();

      const result = expectStatus(await f.engine.refresh(f.subject, requester), "reset");
      expect(await f.head()).toBe(rewritten);
      expect(result.discardedCount).toBe(1);
      expect(f.baselines).toEqual([rewritten]);
      expect(result.recoveryRef).toBeTruthy();
      expect(await git(f.checkout, ["rev-parse", result.recoveryRef!])).toBe(oldHead);
    },
  );

  test("HEAD moved off the baseline: confirmation required, nothing changes until confirmed", async () => {
    const f = await createFixture();
    f.subject.baselineSha = await f.head();
    const mine = await f.commitLocal("mine");
    await git(f.seed, ["checkout", "feature"]);
    await git(f.seed, ["reset", "--hard", "main"]);
    await writeFile(path.join(f.seed, "rewritten.txt"), "r\n");
    await git(f.seed, ["add", "."]);
    await git(f.seed, ["commit", "-m", "rewritten"]);
    await git(f.seed, ["push", "--force", "origin", "feature"]);
    const rewritten = await f.remoteSha();

    const first = expectStatus(await f.engine.refresh(f.subject, requester), "confirm-required");
    expect(first.proposal.kind).toBe("reset");
    expect(first.proposal.facts).toMatchObject({ headSha: mine, liveSha: rewritten });
    expect(first.proposal.affectedCommits.map((c) => c.subject)).toEqual(expect.arrayContaining(["mine"]));
    expect(await f.head()).toBe(mine);
    expect(f.baselines).toEqual([]);

    const confirmed = expectStatus(
      await f.engine.refresh(f.subject, requester, { proposalId: first.proposal.proposalId }),
      "reset",
    );
    expect(await f.head()).toBe(rewritten);
    expect(confirmed.discardedCount).toBeGreaterThanOrEqual(1);
    expect(f.baselines).toEqual([rewritten]);
    expect(await git(f.checkout, ["rev-parse", confirmed.recoveryRef!])).toBe(mine);
  });

  test("a confirmation is refused as stale once the live source moved again", async () => {
    const f = await createFixture();
    await f.commitLocal("mine");
    await git(f.seed, ["checkout", "feature"]);
    await git(f.seed, ["reset", "--hard", "main"]);
    await git(f.seed, ["commit", "--allow-empty", "-m", "rewritten 1"]);
    await git(f.seed, ["push", "--force", "origin", "feature"]);
    const first = expectStatus(await f.engine.refresh(f.subject, requester), "confirm-required");
    await git(f.seed, ["commit", "--allow-empty", "-m", "rewritten 2"]);
    await git(f.seed, ["push", "--force", "origin", "feature"]);

    const second = expectStatus(
      await f.engine.refresh(f.subject, requester, { proposalId: first.proposal.proposalId }),
      "confirm-required",
    );
    expect(second.stale).toBe(true);
    expect(second.proposal.proposalId).not.toBe(first.proposal.proposalId);
  });

  test("unknown baseline with a diverged history stays conservative and asks", async () => {
    const f = await createFixture();
    await f.commitLocal("mine");
    await f.commitOnRemote("theirs");
    expectStatus(await f.engine.refresh(f.subject, requester), "confirm-required");
  });

  test("a baseline recorded for a different commit does not authorize a reset", async () => {
    const f = await createFixture();
    f.subject.baselineSha = "0".repeat(40);
    await f.commitLocal("mine");
    await f.commitOnRemote("theirs");
    expectStatus(await f.engine.refresh(f.subject, requester), "confirm-required");
  });

  test("a dirty worktree blocks movement and nothing is stashed", async () => {
    const f = await createFixture();
    await f.commitOnRemote("feature 2");
    await writeFile(path.join(f.checkout, "f.txt"), "edited\n");
    const before = await f.head();
    const result = expectStatus(await f.engine.refresh(f.subject, requester), "blocked");
    expect(result.code).toBe("dirty-tree");
    expect(await f.head()).toBe(before);
    expect(await git(f.checkout, ["stash", "list"])).toBe("");
  });

  test("untracked files block the reset path too", async () => {
    const f = await createFixture();
    f.subject.baselineSha = await f.head();
    await git(f.seed, ["checkout", "feature"]);
    await git(f.seed, ["reset", "--hard", "main"]);
    await git(f.seed, ["commit", "--allow-empty", "-m", "rewritten"]);
    await git(f.seed, ["push", "--force", "origin", "feature"]);
    await writeFile(path.join(f.checkout, "untracked.txt"), "x\n");
    const result = expectStatus(await f.engine.refresh(f.subject, requester), "blocked");
    expect(result.code).toBe("dirty-tree");
  });

  test("an active rebase blocks everything", async () => {
    const f = await createFixture();
    await f.commitLocal("mine", "conflict.txt");
    await git(f.seed, ["checkout", "main"]);
    await writeFile(path.join(f.seed, "conflict.txt"), "main version\n");
    await git(f.seed, ["add", "."]);
    await git(f.seed, ["commit", "-m", "main conflict"]);
    await git(f.seed, ["push", "origin", "main"]);
    await git(f.checkout, ["fetch", "origin"]);
    await git(f.checkout, ["rebase", "origin/main"]).catch(() => "conflicted");
    const result = expectStatus(await f.engine.refresh(f.subject, requester), "blocked");
    expect(result.code).toBe("operation-in-progress");
  });

  test("a checkout switched to an unrelated branch is blocked, not refreshed", async () => {
    const f = await createFixture();
    await git(f.checkout, ["checkout", "-b", "develop", "origin/main"]);
    const result = expectStatus(await f.engine.refresh(f.subject, requester), "blocked");
    expect(result.code).toBe("branch-mismatch");
  });

  test("a deleted source branch blocks without touching local work", async () => {
    const f = await createFixture();
    await git(f.seed, ["push", "origin", ":refs/heads/feature"]);
    const result = expectStatus(await f.engine.refresh(f.subject, requester), "blocked");
    expect(result.code).toBe("source-ref-deleted");
  });

  test("an unknown source repository blocks instead of guessing from origin", async () => {
    const f = await createFixture();
    f.subject.sourceRepository = null;
    const result = expectStatus(await f.engine.refresh(f.subject, requester), "blocked");
    expect(result.code).toBe("source-unverified");
  });

  test("a failed audit-intent write blocks the mutation", async () => {
    const f = await createFixture();
    await f.commitOnRemote("feature 2");
    const before = await f.head();
    f.audit.failBegin = true;
    const result = expectStatus(await f.engine.refresh(f.subject, requester), "blocked");
    expect(result.code).toBe("audit-unavailable");
    expect(await f.head()).toBe(before);
  });

  test("a failed audit-outcome write is reported, and the mutation is not replayed", async () => {
    const f = await createFixture();
    const tip = await f.commitOnRemote("feature 2");
    f.audit.failFinish = true;
    const result = expectStatus(await f.engine.refresh(f.subject, requester), "updated");
    expect(result.message).toContain("audit outcome could not be recorded");
    expect(await f.head()).toBe(tip);
  });

  test("a baseline that cannot be saved stays stale and says so", async () => {
    const f = await createFixture();
    f.persistFails.value = true;
    await f.commitOnRemote("feature 2");
    const result = expectStatus(await f.engine.refresh(f.subject, requester), "updated");
    expect(result.baselineWarning).toContain("disk full");
    expect(f.subject.baselineSha).toBe("");
  });

  test("writes one audit row per operation, carrying the agent and its reported consent", async () => {
    const f = await createFixture();
    await f.commitOnRemote("feature 2");
    await f.engine.refresh(f.subject, { ...requester, operationId: "op-1" });
    expect(f.audit.entries).toHaveLength(1);
    expect(f.audit.entries[0]).toMatchObject({
      operationId: "op-1",
      kind: "sync-merge",
      requester: { agent: "claude", consent: "user said yes" },
    });
    expect(f.audit.finished).toEqual([{ outcome: "updated", success: true }]);
  });

  test("a shallow clone cannot prove ancestry, so a diverged-looking refresh is blocked", async () => {
    const f = await createFixture();
    const shallow = path.join(f.root, "shallow");
    await git(f.root, [
      "clone",
      "--depth",
      "1",
      "--branch",
      "feature",
      `file://${f.remote.replaceAll("\\", "/")}`,
      shallow,
    ]);
    await git(shallow, ["checkout", "-b", managedReviewBranchAlias(7, "refs/heads/feature")]);
    await writeFile(path.join(shallow, "s.txt"), "s\n");
    await git(shallow, ["add", "."]);
    await git(shallow, ["commit", "-m", "shallow local"]);
    await f.commitOnRemote("feature 2");
    const subject = { ...f.subject, cwd: shallow };
    const result = expectStatus(await f.engine.refresh(subject, requester), "blocked");
    expect(result.code).toBe("shallow-history");
  });
});

describe("push", () => {
  test("fast-forward push publishes HEAD to the source ref and advances the baseline", async () => {
    const f = await createFixture();
    const mine = await f.commitLocal("mine");
    const result = expectStatus(await f.engine.push(f.subject, requester), "pushed");
    expect(await f.remoteSha()).toBe(mine);
    expect(f.baselines).toEqual([mine]);
    expect(result.message).toContain("feature");
  });

  test("uncommitted files alone do not block pushing committed HEAD", async () => {
    const f = await createFixture();
    const mine = await f.commitLocal("mine");
    await writeFile(path.join(f.checkout, "wip.txt"), "wip\n");
    expectStatus(await f.engine.push(f.subject, requester), "pushed");
    expect(await f.remoteSha()).toBe(mine);
  });

  test("pushes to the verified source repository, not to a differently named origin", async () => {
    const f = await createFixture();
    const other = path.join(f.root, "other.git");
    await git(f.root, ["init", "--bare", "-b", "main", other]);
    await git(f.checkout, ["remote", "set-url", "origin", other]);
    const mine = await f.commitLocal("mine");
    expectStatus(await f.engine.push(f.subject, requester), "pushed");
    expect(await f.remoteSha()).toBe(mine);
    await expect(git(other, ["rev-parse", "refs/heads/feature"])).rejects.toThrow();
  });

  test("a server that moved to a commit HEAD already contains is not a warning", async () => {
    const f = await createFixture();
    const tip = await f.commitOnRemote("feature 2");
    await git(f.checkout, ["fetch", "origin"]);
    await git(f.checkout, ["merge", "--ff-only", tip]);
    const mine = await f.commitLocal("mine");
    expectStatus(await f.engine.push(f.subject, requester), "pushed");
    expect(await f.remoteSha()).toBe(mine);
  });

  test("equal to the server: nothing to push", async () => {
    const f = await createFixture();
    expectStatus(await f.engine.push(f.subject, requester), "up-to-date");
  });

  test("behind the server: a regular push is blocked toward refresh", async () => {
    const f = await createFixture();
    await f.commitOnRemote("feature 2");
    const result = expectStatus(await f.engine.push(f.subject, requester), "blocked");
    expect(result.code).toBe("behind-remote");
  });

  test("diverged: a regular push is blocked and force push is named as the separate action", async () => {
    const f = await createFixture();
    await f.commitLocal("mine");
    await f.commitOnRemote("theirs");
    const result = expectStatus(await f.engine.push(f.subject, requester), "blocked");
    expect(result.code).toBe("not-fast-forward");
    expect(result.guidance).toContain("Force push");
  });

  test("a fork source that is not verified writable blocks the push", async () => {
    const f = await createFixture();
    f.subject.sourceRepository = { ...f.subject.sourceRepository!, sameAsTarget: false, canPush: null };
    await f.commitLocal("mine");
    const result = expectStatus(await f.engine.push(f.subject, requester), "blocked");
    expect(result.code).toBe("source-repo-unsupported");
  });

  test("a source repository reported read-only blocks the push", async () => {
    const f = await createFixture();
    f.subject.sourceRepository = { ...f.subject.sourceRepository!, canPush: false };
    await f.commitLocal("mine");
    const result = expectStatus(await f.engine.push(f.subject, requester), "blocked");
    expect(result.code).toBe("source-not-writable");
  });

  test("a verified-writable fork is pushed to explicitly", async () => {
    const f = await createFixture();
    f.subject.sourceRepository = { ...f.subject.sourceRepository!, sameAsTarget: false, canPush: true };
    const mine = await f.commitLocal("mine");
    expectStatus(await f.engine.push(f.subject, requester), "pushed");
    expect(await f.remoteSha()).toBe(mine);
  });

  test("a PR-targeted push from a checkout switched to another branch is blocked", async () => {
    const f = await createFixture();
    await git(f.checkout, ["checkout", "-b", "develop", "origin/main"]);
    await f.commitLocal("on develop");
    const result = expectStatus(await f.engine.push(f.subject, requester), "blocked");
    expect(result.code).toBe("branch-mismatch");
  });
});

describe("force push", () => {
  async function rewriteLocally(f: Fixture): Promise<{ rewritten: string }> {
    await git(f.checkout, ["reset", "--hard", "origin/main"]);
    const rewritten = await f.commitLocal("rewritten locally", "r.txt");
    return { rewritten };
  }

  test("server still at the baseline: no concurrent-change warning, leases the exact live SHA", async () => {
    const f = await createFixture();
    const baseline = await f.head();
    f.subject.baselineSha = baseline;
    const pushes: string[][] = [];
    f.setGit((inner) => async (cwd, args, auth) => {
      if (args[0] === "push") pushes.push(args);
      return inner(cwd, args, auth);
    });
    const { rewritten } = await rewriteLocally(f);
    expectStatus(await f.engine.push(f.subject, requester, { force: true }), "pushed");
    expect(await f.remoteSha()).toBe(rewritten);
    expect(pushes).toHaveLength(1);
    expect(pushes[0]).toContain(`--force-with-lease=refs/heads/feature:${baseline}`);
    expect(pushes[0].some((arg) => arg === `${rewritten}:refs/heads/feature`)).toBe(true);
    expect(f.baselines).toEqual([rewritten]);
  });

  test("server moved since the baseline: shows baseline/server/local and asks first", async () => {
    const f = await createFixture();
    const baseline = await f.head();
    f.subject.baselineSha = baseline;
    const { rewritten } = await rewriteLocally(f);
    const theirs = await f.commitOnRemote("theirs");

    const first = expectStatus(await f.engine.push(f.subject, requester, { force: true }), "confirm-required");
    expect(first.proposal.kind).toBe("force-push");
    expect(first.proposal.facts).toMatchObject({ headSha: rewritten, liveSha: theirs, baselineSha: baseline });
    expect(first.proposal.incomingCommits.map((c) => c.subject)).toContain("theirs");
    expect(await f.remoteSha()).toBe(theirs);

    expectStatus(
      await f.engine.push(f.subject, requester, {
        force: true,
        confirmation: { proposalId: first.proposal.proposalId },
      }),
      "pushed",
    );
    expect(await f.remoteSha()).toBe(rewritten);
  });

  test("accepting a warning and then cancelling leaves the baseline untouched", async () => {
    const f = await createFixture();
    const baseline = await f.head();
    f.subject.baselineSha = baseline;
    await rewriteLocally(f);
    await f.commitOnRemote("theirs");
    expectStatus(await f.engine.push(f.subject, requester, { force: true }), "confirm-required");
    expect(f.baselines).toEqual([]);
    expect(f.subject.baselineSha).toBe(baseline);
  });

  test("a lease rejection fails the operation, is not retried, and leaves the baseline alone", async () => {
    const f = await createFixture();
    const baseline = await f.head();
    f.subject.baselineSha = baseline;
    await rewriteLocally(f);
    let pushAttempts = 0;
    f.setGit((inner) => async (cwd, args, auth) => {
      if (args[0] === "push") {
        pushAttempts += 1;
        await f.commitOnRemote("raced in");
      }
      return inner(cwd, args, auth);
    });
    await expect(f.engine.push(f.subject, requester, { force: true })).rejects.toThrow();
    expect(pushAttempts).toBe(1);
    expect(f.baselines).toEqual([]);
    expect(f.audit.finished.at(-1)).toMatchObject({ outcome: "failed", success: false });
  });

  test("a stale confirmation (server moved again while asking) asks again instead of forcing", async () => {
    const f = await createFixture();
    f.subject.baselineSha = await f.head();
    await rewriteLocally(f);
    await f.commitOnRemote("theirs");
    const first = expectStatus(await f.engine.push(f.subject, requester, { force: true }), "confirm-required");
    await f.commitOnRemote("theirs again");
    const second = expectStatus(
      await f.engine.push(f.subject, requester, {
        force: true,
        confirmation: { proposalId: first.proposal.proposalId },
      }),
      "confirm-required",
    );
    expect(second.stale).toBe(true);
  });
});

describe("rebase onto the PR target", () => {
  async function advanceTarget(f: Fixture, file: string, content: string): Promise<string> {
    await git(f.seed, ["checkout", "main"]);
    await writeFile(path.join(f.seed, file), content);
    await git(f.seed, ["add", "."]);
    await git(f.seed, ["commit", "-m", `main ${file}`]);
    await git(f.seed, ["push", "origin", "main"]);
    return git(f.seed, ["rev-parse", "HEAD"]);
  }

  test("asks first, pins the target SHA, rewrites the local branch, never touches the baseline or the remote", async () => {
    const f = await createFixture();
    f.subject.baselineSha = await f.head();
    const baseline = f.subject.baselineSha;
    const target = await advanceTarget(f, "main-only.txt", "m\n");
    const remoteBefore = await f.remoteSha();

    const first = expectStatus(await f.engine.rebase(f.subject, requester), "confirm-required");
    expect(first.proposal.facts).toMatchObject({ targetSha: target });
    expectStatus(await f.engine.rebase(f.subject, requester, { proposalId: first.proposal.proposalId }), "rebased");
    expect(await git(f.checkout, ["merge-base", "--is-ancestor", target, "HEAD"]).then(() => true)).toBe(true);
    expect(f.subject.baselineSha).toBe(baseline);
    expect(f.baselines).toEqual([]);
    expect(await f.remoteSha()).toBe(remoteBefore);
  });

  test("stops with a conflict and reports it; abort restores the branch", async () => {
    const f = await createFixture();
    const before = await f.commitLocal("mine", "same.txt");
    await advanceTarget(f, "same.txt", "main version\n");
    const first = expectStatus(await f.engine.rebase(f.subject, requester), "confirm-required");
    const result = expectStatus(
      await f.engine.rebase(f.subject, requester, { proposalId: first.proposal.proposalId }),
      "conflict",
    );
    expect(result.conflictedPaths).toEqual(["same.txt"]);

    const blocked = expectStatus(await f.engine.refresh(f.subject, requester), "blocked");
    expect(blocked.code).toBe("operation-in-progress");

    const abort = expectStatus(await f.engine.abortOperation(f.subject, requester), "confirm-required");
    expectStatus(
      await f.engine.abortOperation(f.subject, requester, { proposalId: abort.proposal.proposalId }),
      "aborted",
    );
    expect(await f.head()).toBe(before);
  });

  test("a dirty tree blocks the rebase", async () => {
    const f = await createFixture();
    await advanceTarget(f, "main-only.txt", "m\n");
    await writeFile(path.join(f.checkout, "f.txt"), "edited\n");
    const result = expectStatus(await f.engine.rebase(f.subject, requester), "blocked");
    expect(result.code).toBe("dirty-tree");
  });

  test("already based on the target: nothing to do", async () => {
    const f = await createFixture();
    expectStatus(await f.engine.rebase(f.subject, requester), "up-to-date");
  });
});

describe("stage, commit and resolving a paused operation", () => {
  test("stage pins the intended paths and the index; a changed index asks again", async () => {
    const f = await createFixture();
    await writeFile(path.join(f.checkout, "one.txt"), "1\n");
    await writeFile(path.join(f.checkout, "two.txt"), "2\n");
    const first = expectStatus(await f.engine.stage(f.subject, requester, ["one.txt"]), "confirm-required");
    await writeFile(path.join(f.checkout, "three.txt"), "3\n");
    const stale = expectStatus(
      await f.engine.stage(f.subject, requester, ["one.txt"], { proposalId: first.proposal.proposalId }),
      "confirm-required",
    );
    expect(stale.stale).toBe(true);
    expectStatus(
      await f.engine.stage(f.subject, requester, ["one.txt"], { proposalId: stale.proposal.proposalId }),
      "staged",
    );
    expect(await git(f.checkout, ["diff", "--cached", "--name-only"])).toBe("one.txt");
  });

  test("stage rejects paths outside the repository and paths without changes", async () => {
    const f = await createFixture();
    await writeFile(path.join(f.checkout, "one.txt"), "1\n");
    for (const bad of ["../escape.txt", "/etc/passwd", "f.txt", ":(glob)*"]) {
      const result = expectStatus(await f.engine.stage(f.subject, requester, [bad]), "blocked");
      expect(result.code).toBe("invalid-paths");
    }
  });

  test("unstage removes a path from the index", async () => {
    const f = await createFixture();
    await writeFile(path.join(f.checkout, "one.txt"), "1\n");
    await git(f.checkout, ["add", "one.txt"]);
    const first = expectStatus(await f.engine.unstage(f.subject, requester, ["one.txt"]), "confirm-required");
    expectStatus(
      await f.engine.unstage(f.subject, requester, ["one.txt"], { proposalId: first.proposal.proposalId }),
      "unstaged",
    );
    expect(await git(f.checkout, ["diff", "--cached", "--name-only"])).toBe("");
  });

  test("commit pins the staged diff and the message: changing either asks again", async () => {
    const f = await createFixture();
    await writeFile(path.join(f.checkout, "one.txt"), "1\n");
    await git(f.checkout, ["add", "one.txt"]);
    const first = expectStatus(await f.engine.commit(f.subject, requester, "add one"), "confirm-required");
    await writeFile(path.join(f.checkout, "one.txt"), "changed after asking\n");
    await git(f.checkout, ["add", "one.txt"]);
    const stale = expectStatus(
      await f.engine.commit(f.subject, requester, "add one", { proposalId: first.proposal.proposalId }),
      "confirm-required",
    );
    expect(stale.stale).toBe(true);
    const reworded = expectStatus(
      await f.engine.commit(f.subject, requester, "different message", { proposalId: stale.proposal.proposalId }),
      "confirm-required",
    );
    expect(reworded.stale).toBe(true);
    const done = expectStatus(
      await f.engine.commit(f.subject, requester, "different message", { proposalId: reworded.proposal.proposalId }),
      "committed",
    );
    expect(await git(f.checkout, ["log", "-1", "--format=%s"])).toBe("different message");
    expect(done.headSha).toBe(await f.head());
    expect(f.baselines).toEqual([]);
  });

  test("commit with nothing staged is blocked", async () => {
    const f = await createFixture();
    const result = expectStatus(await f.engine.commit(f.subject, requester, "nothing"), "blocked");
    expect(result.code).toBe("nothing-to-commit");
  });

  test("continue is blocked while conflicts remain, then resolves a paused rebase", async () => {
    const f = await createFixture();
    await f.commitLocal("mine", "same.txt");
    await git(f.seed, ["checkout", "main"]);
    await writeFile(path.join(f.seed, "same.txt"), "main version\n");
    await git(f.seed, ["add", "."]);
    await git(f.seed, ["commit", "-m", "main same"]);
    await git(f.seed, ["push", "origin", "main"]);
    const proposal = expectStatus(await f.engine.rebase(f.subject, requester), "confirm-required");
    expectStatus(await f.engine.rebase(f.subject, requester, { proposalId: proposal.proposal.proposalId }), "conflict");

    const blocked = expectStatus(await f.engine.continueOperation(f.subject, requester), "blocked");
    expect(blocked.code).toBe("conflicts-unresolved");

    await writeFile(path.join(f.checkout, "same.txt"), "resolved\n");
    await git(f.checkout, ["add", "same.txt"]);
    const ask = expectStatus(await f.engine.continueOperation(f.subject, requester), "confirm-required");
    expectStatus(
      await f.engine.continueOperation(f.subject, requester, { proposalId: ask.proposal.proposalId }),
      "continued",
    );
    expect(await git(f.checkout, ["status", "--porcelain"])).toBe("");
  });

  test("a paused operation blocks refresh and push but not reading state", async () => {
    const f = await createFixture();
    await f.commitLocal("mine", "same.txt");
    await git(f.seed, ["checkout", "main"]);
    await writeFile(path.join(f.seed, "same.txt"), "main version\n");
    await git(f.seed, ["add", "."]);
    await git(f.seed, ["commit", "-m", "main same"]);
    await git(f.seed, ["push", "origin", "main"]);
    const proposal = expectStatus(await f.engine.rebase(f.subject, requester), "confirm-required");
    await f.engine.rebase(f.subject, requester, { proposalId: proposal.proposal.proposalId });
    expect(expectStatus(await f.engine.push(f.subject, requester), "blocked").code).toBe("operation-in-progress");
    expect(await f.engine.conflictedPaths(f.checkout)).toEqual(["same.txt"]);
  });
});

describe("last-moment recheck, identity and proposals for agents", () => {
  test("a shell commit landing between inspection and the command stops the mutation", async () => {
    const f = await createFixture();
    await f.commitOnRemote("feature 2");
    const before = await f.head();
    f.audit.onBegin = () => {
      execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@e", "commit", "--allow-empty", "-m", "sneaky"], {
        cwd: f.checkout,
        stdio: "ignore",
      });
    };
    const result = expectStatus(await f.engine.refresh(f.subject, requester), "blocked");
    expect(result.code).toBe("stale");
    expect(await f.head()).not.toBe(before);
    expect(f.audit.finished.at(-1)).toMatchObject({ outcome: "blocked", success: false });
  });

  test("a source that changed since the workspace was linked blocks source-targeted work", async () => {
    const f = await createFixture();
    f.subject.identityConflict = "acme/repo -> other/repo";
    const result = expectStatus(await f.engine.refresh(f.subject, requester), "blocked");
    expect(result.code).toBe("source-identity-changed");
    expect(result.guidance).toContain("Open the pull request again");
  });

  test("rebase fetches the target from the TARGET repository even when origin is another repository", async () => {
    const f = await createFixture();
    const other = path.join(f.root, "fork.git");
    await git(f.root, ["clone", "--bare", f.remote, other]);
    await git(f.checkout, ["remote", "set-url", "origin", other]);
    await git(f.seed, ["checkout", "main"]);
    await writeFile(path.join(f.seed, "main-only.txt"), "m\n");
    await git(f.seed, ["add", "."]);
    await git(f.seed, ["commit", "-m", "main moves"]);
    await git(f.seed, ["push", "origin", "main"]);
    const targetSha = await git(f.seed, ["rev-parse", "HEAD"]);
    f.subject.targetRemoteUrl = f.remote;

    const first = expectStatus(await f.engine.rebase(f.subject, requester), "confirm-required");
    expect(first.proposal.facts).toMatchObject({ targetSha });
    expectStatus(await f.engine.rebase(f.subject, requester, { proposalId: first.proposal.proposalId }), "rebased");
    expect(await git(f.checkout, ["merge-base", "--is-ancestor", targetSha, "HEAD"]).then(() => true)).toBe(true);
  });

  test("an agent's push only describes itself first; the continuation must name that proposal", async () => {
    const f = await createFixture();
    const mine = await f.commitLocal("mine");
    const first = expectStatus(
      await f.engine.push(f.subject, requester, { requireProposal: true }),
      "confirm-required",
    );
    expect(first.proposal.kind).toBe("push");
    expect(first.proposal.facts).toMatchObject({ headSha: mine });
    expect(await f.remoteSha()).not.toBe(mine);

    // HEAD moves while the user is being asked: the answer no longer applies.
    await f.commitLocal("one more", "more.txt");
    const stale = expectStatus(
      await f.engine.push(f.subject, requester, {
        requireProposal: true,
        confirmation: { proposalId: first.proposal.proposalId },
      }),
      "confirm-required",
    );
    expect(stale.stale).toBe(true);

    expectStatus(
      await f.engine.push(f.subject, requester, {
        requireProposal: true,
        confirmation: { proposalId: stale.proposal.proposalId },
      }),
      "pushed",
    );
    expect(await f.remoteSha()).toBe(await f.head());
  });

  test("an agent's force push is always proposed first, even when the server is still at the baseline", async () => {
    const f = await createFixture();
    f.subject.baselineSha = await f.head();
    await git(f.checkout, ["reset", "--hard", "origin/main"]);
    const rewritten = await f.commitLocal("rewritten", "r.txt");
    const first = expectStatus(
      await f.engine.push(f.subject, requester, { force: true, requireProposal: true }),
      "confirm-required",
    );
    expect(first.proposal.kind).toBe("force-push");
    expect(first.proposal.facts).toMatchObject({ serverMovedSinceBaseline: false });
    expect(await f.remoteSha()).not.toBe(rewritten);
    expectStatus(
      await f.engine.push(f.subject, requester, {
        force: true,
        requireProposal: true,
        confirmation: { proposalId: first.proposal.proposalId },
      }),
      "pushed",
    );
    expect(await f.remoteSha()).toBe(rewritten);
  });
});

describe("baseline proof for a checkout that is being created or attached", () => {
  test("proves the live tip when HEAD equals it", async () => {
    const f = await createFixture();
    expect(await f.engine.proveBaseline(f.subject)).toBe(await f.remoteSha());
  });

  test("an attached author checkout that is ahead is still proven (the live tip is incorporated)", async () => {
    const f = await createFixture({ role: "author" });
    await f.commitLocal("mine");
    expect(await f.engine.proveBaseline(f.subject)).toBe(await f.remoteSha());
  });

  test("a checkout that has not incorporated the live tip is left unknown", async () => {
    const f = await createFixture();
    await f.commitOnRemote("feature 2");
    expect(await f.engine.proveBaseline(f.subject)).toBeNull();
  });

  test("a checkout on the wrong branch is left unknown", async () => {
    const f = await createFixture();
    await git(f.checkout, ["checkout", "-b", "develop", "origin/main"]);
    expect(await f.engine.proveBaseline(f.subject)).toBeNull();
  });
});
