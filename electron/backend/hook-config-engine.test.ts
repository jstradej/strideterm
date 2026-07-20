import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  atomicWriteFile,
  readJsonConfig,
  writeJsonConfig,
  findHookIndex,
  matchesNestedCommandEntry,
  buildNestedCommandEntry,
  configureHookEntries,
  removeHookEntries,
  detectHookEntriesStatus,
} from "./hook-config-engine.js";

let tempDir: string;

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "strideterm-hook-engine-test-"));
});

afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
});

// --- atomicWriteFile ---

describe("atomicWriteFile", () => {
  test("writes the file and leaves no tmp file behind on success", async () => {
    const target = path.join(tempDir, "out.json");
    await atomicWriteFile(target, "hello");
    expect(await fs.readFile(target, "utf8")).toBe("hello");
    expect(existsSync(`${target}.strideterm-tmp`)).toBe(false);
  });

  test("honors a custom tmp suffix", async () => {
    const target = path.join(tempDir, "out2.json");
    await atomicWriteFile(target, "world", ".custom-tmp");
    expect(await fs.readFile(target, "utf8")).toBe("world");
    expect(existsSync(`${target}.custom-tmp`)).toBe(false);
  });

  test("throws (does not swallow) when the rename target cannot be replaced", async () => {
    // Target is an existing directory — fs.rename(file, dir) always fails.
    const target = path.join(tempDir, "as-a-dir");
    await fs.mkdir(target);
    await expect(atomicWriteFile(target, "data")).rejects.toThrow();
  });
});

// --- readJsonConfig / writeJsonConfig ---

describe("writeJsonConfig", () => {
  test("creates parent directories and writes pretty JSON with a trailing newline", async () => {
    const configPath = path.join(tempDir, "nested", "dir", "config.json");
    const result = await writeJsonConfig(configPath, { hello: "world" });
    expect(result.ok).toBe(true);
    const content = await fs.readFile(configPath, "utf8");
    expect(content).toBe(`${JSON.stringify({ hello: "world" }, null, 2)}\n`);
  });

  test("cleans up the tmp file when the write/rename fails", async () => {
    // configPath itself is a directory, so the rename step always fails.
    const configPath = path.join(tempDir, "as-a-dir");
    await fs.mkdir(configPath);
    const result = await writeJsonConfig(configPath, { a: 1 });
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
    expect(existsSync(`${configPath}.strideterm-tmp`)).toBe(false);
  });
});

describe("readJsonConfig", () => {
  test("returns ok:true data:null when the file is missing", async () => {
    const result = await readJsonConfig(path.join(tempDir, "missing.json"));
    expect(result.ok).toBe(true);
    expect(result.data).toBeNull();
  });

  test("returns parsed data when the file exists", async () => {
    const configPath = path.join(tempDir, "config.json");
    await fs.writeFile(configPath, JSON.stringify({ a: 1 }));
    const result = await readJsonConfig(configPath);
    expect(result.ok).toBe(true);
    expect(result.data).toEqual({ a: 1 });
  });

  test("returns ok:false on a parse error", async () => {
    const configPath = path.join(tempDir, "bad.json");
    await fs.writeFile(configPath, "{ not json");
    const result = await readJsonConfig(configPath);
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
  });

  test("uses a custom parser when provided", async () => {
    const configPath = path.join(tempDir, "jsonc.json");
    await fs.writeFile(configPath, '// comment\n{ "a": 1 }');
    const result = await readJsonConfig(configPath, (raw) => JSON.parse(raw.replace(/^\/\/.*\n/, "")));
    expect(result.ok).toBe(true);
    expect(result.data).toEqual({ a: 1 });
  });
});

// --- findHookIndex / matchesNestedCommandEntry / buildNestedCommandEntry ---

describe("findHookIndex", () => {
  test("returns -1 when the hooks section is missing or not an array", () => {
    expect(findHookIndex({}, "Stop", ["marker"], matchesNestedCommandEntry)).toBe(-1);
    expect(findHookIndex({ hooks: {} }, "Stop", ["marker"], matchesNestedCommandEntry)).toBe(-1);
    expect(findHookIndex({ hooks: { Stop: "not-an-array" } }, "Stop", ["marker"], matchesNestedCommandEntry)).toBe(-1);
  });

  test("finds the nested-shape entry containing a marker", () => {
    const container = {
      hooks: {
        Stop: [
          { matcher: "", hooks: [{ type: "command", command: "echo user" }] },
          { matcher: "", hooks: [{ type: "command", command: 'node "/x/hooks/notify.mjs" Stop' }] },
        ],
      },
    };
    expect(findHookIndex(container, "Stop", ["hooks/notify.mjs"], matchesNestedCommandEntry)).toBe(1);
  });

  test("supports a fully custom matcher for non-nested entry shapes", () => {
    const matchesFlagEntry = (entry: unknown) => (entry as { tag?: string })?.tag === "strideterm";
    const container = { hooks: { onEvent: [{ tag: "user" }, { tag: "strideterm" }] } };
    expect(findHookIndex(container, "onEvent", [], matchesFlagEntry)).toBe(1);
  });
});

