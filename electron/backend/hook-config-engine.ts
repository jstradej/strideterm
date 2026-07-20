/// <reference types="node" />
import path from "node:path";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";

/**
 * Shared engine for the per-provider agent-hook config files
 * (claude-hook-config.ts, codex-hook-config.ts, gemini-hook-config.ts,
 * opencode-hook-config.ts, copilot-hook-config.ts).
 *
 * Each provider stores its "strIDEterm hook" wiring in its own JSON(-ish)
 * config file, keyed by its own event names, with its own hook-entry shape.
 * What's identical across all five is the read/merge/write/find/detect
 * skeleton around that config file — this module factors that skeleton out.
 * Each provider supplies only its config path, event map (registration key
 * as stored under config.hooks[key] -> canonical hook name passed as argv[2]
 * to notify.mjs), entry shape, and marker-matching logic.
 */

// ---- Atomic write ----

/**
 * Atomic write: write to a temp file first, then rename over the target.
 * Throws on failure — callers decide how to report/clean up.
 */
export async function atomicWriteFile(filePath: string, data: string, tmpSuffix = ".strideterm-tmp"): Promise<void> {
  const tmpPath = `${filePath}${tmpSuffix}`;
  await fs.writeFile(tmpPath, data, "utf8");
  await fs.rename(tmpPath, filePath);
}

// ---- JSON config read/write ----

export interface ReadConfigResult {
  ok: boolean;
  data: Record<string, unknown> | null;
  path: string;
  error?: string;
}

export interface WriteConfigResult {
  ok: boolean;
  error?: string;
}

/**
 * Reads and parses a provider's config file.
 * Returns `{ ok: true, data: null }` if the file doesn't exist yet;
 * `{ ok: false, error }` for any other read/parse failure.
 */
export async function readJsonConfig(
  configPath: string,
  parse: (raw: string) => Record<string, unknown> = (raw) => JSON.parse(raw) as Record<string, unknown>,
): Promise<ReadConfigResult> {
  try {
    const raw = await fs.readFile(configPath, "utf8");
    return { ok: true, data: parse(raw), path: configPath };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ok: true, data: null, path: configPath };
    return { ok: false, data: null, error: (error as NodeJS.ErrnoException).message, path: configPath };
  }
}

/**
 * Writes a provider's config file atomically, creating its parent directory
 * if needed and cleaning up the temp file if the write/rename fails.
 */
export async function writeJsonConfig(configPath: string, data: Record<string, unknown>): Promise<WriteConfigResult> {
  const dir = path.dirname(configPath);
  const tmpPath = `${configPath}.strideterm-tmp`;
  try {
    if (!existsSync(dir)) await fs.mkdir(dir, { recursive: true });
    await atomicWriteFile(configPath, JSON.stringify(data, null, 2) + "\n");
    return { ok: true };
  } catch (error) {
    await fs.rm(tmpPath, { force: true }).catch(() => {});
    return { ok: false, error: (error as NodeJS.ErrnoException).message };
  }
}

// ---- Hook entry lookup ----

export type EntryMatcher = (entry: unknown, markers: readonly string[]) => boolean;

/**
 * Finds the index of a strIDEterm-installed hook entry within
 * `container.hooks[hookKey]`, using `matchesEntry` to recognize the shape.
 * Returns -1 if the section is missing/not an array, or nothing matches.
 */
export function findHookIndex(
  container: Record<string, unknown> | null | undefined,
  hookKey: string,
  markers: readonly string[],
  matchesEntry: EntryMatcher,
): number {
  const hooksSection = (container?.hooks as Record<string, unknown> | undefined)?.[hookKey];
  if (!Array.isArray(hooksSection)) return -1;
  return hooksSection.findIndex((entry: unknown) => matchesEntry(entry, markers));
}

/**
 * Shared entry-matcher for the Claude-style nested shape used by Claude,
 * Codex, and OpenCode: `{ matcher, hooks: [{ command, ... }] }`.
 */
