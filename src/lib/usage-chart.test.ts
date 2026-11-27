import { describe, expect, it } from "vitest";
import { burnChartLayout } from "./usage-chart.js";
import { assessUsagePace } from "./usage-pace.js";
import type { UsageWindow } from "../../electron/shared/agent-usage.js";

const DAY = 24 * 60 * 60_000;
const NOW = Date.parse("2030-01-01T12:00:00Z");
const layout = (usedPercent: number, elapsedDays: number, duration = 7 * DAY) => {
  const window: UsageWindow = {
    label: "Weekly",
    usedPercent,
    durationMinutes: duration / 60_000,
    resetsAt: NOW + duration - elapsedDays * DAY,
  };
  return burnChartLayout(window, assessUsagePace(window, NOW));
};

describe("burnChartLayout", () => {
  it("projects a fast pace to the limit and flags the run-out inside the plot", () => {
    const result = layout(60, 2)!;
    expect(result.nowX).toBeCloseTo((2 / 7) * 100, 5);
    expect(result.usedY).toBe(40);
    expect(result.runoutX).toBeCloseTo(((2 / 7) * 100 * 100) / 60, 5);
    expect(result.projection).toMatchObject({ y: 0, hitsLimit: true });
    expect(result.flagX).toBeLessThanOrEqual(74);
    expect(result.flagX).toBeGreaterThanOrEqual(16);
  });

  it("projects a slow pace to the reset without a run-out zone", () => {
    const result = layout(10, 3)!;
    expect(result.runoutX).toBeUndefined();
    expect(result.projection?.x).toBe(100);
    expect(result.projection?.y).toBeCloseTo(100 - (10 / 3) * 7, 5);
    expect(result.projection?.hitsLimit).toBe(false);
  });

  it("draws no projection when the pace is exhausted or too early", () => {
    expect(layout(100, 3)?.projection).toBeUndefined();
    expect(layout(1, 0.001)?.projection).toBeUndefined();
  });

  it("moves the value label away from the corners and edges", () => {
    expect(layout(30, 3)?.labelPlacement).toBe("above");
    expect(layout(2, 3)?.labelPlacement).toBe("right");
    expect(layout(95, 3)?.labelPlacement).toBe("left");
    expect(layout(30, 0.3)?.labelPlacement).toBe("right");
    expect(layout(5, 6.5)?.labelPlacement).toBe("left");
  });

  it("hides the now label close to either edge", () => {
    expect(layout(30, 3)?.showNowAxisLabel).toBe(true);
    expect(layout(30, 0.5)?.showNowAxisLabel).toBe(false);
    expect(layout(30, 6.5)?.showNowAxisLabel).toBe(false);
  });

  it("has no chart without timing", () => {
    const window: UsageWindow = { label: "Daily", usedPercent: 5 };
    expect(burnChartLayout(window, assessUsagePace(window, NOW))).toBeUndefined();
  });
});
