import { execFileSync } from "node:child_process";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { canonicalLockKey, commonDirOf, createReviewGitLocks } from "./locks.js";

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

describe("review Git locks", () => {
  test("work on one checkout runs strictly one after another", async () => {
    const locks = createReviewGitLocks();
    const log: string[] = [];
    const first = locks.withWorktree("/repo/wt", async () => {
      log.push("first:start");
      await tick();
      await tick();
      log.push("first:end");
    });
    const second = locks.withWorktree("/repo/wt", async () => {
      log.push("second:start");
      log.push("second:end");
    });
    await Promise.all([first, second]);
    expect(log).toEqual(["first:start", "first:end", "second:start", "second:end"]);
  });

  test("distinct worktrees of one repository mutate concurrently, but their shared-ref work serializes", async () => {
    const locks = createReviewGitLocks();
    const log: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const a = locks.withWorktree("/cache/wt-a", async () => {
      log.push("a:start");
      await gate;
      log.push("a:end");
    });
    const b = locks.withWorktree("/cache/wt-b", async () => {
      log.push("b:start");
      log.push("b:end");
    });
    await b;
    // b finished while a still held its own worktree.
    expect(log).toEqual(["a:start", "b:start", "b:end"]);
    release();
    await a;

    const common: string[] = [];
    let releaseCommon!: () => void;
    const commonGate = new Promise<void>((resolve) => {
      releaseCommon = resolve;
    });
    const fetchA = locks.withCommon("/cache/.git", async () => {
      common.push("fetch-a:start");
      await commonGate;
      common.push("fetch-a:end");
    });
    const fetchB = locks.withCommon("/cache/.git", async () => {
      common.push("fetch-b");
    });
    await tick();
    expect(common).toEqual(["fetch-a:start"]);
    releaseCommon();
    await Promise.all([fetchA, fetchB]);
    expect(common).toEqual(["fetch-a:start", "fetch-a:end", "fetch-b"]);
  });

  test("separate repositories never block each other", async () => {
    const locks = createReviewGitLocks();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slow = locks.withBoth("/one/.git", "/one/wt", () => gate);
    let ran = false;
    await locks.withBoth("/two/.git", "/two/wt", async () => {
      ran = true;
    });
    expect(ran).toBe(true);
    release();
    await slow;
  });

  test("withBoth takes the common lock first, then the worktree lock, and releases both", async () => {
    const locks = createReviewGitLocks();
    await locks.withBoth("/cache/.git", "/cache/wt", async () => {
      expect(locks.isCommonHeld("/cache/.git")).toBe(true);
      expect(locks.isWorktreeHeld("/cache/wt")).toBe(true);
    });
    expect(locks.isCommonHeld("/cache/.git")).toBe(false);
    expect(locks.isWorktreeHeld("/cache/wt")).toBe(false);
  });

  test("a worktree waiting on the common lock does not hold its own worktree lock yet", async () => {
    const locks = createReviewGitLocks();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const holder = locks.withCommon("/cache/.git", () => gate);
    const waiting = locks.withBoth("/cache/.git", "/cache/wt", async () => {});
    await tick();
    // Order is common → worktree: until the common lock is won, the worktree is free for others.
    expect(locks.isWorktreeHeld("/cache/wt")).toBe(false);
    release();
    await Promise.all([holder, waiting]);
  });

  test("locks are released when the work throws", async () => {
    const locks = createReviewGitLocks();
    await expect(
      locks.withBoth("/cache/.git", "/cache/wt", async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(locks.isCommonHeld("/cache/.git")).toBe(false);
    expect(locks.isWorktreeHeld("/cache/wt")).toBe(false);
    await expect(locks.withWorktree("/cache/wt", async () => "ok")).resolves.toBe("ok");
  });

  test("a locked action that calls another locked action on the same checkout does not wait on itself", async () => {
    const locks = createReviewGitLocks();
    const result = await locks.withWorktree("/cache/wt", () => locks.withWorktree("/cache/wt", async () => "nested"));
    expect(result).toBe("nested");
  });

  test("keys are canonical: trailing separators and (on Windows/macOS) case do not make a second lock", () => {
    expect(canonicalLockKey("/cache/wt/")).toBe(canonicalLockKey("/cache/wt"));
    if (process.platform === "win32" || process.platform === "darwin") {
      expect(canonicalLockKey("/Cache/WT")).toBe(canonicalLockKey("/cache/wt"));
    } else {
      expect(canonicalLockKey("/Cache/WT")).not.toBe(canonicalLockKey("/cache/wt"));
    }
  });
});

describe("commonDirOf", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true, maxRetries: 5 })));
  });

  const git = (cwd: string, args: string[]) =>
    execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@e", ...args], { cwd, stdio: "ignore" });

  test("a linked worktree and its main checkout share one common dir", async () => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "strideterm-common-dir-")));
    dirs.push(root);
    const main = path.join(root, "main");
    const linked = path.join(root, "linked");
    git(root, ["init", "-q", "-b", "main", main]);
    await writeFile(path.join(main, "a.txt"), "a");
    git(main, ["add", "."]);
    git(main, ["commit", "-q", "-m", "A"]);
    git(main, ["worktree", "add", "-q", "-b", "feature", linked]);

    const mainCommon = await commonDirOf(main);
    const linkedCommon = await commonDirOf(linked);

    expect(canonicalLockKey(linkedCommon)).toBe(canonicalLockKey(mainCommon));
    expect(canonicalLockKey(mainCommon)).toBe(canonicalLockKey(path.join(main, ".git")));
  });

  test("a directory that is not a repository falls back to its own .git path", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "strideterm-common-dir-"));
    dirs.push(root);
    expect(await commonDirOf(root)).toBe(path.join(root, ".git"));
  });
});
