/// <reference types="node" />
import fs from "node:fs";
import path from "node:path";
import { getLogger } from "./logger.js";

const log = getLogger("notify-urls");

/**
 * The registry that tells an installed `notify.mjs` where to POST a hook.
 *
 * ~/.claude/settings.json is global, so exactly ONE notify.mjs is ever
 * registered with Claude Code — and it has to be able to reach an instance
 * whose data directory is a different one (dev beside prod). The registry
 * therefore lives in a SHARED directory, outside any single data dir.
 *
 * Shared state written by several OS processes is where this file earns its
 * existence. A single shared document meant read-modify-write from every
 * instance at once: dev and prod both read the old content, both add their own
 * entry, and the second rename discarded the first one's — silently, and only
 * under a race, so the affected panel just stopped receiving hooks. tmp+rename
 * prevents a torn file; it does nothing about a lost update.
 *
 * So each instance owns exactly one file — `instances/<instanceId>.json` — and
 * writes nothing else that another instance also writes. Concurrent writers
 * cannot collide because they never touch the same path, and the reader
 * (`notify.mjs`) merges the directory.
 *
 * Each shard also carries a LEASE — `updatedAt`, refreshed on every write and
 * by a periodic renewal while the instance runs. Nobody but the owner ever
 * writes a shard, so nobody but the owner could ever remove one: a file left
 * behind by a crash, a deleted dev data dir or an old portable install would
 * otherwise be merged forever, and `notify.mjs` would keep POSTing hook events
 * at a dead — or recycled — port on every single hook. The lease makes "this
 * installation is gone" an observable fact instead of an assumption, and it is
 * deliberately long (`SHARD_LEASE_TTL_MS`): the cost of expiring a live
 * instance early is losing its hook routing, so only a shard nobody has
 * touched for days is treated as abandoned.
 *
 * Two legacy copies are kept in step for older readers, and neither is
 * authoritative — a lease is what makes a source trustworthy, and these two are
 * bare maps, so the current `notify.mjs` reads them only when no leased shard
 * answered at all:
 *  - `<sharedDir>/notify-urls.json` — the aggregate an older notify.mjs reads.
 *    It is REBUILT from the per-instance files on every write, and again by the
 *    start-up sweep, so a lost update here — or an entry belonging to an
 *    installation that has just been swept — is self-healing rather than
 *    permanent.
 *  - `<localPath>` — this data dir's own copy, which an older script installed
 *    by THIS instance resolves against.
 */
export interface NotifyUrlEntry {
  url: string;
  instanceId: string;
  sid: string;
}

export type NotifyUrlRegistry = Record<string, NotifyUrlEntry[]>;

/**
 * How long a shard stays routable without being written or renewed.
 *
 * Seven days, not seven minutes. An expired shard is DELETED, and expiring a
 * live installation's file costs it every hook until it registers again — so
 * the bar is "no sign of life for days", which no running instance can hit
 * (the lease is renewed periodically) and no abandoned one can miss.
 */
export const SHARD_LEASE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * A shard as it is stored: the URL map plus its lease.
 *
 * Older shards — and both legacy mirrors, which are read by scripts that know
 * nothing about leases — are the bare map. `readShard` accepts either shape,
 * and an untimestamped file is dated by its mtime rather than assumed fresh or
 * assumed dead.
 */
interface NotifyUrlShard {
  updatedAt: number;
  urls: NotifyUrlRegistry;
}

/**
 * Registry key for a workspace directory.
 *
 * Case is folded only where the filesystem is case-insensitive. On Linux
 * `/work/Repo` and `/work/repo` are two different directories, and folding
 * them together would route one workspace's hooks into the other's panel.
 * `notify.mjs#norm` applies exactly the same rule.
 */
export function normalizeCwd(cwd: string): string {
  const slashed = String(cwd || "")
    .replace(/\\/g, "/")
    .replace(/\/+$/, "");
  const caseInsensitive = process.platform === "win32" || process.platform === "darwin";
  return caseInsensitive ? slashed.toLowerCase() : slashed;
}

export function getUrlPort(u: string): string {
  try {
    return new URL(u).port;
  } catch {
    return "";
  }
}

export function getUrlSid(u: string): string {
  try {
    return new URL(u).searchParams.get("sid") || "";
  } catch {
    return "";
  }
}

/** Older files hold bare URL strings; both shapes are read, only the new one written. */
function toEntry(item: unknown): NotifyUrlEntry | null {
  if (typeof item === "string") {
    return item ? { url: item, instanceId: "", sid: getUrlSid(item) } : null;
  }
  const record = item as { url?: unknown; instanceId?: unknown; sid?: unknown } | null;
  if (!record || typeof record.url !== "string" || !record.url) return null;
  return {
    url: record.url,
    instanceId: typeof record.instanceId === "string" ? record.instanceId : "",
    sid: typeof record.sid === "string" ? record.sid : getUrlSid(record.url),
  };
}

