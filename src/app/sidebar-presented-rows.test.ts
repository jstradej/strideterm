/**
 * V3 review, §2 — the live → presented projection behind the sidebar's
 * interaction lock, tested without a component or a clock.
 */
import { describe, expect, test } from "vitest";
import {
  mergeRecentRowWhileLocked,
  mergeRunningRowWhileLocked,
  projectPresentedForest,
} from "./sidebar-presented-rows.js";
import type { ActivityCluster, ActivityNode } from "./workspace-activity-tree.js";

describe("mergeRunningRowWhileLocked", () => {
  const frozen = {
    key: "ws-task:worker",
    hostWorkspaceId: "ws-task",
    viewId: "companion:ws-task",
    workspaceName: "Reviewer",
    ancestry: ["strideterm"],
    label: "Primary Claude",
    state: "running",
    startedAtMs: 1_000,
    pausedAtMs: 0,
    finishedAtMs: 0,
    totalPausedMs: 0,
    inGrid: false,
    source: "task" as string,
  };

  test("holds the navigation target, the identity and the ancestry of the same key", () => {
    const live = {
      ...frozen,
      // Everything a background update could move under the pointer.
      hostWorkspaceId: "ws-src",
      viewId: "ws-src:primary",
      workspaceName: "Source renamed",
      ancestry: [],
      label: "Something else",
      source: "session",
    };

    expect(mergeRunningRowWhileLocked(frozen, live)).toMatchObject({
      hostWorkspaceId: "ws-task",
      viewId: "companion:ws-task",
      workspaceName: "Reviewer",
      ancestry: ["strideterm"],
      label: "Primary Claude",
      source: "task",
    });
  });

  test("keeps taking the values that render in reserved, dimension-stable slots", () => {
    const live = {
      ...frozen,
      state: "judge-evaluating",
      startedAtMs: 2_000,
      pausedAtMs: 3_000,
      finishedAtMs: 4_000,
      totalPausedMs: 500,
      inGrid: true,
      gridSlotIndex: 2,
    };

    expect(mergeRunningRowWhileLocked(frozen, live)).toMatchObject({
      state: "judge-evaluating",
      startedAtMs: 2_000,
      pausedAtMs: 3_000,
      finishedAtMs: 4_000,
      totalPausedMs: 500,
      inGrid: true,
      gridSlotIndex: 2,
    });
  });
});

describe("mergeRecentRowWhileLocked", () => {
  const frozen = {
    workspaceId: "ws-child",
    name: "mobile",
    icon: "M",
    lastWorkedAt: "2026-08-29T11:00:00.000Z",
    lastWorkedAtMs: Date.parse("2026-08-29T11:00:00.000Z"),
    ancestors: [{ id: "ws-root", name: "strideterm", icon: "S", color: "#123", kind: "manual" }],
  };

  test("holds the identity and the ancestor model the row is announced by", () => {
    const live = {
      ...frozen,
      name: "renamed",
      icon: "X",
      ancestors: [{ id: "ws-other", name: "Other", icon: "O", color: "#456", kind: "manual" }],
    };

    expect(mergeRecentRowWhileLocked(frozen, live)).toMatchObject({
      workspaceId: "ws-child",
      name: "mobile",
      icon: "M",
      ancestors: frozen.ancestors,
    });
  });

  test("keeps taking a fresher timestamp — it renders in a fixed slot and never re-sorts", () => {
    const at = "2026-08-29T11:59:00.000Z";
    const merged = mergeRecentRowWhileLocked(frozen, { ...frozen, lastWorkedAt: at, lastWorkedAtMs: Date.parse(at) });

    expect(merged.lastWorkedAt).toBe(at);
    expect(merged.lastWorkedAtMs).toBe(Date.parse(at));
  });
});

/**
 * V5 review, §2 (last bullets) — the lock over a whole ACTIVITY FOREST.
 *
 * A key order could hold a flat list but not a tree: cluster membership, a
 * node's role, the parent-child edges and every navigation target are derived
 * from the live workspace list, so a background reparent could restructure the
 * section under the pointer with every individual key still present.
 */
