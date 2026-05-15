import {
  createPullRequestKey,
  parseDate,
  toIsoOrNull,
  normalizeReviewState,
  normalizeCheckState,
  inferAttentionReason,
  buildPullRequestWebUrl,
  trimTrailingSlash,
} from "./github-utils.js";

import {
  findWorkspaceForPullRequest as baseFindWorkspace,
  findMatchingWorkspace,
  type GitSnapshot,
} from "./shared/pr-summary-helpers.js";

interface GithubPR {
  number?: number | string;
  title?: string;
  body?: string;
  state?: string;
  draft?: boolean;
  url?: string;
  html_url?: string;
  created_at?: string;
  updated_at?: string;
  merged_at?: string | null;
  closed_at?: string | null;
  mergeable?: boolean | null;
  mergeable_state?: string;
  base?: {
    repo?: { owner?: { login?: string }; name?: string; clone_url?: string; html_url?: string };
    ref?: string;
  };
  head?: { sha?: string; ref?: string };
  user?: { login?: string; name?: string; avatar_url?: string };
}

export function findWorkspaceForPullRequest(
  workspaces: Array<{ id: string; [key: string]: unknown }>,
  prKey: string,
): { id: string; [key: string]: unknown } | null {
  return baseFindWorkspace(workspaces, prKey, "github");
}

export { findMatchingWorkspace };

/**
 * Summarize reviewers from reviews list and requested_reviewers.
 * GitHub reviews are event-based: a user may have multiple reviews, we take the latest non-COMMENTED one.
 */
function summarizeReviewers(
  reviews: Array<Record<string, unknown>> = [],
  requestedReviewers: Record<string, unknown> | Array<Record<string, unknown>> = [],
  currentUserLogin = "",
): {
  myState: string;
  myIsRequested: boolean;
  approvedCount: number;
  changesRequestedCount: number;
  pendingCount: number;
  totalCount: number;
  reviewers: Array<{
    login: string;
    displayName: string;
    avatarUrl: string;
    state: string;
    isRequested: boolean;
    isTeam?: boolean;
  }>;
} {
  type GHUser = { login?: string; name?: string; avatar_url?: string; [key: string]: unknown };
  type GHReview = { user?: GHUser; state?: unknown; submitted_at?: unknown; [key: string]: unknown };
  type GHReviewerObj = { users?: GHUser[]; teams?: Array<{ slug?: string; name?: string }> };

  // Latest substantive review per user (skip COMMENTED — it's not a decision)
  const latestByUser = new Map<string, GHReview>();
  for (const review of reviews as GHReview[]) {
    const login = review.user?.login || "";
    if (!login) continue;
    const state = normalizeReviewState(review.state);
    if (state === "commented") continue;
    const existing = latestByUser.get(login);
    if (!existing || parseDate(review.submitted_at) > parseDate(existing.submitted_at)) {
      latestByUser.set(login, review);
    }
  }

  const reviewerMap = new Map();

  // Requested reviewers (pending)
  const rrObj = requestedReviewers as GHReviewerObj;
  const users = rrObj?.users || (Array.isArray(requestedReviewers) ? (requestedReviewers as GHUser[]) : []);
  for (const user of Array.isArray(users) ? users : []) {
    const login = user.login || "";
    if (!login) continue;
    reviewerMap.set(login, {
      login,
      displayName: user.name || user.login || "",
      avatarUrl: user.avatar_url || "",
      state: "pending",
      isRequested: true,
    });
  }

  // Requested teams
  const teams = rrObj?.teams || [];
  for (const team of Array.isArray(teams) ? teams : []) {
    const key = `team:${team.slug || team.name}`;
    reviewerMap.set(key, {
      login: key,
      displayName: team.name || team.slug || "",
      avatarUrl: "",
      state: "pending",
      isRequested: true,
      isTeam: true,
    });
  }

  // Reviews that already happened
  for (const [login, review] of latestByUser) {
    const state = normalizeReviewState(review.state);
    reviewerMap.set(login, {
      login,
      displayName: review.user?.name || review.user?.login || login,
      avatarUrl: review.user?.avatar_url || "",
      state,
      isRequested: false,
    });
  }

  const allReviewers = [...reviewerMap.values()];
  const myReview = allReviewers.find((r) => r.login.toLowerCase() === (currentUserLogin || "").toLowerCase());

  return {
    myState: myReview?.state || "",
    myIsRequested: myReview?.isRequested || false,
    approvedCount: allReviewers.filter((r) => r.state === "approved").length,
    changesRequestedCount: allReviewers.filter((r) => r.state === "changes_requested").length,
    pendingCount: allReviewers.filter((r) => r.state === "pending").length,
    totalCount: allReviewers.length,
    reviewers: allReviewers,
  };
}

