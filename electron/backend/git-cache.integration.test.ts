import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GitManager } from "./git-manager.js";
import { GitCacheStore } from "./git-cache-store.js";
import { execFileText } from "./process-utils.js";
import { sanitizeGitEnvironment } from "./shared/git-auth-utils.js";
import { sharedReviewGitLocks } from "./review-git/locks.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture() {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "strideterm-git-cache-integration-"));
  const root = path.join(scratch, "名 repository with spaces");
  await fs.mkdir(root);
  cleanups.push(async () => {
    const resolved = path.resolve(scratch);
    if (
      path.dirname(resolved) !== path.resolve(os.tmpdir()) ||
      !path.basename(resolved).startsWith("strideterm-git-cache-integration-")
    )
      throw new Error("Invalid integration cleanup path.");
    await fs.rm(resolved, { recursive: true, force: true });
  });
  const env = {
    ...sanitizeGitEnvironment(),
    GIT_CONFIG_GLOBAL: path.join(scratch, "empty-config"),
    GIT_CONFIG_NOSYSTEM: "1",
  };
  const git = (cwd: string, args: string[]) => execFileText("git", args, { cwd, env, timeout: 20_000 });
  await git(root, ["init", "--initial-branch=main"]);
  await git(root, ["config", "user.name", "Cache integration"]);
  await git(root, ["config", "user.email", "cache@example.invalid"]);
  await git(root, ["config", "core.autocrlf", "false"]);
  await fs.writeFile(path.join(root, "tracked.txt"), "original\n");
  await fs.mkdir(path.join(root, "subdir"));
  await fs.writeFile(path.join(root, "subdir", "nested.txt"), "nested\n");
  await git(root, ["add", "."]);
  await git(root, ["commit", "-m", "Fixture"]);
  const commands: string[][] = [];
  let clock = Date.now();
  const manager = new GitManager({
    now: () => new Date(clock),
    execGitImpl: async (cwd, args) => {
      commands.push([...args]);
      return git(cwd, args);
    },
  });
  manager.detectLazygit = async () => ({ available: false, backend: null, error: "", launch: null });
  cleanups.push(async () => manager.dispose());
  return {
    scratch,
    root,
    git,
    env,
    manager,
    commands,
    advance: () => {
      clock += 60_000;
    },
  };
}

const isStatus = (args: string[]) => args.includes("status");
const isHistory = (args: string[]) =>
  args.some((arg) => ["log", "rev-list", "merge-base"].includes(arg)) ||
  (args.includes("diff") && !args.includes("--shortstat"));

