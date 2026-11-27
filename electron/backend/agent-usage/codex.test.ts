import { beforeEach, describe, expect, it, vi } from "vitest";
import type { UsageWindow } from "../../shared/agent-usage.js";
import { UsageUnavailable } from "./unavailable.js";

const { runJsonlCli } = vi.hoisted(() => ({ runJsonlCli: vi.fn() }));
vi.mock("./cli-probe.js", () => ({ runJsonlCli }));

import { parseCodexResetCredits, parseCodexUsageWindows, readCodexAccountUsage, readCodexUsage } from "./codex.js";

function reply(id: number, result: unknown, error?: unknown) {
  return { jsonrpc: "2.0", id, ...(error === undefined ? { result } : { error }) };
}

function initialize(onMessage: (message: unknown, send: (value: Record<string, unknown>) => void) => unknown) {
  const sent: Record<string, unknown>[] = [];
  onMessage(reply(1, {}), (value) => sent.push(value));
  expect(sent).toEqual([
    { jsonrpc: "2.0", method: "initialized", params: {} },
    { jsonrpc: "2.0", id: 2, method: "account/read", params: { refreshToken: false } },
    { jsonrpc: "2.0", id: 3, method: "account/rateLimits/read", params: {} },
  ]);
}

const limits = { rateLimits: { primary: { usedPercent: 31, windowDurationMins: 300 } } };

