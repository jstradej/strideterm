import { describe, expect, test } from "vitest";
import {
  statusVisual,
  statusRank,
  isRunning,
  stripRef,
  shortSha,
  formatRelative,
  formatDuration,
  durationMs,
  formatFull,
  formatRelativeUntil,
} from "./azurePipelineFormat.js";

function isoAgo(ms: number): string {
  return new Date(Date.now() - ms).toISOString();
}

describe("statusVisual", () => {
  test("maps completed + succeeded to ok", () => {
    expect(statusVisual("completed", "succeeded")).toEqual({ icon: "✓", cls: "ok", label: "Succeeded" });
  });

  test("maps completed + failed to fail", () => {
    expect(statusVisual("completed", "failed")).toEqual({ icon: "✗", cls: "fail", label: "Failed" });
  });

  test("maps completed + partiallySucceeded to warn", () => {
    expect(statusVisual("completed", "partiallySucceeded")).toEqual({
      icon: "!",
      cls: "warn",
      label: "Partially succeeded",
    });
  });

  test("maps completed + canceled to canceled", () => {
    expect(statusVisual("completed", "canceled")).toEqual({ icon: "⊘", cls: "canceled", label: "Canceled" });
  });

  test("maps completed + skipped to pending", () => {
    expect(statusVisual("completed", "skipped")).toEqual({ icon: "–", cls: "pending", label: "Skipped" });
  });

  test("maps completed with unknown result to a generic ok", () => {
    expect(statusVisual("completed", "")).toEqual({ icon: "✓", cls: "ok", label: "Completed" });
  });

  test("maps inProgress to running", () => {
    expect(statusVisual("inProgress", "")).toEqual({ icon: "●", cls: "running", label: "Running" });
  });

  test("maps notStarted/postponed/pending to queued", () => {
    expect(statusVisual("notStarted", "")).toEqual({ icon: "○", cls: "pending", label: "Queued" });
    expect(statusVisual("postponed", "")).toEqual({ icon: "○", cls: "pending", label: "Queued" });
  });

  test("maps cancelling to canceled/cancelling", () => {
    expect(statusVisual("cancelling", "")).toEqual({ icon: "●", cls: "canceled", label: "Cancelling" });
  });

  test("falls back to the raw status string for unknown values", () => {
    expect(statusVisual("weird", "")).toEqual({ icon: "○", cls: "none", label: "weird" });
    expect(statusVisual(undefined, undefined)).toEqual({ icon: "○", cls: "none", label: "—" });
  });
});

describe("statusRank", () => {
  test("orders running first and unknown last", () => {
    expect(statusRank("inProgress", "")).toBe(0);
    expect(statusRank("completed", "failed")).toBe(1);
    expect(statusRank("completed", "partiallySucceeded")).toBe(2);
    expect(statusRank("notStarted", "")).toBe(3);
    expect(statusRank("completed", "canceled")).toBe(4);
    expect(statusRank("completed", "succeeded")).toBe(5);
    expect(statusRank("weird", "")).toBe(6);
  });
});

describe("isRunning", () => {
  test("true for anything other than completed", () => {
    expect(isRunning("inProgress")).toBe(true);
    expect(isRunning("notStarted")).toBe(true);
  });

  test("false for completed or empty", () => {
    expect(isRunning("completed")).toBe(false);
    expect(isRunning(undefined)).toBe(false);
  });
});

describe("stripRef", () => {
  test("strips the refs/heads/ prefix", () => {
    expect(stripRef("refs/heads/main")).toBe("main");
  });

  test("passes through non-branch refs and nullish values unchanged", () => {
    expect(stripRef("refs/tags/v1")).toBe("refs/tags/v1");
    expect(stripRef(undefined)).toBe("");
  });
});

describe("shortSha", () => {
  test("truncates to 8 chars", () => {
    expect(shortSha("0123456789abcdef")).toBe("01234567");
  });

  test("returns empty string for falsy input", () => {
    expect(shortSha(undefined)).toBe("");
  });
});

