/// <reference types="node" />
import os from "node:os";
import path from "node:path";
import { readFile, mkdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
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
  atomicWriteFile,
} from "./hook-config-engine.js";

const log = getLogger("codex-hook");

/**
 * Manages Codex CLI notification hooks at user scope.
 *
 * Codex stores config in two files:
 *   ~/.codex/config.toml  — must contain [features] hooks = true to load hooks
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
// Registration key === canonical hook name for Codex (no aliasing needed).
const CODEX_EVENT_MAP: Record<string, string> = Object.fromEntries(HOOKS_TO_REGISTER.map((h) => [h, h]));

const HOOK_MARKERS = Object.freeze(["hooks/notify.mjs", "hooks\\notify.mjs"]);

export function getCodexConfigPath(): string {
  return path.join(os.homedir(), ".codex", "config.toml");
}

export function getCodexHooksPath(): string {
  return path.join(os.homedir(), ".codex", "hooks.json");
}

export function findExistingHook(settings: Record<string, unknown>, hookName: string): number {
  return findHookIndex(settings, hookName, HOOK_MARKERS, matchesNestedCommandEntry);
}

function findFeaturesSection(content: string): { bodyStart: number; bodyEnd: number; body: string } | null {
  const header = /(^|\n)\[features\][ \t]*(?:\n|$)/.exec(content);
  if (!header) return null;

  const bodyStart = header.index + header[0].length;
  const nextSection = /\n\[[^\]\n]+\]/g;
  nextSection.lastIndex = bodyStart;
  const next = nextSection.exec(content);
  const bodyEnd = next ? next.index : content.length;
  return {
    bodyStart,
    bodyEnd,
    body: content.slice(bodyStart, bodyEnd),
  };
}

function hasFeatureFlag(body: string, flagName: "hooks" | "codex_hooks", expectedTrue?: boolean): boolean {
  const line = body.split("\n").find((candidate) => {
    const equalIndex = candidate.indexOf("=");
    if (equalIndex < 0) return false;
    return candidate.slice(0, equalIndex).trim() === flagName;
  });
  if (!line) return false;
  if (expectedTrue === undefined) return true;
  const rawValue = line.slice(line.indexOf("=") + 1);
  const commentIndex = rawValue.indexOf("#");
  const value = commentIndex >= 0 ? rawValue.slice(0, commentIndex) : rawValue;
  return value.trim().toLowerCase() === "true";
}

/**
 * Minimalist TOML mutation for the single Codex hooks feature flag.
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
    if ((error as NodeJS.ErrnoException).code !== "ENOENT")
      return { ok: false, error: (error as NodeJS.ErrnoException).message, path: configPath };
  }

  // Work with LF-normalized text for regex consistency; re-emit as UTF-8 LF.
  const content = raw.replace(/\r\n/g, "\n");

  const section = findFeaturesSection(content);
  if (section && hasFeatureFlag(section.body, "hooks", true) && !hasFeatureFlag(section.body, "codex_hooks")) {
    return { ok: true, changed: false, path: configPath };
  }

  let updated;
  if (section) {
    const sectionPrefix = content.slice(0, section.bodyStart);
    const before = sectionPrefix.endsWith("\n") ? sectionPrefix : `${sectionPrefix}\n`;
    const after = content.slice(section.bodyEnd);
    let body = section.body.replace(/(^|\n)[ \t]*codex_hooks\s*=[^\n]*(?=\n|$)/g, "$1");
    if (hasFeatureFlag(body, "hooks")) {
      body = body.replace(/(^|\n)[ \t]*hooks\s*=[^\n]*/, "$1hooks = true");
    } else {
      body = `hooks = true\n${body}`;
    }
    updated = `${before}${body}${after}`;
  } else {
    // No [features] section — append
    const sep = content && !content.endsWith("\n") ? "\n" : "";
    updated = content + sep + (content ? "\n" : "") + "[features]\nhooks = true\n";
  }

  const dir = path.dirname(configPath);
  const tmpPath = `${configPath}.strideterm-tmp`;
  try {
    if (!existsSync(dir)) await mkdir(dir, { recursive: true });
    await atomicWriteFile(configPath, updated);
    return { ok: true, changed: true, path: configPath };
  } catch (error) {
    await rm(tmpPath, { force: true }).catch(() => {});
    return { ok: false, error: (error as NodeJS.ErrnoException).message, path: configPath };
  }
}

/**
 * Check if Codex hooks are currently enabled in config.toml.
 * Returns true for the current `hooks = true` flag and the legacy
 * `codex_hooks = true` flag so old installs remain detectable.
 */