/**
 * Build check summary from check runs and combined status.
 */
function buildCheckSummary(
  checkRuns: Array<Record<string, unknown>> = [],
  combinedStatus: Record<string, unknown> | null = null,
): {
  failedCount: number;
  pendingCount: number;
  passedCount: number;
  items: unknown[];
} {
  type CheckItem = {
    id: string;
    kind: string;
    checkSuiteId: unknown;
    name: string;
    description: string;
    state: string;
    stateLabel: string;
    url: string;
    startTime: unknown;
    finishTime: unknown;
  };
  const items: CheckItem[] = [];

  for (const run of checkRuns) {
    const checkSuite = (run.check_suite || {}) as { id?: unknown };
    const output = (run.output || {}) as { title?: string };
    const state = normalizeCheckState(run.conclusion || run.status);
    items.push({
      id: `check:${run.id}`,
      kind: "check",
      checkSuiteId: checkSuite.id || null,
      name: String(run.name || "Check"),
      description: output.title || "",
      state,
      stateLabel:
        state === "failed" ? "failed" : state === "pending" ? "pending" : state === "succeeded" ? "passed" : "unknown",
      url: String(run.html_url || run.details_url || ""),
      startTime: run.started_at || null,
      finishTime: run.completed_at || null,
    });
  }

  if (combinedStatus?.statuses) {
    for (const status of combinedStatus.statuses as Array<Record<string, unknown>>) {
      const state = normalizeCheckState(status.state);
      items.push({
        id: `status:${status.id || status.context}`,
        kind: "status",
        checkSuiteId: null,
        name: String(status.context || "Status"),
        description: String(status.description || ""),
        state,
        stateLabel:
          state === "failed"
            ? "failed"
            : state === "pending"
              ? "pending"
              : state === "succeeded"
                ? "passed"
                : "unknown",
        url: String(status.target_url || ""),
        startTime: status.created_at || null,
        finishTime: status.updated_at || null,
      });
    }
  }

  const priority: Record<string, number> = { failed: 4, pending: 3, succeeded: 2, unknown: 1 };
  items.sort((a, b) => (priority[b.state] || 0) - (priority[a.state] || 0));

  return {
    failedCount: items.filter((i) => i.state === "failed").length,
    pendingCount: items.filter((i) => i.state === "pending").length,
    passedCount: items.filter((i) => i.state === "succeeded").length,
    items,
  };
}

/**
 * Group review comments into threads by in_reply_to_id.
 */
function groupReviewCommentThreads(
  reviewComments: Array<Record<string, unknown>> = [],
): Array<Record<string, unknown>> {
  const rootMap = new Map();
  const childMap = new Map(); // parentId → [comments]

  for (const comment of reviewComments) {
    if (comment.in_reply_to_id) {
      const rootId = comment.in_reply_to_id;
      if (!childMap.has(rootId)) childMap.set(rootId, []);
      childMap.get(rootId).push(comment);
    } else {
      rootMap.set(comment.id, comment);
    }
  }

  const threads = [];
  for (const [rootId, rootComment] of rootMap) {
    const replies = childMap.get(rootId) || [];
    // Also check if any reply is itself a root for deeper threads
    for (const reply of [...replies]) {
      const deepReplies = childMap.get(reply.id);
      if (deepReplies) {
        replies.push(...deepReplies);
        childMap.delete(reply.id);
      }
    }

    const allComments = [rootComment, ...replies].sort((a, b) => parseDate(a.created_at) - parseDate(b.created_at));

    threads.push({
      id: rootId,
      filePath: rootComment.path || "",
      lineStart: rootComment.original_line || rootComment.line || null,
      lineEnd: rootComment.original_line || rootComment.line || null,
      side: rootComment.side || "RIGHT",
      diffHunk: rootComment.diff_hunk || "",
      publishedDate: rootComment.created_at || null,
      lastUpdatedDate: allComments.at(-1)?.updated_at || allComments.at(-1)?.created_at || null,
      comments: allComments.map((c) => {
        const cu = (c.user || {}) as { login?: string; name?: string; avatar_url?: string };
        return {
          id: c.id,
          body: c.body || "",
          createdAt: c.created_at || null,
          updatedAt: c.updated_at || null,
          author: {
            login: cu.login || "",
            displayName: cu.name || cu.login || "",
            avatarUrl: cu.avatar_url || "",
          },
        };
      }),
    });
  }

  return threads.sort((a, b) => parseDate(a.publishedDate) - parseDate(b.publishedDate));
}

