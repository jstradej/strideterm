import type { ReviewSourceRepository } from "./types/state.js";

const SHA1_LENGTH = 40;
const SHA256_LENGTH = 64;

export function isFullSha(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (value.length !== SHA1_LENGTH && value.length !== SHA256_LENGTH) return false;
  for (const char of value) {
    const code = char.charCodeAt(0);
    const digit = code >= 48 && code <= 57;
    const lowerHex = code >= 97 && code <= 102;
    if (!digit && !lowerHex) return false;
  }
  return true;
}

export function fullSourceRef(sourceRefName: string | null | undefined): string {
  const ref = String(sourceRefName || "").trim();
  if (!ref) return "";
  return ref.startsWith("refs/") ? ref : `refs/heads/${ref}`;
}

export function sourceBranchName(sourceRefName: string | null | undefined): string {
  return fullSourceRef(sourceRefName).replace(/^refs\/heads\//u, "");
}

/** A path segment safe on every OS: the same rule the managed checkout directories and branch aliases use. */
export function sanitizePathSegment(value: unknown, fallback = "unknown"): string {
  const normalized = String(value || "")
    .trim()
    .replace(/[<>:"/\\|?*\u0000-\u001F]+/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return normalized || fallback;
}

/** The local branch name a managed review checkout uses for a PR: `pr-<id>-<sanitized source branch>`. */
export function managedReviewBranchAlias(prId: string | number, sourceRefName: string): string {
  return `pr-${prId}-${sanitizePathSegment(sourceBranchName(sourceRefName))}`;
}

function trimSlashes(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && value[start] === "/") start += 1;
  while (end > start && value[end - 1] === "/") end -= 1;
  return value.slice(start, end);
}

function stripGitSuffix(value: string): string {
  return value.toLowerCase().endsWith(".git") ? value.slice(0, -4) : value;
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** `user@host:path` (scp-style) → host and path; null when the text is not that shape. */
function splitScpStyle(value: string): { host: string; pathname: string } | null {
  if (value.includes("://")) return null;
  const at = value.indexOf("@");
  const colon = value.indexOf(":", at + 1);
  if (at <= 0 || colon <= at + 1) return null;
  return { host: value.slice(at + 1, colon), pathname: value.slice(colon + 1) };
}

/**
 * Canonical comparable form of a git remote: scheme, credentials, port and a
 * trailing `.git` are dropped, scp-style (`user@host:path`) and Azure's SSH
 * shape fold onto the HTTPS shape, and hosts compare case-insensitively. A
 * plain filesystem path (a local remote) folds to its normalized form.
 */
export function normalizeRemoteIdentity(remoteUrl: string | null | undefined): string {
  const value = String(remoteUrl || "")
    .trim()
    .replaceAll("\\", "/");
  if (!value) return "";

  let host: string;
  let pathname: string;
  const scp = splitScpStyle(value);
  if (scp) {
    host = scp.host;
    pathname = scp.pathname;
  } else if (value.includes("://")) {
    try {
      const url = new URL(value);
      host = url.hostname;
      pathname = url.pathname;
    } catch {
      return stripGitSuffix(trimSlashes(value)).toLowerCase();
    }
  } else {
    return stripGitSuffix(value.endsWith("/") ? value.slice(0, -1) : value).toLowerCase();
  }

  host = host.toLowerCase();
  pathname = stripGitSuffix(safeDecode(trimSlashes(pathname)));

  if (host === "ssh.dev.azure.com" || host === "vs-ssh.visualstudio.com") {
    const parts = (pathname.startsWith("v3/") ? pathname.slice(3) : pathname).split("/");
    if (parts.length >= 3) {
      const [org, project, ...repo] = parts;
      return `dev.azure.com/${org}/${project}/_git/${repo.join("/")}`.toLowerCase();
    }
  }
  return `${host}/${pathname}`.toLowerCase();
}

export function sourceRepositoryIdentity(repository: ReviewSourceRepository | null | undefined): string {
  if (!repository) return "";
  const id = String(repository.id || "").trim();
  if (id) return `id:${id.toLowerCase()}`;
  const remote = normalizeRemoteIdentity(repository.remoteUrl);
  if (remote) return `url:${remote}`;
  const fullName = String(repository.fullName || "").trim();
  return fullName ? `name:${fullName.toLowerCase()}` : "";
}

/** The parts of a review the identity is built from — all it needs, so partial and rebuilt shapes qualify. */
interface IdentityInput {
  provider: string;
  connectionId: string;
  prKey: string;
  pullRequest: { sourceRefName?: string | null } | null;
  sourceRepository: ReviewSourceRepository | null;
}

/**
 * Everything a persisted source baseline is bound to: provider, connection, PR,
 * the full source ref and the PR's actual SOURCE repository (not the target).
 * Empty when any part is unknown — an unbound baseline is no baseline.
 */
export function reviewSourceIdentityKey(review: Partial<IdentityInput> | null | undefined): string {
  if (!review) return "";
  const ref = fullSourceRef(review.pullRequest?.sourceRefName);
  const repository = sourceRepositoryIdentity(review.sourceRepository || null);
  const provider = String(review.provider || "");
  const connectionId = String(review.connectionId || "");
  const prKey = String(review.prKey || "");
  if (!provider || !connectionId || !prKey || !ref || !repository) return "";
  return [provider, connectionId, prKey, ref, repository].join("|");
}

/**
 * The baseline survives a metadata rebuild only while the source identity is
 * unchanged. A different source ref, repository, PR or connection clears it;
 * a target-ref change alone does not (the key does not include the target).
 */
export function carryOverSourceBaseline(
  previous: Partial<IdentityInput & { sourceBaselineSha?: string }> | null | undefined,
  next: Partial<IdentityInput> | null | undefined,
): string {
  const baseline = String(previous?.sourceBaselineSha || "").trim();
  if (!isFullSha(baseline)) return "";
  const previousKey = reviewSourceIdentityKey(previous);
  if (!previousKey) return "";
  return previousKey === reviewSourceIdentityKey(next) ? baseline : "";
}

export function sameRemote(a: string | null | undefined, b: string | null | undefined): boolean {
  const left = normalizeRemoteIdentity(a);
  return left !== "" && left === normalizeRemoteIdentity(b);
}
