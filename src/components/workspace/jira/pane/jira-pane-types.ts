import { type JiraSearchKind } from "../jira-view-preferences.js";
import type { JiraAttachmentUploadResultDto } from "../../../../../electron/backend/ipc-schemas.js";
import type { JIRA_SAFE_ERROR_CODES } from "../../../../../electron/shared/jira-error-codes.js";
import type { JiraSmartFilterId } from "../../../../../electron/shared/jira-smart-filters.js";
import {
  type JiraWorkspaceViewInput,
  type JiraWorkspaceViewsState,
} from "../../../../../electron/shared/types/jira-workspace-views.js";

export type JiraConnection = {
  id: string;
  label: string;
  enabled?: boolean;
  issueKeyPrefixes?: string[];
  defaultJql?: string;
  projectKeys?: string[];
  pollSeconds?: number;
  deployment: string;
  webUrl: string;
  apiBaseUrl?: string;
  auth?: { kind: string; email?: string };
  subscriptionHeaderName?: string;
  clientCertificatePath?: string;
  accountPurpose?: string;
  verifiedIdentity?: { displayName: string };
  ownIdentity?: { kind: string; accountId?: string; name?: string; displayName: string };
  health?: { state: JiraErrorCode; checkedAt: string; retryAfterMs?: number };
  status?: "connected" | "needs-login" | "unavailable";
};

export type JiraBoard = {
  id: number;
  name: string;
  type: string;
  location?: { projectKey?: string; projectName?: string };
};

export type JiraColumn = { name: string; statuses: Array<{ id: string; name: string }> };

export type JiraSprint = { id: string | number; name: string; state: string; startDate?: string; endDate?: string };

export type JiraBoardFilter = { id: number | string; name: string; jql?: string };

export type JiraBoardOwner = { displayName: string; accountId?: string };

export type JiraBoardQuickFilter = { id: number; name: string; description?: string; jql: string; position: number };

export type JiraUserRef =
  | { kind: "cloud"; accountId: string; displayName: string }
  | { kind: "data-center"; key?: string; name: string; displayName: string };

export type JiraBoardAssignee = { kind: "user"; id: string; label: string } | { kind: "unassigned"; label: string };

export type JiraBoardCapabilities = {
  configuration?: "available" | "unknown" | "unsupported" | "permission-denied";
  issues?: "available" | "unknown" | "unsupported" | "permission-denied";
  backlog?: "available" | "unknown" | "unsupported" | "permission-denied";
  sprints?: "available" | "unknown" | "unsupported" | "permission-denied";
};

export type JiraCacheMetadata = {
  source: "cache" | "network";
  fetchedAt: number;
  stale: boolean;
  refreshError?: { code: string; message: string };
};

export function aggregateCacheMetadata(pages: Array<JiraCacheMetadata | null>): JiraCacheMetadata | null {
  const known = pages.filter((page): page is JiraCacheMetadata => page !== null);
  if (!known.length) return null;
  const refreshError = known.find((page) => page.refreshError)?.refreshError;
  return {
    source: known.every((page) => page.source === "network") ? "network" : "cache",
    fetchedAt: Math.min(...known.map((page) => page.fetchedAt)),
    stale: known.some((page) => page.stale),
    ...(refreshError ? { refreshError } : {}),
  };
}

export type JiraBoardViewResult = {
  issues: JiraIssue[];
  capability?: string;
  capabilities?: JiraBoardCapabilities;
  columns?: JiraColumn[];
  sprints?: JiraSprint[];
  hasMore?: boolean;
  nextCursor?: string;
  truncated?: boolean;
  selectedSprintId?: number;
  sprintsHasMore?: boolean;
  sprintsNextCursor?: string;
  filter?: JiraBoardFilter;
  owner?: JiraBoardOwner;
  cache?: JiraCacheMetadata;
};

export type JiraBoardSearchResult = { boards: JiraBoard[]; hasMore: boolean; nextCursor?: string; truncated?: boolean };

