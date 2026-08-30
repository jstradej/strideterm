import { describe, expect, it } from "vitest";
import { activityNodesOf, buildActivityForest, type ActivitySelection } from "./workspace-activity-tree.js";

/**
 * V5 review, §"1. Recent bude minimální activity forest" and the test matrix
 * under §"Recent activity forest a deduplikace".
 *
 * The contract this pins down: the caller's selection is authoritative and is
 * never widened or narrowed here; the ancestor closure is added on top of it;
 * connected members merge into one cluster; and no workspace — activity or
 * context — is ever drawn twice inside a cluster.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyApi = any;

function ws(id: string, overrides: AnyApi = {}): AnyApi {
  return { id, name: id, icon: id[0].toUpperCase(), color: "#fff", profileId: "default", ...overrides };
}

/** A child linked through the quickfix marker — one of the real parent links. */
function child(id: string, parentId: string, overrides: AnyApi = {}): AnyApi {
  return ws(id, { quickfix: { parentWorkspaceId: parentId }, ...overrides });
}

function pick(ids: string[], metrics?: Record<string, number>): ActivitySelection<string>[] {
  return ids.map((id, i) => ({
    key: id,
    workspaceId: id,
    metric: metrics?.[id] ?? ids.length - i,
    payload: id,
  }));
}

function shape(clusters: ReturnType<typeof buildActivityForest<string>>): string[][] {
  return clusters.map((cluster) =>
    cluster.nodes.map((node) => `${node.role === "context" ? "·" : ""}${node.depth}:${node.path.join(" › ")}`),
  );
}