export async function isCodexHooksFeatureFlagEnabled(): Promise<boolean> {
  try {
    const raw = await readFile(getCodexConfigPath(), "utf8");
    const section = findFeaturesSection(raw.replace(/\r\n/g, "\n"));
    return (
      !!section && (hasFeatureFlag(section.body, "hooks", true) || hasFeatureFlag(section.body, "codex_hooks", true))
    );
  } catch {
    return false;
  }
}

async function isCurrentCodexHooksFeatureFlagEnabled(): Promise<boolean> {
  try {
    const raw = await readFile(getCodexConfigPath(), "utf8");
    const section = findFeaturesSection(raw.replace(/\r\n/g, "\n"));
    return !!section && hasFeatureFlag(section.body, "hooks", true);
  } catch {
    return false;
  }
}

/**
 * Configure Codex CLI lifecycle hooks.
 *
 * - Writes notify.mjs to <userDataPath>/hooks/notify.mjs (shared with Claude/Gemini)
 * - Enables [features] hooks = true in ~/.codex/config.toml (preserves other keys)
 * - Merges hook entries into ~/.codex/hooks.json (preserves user hooks)
 * - Idempotent: re-running replaces existing strIDEterm entries
 */
export async function configureCodexHook(userDataPath: string): Promise<{
  ok: boolean;
  error?: string;
  detail?: string;
  scriptPath?: string;
  configPath?: string;
  hooksPath?: string;
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

  const flagResult = await ensureCodexHooksFeatureFlag();
  if (!flagResult.ok) {
    return {
      ok: false,
      error: `Failed to write ${flagResult.path}: ${flagResult.error}`,
      detail: "config-write-failed",
    };
  }

  const hooksPath = getCodexHooksPath();
  const result = await configureHookEntries(hooksPath, CODEX_EVENT_MAP, scriptResult.path, {
    hookMarkers: HOOK_MARKERS,
    buildEntry: buildNestedCommandEntry,
    matchesEntry: matchesNestedCommandEntry,
    readFailedDetail: "hooks-read-failed",
    writeFailedDetail: "hooks-write-failed",
  });
  if (!result.ok) return result;

  log.info("codex hooks configured", {
    scriptPath: scriptResult.path,
    configPath: flagResult.path,
    hooksPath,
    featureFlagChanged: flagResult.changed,
    registered: result.registered,
  });
  return {
    ok: true,
    scriptPath: scriptResult.path,
    configPath: flagResult.path,
    hooksPath,
    registered: result.registered,
  };
}

/**
 * Remove strIDEterm hook entries from ~/.codex/hooks.json.
 * The hooks feature flag in config.toml is left alone — the user may
 * have their own hooks that rely on it.
 */
export async function removeCodexHook() {
  const hooksPath = getCodexHooksPath();
  const result = await removeHookEntries(hooksPath, HOOKS_TO_REGISTER, {
    hookMarkers: HOOK_MARKERS,
    matchesEntry: matchesNestedCommandEntry,
  });

  if (!result.ok) {
    log.warn("removeCodexHook: failed", { hooksPath, err: result.error });
  } else if (result.removed) {
    log.info("codex hooks removed", { hooksPath, removedFrom: result.removedFrom });
  } else {
    log.debug("removeCodexHook: no strIDEterm hooks found or hooks.json missing");
  }
  return result;
}

/**
 * Detect current Codex hook configuration status.
 *
 * status:
 *   "configured"     — flag set, hooks registered, script exists
 *   "partial"        — some hooks registered but not all
 *   "flag-missing"   — hooks registered but the current hooks feature flag is not true
 *   "script-missing" — config looks right but notify.mjs is gone
 *   "not-configured" — no strIDEterm entries in hooks.json
 *   "error"          — could not read hooks.json (parse error etc.)
 */
export async function detectCodexHookStatus(userDataPath: string) {
  const configPath = getCodexConfigPath();
  const hooksPath = getCodexHooksPath();
  const scriptPath = getNotifyScriptPath(userDataPath);

  const result = await detectHookEntriesStatus(hooksPath, scriptPath, CODEX_EVENT_MAP, {
    hookMarkers: HOOK_MARKERS,
    matchesEntry: matchesNestedCommandEntry,
    extraCheck: async () => ((await isCurrentCodexHooksFeatureFlagEnabled()) ? null : { status: "flag-missing" }),
  });
  return { ...result, configPath, hooksPath, scriptPath };
}

export { HOOK_MARKERS };
