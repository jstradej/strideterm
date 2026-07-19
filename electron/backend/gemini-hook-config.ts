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
} from "./hook-config-engine.js";

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

export function getGeminiSettingsPath(): string {
  return path.join(os.homedir(), ".gemini", "settings.json");
}

function buildGeminiHookEntry(notifyScriptPath: string, claudeAlias: string) {
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

function matchesGeminiEntry(entry: unknown, markers: readonly string[]): boolean {
  const e = entry as Record<string, unknown>;
  // Current (nested) shape: { matcher, hooks: [{ command, ... }] }
  if (Array.isArray(e?.hooks)) {
    return (e.hooks as unknown[]).some(
      (h: unknown) =>
        typeof (h as Record<string, unknown>)?.command === "string" &&
        markers.some((m) => (h as Record<string, string>).command.includes(m)),
    );
  }
  // Legacy (flat) shape from earlier strIDEterm versions that used the wrong
  // format. Detect so upgrade replaces the stale entry in place.
  if (typeof e?.command === "string") {
    return markers.some((m) => (e.command as string).includes(m));
  }
  return false;
}

export function findExistingHook(settings: Record<string, unknown>, geminiEventName: string): number {
  return findHookIndex(settings, geminiEventName, HOOK_MARKERS, matchesGeminiEntry);
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
export async function configureGeminiHook(userDataPath: string): Promise<{
  ok: boolean;
  error?: string;
  detail?: string;
  scriptPath?: string;
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

  const settingsPath = getGeminiSettingsPath();
  const result = await configureHookEntries(settingsPath, GEMINI_HOOK_MAP, scriptResult.path, {
    hookMarkers: HOOK_MARKERS,
    buildEntry: buildGeminiHookEntry,
    matchesEntry: matchesGeminiEntry,
    readFailedDetail: "settings-read-failed",
    writeFailedDetail: "settings-write-failed",
  });
  if (!result.ok) return result;

  log.info("gemini hooks configured", {
    scriptPath: scriptResult.path,
    settingsPath,
    registered: result.registered,
  });
  return {
    ok: true,
    scriptPath: scriptResult.path,
    settingsPath,
    registered: result.registered,
  };
}

/**
 * Remove all strIDEterm hooks from Gemini CLI settings.
 * Leaves other hooks and settings intact.
 */
export async function removeGeminiHook() {
  const settingsPath = getGeminiSettingsPath();
  const result = await removeHookEntries(settingsPath, Object.keys(GEMINI_HOOK_MAP), {
    hookMarkers: HOOK_MARKERS,
    matchesEntry: matchesGeminiEntry,
  });

  if (!result.ok) {
    log.warn("removeGeminiHook: failed", { settingsPath, err: result.error });
  } else if (result.removed) {
    log.info("gemini hooks removed", { settingsPath, removedFrom: result.removedFrom });
  } else {
    log.debug("removeGeminiHook: no strIDEterm hooks found or settings missing");
  }
  return result;
}

/**
 * Detect current Gemini hook configuration status.
 *
 * Returns { status, scriptPath?, settingsPath?, error?, missingHooks?: string[], registered?: string[] }
 *   status: "configured" | "partial" | "not-configured" | "script-missing" | "error"
 *   "partial" means some but not all events are registered (upgrade available).
 */
export async function detectGeminiHookStatus(userDataPath: string) {
  const settingsPath = getGeminiSettingsPath();
  const scriptPath = getNotifyScriptPath(userDataPath);
  const result = await detectHookEntriesStatus(settingsPath, scriptPath, GEMINI_HOOK_MAP, {
    hookMarkers: HOOK_MARKERS,
    matchesEntry: matchesGeminiEntry,
  });
  return { ...result, settingsPath, scriptPath };
}

export { HOOK_MARKERS };