describe("buildActivityForest — roles and deduplication", () => {
  it("a root selection is one activity node with no context above it", () => {
    const clusters = buildActivityForest({ selected: pick(["a"]), workspaces: [ws("a")] });

    expect(shape(clusters)).toEqual([["0:a"]]);
    expect(clusters[0].nodes[0].role).toBe("activity");
    expect(clusters[0].nodes[0].payload).toBe("a");
  });

  it("adds the ancestor closure as CONTEXT nodes, which carry no payload", () => {
    const workspaces = [ws("root"), child("leaf", "root")];
    const clusters = buildActivityForest({ selected: pick(["leaf"]), workspaces });

    expect(shape(clusters)).toEqual([["·0:root", "1:leaf"]]);
    expect(clusters[0].nodes[0].payload).toBeUndefined();
    expect(clusters[0].nodes[1].payload).toBe("leaf");
  });

  // The screenshot case: `Azure DevOps → mhub PR #30746 → pr-30746`, where the
  // PR and its task are both recent.
  it("a parent and its child that are BOTH selected make one cluster, each drawn once", () => {
    const workspaces = [ws("azure"), child("pr", "azure"), child("task", "pr")];
    const clusters = buildActivityForest({ selected: pick(["task", "pr"]), workspaces });

    expect(clusters).toHaveLength(1);
    expect(shape(clusters)).toEqual([["·0:azure", "1:pr", "2:task"]]);
    // No identity repeats anywhere in the cluster.
    const ids = clusters[0].nodes.flatMap((node) => node.pathIds);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("a selected ancestor becomes an activity node instead of gaining a context copy", () => {
    const workspaces = [ws("root"), child("leaf", "root")];
    const clusters = buildActivityForest({ selected: pick(["leaf", "root"]), workspaces });

    expect(shape(clusters)).toEqual([["0:root", "1:leaf"]]);
    expect(clusters[0].nodes.map((n) => n.role)).toEqual(["activity", "activity"]);
  });

  it("unrelated branches make separate clusters", () => {
    const workspaces = [ws("p1"), child("c1", "p1"), ws("p2"), child("c2", "p2")];
    const clusters = buildActivityForest({
      selected: pick(["c1", "c2"], { c1: 2, c2: 1 }),
      workspaces,
    });

    expect(shape(clusters)).toEqual([
      ["·0:p1", "1:c1"],
      ["·0:p2", "1:c2"],
    ]);
  });

  it("two activities in ONE workspace stay two sibling rows", () => {
    const selected: ActivitySelection<string>[] = [
      { key: "ws:worker", workspaceId: "ws", metric: 2, payload: "worker" },
      { key: "ws:other", workspaceId: "ws", metric: 1, payload: "other" },
    ];
    const clusters = buildActivityForest({ selected, workspaces: [ws("ws")] });

    expect(clusters[0].nodes.map((n) => [n.key, n.depth])).toEqual([
      ["ws:worker", 0],
      ["ws:other", 0],
    ]);
  });
});

describe("buildActivityForest — ordering", () => {
  it("orders clusters by the newest activity anywhere inside them", () => {
    const workspaces = [ws("old-root"), child("old-leaf", "old-root"), ws("fresh")];
    const clusters = buildActivityForest({
      selected: pick(["old-leaf", "fresh"], { "old-leaf": 10, fresh: 5 }),
      workspaces,
    });

    expect(clusters.map((c) => c.key)).toEqual(["old-root", "fresh"]);
    expect(clusters[0].metric).toBe(10);
  });

  it("puts the parent before its child inside a cluster, whatever their own metrics say", () => {
    const workspaces = [ws("root"), child("leaf", "root")];
    const clusters = buildActivityForest({
      selected: pick(["leaf", "root"], { leaf: 100, root: 1 }),
      workspaces,
    });

    expect(clusters[0].nodes.map((n) => n.workspaceId)).toEqual(["root", "leaf"]);
  });

  it("orders sibling branches by their own newest activity", () => {
    const workspaces = [ws("root"), child("older", "root"), child("newer", "root")];
    const clusters = buildActivityForest({
      selected: pick(["older", "newer"], { older: 1, newer: 9 }),
      workspaces,
    });

    expect(clusters[0].nodes.map((n) => n.workspaceId)).toEqual(["root", "newer", "older"]);
  });

  it("falls back to the canonical workspace order for equal metrics", () => {
    // `b` comes first in the canonical list, so it wins the tie both times.
    const workspaces = [ws("root"), child("b", "root"), child("a", "root")];
    const clusters = buildActivityForest({
      selected: pick(["a", "b"], { a: 5, b: 5 }),
      workspaces,
    });

    expect(clusters[0].nodes.map((n) => n.workspaceId)).toEqual(["root", "b", "a"]);
  });
});

describe("buildActivityForest — breadcrumb compression", () => {
  it("collapses an unbranched context-only chain into ONE row that targets its tail", () => {
    const workspaces = [ws("a"), child("b", "a"), child("c", "b"), child("leaf", "c")];
    const clusters = buildActivityForest({ selected: pick(["leaf"]), workspaces });

    expect(shape(clusters)).toEqual([["·0:a › b › c", "1:leaf"]]);
    // The click target is the NEAREST parent of the activity, not the top.
    expect(clusters[0].nodes[0].workspaceId).toBe("c");
    expect(clusters[0].nodes[0].pathIds).toEqual(["a", "b", "c"]);
  });

  it("never compresses an activity node into a breadcrumb", () => {
    const workspaces = [ws("a"), child("b", "a"), child("leaf", "b")];
    const clusters = buildActivityForest({ selected: pick(["leaf", "b"]), workspaces });

    expect(shape(clusters)).toEqual([["·0:a", "1:b", "2:leaf"]]);
  });

  it("never compresses a BRANCHING context node", () => {
    const workspaces = [ws("a"), child("b", "a"), child("x", "b"), child("y", "b")];
    const clusters = buildActivityForest({ selected: pick(["x", "y"], { x: 2, y: 1 }), workspaces });

    // `b` branches, so it keeps its own row instead of joining `a`'s crumb.
    expect(shape(clusters)).toEqual([["·0:a", "·1:b", "2:x", "2:y"]]);
  });

  it("keeps the whole chain in `fullPath`, so two same-named rows are still distinct", () => {
    const workspaces = [
      ws("r1", { name: "Repo" }),
      child("m1", "r1", { name: "main" }),
      child("l1", "m1", { name: "leaf" }),
      ws("r2", { name: "Other repo" }),
      child("m2", "r2", { name: "main" }),
      child("l2", "m2", { name: "leaf" }),
    ];
    const clusters = buildActivityForest({ selected: pick(["l1", "l2"], { l1: 2, l2: 1 }), workspaces });

    expect(clusters.map((c) => c.nodes.map((n) => n.fullPath.join(" › ")))).toEqual([
      ["Repo › main", "Repo › main › leaf"],
      ["Other repo › main", "Other repo › main › leaf"],
    ]);
  });
});

describe("buildActivityForest — guards", () => {
  it("a missing parent makes a root, not an orphan cluster", () => {
    const clusters = buildActivityForest({
      selected: pick(["orphan"]),
      workspaces: [child("orphan", "gone")],
    });

    expect(shape(clusters)).toEqual([["0:orphan"]]);
  });

  it("a cycle cannot produce an infinite cluster", () => {
    const workspaces = [child("a", "b"), child("b", "a")];
    const clusters = buildActivityForest({ selected: pick(["a", "b"], { a: 2, b: 1 }), workspaces });

    expect(
      activityNodesOf(clusters)
        .map((n) => n.workspaceId)
        .sort(),
    ).toEqual(["a", "b"]);
    expect(clusters.every((c) => c.nodes.length <= 2)).toBe(true);
  });

  it("a cross-profile parent never appears as context", () => {
    const workspaces = [ws("secret", { name: "Secret", profileId: "p2" }), child("mine", "secret")];
    const clusters = buildActivityForest({ selected: pick(["mine"]), workspaces });

    expect(shape(clusters)).toEqual([["0:mine"]]);
  });

  it("a selection whose workspace does not exist is dropped rather than hung nowhere", () => {
    const clusters = buildActivityForest({ selected: pick(["ghost", "a"]), workspaces: [ws("a")] });

    expect(shape(clusters)).toEqual([["0:a"]]);
  });

  it("an empty selection is an empty forest — no context is invented", () => {
    expect(buildActivityForest({ selected: [], workspaces: [ws("a"), child("b", "a")] })).toEqual([]);
  });
});

describe("buildActivityForest — the caller's limit is spent on activities only", () => {
  it("seven selections stay seven activity nodes however much context they need", () => {
    const workspaces = Array.from({ length: 7 }, (_, i) => [ws(`p${i}`), child(`c${i}`, `p${i}`)]).flat();
    const clusters = buildActivityForest({
      selected: pick(Array.from({ length: 7 }, (_, i) => `c${i}`)),
      workspaces,
    });

    expect(activityNodesOf(clusters)).toHaveLength(7);
    // Seven context rows came along for orientation and cost no slot.
    expect(clusters.flatMap((c) => c.nodes).filter((n) => n.role === "context")).toHaveLength(7);
  });
});
