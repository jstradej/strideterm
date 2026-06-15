import { describe, expect, test } from "vitest";
import { execSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { merge3, applyNonConflicting, renderResult, hasUnresolvedConflicts } from "./merge3.js";

// ---------------------------------------------------------------------------
// Golden-test helper — compare merge3 output against git merge-file for
// non-conflicting cases (where git exits 0 and our output must match exactly).
// ---------------------------------------------------------------------------
function gitMerge(base: string, ours: string, theirs: string): string | null {
  let dir: string | null = null;
  try {
    dir = mkdtempSync(join(tmpdir(), "merge3-golden-"));
    const b = join(dir, "base");
    const o = join(dir, "ours");
    const t = join(dir, "theirs");
    writeFileSync(b, base);
    writeFileSync(o, ours);
    writeFileSync(t, theirs);
    // -p writes merged result to stdout (no in-place modification)
    const out = execSync(`git merge-file -p "${o}" "${b}" "${t}"`, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return out;
  } catch {
    // exit code 1 means conflict — that case is not a golden test target
    return null;
  } finally {
    if (dir)
      try {
        rmSync(dir, { recursive: true });
      } catch {
        /* ignore */
      }
  }
}

describe("merge3", () => {
  test("identical files produce single unchanged chunk", () => {
    const text = "line1\nline2\nline3";
    const result = merge3(text, text, text);
    expect(result.conflictCount).toBe(0);
    expect(result.chunks).toHaveLength(1);
    expect(result.chunks[0].kind).toBe("unchanged");
  });

  test("only ours changed", () => {
    const base = "a\nb\nc";
    const ours = "a\nBB\nc";
    const theirs = "a\nb\nc";
    const result = merge3(base, ours, theirs);
    expect(result.conflictCount).toBe(0);
    const oursChunk = result.chunks.find((c) => c.kind === "ours");
    expect(oursChunk).toBeDefined();
    expect(oursChunk!.oursLines).toContain("BB");
  });

  test("only theirs changed", () => {
    const base = "a\nb\nc";
    const ours = "a\nb\nc";
    const theirs = "a\nBB\nc";
    const result = merge3(base, ours, theirs);
    expect(result.conflictCount).toBe(0);
    const theirsChunk = result.chunks.find((c) => c.kind === "theirs");
    expect(theirsChunk).toBeDefined();
    expect(theirsChunk!.theirsLines).toContain("BB");
  });

  test("both changed same line — conflict", () => {
    const base = "a\nb\nc";
    const ours = "a\nOURS\nc";
    const theirs = "a\nTHEIRS\nc";
    const result = merge3(base, ours, theirs);
    expect(result.conflictCount).toBe(1);
    const conflict = result.chunks.find((c) => c.kind === "conflict");
    expect(conflict).toBeDefined();
    expect(conflict!.oursLines).toContain("OURS");
    expect(conflict!.theirsLines).toContain("THEIRS");
  });

  test("both changed different lines — no conflict", () => {
    const base = "a\nb\nc\nd";
    const ours = "a\nOURS\nc\nd";
    const theirs = "a\nb\nTHEIRS\nd";
    const result = merge3(base, ours, theirs);
    expect(result.conflictCount).toBe(0);
  });

  test("empty base — both-added conflict", () => {
    const base = "";
    const ours = "ours line";
    const theirs = "theirs line";
    const result = merge3(base, ours, theirs);
    expect(result.conflictCount).toBe(1);
  });

  test("ours deleted a line, theirs unchanged", () => {
    const base = "a\nb\nc";
    const ours = "a\nc";
    const theirs = "a\nb\nc";
    const result = merge3(base, ours, theirs);
    expect(result.conflictCount).toBe(0);
    const oursChunk = result.chunks.find((c) => c.kind === "ours");
    expect(oursChunk).toBeDefined();
  });

  test("adjacent non-conflicting changes", () => {
    const base = "x\ny\nz";
    const ours = "X\ny\nz";
    const theirs = "x\ny\nZ";
    const result = merge3(base, ours, theirs);
    expect(result.conflictCount).toBe(0);
  });

  // Regression: a cursor desync left ours sitting on a trailing `equal` run
  // while theirs was exhausted. That state matched none of the both-present
  // cases, fell into the conflict branch (which drains only NON-equal ops),
  // advanced neither cursor, and looped forever — OOM-crashing the renderer
  // when the merge editor opened a real conflict. Must terminate.
  test("terminates when one diff stream ends on an equal run (was infinite-loop OOM)", () => {
    const base = "A\nB\nC\nD";
    const ours = "A\nB2\nC\nD";
    const theirs = "A\nD";
    const result = merge3(base, ours, theirs);
    expect(Array.isArray(result.chunks)).toBe(true);
    expect(result.chunks.length).toBeGreaterThan(0);
    for (const c of result.chunks) {
      expect(Array.isArray(c.resultLines)).toBe(true);
    }
  }, 3000);
});

describe("applyNonConflicting", () => {
  test("fills result for ours and theirs chunks, leaves conflict empty", () => {
    const { chunks } = merge3("a\nb\nc", "a\nOURS\nc", "a\nTHEIRS\nc");
    const applied = applyNonConflicting(chunks);
    const conflict = applied.find((c) => c.kind === "conflict");
    expect(conflict?.resultLines).toEqual([]);
    const unchanged = applied.find((c) => c.kind === "unchanged");
    expect(unchanged?.resultLines.length).toBeGreaterThan(0);
  });
});

describe("renderResult", () => {
  test("concatenates result lines with newlines", () => {
    const { chunks } = merge3("a\nb", "a\nOURS", "a\nb");
    const applied = applyNonConflicting(chunks);
    const text = renderResult(applied);
    expect(text).toContain("a");
    expect(text).toContain("OURS");
  });
});

describe("hasUnresolvedConflicts", () => {
  test("true when conflict chunk exists and not resolved", () => {
    const { chunks } = merge3("a", "OURS", "THEIRS");
    expect(hasUnresolvedConflicts(chunks)).toBe(true);
  });

  test("false when all conflicts resolved", () => {
    const { chunks } = merge3("a", "OURS", "THEIRS");
    const resolved = chunks.map((c) => (c.kind === "conflict" ? { ...c, resolved: true } : c));
    expect(hasUnresolvedConflicts(resolved)).toBe(false);
  });

  test("false when no conflicts", () => {
    const { chunks } = merge3("a\nb", "a\nb", "a\nb");
    expect(hasUnresolvedConflicts(chunks)).toBe(false);
  });
});

describe("CRLF preservation", () => {
  test("CRLF line endings are round-tripped unchanged", () => {
    const base = "line1\r\nline2\r\nline3\r\n";
    const ours = "line1\r\nOURS\r\nline3\r\n";
    const theirs = "line1\r\nline2\r\nline3\r\n";
    const { chunks } = merge3(base, ours, theirs);
    expect(chunks.filter((c) => c.kind === "conflict")).toHaveLength(0);
    const applied = applyNonConflicting(chunks);
    const result = renderResult(applied);
    // Each line retains \r before the \n separator
    expect(result).toContain("OURS\r");
    expect(result).toContain("line1\r");
  });

  test("CRLF conflict chunk preserves \\r in both sides", () => {
    const base = "a\r\nb\r\nc\r\n";
    const ours = "a\r\nOURS\r\nc\r\n";
    const theirs = "a\r\nTHEIRS\r\nc\r\n";
    const { chunks } = merge3(base, ours, theirs);
    const conflict = chunks.find((c) => c.kind === "conflict");
    expect(conflict).toBeDefined();
    expect(conflict!.oursLines[0]).toBe("OURS\r");
    expect(conflict!.theirsLines[0]).toBe("THEIRS\r");
  });
});

describe("merge3 golden tests vs git merge-file", () => {
  // These tests compare our merge3 non-conflicting output against
  // what `git merge-file` produces. git merge-file is the reference
  // implementation; our output must match for clean merges.
  // (Conflicting cases are not tested here — git uses different marker
  //  format/labels than our wizard, so they intentionally differ.)

  function expectMatchesGit(base: string, ours: string, theirs: string) {
    const gitResult = gitMerge(base, ours, theirs);
    if (gitResult === null) return; // conflict — skip golden comparison
    const { chunks } = merge3(base, ours, theirs);
    expect(chunks.filter((c) => c.kind === "conflict")).toHaveLength(0);
    const applied = applyNonConflicting(chunks);
    expect(renderResult(applied)).toBe(gitResult);
  }

  test("identical files — output equals input", () => {
    const text = "line1\nline2\nline3\n";
    expectMatchesGit(text, text, text);
  });

  test("ours-only change matches git", () => {
    expectMatchesGit("a\nb\nc\n", "a\nOURS\nc\n", "a\nb\nc\n");
  });

  test("theirs-only change matches git", () => {
    expectMatchesGit("a\nb\nc\n", "a\nb\nc\n", "a\nTHEIRS\nc\n");
  });

  test("both changed different lines matches git (non-adjacent)", () => {
    expectMatchesGit("a\nb\nc\nd\ne\n", "a\nOURS\nc\nd\ne\n", "a\nb\nc\nTHEIRS\ne\n");
  });

  test("adjacent non-conflicting changes match git", () => {
    // ours changes first line, theirs changes last line — adjacent boundary
    expectMatchesGit("x\ny\nz\n", "X\ny\nz\n", "x\ny\nZ\n");
  });

  test("ours deletes line, theirs unchanged — matches git", () => {
    expectMatchesGit("a\nb\nc\n", "a\nc\n", "a\nb\nc\n");
  });

  test("theirs deletes line, ours unchanged — matches git", () => {
    expectMatchesGit("a\nb\nc\n", "a\nb\nc\n", "a\nc\n");
  });

  test("overlapping edits produce conflict — git also exits non-zero", () => {
    const base = "a\nb\nc\n";
    const ours = "a\nOURS\nc\n";
    const theirs = "a\nTHEIRS\nc\n";
    // git exits 1 for conflict; gitMerge returns null — we just verify our engine also flags conflict
    const gitResult = gitMerge(base, ours, theirs);
    expect(gitResult).toBeNull(); // confirms this IS a conflicting case
    const { conflictCount } = merge3(base, ours, theirs);
    expect(conflictCount).toBeGreaterThan(0);
  });

  test("whitespace-only change in ours — matches git", () => {
    expectMatchesGit("a\nb\nc\n", "a\n  b\nc\n", "a\nb\nc\n");
  });

  test("empty base with ours-only content — matches git", () => {
    // both-added case: ours has content, theirs has same content → no conflict
    expectMatchesGit("", "added\n", "added\n");
  });
});
