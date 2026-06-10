import { describe, expect, test, vi } from "vitest";
import {
  detectRateLimit,
  summarizeAttentionForProfile,
  waitForHandleRelease,
  shouldRefreshNow,
  createIntervalGate,
} from "./runtime-utils.js";

// All "now" anchors in this file are local-time Dates; the detectors operate
// in local time (Claude Code's clock-time format is the user's local zone).
const ANCHOR_MORNING = new Date(2026, 3, 26, 3, 0, 0); // 2026-04-26 03:00 local
const ANCHOR_NOON = new Date(2026, 3, 26, 12, 0, 0); // 2026-04-26 12:00 local

describe("detectRateLimit", () => {
  describe("Claude Code (/rate-limit-options dialog)", () => {
    test("matches the canonical screenshot text and parses 5:50am", () => {
      const text = "You've hit your limit · resets 5:50am (Europe/Prague)";
      const m = detectRateLimit(text, ANCHOR_MORNING);
      expect(m).not.toBeNull();
      expect(m!.providerHint).toBe("claude");
      expect(m!.needsConfirm).toBe(true);
      expect(m!.resetAt).not.toBeNull();
      expect(m!.resetAt!.getHours()).toBe(5);
      expect(m!.resetAt!.getMinutes()).toBe(50);
    });

    test("converts pm correctly", () => {
      const text = "You've hit your limit · resets 3:30pm";
      const m = detectRateLimit(text, ANCHOR_MORNING);
      expect(m!.resetAt!.getHours()).toBe(15);
      expect(m!.resetAt!.getMinutes()).toBe(30);
    });

    test("rolls forward to next day when reset time is in the past", () => {
      // Anchor at 12:00, reset 05:50 → next day 05:50
      const m = detectRateLimit("You've hit your limit · resets 5:50am", ANCHOR_NOON);
      expect(m!.resetAt!.getDate()).toBe(ANCHOR_NOON.getDate() + 1);
    });

    test("handles smart-quote apostrophe (You’ve)", () => {
      const text = "You’ve hit your limit · resets 5:50am";
      const m = detectRateLimit(text, ANCHOR_MORNING);
      expect(m).not.toBeNull();
      expect(m!.providerHint).toBe("claude");
    });

    test("ignores trailing timezone suffix and noisy context", () => {
      const text = "Brewed for 7h\nYou've hit your limit · resets 5:50am (America/New_York)\n/rate-limit-options";
      const m = detectRateLimit(text, ANCHOR_MORNING);
      expect(m).not.toBeNull();
      expect(m!.needsConfirm).toBe(true);
    });

    test("rejects malformed minutes (60+)", () => {
      const m = detectRateLimit("resets 5:75am", ANCHOR_MORNING);
      // The "hit your limit" prefix is missing AND minutes invalid → no match
      // (genericFallback also doesn't match this).
      expect(m).toBeNull();
    });

    test("12am means midnight", () => {
      const m = detectRateLimit("You've hit your limit · resets 12:00am", ANCHOR_NOON);
      expect(m!.resetAt!.getHours()).toBe(0);
    });

    test("12pm means noon", () => {
      const m = detectRateLimit("You've hit your limit · resets 12:00pm", ANCHOR_MORNING);
      expect(m!.resetAt!.getHours()).toBe(12);
    });

    // Krok 9a — the regression from incident C: current Claude Code writes
    // "session limit", which the old regex (plain "your limit") missed.
    test("matches the exact 'session limit' screenshot string", () => {
      const text = "You've hit your session limit · resets 6:10pm (Europe/Prague)";
      const m = detectRateLimit(text, ANCHOR_MORNING);
      expect(m).not.toBeNull();
      expect(m!.providerHint).toBe("claude");
      expect(m!.needsConfirm).toBe(true);
      expect(m!.resetAt!.getHours()).toBe(18);
      expect(m!.resetAt!.getMinutes()).toBe(10);
    });

    test("matches usage and weekly limit variants", () => {
      expect(detectRateLimit("You've hit your usage limit · resets 5:50am", ANCHOR_MORNING)).not.toBeNull();
      expect(detectRateLimit("You've hit your weekly limit · resets 5:50am", ANCHOR_MORNING)).not.toBeNull();
    });

    test("detects the /rate-limit-options dialog even without a parseable reset time", () => {
      const text =
        "Approaching usage limits · /upgrade to increase\n1. Stop and wait for limit to reset\n2. Request more";
      const m = detectRateLimit(text, ANCHOR_MORNING);
      expect(m).not.toBeNull();
      expect(m!.providerHint).toBe("claude");
      expect(m!.needsConfirm).toBe(true);
      expect(m!.resetAt).toBeNull();
    });
  });

  describe("Codex CLI", () => {
    test("matches 'Rate limit reached for o4-mini'", () => {
      const m = detectRateLimit("Rate limit reached for o4-mini in your subscription. Limit 200000, Used 136502.");
      expect(m).not.toBeNull();
      expect(m!.providerHint).toBe("codex");
      expect(m!.needsConfirm).toBe(false);
      expect(m!.resetAt).toBeNull();
    });

    test("matches 'rate_limit_exceeded' error code", () => {
      const m = detectRateLimit('{"error":{"code":"rate_limit_exceeded","message":"..."}}');
      expect(m!.providerHint).toBe("codex");
    });
  });

  describe("Gemini CLI", () => {
    test("parses 'Please retry in 15.002s' into resetAt", () => {
      const now = new Date(2026, 3, 26, 10, 0, 0, 0);
      const text = "Quota exceeded for metric: ... Please retry in 15.002s";
      const m = detectRateLimit(text, now);
      expect(m).not.toBeNull();
      expect(m!.providerHint).toBe("gemini");
      expect(m!.resetAt).not.toBeNull();
      const diff = m!.resetAt!.getTime() - now.getTime();
      expect(diff).toBe(Math.ceil(15.002 * 1000));
    });

    test("matches 'Quota exceeded' without retry time", () => {
      const m = detectRateLimit("Quota exceeded for metric: generativelanguage.googleapis.com");
      expect(m!.providerHint).toBe("gemini");
      expect(m!.resetAt).toBeNull();
    });

    test("matches 'exceeded your current quota'", () => {
      const m = detectRateLimit("You exceeded your current quota, please check your plan and billing.");
      expect(m!.providerHint).toBe("gemini");
    });
  });

  describe("GitHub Copilot CLI", () => {
    test("parses 'try again in 2 hours'", () => {
      const now = new Date(2026, 3, 26, 10, 0, 0, 0);
      const text = "Sorry, you've hit a rate limit ... Please try again in 2 hours.";
      const m = detectRateLimit(text, now);
      expect(m!.providerHint).toBe("copilot");
      expect(m!.needsConfirm).toBe(false);
      expect(m!.resetAt!.getTime() - now.getTime()).toBe(2 * 60 * 60_000);
    });

    test("parses 'try again in 2 hours 30 minutes'", () => {
      const now = new Date(2026, 3, 26, 10, 0, 0, 0);
      const text = "Please try again in 2 hours 30 minutes.";
      const m = detectRateLimit(text, now);
      expect(m!.resetAt!.getTime() - now.getTime()).toBe((2 * 60 + 30) * 60_000);
    });

    test("matches generic 'exceeded your Copilot token usage' without time", () => {
      const m = detectRateLimit("Sorry, you have exceeded your Copilot token usage. Please review.");
      expect(m!.providerHint).toBe("copilot");
      expect(m!.resetAt).toBeNull();
    });

    test("matches user_weekly_rate_limited", () => {
      const m = detectRateLimit("Error: user_weekly_rate_limited");
      expect(m!.providerHint).toBe("copilot");
    });
  });

  describe("generic fallback (tight error-shape only)", () => {
    test("matches HTTP 429 status line", () => {
      const m = detectRateLimit("HTTP 429: too many requests");
      expect(m).not.toBeNull();
      // Either copilot/gemini/generic could pick this up; in this case the
      // generic detector wins because earlier ones don't match.
      expect(["generic", "copilot", "gemini"]).toContain(m!.providerHint);
    });

    test("matches status-code framings", () => {
      expect(detectRateLimit("API responded with status 429")!.providerHint).toBe("generic");
      expect(detectRateLimit("HTTP status: 429 Too Many Requests")!.providerHint).toBe("generic");
      expect(detectRateLimit("status_code = 429")!.providerHint).toBe("generic");
    });

    test("matches JSON error codes", () => {
      // codex detector also catches rate_limit_exceeded; whichever fires
      // first is fine — the point is that a real JSON error gets handled.
      expect(detectRateLimit('{"error":{"code":"too_many_requests"}}')).not.toBeNull();
    });

    test("does NOT match narrative mentions of rate-limit (regression: false-positive blocked judge)", () => {
      // Worker output that *talks about* rate-limit handling — diff lines,
      // test names, code comments, status messages — must NOT trigger a hold.
      // A real-world bug had the worker editing rate-limit detector code, its
      // own diff scrolled "the runner was rate-limited" through stdout, and
      // the loose generic detector tripped, which set task.rateLimitedUntil
      // and silently blocked the judge from ever running.
      expect(detectRateLimit("the runner was rate-limited and gave up")).toBeNull();
      expect(detectRateLimit("// rate-limit detection runs for any agent")).toBeNull();
      expect(detectRateLimit("test 'rate-limit retry cap and resume'")).toBeNull();
      expect(detectRateLimit("rate-limited fallback at 30 minutes")).toBeNull();
      expect(detectRateLimit("too many requests in flight, throttling to 5/s")).toBeNull();
    });

    test("returns null for unrelated build output", () => {
      const m = detectRateLimit("Compiling project... 3 errors found in src/index.ts");
      expect(m).toBeNull();
    });

    test("returns null for empty input", () => {
      expect(detectRateLimit("")).toBeNull();
    });
  });

  describe("priority order", () => {
    test("Claude prompt detector wins over generic when both could match", () => {
      const text = "You've hit your limit · resets 5:50am — rate limit policy applied";
      const m = detectRateLimit(text, ANCHOR_MORNING);
      expect(m!.providerHint).toBe("claude");
      expect(m!.needsConfirm).toBe(true);
    });

    test("Gemini retry-time wins over generic keyword", () => {
      const now = new Date(2026, 3, 26, 10, 0, 0, 0);
      const text = "Quota exceeded. Please retry in 30s. (Rate limit policy)";
      const m = detectRateLimit(text, now);
      expect(m!.providerHint).toBe("gemini");
      expect(m!.resetAt).not.toBeNull();
    });
  });
});

