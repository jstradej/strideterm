/// <reference types="node" />
import os from "node:os";
import path from "node:path";

// Re-export shared git auth utilities so existing consumers keep working.
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
} from "./shared/provider-utils.js";

import { trimTrailingSlash, firstNonEmpty, parseDate } from "./shared/provider-utils.js";
import {
  normalizeReviewRoot as baseNormalizeReviewRoot,
  formatReviewWorkspaceError as baseFormatReviewWorkspaceError,
} from "./shared/provider-utils.js";

export const API_VERSION = "7.1";
export const POLICY_API_VERSION = "7.1-preview.1";
export const AZURE_REVIEW_ICON = "AZ";
export const AZURE_REVIEW_COLOR = "#0078d4";
// Resolve lazily so dev instances (STRIDETERM_DATA_DIR / --data-dir) don't
// default to the prod ~/.strideterm dir. A module-level `const` evaluates
// once at import time, before main.js sets the env var.
export function getDefaultReviewRoot() {
  return process.env.STRIDETERM_DATA_DIR
    ? path.join(path.resolve(process.env.STRIDETERM_DATA_DIR), "azure-pr")
    : path.join(os.homedir(), ".strideterm", "azure-pr");
}
export const STATUS_PRIORITY: Record<string, number> = {
  active: 2,
  pending: 1,
  fixed: 0,
};
export const CHECK_STATE_PRIORITY: Record<string, number> = {
  failed: 4,
  pending: 3,
  succeeded: 2,
  "not-applicable": 1,
  unknown: 0,
};

export function normalizeReviewRoot(value: unknown): string {
  return baseNormalizeReviewRoot(value, getDefaultReviewRoot());
}

export function uniqueList(values: unknown[] = []): string[] {
  const seen = new Set();
  const result = [];
  for (const value of values.map((entry) => String(entry || "").trim()).filter(Boolean)) {
    const key = value.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(value);
  }
  return result;
}

export function createPullRequestKey(
  connectionId: string,
  repositoryId: string,
  pullRequestId: string | number,
): string {
  return `${connectionId}:${repositoryId}:${pullRequestId}`;
}

export function normalizeIdentityValue(value: unknown): string {
  return String(value || "")
    .trim()
    .toLowerCase();
}

export function identityMatches(
  login: unknown,
  identity: { uniqueName?: string; mailAddress?: string; displayName?: string; id?: string } | null | undefined,
): boolean {
  const normalizedLogin = normalizeIdentityValue(login);
  if (!normalizedLogin || !identity) {
    return false;
  }

  return [identity.uniqueName, identity.mailAddress, identity.displayName, identity.id].some(
    (value) => normalizeIdentityValue(value) === normalizedLogin,
  );
}

export function extractComments(
  threads: Array<{
    id?: number;
    status?: string;
    comments?: Array<{ commentType?: string; [key: string]: unknown }>;
  }> = [],
): Array<{ threadId?: number; threadStatus?: string; commentType?: string; [key: string]: unknown }> {
  return threads.flatMap((thread) =>
    Array.isArray(thread?.comments)
      ? thread.comments
          .filter((comment) => String(comment?.commentType || "").toLowerCase() !== "system")
          .map((comment) => ({ ...comment, threadId: thread.id, threadStatus: thread.status }))
      : [],
  );
}

export function summarizeReviewers(
  reviewers: Array<{
    id?: string;
    displayName?: string;
    uniqueName?: string;
    vote?: number;
    isRequired?: boolean;
    hasDeclined?: boolean;
    isContainer?: boolean;
  }> = [],
  login = "",
): {
  myVote: number;
  myReviewerId: string;
  approvedCount: number;
  waitingCount: number;
  totalCount: number;
  reviewers: Array<{
    id: string;
    displayName: string;
    uniqueName: string;
    vote: number;
    isRequired: boolean;
    hasDeclined: boolean;
    isContainer: boolean;
  }>;
} {
  const myReviewer = reviewers.find((reviewer) => identityMatches(login, reviewer));
  return {
    myVote: myReviewer?.vote ?? 0,
    myReviewerId: myReviewer?.id || "",
    approvedCount: reviewers.filter((reviewer) => Number(reviewer.vote) > 0).length,
    waitingCount: reviewers.filter((reviewer) => Number(reviewer.vote) < 0).length,
    totalCount: reviewers.length,
    reviewers: reviewers.map((reviewer) => ({
      id: reviewer.id || "",
      displayName: reviewer.displayName || reviewer.uniqueName || reviewer.id || "Unknown reviewer",
      uniqueName: reviewer.uniqueName || "",
      vote: Number(reviewer.vote) || 0,
      isRequired: Boolean(reviewer.isRequired),
      hasDeclined: Boolean(reviewer.hasDeclined),
      isContainer: Boolean(reviewer.isContainer),
    })),
  };
}

