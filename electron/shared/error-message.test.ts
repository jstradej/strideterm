import { describe, expect, test } from "vitest";
import { errorMessage } from "./error-message.js";

describe("errorMessage", () => {
  test.each([
    ["plain string", "failure", "failure"],
    ["native error", new Error("failure"), "failure"],
    ["captured stderr", { error: new Error("Command failed"), stderr: "fatal: bad ref" }, "fatal: bad ref"],
    ["nested error", { error: { message: "provider failed" } }, "provider failed"],
    ["cause", { cause: new Error("root cause") }, "root cause"],
    ["unknown shape", { code: 1 }, "Unknown error"],
  ])("formats %s", (_name, value, expected) => {
    expect(errorMessage(value)).toBe(expected);
    expect(errorMessage(value)).not.toContain("[object Object]");
  });

  test("uses a caller fallback", () => {
    expect(errorMessage({ code: 1 }, "Failed")).toBe("Failed");
  });

  test("ignores whitespace-only output and breaks cause cycles", () => {
    const cycle: { stderr: string; cause?: unknown } = { stderr: "  " };
    cycle.cause = cycle;
    expect(errorMessage(cycle, "Failed")).toBe("Failed");
  });
});
