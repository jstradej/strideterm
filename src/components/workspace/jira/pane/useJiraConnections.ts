import { computed, nextTick, onUnmounted, reactive, ref, watch } from "vue";
import { readJiraViewPreferences } from "../jira-view-preferences.js";
import { rlog } from "../../../../lib/renderer-log.js";
import { validateJiraMetadataDraft } from "./jira-metadata-validation.js";
import { notifyJiraIssueLinkRoutesChanged } from "../../../../composables/useJiraIssueLinkRoutes.js";
import { type JiraSavedWorkspaceView } from "../../../../../electron/shared/types/jira-workspace-views.js";
import { jiraSmartFilterClause } from "../../../../../electron/shared/jira-smart-filters.js";
import {
  type JiraUserRef,
  type JiraConnection,
  type JiraBoardViewResult,
  type JiraErrorCode,
  type JiraUiApi,
  type JiraIssue,
} from "./jira-pane-types.js";
import type { JiraPaneContext } from "./jira-pane-context.js";
import { LOAD_BUSY_KEYS } from "./useJiraPaneCore.js";
import { clampJiraPollSeconds, JIRA_POLL_DEFAULT_SECONDS } from "../../../../../electron/shared/jira-poll-interval.js";

const JIRA_API_TOKEN_URL = "https://id.atlassian.com/manage-profile/security/api-tokens";

