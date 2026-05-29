/// <reference types="node" />
import path from "node:path";
import { describe, expect, test } from "vitest";
import {
  STASH_PATCH_MARKER,
  composeStashPatch,
  parseStashPatch,
  extractDiffPaths,
  validatePatchPaths,
  suggestStashFilename,
} from "./git-stash-patch.js";

const SAMPLE_BODY = `diff --git a/src/foo.ts b/src/foo.ts
index 0000001..0000002 100644
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -1 +1 @@
-old
+new
`;

describe("git-stash-patch", () => {
  test("composeStashPatch emits the marker header followed by the diff body", () => {
    const patch = composeStashPatch(
      { baseCommit: "abc1234", branch: "master", message: "fix race", includesUntracked: true },
      SAMPLE_BODY,
    );
    expect(patch.startsWith(STASH_PATCH_MARKER)).toBe(true);
    expect(patch).toContain("# base: abc1234");
    expect(patch).toContain("# branch: master");
    expect(patch).toContain("# message: fix race");
    expect(patch).toContain("# includes-untracked: true");
    expect(patch).toContain("diff --git a/src/foo.ts b/src/foo.ts");
  });

  test("parseStashPatch round-trips the metadata", () => {
    const patch = composeStashPatch(
      { baseCommit: "deadbeef", branch: "feat/x", message: "experiment", includesUntracked: false },
      SAMPLE_BODY,
    );
    const parsed = parseStashPatch(patch);
    expect(parsed.hasHeader).toBe(true);
    expect(parsed.baseCommit).toBe("deadbeef");
    expect(parsed.branch).toBe("feat/x");
    expect(parsed.message).toBe("experiment");
    expect(parsed.includesUntracked).toBe(false);
  });

  test("parseStashPatch treats a header-less (foreign) patch as legacy", () => {
    const parsed = parseStashPatch(SAMPLE_BODY);
    expect(parsed.hasHeader).toBe(false);
    expect(parsed.message).toBe("");
  });

  test("extractDiffPaths returns every referenced file path", () => {
    const paths = extractDiffPaths(SAMPLE_BODY);
    expect(paths).toContain("src/foo.ts");
  });

  test("validatePatchPaths accepts in-repo paths", () => {
    const root = path.resolve("/tmp/repo");
    expect(validatePatchPaths(SAMPLE_BODY, root).ok).toBe(true);
  });

  test("validatePatchPaths rejects parent-directory traversal", () => {
    const bad = `diff --git a/../../etc/passwd b/../../etc/passwd\n--- a/../../etc/passwd\n+++ b/../../etc/passwd\n`;
    const res = validatePatchPaths(bad, path.resolve("/tmp/repo"));
    expect(res.ok).toBe(false);
    expect(res.badPath).toContain("..");
  });

  test("validatePatchPaths rejects absolute paths", () => {
    const bad = `diff --git a//etc/shadow b//etc/shadow\n`;
    const res = validatePatchPaths(bad, path.resolve("/tmp/repo"));
    expect(res.ok).toBe(false);
  });

  test("suggestStashFilename slugifies the custom message", () => {
    const name = suggestStashFilename({ index: 0, branch: "master", customMessage: "WIP: fix race!", date: "" });
    expect(name).toBe("wip-fix-race.patch");
  });

  test("suggestStashFilename falls back to index/branch/date when no message", () => {
    const name = suggestStashFilename({
      index: 2,
      branch: "feat/x",
      customMessage: "",
      date: "2026-05-28T17:14:00.000Z",
    });
    expect(name).toBe("stash-2-feat-x-20260528.patch");
  });
});
