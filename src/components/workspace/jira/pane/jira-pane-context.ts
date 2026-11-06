import { inject, type InjectionKey, type Ref, type ComputedRef, type WritableComputedRef, type Reactive } from "vue";
import type { useAppStore } from "../../../../stores/app.js";
import type { CallableTransport } from "../../../../transport.js";
import type {
  JiraViewPreferences,
  JiraDoneWithinDays,
  JiraIssueSort,
  JiraSearchKind,
} from "../jira-view-preferences.js";
import type {
  JiraWorkspaceViewsState,
  JiraSavedWorkspaceView,
  JiraWorkspaceViewSync,
  JiraWorkspaceViewInput,
} from "../../../../../electron/shared/types/jira-workspace-views.js";
import type { JiraIssueStatusFilter } from "../jiraIssueList";
import type { JiraFacetKey, JiraFacetOption, JiraFacetSelection } from "../jiraIssueFacets";
import type { JiraSmartFilterId } from "../../../../../electron/shared/jira-smart-filters.js";
import type { JiraStatusTone } from "../jiraPeople";
import type { JiraWriteReasonControl, JiraAssignTarget } from "./useJiraIssueDetail.js";
import type { validateJiraMetadataDraft } from "./jira-metadata-validation.js";
import type {
  JiraCommentDraft,
  JiraConnection,
  JiraIssue,
  JiraRecentSearch,
  JiraRecentIssue,
  JiraCacheMetadata,
  JiraBoard,
  JiraBoardQuickFilter,
  JiraBoardAssignee,
  JiraUserRef,
  JiraBoardFilter,
  JiraBoardOwner,
  JiraBoardCapabilities,
  JiraRepoBindingPreference,
  JiraErrorCode,
  JiraUiApi,
  JiraSavedQuery,
  JiraSavedFilter,
  JiraColumn,
  JiraSprint,
  JiraComment,
  JiraTransition,
  JiraIssueRef,
  JiraWorkspaceRecord,
  JiraSearchRequest,
  JiraSearchPage,
  JiraSearchScope,
  JiraBoardViewResult,
  JiraInboxPaneProps,
} from "./jira-pane-types.js";

