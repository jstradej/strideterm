import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { effectScope, ref } from "vue";
import { useRemoteDetailsStore } from "./remote-details.js";
import type { Transport, ResourceInvalidate } from "../transport.js";

/** Minimal fake remote transport that records interest sends and serves
 *  controllable detail fetches + manual invalidates. */
function fakeTransport() {
  const invalidateHandlers: Array<(m: ResourceInvalidate) => void> = [];
  const sentInterests: string[][] = [];
  const fetched: string[] = [];
  const revisions: Record<string, string> = {};
  const api = {
    isRemote: true,
    onResourceInvalidate: (h: (m: ResourceInvalidate) => void) => invalidateHandlers.push(h),
    subscribeResources: (r: string[]) => sentInterests.push([...r]),
    fetchResourceDetail: async (resource: string) => {
      fetched.push(resource);
      return { resource, revision: revisions[resource] || "r1", data: { tag: resource } };
    },
  } as unknown as Transport;
  return {
    api,
    sentInterests,
    fetched,
    setRevision: (resource: string, rev: string) => {
      revisions[resource] = rev;
    },
    invalidate: (resource: string, revision: string) => invalidateHandlers.forEach((h) => h({ resource, revision })),
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("remote-details store", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it("is a no-op on the desktop (non-remote) transport", () => {
    const store = useRemoteDetailsStore();
    store.init({ isRemote: false } as unknown as Transport);
    store.addInterest("docker");
    expect(store.isInterested("docker")).toBe(false);
  });

  it("declares interest, sends it, and fetches the detail on first interest", async () => {
    const t = fakeTransport();
    const store = useRemoteDetailsStore();
    store._resetForTest();
    store.init(t.api);
    store.addInterest("docker");
    expect(store.isInterested("docker")).toBe(true);
    expect(t.sentInterests.at(-1)).toEqual(["docker"]);
    await flush();
    expect(t.fetched).toContain("docker");
    expect(store.get("docker")).toEqual({ tag: "docker" });
  });

  it("ref-counts interest across owners (two panes, one resource)", () => {
    const t = fakeTransport();
    const store = useRemoteDetailsStore();
    store._resetForTest();
    store.init(t.api);
    store.addInterest("git:ws1"); // pane A
    store.addInterest("git:ws1"); // pane B (same resource)
    // Only the first add sends interest.
    expect(t.sentInterests.filter((s) => s.includes("git:ws1")).length).toBe(1);
    store.removeInterest("git:ws1"); // pane A unmounts — still interested (B holds it)
    expect(store.isInterested("git:ws1")).toBe(true);
    store.removeInterest("git:ws1"); // pane B unmounts — now dropped
    expect(store.isInterested("git:ws1")).toBe(false);
    expect(t.sentInterests.at(-1)).toEqual([]);
  });

  it("refetches on an invalidate with a new revision, skips an unchanged one", async () => {
    const t = fakeTransport();
    const store = useRemoteDetailsStore();
    store._resetForTest();
    store.init(t.api);
    t.setRevision("docker", "rev-1");
    store.addInterest("docker");
    await flush();
    const firstFetches = t.fetched.length;

    // Same revision → no refetch (revalidation without change keeps cached data).
    t.invalidate("docker", "rev-1");
    await flush();
    expect(t.fetched.length).toBe(firstFetches);

    // New revision → refetch.
    t.setRevision("docker", "rev-2");
    t.invalidate("docker", "rev-2");
    await flush();
    expect(t.fetched.length).toBe(firstFetches + 1);
    expect(store.revisionOf("docker")).toBe("rev-2");
  });

  it("ignores an invalidate for a resource it is no longer interested in", async () => {
    const t = fakeTransport();
    const store = useRemoteDetailsStore();
    store._resetForTest();
    store.init(t.api);
    store.addInterest("docker");
    await flush();
    const before = t.fetched.length;
    store.removeInterest("docker");
    t.invalidate("docker", "rev-9");
    await flush();
    expect(t.fetched.length).toBe(before);
  });

  it("bounds the cache by count, never evicting an interested resource", async () => {
    const t = fakeTransport();
    const store = useRemoteDetailsStore();
    let clock = 0;
    store._resetForTest(() => clock++);
    store.init(t.api);
    // Keep one resource interested; fill far past the cap with others.
    store.addInterest("docker");
    await flush();
    for (let i = 0; i < 80; i++) {
      await store.fetchDetail(`git:ws${i}`);
    }
    // docker stays cached (interested); the map is bounded.
    expect(store.get("docker")).not.toBeNull();
    expect((store._cache as unknown as Map<string, unknown>).size).toBeLessThanOrEqual(48);
  });

  it("evicts a cached resource once it ages past the lifetime bound", async () => {
    const t = fakeTransport();
    const store = useRemoteDetailsStore();
    let clock = 0;
    store._resetForTest(() => clock);
    store.init(t.api);
    await store.fetchDetail("git:a"); // cached at t=0, never interested
    expect(store.get("git:a")).not.toBeNull();
    clock = 5 * 60_000 + 1; // advance past CACHE_MAX_AGE_MS
    await store.fetchDetail("git:b"); // any fetch runs eviction → aged git:a pruned
    expect(store.get("git:a")).toBeNull();
    expect(store.get("git:b")).not.toBeNull();
  });

  it("retries a failed fetch of a still-interested resource with backoff", async () => {
    vi.useFakeTimers();
    try {
      let attempts = 0;
      const api = {
        isRemote: true,
        onResourceInvalidate: () => {},
        subscribeResources: () => {},
        fetchResourceDetail: async (resource: string) => {
          attempts += 1;
          if (attempts === 1) throw new Error("transient");
          return { resource, revision: "r1", data: { ok: true } };
        },
      } as unknown as Transport;
      const store = useRemoteDetailsStore();
      store._resetForTest();
      store.init(api);
      store.addInterest("docker"); // first fetch fails → schedules a retry
      await vi.advanceTimersByTimeAsync(0); // let the initial fetch reject
      expect(store.get("docker")).toBeNull();
      await vi.advanceTimersByTimeAsync(600); // 500ms retry timer fires → succeeds
      expect(attempts).toBeGreaterThanOrEqual(2);
      expect(store.get("docker")).toEqual({ ok: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops retrying once a resource is no longer interested", async () => {
    vi.useFakeTimers();
    try {
      let attempts = 0;
      const api = {
        isRemote: true,
        onResourceInvalidate: () => {},
        subscribeResources: () => {},
        fetchResourceDetail: async () => {
          attempts += 1;
          throw new Error("always fails");
        },
      } as unknown as Transport;
      const store = useRemoteDetailsStore();
      store._resetForTest();
      store.init(api);
      store.addInterest("docker");
      await vi.advanceTimersByTimeAsync(0); // initial fetch fails → retry scheduled
      const afterFirst = attempts;
      store.removeInterest("docker"); // pane unmounts → pending retry is cleared
      await vi.advanceTimersByTimeAsync(10_000); // no further attempts
      expect(attempts).toBe(afterFirst);
    } finally {
      vi.useRealTimers();
    }
  });

  it("drops an out-of-order stale fetch response so it cannot overwrite fresher cache", async () => {
    // Two concurrent fetches for one resource; the LATER-issued one completes
    // FIRST with fresh data, then the earlier one completes late with stale data.
    // The ordering guard must keep the fresh data.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const deferreds: Array<(resp: any) => void> = [];
    const api = {
      isRemote: true,
      onResourceInvalidate: () => {},
      subscribeResources: () => {},
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      fetchResourceDetail: (_resource: string) => new Promise<any>((resolve) => deferreds.push(resolve)),
    } as unknown as Transport;
    const store = useRemoteDetailsStore();
    store._resetForTest();
    store.init(api);
    store.addInterest("docker"); // fetch #1 (proactive on first interest)
    store.invalidateResources(["docker"]); // fetch #2 (ack-driven, newer)
    expect(deferreds.length).toBe(2);

    // Newer fetch #2 completes first with fresh data.
    deferreds[1]({ resource: "docker", revision: "new", data: { v: "new" } });
    await flush();
    expect(store.get("docker")).toEqual({ v: "new" });

    // Older fetch #1 completes late with stale data — the guard drops it.
    deferreds[0]({ resource: "docker", revision: "old", data: { v: "old" } });
    await flush();
    expect(store.get("docker")).toEqual({ v: "new" });
    expect(store.revisionOf("docker")).toBe("new");
  });

  it("invalidateResources refetches interested resources and ignores the rest (ack-driven)", async () => {
    const t = fakeTransport();
    const store = useRemoteDetailsStore();
    store._resetForTest();
    store.init(t.api);
    store.addInterest("docker");
    await flush();
    const before = t.fetched.length;

    // A resource we don't render is ignored (no wasted fetch).
    store.invalidateResources(["git:not-mounted"]);
    await flush();
    expect(t.fetched.length).toBe(before);

    // An interested resource refetches immediately (the mutation ack path).
    store.invalidateResources(["docker"]);
    await flush();
    expect(t.fetched.length).toBe(before + 1);
  });
});

describe("useResourceInterest composable", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it("follows the reactive key: moves interest on change, clears on scope dispose", async () => {
    const t = fakeTransport();
    const store = useRemoteDetailsStore();
    store._resetForTest();
    store.init(t.api);
    // Import lazily so the composable resolves the freshly-active pinia.
    const { useResourceInterest } = await import("../composables/useResourceInterest.js");
    const { useAppStore } = await import("./app.js");
    const appStore = useAppStore();
    appStore.isRemoteTransport = true;

    const key = ref<string | null>("azure-pr:pr1");
    const scope = effectScope();
    scope.run(() => useResourceInterest(() => key.value));
    expect(store.isInterested("azure-pr:pr1")).toBe(true);

    // Switching the key moves interest.
    key.value = "azure-pr:pr2";
    await flush();
    expect(store.isInterested("azure-pr:pr1")).toBe(false);
    expect(store.isInterested("azure-pr:pr2")).toBe(true);

    // Unmount (scope dispose) clears all interest for this owner.
    scope.stop();
    expect(store.isInterested("azure-pr:pr2")).toBe(false);
  });

  it("does nothing on the desktop transport", async () => {
    const t = fakeTransport();
    const store = useRemoteDetailsStore();
    store._resetForTest();
    store.init(t.api);
    const { useResourceInterest } = await import("../composables/useResourceInterest.js");
    const { useAppStore } = await import("./app.js");
    useAppStore().isRemoteTransport = false;
    const scope = effectScope();
    scope.run(() => useResourceInterest(() => "docker"));
    expect(store.isInterested("docker")).toBe(false);
    scope.stop();
  });
});
