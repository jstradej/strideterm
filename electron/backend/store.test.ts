import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { afterEach, describe, expect, test } from "vitest";
import { createDefaultState } from "./default-state.js";
import { createStore } from "./store.js";

const createdPaths: string[] = [];

async function createTempStatePath() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "strideterm-store-"));
  createdPaths.push(directory);
  return path.join(directory, "strideterm-state.json");
}

function makeState(overrides: Partial<ReturnType<typeof createDefaultState>> = {}) {
  return {
    ...createDefaultState(),
    ...overrides,
    settings: {
      ...createDefaultState().settings,
      ...overrides.settings,
    },
  };
}

async function writeJson(filePath: string, data: unknown) {
  await fs.writeFile(filePath, JSON.stringify(data, null, 2), "utf8");
}

async function ageFile(filePath: string, ageMs: number) {
  const date = new Date(Date.now() - ageMs);
  await fs.utimes(filePath, date, date);
}

afterEach(async () => {
  await Promise.all(createdPaths.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

describe("store", () => {
  test("serializes concurrent mutations", async () => {
    const store = await createStore(await createTempStatePath());

    await Promise.all([
      store.mutate(async (draft) => {
        await new Promise((resolve) => setTimeout(resolve, 25));
        draft.settings.theme = "light";
        draft.settings.remoteAccess.port = 50001;
      }),
      store.mutate(async (draft) => {
        draft.settings.sidebarWidth = 360;
      }),
    ]);

    expect(store.getState().settings.theme).toBe("light");
    expect(store.getState().settings.remoteAccess.port).toBe(50001);
    expect(store.getState().settings.sidebarWidth).toBe(360);
  });

  test("does not overwrite an unreadable existing state file", async () => {
    const statePath = await createTempStatePath();
    const brokenContent = "{ not-valid-json";
    await fs.writeFile(statePath, brokenContent, "utf8");

    await expect(createStore(statePath)).rejects.toThrow(/left untouched/i);
    await expect(fs.readFile(statePath, "utf8")).resolves.toBe(brokenContent);
  });

  test("recovers a newer valid tmp snapshot over an older main file", async () => {
    const statePath = await createTempStatePath();
    const mainState = makeState({ settings: { ...createDefaultState().settings, theme: "dark" } });
    const tmpState = makeState({ settings: { ...createDefaultState().settings, theme: "light", sidebarWidth: 333 } });
    const tmpPath = `${statePath}.tmp-123-recoverable`;

    await writeJson(statePath, mainState);
    await writeJson(tmpPath, tmpState);
    await ageFile(statePath, 60_000);
    await ageFile(tmpPath, 10_000);

    const store = await createStore(statePath);

    expect(store.getState().settings.theme).toBe("light");
    expect(store.getState().settings.sidebarWidth).toBe(333);
    await expect(fs.access(tmpPath)).rejects.toThrow();
    const persisted = JSON.parse(await fs.readFile(statePath, "utf8"));
    expect(persisted.settings.theme).toBe("light");
  });

  test("recovers a tmp snapshot written moments before the crash", async () => {
    const statePath = await createTempStatePath();
    const mainState = makeState({ settings: { ...createDefaultState().settings, theme: "dark" } });
    const tmpState = makeState({ settings: { ...createDefaultState().settings, theme: "light" } });
    const tmpPath = `${statePath}.tmp-123-fresh`;

    await writeJson(statePath, mainState);
    await ageFile(statePath, 60_000);
    // tmp keeps its just-written mtime — a crash immediately followed by a
    // relaunch must still pick it up.
    await writeJson(tmpPath, tmpState);

    const store = await createStore(statePath);

    expect(store.getState().settings.theme).toBe("light");
  });

  test("does not promote a parseable tmp that is not a state snapshot", async () => {
    const statePath = await createTempStatePath();
    const mainState = makeState({ settings: { ...createDefaultState().settings, theme: "dark", sidebarWidth: 288 } });
    const tmpPath = `${statePath}.tmp-123-garbage`;

    await writeJson(statePath, mainState);
    await fs.writeFile(tmpPath, "{}", "utf8");
    await ageFile(statePath, 60_000);
    await ageFile(tmpPath, 10_000);

    const store = await createStore(statePath);

    expect(store.getState().settings.theme).toBe("dark");
    expect(store.getState().settings.sidebarWidth).toBe(288);
    const persisted = JSON.parse(await fs.readFile(statePath, "utf8"));
    expect(persisted.settings.theme).toBe("dark");
  });

  test("ignores an empty tmp snapshot when the main file is valid", async () => {
    const statePath = await createTempStatePath();
    const mainState = makeState({ settings: { ...createDefaultState().settings, theme: "dark", sidebarWidth: 288 } });
    const tmpPath = `${statePath}.tmp-123-empty`;

    await writeJson(statePath, mainState);
    await fs.writeFile(tmpPath, "", "utf8");
    await ageFile(statePath, 60_000);
    await ageFile(tmpPath, 10_000);

    const store = await createStore(statePath);

    expect(store.getState().settings.theme).toBe("dark");
    expect(store.getState().settings.sidebarWidth).toBe(288);
    await expect(fs.access(tmpPath)).resolves.toBeUndefined();
  });

  test("recovers from backup when the main file is invalid", async () => {
    const statePath = await createTempStatePath();
    const backupState = makeState({
      settings: { ...createDefaultState().settings, theme: "light", sidebarWidth: 444 },
    });

    await fs.writeFile(statePath, "{ not-valid-json", "utf8");
    await writeJson(`${statePath}.bak`, backupState);

    const store = await createStore(statePath);

    expect(store.getState().settings.theme).toBe("light");
    expect(store.getState().settings.sidebarWidth).toBe(444);
    const persisted = JSON.parse(await fs.readFile(statePath, "utf8"));
    expect(persisted.settings.sidebarWidth).toBe(444);
  });

  test("prefers the backup over a garbage tmp and preserves the corrupt main", async () => {
    const statePath = await createTempStatePath();
    const brokenContent = "{ not-valid-json";
    const backupState = makeState({
      settings: { ...createDefaultState().settings, theme: "light", sidebarWidth: 444 },
    });
    const tmpPath = `${statePath}.tmp-123-garbage`;

    await fs.writeFile(statePath, brokenContent, "utf8");
    await writeJson(`${statePath}.bak`, backupState);
    await fs.writeFile(tmpPath, "{}", "utf8");

    const store = await createStore(statePath);

    expect(store.getState().settings.sidebarWidth).toBe(444);
    const entries = await fs.readdir(path.dirname(statePath));
    const corruptEntry = entries.find((entry) => entry.startsWith("strideterm-state.json.corrupt-"));
    expect(corruptEntry).toBeDefined();
    const preserved = await fs.readFile(path.join(path.dirname(statePath), corruptEntry as string), "utf8");
    expect(preserved).toBe(brokenContent);
  });

  test("sweeps aged recovery artifacts but keeps recent ones", async () => {
    const statePath = await createTempStatePath();
    const mainState = makeState({ settings: { ...createDefaultState().settings, theme: "dark" } });
    const staleTmpPath = `${statePath}.tmp-123-stale`;
    const staleBakTmpPath = `${statePath}.bak.tmp-123-stale`;
    const staleCorruptPath = `${statePath}.corrupt-old`;
    const freshCorruptPath = `${statePath}.corrupt-new`;

    await writeJson(statePath, mainState);
    await writeJson(staleTmpPath, mainState);
    await writeJson(staleBakTmpPath, mainState);
    await fs.writeFile(staleCorruptPath, "old", "utf8");
    await fs.writeFile(freshCorruptPath, "new", "utf8");
    await ageFile(staleTmpPath, 2 * 60 * 60 * 1000);
    await ageFile(staleBakTmpPath, 2 * 60 * 60 * 1000);
    await ageFile(staleCorruptPath, 31 * 24 * 60 * 60 * 1000);

    const store = await createStore(statePath);

    expect(store.getState().settings.theme).toBe("dark");
    await expect(fs.access(staleTmpPath)).rejects.toThrow();
    await expect(fs.access(staleBakTmpPath)).rejects.toThrow();
    await expect(fs.access(staleCorruptPath)).rejects.toThrow();
    await expect(fs.access(freshCorruptPath)).resolves.toBeUndefined();
  });

  test("writes a backup of the previous main file before replacing it", async () => {
    const statePath = await createTempStatePath();
    const store = await createStore(statePath);

    const originalTheme = store.getState().settings.theme;
    await store.mutate("settings:test-theme", (draft) => {
      draft.settings.theme = originalTheme === "dark" ? "light" : "dark";
    });

    const backup = JSON.parse(await fs.readFile(`${statePath}.bak`, "utf8"));
    const persisted = JSON.parse(await fs.readFile(statePath, "utf8"));
    expect(backup.settings.theme).toBe(originalTheme);
    expect(persisted.settings.theme).not.toBe(originalTheme);

    // The .bak refresh is throttled: an immediate follow-up mutate must not
    // overwrite the backup with the state persisted a moment ago.
    await store.mutate((draft) => {
      draft.settings.sidebarWidth = 311;
    });
    const backupAfter = JSON.parse(await fs.readFile(`${statePath}.bak`, "utf8"));
    expect(backupAfter.settings.theme).toBe(originalTheme);
    expect(backupAfter.settings.sidebarWidth).not.toBe(311);
  });

  test("rejects mutate calls without a mutator", async () => {
    const store = await createStore(await createTempStatePath());
    const mutateUnchecked = store.mutate as unknown as (label: string) => Promise<unknown>;
    await expect(mutateUnchecked("label-only")).rejects.toThrow(/requires a mutator/);
  });
});
