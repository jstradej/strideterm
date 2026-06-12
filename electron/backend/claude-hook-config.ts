/// <reference types="node" />
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { existsSync, mkdirSync } from "node:fs";
import { getLogger } from "./logger.js";

const log = getLogger("claude-hook");

/**
 * Manages Claude Code notification hooks in ~/.claude/settings.json.
 *
 * Provides configure/remove/detect operations that safely merge with
 * existing user settings without overwriting other hooks or config.
 *
 * Registers four hook types against the same notify.mjs script:
 * - Notification   — idle_prompt / permission_prompt / elicitation / auth
 * - Stop           — end of each assistant turn
 * - SubagentStop   — sub-agent completion
 * - UserPromptSubmit — user submitted a new prompt (resets idle state)
 *
 * The script receives the hook name as argv[2] and POSTs it to notify-server.js
 * in the body as the `hook` field; dispatcher.js routes from there.
 */

// Hook types to register. Order matters only for log readability.
export const HOOKS_TO_REGISTER = ["Notification", "Stop", "SubagentStop", "UserPromptSubmit"];

// Markers used to identify strIDEterm hooks in Claude Code settings.
// We check for the env var reference (legacy curl-based hook) and the
// notify script path (Node-based hook) so upgrades are seamless.
const HOOK_MARKERS = ["STRIDETERM_NOTIFY_URL", "hooks/notify.mjs", "hooks\\notify.mjs"];

// Cross-platform Node.js script that reads stdin and POSTs to the strIDEterm
// notify-server. Written to <userDataPath>/hooks/notify.mjs at runtime.
//
// argv[2] is the hook name (Notification | Stop | SubagentStop | UserPromptSubmit)
// injected by buildHookEntry. The script parses stdin as JSON, augments it with
// the hook name, and POSTs to all URLs mapped to the current CLAUDE_PROJECT_DIR.
//
// Claude Code does NOT pass parent env vars to hook processes (only CLAUDE_*).
// URLs are resolved from a file written by strideterm's runtime.
//
// Paths resolve from `import.meta.url` so each installed script points at its
// own <userDataPath> — critical for dev instances (dev.ps1 / --data-dir) whose
// runtime writes notify-urls.json under ~/.strideterm-dev. Using os.homedir()
// here would route every hook back to ~/.strideterm regardless of instance.
//
// Logs to <userDataPath>/logs/hook.log (errors/warnings only, auto-truncated
// at 3MB for retention). Successful delivery is visible in strideterm.log
// via notify-server entries.
const NOTIFY_SCRIPT_CONTENT = `import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// __dirname equivalent for ESM — resolves to <userDataPath>/hooks/
const HOOKS_DIR = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.dirname(HOOKS_DIR);

const LOG_PATH = path.join(DATA_DIR, "logs", "hook.log");
const LOG_MAX_BYTES = 3 * 1024 * 1024; // 3 MB
function log(level, msg) {
  try {
    const line = new Date().toISOString().replace("T", " ").replace("Z", "") + " " + level + "  [hook] " + msg + "\\n";
    try { if (fs.statSync(LOG_PATH).size > LOG_MAX_BYTES) fs.writeFileSync(LOG_PATH, ""); } catch {}
    try { fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true }); } catch {}
    fs.appendFileSync(LOG_PATH, line);
  } catch {}
}

const URLS_PATH = path.join(HOOKS_DIR, "notify-urls.json");
// Hook name — passed as argv[2] by buildHookEntry. Falls back to payload
// hook_event_name (Claude Code may include this) or "Notification" as a
// last resort for older hook scripts not re-installed yet.
const hookNameArg = process.argv[2] || "";
const envUrl = process.env.STRIDETERM_NOTIFY_URL || "";
const envProjectDir = process.env.CLAUDE_PROJECT_DIR || "";

const norm = (p) => String(p || "").replace(/\\\\/g, "/").toLowerCase().replace(/\\/+$/, "");

function resolveUrls(projectDir) {
  if (!projectDir) return [];
  let mapping;
  try {
    mapping = JSON.parse(fs.readFileSync(URLS_PATH, "utf8"));
  } catch (e) {
    log("ERROR", "cannot read " + URLS_PATH + ": " + e.message);
    return [];
  }
  const needle = norm(projectDir);
  if (Array.isArray(mapping[needle])) return mapping[needle];
  // Longest-prefix match so claude invoked in a subdirectory still routes
  // to its owning strideterm workspace. External agents running outside
  // any registered workspace will never match and exit silently — that
  // is intentional so their notifications don't leak into strideterm.
  let bestKey = "";
  for (const key of Object.keys(mapping)) {
    if ((needle === key || needle.startsWith(key + "/")) && key.length > bestKey.length) {
      bestKey = key;
    }
  }
  return bestKey ? (mapping[bestKey] || []) : [];
}

let body = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { body += chunk; });
process.stdin.on("end", () => {
  let parsed;
  try {
    parsed = body.trim() ? JSON.parse(body) : {};
  } catch {
    parsed = { raw_body: body };
  }
  parsed.hook = hookNameArg || parsed.hook_event_name || parsed.hook || "Notification";

  // Resolve notify URLs. Precedence:
  //   1. STRIDETERM_NOTIFY_URL — direct handoff from parent PTY env (only
  //      works if the agent propagates strideterm env vars to hooks).
  //   2. CLAUDE_PROJECT_DIR — set by Claude Code.
  //   3. payload.cwd — set by Codex.
  // If none of these match a strideterm-registered workspace, exit silently:
  // this hook is firing from an agent run the user started outside any
  // strideterm PTY (e.g. "claude" in another terminal) and we must not leak
  // its notifications into strideterm tabs.
  let allUrls = envUrl ? [envUrl] : [];
  const payloadCwd = typeof parsed.cwd === "string" ? parsed.cwd : "";
  const projectDir = envProjectDir || payloadCwd;
  if (allUrls.length === 0) allUrls = resolveUrls(projectDir);

  if (allUrls.length === 0) {
    log("DEBUG", "no match for projectDir=" + (projectDir || "<unset>") + " (hook=" + parsed.hook + ") — skipping");
    process.exit(0);
  }

  const outgoing = JSON.stringify(parsed);
  let pending = allUrls.length;
  function done() { if (--pending <= 0) process.exit(0); }
  // One retry after a short delay: a transient failure (strideterm
  // restarting, notify server rebinding) would otherwise lose the event
  // forever. Per-request timeout is 2s so the worst case (2s + 0.5s + 2s)
  // stays inside Claude Code's 5s hook timeout.
  function post(u, attempt) {
    let p;
    try { p = new URL(u); } catch (e) { log("ERROR", "invalid url: " + u); done(); return; }
    const options = {
      hostname: p.hostname,
      port: p.port,
      path: p.pathname + p.search,
      method: "POST",
      headers: { "Content-Type": "application/json" },
      timeout: 2000,
    };
    let settled = false;
    const fail = (msg) => {
      if (settled) return;
      settled = true;
      if (attempt < 1) {
        log("WARN", msg + " — retrying (hook=" + parsed.hook + ")");
        setTimeout(() => post(u, attempt + 1), 500);
      } else {
        log("ERROR", msg + " (hook=" + parsed.hook + ")");
        done();
      }
    };
    const req = http.request(options, (res) => {
      if (settled) return;
      settled = true;
      if (res.statusCode !== 200 && res.statusCode !== 403) {
        log("WARN", "POST " + p.port + " -> " + res.statusCode + " (hook=" + parsed.hook + ")");
      }
      res.resume();
      done();
    });
    req.on("error", (e) => fail("POST failed: " + e.message));
    req.on("timeout", () => { req.destroy(); fail("POST timeout 2s"); });
    req.end(outgoing);
  }
  for (const u of allUrls) post(u, 0);
});
process.stdin.resume();
`;

