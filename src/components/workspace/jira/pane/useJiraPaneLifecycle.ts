import { onMounted, onUnmounted, watch } from "vue";
import { type JiraWorkspaceViewsState } from "../../../../../electron/shared/types/jira-workspace-views.js";

import type { JiraPaneContext } from "./jira-pane-context.js";
import { useJiraDetachedLifecycle } from "./useJiraDetachedLifecycle.js";

export function useJiraPaneLifecycle(ctx: JiraPaneContext) {
  const {
    activeView,
    boardId,
    boardIssueDetailOpen,
    boardLoadGeneration,
    boardMode,
    boardSearchGeneration,
    boardViewLoaded,
    boards,
    boardsLoading,
    isBusy,
    captureNativePresentationScroll,
    clearIssueErrors,
    clearPaneError,
    closeExtraActionsOnOutsideClick,
    closeOpenExtraActions,
    connectionId,
    connections,
    connectionsLoaded,
    connectionsLoading,
    dismissIssuePreview,
    doneWithinDays,
    flushPendingNativeViewSave,
    isNativeSavedView,
    issueSort,
    issues,
    jiraRootRef,
    jiraViewId,
    loadConnections,
    loadJiraCommentDrafts,
    nativeListPresentation,
    openRequestedJiraIssue,
    runRequestedJiraSearch,
    resetLoadingState,
    nativePersonalScope,
    nativePersonalScopeConfigured,
    nativePresentationChoice,
    nativeStatusFilter,
    nativeStatusFilterConfigured,
    nativeViewSync,
    openRequestedJiraBoardChooser,
    ownBoardGeneration,
    ownIssueSearchGeneration,
    ownIssuesBoardMode,
    persistJiraViewPreferences,
    preferencesRestored,
    projectScopeChoice,
    projectScopeConfigured,
    props,
    queueNativeViewSave,
    recentGeneration,
    recentSearches,
    recentViewedIssues,
    refreshNativeBoardFromCache,
    restoreNativePresentationScroll,
    restoringPreferences,
    searchCache,
    searchFailed,
    searchHasRun,
    selected,
    selectedBoardAssignee,
    selectedBoardLabel,
    selectedBoardType,
    selectedNativeView,
    selectedQuickFilterIds,
    selectedSprintId,
    sprintLoadGeneration,
    store,
    updateCompactPane,
    updateSyncClock,
    vars,
    workspaceViewInput,
    workspaceViewRestored,
    workspaceViewRestoredId,
    workspaceViewsState,
  } = ctx;
  if (props.detached) return useJiraDetachedLifecycle(ctx);
  /** A different workspace, profile or view is a different context: no error and no loading flag of the old one stays. */
  function resetTransientState() {
    clearPaneError();
    clearIssueErrors();
    resetLoadingState();
    for (const errorRef of [
      ctx.projectScopeError,
      ctx.projectCatalogError,
      ctx.queryError,
      ctx.branchError,
      ctx.boardActionError,
      ctx.assigneeSearchError,
      ctx.connectionActionError,
      ctx.identityError,
      ctx.metadataError,
      ctx.workspaceViewSaveError,
      ctx.quickSearchError,
      ctx.humanIdentitySearchError,
      ctx.refreshFailure,
      ctx.boardRefreshError,
      ctx.boardQuickFilterError,
      ctx.boardPickerNotice,
      ctx.selectedRefreshError,
      ctx.commentsError,
      ctx.repoPreferenceNotice,
    ])
      errorRef.value = "";
    ctx.restoreRetryable.value = false;
  }
  onMounted(() => {
    void loadConnections();
    void loadJiraCommentDrafts();
    window.addEventListener("focus", updateSyncClock);
    document.addEventListener("visibilitychange", updateSyncClock);
    updateCompactPane();
    vars.jiraWindowResizeHandler = updateCompactPane;
    window.addEventListener("resize", vars.jiraWindowResizeHandler);
    window.addEventListener("scroll", dismissIssuePreview, true);
    document.addEventListener("pointerdown", closeExtraActionsOnOutsideClick);
    window.addEventListener("scroll", closeOpenExtraActions, true);
    if (jiraRootRef.value && typeof ResizeObserver !== "undefined") {
      vars.jiraResizeObserver = new ResizeObserver(updateCompactPane);
      vars.jiraResizeObserver.observe(jiraRootRef.value);
    }
  });
  onUnmounted(() => {
    document.removeEventListener("pointerdown", closeExtraActionsOnOutsideClick);
    window.removeEventListener("scroll", closeOpenExtraActions, true);
    vars.issueOpenGeneration++;
    recentGeneration.value++;
    ownBoardGeneration.value++;
    boardLoadGeneration.value++;
    vars.boardRefreshGeneration++;
    vars.assigneeSearchGeneration++;
    vars.jiraResizeObserver?.disconnect();
    vars.issuePreviewObserver?.disconnect();
    if (vars.jiraWindowResizeHandler) window.removeEventListener("resize", vars.jiraWindowResizeHandler);
    window.removeEventListener("focus", updateSyncClock);
    document.removeEventListener("visibilitychange", updateSyncClock);
    window.removeEventListener("scroll", dismissIssuePreview, true);
    if (vars.boardSearchTimer) clearTimeout(vars.boardSearchTimer);
    if (vars.assigneeSearchTimer) clearTimeout(vars.assigneeSearchTimer);
    if (vars.issuePreviewTimer) clearTimeout(vars.issuePreviewTimer);
    void flushPendingNativeViewSave();
    dismissIssuePreview();
  });
  watch(
    () => {
      const payload = store.payload as unknown as {
        jiraWorkspaceViews?: Record<string, JiraWorkspaceViewsState>;
      } | null;
      return props.workspaceId ? payload?.jiraWorkspaceViews?.[props.workspaceId] : undefined;
    },
    (state) => {
      if (state?.workspaceId === props.workspaceId) workspaceViewsState.value = state;
    },
    { deep: true },
  );
  watch(
    () => [
      store.jiraIssueOpenRequest?.sequence,
      props.workspaceId,
      jiraViewId.value,
      connectionsLoaded.value,
      connectionsLoading.value,
      ctx.issuesLoading.value,
    ],
    openRequestedJiraIssue,
    { immediate: true },
  );
  watch(
    () => [
      store.jiraSearchRequest?.sequence,
      props.workspaceId,
      connectionsLoaded.value,
      connectionsLoading.value,
      ctx.issuesLoading.value,
    ],
    runRequestedJiraSearch,
    { immediate: true },
  );
  watch(
    () => [
      store.jiraBoardChooserRequest?.workspaceId,
      store.jiraBoardChooserRequest?.sequence,
      props.workspaceId,
      jiraViewId.value,
      connectionsLoaded.value,
      connectionsLoading.value,
      boardsLoading.value,
      boards.value.length,
      isBusy(),
    ],
    openRequestedJiraBoardChooser,
    { immediate: true },
  );
  watch(
    () => [jiraViewId.value, nativeViewSync.value?.state, nativeViewSync.value?.syncedAt] as const,
    (next, previous) => {
      if (
        jiraViewId.value !== "issues" &&
        next[2] !== undefined &&
        next[2] !== previous?.[2] &&
        next[1] !== "syncing"
      ) {
        void refreshNativeBoardFromCache();
      }
    },
  );
  watch(
    nativeListPresentation,
    (next, previous) => {
      if (next === previous || !isNativeSavedView.value) return;
      captureNativePresentationScroll(previous ? "list" : "board");
      restoreNativePresentationScroll(next ? "list" : "board");
    },
    { flush: "post" },
  );
  watch(
    () => [
      jiraViewId.value,
      connectionId.value,
      boardId.value,
      boardMode.value,
      selectedSprintId.value,
      selectedQuickFilterIds.value.join(","),
      selectedBoardAssignee.value?.kind,
      selectedBoardAssignee.value?.kind === "user" ? selectedBoardAssignee.value.id : "",
      selectedBoardAssignee.value?.label,
      doneWithinDays.value,
      nativePresentationChoice.value,
      nativeStatusFilter.value,
      nativeStatusFilterConfigured.value,
      nativePersonalScope.value,
      nativePersonalScopeConfigured.value,
      projectScopeChoice.value?.join(",") ?? "inherit",
      projectScopeConfigured.value,
      workspaceViewRestored.value,
      workspaceViewRestoredId.value,
    ],
    () => {
      const pending = vars.pendingNativeViewSave;
      if (pending && (pending.workspaceId !== props.workspaceId || pending.viewId !== jiraViewId.value)) {
        void flushPendingNativeViewSave();
      }
      const current = selectedNativeView.value;
      if (
        jiraViewId.value === "issues" ||
        !workspaceViewRestored.value ||
        workspaceViewRestoredId.value !== jiraViewId.value ||
        !current ||
        !props.workspaceId
      )
        return;
      const input = workspaceViewInput(current.kind, current.boardName);
      queueNativeViewSave(current, input);
    },
  );
  watch(activeView, (view) => {
    if (view === "issues" && jiraViewId.value === "issues" && workspaceViewRestored.value) ctx.loadDefaultIssues();
    if (view !== "board") ownIssuesBoardMode.value = false;
    if (view !== "board" && boardIssueDetailOpen.value) {
      boardIssueDetailOpen.value = false;
      dismissIssuePreview();
    }
  });
  watch(
    () => [
      connectionId.value,
      boardId.value,
      selectedBoardLabel.value,
      selectedBoardType.value,
      activeView.value,
      boardMode.value,
      selectedSprintId.value,
      selectedQuickFilterIds.value.join(","),
      selectedBoardAssignee.value?.kind,
      selectedBoardAssignee.value?.kind === "user" ? selectedBoardAssignee.value.id : "",
      selectedBoardAssignee.value?.label,
      doneWithinDays.value,
      issueSort.value,
      projectScopeChoice.value?.join(",") ?? "inherit",
      projectScopeConfigured.value,
    ],
    () => persistJiraViewPreferences(),
  );
  watch(
    () => props.workspaceId,
    () => {
      void flushPendingNativeViewSave();
      resetTransientState();
      preferencesRestored.value = false;
      workspaceViewRestored.value = false;
      workspaceViewRestoredId.value = "";
      workspaceViewsState.value = null;
      restoringPreferences.value = false;
      vars.issueOpenGeneration++;
      vars.boardRefreshGeneration++;
      vars.assigneeSearchGeneration++;
      boardLoadGeneration.value++;
      sprintLoadGeneration.value++;
      vars.allSearchGeneration++;
      recentGeneration.value++;
      ownBoardGeneration.value++;
      boardSearchGeneration.value++;
      if (vars.boardSearchTimer) clearTimeout(vars.boardSearchTimer);
      if (vars.assigneeSearchTimer) clearTimeout(vars.assigneeSearchTimer);
      dismissIssuePreview();
      connectionId.value = "";
      boardId.value = 0;
      selectedBoardLabel.value = "";
      activeView.value = jiraViewId.value === "issues" ? "issues" : "board";
      selected.value = null;
      issues.value = [];
      recentSearches.value = [];
      recentViewedIssues.value = [];
      searchCache.value = null;
      searchHasRun.value = false;
      searchFailed.value = false;
      void loadConnections();
      void loadJiraCommentDrafts();
    },
  );
  watch(
    () => jiraViewId.value,
    (viewId, previous) => {
      if (viewId === previous) return;
      resetTransientState();
      workspaceViewRestored.value = false;
      workspaceViewRestoredId.value = "";
      activeView.value = viewId === "issues" ? "issues" : "board";
      boardViewLoaded.value = false;
      selected.value = null;
      void loadConnections();
    },
  );
  watch(
    () => store.myActiveProfileId,
    () => {
      resetTransientState();
      preferencesRestored.value = false;
      workspaceViewRestored.value = false;
      workspaceViewRestoredId.value = "";
      workspaceViewsState.value = null;
      restoringPreferences.value = false;
      vars.issueOpenGeneration++;
      vars.boardRefreshGeneration++;
      vars.assigneeSearchGeneration++;
      boardLoadGeneration.value++;
      sprintLoadGeneration.value++;
      ownIssueSearchGeneration.value++;
      ownBoardGeneration.value++;
      recentGeneration.value++;
      vars.allSearchGeneration++;
      boardSearchGeneration.value++;
      if (vars.boardSearchTimer) clearTimeout(vars.boardSearchTimer);
      if (vars.assigneeSearchTimer) clearTimeout(vars.assigneeSearchTimer);
      dismissIssuePreview();
      connections.value = [];
      issues.value = [];
      recentSearches.value = [];
      recentViewedIssues.value = [];
      searchCache.value = null;
      selected.value = null;
      connectionId.value = "";
      boardId.value = 0;
      selectedBoardLabel.value = "";
      void loadConnections();
    },
  );
  return {};
}
