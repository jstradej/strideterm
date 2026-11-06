/**
 * Whether this checkout's HEAD merges cleanly into the PR target — `git merge-tree`
 * run locally, so it describes the code HERE, which after a local rebase is not
 * yet what the provider sees on the server.
 */
export interface LocalMergeCheck {
  state: "clean" | "conflicts" | "unknown";
  /** Repository-relative conflicted paths; empty unless `conflicts`. */
  paths: string[];
  /** The HEAD the check ran on. Differs from the PR's source commit until it is pushed. */
  headSha: string;
  /** What HEAD was merged against, as last fetched (e.g. `origin/develop`). */
  targetRef: string;
}

/** A file the provider's own merge of the PR (as it is on the server) conflicts in. */
export interface ServerConflictFile {
  path: string;
  /** The provider's conflict kind, e.g. Azure `editEdit`, `deleteEdit`. */
  type: string;
}

/**
 * `git merge-tree --write-tree --name-only --no-messages` on a conflicted merge
 * (exit code 1): the first line is the resulting tree id, every further line one
 * conflicted path — repeated when a path has several conflicting stages.
 */
export function parseMergeTreeConflicts(stdout: string): string[] {
  const lines = stdout
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
  return [...new Set(lines.slice(1))];
}

/** Azure `GitConflict` records (`conflictPath` is rooted, `/pom.xml`) → repository-relative paths. */
export function mapAzureConflicts(records: unknown[]): ServerConflictFile[] {
  const files: ServerConflictFile[] = [];
  const seen = new Set<string>();
  for (const record of records) {
    const entry = (record || {}) as { conflictPath?: unknown; conflictType?: unknown };
    const path = String(entry.conflictPath || "").replace(/^\/+/u, "");
    if (!path || seen.has(path)) continue;
    seen.add(path);
    files.push({ path, type: String(entry.conflictType || "") });
  }
  return files;
}
