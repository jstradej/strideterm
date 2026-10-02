import { describe, expect, test } from "vitest";
import { recentTerminalExcerpt } from "./notification-context.js";
import { sanitizeTerminalText } from "./terminal-text.js";

const ESC = "\u001b";

// What Claude Code's TUI really draws: words separated by CSI C, not spaces.
const czechWords = ["Dnes", "je", "také", "Mezinárodní", "den", "kávy"];
const czechTui = czechWords.join(`${ESC}[1C`);

describe("sanitizeTerminalText", () => {
  test("drops focus and mouse reports and keeps the words, ESC present", () => {
    const raw =
      `${ESC}[O${ESC}[O${ESC}[<35;104;24M${ESC}[I${ESC}[<0;104;24M${ESC}[<0;104;24m` + `Jakýkoli den${ESC}[1Cje dnes`;
    expect(sanitizeTerminalText(raw)).toBe("Jakýkoli den je dnes");
  });

  test("drops the same reports when the shell echoed them without their ESC", () => {
    const stripped = "[O[O[<35;104;24M[I[<0;104;24M[<0;104;24mjkay je dnes";
    const text = sanitizeTerminalText(stripped);
    expect(text).toBe("jkay je dnes");
    expect(text).not.toMatch(/\[O|\[I|\[<\d/);
  });

  test("handles the exact reported preview", () => {
    const text = sanitizeTerminalText(`[O[O[<35;104;24M[I[<0;104;24M[<0;104;24mjkay je dn\n${czechTui}.`);
    expect(text).not.toMatch(/\[O|\[I|\[<\d/);
    expect(text).toBe("jkay je dn\nDnes je také Mezinárodní den kávy.");
  });

  test("cursor-forward becomes that many spaces, minimum one", () => {
    expect(sanitizeTerminalText(`a${ESC}[3Cb`)).toBe("a b");
    expect(sanitizeTerminalText(`a${ESC}[Cb`)).toBe("a b");
    expect(sanitizeTerminalText(`a${ESC}[0Cb`)).toBe("a b");
    expect(sanitizeTerminalText(`a${ESC}[Cb${ESC}[Cc`)).toBe("a b c");
  });

  test("absolute column keeps words apart, a new row starts a new line", () => {
    expect(sanitizeTerminalText(`one${ESC}[40Gtwo`)).toBe("one two");
    expect(sanitizeTerminalText(`${ESC}[2;1Hfirst${ESC}[3;1Hsecond`)).toBe("first\nsecond");
    expect(sanitizeTerminalText(`first${ESC}[1Bsecond`)).toBe("first\nsecond");
  });

  test("strips SGR colours and other private-mode CSI in full", () => {
    expect(sanitizeTerminalText(`${ESC}[1;31mError${ESC}[0m: ${ESC}[38;5;123mboom${ESC}[39m`)).toBe("Error: boom");
    expect(sanitizeTerminalText(`${ESC}[?25l${ESC}[?2004hready${ESC}[?25h`)).toBe("ready");
    expect(sanitizeTerminalText(`${ESC}[>4;2mx${ESC}[=1u`)).toBe("x");
  });

  test("strips OSC (BEL and ST terminated) and DCS/APC, even without a terminator", () => {
    expect(sanitizeTerminalText(`${ESC}]0;my title\u0007hello`)).toBe("hello");
    expect(sanitizeTerminalText(`${ESC}]8;;https://x.test${ESC}\\link${ESC}]8;;${ESC}\\`)).toBe("link");
    expect(sanitizeTerminalText(`${ESC}Pq#0;2;0;0;0${ESC}\\after`)).toBe("after");
    expect(sanitizeTerminalText(`${ESC}_Gi=1;data${ESC}\\after`)).toBe("after");
    // unterminated: ends at the line, the next line survives
    expect(sanitizeTerminalText(`${ESC}]0;never closed\nnext line`)).toBe("next line");
  });

  test("strips two-byte ESC sequences and C0 controls but keeps tabs and newlines", () => {
    expect(sanitizeTerminalText(`${ESC}(B${ESC}7${ESC}=a\u0000b\u0008c\u0007d`)).toBe("abcd");
    expect(sanitizeTerminalText("a\tb\nc")).toBe("a b\nc");
  });

  test("CR: CRLF is one newline, a lone CR starts a new line (progress output)", () => {
    expect(sanitizeTerminalText("one\r\ntwo")).toBe("one\ntwo");
    expect(sanitizeTerminalText("10%\r50%\r100%\r\ndone")).toBe("10%\n50%\n100%\ndone");
  });

  test("collapses whitespace runs and blank lines", () => {
    expect(sanitizeTerminalText("  a   b \n\n\n   c\t\td  ")).toBe("a b\nc d");
  });

  test("leaves plain text with diacritics untouched", () => {
    const text = "Příliš žluťoučký kůň úpěl ďábelské ódy – 🧪 výsledek";
    expect(sanitizeTerminalText(text)).toBe(text);
  });

  test("does not mistake ordinary brackets for reports", () => {
    for (const text of [
      "[I]",
      "[Ok] done",
      "see [1] and [2,3]",
      "arr[0] = 1; [<name>] x",
      "[INFO] started",
      "[Output] ready",
      "[I am here",
    ]) {
      expect(sanitizeTerminalText(text)).toBe(text);
    }
  });

  test("a lone bare focus report is text, but two in a row are reports", () => {
    expect(sanitizeTerminalText("[O")).toBe("[O");
    expect(sanitizeTerminalText("[O[I")).toBe("");
    expect(sanitizeTerminalText("PS> [O[I[<0;1;1M")).toBe("PS>");
  });

  test("empty and non-string input", () => {
    expect(sanitizeTerminalText("")).toBe("");
    expect(sanitizeTerminalText(undefined)).toBe("");
    expect(sanitizeTerminalText(null)).toBe("");
  });
});

describe("recentTerminalExcerpt through the shared sanitizer", () => {
  test("the reported tail reads as sentences with the junk line gone", () => {
    const junk = "[O[O[<35;104;24M[I[<0;104;24M[<0;104;24m";
    const raw = `${junk}\r\n${ESC}[2K${czechTui}${ESC}[1CDnes jsme\r\n${ESC}]0;claude\u0007done`;
    const excerpt = recentTerminalExcerpt(raw);
    expect(excerpt).toBe("Dnes je také Mezinárodní den kávy Dnes jsme\ndone");
    expect(excerpt).not.toMatch(/\[O|\[I|\[<\d/);
  });
});