function getClaudeSettingsPath(): string {
  return path.join(os.homedir(), ".claude", "settings.json");
}

function getNotifyScriptPath(userDataPath: string): string {
  return path.join(userDataPath, "hooks", "notify.mjs");
}

/**
 * Ensures the notify.mjs hook script exists at ~/.strideterm/hooks/notify.mjs.
 * Overwrites on every startup to keep it up to date.
 */
export async function ensureNotifyScript(userDataPath: string): Promise<{ ok: boolean; path: string; error?: string }> {
  const scriptPath = getNotifyScriptPath(userDataPath);
  const dir = path.dirname(scriptPath);
  try {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    await fs.writeFile(scriptPath, NOTIFY_SCRIPT_CONTENT, "utf8");
    return { ok: true, path: scriptPath };
  } catch (error) {
    return { ok: false, path: scriptPath, error: (error as NodeJS.ErrnoException).message };
  }
}

/**
 * Reads and parses ~/.claude/settings.json.
 * Returns { ok, data, error } — data is null if file doesn't exist.
 */
async function readClaudeSettings(): Promise<{
  ok: boolean;
  data: Record<string, unknown> | null;
  path: string;
  error?: string;
}> {
  const settingsPath = getClaudeSettingsPath();
  try {
    const raw = await fs.readFile(settingsPath, "utf8");
    const data = JSON.parse(raw) as Record<string, unknown>;
    return { ok: true, data, path: settingsPath };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { ok: true, data: null, path: settingsPath };
    }
    return { ok: false, data: null, path: settingsPath, error: (error as NodeJS.ErrnoException).message };
  }
}

