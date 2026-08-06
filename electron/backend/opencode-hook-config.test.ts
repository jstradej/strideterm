import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  configureOpencodeHook,
  removeOpencodeHook,
  detectOpencodeHookStatus,
  cleanupLegacyOpencodeHooks,
  migrateLegacyOpencodeHooks,
  getOpencodeConfigPath,
  getOpencodeConfigDir,
  getOpencodePluginPath,
  PLUGIN_FILENAME,
  REGISTERED_EVENTS,
} from "./opencode-hook-config.js";

let tempDir: string;
let mockHomedir: string;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let originalHomedir: any;
let originalEnv: Record<string, string | undefined>;

/** The Claude-style block strIDEterm <= 2.4.20 wrote — the config OpenCode rejects. */
function legacyConfig(extra: Record<string, unknown> = {}) {
  return {
    ...extra,
    hooks: {
      Stop: [
        {
          matcher: "",
          hooks: [{ type: "command", command: 'node "/data/hooks/notify.mjs" Stop', timeout: 5 }],
        },
      ],
      UserPromptSubmit: [
        {
          matcher: "",
          hooks: [{ type: "command", command: 'node "/data/hooks/notify.mjs" UserPromptSubmit', timeout: 5 }],
        },
      ],
    },
  };
}

async function writeConfig(data: unknown) {
  await fs.mkdir(getOpencodeConfigDir(), { recursive: true });
  await fs.writeFile(getOpencodeConfigPath(), JSON.stringify(data, null, 2));
}

async function readConfig() {
  return JSON.parse(await fs.readFile(getOpencodeConfigPath(), "utf8"));
}

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "strideterm-opencode-hook-"));
  mockHomedir = path.join(tempDir, "home");
  await fs.mkdir(mockHomedir, { recursive: true });

  originalHomedir = os.homedir;
  os.homedir = () => mockHomedir;
  originalEnv = {
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
    APPDATA: process.env.APPDATA,
    OPENCODE_HOME: process.env.OPENCODE_HOME,
  };
  // OpenCode resolves its config dir XDG-style on every platform, Windows
  // included, so one override covers the live path everywhere.
  process.env.XDG_CONFIG_HOME = path.join(mockHomedir, ".config");
  // The legacy-path sweep also consults APPDATA (on Windows) and OPENCODE_HOME.
  // Both must point somewhere disposable, or cleanup would reach into the
  // developer's own OpenCode config while the suite runs.
  process.env.APPDATA = path.join(mockHomedir, "AppData", "Roaming");
  delete process.env.OPENCODE_HOME;
});

