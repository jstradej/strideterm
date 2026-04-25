import { afterEach, describe, expect, test } from "vitest";
import {
  recordDismissed,
  recordInteraction,
  forget,
  adaptiveMultiplier,
  isT3Disabled,
  _resetForTests,
} from "./adaptive.js";

afterEach(() => _resetForTests());

describe("adaptive suppression", () => {
  test("multiplier defaults to 1 for unknown sessions", () => {
    expect(adaptiveMultiplier("ws:panel")).toBe(1);
    expect(isT3Disabled("ws:panel")).toBe(false);
  });

  test("multiplier doubles after 3 dismissals", () => {
    recordDismissed("ws:panel");
    expect(adaptiveMultiplier("ws:panel")).toBe(1);
    recordDismissed("ws:panel");
    expect(adaptiveMultiplier("ws:panel")).toBe(1);
    recordDismissed("ws:panel");
    expect(adaptiveMultiplier("ws:panel")).toBe(2);
  });

  test("T3 disabled after 6 dismissals", () => {
    for (let i = 0; i < 5; i += 1) recordDismissed("ws:panel");
    expect(isT3Disabled("ws:panel")).toBe(false);
    recordDismissed("ws:panel");
    expect(isT3Disabled("ws:panel")).toBe(true);
  });

  test("user interaction resets counter", () => {
    for (let i = 0; i < 4; i += 1) recordDismissed("ws:panel");
    expect(adaptiveMultiplier("ws:panel")).toBe(2);
    recordInteraction("ws:panel");
    expect(adaptiveMultiplier("ws:panel")).toBe(1);
    expect(isT3Disabled("ws:panel")).toBe(false);
  });

  test("forget removes session state entirely", () => {
    for (let i = 0; i < 6; i += 1) recordDismissed("ws:panel");
    expect(isT3Disabled("ws:panel")).toBe(true);
    forget("ws:panel");
    expect(isT3Disabled("ws:panel")).toBe(false);
    expect(adaptiveMultiplier("ws:panel")).toBe(1);
  });

  test("counts are per-session", () => {
    for (let i = 0; i < 3; i += 1) recordDismissed("ws:a");
    expect(adaptiveMultiplier("ws:a")).toBe(2);
    expect(adaptiveMultiplier("ws:b")).toBe(1);
  });

  test("recordInteraction on unknown session is a no-op", () => {
    expect(() => recordInteraction("nothing")).not.toThrow();
  });
});
