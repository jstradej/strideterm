export const JIRA_SMART_FILTER_GROUPS = ["who", "state", "time", "sprint"] as const;
export type JiraSmartFilterGroup = (typeof JIRA_SMART_FILTER_GROUPS)[number];

export const JIRA_SMART_FILTERS = [
  { id: "assigned-to-me", group: "who", label: "Assigned to me", needsIdentity: true },
  { id: "reported-by-me", group: "who", label: "Reported by me", needsIdentity: true },
  { id: "watching", group: "who", label: "Watching", needsIdentity: true },
  { id: "unassigned", group: "who", label: "Unassigned", needsIdentity: false },
  { id: "open", group: "state", label: "Open", needsIdentity: false },
  { id: "in-progress", group: "state", label: "In progress", needsIdentity: false },
  { id: "done-14d", group: "state", label: "Done (last 14 days)", needsIdentity: false },
  { id: "updated-today", group: "time", label: "Updated today", needsIdentity: false },
  { id: "updated-week", group: "time", label: "Updated this week", needsIdentity: false },
  { id: "due-7d", group: "time", label: "Due in 7 days", needsIdentity: false },
  { id: "current-sprint", group: "sprint", label: "Current sprint", needsIdentity: false },
] as const;

export type JiraSmartFilterId = (typeof JIRA_SMART_FILTERS)[number]["id"];
export const JIRA_SMART_FILTER_IDS = JIRA_SMART_FILTERS.map((filter) => filter.id) as [
  JiraSmartFilterId,
  ...JiraSmartFilterId[],
];

export const JIRA_SMART_FILTER_TITLES: Record<JiraSmartFilterId, string> = {
  "assigned-to-me": "Issues assigned to you",
  "reported-by-me": "Issues you reported",
  watching: "Issues you are watching",
  unassigned: "Issues nobody is working on yet",
  open: "Not done yet",
  "in-progress": "Work that has started and is not finished",
  "done-14d": "Resolved in the last 14 days",
  "updated-today": "Changed since the start of today",
  "updated-week": "Changed since the start of this week",
  "due-7d": "Due date between today and the next 7 days",
  "current-sprint": "Issues in an active sprint",
};

export function jiraSmartFilterNeedsIdentity(id: JiraSmartFilterId): boolean {
  return JIRA_SMART_FILTERS.find((filter) => filter.id === id)?.needsIdentity === true;
}

/** One choice per group; later ids in the same group replace earlier ones. Unknown ids are dropped. */
export function normalizeJiraSmartFilters(ids: readonly unknown[]): JiraSmartFilterId[] {
  const byGroup = new Map<JiraSmartFilterGroup, JiraSmartFilterId>();
  for (const id of ids) {
    const filter = JIRA_SMART_FILTERS.find((candidate) => candidate.id === id);
    if (filter) byGroup.set(filter.group, filter.id);
  }
  return JIRA_SMART_FILTER_GROUPS.flatMap((group) => {
    const id = byGroup.get(group);
    return id ? [id] : [];
  });
}

export function jiraSmartFilterLabel(ids: readonly JiraSmartFilterId[]): string {
  const labels = ids.flatMap((id) => JIRA_SMART_FILTERS.find((filter) => filter.id === id)?.label ?? []);
  return labels.length ? labels.join(" · ") : "My issues";
}

export function jiraSmartFilterClause(id: JiraSmartFilterId, escapedPerson: string): string {
  switch (id) {
    case "assigned-to-me":
      return `assignee = "${escapedPerson}"`;
    case "reported-by-me":
      return `reporter = "${escapedPerson}"`;
    case "watching":
      return `watcher = "${escapedPerson}"`;
    case "unassigned":
      return "assignee is EMPTY";
    case "open":
      return "statusCategory != Done";
    case "in-progress":
      return 'statusCategory = "In Progress"';
    case "done-14d":
      return "statusCategory = Done AND resolved >= -14d";
    case "updated-today":
      return "updated >= startOfDay()";
    case "updated-week":
      return "updated >= startOfWeek()";
    case "due-7d":
      return 'due >= startOfDay() AND due <= endOfDay("+7d")';
    case "current-sprint":
      return "sprint in openSprints()";
  }
}
