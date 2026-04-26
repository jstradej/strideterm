import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  configureGeminiHook,
  removeGeminiHook,
  detectGeminiHookStatus,
  findExistingHook,
  getGeminiSettingsPath,
  GEMINI_HOOK_MAP,
} from "./gemini-hook-config.js";

let tempDir: string;
let mockHomedir: string;
let userDataPath: string;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let originalHomedir: any;

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "strideterm-gemini-hook-"));
  mockHomedir = path.join(tempDir, "home");
  await fs.mkdir(mockHomedir, { recursive: true });
  userDataPath = path.join(tempDir, "strideterm-data");
  await fs.mkdir(userDataPath, { recursive: true });

  originalHomedir = os.homedir;
  os.homedir = () => mockHomedir;
});

afterEach(async () => {
  os.homedir = originalHomedir;
  await fs.rm(tempDir, { recursive: true, force: true });
});

describe("configureGeminiHook", () => {
  test("writes notify.mjs and user-level settings with all mapped hooks in nested shape", async () => {
    const result = await configureGeminiHook(userDataPath);

    expect(result.ok).toBe(true);
    expect(result.registered).toEqual(Object.keys(GEMINI_HOOK_MAP));
    expect(result.settingsPath).toBe(path.join(mockHomedir, ".gemini", "settings.json"));
    expect(result.scriptPath).toBe(path.join(userDataPath, "hooks", "notify.mjs"));

    // notify.mjs must exist at the reported path
    expect(existsSync(result.scriptPath!)).toBe(true);

    const settings = JSON.parse(await fs.readFile(getGeminiSettingsPath(), "utf8"));
    for (const [geminiEvent, claudeAlias] of Object.entries(GEMINI_HOOK_MAP)) {
      expect(settings.hooks[geminiEvent]).toHaveLength(1);
      const wrapper = settings.hooks[geminiEvent][0];
      expect(wrapper.matcher).toBe("*");
      expect(wrapper.hooks).toHaveLength(1);
      const inner = wrapper.hooks[0];
      expect(inner.type).toBe("command");
      expect(inner.command).toContain("notify.mjs");
      expect(inner.command).toContain(claudeAlias);
      expect(inner.timeout).toBe(5000);
    }
  });

  test("upgrades legacy flat-shape strIDEterm entry to nested shape", async () => {
    const geminiDir = path.join(mockHomedir, ".gemini");
    await fs.mkdir(geminiDir, { recursive: true });
    // Simulate an older strIDEterm install that wrote the (wrong) flat shape
    await fs.writeFile(
      getGeminiSettingsPath(),
      JSON.stringify({
        hooks: {
          AfterAgent: [{ name: "strideterm-Stop", type: "command", command: "node /old/path/hooks/notify.mjs Stop" }],
        },
      }),
    );

    await configureGeminiHook(userDataPath);

    const settings = JSON.parse(await fs.readFile(getGeminiSettingsPath(), "utf8"));
    // Legacy entry was replaced — not duplicated
    expect(settings.hooks.AfterAgent).toHaveLength(1);
    // And it now has the nested shape Gemini actually honors
    expect(settings.hooks.AfterAgent[0].matcher).toBe("*");
    expect(Array.isArray(settings.hooks.AfterAgent[0].hooks)).toBe(true);
  });

  test("preserves existing unrelated settings (MCP servers, extensions)", async () => {
    const geminiDir = path.join(mockHomedir, ".gemini");
    await fs.mkdir(geminiDir, { recursive: true });
    const existing = {
      mcpServers: { foo: { command: "bar" } },
      extensions: ["ext1"],
      customKey: "keepMe",
    };
    await fs.writeFile(getGeminiSettingsPath(), JSON.stringify(existing, null, 2));

    const result = await configureGeminiHook(userDataPath);
    expect(result.ok).toBe(true);

    const merged = JSON.parse(await fs.readFile(getGeminiSettingsPath(), "utf8"));
    expect(merged.mcpServers).toEqual(existing.mcpServers);
    expect(merged.extensions).toEqual(existing.extensions);
    expect(merged.customKey).toBe("keepMe");
    expect(merged.hooks.AfterAgent).toHaveLength(1);
  });

  test("preserves user-defined hooks alongside strIDEterm hooks", async () => {
    const geminiDir = path.join(mockHomedir, ".gemini");
    await fs.mkdir(geminiDir, { recursive: true });
    const existing = {
      hooks: {
        AfterAgent: [
          {
            matcher: "*",
            hooks: [{ name: "user-hook", type: "command", command: "echo custom" }],
          },
        ],
        BeforeTool: [
          {
            matcher: "write_file",
            hooks: [{ name: "other", type: "command", command: "other" }],
          },
        ],
      },
    };
    await fs.writeFile(getGeminiSettingsPath(), JSON.stringify(existing, null, 2));

    await configureGeminiHook(userDataPath);

    const settings = JSON.parse(await fs.readFile(getGeminiSettingsPath(), "utf8"));
    expect(settings.hooks.AfterAgent).toHaveLength(2);
    expect(settings.hooks.AfterAgent[0].hooks[0].command).toBe("echo custom");
    expect(settings.hooks.AfterAgent[1].hooks[0].command).toContain("notify.mjs");
    expect(settings.hooks.BeforeTool[0].hooks[0].command).toBe("other");
  });

  test("is idempotent — re-running replaces existing strIDEterm entry", async () => {
    await configureGeminiHook(userDataPath);
    await configureGeminiHook(userDataPath);

    const settings = JSON.parse(await fs.readFile(getGeminiSettingsPath(), "utf8"));
    for (const event of Object.keys(GEMINI_HOOK_MAP)) {
      expect(settings.hooks[event]).toHaveLength(1);
    }
  });

  test("command uses forward slashes for cross-platform shell compat", async () => {
    await configureGeminiHook(userDataPath);
    const settings = JSON.parse(await fs.readFile(getGeminiSettingsPath(), "utf8"));
    expect(settings.hooks.AfterAgent[0].hooks[0].command).not.toContain("\\");
  });
});

