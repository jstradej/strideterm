/// <reference types="node" />
import { createAuditLogStore } from "./shared/base-audit-log-store.js";

/**
 * Classify an Azure DevOps API request by URL pattern and HTTP method.
 * Returns { operation, category, resourceType }.
 */
export function classifyAzureRequest(method: string | undefined | null, url: string | undefined | null): { operation: string; category: string; resourceType: string } {
  const m = method?.toUpperCase() || "GET";
  const p = url || "";

  // Write operations first (POST/PATCH/PUT/DELETE are writes)
  if (m !== "GET") {
    if (p.includes("/threads") && !p.includes("/comments")) {
      if (m === "POST") return { operation: "createThread", category: "write", resourceType: "thread" };
      if (m === "PATCH") return { operation: "updateThread", category: "write", resourceType: "thread" };
    }
    if (p.includes("/comments")) return { operation: "createComment", category: "write", resourceType: "comment" };
    if (p.includes("/reviewers/")) return { operation: "setVote", category: "write", resourceType: "vote" };
    if (p.includes("/pullrequests") && m === "POST")
      return { operation: "createPullRequest", category: "write", resourceType: "pullRequest" };
    if (p.includes("/policy/evaluations") && m === "PATCH")
      return { operation: "reEvaluatePolicy", category: "write", resourceType: "policy" };
    return { operation: `${m.toLowerCase()}Request`, category: "write", resourceType: "" };
  }

  // Read operations (GET)
  if (p.includes("/_apis/projects")) return { operation: "listProjects", category: "read", resourceType: "project" };
  if (p.includes("/pullrequests?") || p.includes("/pullRequests?"))
    return { operation: "listPullRequests", category: "read", resourceType: "pullRequest" };
  if (p.includes("/threads")) return { operation: "listThreads", category: "read", resourceType: "thread" };
  if (p.includes("/iterations") && p.includes("/changes"))
    return { operation: "listIterationChanges", category: "read", resourceType: "file" };
  if (p.includes("/iterations")) return { operation: "listIterations", category: "read", resourceType: "iteration" };
  if (p.includes("/statuses")) return { operation: "listStatuses", category: "read", resourceType: "status" };
  if (p.includes("/policy/evaluations")) return { operation: "listPolicies", category: "read", resourceType: "policy" };
  if (p.includes("/timeline")) return { operation: "fetchBuildTimeline", category: "read", resourceType: "build" };
  if (/\/build\/builds\/\d+\?/.test(p))
    return { operation: "fetchBuildDetail", category: "read", resourceType: "build" };
  if (p.includes("/refs?")) return { operation: "listBranches", category: "read", resourceType: "branch" };
  if (p.includes("/repositories?") || p.includes("/_apis/git/repositories"))
    return { operation: "listRepositories", category: "read", resourceType: "repository" };
  return { operation: "getRequest", category: "read", resourceType: "" };
}

/**
 * Extract organization and project from an Azure DevOps API URL.
 */
export function parseAzureUrl(url: string | undefined | null): { organization: string; project: string } {
  try {
    const u = new URL(url ?? "");
    const parts = u.pathname.split("/").filter(Boolean);
    // dev.azure.com/{org}/{project}/_apis/...
    // or {org}.visualstudio.com/{project}/_apis/...
    const apisIndex = parts.indexOf("_apis");
    if (apisIndex >= 1) {
      return {
        organization: u.origin + (apisIndex > 1 ? "/" + parts.slice(0, apisIndex - 1).join("/") : ""),
        project: decodeURIComponent(parts[apisIndex - 1] || ""),
      };
    }
    return { organization: u.origin, project: "" };
  } catch {
    return { organization: "", project: "" };
  }
}

export function createAzureAuditLogStore(databasePath: string) {
  return createAuditLogStore(databasePath, {
    tableName: "azure_devops_audit_log",
    indexPrefix: "azure_audit",
    providerColumns: [{ name: "organization", default: "" }, { name: "project", default: "" }],
    mapEntryToProviderValues: (entry) => [String(entry.organization || ""), String(entry.project || "")],
    mapRowToProviderFields: (row) => ({ organization: row.organization, project: row.project }),
    searchFields: ["project", "organization"],
  });
}
