import { API_VERSION, POLICY_API_VERSION, trimTrailingSlash, firstNonEmpty } from "./azure-devops-utils.js";

export function createAzureApi(fetchImpl, { auditLogger } = {}) {
  const etagCache = new Map();
  const ETAG_CACHE_MAX_SIZE = 200;

  async function requestJson(url, { login, token, method = "GET", body = null, headers = {} } = {}) {
    const startTime = Date.now();
    let statusCode = 0;

    const requestHeaders = {
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
          const parsed = JSON.parse(text);
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
            etagCache.delete(firstKey);
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
            errorMessage: err.message,
            durationMs: Date.now() - startTime,
          });
        } catch {}
      }
      throw err;
    }
  }

  function buildProjectsUrl(connection) {
    return `${trimTrailingSlash(connection.orgUrl)}/_apis/projects?api-version=${API_VERSION}&$top=200`;
  }

  function buildProjectPullRequestsUrl(connection, projectName) {
    return `${trimTrailingSlash(connection.orgUrl)}/${encodeURIComponent(projectName)}/_apis/git/pullrequests?searchCriteria.status=active&api-version=${API_VERSION}&$top=200`;
  }

  function buildThreadsUrl(connection, projectName, repositoryId, pullRequestId) {
    return `${trimTrailingSlash(connection.orgUrl)}/${encodeURIComponent(projectName)}/_apis/git/repositories/${repositoryId}/pullRequests/${pullRequestId}/threads?api-version=${API_VERSION}&$top=200`;
  }

  function buildIterationsUrl(connection, projectName, repositoryId, pullRequestId) {
    return `${trimTrailingSlash(connection.orgUrl)}/${encodeURIComponent(projectName)}/_apis/git/repositories/${repositoryId}/pullRequests/${pullRequestId}/iterations?api-version=${API_VERSION}&$top=200`;
  }

  function buildIterationChangesUrl(connection, projectName, repositoryId, pullRequestId, iterationId, skip = 0) {
    return `${trimTrailingSlash(connection.orgUrl)}/${encodeURIComponent(projectName)}/_apis/git/repositories/${repositoryId}/pullRequests/${pullRequestId}/iterations/${iterationId}/changes?api-version=${API_VERSION}&$top=2000&$skip=${skip}`;
  }

  function buildCreateThreadUrl(connection, projectName, repositoryId, pullRequestId) {
    return `${trimTrailingSlash(connection.orgUrl)}/${encodeURIComponent(projectName)}/_apis/git/repositories/${repositoryId}/pullRequests/${pullRequestId}/threads?api-version=${API_VERSION}`;
  }

  function buildCreateCommentUrl(connection, projectName, repositoryId, pullRequestId, threadId) {
    return `${trimTrailingSlash(connection.orgUrl)}/${encodeURIComponent(projectName)}/_apis/git/repositories/${repositoryId}/pullRequests/${pullRequestId}/threads/${threadId}/comments?api-version=${API_VERSION}`;
  }

  function buildUpdateThreadUrl(connection, projectName, repositoryId, pullRequestId, threadId) {
    return `${trimTrailingSlash(connection.orgUrl)}/${encodeURIComponent(projectName)}/_apis/git/repositories/${repositoryId}/pullRequests/${pullRequestId}/threads/${threadId}?api-version=${API_VERSION}`;
  }

  function buildReviewerUrl(connection, projectName, repositoryId, pullRequestId, reviewerId) {
    return `${trimTrailingSlash(connection.orgUrl)}/${encodeURIComponent(projectName)}/_apis/git/repositories/${repositoryId}/pullRequests/${pullRequestId}/reviewers/${reviewerId}?api-version=${API_VERSION}`;
  }

  function buildPullRequestStatusesUrl(connection, projectName, repositoryId, pullRequestId) {
    return `${trimTrailingSlash(connection.orgUrl)}/${encodeURIComponent(projectName)}/_apis/git/repositories/${repositoryId}/pullRequests/${pullRequestId}/statuses?api-version=${API_VERSION}`;
  }

  function buildPolicyEvaluationsUrl(connection, projectName, projectId, pullRequestId) {
    const artifactId = `vstfs:///CodeReview/CodeReviewId/${projectId}/${pullRequestId}`;
    return `${trimTrailingSlash(connection.orgUrl)}/${encodeURIComponent(projectName)}/_apis/policy/evaluations?artifactId=${encodeURIComponent(artifactId)}&includeNotApplicable=true&api-version=${POLICY_API_VERSION}`;
  }

  function buildBuildTimelineUrl(connection, projectName, buildId) {
    return `${trimTrailingSlash(connection.orgUrl)}/${encodeURIComponent(projectName)}/_apis/build/builds/${buildId}/timeline?api-version=${API_VERSION}`;
  }

  async function fetchBuildErrors(connection, token, projectName, buildId) {
    if (!buildId) return "";
    try {
      const timeline = await requestJson(buildBuildTimelineUrl(connection, projectName, buildId), {
        login: connection.login,
        token,
      });
      const records = timeline.records || [];
      const errors = [];
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

  async function listProjects(connection, token) {
    const result = await requestJson(buildProjectsUrl(connection), {
      login: connection.login,
      token,
    });
    return result.value || [];
  }

  async function listPullRequestsByProject(connection, token, projectName) {
    const result = await requestJson(buildProjectPullRequestsUrl(connection, projectName), {
      login: connection.login,
      token,
    });
    return result.value || [];
  }

  async function listThreads(connection, token, projectName, repositoryId, pullRequestId) {
    const result = await requestJson(buildThreadsUrl(connection, projectName, repositoryId, pullRequestId), {
      login: connection.login,
      token,
    });
    return result.value || [];
  }

  async function listPullRequestStatuses(connection, token, projectName, repositoryId, pullRequestId) {
    const result = await requestJson(
      buildPullRequestStatusesUrl(connection, projectName, repositoryId, pullRequestId),
      {
        login: connection.login,
        token,
      },
    );
    return result.value || [];
  }

  async function listPolicyEvaluations(connection, token, projectName, projectId, pullRequestId) {
    if (!projectId) {
      return [];
    }
    const result = await requestJson(buildPolicyEvaluationsUrl(connection, projectName, projectId, pullRequestId), {
      login: connection.login,
      token,
    });
    return result.value || [];
  }

  function buildReEvaluatePolicyUrl(connection, projectName, projectId, evaluationId) {
    return `${trimTrailingSlash(connection.orgUrl)}/${encodeURIComponent(projectName)}/_apis/policy/evaluations/${encodeURIComponent(evaluationId)}?api-version=${POLICY_API_VERSION}`;
  }

  async function reEvaluatePolicy(connection, token, projectName, projectId, evaluationId) {
    return requestJson(buildReEvaluatePolicyUrl(connection, projectName, projectId, evaluationId), {
      login: connection.login,
      token,
      method: "PATCH",
      body: {},
    });
  }

  function buildBuildDetailUrl(connection, projectName, buildId) {
    return `${trimTrailingSlash(connection.orgUrl)}/${encodeURIComponent(projectName)}/_apis/build/builds/${buildId}?api-version=${API_VERSION}`;
  }

  async function fetchBuildDetail(connection, token, projectName, buildId) {
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

  async function listIterationChanges(connection, token, projectName, repositoryId, pullRequestId) {
    const iterationsResult = await requestJson(
      buildIterationsUrl(connection, projectName, repositoryId, pullRequestId),
      {
        login: connection.login,
        token,
      },
    );
    const iterations = iterationsResult.value || [];
    const latestIteration = iterations.at(-1);
    if (!latestIteration?.id) {
      return [];
    }

    const changes = [];
    let skip = 0;
    while (true) {
      const result = await requestJson(
        buildIterationChangesUrl(connection, projectName, repositoryId, pullRequestId, latestIteration.id, skip),
        {
          login: connection.login,
          token,
        },
      );
      const batch = result.changeEntries || result.value || [];
      changes.push(...batch);
      if (!batch.length || batch.length < 2000) {
        break;
      }
      skip += batch.length;
    }

    return changes.map((entry) => ({
      path: entry?.item?.path || entry?.sourceServerItem || "",
      changeType: entry?.changeType || entry?.changeTrackingId || "edit",
      originalPath: entry?.originalPath || "",
      objectId: entry?.item?.objectId || "",
    }));
  }

  function buildListRepositoriesUrl(connection, projectName) {
    return `${trimTrailingSlash(connection.orgUrl)}/${encodeURIComponent(projectName)}/_apis/git/repositories?api-version=${API_VERSION}`;
  }

  function buildListRefsUrl(connection, projectName, repositoryId, filter = "heads") {
    return `${trimTrailingSlash(connection.orgUrl)}/${encodeURIComponent(projectName)}/_apis/git/repositories/${repositoryId}/refs?filter=${encodeURIComponent(filter)}&api-version=${API_VERSION}&$top=500`;
  }

  function buildCreatePullRequestUrl(connection, projectName, repositoryId) {
    return `${trimTrailingSlash(connection.orgUrl)}/${encodeURIComponent(projectName)}/_apis/git/repositories/${repositoryId}/pullrequests?api-version=${API_VERSION}`;
  }

  async function listRepositories(connection, token, projectName) {
    const result = await requestJson(buildListRepositoriesUrl(connection, projectName), {
      login: connection.login,
      token,
    });
    return result.value || [];
  }

  async function listRepositoryRefs(connection, token, projectName, repositoryId, filter = "heads") {
    const result = await requestJson(buildListRefsUrl(connection, projectName, repositoryId, filter), {
      login: connection.login,
      token,
    });
    return result.value || [];
  }

  async function createPullRequest(
    connection,
    token,
    projectName,
    repositoryId,
    { title, description, sourceBranch, targetBranch, isDraft = false },
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
    fetchBuildErrors,
    fetchBuildDetail,
    reEvaluatePolicy,
    listProjects,
    listPullRequestsByProject,
    listThreads,
    listPullRequestStatuses,
    listPolicyEvaluations,
    listIterationChanges,
    listRepositories,
    listRepositoryRefs,
    createPullRequest,
  };
}