describe("summarizeAttentionForProfile (native attention routing)", () => {
  const payload = {
    appState: {
      workspaces: [
        { id: "ws-a1", profileId: "profile-a" },
        { id: "ws-a2", profileId: "profile-a" },
        { id: "ws-b1", profileId: "profile-b" },
        { id: "ws-legacy" }, // no profileId → "default"
      ],
    },
    attention: {
      byWorkspace: {
        "ws-a1": { alerts: [{ kind: "waiting" }, { kind: "completed" }] },
        "ws-a2": { alerts: [{ kind: "completed" }] },
        "ws-b1": { alerts: [{ kind: "waiting" }] },
        "ws-legacy": { alerts: [{ kind: "completed" }] },
      },
    },
  };

  test("counts only alerts in the requested profile's workspaces", () => {
    expect(summarizeAttentionForProfile(payload, "profile-a")).toEqual({ count: 3, waitingCount: 1 });
    expect(summarizeAttentionForProfile(payload, "profile-b")).toEqual({ count: 1, waitingCount: 1 });
  });

  test("workspaces without profileId count toward the default profile", () => {
    expect(summarizeAttentionForProfile(payload, "default")).toEqual({ count: 1, waitingCount: 0 });
  });

  test("two window slots showing the same profile receive identical counts", () => {
    // The summary is keyed by profile, not by window slot — duplicate slots
    // for one profile (multi-window) each badge/flash with the same numbers.
    const slots = [
      { id: "win-1", profileId: "profile-a" },
      { id: "win-2", profileId: "profile-a" },
      { id: "win-3", profileId: "profile-b" },
    ];
    const perWindow = slots.map((slot) => summarizeAttentionForProfile(payload, slot.profileId));
    expect(perWindow[0]).toEqual({ count: 3, waitingCount: 1 });
    expect(perWindow[1]).toEqual(perWindow[0]);
    expect(perWindow[2]).toEqual({ count: 1, waitingCount: 1 });
  });

  test("profile with no alerting workspaces reports zero", () => {
    expect(summarizeAttentionForProfile(payload, "profile-empty")).toEqual({ count: 0, waitingCount: 0 });
  });
});

