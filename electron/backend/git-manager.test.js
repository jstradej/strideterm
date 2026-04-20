import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { afterEach, describe, expect, test, vi } from "vitest";
import { GitManager } from "./git-manager.js";

const tempPaths = [];

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

function createExecMock(responses) {
  return vi.fn(async (cwd, args) => {
    const key = `${cwd}::${args.join(" ")}`;
    if (!(key in responses)) {
      throw { stderr: `Unexpected git call: ${key}`, stdout: "" };
    }
    const value = responses[key];
    if (value instanceof Error) {
      throw { stderr: value.message, stdout: "" };
    }
    if (value && value.__reject) {
      throw value.__reject;
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
    expect(snapshot.remotes.origin).toBe("https://dev.azure.com/acme/Platform/_git/web-app");
    expect(snapshot.baseBranch).toBe("main");
    expect(snapshot.aheadCount).toBe(2);
    expect(snapshot.behindCount).toBe(1);
    expect(snapshot.staged.map((entry) => entry.path)).toEqual(["src/app.js"]);
    expect(snapshot.unstaged.map((entry) => entry.path)).toEqual(["config/app.json"]);
    expect(snapshot.untracked.map((entry) => entry.path)).toEqual(["docs/notes.md"]);
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
    expect(snapshot.siblingWorktrees).toHaveLength(2);
    expect(snapshot.siblingWorktrees[1]).toMatchObject({
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
    const merged = snapshot.siblingWorktrees.find((e) => e.branch === "feature-merged");
    const active = snapshot.siblingWorktrees.find((e) => e.branch === "feature-active");
    const mainEntry = snapshot.siblingWorktrees.find((e) => e.branch === "main");
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
    expect(snapshot.compareWithBase.baseBranch).toBe("origin/main");
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
      execGitImpl.mock.calls.filter(([cwd, args]) => cwd === sibling && args.join(" ") === "status --short"),
    ).toHaveLength(1);
  });

  test("refreshWorkspaces uses snapshot cache within TTL", async () => {
    let inspectCount = 0;
    let nowValue = new Date("2026-03-17T12:00:00.000Z");
    const manager = new GitManager({ execGitImpl: vi.fn(), now: () => nowValue, snapshotCacheTtlMs: 5000 });
    manager.inspectWorkspace = vi.fn(async (workspace) => {
      inspectCount++;
      return { workspaceId: workspace.id, available: true, branch: "main", inspectCount };
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
    manager.inspectWorkspace = vi.fn(async (workspace) => {
      inspectCount++;
      return { workspaceId: workspace.id, available: true };
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
    manager.inspectWorkspace = vi.fn(async (workspace) => {
      inspectCount++;
      return { workspaceId: workspace.id, available: true };
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
    const execGitImpl = vi.fn(async (cwd, args) => {
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
    expect(result.tags).toHaveLength(2);
    expect(result.tags[0]).toMatchObject({
      name: "v1.0.0",
      annotated: true,
      author: "Jaromir",
      message: "First release",
      pushed: true,
      local: true,
    });
    expect(result.tags[1]).toMatchObject({
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

    expect(result.tags).toHaveLength(2);
    expect(result.tags[0]).toMatchObject({ name: "v1.0.0", local: true, pushed: true });
    expect(result.tags[1]).toMatchObject({ name: "v2.0.0", local: false, pushed: true });
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

  // ─── execAuthGit login resolution ────────────────────────────────

  function extractAuthCredentials(execMock) {
    const args = execMock.mock.calls[0][1];
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

    expect(snapshot.staged).toHaveLength(1);
    expect(snapshot.unstaged).toHaveLength(1);
    expect(snapshot.untracked).toHaveLength(0);
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

    expect(snapshot.staged).toHaveLength(0);
    expect(snapshot.unstaged).toHaveLength(0);
    expect(snapshot.untracked).toHaveLength(2);
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
    expect(snapshot.staged.map((e) => e.path)).toContain("src/a.js");
    expect(snapshot.unstaged.map((e) => e.path)).toContain("src/a.js");
    expect(snapshot.unstaged.map((e) => e.path)).toContain("src/b.js");
    expect(snapshot.untracked.map((e) => e.path)).toContain("new.txt");
    expect(snapshot.dirtyCount).toBe(3);
    expect(snapshot.dirty).toBe(true);
  });
});
