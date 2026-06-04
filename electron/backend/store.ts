/// <reference types="node" />
import path from "node:path";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import lockfile from "proper-lockfile";
import { createDefaultState, normalizeState } from "./default-state.js";
import { getLogger } from "./logger.js";
import { renameWithRetries, syncDirectory, writeFileDurable } from "./shared/fs-durable.js";

const log = getLogger("store");

const LOAD_RETRIES = 3;
const RETRY_DELAY_MS = 200;
// A queued store operation (mutate/replace/save) that hasn't settled after
// this long is either waiting behind a stuck predecessor or hung itself —
// both poison the whole queue (every later IPC mutate hangs → frozen UI).
const SLOW_OP_WARN_MS = 5000;
// Atomic-write temp files survive only when a process died mid-persist —
// the single-instance lock means they can never belong to a live sibling.
const ORPHAN_TMP_MAX_AGE_MS = 60 * 60 * 1000;
// .corrupt-* forensic snapshots are kept long enough for a user/support to
// notice and inspect, then swept so token-bearing copies don't pile up.
const CORRUPT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
// The .bak refreshes at most this often. Its job is "a recent known-good
// fallback when main turns unreadable", not a per-write mirror — without a
// cap, un-coalesced writers (window move/resize persists every event) would
// pay a full extra file copy per persist.
const BACKUP_MIN_INTERVAL_MS = 30 * 1000;

type AppState = ReturnType<typeof createDefaultState>;
type StateCandidateKind = "main" | "backup" | "tmp";
type StateCandidate = {
  kind: StateCandidateKind;
  filePath: string;
  state: AppState;
  raw: string;
  mtimeMs: number;
  size: number;
};
type InvalidStateCandidate = {
  kind: StateCandidateKind;
  filePath: string;
  mtimeMs: number;
  size: number;
  reason: string;
};
type SidecarOrphan = {
  filePath: string;
  mtimeMs: number;
  maxAgeMs: number;
};
type StoreMutator = (_draft: AppState) => Promise<AppState | void> | AppState | void;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function backupPathFor(filePath: string): string {
  return `${filePath}.bak`;
}

function corruptPathFor(filePath: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `${filePath}.corrupt-${stamp}`;
}

// Per-statePath timestamp of the last successful .bak refresh. A recovery
// promotion takes a backup first (process start, map empty), and the throttle
// then deliberately keeps the first post-recovery persists from overwriting
// that pre-recovery snapshot right away.
const lastBackupAtByPath = new Map<string, number>();

async function writeBackup(filePath: string): Promise<void> {
  const now = Date.now();
  if (now - (lastBackupAtByPath.get(filePath) ?? 0) < BACKUP_MIN_INTERVAL_MS) return;
  if (!existsSync(filePath)) return;
  const backupPath = backupPathFor(filePath);
  const tmpBackupPath = `${backupPath}.tmp-${process.pid}-${randomUUID()}`;
  try {
    // read + writeFileDurable instead of copyFile: the handle is opened with
    // mode 0o600 so there is no umask window between copy and chmod, and the
    // backup bytes are fsynced like every other durable write.
    const data = await fs.readFile(filePath, "utf8");
    await writeFileDurable(tmpBackupPath, data);
    await renameWithRetries(tmpBackupPath, backupPath);
    await fs.chmod(backupPath, 0o600).catch(() => {});
    await syncDirectory(backupPath);
    lastBackupAtByPath.set(filePath, now);
  } catch (error) {
    await fs.rm(tmpBackupPath, { force: true }).catch(() => {});
    log.warn("state backup write failed", { err: (error as Error).message });
  }
}

/**
 * Atomic write: write to a temp file first, then rename over the target.
 * This prevents half-written/empty files if the process crashes mid-write.
 *
 * The temp filename mixes PID and a random UUID. PID alone is not enough
 * — a sibling process started by `dev.ps1` (which runs an isolated data
 * dir) or a stale process whose PID has been recycled by the OS could
 * collide on the temp file and lose one of the two writes during the
 * rename race.
 */
