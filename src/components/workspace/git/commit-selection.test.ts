import { describe, expect, test } from "vitest";
import { buildCommitSelection } from "./commit-selection.js";

describe("buildCommitSelection", () => {
  test("a plain modification carries no previousPaths", () => {
    const files = [{ path: "a.txt", previousPath: "", stagedStatus: "M", unstagedStatus: "." }];
    expect(buildCommitSelection(files, new Set(["a.txt"]))).toEqual({ paths: ["a.txt"], previousPaths: [] });
  });

  test("a staged rename contributes its old name as the delete side", () => {
    const files = [{ path: "new.txt", previousPath: "old.txt", stagedStatus: "R", unstagedStatus: "." }];
    expect(buildCommitSelection(files, new Set(["new.txt"]))).toEqual({
      paths: ["new.txt"],
      previousPaths: ["old.txt"],
    });
  });

  test("a working-tree (unstaged) rename also contributes its old name", () => {
    const files = [{ path: "new.txt", previousPath: "old.txt", stagedStatus: ".", unstagedStatus: "R" }];
    expect(buildCommitSelection(files, new Set(["new.txt"]))).toEqual({
      paths: ["new.txt"],
      previousPaths: ["old.txt"],
    });
  });

  test("a copy (status.renames=copies) does NOT remove its source", () => {
    // A `C` entry carries previousPath just like `R`, but committing it as a
    // rename would delete the original file — the source must survive.
    const files = [{ path: "copy.txt", previousPath: "orig.txt", stagedStatus: "C", unstagedStatus: "." }];
    expect(buildCommitSelection(files, new Set(["copy.txt"]))).toEqual({
      paths: ["copy.txt"],
      previousPaths: [],
    });
  });

  test("previousPath is ignored when the rename target is not checked", () => {
    const files = [{ path: "new.txt", previousPath: "old.txt", stagedStatus: "R", unstagedStatus: "." }];
    expect(buildCommitSelection(files, new Set(["other.txt"]))).toEqual({
      paths: ["other.txt"],
      previousPaths: [],
    });
  });

  test("entries without a previousPath (untracked, conflicts) are skipped", () => {
    const files = [
      { path: "u.txt", previousPath: "", stagedStatus: "?", unstagedStatus: "?" },
      { path: "c.txt", stagedStatus: undefined, unstagedStatus: undefined }, // conflict shape: no previousPath
    ];
    expect(buildCommitSelection(files, new Set(["u.txt", "c.txt"]))).toEqual({
      paths: ["u.txt", "c.txt"],
      previousPaths: [],
    });
  });
});
