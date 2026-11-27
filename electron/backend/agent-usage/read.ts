import os from "node:os";
import path from "node:path";
import type { AgentUsage, UsageAccountReading, UsageAccountSnapshot } from "../../shared/agent-usage.js";
import { isUsageProfileDirectory } from "./account-store.js";
import { readClaudeAccountUsage } from "./claude.js";
import { readCodexAccountUsage } from "./codex.js";
import { discoverUsageProfiles } from "./discover-profiles.js";
import { UsageUnavailable } from "./unavailable.js";

const CACHE_MS = 60_000;
const MAX_CONCURRENT_PROBES = 3;

type Provider = "claude" | "codex";
type Reader = (env?: NodeJS.ProcessEnv) => Promise<UsageAccountReading>;
type RegisteredProfile = { id: string; provider: Provider; directory: string };
type UsageStore = {
  listProfiles(): RegisteredProfile[];
  history(provider: Provider): UsageAccountSnapshot[];
  observe(provider: Provider, reading: AgentUsage): void;
};
const readers: Record<Provider, Reader> = {
  claude: readClaudeAccountUsage,
  codex: readCodexAccountUsage,
};

function activeEnv(): NodeJS.ProcessEnv {
  return process.env;
}

// Explicit profiles inherit only OS/user context needed to locate the CLI.
// Credential variables from the host must never override the selected folder.
function profileEnv(provider: Provider, directory: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of [
    "PATH",
    "HOME",
    "USERPROFILE",
    "HOMEDRIVE",
    "HOMEPATH",
    "SYSTEMROOT",
    "WINDIR",
    "TEMP",
    "TMP",
    "APPDATA",
    "LOCALAPPDATA",
    "LANG",
    "LC_ALL",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "XDG_CACHE_HOME",
    "XDG_STATE_HOME",
    "XDG_RUNTIME_DIR",
    "DBUS_SESSION_BUS_ADDRESS",
    "GNOME_KEYRING_CONTROL",
    "GNOME_KEYRING_PID",
    "KDE_SESSION_BUS_ADDRESS",
  ]) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  if (!env.HOME) env.HOME = os.homedir();
  if (process.platform === "win32" && !env.USERPROFILE) env.USERPROFILE = os.homedir();
  if (provider === "claude") env.CLAUDE_CONFIG_DIR = path.resolve(directory);
  else env.CODEX_HOME = path.resolve(directory);
  return env;
}

function defaultEntry(
  provider: Provider,
  reading: UsageAccountReading | undefined,
  error: unknown,
  checkedAt: number,
): AgentUsage {
  if (!reading) {
    return {
      provider,
      checkedAt,
      windows: [],
      unavailable: error instanceof UsageUnavailable ? error.message : "Could not read usage from the CLI.",
    };
  }
  const windows = reading.windows.filter((item) => item.resetsAt === undefined || item.resetsAt > checkedAt);
  return {
    provider,
    checkedAt,
    windows,
    ...(reading.account ? { account: reading.account } : {}),
    ...(reading.resetCredits ? { resetCredits: reading.resetCredits } : {}),
    ...(windows.length ? {} : { unavailable: "The CLI returned no current quota windows." }),
  };
}

async function readProfile(
  profile: RegisteredProfile,
  store?: UsageStore,
): Promise<{ snapshot: UsageAccountSnapshot; identityKey?: string }> {
  const fallbackLabel =
    typeof profile.directory === "string" ? path.basename(profile.directory) || profile.provider : profile.provider;
  let directoryValid = false;
  try {
    directoryValid = isUsageProfileDirectory(profile.provider, profile.directory);
  } catch {
    // Treat an unreadable registry path like a missing profile, without failing other accounts.
  }
  if (!directoryValid) {
    return {
      snapshot: {
        id: profile.id,
        label: fallbackLabel,
        status: "listed",
        removable: true,
        unavailable: "This account folder is missing or no longer has a provider login.",
      },
    };
  }
  try {
    const reading = await readers[profile.provider](profileEnv(profile.provider, profile.directory));
    const checkedAt = Date.now();
    const windows = reading.windows.filter((item) => item.resetsAt === undefined || item.resetsAt > checkedAt);
    const identityVerified = Boolean(reading.account?.key);
    if (identityVerified && windows.length) {
      try {
        store?.observe(profile.provider, {
          provider: profile.provider,
          checkedAt,
          account: reading.account,
          windows,
        });
      } catch {
        // Keep the live profile reading even when optional history persistence fails.
      }
    }
    return {
      identityKey: identityVerified ? reading.account!.key : undefined,
      snapshot: {
        id: profile.id,
        label: identityVerified ? reading.account!.label : `${fallbackLabel} · account identity unknown`,
        status: "separate-login",
        ...(!identityVerified ? { identityUnknown: true as const } : {}),
        checkedAt,
        windows,
        removable: true,
        ...(!windows.length ? { unavailable: "The CLI returned no current quota windows." } : {}),
      },
    };
  } catch (error) {
    return {
      snapshot: {
        id: profile.id,
        label: fallbackLabel,
        status: "listed",
        removable: true,
        unavailable:
          error instanceof UsageUnavailable ? error.message : "Could not read usage from this account folder.",
      },
    };
  }
}

