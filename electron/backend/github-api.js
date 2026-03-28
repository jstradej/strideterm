/**
 * GitHub REST API client — raw fetch with ETag caching and audit logging.
 *
 * Mirrors the shape of azure-devops-api.js:
 *   createGitHubApi(fetchImpl, { auditLogger }) → { requestJson, ...endpoint helpers }
 *
 * Auth: Bearer token (PAT).  Works with github.com and GitHub Enterprise Server.
 */

const GITHUB_API_VERSION = "2022-11-28";

export function createGitHubApi(fetchImpl, { auditLogger } = {}) {
  const etagCache = new Map();
  const ETAG_CACHE_MAX_SIZE = 200;

  async function requestJson(
    url,
    { token, method = "GET", body = null, headers = {}, accept = "application/vnd.github+json" } = {},
  ) {
    const startTime = Date.now();
    let statusCode = 0;

    const requestHeaders = {
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

      const data = await response.json();

      if (method === "GET") {
        const etag = typeof response.headers?.get === "function" ? response.headers.get("etag") : null;
        if (etag) {
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

  // ---------------------------------------------------------------------------
  // URL builders
  // ---------------------------------------------------------------------------

  function buildApiBase(connection) {
    return connection.apiBaseUrl || "https://api.github.com";
  }

  // User
  function buildGetUserUrl(connection) {
    return `${buildApiBase(connection)}/user`;
  }

  // Search
  function buildSearchIssuesUrl(connection, query, perPage = 100) {
    return `${buildApiBase(connection)}/search/issues?q=${encodeURIComponent(query)}&per_page=${perPage}&sort=updated&order=desc`;
  }

  // Pulls
  function buildPullRequestUrl(connection, owner, repo, pullNumber) {
    return `${buildApiBase(connection)}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${pullNumber}`;
  }

  function buildPullRequestFilesUrl(connection, owner, repo, pullNumber, perPage = 100) {
    return `${buildApiBase(connection)}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${pullNumber}/files?per_page=${perPage}`;
  }

  // Reviews
  function buildPullRequestReviewsUrl(connection, owner, repo, pullNumber) {
    return `${buildApiBase(connection)}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${pullNumber}/reviews`;
  }

  function buildSubmitReviewUrl(connection, owner, repo, pullNumber) {
    return `${buildApiBase(connection)}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${pullNumber}/reviews`;
  }

  // Review comments (line-level)
  function buildReviewCommentsUrl(connection, owner, repo, pullNumber, perPage = 100) {
    return `${buildApiBase(connection)}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${pullNumber}/comments?per_page=${perPage}&sort=created&direction=asc`;
  }

  // Issue comments (general conversation)
  function buildIssueCommentsUrl(connection, owner, repo, pullNumber, perPage = 100) {
    return `${buildApiBase(connection)}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${pullNumber}/comments?per_page=${perPage}`;
  }

  function buildCreateIssueCommentUrl(connection, owner, repo, pullNumber) {
    return `${buildApiBase(connection)}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${pullNumber}/comments`;
  }

  // Check runs
  function buildCheckRunsUrl(connection, owner, repo, ref, perPage = 100) {
    return `${buildApiBase(connection)}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits/${ref}/check-runs?per_page=${perPage}`;
  }

  // Combined status
  function buildCombinedStatusUrl(connection, owner, repo, ref) {
    return `${buildApiBase(connection)}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits/${ref}/status`;
  }

  // Review requests
  function buildRequestedReviewersUrl(connection, owner, repo, pullNumber) {
    return `${buildApiBase(connection)}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${pullNumber}/requested_reviewers`;
  }

  // ---------------------------------------------------------------------------
  // High-level API methods
  // ---------------------------------------------------------------------------

  async function getAuthenticatedUser(connection, token) {
    return requestJson(buildGetUserUrl(connection), { token });
  }

  async function searchPullRequests(connection, token, query) {
    const result = await requestJson(buildSearchIssuesUrl(connection, query), { token });
    return result?.items || [];
  }

  async function getPullRequest(connection, token, owner, repo, pullNumber) {
    return requestJson(buildPullRequestUrl(connection, owner, repo, pullNumber), { token });
  }

  async function listPullRequestFiles(connection, token, owner, repo, pullNumber) {
    const files = [];
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

  async function listReviews(connection, token, owner, repo, pullNumber) {
    const result = await requestJson(buildPullRequestReviewsUrl(connection, owner, repo, pullNumber), { token });
    return Array.isArray(result) ? result : [];
  }

  async function listReviewComments(connection, token, owner, repo, pullNumber) {
    const comments = [];
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

  async function listIssueComments(connection, token, owner, repo, pullNumber) {
    const comments = [];
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

  async function listCheckRuns(connection, token, owner, repo, ref) {
    const result = await requestJson(buildCheckRunsUrl(connection, owner, repo, ref), { token });
    return result?.check_runs || [];
  }

  async function getCombinedStatus(connection, token, owner, repo, ref) {
    return requestJson(buildCombinedStatusUrl(connection, owner, repo, ref), { token });
  }

  async function listRequestedReviewers(connection, token, owner, repo, pullNumber) {
    return requestJson(buildRequestedReviewersUrl(connection, owner, repo, pullNumber), { token });
  }

  async function createIssueComment(connection, token, owner, repo, pullNumber, body) {
    return requestJson(buildCreateIssueCommentUrl(connection, owner, repo, pullNumber), {
      token,
      method: "POST",
      body: { body },
    });
  }

  async function listUserRepos(connection, token, { perPage = 100, sort = "pushed" } = {}) {
    const repos = [];
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

  async function listBranches(connection, token, owner, repo, { perPage = 100 } = {}) {
    const branches = [];
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

  async function submitReview(connection, token, owner, repo, pullNumber, { event, body = "" }) {
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
    listRequestedReviewers,
    createIssueComment,
    submitReview,
    listUserRepos,
    listBranches,
    createPullRequest: async (connection, token, owner, repo, { title, body = "", head, base, draft = false }) => {
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