export function buildPullRequestSummary({
  connection,
  pr,
  reviews = [],
  reviewComments = [],
  issueComments = [],
  requestedReviewers = [],
  checkRuns = [],
  combinedStatus = null,
  tracked = {},
  workspaces = [],
  gitSnapshots = {},
  activeProfileId = "default",
  now: _now = () => Date.now(),
}: {
  connection: { id: string; label?: string; hostUrl?: string; currentUserLogin?: string; profileId?: string };
  pr: Record<string, unknown>;
  reviews?: Array<Record<string, unknown>>;
  reviewComments?: Array<Record<string, unknown>>;
  issueComments?: Array<Record<string, unknown>>;
  requestedReviewers?: Record<string, unknown> | Array<Record<string, unknown>>;
  checkRuns?: Array<Record<string, unknown>>;
  combinedStatus?: Record<string, unknown> | null;
  tracked?: Record<string, unknown>;
  workspaces?: Array<{ id: string; profileId?: string; [key: string]: unknown }>;
  gitSnapshots?: Record<string, unknown>;
  /** Defensive fallback when connection.profileId is empty (legacy/pre-migration). */
  activeProfileId?: string;
  now?: () => number;
}): { summary: Record<string, unknown>; internals: Record<string, unknown> } {
  type GHComment = {
    id?: unknown;
    body?: string;
    user?: { login?: string; name?: string; avatar_url?: string };
    created_at?: string;
    updated_at?: string;
    [key: string]: unknown;
  };
  type GHReviewEntry = {
    id?: unknown;
    state?: string;
    body?: string;
    submitted_at?: string;
    user?: { login?: string; name?: string; avatar_url?: string };
    [key: string]: unknown;
  };
  const p = pr as GithubPR;
  const owner = p.base?.repo?.owner?.login || "";
  const repo = p.base?.repo?.name || "";
  const pullNumber = p.number ?? "";
  const prKey = createPullRequestKey(connection.id, owner, repo, pullNumber);
  const currentUserLogin = connection.currentUserLogin || "";
  const isAuthor = (p.user?.login || "").toLowerCase() === currentUserLogin.toLowerCase();
  const reviewerInfo = summarizeReviewers(reviews, requestedReviewers, currentUserLogin);
  const isReviewer = !isAuthor && (reviewerInfo.myIsRequested || reviewerInfo.myState !== "");
  const role = isAuthor ? "author" : isReviewer ? "reviewer" : "observer";

  const threads = groupReviewCommentThreads(reviewComments);

  // Compute latest activity timestamps
  const allCommentDates = [
    ...issueComments.map((c) => parseDate(c.updated_at || c.created_at)),
    ...reviewComments.map((c) => parseDate(c.updated_at || c.created_at)),
    ...reviews.map((r) => parseDate(r.submitted_at)),
  ];
  const latestCommentAt = Math.max(...allCommentDates, 0);
  const latestPushAt = parseDate(p.updated_at);
  const latestPrAt = parseDate(p.created_at);
  const lastRemoteActivityAt = toIsoOrNull(Math.max(latestCommentAt, latestPushAt, latestPrAt));

  // New comments since last seen
  const lastSeenAt = parseDate(tracked.lastSeenActivityAt);
  const otherIssueComments = (issueComments as GHComment[]).filter(
    (c) => (c.user?.login || "").toLowerCase() !== currentUserLogin.toLowerCase(),
  );
  const otherReviewComments = (reviewComments as GHComment[]).filter(
    (c) => (c.user?.login || "").toLowerCase() !== currentUserLogin.toLowerCase(),
  );
  const newCommentsCount = [
    ...otherIssueComments.filter((c) => parseDate(c.updated_at || c.created_at) > lastSeenAt),
    ...otherReviewComments.filter((c) => parseDate(c.updated_at || c.created_at) > lastSeenAt),
  ].length;

  // Review state signature for change detection
  const reviewStateSignature = reviewerInfo.reviewers
    .map((r) => `${r.login}:${r.state}:${r.isRequested ? 1 : 0}`)
    .sort()
    .join("|");
  const reviewStateChanged = Boolean(
    tracked.lastReviewStateSignature && tracked.lastReviewStateSignature !== reviewStateSignature,
  );

  // Source branch updated
  const headSha = p.head?.sha || "";
  const sourceUpdated = Boolean(tracked.lastHeadSha && tracked.lastHeadSha !== headSha);

  // Checks
  const checks = buildCheckSummary(checkRuns, combinedStatus);
  const checksFailed = checks.failedCount > 0;
  const checksSignature = `${checks.failedCount}:${checks.pendingCount}:${checks.passedCount}`;
  const checksChanged = Boolean(tracked.lastChecksSignature && tracked.lastChecksSignature !== checksSignature);

  const attentionReason = inferAttentionReason({
    role,
    newCommentsCount,
    sourceUpdated,
    reviewStateChanged,
    checksChanged,
    checksFailed,
  });

  // Workspace matching — scope to the connection's owning profile so a PR
  // fetched via a profile-B connection looks up its review workspace among
  // profile-B's workspaces, not whichever profile happens to be "active".
  const summaryProfileId = connection.profileId || activeProfileId;
  const profileWorkspaces = workspaces.filter((ws) => (ws.profileId || "default") === summaryProfileId);
  const reviewWorkspace = findWorkspaceForPullRequest(profileWorkspaces, prKey);
  const matchingWorkspace = findMatchingWorkspace(
    {
      repository: { remoteUrl: p.base?.repo?.clone_url || p.base?.repo?.html_url || "" },
      pullRequest: { sourceRefName: p.head?.ref || "" },
      role,
    },
    profileWorkspaces,
    gitSnapshots as Record<string, GitSnapshot>,
  );

  const trackedReviewWsId = tracked.reviewWorkspaceId || "";
  const trackedReviewInProfile = trackedReviewWsId && profileWorkspaces.some((ws) => ws.id === trackedReviewWsId);

  const hostUrl = trimTrailingSlash(connection.hostUrl || "https://github.com");

  const summary = {
    provider: "github",
    prKey,
    connectionId: connection.id,
    // See Azure counterpart — surfacing the connection's profile lets
    // Telegram alert dispatch route by profile when the PR has no
    // review/existing workspace yet.
    profileId: connection.profileId || activeProfileId,
    connectionLabel: connection.label || connection.id,
    hostUrl,
    repository: {
      owner,
      name: repo,
      fullName: `${owner}/${repo}`,
      remoteUrl:
        p.base?.repo?.clone_url ||
        buildPullRequestWebUrl(hostUrl, owner, repo, pullNumber).replace(`/pull/${pullNumber}`, ""),
    },
    pullRequest: {
      id: pullNumber,
      number: pullNumber,
      title: p.title || `PR #${pullNumber}`,
      body: p.body || "",
      state: p.state || "open",
      draft: Boolean(p.draft),
      url: p.url || "",
      webUrl: p.html_url || buildPullRequestWebUrl(hostUrl, owner, repo, pullNumber),
      sourceRefName: p.head?.ref || "",
      targetRefName: p.base?.ref || "",
      headSha: headSha,
      createdAt: p.created_at || null,
      updatedAt: p.updated_at || null,
      mergedAt: p.merged_at || null,
      closedAt: p.closed_at || null,
      mergeable: p.mergeable ?? null,
      mergeableState: p.mergeable_state || "",
    },
    author: {
      login: p.user?.login || "",
      displayName: p.user?.name || p.user?.login || "Unknown author",
      avatarUrl: p.user?.avatar_url || "",
    },
    role,
    reviewerSummary: reviewerInfo,
    reviewWorkspaceId: reviewWorkspace?.id || (trackedReviewInProfile ? trackedReviewWsId : ""),
    existingWorkspaceId: matchingWorkspace?.id || "",
    lastSeenActivityAt: tracked.lastSeenActivityAt || null,
    lastRemoteActivityAt,
    lastActivityAt: lastRemoteActivityAt,
    hasAttention: Boolean(attentionReason),
    attentionReason,
    newCommentsCount,
    threads,
    issueComments: (issueComments as GHComment[]).map((c) => ({
      id: c.id,
      body: c.body || "",
      createdAt: c.created_at || null,
      updatedAt: c.updated_at || null,
      author: {
        login: c.user?.login || "",
        displayName: c.user?.name || c.user?.login || "",
        avatarUrl: c.user?.avatar_url || "",
      },
    })),
    reviews: (reviews as GHReviewEntry[])
      .filter((r) => r.state !== "PENDING")
      .map((r) => ({
        id: r.id,
        state: normalizeReviewState(r.state),
        body: r.body || "",
        submittedAt: r.submitted_at || null,
        author: {
          login: r.user?.login || "",
          displayName: r.user?.name || r.user?.login || "",
          avatarUrl: r.user?.avatar_url || "",
        },
      }))
      .sort((a, b) => parseDate(b.submittedAt) - parseDate(a.submittedAt)),
    checks,
    commentCount: issueComments.length + reviewComments.length,
  };

  // Raw signals for the manager's sync() delta detection. Keeping these out of
  // the summary avoids leaking implementation details into the broadcast
  // payload and the UI.
  const internals = {
    reviewStateSignature,
    headSha,
    checksSignature,
    otherIssueComments,
    otherReviewComments,
    reviews,
    reviewerMap: new Map(reviewerInfo.reviewers.map((reviewer) => [reviewer.login, reviewer])),
    myLogin: currentUserLogin,
    checksFailedCount: checks.failedCount,
    mergeableState: p.mergeable_state || "",
  };

  return { summary, internals };
}