function toRegistry(raw: Record<string, unknown> | null): NotifyUrlRegistry {
  const out: NotifyUrlRegistry = {};
  for (const [key, list] of Object.entries(raw || {})) {
    if (!Array.isArray(list)) continue;
    const entries = list.map(toEntry).filter((e): e is NotifyUrlEntry => e !== null);
    if (entries.length) out[key] = entries;
  }
  return out;
}

/**
 * Read one shard, in either shape, with an age we can act on.
 *
 * `updatedAt` is what the current writer stamps. A file without one is not
 * assumed fresh (the residue this exists to clear would then never expire) nor
 * assumed dead (a live sibling on an older build would lose its routing) — it
 * is dated by its mtime, which is a real signal, since every write rewrites
 * the file.
 *
 * That fallback matters most when the READ fails. A shard that could not be
 * parsed is not an expired shard: on Windows a read landing on the writer's
 * rename fails outright, and answering "age 0, so infinitely old" would have
 * the reader DELETE the file of an installation that is very much alive. The
 * mtime survives a failed read, so a mid-write file still dates as fresh and
 * only a genuinely ancient one is treated as abandoned.
 */
function readShard(file: string): NotifyUrlShard {
  let raw: Record<string, unknown> | null;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
  } catch {
    return { updatedAt: fileMtime(file), urls: {} };
  }
  if (!raw || typeof raw !== "object") return { updatedAt: fileMtime(file), urls: {} };
  const wrapped = raw as { updatedAt?: unknown; urls?: unknown };
  if (wrapped.urls && typeof wrapped.urls === "object" && !Array.isArray(wrapped.urls)) {
    return {
      updatedAt: typeof wrapped.updatedAt === "number" ? wrapped.updatedAt : fileMtime(file),
      urls: toRegistry(wrapped.urls as Record<string, unknown>),
    };
  }
  return { updatedAt: fileMtime(file), urls: toRegistry(raw) };
}

function fileMtime(file: string): number {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}

