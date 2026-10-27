import { watch, type FSWatcher } from "node:fs";
import path from "node:path";
import { getLogger, redactSecrets } from "./logger.js";

export type GitInvalidationScope = "status" | "refs" | "all";
export type GitInvalidationReason = "watch" | "poll" | "recovery";
export interface GitWatchTarget {
  key: string;
  root: string;
  gitDir: string;
  commonDir: string;
}

interface TargetState {
  target: GitWatchTarget;
  paths: Set<string>;
  timer: ReturnType<typeof setTimeout> | null;
  firstEventAt: number | null;
  running: boolean;
  pending: boolean;
  failures: number;
  costMs: number;
  nextPollAt: number;
  lastWarningAt: number;
  ignoredDirectories: Map<string, boolean>;
  classifying: Set<string>;
  pendingClassification: Set<string>;
  classificationRunning: boolean;
  ignoreGeneration: number;
}

const IGNORE_CHECK_MAX_DEPTH = 3;

interface WatchEntry {
  watcher: FSWatcher;
  targets: Set<string>;
  metadata: boolean;
}

interface WatchOptions {
  onInvalidate: (key: string, scope: GitInvalidationScope, paths: string[], reason: GitInvalidationReason) => void;
  onRefresh: (key: string) => Promise<void>;
  /** Of the given root-relative directories, the ones Git ignores and that hold no tracked file. */
  classifyIgnored?: (target: GitWatchTarget, directories: string[]) => Promise<string[]>;
  watchImpl?: typeof watch;
  now?: () => number;
  random?: () => number;
  pollMs?: number;
  debounceMs?: number;
  maxWaitMs?: number;
}

const log = getLogger("git-watch");

export class GitCheckoutWatch {
  private targets = new Map<string, TargetState>();
  private watchers = new Map<string, WatchEntry>();
  private retryWatchAt = new Map<string, number>();
  private poll: ReturnType<typeof setInterval> | null = null;
  private disposed = false;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly watchImpl: typeof watch;

  constructor(private readonly options: WatchOptions) {
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
    this.watchImpl = options.watchImpl ?? watch;
  }

  setTargets(targets: GitWatchTarget[]): void {
    if (this.disposed) return;
    const wanted = new Map(targets.map((target) => [target.key, target]));
    for (const [key, state] of this.targets) {
      const next = wanted.get(key);
      if (next && JSON.stringify(next) === JSON.stringify(state.target)) continue;
      if (state.timer) clearTimeout(state.timer);
      this.targets.delete(key);
    }
    for (const [key, target] of wanted) {
      if (this.targets.has(key)) continue;
      this.targets.set(key, {
        target,
        paths: new Set(),
        timer: null,
        firstEventAt: null,
        running: false,
        pending: false,
        failures: 0,
        costMs: 0,
        nextPollAt: this.now() + this.pollDelay(0, 0),
        lastWarningAt: -Infinity,
        ignoredDirectories: new Map(),
        classifying: new Set(),
        pendingClassification: new Set(),
        classificationRunning: false,
        ignoreGeneration: 0,
      });
    }
    this.syncWatchers();
    if (this.targets.size && !this.poll) {
      this.poll = setInterval(() => this.tick(), 1000);
      this.poll.unref();
    } else if (!this.targets.size && this.poll) {
      clearInterval(this.poll);
      this.poll = null;
    }
  }

  dispose(): void {
    this.setTargets([]);
    this.disposed = true;
  }

  getStats(): { targets: number; watchers: number; refreshing: number } {
    return {
      targets: this.targets.size,
      watchers: this.watchers.size,
      refreshing: [...this.targets.values()].filter((state) => state.running).length,
    };
  }

