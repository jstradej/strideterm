import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentUsage } from "../../shared/agent-usage.js";
import { createUsageAccountStore, isUsageProfileDirectory } from "./account-store.js";

const roots: string[] = [];

function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "usage-account-store-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function reading(
  provider: "claude" | "codex",
  account: { label: string; key: string },
  extra: Partial<AgentUsage> = {},
): AgentUsage & { account: typeof account } {
  return {
    provider,
    account,
    checkedAt: 1_800_000_000_000,
    windows: [{ label: "5-hour", usedPercent: 25, durationMinutes: 300 }],
    ...extra,
  };
}

describe("usage account store", () => {
  it("explains when the selected folder is already the default CLI account", () => {
    const root = tempRoot();
    vi.stubEnv("CODEX_HOME", root);
    try {
      const store = createUsageAccountStore(root);
      expect(() => store.addProfile("codex", root)).toThrow("already shown as the default");
      expect(store.listProfiles()).toEqual([]);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("recognizes isolated Claude settings when the login is in the OS keychain", () => {
    const home = tempRoot();
    const profile = path.join(home, ".claude-work");
    fs.mkdirSync(profile);
    fs.writeFileSync(path.join(home, ".claude.json"), "{}");
    fs.writeFileSync(path.join(profile, ".claude.json"), "{}");
    const homedir = vi.spyOn(os, "homedir").mockReturnValue(home);
    try {
      expect(isUsageProfileDirectory("claude", profile)).toBe(true);
      expect(isUsageProfileDirectory("claude", home)).toBe(false);
    } finally {
      homedir.mockRestore();
    }
  });

  it("registers only existing provider-specific nondefault config directories", () => {
    const root = tempRoot();
    const dataDir = path.join(root, "data");
    const claudeDir = path.join(root, "claude-context");
    const codexDir = path.join(root, "codex-context");
    fs.mkdirSync(claudeDir);
    fs.mkdirSync(codexDir);
    fs.writeFileSync(path.join(claudeDir, "settings.json"), "{}");
    fs.writeFileSync(path.join(codexDir, "config.toml"), "[auth]");

    expect(isUsageProfileDirectory("claude", claudeDir)).toBe(true);
    expect(isUsageProfileDirectory("codex", codexDir)).toBe(true);
    expect(isUsageProfileDirectory("codex", claudeDir)).toBe(false);
    expect(isUsageProfileDirectory("claude", path.join(root, "missing"))).toBe(false);

    const store = createUsageAccountStore(dataDir);
    store.addProfile("claude", claudeDir);
    store.addProfile("claude", path.join(claudeDir, "."));
    store.addProfile("codex", codexDir);
    expect(store.listProfiles()).toHaveLength(2);
    expect(fs.existsSync(path.join(dataDir, "usage-accounts.json"))).toBe(true);
    if (process.platform !== "win32") {
      expect(fs.statSync(path.join(dataDir, "usage-accounts.json")).mode & 0o777).toBe(0o600);
    }
  });

  it("persists opaque account ids and distinct sanitized email labels locally", () => {
    const dataDir = tempRoot();
    const store = createUsageAccountStore(dataDir);
    store.observe("claude", reading("claude", { label: "person@example.test", key: "opaque-key-1" }));
    store.observe(
      "claude",
      reading("claude", { label: "second@example.test", key: "opaque-key-2" }, { checkedAt: 1_800_000_001_000 }),
    );

    expect(store.history("claude")).toEqual([
      {
        id: "opaque-key-2",
        label: "second@example.test",
        status: "last-seen",
        checkedAt: 1_800_000_001_000,
        windows: [{ label: "5-hour", usedPercent: 25, durationMinutes: 300 }],
      },
      {
        id: "opaque-key-1",
        label: "person@example.test",
        status: "last-seen",
        checkedAt: 1_800_000_000_000,
        windows: [{ label: "5-hour", usedPercent: 25, durationMinutes: 300 }],
      },
    ]);
    expect(fs.readFileSync(path.join(dataDir, "usage-accounts.json"), "utf8")).toContain("person@example.test");

    const reloaded = createUsageAccountStore(dataDir);
    expect(reloaded.history("claude").map((item) => item.id)).toEqual(["opaque-key-2", "opaque-key-1"]);
  });

  it("reloads the real provider account key formats", () => {
    const dataDir = tempRoot();
    const store = createUsageAccountStore(dataDir);
    const claudeKey = "a".repeat(64);
    const codexKey = `codex:${"b".repeat(64)}`;
    store.observe("claude", reading("claude", { label: "Claude", key: claudeKey }));
    store.observe("codex", reading("codex", { label: "Codex", key: codexKey }));

    const reloaded = createUsageAccountStore(dataDir);
    expect(
      reloaded
        .history()
        .map(({ id }) => id)
        .sort(),
    ).toEqual([claudeKey, codexKey].sort());
  });

  it("removes a temporary registry file when atomic replacement fails", () => {
    const dataDir = tempRoot();
    const directory = path.join(tempRoot(), "claude-profile");
    fs.mkdirSync(directory);
    fs.writeFileSync(path.join(directory, "settings.json"), "{}");
    const store = createUsageAccountStore(dataDir);
    const rename = vi.spyOn(fs, "renameSync").mockImplementationOnce(() => {
      throw new Error("simulated replace failure");
    });

    try {
      expect(() => store.addProfile("claude", directory)).toThrow("Could not save usage account settings.");
    } finally {
      rename.mockRestore();
    }
    expect(store.listProfiles()).toEqual([]);
    expect(fs.readdirSync(dataDir)).toEqual([]);
  });

  it("does not mistake sibling directories for provider profiles from a parent marker", () => {
    const root = tempRoot();
    const parent = path.join(root, "accounts");
    const sibling = path.join(parent, "other-account");
    fs.mkdirSync(sibling, { recursive: true });
    fs.writeFileSync(path.join(parent, ".claude.json"), "{}");
    expect(isUsageProfileDirectory("claude", sibling)).toBe(false);
    fs.writeFileSync(path.join(sibling, ".credentials.json"), "{}");
    expect(isUsageProfileDirectory("claude", sibling)).toBe(true);
  });

  it("skips unknown or failed readings and bounds window data", () => {
    const store = createUsageAccountStore(tempRoot());
    store.observe("codex", { ...reading("codex", { label: "Codex", key: "key" }), unavailable: "offline" });
    store.observe("codex", { ...reading("codex", { label: "Codex", key: "key" }), account: undefined });
    store.observe(
      "codex",
      reading(
        "codex",
        { label: "Codex", key: "key" },
        {
          windows: [
            { label: "weekly\nquota", usedPercent: 105 },
            { label: "weekly\nquota", usedPercent: 50, scope: "one@example.test" },
          ],
        },
      ),
    );
    expect(store.history("codex")[0].windows).toEqual([
      { label: "weekly quota", usedPercent: 50, scope: "one@example.test" },
    ]);
  });

  it("forgets registered paths and matching history without deleting the provider directory", () => {
    const root = tempRoot();
    const directory = path.join(root, "codex");
    fs.mkdirSync(directory);
    fs.writeFileSync(path.join(directory, "auth.json"), "{}");
    const store = createUsageAccountStore(path.join(root, "data"));
    store.addProfile("codex", directory);
    const profile = store.listProfiles()[0];
    store.observe("codex", reading("codex", { label: "Codex", key: profile.id }));

    store.removeProfile(profile.id);
    expect(store.listProfiles()).toEqual([]);
    expect(store.history()).toEqual([]);
    expect(fs.existsSync(path.join(directory, "auth.json"))).toBe(true);
  });

  it("does not return a deleted tracked directory as valid", () => {
    const root = tempRoot();
    const directory = path.join(root, "claude");
    fs.mkdirSync(directory);
    fs.writeFileSync(path.join(directory, "settings.json"), "{}");
    expect(isUsageProfileDirectory("claude", directory)).toBe(true);
    fs.rmSync(directory, { recursive: true });
    expect(isUsageProfileDirectory("claude", directory)).toBe(false);
  });
});
