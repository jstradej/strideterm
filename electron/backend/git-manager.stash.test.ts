/// <reference types="node" />
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { afterEach, beforeAll, describe, expect, test } from "vitest";
import { GitManager } from "./git-manager.js";
import { setAllowedRootsResolver } from "./file-manager.js";

// computeStashFileDiff routes through file-manager, which refuses paths outside
// the registered allow-list. Point the resolver at our live tmp-repo list.
beforeAll(() => {
  setAllowedRootsResolver(() => tempPaths);
});

// Stash detail / lifecycle is exercised against a real git repo: the multi-call
// command sequences (list → base lookup → name-status → numstat → untracked
// tree) are too intertwined to mock faithfully. git 2.50+ is available in CI;
// each test spins up a throwaway tmp repo cleaned by the afterEach.

const tempPaths: string[] = [];

afterEach(async () => {
  await Promise.all(tempPaths.splice(0).map((p) => fs.rm(p, { recursive: true, force: true })));
});

async function makeStashRepo() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "strideterm-stash-"));
  tempPaths.push(root);
  const manager = new GitManager({});
  const g = (args: string[]) => manager.execGit(root, args);
  await g(["init", "-b", "master"]);
  await g(["config", "user.email", "t@example.com"]);
  await g(["config", "user.name", "Tester"]);
  await g(["config", "commit.gpgsign", "false"]);
  await g(["config", "core.autocrlf", "false"]);
  await fs.writeFile(path.join(root, "base.txt"), "line1\nline2\n", "utf8");
  await g(["add", "-A"]);
  await g(["commit", "-m", "initial"]);
  return { root, manager, g };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function stashList(res: any) {
  return res.stashes as Array<Record<string, unknown>>;
}

