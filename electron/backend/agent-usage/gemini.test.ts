import { afterEach, describe, expect, it, vi } from "vitest";
import { createGeminiUsageObserver } from "./gemini.js";

const { readGeminiUsage, observeGeminiTerminalOutput, observeGeminiRateLimit, clearGeminiUsageObservation } =
  createGeminiUsageObserver();
const NOW = 1_800_000_000_000;
const MODEL_ROW = "Pro ▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬ 25% Resets: 1:30 PM (1h 30m)";

afterEach(() => {
  clearGeminiUsageObservation("gemini-session");
  clearGeminiUsageObservation("other-session");
  vi.useRealTimers();
});

describe("passive Gemini CLI usage observation", () => {
  it("parses the upstream model quota row format", () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    observeGeminiTerminalOutput(
      "gemini-session",
      `Model usage\n${MODEL_ROW}\nFlash ▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬ 4% Resets: 1:30 PM (30m)\n`,
      NOW,
    );

    expect(readGeminiUsage("gemini-session")).toEqual({
      provider: "gemini",
      checkedAt: NOW,
      windows: [
        { label: "Pro", scope: "Pro", usedPercent: 25, rounded: true, resetsAt: NOW + 5_400_000 },
        { label: "Flash", scope: "Flash", usedPercent: 4, rounded: true, resetsAt: NOW + 1_800_000 },
      ],
    });
  });

  it("ignores conversation percentages and unsupported layouts", () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    observeGeminiTerminalOutput(
      "gemini-session",
      "context window 80% remaining\nQuota: 23% used\nGemini is at 429\n",
      NOW,
    );
    expect(readGeminiUsage("gemini-session").windows).toEqual([]);
  });

  it("expires snapshots after reset and freshness deadline", () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    observeGeminiTerminalOutput("gemini-session", MODEL_ROW, NOW);
    expect(readGeminiUsage("gemini-session").windows).toHaveLength(1);
    vi.setSystemTime(NOW + 5_400_001);
    expect(readGeminiUsage("gemini-session").unavailable).toBe(
      "Open /model or /stats model in Gemini CLI to check the quota for this account.",
    );
  });

  it("reports only a confirmed, session-scoped throttle and never fabricates a percentage", () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    observeGeminiRateLimit("gemini-session", NOW, NOW + 60_000);
    expect(readGeminiUsage("gemini-session")).toEqual({
      provider: "gemini",
      checkedAt: NOW,
      windows: [],
      unavailable: `Gemini CLI reported a rate limit at ${new Date(NOW).toISOString()} in the active local session. Open /model or /stats model in Gemini CLI to check quota.`,
    });
    expect(readGeminiUsage("other-session").windows).toEqual([]);
  });

  it("does not return another session's observation and clears removed sessions", () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    observeGeminiTerminalOutput("other-session", MODEL_ROW, NOW);
    expect(readGeminiUsage("gemini-session").windows).toEqual([]);
    expect(readGeminiUsage(undefined).windows).toEqual([]);
    clearGeminiUsageObservation("other-session");
    expect(readGeminiUsage("other-session").windows).toEqual([]);
  });
});
