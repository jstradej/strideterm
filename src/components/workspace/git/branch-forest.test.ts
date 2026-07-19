import { describe, expect, test } from "vitest";
import { buildBranchForest, type BranchForestLeaf } from "./branch-forest.js";

// Alphabetical-by-label comparator, matching what both consumers fall back to.
function byLabel(a: BranchForestLeaf<unknown>, b: BranchForestLeaf<unknown>): number {
  return a.label.localeCompare(b.label);
}

describe("buildBranchForest", () => {
  test("flat entries (no slashes) come back as leaves sorted by the comparator", () => {
    const forest = buildBranchForest(
      [
        { path: "zeta", ref: "zeta", payload: null },
        { path: "alpha", ref: "alpha", payload: null },
      ],
      "local",
      byLabel,
    );
    expect(forest.map((n) => n.label)).toEqual(["alpha", "zeta"]);
    expect(forest.every((n) => n.kind === "leaf")).toBe(true);
  });

  test("`/`-delimited paths nest under collapsible folders", () => {
    const forest = buildBranchForest(
      [
        { path: "feature/auth", ref: "feature/auth", payload: null },
        { path: "feature/ui/login", ref: "feature/ui/login", payload: null },
        { path: "main", ref: "main", payload: null },
      ],
      "local",
      byLabel,
    );
    // Folders sort before leaves at each level.
    expect(forest.map((n) => n.kind)).toEqual(["folder", "leaf"]);
    const featureFolder = forest[0];
    if (featureFolder.kind !== "folder") throw new Error("expected folder");
    expect(featureFolder.label).toBe("feature");
    expect(featureFolder.children.map((n) => n.label)).toEqual(["ui", "auth"]); // folder ("ui") before leaf ("auth")
    const uiFolder = featureFolder.children[0];
    if (uiFolder.kind !== "folder") throw new Error("expected nested folder");
    expect(uiFolder.children.map((n) => n.label)).toEqual(["login"]);
  });

  test("entries sharing a folder prefix collapse into a single folder node", () => {
    const forest = buildBranchForest(
      [
        { path: "feature/a", ref: "feature/a", payload: null },
        { path: "feature/b", ref: "feature/b", payload: null },
      ],
      "local",
      byLabel,
    );
    expect(forest).toHaveLength(1);
    const folder = forest[0];
    if (folder.kind !== "folder") throw new Error("expected folder");
    expect(folder.children.map((n) => n.label)).toEqual(["a", "b"]);
  });

  test("folder keys are derived from keyPrefix + accumulated path; leaf keys from keyPrefix + ref", () => {
    const forest = buildBranchForest(
      [{ path: "feature/auth", ref: "origin/feature/auth", payload: null }],
      "remote:origin",
      byLabel,
    );
    const folder = forest[0];
    if (folder.kind !== "folder") throw new Error("expected folder");
    expect(folder.key).toBe("remote:origin:dir:feature");
    const leaf = folder.children[0];
    expect(leaf.key).toBe("remote:origin:origin/feature/auth");
  });

  test("payload is carried through unmodified on the leaf", () => {
    const payload = { meta: { ahead: 3 } };
    const forest = buildBranchForest([{ path: "main", ref: "main", payload }], "local", byLabel);
    const leaf = forest[0];
    if (leaf.kind !== "leaf") throw new Error("expected leaf");
    expect(leaf.payload).toBe(payload);
  });

  test("entries with an empty path (after stripping slashes) are dropped", () => {
    const forest = buildBranchForest(
      [
        { path: "///", ref: "weird", payload: null },
        { path: "main", ref: "main", payload: null },
      ],
      "local",
      byLabel,
    );
    expect(forest.map((n) => n.label)).toEqual(["main"]);
  });

  test("compareLeaves controls leaf order independent of folder alpha-sort", () => {
    // Pin "main" to the top, everything else alphabetical — mirrors the
    // "current branch floats to top" / "default ref floats to top" callers.
    const forest = buildBranchForest(
      [
        { path: "zeta", ref: "zeta", payload: null },
        { path: "main", ref: "main", payload: null },
        { path: "alpha", ref: "alpha", payload: null },
      ],
      "local",
      (a, b) => {
        if (a.ref === "main" && b.ref !== "main") return -1;
        if (b.ref === "main" && a.ref !== "main") return 1;
        return a.label.localeCompare(b.label);
      },
    );
    expect(forest.map((n) => n.label)).toEqual(["main", "alpha", "zeta"]);
  });

  test("folders are always sorted alphabetically regardless of compareLeaves", () => {
    const forest = buildBranchForest(
      [
        { path: "zulu/x", ref: "zulu/x", payload: null },
        { path: "alpha/y", ref: "alpha/y", payload: null },
      ],
      "local",
      byLabel,
    );
    expect(forest.map((n) => n.label)).toEqual(["alpha", "zulu"]);
  });
});
