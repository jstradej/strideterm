export type JiraWorkspaceBoardMode = "issues" | "backlog" | "sprints";
export type JiraWorkspaceAssignee = { kind: "user"; id: string; label?: string } | { kind: "unassigned" };

export interface JiraSavedWorkspaceView {
  viewId: string;
  kind: "board" | "personal";
  connectionId: string;
  boardId: number | null;
  boardName: string;
  title: string;
  mode: JiraWorkspaceBoardMode;
  sprintId: number | null;
  quickFilterIds: number[];
  assignee: JiraWorkspaceAssignee | null;
  doneWithinDays: 7 | 14 | 30 | 90 | null;
  presentation?: "board" | "list";
  statusFilter?: string | null;
  personalScope?: "open" | "all";
  projectKeys?: string[];
  createdAt: number;
  updatedAt: number;
}

export interface JiraWorkspaceViewSync {
  state: "syncing" | "idle" | "error";
  startedAt?: number;
  syncedAt?: number;
  error?: string;
  /** Epoch ms of the failed attempt and the Jira error code behind `error`; set only while `state` is `error`. */
  failedAt?: number;
  code?: string;
  retryAfterMs?: number;
}

export interface JiraWorkspaceViewsState {
  workspaceId: string;
  profileId: string;
  views: Array<JiraSavedWorkspaceView | { viewId: "issues"; kind: "issues"; title: string }>;
  activeViewId: string;
  syncByViewId: Record<string, JiraWorkspaceViewSync>;
  /** Background polling of this profile's saved queries, by saved-query id. Present in payload snapshots only. */
  pollingByQueryId?: Record<string, JiraPollingWatchStatus>;
}

export type JiraWorkspaceViewInput = Pick<JiraSavedWorkspaceView, "kind" | "connectionId"> &
  Partial<Omit<JiraSavedWorkspaceView, "kind" | "connectionId" | "createdAt" | "updatedAt" | "projectKeys">> & {
    projectKeys?: string[] | null;
  };

export type JiraWorkspaceViewsSnapshot = Record<string, JiraWorkspaceViewsState>;

/** Background polling of one saved query, as the renderer sees it. `lastSuccessAt` / `lastError.at` are epoch ms. */
export interface JiraPollingWatchStatus {
  connectionId: string;
  status: "idle" | "polling" | "unsupported" | "incomplete" | "rate-limited" | "error";
  lastSuccessAt?: number;
  lastError?: { code: string; at: number };
  retryAt?: number;
}