  private syncWatchers(): void {
    const wanted = new Map<string, { directory: string; metadata: boolean; targets: Set<string> }>();
    for (const [key, { target }] of this.targets) {
      for (const [directory, metadata] of [
        [target.root, false],
        [target.gitDir, true],
        [target.commonDir, true],
      ] as const) {
        if (!directory) continue;
        const watchKey = `${metadata ? "git" : "files"}:${directory}`;
        let entry = wanted.get(watchKey);
        if (!entry) {
          entry = { directory, metadata, targets: new Set() };
          wanted.set(watchKey, entry);
        }
        entry.targets.add(key);
      }
    }
    for (const [key, entry] of this.watchers) {
      if (wanted.has(key)) continue;
      entry.watcher.close();
      this.watchers.delete(key);
    }
    for (const key of this.retryWatchAt.keys()) {
      if (!wanted.has(key)) this.retryWatchAt.delete(key);
    }
    for (const [watchKey, desired] of wanted) {
      const existing = this.watchers.get(watchKey);
      if (existing) {
        existing.targets = desired.targets;
        continue;
      }
      if ((this.retryWatchAt.get(watchKey) ?? 0) > this.now()) continue;
      try {
        const watcher = this.watchImpl(desired.directory, { recursive: true, persistent: false }, (event, name) => {
          const entry = this.watchers.get(watchKey);
          if (!entry) return;
          const filename = name === null ? "" : String(name);
          const normalized = process.platform === "win32" ? filename.replace(/\\/g, "/") : filename;
          if (entry.metadata && /(?:^|\/)\S*\.lock$/.test(normalized)) return;
          if (!entry.metadata && (normalized === ".git" || normalized.startsWith(".git/"))) {
            if (normalized !== ".git") return;
          }
          const scope: GitInvalidationScope = !filename
            ? "all"
            : !entry.metadata
              ? normalized === ".git"
                ? "all"
                : "status"
              : /^(?:index|sharedindex\.[^/]+)$/.test(normalized)
                ? "status"
                : /^(?:refs(?:\/|$)|packed-refs$|reftable(?:\/|$)|FETCH_HEAD$)/.test(normalized)
                  ? "refs"
                  : "all";
          for (const key of entry.targets) {
            const state = this.targets.get(key);
            if (!state) continue;
            const target = state.target;
            if (entry.metadata && normalized === "info/exclude") this.forgetIgnored(state);
            if (!entry.metadata && normalized === ".git") {
              // Windows reports a change of the directory itself whenever an entry inside it is
              // written; the metadata watch already sees those. Only its creation or removal counts.
              if (event !== "rename" && path.resolve(target.gitDir) === path.resolve(target.root, ".git")) continue;
            } else if (!entry.metadata && filename && this.isIgnored(key, state, normalized)) continue;
            let targetScope = scope;
            if (entry.metadata && filename && desired.directory === target.commonDir) {
              const privateParts = normalized.startsWith("worktrees/") ? normalized.slice(10).split("/") : [];
              const privateName = privateParts.shift();
              const privatePath = privateParts.join("/");
              if (privateName) {
                if (!privatePath || ["gitdir", "commondir"].includes(privatePath)) targetScope = "refs";
                else {
                  const expected = path.join(target.commonDir, "worktrees", privateName);
                  if (path.resolve(target.gitDir) !== path.resolve(expected)) continue;
                  targetScope = privatePath === "index" ? "status" : "all";
                }
              } else if (
                target.gitDir !== target.commonDir &&
                ([
                  "HEAD",
                  "index",
                  "MERGE_HEAD",
                  "MERGE_MSG",
                  "CHERRY_PICK_HEAD",
                  "REVERT_HEAD",
                  "ORIG_HEAD",
                  "BISECT_LOG",
                  "config.worktree",
                ].includes(normalized) ||
                  (normalized.startsWith("sharedindex.") && !normalized.includes("/")) ||
                  ["rebase-merge", "rebase-apply"].includes(normalized.split("/")[0]))
              )
                continue;
            }
            this.changed(key, targetScope, filename, "watch");
          }
        });
        this.watchers.set(watchKey, { watcher, targets: desired.targets, metadata: desired.metadata });
        this.retryWatchAt.delete(watchKey);
        watcher.on("error", (error) => {
          const entry = this.watchers.get(watchKey);
          if (!entry || entry.watcher !== watcher) return;
          watcher.close();
          this.watchers.delete(watchKey);
          this.retryWatchAt.set(watchKey, this.now() + 60_000);
          for (const key of entry.targets) {
            this.warn(key, "Git watcher failed; using periodic validation", error);
            this.changed(key, "all", "", "recovery");
          }
        });
      } catch (error) {
        this.retryWatchAt.set(watchKey, this.now() + 60_000);
        for (const key of desired.targets) this.warn(key, "Git watcher unavailable; using periodic validation", error);
      }
    }
  }

  private isIgnored(key: string, state: TargetState, relative: string): boolean {
    if (relative === ".gitignore" || relative.endsWith("/.gitignore")) {
      this.forgetIgnored(state);
      return false;
    }
    const parts = relative.split("/").filter(Boolean);
    const unknown: string[] = [];
    // Build output and dependency folders sit near the root; checking deeper would spawn a
    // classification for every new folder of a checkout being written.
    for (let depth = 1; depth < Math.min(parts.length, IGNORE_CHECK_MAX_DEPTH + 1); depth++) {
      const directory = parts.slice(0, depth).join("/");
      const ignored = state.ignoredDirectories.get(directory);
      if (ignored) return true;
      if (ignored === undefined && !state.classifying.has(directory)) unknown.push(directory);
    }
    if (unknown.length) this.classify(key, state, unknown);
    return false;
  }

