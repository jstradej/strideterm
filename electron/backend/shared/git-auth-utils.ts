/// <reference types="node" />

/**
 * Provider-agnostic git authentication utilities.
 *
 * These helpers are used by any module that needs to run authenticated
 * git commands (push, fetch, clone) regardless of the hosting provider
 * (Azure DevOps, GitHub, GitLab, …).
 */

/**
 * Build a Basic-auth header value suitable for `git -c http.extraheader=…`.
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
