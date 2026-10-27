import { describe, expect, it } from "vitest";
import {
  DEFAULT_GIT_SNAPSHOT_BUDGET_BYTES,
  enforceGitSnapshotBudget,
  type GitBudgetSnapshotCacheEntry,
} from "./git-cache-budget.js";

function detailed(workspaceId: string, size: number): Record<string, unknown> {
  return {
    workspaceId,
    projectId: workspaceId,
    rootPath: `/repos/${workspaceId}`,
    rootPaths: [`/repos/${workspaceId}`],
    available: true,
    branch: "feature/cache",
    upstream: "origin/feature/cache",
    aheadCount: 1,
    behindCount: 2,
    dirty: true,
    dirtyCount: 1,
    headOid: "a".repeat(40),
    dataRevision: "b".repeat(64),
    contentRevision: 3,
    physicalIdentityToken: "c".repeat(64),
    lastUpdatedAt: "2026-10-26T00:00:00.000Z",
    role: "must-not-retain",
    changedFiles: [{ path: "private/file.ts", diff: "x".repeat(size) }],
    diff: "x".repeat(size),
  };
}

describe("Git snapshot memory budget", () => {
  it("defaults to a 32 MiB budget", () => {
    expect(DEFAULT_GIT_SNAPSHOT_BUDGET_BYTES).toBe(32 * 1024 * 1024);
  });

  it("evicts inactive detail to bounded summaries and protects active workspace entries", () => {
    const activeKey = "active:/repos/active";
    const inactiveKey = "inactive:/repos/inactive";
    const active = detailed("active", 3_000);
    const inactive = detailed("inactive", 12_000);
    const snapshots = new Map([
      [activeKey, active],
      [inactiveKey, inactive],
    ]);
    const workspaceSnapshotCache = new Map<string, GitBudgetSnapshotCacheEntry>([
      [activeKey, { at: 200, snapshot: active }],
      [inactiveKey, { at: 100, snapshot: inactive }],
    ]);
    const physicalSnapshotCache = new Map<string, GitBudgetSnapshotCacheEntry>([
      ["physical-active|context", { at: 200, snapshot: active, physicalKey: "physical-active" }],
      ["physical-inactive|context", { at: 100, snapshot: inactive, physicalKey: "physical-inactive" }],
    ]);
    const workspacePhysicalKeys = new Map([
      [activeKey, "physical-active"],
      [inactiveKey, "physical-inactive"],
    ]);

    const report = enforceGitSnapshotBudget({
      snapshots,
      workspaceSnapshotCache,
      physicalSnapshotCache,
      workspacePhysicalKeys,
      protectedWorkspaceKeys: new Set([activeKey]),
      budgetBytes: 10_000,
    });

    expect(report.overBudget).toBe(false);
    expect(report.retainedBytes).toBeLessThanOrEqual(10_000);
    const retained = new Set<Record<string, unknown>>([
      ...snapshots.values(),
      ...[...workspaceSnapshotCache.values()].map((value) => value.snapshot),
      ...[...physicalSnapshotCache.values()].map((value) => value.snapshot),
    ]);
    expect(report.retainedBytes).toBe(
      [...retained].reduce((bytes, snapshot) => bytes + Buffer.byteLength(JSON.stringify(snapshot)), 0),
    );
    expect(report.evictedKeys).toContain(inactiveKey);
    expect(snapshots.get(activeKey)).toBe(active);
    expect(workspaceSnapshotCache.has(activeKey)).toBe(true);
    expect(physicalSnapshotCache.has("physical-active|context")).toBe(true);

    const inactiveSummary = snapshots.get(inactiveKey)!;
    expect(inactiveSummary).toMatchObject({
      summaryOnly: true,
      stale: true,
      verified: false,
      dirtyCount: 1,
      branch: "feature/cache",
      rootPaths: ["/repos/inactive"],
    });
    expect(inactiveSummary).not.toHaveProperty("changedFiles");
    expect(inactiveSummary).not.toHaveProperty("diff");
    expect(inactiveSummary).not.toHaveProperty("role");
    expect(workspaceSnapshotCache.has(inactiveKey)).toBe(false);
    expect(physicalSnapshotCache.has("physical-inactive|context")).toBe(false);
  });

  it("reports unavoidable over-budget active snapshots", () => {
    const key = "visible:/repo";
    const snapshot = detailed("visible", 4_000);
    const snapshots = new Map([[key, snapshot]]);
    const workspaceSnapshotCache = new Map([[key, { at: 1, snapshot }]]);
    const result = enforceGitSnapshotBudget({
      snapshots,
      workspaceSnapshotCache,
      physicalSnapshotCache: new Map(),
      workspacePhysicalKeys: new Map(),
      protectedWorkspaceKeys: new Set([key]),
      budgetBytes: 32,
    });
    expect(result.retainedBytes > 32).toBe(true);
    expect(result.overBudget).toBe(true);
    expect(snapshots.get(key)).toBe(snapshot);
  });

  it("evicts physical details with literal separators in checkout paths and review refs", () => {
    const key = "inactive";
    const physicalKey = "/repo|name\0/git|dir\0/common\0token";
    const cacheKey = `${physicalKey}|["review|context"]`;
    const snapshot = detailed(key, 8_000);
    const physicalSnapshotCache = new Map([[cacheKey, { at: 1, snapshot, physicalKey }]]);
    const report = enforceGitSnapshotBudget({
      snapshots: new Map([[key, snapshot]]),
      workspaceSnapshotCache: new Map([[key, { at: 1, snapshot }]]),
      physicalSnapshotCache,
      workspacePhysicalKeys: new Map([[key, physicalKey]]),
      protectedWorkspaceKeys: new Set(),
      budgetBytes: 2_000,
    });
    expect(report.overBudget).toBe(false);
    expect(physicalSnapshotCache.size).toBe(0);
  });
});