// Krok 1 — handle-release probe. Deps injected (rename / sleep / clock) so the
// loop is fully deterministic on any OS without real timers.
describe("waitForHandleRelease", () => {
  function harness(renameImpl: (from: string, to: string) => Promise<unknown>) {
    let t = 0;
    const sleeps: number[] = [];
    const sleepImpl = vi.fn(async (ms: number) => {
      sleeps.push(ms);
      t += ms; // each wait advances the injected clock
    });
    const now = () => t;
    return { renameImpl, sleepImpl, sleeps, now };
  }

  test("ENOENT short-circuits immediately with no sleep", async () => {
    const err = Object.assign(new Error("nope"), { code: "ENOENT" });
    const h = harness(vi.fn().mockRejectedValue(err));
    const result = await waitForHandleRelease("/gone", h);
    expect(result).toEqual({ released: true, reason: "enoent" });
    expect(h.sleeps).toHaveLength(0);
  });

  test("rename succeeds immediately → released, zero sleeps", async () => {
    const h = harness(vi.fn().mockResolvedValue(undefined));
    const result = await waitForHandleRelease("/p", h);
    expect(result).toEqual({ released: true });
    expect(h.sleeps).toHaveLength(0);
  });

  test("EBUSY 3× then success → released after exactly 3 sleeps", async () => {
    const ebusy = Object.assign(new Error("busy"), { code: "EBUSY" });
    const renameImpl = vi
      .fn()
      .mockRejectedValueOnce(ebusy)
      .mockRejectedValueOnce(ebusy)
      .mockRejectedValueOnce(ebusy)
      .mockResolvedValueOnce(undefined);
    const h = harness(renameImpl);
    const result = await waitForHandleRelease("/p", h);
    expect(result).toEqual({ released: true });
    expect(h.sleeps).toEqual([150, 150, 150]);
  });

  test("EBUSY forever → released:false after timeout", async () => {
    const ebusy = Object.assign(new Error("busy"), { code: "EBUSY" });
    const h = harness(vi.fn().mockRejectedValue(ebusy));
    const result = await waitForHandleRelease("/p", h);
    expect(result).toEqual({ released: false });
    // 5000ms / 150ms interval → ~33 sleeps then give up.
    expect(h.sleeps.length).toBeGreaterThan(30);
  });
});

