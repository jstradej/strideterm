import { describe, expect, test, beforeEach, afterEach, vi } from "vitest";
import {
  HEARTBEAT_ON_CLASS,
  HEARTBEAT_ON_MS,
  HEARTBEAT_PERIOD_MS,
  heartbeatTargetCount,
  pauseHeartbeat,
  registerHeartbeatTarget,
  resetHeartbeatForTests,
  resumeHeartbeat,
} from "./status-heartbeat.js";

/**
 * The scheduler is the whole point of the shared heartbeat: one timer, one
 * frame per phase, nothing running while the registry is empty or the window
 * is hidden. These tests stub requestAnimationFrame so the frame callbacks are
 * observable and countable, and use fake timers for the period/on windows.
 */

let rafQueue: Map<number, FrameRequestCallback>;
let rafHandle: number;
let cancelledFrames: number[];

/** Run every rAF callback still queued (one "frame"). */
function flushFrame(): void {
  const queued = [...rafQueue.values()];
  rafQueue.clear();
  for (const cb of queued) cb(0);
}

/** How many frames the scheduler has asked for and not had cancelled. */
function pendingFrames(): number {
  return rafQueue.size;
}

function makeTarget(): HTMLElement {
  const el = document.createElement("span");
  document.body.appendChild(el);
  return el;
}

function isOn(el: HTMLElement): boolean {
  return el.classList.contains(HEARTBEAT_ON_CLASS);
}

