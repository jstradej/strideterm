import {
  createPullRequestKey,
  parseDate,
  toIsoOrNull,
  firstNonEmpty,
  normalizeRemoteUrl,
  normalizeReviewState,
  normalizeCheckState,
  inferAttentionReason,
  buildPullRequestWebUrl,
  trimTrailingSlash,
} from "./github-utils.js";

export function findWorkspaceForPullRequest(workspaces, prKey) {
  return (workspaces || []).find((ws) => ws.review?.provider === "github" && ws.review?.prKey === prKey) || null;
}

export function findMatchingWorkspace(summary, workspaces = [], gitSnapshots = {}) {
  const targetRemote = normalizeRemoteUrl(summary.repository?.remoteUrl || "");
  const sourceBranch = summary.pullRequest?.sourceRefName || "";
  return workspaces.find((ws) => {
    if (ws.kind === "docker" || !ws.cwd) return false;
    const snapshot = gitSnapshots?.[ws.id];
    const origin = normalizeRemoteUrl(snapshot?.remotes?.origin || "");
    if (targetRemote && origin && origin !== targetRemote) return false;
    if (summary.role === "author" && snapshot?.branch && sourceBranch) {
      return snapshot.branch === sourceBranch;
    }
    return origin && origin === targetRemote;
  }) || null;
}

/**
 * Summarize reviewers from reviews list and requested_reviewers.
 * GitHub reviews are event-based: a user may have multiple reviews, we take the latest non-COMMENTED one.
 */
