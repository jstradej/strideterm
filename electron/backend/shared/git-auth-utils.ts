/// <reference types="node" />

/**
 * Provider-agnostic git authentication utilities.
 *
 * These helpers are used by any module that needs to run authenticated
 * git commands (push, fetch, clone) regardless of the hosting provider
 * (Azure DevOps, GitHub, GitLab, …).
 */

/**
 * Build a Basic-auth header value suitable for `http.extraheader`, whether it
 * is handed to git as `-c http.extraheader=…` or through `GIT_CONFIG_*`.
 */
export function encodeAuthHeader(login: string, token: string): string {
  return `AUTHORIZATION: Basic ${Buffer.from(`${String(login || "").trim()}:${String(token || "")}`, "utf8").toString("base64")}`;
}

/**
 * Return a copy of `process.env` with git-internal variables removed.
 * This prevents an outer git context from leaking into a spawned git
 * command (e.g. when running inside a worktree or hook).
 */
export function sanitizeGitEnvironment(): Record<string, string | undefined> {
  const env = { ...process.env };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  delete env.GIT_COMMON_DIR;
  delete env.GIT_INDEX_FILE;
  delete env.GIT_PREFIX;
  delete env.GIT_OBJECT_DIRECTORY;
  delete env.GIT_ALTERNATE_OBJECT_DIRECTORIES;
  // Backend git must never be interactive: `rebase --continue` /
  // `cherry-pick --continue` otherwise launch the user's configured editor
  // to confirm the commit message. `true` is a shell builtin (git invokes
  // the editor through sh, on Windows too) that exits 0, so git keeps the
  // original message.
  env.GIT_EDITOR = "true";
  env.GIT_SEQUENCE_EDITOR = "true";
  return env;
}

/** `GIT_CONFIG_COUNT` / `GIT_CONFIG_KEY_n` / `GIT_CONFIG_VALUE_n` need git 2.31. */
const GIT_CONFIG_ENV_MIN = { major: 2, minor: 31 };

/**
 * Parse the `major.minor` out of `git --version` output (`git version
 * 2.43.0.windows.1`). Returns null when the text carries no recognisable
 * version.
 */
export function parseGitVersion(text: string): { major: number; minor: number } | null {
  const match = /(\d+)\.(\d+)/.exec(String(text || ""));
  if (!match) return null;
  return { major: Number(match[1]), minor: Number(match[2]) };
}

/**
 * True when this git understands `GIT_CONFIG_COUNT` & co. An unparseable
 * version answers false, so the caller keeps the argv path rather than
 * silently sending no credentials.
 */
export function gitSupportsConfigEnv(versionOutput: string): boolean {
  const version = parseGitVersion(versionOutput);
  if (!version) return false;
  if (version.major !== GIT_CONFIG_ENV_MIN.major) return version.major > GIT_CONFIG_ENV_MIN.major;
  return version.minor >= GIT_CONFIG_ENV_MIN.minor;
}

/**
 * Memoize "does the installed git support `GIT_CONFIG_*`?". `readVersion`
 * returns the `git --version` text; it runs at most once per probe, and any
 * failure to run or parse it resolves false.
 */
export function createGitConfigEnvProbe(readVersion: () => Promise<string>): () => Promise<boolean> {
  let pending: Promise<boolean> | null = null;
  return () => {
    pending ??= readVersion().then(gitSupportsConfigEnv, () => false);
    return pending;
  };
}

/**
 * `baseEnv` plus the `http.extraheader` carrying the token, passed through
 * `GIT_CONFIG_COUNT` / `GIT_CONFIG_KEY_n` / `GIT_CONFIG_VALUE_n` instead of
 * `-c http.extraheader=…`, so the token is not on the child's command line
 * (process listings, endpoint telemetry). An existing `GIT_CONFIG_COUNT` is
 * respected: the header is appended at the next index.
 */
export function gitAuthEnvironment(
  login: string,
  token: string,
  baseEnv: Record<string, string | undefined>,
): Record<string, string | undefined> {
  const existing = Number.parseInt(baseEnv.GIT_CONFIG_COUNT ?? "", 10);
  const index = Number.isInteger(existing) && existing > 0 ? existing : 0;
  return {
    ...baseEnv,
    GIT_CONFIG_COUNT: String(index + 1),
    [`GIT_CONFIG_KEY_${index}`]: "http.extraheader",
    [`GIT_CONFIG_VALUE_${index}`]: encodeAuthHeader(login, token),
  };
}
