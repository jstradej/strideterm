/* eslint-disable security/detect-unsafe-regex -- regexes run on a fixed local capture, not network input */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildNotificationBody, recentTerminalExcerpt } from "./notification-context.js";
import { sanitizeTerminalText } from "./terminal-text.js";

/**
 * Real data, not a hand-written escape string: the PTY bytes of an interactive
 * Claude Code session (v2.1.287, node-pty / ConPTY, 104x30) that was asked for
 * two short Czech sentences about today's date, without tools. See
 * `__fixtures__/claude-code-tui-answer.json` for how it was captured and the one
 * redaction (the Windows user name).
 *
 *  - `direct`: claude.exe straight in the PTY. The stream carries the folder-trust
 *    dialog, the prompt typed character by character, the spinner, the answer, and
 *    the screen teardown after `/exit`.
 *  - `shell`: pwsh -> claude -> answer -> /exit -> back at the shell prompt.
 *
 * What the stream looks like: Claude Code's TUI never writes a space between
 * words. It writes `Dnes\x1b[1Cje\x1b[1Ctvrtek` (CSI 1 C, cursor forward) and puts
 * lines at `\x1b[9;1H` (CUP). A parser that just deletes sequences yields
 * `Dnesjectvrtek`.
 */
type Capture = { description: string; prompt: string; direct: string; shell: string };
const capture = JSON.parse(
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- fixed fixture URL
  readFileSync(new URL("./__fixtures__/claude-code-tui-answer.json", import.meta.url), "utf8"),
) as Capture;

/**
 * The bytes the replay buffer holds when the agent's `Stop` hook raises the
 * "Agent finished" alert: everything up to the frame that prints "done <time>"
 * under the answer, before the user (or this capture) typed `/exit`.
 */
function atStop(stream: string): string {
  const done = stream.indexOf("· done");
  expect(done).toBeGreaterThan(0);
  const frameEnd = stream.indexOf("\u001b[?25h", done);
  expect(frameEnd).toBeGreaterThan(done);
  return stream.slice(0, frameEnd + "\u001b[?25h".length);
}

// The answer that Claude actually gave in each capture (read off the capture, not invented).
const CAPTURES = [
  {
    name: "direct",
    stream: capture.direct,
    answer: ["Dnes je čtvrtek 1. října 2026.", "Začíná nový měsíc a podzim je v plném proudu."],
  },
  {
    name: "shell",
    stream: capture.shell,
    answer: ["Dnes je čtvrtek 1. října 2026.", "Začíná říjen a s ním i podzim naplno."],
  },
] as const;

// Exactly what runtime.ts raiseAlert() does for an alert that has a session.
function agentFinishedBody(replayData: string): { excerpt: string; body: string } {
  const excerpt = recentTerminalExcerpt(replayData);
  const body = buildNotificationBody({
    kind: "completed",
    detail: "hook:stop",
    message: "",
    recentOutput: excerpt,
  });
  return { excerpt, body };
}

function expectCleanText(text: string): void {
  // No ESC and no other C0 control (only \n separates lines), no DEL, no C1.
  expect(text).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/);
  // Focus / mouse reports that lost their ESC.
  expect(text).not.toMatch(/\[[IO]/);
  expect(text).not.toMatch(/\[<\d/);
  // Any CSI that lost its ESC.
  expect(text).not.toMatch(/\[[<?>=]?\d+(;\d+)*[A-Za-z~]/);
}

describe("sanitizeTerminalText on a real Claude Code TUI capture", () => {
  it("the fixture really is raw TUI output (guards against a pre-cleaned fixture)", () => {
    for (const { stream } of CAPTURES) {
      expect(stream).toContain("\u001b[1C"); // CUF used as the word gap
      expect(stream).toMatch(/\u001b\[\d+;\d+H/); // CUP, absolute positioning
      expect(stream).toContain("\u001b[?25l"); // cursor hide/show per frame
      expect(stream).toContain("\u001b[?1049h"); // alternate screen
      expect(stream).toContain("\u001b[?1006h"); // SGR mouse tracking, the source of `[<35;104;24M`
      expect(stream).toContain("\u001b]0;"); // OSC window title
    }
  });

  for (const { name, stream, answer } of CAPTURES) {
    describe(name, () => {
      it("keeps the Czech answer as space-separated words in the whole stream", () => {
        const text = sanitizeTerminalText(stream);
        expectCleanText(text);
        for (const sentence of answer) expect(text).toContain(sentence);
        // The typed prompt was drawn the same way (a CUF between most words).
        expect(text).toContain(capture.prompt);
        // Words must not be glued together.
        expect(text).not.toMatch(/Dnesje|ječtvrtek|Začínánový/);
      });

      it("agent-finished alert: excerpt and body are clean text with the answer in it", () => {
        const { excerpt, body } = agentFinishedBody(atStop(stream));
        expectCleanText(excerpt);
        expectCleanText(body);
        expect(body.startsWith("Agent finished\n\nRecent terminal output:\n")).toBe(true);
        for (const sentence of answer) expect(body).toContain(sentence);
      });

      it("the same buffer after /exit (screen teardown) is still clean text", () => {
        const { excerpt, body } = agentFinishedBody(stream);
        expectCleanText(excerpt);
        expectCleanText(body);
      });

      it("a focus / mouse report burst echoed after the capture does not reach the excerpt", () => {
        // The capture itself shows no echo (Claude Code consumed the reports and pwsh swallowed
        // them), so this appends the bytes a shell WITHOUT an escape parser types back, as the
        // phone reported: the burst written into the PTY input during the capture, ESC stripped.
        const echoed = "[O[O[<35;104;24M[I[<0;104;24M[<0;104;24m";
        const { excerpt, body } = agentFinishedBody(atStop(stream) + echoed);
        expectCleanText(excerpt);
        expectCleanText(body);
        for (const sentence of answer) expect(body).toContain(sentence);
      });
    });
  }
});
