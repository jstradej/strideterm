/// <reference types="node" />
import os from "node:os";
import path from "node:path";

export { encodeAuthHeader, sanitizeGitEnvironment } from "./shared/git-auth-utils.js";

// Re-export shared provider utilities so existing consumers keep working.
export {
  clone,
  sanitizePathSegment,
  trimTrailingSlash,
  stripRefsPrefix,
  parseDate,
  toIsoOrNull,
  firstNonEmpty,
  normalizeRemoteUrl,
  shortPathKey,
  exists,
  createEmptySnapshot,
  extractErrorText,
  dedupePrSummaries,
} from "./shared/provider-utils.js";

import { trimTrailingSlash } from "./shared/provider-utils.js";
import {
  normalizeReviewRoot as baseNormalizeReviewRoot,
  formatReviewWorkspaceError as baseFormatReviewWorkspaceError,
} from "./shared/provider-utils.js";

export const GITHUB_REVIEW_ICON = "GH";
export const GITHUB_REVIEW_COLOR = "#238636";
// Resolve lazily so dev instances (STRIDETERM_DATA_DIR / --data-dir) don't
// default to the prod ~/.strideterm dir. A module-level `const` evaluates
// once at import time, before main.js sets the env var.
export function getDefaultReviewRoot() {
  return process.env.STRIDETERM_DATA_DIR
    ? path.join(path.resolve(process.env.STRIDETERM_DATA_DIR), "github-pr")
    : path.join(os.homedir(), ".strideterm", "github-pr");
}

export function normalizeReviewRoot(value: unknown): string {
  return baseNormalizeReviewRoot(value, getDefaultReviewRoot());
}

/**
 * Build a pull request key: connectionId:owner/repo:number
 */
export function createPullRequestKey(
  connectionId: string,
  owner: string,
  repo: string,
  pullNumber: number | string,
): string {
  return `${connectionId}:${owner}/${repo}:${pullNumber}`;
}

/**
 * Derive apiBaseUrl from a hostUrl.
 * github.com → https://api.github.com
 * GHES       → https://HOST/api/v3
 */
export function deriveApiBaseUrl(hostUrl: string | null | undefined): string {
  const host = trimTrailingSlash(hostUrl || "https://github.com");
  try {
    const u = new URL(host);
    if (u.hostname === "github.com" || u.hostname === "www.github.com") {
      return "https://api.github.com";
    }
    return `${u.origin}/api/v3`;
  } catch {
    return "https://api.github.com";
  }
}

export function buildRepositoryRemoteUrl(hostUrl: string | null | undefined, owner: string, repo: string): string {
  const host = trimTrailingSlash(hostUrl || "https://github.com");
  return `${host}/${owner}/${repo}`;
}

export function buildPullRequestWebUrl(
  hostUrl: string | null | undefined,
  owner: string,
  repo: string,
  pullNumber: number | string,
): string {
  const host = trimTrailingSlash(hostUrl || "https://github.com");
  return `${host}/${owner}/${repo}/pull/${pullNumber}`;
}

export function formatReviewWorkspaceError(error: unknown, reviewRoot: string): string {
  return baseFormatReviewWorkspaceError(error, normalizeReviewRoot(reviewRoot), "GitHub connection");
}

/**
 * Infer attention reason based on tracked state changes.
 */
export function inferAttentionReason({
  role,
  newCommentsCount,
  sourceUpdated,
  reviewStateChanged,
  checksChanged,
  checksFailed,
}: {
  role: string;
  newCommentsCount: number;
  sourceUpdated: boolean;
  reviewStateChanged: boolean;
  checksChanged: boolean;
  checksFailed: boolean;
}): string {
  if (newCommentsCount > 0) {
    return role === "author" ? "new comment on my PR" : "new comment";
  }
  if (reviewStateChanged) {
    return role === "author" ? "review state changed" : "review decision changed";
  }
  if (sourceUpdated) {
    return role === "reviewer" ? "updated after review" : "branch updated";
  }
  if (checksFailed) {
    return "checks failed";
  }
  if (checksChanged) {
    return "check status changed";
  }
  return "";
}

/**
 * Normalize a GitHub review state to a simple label.
 * GitHub states: APPROVED, CHANGES_REQUESTED, COMMENTED, DISMISSED, PENDING
 */
export function normalizeReviewState(state: unknown): string {
  const normalized = String(state || "").toUpperCase();
  if (normalized === "APPROVED") return "approved";
  if (normalized === "CHANGES_REQUESTED") return "changes_requested";
  if (normalized === "COMMENTED") return "commented";
  if (normalized === "DISMISSED") return "dismissed";
  if (normalized === "PENDING") return "pending";
  return "unknown";
}

