/**
 * A per-key FIFO queue for work that must never overlap with itself.
 *
 * Extracted from `runtime-task-handlers.ts` for one reason: the invariants
 * below are the whole point of the V6 recovery serialization, and they are
 * only testable in isolation. In particular "the map is empty again once
 * everything has settled" cannot be observed through the runtime's public
 * surface without adding a diagnostic endpoint to it (V6 review, §"P1 —
 * recovery `stale` řeší jen sekvenční, ne skutečný multi-window race",
 * oprava 8).
 *
 * The invariants:
 *
 *   - two runs for the SAME key never overlap, and they run in the order they
 *     were requested;
 *   - two runs for DIFFERENT keys never wait on each other;
 *   - a run that throws releases the key and does not wedge the queue behind
 *     it — the rejection still reaches its own caller;
 *   - a key is dropped as soon as nothing is queued behind it, so the map does
 *     not grow with every workspace ever recovered.
 *
 * Dependency-free on purpose (no logger, no store), so it can be unit tested
 * directly and reasoned about as plain promise plumbing.
 */
export interface RecoveryQueue {
  /** Run `fn` once every earlier run for `key` has settled. */
  run<T>(key: string, fn: () => Promise<T>): Promise<T>;
  /** How many keys currently have work queued. Zero when everything settled. */
  readonly size: number;
}

export function createRecoveryQueue(): RecoveryQueue {
  const tails = new Map<string, Promise<void>>();

  return {
    run<T>(key: string, fn: () => Promise<T>): Promise<T> {
      const previous = tails.get(key) || Promise.resolve();
      // `fn` runs whether the previous holder resolved or rejected: one failed
      // decision must never block the retry queued behind it.
      const run = previous.then(fn, fn);
      // What the NEXT caller waits on. It swallows this run's outcome for the
      // same reason, and doubles as the `finally` that releases the key.
      const tail = run.then(
        () => {},
        () => {},
      );
      tails.set(key, tail);
      void tail.then(() => {
        // Only the last waiter clears the entry — a queue still being consumed
        // must keep its head.
        if (tails.get(key) === tail) tails.delete(key);
      });
      return run;
    },
    get size(): number {
      return tails.size;
    },
  };
}
