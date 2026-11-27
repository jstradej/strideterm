import { describe, expect, it } from "vitest";
import { adviseResetCredit, assessUsagePace, recommendNextUsageAccount, selectPacingWindow } from "./usage-pace.js";
import type { AgentUsage, UsageWindow } from "../../electron/shared/agent-usage.js";

const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;
const NOW = Date.parse("2030-01-01T12:00:00Z");
const window = (
  label: string,
  usedPercent: number,
  duration: number,
  elapsed: number,
): UsageWindow & { durationMinutes: number } => ({
  label,
  usedPercent,
  durationMinutes: duration / 60_000,
  resetsAt: NOW + duration - elapsed,
});

describe("recommendNextUsageAccount", () => {
  const spare: AgentUsage = { provider: "claude", checkedAt: NOW, windows: [window("Weekly", 15, 7 * DAY, 3 * DAY)] };
  const limited: AgentUsage = { provider: "codex", checkedAt: NOW, windows: [window("Weekly", 80, 7 * DAY, 3 * DAY)] };

  it("keeps the same next-task decision regardless of provider order", () => {
    expect(recommendNextUsageAccount([limited, spare])).toEqual(recommendNextUsageAccount([spare, limited]));
    expect(recommendNextUsageAccount([limited, spare])?.provider).toBe("claude");
  });

  it("needs an account forecast on both sides of a recommendation", () => {
    const modelOnly = { ...spare, windows: spare.windows.map((w) => ({ ...w, scope: "Fable" })) };
    expect(recommendNextUsageAccount([limited, modelOnly])).toBeUndefined();
    expect(recommendNextUsageAccount([{ ...limited, unavailable: "CLI offline" }, spare])).toBeUndefined();
  });
});

describe("assessUsagePace", () => {
  it("projects at a steady average pace and estimates when the limit is reached", () => {
    const result = assessUsagePace(window("5-hour", 70, 5 * HOUR, 3 * HOUR), NOW);
    expect(result.state).toBe("slow-down");
    expect(result.elapsedPercent).toBe(60);
    expect(result.projectedUsedPercent).toBeCloseTo(116.6667, 3);
    expect(result.reachesLimitAt).toBeCloseTo(NOW + 5 * HOUR * (100 / 116.6666667) - 3 * HOUR, -2);
  });

  it("is neutral within the projection band", () => {
    expect(assessUsagePace(window("5-hour", 50, 5 * HOUR, 2.5 * HOUR), NOW).state).toBe("on-track");
  });

  it("catches a small projected overshoot that would consume the last day's allowance early", () => {
    expect(assessUsagePace(window("Weekly", 99, 7 * DAY, 6.6 * DAY), NOW).state).toBe("slow-down");
    expect(assessUsagePace(window("Weekly", 90, 7 * DAY, 6.8 * DAY), NOW).state).toBe("use-more");
    expect(assessUsagePace(window("Weekly", 97, 7 * DAY, 6.8 * DAY), NOW).state).toBe("on-track");
  });

  it("waits for a useful sample, except for a strong early overuse signal", () => {
    expect(assessUsagePace(window("5-hour", 1, 5 * HOUR, 5 * 60_000), NOW).state).toBe("early");
    expect(assessUsagePace(window("5-hour", 19, 5 * HOUR, 5 * 60_000), NOW).state).toBe("early");
    expect(assessUsagePace(window("5-hour", 20, 5 * HOUR, 5 * 60_000), NOW).state).toBe("slow-down");
  });

  it("uses remaining quota and time to calculate target daily use", () => {
    const result = assessUsagePace(window("Weekly", 30, 7 * DAY, 3.5 * DAY), NOW);
    expect(result.targetPerDay).toBe(20);
    expect(result.state).toBe("use-more");
  });

  it("marks exact exhaustion without reset metadata", () => {
    expect(assessUsagePace({ label: "unknown", usedPercent: 100 }, NOW).state).toBe("exhausted");
  });

  it("keeps the even-pace marker on a window that is already exhausted", () => {
    expect(assessUsagePace(window("Weekly", 100, 7 * DAY, 3.5 * DAY), NOW)).toEqual({
      state: "exhausted",
      elapsedPercent: 50,
    });
  });

  it("gives opposite advice for the same usage early and late in the window", () => {
    expect(assessUsagePace(window("Weekly", 60, 7 * DAY, 2 * DAY), NOW).state).toBe("slow-down");
    expect(assessUsagePace(window("Weekly", 60, 7 * DAY, 6 * DAY), NOW).state).toBe("use-more");
  });

  it("does not claim a rounded Gemini boundary is definitely exhausted", () => {
    expect(assessUsagePace({ label: "Pro", usedPercent: 100, rounded: true }, NOW).state).toBe("unknown");
  });

  it("does not claim exhaustion after a window reset", () => {
    expect(assessUsagePace({ label: "5-hour", usedPercent: 100, resetsAt: NOW }, NOW).state).toBe("unknown");
  });

  it("rejects missing, stale, and impossible elapsed windows", () => {
    expect(assessUsagePace({ label: "unknown", usedPercent: 12 }, NOW).state).toBe("unknown");
    expect(assessUsagePace({ label: "5-hour", usedPercent: 12, durationMinutes: 300, resetsAt: NOW }, NOW).state).toBe(
      "unknown",
    );
    expect(
      assessUsagePace({ label: "5-hour", usedPercent: 12, durationMinutes: 0, resetsAt: NOW + 4 * HOUR }, NOW).state,
    ).toBe("unknown");
    expect(assessUsagePace({ label: "5-hour", usedPercent: 12, resetsAt: NOW + 4 * HOUR }, NOW).state).toBe("unknown");
  });
});

