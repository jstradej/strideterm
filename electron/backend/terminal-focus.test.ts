import { describe, expect, test } from "vitest";
import { FOCUS_IN, FOCUS_OUT, TerminalFocusArbiter, focusReportOf } from "./terminal-focus.js";

// Several viewers share one PTY. Passing each one's ESC[I / ESC[O through let
// the last speaker win — a phone that merely connected told the app focus was
// lost while the desktop was on it. tmux combines them instead.
describe("TerminalFocusArbiter", () => {
  const S = "ws:panel";

  test("the app hears focus while any viewer has the terminal focused", () => {
    const arbiter = new TerminalFocusArbiter(() => true);

    expect(arbiter.report(S, "desktop", true)).toBe(FOCUS_IN);
    // A phone connects: its unfocused report changes nothing the app hears.
    expect(arbiter.report(S, "phone", false)).toBeNull();
    // The desktop window loses focus, the phone shows the terminal.
    expect(arbiter.report(S, "phone", true)).toBeNull();
    expect(arbiter.report(S, "desktop", false)).toBeNull();
    // The phone's page goes away too.
    expect(arbiter.report(S, "phone", false)).toBe(FOCUS_OUT);
    expect(arbiter.report(S, "phone", false)).toBeNull();
  });

  test("a viewer that goes away stops keeping the terminal focused", () => {
    const arbiter = new TerminalFocusArbiter(() => true);
    arbiter.report(S, "phone", true);
    arbiter.report("ws:other", "phone", false);
    arbiter.report("ws:other", "desktop", true);

    expect(arbiter.dropViewer("phone")).toEqual([{ sessionId: S, data: FOCUS_OUT }]);
    expect(arbiter.dropViewer("phone")).toEqual([]);
  });

  test("nothing is said to an app that has not asked for focus reports", () => {
    let wants = false;
    const arbiter = new TerminalFocusArbiter(() => wants);

    expect(arbiter.report(S, "desktop", true)).toBeNull();
    wants = true;
    // The first report after it asked is said, whatever it was told before.
    expect(arbiter.report(S, "phone", false)).toBe(FOCUS_IN);
  });

  test("an app that turns reports on again hears the current state on the next report", () => {
    const arbiter = new TerminalFocusArbiter(() => true);
    expect(arbiter.report(S, "desktop", true)).toBe(FOCUS_IN);

    arbiter.forgetTold(S);

    expect(arbiter.report(S, "desktop", true)).toBe(FOCUS_IN);
  });

  test("a restarted session starts from nothing", () => {
    const arbiter = new TerminalFocusArbiter(() => true);
    arbiter.report(S, "desktop", true);
    arbiter.report("other:panel", "desktop", true);

    arbiter.forgetSessionsWithPrefix("ws:");

    expect(arbiter.isFocused(S)).toBe(false);
    expect(arbiter.isFocused("other:panel")).toBe(true);
    expect(arbiter.report(S, "phone", false)).toBe(FOCUS_OUT);
  });

  test("only an exact focus report counts as one", () => {
    expect(focusReportOf("\x1b[I")).toBe(true);
    expect(focusReportOf("\x1b[O")).toBe(false);
    expect(focusReportOf("\x1b[Ix")).toBeNull();
    expect(focusReportOf("I")).toBeNull();
  });
});
