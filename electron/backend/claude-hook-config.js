import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { existsSync, mkdirSync } from "node:fs";
import { getLogger } from "./logger.js";

const log = getLogger("claude-hook");

/**
 * Manages the Claude Code notification hook in ~/.claude/settings.json.
 *
 * Provides configure/remove/detect operations that safely merge with
 * existing user settings without overwriting other hooks or config.
 */

// Markers used to identify strIDEterm hooks in Claude Code settings.
// We check for both the env var reference (old curl-based hook) and the
// notify script path (new Node-based hook) so upgrades are seamless.
const HOOK_MARKERS = ["STRIDETERM_NOTIFY_URL", "hooks/notify.mjs", "hooks\\notify.mjs"];

// Cross-platform Node.js script that reads stdin and POSTs to STRIDETERM_NOTIFY_URL.
// Written to ~/.strideterm/hooks/notify.mjs at runtime so the path is stable
// regardless of how strIDEterm is packaged (ASAR, binary, dev).
// Notify hook script — runs as a Claude Code Notification hook.
// Claude Code does NOT pass parent env vars to hook processes, only CLAUDE_*.
// So we resolve the notify URL from a file written by strideterm's runtime.
//
// Logs to ~/.strideterm/logs/hook.log (errors/warnings only, auto-truncated
// at 3MB for retention).  Successful delivery is visible in strideterm.log
// via notify-server entries — no need to log success here.
const NOTIFY_SCRIPT_CONTENT = `import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const LOG_PATH = path.join(os.homedir(), ".strideterm", "logs", "hook.log");
const LOG_MAX_BYTES = 3 * 1024 * 1024; // 3 MB
function log(level, msg) {
  try {
    const line = new Date().toISOString().replace("T", " ").replace("Z", "") + " " + level + "  [hook] " + msg + "\\n";
    // Simple retention: if over limit, start fresh (atomic — no partial read/write)
    try { if (fs.statSync(LOG_PATH).size > LOG_MAX_BYTES) fs.writeFileSync(LOG_PATH, ""); } catch {}
    fs.appendFileSync(LOG_PATH, line);
  } catch {}
}

const URLS_PATH = path.join(os.homedir(), ".strideterm", "hooks", "notify-urls.json");
const projectDir = process.env.CLAUDE_PROJECT_DIR || "";
let url = process.env.STRIDETERM_NOTIFY_URL || "";

let allUrls = url ? [url] : [];

if (allUrls.length === 0) {
  try {
    const mapping = JSON.parse(fs.readFileSync(URLS_PATH, "utf8"));
    const norm = (p) => p.replace(/\\\\\\\\/g, "/").replace(/\\\\/g, "/").toLowerCase();
    if (projectDir) {
      const key = norm(projectDir);
      const urls = mapping[key];
      if (Array.isArray(urls) && urls.length > 0) {
        allUrls = urls;
      }
    }
    // Fallback: CLAUDE_PROJECT_DIR missing or no match — POST to all URLs.
    // Server validates secret; only the matching session returns 200.
    if (allUrls.length === 0) {
      for (const urls of Object.values(mapping)) {
        if (Array.isArray(urls)) allUrls.push(...urls);
      }
      if (allUrls.length > 0) log("WARN", "no match for projectDir=" + projectDir + ", broadcasting to " + allUrls.length + " url(s)");
    }
  } catch (e) {
    log("ERROR", "cannot read " + URLS_PATH + ": " + e.message);
  }
}

if (allUrls.length === 0) {
  log("WARN", "no notify urls resolved (projectDir=" + projectDir + ")");
  process.exit(0);
}

let body = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { body += chunk; });
process.stdin.on("end", () => {
  let pending = allUrls.length;
  function done() { if (--pending <= 0) process.exit(0); }
  for (const u of allUrls) {
    let parsed;
    try { parsed = new URL(u); } catch (e) { log("ERROR", "invalid url: " + u); done(); continue; }
    const options = {
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname + parsed.search,
      method: "POST",
      headers: { "Content-Type": "application/json" },
      timeout: 4000,
    };
    const req = http.request(options, (res) => {
      if (res.statusCode !== 200 && res.statusCode !== 403) {
        log("WARN", "POST " + parsed.port + " -> " + res.statusCode);
      }
      done();
    });
    req.on("error", (e) => { log("ERROR", "POST failed: " + e.message); done(); });
    req.on("timeout", () => { log("ERROR", "POST timeout (4s)"); req.destroy(); done(); });
    req.end(body);
  }
});
process.stdin.resume();
`;

function getClaudeSettingsPath() {
  return path.join(os.homedir(), ".claude", "settings.json");
}

function getNotifyScriptPath(userDataPath) {
  return path.join(userDataPath, "hooks", "notify.mjs");
}

/**
 * Ensures the notify.mjs hook script exists at ~/.strideterm/hooks/notify.mjs.
 * Overwrites on every startup to keep it up to date.
 */
