import { nextTick, ref } from "vue";

import type { JiraPaneContext } from "./jira-pane-context.js";

export function useJiraPaneUi(ctx: JiraPaneContext) {
  const {
    activeView,
    boards,
    boardsLoading,
    isBusy,
    connectionId,
    connectionsLoaded,
    connectionsLoading,
    dismissIssuePreview,
    isCompactPane,
    issuePreviewVisible,
    jiraRootRef,
    jiraViewId,
    workspaceViewRestoredId,
    loadBoards,
    props,
    store,
    vars,
  } = ctx;
  const searchDetailsRef = ref<HTMLDetailsElement | null>(null);
  const jqlInputRef = ref<HTMLInputElement | null>(null);
  const quickSearchInputRef = ref<HTMLInputElement | null>(null);
  const boardChooserLabelRef = ref<HTMLLabelElement | null>(null);
  const searchToolsOpen = ref(false);
  function toggleAdvancedSearch() {
    const shouldOpen = activeView.value === "board" || !searchToolsOpen.value;
    activeView.value = "issues";
    searchToolsOpen.value = shouldOpen;
    void nextTick(() => {
      if (searchDetailsRef.value) searchDetailsRef.value.open = shouldOpen;
      if (shouldOpen) jqlInputRef.value?.focus();
    });
  }
  function openRequestedJiraBoardChooser() {
    const request = store.jiraBoardChooserRequest;
    if (
      !request ||
      request.workspaceId !== props.workspaceId ||
      jiraViewId.value !== "issues" ||
      request.sequence <= vars.lastHandledBoardChooserSequence ||
      vars.pendingBoardChooserSequence === request.sequence ||
      !connectionsLoaded.value ||
      connectionsLoading.value ||
      boardsLoading.value ||
      isBusy()
    )
      return;
    if (activeView.value !== "board") {
      activeView.value = "board";
      void nextTick(openRequestedJiraBoardChooser);
      return;
    }
    if (!boards.value.length && connectionId.value !== "__all__") {
      void loadBoards("");
      return;
    }
    const chooser = boardChooserLabelRef.value?.querySelector<HTMLButtonElement>(".custom-select__button");
    if (!chooser) return;
    if (chooser.disabled) {
      if (!boards.value.length) {
        vars.lastHandledBoardChooserSequence = request.sequence;
        store.clearJiraBoardChooserRequest(request.sequence);
      }
      return;
    }
    const sequence = request.sequence;
    vars.pendingBoardChooserSequence = sequence;
    void nextTick(() => {
      const latest = store.jiraBoardChooserRequest;
      const readyChooser = boardChooserLabelRef.value?.querySelector<HTMLButtonElement>(".custom-select__button");
      if (
        latest?.sequence !== sequence ||
        latest.workspaceId !== props.workspaceId ||
        jiraViewId.value !== "issues" ||
        !readyChooser ||
        readyChooser.disabled
      ) {
        vars.pendingBoardChooserSequence = null;
        return;
      }
      readyChooser.focus();
      readyChooser.click();
      vars.lastHandledBoardChooserSequence = sequence;
      vars.pendingBoardChooserSequence = null;
      store.clearJiraBoardChooserRequest(sequence);
    });
  }
  /** The sidebar's Jira chip asks this pane to open an issue; it waits for the restore and the first search to settle. */
  function openRequestedJiraIssue() {
    const request = store.jiraIssueOpenRequest;
    if (
      !request ||
      request.workspaceId !== props.workspaceId ||
      ctx.connectionsOnly.value ||
      request.sequence <= vars.lastHandledIssueOpenSequence ||
      !connectionsLoaded.value ||
      connectionsLoading.value ||
      ctx.issuesLoading.value
    )
      return;
    vars.lastHandledIssueOpenSequence = request.sequence;
    store.clearJiraIssueOpenRequest(request.sequence);
    const { connectionId: requestedConnectionId, issueId, issueKey } = request.ref;
    const inIssuesView = jiraViewId.value === "issues";
    if (!ctx.connections.value.some((connection) => connection.id === requestedConnectionId)) {
      ctx.reportFailure(`Could not open ${issueKey}`, new Error("Its Jira connection is unavailable in this profile."));
      return;
    }
    void (async () => {
      try {
        if (inIssuesView) ctx.activeView.value = "issues";
        if (inIssuesView && connectionId.value !== requestedConnectionId) {
          connectionId.value = requestedConnectionId;
          await ctx.onConnectionChange();
        }
        await ctx.openIssue({
          ref: { provider: "jira", connectionId: requestedConnectionId, issueId, issueKey },
          key: issueKey,
        });
      } catch (cause) {
        ctx.reportFailure(`Could not open ${issueKey}`, cause);
      }
    })();
  }
  /**
   * The header's Jira search hands its text over here to show every result; it searches what the header searched.
   * Only the Issues tab takes it: a saved board tab that happened to be on screen used to consume the request
   * before the switch to Issues, which then restored its last sub-view (often the board) with no search at all.
   */
  function runRequestedJiraSearch() {
    const request = store.jiraSearchRequest;
    if (
      !request ||
      request.workspaceId !== props.workspaceId ||
      jiraViewId.value !== "issues" ||
      workspaceViewRestoredId.value !== "issues" ||
      ctx.connectionsOnly.value ||
      request.sequence <= vars.lastHandledSearchSequence ||
      !connectionsLoaded.value ||
      connectionsLoading.value ||
      ctx.issuesLoading.value
    )
      return;
    vars.lastHandledSearchSequence = request.sequence;
    store.clearJiraSearchRequest(request.sequence);
    const enabled = ctx.connections.value.filter((connection) => connection.enabled !== false);
    if (!enabled.length) {
      ctx.reportFailure("Jira search failed", new Error("No Jira connection is enabled in this profile."));
      return;
    }
    const target = enabled.length > 1 ? "__all__" : enabled[0].id;
    void (async () => {
      try {
        activeView.value = "issues";
        ctx.quickSearchText.value = request.text;
        ctx.textSearch.value = request.text;
        if (connectionId.value !== target) {
          connectionId.value = target;
          await ctx.onConnectionChange();
          if (target === "__all__") return;
        }
        await ctx.searchQuick();
      } catch (cause) {
        ctx.reportFailure("Jira search failed", cause);
      }
    })();
  }
  function onBoardChooserOpen() {
    if (connectionId.value && connectionId.value !== "__all__" && !boards.value.length && !boardsLoading.value) {
      void loadBoards("");
    }
  }
  function focusQuickSearch() {
    void nextTick(() => quickSearchInputRef.value?.focus());
  }
  function closeExtraActionsOnOutsideClick(event: MouseEvent) {
    const target = event.target;
    if (!(target instanceof Node)) return;
    const root = jiraRootRef.value;
    if (!root) return;
    for (const details of root.querySelectorAll<HTMLDetailsElement>("details.jira-extra-actions[open]"))
      if (!details.contains(target)) details.open = false;
    // Board options and Board filters float over the board only in the wide layout. Their selects open a list
    // teleported to <body>, so a pick there is still inside the popover.
    if (root.classList.contains("jira-inbox--compact")) return;
    if (target instanceof Element && target.closest(".custom-select__list")) return;
    for (const details of root.querySelectorAll<HTMLDetailsElement>(
      "details.jira-board-options[open], details.jira-board-filter-details[open], details.jira-board-status-details[open]",
    ))
      if (!details.contains(target)) details.open = false;
  }
  function closeOpenExtraActions(event?: Event) {
    if (event?.target instanceof Element && event.target.closest("details.jira-extra-actions[open]")) return;
    for (const details of jiraRootRef.value?.querySelectorAll<HTMLDetailsElement>("details.jira-extra-actions[open]") ??
      [])
      details.open = false;
  }
  function closeExtraActionsWhenFocusLeaves(event: FocusEvent) {
    const details = event.currentTarget as HTMLDetailsElement;
    const next = event.relatedTarget;
    if (next instanceof Node && details.contains(next)) return;
    details.open = false;
  }
  function positionExtraActionsMenu(event: Event) {
    const details = event.currentTarget as HTMLDetailsElement;
    if (!details.open) return;
    const summary = details.querySelector<HTMLElement>("summary");
    const menu = details.querySelector<HTMLElement>(".jira-extra-actions__menu");
    if (!summary || !menu) return;
    const rect = summary.getBoundingClientRect();
    const width = Math.min(Math.max(190, menu.scrollWidth), window.innerWidth - 16);
    const height = Math.min(menu.scrollHeight || 120, window.innerHeight - 16);
    const top = rect.bottom + height + 6 <= window.innerHeight ? rect.bottom + 6 : Math.max(8, rect.top - height - 6);
    const anchor = details.dataset.align === "start" ? rect.left : rect.right - width;
    const left = Math.max(8, Math.min(anchor, window.innerWidth - width - 8));
    menu.style.setProperty("--jira-menu-top", `${top}px`);
    menu.style.setProperty("--jira-menu-left", `${left}px`);
  }
  function updateCompactPane() {
    closeOpenExtraActions();
    if (issuePreviewVisible.value) dismissIssuePreview();
    const root = jiraRootRef.value;
    if (!root) return;
    const rect = root.getBoundingClientRect();
    const width = root.clientWidth || rect.width;
    const height = root.clientHeight || rect.height;
    const coarsePointer = window.matchMedia?.("(pointer: coarse)").matches === true;
    isCompactPane.value =
      store.isMobileSession() || coarsePointer || (width > 0 && width <= 680) || (height > 0 && height <= 520);
  }
  return {
    searchDetailsRef,
    jqlInputRef,
    quickSearchInputRef,
    boardChooserLabelRef,
    searchToolsOpen,
    toggleAdvancedSearch,
    openRequestedJiraBoardChooser,
    openRequestedJiraIssue,
    runRequestedJiraSearch,
    onBoardChooserOpen,
    focusQuickSearch,
    closeExtraActionsOnOutsideClick,
    closeOpenExtraActions,
    closeExtraActionsWhenFocusLeaves,
    positionExtraActionsMenu,
    updateCompactPane,
  };
}