export type JiraWorkspaceRecord = {
  id: string;
  name: string;
  kind: string;
  profileId?: string;
  connectionId?: string;
  cwd?: string;
  gitRoots?: string[];
  activeRootPath?: string;
  panels?: unknown[];
  activePanelId?: string | null;
  activeViewId?: string | null;
  splitLayout?: string | null;
  splitViewIds?: string[];
  review?: unknown;
  quickfix?: { repositoryName?: string; baseBranch?: string } | null;
  workItems?: Array<{ ref: JiraIssueRef; summary?: string; status?: string }>;
  lastWorkedAt?: string;
  task?: {
    jiraIssueRefs?: JiraIssueRef[];
    jiraIssueSnapshots?: Array<{ ref: JiraIssueRef; fields?: { summary?: string } }>;
    state?: string;
    startedAt?: string | null;
    createdAt?: string;
    description?: string;
  } | null;
  jiraBoard?: {
    parentWorkspaceId: string;
    connectionId: string;
    boardId: string;
    boardName: string;
    projectKeys?: string[];
  };
  [key: string]: unknown;
};

export type JiraTransition = {
  id: string;
  name: string;
  to: string;
  requiredFields: Array<{
    id: string;
    name: string;
    type?: string;
    required: boolean;
    supported: boolean;
    allowedValues?: Array<{ value: string; label: string }>;
  }>;
};

export type JiraSavedQuery = {
  id: string;
  name: string;
  jql: string;
  connectionId: string;
  notificationsEnabled: boolean;
};

export type JiraSavedFilter = { id: string; name: string; jql?: string };

export type JiraRecentSearch = { connectionId: string; jql: string; label?: string; usedAt: number };

export type JiraRecentIssue = {
  ref: JiraIssueRef;
  summary: string;
  status: string;
  statusCategory?: "new" | "indeterminate" | "done";
  issueType?: string;
  viewedAt: number;
};

export type JiraComment = {
  id: string;
  author?: string | { displayName: string };
  created: string;
  body: string;
  bodyHtml?: string;
};

export type JiraCommentDraft = {
  id: string;
  ref: JiraIssueRef;
  body: string;
  sourceWorkspaceId: string;
  createdAt: string;
};

export type JiraWritePreview = {
  token: string;
  intent: string;
  preview: string;
  account?: { displayName: string; purpose: string };
};

