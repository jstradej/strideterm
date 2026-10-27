import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GitManager } from "./git-manager.js";
import { execFileText } from "./process-utils.js";
import { parseGitVersion, sanitizeGitEnvironment } from "./shared/git-auth-utils.js";

const gitVersion = (() => {
  try {
    return parseGitVersion(execFileSync("git", ["--version"], { encoding: "utf8", windowsHide: true }));
  } catch {
    return null;
  }
})();
const hasGit = gitVersion !== null;
// `%(ahead-behind:...)` arrived in Git 2.41; older runners take the per-ref fallback.
const hasAheadBehind = !!gitVersion && (gitVersion.major > 2 || (gitVersion.major === 2 && gitVersion.minor >= 41));
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function repoFixture() {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "git-cache-regression-"));
  const root = path.join(temp, "repository with spaces");
  await fs.mkdir(root);
  const env = {
    ...sanitizeGitEnvironment(),
    GIT_CONFIG_GLOBAL: path.join(temp, "empty-global-config"),
    GIT_CONFIG_NOSYSTEM: "1",
  };
  const git = (cwd: string, args: string[]) => execFileText("git", args, { cwd, env, timeout: 20_000 });
  await git(root, ["init", "--initial-branch=main"]);
  await git(root, ["config", "user.name", "Regression fixture"]);
  await git(root, ["config", "user.email", "regression@example.invalid"]);
  await git(root, ["config", "core.autocrlf", "false"]);
  await fs.writeFile(path.join(root, "tracked.txt"), "base\n");
  await git(root, ["add", "."]);
  await git(root, ["commit", "-m", "initial"]);
  const commands: Array<{ cwd: string; args: string[] }> = [];
  const manager = new GitManager({
    execGitImpl: async (cwd, args) => {
      commands.push({ cwd, args: [...args] });
      return git(cwd, args);
    },
  });
  manager.detectLazygit = async () => ({ available: false, backend: null, error: "", launch: null });
  cleanups.push(async () => {
    manager.dispose();
    await fs.rm(temp, { recursive: true, force: true });
  });
  return { temp, root, env, git, manager, commands };
}

const statusCalls = (commands: Array<{ cwd: string; args: string[] }>) =>
  commands.filter(({ args }) => args.includes("status"));

