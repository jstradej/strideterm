import { computed, onScopeDispose, ref, watch } from "vue";
import { useDelayedFlag } from "../../../../composables/useDelayedFlag.js";
import { useJiraMyIssues } from "../../../../composables/useJiraMyIssues.js";
import { writeJiraViewPreferences } from "../jira-view-preferences.js";

import type { JiraWorkspaceViewsState } from "../../../../../electron/shared/types/jira-workspace-views.js";
import type { JiraPaneContext } from "./jira-pane-context.js";
import type { JiraCacheMetadata } from "./jira-pane-types.js";

export function useJiraPaneSync(ctx: JiraPaneContext) {
  const {
    activeSearchFilterId,
    activeSearchJql,
    activeSearchKind,
    activeSearchLabel,
    activeView,
    applyWorkspaceViewsState,
    boardCache,
    boardId,
    boardIssueDetailOpen,
    boardLoading,
    boardMode,
    boardRefreshError,
    boardRefreshing,
    boardViewLoaded,
    connectionId,
    connections,
    connectionsLoaded,
    connectionsLoading,
    doneWithinDays,
    dynamicApi,
    formatSyncAge,
    isBusy,
    issueLoading,
    issueSort,
    issues,
    issuesLoading,
    issuesLoadingLabel,
    jiraErrorLabel,
    jiraViewId,
    searchRefreshing,
    store,
    queryId,
    updateSyncClock,
    workspaceViewRestored,
    loadBoard,
    loadBoardQuickFilters,
    loadComments,
    refreshConnectionList,
    reportFailure,
    nativeViewSync,
    pinnedBoardInfo,
    preferencesProfileId,
    preferencesRestored,
    props,
    refreshBoardSnapshot,
    refreshSelectedIssue,
    restoringPreferences,
    search,
    searchHasRun,
    selected,
    selectedBoard,
    selectedBoardAssignee,
    selectedBoardType,
    searchCache,
    selectedConnection,
    selectedQuickFilterIds,
    selectedRefreshError,
    selectedRefreshing,
    selectedSprintId,
    setupVisible,
    vars,
  } = ctx;
  const visibleRefreshInProgress = ref(false);
  const refreshFailure = ref("");
  const visibleCacheMetadata = computed(() => {
    if (activeView.value === "board" && !boardIssueDetailOpen.value) return boardCache.value;
    const issue = selected.value;
    if (!issue) return activeView.value === "issues" ? searchCache.value : null;
    if (!issue.cache) return null;
    if (connectionId.value !== "__all__" && issue.ref?.connectionId !== connectionId.value) return null;
    return issue.cache;
  });
  const visibleSyncError = computed(() => {
    if (refreshFailure.value) return refreshFailure.value;
    if (jiraViewId.value !== "issues" && nativeViewSync.value?.state === "error")
      return nativeViewSync.value.error || "Jira sync failed.";
    if (activeView.value === "board" && !boardIssueDetailOpen.value)
      return boardCache.value?.refreshError?.message || boardRefreshError.value || "";
    if (!selected.value && activeView.value === "issues") return searchCache.value?.refreshError?.message || "";
    return selectedRefreshError.value || selected.value?.cache?.refreshError?.message || "";
  });
  const isVisibleSyncing = computed(
    () =>
      connectionsLoading.value ||
      visibleRefreshInProgress.value ||
      boardLoading.value ||
      boardRefreshing.value ||
      selectedRefreshing.value ||
      issuesLoading.value ||
      issueLoading.value ||
      (jiraViewId.value !== "issues" && nativeViewSync.value?.state === "syncing"),
  );
  const lastCacheMetadata = ref<JiraCacheMetadata | null>(null);
  watch(
    visibleCacheMetadata,
    (metadata) => {
      if (metadata) lastCacheMetadata.value = metadata;
    },
    { immediate: true },
  );
  watch(
    () => store.myActiveProfileId,
    () => {
      lastCacheMetadata.value = null;
    },
  );
  /** The head sync line keeps the last metadata until the next arrives, so it never empties and refills. */
  const headCacheMetadata = computed(() => visibleCacheMetadata.value ?? lastCacheMetadata.value);
  const headSyncLabel = computed(() => {
    if (headCacheMetadata.value) return headCacheMetadata.value.stale ? "Saved data · synced" : "Synced";
    if (visibleSyncError.value) return "Sync failed";
    return isVisibleSyncing.value ? "Syncing Jira data…" : "";
  });
  const pollingStatus = computed(() => {
    const payload = store.payload as unknown as {
      jiraWorkspaceViews?: Record<string, JiraWorkspaceViewsState>;
    } | null;
    const watchStatus = props.workspaceId
      ? payload?.jiraWorkspaceViews?.[props.workspaceId]?.pollingByQueryId?.[queryId.value]
      : undefined;
    return watchStatus && watchStatus.connectionId === connectionId.value ? watchStatus : null;
  });
  /** The last failed background refresh: what failed, how long ago, and when the runtime will try again. */
  const backgroundFailure = computed(() => {
    const viewSync = jiraViewId.value !== "issues" ? nativeViewSync.value : null;
    if (viewSync?.state === "error") {
      const failedAt = viewSync.failedAt ?? viewSync.syncedAt;
      return {
        failedAt,
        code: viewSync.code,
        message: viewSync.error,
        retryAt: failedAt && viewSync.retryAfterMs ? failedAt + viewSync.retryAfterMs : undefined,
      };
    }
    const polling = pollingStatus.value;
    if (polling?.status === "rate-limited")
      return { failedAt: polling.lastError?.at, code: "rate-limited", retryAt: polling.retryAt };
    if (polling?.status === "error")
      return { failedAt: polling.lastError?.at, code: polling.lastError?.code, retryAt: polling.retryAt };
    return null;
  });
  const retryClock = ref(Date.now());
  let retryTimer: ReturnType<typeof setInterval> | undefined;
  watch(
    () => backgroundFailure.value?.retryAt,
    (retryAt) => {
      if (retryTimer) clearInterval(retryTimer);
      retryTimer = undefined;
      if (!retryAt || retryAt <= Date.now()) return;
      retryClock.value = Date.now();
      retryTimer = setInterval(() => {
        retryClock.value = Date.now();
        updateSyncClock();
        if (retryAt <= retryClock.value && retryTimer) {
          clearInterval(retryTimer);
          retryTimer = undefined;
        }
      }, 1000);
    },
    { immediate: true },
  );
  onScopeDispose(() => {
    if (retryTimer) clearInterval(retryTimer);
  });
  const backgroundFailureText = computed(() => {
    const failure = backgroundFailure.value;
    if (!failure) return "";
    const parts = [
      failure.failedAt ? `Last refresh failed ${formatSyncAge(failure.failedAt)} ago` : "Last refresh failed",
    ];
    if (failure.code) parts.push(jiraErrorLabel(failure.code as Parameters<typeof jiraErrorLabel>[0]));
    else if (failure.message) parts.push(failure.message);
    if (failure.retryAt && failure.retryAt > retryClock.value)
      parts.push(`retrying in ${Math.ceil((failure.retryAt - retryClock.value) / 1000)} s`);
    return parts.join(" · ");
  });
  const backgroundRefreshing = computed(
    () =>
      visibleRefreshInProgress.value ||
      boardRefreshing.value ||
      selectedRefreshing.value ||
      searchRefreshing.value ||
      (jiraViewId.value !== "issues" && nativeViewSync.value?.state === "syncing"),
  );
  /** A load that replaces what the active region shows. Empty states wait for it: a pending load is not "no issues". */
  const contentPending = computed(
    () =>
      !connectionsLoaded.value ||
      connectionsLoading.value ||
      restoringPreferences.value ||
      issuesLoading.value ||
      boardLoading.value ||
      isBusy("search", "board", "sprint") ||
      (jiraViewId.value !== "issues" && !workspaceViewRestored.value),
  );
  const stripLabel = computed(() => {
    if (!connectionsLoaded.value || connectionsLoading.value) return "Loading Jira connections…";
    if (restoringPreferences.value) return "Restoring your Jira view…";
    if (boardLoading.value) return "Loading board…";
    if (isBusy("sprint")) return "Loading sprint issues…";
    if (issuesLoading.value) return issuesLoadingLabel.value || "Loading Jira issues…";
    if (backgroundRefreshing.value) return "Refreshing Jira data…";
    return "";
  });
  const stripBackground = computed(() => Boolean(stripLabel.value) && stripLabel.value === "Refreshing Jira data…");
  const stripBusy = computed(() => Boolean(stripLabel.value));
  const stripVisible = useDelayedFlag(stripBusy);
  const shownStripLabel = ref("");
  watch(
    stripLabel,
    (label) => {
      if (label) shownStripLabel.value = label;
    },
    { immediate: true },
  );
  const stripExistingResultsNote = computed(() => issuesLoading.value && issues.value.length > 0);
  const status = computed(() =>
    connections.value.length
      ? `${connections.value.length} connection${connections.value.length === 1 ? "" : "s"}`
      : "Not connected",
  );
  function persistJiraViewPreferences() {
    if (
      jiraViewId.value !== "issues" ||
      !preferencesRestored.value ||
      restoringPreferences.value ||
      !props.workspaceId ||
      setupVisible.value
    )
      return;
    const pinned = pinnedBoardInfo.value;
    const userAssignee = selectedBoardAssignee.value?.kind === "user" ? selectedBoardAssignee.value : null;
    writeJiraViewPreferences(preferencesProfileId.value, props.workspaceId, {
      connectionId: pinned?.connectionId || connectionId.value || null,
      boardId: pinned?.boardId || (boardId.value ? String(boardId.value) : null),
      boardName: pinned?.boardName || selectedBoard.value?.name || null,
      boardType: selectedBoard.value?.type || selectedBoardType.value || null,
      activeView: pinned ? "board" : activeView.value,
      boardMode: boardMode.value,
      selectedSprintId: selectedSprintId.value ? String(selectedSprintId.value) : null,
      quickFilterIds: selectedQuickFilterIds.value.map(String),
      assignee:
        selectedBoardAssignee.value?.kind === "unassigned"
          ? { kind: "unassigned" }
          : userAssignee
            ? {
                kind: selectedConnection.value?.deployment === "cloud" ? "cloud" : "dc",
                id: userAssignee.id,
                displayName: userAssignee.label,
              }
            : null,
      doneWithinDays: doneWithinDays.value,
      issueSort: issueSort.value,
    });
  }
  async function refreshVisibleJiraData(
    options: { afterWrite?: boolean; refreshComments?: boolean; userInitiated?: boolean } = {},
  ) {
    if (vars.visibleRefreshTask) {
      await vars.visibleRefreshTask;
      if (!options.afterWrite) return;
    }
    visibleRefreshInProgress.value = true;
    refreshFailure.value = "";
    if (options.userInitiated) {
      void useJiraMyIssues(() => store.getApi(), preferencesProfileId)
        .load("force")
        .catch(() => undefined);
    }
    const task = (async () => {
      if (jiraViewId.value !== "issues" && dynamicApi.refreshJiraWorkspaceViews && props.workspaceId) {
        const refreshes: Promise<unknown>[] = [
          dynamicApi
            .refreshJiraWorkspaceViews({ workspaceId: props.workspaceId, viewId: jiraViewId.value })
            .then((state) => {
              applyWorkspaceViewsState(state);
            }),
        ];
        if (selected.value?.ref) {
          refreshes.push(
            refreshSelectedIssue(
              { connectionId: selected.value.ref.connectionId, issueId: selected.value.ref.issueId },
              vars.issueOpenGeneration,
              options.afterWrite === true,
            ),
          );
        }
        if (options.refreshComments && selected.value?.ref) refreshes.push(loadComments());
        await Promise.all(refreshes);
      } else if (activeView.value === "board" && boardId.value) {
        await loadBoardQuickFilters(true);
        if (activeView.value !== "board") return;
        const refreshes: Promise<unknown>[] = [boardViewLoaded.value ? refreshBoardSnapshot() : loadBoard()];
        if (boardIssueDetailOpen.value && selected.value?.ref)
          refreshes.push(
            refreshSelectedIssue(
              { connectionId: selected.value.ref.connectionId, issueId: selected.value.ref.issueId },
              vars.issueOpenGeneration,
              options.afterWrite === true,
            ),
          );
        if (options.refreshComments && selected.value?.ref) refreshes.push(loadComments());
        await Promise.all(refreshes);
      } else if (activeView.value === "issues") {
        const refreshes: Promise<unknown>[] = [];
        if (selected.value?.ref)
          refreshes.push(
            refreshSelectedIssue(
              { connectionId: selected.value.ref.connectionId, issueId: selected.value.ref.issueId },
              vars.issueOpenGeneration,
              options.afterWrite === true,
            ),
          );
        if (searchHasRun.value && activeSearchJql.value && connectionId.value !== "__all__")
          refreshes.push(
            search(activeSearchJql.value, true, {
              kind: activeSearchKind.value,
              ...(activeSearchLabel.value !== "Current query" ? { label: activeSearchLabel.value } : {}),
              filterId: activeSearchFilterId.value,
              recordUsage: false,
              ...(options.userInitiated ? { forceRefresh: true } : {}),
            }),
          );
        if (options.refreshComments && selected.value?.ref) refreshes.push(loadComments());
        if (refreshes.length) await Promise.all(refreshes);
        else if (!options.afterWrite) await refreshConnectionList();
      } else if (!options.afterWrite) {
        await refreshConnectionList();
      }
    })().catch((cause) => {
      reportFailure("Could not refresh Jira data", cause, refreshFailure);
    });
    vars.visibleRefreshTask = task;
    try {
      await task;
    } finally {
      if (vars.visibleRefreshTask === task) {
        vars.visibleRefreshTask = undefined;
        visibleRefreshInProgress.value = false;
      }
    }
  }
  return {
    visibleRefreshInProgress,
    refreshFailure,
    visibleCacheMetadata,
    visibleSyncError,
    isVisibleSyncing,
    headCacheMetadata,
    headSyncLabel,
    backgroundFailureText,
    backgroundRefreshing,
    contentPending,
    stripBusy,
    stripVisible,
    shownStripLabel,
    stripBackground,
    stripExistingResultsNote,
    status,
    persistJiraViewPreferences,
    refreshVisibleJiraData,
  };
}
