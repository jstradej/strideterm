import { EventEmitter } from "node:events";
import type { FSWatcher, watch } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GitCheckoutWatch, type GitWatchTarget } from "./git-checkout-watch.js";

function fixture(classifyIgnored?: (target: GitWatchTarget, directories: string[]) => Promise<string[]>) {
  const watchers = new Map<
    string,
    { watcher: FSWatcher; emit: (filename: string | null, event?: "change" | "rename") => void }
  >();
  const watchImpl = vi.fn(
    (directory: string, _options: unknown, listener: (_event: string, filename: string | null) => void) => {
      const emitter = new EventEmitter();
      const watcher = Object.assign(emitter, { close: vi.fn() }) as unknown as FSWatcher;
      watchers.set(directory, { watcher, emit: (filename, event = "change") => listener(event, filename) });
      return watcher;
    },
  );
  const onInvalidate = vi.fn();
  const onRefresh = vi.fn(async (_key: string) => {});
  const service = new GitCheckoutWatch({
    watchImpl: watchImpl as unknown as typeof watch,
    onInvalidate,
    onRefresh,
    classifyIgnored,
    random: () => 0.5,
  });
  return { service, watchers, watchImpl, onInvalidate, onRefresh };
}

const first = { key: "one", root: "/repo", gitDir: "/repo/.git", commonDir: "/repo/.git" };
const second = { key: "two", root: "/worktree", gitDir: "/repo/.git/worktrees/two", commonDir: "/repo/.git" };

const tempDirs: string[] = [];
let mtimeTick = 0;

async function tempCheckout(): Promise<GitWatchTarget> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "git-watch-"));
  tempDirs.push(root);
  await fs.mkdir(path.join(root, ".git", "info"), { recursive: true });
  const gitDir = path.join(root, ".git");
  return { key: "one", root, gitDir, commonDir: gitDir };
}

async function rewrite(file: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content);
  const when = new Date(Date.now() + ++mtimeTick * 10_000);
  await fs.utimes(file, when, when);
}

function stateOf(service: GitCheckoutWatch, key: string) {
  return (
    service as unknown as {
      targets: Map<
        string,
        {
          ignoreFileStamps: Map<string, string>;
          ignoreFileChecks: Map<string, Promise<boolean>>;
          ignoredDirectories: Map<string, boolean>;
        }
      >;
    }
  ).targets.get(key)!;
}

type WatchState = ReturnType<typeof stateOf>;

const primed = (state: WatchState) => vi.waitFor(() => expect(state.ignoreFileStamps.size).toBe(2));
const checked = (state: WatchState) => vi.waitFor(() => expect(state.ignoreFileChecks.size).toBe(0));