function summarizeReviewers(reviews = [], requestedReviewers = [], currentUserLogin = "") {
  // Latest substantive review per user (skip COMMENTED — it's not a decision)
  const latestByUser = new Map();
  for (const review of reviews) {
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
  const users = requestedReviewers?.users || requestedReviewers || [];
  for (const user of (Array.isArray(users) ? users : [])) {
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
  const teams = requestedReviewers?.teams || [];
  for (const team of (Array.isArray(teams) ? teams : [])) {
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
function buildCheckSummary(checkRuns = [], combinedStatus = null) {
  const items = [];

  for (const run of checkRuns) {
    const state = normalizeCheckState(run.conclusion || run.status);
    items.push({
      id: `check:${run.id}`,
      kind: "check",
      name: run.name || "Check",
      description: run.output?.title || "",
      state,
      stateLabel: state === "failed" ? "failed" : (state === "pending" ? "pending" : (state === "succeeded" ? "passed" : "unknown")),
      url: run.html_url || run.details_url || "",
    });
  }

  if (combinedStatus?.statuses) {
    for (const status of combinedStatus.statuses) {
      const state = normalizeCheckState(status.state);
      items.push({
        id: `status:${status.id || status.context}`,
        kind: "status",
        name: status.context || "Status",
        description: status.description || "",
        state,
        stateLabel: state === "failed" ? "failed" : (state === "pending" ? "pending" : (state === "succeeded" ? "passed" : "unknown")),
        url: status.target_url || "",
      });
    }
  }

  items.sort((a, b) => {
    const priority = { failed: 4, pending: 3, succeeded: 2, unknown: 1 };
    return (priority[b.state] || 0) - (priority[a.state] || 0);
  });

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
function groupReviewCommentThreads(reviewComments = []) {
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

    const allComments = [rootComment, ...replies].sort(
      (a, b) => parseDate(a.created_at) - parseDate(b.created_at),
    );

    threads.push({
      id: rootId,
      filePath: rootComment.path || "",
      lineStart: rootComment.original_line || rootComment.line || null,
      lineEnd: rootComment.original_line || rootComment.line || null,
      side: rootComment.side || "RIGHT",
      diffHunk: rootComment.diff_hunk || "",
      publishedDate: rootComment.created_at || null,
      lastUpdatedDate: allComments.at(-1)?.updated_at || allComments.at(-1)?.created_at || null,
      comments: allComments.map((c) => ({
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
  now = () => Date.now(),
}) {
  const owner = pr.base?.repo?.owner?.login || "";
  const repo = pr.base?.repo?.name || "";
  const pullNumber = pr.number;
  const prKey = createPullRequestKey(connection.id, owner, repo, pullNumber);
  const currentUserLogin = connection.currentUserLogin || "";
  const isAuthor = (pr.user?.login || "").toLowerCase() === currentUserLogin.toLowerCase();
  const reviewerInfo = summarizeReviewers(reviews, requestedReviewers, currentUserLogin);
  const isReviewer = !isAuthor && (reviewerInfo.myIsRequested || reviewerInfo.myState !== "");
  const role = isAuthor ? "author" : (isReviewer ? "reviewer" : "observer");

  const threads = groupReviewCommentThreads(reviewComments);

  // Compute latest activity timestamps
  const allCommentDates = [
    ...issueComments.map((c) => parseDate(c.updated_at || c.created_at)),
    ...reviewComments.map((c) => parseDate(c.updated_at || c.created_at)),
    ...reviews.map((r) => parseDate(r.submitted_at)),
  ];
  const latestCommentAt = Math.max(...allCommentDates, 0);
  const latestPushAt = parseDate(pr.updated_at);
  const latestPrAt = parseDate(pr.created_at);
  const lastRemoteActivityAt = toIsoOrNull(Math.max(latestCommentAt, latestPushAt, latestPrAt));

  // New comments since last seen
  const lastSeenAt = parseDate(tracked.lastSeenActivityAt);
  const otherIssueComments = issueComments.filter((c) => (c.user?.login || "").toLowerCase() !== currentUserLogin.toLowerCase());
  const otherReviewComments = reviewComments.filter((c) => (c.user?.login || "").toLowerCase() !== currentUserLogin.toLowerCase());
  const newCommentsCount = [
    ...otherIssueComments.filter((c) => parseDate(c.updated_at || c.created_at) > lastSeenAt),
    ...otherReviewComments.filter((c) => parseDate(c.updated_at || c.created_at) > lastSeenAt),
  ].length;

  // Review state signature for change detection
  const reviewStateSignature = reviewerInfo.reviewers
    .map((r) => `${r.login}:${r.state}:${r.isRequested ? 1 : 0}`)
    .sort()
    .join("|");
  const reviewStateChanged = Boolean(tracked.lastReviewStateSignature && tracked.lastReviewStateSignature !== reviewStateSignature);

  // Source branch updated
  const headSha = pr.head?.sha || "";
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

  // Workspace matching
  const profileWorkspaces = workspaces.filter((ws) => (ws.profileId || "default") === activeProfileId);
  const reviewWorkspace = findWorkspaceForPullRequest(profileWorkspaces, prKey);
  const matchingWorkspace = findMatchingWorkspace(
    {
      repository: { remoteUrl: pr.base?.repo?.clone_url || pr.base?.repo?.html_url || "" },
      pullRequest: { sourceRefName: pr.head?.ref || "" },
      role,
    },
    profileWorkspaces,
    gitSnapshots,
  );

  const trackedReviewWsId = tracked.reviewWorkspaceId || "";
  const trackedReviewInProfile = trackedReviewWsId && profileWorkspaces.some((ws) => ws.id === trackedReviewWsId);

  const hostUrl = trimTrailingSlash(connection.hostUrl || "https://github.com");

  return {
    provider: "github",
    prKey,
    connectionId: connection.id,
    connectionLabel: connection.label || connection.id,
    hostUrl,
    repository: {
      owner,
      name: repo,
      fullName: `${owner}/${repo}`,
      remoteUrl: pr.base?.repo?.clone_url || buildPullRequestWebUrl(hostUrl, owner, repo, pullNumber).replace(`/pull/${pullNumber}`, ""),
    },
    pullRequest: {
      id: pullNumber,
      number: pullNumber,
      title: pr.title || `PR #${pullNumber}`,
      body: pr.body || "",
      state: pr.state || "open",
      draft: Boolean(pr.draft),
      url: pr.url || "",
      webUrl: pr.html_url || buildPullRequestWebUrl(hostUrl, owner, repo, pullNumber),
      sourceRefName: pr.head?.ref || "",
      targetRefName: pr.base?.ref || "",
      headSha: headSha,
      createdAt: pr.created_at || null,
      updatedAt: pr.updated_at || null,
      mergedAt: pr.merged_at || null,
      mergeable: pr.mergeable ?? null,
      mergeableState: pr.mergeable_state || "",
    },
    author: {
      login: pr.user?.login || "",
      displayName: pr.user?.name || pr.user?.login || "Unknown author",
      avatarUrl: pr.user?.avatar_url || "",
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
    issueComments: issueComments.map((c) => ({
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
    reviews: reviews
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
    // Tracking signatures (not exposed in UI, used for change detection)
    _reviewStateSignature: reviewStateSignature,
    _headSha: headSha,
    _checksSignature: checksSignature,
  };
}
