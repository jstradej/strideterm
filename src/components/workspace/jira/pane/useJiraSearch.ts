import { computed, ref } from "vue";
import {
  filterJiraIssues,
  jiraIssueStatusGroup,
  JIRA_ISSUE_SORT_OPTIONS,
  sortJiraIssues,
  withJqlOrderBy,
  type JiraIssueStatusFilter,
} from "../jiraIssueList";
import {
  applyJiraFacets,
  emptyJiraFacets,
  jiraFacetOptions,
  JIRA_FACET_KEYS,
  type JiraFacetKey,
  type JiraFacetOption,
  type JiraFacetSelection,
} from "../jiraIssueFacets";
import { writeJiraViewPreferences, writeLastJiraSearch, type JiraSearchKind } from "../jira-view-preferences.js";
import {
  jiraSmartFilterLabel,
  normalizeJiraSmartFilters,
  type JiraSmartFilterId,
} from "../../../../../electron/shared/jira-smart-filters.js";
import {
  type JiraSavedFilter,
  type JiraSearchRequest,
  type JiraIssue,
  type JiraSearchPage,
  type JiraSearchScope,
  type JiraRecentSearch,
  type JiraRecentIssue,
  type JiraSavedQuery,
} from "./jira-pane-types.js";
import type { JiraPaneContext } from "./jira-pane-context.js";

