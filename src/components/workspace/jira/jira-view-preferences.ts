import { normalizeJiraSmartFilters, type JiraSmartFilterId } from "../../../../electron/shared/jira-smart-filters";

export type JiraActiveView = "issues" | "board" | "settings";
export type JiraBoardMode = "issues" | "backlog" | "sprints";
export type JiraDoneWithinDays = 7 | 14 | 30 | 90;
export type JiraIssueSort = "updated" | "created" | "priority" | "status" | "key" | "assignee";
export type JiraSearchKind = "jql" | "my-issues" | "saved-filter" | "quick-search";
export type JiraSearchPreference = {
  connectionId: string;
  jql: string;
  kind: JiraSearchKind;
  label: string | null;
  filterId: string | null;
};
export const JIRA_ISSUE_SORTS: readonly JiraIssueSort[] = [
  "updated",
  "created",
  "priority",
  "status",
  "key",
  "assignee",
];
export type JiraAssigneePreference = { id: string; displayName: string; kind: "cloud" | "dc" } | { kind: "unassigned" };

export type JiraViewPreferences = {
  connectionId: string | null;
  boardId: string | null;
  boardName: string | null;
  boardType: string | null;
  activeView: JiraActiveView;
  boardMode: JiraBoardMode;
  selectedSprintId: string | null;
  quickFilterIds: string[];
  assignee: JiraAssigneePreference | null;
  /** Completed issues older than this are hidden from the plain board view; null shows all of them. */
  doneWithinDays: JiraDoneWithinDays | null;
  issueSort: JiraIssueSort;
  lastSearch: JiraSearchPreference | null;
  /** Smart-filter chips that produced `lastSearch`; empty when that search did not come from them. */
  smartFilters: JiraSmartFilterId[];
};

type JiraPreferenceStorage = Pick<Storage, "getItem" | "setItem">;
const VERSION = 3;
const MAX_FILTERS = 50;
const MAX_TEXT = 300;
const MAX_JQL = 2000;

function defaultPreferences(): JiraViewPreferences {
  return {
    connectionId: null,
    boardId: null,
    boardName: null,
    boardType: null,
    activeView: "issues",
    boardMode: "issues",
    selectedSprintId: null,
    quickFilterIds: [],
    assignee: null,
    doneWithinDays: 14,
    issueSort: "updated",
    lastSearch: null,
    smartFilters: [],
  };
}

export function jiraViewPreferencesKey(profileId: string, workspaceId: string): string {
  return `strideterm-jira-view-v1:${encodeURIComponent(profileId)}:${encodeURIComponent(workspaceId)}`;
}

function storageOrDefault(storage?: JiraPreferenceStorage): JiraPreferenceStorage | undefined {
  if (storage) return storage;
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

function cleanText(value: unknown): string | null {
  return typeof value === "string" && value.trim() && value.trim().length <= MAX_TEXT ? value.trim() : null;
}

function cleanNumericId(value: unknown): string | null {
  if (typeof value !== "string" || !/^\d+$/.test(value)) return null;
  const numeric = Number(value);
  return Number.isSafeInteger(numeric) && numeric > 0 ? value : null;
}

function cleanSearchPreference(value: unknown): JiraSearchPreference | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const connectionId = cleanText(raw.connectionId);
  const jql = typeof raw.jql === "string" ? raw.jql.trim() : "";
  if (!connectionId || !jql || jql.length > MAX_JQL) return null;
  const kind = raw.kind;
  if (kind !== "jql" && kind !== "my-issues" && kind !== "saved-filter" && kind !== "quick-search") return null;
  const filterId = kind === "saved-filter" ? cleanNumericId(String(raw.filterId || "")) : null;
  if (kind === "saved-filter" && !filterId) return null;
  return {
    connectionId,
    jql,
    kind,
    label: cleanText(raw.label),
    filterId,
  };
}

function searchIdentity(search: JiraSearchPreference): string {
  return `${search.connectionId}\0${search.kind}\0${search.filterId || ""}\0${search.jql}`;
}

