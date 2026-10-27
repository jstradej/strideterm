import { AsyncResource } from "node:async_hooks";

export type GitReadPriority = "foreground" | "background";

interface PendingProcess {
  priority: GitReadPriority;
  group: string;
  queuedAt: number;
  start: () => void;
  reject: (error: Error) => void;
}

export class GitProcessScheduler {
  private active = 0;
  private background = 0;
  private queue: PendingProcess[] = [];
  private activeByGroup = new Map<string, number>();
  private stopped = false;
  private peak = 0;
  private commands = 0;
  private longestWaitMs = 0;

  constructor(
    private readonly limit = 4,
    private readonly now: () => number = Date.now,
  ) {
    if (!Number.isInteger(limit) || limit < 2) throw new Error("Git process limit must be at least two.");
  }

  /** `group` names the checkout: one busy checkout must not starve the others' reads. */
  run<T>(task: () => Promise<T>, priority: GitReadPriority = "foreground", group = ""): Promise<T> {
    if (this.stopped && priority === "background") return Promise.reject(new Error("Git background reads stopped."));
    // Started from whichever task freed the slot, so bind it back to its caller's async context.
    const bound = AsyncResource.bind(task);
    return new Promise<T>((resolve, reject) => {
      this.queue.push({
        priority,
        group,
        queuedAt: this.now(),
        reject,
        start: () => {
          this.active++;
          this.activeByGroup.set(group, (this.activeByGroup.get(group) ?? 0) + 1);
          this.commands++;
          this.peak = Math.max(this.peak, this.active);
          if (priority === "background") this.background++;
          void Promise.resolve()
            .then(bound)
            .then(resolve, reject)
            .finally(() => {
              this.active--;
              const remaining = (this.activeByGroup.get(group) ?? 1) - 1;
              if (remaining) this.activeByGroup.set(group, remaining);
              else this.activeByGroup.delete(group);
              if (priority === "background") this.background--;
              this.drain();
            });
        },
      });
      this.drain();
    });
  }

  stopBackground(): void {
    this.stopped = true;
    const remaining: PendingProcess[] = [];
    for (const entry of this.queue) {
      if (entry.priority === "background") entry.reject(new Error("Git background reads stopped."));
      else remaining.push(entry);
    }
    this.queue = remaining;
  }

  getStats() {
    return {
      active: this.active,
      background: this.background,
      queued: this.queue.length,
      peak: this.peak,
      commands: this.commands,
      longestWaitMs: this.longestWaitMs,
    };
  }

  private drain(): void {
    while (this.active < this.limit) {
      const now = this.now();
      let chosen = -1;
      let highest = -Infinity;
      for (let index = 0; index < this.queue.length; index++) {
        const entry = this.queue[index];
        if (entry.priority === "background" && this.background >= this.limit - 1) continue;
        const score =
          (entry.priority === "foreground" ? 5000 : 0) +
          (now - entry.queuedAt) -
          5000 * (this.activeByGroup.get(entry.group) ?? 0);
        if (score <= highest) continue;
        chosen = index;
        highest = score;
      }
      if (chosen < 0) return;
      const [entry] = this.queue.splice(chosen, 1);
      this.longestWaitMs = Math.max(this.longestWaitMs, now - entry.queuedAt);
      entry.start();
    }
  }
}