describe("GitManager stash lifecycle (real git)", () => {
  test("listStashes returns empty for a repo with no stashes", async () => {
    const { root, manager } = await makeStashRepo();
    const res = await manager.listStashes(null, { rootPath: root });
    expect(res.ok).toBe(true);
    expect(res.stashes).toHaveLength(0);
  });

  async function makeUnbornRepo() {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "strideterm-stash-unborn-"));
    tempPaths.push(root);
    const manager = new GitManager({});
    const g = (args: string[]) => manager.execGit(root, args);
    await g(["init", "-b", "master"]);
    await g(["config", "user.email", "t@example.com"]);
    await g(["config", "user.name", "Tester"]);
    await g(["config", "commit.gpgsign", "false"]);
    await fs.writeFile(path.join(root, "test.md"), "hi\n", "utf8");
    return { root, manager, g };
  }

  test("stash on an unborn HEAD signals needsInitialCommit instead of failing cryptically", async () => {
    // Repo with no initial commit — `git stash` here fails with the cryptic
    // "You do not have the initial commit yet". The preflight should catch it
    // and flag the one-click fix rather than running git stash.
    const { root, manager } = await makeUnbornRepo();
    const res = await manager.stash(null, { rootPath: root, includeUntracked: true });
    expect(res.ok).toBe(false);
    expect(res.needsInitialCommit).toBe(true);
    expect(String(res.summary)).toMatch(/no commits yet/i);
  });

  test("stash with allowEmptyInitialCommit creates a root commit then stashes", async () => {
    const { root, manager } = await makeUnbornRepo();
    const res = await manager.stash(null, { rootPath: root, includeUntracked: true, allowEmptyInitialCommit: true });
    expect(res.ok).toBe(true);
    // An empty root commit now exists and the untracked file is in the stash.
    const list = stashList(await manager.listStashes(null, { rootPath: root }));
    expect(list).toHaveLength(1);
    const files = (await manager.stashFiles(null, { rootPath: root, ref: "stash@{0}" })) as {
      files: Array<{ path: string }>;
    };
    expect(files.files.some((f) => f.path === "test.md")).toBe(true);
  });

  test("listStashes parses 'On <branch>: <msg>' into branch + customMessage", async () => {
    const { root, manager } = await makeStashRepo();
    await fs.writeFile(path.join(root, "base.txt"), "changed\n", "utf8");
    await manager.stash(null, { rootPath: root, message: "fix race", includeUntracked: false });
    const entry = stashList(await manager.listStashes(null, { rootPath: root }))[0];
    expect(entry.branch).toBe("master");
    expect(entry.customMessage).toBe("fix race");
    expect(entry.isWipDefault).toBe(false);
    expect(entry.ref).toBe("stash@{0}");
  });

  test("listStashes parses 'WIP on <branch>: <subject>' as isWipDefault=true", async () => {
    const { root, g } = await makeStashRepo();
    const manager = new GitManager({});
    await fs.writeFile(path.join(root, "base.txt"), "changed\n", "utf8");
    await g(["stash", "push"]); // no -m -> WIP default
    const entry = stashList(await manager.listStashes(null, { rootPath: root }))[0];
    expect(entry.isWipDefault).toBe(true);
    expect(entry.customMessage).toBe("");
  });

  test("listStashes returns entries newest-first (stash@{0} is the latest)", async () => {
    const { root, manager } = await makeStashRepo();
    await fs.writeFile(path.join(root, "base.txt"), "a\n", "utf8");
    await manager.stash(null, { rootPath: root, message: "first", includeUntracked: false });
    await fs.writeFile(path.join(root, "base.txt"), "b\n", "utf8");
    await manager.stash(null, { rootPath: root, message: "second", includeUntracked: false });
    const list = stashList(await manager.listStashes(null, { rootPath: root }));
    expect(list[0].customMessage).toBe("second");
    expect(list[1].customMessage).toBe("first");
  });

  test("stashFiles reports an added (tracked) file", async () => {
    const { root, manager, g } = await makeStashRepo();
    await fs.writeFile(path.join(root, "base.txt"), "line1\nline2\nline3\n", "utf8");
    await fs.writeFile(path.join(root, "added.txt"), "new\n", "utf8");
    await g(["add", "added.txt"]);
    await manager.stash(null, { rootPath: root, message: "m", includeUntracked: false });
    const res = await manager.stashFiles(null, { rootPath: root, ref: "stash@{0}" });
    expect(res.ok).toBe(true);
    const byPath = new Map(res.files.map((f) => [f.path, f]));
    expect(byPath.get("added.txt")?.status).toBe("added");
    expect(byPath.get("base.txt")?.status).toBe("modified");
    expect(byPath.get("base.txt")?.additions ?? 0).toBeGreaterThan(0);
  });

  test("stashFiles flags binary files (numstat '-\\t-')", async () => {
    const { root, manager, g } = await makeStashRepo();
    await fs.writeFile(path.join(root, "blob.bin"), Buffer.from([0, 1, 2, 0, 255, 254, 0, 10]));
    await g(["add", "blob.bin"]);
    await g(["commit", "-m", "add binary"]);
    await fs.writeFile(path.join(root, "blob.bin"), Buffer.from([0, 9, 9, 9, 0, 1, 2, 3]));
    await manager.stash(null, { rootPath: root, message: "bin", includeUntracked: false });
    const res = await manager.stashFiles(null, { rootPath: root, ref: "stash@{0}" });
    const file = res.files.find((f) => f.path === "blob.bin");
    expect(file?.isBinary).toBe(true);
    expect(file?.additions).toBe(0);
  });

  test("stashFiles includes untracked files when stashed with -u", async () => {
    const { root, manager } = await makeStashRepo();
    await fs.writeFile(path.join(root, "untracked.txt"), "u\n", "utf8");
    await fs.writeFile(path.join(root, "base.txt"), "edit\n", "utf8");
    await manager.stash(null, { rootPath: root, message: "with-u", includeUntracked: true });
    const res = await manager.stashFiles(null, { rootPath: root, ref: "stash@{0}" });
    const untracked = res.files.find((f) => f.path === "untracked.txt");
    expect(untracked?.status).toBe("untracked");
    expect(untracked?.code).toBe("?");
  });

  test("stashFiles excludes untracked when stashed without -u", async () => {
    const { root, manager } = await makeStashRepo();
    await fs.writeFile(path.join(root, "untracked.txt"), "u\n", "utf8");
    await fs.writeFile(path.join(root, "base.txt"), "edit\n", "utf8");
    await manager.stash(null, { rootPath: root, message: "no-u", includeUntracked: false });
    const res = await manager.stashFiles(null, { rootPath: root, ref: "stash@{0}" });
    expect(res.files.some((f) => f.path === "untracked.txt")).toBe(false);
  });

  test("stashFileDiff returns base->stash diff for a modified file", async () => {
    const { root, manager } = await makeStashRepo();
    await fs.writeFile(path.join(root, "base.txt"), "line1\nCHANGED\n", "utf8");
    await manager.stash(null, { rootPath: root, message: "mod", includeUntracked: false });
    const diff = (await manager.stashFileDiff(null, {
      rootPath: root,
      ref: "stash@{0}",
      relativePath: "base.txt",
    })) as { leftContent: string; rightContent: string; leftMissing: boolean; rightMissing: boolean };
    expect(diff.leftContent).toContain("line2");
    expect(diff.rightContent).toContain("CHANGED");
    expect(diff.leftMissing).toBe(false);
    expect(diff.rightMissing).toBe(false);
  });

  test("stashFileDiff marks an added file as leftMissing", async () => {
    const { root, manager, g } = await makeStashRepo();
    await fs.writeFile(path.join(root, "fresh.ts"), "export const x = 1;\n", "utf8");
    await g(["add", "fresh.ts"]);
    await manager.stash(null, { rootPath: root, message: "add", includeUntracked: false });
    const diff = (await manager.stashFileDiff(null, {
      rootPath: root,
      ref: "stash@{0}",
      relativePath: "fresh.ts",
    })) as { leftContent: string; rightContent: string; leftMissing: boolean; rightMissing: boolean };
    expect(diff.leftMissing).toBe(true);
    expect(diff.rightContent).toContain("export const x");
  });

  test("stashFileDiff marks a deleted file as rightMissing", async () => {
    const { root, manager } = await makeStashRepo();
    await fs.rm(path.join(root, "base.txt"));
    await manager.stash(null, { rootPath: root, message: "del", includeUntracked: false });
    const diff = (await manager.stashFileDiff(null, {
      rootPath: root,
      ref: "stash@{0}",
      relativePath: "base.txt",
    })) as { leftContent: string; rightContent: string; leftMissing: boolean; rightMissing: boolean };
    expect(diff.rightMissing).toBe(true);
    expect(diff.leftContent).toContain("line1");
  });

  test("stashFileDiff pulls untracked content from stash^3", async () => {
    const { root, manager } = await makeStashRepo();
    await fs.writeFile(path.join(root, "note.txt"), "hello untracked\n", "utf8");
    await fs.writeFile(path.join(root, "base.txt"), "edit\n", "utf8");
    await manager.stash(null, { rootPath: root, message: "u", includeUntracked: true });
    const diff = (await manager.stashFileDiff(null, {
      rootPath: root,
      ref: "stash@{0}",
      relativePath: "note.txt",
    })) as { leftContent: string; rightContent: string; leftMissing: boolean; rightMissing: boolean };
    expect(diff.leftMissing).toBe(true);
    expect(diff.rightContent).toContain("hello untracked");
  });

  test("stash(message, includeUntracked) creates an entry with the message", async () => {
    const { root, manager } = await makeStashRepo();
    await fs.writeFile(path.join(root, "base.txt"), "edit\n", "utf8");
    const res = await manager.stash(null, { rootPath: root, message: "hello", includeUntracked: true });
    expect(res.ok).toBe(true);
    const list = stashList(await manager.listStashes(null, { rootPath: root }));
    expect(list[0].customMessage).toBe("hello");
  });

  test("stash with paths only stashes the listed files, leaving the rest dirty", async () => {
    const { root, manager, g } = await makeStashRepo();
    await g(["commit", "--allow-empty", "-m", "noop"]); // keep history non-empty
    await fs.writeFile(path.join(root, "other.txt"), "other\n", "utf8");
    await g(["add", "other.txt"]);
    await g(["commit", "-m", "add other"]);
    // Two tracked files now dirty.
    await fs.writeFile(path.join(root, "base.txt"), "changed-base\n", "utf8");
    await fs.writeFile(path.join(root, "other.txt"), "changed-other\n", "utf8");
    const res = await manager.stash(null, {
      rootPath: root,
      message: "only base",
      includeUntracked: false,
      paths: ["base.txt"],
    });
    expect(res.ok).toBe(true);
    // The stash holds just base.txt …
    const files = await manager.stashFiles(null, { rootPath: root, ref: "stash@{0}" });
    expect(files.files.map((f) => f.path)).toEqual(["base.txt"]);
    // … and other.txt is still modified in the working tree (not stashed).
    const status = (await g(["status", "--porcelain"])).stdout;
    expect(status).toContain("other.txt");
    expect(status).not.toContain("base.txt");
  });

  test("stash on a clean tree returns ok:false 'No local changes'", async () => {
    const { root, manager } = await makeStashRepo();
    const res = await manager.stash(null, { rootPath: root });
    expect(res.ok).toBe(false);
    expect(String(res.summary)).toMatch(/no local changes/i);
  });

  test("stashPop without ref pops stash@{0}", async () => {
    const { root, manager } = await makeStashRepo();
    await fs.writeFile(path.join(root, "base.txt"), "edit\n", "utf8");
    await manager.stash(null, { rootPath: root, message: "x", includeUntracked: false });
    const res = await manager.stashPop(null, { rootPath: root });
    expect(res.ok).toBe(true);
    expect((await manager.listStashes(null, { rootPath: root })).stashes).toHaveLength(0);
  });

  test("stashPop with ref pops the specified entry and shifts indices", async () => {
    const { root, manager } = await makeStashRepo();
    await fs.writeFile(path.join(root, "base.txt"), "a\n", "utf8");
    await manager.stash(null, { rootPath: root, message: "first", includeUntracked: false });
    await fs.writeFile(path.join(root, "base.txt"), "b\n", "utf8");
    await manager.stash(null, { rootPath: root, message: "second", includeUntracked: false });
    const res = await manager.stashPop(null, { rootPath: root, ref: "stash@{1}" });
    expect(res.ok).toBe(true);
    const list = stashList(await manager.listStashes(null, { rootPath: root }));
    expect(list).toHaveLength(1);
    expect(list[0].customMessage).toBe("second");
  });

  test("stashApply leaves the entry in place", async () => {
    const { root, manager } = await makeStashRepo();
    await fs.writeFile(path.join(root, "base.txt"), "edit\n", "utf8");
    await manager.stash(null, { rootPath: root, message: "x", includeUntracked: false });
    const res = await manager.stashApply(null, { rootPath: root, ref: "stash@{0}" });
    expect(res.ok).toBe(true);
    expect((await manager.listStashes(null, { rootPath: root })).stashes).toHaveLength(1);
  });

  test("stashDrop removes the entry", async () => {
    const { root, manager } = await makeStashRepo();
    await fs.writeFile(path.join(root, "base.txt"), "edit\n", "utf8");
    await manager.stash(null, { rootPath: root, message: "x", includeUntracked: false });
    const res = await manager.stashDrop(null, { rootPath: root, ref: "stash@{0}" });
    expect(res.ok).toBe(true);
    expect((await manager.listStashes(null, { rootPath: root })).stashes).toHaveLength(0);
  });

  test("stashBranch switchImmediately=true creates+applies+drops, HEAD on new branch", async () => {
    const { root, manager, g } = await makeStashRepo();
    await fs.writeFile(path.join(root, "base.txt"), "edit\n", "utf8");
    await manager.stash(null, { rootPath: root, message: "x", includeUntracked: false });
    const res = await manager.stashBranch(null, {
      rootPath: root,
      ref: "stash@{0}",
      branchName: "feature-from-stash",
      switchImmediately: true,
    });
    expect(res.ok).toBe(true);
    expect((await g(["rev-parse", "--abbrev-ref", "HEAD"])).stdout.trim()).toBe("feature-from-stash");
    expect((await manager.listStashes(null, { rootPath: root })).stashes).toHaveLength(0);
  });

  test("stashBranch switchImmediately=false creates ref, keeps HEAD and the stash", async () => {
    const { root, manager, g } = await makeStashRepo();
    await fs.writeFile(path.join(root, "base.txt"), "edit\n", "utf8");
    await manager.stash(null, { rootPath: root, message: "x", includeUntracked: false });
    const res = await manager.stashBranch(null, {
      rootPath: root,
      ref: "stash@{0}",
      branchName: "ref-only",
      switchImmediately: false,
    });
    expect(res.ok).toBe(true);
    expect((await g(["rev-parse", "--abbrev-ref", "HEAD"])).stdout.trim()).toBe("master");
    expect((await g(["branch", "--list", "ref-only"])).stdout).toContain("ref-only");
    expect((await manager.listStashes(null, { rootPath: root })).stashes).toHaveLength(1);
  });

  test("stashBranch switchImmediately=true on a dirty tree refuses, tree+stash intact", async () => {
    const { root, manager } = await makeStashRepo();
    await fs.writeFile(path.join(root, "base.txt"), "stashed\n", "utf8");
    await manager.stash(null, { rootPath: root, message: "x", includeUntracked: false });
    await fs.writeFile(path.join(root, "base.txt"), "dirty-now\n", "utf8");
    const res = await manager.stashBranch(null, {
      rootPath: root,
      ref: "stash@{0}",
      branchName: "wont-happen",
      switchImmediately: true,
    });
    expect(res.ok).toBe(false);
    expect((await manager.listStashes(null, { rootPath: root })).stashes).toHaveLength(1);
    expect(await fs.readFile(path.join(root, "base.txt"), "utf8")).toContain("dirty-now");
  });

  test("stashBranch rejects an invalid branch name", async () => {
    const { root, manager } = await makeStashRepo();
    await fs.writeFile(path.join(root, "base.txt"), "edit\n", "utf8");
    await manager.stash(null, { rootPath: root, message: "x", includeUntracked: false });
    const res = await manager.stashBranch(null, {
      rootPath: root,
      ref: "stash@{0}",
      branchName: "bad name!!",
      switchImmediately: false,
    });
    expect(res.ok).toBe(false);
    expect(String(res.summary)).toMatch(/invalid branch name/i);
  });

  test("stashExportPatch -> drop -> stashImportPatch round-trips the entry", async () => {
    const { root, manager, g } = await makeStashRepo();
    await fs.writeFile(path.join(root, "base.txt"), "line1\nROUNDTRIP\n", "utf8");
    await manager.stash(null, { rootPath: root, message: "exported", includeUntracked: false });
    const exported = await manager.stashExportPatch(null, { rootPath: root, ref: "stash@{0}" });
    expect(exported.ok).toBe(true);
    expect(exported.patch).toContain("diff --git");
    await manager.stashDrop(null, { rootPath: root, ref: "stash@{0}" });
    await g(["checkout", "--", "base.txt"]).catch(() => undefined);
    const imported = await manager.stashImportPatch(null, {
      rootPath: root,
      patch: exported.patch,
      message: "reimported",
    });
    expect(imported.ok).toBe(true);
    const list = stashList(await manager.listStashes(null, { rootPath: root }));
    expect(list[0].customMessage).toBe("reimported");
  });

  test("stashExportPatch includes untracked files when the stash had -u", async () => {
    const { root, manager } = await makeStashRepo();
    await fs.writeFile(path.join(root, "extra.txt"), "untracked body\n", "utf8");
    await fs.writeFile(path.join(root, "base.txt"), "edit\n", "utf8");
    await manager.stash(null, { rootPath: root, message: "withU", includeUntracked: true });
    const exported = await manager.stashExportPatch(null, { rootPath: root, ref: "stash@{0}" });
    expect(exported.ok).toBe(true);
    expect(exported.patch).toContain("extra.txt");
    expect(exported.patch).toContain("untracked body");
  });

  test("stashImportPatch rejects a path-traversal diff header", async () => {
    const { root, manager } = await makeStashRepo();
    const evil = [
      "# strideterm-stash-patch v1",
      "# message: evil",
      "diff --git a/../../escape.txt b/../../escape.txt",
      "--- a/../../escape.txt",
      "+++ b/../../escape.txt",
      "@@ -0,0 +1 @@",
      "+pwned",
      "",
    ].join("\n");
    const res = await manager.stashImportPatch(null, { rootPath: root, patch: evil });
    expect(res.ok).toBe(false);
    expect(String(res.summary)).toMatch(/outside the repository/i);
  });

  test("stashImportPatch returns an error (not a crash) for a malformed body", async () => {
    const { root, manager } = await makeStashRepo();
    const garbage = [
      "# strideterm-stash-patch v1",
      "diff --git a/base.txt b/base.txt",
      "this is not a valid hunk at all",
      "",
    ].join("\n");
    const res = await manager.stashImportPatch(null, { rootPath: root, patch: garbage });
    expect(res.ok).toBe(false);
  });

  test("stashImportPatch on a dirty tree auto-stashes current changes first", async () => {
    const { root, manager } = await makeStashRepo();
    await fs.writeFile(path.join(root, "base.txt"), "line1\nPATCHED\n", "utf8");
    await manager.stash(null, { rootPath: root, message: "src", includeUntracked: false });
    const exported = await manager.stashExportPatch(null, { rootPath: root, ref: "stash@{0}" });
    await manager.stashDrop(null, { rootPath: root, ref: "stash@{0}" });
    // Dirty the tree with an UNRELATED change so import must set it aside first.
    await fs.writeFile(path.join(root, "other.txt"), "unrelated dirty\n", "utf8");
    const res = await manager.stashImportPatch(null, {
      rootPath: root,
      patch: exported.patch,
      message: "imported",
    });
    expect(res.ok).toBe(true);
    // One stash for the imported patch + one for the auto-stashed dirty changes.
    expect((await manager.listStashes(null, { rootPath: root })).stashes.length).toBe(2);
  });

  test("stashImportPatch on a dirty tree with an OVERLAPPING edit auto-stashes first, then applies", async () => {
    const { root, manager } = await makeStashRepo();
    // Build a patch that turns base.txt line2 into PATCHED.
    await fs.writeFile(path.join(root, "base.txt"), "line1\nPATCHED\n", "utf8");
    await manager.stash(null, { rootPath: root, message: "src", includeUntracked: false });
    const exported = await manager.stashExportPatch(null, { rootPath: root, ref: "stash@{0}" });
    await manager.stashDrop(null, { rootPath: root, ref: "stash@{0}" });
    // Dirty the SAME line the patch touches. `git apply --check` against this
    // working tree fails — but once the importer sets these changes aside the
    // patch applies cleanly to HEAD. Regression guard for the old ordering that
    // ran --check before the auto-stash (it rejected this case spuriously).
    await fs.writeFile(path.join(root, "base.txt"), "line1\nLOCAL-EDIT\n", "utf8");
    const res = await manager.stashImportPatch(null, {
      rootPath: root,
      patch: exported.patch,
      message: "imported",
    });
    expect(res.ok).toBe(true);
    // Imported stash + auto-stashed local edit.
    expect((await manager.listStashes(null, { rootPath: root })).stashes.length).toBe(2);
    // The patch really applied: the imported stash (top) carries the PATCHED line.
    await manager.stashApply(null, { rootPath: root, ref: "stash@{0}" });
    expect(await fs.readFile(path.join(root, "base.txt"), "utf8")).toContain("PATCHED");
  });
});
