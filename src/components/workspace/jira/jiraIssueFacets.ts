export type JiraFacetKey = "status" | "type" | "priority" | "assignee";
export type JiraFacetSelection = Record<JiraFacetKey, string | null>;
export type JiraFacetOption = { value: string; count: number };

type FacetIssue = { status?: string; issueType?: string; priority?: string; assignee?: string };

export const JIRA_FACET_KEYS: readonly JiraFacetKey[] = ["status", "type", "priority", "assignee"];
const MAX_OPTIONS = 12;

export function emptyJiraFacets(): JiraFacetSelection {
  return { status: null, type: null, priority: null, assignee: null };
}

export function hasJiraFacets(selection: JiraFacetSelection): boolean {
  return JIRA_FACET_KEYS.some((key) => selection[key] !== null);
}

/** Unassigned issues have the empty assignee value. */
function facetValue(issue: FacetIssue, key: JiraFacetKey): string {
  const value =
    key === "status"
      ? issue.status
      : key === "type"
        ? issue.issueType
        : key === "priority"
          ? issue.priority
          : issue.assignee;
  return (value || "").trim();
}

function matches(issue: FacetIssue, selection: JiraFacetSelection, skip?: JiraFacetKey): boolean {
  return JIRA_FACET_KEYS.every(
    (key) => key === skip || selection[key] === null || facetValue(issue, key) === selection[key],
  );
}

export function applyJiraFacets<T extends FacetIssue>(issues: readonly T[], selection: JiraFacetSelection): T[] {
  return hasJiraFacets(selection) ? issues.filter((issue) => matches(issue, selection)) : [...issues];
}

/** Counts for one facet ignore that facet's own selection, so the other values stay pickable. */
export function jiraFacetOptions(
  issues: readonly FacetIssue[],
  selection: JiraFacetSelection,
  key: JiraFacetKey,
): JiraFacetOption[] {
  const counts = new Map<string, number>();
  for (const issue of issues) {
    if (!matches(issue, selection, key)) continue;
    const value = facetValue(issue, key);
    if (!value && key !== "assignee") continue;
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  const selected = selection[key];
  if (selected !== null && !counts.has(selected)) counts.set(selected, 0);
  const options = [...counts].map(([value, count]) => ({ value, count }));
  options.sort(
    (left, right) =>
      Number(right.value === selected) - Number(left.value === selected) ||
      right.count - left.count ||
      Number(left.value === "") - Number(right.value === "") ||
      left.value.localeCompare(right.value),
  );
  return options.slice(0, MAX_OPTIONS);
}