describe("selectPacingWindow", () => {
  it("prioritizes a risky short window over a comfortable weekly window", () => {
    const short = window("5-hour", 80, 5 * HOUR, 4 * HOUR);
    const weekly = window("Weekly", 20, 7 * DAY, 3.5 * DAY);
    expect(selectPacingWindow([weekly, short], NOW)?.window).toBe(short);
  });

  it("keeps an unknown account-wide window ahead of a scoped exhausted quota", () => {
    const unknownGlobal = { label: "Account", usedPercent: 40 };
    const exhaustedScoped = { ...window("Fable", 100, 5 * HOUR, 2 * HOUR), scope: "Fable" };
    expect(selectPacingWindow([exhaustedScoped, unknownGlobal], NOW)?.window).toBe(unknownGlobal);
  });

  it("keeps a hard-exhausted account window despite a known-duration scoped candidate", () => {
    const exhaustedGlobal = { label: "Account", usedPercent: 100 };
    const scoped = { ...window("Fable", 10, 7 * DAY, 2 * DAY), scope: "Fable" };
    expect(selectPacingWindow([scoped, exhaustedGlobal], NOW)?.window).toBe(exhaustedGlobal);
  });

  it("chooses the soonest projected limit within the slow-down category", () => {
    const urgent = window("Urgent", 90, 5 * HOUR, 3 * HOUR);
    const lessUrgent = window("Less urgent", 70, 5 * HOUR, 3 * HOUR);
    expect(selectPacingWindow([lessUrgent, urgent], NOW)?.window).toBe(urgent);
  });

  it("chooses the most constraining projection within use-more", () => {
    const closer = window("Closer", 24, 7 * DAY, 2 * DAY);
    const looser = window("Looser", 40, 7 * DAY, 4 * DAY);
    expect(selectPacingWindow([looser, closer], NOW)?.window).toBe(closer);
  });

  it("does not mask an unknown account-wide window with a known window", () => {
    const unknownLong = { label: "Custom pool", usedPercent: 1, resetsAt: NOW + 3 * DAY };
    const known = window("5-hour", 30, 5 * HOUR, 2.5 * HOUR);
    expect(selectPacingWindow([unknownLong, known], NOW)?.window).toBe(unknownLong);
  });

  it("prefers a window with a forecast over one that just reset", () => {
    const fresh = window("5-hour", 0, 5 * HOUR, 5 * 60_000);
    const weekly = window("7-day", 5, 7 * DAY, DAY);
    expect(selectPacingWindow([fresh, weekly], NOW)?.window).toBe(weekly);
  });

  it("does not combine usage from independent pools", () => {
    const windows = [window("Team A", 70, DAY, 12 * HOUR), window("Team B", 70, DAY, 12 * HOUR)];
    expect(selectPacingWindow(windows, NOW)?.pace.projectedUsedPercent).toBe(140);
  });

  it("prefers provider-wide windows over exhausted scoped model windows", () => {
    const windows = [
      { ...window("Fable weekly", 100, 7 * DAY, 3 * DAY), scope: "Fable" },
      window("5-hour", 25, 5 * HOUR, 2 * HOUR),
    ];
    expect(selectPacingWindow(windows, NOW)?.window.label).toBe("5-hour");
  });

  it("selects the tightest scoped window only when no provider-wide window exists", () => {
    const broad = { ...window("Weekly (Fable)", 10, 7 * DAY, 2 * DAY), scope: "Fable" };
    const tight = { ...window("5-hour (Opus)", 30, 5 * HOUR, 3 * HOUR), scope: "Opus" };
    expect(selectPacingWindow([broad, tight], NOW)?.window).toBe(tight);
  });
});

describe("adviseResetCredit", () => {
  const advise = (w: UsageWindow, credits?: { available: number; expiresAt: number[] }) =>
    adviseResetCredit(w, assessUsagePace(w, NOW), credits, NOW);
  const credits = { available: 3, expiresAt: [NOW - HOUR, NOW + DAY, NOW + 10 * DAY] };

  it("gives no advice without available credits", () => {
    expect(advise(window("Weekly", 100, 7 * DAY, 3 * DAY))).toBeUndefined();
    expect(advise(window("Weekly", 100, 7 * DAY, 3 * DAY), { available: 0, expiresAt: [] })).toBeUndefined();
  });

  it("recommends a reset only near the limit with real time left", () => {
    expect(advise(window("Weekly", 100, 7 * DAY, 3 * DAY), credits)?.state).toBe("use-now");
    expect(advise(window("Weekly", 92, 7 * DAY, 3 * DAY), credits)?.state).toBe("use-now");
    expect(advise(window("Weekly", 100, 7 * DAY, 7 * DAY - 2 * HOUR), credits)?.state).toBe("wait-for-reset");
  });

  it("keeps credits at low usage and plans one when the pace runs out early", () => {
    expect(advise(window("Weekly", 20, 7 * DAY, 3 * DAY), credits)?.state).toBe("keep");
    expect(advise(window("Weekly", 70, 7 * DAY, 3 * DAY), credits)?.state).toBe("at-limit-later");
  });

  it("ignores expired credits and counts those expiring before the window resets", () => {
    const advice = advise(window("Weekly", 20, 7 * DAY, 3 * DAY), credits);
    expect(advice).toMatchObject({ available: 3, nextExpiresAt: NOW + DAY, expiringBeforeReset: 1 });
  });
});