/**
 * Writes settings to ~/.claude/settings.json atomically.
 */
async function writeClaudeSettings(data: Record<string, unknown>): Promise<{ ok: boolean; error?: string }> {
  const settingsPath = getClaudeSettingsPath();
  const dir = path.dirname(settingsPath);
  const tmpPath = settingsPath + ".strideterm-tmp";
  try {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    const content = JSON.stringify(data, null, 2) + "\n";
    await fs.writeFile(tmpPath, content, "utf8");
    await fs.rename(tmpPath, settingsPath);
    return { ok: true };
  } catch (error) {
    // Clean up temp file if rename failed
    await fs.rm(tmpPath, { force: true }).catch(() => {});
    return { ok: false, error: (error as NodeJS.ErrnoException).message };
  }
}

/**
 * Builds the hook entry object for Claude Code settings.
 * The hook name is passed as argv[2] so the same script handles all hook types.
 */
function buildHookEntry(notifyScriptPath: string, hookName: string) {
  // Normalize path separators to forward slashes for cross-platform shell compat
  const normalizedPath = notifyScriptPath.replace(/\\/g, "/");
  return {
    matcher: "",
    hooks: [
      {
        type: "command",
        command: `node "${normalizedPath}" ${hookName}`,
        timeout: 5,
      },
    ],
  };
}

/**
 * Checks if a strIDEterm hook is already configured in a given hook category.
 * Returns the index in settings.hooks[hookName], or -1 if not found.
 *
 * Default hookName is "Notification" for backward compatibility with earlier
 * callers/tests that assumed only Notification was registered.
 */
export function findExistingHook(settings: Record<string, unknown>, hookName = "Notification"): number {
  const hooksSection = (settings?.hooks as Record<string, unknown> | undefined)?.[hookName];
  if (!Array.isArray(hooksSection)) return -1;
  return hooksSection.findIndex(
    (entry: unknown) =>
      Array.isArray((entry as Record<string, unknown>)?.hooks) &&
      ((entry as Record<string, unknown>).hooks as unknown[]).some(
        (h: unknown) =>
          typeof (h as Record<string, unknown>)?.command === "string" &&
          HOOK_MARKERS.some((marker) => (h as Record<string, string>).command.includes(marker)),
      ),
  );
}

/**
 * Configure the Claude Code notification hooks.
 *
 * Registers four hook types (HOOKS_TO_REGISTER) pointing at the same
 * notify.mjs script, each invoked with its hook name as argv[2].
 *
 * - Creates ~/.claude/settings.json if it doesn't exist
 * - Merges with existing hooks (never overwrites unrelated config)
 * - Updates existing strIDEterm hook entries if found (no duplication)
 *
 * Returns { ok, error?, detail?, scriptPath?, settingsPath?, registered?: string[] }
 */
export async function configureClaudeHook(userDataPath: string) {
  // Step 1: ensure the notify script exists
  const scriptResult = await ensureNotifyScript(userDataPath);
  if (!scriptResult.ok) {
    return {
      ok: false,
      error: `Failed to write hook script: ${scriptResult.error}`,
      detail: "script-write-failed",
    };
  }

  // Step 2: read existing Claude settings
  const readResult = await readClaudeSettings();
  if (!readResult.ok) {
    return {
      ok: false,
      error: `Cannot read ${readResult.path}: ${readResult.error}. Check if the file contains valid JSON.`,
      detail: "settings-read-failed",
    };
  }

  // Step 3: merge hooks into settings (iterate over all hook types)
  const settings = readResult.data || {};
  if (!settings.hooks || typeof settings.hooks !== "object") settings.hooks = {};
  const hooksMap = settings.hooks as Record<string, unknown[]>;
  const registered: string[] = [];

  for (const hookName of HOOKS_TO_REGISTER) {
    if (!Array.isArray(hooksMap[hookName])) hooksMap[hookName] = [];
    const hookEntry = buildHookEntry(scriptResult.path, hookName);
    const existingIndex = findExistingHook(settings, hookName);

    if (existingIndex >= 0) {
      hooksMap[hookName][existingIndex] = hookEntry;
    } else {
      hooksMap[hookName].push(hookEntry);
    }
    registered.push(hookName);
  }

  // Step 4: write back
  const writeResult = await writeClaudeSettings(settings);
  if (!writeResult.ok) {
    return {
      ok: false,
      error: `Failed to write ${readResult.path}: ${writeResult.error}`,
      detail: "settings-write-failed",
    };
  }

  log.info("claude hooks configured", {
    scriptPath: scriptResult.path,
    settingsPath: readResult.path,
    registered,
  });
  return {
    ok: true,
    scriptPath: scriptResult.path,
    settingsPath: readResult.path,
    registered,
  };
}

