/// <reference types="node" />
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { getLogger } from "./logger.js";
import {
  atomicWriteFile,
  matchesNestedCommandEntry,
  parseJsoncConfig,
  removeHookEntries,
} from "./hook-config-engine.js";

const log = getLogger("opencode-hook");

/**
 * Manages the OpenCode notification integration.
 *
 * OpenCode has NO `hooks` key in its config schema and validates the config
 * strictly — an unrecognized key makes it refuse to start entirely (#178).
 * Earlier strIDEterm versions wrote a Claude-style `hooks` block there, which
 * never fired and only broke the user's OpenCode; cleanupLegacyOpencodeHooks()
 * below strips it.
 *
 * The supported extension point is a native OpenCode *plugin*: a JS module in
 * the plugins directory, auto-loaded at startup, that subscribes to
 * `session.idle` (turn finished) and `chat.message` (user submitted a prompt).
 *
 * Plugin path: <XDG_CONFIG_HOME or ~/.config>/opencode/plugins/strideterm-notify.js
 *
 * Unlike Claude Code hooks — separate processes that inherit no parent env —
 * an OpenCode plugin runs inside the opencode process itself, so it reads
 * STRIDETERM_NOTIFY_URL straight from the PTY env strIDEterm injected. That
 * means no notify.mjs and no notify-urls.json lookup, and an opencode started
 * outside strIDEterm has no URL and stays silent.
 */

export const PLUGIN_FILENAME = "strideterm-notify.js";

// OpenCode event/hook names this plugin subscribes to, mapped to the canonical
// hook names the shared dispatcher understands (runtime.dispatchAgentHookEvent).
export const REGISTERED_EVENTS = Object.freeze(["session.idle", "chat.message"]);

// Markers identifying the Claude-style entries strIDEterm <= 2.4.20 wrote into
// the OpenCode config file, so cleanup only ever touches our own leftovers.
const LEGACY_HOOK_MARKERS = Object.freeze(["hooks/notify.mjs", "hooks\\notify.mjs"]);
const LEGACY_HOOK_KEYS = Object.freeze(["Stop", "UserPromptSubmit"]);

const PLUGIN_CONTENT = `// strIDEterm notification plugin for OpenCode.
// Installed and overwritten by strIDEterm — edits here are lost on the next
// "Configure OpenCode" (Settings -> Agent notification hooks).
//
// STRIDETERM_NOTIFY_URL is injected into every strIDEterm PTY session and
// inherited by the opencode process, so the plugin reports to exactly the tab
// that launched it. When the variable is absent this opencode was started
// outside strIDEterm and the plugin stays silent.

const NOTIFY_URL = process.env.STRIDETERM_NOTIFY_URL || "";

async function send(hook) {
  try {
    await fetch(NOTIFY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ hook, source: "opencode-plugin" }),
      signal: AbortSignal.timeout(2000),
    });
  } catch {
    // strIDEterm is closed or restarting — dropping the event is preferable to
    // surfacing an error inside the user's coding session.
  }
}

export const StridetermNotify = async () => {
  if (!NOTIFY_URL) return {};
  return {
    // Turn finished — the dispatcher treats this like Claude's Stop.
    event: async ({ event }) => {
      if (event?.type === "session.idle") await send("Stop");
    },
    // User submitted a prompt — resets idle bookkeeping, like UserPromptSubmit.
    "chat.message": async () => {
      await send("UserPromptSubmit");
    },
  };
};
`;

/**
 * OpenCode's global config directory.
 *
 * Verified against opencode 1.18.14 via `opencode debug paths`: the location is
 * XDG-style on EVERY platform, Windows included — $XDG_CONFIG_HOME/opencode,
 * falling back to ~/.config/opencode. There is no %APPDATA% variant (writing
 * there means writing somewhere opencode never reads), and OPENCODE_HOME is not
 * consulted for any path at all despite what earlier versions of this file and
 * the docs claimed.
 */
export function getOpencodeConfigDir(): string {
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "opencode");
}

export function getOpencodeConfigPath(): string {
  return path.join(getOpencodeConfigDir(), "config.json");
}

/**
 * Config files an older strIDEterm may have written its `hooks` block into.
 *
 * The current location, plus the two that versions <= 2.4.20 could target:
 * %APPDATA%\opencode\config.json on Windows, and $OPENCODE_HOME/config.json
 * when that variable happened to be set. Neither of those actually broke
 * anything (opencode reads neither), but both are litter strIDEterm created,
 * so cleanup takes them with it rather than leaving stray configs behind.
 */
function getLegacyConfigPaths(): string[] {
  const paths = [getOpencodeConfigPath()];
  const add = (candidate: string) => {
    if (!paths.includes(candidate)) paths.push(candidate);
  };
  if (process.platform === "win32") {
    add(path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "opencode", "config.json"));
  }
  if (process.env.OPENCODE_HOME) add(path.join(path.resolve(process.env.OPENCODE_HOME), "config.json"));
  return paths;
}

export function getOpencodePluginPath(): string {
  return path.join(getOpencodeConfigDir(), "plugins", PLUGIN_FILENAME);
}

/**
 * Strip the Claude-style `hooks` block older strIDEterm versions wrote into
 * the OpenCode config. OpenCode rejects the unrecognized key and refuses to
 * start, so this runs at startup too — a user whose OpenCode is already broken
 * can't be expected to find the Settings dialog first. Only entries carrying
 * our notify.mjs marker are removed, and `hooks` is dropped once empty.
 *
 * Parsed as JSONC: opencode writes its own config with a trailing comma
 * (`{ "$schema": "...", }` on 1.18.14), which strict JSON.parse rejects — and
 * bailing out on a parse error would strand exactly the users this heals.
 */
