/**
 * Formatting helpers used by PrRow.vue (Azure/GitHub PR rows share the one
 * component, parametrized by a `provider` prop). Each provider's PR row used
 * to carry its own copy of these before the merge — this is the single home
 * for them. (`stripRef` is shared too, but its existing home is
 * azurePipelineFormat.ts — see the import in PrRow.vue.)
 */

/** First 7 chars of a commit SHA, for the compact "HEAD" fact. */
export function shortSha(sha: unknown): string {
  return String(sha || "").slice(0, 7);
}

/** e.g. "3 Jan 2026" — used for the "Created"/"Updated" facts. */
export function formatDate(iso: unknown): string {
  if (!iso) return "";
  const d = new Date(iso as string);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

/**
 * The leading ticket keys of a title ("ABC-91511 ABC-91974 | …"), so a row can mute them: several PRs of one change
 * start the same, and what tells them apart comes after.
 */
export function splitTicketPrefix(title: string): { prefix: string; rest: string } {
  let end = 0;
  for (let key = TICKET_KEY.exec(title); key; key = TICKET_KEY.exec(title.slice(end))) end += key[0].length;
  if (end) end += /^[:|]\s*/.exec(title.slice(end))?.[0].length ?? 0;
  // Keys alone are the whole title, not a prefix of it.
  return end && end < title.length
    ? { prefix: title.slice(0, end), rest: title.slice(end) }
    : { prefix: "", rest: title };
}

const TICKET_KEY = /^[A-Z][A-Z0-9]+-\d{2,}\b[\s,]*/;

/** "Doe, Jane (Acme Ltd.)" → "Doe, Jane": the organisation suffix repeats on every row. */
export function shortPersonName(name: string): string {
  return name.replace(/\s*\([^()]*\)\s*$/, "") || name;
}

const DAY_MS = 86_400_000;

/** Whole-day age of an ISO timestamp, or null when it is missing or invalid. */
export function daysSince(iso: unknown, now: number = Date.now()): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso as string);
  return Number.isNaN(ms) ? null : Math.max(0, now - ms) / DAY_MS;
}

/** Remote activity the user has not looked at yet (never opened counts as unread). */
export function isUnread(item: {
  lastSeenActivityAt?: unknown;
  lastRemoteActivityAt?: unknown;
  lastOthersActivityAt?: unknown;
}): boolean {
  // Azure reports other people's activity separately so the user's own comment or push is not "unread".
  if ("lastOthersActivityAt" in item) {
    if (!item.lastOthersActivityAt) return false;
    if (!item.lastSeenActivityAt) return true;
    return Date.parse(item.lastOthersActivityAt as string) > Date.parse(item.lastSeenActivityAt as string);
  }
  if (!item.lastSeenActivityAt) return true;
  return Date.parse(item.lastRemoteActivityAt as string) > Date.parse(item.lastSeenActivityAt as string);
}

/** Looking at the PR would clear something: unread activity, or attention that opening acknowledges. */
export function hasAcknowledgeableChange(item: {
  lastSeenActivityAt?: unknown;
  lastRemoteActivityAt?: unknown;
  lastOthersActivityAt?: unknown;
  hasAttention?: unknown;
  attentionReasons?: unknown;
}): boolean {
  if (isUnread(item)) return true;
  const reasons = item.attentionReasons;
  return Array.isArray(reasons)
    ? reasons.some((reason) => Boolean((reason as { ackOnSeen?: unknown })?.ackOnSeen))
    : Boolean(item.hasAttention);
}

export const PR_ICONS = {
  chevronDown: ["m6 9 6 6 6-6"],
  chevronRight: ["m9 18 6-6-6-6"],
  comment: ["M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"],
  eye: ["M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z", "M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z"],
  push: ["M12 19V5", "m5 12 7-7 7 7"],
  vote: ["M20 6 9 17l-5-5"],
  check: ["M20 6 9 17l-5-5"],
  warning: ["M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z", "M12 9v4", "M12 17h.01"],
  alert: ["M13 2 3 14h9l-1 8 10-12h-9l1-8z"],
  clock: ["M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z", "M12 7v5l3 2"],
  x: ["M18 6 6 18", "m6 6 12 12"],
  external: ["M15 3h6v6", "M10 14 21 3", "M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"],
  folderGit: [
    "M9 20H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H20a2 2 0 0 1 2 2v5",
    "M13 10a2 2 0 1 0 0 4 2 2 0 0 0 0-4z",
    "M18 19c-2.8 0-5-2.2-5-5v8",
    "M20 17a2 2 0 1 0 0 4 2 2 0 0 0 0-4z",
  ],
} as const;
