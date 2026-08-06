/// <reference types="node" />
import os from "node:os";
import path from "node:path";
import { getLogger } from "./logger.js";
import { ensureNotifyScript } from "./claude-hook-config.js";
import {
  getNotifyScriptPath,
  findHookIndex,
  configureHookEntries,
  removeHookEntries,
  detectHookEntriesStatus,
  parseJsoncConfig,
} from "./hook-config-engine.js";

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

export function getCopilotHome(): string {
  return process.env.COPILOT_HOME || path.join(os.homedir(), ".copilot");
}

export function getCopilotConfigPath(): string {
  return path.join(getCopilotHome(), "config.json");
}

function buildCopilotHookEntry(notifyScriptPath: string, canonicalEventName: string) {
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

function matchesCopilotEntry(entry: unknown, markers: readonly string[]): boolean {
  const e = entry as Record<string, unknown>;
  if (typeof e?.bash === "string" && markers.some((m) => (e.bash as string).includes(m))) return true;
  if (typeof e?.powershell === "string" && markers.some((m) => (e.powershell as string).includes(m))) return true;
  return false;
}

export function findExistingHook(config: Record<string, unknown>, copilotEventName: string): number {
  return findHookIndex(config, copilotEventName, HOOK_MARKERS, matchesCopilotEntry);
}

// Copilot's config.json is JSONC — it ships with `// User settings ...`
// header comments and may pick up trailing commas, both of which JSON.parse
// rejects. Shared with the OpenCode module, whose config is JSONC too.
const parseCopilotConfig = parseJsoncConfig;

/**
 * Configure GitHub Copilot CLI lifecycle hooks in ~/.copilot/config.json.
 *
 * - Ensures notify.mjs exists at <userDataPath>/hooks/notify.mjs
 * - Merges into config.json preserving unrelated keys (model, theme, etc.)
 * - Idempotent: re-running replaces existing strIDEterm entries
 *
 * Returns { ok, error?, detail?, scriptPath?, configPath?, registered?: string[] }
 */
export async function configureCopilotHook(userDataPath: string): Promise<{
  ok: boolean;
  error?: string;
  detail?: string;
  scriptPath?: string;
  configPath?: string;
  settingsPath?: string;
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

  const configPath = getCopilotConfigPath();
  const result = await configureHookEntries(configPath, COPILOT_HOOK_MAP, scriptResult.path, {
    hookMarkers: HOOK_MARKERS,
    buildEntry: buildCopilotHookEntry,
    matchesEntry: matchesCopilotEntry,
    parseConfig: parseCopilotConfig,
    readFailedDetail: "config-read-failed",
    writeFailedDetail: "config-write-failed",
  });
  if (!result.ok) return result;

  log.info("copilot hooks configured", {
    scriptPath: scriptResult.path,
    configPath,
    registered: result.registered,
  });
  return {
    ok: true,
    scriptPath: scriptResult.path,
    configPath,
    settingsPath: configPath,
    registered: result.registered,
  };
}

/**
 * Remove strIDEterm hook entries from ~/.copilot/config.json.
 * Leaves other top-level keys and user-authored hooks intact.
 */
export async function removeCopilotHook() {
  const configPath = getCopilotConfigPath();
  const result = await removeHookEntries(configPath, HOOKS_TO_REGISTER, {
    hookMarkers: HOOK_MARKERS,
    matchesEntry: matchesCopilotEntry,
    parseConfig: parseCopilotConfig,
  });

  if (!result.ok) {
    log.warn("removeCopilotHook: failed", { configPath, err: result.error });
  } else if (result.removed) {
    log.info("copilot hooks removed", { configPath, removedFrom: result.removedFrom });
  } else {
    log.debug("removeCopilotHook: no strIDEterm hooks found or config missing");
  }
  return result;
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
export async function detectCopilotHookStatus(userDataPath: string) {
  const configPath = getCopilotConfigPath();
  const scriptPath = getNotifyScriptPath(userDataPath);
  const result = await detectHookEntriesStatus(configPath, scriptPath, COPILOT_HOOK_MAP, {
    hookMarkers: HOOK_MARKERS,
    matchesEntry: matchesCopilotEntry,
    parseConfig: parseCopilotConfig,
    extraCheck: (data) => (data.disableAllHooks === true ? { status: "configured-but-disabled" } : null),
  });
  return { ...result, configPath, scriptPath };
}

export { HOOK_MARKERS };
