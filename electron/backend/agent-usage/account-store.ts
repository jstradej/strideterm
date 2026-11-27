import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentUsage, UsageWindow } from "../../shared/agent-usage.js";

const FILE_NAME = "usage-accounts.json";
const MAX_PROFILES = 8;
const MAX_HISTORY = 8;
const MAX_WINDOWS = 16;
const MAX_LABEL = 80;
const MAX_PATH = 2048;
const MAX_FILE_BYTES = 256 * 1024;
const SNAPSHOT_WRITE_INTERVAL_MS = 60_000;
const VALID_PROVIDERS = new Set(["claude", "codex"]);

interface StoredProfile {
  id: string;
  provider: "claude" | "codex";
  directory: string;
}

export interface UsageAccountSnapshot {
  id: string;
  label: string;
  status: "last-seen";
  checkedAt: number;
  windows: UsageWindow[];
}

interface StoredSnapshot extends UsageAccountSnapshot {
  provider: "claude" | "codex";
}

interface StoreState {
  version: 1;
  profiles: StoredProfile[];
  history: StoredSnapshot[];
}

function emptyState(): StoreState {
  return { version: 1, profiles: [], history: [] };
}

function safeText(value: unknown, max = MAX_LABEL): string {
  if (typeof value !== "string") return "";
  return value
    .replace(/[\r\n\t\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function expandedDirectory(directory: string): string {
  const expanded =
    directory === "~"
      ? os.homedir()
      : directory.startsWith(`~${path.sep}`)
        ? path.join(os.homedir(), directory.slice(2))
        : directory;
  return path.resolve(expanded);
}

function canonicalDirectory(directory: string): string {
  let resolved = expandedDirectory(directory);
  try {
    resolved = fs.realpathSync.native(resolved);
  } catch {
    // Keep the normalized absolute path when the target is unavailable.
  }
  return process.platform === "win32" ? resolved.toLocaleLowerCase("en-US") : resolved;
}

function defaultDirectory(provider: "claude" | "codex"): string {
  const override = provider === "claude" ? process.env.CLAUDE_CONFIG_DIR : process.env.CODEX_HOME;
  return path.resolve(override || path.join(os.homedir(), provider === "claude" ? ".claude" : ".codex"));
}

function providerFiles(provider: "claude" | "codex"): string[] {
  return provider === "claude"
    ? [".credentials.json", ".claude.json", "settings.json", "config.json"]
    : ["auth.json", "config.toml"];
}

function hasProviderFootprint(provider: "claude" | "codex", directory: string): boolean {
  for (const name of providerFiles(provider)) {
    try {
      const info = fs.statSync(path.join(directory, name));
      if (info.isFile() && info.size > 0) return true;
    } catch {
      // A missing or unreadable candidate is not evidence of a configured account.
    }
  }
  return false;
}

/** Read-only check used before probing a saved provider context. */
export function isUsageProfileDirectory(provider: "claude" | "codex", directory: string): boolean {
  if (!VALID_PROVIDERS.has(provider) || typeof directory !== "string" || !directory.trim()) return false;
  const resolved = canonicalDirectory(directory);
  // The home-wide .claude.json is shared metadata, not an independently signed-in CLI directory.
  if (resolved === canonicalDirectory(os.homedir())) return false;
  try {
    if (!fs.statSync(resolved).isDirectory()) return false;
  } catch {
    return false;
  }
  return hasProviderFootprint(provider, resolved);
}

function normalizeWindow(value: unknown): UsageWindow | undefined {
  if (!value || typeof value !== "object") return undefined;
  const source = value as Record<string, unknown>;
  if (typeof source.usedPercent !== "number" || !Number.isFinite(source.usedPercent)) return undefined;
  if (source.usedPercent < 0 || source.usedPercent > 100) return undefined;
  const label = safeText(source.label, 48);
  if (!label) return undefined;
  const durationMinutes =
    typeof source.durationMinutes === "number" &&
    Number.isSafeInteger(source.durationMinutes) &&
    source.durationMinutes > 0
      ? Math.min(source.durationMinutes, 525600)
      : undefined;
  const resetsAt =
    typeof source.resetsAt === "number" && Number.isFinite(source.resetsAt) && source.resetsAt > 0
      ? Math.min(source.resetsAt, 8.64e15)
      : undefined;
  const scope = safeText(source.scope, 48) || undefined;
  return {
    label,
    usedPercent: source.usedPercent,
    ...(source.rounded === true ? { rounded: true } : {}),
    ...(durationMinutes === undefined ? {} : { durationMinutes }),
    ...(scope === undefined ? {} : { scope }),
    ...(resetsAt === undefined ? {} : { resetsAt }),
  };
}

function parseState(raw: string): StoreState {
  try {
    const value = JSON.parse(raw) as Partial<StoreState>;
    if (value.version !== 1) return emptyState();
    const profiles: StoredProfile[] = [];
    for (const rawProfile of Array.isArray(value.profiles) ? value.profiles : []) {
      if (!rawProfile || typeof rawProfile !== "object") continue;
      const item = rawProfile as Partial<StoredProfile>;
      if (
        typeof item.id !== "string" ||
        !/^[a-f0-9]{24}$/.test(item.id) ||
        !VALID_PROVIDERS.has(item.provider as string) ||
        typeof item.directory !== "string" ||
        item.directory.length > MAX_PATH ||
        !path.isAbsolute(item.directory) ||
        profiles.length >= MAX_PROFILES
      )
        continue;
      profiles.push({ id: item.id, provider: item.provider as StoredProfile["provider"], directory: item.directory });
    }
    const history: StoredSnapshot[] = [];
    for (const rawSnapshot of Array.isArray(value.history) ? value.history : []) {
      if (!rawSnapshot || typeof rawSnapshot !== "object") continue;
      const item = rawSnapshot as Partial<StoredSnapshot>;
      if (
        typeof item.id !== "string" ||
        !/^(?:[a-f0-9]{64}|codex:[a-f0-9]{64}|[a-z0-9_-]{1,128})$/i.test(item.id) ||
        !VALID_PROVIDERS.has(item.provider as string) ||
        item.status !== "last-seen" ||
        typeof item.checkedAt !== "number" ||
        !Number.isFinite(item.checkedAt) ||
        item.checkedAt <= 0 ||
        !Array.isArray(item.windows) ||
        history.length >= MAX_HISTORY
      )
        continue;
      const windows = item.windows
        .slice(0, MAX_WINDOWS)
        .map(normalizeWindow)
        .filter((window): window is UsageWindow => Boolean(window));
      if (!windows.length) continue;
      history.push({
        id: item.id,
        provider: item.provider as StoredSnapshot["provider"],
        label: safeText(item.label) || "Account",
        status: "last-seen",
        checkedAt: item.checkedAt,
        windows,
      });
    }
    return { version: 1, profiles, history };
  } catch {
    return emptyState();
  }
}

/** A separate, private registry for explicitly selected local CLI contexts. */
export function createUsageAccountStore(dataDir: string) {
  const filePath = path.join(dataDir, FILE_NAME);
  const profiles = new Map<string, StoredProfile>();
  const snapshots = new Map<string, StoredSnapshot>();
  let loaded = false;
  let changed = false;

  function load(): void {
    if (loaded) return;
    loaded = true;
    // The public API is synchronous. Runtime calls this factory after its async boot phase;
    // loading is completed lazily through a synchronous read only for this small local registry.
    try {
      if (fs.statSync(filePath).size > MAX_FILE_BYTES) return;
      const raw = fs.readFileSync(filePath, "utf8");
      const state = parseState(raw);
      for (const item of state.profiles) profiles.set(item.id, item);
      for (const item of state.history) snapshots.set(item.id, item);
    } catch {
      // The registry is optional; a missing or malformed file starts empty.
    }
  }

  function persist(): void {
    if (!changed) return;
    const state: StoreState = {
      version: 1,
      profiles: [...profiles.values()].slice(0, MAX_PROFILES),
      history: [...snapshots.values()].sort((a, b) => b.checkedAt - a.checkedAt).slice(0, MAX_HISTORY),
    };
    const tempPath = `${filePath}.tmp-${process.pid}-${randomUUID()}`;
    try {
      fs.mkdirSync(dataDir, { recursive: true });
      const handle = fs.openSync(tempPath, "w", 0o600);
      try {
        fs.writeFileSync(handle, JSON.stringify(state), "utf8");
        fs.fsyncSync(handle);
      } finally {
        fs.closeSync(handle);
      }
      fs.renameSync(tempPath, filePath);
      try {
        fs.chmodSync(filePath, 0o600);
      } catch {
        // Windows does not implement POSIX file mode bits.
      }
      changed = false;
    } catch {
      throw new Error("Could not save usage account settings.");
    } finally {
      // Do not leave identity/quota data in a temporary file after a failed
      // write or rename. After a successful rename this is a harmless no-op.
      try {
        fs.rmSync(tempPath, { force: true });
      } catch {
        // Preserve the original persistence error; the registry is optional.
      }
    }
  }

  function mutate(operation: () => void): void {
    const previousProfiles = new Map(profiles);
    const previousSnapshots = new Map(snapshots);
    const wasChanged = changed;
    try {
      operation();
      persist();
    } catch (error) {
      profiles.clear();
      snapshots.clear();
      for (const [id, item] of previousProfiles) profiles.set(id, item);
      for (const [id, item] of previousSnapshots) snapshots.set(id, item);
      changed = wasChanged;
      throw error;
    }
  }

  return {
    listProfiles(): { id: string; provider: "claude" | "codex"; directory: string }[] {
      load();
      return [...profiles.values()].map(({ id, provider, directory }) => ({ id, provider, directory }));
    },

    addProfile(provider: "claude" | "codex", directory: string): void {
      load();
      if (
        !VALID_PROVIDERS.has(provider) ||
        typeof directory !== "string" ||
        !directory.trim() ||
        directory.length > MAX_PATH
      )
        throw new Error("Choose a valid provider config directory.");
      const storedDirectory = expandedDirectory(directory.trim());
      const resolved = canonicalDirectory(storedDirectory);
      if (resolved === canonicalDirectory(defaultDirectory(provider))) {
        throw new Error("This folder is already shown as the default CLI account.");
      }
      const same = [...profiles.values()].some(
        (profile) => profile.provider === provider && canonicalDirectory(profile.directory) === resolved,
      );
      if (same) return;
      if (profiles.size >= MAX_PROFILES) throw new Error("The maximum number of usage profiles has been reached.");
      if (!isUsageProfileDirectory(provider, resolved)) {
        throw new Error("That directory has no existing configuration for this provider.");
      }
      const id = createHash("sha256").update(`${provider}\0${resolved}`).digest("hex").slice(0, 24);
      mutate(() => {
        profiles.set(id, { id, provider, directory: storedDirectory });
        changed = true;
      });
    },

    removeProfile(id: string): void {
      load();
      if (!profiles.has(id) && !snapshots.has(id)) return;
      mutate(() => {
        profiles.delete(id);
        snapshots.delete(id);
        changed = true;
      });
    },

    observe(provider: "claude" | "codex", reading: AgentUsage & { account?: { label: string; key: string } }): void {
      load();
      const account = reading?.account;
      if (
        !VALID_PROVIDERS.has(provider) ||
        reading.provider !== provider ||
        reading.unavailable ||
        !account ||
        typeof account.key !== "string" ||
        !account.key ||
        !Array.isArray(reading.windows) ||
        reading.windows.length === 0
      )
        return;
      const checkedAt = Number.isFinite(reading.checkedAt) ? reading.checkedAt : Date.now();
      const id = account.key;
      const existing = snapshots.get(id);
      const windows = Array.isArray(reading.windows)
        ? reading.windows
            .slice(0, MAX_WINDOWS)
            .map(normalizeWindow)
            .filter((item): item is UsageWindow => Boolean(item))
        : [];
      const label =
        safeText(account.label) || existing?.label || `${provider === "claude" ? "Claude" : "Codex"} account`;
      if (
        existing &&
        existing.provider === provider &&
        existing.label === label &&
        JSON.stringify(existing.windows) === JSON.stringify(windows) &&
        Math.abs(checkedAt - existing.checkedAt) < SNAPSHOT_WRITE_INTERVAL_MS
      )
        return;
      mutate(() => {
        snapshots.delete(id);
        snapshots.set(id, { id, provider, label, status: "last-seen", checkedAt, windows });
        while (snapshots.size > MAX_HISTORY) {
          const oldest = [...snapshots.values()].reduce((a, b) => (a.checkedAt <= b.checkedAt ? a : b));
          snapshots.delete(oldest.id);
        }
        changed = true;
      });
    },

    history(provider?: "claude" | "codex"): UsageAccountSnapshot[] {
      load();
      return [...snapshots.values()]
        .filter((item) => provider === undefined || item.provider === provider)
        .sort((a, b) => b.checkedAt - a.checkedAt)
        .map(({ id, label, status, checkedAt, windows }) => ({
          id,
          label,
          status,
          checkedAt,
          windows: windows.map((window) => ({ ...window })),
        }));
    },
  };
}