export function matchesNestedCommandEntry(entry: unknown, markers: readonly string[]): boolean {
  const e = entry as Record<string, unknown>;
  return (
    Array.isArray(e?.hooks) &&
    (e.hooks as unknown[]).some(
      (h: unknown) =>
        typeof (h as Record<string, unknown>)?.command === "string" &&
        markers.some((m) => (h as Record<string, string>).command.includes(m)),
    )
  );
}

/**
 * Builds the shared nested hook-entry shape used by Claude, Codex, and
 * OpenCode. The hook/event name is passed as argv[2] so one notify.mjs
 * script handles every hook type.
 */
export function buildNestedCommandEntry(notifyScriptPath: string, canonicalName: string) {
  const normalized = notifyScriptPath.replace(/\\/g, "/");
  return {
    matcher: "",
    hooks: [
      {
        type: "command",
        command: `node "${normalized}" ${canonicalName}`,
        timeout: 5,
      },
    ],
  };
}

/** Path to the shared notify.mjs script, common to every provider. */
export function getNotifyScriptPath(userDataPath: string): string {
  return path.join(userDataPath, "hooks", "notify.mjs");
}

// ---- configure / remove / detect skeleton ----

export interface EntryShapeDescriptor {
  /** Markers identifying a strIDEterm-installed entry. */
  hookMarkers: readonly string[];
  /** Builds the hook entry object for a given canonical name. */
  buildEntry: (notifyScriptPath: string, canonicalName: string) => unknown;
  /** Recognizes a strIDEterm-installed entry. */
  matchesEntry: EntryMatcher;
  /** Optional custom parser (e.g. Copilot's JSONC config). Defaults to JSON.parse. */
  parseConfig?: (raw: string) => Record<string, unknown>;
}

export interface ConfigureResult {
  ok: boolean;
  error?: string;
  detail?: string;
  registered?: string[];
}

/**
 * Reads `configPath`, merges a hook entry for every [registrationKey,
 * canonicalName] pair in `eventMap` into `config.hooks[registrationKey]`
 * (replacing any existing strIDEterm entry in place, appending otherwise),
 * and writes the result back. Preserves every other key/hook already present.
 */
export async function configureHookEntries(
  configPath: string,
  eventMap: Record<string, string>,
  notifyScriptPath: string,
  descriptor: EntryShapeDescriptor & { readFailedDetail: string; writeFailedDetail: string },
): Promise<ConfigureResult> {
  const readResult = await readJsonConfig(configPath, descriptor.parseConfig);
  if (!readResult.ok) {
    return {
      ok: false,
      error: `Cannot read ${configPath}: ${readResult.error}. Check if the file contains valid JSON.`,
      detail: descriptor.readFailedDetail,
    };
  }

  const config = readResult.data || {};
  if (!config.hooks || typeof config.hooks !== "object") config.hooks = {};
  const hooksMap = config.hooks as Record<string, unknown[]>;

  const registered: string[] = [];
  for (const [registrationKey, canonicalName] of Object.entries(eventMap)) {
    if (!Array.isArray(hooksMap[registrationKey])) hooksMap[registrationKey] = [];
    const entry = descriptor.buildEntry(notifyScriptPath, canonicalName);
    const idx = findHookIndex(config, registrationKey, descriptor.hookMarkers, descriptor.matchesEntry);
    if (idx >= 0) hooksMap[registrationKey][idx] = entry;
    else hooksMap[registrationKey].push(entry);
    registered.push(registrationKey);
  }

  const writeResult = await writeJsonConfig(configPath, config);
  if (!writeResult.ok) {
    return {
      ok: false,
      error: `Failed to write ${configPath}: ${writeResult.error}`,
      detail: descriptor.writeFailedDetail,
    };
  }

  return { ok: true, registered };
}

export interface RemoveResult {
  ok: boolean;
  error?: string;
  removed?: boolean;
  removedFrom?: string[];
}

