import { describe, expect, test, beforeEach } from "vitest";
import { shouldShowSystemNotification, _resetSystemNotificationDedupeForTest } from "./system-notification-dedupe.js";

describe("system notification dedupe (multi-window OS popup collapse)", () => {
  beforeEach(() => {
    _resetSystemNotificationDedupeForTest();
  });

  test("first notification for a key is shown", () => {
    expect(shouldShowSystemNotification("ws-1:ws-1:shell", 1_000)).toBe(true);
  });

  test("second identical notification within the window is suppressed", () => {
    // Two unfocused windows of the same profile fire the same alert almost
    // simultaneously — only the first OS popup may appear.
    expect(shouldShowSystemNotification("ws-1:ws-1:shell", 1_000)).toBe(true);
    expect(shouldShowSystemNotification("ws-1:ws-1:shell", 1_200)).toBe(false);
  });

  test("same key fires again after the dedupe window expires", () => {
    expect(shouldShowSystemNotification("ws-1:ws-1:shell", 1_000)).toBe(true);
    expect(shouldShowSystemNotification("ws-1:ws-1:shell", 7_000)).toBe(true);
  });

  test("different keys never dedupe each other", () => {
    expect(shouldShowSystemNotification("ws-1:ws-1:shell", 1_000)).toBe(true);
    expect(shouldShowSystemNotification("ws-2:ws-2:shell", 1_001)).toBe(true);
  });

  test("empty key is never deduped (callers without session context)", () => {
    expect(shouldShowSystemNotification("", 1_000)).toBe(true);
    expect(shouldShowSystemNotification("", 1_001)).toBe(true);
  });
});