export async function cleanupLegacyOpencodeHooks(): Promise<{ ok: boolean; removed: boolean; cleaned: string[] }> {
  const cleaned: string[] = [];
  let ok = true;

  for (const configPath of getLegacyConfigPaths()) {
    const result = await removeHookEntries(configPath, LEGACY_HOOK_KEYS, {
      hookMarkers: LEGACY_HOOK_MARKERS,
      matchesEntry: matchesNestedCommandEntry,
      parseConfig: parseJsoncConfig,
    });

    if (!result.ok) {
      ok = false;
      log.warn("legacy opencode hooks cleanup failed", { configPath, err: result.error });
    } else if (result.removed) {
      cleaned.push(configPath);
      log.info("removed legacy opencode hooks block (OpenCode rejects it)", {
        configPath,
        removedFrom: result.removedFrom,
      });
    }
  }

  return { ok, removed: cleaned.length > 0, cleaned };
}

/**
 * Startup migration: clean up the legacy `hooks` block and, if this install
 * actually had one, carry the user's opt-in over to the plugin.
 *
 * Finding our own legacy entries proves the user once clicked "Configure
 * OpenCode". Cleaning up without reinstalling would silently drop a feature
 * they chose to enable and leave them with no idea why their notifications
 * stopped — so the mechanism is swapped, not the decision. Installs that never
 * had the legacy block are left completely untouched.
 */
export async function migrateLegacyOpencodeHooks(): Promise<{
  cleaned: string[];
  pluginInstalled: boolean;
  error?: string;
}> {
  const cleanup = await cleanupLegacyOpencodeHooks();
  if (!cleanup.removed) return { cleaned: [], pluginInstalled: false };

  const result = await configureOpencodeHook();
  if (!result.ok) {
    log.warn("legacy opencode hooks removed but plugin install failed", { err: result.error });
    return { cleaned: cleanup.cleaned, pluginInstalled: false, error: result.error };
  }

  log.info("migrated legacy opencode hooks to the native plugin", {
    cleaned: cleanup.cleaned,
    pluginPath: result.pluginPath,
  });
  return { cleaned: cleanup.cleaned, pluginInstalled: true };
}

/**
 * Install the strIDEterm OpenCode plugin.
 *
 * - Writes <opencode config dir>/plugins/strideterm-notify.js
 * - Removes the legacy `hooks` block that keeps OpenCode from starting
 * - Idempotent: the plugin file is overwritten in place
 *
 * Takes no arguments; the HOOK_PROVIDERS table passes userDataPath to every
 * provider's configure() and this one simply doesn't need it.
 */
export async function configureOpencodeHook(): Promise<{
  ok: boolean;
  error?: string;
  detail?: string;
  pluginPath?: string;
  configPath?: string;
  registered?: string[];
}> {
  const pluginPath = getOpencodePluginPath();
  try {
    await fs.mkdir(path.dirname(pluginPath), { recursive: true });
    await atomicWriteFile(pluginPath, PLUGIN_CONTENT);
  } catch (error) {
    return {
      ok: false,
      error: `Failed to write ${pluginPath}: ${(error as NodeJS.ErrnoException).message}`,
      detail: "plugin-write-failed",
    };
  }

  await cleanupLegacyOpencodeHooks();

  const configPath = getOpencodeConfigPath();
  log.info("opencode plugin installed", { pluginPath, registered: REGISTERED_EVENTS });
  return { ok: true, pluginPath, configPath, registered: [...REGISTERED_EVENTS] };
}

/**
 * Remove the strIDEterm plugin and any legacy hook entries.
 * Leaves all other OpenCode config and plugins intact.
 */
export async function removeOpencodeHook(): Promise<{
  ok: boolean;
  error?: string;
  removed?: boolean;
  pluginPath?: string;
}> {
  const pluginPath = getOpencodePluginPath();
  let pluginRemoved = false;
  try {
    await fs.unlink(pluginPath);
    pluginRemoved = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      log.warn("removeOpencodeHook: failed", { pluginPath, err: (error as NodeJS.ErrnoException).message });
      return { ok: false, error: `Failed to delete ${pluginPath}: ${(error as NodeJS.ErrnoException).message}` };
    }
  }

  const legacy = await cleanupLegacyOpencodeHooks();
  const removed = pluginRemoved || Boolean(legacy.removed);
  if (removed) log.info("opencode plugin removed", { pluginPath, pluginRemoved, legacy: legacy.removed });
  return { ok: true, removed, pluginPath };
}

/**
 * Detect current OpenCode plugin status.
 *
 * status:
 *   "configured"     — plugin installed and up to date
 *   "partial"        — plugin installed but written by an older strIDEterm
 *   "not-configured" — no plugin file
 *   "error"          — the plugin file exists but could not be read
 */
export async function detectOpencodeHookStatus(): Promise<{
  status: string;
  error?: string;
  registered?: string[];
  pluginPath: string;
  configPath: string;
}> {
  const pluginPath = getOpencodePluginPath();
  const configPath = getOpencodeConfigPath();

  let installed: string;
  try {
    installed = await fs.readFile(pluginPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { status: "not-configured", pluginPath, configPath };
    }
    return { status: "error", error: (error as NodeJS.ErrnoException).message, pluginPath, configPath };
  }

  if (installed !== PLUGIN_CONTENT) {
    return { status: "partial", registered: [...REGISTERED_EVENTS], pluginPath, configPath };
  }
  return { status: "configured", registered: [...REGISTERED_EVENTS], pluginPath, configPath };
}

// For testing
export { PLUGIN_CONTENT, LEGACY_HOOK_MARKERS };
