import { describe, expect, test } from "vitest";
import { CodexTerminalNotifications } from "./codex-terminal-notifications.js";

describe("Codex terminal questions", () => {
  test.each(["\u0007", "\u001b\\"])("handles every chunk boundary with terminator %j", (end) => {
    const text = `\u001b]9;Plan mode prompt: Which device?${end}`;
    for (let split = 0; split <= text.length; split++) {
      const parser = new CodexTerminalNotifications();
      expect([...parser.feed(text.slice(0, split)), ...parser.feed(text.slice(split))]).toEqual([
        "Plan mode prompt: Which device?",
      ]);
    }
  });

  test("ignores text, completion, other OSC commands and malformed messages", () => {
    const parser = new CodexTerminalNotifications();
    expect(parser.feed("Queued follow-up inputs\nQuestion requested\nWhich device?")).toEqual([]);
    expect(parser.feed("\u001b]9;Agent turn complete\u0007\u001b]0;Question requested\u0007")).toEqual([]);
    expect(parser.feed("\u001b]9;Plan mode prompt: bad\u001b[2J\u0007")).toEqual([]);
    expect(parser.feed(`\u001b]9;${"x".repeat(5000)}`)).toEqual([]);
    expect(parser.feed("\u001b]9;Question requested\u0007")).toEqual(["Question requested"]);
  });

  test("deduplicates immediate repeats but keeps distinct and later questions", () => {
    const parser = new CodexTerminalNotifications();
    const message = "\u001b]9;Question requested\u0007";
    expect(parser.feed(message + message, 100)).toEqual(["Question requested"]);
    expect(parser.feed("\u001b]9;2 questions requested\u0007", 101)).toEqual(["2 questions requested"]);
    expect(parser.feed(message, 4000)).toEqual(["Question requested"]);
  });
});