export async function ensureNotifyScript(userDataPath) {
  const scriptPath = getNotifyScriptPath(userDataPath);
  const dir = path.dirname(scriptPath);
  try {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    await fs.writeFile(scriptPath, NOTIFY_SCRIPT_CONTENT, "utf8");
    return { ok: true, path: scriptPath };
  } catch (error) {
    return { ok: false, path: scriptPath, error: error.message };
  }
}

/**
 * Reads and parses ~/.claude/settings.json.
 * Returns { ok, data, error } — data is null if file doesn't exist.
 */
async function readClaudeSettings() {
  const settingsPath = getClaudeSettingsPath();
  try {
    const raw = await fs.readFile(settingsPath, "utf8");
    const data = JSON.parse(raw);
    return { ok: true, data, path: settingsPath };
  } catch (error) {
    if (error.code === "ENOENT") {
      return { ok: true, data: null, path: settingsPath };
    }
    return { ok: false, data: null, path: settingsPath, error: error.message };
  }
}

/**
 * Writes settings to ~/.claude/settings.json atomically.
 */
async function writeClaudeSettings(data) {
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
    return { ok: false, error: error.message };
  }
}

/**
 * Builds the hook entry object for Claude Code settings.
 */
function buildHookEntry(notifyScriptPath) {
  // Normalize path separators to forward slashes for cross-platform shell compat
  const normalizedPath = notifyScriptPath.replace(/\\/g, "/");
  return {
    matcher: "",
    hooks: [
      {
        type: "command",
        command: `node "${normalizedPath}"`,
        timeout: 5,
      },
    ],
  };
}

/**
 * Checks if the strIDEterm hook is already configured.
 */
function findExistingHook(settings) {
  const entries = settings?.hooks?.Notification;
  if (!Array.isArray(entries)) return -1;
  return entries.findIndex(
    (entry) =>
      Array.isArray(entry?.hooks) &&
      entry.hooks.some(
        (h) => typeof h?.command === "string" && HOOK_MARKERS.some((marker) => h.command.includes(marker)),
      ),
  );
}

/**
 * Configure the Claude Code notification hook.
 *
 * - Creates ~/.claude/settings.json if it doesn't exist
 * - Merges with existing hooks (never overwrites unrelated config)
 * - Updates existing strIDEterm hook if found
 *
 * Returns { ok, error?, detail? }
 */
export async function configureClaudeHook(userDataPath) {
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

  // Step 3: merge hook into settings
  const settings = readResult.data || {};
  settings.hooks = settings.hooks || {};
  settings.hooks.Notification = settings.hooks.Notification || [];

  const hookEntry = buildHookEntry(scriptResult.path);
  const existingIndex = findExistingHook(settings);

  if (existingIndex >= 0) {
    settings.hooks.Notification[existingIndex] = hookEntry;
  } else {
    settings.hooks.Notification.push(hookEntry);
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

  log.info("claude hook configured", { scriptPath: scriptResult.path, settingsPath: readResult.path });
  return { ok: true, scriptPath: scriptResult.path, settingsPath: readResult.path };
}

/**
 * Remove the strIDEterm hook from Claude Code settings.
 * Leaves all other hooks and settings intact.
 *
 * Returns { ok, error?, removed? }
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
  const existingIndex = findExistingHook(settings);

  if (existingIndex < 0) {
    log.debug("removeClaudeHook: hook not found in settings");
    return { ok: true, removed: false };
  }

  settings.hooks.Notification.splice(existingIndex, 1);

  // Clean up empty arrays/objects
  if (settings.hooks.Notification.length === 0) {
    delete settings.hooks.Notification;
  }
  if (Object.keys(settings.hooks).length === 0) {
    delete settings.hooks;
  }

  const writeResult = await writeClaudeSettings(settings);
  if (!writeResult.ok) {
    log.warn("removeClaudeHook: failed to write settings", { path: readResult.path, err: writeResult.error });
    return { ok: false, error: `Failed to write ${readResult.path}: ${writeResult.error}` };
  }

  log.info("claude hook removed", { settingsPath: readResult.path });
  return { ok: true, removed: true };
}

/**
 * Detect current hook configuration status.
 *
 * Returns { status, scriptPath?, settingsPath?, error? }
 * - status: "configured" | "not-configured" | "error" | "script-missing"
 */
export async function detectClaudeHookStatus(userDataPath) {
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

  const hookIndex = findExistingHook(readResult.data);
  if (hookIndex < 0) {
    log.debug("detectClaudeHookStatus: hook not found in settings");
    return { status: "not-configured", settingsPath, scriptPath };
  }

  if (!scriptExists) {
    log.warn("detectClaudeHookStatus: hook configured but script missing", { scriptPath });
    return { status: "script-missing", settingsPath, scriptPath };
  }

  log.debug("detectClaudeHookStatus: hook configured", { settingsPath, scriptPath });
  return { status: "configured", settingsPath, scriptPath };
}

// For testing
export { getClaudeSettingsPath, getNotifyScriptPath, NOTIFY_SCRIPT_CONTENT, HOOK_MARKERS, findExistingHook };