  /** One classification per checkout at a time; directories seen meanwhile wait for the next batch. */
  private classify(key: string, state: TargetState, directories: string[]): void {
    const classifyIgnored = this.options.classifyIgnored;
    if (!classifyIgnored) return;
    for (const directory of directories) {
      state.classifying.add(directory);
      state.pendingClassification.add(directory);
    }
    if (state.classificationRunning) return;
    const batch = [...state.pendingClassification].slice(0, 64);
    for (const directory of batch) state.pendingClassification.delete(directory);
    const generation = state.ignoreGeneration;
    state.classificationRunning = true;
    void classifyIgnored(state.target, batch)
      .catch((error: unknown) => {
        this.warn(key, "Git ignore check failed", error);
        return [] as string[];
      })
      .then((ignored) => {
        if (this.targets.get(key) !== state || state.ignoreGeneration !== generation) return;
        if (state.ignoredDirectories.size > 4096) state.ignoredDirectories.clear();
        const matched = new Set(ignored);
        for (const directory of batch) state.ignoredDirectories.set(directory, matched.has(directory));
      })
      .finally(() => {
        for (const directory of batch) state.classifying.delete(directory);
        state.classificationRunning = false;
        if (state.pendingClassification.size && this.targets.get(key) === state && !this.disposed)
          this.classify(key, state, []);
      });
  }

  private forgetIgnored(state: TargetState): void {
    state.ignoreGeneration++;
    state.ignoredDirectories.clear();
    for (const directory of state.pendingClassification) state.classifying.delete(directory);
    state.pendingClassification.clear();
  }

  private changed(key: string, scope: GitInvalidationScope, filename: string, reason: GitInvalidationReason): void {
    const state = this.targets.get(key);
    if (!state || this.disposed) return;
    if (filename && state.paths.size < 512) state.paths.add(filename);
    try {
      this.options.onInvalidate(key, scope, filename ? [filename] : [], reason);
    } catch (error) {
      this.warn(key, "Git invalidation failed", error);
    }
    state.pending = true;
    state.firstEventAt ??= this.now();
    if (state.timer) clearTimeout(state.timer);
    const remaining = Math.max(0, (this.options.maxWaitMs ?? 2000) - (this.now() - state.firstEventAt));
    const retryDelay = state.failures && reason !== "poll" ? Math.max(0, state.nextPollAt - this.now()) : 0;
    state.timer = setTimeout(
      () => {
        state.timer = null;
        void this.refresh(key, state);
      },
      Math.max(Math.min(this.options.debounceMs ?? 250, remaining), retryDelay),
    );
    state.timer.unref();
  }

  private tick(): void {
    this.syncWatchers();
    const now = this.now();
    for (const [key, state] of this.targets) {
      if (state.running || state.pending || now < state.nextPollAt) continue;
      state.nextPollAt = now + this.pollDelay(state.costMs, state.failures);
      this.forgetIgnored(state);
      this.changed(key, "status", "", "poll");
    }
  }

  private async refresh(key: string, state: TargetState): Promise<void> {
    if (this.disposed || this.targets.get(key) !== state || state.running || !state.pending) return;
    state.running = true;
    state.pending = false;
    state.firstEventAt = null;
    state.paths.clear();
    const started = this.now();
    try {
      await this.options.onRefresh(key);
      state.failures = 0;
    } catch (error) {
      state.failures = Math.min(8, state.failures + 1);
      this.warn(key, "Git background validation failed", error);
    } finally {
      const duration = Math.max(0, this.now() - started);
      state.costMs = state.costMs ? state.costMs * 0.75 + duration * 0.25 : duration;
      state.running = false;
      state.nextPollAt = this.now() + this.pollDelay(state.costMs, state.failures);
      if (state.failures && state.pending && state.timer) {
        clearTimeout(state.timer);
        state.timer = null;
      }
      if (state.pending && this.targets.get(key) === state && !state.timer && !this.disposed) {
        state.timer = setTimeout(
          () => {
            state.timer = null;
            void this.refresh(key, state);
          },
          state.failures
            ? Math.max(this.options.debounceMs ?? 250, state.nextPollAt - this.now())
            : (this.options.debounceMs ?? 250),
        );
        state.timer.unref();
      }
    }
  }

  private pollDelay(costMs: number, failures: number): number {
    const totalCost = [...this.targets.values()].reduce((sum, state) => sum + state.costMs, 0);
    const base = Math.max(this.options.pollMs ?? 60_000, costMs * 10, totalCost * 10);
    return Math.min(600_000, base * 2 ** failures) * (0.9 + this.random() * 0.2);
  }

  private warn(key: string, message: string, error: unknown): void {
    const state = this.targets.get(key);
    if (!state || this.now() - state.lastWarningAt < 60_000) return;
    state.lastWarningAt = this.now();
    const reason = error instanceof Error ? error.message : String(error);
    log.warn(message, { root: state.target.root, err: redactSecrets(reason) });
  }
}
