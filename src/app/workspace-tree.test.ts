/**
 * V2 plan, Fáze 4 — the hierarchy utilities, split out of the recent
 * projection so every consumer (star filter, search filter, selectors, the
 * recent shortcuts) agrees on one definition of "parent".
 */
import { describe, expect, it } from "vitest";
import { buildWorkspaceTree, resolveParentId } from "./workspace-tree.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyWs = any;

function ws(id: string, extra: Record<string, unknown> = {}): AnyWs {
  return { id, name: id, profileId: "p1", notes: "", ...extra };
}

describe("resolveParentId", () => {
  it("prefers an explicit managed-worktree review parent", () => {
    const child = ws("c", { review: { checkout: { mode: "managed-worktree" }, parentWorkspaceId: "p" } });
    expect(resolveParentId(child, [ws("p"), child])).toBe("p");
  });

  it("ignores a review parent when the checkout is not a managed worktree", () => {
    const child = ws("c", { review: { parentWorkspaceId: "p" } });
    expect(resolveParentId(child, [ws("p"), child])).toBeNull();
  });

  it("resolves quickfix and task parents", () => {
    expect(resolveParentId(ws("c", { quickfix: { parentWorkspaceId: "p" } }), [])).toBe("p");
    expect(resolveParentId(ws("c", { task: { parentWorkspaceId: "p" } }), [])).toBe("p");
  });

  it("falls back to the legacy 'Worktree of' name link, preferring the same profile", () => {
    const child = ws("c", { name: "Repo / feature", notes: "Worktree of Repo", profileId: "p2" });
    const sameProfile = ws("same", { name: "Repo", profileId: "p2" });
    const otherProfile = ws("other", { name: "Repo", profileId: "p1" });
    expect(resolveParentId(child, [otherProfile, sameProfile, child])).toBe("same");
  });

  it("returns the raw id even when it is not in the list — buildWorkspaceTree validates", () => {
    const child = ws("c", { task: { parentWorkspaceId: "foreign" } });
    expect(resolveParentId(child, [child])).toBe("foreign");
  });
});

describe("buildWorkspaceTree", () => {
  it("reports no ancestors for a root workspace", () => {
    const tree = buildWorkspaceTree([ws("a")]);
    expect(tree.parentOf("a")).toBeNull();
    expect(tree.ancestorsOf("a")).toEqual([]);
    expect(tree.depthOf("a")).toBe(0);
  });

  it("walks a multi-level chain root-first", () => {
    const tree = buildWorkspaceTree([
      ws("root", { name: "Root" }),
      ws("mid", { name: "Mid", quickfix: { parentWorkspaceId: "root" } }),
      ws("leaf", { name: "Leaf", task: { parentWorkspaceId: "mid" } }),
    ]);
    expect(tree.ancestorsOf("leaf")).toEqual(["root", "mid"]);
    expect(tree.depthOf("leaf")).toBe(2);
  });

  it("treats a parent that is missing from the list as no parent", () => {
    const tree = buildWorkspaceTree([ws("orphan", { task: { parentWorkspaceId: "gone" } })]);
    expect(tree.parentOf("orphan")).toBeNull();
    expect(tree.ancestorsOf("orphan")).toEqual([]);
  });

  it("never links across profiles, so no foreign workspace can leak into an ancestry", () => {
    const tree = buildWorkspaceTree([
      ws("foreign", { name: "Secret project", profileId: "p2" }),
      ws("child", { name: "Child", profileId: "p1", task: { parentWorkspaceId: "foreign" } }),
    ]);
    expect(tree.parentOf("child")).toBeNull();
    expect(tree.ancestorsOf("child")).toEqual([]);
  });

  it("drops a cyclic link instead of hanging, and both nodes become roots", () => {
    const tree = buildWorkspaceTree([
      ws("a", { task: { parentWorkspaceId: "b" } }),
      ws("b", { task: { parentWorkspaceId: "a" } }),
    ]);
    expect(tree.parentOf("a")).toBeNull();
    expect(tree.parentOf("b")).toBeNull();
    expect(tree.ancestorsOf("a")).toEqual([]);
    expect(tree.depthOf("b")).toBe(0);
  });

  it("drops a self-parent link", () => {
    const tree = buildWorkspaceTree([ws("a", { task: { parentWorkspaceId: "a" } })]);
    expect(tree.parentOf("a")).toBeNull();
  });

  it("keeps a valid chain that merely points at a node deeper in a cycle-free graph", () => {
    // b -> a, c -> b. Nothing loops, so all three links survive.
    const tree = buildWorkspaceTree([
      ws("a"),
      ws("b", { task: { parentWorkspaceId: "a" } }),
      ws("c", { task: { parentWorkspaceId: "b" } }),
    ]);
    expect(tree.ancestorsOf("c")).toEqual(["a", "b"]);
  });

  it("compares by canonical order first, then by id", () => {
    const tree = buildWorkspaceTree([ws("z"), ws("a"), ws("m")]);
    expect(tree.indexOf("z")).toBe(0);
    expect(tree.compare("z", "a")).toBeLessThan(0);
    expect(tree.compare("a", "m")).toBeLessThan(0);
    // Unknown ids sort last, and tie-break on the id itself.
    expect(tree.compare("unknown-b", "unknown-a")).toBeGreaterThan(0);
    expect(tree.indexOf("unknown-a")).toBe(-1);
  });
});