describe("findExistingHook", () => {
  test("returns -1 when hooks section is missing", () => {
    expect(findExistingHook({}, "AfterAgent")).toBe(-1);
    expect(findExistingHook({ hooks: {} }, "AfterAgent")).toBe(-1);
  });

  test("returns index of strIDEterm entry (nested shape)", () => {
    const settings = {
      hooks: {
        AfterAgent: [
          { matcher: "*", hooks: [{ name: "user", command: "echo" }] },
          { matcher: "*", hooks: [{ name: "strideterm", command: "node hooks/notify.mjs Stop" }] },
        ],
      },
    };
    expect(findExistingHook(settings, "AfterAgent")).toBe(1);
  });

  test("detects legacy flat-shape entry for migration", () => {
    const settings = {
      hooks: {
        AfterAgent: [{ name: "strideterm", command: "node hooks/notify.mjs Stop" }],
      },
    };
    expect(findExistingHook(settings, "AfterAgent")).toBe(0);
  });

  test("ignores entries without the marker", () => {
    const settings = {
      hooks: {
        AfterAgent: [{ matcher: "*", hooks: [{ name: "foo", command: "other-tool" }] }],
      },
    };
    expect(findExistingHook(settings, "AfterAgent")).toBe(-1);
  });
});

describe("removeGeminiHook", () => {
  test("removes strIDEterm entries and leaves user entries intact", async () => {
    const geminiDir = path.join(mockHomedir, ".gemini");
    await fs.mkdir(geminiDir, { recursive: true });
    await fs.writeFile(
      getGeminiSettingsPath(),
      JSON.stringify({
        hooks: {
          AfterAgent: [{ matcher: "*", hooks: [{ name: "user-hook", command: "echo" }] }],
        },
      }),
    );
    await configureGeminiHook(userDataPath);

    const result = await removeGeminiHook();
    expect(result.ok).toBe(true);
    expect(result.removed).toBe(true);
    expect(result.removedFrom).toContain("AfterAgent");

    const settings = JSON.parse(await fs.readFile(getGeminiSettingsPath(), "utf8"));
    expect(settings.hooks.AfterAgent).toHaveLength(1);
    expect(settings.hooks.AfterAgent[0].hooks[0].name).toBe("user-hook");
  });

  test("is a no-op when no strIDEterm hooks are present", async () => {
    const geminiDir = path.join(mockHomedir, ".gemini");
    await fs.mkdir(geminiDir, { recursive: true });
    await fs.writeFile(getGeminiSettingsPath(), JSON.stringify({ mcpServers: {} }));

    const result = await removeGeminiHook();
    expect(result.ok).toBe(true);
    expect(result.removed).toBe(false);
  });

  test("returns ok with removed=false when settings file is missing", async () => {
    const result = await removeGeminiHook();
    expect(result.ok).toBe(true);
    expect(result.removed).toBe(false);
  });
});

describe("detectGeminiHookStatus", () => {
  test("returns not-configured when settings file is missing", async () => {
    const status = await detectGeminiHookStatus(userDataPath);
    expect(status.status).toBe("not-configured");
  });

  test("returns not-configured when file exists without strIDEterm hooks", async () => {
    const geminiDir = path.join(mockHomedir, ".gemini");
    await fs.mkdir(geminiDir, { recursive: true });
    await fs.writeFile(getGeminiSettingsPath(), JSON.stringify({ mcpServers: {} }));

    const status = await detectGeminiHookStatus(userDataPath);
    expect(status.status).toBe("not-configured");
  });

  test("returns configured after configureGeminiHook", async () => {
    await configureGeminiHook(userDataPath);
    const status = await detectGeminiHookStatus(userDataPath);
    expect(status.status).toBe("configured");
    expect(status.registered).toEqual(Object.keys(GEMINI_HOOK_MAP));
  });

  test("returns partial when only some events are registered", async () => {
    await configureGeminiHook(userDataPath);
    // Remove one event manually to simulate a mid-upgrade state
    const settings = JSON.parse(await fs.readFile(getGeminiSettingsPath(), "utf8"));
    delete settings.hooks.BeforeAgent;
    await fs.writeFile(getGeminiSettingsPath(), JSON.stringify(settings, null, 2));

    const status = await detectGeminiHookStatus(userDataPath);
    expect(status.status).toBe("partial");
    expect(status.missingHooks).toContain("BeforeAgent");
  });

  test("returns script-missing when hooks exist but notify.mjs is gone", async () => {
    await configureGeminiHook(userDataPath);
    await fs.rm(path.join(userDataPath, "hooks", "notify.mjs"));

    const status = await detectGeminiHookStatus(userDataPath);
    expect(status.status).toBe("script-missing");
  });
});