describe("buildNestedCommandEntry", () => {
  test("normalizes backslashes and embeds the canonical name as argv", () => {
    const entry = buildNestedCommandEntry("C:\\data\\hooks\\notify.mjs", "Stop") as {
      matcher: string;
      hooks: Array<{ command: string; timeout: number }>;
    };
    expect(entry.matcher).toBe("");
    expect(entry.hooks[0].command).toBe('node "C:/data/hooks/notify.mjs" Stop');
    expect(entry.hooks[0].timeout).toBe(5);
  });
});

// --- configureHookEntries / removeHookEntries / detectHookEntriesStatus ---
// Exercised with a synthetic descriptor (flat `{ tag, target }` entries)
// unrelated to any real provider's shape.

const FAKE_MARKERS = ["fake-marker"];
function buildFakeEntry(scriptPath: string, canonicalName: string) {
  return { tag: "fake-marker", target: `${scriptPath}#${canonicalName}` };
}
function matchesFakeEntry(entry: unknown): boolean {
  return (entry as { tag?: string })?.tag === "fake-marker";
}
const FAKE_EVENT_MAP = { onA: "A", onB: "B" };

describe("configureHookEntries", () => {
  test("creates the config file and registers every mapped event", async () => {
    const configPath = path.join(tempDir, "fake-config.json");
    const result = await configureHookEntries(configPath, FAKE_EVENT_MAP, "/script", {
      hookMarkers: FAKE_MARKERS,
      buildEntry: buildFakeEntry,
      matchesEntry: matchesFakeEntry,
      readFailedDetail: "read-failed",
      writeFailedDetail: "write-failed",
    });
    expect(result.ok).toBe(true);
    expect(result.registered).toEqual(["onA", "onB"]);

    const written = JSON.parse(await fs.readFile(configPath, "utf8"));
    expect(written.hooks.onA).toHaveLength(1);
    expect(written.hooks.onA[0].target).toBe("/script#A");
  });

  test("preserves unrelated keys and replaces an existing strIDEterm entry in place", async () => {
    const configPath = path.join(tempDir, "fake-config2.json");
    await fs.writeFile(
      configPath,
      JSON.stringify({
        unrelated: true,
        hooks: {
          onA: [{ tag: "user" }, { tag: "fake-marker", target: "/old#A" }],
        },
      }),
    );

    const result = await configureHookEntries(configPath, FAKE_EVENT_MAP, "/script", {
      hookMarkers: FAKE_MARKERS,
      buildEntry: buildFakeEntry,
      matchesEntry: matchesFakeEntry,
      readFailedDetail: "read-failed",
      writeFailedDetail: "write-failed",
    });
    expect(result.ok).toBe(true);

    const written = JSON.parse(await fs.readFile(configPath, "utf8"));
    expect(written.unrelated).toBe(true);
    expect(written.hooks.onA).toHaveLength(2);
    expect(written.hooks.onA[0].tag).toBe("user");
    expect(written.hooks.onA[1].target).toBe("/script#A"); // replaced in place, not duplicated
  });

  test("surfaces a read failure with the provided detail", async () => {
    const configPath = path.join(tempDir, "fake-bad.json");
    await fs.writeFile(configPath, "{ not json");

    const result = await configureHookEntries(configPath, FAKE_EVENT_MAP, "/script", {
      hookMarkers: FAKE_MARKERS,
      buildEntry: buildFakeEntry,
      matchesEntry: matchesFakeEntry,
      readFailedDetail: "read-failed",
      writeFailedDetail: "write-failed",
    });
    expect(result.ok).toBe(false);
    expect(result.detail).toBe("read-failed");
  });
});

