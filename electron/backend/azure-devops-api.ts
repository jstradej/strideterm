/// <reference types="node" />
import { API_VERSION, POLICY_API_VERSION, trimTrailingSlash } from "./azure-devops-utils.js";

interface AzureConnection {
  orgUrl: string;
  login: string;
  [key: string]: unknown;
}

interface RequestOptions {
  login?: string;
  token?: string;
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
}

interface EtagEntry {
  etag: string;
  data: unknown;
}

interface AuditLogger {
  (entry: {
    method: string;
    url: string;
    statusCode: number;
    success: boolean;
    durationMs: number;
    errorMessage?: string;
  }): void;
}

interface CreateAzureApiOptions {
  auditLogger?: AuditLogger;
}

export function createAzureApi(fetchImpl: typeof globalThis.fetch, { auditLogger }: CreateAzureApiOptions = {}) {
  const etagCache = new Map<string, EtagEntry>();
  const ETAG_CACHE_MAX_SIZE = 200;

  async function requestJson(url: string, { login, token, method = "GET", body = null, headers = {} }: RequestOptions = {}) {
    const startTime = Date.now();
    let statusCode = 0;

    const requestHeaders: Record<string, string> = {
      Accept: "application/json",
      "Content-Type": "application/json",
      Authorization: `Basic ${Buffer.from(`${login}:${token}`, "utf8").toString("base64")}`,
      ...headers,
    };

    // Add ETag/If-None-Match for GET requests (only when cached data exists to fall back to)
    if (method === "GET") {
      const cached = etagCache.get(url);
      if (cached?.etag && cached?.data) {
        requestHeaders["If-None-Match"] = cached.etag;
      }
    }

    try {
      const response = await fetchImpl(url, {
        method,
        headers: requestHeaders,
        body: body == null ? undefined : JSON.stringify(body),
      });

      statusCode = response.status;

      // Return cached response on 304 Not Modified
      if (response.status === 304 && method === "GET") {
        const cached = etagCache.get(url);
        if (cached?.data) {
          if (auditLogger) {
            try {
              auditLogger({ method, url, statusCode: 304, success: true, durationMs: Date.now() - startTime });
            } catch {}
          }
          return cached.data;
        }
      }

      if (!response.ok) {
        const text = await response.text().catch(() => "");
        let message = text || response.statusText;
        try {
          const parsed = JSON.parse(text) as { message?: string; error?: { message?: string } };
          message = parsed?.message || parsed?.error?.message || message;
        } catch {}
        throw new Error(`Azure DevOps request failed (${response.status}): ${message}`);
      }

      const data = await response.json();

      // Cache ETag for GET responses
      if (method === "GET") {
        const etag = typeof response.headers?.get === "function" ? response.headers.get("etag") : null;
        if (etag) {
          // Evict oldest entries if cache grows too large
          if (etagCache.size >= ETAG_CACHE_MAX_SIZE) {
            const firstKey = etagCache.keys().next().value;
            // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
            etagCache.delete(firstKey!);
          }
          etagCache.set(url, { etag, data });
        }
      }

      if (auditLogger) {
        try {
          auditLogger({ method, url, statusCode, success: true, durationMs: Date.now() - startTime });
        } catch {}
      }

      return data;
    } catch (err) {
      if (auditLogger) {
        try {
          auditLogger({
            method,
            url,
            statusCode,
            success: false,
            errorMessage: (err as Error).message,
            durationMs: Date.now() - startTime,
          });
        } catch {}
      }
      throw err;
    }
  }

  function buildProjectsUrl(connection: AzureConnection) {
    return `${trimTrailingSlash(connection.orgUrl)}/_apis/projects?api-version=${API_VERSION}&$top=200`;
  }

  function buildProjectPullRequestsUrl(connection: AzureConnection, projectName: string) {
    return `${trimTrailingSlash(connection.orgUrl)}/${encodeURIComponent(projectName)}/_apis/git/pullrequests?searchCriteria.status=active&api-version=${API_VERSION}&$top=200`;
  }

  function buildPullRequestUrl(connection: AzureConnection, projectName: string, repositoryId: string, pullRequestId: string | number) {
    return `${trimTrailingSlash(connection.orgUrl)}/${encodeURIComponent(projectName)}/_apis/git/repositories/${repositoryId}/pullRequests/${pullRequestId}?api-version=${API_VERSION}`;
  }

  function buildThreadsUrl(connection: AzureConnection, projectName: string, repositoryId: string, pullRequestId: string | number) {
    return `${trimTrailingSlash(connection.orgUrl)}/${encodeURIComponent(projectName)}/_apis/git/repositories/${repositoryId}/pullRequests/${pullRequestId}/threads?api-version=${API_VERSION}&$top=200`;
  }

  function buildIterationsUrl(connection: AzureConnection, projectName: string, repositoryId: string, pullRequestId: string | number) {
    return `${trimTrailingSlash(connection.orgUrl)}/${encodeURIComponent(projectName)}/_apis/git/repositories/${repositoryId}/pullRequests/${pullRequestId}/iterations?api-version=${API_VERSION}&$top=200`;
  }

  function buildIterationChangesUrl(connection: AzureConnection, projectName: string, repositoryId: string, pullRequestId: string | number, iterationId: string | number, skip = 0) {
    return `${trimTrailingSlash(connection.orgUrl)}/${encodeURIComponent(projectName)}/_apis/git/repositories/${repositoryId}/pullRequests/${pullRequestId}/iterations/${iterationId}/changes?api-version=${API_VERSION}&$top=2000&$skip=${skip}`;
  }

  function buildCreateThreadUrl(connection: AzureConnection, projectName: string, repositoryId: string, pullRequestId: string | number) {
    return `${trimTrailingSlash(connection.orgUrl)}/${encodeURIComponent(projectName)}/_apis/git/repositories/${repositoryId}/pullRequests/${pullRequestId}/threads?api-version=${API_VERSION}`;
  }

  function buildCreateCommentUrl(connection: AzureConnection, projectName: string, repositoryId: string, pullRequestId: string | number, threadId: string | number) {
    return `${trimTrailingSlash(connection.orgUrl)}/${encodeURIComponent(projectName)}/_apis/git/repositories/${repositoryId}/pullRequests/${pullRequestId}/threads/${threadId}/comments?api-version=${API_VERSION}`;
  }

  function buildUpdateThreadUrl(connection: AzureConnection, projectName: string, repositoryId: string, pullRequestId: string | number, threadId: string | number) {
    return `${trimTrailingSlash(connection.orgUrl)}/${encodeURIComponent(projectName)}/_apis/git/repositories/${repositoryId}/pullRequests/${pullRequestId}/threads/${threadId}?api-version=${API_VERSION}`;
  }

  function buildReviewerUrl(connection: AzureConnection, projectName: string, repositoryId: string, pullRequestId: string | number, reviewerId: string) {
    return `${trimTrailingSlash(connection.orgUrl)}/${encodeURIComponent(projectName)}/_apis/git/repositories/${repositoryId}/pullRequests/${pullRequestId}/reviewers/${reviewerId}?api-version=${API_VERSION}`;
  }

  function buildPullRequestStatusesUrl(connection: AzureConnection, projectName: string, repositoryId: string, pullRequestId: string | number) {
    return `${trimTrailingSlash(connection.orgUrl)}/${encodeURIComponent(projectName)}/_apis/git/repositories/${repositoryId}/pullRequests/${pullRequestId}/statuses?api-version=${API_VERSION}`;
  }

  function buildPolicyEvaluationsUrl(connection: AzureConnection, projectName: string, projectId: string, pullRequestId: string | number) {
    const artifactId = `vstfs:///CodeReview/CodeReviewId/${projectId}/${pullRequestId}`;
    return `${trimTrailingSlash(connection.orgUrl)}/${encodeURIComponent(projectName)}/_apis/policy/evaluations?artifactId=${encodeURIComponent(artifactId)}&includeNotApplicable=true&api-version=${POLICY_API_VERSION}`;
  }

  function buildBuildTimelineUrl(connection: AzureConnection, projectName: string, buildId: string | number) {
    return `${trimTrailingSlash(connection.orgUrl)}/${encodeURIComponent(projectName)}/_apis/build/builds/${buildId}/timeline?api-version=${API_VERSION}`;
  }

  async function fetchBuildErrors(connection: AzureConnection, token: string, projectName: string, buildId: string | number | null | undefined) {
    if (!buildId) return "";
    try {
      const timeline = await requestJson(buildBuildTimelineUrl(connection, projectName, buildId), {
        login: connection.login,
        token,
      }) as { records?: Array<{ result?: string; issues?: Array<{ type?: string; message?: string }> }> };
      const records = timeline.records || [];
      const errors: string[] = [];
      for (const record of records) {
        if (record.result === "failed" || record.result === "canceled") {
          const issues = record.issues || [];
          for (const issue of issues) {
            if (issue.type === "error" && issue.message) {
              errors.push(issue.message);
            }
          }
        }
      }
      return errors.join("\n").trim();
    } catch {
      return "";
    }
  }

  async function listProjects(connection: AzureConnection, token: string) {
    const result = await requestJson(buildProjectsUrl(connection), {
      login: connection.login,
      token,
    }) as { value?: unknown[] };
    return result.value || [];
  }

  async function listPullRequestsByProject(connection: AzureConnection, token: string, projectName: string) {
    const result = await requestJson(buildProjectPullRequestsUrl(connection, projectName), {
      login: connection.login,
      token,
    }) as { value?: unknown[] };
    return result.value || [];
  }

  async function getPullRequestById(connection: AzureConnection, token: string, projectName: string, repositoryId: string, pullRequestId: string | number) {
    return requestJson(buildPullRequestUrl(connection, projectName, repositoryId, pullRequestId), {
      login: connection.login,
      token,
    });
  }

  async function listThreads(connection: AzureConnection, token: string, projectName: string, repositoryId: string, pullRequestId: string | number) {
    const result = await requestJson(buildThreadsUrl(connection, projectName, repositoryId, pullRequestId), {
      login: connection.login,
      token,
    }) as { value?: unknown[] };
    return result.value || [];
  }

  async function listPullRequestStatuses(connection: AzureConnection, token: string, projectName: string, repositoryId: string, pullRequestId: string | number) {
    const result = await requestJson(
      buildPullRequestStatusesUrl(connection, projectName, repositoryId, pullRequestId),
      {
        login: connection.login,
        token,
      },
    ) as { value?: unknown[] };
    return result.value || [];
  }

  async function listPolicyEvaluations(connection: AzureConnection, token: string, projectName: string, projectId: string, pullRequestId: string | number) {
    if (!projectId) {
      return [];
    }
    const result = await requestJson(buildPolicyEvaluationsUrl(connection, projectName, projectId, pullRequestId), {
      login: connection.login,
      token,
    }) as { value?: unknown[] };
    return result.value || [];
  }

  function buildReEvaluatePolicyUrl(connection: AzureConnection, projectName: string, _projectId: string, evaluationId: string) {
    return `${trimTrailingSlash(connection.orgUrl)}/${encodeURIComponent(projectName)}/_apis/policy/evaluations/${encodeURIComponent(evaluationId)}?api-version=${POLICY_API_VERSION}`;
  }

  async function reEvaluatePolicy(connection: AzureConnection, token: string, projectName: string, projectId: string, evaluationId: string) {
    return requestJson(buildReEvaluatePolicyUrl(connection, projectName, projectId, evaluationId), {
      login: connection.login,
      token,
      method: "PATCH",
      body: {},
    });
  }

  function buildBuildDetailUrl(connection: AzureConnection, projectName: string, buildId: string | number) {
    return `${trimTrailingSlash(connection.orgUrl)}/${encodeURIComponent(projectName)}/_apis/build/builds/${buildId}?api-version=${API_VERSION}`;
  }

  async function fetchBuildDetail(connection: AzureConnection, token: string, projectName: string, buildId: string | number | null | undefined) {
    if (!buildId) return null;
    try {
      return await requestJson(buildBuildDetailUrl(connection, projectName, buildId), {
        login: connection.login,
        token,
      });
    } catch {
      return null;
    }
  }

  async function listIterationChanges(connection: AzureConnection, token: string, projectName: string, repositoryId: string, pullRequestId: string | number) {
    const iterationsResult = await requestJson(
      buildIterationsUrl(connection, projectName, repositoryId, pullRequestId),
      {
        login: connection.login,
        token,
      },
    ) as { value?: Array<{ id?: string | number }> };
    const iterations = iterationsResult.value || [];
    const latestIteration = iterations.at(-1);
    if (!latestIteration?.id) {
      return [];
    }

    const changes: unknown[] = [];
    let skip = 0;
    while (true) {
      const result = await requestJson(
        buildIterationChangesUrl(connection, projectName, repositoryId, pullRequestId, latestIteration.id, skip),
        {
          login: connection.login,
          token,
        },
      ) as { changeEntries?: unknown[]; value?: unknown[] };
      const batch = result.changeEntries || result.value || [];
      changes.push(...batch);
      if (!batch.length || batch.length < 2000) {
        break;
      }
      skip += batch.length;
    }

    return changes.map((entry) => {
      const e = entry as {
        item?: { path?: string; objectId?: string };
        sourceServerItem?: string;
        changeType?: string;
        changeTrackingId?: string;
        originalPath?: string;
      };
      return {
        path: e?.item?.path || e?.sourceServerItem || "",
        changeType: e?.changeType || e?.changeTrackingId || "edit",
        originalPath: e?.originalPath || "",
        objectId: e?.item?.objectId || "",
      };
    });
  }

  function buildListRepositoriesUrl(connection: AzureConnection, projectName: string) {
    return `${trimTrailingSlash(connection.orgUrl)}/${encodeURIComponent(projectName)}/_apis/git/repositories?api-version=${API_VERSION}`;
  }

  function buildListRefsUrl(connection: AzureConnection, projectName: string, repositoryId: string, filter = "heads") {
    return `${trimTrailingSlash(connection.orgUrl)}/${encodeURIComponent(projectName)}/_apis/git/repositories/${repositoryId}/refs?filter=${encodeURIComponent(filter)}&api-version=${API_VERSION}&$top=500`;
  }

  function buildCreatePullRequestUrl(connection: AzureConnection, projectName: string, repositoryId: string) {
    return `${trimTrailingSlash(connection.orgUrl)}/${encodeURIComponent(projectName)}/_apis/git/repositories/${repositoryId}/pullrequests?api-version=${API_VERSION}`;
  }

  async function listRepositories(connection: AzureConnection, token: string, projectName: string) {
    const result = await requestJson(buildListRepositoriesUrl(connection, projectName), {
      login: connection.login,
      token,
    }) as { value?: unknown[] };
    return result.value || [];
  }

  async function listRepositoryRefs(connection: AzureConnection, token: string, projectName: string, repositoryId: string, filter = "heads") {
    const result = await requestJson(buildListRefsUrl(connection, projectName, repositoryId, filter), {
      login: connection.login,
      token,
    }) as { value?: unknown[] };
    return result.value || [];
  }

  async function createPullRequest(
    connection: AzureConnection,
    token: string,
    projectName: string,
    repositoryId: string,
    { title, description, sourceBranch, targetBranch, isDraft = false }: {
      title: string;
      description?: string;
      sourceBranch: string;
      targetBranch: string;
      isDraft?: boolean;
    },
  ) {
    return requestJson(buildCreatePullRequestUrl(connection, projectName, repositoryId), {
      login: connection.login,
      token,
      method: "POST",
      body: {
        sourceRefName: sourceBranch.startsWith("refs/") ? sourceBranch : `refs/heads/${sourceBranch}`,
        targetRefName: targetBranch.startsWith("refs/") ? targetBranch : `refs/heads/${targetBranch}`,
        title,
        description: description || "",
        isDraft,
      },
    });
  }

  return {
    requestJson,
    buildProjectsUrl,
    buildProjectPullRequestsUrl,
    buildThreadsUrl,
    buildIterationsUrl,
    buildIterationChangesUrl,
    buildCreateThreadUrl,
    buildCreateCommentUrl,
    buildUpdateThreadUrl,
    buildReviewerUrl,
    buildPullRequestStatusesUrl,
    buildPolicyEvaluationsUrl,
    buildBuildTimelineUrl,
    buildListRepositoriesUrl,
    buildListRefsUrl,
    buildCreatePullRequestUrl,
    buildPullRequestUrl,
    fetchBuildErrors,
    fetchBuildDetail,
    reEvaluatePolicy,
    listProjects,
    listPullRequestsByProject,
    getPullRequestById,
    listThreads,
    listPullRequestStatuses,
    listPolicyEvaluations,
    listIterationChanges,
    listRepositories,
    listRepositoryRefs,
    createPullRequest,
  };
}