async function mapBounded<T, R>(values: T[], limit: number, fn: (value: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(values.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, values.length) }, async () => {
      while (next < values.length) {
        const index = next++;
        results[index] = await fn(values[index]!);
      }
    }),
  );
  return results;
}

export function createAgentUsageReader(store?: UsageStore) {
  let accounts: Promise<AgentUsage[]> | undefined;
  let expiresAt = 0;

  return async (forceRefresh = false): Promise<AgentUsage[]> => {
    // A user-requested refresh bypasses a completed snapshot, but shares any
    // current provider query so multiple windows cannot stampede the CLIs.
    if (accounts && (expiresAt === Infinity || (!forceRefresh && Date.now() < expiresAt))) return accounts;
    expiresAt = Infinity;
    accounts = (async () => {
      let profiles: RegisteredProfile[] = [];
      const history = new Map<Provider, UsageAccountSnapshot[]>();
      try {
        profiles = store?.listProfiles() ?? [];
      } catch {
        // Account history is optional; the active provider readings still work.
      }
      for (const provider of ["claude", "codex"] as const) {
        try {
          history.set(provider, store?.history(provider) ?? []);
        } catch {
          // A damaged optional history store must not hide current usage.
        }
      }
      let candidates: Awaited<ReturnType<typeof discoverUsageProfiles>> = [];
      if (store) {
        try {
          candidates = await discoverUsageProfiles(profiles);
        } catch {
          // Candidate discovery is best-effort and never prevents account reads.
        }
      }

      const jobs: Array<
        { kind: "active"; provider: Provider } | { kind: "profile"; profile: (typeof profiles)[number] }
      > = [
        { kind: "active", provider: "claude" },
        { kind: "active", provider: "codex" },
        ...profiles.map((profile) => ({ kind: "profile" as const, profile })),
      ];
      const completed = await mapBounded(jobs, MAX_CONCURRENT_PROBES, async (job) => {
        if (job.kind === "profile")
          return { kind: job.kind, profile: job.profile, ...(await readProfile(job.profile, store)) };
        try {
          const reading = await readers[job.provider](activeEnv());
          return { kind: job.kind, provider: job.provider, reading, checkedAt: Date.now() };
        } catch (error) {
          return { kind: job.kind, provider: job.provider, error, checkedAt: Date.now() };
        }
      });

      const active = new Map<Provider, AgentUsage>();
      const liveProfiles = new Map<Provider, { snapshot: UsageAccountSnapshot; identityKey?: string }[]>();
      for (const result of completed) {
        if (result.kind === "active") {
          const entry = defaultEntry(
            result.provider,
            "reading" in result ? result.reading : undefined,
            "error" in result ? result.error : undefined,
            result.checkedAt,
          );
          active.set(result.provider, entry);
          if (entry.account && entry.windows.length) {
            try {
              store?.observe(result.provider, entry);
            } catch {
              // Store writes are best-effort; keep the valid in-memory reading.
            }
          }
        } else {
          const list = liveProfiles.get(result.profile.provider) ?? [];
          list.push({ snapshot: result.snapshot, identityKey: result.identityKey });
          liveProfiles.set(result.profile.provider, list);
        }
      }

      for (const provider of ["claude", "codex"] as const) {
        const current = active.get(provider)!;
        const currentKey = current.account?.key;
        const live = liveProfiles.get(provider) ?? [];
        const liveKeys = new Set(live.flatMap(({ identityKey }) => (identityKey ? [identityKey] : [])));
        // Keep a row for every registered folder, including one that currently
        // uses the default login, so the user can remove that registration.
        const archived = (history.get(provider) ?? [])
          .filter((snapshot) => snapshot.id !== currentKey && !liveKeys.has(snapshot.id))
          .filter((snapshot) => snapshot.status === "last-seen")
          .map((snapshot) => ({ ...snapshot, removable: true }));
        current.otherAccounts = [
          ...live.map(({ snapshot, identityKey }) =>
            currentKey && identityKey === currentKey ? { ...snapshot, sameAsDefault: true as const } : snapshot,
          ),
          ...archived,
          ...candidates
            .filter((candidate) => candidate.provider === provider)
            .map(({ id, label }) => ({ id, label, status: "candidate" as const })),
        ];
      }

      expiresAt = Date.now() + CACHE_MS;
      for (const entry of active.values()) {
        for (const window of entry.windows) {
          if (window.resetsAt !== undefined) expiresAt = Math.min(expiresAt, window.resetsAt);
        }
      }
      for (const profilesForProvider of liveProfiles.values()) {
        for (const { snapshot } of profilesForProvider) {
          for (const window of snapshot.windows ?? []) {
            if (window.resetsAt !== undefined) expiresAt = Math.min(expiresAt, window.resetsAt);
          }
        }
      }
      return [active.get("claude")!, active.get("codex")!];
    })();
    const request = accounts;
    const guardedRequest = request.catch((error: unknown) => {
      if (accounts === guardedRequest) {
        accounts = undefined;
        expiresAt = 0;
      }
      throw error;
    });
    accounts = guardedRequest;
    return accounts;
  };
}
