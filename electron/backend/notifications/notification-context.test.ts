import { describe, expect, test } from "vitest";
import {
  buildNotificationBody,
  NOTIFICATION_BODY_MAX_BYTES,
  notificationSummary,
  recentTerminalExcerpt,
  truncateUtf8End,
} from "./notification-context.js";

describe("notification context", () => {
  test("strips ANSI/OSC, normalizes carriage returns, and keeps the final lines", () => {
    const excerpt = recentTerminalExcerpt("first\r\n\u001b[31msecond\u001b[0m\n\u001b]0;title\u0007third\rfinal");
    expect(excerpt).toBe("first\nsecond\nthird\nfinal");
  });

  test("truncates by UTF-8 bytes from the end", () => {
    const value = truncateUtf8End("old line\nошибка финальная строка", 40);
    expect(Buffer.byteLength(value, "utf8")).toBeLessThanOrEqual(40);
    expect(value).toContain("финальная строка");
  });

  test("keeps an explicit message and a distinct output tail", () => {
    const body = buildNotificationBody({
      kind: "waiting",
      detail: "hook:Notification:idle_prompt",
      message: "Approve the deployment?",
      recentOutput: "building…\nready",
    });
    expect(body).toContain("Approve the deployment?");
    expect(body).toContain("Recent terminal output:");
    expect(body).toContain("ready");
    expect(Buffer.byteLength(body, "utf8")).toBeLessThanOrEqual(NOTIFICATION_BODY_MAX_BYTES);
    expect(body).not.toContain("hook:Notification");
  });

  test("prefers hook meaning over generic completed kind", () => {
    expect(notificationSummary("completed", "hook:SubagentStop")).toBe("Subagent finished");
    expect(notificationSummary("error", "exit:shell", 2)).toBe("Command failed (exit 2)");
  });

  test("does not interpret prose as hook keys and hides nested detector keys", () => {
    expect(notificationSummary("error", "Build stopped because tests failed")).toBe(
      "Build stopped because tests failed",
    );
    expect(notificationSummary("completed", "42 tests passed")).toBe("42 tests passed");
    expect(notificationSummary("waiting", "hook:Notification:idle_prompt")).toBe("Waiting for input");
    expect(notificationSummary("completed", "hook:Stop")).toBe("Agent finished");
  });

  test("keeps the last failure and a message even when output also contains it", () => {
    const message = "Approve deployment?";
    const excerpt = recentTerminalExcerpt(`${"old line\n".repeat(20)}${message}\n${"界".repeat(900)}\nFINAL ERROR`);
    expect(excerpt).toMatch(/FINAL ERROR$/);
    expect(excerpt).not.toContain("old line");
    const body = buildNotificationBody({ kind: "waiting", message, recentOutput: excerpt });
    expect(body).toContain(message);
    expect(body).toMatch(/FINAL ERROR$/);
    expect(Buffer.byteLength(body, "utf8")).toBeLessThanOrEqual(NOTIFICATION_BODY_MAX_BYTES);
    expect(buildNotificationBody({ kind: "waiting", message, recentOutput: `context\n${message}` })).toContain(
      "context",
    );
  });

  test("bounds long multilingual messages and details while retaining recent output", () => {
    for (const textField of ["message", "detail"]) {
      const body = buildNotificationBody({
        kind: "completed",
        [textField]: "🧪 výsledek ".repeat(400),
        recentOutput: "Last line",
      });
      expect(Buffer.byteLength(body, "utf8")).toBeLessThanOrEqual(NOTIFICATION_BODY_MAX_BYTES);
      expect(body).toMatch(/Last line$/);
      expect(body).not.toContain("\uFFFD");
    }
  });
});