describe("Codex account usage", () => {
  beforeEach(() => runJsonlCli.mockReset());

  it("reads active identity and quota in one read-only app-server process", async () => {
    runJsonlCli.mockImplementationOnce(async (_command, _args, initial, onMessage, options) => {
      expect(initial.method).toBe("initialize");
      expect(options.env.CODEX_HOME).toBe("/profile/a");
      initialize(onMessage);
      const quota = onMessage(reply(3, limits), () => undefined);
      expect(quota).toBeUndefined();
      return onMessage(
        reply(2, {
          userId: "test-user-id",
          account: { type: "chatgpt", email: "codex@example.invalid", planType: "plus" },
          workspaceRouting: { chatgptAccountId: "test-workspace-id" },
        }),
        () => undefined,
      );
    });

    const result = await readCodexAccountUsage({ ...process.env, CODEX_HOME: "/profile/a" });
    expect(result.account?.label).toBe("codex@example.invalid");
    expect(result.account?.key).toMatch(/^codex:[a-f0-9]{64}$/);
    expect(result.account?.key).not.toContain("test-user-id");
    expect(result.account?.key).not.toContain("codex@example.invalid");
    expect(result.windows).toEqual<UsageWindow[]>([{ label: "5-hour", usedPercent: 31, durationMinutes: 300 }]);
    expect(runJsonlCli).toHaveBeenCalledWith("codex", ["app-server"], expect.any(Object), expect.any(Function), {
      env: expect.objectContaining({ CODEX_HOME: "/profile/a" }),
    });
  });

  it("keeps distinct source contexts when workspace identity is unavailable", async () => {
    const keys: string[] = [];
    for (const home of ["/profile/a", "/profile/b"]) {
      runJsonlCli.mockImplementationOnce(async (_command, _args, _initial, onMessage) => {
        initialize(onMessage);
        onMessage(reply(2, { userId: "same-user", account: { type: "chatgpt" } }), () => undefined);
        return onMessage(reply(3, limits), () => undefined);
      });
      keys.push((await readCodexAccountUsage({ ...process.env, CODEX_HOME: home })).account!.key);
    }
    expect(keys[0]).not.toBe(keys[1]);
  });

  it("preserves the quota-only API", async () => {
    runJsonlCli.mockImplementationOnce(async (_command, _args, _initial, onMessage) => {
      initialize(onMessage);
      onMessage(reply(2, null), () => undefined);
      return onMessage(reply(3, limits), () => undefined);
    });
    await expect(readCodexUsage()).resolves.toEqual([{ label: "5-hour", usedPercent: 31, durationMinutes: 300 }]);
  });

  it("keeps quota anonymous when auth mode and plan do not identify a particular user", async () => {
    runJsonlCli.mockImplementationOnce(async (_command, _args, _initial, onMessage) => {
      initialize(onMessage);
      onMessage(reply(2, { account: { type: "apiKey" } }), () => undefined);
      return onMessage(reply(3, limits), () => undefined);
    });
    expect((await readCodexAccountUsage()).account).toBeUndefined();
  });

  it("preserves the default window and independent named pools, including valid zero usage", () => {
    const standard = { limitId: "codex", primary: { usedPercent: 0, windowDurationMins: 300, resetsAt: 1800000000 } };
    expect(
      parseCodexUsageWindows({
        rateLimits: standard,
        rateLimitsByLimitId: {
          codex: standard,
          spark: {
            limitName: "Spark",
            primary: { usedPercent: 101 },
            secondary: { usedPercent: 70, windowDurationMins: 10080 },
          },
        },
      }),
    ).toEqual([
      { label: "5-hour", usedPercent: 0, durationMinutes: 300, resetsAt: 1800000000000 },
      { label: "Weekly (Spark)", scope: "Spark", usedPercent: 70, durationMinutes: 10080 },
    ]);
  });

  it("bounds and sanitizes provider supplied pool labels and window counts", () => {
    const noisyName = `${"x".repeat(120)}\nprivate-label`;
    const pools = Object.fromEntries(
      Array.from({ length: 100 }, (_, index) => [
        `pool-${index}`,
        { limitName: noisyName, primary: { usedPercent: 10, windowDurationMins: 60 } },
      ]),
    );
    const windows = parseCodexUsageWindows({
      rateLimits: { limitId: "codex", primary: { usedPercent: 5, windowDurationMins: 300 } },
      rateLimitsByLimitId: pools,
    });
    expect(windows).toHaveLength(32);
    expect(windows[0]?.label).toBe("5-hour");
    expect(windows[1]?.label).toBe(`1-hour (${"x".repeat(96)})`);
    expect(windows[1]?.label).not.toContain("private-label");
  });

  it("does not expose account-reader or quota error details", async () => {
    runJsonlCli.mockImplementationOnce(async (_command, _args, _initial, onMessage) => {
      initialize(onMessage);
      onMessage(reply(2, null, { message: "private identity details" }), () => undefined);
      return onMessage(reply(3, null, { message: "Authorization: Bearer private-token" }), () => undefined);
    });
    const error = await readCodexAccountUsage().catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(UsageUnavailable);
    expect((error as Error).message).not.toContain("private-token");
  });
});

describe("parseCodexResetCredits", () => {
  const now = Date.parse("2030-01-01T00:00:00Z");
  const seconds = (ms: number) => Math.floor(ms / 1000);

  it("counts only available, unexpired credits and drops their descriptions", () => {
    const credits = parseCodexResetCredits(
      {
        rateLimitResetCredits: {
          availableCount: 4,
          credits: [
            { id: "a", status: "available", expiresAt: seconds(now + 3 * 86_400_000), title: "Full reset" },
            { id: "b", status: "available", expiresAt: seconds(now + 86_400_000) },
            { id: "c", status: "redeemed", expiresAt: seconds(now + 86_400_000) },
            { id: "d", status: "available", expiresAt: seconds(now - 1000) },
          ],
        },
      },
      now,
    );
    expect(credits).toEqual({ available: 2, expiresAt: [now + 86_400_000, now + 3 * 86_400_000] });
  });

  it("falls back to the available count and ignores missing data", () => {
    expect(parseCodexResetCredits({ rateLimitResetCredits: { availableCount: 2 } }, now)).toEqual({
      available: 2,
      expiresAt: [],
    });
    expect(parseCodexResetCredits({ rateLimits: {} }, now)).toBeUndefined();
    expect(parseCodexResetCredits({ rateLimitResetCredits: { credits: [] } }, now)).toBeUndefined();
  });
});
