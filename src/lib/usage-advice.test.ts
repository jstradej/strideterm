import { describe, expect, it } from "vitest";
import {
  adviceText,
  countdown,
  paceRates,
  presentProvider,
  resetAdviceText,
  resetCreditHeadline,
  toneColor,
  toneForState,
  verdictText,
  withoutScope,
} from "./usage-advice.js";
import { adviseResetCredit, assessUsagePace } from "./usage-pace.js";
import type { AgentUsage, UsageWindow } from "../../electron/shared/agent-usage.js";

const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;
const NOW = Date.parse("2030-01-01T12:00:00Z");
const window = (usedPercent: number, duration: number, elapsed: number): UsageWindow => ({
  label: "Weekly",
  usedPercent,
  durationMinutes: duration / 60_000,
  resetsAt: NOW + duration - elapsed,
});
const present = (w: UsageWindow) => {
  const entry: AgentUsage = { provider: "codex", checkedAt: NOW, windows: [w] };
  return presentProvider(entry).selected!;
};

describe("tones", () => {
  it("maps pace states to theme tokens that exist in every theme", () => {
    expect(toneForState("slow-down")).toBe("warning");
    expect(toneForState("exhausted")).toBe("danger");
    expect(toneForState("use-more")).toBe("good");
    expect(toneForState("early")).toBe("neutral");
    expect(toneColor("warning")).toBe("var(--status-paused)");
    expect(toneColor("good")).toBe("var(--success)");
    expect(toneColor("danger")).toBe("var(--danger)");
    expect(toneColor("neutral")).toBe("var(--muted)");
  });
});

describe("formatting helpers", () => {
  it("formats countdowns and strips repeated scopes", () => {
    expect(countdown(NOW + 5 * 60_000, NOW)).toBe("5m");
    expect(countdown(NOW + 3 * HOUR + 10 * 60_000, NOW)).toBe("3h 10m");
    expect(countdown(NOW + 2 * DAY + 4 * HOUR, NOW)).toBe("2d 4h");
    expect(countdown(NOW - 1000, NOW)).toBe("0m");
    expect(withoutScope("Opus weekly", "Opus")).toBe("weekly");
    expect(verdictText("claude", "slow-down", "Opus")).toBe("Slow down on Claude (Opus)");
    expect(resetCreditHeadline(1)).toBe("1 reset available");
    expect(resetCreditHeadline(3)).toBe("3 resets available");
  });
});

describe("paceRates", () => {
  it("compares the average pace with the budget per day", () => {
    const w = window(60, 7 * DAY, 2 * DAY);
    const rates = paceRates(w, assessUsagePace(w, NOW), NOW);
    expect(rates?.unit).toBe("day");
    expect(rates?.user).toBe("30%/day");
    expect(rates?.budget).toBe("8%/day");
  });

  it("uses hours for short windows and the remainder in the last hour", () => {
    const short = window(70, 5 * HOUR, 3 * HOUR);
    expect(paceRates(short, assessUsagePace(short, NOW), NOW)).toMatchObject({ unit: "hour", user: "23%/hour" });
    const last = window(65, 7 * DAY, 7 * DAY - 30 * 60_000);
    expect(paceRates(last, assessUsagePace(last, NOW), NOW)).toEqual({ unit: "rest", budget: "35%" });
  });

  it("has nothing without timing", () => {
    const untimed: UsageWindow = { label: "x", usedPercent: 5 };
    expect(paceRates(untimed, assessUsagePace(untimed, NOW), NOW)).toBeUndefined();
  });
});

describe("adviceText", () => {
  it("states where the pace leads when it will run out", () => {
    const text = adviceText(present(window(60, 7 * DAY, 2 * DAY)), NOW);
    expect(text).toContain("At your pace (30%/day) this quota would run out around");
    expect(text).toContain("before it resets");
    expect(text).toContain("To last, keep to 8%/day.");
  });

  it("says how much would go unused with room left", () => {
    const text = adviceText(present(window(10, 7 * DAY, 3 * DAY)), NOW);
    expect(text).toContain("would go unused at your pace (");
    expect(text).toContain("You can spend");
  });

  it("covers exhausted, early and missing forecasts", () => {
    expect(adviceText(present(window(100, 7 * DAY, 3 * DAY)), NOW)).toBe("Weekly is exhausted at 100% used.");
    expect(adviceText(present(window(1, 7 * DAY, 60_000)), NOW)).toBe("Too little elapsed time for a steady estimate.");
    expect(adviceText(present({ label: "Daily", usedPercent: 4 }), NOW)).toBe("A forecast is unavailable for Daily.");
  });
});

describe("resetAdviceText", () => {
  const credits = { available: 3, expiresAt: [NOW + DAY, NOW + 10 * DAY, NOW + 20 * DAY] };
  const sentence = (w: UsageWindow) => {
    const pace = assessUsagePace(w, NOW);
    const advice = adviseResetCredit(w, pace, credits, NOW)!;
    return resetAdviceText(advice, w, pace, NOW);
  };

  it("recommends using a reset when the quota is nearly gone with time left", () => {
    const text = sentence(window(100, 7 * DAY, 3 * DAY));
    expect(text).toContain("Worth using now: it recovers about 100% used, with 4d 0h left until reset.");
    expect(text).toContain("1 expire before this window resets (next");
  });

  it("keeps the credit when the window resets soon on its own", () => {
    expect(sentence(window(100, 7 * DAY, 7 * DAY - 2 * HOUR))).toContain("resets on its own in 2h, so keep the reset.");
  });

  it("plans a reset for when the limit is reached and declines one at low use", () => {
    expect(sentence(window(60, 7 * DAY, 2 * DAY))).toContain("you hit the limit around");
    expect(sentence(window(20, 7 * DAY, 3 * DAY))).toContain("Not worth using now: it would recover only 20%.");
  });

  it("never claims anything about window timing", () => {
    for (const used of [20, 60, 100]) {
      expect(sentence(window(used, 7 * DAY, 3 * DAY))).not.toMatch(/restart|new window|redeem/i);
    }
  });
});
