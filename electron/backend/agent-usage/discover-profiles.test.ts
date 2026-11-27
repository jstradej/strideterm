import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { discoverUsageProfiles } from "./discover-profiles.js";

const roots: string[] = [];

function fixtureHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "usage-profile-discovery-"));
  roots.push(home);
  return home;
}

function profile(home: string, name: string, footprint: "claude" | "codex") {
  const directory = path.join(home, name);
  fs.mkdirSync(directory);
  const fixtureFile = footprint === "claude" ? "settings.json" : "config.toml";
  fs.writeFileSync(path.join(directory, fixtureFile), "fixture");
  return directory;
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("discoverUsageProfiles", () => {
  it("suggests only one-level conventional homes with provider footprints", async () => {
    const home = fixtureHome();
    const claude = profile(home, ".claude-work", "claude");
    const codex = profile(home, ".codex-personal", "codex");
    fs.mkdirSync(path.join(home, ".claude-empty"));
    fs.mkdirSync(path.join(home, "nested"));
    profile(path.join(home, "nested"), ".codex-hidden", "codex");
    profile(home, "claude-work", "claude");
    profile(home, ".codex", "codex");
    profile(home, ".claude", "claude");

    const results = await discoverUsageProfiles([], home);
    expect(results.map(({ provider, directory, label }) => ({ provider, directory, label }))).toEqual([
      { provider: "claude", directory: claude, label: ".claude-work" },
      { provider: "codex", directory: codex, label: ".codex-personal" },
    ]);
    expect(results.every(({ id }) => /^candidate-[a-f0-9]{24}$/.test(id))).toBe(true);
    expect((await discoverUsageProfiles([], home)).map(({ id }) => id)).toEqual(results.map(({ id }) => id));
  });

  it("excludes tracked paths and skips links", async () => {
    const home = fixtureHome();
    const tracked = profile(home, ".codex-team", "codex");
    const target = profile(home, "target", "claude");
    const link = path.join(home, ".claude-linked");
    try {
      fs.symlinkSync(target, link, "junction");
    } catch {
      // Symlink creation can be unavailable in restricted Windows test hosts.
    }

    const results = await discoverUsageProfiles([{ directory: tracked }], home);
    expect(results.some(({ directory }) => directory === tracked)).toBe(false);
    expect(results.some(({ directory }) => directory === link)).toBe(false);
  });

  it("excludes active environment-selected homes", async () => {
    const home = fixtureHome();
    const active = profile(home, ".codex-active", "codex");
    const other = profile(home, ".codex-other", "codex");
    const previous = process.env.CODEX_HOME;
    process.env.CODEX_HOME = active;
    try {
      const results = await discoverUsageProfiles([], home);
      expect(results.map(({ directory }) => directory)).toEqual([other]);
    } finally {
      if (previous === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previous;
    }
  });

  it("returns an empty list for invalid or unreadable homes", async () => {
    expect(await discoverUsageProfiles([], path.join(os.tmpdir(), "usage-profile-home-missing"))).toEqual([]);
    expect(await discoverUsageProfiles([], "\0invalid-home")).toEqual([]);
  });
});