export function buildRepositoryRemoteUrl(
  connection: { orgUrl?: string } | null | undefined,
  projectName: string,
  repositoryName: string,
): string {
  const baseUrl = trimTrailingSlash(connection?.orgUrl);
  const project = String(projectName || "").trim();
  const repository = String(repositoryName || "").trim();
  if (!baseUrl || !project || !repository) {
    return "";
  }
  return `${baseUrl}/${encodeURIComponent(project)}/_git/${encodeURIComponent(repository)}`;
}

export function formatReviewWorkspaceError(error: unknown, reviewRoot: string): string {
  return baseFormatReviewWorkspaceError(error, normalizeReviewRoot(reviewRoot), "Azure connection");
}

export function computeThreadStatusCounts(threads: Array<{ status?: string }> = []): Record<string, number> {
  return threads.reduce<Record<string, number>>((result, thread) => {
    const key = String(thread?.status || "unknown").toLowerCase();
    result[key] = (result[key] || 0) + 1;
    return result;
  }, {});
}

export function normalizeCheckState(value: unknown): string {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  if (!normalized) {
    return "unknown";
  }
  if (["failed", "failure", "error", "rejected", "broken"].includes(normalized)) {
    return "failed";
  }
  if (["pending", "queued", "running", "inprogress", "notset"].includes(normalized)) {
    return "pending";
  }
  if (["approved", "succeeded", "success", "passed", "completed", "ok"].includes(normalized)) {
    return "succeeded";
  }
  if (["notapplicable", "not-applicable", "skipped"].includes(normalized)) {
    return "not-applicable";
  }
  return "unknown";
}

export function checkStateLabel(value: unknown): string {
  const normalized = normalizeCheckState(value);
  if (normalized === "failed") {
    return "failed";
  }
  if (normalized === "pending") {
    return "pending";
  }
  if (normalized === "succeeded") {
    return "passed";
  }
  if (normalized === "not-applicable") {
    return "skipped";
  }
  return "unknown";
}

export function summarizePolicyContext(
  context: {
    errorMessage?: string;
    statusDescription?: string;
    buildDefinitionName?: string;
    buildNumber?: string;
    message?: string;
  } = {},
): string {
  return firstNonEmpty(
    context.errorMessage,
    context.statusDescription,
    context.buildDefinitionName && context.buildNumber
      ? `${context.buildDefinitionName} \u00B7 ${context.buildNumber}`
      : "",
    context.buildDefinitionName || "",
    context.buildNumber || "",
    context.message || "",
  );
}