async function atomicWriteFile(
  filePath: string,
  data: string,
  options: { backupExisting?: boolean } = {},
): Promise<void> {
  const tmpPath = `${filePath}.tmp-${process.pid}-${randomUUID()}`;
  // mode 0o600 (set by writeFileDurable): the state file contains the
  // remote-access token in plaintext (the LAN auth secret). Default umask
  // 022 would leave it world-readable and any other user on the same host
  // could connect. Windows ignores mode.
  await writeFileDurable(tmpPath, data);
  // On final rename failure (renameWithRetries rethrows) the tmp file is
  // deliberately left in place: it holds the newest state, the target file
  // is intact, and recoverStateFile promotes it on a later startup.
  if (options.backupExisting) {
    await writeBackup(filePath);
  }
  await renameWithRetries(tmpPath, filePath);
  await fs.chmod(filePath, 0o600).catch(() => {});
  await syncDirectory(filePath);
}

/**
 * Every state file this app writes carries a `workspaces` array (legacy
 * files used `projects`). normalizeState() is a repair function — it turns
 * ANY parseable JSON (`{}`, `[]`, `42`…) into a fresh default state, so
 * "JSON.parse + normalizeState succeeded" is far too weak a validity test
 * for recovery: promoting such a candidate would replace the user's real
 * state (and rotate the remote-access token) with empty defaults.
 */
function looksLikePersistedState(parsed: unknown): boolean {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
  const record = parsed as Record<string, unknown>;
  return Array.isArray(record.workspaces) || Array.isArray(record.projects);
}

async function readCandidate(
  kind: StateCandidateKind,
  filePath: string,
): Promise<StateCandidate | InvalidStateCandidate | null> {
  let stat;
  try {
    stat = await fs.stat(filePath);
  } catch {
    return null;
  }
  if (stat.size === 0) {
    return { kind, filePath, mtimeMs: stat.mtimeMs, size: stat.size, reason: "empty" };
  }
  try {
    const raw = await fs.readFile(filePath, "utf8");
    if (!raw.trim()) {
      return { kind, filePath, mtimeMs: stat.mtimeMs, size: stat.size, reason: "empty" };
    }
    const parsed: unknown = JSON.parse(raw);
    if (!looksLikePersistedState(parsed)) {
      return { kind, filePath, mtimeMs: stat.mtimeMs, size: stat.size, reason: "not a state snapshot" };
    }
    const state = normalizeState(parsed);
    return { kind, filePath, state, raw, mtimeMs: stat.mtimeMs, size: stat.size };
  } catch (error) {
    return {
      kind,
      filePath,
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      reason: (error as Error).message,
    };
  }
}

function isValidCandidate(candidate: StateCandidate | InvalidStateCandidate | null): candidate is StateCandidate {
  return !!candidate && "state" in candidate;
}

function isInvalidCandidate(
  candidate: StateCandidate | InvalidStateCandidate | null,
): candidate is InvalidStateCandidate {
  return !!candidate && !("state" in candidate);
}

async function listRecoveryCandidates(statePath: string): Promise<{
  candidates: Array<StateCandidate | InvalidStateCandidate>;
  sidecarOrphans: SidecarOrphan[];
}> {
  const dir = path.dirname(statePath);
  const base = path.basename(statePath);
  const tmpPrefix = `${base}.tmp-`;
  const bakTmpPrefix = `${base}.bak.tmp-`;
  const corruptPrefix = `${base}.corrupt-`;
  const candidates: Array<StateCandidate | InvalidStateCandidate> = [];
  const sidecarOrphans: SidecarOrphan[] = [];
  const main = await readCandidate("main", statePath);
  if (main) candidates.push(main);
  try {
    const entries = await fs.readdir(dir);
    for (const entry of entries) {
      if (entry.startsWith(tmpPrefix)) {
        const candidate = await readCandidate("tmp", path.join(dir, entry));
        if (candidate) candidates.push(candidate);
        continue;
      }
      // writeBackup tmp leftovers (hard crash mid-backup) and old forensic
      // .corrupt-* snapshots are never recovery sources — they only need
      // sweeping once they age out.
      const isBakTmp = entry.startsWith(bakTmpPrefix);
      const isCorrupt = entry.startsWith(corruptPrefix);
      if (!isBakTmp && !isCorrupt) continue;
      const filePath = path.join(dir, entry);
      const stat = await fs.stat(filePath).catch(() => null);
      if (!stat) continue;
      sidecarOrphans.push({
        filePath,
        mtimeMs: stat.mtimeMs,
        maxAgeMs: isBakTmp ? ORPHAN_TMP_MAX_AGE_MS : CORRUPT_RETENTION_MS,
      });
    }
  } catch {
    // Best-effort — an unreadable dir will surface in loadState anyway.
  }
  return { candidates, sidecarOrphans };
}

