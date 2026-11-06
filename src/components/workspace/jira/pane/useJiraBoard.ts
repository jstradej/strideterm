import { computed, nextTick, ref } from "vue";
import { jiraStatusTone, type JiraStatusTone } from "../jiraPeople";
import { filterJiraIssues, sortJiraIssues } from "../jiraIssueList";
import { writeLastJiraSearch, type JiraDoneWithinDays } from "../jira-view-preferences.js";
import { jiraViewTabId } from "../../../../app/jira-view-tabs.js";
import { isSupersededActivation } from "./jira-failure.js";
import {
  type JiraSavedWorkspaceView,
  type JiraWorkspaceViewInput,
  type JiraWorkspaceViewsState,
} from "../../../../../electron/shared/types/jira-workspace-views.js";
import {
  type JiraBoardQuickFilter,
  type JiraUserRef,
  type JiraCacheMetadata,
  type JiraBoardFilter,
  type JiraBoardOwner,
  type JiraBoardCapabilities,
  type JiraColumn,
  type JiraSprint,
  type JiraIssue,
  type JiraBoardSearchResult,
  type JiraBoard,
  type JiraWorkspaceRecord,
  type JiraBoardViewResult,
  aggregateCacheMetadata,
} from "./jira-pane-types.js";
import type { JiraPaneContext } from "./jira-pane-context.js";

