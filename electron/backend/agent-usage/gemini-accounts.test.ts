import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readGeminiKnownAccounts } from "./gemini-accounts.js";

const tempHomes: string[] = [];

async function useHome(): Promise<string> {
  const home = await mkdtemp(path.join(os.tmpdir(), "strideterm-gemini-accounts-"));
  tempHomes.push(home);
  vi.spyOn(os, "homedir").mockReturnValue(home);
  await mkdir(path.join(home, ".gemini"), { recursive: true });
  return path.join(home, ".gemini", "google_accounts.json");
}

afterEach(async () => {
  vi.restoreAllMocks();
  delete process.env.GEMINI_CLI_HOME;
  delete process.env.SANDBOX;
  await Promise.all(tempHomes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

describe("Gemini known account metadata", () => {
  it("lists active and previously used emails without attaching quota data", async () => {
    const accountPath = await useHome();
    await writeFile(accountPath, JSON.stringify({ active: "current@example.com", old: ["previous@example.com"] }));

    const result = await readGeminiKnownAccounts();

    expect(result).toHaveLength(2);
    expect(result.map(({ label, status, windows }) => ({ label, status, windows }))).toEqual([
      { label: "previous@example.com", status: "listed", windows: undefined },
      { label: "current@example.com", status: "listed", windows: undefined },
    ]);
    expect(result.every(({ id }) => id.startsWith("gemini:") && !id.includes("@"))).toBe(true);
  });

  it("deduplicates case-insensitively and handles an inactive account index", async () => {
    const accountPath = await useHome();
    await writeFile(accountPath, JSON.stringify({ active: null, old: ["a@example.com", "A@example.com"] }));

    expect(await readGeminiKnownAccounts()).toHaveLength(1);
  });

  it.each([
    ["malformed JSON", "{"],
    ["invalid schema", JSON.stringify({ active: ["bad"], old: [] })],
    ["invalid email", JSON.stringify({ active: "not-an-email", old: [] })],
    ["overlong email", JSON.stringify({ active: `${"a".repeat(250)}@example.com`, old: [] })],
    ["oversized metadata", JSON.stringify({ active: "a@example.com", old: [] }).padEnd(65 * 1024, " ")],
  ])("ignores %s", async (_name, contents) => {
    const accountPath = await useHome();
    await writeFile(accountPath, contents);

    expect(await readGeminiKnownAccounts()).toEqual([]);
  });

  it("returns an empty listing when the metadata file is absent", async () => {
    await useHome();
    expect(await readGeminiKnownAccounts()).toEqual([]);
  });

  it("keeps the listing bounded when there are 64 prior accounts plus a new active account", async () => {
    const accountPath = await useHome();
    const old = Array.from({ length: 64 }, (_, index) => `old${index}@example.com`);
    await writeFile(accountPath, JSON.stringify({ active: "current@example.com", old }));

    const result = await readGeminiKnownAccounts();
    expect(result).toHaveLength(64);
    expect(result.some(({ label }) => label === "current@example.com")).toBe(true);
  });

  it.runIf(process.platform !== "win32")("does not follow a symlink to account metadata", async () => {
    const accountPath = await useHome();
    const outsidePath = path.join(path.dirname(path.dirname(accountPath)), "external-account-index.json");
    await writeFile(outsidePath, JSON.stringify({ active: "outside@example.com", old: [] }));
    await rm(accountPath, { force: true });
    await symlink(outsidePath, accountPath);

    expect(await readGeminiKnownAccounts()).toEqual([]);
  });

  it("honors Gemini CLI's custom home and sandbox runtime location", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "strideterm-gemini-custom-home-"));
    tempHomes.push(home);
    process.env.GEMINI_CLI_HOME = home;
    process.env.SANDBOX = "sandbox-exec";
    const runtimeDir = path.join(home, ".cache", ".gemini");
    await mkdir(runtimeDir, { recursive: true });
    await writeFile(
      path.join(runtimeDir, "google_accounts.json"),
      JSON.stringify({ active: "custom@example.com", old: [] }),
    );

    expect((await readGeminiKnownAccounts()).map(({ label }) => label)).toEqual(["custom@example.com"]);
  });
});
