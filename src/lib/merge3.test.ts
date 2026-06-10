import { describe, expect, test } from "vitest";
import { merge3, applyNonConflicting, renderResult, hasUnresolvedConflicts } from "./merge3.js";

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
