import { describe, expect, test } from "vitest";
import { Terminal } from "@xterm/xterm";
import {
  buildTerminalTextSnapshot,
  MAX_SNAPSHOT_CHARS,
  MAX_SNAPSHOT_SCROLLBACK_LINES,
} from "./terminal-text-snapshot.js";

/**
 * These run against a REAL xterm buffer rather than a hand-built fake: the
 * whole point of the helper is that it agrees with xterm about where a soft
 * wrap is and what a cell holds, and a fake would just re-state our own
 * assumptions. `open()` is never called, so no canvas is needed in jsdom.
 */
function makeTerm(options: { cols?: number; rows?: number; scrollback?: number } = {}): Terminal {
  return new Terminal({
    cols: options.cols ?? 20,
    rows: options.rows ?? 6,
    scrollback: options.scrollback ?? 100,
    allowProposedApi: true,
  });
}

/** Resolve only once xterm has PARSED the data into the buffer. */
function write(term: Terminal, data: string): Promise<void> {
  return new Promise((resolve) => term.write(data, resolve));
}

describe("buildTerminalTextSnapshot", () => {
  test("keeps hard newlines and blank lines, drops the unwritten screen below", async () => {
    const term = makeTerm();
    await write(term, "first\r\n\r\nthird\r\n");

    const snapshot = buildTerminalTextSnapshot(term);

    expect(snapshot.text).toBe("first\n\nthird");
    expect(snapshot.truncated).toBe(false);
    expect(snapshot.alternateBuffer).toBe(false);
  });

  test("joins a soft wrap into one line but keeps a hard newline separate", async () => {
    const term = makeTerm({ cols: 10 });
    await write(term, "hello world this wraps\r\nnext\r\n");

    const snapshot = buildTerminalTextSnapshot(term);

    expect(snapshot.text).toBe("hello world this wraps\nnext");
  });

  test("preserves indentation and interior runs of spaces", async () => {
    const term = makeTerm({ cols: 40 });
    await write(term, "    indented  two   three\r\n\tafter-tab\r\n");

    const snapshot = buildTerminalTextSnapshot(term);

    expect(snapshot.text.split("\n")[0]).toBe("    indented  two   three");
    // The terminal already expanded the tab into cell padding; the snapshot
    // reports the screen, so spaces are the honest answer here.
    expect(snapshot.text.split("\n")[1]).toBe("        after-tab");
  });

  test("a real space at a wrap boundary survives the join", async () => {
    const term = makeTerm({ cols: 6 });
    // "abcde" + " " fills the row exactly, so the space is a written cell.
    await write(term, "abcde fghij");

    const snapshot = buildTerminalTextSnapshot(term);

    expect(snapshot.text).toBe("abcde fghij");
  });

  test("padding before a double-width glyph at the row edge is not turned into a space", async () => {
    const term = makeTerm({ cols: 6 });
    // The wide glyph cannot fit in the last cell of "abcde", so xterm leaves
    // that cell NULL and wraps. Rendering it as a space would glue in a
    // phantom space between "abcde" and the glyph.
    await write(term, "abcde你好");

    const snapshot = buildTerminalTextSnapshot(term);

    expect(snapshot.text).toBe("abcde你好");
  });

  test("emoji and combining marks survive intact", async () => {
    const term = makeTerm({ cols: 40 });
    await write(term, "diky \u{1f680} escrzyaie\r\n");

    const snapshot = buildTerminalTextSnapshot(term);

    expect(snapshot.text).toBe("diky \u{1f680} escrzyaie");
  });

  test("reads the viewport, not the whole buffer, when scrolled into the scrollback", async () => {
    const term = makeTerm({ cols: 20, rows: 4 });
    for (let i = 1; i <= 20; i += 1) await write(term, `line-${i}\r\n`);
    term.scrollToTop();

    const snapshot = buildTerminalTextSnapshot(term);

    expect(term.buffer.active.viewportY).toBe(0);
    expect(snapshot.text).toBe("line-1\nline-2\nline-3\nline-4");
    expect(snapshot.rowCount).toBe(4);
    expect(snapshot.scrollbackRows).toBe(0);
  });

  test("scrollbackLines prepends earlier rows and reports how many it took", async () => {
    const term = makeTerm({ cols: 20, rows: 4 });
    for (let i = 1; i <= 20; i += 1) await write(term, `line-${i}\r\n`);

    const snapshot = buildTerminalTextSnapshot(term, { scrollbackLines: 3 });

    expect(snapshot.scrollbackRows).toBe(3);
    expect(snapshot.text.split("\n")[0]).toBe("line-15");
    expect(snapshot.text.split("\n").at(-1)).toBe("line-20");
  });

  test("scrollbackLines is clamped to the documented ceiling", async () => {
    const term = makeTerm({ cols: 20, rows: 4, scrollback: 5000 });
    // One write, not 900 — the parser is the slow part and the buffer it
    // produces is identical.
    await write(term, Array.from({ length: 900 }, (_, i) => `line-${i + 1}`).join("\r\n") + "\r\n");

    const snapshot = buildTerminalTextSnapshot(term, { scrollbackLines: 5000 });

    expect(snapshot.scrollbackRows).toBe(MAX_SNAPSHOT_SCROLLBACK_LINES);
  });

  test("clamps to the real buffer length when the viewport runs past it", async () => {
    const term = makeTerm({ cols: 20, rows: 40 });
    await write(term, "only-line\r\n");

    const snapshot = buildTerminalTextSnapshot(term);

    expect(snapshot.text).toBe("only-line");
    expect(snapshot.rowCount).toBeLessThanOrEqual(term.buffer.active.length);
  });

  test("alternate buffer: only the screen, never the normal buffer's scrollback", async () => {
    const term = makeTerm({ cols: 20, rows: 4 });
    for (let i = 1; i <= 20; i += 1) await write(term, `scrollback-${i}\r\n`);
    // DECSET 1049 — enter the alternate screen, then clear it and home the
    // cursor, exactly as a full-screen TUI does on startup.
    await write(term, "\x1b[?1049h\x1b[2J\x1b[H");
    await write(term, "tui-top\r\ntui-body");

    const snapshot = buildTerminalTextSnapshot(term, { scrollbackLines: 500 });

    expect(snapshot.alternateBuffer).toBe(true);
    expect(snapshot.scrollbackRows).toBe(0);
    expect(snapshot.text).toBe("tui-top\ntui-body");
    expect(snapshot.text).not.toContain("scrollback-");
  });

  test("flags a viewport that starts inside a wrapped logical line", async () => {
    const term = makeTerm({ cols: 10, rows: 3 });
    await write(term, "aaaaaaaaaabbbbbbbbbbcccccccccc\r\nx\r\ny\r\nz\r\n");

    expect(buildTerminalTextSnapshot(term).startsMidLine).toBe(false);

    term.scrollLines(-2);
    expect(buildTerminalTextSnapshot(term).startsMidLine).toBe(true);
  });

  test("flags a viewport whose last row continues below it", async () => {
    const term = makeTerm({ cols: 10, rows: 2 });
    await write(term, "aaaaaaaaaabbbbbbbbbbcccccccccc");
    term.scrollToTop();

    const snapshot = buildTerminalTextSnapshot(term);

    expect(snapshot.endsMidLine).toBe(true);
    expect(snapshot.text).toBe("aaaaaaaaaabbbbbbbbbb");
  });

  test("truncates to the char budget from the OLD end and flags it", async () => {
    const term = makeTerm({ cols: 20, rows: 10 });
    for (let i = 0; i < 10; i += 1) await write(term, `line-${i}\r\n`);

    const snapshot = buildTerminalTextSnapshot(term, { maxChars: 12 });

    expect(snapshot.truncated).toBe(true);
    expect(snapshot.text.length).toBeLessThanOrEqual(12);
    expect(snapshot.text.endsWith("line-9")).toBe(true);
  });

  test("truncation never splits a surrogate pair", async () => {
    const term = makeTerm({ cols: 20, rows: 4 });
    await write(term, "ab\u{1f680}cd");

    // The text is 6 UTF-16 units; a budget of 3 lands the cut exactly on the
    // low surrogate of the rocket, so the cut has to step past it.
    const snapshot = buildTerminalTextSnapshot(term, { maxChars: 3 });

    expect(snapshot.truncated).toBe(true);
    expect(snapshot.text).toBe("cd");
  });

  test("an empty terminal yields an empty snapshot rather than blank padding", async () => {
    const term = makeTerm();
    await write(term, "");

    const snapshot = buildTerminalTextSnapshot(term);

    expect(snapshot.text).toBe("");
    expect(snapshot.truncated).toBe(false);
  });

  test("the default char budget is the documented constant", async () => {
    const term = makeTerm({ cols: 20, rows: 4 });
    await write(term, "short\r\n");

    expect(MAX_SNAPSHOT_CHARS).toBe(200_000);
    expect(buildTerminalTextSnapshot(term).truncated).toBe(false);
  });
});
