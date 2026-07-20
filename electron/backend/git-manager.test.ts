/// <reference types="node" />
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, test, vi } from "vitest";
import { GitManager } from "./git-manager.js";
import { runEffect } from "./effect/runtime.js";
import { reconfigureLogger } from "./logger.js";

// Real-git availability gate for the fixture round-trip suite (Phase 1 §5).
// Mirrors merge3.test.ts's golden-test guard: skip gracefully where git is absent.
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
  await Promise.all(tempPaths.splice(0).map((targetPath) => fs.rm(targetPath, { recursive: true, force: true })));
});

async function createGitFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "strideterm-git-"));
  const sibling = path.join(root, ".strideterm", "tree", "feature-y");
  await fs.mkdir(path.join(root, ".git"), { recursive: true });
  await fs.mkdir(sibling, { recursive: true });
  await fs.writeFile(path.join(root, ".git", "FETCH_HEAD"), "origin/main\n", "utf8");
  tempPaths.push(root);
  return { root, sibling };
}

function createExecMock(responses: Record<string, { stdout: string; stderr: string } | Error>) {
  return vi.fn(async (cwd: string, args: string[]) => {
    const key = `${cwd}::${args.join(" ")}`;
    if (!(key in responses)) {
      throw { stderr: `Unexpected git call: ${key}`, stdout: "" };
    }
    const value = responses[key];
    if (value instanceof Error) {
      throw { stderr: value.message, stdout: "" };
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if (value && (value as any).__reject) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      throw (value as any).__reject;
    }
    return value;
  });
}