async function cleanupRecoveryArtifacts(
  candidates: Array<StateCandidate | InvalidStateCandidate>,
  sidecarOrphans: SidecarOrphan[],
): Promise<void> {
  const now = Date.now();
  let removed = 0;
  for (const candidate of candidates) {
    if (candidate.kind !== "tmp") continue;
    if (now - candidate.mtimeMs <= ORPHAN_TMP_MAX_AGE_MS) continue;
    try {
      await fs.rm(candidate.filePath, { force: true });
      removed++;
    } catch {
      // Best-effort — the file may have just been renamed/removed.
    }
  }
  for (const orphan of sidecarOrphans) {
    if (now - orphan.mtimeMs <= orphan.maxAgeMs) continue;
    try {
      await fs.rm(orphan.filePath, { force: true });
      removed++;
    } catch {
      // Best-effort.
    }
  }
  if (removed > 0) {
    log.info("removed orphaned state sidecar files", { removed });
  }
}

async function promoteCandidate(
  statePath: string,
  candidate: StateCandidate,
  previousMain: StateCandidate | null,
): Promise<void> {
  if (!previousMain && existsSync(statePath)) {
    // Preserve the unreadable main before overwriting it. If this copy
    // fails, the throw aborts the promotion: losing the user's original
    // bytes is worse than skipping recovery — loadState then surfaces the
    // corrupt file without touching it ("left untouched" contract).
    await fs.copyFile(statePath, corruptPathFor(statePath));
  }
  await atomicWriteFile(statePath, candidate.raw, { backupExisting: !!previousMain });
  if (candidate.kind === "tmp") {
    await fs.rm(candidate.filePath, { force: true }).catch(() => {});
  }
  log.warn("recovered persisted state from fallback snapshot", {
    source: candidate.kind,
    sourcePath: candidate.filePath,
    size: candidate.size,
  });
}

async function recoverStateFileLocked(statePath: string): Promise<void> {
  const { candidates, sidecarOrphans } = await listRecoveryCandidates(statePath);

  const main = candidates.find((candidate) => candidate.kind === "main") ?? null;
  const validMain = isValidCandidate(main) ? main : null;
  // No freshness grace is needed on tmp candidates: the Electron
  // single-instance lock guarantees no live sibling is mid-persist on this
  // statePath, and a torn in-flight write fails JSON.parse (or the shape
  // guard) and never becomes a candidate. A leftover tmp always belongs to
  // a dead process — the newest one wins.
  const validTmp = candidates
    .filter((candidate): candidate is StateCandidate => isValidCandidate(candidate) && candidate.kind === "tmp")
    .sort((a, b) => b.mtimeMs - a.mtimeMs);

  if (validMain) {
    const newerTmp = validTmp.find((candidate) => candidate.mtimeMs > validMain.mtimeMs);
    if (newerTmp) {
      await promoteCandidate(statePath, newerTmp, validMain);
    }
  } else {
    // Only read/parse .bak when it can actually be used (main is missing or
    // unreadable) — a healthy startup skips a full state parse this way.
    const backup = await readCandidate("backup", backupPathFor(statePath));
    const fallback = validTmp[0] ?? (isValidCandidate(backup) ? backup : null);
    if (fallback) {
      await promoteCandidate(statePath, fallback, null);
    } else if (isInvalidCandidate(main)) {
      log.warn("state main file is invalid and no recovery candidate was usable", {
        reason: main.reason,
        size: main.size,
      });
    }
  }

  // Sweep only AFTER the promotion decision: deleting an aged orphan that
  // is about to be promoted would destroy the only copy of the newest
  // state if the promotion write then failed. When a promotion above
  // throws, the sweep is skipped entirely and every artifact stays on disk
  // for the next startup.
  await cleanupRecoveryArtifacts(candidates, sidecarOrphans);
}

