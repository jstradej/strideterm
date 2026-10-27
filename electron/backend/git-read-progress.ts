import { AsyncLocalStorage } from "node:async_hooks";

interface GitReadProgress {
  queued: number;
  lastProgressAt: number;
  parent?: GitReadProgress;
}

const gitReadProgress = new AsyncLocalStorage<GitReadProgress>();
export const GIT_READ_QUEUE_LIMIT_MS = 300_000;
export const GIT_READ_BUSY_MESSAGE = "Git is busy with other repositories and this refresh did not get its turn.";

/**
 * Bounds a read by how long it goes without progress, not by its age: a read whose commands
 * are waiting their turn behind other checkouts is busy, not unavailable.
 */
export function timedGitRead<T>(task: () => Promise<T>, message: string, idleMs = 30_000): Promise<T> {
  const startedAt = Date.now();
  const progress: GitReadProgress = { queued: 0, lastProgressAt: startedAt, parent: gitReadProgress.getStore() };
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    gitReadProgress.run(progress, task),
    new Promise<never>((_resolve, reject) => {
      const check = () => {
        const now = Date.now();
        const idle = now - progress.lastProgressAt;
        if (progress.queued > 0 && now - startedAt >= GIT_READ_QUEUE_LIMIT_MS)
          return reject(new Error(GIT_READ_BUSY_MESSAGE));
        if (progress.queued === 0 && idle >= idleMs) return reject(new Error(message));
        timer = setTimeout(check, Math.max(1000, idleMs - idle));
        timer.unref();
      };
      timer = setTimeout(check, idleMs);
      timer.unref();
    }),
  ]).finally(() => clearTimeout(timer));
}

/** Called by each Git command of a timed read: +1 when queued, -1 when it starts, 0 when it ends. */
export function reportGitReadProgress(queuedChange: number): void {
  for (let progress = gitReadProgress.getStore(); progress; progress = progress.parent) {
    progress.queued += queuedChange;
    progress.lastProgressAt = Date.now();
  }
}
