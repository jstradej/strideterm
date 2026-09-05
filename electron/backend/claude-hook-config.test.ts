import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import http from "node:http";
import { execFile } from "node:child_process";
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
import { SHARD_LEASE_TTL_MS } from "./notify-url-registry.js";

let tempDir: string;
let mockHomedir: string;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let originalHomedir: any;

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
    const settings = JSON.parse(await fs.readFile(result.settingsPath!, "utf8"));
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

    // Existing hooks preserved; strIDEterm's own PreToolUse entry is appended.
    expect(settings.hooks.PreToolUse).toHaveLength(2); // existing Bash + strIDEterm's Agent/Task
    expect(settings.hooks.PreToolUse[0].hooks[0].command).toBe("echo pre");
    expect(settings.hooks.PreToolUse[1].hooks[0].command).toContain("notify.mjs");
    expect(settings.hooks.PreToolUse[1].matcher).toBe("Agent|Task");
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

    const settings = JSON.parse(await fs.readFile(result2.settingsPath!, "utf8"));
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

    const settings = JSON.parse(await fs.readFile(result.settingsPath!, "utf8"));
    const command = settings.hooks.Notification[0].hooks[0].command;

    // Should not contain backslashes (Windows path separators)
    expect(command).not.toContain("\\");
    expect(command).toContain("/");
  });

  test("registers all hook types (Notification, Stop, SubagentStop, UserPromptSubmit, PreToolUse)", async () => {
    const userDataPath = path.join(tempDir, "strideterm-data");
    await fs.mkdir(userDataPath, { recursive: true });

    const result = await configureClaudeHook(userDataPath);
    expect(result.ok).toBe(true);
    expect(result.registered).toEqual(HOOKS_TO_REGISTER);

    const settings = JSON.parse(await fs.readFile(result.settingsPath!, "utf8"));
    for (const hookName of HOOKS_TO_REGISTER) {
      expect(settings.hooks[hookName]).toHaveLength(1);
      expect(settings.hooks[hookName][0].hooks[0].command).toContain("notify.mjs");
      // Hook name is passed as argv so the same script handles all types
      expect(settings.hooks[hookName][0].hooks[0].command).toContain(hookName);
    }

    // PreToolUse is matcher-scoped to the subagent-launching tool so it does
    // not fire on every Read/Edit/Bash; all others fire unconditionally.
    expect(settings.hooks.PreToolUse[0].matcher).toBe("Agent|Task");
    expect(settings.hooks.Notification[0].matcher).toBe("");
    expect(settings.hooks.SubagentStop[0].matcher).toBe("");
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

    const settings = JSON.parse(await fs.readFile(result.settingsPath!, "utf8"));
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
    // An install predating PermissionRequest reports it as missing, which is
    // what surfaces "partial" in Settings and offers Configure — the existing
    // upgrade path, reused rather than special-cased.
    expect(result.missingHooks).toContain("PermissionRequest");
  });

  test('returns "configured" when all hooks are registered', async () => {
    const userDataPath = path.join(tempDir, "strideterm-data");
    await fs.mkdir(userDataPath, { recursive: true });

    await configureClaudeHook(userDataPath);

    const result = await detectClaudeHookStatus(userDataPath);
    expect(result.status).toBe("configured");
    expect(result.registered).toEqual(HOOKS_TO_REGISTER);
  });
});

// --- notify.mjs delivery (end-to-end: spawn the real script) ---

