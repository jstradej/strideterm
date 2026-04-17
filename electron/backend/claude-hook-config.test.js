import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import { afterEach, describe, expect, test, beforeEach } from "vitest";
import {
  ensureNotifyScript,
  configureClaudeHook,
  removeClaudeHook,
  detectClaudeHookStatus,
  NOTIFY_SCRIPT_CONTENT,
  findExistingHook,
  HOOKS_TO_REGISTER,
} from "./claude-hook-config.js";

let tempDir;
let mockHomedir;
let originalHomedir;

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "strideterm-hook-test-"));
  mockHomedir = path.join(tempDir, "home");
  await fs.mkdir(mockHomedir, { recursive: true });

  // Mock os.homedir() to use temp directory
  originalHomedir = os.homedir;
  os.homedir = () => mockHomedir;
});

afterEach(async () => {
  os.homedir = originalHomedir;
  await fs.rm(tempDir, { recursive: true, force: true });
});

// --- ensureNotifyScript ---

describe("ensureNotifyScript", () => {
  test("creates hooks directory and notify.mjs script", async () => {
    const userDataPath = path.join(tempDir, "strideterm-data");
    await fs.mkdir(userDataPath, { recursive: true });

    const result = await ensureNotifyScript(userDataPath);

    expect(result.ok).toBe(true);
    expect(result.path).toBe(path.join(userDataPath, "hooks", "notify.mjs"));

    const content = await fs.readFile(result.path, "utf8");
    expect(content).toBe(NOTIFY_SCRIPT_CONTENT);
  });

  test("overwrites existing script with latest version", async () => {
    const userDataPath = path.join(tempDir, "strideterm-data");
    const hooksDir = path.join(userDataPath, "hooks");
    await fs.mkdir(hooksDir, { recursive: true });
    await fs.writeFile(path.join(hooksDir, "notify.mjs"), "old content");

    const result = await ensureNotifyScript(userDataPath);

    expect(result.ok).toBe(true);
    const content = await fs.readFile(result.path, "utf8");
    expect(content).toBe(NOTIFY_SCRIPT_CONTENT);
  });

  test("returns error when directory is not writable", async () => {
    // Use a path that can't be created
    const result = await ensureNotifyScript(path.join(tempDir, "\0invalid"));

    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
  });
});

// --- findExistingHook ---

describe("findExistingHook", () => {
  test("returns -1 when no hooks configured", () => {
    expect(findExistingHook({})).toBe(-1);
    expect(findExistingHook({ hooks: {} })).toBe(-1);
    expect(findExistingHook({ hooks: { Notification: [] } })).toBe(-1);
  });

  test("finds strIDEterm hook by notify script path in command", () => {
    const settings = {
      hooks: {
        Notification: [
          {
            matcher: "",
            hooks: [{ type: "command", command: `node "/home/user/.strideterm/hooks/notify.mjs"` }],
          },
        ],
      },
    };
    expect(findExistingHook(settings)).toBe(0);
  });

  test("finds hook when command contains STRIDETERM_NOTIFY_URL (legacy)", () => {
    const settings = {
      hooks: {
        Notification: [
          {
            matcher: "",
            hooks: [
              {
                type: "command",
                command: `curl -sf -X POST "$STRIDETERM_NOTIFY_URL" -d "$(cat)" || true`,
              },
            ],
          },
        ],
      },
    };
    expect(findExistingHook(settings)).toBe(0);
  });

  test("does not match unrelated hooks", () => {
    const settings = {
      hooks: {
        Notification: [
          {
            matcher: "",
            hooks: [{ type: "command", command: 'echo "hello"' }],
          },
        ],
      },
    };
    expect(findExistingHook(settings)).toBe(-1);
  });
});

// --- configureClaudeHook ---

