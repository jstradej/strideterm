/**
 * GitHub REST API client — raw fetch with ETag caching and audit logging.
 *
 * Mirrors the shape of azure-devops-api.js:
 *   createGitHubApi(fetchImpl, { auditLogger }) → { requestJson, ...endpoint helpers }
 *
 * Auth: Bearer token (PAT).  Works with github.com and GitHub Enterprise Server.
 */

import { createEtagJsonClient } from "./shared/etag-json-client.js";

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

export function createGitHubApi(
  fetchImpl: typeof globalThis.fetch,
  { auditLogger }: { auditLogger?: (entry: AuditEntry) => void } = {},
) {
  const { requestJson } = createEtagJsonClient<RequestJsonOptions>(fetchImpl, {
    buildJsonHeaders({ token, headers = {}, accept = "application/vnd.github+json" }) {
      return {
        Accept: accept,
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": GITHUB_API_VERSION,
        ...headers,
      };
    },
    errorPrefix: "GitHub",
    extractErrorMessage(parsedBody, fallback) {
      const parsed = parsedBody as { message?: string };
      return parsed?.message || fallback;
    },
    treatNoContentAsNull: true,
    auditLogger,
  });

  /**
   * Follows GitHub's page-number pagination (`?page=N`) for a list endpoint,
   * aggregating every page's items into one array. Stops when a page comes
   * back empty/non-array, or short of `perPage` (the standard signal that it
   * was the last page) — matching the per-endpoint loops this replaces.
   */
  async function paginate(
    buildPageUrl: (page: number) => string,
    token: string | undefined,
    perPage: number,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- MIGRATION-EXEMPT: GitHub API returns open-ended JSON array
  ): Promise<any[]> {
    const results: any[] = []; // eslint-disable-line @typescript-eslint/no-explicit-any -- MIGRATION-EXEMPT: accumulator for open-ended API JSON
    let page = 1;
    while (true) {
      const batch = await requestJson(buildPageUrl(page), { token });
      if (!Array.isArray(batch) || !batch.length) break;
      results.push(...batch);
      if (batch.length < perPage) break;
      page++;
    }
    return results;
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
    return paginate((page) => `${buildPullRequestFilesUrl(connection, owner, repo, pullNumber)}&page=${page}`, token, 100);
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
    return paginate((page) => `${buildReviewCommentsUrl(connection, owner, repo, pullNumber)}&page=${page}`, token, 100);
  }

  async function listIssueComments(
    connection: Connection,
    token: string,
    owner: string,
    repo: string,
    pullNumber: number | string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- MIGRATION-EXEMPT: GitHub API returns open-ended JSON array
  ): Promise<any[]> {
    return paginate((page) => `${buildIssueCommentsUrl(connection, owner, repo, pullNumber)}&page=${page}`, token, 100);
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
    return paginate(
      (page) => `${buildApiBase(connection)}/user/repos?per_page=${perPage}&sort=${sort}&direction=desc&page=${page}`,
      token,
      perPage,
    );
  }

  async function listBranches(
    connection: Connection,
    token: string,
    owner: string,
    repo: string,
    { perPage = 100 }: ListBranchesOptions = {},
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- MIGRATION-EXEMPT: GitHub API returns open-ended JSON array
  ): Promise<any[]> {
    return paginate(
      (page) =>
        `${buildApiBase(connection)}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/branches?per_page=${perPage}&page=${page}`,
      token,
      perPage,
    );
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
    paginate,
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