export function useJiraBoard(ctx: JiraPaneContext) {
  const {
    activeView,
    api,
    boardId,
    boardIssueDetailOpen,
    boardMode,
    boards,
    isBusy,
    connectionId,
    connectionsOnly,
    currentWorkspace,
    dismissIssuePreview,
    doneWithinDays,
    dynamicApi,
    error,
    isCompactPane,
    isJiraAccessFailure,
    issueFilterText,
    issueReturnNativeIssueId,
    issueSort,
    issues,
    jiraRootRef,
    jiraUserIdentity,
    jiraViewId,
    nativeIssueListRef,
    ownIssuesBoardMode,
    ownSearchIdentityLabel,
    preferencesProfileId,
    projectScopeChoice,
    projectScopeConfigured,
    props,
    reportFailure,
    reportFailureText,
    restoredPreferences,
    searchCache,
    searchHasRun,
    selected,
    selectedBoardAssignee,
    beginBusy,
    selectedConnection,
    selectedQuickFilterIds,
    selectedSprintId,
    store,
    vars,
    workspaceRecords,
  } = ctx;
  const workspaceViewsState = ref<JiraWorkspaceViewsState | null>(null);
  const workspaceViewRestored = ref(false);
  const workspaceViewRestoredId = ref("");
  const workspaceViewSaving = ref(false);
  const workspaceViewSaveError = ref("");
  const nativePresentationChoice = ref<"board" | "list" | null>(null);
  const nativeStatusFilter = ref<string | null>(null);
  const nativeStatusFilterConfigured = ref(false);
  const nativePersonalScope = ref<"open" | "all">("open");
  const nativePersonalScopeConfigured = ref(false);
  const nativePersonalScopeChoice = computed({
    get: () => nativePersonalScope.value,
    set: (value: string | number | null) => {
      nativePersonalScope.value = value === "all" ? "all" : "open";
      nativePersonalScopeConfigured.value = true;
    },
  });
  const workspaceViews = computed(() => {
    const payload = store.payload as unknown as { jiraWorkspaceViews?: Record<string, JiraWorkspaceViewsState> } | null;
    return (
      (workspaceViewsState.value?.workspaceId === props.workspaceId ? workspaceViewsState.value : null) ||
      (props.workspaceId && payload?.jiraWorkspaceViews?.[props.workspaceId]) ||
      null
    );
  });
  const selectedNativeView = computed(() =>
    jiraViewId.value === "issues"
      ? null
      : (workspaceViews.value?.views.find((view) => view.viewId === jiraViewId.value && view.kind !== "issues") as
          JiraSavedWorkspaceView | undefined),
  );
  const isNativeSavedView = computed(() => jiraViewId.value !== "issues" && selectedNativeView.value !== null);
  const nativePresentation = computed(
    () =>
      nativePresentationChoice.value ||
      selectedNativeView.value?.presentation ||
      (isCompactPane.value ? "list" : "board"),
  );
  const nativeListPresentation = computed(
    () => isNativeSavedView.value && activeView.value === "board" && nativePresentation.value === "list",
  );
  const nativeViewSync = computed(() => workspaceViews.value?.syncByViewId[jiraViewId.value] || null);
  const nativeIssueListScrollTop = ref(0);
  const nativeBoardScrollLeft = ref(0);
  const boardViewLoaded = ref(false);
  const boardLoadGeneration = ref(0);
  const sprintLoadGeneration = ref(0);
  const ownIssueSearchGeneration = ref(0);
  const ownBoardGeneration = ref(0);
  const boardsLoading = ref(false);
  const boardFilterDetailsRef = ref<HTMLDetailsElement | null>(null);
  const boardFilterOpenOverride = ref<boolean | null>(null);
  const boardQuickFilters = ref<JiraBoardQuickFilter[]>([]);
  const boardFilterDetailsOpen = computed(() => boardFilterOpenOverride.value ?? false);
  const assigneeCatalog = ref<JiraUserRef[]>([]);
  // The statuses the board's issues are in before any person or quick filter, collected with the people: a status
  // chip row that followed the chosen person changed width and moved the people chips after it.
  const rosterStatusKeys = ref(new Set<string>());
  const assigneeSearchText = ref("");
  const assigneeSearchResults = ref<JiraUserRef[]>([]);
  const assigneeSearchLoading = ref(false);
  const boardLoading = ref(false);
  const boardRefreshing = ref(false);
  const boardCache = ref<JiraCacheMetadata | null>(null);
  const boardRefreshError = ref("");
  const boardQuickFilterError = ref("");
  const boardActionError = ref("");
  const assigneeSearchError = ref("");
  const boardPageCacheMetadata = ref<Array<JiraCacheMetadata | null>>([null]);
  const sprintMetadataPageCacheMetadata = ref<Array<JiraCacheMetadata | null>>([null]);
  const sprintIssuePageCacheMetadata = ref<Array<JiraCacheMetadata | null>>([null]);
  const boardCapability = ref("");
  const boardFilter = ref<JiraBoardFilter | null>(null);
  const boardOwner = ref<JiraBoardOwner | null>(null);
  const boardCapabilities = ref<JiraBoardCapabilities>({});
  const boardPageCursor = ref("");
  const boardPageCursors = ref<Array<string | undefined>>([undefined]);
  const boardHasMore = ref(false);
  const boardPageTruncated = ref(false);
  const sprintsPageCursor = ref("");
  const sprintMetadataPageCursors = ref<Array<string | undefined>>([undefined]);
  const sprintsHasMore = ref(false);
  const boardColumns = ref<JiraColumn[]>([]);
  const boardSearchQuery = ref("");
  const boardSearchCursor = ref("");
  const boardsHaveMore = ref(false);
  const boardPickerNotice = ref("");
  const boardCatalogLoaded = ref(false);
  const boardSearchGeneration = ref(0);
  const selectedBoardLabel = ref("");
  const selectedBoardType = ref("");
  const boardOptions = computed(() => [
    { value: 0, label: "Search results" },
    ...(boardId.value && !boards.value.some((board) => board.id === boardId.value) && selectedBoardLabel.value
      ? [{ value: boardId.value, label: selectedBoardLabel.value }]
      : []),
    ...boards.value.map((board) => ({ value: board.id, label: `${board.name} · ${board.type}` })),
  ]);
  const boardModeOptions = computed(() =>
    selectedBoard.value?.type === "scrum"
      ? [
          { value: "sprints", label: "Sprint" },
          { value: "backlog", label: "Backlog" },
          { value: "issues", label: "All issues" },
        ]
      : [{ value: "issues", label: "Board" }],
  );
  const doneWithinOptions = [
    { value: "7", label: "Done in last 7 days" },
    { value: "14", label: "Done in last 14 days" },
    { value: "30", label: "Done in last 30 days" },
    { value: "90", label: "Done in last 90 days" },
    { value: "all", label: "All completed" },
  ];
  const doneWithinChoice = computed({
    get: () => (doneWithinDays.value ? String(doneWithinDays.value) : "all"),
    set: (value: string) => {
      doneWithinDays.value = value === "all" ? null : (Number(value) as JiraDoneWithinDays);
    },
  });
  const sprintOptions = computed(() =>
    boardSprints.value.map((sprint) => ({ value: Number(sprint.id), label: `${sprint.name} · ${sprint.state}` })),
  );
  const boardSprints = ref<JiraSprint[]>([]);
  const selectedSprint = computed(
    () => boardSprints.value.find((sprint) => Number(sprint.id) === selectedSprintId.value) || null,
  );
  const sprintDateRange = computed(() => {
    const sprint = selectedSprint.value;
    const format = (value?: string) => {
      const date = value ? new Date(value) : null;
      return date && !Number.isNaN(date.getTime())
        ? new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short" }).format(date)
        : "";
    };
    const start = format(sprint?.startDate);
    const end = format(sprint?.endDate);
    return start && end ? `${start} – ${end}` : start || end;
  });
  const sprintRemainingLabel = computed(() => {
    const sprint = selectedSprint.value;
    const end = sprint?.endDate ? new Date(sprint.endDate).getTime() : NaN;
    if (sprint?.state !== "active" || Number.isNaN(end)) return "";
    const days = Math.ceil((end - Date.now()) / 86_400_000);
    if (days > 1) return `${days} days left`;
    if (days === 1) return "1 day left";
    if (days === 0) return "Ends today";
    return `Overdue by ${-days} ${days === -1 ? "day" : "days"}`;
  });
  const sprintProgress = computed(() => ({
    total: sprintIssues.value.length,
    done: sprintIssues.value.filter((issue) => jiraStatusTone(issue.status, issue.statusCategory) === "done").length,
  }));
  const sprintIssues = ref<JiraIssue[]>([]);
  const sprintIssuesCursor = ref("");
  const sprintIssuePageCursors = ref<Array<string | undefined>>([undefined]);
  const sprintIssuesHasMore = ref(false);
  const sprintIssuesTruncated = ref(false);
  const selectedBoard = computed(
    () =>
      boards.value.find((board) => board.id === boardId.value) ||
      (boardId.value && selectedBoardLabel.value
        ? { id: boardId.value, name: selectedBoardLabel.value, type: selectedBoardType.value }
        : undefined),
  );
  const isOwnBoardFilterSelected = computed(() => {
    const own = selectedConnection.value?.ownIdentity;
    const assignee = selectedBoardAssignee.value;
    if (!own || assignee?.kind !== "user") return false;
    const ownId = own.kind === "cloud" ? own.accountId : own.name;
    return Boolean(ownId && ownId === assignee.id);
  });
  const pinnedBoardInfo = computed(() => {
    const workspace = currentWorkspace.value;
    if (
      workspace?.kind !== "jira-board" ||
      (workspace.profileId || "default") !== (store.myActiveProfileId || "default")
    )
      return undefined;
    return workspace.jiraBoard;
  });
  const jiraInboxWorkspace = computed(() => {
    const workspace = currentWorkspace.value;
    if (
      !workspace ||
      workspace.kind !== "jira" ||
      (workspace.profileId || "default") !== (store.myActiveProfileId || "default")
    )
      return null;
    return workspace;
  });
  const pinnedBoardWorkspace = computed(() => {
    const current = currentWorkspace.value;
    const info = pinnedBoardInfo.value;
    if (
      current?.kind === "jira-board" &&
      info &&
      (current.profileId || "default") === (store.myActiveProfileId || "default")
    )
      return current;
    if (!jiraInboxWorkspace.value || !selectedBoard.value || !connectionId.value) return null;
    return (
      workspaceRecords.value.find(
        (workspace) =>
          workspace.kind === "jira-board" &&
          (workspace.profileId || "default") === (jiraInboxWorkspace.value!.profileId || "default") &&
          workspace.jiraBoard?.parentWorkspaceId === jiraInboxWorkspace.value!.id &&
          workspace.jiraBoard.connectionId === connectionId.value &&
          workspace.jiraBoard.boardId === String(boardId.value),
      ) || null
    );
  });
  const selectedBoardSavedView = computed(
    () =>
      (workspaceViews.value?.views.find(
        (view) =>
          view.kind === "board" &&
          view.connectionId === connectionId.value &&
          view.boardId === boardId.value &&
          boardId.value > 0,
      ) as JiraSavedWorkspaceView | undefined) || null,
  );
  const canOpenSelectedBoardAsTab = computed(() =>
    Boolean(jiraInboxWorkspace.value && selectedBoard.value && connectionId.value && !connectionsOnly.value),
  );
  const compactBoardLayout = computed(
    () =>
      isCompactPane.value &&
      (Boolean(selectedBoard.value) || (activeView.value === "board" && !boardId.value && searchHasRun.value)),
  );
  const compactSelectedIssue = computed(
    () => isCompactPane.value && (Boolean(selected.value) || boardIssueDetailOpen.value || ctx.issueLoading.value),
  );
  function queueBoardSearch(query: string) {
    boardSearchQuery.value = query;
    boardPickerNotice.value = "";
    boardSearchGeneration.value += 1;
    if (vars.boardSearchTimer) clearTimeout(vars.boardSearchTimer);
    boardsLoading.value = true;
    vars.boardSearchTimer = setTimeout(() => {
      vars.boardSearchTimer = undefined;
      void loadBoards(query, false);
    }, 250);
  }
  async function loadMoreBoards() {
    if (!boardsHaveMore.value || !boardSearchCursor.value || boardsLoading.value) return;
    await loadBoards(boardSearchQuery.value, true);
  }
  async function loadBoards(query = boardSearchQuery.value, append = false) {
    const generation = ++boardSearchGeneration.value;
    const cursor = append ? boardSearchCursor.value : "";
    boardSearchQuery.value = query;
    boardPickerNotice.value = "";
    boardsLoading.value = true;
    try {
      let page: JiraBoardSearchResult;
      if (dynamicApi.searchJiraBoards) {
        page = (await dynamicApi.searchJiraBoards({
          connectionId: connectionId.value,
          ...(query.trim() ? { query: query.trim() } : {}),
          ...(cursor ? { cursor } : {}),
          limit: 50,
          ...ctx.projectScopePayload(),
        })) as JiraBoardSearchResult;
      } else {
        page = { boards: (await api.listJiraBoards(connectionId.value)) as JiraBoard[], hasMore: false };
      }
      if (generation !== boardSearchGeneration.value) return;
      if (append) {
        const existingIds = new Set(boards.value.map((board) => board.id));
        boards.value = [...boards.value, ...page.boards.filter((board) => !existingIds.has(board.id))];
      } else {
        boards.value = page.boards;
      }
      boardSearchCursor.value = page.nextCursor || "";
      boardsHaveMore.value = page.hasMore === true && Boolean(page.nextCursor);
      boardCatalogLoaded.value = true;
      if (page.truncated)
        boardPickerNotice.value = "Showing a limited set of boards. Narrow the project scope or search by name.";
      if (selectedBoard.value) {
        selectedBoardLabel.value = selectedBoard.value.name;
        selectedBoardType.value = selectedBoard.value.type;
        if (selectedBoard.value.type !== "scrum" && boardMode.value !== "issues") {
          boardMode.value = "issues";
          if (boardId.value && jiraViewId.value !== "issues") void loadBoard();
        }
      }
    } catch (cause) {
      if (generation === boardSearchGeneration.value) {
        if (!append) boards.value = [];
        boardsHaveMore.value = false;
        boardSearchCursor.value = "";
        const text = reportFailureText("Could not load Jira boards", cause);
        boardPickerNotice.value = /choose up to 8 projects/i.test(text)
          ? "Choose up to 8 projects to find boards, or narrow the search by name."
          : text;
      }
    } finally {
      if (generation === boardSearchGeneration.value) boardsLoading.value = false;
    }
  }
  function nativeJiraViewId(viewId: string) {
    return jiraViewTabId(props.workspaceId, viewId);
  }
  function workspaceViewInput(kind: "board" | "personal", identityLabel?: string): JiraWorkspaceViewInput {
    const board = selectedBoard.value;
    const boardName = kind === "personal" ? identityLabel || "My issues" : board?.name || "Jira board";
    const existing = workspaceViews.value?.views.find(
      (view) =>
        view.kind === kind &&
        view.connectionId === connectionId.value &&
        view.boardId === (kind === "personal" ? null : boardId.value),
    ) as JiraSavedWorkspaceView | undefined;
    return {
      ...(existing?.viewId ? { viewId: existing.viewId } : {}),
      kind,
      connectionId: connectionId.value,
      boardId: kind === "personal" ? null : boardId.value,
      boardName,
      title: existing?.title || (kind === "personal" ? "My issues" : boardName),
      mode: kind === "personal" ? "issues" : boardMode.value,
      sprintId: kind === "personal" || boardMode.value !== "sprints" ? null : selectedSprintId.value,
      quickFilterIds: kind === "personal" ? [] : [...selectedQuickFilterIds.value],
      assignee: kind === "personal" || !selectedBoardAssignee.value ? null : { ...selectedBoardAssignee.value },
      doneWithinDays: kind === "personal" ? null : doneWithinDays.value,
      ...(kind === "personal" && (nativePersonalScopeConfigured.value || existing?.personalScope !== undefined)
        ? { personalScope: nativePersonalScope.value }
        : {}),
      ...(nativePresentationChoice.value ? { presentation: nativePresentationChoice.value } : {}),
      ...(nativeStatusFilterConfigured.value || existing?.statusFilter !== undefined
        ? { statusFilter: nativeStatusFilter.value }
        : {}),
      ...(projectScopeConfigured.value
        ? { projectKeys: projectScopeChoice.value === null ? null : [...projectScopeChoice.value] }
        : existing?.projectKeys !== undefined
          ? { projectKeys: [...existing.projectKeys] }
          : {}),
    };
  }
  function queueNativeViewSave(view: JiraSavedWorkspaceView, input = workspaceViewInput(view.kind, view.boardName)) {
    if (!props.workspaceId) return;
    input.viewId = view.viewId;
    const signature = `${props.workspaceId}\0${view.viewId}\0${JSON.stringify(input)}`;
    const pendingSignature = vars.pendingNativeViewSave
      ? `${vars.pendingNativeViewSave.workspaceId}\0${vars.pendingNativeViewSave.viewId}\0${JSON.stringify(vars.pendingNativeViewSave.input)}`
      : "";
    if (signature === vars.lastSavedNativeViewSignature || signature === pendingSignature) return;
    vars.pendingNativeViewSave = { workspaceId: props.workspaceId, viewId: view.viewId, input };
    if (vars.workspaceViewSaveTimer) clearTimeout(vars.workspaceViewSaveTimer);
    vars.workspaceViewSaveTimer = setTimeout(() => {
      void flushPendingNativeViewSave();
    }, 250);
  }
  function applyWorkspaceViewsState(state: JiraWorkspaceViewsState) {
    if (state.workspaceId === props.workspaceId) workspaceViewsState.value = state;
  }
  async function saveAndActivateNativeView(input: JiraWorkspaceViewInput) {
    if (!props.workspaceId || !dynamicApi.saveJiraWorkspaceView) return false;
    try {
      workspaceViewSaving.value = true;
      workspaceViewSaveError.value = "";
      const state = await dynamicApi.saveJiraWorkspaceView({ workspaceId: props.workspaceId, view: input });
      applyWorkspaceViewsState(state);
      const savedView = state.views.find(
        (view) =>
          view.kind === input.kind &&
          view.connectionId === input.connectionId &&
          view.boardId === (input.kind === "personal" ? null : input.boardId),
      );
      if (!savedView) throw new Error("The saved Jira view was not returned by the workspace view registry.");
      await nextTick();
      await store.activateView(nativeJiraViewId(savedView.viewId));
      return true;
    } catch (cause) {
      if (!isSupersededActivation(cause))
        reportFailure("Could not open this Jira view as a workspace tab", cause, workspaceViewSaveError);
      return false;
    } finally {
      workspaceViewSaving.value = false;
    }
  }
  async function flushPendingNativeViewSave() {
    if (vars.workspaceViewSaveTimer) clearTimeout(vars.workspaceViewSaveTimer);
    vars.workspaceViewSaveTimer = undefined;
    const pending = vars.pendingNativeViewSave;
    vars.pendingNativeViewSave = null;
    if (!pending || !dynamicApi.saveJiraWorkspaceView) return;
    try {
      await dynamicApi.saveJiraWorkspaceView({ workspaceId: pending.workspaceId, view: pending.input });
      vars.lastSavedNativeViewSignature = `${pending.workspaceId}\0${pending.viewId}\0${JSON.stringify(pending.input)}`;
      if (props.workspaceId === pending.workspaceId && jiraViewId.value === pending.viewId)
        workspaceViewSaveError.value = "";
    } catch (cause) {
      if (props.workspaceId === pending.workspaceId && jiraViewId.value === pending.viewId) {
        reportFailure("Could not save this Jira tab's filters", cause, workspaceViewSaveError);
      }
    }
  }
  async function openSelectedBoardAsNativeTab() {
    if (!canOpenSelectedBoardAsTab.value || !boardId.value) return;
    await saveAndActivateNativeView(workspaceViewInput("board"));
  }
  async function openPinnedBoard(workspaceId: string) {
    boardActionError.value = "";
    try {
      await store.activateWorkspace(workspaceId);
    } catch (cause) {
      if (!isSupersededActivation(cause))
        reportFailure("Could not open the pinned Jira board", cause, boardActionError);
    }
  }
  function onBoardChange() {
    const wasMyIssuesBoard = ownIssuesBoardMode.value;
    ownIssuesBoardMode.value = false;
    const chosenBoard = boards.value.find((board) => board.id === boardId.value);
    boardMode.value = chosenBoard?.type === "scrum" ? "sprints" : "issues";
    selectedSprintId.value = null;
    selectedBoardLabel.value = chosenBoard?.name || "";
    selectedBoardType.value = chosenBoard?.type || "";
    selectedQuickFilterIds.value = [];
    const own = selectedConnection.value?.ownIdentity;
    const ownId = own?.kind === "cloud" ? own.accountId : own?.name;
    selectedBoardAssignee.value =
      wasMyIssuesBoard && own && ownId ? { kind: "user", id: ownId, label: own.displayName } : null;
    assigneeCatalog.value = [];
    rosterStatusKeys.value = new Set();
    assigneeSearchText.value = "";
    assigneeSearchResults.value = [];
    boardIssueDetailOpen.value = false;
    if (jiraViewId.value === "issues" && activeView.value !== "board") activeView.value = "board";
    void loadBoard();
  }
  function onBoardModeChange() {
    if (boardMode.value !== "sprints") selectedSprintId.value = null;
    void loadBoard();
  }
  async function loadBoardQuickFilters(forceRefresh = false): Promise<boolean> {
    if (!connectionId.value || !boardId.value || !dynamicApi.listJiraBoardQuickFilters) {
      boardQuickFilters.value = [];
      return false;
    }
    const requestedConnectionId = connectionId.value;
    const requestedBoardId = boardId.value;
    try {
      const result = await dynamicApi.listJiraBoardQuickFilters({
        connectionId: requestedConnectionId,
        boardId: requestedBoardId,
        limit: 100,
        ...(forceRefresh ? { forceRefresh: true } : {}),
      });
      if (requestedConnectionId !== connectionId.value || requestedBoardId !== boardId.value) return false;
      boardQuickFilters.value = result.filters || [];
      boardQuickFilterError.value = result.cache?.refreshError?.message
        ? `Quick filters were not refreshed: ${result.cache.refreshError.message}`
        : result.cache?.stale
          ? "Quick filters were not refreshed: showing saved filters."
          : "";
      if (!result.cache?.stale && !result.cache?.refreshError && !result.hasMore) {
        const availableIds = new Set(boardQuickFilters.value.map((filter) => filter.id));
        selectedQuickFilterIds.value = selectedQuickFilterIds.value.filter((id) => availableIds.has(id));
      }
      return true;
    } catch (cause) {
      if (requestedConnectionId !== connectionId.value || requestedBoardId !== boardId.value) return false;
      reportFailure("Quick filters were not refreshed", cause, boardQuickFilterError);
      if (!forceRefresh) boardQuickFilters.value = [];
      return false;
    }
  }
  // A board's own Jira filter decides its projects, so the pane's project scope does not narrow it.
  function boardFilterPayload() {
    return {
      ...(selectedQuickFilterIds.value.length ? { quickFilterIds: [...selectedQuickFilterIds.value] } : {}),
      ...(selectedBoardAssignee.value
        ? {
            assignee:
              selectedBoardAssignee.value.kind === "unassigned"
                ? { kind: "unassigned" as const }
                : { kind: "user" as const, id: selectedBoardAssignee.value.id },
          }
        : {}),
      ...(boardMode.value === "issues" && doneWithinDays.value ? { doneWithinDays: doneWithinDays.value } : {}),
    };
  }
  // Keyed by the id the assignee filter matches on: a Data Center user restored from a saved filter carries only its
  // name, the same user from an issue also its key, and keying by the key showed that person twice.
  function mergeAssigneeCatalog(users: JiraUserRef[], replace = false) {
    const catalog = new Map<string, JiraUserRef>();
    const add = (user: JiraUserRef) => {
      const existing = catalog.get(jiraUserIdentity(user));
      catalog.set(jiraUserIdentity(user), existing ? ({ ...user, ...existing } as JiraUserRef) : user);
    };
    if (!replace) assigneeCatalog.value.forEach(add);
    users.forEach(add);
    assigneeCatalog.value = [...catalog.values()].sort((left, right) =>
      left.displayName.localeCompare(right.displayName),
    );
  }
  function collectIssueAssignees(issues: JiraIssue[], replace = false) {
    mergeAssigneeCatalog(
      issues.flatMap((issue) => (issue.assigneeRef ? [issue.assigneeRef] : [])),
      replace,
    );
    const statusKeys = issues.map(nativeIssueStatusKey);
    rosterStatusKeys.value = new Set(replace ? statusKeys : [...rosterStatusKeys.value, ...statusKeys]);
  }
  function toggleQuickFilter(filterId: number) {
    selectedQuickFilterIds.value = selectedQuickFilterIds.value.includes(filterId)
      ? selectedQuickFilterIds.value.filter((id) => id !== filterId)
      : [...selectedQuickFilterIds.value, filterId];
    void loadBoard();
  }
  function onBoardFilterDetailsToggle(event: Event) {
    boardFilterOpenOverride.value = (event.currentTarget as HTMLDetailsElement).open;
  }
  function onBoardFilterDetailsKeydown(event: KeyboardEvent) {
    const details = boardFilterDetailsRef.value;
    if (!details?.open) return;
    if (event.key === "Escape") {
      if (event.target instanceof Element && event.target.closest("details.jira-project-scope-picker[open]")) return;
      event.preventDefault();
      event.stopPropagation();
      boardFilterOpenOverride.value = false;
      details.open = false;
      void nextTick(() => details.querySelector<HTMLElement>("summary")?.focus({ preventScroll: true }));
      return;
    }
    if (event.key !== "Tab" || !window.matchMedia?.("(max-height: 520px)").matches) return;
    const focusable = [
      ...details.querySelectorAll<HTMLElement>(
        'summary, button:not(:disabled), input:not(:disabled):not([type="hidden"]), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex]:not([tabindex="-1"])',
      ),
    ].filter((element) => {
      let parent = element.parentElement;
      while (parent && parent !== details) {
        if (parent instanceof HTMLDetailsElement && !parent.open) return false;
        if (parent.hidden || parent.getAttribute("aria-hidden") === "true") return false;
        parent = parent.parentElement;
      }
      return true;
    });
    const first = focusable[0];
    const last = focusable.at(-1);
    const active = document.activeElement;
    if (event.shiftKey && (active === first || !details.contains(active))) {
      event.preventDefault();
      last?.focus({ preventScroll: true });
    } else if (!event.shiftKey && (active === last || !details.contains(active))) {
      event.preventDefault();
      first?.focus({ preventScroll: true });
    }
  }
  function queueAssigneeSearch() {
    if (vars.assigneeSearchTimer) clearTimeout(vars.assigneeSearchTimer);
    const query = assigneeSearchText.value.trim();
    if (query.length < 1 || !connectionId.value || !dynamicApi.searchJiraUsers) {
      assigneeSearchResults.value = [];
      assigneeSearchLoading.value = false;
      return;
    }
    const generation = ++vars.assigneeSearchGeneration;
    assigneeSearchLoading.value = true;
    assigneeSearchError.value = "";
    const requestedConnectionId = connectionId.value;
    vars.assigneeSearchTimer = setTimeout(async () => {
      try {
        const users = await dynamicApi.searchJiraUsers!({ connectionId: requestedConnectionId, query, limit: 25 });
        if (
          generation === vars.assigneeSearchGeneration &&
          requestedConnectionId === connectionId.value &&
          query === assigneeSearchText.value.trim()
        ) {
          assigneeSearchResults.value = users;
          mergeAssigneeCatalog(users);
        }
      } catch (cause) {
        if (generation === vars.assigneeSearchGeneration) {
          assigneeSearchResults.value = [];
          reportFailure("Could not search Jira users", cause, assigneeSearchError);
        }
      } finally {
        if (generation === vars.assigneeSearchGeneration) assigneeSearchLoading.value = false;
      }
    }, 250);
  }
  function selectBoardAssignee(user: JiraUserRef) {
    selectedBoardAssignee.value = { kind: "user", id: jiraUserIdentity(user), label: user.displayName };
    assigneeSearchText.value = "";
    assigneeSearchResults.value = [];
    void loadBoard();
  }
  async function openMyIssuesBoard() {
    const requestedConnectionId = connectionId.value;
    const connection = selectedConnection.value;
    const requestedProfileId = preferencesProfileId.value;
    const own = connection?.ownIdentity;
    const identityId = own?.kind === "cloud" ? own.accountId : own?.name;
    if (!requestedConnectionId || !connection || !own || !identityId || !dynamicApi.buildJiraOwnIssuesQuery) {
      error.value = "Verify a personal Jira identity before opening My issues on this board.";
      return;
    }
    const generation = ++ownBoardGeneration.value;
    const endBoard = beginBusy("board");
    error.value = "";
    try {
      const query = await dynamicApi.buildJiraOwnIssuesQuery({
        connectionId: requestedConnectionId,
        ...(selectedNativeView.value?.personalScope ? { personalScope: selectedNativeView.value.personalScope } : {}),
        ...ctx.projectScopePayload(),
      });
      if (
        generation !== ownBoardGeneration.value ||
        requestedConnectionId !== connectionId.value ||
        requestedProfileId !== preferencesProfileId.value
      )
        return;
      const identityLabel = query.identityLabel || own.displayName;
      if (dynamicApi.saveJiraWorkspaceView) {
        await saveAndActivateNativeView({
          ...workspaceViewInput("personal", identityLabel),
          boardName: identityLabel,
          title: "My issues",
        });
        return;
      }
      selectedBoardAssignee.value = boardId.value ? { kind: "user", id: identityId, label: identityLabel } : null;
      ownIssuesBoardMode.value = !boardId.value;
      activeView.value = "board";
      if (boardId.value) {
        await loadBoard();
        if (
          generation === ownBoardGeneration.value &&
          requestedConnectionId === connectionId.value &&
          boardViewLoaded.value
        ) {
          if (props.workspaceId)
            restoredPreferences.value = writeLastJiraSearch(requestedProfileId, props.workspaceId, {
              connectionId: requestedConnectionId,
              jql: query.jql,
              kind: "my-issues",
              label: "My issues",
              filterId: null,
            });
          void dynamicApi
            .rememberJiraSearch?.({ connectionId: requestedConnectionId, jql: query.jql, label: "My issues" })
            .catch(() => {});
        }
      } else {
        await ctx.search(query.jql, false, { kind: "my-issues", label: "My issues", ...ctx.projectScopePayload() });
        if (generation === ownBoardGeneration.value && requestedConnectionId === connectionId.value)
          ownSearchIdentityLabel.value = identityLabel;
      }
    } catch (cause) {
      if (generation === ownBoardGeneration.value && requestedConnectionId === connectionId.value) {
        reportFailure("Could not open My issues", cause);
      }
    } finally {
      endBoard();
      if (!isBusy("board")) boardLoading.value = false;
    }
  }
  function selectUnassignedAssignee() {
    selectedBoardAssignee.value = { kind: "unassigned", label: "Unassigned" };
    assigneeSearchText.value = "";
    assigneeSearchResults.value = [];
    void loadBoard();
  }
  function clearBoardAssignee() {
    selectedBoardAssignee.value = null;
    void loadBoard();
  }
  function chooseFirstAssigneeResult() {
    const first = assigneeSearchResults.value[0];
    if (first) selectBoardAssignee(first);
  }
  async function loadBoard() {
    if (!connectionId.value || !boardId.value) return ctx.search();
    vars.issueOpenGeneration++;
    ctx.issueLoading.value = false;
    ctx.issuePendingKey.value = "";
    dismissIssuePreview();
    const selectedBoardTypeValue = selectedBoard.value?.type;
    if (selectedBoardTypeValue && selectedBoardTypeValue !== "scrum") boardMode.value = "issues";
    const quickFilterBoardKey = `${connectionId.value}:${boardId.value}`;
    const boardChanged = vars.loadedQuickFilterBoardKey !== quickFilterBoardKey;
    if (boardChanged) {
      vars.loadedQuickFilterBoardKey = quickFilterBoardKey;
      void loadBoardQuickFilters();
    }
    vars.allSearchGeneration++;
    ctx.searchRefreshing.value = false;
    ownIssueSearchGeneration.value++;
    const generation = ++boardLoadGeneration.value;
    sprintLoadGeneration.value++;
    const requestedConnectionId = connectionId.value;
    const requestedBoardId = boardId.value;
    const requestedMode = boardMode.value;
    const requestPayload = {
      connectionId: requestedConnectionId,
      boardId: requestedBoardId,
      mode: requestedMode,
      ...(requestedMode === "sprints" && selectedSprintId.value ? { sprintId: selectedSprintId.value } : {}),
      ...boardFilterPayload(),
    };
    boardViewLoaded.value = false;
    let appliedResult = false;
    boardRefreshError.value = "";
    boardPageCacheMetadata.value = [null];
    sprintMetadataPageCacheMetadata.value = [null];
    sprintIssuePageCacheMetadata.value = [null];
    const endBoard = beginBusy("board");
    boardLoading.value = true;
    error.value = "";
    boardCapability.value = "";
    boardPageCursor.value = "";
    boardPageCursors.value = [undefined];
    boardHasMore.value = false;
    boardPageTruncated.value = false;
    sprintsPageCursor.value = "";
    sprintMetadataPageCursors.value = [undefined];
    sprintsHasMore.value = false;
    if (boardChanged) sprintIssues.value = [];
    sprintIssuesCursor.value = "";
    sprintIssuePageCursors.value = [undefined];
    sprintIssuesHasMore.value = false;
    sprintIssuesTruncated.value = false;
    selected.value = null;
    boardIssueDetailOpen.value = false;
    // A saved board tab gets a new filter's issues only from its background sync, so narrow what is already loaded
    // right away instead of showing everyone's issues under the chosen person until then.
    const assignee = selectedBoardAssignee.value;
    if (assignee) {
      const matches = (issue: JiraIssue) =>
        assignee.kind === "unassigned"
          ? !issue.assigneeRef && !issue.assignee
          : !!issue.assigneeRef && jiraUserIdentity(issue.assigneeRef) === assignee.id;
      issues.value = issues.value.filter(matches);
      sprintIssues.value = sprintIssues.value.filter(matches);
    }
    try {
      const cacheOnlyRead = dynamicApi.getJiraBoardView;
      const cached = cacheOnlyRead ? await cacheOnlyRead({ ...requestPayload, cacheOnly: true }) : null;
      if (cached && isCurrentBoardRequest(generation, requestedConnectionId, requestedBoardId, requestedMode)) {
        applyBoardViewResult(cached, generation, requestedConnectionId, requestedBoardId, requestedMode);
        appliedResult = true;
      }
      if (!isCurrentBoardRequest(generation, requestedConnectionId, requestedBoardId, requestedMode)) return;
      if (jiraViewId.value !== "issues") {
        return;
      }
      if (!dynamicApi.getJiraBoardView) throw new Error("Jira board view is unavailable.");
      const refreshed = await dynamicApi.getJiraBoardView({ ...requestPayload, forceRefresh: true });
      if (refreshed && isCurrentBoardRequest(generation, requestedConnectionId, requestedBoardId, requestedMode)) {
        applyBoardViewResult(refreshed, generation, requestedConnectionId, requestedBoardId, requestedMode);
        appliedResult = true;
      }
    } catch (cause) {
      if (isCurrentBoardRequest(generation, requestedConnectionId, requestedBoardId, requestedMode)) {
        if (isJiraAccessFailure(cause)) {
          issues.value = [];
          sprintIssues.value = [];
          boardColumns.value = [];
          boardCache.value = null;
          boardViewLoaded.value = false;
          boardHasMore.value = false;
          sprintIssuesHasMore.value = false;
          selected.value = null;
          boardIssueDetailOpen.value = false;
          boardRefreshError.value = "";
          reportFailure("Jira access is no longer available", cause);
        } else if (appliedResult && boardCache.value) {
          const prior = boardCache.value as JiraCacheMetadata;
          boardCache.value = {
            ...prior,
            stale: true,
            refreshError: {
              code: "refresh-failed",
              message: reportFailureText("Could not refresh the Jira board", cause),
            },
          };
          boardRefreshError.value = "";
        } else {
          boardRefreshError.value = reportFailureText("Could not load the Jira board", cause);
        }
      }
    } finally {
      endBoard();
      if (!isBusy("board")) boardLoading.value = false;
    }
    if (boardMode.value === "sprints" && selectedSprintId.value) await loadSelectedSprintIssues();
  }
  async function refreshNativeBoardFromCache() {
    if (jiraViewId.value === "issues" || !connectionId.value) return;
    const requestedViewId = jiraViewId.value;
    const requestedConnectionId = connectionId.value;
    const requestedProfileId = preferencesProfileId.value;
    if (selectedNativeView.value?.kind === "personal") {
      const generation = ++vars.allSearchGeneration;
      try {
        const query = await dynamicApi.buildJiraOwnIssuesQuery?.({
          connectionId: requestedConnectionId,
          personalScope: selectedNativeView.value.personalScope ?? "open",
          ...ctx.projectScopePayload(),
        });
        if (!query) return;
        const cached = await ctx.requestSearchPage({
          connectionId: requestedConnectionId,
          jql: query.jql,
          limit: 50,
          cacheOnly: true,
          ...ctx.projectScopePayload(),
        });
        if (
          !cached ||
          generation !== vars.allSearchGeneration ||
          requestedViewId !== jiraViewId.value ||
          requestedConnectionId !== connectionId.value ||
          requestedProfileId !== preferencesProfileId.value
        )
          return;
        ctx.activeSearchJql.value = query.jql;
        ownSearchIdentityLabel.value = query.identityLabel;
        ctx.applySearchPage(cached, true);
        if (selected.value) {
          const refreshedSelection = issues.value.find((issue) => issue.ref?.issueId === selected.value?.ref?.issueId);
          if (refreshedSelection) selected.value = refreshedSelection;
        }
      } catch (cause) {
        if (
          generation === vars.allSearchGeneration &&
          requestedViewId === jiraViewId.value &&
          requestedConnectionId === connectionId.value &&
          requestedProfileId === preferencesProfileId.value
        ) {
          boardRefreshError.value = reportFailureText(
            "Could not load the synchronized Jira personal issue snapshot",
            cause,
          );
        }
      }
      return;
    }
    if (!boardId.value || !dynamicApi.getJiraBoardView) return;
    const requestedBoardId = boardId.value;
    const requestedMode = boardMode.value;
    const generation = boardLoadGeneration.value;
    try {
      const cached = await dynamicApi.getJiraBoardView({
        connectionId: requestedConnectionId,
        boardId: requestedBoardId,
        mode: requestedMode,
        ...(requestedMode === "sprints" && selectedSprintId.value ? { sprintId: selectedSprintId.value } : {}),
        ...boardFilterPayload(),
        cacheOnly: true,
      });
      if (
        !cached ||
        generation !== boardLoadGeneration.value ||
        requestedViewId !== jiraViewId.value ||
        requestedConnectionId !== connectionId.value ||
        requestedBoardId !== boardId.value ||
        requestedMode !== boardMode.value
      )
        return;
      applyBoardViewResult(cached, generation, requestedConnectionId, requestedBoardId, requestedMode);
    } catch (cause) {
      if (
        generation === boardLoadGeneration.value &&
        requestedViewId === jiraViewId.value &&
        requestedConnectionId === connectionId.value &&
        requestedProfileId === preferencesProfileId.value
      ) {
        boardRefreshError.value = reportFailureText("Could not load the synchronized Jira board snapshot", cause);
      }
    }
  }
  function isCurrentBoardRequest(
    generation: number,
    requestedConnectionId: string,
    requestedBoardId: number,
    mode: string,
  ) {
    return (
      generation === boardLoadGeneration.value &&
      requestedConnectionId === connectionId.value &&
      requestedBoardId === boardId.value &&
      mode === boardMode.value
    );
  }
  function applyBoardViewResult(
    result: JiraBoardViewResult,
    generation: number,
    requestedConnectionId: string,
    requestedBoardId: number,
    mode: "issues" | "backlog" | "sprints",
  ) {
    if (!isCurrentBoardRequest(generation, requestedConnectionId, requestedBoardId, mode)) return;
    issues.value = result.issues || [];
    boardCapability.value = result.capability || "";
    boardCapabilities.value = result.capabilities || {};
    boardFilter.value = result.filter || null;
    boardOwner.value = result.owner || null;
    boardColumns.value = result.columns || [];
    boardViewLoaded.value = true;
    boardRefreshError.value = "";
    const pageMetadata = result.cache || null;
    if (mode === "sprints") {
      sprintMetadataPageCacheMetadata.value = [pageMetadata];
      boardCache.value = aggregateCacheMetadata(sprintMetadataPageCacheMetadata.value);
      sprintIssues.value = result.issues || [];
      sprintIssuesCursor.value = result.nextCursor || "";
      sprintIssuesHasMore.value = result.hasMore === true && !!result.nextCursor;
      sprintIssuesTruncated.value = result.truncated === true;
      sprintIssuePageCacheMetadata.value = [pageMetadata];
    } else {
      boardPageCacheMetadata.value = [pageMetadata];
      boardCache.value = aggregateCacheMetadata(boardPageCacheMetadata.value);
    }
    if (!selectedQuickFilterIds.value.length && !selectedBoardAssignee.value)
      collectIssueAssignees(result.issues || [], true);
    if (result.sprints) boardSprints.value = result.sprints;
    if (mode === "sprints") {
      sprintsPageCursor.value = result.sprintsNextCursor || "";
      sprintsHasMore.value = result.sprintsHasMore === true && !!result.sprintsNextCursor;
      boardPageCursor.value = sprintsPageCursor.value;
      boardHasMore.value = sprintsHasMore.value;
      if (
        !selectedSprintId.value ||
        !boardSprints.value.some((sprint) => Number(sprint.id) === selectedSprintId.value)
      ) {
        const preferredSprint = boardSprints.value.find((sprint) => sprint.state === "active");
        if (!selectedSprintId.value) selectedSprintId.value = preferredSprint ? Number(preferredSprint.id) : null;
      }
    } else {
      selectedSprintId.value = null;
      sprintIssues.value = [];
      boardPageCursor.value = result.nextCursor || "";
      boardHasMore.value = result.hasMore === true && !!result.nextCursor;
    }
    boardPageTruncated.value = result.truncated === true;
  }
  async function refreshBoardSnapshot() {
    if (!connectionId.value || !boardId.value || boardRefreshing.value || !dynamicApi.getJiraBoardView) return;
    const generation = ++vars.boardRefreshGeneration;
    const loadGeneration = boardLoadGeneration.value;
    const requestedConnectionId = connectionId.value;
    const requestedBoardId = boardId.value;
    const mode = boardMode.value;
    const requestedSprintId = mode === "sprints" ? selectedSprintId.value : null;
    const filters = boardFilterPayload();
    const pageCursors =
      mode === "sprints"
        ? requestedSprintId
          ? [...sprintIssuePageCursors.value]
          : [...sprintMetadataPageCursors.value]
        : [...boardPageCursors.value];
    const pageLimit = pageCursors.length;
    const basePayload = {
      connectionId: requestedConnectionId,
      boardId: requestedBoardId,
      mode,
      ...(requestedSprintId ? { sprintId: requestedSprintId } : {}),
      ...filters,
    };
    boardRefreshing.value = true;
    try {
      const refreshedPages: JiraBoardViewResult[] = [];
      const refreshedCursors: Array<string | undefined> = [];
      let requestCursor: string | undefined;
      for (let pageIndex = 0; pageIndex < pageLimit; pageIndex++) {
        const result = await dynamicApi.getJiraBoardView({
          ...basePayload,
          ...(requestCursor ? { cursor: requestCursor } : {}),
          forceRefresh: true,
        });
        if (!result) throw new Error("Jira did not return the refreshed board page.");
        if (result.cache?.stale || result.cache?.refreshError)
          throw new Error(result.cache.refreshError?.message || "Jira returned a stale board page.");
        refreshedPages.push(result);
        refreshedCursors.push(requestCursor);
        const more = requestedSprintId
          ? result.hasMore === true && !!result.nextCursor
          : mode === "sprints"
            ? result.sprintsHasMore === true && !!result.sprintsNextCursor
            : result.hasMore === true && !!result.nextCursor;
        if (!more) break;
        requestCursor = requestedSprintId
          ? result.nextCursor
          : mode === "sprints"
            ? result.sprintsNextCursor
            : result.nextCursor;
      }
      if (
        generation !== vars.boardRefreshGeneration ||
        loadGeneration !== boardLoadGeneration.value ||
        requestedConnectionId !== connectionId.value ||
        requestedBoardId !== boardId.value ||
        mode !== boardMode.value ||
        requestedSprintId !== (mode === "sprints" ? selectedSprintId.value : null)
      )
        return;
      const lastPage = refreshedPages[refreshedPages.length - 1];
      if (!lastPage) return;
      if (requestedSprintId) {
        sprintIssues.value = refreshedPages.flatMap((page) => page.issues || []);
        sprintIssuePageCursors.value = refreshedCursors;
        sprintIssuePageCacheMetadata.value = refreshedPages.map((page) => page.cache || null);
        sprintIssuesCursor.value = lastPage.nextCursor || "";
        sprintIssuesHasMore.value = lastPage.hasMore === true && !!lastPage.nextCursor;
        sprintIssuesTruncated.value = lastPage.truncated === true;
      } else if (mode === "sprints") {
        boardSprints.value = refreshedPages.flatMap((page) => page.sprints || []);
        sprintMetadataPageCursors.value = refreshedCursors;
        sprintMetadataPageCacheMetadata.value = refreshedPages.map((page) => page.cache || null);
        sprintsPageCursor.value = lastPage.sprintsNextCursor || "";
        sprintsHasMore.value = lastPage.sprintsHasMore === true && !!lastPage.sprintsNextCursor;
        boardPageCursor.value = sprintsPageCursor.value;
        boardHasMore.value = sprintsHasMore.value;
      } else {
        issues.value = refreshedPages.flatMap((page) => page.issues || []);
        boardPageCursors.value = refreshedCursors;
        boardPageCacheMetadata.value = refreshedPages.map((page) => page.cache || null);
        boardPageCursor.value = lastPage.nextCursor || "";
        boardHasMore.value = lastPage.hasMore === true && !!lastPage.nextCursor;
        boardPageTruncated.value = lastPage.truncated === true;
      }
      if (!filters.quickFilterIds?.length && !filters.assignee)
        collectIssueAssignees(
          refreshedPages.flatMap((page) => page.issues || []),
          true,
        );
      if (lastPage.columns) boardColumns.value = lastPage.columns;
      if (lastPage.capabilities) boardCapabilities.value = lastPage.capabilities;
      boardCache.value = aggregateCacheMetadata(
        requestedSprintId
          ? sprintIssuePageCacheMetadata.value
          : mode === "sprints"
            ? sprintMetadataPageCacheMetadata.value
            : boardPageCacheMetadata.value,
      );
      boardRefreshError.value = "";
      boardViewLoaded.value = true;
    } catch (cause) {
      if (generation === vars.boardRefreshGeneration && loadGeneration === boardLoadGeneration.value) {
        if (isJiraAccessFailure(cause)) {
          issues.value = [];
          sprintIssues.value = [];
          boardCache.value = null;
          boardViewLoaded.value = false;
          boardHasMore.value = false;
          sprintIssuesHasMore.value = false;
          boardIssueDetailOpen.value = false;
          selected.value = null;
          reportFailure("Jira access is no longer available", cause);
          return;
        }
        const prior = boardCache.value;
        if (prior) {
          boardCache.value = {
            ...prior,
            stale: true,
            refreshError: { code: "refresh-failed", message: reportFailureText("Refresh failed", cause) },
          };
          boardRefreshError.value = "";
        } else {
          boardRefreshError.value = reportFailureText("Refresh failed", cause);
        }
      }
    } finally {
      if (generation === vars.boardRefreshGeneration) boardRefreshing.value = false;
    }
  }
  async function loadMoreBoard() {
    if (
      !connectionId.value ||
      !boardId.value ||
      !boardHasMore.value ||
      !boardPageCursor.value ||
      isBusy("board", "board-more")
    )
      return;
    const generation = boardLoadGeneration.value;
    const requestedConnectionId = connectionId.value;
    const requestedBoardId = boardId.value;
    const requestedMode = boardMode.value;
    const requestedCursor = boardPageCursor.value;
    const endMore = beginBusy("board-more");
    try {
      const result = (await api.getJiraBoardView({
        connectionId: requestedConnectionId,
        boardId: requestedBoardId,
        mode: requestedMode,
        cursor: requestedCursor,
        ...boardFilterPayload(),
      })) as {
        issues: JiraIssue[];
        sprints?: JiraSprint[];
        hasMore?: boolean;
        nextCursor?: string;
        truncated?: boolean;
        sprintsHasMore?: boolean;
        sprintsNextCursor?: string;
        cache?: JiraCacheMetadata;
      };
      if (
        generation !== boardLoadGeneration.value ||
        requestedConnectionId !== connectionId.value ||
        requestedBoardId !== boardId.value ||
        requestedMode !== boardMode.value
      )
        return;
      if (requestedMode === "sprints") {
        if (result.sprints) {
          const seenSprints = new Set(boardSprints.value.map((sprint) => sprint.id));
          const newSprints = result.sprints.filter((sprint) => {
            if (seenSprints.has(sprint.id)) return false;
            seenSprints.add(sprint.id);
            return true;
          });
          boardSprints.value = [...boardSprints.value, ...newSprints];
        }
        sprintsPageCursor.value = result.sprintsNextCursor || "";
        sprintsHasMore.value = result.sprintsHasMore === true && !!result.sprintsNextCursor;
        boardPageCursor.value = sprintsPageCursor.value;
        sprintMetadataPageCursors.value = [...sprintMetadataPageCursors.value, boardPageCursor.value];
        sprintMetadataPageCacheMetadata.value = [...sprintMetadataPageCacheMetadata.value, result.cache || null];
        if (!selectedQuickFilterIds.value.length && !selectedBoardAssignee.value)
          collectIssueAssignees(result.issues || []);
        boardHasMore.value = sprintsHasMore.value;
      } else {
        issues.value = [...issues.value, ...(result.issues || [])];
        boardPageCursor.value = result.nextCursor || "";
        boardPageCursors.value = [...boardPageCursors.value, requestedCursor];
        boardPageCacheMetadata.value = [...boardPageCacheMetadata.value, result.cache || null];
        if (!selectedQuickFilterIds.value.length && !selectedBoardAssignee.value)
          collectIssueAssignees(result.issues || []);
        boardHasMore.value = result.hasMore === true && !!result.nextCursor;
        boardPageTruncated.value = result.truncated === true;
      }
      boardCache.value = aggregateCacheMetadata(
        requestedMode === "sprints" ? sprintMetadataPageCacheMetadata.value : boardPageCacheMetadata.value,
      );
    } catch (cause) {
      if (generation === boardLoadGeneration.value) reportFailure("Could not load more board results", cause);
    } finally {
      endMore();
    }
  }
  async function loadSelectedSprintIssues() {
    if (!connectionId.value || !boardId.value || !selectedSprintId.value || boardMode.value !== "sprints") return;
    const generation = ++sprintLoadGeneration.value;
    const requestedConnectionId = connectionId.value;
    const requestedBoardId = boardId.value;
    const requestedSprintId = selectedSprintId.value;
    sprintIssuesCursor.value = "";
    sprintIssuePageCursors.value = [undefined];
    sprintIssuesHasMore.value = false;
    sprintIssuesTruncated.value = false;
    const endSprint = beginBusy("sprint");
    try {
      const result = (await api.getJiraBoardView({
        connectionId: requestedConnectionId,
        boardId: requestedBoardId,
        mode: "sprints",
        sprintId: requestedSprintId,
        ...boardFilterPayload(),
      })) as {
        issues: JiraIssue[];
        columns?: JiraColumn[];
        capabilities?: JiraBoardCapabilities;
        capability?: string;
        hasMore?: boolean;
        nextCursor?: string;
        truncated?: boolean;
        cache?: JiraCacheMetadata;
      };
      if (
        generation !== sprintLoadGeneration.value ||
        requestedConnectionId !== connectionId.value ||
        requestedBoardId !== boardId.value ||
        requestedSprintId !== selectedSprintId.value
      )
        return;
      sprintIssues.value = result.issues || [];
      if (!selectedQuickFilterIds.value.length && !selectedBoardAssignee.value)
        collectIssueAssignees(result.issues || []);
      sprintIssuePageCacheMetadata.value = [result.cache || null];
      boardCache.value = aggregateCacheMetadata(sprintIssuePageCacheMetadata.value);
      if (result.columns) boardColumns.value = result.columns;
      sprintIssuesCursor.value = result.nextCursor || "";
      sprintIssuesHasMore.value = result.hasMore === true && !!result.nextCursor;
      sprintIssuesTruncated.value = result.truncated === true;
      if (result.capabilities) boardCapabilities.value = result.capabilities;
      boardCapability.value = result.capability || boardCapability.value;
    } catch (cause) {
      if (
        generation === sprintLoadGeneration.value &&
        requestedConnectionId === connectionId.value &&
        requestedBoardId === boardId.value &&
        requestedSprintId === selectedSprintId.value
      ) {
        sprintIssues.value = [];
        reportFailure("Could not load issues for this sprint", cause);
      }
    } finally {
      endSprint();
    }
  }
  async function loadMoreSprintIssues() {
    if (
      !selectedSprintId.value ||
      !sprintIssuesHasMore.value ||
      !sprintIssuesCursor.value ||
      isBusy("sprint", "sprint-more")
    )
      return;
    const generation = ++sprintLoadGeneration.value;
    const requestedConnectionId = connectionId.value;
    const requestedBoardId = boardId.value;
    const requestedSprintId = selectedSprintId.value;
    const requestedCursor = sprintIssuesCursor.value;
    const endMore = beginBusy("sprint-more");
    try {
      const result = (await api.getJiraBoardView({
        connectionId: requestedConnectionId,
        boardId: requestedBoardId,
        mode: "sprints",
        sprintId: requestedSprintId,
        cursor: requestedCursor,
        ...boardFilterPayload(),
      })) as {
        issues: JiraIssue[];
        hasMore?: boolean;
        nextCursor?: string;
        truncated?: boolean;
        cache?: JiraCacheMetadata;
      };
      if (
        generation !== sprintLoadGeneration.value ||
        requestedConnectionId !== connectionId.value ||
        requestedBoardId !== boardId.value ||
        requestedSprintId !== selectedSprintId.value ||
        boardMode.value !== "sprints"
      )
        return;
      sprintIssues.value = [...sprintIssues.value, ...(result.issues || [])];
      sprintIssuesCursor.value = result.nextCursor || "";
      sprintIssuePageCursors.value = [...sprintIssuePageCursors.value, requestedCursor];
      sprintIssuePageCacheMetadata.value = [...sprintIssuePageCacheMetadata.value, result.cache || null];
      boardCache.value = aggregateCacheMetadata(sprintIssuePageCacheMetadata.value);
      sprintIssuesHasMore.value = result.hasMore === true && !!result.nextCursor;
      sprintIssuesTruncated.value = result.truncated === true;
    } catch (cause) {
      if (
        generation === sprintLoadGeneration.value &&
        requestedConnectionId === connectionId.value &&
        requestedBoardId === boardId.value &&
        requestedSprintId === selectedSprintId.value
      )
        reportFailure("Could not load more issues for this sprint", cause);
    } finally {
      endMore();
    }
  }
  const boardColumnViews = computed(() =>
    boardColumns.value.map((column) => {
      const statusNames = column.statuses.map((boardStatus) => boardStatus.name).filter(Boolean);
      const columnName = column.name.trim().toLowerCase();
      return {
        name: column.name,
        statusNames,
        extraStatuses:
          statusNames.length > 1 || (statusNames[0] && statusNames[0].trim().toLowerCase() !== columnName)
            ? statusNames
            : [],
        tone: jiraStatusTone(column.name) as JiraStatusTone,
        issues: issuesForColumn(column),
      };
    }),
  );
  const nativeIssueSource = computed(() =>
    boardMode.value === "sprints" && selectedSprintId.value ? sprintIssues.value : issues.value,
  );
  function nativeIssueStatusKey(issue: JiraIssue): string {
    const statusId = issue.statusId?.trim();
    if (statusId) return `id:${statusId}`;
    return `name:${(issue.status || "Unknown status").trim().toLocaleLowerCase()}`;
  }
  const nativeStatusOptions = computed(() => {
    const definitions = new Map<string, { label: string; tone: string }>();
    for (const column of boardColumns.value) {
      for (const status of column.statuses) {
        const name = status.name?.trim();
        if (!name) continue;
        const key = status.id ? `id:${String(status.id)}` : `name:${name.toLocaleLowerCase()}`;
        if (!definitions.has(key)) definitions.set(key, { label: name, tone: jiraStatusTone(name) });
      }
    }
    for (const issue of nativeIssueSource.value) {
      const key = nativeIssueStatusKey(issue);
      if (!definitions.has(key)) {
        const label = issue.status?.trim() || "Unknown status";
        definitions.set(key, { label, tone: jiraStatusTone(label, issue.statusCategory) });
      }
    }
    const options = [
      { key: null, label: "All", tone: undefined, count: nativeIssueSource.value.length },
      ...[...definitions]
        .map(([key, status]) => ({
          key,
          ...status,
          count: nativeIssueSource.value.filter((issue) => nativeIssueStatusKey(issue) === key).length,
        }))
        .filter(
          (option) =>
            option.count > 0 || rosterStatusKeys.value.has(option.key) || option.key === nativeStatusFilter.value,
        ),
    ];
    if (nativeStatusFilter.value && !definitions.has(nativeStatusFilter.value)) {
      options.push({ key: nativeStatusFilter.value, label: "Saved status", tone: "unknown", count: 0 });
    }
    return options;
  });
  const nativeStatusSelectValue = computed({
    get: () => nativeStatusFilter.value || "__all__",
    set: (value: string | number | null) => selectNativeStatusFilter(value === "__all__" ? null : String(value)),
  });
  const nativeStatusSelectOptions = computed(() =>
    nativeStatusOptions.value.map((option) => ({
      value: option.key || "__all__",
      label: `${option.label} · ${option.count}`,
    })),
  );
  const nativeStatusFilteredIssues = computed(() =>
    nativeStatusFilter.value
      ? nativeIssueSource.value.filter((issue) => nativeIssueStatusKey(issue) === nativeStatusFilter.value)
      : nativeIssueSource.value,
  );
  const nativeVisibleIssues = computed(() =>
    sortJiraIssues(filterJiraIssues(nativeStatusFilteredIssues.value, issueFilterText.value, "all"), issueSort.value),
  );
  function nativeIssueKey(issue: JiraIssue) {
    return `${issue.ref.connectionId}:${issue.ref.issueId}`;
  }
  function selectNativePresentation(presentation: "board" | "list") {
    captureNativePresentationScroll(nativeListPresentation.value ? "list" : "board");
    nativePresentationChoice.value = presentation;
    restoreNativePresentationScroll(presentation);
    if (presentation === "board" && isCompactPane.value && !nativeStatusFilter.value) {
      const firstStatus = nativeStatusOptions.value.find((option) => option.key !== null);
      if (firstStatus) selectNativeStatusFilter(firstStatus.key);
    }
  }
  function selectNativeStatusFilter(status: string | null) {
    nativeStatusFilterConfigured.value = true;
    nativeStatusFilter.value = status;
  }
  function clearNativeIssueFilter() {
    issueFilterText.value = "";
    selectNativeStatusFilter(null);
  }
  const nativeBoardColumnViews = computed(() => {
    if (!isNativeSavedView.value) return boardColumnViews.value;
    if (isCompactPane.value || nativeStatusFilter.value) {
      const selectedOption = nativeStatusOptions.value.find((option) => option.key === nativeStatusFilter.value);
      return [
        {
          name: selectedOption?.label || "All issues",
          statusNames: selectedOption?.key ? [selectedOption.label] : [],
          extraStatuses: [],
          tone: selectedOption?.tone || "progress",
          issues: nativeVisibleIssues.value,
        },
      ];
    }
    if (issueFilterText.value.trim()) {
      const visibleKeys = new Set(nativeVisibleIssues.value.map(nativeIssueKey));
      return boardColumnViews.value.map((column) => ({
        ...column,
        issues: column.issues.filter((issue) => visibleKeys.has(nativeIssueKey(issue))),
      }));
    }
    return boardColumnViews.value;
  });
  function ownIssueStatusCategory(issue: JiraIssue): "new" | "indeterminate" | "done" {
    if (issue.statusCategory) return issue.statusCategory;
    const tone = jiraStatusTone(issue.status);
    return tone === "done"
      ? "done"
      : tone === "progress" || tone === "review" || tone === "testing"
        ? "indeterminate"
        : "new";
  }
  function updateNoBoardSearchColumns() {
    const categories = [
      { id: "new", name: "To do", tone: "todo" },
      { id: "indeterminate", name: "In progress", tone: "progress" },
      { id: "done", name: "Done", tone: "done" },
    ] as const;
    const statuses = new Map(
      categories.map((category) => [category.id, new Map<string, { id: string; name: string }>()]),
    );
    for (const issue of issues.value) {
      const name = issue.status?.trim();
      if (!name) continue;
      const category = ownIssueStatusCategory(issue);
      const id = issue.statusId || name.toLocaleLowerCase();
      statuses.get(category)?.set(id, { id, name });
    }
    boardColumns.value = categories.map((category) => ({
      name: category.name,
      statuses: [...(statuses.get(category.id)?.values() || [])],
    }));
    boardMode.value = "issues";
    boardViewLoaded.value = true;
    boardCache.value = searchCache.value;
    boardRefreshError.value = searchCache.value?.refreshError?.message || "";
  }
  /** A label every card carries (often the board's own filter label) tells nothing; keep only distinguishing ones. */
  const boardSharedLabels = computed(() => {
    const visible = boardMode.value === "sprints" && selectedSprintId.value ? sprintIssues.value : issues.value;
    if (visible.length < 2) return new Set<string>();
    const [first, ...rest] = visible;
    return new Set((first?.labels || []).filter((label) => rest.every((issue) => issue.labels?.includes(label))));
  });
  function cardLabels(issue: JiraIssue) {
    return (issue.labels || []).filter((label) => !boardSharedLabels.value.has(label));
  }
  function issuesForColumn(column: JiraColumn) {
    const visibleIssues = boardMode.value === "sprints" && selectedSprintId.value ? sprintIssues.value : issues.value;
    const ids = new Set(column.statuses.map((boardStatus) => String(boardStatus.id)));
    const names = new Set(
      column.statuses
        .map((boardStatus) =>
          String(boardStatus.name || "")
            .trim()
            .toLowerCase(),
        )
        .filter(Boolean),
    );
    return visibleIssues.filter((issue) => {
      if (issue.statusId) return ids.has(String(issue.statusId));
      return names.has(
        String(issue.status || "")
          .trim()
          .toLowerCase(),
      );
    });
  }
  const unmappedBoardIssues = computed(() =>
    (boardMode.value === "sprints" && selectedSprintId.value ? sprintIssues.value : issues.value).filter(
      (issue) => !boardColumns.value.some((column) => issuesForColumn(column).includes(issue)),
    ),
  );
  function captureNativePresentationScroll(presentation: "list" | "board") {
    if (presentation === "list") {
      if (nativeIssueListRef.value) nativeIssueListScrollTop.value = nativeIssueListRef.value.scrollTop;
      return;
    }
    const root = jiraRootRef.value;
    const columns = root?.querySelector<HTMLElement>(".jira-board-columns");
    if (!columns) return;
    nativeBoardScrollLeft.value = columns.scrollLeft;
    vars.nativeBoardScrollTop = columns.scrollTop;
    const cards = new Map<string, number>();
    for (const region of columns.querySelectorAll<HTMLElement>(".jira-board-column__cards")) {
      const label = region.getAttribute("aria-label");
      if (label) cards.set(label, region.scrollTop);
    }
    vars.nativeBoardCardsScrollTop = cards;
  }
  function rememberNativeListScroll(event: Event) {
    if (event.currentTarget instanceof HTMLElement) nativeIssueListScrollTop.value = event.currentTarget.scrollTop;
  }
  function rememberNativeBoardHorizontalScroll(event: Event) {
    if (!(event.currentTarget instanceof HTMLElement)) return;
    nativeBoardScrollLeft.value = event.currentTarget.scrollLeft;
    vars.nativeBoardScrollTop = event.currentTarget.scrollTop;
  }
  function rememberNativeBoardCardsScroll(event: Event) {
    if (!(event.currentTarget instanceof HTMLElement)) return;
    const label = event.currentTarget.getAttribute("aria-label");
    if (label) vars.nativeBoardCardsScrollTop.set(label, event.currentTarget.scrollTop);
  }
  function restoreNativePresentationScroll(presentation: "list" | "board", focusIssue = false) {
    void nextTick(() => {
      if (presentation === "list") {
        const list = nativeIssueListRef.value;
        if (!list) return;
        list.scrollTop = nativeIssueListScrollTop.value;
        if (focusIssue) {
          const issueButton = [...list.querySelectorAll<HTMLButtonElement>(".jira-native-issue-list__item")].find(
            (button) => button.dataset.issueId === issueReturnNativeIssueId.value,
          );
          if (issueButton) issueButton.focus({ preventScroll: true });
          else list.focus({ preventScroll: true });
        }
        return;
      }
      const columns = jiraRootRef.value?.querySelector<HTMLElement>(".jira-board-columns");
      if (!columns) return;
      columns.scrollLeft = nativeBoardScrollLeft.value;
      columns.scrollTop = vars.nativeBoardScrollTop;
      for (const region of columns.querySelectorAll<HTMLElement>(".jira-board-column__cards")) {
        const label = region.getAttribute("aria-label");
        if (label && vars.nativeBoardCardsScrollTop.has(label))
          region.scrollTop = vars.nativeBoardCardsScrollTop.get(label) || 0;
      }
      if (focusIssue) {
        const issueButton = [...columns.querySelectorAll<HTMLButtonElement>(".jira-board-issue")].find(
          (button) => button.dataset.issueId === issueReturnNativeIssueId.value,
        );
        if (issueButton) issueButton.focus({ preventScroll: true });
        else columns.querySelector<HTMLElement>(".jira-board-column__cards")?.focus({ preventScroll: true });
      }
    });
  }
  return {
    workspaceViewsState,
    workspaceViewRestored,
    workspaceViewRestoredId,
    workspaceViewSaving,
    workspaceViewSaveError,
    nativePresentationChoice,
    nativeStatusFilter,
    nativeStatusFilterConfigured,
    nativePersonalScope,
    nativePersonalScopeConfigured,
    nativePersonalScopeChoice,
    workspaceViews,
    selectedNativeView,
    isNativeSavedView,
    nativePresentation,
    nativeListPresentation,
    nativeViewSync,
    nativeIssueListScrollTop,
    nativeBoardScrollLeft,
    boardViewLoaded,
    boardLoadGeneration,
    sprintLoadGeneration,
    ownIssueSearchGeneration,
    ownBoardGeneration,
    boardsLoading,
    boardFilterDetailsRef,
    boardFilterOpenOverride,
    boardQuickFilters,
    boardFilterDetailsOpen,
    assigneeCatalog,
    assigneeSearchText,
    assigneeSearchResults,
    assigneeSearchLoading,
    boardLoading,
    boardRefreshing,
    boardCache,
    boardRefreshError,
    boardQuickFilterError,
    boardActionError,
    assigneeSearchError,
    boardPageCacheMetadata,
    sprintMetadataPageCacheMetadata,
    sprintIssuePageCacheMetadata,
    boardCapability,
    boardFilter,
    boardOwner,
    boardCapabilities,
    boardPageCursor,
    boardPageCursors,
    boardHasMore,
    boardPageTruncated,
    sprintsPageCursor,
    sprintMetadataPageCursors,
    sprintsHasMore,
    boardColumns,
    boardSearchQuery,
    boardSearchCursor,
    boardsHaveMore,
    boardPickerNotice,
    boardCatalogLoaded,
    boardSearchGeneration,
    selectedBoardLabel,
    selectedBoardType,
    boardOptions,
    boardModeOptions,
    doneWithinOptions,
    doneWithinChoice,
    sprintOptions,
    boardSprints,
    selectedSprint,
    sprintDateRange,
    sprintRemainingLabel,
    sprintProgress,
    sprintIssues,
    sprintIssuesCursor,
    sprintIssuePageCursors,
    sprintIssuesHasMore,
    sprintIssuesTruncated,
    selectedBoard,
    isOwnBoardFilterSelected,
    pinnedBoardInfo,
    jiraInboxWorkspace,
    pinnedBoardWorkspace,
    selectedBoardSavedView,
    canOpenSelectedBoardAsTab,
    compactBoardLayout,
    compactSelectedIssue,
    queueBoardSearch,
    loadMoreBoards,
    loadBoards,
    nativeJiraViewId,
    workspaceViewInput,
    queueNativeViewSave,
    applyWorkspaceViewsState,
    saveAndActivateNativeView,
    flushPendingNativeViewSave,
    openSelectedBoardAsNativeTab,
    openPinnedBoard,
    onBoardChange,
    onBoardModeChange,
    loadBoardQuickFilters,
    boardFilterPayload,
    mergeAssigneeCatalog,
    collectIssueAssignees,
    toggleQuickFilter,
    onBoardFilterDetailsToggle,
    onBoardFilterDetailsKeydown,
    queueAssigneeSearch,
    selectBoardAssignee,
    openMyIssuesBoard,
    selectUnassignedAssignee,
    clearBoardAssignee,
    chooseFirstAssigneeResult,
    loadBoard,
    refreshNativeBoardFromCache,
    isCurrentBoardRequest,
    applyBoardViewResult,
    refreshBoardSnapshot,
    loadMoreBoard,
    loadSelectedSprintIssues,
    loadMoreSprintIssues,
    boardColumnViews,
    nativeIssueSource,
    nativeIssueStatusKey,
    nativeStatusOptions,
    nativeStatusSelectValue,
    nativeStatusSelectOptions,
    nativeStatusFilteredIssues,
    nativeVisibleIssues,
    nativeIssueKey,
    selectNativePresentation,
    selectNativeStatusFilter,
    clearNativeIssueFilter,
    nativeBoardColumnViews,
    ownIssueStatusCategory,
    updateNoBoardSearchColumns,
    boardSharedLabels,
    cardLabels,
    issuesForColumn,
    unmappedBoardIssues,
    captureNativePresentationScroll,
    rememberNativeListScroll,
    rememberNativeBoardHorizontalScroll,
    rememberNativeBoardCardsScroll,
    restoreNativePresentationScroll,
  };
}
