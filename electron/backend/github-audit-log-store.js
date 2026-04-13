import { createAuditLogStore } from "./shared/base-audit-log-store.js";

/**
 * Classify a GitHub API request by URL pattern and HTTP method.
 * Returns { operation, category, resourceType }.
 */
export function classifyGitHubRequest(method, url) {
  const m = method?.toUpperCase() || "GET";
  const p = url || "";

  if (m !== "GET") {
    if (p.includes("/pulls/") && p.includes("/reviews") && m === "POST")
      return { operation: "submitReview", category: "write", resourceType: "review" };
    if (p.includes("/issues/") && p.includes("/comments") && m === "POST")
      return { operation: "createIssueComment", category: "write", resourceType: "comment" };
    if (p.includes("/pulls/") && p.includes("/comments") && m === "POST")
      return { operation: "createReviewComment", category: "write", resourceType: "reviewComment" };
    if (p.includes("/check-suites/") && p.includes("/rerequest"))
      return { operation: "rerunCheckSuite", category: "write", resourceType: "checkSuite" };
    if (p.includes("/pulls") && m === "POST")
      return { operation: "createPullRequest", category: "write", resourceType: "pullRequest" };
    if (p.includes("/pulls/") && (m === "PATCH" || m === "PUT"))
      return { operation: "updatePullRequest", category: "write", resourceType: "pullRequest" };
    return { operation: `${m.toLowerCase()}Request`, category: "write", resourceType: "" };
  }

  // Read operations (GET)
  if (p.includes("/search/issues"))
    return { operation: "searchPullRequests", category: "read", resourceType: "pullRequest" };
  if (p.includes("/user") && !p.includes("/users/"))
    return { operation: "getAuthenticatedUser", category: "read", resourceType: "user" };
  if (p.includes("/pulls/") && p.includes("/files"))
    return { operation: "listPullRequestFiles", category: "read", resourceType: "file" };
  if (p.includes("/pulls/") && p.includes("/reviews"))
    return { operation: "listReviews", category: "read", resourceType: "review" };
  if (p.includes("/pulls/") && p.includes("/comments"))
    return { operation: "listReviewComments", category: "read", resourceType: "reviewComment" };
  if (p.includes("/pulls/") && p.includes("/requested_reviewers"))
    return { operation: "listRequestedReviewers", category: "read", resourceType: "reviewer" };
  if (p.includes("/issues/") && p.includes("/comments"))
    return { operation: "listIssueComments", category: "read", resourceType: "comment" };
  if (p.includes("/pulls/")) return { operation: "getPullRequest", category: "read", resourceType: "pullRequest" };
  if (p.includes("/check-runs")) return { operation: "listCheckRuns", category: "read", resourceType: "check" };
  if (p.includes("/status")) return { operation: "getCombinedStatus", category: "read", resourceType: "status" };
  return { operation: "getRequest", category: "read", resourceType: "" };
}

/**
 * Extract owner and repo from a GitHub API URL.
 */
export function parseGitHubUrl(url) {
  try {
    const u = new URL(url);
    const parts = u.pathname.split("/").filter(Boolean);
    // /repos/{owner}/{repo}/...
    const reposIndex = parts.indexOf("repos");
    if (reposIndex >= 0 && parts.length > reposIndex + 2) {
      return {
        owner: decodeURIComponent(parts[reposIndex + 1]),
        repository: decodeURIComponent(parts[reposIndex + 2]),
      };
    }
    // /search/issues or /user
    return { owner: "", repository: "" };
  } catch {
    return { owner: "", repository: "" };
  }
}

export function createGitHubAuditLogStore(databasePath) {
  return createAuditLogStore(databasePath, {
    tableName: "github_audit_log",
    indexPrefix: "github_audit",
    providerColumns: [{ name: "owner" }, { name: "repository" }],
    mapEntryToProviderValues: (entry) => [entry.owner || "", entry.repository || ""],
    mapRowToProviderFields: (row) => ({ owner: row.owner, repository: row.repository }),
    searchFields: ["owner", "repository"],
  });
}
