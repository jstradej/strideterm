export function isAzureCommentByCurrentUser(
  author: { id?: string } | null | undefined,
  currentUserId: string | null | undefined,
): boolean {
  const authorId = typeof author?.id === "string" ? author.id.trim() : "";
  const authenticatedId = typeof currentUserId === "string" ? currentUserId.trim() : "";
  return Boolean(authorId && authenticatedId && authorId.toLowerCase() === authenticatedId.toLowerCase());
}
