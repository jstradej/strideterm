/** Why a queued inline comment must not be published, or null when its anchor still holds. */
export function staleAnchorError(
  comment: { anchorStale?: boolean; filePath?: string; lineNumber?: number } | null | undefined,
): string | null {
  if (comment?.anchorStale !== true) return null;
  const location = `${comment.filePath || ""}${comment.lineNumber ? `:${comment.lineNumber}` : ""}`;
  return `The inline anchor ${location} is stale after a history rewrite. Delete this comment and add it again on the current code, then publish.`;
}
