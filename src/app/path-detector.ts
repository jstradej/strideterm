/**
 * Detects file-system paths in plain terminal output so the renderer can
 * surface them as clickable links. The matcher is deliberately conservative
 * — better to miss an ambiguous case than underline every fraction (`1/2`)
 * the user types — and final validation that the file exists happens at
 * click time via fs.stat (out of scope here).
 *
 * Recognised forms:
 *   1. Unix absolute             /usr/local/bin/node
 *   2. Unix home-relative        ~/Documents/notes.md
 *   3. Unix explicit relative    ./src/foo.ts, ../shared/util.js
 *   4. Windows absolute          C:\Users\foo\bar.txt or D:/proj/main.cs
 *   5. UNC share                 \\server\share\file
 *   6. Compiler reference        src/foo.ts:42:5  (only when the line:col
 *                                tail is present — bare `foo.ts` is too
 *                                ambiguous on its own)
 *
 * Optional location suffix appended after any of those:
 *   :line[:col]        e.g. /src/a.ts:42:5
 *   (line[,col])       e.g. ./foo.ts(42,5)
 *
 * Whitespace and the small set of chars that are illegal in Windows paths
 * (`<`, `>`, `|`, `*`, `?`, quotes, NUL) terminate a path body, plus the
 * three suffix-delimiter chars (`:`, `(`, `)`) so the suffix gets parsed
 * as a structured location rather than swallowed into the body. Diacritics
 * and CJK characters pass through unchanged because we only blacklist —
 * never whitelist — characters inside the body.
 */

export interface DetectedPath {
  /** The raw path text (no line/column suffix). */
  path: string;
  /** Optional 1-based line number from a `:line` or `(line)` suffix. */
  line?: number;
  /** Optional 1-based column number from a `:line:col` or `(line,col)` suffix. */
  column?: number;
  /** Offset of the first character of the match within the input string. */
  start: number;
  /** Total length of the match including any trailing line/column suffix. */
  length: number;
}

// Body characters: anything except whitespace, the Windows-illegal set,
// and the three suffix delimiters (so `:line:col` and `(line,col)` get
// parsed as a structured tail rather than absorbed into the body).
const PATH_BODY = String.raw`[^\s<>|*?"' :()]+`;

// Optional trailing location, captured: either `:line[:col]` or `(line[,col])`.
const SUFFIX = String.raw`(?::(\d+)(?::(\d+))?|\((\d+)(?:,\s*(\d+))?\))?`;

const ANCHORS = [
  // Windows absolute: C:\foo or C:/foo (drive letter required).
  String.raw`[A-Za-z]:[\\/]`,
  // UNC: \\server\share\... (the trailing body still consumes literal backslashes).
  String.raw`\\\\`,
  // Unix home: ~/...
  String.raw`~/`,
  // Explicit relative: ./... or ../...
  String.raw`\.{1,2}/`,
  // Unix absolute: /...
  String.raw`/`,
];

// `(?<![A-Za-z0-9])` keeps the bare `/` anchor from firing inside words
// like `foo/bar` (where the `/` is just a token separator, not a path
// root). The same look-behind is applied to all anchors for consistency
// — the cost is negligible and protects against weird cases like
// `setVarC:\path` where someone concatenates a variable name and a path.
const ANCHORED_PATH_RE = new RegExp(String.raw`(?<![A-Za-z0-9])(?:${ANCHORS.join("|")})${PATH_BODY}${SUFFIX}`, "g");

// Compiler-style reference: filename with extension followed by a line:col
// or (line,col) suffix. Allows path separators inside the name so that
// `packages/web/src/index.tsx:10:3` is a single match. The required
// extension + location suffix is what differentiates this from arbitrary
// `a/b` text.
const COMPILER_REF_RE = new RegExp(
  String.raw`(?<![\w/\\.\-])` + // boundary on the left
    String.raw`(?:[^\s<>|*?"' :()/\\]+[\\/])*` + // optional dir segments
    String.raw`[^\s<>|*?"' :()/\\]+\.[A-Za-z][A-Za-z0-9]{0,9}` + // name.ext
    String.raw`(?::(\d+)(?::(\d+))?|\((\d+)(?:,\s*(\d+))?\))`, // required suffix
  "g",
);

// Used to peel the leading anchor off so we can sanity-check the body
// (e.g. reject `/123/456` while keeping `/usr/123` and `~/Documents`).
const ANCHOR_STRIP_RE = /^(?:[A-Za-z]:[\\/]|\\\\|~\/|\.{1,2}\/|\/)/;