export function useJiraConnections(ctx: JiraPaneContext) {
  const {
    activeSearchProjectKeys,
    activeView,
    allMyIssueCursors,
    api,
    applyWorkspaceViewsState,
    assigneeCatalog,
    assigneeSearchResults,
    assigneeSearchText,
    boardColumns,
    boardId,
    boardIssueDetailOpen,
    boardLoadGeneration,
    boardMode,
    boardQuickFilterError,
    boardQuickFilters,
    boards,
    clearBusy,
    isBusy,
    beginBusy,
    clearPaneError,
    canManageConnections,
    collectIssueAssignees,
    connectionId,
    connections,
    connectionsOnly,
    currentWorkspace,
    dismissIssuePreview,
    doneWithinDays,
    dynamicApi,
    error,
    friendlyConnectionError,
    issueSort,
    issues,
    jiraRootRef,
    jiraUserIdentity,
    jiraViewId,
    jql,
    loadBoard,
    loadBoards,
    loadJiraRecents,
    loadQueries,
    loadWorkspaceProjectScope,
    mergeAssigneeCatalog,
    nativePersonalScope,
    nativePersonalScopeConfigured,
    nativePresentationChoice,
    nativeStatusFilter,
    nativeStatusFilterConfigured,
    openMyIssuesBoard,
    ownBoardGeneration,
    ownIssueSearchGeneration,
    ownIssuesBoardMode,
    ownSearchIdentityLabel,
    pinnedBoardInfo,
    preferencesProfileId,
    preferencesRestored,
    projectScopeChoice,
    projectScopeConfigured,
    projectScopePayload,
    props,
    queryId,
    recentGeneration,
    reportFailure,
    reportFailureText,
    recentSearches,
    recentViewedIssues,
    restoredPreferences,
    restoringPreferences,
    savedQueries,
    search,
    searchAllText,
    searchCache,
    searchFailed,
    searchHasMore,
    searchHasRun,
    selected,
    selectedBoardAssignee,
    selectedBoardLabel,
    selectedBoardType,
    selectedConnection,
    selectedQuickFilterIds,
    selectedSprintId,
    sprintLoadGeneration,
    store,
    vars,
    workspaceViewRestored,
    workspaceViewRestoredId,
    workspaceViews,
  } = ctx;
  const connectionsLoaded = ref(false);
  const setupInProgress = ref(false);
  const setupDismissed = ref(false);
  const setupStep = ref(1);
  const setupValidationError = ref("");
  const connectionTestBusy = ref(false);
  const connectionSaveBusy = ref(false);
  const connectionTestState = ref<"idle" | "testing" | "success" | "error">("idle");
  const connectionTestMessage = ref("");
  const connectionTestFieldError = ref<
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
  >(null);
  const connectionTestResultRef = ref<HTMLElement | null>(null);
  const verifyingConnectionId = ref<string | null>(null);
  const connectionVerificationResults = reactive<Record<string, { ok: boolean; message: string }>>({});
  const connectionVerificationGenerations = new Map<string, number>();
  const setupNameInput = ref<HTMLInputElement | null>(null);
  const setupWebUrlInput = ref<HTMLInputElement | null>(null);
  const setupApiUrlInput = ref<HTMLInputElement | null>(null);
  const setupPatInput = ref<HTMLInputElement | null>(null);
  const setupKeyInput = ref<HTMLInputElement | null>(null);
  const setupHeaderInput = ref<HTMLInputElement | null>(null);
  const setupCertificateInput = ref<HTMLInputElement | null>(null);
  const setupCertificatePasswordInput = ref<HTMLInputElement | null>(null);
  const setupEmailInput = ref<HTMLInputElement | null>(null);
  const setupApiTokenInput = ref<HTMLInputElement | null>(null);
  const setupFinishButton = ref<HTMLButtonElement | null>(null);
  const addConnectionButton = ref<HTMLButtonElement | null>(null);
  const setupReturnFocus = ref<HTMLElement | null>(null);
  const connectionsLoading = ref(false);
  const identityPanelOpen = ref(false);
  const draft = reactive({
    id: undefined as string | undefined,
    label: "",
    deployment: "data-center" as "data-center" | "cloud",
    authMode: "pat" as "pat" | "apim",
    webUrl: "",
    apiBaseUrl: "",
    email: "",
    apiToken: "",
    pat: "",
    subscriptionKey: "",
    subscriptionHeaderName: "Ocp-Apim-Subscription-Key",
    clientCertificatePath: "",
    clientCertificatePassword: "",
    accountPurpose: "personal" as "personal" | "technical",
  });
  const metadataDraft = reactive({
    label: "",
    accountPurpose: "personal" as "personal" | "technical",
    issueKeyPrefixesText: "",
    defaultJql: "",
    projectKeysText: "",
    pollSeconds: JIRA_POLL_DEFAULT_SECONDS,
  });
  const accountPurposeOptions = [
    { value: "personal", label: "Personal account" },
    { value: "technical", label: "Technical account" },
  ];
  const connectionTypeOptions = [
    { value: "cloud", label: "Jira Cloud · API token" },
    { value: "pat", label: "Jira Data Center · Personal access token" },
    { value: "apim", label: "API gateway (APIM)" },
  ];
  const connectionType = computed({
    get: () => (draft.deployment === "cloud" ? "cloud" : draft.authMode === "apim" ? "apim" : "pat"),
    set: (value: string) => {
      if (value === "cloud") {
        draft.deployment = "cloud";
        draft.authMode = "pat";
      } else {
        draft.deployment = "data-center";
        draft.authMode = value === "apim" ? "apim" : "pat";
      }
    },
  });
  const connectionTypeDescription = computed(() => {
    if (connectionType.value === "cloud")
      return "Atlassian-hosted Jira. You’ll enter your site address, your Atlassian account email and an API token you create yourself.";
    if (connectionType.value === "apim")
      return "Jira reached through an API gateway. You’ll enter the Jira and gateway URLs, a gateway subscription key, and an optional client certificate.";
    return "Self-hosted Jira Data Center. You’ll enter the Jira URLs and a personal access token.";
  });
  const metadataEditing = ref(false);
  const connectionEditTab = ref<"general" | "connection">("general");
  // The Connection tab of a saved connection's Edit form reuses the setup fields in place, without the wizard.
  const credentialsInline = computed(() => metadataEditing.value && connectionEditTab.value === "connection");
  const expandedConnectionId = ref<string | undefined>(undefined);
  const openConnectionPanelId = computed(() =>
    expandedConnectionId.value === undefined
      ? connectionId.value === "__all__"
        ? connections.value[0]?.id || ""
        : connectionId.value
      : expandedConnectionId.value,
  );
  watch(activeView, (view) => {
    if (view === "settings") expandedConnectionId.value = undefined;
  });
  watch(
    () => [connectionsOnly.value && connectionsLoaded.value ? openConnectionPanelId.value : "", connectionId.value],
    ([panelId, selectedId]) => {
      if (panelId && panelId === selectedId) void loadQueries();
    },
    { immediate: true },
  );
  const setupVisible = computed(
    () =>
      canManageConnections.value &&
      connectionsLoaded.value &&
      (connectionsOnly.value
        ? setupInProgress.value
        : (!connections.value.length && !setupDismissed.value) || setupInProgress.value),
  );
  const noConnectionManager = computed(
    () =>
      !connectionsOnly.value &&
      canManageConnections.value &&
      connectionsLoaded.value &&
      !connections.value.length &&
      setupDismissed.value &&
      !setupInProgress.value,
  );
  watch(
    () => (setupVisible.value ? setupStep.value : 0),
    (step) => {
      if (step) void focusSetupStep(step);
    },
    { immediate: true },
  );
  watch(
    () => [
      draft.id,
      draft.label,
      draft.deployment,
      draft.authMode,
      draft.webUrl,
      draft.apiBaseUrl,
      draft.email,
      draft.apiToken,
      draft.pat,
      draft.subscriptionKey,
      draft.subscriptionHeaderName,
      draft.clientCertificatePath,
      draft.clientCertificatePassword,
      draft.accountPurpose,
    ],
    () => {
      vars.connectionDraftRevision += 1;
      connectionTestState.value = "idle";
      connectionTestMessage.value = "";
      connectionTestFieldError.value = null;
      setupValidationError.value = "";
    },
    { flush: "sync" },
  );
  const connectionOptions = computed(() => [
    ...(connections.value.length > 1 ? [{ value: "__all__", label: "All connections · text search only" }] : []),
    ...connections.value.map((connection) => ({
      value: connection.id,
      label: `${connection.label} · ${jiraConnectionTypeLabel(connection)}`,
    })),
  ]);
  const connectionStatus = ref("");
  const identityValue = ref("");
  const humanIdentitySetupOpen = ref(false);
  const humanIdentitySearchText = ref("");
  const humanIdentitySearchResults = ref<JiraUserRef[]>([]);
  const humanIdentitySelectedUser = ref<JiraUserRef | null>(null);
  const humanIdentitySearchLoading = ref(false);
  const humanIdentitySaving = ref(false);
  const humanIdentitySearchError = ref("");
  const connectionActionError = ref("");
  const identityError = ref("");
  const metadataError = ref("");
  const metadataTouched = ref(false);
  const restoreRetryable = ref(false);
  let connectionListRequest = 0;
  const metadataValidation = computed(() => validateJiraMetadataDraft(metadataDraft));
  function ownIdentityValueOf(list: JiraConnection[]) {
    const own = list.find((connection) => connection.id === connectionId.value)?.ownIdentity;
    return own?.accountId || own?.name || "";
  }
  /** Refreshes only the connection list: keeps the open issue, filters and results exactly as they are. */
  async function refreshConnectionList(): Promise<boolean> {
    const request = ++connectionListRequest;
    const restoreGeneration = vars.connectionLoadGeneration;
    const requestedProfileId = preferencesProfileId.value;
    const requestedWorkspaceId = props.workspaceId;
    const isStale = () =>
      request !== connectionListRequest ||
      restoreGeneration !== vars.connectionLoadGeneration ||
      requestedProfileId !== preferencesProfileId.value ||
      requestedWorkspaceId !== props.workspaceId;
    try {
      const list = (await api.listJiraConnections()) as JiraConnection[];
      if (isStale()) return false;
      const previousIdentity = ownIdentityValueOf(connections.value);
      connections.value = list;
      notifyJiraIssueLinkRoutesChanged();
      if (!identityValue.value || identityValue.value === previousIdentity)
        identityValue.value = ownIdentityValueOf(list);
      return true;
    } catch (cause) {
      if (!isStale()) reportFailure("Could not refresh the Jira connection list", cause);
      return false;
    }
  }
  function retryRestore() {
    restoreRetryable.value = false;
    void loadConnections();
  }
  async function loadConnections() {
    const generation = ++vars.connectionLoadGeneration;
    const requestedProfileId = preferencesProfileId.value;
    const requestedWorkspaceId = props.workspaceId;
    const requestedJiraViewId = jiraViewId.value;
    let preferencesCanPersist = false;
    restoreRetryable.value = false;
    connectionsLoading.value = true;
    restoringPreferences.value = true;
    preferencesRestored.value = false;
    workspaceViewRestored.value = false;
    workspaceViewRestoredId.value = "";
    nativePresentationChoice.value = null;
    nativeStatusFilter.value = null;
    nativeStatusFilterConfigured.value = false;
    nativePersonalScope.value = "open";
    nativePersonalScopeConfigured.value = false;
    projectScopeChoice.value = null;
    projectScopeConfigured.value = false;
    activeSearchProjectKeys.value = undefined;
    try {
      const [connectionList, viewsResult] = await Promise.all([
        api.listJiraConnections(),
        props.workspaceId && dynamicApi.getJiraWorkspaceViews
          ? dynamicApi.getJiraWorkspaceViews({ workspaceId: props.workspaceId }).then(
              (state) => ({ state, failure: undefined as unknown }),
              (failure: unknown) => ({
                state: null,
                failure: failure ?? new Error("Could not load the saved Jira views."),
              }),
            )
          : Promise.resolve({ state: workspaceViews.value, failure: undefined as unknown }),
      ]);
      if (
        generation !== vars.connectionLoadGeneration ||
        requestedProfileId !== preferencesProfileId.value ||
        requestedWorkspaceId !== props.workspaceId
      )
        return;
      connections.value = connectionList as JiraConnection[];
      if (viewsResult.state) applyWorkspaceViewsState(viewsResult.state);
      const viewsFailure = viewsResult.failure;
      preferencesCanPersist = true;
      notifyJiraIssueLinkRoutesChanged();
      const pinnedBoard = pinnedBoardInfo.value;
      const saved = props.workspaceId ? readJiraViewPreferences(preferencesProfileId.value, props.workspaceId) : null;
      restoredPreferences.value = saved;
      const savedNativeView =
        jiraViewId.value === "issues"
          ? null
          : (workspaceViews.value?.views.find((view) => view.viewId === jiraViewId.value && view.kind !== "issues") as
              JiraSavedWorkspaceView | undefined);
      if (jiraViewId.value !== "issues" && !savedNativeView) {
        if (viewsFailure) {
          reportFailure("Could not load this saved Jira tab", viewsFailure);
          restoreRetryable.value = true;
        } else {
          error.value = "This saved Jira tab is no longer available. Open Jira issues and add the board again.";
        }
        return;
      }
      if (viewsFailure)
        rlog("warn", "[jira] Could not refresh the saved Jira views; using the last known ones", { context: "views" });
      if (savedNativeView) {
        activeView.value = "board";
        nativePresentationChoice.value = savedNativeView.presentation ?? null;
        nativeStatusFilter.value = savedNativeView.statusFilter ?? null;
        nativeStatusFilterConfigured.value = savedNativeView.statusFilter !== undefined;
        nativePersonalScope.value = savedNativeView.personalScope ?? "open";
        nativePersonalScopeConfigured.value = savedNativeView.personalScope !== undefined;
        projectScopeChoice.value = savedNativeView.projectKeys === undefined ? null : [...savedNativeView.projectKeys];
        projectScopeConfigured.value = savedNativeView.projectKeys !== undefined;
        connectionId.value = savedNativeView.connectionId;
        boardId.value = savedNativeView.boardId || 0;
        selectedBoardLabel.value = savedNativeView.boardName;
        selectedBoardType.value = savedNativeView.mode === "sprints" ? "scrum" : "";
        boardMode.value = savedNativeView.mode;
        selectedSprintId.value = savedNativeView.mode === "sprints" ? savedNativeView.sprintId : null;
        selectedQuickFilterIds.value = [...savedNativeView.quickFilterIds];
        selectedBoardAssignee.value =
          savedNativeView.assignee?.kind === "unassigned"
            ? { kind: "unassigned", label: "Unassigned" }
            : savedNativeView.assignee
              ? { kind: "user", id: savedNativeView.assignee.id, label: savedNativeView.assignee.label || "Jira user" }
              : null;
        doneWithinDays.value = savedNativeView.doneWithinDays;
        ownIssuesBoardMode.value = savedNativeView.kind === "personal";
      }
      if (currentWorkspace.value?.kind === "jira-board" && !pinnedBoard) {
        error.value =
          "This pinned Jira board has no valid saved board context. Open its parent Jira inbox to choose a board.";
        return;
      }
      if (savedNativeView) {
        if (!connections.value.some((connection) => connection.id === savedNativeView.connectionId)) {
          error.value = `Saved Jira tab “${savedNativeView.title}” uses a connection that is no longer available.`;
          return;
        }
      } else if (pinnedBoard) {
        const savedBoardId = Number(pinnedBoard.boardId);
        if (!Number.isSafeInteger(savedBoardId) || savedBoardId <= 0) {
          error.value = `Pinned board “${pinnedBoard.boardName}” has an invalid board ID.`;
          return;
        }
        activeView.value = "board";
        connectionId.value = pinnedBoard.connectionId;
        boardId.value = savedBoardId;
        selectedBoardLabel.value = pinnedBoard.boardName;
        selectedBoardType.value = saved?.boardType || "";
        if (!connections.value.some((connection) => connection.id === pinnedBoard.connectionId)) {
          error.value = `Pinned board “${pinnedBoard.boardName}” uses a Jira connection that is no longer available. Choose a connection to continue.`;
          return;
        }
      } else {
        const savedConnection =
          saved?.connectionId && connections.value.some((item) => item.id === saved.connectionId)
            ? saved.connectionId
            : "";
        connectionId.value = savedConnection || connections.value[0]?.id || "";
        if (savedConnection && saved?.boardId) {
          boardId.value = Number(saved.boardId);
          selectedBoardLabel.value = saved.boardName || "";
          selectedBoardType.value = saved.boardType || "";
        } else {
          boardId.value = 0;
          selectedBoardLabel.value = "";
          selectedBoardType.value = "";
        }
      }
      if (saved && jiraViewId.value === "issues") {
        doneWithinDays.value = saved.doneWithinDays;
        issueSort.value = saved.issueSort;
      }
      if (saved && !pinnedBoard && jiraViewId.value === "issues") {
        activeView.value = saved.activeView;
        boardMode.value = saved.boardMode;
        selectedSprintId.value = saved.selectedSprintId ? Number(saved.selectedSprintId) : null;
        selectedQuickFilterIds.value = saved.quickFilterIds.map(Number);
        selectedBoardAssignee.value =
          saved.assignee?.kind === "unassigned"
            ? { kind: "unassigned", label: "Unassigned" }
            : saved.assignee
              ? { kind: "user", id: saved.assignee.id, label: saved.assignee.displayName }
              : null;
      } else if (saved && pinnedBoard && jiraViewId.value === "issues") {
        boardMode.value = saved.boardMode;
        selectedSprintId.value = saved.selectedSprintId ? Number(saved.selectedSprintId) : null;
        selectedQuickFilterIds.value = saved.quickFilterIds.map(Number);
        selectedBoardAssignee.value =
          saved.assignee?.kind === "unassigned"
            ? { kind: "unassigned", label: "Unassigned" }
            : saved.assignee
              ? { kind: "user", id: saved.assignee.id, label: saved.assignee.displayName }
              : null;
      }
      if (jiraViewId.value === "issues") {
        ownIssuesBoardMode.value =
          !pinnedBoard && !boardId.value && activeView.value === "board" && saved?.lastSearch?.kind === "my-issues";
        applyConnectionDefaults();
      }
      if (
        jiraViewId.value === "issues" &&
        !connectionsOnly.value &&
        connectionId.value &&
        connectionId.value !== "__all__"
      ) {
        await loadWorkspaceProjectScope(connectionId.value);
        if (generation !== vars.connectionLoadGeneration || requestedProfileId !== preferencesProfileId.value) return;
      }
      identityValue.value =
        selectedConnection.value?.ownIdentity?.accountId || selectedConnection.value?.ownIdentity?.name || "";
      if (!connectionsOnly.value && connectionId.value && connectionId.value !== "__all__") {
        void loadJiraRecents(connectionId.value);
      }
      if (!connectionsOnly.value && connectionId.value) {
        const shouldLoadBoardCatalog = Boolean(pinnedBoard || savedNativeView?.kind === "board" || boardId.value);
        const boardsPromise = shouldLoadBoardCatalog ? loadBoards(pinnedBoard?.boardName || "") : Promise.resolve();
        if (savedNativeView) {
          void boardsPromise;
          if (savedNativeView.kind === "personal") {
            if (dynamicApi.buildJiraOwnIssuesQuery) {
              let query: { jql: string; identityLabel: string } | null = null;
              try {
                query = await dynamicApi.buildJiraOwnIssuesQuery({
                  connectionId: savedNativeView.connectionId,
                  personalScope: savedNativeView.personalScope ?? "open",
                  ...(savedNativeView.projectKeys === undefined
                    ? {}
                    : { projectKeys: [...savedNativeView.projectKeys] }),
                });
              } catch (cause) {
                if (
                  generation === vars.connectionLoadGeneration &&
                  requestedProfileId === preferencesProfileId.value &&
                  requestedWorkspaceId === props.workspaceId &&
                  jiraViewId.value === savedNativeView.viewId
                )
                  reportFailure("Could not restore this My issues tab", cause);
              }
              if (
                !query ||
                generation !== vars.connectionLoadGeneration ||
                requestedProfileId !== preferencesProfileId.value ||
                requestedWorkspaceId !== props.workspaceId ||
                jiraViewId.value !== savedNativeView.viewId
              )
                return;
              ownSearchIdentityLabel.value = query.identityLabel;
              await search(query.jql, false, {
                kind: "my-issues",
                label: savedNativeView.title,
                recordUsage: false,
                registrySync: true,
                ...(savedNativeView.projectKeys === undefined ? {} : { projectKeys: [...savedNativeView.projectKeys] }),
              });
            } else {
              error.value = "Verify a personal Jira identity to open this saved My issues tab.";
            }
          } else if (boardId.value) {
            if (
              savedNativeView.kind === "board" &&
              (selectedQuickFilterIds.value.length || selectedBoardAssignee.value)
            ) {
              try {
                const cachedRoster = dynamicApi.getJiraBoardView
                  ? ((await dynamicApi.getJiraBoardView({
                      connectionId: savedNativeView.connectionId,
                      boardId: savedNativeView.boardId!,
                      mode: savedNativeView.mode,
                      ...(savedNativeView.mode === "sprints" && savedNativeView.sprintId
                        ? { sprintId: savedNativeView.sprintId }
                        : {}),
                      cacheOnly: true,
                    })) as JiraBoardViewResult | null)
                  : null;
                if (cachedRoster?.issues) collectIssueAssignees(cachedRoster.issues, true);
              } catch {
                // A cached roster is supplementary; keep the saved assignee visible if it is unavailable.
              }
              if (
                generation !== vars.connectionLoadGeneration ||
                requestedProfileId !== preferencesProfileId.value ||
                requestedWorkspaceId !== props.workspaceId ||
                jiraViewId.value !== savedNativeView.viewId
              )
                return;
              if (selectedBoardAssignee.value?.kind === "user") {
                const id = selectedBoardAssignee.value.id;
                const label = selectedBoardAssignee.value.label;
                const selectedUser: JiraUserRef =
                  selectedConnection.value?.deployment === "cloud"
                    ? { kind: "cloud", accountId: id, displayName: label }
                    : { kind: "data-center", name: id, displayName: label };
                mergeAssigneeCatalog([selectedUser]);
              }
            }
            await loadBoard();
          }
        } else {
          await boardsPromise;
          if (
            generation !== vars.connectionLoadGeneration ||
            requestedProfileId !== preferencesProfileId.value ||
            requestedWorkspaceId !== props.workspaceId
          )
            return;
          if (boardId.value) {
            if (selectedQuickFilterIds.value.length || selectedBoardAssignee.value) {
              try {
                const cachedUnfiltered = dynamicApi.getJiraBoardView
                  ? ((await dynamicApi.getJiraBoardView({
                      connectionId: connectionId.value,
                      boardId: boardId.value,
                      mode: boardMode.value === "sprints" ? "sprints" : boardMode.value,
                      cacheOnly: true,
                    })) as JiraBoardViewResult | null)
                  : null;
                if (cachedUnfiltered?.issues) collectIssueAssignees(cachedUnfiltered.issues, true);
              } catch {
                // The roster is supplementary; keep the selected name visible if no unfiltered snapshot is cached.
              }
              if (selectedBoardAssignee.value?.kind === "user") {
                const id = selectedBoardAssignee.value.id;
                const label = selectedBoardAssignee.value.label;
                const selectedUser: JiraUserRef =
                  selectedConnection.value?.deployment === "cloud"
                    ? { kind: "cloud", accountId: id, displayName: label }
                    : { kind: "data-center", name: id, displayName: label };
                mergeAssigneeCatalog([selectedUser]);
              }
            }
            await loadBoard();
          }
        }
      }
      const lastSearch = saved?.lastSearch || null;
      const restoreLastSearch =
        jiraViewId.value === "issues" &&
        !connectionsOnly.value &&
        (activeView.value === "issues" || (ownIssuesBoardMode.value && lastSearch?.kind === "my-issues")) &&
        lastSearch &&
        lastSearch.connectionId === connectionId.value &&
        connectionId.value !== "__all__";
      if (restoreLastSearch) {
        if (lastSearch.kind === "my-issues") {
          if (selectedConnection.value?.ownIdentity && dynamicApi.buildJiraOwnIssuesQuery) {
            const restoreGeneration = ++ownIssueSearchGeneration.value;
            const restoreConnectionId = connectionId.value;
            const restoreProfileId = preferencesProfileId.value;
            void dynamicApi
              .buildJiraOwnIssuesQuery({
                connectionId: restoreConnectionId,
                ...projectScopePayload(),
              })
              .then(
                (query) => {
                  if (
                    restoreGeneration !== ownIssueSearchGeneration.value ||
                    restoreConnectionId !== connectionId.value ||
                    restoreProfileId !== preferencesProfileId.value ||
                    generation !== vars.connectionLoadGeneration
                  )
                    return;
                  ownSearchIdentityLabel.value = query.identityLabel;
                  void search(query.jql, false, {
                    kind: "my-issues",
                    label: lastSearch.label || "My issues",
                    recordUsage: false,
                    ...projectScopePayload(),
                  });
                },
                (cause) => {
                  if (restoreGeneration === ownIssueSearchGeneration.value) {
                    reportFailure("Could not restore My issues", cause);
                  }
                },
              );
          }
        } else {
          jql.value = lastSearch.jql;
          void search(lastSearch.jql, false, {
            kind: lastSearch.kind,
            label: lastSearch.label || undefined,
            filterId: lastSearch.filterId,
            recordUsage: false,
            smartFilters: saved?.smartFilters ?? [],
          });
        }
      } else if (jiraViewId.value === "issues" && activeView.value === "issues") {
        ctx.loadDefaultIssues();
      }
      if (jiraViewId.value === "issues" && !connectionsOnly.value && connectionId.value) await loadQueries();
    } catch (cause) {
      if (
        generation !== vars.connectionLoadGeneration ||
        requestedProfileId !== preferencesProfileId.value ||
        requestedWorkspaceId !== props.workspaceId
      )
        return;
      issues.value = [];
      reportFailure("Could not load Jira connections", cause);
    } finally {
      if (
        generation === vars.connectionLoadGeneration &&
        requestedProfileId === preferencesProfileId.value &&
        requestedWorkspaceId === props.workspaceId &&
        requestedJiraViewId === jiraViewId.value
      ) {
        connectionsLoaded.value = true;
        connectionsLoading.value = false;
        restoringPreferences.value = false;
        preferencesRestored.value = preferencesCanPersist;
        workspaceViewRestored.value = true;
        workspaceViewRestoredId.value = requestedJiraViewId;
      }
    }
  }
  /** Generations were bumped, so the finally blocks of superseded loads no longer clear their flags: clear them here. */
  function resetLoadingState() {
    clearBusy({ only: LOAD_BUSY_KEYS });
    ctx.issuesLoading.value = false;
    ctx.searchRefreshing.value = false;
    ctx.boardLoading.value = false;
    ctx.boardRefreshing.value = false;
    ctx.boardsLoading.value = false;
    ctx.issueLoading.value = false;
    ctx.selectedRefreshing.value = false;
  }
  async function onConnectionChange() {
    clearPaneError();
    vars.issueOpenGeneration++;
    vars.boardRefreshGeneration++;
    vars.assigneeSearchGeneration++;
    dismissIssuePreview();
    if (vars.assigneeSearchTimer) clearTimeout(vars.assigneeSearchTimer);
    vars.allSearchGeneration++;
    ownIssueSearchGeneration.value++;
    ownBoardGeneration.value++;
    recentGeneration.value++;
    boardLoadGeneration.value++;
    sprintLoadGeneration.value++;
    allMyIssueCursors.value.clear();
    searchHasMore.value = false;
    searchHasRun.value = false;
    searchFailed.value = false;
    ownSearchIdentityLabel.value = "";
    boardId.value = 0;
    boardQuickFilters.value = [];
    vars.loadedQuickFilterBoardKey = "";
    boardQuickFilterError.value = "";
    selectedQuickFilterIds.value = [];
    selectedBoardAssignee.value = null;
    assigneeCatalog.value = [];
    assigneeSearchResults.value = [];
    assigneeSearchText.value = "";
    boardIssueDetailOpen.value = false;
    selected.value = null;
    issues.value = [];
    recentSearches.value = [];
    recentViewedIssues.value = [];
    searchCache.value = null;
    boardColumns.value = [];
    queryId.value = "";
    resetLoadingState();
    if (connectionId.value === "__all__") {
      boards.value = [];
      savedQueries.value = [];
      await searchAllText();
      return;
    }
    await loadWorkspaceProjectScope(connectionId.value);
    if (connectionId.value !== selectedConnection.value?.id) return;
    applyConnectionDefaults();
    if (connectionsOnly.value) return;
    if (connectionId.value) void loadJiraRecents(connectionId.value);
    await loadBoards();
    await loadQueries();
    await search();
  }
  function applyConnectionDefaults() {
    const connection = selectedConnection.value;
    if (!connection || connectionId.value === "__all__") return;
    if (connection.defaultJql?.trim()) {
      jql.value = connection.defaultJql;
      return;
    }
    // currentUser() is whoever the credentials belong to: on a shared technical account that is the account, not you.
    const identity = connection.accountPurpose === "technical" ? connection.ownIdentity : undefined;
    const person = identity ? (identity.kind === "cloud" ? identity.accountId : identity.name) : "";
    jql.value = person
      ? `${jiraSmartFilterClause("assigned-to-me", person.replaceAll("\\", "\\\\").replaceAll('"', '\\"'))} ORDER BY updated DESC`
      : "assignee = currentUser() ORDER BY updated DESC";
  }
  async function verifyConnection() {
    const verifyId = connectionId.value;
    if (!verifyId || verifyingConnectionId.value) return false;
    const verifyGeneration = (connectionVerificationGenerations.get(verifyId) || 0) + 1;
    connectionVerificationGenerations.set(verifyId, verifyGeneration);
    const isSetupVerification = setupInProgress.value;
    verifyingConnectionId.value = verifyId;
    delete connectionVerificationResults[verifyId];
    const endBusy = beginBusy("connection");
    try {
      const result = (await api.verifyJiraConnection(verifyId)) as
        | {
            ok: true;
            identity: { displayName?: string };
            serverTitle: string;
            health: NonNullable<JiraConnection["health"]>;
          }
        | {
            ok: false;
            health: NonNullable<JiraConnection["health"]>;
            error: { code: JiraErrorCode; message: string; retryAfterMs?: number };
          };
      if (connectionVerificationGenerations.get(verifyId) !== verifyGeneration) return false;
      await refreshConnectionList();
      if (connectionVerificationGenerations.get(verifyId) !== verifyGeneration) return false;
      if (result.ok) {
        error.value = "";
        const displayName = result.identity?.displayName || "Jira user";
        if (isSetupVerification) {
          connectionStatus.value = `Verified as ${displayName}`;
          setupStep.value = 3;
        } else {
          connectionVerificationResults[verifyId] = { ok: true, message: `Verified as ${displayName}.` };
          connectionStatus.value = "";
        }
        return true;
      } else {
        rlog("warn", "[jira] Jira connection verification failed", {
          context: "Jira connection verification failed",
          code: result.error.code,
        });
        const failureMessage = friendlyConnectionError(result.error.message, "Jira verification failed.");
        if (isSetupVerification) {
          error.value = "";
          connectionTestState.value = "error";
          connectionTestMessage.value = failureMessage;
          await focusConnectionTestResult();
        } else {
          error.value = "";
          connectionVerificationResults[verifyId] = { ok: false, message: failureMessage };
        }
        return false;
      }
    } catch (cause) {
      if (connectionVerificationGenerations.get(verifyId) !== verifyGeneration) return false;
      const failureMessage = reportFailureText("Jira verification failed", cause);
      if (isSetupVerification) {
        error.value = "";
        connectionTestState.value = "error";
        connectionTestMessage.value = failureMessage;
        await focusConnectionTestResult();
      } else {
        error.value = "";
        connectionVerificationResults[verifyId] = { ok: false, message: failureMessage };
      }
      return false;
    } finally {
      endBusy();
      if (connectionVerificationGenerations.get(verifyId) === verifyGeneration) {
        if (verifyingConnectionId.value === verifyId) verifyingConnectionId.value = null;
      }
    }
  }
  function openConnectionSettings() {
    if (jiraViewId.value !== "issues") return;
    expandedConnectionId.value = undefined;
    activeView.value = "settings";
  }
  async function toggleConnectionPanel(id: string) {
    if (openConnectionPanelId.value === id) {
      expandedConnectionId.value = "";
      return;
    }
    expandedConnectionId.value = id;
    if (connectionId.value === id) return;
    connectionId.value = id;
    await onConnectionChange();
  }
  function finishSetup() {
    clearConnectionTestResult();
    setupInProgress.value = false;
    setupStep.value = 1;
    connectionStatus.value = "";
    resetConnectionDraft();
    void returnFocusFromSetup();
  }
  function startConnectionSetup() {
    clearConnectionTestResult();
    const activeElement = document.activeElement;
    setupReturnFocus.value =
      activeElement instanceof HTMLElement && activeElement !== document.body
        ? activeElement
        : addConnectionButton.value;
    error.value = "";
    connectionActionError.value = "";
    metadataEditing.value = false;
    setupValidationError.value = "";
    connectionStatus.value = "";
    setupDismissed.value = false;
    resetConnectionDraft();
    setupStep.value = 1;
    setupInProgress.value = true;
    void focusSetupStep(1);
  }
  function cancelConnectionSetup() {
    if (credentialsInline.value) {
      closeConnectionEdit();
      return;
    }
    clearConnectionTestResult();
    setupInProgress.value = false;
    setupDismissed.value = true;
    setupStep.value = 1;
    setupValidationError.value = "";
    connectionStatus.value = "";
    resetConnectionDraft();
    void returnFocusFromSetup();
  }
  async function returnFocusFromSetup() {
    await nextTick();
    const target =
      (connectionsOnly.value || noConnectionManager.value) && addConnectionButton.value
        ? addConnectionButton.value
        : setupReturnFocus.value?.isConnected && setupReturnFocus.value !== document.body
          ? setupReturnFocus.value
          : addConnectionButton.value;
    target?.focus();
    setupReturnFocus.value = null;
  }
  function backToConnectionType() {
    clearConnectionTestResult();
    setupStep.value = 1;
    setupValidationError.value = "";
    void focusSetupStep(1);
  }
  function resetConnectionDraft() {
    clearConnectionTestResult();
    Object.assign(draft, {
      id: undefined,
      label: "",
      deployment: "data-center",
      authMode: "pat",
      webUrl: "",
      apiBaseUrl: "",
      email: "",
      apiToken: "",
      pat: "",
      subscriptionKey: "",
      subscriptionHeaderName: "Ocp-Apim-Subscription-Key",
      clientCertificatePath: "",
      clientCertificatePassword: "",
      accountPurpose: "personal",
    });
  }
  function clearConnectionTestResult() {
    vars.connectionTestSession += 1;
    connectionTestBusy.value = false;
    vars.connectionDraftRevision += 1;
    connectionTestState.value = "idle";
    connectionTestMessage.value = "";
  }
  async function focusSetupStep(step: number) {
    await nextTick();
    if (step === 1) setupNameInput.value?.focus();
    else if (step === 2) setupWebUrlInput.value?.focus();
    else setupFinishButton.value?.focus();
  }
  function goToConnectionDetails() {
    clearConnectionTestResult();
    setupStep.value = 2;
    setupValidationError.value = "";
    void focusSetupStep(2);
  }
  function fillConnectionLabel() {
    if (draft.label.trim()) {
      draft.label = draft.label.trim();
      return;
    }
    if (draft.webUrl.trim()) {
      try {
        draft.label = new URL(draft.webUrl).hostname || "Jira";
        return;
      } catch {
        // Invalid URLs are reported by the connection form before saving.
      }
    }
    draft.label = "Jira";
  }
  function validateSetupConnection(): boolean {
    const missingWebUrl = !draft.webUrl.trim();
    const invalidWebUrl = !missingWebUrl && !setupWebUrlInput.value?.checkValidity();
    if (draft.deployment === "cloud") {
      const missingToken = !draft.id && !draft.apiToken.trim();
      if (missingWebUrl || invalidWebUrl) {
        setupValidationError.value = missingWebUrl
          ? "Enter your Jira site address, for example https://your-site.atlassian.net."
          : "Enter a complete Jira site address, including https://.";
        connectionTestFieldError.value = "webUrl";
        setupWebUrlInput.value?.focus();
        return false;
      }
      if (!draft.email.trim() || !setupEmailInput.value?.checkValidity()) {
        setupValidationError.value = "Enter the email address of your Atlassian account.";
        connectionTestFieldError.value = "email";
        setupEmailInput.value?.focus();
        return false;
      }
      if (missingToken) {
        setupValidationError.value = "Enter your Jira API token to continue.";
        connectionTestFieldError.value = "apiToken";
        setupApiTokenInput.value?.focus();
        return false;
      }
      setupValidationError.value = "";
      connectionTestFieldError.value = null;
      return true;
    }
    const missingApiUrl = !draft.apiBaseUrl.trim();
    const invalidApiUrl = !missingApiUrl && !setupApiUrlInput.value?.checkValidity();
    const missingPat = !draft.id && draft.authMode !== "apim" && !draft.pat.trim();
    if (missingWebUrl || invalidWebUrl) {
      setupValidationError.value = missingWebUrl
        ? "Enter the Jira web URL you use in your browser."
        : "Enter a complete Jira web URL, including https://.";
      connectionTestFieldError.value = "webUrl";
      setupWebUrlInput.value?.focus();
      return false;
    }
    if (missingApiUrl || invalidApiUrl) {
      setupValidationError.value = missingApiUrl
        ? "Enter the Jira API URL supplied by your administrator."
        : "Enter a complete Jira API URL, including https://.";
      connectionTestFieldError.value = "apiBaseUrl";
      setupApiUrlInput.value?.focus();
      return false;
    }
    if (missingPat) {
      setupValidationError.value = "Enter your Jira personal access token to continue.";
      connectionTestFieldError.value = "pat";
      setupPatInput.value?.focus();
      return false;
    }
    if (draft.authMode === "apim") {
      if (!draft.subscriptionHeaderName.trim()) {
        setupValidationError.value = "Enter the subscription header name.";
        connectionTestFieldError.value = "subscriptionHeaderName";
        setupHeaderInput.value?.focus();
        return false;
      }
      if (!draft.id && !draft.subscriptionKey.trim()) {
        setupValidationError.value = "Enter the API gateway subscription key.";
        connectionTestFieldError.value = "subscriptionKey";
        setupKeyInput.value?.focus();
        return false;
      }
    }
    setupValidationError.value = "";
    connectionTestFieldError.value = null;
    return true;
  }
  async function focusConnectionTestResult() {
    await nextTick();
    const target = connectionTestResultRef.value;
    if (!target) return;
    let scrollContainer = target.parentElement;
    while (scrollContainer && scrollContainer !== document.body) {
      const overflowY = getComputedStyle(scrollContainer).overflowY;
      if (
        (overflowY === "auto" || overflowY === "scroll") &&
        scrollContainer.scrollHeight > scrollContainer.clientHeight
      )
        break;
      scrollContainer = scrollContainer.parentElement;
    }
    if (scrollContainer && scrollContainer !== document.body) {
      const targetRect = target.getBoundingClientRect();
      const containerRect = scrollContainer.getBoundingClientRect();
      if (targetRect.bottom > containerRect.bottom || targetRect.top < containerRect.top) {
        scrollContainer.scrollTop = Math.max(0, scrollContainer.scrollHeight - scrollContainer.clientHeight);
        await nextTick();
        await new Promise<void>((resolve) => {
          if (typeof requestAnimationFrame === "function") requestAnimationFrame(() => resolve());
          else resolve();
        });
      }
    }
    target.focus({ preventScroll: true });
  }
  function markConnectionTestFieldError(messageText: string) {
    if (draft.deployment === "cloud") {
      if (/email address/i.test(messageText)) connectionTestFieldError.value = "email";
      else if (/api token|rejected the email/i.test(messageText)) connectionTestFieldError.value = "apiToken";
      else if (/site|url|host/i.test(messageText)) connectionTestFieldError.value = "webUrl";
      return;
    }
    if (/certificate|\.pfx|\.p12/i.test(messageText)) {
      connectionTestFieldError.value = /password|passphrase/i.test(messageText) ? "certificatePassword" : "certificate";
    } else if (/subscription.?key|gateway key/i.test(messageText)) connectionTestFieldError.value = "subscriptionKey";
    else if (/header name/i.test(messageText)) connectionTestFieldError.value = "subscriptionHeaderName";
    else if (/personal access token|\bpat\b|token rejected|authentication/i.test(messageText))
      connectionTestFieldError.value = "pat";
    else if (/gateway.*url|api.*url/i.test(messageText)) connectionTestFieldError.value = "apiBaseUrl";
    else if (/web.*url|site address/i.test(messageText)) connectionTestFieldError.value = "webUrl";
  }
  async function testSetupConnection() {
    if (connectionTestBusy.value || connectionSaveBusy.value || isBusy("connection") || !validateSetupConnection())
      return;
    fillConnectionLabel();
    const testedRevision = vars.connectionDraftRevision;
    const testedSession = vars.connectionTestSession;
    connectionTestBusy.value = true;
    connectionTestState.value = "testing";
    connectionTestMessage.value = "";
    connectionTestFieldError.value = null;
    if (!credentialsInline.value) setupInProgress.value = true;
    try {
      const testApi = dynamicApi.testJiraConnection as JiraUiApi["testJiraConnection"] | undefined;
      if (!testApi) throw new Error("Restart the desktop app to enable Jira connection testing.");
      const result = await testApi({
        ...(draft.id ? { id: draft.id } : {}),
        label: draft.label,
        deployment: draft.deployment,
        webUrl: draft.webUrl.trim(),
        apiBaseUrl: draft.deployment === "cloud" ? draft.webUrl.trim() : draft.apiBaseUrl.trim(),
        ...(draft.deployment === "cloud" ? { email: draft.email.trim(), apiToken: draft.apiToken } : {}),
        authMode: draft.authMode,
        pat: draft.pat,
        subscriptionKey: draft.subscriptionKey,
        subscriptionHeaderName: draft.subscriptionHeaderName.trim(),
        clientCertificatePath: draft.clientCertificatePath,
        clientCertificatePassword: draft.clientCertificatePassword,
        accountPurpose: draft.accountPurpose as "personal" | "technical",
      });
      if (testedSession !== vars.connectionTestSession) return;
      if (testedRevision !== vars.connectionDraftRevision) {
        connectionTestState.value = "error";
        connectionTestMessage.value = "Connection details changed while testing. Run the test again.";
        return;
      }
      if (!result.ok) {
        rlog("warn", "[jira] Jira connection test failed", {
          context: "Jira connection test failed",
          code: result.error.code,
        });
        connectionTestState.value = "error";
        connectionTestMessage.value = friendlyConnectionError(
          result.error.message,
          "Could not verify the Jira connection.",
        );
        markConnectionTestFieldError(connectionTestMessage.value);
        return;
      }
      const identity = result.identity?.displayName || result.identity?.name || result.identity?.accountId;
      connectionTestState.value = "success";
      connectionTestMessage.value = `Connection test passed${identity ? ` · ${identity}` : ""}. Nothing was saved.`;
    } catch (cause) {
      if (testedSession !== vars.connectionTestSession) return;
      const failureMessage = reportFailureText("Could not test the Jira connection", cause);
      connectionTestState.value = "error";
      connectionTestMessage.value =
        testedRevision === vars.connectionDraftRevision
          ? failureMessage
          : "Connection details changed while testing. Run the test again.";
      markConnectionTestFieldError(connectionTestMessage.value);
    } finally {
      if (testedSession === vars.connectionTestSession) {
        connectionTestBusy.value = false;
        if (connectionTestState.value === "testing") connectionTestState.value = "idle";
        if (connectionTestState.value === "success" || connectionTestState.value === "error")
          await focusConnectionTestResult();
      }
    }
  }
  async function saveSetupConnection() {
    if (connectionTestBusy.value || connectionSaveBusy.value || !validateSetupConnection()) return;
    fillConnectionLabel();
    const inline = credentialsInline.value;
    if (!inline) setupInProgress.value = true;
    connectionSaveBusy.value = true;
    try {
      const saved = await saveConnection();
      if (saved && connectionId.value) {
        const identity = selectedConnection.value?.verifiedIdentity?.displayName;
        connectionStatus.value = `Saved and verified${identity ? ` as ${identity}` : ""}. Credentials were stored.`;
        if (inline) closeConnectionEdit();
        else {
          setupStep.value = 3;
          resetConnectionDraft();
        }
      }
    } finally {
      connectionSaveBusy.value = false;
    }
  }
  async function openApiTokenHelp() {
    try {
      if (!api.openExternal) throw new Error("Opening links is unavailable in this client.");
      await api.openExternal(JIRA_API_TOKEN_URL);
    } catch (cause) {
      reportFailure("Could not open the Atlassian API token page", cause);
    }
  }
  async function chooseClientCertificate() {
    try {
      const picker = (
        api as unknown as {
          browseFile?: (options: { filters: Array<{ name: string; extensions: string[] }> }) => Promise<string | null>;
        }
      ).browseFile;
      if (!picker) {
        setupValidationError.value = "File selection is available in the desktop app.";
        return;
      }
      const path = await picker({ filters: [{ name: "PKCS#12 certificate", extensions: ["pfx", "p12"] }] });
      if (path) draft.clientCertificatePath = path;
    } catch (cause) {
      reportFailure("Could not select the certificate file", cause, setupValidationError);
    }
  }
  function loadCredentialsDraft(connection: JiraConnection) {
    clearConnectionTestResult();
    setupValidationError.value = "";
    draft.id = connection.id;
    draft.label = connection.label;
    draft.deployment = connection.deployment === "cloud" ? "cloud" : "data-center";
    draft.authMode = connection.auth?.kind === "dc-apim" ? "apim" : "pat";
    draft.webUrl = connection.webUrl;
    draft.apiBaseUrl = connection.apiBaseUrl || "";
    draft.email = connection.auth?.email || "";
    draft.apiToken = "";
    draft.accountPurpose = connection.accountPurpose === "technical" ? "technical" : "personal";
    draft.pat = "";
    draft.subscriptionKey = "";
    draft.subscriptionHeaderName = connection.subscriptionHeaderName || "Ocp-Apim-Subscription-Key";
    draft.clientCertificatePath = connection.clientCertificatePath || "";
    draft.clientCertificatePassword = "";
  }
  function openConnectionEditTab(tab: "general" | "connection") {
    if (metadataEditing.value && connectionEditTab.value === tab) return;
    const connection = selectedConnection.value;
    if (tab === "connection" && connection) loadCredentialsDraft(connection);
    connectionEditTab.value = tab;
  }
  function closeConnectionEdit() {
    const hadCredentials = connectionEditTab.value === "connection";
    metadataEditing.value = false;
    connectionEditTab.value = "general";
    setupValidationError.value = "";
    if (hadCredentials) resetConnectionDraft();
  }
  /** Opens the connection's Edit form on its Connection tab: address and credentials, a blank secret keeps the saved one. */
  function editConnectionCredentials() {
    const connection = selectedConnection.value;
    if (!connection) return;
    error.value = "";
    connectionStatus.value = "";
    expandedConnectionId.value = connection.id;
    editConnectionMetadata();
    openConnectionEditTab("connection");
  }
  function jiraConnectionTypeLabel(connection: JiraConnection) {
    if (connection.deployment === "cloud") return "Jira Cloud · API token";
    return connection.auth?.kind === "dc-apim" ? "API gateway (APIM)" : "Jira Data Center · PAT";
  }
  async function runManagedConnectionAction(
    connectionIdToManage: string,
    action: "verify" | "edit" | "credentials" | "disconnect",
  ) {
    connectionId.value = connectionIdToManage;
    error.value = "";
    connectionActionError.value = "";
    if (action === "verify") await verifyConnection();
    else if (action === "edit") editConnectionMetadata();
    else if (action === "credentials") editConnectionCredentials();
    else await removeConnection();
  }
  function editConnectionMetadata() {
    const connection = selectedConnection.value;
    if (!connection) return;
    metadataDraft.label = connection.label;
    metadataDraft.accountPurpose = connection.accountPurpose === "technical" ? "technical" : "personal";
    metadataDraft.issueKeyPrefixesText = (connection.issueKeyPrefixes || []).join(", ");
    metadataDraft.defaultJql = connection.defaultJql || "";
    metadataDraft.projectKeysText = (connection.projectKeys || []).join(", ");
    metadataDraft.pollSeconds = clampJiraPollSeconds(connection.pollSeconds);
    metadataTouched.value = false;
    metadataError.value = "";
    if (connectionEditTab.value === "connection") resetConnectionDraft();
    connectionEditTab.value = "general";
    metadataEditing.value = true;
  }
  async function saveConnectionMetadata() {
    if (!selectedConnection.value) return;
    metadataTouched.value = true;
    metadataError.value = "";
    const validation = metadataValidation.value;
    if (!validation.ok) {
      metadataError.value = "Fix the highlighted fields to save the connection details.";
      return;
    }
    const endBusy = beginBusy("connection");
    try {
      await api.updateJiraConnectionMetadata?.({ connectionId: connectionId.value, ...validation.value });
      closeConnectionEdit();
      metadataTouched.value = false;
      await refreshConnectionList();
    } catch (cause) {
      reportFailure("Could not update Jira connection details", cause, metadataError);
    } finally {
      endBusy();
    }
  }
  /** The credentials form opens on this connection with the token (or gateway key) field focused. */
  async function signInAgainWithCredentials(connection: JiraConnection) {
    connectionId.value = connection.id;
    if (jiraViewId.value === "issues") activeView.value = "settings";
    editConnectionCredentials();
    await nextTick();
    await nextTick();
    (draft.deployment === "cloud"
      ? setupApiTokenInput.value
      : draft.authMode === "apim"
        ? setupKeyInput.value
        : setupPatInput.value
    )?.focus();
  }
  function ownJiraIdentityIds() {
    const own = selectedConnection.value?.ownIdentity;
    return own ? [own.accountId, own.name].filter((value): value is string => Boolean(value)) : [];
  }
  function isOwnJiraUser(user: JiraUserRef) {
    return ownJiraIdentityIds().includes(jiraUserIdentity(user));
  }
  function isOwnJiraAssignee(issue: JiraIssue) {
    const ids = ownJiraIdentityIds();
    if (!ids.length || !issue.assigneeRef) return false;
    return issue.assigneeRef.kind === "cloud"
      ? ids.includes(issue.assigneeRef.accountId)
      : ids.includes(issue.assigneeRef.name) || Boolean(issue.assigneeRef.key && ids.includes(issue.assigneeRef.key));
  }
  /** What follows a saved identity: the My issues list (default), the saved My issues tab, or the pending assignment. */
  const humanIdentityAfter = ref<"list" | "tab" | "assign">("list");
  function openInlineHumanIdentitySetup(after: "list" | "tab" | "assign" = "list") {
    humanIdentityAfter.value = after;
    humanIdentitySetupOpen.value = true;
    humanIdentitySearchText.value = "";
    humanIdentitySearchResults.value = [];
    humanIdentitySelectedUser.value = null;
    humanIdentitySearchError.value = "";
    void nextTick(() => {
      jiraRootRef.value?.querySelector<HTMLInputElement>(".jira-human-identity-setup input")?.focus();
    });
  }
  function closeInlineHumanIdentitySetup() {
    ctx.pendingAssignIssue.value = null;
    humanIdentitySetupOpen.value = false;
    humanIdentitySearchError.value = "";
    void nextTick(() => jiraRootRef.value?.querySelector<HTMLElement>(".jira-views-menu > summary")?.focus());
  }
  async function searchHumanIdentityUsers() {
    const requestedConnectionId = connectionId.value;
    const query = humanIdentitySearchText.value.trim();
    if (!requestedConnectionId || !query) return;
    if (!dynamicApi.searchJiraUsers) {
      humanIdentitySearchError.value = "Jira user search is unavailable for this session.";
      return;
    }
    const generation = ++vars.humanIdentitySearchGeneration;
    humanIdentitySearchLoading.value = true;
    humanIdentitySearchError.value = "";
    humanIdentitySelectedUser.value = null;
    try {
      const results = await dynamicApi.searchJiraUsers({ connectionId: requestedConnectionId, query, limit: 25 });
      if (generation !== vars.humanIdentitySearchGeneration || requestedConnectionId !== connectionId.value) return;
      humanIdentitySearchResults.value = results;
      if (!results.length) humanIdentitySearchError.value = "No matching Jira users. Try another search.";
    } catch (cause) {
      if (generation === vars.humanIdentitySearchGeneration)
        reportFailure("Could not search Jira users", cause, humanIdentitySearchError);
    } finally {
      if (generation === vars.humanIdentitySearchGeneration) humanIdentitySearchLoading.value = false;
    }
  }
  function selectHumanIdentityUser(user: JiraUserRef) {
    humanIdentitySelectedUser.value = user;
    humanIdentitySearchError.value = "";
  }
  async function saveSelectedHumanIdentity() {
    const user = humanIdentitySelectedUser.value;
    const requestedConnectionId = connectionId.value;
    if (!user || !requestedConnectionId) return;
    if (!dynamicApi.verifyJiraOwnIdentity || !dynamicApi.setJiraOwnIdentity) {
      humanIdentitySearchError.value = "Identity verification is unavailable for this session.";
      return;
    }
    if (humanIdentitySaving.value) return;
    const userId = jiraUserIdentity(user);
    humanIdentitySaving.value = true;
    humanIdentitySearchError.value = "";
    try {
      const verified = await dynamicApi.verifyJiraOwnIdentity({ connectionId: requestedConnectionId, userId });
      if (verified && typeof verified === "object" && "ok" in verified && verified.ok === false) {
        throw new Error("Jira could not verify this user for the selected connection.");
      }
      await dynamicApi.setJiraOwnIdentity({ connectionId: requestedConnectionId, userId });
      await refreshConnectionList();
      if (requestedConnectionId !== connectionId.value || !selectedConnection.value?.ownIdentity) {
        throw new Error("The selected identity was not saved for this connection.");
      }
      humanIdentitySetupOpen.value = false;
      if (humanIdentityAfter.value === "tab") await openMyIssuesBoard();
      else if (humanIdentityAfter.value === "assign") {
        const pending = ctx.pendingAssignIssue.value;
        ctx.pendingAssignIssue.value = null;
        if (
          ctx.selected.value?.ref?.connectionId !== requestedConnectionId &&
          pending?.ref?.connectionId === requestedConnectionId
        )
          await ctx.openIssue(pending);
        if (ctx.selected.value?.ref?.connectionId === requestedConnectionId) ctx.assignToMe();
      } else {
        ctx.showIssuesView();
        await ctx.searchOwnIssues("statusCategory != Done");
      }
    } catch (cause) {
      reportFailure("Could not verify and save the selected Jira identity", cause, humanIdentitySearchError);
    } finally {
      humanIdentitySaving.value = false;
    }
  }
  async function verifyOwnIdentity() {
    if (isBusy("identity")) return;
    identityError.value = "";
    const endIdentity = beginBusy("identity");
    try {
      if (!identityValue.value.trim()) throw new Error("Enter the Jira accountId or Data Center username to verify.");
      const payload = { connectionId: connectionId.value, userId: identityValue.value.trim() };
      const verified = await dynamicApi.verifyJiraOwnIdentity?.(payload);
      await dynamicApi.setJiraOwnIdentity?.(payload);
      await refreshConnectionList();
      connectionStatus.value = `Personal identity verified: ${(verified as { displayName?: string })?.displayName || selectedConnection.value?.ownIdentity?.displayName || identityValue.value}`;
    } catch (cause) {
      reportFailure("Could not verify personal identity", cause, identityError);
    } finally {
      endIdentity();
    }
  }
  async function saveConnection(): Promise<boolean> {
    if (isBusy("connection-save")) return false;
    const endSave = beginBusy("connection-save");
    const endBusy = beginBusy("connection");
    error.value = "";
    try {
      const result = (await api.saveJiraConnection({
        ...draft,
        email: draft.deployment === "cloud" ? draft.email.trim() : undefined,
        apiBaseUrl: draft.deployment === "cloud" ? draft.webUrl.trim() : draft.apiBaseUrl,
      })) as { id?: string; connection?: { id?: string } } | undefined;
      const savedId = result?.connection?.id || result?.id || draft.id;
      if (savedId) {
        connectionId.value = savedId;
        connectionVerificationGenerations.set(savedId, (connectionVerificationGenerations.get(savedId) || 0) + 1);
        // A previous explicit Test result is keyed by connection ID. The save
        // endpoint has now verified these credentials, so discard that stale
        // result instead of carrying an old 403 into the refreshed manager card.
        delete connectionVerificationResults[savedId];
        if (verifyingConnectionId.value === savedId) verifyingConnectionId.value = null;
      }
      await loadConnections();
      if (savedId) connectionId.value = savedId;
      return true;
    } catch (cause) {
      const failureMessage = reportFailureText("Could not save the Jira connection", cause);
      error.value = "";
      connectionTestState.value = "error";
      connectionTestMessage.value = failureMessage;
      markConnectionTestFieldError(failureMessage);
      await focusConnectionTestResult();
      return false;
    } finally {
      endBusy();
      endSave();
    }
  }
  async function removeConnection() {
    if (!connectionId.value) return;
    const target = connections.value.find((connection) => connection.id === connectionId.value);
    const payload = store.payload as {
      appState?: { workspaces?: Array<{ kind?: string; profileId?: string; jiraBoard?: { connectionId?: unknown } }> };
    } | null;
    const pinnedBoards = (payload?.appState?.workspaces || []).filter(
      (workspace) =>
        workspace.kind === "jira-board" &&
        (workspace.profileId || "default") === (store.myActiveProfileId || "default") &&
        String(workspace.jiraBoard?.connectionId) === connectionId.value,
    ).length;
    const confirmed = await store.confirmInApp({
      title: "Disconnect Jira connection?",
      message: [
        `This removes ${target ? `“${target.label}”` : "the connection"} and its saved credentials from this profile.`,
        "It also removes its saved views, polling watches and saved repository targets.",
        pinnedBoards
          ? `${pinnedBoards} pinned board workspace${pinnedBoards === 1 ? "" : "s"} will close.`
          : "No pinned board workspaces are open for it.",
        "Nothing in Jira itself is deleted.",
      ].join(" "),
      confirmLabel: "Disconnect",
      danger: true,
    });
    if (!confirmed) return;
    if (isBusy("connection-remove")) return;
    const endRemove = beginBusy("connection-remove");
    const endBusy = beginBusy("connection");
    error.value = "";
    connectionActionError.value = "";
    try {
      await api.deleteJiraConnection(connectionId.value);
      connectionId.value = "";
      selected.value = null;
      issues.value = [];
      await loadConnections();
    } catch (cause) {
      reportFailure("Could not disconnect Jira", cause, connectionActionError);
    } finally {
      endBusy();
      endRemove();
    }
  }
  return {
    connectionsLoaded,
    setupInProgress,
    setupDismissed,
    setupStep,
    setupValidationError,
    connectionTestBusy,
    connectionSaveBusy,
    connectionTestState,
    connectionTestMessage,
    connectionTestFieldError,
    connectionTestResultRef,
    verifyingConnectionId,
    connectionVerificationResults,
    connectionVerificationGenerations,
    setupNameInput,
    setupWebUrlInput,
    setupApiUrlInput,
    setupPatInput,
    setupEmailInput,
    setupApiTokenInput,
    setupKeyInput,
    setupHeaderInput,
    setupCertificateInput,
    setupCertificatePasswordInput,
    setupFinishButton,
    addConnectionButton,
    setupReturnFocus,
    connectionsLoading,
    identityPanelOpen,
    draft,
    metadataDraft,
    accountPurposeOptions,
    connectionTypeOptions,
    connectionType,
    connectionTypeDescription,
    metadataEditing,
    setupVisible,
    noConnectionManager,
    connectionOptions,
    connectionStatus,
    identityValue,
    humanIdentitySetupOpen,
    humanIdentitySearchText,
    humanIdentitySearchResults,
    humanIdentitySelectedUser,
    humanIdentitySearchLoading,
    humanIdentitySaving,
    humanIdentitySearchError,
    connectionActionError,
    identityError,
    metadataError,
    metadataTouched,
    metadataValidation,
    restoreRetryable,
    refreshConnectionList,
    signInAgainWithCredentials,
    retryRestore,
    resetLoadingState,
    loadConnections,
    onConnectionChange,
    applyConnectionDefaults,
    verifyConnection,
    openConnectionSettings,
    toggleConnectionPanel,
    expandedConnectionId,
    openConnectionPanelId,
    finishSetup,
    startConnectionSetup,
    cancelConnectionSetup,
    returnFocusFromSetup,
    backToConnectionType,
    resetConnectionDraft,
    clearConnectionTestResult,
    focusSetupStep,
    goToConnectionDetails,
    fillConnectionLabel,
    validateSetupConnection,
    focusConnectionTestResult,
    markConnectionTestFieldError,
    testSetupConnection,
    saveSetupConnection,
    chooseClientCertificate,
    openApiTokenHelp,
    editConnectionCredentials,
    connectionEditTab,
    credentialsInline,
    openConnectionEditTab,
    closeConnectionEdit,
    jiraConnectionTypeLabel,
    runManagedConnectionAction,
    editConnectionMetadata,
    saveConnectionMetadata,
    ownJiraIdentityIds,
    isOwnJiraUser,
    isOwnJiraAssignee,
    openInlineHumanIdentitySetup,
    closeInlineHumanIdentitySetup,
    searchHumanIdentityUsers,
    selectHumanIdentityUser,
    saveSelectedHumanIdentity,
    verifyOwnIdentity,
    saveConnection,
    removeConnection,
  };
}
