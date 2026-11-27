import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import path from "node:path";
import type { UsageAccountReading } from "../../shared/agent-usage.js";

const { readClaudeAccountUsage, readCodexAccountUsage, isUsageProfileDirectory, discoverUsageProfiles } = vi.hoisted(
  () => ({
    readClaudeAccountUsage: vi.fn(),
    readCodexAccountUsage: vi.fn(),
    isUsageProfileDirectory: vi.fn(),
    discoverUsageProfiles: vi.fn(),
  }),
);
vi.mock("./claude.js", () => ({ readClaudeAccountUsage }));
vi.mock("./codex.js", () => ({ readCodexAccountUsage }));
vi.mock("./account-store.js", () => ({ isUsageProfileDirectory }));
vi.mock("./discover-profiles.js", () => ({ discoverUsageProfiles }));

import { createAgentUsageReader } from "./read.js";
import { UsageUnavailable } from "./unavailable.js";

const account = (key: string, label = key) => ({ key, label });
const reading = (key: string, usedPercent: number, resetsAt?: number): UsageAccountReading => ({
  account: account(key),
  windows: [{ label: "Weekly", usedPercent, ...(resetsAt === undefined ? {} : { resetsAt }) }],
});

describe("desktop account usage", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(1_800_000_000_000);
    vi.mocked(readClaudeAccountUsage).mockResolvedValue(reading("claude-default", 27));
    vi.mocked(readCodexAccountUsage).mockResolvedValue(reading("codex-default", 41));
    vi.mocked(isUsageProfileDirectory).mockReturnValue(true);
    vi.mocked(discoverUsageProfiles).mockResolvedValue([]);
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;
  });
  afterEach(() => vi.useRealTimers());

  it("shares pending checks and invalidates the cache at a quota reset", async () => {
    vi.mocked(readClaudeAccountUsage).mockResolvedValueOnce(reading("claude-default", 100, Date.now() + 9_000));
    const read = createAgentUsageReader();
    const [first, second] = await Promise.all([read(), read()]);
    expect(first).toEqual(second);
    await read();
    expect(readClaudeAccountUsage).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(9_000);
    vi.mocked(readClaudeAccountUsage).mockRejectedValueOnce(new UsageUnavailable("Claude has signed out."));
    const updated = await read();
    expect(updated[0]).toMatchObject({ windows: [], unavailable: "Claude has signed out." });
    expect(updated[1]?.windows[0]?.usedPercent).toBe(41);
    expect(readCodexAccountUsage).toHaveBeenCalledTimes(2);
  });

  it("keeps unexpected provider errors private", async () => {
    vi.mocked(readClaudeAccountUsage).mockRejectedValueOnce(new Error("raw process output"));
    const rows = await createAgentUsageReader()();
    expect(rows[0]?.unavailable).toBe("Could not read usage from the CLI.");
    expect(rows[1]?.windows[0]?.usedPercent).toBe(41);
  });

  it("retries cached failures manually, coalesces refreshes, and shares the refreshed snapshot", async () => {
    vi.mocked(readClaudeAccountUsage)
      .mockRejectedValueOnce(new UsageUnavailable("Claude has signed out."))
      .mockResolvedValueOnce(reading("claude-default", 27));
    const read = createAgentUsageReader();
    const failed = await read();
    expect(failed[0]?.unavailable).toBe("Claude has signed out.");
    const [first, second] = await Promise.all([read(true), read(true)]);
    expect(first).toEqual(second);
    expect(first[0]?.windows[0]?.usedPercent).toBe(27);
    expect(readClaudeAccountUsage).toHaveBeenCalledTimes(2);
    expect(await read()).toEqual(first);
    expect(readClaudeAccountUsage).toHaveBeenCalledTimes(2);
  });

  it("joins a pending ordinary read when a manual refresh arrives", async () => {
    let resolveClaude!: (value: UsageAccountReading) => void;
    vi.mocked(readClaudeAccountUsage).mockReturnValueOnce(new Promise((resolve) => (resolveClaude = resolve)));
    const read = createAgentUsageReader();
    const ordinary = read();
    const manual = read(true);
    resolveClaude(reading("claude-default", 27));
    expect(await manual).toEqual(await ordinary);
    expect(readClaudeAccountUsage).toHaveBeenCalledTimes(1);
  });

  it("shows identified registered accounts and candidates, dedupes archived accounts, and keeps same-login profiles removable", async () => {
    const profile = {
      id: "profile-same",
      provider: "claude" as const,
      directory: path.join("profiles", "claude-work"),
    };
    vi.mocked(readClaudeAccountUsage)
      .mockResolvedValueOnce(reading("claude-default", 27))
      .mockResolvedValueOnce(reading("claude-default", 30));
    const store = {
      listProfiles: () => [profile],
      history: (provider: "claude" | "codex") =>
        provider === "claude"
          ? [
              { id: "claude-default", label: "default archive", status: "last-seen" as const, windows: [] },
              { id: "claude-old", label: "old", status: "last-seen" as const, windows: [] },
            ]
          : [],
      observe: vi.fn(),
    };
    vi.mocked(discoverUsageProfiles).mockResolvedValue([
      { id: "candidate-1", provider: "claude", directory: "private-path", label: ".claude-work" },
    ]);

    const [claude] = await createAgentUsageReader(store)();
    expect(claude?.windows[0]?.usedPercent).toBe(27);
    expect(claude?.otherAccounts).toEqual([
      expect.objectContaining({
        id: "profile-same",
        label: "claude-default",
        removable: true,
        sameAsDefault: true,
        windows: [{ label: "Weekly", usedPercent: 30 }],
      }),
      expect.objectContaining({ id: "claude-old", removable: true }),
      { id: "candidate-1", label: ".claude-work", status: "candidate" },
    ]);
    expect(store.observe).toHaveBeenCalledWith(
      "claude",
      expect.objectContaining({
        account: { key: "claude-default", label: "claude-default" },
        windows: [{ label: "Weekly", usedPercent: 30 }],
      }),
    );
    expect(JSON.stringify(claude?.otherAccounts)).not.toContain("private-path");
    expect(discoverUsageProfiles).toHaveBeenCalledTimes(1);
  });

  it("shows separate live accounts when the default is unavailable and isolates profile environment", async () => {
    vi.mocked(readClaudeAccountUsage)
      .mockRejectedValueOnce(new UsageUnavailable("default unavailable"))
      .mockResolvedValueOnce(reading("claude-other", 63));
    const store = {
      listProfiles: () => [
        { id: "profile-other", provider: "claude" as const, directory: path.join("private", "other-login") },
      ],
      history: (provider: "claude" | "codex") =>
        provider === "claude"
          ? [
              {
                id: "claude-archive",
                label: "Past account",
                status: "last-seen" as const,
                windows: [{ label: "Weekly", usedPercent: 12 }],
              },
            ]
          : [],
      observe: vi.fn(),
    };
    const [claude] = await createAgentUsageReader(store)();
    expect(claude).toMatchObject({ windows: [], unavailable: "default unavailable" });
    expect(claude?.otherAccounts).toEqual([
      expect.objectContaining({
        id: "profile-other",
        label: "claude-other",
        windows: [{ label: "Weekly", usedPercent: 63 }],
      }),
      expect.objectContaining({ id: "claude-archive", removable: true }),
    ]);
    const env = vi.mocked(readClaudeAccountUsage).mock.calls[1]?.[0];
    expect(env?.CLAUDE_CONFIG_DIR).toBe(path.resolve("private", "other-login"));
    expect(env?.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env?.OPENAI_API_KEY).toBeUndefined();
  });

  it("uses unknown folder labels without misattributing identity and rejects directories removed before probing", async () => {
    vi.mocked(readClaudeAccountUsage).mockImplementation(async (env) =>
      env?.CLAUDE_CONFIG_DIR ? { windows: [{ label: "Weekly", usedPercent: 19 }] } : reading("claude-default", 27),
    );
    vi.mocked(isUsageProfileDirectory).mockReturnValueOnce(true).mockReturnValueOnce(false);
    const profiles = [
      { id: "unknown-profile", provider: "claude" as const, directory: path.join("private", "unnamed") },
      { id: "missing-profile", provider: "claude" as const, directory: path.join("private", "gone") },
    ];
    const [claude] = await createAgentUsageReader({
      listProfiles: () => profiles,
      history: () => [],
      observe: vi.fn(),
    })();
    expect(claude?.otherAccounts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "unknown-profile",
          label: "unnamed · account identity unknown",
          identityUnknown: true,
          windows: [{ label: "Weekly", usedPercent: 19 }],
        }),
        expect.objectContaining({
          id: "missing-profile",
          label: "gone",
          unavailable: expect.stringContaining("missing"),
          removable: true,
        }),
      ]),
    );
    expect(readClaudeAccountUsage).toHaveBeenCalledTimes(2);
  });

  it("keeps fresh default usage when persisting its history fails", async () => {
    const observe = vi.fn(() => {
      throw new Error("store unavailable");
    });
    const [claude] = await createAgentUsageReader({ listProfiles: () => [], history: () => [], observe })();
    expect(claude?.windows[0]?.usedPercent).toBe(27);
    expect(observe).toHaveBeenCalledWith("claude", expect.objectContaining({ provider: "claude" }));
  });

  it("clears a rejected aggregate cache so a later read can recover", async () => {
    let profileReads = 0;
    const store = {
      listProfiles: () =>
        profileReads++ === 0
          ? ({ corrupt: true } as unknown as { id: string; provider: "claude"; directory: string }[])
          : [],
      history: () => [],
      observe: vi.fn(),
    };
    const read = createAgentUsageReader(store);
    await expect(read()).rejects.toThrow();
    const [claude] = await read();
    expect(claude?.windows[0]?.usedPercent).toBe(27);
    expect(readClaudeAccountUsage).toHaveBeenCalledTimes(1);
  });

  it("shows retained verified history after a registered account goes offline", async () => {
    vi.mocked(readClaudeAccountUsage)
      .mockResolvedValueOnce(reading("claude-default", 27))
      .mockRejectedValueOnce(new UsageUnavailable("profile login expired"));
    const store = {
      listProfiles: () => [
        { id: "profile-other", provider: "claude" as const, directory: path.join("profiles", "other") },
      ],
      history: (provider: "claude" | "codex") =>
        provider === "claude"
          ? [
              {
                id: "claude-other",
                label: "Other verified account",
                status: "last-seen" as const,
                windows: [{ label: "Weekly", usedPercent: 58 }],
              },
            ]
          : [],
      observe: vi.fn(),
    };
    const [claude] = await createAgentUsageReader(store)();
    expect(claude?.otherAccounts).toEqual([
      expect.objectContaining({
        id: "profile-other",
        status: "listed",
        unavailable: "profile login expired",
        removable: true,
      }),
      expect.objectContaining({
        id: "claude-other",
        label: "Other verified account",
        status: "last-seen",
        windows: [{ label: "Weekly", usedPercent: 58 }],
        removable: true,
      }),
    ]);
  });

  it("expires against live alternate windows but not stale archive windows", async () => {
    const resetAt = Date.now() + 8_000;
    vi.mocked(readClaudeAccountUsage)
      .mockResolvedValueOnce(reading("claude-default", 10))
      .mockResolvedValueOnce(reading("claude-other", 20, resetAt))
      .mockResolvedValueOnce(reading("claude-default", 30))
      .mockResolvedValueOnce(reading("claude-other", 40));
    const store = {
      listProfiles: () => [
        { id: "profile-other", provider: "claude" as const, directory: path.join("profiles", "other") },
      ],
      history: (provider: "claude" | "codex") =>
        provider === "claude"
          ? [
              {
                id: "archive",
                label: "archive",
                status: "last-seen" as const,
                windows: [{ label: "Weekly", usedPercent: 80, resetsAt: Date.now() + 1 }],
              },
            ]
          : [],
      observe: vi.fn(),
    };
    const read = createAgentUsageReader(store);
    await read();
    await read();
    expect(readClaudeAccountUsage).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(8_000);
    await read();
    expect(readClaudeAccountUsage).toHaveBeenCalledTimes(4);
  });

  it("limits simultaneous active and alternate CLI probes", async () => {
    vi.useRealTimers();
    let inFlight = 0;
    let maximumInFlight = 0;
    vi.mocked(readClaudeAccountUsage).mockImplementation(async (env) => {
      inFlight++;
      maximumInFlight = Math.max(maximumInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 4));
      inFlight--;
      return reading(env?.CLAUDE_CONFIG_DIR ? `profile:${env.CLAUDE_CONFIG_DIR}` : "claude-default", 27);
    });
    const profiles = Array.from({ length: 8 }, (_, index) => ({
      id: `profile-${index}`,
      provider: "claude" as const,
      directory: path.join("profiles", `claude-${index}`),
    }));
    await createAgentUsageReader({ listProfiles: () => profiles, history: () => [], observe: vi.fn() })();
    expect(maximumInFlight).toBe(3);
  });
});
