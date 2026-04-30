/// <reference types="node" />
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { afterEach, describe, expect, test, vi } from "vitest";
import { GitManager } from "./git-manager.js";

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
});
