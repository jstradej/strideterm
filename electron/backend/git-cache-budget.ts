export interface GitBudgetSnapshotCacheEntry {
  at: number;
  snapshot: Record<string, unknown>;
  physicalKey?: string;
}

export interface GitSnapshotBudgetInput {
  snapshots: Map<string, Record<string, unknown>>;
  workspaceSnapshotCache: Map<string, GitBudgetSnapshotCacheEntry>;
  physicalSnapshotCache: Map<string, GitBudgetSnapshotCacheEntry>;
  protectedWorkspaceKeys: ReadonlySet<string>;
  workspacePhysicalKeys: ReadonlyMap<string, string>;
  budgetBytes?: number;
}

export interface GitSnapshotBudgetResult {
  retainedBytes: number;
  overBudget: boolean;
  evictedKeys: string[];
}

export const DEFAULT_GIT_SNAPSHOT_BUDGET_BYTES = 32 * 1024 * 1024;
const SUMMARY_KEYS = [
  "workspaceId",
  "projectId",
  "rootPath",
  "rootPaths",
  "primaryRoot",
  "cwd",
  "available",
  "branch",
  "upstream",
  "aheadCount",
  "behindCount",
  "dirty",
  "dirtyCount",
  "headOid",
  "dataRevision",
  "contentRevision",
  "physicalIdentityToken",
  "lastUpdatedAt",
] as const;

export function enforceGitSnapshotBudget(input: GitSnapshotBudgetInput): GitSnapshotBudgetResult {
  const budget = Math.max(0, input.budgetBytes ?? DEFAULT_GIT_SNAPSHOT_BUDGET_BYTES);
  const evictedKeys: string[] = [];
  const refs = new Map<Record<string, unknown>, { count: number; bytes: number }>();
  let retainedBytes = 0;
  const retain = (snapshot: Record<string, unknown> | undefined) => {
    if (!snapshot) return;
    const prior = refs.get(snapshot);
    if (prior) {
      prior.count++;
      return;
    }
    const bytes = measureOne(snapshot);
    refs.set(snapshot, { count: 1, bytes });
    retainedBytes += bytes;
  };
  const release = (snapshot: Record<string, unknown> | undefined) => {
    if (!snapshot) return;
    const prior = refs.get(snapshot);
    if (!prior) return;
    if (--prior.count === 0) {
      refs.delete(snapshot);
      retainedBytes -= prior.bytes;
    }
  };
  const setSnapshot = (map: Map<string, Record<string, unknown>>, key: string, value: Record<string, unknown>) => {
    const previous = map.get(key);
    if (previous === value) return;
    release(previous);
    map.set(key, value);
    retain(value);
  };
  const deleteCacheEntry = (map: Map<string, GitBudgetSnapshotCacheEntry>, key: string) => {
    const previous = map.get(key);
    if (!previous) return;
    map.delete(key);
    release(previous.snapshot);
  };
  for (const snapshot of input.snapshots.values()) retain(snapshot);
  for (const value of input.workspaceSnapshotCache.values()) retain(value.snapshot);
  for (const value of input.physicalSnapshotCache.values()) retain(value.snapshot);
  if (retainedBytes <= budget) return { retainedBytes, overBudget: false, evictedKeys };

  const keys = new Set([
    ...input.snapshots.keys(),
    ...input.workspaceSnapshotCache.keys(),
    ...input.workspacePhysicalKeys.keys(),
  ]);
  const candidates = [...keys]
    .filter((key) => !input.protectedWorkspaceKeys.has(key))
    .map((key) => ({ key, at: input.workspaceSnapshotCache.get(key)?.at ?? 0 }))
    .sort((a, b) => a.at - b.at || a.key.localeCompare(b.key));
  const protectedPhysicalKeys = new Set(
    [...input.protectedWorkspaceKeys]
      .map((key) => input.workspacePhysicalKeys.get(key))
      .filter((key): key is string => Boolean(key)),
  );
  const physicalCacheKeys = new Map<string, string[]>();
  for (const [cacheKey, entry] of input.physicalSnapshotCache) {
    const physicalKey = entry.physicalKey ?? cacheKey;
    const keysForPhysical = physicalCacheKeys.get(physicalKey) ?? [];
    keysForPhysical.push(cacheKey);
    physicalCacheKeys.set(physicalKey, keysForPhysical);
  }

  for (const { key } of candidates) {
    const current = input.snapshots.get(key) ?? input.workspaceSnapshotCache.get(key)?.snapshot;
    if (current) {
      const summary = summarize(current);
      setSnapshot(input.snapshots, key, summary);
      deleteCacheEntry(input.workspaceSnapshotCache, key);
    } else {
      deleteCacheEntry(input.workspaceSnapshotCache, key);
    }

    const physicalKey = input.workspacePhysicalKeys.get(key);
    if (physicalKey) {
      const protectedPhysical = protectedPhysicalKeys.has(physicalKey);
      if (!protectedPhysical) {
        for (const cacheKey of physicalCacheKeys.get(physicalKey) ?? [])
          deleteCacheEntry(input.physicalSnapshotCache, cacheKey);
      }
    }

    evictedKeys.push(key);
    if (retainedBytes <= budget) break;
  }

  return { retainedBytes, overBudget: retainedBytes > budget, evictedKeys };
}

function summarize(snapshot: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const key of SUMMARY_KEYS) {
    const value = snapshot[key];
    if (key === "rootPaths" && Array.isArray(value)) {
      result[key] = value.filter((item): item is string => typeof item === "string").slice(0, 64);
    } else if (value === null || ["string", "number", "boolean"].includes(typeof value)) {
      result[key] = value;
    }
  }
  result.summaryOnly = true;
  result.stale = true;
  result.verified = false;
  return result;
}

function measureOne(value: Record<string, unknown>): number {
  try {
    return Buffer.byteLength(JSON.stringify(value));
  } catch {
    return Number.MAX_SAFE_INTEGER;
  }
}