async function recoverStateFile(statePath: string): Promise<void> {
  await fs.mkdir(path.dirname(statePath), { recursive: true });
  let release: (() => Promise<void>) | null = null;
  if (existsSync(statePath)) {
    try {
      release = await lockfile.lock(statePath, {
        retries: { retries: 0 },
        stale: 10000,
        realpath: false,
      });
    } catch (error) {
      log.warn("state recovery skipped because the state file is locked", { err: (error as Error).message });
      return;
    }
  }
  try {
    await recoverStateFileLocked(statePath);
  } catch (error) {
    // Recovery is best-effort: a failed promotion leaves all previous files
    // in place and loadState decides what is loadable.
    log.warn("state recovery failed", { err: (error as Error).message });
  } finally {
    await release?.().catch(() => {});
  }
}

async function loadState(statePath: string): Promise<{ state: AppState; isDefaults: boolean }> {
  if (!existsSync(statePath)) {
    log.info("no state file found, creating defaults", { statePath });
    const defaults = createDefaultState();
    return { state: defaults, isDefaults: true };
  }

  let lastError: unknown;
  for (let attempt = 1; attempt <= LOAD_RETRIES; attempt++) {
    try {
      const raw = await fs.readFile(statePath, "utf8");
      if (!raw.trim()) {
        throw new Error("State file is empty");
      }
      const parsed: unknown = JSON.parse(raw);
      if (attempt > 1) {
        log.info("state loaded on retry", { attempt });
      }
      return { state: normalizeState(parsed), isDefaults: false };
    } catch (error) {
      lastError = error;
      log.warn("load attempt failed", { attempt, totalRetries: LOAD_RETRIES, err: (error as Error).message });
      if (attempt < LOAD_RETRIES) {
        await sleep(RETRY_DELAY_MS * attempt);
      }
    }
  }

  log.error("all load attempts failed", {
    statePath,
    retries: LOAD_RETRIES,
    err: (lastError as Error | undefined)?.message,
  });
  throw new Error(
    `State file at ${statePath} could not be loaded after ${LOAD_RETRIES} attempts. ` +
      "Existing file was left untouched to avoid overwriting user data.",
  );
}

