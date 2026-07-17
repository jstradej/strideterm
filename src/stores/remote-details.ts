import { defineStore } from "pinia";
import { shallowRef } from "vue";
import type { Transport, ResourceInvalidate } from "../transport.js";

/**
 * remote-details — client-side cache of slim-core DETAIL resources for the
 * remote transport (git snapshots, docker state, provider inbox/PR detail,
 * review-bridge contexts).
 *
 * The slim core (protocol 2) carries only summaries/badges. Panes declare
 * interest in the detail resources they render; the server pushes
 * `resource:invalidate` on first interest and whenever a resource changes, and
 * this store fetches the detail on demand and caches it. The app store's
 * accessors read from here on remote and from `payload` on desktop, so there is
 * ONE adaptive renderer.
 *
 * Cached data is preserved across revalidation (a stale revision is refetched
 * without first clearing the old value) so panes don't flicker on every summary
 * update. Eviction is bounded by count + lifetime, never by a JSON byte
 * threshold; correctness never depends on a cached resource surviving eviction
 * (reopening the pane re-declares interest → refetch).
 */

interface CachedDetail {
  revision: string;
  data: unknown;
  fetchedAt: number;
}

/** Max cached detail resources kept alive; currently-interested resources are
 *  never evicted. Reopening an evicted pane refetches it. */
const MAX_CACHED = 48;
/** Lifetime bound: a cached detail older than this that is no longer interested
 *  is dropped so the cache never holds indefinitely-stale data. Interested
 *  resources are revalidated by invalidations and never age out. */
const CACHE_MAX_AGE_MS = 5 * 60_000;
/** How often the idle sweep prunes aged-out, uninterested entries (so lifetime
 *  is bounded even when no new fetch triggers eviction). */
const CACHE_SWEEP_MS = 60_000;
/** Retry schedule for a failed fetch of a still-visible resource: without it a
 *  transient error would leave a mounted pane blank forever (no invalidation is
 *  coming for an unchanged resource). Bounded so a persistently-failing resource
 *  stops hammering the server. */
const MAX_FETCH_RETRIES = 4;
const RETRY_BASE_MS = 500;
const RETRY_MAX_MS = 8_000;