describe("configureClaudeHook", () => {
  test("creates ~/.claude/settings.json from scratch", async () => {
    const userDataPath = path.join(tempDir, "strideterm-data");
    await fs.mkdir(userDataPath, { recursive: true });

    const result = await configureClaudeHook(userDataPath);

    expect(result.ok).toBe(true);
    expect(result.scriptPath).toContain("notify.mjs");
    expect(result.settingsPath).toContain("settings.json");

    // Verify the settings file was created
    const settings = JSON.parse(await fs.readFile(result.settingsPath, "utf8"));
    expect(settings.hooks).toBeDefined();
    expect(settings.hooks.Notification).toHaveLength(1);
    expect(settings.hooks.Notification[0].hooks[0].type).toBe("command");
    expect(settings.hooks.Notification[0].hooks[0].command).toContain("node");
    expect(settings.hooks.Notification[0].hooks[0].command).toContain("notify.mjs");
  });

  test("creates .claude directory if it doesn't exist", async () => {
    const userDataPath = path.join(tempDir, "strideterm-data");
    await fs.mkdir(userDataPath, { recursive: true });

    const claudeDir = path.join(mockHomedir, ".claude");
    expect(existsSync(claudeDir)).toBe(false);

    const result = await configureClaudeHook(userDataPath);

    expect(result.ok).toBe(true);
    expect(existsSync(claudeDir)).toBe(true);
  });

  test("preserves existing settings and other hooks", async () => {
    const userDataPath = path.join(tempDir, "strideterm-data");
    await fs.mkdir(userDataPath, { recursive: true });

    // Create existing Claude settings with other config
    const claudeDir = path.join(mockHomedir, ".claude");
    await fs.mkdir(claudeDir, { recursive: true });
    await fs.writeFile(
      path.join(claudeDir, "settings.json"),
      JSON.stringify(
        {
          model: "claude-sonnet-4-6",
          hooks: {
            PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo pre" }] }],
            Notification: [{ matcher: "permission_prompt", hooks: [{ type: "command", command: "echo notify" }] }],
          },
          customSetting: true,
        },
        null,
        2,
      ),
    );

    const result = await configureClaudeHook(userDataPath);
    expect(result.ok).toBe(true);

    const settings = JSON.parse(await fs.readFile(path.join(claudeDir, "settings.json"), "utf8"));

    // Existing settings preserved
    expect(settings.model).toBe("claude-sonnet-4-6");
    expect(settings.customSetting).toBe(true);

    // Existing hooks preserved
    expect(settings.hooks.PreToolUse).toHaveLength(1);
    expect(settings.hooks.Notification).toHaveLength(2); // existing + new

    // Existing notification hook still there
    expect(settings.hooks.Notification[0].hooks[0].command).toBe("echo notify");

    // New strIDEterm hook added
    expect(settings.hooks.Notification[1].hooks[0].command).toContain("notify.mjs");
  });

  test("updates existing strIDEterm hook instead of duplicating", async () => {
    const userDataPath = path.join(tempDir, "strideterm-data");
    await fs.mkdir(userDataPath, { recursive: true });

    // First configure
    const result1 = await configureClaudeHook(userDataPath);
    expect(result1.ok).toBe(true);

    // Second configure — should update, not duplicate
    const result2 = await configureClaudeHook(userDataPath);
    expect(result2.ok).toBe(true);

    const settings = JSON.parse(await fs.readFile(result2.settingsPath, "utf8"));
    expect(settings.hooks.Notification).toHaveLength(1); // Not 2
  });

  test("returns error for malformed existing JSON", async () => {
    const userDataPath = path.join(tempDir, "strideterm-data");
    await fs.mkdir(userDataPath, { recursive: true });

    const claudeDir = path.join(mockHomedir, ".claude");
    await fs.mkdir(claudeDir, { recursive: true });
    await fs.writeFile(path.join(claudeDir, "settings.json"), "{ invalid json }}");

    const result = await configureClaudeHook(userDataPath);

    expect(result.ok).toBe(false);
    expect(result.error).toContain("valid JSON");
    expect(result.detail).toBe("settings-read-failed");
  });

  test("notify script uses forward slashes in hook command on all platforms", async () => {
    const userDataPath = path.join(tempDir, "strideterm-data");
    await fs.mkdir(userDataPath, { recursive: true });

    const result = await configureClaudeHook(userDataPath);
    expect(result.ok).toBe(true);

    const settings = JSON.parse(await fs.readFile(result.settingsPath, "utf8"));
    const command = settings.hooks.Notification[0].hooks[0].command;

    // Should not contain backslashes (Windows path separators)
    expect(command).not.toContain("\\");
    expect(command).toContain("/");
  });

  test("registers all four hook types (Notification, Stop, SubagentStop, UserPromptSubmit)", async () => {
    const userDataPath = path.join(tempDir, "strideterm-data");
    await fs.mkdir(userDataPath, { recursive: true });

    const result = await configureClaudeHook(userDataPath);
    expect(result.ok).toBe(true);
    expect(result.registered).toEqual(HOOKS_TO_REGISTER);

    const settings = JSON.parse(await fs.readFile(result.settingsPath, "utf8"));
    for (const hookName of HOOKS_TO_REGISTER) {
      expect(settings.hooks[hookName]).toHaveLength(1);
      expect(settings.hooks[hookName][0].hooks[0].command).toContain("notify.mjs");
      // Hook name is passed as argv so the same script handles all types
      expect(settings.hooks[hookName][0].hooks[0].command).toContain(hookName);
    }
  });

  test("hook command includes hook name as argv[2]", async () => {
    const userDataPath = path.join(tempDir, "strideterm-data");
    await fs.mkdir(userDataPath, { recursive: true });

    await configureClaudeHook(userDataPath);

    const settingsPath = path.join(mockHomedir, ".claude", "settings.json");
    const settings = JSON.parse(await fs.readFile(settingsPath, "utf8"));

    expect(settings.hooks.Notification[0].hooks[0].command).toMatch(/notify\.mjs"\s+Notification$/);
    expect(settings.hooks.Stop[0].hooks[0].command).toMatch(/notify\.mjs"\s+Stop$/);
    expect(settings.hooks.SubagentStop[0].hooks[0].command).toMatch(/notify\.mjs"\s+SubagentStop$/);
    expect(settings.hooks.UserPromptSubmit[0].hooks[0].command).toMatch(/notify\.mjs"\s+UserPromptSubmit$/);
  });

  test("re-configure does not duplicate entries in any hook category", async () => {
    const userDataPath = path.join(tempDir, "strideterm-data");
    await fs.mkdir(userDataPath, { recursive: true });

    await configureClaudeHook(userDataPath);
    await configureClaudeHook(userDataPath);

    const settingsPath = path.join(mockHomedir, ".claude", "settings.json");
    const settings = JSON.parse(await fs.readFile(settingsPath, "utf8"));

    for (const hookName of HOOKS_TO_REGISTER) {
      expect(settings.hooks[hookName]).toHaveLength(1);
    }
  });

  test("preserves unrelated hooks in Stop / UserPromptSubmit categories", async () => {
    const userDataPath = path.join(tempDir, "strideterm-data");
    await fs.mkdir(userDataPath, { recursive: true });

    const claudeDir = path.join(mockHomedir, ".claude");
    await fs.mkdir(claudeDir, { recursive: true });
    await fs.writeFile(
      path.join(claudeDir, "settings.json"),
      JSON.stringify({
        hooks: {
          Stop: [{ matcher: "", hooks: [{ type: "command", command: "echo user-stop" }] }],
          UserPromptSubmit: [{ matcher: "", hooks: [{ type: "command", command: "echo user-prompt" }] }],
        },
      }),
    );

    const result = await configureClaudeHook(userDataPath);
    expect(result.ok).toBe(true);

    const settings = JSON.parse(await fs.readFile(result.settingsPath, "utf8"));
    expect(settings.hooks.Stop).toHaveLength(2);
    expect(settings.hooks.Stop[0].hooks[0].command).toBe("echo user-stop");
    expect(settings.hooks.Stop[1].hooks[0].command).toContain("notify.mjs");

    expect(settings.hooks.UserPromptSubmit).toHaveLength(2);
    expect(settings.hooks.UserPromptSubmit[0].hooks[0].command).toBe("echo user-prompt");
  });
});

// --- removeClaudeHook ---

describe("removeClaudeHook", () => {
  test("removes strIDEterm hook and preserves other hooks", async () => {
    const userDataPath = path.join(tempDir, "strideterm-data");
    await fs.mkdir(userDataPath, { recursive: true });

    // Configure first
    await configureClaudeHook(userDataPath);

    // Add another hook manually
    const settingsPath = path.join(mockHomedir, ".claude", "settings.json");
    const settings = JSON.parse(await fs.readFile(settingsPath, "utf8"));
    settings.hooks.Notification.push({
      matcher: "",
      hooks: [{ type: "command", command: "echo other-hook" }],
    });
    await fs.writeFile(settingsPath, JSON.stringify(settings, null, 2));

    const result = await removeClaudeHook();

    expect(result.ok).toBe(true);
    expect(result.removed).toBe(true);

    const updated = JSON.parse(await fs.readFile(settingsPath, "utf8"));
    expect(updated.hooks.Notification).toHaveLength(1);
    expect(updated.hooks.Notification[0].hooks[0].command).toBe("echo other-hook");
  });

  test("cleans up empty hooks object", async () => {
    const userDataPath = path.join(tempDir, "strideterm-data");
    await fs.mkdir(userDataPath, { recursive: true });

    await configureClaudeHook(userDataPath);

    const result = await removeClaudeHook();
    expect(result.ok).toBe(true);

    const settingsPath = path.join(mockHomedir, ".claude", "settings.json");
    const settings = JSON.parse(await fs.readFile(settingsPath, "utf8"));

    // hooks object should be completely removed (was empty)
    expect(settings.hooks).toBeUndefined();
  });

  test("returns removed=false when no hook to remove", async () => {
    const result = await removeClaudeHook();

    expect(result.ok).toBe(true);
    expect(result.removed).toBe(false);
  });

  test("returns removed=false when settings file has no strIDEterm hook", async () => {
    const claudeDir = path.join(mockHomedir, ".claude");
    await fs.mkdir(claudeDir, { recursive: true });
    await fs.writeFile(
      path.join(claudeDir, "settings.json"),
      JSON.stringify({ hooks: { Notification: [{ hooks: [{ command: "other" }] }] } }),
    );

    const result = await removeClaudeHook();

    expect(result.ok).toBe(true);
    expect(result.removed).toBe(false);
  });

  test("removes strIDEterm entries from all four hook categories", async () => {
    const userDataPath = path.join(tempDir, "strideterm-data");
    await fs.mkdir(userDataPath, { recursive: true });

    await configureClaudeHook(userDataPath);

    const result = await removeClaudeHook();
    expect(result.ok).toBe(true);
    expect(result.removed).toBe(true);
    expect(result.removedFrom).toEqual(expect.arrayContaining(HOOKS_TO_REGISTER));

    const settings = JSON.parse(await fs.readFile(path.join(mockHomedir, ".claude", "settings.json"), "utf8"));
    // All four categories should be cleaned up
    expect(settings.hooks).toBeUndefined();
  });

  test("removes strIDEterm from Stop but keeps unrelated Stop hooks", async () => {
    const userDataPath = path.join(tempDir, "strideterm-data");
    await fs.mkdir(userDataPath, { recursive: true });

    await configureClaudeHook(userDataPath);

    // Add a user's own Stop hook alongside strIDEterm's
    const settingsPath = path.join(mockHomedir, ".claude", "settings.json");
    const settings = JSON.parse(await fs.readFile(settingsPath, "utf8"));
    settings.hooks.Stop.push({ matcher: "", hooks: [{ type: "command", command: "echo user-stop" }] });
    await fs.writeFile(settingsPath, JSON.stringify(settings, null, 2));

    const result = await removeClaudeHook();
    expect(result.ok).toBe(true);
    expect(result.removed).toBe(true);

    const updated = JSON.parse(await fs.readFile(settingsPath, "utf8"));
    expect(updated.hooks.Stop).toHaveLength(1);
    expect(updated.hooks.Stop[0].hooks[0].command).toBe("echo user-stop");
    // Other categories fully cleaned up
    expect(updated.hooks.Notification).toBeUndefined();
    expect(updated.hooks.SubagentStop).toBeUndefined();
    expect(updated.hooks.UserPromptSubmit).toBeUndefined();
  });
});

// --- detectClaudeHookStatus ---

describe("detectClaudeHookStatus", () => {
  test('returns "configured" when hook and script both exist', async () => {
    const userDataPath = path.join(tempDir, "strideterm-data");
    await fs.mkdir(userDataPath, { recursive: true });

    await configureClaudeHook(userDataPath);

    const result = await detectClaudeHookStatus(userDataPath);
    expect(result.status).toBe("configured");
  });

  test('returns "not-configured" when no settings file', async () => {
    const userDataPath = path.join(tempDir, "strideterm-data");
    await fs.mkdir(userDataPath, { recursive: true });

    const result = await detectClaudeHookStatus(userDataPath);
    expect(result.status).toBe("not-configured");
  });

  test('returns "not-configured" when settings exist but no hook', async () => {
    const userDataPath = path.join(tempDir, "strideterm-data");
    await fs.mkdir(userDataPath, { recursive: true });

    const claudeDir = path.join(mockHomedir, ".claude");
    await fs.mkdir(claudeDir, { recursive: true });
    await fs.writeFile(path.join(claudeDir, "settings.json"), JSON.stringify({ model: "claude-sonnet-4-6" }));

    const result = await detectClaudeHookStatus(userDataPath);
    expect(result.status).toBe("not-configured");
  });

  test('returns "script-missing" when hook is configured but script file is gone', async () => {
    const userDataPath = path.join(tempDir, "strideterm-data");
    await fs.mkdir(userDataPath, { recursive: true });

    // Configure (creates both hook and script)
    await configureClaudeHook(userDataPath);

    // Delete the script
    await fs.rm(path.join(userDataPath, "hooks", "notify.mjs"));

    const result = await detectClaudeHookStatus(userDataPath);
    expect(result.status).toBe("script-missing");
  });

  test('returns "error" for malformed settings JSON', async () => {
    const userDataPath = path.join(tempDir, "strideterm-data");
    await fs.mkdir(userDataPath, { recursive: true });

    const claudeDir = path.join(mockHomedir, ".claude");
    await fs.mkdir(claudeDir, { recursive: true });
    await fs.writeFile(path.join(claudeDir, "settings.json"), "not json");

    const result = await detectClaudeHookStatus(userDataPath);
    expect(result.status).toBe("error");
    expect(result.error).toBeTruthy();
  });

  test('returns "partial" when only some hooks are registered (legacy upgrade)', async () => {
    const userDataPath = path.join(tempDir, "strideterm-data");
    await fs.mkdir(userDataPath, { recursive: true });

    // Ensure script exists
    await ensureNotifyScript(userDataPath);

    // Write legacy-style config with only Notification hook registered
    const scriptPath = path.join(userDataPath, "hooks", "notify.mjs").replace(/\\/g, "/");
    const claudeDir = path.join(mockHomedir, ".claude");
    await fs.mkdir(claudeDir, { recursive: true });
    await fs.writeFile(
      path.join(claudeDir, "settings.json"),
      JSON.stringify({
        hooks: {
          Notification: [{ matcher: "", hooks: [{ type: "command", command: `node "${scriptPath}"`, timeout: 5 }] }],
        },
      }),
    );

    const result = await detectClaudeHookStatus(userDataPath);
    expect(result.status).toBe("partial");
    expect(result.registered).toContain("Notification");
    expect(result.missingHooks).toEqual(expect.arrayContaining(["Stop", "SubagentStop", "UserPromptSubmit"]));
  });

  test('returns "configured" when all four hooks are registered', async () => {
    const userDataPath = path.join(tempDir, "strideterm-data");
    await fs.mkdir(userDataPath, { recursive: true });

    await configureClaudeHook(userDataPath);

    const result = await detectClaudeHookStatus(userDataPath);
    expect(result.status).toBe("configured");
    expect(result.registered).toEqual(HOOKS_TO_REGISTER);
  });
});
