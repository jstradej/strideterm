/**
 * Pure TypeScript diff3 merge engine.
 *
 * Takes three text strings (base, ours, theirs) and produces a list of
 * Chunks that describe the merged result. No DOM/Monaco dependency — fully
 * unit-testable.
 *
 * Algorithm: line-based LCS diff (Myers) of base→ours and base→theirs,
 * then zip the two diff streams into a three-way merge.
 */

export type ChunkKind = "unchanged" | "ours" | "theirs" | "conflict";

export interface Chunk {
  kind: ChunkKind;
  /** 0-based line indices into the Result array (after applying non-conflicting chunks) */
  baseLines: string[];
  oursLines: string[];
  theirsLines: string[];
  /** Lines to show in the Result editor for this chunk */
  resultLines: string[];
  /** Whether this conflict chunk has been resolved */
  resolved?: boolean;
  /** Which side was used if resolved via an arrow (undefined = manual edit) */
  resolvedBy?: "ours" | "theirs";
}

// ---------------------------------------------------------------------------
// Simple LCS-based diff (produces edit script)
// ---------------------------------------------------------------------------

type DiffOp = { op: "equal" | "insert" | "delete"; lines: string[] };

function lcs(a: string[], b: string[]): number[][] {
  const m = a.length;
  const n = b.length;
  // dp[i][j] = length of LCS of a[0..i-1] and b[0..j-1]
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }
  return dp;
}

function diff(base: string[], changed: string[]): DiffOp[] {
  const dp = lcs(base, changed);
  const ops: DiffOp[] = [];
  let i = base.length;
  let j = changed.length;

  const raw: DiffOp[] = [];
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && base[i - 1] === changed[j - 1]) {
      raw.push({ op: "equal", lines: [base[i - 1]] });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      raw.push({ op: "insert", lines: [changed[j - 1]] });
      j--;
    } else {
      raw.push({ op: "delete", lines: [base[i - 1]] });
      i--;
    }
  }
  raw.reverse();

  // Coalesce adjacent same-op runs
  for (const item of raw) {
    if (ops.length > 0 && ops[ops.length - 1].op === item.op) {
      ops[ops.length - 1].lines.push(...item.lines);
    } else {
      ops.push({ op: item.op, lines: [...item.lines] });
    }
  }
  return ops;
}

// ---------------------------------------------------------------------------
// Diff stream iterator
// ---------------------------------------------------------------------------

interface DiffCursor {
  ops: DiffOp[];
  opIdx: number;
  lineIdx: number;
}

function makeCursor(ops: DiffOp[]): DiffCursor {
  return { ops, opIdx: 0, lineIdx: 0 };
}

type DiffToken = { op: "equal" | "insert" | "delete"; line: string } | null;

function peek(c: DiffCursor): DiffToken {
  if (c.opIdx >= c.ops.length) return null;
  const op = c.ops[c.opIdx];
  return { op: op.op, line: op.lines[c.lineIdx] };
}

function advance(c: DiffCursor): DiffToken {
  const t = peek(c);
  if (!t) return null;
  const op = c.ops[c.opIdx];
  c.lineIdx++;
  if (c.lineIdx >= op.lines.length) {
    c.opIdx++;
    c.lineIdx = 0;
  }
  return t;
}

// ---------------------------------------------------------------------------
// Three-way merge
// ---------------------------------------------------------------------------

export interface Merge3Result {
  chunks: Chunk[];
  /** Number of conflict chunks */
  conflictCount: number;
}

