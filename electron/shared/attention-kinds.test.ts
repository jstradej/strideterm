import { describe, expect, test } from "vitest";
import { ATTENTION_KIND_QUESTION, ATTENTION_KIND_WAITING, isInputBlockingKind } from "./attention-kinds.js";

describe("isInputBlockingKind", () => {
  test("a question blocks on a human, exactly like waiting does", () => {
    // The review's P2-11: every summary counted only `waiting`, so a
    // permission prompt — the STRONGER of the two states — got the generic
    // orange badge and a tooltip that called it a finished task.
    expect(isInputBlockingKind(ATTENTION_KIND_WAITING)).toBe(true);
    expect(isInputBlockingKind(ATTENTION_KIND_QUESTION)).toBe(true);
  });

  test("nothing else counts", () => {
    for (const kind of ["completed", "error", "info", "review", "pipeline", "subagent_done", "auto_approved"]) {
      expect(isInputBlockingKind(kind)).toBe(false);
    }
  });

  test("a missing kind is not input-blocking", () => {
    expect(isInputBlockingKind(undefined)).toBe(false);
    expect(isInputBlockingKind(null)).toBe(false);
    expect(isInputBlockingKind("")).toBe(false);
  });
});