describe("status heartbeat scheduler", () => {
  let setIntervalSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    rafQueue = new Map();
    rafHandle = 0;
    cancelledFrames = [];
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      rafQueue.set(++rafHandle, cb);
      return rafHandle;
    });
    vi.stubGlobal("cancelAnimationFrame", (handle: number) => {
      cancelledFrames.push(handle);
      rafQueue.delete(handle);
    });
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
    document.documentElement.classList.remove("app-hidden");
    setIntervalSpy = vi.spyOn(globalThis, "setInterval");
    resetHeartbeatForTests();
  });

  afterEach(() => {
    resetHeartbeatForTests();
    document.body.innerHTML = "";
    setIntervalSpy.mockRestore();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  test("the first target starts exactly one timer", () => {
    registerHeartbeatTarget(makeTarget());

    expect(setIntervalSpy).toHaveBeenCalledTimes(1);
    expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), HEARTBEAT_PERIOD_MS);
  });

  test("additional targets do not start another timer", () => {
    registerHeartbeatTarget(makeTarget());
    registerHeartbeatTarget(makeTarget());
    registerHeartbeatTarget(makeTarget());

    expect(heartbeatTargetCount()).toBe(3);
    expect(setIntervalSpy).toHaveBeenCalledTimes(1);
  });

  test("every target gets and loses the pulse class in the same frame", () => {
    const a = makeTarget();
    const b = makeTarget();
    registerHeartbeatTarget(a);
    registerHeartbeatTarget(b);

    vi.advanceTimersByTime(HEARTBEAT_PERIOD_MS);
    // One frame requested for the whole tick, not one per target.
    expect(pendingFrames()).toBe(1);
    flushFrame();
    expect(isOn(a)).toBe(true);
    expect(isOn(b)).toBe(true);

    vi.advanceTimersByTime(HEARTBEAT_ON_MS);
    expect(pendingFrames()).toBe(1);
    flushFrame();
    expect(isOn(a)).toBe(false);
    expect(isOn(b)).toBe(false);
  });

  test("the on phase is bounded by HEARTBEAT_ON_MS and repeats every period", () => {
    const el = makeTarget();
    registerHeartbeatTarget(el);

    vi.advanceTimersByTime(HEARTBEAT_PERIOD_MS);
    flushFrame();
    expect(isOn(el)).toBe(true);

    // Still on one millisecond before the off timeout fires.
    vi.advanceTimersByTime(HEARTBEAT_ON_MS - 1);
    flushFrame();
    expect(isOn(el)).toBe(true);

    vi.advanceTimersByTime(1);
    flushFrame();
    expect(isOn(el)).toBe(false);

    // Next period pulses again — one timer keeps driving it.
    vi.advanceTimersByTime(HEARTBEAT_PERIOD_MS - HEARTBEAT_ON_MS);
    flushFrame();
    expect(isOn(el)).toBe(true);
    expect(setIntervalSpy).toHaveBeenCalledTimes(1);
  });

  test("the last unregister stops the timer and cleans the class up", () => {
    const a = makeTarget();
    const b = makeTarget();
    const disposeA = registerHeartbeatTarget(a);
    const disposeB = registerHeartbeatTarget(b);

    vi.advanceTimersByTime(HEARTBEAT_PERIOD_MS);
    flushFrame();
    expect(isOn(a)).toBe(true);

    disposeA();
    expect(isOn(a)).toBe(false);
    expect(heartbeatTargetCount()).toBe(1);

    disposeB();
    expect(isOn(b)).toBe(false);
    expect(heartbeatTargetCount()).toBe(0);

    // Timer is gone: no further frames are ever requested.
    vi.advanceTimersByTime(HEARTBEAT_PERIOD_MS * 5);
    expect(pendingFrames()).toBe(0);
  });

  test("disposers are idempotent and a re-register restarts the single timer", () => {
    const el = makeTarget();
    const dispose = registerHeartbeatTarget(el);
    dispose();
    dispose();
    expect(heartbeatTargetCount()).toBe(0);

    registerHeartbeatTarget(el);
    expect(heartbeatTargetCount()).toBe(1);
    expect(setIntervalSpy).toHaveBeenCalledTimes(2);
  });

  test("no timer runs while nothing is registered", () => {
    expect(setIntervalSpy).not.toHaveBeenCalled();
    vi.advanceTimersByTime(HEARTBEAT_PERIOD_MS * 10);
    expect(pendingFrames()).toBe(0);
  });

  test("registering while hidden does not start a timer, resume does", () => {
    pauseHeartbeat();
    const el = makeTarget();
    registerHeartbeatTarget(el);

    expect(setIntervalSpy).not.toHaveBeenCalled();
    vi.advanceTimersByTime(HEARTBEAT_PERIOD_MS * 3);
    expect(pendingFrames()).toBe(0);

    resumeHeartbeat();
    expect(setIntervalSpy).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(HEARTBEAT_PERIOD_MS);
    flushFrame();
    expect(isOn(el)).toBe(true);
  });

  test("hiding the window stops the timer and clears the class; restore resumes it", () => {
    const el = makeTarget();
    registerHeartbeatTarget(el);

    vi.advanceTimersByTime(HEARTBEAT_PERIOD_MS);
    flushFrame();
    expect(isOn(el)).toBe(true);

    pauseHeartbeat();
    expect(isOn(el)).toBe(false);
    vi.advanceTimersByTime(HEARTBEAT_PERIOD_MS * 4);
    expect(pendingFrames()).toBe(0);

    resumeHeartbeat();
    vi.advanceTimersByTime(HEARTBEAT_PERIOD_MS);
    flushFrame();
    expect(isOn(el)).toBe(true);
  });

  test("resume with an empty registry does not start a timer", () => {
    pauseHeartbeat();
    resumeHeartbeat();

    expect(setIntervalSpy).not.toHaveBeenCalled();
    vi.advanceTimersByTime(HEARTBEAT_PERIOD_MS * 3);
    expect(pendingFrames()).toBe(0);
  });

  test("a document that reports hidden keeps the scheduler idle", () => {
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });

    registerHeartbeatTarget(makeTarget());

    expect(setIntervalSpy).not.toHaveBeenCalled();
  });

  test("html.app-hidden stops the next beat even if the timer is already running", () => {
    const el = makeTarget();
    registerHeartbeatTarget(el);
    expect(setIntervalSpy).toHaveBeenCalledTimes(1);

    document.documentElement.classList.add("app-hidden");
    vi.advanceTimersByTime(HEARTBEAT_PERIOD_MS);

    expect(pendingFrames()).toBe(0);
    expect(isOn(el)).toBe(false);
    // Timer really stopped — later periods request nothing either.
    vi.advanceTimersByTime(HEARTBEAT_PERIOD_MS * 3);
    expect(pendingFrames()).toBe(0);
  });

  test("unregistering during the on phase leaves neither class nor element reference", () => {
    const a = makeTarget();
    const b = makeTarget();
    const disposeA = registerHeartbeatTarget(a);
    registerHeartbeatTarget(b);

    vi.advanceTimersByTime(HEARTBEAT_PERIOD_MS);
    flushFrame();
    expect(isOn(a)).toBe(true);

    // Unmount mid-"on": the class must go immediately, and the off frame must
    // not resurrect a reference to the detached element.
    disposeA();
    a.remove();
    expect(isOn(a)).toBe(false);
    expect(heartbeatTargetCount()).toBe(1);

    vi.advanceTimersByTime(HEARTBEAT_ON_MS);
    flushFrame();
    expect(isOn(a)).toBe(false);
    expect(isOn(b)).toBe(false);

    vi.advanceTimersByTime(HEARTBEAT_PERIOD_MS - HEARTBEAT_ON_MS);
    flushFrame();
    expect(isOn(a)).toBe(false);
    expect(isOn(b)).toBe(true);
  });

  test("pausing mid-on cancels the pending off frame", () => {
    const el = makeTarget();
    registerHeartbeatTarget(el);

    vi.advanceTimersByTime(HEARTBEAT_PERIOD_MS);
    flushFrame();
    expect(isOn(el)).toBe(true);

    pauseHeartbeat();
    expect(isOn(el)).toBe(false);

    // The off timeout was cleared, so no frame is queued when it would have run.
    vi.advanceTimersByTime(HEARTBEAT_ON_MS);
    expect(pendingFrames()).toBe(0);
  });

  test("pausing between the beat and its frame cancels the queued frame", () => {
    const el = makeTarget();
    registerHeartbeatTarget(el);

    vi.advanceTimersByTime(HEARTBEAT_PERIOD_MS);
    expect(pendingFrames()).toBe(1);

    pauseHeartbeat();
    expect(cancelledFrames).toHaveLength(1);
  });
});
