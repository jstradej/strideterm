import { describe, expect, test, vi } from "vitest";

const { debugSpy } = vi.hoisted(() => ({ debugSpy: vi.fn() }));
vi.mock("./logger.js", () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), debug: debugSpy, error: vi.fn() }),
}));

import { parseJsonLines } from "./process-utils.js";

describe("parseJsonLines", () => {
  test("parses every line when all are valid JSON (regression guard)", () => {
    const input = ['{"a":1}', '{"b":2}', '{"c":3}'].join("\n");
    expect(parseJsonLines(input)).toEqual([{ a: 1 }, { b: 2 }, { c: 3 }]);
    expect(debugSpy).not.toHaveBeenCalled();
  });

  test("skips a non-JSON line mixed among good ones instead of throwing", () => {
    debugSpy.mockClear();
    const input = ['{"a":1}', "Warning: something printed by a CLI tool", '{"c":3}'].join("\n");

    const result = parseJsonLines(input);

    expect(result).toEqual([{ a: 1 }, { c: 3 }]);
    expect(debugSpy).toHaveBeenCalledTimes(1);
    expect(debugSpy).toHaveBeenCalledWith(
      expect.stringContaining("skipped 1"),
      expect.objectContaining({ skipped: 1 }),
    );
  });

  test("ignores blank lines without counting them as skipped", () => {
    debugSpy.mockClear();
    const input = ['{"a":1}', "", "   ", '{"b":2}'].join("\n");

    const result = parseJsonLines(input);

    expect(result).toEqual([{ a: 1 }, { b: 2 }]);
    expect(debugSpy).not.toHaveBeenCalled();
  });
});