describe("GitCheckoutWatch", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(async () => {
    vi.useRealTimers();
    await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
  });

  it("shares metadata watches, drops departed targets and stops all work without consumers", async () => {
    const { service, watchers, onRefresh } = fixture();
    service.setTargets([first, second]);
    expect(service.getStats()).toMatchObject({ targets: 2, watchers: 4 });
    watchers.get(first.commonDir)!.emit("refs/heads/main");
    await vi.advanceTimersByTimeAsync(250);
    expect(onRefresh.mock.calls.map(([key]) => key).sort()).toEqual(["one", "two"]);
    service.setTargets([second]);
    expect(watchers.get(first.root)!.watcher.close).toHaveBeenCalledOnce();
    expect(watchers.get(first.commonDir)!.watcher.close).not.toHaveBeenCalled();
    service.dispose();
    expect(service.getStats()).toEqual({ targets: 0, watchers: 0, refreshing: 0 });
    await vi.advanceTimersByTimeAsync(600_000);
    expect(onRefresh).toHaveBeenCalledTimes(2);
  });

  it("coalesces storms and enforces maximum debounce delay while invalidating before a read completes", async () => {
    const { service, watchers, onRefresh, onInvalidate } = fixture();
    service.setTargets([first]);
    for (let i = 0; i < 22; i++) {
      watchers.get(first.root)!.emit(`file${i}.txt`);
      await vi.advanceTimersByTimeAsync(100);
    }
    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect(onInvalidate).toHaveBeenCalledWith("one", "status", ["file0.txt"], "watch");
    await vi.advanceTimersByTimeAsync(250);
    expect(onRefresh).toHaveBeenCalledTimes(2);
    service.dispose();
  });

  it("separates index, shared refs and unknown metadata and ignores optional lock traffic", async () => {
    const { service, watchers, onInvalidate } = fixture();
    service.setTargets([first]);
    const metadata = watchers.get(first.gitDir)!;
    metadata.emit("index.lock");
    metadata.emit("refs/heads/main.lock");
    expect(onInvalidate).not.toHaveBeenCalled();
    metadata.emit("index");
    metadata.emit("packed-refs");
    metadata.emit("HEAD");
    metadata.emit(null);
    expect(onInvalidate.mock.calls.map((call) => call[1])).toEqual(["status", "refs", "all", "all"]);
    service.dispose();
  });

  it("ignores metadata paths that cannot change the repository state and keeps the ones that can", () => {
    const { service, watchers, onInvalidate } = fixture();
    service.setTargets([first]);
    const metadata = watchers.get(first.gitDir)!;
    for (const inert of [
      "objects",
      "objects/ab/cdef0123",
      "objects/pack/pack-x.idx",
      "objects/info/packs",
      "logs",
      "logs/HEAD",
      "logs/refs/heads/main",
      "lfs/objects/aa/bb",
      "hooks/pre-commit",
      "info/refs",
      "COMMIT_EDITMSG",
      "description",
    ]) {
      metadata.emit(inert);
    }
    expect(onInvalidate).not.toHaveBeenCalled();

    for (const relevant of ["refs/heads/main", "packed-refs", "HEAD", "config"]) {
      metadata.emit(relevant);
    }
    expect(onInvalidate.mock.calls.map((call) => [call[2][0], call[1]])).toEqual([
      ["refs/heads/main", "refs"],
      ["packed-refs", "refs"],
      ["HEAD", "all"],
      ["config", "all"],
    ]);
    service.dispose();
  });

  it("applies the same ignore list to a linked worktree's own private directory", () => {
    const { service, watchers, onInvalidate } = fixture();
    service.setTargets([first, second]);
    const common = watchers.get(first.commonDir)!;
    common.emit("worktrees/two/logs/HEAD");
    common.emit("worktrees/two/COMMIT_EDITMSG");
    common.emit("worktrees/two/objects/ab/cdef0123");
    watchers.get(second.gitDir)!.emit("logs/HEAD");
    expect(onInvalidate).not.toHaveBeenCalled();

    common.emit("worktrees/two/index");
    common.emit("worktrees/two/HEAD");
    expect(onInvalidate.mock.calls.map((call) => [call[0], call[1], call[2][0]])).toEqual([
      ["two", "status", "worktrees/two/index"],
      ["two", "all", "worktrees/two/HEAD"],
    ]);
    service.dispose();
  });

  it("ignores a change of the .git directory itself but not its creation or a worktree's .git file", () => {
    const { service, watchers, onInvalidate } = fixture();
    service.setTargets([first, second]);
    watchers.get(first.root)!.emit(".git");
    expect(onInvalidate).not.toHaveBeenCalled();
    watchers.get(first.root)!.emit(".git", "rename");
    watchers.get(second.root)!.emit(".git");
    expect(onInvalidate.mock.calls.map((call) => [call[0], call[1]])).toEqual([
      ["one", "all"],
      ["two", "all"],
    ]);
    service.dispose();
  });

  it("never invalidates for writes inside an ignored directory", async () => {
    const classifyIgnored = vi.fn(async (_target: GitWatchTarget, directories: string[]) =>
      directories.filter((directory) => directory === "dist" || directory === ".nested"),
    );
    const { service, watchers, onInvalidate, onRefresh } = fixture(classifyIgnored);
    service.setTargets([first]);
    const root = watchers.get(first.root)!;
    root.emit("dist/assets/app.js");
    expect(classifyIgnored).toHaveBeenCalledWith(first, ["dist", "dist/assets"]);
    expect(onInvalidate).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(250);
    for (let index = 0; index < 20; index++) root.emit(`dist/assets/chunk-${index}.js`);
    root.emit(".nested/tree/work/dist/x.js");
    root.emit(".nested/tree/work/src/y.ts");
    await vi.advanceTimersByTimeAsync(250);
    root.emit(".nested/tree/work/src/z.ts");
    root.emit("dist/late.js");
    await vi.advanceTimersByTimeAsync(2500);
    expect(onInvalidate).not.toHaveBeenCalled();
    expect(onRefresh).not.toHaveBeenCalled();

    root.emit("src/main.ts");
    await vi.advanceTimersByTimeAsync(0);
    expect(onInvalidate).toHaveBeenCalledWith("one", "status", ["src/main.ts"], "watch");
    onInvalidate.mockClear();
    root.emit("src/again.ts");
    expect(onInvalidate).toHaveBeenCalledWith("one", "status", ["src/again.ts"], "watch");
    service.dispose();
  });

  it("holds a write under an unclassified directory until Git says the directory is not ignored", async () => {
    let release!: (ignored: string[]) => void;
    const classifyIgnored = vi.fn(
      () =>
        new Promise<string[]>((resolve) => {
          release = resolve;
        }),
    );
    const { service, watchers, onInvalidate, onRefresh } = fixture(classifyIgnored);
    service.setTargets([first]);
    const root = watchers.get(first.root)!;
    root.emit("src/a.ts");
    root.emit("src/deep/b.ts");
    await vi.advanceTimersByTimeAsync(5000);
    expect(onInvalidate).not.toHaveBeenCalled();
    expect(onRefresh).not.toHaveBeenCalled();
    release([]);
    await vi.advanceTimersByTimeAsync(0);
    expect(onInvalidate.mock.calls.map((call) => [call[1], call[2][0], call[3]])).toEqual([
      ["status", "src/a.ts", "watch"],
      ["status", "src/deep/b.ts", "watch"],
    ]);
    await vi.advanceTimersByTimeAsync(250);
    expect(onRefresh).toHaveBeenCalledTimes(1);
    service.dispose();
  });

  it("drops the writes it held when Git reports the directory ignored", async () => {
    let release!: (ignored: string[]) => void;
    const classifyIgnored = vi.fn(
      () =>
        new Promise<string[]>((resolve) => {
          release = resolve;
        }),
    );
    const { service, watchers, onInvalidate, onRefresh } = fixture(classifyIgnored);
    service.setTargets([first]);
    watchers.get(first.root)!.emit("build/out/a.js");
    release(["build"]);
    await vi.advanceTimersByTimeAsync(5000);
    expect(onInvalidate).not.toHaveBeenCalled();
    expect(onRefresh).not.toHaveBeenCalled();
    service.dispose();
  });

  it("releases held writes as changes when the ignore rules change meanwhile", async () => {
    vi.useRealTimers();
    const target = await tempCheckout();
    const gitignore = path.join(target.root, ".gitignore");
    await rewrite(gitignore, "dist\n");
    const classifyIgnored = vi.fn(() => new Promise<string[]>(() => {}));
    const { service, watchers, onInvalidate } = fixture(classifyIgnored);
    service.setTargets([target]);
    const state = stateOf(service, target.key);
    await primed(state);
    const root = watchers.get(target.root)!;
    root.emit("dist/a.js");
    expect(onInvalidate).not.toHaveBeenCalled();
    await rewrite(gitignore, "build\n");
    root.emit(".gitignore");
    await checked(state);
    expect(onInvalidate.mock.calls.map((call) => call[2][0])).toEqual(["dist/a.js", ".gitignore"]);
    service.dispose();
  });

  it("acts on info/exclude only when its content changed, not when Git merely reads it", async () => {
    vi.useRealTimers();
    const target = await tempCheckout();
    const exclude = path.join(target.gitDir, "info", "exclude");
    await rewrite(exclude, "dist\n");
    const { service, watchers, onInvalidate } = fixture();
    service.setTargets([target]);
    const state = stateOf(service, target.key);
    await primed(state);
    state.ignoredDirectories.set("dist", true);
    const metadata = watchers.get(target.gitDir)!;

    metadata.emit("info/exclude");
    metadata.emit("info/exclude");
    expect(state.ignoreFileChecks.size).toBe(1);
    await checked(state);
    expect(onInvalidate).not.toHaveBeenCalled();
    expect(state.ignoredDirectories.size).toBe(1);

    await rewrite(exclude, "dist\nbuild\n");
    metadata.emit("info/exclude");
    await checked(state);
    expect(onInvalidate).toHaveBeenCalledOnce();
    expect(onInvalidate).toHaveBeenCalledWith("one", "status", ["info/exclude"], "watch");
    expect(state.ignoredDirectories.size).toBe(0);

    onInvalidate.mockClear();
    metadata.emit("info/exclude");
    await checked(state);
    expect(onInvalidate).not.toHaveBeenCalled();
    service.dispose();
  });

  it("acts on the root .gitignore only when its content changed", async () => {
    vi.useRealTimers();
    const target = await tempCheckout();
    const gitignore = path.join(target.root, ".gitignore");
    await rewrite(gitignore, "dist\n");
    const { service, watchers, onInvalidate } = fixture();
    service.setTargets([target]);
    const state = stateOf(service, target.key);
    await primed(state);
    state.ignoredDirectories.set("dist", true);
    const root = watchers.get(target.root)!;

    root.emit(".gitignore");
    await checked(state);
    expect(onInvalidate).not.toHaveBeenCalled();
    expect(state.ignoredDirectories.size).toBe(1);

    await rewrite(gitignore, "dist\nbuild\n");
    root.emit(".gitignore");
    await checked(state);
    expect(onInvalidate).toHaveBeenCalledOnce();
    expect(onInvalidate).toHaveBeenCalledWith("one", "status", [".gitignore"], "watch");
    expect(state.ignoredDirectories.size).toBe(0);
    service.dispose();
  });

  it("treats the first event of a nested .gitignore as a change and later reads as nothing", async () => {
    vi.useRealTimers();
    const target = await tempCheckout();
    await rewrite(path.join(target.root, "sub", ".gitignore"), "out\n");
    const { service, watchers, onInvalidate } = fixture();
    service.setTargets([target]);
    const state = stateOf(service, target.key);
    await primed(state);
    const root = watchers.get(target.root)!;

    root.emit("sub/.gitignore");
    await checked(state);
    expect(onInvalidate).toHaveBeenCalledOnce();
    expect(onInvalidate).toHaveBeenCalledWith("one", "status", ["sub/.gitignore"], "watch");

    root.emit("sub/.gitignore");
    await checked(state);
    expect(onInvalidate).toHaveBeenCalledOnce();
    service.dispose();
  });

  it("invalidates when the ignore file can no longer be read", async () => {
    vi.useRealTimers();
    const target = await tempCheckout();
    const gitignore = path.join(target.root, ".gitignore");
    await rewrite(gitignore, "dist\n");
    const { service, watchers, onInvalidate } = fixture();
    service.setTargets([target]);
    const state = stateOf(service, target.key);
    await primed(state);

    await fs.rm(gitignore);
    watchers.get(target.root)!.emit(".gitignore", "rename");
    await checked(state);
    expect(onInvalidate).toHaveBeenCalledWith("one", "status", [".gitignore"], "watch");
    service.dispose();
  });

  it("keeps one empty change for a directory that overflows its held paths and falls back past 64 directories", async () => {
    let release!: (ignored: string[]) => void;
    const classifyIgnored = vi.fn(
      () =>
        new Promise<string[]>((resolve) => {
          release = resolve;
        }),
    );
    const { service, watchers, onInvalidate } = fixture(classifyIgnored);
    service.setTargets([first]);
    const root = watchers.get(first.root)!;
    for (let index = 0; index < 300; index++) root.emit(`busy/file-${index}.ts`);
    for (let index = 0; index < 70; index++) root.emit(`dir-${index}/file.ts`);
    expect(onInvalidate).toHaveBeenCalledTimes(70 - 63);
    onInvalidate.mockClear();
    release([]);
    await vi.advanceTimersByTimeAsync(0);
    expect(onInvalidate).toHaveBeenCalledWith("one", "status", [], "watch");
    expect(onInvalidate.mock.calls.filter((call) => call[2].length === 0)).toHaveLength(1);
    service.dispose();
  });

  it("keeps what Git ignored across polls and asks again after ten minutes", async () => {
    const classifyIgnored = vi.fn(async (_target: GitWatchTarget, directories: string[]) =>
      directories.filter((directory) => directory === "dist"),
    );
    const { service, watchers, onInvalidate } = fixture(classifyIgnored);
    service.setTargets([first]);
    const root = watchers.get(first.root)!;
    root.emit("dist/a.js");
    await vi.advanceTimersByTimeAsync(0);
    expect(classifyIgnored).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(240_000);
    expect(onInvalidate.mock.calls.some((call) => call[3] === "poll")).toBe(true);
    onInvalidate.mockClear();
    root.emit("dist/b.js");
    expect(classifyIgnored).toHaveBeenCalledTimes(1);
    expect(onInvalidate).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(600_000);
    onInvalidate.mockClear();
    root.emit("dist/c.js");
    expect(classifyIgnored).toHaveBeenCalledTimes(2);
    expect(onInvalidate).not.toHaveBeenCalled();
    service.dispose();
  });

  it("runs one shallow ignore check per checkout at a time while a checkout is being written", async () => {
    const releases: Array<() => void> = [];
    const classifyIgnored = vi.fn(
      (_target: GitWatchTarget, _directories: string[]) =>
        new Promise<string[]>((resolve) => releases.push(() => resolve([]))),
    );
    const { service, watchers } = fixture(classifyIgnored);
    service.setTargets([first]);
    for (let index = 0; index < 50; index++)
      watchers.get(first.root)!.emit(`src/module-${index}/deep/er/still/file.ts`);
    expect(classifyIgnored).toHaveBeenCalledOnce();
    expect(classifyIgnored.mock.calls[0][1]).toEqual(["src", "src/module-0", "src/module-0/deep"]);
    releases.shift()!();
    await vi.advanceTimersByTimeAsync(0);
    expect(classifyIgnored).toHaveBeenCalledTimes(2);
    expect(classifyIgnored.mock.calls[1][1]).toHaveLength(64);
    releases.shift()!();
    await vi.advanceTimersByTimeAsync(0);
    expect(classifyIgnored.mock.calls[2][1]).toHaveLength(49 * 2 - 64);
    releases.shift()!();
    await vi.advanceTimersByTimeAsync(0);
    watchers.get(first.root)!.emit("src/module-7/deep/other.ts");
    expect(classifyIgnored).toHaveBeenCalledTimes(3);
    service.dispose();
  });

  it("treats a failed ignore check as not ignored instead of retrying it on every event", async () => {
    const classifyIgnored = vi.fn(async () => {
      throw new Error("git check-ignore failed");
    });
    const { service, watchers, onInvalidate } = fixture(classifyIgnored);
    service.setTargets([first]);
    watchers.get(first.root)!.emit("build/a.js");
    await vi.advanceTimersByTimeAsync(0);
    watchers.get(first.root)!.emit("build/b.js");
    expect(classifyIgnored).toHaveBeenCalledOnce();
    expect(onInvalidate).toHaveBeenCalledTimes(2);
    service.dispose();
  });

  it("routes a private worktree index only to that checkout", () => {
    const { service, watchers, onInvalidate } = fixture();
    service.setTargets([first, second]);
    watchers.get(first.commonDir)!.emit("index");
    expect(onInvalidate.mock.calls.map((call) => call[0])).toEqual(["one"]);
    onInvalidate.mockClear();
    watchers.get(first.commonDir)!.emit("worktrees/two/index");
    expect(onInvalidate.mock.calls.map((call) => call[0])).toEqual(["two"]);
    expect(onInvalidate.mock.calls[0][1]).toBe("status");
    service.dispose();
  });

  it("retains one followup when an event arrives during a refresh", async () => {
    const { service, watchers, onRefresh } = fixture();
    let finish!: () => void;
    onRefresh.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    service.setTargets([first]);
    watchers.get(first.root)!.emit("first.txt");
    await vi.advanceTimersByTimeAsync(250);
    watchers.get(first.root)!.emit("second.txt");
    await vi.advanceTimersByTimeAsync(500);
    expect(onRefresh).toHaveBeenCalledTimes(1);
    finish();
    await vi.advanceTimersByTimeAsync(250);
    expect(onRefresh).toHaveBeenCalledTimes(2);
    service.dispose();
  });

  it("recovers a lost watcher through polling, limits retry frequency and backs off errors", async () => {
    const { service, watchers, watchImpl, onRefresh, onInvalidate } = fixture();
    service.setTargets([first]);
    watchers.get(first.root)!.watcher.emit("error", new Error("watch resource exhausted"));
    await vi.advanceTimersByTimeAsync(250);
    expect(onInvalidate).toHaveBeenCalledWith("one", "all", [], "recovery");
    const attempts = watchImpl.mock.calls.length;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(watchImpl).toHaveBeenCalledTimes(attempts);
    onRefresh.mockRejectedValueOnce(new Error("disk unavailable"));
    await vi.advanceTimersByTimeAsync(51_000);
    expect(onRefresh).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(onRefresh).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(61_000);
    expect(onRefresh).toHaveBeenCalledTimes(3);
    service.dispose();
  });

  it("keeps event storms within the error backoff while invalidating promptly", async () => {
    const { service, watchers, onRefresh, onInvalidate } = fixture();
    onRefresh.mockRejectedValue(new Error("network disk unavailable"));
    service.setTargets([first]);
    watchers.get(first.root)!.emit("first.txt");
    await vi.advanceTimersByTimeAsync(250);
    for (let index = 0; index < 30; index++) {
      watchers.get(first.root)!.emit(`changed-${index}.txt`);
      await vi.advanceTimersByTimeAsync(100);
    }
    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect(onInvalidate).toHaveBeenCalledTimes(31);
    service.dispose();
  });
});
