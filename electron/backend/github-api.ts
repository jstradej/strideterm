/**
 * GitHub REST API client — raw fetch with ETag caching and audit logging.
 *
 * Mirrors the shape of azure-devops-api.js:
 *   createGitHubApi(fetchImpl, { auditLogger }) → { requestJson, ...endpoint helpers }
 *
 * Auth: Bearer token (PAT).  Works with github.com and GitHub Enterprise Server.
 */

const GITHUB_API_VERSION = "2022-11-28";

interface Connection {
  apiBaseUrl?: string;
  [key: string]: unknown;
}

interface RequestJsonOptions {
  token?: string;
  method?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body?: any;
  headers?: Record<string, string>;
  accept?: string;
}

interface AuditEntry {
  method: string;
  url: string;
  statusCode: number;
  success: boolean;
  durationMs: number;
  errorMessage?: string;
}

interface ListUserReposOptions {
  perPage?: number;
  sort?: string;
}

interface ListBranchesOptions {
  perPage?: number;
}

interface SubmitReviewOptions {
  event: string;
  body?: string;
}

interface CreatePullRequestOptions {
  title: string;
  body?: string;
  head: string;
  base: string;
  draft?: boolean;
}

interface EtagCacheEntry {
  etag: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data: any;
}

export function createGitHubApi(
  fetchImpl: typeof globalThis.fetch,
  { auditLogger }: { auditLogger?: (entry: AuditEntry) => void } = {},
) {
  const etagCache = new Map<string, EtagCacheEntry>();
  const ETAG_CACHE_MAX_SIZE = 200;

  async function requestJson(
    url: string,
    {
      token,
      method = "GET",
      body = null,
      headers = {},
      accept = "application/vnd.github+json",
    }: RequestJsonOptions = {},
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- MIGRATION-EXEMPT: GitHub API returns open-ended JSON, typed later
  ): Promise<any> {
    const startTime = Date.now();
    let statusCode = 0;

    const requestHeaders: Record<string, string> = {
      Accept: accept,
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": GITHUB_API_VERSION,
      ...headers,
    };

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
          message = parsed?.message || message;
        } catch {}
        throw new Error(`GitHub request failed (${response.status}): ${message}`);
      }

      // Some endpoints return 204 No Content
      if (response.status === 204) {
        if (auditLogger) {
          try {
            auditLogger({ method, url, statusCode, success: true, durationMs: Date.now() - startTime });
          } catch {}
        }
        return null;
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const data: any = await response.json();

      if (method === "GET") {
        const etag = typeof response.headers?.get === "function" ? response.headers.get("etag") : null;
        if (etag) {
          if (etagCache.size >= ETAG_CACHE_MAX_SIZE) {
            const firstKey = etagCache.keys().next().value;
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

  // ---------------------------------------------------------------------------
  // URL builders
  // ---------------------------------------------------------------------------

  function buildApiBase(connection: Connection): string {
    return (connection.apiBaseUrl as string) || "https://api.github.com";
  }

  // User
  function buildGetUserUrl(connection: Connection): string {
    return `${buildApiBase(connection)}/user`;
  }

  // Search
  function buildSearchIssuesUrl(connection: Connection, query: string, perPage = 100): string {
    return `${buildApiBase(connection)}/search/issues?q=${encodeURIComponent(query)}&per_page=${perPage}&sort=updated&order=desc`;
  }

  // Pulls
  function buildPullRequestUrl(
    connection: Connection,
    owner: string,
    repo: string,
    pullNumber: number | string,
  ): string {
    return `${buildApiBase(connection)}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${pullNumber}`;
  }

  function buildPullRequestFilesUrl(
    connection: Connection,
    owner: string,
    repo: string,
    pullNumber: number | string,
    perPage = 100,
  ): string {
    return `${buildApiBase(connection)}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${pullNumber}/files?per_page=${perPage}`;
  }

  // Reviews
  function buildPullRequestReviewsUrl(
    connection: Connection,
    owner: string,
    repo: string,
    pullNumber: number | string,
  ): string {
    return `${buildApiBase(connection)}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${pullNumber}/reviews`;
  }

  function buildSubmitReviewUrl(
    connection: Connection,
    owner: string,
    repo: string,
    pullNumber: number | string,
  ): string {
    return `${buildApiBase(connection)}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${pullNumber}/reviews`;
  }

  // Review comments (line-level)
  function buildReviewCommentsUrl(
    connection: Connection,
    owner: string,
    repo: string,
    pullNumber: number | string,
    perPage = 100,
  ): string {
    return `${buildApiBase(connection)}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${pullNumber}/comments?per_page=${perPage}&sort=created&direction=asc`;
  }

  // Issue comments (general conversation)
  function buildIssueCommentsUrl(
    connection: Connection,
    owner: string,
    repo: string,
    pullNumber: number | string,
    perPage = 100,
  ): string {
    return `${buildApiBase(connection)}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${pullNumber}/comments?per_page=${perPage}`;
  }

  function buildCreateIssueCommentUrl(
    connection: Connection,
    owner: string,
    repo: string,
    pullNumber: number | string,
  ): string {
    return `${buildApiBase(connection)}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${pullNumber}/comments`;
  }

  // Check runs
  function buildCheckRunsUrl(connection: Connection, owner: string, repo: string, ref: string, perPage = 100): string {
    return `${buildApiBase(connection)}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits/${ref}/check-runs?per_page=${perPage}`;
  }

  // Combined status
  function buildCombinedStatusUrl(connection: Connection, owner: string, repo: string, ref: string): string {
    return `${buildApiBase(connection)}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits/${ref}/status`;
  }

  // Review requests
  function buildRequestedReviewersUrl(
    connection: Connection,
    owner: string,
    repo: string,
    pullNumber: number | string,
  ): string {
    return `${buildApiBase(connection)}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${pullNumber}/requested_reviewers`;
  }

  // ---------------------------------------------------------------------------
  // High-level API methods
  // ---------------------------------------------------------------------------

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async function getAuthenticatedUser(connection: Connection, token: string): Promise<any> {
    return requestJson(buildGetUserUrl(connection), { token });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async function searchPullRequests(connection: Connection, token: string, query: string): Promise<any[]> {
    const result = await requestJson(buildSearchIssuesUrl(connection, query), { token });
    return result?.items || [];
  }

  async function getPullRequest(
    connection: Connection,
    token: string,
    owner: string,
    repo: string,
    pullNumber: number | string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- MIGRATION-EXEMPT: GitHub API returns open-ended JSON
  ): Promise<any> {
    return requestJson(buildPullRequestUrl(connection, owner, repo, pullNumber), { token });
  }

  async function listPullRequestFiles(
    connection: Connection,
    token: string,
    owner: string,
    repo: string,
    pullNumber: number | string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- MIGRATION-EXEMPT: GitHub API returns open-ended JSON array
  ): Promise<any[]> {
    const files: any[] = []; // eslint-disable-line @typescript-eslint/no-explicit-any -- MIGRATION-EXEMPT: accumulator for open-ended API JSON
    let page = 1;
    while (true) {
      const url = `${buildPullRequestFilesUrl(connection, owner, repo, pullNumber)}&page=${page}`;
      const batch = await requestJson(url, { token });
      if (!Array.isArray(batch) || !batch.length) break;
      files.push(...batch);
      if (batch.length < 100) break;
      page++;
    }
    return files;
  }

  async function listReviews(
    connection: Connection,
    token: string,
    owner: string,
    repo: string,
    pullNumber: number | string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- MIGRATION-EXEMPT: GitHub API returns open-ended JSON array
  ): Promise<any[]> {
    const result = await requestJson(buildPullRequestReviewsUrl(connection, owner, repo, pullNumber), { token });
    return Array.isArray(result) ? result : [];
  }

  async function listReviewComments(
    connection: Connection,
    token: string,
    owner: string,
    repo: string,
    pullNumber: number | string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- MIGRATION-EXEMPT: GitHub API returns open-ended JSON array
  ): Promise<any[]> {
    const comments: any[] = []; // eslint-disable-line @typescript-eslint/no-explicit-any -- MIGRATION-EXEMPT: accumulator for open-ended API JSON
    let page = 1;
    while (true) {
      const url = `${buildReviewCommentsUrl(connection, owner, repo, pullNumber)}&page=${page}`;
      const batch = await requestJson(url, { token });
      if (!Array.isArray(batch) || !batch.length) break;
      comments.push(...batch);
      if (batch.length < 100) break;
      page++;
    }
    return comments;
  }

  async function listIssueComments(
    connection: Connection,
    token: string,
    owner: string,
    repo: string,
    pullNumber: number | string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- MIGRATION-EXEMPT: GitHub API returns open-ended JSON array
  ): Promise<any[]> {
    const comments: any[] = []; // eslint-disable-line @typescript-eslint/no-explicit-any -- MIGRATION-EXEMPT: accumulator for open-ended API JSON
    let page = 1;
    while (true) {
      const url = `${buildIssueCommentsUrl(connection, owner, repo, pullNumber)}&page=${page}`;
      const batch = await requestJson(url, { token });
      if (!Array.isArray(batch) || !batch.length) break;
      comments.push(...batch);
      if (batch.length < 100) break;
      page++;
    }
    return comments;
  }

  async function listCheckRuns(
    connection: Connection,
    token: string,
    owner: string,
    repo: string,
    ref: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- MIGRATION-EXEMPT: GitHub API returns open-ended JSON array
  ): Promise<any[]> {
    const result = await requestJson(buildCheckRunsUrl(connection, owner, repo, ref), { token });
    return result?.check_runs || [];
  }

  async function getCombinedStatus(
    connection: Connection,
    token: string,
    owner: string,
    repo: string,
    ref: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- MIGRATION-EXEMPT: GitHub API returns open-ended JSON
  ): Promise<any> {
    return requestJson(buildCombinedStatusUrl(connection, owner, repo, ref), { token });
  }

  async function rerunCheckSuite(
    connection: Connection,
    token: string,
    owner: string,
    repo: string,
    checkSuiteId: string | number,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- MIGRATION-EXEMPT: GitHub API returns open-ended JSON
  ): Promise<any> {
    const url = `${buildApiBase(connection)}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/check-suites/${checkSuiteId}/rerequest`;
    return requestJson(url, { token, method: "POST" });
  }

  async function listRequestedReviewers(
    connection: Connection,
    token: string,
    owner: string,
    repo: string,
    pullNumber: number | string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- MIGRATION-EXEMPT: GitHub API returns open-ended JSON
  ): Promise<any> {
    return requestJson(buildRequestedReviewersUrl(connection, owner, repo, pullNumber), { token });
  }

  async function createIssueComment(
    connection: Connection,
    token: string,
    owner: string,
    repo: string,
    pullNumber: number | string,
    body: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- MIGRATION-EXEMPT: GitHub API returns open-ended JSON
  ): Promise<any> {
    return requestJson(buildCreateIssueCommentUrl(connection, owner, repo, pullNumber), {
      token,
      method: "POST",
      body: { body },
    });
  }

  async function listUserRepos(
    connection: Connection,
    token: string,
    { perPage = 100, sort = "pushed" }: ListUserReposOptions = {},
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- MIGRATION-EXEMPT: GitHub API returns open-ended JSON array
  ): Promise<any[]> {
    const repos: any[] = []; // eslint-disable-line @typescript-eslint/no-explicit-any -- MIGRATION-EXEMPT: accumulator for open-ended API JSON
    let page = 1;
    while (true) {
      const url = `${buildApiBase(connection)}/user/repos?per_page=${perPage}&sort=${sort}&direction=desc&page=${page}`;
      const batch = await requestJson(url, { token });
      if (!Array.isArray(batch) || !batch.length) break;
      repos.push(...batch);
      if (batch.length < perPage) break;
      page++;
    }
    return repos;
  }

  async function listBranches(
    connection: Connection,
    token: string,
    owner: string,
    repo: string,
    { perPage = 100 }: ListBranchesOptions = {},
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- MIGRATION-EXEMPT: GitHub API returns open-ended JSON array
  ): Promise<any[]> {
    const branches: any[] = []; // eslint-disable-line @typescript-eslint/no-explicit-any -- MIGRATION-EXEMPT: accumulator for open-ended API JSON
    let page = 1;
    while (true) {
      const url = `${buildApiBase(connection)}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/branches?per_page=${perPage}&page=${page}`;
      const batch = await requestJson(url, { token });
      if (!Array.isArray(batch) || !batch.length) break;
      branches.push(...batch);
      if (batch.length < perPage) break;
      page++;
    }
    return branches;
  }

  async function submitReview(
    connection: Connection,
    token: string,
    owner: string,
    repo: string,
    pullNumber: number | string,
    { event, body = "" }: SubmitReviewOptions,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- MIGRATION-EXEMPT: GitHub API returns open-ended JSON
  ): Promise<any> {
    return requestJson(buildSubmitReviewUrl(connection, owner, repo, pullNumber), {
      token,
      method: "POST",
      body: { event, body: body || undefined },
    });
  }

  return {
    requestJson,
    // URL builders (exposed for direct use if needed)
    buildApiBase,
    buildGetUserUrl,
    buildSearchIssuesUrl,
    buildPullRequestUrl,
    buildPullRequestFilesUrl,
    buildPullRequestReviewsUrl,
    buildSubmitReviewUrl,
    buildReviewCommentsUrl,
    buildIssueCommentsUrl,
    buildCreateIssueCommentUrl,
    buildCheckRunsUrl,
    buildCombinedStatusUrl,
    buildRequestedReviewersUrl,
    // High-level methods
    getAuthenticatedUser,
    searchPullRequests,
    getPullRequest,
    listPullRequestFiles,
    listReviews,
    listReviewComments,
    listIssueComments,
    listCheckRuns,
    getCombinedStatus,
    rerunCheckSuite,
    listRequestedReviewers,
    createIssueComment,
    submitReview,
    listUserRepos,
    listBranches,
    createPullRequest: async (
      connection: Connection,
      token: string,
      owner: string,
      repo: string,
      { title, body = "", head, base, draft = false }: CreatePullRequestOptions,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- MIGRATION-EXEMPT: GitHub API returns open-ended JSON
    ): Promise<any> => {
      return requestJson(
        `${buildApiBase(connection)}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls`,
        {
          token,
          method: "POST",
          body: { title, body: body || undefined, head, base, draft },
        },
      );
    },
  };
}
