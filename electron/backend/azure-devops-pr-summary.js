import {
  createPullRequestKey,
  trimTrailingSlash,
  firstNonEmpty,
  parseDate,
  toIsoOrNull,
  identityMatches,
  extractComments,
  summarizeReviewers,
  buildRepositoryRemoteUrl,
  computeThreadStatusCounts,
  compareThreads,
  inferAttentionReason,
} from "./azure-devops-utils.js";

import {
  findWorkspaceForPullRequest as baseFindWorkspace,
  findMatchingWorkspace,
} from "./shared/pr-summary-helpers.js";

export function findWorkspaceForPullRequest(workspaces, prKey) {
  return baseFindWorkspace(workspaces, prKey, "azure-devops");
}

export { findMatchingWorkspace };

export function buildPullRequestSummary({
  connection,
  pr,
  projectName,
  threads,
  tracked = {},
  workspaces = [],
  gitSnapshots = {},
  activeProfileId = "default",
  now: _now = () => Date.now(),
}) {
  const repositoryId = pr.repository?.id || "";
  const prKey = createPullRequestKey(connection.id, repositoryId, pr.pullRequestId);
  const comments = extractComments(threads);
  const reviewerInfo = summarizeReviewers(pr.reviewers || [], connection.login);
  const isAuthor = identityMatches(connection.login, pr.createdBy);
  const isReviewer =
    !isAuthor && reviewerInfo.reviewers.some((reviewer) => identityMatches(connection.login, reviewer));
  const role = isAuthor ? "author" : isReviewer ? "reviewer" : "observer";
  const latestCommentAt = Math.max(
    ...comments.map((comment) => parseDate(comment.lastUpdatedDate || comment.publishedDate)),
    0,
  );
  const latestCommitAt = parseDate(pr.lastMergeSourceCommit?.committer?.date);
  const latestPrAt = parseDate(pr.creationDate);
  const lastRemoteActivityAt = toIsoOrNull(Math.max(latestCommentAt, latestCommitAt, latestPrAt));
  const lastSeenAt = parseDate(tracked.lastSeenActivityAt);
  const commentsByOthers = comments.filter((comment) => !identityMatches(connection.login, comment.author));
  const newCommentsCount = commentsByOthers.filter(
    (comment) => parseDate(comment.lastUpdatedDate || comment.publishedDate) > lastSeenAt,
  ).length;
  const voteSignature = reviewerInfo.reviewers
    .map((reviewer) => `${reviewer.id}:${reviewer.vote}:${reviewer.hasDeclined ? 1 : 0}`)
    .sort()
    .join("|");
  const sourceUpdated = latestCommitAt > lastSeenAt && latestCommitAt > 0;
  const voteChanged = Boolean(tracked.lastVoteSignature && tracked.lastVoteSignature !== voteSignature);
  const mergeStatus = pr.mergeStatus || pr.status || "";
  const mergeStatusChanged = Boolean(tracked.lastMergeStatus && tracked.lastMergeStatus !== mergeStatus);
  const unresolvedThreadCount = threads.filter(
    (thread) => String(thread.status || "").toLowerCase() === "active",
  ).length;
  const attentionReason = inferAttentionReason({
    role,
    newCommentsCount,
    sourceUpdated,
    voteChanged,
    mergeStatusChanged,
    mergeStatus,
  });
  const profileWorkspaces = workspaces.filter((ws) => (ws.profileId || "default") === activeProfileId);
  const reviewWorkspace = findWorkspaceForPullRequest(profileWorkspaces, prKey);
  const matchingWorkspace = findMatchingWorkspace(
    {
      repository: { remoteUrl: pr.repository?.remoteUrl || "" },
      pullRequest: { sourceRefName: pr.sourceRefName || "" },
      role,
    },
    profileWorkspaces,
    gitSnapshots,
  );

  const trackedReviewWsId = tracked.reviewWorkspaceId || "";
  const trackedReviewInProfile = trackedReviewWsId && profileWorkspaces.some((ws) => ws.id === trackedReviewWsId);

  const summary = {
    provider: "azure-devops",
    prKey,
    connectionId: connection.id,
    connectionLabel: connection.label || connection.id,
    orgUrl: trimTrailingSlash(connection.orgUrl),
    project: {
      id: pr.repository?.project?.id || "",
      name: projectName,
    },
    repository: {
      id: repositoryId,
      name: pr.repository?.name || "",
      remoteUrl: firstNonEmpty(
        pr.repository?.remoteUrl,
        buildRepositoryRemoteUrl(connection, projectName, pr.repository?.name || repositoryId),
      ),
    },
    pullRequest: {
      id: pr.pullRequestId,
      title: pr.title || `PR #${pr.pullRequestId}`,
      description: pr.description || "",
      status: pr.status || "active",
      mergeStatus,
      isDraft: Boolean(pr.isDraft),
      url: pr.url || "",
      webUrl:
        pr._links?.web?.href ||
        `${connection.orgUrl}/${encodeURIComponent(projectName)}/_git/${encodeURIComponent(pr.repository?.name || repositoryId)}/pullrequest/${pr.pullRequestId}`,
      sourceRefName: pr.sourceRefName || "",
      targetRefName: pr.targetRefName || "",
      sourceCommitId: pr.lastMergeSourceCommit?.commitId || "",
      lastSourceCommitAt: toIsoOrNull(latestCommitAt),
      creationDate: toIsoOrNull(latestPrAt),
      closedDate: toIsoOrNull(pr.closedDate) || null,
    },
    author: {
      id: pr.createdBy?.id || "",
      displayName: firstNonEmpty(pr.createdBy?.displayName, pr.createdBy?.uniqueName, "Unknown author"),
      uniqueName: pr.createdBy?.uniqueName || "",
    },
    role,
    myVote: reviewerInfo.myVote,
    myReviewerId: reviewerInfo.myReviewerId,
    reviewerSummary: reviewerInfo,
    reviewWorkspaceId: reviewWorkspace?.id || (trackedReviewInProfile ? trackedReviewWsId : ""),
    existingWorkspaceId: matchingWorkspace?.id || "",
    lastSeenActivityAt: tracked.lastSeenActivityAt || null,
    lastRemoteActivityAt,
    lastActivityAt: lastRemoteActivityAt,
    hasAttention: Boolean(attentionReason),
    attentionReason,
    newCommentsCount,
    unresolvedThreadCount,
    threadCounts: computeThreadStatusCounts(threads),
    commentCount: comments.length,
    latestCommentPreview:
      commentsByOthers.sort(
        (left, right) =>
          parseDate(right.lastUpdatedDate || right.publishedDate) -
          parseDate(left.lastUpdatedDate || left.publishedDate),
      )[0]?.content || "",
    threads: threads
      .slice()
      .sort(compareThreads)
      .map((thread) => ({
        id: thread.id,
        status: thread.status || "unknown",
        isDeleted: Boolean(thread.isDeleted),
        filePath: thread.threadContext?.filePath || "",
        lineStart: thread.threadContext?.rightFileStart?.line ?? thread.threadContext?.leftFileStart?.line ?? null,
        lineEnd: thread.threadContext?.rightFileEnd?.line ?? thread.threadContext?.leftFileEnd?.line ?? null,
        publishedDate: thread.publishedDate || null,
        lastUpdatedDate: thread.lastUpdatedDate || null,
        comments: (thread.comments || [])
          .filter((comment) => !comment.isDeleted)
          .map((comment) => ({
            id: comment.id,
            parentCommentId: comment.parentCommentId ?? 0,
            content: comment.content || "",
            publishedDate: comment.publishedDate || null,
            lastUpdatedDate: comment.lastUpdatedDate || null,
            commentType: comment.commentType || "text",
            author: {
              id: comment.author?.id || "",
              displayName: firstNonEmpty(comment.author?.displayName, comment.author?.uniqueName, "Unknown author"),
              uniqueName: comment.author?.uniqueName || "",
            },
          })),
      })),
  };

  // Raw signals used by the manager's sync() to detect notification-worthy
  // deltas vs tracked.lastNotifiedActivityAt. Kept out of the summary so they
  // don't leak into the broadcast payload.
  const internals = {
    comments,
    commentsByOthers,
    voteSignature,
    sourceCommitId: pr.lastMergeSourceCommit?.commitId || "",
    sourceCommitter: pr.lastMergeSourceCommit?.committer || null,
    sourceCommitAuthor: pr.lastMergeSourceCommit?.author || null,
    latestCommitAt: toIsoOrNull(latestCommitAt),
    reviewerMap: new Map(reviewerInfo.reviewers.map((reviewer) => [reviewer.id, reviewer])),
    myReviewerId: reviewerInfo.myReviewerId,
    mergeStatus,
  };

  return { summary, internals };
}