export function normalizeCheckState(state: unknown): string {
  const normalized = String(state || "").toLowerCase();
  if (["failure", "timed_out", "action_required", "cancelled", "startup_failure"].includes(normalized)) return "failed";
  if (["queued", "in_progress", "waiting", "pending", "requested"].includes(normalized)) return "pending";
  if (["success", "neutral", "skipped"].includes(normalized)) return "succeeded";
  return "unknown";
}

export function createConnectionSnapshot(
  connection: {
    id: string;
    label?: string;
    hostUrl?: string;
    apiBaseUrl?: string;
    currentUserLogin?: string;
    tokenRef?: string;
    enabled?: boolean;
    profileId?: string;
    ownerFilters?: string[];
    repositoryFilters?: string[];
    pollSeconds?: number;
    reviewRoot?: string;
  },
  persistedState: {
    status?: string;
    lastSyncAt?: string | null;
    lastSuccessAt?: string | null;
    lastError?: string;
  } = {},
): {
  id: string;
  label: string;
  hostUrl: string;
  apiBaseUrl: string;
  currentUserLogin: string;
  tokenRef: string;
  enabled: boolean;
  profileId: string;
  ownerFilters: string[];
  repositoryFilters: string[];
  pollSeconds: number;
  reviewRoot: string;
  status: string;
  lastSyncAt: string | null;
  lastSuccessAt: string | null;
  lastError: string;
} {
  return {
    id: connection.id,
    label: connection.label || connection.id,
    hostUrl: trimTrailingSlash(connection.hostUrl || "https://github.com"),
    apiBaseUrl: connection.apiBaseUrl || deriveApiBaseUrl(connection.hostUrl),
    currentUserLogin: connection.currentUserLogin || "",
    tokenRef: connection.tokenRef || "",
    enabled: connection.enabled !== false,
    // See azure-devops-utils createConnectionSnapshot for the rationale —
    // frontend filters connections per window's profile.
    profileId: connection.profileId || "default",
    ownerFilters: [...(connection.ownerFilters || [])],
    repositoryFilters: [...(connection.repositoryFilters || [])],
    pollSeconds: Number(connection.pollSeconds) || 120,
    reviewRoot: normalizeReviewRoot(connection.reviewRoot),
    status: persistedState.status || "idle",
    lastSyncAt: persistedState.lastSyncAt || null,
    lastSuccessAt: persistedState.lastSuccessAt || null,
    lastError: persistedState.lastError || "",
  };
}

export function normalizeConnectionInput(
  connectionInput: {
    hostUrl?: string;
    apiBaseUrl?: string;
    currentUserLogin?: string;
    ownerFilters?: unknown[];
    repositoryFilters?: unknown[];
    [key: string]: unknown;
  } = {},
): {
  hostUrl: string;
  apiBaseUrl: string;
  currentUserLogin: string;
  ownerFilters: string[];
  repositoryFilters: string[];
  [key: string]: unknown;
} {
  let hostUrl = trimTrailingSlash(connectionInput.hostUrl || "https://github.com");
  const ownerFilters = Array.isArray(connectionInput.ownerFilters)
    ? connectionInput.ownerFilters.map((v) => String(v || "").trim()).filter(Boolean)
    : [];
  const repositoryFilters = Array.isArray(connectionInput.repositoryFilters)
    ? connectionInput.repositoryFilters.map((v) => String(v || "").trim()).filter(Boolean)
    : [];

  // If user pasted a full repo or owner URL, extract just the host and infer filters
  try {
    const u = new URL(hostUrl);
    const segments = u.pathname.split("/").filter(Boolean);
    if (segments.length >= 1) {
      // e.g. https://github.com/owner/repo or https://github.com/owner
      const ownerHint = segments[0];
      const repoHint = segments[1] || "";
      hostUrl = u.origin; // strip path to just https://github.com
      if (ownerHint && !ownerFilters.includes(ownerHint)) {
        ownerFilters.push(ownerHint);
      }
      if (repoHint && !repositoryFilters.includes(`${ownerHint}/${repoHint}`)) {
        repositoryFilters.push(`${ownerHint}/${repoHint}`);
      }
    }
  } catch {}

  return {
    ...connectionInput,
    hostUrl,
    apiBaseUrl: connectionInput.apiBaseUrl || deriveApiBaseUrl(hostUrl),
    currentUserLogin: String(connectionInput.currentUserLogin || "").trim(),
    ownerFilters,
    repositoryFilters,
  };
}