export type JiraUiApi = {
  getJiraWorkspaceProjectScope?: (payload: { workspaceId: string; connectionId: string }) => Promise<string[] | null>;
  setJiraWorkspaceProjectScope?: (payload: {
    workspaceId: string;
    connectionId: string;
    projectKeys: string[] | null;
  }) => Promise<string[] | null>;
  getJiraWorkspaceViews?: (payload: { workspaceId: string }) => Promise<JiraWorkspaceViewsState>;
  saveJiraWorkspaceView?: (payload: {
    workspaceId: string;
    view: JiraWorkspaceViewInput;
  }) => Promise<JiraWorkspaceViewsState>;
  removeJiraWorkspaceView?: (payload: { workspaceId: string; viewId: string }) => Promise<JiraWorkspaceViewsState>;
  setJiraWorkspaceActiveView?: (payload: { workspaceId: string; viewId: string }) => Promise<JiraWorkspaceViewsState>;
  refreshJiraWorkspaceViews?: (payload: { workspaceId: string; viewId?: string }) => Promise<JiraWorkspaceViewsState>;
  getJiraRecentSearches?: (_payload: {
    connectionId: string;
    limit?: number;
  }) => Promise<Array<Omit<JiraRecentSearch, "connectionId">>>;
  rememberJiraSearch?: (_payload: { connectionId: string; jql: string; label?: string }) => Promise<unknown>;
  getJiraRecentIssues?: (_payload: { connectionId: string; limit?: number }) => Promise<JiraRecentIssue[]>;
  rememberJiraIssueViewed?: (_payload: { ref: JiraIssueRef }) => Promise<unknown>;
  getJiraBoardView?: (payload: {
    connectionId: string;
    boardId: number;
    mode: "issues" | "backlog" | "sprints";
    cursor?: string;
    sprintId?: number;
    quickFilterIds?: number[];
    assignee?: { kind: "user"; id: string } | { kind: "unassigned" };
    projectKeys?: string[];
    cacheOnly?: boolean;
    forceRefresh?: boolean;
  }) => Promise<JiraBoardViewResult | null>;
  listJiraProjects?: (connectionId: string) => Promise<unknown>;
  getJiraIssue?: (payload: {
    connectionId: string;
    issueId: string;
    cacheOnly?: boolean;
    forceRefresh?: boolean;
  }) => Promise<(JiraIssue & { cache?: JiraCacheMetadata }) | null>;
  searchJiraBoards?: (_payload: {
    connectionId: string;
    query?: string;
    cursor?: string;
    limit?: number;
    projectKeys?: string[];
  }) => Promise<JiraBoardSearchResult>;
  listJiraBoardQuickFilters?: (_payload: {
    connectionId: string;
    boardId: number;
    cursor?: string;
    limit?: number;
    cacheOnly?: boolean;
    forceRefresh?: boolean;
  }) => Promise<{
    filters: JiraBoardQuickFilter[];
    hasMore: boolean;
    nextCursor?: string;
    capability?: string;
    cache?: JiraCacheMetadata;
  }>;
  searchJiraUsers?: (_payload: { connectionId: string; query: string; limit?: number }) => Promise<JiraUserRef[]>;
  testJiraConnection?: (_payload: {
    id?: string;
    label: string;
    deployment: "data-center" | "cloud";
    webUrl: string;
    apiBaseUrl: string;
    authMode: "pat" | "apim";
    email?: string;
    apiToken?: string;
    pat?: string;
    subscriptionKey?: string;
    subscriptionHeaderName?: string;
    clientCertificatePath?: string;
    clientCertificatePassword?: string;
    accountPurpose: "personal" | "technical";
  }) => Promise<
    | { ok: true; identity?: { name?: string; displayName?: string; accountId?: string } }
    | { ok: false; error: { code?: string; message: string } }
  >;
  listJiraQueries?: (_connectionId: string) => Promise<JiraSavedQuery[]>;
  listJiraFavoriteFilters?: (_connectionId: string) => Promise<JiraSavedFilter[]>;
  getJiraSavedFilter?: (_payload: { connectionId: string; filterId: string }) => Promise<JiraSavedFilter>;
  saveJiraQuery?: (_payload: {
    id?: string;
    connectionId: string;
    name: string;
    jql: string;
    notificationsEnabled?: boolean;
  }) => Promise<{ id: string }>;
  deleteJiraQuery?: (_id: string) => Promise<unknown>;
  listJiraComments?: (_payload: { ref: JiraIssueRef }) => Promise<JiraComment[]>;
  listJiraCommentDrafts?: (_workspaceId: string) => Promise<JiraCommentDraft[]>;
  deleteJiraCommentDraft?: (_payload: { sourceWorkspaceId: string; draftId: string }) => Promise<unknown>;
  verifyJiraOwnIdentity?: (_payload: { connectionId: string; userId: string }) => Promise<unknown>;
  saveJiraIssueAttachment?: (_payload: {
    connectionId: string;
    issueId: string;
    attachmentId: string;
  }) => Promise<{ saved: boolean; filePath?: string }>;
  uploadJiraIssueAttachment?: (_payload: {
    connectionId: string;
    issueId: string;
  }) => Promise<JiraAttachmentUploadResultDto>;
  setJiraOwnIdentity?: (_payload: { connectionId: string; userId: string }) => Promise<unknown>;
  buildJiraOwnIssuesQuery?: (_payload: {
    connectionId: string;
    baseJql?: string;
    personalScope?: "open" | "all";
    projectKeys?: string[];
    smartFilters?: JiraSmartFilterId[];
  }) => Promise<{ jql: string; identityLabel: string }>;
  reconcileJiraWrite?: (_journalId: string) => Promise<{
    journalId: string;
    status: "reconciled" | "unknown";
    outcome: "applied" | "not-applied" | "unresolved";
  }>;
  azureQuickFixListProjects?: (_payload: { connectionId: string }) => Promise<{ projects?: TaskProject[] }>;
  azureQuickFixListRepositories?: (_payload: {
    connectionId: string;
    projectName: string;
  }) => Promise<{ repositories?: TaskRepo[] }>;
  azureQuickFixListBranches?: (_payload: {
    connectionId: string;
    projectName: string;
    repositoryId: string;
  }) => Promise<{ branches?: string[] }>;
  githubQuickFixListRepos?: (_payload: { connectionId: string }) => Promise<{ repositories?: TaskRepo[] }>;
  githubQuickFixListBranches?: (_payload: {
    connectionId: string;
    owner: string;
    repo: string;
  }) => Promise<{ branches?: string[] }>;
};

