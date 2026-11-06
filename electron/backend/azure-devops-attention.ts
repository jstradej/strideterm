import { parseDate } from "./azure-devops-utils.js";
import { isAzureCommentByCurrentUser } from "./azure-comment-identity.js";

export type AzureAttentionCode =
  | "review-requested"
  | "group-review-requested"
  | "push-after-approval"
  | "push-after-feedback"
  | "changes-requested"
  | "conflicts"
  | "merge-failed"
  | "replies";

export interface AzureAttentionReason {
  code: AzureAttentionCode;
  label: string;
  ackOnSeen: boolean;
}

export type AzureMyReviewStatus = "none" | "voted" | "declined" | "pending" | "covered";

export interface AzureReviewerVia {
  id: string;
  displayName: string;
  isRequired: boolean;
  vote: number;
  covered: boolean;
  coveredBy: string | null;
}

export type AzureReviewerVotes = Record<string, { vote: number; commitId: string }>;

interface SummarizedReviewer {
  id: string;
  displayName: string;
  vote: number;
  isRequired: boolean;
  hasDeclined: boolean;
  isContainer: boolean;
  votedFor: Array<{ id: string; displayName: string }>;
}

function lower(value: unknown): string {
  return String(value || "")
    .trim()
    .toLowerCase();
}

// Azure names project-scoped groups "[Project]\Name"; the web UI shows only "Name".
export function shortGroupName(displayName: string): string {
  return displayName.replace(/^\[[^\]]*\]\\/, "") || displayName;
}

export function trackReviewerVotes(
  previous: unknown,
  reviewers: Array<{ id: string; vote: number }>,
  currentCommitId: string,
): AzureReviewerVotes {
  const prior = (previous && typeof previous === "object" ? previous : {}) as Record<string, unknown>;
  const next: AzureReviewerVotes = {};
  for (const reviewer of reviewers) {
    if (!reviewer.id || reviewer.vote === 0) continue;
    const entry = prior[reviewer.id] as { vote?: unknown; commitId?: unknown } | undefined;
    next[reviewer.id] =
      entry && entry.vote === reviewer.vote && typeof entry.commitId === "string"
        ? { vote: reviewer.vote, commitId: entry.commitId }
        : { vote: reviewer.vote, commitId: currentCommitId };
  }
  return next;
}

// A branch policy that requires several members of one group is not visible in the PR data, so a
// single member's vote counts as covering the group for everyone else in it.
export function resolveMyReview(
  reviewers: SummarizedReviewer[],
  me: SummarizedReviewer | undefined,
  myGroupIds: ReadonlySet<string>,
): { isDirectReviewer: boolean; reviewerVia: AzureReviewerVia[]; myReviewStatus: AzureMyReviewStatus } {
  const isDirectReviewer = Boolean(me);
  const reviewerVia: AzureReviewerVia[] = reviewers
    .filter((reviewer) => reviewer.isContainer && reviewer !== me && myGroupIds.has(lower(reviewer.id)))
    .map((group) => {
      const colleague = reviewers.find(
        (reviewer) =>
          !reviewer.isContainer &&
          reviewer !== me &&
          reviewer.vote !== 0 &&
          reviewer.votedFor.some((voted) => lower(voted.id) === lower(group.id)),
      );
      return {
        id: group.id,
        displayName: group.displayName,
        isRequired: group.isRequired,
        vote: group.vote,
        covered: group.vote !== 0 || Boolean(colleague),
        coveredBy: colleague?.displayName ?? null,
      };
    });

  let myReviewStatus: AzureMyReviewStatus;
  if (me) {
    myReviewStatus = me.vote !== 0 ? "voted" : me.hasDeclined ? "declined" : "pending";
  } else if (reviewerVia.length === 0) {
    myReviewStatus = "none";
  } else {
    myReviewStatus = reviewerVia.some((group) => !group.covered) ? "pending" : "covered";
  }
  return { isDirectReviewer, reviewerVia, myReviewStatus };
}

type RawThread = {
  status?: unknown;
  isDeleted?: boolean;
  comments?: Array<{
    commentType?: string;
    isDeleted?: boolean;
    content?: string;
    publishedDate?: string | null;
    lastUpdatedDate?: string | null;
    author?: { id?: string } | null;
  }>;
};