export function merge3(base: string, ours: string, theirs: string): Merge3Result {
  const baseLines = splitLines(base);
  const oursLines = splitLines(ours);
  const theirsLines = splitLines(theirs);

  const diffO = diff(baseLines, oursLines);
  const diffT = diff(baseLines, theirsLines);

  const co = makeCursor(diffO);
  const ct = makeCursor(diffT);

  const chunks: Chunk[] = [];

  while (peek(co) !== null || peek(ct) !== null) {
    const to = peek(co);
    const tt = peek(ct);

    // Both equal — advance together (unchanged region)
    if (to?.op === "equal" && tt?.op === "equal") {
      const equalLines: string[] = [];
      while (peek(co)?.op === "equal" && peek(ct)?.op === "equal") {
        const o = advance(co)!;
        const t = advance(ct)!;
        // Both should be same line (from base)
        equalLines.push(o.line);
      }
      if (equalLines.length > 0) {
        chunks.push({
          kind: "unchanged",
          baseLines: equalLines,
          oursLines: equalLines,
          theirsLines: equalLines,
          resultLines: equalLines,
        });
      }
      continue;
    }

    // Only ours changed (theirs is equal or absent)
    if ((to?.op === "insert" || to?.op === "delete") && (tt === null || tt.op === "equal")) {
      const oLines: string[] = [];
      const bLines: string[] = [];
      // Consume ours changes: eat insert/delete ops until we hit equal again
      while (peek(co) !== null && peek(co)!.op !== "equal") {
        const o = advance(co)!;
        if (o.op === "insert") oLines.push(o.line);
        else bLines.push(o.line); // delete from base
      }
      // Advance theirs past the deleted base lines
      for (let k = 0; k < bLines.length; k++) {
        if (peek(ct)?.op === "equal") advance(ct);
      }
      chunks.push({ kind: "ours", baseLines: bLines, oursLines: oLines, theirsLines: bLines, resultLines: oLines });
      continue;
    }

    // Only theirs changed
    if ((tt?.op === "insert" || tt?.op === "delete") && (to === null || to.op === "equal")) {
      const tLines: string[] = [];
      const bLines: string[] = [];
      while (peek(ct) !== null && peek(ct)!.op !== "equal") {
        const t = advance(ct)!;
        if (t.op === "insert") tLines.push(t.line);
        else bLines.push(t.line);
      }
      for (let k = 0; k < bLines.length; k++) {
        if (peek(co)?.op === "equal") advance(co);
      }
      chunks.push({ kind: "theirs", baseLines: bLines, oursLines: bLines, theirsLines: tLines, resultLines: tLines });
      continue;
    }

    // Both changed — potential conflict
    const conflictOurs: string[] = [];
    const conflictTheirs: string[] = [];
    const conflictBase: string[] = [];

    // Drain both non-equal sides
    while (peek(co) !== null && peek(co)!.op !== "equal") {
      const o = advance(co)!;
      if (o.op === "insert") conflictOurs.push(o.line);
      else conflictBase.push(o.line);
    }
    while (peek(ct) !== null && peek(ct)!.op !== "equal") {
      const t = advance(ct)!;
      if (t.op === "insert") conflictTheirs.push(t.line);
      // deletes from theirs already accounted in base
    }

    // Same change on both sides = non-conflicting (diff3 rule: if ours==theirs use that)
    if (arraysEqual(conflictOurs, conflictTheirs)) {
      chunks.push({
        kind: "ours",
        baseLines: conflictBase,
        oursLines: conflictOurs,
        theirsLines: conflictOurs,
        resultLines: conflictOurs,
      });
    } else {
      chunks.push({
        kind: "conflict",
        baseLines: conflictBase,
        oursLines: conflictOurs,
        theirsLines: conflictTheirs,
        resultLines: [],
        resolved: false,
      });
    }
  }

  const conflictCount = chunks.filter((c) => c.kind === "conflict").length;
  return { chunks, conflictCount };
}

/**
 * Compute the full result text from chunks (for Apply).
 * Conflict chunks use their resultLines (which may be empty if unresolved —
 * caller should check resolvedOrEmpty before calling).
 */
export function renderResult(chunks: Chunk[]): string {
  const lines: string[] = [];
  for (const chunk of chunks) {
    lines.push(...chunk.resultLines);
  }
  return lines.join("\n");
}

/**
 * Apply all non-conflicting chunks, leaving conflict chunks empty.
 * Returns a new chunks array with resultLines filled in for ours/theirs/unchanged.
 */
export function applyNonConflicting(chunks: Chunk[]): Chunk[] {
  return chunks.map((chunk) => {
    if (chunk.kind === "conflict") return chunk;
    if (chunk.kind === "theirs") return { ...chunk, resultLines: chunk.theirsLines };
    if (chunk.kind === "ours") return { ...chunk, resultLines: chunk.oursLines };
    // unchanged
    return { ...chunk, resultLines: chunk.baseLines };
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function arraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function splitLines(text: string): string[] {
  if (!text) return [];
  // Keep line endings intact by not stripping \r
  return text.split("\n");
}

export function hasUnresolvedConflicts(chunks: Chunk[]): boolean {
  return chunks.some((c) => c.kind === "conflict" && !c.resolved);
}
