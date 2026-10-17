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

class KeyedMutex {
  private tails = new Map<string, Promise<void>>();
  private held = new Set<string>();

  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) || Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => gate);
    this.tails.set(key, tail);
    await previous;
    this.held.add(key);
    try {
      return await fn();
    } finally {
      this.held.delete(key);
      release();
      if (this.tails.get(key) === tail) this.tails.delete(key);
    }
  }

  isHeld(key: string): boolean {
    return this.held.has(key);
  }
}

export interface ReviewGitLocks {
  withCommon<T>(commonDir: string, fn: () => Promise<T>): Promise<T>;
  withWorktree<T>(worktreeDir: string, fn: () => Promise<T>): Promise<T>;
  /** Acquire common, then worktree; release both when `fn` settles. */
  withBoth<T>(commonDir: string, worktreeDir: string, fn: () => Promise<T>): Promise<T>;
  isCommonHeld(commonDir: string): boolean;
  isWorktreeHeld(worktreeDir: string): boolean;
}

export function createReviewGitLocks(): ReviewGitLocks {
  const common = new KeyedMutex();
  const worktree = new KeyedMutex();
  return {
    withCommon: (dir, fn) => common.run(canonicalLockKey(dir), fn),
    withWorktree: (dir, fn) => worktree.run(canonicalLockKey(dir), fn),
    withBoth: (commonDir, worktreeDir, fn) =>
      common.run(canonicalLockKey(commonDir), () => worktree.run(canonicalLockKey(worktreeDir), fn)),
    isCommonHeld: (dir) => common.isHeld(canonicalLockKey(dir)),
    isWorktreeHeld: (dir) => worktree.isHeld(canonicalLockKey(dir)),
  };
}

/**
 * One lock registry per process, shared by the provider managers, the runtime
 * and the MCP broker: a UI refresh and an agent's push on the same checkout
 * must queue behind each other, not race.
 */
export const sharedReviewGitLocks: ReviewGitLocks = createReviewGitLocks();