export function countRepliesToMe(
  threads: RawThread[],
  currentUserId: string | null | undefined,
  isAuthor: boolean,
  lastSeenAt: number,
): number {
  const userId = lower(currentUserId);
  if (!userId) return 0;
  const mention = `@<${userId}>`;
  let count = 0;
  for (const thread of threads) {
    const status = lower(thread.status);
    if ((status !== "active" && status !== "pending") || thread.isDeleted) continue;
    const comments = (thread.comments || []).filter(
      (comment) => !comment.isDeleted && lower(comment.commentType) !== "system",
    );
    const when = (comment: (typeof comments)[number]) => parseDate(comment.lastUpdatedDate || comment.publishedDate);
    const mine = comments.filter((comment) => isAzureCommentByCurrentUser(comment.author, userId));
    const myLastAt = Math.max(0, ...mine.map(when));
    const involved = isAuthor || mine.length > 0;
    const since = Math.max(lastSeenAt, myLastAt);
    for (const comment of comments) {
      if (isAzureCommentByCurrentUser(comment.author, userId) || when(comment) <= since) continue;
      if (involved || lower(comment.content).includes(mention)) count += 1;
    }
  }
  return count;
}

export function buildAttentionReasons(input: {
  isAuthor: boolean;
  isDraft: boolean;
  me: SummarizedReviewer | undefined;
  reviewers: SummarizedReviewer[];
  isDirectReviewer: boolean;
  reviewerVia: AzureReviewerVia[];
  myReviewStatus: AzureMyReviewStatus;
  reviewerVotes: AzureReviewerVotes;
  currentCommitId: string;
  latestCommitAt: number;
  lastSeenAt: number;
  mergeStatus: string;
  replyCount: number;
}): AzureAttentionReason[] {
  const reasons: AzureAttentionReason[] = [];
  const pushedSince = (reviewerId: string) => {
    const entry = input.reviewerVotes[reviewerId];
    return Boolean(entry && input.currentCommitId && entry.commitId !== input.currentCommitId);
  };

  if (!input.isAuthor && !input.isDraft) {
    if (input.myReviewStatus === "pending" && input.isDirectReviewer) {
      reasons.push({ code: "review-requested", label: "Your review", ackOnSeen: false });
    } else if (input.myReviewStatus === "pending") {
      const open = input.reviewerVia.filter((group) => !group.covered);
      const group = open.find((entry) => entry.isRequired) || open[0];
      reasons.push({
        code: "group-review-requested",
        label: `Your review · via ${shortGroupName(group.displayName)}`,
        ackOnSeen: false,
      });
    }
    const me = input.me;
    if (me && me.vote !== 0 && pushedSince(me.id) && input.latestCommitAt > input.lastSeenAt) {
      reasons.push(
        me.vote > 0
          ? { code: "push-after-approval", label: "New push after your approval", ackOnSeen: true }
          : { code: "push-after-feedback", label: "Pushed after your feedback", ackOnSeen: true },
      );
    }
  }

  if (input.isAuthor) {
    const blocker = input.reviewers.find(
      (reviewer) => reviewer !== input.me && !reviewer.isContainer && reviewer.vote < 0 && !pushedSince(reviewer.id),
    );
    if (blocker) {
      reasons.push({
        code: "changes-requested",
        label:
          blocker.vote <= -10 ? `Rejected by ${blocker.displayName}` : `${blocker.displayName}: waiting for author`,
        ackOnSeen: false,
      });
    }
    const mergeStatus = lower(input.mergeStatus);
    if (mergeStatus === "conflicts") {
      reasons.push({ code: "conflicts", label: "Merge conflicts", ackOnSeen: false });
    } else if (mergeStatus === "rejectedbypolicy" || mergeStatus === "failure") {
      reasons.push({ code: "merge-failed", label: "Merge check failed", ackOnSeen: false });
    }
  }

  if (input.replyCount > 0) {
    const plural = input.replyCount === 1 ? "" : "s";
    reasons.push({
      code: "replies",
      label: input.isAuthor
        ? `${input.replyCount} new comment${plural}`
        : `${input.replyCount} ${input.replyCount === 1 ? "reply" : "replies"} to you`,
      ackOnSeen: true,
    });
  }
  return reasons;
}