export function buildCheckSummary({
  policyEvaluations = [],
  statuses = [],
  buildDetails = {},
}: {
  policyEvaluations?: Array<{
    evaluationId?: string | null;
    configuration?: {
      id?: string;
      settings?: Record<string, unknown>;
      type?: { displayName?: string };
      isBlocking?: boolean;
    };
    type?: { displayName?: string };
    context?: Record<string, unknown>;
    status?: string;
    _links?: { web?: { href?: string } };
  }>;
  statuses?: Array<{
    id?: string | number;
    state?: string;
    context?: { genre?: string; name?: string };
    description?: string;
    targetUrl?: string;
    createdDate?: string;
    updatedDate?: string;
    _links?: { target?: { href?: string }; web?: { href?: string } };
  }>;
  buildDetails?: Record<string, { startTime?: string | null; finishTime?: string | null; queueTime?: string | null }>;
} = {}): {
  failedCount: number;
  pendingCount: number;
  passedCount: number;
  optionalFailedCount: number;
  requiredFailedCount: number;
  items: unknown[];
} {
  const items = [
    ...policyEvaluations.map((evaluation, index) => {
      const state = normalizeCheckState(evaluation?.status);
      const settings = (evaluation?.configuration?.settings || {}) as Record<string, unknown>;
      const context = (evaluation?.context || {}) as Record<string, unknown>;
      const buildId = (context.buildId as string | null | undefined) || null;
      const build = buildId ? buildDetails[buildId] : null;
      return {
        id: `policy:${evaluation?.evaluationId || evaluation?.configuration?.id || index}`,
        kind: "policy",
        evaluationId: evaluation?.evaluationId || null,
        name: firstNonEmpty(
          settings.displayName,
          evaluation?.configuration?.type?.displayName,
          evaluation?.type?.displayName,
          "Policy",
        ),
        description: firstNonEmpty(context.statusDescription, context.message, ""),
        state,
        stateLabel: checkStateLabel(state),
        optional:
          evaluation?.configuration?.isBlocking === false
            ? true
            : evaluation?.configuration?.isBlocking === true
              ? false
              : null,
        source: firstNonEmpty(evaluation?.configuration?.type?.displayName, "policy"),
        url: firstNonEmpty(context.url, context.targetUrl, evaluation?._links?.web?.href),
        errorMessage: context.errorMessage || "",
        buildId,
        buildInfo: context.buildDefinitionName
          ? `${context.buildDefinitionName}${context.buildNumber ? ` \u00B7 ${context.buildNumber}` : ""}`
          : "",
        startTime: build?.startTime || null,
        finishTime: build?.finishTime || null,
        queueTime: build?.queueTime || null,
      };
    }),
    ...statuses.map((status, index) => {
      const state = normalizeCheckState(status?.state);
      return {
        id: `status:${status?.id || index}:${status?.context?.genre || ""}:${status?.context?.name || ""}`,
        kind: "status",
        evaluationId: null,
        name: firstNonEmpty(status?.context?.name, status?.description, status?.context?.genre, "Status"),
        description: firstNonEmpty(status?.description, ""),
        state,
        stateLabel: checkStateLabel(state),
        optional: null,
        source: firstNonEmpty(status?.context?.genre, "status"),
        url: firstNonEmpty(status?.targetUrl, status?._links?.target?.href, status?._links?.web?.href),
        errorMessage: "",
        buildId: null,
        buildInfo: "",
        startTime: status?.createdDate || null,
        finishTime: status?.updatedDate || null,
        queueTime: null,
      };
    }),
  ]
    .filter((item) => item.name)
    .sort((left, right) => {
      const priorityDelta = (CHECK_STATE_PRIORITY[right.state] || 0) - (CHECK_STATE_PRIORITY[left.state] || 0);
      if (priorityDelta !== 0) {
        return priorityDelta;
      }
      const optionalDelta = Number(left.optional === true) - Number(right.optional === true);
      if (optionalDelta !== 0) {
        return optionalDelta;
      }
      return left.name.localeCompare(right.name);
    });

  return {
    failedCount: items.filter((item) => item.state === "failed").length,
    pendingCount: items.filter((item) => item.state === "pending").length,
    passedCount: items.filter((item) => item.state === "succeeded").length,
    optionalFailedCount: items.filter((item) => item.state === "failed" && item.optional === true).length,
    requiredFailedCount: items.filter((item) => item.state === "failed" && item.optional === false).length,
    items,
  };
}

export function compareThreads(
  left: { status?: string; lastUpdatedDate?: string; publishedDate?: string },
  right: { status?: string; lastUpdatedDate?: string; publishedDate?: string },
): number {
  const leftPriority = STATUS_PRIORITY[String(left?.status || "").toLowerCase()] || 0;
  const rightPriority = STATUS_PRIORITY[String(right?.status || "").toLowerCase()] || 0;
  if (leftPriority !== rightPriority) {
    return rightPriority - leftPriority;
  }
  return (
    parseDate(right?.lastUpdatedDate || right?.publishedDate) - parseDate(left?.lastUpdatedDate || left?.publishedDate)
  );
}

export function createConnectionSnapshot(
  connection: {
    id: string;
    label?: string;
    orgUrl?: string;
    login?: string;
    tokenRef?: string;
    enabled?: boolean;
    profileId?: string;
    projectFilters?: string[];
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
  orgUrl: string;
  login: string;
  tokenRef: string;
  enabled: boolean;
  profileId: string;
  projectFilters: string[];
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
    orgUrl: trimTrailingSlash(connection.orgUrl),
    login: connection.login || "",
    tokenRef: connection.tokenRef || "",
    enabled: connection.enabled !== false,
    // Frontend filters connections per window's active profile (see
    // AzureInboxPane). Without this, every connection looked unprofiled to
    // the renderer and the filter either showed all or none depending on
    // which slot the user's window happened to be on.
    profileId: connection.profileId || "default",
    projectFilters: [...(connection.projectFilters || [])],
    repositoryFilters: [...(connection.repositoryFilters || [])],
    pollSeconds: Number(connection.pollSeconds) || 120,
    reviewRoot: normalizeReviewRoot(connection.reviewRoot),
    status: persistedState.status || "idle",
    lastSyncAt: persistedState.lastSyncAt || null,
    lastSuccessAt: persistedState.lastSuccessAt || null,
    lastError: persistedState.lastError || "",
  };
}

