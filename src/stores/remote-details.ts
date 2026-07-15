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
  // Fake clock injectable in tests (Date.now unavailable in some harnesses).
  let now = (): number => Date.now();

  function init(transport: Transport): void {
    api = transport;
    enabled = Boolean(transport.isRemote);
    if (!enabled) return;
    transport.onResourceInvalidate?.((msg) => void onInvalidate(msg));
  }

  /** Test seam: inject a deterministic clock + reset. */
  function _resetForTest(clock?: () => number): void {
    api = null;
    enabled = false;
    cache.value = new Map();
    interestCounts.clear();
    interests.clear();
    if (clock) now = clock;
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
      sendInterest();
    } else {
      interestCounts.set(resource, n);
    }
  }

  /**
   * Replace the interest set for one owner key with `resources` — the pattern a
   * pane/grid uses when its visible set changes. Diffs against what this owner
   * last declared so ref-counts stay correct across grid churn.
   */
  const ownerSets = new Map<string, Set<string>>();
  function setInterestForOwner(owner: string, resources: string[]): void {
    if (!enabled) return;
    const prev = ownerSets.get(owner) || new Set<string>();
    const next = new Set(resources.filter(Boolean));
    for (const r of next) if (!prev.has(r)) addInterest(r);
    for (const r of prev) if (!next.has(r)) removeInterest(r);
    if (next.size) ownerSets.set(owner, next);
    else ownerSets.delete(owner);
  }

  function sendInterest(): void {
    api?.subscribeResources?.([...interests]);
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
    try {
      const res = await api.fetchResourceDetail(resource);
      if (!res || res.resource !== resource) return;
      // The pane may have unmounted mid-flight; still cache (cheap) but it will
      // be eligible for eviction since it's no longer interested.
      const next = new Map(cache.value);
      next.set(resource, { revision: res.revision, data: res.data, fetchedAt: now() });
      evict(next);
      cache.value = next;
    } catch {
      // Transient failure — a later invalidate (or the next interest cycle)
      // retries. Correctness never depends on this fetch succeeding.
    }
  }

  function evict(map: Map<string, CachedDetail>): void {
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
    setInterestForOwner,
    // exposed for tests
    _resetForTest,
    _interests: interests,
    _cache: cache,
    fetchDetail,
    onInvalidate,
  };
});
