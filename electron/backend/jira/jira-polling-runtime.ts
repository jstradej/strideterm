import type { JiraPollRequest, JiraPollResult } from "./jira-polling.js";
import { JiraRequestError, type JiraRequestErrorCode } from "./jira-request-error.js";

export interface JiraPollPage {
  issues: JiraPollingSearchIssue[];
  hasMore: boolean;
  nextCursor?: string;
  cache: { refreshError?: { code: JiraRequestErrorCode; message: string; retryAfterMs?: number } };
}

/**
 * One poll of a saved query. Every page is read from Jira (never the cache), and a page the manager answered from a
 * stale cache because the refresh FAILED is a failure, not a snapshot: taken as "complete" it would tell the user
 * that nothing changed. A rate limit becomes the poller's own `rate-limited` result so its wait is honoured; with no `Retry-After` the poller backs off by itself.
 */
export async function pollJiraQuery(
  request: JiraPollRequest,
  search: (cursor: string | undefined, limit: number) => Promise<JiraPollPage | null>,
  now: () => number = Date.now,
): Promise<JiraPollResult> {
  try {
    return await collectJiraPollSnapshot(
      request,
      async (cursor, limit) => {
        const page = await search(cursor, limit);
        if (!page) throw new JiraRequestError("unknown", "Jira returned no page for a polled query.");
        const refreshError = page.cache.refreshError;
        if (refreshError)
          throw new JiraRequestError(refreshError.code, refreshError.message, refreshError.retryAfterMs);
        return { issues: page.issues, hasMore: page.hasMore, nextCursor: page.nextCursor };
      },
      now,
    );
  } catch (error) {
    if (error instanceof JiraRequestError && error.code === "rate-limited")
      return {
        kind: "rate-limited",
        ...(error.retryAfterMs !== undefined ? { retryAfterMs: error.retryAfterMs } : {}),
      };
    throw error;
  }
}

export interface JiraPollingSearchIssue {
  ref: { issueId: string; issueKey: string };
  updated: string;
}

/** Read bounded pages and never label a capped/truncated result complete. */
export async function collectJiraPollSnapshot(
  request: JiraPollRequest,
  searchPage: (
    cursor: string | undefined,
    limit: number,
  ) => Promise<{
    issues: JiraPollingSearchIssue[];
    hasMore: boolean;
    nextCursor?: string;
  }>,
  now: () => number = Date.now,
): Promise<JiraPollResult> {
  const issues = new Map<string, { issueId: string; issueKey: string; updatedAt: number }>();
  let cursor: string | undefined;
  const seenCursors = new Set<string>();
  for (let pageIndex = 0; pageIndex < request.maxRequests; pageIndex += 1) {
    const remaining = request.maxIssues - issues.size;
    if (remaining <= 0)
      return { kind: "snapshot", supported: true, complete: false, observedAt: now(), issues: [...issues.values()] };
    const page = await searchPage(cursor, Math.min(100, remaining));
    for (const item of page.issues) {
      if (issues.size >= request.maxIssues) break;
      issues.set(item.ref.issueId, {
        issueId: item.ref.issueId,
        issueKey: item.ref.issueKey,
        updatedAt: Date.parse(item.updated) || 0,
      });
    }
    if (!page.hasMore)
      return { kind: "snapshot", supported: true, complete: true, observedAt: now(), issues: [...issues.values()] };
    if (
      !page.nextCursor ||
      seenCursors.has(page.nextCursor) ||
      pageIndex + 1 >= request.maxRequests ||
      issues.size >= request.maxIssues
    ) {
      return { kind: "snapshot", supported: true, complete: false, observedAt: now(), issues: [...issues.values()] };
    }
    seenCursors.add(page.nextCursor);
    cursor = page.nextCursor;
  }
  return { kind: "snapshot", supported: true, complete: false, observedAt: now(), issues: [...issues.values()] };
}
