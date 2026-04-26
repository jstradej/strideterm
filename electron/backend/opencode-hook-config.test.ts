import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  configureOpencodeHook,
  removeOpencodeHook,
  detectOpencodeHookStatus,
  findExistingHook,
  getOpencodeConfigPath,
  getOpencodeConfigDir,
  HOOKS_TO_REGISTER,
} from "./opencode-hook-config.js";

let tempDir: string;
let mockHomedir: string;
let userDataPath: string;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let originalHomedir: any;
let originalEnv: Record<string, string | undefined>;

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "strideterm-opencode-hook-"));
  mockHomedir = path.join(tempDir, "home");
  await fs.mkdir(mockHomedir, { recursive: true });
  userDataPath = path.join(tempDir, "strideterm-data");
  await fs.mkdir(userDataPath, { recursive: true });

  originalHomedir = os.homedir;
  os.homedir = () => mockHomedir;
  originalEnv = {
    OPENCODE_HOME: process.env.OPENCODE_HOME,
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
    APPDATA: process.env.APPDATA,
  };
  // Unset OPENCODE_HOME so tests use the platform default
  delete process.env.OPENCODE_HOME;
  if (process.platform === "win32") {
    // Point APPDATA to our temp dir so tests are isolated on Windows
    process.env.APPDATA = path.join(mockHomedir, "AppData", "Roaming");
  } else {
    // Point XDG_CONFIG_HOME to our temp dir so tests are isolated on Linux/macOS
    process.env.XDG_CONFIG_HOME = path.join(mockHomedir, ".config");
  }
});