describe("formatRelative", () => {
  test("returns empty string for falsy input", () => {
    expect(formatRelative(undefined)).toBe("");
  });

  test("returns 'just now' under a minute", () => {
    expect(formatRelative(isoAgo(10_000))).toBe("just now");
  });

  test("returns minutes under an hour", () => {
    expect(formatRelative(isoAgo(5 * 60_000))).toBe("5m ago");
  });

  test("returns hours under a day", () => {
    expect(formatRelative(isoAgo(3 * 3_600_000))).toBe("3h ago");
  });

  test("returns days beyond a day", () => {
    expect(formatRelative(isoAgo(2 * 86_400_000))).toBe("2d ago");
  });
});

describe("formatDuration / durationMs", () => {
  test("formats seconds", () => {
    const start = isoAgo(30_000);
    expect(formatDuration(start)).toBe("30s");
  });

  test("formats minutes and seconds", () => {
    const start = new Date("2026-01-01T00:00:00.000Z").toISOString();
    const finish = new Date("2026-01-01T00:02:05.000Z").toISOString();
    expect(formatDuration(start, finish)).toBe("2m 5s");
  });

  test("formats whole minutes without seconds", () => {
    const start = new Date("2026-01-01T00:00:00.000Z").toISOString();
    const finish = new Date("2026-01-01T00:02:00.000Z").toISOString();
    expect(formatDuration(start, finish)).toBe("2m");
  });

  test("formats hours and minutes", () => {
    const start = new Date("2026-01-01T00:00:00.000Z").toISOString();
    const finish = new Date("2026-01-01T01:30:00.000Z").toISOString();
    expect(formatDuration(start, finish)).toBe("1h 30m");
  });

  test("returns empty string when start is missing or finish precedes start", () => {
    expect(formatDuration(undefined)).toBe("");
    const start = new Date("2026-01-01T01:00:00.000Z").toISOString();
    const finish = new Date("2026-01-01T00:00:00.000Z").toISOString();
    expect(formatDuration(start, finish)).toBe("");
  });

  test("durationMs computes the millisecond delta, 0 when unknown", () => {
    const start = new Date("2026-01-01T00:00:00.000Z").toISOString();
    const finish = new Date("2026-01-01T00:00:05.000Z").toISOString();
    expect(durationMs(start, finish)).toBe(5000);
    expect(durationMs(undefined)).toBe(0);
  });
});

describe("formatFull", () => {
  test("returns empty string for falsy or invalid input", () => {
    expect(formatFull(undefined)).toBe("");
    expect(formatFull("not-a-date")).toBe("");
  });

  test("returns a locale string for a valid date", () => {
    expect(formatFull("2026-01-01T00:00:00.000Z")).toBe(new Date("2026-01-01T00:00:00.000Z").toLocaleString());
  });
});

describe("formatRelativeUntil", () => {
  test("returns empty string for falsy input", () => {
    expect(formatRelativeUntil(undefined, 1000, () => "fallback")).toBe("");
  });

  test("uses formatRelative under the threshold", () => {
    expect(formatRelativeUntil(isoAgo(10_000), 60_000, () => "fallback")).toBe("just now");
  });

  test("uses the fallback at or beyond the threshold", () => {
    const dateStr = isoAgo(2 * 86_400_000);
    expect(formatRelativeUntil(dateStr, 86_400_000, (d) => `fallback:${d}`)).toBe(`fallback:${dateStr}`);
  });

  test("matches AzureAuditLog's 24h absolute-date fallback shape", () => {
    const dateStr = isoAgo(2 * 86_400_000);
    const result = formatRelativeUntil(dateStr, 86_400_000, (d) => {
      const date = new Date(d);
      return (
        date.toLocaleDateString(undefined, { month: "short", day: "numeric" }) +
        " " +
        date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
      );
    });
    expect(result).not.toContain("ago");
    expect(result.length).toBeGreaterThan(0);
  });

  test("matches ReviewCommentsTab's 2-week 'weeks ago' fallback shape", () => {
    const dateStr = isoAgo(20 * 86_400_000);
    const result = formatRelativeUntil(dateStr, 14 * 86_400_000, (d) => {
      const days = Math.floor((Date.now() - new Date(d).getTime()) / 86_400_000);
      return `${Math.floor(days / 7)}w ago`;
    });
    expect(result).toBe("2w ago");
  });
});
