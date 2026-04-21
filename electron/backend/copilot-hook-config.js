import os from "node:os";
import path from "node:path";
import { readFile, writeFile, mkdir, rename, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { getLogger } from "./logger.js";
import { ensureNotifyScript } from "./claude-hook-config.js";

const log = getLogger("copilot-hook");

/**
 * Manages GitHub Copilot CLI notification hooks at user scope.
 *
 * Unlike Claude/Codex/Gemini, Copilot stores hooks directly in its main
 * settings file (`~/.copilot/config.json`) under a top-level `hooks` key.
 * Copilot's hook entry shape is flat — `{ type, bash, powershell, timeoutSec }`
 * with separate platform scripts — not the Claude-style nested
 * `{ matcher, hooks: [...] }` wrapper. Same notify.mjs script; same argv.
 *
 * Copilot's event names differ from Claude's, so we map them at install time:
 *   `userPromptSubmitted` → argv `UserPromptSubmit` (resets idle bookkeeping)
 *   `sessionEnd`          → argv `Stop`             (fires onAgentIdle)
 * This keeps notify.mjs / dispatcher.js provider-neutral.
 *
 * Config location is overridable via `COPILOT_HOME` (documented in
 * `copilot help environment`). We honor that so users with non-default dirs
 * get their hooks written to the right place.
 *
 * `disableAllHooks: true` in config.json is a user-facing kill-switch that
 * overrides all hook entries. We surface it as a distinct status so the
 * Settings dialog can warn before the user wonders why hooks don't fire.
 */

// Copilot event → argv passed to notify.mjs (Claude-compatible alias).
// `sessionEnd` is the task-runner signal; `userPromptSubmitted` resets idle.
// preToolUse/postToolUse are intentionally skipped — they'd flood (same
// rationale as Codex). sessionStart and errorOccurred have no consumer today.
export const COPILOT_HOOK_MAP = Object.freeze({
  sessionEnd: "Stop",
  userPromptSubmitted: "UserPromptSubmit",
});

export const HOOKS_TO_REGISTER = Object.freeze(Object.keys(COPILOT_HOOK_MAP));

// Markers identifying strIDEterm-installed hook entries so re-install replaces
// them in place without touching user-authored hooks.
const HOOK_MARKERS = Object.freeze(["hooks/notify.mjs", "hooks\\notify.mjs"]);

export function getCopilotHome() {
  return process.env.COPILOT_HOME || path.join(os.homedir(), ".copilot");
}

export function getCopilotConfigPath() {
  return path.join(getCopilotHome(), "config.json");
}

function getNotifyScriptPath(userDataPath) {
  return path.join(userDataPath, "hooks", "notify.mjs");
}

function buildCopilotHookEntry(notifyScriptPath, canonicalEventName) {
  const normalized = notifyScriptPath.replace(/\\/g, "/");
  // Copilot's flat schema: one entry = one command. Both `bash` and
  // `powershell` fields point at the same Node script — Node works identically
  // on both OSes, and Copilot picks the right one based on platform.
  // timeoutSec (seconds), not timeout (ms) — Copilot-specific.
  return {
    type: "command",
    bash: `node "${normalized}" ${canonicalEventName}`,
    powershell: `node "${normalized}" ${canonicalEventName}`,
    timeoutSec: 5,
  };
}

export function findExistingHook(config, copilotEventName) {
  const entries = config?.hooks?.[copilotEventName];
  if (!Array.isArray(entries)) return -1;
  return entries.findIndex((entry) => {
    if (typeof entry?.bash === "string" && HOOK_MARKERS.some((m) => entry.bash.includes(m))) return true;
    if (typeof entry?.powershell === "string" && HOOK_MARKERS.some((m) => entry.powershell.includes(m))) return true;
    return false;
  });
}

async function readCopilotConfig() {
  const configPath = getCopilotConfigPath();
  try {
    const raw = await readFile(configPath, "utf8");
    return { ok: true, data: JSON.parse(raw), path: configPath };
  } catch (error) {
    if (error.code === "ENOENT") return { ok: true, data: null, path: configPath };
    return { ok: false, error: error.message, path: configPath };
  }
}

async function writeCopilotConfig(data) {
  const configPath = getCopilotConfigPath();
  const dir = path.dirname(configPath);
  const tmpPath = configPath + ".strideterm-tmp";
  try {
    if (!existsSync(dir)) await mkdir(dir, { recursive: true });
    await writeFile(tmpPath, JSON.stringify(data, null, 2) + "\n", "utf8");
    await rename(tmpPath, configPath);
    return { ok: true };
  } catch (error) {
    await rm(tmpPath, { force: true }).catch(() => {});
    return { ok: false, error: error.message };
  }
}

/**
 * Configure GitHub Copilot CLI lifecycle hooks in ~/.copilot/config.json.
 *
 * - Ensures notify.mjs exists at <userDataPath>/hooks/notify.mjs
 * - Merges into config.json preserving unrelated keys (model, theme, etc.)
 * - Idempotent: re-running replaces existing strIDEterm entries
 *
 * Returns { ok, error?, detail?, scriptPath?, configPath?, registered?: string[] }
 */
export async function configureCopilotHook(userDataPath) {
  const scriptResult = await ensureNotifyScript(userDataPath);
  if (!scriptResult.ok) {
    return {
      ok: false,
      error: `Failed to write hook script: ${scriptResult.error}`,
      detail: "script-write-failed",
    };
  }

  const readResult = await readCopilotConfig();
  if (!readResult.ok) {
    return {
      ok: false,
      error: `Cannot read ${readResult.path}: ${readResult.error}. Check if the file contains valid JSON.`,
      detail: "config-read-failed",
    };
  }

  const config = readResult.data || {};
  config.hooks = config.hooks || {};

  const registered = [];
  for (const [copilotEvent, canonicalName] of Object.entries(COPILOT_HOOK_MAP)) {
    config.hooks[copilotEvent] = config.hooks[copilotEvent] || [];
    const entry = buildCopilotHookEntry(scriptResult.path, canonicalName);
    const idx = findExistingHook(config, copilotEvent);
    if (idx >= 0) config.hooks[copilotEvent][idx] = entry;
    else config.hooks[copilotEvent].push(entry);
    registered.push(copilotEvent);
  }

  const writeResult = await writeCopilotConfig(config);
  if (!writeResult.ok) {
    return {
      ok: false,
      error: `Failed to write ${readResult.path}: ${writeResult.error}`,
      detail: "config-write-failed",
    };
  }

  log.info("copilot hooks configured", {
    scriptPath: scriptResult.path,
    configPath: readResult.path,
    registered,
  });
  return {
    ok: true,
    scriptPath: scriptResult.path,
    configPath: readResult.path,
    settingsPath: readResult.path,
    registered,
  };
}

/**
 * Remove strIDEterm hook entries from ~/.copilot/config.json.
 * Leaves other top-level keys and user-authored hooks intact.
 */
export async function removeCopilotHook() {
  const readResult = await readCopilotConfig();
  if (!readResult.ok) {
    log.warn("removeCopilotHook: cannot read config", { path: readResult.path, err: readResult.error });
    return { ok: false, error: `Cannot read ${readResult.path}: ${readResult.error}` };
  }
  if (!readResult.data) {
    log.debug("removeCopilotHook: config file not found, nothing to remove");
    return { ok: true, removed: false };
  }

  const config = readResult.data;
  const removedFrom = [];
  const hookKeys = new Set([...HOOKS_TO_REGISTER, ...Object.keys(config.hooks || {})]);

  for (const eventName of hookKeys) {
    const idx = findExistingHook(config, eventName);
    if (idx < 0) continue;
    config.hooks[eventName].splice(idx, 1);
    removedFrom.push(eventName);
    if (config.hooks[eventName].length === 0) delete config.hooks[eventName];
  }

  if (removedFrom.length === 0) {
    log.debug("removeCopilotHook: no strIDEterm hooks found in config");
    return { ok: true, removed: false };
  }
  if (config.hooks && Object.keys(config.hooks).length === 0) delete config.hooks;

  const writeResult = await writeCopilotConfig(config);
  if (!writeResult.ok) {
    log.warn("removeCopilotHook: failed to write config", { path: readResult.path, err: writeResult.error });
    return { ok: false, error: `Failed to write ${readResult.path}: ${writeResult.error}` };
  }

  log.info("copilot hooks removed", { configPath: readResult.path, removedFrom });
  return { ok: true, removed: true, removedFrom };
}

/**
 * Detect current Copilot hook configuration status.
 *
 * status:
 *   "configured"              — all events registered, script exists, hooks enabled
 *   "partial"                 — some events registered, others missing
 *   "configured-but-disabled" — entries present but `disableAllHooks: true`
 *   "not-configured"          — no strIDEterm entries found
 *   "script-missing"          — entries present but notify.mjs missing
 *   "error"                   — IO/parse error
 */
export async function detectCopilotHookStatus(userDataPath) {
  const configPath = getCopilotConfigPath();
  const scriptPath = getNotifyScriptPath(userDataPath);
  const scriptExists = existsSync(scriptPath);

  const readResult = await readCopilotConfig();
  if (!readResult.ok) {
    log.debug("detectCopilotHookStatus: cannot read config", { err: readResult.error });
    return { status: "error", error: readResult.error, configPath, scriptPath };
  }
  if (!readResult.data) {
    return { status: "not-configured", configPath, scriptPath };
  }

  const registered = [];
  const missing = [];
  for (const event of HOOKS_TO_REGISTER) {
    const idx = findExistingHook(readResult.data, event);
    if (idx >= 0) registered.push(event);
    else missing.push(event);
  }

  if (registered.length === 0) {
    return { status: "not-configured", configPath, scriptPath };
  }
  if (!scriptExists) {
    log.warn("detectCopilotHookStatus: hooks configured but script missing", { scriptPath });
    return { status: "script-missing", configPath, scriptPath, registered, missingHooks: missing };
  }
  if (readResult.data.disableAllHooks === true) {
    return {
      status: "configured-but-disabled",
      configPath,
      scriptPath,
      registered,
      missingHooks: missing,
    };
  }
  if (missing.length > 0) {
    return { status: "partial", configPath, scriptPath, registered, missingHooks: missing };
  }
  return { status: "configured", configPath, scriptPath, registered };
}

export { HOOK_MARKERS };