export const useRemoteDetailsStore = defineStore("remoteDetails", () => {
  let api: Transport | null = null;
  let enabled = false;
  // Reactive by whole-Map replacement (shallowRef) — cheap for the small,
  // pane-sized set of detail resources a client renders at once.
  const cache = shallowRef<Map<string, CachedDetail>>(new Map());
  // Ref-counted interest: several visible grid cells may render the same
  // resource; it stays interested until the last one unmounts.
  const interestCounts = new Map<string, number>();
  const interests = new Set<string>();
  // Pending retry timers + attempt counts for resources whose fetch failed while
  // still visible.
  const retryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const retryCounts = new Map<string, number>();
  // Monotonic per-resource fetch sequence. Every fetchDetail bumps it; only the
  // LATEST-issued fetch is allowed to write the cache, so a slower older request
  // completing after a newer one can never clobber the fresher cached data
  // (concurrent invalidations, ack-driven refetch and retries all race here).
  const fetchSeq = new Map<string, number>();
  let sweepTimer: ReturnType<typeof setInterval> | null = null;
  // Fake clock injectable in tests (Date.now unavailable in some harnesses).
  let now = (): number => Date.now();

  function init(transport: Transport): void {
    api = transport;
    enabled = Boolean(transport.isRemote);
    if (!enabled) return;
    transport.onResourceInvalidate?.((msg) => void onInvalidate(msg));
    if (!sweepTimer) {
      sweepTimer = setInterval(pruneExpired, CACHE_SWEEP_MS);
      (sweepTimer as { unref?: () => void }).unref?.();
    }
  }

  /** Test seam: inject a deterministic clock + reset. */
  function _resetForTest(clock?: () => number): void {
    api = null;
    enabled = false;
    cache.value = new Map();
    interestCounts.clear();
    interests.clear();
    for (const t of retryTimers.values()) clearTimeout(t);
    retryTimers.clear();
    retryCounts.clear();
    fetchSeq.clear();
    if (sweepTimer) {
      clearInterval(sweepTimer);
      sweepTimer = null;
    }
    if (clock) now = clock;
  }

  function clearRetry(resource: string): void {
    const t = retryTimers.get(resource);
    if (t) clearTimeout(t);
    retryTimers.delete(resource);
    retryCounts.delete(resource);
  }

  /** Schedule a bounded, backing-off refetch for a still-interested resource
   *  whose fetch just failed. Correctness never depends on it (reopening the
   *  pane refetches too); it only fills a blank visible pane after a transient
   *  error. */
  function scheduleRetry(resource: string): void {
    if (!enabled || !interests.has(resource)) return;
    const attempt = (retryCounts.get(resource) || 0) + 1;
    if (attempt > MAX_FETCH_RETRIES) return;
    retryCounts.set(resource, attempt);
    const delay = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** (attempt - 1));
    const existing = retryTimers.get(resource);
    if (existing) clearTimeout(existing);
    retryTimers.set(
      resource,
      setTimeout(() => {
        retryTimers.delete(resource);
        if (interests.has(resource)) void fetchDetail(resource);
      }, delay),
    );
  }

  /** Drop aged-out, no-longer-interested entries (lifetime bound). */
  function pruneExpired(): void {
    const cutoff = now() - CACHE_MAX_AGE_MS;
    let changed = false;
    const next = new Map(cache.value);
    for (const [key, entry] of next) {
      if (!interests.has(key) && entry.fetchedAt < cutoff) {
        next.delete(key);
        changed = true;
      }
    }
    if (changed) cache.value = next;
  }

  /** Cached detail data for a resource, or null when not (yet) loaded. */
  function get(resource: string): unknown {
    return cache.value.get(resource)?.data ?? null;
  }

  /** Cached revision for a resource, or "" when absent. */
  function revisionOf(resource: string): string {
    return cache.value.get(resource)?.revision ?? "";
  }

  function isInterested(resource: string): boolean {
    return interests.has(resource);
  }

  /** Declare interest in a resource (a pane mounted). Ref-counted. */
  function addInterest(resource: string): void {
    if (!enabled || !resource) return;
    const n = (interestCounts.get(resource) || 0) + 1;
    interestCounts.set(resource, n);
    if (n === 1) {
      interests.add(resource);
      sendInterest();
      // The server pushes an immediate invalidate for a newly-interested
      // resource, which drives the first fetch. Fetch proactively too in case
      // the socket is momentarily closed (the invalidate would then be missed).
      void fetchDetail(resource);
    }
  }

  /** Drop interest in a resource (a pane unmounted). Ref-counted. */
  function removeInterest(resource: string): void {
    if (!enabled || !resource) return;
    const n = (interestCounts.get(resource) || 0) - 1;
    if (n <= 0) {
      interestCounts.delete(resource);
      interests.delete(resource);
      clearRetry(resource); // stop retrying a no-longer-visible resource
      sendInterest();
    } else {
      interestCounts.set(resource, n);
    }
  }

  function sendInterest(): void {
    api?.subscribeResources?.([...interests]);
  }

  /**
   * Force a refetch of the given resources if we're still interested in them —
   * the client's response to a mutation ack that names its `changedResources`.
   * The WS `resource:invalidate` push also covers this, but the ack arrives on
   * the mutation's own HTTP response, so acting on it closes the request→repaint
   * latency without waiting for the broadcast round-trip. The ordering guard in
   * fetchDetail keeps this safe against the concurrent broadcast-driven fetch.
   */
  function invalidateResources(resources: string[]): void {
    if (!enabled) return;
    for (const r of resources) if (r && interests.has(r)) void fetchDetail(r);
  }

  async function onInvalidate(msg: ResourceInvalidate): Promise<void> {
    // Ignore resources we no longer render; skip a refetch when we already hold
    // the current revision (revalidation without change → keep cached data).
    if (!interests.has(msg.resource)) return;
    if (cache.value.get(msg.resource)?.revision === msg.revision) return;
    await fetchDetail(msg.resource);
  }

  async function fetchDetail(resource: string): Promise<void> {
    if (!enabled || !api?.fetchResourceDetail) return;
    // Ordering guard: stamp this fetch and only let the latest-issued one write.
    const seq = (fetchSeq.get(resource) || 0) + 1;
    fetchSeq.set(resource, seq);
    try {
      const res = await api.fetchResourceDetail(resource);
      if (!res || res.resource !== resource) return;
      // A newer fetch for this resource started after us (a fresh invalidation,
      // an ack-driven refetch, a retry). Its response is authoritative — drop
      // ours so an out-of-order completion can't overwrite the newer cache.
      if (fetchSeq.get(resource) !== seq) return;
      // The pane may have unmounted mid-flight; still cache (cheap) but it will
      // be eligible for eviction since it's no longer interested.
      const next = new Map(cache.value);
      next.set(resource, { revision: res.revision, data: res.data, fetchedAt: now() });
      evict(next);
      cache.value = next;
      clearRetry(resource); // succeeded — reset the retry backoff
    } catch {
      // Transient failure. If the resource is still visible, retry with backoff
      // so its pane doesn't stay blank (no invalidation is coming for an
      // unchanged resource). Correctness never depends on this succeeding —
      // reopening the pane refetches too.
      scheduleRetry(resource);
    }
  }

  function evict(map: Map<string, CachedDetail>): void {
    // Lifetime bound first: drop aged-out, uninterested entries regardless of
    // count so the cache never holds indefinitely-stale data.
    const cutoff = now() - CACHE_MAX_AGE_MS;
    for (const [key, entry] of [...map.entries()]) {
      if (!interests.has(key) && entry.fetchedAt < cutoff) map.delete(key);
    }
    if (map.size <= MAX_CACHED) return;
    const evictable = [...map.entries()]
      .filter(([key]) => !interests.has(key))
      .sort((a, b) => a[1].fetchedAt - b[1].fetchedAt);
    let over = map.size - MAX_CACHED;
    for (const [key] of evictable) {
      if (over-- <= 0) break;
      map.delete(key);
    }
  }

  return {
    init,
    get,
    revisionOf,
    isInterested,
    addInterest,
    removeInterest,
    invalidateResources,
    // exposed for tests
    _resetForTest,
    _interests: interests,
    _cache: cache,
    fetchDetail,
    onInvalidate,
  };
});
