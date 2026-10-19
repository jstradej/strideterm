export type ReviewNotificationCommentTarget =
  | { kind: "azure-thread-comment"; threadId: string; commentId: string }
  | { kind: "github-issue-comment"; commentId: string }
  | { kind: "github-review-comment"; commentId: string; threadId?: string };
