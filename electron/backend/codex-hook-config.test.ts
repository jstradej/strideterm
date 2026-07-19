import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  configureCodexHook,
  removeCodexHook,
  detectCodexHookStatus,
  ensureCodexHooksFeatureFlag,
  isCodexHooksFeatureFlagEnabled,
  findExistingHook,
  getCodexConfigPath,
  getCodexHooksPath,
  HOOKS_TO_REGISTER,
} from "./codex-hook-config.js";

let tempDir: string;
let mockHomedir: string;
let userDataPath: string;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let originalHomedir: any;

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "strideterm-codex-hook-"));
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

describe("ensureCodexHooksFeatureFlag", () => {
  test("creates config.toml with [features] section when file missing", async () => {
    const result = await ensureCodexHooksFeatureFlag();
    expect(result.ok).toBe(true);
    expect(result.changed).toBe(true);

    const content = await fs.readFile(getCodexConfigPath(), "utf8");
    expect(content).toContain("[features]");
    expect(content).toContain("hooks = true");
    expect(content).not.toContain("codex_hooks");
  });

  test("is no-op when already enabled", async () => {
    await fs.mkdir(path.dirname(getCodexConfigPath()), { recursive: true });
    await fs.writeFile(getCodexConfigPath(), "[features]\nhooks = true\n");

    const result = await ensureCodexHooksFeatureFlag();
    expect(result.ok).toBe(true);
    expect(result.changed).toBe(false);
  });

  test("replaces hooks = false with true", async () => {
    await fs.mkdir(path.dirname(getCodexConfigPath()), { recursive: true });
    await fs.writeFile(getCodexConfigPath(), "[features]\nhooks = false\nother = 1\n");

    const result = await ensureCodexHooksFeatureFlag();
    expect(result.ok).toBe(true);
    expect(result.changed).toBe(true);

    const content = await fs.readFile(getCodexConfigPath(), "utf8");
    expect(content).toContain("hooks = true");
    expect(content).not.toContain("hooks = false");
    expect(content).toContain("other = 1");
  });

  test("appends hooks to existing [features] section", async () => {
    await fs.mkdir(path.dirname(getCodexConfigPath()), { recursive: true });
    await fs.writeFile(getCodexConfigPath(), "[features]\nsomething = true\n\n[other]\nkey = 1\n");

    await ensureCodexHooksFeatureFlag();

    const content = await fs.readFile(getCodexConfigPath(), "utf8");
    expect(content).toContain("hooks = true");
    expect(content).toContain("something = true");
    expect(content).toContain("[other]");
    expect(content).toContain("key = 1");
  });

  test("appends hooks under empty [features] section without trailing newline", async () => {
    await fs.mkdir(path.dirname(getCodexConfigPath()), { recursive: true });
    await fs.writeFile(getCodexConfigPath(), "[features]");

    await ensureCodexHooksFeatureFlag();

    const content = await fs.readFile(getCodexConfigPath(), "utf8");
    expect(content).toBe("[features]\nhooks = true\n");
  });

  test("appends new [features] section when none exists", async () => {
    await fs.mkdir(path.dirname(getCodexConfigPath()), { recursive: true });
    await fs.writeFile(getCodexConfigPath(), '[profile]\nmodel = "gpt-5"\n');

    await ensureCodexHooksFeatureFlag();

    const content = await fs.readFile(getCodexConfigPath(), "utf8");
    expect(content).toContain("[profile]");
    expect(content).toContain("[features]");
    expect(content).toContain("hooks = true");
    expect(content.indexOf("[features]")).toBeGreaterThan(content.indexOf("[profile]"));
  });

  test("normalizes CRLF to LF", async () => {
    await fs.mkdir(path.dirname(getCodexConfigPath()), { recursive: true });
    await fs.writeFile(getCodexConfigPath(), "[features]\r\nsomething = true\r\n");

    await ensureCodexHooksFeatureFlag();

    const content = await fs.readFile(getCodexConfigPath(), "utf8");
    expect(content).not.toContain("\r");
    expect(content).toContain("hooks = true");
    expect(content).toContain("something = true");
  });

  test("upgrades legacy codex_hooks flag to hooks without leaving deprecation warning behind", async () => {
    await fs.mkdir(path.dirname(getCodexConfigPath()), { recursive: true });
    await fs.writeFile(getCodexConfigPath(), "[features]\ncodex_hooks = true\nother = 1\n");

    const result = await ensureCodexHooksFeatureFlag();
    expect(result.ok).toBe(true);
    expect(result.changed).toBe(true);

    const content = await fs.readFile(getCodexConfigPath(), "utf8");
    expect(content).toContain("hooks = true");
    expect(content).not.toContain("codex_hooks");
    expect(content).toContain("other = 1");
  });
});

