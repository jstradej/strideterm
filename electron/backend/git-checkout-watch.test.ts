import { EventEmitter } from "node:events";
import type { FSWatcher, watch } from "node:fs";
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

describe("GitCheckoutWatch", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

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

  it("stops refreshing for writes inside an ignored directory once Git has classified it", async () => {
    const classifyIgnored = vi.fn(async (_target: GitWatchTarget, directories: string[]) =>
      directories.filter((directory) => directory === "dist" || directory === ".nested"),
    );
    const { service, watchers, onInvalidate, onRefresh } = fixture(classifyIgnored);
    service.setTargets([first]);
    const root = watchers.get(first.root)!;
    root.emit("dist/assets/app.js");
    expect(classifyIgnored).toHaveBeenCalledWith(first, ["dist", "dist/assets"]);
    await vi.advanceTimersByTimeAsync(250);
    expect(onRefresh).toHaveBeenCalledTimes(1);
    onInvalidate.mockClear();
    for (let index = 0; index < 20; index++) root.emit(`dist/assets/chunk-${index}.js`);
    root.emit(".nested/tree/work/dist/x.js");
    root.emit(".nested/tree/work/src/y.ts");
    await vi.advanceTimersByTimeAsync(250);
    root.emit(".nested/tree/work/src/z.ts");
    root.emit("dist/late.js");
    await vi.advanceTimersByTimeAsync(2500);
    expect(onRefresh).toHaveBeenCalledTimes(2);
    expect(onInvalidate.mock.calls.map((call) => call[2][0])).toEqual([
      ".nested/tree/work/dist/x.js",
      ".nested/tree/work/src/y.ts",
    ]);

    onInvalidate.mockClear();
    root.emit("src/main.ts");
    expect(onInvalidate).toHaveBeenCalledWith("one", "status", ["src/main.ts"], "watch");
    root.emit(".gitignore");
    root.emit("dist/after-ignore-change.js");
    expect(onInvalidate.mock.calls.map((call) => call[2][0])).toEqual([
      "src/main.ts",
      ".gitignore",
      "dist/after-ignore-change.js",
    ]);
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
