/**
 * Provider-agnostic git authentication utilities.
 *
 * These helpers are used by any module that needs to run authenticated
 * git commands (push, fetch, clone) regardless of the hosting provider
 * (Azure DevOps, GitHub, GitLab, …).
 */

/**
 * Build a Basic-auth header value suitable for `git -c http.extraheader=…`.
 * @param {string} login
 * @param {string} token
 * @returns {string}
 */
export function encodeAuthHeader(login, token) {
  return `AUTHORIZATION: Basic ${Buffer.from(`${String(login || "").trim()}:${String(token || "")}`, "utf8").toString("base64")}`;
}

/**
 * Return a copy of `process.env` with git-internal variables removed.
 * This prevents an outer git context from leaking into a spawned git
 * command (e.g. when running inside a worktree or hook).
 * @returns {Record<string, string>}
 */
export function sanitizeGitEnvironment() {
  const env = { ...process.env };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  delete env.GIT_COMMON_DIR;
  delete env.GIT_INDEX_FILE;
  delete env.GIT_PREFIX;
  delete env.GIT_OBJECT_DIRECTORY;
  delete env.GIT_ALTERNATE_OBJECT_DIRECTORIES;
  return env;
}
