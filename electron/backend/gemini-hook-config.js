import os from "node:os";
import path from "node:path";
import { readFile, writeFile, mkdir, rename, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { getLogger } from "./logger.js";
import { ensureNotifyScript } from "./claude-hook-config.js";

const log = getLogger("gemini-hook");

/**
 * Manages Gemini CLI notification hooks in the user-level settings file
 * (~/.gemini/settings.json).
 *
 * Rationale: Gemini lifecycle hooks configured at user scope fire for every
 * Gemini session regardless of cwd, so both task runs and regular workspace
 * terminals get notification events. Project-scoped hooks (in <cwd>/.gemini/…)
 * would require writing into every project the user opens and trigger
 * Gemini's "untrusted hook" fingerprint warning on first run.
 *
 * Gemini event names are mapped onto Claude-compatible aliases at configure
 * time — the argv[2] passed to notify.mjs is the Claude alias — so the
 * downstream dispatcher (notify-server → runtime.dispatchAgentHookEvent →
 * agent-task-runner.onHookEvent) works without Gemini-specific branches.
 *
 * Gemini sets CLAUDE_PROJECT_DIR as a compat alias for GEMINI_PROJECT_DIR, so
 * the shared notify.mjs resolves the right notify URL unchanged.
 */

// Gemini event → Claude alias (passed as argv[2] to notify.mjs).
// AfterAgent fires when the agent loop ends — analogous to Claude's Stop and
// drives `taskState → evaluating` in the task runner.
// BeforeAgent fires after the user submits a prompt, before planning — maps
// to UserPromptSubmit which resets idle bookkeeping.
export const GEMINI_HOOK_MAP = Object.freeze({
  AfterAgent: "Stop",
  Notification: "Notification",
  BeforeAgent: "UserPromptSubmit",
});

// Markers identifying strIDEterm-installed hook entries so we can find+replace
// them on upgrade without duplicating or touching the user's own hooks.
const HOOK_MARKERS = Object.freeze(["hooks/notify.mjs", "hooks\\notify.mjs"]);

export function getGeminiSettingsPath() {
  return path.join(os.homedir(), ".gemini", "settings.json");
}

function getNotifyScriptPath(userDataPath) {
  return path.join(userDataPath, "hooks", "notify.mjs");
}

function buildGeminiHookEntry(notifyScriptPath, claudeAlias) {
  const normalized = notifyScriptPath.replace(/\\/g, "/");
  // Gemini CLI expects the Claude-compatible nested shape: matcher wrapper +
  // inner hooks array. AfterAgent only honors "*" for the matcher (all other
  // values are rejected silently), and Stop/UserPromptSubmit-equivalents ignore
  // matcher anyway, so "*" is the safe universal value.
  return {
    matcher: "*",
    hooks: [
      {
        name: `strideterm-${claudeAlias}`,
        type: "command",
        command: `node "${normalized}" ${claudeAlias}`,
        timeout: 5000,
      },
    ],
  };
}

export function findExistingHook(settings, geminiEventName) {
  const entries = settings?.hooks?.[geminiEventName];
  if (!Array.isArray(entries)) return -1;
  return entries.findIndex((entry) => {
    // Current (nested) shape: { matcher, hooks: [{ command, ... }] }
    if (Array.isArray(entry?.hooks)) {
      return entry.hooks.some((h) => typeof h?.command === "string" && HOOK_MARKERS.some((m) => h.command.includes(m)));
    }
    // Legacy (flat) shape from earlier strIDEterm versions that used the wrong
    // format. Detect so upgrade replaces the stale entry in place.
    if (typeof entry?.command === "string") {
      return HOOK_MARKERS.some((m) => entry.command.includes(m));
    }
    return false;
  });
}

async function readGeminiSettings() {
  const settingsPath = getGeminiSettingsPath();
  try {
    const raw = await readFile(settingsPath, "utf8");
    const data = JSON.parse(raw);
    return { ok: true, data, path: settingsPath };
  } catch (error) {
    if (error.code === "ENOENT") return { ok: true, data: null, path: settingsPath };
    return { ok: false, error: error.message, path: settingsPath };
  }
}

async function writeGeminiSettings(data) {
  const settingsPath = getGeminiSettingsPath();
  const dir = path.dirname(settingsPath);
  const tmpPath = settingsPath + ".strideterm-tmp";
  try {
    if (!existsSync(dir)) await mkdir(dir, { recursive: true });
    await writeFile(tmpPath, JSON.stringify(data, null, 2) + "\n", "utf8");
    await rename(tmpPath, settingsPath);
    return { ok: true };
  } catch (error) {
    await rm(tmpPath, { force: true }).catch(() => {});
    return { ok: false, error: error.message };
  }
}

/**
 * Configure Gemini CLI lifecycle hooks in ~/.gemini/settings.json.
 *
 * - Ensures notify.mjs exists at <userDataPath>/hooks/notify.mjs
 * - Merges with existing settings (preserves MCP servers, extensions, user hooks)
 * - Idempotent: re-running replaces existing strIDEterm entries
 *
 * Returns { ok, error?, detail?, scriptPath?, settingsPath?, registered?: string[] }
 */
export async function configureGeminiHook(userDataPath) {
  const scriptResult = await ensureNotifyScript(userDataPath);
  if (!scriptResult.ok) {
    return {
      ok: false,
      error: `Failed to write hook script: ${scriptResult.error}`,
      detail: "script-write-failed",
    };
  }

  const readResult = await readGeminiSettings();
  if (!readResult.ok) {
    return {
      ok: false,
      error: `Cannot read ${readResult.path}: ${readResult.error}. Check if the file contains valid JSON.`,
      detail: "settings-read-failed",
    };
  }

  const settings = readResult.data || {};
  settings.hooks = settings.hooks || {};

  const registered = [];
  for (const [geminiEvent, claudeAlias] of Object.entries(GEMINI_HOOK_MAP)) {
    settings.hooks[geminiEvent] = settings.hooks[geminiEvent] || [];
    const entry = buildGeminiHookEntry(scriptResult.path, claudeAlias);
    const idx = findExistingHook(settings, geminiEvent);
    if (idx >= 0) settings.hooks[geminiEvent][idx] = entry;
    else settings.hooks[geminiEvent].push(entry);
    registered.push(geminiEvent);
  }

  const writeResult = await writeGeminiSettings(settings);
  if (!writeResult.ok) {
    return {
      ok: false,
      error: `Failed to write ${readResult.path}: ${writeResult.error}`,
      detail: "settings-write-failed",
    };
  }

  log.info("gemini hooks configured", {
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
 * Remove all strIDEterm hooks from Gemini CLI settings.
 * Leaves other hooks and settings intact.
 */
export async function removeGeminiHook() {
  const readResult = await readGeminiSettings();
  if (!readResult.ok) {
    log.warn("removeGeminiHook: cannot read settings", { path: readResult.path, err: readResult.error });
    return { ok: false, error: `Cannot read ${readResult.path}: ${readResult.error}` };
  }
  if (!readResult.data) {
    log.debug("removeGeminiHook: settings file not found, nothing to remove");
    return { ok: true, removed: false };
  }

  const settings = readResult.data;
  const removedFrom = [];
  const hookKeys = new Set([...Object.keys(GEMINI_HOOK_MAP), ...Object.keys(settings.hooks || {})]);

  for (const hookName of hookKeys) {
    const idx = findExistingHook(settings, hookName);
    if (idx < 0) continue;
    settings.hooks[hookName].splice(idx, 1);
    removedFrom.push(hookName);
    if (settings.hooks[hookName].length === 0) delete settings.hooks[hookName];
  }

  if (removedFrom.length === 0) {
    log.debug("removeGeminiHook: no strIDEterm hooks found in settings");
    return { ok: true, removed: false };
  }

  if (settings.hooks && Object.keys(settings.hooks).length === 0) delete settings.hooks;

  const writeResult = await writeGeminiSettings(settings);
  if (!writeResult.ok) {
    log.warn("removeGeminiHook: failed to write settings", { path: readResult.path, err: writeResult.error });
    return { ok: false, error: `Failed to write ${readResult.path}: ${writeResult.error}` };
  }

  log.info("gemini hooks removed", { settingsPath: readResult.path, removedFrom });
  return { ok: true, removed: true, removedFrom };
}

/**
 * Detect current Gemini hook configuration status.
 *
 * Returns { status, scriptPath?, settingsPath?, error?, missingHooks?: string[], registered?: string[] }
 *   status: "configured" | "partial" | "not-configured" | "script-missing" | "error"
 *   "partial" means some but not all events are registered (upgrade available).
 */
export async function detectGeminiHookStatus(userDataPath) {
  const settingsPath = getGeminiSettingsPath();
  const scriptPath = getNotifyScriptPath(userDataPath);
  const scriptExists = existsSync(scriptPath);

  const readResult = await readGeminiSettings();
  if (!readResult.ok) {
    log.debug("detectGeminiHookStatus: cannot read settings", { err: readResult.error });
    return { status: "error", error: readResult.error, settingsPath, scriptPath };
  }
  if (!readResult.data) {
    return { status: "not-configured", settingsPath, scriptPath };
  }

  const registered = [];
  const missing = [];
  for (const event of Object.keys(GEMINI_HOOK_MAP)) {
    const idx = findExistingHook(readResult.data, event);
    if (idx >= 0) registered.push(event);
    else missing.push(event);
  }

  if (registered.length === 0) {
    return { status: "not-configured", settingsPath, scriptPath };
  }
  if (!scriptExists) {
    log.warn("detectGeminiHookStatus: hooks configured but script missing", { scriptPath });
    return { status: "script-missing", settingsPath, scriptPath, registered, missingHooks: missing };
  }
  if (missing.length > 0) {
    return { status: "partial", settingsPath, scriptPath, registered, missingHooks: missing };
  }
  return { status: "configured", settingsPath, scriptPath, registered };
}

export { HOOK_MARKERS };