afterEach(async () => {
  os.homedir = originalHomedir;
  for (const [k, v] of Object.entries(originalEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  await fs.rm(tempDir, { recursive: true, force: true });
});

describe("paths", () => {
  test("honors XDG_CONFIG_HOME", () => {
    const customDir = path.join(tempDir, "custom-xdg");
    process.env.XDG_CONFIG_HOME = customDir;
    expect(getOpencodeConfigDir()).toBe(path.join(customDir, "opencode"));
  });

  // Regression: earlier versions pointed Windows at %APPDATA%\opencode, which
  // opencode never reads — `opencode debug paths` reports ~/.config/opencode on
  // Windows too. OPENCODE_HOME is likewise ignored by opencode itself.
  test("falls back to ~/.config/opencode on every platform", () => {
    delete process.env.XDG_CONFIG_HOME;
    expect(getOpencodeConfigDir()).toBe(path.join(mockHomedir, ".config", "opencode"));
  });

  test("ignores OPENCODE_HOME, matching opencode's own resolution", () => {
    process.env.OPENCODE_HOME = path.join(tempDir, "ignored");
    try {
      expect(getOpencodeConfigDir()).toBe(path.join(mockHomedir, ".config", "opencode"));
    } finally {
      delete process.env.OPENCODE_HOME;
    }
  });

  test("plugin lives in the plugins subdirectory of the config dir", () => {
    expect(getOpencodePluginPath()).toBe(path.join(getOpencodeConfigDir(), "plugins", PLUGIN_FILENAME));
  });
});

describe("configureOpencodeHook", () => {
  test("writes the plugin file and reports the events it registers", async () => {
    const result = await configureOpencodeHook();
    expect(result.ok).toBe(true);
    expect(result.registered).toEqual(expect.arrayContaining(["session.idle", "chat.message"]));
    expect(existsSync(getOpencodePluginPath())).toBe(true);
  });

  test("plugin subscribes to session.idle and chat.message and gates on the notify URL", async () => {
    await configureOpencodeHook();
    const plugin = await fs.readFile(getOpencodePluginPath(), "utf8");

    expect(plugin).toContain('event?.type === "session.idle"');
    expect(plugin).toContain('"chat.message"');
    expect(plugin).toContain("process.env.STRIDETERM_NOTIFY_URL");
    // No URL means opencode was started outside strIDEterm — stay silent.
    expect(plugin).toContain("if (!NOTIFY_URL) return {}");
  });

  test("never writes a hooks key into the OpenCode config (#178)", async () => {
    await writeConfig({ model: "anthropic/claude-sonnet-4-5" });
    await configureOpencodeHook();

    const config = await readConfig();
    expect(config.hooks).toBeUndefined();
    expect(config.model).toBe("anthropic/claude-sonnet-4-5");
  });

  test("does not create an OpenCode config file when none exists", async () => {
    await configureOpencodeHook();
    expect(existsSync(getOpencodeConfigPath())).toBe(false);
  });

  test("is idempotent — re-running rewrites the same plugin", async () => {
    await configureOpencodeHook();
    const first = await fs.readFile(getOpencodePluginPath(), "utf8");
    await configureOpencodeHook();
    const second = await fs.readFile(getOpencodePluginPath(), "utf8");
    expect(second).toBe(first);
  });

  test("strips a legacy hooks block left by an older version", async () => {
    await writeConfig(legacyConfig({ theme: "dark" }));

    const result = await configureOpencodeHook();
    expect(result.ok).toBe(true);

    const config = await readConfig();
    expect(config.hooks).toBeUndefined();
    expect(config.theme).toBe("dark");
  });
});

describe("cleanupLegacyOpencodeHooks", () => {
  test("no-ops when the config file does not exist", async () => {
    const result = await cleanupLegacyOpencodeHooks();
    expect(result.ok).toBe(true);
    expect(result.removed).toBe(false);
  });

  test("removes the whole hooks key when only strIDEterm entries were there", async () => {
    await writeConfig(legacyConfig());

    const result = await cleanupLegacyOpencodeHooks();
    expect(result.removed).toBe(true);
    expect((await readConfig()).hooks).toBeUndefined();
  });

  // opencode 1.18.14 writes `{ "$schema": "...", }` itself, so a real broken
  // config is very likely to be JSONC rather than strict JSON. Bailing out on
  // the parse error would strand exactly the users this is meant to heal.
  test("parses a config with a trailing comma and comments", async () => {
    await fs.mkdir(getOpencodeConfigDir(), { recursive: true });
    await fs.writeFile(
      getOpencodeConfigPath(),
      `{
  // written by opencode
  "$schema": "https://opencode.ai/config.json",
  "hooks": {
    "Stop": [
      { "matcher": "", "hooks": [{ "type": "command", "command": "node \\"/d/hooks/notify.mjs\\" Stop" }] }
    ],
  },
}
`,
    );

    const result = await cleanupLegacyOpencodeHooks();
    expect(result.ok).toBe(true);
    expect(result.removed).toBe(true);

    const after = await readConfig();
    expect(after.hooks).toBeUndefined();
    expect(after.$schema).toBe("https://opencode.ai/config.json");
  });

  // strIDEterm <= 2.4.20 pointed Windows at %APPDATA%\opencode\config.json.
  // opencode never read that file so it broke nothing, but it is litter we
  // created and cleanup should take it with us.
  test.runIf(process.platform === "win32")("also clears the legacy %APPDATA% config on Windows", async () => {
    const legacyPath = path.join(mockHomedir, "AppData", "Roaming", "opencode", "config.json");
    await fs.mkdir(path.dirname(legacyPath), { recursive: true });
    await fs.writeFile(legacyPath, JSON.stringify(legacyConfig({ theme: "dark" }), null, 2));

    const result = await cleanupLegacyOpencodeHooks();
    expect(result.removed).toBe(true);
    expect(result.cleaned).toContain(legacyPath);

    const after = JSON.parse(await fs.readFile(legacyPath, "utf8"));
    expect(after.hooks).toBeUndefined();
    expect(after.theme).toBe("dark");
  });

  // The mirror of the test above: %APPDATA% is a Windows-only legacy location,
  // so on Linux/macOS an identically-named file must be left strictly alone.
  test.runIf(process.platform !== "win32")("ignores the Windows legacy location off Windows", async () => {
    const legacyPath = path.join(mockHomedir, "AppData", "Roaming", "opencode", "config.json");
    const original = JSON.stringify(legacyConfig({ theme: "dark" }), null, 2);
    await fs.mkdir(path.dirname(legacyPath), { recursive: true });
    await fs.writeFile(legacyPath, original);

    const result = await cleanupLegacyOpencodeHooks();
    expect(result.removed).toBe(false);
    expect(await fs.readFile(legacyPath, "utf8")).toBe(original);
  });

  test("sweeps OPENCODE_HOME too — versions that honored it wrote a config there", async () => {
    const legacyHome = path.join(tempDir, "opencode-home");
    const legacyPath = path.join(legacyHome, "config.json");
    process.env.OPENCODE_HOME = legacyHome;
    await fs.mkdir(legacyHome, { recursive: true });
    await fs.writeFile(legacyPath, JSON.stringify(legacyConfig(), null, 2));

    const result = await cleanupLegacyOpencodeHooks();
    expect(result.cleaned).toContain(legacyPath);
    expect(JSON.parse(await fs.readFile(legacyPath, "utf8")).hooks).toBeUndefined();
  });

  test("leaves hook entries the user wrote themselves alone", async () => {
    const config = legacyConfig();
    config.hooks.Stop.push({ matcher: "", hooks: [{ type: "command", command: "my-script.sh Stop", timeout: 5 }] });
    await writeConfig(config);

    await cleanupLegacyOpencodeHooks();

    const after = await readConfig();
    expect(after.hooks.Stop).toHaveLength(1);
    expect(after.hooks.Stop[0].hooks[0].command).toBe("my-script.sh Stop");
    expect(after.hooks.UserPromptSubmit).toBeUndefined();
  });
});

describe("migrateLegacyOpencodeHooks", () => {
  test("leaves installs that never had the legacy block completely untouched", async () => {
    const result = await migrateLegacyOpencodeHooks();
    expect(result.cleaned).toEqual([]);
    expect(result.pluginInstalled).toBe(false);
    expect(existsSync(getOpencodePluginPath())).toBe(false);
  });

  test("does not install a plugin just because an unrelated config exists", async () => {
    await writeConfig({ model: "anthropic/claude-sonnet-4-5" });

    const result = await migrateLegacyOpencodeHooks();
    expect(result.pluginInstalled).toBe(false);
    expect(existsSync(getOpencodePluginPath())).toBe(false);
  });

  // Finding our own legacy entries proves the user once opted in, so the
  // opt-in is carried over instead of being silently dropped.
  test("carries a previous opt-in over to the plugin", async () => {
    await writeConfig(legacyConfig());

    const result = await migrateLegacyOpencodeHooks();
    expect(result.pluginInstalled).toBe(true);
    expect(result.cleaned).toContain(getOpencodeConfigPath());
    expect((await readConfig()).hooks).toBeUndefined();
    expect((await detectOpencodeHookStatus()).status).toBe("configured");
  });

  test("is idempotent — a second run finds nothing left to migrate", async () => {
    await writeConfig(legacyConfig());
    await migrateLegacyOpencodeHooks();

    const second = await migrateLegacyOpencodeHooks();
    expect(second.cleaned).toEqual([]);
    expect(second.pluginInstalled).toBe(false);
    // The plugin installed by the first run stays in place.
    expect((await detectOpencodeHookStatus()).status).toBe("configured");
  });
});

describe("removeOpencodeHook", () => {
  test("returns removed:false when nothing is installed", async () => {
    const result = await removeOpencodeHook();
    expect(result.ok).toBe(true);
    expect(result.removed).toBe(false);
  });

  test("deletes the plugin file", async () => {
    await configureOpencodeHook();

    const result = await removeOpencodeHook();
    expect(result.ok).toBe(true);
    expect(result.removed).toBe(true);
    expect(existsSync(getOpencodePluginPath())).toBe(false);
  });

  test("also clears a legacy hooks block even without a plugin file", async () => {
    await writeConfig(legacyConfig());

    const result = await removeOpencodeHook();
    expect(result.removed).toBe(true);
    expect((await readConfig()).hooks).toBeUndefined();
  });

  test("leaves other plugins in the directory untouched", async () => {
    await configureOpencodeHook();
    const otherPlugin = path.join(path.dirname(getOpencodePluginPath()), "user-plugin.js");
    await fs.writeFile(otherPlugin, "export const Mine = async () => ({})");

    await removeOpencodeHook();

    expect(existsSync(otherPlugin)).toBe(true);
  });
});

describe("detectOpencodeHookStatus", () => {
  test("returns not-configured when the plugin is missing", async () => {
    const result = await detectOpencodeHookStatus();
    expect(result.status).toBe("not-configured");
  });

  test("returns configured after a successful configure", async () => {
    await configureOpencodeHook();
    const result = await detectOpencodeHookStatus();
    expect(result.status).toBe("configured");
    expect(result.registered).toEqual([...REGISTERED_EVENTS]);
  });

  test("returns partial when the installed plugin is from an older version", async () => {
    await configureOpencodeHook();
    await fs.writeFile(getOpencodePluginPath(), "// stale plugin from an older strIDEterm\n");

    const result = await detectOpencodeHookStatus();
    expect(result.status).toBe("partial");
  });

  test("returns not-configured again after remove", async () => {
    await configureOpencodeHook();
    await removeOpencodeHook();
    expect((await detectOpencodeHookStatus()).status).toBe("not-configured");
  });
});
