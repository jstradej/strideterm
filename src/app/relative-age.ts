/**
 * Short, human-readable age for a card chip. "5m", "2h", "3d", "1w". Empty
 * string for missing / unparseable timestamps so the chip renders nothing
 * rather than "Invalid Date". Future timestamps (clock skew) coalesce to "now".
 *
 * Shared between the workspace card renderer and the Git Stashes tab so both
 * surfaces format ages identically.
 */
export function formatRelativeAge(iso: string | undefined | null, now = Date.now()): string {
  if (!iso) return "";
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "";
  const seconds = Math.max(0, Math.round((now - then) / 1000));
  if (seconds < 45) return "now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d`;
  const weeks = Math.round(days / 7);
  if (weeks < 8) return `${weeks}w`;
  // Beyond ~2 months, fall back to a short locale date — at that point
  // "10w" / "20w" stops being meaningful and a concrete date is clearer.
  try {
    return new Date(then).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  } catch {
    return `${weeks}w`;
  }
}
