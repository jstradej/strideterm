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
  // A `git status` read must not rewrite the index: the checkout watcher sees
  // that write as a change and would refresh again.
  env.GIT_OPTIONAL_LOCKS = "0";
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
 * `http.extraheader`, or `http.<origin>/.extraheader` when `scopeUrl` is given:
 * git then sends the header only to that origin, so a URL that points
 * elsewhere (a redirect, a submodule, a mistaken remote) never receives the
 * token. A non-http(s) or unparseable `scopeUrl` throws instead of falling
 * back to the global key.
 */
export function authHeaderConfigKey(scopeUrl?: string): string {
  if (scopeUrl === undefined) return "http.extraheader";
  let origin: string;
  try {
    const parsed = new URL(scopeUrl);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new Error("not http(s)");
    origin = parsed.origin;
  } catch {
    throw new Error("Refusing to attach credentials: the repository URL is not a valid http(s) URL.");
  }
  return `http.${origin}/.extraheader`;
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
  scopeUrl?: string | readonly string[],
): Record<string, string | undefined> {
  const existing = Number.parseInt(baseEnv.GIT_CONFIG_COUNT ?? "", 10);
  const index = Number.isInteger(existing) && existing > 0 ? existing : 0;
  const keys = authHeaderConfigKeys(scopeUrl);
  const env: Record<string, string | undefined> = { ...baseEnv, GIT_CONFIG_COUNT: String(index + keys.length) };
  keys.forEach((key, offset) => {
    env[`GIT_CONFIG_KEY_${index + offset}`] = key;
    env[`GIT_CONFIG_VALUE_${index + offset}`] = encodeAuthHeader(login, token);
  });
  return env;
}

/** One `authHeaderConfigKey` per scope; an empty list is refused, never widened to the global key. */
export function authHeaderConfigKeys(scopeUrl?: string | readonly string[]): string[] {
  if (scopeUrl === undefined || typeof scopeUrl === "string") return [authHeaderConfigKey(scopeUrl)];
  if (!scopeUrl.length) throw new Error("Refusing to attach credentials: no repository URL to scope them to.");
  return [...new Set(scopeUrl.map((url) => authHeaderConfigKey(url)))];
}

const AZURE_DEVOPS_ORG = /^[a-z0-9][a-z0-9-]*$/iu;

/**
 * The origins a provider connection's token may be sent to: the connection's own Git host (Azure `orgUrl`,
 * GitHub `hostUrl`, github.com by default), plus the other spelling of an Azure DevOps cloud organization
 * (`dev.azure.com/<org>` and `<org>.visualstudio.com` serve the same repositories). Taken from the stored
 * connection, never from a workspace's repository metadata, so a rewritten remote cannot widen it.
 */
export function connectionGitAuthScopes(
  connection: { orgUrl?: unknown; hostUrl?: unknown } | null | undefined,
): string[] {
  const orgUrl = String(connection?.orgUrl || "").trim();
  let url: URL;
  try {
    url = new URL(orgUrl || String(connection?.hostUrl || "").trim() || "https://github.com");
  } catch {
    return [];
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return [];
  const scopes = [url.origin];
  const host = url.hostname.toLowerCase();
  if (orgUrl && url.protocol === "https:") {
    if (host === "dev.azure.com") {
      const org = url.pathname.split("/").find(Boolean) || "";
      if (AZURE_DEVOPS_ORG.test(org)) scopes.push(`https://${org.toLowerCase()}.visualstudio.com`);
    } else if (/^[a-z0-9-]+\.visualstudio\.com$/u.test(host)) {
      scopes.push("https://dev.azure.com");
    }
  }
  return scopes;
}
