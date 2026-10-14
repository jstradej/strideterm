import { Terminal } from "@xterm/xterm";
import { describe, expect, test } from "vitest";
import { TerminalReplayStore } from "./terminal-replay-buffer.js";

const MODE_SETUP = "\u001b[?1049h\u001b[?1000h\u001b[?1006h\u001b[?1h\u001b[?2004h";

function write(term: Terminal, data: string): Promise<void> {
  return new Promise((resolve) => term.write(data, resolve));
}

describe("terminal replay mode recovery with xterm", () => {
  test("preserves active modes after default-cap eviction and reset", async () => {
    const store = new TerminalReplayStore(200_000);
    store.append("s", MODE_SETUP);
    for (let i = 0; i < 11; i++) store.append("s", `${i}:` + "x".repeat(20_000));
    const snapshot = store.snapshot("s");

    const term = new Terminal({ cols: 80, rows: 24 });
    await write(term, MODE_SETUP);
    expect(term.buffer.active.type).toBe("alternate");
    expect(term.modes).toMatchObject({
      applicationCursorKeysMode: true,
      bracketedPasteMode: true,
      mouseTrackingMode: "vt200",
    });

    term.reset();
    await write(term, snapshot.data);
    expect(term.buffer.active.type).toBe("alternate");
    expect(term.modes).toMatchObject({
      applicationCursorKeysMode: true,
      bracketedPasteMode: true,
      mouseTrackingMode: "vt200",
    });
    expect(Buffer.byteLength(snapshot.data, "utf8")).toBeLessThanOrEqual(200_000);
    term.dispose();
  });

  test("keeps the no-overflow path and applies later mode exits in stream order", async () => {
    const control = new TerminalReplayStore(200_000);
    control.append("s", MODE_SETUP);
    control.append("s", "screen");
    const controlTerm = new Terminal({ cols: 80, rows: 24 });
    controlTerm.reset();
    await write(controlTerm, control.snapshot("s").data);
    expect(controlTerm.buffer.active.type).toBe("alternate");
    expect(controlTerm.modes.mouseTrackingMode).toBe("vt200");
    controlTerm.dispose();

    const store = new TerminalReplayStore(80);
    store.append("s", "\u001b[?1049h\u001b[?1000h");
    store.append("s", "f".repeat(60));
    store.append("s", "\u001b[?1049l\u001b[?1000lTAIL");
    const snapshot = store.snapshot("s");
    const term = new Terminal({ cols: 80, rows: 24 });
    term.reset();
    await write(term, snapshot.data);
    expect(term.buffer.active.type).toBe("normal");
    expect(term.modes.mouseTrackingMode).toBe("none");
    term.dispose();
  });

  test("keeps an incomplete retained CSI open for the next live frame", async () => {
    const store = new TerminalReplayStore(80);
    store.append("s", "existing screen contents");
    store.append("s", "\u001b[?1049");
    const snapshot = store.snapshot("s");
    const term = new Terminal({ cols: 80, rows: 24 });
    term.reset();
    await write(term, snapshot.data);
    expect(term.buffer.active.type).toBe("normal");
    await write(term, "h");
    expect(term.buffer.active.type).toBe("alternate");
    term.dispose();
  });

  test("continues a CSI opener at an evicted boundary when the live frame supplies its final", async () => {
    const store = new TerminalReplayStore(96);
    store.append("s", "a".repeat(100) + "\u001b[?1049");
    const snapshot = store.snapshot("s");
    expect(snapshot.data).toBe("\u001b[?1049");
    const term = new Terminal({ cols: 80, rows: 24 });
    term.reset();
    await write(term, snapshot.data);
    expect(term.buffer.active.type).toBe("normal");
    await write(term, "h");
    expect(term.buffer.active.type).toBe("alternate");
    term.dispose();
  });

  test("matches xterm mode semantics for DECSTR and mode-like bytes inside OSC", async () => {
    const scenarios = [
      "\u001b[?1h\u001b[?66h\u001b[?1004h\u001b[?2004h\u001b[!p" + "x".repeat(80),
      "\u001b]0;title\u001b[?1049h\u0007" + "y".repeat(80),
    ];
    for (const stream of scenarios) {
      const store = new TerminalReplayStore(48);
      store.append("s", stream);
      const snapshot = store.snapshot("s");
      const expected = new Terminal({ cols: 80, rows: 24 });
      const replayed = new Terminal({ cols: 80, rows: 24 });
      await write(expected, stream);
      await write(replayed, snapshot.data);
      expect(replayed.buffer.active.type).toBe(expected.buffer.active.type);
      expect(replayed.modes.applicationCursorKeysMode).toBe(expected.modes.applicationCursorKeysMode);
      expect(replayed.modes.applicationKeypadMode).toBe(expected.modes.applicationKeypadMode);
      expect(replayed.modes.sendFocusMode).toBe(expected.modes.sendFocusMode);
      expect(replayed.modes.bracketedPasteMode).toBe(expected.modes.bracketedPasteMode);
      expect(replayed.modes.mouseTrackingMode).toBe(expected.modes.mouseTrackingMode);
      expected.dispose();
      replayed.dispose();
    }
  });

  test("uses an inert OSC continuation when the original OSC opener was evicted", async () => {
    const store = new TerminalReplayStore(32);
    store.append("s", "\u001b]52;c;evicted-clipboard-payload");
    store.append("s", "suffix\u001b\\TAIL");
    const snapshot = store.snapshot("s");
    expect(snapshot.data).not.toContain("evicted-clipboard-payload");
    expect(snapshot.data.startsWith("\u001b]999999;")).toBe(true);

    const term = new Terminal({ cols: 80, rows: 24 });
    term.reset();
    await write(term, snapshot.data);
    const visible = term.buffer.active.getLine(0)?.translateToString(true) || "";
    expect(visible).toContain("TAIL");
    expect(visible).not.toContain("evicted-clipboard-payload");
    term.dispose();
  });

  test("keeps ESC pending across executable C0 controls at an evicted boundary", async () => {
    const store = new TerminalReplayStore(96);
    const prefix = `${MODE_SETUP}${"x".repeat(100)}\u001b`;
    store.append("s", prefix);
    store.append("s", "\u0007c");
    store.append("s", "y".repeat(40));
    store.append("s", "z".repeat(20));

    const expected = new Terminal({ cols: 80, rows: 24 });
    const replayed = new Terminal({ cols: 80, rows: 24 });
    await write(expected, `${prefix}\u0007c${"y".repeat(40)}${"z".repeat(20)}`);
    await write(replayed, store.snapshot("s").data);
    expect(replayed.buffer.active.type).toBe(expected.buffer.active.type);
    expect(replayed.modes.applicationCursorKeysMode).toBe(expected.modes.applicationCursorKeysMode);
    expect(replayed.modes.bracketedPasteMode).toBe(expected.modes.bracketedPasteMode);
    expect(replayed.modes.mouseTrackingMode).toBe(expected.modes.mouseTrackingMode);
    expected.dispose();
    replayed.dispose();
  });

  test("recognizes C1 CSI as a global transition from an evicted CSI", async () => {
    const store = new TerminalReplayStore(32);
    const prefix = `${"x".repeat(100)}\u001b[?1\u009b`;
    store.append("s", prefix);
    store.append("s", "?1049h");

    const expected = new Terminal({ cols: 80, rows: 24 });
    const replayed = new Terminal({ cols: 80, rows: 24 });
    await write(expected, `${prefix}?1049h`);
    await write(replayed, store.snapshot("s").data);
    expect(replayed.buffer.active.type).toBe(expected.buffer.active.type);
    expected.dispose();
    replayed.dispose();
  });

  test("does not interpret a DEC mode CSI with an intermediate space", async () => {
    const store = new TerminalReplayStore(32);
    const stream = `\u001b[?1 h${"x".repeat(100)}`;
    store.append("s", stream);

    const expected = new Terminal({ cols: 80, rows: 24 });
    const replayed = new Terminal({ cols: 80, rows: 24 });
    await write(expected, stream);
    await write(replayed, store.snapshot("s").data);
    expect(replayed.modes.applicationCursorKeysMode).toBe(expected.modes.applicationCursorKeysMode);
    expected.dispose();
    replayed.dispose();
  });

  test("ignores DEL without ending an evicted CSI parameter sequence", async () => {
    const store = new TerminalReplayStore(32);
    const stream = `\u001b[?10\u007f49h${"x".repeat(100)}`;
    store.append("s", stream);

    const expected = new Terminal({ cols: 80, rows: 24 });
    const replayed = new Terminal({ cols: 80, rows: 24 });
    await write(expected, stream);
    await write(replayed, store.snapshot("s").data);
    expect(replayed.buffer.active.type).toBe(expected.buffer.active.type);
    expected.dispose();
    replayed.dispose();
  });

  test("does not recognize CSI after an ESC intermediate sequence", async () => {
    const store = new TerminalReplayStore(32);
    const stream = `${"x".repeat(100)}\u001b([?1049h`;
    store.append("s", stream);

    const expected = new Terminal({ cols: 80, rows: 24 });
    const replayed = new Terminal({ cols: 80, rows: 24 });
    await write(expected, stream);
    await write(replayed, store.snapshot("s").data);
    expect(replayed.buffer.active.type).toBe(expected.buffer.active.type);
    expected.dispose();
    replayed.dispose();
  });
});
