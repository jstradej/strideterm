import type { IBuffer, IBufferLine } from "@xterm/xterm";

/**
 * Serialise what a terminal is showing into a plain, stable string.
 *
 * The "Select text" panel (TerminalTextSelectionDialog.vue) renders this
 * string in a `<pre>` so the phone's own selection handles and Copy callout
 * can work on it. Everything here reads the PUBLIC xterm buffer API only — no
 * `_core`, no glyph scraping out of the DOM/canvas — and runs synchronously
 * against whatever the parser has already committed, so the PTY never has to
 * be paused to take a snapshot.
 *
 * What comes out is the CONTENT OF THE SCREEN, not the raw PTY stream: styles
 * and control sequences are gone, and tabs the terminal already expanded into
 * cell padding cannot be recovered as tabs.
 */

/**
 * Hard cap on one snapshot, in UTF-16 units. A phone has to hold this in a
 * single DOM text node and the user has to be able to scroll it; past a few
 * hundred KB both stop being true. Deliberately a constant, not a setting.
 */
export const MAX_SNAPSHOT_CHARS = 200_000;

/**
 * Ceiling for the optional "Include earlier output" pass, in PHYSICAL buffer
 * rows (so a soft-wrapped logical line counts once per screen row it occupies).
 */
export const MAX_SNAPSHOT_SCROLLBACK_LINES = 500;

/**
 * The slice of xterm's `Terminal` this module needs. Structural on purpose:
 * a real `Terminal` satisfies it, and so does a test double, without either
 * having to drag in the renderer.
 */
export interface TerminalTextSnapshotSource {
  readonly cols: number;
  readonly rows: number;
  readonly buffer: { readonly active: IBuffer };
}

export interface TerminalTextSnapshotOptions {
  /**
   * Physical rows of scrollback to prepend ahead of the viewport. Clamped to
   * {@link MAX_SNAPSHOT_SCROLLBACK_LINES}, and ignored on the alternate screen
   * (which has no scrollback of its own — the normal buffer's history belongs
   * to a different screen and must never be spliced in).
   */
  scrollbackLines?: number;
  /** UTF-16 budget for the whole snapshot. Defaults to {@link MAX_SNAPSHOT_CHARS}. */
  maxChars?: number;
}

export interface TerminalTextSnapshot {
  /** The serialised screen. Plain text, `\n`-separated, no trailing newline. */
  text: string;
  /** Physical buffer rows the text was built from, after clamping. */
  rowCount: number;
  /** How many of those rows came from scrollback above the viewport. */
  scrollbackRows: number;
  /** The first row is a soft-wrap continuation of a line ABOVE the range. */
  startsMidLine: boolean;
  /** The last row soft-wraps into a line BELOW the range. */
  endsMidLine: boolean;
  /** The text was cut to the char budget; the OLDEST part is missing. */
  truncated: boolean;
  /** The source was the alternate screen (a TUI), so there is no scrollback. */
  alternateBuffer: boolean;
}

/**
 * Last column of a row that still holds written content.
 *
 * Only ever used for a row that soft-wraps into the next one, and only to drop
 * trailing NULL cells. xterm renders a null cell as a space, so a row that had
 * to wrap early because a double-width glyph didn't fit in its last cell comes
 * back from `translateToString` with a phantom space on the end — join that to
 * the next row and `abcde你好` becomes `abcde 你好`. A real trailing space is a
 * space cell (`getChars() === " "`), not a null one, so it survives.
 *
 * A cell of width 0 is the second half of a wide glyph and is never trailing
 * padding, so the scan stops there.
 */
function contentEndColumn(line: IBufferLine, cols: number): number {
  let end = Math.min(line.length, cols);
  while (end > 0) {
    const cell = line.getCell(end - 1);
    if (!cell) {
      end -= 1;
      continue;
    }
    if (cell.getWidth() === 0) break;
    if (cell.getChars() !== "") break;
    end -= 1;
  }
  return end;
}

/**
 * One physical row as text.
 *
 * A row that ENDS a logical line is right-trimmed: the cells past the last
 * character are unwritten screen, and keeping them would pad every short line
 * out to the terminal width. A row that CONTINUES into the next one is not —
 * blind trimming there glues the last word of the row to the first word of the
 * continuation. See {@link contentEndColumn} for the one thing that does get
 * trimmed off a continuing row.
 */
function rowText(line: IBufferLine, cols: number, continues: boolean): string {
  if (!continues) return line.translateToString(true);
  return line.translateToString(false, 0, contentEndColumn(line, cols));
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

export function buildTerminalTextSnapshot(
  term: TerminalTextSnapshotSource,
  options: TerminalTextSnapshotOptions = {},
): TerminalTextSnapshot {
  const buffer = term.buffer.active;
  const alternateBuffer = buffer.type === "alternate";
  const cols = Math.max(1, term.cols);
  const maxChars = Math.max(1, options.maxChars ?? MAX_SNAPSHOT_CHARS);
  const requestedScrollback = Math.max(0, Math.floor(options.scrollbackLines ?? 0));
  const scrollback = alternateBuffer ? 0 : Math.min(requestedScrollback, MAX_SNAPSHOT_SCROLLBACK_LINES);

  const viewportTop = Math.max(0, buffer.viewportY);
  const startRow = Math.max(0, viewportTop - scrollback);
  const endRow = Math.min(buffer.length, viewportTop + Math.max(0, term.rows));

  const empty: TerminalTextSnapshot = {
    text: "",
    rowCount: 0,
    scrollbackRows: 0,
    startsMidLine: false,
    endsMidLine: false,
    truncated: false,
    alternateBuffer,
  };
  if (endRow <= startRow) return empty;

  const startsMidLine = startRow > 0 && buffer.getLine(startRow)?.isWrapped === true;
  const endsMidLine = buffer.getLine(endRow)?.isWrapped === true;

  const lines: string[] = [];
  let pending = "";
  for (let row = startRow; row < endRow; row += 1) {
    const line = buffer.getLine(row);
    if (!line) {
      lines.push(pending);
      pending = "";
      continue;
    }
    // "Continues" is a property of the BUFFER, not of the range: the last row
    // we take may soft-wrap into a row we don't. Reading the real wrap flag
    // keeps that row's trailing content intact; the range cut is reported
    // through `endsMidLine` instead of being silently trimmed away.
    const wrapsToNext = buffer.getLine(row + 1)?.isWrapped === true;
    pending += rowText(line, cols, wrapsToNext);
    if (!wrapsToNext || row + 1 >= endRow) {
      lines.push(pending);
      pending = "";
    }
  }
  if (pending) lines.push(pending);

  // Blank rows below the last written line are unwritten screen, not content.
  // Blank rows BETWEEN lines are content and stay exactly where they are.
  while (lines.length > 0 && lines[lines.length - 1].trim() === "") lines.pop();

  let text = lines.join("\n");
  let truncated = false;
  if (text.length > maxChars) {
    // Keep the NEWEST end: the user long-pressed on what is on screen now.
    let cut = text.length - maxChars;
    if (isLowSurrogate(text.charCodeAt(cut))) cut += 1;
    text = text.slice(cut);
    truncated = true;
  }

  return {
    text,
    rowCount: endRow - startRow,
    scrollbackRows: viewportTop - startRow,
    startsMidLine,
    endsMidLine,
    truncated,
    alternateBuffer,
  };
}