describe("Git cache integration", () => {
  it("shares a physical checkout across subdirectory bindings and performs one status for two clients", async () => {
    const { manager, root, commands, advance } = await fixture();
    const first = { id: "one", cwd: root, kind: "terminal" };
    const second = { id: "two", cwd: path.join(root, "subdir"), kind: "terminal" };
    await manager.registerWorkspaces([
      first,
      second,
      ...Array.from({ length: 98 }, (_, index) => ({ id: `sleep-${index}`, cwd: path.join(root, `absent-${index}`) })),
    ]);
    expect(commands).toHaveLength(0);
    await Promise.all([manager.refreshWorkspaces([first]), manager.refreshWorkspaces([second])]);
    expect(manager.getSnapshot("one")?.available).toBe(true);
    expect(manager.getSnapshot("two")?.root).toBe(manager.getSnapshot("one")?.root);
    expect(commands.filter(isStatus)).toHaveLength(1);
    commands.length = 0;
    for (let index = 0; index < 60; index++) await manager.refreshWorkspaces([first, second]);
    expect(commands).toHaveLength(0);
    advance();
    await fs.writeFile(path.join(root, "tracked.txt"), "external edit\n");
    await Promise.all([manager.refreshWorkspaces([first]), manager.refreshWorkspaces([second])]);
    expect(manager.getSnapshot("one")?.dirtyCount).toBe(1);
    expect(manager.getSnapshot("two")?.dirtyCount).toBe(1);
    expect(commands.filter(isStatus)).toHaveLength(1);
    expect(commands.filter(isHistory)).toHaveLength(0);
  });

  it("updates repeated M edits through native watches and closes all watches when interest ends", async () => {
    const { manager, root } = await fixture();
    const workspace = { id: "watch", cwd: root, kind: "terminal" };
    await manager.refreshWorkspaces([workspace]);
    await manager.setInterestedWorkspaces([workspace]);
    await fs.writeFile(path.join(root, "tracked.txt"), "first external edit\n");
    await vi.waitFor(() => expect(manager.getSnapshot(workspace.id)?.dirtyCount).toBe(1), { timeout: 8000 });
    const revision = manager.getSnapshot(workspace.id)?.dataRevision;
    await fs.writeFile(path.join(root, "tracked.txt"), "second external edit\n");
    await vi.waitFor(() => expect(manager.getSnapshot(workspace.id)?.dataRevision).not.toBe(revision), {
      timeout: 8000,
    });
    expect(manager.getSnapshot(workspace.id)?.dirtyCount).toBe(1);
    const diff = await manager.diffPreview(workspace, { path: "tracked.txt" });
    expect(String(diff.diff)).toContain("second external edit");
    await manager.setInterestedWorkspaces([]);
    const stoppedRevision = manager.getSnapshot(workspace.id)?.dataRevision;
    await fs.writeFile(path.join(root, "tracked.txt"), "sleeping edit\n");
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(manager.getSnapshot(workspace.id)?.dataRevision).toBe(stoppedRevision);
  });

  it("hydrates last-known summaries after restart without running Git", async () => {
    const { root, scratch, git, manager } = await fixture();
    manager.dispose();
    const workspace = { id: "persistent", cwd: root, kind: "terminal" };
    const aliasWorkspace = { id: "persistent-subdirectory", cwd: path.join(root, "subdir"), kind: "terminal" };
    const dir = path.join(scratch, "data");
    const store = new GitCacheStore(dir);
    const first = new GitManager({ cacheStore: store, execGitImpl: git });
    first.detectLazygit = manager.detectLazygit;
    cleanups.push(async () => {
      first.dispose();
      await store.close();
    });
    await first.registerWorkspaces([workspace, aliasWorkspace]);
    await first.refreshWorkspaces([workspace]);
    await first.refreshWorkspaces([aliasWorkspace]);
    first.dispose();
    await store.close();
    await fs.rename(root, path.join(scratch, "offline-repository"));
    const reopened = new GitCacheStore(dir);
    const runner = vi.fn(git);
    const second = new GitManager({ cacheStore: reopened, execGitImpl: runner });
    second.detectLazygit = manager.detectLazygit;
    cleanups.push(async () => {
      second.dispose();
      await reopened.close();
    });
    await second.registerWorkspaces([workspace, aliasWorkspace]);
    expect(runner).not.toHaveBeenCalled();
    expect(second.getSnapshot(workspace.id)).toMatchObject({ branch: "main", stale: true });
    expect(second.getSnapshot(aliasWorkspace.id)).toMatchObject({ branch: "main", stale: true, summaryOnly: false });
  });

  it("restores a renderable snapshot after restart and verifies it without rebuilding the history", async () => {
    const { root, scratch, git, manager } = await fixture();
    manager.dispose();
    const workspace = { id: "restored", cwd: root, kind: "terminal" };
    const dir = path.join(scratch, "data");
    await fs.writeFile(path.join(root, "tracked.txt"), "dirty before restart\n");
    const store = new GitCacheStore(dir);
    const first = new GitManager({ cacheStore: store, execGitImpl: git });
    first.detectLazygit = manager.detectLazygit;
    await first.refreshWorkspaces([workspace]);
    const before = first.getSnapshot(workspace.id);
    first.dispose();
    await store.close();

    let clock = Date.now();
    const commands: string[][] = [];
    const reopened = new GitCacheStore(dir);
    const second = new GitManager({
      cacheStore: reopened,
      now: () => new Date(clock),
      execGitImpl: async (cwd, args) => {
        commands.push([...args]);
        return git(cwd, args);
      },
    });
    second.detectLazygit = manager.detectLazygit;
    cleanups.push(async () => {
      second.dispose();
      await reopened.close();
    });
    await second.registerWorkspaces([workspace]);
    expect(commands).toHaveLength(0);
    const restored = second.getSnapshot(workspace.id);
    expect(restored).toMatchObject({ available: true, stale: true, verified: false, branch: "main", dirtyCount: 1 });
    expect(restored?.summaryOnly).toBeFalsy();
    expect(restored?.stateToken).toBe(before?.stateToken);
    expect(restored?.log).toEqual(before?.log);
    expect(
      (restored?.changes as { unstaged: { files: Array<{ path: string }> } }).unstaged.files.map((file) => file.path),
    ).toEqual(["tracked.txt"]);

    await second.refreshWorkspaces([workspace]);
    const forbidden = commands.filter(
      (args) =>
        args.includes("log") ||
        args.includes("rev-list") ||
        args.includes("worktree") ||
        args.includes("--format=%(refname:short)"),
    );
    expect(forbidden).toEqual([]);
    expect(commands.filter(isStatus)).toHaveLength(1);
    expect(second.getSnapshot(workspace.id)).toMatchObject({ stale: false, verified: true, dirtyCount: 1 });
    expect(second.getSnapshot(workspace.id)?.log).toEqual(before?.log);

    await git(root, ["add", "."]);
    await git(root, ["commit", "-m", "External commit"]);
    clock += 60_000;
    commands.length = 0;
    await second.refreshWorkspaces([workspace]);
    expect(commands.some((args) => args.includes("log"))).toBe(true);
    expect(second.getSnapshot(workspace.id)).toMatchObject({ dirtyCount: 0, available: true });
    expect(second.getSnapshot(workspace.id)?.stale).toBeFalsy();
    expect(second.getSnapshot(workspace.id)?.headOid).not.toBe(before?.headOid);
  });

  it("lists the cached state while the first inspect of a new run is still verifying it", async () => {
    const { root, scratch, git, manager } = await fixture();
    manager.dispose();
    const workspace = { id: "raced", cwd: root, kind: "terminal" };
    const dir = path.join(scratch, "data");
    await fs.writeFile(path.join(root, "tracked.txt"), "dirty before restart\n");
    const store = new GitCacheStore(dir);
    const first = new GitManager({ cacheStore: store, execGitImpl: git });
    first.detectLazygit = manager.detectLazygit;
    await first.refreshWorkspaces([workspace]);
    first.dispose();
    await store.close();

    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const reopened = new GitCacheStore(dir);
    const second = new GitManager({
      cacheStore: reopened,
      execGitImpl: async (cwd, args) => {
        if (!args.includes("rev-parse")) await gate;
        return git(cwd, args);
      },
    });
    second.detectLazygit = manager.detectLazygit;
    cleanups.push(async () => {
      second.dispose();
      await reopened.close();
    });
    // Activation order: the registration's hydration reads the store asynchronously while the
    // workspace refresh writes its placeholder in the same tick, so the refresh wins the race.
    const registered = second.registerWorkspaces([workspace]);
    const refreshed = second.refreshWorkspaces([workspace]);
    await registered;
    await vi.waitFor(() =>
      expect(second.getSnapshot(workspace.id)).toMatchObject({
        available: true,
        cached: true,
        verified: false,
        dirtyCount: 1,
      }),
    );
    release();
    await refreshed;
    expect(second.getSnapshot(workspace.id)).toMatchObject({
      available: true,
      verified: true,
      stale: false,
      dirtyCount: 1,
    });
  });

  it("keeps the data revision stable when a forced validation finds no changes", async () => {
    const { manager, root } = await fixture();
    const workspace = { id: "stable", cwd: root, kind: "terminal" };
    await manager.refreshWorkspaces([workspace]);
    const before = manager.getSnapshot(workspace.id)?.dataRevision;
    manager.invalidateSnapshotCache(workspace.id);
    await manager.refreshWorkspaces([workspace]);
    expect(manager.getSnapshot(workspace.id)?.dataRevision).toBe(before);
  });

  it("strips credentials from shared remote metadata", async () => {
    const { manager, root, git } = await fixture();
    await git(root, [
      "remote",
      "add",
      "origin",
      "https://private-user:private-password@example.invalid/repo?token=private-token",
    ]);
    await manager.refreshWorkspaces([{ id: "first-profile", cwd: root, kind: "terminal" }]);
    await manager.refreshWorkspaces([{ id: "second-profile", cwd: root, kind: "terminal" }]);
    for (const id of ["first-profile", "second-profile"]) {
      const serialized = JSON.stringify(manager.getSnapshot(id)?.remotes);
      expect(serialized.includes("private-user")).toBe(false);
      expect(serialized.includes("private-password")).toBe(false);
      expect(serialized.includes("private-token")).toBe(false);
      expect(serialized).toContain("example.invalid/repo");
    }
  });

  it("revalidates included Git configuration without relying on a filesystem event", async () => {
    const { manager, root, scratch, git, advance } = await fixture();
    const included = path.join(scratch, "included-config");
    await fs.writeFile(included, '[remote "extra"]\n  url = https://example.invalid/old\n');
    await git(root, ["config", "include.path", included]);
    const workspace = { id: "configuration", cwd: root, kind: "terminal" };
    await manager.refreshWorkspaces([workspace]);
    expect((manager.getSnapshot(workspace.id)?.remotes as Record<string, string>).extra).toBe(
      "https://example.invalid/old",
    );
    await fs.writeFile(included, '[remote "extra"]\n  url = https://example.invalid/replacement\n');
    advance();
    await manager.refreshWorkspaces([workspace]);
    expect((manager.getSnapshot(workspace.id)?.remotes as Record<string, string>).extra).toBe(
      "https://example.invalid/replacement",
    );
  });

  it("uses the checkout root and its write lock for files in a subdirectory workspace", async () => {
    const { manager, root, git } = await fixture();
    const workspace = { id: "subdirectory", cwd: path.join(root, "subdir"), kind: "terminal" };
    await manager.refreshWorkspaces([workspace]);
    await fs.writeFile(path.join(root, "subdir", "nested.txt"), "selected nested edit\n");
    const runner = manager.execGitImpl!;
    let locked = false;
    manager.execGitImpl = (cwd, args, options) => {
      if (args.includes("add")) locked = sharedReviewGitLocks.isWorktreeHeld(root);
      return runner(cwd, args, options);
    };
    expect((await manager.stageFile(workspace, { path: "subdir/nested.txt" })).ok).toBe(true);
    expect(locked).toBe(true);
    expect((await git(root, ["diff", "--cached", "--name-only", "-z"])).stdout).toBe("subdir/nested.txt\0");
    expect(
      String((await manager.diffPreview(workspace, { path: "subdir/nested.txt", scope: "staged" })).diff),
    ).toContain("selected nested edit");
  });

  it("runs Git, takes the review lock and reports the checkout under a linked workspace's own path", async () => {
    const { manager, root, scratch } = await fixture();
    const linked = path.join(scratch, "linked checkout");
    await fs.symlink(root, linked, process.platform === "win32" ? "junction" : "dir");
    const workspace = { id: "linked", cwd: path.join(linked, "subdir"), kind: "terminal" };
    await manager.refreshWorkspaces([workspace]);
    expect(manager.getSnapshot(workspace.id)).toMatchObject({ root: linked, worktreePath: linked });

    await fs.writeFile(path.join(root, "subdir", "nested.txt"), "linked edit\n");
    const runner = manager.execGitImpl!;
    const writes: Array<{ cwd: string; locked: boolean }> = [];
    manager.execGitImpl = (cwd, args, options) => {
      if (args.includes("add")) writes.push({ cwd, locked: sharedReviewGitLocks.isWorktreeHeld(linked) });
      return runner(cwd, args, options);
    };
    expect((await manager.stageFile(workspace, { path: "subdir/nested.txt" })).ok).toBe(true);
    expect(writes).toEqual([{ cwd: linked, locked: true }]);

    // The review Git engine locks the workspace's own path; the Git pane must see that mutation.
    let events = 0;
    manager.on("freshness", () => events++);
    await sharedReviewGitLocks.withWorktree(linked, async () => {});
    expect(events).toBe(2);
  });

  it("hydrates every linked workspace of one checkout after restart", async () => {
    const { root, scratch, git, manager } = await fixture();
    manager.dispose();
    const linked = path.join(scratch, "linked checkout");
    await fs.symlink(root, linked, process.platform === "win32" ? "junction" : "dir");
    const workspaces = [
      { id: "linked-root", cwd: linked, kind: "terminal" },
      { id: "linked-subdirectory", cwd: path.join(linked, "subdir"), kind: "terminal" },
    ];
    const dir = path.join(scratch, "data");
    const store = new GitCacheStore(dir);
    const first = new GitManager({ cacheStore: store, execGitImpl: git });
    first.detectLazygit = manager.detectLazygit;
    cleanups.push(async () => {
      first.dispose();
      await store.close();
    });
    await first.registerWorkspaces(workspaces);
    await first.refreshWorkspaces([workspaces[0]]);
    await first.refreshWorkspaces([workspaces[1]]);
    first.dispose();
    await store.close();

    const reopened = new GitCacheStore(dir);
    const runner = vi.fn(git);
    const second = new GitManager({ cacheStore: reopened, execGitImpl: runner });
    second.detectLazygit = manager.detectLazygit;
    cleanups.push(async () => {
      second.dispose();
      await reopened.close();
    });
    await second.registerWorkspaces(workspaces);
    expect(runner).not.toHaveBeenCalled();
    for (const workspace of workspaces)
      expect(second.getSnapshot(workspace.id)).toMatchObject({ branch: "main", stale: true });
  });

  it("falls back to the real checkout root when the link points inside the repository", async () => {
    const { manager, root, scratch, git } = await fixture();
    const linkedSubdirectory = path.join(scratch, "linked subdirectory");
    await fs.symlink(path.join(root, "subdir"), linkedSubdirectory, process.platform === "win32" ? "junction" : "dir");
    const workspace = { id: "linked-subdirectory", cwd: linkedSubdirectory, kind: "terminal" };
    await manager.refreshWorkspaces([workspace]);
    const realRoot = await fs.realpath(root);
    expect(path.resolve(String(manager.getSnapshot(workspace.id)?.root))).toBe(realRoot);

    await fs.writeFile(path.join(root, "subdir", "nested.txt"), "linked subdirectory edit\n");
    const runner = manager.execGitImpl!;
    const cwds: string[] = [];
    manager.execGitImpl = (cwd, args, options) => {
      if (args.includes("add")) cwds.push(cwd);
      return runner(cwd, args, options);
    };
    expect((await manager.stageFile(workspace, { path: "subdir/nested.txt" })).ok).toBe(true);
    expect(cwds).toEqual([realRoot]);
    expect((await git(root, ["diff", "--cached", "--name-only", "-z"])).stdout).toBe("subdir/nested.txt\0");
  });

  it("rediscovers a newly created nested repository instead of sharing its former parent cache", async () => {
    const { manager, root, git } = await fixture();
    const nested = path.join(root, "subdir");
    const workspace = { id: "nested", cwd: nested, kind: "terminal" };
    await manager.refreshWorkspaces([workspace]);
    expect(manager.getSnapshot(workspace.id)?.branch).toBe("main");
    await git(nested, ["init", "--initial-branch=nested"]);
    await git(nested, ["config", "user.name", "Nested integration"]);
    await git(nested, ["config", "user.email", "nested@example.invalid"]);
    await git(nested, ["add", "nested.txt"]);
    await git(nested, ["commit", "-m", "Independent repository"]);
    manager.invalidateSnapshotCache(workspace.id);
    await manager.refreshWorkspaces([workspace]);
    expect(manager.getSnapshot(workspace.id)?.branch).toBe("nested");
    expect(path.resolve(String(manager.getSnapshot(workspace.id)?.root))).toBe(path.resolve(nested));
  });

  it("does not overwrite a newer root while another root is still refreshing", async () => {
    const { manager, root, scratch } = await fixture();
    const second = path.join(scratch, "second repository");
    await fs.cp(root, second, { recursive: true });
    const workspace = { id: "composition", cwd: root, gitRoots: [root, second], kind: "terminal" };
    await manager.registerWorkspaces([workspace]);
    const runner = manager.execGitImpl!;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    manager.execGitImpl = async (cwd, args, options) => {
      if (path.resolve(cwd) === path.resolve(second) && args.includes("status")) await gate;
      return runner(cwd, args, options);
    };
    const combined = manager.refreshWorkspaces([workspace]);
    try {
      await vi.waitFor(
        () =>
          expect(
            [...manager.snapshotCache.values()].some(
              (entry) => entry.snapshot.rootPath === root && entry.snapshot.available,
            ),
          ).toBe(true),
        // The gated second root holds one background slot, so under a full parallel suite the first root's refresh can take a while.
        { timeout: 30_000 },
      );
      await fs.writeFile(path.join(root, "tracked.txt"), "newer root result\n");
      manager.invalidateSnapshotCache(workspace.id, root);
      await manager.refreshWorkspaces([{ ...workspace, gitRoots: [root] }]);
      expect(manager.getSnapshot(workspace.id, root)?.dirtyCount).toBe(1);
      release();
      await combined;
      expect(manager.getSnapshot(workspace.id, root)?.dirtyCount).toBe(1);
      expect(Boolean(manager.getSnapshot(workspace.id, root)?.stale)).toBe(false);
    } finally {
      release();
      await combined;
    }
  });

  it("stages and previews literal pathspec characters without selecting another file", async () => {
    const { manager, root, git } = await fixture();
    const filename = "literal[1].txt";
    await fs.writeFile(path.join(root, filename), "selected\n");
    await fs.writeFile(path.join(root, "literal1.txt"), "other\n");
    const workspace = { id: "literal", cwd: root, kind: "terminal" };
    expect((await manager.stageFile(workspace, { path: filename })).ok).toBe(true);
    const staged = await git(root, ["diff", "--cached", "--name-only", "-z"]);
    expect(staged.stdout).toBe(`${filename}\0`);
    expect(String((await manager.diffPreview(workspace, { path: filename, scope: "staged" })).diff)).toContain(
      "selected",
    );
    expect((await manager.unstageFile(workspace, { path: filename })).ok).toBe(true);
    expect((await git(root, ["diff", "--cached", "--name-only", "-z"])).stdout).toBe("");
  });

  it.skipIf(process.platform === "win32")("preserves a POSIX backslash filename when staging", async () => {
    const { manager, root, git } = await fixture();
    const filename = "literal\\name.txt";
    await fs.writeFile(path.join(root, filename), "selected\n");
    await fs.mkdir(path.join(root, "literal"));
    await fs.writeFile(path.join(root, "literal", "name.txt"), "other\n");
    expect((await manager.stageFile({ id: "posix", cwd: root, kind: "terminal" }, { path: filename })).ok).toBe(true);
    expect((await git(root, ["diff", "--cached", "--name-only", "-z"])).stdout).toBe(`${filename}\0`);
  });

  it("preserves a successful snapshot when the checkout disappears and continues refreshing other roots", async () => {
    const { root, manager, advance, scratch } = await fixture();
    const workspace = { id: "removed", cwd: root, kind: "terminal" };
    await manager.refreshWorkspaces([workspace]);
    const oldRevision = manager.getSnapshot(workspace.id)?.dataRevision;
    await fs.rename(root, path.join(scratch, "moved-repository"));
    advance();
    await expect(manager.refreshWorkspaces([workspace])).resolves.toBeDefined();
    expect(manager.getSnapshot(workspace.id)).toMatchObject({
      available: true,
      stale: true,
      dataRevision: oldRevision,
    });
    expect(manager.getSnapshot(workspace.id)?.refreshError).toBeTruthy();
  });
});
