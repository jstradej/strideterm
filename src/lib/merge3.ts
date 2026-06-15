/**
 * Pure TypeScript diff3 merge engine.
 *
 * Takes three text strings (base, ours, theirs) and produces a list of
 * Chunks that describe the merged result. No DOM/Monaco dependency — fully
 * unit-testable.
 *
 * Algorithm: line-based LCS diff (Myers) of base→ours and base→theirs, reduce
 * each to base-anchored hunks, then zip the two hunk lists over base line
 * positions. Anchoring to base indices keeps ours and theirs aligned — the
 * earlier token-cursor zip let the two streams drift out of sync, which both
 * produced wrong merges and (for some inputs) looped forever, OOM-crashing the
 * renderer when the merge editor opened a conflict.
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
// Base-anchored hunks
// ---------------------------------------------------------------------------
//
// Each diff (base→ours, base→theirs) is reduced to a list of hunks: a base
// line range [baseStart, baseEnd) that the side REPLACES with `lines`. Equal
// runs are implicit (base unchanged). A pure insertion is a zero-width range
// (baseStart === baseEnd) with the inserted lines.

interface Hunk {
  baseStart: number;
  baseEnd: number; // exclusive
  lines: string[]; // replacement lines for [baseStart, baseEnd)
}

function diffToHunks(ops: DiffOp[]): Hunk[] {
  const hunks: Hunk[] = [];
  let base = 0;
  let cur: Hunk | null = null;
  for (const op of ops) {
    if (op.op === "equal") {
      if (cur) {
        hunks.push(cur);
        cur = null;
      }
      base += op.lines.length;
    } else {
      if (!cur) cur = { baseStart: base, baseEnd: base, lines: [] };
      if (op.op === "delete") {
        base += op.lines.length;
        cur.baseEnd = base;
      } else {
        // insert — adds lines without consuming a base line
        cur.lines.push(...op.lines);
      }
    }
  }
  if (cur) hunks.push(cur);
  return hunks;
}

// Reconstruct one side's text over base range [from, to) given that side's
// hunks indexed [hunkStart, hunkEnd). Base lines outside any hunk are kept
// verbatim (that side left them unchanged); each hunk replaces its base range.
function reconstructSide(
  hunks: Hunk[],
  hunkStart: number,
  hunkEnd: number,
  from: number,
  to: number,
  baseLines: string[],
): string[] {
  const out: string[] = [];
  let b = from;
  for (let i = hunkStart; i < hunkEnd; i++) {
    const h = hunks[i];
    if (h.baseStart > b) out.push(...baseLines.slice(b, h.baseStart));
    out.push(...h.lines);
    b = h.baseEnd;
  }
  if (b < to) out.push(...baseLines.slice(b, to));
  return out;
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

  const oursHunks = diffToHunks(diff(baseLines, oursLines));
  const theirsHunks = diffToHunks(diff(baseLines, theirsLines));

  const chunks: Chunk[] = [];
  const pushUnchanged = (lines: string[]): void => {
    if (lines.length === 0) return;
    chunks.push({ kind: "unchanged", baseLines: lines, oursLines: lines, theirsLines: lines, resultLines: lines });
  };

  let basePos = 0; // current base line index
  let oi = 0; // next ours hunk
  let ti = 0; // next theirs hunk

  while (basePos < baseLines.length || oi < oursHunks.length || ti < theirsHunks.length) {
    const oStart = oi < oursHunks.length ? oursHunks[oi].baseStart : Infinity;
    const tStart = ti < theirsHunks.length ? theirsHunks[ti].baseStart : Infinity;
    const nextChange = Math.min(oStart, tStart);

    // Stable (unchanged-by-both) base lines before the next change.
    if (basePos < nextChange && nextChange !== Infinity) {
      const end = Math.min(nextChange, baseLines.length);
      pushUnchanged(baseLines.slice(basePos, end));
      basePos = end;
      continue;
    }

    // No remaining hunks → emit any trailing unchanged base lines and finish.
    if (oStart === Infinity && tStart === Infinity) {
      pushUnchanged(baseLines.slice(basePos));
      basePos = baseLines.length;
      continue;
    }

    // A change region starts at basePos. Expand it to cover every ours/theirs
    // hunk that overlaps or abuts the growing region, so both sides span the
    // SAME base range (the diff3 "unstable" region between two stable points).
    const regionStart = basePos;
    let regionEnd = basePos;
    const ourFirst = oi;
    const theirFirst = ti;
    // A hunk joins the region if it OVERLAPS it (starts before the current
    // end, sharing a base line) or it is the region's anchor (starts exactly
    // at regionStart — covers the first hunk and zero-width inserts there).
    // Merely adjacent changes (one ends where the other begins, on different
    // base lines) stay in SEPARATE regions so they merge cleanly instead of
    // being reported as a conflict — matching git merge-file.
    const joins = (h: Hunk): boolean => h.baseStart < regionEnd || h.baseStart === regionStart;
    let grew = true;
    while (grew) {
      grew = false;
      if (oi < oursHunks.length && joins(oursHunks[oi])) {
        regionEnd = Math.max(regionEnd, oursHunks[oi].baseEnd);
        oi++;
        grew = true;
      }
      if (ti < theirsHunks.length && joins(theirsHunks[ti])) {
        regionEnd = Math.max(regionEnd, theirsHunks[ti].baseEnd);
        ti++;
        grew = true;
      }
    }

    const oursTouched = oi > ourFirst;
    const theirsTouched = ti > theirFirst;
    const regionBase = baseLines.slice(regionStart, regionEnd);
    const ourSide = reconstructSide(oursHunks, ourFirst, oi, regionStart, regionEnd, baseLines);
    const theirSide = reconstructSide(theirsHunks, theirFirst, ti, regionStart, regionEnd, baseLines);
    basePos = regionEnd;

    if (oursTouched && !theirsTouched) {
      chunks.push({
        kind: "ours",
        baseLines: regionBase,
        oursLines: ourSide,
        theirsLines: regionBase,
        resultLines: ourSide,
      });
    } else if (theirsTouched && !oursTouched) {
      chunks.push({
        kind: "theirs",
        baseLines: regionBase,
        oursLines: regionBase,
        theirsLines: theirSide,
        resultLines: theirSide,
      });
    } else if (arraysEqual(ourSide, theirSide)) {
      // Both sides made the identical change — not a conflict (diff3 rule).
      chunks.push({
        kind: "ours",
        baseLines: regionBase,
        oursLines: ourSide,
        theirsLines: theirSide,
        resultLines: ourSide,
      });
    } else {
      chunks.push({
        kind: "conflict",
        baseLines: regionBase,
        oursLines: ourSide,
        theirsLines: theirSide,
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
