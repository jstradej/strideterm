export type JiraStatusTone = "todo" | "progress" | "waiting" | "blocked" | "review" | "testing" | "done" | "cancelled";
export type JiraStatusCategory = "new" | "indeterminate" | "done";

const ORG_SUFFIX = /\s*\(([^()]*)\)\s*$/;
const AVATAR_HUES = [12, 32, 48, 140, 168, 192, 212, 236, 262, 290, 318, 340];

/** "Doe, Jane (Acme Ltd.)" → "Doe, Jane"; the organisation stays available separately. */
export function jiraPersonName(displayName: string): string {
  return displayName.replace(ORG_SUFFIX, "").trim() || displayName.trim();
}

export function jiraPersonOrganization(displayName: string): string {
  return ORG_SUFFIX.exec(displayName)?.[1]?.trim() || "";
}

/** Initials for both "Last, First" and "First Last" display names; digits used to disambiguate accounts are skipped. */
export function jiraPersonInitials(displayName: string): string {
  const name = jiraPersonName(displayName);
  const [last, first] = name.includes(",") ? name.split(",", 2) : [undefined, name];
  const words = (value: string | undefined) =>
    (value || "")
      .split(/\s+/)
      .map((word) => word.replace(/[^\p{L}]/gu, ""))
      .filter(Boolean);
  const firstWords = words(first);
  const lastWords = words(last);
  const letters = lastWords.length
    ? [firstWords[0]?.[0], lastWords[0]?.[0]]
    : [firstWords[0]?.[0], firstWords.length > 1 ? firstWords[firstWords.length - 1]?.[0] : firstWords[0]?.[1]];
  return letters.filter(Boolean).join("").toUpperCase() || "?";
}

export function jiraPersonHue(seed: string): number {
  let hash = 0;
  for (const char of seed) hash = (hash * 31 + char.codePointAt(0)!) >>> 0;
  return AVATAR_HUES[hash % AVATAR_HUES.length]!;
}

/**
 * Colour family for a status or board column. Jira only knows three categories; a few common workflow names get
 * their own tone so neighbouring columns on a board stay distinguishable.
 */
export function jiraStatusTone(statusName: string | undefined, category?: JiraStatusCategory): JiraStatusTone {
  const name = (statusName || "").trim().toLowerCase();
  if (/\b(cancel+ed|cancel|rejected|declined|abandoned|won'?t do|wontfix|obsolete)\b/.test(name)) return "cancelled";
  if (category === "done" || /\b(done|closed|resolved|released|complete|completed|deployed)\b/.test(name))
    return "done";
  if (/\b(block|blocked|impediment)\b/.test(name)) return "blocked";
  if (/\b(wait|waiting|hold|pending|paused)\b/.test(name)) return "waiting";
  if (/review/.test(name)) return "review";
  if (/\b(test|testing|qa|verif\w*|validat\w*|uat)\b/.test(name)) return "testing";
  if (category === "new" || /^(to ?do|open|new|backlog|selected|ready|reopened|created)\b/.test(name)) return "todo";
  return "progress";
}

export function formatJiraRelativeTime(value: string | undefined, now = Date.now()): string {
  if (!value) return "";
  const time = new Date(value).getTime();
  if (Number.isNaN(time)) return value;
  const seconds = Math.round((time - now) / 1000);
  const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ["year", 31_536_000],
    ["month", 2_592_000],
    ["week", 604_800],
    ["day", 86_400],
    ["hour", 3_600],
    ["minute", 60],
  ];
  const format = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
  for (const [unit, size] of units) {
    if (Math.abs(seconds) >= size) return format.format(Math.round(seconds / size), unit);
  }
  return format.format(0, "minute");
}
