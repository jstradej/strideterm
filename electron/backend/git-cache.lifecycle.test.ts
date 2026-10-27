import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GitCacheStore } from "./git-cache-store.js";
import { GitManager } from "./git-manager.js";
import { execFileText } from "./process-utils.js";
import { sanitizeGitEnvironment } from "./shared/git-auth-utils.js";
import { sharedReviewGitLocks } from "./review-git/locks.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

async function createRepo() {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "git-cache-lifecycle-"));
  cleanup.push(async () => {
    const resolved = path.resolve(scratch);
    if (
      path.dirname(resolved) !== path.resolve(os.tmpdir()) ||
      !path.basename(resolved).startsWith("git-cache-lifecycle-")
    )
      throw new Error("Invalid lifecycle fixture cleanup path.");
    await fs.rm(resolved, { recursive: true, force: true });
  });
  const root = path.join(scratch, "repository");
  await fs.mkdir(root);
  const env = {
    ...sanitizeGitEnvironment(),
    GIT_CONFIG_GLOBAL: path.join(scratch, "empty-config"),
    GIT_CONFIG_NOSYSTEM: "1",
  };
  const git = (cwd: string, args: string[]) => execFileText("git", args, { cwd, env, timeout: 20_000 });
  await git(root, ["init", "--initial-branch=main"]);
  await git(root, ["config", "user.name", "Lifecycle test"]);
  await git(root, ["config", "user.email", "lifecycle@example.invalid"]);
  await fs.writeFile(path.join(root, "tracked.txt"), "fixture\n");
  await git(root, ["add", "tracked.txt"]);
  await git(root, ["commit", "-m", "fixture"]);
  return { scratch, root, git };
}

function managerFor(
  git: (cwd: string, args: string[]) => Promise<{ stdout: string; stderr: string }>,
  options: ConstructorParameters<typeof GitManager>[0] = {},
) {
  const manager = new GitManager({ ...options, execGitImpl: (cwd, args) => git(cwd, args) });
  manager.detectLazygit = async () => ({ available: false, backend: null, error: "", launch: null });
  cleanup.push(async () => manager.dispose());
  return manager;
}

describe("Git cache lifecycle regressions", () => {
  it("does not resurrect a workspace snapshot when an in-flight refresh is unregistered", async () => {
    const { root, git } = await createRepo();
    let statusStarted!: () => void;
    const started = new Promise<void>((resolve) => (statusStarted = resolve));
    let releaseStatus!: () => void;
    const statusGate = new Promise<void>((resolve) => (releaseStatus = resolve));
    const manager = new GitManager({
      execGitImpl: async (cwd, args) => {
        if (args[0] === "--no-optional-locks" && args.includes("status")) {
          statusStarted();
          await statusGate;
        }
        return git(cwd, args);
      },
    });
    manager.detectLazygit = async () => ({ available: false, backend: null, error: "", launch: null });
    cleanup.push(async () => manager.dispose());
    const workspace = { id: "removing", cwd: root, kind: "terminal" };
    await manager.registerWorkspaces([workspace]);
    const refresh = manager.refreshWorkspaces([workspace]);
    await started;
    await manager.registerWorkspaces([]);
    releaseStatus();
    await refresh;
    expect(manager.getSnapshot(workspace.id, root)).toBeNull();
  });

  it("ignores a late stored summary when a live refresh already published", async () => {
    const { root, git } = await createRepo();
    let readStarted!: () => void;
    const started = new Promise<void>((resolve) => (readStarted = resolve));
    let releaseRead!: () => void;
    const readGate = new Promise<void>((resolve) => (releaseRead = resolve));
    const cacheStore = {
      read: async () => null,
      write: () => {},
      readByRoot: async () => {
        readStarted();
        await readGate;
        return {
          checkoutRoot: root,
          gitDir: path.join(root, ".git"),
          commonDir: path.join(root, ".git"),
          validatedAt: Date.now() - 10_000,
          revision: "old-revision",
          summary: { branch: "old-branch", dirtyCount: 99 },
        };
      },
    };
    const manager = managerFor(git, { cacheStore });
    const workspace = { id: "live", cwd: root, kind: "terminal" };
    const registration = manager.registerWorkspaces([workspace]);
    await started;
    await manager.refreshWorkspaces([workspace]);
    expect(manager.getSnapshot(workspace.id, root)).toMatchObject({ branch: "main", dirtyCount: 0 });
    releaseRead();
    await registration;
    expect(manager.getSnapshot(workspace.id, root)).toMatchObject({ branch: "main", dirtyCount: 0 });
    expect(manager.getSnapshot(workspace.id, root)?.summaryOnly).toBeUndefined();
  });

  it("unsubscribes the manager from global review lock events on dispose", async () => {
    const { root, git } = await createRepo();
    const manager = managerFor(git);
    const workspace = { id: "lock-listener", cwd: root, kind: "terminal" };
    await manager.refreshWorkspaces([workspace]);
    let events = 0;
    manager.on("freshness", () => events++);
    await sharedReviewGitLocks.withWorktree(root, async () => {});
    expect(events).toBe(2);
    manager.dispose();
    await sharedReviewGitLocks.withWorktree(root, async () => {});
    expect(events).toBe(2);
  });

  it("hydrates a previously used alias after restart even when its path is unavailable", async () => {
    const { root, scratch, git } = await createRepo();
    const alias = path.join(scratch, "repository-alias");
    await fs.symlink(root, alias, process.platform === "win32" ? "junction" : "dir");
    const storeDir = path.join(scratch, "data");
    const store = new GitCacheStore(storeDir);
    const first = managerFor(git, { cacheStore: store });
    const original = { id: "canonical", cwd: root, kind: "terminal" };
    await first.refreshWorkspaces([original]);
    await first.refreshWorkspaces([{ id: "alias", cwd: alias, kind: "terminal" }]);
    first.dispose();
    await store.close();
    await fs.unlink(alias);

    const reopened = new GitCacheStore(storeDir);
    const gitAfterRestart = vi.fn(git);
    const second = managerFor(gitAfterRestart, { cacheStore: reopened });
    cleanup.push(async () => reopened.close());
    await second.registerWorkspaces([{ id: "alias", cwd: alias, kind: "terminal" }]);
    expect(gitAfterRestart).not.toHaveBeenCalled();
    expect(second.getSnapshot("alias", alias)).toMatchObject({ branch: "main", stale: true, summaryOnly: true });
  });
});
