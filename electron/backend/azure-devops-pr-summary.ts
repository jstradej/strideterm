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

interface AzurePR {
  pullRequestId?: number | string;
  title?: string;
  description?: string;
  status?: string;
  mergeStatus?: string;
  isDraft?: boolean;
  url?: string;
  sourceRefName?: string;
  targetRefName?: string;
  creationDate?: string;
  closedDate?: string;
  reviewers?: unknown[];
  createdBy?: { id?: string; displayName?: string; uniqueName?: string; [key: string]: unknown };
  repository?: {
    id?: string;
    name?: string;
    remoteUrl?: string;
    project?: { id?: string; name?: string };
  };
  lastMergeSourceCommit?: {
    commitId?: string;
    committer?: unknown;
    author?: unknown;
  };
  _links?: { web?: { href?: string } };
}

import {
  findWorkspaceForPullRequest as baseFindWorkspace,
  findMatchingWorkspace,
  type GitSnapshot,
} from "./shared/pr-summary-helpers.js";

export function findWorkspaceForPullRequest(
  workspaces: Array<{ id: string; [key: string]: unknown }>,
  prKey: string,
): { id: string; [key: string]: unknown } | null {
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
}: {
  connection: { id: string; label?: string; orgUrl?: string; login?: string; profileId?: string };
  pr: Record<string, unknown>;
  projectName: string;
  threads: Array<Record<string, unknown>>;
  tracked?: Record<string, unknown>;
  workspaces?: Array<{ id: string; profileId?: string; [key: string]: unknown }>;
  gitSnapshots?: Record<string, unknown>;
  /** Defensive fallback when connection.profileId is empty (legacy/pre-migration). */
  activeProfileId?: string;
  now?: () => number;
}): { summary: Record<string, unknown>; internals: Record<string, unknown> } {
  const p = pr as AzurePR;
  const repositoryId = p.repository?.id || "";
  const prKey = createPullRequestKey(connection.id, repositoryId, p.pullRequestId ?? "");
  const comments = extractComments(threads);
  type AzureReviewer = {
    id?: string;
    displayName?: string;
    uniqueName?: string;
    vote?: number;
    isRequired?: boolean;
    hasDeclined?: boolean;
    isContainer?: boolean;
  };
  const reviewerInfo = summarizeReviewers((p.reviewers || []) as AzureReviewer[], connection.login);
  const isAuthor = identityMatches(connection.login, p.createdBy ?? null);
  const isReviewer =
    !isAuthor && reviewerInfo.reviewers.some((reviewer) => identityMatches(connection.login, reviewer));
  const role = isAuthor ? "author" : isReviewer ? "reviewer" : "observer";
  const latestCommentAt = Math.max(
    ...comments.map((comment) => parseDate(comment.lastUpdatedDate || comment.publishedDate)),
    0,
  );
  const lastMergeSourceCommit = p.lastMergeSourceCommit || {};
  const latestCommitAt = parseDate((lastMergeSourceCommit.committer as Record<string, unknown> | undefined)?.date);
  const latestPrAt = parseDate(p.creationDate);
  const lastRemoteActivityAt = toIsoOrNull(Math.max(latestCommentAt, latestCommitAt, latestPrAt));
  const lastSeenAt = parseDate(tracked.lastSeenActivityAt);
  type AzureIdentity = { uniqueName?: string; mailAddress?: string; displayName?: string; id?: string };
  const commentsByOthers = comments.filter(
    (comment) => !identityMatches(connection.login, comment.author as AzureIdentity | null | undefined),
  );
  const newCommentsCount = commentsByOthers.filter(
    (comment) => parseDate(comment.lastUpdatedDate || comment.publishedDate) > lastSeenAt,
  ).length;
  const voteSignature = reviewerInfo.reviewers
    .map((reviewer) => `${reviewer.id}:${reviewer.vote}:${reviewer.hasDeclined ? 1 : 0}`)
    .sort()
    .join("|");
  const sourceUpdated = latestCommitAt > lastSeenAt && latestCommitAt > 0;
  const voteChanged = Boolean(tracked.lastVoteSignature && tracked.lastVoteSignature !== voteSignature);
  const mergeStatus = p.mergeStatus || p.status || "";
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
  // Each PR belongs to the connection it was fetched through. Scope the
  // review/matching workspace lookup to the connection's profile so that a
  // user in window A doesn't silently miss the review workspace that
  // belongs to window B's profile (which is where the connection lives).
  const summaryProfileId = connection.profileId || activeProfileId;
  const profileWorkspaces = workspaces.filter((ws) => (ws.profileId || "default") === summaryProfileId);
  const reviewWorkspace = findWorkspaceForPullRequest(profileWorkspaces, prKey);
  const matchingWorkspace = findMatchingWorkspace(
    {
      repository: { remoteUrl: p.repository?.remoteUrl || "" },
      pullRequest: { sourceRefName: p.sourceRefName || "" },
      role,
    },
    profileWorkspaces,
    gitSnapshots as Record<string, GitSnapshot>,
  );

  const trackedReviewWsId = tracked.reviewWorkspaceId || "";
  const trackedReviewInProfile = trackedReviewWsId && profileWorkspaces.some((ws) => ws.id === trackedReviewWsId);

  const summary = {
    provider: "azure-devops",
    prKey,
    connectionId: connection.id,
    // Profile that owns this PR's connection. Telegram and other consumers
    // route alerts by this — without it the fallback to "first Azure inbox
    // workspace in any profile" lands the alert under the wrong profile
    // when no review workspace exists yet.
    profileId: connection.profileId || activeProfileId,
    connectionLabel: connection.label || connection.id,
    orgUrl: trimTrailingSlash(connection.orgUrl),
    project: {
      id: p.repository?.project?.id || "",
      name: projectName,
    },
    repository: {
      id: repositoryId,
      name: p.repository?.name || "",
      remoteUrl: firstNonEmpty(
        p.repository?.remoteUrl,
        buildRepositoryRemoteUrl(connection, projectName, p.repository?.name || repositoryId),
      ),
    },
    pullRequest: {
      id: p.pullRequestId,
      title: p.title || `PR #${p.pullRequestId}`,
      description: p.description || "",
      status: p.status || "active",
      mergeStatus,
      isDraft: Boolean(p.isDraft),
      url: p.url || "",
      webUrl:
        p._links?.web?.href ||
        `${connection.orgUrl}/${encodeURIComponent(projectName)}/_git/${encodeURIComponent(p.repository?.name || repositoryId)}/pullrequest/${p.pullRequestId}`,
      sourceRefName: p.sourceRefName || "",
      targetRefName: p.targetRefName || "",
      sourceCommitId: lastMergeSourceCommit.commitId || "",
      lastSourceCommitAt: toIsoOrNull(latestCommitAt),
      creationDate: toIsoOrNull(latestPrAt),
      closedDate: toIsoOrNull(parseDate(p.closedDate)) || null,
    },
    author: {
      id: p.createdBy?.id || "",
      displayName: firstNonEmpty(p.createdBy?.displayName, p.createdBy?.uniqueName, "Unknown author"),
      uniqueName: p.createdBy?.uniqueName || "",
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
      .map((thread) => {
        type ThreadCtx = {
          filePath?: string;
          rightFileStart?: { line?: number };
          leftFileStart?: { line?: number };
          rightFileEnd?: { line?: number };
          leftFileEnd?: { line?: number };
        };
        const tc = (thread.threadContext || {}) as ThreadCtx;
        type ThreadComment = {
          id?: unknown;
          parentCommentId?: number;
          isDeleted?: boolean;
          content?: string;
          publishedDate?: string | null;
          lastUpdatedDate?: string | null;
          commentType?: string;
          author?: { id?: string; displayName?: string; uniqueName?: string };
        };
        const threadComments = (thread.comments || []) as ThreadComment[];
        return {
          id: thread.id,
          status: thread.status || "unknown",
          isDeleted: Boolean(thread.isDeleted),
          filePath: tc.filePath || "",
          lineStart: tc.rightFileStart?.line ?? tc.leftFileStart?.line ?? null,
          lineEnd: tc.rightFileEnd?.line ?? tc.leftFileEnd?.line ?? null,
          publishedDate: thread.publishedDate || null,
          lastUpdatedDate: thread.lastUpdatedDate || null,
          comments: threadComments
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
        };
      }),
  };

  // Raw signals used by the manager's sync() to detect notification-worthy
  // deltas vs tracked.lastNotifiedActivityAt. Kept out of the summary so they
  // don't leak into the broadcast payload.
  const internals = {
    comments,
    commentsByOthers,
    voteSignature,
    sourceCommitId: lastMergeSourceCommit.commitId || "",
    sourceCommitter: lastMergeSourceCommit.committer || null,
    sourceCommitAuthor: lastMergeSourceCommit.author || null,
    latestCommitAt: toIsoOrNull(latestCommitAt),
    reviewerMap: new Map(reviewerInfo.reviewers.map((reviewer) => [reviewer.id, reviewer])),
    myReviewerId: reviewerInfo.myReviewerId,
    mergeStatus,
  };

  return { summary, internals };
}
