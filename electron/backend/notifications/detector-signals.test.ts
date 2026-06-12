import { describe, expect, test } from "vitest";
import { hasRecentAnimation, SPINNER_RE } from "./detector-signals.js";

describe("hasRecentAnimation", () => {
  test("plain output with paths, flags, and dashes is NOT animation", () => {
    // Before the ASCII-class removal, any /, |, \ or - matched SPINNER_RE,
    // so virtually every chunk read as "animating" and the signal was noise.
    expect(hasRecentAnimation("Building C:/work/strideterm — done")).toBe(false);
    expect(hasRecentAnimation("run with --verbose flag")).toBe(false);
    expect(hasRecentAnimation("path\\to\\file and a | pipe")).toBe(false);
  });

  test("braille and block spinner frames ARE animation", () => {
    expect(hasRecentAnimation("⠋ working")).toBe(true);
    expect(hasRecentAnimation("▉▉▉")).toBe(true);
  });

  test("cursor movement and progress bars ARE animation", () => {
    expect(hasRecentAnimation("\u001b[2K")).toBe(true);
    expect(hasRecentAnimation("[===>   ] 42%")).toBe(true);
  });

  test("empty chunk is not animation", () => {
    expect(hasRecentAnimation("")).toBe(false);
  });
});

describe("SPINNER_RE", () => {
  test("no longer matches bare ASCII slash/pipe/dash", () => {
    expect(SPINNER_RE.test("/")).toBe(false);
    expect(SPINNER_RE.test("|")).toBe(false);
    expect(SPINNER_RE.test("-")).toBe(false);
    expect(SPINNER_RE.test("\\")).toBe(false);
  });
});
