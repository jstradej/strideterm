/// <reference types="node" />
import os from "node:os";
import path from "node:path";
import { getLogger } from "./logger.js";
import { ensureNotifyScript } from "./claude-hook-config.js";
import {
  matchesNestedCommandEntry,
  buildNestedCommandEntry,
  getNotifyScriptPath,
  findHookIndex,
  configureHookEntries,
  removeHookEntries,
  detectHookEntriesStatus,
} from "./hook-config-engine.js";

const log = getLogger("opencode-hook");

/**
 * Manages OpenCode CLI notification hooks at user scope.
 *
 * OpenCode stores its config in a platform-specific directory:
 *   Linux/macOS: ~/.config/opencode/config.json (XDG base dir)
 *   Windows:     %APPDATA%\opencode\config.json
 *
 * The OPENCODE_HOME env var overrides the config directory.
 *
 * Hook event names match Claude's for the events we register (Stop,
 * UserPromptSubmit), so no alias mapping is needed — argv[2] passes through
 * unchanged to the shared dispatcher (notify-server → runtime.dispatchAgentHookEvent).
 *
 * OpenCode sets CLAUDE_PROJECT_DIR as a compat env var so the shared
 * notify.mjs resolves the right notify URL without provider-specific branches.
 */

// Events to register — same as Codex; Stop drives taskState → evaluating and
// UserPromptSubmit resets idle bookkeeping in the notification pipeline.
export const HOOKS_TO_REGISTER = Object.freeze(["Stop", "UserPromptSubmit"]);
// Registration key === canonical hook name for OpenCode (no aliasing needed).
const OPENCODE_EVENT_MAP: Record<string, string> = Object.fromEntries(HOOKS_TO_REGISTER.map((h) => [h, h]));

const HOOK_MARKERS = Object.freeze(["hooks/notify.mjs", "hooks\\notify.mjs"]);

export function getOpencodeConfigDir(): string {
  if (process.env.OPENCODE_HOME) return path.resolve(process.env.OPENCODE_HOME);
  if (process.platform === "win32") {
    return path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "opencode");
  }
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "opencode");
}

export function getOpencodeConfigPath(): string {
  return path.join(getOpencodeConfigDir(), "config.json");
}

export function findExistingHook(settings: Record<string, unknown>, hookName: string): number {
  return findHookIndex(settings, hookName, HOOK_MARKERS, matchesNestedCommandEntry);
}

/**
 * Configure OpenCode CLI lifecycle hooks.
 *
 * - Writes notify.mjs to <userDataPath>/hooks/notify.mjs (shared with Claude/Gemini/Codex)
 * - Merges hook entries into the OpenCode config file (preserves user settings)
 * - Idempotent: re-running replaces existing strIDEterm entries
 */
export async function configureOpencodeHook(userDataPath: string): Promise<{
  ok: boolean;
  error?: string;
  detail?: string;
  scriptPath?: string;
  configPath?: string;
  registered?: string[];
}> {
  const scriptResult = await ensureNotifyScript(userDataPath);
  if (!scriptResult.ok) {
    return {
      ok: false,
      error: `Failed to write hook script: ${scriptResult.error}`,
      detail: "script-write-failed",
    };
  }

  const configPath = getOpencodeConfigPath();
  const result = await configureHookEntries(configPath, OPENCODE_EVENT_MAP, scriptResult.path, {
    hookMarkers: HOOK_MARKERS,
    buildEntry: buildNestedCommandEntry,
    matchesEntry: matchesNestedCommandEntry,
    readFailedDetail: "settings-read-failed",
    writeFailedDetail: "settings-write-failed",
  });
  if (!result.ok) return result;

  log.info("opencode hooks configured", {
    scriptPath: scriptResult.path,
    configPath,
    registered: result.registered,
  });
  return {
    ok: true,
    scriptPath: scriptResult.path,
    configPath,
    registered: result.registered,
  };
}

/**
 * Remove strIDEterm hook entries from the OpenCode config file.
 * Leaves all other settings intact.
 */
export async function removeOpencodeHook() {
  const configPath = getOpencodeConfigPath();
  const result = await removeHookEntries(configPath, HOOKS_TO_REGISTER, {
    hookMarkers: HOOK_MARKERS,
    matchesEntry: matchesNestedCommandEntry,
  });

  if (!result.ok) {
    log.warn("removeOpencodeHook: failed", { configPath, err: result.error });
  } else if (result.removed) {
    log.info("opencode hooks removed", { configPath, removedFrom: result.removedFrom });
  } else {
    log.debug("removeOpencodeHook: no strIDEterm hooks found or config missing");
  }
  return result;
}

/**
 * Detect current OpenCode hook configuration status.
 *
 * status:
 *   "configured"     — hooks registered and script exists
 *   "partial"        — some hooks registered but not all
 *   "script-missing" — hooks registered but notify.mjs is gone
 *   "not-configured" — no strIDEterm entries in config
 *   "error"          — could not read config (parse error etc.)
 */
export async function detectOpencodeHookStatus(userDataPath: string) {
  const configPath = getOpencodeConfigPath();
  const scriptPath = getNotifyScriptPath(userDataPath);
  const result = await detectHookEntriesStatus(configPath, scriptPath, OPENCODE_EVENT_MAP, {
    hookMarkers: HOOK_MARKERS,
    matchesEntry: matchesNestedCommandEntry,
  });
  return { ...result, configPath, scriptPath };
}

export { HOOK_MARKERS };
