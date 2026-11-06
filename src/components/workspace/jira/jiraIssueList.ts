import { jiraPriorityLevel } from "./jiraIssueBadges";
import { jiraPersonName, jiraStatusTone, type JiraStatusCategory, type JiraStatusTone } from "./jiraPeople";
import type { JiraIssueSort } from "./jira-view-preferences";

export type JiraIssueStatusFilter = "all" | "todo" | "active" | "done";

type ListIssue = {
  ref?: { issueKey?: string };
  key?: string;
  summary?: string;
  title?: string;
  status?: string;
  statusCategory?: JiraStatusCategory;
  assignee?: string;
  priority?: string;
  created?: string;
  updated?: string;
};

export const JIRA_ISSUE_SORT_OPTIONS: Array<{ value: JiraIssueSort; label: string }> = [
  { value: "updated", label: "Recently updated" },
  { value: "created", label: "Recently created" },
  { value: "priority", label: "Priority" },
  { value: "status", label: "Status" },
  { value: "key", label: "Issue key" },
  { value: "assignee", label: "Assignee" },
];

const JQL_ORDER: Record<JiraIssueSort, string> = {
  updated: "updated DESC",
  created: "created DESC",
  priority: "priority DESC, updated DESC",
  status: "status ASC, updated DESC",
  key: "key DESC",
  assignee: "assignee ASC, updated DESC",
};
const TONE_ORDER: JiraStatusTone[] = [
  "todo",
  "progress",
  "waiting",
  "blocked",
  "review",
  "testing",
  "done",
  "cancelled",
];

export function jiraIssueStatusGroup(issue: ListIssue): Exclude<JiraIssueStatusFilter, "all"> {
  const tone = jiraStatusTone(issue.status, issue.statusCategory);
  return tone === "todo" ? "todo" : tone === "done" || tone === "cancelled" ? "done" : "active";
}

/** Replaces the ORDER BY clause of a JQL query; an ORDER BY inside a quoted string is left alone. */
export function withJqlOrderBy(jql: string, sort: JiraIssueSort): string {
  const pattern = /\border\s+by\b/gi;
  let orderIndex = -1;
  for (let match = pattern.exec(jql); match; match = pattern.exec(jql)) {
    const before = jql.slice(0, match.index).replace(/\\./g, "");
    if ((before.match(/"/g)?.length ?? 0) % 2 === 0) orderIndex = match.index;
  }
  const filter = (orderIndex >= 0 ? jql.slice(0, orderIndex) : jql).trim();
  return `${filter}${filter ? " " : ""}ORDER BY ${JQL_ORDER[sort]}`;
}

function time(value: string | undefined) {
  const parsed = value ? Date.parse(value) : NaN;
  return Number.isNaN(parsed) ? -Infinity : parsed;
}
function issueKey(issue: ListIssue) {
  return issue.ref?.issueKey || issue.key || "";
}
function compareKeys(a: ListIssue, b: ListIssue) {
  const [projectA = "", numberA = "0"] = issueKey(a).split("-");
  const [projectB = "", numberB = "0"] = issueKey(b).split("-");
  return projectA.localeCompare(projectB) || Number(numberB) - Number(numberA);
}
function priorityRank(issue: ListIssue) {
  const level = jiraPriorityLevel(issue.priority || "");
  return level === null ? 5 : 5 - level;
}

export function sortJiraIssues<T extends ListIssue>(issues: readonly T[], sort: JiraIssueSort): T[] {
  const byUpdated = (a: T, b: T) => time(b.updated) - time(a.updated);
  const compare: Record<JiraIssueSort, (a: T, b: T) => number> = {
    updated: byUpdated,
    created: (a, b) => time(b.created) - time(a.created) || byUpdated(a, b),
    priority: (a, b) => priorityRank(a) - priorityRank(b) || byUpdated(a, b),
    status: (a, b) =>
      TONE_ORDER.indexOf(jiraStatusTone(a.status, a.statusCategory)) -
        TONE_ORDER.indexOf(jiraStatusTone(b.status, b.statusCategory)) ||
      (a.status || "").localeCompare(b.status || "") ||
      byUpdated(a, b),
    key: compareKeys,
    assignee: (a, b) =>
      Number(!a.assignee) - Number(!b.assignee) ||
      jiraPersonName(a.assignee || "").localeCompare(jiraPersonName(b.assignee || "")) ||
      byUpdated(a, b),
  };
  return [...issues].sort(compare[sort]);
}

export function filterJiraIssues<T extends ListIssue>(
  issues: readonly T[],
  text: string,
  status: JiraIssueStatusFilter,
): T[] {
  const needle = text.trim().toLowerCase();
  return issues.filter((issue) => {
    if (status !== "all" && jiraIssueStatusGroup(issue) !== status) return false;
    if (!needle) return true;
    return [issueKey(issue), issue.summary, issue.title, issue.assignee, issue.status].some((value) =>
      value?.toLowerCase().includes(needle),
    );
  });
}
