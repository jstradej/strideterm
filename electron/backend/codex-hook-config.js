import os from "node:os";
import path from "node:path";
import { readFile, writeFile, mkdir, rename, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { getLogger } from "./logger.js";
import { ensureNotifyScript } from "./claude-hook-config.js";

const log = getLogger("codex-hook");

/**
 * Manages Codex CLI notification hooks at user scope.
 *
 * Codex stores config in two files:
 *   ~/.codex/config.toml  — must contain [features] codex_hooks = true to load hooks
 *   ~/.codex/hooks.json   — hook definitions (same nested shape as Claude)
 *
 * Codex hooks were gated off on Windows until PR #17268 (merged 2026-04-09),
 * shipped in Codex CLI v0.121.0. strIDEterm requires that version or newer on
 * Windows; older versions will accept the config but not fire hooks.
 *
 * Codex's hook payload on stdin includes `hook_event_name` and `cwd`, so the
 * shared notify.mjs resolves notify URLs by matching payload.cwd against the
 * workspace cwds registered in notify-urls.json. Codex runs that fire outside
 * any registered workspace are dropped, so external `codex` invocations do
 * not leak notifications into strIDEterm.
 *
 * Codex's event names match Claude's for the events we care about (Stop,
 * UserPromptSubmit), so no alias mapping is needed — argv[2] is passed through
 * to the dispatcher unchanged.
 */

// Events we register. Codex supports: SessionStart, PreToolUse, PostToolUse,
// UserPromptSubmit, Stop. For strIDEterm task runner and notifications we only
// need Stop (fires onAgentIdle) and UserPromptSubmit (resets idle bookkeeping).
// PreToolUse/PostToolUse only fire for Bash today and would flood; skip.
// SessionStart has no strIDEterm consumer; skip.
export const HOOKS_TO_REGISTER = Object.freeze(["Stop", "UserPromptSubmit"]);

const HOOK_MARKERS = Object.freeze(["hooks/notify.mjs", "hooks\\notify.mjs"]);

export function getCodexConfigPath() {
  return path.join(os.homedir(), ".codex", "config.toml");
}

export function getCodexHooksPath() {
  return path.join(os.homedir(), ".codex", "hooks.json");
}

function getNotifyScriptPath(userDataPath) {
  return path.join(userDataPath, "hooks", "notify.mjs");
}

function buildCodexHookEntry(notifyScriptPath, hookName) {
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

export function findExistingHook(settings, hookName) {
  const entries = settings?.hooks?.[hookName];
  if (!Array.isArray(entries)) return -1;
  return entries.findIndex(
    (entry) =>
      Array.isArray(entry?.hooks) &&
      entry.hooks.some((h) => typeof h?.command === "string" && HOOK_MARKERS.some((m) => h.command.includes(m))),
  );
}

async function readHooksJson() {
  const hooksPath = getCodexHooksPath();
  try {
    const raw = await readFile(hooksPath, "utf8");
    return { ok: true, data: JSON.parse(raw), path: hooksPath };
  } catch (error) {
    if (error.code === "ENOENT") return { ok: true, data: null, path: hooksPath };
    return { ok: false, error: error.message, path: hooksPath };
  }
}

async function writeHooksJson(data) {
  const hooksPath = getCodexHooksPath();
  const dir = path.dirname(hooksPath);
  const tmpPath = hooksPath + ".strideterm-tmp";
  try {
    if (!existsSync(dir)) await mkdir(dir, { recursive: true });
    await writeFile(tmpPath, JSON.stringify(data, null, 2) + "\n", "utf8");
    await rename(tmpPath, hooksPath);
    return { ok: true };
  } catch (error) {
    await rm(tmpPath, { force: true }).catch(() => {});
    return { ok: false, error: error.message };
  }
}

/**
 * Minimalist TOML mutation for the single `codex_hooks` feature flag.
 *
 * Handles three cases:
 *   1. Flag already present and true  → no-op
 *   2. Flag present with different value  → replace the line
 *   3. [features] section missing  → append new section at end
 *   4. [features] exists, flag missing  → add line immediately after section header
 *
 * Uses text-based handling instead of a TOML parser because we only ever touch
 * this one key; a full round-trip TOML parser would rewrite user comments and
 * formatting we want to preserve.
 */
export async function ensureCodexHooksFeatureFlag() {
  const configPath = getCodexConfigPath();
  let raw = "";
  try {
    raw = await readFile(configPath, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") return { ok: false, error: error.message, path: configPath };
  }

  // Work with LF-normalized text for regex consistency; re-emit as UTF-8 LF.
  const content = raw.replace(/\r\n/g, "\n");

  if (/(^|\n)codex_hooks\s*=\s*true(\s|$)/.test(content)) {
    return { ok: true, changed: false, path: configPath };
  }

  let updated;
  if (/(^|\n)codex_hooks\s*=/.test(content)) {
    // Existing flag (maybe false) — replace
    updated = content.replace(/(^|\n)codex_hooks\s*=[^\n]*/, "$1codex_hooks = true");
  } else if (/(^|\n)\[features\][ \t]*(\r?\n|$)/.test(content)) {
    // [features] section exists — insert flag after its header
    updated = content.replace(/(^|\n)(\[features\][ \t]*\n)/, "$1$2codex_hooks = true\n");
  } else {
    // No [features] section — append
    const sep = content && !content.endsWith("\n") ? "\n" : "";
    updated = content + sep + (content ? "\n" : "") + "[features]\ncodex_hooks = true\n";
  }

  const dir = path.dirname(configPath);
  const tmpPath = configPath + ".strideterm-tmp";
  try {
    if (!existsSync(dir)) await mkdir(dir, { recursive: true });
    await writeFile(tmpPath, updated, "utf8");
    await rename(tmpPath, configPath);
    return { ok: true, changed: true, path: configPath };
  } catch (error) {
    await rm(tmpPath, { force: true }).catch(() => {});
    return { ok: false, error: error.message, path: configPath };
  }
}

/**
 * Check if the codex_hooks feature flag is currently enabled in config.toml.
 * Returns true if `codex_hooks = true` is present anywhere in the file.
 */
export async function isCodexHooksFeatureFlagEnabled() {
  try {
    const raw = await readFile(getCodexConfigPath(), "utf8");
    return /(^|\n)codex_hooks\s*=\s*true(\s|$)/.test(raw.replace(/\r\n/g, "\n"));
  } catch {
    return false;
  }
}

/**
 * Configure Codex CLI lifecycle hooks.
 *
 * - Writes notify.mjs to <userDataPath>/hooks/notify.mjs (shared with Claude/Gemini)
 * - Enables [features] codex_hooks = true in ~/.codex/config.toml (preserves other keys)
 * - Merges hook entries into ~/.codex/hooks.json (preserves user hooks)
 * - Idempotent: re-running replaces existing strIDEterm entries
 */
export async function configureCodexHook(userDataPath) {
  const scriptResult = await ensureNotifyScript(userDataPath);
  if (!scriptResult.ok) {
    return {
      ok: false,
      error: `Failed to write hook script: ${scriptResult.error}`,
      detail: "script-write-failed",
    };
  }

  const flagResult = await ensureCodexHooksFeatureFlag();
  if (!flagResult.ok) {
    return {
      ok: false,
      error: `Failed to write ${flagResult.path}: ${flagResult.error}`,
      detail: "config-write-failed",
    };
  }

  const readResult = await readHooksJson();
  if (!readResult.ok) {
    return {
      ok: false,
      error: `Cannot read ${readResult.path}: ${readResult.error}. Check if the file contains valid JSON.`,
      detail: "hooks-read-failed",
    };
  }

  const hooks = readResult.data || {};
  hooks.hooks = hooks.hooks || {};

  const registered = [];
  for (const hookName of HOOKS_TO_REGISTER) {
    hooks.hooks[hookName] = hooks.hooks[hookName] || [];
    const entry = buildCodexHookEntry(scriptResult.path, hookName);
    const idx = findExistingHook(hooks, hookName);
    if (idx >= 0) hooks.hooks[hookName][idx] = entry;
    else hooks.hooks[hookName].push(entry);
    registered.push(hookName);
  }

  const writeResult = await writeHooksJson(hooks);
  if (!writeResult.ok) {
    return {
      ok: false,
      error: `Failed to write ${readResult.path}: ${writeResult.error}`,
      detail: "hooks-write-failed",
    };
  }

  log.info("codex hooks configured", {
    scriptPath: scriptResult.path,
    configPath: flagResult.path,
    hooksPath: readResult.path,
    featureFlagChanged: flagResult.changed,
    registered,
  });
  return {
    ok: true,
    scriptPath: scriptResult.path,
    configPath: flagResult.path,
    hooksPath: readResult.path,
    registered,
  };
}

/**
 * Remove strIDEterm hook entries from ~/.codex/hooks.json.
 * The codex_hooks feature flag in config.toml is left alone — the user may
 * have their own hooks that rely on it.
 */
export async function removeCodexHook() {
  const readResult = await readHooksJson();
  if (!readResult.ok) {
    log.warn("removeCodexHook: cannot read hooks", { path: readResult.path, err: readResult.error });
    return { ok: false, error: `Cannot read ${readResult.path}: ${readResult.error}` };
  }
  if (!readResult.data) {
    log.debug("removeCodexHook: hooks file not found, nothing to remove");
    return { ok: true, removed: false };
  }

  const hooks = readResult.data;
  const removedFrom = [];
  const hookKeys = new Set([...HOOKS_TO_REGISTER, ...Object.keys(hooks.hooks || {})]);

  for (const hookName of hookKeys) {
    const idx = findExistingHook(hooks, hookName);
    if (idx < 0) continue;
    hooks.hooks[hookName].splice(idx, 1);
    removedFrom.push(hookName);
    if (hooks.hooks[hookName].length === 0) delete hooks.hooks[hookName];
  }

  if (removedFrom.length === 0) {
    log.debug("removeCodexHook: no strIDEterm hooks found in hooks.json");
    return { ok: true, removed: false };
  }
  if (hooks.hooks && Object.keys(hooks.hooks).length === 0) delete hooks.hooks;

  const writeResult = await writeHooksJson(hooks);
  if (!writeResult.ok) {
    log.warn("removeCodexHook: failed to write hooks", { path: readResult.path, err: writeResult.error });
    return { ok: false, error: `Failed to write ${readResult.path}: ${writeResult.error}` };
  }

  log.info("codex hooks removed", { hooksPath: readResult.path, removedFrom });
  return { ok: true, removed: true, removedFrom };
}

/**
 * Detect current Codex hook configuration status.
 *
 * status:
 *   "configured"     — flag set, hooks registered, script exists
 *   "partial"        — some hooks registered but not all
 *   "flag-missing"   — hooks registered but codex_hooks feature flag is not true
 *   "script-missing" — config looks right but notify.mjs is gone
 *   "not-configured" — no strIDEterm entries in hooks.json
 *   "error"          — could not read hooks.json (parse error etc.)
 */
export async function detectCodexHookStatus(userDataPath) {
  const configPath = getCodexConfigPath();
  const hooksPath = getCodexHooksPath();
  const scriptPath = getNotifyScriptPath(userDataPath);
  const scriptExists = existsSync(scriptPath);

  const readResult = await readHooksJson();
  if (!readResult.ok) {
    return { status: "error", error: readResult.error, configPath, hooksPath, scriptPath };
  }
  if (!readResult.data) {
    return { status: "not-configured", configPath, hooksPath, scriptPath };
  }

  const registered = [];
  const missing = [];
  for (const event of HOOKS_TO_REGISTER) {
    const idx = findExistingHook(readResult.data, event);
    if (idx >= 0) registered.push(event);
    else missing.push(event);
  }

  if (registered.length === 0) {
    return { status: "not-configured", configPath, hooksPath, scriptPath };
  }
  if (!scriptExists) {
    return { status: "script-missing", configPath, hooksPath, scriptPath, registered, missingHooks: missing };
  }

  const flagEnabled = await isCodexHooksFeatureFlagEnabled();
  if (!flagEnabled) {
    return {
      status: "flag-missing",
      configPath,
      hooksPath,
      scriptPath,
      registered,
      missingHooks: missing,
    };
  }

  if (missing.length > 0) {
    return { status: "partial", configPath, hooksPath, scriptPath, registered, missingHooks: missing };
  }
  return { status: "configured", configPath, hooksPath, scriptPath, registered };
}

export { HOOK_MARKERS };
