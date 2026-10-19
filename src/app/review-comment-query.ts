import type { ReviewNotificationCommentTarget } from "../../electron/shared/review-notification-target.js";

export interface ReviewCommentQueryRequest {
  profileId: string;
  workspaceId: string;
  provider: "azure-devops" | "github";
  connectionId: string;
  prKey: string;
  target: ReviewNotificationCommentTarget;
}

const REVIEW_QUERY_KEYS = [
  "reviewWorkspaceId",
  "reviewProvider",
  "reviewConnectionId",
  "reviewPrKey",
  "reviewCommentKind",
  "reviewCommentId",
  "reviewThreadId",
] as const;

function bounded(value: string | null, max = 256): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max && value.trim() === value;
}

function numericId(value: string | null): value is string {
  return typeof value === "string" && /^\d{1,32}$/.test(value);
}

export function parseReviewCommentQuery(href: string): {
  request: ReviewCommentQueryRequest | null;
  cleanedHref: string;
  hasReviewParams: boolean;
} {
  const url = new URL(href);
  const hasReviewParams = REVIEW_QUERY_KEYS.some((key) => url.searchParams.has(key));
  if (!hasReviewParams) return { request: null, cleanedHref: href, hasReviewParams: false };

  const hasUniqueKeys = ["profileId", ...REVIEW_QUERY_KEYS].every((key) => url.searchParams.getAll(key).length <= 1);

  const profileId = url.searchParams.get("profileId");
  const workspaceId = url.searchParams.get("reviewWorkspaceId");
  const provider = url.searchParams.get("reviewProvider");
  const parsedProvider = provider === "azure-devops" || provider === "github" ? provider : null;
  const connectionId = url.searchParams.get("reviewConnectionId");
  const prKey = url.searchParams.get("reviewPrKey");
  const kind = url.searchParams.get("reviewCommentKind");
  const commentId = url.searchParams.get("reviewCommentId");
  const threadId = url.searchParams.get("reviewThreadId");

  let target: ReviewNotificationCommentTarget | null = null;
  if (kind === "azure-thread-comment" && numericId(commentId) && numericId(threadId)) {
    target = { kind, commentId, threadId };
  } else if (kind === "github-issue-comment" && numericId(commentId) && !threadId) {
    target = { kind, commentId };
  } else if (kind === "github-review-comment" && numericId(commentId) && (!threadId || numericId(threadId))) {
    target = { kind, commentId, ...(threadId ? { threadId } : {}) };
  }

  let request: ReviewCommentQueryRequest | null = null;
  if (
    hasUniqueKeys &&
    bounded(profileId, 128) &&
    bounded(workspaceId, 128) &&
    parsedProvider &&
    bounded(connectionId, 200) &&
    bounded(prKey, 500) &&
    target &&
    ((parsedProvider === "azure-devops" && target.kind === "azure-thread-comment") ||
      (parsedProvider === "github" && target.kind !== "azure-thread-comment"))
  ) {
    request = { profileId, workspaceId, provider: parsedProvider, connectionId, prKey, target };
  }

  url.searchParams.delete("profileId");
  for (const key of REVIEW_QUERY_KEYS) url.searchParams.delete(key);
  return { request, cleanedHref: `${url.pathname}${url.search}${url.hash}`, hasReviewParams: true };
}

type ReviewQueryState = {
  workspaces?: Array<{
    id?: string;
    profileId?: string;
    review?: { provider?: string; connectionId?: string; prKey?: string } | null;
  }>;
  settings?: {
    integrations?: {
      azureDevops?: { connections?: Array<{ id?: string; profileId?: string }> };
      github?: { connections?: Array<{ id?: string; profileId?: string }> };
    };
  };
};

export function validateReviewCommentQuery(
  request: ReviewCommentQueryRequest,
  payload: { appState?: ReviewQueryState } | null | undefined,
  activeProfileId: string | null,
): boolean {
  if (!payload?.appState || activeProfileId !== request.profileId) return false;
  const state = payload.appState;
  const workspace = state.workspaces?.find(
    (item) => item.id === request.workspaceId && (item.profileId || "default") === request.profileId,
  );
  if (
    !workspace ||
    workspace.review?.provider !== request.provider ||
    workspace.review.connectionId !== request.connectionId ||
    workspace.review.prKey !== request.prKey
  ) {
    return false;
  }
  const settings = state.settings?.integrations;
  const connections =
    request.provider === "github" ? settings?.github?.connections : settings?.azureDevops?.connections;
  return !!connections?.some(
    (connection) => connection.id === request.connectionId && (connection.profileId || "default") === request.profileId,
  );
}

export async function activateReviewCommentQuery(
  request: ReviewCommentQueryRequest,
  dependencies: {
    getPayload: () => { appState?: ReviewQueryState } | null | undefined;
    getActiveProfileId: () => string | null;
    getActiveWorkspaceId: () => string;
    activateWorkspace: (_workspaceId: string) => Promise<void>;
    requestFocus: (_request: ReviewCommentQueryRequest) => void;
  },
): Promise<boolean> {
  if (!validateReviewCommentQuery(request, dependencies.getPayload(), dependencies.getActiveProfileId())) return false;
  await dependencies.activateWorkspace(request.workspaceId);
  if (
    dependencies.getActiveProfileId() !== request.profileId ||
    dependencies.getActiveWorkspaceId() !== request.workspaceId ||
    !validateReviewCommentQuery(request, dependencies.getPayload(), dependencies.getActiveProfileId())
  ) {
    return false;
  }
  dependencies.requestFocus(request);
  return true;
}