export async function createStore(statePath: string) {
  await recoverStateFile(statePath);
  const { state: loadedState, isDefaults } = await loadState(statePath);
  let state = loadedState;
  let pending: Promise<unknown> = Promise.resolve();
  let queueDepth = 0;
  let lastQueueStuckWarnAt = 0;

  async function persist(operation = "state:persist"): Promise<void> {
    const startedAt = Date.now();
    const serialized = JSON.stringify(state, null, 2);
    await fs.mkdir(path.dirname(statePath), { recursive: true });
    // If the file does not exist yet, there is nothing useful to lock or back up.
    if (!existsSync(statePath)) {
      await atomicWriteFile(statePath, serialized);
      return;
    }
    // Lock acquisition gets its own catch so a write failure can never be
    // misreported as a lock failure (and is never blindly retried while the
    // lock is still held). fail-soft: if the lock cannot be acquired (stale +
    // another instance holds it), still write — the atomic tmp+rename
    // prevents half-written files.
    let release: (() => Promise<void>) | null = null;
    try {
      release = await lockfile.lock(statePath, {
        retries: { retries: 10, minTimeout: 100, maxTimeout: 500 },
        stale: 10000,
        realpath: false,
      });
    } catch (error) {
      log.warn("state file lock failed, writing without lock", { err: (error as Error).message });
    }
    try {
      await atomicWriteFile(statePath, serialized, { backupExisting: true });
    } finally {
      await release?.().catch(() => {});
      const ms = Date.now() - startedAt;
      if (ms > 1000) {
        log.warn("state persist slow", { ms, operation });
      }
    }
  }

  function enqueue<T>(kind: string, operation: () => Promise<T>): Promise<T> {
    // Captured here (not when the op starts) so a queue stuck behind an
    // earlier operation still gets reported — with the call site that's
    // waiting. The timer only fires when the event loop is alive: a hung
    // await / poisoned queue logs this, a synchronous block is the freeze
    // watchdog's job (see freeze-watchdog.ts).
    const enqueueStack = new Error(`store.${kind}`).stack;
    queueDepth += 1;
    let started = false;
    const slowTimer = setTimeout(() => {
      // One warning per stall window: when the queue head hangs, every op
      // queued behind it would otherwise fire its own timer and flood the
      // log with near-identical stacks.
      const now = Date.now();
      if (now - lastQueueStuckWarnAt < SLOW_OP_WARN_MS) return;
      lastQueueStuckWarnAt = now;
      log.warn("store operation not settled 5s after enqueue — queue may be stuck", {
        kind,
        started,
        queueDepth,
        stack: enqueueStack,
      });
    }, SLOW_OP_WARN_MS);
    const run = async () => {
      started = true;
      return operation();
    };
    const next = pending.then(run, run) as Promise<T>;
    const settle = () => {
      clearTimeout(slowTimer);
      queueDepth -= 1;
    };
    next.then(settle, settle);
    pending = next.catch((error: Error) => {
      log.error("persist queue error", { err: error.message });
    });
    return next;
  }

  /**
   * Apply a mutation to a clone of the state, then persist. `mutate(fn)`
   * and `mutate("label", fn)` are equivalent — the label names the
   * operation in slow-persist / stuck-queue diagnostics. Declared as
   * overloads so `mutate("label")` (no mutator) and `mutate(fn1, fn2)`
   * (second mutator silently dropped) fail to compile.
   *
   * Never await another store operation (mutate/replace/save/flush) from
   * inside the mutator: operations run FIFO on a single queue, so the
   * nested operation waits for the running one and deadlocks the store.
   */
  function mutate(mutator: StoreMutator): Promise<AppState>;
  function mutate(label: string, mutator: StoreMutator): Promise<AppState>;
  async function mutate(labelOrMutator: string | StoreMutator, maybeMutator?: StoreMutator): Promise<AppState> {
    const label = typeof labelOrMutator === "string" ? labelOrMutator : "mutate";
    const mutator = typeof labelOrMutator === "string" ? maybeMutator : labelOrMutator;
    if (!mutator) {
      throw new Error("store.mutate requires a mutator");
    }
    return enqueue(label, async () => {
      const draft = structuredClone(state);
      const result = await mutator(draft);
      state = normalizeState(result || draft, { seedRestoreIdsFromSlots: false });
      await persist(label);
      return state;
    });
  }

  // Only persist on startup when we loaded fresh defaults (new file).
  // Never overwrite an existing config that was successfully loaded.
  if (isDefaults) {
    await persist();
  }

  return {
    getState(): AppState {
      return state;
    },
    async replace(nextState: AppState, label = "replace"): Promise<AppState> {
      return enqueue(label, async () => {
        state = normalizeState(nextState, { seedRestoreIdsFromSlots: false });
        await persist(label);
        return state;
      });
    },
    mutate,
    async save(label = "save"): Promise<AppState> {
      return enqueue(label, async () => {
        await persist(label);
        return state;
      });
    },
    /**
     * Resolves once every operation queued so far (and its persist) has
     * settled. Used on shutdown so quit doesn't cut an in-flight tmp-write
     * + rename in half. Never rejects — queue errors are already logged.
     */
    async flush(): Promise<void> {
      await pending;
    },
  };
}