/** Write one registry file atomically via tmp+rename to prevent torn reads. */
function writeFileAtomic(file: string, data: NotifyUrlRegistry | NotifyUrlShard): void {
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmpPath = `${file}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), "utf8");
  fs.renameSync(tmpPath, file);
}

export interface NotifyUrlRegistryOptions {
  /** Directory shared by every installation — `~/.strideterm-hooks` in production. */
  sharedDir: string;
  /** `<userDataPath>/hooks/notify-urls.json`, kept for this instance's own older script. */
  localPath: string;
  /** Stable identity of this installation (a hash of its data dir). */
  instanceId: string;
}

export function createNotifyUrlRegistry(options: NotifyUrlRegistryOptions) {
  const instancesDir = path.join(options.sharedDir, "instances");
  const ownPath = path.join(instancesDir, `${options.instanceId}.json`);
  const aggregatePath = path.join(options.sharedDir, "notify-urls.json");

  function instanceFiles(): string[] {
    try {
      return fs
        .readdirSync(instancesDir)
        .filter((name) => name.endsWith(".json"))
        .map((name) => path.join(instancesDir, name));
    } catch {
      return [];
    }
  }

  function readOwn(): NotifyUrlRegistry {
    return readShard(ownPath).urls;
  }

  function readMerged(): NotifyUrlRegistry {
    const merged: NotifyUrlRegistry = {};
    const now = Date.now();
    for (const file of instanceFiles()) {
      const shard = readShard(file);
      // An expired shard is not routed. `notify.mjs` applies the same rule at
      // read time, so residue stops being POSTed to before any running
      // instance gets around to deleting the file.
      if (file !== ownPath && now - shard.updatedAt > SHARD_LEASE_TTL_MS) continue;
      for (const [key, entries] of Object.entries(shard.urls)) {
        const bucket = (merged[key] ||= []);
        for (const entry of entries) {
          if (!bucket.some((existing) => existing.url === entry.url)) bucket.push(entry);
        }
      }
    }
    return merged;
  }

  /**
   * Delete shards whose lease ran out. Returns how many files went.
   *
   * The one place an instance touches a file it does not own, and it only ever
   * removes: a shard nobody has written or renewed for `SHARD_LEASE_TTL_MS` is
   * a crashed run, a deleted data dir or an uninstalled portable copy, and
   * there is by construction no other process left to clean it up. Our own
   * shard is never a candidate — its age is our own business.
   *
   * Called once at start-up rather than on every write: reading and unlinking
   * across the shared directory is exactly the traffic that collides with a
   * sibling's rename, and nothing depends on it being prompt — an expired
   * shard has already stopped being routed to (`readMerged()` and
   * `notify.mjs` both skip it), so deleting the file is only tidiness.
   *
   * The aggregate mirror IS rebuilt here, in the same operation. It is a bare
   * map with no lease, so a copy written while the swept installation was
   * alive still names its URLs — and once the shard is gone, nothing is left
   * to recognise them by (`notify.mjs` tombstones an expired shard's URLs, but
   * only while the file it reads them from is still there). Leaving that to
   * the next `persist()` would keep a dead port routable in the meantime.
   */
  function pruneExpiredShards(): number {
    let removed = 0;
    const now = Date.now();
    for (const file of instanceFiles()) {
      if (file === ownPath) continue;
      const shard = readShard(file);
      if (now - shard.updatedAt <= SHARD_LEASE_TTL_MS) continue;
      try {
        fs.unlinkSync(file);
        removed += 1;
        log.info("abandoned notify-urls shard removed", { file: path.basename(file), ageMs: now - shard.updatedAt });
      } catch (err) {
        log.debug("notify-urls shard removal failed", { file: path.basename(file), err: (err as Error).message });
      }
    }
    if (removed > 0) {
      try {
        writeFileAtomic(aggregatePath, readMerged());
      } catch (err) {
        log.debug("aggregate rebuild after sweep failed", { err: (err as Error).message });
      }
    }
    return removed;
  }

  /**
   * Persist our own file — lease stamped — then rebuild the legacy copies.
   *
   * The aggregate is derived, never edited in place: whatever a concurrent
   * writer's rebuild happened to drop is back the next time either instance
   * writes, and the per-instance files it is built from are never at risk. It
   * cannot re-publish an expired shard either: `readMerged()` already refuses
   * those. Sweeping the files themselves is NOT done here — it is a start-up
   * job (see `pruneExpiredShards`), because every extra pass over the shared
   * directory is another chance to collide with a sibling's rename.
   */
  function persist(own: NotifyUrlRegistry): void {
    writeFileAtomic(ownPath, { updatedAt: Date.now(), urls: own } satisfies NotifyUrlShard);
    try {
      // Both mirrors stay the BARE map: they exist for scripts that predate
      // the lease and would not recognise a wrapper.
      writeFileAtomic(options.localPath, own);
    } catch (err) {
      log.debug("local notify-urls.json copy failed", { err: (err as Error).message });
    }
    try {
      writeFileAtomic(aggregatePath, readMerged());
    } catch (err) {
      log.debug("aggregate notify-urls.json mirror failed", { err: (err as Error).message });
    }
  }

  return {
    /** Path of the file this instance owns. */
    ownPath,
    /** This instance's own entries. */
    readOwn,
    /** What a reader sees: every live instance file merged. */
    readMerged,
    /** Remove shards left behind by installations that are gone. */
    pruneExpiredShards,

    /**
     * Re-stamp our lease so a long-running instance with no panel churn is
     * never mistaken for an abandoned one.
     *
     * A no-op when we hold no entries: an instance with nothing registered has
     * nothing to keep alive, and creating an empty shard just to date it would
     * put a file in the shared directory for no reader to use.
     */
    renewLease(): void {
      const own = readOwn();
      if (!Object.keys(own).length) return;
      try {
        persist(own);
      } catch (err) {
        log.debug("notify-urls lease renewal failed", { err: (err as Error).message });
      }
    },

    /** Add or replace this instance's entry for one session. */
    register(cwd: string, url: string): void {
      const key = normalizeCwd(cwd);
      const sid = getUrlSid(url);
      const own = readOwn();
      const bucket = (own[key] || []).filter((entry) => entry.sid !== sid);
      bucket.push({ url, instanceId: options.instanceId, sid });
      own[key] = bucket;
      try {
        persist(own);
        log.debug("notify-urls registered", { cwd: key, urls: bucket.length, port: getUrlPort(url) });
      } catch (err) {
        log.warn("failed to write notify-urls", { err: (err as Error).message });
      }
    },

    /** Drop this instance's entry for one session. Returns how many were removed. */
    unregister(sessionId: string): number {
      if (!sessionId) return 0;
      const own = readOwn();
      let removed = 0;
      for (const key of Object.keys(own)) {
        const before = own[key].length;
        own[key] = own[key].filter((entry) => entry.sid !== sessionId);
        removed += before - own[key].length;
        if (own[key].length === 0) delete own[key];
      }
      if (!removed) return 0;
      try {
        persist(own);
        log.debug("notify-urls entry removed", { sessionId, removed });
      } catch (err) {
        log.debug("notify-urls unregister failed", { err: (err as Error).message });
      }
      return removed;
    },

    /** Drop every entry of ours pointing at one port (shutdown, or a crashed run). */
    cleanupPort(port: number): number {
      try {
        const own = readOwn();
        const portStr = String(port);
        let removed = 0;
        for (const key of Object.keys(own)) {
          const before = own[key].length;
          own[key] = own[key].filter((entry) => getUrlPort(entry.url) !== portStr);
          removed += before - own[key].length;
          if (own[key].length === 0) delete own[key];
        }
        if (removed > 0) {
          persist(own);
          log.debug("notify-urls cleanup", { port: portStr, removed });
        }
        return removed;
      } catch (err) {
        log.debug("notify-urls cleanup failed", { err: (err as Error).message });
        return 0;
      }
    },
  };
}

/** The handle `createNotifyUrlRegistry` returns. */
export type NotifyUrlRegistryHandle = ReturnType<typeof createNotifyUrlRegistry>;