describe("notify.mjs retry", () => {
  test("retries once after a transient connection failure and delivers the event", async () => {
    const userDataPath = path.join(tempDir, "strideterm-data");
    await fs.mkdir(userDataPath, { recursive: true });
    const scriptResult = await ensureNotifyScript(userDataPath);
    expect(scriptResult.ok).toBe(true);

    // Server that kills the FIRST connection before responding (simulates
    // strideterm restarting / notify server rebinding) and accepts the rest.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const received: any[] = [];
    let firstKilled = false;
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        received.push(JSON.parse(body));
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end("{}");
      });
    });
    server.on("connection", (socket) => {
      if (!firstKilled) {
        firstKilled = true;
        socket.destroy();
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const port = (server.address() as any).port;

    try {
      // notify-urls.json next to the script maps the project dir to our server.
      const projectDir = path.join(tempDir, "proj");
      const key = projectDir.replace(/\\/g, "/").toLowerCase();
      await fs.writeFile(
        path.join(userDataPath, "hooks", "notify-urls.json"),
        JSON.stringify({ [key]: [`http://127.0.0.1:${port}/notify?sid=ws%3Ap&secret=s`] }),
      );

      // Run the script exactly as Claude Code would: hook name as argv[2],
      // JSON payload on stdin. STRIDETERM_NOTIFY_URL cleared so resolution
      // goes through CLAUDE_PROJECT_DIR + notify-urls.json.
      await new Promise<void>((resolve, reject) => {
        const child = execFile(
          process.execPath,
          [scriptResult.path, "Stop"],
          {
            env: {
              ...process.env,
              STRIDETERM_NOTIFY_URL: "",
              CLAUDE_PROJECT_DIR: projectDir,
              // The child is a real node process, so `os.homedir()` inside it
              // is the DEVELOPER's home unless this seam is set — the script
              // would read the machine's real shard registry, whose live
              // instances make the local mirror below a fallback nobody
              // consults.
              STRIDETERM_HOOKS_DIR: path.join(tempDir, "shared-hooks"),
            },
          },
          (err) => (err ? reject(err) : resolve()),
        );
        child.stdin!.end(JSON.stringify({ session_id: "abc" }));
      });

      expect(firstKilled).toBe(true);
      expect(received).toHaveLength(1);
      expect(received[0].hook).toBe("Stop");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 15_000);
});

describe("PermissionRequest registration", () => {
  test("is registered with an EMPTY matcher — strIDEterm decides, not the settings file", async () => {
    const userDataPath = path.join(tempDir, "strideterm-data");
    await fs.mkdir(userDataPath, { recursive: true });

    await configureClaudeHook(userDataPath);

    const settings = JSON.parse(await fs.readFile(path.join(mockHomedir, ".claude", "settings.json"), "utf8"));
    expect(HOOKS_TO_REGISTER).toContain("PermissionRequest");
    expect(settings.hooks.PermissionRequest).toHaveLength(1);
    expect(settings.hooks.PermissionRequest[0].matcher).toBe("");
    expect(settings.hooks.PermissionRequest[0].hooks[0].command).toContain("notify.mjs");
  });
});

// --- notify.mjs PermissionRequest decision plumbing (end-to-end) ---

/** One stub instance: what it offers, and what its commit returns. */
interface StubInstance {
  /** requestId to answer phase 1 with, or "" to abstain. */
  offer: string;
  /** Document its commit returns as `hookOutput`, or null for none. */
  commit?: Record<string, unknown> | null;
}

interface NotifyRun {
  stdout: string;
  hookLog: string;
  /** Every request body each stub received, in arrival order. */
  received: Array<Array<Record<string, unknown>>>;
}

/**
 * Spawn the real notify.mjs against N stub strIDEterm instances and return
 * whatever the script printed on stdout — which is exactly what Claude Code
 * would read.
 *
 * The stubs implement the two-phase handshake: an `offer` body gets
 * `{offer:{requestId}}`, a `commit` body gets `{hookOutput:…}`.
 */
async function runNotifyForPermissionRequest(
  instances: StubInstance[],
  payload: Record<string, unknown> = {
    session_id: "abc",
    prompt_id: "p1",
    tool_name: "Bash",
    tool_input: { command: "chmod +x deploy.sh" },
  },
  env: Record<string, string> = {},
): Promise<NotifyRun> {
  const userDataPath = path.join(tempDir, "strideterm-data");
  await fs.mkdir(userDataPath, { recursive: true });
  const scriptResult = await ensureNotifyScript(userDataPath);
  expect(scriptResult.ok).toBe(true);

  const servers: http.Server[] = [];
  const urls: string[] = [];
  const received: Array<Array<Record<string, unknown>>> = [];
  for (const instance of instances) {
    const seen: Array<Record<string, unknown>> = [];
    received.push(seen);
    const server = http.createServer((req, res) => {
      let raw = "";
      req.on("data", (chunk) => {
        raw += chunk;
      });
      req.on("end", () => {
        let body: Record<string, unknown>;
        try {
          body = JSON.parse(raw || "{}") as Record<string, unknown>;
        } catch {
          body = { unparseable: raw };
        }
        seen.push(body);
        res.writeHead(200, { "Content-Type": "application/json" });
        if (body.phase === "commit") {
          res.end(instance.commit ? JSON.stringify({ hookOutput: instance.commit }) : "{}");
          return;
        }
        res.end(instance.offer ? JSON.stringify({ offer: { requestId: instance.offer } }) : "{}");
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    servers.push(server);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    urls.push(`http://127.0.0.1:${(server.address() as any).port}/notify?sid=ws%3Ap&secret=s`);
  }

  try {
    const projectDir = path.join(tempDir, "proj");
    const key = projectDir.replace(/\\/g, "/").toLowerCase();
    await fs.writeFile(path.join(userDataPath, "hooks", "notify-urls.json"), JSON.stringify({ [key]: urls }));

    const stdout = await new Promise<string>((resolve, reject) => {
      const child = execFile(
        process.execPath,
        [scriptResult.path, "PermissionRequest"],
        {
          env: {
            ...process.env,
            STRIDETERM_NOTIFY_URL: "",
            CLAUDE_PROJECT_DIR: projectDir,
            // Keep the shared registry out of the developer's real home dir.
            STRIDETERM_HOOKS_DIR: path.join(tempDir, "shared-hooks"),
            ...env,
          },
        },
        (err, out) => (err ? reject(err) : resolve(String(out))),
      );
      child.stdin!.end(JSON.stringify(payload));
    });

    let hookLog = "";
    try {
      hookLog = await fs.readFile(path.join(userDataPath, "logs", "hook.log"), "utf8");
    } catch {
      // No log file means nothing was worth logging — an empty string reads
      // the same for every assertion below.
    }
    return { stdout, hookLog, received };
  } finally {
    await Promise.all(servers.map((s) => new Promise<void>((resolve) => s.close(() => resolve()))));
  }
}

/** The exact document Claude Code reads for an approval. */
const ALLOW_DOCUMENT = {
  hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } },
};

describe("notify.mjs PermissionRequest decisions", () => {
  test("the stdout contract is the hookSpecificOutput document, byte for byte", async () => {
    // The whole point of P0-1: the wrapper is not optional. Compared as an
    // exact string, not a parsed object, because what Claude Code reads is the
    // bytes — an assertion on the inner object is how the missing wrapper
    // survived a green test suite.
    const { stdout } = await runNotifyForPermissionRequest([{ offer: "req-1", commit: ALLOW_DOCUMENT }]);
    expect(stdout).toBe(JSON.stringify(ALLOW_DOCUMENT));
    expect(stdout).toBe('{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}');
  }, 15_000);

  test("the commit carries the requestId the single offer named", async () => {
    const { received } = await runNotifyForPermissionRequest([{ offer: "req-42", commit: ALLOW_DOCUMENT }]);
    const commit = received[0].find((body) => body.phase === "commit");
    expect(commit).toMatchObject({ phase: "commit", request_id: "req-42" });
  }, 15_000);

  test("no instance offering → nothing printed and nothing committed", async () => {
    const { stdout, received } = await runNotifyForPermissionRequest([{ offer: "" }]);
    expect(stdout.trim()).toBe("");
    expect(received[0].some((body) => body.phase === "commit")).toBe(false);
  }, 15_000);

  test("two instances offering → nobody is committed and a conflict is logged", async () => {
    // Dev + prod strIDEterm over the same repo. There is no way to know whose
    // "allow" the user meant, so nobody's is used — and crucially NEITHER gets
    // a commit, so neither writes an audit row claiming it approved.
    const { stdout, hookLog, received } = await runNotifyForPermissionRequest([
      { offer: "req-a", commit: ALLOW_DOCUMENT },
      { offer: "req-b", commit: ALLOW_DOCUMENT },
    ]);
    expect(stdout.trim()).toBe("");
    expect(hookLog).toContain("conflict");
    expect(received[0].some((body) => body.phase === "commit")).toBe(false);
    expect(received[1].some((body) => body.phase === "commit")).toBe(false);
  }, 15_000);

  test("one offering alongside one abstaining → the single decision still wins", async () => {
    const { stdout, hookLog } = await runNotifyForPermissionRequest([
      { offer: "" },
      { offer: "req-1", commit: ALLOW_DOCUMENT },
    ]);
    expect(stdout).toBe(JSON.stringify(ALLOW_DOCUMENT));
    expect(hookLog).not.toContain("conflict");
  }, 15_000);

  test("an offer accepted but a commit that returns nothing prints nothing", async () => {
    // The audit write failed, or the offer expired. The prompt is shown, which
    // is the correct fallback.
    const { stdout } = await runNotifyForPermissionRequest([{ offer: "req-1", commit: null }]);
    expect(stdout.trim()).toBe("");
  }, 15_000);

  test("an unparseable response is ignored, not treated as an approval", async () => {
    const userDataPath = path.join(tempDir, "strideterm-data");
    await fs.mkdir(userDataPath, { recursive: true });
    const scriptResult = await ensureNotifyScript(userDataPath);
    const server = http.createServer((req, res) => {
      req.on("data", () => {});
      req.on("end", () => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end("this is not json");
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    try {
      const projectDir = path.join(tempDir, "proj");
      const key = projectDir.replace(/\\/g, "/").toLowerCase();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const url = `http://127.0.0.1:${(server.address() as any).port}/notify?sid=ws%3Ap&secret=s`;
      await fs.writeFile(path.join(userDataPath, "hooks", "notify-urls.json"), JSON.stringify({ [key]: [url] }));
      const stdout = await new Promise<string>((resolve, reject) => {
        const child = execFile(
          process.execPath,
          [scriptResult.path, "PermissionRequest"],
          {
            env: {
              ...process.env,
              STRIDETERM_NOTIFY_URL: "",
              CLAUDE_PROJECT_DIR: projectDir,
              STRIDETERM_HOOKS_DIR: path.join(tempDir, "shared-hooks"),
            },
          },
          (err, out) => (err ? reject(err) : resolve(String(out))),
        );
        child.stdin!.end(JSON.stringify({ session_id: "abc", tool_name: "Bash", tool_input: {} }));
      });
      expect(stdout.trim()).toBe("");
      const hookLog = await fs.readFile(path.join(userDataPath, "logs", "hook.log"), "utf8");
      expect(hookLog).toContain("unparseable");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 15_000);
});

describe("notify.mjs PermissionRequest payload shaping", () => {
  test("a 90KB Write body is trimmed before it is sent", async () => {
    // P2-7: untrimmed, this used to hit the server's body limit, which meant a
    // 413 and no decision at all — for exactly the operations a user turning
    // auto-approve on most wants answered.
    const content = "x".repeat(90 * 1024);
    const { received } = await runNotifyForPermissionRequest([{ offer: "req-1", commit: ALLOW_DOCUMENT }], {
      session_id: "abc",
      prompt_id: "p1",
      tool_name: "Write",
      tool_input: { file_path: "src/big.ts", content },
    });
    const offer = received[0].find((body) => body.phase === "offer")!;
    expect(JSON.stringify(offer).length).toBeLessThan(64 * 1024);
    // The field a summary is built from survives intact.
    expect((offer.tool_input as Record<string, unknown>).file_path).toBe("src/big.ts");
    expect(String((offer.tool_input as Record<string, unknown>).content).length).toBeLessThan(content.length);
  }, 15_000);

  test("the ownership token and one delivery id ride along, on both phases", async () => {
    const { received } = await runNotifyForPermissionRequest(
      [{ offer: "req-1", commit: ALLOW_DOCUMENT }],
      { session_id: "claude-sess", prompt_id: "prompt-7", tool_name: "Bash", tool_input: { command: "ls" } },
      { STRIDETERM_SESSION_TOKEN: "tok-abc" },
    );
    const offer = received[0].find((body) => body.phase === "offer")!;
    const commit = received[0].find((body) => body.phase === "commit")!;
    expect(offer.strideterm_session_token).toBe("tok-abc");
    // One hook run, one identity — the same value on the offer and on the
    // commit, so the instance that offered recognises the commit as its own.
    expect(String(offer.strideterm_delivery_id)).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(commit.strideterm_delivery_id).toBe(offer.strideterm_delivery_id);
    // The old key. `prompt_id` names the USER PROMPT, so a key built from it
    // was shared by every tool of one turn — and the second tool then replayed
    // the first one's `allow`, never reaching the never-list.
    expect(offer.request_key).toBeUndefined();
  }, 15_000);

  test("two requests of the SAME turn get different delivery ids", async () => {
    // Identical session_id and prompt_id: this is Bash and then Write inside
    // one user turn, which is exactly the pair the old key merged.
    const payload = { session_id: "s", prompt_id: "p", tool_name: "Bash", tool_input: { command: "ls" } };
    const first = await runNotifyForPermissionRequest([{ offer: "req-1", commit: ALLOW_DOCUMENT }], payload);
    const second = await runNotifyForPermissionRequest([{ offer: "req-1", commit: ALLOW_DOCUMENT }], payload);
    const idOf = (run: NotifyRun) => run.received[0].find((body) => body.phase === "offer")!.strideterm_delivery_id;
    expect(idOf(first)).not.toBe(idOf(second));
  }, 20_000);
});

describe("notify.mjs registry resolution", () => {
  test("reads the SHARED registry, so a second data dir is reachable", async () => {
    // P1-3: ~/.claude/settings.json is global, so only one installed
    // notify.mjs is ever registered — and before the shared registry it could
    // only ever see the URLs of its own data dir. Here the local file is
    // deliberately absent and the instance is found anyway.
    const userDataPath = path.join(tempDir, "other-instance-data");
    await fs.mkdir(path.join(userDataPath, "hooks"), { recursive: true });
    const scriptResult = await ensureNotifyScript(userDataPath);

    const seen: Array<Record<string, unknown>> = [];
    const server = http.createServer((req, res) => {
      let raw = "";
      req.on("data", (chunk) => {
        raw += chunk;
      });
      req.on("end", () => {
        try {
          seen.push(JSON.parse(raw || "{}") as Record<string, unknown>);
        } catch {
          // ignore
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end("{}");
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));

    try {
      const sharedDir = path.join(tempDir, "shared-registry");
      await fs.mkdir(sharedDir, { recursive: true });
      const projectDir = path.join(tempDir, "shared-proj");
      const key = projectDir.replace(/\\/g, "/").toLowerCase();
      // Written in the new entry shape, with the OTHER instance's identity.
      await fs.writeFile(
        path.join(sharedDir, "notify-urls.json"),
        JSON.stringify({
          [key]: [
            {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              url: `http://127.0.0.1:${(server.address() as any).port}/notify?sid=ws%3Ap&secret=s`,
              instanceId: "other-instance",
              sid: "ws:p",
            },
          ],
        }),
      );

      await new Promise<void>((resolve, reject) => {
        const child = execFile(
          process.execPath,
          [scriptResult.path, "Stop"],
          {
            env: {
              ...process.env,
              STRIDETERM_NOTIFY_URL: "",
              CLAUDE_PROJECT_DIR: projectDir,
              STRIDETERM_HOOKS_DIR: sharedDir,
            },
          },
          (err) => (err ? reject(err) : resolve()),
        );
        child.stdin!.end(JSON.stringify({ session_id: "abc" }));
      });

      expect(seen).toHaveLength(1);
      expect(seen[0].hook).toBe("Stop");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 15_000);

  test("merges the per-instance registry files, so two installations both get the event", async () => {
    // P2-5: each instance owns instances/<id>.json and writes nothing another
    // instance writes, so two of them registering at once cannot lose each
    // other's entries. The reader has to put them back together.
    const userDataPath = path.join(tempDir, "reader-data");
    await fs.mkdir(path.join(userDataPath, "hooks"), { recursive: true });
    const scriptResult = await ensureNotifyScript(userDataPath);

    const seen: Array<Array<Record<string, unknown>>> = [[], []];
    const servers: http.Server[] = [];
    const urls: string[] = [];
    for (const bucket of seen) {
      const server = http.createServer((req, res) => {
        let raw = "";
        req.on("data", (chunk) => {
          raw += chunk;
        });
        req.on("end", () => {
          try {
            bucket.push(JSON.parse(raw || "{}") as Record<string, unknown>);
          } catch {
            // ignore
          }
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end("{}");
        });
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
      servers.push(server);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      urls.push(`http://127.0.0.1:${(server.address() as any).port}/notify?sid=ws%3Ap&secret=s`);
    }

    try {
      const sharedDir = path.join(tempDir, "shared-instances");
      const instancesDir = path.join(sharedDir, "instances");
      await fs.mkdir(instancesDir, { recursive: true });
      const projectDir = path.join(tempDir, "two-instance-proj");
      const key = projectDir.replace(/\\/g, "/").toLowerCase();
      await fs.writeFile(
        path.join(instancesDir, "aaaaaaaaaaaa.json"),
        JSON.stringify({ [key]: [{ url: urls[0], instanceId: "aaaaaaaaaaaa", sid: "ws:p" }] }),
      );
      await fs.writeFile(
        path.join(instancesDir, "bbbbbbbbbbbb.json"),
        JSON.stringify({ [key]: [{ url: urls[1], instanceId: "bbbbbbbbbbbb", sid: "ws:p" }] }),
      );

      await new Promise<void>((resolve, reject) => {
        const child = execFile(
          process.execPath,
          [scriptResult.path, "Stop"],
          {
            env: {
              ...process.env,
              STRIDETERM_NOTIFY_URL: "",
              CLAUDE_PROJECT_DIR: projectDir,
              STRIDETERM_HOOKS_DIR: sharedDir,
            },
          },
          (err) => (err ? reject(err) : resolve()),
        );
        child.stdin!.end(JSON.stringify({ session_id: "abc" }));
      });

      expect(seen[0]).toHaveLength(1);
      expect(seen[1]).toHaveLength(1);
    } finally {
      await Promise.all(servers.map((s) => new Promise<void>((resolve) => s.close(() => resolve()))));
    }
  }, 15_000);

  test("an expired shard is not routed to, while the live installation still is", async () => {
    // P3-4: the residue of a crashed run or a deleted data dir is a file only
    // its dead owner may write. The lease is what lets the READER refuse it —
    // without which every hook POSTs at a dead or recycled port and pays the
    // connect attempt before it can reach the instance that is actually there.
    const userDataPath = path.join(tempDir, "lease-reader-data");
    await fs.mkdir(path.join(userDataPath, "hooks"), { recursive: true });
    const scriptResult = await ensureNotifyScript(userDataPath);

    const seen: Array<Array<Record<string, unknown>>> = [[], []];
    const servers: http.Server[] = [];
    const urls: string[] = [];
    for (const bucket of seen) {
      const server = http.createServer((req, res) => {
        let raw = "";
        req.on("data", (chunk) => {
          raw += chunk;
        });
        req.on("end", () => {
          try {
            bucket.push(JSON.parse(raw || "{}") as Record<string, unknown>);
          } catch {
            // ignore
          }
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end("{}");
        });
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
      servers.push(server);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      urls.push(`http://127.0.0.1:${(server.address() as any).port}/notify?sid=ws%3Ap&secret=s`);
    }

    try {
      const sharedDir = path.join(tempDir, "shared-lease");
      const instancesDir = path.join(sharedDir, "instances");
      await fs.mkdir(instancesDir, { recursive: true });
      const projectDir = path.join(tempDir, "lease-proj");
      const key = projectDir.replace(/\\/g, "/").toLowerCase();
      await fs.writeFile(
        path.join(instancesDir, "aaaaaaaaaaaa.json"),
        JSON.stringify({
          updatedAt: Date.now(),
          urls: { [key]: [{ url: urls[0], instanceId: "aaaaaaaaaaaa", sid: "ws:p" }] },
        }),
      );
      await fs.writeFile(
        path.join(instancesDir, "bbbbbbbbbbbb.json"),
        JSON.stringify({
          updatedAt: Date.now() - SHARD_LEASE_TTL_MS - 60_000,
          urls: { [key]: [{ url: urls[1], instanceId: "bbbbbbbbbbbb", sid: "ws:p" }] },
        }),
      );

      await new Promise<void>((resolve, reject) => {
        const child = execFile(
          process.execPath,
          [scriptResult.path, "Stop"],
          {
            env: {
              ...process.env,
              STRIDETERM_NOTIFY_URL: "",
              CLAUDE_PROJECT_DIR: projectDir,
              STRIDETERM_HOOKS_DIR: sharedDir,
            },
          },
          (err) => (err ? reject(err) : resolve()),
        );
        child.stdin!.end(JSON.stringify({ session_id: "abc" }));
      });

      expect(seen[0]).toHaveLength(1);
      expect(seen[1]).toHaveLength(0);
    } finally {
      await Promise.all(servers.map((s) => new Promise<void>((resolve) => s.close(() => resolve()))));
    }
  }, 15_000);

  /**
   * Run the real notify.mjs against two stub servers and whatever registry
   * layout `write` puts in place. Returns what each stub received.
   */
  async function runWithRegistryLayout(
    label: string,
    write: (context: {
      instancesDir: string;
      sharedUrlsPath: string;
      localUrlsPath: string;
      key: string;
      /** Registry key of a workspace NESTED inside `key` — the prefix-fallback case. */
      childKey: string;
      urls: string[];
    }) => Promise<void>,
    options: { runInChild?: boolean } = {},
  ): Promise<Array<Array<Record<string, unknown>>>> {
    const userDataPath = path.join(tempDir, `${label}-data`);
    await fs.mkdir(path.join(userDataPath, "hooks"), { recursive: true });
    const scriptResult = await ensureNotifyScript(userDataPath);
    expect(scriptResult.ok).toBe(true);

    const seen: Array<Array<Record<string, unknown>>> = [[], []];
    const servers: http.Server[] = [];
    const urls: string[] = [];
    for (const bucket of seen) {
      const server = http.createServer((req, res) => {
        let raw = "";
        req.on("data", (chunk) => {
          raw += chunk;
        });
        req.on("end", () => {
          try {
            bucket.push(JSON.parse(raw || "{}") as Record<string, unknown>);
          } catch {
            // ignore
          }
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end("{}");
        });
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
      servers.push(server);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      urls.push(`http://127.0.0.1:${(server.address() as any).port}/notify?sid=ws%3Ap&secret=s`);
    }

    try {
      const sharedDir = path.join(tempDir, `${label}-shared`);
      const instancesDir = path.join(sharedDir, "instances");
      await fs.mkdir(instancesDir, { recursive: true });
      const projectDir = path.join(tempDir, `${label}-proj`);
      const childDir = path.join(projectDir, "sub");
      const norm = (dir: string) => dir.replace(/\\/g, "/").toLowerCase();
      await write({
        instancesDir,
        sharedUrlsPath: path.join(sharedDir, "notify-urls.json"),
        localUrlsPath: path.join(userDataPath, "hooks", "notify-urls.json"),
        key: norm(projectDir),
        childKey: norm(childDir),
        urls,
      });
      const hookCwd = options.runInChild ? childDir : projectDir;

      await new Promise<void>((resolve, reject) => {
        const child = execFile(
          process.execPath,
          [scriptResult.path, "Stop"],
          {
            env: {
              ...process.env,
              STRIDETERM_NOTIFY_URL: "",
              CLAUDE_PROJECT_DIR: hookCwd,
              STRIDETERM_HOOKS_DIR: sharedDir,
            },
          },
          (err) => (err ? reject(err) : resolve()),
        );
        child.stdin!.end(JSON.stringify({ session_id: "abc" }));
      });
      return seen;
    } finally {
      await Promise.all(servers.map((s) => new Promise<void>((resolve) => s.close(() => resolve()))));
    }
  }

  test("an expired shard's URL is not resurrected by the legacy mirrors", async () => {
    // P3-2: the shard was correctly refused for its lease, and then both bare
    // mirrors — written while that installation was still alive — named the
    // same URL and put it straight back. A lease that any unleased source can
    // overrule is no protection at all for the crash/abandon case it exists
    // for. The mirrors are still read here (no other shard answers) and still
    // route what only they know: the tombstone is per-URL, not a blanket
    // refusal.
    const seen = await runWithRegistryLayout("mirror-lease", async (ctx) => {
      await fs.writeFile(
        path.join(ctx.instancesDir, "bbbbbbbbbbbb.json"),
        JSON.stringify({
          updatedAt: Date.now() - SHARD_LEASE_TTL_MS - 60_000,
          urls: { [ctx.key]: [{ url: ctx.urls[1], instanceId: "bbbbbbbbbbbb", sid: "ws:p" }] },
        }),
      );
      // The aggregate as it stood while the dead instance was still running…
      await fs.writeFile(ctx.sharedUrlsPath, JSON.stringify({ [ctx.key]: [ctx.urls[0], ctx.urls[1]] }));
      // …and the local mirror of the script that instance had installed.
      await fs.writeFile(ctx.localUrlsPath, JSON.stringify({ [ctx.key]: [ctx.urls[1]] }));
    });

    expect(seen[0]).toHaveLength(1);
    expect(seen[1]).toHaveLength(0);
  }, 15_000);

  test("a swept installation's mirror is not consulted while a leased shard answers", async () => {
    // The ordering trap: `pruneExpiredShards()` DELETES the expired shard, and
    // with the file gone there is nothing left to tombstone its URLs from. So
    // the rule has to be structural as well — a shard registry that answered
    // is authoritative, and the unleased mirrors are only for a machine that
    // has none.
    const seen = await runWithRegistryLayout("swept-mirror", async (ctx) => {
      await fs.writeFile(
        path.join(ctx.instancesDir, "aaaaaaaaaaaa.json"),
        JSON.stringify({
          updatedAt: Date.now(),
          urls: { [ctx.key]: [{ url: ctx.urls[0], instanceId: "aaaaaaaaaaaa", sid: "ws:p" }] },
        }),
      );
      // No shard names urls[1] any more — it was swept. Both mirrors still do.
      await fs.writeFile(ctx.sharedUrlsPath, JSON.stringify({ [ctx.key]: [ctx.urls[0], ctx.urls[1]] }));
      await fs.writeFile(ctx.localUrlsPath, JSON.stringify({ [ctx.key]: [ctx.urls[1]] }));
    });

    expect(seen[0]).toHaveLength(1);
    expect(seen[1]).toHaveLength(0);
  }, 15_000);

  test("an expired child workspace does not fall through to a live parent's panel", async () => {
    // P3-1: refusing the expired shard's URL is only half the answer. The
    // shard never reached `routable`, so its workspace KEY was never
    // materialised — and with no exact key, the resolver's longest-PREFIX
    // match handed the hook to the live parent workspace at the level above.
    // The event would have raised an alert (and offered a decision) in a
    // different panel, in a different workspace, that never made the call.
    //
    // Neither mirror can rescue the key here either: a leased shard answered,
    // so both are skipped by construction.
    const seen = await runWithRegistryLayout(
      "nested-expired",
      async (ctx) => {
        await fs.writeFile(
          path.join(ctx.instancesDir, "aaaaaaaaaaaa.json"),
          JSON.stringify({
            updatedAt: Date.now(),
            urls: { [ctx.key]: [{ url: ctx.urls[0], instanceId: "aaaaaaaaaaaa", sid: "ws:parent" }] },
          }),
        );
        await fs.writeFile(
          path.join(ctx.instancesDir, "bbbbbbbbbbbb.json"),
          JSON.stringify({
            updatedAt: Date.now() - SHARD_LEASE_TTL_MS - 60_000,
            urls: { [ctx.childKey]: [{ url: ctx.urls[1], instanceId: "bbbbbbbbbbbb", sid: "ws:child" }] },
          }),
        );
      },
      { runInChild: true },
    );

    // Not the dead child URL, and not the live parent's either.
    expect(seen[0]).toHaveLength(0);
    expect(seen[1]).toHaveLength(0);
  }, 15_000);

  test("a live nested workspace still routes to its own panel, not the parent's", async () => {
    // The other side of the same rule: the empty bucket is written only where
    // nothing live claims the key, so dev and prod (or a parent workspace and
    // a nested one) keep the routing they registered.
    const seen = await runWithRegistryLayout(
      "nested-live",
      async (ctx) => {
        await fs.writeFile(
          path.join(ctx.instancesDir, "aaaaaaaaaaaa.json"),
          JSON.stringify({
            updatedAt: Date.now(),
            urls: {
              [ctx.key]: [{ url: ctx.urls[0], instanceId: "aaaaaaaaaaaa", sid: "ws:parent" }],
              [ctx.childKey]: [{ url: ctx.urls[1], instanceId: "aaaaaaaaaaaa", sid: "ws:child" }],
            },
          }),
        );
      },
      { runInChild: true },
    );

    expect(seen[0]).toHaveLength(0);
    expect(seen[1]).toHaveLength(1);
  }, 15_000);

  test("with no shard registry at all, the legacy mirrors still route", async () => {
    // The compatibility half of the same rule. An installation whose script
    // predates the per-instance shards has nothing else to resolve against,
    // and "prefer the leased source" must not become "ignore the only one".
    const seen = await runWithRegistryLayout("mirror-only", async (ctx) => {
      await fs.writeFile(ctx.localUrlsPath, JSON.stringify({ [ctx.key]: [ctx.urls[1]] }));
    });

    expect(seen[0]).toHaveLength(0);
    expect(seen[1]).toHaveLength(1);
  }, 15_000);

  test("a live STRIDETERM_NOTIFY_URL is used alone — sibling panels of the same cwd are not copied in", async () => {
    // The registry is keyed by project DIRECTORY, so it lists every panel of
    // the workspace. The env URL names this panel exactly; using both would
    // raise the second panel's alert for the first panel's event, which is
    // precisely the mis-routing the sid in each URL exists to prevent.
    const userDataPath = path.join(tempDir, "sibling-data");
    await fs.mkdir(path.join(userDataPath, "hooks"), { recursive: true });
    const scriptResult = await ensureNotifyScript(userDataPath);

    const seen: Array<Array<Record<string, unknown>>> = [[], []];
    const servers: http.Server[] = [];
    const urls: string[] = [];
    for (let index = 0; index < seen.length; index += 1) {
      const bucket = seen[index];
      const server = http.createServer((req, res) => {
        let raw = "";
        req.on("data", (chunk) => {
          raw += chunk;
        });
        req.on("end", () => {
          try {
            bucket.push(JSON.parse(raw || "{}") as Record<string, unknown>);
          } catch {
            // ignore
          }
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end("{}");
        });
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
      servers.push(server);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      urls.push(`http://127.0.0.1:${(server.address() as any).port}/notify?sid=ws%3Ap${index}&secret=s`);
    }

    try {
      const sharedDir = path.join(tempDir, "sibling-hooks");
      const instancesDir = path.join(sharedDir, "instances");
      await fs.mkdir(instancesDir, { recursive: true });
      const projectDir = path.join(tempDir, "sibling-proj");
      const key = projectDir.replace(/\\/g, "/").toLowerCase();
      await fs.writeFile(
        path.join(instancesDir, "dddddddddddd.json"),
        JSON.stringify({
          [key]: [
            { url: urls[0], instanceId: "dddddddddddd", sid: "ws:p0" },
            { url: urls[1], instanceId: "dddddddddddd", sid: "ws:p1" },
          ],
        }),
      );

      await new Promise<void>((resolve, reject) => {
        const child = execFile(
          process.execPath,
          [scriptResult.path, "Stop"],
          {
            env: {
              ...process.env,
              STRIDETERM_NOTIFY_URL: urls[0],
              CLAUDE_PROJECT_DIR: projectDir,
              STRIDETERM_HOOKS_DIR: sharedDir,
            },
          },
          (err) => (err ? reject(err) : resolve()),
        );
        child.stdin!.end(JSON.stringify({ session_id: "abc" }));
      });

      expect(seen[0]).toHaveLength(1);
      expect(seen[1]).toHaveLength(0);
    } finally {
      await Promise.all(servers.map((s) => new Promise<void>((resolve) => s.close(() => resolve()))));
    }
  }, 15_000);

  test("a stale STRIDETERM_NOTIFY_URL does not stop the registry from being used", async () => {
    // P1-2: the notify server was restarted on a different port (the agent-hook
    // checkbox off and on again). A shell started before that still carries the
    // old URL in its environment and cannot be updated — so the env value must
    // be a candidate, never the only one, or the panel stays dead until the
    // user restarts the terminal.
    const userDataPath = path.join(tempDir, "stale-env-data");
    await fs.mkdir(path.join(userDataPath, "hooks"), { recursive: true });
    const scriptResult = await ensureNotifyScript(userDataPath);

    const seen: Array<Record<string, unknown>> = [];
    const server = http.createServer((req, res) => {
      let raw = "";
      req.on("data", (chunk) => {
        raw += chunk;
      });
      req.on("end", () => {
        try {
          seen.push(JSON.parse(raw || "{}") as Record<string, unknown>);
        } catch {
          // ignore
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end("{}");
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));

    // A port nothing is listening on — the server that used to be there.
    const deadServer = http.createServer(() => {});
    await new Promise<void>((resolve) => deadServer.listen(0, "127.0.0.1", () => resolve()));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const deadPort = (deadServer.address() as any).port;
    await new Promise<void>((resolve) => deadServer.close(() => resolve()));

    try {
      const sharedDir = path.join(tempDir, "stale-env-hooks");
      const instancesDir = path.join(sharedDir, "instances");
      await fs.mkdir(instancesDir, { recursive: true });
      const projectDir = path.join(tempDir, "stale-env-proj");
      const key = projectDir.replace(/\\/g, "/").toLowerCase();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const liveUrl = `http://127.0.0.1:${(server.address() as any).port}/notify?sid=ws%3Ap&secret=s`;
      await fs.writeFile(
        path.join(instancesDir, "cccccccccccc.json"),
        JSON.stringify({ [key]: [{ url: liveUrl, instanceId: "cccccccccccc", sid: "ws:p" }] }),
      );

      await new Promise<void>((resolve, reject) => {
        const child = execFile(
          process.execPath,
          [scriptResult.path, "Stop"],
          {
            env: {
              ...process.env,
              STRIDETERM_NOTIFY_URL: `http://127.0.0.1:${deadPort}/notify?sid=ws%3Ap&secret=s`,
              CLAUDE_PROJECT_DIR: projectDir,
              STRIDETERM_HOOKS_DIR: sharedDir,
            },
          },
          (err) => (err ? reject(err) : resolve()),
        );
        child.stdin!.end(JSON.stringify({ session_id: "abc" }));
      });

      expect(seen).toHaveLength(1);
      expect(seen[0].hook).toBe("Stop");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 20_000);
});
