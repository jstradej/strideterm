import { beforeEach, describe, expect, it, vi } from "vitest";
import type { UsageWindow } from "../../shared/agent-usage.js";
import { UsageUnavailable } from "./unavailable.js";

const { runJsonlCli } = vi.hoisted(() => ({ runJsonlCli: vi.fn() }));
vi.mock("./cli-probe.js", () => ({ runJsonlCli }));

import { readClaudeAccountUsage, readClaudeUsage } from "./claude.js";

function response(requestId: string, payload: Record<string, unknown> = {}) {
  return { type: "control_response", response: { subtype: "success", request_id: requestId, response: payload } };
}

function usageReply(limits: Record<string, unknown> | null, available = true) {
  return { rate_limits_available: available, rate_limits: limits };
}

async function simulateUsage(reply: Record<string, unknown>, email = "claude-test@example.invalid") {
  runJsonlCli.mockImplementationOnce(async (_command, _args, initial, onMessage) => {
    expect(initial.request.subtype).toBe("initialize");
    const sent: Record<string, unknown>[] = [];
    onMessage(
      response("strideterm-usage-initialize", {
        account: { email, organization: "Test Org", subscriptionType: "max", apiProvider: "firstParty" },
      }),
      (value: Record<string, unknown>) => sent.push(value),
    );
    expect(sent[0].request).toEqual({ subtype: "get_usage", skip_behaviors: true });
    return onMessage(response("strideterm-usage-read", reply), () => undefined);
  });
}

describe("Claude plan usage", () => {
  beforeEach(() => runJsonlCli.mockReset());

  it("reads Claude CLI subscription windows without sending a prompt", async () => {
    await simulateUsage(
      usageReply({
        five_hour: { utilization: 23, resets_at: "2030-01-02T03:04:05.000Z" },
        seven_day: { utilization: 44, resets_at: 1_893_456_000 },
        model_scoped: [{ display_name: "Fable", utilization: 7, resets_at: "2030-01-03T00:00:00Z" }],
      }),
    );

    const actual = await readClaudeAccountUsage({ CLAUDE_CONFIG_DIR: "C:/fake/claude-profile" });
    expect(actual.account).toEqual({
      label: "claude-test@example.invalid",
      key: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(actual.windows).toEqual<UsageWindow[]>([
      { label: "5-hour", usedPercent: 23, durationMinutes: 300, resetsAt: Date.parse("2030-01-02T03:04:05.000Z") },
      { label: "7-day", usedPercent: 44, durationMinutes: 10080, resetsAt: 1_893_456_000_000 },
      {
        label: "Fable weekly",
        usedPercent: 7,
        durationMinutes: 10080,
        scope: "Fable",
        resetsAt: Date.parse("2030-01-03T00:00:00Z"),
      },
    ]);
    expect(runJsonlCli).toHaveBeenCalledWith(
      "claude",
      expect.arrayContaining(["--no-session-persistence", "--safe-mode"]),
      expect.objectContaining({ type: "control_request" }),
      expect.any(Function),
      { timeoutMs: 12_000, env: { CLAUDE_CONFIG_DIR: "C:/fake/claude-profile" } },
    );
  });

  it("keeps the windows-only compatibility export", async () => {
    await simulateUsage(usageReply({ five_hour: { utilization: 5 } }), "claude-compat@example.invalid");
    await expect(readClaudeUsage()).resolves.toEqual([{ label: "5-hour", usedPercent: 5, durationMinutes: 300 }]);
  });

  it("bounds and sanitizes scoped quota labels from large CLI replies", async () => {
    const model_scoped = Array.from({ length: 100 }, () => ({
      display_name: `${"x".repeat(120)}\nprivate-label`,
      utilization: 10,
    }));
    await simulateUsage(
      usageReply({ five_hour: { utilization: 5 }, model_scoped }),
      "claude-synthetic@example.invalid",
    );
    const reading = await readClaudeAccountUsage();
    expect(reading.windows).toHaveLength(28);
    expect(reading.windows[1]?.label).toBe(`${"x".repeat(96)} weekly`);
    expect(reading.windows[1]?.label).not.toContain("private-label");
  });

  it("keeps default quota available when older CLI initialization omits identity", async () => {
    runJsonlCli.mockImplementationOnce(async (_command, _args, _initial, onMessage) => {
      const sent: Record<string, unknown>[] = [];
      onMessage(
        response("strideterm-usage-initialize", { account: { apiProvider: "firstParty" } }),
        (value: Record<string, unknown>) => sent.push(value),
      );
      expect(sent[0].request).toEqual({ subtype: "get_usage", skip_behaviors: true });
      return onMessage(
        response("strideterm-usage-read", usageReply({ five_hour: { utilization: 8 } })),
        () => undefined,
      );
    });
    await expect(readClaudeAccountUsage()).resolves.toEqual({
      windows: [{ label: "5-hour", usedPercent: 8, durationMinutes: 300 }],
    });
  });

  it("refuses usage for API key or unsupported logins", async () => {
    await simulateUsage(usageReply(null, false), "claude-no-plan@example.invalid");
    await expect(readClaudeAccountUsage()).rejects.toThrow("Claude plan usage is unavailable for this login");
  });

  it("reports older CLI protocol support clearly", async () => {
    runJsonlCli.mockImplementationOnce(async (_command, _args, _initial, onMessage) => {
      const sent: Record<string, unknown>[] = [];
      onMessage(
        response("strideterm-usage-initialize", { account: { email: "claude-old@example.invalid" } }),
        (value: Record<string, unknown>) => sent.push(value),
      );
      const error = {
        type: "control_response",
        response: { subtype: "error", request_id: "strideterm-usage-read", error: "unknown get_usage subtype" },
      };
      return onMessage(error, () => undefined);
    });
    await expect(readClaudeUsage()).rejects.toThrow("does not support usage reporting");
  });

  it("does not expose CLI error details", async () => {
    runJsonlCli.mockRejectedValueOnce(new Error("Authorization: Bearer secret-token"));
    const error = await readClaudeAccountUsage().catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(UsageUnavailable);
    expect((error as Error).message).not.toContain("secret-token");
  });

  it("uses a bounded cooldown after a provider rate limit", async () => {
    runJsonlCli.mockImplementationOnce(async (_command, _args, _initial, onMessage) => {
      onMessage(
        response("strideterm-usage-initialize", { account: { email: "claude-rate-limit@example.invalid" } }),
        () => undefined,
      );
      throw new Error("HTTP 429 rate limit");
    });
    await expect(readClaudeAccountUsage()).rejects.toThrow("rate limited");
    expect(runJsonlCli).toHaveBeenCalledTimes(1);
    runJsonlCli.mockImplementationOnce(async (_command, _args, _initial, onMessage) => {
      const sent: Record<string, unknown>[] = [];
      onMessage(
        response("strideterm-usage-initialize", { account: { email: "claude-rate-limit@example.invalid" } }),
        (value: Record<string, unknown>) => sent.push(value),
      );
      expect(sent).toEqual([]);
      return {};
    });
    await expect(readClaudeAccountUsage()).rejects.toThrow("cooling down");
    expect(runJsonlCli).toHaveBeenCalledTimes(2);
    await simulateUsage(usageReply({ five_hour: { utilization: 5 } }), "claude-other-account@example.invalid");
    await expect(readClaudeAccountUsage()).resolves.toHaveProperty("windows");
  });
});