describe("projectPresentedForest", () => {
  interface Payload {
    at: number;
  }

  function node(
    key: string,
    role: "activity" | "context",
    workspaceId: string,
    depth: number,
    payload?: Payload,
  ): ActivityNode<Payload> {
    return {
      key,
      role,
      workspaceId,
      name: workspaceId,
      icon: "",
      color: "",
      kind: "",
      depth,
      path: [workspaceId],
      pathIds: [workspaceId],
      fullPath: [workspaceId],
      payload,
    };
  }

  const FROZEN: ActivityCluster<Payload>[] = [
    {
      key: "root",
      metric: 10,
      nodes: [node("context:root", "context", "root", 0), node("leaf", "activity", "leaf", 1, { at: 1 })],
    },
  ];

  test("passes the live forest straight through when nothing is locked", () => {
    const presented = projectPresentedForest({
      live: FROZEN,
      lockedForest: null,
      isAlive: () => true,
    });

    expect(presented.map((c) => c.nodes.map((n) => [n.key, n.missing]))).toEqual([
      [
        ["context:root", false],
        ["leaf", false],
      ],
    ]);
  });

  test("renders the FROZEN structure while locked, whatever the live forest now looks like", () => {
    const live: ActivityCluster<Payload>[] = [
      { key: "other", metric: 99, nodes: [node("leaf", "activity", "leaf", 0, { at: 2 })] },
    ];

    const presented = projectPresentedForest({
      live,
      lockedForest: FROZEN,
      isAlive: () => true,
    });

    // Same cluster, same roles, same edges, same depths — the reparent waits.
    expect(presented).toHaveLength(1);
    expect(presented[0].key).toBe("root");
    expect(presented[0].nodes.map((n) => [n.key, n.role, n.depth])).toEqual([
      ["context:root", "context", 0],
      ["leaf", "activity", 1],
    ]);
  });

  test("still takes the live PAYLOAD for a key that is present in both", () => {
    const live: ActivityCluster<Payload>[] = [
      { key: "root", metric: 20, nodes: [node("leaf", "activity", "leaf", 0, { at: 2 })] },
    ];

    const presented = projectPresentedForest({
      live,
      lockedForest: FROZEN,
      isAlive: () => true,
      mergePayloadWhileLocked: (frozen, livePayload) => ({ ...frozen, at: livePayload.at }),
    });

    expect(presented[0].nodes[1].payload).toEqual({ at: 2 });
  });

  test("keeps the frozen payload for a key that has left the live forest", () => {
    const presented = projectPresentedForest({
      live: [],
      lockedForest: FROZEN,
      isAlive: () => true,
      mergePayloadWhileLocked: (frozen) => frozen,
    });

    expect(presented[0].nodes[1].payload).toEqual({ at: 1 });
    expect(presented[0].nodes[1].missing).toBe(false);
  });

  test("marks a node whose workspace was hard-deleted as missing — context rows included", () => {
    const presented = projectPresentedForest({
      live: [],
      lockedForest: FROZEN,
      isAlive: (n) => n.workspaceId !== "root" && n.workspaceId !== "leaf",
    });

    expect(presented[0].nodes.map((n) => n.missing)).toEqual([true, true]);
    // The rows are still there — the section holds its height until unlock.
    expect(presented[0].nodes).toHaveLength(2);
  });

  test("never inserts a cluster or a node that is not in the frozen forest", () => {
    const live: ActivityCluster<Payload>[] = [
      ...FROZEN,
      { key: "new", metric: 50, nodes: [node("new-leaf", "activity", "new-leaf", 0, { at: 3 })] },
    ];

    const presented = projectPresentedForest({ live, lockedForest: FROZEN, isAlive: () => true });

    expect(presented.map((c) => c.key)).toEqual(["root"]);
  });
});