// Punctuation we'll trim from the end of a captured path when it's almost
// certainly sentence punctuation rather than part of the filename. The
// final `/` is intentionally absent — a trailing slash is a directory
// marker that's worth preserving.
const TRAILING_PUNCT_RE = /[.,;:!?'"\]}>]+$/;

function isLikelyUrlScheme(input: string, start: number): boolean {
  // Reject the host/path portion of a URL like `https://example.com/foo`:
  // the regex would otherwise match the `/` that begins `//host/path`.
  // Walk back from the match start, expecting to land on `<scheme>:`.
  if (start < 2) return false;
  const prefix = input.slice(0, start + 1);
  return /[A-Za-z][A-Za-z0-9+.-]*:\/$/.test(prefix);
}

function bodyHasContent(path: string): boolean {
  // After the leading anchor, the body has to have *something* — filters
  // bare anchors like `./` or `~/` that didn't consume any payload.
  return path.replace(ANCHOR_STRIP_RE, "").length > 0;
}

function bodyIsOnlyDigitsAndSeparators(path: string): boolean {
  // Strip the leading anchor before the digit check so `/123/456` and
  // `1/2` both look like noise while `/usr/123` survives.
  const body = path.replace(ANCHOR_STRIP_RE, "");
  return /^[\d/\\]+$/.test(body);
}

function trimTrailingPunctuation(path: string): { path: string; delta: number } {
  const trimmed = path.replace(TRAILING_PUNCT_RE, "");
  if (trimmed.length === 0) return { path, delta: 0 };
  return { path: trimmed, delta: path.length - trimmed.length };
}

interface RawAnchoredMatch {
  full: string; // entire matched text including any suffix
  bodyEnd: number; // index in `full` where the path body ends (== suffix start)
  line?: number;
  column?: number;
}

function parseAnchoredMatch(match: RegExpExecArray): RawAnchoredMatch {
  const full = match[0];
  const colonLine = match[1];
  const colonCol = match[2];
  const parensLine = match[3];
  const parensCol = match[4];

  if (colonLine !== undefined) {
    // `:line[:col]` form. Reconstruct the suffix length from its raw text.
    const suffix = colonCol !== undefined ? `:${colonLine}:${colonCol}` : `:${colonLine}`;
    return {
      full,
      bodyEnd: full.length - suffix.length,
      line: parseInt(colonLine, 10),
      column: colonCol !== undefined ? parseInt(colonCol, 10) : undefined,
    };
  }
  if (parensLine !== undefined) {
    // `(line[,col])` form. The capture group only sees the digits, so we
    // re-extract the literal suffix off the tail of `full`.
    // eslint-disable-next-line security/detect-unsafe-regex -- bounded; both \d+ separated by literal `,` cannot backtrack catastrophically
    const tailMatch = full.match(/\((\d+)(?:,\s*(\d+))?\)$/);
    const suffix = tailMatch ? tailMatch[0] : "";
    return {
      full,
      bodyEnd: full.length - suffix.length,
      line: parseInt(parensLine, 10),
      column: parensCol !== undefined ? parseInt(parensCol, 10) : undefined,
    };
  }
  return { full, bodyEnd: full.length };
}

/**
 * Scan a single line of text and return every path-like span we'd want to
 * surface as a clickable link. Matches come back left-to-right and never
 * overlap. Callers are responsible for validating that the captured path
 * actually exists on disk (resolve relative paths against the appropriate
 * cwd before stat'ing).
 */
export function detectPaths(input: string): DetectedPath[] {
  if (!input) return [];
  const matches: DetectedPath[] = [];
  const claimedRanges: Array<[number, number]> = [];

  function overlapsClaim(start: number, end: number): boolean {
    return claimedRanges.some(([s, e]) => start < e && end > s);
  }

  // Pass 1: anchored paths (start with /, \\, ~/, ./, ../, or drive letter).
  ANCHORED_PATH_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = ANCHORED_PATH_RE.exec(input)) !== null) {
    const matchStart = match.index;
    const parsed = parseAnchoredMatch(match);

    if (isLikelyUrlScheme(input, matchStart)) continue;

    let path = parsed.full.slice(0, parsed.bodyEnd);
    let totalLength = parsed.full.length;

    // Trim trailing sentence punctuation (period, comma, etc.) only when
    // the body had no structured suffix — if the user wrote `./foo.ts:42:5,`
    // we already stripped the `:42:5` cleanly, so the trailing `,` is on
    // the suffix end, not the path end.
    if (parsed.line === undefined) {
      const trimmed = trimTrailingPunctuation(path);
      path = trimmed.path;
      totalLength -= trimmed.delta;
    }

    if (!bodyHasContent(path)) continue;
    if (bodyIsOnlyDigitsAndSeparators(path)) continue;

    matches.push({
      path,
      line: parsed.line,
      column: parsed.column,
      start: matchStart,
      length: totalLength,
    });
    claimedRanges.push([matchStart, matchStart + totalLength]);
  }

  // Pass 2: implicit-relative compiler references (filename.ext with a
  // required line:col suffix). Skipped for any range Pass 1 already grabbed.
  COMPILER_REF_RE.lastIndex = 0;
  while ((match = COMPILER_REF_RE.exec(input)) !== null) {
    const matchedText = match[0];
    const matchStart = match.index;
    const matchEnd = matchStart + matchedText.length;
    if (overlapsClaim(matchStart, matchEnd)) continue;

    const colonLine = match[1];
    const colonCol = match[2];
    const parensLine = match[3];
    const parensCol = match[4];

    let path = matchedText;
    let line: number | undefined;
    let column: number | undefined;

    if (colonLine !== undefined) {
      const suffix = colonCol !== undefined ? `:${colonLine}:${colonCol}` : `:${colonLine}`;
      path = matchedText.slice(0, -suffix.length);
      line = parseInt(colonLine, 10);
      column = colonCol !== undefined ? parseInt(colonCol, 10) : undefined;
    } else if (parensLine !== undefined) {
      // eslint-disable-next-line security/detect-unsafe-regex -- bounded; both \d+ separated by literal `,` cannot backtrack catastrophically
      const tailMatch = matchedText.match(/\((\d+)(?:,\s*(\d+))?\)$/);
      const suffix = tailMatch ? tailMatch[0] : "";
      path = matchedText.slice(0, -suffix.length);
      line = parseInt(parensLine, 10);
      column = parensCol !== undefined ? parseInt(parensCol, 10) : undefined;
    }

    if (!path || /^[\d.\\/]+$/.test(path)) continue;

    matches.push({ path, line, column, start: matchStart, length: matchedText.length });
    claimedRanges.push([matchStart, matchEnd]);
  }

  // Sort by start offset so callers can rely on left-to-right ordering even
  // though Pass 2 may slot matches between Pass 1 hits.
  matches.sort((a, b) => a.start - b.start);
  return matches;
}