describe("isCodexHooksFeatureFlagEnabled", () => {
  test("returns false when file missing", async () => {
    expect(await isCodexHooksFeatureFlagEnabled()).toBe(false);
  });

  test("returns false when flag is not present", async () => {
    await fs.mkdir(path.dirname(getCodexConfigPath()), { recursive: true });
    await fs.writeFile(getCodexConfigPath(), "[features]\nother = true\n");
    expect(await isCodexHooksFeatureFlagEnabled()).toBe(false);
  });

  test("returns false when flag is false", async () => {
    await fs.mkdir(path.dirname(getCodexConfigPath()), { recursive: true });
    await fs.writeFile(getCodexConfigPath(), "[features]\nhooks = false\n");
    expect(await isCodexHooksFeatureFlagEnabled()).toBe(false);
  });

  test("returns true when flag is true", async () => {
    await fs.mkdir(path.dirname(getCodexConfigPath()), { recursive: true });
    await fs.writeFile(getCodexConfigPath(), "[features]\nhooks = true\n");
    expect(await isCodexHooksFeatureFlagEnabled()).toBe(true);
  });

  test("returns true for legacy codex_hooks flag", async () => {
    await fs.mkdir(path.dirname(getCodexConfigPath()), { recursive: true });
    await fs.writeFile(getCodexConfigPath(), "[features]\ncodex_hooks = true\n");
    expect(await isCodexHooksFeatureFlagEnabled()).toBe(true);
  });
});

describe("configureCodexHook", () => {
  test("creates config.toml, hooks.json, and notify.mjs when nothing exists", async () => {
    const result = await configureCodexHook(userDataPath);
    expect(result.ok).toBe(true);
    expect(result.registered).toEqual([...HOOKS_TO_REGISTER]);
    expect(existsSync(getCodexConfigPath())).toBe(true);
    expect(existsSync(getCodexHooksPath())).toBe(true);
    expect(existsSync(result.scriptPath!)).toBe(true);

    const hooks = JSON.parse(await fs.readFile(getCodexHooksPath(), "utf8"));
    for (const event of HOOKS_TO_REGISTER) {
      expect(hooks.hooks[event]).toHaveLength(1);
      const entry = hooks.hooks[event][0];
      expect(entry.matcher).toBe("");
      expect(entry.hooks[0].type).toBe("command");
      expect(entry.hooks[0].command).toContain("notify.mjs");
      expect(entry.hooks[0].command).toContain(event);
      expect(entry.hooks[0].timeout).toBe(5);
    }
  });

  test("preserves existing hooks.json entries from user", async () => {
    await fs.mkdir(path.dirname(getCodexHooksPath()), { recursive: true });
    const existing = {
      hooks: {
        Stop: [{ matcher: "", hooks: [{ type: "command", command: "echo user-hook" }] }],
        PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "policy.sh" }] }],
      },
    };
    await fs.writeFile(getCodexHooksPath(), JSON.stringify(existing, null, 2));

    await configureCodexHook(userDataPath);

    const hooks = JSON.parse(await fs.readFile(getCodexHooksPath(), "utf8"));
    expect(hooks.hooks.Stop).toHaveLength(2);
    expect(hooks.hooks.Stop[0].hooks[0].command).toBe("echo user-hook");
    expect(hooks.hooks.Stop[1].hooks[0].command).toContain("notify.mjs");
    expect(hooks.hooks.PreToolUse[0].hooks[0].command).toBe("policy.sh");
  });

  test("is idempotent", async () => {
    await configureCodexHook(userDataPath);
    await configureCodexHook(userDataPath);

    const hooks = JSON.parse(await fs.readFile(getCodexHooksPath(), "utf8"));
    for (const event of HOOKS_TO_REGISTER) {
      expect(hooks.hooks[event]).toHaveLength(1);
    }
  });

  test("enables hooks feature flag in config.toml", async () => {
    await configureCodexHook(userDataPath);
    expect(await isCodexHooksFeatureFlagEnabled()).toBe(true);
  });

  test("preserves existing config.toml sections", async () => {
    await fs.mkdir(path.dirname(getCodexConfigPath()), { recursive: true });
    await fs.writeFile(getCodexConfigPath(), '[profile]\nmodel = "gpt-5"\n\n[sandbox]\nmode = "read-only"\n');

    await configureCodexHook(userDataPath);

    const content = await fs.readFile(getCodexConfigPath(), "utf8");
    expect(content).toContain("[profile]");
    expect(content).toContain('model = "gpt-5"');
    expect(content).toContain("[sandbox]");
    expect(content).toContain('mode = "read-only"');
    expect(content).toContain("hooks = true");
  });

  test("command uses forward slashes", async () => {
    await configureCodexHook(userDataPath);
    const hooks = JSON.parse(await fs.readFile(getCodexHooksPath(), "utf8"));
    for (const event of HOOKS_TO_REGISTER) {
      expect(hooks.hooks[event][0].hooks[0].command).not.toContain("\\");
    }
  });
});