export function inferAttentionReason({
  role,
  newCommentsCount,
  sourceUpdated,
  voteChanged,
  mergeStatusChanged,
  mergeStatus,
}: {
  role: string;
  newCommentsCount: number;
  sourceUpdated: boolean;
  voteChanged: boolean;
  mergeStatusChanged: boolean;
  mergeStatus: string;
}): string {
  if (newCommentsCount > 0) {
    return role === "author" ? "new comment on my PR" : "new comment";
  }
  if (voteChanged) {
    return "review state changed";
  }
  if (sourceUpdated) {
    return role === "reviewer" ? "updated after review" : "branch updated";
  }
  if (
    mergeStatusChanged ||
    String(mergeStatus || "")
      .toLowerCase()
      .includes("failed")
  ) {
    return "policy failed";
  }
  return "";
}

export function normalizeConnectionInput(
  connectionInput: {
    orgUrl?: string;
    login?: string;
    projectFilters?: unknown[];
    repositoryFilters?: unknown[];
    [key: string]: unknown;
  } = {},
): {
  orgUrl: string;
  login: string;
  projectFilters: string[];
  repositoryFilters: string[];
  [key: string]: unknown;
} {
  const initialProjectFilters = Array.isArray(connectionInput.projectFilters) ? connectionInput.projectFilters : [];
  const initialRepositoryFilters = Array.isArray(connectionInput.repositoryFilters)
    ? connectionInput.repositoryFilters
    : [];
  const normalized = {
    ...connectionInput,
    orgUrl: trimTrailingSlash(connectionInput.orgUrl),
    login: String(connectionInput.login || "").trim(),
    projectFilters: uniqueList(initialProjectFilters),
    repositoryFilters: uniqueList(initialRepositoryFilters),
  };

  if (!normalized.orgUrl) {
    return normalized;
  }

  try {
    const url = new URL(normalized.orgUrl);
    const segments = url.pathname.split("/").filter(Boolean);
    let baseSegments = segments;
    let projectHint = "";
    let repositoryHint = "";
    const isAzureDevOpsServicesHost =
      /(^|\.)dev\.azure\.com$/i.test(url.hostname) || /(^|\.)visualstudio\.com$/i.test(url.hostname);

    const projectsIndex = segments.findIndex((segment) => segment.toLowerCase() === "projects");
    const gitIndex = segments.findIndex((segment) => segment.toLowerCase() === "_git");
    const apisIndex = segments.findIndex((segment) => segment.toLowerCase() === "_apis");

    if (projectsIndex >= 0) {
      if (isAzureDevOpsServicesHost) {
        baseSegments = segments.slice(0, projectsIndex);
        projectHint = segments[projectsIndex + 1] || "";
        repositoryHint = segments[projectsIndex + 2] || "";
      } else {
        const collectionHint = segments[projectsIndex + 1] || "";
        projectHint = segments[projectsIndex + 2] || "";
        repositoryHint = segments[projectsIndex + 3] || "";
        baseSegments = [...segments.slice(0, projectsIndex + 1), ...(collectionHint ? [collectionHint] : [])];
      }
    } else if (gitIndex >= 1) {
      baseSegments = segments.slice(0, gitIndex - 1);
      projectHint = segments[gitIndex - 1] || "";
      repositoryHint = segments[gitIndex + 1] || "";
    } else if (apisIndex >= 0) {
      baseSegments = segments.slice(0, apisIndex);
    }

    normalized.orgUrl = trimTrailingSlash(`${url.origin}${baseSegments.length ? `/${baseSegments.join("/")}` : ""}`);
    normalized.projectFilters = uniqueList([projectHint, ...normalized.projectFilters]);
    normalized.repositoryFilters = uniqueList([repositoryHint, ...normalized.repositoryFilters]);
    return normalized;
  } catch {
    return normalized;
  }
}