export function useJiraSearch(ctx: JiraPaneContext) {
  const {
    activeView,
    allMyIssueCursors,
    api,
    boardCatalogLoaded,
    boardId,
    boardIssueDetailOpen,
    boardPickerNotice,
    boards,
    isBusy,
    connectionId,
    connections,
    dynamicApi,
    error,
    issueFilterText,
    issueSort,
    issues,
    jiraViewId,
    jql,
    loadBoard,
    loadBoards,
    mapSettledBounded,
    nativePersonalScope,
    openIssue,
    ownIssueSearchGeneration,
    ownIssuesBoardMode,
    ownSearchIdentityLabel,
    plainIssueRef,
    preferencesProfileId,
    projectScopeChoice,
    projectScopeConfigured,
    props,
    queryId,
    queueNativeViewSave,
    recentGeneration,
    reportFailure,
    reportFailureText,
    reportPartialFailures,
    beginBusy,
    recentSearches,
    recentViewedIssues,
    restoredPreferences,
    savedQueries,
    searchCache,
    searchFailed,
    searchHasMore,
    searchHasRun,
    selected,
    selectedConnection,
    selectedNativeView,
    textSearch,
    updateNoBoardSearchColumns,
    vars,
  } = ctx;
  const projectCatalogByConnection = ref<Record<string, Array<{ id: string | number; key: string; name: string }>>>({});
  const projectCatalogLoading = ref(false);
  const projectCatalogError = ref("");
  const projectCatalogTruncated = ref(false);
  const projectScopeError = ref("");
  const queryError = ref("");
  const queryNotice = ref("");
  const projectCatalog = computed(() => projectCatalogByConnection.value[connectionId.value] || []);
  const projectScopeLabel = computed(() => {
    const keys =
      projectScopeChoice.value === null ? selectedConnection.value?.projectKeys || [] : projectScopeChoice.value;
    if (projectScopeChoice.value === null && keys.length) return `Default · ${keys.slice(0, 2).join(", ")}`;
    if (!keys.length) return "All projects";
    return keys.length <= 2 ? keys.join(", ") : `${keys.slice(0, 2).join(", ")} +${keys.length - 2}`;
  });
  const resolvedProjectScopeKeys = computed(() =>
    projectScopeChoice.value === null ? selectedConnection.value?.projectKeys || [] : projectScopeChoice.value,
  );
  function issueMatchesProjectScope(issueKey: string) {
    const keys = resolvedProjectScopeKeys.value;
    if (!keys.length) return true;
    const projectKey = issueKey.split("-")[0]?.toUpperCase();
    return Boolean(projectKey && keys.includes(projectKey));
  }
  const recentViewedIssuesInScope = computed(() =>
    recentViewedIssues.value.filter((recent) => issueMatchesProjectScope(recent.ref.issueKey)),
  );
  const emptyResultScope = computed(() => {
    const jqlText = activeSearchJql.value.trim();
    const label = activeSearchLabel.value;
    return {
      projectKeys: [...(activeSearchProjectKeys.value ?? resolvedProjectScopeKeys.value)],
      query: label && label !== "Current query" ? label : jqlText,
      jql: jqlText,
    };
  });
  function searchAllProjects() {
    setProjectScope([]);
  }
  function clearActiveSearch() {
    quickSearchText.value = "";
    activeSearchJql.value = "";
    searchHasRun.value = false;
    searchFailed.value = false;
  }
  function setProjectScope(value: string[] | null) {
    const previous = {
      choice: projectScopeChoice.value === null ? null : [...projectScopeChoice.value],
      configured: projectScopeConfigured.value,
    };
    projectScopeError.value = "";
    projectScopeChoice.value =
      value === null ? null : [...new Set(value.map((key) => key.trim().toUpperCase()))].slice(0, 50);
    projectScopeConfigured.value = true;
    if (jiraViewId.value === "issues" && connectionId.value && connectionId.value !== "__all__") {
      void persistWorkspaceProjectScope(value, previous);
    } else if (selectedNativeView.value) {
      queueNativeViewSave(selectedNativeView.value);
    }
    if (jiraViewId.value === "issues") ctx.persistJiraViewPreferences();
    if (boardCatalogLoaded.value && connectionId.value && connectionId.value !== "__all__") {
      boards.value = [];
      boardPickerNotice.value = "";
      void loadBoards("");
    }
    selected.value = null;
    boardIssueDetailOpen.value = false;
    void reloadForProjectScope();
  }
  async function loadWorkspaceProjectScope(requestedConnectionId: string) {
    projectScopeChoice.value = null;
    projectScopeConfigured.value = false;
    if (!props.workspaceId || !dynamicApi.getJiraWorkspaceProjectScope) return;
    const requestedWorkspaceId = props.workspaceId;
    const requestedProfileId = preferencesProfileId.value;
    try {
      const saved = await dynamicApi.getJiraWorkspaceProjectScope({
        workspaceId: requestedWorkspaceId,
        connectionId: requestedConnectionId,
      });
      if (
        requestedWorkspaceId !== props.workspaceId ||
        requestedConnectionId !== connectionId.value ||
        requestedProfileId !== preferencesProfileId.value ||
        jiraViewId.value !== "issues"
      )
        return;
      projectScopeChoice.value = saved === null ? null : [...saved];
      projectScopeConfigured.value = saved !== null;
    } catch (cause) {
      if (requestedWorkspaceId === props.workspaceId && requestedConnectionId === connectionId.value)
        reportFailure("Could not load the saved project scope", cause, projectCatalogError);
    }
  }
  function projectScopePayload(value = projectScopeChoice.value, configured = projectScopeConfigured.value) {
    if (!configured) return {};
    if (value === null) return {};
    return { projectKeys: [...value] };
  }
  const personalScopeOptions = [
    { value: "open", label: "Open issues" },
    { value: "all", label: "All issues" },
  ];
  const searchCursor = ref("");
  const activeSearchJql = ref("");
  const activeSearchProjectKeys = ref<string[] | undefined>(undefined);
  const activeSearchLabel = ref("Current query");
  const activeSearchKind = ref<JiraSearchKind>("jql");
  const activeSearchFilterId = ref<string | null>(null);
  const searchTruncated = ref(false);
  const issuesLoading = ref(false);
  const issuesLoadingLabel = ref("Searching Jira issues…");
  const searchRefreshing = ref(false);
  const quickSearchText = ref("");
  const quickSearchError = ref("");
  const favoriteFilters = ref<JiraSavedFilter[]>([]);
  const favoriteFiltersUnavailable = ref(false);
  const favoriteFilterId = ref("");
  const savedFilterLookupId = ref("");
  const queryName = ref("");
  const queryNotificationsEnabled = ref(false);
  const issueSortOptions = JIRA_ISSUE_SORT_OPTIONS;
  const issueStatusFilter = ref<JiraIssueStatusFilter>("all");
  const textFilteredIssues = computed(() => filterJiraIssues(issues.value, issueFilterText.value, "all"));
  const issueStatusGroups = computed(() => {
    const counts = { todo: 0, active: 0, done: 0 };
    const faceted = applyJiraFacets(textFilteredIssues.value, issueFacets.value);
    for (const issue of faceted) counts[jiraIssueStatusGroup(issue)]++;
    return [
      { value: "all" as const, label: "All", tone: undefined, count: faceted.length },
      { value: "todo" as const, label: "To do", tone: "todo", count: counts.todo },
      { value: "active" as const, label: "In progress", tone: "progress", count: counts.active },
      { value: "done" as const, label: "Done", tone: "done", count: counts.done },
    ];
  });
  const issueFacets = ref<JiraFacetSelection>(emptyJiraFacets());
  const smartFilters = ref<JiraSmartFilterId[]>([]);
  const facetOptions = computed(() => {
    const result = {} as Record<JiraFacetKey, JiraFacetOption[]>;
    for (const key of JIRA_FACET_KEYS) result[key] = jiraFacetOptions(textFilteredIssues.value, issueFacets.value, key);
    return result;
  });
  const visibleIssueList = computed(() =>
    sortJiraIssues(
      filterJiraIssues(applyJiraFacets(textFilteredIssues.value, issueFacets.value), "", issueStatusFilter.value),
      issueSort.value,
    ),
  );
  function clearIssueListFilter() {
    issueFilterText.value = "";
    issueStatusFilter.value = "all";
    issueFacets.value = emptyJiraFacets();
  }
  /** Re-runs a plain JQL search with the matching ORDER BY so the first page holds the right issues, not just a re-sort. */
  function applyIssueSort() {
    if (!connectionId.value || connectionId.value === "__all__" || !searchHasRun.value || ownSearchIdentityLabel.value)
      return;
    jql.value = withJqlOrderBy(activeSearchJql.value || jql.value, issueSort.value);
    void search(jql.value, true, { recordUsage: false });
  }
  async function persistWorkspaceProjectScope(
    value: string[] | null,
    previous?: { choice: string[] | null; configured: boolean },
  ) {
    if (
      !props.workspaceId ||
      !connectionId.value ||
      connectionId.value === "__all__" ||
      !dynamicApi.setJiraWorkspaceProjectScope
    )
      return;
    const requestedWorkspaceId = props.workspaceId;
    const requestedConnectionId = connectionId.value;
    const requestedProfileId = preferencesProfileId.value;
    try {
      const saved = await dynamicApi.setJiraWorkspaceProjectScope({
        workspaceId: requestedWorkspaceId,
        connectionId: requestedConnectionId,
        projectKeys: value === null ? null : [...value],
      });
      if (
        requestedWorkspaceId !== props.workspaceId ||
        requestedConnectionId !== connectionId.value ||
        requestedProfileId !== preferencesProfileId.value
      )
        return;
      projectScopeChoice.value = saved === null ? null : [...saved];
      projectScopeConfigured.value = saved !== null;
    } catch (cause) {
      if (
        requestedWorkspaceId !== props.workspaceId ||
        requestedConnectionId !== connectionId.value ||
        requestedProfileId !== preferencesProfileId.value
      )
        return;
      if (previous) {
        projectScopeChoice.value = previous.choice;
        projectScopeConfigured.value = previous.configured;
        void reloadForProjectScope();
      }
      reportFailure("Could not save the project scope; the previous scope was restored", cause, projectScopeError);
    }
  }
  async function requestSearchPage(payload: JiraSearchRequest): Promise<JiraIssue[] | JiraSearchPage | null> {
    const request = api.searchJiraIssues as unknown as (
      input: JiraSearchRequest,
    ) => Promise<JiraIssue[] | JiraSearchPage | null>;
    return request(payload);
  }
  async function reloadForProjectScope() {
    if (!connectionId.value || connectionId.value === "__all__") return;
    const requestedConnectionId = connectionId.value;
    const requestedProfileId = preferencesProfileId.value;
    const requestedViewId = jiraViewId.value;
    const projectKeys = projectScopeChoice.value === null ? undefined : [...projectScopeChoice.value];
    if (activeView.value === "board" && boardId.value) {
      await loadBoard();
      return;
    }
    const personal = selectedNativeView.value?.kind === "personal" || ownIssuesBoardMode.value;
    if (personal && selectedConnection.value?.ownIdentity && dynamicApi.buildJiraOwnIssuesQuery) {
      try {
        const query = await dynamicApi.buildJiraOwnIssuesQuery({
          connectionId: requestedConnectionId,
          personalScope: selectedNativeView.value?.personalScope ?? nativePersonalScope.value,
          ...(projectKeys === undefined ? {} : { projectKeys }),
        });
        if (
          requestedConnectionId !== connectionId.value ||
          requestedProfileId !== preferencesProfileId.value ||
          requestedViewId !== jiraViewId.value
        )
          return;
        activeSearchJql.value = query.jql;
        ownSearchIdentityLabel.value = query.identityLabel;
        await search(query.jql, true, {
          kind: "my-issues",
          label: selectedNativeView.value?.title || "My issues",
          recordUsage: false,
          projectKeys,
        });
      } catch (cause) {
        reportFailure("Could not update the project scope", cause);
      }
      return;
    }
    if (searchHasRun.value && activeSearchJql.value) {
      await search(activeSearchJql.value, true, { kind: "jql", label: activeSearchLabel.value, projectKeys });
    }
  }
  async function loadJiraProjectCatalog(requestedConnectionId: string) {
    const cachedProjects = projectCatalogByConnection.value[requestedConnectionId];
    if (cachedProjects) {
      projectCatalogLoading.value = false;
      projectCatalogError.value = "";
      projectCatalogTruncated.value = cachedProjects.length >= 500;
      return;
    }
    if (projectCatalogLoading.value && vars.projectCatalogLoadingFor === requestedConnectionId) return;
    if (!dynamicApi.listJiraProjects) return;
    const generation = ++vars.projectCatalogGeneration;
    vars.projectCatalogLoadingFor = requestedConnectionId;
    const requestedProfileId = preferencesProfileId.value;
    projectCatalogLoading.value = true;
    projectCatalogError.value = "";
    try {
      const result = await dynamicApi.listJiraProjects(requestedConnectionId);
      if (
        generation !== vars.projectCatalogGeneration ||
        requestedConnectionId !== connectionId.value ||
        requestedProfileId !== preferencesProfileId.value
      )
        return;
      const rows = Array.isArray(result)
        ? result
        : result && typeof result === "object" && "projects" in result && Array.isArray(result.projects)
          ? result.projects
          : [];
      const projects = rows.flatMap((value) => {
        if (!value || typeof value !== "object") return [];
        const record = value as Record<string, unknown>;
        const key = typeof record.key === "string" ? record.key.trim().toUpperCase() : "";
        if (!/^[A-Z][A-Z0-9_]{1,49}$/.test(key)) return [];
        return [
          {
            id: typeof record.id === "string" || typeof record.id === "number" ? record.id : key,
            key,
            name: typeof record.name === "string" ? record.name : key,
          },
        ];
      });
      projectCatalogByConnection.value = {
        ...projectCatalogByConnection.value,
        [requestedConnectionId]: projects.slice(0, 500),
      };
      projectCatalogTruncated.value = projects.length >= 500;
    } catch (cause) {
      if (generation === vars.projectCatalogGeneration && requestedConnectionId === connectionId.value) {
        reportFailure("Could not load Jira projects", cause, projectCatalogError);
      }
    } finally {
      if (generation === vars.projectCatalogGeneration) {
        projectCatalogLoading.value = false;
        vars.projectCatalogLoadingFor = "";
      }
    }
  }
  function applySearchPage(result: JiraIssue[] | JiraSearchPage, preserveSelection: boolean) {
    issues.value = Array.isArray(result) ? result : result.issues;
    searchCursor.value = Array.isArray(result) ? "" : result.nextCursor || "";
    searchHasMore.value = !Array.isArray(result) && result.hasMore === true && !!result.nextCursor;
    searchTruncated.value = !Array.isArray(result) && result.truncated === true;
    searchCache.value = Array.isArray(result) ? null : result.cache || null;
    if (!preserveSelection) selected.value = null;
    searchHasRun.value = true;
    searchFailed.value = false;
    if (!boardId.value) updateNoBoardSearchColumns();
  }
  async function refreshSearchResults(
    requestedConnectionId: string,
    requestedProfileId: string,
    query: string,
    generation: number,
    projectKeys?: string[],
  ) {
    try {
      const fresh = await requestSearchPage({
        connectionId: requestedConnectionId,
        jql: query,
        limit: 50,
        forceRefresh: true,
        ...(projectKeys === undefined ? {} : { projectKeys: [...projectKeys] }),
      });
      if (
        !fresh ||
        generation !== vars.allSearchGeneration ||
        requestedConnectionId !== connectionId.value ||
        requestedProfileId !== preferencesProfileId.value ||
        query !== activeSearchJql.value
      )
        return;
      applySearchPage(fresh, true);
      if (selected.value) {
        const refreshedSelection = issues.value.find((issue) => issue.ref?.issueId === selected.value?.ref?.issueId);
        if (refreshedSelection) selected.value = refreshedSelection;
      }
    } catch (cause) {
      if (
        generation === vars.allSearchGeneration &&
        requestedConnectionId === connectionId.value &&
        requestedProfileId === preferencesProfileId.value
      ) {
        const prior = searchCache.value;
        if (prior)
          searchCache.value = {
            ...prior,
            refreshError: { code: "network", message: reportFailureText("Refresh failed", cause) },
          };
      }
    } finally {
      if (generation === vars.allSearchGeneration && requestedConnectionId === connectionId.value)
        searchRefreshing.value = false;
    }
  }
  function beginSearchLoading(label: string) {
    const end = beginBusy("search");
    issuesLoading.value = true;
    issuesLoadingLabel.value = label;
    return () => {
      end();
      if (!isBusy("search")) issuesLoading.value = false;
    };
  }
  async function search(query = jql.value, preserveSelection = false, scope: JiraSearchScope = {}) {
    if (!connectionId.value || connectionId.value === "__all__") return;
    if (!preserveSelection) clearIssueListFilter();
    const requestedConnectionId = connectionId.value;
    const requestedProfileId = preferencesProfileId.value;
    const requestedProjectKeys =
      scope.projectKeys ?? (projectScopeConfigured.value ? (projectScopeChoice.value ?? undefined) : undefined);
    const projectPayload = requestedProjectKeys === undefined ? {} : { projectKeys: [...requestedProjectKeys] };
    const kind = scope.kind || "jql";
    const endSearch = beginSearchLoading("Searching Jira issues…");
    searchFailed.value = false;
    searchRefreshing.value = false;
    const generation = ++vars.allSearchGeneration;
    error.value = "";
    try {
      activeSearchJql.value = query;
      activeSearchProjectKeys.value = requestedProjectKeys === undefined ? undefined : [...requestedProjectKeys];
      ownSearchIdentityLabel.value = "";
      const cached = scope.forceRefresh
        ? null
        : await requestSearchPage({
            connectionId: requestedConnectionId,
            jql: query,
            limit: 50,
            cacheOnly: true,
            ...projectPayload,
          });
      if (
        generation !== vars.allSearchGeneration ||
        requestedConnectionId !== connectionId.value ||
        requestedProfileId !== preferencesProfileId.value
      )
        return;
      if (cached) {
        applySearchPage(cached, preserveSelection);
        if (!scope.registrySync && !Array.isArray(cached) && cached.cache?.stale) {
          searchRefreshing.value = true;
          void refreshSearchResults(requestedConnectionId, requestedProfileId, query, generation, requestedProjectKeys);
        }
      } else if (scope.registrySync) {
        applySearchPage([], preserveSelection);
      } else {
        const fresh = await requestSearchPage({
          connectionId: requestedConnectionId,
          jql: query,
          limit: 50,
          forceRefresh: true,
          ...projectPayload,
        });
        if (
          generation !== vars.allSearchGeneration ||
          requestedConnectionId !== connectionId.value ||
          requestedProfileId !== preferencesProfileId.value
        )
          return;
        if (!fresh) throw new Error("Jira returned no search results.");
        applySearchPage(fresh, preserveSelection);
      }
      activeSearchLabel.value = scope.label || (kind === "jql" ? "Current query" : "Search");
      activeSearchKind.value = kind;
      activeSearchFilterId.value = scope.filterId || null;
      smartFilters.value = normalizeJiraSmartFilters(scope.smartFilters ?? []);
      if (kind === "my-issues") {
        ownSearchIdentityLabel.value = selectedConnection.value?.ownIdentity?.displayName || "verified human identity";
      }
      if (props.workspaceId && jiraViewId.value === "issues") {
        writeLastJiraSearch(requestedProfileId, props.workspaceId, {
          connectionId: requestedConnectionId,
          jql: query,
          kind,
          label: scope.label || null,
          filterId: scope.filterId || null,
        });
        restoredPreferences.value = writeJiraViewPreferences(requestedProfileId, props.workspaceId, {
          smartFilters: smartFilters.value,
        });
      }
      if (scope.recordUsage !== false && dynamicApi.rememberJiraSearch) {
        void dynamicApi
          .rememberJiraSearch({
            connectionId: requestedConnectionId,
            jql: query,
            ...(scope.label ? { label: scope.label } : {}),
          })
          .then(() => {
            if (requestedConnectionId === connectionId.value && requestedProfileId === preferencesProfileId.value)
              void loadJiraRecents(requestedConnectionId);
          })
          .catch(() => {});
      }
    } catch (cause) {
      if (generation === vars.allSearchGeneration && requestedConnectionId === connectionId.value) {
        reportFailure("Jira search failed", cause);
        searchCache.value = null;
        searchFailed.value = true;
        searchHasRun.value = true;
      }
    } finally {
      endSearch();
    }
  }
  async function searchAllText() {
    const text = textSearch.value.trim();
    if (!text || connections.value.length < 2) return;
    const jql = buildJiraTextSearchJql(text);
    if (!jql) {
      quickSearchError.value = "Enter an issue key or at least one word to search.";
      return;
    }
    const endSearch = beginSearchLoading("Searching Jira connections…");
    searchFailed.value = false;
    const generation = ++vars.allSearchGeneration;
    allMyIssueCursors.value.clear();
    clearIssueListFilter();
    searchHasMore.value = false;
    error.value = "";
    selected.value = null;
    try {
      const enabledConnections = connections.value.filter((connection) => connection.enabled !== false);
      const results = await mapSettledBounded(enabledConnections, 4, async (connection) => {
        const result = (await api.searchJiraIssues({
          connectionId: connection.id,
          jql,
          limit: 50,
        })) as JiraIssue[] | { issues: JiraIssue[]; hasMore?: boolean; truncated?: boolean };
        const rows = Array.isArray(result) ? result : result.issues;
        return {
          rows: rows.map((issue) => ({ ...issue, sourceLabel: connection.label })),
          truncated: !Array.isArray(result) && (result.hasMore === true || result.truncated === true),
        };
      });
      if (generation !== vars.allSearchGeneration) return;
      const failed = results.flatMap((result, index) =>
        result.status === "rejected" ? [{ label: enabledConnections[index].label, cause: result.reason }] : [],
      );
      issues.value = results
        .flatMap((result) => (result.status === "fulfilled" ? result.value.rows : []))
        .sort((left, right) => Date.parse(right.updated || "") - Date.parse(left.updated || ""));
      searchCursor.value = "";
      searchHasMore.value = false;
      searchTruncated.value = results.some((result) => result.status === "fulfilled" && result.value.truncated);
      searchHasRun.value = true;
      searchFailed.value = failed.length > 0 && !issues.value.length;
      if (failed.length) reportPartialFailures("Could not search", failed, "; results show only successful sources.");
    } catch (cause) {
      if (generation === vars.allSearchGeneration) {
        reportFailure("Jira search failed", cause);
        searchFailed.value = true;
        searchHasRun.value = true;
      }
    } finally {
      endSearch();
    }
  }
  function buildJiraTextSearchJql(text: string) {
    const words = text.match(/[\p{L}\p{N}_]+/gu) || [];
    if (!words.length) return "";
    return `${words.map((word) => `text ~ "${word}"`).join(" AND ")} ORDER BY updated DESC`;
  }
  /** A choice from the Views menu always lands on the issue list, wherever the user was. */
  function showIssuesView() {
    if (jiraViewId.value === "issues" && activeView.value !== "issues") activeView.value = "issues";
  }
  async function searchQuick() {
    const text = quickSearchText.value.trim();
    quickSearchError.value = "";
    if (!text) return;
    if (connectionId.value === "__all__") {
      textSearch.value = text;
      await searchAllText();
      return;
    }
    if (!connectionId.value) return;
    const query = /^[a-z][a-z0-9_]*-\d+$/i.test(text) ? `key = "${text.toUpperCase()}"` : buildJiraTextSearchJql(text);
    if (!query) {
      quickSearchError.value = "Enter an issue key or at least one word to search.";
      return;
    }
    jql.value = query;
    await search(query, false, { kind: "quick-search", label: text });
  }
  /** Opening Issues shows something at once: My issues when the user's Jira identity is known, else the default JQL. */
  function loadDefaultIssues() {
    if (ctx.connectionsOnly.value || !connectionId.value || connectionId.value === "__all__") return;
    if (searchHasRun.value || isBusy("search") || issues.value.length) return;
    loadDefaultIssuesNow();
  }
  function loadDefaultIssuesNow() {
    if (selectedConnection.value?.ownIdentity && dynamicApi.buildJiraOwnIssuesQuery)
      void searchOwnIssues("statusCategory != Done", { recordUsage: false });
    else void search(jql.value, false, { recordUsage: false });
  }
  /** One choice per group; picking the active chip again clears it. The query is built by the runtime from the chip ids. */
  async function toggleSmartFilter(id: JiraSmartFilterId) {
    if (!connectionId.value || connectionId.value === "__all__" || !dynamicApi.buildJiraOwnIssuesQuery) return;
    const next = smartFilters.value.includes(id)
      ? smartFilters.value.filter((chip) => chip !== id)
      : normalizeJiraSmartFilters([...smartFilters.value, id]);
    const previous = smartFilters.value;
    smartFilters.value = next;
    if (!next.length) {
      loadDefaultIssuesNow();
      return;
    }
    const generation = ++ownIssueSearchGeneration.value;
    const requestedConnectionId = connectionId.value;
    const endSearch = beginSearchLoading("Preparing your filters…");
    try {
      error.value = "";
      const result = await dynamicApi.buildJiraOwnIssuesQuery({
        connectionId: requestedConnectionId,
        smartFilters: next,
        ...projectScopePayload(),
      });
      if (generation !== ownIssueSearchGeneration.value || requestedConnectionId !== connectionId.value) return;
      endSearch();
      jql.value = result.jql;
      await search(result.jql, false, {
        label: jiraSmartFilterLabel(next),
        smartFilters: next,
        ...projectScopePayload(),
      });
      if (searchFailed.value && generation === ownIssueSearchGeneration.value) smartFilters.value = previous;
    } catch (cause) {
      if (generation === ownIssueSearchGeneration.value && requestedConnectionId === connectionId.value) {
        smartFilters.value = previous;
        reportFailure("Could not apply the Jira filters", cause);
        searchFailed.value = true;
        searchHasRun.value = true;
      }
    } finally {
      endSearch();
    }
  }
  async function searchOwnIssues(baseJql?: string, options: { recordUsage?: boolean } = {}) {
    if (!connectionId.value || !selectedConnection.value?.ownIdentity || !dynamicApi.buildJiraOwnIssuesQuery) return;
    const generation = ++ownIssueSearchGeneration.value;
    const requestedConnectionId = connectionId.value;
    const endSearch = beginSearchLoading("Preparing your My issues search…");
    try {
      searchFailed.value = false;
      error.value = "";
      const result = await dynamicApi.buildJiraOwnIssuesQuery({
        connectionId: requestedConnectionId,
        ...(baseJql ? { baseJql } : {}),
        ...projectScopePayload(),
      });
      if (generation !== ownIssueSearchGeneration.value || requestedConnectionId !== connectionId.value) return;
      ownSearchIdentityLabel.value = result.identityLabel;
      endSearch();
      await search(result.jql, false, {
        kind: "my-issues",
        label: "My issues",
        ...(options.recordUsage === false ? { recordUsage: false } : {}),
        ...projectScopePayload(),
      });
      ownSearchIdentityLabel.value = result.identityLabel;
    } catch (cause) {
      if (generation === ownIssueSearchGeneration.value && requestedConnectionId === connectionId.value) {
        reportFailure("Could not prepare the personal Jira issue filter", cause);
        searchFailed.value = true;
        searchHasRun.value = true;
      }
    } finally {
      endSearch();
    }
  }
  async function searchAllMyIssues(baseJql?: string) {
    const available = connections.value.filter((connection) => connection.enabled !== false && connection.ownIdentity);
    if (!available.length || !dynamicApi.buildJiraOwnIssuesQuery) return;
    const endSearch = beginSearchLoading("Searching My issues across connections…");
    searchFailed.value = false;
    const generation = ++vars.allSearchGeneration;
    error.value = "";
    selected.value = null;
    try {
      const results = await mapSettledBounded(available, 4, async (connection) => {
        const query = await dynamicApi.buildJiraOwnIssuesQuery!({
          connectionId: connection.id,
          ...(baseJql ? { baseJql } : {}),
        });
        const result = (await api.searchJiraIssues({ connectionId: connection.id, jql: query.jql, limit: 50 })) as
          JiraIssue[] | { issues: JiraIssue[]; hasMore?: boolean; nextCursor?: string; truncated?: boolean };
        return {
          connectionId: connection.id,
          jql: query.jql,
          sourceLabel: `${connection.label} · ${query.identityLabel}`,
          rows: (Array.isArray(result) ? result : result.issues).map((issue) => ({
            ...issue,
            sourceLabel: `${connection.label} · ${query.identityLabel}`,
          })),
          cursor: !Array.isArray(result) && result.hasMore && result.nextCursor ? result.nextCursor : "",
          truncated: !Array.isArray(result) && (result.hasMore === true || result.truncated === true),
        };
      });
      if (generation !== vars.allSearchGeneration) return;
      const failed = results.flatMap((result, index) =>
        result.status === "rejected" ? [{ label: available[index].label, cause: result.reason }] : [],
      );
      const fulfilled = results.flatMap((result) => (result.status === "fulfilled" ? [result.value] : []));
      issues.value = fulfilled
        .flatMap((result) => result.rows)
        .sort((left, right) => Date.parse(right.updated || "") - Date.parse(left.updated || ""));
      allMyIssueCursors.value = new Map(
        fulfilled
          .filter((result) => result.cursor)
          .map((result) => [
            result.connectionId,
            { cursor: result.cursor, jql: result.jql, sourceLabel: result.sourceLabel },
          ]),
      );
      searchCursor.value = "";
      searchHasMore.value = allMyIssueCursors.value.size > 0;
      searchTruncated.value = searchHasMore.value;
      searchHasRun.value = true;
      ownSearchIdentityLabel.value = "Verified personal identity filters, per connection";
      searchFailed.value = failed.length > 0 && !issues.value.length;
      if (failed.length) reportPartialFailures("Could not search", failed, "; results show only successful sources.");
    } catch (cause) {
      if (generation === vars.allSearchGeneration) {
        reportFailure("Could not search My issues across connections", cause);
        searchFailed.value = true;
        searchHasRun.value = true;
      }
    } finally {
      endSearch();
    }
  }
  async function loadMore() {
    if (connectionId.value === "__all__" && allMyIssueCursors.value.size) {
      await loadMoreAllMyIssues();
      return;
    }
    if (!connectionId.value || !searchCursor.value || isBusy("search", "search-more")) return;
    const generation = vars.allSearchGeneration;
    const requestedConnectionId = connectionId.value;
    const requestedJql = activeSearchJql.value;
    const endMore = beginBusy("search-more");
    try {
      const result = (await api.searchJiraIssues({
        connectionId: requestedConnectionId,
        jql: requestedJql,
        limit: 50,
        cursor: searchCursor.value,
        ...(activeSearchProjectKeys.value === undefined ? {} : { projectKeys: [...activeSearchProjectKeys.value] }),
      })) as { issues: JiraIssue[]; hasMore?: boolean; nextCursor?: string; truncated?: boolean };
      if (
        generation !== vars.allSearchGeneration ||
        requestedConnectionId !== connectionId.value ||
        requestedJql !== activeSearchJql.value
      )
        return;
      issues.value = [...issues.value, ...result.issues];
      searchCursor.value = result.nextCursor || "";
      searchHasMore.value = result.hasMore === true && !!result.nextCursor;
      searchTruncated.value = result.truncated === true;
      if (!boardId.value) updateNoBoardSearchColumns();
    } catch (cause) {
      if (generation === vars.allSearchGeneration) reportFailure("Could not load more Jira issues", cause);
    } finally {
      endMore();
    }
  }
  async function loadMoreAllMyIssues() {
    if (isBusy("search", "search-more") || !allMyIssueCursors.value.size) return;
    const endMore = beginBusy("search-more");
    const generation = ++vars.allSearchGeneration;
    const cursors = [...allMyIssueCursors.value.entries()];
    try {
      const pages = await mapSettledBounded(cursors, 4, async ([connectionId, state]) => {
        const result = (await api.searchJiraIssues({
          connectionId,
          jql: state.jql,
          limit: 50,
          cursor: state.cursor,
        })) as JiraIssue[] | { issues: JiraIssue[]; hasMore?: boolean; nextCursor?: string; truncated?: boolean };
        return {
          connectionId,
          sourceLabel: state.sourceLabel,
          rows: (Array.isArray(result) ? result : result.issues).map((issue) => ({
            ...issue,
            sourceLabel: state.sourceLabel,
          })),
          cursor: !Array.isArray(result) && result.hasMore && result.nextCursor ? result.nextCursor : "",
        };
      });
      if (generation !== vars.allSearchGeneration) return;
      const failed = pages.flatMap((page, index) =>
        page.status === "rejected"
          ? [
              {
                label:
                  connections.value.find((connection) => connection.id === cursors[index][0])?.label ||
                  cursors[index][0],
                cause: page.reason,
              },
            ]
          : [],
      );
      for (const page of pages) {
        if (page.status !== "fulfilled") continue;
        const prior = allMyIssueCursors.value.get(page.value.connectionId);
        if (page.value.cursor && prior)
          allMyIssueCursors.value.set(page.value.connectionId, { ...prior, cursor: page.value.cursor });
        else allMyIssueCursors.value.delete(page.value.connectionId);
        issues.value.push(...page.value.rows);
      }
      issues.value.sort((left, right) => Date.parse(right.updated || "") - Date.parse(left.updated || ""));
      searchHasMore.value = allMyIssueCursors.value.size > 0;
      searchTruncated.value = searchHasMore.value;
      if (failed.length) reportPartialFailures("Could not load more personal issues from", failed, ".");
    } catch (cause) {
      if (generation === vars.allSearchGeneration) reportFailure("Could not load more personal Jira issues", cause);
    } finally {
      endMore();
    }
  }
  async function loadJiraRecents(requestedConnectionId: string) {
    const generation = ++recentGeneration.value;
    const requestedProfileId = preferencesProfileId.value;
    const recentSearchesPromise = dynamicApi.getJiraRecentSearches
      ? dynamicApi.getJiraRecentSearches({ connectionId: requestedConnectionId, limit: 8 })
      : Promise.resolve([]);
    const recentIssuesPromise = dynamicApi.getJiraRecentIssues
      ? dynamicApi.getJiraRecentIssues({ connectionId: requestedConnectionId, limit: 8 })
      : Promise.resolve([]);
    const [searches, viewed] = await Promise.allSettled([recentSearchesPromise, recentIssuesPromise]);
    if (
      generation !== recentGeneration.value ||
      requestedConnectionId !== connectionId.value ||
      requestedProfileId !== preferencesProfileId.value
    )
      return;
    recentSearches.value =
      searches.status === "fulfilled"
        ? searches.value.map((search) => ({ ...search, connectionId: requestedConnectionId }))
        : [];
    recentViewedIssues.value = viewed.status === "fulfilled" ? viewed.value : [];
  }
  async function runRecentSearch(recent: JiraRecentSearch) {
    if (recent.connectionId !== connectionId.value) {
      connectionId.value = recent.connectionId;
      await ctx.onConnectionChange();
    }
    jql.value = recent.jql;
    await search(recent.jql, false, { kind: "jql", label: recent.label });
  }
  async function openRecentIssue(recent: JiraRecentIssue) {
    await openIssue({
      ref: plainIssueRef(recent.ref),
      key: recent.ref.issueKey,
      summary: recent.summary,
      status: recent.status,
      issueType: recent.issueType,
      statusCategory: recent.statusCategory,
    });
  }
  async function loadQueries() {
    const requestedConnectionId = connectionId.value;
    queryError.value = "";
    if (dynamicApi.listJiraQueries) {
      try {
        const queries = (await dynamicApi.listJiraQueries(requestedConnectionId)) as JiraSavedQuery[];
        if (requestedConnectionId === connectionId.value) savedQueries.value = queries;
      } catch (cause) {
        if (requestedConnectionId === connectionId.value)
          reportFailure("Could not load saved Jira queries", cause, queryError);
      }
    }
    if (dynamicApi.listJiraFavoriteFilters) {
      favoriteFiltersUnavailable.value = false;
      try {
        const favorites = (await dynamicApi.listJiraFavoriteFilters(requestedConnectionId)) as JiraSavedFilter[];
        if (requestedConnectionId === connectionId.value) favoriteFilters.value = favorites;
      } catch {
        if (requestedConnectionId === connectionId.value) {
          favoriteFilters.value = [];
          favoriteFiltersUnavailable.value = true;
        }
      }
    } else {
      favoriteFilters.value = [];
      favoriteFiltersUnavailable.value = !api.isRemote;
    }
  }
  async function runFavoriteFilter(filterId = favoriteFilterId.value) {
    favoriteFilterId.value = filterId;
    const filter = favoriteFilters.value.find((item) => item.id === filterId);
    if (!filter || !dynamicApi.getJiraSavedFilter || !connectionId.value || connectionId.value === "__all__") return;
    const requestedConnectionId = connectionId.value;
    queryError.value = "";
    const endSearch = beginSearchLoading("Loading Jira filter…");
    try {
      const detail = (await dynamicApi.getJiraSavedFilter!({
        connectionId: requestedConnectionId,
        filterId: filter.id,
      })) as JiraSavedFilter;
      if (requestedConnectionId !== connectionId.value) return;
      if (typeof detail.jql !== "string") throw new Error("Jira filter returned no usable JQL.");
      jql.value = detail.jql;
      await search(detail.jql, false, { kind: "saved-filter", label: detail.name, filterId: filter.id });
    } catch (cause) {
      if (requestedConnectionId === connectionId.value)
        reportFailure("Could not load this Jira favorite filter", cause);
    } finally {
      endSearch();
    }
  }
  async function runSavedFilterById() {
    if (!connectionId.value || connectionId.value === "__all__" || !/^\d{1,20}$/.test(savedFilterLookupId.value))
      return;
    const requestedConnectionId = connectionId.value;
    queryError.value = "";
    const endSearch = beginSearchLoading("Loading Jira filter…");
    try {
      const getSavedFilter = dynamicApi.getJiraSavedFilter;
      if (!getSavedFilter) return;
      const filter = (await getSavedFilter({
        connectionId: requestedConnectionId,
        filterId: savedFilterLookupId.value,
      })) as JiraSavedFilter;
      if (requestedConnectionId !== connectionId.value) return;
      if (typeof filter.jql !== "string") throw new Error("Jira filter returned no usable JQL.");
      jql.value = filter.jql;
      favoriteFilterId.value = "";
      await search(filter.jql, false, { kind: "saved-filter", label: filter.name, filterId: filter.id });
    } catch (cause) {
      if (requestedConnectionId === connectionId.value)
        reportFailure("Could not load this Jira filter on the selected connection", cause, queryError);
    } finally {
      endSearch();
    }
  }
  async function saveQuery() {
    queryError.value = "";
    if (!queryName.value.trim()) {
      queryError.value = "Enter a name for this saved query.";
      return;
    }
    if (isBusy("query-save", "query-delete")) return;
    const requestedConnectionId = connectionId.value;
    const sameName = savedQueries.value.find(
      (query) =>
        query.connectionId === requestedConnectionId &&
        query.name.trim().toLowerCase() === queryName.value.trim().toLowerCase(),
    );
    const endSave = beginBusy("query-save");
    try {
      const saved = (await dynamicApi.saveJiraQuery!({
        id: sameName?.id,
        connectionId: requestedConnectionId,
        name: queryName.value.trim(),
        jql: jql.value,
        notificationsEnabled: sameName?.notificationsEnabled ?? queryNotificationsEnabled.value,
      })) as { id: string };
      if (requestedConnectionId !== connectionId.value) return;
      await loadQueries();
      queryId.value = saved.id;
      queryNotice.value = `Saved “${queryName.value.trim()}” in Views.`;
    } catch (cause) {
      if (requestedConnectionId === connectionId.value) reportFailure("Could not save query", cause, queryError);
    } finally {
      endSave();
    }
  }
  /** Picking a saved query in Views runs it; the query text also lands in the JQL editor. */
  async function runSavedQuery(id: string) {
    const q = savedQueries.value.find((item) => item.id === id);
    if (!q || !connectionId.value || connectionId.value === "__all__") return;
    queryId.value = q.id;
    queryName.value = q.name;
    queryNotificationsEnabled.value = q.notificationsEnabled === true;
    jql.value = q.jql;
    await search(q.jql, false, { kind: "jql", label: q.name });
  }
  async function updateSavedQuery(query: JiraSavedQuery, patch: { name?: string; notificationsEnabled?: boolean }) {
    const name = (patch.name ?? query.name).trim();
    if (!name || isBusy("query-save", "query-delete")) return;
    queryError.value = "";
    const requestedConnectionId = connectionId.value;
    const endSave = beginBusy("query-save");
    try {
      await dynamicApi.saveJiraQuery!({
        id: query.id,
        connectionId: query.connectionId || requestedConnectionId,
        name,
        jql: query.jql,
        notificationsEnabled: patch.notificationsEnabled ?? query.notificationsEnabled,
      });
      if (requestedConnectionId === connectionId.value) await loadQueries();
    } catch (cause) {
      if (requestedConnectionId === connectionId.value)
        reportFailure("Could not update the saved query", cause, queryError);
    } finally {
      endSave();
    }
  }
  async function deleteQuery(id = queryId.value) {
    if (isBusy("query-save", "query-delete") || !id) return;
    queryError.value = "";
    const requestedConnectionId = connectionId.value;
    const target = savedQueries.value.find((query) => query.id === id);
    const confirmed = await ctx.store.confirmInApp({
      title: "Delete saved query?",
      message: `Delete “${target?.name || "this query"}”? Polling for it stops too.`,
      confirmLabel: "Delete",
      danger: true,
    });
    if (!confirmed) return;
    const endDelete = beginBusy("query-delete");
    try {
      await dynamicApi.deleteJiraQuery?.(id);
      if (requestedConnectionId !== connectionId.value) return;
      if (queryId.value === id) {
        queryId.value = "";
        queryName.value = "";
        queryNotificationsEnabled.value = false;
      }
      await loadQueries();
    } catch (cause) {
      if (requestedConnectionId === connectionId.value) reportFailure("Could not delete query", cause, queryError);
    } finally {
      endDelete();
    }
  }
  return {
    projectCatalogByConnection,
    projectCatalogLoading,
    projectCatalogError,
    projectCatalogTruncated,
    projectScopeError,
    queryError,
    queryNotice,
    projectCatalog,
    projectScopeLabel,
    resolvedProjectScopeKeys,
    issueMatchesProjectScope,
    recentViewedIssuesInScope,
    setProjectScope,
    emptyResultScope,
    searchAllProjects,
    clearActiveSearch,
    loadWorkspaceProjectScope,
    projectScopePayload,
    personalScopeOptions,
    searchCursor,
    activeSearchJql,
    activeSearchProjectKeys,
    activeSearchLabel,
    activeSearchKind,
    activeSearchFilterId,
    searchTruncated,
    issuesLoading,
    issuesLoadingLabel,
    searchRefreshing,
    quickSearchText,
    quickSearchError,
    favoriteFilters,
    favoriteFiltersUnavailable,
    favoriteFilterId,
    savedFilterLookupId,
    queryName,
    queryNotificationsEnabled,
    issueSortOptions,
    issueStatusFilter,
    textFilteredIssues,
    issueStatusGroups,
    visibleIssueList,
    clearIssueListFilter,
    applyIssueSort,
    persistWorkspaceProjectScope,
    requestSearchPage,
    reloadForProjectScope,
    loadJiraProjectCatalog,
    applySearchPage,
    refreshSearchResults,
    search,
    searchAllText,
    buildJiraTextSearchJql,
    searchQuick,
    searchOwnIssues,
    loadDefaultIssues,
    loadDefaultIssuesNow,
    toggleSmartFilter,
    issueFacets,
    facetOptions,
    smartFilters,
    searchAllMyIssues,
    loadMore,
    loadMoreAllMyIssues,
    loadJiraRecents,
    runRecentSearch,
    openRecentIssue,
    loadQueries,
    runFavoriteFilter,
    runSavedFilterById,
    saveQuery,
    runSavedQuery,
    updateSavedQuery,
    showIssuesView,
    deleteQuery,
  };
}
