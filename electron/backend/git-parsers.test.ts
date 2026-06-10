import { describe, expect, test } from "vitest";
import {
  parseLsFilesUntracked,
  buildOperationState,
  resolveContinueArgs,
  resolveAbortArgs,
  resolveSkipArgs,
} from "./git-parsers.js";

describe("parseLsFilesUntracked", () => {
  test("parses both-modified conflict", () => {
    const raw = ["100644 abc123 1\tsrc/app.py", "100644 def456 2\tsrc/app.py", "100644 ghi789 3\tsrc/app.py"].join(
      "\n",
    );
    const result = parseLsFilesUntracked(raw);
    expect(result).toHaveLength(1);
    expect(result[0].path).toBe("src/app.py");
    expect(result[0].conflictType).toBe("both-modified");
    expect(result[0].stages).toEqual([1, 2, 3]);
  });

  test("parses both-added conflict (no base stage)", () => {
    const raw = ["100644 def456 2\tsrc/new.py", "100644 ghi789 3\tsrc/new.py"].join("\n");
    const result = parseLsFilesUntracked(raw);
    expect(result).toHaveLength(1);
    expect(result[0].conflictType).toBe("both-added");
    expect(result[0].stages).toEqual([2, 3]);
  });

  test("parses deleted-by-us (stage 1 and 3, no stage 2)", () => {
    const raw = ["100644 abc123 1\tsrc/gone.py", "100644 ghi789 3\tsrc/gone.py"].join("\n");
    const result = parseLsFilesUntracked(raw);
    expect(result).toHaveLength(1);
    expect(result[0].conflictType).toBe("deleted-by-us");
  });

  test("parses deleted-by-them (stage 1 and 2, no stage 3)", () => {
    const raw = ["100644 abc123 1\tsrc/theirs.py", "100644 def456 2\tsrc/theirs.py"].join("\n");
    const result = parseLsFilesUntracked(raw);
    expect(result).toHaveLength(1);
    expect(result[0].conflictType).toBe("deleted-by-them");
  });

  test("handles multiple files", () => {
    const raw = [
      "100644 a 1\tapp.py",
      "100644 b 2\tapp.py",
      "100644 c 3\tapp.py",
      "100644 d 1\tutil.py",
      "100644 e 2\tutil.py",
      "100644 f 3\tutil.py",
    ].join("\n");
    const result = parseLsFilesUntracked(raw);
    expect(result).toHaveLength(2);
    expect(result.map((e) => e.path)).toContain("app.py");
    expect(result.map((e) => e.path)).toContain("util.py");
  });

  test("handles empty input", () => {
    expect(parseLsFilesUntracked("")).toEqual([]);
    expect(parseLsFilesUntracked("   \n  \n")).toEqual([]);
  });

  test("ignores lines without tab separator", () => {
    const raw = "100644 abc123 1 src/nontab.py";
    expect(parseLsFilesUntracked(raw)).toEqual([]);
  });
});

describe("buildOperationState", () => {
  test("returns idle state for empty kind", () => {
    const state = buildOperationState({});
    expect(state.inProgress).toBe(false);
    expect(state.kind).toBe("idle");
    expect(state.canSkip).toBe(false);
    expect(state.progress).toBeNull();
    expect(state.currentCommit).toBeNull();
    expect(state.sides).toBeNull();
  });

  test("builds rebase state with metadata", () => {
    const state = buildOperationState({
      kind: "rebase",
      conflicts: ["a.py"],
      progress: { current: 2, total: 5 },
      currentCommit: { sha: "abc1234", subject: "feat: add greet" },
      sides: { ours: "main", theirs: "feature/x" },
    });
    expect(state.kind).toBe("rebase");
    expect(state.inProgress).toBe(true);
    expect(state.canContinue).toBe(true);
    expect(state.canSkip).toBe(true);
    expect(state.progress).toEqual({ current: 2, total: 5 });
    expect(state.currentCommit).toEqual({ sha: "abc1234", subject: "feat: add greet" });
    expect(state.sides).toEqual({ ours: "main", theirs: "feature/x" });
  });

  test("builds merge state without skip", () => {
    const state = buildOperationState({ kind: "merge", conflicts: ["b.py"] });
    expect(state.canSkip).toBe(false);
    expect(state.canContinue).toBe(true);
    expect(state.canAbort).toBe(true);
  });

  test("builds cherry-pick state with skip", () => {
    const state = buildOperationState({ kind: "cherry-pick" });
    expect(state.canSkip).toBe(true);
  });

  test("bisect cannot continue", () => {
    const state = buildOperationState({ kind: "bisect" });
    expect(state.canContinue).toBe(false);
    expect(state.canSkip).toBe(false);
  });
});

describe("resolveSkipArgs", () => {
  test("rebase skip returns correct args", () => {
    expect(resolveSkipArgs("rebase")).toEqual(["rebase", "--skip"]);
  });

  test("cherry-pick skip returns correct args", () => {
    expect(resolveSkipArgs("cherry-pick")).toEqual(["cherry-pick", "--skip"]);
  });

  test("merge does not support skip", () => {
    expect(resolveSkipArgs("merge")).toBeNull();
  });

  test("bisect does not support skip", () => {
    expect(resolveSkipArgs("bisect")).toBeNull();
  });
});

describe("resolveContinueArgs and resolveAbortArgs still work", () => {
  test("continue args unchanged", () => {
    expect(resolveContinueArgs("merge")).toEqual(["merge", "--continue"]);
    expect(resolveContinueArgs("rebase")).toEqual(["rebase", "--continue"]);
    expect(resolveContinueArgs("cherry-pick")).toEqual(["cherry-pick", "--continue"]);
  });

  test("abort args unchanged", () => {
    expect(resolveAbortArgs("merge")).toEqual(["merge", "--abort"]);
    expect(resolveAbortArgs("rebase")).toEqual(["rebase", "--abort"]);
  });
});