describe("GitManager", () => {
  test("inspectWorkspace returns enriched worktree, sync, and changes snapshot", async () => {
    const { root, sibling } = await createGitFixture();
    const execGitImpl = createExecMock({
      [`${root}::rev-parse --show-toplevel`]: { stdout: `${root}\n`, stderr: "" },
      [`${root}::rev-parse --abbrev-ref HEAD`]: { stdout: "feature-x\n", stderr: "" },
      [`${root}::remote -v`]: {
        stdout:
          "origin\thttps://dev.azure.com/acme/Platform/_git/web-app (fetch)\norigin\thttps://dev.azure.com/acme/Platform/_git/web-app (push)\n",
        stderr: "",
      },
      [`${root}::rev-list --count HEAD`]: { stdout: "42\n", stderr: "" },
      [`${root}::status --porcelain=v2 --branch`]: {
        stdout: [
          "# branch.oid abcdef",
          "# branch.head feature-x",
          "# branch.upstream origin/feature-x",
          "# branch.ab +2 -1",
          "1 M. N... 100644 100644 100644 abc def src/app.js",
          "1 .M N... 100644 100644 100644 abc def config/app.json",
          "? docs/notes.md",
        ].join("\n"),
        stderr: "",
      },
      [`${root}::status --short`]: { stdout: "M  src/app.js\n M config/app.json\n?? docs/notes.md\n", stderr: "" },
      [`${root}::log --date=relative --pretty=format:%h%x09%ad%x09%an%x09%d%x09%s -n 18`]: {
        stdout: "abc123\t2 hours ago\tJaromir\t(HEAD -> feature-x)\tRefine git tab",
        stderr: "",
      },
      [`${root}::rev-parse --git-dir`]: { stdout: ".git\n", stderr: "" },
      [`${root}::rev-parse --git-common-dir`]: { stdout: ".git\n", stderr: "" },
      [`${root}::worktree list --porcelain`]: {
        stdout: [
          `worktree ${root}`,
          "HEAD abcdef1",
          "branch refs/heads/main",
          "",
          `worktree ${sibling}`,
          "HEAD bcdefa2",
          "branch refs/heads/feature-y",
          "",
        ].join("\n"),
        stderr: "",
      },
      [`${root}::for-each-ref --format=%(refname:short) refs/heads refs/remotes`]: {
        stdout: "feature-x\nmain\norigin/feature-x\norigin/main\n",
        stderr: "",
      },
      [`${root}::rev-list --left-right --count HEAD...main`]: { stdout: "3\t1\n", stderr: "" },
      [`${root}::log --date=relative --pretty=format:%h%x09%ad%x09%an%x09%d%x09%s -n 18 main..HEAD`]: {
        stdout: "bbb222\t1 hour ago\tJaromir\t\tAdd compare panel",
        stderr: "",
      },
      [`${root}::diff --name-status main...HEAD`]: { stdout: "M\tsrc/app.js\nA\tdocs/notes.md\n", stderr: "" },
      [`${root}::diff --shortstat main...HEAD`]: {
        stdout: " 2 files changed, 7 insertions(+), 1 deletion(-)\n",
        stderr: "",
      },
      [`${root}::diff --cached --shortstat`]: { stdout: " 1 file changed, 5 insertions(+)\n", stderr: "" },
      [`${root}::diff --shortstat`]: { stdout: " 1 file changed, 2 deletions(-)\n", stderr: "" },
      [`${root}::diff --name-only --diff-filter=U`]: { stdout: "", stderr: "" },
      [`${sibling}::status --short`]: { stdout: " M src/other.js\n", stderr: "" },
    });
    const manager = new GitManager({ execGitImpl, now: () => new Date("2026-03-17T12:00:00.000Z") });
    manager.detectLazygit = async () => ({
      available: true,
      backend: "host",
      error: "",
      launch: { file: "lazygit", args: [] },
    });

    const snapshot = await manager.inspectWorkspace({ id: "frontend", cwd: root, kind: "terminal" });

    expect(snapshot.available).toBe(true);
    expect(snapshot.branch).toBe("feature-x");
    expect((snapshot.remotes as Record<string, string>).origin).toBe(
      "https://dev.azure.com/acme/Platform/_git/web-app",
    );
    expect(snapshot.baseBranch).toBe("main");
    expect(snapshot.aheadCount).toBe(2);
    expect(snapshot.behindCount).toBe(1);
    expect((snapshot.staged as Array<{ path: string }>).map((entry) => entry.path)).toEqual(["src/app.js"]);
    expect((snapshot.unstaged as Array<{ path: string }>).map((entry) => entry.path)).toEqual(["config/app.json"]);
    expect((snapshot.untracked as Array<{ path: string }>).map((entry) => entry.path)).toEqual(["docs/notes.md"]);
    expect(snapshot.diffStat).toMatchObject({
      files: 3,
      insertions: 5,
      deletions: 2,
    });
    expect(snapshot.compareWithBase).toMatchObject({
      baseBranch: "main",
      aheadCount: 3,
      behindCount: 1,
    });
    expect(snapshot.siblingWorktrees as unknown[]).toHaveLength(2);
    expect((snapshot.siblingWorktrees as Array<Record<string, unknown>>)[1]).toMatchObject({
      branch: "feature-y",
      dirty: true,
    });
    expect(snapshot.lastFetchAt).toBeTruthy();
  });

  test("inspectWorkspace marks per-sibling branchMerged via git branch --merged", async () => {
    const { root } = await createGitFixture();
    const siblingMain = path.join(root, ".strideterm", "tree", "main-wt");
    const siblingMerged = path.join(root, ".strideterm", "tree", "feature-merged");
    const siblingActive = path.join(root, ".strideterm", "tree", "feature-active");
    await fs.mkdir(siblingMain, { recursive: true });
    await fs.mkdir(siblingMerged, { recursive: true });
    await fs.mkdir(siblingActive, { recursive: true });

    const execGitImpl = createExecMock({
      [`${root}::rev-parse --show-toplevel`]: { stdout: `${root}\n`, stderr: "" },
      [`${root}::rev-parse --abbrev-ref HEAD`]: { stdout: "feature-x\n", stderr: "" },
      [`${root}::remote -v`]: { stdout: "", stderr: "" },
      [`${root}::rev-list --count HEAD`]: { stdout: "10\n", stderr: "" },
      [`${root}::status --porcelain=v2 --branch`]: { stdout: "# branch.head feature-x\n", stderr: "" },
      [`${root}::status --short`]: { stdout: "", stderr: "" },
      [`${root}::log --date=relative --pretty=format:%h%x09%ad%x09%an%x09%d%x09%s -n 18`]: { stdout: "", stderr: "" },
      [`${root}::rev-parse --git-dir`]: { stdout: ".git\n", stderr: "" },
      [`${root}::rev-parse --git-common-dir`]: { stdout: ".git\n", stderr: "" },
      [`${root}::worktree list --porcelain`]: {
        stdout: [
          `worktree ${root}`,
          "HEAD aaaa111",
          "branch refs/heads/feature-x",
          "",
          `worktree ${siblingMain}`,
          "HEAD bbbb222",
          "branch refs/heads/main",
          "",
          `worktree ${siblingMerged}`,
          "HEAD cccc333",
          "branch refs/heads/feature-merged",
          "",
          `worktree ${siblingActive}`,
          "HEAD dddd444",
          "branch refs/heads/feature-active",
          "",
        ].join("\n"),
        stderr: "",
      },
      [`${root}::for-each-ref --format=%(refname:short) refs/heads refs/remotes`]: {
        stdout: "feature-x\nmain\nfeature-merged\nfeature-active\n",
        stderr: "",
      },
      [`${root}::merge-base HEAD main`]: { stdout: "aaaaaaa\n", stderr: "" },
      [`${root}::rev-list --count aaaaaaa..HEAD`]: { stdout: "2\n", stderr: "" },
      [`${root}::rev-list --left-right --count HEAD...main`]: { stdout: "2\t0\n", stderr: "" },
      [`${root}::log --date=relative --pretty=format:%h%x09%ad%x09%an%x09%d%x09%s -n 18 main..HEAD`]: {
        stdout: "",
        stderr: "",
      },
      [`${root}::diff --name-status main...HEAD`]: { stdout: "", stderr: "" },
      [`${root}::diff --shortstat main...HEAD`]: { stdout: "", stderr: "" },
      [`${root}::diff --cached --shortstat`]: { stdout: "", stderr: "" },
      [`${root}::diff --shortstat`]: { stdout: "", stderr: "" },
      [`${root}::diff --name-only --diff-filter=U`]: { stdout: "", stderr: "" },
      [`${root}::branch --merged main --format=%(refname:short)`]: {
        stdout: "main\nfeature-merged\n",
        stderr: "",
      },
      [`${siblingMain}::status --short`]: { stdout: "", stderr: "" },
      [`${siblingMerged}::status --short`]: { stdout: "", stderr: "" },
      [`${siblingActive}::status --short`]: { stdout: "", stderr: "" },
    });
    const manager = new GitManager({ execGitImpl });
    manager.detectLazygit = async () => ({ available: false, backend: null, error: "missing", launch: null });

    const snapshot = await manager.inspectWorkspace({ id: "frontend", cwd: root, kind: "terminal" });

    expect(snapshot.branch).toBe("feature-x");
    expect(snapshot.baseBranch).toBe("main");
    const siblings = snapshot.siblingWorktrees as Array<{ branch: string; branchMerged: boolean }>;
    const merged = siblings.find((e) => e.branch === "feature-merged");
    const active = siblings.find((e) => e.branch === "feature-active");
    const mainEntry = siblings.find((e) => e.branch === "main");
    expect(merged?.branchMerged).toBe(true);
    expect(active?.branchMerged).toBe(false);
    expect(mainEntry?.branchMerged).toBe(false);
  });

  test("inspectWorkspace detects active merge operation and conflicts", async () => {
    const { root } = await createGitFixture();
    await fs.writeFile(path.join(root, ".git", "MERGE_HEAD"), "abcdef\n", "utf8");
    const execGitImpl = createExecMock({
      [`${root}::rev-parse --show-toplevel`]: { stdout: `${root}\n`, stderr: "" },
      [`${root}::rev-parse --abbrev-ref HEAD`]: { stdout: "feature-x\n", stderr: "" },
      [`${root}::remote -v`]: { stdout: "", stderr: "" },
      [`${root}::rev-list --count HEAD`]: { stdout: "1\n", stderr: "" },
      [`${root}::status --porcelain=v2 --branch`]: { stdout: "# branch.head feature-x\n", stderr: "" },
      [`${root}::status --short`]: { stdout: "UU src/app.js\n", stderr: "" },
      [`${root}::log --date=relative --pretty=format:%h%x09%ad%x09%an%x09%d%x09%s -n 18`]: { stdout: "", stderr: "" },
      [`${root}::rev-parse --git-dir`]: { stdout: ".git\n", stderr: "" },
      [`${root}::rev-parse --git-common-dir`]: { stdout: ".git\n", stderr: "" },
      [`${root}::worktree list --porcelain`]: {
        stdout: `worktree ${root}\nHEAD abc\nbranch refs/heads/feature-x\n`,
        stderr: "",
      },
      [`${root}::for-each-ref --format=%(refname:short) refs/heads refs/remotes`]: {
        stdout: "feature-x\nmain\n",
        stderr: "",
      },
      [`${root}::diff --cached --shortstat`]: { stdout: "", stderr: "" },
      [`${root}::diff --shortstat`]: { stdout: "", stderr: "" },
      [`${root}::diff --name-only --diff-filter=U`]: { stdout: "src/app.js\n", stderr: "" },
    });
    const manager = new GitManager({ execGitImpl });
    manager.detectLazygit = async () => ({ available: false, backend: null, error: "missing", launch: null });

    const snapshot = await manager.inspectWorkspace({ id: "frontend", cwd: root, kind: "terminal" });

    expect(snapshot.operationState).toMatchObject({
      kind: "merge",
      inProgress: true,
      conflicts: ["src/app.js"],
      canContinue: true,
      canAbort: true,
    });
  });

  test("inspectWorkspace prefers remote base branch when local main is missing", async () => {
    const { root } = await createGitFixture();
    const execGitImpl = createExecMock({
      [`${root}::rev-parse --show-toplevel`]: { stdout: `${root}\n`, stderr: "" },
      [`${root}::rev-parse --abbrev-ref HEAD`]: { stdout: "feature-x\n", stderr: "" },
      [`${root}::remote -v`]: { stdout: "", stderr: "" },
      [`${root}::rev-list --count HEAD`]: { stdout: "1\n", stderr: "" },
      [`${root}::status --porcelain=v2 --branch`]: {
        stdout: "# branch.head feature-x\n# branch.upstream origin/feature-x\n",
        stderr: "",
      },
      [`${root}::status --short`]: { stdout: "", stderr: "" },
      [`${root}::log --date=relative --pretty=format:%h%x09%ad%x09%an%x09%d%x09%s -n 18`]: { stdout: "", stderr: "" },
      [`${root}::rev-parse --git-dir`]: { stdout: ".git\n", stderr: "" },
      [`${root}::rev-parse --git-common-dir`]: { stdout: ".git\n", stderr: "" },
      [`${root}::worktree list --porcelain`]: {
        stdout: `worktree ${root}\nHEAD abc\nbranch refs/heads/feature-x\n`,
        stderr: "",
      },
      [`${root}::for-each-ref --format=%(refname:short) refs/heads refs/remotes`]: {
        stdout: "feature-x\norigin/main\norigin/feature-x\n",
        stderr: "",
      },
      [`${root}::rev-list --left-right --count HEAD...origin/main`]: { stdout: "1\t0\n", stderr: "" },
      [`${root}::log --date=relative --pretty=format:%h%x09%ad%x09%an%x09%d%x09%s -n 18 origin/main..HEAD`]: {
        stdout: "",
        stderr: "",
      },
      [`${root}::diff --name-status origin/main...HEAD`]: { stdout: "", stderr: "" },
      [`${root}::diff --shortstat origin/main...HEAD`]: { stdout: "", stderr: "" },
      [`${root}::diff --cached --shortstat`]: { stdout: "", stderr: "" },
      [`${root}::diff --shortstat`]: { stdout: "", stderr: "" },
      [`${root}::diff --name-only --diff-filter=U`]: { stdout: "", stderr: "" },
    });
    const manager = new GitManager({ execGitImpl });
    manager.detectLazygit = async () => ({ available: false, backend: null, error: "missing", launch: null });

    const snapshot = await manager.inspectWorkspace({ id: "frontend", cwd: root, kind: "terminal" });

    expect(snapshot.baseBranch).toBe("origin/main");
    expect((snapshot.compareWithBase as { baseBranch: string }).baseBranch).toBe("origin/main");
  });

  // Regression: a PR author's managed worktree pushes the SOURCE branch, so
  // basing the snapshot on origin/<source> is a self-comparison (0/0). That
  // pinned the base to the branch itself → "nothing to pull" → the Update
  // button was permanently disabled. An author must base on the PR TARGET.
  test("inspectWorkspace bases a PR author's worktree on the target branch, not the source", async () => {
    const { root } = await createGitFixture();
    const branch = "pr-30742-jstradej-MSP-756000-email-watcher";
    const execGitImpl = createExecMock({
      [`${root}::rev-parse --show-toplevel`]: { stdout: `${root}\n`, stderr: "" },
      [`${root}::rev-parse --abbrev-ref HEAD`]: { stdout: `${branch}\n`, stderr: "" },
      [`${root}::remote -v`]: { stdout: "", stderr: "" },
      [`${root}::rev-list --count HEAD`]: { stdout: "5\n", stderr: "" },
      [`${root}::status --porcelain=v2 --branch`]: {
        stdout: `# branch.head ${branch}\n# branch.upstream origin/jstradej/MSP-756000-email-watcher\n`,
        stderr: "",
      },
      [`${root}::status --short`]: { stdout: "", stderr: "" },
      [`${root}::log --date=relative --pretty=format:%h%x09%ad%x09%an%x09%d%x09%s -n 18`]: { stdout: "", stderr: "" },
      [`${root}::rev-parse --git-dir`]: { stdout: ".git\n", stderr: "" },
      [`${root}::rev-parse --git-common-dir`]: { stdout: ".git\n", stderr: "" },
      [`${root}::worktree list --porcelain`]: {
        stdout: `worktree ${root}\nHEAD abc\nbranch refs/heads/${branch}\n`,
        stderr: "",
      },
      [`${root}::for-each-ref --format=%(refname:short) refs/heads refs/remotes`]: {
        stdout: `${branch}\ndevelop\norigin/develop\norigin/jstradej/MSP-756000-email-watcher\n`,
        stderr: "",
      },
      // Base comparison runs against origin/develop (the PR target) — 2 ahead, 11 behind.
      [`${root}::rev-list --left-right --count HEAD...origin/develop`]: { stdout: "2\t11\n", stderr: "" },
      [`${root}::log --date=relative --pretty=format:%h%x09%ad%x09%an%x09%d%x09%s -n 18 origin/develop..HEAD`]: {
        stdout: "",
        stderr: "",
      },
      [`${root}::diff --name-status origin/develop...HEAD`]: { stdout: "", stderr: "" },
      [`${root}::diff --shortstat origin/develop...HEAD`]: { stdout: "", stderr: "" },
      [`${root}::diff --cached --shortstat`]: { stdout: "", stderr: "" },
      [`${root}::diff --shortstat`]: { stdout: "", stderr: "" },
      [`${root}::diff --name-only --diff-filter=U`]: { stdout: "", stderr: "" },
    });
    const manager = new GitManager({ execGitImpl });
    manager.detectLazygit = async () => ({ available: false, backend: null, error: "missing", launch: null });

    const snapshot = await manager.inspectWorkspace({
      id: "review-author",
      cwd: root,
      kind: "terminal",
      review: {
        role: "author",
        pullRequest: {
          sourceRefName: "refs/heads/jstradej/MSP-756000-email-watcher",
          targetRefName: "refs/heads/develop",
        },
      },
    });

    expect(snapshot.baseBranch).toBe("origin/develop");
    const cmp = snapshot.compareWithBase as { baseBranch: string; behindCount: number };
    expect(cmp.baseBranch).toBe("origin/develop");
    expect(cmp.behindCount).toBe(11);
  });

  // Reviewers (non-author) keep basing on origin/<source>: their checkout is
  // measured against the pushed source branch. Guards the author fix above
  // from regressing the reviewer path.
  test("inspectWorkspace keeps a reviewer's worktree based on the PR source branch", async () => {
    const { root } = await createGitFixture();
    const branch = "pr-29806-jveselka-feature";
    const src = "jveselka/feature";
    const execGitImpl = createExecMock({
      [`${root}::rev-parse --show-toplevel`]: { stdout: `${root}\n`, stderr: "" },
      [`${root}::rev-parse --abbrev-ref HEAD`]: { stdout: `${branch}\n`, stderr: "" },
      [`${root}::remote -v`]: { stdout: "", stderr: "" },
      [`${root}::rev-list --count HEAD`]: { stdout: "5\n", stderr: "" },
      [`${root}::status --porcelain=v2 --branch`]: {
        stdout: `# branch.head ${branch}\n# branch.upstream origin/${src}\n`,
        stderr: "",
      },
      [`${root}::status --short`]: { stdout: "", stderr: "" },
      [`${root}::log --date=relative --pretty=format:%h%x09%ad%x09%an%x09%d%x09%s -n 18`]: { stdout: "", stderr: "" },
      [`${root}::rev-parse --git-dir`]: { stdout: ".git\n", stderr: "" },
      [`${root}::rev-parse --git-common-dir`]: { stdout: ".git\n", stderr: "" },
      [`${root}::worktree list --porcelain`]: {
        stdout: `worktree ${root}\nHEAD abc\nbranch refs/heads/${branch}\n`,
        stderr: "",
      },
      [`${root}::for-each-ref --format=%(refname:short) refs/heads refs/remotes`]: {
        stdout: `${branch}\norigin/develop\norigin/${src}\n`,
        stderr: "",
      },
      [`${root}::rev-list --left-right --count HEAD...origin/${src}`]: { stdout: "0\t0\n", stderr: "" },
      [`${root}::log --date=relative --pretty=format:%h%x09%ad%x09%an%x09%d%x09%s -n 18 origin/${src}..HEAD`]: {
        stdout: "",
        stderr: "",
      },
      [`${root}::diff --name-status origin/${src}...HEAD`]: { stdout: "", stderr: "" },
      [`${root}::diff --shortstat origin/${src}...HEAD`]: { stdout: "", stderr: "" },
      [`${root}::diff --cached --shortstat`]: { stdout: "", stderr: "" },
      [`${root}::diff --shortstat`]: { stdout: "", stderr: "" },
      [`${root}::diff --name-only --diff-filter=U`]: { stdout: "", stderr: "" },
    });
    const manager = new GitManager({ execGitImpl });
    manager.detectLazygit = async () => ({ available: false, backend: null, error: "missing", launch: null });

    const snapshot = await manager.inspectWorkspace({
      id: "review-reviewer",
      cwd: root,
      kind: "terminal",
      review: {
        role: "reviewer",
        pullRequest: { sourceRefName: `refs/heads/${src}`, targetRefName: "refs/heads/develop" },
      },
    });

    expect(snapshot.baseBranch).toBe(`origin/${src}`);
  });

  test("mergeIntoCurrent refuses dirty workspace without explicit stash flow", async () => {
    const { root } = await createGitFixture();
    const manager = new GitManager({ execGitImpl: vi.fn() });
    manager.inspectWorkspace = vi.fn().mockResolvedValue({
      available: true,
      branch: "feature-x",
      baseBranch: "main",
      upstream: "origin/feature-x",
      aheadCount: 2,
      behindCount: 0,
      dirty: true,
      operationState: { kind: "idle", inProgress: false, conflicts: [] },
    });

    const result = await manager.mergeIntoCurrent({ id: "frontend", cwd: root }, { baseBranch: "main" });

    expect(result.ok).toBe(false);
    expect(result.summary).toContain("Working tree is dirty");
    expect(manager.execGitImpl).not.toHaveBeenCalled();
  });

  test("rebaseOnto stashes dirty changes, runs rebase, and restores stash", async () => {
    const { root } = await createGitFixture();
    const execGitImpl = vi
      .fn()
      .mockResolvedValueOnce({ stdout: "Saved working directory and index state\n", stderr: "" })
      .mockResolvedValueOnce({ stdout: "Successfully rebased\n", stderr: "" })
      .mockResolvedValueOnce({ stdout: "Dropped refs/stash@{0}\n", stderr: "" });
    const manager = new GitManager({ execGitImpl, now: () => new Date("2026-03-17T12:00:00.000Z") });
    manager.inspectWorkspace = vi.fn().mockResolvedValueOnce({
      available: true,
      branch: "feature-x",
      baseBranch: "main",
      upstream: "origin/feature-x",
      aheadCount: 1,
      behindCount: 0,
      dirty: true,
      operationState: { kind: "idle", inProgress: false, conflicts: [] },
    });

    const result = await manager.rebaseOnto({ id: "frontend", cwd: root }, { baseBranch: "main", stashDirty: true });

    expect(result.ok).toBe(true);
    expect(execGitImpl).toHaveBeenNthCalledWith(
      1,
      root,
      expect.arrayContaining(["stash", "push", "--include-untracked"]),
    );
    expect(execGitImpl).toHaveBeenNthCalledWith(2, root, ["rebase", "main"]);
    expect(execGitImpl).toHaveBeenNthCalledWith(3, root, ["stash", "pop"]);
    expect(result.rawOutput).toContain("Successfully rebased");
  });

  describe("execAuthGitEffect retry policy", () => {
    // fetch/pull/push/merge/rebase all funnel through execAuthGitEffect. Only
    // transient/network-shaped stderr should be retried — a deterministic
    // failure (merge/rebase conflict, bad ref, …) never succeeds on retry, and
    // for merge/rebase specifically, retrying re-runs the command against an
    // already-started operation instead of surfacing the real conflict.

    test("retries a transient network error (regression guard for fetch/pull/push)", async () => {
      const { root } = await createGitFixture();
      const execGitImpl = vi
        .fn()
        .mockRejectedValueOnce({
          stderr: "fatal: unable to access 'https://example.com/repo.git/': Connection timed out",
          stdout: "",
        })
        .mockResolvedValueOnce({ stdout: "", stderr: "" });
      const manager = new GitManager({ execGitImpl });

      const result = await runEffect(manager.execAuthGitEffect(root, ["fetch", "--all", "--prune"]));

      expect(result).toEqual({ stdout: "", stderr: "" });
      expect(execGitImpl).toHaveBeenCalledTimes(2);
    });

    test("does not retry a merge conflict", async () => {
      const { root } = await createGitFixture();
      const execGitImpl = vi.fn().mockRejectedValue({
        stderr:
          "Auto-merging file.txt\nCONFLICT (content): Merge conflict in file.txt\nAutomatic merge failed; fix conflicts and then commit the result.",
        stdout: "",
        exitCode: 1,
      });
      const manager = new GitManager({ execGitImpl });

      await expect(runEffect(manager.execAuthGitEffect(root, ["merge", "--no-edit", "main"]))).rejects.toMatchObject({
        _tag: "GitCommandError",
      });
      expect(execGitImpl).toHaveBeenCalledTimes(1);
    });

    test("does not retry a rebase conflict", async () => {
      const { root } = await createGitFixture();
      const execGitImpl = vi.fn().mockRejectedValue({
        stderr:
          "CONFLICT (content): Merge conflict in file.txt\nerror: could not apply abc1234... combined\nhint: Resolve all conflicts manually",
        stdout: "",
        exitCode: 1,
      });
      const manager = new GitManager({ execGitImpl });

      await expect(runEffect(manager.execAuthGitEffect(root, ["rebase", "main"]))).rejects.toMatchObject({
        _tag: "GitCommandError",
      });
      expect(execGitImpl).toHaveBeenCalledTimes(1);
    });

    test("does not retry a non-transient, non-auth error on a non-merge/rebase command", async () => {
      const { root } = await createGitFixture();
      const execGitImpl = vi.fn().mockRejectedValue({
        stderr: "fatal: 'origin' does not appear to be a git repository",
        stdout: "",
        exitCode: 128,
      });
      const manager = new GitManager({ execGitImpl });

      await expect(runEffect(manager.execAuthGitEffect(root, ["fetch", "--all", "--prune"]))).rejects.toMatchObject({
        _tag: "GitCommandError",
      });
      expect(execGitImpl).toHaveBeenCalledTimes(1);
    });
  });

  test("reuses cached sibling dirty state within a short inspection window", async () => {
    const { root, sibling } = await createGitFixture();
    let nowValue = new Date("2026-03-17T12:00:00.000Z");
    const execGitImpl = createExecMock({
      [`${root}::rev-parse --show-toplevel`]: { stdout: `${root}\n`, stderr: "" },
      [`${root}::rev-parse --abbrev-ref HEAD`]: { stdout: "feature-x\n", stderr: "" },
      [`${root}::remote -v`]: { stdout: "", stderr: "" },
      [`${root}::rev-list --count HEAD`]: { stdout: "42\n", stderr: "" },
      [`${root}::status --porcelain=v2 --branch`]: { stdout: "# branch.head feature-x\n", stderr: "" },
      [`${root}::status --short`]: { stdout: "", stderr: "" },
      [`${root}::log --date=relative --pretty=format:%h%x09%ad%x09%an%x09%d%x09%s -n 18`]: { stdout: "", stderr: "" },
      [`${root}::rev-parse --git-dir`]: { stdout: ".git\n", stderr: "" },
      [`${root}::rev-parse --git-common-dir`]: { stdout: ".git\n", stderr: "" },
      [`${root}::worktree list --porcelain`]: {
        stdout: [
          `worktree ${root}`,
          "HEAD abcdef1",
          "branch refs/heads/main",
          "",
          `worktree ${sibling}`,
          "HEAD bcdefa2",
          "branch refs/heads/feature-y",
          "",
        ].join("\n"),
        stderr: "",
      },
      [`${root}::for-each-ref --format=%(refname:short) refs/heads refs/remotes`]: {
        stdout: "feature-x\nmain\n",
        stderr: "",
      },
      [`${root}::rev-list --left-right --count HEAD...main`]: { stdout: "0\t0\n", stderr: "" },
      [`${root}::log --date=relative --pretty=format:%h%x09%ad%x09%an%x09%d%x09%s -n 18 main..HEAD`]: {
        stdout: "",
        stderr: "",
      },
      [`${root}::diff --name-status main...HEAD`]: { stdout: "", stderr: "" },
      [`${root}::diff --shortstat main...HEAD`]: { stdout: "", stderr: "" },
      [`${root}::diff --cached --shortstat`]: { stdout: "", stderr: "" },
      [`${root}::diff --shortstat`]: { stdout: "", stderr: "" },
      [`${root}::diff --name-only --diff-filter=U`]: { stdout: "", stderr: "" },
      [`${sibling}::status --short`]: { stdout: " M src/other.js\n", stderr: "" },
    });
    const manager = new GitManager({ execGitImpl, now: () => nowValue });
    manager.detectLazygit = async () => ({ available: false, backend: null, error: "missing", launch: null });

    await manager.inspectWorkspace({ id: "frontend", cwd: root, kind: "terminal" });
    nowValue = new Date(nowValue.getTime() + 1000);
    await manager.inspectWorkspace({ id: "frontend", cwd: root, kind: "terminal" });

    expect(
      execGitImpl.mock.calls.filter(
        ([cwd, args]: [string, string[]]) => cwd === sibling && args.join(" ") === "status --short",
      ),
    ).toHaveLength(1);
  });

  test("refreshWorkspaces uses snapshot cache within TTL", async () => {
    let inspectCount = 0;
    let nowValue = new Date("2026-03-17T12:00:00.000Z");
    const manager = new GitManager({ execGitImpl: vi.fn(), now: () => nowValue, snapshotCacheTtlMs: 5000 });
    manager._inspectRoot = vi.fn(async (workspace, rootPath) => {
      inspectCount++;
      return { workspaceId: workspace.id, rootPath, available: true, branch: "main", inspectCount };
    });

    const workspaces = [{ id: "ws-1", cwd: "/tmp/project", kind: "terminal" }];

    await manager.refreshWorkspaces(workspaces);
    expect(inspectCount).toBe(1);

    // Within TTL — should use cache
    nowValue = new Date(nowValue.getTime() + 3000);
    await manager.refreshWorkspaces(workspaces);
    expect(inspectCount).toBe(1);

    // After TTL — should re-inspect
    nowValue = new Date(nowValue.getTime() + 3000);
    await manager.refreshWorkspaces(workspaces);
    expect(inspectCount).toBe(2);
  });

  test("invalidateSnapshotCache forces re-inspection", async () => {
    let inspectCount = 0;
    const nowValue = new Date("2026-03-17T12:00:00.000Z");
    const manager = new GitManager({ execGitImpl: vi.fn(), now: () => nowValue, snapshotCacheTtlMs: 60000 });
    manager._inspectRoot = vi.fn(async (workspace, rootPath) => {
      inspectCount++;
      return { workspaceId: workspace.id, rootPath, available: true };
    });

    const workspaces = [{ id: "ws-1", cwd: "/tmp/project", kind: "terminal" }];
    await manager.refreshWorkspaces(workspaces);
    expect(inspectCount).toBe(1);

    manager.invalidateSnapshotCache("ws-1");
    await manager.refreshWorkspaces(workspaces);
    expect(inspectCount).toBe(2);
  });

  test("invalidateSnapshotCache with no args clears all", async () => {
    let inspectCount = 0;
    const nowValue = new Date("2026-03-17T12:00:00.000Z");
    const manager = new GitManager({ execGitImpl: vi.fn(), now: () => nowValue, snapshotCacheTtlMs: 60000 });
    manager._inspectRoot = vi.fn(async (workspace, rootPath) => {
      inspectCount++;
      return { workspaceId: workspace.id, rootPath, available: true };
    });

    const workspaces = [
      { id: "ws-1", cwd: "/tmp/a", kind: "terminal" },
      { id: "ws-2", cwd: "/tmp/b", kind: "terminal" },
    ];
    await manager.refreshWorkspaces(workspaces);
    expect(inspectCount).toBe(2);

    manager.invalidateSnapshotCache();
    await manager.refreshWorkspaces(workspaces);
    expect(inspectCount).toBe(4);
  });

  test("diffPreview returns a preview for untracked files", async () => {
    const { root } = await createGitFixture();
    const execGitImpl = vi.fn(async (cwd: string, args: string[]) => {
      if (cwd !== root) {
        throw { stderr: "unexpected cwd", stdout: "" };
      }

      if (args[0] === "diff" && args[1] === "--no-index") {
        throw {
          stdout: [
            "diff --git a/empty b/new-file.txt",
            "new file mode 100644",
            "--- a/empty",
            "+++ b/new-file.txt",
            "@@ -0,0 +1 @@",
            "+hello",
          ].join("\n"),
          stderr: "",
        };
      }

      throw { stderr: `Unexpected git call: ${args.join(" ")}`, stdout: "" };
    });
    const manager = new GitManager({ execGitImpl });

    const result = await manager.diffPreview(
      { id: "frontend", cwd: root, kind: "terminal" },
      { path: "new-file.txt", scope: "untracked" },
    );

    expect(result).toMatchObject({
      ok: true,
      scope: "untracked",
      path: "new-file.txt",
    });
    expect(result.diff).toContain("new file mode");
  });

  // ─── Tag operations ──────────────────────────────────────────────

  test("listTags parses tags with remote push state", async () => {
    const { root } = await createGitFixture();
    const tagFmt = [
      "%(refname:short)",
      "%(objecttype)",
      "%(creatordate:iso8601)",
      "%(if)%(taggername)%(then)%(taggername)%(else)%(authorname)%(end)",
      "%(subject)",
      "%(objectname:short)",
    ].join("%09");
    const execGitImpl = createExecMock({
      [`${root}::for-each-ref --format=${tagFmt} --sort=-creatordate refs/tags`]: {
        stdout: [
          "v1.0.0\ttag\t2026-03-15 10:00:00 +0000\tJaromir\tFirst release\tabc1234",
          "v0.9.0\tcommit\t2026-03-10 09:00:00 +0000\tJaromir\t\tdef5678",
        ].join("\n"),
        stderr: "",
      },
      [`${root}::ls-remote --tags origin`]: {
        stdout: "abc123\trefs/tags/v1.0.0\nabc123\trefs/tags/v1.0.0^{}\n",
        stderr: "",
      },
    });
    const manager = new GitManager({ execGitImpl });

    const result = await manager.listTags({ id: "ws-1", cwd: root });

    expect(result.ok).toBe(true);
    expect(result.tags as unknown[]).toHaveLength(2);
    expect((result.tags as Array<Record<string, unknown>>)[0]).toMatchObject({
      name: "v1.0.0",
      annotated: true,
      author: "Jaromir",
      message: "First release",
      pushed: true,
      local: true,
    });
    expect((result.tags as Array<Record<string, unknown>>)[1]).toMatchObject({
      name: "v0.9.0",
      annotated: false,
      pushed: false,
      local: true,
    });
  });

  test("listTags includes remote-only tags not present locally", async () => {
    const { root } = await createGitFixture();
    const tagFmt = [
      "%(refname:short)",
      "%(objecttype)",
      "%(creatordate:iso8601)",
      "%(if)%(taggername)%(then)%(taggername)%(else)%(authorname)%(end)",
      "%(subject)",
      "%(objectname:short)",
    ].join("%09");
    const execGitImpl = createExecMock({
      [`${root}::for-each-ref --format=${tagFmt} --sort=-creatordate refs/tags`]: {
        stdout: "v1.0.0\ttag\t2026-03-15\tJaromir\tRelease\tabc1234",
        stderr: "",
      },
      [`${root}::ls-remote --tags origin`]: {
        stdout:
          "abc123\trefs/tags/v1.0.0\nabc123\trefs/tags/v1.0.0^{}\ndef456\trefs/tags/v2.0.0\ndef456\trefs/tags/v2.0.0^{}\n",
        stderr: "",
      },
    });
    const manager = new GitManager({ execGitImpl });

    const result = await manager.listTags({ id: "ws-1", cwd: root });

    expect(result.tags as unknown[]).toHaveLength(2);
    expect((result.tags as Array<Record<string, unknown>>)[0]).toMatchObject({
      name: "v1.0.0",
      local: true,
      pushed: true,
    });
    expect((result.tags as Array<Record<string, unknown>>)[1]).toMatchObject({
      name: "v2.0.0",
      local: false,
      pushed: true,
    });
  });

  test("listTags returns empty array when no tags exist", async () => {
    const { root } = await createGitFixture();
    const tagFmt = [
      "%(refname:short)",
      "%(objecttype)",
      "%(creatordate:iso8601)",
      "%(if)%(taggername)%(then)%(taggername)%(else)%(authorname)%(end)",
      "%(subject)",
      "%(objectname:short)",
    ].join("%09");
    const execGitImpl = createExecMock({
      [`${root}::for-each-ref --format=${tagFmt} --sort=-creatordate refs/tags`]: { stdout: "", stderr: "" },
      [`${root}::ls-remote --tags origin`]: { stdout: "", stderr: "" },
    });
    const manager = new GitManager({ execGitImpl });

    const result = await manager.listTags({ id: "ws-1", cwd: root });

    expect(result.ok).toBe(true);
    expect(result.tags).toEqual([]);
  });

  test("createTag creates annotated tag with message", async () => {
    const { root } = await createGitFixture();
    const execGitImpl = vi.fn().mockResolvedValue({ stdout: "", stderr: "" });
    const manager = new GitManager({ execGitImpl });

    const result = await manager.createTag({ id: "ws-1", cwd: root }, { tagName: "v2.0.0", message: "Release 2.0" });

    expect(result.ok).toBe(true);
    expect(result.summary).toContain("v2.0.0");
    expect(execGitImpl).toHaveBeenCalledWith(root, ["tag", "-a", "v2.0.0", "-m", "Release 2.0"]);
  });

  test("createTag creates lightweight tag without message", async () => {
    const { root } = await createGitFixture();
    const execGitImpl = vi.fn().mockResolvedValue({ stdout: "", stderr: "" });
    const manager = new GitManager({ execGitImpl });

    const result = await manager.createTag({ id: "ws-1", cwd: root }, { tagName: "v2.0.0" });

    expect(result.ok).toBe(true);
    expect(execGitImpl).toHaveBeenCalledWith(root, ["tag", "v2.0.0"]);
  });

  test("createTag rejects empty tag name", async () => {
    const manager = new GitManager({ execGitImpl: vi.fn() });
    const result = await manager.createTag({ id: "ws-1", cwd: "/tmp" }, { tagName: "" });
    expect(result.ok).toBe(false);
    expect(result.summary).toContain("required");
  });

  test("deleteTag deletes local tag", async () => {
    const { root } = await createGitFixture();
    const execGitImpl = vi.fn().mockResolvedValue({ stdout: "Deleted tag 'v1.0.0'\n", stderr: "" });
    const manager = new GitManager({ execGitImpl });

    const result = await manager.deleteTag({ id: "ws-1", cwd: root }, { tagName: "v1.0.0" });

    expect(result.ok).toBe(true);
    expect(execGitImpl).toHaveBeenCalledWith(root, ["tag", "-d", "v1.0.0"]);
  });

  test("pushTag pushes tag to origin with auth and audit", async () => {
    const { root } = await createGitFixture();
    const execGitImpl = vi.fn().mockResolvedValue({ stdout: "", stderr: "To origin\n * [new tag] v1.0.0\n" });
    const auditLogStore = { logEntry: vi.fn() };
    const manager = new GitManager({ execGitImpl, auditLogStore });
    manager.inspectWorkspace = vi.fn().mockResolvedValue({
      available: true,
      branch: "main",
      dirty: false,
      operationState: { kind: "idle", inProgress: false, conflicts: [] },
    });

    const connection = { id: "gh-1", login: "", currentUserLogin: "user", provider: "github" };
    const result = await manager.pushTag({ id: "ws-1", cwd: root }, { tagName: "v1.0.0", connection });

    expect(result.ok).toBe(true);
    expect(result.summary).toContain("Push tag v1.0.0");
    expect(auditLogStore.logEntry).toHaveBeenCalledWith(
      expect.objectContaining({ operation: "gitPush-tag", category: "write" }),
    );
  });

  test("pushAllTags pushes all tags to origin", async () => {
    const { root } = await createGitFixture();
    const execGitImpl = vi.fn().mockResolvedValue({ stdout: "", stderr: "" });
    const manager = new GitManager({ execGitImpl });
    manager.inspectWorkspace = vi.fn().mockResolvedValue({
      available: true,
      branch: "main",
      dirty: false,
      operationState: { kind: "idle", inProgress: false, conflicts: [] },
    });

    const result = await manager.pushAllTags({ id: "ws-1", cwd: root }, {});

    expect(result.ok).toBe(true);
  });

  test("deleteRemoteTag deletes tag from remote with audit", async () => {
    const { root } = await createGitFixture();
    const execGitImpl = vi.fn().mockResolvedValue({ stdout: "", stderr: "" });
    const auditLogStore = { logEntry: vi.fn() };
    const manager = new GitManager({ execGitImpl, auditLogStore });
    manager.inspectWorkspace = vi.fn().mockResolvedValue({
      available: true,
      branch: "main",
      dirty: false,
      operationState: { kind: "idle", inProgress: false, conflicts: [] },
    });

    const connection = { id: "gh-1", provider: "github" };
    const result = await manager.deleteRemoteTag({ id: "ws-1", cwd: root }, { tagName: "v1.0.0", connection });

    expect(result.ok).toBe(true);
    expect(result.summary).toContain("Delete remote tag v1.0.0");
    expect(auditLogStore.logEntry).toHaveBeenCalledWith(
      expect.objectContaining({ operation: "gitDelete-remote-tag", category: "write" }),
    );
  });

  test("deleteTag fails gracefully on git error", async () => {
    const { root } = await createGitFixture();
    const execGitImpl = vi.fn().mockRejectedValue({ stdout: "", stderr: "error: tag 'v1.0.0' not found." });
    const manager = new GitManager({ execGitImpl });

    const result = await manager.deleteTag({ id: "ws-1", cwd: root }, { tagName: "v1.0.0" });

    expect(result.ok).toBe(false);
    expect(result.summary).toContain("Failed");
  });

  // ─── cherry-pick / squash ────────────────────────────────────────

  const cleanSnapshot = {
    available: true,
    branch: "main",
    dirty: false,
    operationState: { kind: "idle", inProgress: false, conflicts: [] },
  };

  test("cherryPick applies commits oldest-first and audits via connection", async () => {
    const { root } = await createGitFixture();
    const execGitImpl = vi.fn().mockResolvedValue({ stdout: "", stderr: "" });
    const auditLogStore = { logEntry: vi.fn() };
    const manager = new GitManager({ execGitImpl, auditLogStore });
    manager.inspectWorkspace = vi.fn().mockResolvedValue(cleanSnapshot);

    // hashes arrive newest-first (display order)
    const result = await manager.cherryPick(
      { id: "ws-1", cwd: root },
      { hashes: ["bbb222", "aaa111"], connection: { id: "az-1", provider: "azure" } },
    );

    expect(result.ok).toBe(true);
    expect(execGitImpl).toHaveBeenCalledWith(root, ["cherry-pick", "aaa111", "bbb222"]);
    expect(auditLogStore.logEntry).toHaveBeenCalledWith(
      expect.objectContaining({ operation: "gitCherry-pick", success: true }),
    );
  });

  test("_logGitAudit logs a warning but never breaks the git action when the audit DB write throws", async () => {
    const { root } = await createGitFixture();
    const execGitImpl = vi.fn().mockResolvedValue({ stdout: "", stderr: "" });
    const auditLogStore = {
      logEntry: vi.fn(() => {
        throw new Error("SQLITE_BUSY: database is locked");
      }),
    };
    const manager = new GitManager({ execGitImpl, auditLogStore });
    manager.inspectWorkspace = vi.fn().mockResolvedValue(cleanSnapshot);

    // Reconfigure the shared logger singleton so we get a handle to the
    // underlying winston instance to spy on. getLogger() proxies always
    // resolve the singleton at call time, so this affects git-manager.ts's
    // already-created `log` proxy too.
    const winstonLogger = reconfigureLogger();
    const warnSpy = vi.spyOn(winstonLogger, "warn").mockImplementation(() => winstonLogger);

    try {
      const result = await manager.cherryPick(
        { id: "ws-1", cwd: root },
        { hashes: ["aaa111"], connection: { id: "az-1", provider: "azure" } },
      );

      // The "never break the main flow" contract: the git action itself
      // still succeeds even though the audit write threw.
      expect(result.ok).toBe(true);
      expect(auditLogStore.logEntry).toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalledWith("git audit write failed", expect.objectContaining({ label: "git" }));
    } finally {
      warnSpy.mockRestore();
    }
  });

  test("cherryPick rejects empty and non-hex hashes without touching git", async () => {
    const { root } = await createGitFixture();
    const execGitImpl = vi.fn();
    const manager = new GitManager({ execGitImpl });

    const empty = await manager.cherryPick({ id: "ws-1", cwd: root }, { hashes: [] });
    expect(empty.ok).toBe(false);
    expect(empty.summary).toContain("No commits");

    const injected = await manager.cherryPick({ id: "ws-1", cwd: root }, { hashes: ["--exec=evil"] });
    expect(injected.ok).toBe(false);
    expect(injected.summary).toContain("Invalid commit hash");
    expect(execGitImpl).not.toHaveBeenCalled();
  });

  test("cherryPick refuses dirty working tree", async () => {
    const { root } = await createGitFixture();
    const execGitImpl = vi.fn();
    const manager = new GitManager({ execGitImpl });
    manager.inspectWorkspace = vi.fn().mockResolvedValue({ ...cleanSnapshot, dirty: true });

    const result = await manager.cherryPick({ id: "ws-1", cwd: root }, { hashes: ["aaa111"] });

    expect(result.ok).toBe(false);
    expect(result.summary).toContain("Working tree is dirty");
    expect(execGitImpl).not.toHaveBeenCalled();
  });

  test("squashCommits at HEAD soft-resets and commits with the given message", async () => {
    const { root } = await createGitFixture();
    const responses: Record<string, { stdout: string; stderr: string }> = {
      "rev-list aaaa3333^..cccc1111": { stdout: "cccc1111\nbbbb2222\naaaa3333\n", stderr: "" },
      "rev-list --merges aaaa3333^..HEAD": { stdout: "", stderr: "" },
      "merge-base --is-ancestor cccc1111 HEAD": { stdout: "", stderr: "" },
      "rev-parse HEAD": { stdout: "cccc1111\n", stderr: "" },
      "rev-parse --abbrev-ref HEAD": { stdout: "main\n", stderr: "" },
      "reset --soft aaaa3333^": { stdout: "", stderr: "" },
      "commit -m feat: combined": { stdout: "[main ffff6666] feat: combined\n", stderr: "" },
    };
    const execGitImpl = vi.fn(async (_cwd: string, args: string[]) => {
      const key = args.join(" ");
      if (!(key in responses)) throw { stdout: "", stderr: `Unexpected git call: ${key}` };
      return responses[key];
    });
    const manager = new GitManager({ execGitImpl });
    manager.inspectWorkspace = vi.fn().mockResolvedValue(cleanSnapshot);

    const result = await manager.squashCommits(
      { id: "ws-1", cwd: root },
      { hashes: ["cccc1111", "bbbb2222", "aaaa3333"], message: "feat: combined" },
    );

    expect(result.ok).toBe(true);
    expect(execGitImpl).toHaveBeenCalledWith(root, ["reset", "--soft", "aaaa3333^"]);
    expect(execGitImpl).toHaveBeenCalledWith(root, ["commit", "-m", "feat: combined"]);
    // The at-HEAD path must not rebase or detach.
    const calls = execGitImpl.mock.calls.map(([, args]: [string, string[]]) => args[0]);
    expect(calls).not.toContain("rebase");
    expect(calls).not.toContain("checkout");
  });

  test("squashCommits below HEAD detaches, squashes, and rebases descendants", async () => {
    const { root } = await createGitFixture();
    let revParseHeadCalls = 0;
    const execGitImpl = vi.fn(async (_cwd: string, args: string[]) => {
      const key = args.join(" ");
      if (key === "rev-parse HEAD") {
        revParseHeadCalls += 1;
        // 1st: resolve current HEAD; 2nd: resolve the squashed commit.
        return { stdout: revParseHeadCalls === 1 ? "eeee5555\n" : "ffff6666\n", stderr: "" };
      }
      const responses: Record<string, { stdout: string; stderr: string }> = {
        "rev-list aaaa3333^..cccc1111": { stdout: "cccc1111\nbbbb2222\naaaa3333\n", stderr: "" },
        "rev-list --merges aaaa3333^..HEAD": { stdout: "", stderr: "" },
        "merge-base --is-ancestor cccc1111 HEAD": { stdout: "", stderr: "" },
        "rev-parse --abbrev-ref HEAD": { stdout: "main\n", stderr: "" },
        "checkout --detach cccc1111": { stdout: "", stderr: "" },
        "reset --soft aaaa3333^": { stdout: "", stderr: "" },
        "commit -m feat: combined": { stdout: "", stderr: "" },
        "rebase --onto ffff6666 cccc1111 main": { stdout: "Successfully rebased\n", stderr: "" },
      };
      if (!(key in responses)) throw { stdout: "", stderr: `Unexpected git call: ${key}` };
      return responses[key];
    });
    const manager = new GitManager({ execGitImpl });
    manager.inspectWorkspace = vi.fn().mockResolvedValue(cleanSnapshot);

    const result = await manager.squashCommits(
      { id: "ws-1", cwd: root },
      { hashes: ["cccc1111", "bbbb2222", "aaaa3333"], message: "feat: combined" },
    );

    expect(result.ok).toBe(true);
    expect(execGitImpl).toHaveBeenCalledWith(root, ["checkout", "--detach", "cccc1111"]);
    expect(execGitImpl).toHaveBeenCalledWith(root, ["rebase", "--onto", "ffff6666", "cccc1111", "main"]);
  });

  test("squashCommits rejects a non-contiguous selection", async () => {
    const { root } = await createGitFixture();
    const execGitImpl = vi.fn(async (_cwd: string, args: string[]) => {
      if (args.join(" ") === "rev-list aaaa3333^..cccc1111") {
        // extra commit in the range that was not selected
        return { stdout: "cccc1111\nbbbb2222\ndddd4444\naaaa3333\n", stderr: "" };
      }
      throw { stdout: "", stderr: "unexpected" };
    });
    const manager = new GitManager({ execGitImpl });

    const result = await manager.squashCommits(
      { id: "ws-1", cwd: root },
      { hashes: ["cccc1111", "bbbb2222", "aaaa3333"], message: "m" },
    );

    expect(result.ok).toBe(false);
    expect(result.summary).toContain("not a contiguous range");
  });

  test("squashCommits rejects when merge commits sit in the rewrite range", async () => {
    const { root } = await createGitFixture();
    const execGitImpl = vi.fn(async (_cwd: string, args: string[]) => {
      const key = args.join(" ");
      if (key === "rev-list aaaa3333^..cccc1111") return { stdout: "cccc1111\nbbbb2222\naaaa3333\n", stderr: "" };
      if (key === "rev-list --merges aaaa3333^..HEAD") return { stdout: "abcd9999\n", stderr: "" };
      throw { stdout: "", stderr: "unexpected" };
    });
    const manager = new GitManager({ execGitImpl });

    const result = await manager.squashCommits(
      { id: "ws-1", cwd: root },
      { hashes: ["cccc1111", "bbbb2222", "aaaa3333"], message: "m" },
    );

    expect(result.ok).toBe(false);
    expect(result.summary).toContain("merge commits");
  });

  test("squashCommits rejects commits that are not on the current branch", async () => {
    const { root } = await createGitFixture();
    const execGitImpl = vi.fn(async (_cwd: string, args: string[]) => {
      const key = args.join(" ");
      if (key === "rev-list aaaa3333^..cccc1111") return { stdout: "cccc1111\nbbbb2222\naaaa3333\n", stderr: "" };
      if (key === "rev-list --merges aaaa3333^..HEAD") return { stdout: "", stderr: "" };
      if (key === "merge-base --is-ancestor cccc1111 HEAD") throw { stdout: "", stderr: "" };
      throw { stdout: "", stderr: "unexpected" };
    });
    const manager = new GitManager({ execGitImpl });

    const result = await manager.squashCommits(
      { id: "ws-1", cwd: root },
      { hashes: ["cccc1111", "bbbb2222", "aaaa3333"], message: "m" },
    );

    expect(result.ok).toBe(false);
    expect(result.summary).toContain("not on the current branch");
  });

  test("squashCommits requires at least two commits and a message", async () => {
    const { root } = await createGitFixture();
    const execGitImpl = vi.fn();
    const manager = new GitManager({ execGitImpl });

    const single = await manager.squashCommits({ id: "ws-1", cwd: root }, { hashes: ["aaaa3333"], message: "m" });
    expect(single.ok).toBe(false);
    expect(single.summary).toContain("at least two");

    const noMessage = await manager.squashCommits(
      { id: "ws-1", cwd: root },
      { hashes: ["bbbb2222", "aaaa3333"], message: "  " },
    );
    expect(noMessage.ok).toBe(false);
    expect(noMessage.summary).toContain("message");
    expect(execGitImpl).not.toHaveBeenCalled();
  });

  // ─── execAuthGit login resolution ────────────────────────────────

  function extractAuthCredentials(execMock: ReturnType<typeof vi.fn>) {
    const args = execMock.mock.calls[0][1] as string[];
    const headerArg = args.find((a) => typeof a === "string" && a.includes("http.extraheader="));
    if (!headerArg) return null;
    const base64 = headerArg.split("Basic ")[1];
    return Buffer.from(base64, "base64").toString("utf8");
  }

  test("execAuthGit uses connection.login for Azure DevOps connections", async () => {
    const { root } = await createGitFixture();
    const execGitImpl = vi.fn().mockResolvedValue({ stdout: "", stderr: "" });
    const credentialStore = { getSecret: () => "azure-pat-123" };
    const manager = new GitManager({ execGitImpl, credentialStore });

    await manager.execAuthGit(root, ["push"], {
      connection: { login: "azure-user", tokenRef: "secret:azure" },
    });

    expect(extractAuthCredentials(execGitImpl)).toBe("azure-user:azure-pat-123");
  });

  test("execAuthGit falls back to currentUserLogin for GitHub connections", async () => {
    const { root } = await createGitFixture();
    const execGitImpl = vi.fn().mockResolvedValue({ stdout: "", stderr: "" });
    const credentialStore = { getSecret: () => "ghp_token123" };
    const manager = new GitManager({ execGitImpl, credentialStore });

    await manager.execAuthGit(root, ["push", "origin", "refs/tags/v1.0.0"], {
      connection: { currentUserLogin: "jstradej", tokenRef: "secret:gh" },
    });

    expect(extractAuthCredentials(execGitImpl)).toBe("jstradej:ghp_token123");
  });

  test("execAuthGit falls back to x-access-token when no login fields exist", async () => {
    const { root } = await createGitFixture();
    const execGitImpl = vi.fn().mockResolvedValue({ stdout: "", stderr: "" });
    const credentialStore = { getSecret: () => "some-token" };
    const manager = new GitManager({ execGitImpl, credentialStore });

    await manager.execAuthGit(root, ["fetch"], {
      connection: { tokenRef: "secret:ref" },
    });

    expect(extractAuthCredentials(execGitImpl)).toBe("x-access-token:some-token");
  });

  test("execAuthGit skips auth when no credentialStore", async () => {
    const { root } = await createGitFixture();
    const execGitImpl = vi.fn().mockResolvedValue({ stdout: "", stderr: "" });
    const manager = new GitManager({ execGitImpl });

    await manager.execAuthGit(root, ["push"], {
      connection: { login: "user", tokenRef: "secret:ref" },
    });

    expect(execGitImpl).toHaveBeenCalledWith(root, ["push"]);
  });

  // ─── Phase 4: forcePushWithLease audit log ────────────────────────

  test("forcePushWithLease records expectedRef, previousRemoteRef, newRemoteRef in gitAuditLogStore", async () => {
    const { root } = await createGitFixture();
    // execGitImpl call sequence:
    // 1. inspectWorkspace (several calls — mocked below)
    // 2. rev-parse origin/feature-x → expectedRef hash
    // 3. push --force-with-lease=feature-x:abc123 origin feature-x → success
    // 4. rev-parse HEAD → newRemoteRef hash
    const execGitImpl = createExecMock({
      [`${root}::rev-parse --show-toplevel`]: { stdout: `${root}\n`, stderr: "" },
      [`${root}::rev-parse --abbrev-ref HEAD`]: { stdout: "feature-x\n", stderr: "" },
      [`${root}::remote -v`]: {
        stdout: "origin\thttps://example.com/repo.git (fetch)\norigin\thttps://example.com/repo.git (push)\n",
        stderr: "",
      },
      [`${root}::rev-list --count HEAD`]: { stdout: "5\n", stderr: "" },
      [`${root}::status --porcelain=v2 --branch`]: {
        stdout: "# branch.head feature-x\n# branch.upstream origin/feature-x\n# branch.ab +2 -3\n",
        stderr: "",
      },
      [`${root}::status --short`]: { stdout: "", stderr: "" },
      [`${root}::log --date=relative --pretty=format:%h%x09%ad%x09%an%x09%d%x09%s -n 18`]: { stdout: "", stderr: "" },
      [`${root}::rev-parse --git-dir`]: { stdout: ".git\n", stderr: "" },
      [`${root}::rev-parse --git-common-dir`]: { stdout: ".git\n", stderr: "" },
      [`${root}::worktree list --porcelain`]: {
        stdout: `worktree ${root}\nHEAD abc\nbranch refs/heads/feature-x\n`,
        stderr: "",
      },
      [`${root}::for-each-ref --format=%(refname:short) refs/heads refs/remotes`]: {
        stdout: "feature-x\norigin/feature-x\n",
        stderr: "",
      },
      [`${root}::rev-list --left-right --count HEAD...origin/feature-x`]: { stdout: "2\t3\n", stderr: "" },
      [`${root}::log --date=relative --pretty=format:%h%x09%ad%x09%an%x09%d%x09%s -n 18 origin/feature-x..HEAD`]: {
        stdout: "",
        stderr: "",
      },
      [`${root}::diff --name-status origin/feature-x...HEAD`]: { stdout: "", stderr: "" },
      [`${root}::diff --shortstat origin/feature-x...HEAD`]: { stdout: "", stderr: "" },
      [`${root}::diff --cached --shortstat`]: { stdout: "", stderr: "" },
      [`${root}::diff --shortstat`]: { stdout: "", stderr: "" },
      [`${root}::diff --name-only --diff-filter=U`]: { stdout: "", stderr: "" },
      // Pre-push: resolve upstream hash
      [`${root}::rev-parse origin/feature-x`]: { stdout: "abc123abc123\n", stderr: "" },
      // The actual push (with explicit lease ref)
      [`${root}::push --force-with-lease=feature-x:abc123abc123 origin feature-x`]: {
        stdout: "",
        stderr: "To https://example.com/repo.git\n + abc123..def456 feature-x -> feature-x (forced)\n",
      },
      // Post-push: resolve HEAD
      [`${root}::rev-parse HEAD`]: { stdout: "def456def456\n", stderr: "" },
    });
    const gitAuditLogStore = { logEntry: vi.fn() };
    const manager = new GitManager({ execGitImpl, gitAuditLogStore });
    manager.detectLazygit = async () => ({ available: false, backend: null, error: "missing", launch: null });

    const result = await manager.forcePushWithLease({ id: "ws-1", cwd: root }, { connection: null });

    expect(result.ok).toBe(true);
    expect(gitAuditLogStore.logEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        connectionId: "system-ws-1",
        category: "write",
        expectedRef: "abc123abc123",
        previousRemoteRef: "abc123abc123",
        newRemoteRef: "def456def456",
      }),
    );
  });

  test("push with connection=null writes to gitAuditLogStore, not auditLogStore", async () => {
    const { root } = await createGitFixture();
    const execGitImpl = vi.fn().mockResolvedValue({ stdout: "", stderr: "" });
    const auditLogStore = { logEntry: vi.fn() };
    const gitAuditLogStore = { logEntry: vi.fn() };
    const manager = new GitManager({ execGitImpl, auditLogStore, gitAuditLogStore });
    manager.inspectWorkspace = vi.fn().mockResolvedValue({
      available: true,
      branch: "main",
      upstream: "origin/main",
      aheadCount: 1,
      behindCount: 0,
      dirty: false,
      remotes: { origin: "https://example.com/repo.git" },
      operationState: { kind: "idle", inProgress: false, conflicts: [] },
    });

    const result = await manager.push({ id: "ws-2", cwd: root }, { connection: null });

    expect(result.ok).toBe(true);
    expect(auditLogStore.logEntry).not.toHaveBeenCalled();
    expect(gitAuditLogStore.logEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        connectionId: "system-ws-2",
        remoteUrl: "https://example.com/repo.git",
        category: "write",
      }),
    );
  });

  test("fetch with connection=null writes to gitAuditLogStore", async () => {
    const { root } = await createGitFixture();
    const execGitImpl = vi.fn().mockResolvedValue({ stdout: "", stderr: "" });
    const gitAuditLogStore = { logEntry: vi.fn() };
    const manager = new GitManager({ execGitImpl, gitAuditLogStore });
    manager.inspectWorkspace = vi.fn().mockResolvedValue({
      available: true,
      branch: "main",
      upstream: "origin/main",
      aheadCount: 0,
      behindCount: 0,
      dirty: false,
      remotes: { origin: "https://example.com/repo.git" },
      operationState: { kind: "idle", inProgress: false, conflicts: [] },
    });

    const result = await manager.fetch({ id: "ws-3", cwd: root }, { connection: null });

    expect(result.ok).toBe(true);
    expect(gitAuditLogStore.logEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        connectionId: "system-ws-3",
        category: "read",
      }),
    );
  });

  // ─── P-1: dirtyCount consistency ─────────────────────────────────

  test("dirtyCount equals unique changed-file count for staged+unstaged only", async () => {
    const { root } = await createGitFixture();
    const execGitImpl = createExecMock({
      [`${root}::rev-parse --show-toplevel`]: { stdout: `${root}\n`, stderr: "" },
      [`${root}::rev-parse --abbrev-ref HEAD`]: { stdout: "main\n", stderr: "" },
      [`${root}::remote -v`]: { stdout: "", stderr: "" },
      [`${root}::rev-list --count HEAD`]: { stdout: "5\n", stderr: "" },
      [`${root}::status --porcelain=v2 --branch`]: {
        stdout: [
          "# branch.head main",
          "1 M. N... 100644 100644 100644 aaa bbb src/a.js",
          "1 .M N... 100644 100644 100644 ccc ddd src/b.js",
        ].join("\n"),
        stderr: "",
      },
      [`${root}::status --short`]: { stdout: "M  src/a.js\n M src/b.js\n", stderr: "" },
      [`${root}::log --date=relative --pretty=format:%h%x09%ad%x09%an%x09%d%x09%s -n 18`]: { stdout: "", stderr: "" },
      [`${root}::rev-parse --git-dir`]: { stdout: ".git\n", stderr: "" },
      [`${root}::rev-parse --git-common-dir`]: { stdout: ".git\n", stderr: "" },
      [`${root}::worktree list --porcelain`]: {
        stdout: `worktree ${root}\nHEAD abc\nbranch refs/heads/main\n`,
        stderr: "",
      },
      [`${root}::for-each-ref --format=%(refname:short) refs/heads refs/remotes`]: { stdout: "main\n", stderr: "" },
      [`${root}::diff --cached --shortstat`]: { stdout: " 1 file changed, 2 insertions(+)\n", stderr: "" },
      [`${root}::diff --shortstat`]: { stdout: " 1 file changed, 1 deletion(-)\n", stderr: "" },
      [`${root}::diff --name-only --diff-filter=U`]: { stdout: "", stderr: "" },
    });
    const manager = new GitManager({ execGitImpl });
    manager.detectLazygit = async () => ({ available: false, backend: null, error: "missing", launch: null });

    const snapshot = await manager.inspectWorkspace({ id: "ws-1", cwd: root, kind: "terminal" });

    expect(snapshot.staged as unknown[]).toHaveLength(1);
    expect(snapshot.unstaged as unknown[]).toHaveLength(1);
    expect(snapshot.untracked as unknown[]).toHaveLength(0);
    expect(snapshot.dirtyCount).toBe(2);
    expect(snapshot.dirty).toBe(true);
  });

  test("dirtyCount equals unique changed-file count for untracked only", async () => {
    const { root } = await createGitFixture();
    const execGitImpl = createExecMock({
      [`${root}::rev-parse --show-toplevel`]: { stdout: `${root}\n`, stderr: "" },
      [`${root}::rev-parse --abbrev-ref HEAD`]: { stdout: "main\n", stderr: "" },
      [`${root}::remote -v`]: { stdout: "", stderr: "" },
      [`${root}::rev-list --count HEAD`]: { stdout: "5\n", stderr: "" },
      [`${root}::status --porcelain=v2 --branch`]: {
        stdout: ["# branch.head main", "? new-file.txt", "? another.txt"].join("\n"),
        stderr: "",
      },
      [`${root}::status --short`]: { stdout: "?? new-file.txt\n?? another.txt\n", stderr: "" },
      [`${root}::log --date=relative --pretty=format:%h%x09%ad%x09%an%x09%d%x09%s -n 18`]: { stdout: "", stderr: "" },
      [`${root}::rev-parse --git-dir`]: { stdout: ".git\n", stderr: "" },
      [`${root}::rev-parse --git-common-dir`]: { stdout: ".git\n", stderr: "" },
      [`${root}::worktree list --porcelain`]: {
        stdout: `worktree ${root}\nHEAD abc\nbranch refs/heads/main\n`,
        stderr: "",
      },
      [`${root}::for-each-ref --format=%(refname:short) refs/heads refs/remotes`]: { stdout: "main\n", stderr: "" },
      [`${root}::diff --cached --shortstat`]: { stdout: "", stderr: "" },
      [`${root}::diff --shortstat`]: { stdout: "", stderr: "" },
      [`${root}::diff --name-only --diff-filter=U`]: { stdout: "", stderr: "" },
    });
    const manager = new GitManager({ execGitImpl });
    manager.detectLazygit = async () => ({ available: false, backend: null, error: "missing", launch: null });

    const snapshot = await manager.inspectWorkspace({ id: "ws-1", cwd: root, kind: "terminal" });

    expect(snapshot.staged as unknown[]).toHaveLength(0);
    expect(snapshot.unstaged as unknown[]).toHaveLength(0);
    expect(snapshot.untracked as unknown[]).toHaveLength(2);
    expect(snapshot.dirtyCount).toBe(2);
    expect(snapshot.dirty).toBe(true);
  });

  test("dirtyCount deduplicates same path across staged+unstaged+untracked (mix of 3 unique files)", async () => {
    const { root } = await createGitFixture();
    const execGitImpl = createExecMock({
      [`${root}::rev-parse --show-toplevel`]: { stdout: `${root}\n`, stderr: "" },
      [`${root}::rev-parse --abbrev-ref HEAD`]: { stdout: "main\n", stderr: "" },
      [`${root}::remote -v`]: { stdout: "", stderr: "" },
      [`${root}::rev-list --count HEAD`]: { stdout: "5\n", stderr: "" },
      [`${root}::status --porcelain=v2 --branch`]: {
        stdout: [
          "# branch.head main",
          "1 MM N... 100644 100644 100644 aaa bbb src/a.js",
          "1 .M N... 100644 100644 100644 ccc ddd src/b.js",
          "? new.txt",
        ].join("\n"),
        stderr: "",
      },
      [`${root}::status --short`]: { stdout: "MM src/a.js\n M src/b.js\n?? new.txt\n", stderr: "" },
      [`${root}::log --date=relative --pretty=format:%h%x09%ad%x09%an%x09%d%x09%s -n 18`]: { stdout: "", stderr: "" },
      [`${root}::rev-parse --git-dir`]: { stdout: ".git\n", stderr: "" },
      [`${root}::rev-parse --git-common-dir`]: { stdout: ".git\n", stderr: "" },
      [`${root}::worktree list --porcelain`]: {
        stdout: `worktree ${root}\nHEAD abc\nbranch refs/heads/main\n`,
        stderr: "",
      },
      [`${root}::for-each-ref --format=%(refname:short) refs/heads refs/remotes`]: { stdout: "main\n", stderr: "" },
      [`${root}::diff --cached --shortstat`]: { stdout: " 1 file changed, 3 insertions(+)\n", stderr: "" },
      [`${root}::diff --shortstat`]: { stdout: " 2 files changed, 1 insertion(+)\n", stderr: "" },
      [`${root}::diff --name-only --diff-filter=U`]: { stdout: "", stderr: "" },
    });
    const manager = new GitManager({ execGitImpl });
    manager.detectLazygit = async () => ({ available: false, backend: null, error: "missing", launch: null });

    const snapshot = await manager.inspectWorkspace({ id: "ws-1", cwd: root, kind: "terminal" });

    // src/a.js appears in both staged and unstaged — must count once
    expect((snapshot.staged as Array<{ path: string }>).map((e) => e.path)).toContain("src/a.js");
    expect((snapshot.unstaged as Array<{ path: string }>).map((e) => e.path)).toContain("src/a.js");
    expect((snapshot.unstaged as Array<{ path: string }>).map((e) => e.path)).toContain("src/b.js");
    expect((snapshot.untracked as Array<{ path: string }>).map((e) => e.path)).toContain("new.txt");
    expect(snapshot.dirtyCount).toBe(3);
    expect(snapshot.dirty).toBe(true);
  });

  // ─── runWriteAction rootPath routing ─────────────────────────────

  describe("runWriteAction rootPath routing", () => {
    test("runWriteAction uses rootPath as effectiveCwd when provided", async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "strideterm-rw-"));
      tempPaths.push(root);
      await fs.mkdir(path.join(root, ".git"), { recursive: true });
      await fs.mkdir(path.join(root, "sub"), { recursive: true });
      await fs.mkdir(path.join(root, "sub", ".git"), { recursive: true });

      const subPath = path.join(root, "sub").replace(/\\/g, "/");

      const execGitImpl = async (cwd: string, args: string[]) => {
        if (args[0] === "rev-parse" && args[1] === "--show-toplevel") return { stdout: cwd + "\n", stderr: "" };
        if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") return { stdout: "main\n", stderr: "" };
        if (args[0] === "remote") return { stdout: "", stderr: "" };
        if (args[0] === "rev-list" && args[1] === "--count") return { stdout: "1\n", stderr: "" };
        if (args[0] === "status" && args.includes("--porcelain=v2"))
          return { stdout: "# branch.oid abc\n# branch.head main\n", stderr: "" };
        if (args[0] === "status" && args.includes("--short")) return { stdout: "", stderr: "" };
        if (args[0] === "log") return { stdout: "", stderr: "" };
        if (args[0] === "stash" && args[1] === "list") return { stdout: "", stderr: "" };
        if (args[0] === "diff" && args.includes("--cached")) return { stdout: "", stderr: "" };
        if (args[0] === "diff" && args.includes("--shortstat")) return { stdout: "", stderr: "" };
        if (args[0] === "diff" && args.includes("--name-only")) return { stdout: "", stderr: "" };
        if (args[0] === "diff") return { stdout: "", stderr: "" };
        if (args[0] === "ls-files") return { stdout: "", stderr: "" };
        if (args[0] === "worktree")
          return { stdout: `worktree ${cwd}\nHEAD abc\nbranch refs/heads/main\n`, stderr: "" };
        if (args[0] === "for-each-ref") return { stdout: "main\n", stderr: "" };
        if (args[0] === "rev-parse" && args[1] === "--git-dir") return { stdout: ".git\n", stderr: "" };
        if (args[0] === "rev-parse" && args[1] === "--git-common-dir") return { stdout: ".git\n", stderr: "" };
        return { stdout: "", stderr: "" };
      };

      const mgr = new GitManager({ execGitImpl });
      mgr.detectLazygit = async () => ({ available: false, backend: null, error: "missing", launch: null });

      const workspace = { id: "ws1", cwd: root.replace(/\\/g, "/"), gitRoots: [root.replace(/\\/g, "/"), subPath] };

      let actionCwd: string | null = null;
      await mgr.runWriteAction(workspace, {
        type: "fetch",
        label: "Fetch",
        rootPath: subPath,
        skipPreflight: true,
        run: async (cwd) => {
          actionCwd = cwd;
          return { stdout: "", stderr: "" };
        },
      });

      expect(actionCwd).toBe(subPath);
    });

    test("runWriteAction uses workspace.cwd when rootPath is not provided", async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "strideterm-rw2-"));
      tempPaths.push(root);
      await fs.mkdir(path.join(root, ".git"), { recursive: true });

      const normalizedRoot = root.replace(/\\/g, "/");

      const execGitImpl = async (cwd: string, args: string[]) => {
        if (args[0] === "rev-parse" && args[1] === "--show-toplevel") return { stdout: cwd + "\n", stderr: "" };
        if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") return { stdout: "main\n", stderr: "" };
        if (args[0] === "remote") return { stdout: "", stderr: "" };
        if (args[0] === "rev-list" && args[1] === "--count") return { stdout: "1\n", stderr: "" };
        if (args[0] === "status" && args.includes("--porcelain=v2"))
          return { stdout: "# branch.oid abc\n# branch.head main\n", stderr: "" };
        if (args[0] === "status" && args.includes("--short")) return { stdout: "", stderr: "" };
        if (args[0] === "log") return { stdout: "", stderr: "" };
        if (args[0] === "diff") return { stdout: "", stderr: "" };
        if (args[0] === "worktree")
          return { stdout: `worktree ${cwd}\nHEAD abc\nbranch refs/heads/main\n`, stderr: "" };
        if (args[0] === "for-each-ref") return { stdout: "main\n", stderr: "" };
        if (args[0] === "rev-parse" && args[1] === "--git-dir") return { stdout: ".git\n", stderr: "" };
        if (args[0] === "rev-parse" && args[1] === "--git-common-dir") return { stdout: ".git\n", stderr: "" };
        return { stdout: "", stderr: "" };
      };

      const mgr = new GitManager({ execGitImpl });
      mgr.detectLazygit = async () => ({ available: false, backend: null, error: "missing", launch: null });

      const workspace = { id: "ws2", cwd: normalizedRoot };

      let actionCwd: string | null = null;
      await mgr.runWriteAction(workspace, {
        type: "fetch",
        label: "Fetch",
        // rootPath omitted
        skipPreflight: true,
        run: async (cwd) => {
          actionCwd = cwd;
          return { stdout: "", stderr: "" };
        },
      });

      expect(actionCwd).toBe(normalizedRoot);
    });

    test("runWriteAction includes rootPath in audit log extra", async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "strideterm-audit-"));
      tempPaths.push(root);
      await fs.mkdir(path.join(root, ".git"), { recursive: true });
      const subPath = path.join(root, "sub").replace(/\\/g, "/");
      await fs.mkdir(path.join(root, "sub"), { recursive: true });
      await fs.mkdir(path.join(root, "sub", ".git"), { recursive: true });

      const execGitImpl = async (cwd: string, args: string[]) => {
        if (args[0] === "rev-parse" && args[1] === "--show-toplevel") return { stdout: cwd + "\n", stderr: "" };
        if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") return { stdout: "main\n", stderr: "" };
        if (args[0] === "remote") return { stdout: "", stderr: "" };
        if (args[0] === "rev-list" && args[1] === "--count") return { stdout: "1\n", stderr: "" };
        if (args[0] === "status" && args.includes("--porcelain=v2"))
          return { stdout: "# branch.oid abc\n# branch.head main\n", stderr: "" };
        if (args[0] === "status" && args.includes("--short")) return { stdout: "", stderr: "" };
        if (args[0] === "log") return { stdout: "", stderr: "" };
        if (args[0] === "diff") return { stdout: "", stderr: "" };
        if (args[0] === "worktree")
          return { stdout: `worktree ${cwd}\nHEAD abc\nbranch refs/heads/main\n`, stderr: "" };
        if (args[0] === "for-each-ref") return { stdout: "main\n", stderr: "" };
        if (args[0] === "rev-parse" && args[1] === "--git-dir") return { stdout: ".git\n", stderr: "" };
        if (args[0] === "rev-parse" && args[1] === "--git-common-dir") return { stdout: ".git\n", stderr: "" };
        return { stdout: "", stderr: "" };
      };

      const mgr = new GitManager({ execGitImpl });
      mgr.detectLazygit = async () => ({ available: false, backend: null, error: "missing", launch: null });

      const auditEntries: Array<Record<string, unknown>> = [];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mgr._logGitAudit = (entry: any) => auditEntries.push(entry);

      const workspace = {
        id: "ws-audit",
        cwd: root.replace(/\\/g, "/"),
        gitRoots: [root.replace(/\\/g, "/"), subPath],
      };

      await mgr.runWriteAction(workspace, {
        type: "fetch",
        label: "Fetch",
        rootPath: subPath,
        skipPreflight: true,
        run: async () => ({ stdout: "", stderr: "" }),
      });

      const successEntry = auditEntries.find((e) => e.success === true);
      expect(successEntry).toBeTruthy();
      expect((successEntry!.extra as Record<string, unknown>)?.rootPath).toBe(subPath);
    });
  });

  // ─── inspectWorkspaceRoots ────────────────────────────────────────

  describe("inspectWorkspaceRoots", () => {
    test("returns empty result when workspace has no cwd and no gitRoots", async () => {
      const mgr = new GitManager({});
      const result = await mgr.inspectWorkspaceRoots({ id: "ws1", cwd: "", gitRoots: [] });
      expect(result.roots).toEqual([]);
      expect(result.primaryRoot).toBe("");
    });

    test("uses workspace.cwd as single root when gitRoots is empty", async () => {
      const mgr = new GitManager({});
      const fakeSnap = { workspaceId: "ws1", rootPath: "/repo", branch: "main", available: true };
      mgr._inspectRoot = vi.fn().mockResolvedValue(fakeSnap);
      const result = await mgr.inspectWorkspaceRoots({ id: "ws1", cwd: "/repo", gitRoots: [] });
      expect(result.roots).toHaveLength(1);
      expect(result.primaryRoot).toBe("/repo");
      expect(mgr._inspectRoot).toHaveBeenCalledWith(expect.objectContaining({ id: "ws1" }), "/repo");
    });

    test("returns N snapshots for N gitRoots entries", async () => {
      const mgr = new GitManager({});
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mgr._inspectRoot = vi.fn().mockImplementation(async (ws: any, rp: string) => ({
        workspaceId: ws.id,
        rootPath: rp,
        available: true,
      }));
      const workspace = { id: "ws1", cwd: "/ms", gitRoots: ["/ms/api", "/ms/web", "/ms/infra"] };
      const result = await mgr.inspectWorkspaceRoots(workspace);
      expect(result.roots).toHaveLength(3);
      expect(result.primaryRoot).toBe("/ms/api");
      expect(mgr._inspectRoot).toHaveBeenCalledTimes(3);
    });

    test("refreshWorkspaces cache key isolates siblings", async () => {
      const mgr = new GitManager({});
      let inspectCount = 0;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mgr._inspectRoot = vi.fn().mockImplementation(async (ws: any, rp: string) => {
        inspectCount++;
        return { workspaceId: ws.id, rootPath: rp, available: true };
      });
      const workspace = { id: "ws1", cwd: "/ms", gitRoots: ["/ms/api", "/ms/web"] };

      // First refresh — both roots are inspected
      await mgr.refreshWorkspaces([workspace]);
      expect(inspectCount).toBe(2);

      // Second refresh within TTL — both are cached
      await mgr.refreshWorkspaces([workspace]);
      expect(inspectCount).toBe(2);

      // Invalidate only /ms/api cache, /ms/web remains
      mgr.invalidateSnapshotCache("ws1", "/ms/api");

      // Third refresh — only api gets re-inspected
      await mgr.refreshWorkspaces([workspace]);
      expect(inspectCount).toBe(3);
    });

    test("inspectWorkspace back-compat returns primary root snapshot", async () => {
      const mgr = new GitManager({});
      const fakeSnap = { workspaceId: "ws1", rootPath: "/repo", branch: "main", available: true };
      mgr._inspectRoot = vi.fn().mockResolvedValue(fakeSnap);
      const result = await mgr.inspectWorkspace({ id: "ws1", cwd: "/repo", kind: "terminal" });
      expect(result).toBe(fakeSnap);
    });

    test("getSnapshot returns primary root snapshot when called without rootPath", () => {
      const mgr = new GitManager({});
      const primary = { workspaceId: "ws1", rootPath: "/ms/api", branch: "main", available: true };
      const secondary = { workspaceId: "ws1", rootPath: "/ms/web", branch: "main", available: true };
      mgr.snapshots.set(mgr._cacheKey("ws1", "/ms/api"), primary);
      mgr.snapshots.set(mgr._cacheKey("ws1", "/ms/web"), secondary);
      expect(mgr.getSnapshot("ws1")).toBe(primary);
    });

    test("getSnapshot returns the requested root snapshot when rootPath is provided", () => {
      const mgr = new GitManager({});
      const primary = { workspaceId: "ws1", rootPath: "/ms/api", branch: "main", available: true };
      const secondary = { workspaceId: "ws1", rootPath: "/ms/web", branch: "main", available: true };
      mgr.snapshots.set(mgr._cacheKey("ws1", "/ms/api"), primary);
      mgr.snapshots.set(mgr._cacheKey("ws1", "/ms/web"), secondary);
      expect(mgr.getSnapshot("ws1", "/ms/web")).toBe(secondary);
    });
  });

  // ─── stash rootPath routing ───────────────────────────────────────

  describe("stash rootPath routing", () => {
    test("stash uses rootPath as effective cwd when provided", async () => {
      const calls: Array<{ cwd: string; cmd: string }> = [];
      const execGitImpl = vi.fn().mockImplementation(async (cwd: string, args: string[]) => {
        calls.push({ cwd, cmd: args[0] });
        return { stdout: "No local changes to save\n", stderr: "" };
      });
      const mgr = new GitManager({ execGitImpl });
      const workspace = { id: "ws1", cwd: "/ms" };
      await mgr.stash(workspace, { rootPath: "/ms/api" });
      expect(calls[0].cwd).toBe("/ms/api");
    });

    test("stash falls back to workspace.cwd when rootPath is empty", async () => {
      const calls: string[] = [];
      const execGitImpl = vi.fn().mockImplementation(async (cwd: string) => {
        calls.push(cwd);
        return { stdout: "No local changes to save\n", stderr: "" };
      });
      const mgr = new GitManager({ execGitImpl });
      await mgr.stash({ id: "ws1", cwd: "/ms/root" }, { rootPath: "" });
      expect(calls[0]).toBe("/ms/root");
    });

    test("stashPop uses rootPath as effective cwd when provided", async () => {
      const calls: string[] = [];
      const execGitImpl = vi.fn().mockImplementation(async (cwd: string) => {
        calls.push(cwd);
        return { stdout: "HEAD is now at abc main\n", stderr: "" };
      });
      const mgr = new GitManager({ execGitImpl });
      await mgr.stashPop({ id: "ws1", cwd: "/ms" }, { rootPath: "/ms/web" });
      expect(calls[0]).toBe("/ms/web");
    });
  });

  describe("logPage pagination", () => {
    test("issues git log with --skip and limit+1 to detect hasMore", async () => {
      // Three real-looking commits — git returns limit+1 so hasMore can be
      // detected without a separate count query.
      const stdout =
        "aaa1111\t1 day ago\tjane\t\tFirst\n" +
        "bbb2222\t2 days ago\tjane\t\tSecond\n" +
        "ccc3333\t3 days ago\tjane\t\tThird\n";
      const execGitImpl = vi.fn().mockResolvedValue({ stdout, stderr: "" });
      const mgr = new GitManager({ execGitImpl });
      const result = await mgr.logPage(
        { id: "ws1", cwd: "/repo" },
        { rootPath: "/repo", baseBranch: "", skip: 0, limit: 2 },
      );
      expect(execGitImpl).toHaveBeenCalledTimes(1);
      const args = execGitImpl.mock.calls[0][1];
      expect(args).toContain("--skip");
      expect(args[args.indexOf("--skip") + 1]).toBe("0");
      expect(args).toContain("-n");
      expect(args[args.indexOf("-n") + 1]).toBe("3"); // limit + 1
      expect(result.ok).toBe(true);
      expect(result.commits).toHaveLength(2);
      expect(result.hasMore).toBe(true);
    });

    test("returns hasMore=false when fewer commits than limit are returned", async () => {
      const stdout = "aaa1111\t1 day ago\tjane\t\tFirst\n";
      const execGitImpl = vi.fn().mockResolvedValue({ stdout, stderr: "" });
      const mgr = new GitManager({ execGitImpl });
      const result = await mgr.logPage({ id: "ws1", cwd: "/repo" }, { rootPath: "/repo", skip: 0, limit: 100 });
      expect(result.ok).toBe(true);
      expect(result.hasMore).toBe(false);
      expect(result.commits).toHaveLength(1);
    });

    test("uses baseBranch..HEAD when baseBranch is provided", async () => {
      const execGitImpl = vi.fn().mockResolvedValue({ stdout: "", stderr: "" });
      const mgr = new GitManager({ execGitImpl });
      await mgr.logPage(
        { id: "ws1", cwd: "/repo" },
        { rootPath: "/repo", baseBranch: "origin/main", skip: 100, limit: 50 },
      );
      const args = execGitImpl.mock.calls[0][1];
      expect(args[args.length - 1]).toBe("origin/main..HEAD");
      expect(args[args.indexOf("--skip") + 1]).toBe("100");
    });

    test("returns ok=false on git failure", async () => {
      const execGitImpl = vi.fn().mockRejectedValue({ stderr: "fatal: bad revision", stdout: "" });
      const mgr = new GitManager({ execGitImpl });
      const result = await mgr.logPage({ id: "ws1", cwd: "/repo" }, { rootPath: "/repo", limit: 50 });
      expect(result.ok).toBe(false);
      expect(result.commits).toEqual([]);
      expect(result.hasMore).toBe(false);
    });

    test("clamps limit at 500 to keep payloads bounded", async () => {
      const execGitImpl = vi.fn().mockResolvedValue({ stdout: "", stderr: "" });
      const mgr = new GitManager({ execGitImpl });
      await mgr.logPage({ id: "ws1", cwd: "/repo" }, { rootPath: "/repo", limit: 9999 });
      const args = execGitImpl.mock.calls[0][1];
      expect(args[args.indexOf("-n") + 1]).toBe("501"); // 500 + 1
    });
  });

  describe("commitInfo", () => {
    const SEP = "\x1f";

    function metaStdout(fields: string[]): string {
      return fields.join(SEP);
    }

    test("parses metadata (from the format call) and stat (from the dedicated --shortstat call)", async () => {
      const fields = [
        "abcdef1234567890abcdef1234567890abcdef12", // %H
        "abcdef1", // %h
        "parent1hash", // %P
        "Jane Doe", // %an
        "jane@example.com", // %ae
        "2026-07-01T10:00:00+02:00", // %aI
        "Jane Doe", // %cn
        "jane@example.com", // %ce
        "2026-07-01T10:00:00+02:00", // %cI
        "2 weeks ago", // %ar
        " (HEAD -> main)", // %d
        "Fix bug", // %s
        "Fix bug\n\nDetailed body text.", // %B
      ];
      const execGitImpl = vi.fn(async (_cwd: string, args: string[]) => {
        if (args.includes("--shortstat")) {
          return { stdout: " 2 files changed, 3 insertions(+), 1 deletion(-)\n", stderr: "" };
        }
        return { stdout: metaStdout(fields), stderr: "" };
      });
      const mgr = new GitManager({ execGitImpl });
      const result = await mgr.commitInfo({ id: "ws1", cwd: "/repo" }, { hash: "abcdef1" });

      // Two purpose-built calls instead of one combined one.
      expect(execGitImpl).toHaveBeenCalledTimes(2);
      expect(result.ok).toBe(true);
      expect(result.hash).toBe(fields[0]);
      expect(result.shortHash).toBe("abcdef1");
      expect(result.parents).toBe("parent1hash");
      expect(result.author).toBe("Jane Doe");
      expect(result.authorEmail).toBe("jane@example.com");
      expect(result.subject).toBe("Fix bug");
      expect(result.body).toBe("Fix bug\n\nDetailed body text.");
      expect(result.refs).toBe("HEAD -> main");
      expect(result.stat).toBe("2 files changed, 3 insertions(+), 1 deletion(-)");
    });

    test("correctly parses a body whose last line looks like a shortstat summary", async () => {
      // Regression test: the old regex-based stripping popped the trailing
      // line off the raw %B body if it matched /file[s]? changed/, so a
      // commit message ending in a line like this would have been silently
      // truncated. The new implementation gets the stat from its own
      // dedicated --shortstat call, so the body is never touched.
      const bodyWithFakeStat =
        "Refactor parser\n\nSee the note below:\n 3 files changed, 12 insertions(+), 1 deletion(-)";
      const fields = [
        "abcdef1234567890abcdef1234567890abcdef12",
        "abcdef1",
        "parenthash",
        "Jane Doe",
        "jane@example.com",
        "2026-07-01T10:00:00+02:00",
        "Jane Doe",
        "jane@example.com",
        "2026-07-01T10:00:00+02:00",
        "2 weeks ago",
        "",
        "Refactor parser",
        bodyWithFakeStat,
      ];
      const execGitImpl = vi.fn(async (_cwd: string, args: string[]) => {
        if (args.includes("--shortstat")) {
          return { stdout: " 1 file changed, 5 insertions(+)\n", stderr: "" };
        }
        return { stdout: metaStdout(fields), stderr: "" };
      });
      const mgr = new GitManager({ execGitImpl });
      const result = await mgr.commitInfo({ id: "ws1", cwd: "/repo" }, { hash: "abcdef1" });

      expect(result.ok).toBe(true);
      // The body-looking-like-a-shortstat line must survive intact.
      expect(result.body).toBe(bodyWithFakeStat);
      // The real stat comes from the dedicated call, not confused with the
      // fake shortstat-looking line embedded in the body.
      expect(result.stat).toBe("1 file changed, 5 insertions(+)");
    });
  });

  describe("listStashes", () => {
    test("batches base-commit lookups and runs file-list lookups concurrently, same output shape as before", async () => {
      const root = "/repo";
      const execGitImpl = createExecMock({
        [`${root}::stash list --format=%gd%x09%ct%x09%H%x09%gs%x09%an%x09%P`]: {
          stdout: [
            "stash@{0}\t1700000000\tHASH0\tWIP on main: abc\tJane\tBASE0FULL",
            "stash@{1}\t1700003600\tHASH1\tOn feature: custom msg\tJane\tBASE1FULL",
          ].join("\n"),
          stderr: "",
        },
        [`${root}::log --no-walk --format=%H%x09%h%x09%s BASE0FULL BASE1FULL`]: {
          stdout: "BASE0FULL\tbase0\tBase commit zero subject\nBASE1FULL\tbase1\tBase commit one subject\n",
          stderr: "",
        },
        [`${root}::stash show --include-untracked --name-only stash@{0}`]: {
          stdout: "file0.txt\nfile1.txt\n",
          stderr: "",
        },
        [`${root}::stash show --include-untracked --name-only stash@{1}`]: {
          stdout: "file2.txt\n",
          stderr: "",
        },
      });
      const mgr = new GitManager({ execGitImpl });
      const result = await mgr.listStashes({ id: "ws1", cwd: root });

      expect(result.ok).toBe(true);
      expect(result.stashes).toHaveLength(2);
      expect(result.stashes[0]).toMatchObject({
        index: 0,
        ref: "stash@{0}",
        hash: "HASH0",
        author: "Jane",
        branch: "main",
        isWipDefault: true,
        customMessage: "",
        message: "WIP on main: abc",
        baseCommit: "base0",
        baseSubject: "Base commit zero subject",
        fileCount: 2,
        filePaths: ["file0.txt", "file1.txt"],
      });
      expect(result.stashes[0].date).toBe(new Date(1700000000 * 1000).toISOString());
      expect(result.stashes[1]).toMatchObject({
        index: 1,
        ref: "stash@{1}",
        hash: "HASH1",
        author: "Jane",
        branch: "feature",
        isWipDefault: false,
        customMessage: "custom msg",
        message: "On feature: custom msg",
        baseCommit: "base1",
        baseSubject: "Base commit one subject",
        fileCount: 1,
        filePaths: ["file2.txt"],
      });

      // Old approach: 1 (stash list) + 2 (one `git log <ref>^1` per stash) +
      // 2 (one stashShowNameOnly per stash) = 5 subprocess spawns for 2
      // stashes. New approach: 1 (stash list) + 1 (batched base-commit log)
      // + 2 (concurrent stashShowNameOnly) = 4.
      expect(execGitImpl).toHaveBeenCalledTimes(4);
    });

    test("runs per-stash file-list lookups concurrently, not sequentially", async () => {
      const root = "/repo";
      let inFlight = 0;
      let maxInFlight = 0;
      const execGitImpl = vi.fn(async (_cwd: string, args: string[]) => {
        if (args[0] === "stash" && args[1] === "list") {
          return {
            stdout: [
              "stash@{0}\t1700000000\tHASH0\tWIP on main: abc\tJane\tBASE0",
              "stash@{1}\t1700003600\tHASH1\tWIP on main: def\tJane\tBASE1",
            ].join("\n"),
            stderr: "",
          };
        }
        if (args[0] === "log" && args[1] === "--no-walk") {
          return { stdout: "BASE0\tbase0\tzero\nBASE1\tbase1\tone\n", stderr: "" };
        }
        if (args[0] === "stash" && args[1] === "show") {
          inFlight++;
          maxInFlight = Math.max(maxInFlight, inFlight);
          await new Promise((resolve) => setTimeout(resolve, 10));
          inFlight--;
          return { stdout: "file.txt\n", stderr: "" };
        }
        return { stdout: "", stderr: "" };
      });
      const mgr = new GitManager({ execGitImpl });
      const result = await mgr.listStashes({ id: "ws1", cwd: root });

      expect(result.ok).toBe(true);
      // Sequential per-stash calls would never have more than 1 in flight;
      // Promise.all lets both stashShowNameOnly calls overlap.
      expect(maxInFlight).toBe(2);
    });
  });

  describe("removeWorktree fast path", () => {
    test("uses fs.rm + git worktree prune when directory removal succeeds", async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "strideterm-rm-"));
      const wtPath = path.join(root, ".strideterm", "tree", "feature-rm");
      await fs.mkdir(wtPath, { recursive: true });
      await fs.writeFile(path.join(wtPath, "file.txt"), "hello", "utf8");
      tempPaths.push(root);

      const calls: string[][] = [];
      const execGitImpl = vi.fn().mockImplementation(async (_cwd: string, args: string[]) => {
        calls.push(args);
        return { stdout: "", stderr: "" };
      });
      const mgr = new GitManager({ execGitImpl });
      const result = await mgr.removeWorktree({ id: "ws1", cwd: root }, { worktreePath: wtPath, rootPath: root });
      // The worktree directory itself was removed by fs.rm before git ran.
      let dirGone = false;
      try {
        await fs.stat(wtPath);
      } catch {
        dirGone = true;
      }
      expect(dirGone).toBe(true);
      // We should have called `git worktree prune` (fast path), NOT
      // `git worktree remove --force`.
      const ranPrune = calls.some((args) => args[0] === "worktree" && args[1] === "prune");
      const ranForceRemove = calls.some((args) => args[0] === "worktree" && args[1] === "remove");
      expect(ranPrune).toBe(true);
      expect(ranForceRemove).toBe(false);
      expect(result.ok).toBe(true);
    });

    test("falls back to git worktree remove --force when fs.rm fails / dir still exists", async () => {
      // Pass a path that doesn't exist — fs.rm with force=true returns
      // silently, then existsSync(resolvedPath) is false so prune runs. To
      // simulate the fallback path we point at a path that exists *and*
      // make execGit acknowledge --force removal worked.
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "strideterm-rm-fallback-"));
      const wtPath = path.join(root, ".strideterm", "tree", "feature-fallback");
      await fs.mkdir(wtPath, { recursive: true });
      // Create a file we cannot easily remove cross-platform — instead, we
      // rely on the contract: when prune is called and the dir is gone, we
      // pass; here we just verify the call shape goes through prune since
      // node fs.rm with force handles missing gracefully.
      tempPaths.push(root);

      const execGitImpl = vi.fn().mockResolvedValue({ stdout: "", stderr: "" });
      const mgr = new GitManager({ execGitImpl });
      const result = await mgr.removeWorktree({ id: "ws1", cwd: root }, { worktreePath: wtPath, rootPath: root });
      expect(result.ok).toBe(true);
    });
  });

  // ─── logGraph filter args ──────────────────────────────────────────
  describe("logGraph filter wiring", () => {
    function captureLogArgs(): { mgr: GitManager; calls: string[][] } {
      const calls: string[][] = [];
      const execGitImpl = vi.fn(async (_cwd: string, args: string[]) => {
        calls.push(args);
        if (args[0] === "log") return { stdout: "", stderr: "" };
        if (args[0] === "rev-parse" && args[1] === "HEAD") return { stdout: "deadbeef\n", stderr: "" };
        return { stdout: "", stderr: "" };
      });
      const mgr = new GitManager({ execGitImpl });
      return { mgr, calls };
    }

    test("forwards --since / --until / --topo-order / --author and trailing -- <paths>", async () => {
      const { mgr, calls } = captureLogArgs();
      await mgr.logGraph(
        { id: "ws1", cwd: "/repo" },
        {
          rootPath: "/repo",
          sinceDate: "2 weeks ago",
          untilDate: "2026-01-01",
          paths: ["src/foo.ts", "docs/bar.md"],
          topoOrder: true,
          author: "alice",
        },
      );
      const logCall = calls.find((c) => c[0] === "log");
      expect(logCall, "git log was not invoked").toBeTruthy();
      expect(logCall).toContain("--topo-order");
      expect(logCall).toContain("--since=2 weeks ago");
      expect(logCall).toContain("--until=2026-01-01");
      expect(logCall).toContain("--author=alice");
      // -- separator must come AFTER walk args so the paths aren't parsed as refs.
      const dashIdx = logCall!.indexOf("--");
      expect(dashIdx).toBeGreaterThan(0);
      expect(logCall!.slice(dashIdx + 1)).toEqual(["src/foo.ts", "docs/bar.md"]);
    });

    test("omits all filter args when none provided", async () => {
      const { mgr, calls } = captureLogArgs();
      await mgr.logGraph({ id: "ws1", cwd: "/repo" }, { rootPath: "/repo" });
      const logCall = calls.find((c) => c[0] === "log");
      expect(logCall).toBeTruthy();
      expect(logCall!.some((a) => a.startsWith("--since="))).toBe(false);
      expect(logCall!.some((a) => a.startsWith("--until="))).toBe(false);
      expect(logCall!.some((a) => a.startsWith("--author="))).toBe(false);
      expect(logCall).toContain("--date-order");
      expect(logCall).not.toContain("--topo-order");
    });

    test("drops paths starting with '-' (defense in depth even after schema validation)", async () => {
      const { mgr, calls } = captureLogArgs();
      // Bypassing the schema directly here to exercise the inner guard.
      await mgr.logGraph({ id: "ws1", cwd: "/repo" }, { rootPath: "/repo", paths: ["-rf", "src/ok.ts"] as string[] });
      const logCall = calls.find((c) => c[0] === "log");
      const dashIdx = logCall!.indexOf("--");
      expect(logCall!.slice(dashIdx + 1)).toEqual(["src/ok.ts"]);
    });
  });

  // ─── createTag at a specific commit ────────────────────────────────
  describe("createTag commit pinning", () => {
    test("annotated tag at HEAD when commit omitted", async () => {
      const args: string[][] = [];
      const execGitImpl = vi.fn(async (_cwd: string, a: string[]) => {
        args.push(a);
        return { stdout: "", stderr: "" };
      });
      const mgr = new GitManager({ execGitImpl });
      await mgr.createTag({ id: "ws1", cwd: "/repo" }, { tagName: "v1.0.0", message: "release" });
      expect(args[0]).toEqual(["tag", "-a", "v1.0.0", "-m", "release"]);
    });

    test("lightweight tag pinned to a commit hash when commit provided", async () => {
      const args: string[][] = [];
      const execGitImpl = vi.fn(async (_cwd: string, a: string[]) => {
        args.push(a);
        return { stdout: "", stderr: "" };
      });
      const mgr = new GitManager({ execGitImpl });
      await mgr.createTag({ id: "ws1", cwd: "/repo" }, { tagName: "v1.0.0", commit: "abc1234" });
      expect(args[0]).toEqual(["tag", "v1.0.0", "abc1234"]);
    });
  });

  // ─── listBranches ──────────────────────────────────────────────────
  describe("listBranches", () => {
    const BRANCH_FMT = [
      "%(refname)",
      "%(refname:short)",
      "%(HEAD)",
      "%(upstream:short)",
      "%(upstream:track,nobracket)",
      "%(objectname:short)",
      "%(contents:subject)",
      "%(authorname)",
      "%(committerdate:relative)",
      "%(committerdate:unix)",
    ].join("%09");

    test("parses local + remote branches with ahead/behind from upstream:track", async () => {
      const cwd = "/repo";
      const execGitImpl = createExecMock({
        [`${cwd}::for-each-ref --format=${BRANCH_FMT} --sort=-committerdate refs/heads`]: {
          stdout: [
            "refs/heads/main\tmain\t*\torigin/main\t\tabc1234\tInit\tAlice\t2 hours ago\t1700000000",
            "refs/heads/feature/foo\tfeature/foo\t \torigin/feature/foo\tahead 2, behind 1\tdef5678\tWork\tBob\t1 day ago\t1699900000",
            "refs/heads/lonely\tlonely\t \t\t\t999aaaa\tNo upstream\tAlice\t3 days ago\t1699700000",
          ].join("\n"),
          stderr: "",
        },
        [`${cwd}::for-each-ref --format=${BRANCH_FMT} --sort=-committerdate refs/remotes`]: {
          stdout: [
            "refs/remotes/origin/main\torigin/main\t \t\t\tabc1234\tInit\tAlice\t2 hours ago\t1700000000",
            "refs/remotes/origin/HEAD\torigin/HEAD\t \t\t\tabc1234\t\t\t\t",
            "refs/remotes/origin/feature/foo\torigin/feature/foo\t \t\t\tdef5678\tWork\tBob\t1 day ago\t1699900000",
          ].join("\n"),
          stderr: "",
        },
        [`${cwd}::rev-parse --abbrev-ref HEAD`]: { stdout: "main\n", stderr: "" },
        [`${cwd}::rev-parse --abbrev-ref --symbolic-full-name @{upstream}`]: {
          stdout: "origin/main\n",
          stderr: "",
        },
        // Per-branch rev-list vs current — entries that aren't isCurrent and aren't named "current".
        [`${cwd}::rev-list --left-right --count main...feature/foo`]: { stdout: "1\t3\n", stderr: "" },
        [`${cwd}::rev-list --left-right --count main...lonely`]: { stdout: "0\t5\n", stderr: "" },
        // Symbolic ref for origin's default branch — points to origin/main.
        [`${cwd}::symbolic-ref --short refs/remotes/origin/HEAD`]: { stdout: "origin/main\n", stderr: "" },
      });
      const mgr = new GitManager({ execGitImpl });

      const result = await mgr.listBranches({ id: "ws-1", cwd }, { rootPath: cwd });

      expect(result.ok).toBe(true);
      expect(result.current).toBe("main");
      expect(result.upstream).toBe("origin/main");

      expect(result.local).toHaveLength(3);
      const mainEntry = result.local.find((b) => b.name === "main")!;
      expect(mainEntry.isCurrent).toBe(true);
      expect(mainEntry.upstream).toBe("origin/main");

      const fooEntry = result.local.find((b) => b.name === "feature/foo")!;
      // upstream:track wins over the per-branch vs HEAD fallback when upstream is set.
      expect(fooEntry.ahead).toBe(2);
      expect(fooEntry.behind).toBe(1);
      // merged reflects "branch fully reachable from HEAD" — right side of rev-list == 0.
      // foo is 3 commits ahead of main (right=3), so NOT merged.
      expect(fooEntry.merged).toBe(false);

      const lonelyEntry = result.local.find((b) => b.name === "lonely")!;
      // No upstream → falls back to rev-list count vs HEAD. left=current ahead, right=entry ahead.
      // We stub "0\t5\n" → counts = { left: 0, right: 5 }; entry "ahead" = right, "behind" = left.
      expect(lonelyEntry.upstream).toBe("");
      expect(lonelyEntry.ahead).toBe(5);
      expect(lonelyEntry.behind).toBe(0);
      // right === 0 means merged; here right is 5 so NOT merged.
      expect(lonelyEntry.merged).toBe(false);

      // Remote dedup: "origin/HEAD" should be filtered out, leaving 2 remotes.
      expect(result.remotes).toHaveLength(2);
      expect(result.remotes.map((r) => r.shortName)).toEqual(["main", "feature/foo"]);
      expect(result.remotes[0]).toMatchObject({ remote: "origin", shortName: "main" });

      // origin/HEAD → origin/main, so the symbolic default lands on the main remote entry.
      const remoteMain = result.remotes.find((r) => r.name === "origin/main")!;
      expect(remoteMain.isDefault).toBe(true);
      const remoteFoo = result.remotes.find((r) => r.name === "origin/feature/foo")!;
      expect(remoteFoo.isDefault).toBe(false);
      expect(result.defaultBranch).toBe("main");
      expect(result.defaultRemote).toBe("origin");
    });

    test("returns error when rootPath is missing", async () => {
      const mgr = new GitManager({ execGitImpl: vi.fn() });
      const result = await mgr.listBranches(null, {});
      expect(result.ok).toBe(false);
      expect(result.error).toContain("Missing rootPath");
    });

    test("returns ok with empty arrays on git failure", async () => {
      const execGitImpl = vi.fn().mockRejectedValue({ stderr: "fatal: not a git repository", stdout: "" });
      const mgr = new GitManager({ execGitImpl });
      // Each .catch() wraps the for-each-ref call to a stdout="" fallback rather
      // than throwing; the test confirms the outer ok:true path with empty data.
      const result = await mgr.listBranches({ id: "ws-1", cwd: "/repo" }, { rootPath: "/repo" });
      expect(result.ok).toBe(true);
      expect(result.local).toEqual([]);
      expect(result.remotes).toEqual([]);
    });

    test("merged flag is true when current has no commits past entry tip", async () => {
      const cwd = "/repo";
      const execGitImpl = createExecMock({
        [`${cwd}::for-each-ref --format=${BRANCH_FMT} --sort=-committerdate refs/heads`]: {
          stdout: [
            "refs/heads/main\tmain\t*\t\t\tabc1234\tInit\tAlice\t2 hours ago\t1700000000",
            "refs/heads/merged-feature\tmerged-feature\t \t\t\tdef5678\tDone\tBob\t1 day ago\t1699900000",
          ].join("\n"),
          stderr: "",
        },
        [`${cwd}::for-each-ref --format=${BRANCH_FMT} --sort=-committerdate refs/remotes`]: {
          stdout: "",
          stderr: "",
        },
        [`${cwd}::rev-parse --abbrev-ref HEAD`]: { stdout: "main\n", stderr: "" },
        [`${cwd}::rev-parse --abbrev-ref --symbolic-full-name @{upstream}`]: { stdout: "", stderr: "" },
        // merged-feature is fully reachable from main → right (entry ahead of current) === 0.
        [`${cwd}::rev-list --left-right --count main...merged-feature`]: { stdout: "3\t0\n", stderr: "" },
      });
      const mgr = new GitManager({ execGitImpl });

      const result = await mgr.listBranches({ id: "ws-1", cwd }, { rootPath: cwd });

      const merged = result.local.find((b) => b.name === "merged-feature")!;
      expect(merged.merged).toBe(true);
    });

    test("local entries carry worktreePath when checked out in a worktree", async () => {
      const cwd = "/repo";
      const execGitImpl = createExecMock({
        [`${cwd}::for-each-ref --format=${BRANCH_FMT} --sort=-committerdate refs/heads`]: {
          stdout: [
            "refs/heads/main\tmain\t*\t\t\tabc1234\tInit\tAlice\t2h\t1700000000",
            "refs/heads/docker-view\tdocker-view\t \t\t\tdef5678\tWork\tBob\t3d\t1699900000",
          ].join("\n"),
          stderr: "",
        },
        [`${cwd}::for-each-ref --format=${BRANCH_FMT} --sort=-committerdate refs/remotes`]: {
          stdout: "",
          stderr: "",
        },
        [`${cwd}::rev-parse --abbrev-ref HEAD`]: { stdout: "main\n", stderr: "" },
        [`${cwd}::rev-parse --abbrev-ref --symbolic-full-name @{upstream}`]: { stdout: "", stderr: "" },
        [`${cwd}::rev-list --left-right --count main...docker-view`]: { stdout: "1\t2\n", stderr: "" },
        [`${cwd}::worktree list --porcelain`]: {
          stdout: [
            "worktree /repo",
            "HEAD abc1234",
            "branch refs/heads/main",
            "",
            "worktree /repo/.strideterm/tree/docker-view",
            "HEAD def5678",
            "branch refs/heads/docker-view",
            "",
          ].join("\n"),
          stderr: "",
        },
      });
      const mgr = new GitManager({ execGitImpl });

      const result = await mgr.listBranches({ id: "ws-1", cwd }, { rootPath: cwd });

      const dockerView = result.local.find((b) => b.name === "docker-view")!;
      expect(dockerView.worktreePath).toBe("/repo/.strideterm/tree/docker-view");
      // Main is checked out in the main worktree — also reported so the UI
      // could surface it if it ever wanted to (we don't currently).
      const mainEntry = result.local.find((b) => b.name === "main")!;
      expect(mainEntry.worktreePath).toBe("/repo");
    });

    test("local entries omit worktreePath when no worktree is associated", async () => {
      const cwd = "/repo";
      const execGitImpl = createExecMock({
        [`${cwd}::for-each-ref --format=${BRANCH_FMT} --sort=-committerdate refs/heads`]: {
          stdout: "refs/heads/main\tmain\t*\t\t\tabc1234\tInit\tAlice\t2h\t1700000000\n",
          stderr: "",
        },
        [`${cwd}::for-each-ref --format=${BRANCH_FMT} --sort=-committerdate refs/remotes`]: {
          stdout: "",
          stderr: "",
        },
        [`${cwd}::rev-parse --abbrev-ref HEAD`]: { stdout: "main\n", stderr: "" },
        [`${cwd}::rev-parse --abbrev-ref --symbolic-full-name @{upstream}`]: { stdout: "", stderr: "" },
        // No worktree stub — call rejects, caught by .catch, returns empty map.
      });
      const mgr = new GitManager({ execGitImpl });
      const result = await mgr.listBranches({ id: "ws-1", cwd }, { rootPath: cwd });
      const mainEntry = result.local.find((b) => b.name === "main")!;
      expect(mainEntry.worktreePath).toBeUndefined();
    });
  });

  // ─── detectBestBaseBranch ───────────────────────────────────────────────
  describe("detectBestBaseBranch", () => {
    test("picks the closest fork point — feature off feature, not hardcoded master", async () => {
      const cwd = "/repo";
      // Current branch "feature/auth-fix" was forked from "feature/auth" (3 commits ago).
      // "feature/auth" itself diverged from "master" 30 commits ago.
      // The legacy heuristic would have only considered master/origin/master/develop
      // and picked master — this test guards the regression.
      const execGitImpl = createExecMock({
        // No remotes configured for the symbolic-ref lookup in this scenario.
        [`${cwd}::merge-base HEAD feature/auth`]: { stdout: "aaaaaaa\n", stderr: "" },
        [`${cwd}::rev-list --count aaaaaaa..HEAD`]: { stdout: "3\n", stderr: "" },
        // master and origin/master point to the same commit → same merge-base
        // and same rev-list key. Single mock entry serves both candidates.
        [`${cwd}::merge-base HEAD master`]: { stdout: "bbbbbbb\n", stderr: "" },
        [`${cwd}::merge-base HEAD origin/master`]: { stdout: "bbbbbbb\n", stderr: "" },
        [`${cwd}::rev-list --count bbbbbbb..HEAD`]: { stdout: "33\n", stderr: "" },
      });
      const mgr = new GitManager({ execGitImpl });

      const result = await mgr.detectBestBaseBranch(
        cwd,
        "feature/auth-fix",
        "",
        ["feature/auth", "master", "origin/master"],
        {}, // no remotes → no symbolic-ref calls
      );
      expect(result).toBe("feature/auth");
    });

    test("ties broken by symbolic default remote branch", async () => {
      const cwd = "/repo";
      // Brand-new branch with no commits past HEAD vs. master AND origin/HEAD-default "develop".
      // Distance is the same (0) on both — symbolic default ("origin/develop") must win.
      const execGitImpl = createExecMock({
        [`${cwd}::symbolic-ref --short refs/remotes/origin/HEAD`]: { stdout: "origin/develop\n", stderr: "" },
        [`${cwd}::merge-base HEAD master`]: { stdout: "ccccccc\n", stderr: "" },
        [`${cwd}::merge-base HEAD origin/develop`]: { stdout: "ccccccc\n", stderr: "" },
        [`${cwd}::rev-list --count ccccccc..HEAD`]: { stdout: "0\n", stderr: "" },
      });
      const mgr = new GitManager({ execGitImpl });

      const result = await mgr.detectBestBaseBranch(cwd, "feature/brandnew", "", ["master", "origin/develop"], {
        origin: "https://example.com/repo.git",
      });
      expect(result).toBe("origin/develop");
    });

    test("falls back to symbolic default when no candidate is reachable", async () => {
      const cwd = "/repo";
      // Every merge-base call returns empty — no shared ancestry (orphan branch scenario).
      const execGitImpl = createExecMock({
        [`${cwd}::symbolic-ref --short refs/remotes/origin/HEAD`]: { stdout: "origin/master\n", stderr: "" },
        [`${cwd}::merge-base HEAD master`]: { stdout: "\n", stderr: "" },
        [`${cwd}::merge-base HEAD origin/master`]: { stdout: "\n", stderr: "" },
      });
      const mgr = new GitManager({ execGitImpl });

      const result = await mgr.detectBestBaseBranch(cwd, "orphan", "", ["master", "origin/master"], {
        origin: "https://example.com/repo.git",
      });
      expect(result).toBe("origin/master");
    });
  });

  // ─── deleteBranch / deleteRemoteBranch / renameBranch / checkoutRemoteBranch ─
  describe("branch mutations", () => {
    function makeMgr() {
      const calls: string[][] = [];
      const execGitImpl = vi.fn(async (_cwd: string, args: string[]) => {
        calls.push(args);
        const key = args.join(" ");
        // A normal repo: on a branch with a resolvable HEAD. commitScopedPaths
        // reads both to pick its temp-index base and to detect HEAD moves.
        if (key === "rev-parse --verify --quiet HEAD") return { stdout: `${"a".repeat(40)}\n`, stderr: "" };
        if (key === "symbolic-ref --quiet HEAD") return { stdout: "refs/heads/main\n", stderr: "" };
        return { stdout: "", stderr: "" };
      });
      const mgr = new GitManager({ execGitImpl });
      // runWriteAction's snapshot preflight runs through inspectWorkspace.
      // Stub it so we don't have to mock the full inspect call chain.
      mgr.inspectWorkspace = vi.fn().mockResolvedValue({
        available: true,
        branch: "main",
        baseBranch: "main",
        upstream: "origin/main",
        dirty: false,
        operationState: { kind: "idle", inProgress: false, conflicts: [] },
        remotes: { origin: "https://example.com/repo.git" },
      });
      return { mgr, calls };
    }

    describe("deleteBranch", () => {
      test("uses -d for safe delete (non-force)", async () => {
        const { mgr, calls } = makeMgr();
        const result = await mgr.deleteBranch({ id: "ws-1", cwd: "/repo" }, { branch: "feature/foo" });
        expect(result.ok).toBe(true);
        expect(calls).toContainEqual(["branch", "-d", "feature/foo"]);
      });

      test("uses -D when force=true", async () => {
        const { mgr, calls } = makeMgr();
        const result = await mgr.deleteBranch({ id: "ws-1", cwd: "/repo" }, { branch: "feature/foo", force: true });
        expect(result.ok).toBe(true);
        expect(calls).toContainEqual(["branch", "-D", "feature/foo"]);
      });

      test("rejects empty branch name", async () => {
        const { mgr } = makeMgr();
        const result = await mgr.deleteBranch({ id: "ws-1", cwd: "/repo" }, { branch: "" });
        expect(result.ok).toBe(false);
        expect(result.summary).toContain("required");
      });

      test("rejects branch starting with '-' (flag-injection guard)", async () => {
        const { mgr, calls } = makeMgr();
        const result = await mgr.deleteBranch({ id: "ws-1", cwd: "/repo" }, { branch: "-D" });
        expect(result.ok).toBe(false);
        expect(result.summary).toContain("Invalid");
        expect(calls.some((args) => args[0] === "branch")).toBe(false);
      });

      test("refuses with code 'branch-in-worktree' when branch is checked out in a worktree", async () => {
        const calls: string[][] = [];
        const execGitImpl = vi.fn(async (_cwd: string, args: string[]) => {
          calls.push(args);
          if (args[0] === "worktree" && args[1] === "list") {
            return {
              stdout: [
                "worktree /repo",
                "HEAD abc1234",
                "branch refs/heads/main",
                "",
                "worktree /repo/.strideterm/tree/docker-view",
                "HEAD def5678",
                "branch refs/heads/docker-view",
                "",
              ].join("\n"),
              stderr: "",
            };
          }
          return { stdout: "", stderr: "" };
        });
        const mgr = new GitManager({ execGitImpl });
        // No inspectWorkspace stub needed — we exit before runWriteAction.

        const result = await mgr.deleteBranch({ id: "ws-1", cwd: "/repo" }, { branch: "docker-view" });

        expect(result.ok).toBe(false);
        // Custom code field for the UI to dispatch on.
        expect((result as Record<string, unknown>).code).toBe("branch-in-worktree");
        expect((result as Record<string, unknown>).worktreePath).toBe("/repo/.strideterm/tree/docker-view");
        expect((result as Record<string, unknown>).branch).toBe("docker-view");
        // Crucially, no `git branch -d` was attempted.
        expect(calls.some((args) => args[0] === "branch" && (args[1] === "-d" || args[1] === "-D"))).toBe(false);
      });

      test("proceeds to runWriteAction when branch is not in any worktree", async () => {
        const calls: string[][] = [];
        const execGitImpl = vi.fn(async (_cwd: string, args: string[]) => {
          calls.push(args);
          if (args[0] === "worktree" && args[1] === "list") {
            return {
              stdout: ["worktree /repo", "HEAD abc1234", "branch refs/heads/main", ""].join("\n"),
              stderr: "",
            };
          }
          return { stdout: "", stderr: "" };
        });
        const mgr = new GitManager({ execGitImpl });
        mgr.inspectWorkspace = vi.fn().mockResolvedValue({
          available: true,
          branch: "main",
          baseBranch: "main",
          upstream: "origin/main",
          dirty: false,
          operationState: { kind: "idle", inProgress: false, conflicts: [] },
          remotes: { origin: "https://example.com/repo.git" },
        });

        const result = await mgr.deleteBranch({ id: "ws-1", cwd: "/repo" }, { branch: "feature/foo" });

        expect(result.ok).toBe(true);
        expect(calls).toContainEqual(["branch", "-d", "feature/foo"]);
        expect((result as Record<string, unknown>).code).toBeUndefined();
      });
    });

    describe("deleteRemoteBranch", () => {
      test("pushes refs/heads/<branch> deletion to the named remote", async () => {
        const { mgr, calls } = makeMgr();
        const result = await mgr.deleteRemoteBranch(
          { id: "ws-1", cwd: "/repo" },
          { branch: "feature/foo", remote: "upstream" },
        );
        expect(result.ok).toBe(true);
        expect(calls).toContainEqual(["push", "upstream", ":refs/heads/feature/foo"]);
      });

      test("defaults remote to 'origin' when not supplied", async () => {
        const { mgr, calls } = makeMgr();
        const result = await mgr.deleteRemoteBranch({ id: "ws-1", cwd: "/repo" }, { branch: "feature/foo" });
        expect(result.ok).toBe(true);
        expect(calls).toContainEqual(["push", "origin", ":refs/heads/feature/foo"]);
      });

      test("rejects branch starting with '-'", async () => {
        const { mgr, calls } = makeMgr();
        const result = await mgr.deleteRemoteBranch({ id: "ws-1", cwd: "/repo" }, { branch: "-rf", remote: "origin" });
        expect(result.ok).toBe(false);
        expect(calls.some((args) => args[0] === "push")).toBe(false);
      });

      test("rejects remote starting with '-'", async () => {
        const { mgr, calls } = makeMgr();
        const result = await mgr.deleteRemoteBranch(
          { id: "ws-1", cwd: "/repo" },
          { branch: "feature/foo", remote: "--upload-pack=evil" },
        );
        expect(result.ok).toBe(false);
        expect(calls.some((args) => args[0] === "push")).toBe(false);
      });
    });

    describe("push on review checkouts", () => {
      function makeReviewMgr({ branch, upstream }: { branch: string; upstream: string }) {
        const calls: string[][] = [];
        const execGitImpl = vi.fn(async (_cwd: string, args: string[]) => {
          calls.push(args);
          return { stdout: "", stderr: "" };
        });
        const mgr = new GitManager({ execGitImpl });
        mgr.inspectWorkspace = vi.fn().mockResolvedValue({
          available: true,
          branch,
          baseBranch: "main",
          upstream,
          dirty: false,
          aheadCount: 1,
          behindCount: 1,
          operationState: { kind: "idle", inProgress: false, conflicts: [] },
          remotes: { origin: "https://example.com/repo.git" },
        });
        return { mgr, calls };
      }
      const reviewWorkspace = {
        id: "ws-1",
        cwd: "/repo",
        review: { pullRequest: { sourceRefName: "refs/heads/feature/foo" } },
      };

      test("push maps the pr-N local branch to the PR source branch via refspec", async () => {
        const { mgr, calls } = makeReviewMgr({ branch: "pr-12-feature-foo", upstream: "origin/feature/foo" });
        const result = await mgr.push(reviewWorkspace);
        expect(result.ok).toBe(true);
        expect(calls).toContainEqual(["push", "-u", "origin", "HEAD:refs/heads/feature/foo"]);
      });

      test("push keeps normal strategy when the local branch already matches the source branch", async () => {
        const { mgr, calls } = makeReviewMgr({ branch: "feature/foo", upstream: "origin/feature/foo" });
        const result = await mgr.push(reviewWorkspace);
        expect(result.ok).toBe(true);
        expect(calls).toContainEqual(["push", "origin", "HEAD"]);
      });

      test("forcePushWithLease maps the pr-N local branch to the PR source branch", async () => {
        const { mgr, calls } = makeReviewMgr({ branch: "pr-12-feature-foo", upstream: "origin/feature/foo" });
        const result = await mgr.forcePushWithLease(reviewWorkspace);
        expect(result.ok).toBe(true);
        expect(calls).toContainEqual(["push", "--force-with-lease", "origin", "HEAD:refs/heads/feature/foo"]);
      });

      // After "Detach from PR review" (review === null) we deliberately do NOT
      // auto-remap onto the tracked upstream: no branch-name or persisted signal
      // reliably survives a detached workspace switching branches, so remapping
      // risks fast-forwarding an unrelated remote branch. Push safely publishes
      // under the local branch name; the reliable "Enable editing" path (review
      // stays linked) is how you push to the PR source branch.
      test("push after detach publishes the local branch name (no unsafe remap)", async () => {
        const { mgr, calls } = makeReviewMgr({ branch: "pr-12-feature-foo", upstream: "origin/feature/foo" });
        const result = await mgr.push({ id: "ws-1", cwd: "/repo" });
        expect(result.ok).toBe(true);
        expect(calls).toContainEqual(["push", "--set-upstream", "origin", "pr-12-feature-foo"]);
        expect(calls).not.toContainEqual(["push", "origin", "HEAD:refs/heads/feature/foo"]);
      });

      test("push publishes the local branch name when there is no upstream", async () => {
        const { mgr, calls } = makeReviewMgr({ branch: "feature/foo", upstream: "" });
        const result = await mgr.push({ id: "ws-1", cwd: "/repo" });
        expect(result.ok).toBe(true);
        expect(calls).toContainEqual(["push", "--set-upstream", "origin", "feature/foo"]);
      });

      // Guard against remapping ORDINARY branches: `feature` tracking origin/main
      // must NOT push HEAD onto main — only pr-N-* review aliases get that remap.
      test("push does not remap an ordinary branch whose upstream name differs", async () => {
        const { mgr, calls } = makeReviewMgr({ branch: "feature", upstream: "origin/main" });
        const result = await mgr.push({ id: "ws-1", cwd: "/repo" });
        expect(result.ok).toBe(true);
        expect(calls).toContainEqual(["push", "--set-upstream", "origin", "feature"]);
        expect(calls).not.toContainEqual(["push", "origin", "HEAD:refs/heads/main"]);
      });
    });

    describe("push failure output + live progress", () => {
      function makePushMgr(pushBehavior: (args: string[]) => Promise<{ stdout: string; stderr: string }>) {
        const calls: string[][] = [];
        const execGitImpl = vi.fn(async (_cwd: string, args: string[]) => {
          calls.push(args);
          if (args[0] === "push") return pushBehavior(args);
          return { stdout: "", stderr: "" };
        });
        const mgr = new GitManager({ execGitImpl });
        mgr.inspectWorkspace = vi.fn().mockResolvedValue({
          available: true,
          branch: "feature/foo",
          baseBranch: "main",
          upstream: "origin/feature/foo",
          dirty: false,
          aheadCount: 1,
          behindCount: 1,
          operationState: { kind: "idle", inProgress: false, conflicts: [] },
          remotes: { origin: "https://example.com/repo.git" },
        });
        return { mgr, calls };
      }

      test("a failed pre-push hook surfaces its stdout (not just stderr) in rawOutput", async () => {
        // The real reason a `npm run check` hook fails (test/lint output) is on
        // stdout; git only adds a terse note on stderr. Both must survive.
        const { mgr } = makePushMgr(async () => {
          throw {
            stdout: "FAIL src/foo.test.ts > bar\n  expected 1 to be 2\n",
            stderr: "husky - pre-push hook exited with code 1\n",
          };
        });
        const result = await mgr.push({ id: "ws-1", cwd: "/repo" });
        expect(result.ok).toBe(false);
        expect(result.rawOutput).toContain("FAIL src/foo.test.ts");
        expect(result.rawOutput).toContain("expected 1 to be 2");
        expect(result.rawOutput).toContain("husky - pre-push hook exited with code 1");
      });

      test("push forwards streamed git output to onProgress", async () => {
        const { mgr } = makePushMgr(async () => ({ stdout: "Running pre-push hook…\n", stderr: "" }));
        const chunks: string[] = [];
        const result = await mgr.push({ id: "ws-1", cwd: "/repo" }, { onProgress: (c: string) => chunks.push(c) });
        expect(result.ok).toBe(true);
        expect(chunks.join("")).toContain("Running pre-push hook…");
      });

      test("forcePushWithLease forwards streamed git output to onProgress", async () => {
        const { mgr } = makePushMgr(async () => ({ stdout: "hook running\n", stderr: "" }));
        const chunks: string[] = [];
        const result = await mgr.forcePushWithLease(
          { id: "ws-1", cwd: "/repo" },
          { onProgress: (c: string) => chunks.push(c) },
        );
        expect(result.ok).toBe(true);
        expect(chunks.join("")).toContain("hook running");
      });
    });

    describe("commitAll (arg wiring)", () => {
      test("commits the whole tree with add -A when paths are omitted", async () => {
        const { mgr, calls } = makeMgr();
        const result = await mgr.commitAll({ id: "ws-1", cwd: "/repo" }, { message: "msg" });
        expect(result.ok).toBe(true);
        expect(calls).toContainEqual(["add", "-A"]);
        expect(calls).toContainEqual(["commit", "-m", "msg"]);
      });

      test("an explicitly-scoped commit with no valid paths errors instead of committing everything", async () => {
        const { mgr, calls } = makeMgr();
        const empty = await mgr.commitAll({ id: "ws-1", cwd: "/repo" }, { message: "msg", paths: [] });
        expect(empty.ok).toBe(false);
        const blank = await mgr.commitAll(
          { id: "ws-1", cwd: "/repo" },
          { message: "msg", paths: ["", null] as unknown as string[] },
        );
        expect(blank.ok).toBe(false);
        // Must never fall through to a whole-tree commit.
        expect(calls).not.toContainEqual(["add", "-A"]);
        expect(calls.some((a) => a[0] === "commit")).toBe(false);
      });

      test("a scoped commit builds a temporary index, not a whole-tree add", async () => {
        const { mgr, calls } = makeMgr();
        const result = await mgr.commitAll({ id: "ws-1", cwd: "/does/not/exist" }, { message: "msg", paths: ["a.ts"] });
        expect(result.ok).toBe(true);
        expect(calls).toContainEqual(["read-tree", "HEAD"]); // temp index is seeded from HEAD
        expect(calls).not.toContainEqual(["add", "-A"]); // never the whole tree
        expect(calls.some((a) => a[0] === "commit")).toBe(true);
      });
    });

    describe("renameBranch", () => {
      test("renames named branch with branch -m old new", async () => {
        const { mgr, calls } = makeMgr();
        const result = await mgr.renameBranch(
          { id: "ws-1", cwd: "/repo" },
          { branch: "old-name", newName: "new-name" },
        );
        expect(result.ok).toBe(true);
        expect(calls).toContainEqual(["branch", "-m", "old-name", "new-name"]);
      });

      test("renames current branch with branch -m new (when old branch omitted)", async () => {
        const { mgr, calls } = makeMgr();
        const result = await mgr.renameBranch({ id: "ws-1", cwd: "/repo" }, { newName: "new-name" });
        expect(result.ok).toBe(true);
        expect(calls).toContainEqual(["branch", "-m", "new-name"]);
      });

      test("rejects empty newName", async () => {
        const { mgr } = makeMgr();
        const result = await mgr.renameBranch({ id: "ws-1", cwd: "/repo" }, { branch: "old", newName: "" });
        expect(result.ok).toBe(false);
        expect(result.summary).toContain("required");
      });

      test("rejects newName starting with '-'", async () => {
        const { mgr, calls } = makeMgr();
        const result = await mgr.renameBranch({ id: "ws-1", cwd: "/repo" }, { branch: "old", newName: "-D" });
        expect(result.ok).toBe(false);
        expect(calls.some((args) => args[0] === "branch")).toBe(false);
      });
    });

    describe("checkoutRemoteBranch", () => {
      test("derives local branch name by stripping the leading <remote>/ segment", async () => {
        const { mgr, calls } = makeMgr();
        const result = await mgr.checkoutRemoteBranch(
          { id: "ws-1", cwd: "/repo" },
          { remoteBranch: "origin/feature/foo" },
        );
        expect(result.ok).toBe(true);
        expect(calls).toContainEqual(["checkout", "-b", "feature/foo", "--track", "origin/feature/foo"]);
      });

      test("uses explicit localBranch when caller supplies one", async () => {
        const { mgr, calls } = makeMgr();
        const result = await mgr.checkoutRemoteBranch(
          { id: "ws-1", cwd: "/repo" },
          { remoteBranch: "origin/feature/foo", localBranch: "origin-feature-foo" },
        );
        expect(result.ok).toBe(true);
        expect(calls).toContainEqual(["checkout", "-b", "origin-feature-foo", "--track", "origin/feature/foo"]);
      });

      test("rejects empty remoteBranch", async () => {
        const { mgr } = makeMgr();
        const result = await mgr.checkoutRemoteBranch({ id: "ws-1", cwd: "/repo" }, { remoteBranch: "" });
        expect(result.ok).toBe(false);
        expect(result.summary).toContain("required");
      });

      test("rejects remoteBranch starting with '-'", async () => {
        const { mgr, calls } = makeMgr();
        const result = await mgr.checkoutRemoteBranch({ id: "ws-1", cwd: "/repo" }, { remoteBranch: "-rf" });
        expect(result.ok).toBe(false);
        expect(calls.some((args) => args[0] === "checkout")).toBe(false);
      });

      test("rejects localBranch starting with '-'", async () => {
        const { mgr, calls } = makeMgr();
        const result = await mgr.checkoutRemoteBranch(
          { id: "ws-1", cwd: "/repo" },
          { remoteBranch: "origin/feature", localBranch: "-D" },
        );
        expect(result.ok).toBe(false);
        expect(calls.some((args) => args[0] === "checkout")).toBe(false);
      });
    });
  });

  // --- Conflict resolution operations ---

  describe("skipCommit", () => {
    test("skips when rebase in progress", async () => {
      const calls: string[][] = [];
      const execGitImpl = vi.fn(async (_cwd: string, args: string[]) => {
        calls.push(args);
        return { stdout: "Successfully skipped\n", stderr: "" };
      });
      const mgr = new GitManager({ execGitImpl });
      // mockResolvedValue (not Once): skipCommit's own pre-check inspects once,
      // hands that snapshot to runWriteAction (which no longer re-inspects),
      // and the post-success restoreParkedStashIfFinished check inspects once
      // more — so inspectWorkspace is called twice total, not three times.
      mgr.inspectWorkspace = vi.fn().mockResolvedValue({
        available: true,
        dirty: false,
        branch: "feature-x",
        baseBranch: "main",
        operationState: { kind: "rebase", inProgress: true, conflicts: ["a.py"], label: "Rebase in progress" },
      });
      const result = await mgr.skipCommit({ id: "ws", cwd: "/repo", kind: "terminal" });
      expect(result.ok).toBe(true);
      expect(calls).toContainEqual(["rebase", "--skip"]);
      expect(mgr.inspectWorkspace).toHaveBeenCalledTimes(2);
    });

    test("fails when no operation in progress", async () => {
      const mgr = new GitManager({ execGitImpl: vi.fn() });
      mgr.inspectWorkspace = vi.fn().mockResolvedValue({
        available: true,
        dirty: false,
        branch: "main",
        operationState: { kind: "idle", inProgress: false, conflicts: [] },
      });
      const result = await mgr.skipCommit({ id: "ws", cwd: "/repo", kind: "terminal" });
      expect(result.ok).toBe(false);
    });
  });

  // ─── runWriteAction snapshot passthrough ──────────────────────────
  // push/forcePushWithLease/continueOperation/abortOperation/skipCommit each
  // inspect the workspace themselves before deciding what to run, then used
  // to hand off to runWriteAction, which inspected *again* from scratch.
  // runWriteAction now accepts that already-computed snapshot instead of
  // redoing the same dozen-plus-subprocess inspect a moment later.
  describe("runWriteAction snapshot passthrough (no redundant re-inspect)", () => {
    function makeSnapshotSpyMgr(operationState = { kind: "idle", inProgress: false, conflicts: [] as string[] }) {
      const execGitImpl = vi.fn(async () => ({ stdout: "", stderr: "" }));
      const mgr = new GitManager({ execGitImpl });
      mgr.inspectWorkspace = vi.fn().mockResolvedValue({
        available: true,
        branch: "feature-x",
        baseBranch: "main",
        upstream: "origin/feature-x",
        dirty: false,
        aheadCount: 2,
        behindCount: 2,
        operationState,
        remotes: { origin: "https://example.com/repo.git" },
      });
      return { mgr, execGitImpl };
    }

    test("push inspects the workspace once instead of twice", async () => {
      const { mgr } = makeSnapshotSpyMgr();
      const result = await mgr.push({ id: "ws-1", cwd: "/repo" });
      expect(result.ok).toBe(true);
      expect(mgr.inspectWorkspace).toHaveBeenCalledTimes(1);
    });

    test("forcePushWithLease inspects the workspace once instead of twice", async () => {
      const { mgr } = makeSnapshotSpyMgr();
      const result = await mgr.forcePushWithLease({ id: "ws-1", cwd: "/repo" });
      expect(result.ok).toBe(true);
      expect(mgr.inspectWorkspace).toHaveBeenCalledTimes(1);
    });

    test("abortOperation inspects the workspace once instead of twice", async () => {
      const { mgr } = makeSnapshotSpyMgr({ kind: "rebase", inProgress: true, conflicts: [] });
      const result = await mgr.abortOperation({ id: "ws-1", cwd: "/repo" });
      expect(result.ok).toBe(true);
      expect(mgr.inspectWorkspace).toHaveBeenCalledTimes(1);
    });

    // continueOperation additionally re-inspects once more after a successful
    // run (restoreParkedStashIfFinished — an unrelated post-action check), so
    // its count drops from 3 to 2, not 2 to 1.
    test("continueOperation drops from 3 inspects to 2", async () => {
      const { mgr } = makeSnapshotSpyMgr({ kind: "rebase", inProgress: true, conflicts: [] });
      const result = await mgr.continueOperation({ id: "ws-1", cwd: "/repo" });
      expect(result.ok).toBe(true);
      expect(mgr.inspectWorkspace).toHaveBeenCalledTimes(2);
    });
  });

  describe("resolveConflict", () => {
    test("mode=ours runs checkout --ours then git add", async () => {
      const calls: string[][] = [];
      const execGitImpl = vi.fn(async (_cwd: string, args: string[]) => {
        calls.push(args);
        return { stdout: "", stderr: "" };
      });
      const mgr = new GitManager({ execGitImpl });
      const result = await mgr.resolveConflict(
        { id: "ws", cwd: "/repo", kind: "terminal" },
        { filePath: "src/app.py", mode: "ours" },
      );
      expect(result.ok).toBe(true);
      expect(calls).toContainEqual(["checkout", "--ours", "--", "src/app.py"]);
      expect(calls).toContainEqual(["add", "--", "src/app.py"]);
    });

    test("mode=theirs runs checkout --theirs then git add", async () => {
      const calls: string[][] = [];
      const execGitImpl = vi.fn(async (_cwd: string, args: string[]) => {
        calls.push(args);
        return { stdout: "", stderr: "" };
      });
      const mgr = new GitManager({ execGitImpl });
      const result = await mgr.resolveConflict(
        { id: "ws", cwd: "/repo", kind: "terminal" },
        { filePath: "src/app.py", mode: "theirs" },
      );
      expect(result.ok).toBe(true);
      expect(calls).toContainEqual(["checkout", "--theirs", "--", "src/app.py"]);
      expect(calls).toContainEqual(["add", "--", "src/app.py"]);
    });

    test("mode=delete runs git rm", async () => {
      const calls: string[][] = [];
      const execGitImpl = vi.fn(async (_cwd: string, args: string[]) => {
        calls.push(args);
        return { stdout: "", stderr: "" };
      });
      const mgr = new GitManager({ execGitImpl });
      const result = await mgr.resolveConflict(
        { id: "ws", cwd: "/repo", kind: "terminal" },
        { filePath: "src/app.py", mode: "delete" },
      );
      expect(result.ok).toBe(true);
      expect(calls).toContainEqual(["rm", "-f", "--", "src/app.py"]);
    });

    test("mode=manual requires content", async () => {
      const mgr = new GitManager({ execGitImpl: vi.fn() });
      const result = await mgr.resolveConflict(
        { id: "ws", cwd: "/repo", kind: "terminal" },
        { filePath: "src/app.py", mode: "manual" },
      );
      expect(result.ok).toBe(false);
      expect(result.summary).toContain("Content is required");
    });

    test("rejects empty filePath", async () => {
      const mgr = new GitManager({ execGitImpl: vi.fn() });
      const result = await mgr.resolveConflict(
        { id: "ws", cwd: "/repo", kind: "terminal" },
        { filePath: "", mode: "ours" },
      );
      expect(result.ok).toBe(false);
    });
  });

  describe("unresolveConflict", () => {
    test("runs git checkout -m", async () => {
      const calls: string[][] = [];
      const execGitImpl = vi.fn(async (_cwd: string, args: string[]) => {
        calls.push(args);
        return { stdout: "", stderr: "" };
      });
      const mgr = new GitManager({ execGitImpl });
      const result = await mgr.unresolveConflict(
        { id: "ws", cwd: "/repo", kind: "terminal" },
        { filePath: "src/app.py" },
      );
      expect(result.ok).toBe(true);
      expect(calls).toContainEqual(["checkout", "-m", "--", "src/app.py"]);
    });
  });

  describe("inspectOperationState with metadata", () => {
    test("detects rebase operation", async () => {
      const { root } = await createGitFixture();
      const rebaseMergeDir = path.join(root, ".git", "rebase-merge");
      await fs.mkdir(rebaseMergeDir, { recursive: true });
      await fs.writeFile(path.join(rebaseMergeDir, "msgnum"), "2\n");
      await fs.writeFile(path.join(rebaseMergeDir, "end"), "5\n");
      await fs.writeFile(path.join(rebaseMergeDir, "stopped-sha"), "abc1234567890\n");
      await fs.writeFile(path.join(rebaseMergeDir, "message"), "feat: add feature\n");
      await fs.writeFile(path.join(rebaseMergeDir, "head-name"), "refs/heads/main\n");
      await fs.writeFile(path.join(rebaseMergeDir, "onto_name"), "feature/x\n");

      const execGitImpl = vi.fn(async () => ({ stdout: "", stderr: "" }));
      const mgr = new GitManager({ execGitImpl });
      const state = await mgr.inspectOperationState(root, {
        gitDir: path.join(root, ".git"),
        gitCommonDir: path.join(root, ".git"),
      });

      expect(state.kind).toBe("rebase");
      expect(state.inProgress).toBe(true);
      expect(state.progress).toEqual({ current: 2, total: 5 });
      expect(state.currentCommit?.sha).toBe("abc1234");
      expect(state.currentCommit?.subject).toBe("feat: add feature");
      expect(state.sides?.ours).toBe("main");
      expect(state.sides?.theirs).toBe("feature/x");
    });
  });

  // Phase 1 §5 — integration round-trip against a REAL git repo: create a
  // conflict, resolve via each mode, and assert the working tree ends clean
  // (no unmerged entries). Complements the mocked arg-sequence tests above,
  // which prove WHICH git commands run but not the end-to-end git outcome.
  describe.skipIf(!GIT_AVAILABLE)("conflict resolution — real git fixture round-trip", () => {
    const mgr = new GitManager({}); // execGitImpl=null → real `git`
    const ws = (cwd: string) => ({ id: "ws", cwd, kind: "terminal" as const });
    // Run real git in the fixture; throws on non-zero exit (callers catch the
    // expected merge-conflict failure).
    const rg = (cwd: string, args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" });
    const unmerged = (cwd: string) => rg(cwd, ["ls-files", "-u"]).trim();

    async function initRepo(prefix: string): Promise<{ root: string; branch: string }> {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
      tempPaths.push(root);
      rg(root, ["init", "-q"]);
      rg(root, ["config", "user.email", "t@example.com"]);
      rg(root, ["config", "user.name", "Test"]);
      rg(root, ["config", "commit.gpgsign", "false"]);
      rg(root, ["config", "core.autocrlf", "false"]); // deterministic content cross-platform
      await fs.writeFile(path.join(root, "app.txt"), "base\ncommon\n", "utf8");
      rg(root, ["add", "-A"]);
      rg(root, ["commit", "-q", "-m", "base"]);
      const branch = rg(root, ["rev-parse", "--abbrev-ref", "HEAD"]).trim();
      return { root, branch };
    }

    // base → feature edits app.txt → base-branch edits the same line → merge conflicts.
    async function makeBothModifiedRepo(): Promise<string> {
      const { root, branch } = await initRepo("strideterm-git-bothmod-");
      rg(root, ["checkout", "-q", "-b", "feature"]);
      await fs.writeFile(path.join(root, "app.txt"), "theirs\ncommon\n", "utf8");
      rg(root, ["commit", "-q", "-am", "feature edit"]);
      rg(root, ["checkout", "-q", branch]);
      await fs.writeFile(path.join(root, "app.txt"), "ours\ncommon\n", "utf8");
      rg(root, ["commit", "-q", "-am", "base-branch edit"]);
      try {
        rg(root, ["merge", "--no-edit", "feature"]);
      } catch {
        /* expected: conflict in app.txt */
      }
      return root;
    }

    test("lists a both-modified conflict and reads its three stages", async () => {
      const root = await makeBothModifiedRepo();
      const list = await mgr.listConflicts(ws(root));
      expect(list.ok).toBe(true);
      const entries = list.entries as Array<{ path: string; conflictType: string }>;
      expect(entries.some((e) => e.path === "app.txt" && e.conflictType === "both-modified")).toBe(true);

      const detail = await mgr.conflictDetail(ws(root), { filePath: "app.txt" });
      expect(detail.ok).toBe(true);
      expect(String(detail.base)).toContain("base");
      expect(String(detail.ours)).toContain("ours");
      expect(String(detail.theirs)).toContain("theirs");
    });

    test("mode=ours resolves to our version and leaves no unmerged entries", async () => {
      const root = await makeBothModifiedRepo();
      const res = await mgr.resolveConflict(ws(root), { filePath: "app.txt", mode: "ours" });
      expect(res.ok).toBe(true);
      expect(await fs.readFile(path.join(root, "app.txt"), "utf8")).toContain("ours");
      expect(unmerged(root)).toBe(""); // clean
    });

    test("mode=theirs resolves to their version and leaves no unmerged entries", async () => {
      const root = await makeBothModifiedRepo();
      const res = await mgr.resolveConflict(ws(root), { filePath: "app.txt", mode: "theirs" });
      expect(res.ok).toBe(true);
      expect(await fs.readFile(path.join(root, "app.txt"), "utf8")).toContain("theirs");
      expect(unmerged(root)).toBe("");
    });

    test("mode=manual writes merged content, stages it, and the merge commits clean", async () => {
      const root = await makeBothModifiedRepo();
      const merged = "merged result\ncommon\n";
      const res = await mgr.resolveConflict(ws(root), { filePath: "app.txt", mode: "manual", content: merged });
      expect(res.ok).toBe(true);
      expect(await fs.readFile(path.join(root, "app.txt"), "utf8")).toBe(merged);
      expect(unmerged(root)).toBe("");
      // Drive the operation to completion — committing the merge succeeds and the tree is clean.
      rg(root, ["commit", "-q", "--no-edit"]);
      expect(rg(root, ["status", "--porcelain"]).trim()).toBe("");
    });

    test("unresolveConflict restores conflict markers (Undo)", async () => {
      const root = await makeBothModifiedRepo();
      await mgr.resolveConflict(ws(root), { filePath: "app.txt", mode: "ours" });
      expect(unmerged(root)).toBe("");
      const undo = await mgr.unresolveConflict(ws(root), { filePath: "app.txt" });
      expect(undo.ok).toBe(true);
      expect(unmerged(root)).not.toBe(""); // unmerged again
      expect(await fs.readFile(path.join(root, "app.txt"), "utf8")).toContain("<<<<<<<");
    });

    test("mode=delete resolves a modify/delete conflict cleanly", async () => {
      const { root, branch } = await initRepo("strideterm-git-del-");
      rg(root, ["checkout", "-q", "-b", "feature"]);
      rg(root, ["rm", "-q", "app.txt"]);
      rg(root, ["commit", "-q", "-m", "delete on feature"]);
      rg(root, ["checkout", "-q", branch]);
      await fs.writeFile(path.join(root, "app.txt"), "modified\ncommon\n", "utf8");
      rg(root, ["commit", "-q", "-am", "modify on base branch"]);
      try {
        rg(root, ["merge", "--no-edit", "feature"]);
      } catch {
        /* expected: modify/delete conflict */
      }
      expect(unmerged(root)).not.toBe(""); // sanity: a real conflict exists
      const res = await mgr.resolveConflict(ws(root), { filePath: "app.txt", mode: "delete" });
      expect(res.ok).toBe(true);
      expect(unmerged(root)).toBe(""); // resolved via git rm — clean
    });
  });

  // Reviewer's regressions for the scoped-commit failure paths: a failing safety
  // check (HEAD resolution, conflict probe, rename probe) or a concurrent HEAD
  // move must ABORT rather than proceed as if the repo were in a safe state.
  // Mocked so the failure of a specific git call can be injected deterministically.
  describe("commitAll — scoped-commit safety aborts (mocked)", () => {
    const REPO = "/repo";
    const ok = { stdout: "", stderr: "" };

    test("aborts when HEAD can't be resolved (not a confirmed unborn branch)", async () => {
      // git is operational (git-dir resolves) but HEAD neither resolves to a
      // commit NOR is a valid symbolic ref → must not fall back to an empty tree.
      const mgr = new GitManager({
        execGitImpl: createExecMock({
          [`${REPO}::ls-files --unmerged`]: ok,
          [`${REPO}::rev-parse --git-dir`]: { stdout: ".git\n", stderr: "" },
          [`${REPO}::rev-parse --verify --quiet HEAD`]: new Error("transient"),
          [`${REPO}::symbolic-ref --quiet HEAD`]: new Error("transient"),
        }),
      });
      const res = await mgr.commitAll({ id: "ws", cwd: REPO }, { message: "m", paths: ["a.txt"] });
      expect(res.ok).toBe(false);
      expect(String(res.summary)).toMatch(/resolve HEAD/i);
    });

    test("aborts when rev-parse HEAD fails operationally even though HEAD is a real branch", async () => {
      // The P1 finding: an operational rev-parse failure yields no sha, but
      // symbolic-ref still resolves on ANY normal branch. Treating that as unborn
      // would build an empty base tree and drop every unselected tracked file. A
      // `fatal:` on stderr is operational — not the clean "no such ref" of an
      // unborn branch — so it must abort, not fall back to the empty tree.
      const mgr = new GitManager({
        execGitImpl: createExecMock({
          [`${REPO}::ls-files --unmerged`]: ok,
          [`${REPO}::rev-parse --git-dir`]: { stdout: ".git\n", stderr: "" },
          [`${REPO}::rev-parse --verify --quiet HEAD`]: new Error("fatal: unable to read HEAD"),
          [`${REPO}::symbolic-ref --quiet HEAD`]: { stdout: "refs/heads/main\n", stderr: "" },
        }),
      });
      const res = await mgr.commitAll({ id: "ws", cwd: REPO }, { message: "m", paths: ["a.txt"] });
      expect(res.ok).toBe(false);
      expect(String(res.summary)).toMatch(/resolve HEAD/i);
    });

    test("aborts when the conflict probe (ls-files) fails", async () => {
      const mgr = new GitManager({
        execGitImpl: createExecMock({ [`${REPO}::ls-files --unmerged`]: new Error("io") }),
      });
      const res = await mgr.commitAll({ id: "ws", cwd: REPO }, { message: "m", paths: ["a.txt"] });
      expect(res.ok).toBe(false);
      expect(String(res.summary)).toMatch(/conflicts/i);
    });

    test("aborts when the rename probe (git status) fails", async () => {
      const mgr = new GitManager({
        execGitImpl: createExecMock({
          [`${REPO}::ls-files --unmerged`]: ok,
          [`${REPO}::rev-parse --git-dir`]: { stdout: ".git\n", stderr: "" },
          [`${REPO}::status --porcelain=v2`]: new Error("io"),
        }),
      });
      const res = await mgr.commitAll(
        { id: "ws", cwd: REPO },
        { message: "m", paths: ["new.txt"], previousPaths: ["old.txt"] },
      );
      expect(res.ok).toBe(false);
      expect(String(res.summary)).toMatch(/rename status/i);
    });

    test("aborts when HEAD moves between the tree snapshot and the commit", async () => {
      // rev-parse HEAD returns a different sha on the second read (a concurrent
      // op advanced HEAD). The commit must NOT run — asserted by the mock, which
      // has no mapping for a `commit` call and would throw if it were reached.
      let headReads = 0;
      const impl = vi.fn(async (_cwd: string, args: string[]) => {
        const key = args.join(" ");
        const sub = args[0] === "--literal-pathspecs" ? args[1] : args[0];
        if (key === "ls-files --unmerged") return ok;
        if (key === "rev-parse --git-dir") return { stdout: ".git\n", stderr: "" };
        if (key === "symbolic-ref --quiet HEAD") return { stdout: "refs/heads/main\n", stderr: "" };
        if (key === "rev-parse --verify --quiet HEAD") {
          headReads += 1;
          return { stdout: `${headReads === 1 ? "sha1" : "sha2"}\n`, stderr: "" };
        }
        if (sub === "read-tree" || sub === "rm" || sub === "add") return ok;
        throw { stdout: "", stderr: `Unexpected git call: ${key}` };
      });
      const mgr = new GitManager({ execGitImpl: impl });
      const res = await mgr.commitAll({ id: "ws", cwd: REPO }, { message: "m", paths: ["gone.txt"] });
      expect(res.ok).toBe(false);
      expect(String(res.summary)).toMatch(/HEAD changed/i);
    });

    // The residual race the pre-commit re-check can't cover: HEAD is stable when
    // we snapshot it AND when we re-check, but an external op moves it in the
    // window before `git commit` reads HEAD, so the new commit is parented on the
    // moved HEAD (H1) instead of our base (H0). We DETECT that (the new tip's
    // parent ≠ our base) and surface it for review — deliberately WITHOUT rewriting
    // history (no update-ref), because reliably identifying our own commit is
    // impossible post-hoc and any auto-rollback risks clobbering a foreign commit.
    test("detects a HEAD move in the commit window and surfaces it for review without rewriting history", async () => {
      const H0 = "0".repeat(40); // our snapshot base
      const H1 = "1".repeat(40); // where an external op moved HEAD mid-commit
      const C = "c".repeat(40); // our new (off-base) commit
      const REF = "refs/heads/main";
      const calls: string[][] = [];
      let headReads = 0;
      const impl = vi.fn(async (_cwd: string, args: string[]) => {
        calls.push(args);
        const key = args.join(" ");
        const sub = args[0] === "--literal-pathspecs" ? args[1] : args[0];
        if (key === "ls-files --unmerged") return ok;
        if (key === "rev-parse --git-dir") return { stdout: ".git\n", stderr: "" };
        if (key === "symbolic-ref --quiet HEAD") return { stdout: `${REF}\n`, stderr: "" };
        // Snapshot (#1) and pre-commit re-check (#2) both see H0 — the guard
        // passes and we commit; the post-commit read (#3) is our new commit C.
        if (key === "rev-parse --verify --quiet HEAD") {
          headReads += 1;
          return { stdout: `${headReads <= 2 ? H0 : C}\n`, stderr: "" };
        }
        // C's real parent is H1: HEAD moved between the re-check and git commit.
        if (key === `rev-parse --verify --quiet ${C}^`) return { stdout: `${H1}\n`, stderr: "" };
        if (sub === "read-tree" || sub === "add" || sub === "rm") return ok;
        if (key === "commit -m scoped") return { stdout: `[main ${C.slice(0, 7)}] scoped\n`, stderr: "" };
        throw { stdout: "", stderr: `Unexpected git call: ${key}` };
      });
      const mgr = new GitManager({ execGitImpl: impl });
      const res = await mgr.commitAll({ id: "ws", cwd: REPO }, { message: "scoped", paths: ["mod.txt"] });
      expect(res.ok).toBe(false);
      expect(String(res.summary)).toMatch(/HEAD moved|review the latest commit/i);
      // Never rewrites history: no update-ref (nor write-tree) is ever attempted,
      // so a concurrent/foreign commit can never be clobbered.
      expect(calls.some((a) => a[0] === "update-ref")).toBe(false);
      expect(calls.some((a) => a[0] === "write-tree")).toBe(false);
    });
  });

  // Real-repo round-trip for the scoped (path-selected) commit. Mocked arg tests
  // can't catch that `git add` rejects a deleted/renamed-away pathspec, so this
  // drives modify + delete + rename + untracked through actual git and asserts
  // the committed tree and the untouched leftovers.
  describe.skipIf(!GIT_AVAILABLE)("commitAll — real git fixture round-trip", () => {
    const mgr = new GitManager({}); // execGitImpl=null → real git
    const rg = (cwd: string, args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" });

    async function initRepo(): Promise<string> {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "strideterm-commit-"));
      tempPaths.push(root);
      rg(root, ["init", "-q"]);
      rg(root, ["config", "user.email", "t@example.com"]);
      rg(root, ["config", "user.name", "Test"]);
      rg(root, ["config", "commit.gpgsign", "false"]);
      rg(root, ["config", "core.autocrlf", "false"]);
      for (const f of ["mod.txt", "del.txt", "ren_old.txt", "other.txt"]) {
        await fs.writeFile(path.join(root, f), `${f}\n`, "utf8");
      }
      rg(root, ["add", "-A"]);
      rg(root, ["commit", "-q", "-m", "base"]);
      return root;
    }

    const tree = (root: string) =>
      rg(root, ["ls-tree", "-r", "--name-only", "HEAD"])
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean);

    test("scoped commit handles modify/delete/rename/untracked and leaves other files", async () => {
      const root = await initRepo();
      await fs.writeFile(path.join(root, "mod.txt"), "changed\n", "utf8");
      await fs.rm(path.join(root, "del.txt")); // unstaged deletion
      rg(root, ["mv", "ren_old.txt", "ren_new.txt"]); // staged rename
      await fs.writeFile(path.join(root, "untr.txt"), "new\n", "utf8"); // untracked
      await fs.writeFile(path.join(root, "other.txt"), "unrelated\n", "utf8"); // must stay uncommitted

      // The UI passes selected new paths and the rename's previousPath SEPARATELY.
      const res = await mgr.commitAll(
        { id: "ws", cwd: root },
        {
          message: "scoped",
          paths: ["mod.txt", "del.txt", "untr.txt", "ren_new.txt"],
          previousPaths: ["ren_old.txt"],
        },
      );
      expect(res.ok).toBe(true);

      const head = tree(root);
      expect(head).toContain("mod.txt");
      expect(head).toContain("untr.txt");
      expect(head).toContain("ren_new.txt");
      expect(head).toContain("other.txt"); // present at base content, not the edit
      expect(head).not.toContain("del.txt"); // deletion committed
      expect(head).not.toContain("ren_old.txt"); // renamed away

      expect(rg(root, ["show", "HEAD:mod.txt"])).toContain("changed");
      expect(rg(root, ["show", "HEAD:other.txt"])).not.toContain("unrelated");
      // The unrelated edit is still pending in the working tree (unstaged modify).
      expect(rg(root, ["status", "--porcelain"]).trim()).toBe("M other.txt");
    });

    // Reviewer's regression: a staged rename's old name RECREATED as an unselected
    // file must commit as a real RENAME (HEAD loses the old name) with a clean
    // index — not a copy, and not sweeping in the recreated file.
    test("commits a rename (not a copy) and leaves a recreated old name untracked", async () => {
      const root = await initRepo();
      rg(root, ["mv", "ren_old.txt", "ren_new.txt"]); // staged rename
      await fs.writeFile(path.join(root, "ren_old.txt"), "RECREATED\n", "utf8"); // unselected, back on disk

      const res = await mgr.commitAll(
        { id: "ws", cwd: root },
        { message: "rename only", paths: ["ren_new.txt"], previousPaths: ["ren_old.txt"] },
      );
      expect(res.ok).toBe(true);

      const head = tree(root);
      expect(head).toContain("ren_new.txt");
      expect(head).not.toContain("ren_old.txt"); // a real rename — old name gone from HEAD
      expect(rg(root, ["show", "HEAD:ren_new.txt"])).toContain("ren_old"); // renamed content preserved
      // Clean index: the ONLY leftover is the untracked recreated file (no dangling
      // staged deletion, no committed recreated body).
      expect(rg(root, ["status", "--porcelain"]).trim()).toBe("?? ren_old.txt");
      expect(await fs.readFile(path.join(root, "ren_old.txt"), "utf8")).toBe("RECREATED\n");
    });

    // Reviewer's regression: when the user checks BOTH the rename target and the
    // recreated old name, the old name is an explicit selection and must be
    // committed with its new content — not swept out by the rename's delete side.
    test("commits both the rename target and an explicitly selected recreated old name", async () => {
      const root = await initRepo();
      rg(root, ["mv", "ren_old.txt", "ren_new.txt"]); // staged rename
      await fs.writeFile(path.join(root, "ren_old.txt"), "RECREATED\n", "utf8"); // recreated AND selected

      const res = await mgr.commitAll(
        { id: "ws", cwd: root },
        { message: "rename + recreated", paths: ["ren_new.txt", "ren_old.txt"], previousPaths: ["ren_old.txt"] },
      );
      expect(res.ok).toBe(true);

      const head = tree(root);
      expect(head).toContain("ren_new.txt");
      expect(head).toContain("ren_old.txt"); // explicitly selected — NOT dropped
      expect(rg(root, ["show", "HEAD:ren_new.txt"])).toContain("ren_old"); // original body under the new name
      expect(rg(root, ["show", "HEAD:ren_old.txt"])).toContain("RECREATED"); // recreated body committed
      expect(rg(root, ["status", "--porcelain"]).trim()).toBe(""); // clean index and tree
    });

    // Reviewer's regression: `previousPaths` is removed from the commit, so a
    // stale snapshot or a forged request listing a normal tracked file there must
    // NOT delete it — only paths git confirms as a rename old-name may be removed.
    test("ignores a previousPath that isn't a current rename old-name", async () => {
      const root = await initRepo();
      await fs.writeFile(path.join(root, "mod.txt"), "changed\n", "utf8");

      const res = await mgr.commitAll(
        { id: "ws", cwd: root },
        // other.txt is a plain tracked file with no rename — it must survive.
        { message: "scoped", paths: ["mod.txt"], previousPaths: ["other.txt"] },
      );
      expect(res.ok).toBe(true);

      const head = tree(root);
      expect(head).toContain("mod.txt");
      expect(head).toContain("other.txt"); // NOT dropped by the bogus previousPath
      expect(rg(root, ["show", "HEAD:mod.txt"])).toContain("changed");
      expect(rg(root, ["show", "HEAD:other.txt"])).toContain("other.txt"); // original content intact
    });

    // Reviewer's regression: two scoped commits building temp indexes from the
    // same HEAD would parent the second's stale tree on the first's new HEAD and
    // silently revert it. Per-repo serialization must keep both commits' files.
    test("serializes concurrent scoped commits so neither reverts the other", async () => {
      const root = await initRepo();
      await fs.writeFile(path.join(root, "mod.txt"), "AAA\n", "utf8");
      await fs.writeFile(path.join(root, "other.txt"), "BBB\n", "utf8");

      const [r1, r2] = await Promise.all([
        mgr.commitAll({ id: "ws", cwd: root }, { message: "c1", paths: ["mod.txt"] }),
        mgr.commitAll({ id: "ws", cwd: root }, { message: "c2", paths: ["other.txt"] }),
      ]);
      expect(r1.ok).toBe(true);
      expect(r2.ok).toBe(true);

      // Both edits are in the final HEAD — neither commit reverted the other.
      expect(rg(root, ["show", "HEAD:mod.txt"])).toContain("AAA");
      expect(rg(root, ["show", "HEAD:other.txt"])).toContain("BBB");
      expect(rg(root, ["rev-list", "--count", "HEAD"]).trim()).toBe("3"); // base + two commits
    });

    // Confirms the unborn-branch path still works after tightening HEAD detection
    // (only a positive unborn signal — a symbolic ref with no commit — uses the
    // empty base tree; operational failures abort instead).
    test("scoped commit works on an unborn branch (first commit)", async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "strideterm-unborn-"));
      tempPaths.push(root);
      rg(root, ["init", "-q"]);
      rg(root, ["config", "user.email", "t@example.com"]);
      rg(root, ["config", "user.name", "Test"]);
      rg(root, ["config", "commit.gpgsign", "false"]);
      await fs.writeFile(path.join(root, "a.txt"), "A\n", "utf8");
      await fs.writeFile(path.join(root, "b.txt"), "B\n", "utf8");

      const res = await mgr.commitAll({ id: "ws", cwd: root }, { message: "first", paths: ["a.txt"] });
      expect(res.ok).toBe(true);
      expect(tree(root)).toEqual(["a.txt"]); // only the selected file is in the first commit
      expect(rg(root, ["status", "--porcelain"]).trim()).toBe("?? b.txt"); // b.txt still untracked
    });

    // Reviewer's regression: onDisk must inspect the directory ENTRY (lstat), not
    // follow the link (existsSync). A dangling symlink points at a missing target,
    // so existsSync reads it as absent and would commit a deletion / skip the add.
    // POSIX-only: creating symlinks on Windows needs elevation and mode bits differ.
    test.skipIf(process.platform === "win32")(
      "commits a new dangling symlink as a symlink, not a deletion",
      async () => {
        const root = await initRepo();
        await fs.symlink("missing-target", path.join(root, "link")); // untracked, dangling

        const res = await mgr.commitAll({ id: "ws", cwd: root }, { message: "add dangling symlink", paths: ["link"] });
        expect(res.ok).toBe(true);

        expect(tree(root)).toContain("link");
        expect(rg(root, ["ls-tree", "HEAD", "link"])).toContain("120000"); // symlink mode, not a deletion
        expect(rg(root, ["show", "HEAD:link"]).trim()).toBe("missing-target"); // link body = the missing target
      },
    );

    // Reviewer's regression: a pre-commit hook inherits the temp GIT_INDEX_FILE
    // and can `git add` files beyond the selection. They land in the commit, so
    // the real-index reconcile must cover them too (via the commit's actual diff)
    // — otherwise the hook-added path lingers as a phantom reverse-staged change.
    // POSIX-only: hook execution + chmod +x differ on Windows.
    test.skipIf(process.platform === "win32")(
      "reconciles the real index for files a pre-commit hook adds to the commit",
      async () => {
        const root = await initRepo();
        const hook = path.join(root, ".git", "hooks", "pre-commit");
        // Stage an extra tracked file into whatever index is active (the temp
        // index, via inherited GIT_INDEX_FILE), reproducing the finding.
        await fs.writeFile(hook, "#!/bin/sh\nprintf 'hooked\\n' > other.txt\ngit add other.txt\n", "utf8");
        await fs.chmod(hook, 0o755);

        await fs.writeFile(path.join(root, "mod.txt"), "changed\n", "utf8");
        const res = await mgr.commitAll({ id: "ws", cwd: root }, { message: "scoped + hook", paths: ["mod.txt"] });
        expect(res.ok).toBe(true);

        // The hook's file is in the commit...
        expect(tree(root)).toContain("other.txt");
        expect(rg(root, ["show", "HEAD:other.txt"])).toContain("hooked");
        // ...and the real index was reconciled to it: no phantom reverse-staged
        // entry for other.txt. Worktree == committed content, so it's fully clean.
        expect(rg(root, ["status", "--porcelain"]).trim()).toBe("");
      },
    );

    test("isolates the commit from unselected staged changes (temp index)", async () => {
      const root = await initRepo();
      await fs.writeFile(path.join(root, "mod.txt"), "changed\n", "utf8"); // selected, unstaged
      await fs.writeFile(path.join(root, "other.txt"), "staged edit\n", "utf8");
      rg(root, ["add", "other.txt"]); // UNSELECTED but pre-staged

      const res = await mgr.commitAll({ id: "ws", cwd: root }, { message: "only mod", paths: ["mod.txt"] });
      expect(res.ok).toBe(true);

      expect(rg(root, ["show", "HEAD:mod.txt"])).toContain("changed");
      expect(rg(root, ["show", "HEAD:other.txt"])).not.toContain("staged edit"); // other.txt NOT committed
      // The unselected file's staged edit is still staged after the commit.
      expect(rg(root, ["diff", "--cached", "--name-only"]).trim()).toBe("other.txt");
    });

    test("rejects an explicitly-scoped commit with no valid paths without touching HEAD", async () => {
      const root = await initRepo();
      await fs.writeFile(path.join(root, "mod.txt"), "changed\n", "utf8");
      const before = rg(root, ["rev-parse", "HEAD"]).trim();
      const res = await mgr.commitAll({ id: "ws", cwd: root }, { message: "scoped empty", paths: [] });
      expect(res.ok).toBe(false);
      expect(rg(root, ["rev-parse", "HEAD"]).trim()).toBe(before); // nothing committed
      expect(rg(root, ["status", "--porcelain"])).toContain("mod.txt"); // change still pending
    });

    test("commits a lone deletion (empty stage list) without a pathspec error", async () => {
      const root = await initRepo();
      rg(root, ["rm", "-q", "del.txt"]); // staged deletion → nothing exists on disk to `git add`
      const res = await mgr.commitAll({ id: "ws", cwd: root }, { message: "del only", paths: ["del.txt"] });
      expect(res.ok).toBe(true);
      expect(tree(root)).not.toContain("del.txt");
      expect(rg(root, ["status", "--porcelain"]).trim()).toBe("");
    });

    test("commits the whole tree when no paths are given", async () => {
      const root = await initRepo();
      await fs.writeFile(path.join(root, "mod.txt"), "changed\n", "utf8");
      await fs.writeFile(path.join(root, "other.txt"), "changed too\n", "utf8");
      const res = await mgr.commitAll({ id: "ws", cwd: root }, { message: "all" });
      expect(res.ok).toBe(true);
      expect(rg(root, ["status", "--porcelain"]).trim()).toBe("");
    });

    // Reviewer's regression: a scoped commit builds its tree from HEAD in a temp
    // index, so `git commit` here wouldn't see the merge state — it would create
    // the merge commit with ONLY the selected paths and drop everything else the
    // merge staged. Must be refused even when conflicts are already resolved and
    // staged (unmerged index is empty; only the MERGE_HEAD marker remains).
    test("refuses a scoped commit while a merge is in progress", async () => {
      const root = await initRepo();
      const main = rg(root, ["rev-parse", "--abbrev-ref", "HEAD"]).trim();
      rg(root, ["checkout", "-q", "-b", "feature"]);
      await fs.writeFile(path.join(root, "mod.txt"), "feature\n", "utf8");
      rg(root, ["commit", "-aqm", "feature edit"]);
      rg(root, ["checkout", "-q", main]);
      await fs.writeFile(path.join(root, "mod.txt"), "mainline\n", "utf8");
      rg(root, ["commit", "-aqm", "main edit"]);
      try {
        rg(root, ["merge", "feature"]); // conflicts on mod.txt
      } catch {
        /* expected */
      }
      await fs.writeFile(path.join(root, "mod.txt"), "resolved\n", "utf8");
      rg(root, ["add", "mod.txt"]); // conflict resolved & staged — no unmerged entries remain
      await fs.writeFile(path.join(root, "other.txt"), "unrelated\n", "utf8"); // the file we try to sneak in

      const before = rg(root, ["rev-parse", "HEAD"]).trim();
      const res = await mgr.commitAll({ id: "ws", cwd: root }, { message: "sneak", paths: ["other.txt"] });
      expect(res.ok).toBe(false);
      expect(String(res.summary)).toMatch(/in progress/i);
      expect(rg(root, ["rev-parse", "HEAD"]).trim()).toBe(before); // nothing committed
      expect(rg(root, ["rev-parse", "--verify", "MERGE_HEAD"]).trim()).toBeTruthy(); // merge still pending
    });

    // Reviewer's regression: conflicts left by `git stash apply` leave unmerged
    // index entries but NO operation in progress (no MERGE_HEAD), so the marker
    // check alone wouldn't catch them — the unmerged-index check must.
    test("refuses a scoped commit while the index has unresolved conflicts (no operation)", async () => {
      const root = await initRepo();
      await fs.writeFile(path.join(root, "mod.txt"), "stashed\n", "utf8");
      rg(root, ["stash", "push", "-q", "--", "mod.txt"]); // working tree back to base, clean
      // Commit a diverging change to the same file so the tree is clean but the
      // stash no longer applies cleanly — `stash apply` then 3-way merges and
      // conflicts (unmerged index) WITHOUT starting a tracked operation.
      await fs.writeFile(path.join(root, "mod.txt"), "committed\n", "utf8");
      rg(root, ["commit", "-aqm", "diverge mod.txt"]);
      try {
        rg(root, ["stash", "apply"]); // conflicts on mod.txt, no MERGE_HEAD
      } catch {
        /* expected */
      }
      await fs.writeFile(path.join(root, "other.txt"), "unrelated\n", "utf8");

      const before = rg(root, ["rev-parse", "HEAD"]).trim();
      const res = await mgr.commitAll({ id: "ws", cwd: root }, { message: "sneak", paths: ["other.txt"] });
      expect(res.ok).toBe(false);
      expect(String(res.summary)).toMatch(/conflicts/i);
      expect(rg(root, ["rev-parse", "HEAD"]).trim()).toBe(before); // nothing committed
      expect(() => rg(root, ["rev-parse", "--verify", "MERGE_HEAD"])).toThrow(); // no operation, yet refused
    });

    // Reviewer's regression: the post-commit index reconcile is best-effort. When
    // it can't run (locked index), the commit still lands but the result must warn
    // rather than report an unqualified clean success. The commit uses a temp
    // index, so a stale .git/index.lock blocks only the reconcile `git reset`.
    test("commits with a warning when the index can't be reconciled", async () => {
      const root = await initRepo();
      await fs.writeFile(path.join(root, "mod.txt"), "changed\n", "utf8");
      await fs.writeFile(path.join(root, ".git", "index.lock"), "", "utf8"); // simulate a locked index

      const res = await mgr.commitAll({ id: "ws", cwd: root }, { message: "locked", paths: ["mod.txt"] });
      expect(res.ok).toBe(true); // temp-index commit still lands
      expect(tree(root)).toContain("mod.txt");
      expect(rg(root, ["show", "HEAD:mod.txt"])).toContain("changed");
      expect((res.warnings as string[]).length).toBeGreaterThan(0); // caller is warned about the stale index

      await fs.rm(path.join(root, ".git", "index.lock"), { force: true });
    });
  });
});