export interface JiraPaneContext {
  connectionsOnly: ComputedRef<boolean>;
  jiraViewId: ComputedRef<string>;
  store: ReturnType<typeof useAppStore>;
  api: CallableTransport;
  preferencesRestored: Ref<boolean, boolean>;
  restoringPreferences: Ref<boolean, boolean>;
  restoredPreferences: Ref<JiraViewPreferences | null>;
  workspaceViewsState: Ref<JiraWorkspaceViewsState | null>;
  workspaceViewRestored: Ref<boolean, boolean>;
  workspaceViewRestoredId: Ref<string, string>;
  workspaceViewSaving: Ref<boolean, boolean>;
  workspaceViewSaveError: Ref<string, string>;
  nativePresentationChoice: Ref<"board" | "list" | null>;
  nativeStatusFilter: Ref<string | null>;
  nativeStatusFilterConfigured: Ref<boolean, boolean>;
  nativePersonalScope: Ref<"open" | "all">;
  nativePersonalScopeConfigured: Ref<boolean, boolean>;
  projectScopeChoice: Ref<string[] | null>;
  projectScopeConfigured: Ref<boolean, boolean>;
  projectCatalogByConnection: Ref<Record<string, Array<{ id: string | number; key: string; name: string }>>>;
  projectCatalogLoading: Ref<boolean, boolean>;
  projectCatalogError: Ref<string, string>;
  projectCatalogTruncated: Ref<boolean, boolean>;
  projectCatalog: ComputedRef<{ id: string | number; key: string; name: string }[]>;
  projectScopeLabel: ComputedRef<string>;
  resolvedProjectScopeKeys: ComputedRef<string[]>;
  issueMatchesProjectScope: (issueKey: string) => boolean;
  recentViewedIssuesInScope: ComputedRef<
    {
      ref: { provider: "jira"; connectionId: string; issueId: string; issueKey: string };
      summary: string;
      status: string;
      statusCategory?: "new" | "indeterminate" | "done" | undefined;
      issueType?: string | undefined;
      viewedAt: number;
    }[]
  >;
  setProjectScope: (value: string[] | null) => void;
  emptyResultScope: ComputedRef<{ projectKeys: string[]; query: string; jql: string }>;
  searchAllProjects: () => void;
  clearActiveSearch: () => void;
  loadWorkspaceProjectScope: (requestedConnectionId: string) => Promise<void>;
  projectScopePayload: (
    value?: string[] | null,
    configured?: boolean,
  ) => { projectKeys?: undefined } | { projectKeys: string[] };
  nativePersonalScopeChoice: WritableComputedRef<"open" | "all", string | number | null>;
  personalScopeOptions: { value: string; label: string }[];
  preferencesProfileId: ComputedRef<string>;
  workspaceViews: ComputedRef<JiraWorkspaceViewsState | null>;
  selectedNativeView: ComputedRef<JiraSavedWorkspaceView | null | undefined>;
  isNativeSavedView: ComputedRef<boolean>;
  nativePresentation: ComputedRef<"board" | "list">;
  nativeListPresentation: ComputedRef<boolean>;
  nativeViewSync: ComputedRef<JiraWorkspaceViewSync | null>;
  canUseAttachmentFileDialogs: ComputedRef<boolean>;
  jiraRootRef: Ref<HTMLElement | null>;
  nativeIssueListRef: Ref<HTMLElement | null>;
  nativeIssueListScrollTop: Ref<number, number>;
  nativeBoardScrollLeft: Ref<number, number>;
  issueReturnNativeIssueId: Ref<string, string>;
  searchDetailsRef: Ref<HTMLDetailsElement | null>;
  jqlInputRef: Ref<HTMLInputElement | null>;
  quickSearchInputRef: Ref<HTMLInputElement | null>;
  boardChooserLabelRef: Ref<HTMLLabelElement | null>;
  activeView: Ref<"issues" | "board" | "settings">;
  boardViewLoaded: Ref<boolean, boolean>;
  boardLoadGeneration: Ref<number, number>;
  sprintLoadGeneration: Ref<number, number>;
  ownIssuesBoardMode: Ref<boolean, boolean>;
  ownIssueSearchGeneration: Ref<number, number>;
  ownBoardGeneration: Ref<number, number>;
  recentGeneration: Ref<number, number>;
  commentComposerInput: Ref<HTMLTextAreaElement | null>;
  writeDetailsRef: Ref<HTMLDetailsElement | null>;
  worklogComment: Ref<string, string>;
  writeSurface: Ref<"header" | "composer" | "form">;
  writeCardKind: Ref<"transition" | "assign" | null>;
  assignTarget: Ref<JiraAssignTarget | null>;
  statusMenuRef: Ref<HTMLDetailsElement | null>;
  assignMenuRef: Ref<HTMLDetailsElement | null>;
  statusPillRef: Ref<HTMLElement | null>;
  assignTriggerRef: Ref<HTMLElement | null>;
  writeCardRef: Ref<HTMLElement | null>;
  commentsListRef: Ref<HTMLElement | null>;
  transitionsError: Ref<string, string>;
  copyNotice: Ref<string, string>;
  copyError: Ref<string, string>;
  assignSearchText: Ref<string, string>;
  assignSearchResults: Ref<Array<{ id: string; label: string }>>;
  assignSearchLoading: Ref<boolean, boolean>;
  assignSearchError: Ref<string, string>;
  commentReason: JiraWriteReasonControl;
  writeReason: JiraWriteReasonControl;
  canSendComment: ComputedRef<boolean>;
  commentBodyError: ComputedRef<string>;
  onStatusMenuToggle: (event: Event) => void;
  onAssignMenuToggle: (event: Event) => void;
  closeMenuOnItemClick: (event: MouseEvent) => void;
  onMenuKeydown: (event: KeyboardEvent) => void;
  onMenuEscape: (event: KeyboardEvent) => void;
  pickTransition: (transition: JiraTransition) => Promise<void>;
  pickAssignee: (
    request: { kind: "user"; id: string; displayName?: string } | { kind: "me" } | { kind: "unassigned" },
    label: string,
  ) => Promise<void>;
  assignToMe: () => void;
  chooseIdentityFirst: () => void;
  closeWriteCard: (options?: { restoreFocus?: boolean }) => void;
  confirmWriteCard: () => Promise<void>;
  previewFormWrite: () => Promise<void>;
  sendComment: () => Promise<void>;
  discardCommentDraft: () => Promise<void>;
  draftReviewActive: Ref<boolean>;
  pendingAssignIssue: Ref<JiraIssue | null>;
  confirmDraftReview: () => Promise<void>;
  cancelDraftReview: () => void;
  focusComposer: () => Promise<void>;
  openFormAction: (action: "remote-link" | "worklog") => Promise<void>;
  copyIssueText: (what: "key" | "link") => Promise<void>;
  branchDialogOpen: Ref<boolean>;
  isCompactPane: Ref<boolean, boolean>;
  searchToolsOpen: Ref<boolean, boolean>;
  jiraCommentDrafts: Ref<JiraCommentDraft[]>;
  jiraDetailHeadingRef: Ref<HTMLElement | null>;
  issueTriggerRef: Ref<HTMLButtonElement | null>;
  issueReturnScrollTop: Ref<number, number>;
  connections: Ref<JiraConnection[]>;
  connectionsLoaded: Ref<boolean, boolean>;
  setupInProgress: Ref<boolean, boolean>;
  setupDismissed: Ref<boolean, boolean>;
  setupStep: Ref<number, number>;
  setupValidationError: Ref<string, string>;
  connectionTestBusy: Ref<boolean, boolean>;
  connectionSaveBusy: Ref<boolean, boolean>;
  connectionTestState: Ref<"idle" | "testing" | "success" | "error">;
  connectionTestMessage: Ref<string, string>;
  connectionTestFieldError: Ref<
    | "webUrl"
    | "apiBaseUrl"
    | "pat"
    | "email"
    | "apiToken"
    | "subscriptionKey"
    | "subscriptionHeaderName"
    | "certificate"
    | "certificatePassword"
    | null
  >;
  connectionTestResultRef: Ref<HTMLElement | null>;
  verifyingConnectionId: Ref<string | null>;
  connectionVerificationResults: Record<string, { ok: boolean; message: string }>;
  connectionVerificationGenerations: Map<string, number>;
  setupNameInput: Ref<HTMLInputElement | null>;
  setupWebUrlInput: Ref<HTMLInputElement | null>;
  setupApiUrlInput: Ref<HTMLInputElement | null>;
  setupPatInput: Ref<HTMLInputElement | null>;
  setupKeyInput: Ref<HTMLInputElement | null>;
  setupHeaderInput: Ref<HTMLInputElement | null>;
  setupCertificateInput: Ref<HTMLInputElement | null>;
  setupCertificatePasswordInput: Ref<HTMLInputElement | null>;
  setupEmailInput: Ref<HTMLInputElement | null>;
  setupApiTokenInput: Ref<HTMLInputElement | null>;
  setupFinishButton: Ref<HTMLButtonElement | null>;
  addConnectionButton: Ref<HTMLButtonElement | null>;
  setupReturnFocus: Ref<HTMLElement | null>;
  issues: Ref<JiraIssue[]>;
  recentSearches: Ref<JiraRecentSearch[]>;
  recentViewedIssues: Ref<JiraRecentIssue[]>;
  searchCursor: Ref<string, string>;
  activeSearchJql: Ref<string, string>;
  activeSearchProjectKeys: Ref<string[] | undefined>;
  ownSearchIdentityLabel: Ref<string, string>;
  activeSearchLabel: Ref<string, string>;
  activeSearchKind: Ref<JiraSearchKind, JiraSearchKind>;
  activeSearchFilterId: Ref<string | null, string | null>;
  searchHasMore: Ref<boolean, boolean>;
  allMyIssueCursors: Ref<Map<string, { cursor: string; jql: string; sourceLabel: string }>>;
  searchTruncated: Ref<boolean, boolean>;
  issuesLoading: Ref<boolean, boolean>;
  issuesLoadingLabel: Ref<string, string>;
  searchHasRun: Ref<boolean, boolean>;
  searchFailed: Ref<boolean, boolean>;
  searchCache: Ref<JiraCacheMetadata | null>;
  searchRefreshing: Ref<boolean, boolean>;
  connectionsLoading: Ref<boolean, boolean>;
  identityPanelOpen: Ref<boolean, boolean>;
  boards: Ref<JiraBoard[]>;
  boardsLoading: Ref<boolean, boolean>;
  boardId: Ref<number, number>;
  boardIssueDetailOpen: Ref<boolean, boolean>;
  selectedQuickFilterIds: Ref<number[]>;
  boardFilterDetailsRef: Ref<HTMLDetailsElement | null>;
  boardFilterOpenOverride: Ref<boolean | null>;
  boardQuickFilters: Ref<JiraBoardQuickFilter[]>;
  selectedBoardAssignee: Ref<JiraBoardAssignee | null>;
  boardFilterDetailsOpen: ComputedRef<boolean>;
  assigneeCatalog: Ref<JiraUserRef[]>;
  assigneeSearchText: Ref<string, string>;
  assigneeSearchResults: Ref<JiraUserRef[]>;
  assigneeSearchLoading: Ref<boolean, boolean>;
  boardMode: Ref<"issues" | "backlog" | "sprints">;
  boardLoading: Ref<boolean, boolean>;
  boardRefreshing: Ref<boolean, boolean>;
  boardCache: Ref<JiraCacheMetadata | null>;
  boardRefreshError: Ref<string, string>;
  boardQuickFilterError: Ref<string, string>;
  boardPageCacheMetadata: Ref<Array<JiraCacheMetadata | null>>;
  sprintMetadataPageCacheMetadata: Ref<Array<JiraCacheMetadata | null>>;
  sprintIssuePageCacheMetadata: Ref<Array<JiraCacheMetadata | null>>;
  visibleRefreshInProgress: Ref<boolean, boolean>;
  boardCapability: Ref<string, string>;
  boardFilter: Ref<JiraBoardFilter | null>;
  boardOwner: Ref<JiraBoardOwner | null>;
  boardCapabilities: Ref<JiraBoardCapabilities>;
  boardPageCursor: Ref<string, string>;
  boardPageCursors: Ref<Array<string | undefined>>;
  boardHasMore: Ref<boolean, boolean>;
  boardPageTruncated: Ref<boolean, boolean>;
  sprintsPageCursor: Ref<string, string>;
  sprintMetadataPageCursors: Ref<Array<string | undefined>>;
  sprintsHasMore: Ref<boolean, boolean>;
  selected: Ref<JiraIssue | null>;
  selectedRefreshError: Ref<string, string>;
  selectedRefreshing: Ref<boolean, boolean>;
  workspaceLinksOpen: Ref<boolean, boolean>;
  issuePreviewIssue: Ref<JiraIssue | null>;
  issuePreviewDetails: Ref<JiraIssue | null>;
  issuePreviewVisible: Ref<boolean, boolean>;
  issuePreviewLoading: Ref<boolean, boolean>;
  issuePreviewError: Ref<string, string>;
  issuePreviewRef: Ref<HTMLElement | null>;
  issuePreviewStyle: Ref<Record<string, string>>;
  jiraResultsRef: Ref<HTMLElement | null>;
  issueLoading: Ref<boolean, boolean>;
  issuePendingKey: Ref<string, string>;
  transitionsLoading: Ref<boolean, boolean>;
  attachmentDownloads: Record<string, "cancelled" | "saving" | "saved">;
  attachmentUploadState: Ref<"idle" | "uploading" | "uploaded">;
  savedRepoBinding: Ref<JiraRepoBindingPreference | null>;
  connectionId: Ref<string, string>;
  jql: Ref<string, string>;
  textSearch: Ref<string, string>;
  quickSearchText: Ref<string, string>;
  quickSearchError: Ref<string, string>;
  busyActions: Reactive<Record<string, boolean>>;
  beginBusy: (key: string) => () => void;
  isBusy: (...keys: string[]) => boolean;
  clearBusy: (options?: { only?: readonly string[] }) => void;
  error: Ref<string, string>;
  errorStatus: Ref<{ code: JiraErrorCode; retryAfterMs?: number } | null>;
  refreshFailure: Ref<string, string>;
  attachmentError: Ref<string, string>;
  workspaceLinkError: Ref<string, string>;
  commentDraftsError: Ref<string, string>;
  developmentError: Ref<string, string>;
  writeError: Ref<string, string>;
  writeFieldError: ComputedRef<string>;
  clearIssueErrors: () => void;
  connectionActionError: Ref<string, string>;
  identityError: Ref<string, string>;
  metadataError: Ref<string, string>;
  metadataTouched: Ref<boolean, boolean>;
  metadataValidation: ComputedRef<ReturnType<typeof validateJiraMetadataDraft>>;
  restoreRetryable: Ref<boolean, boolean>;
  refreshConnectionList: () => Promise<boolean>;
  retryRestore: () => void;
  resetLoadingState: () => void;
  projectScopeError: Ref<string, string>;
  queryError: Ref<string, string>;
  queryNotice: Ref<string, string>;
  boardActionError: Ref<string, string>;
  assigneeSearchError: Ref<string, string>;
  openRequestedJiraIssue: () => void;
  draft: {
    id: string | undefined;
    label: string;
    deployment: "data-center" | "cloud";
    authMode: "pat" | "apim";
    webUrl: string;
    apiBaseUrl: string;
    email: string;
    apiToken: string;
    pat: string;
    subscriptionKey: string;
    subscriptionHeaderName: string;
    clientCertificatePath: string;
    clientCertificatePassword: string;
    accountPurpose: "personal" | "technical";
  };
  metadataDraft: {
    label: string;
    accountPurpose: "personal" | "technical";
    issueKeyPrefixesText: string;
    defaultJql: string;
    projectKeysText: string;
    pollSeconds: number;
  };
  accountPurposeOptions: { value: string; label: string }[];
  connectionTypeOptions: { value: string; label: string }[];
  connectionType: WritableComputedRef<"cloud" | "pat" | "apim", string>;
  connectionTypeDescription: ComputedRef<
    | "Atlassian-hosted Jira. You’ll enter your site address, your Atlassian account email and an API token you create yourself."
    | "Jira reached through an API gateway. You’ll enter the Jira and gateway URLs, a gateway subscription key, and an optional client certificate."
    | "Self-hosted Jira Data Center. You’ll enter the Jira URLs and a personal access token."
  >;
  metadataEditing: Ref<boolean, boolean>;
  commentBody: Ref<string, string>;
  writeIntent: Ref<string, string>;
  writeConfirmation: Ref<{
    token: string;
    intent: string;
    preview: string;
    account?: { displayName: string; purpose: string };
  } | null>;
  dynamicApi: Omit<CallableTransport, keyof JiraUiApi> & JiraUiApi;
  detached: ComputedRef<boolean>;
  canPopOutIssue: ComputedRef<boolean>;
  popOutSelectedIssue: () => Promise<void>;
  canManageConnections: ComputedRef<boolean>;
  setupVisible: ComputedRef<boolean>;
  noConnectionManager: ComputedRef<boolean>;
  canManageQueries: ComputedRef<boolean>;
  canWriteJira: ComputedRef<boolean>;
  canLinkWorkspaces: ComputedRef<boolean>;
  connectionOptions: ComputedRef<{ value: string; label: string }[]>;
  savedQueries: Ref<JiraSavedQuery[]>;
  favoriteFilters: Ref<JiraSavedFilter[]>;
  favoriteFiltersUnavailable: Ref<boolean, boolean>;
  favoriteFilterId: Ref<string, string>;
  savedFilterLookupId: Ref<string, string>;
  queryId: Ref<string, string>;
  queryName: Ref<string, string>;
  queryNotificationsEnabled: Ref<boolean, boolean>;
  boardColumns: Ref<JiraColumn[]>;
  boardSearchQuery: Ref<string, string>;
  boardSearchCursor: Ref<string, string>;
  boardsHaveMore: Ref<boolean, boolean>;
  boardPickerNotice: Ref<string, string>;
  boardCatalogLoaded: Ref<boolean, boolean>;
  boardSearchGeneration: Ref<number, number>;
  selectedBoardLabel: Ref<string, string>;
  selectedBoardType: Ref<string, string>;
  boardOptions: ComputedRef<{ value: number; label: string }[]>;
  boardModeOptions: ComputedRef<{ value: string; label: string }[]>;
  doneWithinDays: Ref<JiraDoneWithinDays | null>;
  issueSort: Ref<JiraIssueSort>;
  issueSortOptions: { value: JiraIssueSort; label: string }[];
  issueFilterText: Ref<string, string>;
  issueStatusFilter: Ref<JiraIssueStatusFilter>;
  issueFacets: Ref<JiraFacetSelection>;
  facetOptions: ComputedRef<Record<JiraFacetKey, JiraFacetOption[]>>;
  smartFilters: Ref<JiraSmartFilterId[]>;
  toggleSmartFilter: (id: JiraSmartFilterId) => Promise<void>;
  textFilteredIssues: ComputedRef<
    {
      ref: { provider: "jira"; connectionId: string; issueId: string; issueKey: string };
      assigneeRef?:
        | { kind: "cloud"; accountId: string; displayName: string }
        | { kind: "data-center"; key?: string | undefined; name: string; displayName: string }
        | undefined;
      cache?:
        | {
            source: "cache" | "network";
            fetchedAt: number;
            stale: boolean;
            refreshError?: { code: string; message: string } | undefined;
          }
        | undefined;
      id?: string | undefined;
      key?: string | undefined;
      summary?: string | undefined;
      title?: string | undefined;
      status?: string | undefined;
      statusId?: string | undefined;
      statusCategory?: "new" | "indeterminate" | "done" | undefined;
      issueType?: string | undefined;
      assignee?: string | undefined;
      reporter?: string | undefined;
      priority?: string | undefined;
      resolution?: string | undefined;
      created?: string | undefined;
      description?: string | undefined;
      descriptionMarkdown?: string | undefined;
      url?: string | undefined;
      projectKey?: string | undefined;
      updated?: string | undefined;
      labels?: string[] | undefined;
      components?: string[] | undefined;
      versions?: string[] | undefined;
      issueLinks?:
        | {
            type: string;
            direction: "inward" | "outward";
            issueKey: string;
            summary?: string | undefined;
            status?: string | undefined;
          }[]
        | undefined;
      sourceLabel?: string | undefined;
      attachments?: { id: string; fileName: string; mediaType: string; sizeBytes: number }[] | undefined;
    }[]
  >;
  issueStatusGroups: ComputedRef<
    (
      | { value: "all"; label: string; tone: undefined; count: number }
      | { value: "todo"; label: string; tone: string; count: number }
      | { value: "active"; label: string; tone: string; count: number }
      | { value: "done"; label: string; tone: string; count: number }
    )[]
  >;
  visibleIssueList: ComputedRef<
    {
      ref: { provider: "jira"; connectionId: string; issueId: string; issueKey: string };
      assigneeRef?:
        | { kind: "cloud"; accountId: string; displayName: string }
        | { kind: "data-center"; key?: string | undefined; name: string; displayName: string }
        | undefined;
      cache?:
        | {
            source: "cache" | "network";
            fetchedAt: number;
            stale: boolean;
            refreshError?: { code: string; message: string } | undefined;
          }
        | undefined;
      id?: string | undefined;
      key?: string | undefined;
      summary?: string | undefined;
      title?: string | undefined;
      status?: string | undefined;
      statusId?: string | undefined;
      statusCategory?: "new" | "indeterminate" | "done" | undefined;
      issueType?: string | undefined;
      assignee?: string | undefined;
      reporter?: string | undefined;
      priority?: string | undefined;
      resolution?: string | undefined;
      created?: string | undefined;
      description?: string | undefined;
      descriptionMarkdown?: string | undefined;
      url?: string | undefined;
      projectKey?: string | undefined;
      updated?: string | undefined;
      labels?: string[] | undefined;
      components?: string[] | undefined;
      versions?: string[] | undefined;
      issueLinks?:
        | {
            type: string;
            direction: "inward" | "outward";
            issueKey: string;
            summary?: string | undefined;
            status?: string | undefined;
          }[]
        | undefined;
      sourceLabel?: string | undefined;
      attachments?: { id: string; fileName: string; mediaType: string; sizeBytes: number }[] | undefined;
    }[]
  >;
  clearIssueListFilter: () => void;
  applyIssueSort: () => void;
  doneWithinOptions: { value: string; label: string }[];
  doneWithinChoice: WritableComputedRef<string, string>;
  sprintOptions: ComputedRef<{ value: number; label: string }[]>;
  boardSprints: Ref<JiraSprint[]>;
  selectedSprint: ComputedRef<{
    id: string | number;
    name: string;
    state: string;
    startDate?: string | undefined;
    endDate?: string | undefined;
  } | null>;
  sprintDateRange: ComputedRef<string>;
  sprintRemainingLabel: ComputedRef<string>;
  sprintProgress: ComputedRef<{ total: number; done: number }>;
  selectedSprintId: Ref<number | null>;
  sprintIssues: Ref<JiraIssue[]>;
  sprintIssuesCursor: Ref<string, string>;
  sprintIssuePageCursors: Ref<Array<string | undefined>>;
  sprintIssuesHasMore: Ref<boolean, boolean>;
  sprintIssuesTruncated: Ref<boolean, boolean>;
  comments: Ref<JiraComment[]>;
  commentsLoading: Ref<boolean, boolean>;
  commentsError: Ref<string, string>;
  transitions: Ref<JiraTransition[]>;
  writeAction: Ref<string, string>;
  writeActionOptions: { value: string; label: string }[];
  transitionId: Ref<string, string>;
  transitionFields: Reactive<Map<string, string>>;
  remoteUrl: Ref<string, string>;
  remoteTitle: Ref<string, string>;
  worklogDuration: Ref<string, string>;
  worklogSeconds: ComputedRef<number>;
  worklogStarted: Ref<string, string>;
  connectionStatus: Ref<string, string>;
  identityValue: Ref<string, string>;
  humanIdentitySetupOpen: Ref<boolean, boolean>;
  humanIdentitySearchText: Ref<string, string>;
  humanIdentitySearchResults: Ref<JiraUserRef[]>;
  humanIdentitySelectedUser: Ref<JiraUserRef | null>;
  humanIdentitySearchLoading: Ref<boolean, boolean>;
  humanIdentitySaving: Ref<boolean, boolean>;
  humanIdentitySearchError: Ref<string, string>;
  activeRequiredFields: ComputedRef<
    {
      id: string;
      name: string;
      type?: string | undefined;
      required: boolean;
      supported: boolean;
      allowedValues?: { value: string; label: string }[] | undefined;
    }[]
  >;
  repoPreferenceNotice: Ref<string, string>;
  canPreviewWrite: ComputedRef<boolean>;
  writeMessage: Ref<string, string>;
  writeJournal: Ref<{ journalId: string; status: string; outcome?: string } | null>;
  selectedConnection: ComputedRef<
    | {
        id: string;
        label: string;
        enabled?: boolean | undefined;
        issueKeyPrefixes?: string[] | undefined;
        defaultJql?: string | undefined;
        projectKeys?: string[] | undefined;
        pollSeconds?: number | undefined;
        deployment: string;
        webUrl: string;
        apiBaseUrl?: string | undefined;
        auth?: { kind: string; email?: string } | undefined;
        subscriptionHeaderName?: string | undefined;
        clientCertificatePath?: string | undefined;
        accountPurpose?: string | undefined;
        verifiedIdentity?: { displayName: string } | undefined;
        ownIdentity?:
          { kind: string; accountId?: string | undefined; name?: string | undefined; displayName: string } | undefined;
        health?: { state: JiraErrorCode; checkedAt: string; retryAfterMs?: number | undefined } | undefined;
        status?: "connected" | "needs-login" | "unavailable" | undefined;
      }
    | undefined
  >;
  syncClock: Ref<number, number>;
  visibleCacheMetadata: ComputedRef<{
    source: "cache" | "network";
    fetchedAt: number;
    stale: boolean;
    refreshError?: { code: string; message: string } | undefined;
  } | null>;
  visibleSyncError: ComputedRef<string>;
  isVisibleSyncing: ComputedRef<boolean>;
  headCacheMetadata: ComputedRef<JiraCacheMetadata | null>;
  headSyncLabel: ComputedRef<string>;
  backgroundFailureText: ComputedRef<string>;
  backgroundRefreshing: ComputedRef<boolean>;
  contentPending: ComputedRef<boolean>;
  stripBusy: ComputedRef<boolean>;
  stripVisible: Ref<boolean, boolean>;
  shownStripLabel: Ref<string, string>;
  stripBackground: ComputedRef<boolean>;
  stripExistingResultsNote: ComputedRef<boolean>;
  formatSyncAge: (fetchedAt: number) => string;
  updateSyncClock: () => void;
  jiraDescriptionRoutes: ComputedRef<
    { connectionId: string; label: string; webUrl: string; issueKeyPrefixes: string[] }[]
  >;
  linkWorkspaceId: Ref<string, string>;
  profileWorkspaces: ComputedRef<
    { id: string; name: string; profileId?: string; workItems?: Array<{ ref: JiraIssueRef }> }[]
  >;
  workspaceOptions: ComputedRef<
    { id: string; name: string; profileId?: string; workItems?: Array<{ ref: JiraIssueRef }> }[]
  >;
  workspaceSelectOptions: ComputedRef<{ value: string; label: string }[]>;
  linkedWorkspaces: ComputedRef<
    { id: string; name: string; profileId?: string; workItems?: Array<{ ref: JiraIssueRef }> }[]
  >;
  selectedBoard: ComputedRef<
    | {
        id: number;
        name: string;
        type: string;
        location?: { projectKey?: string | undefined; projectName?: string | undefined } | undefined;
      }
    | undefined
  >;
  isOwnBoardFilterSelected: ComputedRef<boolean>;
  matchingDevelopmentWorkspaces: ComputedRef<
    {
      id: string;
      name: string;
      terminal: boolean;
      status: string;
      statusLabel: string;
      summary: string;
      activityAt: number;
    }[]
  >;
  recentDevelopmentWorkspaces: ComputedRef<
    { id: string; name: string; issueKey: string; summary: string; statusLabel: string; activityAt: number }[]
  >;
  hasExistingDevelopmentWorkspace: ComputedRef<boolean>;
  workspaceRecords: ComputedRef<JiraWorkspaceRecord[]>;
  openRecentDevelopment: (workspaceId: string) => Promise<void>;
  persistWorkspaceProjectScope: (value: string[] | null) => Promise<void>;
  currentWorkspace: ComputedRef<JiraWorkspaceRecord | undefined>;
  pinnedBoardInfo: ComputedRef<
    | { parentWorkspaceId: string; connectionId: string; boardId: string; boardName: string; projectKeys?: string[] }
    | undefined
  >;
  jiraInboxWorkspace: ComputedRef<JiraWorkspaceRecord | null>;
  pinnedBoardWorkspace: ComputedRef<JiraWorkspaceRecord | null>;
  selectedBoardSavedView: ComputedRef<JiraSavedWorkspaceView | null>;
  canOpenSelectedBoardAsTab: ComputedRef<boolean>;
  compactBoardLayout: ComputedRef<boolean>;
  compactSelectedIssue: ComputedRef<boolean>;
  status: ComputedRef<string>;
  loadConnections: () => Promise<void>;
  persistJiraViewPreferences: () => void;
  mapSettledBounded: <T, R>(
    items: T[],
    limit: number,
    mapper: (item: T) => Promise<R>,
  ) => Promise<PromiseSettledResult<R>[]>;
  requestSearchPage: (payload: JiraSearchRequest) => Promise<JiraIssue[] | JiraSearchPage | null>;
  reloadForProjectScope: () => Promise<void>;
  loadJiraProjectCatalog: (requestedConnectionId: string) => Promise<void>;
  applySearchPage: (result: JiraIssue[] | JiraSearchPage, preserveSelection: boolean) => void;
  refreshSearchResults: (
    requestedConnectionId: string,
    requestedProfileId: string,
    query: string,
    generation: number,
    projectKeys?: string[],
  ) => Promise<void>;
  search: (query?: string, preserveSelection?: boolean, scope?: JiraSearchScope) => Promise<void>;
  searchAllText: () => Promise<void>;
  buildJiraTextSearchJql: (text: string) => string;
  searchQuick: () => Promise<void>;
  searchOwnIssues: (baseJql?: string, options?: { recordUsage?: boolean }) => Promise<void>;
  loadDefaultIssues: () => void;
  loadDefaultIssuesNow: () => void;
  searchAllMyIssues: (baseJql?: string) => Promise<void>;
  loadMore: () => Promise<void>;
  loadMoreAllMyIssues: () => Promise<void>;
  onConnectionChange: () => Promise<void>;
  applyConnectionDefaults: () => void;
  queueBoardSearch: (query: string) => void;
  loadMoreBoards: () => Promise<void>;
  loadBoards: (query?: string, append?: boolean) => Promise<void>;
  nativeJiraViewId: (viewId: string) => string;
  workspaceViewInput: (kind: "board" | "personal", identityLabel?: string) => JiraWorkspaceViewInput;
  queueNativeViewSave: (view: JiraSavedWorkspaceView, input?: JiraWorkspaceViewInput) => void;
  applyWorkspaceViewsState: (state: JiraWorkspaceViewsState) => void;
  saveAndActivateNativeView: (input: JiraWorkspaceViewInput) => Promise<boolean>;
  flushPendingNativeViewSave: () => Promise<void>;
  openSelectedBoardAsNativeTab: () => Promise<void>;
  openPinnedBoard: (workspaceId: string) => Promise<void>;
  onBoardChange: () => void;
  onBoardModeChange: () => void;
  loadBoardQuickFilters: (forceRefresh?: boolean) => Promise<boolean>;
  boardFilterPayload: () =>
    | {
        doneWithinDays?: JiraDoneWithinDays | undefined;
        assignee?: { kind: "unassigned"; id?: undefined } | { kind: "user"; id: string } | undefined;
        quickFilterIds?: number[] | undefined;
        projectKeys?: undefined;
      }
    | {
        doneWithinDays?: JiraDoneWithinDays | undefined;
        assignee?: { kind: "unassigned"; id?: undefined } | { kind: "user"; id: string } | undefined;
        quickFilterIds?: number[] | undefined;
        projectKeys: string[];
      };
  mergeAssigneeCatalog: (users: JiraUserRef[], replace?: boolean) => void;
  collectIssueAssignees: (issues: JiraIssue[], replace?: boolean) => void;
  toggleQuickFilter: (filterId: number) => void;
  onBoardFilterDetailsToggle: (event: Event) => void;
  onBoardFilterDetailsKeydown: (event: KeyboardEvent) => void;
  jiraUserIdentity: (user: JiraUserRef) => string;
  jiraUserOptionKey: (user: JiraUserRef) => string;
  queueAssigneeSearch: () => void;
  selectBoardAssignee: (user: JiraUserRef) => void;
  openMyIssuesBoard: () => Promise<void>;
  selectUnassignedAssignee: () => void;
  clearBoardAssignee: () => void;
  chooseFirstAssigneeResult: () => void;
  loadJiraRecents: (requestedConnectionId: string) => Promise<void>;
  runRecentSearch: (recent: JiraRecentSearch) => Promise<void>;
  openRecentIssue: (recent: JiraRecentIssue) => Promise<void>;
  loadQueries: () => Promise<void>;
  runFavoriteFilter: (filterId?: string) => Promise<void>;
  runSavedFilterById: () => Promise<void>;
  /** Text with the action first, a `[renderer]` log line and the error ref next to the control (the banner without one). */
  reportFailure: (context: string, cause: unknown, target?: Ref<string>) => string;
  reportFailureText: (context: string, cause: unknown) => string;
  reportPartialFailures: (prefix: string, failures: Array<{ label: string; cause: unknown }>, suffix?: string) => void;
  clearPaneError: () => void;
  isJiraAccessFailure: (cause: unknown) => boolean;
  friendlyConnectionError: (cause: unknown, fallback: string) => string;
  jiraErrorLabel: (code: JiraErrorCode) => string;
  saveQuery: () => Promise<void>;
  runSavedQuery: (id: string) => Promise<void>;
  updateSavedQuery: (query: JiraSavedQuery, patch: { name?: string; notificationsEnabled?: boolean }) => Promise<void>;
  showIssuesView: () => void;
  deleteQuery: (id?: string) => Promise<void>;
  verifyConnection: () => Promise<boolean>;
  openConnectionSettings: () => void;
  toggleConnectionPanel: (id: string) => Promise<void>;
  expandedConnectionId: Ref<string | undefined>;
  openConnectionPanelId: ComputedRef<string>;
  finishSetup: () => void;
  startConnectionSetup: () => void;
  cancelConnectionSetup: () => void;
  returnFocusFromSetup: () => Promise<void>;
  backToConnectionType: () => void;
  resetConnectionDraft: () => void;
  clearConnectionTestResult: () => void;
  focusSetupStep: (step: number) => Promise<void>;
  goToConnectionDetails: () => void;
  fillConnectionLabel: () => void;
  validateSetupConnection: () => boolean;
  focusConnectionTestResult: () => Promise<void>;
  markConnectionTestFieldError: (messageText: string) => void;
  testSetupConnection: () => Promise<void>;
  saveSetupConnection: () => Promise<void>;
  chooseClientCertificate: () => Promise<void>;
  openApiTokenHelp: () => Promise<void>;
  editConnectionCredentials: () => void;
  connectionEditTab: Ref<"general" | "connection">;
  credentialsInline: ComputedRef<boolean>;
  openConnectionEditTab: (tab: "general" | "connection") => void;
  closeConnectionEdit: () => void;
  jiraConnectionTypeLabel: (
    connection: JiraConnection,
  ) => "Jira Cloud · API token" | "API gateway (APIM)" | "Jira Data Center · PAT";
  runManagedConnectionAction: (
    connectionIdToManage: string,
    action: "verify" | "edit" | "credentials" | "disconnect",
  ) => Promise<void>;
  editConnectionMetadata: () => void;
  saveConnectionMetadata: () => Promise<void>;
  signInAgainWithCredentials: (connection: JiraConnection) => Promise<void>;
  signInConnection: ComputedRef<JiraConnection | null>;
  signInExpired: ComputedRef<boolean>;
  signInBannerDuplicate: ComputedRef<boolean>;
  signInAgain: () => Promise<void>;
  openJiraSettings: () => void;
  rateLimitRemainingMs: Ref<number, number>;
  rateLimitAutoRetry: Ref<boolean, boolean>;
  retryAfterRateLimit: () => void;
  loadBoard: () => Promise<void>;
  refreshNativeBoardFromCache: () => Promise<void>;
  isCurrentBoardRequest: (
    generation: number,
    requestedConnectionId: string,
    requestedBoardId: number,
    mode: string,
  ) => boolean;
  applyBoardViewResult: (
    result: JiraBoardViewResult,
    generation: number,
    requestedConnectionId: string,
    requestedBoardId: number,
    mode: "issues" | "backlog" | "sprints",
  ) => void;
  refreshBoardSnapshot: () => Promise<void>;
  loadMoreBoard: () => Promise<void>;
  loadSelectedSprintIssues: () => Promise<void>;
  loadMoreSprintIssues: () => Promise<void>;
  boardColumnViews: ComputedRef<
    {
      name: string;
      statusNames: string[];
      extraStatuses: string[];
      tone: JiraStatusTone;
      issues: {
        ref: { provider: "jira"; connectionId: string; issueId: string; issueKey: string };
        assigneeRef?:
          | { kind: "cloud"; accountId: string; displayName: string }
          | { kind: "data-center"; key?: string | undefined; name: string; displayName: string }
          | undefined;
        cache?:
          | {
              source: "cache" | "network";
              fetchedAt: number;
              stale: boolean;
              refreshError?: { code: string; message: string } | undefined;
            }
          | undefined;
        id?: string | undefined;
        key?: string | undefined;
        summary?: string | undefined;
        title?: string | undefined;
        status?: string | undefined;
        statusId?: string | undefined;
        statusCategory?: "new" | "indeterminate" | "done" | undefined;
        issueType?: string | undefined;
        assignee?: string | undefined;
        reporter?: string | undefined;
        priority?: string | undefined;
        resolution?: string | undefined;
        created?: string | undefined;
        description?: string | undefined;
        descriptionMarkdown?: string | undefined;
        url?: string | undefined;
        projectKey?: string | undefined;
        updated?: string | undefined;
        labels?: string[] | undefined;
        components?: string[] | undefined;
        versions?: string[] | undefined;
        issueLinks?:
          | {
              type: string;
              direction: "inward" | "outward";
              issueKey: string;
              summary?: string | undefined;
              status?: string | undefined;
            }[]
          | undefined;
        sourceLabel?: string | undefined;
        attachments?: { id: string; fileName: string; mediaType: string; sizeBytes: number }[] | undefined;
      }[];
    }[]
  >;
  nativeIssueSource: ComputedRef<
    {
      ref: { provider: "jira"; connectionId: string; issueId: string; issueKey: string };
      assigneeRef?:
        | { kind: "cloud"; accountId: string; displayName: string }
        | { kind: "data-center"; key?: string | undefined; name: string; displayName: string }
        | undefined;
      cache?:
        | {
            source: "cache" | "network";
            fetchedAt: number;
            stale: boolean;
            refreshError?: { code: string; message: string } | undefined;
          }
        | undefined;
      id?: string | undefined;
      key?: string | undefined;
      summary?: string | undefined;
      title?: string | undefined;
      status?: string | undefined;
      statusId?: string | undefined;
      statusCategory?: "new" | "indeterminate" | "done" | undefined;
      issueType?: string | undefined;
      assignee?: string | undefined;
      reporter?: string | undefined;
      priority?: string | undefined;
      resolution?: string | undefined;
      created?: string | undefined;
      description?: string | undefined;
      descriptionMarkdown?: string | undefined;
      url?: string | undefined;
      projectKey?: string | undefined;
      updated?: string | undefined;
      labels?: string[] | undefined;
      components?: string[] | undefined;
      versions?: string[] | undefined;
      issueLinks?:
        | {
            type: string;
            direction: "inward" | "outward";
            issueKey: string;
            summary?: string | undefined;
            status?: string | undefined;
          }[]
        | undefined;
      sourceLabel?: string | undefined;
      attachments?: { id: string; fileName: string; mediaType: string; sizeBytes: number }[] | undefined;
    }[]
  >;
  nativeIssueStatusKey: (issue: JiraIssue) => string;
  nativeStatusOptions: ComputedRef<
    (
      | { count: number; label: string; tone: string; key: string }
      | { key: null; label: string; tone: undefined; count: number }
    )[]
  >;
  nativeStatusSelectValue: WritableComputedRef<string, string | number | null>;
  nativeStatusSelectOptions: ComputedRef<{ value: string; label: string }[]>;
  nativeStatusFilteredIssues: ComputedRef<
    {
      ref: { provider: "jira"; connectionId: string; issueId: string; issueKey: string };
      assigneeRef?:
        | { kind: "cloud"; accountId: string; displayName: string }
        | { kind: "data-center"; key?: string | undefined; name: string; displayName: string }
        | undefined;
      cache?:
        | {
            source: "cache" | "network";
            fetchedAt: number;
            stale: boolean;
            refreshError?: { code: string; message: string } | undefined;
          }
        | undefined;
      id?: string | undefined;
      key?: string | undefined;
      summary?: string | undefined;
      title?: string | undefined;
      status?: string | undefined;
      statusId?: string | undefined;
      statusCategory?: "new" | "indeterminate" | "done" | undefined;
      issueType?: string | undefined;
      assignee?: string | undefined;
      reporter?: string | undefined;
      priority?: string | undefined;
      resolution?: string | undefined;
      created?: string | undefined;
      description?: string | undefined;
      descriptionMarkdown?: string | undefined;
      url?: string | undefined;
      projectKey?: string | undefined;
      updated?: string | undefined;
      labels?: string[] | undefined;
      components?: string[] | undefined;
      versions?: string[] | undefined;
      issueLinks?:
        | {
            type: string;
            direction: "inward" | "outward";
            issueKey: string;
            summary?: string | undefined;
            status?: string | undefined;
          }[]
        | undefined;
      sourceLabel?: string | undefined;
      attachments?: { id: string; fileName: string; mediaType: string; sizeBytes: number }[] | undefined;
    }[]
  >;
  nativeVisibleIssues: ComputedRef<
    {
      ref: { provider: "jira"; connectionId: string; issueId: string; issueKey: string };
      assigneeRef?:
        | { kind: "cloud"; accountId: string; displayName: string }
        | { kind: "data-center"; key?: string | undefined; name: string; displayName: string }
        | undefined;
      cache?:
        | {
            source: "cache" | "network";
            fetchedAt: number;
            stale: boolean;
            refreshError?: { code: string; message: string } | undefined;
          }
        | undefined;
      id?: string | undefined;
      key?: string | undefined;
      summary?: string | undefined;
      title?: string | undefined;
      status?: string | undefined;
      statusId?: string | undefined;
      statusCategory?: "new" | "indeterminate" | "done" | undefined;
      issueType?: string | undefined;
      assignee?: string | undefined;
      reporter?: string | undefined;
      priority?: string | undefined;
      resolution?: string | undefined;
      created?: string | undefined;
      description?: string | undefined;
      descriptionMarkdown?: string | undefined;
      url?: string | undefined;
      projectKey?: string | undefined;
      updated?: string | undefined;
      labels?: string[] | undefined;
      components?: string[] | undefined;
      versions?: string[] | undefined;
      issueLinks?:
        | {
            type: string;
            direction: "inward" | "outward";
            issueKey: string;
            summary?: string | undefined;
            status?: string | undefined;
          }[]
        | undefined;
      sourceLabel?: string | undefined;
      attachments?: { id: string; fileName: string; mediaType: string; sizeBytes: number }[] | undefined;
    }[]
  >;
  nativeIssueKey: (issue: JiraIssue) => string;
  selectNativePresentation: (presentation: "board" | "list") => void;
  selectNativeStatusFilter: (status: string | null) => void;
  clearNativeIssueFilter: () => void;
  nativeBoardColumnViews: ComputedRef<
    | {
        name: string;
        statusNames: string[];
        extraStatuses: string[];
        tone: JiraStatusTone;
        issues: {
          ref: { provider: "jira"; connectionId: string; issueId: string; issueKey: string };
          assigneeRef?:
            | { kind: "cloud"; accountId: string; displayName: string }
            | { kind: "data-center"; key?: string | undefined; name: string; displayName: string }
            | undefined;
          cache?:
            | {
                source: "cache" | "network";
                fetchedAt: number;
                stale: boolean;
                refreshError?: { code: string; message: string } | undefined;
              }
            | undefined;
          id?: string | undefined;
          key?: string | undefined;
          summary?: string | undefined;
          title?: string | undefined;
          status?: string | undefined;
          statusId?: string | undefined;
          statusCategory?: "new" | "indeterminate" | "done" | undefined;
          issueType?: string | undefined;
          assignee?: string | undefined;
          reporter?: string | undefined;
          priority?: string | undefined;
          resolution?: string | undefined;
          created?: string | undefined;
          description?: string | undefined;
          descriptionMarkdown?: string | undefined;
          url?: string | undefined;
          projectKey?: string | undefined;
          updated?: string | undefined;
          labels?: string[] | undefined;
          components?: string[] | undefined;
          versions?: string[] | undefined;
          issueLinks?:
            | {
                type: string;
                direction: "inward" | "outward";
                issueKey: string;
                summary?: string | undefined;
                status?: string | undefined;
              }[]
            | undefined;
          sourceLabel?: string | undefined;
          attachments?: { id: string; fileName: string; mediaType: string; sizeBytes: number }[] | undefined;
        }[];
      }[]
    | {
        name: string;
        statusNames: string[];
        extraStatuses: never[];
        tone: string;
        issues: {
          ref: { provider: "jira"; connectionId: string; issueId: string; issueKey: string };
          assigneeRef?:
            | { kind: "cloud"; accountId: string; displayName: string }
            | { kind: "data-center"; key?: string | undefined; name: string; displayName: string }
            | undefined;
          cache?:
            | {
                source: "cache" | "network";
                fetchedAt: number;
                stale: boolean;
                refreshError?: { code: string; message: string } | undefined;
              }
            | undefined;
          id?: string | undefined;
          key?: string | undefined;
          summary?: string | undefined;
          title?: string | undefined;
          status?: string | undefined;
          statusId?: string | undefined;
          statusCategory?: "new" | "indeterminate" | "done" | undefined;
          issueType?: string | undefined;
          assignee?: string | undefined;
          reporter?: string | undefined;
          priority?: string | undefined;
          resolution?: string | undefined;
          created?: string | undefined;
          description?: string | undefined;
          descriptionMarkdown?: string | undefined;
          url?: string | undefined;
          projectKey?: string | undefined;
          updated?: string | undefined;
          labels?: string[] | undefined;
          components?: string[] | undefined;
          versions?: string[] | undefined;
          issueLinks?:
            | {
                type: string;
                direction: "inward" | "outward";
                issueKey: string;
                summary?: string | undefined;
                status?: string | undefined;
              }[]
            | undefined;
          sourceLabel?: string | undefined;
          attachments?: { id: string; fileName: string; mediaType: string; sizeBytes: number }[] | undefined;
        }[];
      }[]
  >;
  ownIssueStatusCategory: (issue: JiraIssue) => "new" | "indeterminate" | "done";
  updateNoBoardSearchColumns: () => void;
  boardSharedLabels: ComputedRef<Set<string>>;
  cardLabels: (issue: JiraIssue) => string[];
  ownJiraIdentityIds: () => string[];
  isOwnJiraUser: (user: JiraUserRef) => boolean;
  isOwnJiraAssignee: (issue: JiraIssue) => boolean;
  plainIssueRef: (ref: JiraIssueRef) => JiraIssueRef;
  jiraCommentAuthor: (comment: JiraComment) => string;
  issuesForColumn: (column: JiraColumn) => {
    ref: { provider: "jira"; connectionId: string; issueId: string; issueKey: string };
    assigneeRef?:
      | { kind: "cloud"; accountId: string; displayName: string }
      | { kind: "data-center"; key?: string | undefined; name: string; displayName: string }
      | undefined;
    cache?:
      | {
          source: "cache" | "network";
          fetchedAt: number;
          stale: boolean;
          refreshError?: { code: string; message: string } | undefined;
        }
      | undefined;
    id?: string | undefined;
    key?: string | undefined;
    summary?: string | undefined;
    title?: string | undefined;
    status?: string | undefined;
    statusId?: string | undefined;
    statusCategory?: "new" | "indeterminate" | "done" | undefined;
    issueType?: string | undefined;
    assignee?: string | undefined;
    reporter?: string | undefined;
    priority?: string | undefined;
    resolution?: string | undefined;
    created?: string | undefined;
    description?: string | undefined;
    descriptionMarkdown?: string | undefined;
    url?: string | undefined;
    projectKey?: string | undefined;
    updated?: string | undefined;
    labels?: string[] | undefined;
    components?: string[] | undefined;
    versions?: string[] | undefined;
    issueLinks?:
      | {
          type: string;
          direction: "inward" | "outward";
          issueKey: string;
          summary?: string | undefined;
          status?: string | undefined;
        }[]
      | undefined;
    sourceLabel?: string | undefined;
    attachments?: { id: string; fileName: string; mediaType: string; sizeBytes: number }[] | undefined;
  }[];
  unmappedBoardIssues: ComputedRef<
    {
      ref: { provider: "jira"; connectionId: string; issueId: string; issueKey: string };
      assigneeRef?:
        | { kind: "cloud"; accountId: string; displayName: string }
        | { kind: "data-center"; key?: string | undefined; name: string; displayName: string }
        | undefined;
      cache?:
        | {
            source: "cache" | "network";
            fetchedAt: number;
            stale: boolean;
            refreshError?: { code: string; message: string } | undefined;
          }
        | undefined;
      id?: string | undefined;
      key?: string | undefined;
      summary?: string | undefined;
      title?: string | undefined;
      status?: string | undefined;
      statusId?: string | undefined;
      statusCategory?: "new" | "indeterminate" | "done" | undefined;
      issueType?: string | undefined;
      assignee?: string | undefined;
      reporter?: string | undefined;
      priority?: string | undefined;
      resolution?: string | undefined;
      created?: string | undefined;
      description?: string | undefined;
      descriptionMarkdown?: string | undefined;
      url?: string | undefined;
      projectKey?: string | undefined;
      updated?: string | undefined;
      labels?: string[] | undefined;
      components?: string[] | undefined;
      versions?: string[] | undefined;
      issueLinks?:
        | {
            type: string;
            direction: "inward" | "outward";
            issueKey: string;
            summary?: string | undefined;
            status?: string | undefined;
          }[]
        | undefined;
      sourceLabel?: string | undefined;
      attachments?: { id: string; fileName: string; mediaType: string; sizeBytes: number }[] | undefined;
    }[]
  >;
  issueUrl: (issueKey: string) => string;
  formatJiraDate: (value: string) => string;
  scheduleIssuePreview: (issue: JiraIssue, event: MouseEvent | FocusEvent) => void;
  dismissIssuePreview: () => void;
  openIssue: (issue: JiraIssue, event?: { currentTarget: EventTarget | null }) => Promise<void>;
  boardDrawerMode: ComputedRef<boolean>;
  navRow: (issue: JiraIssue) => { "data-nav-row": string; "data-nav-key": string; tabindex: number };
  onPaneKeydown: (event: KeyboardEvent) => void;
  onPaneFocusin: (event: FocusEvent) => void;
  captureNativePresentationScroll: (presentation: "list" | "board") => void;
  rememberNativeListScroll: (event: Event) => void;
  rememberNativeBoardHorizontalScroll: (event: Event) => void;
  rememberNativeBoardCardsScroll: (event: Event) => void;
  restoreNativePresentationScroll: (presentation: "list" | "board", focusIssue?: boolean) => void;
  refreshSelectedIssue: (
    ref: { connectionId: string; issueId: string },
    generation?: number,
    refreshAgainAfterInFlight?: boolean,
  ) => Promise<void>;
  refreshVisibleJiraData: (options?: {
    afterWrite?: boolean;
    refreshComments?: boolean;
    userInitiated?: boolean;
  }) => Promise<void>;
  toggleAdvancedSearch: () => void;
  openRequestedJiraBoardChooser: () => void;
  onBoardChooserOpen: () => void;
  focusQuickSearch: () => void;
  openInlineHumanIdentitySetup: (after?: "list" | "tab" | "assign") => void;
  closeInlineHumanIdentitySetup: () => void;
  searchHumanIdentityUsers: () => Promise<void>;
  selectHumanIdentityUser: (user: JiraUserRef) => void;
  saveSelectedHumanIdentity: () => Promise<void>;
  clearSelectedIssue: () => void;
  formatAttachmentSize: (size: number) => string;
  downloadIssueAttachment: (attachment: NonNullable<JiraIssue["attachments"]>[number]) => Promise<void>;
  uploadIssueAttachment: () => Promise<void>;
  attachSelectedIssue: () => Promise<void>;
  detachSelectedIssue: (targetWorkspaceId: string) => Promise<void>;
  previewWrite: () => Promise<void>;
  sendWrite: () => Promise<void>;
  reconcileWrite: () => Promise<void>;
  loadComments: ({ background }?: { background?: boolean }) => Promise<void>;
  loadJiraCommentDrafts: () => Promise<void>;
  jiraDraftSourceName: (sourceWorkspaceId: string) => string;
  useJiraCommentDraft: (draftItem: JiraCommentDraft) => Promise<void>;
  clearJiraCommentDraft: (draftItem: JiraCommentDraft) => Promise<void>;
  loadTransitions: () => Promise<void>;
  resetWrite: () => void;
  openJiraAction: (action: "comment" | "transition") => Promise<void>;
  openDevelopmentWorkspace: (workspaceId: string) => Promise<void>;
  branchConnectionKey: Ref<string, string>;
  branchProjectId: Ref<string, string>;
  branchRepoId: Ref<string, string>;
  branchBase: Ref<string, string>;
  branchName: Ref<string, string>;
  branchError: Ref<string, string>;
  branchProjectsLoading: Ref<boolean, boolean>;
  branchReposLoading: Ref<boolean, boolean>;
  branchBasesLoading: Ref<boolean, boolean>;
  branchProvider: ComputedRef<"azure" | "github">;
  hasBranchConnections: ComputedRef<boolean>;
  branchConnectionOptions: ComputedRef<{ value: string; label: string }[]>;
  branchProjectOptions: ComputedRef<{ value: string; label: string }[]>;
  branchRepoOptions: ComputedRef<{ value: string; label: string }[]>;
  branchBaseOptions: ComputedRef<{ value: string; label: string }[]>;
  canStartBranch: ComputedRef<boolean>;
  startBranchDisabledReason: ComputedRef<string>;
  onBranchConnectionChange: () => Promise<void>;
  loadBranchRepos: () => Promise<void>;
  selectBranchRepo: () => Promise<void>;
  startBranch: () => Promise<void>;
  addBranchConnection: (provider: "azure" | "github") => void;
  openBranchStart: () => Promise<void>;
  closeBranchStart: () => void;
  branchAgent: Ref<import("../../../../../electron/shared/jira-development.js").JiraDevelopmentAgent | "">;
  branchAgentOptions: ComputedRef<
    Array<{
      value: import("../../../../../electron/shared/jira-development.js").JiraDevelopmentAgent | "";
      label: string;
    }>
  >;
  branchModel: Ref<string>;
  branchModelChoices: ComputedRef<Array<{ id: string; name: string }>>;
  branchEffort: Ref<string>;
  branchEffortOptions: ComputedRef<Array<{ value: string; label: string }>>;
  branchMode: Ref<import("../../../../../electron/shared/jira-development.js").JiraDevelopmentMode>;
  branchTask: WritableComputedRef<string>;
  branchStartOperationId: Ref<string>;
  branchStartProgress: ComputedRef<string>;
  resetBranchTask: () => void;
  matchingBranchWorkspaces: ComputedRef<
    { id: string; name: string; repository: string; baseBranch: string; activityAt: number }[]
  >;
  primaryBranchWorkspace: ComputedRef<{
    id: string;
    name: string;
    repository: string;
    baseBranch: string;
    activityAt: number;
  } | null>;
  branchWorkspaceTitle: (ref: { connectionId: string; issueId: string } | undefined) => string;
  verifyOwnIdentity: () => Promise<void>;
  saveConnection: (preserveDraft?: boolean, setupAction?: boolean) => Promise<boolean>;
  removeConnection: () => Promise<void>;
  closeExtraActionsOnOutsideClick: (event: MouseEvent) => void;
  closeOpenExtraActions: (event?: Event) => void;
  closeExtraActionsWhenFocusLeaves: (event: FocusEvent) => void;
  positionExtraActionsMenu: (event: Event) => void;
  updateCompactPane: () => void;
  props: JiraInboxPaneProps;
  vars: {
    workspaceViewSaveTimer: ReturnType<typeof setTimeout> | undefined;
    pendingNativeViewSave: { workspaceId: string; viewId: string; input: JiraWorkspaceViewInput } | null;
    lastSavedNativeViewSignature: string;
    projectCatalogGeneration: number;
    projectCatalogLoadingFor: string;
    nativeBoardCardsScrollTop: Map<string, number>;
    nativeBoardScrollTop: number;
    connectionDraftRevision: number;
    connectionTestSession: number;
    loadedQuickFilterBoardKey: string;
    assigneeSearchTimer: ReturnType<typeof setTimeout> | undefined;
    assigneeSearchGeneration: number;
    issuePreviewTimer: ReturnType<typeof setTimeout> | undefined;
    issuePreviewTrigger: HTMLElement | null;
    issuePreviewObserver: ResizeObserver | undefined;
    issuePreviewRequest: number;
    issueOpenGeneration: number;
    allSearchGeneration: number;
    boardSearchTimer: ReturnType<typeof setTimeout> | undefined;
    commentsGeneration: number;
    humanIdentitySearchGeneration: number;
    connectionLoadGeneration: number;
    boardRefreshGeneration: number;
    selectedRefreshTask: { key: string; generation: number; promise: Promise<void> } | undefined;
    visibleRefreshTask: Promise<void> | undefined;
    pendingBoardChooserSequence: number | null;
    lastHandledBoardChooserSequence: number;
    lastHandledIssueOpenSequence: number;
    jiraResizeObserver: ResizeObserver | undefined;
    jiraWindowResizeHandler: (() => void) | undefined;
  };
}

export const jiraPaneContextKey: InjectionKey<JiraPaneContext> = Symbol("jira-pane-context");

export function useJiraPaneContext(): JiraPaneContext {
  const ctx = inject(jiraPaneContextKey);
  if (!ctx) throw new Error("Jira pane context is not provided.");
  return ctx;
}
