import { describe, expect, it } from "vitest";
import { isValidAutomationCron, nextAutomationSlot } from "./automation-schedule.js";

describe("automation schedule", () => {
  it("only returns a future one-time slot", () => {
    const trigger = { type: "schedule", kind: "once", at: "2026-01-01T00:00:00Z" } as const;
    expect(nextAutomationSlot(trigger, new Date("2025-12-31T23:59:00Z"))?.toISOString()).toBe(
      "2026-01-01T00:00:00.000Z",
    );
    expect(nextAutomationSlot(trigger, new Date(trigger.at))).toBeNull();
  });
  it("keeps interval slots anchored across restarts", () => {
    const trigger = { type: "schedule", kind: "interval", everyMinutes: 45, anchor: "2026-01-01T00:00:00Z" } as const;
    expect(nextAutomationSlot(trigger, new Date("2026-01-01T01:00:00Z"))?.toISOString()).toBe(
      "2026-01-01T01:30:00.000Z",
    );
    expect(nextAutomationSlot(trigger, new Date("2025-12-31T23:00:00Z"))?.toISOString()).toBe(
      "2026-01-01T00:00:00.000Z",
    );
  });
  it("uses the requested timezone across daylight saving time", () => {
    const trigger = { type: "schedule", kind: "cron", expression: "0 9 * * *", timezone: "Europe/Prague" } as const;
    expect(nextAutomationSlot(trigger, new Date("2026-03-28T09:00:00Z"))?.toISOString()).toBe(
      "2026-03-29T07:00:00.000Z",
    );
  });
  it("rejects six-field cron expressions", () => {
    expect(() =>
      nextAutomationSlot({ type: "schedule", kind: "cron", expression: "* * * * * *" }, new Date()),
    ).toThrow();
  });
  it("validates five-field cron expressions, timezones and minimum spacing", () => {
    expect(isValidAutomationCron("*/5 * * * *", "Europe/Prague")).toBe(true);
    expect(isValidAutomationCron("*/2 * * * *")).toBe(false);
    expect(isValidAutomationCron("* * * * * *")).toBe(false);
    expect(isValidAutomationCron("@daily")).toBe(false);
    expect(isValidAutomationCron("0 7 * * *", "Not/AZone")).toBe(false);
  });
});
