import { createHash } from "node:crypto";
import { lstat, opendir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isUsageProfileDirectory } from "./account-store.js";

const MAX_HOME_ENTRIES = 1024;
const MAX_CANDIDATES = 128;
const MAX_CONCURRENT_CHECKS = 8;

export interface DiscoveredUsageProfile {
  id: string;
  provider: "claude" | "codex";
  directory: string;
  /** A path-based suggestion only; it does not establish account identity. */
  label: string;
}

function canonical(directory: string): string {
  const resolved = path.resolve(directory);
  return process.platform === "win32" ? resolved.toLocaleLowerCase("en-US") : resolved;
}

function activeDirectory(provider: "claude" | "codex", home: string): string {
  const override = provider === "claude" ? process.env.CLAUDE_CONFIG_DIR : process.env.CODEX_HOME;
  return path.resolve(override || path.join(home, provider === "claude" ? ".claude" : ".codex"));
}

function candidateProvider(name: string): "claude" | "codex" | undefined {
  const match = /^\.(claude|codex)-[a-z0-9][a-z0-9._-]{0,63}$/i.exec(name);
  return match?.[1]?.toLowerCase() as "claude" | "codex" | undefined;
}

function candidateId(provider: "claude" | "codex", directory: string): string {
  const digest = createHash("sha256")
    .update(`${provider}\0${canonical(directory)}`)
    .digest("hex")
    .slice(0, 24);
  return `candidate-${digest}`;
}

async function boundedMap<T, R>(items: T[], limit: number, visit: (item: T) => Promise<R | undefined>): Promise<R[]> {
  const result: R[] = [];
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      try {
        const value = await visit(items[index]!);
        if (value !== undefined) result.push(value);
      } catch {
        // Inaccessible candidates are simply omitted from suggestions.
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return result;
}

/**
 * Finds conventional sibling CLI homes for optional user selection. Discovery
 * checks directory metadata and provider footprints only; it never reads files
 * or launches a CLI.
 */
export async function discoverUsageProfiles(
  tracked: { directory: string }[],
  home = os.homedir(),
): Promise<DiscoveredUsageProfile[]> {
  const trackedPaths = new Set(tracked.map(({ directory }) => canonical(directory)));
  const entries: { name: string; provider: "claude" | "codex" }[] = [];
  try {
    const directory = await opendir(home);
    let examined = 0;
    for await (const entry of directory) {
      if (examined++ >= MAX_HOME_ENTRIES) break;
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const provider = candidateProvider(entry.name);
      if (provider) entries.push({ name: entry.name, provider });
    }
  } catch {
    return [];
  }

  const selected = entries.slice(0, MAX_CANDIDATES);
  const results = await boundedMap(selected, MAX_CONCURRENT_CHECKS, async ({ name, provider }) => {
    const directory = path.join(home, name);
    const resolved = canonical(directory);
    if (trackedPaths.has(resolved) || resolved === canonical(activeDirectory(provider, home))) return undefined;

    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) return undefined;
    if (!isUsageProfileDirectory(provider, directory)) return undefined;
    return { id: candidateId(provider, directory), provider, directory, label: name };
  });
  return results.sort(
    (left, right) => left.provider.localeCompare(right.provider) || left.label.localeCompare(right.label),
  );
}