describe("findExistingHook", () => {
  test("returns -1 for missing entries", () => {
    expect(findExistingHook({}, "Stop")).toBe(-1);
    expect(findExistingHook({ hooks: {} }, "Stop")).toBe(-1);
    expect(findExistingHook({ hooks: { Stop: [] } }, "Stop")).toBe(-1);
  });

  test("returns index of strIDEterm entry", () => {
    const settings = {
      hooks: {
        Stop: [
          { matcher: "", hooks: [{ type: "command", command: "echo user" }] },
          { matcher: "", hooks: [{ type: "command", command: "node /path/hooks/notify.mjs Stop" }] },
        ],
      },
    };
    expect(findExistingHook(settings, "Stop")).toBe(1);
  });
});

describe("removeCodexHook", () => {
  test("removes strIDEterm entries while keeping user entries", async () => {
    await fs.mkdir(path.dirname(getCodexHooksPath()), { recursive: true });
    await fs.writeFile(
      getCodexHooksPath(),
      JSON.stringify({
        hooks: {
          Stop: [{ matcher: "", hooks: [{ type: "command", command: "echo user-hook" }] }],
        },
      }),
    );
    await configureCodexHook(userDataPath);

    const result = await removeCodexHook();
    expect(result.ok).toBe(true);
    expect(result.removed).toBe(true);

    const hooks = JSON.parse(await fs.readFile(getCodexHooksPath(), "utf8"));
    expect(hooks.hooks.Stop).toHaveLength(1);
    expect(hooks.hooks.Stop[0].hooks[0].command).toBe("echo user-hook");
  });

  test("leaves hooks feature flag alone — user may rely on it", async () => {
    await configureCodexHook(userDataPath);
    await removeCodexHook();

    // Feature flag should still be present even after hook removal
    expect(await isCodexHooksFeatureFlagEnabled()).toBe(true);
  });

  test("is a no-op when no strIDEterm entries exist", async () => {
    await fs.mkdir(path.dirname(getCodexHooksPath()), { recursive: true });
    await fs.writeFile(getCodexHooksPath(), JSON.stringify({ hooks: {} }));

    const result = await removeCodexHook();
    expect(result.ok).toBe(true);
    expect(result.removed).toBe(false);
  });

  test("returns ok with removed=false when hooks.json missing", async () => {
    const result = await removeCodexHook();
    expect(result.ok).toBe(true);
    expect(result.removed).toBe(false);
  });
});

describe("detectCodexHookStatus", () => {
  test("returns not-configured when hooks.json missing", async () => {
    expect((await detectCodexHookStatus(userDataPath)).status).toBe("not-configured");
  });

  test("returns configured after configureCodexHook", async () => {
    await configureCodexHook(userDataPath);
    const status = await detectCodexHookStatus(userDataPath);
    expect(status.status).toBe("configured");
    expect(status.registered).toEqual([...HOOKS_TO_REGISTER]);
  });

  test("returns flag-missing when feature flag is off", async () => {
    await configureCodexHook(userDataPath);
    // Strip feature flag without touching hooks.json
    await fs.writeFile(getCodexConfigPath(), "[features]\nother = true\n");

    const status = await detectCodexHookStatus(userDataPath);
    expect(status.status).toBe("flag-missing");
  });

  test("does not report flag-missing for the legacy codex_hooks flag", async () => {
    await configureCodexHook(userDataPath);
    // Replace the migrated flag with the pre-rename legacy key, as an
    // old install (never touched by ensureCodexHooksFeatureFlag) would have it.
    await fs.writeFile(getCodexConfigPath(), "[features]\ncodex_hooks = true\n");

    const status = await detectCodexHookStatus(userDataPath);
    expect(status.status).toBe("configured");
  });

  test("returns partial when only some events are registered", async () => {
    await configureCodexHook(userDataPath);
    const hooks = JSON.parse(await fs.readFile(getCodexHooksPath(), "utf8"));
    delete hooks.hooks.UserPromptSubmit;
    await fs.writeFile(getCodexHooksPath(), JSON.stringify(hooks, null, 2));

    const status = await detectCodexHookStatus(userDataPath);
    expect(status.status).toBe("partial");
    expect(status.missingHooks).toContain("UserPromptSubmit");
  });

  test("returns script-missing when notify.mjs is removed", async () => {
    await configureCodexHook(userDataPath);
    await fs.rm(path.join(userDataPath, "hooks", "notify.mjs"));

    const status = await detectCodexHookStatus(userDataPath);
    expect(status.status).toBe("script-missing");
  });
});
