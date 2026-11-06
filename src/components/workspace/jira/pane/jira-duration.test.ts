import { describe, expect, test } from "vitest";
import { parseJiraDuration } from "./jira-duration.js";

describe("parseJiraDuration", () => {
  test.each([
    ["1h 30m", 5400],
    ["1h30m", 5400],
    ["45m", 2700],
    ["2h", 7200],
    ["1.5h", 5400],
    ["1,5h", 5400],
    ["  2H 15M ", 8100],
    ["90m", 5400],
    ["30 m", 1800],
  ])("%s is %i seconds", (input, seconds) => {
    expect(parseJiraDuration(input)).toEqual({ ok: true, seconds });
  });

  test.each(["", "   ", "abc", "90", "1d", "h", "1h h", "1h 2h", "1..5h", "1h30", "0m", "0.5m", "25h"])(
    "%j is refused with a message",
    (input) => {
      const result = parseJiraDuration(input);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.length).toBeGreaterThan(5);
    },
  );
});
