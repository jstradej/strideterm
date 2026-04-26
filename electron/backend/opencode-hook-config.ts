/// <reference types="node" />
import os from "node:os";
import path from "node:path";
import { readFile, writeFile, mkdir, rename, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { getLogger } from "./logger.js";
import { ensureNotifyScript } from "./claude-hook-config.js";

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

function getNotifyScriptPath(userDataPath: string): string {
  return path.join(userDataPath, "hooks", "notify.mjs");
}

function buildOpencodeHookEntry(notifyScriptPath: string, hookName: string) {
  const normalized = notifyScriptPath.replace(/\\/g, "/");
  return {
    matcher: "",
    hooks: [
      {
        type: "command",
        command: `node "${normalized}" ${hookName}`,
        timeout: 5,
      },
    ],
  };
}

export function findExistingHook(settings: Record<string, unknown>, hookName: string): number {
  const hooksSection = (settings?.hooks as Record<string, unknown> | undefined)?.[hookName];
  if (!Array.isArray(hooksSection)) return -1;
  return hooksSection.findIndex(
    (entry: unknown) =>
      Array.isArray((entry as Record<string, unknown>)?.hooks) &&
      ((entry as Record<string, unknown>).hooks as unknown[]).some(
        (h: unknown) =>
          typeof (h as Record<string, unknown>)?.command === "string" &&
          HOOK_MARKERS.some((m) => (h as Record<string, string>).command.includes(m)),
      ),
  );
}

async function readOpencodeConfig(): Promise<{
  ok: boolean;
  data: Record<string, unknown> | null;
  path: string;
  error?: string;
}> {
  const configPath = getOpencodeConfigPath();
  try {
    const raw = await readFile(configPath, "utf8");
    return { ok: true, data: JSON.parse(raw) as Record<string, unknown>, path: configPath };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ok: true, data: null, path: configPath };
    return { ok: false, data: null, error: (error as NodeJS.ErrnoException).message, path: configPath };
  }
}

async function writeOpencodeConfig(data: Record<string, unknown>): Promise<{ ok: boolean; error?: string }> {
  const configPath = getOpencodeConfigPath();
  const dir = path.dirname(configPath);
  const tmpPath = configPath + ".strideterm-tmp";
  try {
    if (!existsSync(dir)) await mkdir(dir, { recursive: true });
    await writeFile(tmpPath, JSON.stringify(data, null, 2) + "\n", "utf8");
    await rename(tmpPath, configPath);
    return { ok: true };
  } catch (error) {
    await rm(tmpPath, { force: true }).catch(() => {});
    return { ok: false, error: (error as NodeJS.ErrnoException).message };
  }
}

/**
 * Configure OpenCode CLI lifecycle hooks.
 *
 * - Writes notify.mjs to <userDataPath>/hooks/notify.mjs (shared with Claude/Gemini/Codex)
 * - Merges hook entries into the OpenCode config file (preserves user settings)
 * - Idempotent: re-running replaces existing strIDEterm entries
 */
export async function configureOpencodeHook(userDataPath: string) {
  const scriptResult = await ensureNotifyScript(userDataPath);
  if (!scriptResult.ok) {
    return {
      ok: false,
      error: `Failed to write hook script: ${scriptResult.error}`,
      detail: "script-write-failed",
    };
  }

  const readResult = await readOpencodeConfig();
  if (!readResult.ok) {
    return {
      ok: false,
      error: `Cannot read ${readResult.path}: ${readResult.error}. Check if the file contains valid JSON.`,
      detail: "settings-read-failed",
    };
  }

  const config = readResult.data || {};
  if (!config.hooks || typeof config.hooks !== "object") config.hooks = {};
  const hooksMap = config.hooks as Record<string, unknown[]>;

  const registered: string[] = [];
  for (const hookName of HOOKS_TO_REGISTER) {
    if (!Array.isArray(hooksMap[hookName])) hooksMap[hookName] = [];
    const entry = buildOpencodeHookEntry(scriptResult.path, hookName);
    const idx = findExistingHook(config, hookName);
    if (idx >= 0) hooksMap[hookName][idx] = entry;
    else hooksMap[hookName].push(entry);
    registered.push(hookName);
  }

  const writeResult = await writeOpencodeConfig(config);
  if (!writeResult.ok) {
    return {
      ok: false,
      error: `Failed to write ${readResult.path}: ${writeResult.error}`,
      detail: "settings-write-failed",
    };
  }

  log.info("opencode hooks configured", {
    scriptPath: scriptResult.path,
    configPath: readResult.path,
    registered,
  });
  return {
    ok: true,
    scriptPath: scriptResult.path,
    configPath: readResult.path,
    registered,
  };
}

/**
 * Remove strIDEterm hook entries from the OpenCode config file.
 * Leaves all other settings intact.
 */
export async function removeOpencodeHook() {
  const readResult = await readOpencodeConfig();
  if (!readResult.ok) {
    log.warn("removeOpencodeHook: cannot read config", { path: readResult.path, err: readResult.error });
    return { ok: false, error: `Cannot read ${readResult.path}: ${readResult.error}` };
  }
  if (!readResult.data) {
    log.debug("removeOpencodeHook: config file not found, nothing to remove");
    return { ok: true, removed: false };
  }

  const config = readResult.data;
  const removedFrom: string[] = [];
  const hooksMap = (config.hooks || {}) as Record<string, unknown[]>;
  const hookKeys = new Set([...HOOKS_TO_REGISTER, ...Object.keys(hooksMap)]);

  for (const hookName of hookKeys) {
    const idx = findExistingHook(config, hookName);
    if (idx < 0) continue;
    hooksMap[hookName].splice(idx, 1);
    removedFrom.push(hookName);
    if (hooksMap[hookName].length === 0) delete hooksMap[hookName];
  }

  if (removedFrom.length === 0) {
    log.debug("removeOpencodeHook: no strIDEterm hooks found in config");
    return { ok: true, removed: false };
  }
  if (Object.keys(hooksMap).length === 0) delete config.hooks;

  const writeResult = await writeOpencodeConfig(config);
  if (!writeResult.ok) {
    log.warn("removeOpencodeHook: failed to write config", { path: readResult.path, err: writeResult.error });
    return { ok: false, error: `Failed to write ${readResult.path}: ${writeResult.error}` };
  }

  log.info("opencode hooks removed", { configPath: readResult.path, removedFrom });
  return { ok: true, removed: true, removedFrom };
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
  const scriptExists = existsSync(scriptPath);

  const readResult = await readOpencodeConfig();
  if (!readResult.ok) {
    log.debug("detectOpencodeHookStatus: cannot read config", { err: readResult.error });
    return { status: "error", error: readResult.error, configPath, scriptPath };
  }
  if (!readResult.data) {
    return { status: "not-configured", configPath, scriptPath };
  }

  const registered: string[] = [];
  const missing: string[] = [];
  for (const event of HOOKS_TO_REGISTER) {
    const idx = findExistingHook(readResult.data, event);
    if (idx >= 0) registered.push(event);
    else missing.push(event);
  }

  if (registered.length === 0) {
    return { status: "not-configured", configPath, scriptPath };
  }
  if (!scriptExists) {
    return { status: "script-missing", configPath, scriptPath, registered, missingHooks: missing };
  }
  if (missing.length > 0) {
    return { status: "partial", configPath, scriptPath, registered, missingHooks: missing };
  }
  return { status: "configured", configPath, scriptPath, registered };
}

export { HOOK_MARKERS };