// Krok 3 — leading-edge refresh decision.
describe("shouldRefreshNow", () => {
  test("first call after a quiet period (lastAt=-Infinity) refreshes immediately", () => {
    expect(shouldRefreshNow(1000, -Infinity, 10_000)).toEqual({ refresh: true, deferMs: 0 });
  });

  test("elapsed >= interval → refresh now", () => {
    expect(shouldRefreshNow(20_000, 5_000, 10_000)).toEqual({ refresh: true, deferMs: 0 });
  });

  test("within interval → defer by the remaining time", () => {
    expect(shouldRefreshNow(12_000, 5_000, 10_000)).toEqual({ refresh: false, deferMs: 3_000 });
  });

  test("interval of 0 always refreshes (escape hatch)", () => {
    expect(shouldRefreshNow(100, 100, 0)).toEqual({ refresh: true, deferMs: 0 });
  });
});

// Krok 7 — per-key interval gate for log throttling.
describe("createIntervalGate", () => {
  test("allows once per interval per key and counts suppressed in between", () => {
    let t = 0;
    const gate = createIntervalGate(10_000, () => t);
    // 100 calls within 1s → only the first is allowed.
    let allowed = 0;
    for (let i = 0; i < 100; i++) {
      t = i * 10; // 0..990ms
      if (gate.allow("bell:s1").allow) allowed++;
    }
    expect(allowed).toBe(1);
    // After the interval elapses, the next call is allowed again and reports
    // how many were suppressed.
    t = 10_000;
    const next = gate.allow("bell:s1");
    expect(next.allow).toBe(true);
    expect(next.suppressed).toBe(99);
  });

  test("keys are independent", () => {
    let t = 0;
    const gate = createIntervalGate(10_000, () => t);
    expect(gate.allow("a").allow).toBe(true);
    expect(gate.allow("b").allow).toBe(true);
    expect(gate.allow("a").allow).toBe(false);
    t = 10_000;
    expect(gate.allow("a").allow).toBe(true);
  });
});