/**
 * Removes strIDEterm-installed entries from every hook category in
 * `configPath` — the categories in `registrationKeys` plus any other key
 * already present in `config.hooks` (so stale/legacy categories get cleaned
 * up too). Leaves every other hook/setting untouched.
 */
export async function removeHookEntries(
  configPath: string,
  registrationKeys: readonly string[],
  descriptor: Pick<EntryShapeDescriptor, "hookMarkers" | "matchesEntry" | "parseConfig">,
): Promise<RemoveResult> {
  const readResult = await readJsonConfig(configPath, descriptor.parseConfig);
  if (!readResult.ok) {
    return { ok: false, error: `Cannot read ${configPath}: ${readResult.error}` };
  }
  if (!readResult.data) {
    return { ok: true, removed: false };
  }

  const config = readResult.data;
  const removedFrom: string[] = [];
  const hooksMap = (config.hooks || {}) as Record<string, unknown[]>;
  const hookKeys = new Set([...registrationKeys, ...Object.keys(hooksMap)]);

  for (const key of hookKeys) {
    const idx = findHookIndex(config, key, descriptor.hookMarkers, descriptor.matchesEntry);
    if (idx < 0) continue;
    hooksMap[key].splice(idx, 1);
    removedFrom.push(key);
    if (hooksMap[key].length === 0) delete hooksMap[key];
  }

  if (removedFrom.length === 0) {
    return { ok: true, removed: false };
  }
  if (Object.keys(hooksMap).length === 0) delete config.hooks;

  const writeResult = await writeJsonConfig(configPath, config);
  if (!writeResult.ok) {
    return { ok: false, error: `Failed to write ${configPath}: ${writeResult.error}` };
  }

  return { ok: true, removed: true, removedFrom };
}

export interface DetectStatusResult {
  status: string;
  error?: string;
  registered?: string[];
  missingHooks?: string[];
}

/**
 * Detects strIDEterm hook configuration status for a provider's config file.
 *
 * Status precedence: "error" (read failure) -> "not-configured" (no file, or
 * no strIDEterm entries) -> "script-missing" (entries exist but notify.mjs is
 * gone) -> `extraCheck` result, if any (provider-specific — e.g. a disabled
 * feature flag) -> "partial" (some but not all events registered) ->
 * "configured".
 */
export async function detectHookEntriesStatus(
  configPath: string,
  scriptPath: string,
  eventMap: Record<string, string>,
  descriptor: Pick<EntryShapeDescriptor, "hookMarkers" | "matchesEntry" | "parseConfig"> & {
    extraCheck?: (
      data: Record<string, unknown>,
      ctx: { registered: string[]; missing: string[] },
    ) => Promise<{ status: string } | null> | ({ status: string } | null);
  },
): Promise<DetectStatusResult> {
  const scriptExists = existsSync(scriptPath);

  const readResult = await readJsonConfig(configPath, descriptor.parseConfig);
  if (!readResult.ok) {
    return { status: "error", error: readResult.error };
  }
  if (!readResult.data) {
    return { status: "not-configured" };
  }

  const registered: string[] = [];
  const missing: string[] = [];
  for (const key of Object.keys(eventMap)) {
    const idx = findHookIndex(readResult.data, key, descriptor.hookMarkers, descriptor.matchesEntry);
    if (idx >= 0) registered.push(key);
    else missing.push(key);
  }

  if (registered.length === 0) {
    return { status: "not-configured" };
  }
  if (!scriptExists) {
    return { status: "script-missing", registered, missingHooks: missing };
  }

  if (descriptor.extraCheck) {
    const extra = await descriptor.extraCheck(readResult.data, { registered, missing });
    if (extra) {
      return { registered, missingHooks: missing, status: extra.status };
    }
  }

  if (missing.length > 0) {
    return { status: "partial", registered, missingHooks: missing };
  }
  return { status: "configured", registered };
}