/**
 * Remove all strIDEterm hooks from Claude Code settings.
 * Leaves all other hooks and settings intact.
 *
 * Returns { ok, error?, removed?: boolean, removedFrom?: string[] }
 */
export async function removeClaudeHook() {
  const readResult = await readClaudeSettings();
  if (!readResult.ok) {
    log.warn("removeClaudeHook: cannot read settings", { path: readResult.path, err: readResult.error });
    return { ok: false, error: `Cannot read ${readResult.path}: ${readResult.error}` };
  }

  if (!readResult.data) {
    log.debug("removeClaudeHook: settings file not found, nothing to remove");
    return { ok: true, removed: false };
  }

  const settings = readResult.data;
  const removedFrom: string[] = [];

  // Remove strIDEterm entries from each registered hook category.
  // We also iterate over ANY hook key that contains our marker, to handle
  // cleanup of old-format hook entries that may not be in HOOKS_TO_REGISTER.
  const hooksMap = (settings.hooks || {}) as Record<string, unknown[]>;
  const hookKeysToCheck = new Set([...HOOKS_TO_REGISTER, ...Object.keys(hooksMap)]);

  for (const hookName of hookKeysToCheck) {
    const existingIndex = findExistingHook(settings, hookName);
    if (existingIndex < 0) continue;

    hooksMap[hookName].splice(existingIndex, 1);
    removedFrom.push(hookName);

    // Clean up empty array for this hook type
    if (hooksMap[hookName].length === 0) {
      delete hooksMap[hookName];
    }
  }

  if (removedFrom.length === 0) {
    log.debug("removeClaudeHook: no strIDEterm hooks found in settings");
    return { ok: true, removed: false };
  }

  // Clean up empty hooks object
  if (Object.keys(hooksMap).length === 0) {
    delete settings.hooks;
  }

  const writeResult = await writeClaudeSettings(settings);
  if (!writeResult.ok) {
    log.warn("removeClaudeHook: failed to write settings", { path: readResult.path, err: writeResult.error });
    return { ok: false, error: `Failed to write ${readResult.path}: ${writeResult.error}` };
  }

  log.info("claude hooks removed", { settingsPath: readResult.path, removedFrom });
  return { ok: true, removed: true, removedFrom };
}

/**
 * Detect current hook configuration status.
 *
 * Returns { status, scriptPath?, settingsPath?, error?, missingHooks?: string[] }
 * - status: "configured" | "not-configured" | "error" | "script-missing" | "partial"
 * - "partial" means some hooks are registered but not all (upgrade available).
 */
export async function detectClaudeHookStatus(userDataPath: string) {
  const settingsPath = getClaudeSettingsPath();
  const scriptPath = getNotifyScriptPath(userDataPath);

  // Check if the notify script exists
  const scriptExists = existsSync(scriptPath);

  // Check Claude settings
  const readResult = await readClaudeSettings();
  if (!readResult.ok) {
    log.debug("detectClaudeHookStatus: cannot read settings", { err: readResult.error });
    return {
      status: "error",
      error: readResult.error,
      settingsPath,
      scriptPath,
    };
  }

  if (!readResult.data) {
    log.debug("detectClaudeHookStatus: settings file not found", { settingsPath });
    return { status: "not-configured", settingsPath, scriptPath };
  }

  // Check each hook category.
  const registered: string[] = [];
  const missing: string[] = [];
  for (const hookName of HOOKS_TO_REGISTER) {
    const idx = findExistingHook(readResult.data, hookName);
    if (idx >= 0) registered.push(hookName);
    else missing.push(hookName);
  }

  if (registered.length === 0) {
    log.debug("detectClaudeHookStatus: no strIDEterm hooks found");
    return { status: "not-configured", settingsPath, scriptPath };
  }

  if (!scriptExists) {
    log.warn("detectClaudeHookStatus: hooks configured but script missing", { scriptPath });
    return { status: "script-missing", settingsPath, scriptPath, registered, missingHooks: missing };
  }

  if (missing.length > 0) {
    log.info("detectClaudeHookStatus: partial — missing hooks", { missing });
    return {
      status: "partial",
      settingsPath,
      scriptPath,
      registered,
      missingHooks: missing,
    };
  }

  log.debug("detectClaudeHookStatus: all hooks configured", { settingsPath, scriptPath });
  return { status: "configured", settingsPath, scriptPath, registered };
}

// For testing
export { getClaudeSettingsPath, getNotifyScriptPath, NOTIFY_SCRIPT_CONTENT, HOOK_MARKERS };