describe("removeHookEntries", () => {
  test("strips only strIDEterm entries and cleans up empty categories", async () => {
    const configPath = path.join(tempDir, "fake-config3.json");
    await fs.writeFile(
      configPath,
      JSON.stringify({
        hooks: {
          onA: [{ tag: "user" }, { tag: "fake-marker", target: "/x#A" }],
          onB: [{ tag: "fake-marker", target: "/x#B" }],
        },
      }),
    );

    const result = await removeHookEntries(configPath, Object.keys(FAKE_EVENT_MAP), {
      hookMarkers: FAKE_MARKERS,
      matchesEntry: matchesFakeEntry,
    });
    expect(result.ok).toBe(true);
    expect(result.removed).toBe(true);
    expect(result.removedFrom).toEqual(expect.arrayContaining(["onA", "onB"]));

    const written = JSON.parse(await fs.readFile(configPath, "utf8"));
    expect(written.hooks.onA).toHaveLength(1);
    expect(written.hooks.onA[0].tag).toBe("user");
    expect(written.hooks.onB).toBeUndefined();
  });

  test("is a no-op when the config file does not exist", async () => {
    const result = await removeHookEntries(path.join(tempDir, "missing.json"), Object.keys(FAKE_EVENT_MAP), {
      hookMarkers: FAKE_MARKERS,
      matchesEntry: matchesFakeEntry,
    });
    expect(result).toEqual({ ok: true, removed: false });
  });
});

describe("detectHookEntriesStatus", () => {
  test("walks not-configured -> script-missing -> partial -> configured", async () => {
    const configPath = path.join(tempDir, "fake-config4.json");
    const scriptPath = path.join(tempDir, "script.js");

    // Not configured: no file at all.
    let status = await detectHookEntriesStatus(configPath, scriptPath, FAKE_EVENT_MAP, {
      hookMarkers: FAKE_MARKERS,
      matchesEntry: matchesFakeEntry,
    });
    expect(status.status).toBe("not-configured");

    // Entries exist but the script doesn't -> script-missing takes precedence over partial.
    await fs.writeFile(configPath, JSON.stringify({ hooks: { onA: [{ tag: "fake-marker", target: "/x#A" }] } }));
    status = await detectHookEntriesStatus(configPath, scriptPath, FAKE_EVENT_MAP, {
      hookMarkers: FAKE_MARKERS,
      matchesEntry: matchesFakeEntry,
    });
    expect(status.status).toBe("script-missing");

    // Script now present, only one of two events registered -> partial.
    await fs.writeFile(scriptPath, "// script");
    status = await detectHookEntriesStatus(configPath, scriptPath, FAKE_EVENT_MAP, {
      hookMarkers: FAKE_MARKERS,
      matchesEntry: matchesFakeEntry,
    });
    expect(status.status).toBe("partial");
    expect(status.registered).toEqual(["onA"]);
    expect(status.missingHooks).toEqual(["onB"]);

    // Both events registered -> configured.
    await fs.writeFile(
      configPath,
      JSON.stringify({
        hooks: {
          onA: [{ tag: "fake-marker", target: "/x#A" }],
          onB: [{ tag: "fake-marker", target: "/x#B" }],
        },
      }),
    );
    status = await detectHookEntriesStatus(configPath, scriptPath, FAKE_EVENT_MAP, {
      hookMarkers: FAKE_MARKERS,
      matchesEntry: matchesFakeEntry,
    });
    expect(status.status).toBe("configured");
  });

  test("extraCheck can override the result before the partial/configured decision", async () => {
    const configPath = path.join(tempDir, "fake-config5.json");
    const scriptPath = path.join(tempDir, "script2.js");
    await fs.writeFile(scriptPath, "// script");
    await fs.writeFile(
      configPath,
      JSON.stringify({
        hooks: {
          onA: [{ tag: "fake-marker", target: "/x#A" }],
          onB: [{ tag: "fake-marker", target: "/x#B" }],
        },
      }),
    );

    const status = await detectHookEntriesStatus(configPath, scriptPath, FAKE_EVENT_MAP, {
      hookMarkers: FAKE_MARKERS,
      matchesEntry: matchesFakeEntry,
      extraCheck: () => ({ status: "disabled-by-fake-flag" }),
    });
    expect(status.status).toBe("disabled-by-fake-flag");
    // registered/missingHooks are still populated from the base computation.
    expect(status.registered).toEqual(["onA", "onB"]);
    expect(status.missingHooks).toEqual([]);
  });

  test("a read error surfaces as status:error", async () => {
    const configPath = path.join(tempDir, "fake-bad2.json");
    await fs.writeFile(configPath, "{ not json");
    const status = await detectHookEntriesStatus(configPath, path.join(tempDir, "script3.js"), FAKE_EVENT_MAP, {
      hookMarkers: FAKE_MARKERS,
      matchesEntry: matchesFakeEntry,
    });
    expect(status.status).toBe("error");
    expect(status.error).toBeTruthy();
  });
});