describe.skipIf(!hasGit)("Git cache regressions on real repositories", () => {
  it("fetches shared refs from one linked worktree without checking sibling status", async () => {
    const { temp, root, git, manager, commands } = await repoFixture();
    const remote = path.join(temp, "remote.git");
    const sibling = path.join(temp, "linked worktree");
    await execFileText("git", ["clone", "--bare", root, remote], { cwd: temp, env: sanitizeGitEnvironment() });
    await git(root, ["remote", "add", "origin", remote]);
    await git(root, ["worktree", "add", "-b", "feature", sibling, "main"]);
    const mainWorkspace = { id: "linked-main", cwd: root, kind: "terminal" };
    const siblingWorkspace = { id: "linked-feature", cwd: sibling, kind: "terminal" };
    await manager.registerWorkspaces([mainWorkspace, siblingWorkspace]);
    commands.length = 0;

    await Promise.all([manager.refreshWorkspaces([mainWorkspace]), manager.refreshWorkspaces([siblingWorkspace])]);
    const sharedReads = (predicate: (args: string[]) => boolean) => commands.filter(({ args }) => predicate(args));
    expect(sharedReads((args) => args.join(" ") === "worktree list --porcelain")).toHaveLength(1);
    expect(
      sharedReads(
        (args) =>
          args[0] === "for-each-ref" &&
          args.includes("refs/heads") &&
          args.includes("refs/remotes") &&
          !args.some((arg) => arg.includes("ahead-behind")),
      ),
    ).toHaveLength(1);
    expect(sharedReads((args) => args[0] === "stash" && args[1] === "list")).toHaveLength(1);
    expect(
      statusCalls(commands)
        .map(({ cwd }) => path.resolve(cwd))
        .sort(),
    ).toEqual([path.resolve(root), path.resolve(sibling)].sort());

    commands.length = 0;
    expect((await manager.fetch(mainWorkspace)).ok).toBe(true);

    expect(statusCalls(commands).some(({ cwd }) => path.resolve(cwd) === path.resolve(sibling))).toBe(false);
    expect((await git(sibling, ["show-ref", "--verify", "refs/remotes/origin/main"])).stdout.trim()).toMatch(
      /refs\/remotes\/origin\/main$/,
    );
  });

  it("finds the base branch with one ref walk and agrees with the per-candidate walk", async () => {
    const { root, git, manager, commands } = await repoFixture();
    const commit = async (name: string) => {
      await fs.writeFile(path.join(root, `${name}.txt`), `${name}\n`);
      await git(root, ["add", "."]);
      await git(root, ["commit", "-m", name]);
    };
    await git(root, ["checkout", "-b", "feature/auth"]);
    for (const name of ["auth-1", "auth-2", "auth-3"]) await commit(name);
    await git(root, ["checkout", "-b", "feature/auth-fix"]);
    await commit("fix-1");
    await git(root, ["checkout", "--orphan", "unrelated"]);
    await commit("unrelated-1");
    await git(root, ["checkout", "feature/auth-fix"]);
    const candidates = ["main", "feature/auth", "unrelated"];
    const detect = (current: string) => manager.detectBestBaseBranch(root, current, "", candidates, {}, "");

    commands.length = 0;
    expect(await detect("feature/auth-fix")).toBe("feature/auth");
    if (hasAheadBehind) expect(commands.length).toBeLessThanOrEqual(2);
    await git(root, ["checkout", "unrelated"]);
    expect(await detect("unrelated")).toBe(
      await (async () => {
        (manager as unknown as { aheadBehindSupported: boolean }).aheadBehindSupported = false;
        try {
          return await detect("unrelated");
        } finally {
          (manager as unknown as { aheadBehindSupported: boolean }).aheadBehindSupported = true;
        }
      })(),
    );
    await git(root, ["checkout", "feature/auth-fix"]);
    (manager as unknown as { aheadBehindSupported: boolean }).aheadBehindSupported = false;
    expect(await detect("feature/auth-fix")).toBe("feature/auth");
  });

  it("lists branch ahead/behind against HEAD in one ref walk, matching the per-branch counts", async () => {
    const { root, git, manager, commands } = await repoFixture();
    const commit = async (name: string) => {
      await fs.writeFile(path.join(root, `${name}.txt`), `${name}\n`);
      await git(root, ["add", "."]);
      await git(root, ["commit", "-m", name]);
    };
    await git(root, ["branch", "merged-old"]);
    await git(root, ["checkout", "-b", "ahead-two"]);
    await commit("a1");
    await commit("a2");
    await git(root, ["checkout", "main"]);
    await commit("main-1");
    const shape = async () =>
      (await manager.listBranches({ id: "branches", cwd: root }, { rootPath: root })).local
        .map((entry) => `${entry.name}:${entry.ahead}/${entry.behind}/${entry.merged}`)
        .sort();

    commands.length = 0;
    const batched = await shape();
    if (hasAheadBehind)
      expect(commands.filter(({ args }) => args[0] === "rev-list" && args.includes("--left-right"))).toEqual([]);
    expect(batched).toEqual(["ahead-two:2/1/false", "main:0/0/false", "merged-old:0/1/true"]);
    (manager as unknown as { aheadBehindSupported: boolean }).aheadBehindSupported = false;
    expect(await shape()).toEqual(batched);
  });

  it("stops refreshing for writes into an ignored directory but keeps force-added files live", async () => {
    const { root, git, manager, commands } = await repoFixture();
    await fs.writeFile(path.join(root, ".gitignore"), "dist/\nvendor/\n");
    await fs.mkdir(path.join(root, "dist", "assets"), { recursive: true });
    await fs.mkdir(path.join(root, "vendor"));
    await fs.writeFile(path.join(root, "vendor", "kept.js"), "v1\n");
    await git(root, ["add", ".gitignore"]);
    await git(root, ["add", "-f", "vendor/kept.js"]);
    await git(root, ["commit", "-m", "ignore build output"]);
    const workspace = { id: "ignored-writes", cwd: root, kind: "terminal" };
    await manager.registerWorkspaces([workspace]);
    await manager.setInterestedWorkspaces([workspace]);
    await manager.refreshWorkspaces([workspace]);
    const ignoreChecks = () => commands.filter(({ args }) => args.includes("check-ignore"));

    await fs.writeFile(path.join(root, "dist", "assets", "first.js"), "1");
    await fs.writeFile(path.join(root, "vendor", "other.js"), "1");
    await vi.waitFor(() => expect(ignoreChecks().length).toBeGreaterThanOrEqual(2), { timeout: 5000 });
    await vi.waitFor(() => expect(manager.getProcessStats()).toMatchObject({ active: 0, queued: 0 }), {
      timeout: 5000,
    });
    await new Promise((resolve) => setTimeout(resolve, 600));
    const invalidatedPaths: string[] = [];
    manager.on("invalidated", (event: { paths: string[] }) =>
      invalidatedPaths.push(...event.paths.map((entry) => entry.replace(/\\/g, "/"))),
    );

    for (let index = 0; index < 10; index++)
      await fs.writeFile(path.join(root, "dist", "assets", `chunk-${index}.js`), String(index));
    await new Promise((resolve) => setTimeout(resolve, 1500));
    // Asserted on the paths, not on Git calls: a late event from the setup writes may still refresh.
    expect(invalidatedPaths.filter((entry) => entry.startsWith("dist"))).toEqual([]);

    commands.length = 0;
    await fs.writeFile(path.join(root, "vendor", "kept.js"), "v2\n");
    await vi.waitFor(() => expect(invalidatedPaths).toContain("vendor/kept.js"), { timeout: 5000 });
    await vi.waitFor(() => expect(statusCalls(commands).length).toBeGreaterThan(0), { timeout: 5000 });
    await manager.setInterestedWorkspaces([]);
    await vi.waitFor(() => expect(manager.getProcessStats()).toMatchObject({ active: 0, queued: 0 }), {
      timeout: 5000,
    });
  });

  it("keeps history and diff statistics out of a status refresh after stage and unstage", async () => {
    const { root, manager, commands } = await repoFixture();
    const workspace = { id: "stage-refresh", cwd: root, kind: "terminal" };
    await manager.refreshWorkspaces([workspace]);
    await fs.writeFile(path.join(root, "tracked.txt"), "staged edit\n");
    expect((await manager.stageFile(workspace, { path: "tracked.txt" })).ok).toBe(true);
    expect((await manager.unstageFile(workspace, { path: "tracked.txt" })).ok).toBe(true);

    commands.length = 0;
    await manager.refreshWorkspaces([workspace], { reason: "mutation" });

    expect(
      commands
        .filter(({ args }) =>
          args.some((arg) => ["log", "rev-list", "merge-base", "diff", "--shortstat"].includes(arg)),
        )
        .map(({ args }) => args.join(" ")),
    ).toEqual([]);
  });

  it("creates and drops stashes, and retains merge operation state after a failed merge or stage", async () => {
    const { root, git, manager } = await repoFixture();
    const workspace = { id: "merge-stash", cwd: root, kind: "terminal" };
    // Warm the UI cache once. The subsequent mutation checks should exercise
    // incremental refreshes where possible instead of charging a cold snapshot
    // to every write.
    await manager.refreshWorkspaces([workspace]);
    await fs.writeFile(path.join(root, "tracked.txt"), "stashed edit\n");
    expect((await manager.stash(workspace, { message: "regression stash" })).ok).toBe(true);
    const stashes = await manager.listStashes(workspace);
    expect(stashes.stashes).toHaveLength(1);
    expect((await manager.stashDrop(workspace, { ref: "stash@{0}" })).ok).toBe(true);
    expect((await manager.listStashes(workspace)).stashes).toHaveLength(0);

    expect((await manager.stageFile(workspace, { path: "missing-file.txt" })).ok).toBe(false);
    await manager.refreshWorkspaces([workspace]);
    const failedStage = manager.getSnapshot(workspace.id) || {};
    expect(failedStage.operationState).toMatchObject({ kind: "idle", inProgress: false });

    await fs.writeFile(path.join(root, "conflict.txt"), "base\n");
    await git(root, ["add", "conflict.txt"]);
    await git(root, ["commit", "-m", "conflict base"]);
    await git(root, ["branch", "left"]);
    await git(root, ["branch", "right"]);
    await git(root, ["checkout", "left"]);
    await fs.writeFile(path.join(root, "conflict.txt"), "left\n");
    await git(root, ["commit", "-am", "left change"]);
    await git(root, ["checkout", "right"]);
    await fs.writeFile(path.join(root, "conflict.txt"), "right\n");
    await git(root, ["commit", "-am", "right change"]);
    await git(root, ["checkout", "left"]);

    expect((await manager.mergeIntoCurrent(workspace, { baseBranch: "right" })).ok).toBe(false);
    await manager.refreshWorkspaces([workspace]);
    const conflicted = manager.getSnapshot(workspace.id) || {};
    expect(conflicted.operationState).toMatchObject({ kind: "merge", inProgress: true });
    expect((conflicted.operationState as { conflicts: string[] }).conflicts).toContain("conflict.txt");
    await manager.abortOperation(workspace, { rootPath: root });
  });

  it("keeps review role projections separate while sharing one physical status read", async () => {
    const { root, git, manager, commands } = await repoFixture();
    const head = (await git(root, ["rev-parse", "HEAD"])).stdout.trim();
    await git(root, ["update-ref", "refs/remotes/origin/source", head]);
    await git(root, ["update-ref", "refs/remotes/origin/target", head]);
    const reviewer = {
      id: "reviewer-view",
      cwd: root,
      kind: "review",
      review: { role: "reviewer", pullRequest: { id: 1, sourceRefName: "source", targetRefName: "target" } },
    };
    const author = {
      id: "author-view",
      cwd: root,
      kind: "review",
      review: { role: "author", pullRequest: { id: 1, sourceRefName: "source", targetRefName: "target" } },
    };
    await Promise.all([manager.refreshWorkspaces([reviewer]), manager.refreshWorkspaces([author])]);
    expect(manager.getSnapshot(reviewer.id)?.baseBranch).toBe("origin/source");
    expect(manager.getSnapshot(author.id)?.baseBranch).toBe("origin/target");
    expect(statusCalls(commands)).toHaveLength(1);
  });

  it("re-identifies a replaced repository at the same path and does not resurrect a removed in-flight binding", async () => {
    const { root, temp, git, manager, commands } = await repoFixture();
    const workspace = { id: "replace", cwd: root, kind: "terminal" };
    await manager.registerWorkspaces([workspace]);
    await manager.refreshWorkspaces([workspace]);
    const oldHead = manager.getSnapshot(workspace.id)?.headOid;
    await fs.rm(root, { recursive: true, force: true });
    await fs.mkdir(root);
    await git(root, ["init", "--initial-branch=replacement"]);
    await git(root, ["config", "user.name", "Replacement"]);
    await git(root, ["config", "user.email", "replacement@example.invalid"]);
    await fs.writeFile(path.join(root, "new.txt"), "new repository\n");
    await git(root, ["add", "."]);
    await git(root, ["commit", "-m", "replacement repository"]);
    manager.invalidateSnapshotCache(workspace.id, root);
    await manager.refreshWorkspaces([workspace]);
    expect(manager.getSnapshot(workspace.id)).toMatchObject({ available: true, branch: "replacement" });
    expect(manager.getSnapshot(workspace.id)?.stale).toBeFalsy();
    expect(manager.getSnapshot(workspace.id)?.headOid).not.toBe(oldHead);

    const inFlight = await repoFixture();
    const pendingWorkspace = { id: "removed-in-flight", cwd: inFlight.root, kind: "terminal" };
    await inFlight.manager.registerWorkspaces([pendingWorkspace]);
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const originalRunner = inFlight.manager.execGitImpl!;
    let blockedOnce = false;
    inFlight.manager.execGitImpl = async (cwd, args, options) => {
      if (!blockedOnce && args.includes("status")) {
        blockedOnce = true;
        await blocked;
      }
      return originalRunner(cwd, args, options);
    };
    const pendingRefresh = inFlight.manager.refreshWorkspaces([pendingWorkspace]);
    await vi.waitFor(() => expect(blockedOnce).toBe(true), { timeout: 5000 });
    await inFlight.manager.registerWorkspaces([]);
    release();
    await pendingRefresh;
    expect(inFlight.manager.getSnapshot(pendingWorkspace.id)).toBeNull();
  });
});