afterEach(async () => {
  os.homedir = originalHomedir;
  for (const [k, v] of Object.entries(originalEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  await fs.rm(tempDir, { recursive: true, force: true });
});

describe("getOpencodeConfigPath", () => {
  test("uses OPENCODE_HOME when set", () => {
    const customDir = path.join(tempDir, "custom-opencode");
    process.env.OPENCODE_HOME = customDir;
    expect(getOpencodeConfigPath()).toBe(path.join(customDir, "config.json"));
  });

  test("returns a path ending in config.json", () => {
    expect(getOpencodeConfigPath()).toMatch(/config\.json$/);
  });
});

describe("HOOKS_TO_REGISTER", () => {
  test("includes Stop and UserPromptSubmit", () => {
    expect(HOOKS_TO_REGISTER).toContain("Stop");
    expect(HOOKS_TO_REGISTER).toContain("UserPromptSubmit");
  });
});

describe("configureOpencodeHook", () => {
  test("creates config with hook entries when file missing", async () => {
    const result = await configureOpencodeHook(userDataPath);
    expect(result.ok).toBe(true);
    expect(result.registered).toEqual(expect.arrayContaining(["Stop", "UserPromptSubmit"]));

    const configPath = getOpencodeConfigPath();
    expect(existsSync(configPath)).toBe(true);

    const content = JSON.parse(await fs.readFile(configPath, "utf8"));
    expect(content.hooks).toBeDefined();
    expect(Array.isArray(content.hooks.Stop)).toBe(true);
    expect(Array.isArray(content.hooks.UserPromptSubmit)).toBe(true);
  });

  test("is idempotent — re-running does not duplicate entries", async () => {
    await configureOpencodeHook(userDataPath);
    await configureOpencodeHook(userDataPath);

    const content = JSON.parse(await fs.readFile(getOpencodeConfigPath(), "utf8"));
    expect(content.hooks.Stop).toHaveLength(1);
    expect(content.hooks.UserPromptSubmit).toHaveLength(1);
  });

  test("preserves existing user keys in config", async () => {
    const configDir = getOpencodeConfigDir();
    await fs.mkdir(configDir, { recursive: true });
    await fs.writeFile(
      getOpencodeConfigPath(),
      JSON.stringify({ theme: "dark", model: "anthropic/claude-sonnet-4-5" }, null, 2),
    );

    const result = await configureOpencodeHook(userDataPath);
    expect(result.ok).toBe(true);

    const content = JSON.parse(await fs.readFile(getOpencodeConfigPath(), "utf8"));
    expect(content.theme).toBe("dark");
    expect(content.model).toBe("anthropic/claude-sonnet-4-5");
    expect(content.hooks).toBeDefined();
  });

  test("writes notify.mjs to userDataPath/hooks", async () => {
    const result = await configureOpencodeHook(userDataPath);
    expect(result.ok).toBe(true);

    const scriptPath = path.join(userDataPath, "hooks", "notify.mjs");
    expect(existsSync(scriptPath)).toBe(true);
  });
});

describe("removeOpencodeHook", () => {
  test("returns ok:true removed:false when config does not exist", async () => {
    const result = await removeOpencodeHook();
    expect(result.ok).toBe(true);
    expect((result as { removed: boolean }).removed).toBe(false);
  });

  test("removes strIDEterm hook entries", async () => {
    await configureOpencodeHook(userDataPath);

    const result = await removeOpencodeHook();
    expect(result.ok).toBe(true);
    expect((result as { removed: boolean }).removed).toBe(true);

    const content = JSON.parse(await fs.readFile(getOpencodeConfigPath(), "utf8"));
    expect(content.hooks).toBeUndefined();
  });

  test("preserves user hooks added alongside strIDEterm hooks", async () => {
    await configureOpencodeHook(userDataPath);

    const configPath = getOpencodeConfigPath();
    const content = JSON.parse(await fs.readFile(configPath, "utf8"));
    content.hooks.Stop.push({ matcher: "", hooks: [{ type: "command", command: "my-script.sh Stop" }] });
    await fs.writeFile(configPath, JSON.stringify(content, null, 2));

    await removeOpencodeHook();

    const after = JSON.parse(await fs.readFile(configPath, "utf8"));
    expect(after.hooks.Stop).toHaveLength(1);
    expect(after.hooks.Stop[0].hooks[0].command).toBe("my-script.sh Stop");
  });
});

describe("detectOpencodeHookStatus", () => {
  test("returns not-configured when config does not exist", async () => {
    const result = await detectOpencodeHookStatus(userDataPath);
    expect(result.status).toBe("not-configured");
  });

  test("returns configured after successful configuration", async () => {
    await configureOpencodeHook(userDataPath);
    const result = await detectOpencodeHookStatus(userDataPath);
    expect(result.status).toBe("configured");
  });

  test("returns script-missing when notify.mjs is removed after configure", async () => {
    await configureOpencodeHook(userDataPath);
    const scriptPath = path.join(userDataPath, "hooks", "notify.mjs");
    await fs.rm(scriptPath, { force: true });

    const result = await detectOpencodeHookStatus(userDataPath);
    expect(result.status).toBe("script-missing");
  });

  test("returns partial when only some hooks are registered", async () => {
    const configDir = getOpencodeConfigDir();
    await fs.mkdir(configDir, { recursive: true });
    const notifyScript = path.join(userDataPath, "hooks", "notify.mjs");
    await fs.mkdir(path.dirname(notifyScript), { recursive: true });
    await fs.writeFile(notifyScript, "// notify");

    const partial = {
      hooks: {
        Stop: [{ matcher: "", hooks: [{ type: "command", command: `node "${notifyScript}" Stop`, timeout: 5 }] }],
      },
    };
    await fs.writeFile(getOpencodeConfigPath(), JSON.stringify(partial, null, 2));

    const result = await detectOpencodeHookStatus(userDataPath);
    expect(result.status).toBe("partial");
    expect((result as { registered: string[] }).registered).toContain("Stop");
    expect((result as { missingHooks: string[] }).missingHooks).toContain("UserPromptSubmit");
  });
});

describe("findExistingHook", () => {
  test("returns -1 when no hooks section", () => {
    expect(findExistingHook({}, "Stop")).toBe(-1);
  });

  test("returns -1 when hook not present", () => {
    const settings = { hooks: { Stop: [] } };
    expect(findExistingHook(settings, "Stop")).toBe(-1);
  });

  test("finds existing strIDEterm hook by marker", () => {
    const settings = {
      hooks: {
        Stop: [
          { matcher: "", hooks: [{ type: "command", command: 'node "/data/hooks/notify.mjs" Stop', timeout: 5 }] },
        ],
      },
    };
    expect(findExistingHook(settings, "Stop")).toBe(0);
  });
});
