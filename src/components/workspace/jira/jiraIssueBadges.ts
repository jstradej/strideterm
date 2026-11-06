export type JiraIssueKind = "bug" | "story" | "task" | "subtask" | "epic" | "unknown";

export function classifyJiraIssueType(issueType: string): JiraIssueKind {
  const type = issueType
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, " ");
  if (type.includes("bug")) return "bug";
  if (type.includes("epic")) return "epic";
  if (type.includes("subtask") || type.includes("sub task")) return "subtask";
  if (type.includes("story")) return "story";
  if (type === "task" || type.endsWith(" task")) return "task";
  return "unknown";
}

export type JiraPriorityLevel = 1 | 2 | 3 | 4 | 5;

const PRIORITY_LEVELS: Record<string, JiraPriorityLevel> = {
  highest: 5,
  blocker: 5,
  p0: 5,
  a: 5,
  high: 4,
  critical: 4,
  p1: 4,
  b: 4,
  medium: 3,
  normal: 3,
  major: 3,
  p2: 3,
  c: 3,
  low: 2,
  minor: 2,
  p3: 2,
  d: 2,
  lowest: 1,
  trivial: 1,
  p4: 1,
  e: 1,
};

/** 5 = most urgent, 1 = least. Jira's own five names (and the older Blocker..Trivial set) keep their own step. */
export function jiraPriorityLevel(priority: string): JiraPriorityLevel | null {
  return PRIORITY_LEVELS[priority.trim().toLowerCase()] ?? null;
}