export type JiraIssueRef = { provider: "jira"; connectionId: string; issueId: string; issueKey: string };

export type JiraRepoBindingPreference = {
  provider: "azure" | "github";
  connectionId: string;
  repoId: string;
  projectId?: string;
  repoName: string;
  remoteUrl: string;
  baseBranch: string;
};

export type TaskRepo = {
  id?: string;
  name: string;
  fullName?: string;
  owner?: string;
  remoteUrl?: string;
  defaultBranch?: string;
};

export type TaskProject = { id: string; name: string };

export type TaskConnection = { id: string; label: string; profileId?: string; enabled?: boolean };

export type JiraIssue = {
  ref: JiraIssueRef;
  assigneeRef?: JiraUserRef;
  cache?: JiraCacheMetadata;
  id?: string;
  key?: string;
  summary?: string;
  title?: string;
  status?: string;
  statusId?: string;
  statusCategory?: "new" | "indeterminate" | "done";
  issueType?: string;
  assignee?: string;
  reporter?: string;
  priority?: string;
  resolution?: string;
  created?: string;
  description?: string;
  descriptionMarkdown?: string;
  descriptionHtml?: string;
  url?: string;
  projectKey?: string;
  updated?: string;
  labels?: string[];
  components?: string[];
  versions?: string[];
  issueLinks?: Array<{
    type: string;
    direction: "inward" | "outward";
    issueKey: string;
    summary?: string;
    status?: string;
  }>;
  sourceLabel?: string;
  attachments?: Array<{ id: string; fileName: string; mediaType: string; sizeBytes: number }>;
};

export type JiraErrorCode = (typeof JIRA_SAFE_ERROR_CODES)[number];

export type JiraSearchPage = {
  issues: JiraIssue[];
  hasMore?: boolean;
  nextCursor?: string;
  truncated?: boolean;
  cache?: JiraCacheMetadata;
};

export type JiraSearchScope = {
  kind?: JiraSearchKind;
  label?: string;
  filterId?: string | null;
  projectKeys?: string[];
  /** The smart-filter chips this query was built from; remembered with the search, empty otherwise. */
  smartFilters?: JiraSmartFilterId[];
  recordUsage?: boolean;
  registrySync?: boolean;
  /** Skip the cache-only read and ask Jira; for an explicit user Refresh. */
  forceRefresh?: boolean;
};

export type JiraSearchRequest = {
  connectionId: string;
  jql: string;
  limit: number;
  cursor?: string;
  cacheOnly?: boolean;
  forceRefresh?: boolean;
  projectKeys?: string[];
};

export type JiraInboxPaneProps = Readonly<{
  workspaceId: string;
  jiraViewId: string;
  showHeader: boolean;
  connectionsOnly: boolean;
  /** A pop-out window shows one issue and owns no board, search or saved view: nothing is restored, loaded or persisted. */
  detached?: boolean;
  detachedIssue?: { connectionId: string; issueId: string; issueKey: string };
}>;
