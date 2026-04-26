import { describe, expect, test } from "vitest";
import { detectRateLimit } from "./runtime-utils.js";

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