function cleanPreference(value: unknown): JiraViewPreferences {
  if (!value || typeof value !== "object" || Array.isArray(value)) return defaultPreferences();
  const raw = value as Record<string, unknown>;
  const assignee =
    raw.assignee && typeof raw.assignee === "object" && !Array.isArray(raw.assignee)
      ? (raw.assignee as Record<string, unknown>)
      : null;
  const ids = Array.isArray(raw.quickFilterIds)
    ? [
        ...new Set(
          raw.quickFilterIds
            .filter((id): id is string => typeof id === "string" && id.trim().length > 0)
            .map((id) => cleanNumericId(id.trim()))
            .filter((id): id is string => id !== null),
        ),
      ].slice(0, MAX_FILTERS)
    : [];
  return {
    connectionId: cleanText(raw.connectionId),
    boardId: cleanNumericId(raw.boardId),
    boardName: cleanText(raw.boardName),
    boardType: cleanText(raw.boardType),
    activeView: raw.activeView === "board" || raw.activeView === "settings" ? raw.activeView : "issues",
    boardMode: raw.boardMode === "backlog" || raw.boardMode === "sprints" ? raw.boardMode : "issues",
    selectedSprintId: cleanNumericId(raw.selectedSprintId),
    quickFilterIds: ids,
    assignee:
      assignee?.kind === "unassigned"
        ? { kind: "unassigned" }
        : assignee &&
            (assignee.kind === "cloud" || assignee.kind === "dc") &&
            cleanText(assignee.id) &&
            cleanText(assignee.displayName)
          ? { id: cleanText(assignee.id)!, displayName: cleanText(assignee.displayName)!, kind: assignee.kind }
          : null,
    doneWithinDays:
      raw.doneWithinDays === null
        ? null
        : raw.doneWithinDays === 7 || raw.doneWithinDays === 30 || raw.doneWithinDays === 90
          ? raw.doneWithinDays
          : 14,
    issueSort: JIRA_ISSUE_SORTS.includes(raw.issueSort as JiraIssueSort) ? (raw.issueSort as JiraIssueSort) : "updated",
    lastSearch: cleanSearchPreference(raw.lastSearch),
    smartFilters: Array.isArray(raw.smartFilters) ? normalizeJiraSmartFilters(raw.smartFilters) : [],
  };
}

export function readJiraViewPreferences(
  profileId: string,
  workspaceId: string,
  storage?: JiraPreferenceStorage,
): JiraViewPreferences {
  try {
    const raw = storageOrDefault(storage)?.getItem(jiraViewPreferencesKey(profileId, workspaceId));
    if (!raw) return defaultPreferences();
    const envelope: unknown = JSON.parse(raw);
    if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) return defaultPreferences();
    const record = envelope as Record<string, unknown>;
    if ((record.version !== 1 && record.version !== 2 && record.version !== VERSION) || !record.preferences)
      return defaultPreferences();
    return cleanPreference(record.preferences);
  } catch {
    return defaultPreferences();
  }
}

/** Save only the successful query scope. Jira issue payloads and result history belong in the backend cache. */
export function writeLastJiraSearch(
  profileId: string,
  workspaceId: string,
  search: JiraSearchPreference,
  storage?: JiraPreferenceStorage,
): JiraViewPreferences {
  const current = readJiraViewPreferences(profileId, workspaceId, storage);
  const clean = cleanSearchPreference(search);
  if (!clean) return current;
  return writeJiraViewPreferences(profileId, workspaceId, { lastSearch: clean }, storage);
}

export function writeJiraViewPreferences(
  profileId: string,
  workspaceId: string,
  patch: Partial<JiraViewPreferences>,
  storage?: JiraPreferenceStorage,
): JiraViewPreferences {
  const current = readJiraViewPreferences(profileId, workspaceId, storage);
  const next = cleanPreference({ ...current, ...patch });
  try {
    storageOrDefault(storage)?.setItem(
      jiraViewPreferencesKey(profileId, workspaceId),
      JSON.stringify({ version: VERSION, preferences: next }),
    );
  } catch {
    // UI preferences are optional; keep the current session usable when storage is blocked.
  }
  return next;
}
