import { AsyncLocalStorage } from "node:async_hooks";
import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";

/**
 * Two lock levels for review Git work.
 *
 * - common: the canonical repository common dir (the cache repo a managed
 *   worktree hangs off). Fetches, shared refs and the worktree registry
 *   serialize here.
 * - worktree: one checkout's HEAD, index and working tree.
 *
 * When both are needed the order is always common → worktree. Separate
 * repositories and separate worktrees of one repository never block each
 * other except through the common level.
 */
export function canonicalLockKey(dir: string): string {
  const resolved = path.resolve(String(dir || ""));
  const stripped = resolved.replace(/[\\/]+$/u, "");
  const slashed = stripped.replace(/\\/gu, "/");
  return process.platform === "win32" || process.platform === "darwin" ? slashed.toLowerCase() : slashed;
}

/**
 * The common dir of the repository a checkout belongs to, read from the
 * filesystem (no Git process): `<cwd>/.git` for a normal clone, or — for a
 * linked worktree, where `.git` is a file — the `commondir` of its gitdir.
 * It is the lock key shared by every worktree of one repository.
 */
export async function commonDirOf(cwd: string): Promise<string> {
  const dir = await rawCommonDirOf(cwd);
  // Git writes a linked worktree's gitdir pointer with symlinks resolved, so
  // the main checkout is resolved too, or the two would get different keys.
  return realpath(dir).catch(() => dir);
}

async function rawCommonDirOf(cwd: string): Promise<string> {
  const dotGit = path.join(cwd, ".git");
  try {
    if ((await stat(dotGit)).isDirectory()) return dotGit;
    const pointer = /^gitdir:\s*(.+)$/mu.exec(await readFile(dotGit, "utf8"))?.[1]?.trim();
    if (!pointer) return dotGit;
    const gitDir = path.resolve(cwd, pointer);
    const common = await readFile(path.join(gitDir, "commondir"), "utf8").then(
      (text) => text.trim(),
      () => "",
    );
    return common ? path.resolve(gitDir, common) : gitDir;
  } catch {
    return dotGit;
  }
}

class KeyedMutex {
  private tails = new Map<string, Promise<void>>();
  private held = new Set<string>();
  // Keys this async call chain already holds: a Git action that calls another
  // locked Git action on the same checkout (a pull that fetches first) must
  // not wait on itself.
  private holders = new AsyncLocalStorage<ReadonlySet<string>>();

  constructor(
    private readonly level: "common" | "worktree",
    private readonly notify: (event: ReviewGitLockStateChange) => void,
  ) {}

  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const mine = this.holders.getStore();
    if (mine?.has(key)) return fn();
    const previous = this.tails.get(key) || Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => gate);
    this.tails.set(key, tail);
    await previous;
    this.held.add(key);
    this.notify({ level: this.level, key, held: true });
    try {
      return await this.holders.run(new Set([...(mine ?? []), key]), fn);
    } finally {
      this.held.delete(key);
      this.notify({ level: this.level, key, held: false });
      release();
      if (this.tails.get(key) === tail) this.tails.delete(key);
    }
  }

  isHeld(key: string): boolean {
    return this.held.has(key);
  }
}

export interface ReviewGitLockStateChange {
  level: "common" | "worktree";
  key: string;
  held: boolean;
}

export interface ReviewGitLocks {
  withCommon<T>(commonDir: string, fn: () => Promise<T>): Promise<T>;
  withWorktree<T>(worktreeDir: string, fn: () => Promise<T>): Promise<T>;
  /** Acquire common, then worktree; release both when `fn` settles. */
  withBoth<T>(commonDir: string, worktreeDir: string, fn: () => Promise<T>): Promise<T>;
  isCommonHeld(commonDir: string): boolean;
  isWorktreeHeld(worktreeDir: string): boolean;
  subscribe(listener: (event: ReviewGitLockStateChange) => void): () => void;
}

export function createReviewGitLocks(): ReviewGitLocks {
  const listeners = new Set<(event: ReviewGitLockStateChange) => void>();
  const notify = (event: ReviewGitLockStateChange) => {
    for (const listener of listeners) {
      try {
        listener(event);
      } catch {
        process.emitWarning("Review Git lock state listener failed");
      }
    }
  };
  const common = new KeyedMutex("common", notify);
  const worktree = new KeyedMutex("worktree", notify);
  return {
    withCommon: (dir, fn) => common.run(canonicalLockKey(dir), fn),
    withWorktree: (dir, fn) => worktree.run(canonicalLockKey(dir), fn),
    withBoth: (commonDir, worktreeDir, fn) =>
      common.run(canonicalLockKey(commonDir), () => worktree.run(canonicalLockKey(worktreeDir), fn)),
    isCommonHeld: (dir) => common.isHeld(canonicalLockKey(dir)),
    isWorktreeHeld: (dir) => worktree.isHeld(canonicalLockKey(dir)),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/**
 * One lock registry per process, shared by the provider managers, the runtime
 * and the MCP broker: a UI refresh and an agent's push on the same checkout
 * must queue behind each other, not race.
 */
export const sharedReviewGitLocks: ReviewGitLocks = createReviewGitLocks();
