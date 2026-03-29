import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { access } from "node:fs/promises";

// Re-export shared git auth utilities so existing consumers keep working.
export { encodeAuthHeader, sanitizeGitEnvironment } from "./shared/git-auth-utils.js";

export const API_VERSION = "7.1";
export const POLICY_API_VERSION = "7.1-preview.1";
export const AZURE_REVIEW_ICON = "AZ";
export const AZURE_REVIEW_COLOR = "#0078d4";
export const DEFAULT_REVIEW_ROOT = path.join(os.homedir(), ".strideterm", "azure-pr");
export const STATUS_PRIORITY = {
  active: 2,
  pending: 1,
  fixed: 0,
};
export const CHECK_STATE_PRIORITY = {
  failed: 4,
  pending: 3,
  succeeded: 2,
  "not-applicable": 1,
  unknown: 0,
};

export function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

export function sanitizePathSegment(value, fallback = "unknown") {
  const normalized = String(value || "")
    .trim()
    .replace(/[<>:"/\\|?*\u0000-\u001F]+/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return normalized || fallback;
}

export function trimTrailingSlash(value) {
  return String(value || "")
    .trim()
    .replace(/\/+$/, "");
}

export function normalizeReviewRoot(value) {
  return trimTrailingSlash(value || DEFAULT_REVIEW_ROOT);
}

export function uniqueList(values = []) {
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

export function createPullRequestKey(connectionId, repositoryId, pullRequestId) {
  return `${connectionId}:${repositoryId}:${pullRequestId}`;
}

export function stripRefsPrefix(value) {
  return String(value || "").replace(/^refs\/heads\//, "");
}

export function parseDate(value) {
  const timestamp = new Date(value || 0).getTime();
  return Number.isFinite(timestamp) ? timestamp : 0;
}

export function toIsoOrNull(timestamp) {
  return timestamp ? new Date(timestamp).toISOString() : null;
}

export function firstNonEmpty(...values) {
  return values.map((value) => String(value || "").trim()).find(Boolean) || "";
}

export function normalizeIdentityValue(value) {
  return String(value || "")
    .trim()
    .toLowerCase();
}

export function identityMatches(login, identity) {
  const normalizedLogin = normalizeIdentityValue(login);
  if (!normalizedLogin || !identity) {
    return false;
  }

  return [identity.uniqueName, identity.mailAddress, identity.displayName, identity.id].some(
    (value) => normalizeIdentityValue(value) === normalizedLogin,
  );
}

export function extractComments(threads = []) {
  return threads.flatMap((thread) =>
    Array.isArray(thread?.comments)
      ? thread.comments
          .filter((comment) => String(comment?.commentType || "").toLowerCase() !== "system")
          .map((comment) => ({ ...comment, threadId: thread.id, threadStatus: thread.status }))
      : [],
  );
}

export function summarizeReviewers(reviewers = [], login = "") {
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

export function normalizeRemoteUrl(value) {
  return trimTrailingSlash(
    String(value || "")
      .trim()
      .replace(/\.git$/i, ""),
  ).toLowerCase();
}

export function buildRepositoryRemoteUrl(connection, projectName, repositoryName) {
  const baseUrl = trimTrailingSlash(connection?.orgUrl);
  const project = String(projectName || "").trim();
  const repository = String(repositoryName || "").trim();
  if (!baseUrl || !project || !repository) {
    return "";
  }
  return `${baseUrl}/${encodeURIComponent(project)}/_git/${encodeURIComponent(repository)}`;
}

export function shortPathKey(value, fallback = "item") {
  const normalized = sanitizePathSegment(value, fallback).toLowerCase();
  const digest = createHash("sha1")
    .update(String(value || fallback))
    .digest("hex")
    .slice(0, 10);
  const prefix = normalized.slice(0, 8).replace(/^-|-$/g, "") || fallback;
  return `${prefix}-${digest}`;
}

export function extractErrorText(error) {
  return firstNonEmpty(error?.stderr, error?.stdout, error?.error?.message, error?.message, String(error || ""));
}

export function formatReviewWorkspaceError(error, reviewRoot) {
  const text = extractErrorText(error);
  if (!text) {
    return "";
  }

  if (/filename too long|unable to create file|could not reset index file to revision 'HEAD'/i.test(text)) {
    const example = process.platform === "win32" ? "C:\\pr" : "~/pr";
    return [
      "Review workspace could not be created because some checkout paths are too long.",
      `Current review root: ${normalizeReviewRoot(reviewRoot)}`,
      `Use a much shorter Review root in the Azure connection settings, for example ${example}, then try Review again.`,
    ].join("\n");
  }

  if (/empty string is not a valid path/i.test(text)) {
    return [
      "Review workspace could not be created because the checkout path was empty.",
      "Check the Azure connection Review root and retry.",
    ].join("\n");
  }

  return "";
}

export function computeThreadStatusCounts(threads = []) {
  return threads.reduce((result, thread) => {
    const key = String(thread?.status || "unknown").toLowerCase();
    result[key] = (result[key] || 0) + 1;
    return result;
  }, {});
}

export function normalizeCheckState(value) {
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

export function checkStateLabel(value) {
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

export function summarizePolicyContext(context = {}) {
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

export function buildCheckSummary({ policyEvaluations = [], statuses = [], buildDetails = {} } = {}) {
  const items = [
    ...policyEvaluations.map((evaluation, index) => {
      const state = normalizeCheckState(evaluation?.status);
      const settings = evaluation?.configuration?.settings || {};
      const context = evaluation?.context || {};
      const buildId = context.buildId || null;
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

export function compareThreads(left, right) {
  const leftPriority = STATUS_PRIORITY[String(left?.status || "").toLowerCase()] || 0;
  const rightPriority = STATUS_PRIORITY[String(right?.status || "").toLowerCase()] || 0;
  if (leftPriority !== rightPriority) {
    return rightPriority - leftPriority;
  }
  return (
    parseDate(right?.lastUpdatedDate || right?.publishedDate) - parseDate(left?.lastUpdatedDate || left?.publishedDate)
  );
}

export function createConnectionSnapshot(connection, persistedState = {}) {
  return {
    id: connection.id,
    label: connection.label || connection.id,
    orgUrl: trimTrailingSlash(connection.orgUrl),
    login: connection.login || "",
    tokenRef: connection.tokenRef || "",
    enabled: connection.enabled !== false,
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

export function createEmptySnapshot() {
  return {
    connections: [],
    inbox: {
      needsMyReview: [],
      myPullRequests: [],
      recentlyUpdated: [],
      needsAttention: [],
    },
    trackedPullRequests: {},
    pullRequests: {},
    sync: {
      running: false,
      lastStartedAt: null,
      lastCompletedAt: null,
    },
  };
}

export function inferAttentionReason({
  role,
  newCommentsCount,
  sourceUpdated,
  voteChanged,
  mergeStatusChanged,
  mergeStatus,
}) {
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

export async function exists(targetPath) {
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
}

export function normalizeConnectionInput(connectionInput = {}) {
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
