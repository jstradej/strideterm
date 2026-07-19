/// <reference types="node" />
import { API_VERSION, POLICY_API_VERSION, trimTrailingSlash } from "./azure-devops-utils.js";
import { createEtagJsonClient } from "./shared/etag-json-client.js";

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

function buildBasicAuthHeader(login: string | undefined, token: string | undefined): string {
  return `Basic ${Buffer.from(`${login}:${token}`, "utf8").toString("base64")}`;
}

export function createAzureApi(fetchImpl: typeof globalThis.fetch, { auditLogger }: CreateAzureApiOptions = {}) {
  const { requestJson, requestText } = createEtagJsonClient<RequestOptions>(fetchImpl, {
    buildJsonHeaders({ login, token, headers = {} }) {
      return {
        Accept: "application/json",
        "Content-Type": "application/json",
        Authorization: buildBasicAuthHeader(login, token),
        ...headers,
      };
    },
    buildTextHeaders({ login, token, headers = {} }) {
      return {
        Accept: "text/plain",
        Authorization: buildBasicAuthHeader(login, token),
        ...headers,
      };
    },
    errorPrefix: "Azure DevOps",
    extractErrorMessage(parsedBody, fallback) {
      const parsed = parsedBody as { message?: string; error?: { message?: string } };
      return parsed?.message || parsed?.error?.message || fallback;
    },
    auditLogger,
  });

  function buildProjectsUrl(connection: AzureConnection) {
    return `${trimTrailingSlash(connection.orgUrl)}/_apis/projects?api-version=${API_VERSION}&$top=200`;
  }

  function buildProjectPullRequestsUrl(connection: AzureConnection, projectName: string) {
    return `${trimTrailingSlash(connection.orgUrl)}/${encodeURIComponent(projectName)}/_apis/git/pullrequests?searchCriteria.status=active&api-version=${API_VERSION}&$top=200`;
  }

  function buildPullRequestUrl(
    connection: AzureConnection,
    projectName: string,
    repositoryId: string,
    pullRequestId: string | number,
  ) {
    return `${trimTrailingSlash(connection.orgUrl)}/${encodeURIComponent(projectName)}/_apis/git/repositories/${repositoryId}/pullRequests/${pullRequestId}?api-version=${API_VERSION}`;
  }

  function buildThreadsUrl(
    connection: AzureConnection,
    projectName: string,
    repositoryId: string,
    pullRequestId: string | number,
  ) {
    return `${trimTrailingSlash(connection.orgUrl)}/${encodeURIComponent(projectName)}/_apis/git/repositories/${repositoryId}/pullRequests/${pullRequestId}/threads?api-version=${API_VERSION}&$top=200`;
  }

  function buildIterationsUrl(
    connection: AzureConnection,
    projectName: string,
    repositoryId: string,
    pullRequestId: string | number,
  ) {
    return `${trimTrailingSlash(connection.orgUrl)}/${encodeURIComponent(projectName)}/_apis/git/repositories/${repositoryId}/pullRequests/${pullRequestId}/iterations?api-version=${API_VERSION}&$top=200`;
  }

  function buildIterationChangesUrl(
    connection: AzureConnection,
    projectName: string,
    repositoryId: string,
    pullRequestId: string | number,
    iterationId: string | number,
    skip = 0,
  ) {
    return `${trimTrailingSlash(connection.orgUrl)}/${encodeURIComponent(projectName)}/_apis/git/repositories/${repositoryId}/pullRequests/${pullRequestId}/iterations/${iterationId}/changes?api-version=${API_VERSION}&$top=2000&$skip=${skip}`;
  }

  function buildCreateThreadUrl(
    connection: AzureConnection,
    projectName: string,
    repositoryId: string,
    pullRequestId: string | number,
  ) {
    return `${trimTrailingSlash(connection.orgUrl)}/${encodeURIComponent(projectName)}/_apis/git/repositories/${repositoryId}/pullRequests/${pullRequestId}/threads?api-version=${API_VERSION}`;
  }

  function buildCreateCommentUrl(
    connection: AzureConnection,
    projectName: string,
    repositoryId: string,
    pullRequestId: string | number,
    threadId: string | number,
  ) {
    return `${trimTrailingSlash(connection.orgUrl)}/${encodeURIComponent(projectName)}/_apis/git/repositories/${repositoryId}/pullRequests/${pullRequestId}/threads/${threadId}/comments?api-version=${API_VERSION}`;
  }

  function buildUpdateThreadUrl(
    connection: AzureConnection,
    projectName: string,
    repositoryId: string,
    pullRequestId: string | number,
    threadId: string | number,
  ) {
    return `${trimTrailingSlash(connection.orgUrl)}/${encodeURIComponent(projectName)}/_apis/git/repositories/${repositoryId}/pullRequests/${pullRequestId}/threads/${threadId}?api-version=${API_VERSION}`;
  }

  function buildReviewerUrl(
    connection: AzureConnection,
    projectName: string,
    repositoryId: string,
    pullRequestId: string | number,
    reviewerId: string,
  ) {
    return `${trimTrailingSlash(connection.orgUrl)}/${encodeURIComponent(projectName)}/_apis/git/repositories/${repositoryId}/pullRequests/${pullRequestId}/reviewers/${reviewerId}?api-version=${API_VERSION}`;
  }

  function buildPullRequestStatusesUrl(
    connection: AzureConnection,
    projectName: string,
    repositoryId: string,
    pullRequestId: string | number,
  ) {
    return `${trimTrailingSlash(connection.orgUrl)}/${encodeURIComponent(projectName)}/_apis/git/repositories/${repositoryId}/pullRequests/${pullRequestId}/statuses?api-version=${API_VERSION}`;
  }

  function buildPolicyEvaluationsUrl(
    connection: AzureConnection,
    projectName: string,
    projectId: string,
    pullRequestId: string | number,
  ) {
    const artifactId = `vstfs:///CodeReview/CodeReviewId/${projectId}/${pullRequestId}`;
    return `${trimTrailingSlash(connection.orgUrl)}/${encodeURIComponent(projectName)}/_apis/policy/evaluations?artifactId=${encodeURIComponent(artifactId)}&includeNotApplicable=true&api-version=${POLICY_API_VERSION}`;
  }

  function buildBuildTimelineUrl(connection: AzureConnection, projectName: string, buildId: string | number) {
    return `${trimTrailingSlash(connection.orgUrl)}/${encodeURIComponent(projectName)}/_apis/build/builds/${buildId}/timeline?api-version=${API_VERSION}`;
  }

  async function fetchBuildErrors(
    connection: AzureConnection,
    token: string,
    projectName: string,
    buildId: string | number | null | undefined,
  ) {
    if (!buildId) return "";
    const startTime = Date.now();
    try {
      const timeline = (await requestJson(buildBuildTimelineUrl(connection, projectName, buildId), {
        login: connection.login,
        token,
      })) as { records?: Array<{ result?: string; issues?: Array<{ type?: string; message?: string }> }> };
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
    } catch (err) {
      if (auditLogger) {
        try {
          auditLogger({
            method: "GET",
            url: buildBuildTimelineUrl(connection, projectName, buildId),
            statusCode: 0,
            success: false,
            errorMessage: (err as Error).message,
            durationMs: Date.now() - startTime,
          });
        } catch {}
      }
      return "";
    }
  }

  async function listProjects(connection: AzureConnection, token: string) {
    const result = (await requestJson(buildProjectsUrl(connection), {
      login: connection.login,
      token,
    })) as { value?: unknown[] };
    return result.value || [];
  }

  async function listPullRequestsByProject(connection: AzureConnection, token: string, projectName: string) {
    const result = (await requestJson(buildProjectPullRequestsUrl(connection, projectName), {
      login: connection.login,
      token,
    })) as { value?: unknown[] };
    return result.value || [];
  }

  async function getPullRequestById(
    connection: AzureConnection,
    token: string,
    projectName: string,
    repositoryId: string,
    pullRequestId: string | number,
  ) {
    return requestJson(buildPullRequestUrl(connection, projectName, repositoryId, pullRequestId), {
      login: connection.login,
      token,
    });
  }

  async function listThreads(
    connection: AzureConnection,
    token: string,
    projectName: string,
    repositoryId: string,
    pullRequestId: string | number,
  ) {
    const result = (await requestJson(buildThreadsUrl(connection, projectName, repositoryId, pullRequestId), {
      login: connection.login,
      token,
    })) as { value?: unknown[] };
    return result.value || [];
  }

  async function listPullRequestStatuses(
    connection: AzureConnection,
    token: string,
    projectName: string,
    repositoryId: string,
    pullRequestId: string | number,
  ) {
    const result = (await requestJson(
      buildPullRequestStatusesUrl(connection, projectName, repositoryId, pullRequestId),
      {
        login: connection.login,
        token,
      },
    )) as { value?: unknown[] };
    return result.value || [];
  }

  async function listPolicyEvaluations(
    connection: AzureConnection,
    token: string,
    projectName: string,
    projectId: string,
    pullRequestId: string | number,
  ) {
    if (!projectId) {
      return [];
    }
    const result = (await requestJson(buildPolicyEvaluationsUrl(connection, projectName, projectId, pullRequestId), {
      login: connection.login,
      token,
    })) as { value?: unknown[] };
    return result.value || [];
  }

  function buildReEvaluatePolicyUrl(
    connection: AzureConnection,
    projectName: string,
    _projectId: string,
    evaluationId: string,
  ) {
    return `${trimTrailingSlash(connection.orgUrl)}/${encodeURIComponent(projectName)}/_apis/policy/evaluations/${encodeURIComponent(evaluationId)}?api-version=${POLICY_API_VERSION}`;
  }

  async function reEvaluatePolicy(
    connection: AzureConnection,
    token: string,
    projectName: string,
    projectId: string,
    evaluationId: string,
  ) {
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

  async function fetchBuildDetail(
    connection: AzureConnection,
    token: string,
    projectName: string,
    buildId: string | number | null | undefined,
  ) {
    if (!buildId) return null;
    const startTime = Date.now();
    try {
      return await requestJson(buildBuildDetailUrl(connection, projectName, buildId), {
        login: connection.login,
        token,
      });
    } catch (err) {
      if (auditLogger) {
        try {
          auditLogger({
            method: "GET",
            url: buildBuildDetailUrl(connection, projectName, buildId),
            statusCode: 0,
            success: false,
            errorMessage: (err as Error).message,
            durationMs: Date.now() - startTime,
          });
        } catch {}
      }
      return null;
    }
  }

  async function listIterationChanges(
    connection: AzureConnection,
    token: string,
    projectName: string,
    repositoryId: string,
    pullRequestId: string | number,
  ) {
    const iterationsResult = (await requestJson(
      buildIterationsUrl(connection, projectName, repositoryId, pullRequestId),
      {
        login: connection.login,
        token,
      },
    )) as { value?: Array<{ id?: string | number }> };
    const iterations = iterationsResult.value || [];
    const latestIteration = iterations.at(-1);
    if (!latestIteration?.id) {
      return [];
    }

    const changes: unknown[] = [];
    let skip = 0;
    while (true) {
      const result = (await requestJson(
        buildIterationChangesUrl(connection, projectName, repositoryId, pullRequestId, latestIteration.id, skip),
        {
          login: connection.login,
          token,
        },
      )) as { changeEntries?: unknown[]; value?: unknown[] };
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
    const result = (await requestJson(buildListRepositoriesUrl(connection, projectName), {
      login: connection.login,
      token,
    })) as { value?: unknown[] };
    return result.value || [];
  }

  async function listRepositoryRefs(
    connection: AzureConnection,
    token: string,
    projectName: string,
    repositoryId: string,
    filter = "heads",
  ) {
    const result = (await requestJson(buildListRefsUrl(connection, projectName, repositoryId, filter), {
      login: connection.login,
      token,
    })) as { value?: unknown[] };
    return result.value || [];
  }

  function buildListCommitsUrl(connection: AzureConnection, projectName: string, repositoryId: string, top: number) {
    return `${trimTrailingSlash(connection.orgUrl)}/${encodeURIComponent(projectName)}/_apis/git/repositories/${repositoryId}/commits?searchCriteria.$top=${top}&api-version=${API_VERSION}`;
  }

  /** Recent commits on the repo's default branch (for the re-run branch picker's Commits tab). */
  async function listRepositoryCommits(
    connection: AzureConnection,
    token: string,
    projectName: string,
    repositoryId: string,
    top = 30,
  ) {
    const result = (await requestJson(buildListCommitsUrl(connection, projectName, repositoryId, top), {
      login: connection.login,
      token,
    })) as { value?: unknown[] };
    return result.value || [];
  }

  async function createPullRequest(
    connection: AzureConnection,
    token: string,
    projectName: string,
    repositoryId: string,
    {
      title,
      description,
      sourceBranch,
      targetBranch,
      isDraft = false,
    }: {
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

  // --- Pipelines (Build definitions + Pipelines run API) ---

  function buildPipelineDefinitionsUrl(connection: AzureConnection, projectName: string) {
    return `${trimTrailingSlash(connection.orgUrl)}/${encodeURIComponent(projectName)}/_apis/build/definitions?includeLatestBuilds=true&queryOrder=lastModifiedDescending&$top=200&api-version=${API_VERSION}`;
  }

  function buildPipelineRunsUrl(connection: AzureConnection, projectName: string, pipelineId: string | number) {
    return `${trimTrailingSlash(connection.orgUrl)}/${encodeURIComponent(projectName)}/_apis/pipelines/${pipelineId}/runs?api-version=${API_VERSION}`;
  }

  function buildBuildsByDefinitionUrl(
    connection: AzureConnection,
    projectName: string,
    definitionId: string | number,
    top: number,
  ) {
    return `${trimTrailingSlash(connection.orgUrl)}/${encodeURIComponent(projectName)}/_apis/build/builds?definitions=${definitionId}&queryOrder=queueTimeDescending&$top=${top}&api-version=${API_VERSION}`;
  }

  function buildPipelineRunUrl(
    connection: AzureConnection,
    projectName: string,
    pipelineId: string | number,
    runId: string | number,
  ) {
    return `${trimTrailingSlash(connection.orgUrl)}/${encodeURIComponent(projectName)}/_apis/pipelines/${pipelineId}/runs/${runId}?api-version=${API_VERSION}`;
  }

  // The Run-pipeline panel's parameter schema is served by a contribution data
  // provider (not a public REST resource), reached via HierarchyQuery. This is
  // the same call the Azure DevOps web UI makes, so it returns the exact same
  // types/allowed-values; it's undocumented, hence pinned to its own version.
  function buildHierarchyQueryUrl(connection: AzureConnection, projectName: string) {
    return `${trimTrailingSlash(connection.orgUrl)}/_apis/Contribution/HierarchyQuery/project/${encodeURIComponent(projectName)}?api-version=5.0-preview.1`;
  }

  /** Build definitions with their latest/latestCompleted builds inline (one call per project). */
  async function listBuildDefinitionsWithLatest(connection: AzureConnection, token: string, projectName: string) {
    const result = (await requestJson(buildPipelineDefinitionsUrl(connection, projectName), {
      login: connection.login,
      token,
    })) as { value?: unknown[] };
    return result.value || [];
  }

  /** Recent builds for a definition (Build API — richer than Pipelines runs: who/branch/commit/timing). */
  async function listBuildsByDefinition(
    connection: AzureConnection,
    token: string,
    projectName: string,
    definitionId: string | number,
    top = 25,
  ) {
    const result = (await requestJson(buildBuildsByDefinitionUrl(connection, projectName, definitionId, top), {
      login: connection.login,
      token,
    })) as { value?: unknown[] };
    return result.value || [];
  }

  function buildBuildDefinitionDetailUrl(
    connection: AzureConnection,
    projectName: string,
    definitionId: string | number,
  ) {
    return `${trimTrailingSlash(connection.orgUrl)}/${encodeURIComponent(projectName)}/_apis/build/definitions/${definitionId}?api-version=${API_VERSION}`;
  }

  /** A single build definition — carries `repository` (id + type) so we can list its refs. */
  async function getBuildDefinition(
    connection: AzureConnection,
    token: string,
    projectName: string,
    definitionId: string | number,
  ) {
    return requestJson(buildBuildDefinitionDetailUrl(connection, projectName, definitionId), {
      login: connection.login,
      token,
    });
  }

  /** A single run including templateParameters, variables and resource refName (for re-run seeding). */
  async function getPipelineRun(
    connection: AzureConnection,
    token: string,
    projectName: string,
    pipelineId: string | number,
    runId: string | number,
  ) {
    return requestJson(buildPipelineRunUrl(connection, projectName, pipelineId, runId), {
      login: connection.login,
      token,
    });
  }

  /**
   * Runtime parameter schema for a pipeline (name/type/default/allowed values),
   * via the same data provider the "Run pipeline" panel uses. Returns the raw
   * HierarchyQuery payload for the manager to map; `sourceBranch` matters
   * because YAML parameters can differ per branch.
   */
  async function getPipelineRunParameters(
    connection: AzureConnection,
    token: string,
    projectName: string,
    pipelineId: string | number,
    sourceBranch?: string,
  ) {
    return requestJson(buildHierarchyQueryUrl(connection, projectName), {
      login: connection.login,
      token,
      method: "POST",
      body: {
        contributionIds: ["ms.vss-build-web.pipeline-run-parameters-data-provider"],
        dataProviderContext: {
          properties: {
            pipelineId: Number(pipelineId),
            sourceBranch: sourceBranch || undefined,
            sourcePage: { routeValues: { project: projectName } },
          },
        },
      },
    });
  }

  /** Queue a new pipeline run. Requires the PAT to have Build (read & execute). */
  async function runPipeline(
    connection: AzureConnection,
    token: string,
    projectName: string,
    pipelineId: string | number,
    body: unknown,
  ) {
    return requestJson(buildPipelineRunsUrl(connection, projectName, pipelineId), {
      login: connection.login,
      token,
      method: "POST",
      body,
    });
  }

  function buildBuildLogsUrl(connection: AzureConnection, projectName: string, buildId: string | number) {
    return `${trimTrailingSlash(connection.orgUrl)}/${encodeURIComponent(projectName)}/_apis/build/builds/${buildId}/logs?api-version=${API_VERSION}`;
  }

  function buildBuildLogUrl(
    connection: AzureConnection,
    projectName: string,
    buildId: string | number,
    logId: string | number,
  ) {
    return `${trimTrailingSlash(connection.orgUrl)}/${encodeURIComponent(projectName)}/_apis/build/builds/${buildId}/logs/${logId}?api-version=${API_VERSION}`;
  }

  /** List the per-step/job log references for a build. */
  async function listBuildLogs(
    connection: AzureConnection,
    token: string,
    projectName: string,
    buildId: string | number,
  ) {
    const result = (await requestJson(buildBuildLogsUrl(connection, projectName, buildId), {
      login: connection.login,
      token,
    })) as { value?: unknown[] };
    return result.value || [];
  }

  /** Raw text of a single build log. */
  async function getBuildLogText(
    connection: AzureConnection,
    token: string,
    projectName: string,
    buildId: string | number,
    logId: string | number,
  ): Promise<string> {
    return requestText(buildBuildLogUrl(connection, projectName, buildId, logId), {
      login: connection.login,
      token,
    });
  }

  /** Build timeline (job/step records) — used to label log sections. */
  async function fetchBuildTimeline(
    connection: AzureConnection,
    token: string,
    projectName: string,
    buildId: string | number,
  ) {
    return requestJson(buildBuildTimelineUrl(connection, projectName, buildId), {
      login: connection.login,
      token,
    });
  }

  /** Cancel an in-progress build/run. Requires Build (read & execute). buildId == pipeline run id. */
  async function cancelBuild(
    connection: AzureConnection,
    token: string,
    projectName: string,
    buildId: string | number,
  ) {
    return requestJson(buildBuildDetailUrl(connection, projectName, buildId), {
      login: connection.login,
      token,
      method: "PATCH",
      body: { status: "cancelling" },
    });
  }

  return {
    requestJson,
    // Only URL builders with real (non-test) external consumers are exposed —
    // the rest stay module-internal, used solely by the methods below.
    buildCreateThreadUrl,
    buildCreateCommentUrl,
    buildUpdateThreadUrl,
    buildReviewerUrl,
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
    listRepositoryCommits,
    createPullRequest,
    listBuildDefinitionsWithLatest,
    listBuildsByDefinition,
    getBuildDefinition,
    getPipelineRun,
    getPipelineRunParameters,
    runPipeline,
    cancelBuild,
    listBuildLogs,
    getBuildLogText,
    fetchBuildTimeline,
  };
}
