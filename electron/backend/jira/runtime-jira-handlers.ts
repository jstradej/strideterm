/* eslint-disable @typescript-eslint/no-explicit-any -- state-store mutations follow the runtime's existing typed-draft boundary. */
import { JIRA_COMMENTS_MAX, type JiraConnection } from "./jira-manager.js";
import { getLogger } from "../logger.js";
import { JIRA_SAFE_ERROR_CODES, JIRA_SIGN_IN_CODES } from "../../shared/jira-error-codes.js";
import {
  normalizeJiraAgentAttachmentLimits,
  type JiraAgentAttachmentLimits,
} from "../../shared/jira-agent-attachments.js";
import { normalizeJiraCommentAttribution, type JiraCommentAttribution } from "../../shared/jira-comment-attribution.js";
import {
  jiraSmartFilterClause,
  jiraSmartFilterNeedsIdentity,
  normalizeJiraSmartFilters,
  type JiraSmartFilterId,
} from "../../shared/jira-smart-filters.js";
import { jiraErrorFields } from "./jira-request-error.js";
import { jiraFailureLog, logJiraFailure, logJiraRecovered } from "./jira-failure-log.js";
import {
  appendJiraJqlClause,
  applyJiraProjectScope,
  cloudSiteOrigin,
  JiraManager,
  JiraRequestError,
  normalizeJiraProjectKeys,
} from "./jira-manager.js";
import type {
  JiraSavedWorkspaceView,
  JiraWorkspaceViewInput,
  JiraWorkspaceViewsSnapshot,
  JiraWorkspaceViewsState,
} from "../../shared/types/jira-workspace-views.js";
import { JiraWriteJournal, JiraWriteJournalError, type JiraWriteJournalEntry } from "./jira-write-journal.js";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import type { JiraAttachmentCache } from "./jira-attachment-cache.js";
import { mkdir, readFile } from "node:fs/promises";
import { createSecureContext } from "node:tls";
import { normalizeWorkspace, strideDataDir } from "../default-state.js";
import {
  jiraBoardDtoSchema,
  jiraBoardSearchResultDtoSchema,
  jiraBoardViewDtoSchema,
  jiraBoardQuickFiltersDtoSchema,
  jiraConnectionDtoSchema,
  jiraRepoBindingPreferenceDtoSchema,
  jiraCommentDtoSchema,
  jiraIssueDtoSchema,
  jiraIdentityDtoSchema,
  jiraCommentDraftDtoSchema,
  jiraProjectDtoSchema,
  jiraUserSearchDtoSchema,
  jiraSavedQueryDtoSchema,
  jiraSavedFilterDtoSchema,
  jiraTaskContextDtoSchema,
  jiraOwnIssuesQueryDtoSchema,
  jiraWriteConfirmationDtoSchema,
  jiraSearchResultDtoSchema,
  jiraRecentSearchesDtoSchema,
  jiraRecentIssuesDtoSchema,
  jiraWorkspaceProjectScopeDtoSchema,
  type JiraBoardSearchPayload,
  jiraTransitionDtoSchema,
  jiraVerifyConnectionDtoSchema,
  jiraWriteJournalEntryDtoSchema,
  jiraWriteReconcileResultDtoSchema,
  jiraWriteInvokeResultDtoSchema,
} from "../ipc-schemas.js";
import {
  JiraWriteSafety,
  JiraWriteSafetyError,
  jiraWriteNameHash,
  type JiraAssignRequest,
  type JiraWriteConfirmation,
  type JiraWriteIssue,
  type JiraWriteIdentity,
} from "./jira-write-safety.js";

export function createJiraHandlers(ctx: any) {
  const log: ReturnType<typeof getLogger> = ctx.jiraLog ?? getLogger("jira");
  const manager = ctx.jiraManager || new JiraManager(ctx.credentialStore, ctx.fetchImpl, ctx.jiraCache);
  manager.onConnectionInvalidated = (connectionId: string) => {
    void (ctx.jiraAttachmentCache as JiraAttachmentCache | undefined)?.removeConnection(connectionId);
  };
  const attachmentImage = async (
    connection: JiraConnection,
    payload: { connectionId: string; issueId: string; attachmentId: string },
  ): Promise<{ mediaType: string; bytes: Uint8Array }> => {
    const cache = ctx.jiraAttachmentCache as JiraAttachmentCache | undefined;
    const binding = manager.cacheBinding(connection);
    const hit = await cache?.get(payload.connectionId, binding, payload.issueId, payload.attachmentId);
    if (hit) return hit;
    const downloaded = await manager.attachmentBytes(connection, payload.issueId, payload.attachmentId, {
      maxBytes: 10 * 1024 * 1024,
      maxDurationMs: 25_000,
      imageOnly: true,
    });
    const image = { mediaType: downloaded.mediaType, bytes: downloaded.bytes };
    await cache?.put(payload.connectionId, binding, payload.issueId, payload.attachmentId, image);
    return image;
  };
  const viewSyncStates = new Map<string, JiraWorkspaceViewsState>();
  const viewFlights = new Map<string, Promise<void>>();
  const viewFlightForceRefresh = new Map<string, boolean>();
  const queuedForceRefresh = new Set<string>();
  let viewSyncDisposed = false;
  const viewStateKey = (profileId: string, workspaceId: string) => `${profileId}:${workspaceId}`;
  const sameViewData = (a: JiraSavedWorkspaceView, b: JiraSavedWorkspaceView) =>
    a.connectionId === b.connectionId &&
    a.kind === b.kind &&
    a.boardId === b.boardId &&
    a.mode === b.mode &&
    a.sprintId === b.sprintId &&
    JSON.stringify(a.quickFilterIds) === JSON.stringify(b.quickFilterIds) &&
    JSON.stringify(a.assignee) === JSON.stringify(b.assignee) &&
    a.doneWithinDays === b.doneWithinDays &&
    (a.personalScope ?? "open") === (b.personalScope ?? "open") &&
    JSON.stringify(a.projectKeys ?? null) === JSON.stringify(b.projectKeys ?? null);
  const refreshFailure = (refresh: { code: string; message: string; retryAfterMs?: number }) =>
    new JiraRequestError(refresh.code as any, refresh.message, refresh.retryAfterMs);
  const viewError = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 240);
  const isSavedWorkspaceView = (value: unknown): value is JiraSavedWorkspaceView => {
    if (!value || typeof value !== "object") return false;
    const view = value as Partial<JiraSavedWorkspaceView>;
    const assignee = view.assignee;
    const validAssignee =
      assignee === null ||
      (assignee !== undefined &&
        typeof assignee === "object" &&
        (assignee.kind === "unassigned" ||
          (assignee.kind === "user" && typeof assignee.id === "string" && assignee.id.length <= 200)));
    const validDoneWindow =
      view.doneWithinDays === null ||
      view.doneWithinDays === 7 ||
      view.doneWithinDays === 14 ||
      view.doneWithinDays === 30 ||
      view.doneWithinDays === 90;
    return (
      typeof view.viewId === "string" &&
      view.viewId.length > 0 &&
      view.viewId.length <= 200 &&
      (view.kind === "board" || view.kind === "personal") &&
      typeof view.connectionId === "string" &&
      view.connectionId.length > 0 &&
      view.connectionId.length <= 200 &&
      (view.kind === "personal"
        ? view.boardId === null
        : Number.isSafeInteger(view.boardId) && Number(view.boardId) > 0) &&
      typeof view.boardName === "string" &&
      view.boardName.length <= 200 &&
      typeof view.title === "string" &&
      view.title.length <= 200 &&
      (view.mode === "issues" || view.mode === "backlog" || view.mode === "sprints") &&
      (view.sprintId === null || (Number.isSafeInteger(view.sprintId) && Number(view.sprintId) > 0)) &&
      Array.isArray(view.quickFilterIds) &&
      view.quickFilterIds.length <= 50 &&
      view.quickFilterIds.every((id) => Number.isSafeInteger(id) && id >= 0) &&
      validAssignee &&
      validDoneWindow &&
      (view.presentation === undefined || view.presentation === "board" || view.presentation === "list") &&
      (view.statusFilter === undefined ||
        view.statusFilter === null ||
        (typeof view.statusFilter === "string" && view.statusFilter.length <= 200)) &&
      (view.personalScope === undefined || view.personalScope === "open" || view.personalScope === "all") &&
      (view.projectKeys === undefined ||
        (Array.isArray(view.projectKeys) &&
          view.projectKeys.length <= 50 &&
          view.projectKeys.every((key) => typeof key === "string" && /^[A-Z][A-Z0-9_]{0,19}$/.test(key)))) &&
      Number.isFinite(view.createdAt) &&
      Number.isFinite(view.updatedAt)
    );
  };
  const ownIssuesJql = (
    identity: NonNullable<JiraConnection["ownIdentity"]>,
    baseJql = "",
    personalScope: "open" | "all" = "open",
  ) => {
    const value = identity.kind === "cloud" ? identity.accountId : identity.name;
    const escaped = value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
    const ownClause = `assignee = "${escaped}"`;
    let jql = baseJql.trim();
    if (personalScope === "open" && !/statusCategory\s*!=\s*Done\b/i.test(jql))
      jql = appendJiraJqlClause(jql, "statusCategory != Done");
    return appendJiraJqlClause(jql, ownClause);
  };
  const smartFiltersJql = (
    identity: JiraConnection["ownIdentity"] | undefined,
    baseJql: string,
    smartFilters: readonly JiraSmartFilterId[],
  ) => {
    const filters = normalizeJiraSmartFilters(smartFilters);
    const hasIdentity = !!identity && (identity.kind === "cloud" ? !!identity.accountId : !!identity.name);
    if (filters.some(jiraSmartFilterNeedsIdentity) && !hasIdentity)
      throw new Error("Choose and verify a personal Jira identity before using these filters.");
    const person = !identity ? "" : identity.kind === "cloud" ? identity.accountId : identity.name;
    const escaped = person.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
    let jql = baseJql.trim();
    for (const id of filters) jql = appendJiraJqlClause(jql, jiraSmartFilterClause(id, escaped));
    return /\border\s+by\b/i.test(jql) ? jql : `${jql} ORDER BY updated DESC`;
  };
  const smartFilterQuery = (
    connection: JiraConnection,
    input: { baseJql?: string; projectKeys?: string[]; smartFilters?: JiraSmartFilterId[] },
  ) =>
    jiraOwnIssuesQueryDtoSchema.parse({
      jql: applyJiraProjectScope(
        smartFiltersJql(connection.ownIdentity, input.baseJql ?? "", input.smartFilters ?? []),
        input.projectKeys === undefined ? connection.projectKeys : input.projectKeys,
      ),
      identityLabel: connection.ownIdentity?.displayName ?? "",
    });
  const connections = () => (ctx.getState().settings.integrations.jira?.connections || []) as JiraConnection[];
  const getViewerProfileId = (windowId?: string): string => {
    if (!windowId) throw new Error("Jira access requires a trusted desktop window context.");
    const profileId = ctx.getViewerProfileId?.(windowId);
    if (!profileId) throw new Error("Could not resolve this window's Jira profile.");
    return profileId;
  };
  const get = (id: string, windowId?: string) => {
    const connection = connections().find((item) => item.id === id && item.enabled);
    if (!connection) throw new Error("Jira connection was not found or is disabled.");
    const viewerProfile = getViewerProfileId(windowId);
    if (connection.profileId !== viewerProfile) throw new Error("Jira connection belongs to another profile.");
    return connection;
  };
  const getForProfile = (id: string, profileId: string) => {
    if (!profileId) throw new Error("Jira remote read requires an authenticated profile.");
    const connection = connections().find((item) => item.id === id && item.enabled && item.profileId === profileId);
    if (!connection) throw new Error("Jira connection was not found in this profile.");
    return connection;
  };
  const workspaceForProfile = (workspaceId: string, profileId: string) => {
    const workspace = ctx
      .getState()
      .workspaces.find((item: any) => item.id === workspaceId && (item.profileId || "default") === profileId);
    if (!workspace || !["jira", "jira-board"].includes(workspace.kind))
      throw new Error("Jira workspace was not found in this profile.");
    return workspace;
  };
  const savedViewsFor = (workspaceId: string, profileId: string): JiraSavedWorkspaceView[] => {
    const workspace = workspaceForProfile(workspaceId, profileId);
    const stored = ctx.jiraCache?.listSavedViews?.(profileId, workspaceId) || [];
    let views: JiraSavedWorkspaceView[] = stored.map((row: any) => row.value).filter(isSavedWorkspaceView);
    views = views.map((view) => {
      let canonical = view;
      if (view.mode !== "sprints" && view.sprintId !== null) canonical = { ...canonical, sprintId: null };
      if (view.projectKeys !== undefined) {
        const projectKeys = normalizeJiraProjectKeys(view.projectKeys);
        if (JSON.stringify(projectKeys) !== JSON.stringify(view.projectKeys)) canonical = { ...canonical, projectKeys };
      }
      if (canonical !== view)
        ctx.jiraCache?.saveView?.({ profileId, workspaceId, viewId: view.viewId, value: canonical, active: false });
      return canonical;
    });
    if (workspace.kind === "jira-board" && workspace.jiraBoard && workspace.jiraBoard.projectKeys !== undefined) {
      const pinnedView = views.find((view) => view.kind === "board");
      if (pinnedView && pinnedView.projectKeys === undefined) {
        const canonical = { ...pinnedView, projectKeys: normalizeJiraProjectKeys(workspace.jiraBoard.projectKeys) };
        ctx.jiraCache?.saveView?.({
          profileId,
          workspaceId,
          viewId: canonical.viewId,
          value: canonical,
          active: false,
        });
        views = views.map((view) => (view.viewId === canonical.viewId ? canonical : view));
      }
    }
    if (workspace.kind === "jira-board" && workspace.jiraBoard && !views.some((view) => view.kind === "board")) {
      const boardId = Number(workspace.jiraBoard.boardId);
      const view: JiraSavedWorkspaceView = {
        viewId: `pinned-${workspace.id}`,
        kind: "board",
        connectionId: String(workspace.jiraBoard.connectionId),
        boardId: Number.isFinite(boardId) ? boardId : null,
        boardName: String(workspace.jiraBoard.boardName || workspace.name || "Jira board").slice(0, 200),
        title: String(workspace.jiraBoard.boardName || workspace.name || "Jira board").slice(0, 200),
        mode: "issues",
        sprintId: null,
        quickFilterIds: [],
        assignee: null,
        doneWithinDays: null,
        ...(workspace.jiraBoard.projectKeys !== undefined
          ? { projectKeys: normalizeJiraProjectKeys(workspace.jiraBoard.projectKeys) }
          : {}),
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      if (view.boardId !== null && view.connectionId) {
        ctx.jiraCache?.saveView?.({ profileId, workspaceId, viewId: view.viewId, value: view, active: true });
        views = [view];
      }
    }
    return views.filter((view) => view && typeof view.viewId === "string" && view.connectionId);
  };
  const makeWorkspaceViewsState = (workspaceId: string, profileId: string): JiraWorkspaceViewsState => {
    workspaceForProfile(workspaceId, profileId);
    const views = savedViewsFor(workspaceId, profileId);
    const activeViewId = ctx.jiraCache?.getActiveView?.(profileId, workspaceId) || "issues";
    const state: JiraWorkspaceViewsState = {
      workspaceId,
      profileId,
      views: [{ viewId: "issues", kind: "issues", title: "Jira" }, ...views],
      activeViewId:
        views.some((view) => view.viewId === activeViewId) || activeViewId === "issues" ? activeViewId : "issues",
      syncByViewId: {},
    };
    const key = viewStateKey(profileId, workspaceId);
    const previous = viewSyncStates.get(key);
    for (const view of views) {
      const sync = previous?.syncByViewId[view.viewId];
      if (sync) state.syncByViewId[view.viewId] = sync;
    }
    viewSyncStates.set(key, state);
    return state;
  };
  const snapshotWorkspaceViews = (): JiraWorkspaceViewsSnapshot => {
    // A Jira workspace nobody has opened yet still shows its saved-view tabs: built from local state, no Jira call.
    for (const workspace of ctx.getState().workspaces as Array<{ id: string; kind?: string; profileId?: string }>) {
      if (workspace.kind !== "jira" && workspace.kind !== "jira-board") continue;
      const profileId = workspace.profileId || "default";
      if (!viewSyncStates.has(viewStateKey(profileId, workspace.id))) makeWorkspaceViewsState(workspace.id, profileId);
    }
    const snapshot: JiraWorkspaceViewsSnapshot = {};
    for (const state of viewSyncStates.values()) {
      const polling = ctx.getJiraPollingStatus?.(state.profileId);
      snapshot[state.workspaceId] =
        polling && Object.keys(polling).length ? { ...state, pollingByQueryId: polling } : state;
    }
    return snapshot;
  };
  const setViewSyncStatus = (
    profileId: string,
    workspaceId: string,
    viewId: string,
    status: JiraWorkspaceViewsState["syncByViewId"][string],
    expectedUpdatedAt?: number,
  ) => {
    if (viewSyncDisposed) return;
    const currentView = savedViewsFor(workspaceId, profileId).find((view) => view.viewId === viewId);
    if (!currentView || (expectedUpdatedAt !== undefined && currentView.updatedAt !== expectedUpdatedAt)) return;
    const state = makeWorkspaceViewsState(workspaceId, profileId);
    const previousSync = state.syncByViewId[viewId];
    state.syncByViewId[viewId] =
      status.state !== "idle" && previousSync?.syncedAt !== undefined
        ? { ...status, syncedAt: previousSync.syncedAt }
        : status;
    ctx.broadcastState?.();
  };
  const syncWorkspaceView = async (
    profileId: string,
    workspaceId: string,
    view: JiraSavedWorkspaceView,
    forceRefresh = true,
  ) => {
    if (viewSyncDisposed) return;
    const currentView = savedViewsFor(workspaceId, profileId).find((item) => item.viewId === view.viewId);
    if (!currentView || currentView.updatedAt !== view.updatedAt) return;
    const flightKey = `${viewStateKey(profileId, workspaceId)}:${view.viewId}`;
    const previousStatus = viewSyncStates.get(viewStateKey(profileId, workspaceId))?.syncByViewId[view.viewId];
    const shouldForceRefresh = forceRefresh || previousStatus?.state === "error";
    const existing = viewFlights.get(flightKey);
    if (existing) {
      if (shouldForceRefresh && !viewFlightForceRefresh.get(flightKey)) {
        queuedForceRefresh.add(flightKey);
        setViewSyncStatus(
          profileId,
          workspaceId,
          view.viewId,
          { state: "syncing", startedAt: Date.now() },
          view.updatedAt,
        );
        await existing;
        const latest = savedViewsFor(workspaceId, profileId).find((saved) => saved.viewId === view.viewId);
        queuedForceRefresh.delete(flightKey);
        if (!viewSyncDisposed && latest?.updatedAt === view.updatedAt)
          return syncWorkspaceView(profileId, workspaceId, latest, true);
      }
      return existing;
    }
    const flight = (async () => {
      setViewSyncStatus(
        profileId,
        workspaceId,
        view.viewId,
        { state: "syncing", startedAt: Date.now() },
        view.updatedAt,
      );
      try {
        const connection = getForProfile(view.connectionId, profileId);
        if (view.kind === "personal") {
          const identity = connection.ownIdentity;
          if (
            !identity ||
            (identity.kind === "cloud" && !identity.accountId) ||
            (identity.kind === "data-center" && !identity.name)
          )
            throw new Error("Choose and verify a personal Jira identity before syncing this view.");
          const result = await manager.searchPage(
            connection,
            ownIssuesJql(identity, "", view.personalScope ?? "open"),
            50,
            undefined,
            {
              forceRefresh: shouldForceRefresh,
              projectKeys: view.projectKeys,
            },
          );
          if (!result) throw new Error("Jira personal issue refresh returned no result.");
          if (result.cache.refreshError) throw refreshFailure(result.cache.refreshError);
        } else if (view.boardId !== null) {
          const result = await manager.boardView(
            connection,
            view.boardId,
            view.mode,
            undefined,
            view.mode === "sprints" ? (view.sprintId ?? undefined) : undefined,
            {
              quickFilterIds: view.quickFilterIds,
              assignee:
                view.assignee?.kind === "user" ? { kind: "user", id: view.assignee.id } : view.assignee || undefined,
              doneWithinDays: view.doneWithinDays ?? undefined,
              forceRefresh: shouldForceRefresh,
              projectKeys: view.projectKeys,
            },
          );
          if (!result) throw new Error("Jira board refresh returned no result.");
          if (result.cache?.refreshError) throw refreshFailure(result.cache.refreshError);
        }
        logJiraRecovered(connection.id, `view-sync:${view.viewId}`);
        if (!queuedForceRefresh.has(flightKey))
          setViewSyncStatus(
            profileId,
            workspaceId,
            view.viewId,
            { state: "idle", syncedAt: Date.now() },
            view.updatedAt,
          );
      } catch (error) {
        const failure = jiraErrorFields(error);
        logJiraFailure(
          { connectionId: view.connectionId, scope: `view-sync:${view.viewId}`, code: failure.code },
          { workspaceId, ...failure },
        );
        if (!queuedForceRefresh.has(flightKey))
          setViewSyncStatus(
            profileId,
            workspaceId,
            view.viewId,
            {
              state: "error",
              error: viewError(error),
              failedAt: Date.now(),
              ...(error instanceof JiraRequestError
                ? {
                    code: error.code,
                    ...(error.retryAfterMs !== undefined ? { retryAfterMs: error.retryAfterMs } : {}),
                  }
                : {}),
            },
            view.updatedAt,
          );
      }
    })();
    viewFlights.set(flightKey, flight);
    viewFlightForceRefresh.set(flightKey, shouldForceRefresh);
    try {
      await flight;
    } finally {
      if (viewFlights.get(flightKey) === flight) {
        viewFlights.delete(flightKey);
        viewFlightForceRefresh.delete(flightKey);
      }
      if (!viewSyncDisposed) {
        const latest = savedViewsFor(workspaceId, profileId).find((saved) => saved.viewId === view.viewId);
        if (latest && latest.updatedAt !== view.updatedAt)
          runBackgroundViewSync(syncWorkspaceView(profileId, workspaceId, latest, shouldForceRefresh));
      }
    }
  };
  const syncSavedViewsForWorkspace = async (
    profileId: string,
    workspaceId: string,
    selectedViewId?: string,
    forceRefresh = true,
  ) => {
    const views = savedViewsFor(workspaceId, profileId);
    const selected = selectedViewId ? views.filter((view) => view.viewId === selectedViewId) : views;
    // Shared manager scheduler bounds individual Jira requests; this worker caps concurrent view work as well.
    let next = 0;
    const workers = Array.from({ length: Math.min(3, selected.length) }, async () => {
      while (next < selected.length) {
        if (viewSyncDisposed) return;
        await syncWorkspaceView(profileId, workspaceId, selected[next++], forceRefresh);
      }
    });
    await Promise.all(workers);
    return makeWorkspaceViewsState(workspaceId, profileId);
  };
  const runBackgroundViewSync = (operation: Promise<unknown>) => {
    void operation.catch((error) => {
      if (!viewSyncDisposed) log.warn("jira workspace view sync could not be scheduled", jiraErrorFields(error));
    });
  };
  // No periodic sync: a view refreshes when somebody opens or switches to it, returns to it, or asks for it.
  const stopJiraWorkspaceViewSync = () => {
    viewSyncDisposed = true;
    queuedForceRefresh.clear();
  };
  const saveWorkspaceView = async (profileId: string, input: { workspaceId: string; view: JiraWorkspaceViewInput }) => {
    const workspace = workspaceForProfile(input.workspaceId, profileId);
    const draft = input.view;
    const connection = getForProfile(draft.connectionId, profileId);
    if (draft.kind !== "board" && draft.kind !== "personal") throw new Error("Jira view kind is invalid.");
    if (draft.kind === "personal" && draft.boardId != null)
      throw new Error("Personal Jira views cannot target a board.");
    if (draft.kind === "board" && (!Number.isInteger(draft.boardId) || Number(draft.boardId) < 1))
      throw new Error("Jira board view requires a valid board ID.");
    if (draft.kind === "personal" && !connection.ownIdentity) throw new Error("Verify a personal Jira identity first.");
    const existing = savedViewsFor(input.workspaceId, profileId);
    const stable = existing.find(
      (item) =>
        item.connectionId === connection.id && item.kind === draft.kind && item.boardId === (draft.boardId ?? null),
    );
    const requested =
      typeof draft.viewId === "string" ? existing.find((item) => item.viewId === draft.viewId) : undefined;
    if (!stable && !requested && existing.length >= 50)
      throw new Error("A Jira workspace can contain at most 50 saved views.");
    const viewId = stable?.viewId || requested?.viewId || randomUUID();
    const prior = stable || requested;
    const now = Date.now();
    const nextBoardName = String(
      draft.boardName || prior?.boardName || (draft.kind === "personal" ? "My issues" : "Jira board"),
    )
      .trim()
      .slice(0, 200);
    const incomingTitle = String(
      draft.title || draft.boardName || prior?.title || (draft.kind === "personal" ? "My issues" : "Jira board"),
    )
      .trim()
      .slice(0, 200);
    const keepCustomTitle = !!prior && prior.title !== prior.boardName && incomingTitle === nextBoardName;
    const view: JiraSavedWorkspaceView = {
      viewId,
      kind: draft.kind,
      connectionId: connection.id,
      boardId: draft.boardId ?? null,
      boardName: nextBoardName,
      title: keepCustomTitle ? prior.title : incomingTitle,
      mode: draft.mode || prior?.mode || "issues",
      sprintId: (draft.mode || prior?.mode || "issues") === "sprints" ? (draft.sprintId ?? null) : null,
      quickFilterIds: Array.isArray(draft.quickFilterIds)
        ? [...new Set(draft.quickFilterIds.filter((id) => Number.isInteger(id) && id >= 0))].slice(0, 50)
        : prior?.quickFilterIds || [],
      assignee: "assignee" in draft ? (draft.assignee ?? null) : (prior?.assignee ?? null),
      doneWithinDays: "doneWithinDays" in draft ? (draft.doneWithinDays ?? null) : (prior?.doneWithinDays ?? null),
      ...(draft.presentation !== undefined || prior?.presentation !== undefined
        ? { presentation: draft.presentation ?? prior?.presentation }
        : {}),
      ...(Object.hasOwn(draft, "statusFilter") || prior?.statusFilter !== undefined
        ? { statusFilter: Object.hasOwn(draft, "statusFilter") ? (draft.statusFilter ?? null) : prior?.statusFilter }
        : {}),
      ...(Object.hasOwn(draft, "personalScope") || prior?.personalScope !== undefined
        ? { personalScope: Object.hasOwn(draft, "personalScope") ? draft.personalScope : prior?.personalScope }
        : {}),
      ...(Object.hasOwn(draft, "projectKeys")
        ? draft.projectKeys === null
          ? {}
          : { projectKeys: normalizeJiraProjectKeys(draft.projectKeys ?? undefined) }
        : prior?.projectKeys !== undefined
          ? { projectKeys: prior.projectKeys }
          : {}),
      createdAt: prior?.createdAt || now,
      updatedAt: now,
    };
    view.updatedAt = prior && sameViewData(prior, view) ? prior.updatedAt : Math.max(now, (prior?.updatedAt || 0) + 1);
    if (
      !ctx.jiraCache?.saveView?.({
        profileId,
        workspaceId: input.workspaceId,
        viewId,
        value: view,
        active: !prior,
      })
    )
      throw new Error("Jira workspace view could not be saved to the local database.");
    if (
      workspace.kind === "jira-board" &&
      workspace.jiraBoard &&
      view.kind === "board" &&
      workspace.jiraBoard.connectionId === view.connectionId &&
      workspace.jiraBoard.boardId === String(view.boardId)
    ) {
      await ctx.store.mutate((stateDraft: any) => {
        const pinnedWorkspace = stateDraft.workspaces.find(
          (item: any) => item.id === input.workspaceId && (item.profileId || "default") === profileId,
        );
        if (!pinnedWorkspace?.jiraBoard) return;
        if (view.projectKeys === undefined) delete pinnedWorkspace.jiraBoard.projectKeys;
        else pinnedWorkspace.jiraBoard.projectKeys = view.projectKeys;
      });
    }
    ctx.broadcastState?.();
    if (!prior || view.updatedAt !== prior.updatedAt)
      runBackgroundViewSync(syncSavedViewsForWorkspace(profileId, input.workspaceId, viewId, false));
    return makeWorkspaceViewsState(input.workspaceId, profileId);
  };
  const renameWorkspaceView = (profileId: string, input: { workspaceId: string; viewId: string; title: string }) => {
    workspaceForProfile(input.workspaceId, profileId);
    const view = savedViewsFor(input.workspaceId, profileId).find((item) => item.viewId === input.viewId);
    if (!view) throw new Error("Jira workspace view was not found.");
    const renamed = { ...view, title: input.title.trim() };
    if (!ctx.jiraCache?.renameSavedView?.(profileId, input.workspaceId, input.viewId, renamed))
      throw new Error("Jira workspace view could not be renamed.");
    ctx.broadcastState?.();
    return makeWorkspaceViewsState(input.workspaceId, profileId);
  };
  const reorderWorkspaceViews = (profileId: string, input: { workspaceId: string; viewIds: string[] }) => {
    workspaceForProfile(input.workspaceId, profileId);
    const views = savedViewsFor(input.workspaceId, profileId);
    if (
      input.viewIds.length !== views.length ||
      new Set(input.viewIds).size !== views.length ||
      views.some((view) => !input.viewIds.includes(view.viewId))
    )
      throw new Error("Jira workspace view order must include every saved view exactly once.");
    if (!ctx.jiraCache?.reorderSavedViews?.(profileId, input.workspaceId, input.viewIds))
      throw new Error("Jira workspace view order could not be saved.");
    ctx.broadcastState?.();
    return makeWorkspaceViewsState(input.workspaceId, profileId);
  };
  const refreshPersonalViewsForConnection = (profileId: string, connectionId: string) => {
    const workspaces = ctx
      .getState()
      .workspaces.filter(
        (workspace: any) =>
          (workspace.profileId || "default") === profileId && ["jira", "jira-board"].includes(workspace.kind),
      );
    for (const workspace of workspaces) {
      for (const view of savedViewsFor(workspace.id, profileId)) {
        if (view.kind === "personal" && view.connectionId === connectionId)
          runBackgroundViewSync(syncWorkspaceView(profileId, workspace.id, view, false));
      }
    }
  };
  const authModeFor = (connection: JiraConnection) =>
    connection.auth.kind === "cloud-api-token"
      ? "cloud-api-token"
      : connection.auth.kind === "dc-apim"
        ? "apim"
        : "pat";
  const logVerification = (
    level: "info" | "warn",
    event: string,
    {
      windowId,
      ...rest
    }: {
      requestId: string;
      operation: "draft-test" | "save" | "saved-verify";
      connectionId: string;
      profileId: string;
      authMode: string;
      stage: string;
      source?: "candidate" | "persisted";
      windowId?: string;
      outcome?: string;
      code?: string;
      statusCode?: number;
      gatewayKeyPresent?: boolean;
      clientCertificatePresent?: boolean;
      certificatePasswordPresent?: boolean;
      identityPresent?: boolean;
      persistedConnectionFound?: boolean;
      persistedAuthModeMatchesCandidate?: boolean;
      persistedKeyMatchesCandidate?: boolean;
      persistedPasswordMatchesCandidate?: boolean;
      persistedCertificatePathMatchesCandidate?: boolean;
      persistedHeaderMatchesCandidate?: boolean;
      persistedApiBaseUrlMatchesCandidate?: boolean;
    },
  ) =>
    log[level](event, {
      ...rest,
      ...(windowId ? { window: createHash("sha256").update(windowId).digest("hex").slice(0, 8) } : {}),
      routeFamily: "jira-rest-api",
      endpoint:
        rest.authMode === "cloud-api-token"
          ? "/rest/api/3/myself"
          : rest.authMode === "apim"
            ? "/rest/api/latest/myself"
            : "/rest/api/2/myself",
      method: "GET",
      resource: "myself",
    });
  const issueByRef = async (ref: JiraWriteIssue, windowId?: string) => {
    const issue = await manager.issue(get(ref.connectionId, windowId), ref.issueId);
    if (issue.ref.issueId !== ref.issueId || issue.ref.connectionId !== ref.connectionId)
      throw new Error("Jira issue reference does not match the selected connection.");
    return issue;
  };
  const safeErrorCodes: readonly string[] = JIRA_SAFE_ERROR_CODES;
  manager.setHealthObserver?.(async ({ connection, code }: { connection: JiraConnection; code?: string }) => {
    const stored = connections().find((item) => item.id === connection.id && item.profileId === connection.profileId);
    if (!stored) return;
    const checkedAt = new Date().toISOString();
    if (code) {
      if (stored.status === "needs-login" && stored.health?.state === code) return;
      await ctx.store.mutate((draft: any) => {
        const current = draft.settings.integrations.jira.connections.find(
          (item: JiraConnection) => item.id === stored.id && item.profileId === stored.profileId,
        );
        if (!current) return;
        current.health = { state: code, checkedAt };
        current.status = "needs-login";
      });
      log.warn("jira connection needs sign-in", { connectionId: stored.id, profileId: stored.profileId, code });
    } else {
      if (!stored.status && !stored.health) return;
      if (stored.status === "connected" && (!stored.health || stored.health.state === "verified")) return;
      await ctx.store.mutate((draft: any) => {
        const current = draft.settings.integrations.jira.connections.find(
          (item: JiraConnection) => item.id === stored.id && item.profileId === stored.profileId,
        );
        if (!current) return;
        current.health = { state: "verified", checkedAt };
        current.status = "connected";
      });
      log.info("jira connection sign-in works again", { connectionId: stored.id, profileId: stored.profileId });
    }
    ctx.broadcastState?.();
  });
  const invokeWrite = async (operation: () => Promise<any>) => {
    try {
      const result = await operation();
      return jiraWriteInvokeResultDtoSchema.parse({
        ok: true,
        data: { status: result?.status || "succeeded", journalId: result?.journalId },
      });
    } catch (error) {
      const raw = error as Error & { code?: string; journalId?: string; status?: string; retryAfterMs?: number };
      const code =
        typeof raw.code === "string" && safeErrorCodes.includes(raw.code)
          ? raw.code
          : error instanceof Error && /another profile|forbidden/i.test(error.message)
            ? "forbidden"
            : "validation-failed";
      const ownMessage =
        error instanceof JiraRequestError ||
        error instanceof JiraWriteSafetyError ||
        error instanceof JiraWriteJournalError;
      if (!raw.journalId) log.warn("jira write was refused before it started", { ...jiraErrorFields(error), code });
      const message = ownMessage
        ? raw.message.slice(0, 500)
        : "Jira write was not sent. Review the issue, permissions, and confirmation, then prepare a new preview.";
      return jiraWriteInvokeResultDtoSchema.parse({
        ok: false,
        error: {
          code,
          message,
          ...(raw.journalId ? { journalId: raw.journalId } : {}),
          ...(raw.status === "unknown" || raw.status === "failed" ? { status: raw.status } : {}),
          ...(typeof raw.retryAfterMs === "number" ? { retryAfterMs: raw.retryAfterMs } : {}),
        },
      });
    }
  };
  const writesByWindow = new Map<string, JiraWriteSafety>();
  const journalsByProfile = new Map<string, JiraWriteJournal>();
  const journalFor = (profileId: string) => {
    let journal = journalsByProfile.get(profileId);
    if (!journal) {
      const ref = `jira:write-journal:${profileId}`;
      journal = new JiraWriteJournal({
        store: {
          async load() {
            const raw = ctx.credentialStore.getSecret(ref);
            if (!raw) return undefined;
            try {
              return JSON.parse(raw);
            } catch {
              throw new Error("Jira write journal storage is invalid; writes are blocked safely.");
            }
          },
          async save(state) {
            if (!ctx.credentialStore.isEncryptionAvailable())
              throw new Error("Encrypted storage is required for Jira write safety.");
            await ctx.credentialStore.setSecret(ref, JSON.stringify(state), { requireEncryptedStorage: true });
          },
        },
      });
      journalsByProfile.set(profileId, journal);
    }
    return journal;
  };
  const writesFor = (windowId: string) => {
    const profileId = getViewerProfileId(windowId);
    const writesKey = `${windowId}:${profileId}`;
    let writes = writesByWindow.get(writesKey);
    if (!writes) {
      writes = new JiraWriteSafety({
        listTransitions: async (ref) => manager.transitions(get(ref.connectionId, windowId), ref.issueId),
        transition: async (ref, transitionId, fields) =>
          manager.transition(get(ref.connectionId, windowId), ref.issueId, transitionId, fields),
        addComment: async (ref, body) => manager.addComment(get(ref.connectionId, windowId), ref.issueId, body),
        addRemoteLink: async (ref, data) => manager.addRemoteLink(get(ref.connectionId, windowId), ref.issueId, data),
        addWorklog: async (ref, data) => manager.addWorklog(get(ref.connectionId, windowId), ref.issueId, data),
        assign: async (ref, target) => manager.assign(get(ref.connectionId, windowId), ref.issueId, target),
        currentAssignee: async (ref) => manager.currentAssignee(get(ref.connectionId, windowId), ref.issueId),
        resolveMe: async (connectionId) => {
          const own = get(connectionId, windowId).ownIdentity;
          if (!own) return undefined;
          return own.kind === "cloud"
            ? { kind: "cloud" as const, accountId: own.accountId, displayName: own.displayName }
            : { kind: "data-center" as const, name: own.name, displayName: own.displayName };
        },
        uploadAttachment: async (ref, file) =>
          manager.uploadAttachment(
            get(ref.connectionId, windowId),
            ref.issueId,
            file.fileName,
            file.mediaType,
            file.bytes,
          ),
        countAttachmentsLike: async (ref, match) =>
          (await manager.issueAttachments(get(ref.connectionId, windowId), ref.issueId)).filter(
            (attachment: { fileName: string; sizeBytes: number }) =>
              jiraWriteNameHash(attachment.fileName) === match.nameHash && attachment.sizeBytes === match.size,
          ).length,
        getMyself: async (connectionId) => {
          const { identity } = await manager.verify(get(connectionId, windowId));
          return identity.kind === "cloud"
            ? { kind: "cloud", accountId: identity.accountId }
            : { kind: "data-center", name: identity.name };
        },
        canWorklog: async (connectionId, issue) => manager.canWorklog(get(connectionId, windowId), issue.issueId),
        journal: journalFor(profileId),
        getAuditContext: async (issue) => {
          const connection = get(issue.connectionId, windowId);
          const identity = connection.verifiedIdentity;
          const profileName = ctx.getState().profiles?.find((profile: any) => profile.id === profileId)?.name;
          const actor =
            identity?.kind === "cloud"
              ? { kind: "cloud" as const, accountId: identity.accountId }
              : identity?.kind === "data-center"
                ? { kind: "data-center" as const, name: identity.name }
                : undefined;
          return {
            profileId,
            requester: typeof profileName === "string" && profileName.trim() ? profileName : "Desktop user",
            apiActor: identity
              ? `${identity.displayName} (${identity.kind === "cloud" ? identity.accountId : identity.name})`
              : "strIDEterm",
            ...(actor ? { actor } : {}),
            commentAttribution: {
              setting: normalizeJiraCommentAttribution(ctx.getState().settings.integrations.jira?.commentAttribution),
              names: {
                user: connection.ownIdentity?.displayName,
                profile: typeof profileName === "string" ? profileName : undefined,
                account: identity?.displayName,
              },
            },
          };
        },
        freshIssueState: async (issue) => manager.freshIssueState(get(issue.connectionId, windowId), issue.issueId),
        reconcile: async (entry: JiraWriteJournalEntry) => {
          const connection = get(entry.connectionId, windowId);
          const metadata = entry.metadata;
          if (metadata.kind === "transition") {
            const state = await manager.freshIssueState(connection, entry.issueId);
            if (state.status === metadata.targetStatus && state.updated !== metadata.beforeUpdatedAt) return "applied";
            if (state.status === metadata.beforeStatus && state.updated === metadata.beforeUpdatedAt)
              return "not-applied";
            return "unresolved";
          }
          if (metadata.kind === "comment") {
            const outcome = await manager.reconcileCommentWrite(connection, entry.issueId, {
              fingerprint: metadata.bodyHash,
              submittedAt: metadata.submittedAt,
              ...(connection.verifiedIdentity
                ? {
                    actor:
                      connection.verifiedIdentity.kind === "cloud"
                        ? { kind: "cloud" as const, accountId: connection.verifiedIdentity.accountId }
                        : { kind: "data-center" as const, name: connection.verifiedIdentity.name },
                  }
                : {}),
            });
            return outcome === "unknown" ? "unresolved" : outcome;
          }
          if (metadata.kind === "worklog") {
            const outcome = await manager.reconcileWorklogWrite(connection, entry.issueId, {
              fingerprint: metadata.fingerprint,
              submittedAt: metadata.submittedAt,
              seconds: metadata.seconds,
              started: metadata.started,
              commentHash: metadata.commentHash,
              ...(connection.verifiedIdentity
                ? {
                    actor:
                      connection.verifiedIdentity.kind === "cloud"
                        ? { kind: "cloud" as const, accountId: connection.verifiedIdentity.accountId }
                        : { kind: "data-center" as const, name: connection.verifiedIdentity.name },
                  }
                : {}),
            });
            return outcome === "unknown" ? "unresolved" : outcome;
          }
          if (metadata.kind === "assign") {
            const current = await manager.currentAssignee(connection, entry.issueId);
            if (current.id === metadata.target) return "applied";
            if (current.id === metadata.beforeAssignee) return "not-applied";
            return "unresolved";
          }
          if (metadata.kind === "attachment") {
            const now = (await manager.issueAttachments(connection, entry.issueId)).filter(
              (attachment: { fileName: string; sizeBytes: number }) =>
                jiraWriteNameHash(attachment.fileName) === metadata.nameHash && attachment.sizeBytes === metadata.size,
            ).length;
            return now > metadata.beforeCount ? "applied" : "not-applied";
          }
          return (await manager.hasRemoteLink(connection, entry.issueId, metadata.globalId))
            ? "applied"
            : "not-applied";
        },
      });
      writesByWindow.set(writesKey, writes);
    }
    return writes;
  };
  const findInbox = (resolvedProfileId: string) =>
    ctx
      .getState()
      .workspaces.find(
        (workspace: any) => workspace.kind === "jira" && (workspace.profileId || "default") === resolvedProfileId,
      );
  // The inbox has no checkout, but its cwd must exist: a build that does not know `kind: "jira"` prunes a
  // workspace whose cwd is missing, and the data dir is shared by every build that runs against it.
  const ensureInboxDir = async (cwd: string) => {
    try {
      await mkdir(cwd, { recursive: true });
    } catch (err) {
      log.warn("Jira inbox directory could not be created", { cwd, err: (err as Error)?.message || String(err) });
    }
  };
  const ensureWorkspaceForProfile = async (profileId: string | null | undefined) => {
    const resolvedProfileId = profileId || "default";
    const existing = findInbox(resolvedProfileId);
    if (existing) {
      if (existing.cwd) await ensureInboxDir(existing.cwd);
      return existing;
    }
    const inboxCwd = path.join(strideDataDir(), "jira-inbox", resolvedProfileId);
    await ensureInboxDir(inboxCwd);
    const workspace = normalizeWorkspace({
      id: `workspace-${randomUUID()}`,
      name: "Jira",
      icon: "J",
      color: "#2684ff",
      kind: "jira",
      cwd: inboxCwd,
      notes: "Jira issue inbox",
      profileId: resolvedProfileId,
      panels: [],
      activePanelId: "",
    });
    // Checked again inside the mutator: two windows asking at once must end with one inbox.
    let added = false;
    await ctx.store.mutate((draft: any) => {
      if (
        draft.workspaces.some(
          (item: any) => item.kind === "jira" && (item.profileId || "default") === resolvedProfileId,
        )
      )
        return;
      draft.workspaces.push(workspace);
      added = true;
    });
    if (added) ctx.broadcastState?.();
    return findInbox(resolvedProfileId) ?? workspace;
  };
  return {
    getJiraWorkspaceViewsSnapshot: snapshotWorkspaceViews,
    forgetJiraProfileViewState(profileId: string) {
      for (const key of [...viewSyncStates.keys()]) if (key.startsWith(`${profileId}:`)) viewSyncStates.delete(key);
    },
    /** A deleted profile's write history follows its connections, so a repeat is still blocked and unknown writes can be reconciled. */
    async moveJiraProfileWriteJournal(fromProfileId: string, toProfileId: string) {
      if (fromProfileId === toProfileId) return 0;
      const entries = await journalFor(fromProfileId).exportAll();
      const moved = entries.length ? await journalFor(toProfileId).absorb(entries, toProfileId) : 0;
      await ctx.credentialStore.deleteSecret(`jira:write-journal:${fromProfileId}`);
      journalsByProfile.delete(fromProfileId);
      for (const key of [...writesByWindow.keys()]) if (key.endsWith(`:${fromProfileId}`)) writesByWindow.delete(key);
      return moved;
    },
    stopJiraWorkspaceViewSync,
    async getJiraWorkspaceViews(input: { workspaceId: string }, windowId: string) {
      const profileId = getViewerProfileId(windowId);
      runBackgroundViewSync(syncSavedViewsForWorkspace(profileId, input.workspaceId, undefined, false));
      return makeWorkspaceViewsState(input.workspaceId, profileId);
    },
    async saveJiraWorkspaceView(input: { workspaceId: string; view: JiraWorkspaceViewInput }, windowId: string) {
      return saveWorkspaceView(getViewerProfileId(windowId), input);
    },
    async getJiraWorkspaceProjectScope(input: { workspaceId: string; connectionId: string }, windowId: string) {
      const profileId = getViewerProfileId(windowId);
      workspaceForProfile(input.workspaceId, profileId);
      getForProfile(input.connectionId, profileId);
      return jiraWorkspaceProjectScopeDtoSchema.parse(
        ctx.jiraCache?.getWorkspaceProjectScope?.(profileId, input.workspaceId, input.connectionId) ?? null,
      );
    },
    async setJiraWorkspaceProjectScope(
      input: { workspaceId: string; connectionId: string; projectKeys: string[] | null },
      windowId: string,
    ) {
      const profileId = getViewerProfileId(windowId);
      workspaceForProfile(input.workspaceId, profileId);
      getForProfile(input.connectionId, profileId);
      const projectKeys = input.projectKeys === null ? null : normalizeJiraProjectKeys(input.projectKeys);
      if (!ctx.jiraCache?.setWorkspaceProjectScope?.({ profileId, ...input, projectKeys }))
        throw new Error("Jira workspace project scope could not be saved.");
      ctx.broadcastState?.();
      return jiraWorkspaceProjectScopeDtoSchema.parse(projectKeys);
    },
    async renameJiraWorkspaceView(input: { workspaceId: string; viewId: string; title: string }, windowId: string) {
      return renameWorkspaceView(getViewerProfileId(windowId), input);
    },
    async reorderJiraWorkspaceViews(input: { workspaceId: string; viewIds: string[] }, windowId: string) {
      return reorderWorkspaceViews(getViewerProfileId(windowId), input);
    },
    async removeJiraWorkspaceView(input: { workspaceId: string; viewId: string }, windowId: string) {
      const profileId = getViewerProfileId(windowId);
      workspaceForProfile(input.workspaceId, profileId);
      if (!ctx.jiraCache?.removeSavedView?.(profileId, input.workspaceId, input.viewId))
        throw new Error("Jira workspace view was not found.");
      const state = makeWorkspaceViewsState(input.workspaceId, profileId);
      ctx.broadcastState?.();
      return state;
    },
    async setJiraWorkspaceActiveView(input: { workspaceId: string; viewId: string }, windowId: string) {
      const profileId = getViewerProfileId(windowId);
      workspaceForProfile(input.workspaceId, profileId);
      if (!ctx.jiraCache?.setActiveView?.(profileId, input.workspaceId, input.viewId))
        throw new Error("Jira workspace view was not found.");
      ctx.broadcastState?.();
      if (input.viewId !== "issues") {
        const view = savedViewsFor(input.workspaceId, profileId).find((item) => item.viewId === input.viewId);
        if (view) runBackgroundViewSync(syncWorkspaceView(profileId, input.workspaceId, view, false));
      }
      return makeWorkspaceViewsState(input.workspaceId, profileId);
    },
    async refreshJiraWorkspaceViews(input: { workspaceId: string; viewId?: string }, windowId: string) {
      const profileId = getViewerProfileId(windowId);
      workspaceForProfile(input.workspaceId, profileId);
      runBackgroundViewSync(syncSavedViewsForWorkspace(profileId, input.workspaceId, input.viewId));
      return makeWorkspaceViewsState(input.workspaceId, profileId);
    },
    async jiraRemoteGetWorkspaceViews(input: { workspaceId: string }, profileId: string) {
      runBackgroundViewSync(syncSavedViewsForWorkspace(profileId, input.workspaceId, undefined, false));
      return makeWorkspaceViewsState(input.workspaceId, profileId);
    },
    async jiraRemoteSaveWorkspaceView(input: { workspaceId: string; view: JiraWorkspaceViewInput }, profileId: string) {
      return saveWorkspaceView(profileId, input);
    },
    async jiraRemoteGetWorkspaceProjectScope(input: { workspaceId: string; connectionId: string }, profileId: string) {
      workspaceForProfile(input.workspaceId, profileId);
      getForProfile(input.connectionId, profileId);
      return jiraWorkspaceProjectScopeDtoSchema.parse(
        ctx.jiraCache?.getWorkspaceProjectScope?.(profileId, input.workspaceId, input.connectionId) ?? null,
      );
    },
    async jiraRemoteSetWorkspaceProjectScope(
      input: { workspaceId: string; connectionId: string; projectKeys: string[] | null },
      profileId: string,
    ) {
      workspaceForProfile(input.workspaceId, profileId);
      getForProfile(input.connectionId, profileId);
      const projectKeys = input.projectKeys === null ? null : normalizeJiraProjectKeys(input.projectKeys);
      if (!ctx.jiraCache?.setWorkspaceProjectScope?.({ profileId, ...input, projectKeys }))
        throw new Error("Jira workspace project scope could not be saved.");
      ctx.broadcastState?.();
      return jiraWorkspaceProjectScopeDtoSchema.parse(projectKeys);
    },
    async jiraRemoteRenameWorkspaceView(
      input: { workspaceId: string; viewId: string; title: string },
      profileId: string,
    ) {
      return renameWorkspaceView(profileId, input);
    },
    async jiraRemoteReorderWorkspaceViews(input: { workspaceId: string; viewIds: string[] }, profileId: string) {
      return reorderWorkspaceViews(profileId, input);
    },
    async jiraRemoteRemoveWorkspaceView(input: { workspaceId: string; viewId: string }, profileId: string) {
      workspaceForProfile(input.workspaceId, profileId);
      if (!ctx.jiraCache?.removeSavedView?.(profileId, input.workspaceId, input.viewId))
        throw new Error("Jira workspace view was not found.");
      const state = makeWorkspaceViewsState(input.workspaceId, profileId);
      ctx.broadcastState?.();
      return state;
    },
    async jiraRemoteSetWorkspaceActiveView(input: { workspaceId: string; viewId: string }, profileId: string) {
      workspaceForProfile(input.workspaceId, profileId);
      if (!ctx.jiraCache?.setActiveView?.(profileId, input.workspaceId, input.viewId))
        throw new Error("Jira workspace view was not found.");
      ctx.broadcastState?.();
      if (input.viewId !== "issues") {
        const view = savedViewsFor(input.workspaceId, profileId).find((item) => item.viewId === input.viewId);
        if (view) runBackgroundViewSync(syncWorkspaceView(profileId, input.workspaceId, view, false));
      }
      return makeWorkspaceViewsState(input.workspaceId, profileId);
    },
    async jiraRemoteRefreshWorkspaceViews(input: { workspaceId: string; viewId?: string }, profileId: string) {
      workspaceForProfile(input.workspaceId, profileId);
      runBackgroundViewSync(syncSavedViewsForWorkspace(profileId, input.workspaceId, input.viewId));
      return makeWorkspaceViewsState(input.workspaceId, profileId);
    },
    async jiraListConnections(windowId: string) {
      const profileId = getViewerProfileId(windowId);
      return jiraConnectionDtoSchema
        .array()
        .max(100)
        .parse(
          connections()
            .filter((item) => item.profileId === profileId)
            .map(({ auth, ...connection }) => ({
              ...connection,
              auth: { kind: auth.kind, ...(auth.email ? { email: auth.email } : {}) },
            })),
        );
    },
    async jiraGetRepoBindingPreference(input: { connectionId: string; projectKey: string }, windowId: string) {
      const connection = get(input.connectionId, windowId);
      const projectKey = input.projectKey.trim().toUpperCase();
      const preference = (ctx.getState().settings.integrations.jira.repoBindings || []).find(
        (item: any) =>
          item.profileId === connection.profileId &&
          item.jiraConnectionId === connection.id &&
          item.projectKey === projectKey,
      );
      return preference ? jiraRepoBindingPreferenceDtoSchema.parse(preference) : null;
    },
    async jiraEnsureWorkspace(windowId: string) {
      return ensureWorkspaceForProfile(getViewerProfileId(windowId));
    },
    async jiraRemoteEnsureWorkspace(profileId: string) {
      return ensureWorkspaceForProfile(profileId);
    },
    async jiraGetTaskContext(workspaceId: string, windowId: string) {
      const profileId = getViewerProfileId(windowId);
      const workspace = ctx
        .getState()
        .workspaces.find((item: any) => item.id === workspaceId && (item.profileId || "default") === profileId);
      if (!workspace?.task) throw new Error("Task workspace is missing or belongs to another profile.");
      return jiraTaskContextDtoSchema.parse({
        jiraIssueRefs: workspace.task.jiraIssueRefs || [],
        jiraPreparedSnapshot: workspace.task.jiraPreparedSnapshot || [],
        jiraIssueSnapshots: workspace.task.jiraIssueSnapshots || [],
      });
    },
    async jiraRemoteSearchIssues(
      input: {
        connectionId: string;
        jql: string;
        limit?: number;
        cursor?: string;
        cacheOnly?: boolean;
        forceRefresh?: boolean;
        refreshInBackground?: boolean;
        projectKeys?: string[];
      },
      profileId: string,
    ) {
      const result = await manager.searchPage(
        getForProfile(input.connectionId, profileId),
        input.jql,
        input.limit,
        input.cursor,
        {
          cacheOnly: input.cacheOnly,
          forceRefresh: input.forceRefresh,
          refreshInBackground: input.refreshInBackground,
          projectKeys: input.projectKeys,
        },
      );
      if (result === null) return null;
      return jiraSearchResultDtoSchema.parse(result);
    },
    async jiraRemoteGetRecentSearches(input: { connectionId: string; limit?: number }, profileId: string) {
      return jiraRecentSearchesDtoSchema.parse(
        manager.getRecentSearches?.(getForProfile(input.connectionId, profileId), input.limit) || [],
      );
    },
    async jiraRemoteRememberSearch(input: { connectionId: string; jql: string; label?: string }, profileId: string) {
      manager.rememberSearch?.(getForProfile(input.connectionId, profileId), input);
      return { ok: true };
    },
    async jiraRemoteGetRecentIssues(input: { connectionId: string; limit?: number }, profileId: string) {
      return jiraRecentIssuesDtoSchema.parse(
        manager.getRecentIssues?.(getForProfile(input.connectionId, profileId), input.limit) || [],
      );
    },
    async jiraRemoteRememberIssueViewed(
      input: { ref: { provider: "jira"; connectionId: string; issueId: string; issueKey: string } },
      profileId: string,
    ) {
      manager.rememberViewedIssue?.(getForProfile(input.ref.connectionId, profileId), input.ref);
      return { ok: true };
    },
    async jiraNudgePolling(windowId: string) {
      return { nudged: (await ctx.nudgeJiraPolling?.(getViewerProfileId(windowId))) ?? 0 };
    },
    async jiraRemoteNudgePolling(profileId: string) {
      if (!profileId) throw new Error("Jira remote read requires an authenticated profile.");
      return { nudged: (await ctx.nudgeJiraPolling?.(profileId)) ?? 0 };
    },
    async jiraRemoteListConnections(profileId: string) {
      if (!profileId) throw new Error("Jira remote read requires an authenticated profile.");
      return jiraConnectionDtoSchema
        .array()
        .max(100)
        .parse(
          connections()
            .filter((item) => item.enabled && item.profileId === profileId)
            .map(
              ({ auth, clientCertificatePath: _certificatePath, subscriptionHeaderName: _header, ...connection }) => ({
                ...connection,
                // Gateway coordinates and local file paths are connection administration, which is desktop-only.
                apiBaseUrl: "",
                auth: { kind: auth.kind },
              }),
            ),
        );
    },
    async jiraRemoteListQueries(connectionId: string, profileId: string) {
      getForProfile(connectionId, profileId);
      return jiraSavedQueryDtoSchema
        .array()
        .max(500)
        .parse(
          (ctx.getState().settings.integrations.jira.queries || []).filter(
            (query: any) => query.connectionId === connectionId && query.profileId === profileId,
          ),
        );
    },
    async getJiraRecentSearches(input: { connectionId: string; limit?: number }, windowId: string) {
      const connection = get(input.connectionId, windowId);
      return jiraRecentSearchesDtoSchema.parse(
        typeof manager.getRecentSearches === "function" ? manager.getRecentSearches(connection, input.limit) : [],
      );
    },
    async rememberJiraSearch(input: { connectionId: string; jql: string; label?: string }, windowId: string) {
      const connection = get(input.connectionId, windowId);
      manager.rememberSearch?.(connection, input);
      return { ok: true };
    },
    async getJiraRecentIssues(input: { connectionId: string; limit?: number }, windowId: string) {
      const connection = get(input.connectionId, windowId);
      return jiraRecentIssuesDtoSchema.parse(
        typeof manager.getRecentIssues === "function" ? manager.getRecentIssues(connection, input.limit) : [],
      );
    },
    async rememberJiraIssueViewed(
      input: { ref: { provider: "jira"; connectionId: string; issueId: string; issueKey: string } },
      windowId: string,
    ) {
      const connection = get(input.ref.connectionId, windowId);
      manager.rememberViewedIssue?.(connection, input.ref);
      return { ok: true };
    },
    async jiraRemoteBuildOwnIssuesQuery(
      input: {
        connectionId: string;
        baseJql?: string;
        personalScope?: "open" | "all";
        projectKeys?: string[];
        smartFilters?: JiraSmartFilterId[];
      },
      profileId: string,
    ) {
      const connection = getForProfile(input.connectionId, profileId);
      const identity = connection.ownIdentity;
      if (input.smartFilters?.length) return smartFilterQuery(connection, input);
      if (
        !identity ||
        (identity.kind === "cloud" && !identity.accountId) ||
        (identity.kind === "data-center" && !identity.name)
      )
        throw new Error("Choose and verify a personal Jira identity before using My issues.");
      const baseJql = typeof input.baseJql === "string" ? input.baseJql.trim() : "";
      return jiraOwnIssuesQueryDtoSchema.parse({
        jql: applyJiraProjectScope(
          ownIssuesJql(identity, baseJql, input.personalScope ?? "open"),
          input.projectKeys === undefined ? connection.projectKeys : input.projectKeys,
        ),
        identityLabel: identity.displayName,
      });
    },
    async jiraRemoteVerifyOwnIdentity(input: { connectionId: string; userId: string }, profileId: string) {
      const connection = getForProfile(input.connectionId, profileId);
      const identity = await manager.verifyUserIdentity(connection, input.userId);
      getForProfile(connection.id, profileId);
      return jiraIdentityDtoSchema.parse(identity);
    },
    async jiraRemoteSetOwnIdentity(input: { connectionId: string; userId: string }, profileId: string) {
      const connection = getForProfile(input.connectionId, profileId);
      const identity = await manager.verifyUserIdentity(connection, input.userId);
      getForProfile(connection.id, profileId);
      manager.invalidate(connection.id);
      await ctx.store.mutate((draft: any) => {
        const current = draft.settings.integrations.jira.connections.find(
          (item: JiraConnection) => item.id === connection.id && item.profileId === profileId,
        );
        if (!current || !current.enabled)
          throw new Error("Jira connection changed before its personal identity was saved.");
        current.ownIdentity = identity;
      });
      ctx.broadcastState?.();
      refreshPersonalViewsForConnection(connection.profileId, connection.id);
      return jiraIdentityDtoSchema.parse(identity);
    },
    async jiraRemoteGetIssue(
      input: {
        connectionId: string;
        issueId: string;
        cacheOnly?: boolean;
        forceRefresh?: boolean;
        refreshInBackground?: boolean;
      },
      profileId: string,
    ) {
      const issue = await manager.issue(getForProfile(input.connectionId, profileId), input.issueId, {
        cacheOnly: input.cacheOnly,
        forceRefresh: input.forceRefresh,
        refreshInBackground: input.refreshInBackground,
      });
      return issue === null ? null : jiraIssueDtoSchema.parse(issue);
    },
    async jiraRemoteListComments(input: { connectionId: string; issueId: string }, profileId: string) {
      return jiraCommentDtoSchema
        .array()
        .max(JIRA_COMMENTS_MAX)
        .parse(await manager.comments(getForProfile(input.connectionId, profileId), input.issueId));
    },
    async jiraRemoteListBoards(connectionId: string, profileId: string) {
      return jiraBoardDtoSchema
        .array()
        .max(500)
        .parse(await manager.boards(getForProfile(connectionId, profileId)));
    },
    async jiraRemoteListProjects(connectionId: string, profileId: string) {
      return jiraProjectDtoSchema
        .array()
        .max(500)
        .parse(await manager.projects(getForProfile(connectionId, profileId)));
    },
    async jiraRemoteSearchBoards(input: JiraBoardSearchPayload, profileId: string) {
      return jiraBoardSearchResultDtoSchema.parse(
        await manager.searchBoards(getForProfile(input.connectionId, profileId), input),
      );
    },
    async jiraRemoteBoardView(
      input: {
        connectionId: string;
        boardId: number;
        mode?: "issues" | "backlog" | "sprints";
        cursor?: string;
        sprintId?: number;
        quickFilterIds?: number[];
        assignee?: { kind: "user"; id: string } | { kind: "unassigned" };
        doneWithinDays?: number;
        cacheOnly?: boolean;
        forceRefresh?: boolean;
        refreshInBackground?: boolean;
        projectKeys?: string[];
      },
      profileId: string,
    ) {
      const result = await manager.boardView(
        getForProfile(input.connectionId, profileId),
        input.boardId,
        input.mode,
        input.cursor,
        input.sprintId,
        {
          quickFilterIds: input.quickFilterIds,
          assignee: input.assignee,
          doneWithinDays: input.doneWithinDays,
          cacheOnly: input.cacheOnly,
          forceRefresh: input.forceRefresh,
          refreshInBackground: input.refreshInBackground,
          projectKeys: input.projectKeys,
        },
      );
      if (result === null) return null;
      return jiraBoardViewDtoSchema.parse({ ...result, issues: jiraIssueDtoSchema.array().parse(result.issues) });
    },
    async jiraRemoteBoardQuickFilters(
      input: {
        connectionId: string;
        boardId: number;
        cursor?: string;
        limit?: number;
        cacheOnly?: boolean;
        forceRefresh?: boolean;
        refreshInBackground?: boolean;
      },
      profileId: string,
    ) {
      const result = await manager.boardQuickFilters(getForProfile(input.connectionId, profileId), input.boardId, {
        cursor: input.cursor,
        limit: input.limit,
        cacheOnly: input.cacheOnly,
        forceRefresh: input.forceRefresh,
        refreshInBackground: input.refreshInBackground,
      });
      return result === null ? null : jiraBoardQuickFiltersDtoSchema.parse(result);
    },
    async jiraRemoteSearchUsers(input: { connectionId: string; query: string; limit?: number }, profileId: string) {
      return jiraUserSearchDtoSchema.parse(
        await manager.searchUsers(getForProfile(input.connectionId, profileId), input.query, input.limit),
      );
    },
    /** Authorises a Jira issue for linking at workspace creation: same profile, same identity checks as attaching later. */
    async jiraResolveWorkItem(ref: JiraWriteIssue, windowId?: string) {
      const issue = await issueByRef(ref, windowId);
      return { ref: issue.ref, summary: issue.summary, status: issue.status };
    },
    /**
     * What an agent starting on an issue gets: the fresh issue, every comment and a reader for its attachments, all
     * through the caller's profile.
     */
    async jiraDevelopmentSource(ref: JiraWriteIssue, profileId: string) {
      const connection = getForProfile(ref.connectionId, profileId);
      const issue = await manager.issue(connection, ref.issueId, { forceRefresh: true });
      if (!issue || issue.ref.issueId !== ref.issueId || issue.ref.connectionId !== ref.connectionId)
        throw new Error("Jira issue reference does not match the selected connection.");
      const { comments, total: commentsTotal } = await manager.commentsWithTotal(connection, ref.issueId);
      return {
        issue,
        comments,
        commentsTotal,
        readAttachment: async (attachmentId: string, maxBytes: number) =>
          (await manager.attachmentBytes(connection, ref.issueId, attachmentId, { maxBytes })).bytes,
      };
    },
    async jiraAttachIssueToWorkspace(input: { workspaceId: string; ref: JiraWriteIssue }, windowId: string) {
      const profileId = getViewerProfileId(windowId);
      const workspace = ctx.getState().workspaces.find((item: any) => item.id === input.workspaceId);
      if (!workspace || (workspace.profileId || "default") !== profileId)
        throw new Error("Workspace is missing or belongs to another profile.");
      const issue = await issueByRef(input.ref, windowId);
      await ctx.store.mutate((draft: any) => {
        const current = draft.workspaces.find(
          (item: any) => item.id === input.workspaceId && (item.profileId || "default") === profileId,
        );
        if (!current) throw new Error("Workspace changed before the Jira issue was linked.");
        const items = current.workItems || (current.workItems = []);
        const index = items.findIndex(
          (item: any) => item.ref?.connectionId === issue.ref.connectionId && item.ref?.issueId === issue.ref.issueId,
        );
        const linked = { ref: issue.ref, summary: issue.summary, status: issue.status };
        if (index >= 0) items[index] = linked;
        else items.push(linked);
      });
      ctx.broadcastState?.();
      return { ok: true };
    },
    async jiraDetachIssueFromWorkspace(input: { workspaceId: string; ref: JiraWriteIssue }, windowId: string) {
      const profileId = getViewerProfileId(windowId);
      await ctx.store.mutate((draft: any) => {
        const current = draft.workspaces.find(
          (item: any) => item.id === input.workspaceId && (item.profileId || "default") === profileId,
        );
        if (!current) throw new Error("Workspace is missing or belongs to another profile.");
        current.workItems = (current.workItems || []).filter(
          (item: any) => item.ref?.connectionId !== input.ref.connectionId || item.ref?.issueId !== input.ref.issueId,
        );
      });
      ctx.broadcastState?.();
      return { ok: true };
    },
    async saveJiraCommentDraft(
      input: { sourceWorkspaceId: string; ref: JiraWriteIssue; body: string },
      windowId: string,
    ) {
      const profileId = getViewerProfileId(windowId);
      const body = input.body.trim();
      if (!body || body.length > 32_000) throw new Error("Jira comment draft must contain 1–32,000 characters.");
      const issue = await issueByRef(input.ref, windowId);
      await ctx.store.mutate((draft: any) => {
        const workspace = draft.workspaces.find(
          (item: any) => item.id === input.sourceWorkspaceId && (item.profileId || "default") === profileId,
        );
        if (!workspace) throw new Error("Task workspace is missing or belongs to another profile.");
        const sourceTaskId = workspace.task?.taskId;
        const drafts = workspace.task?.jiraCommentDrafts || (workspace.task && (workspace.task.jiraCommentDrafts = []));
        if (!drafts) throw new Error("Comment drafts can only be saved from a task workspace.");
        drafts.push({
          id: randomUUID(),
          ref: issue.ref,
          body,
          sourceWorkspaceId: workspace.id,
          ...(sourceTaskId ? { sourceTaskId } : {}),
          createdAt: new Date().toISOString(),
        });
        if (drafts.length > 100) drafts.splice(0, drafts.length - 100);
      });
      ctx.broadcastState?.();
      return { ok: true };
    },
    async listJiraCommentDrafts(sourceWorkspaceId: string, windowId: string) {
      const profileId = getViewerProfileId(windowId);
      const workspace = ctx
        .getState()
        .workspaces.find((item: any) => item.id === sourceWorkspaceId && (item.profileId || "default") === profileId);
      if (!workspace) throw new Error("Task workspace is missing or belongs to another profile.");
      return jiraCommentDraftDtoSchema
        .array()
        .max(100)
        .parse([...(workspace.jiraMcpCommentDrafts || []), ...(workspace.task?.jiraCommentDrafts || [])].slice(-100));
    },
    async deleteJiraCommentDraft(input: { sourceWorkspaceId: string; draftId: string }, windowId: string) {
      const profileId = getViewerProfileId(windowId);
      await ctx.store.mutate((draft: any) => {
        const workspace = draft.workspaces.find(
          (item: any) => item.id === input.sourceWorkspaceId && (item.profileId || "default") === profileId,
        );
        if (!workspace) throw new Error("Task workspace is missing or belongs to another profile.");
        workspace.jiraMcpCommentDrafts = (workspace.jiraMcpCommentDrafts || []).filter(
          (item: any) => item.id !== input.draftId,
        );
        if (workspace.task)
          workspace.task.jiraCommentDrafts = (workspace.task.jiraCommentDrafts || []).filter(
            (item: any) => item.id !== input.draftId,
          );
      });
      ctx.broadcastState?.();
      return { ok: true };
    },
    async jiraSaveConnection(
      input: {
        id?: string;
        label: string;
        deployment: "data-center" | "cloud";
        webUrl: string;
        apiBaseUrl: string;
        email?: string;
        apiToken?: string;
        pat?: string;
        authMode?: "pat" | "apim";
        subscriptionKey?: string;
        subscriptionHeaderName?: string;
        clientCertificatePath?: string;
        clientCertificatePassword?: string;
        clearClientCertificatePassword?: boolean;
        profileId?: string;
        accountPurpose?: "personal" | "technical";
      },
      windowId: string,
    ) {
      const profileId = getViewerProfileId(windowId);
      if (input.profileId && input.profileId !== profileId)
        throw new Error("Jira connection profile does not match this window.");
      const existing = input.id ? connections().find((item) => item.id === input.id) : undefined;
      if (input.id && !existing) throw new Error("Jira connection was not found.");
      if (existing && existing.profileId !== profileId) throw new Error("Jira connection belongs to another profile.");
      if (input.deployment === "cloud") {
        const webUrl = cloudSiteOrigin(input.webUrl);
        const email = input.email?.trim();
        if (!email) throw new Error("Enter the email address of the Atlassian account.");
        if (!ctx.credentialStore.isEncryptionAvailable())
          throw new Error("Secure credential storage is unavailable; Jira connection was not saved.");
        const id = existing?.id || `jira-${randomUUID()}`;
        const secretRef = `jira:${id}:api-token`;
        const verificationSecretRef = `jira:${id}:verify:${randomUUID()}`;
        const savedToken =
          existing?.auth.kind === "cloud-api-token" && existing.auth.secretRef && existing.webUrl === webUrl
            ? ctx.credentialStore.getSecret(existing.auth.secretRef)
            : "";
        const token = input.apiToken?.trim() || savedToken;
        if (!token)
          throw new Error(
            existing?.auth.kind === "cloud-api-token" && existing.webUrl !== webUrl
              ? "Enter the API token again: the saved token is not sent to a different Jira site."
              : "Enter a Jira Cloud API token.",
          );
        const connection: JiraConnection = {
          id,
          profileId,
          label: input.label.trim() || "Jira Cloud",
          enabled: true,
          deployment: "cloud",
          webUrl,
          apiBaseUrl: webUrl,
          auth: { kind: "cloud-api-token", secretRef: verificationSecretRef, email },
          accountPurpose: input.accountPurpose || "personal",
        };
        const requestId = randomUUID();
        await ctx.credentialStore.setSecret(verificationSecretRef, token, { requireEncryptedStorage: true });
        const logContext = {
          requestId,
          operation: "save" as const,
          connectionId: id,
          profileId,
          authMode: "cloud-api-token",
          stage: "verification_http",
        };
        try {
          logVerification("info", "jira connection verification started", logContext);
          const { identity, cloudId } = await manager.verify(connection);
          connection.verifiedIdentity = identity;
          if (connection.accountPurpose === "personal") connection.ownIdentity = identity;
          if (cloudId) connection.cloudId = cloudId;
          logVerification("info", "jira connection verification completed", {
            ...logContext,
            stage: "complete",
            outcome: "verified",
            statusCode: 200,
          });
        } catch (error) {
          logVerification("warn", "jira connection verification failed", {
            ...logContext,
            outcome: "failed",
            code: error instanceof JiraRequestError ? error.code : "network",
            ...(error instanceof JiraRequestError && error.statusCode !== undefined
              ? { statusCode: error.statusCode }
              : {}),
          });
          await ctx.credentialStore.deleteSecret(verificationSecretRef);
          throw error;
        }
        const previousSecret = ctx.credentialStore.getSecret(secretRef);
        connection.auth.secretRef = secretRef;
        try {
          if (existing) manager.invalidate(id);
          await ctx.credentialStore.setSecret(secretRef, token, { requireEncryptedStorage: true });
          await ctx.store.mutate((draft: any) => {
            const list = draft.settings.integrations.jira.connections as JiraConnection[];
            const index = list.findIndex((item) => item.id === id);
            if (index >= 0) list[index] = connection;
            else list.push(connection);
          });
        } catch (error) {
          if (previousSecret)
            await ctx.credentialStore.setSecret(secretRef, previousSecret, { requireEncryptedStorage: true });
          else await ctx.credentialStore.deleteSecret(secretRef);
          await ctx.credentialStore.deleteSecret(verificationSecretRef);
          throw error;
        }
        await ctx.credentialStore.deleteSecret(verificationSecretRef);
        if (existing && existing.auth.kind !== "cloud-api-token") {
          if (existing.auth.secretRef) await ctx.credentialStore.deleteSecret(existing.auth.secretRef);
          if (existing.auth.passphraseRef) await ctx.credentialStore.deleteSecret(existing.auth.passphraseRef);
        }
        ctx.broadcastState?.();
        return { ok: true, connection: { ...connection, auth: { kind: "cloud-api-token", email } } };
      }
      if (input.authMode === "apim") {
        const certificatePath = input.clientCertificatePath?.trim() || undefined;
        if (certificatePath && !/\.(pfx|p12)$/i.test(certificatePath))
          throw new Error("Choose a .pfx or .p12 certificate file.");
        if (!certificatePath && input.clientCertificatePassword)
          throw new Error("Choose a client certificate before entering its password.");
        const headerName = (input.subscriptionHeaderName || "Ocp-Apim-Subscription-Key").trim();
        if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(headerName))
          throw new Error("Enter a valid subscription key header name.");
        if (!ctx.credentialStore.isEncryptionAvailable())
          throw new Error("Secure credential storage is unavailable; Jira connection was not saved.");
        const id = existing?.id || `jira-${randomUUID()}`;
        const requestId = randomUUID();
        const keyRef = `jira:${id}:apim-key`;
        const passRef = `jira:${id}:apim-passphrase`;
        const oldKey =
          existing?.auth.kind === "dc-apim" && existing.auth.secretRef
            ? ctx.credentialStore.getSecret(existing.auth.secretRef)
            : "";
        const key = input.subscriptionKey?.trim() || oldKey;
        if (!key) throw new Error("Enter the API gateway subscription key.");
        const sameCertificate = !!certificatePath && existing?.clientCertificatePath === certificatePath;
        const oldPass =
          existing?.auth.kind === "dc-apim" && existing.auth.passphraseRef
            ? ctx.credentialStore.getSecret(existing.auth.passphraseRef)
            : "";
        const passphrase =
          input.clientCertificatePassword !== undefined && input.clientCertificatePassword !== ""
            ? input.clientCertificatePassword
            : input.clearClientCertificatePassword
              ? ""
              : sameCertificate
                ? oldPass
                : "";
        const candidateContext = {
          requestId,
          operation: "save" as const,
          connectionId: id,
          profileId,
          windowId,
          authMode: "apim",
          source: "candidate" as const,
          gatewayKeyPresent: Boolean(key),
          clientCertificatePresent: Boolean(certificatePath),
          certificatePasswordPresent: Boolean(passphrase),
        };
        logVerification("info", "jira connection save started", {
          ...candidateContext,
          stage: "save-start",
          outcome: "started",
        });
        if (certificatePath) {
          logVerification("info", "jira client certificate validation started", {
            ...candidateContext,
            stage: "certificate-read-started",
          });
          let pfx: Buffer;
          try {
            pfx = await readFile(certificatePath);
          } catch {
            logVerification("warn", "jira client certificate validation failed", {
              ...candidateContext,
              stage: "certificate-read-failed",
              outcome: "failed",
              code: "certificate-read",
            });
            throw new Error("The selected client certificate could not be opened. Check the file and its password.");
          }
          logVerification("info", "jira client certificate read completed", {
            ...candidateContext,
            stage: "certificate-read-complete",
            outcome: "verified",
          });
          try {
            createSecureContext({ pfx, ...(passphrase ? { passphrase } : {}) });
          } catch {
            logVerification("warn", "jira client certificate validation failed", {
              ...candidateContext,
              stage: "certificate-parse-failed",
              outcome: "failed",
              code: "certificate-parse",
            });
            throw new Error("The selected client certificate could not be opened. Check the file and its password.");
          }
          logVerification("info", "jira client certificate validation completed", {
            ...candidateContext,
            stage: "certificate-parse-complete",
            outcome: "verified",
          });
        }
        const verifyKeyRef = `jira:${id}:verify-key:${randomUUID()}`;
        const verifyPassRef = passphrase ? `jira:${id}:verify-pass:${randomUUID()}` : undefined;
        const connection: JiraConnection = {
          id,
          profileId,
          label: input.label.trim() || "Jira",
          enabled: true,
          deployment: "data-center",
          webUrl: input.webUrl,
          apiBaseUrl: input.apiBaseUrl,
          subscriptionHeaderName: headerName,
          ...(certificatePath ? { clientCertificatePath: certificatePath } : {}),
          auth: {
            kind: "dc-apim",
            secretRef: verifyKeyRef,
            ...(verifyPassRef ? { passphraseRef: verifyPassRef } : {}),
          },
          accountPurpose: input.accountPurpose || "personal",
        };
        let verificationStarted = false;
        try {
          await ctx.credentialStore.setSecret(verifyKeyRef, key, { requireEncryptedStorage: true });
          if (verifyPassRef)
            await ctx.credentialStore.setSecret(verifyPassRef, passphrase, { requireEncryptedStorage: true });
          logVerification("info", "jira candidate credentials prepared", {
            ...candidateContext,
            stage: "candidate-credentials-stored",
            outcome: "verified",
          });
          logVerification("info", "jira connection verification started", {
            ...candidateContext,
            stage: "candidate-verification-started",
            outcome: "started",
          });
          verificationStarted = true;
          const { identity } = await manager.verify(connection);
          connection.verifiedIdentity = identity;
          if (connection.accountPurpose === "personal") connection.ownIdentity = identity;
          logVerification("info", "jira connection verification completed", {
            ...candidateContext,
            stage: "candidate-verification-complete",
            outcome: "verified",
            statusCode: 200,
            identityPresent:
              identity.kind === "cloud" ? Boolean(identity.accountId) : Boolean(identity.name || identity.key),
          });
        } catch (error) {
          if (verificationStarted)
            logVerification("warn", "jira connection verification failed", {
              ...candidateContext,
              stage: "candidate-verification-failed",
              outcome: "failed",
              code: error instanceof JiraRequestError ? error.code : "network",
              ...(error instanceof JiraRequestError && error.statusCode !== undefined
                ? { statusCode: error.statusCode }
                : {}),
            });
          await ctx.credentialStore.deleteSecret(verifyKeyRef);
          if (verifyPassRef) await ctx.credentialStore.deleteSecret(verifyPassRef);
          throw error;
        }
        const permanentPassRef = passphrase ? passRef : undefined;
        const oldAuth = existing?.auth;
        connection.auth = {
          kind: "dc-apim",
          secretRef: keyRef,
          ...(permanentPassRef ? { passphraseRef: passRef } : {}),
        };
        let stateCommitted = false;
        try {
          if (existing) manager.invalidate(id);
          await ctx.credentialStore.setSecret(keyRef, key, { requireEncryptedStorage: true });
          if (passphrase) await ctx.credentialStore.setSecret(passRef, passphrase, { requireEncryptedStorage: true });
          else await ctx.credentialStore.deleteSecret(passRef);
          logVerification("info", "jira connection credentials stored", {
            ...candidateContext,
            source: "candidate",
            stage: "permanent-credentials-stored",
            outcome: "committed",
            gatewayKeyPresent: true,
            clientCertificatePresent: Boolean(certificatePath),
            certificatePasswordPresent: Boolean(passphrase),
          });
          const committedState = await ctx.store.mutate((draft: any) => {
            const list = draft.settings.integrations.jira.connections as JiraConnection[];
            const index = list.findIndex((item) => item.id === id);
            if (index >= 0) list[index] = connection;
            else list.push(connection);
          });
          stateCommitted = true;
          const persistedConnection = (
            (committedState || ctx.getState()).settings.integrations.jira.connections || []
          ).find((item: JiraConnection) => item.id === id && item.profileId === profileId) as
            JiraConnection | undefined;
          const persistedKey =
            persistedConnection?.auth.kind === "dc-apim" && persistedConnection.auth.secretRef
              ? ctx.credentialStore.getSecret(persistedConnection.auth.secretRef)
              : "";
          const persistedPassphrase =
            persistedConnection?.auth.kind === "dc-apim" && persistedConnection.auth.passphraseRef
              ? ctx.credentialStore.getSecret(persistedConnection.auth.passphraseRef)
              : "";
          const readback = {
            persistedConnectionFound: Boolean(persistedConnection),
            persistedAuthModeMatchesCandidate: persistedConnection?.auth.kind === "dc-apim",
            persistedKeyMatchesCandidate: persistedKey === key,
            persistedPasswordMatchesCandidate: persistedPassphrase === passphrase,
            persistedCertificatePathMatchesCandidate: certificatePath
              ? persistedConnection?.clientCertificatePath === certificatePath
              : !persistedConnection?.clientCertificatePath,
            persistedHeaderMatchesCandidate: persistedConnection?.subscriptionHeaderName === headerName,
            persistedApiBaseUrlMatchesCandidate: persistedConnection?.apiBaseUrl === input.apiBaseUrl,
          };
          const readbackMatches = Object.values(readback).every(Boolean);
          logVerification("info", "jira connection persistence readback completed", {
            ...candidateContext,
            source: "persisted",
            stage: "persistence-readback",
            outcome: readbackMatches ? "readback-consistent" : "readback-mismatch",
            ...readback,
            gatewayKeyPresent: Boolean(persistedKey),
            clientCertificatePresent: Boolean(persistedConnection?.clientCertificatePath),
            certificatePasswordPresent: Boolean(persistedPassphrase),
          });
          if (!readbackMatches)
            throw new Error("Jira connection was verified but its saved settings could not be confirmed.");
        } catch (error) {
          if (stateCommitted) {
            await ctx.store.mutate((draft: any) => {
              const list = draft.settings.integrations.jira.connections as JiraConnection[];
              const index = list.findIndex((item) => item.id === id && item.profileId === profileId);
              if (existing && index >= 0) list[index] = existing;
              else if (index >= 0) list.splice(index, 1);
            });
          }
          if (oldAuth?.secretRef && oldKey)
            await ctx.credentialStore.setSecret(oldAuth.secretRef, oldKey, { requireEncryptedStorage: true });
          if (oldAuth?.passphraseRef && oldPass)
            await ctx.credentialStore.setSecret(oldAuth.passphraseRef, oldPass, { requireEncryptedStorage: true });
          if (!oldAuth?.secretRef || oldAuth.secretRef !== keyRef) await ctx.credentialStore.deleteSecret(keyRef);
          if (!oldAuth?.passphraseRef || oldAuth.passphraseRef !== passRef)
            await ctx.credentialStore.deleteSecret(passRef);
          await ctx.credentialStore.deleteSecret(verifyKeyRef);
          if (verifyPassRef) await ctx.credentialStore.deleteSecret(verifyPassRef);
          logVerification("warn", "jira connection save rolled back", {
            ...candidateContext,
            source: "persisted",
            stage: "save-rollback",
            outcome: "rolled-back",
            code: "persistence-failed",
          });
          throw error;
        }
        await ctx.credentialStore.deleteSecret(verifyKeyRef);
        if (verifyPassRef) await ctx.credentialStore.deleteSecret(verifyPassRef);
        if (oldAuth?.kind === "dc-apim") {
          if (oldAuth.secretRef && oldAuth.secretRef !== keyRef)
            await ctx.credentialStore.deleteSecret(oldAuth.secretRef);
          if (oldAuth.passphraseRef && oldAuth.passphraseRef !== passRef)
            await ctx.credentialStore.deleteSecret(oldAuth.passphraseRef);
        } else if (oldAuth?.kind === "dc-pat" && oldAuth.secretRef) {
          await ctx.credentialStore.deleteSecret(oldAuth.secretRef);
        }
        logVerification("info", "jira connection save completed", {
          ...candidateContext,
          source: "persisted",
          stage: "save-complete",
          outcome: "committed",
          gatewayKeyPresent: true,
          clientCertificatePresent: Boolean(certificatePath),
          certificatePasswordPresent: Boolean(passphrase),
        });
        ctx.broadcastState?.();
        return { ok: true, connection: { ...connection, auth: { kind: "dc-apim" } } };
      }
      if (!input.pat?.trim()) throw new Error("Enter a Jira Data Center personal access token.");
      if (!ctx.credentialStore.isEncryptionAvailable())
        throw new Error("Secure credential storage is unavailable; Jira connection was not saved.");
      const id = existing?.id || `jira-${randomUUID()}`;
      const secretRef = `jira:${id}:pat`;
      const verificationSecretRef = `jira:${id}:verify:${randomUUID()}`;
      const connection: JiraConnection = {
        id,
        profileId,
        label: input.label.trim() || "Jira",
        enabled: true,
        deployment: "data-center",
        webUrl: input.webUrl,
        apiBaseUrl: input.apiBaseUrl,
        auth: { kind: "dc-pat", secretRef: verificationSecretRef },
        accountPurpose: input.accountPurpose || "personal",
      };
      const requestId = randomUUID();
      // Verify under a temporary encrypted ref so failed reauthentication cannot destroy the
      // previously working secret for this connection.
      await ctx.credentialStore.setSecret(verificationSecretRef, input.pat, { requireEncryptedStorage: true });
      try {
        logVerification("info", "jira connection verification started", {
          requestId,
          operation: "save",
          connectionId: id,
          profileId,
          authMode: "pat",
          stage: "verification_http",
        });
        const { identity } = await manager.verify(connection);
        connection.verifiedIdentity = identity;
        if (connection.accountPurpose === "personal") connection.ownIdentity = identity;
        logVerification("info", "jira connection verification completed", {
          requestId,
          operation: "save",
          connectionId: id,
          profileId,
          authMode: "pat",
          stage: "complete",
          outcome: "verified",
          statusCode: 200,
        });
      } catch (error) {
        logVerification("warn", "jira connection verification failed", {
          requestId,
          operation: "save",
          connectionId: id,
          profileId,
          authMode: "pat",
          stage: "verification_http",
          outcome: "failed",
          code: error instanceof JiraRequestError ? error.code : "network",
          ...(error instanceof JiraRequestError && error.statusCode !== undefined
            ? { statusCode: error.statusCode }
            : {}),
        });
        await ctx.credentialStore.deleteSecret(verificationSecretRef);
        throw error;
      }
      const previousSecret = ctx.credentialStore.getSecret(secretRef);
      connection.auth.secretRef = secretRef;
      try {
        if (existing) manager.invalidate(id);
        await ctx.credentialStore.setSecret(secretRef, input.pat, { requireEncryptedStorage: true });
        await ctx.store.mutate((draft: any) => {
          const list = draft.settings.integrations.jira.connections as JiraConnection[];
          const index = list.findIndex((item) => item.id === id);
          if (index >= 0) list[index] = connection;
          else list.push(connection);
        });
      } catch (error) {
        if (previousSecret)
          await ctx.credentialStore.setSecret(secretRef, previousSecret, { requireEncryptedStorage: true });
        else await ctx.credentialStore.deleteSecret(secretRef);
        await ctx.credentialStore.deleteSecret(verificationSecretRef);
        throw error;
      }
      await ctx.credentialStore.deleteSecret(verificationSecretRef);
      if (existing?.auth.kind === "dc-apim") {
        if (existing.auth.secretRef) await ctx.credentialStore.deleteSecret(existing.auth.secretRef);
        if (existing.auth.passphraseRef) await ctx.credentialStore.deleteSecret(existing.auth.passphraseRef);
      }
      ctx.broadcastState?.();
      return { ok: true, connection: { ...connection, auth: { kind: "dc-pat" } } };
    },
    async jiraTestConnection(
      input: {
        id?: string;
        label: string;
        deployment: "data-center" | "cloud";
        webUrl: string;
        apiBaseUrl: string;
        email?: string;
        apiToken?: string;
        pat?: string;
        authMode?: "pat" | "apim";
        subscriptionKey?: string;
        subscriptionHeaderName?: string;
        clientCertificatePath?: string;
        clientCertificatePassword?: string;
        clearClientCertificatePassword?: boolean;
        profileId?: string;
        accountPurpose?: "personal" | "technical";
      },
      windowId: string,
    ) {
      const profileId = getViewerProfileId(windowId);
      if (input.profileId && input.profileId !== profileId)
        throw new Error("Jira connection profile does not match this window.");
      const existing = input.id ? connections().find((item) => item.id === input.id) : undefined;
      if (input.id && !existing) throw new Error("Jira connection was not found.");
      if (existing && existing.profileId !== profileId) throw new Error("Jira connection belongs to another profile.");
      if (!ctx.credentialStore.isEncryptionAvailable())
        throw new Error("Secure credential storage is unavailable; Jira connection was not tested.");

      const id = existing?.id || `jira-test-${randomUUID()}`;
      const requestId = randomUUID();
      const temporaryRefs: string[] = [];
      const checkedAt = new Date().toISOString();
      const authMode = input.deployment === "cloud" ? "cloud-api-token" : input.authMode === "apim" ? "apim" : "pat";
      let connection: JiraConnection;
      let gatewayKeyPresent = false;
      let clientCertificatePresent = false;
      let certificatePasswordPresent = false;
      let stage: "validate" | "certificate_read" | "certificate_parse" | "credentials" | "verification_http" =
        "validate";
      try {
        if (authMode === "cloud-api-token") {
          stage = "credentials";
          const webUrl = cloudSiteOrigin(input.webUrl);
          const email = input.email?.trim();
          if (!email) throw new Error("Enter the email address of the Atlassian account.");
          const savedToken =
            existing?.auth.kind === "cloud-api-token" && existing.auth.secretRef && existing.webUrl === webUrl
              ? ctx.credentialStore.getSecret(existing.auth.secretRef)
              : "";
          const token = input.apiToken?.trim() || savedToken;
          if (!token)
            throw new Error(
              existing?.auth.kind === "cloud-api-token" && existing.webUrl !== webUrl
                ? "Enter the API token again: the saved token is not sent to a different Jira site."
                : "Enter a Jira Cloud API token.",
            );
          const secretRef = `jira:${id}:test-api-token:${randomUUID()}`;
          temporaryRefs.push(secretRef);
          try {
            await ctx.credentialStore.setSecret(secretRef, token, { requireEncryptedStorage: true });
          } catch {
            throw new Error(
              "Secure credential storage could not prepare a temporary Jira test. No connection was saved.",
            );
          }
          connection = {
            id,
            profileId,
            label: input.label.trim() || "Jira Cloud",
            enabled: true,
            deployment: "cloud",
            webUrl,
            apiBaseUrl: webUrl,
            auth: { kind: "cloud-api-token", secretRef, email },
            accountPurpose: input.accountPurpose || "personal",
          };
        } else if (authMode === "apim") {
          const certificatePath = input.clientCertificatePath?.trim() || undefined;
          if (certificatePath && !/\.(pfx|p12)$/i.test(certificatePath))
            throw new Error("Choose a .pfx or .p12 client certificate file.");
          if (!certificatePath && input.clientCertificatePassword)
            throw new Error("Choose a client certificate before entering its password.");
          const headerName = (input.subscriptionHeaderName || "Ocp-Apim-Subscription-Key").trim();
          if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(headerName))
            throw new Error("Enter a valid subscription key header name.");
          const oldKey =
            existing?.auth.kind === "dc-apim" && existing.auth.secretRef
              ? ctx.credentialStore.getSecret(existing.auth.secretRef)
              : "";
          const key = input.subscriptionKey?.trim() || oldKey;
          if (!key) throw new Error("Enter the API gateway subscription key.");
          gatewayKeyPresent = authMode === "apim" && Boolean(key);
          clientCertificatePresent = Boolean(certificatePath);
          const sameCertificate = !!certificatePath && existing?.clientCertificatePath === certificatePath;
          const oldPass =
            existing?.auth.kind === "dc-apim" && existing.auth.passphraseRef
              ? ctx.credentialStore.getSecret(existing.auth.passphraseRef)
              : "";
          const passphrase =
            input.clientCertificatePassword !== undefined && input.clientCertificatePassword !== ""
              ? input.clientCertificatePassword
              : input.clearClientCertificatePassword
                ? ""
                : sameCertificate
                  ? oldPass
                  : "";
          certificatePasswordPresent = Boolean(passphrase);
          if (certificatePath) {
            stage = "certificate_read";
            let pfx: Buffer;
            try {
              pfx = await readFile(certificatePath);
            } catch {
              throw new Error(
                "Could not read the selected client certificate. Check that the file exists and is accessible.",
              );
            }
            try {
              stage = "certificate_parse";
              createSecureContext({ pfx, ...(passphrase ? { passphrase } : {}) });
            } catch {
              throw new Error(
                "The client certificate could not be opened. Check that it is a valid PFX/P12 file and that its password is correct.",
              );
            }
          }
          stage = "credentials";
          const keyRef = `jira:${id}:test-key:${randomUUID()}`;
          const passRef = passphrase ? `jira:${id}:test-pass:${randomUUID()}` : undefined;
          temporaryRefs.push(keyRef, ...(passRef ? [passRef] : []));
          try {
            await ctx.credentialStore.setSecret(keyRef, key, { requireEncryptedStorage: true });
            if (passRef) await ctx.credentialStore.setSecret(passRef, passphrase, { requireEncryptedStorage: true });
          } catch {
            throw new Error(
              "Secure credential storage could not prepare a temporary Jira test. No connection was saved.",
            );
          }
          connection = {
            id,
            profileId,
            label: input.label.trim() || "Jira",
            enabled: true,
            deployment: "data-center",
            webUrl: input.webUrl,
            apiBaseUrl: input.apiBaseUrl,
            subscriptionHeaderName: headerName,
            ...(certificatePath ? { clientCertificatePath: certificatePath } : {}),
            auth: { kind: "dc-apim", secretRef: keyRef, ...(passRef ? { passphraseRef: passRef } : {}) },
            accountPurpose: input.accountPurpose || "personal",
          };
        } else {
          stage = "credentials";
          const savedPat =
            existing?.auth.kind === "dc-pat" && existing.auth.secretRef
              ? ctx.credentialStore.getSecret(existing.auth.secretRef)
              : "";
          const pat = input.pat?.trim() || savedPat;
          if (!pat) throw new Error("Enter a Jira Data Center personal access token.");
          const secretRef = `jira:${id}:test-pat:${randomUUID()}`;
          temporaryRefs.push(secretRef);
          try {
            await ctx.credentialStore.setSecret(secretRef, pat, { requireEncryptedStorage: true });
          } catch {
            throw new Error(
              "Secure credential storage could not prepare a temporary Jira test. No connection was saved.",
            );
          }
          connection = {
            id,
            profileId,
            label: input.label.trim() || "Jira",
            enabled: true,
            deployment: "data-center",
            webUrl: input.webUrl,
            apiBaseUrl: input.apiBaseUrl,
            auth: { kind: "dc-pat", secretRef },
            accountPurpose: input.accountPurpose || "personal",
          };
        }

        stage = "verification_http";
        logVerification("info", "jira connection verification started", {
          requestId,
          operation: "draft-test",
          connectionId: id,
          profileId,
          authMode,
          source: "candidate",
          windowId,
          gatewayKeyPresent,
          clientCertificatePresent,
          certificatePasswordPresent,
          stage: "verification_http",
          outcome: "started",
        });
        const verified = await manager.verify(connection);
        const result = { identity: verified.identity, serverTitle: verified.serverTitle };
        const health = { state: "verified" as const, checkedAt };
        logVerification("info", "jira connection verification completed", {
          requestId,
          operation: "draft-test",
          connectionId: id,
          profileId,
          authMode,
          source: "candidate",
          windowId,
          gatewayKeyPresent,
          clientCertificatePresent,
          certificatePasswordPresent,
          stage: "complete",
          outcome: "verified",
          statusCode: 200,
          identityPresent:
            result.identity.kind === "cloud"
              ? Boolean(result.identity.accountId)
              : Boolean(result.identity.name || result.identity.key),
        });
        return jiraVerifyConnectionDtoSchema.parse({ ok: true, ...result, health });
      } catch (error) {
        const code =
          error instanceof JiraRequestError ? error.code : stage === "verification_http" ? "network" : "unknown";
        const message =
          error instanceof JiraRequestError
            ? error.message
            : stage === "verification_http"
              ? "Jira connection test failed. Check the Jira URL and network access, then try again."
              : error instanceof Error
                ? error.message
                : "Jira connection test failed.";
        logVerification("warn", "jira connection verification failed", {
          requestId,
          operation: "draft-test",
          connectionId: id,
          profileId,
          authMode,
          source: "candidate",
          windowId,
          gatewayKeyPresent,
          clientCertificatePresent,
          certificatePasswordPresent,
          stage,
          outcome: "failed",
          code,
          ...(error instanceof JiraRequestError && error.statusCode !== undefined
            ? { statusCode: error.statusCode }
            : {}),
        });
        return jiraVerifyConnectionDtoSchema.parse({
          ok: false,
          health: { state: code, checkedAt },
          error: { code, message: message.slice(0, 500) },
        });
      } finally {
        for (const ref of temporaryRefs) {
          try {
            await ctx.credentialStore.deleteSecret(ref);
          } catch {
            log.warn("jira connection test temporary credential cleanup failed", { connectionId: id });
          }
        }
      }
    },
    async jiraDeleteConnection(connectionId: string, windowId: string) {
      const connection = get(connectionId, windowId);
      const removedWorkspaces: any[] = [];
      await ctx.store.mutate((draft: any) => {
        const jira = draft.settings.integrations.jira;
        jira.connections = jira.connections.filter((item: JiraConnection) => item.id !== connectionId);
        jira.queries = jira.queries.filter((query: any) => query.connectionId !== connectionId);
        jira.repoBindings = (jira.repoBindings || []).filter((item: any) => item.jiraConnectionId !== connectionId);
        draft.workspaces = draft.workspaces.filter((workspace: any) => {
          if (workspace.kind !== "jira-board" || String(workspace.jiraBoard?.connectionId) !== connectionId)
            return true;
          removedWorkspaces.push({ id: workspace.id, profileId: workspace.profileId });
          return false;
        });
      });
      if (connection.auth.secretRef) await ctx.credentialStore.deleteSecret(connection.auth.secretRef);
      if (connection.auth.passphraseRef) await ctx.credentialStore.deleteSecret(connection.auth.passphraseRef);
      manager.invalidate(connectionId);
      jiraFailureLog().forget(connectionId);
      log.info("jira connection deleted", {
        connectionId,
        profileId: connection.profileId,
        authKind: connection.auth.kind,
      });
      try {
        await ctx.removeJiraPollingForConnection?.(connection.profileId, connectionId);
      } catch (error) {
        log.warn("jira connection removed but its polling watches could not be cleared", {
          connectionId,
          ...jiraErrorFields(error),
        });
      }
      ctx.jiraCache?.removeConnectionData?.(connectionId);
      await ctx.jiraAttachmentCache?.removeConnection(connectionId);
      for (const workspace of removedWorkspaces) {
        viewSyncStates.delete(viewStateKey(String(workspace.profileId || "default"), workspace.id));
        void ctx.finalizeWorkspaceRemoval?.(workspace);
      }
      for (const state of [...viewSyncStates.values()]) {
        if (state.profileId !== connection.profileId) continue;
        try {
          makeWorkspaceViewsState(state.workspaceId, state.profileId);
        } catch {
          viewSyncStates.delete(viewStateKey(state.profileId, state.workspaceId));
        }
      }
      ctx.broadcastState?.();
      return { ok: true };
    },
    async jiraVerifyConnection(connectionId: string, windowId: string) {
      const connection = get(connectionId, windowId);
      const checkedAt = new Date().toISOString();
      const requestId = randomUUID();
      const authMode = authModeFor(connection);
      const savedKey =
        connection.auth.kind === "dc-apim" && connection.auth.secretRef
          ? ctx.credentialStore.getSecret(connection.auth.secretRef)
          : "";
      const savedPassword =
        connection.auth.kind === "dc-apim" && connection.auth.passphraseRef
          ? ctx.credentialStore.getSecret(connection.auth.passphraseRef)
          : "";
      const persistedContext = {
        requestId,
        operation: "saved-verify" as const,
        connectionId: connection.id,
        profileId: connection.profileId,
        authMode,
        source: "persisted" as const,
        windowId,
        gatewayKeyPresent: Boolean(savedKey),
        clientCertificatePresent: Boolean(connection.clientCertificatePath),
        certificatePasswordPresent: Boolean(savedPassword),
      };
      logVerification("info", "jira connection verification started", {
        ...persistedContext,
        stage: "verification_http",
        outcome: "started",
      });
      try {
        const verified = await manager.verify(connection);
        const result = { identity: verified.identity, serverTitle: verified.serverTitle };
        const health = { state: "verified" as const, checkedAt };
        await ctx.store.mutate((draft: any) => {
          const current = draft.settings.integrations.jira.connections.find(
            (item: JiraConnection) => item.id === connection.id && item.profileId === connection.profileId,
          );
          if (current) {
            current.health = health;
            current.status = "connected";
            if (verified.cloudId && !current.cloudId) current.cloudId = verified.cloudId;
          }
        });
        ctx.broadcastState?.();
        logVerification("info", "jira connection verification completed", {
          ...persistedContext,
          stage: "complete",
          outcome: "verified",
          statusCode: 200,
          identityPresent:
            result.identity.kind === "cloud"
              ? Boolean(result.identity.accountId)
              : Boolean(result.identity.name || result.identity.key),
        });
        return jiraVerifyConnectionDtoSchema.parse({ ok: true, ...result, health });
      } catch (error) {
        const code = error instanceof JiraRequestError ? error.code : "network";
        const retryAfterMs = error instanceof JiraRequestError ? error.retryAfterMs : undefined;
        if (["auth-expired", "permission-denied", "not-found"].includes(code)) manager.invalidate(connection.id);
        const health = { state: code, checkedAt, ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) };
        await ctx.store.mutate((draft: any) => {
          const current = draft.settings.integrations.jira.connections.find(
            (item: JiraConnection) => item.id === connection.id && item.profileId === connection.profileId,
          );
          if (current) {
            current.health = health;
            current.status = JIRA_SIGN_IN_CODES.has(code) ? "needs-login" : "unavailable";
          }
        });
        ctx.broadcastState?.();
        logVerification("warn", "jira connection verification failed", {
          ...persistedContext,
          stage: "verification_http",
          outcome: "failed",
          code,
          ...(error instanceof JiraRequestError && error.statusCode !== undefined
            ? { statusCode: error.statusCode }
            : {}),
        });
        return jiraVerifyConnectionDtoSchema.parse({
          ok: false,
          health,
          error: {
            code,
            message: error instanceof JiraRequestError ? error.message : "Jira connection check failed.",
            ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
          },
        });
      }
    },
    async jiraUpdateConnectionMetadata(
      input: {
        connectionId: string;
        label: string;
        accountPurpose: "personal" | "technical";
        issueKeyPrefixes: string[];
        defaultJql: string;
        projectKeys: string[];
        pollSeconds: number;
      },
      windowId: string,
    ) {
      const connection = get(input.connectionId, windowId);
      manager.invalidate(connection.id);
      await ctx.store.mutate((draft: any) => {
        const current = draft.settings.integrations.jira.connections.find(
          (item: JiraConnection) => item.id === connection.id,
        );
        if (!current || current.profileId !== connection.profileId)
          throw new Error("Jira connection changed before metadata was saved.");
        current.label = input.label.trim();
        current.accountPurpose = input.accountPurpose;
        current.issueKeyPrefixes = [...new Set(input.issueKeyPrefixes.map((prefix) => prefix.trim().toUpperCase()))];
        current.defaultJql = input.defaultJql.trim();
        current.projectKeys = [...new Set(input.projectKeys.map((key) => key.trim().toUpperCase()))];
        current.pollSeconds = input.pollSeconds;
      });
      ctx.broadcastState?.();
      return { ok: true };
    },
    async jiraSetCommentAttribution(input: JiraCommentAttribution, windowId: string) {
      if (!windowId) throw new Error("Jira settings need a trusted desktop window context.");
      const next = normalizeJiraCommentAttribution(input);
      await ctx.store.mutate((draft: any) => {
        draft.settings.integrations.jira.commentAttribution = next;
      });
      ctx.broadcastState?.();
      return next;
    },
    async jiraSetAgentAttachmentLimits(input: JiraAgentAttachmentLimits, windowId: string) {
      if (!windowId) throw new Error("Jira settings need a trusted desktop window context.");
      const next = normalizeJiraAgentAttachmentLimits(input);
      await ctx.store.mutate((draft: any) => {
        draft.settings.integrations.jira.agentAttachments = next;
      });
      ctx.broadcastState?.();
      return next;
    },
    async jiraVerifyOwnIdentity(input: { connectionId: string; userId: string }, windowId: string) {
      const connection = get(input.connectionId, windowId);
      const identity = await manager.verifyUserIdentity(connection, input.userId);
      get(connection.id, windowId);
      return jiraIdentityDtoSchema.parse(identity);
    },
    async jiraSetOwnIdentity(input: { connectionId: string; userId: string }, windowId: string) {
      const connection = get(input.connectionId, windowId);
      const identity = await manager.verifyUserIdentity(connection, input.userId);
      get(connection.id, windowId);
      manager.invalidate(connection.id);
      await ctx.store.mutate((draft: any) => {
        const current = draft.settings.integrations.jira.connections.find(
          (item: JiraConnection) => item.id === connection.id,
        );
        if (!current || current.profileId !== connection.profileId)
          throw new Error("Jira connection changed before its personal identity was saved.");
        current.ownIdentity = identity;
      });
      ctx.broadcastState?.();
      refreshPersonalViewsForConnection(connection.profileId, connection.id);
      return jiraIdentityDtoSchema.parse(identity);
    },
    async jiraListProjects(connectionId: string, windowId: string) {
      return jiraProjectDtoSchema
        .array()
        .max(500)
        .parse(await manager.projects(get(connectionId, windowId)));
    },
    async jiraListBoards(connectionId: string, windowId: string) {
      const boards = await manager.boards(get(connectionId, windowId));
      return jiraBoardDtoSchema.array().max(500).parse(boards);
    },
    async jiraSearchBoards(input: JiraBoardSearchPayload, windowId: string) {
      return jiraBoardSearchResultDtoSchema.parse(await manager.searchBoards(get(input.connectionId, windowId), input));
    },
    async jiraGetBoardView(
      payload: {
        connectionId: string;
        boardId: number;
        mode?: "issues" | "backlog" | "sprints";
        cursor?: string;
        sprintId?: number;
        quickFilterIds?: number[];
        assignee?: { kind: "user"; id: string } | { kind: "unassigned" };
        doneWithinDays?: number;
        cacheOnly?: boolean;
        forceRefresh?: boolean;
        refreshInBackground?: boolean;
        projectKeys?: string[];
      },
      windowId: string,
    ) {
      const result = await manager.boardView(
        get(payload.connectionId, windowId),
        payload.boardId,
        payload.mode,
        payload.cursor,
        payload.sprintId,
        {
          quickFilterIds: payload.quickFilterIds,
          assignee: payload.assignee,
          doneWithinDays: payload.doneWithinDays,
          cacheOnly: payload.cacheOnly,
          forceRefresh: payload.forceRefresh,
          refreshInBackground: payload.refreshInBackground,
          projectKeys: payload.projectKeys,
        },
      );
      if (result === null) return null;
      return jiraBoardViewDtoSchema.parse({
        ...result,
        issues: jiraIssueDtoSchema.array().max(100).parse(result.issues),
      });
    },
    async jiraSearchIssues(
      payload: {
        connectionId: string;
        jql: string;
        limit?: number;
        cursor?: string;
        cacheOnly?: boolean;
        forceRefresh?: boolean;
        refreshInBackground?: boolean;
        projectKeys?: string[];
      },
      windowId: string,
    ) {
      const result = await manager.searchPage(
        get(payload.connectionId, windowId),
        payload.jql,
        payload.limit,
        payload.cursor,
        {
          cacheOnly: payload.cacheOnly,
          forceRefresh: payload.forceRefresh,
          refreshInBackground: payload.refreshInBackground,
          projectKeys: payload.projectKeys,
        },
      );
      if (result === null) return null;
      return jiraSearchResultDtoSchema.parse({
        ...result,
        issues: jiraIssueDtoSchema.array().max(100).parse(result.issues),
      });
    },
    async jiraGetIssue(
      payload: {
        connectionId: string;
        issueId: string;
        cacheOnly?: boolean;
        forceRefresh?: boolean;
        refreshInBackground?: boolean;
      },
      windowId: string,
    ) {
      const issue = await manager.issue(get(payload.connectionId, windowId), payload.issueId, {
        cacheOnly: payload.cacheOnly,
        forceRefresh: payload.forceRefresh,
        refreshInBackground: payload.refreshInBackground,
      });
      return issue === null ? null : jiraIssueDtoSchema.parse(issue);
    },
    async jiraListBoardQuickFilters(
      payload: {
        connectionId: string;
        boardId: number;
        cursor?: string;
        limit?: number;
        cacheOnly?: boolean;
        forceRefresh?: boolean;
        refreshInBackground?: boolean;
      },
      windowId: string,
    ) {
      const result = await manager.boardQuickFilters(get(payload.connectionId, windowId), payload.boardId, {
        cursor: payload.cursor,
        limit: payload.limit,
        cacheOnly: payload.cacheOnly,
        forceRefresh: payload.forceRefresh,
        refreshInBackground: payload.refreshInBackground,
      });
      return result === null ? null : jiraBoardQuickFiltersDtoSchema.parse(result);
    },
    async jiraSearchUsers(payload: { connectionId: string; query: string; limit?: number }, windowId: string) {
      return jiraUserSearchDtoSchema.parse(
        await manager.searchUsers(get(payload.connectionId, windowId), payload.query, payload.limit),
      );
    },
    async jiraGetAttachmentBytes(
      payload: { connectionId: string; issueId: string; attachmentId: string },
      windowId: string,
    ) {
      return manager.attachmentBytes(get(payload.connectionId, windowId), payload.issueId, payload.attachmentId, {
        maxBytes: 10 * 1024 * 1024,
        maxDurationMs: 25_000,
      });
    },
    async jiraGetAttachmentImage(
      payload: { connectionId: string; issueId: string; attachmentId: string },
      windowId: string,
    ) {
      return attachmentImage(get(payload.connectionId, windowId), payload);
    },
    async jiraRemoteGetAttachmentImage(
      payload: { connectionId: string; issueId: string; attachmentId: string },
      profileId: string,
    ) {
      const image = await attachmentImage(getForProfile(payload.connectionId, profileId), payload);
      return { mediaType: image.mediaType, base64: Buffer.from(image.bytes).toString("base64") };
    },
    async jiraUploadAttachment(
      payload: { connectionId: string; issueId: string },
      windowId: string,
      file: { fileName: string; mediaType: string; bytes: Uint8Array },
    ) {
      return invokeWrite(async () => {
        const issue = await manager.issue(get(payload.connectionId, windowId), payload.issueId);
        return writesFor(windowId).uploadAttachment(
          { connectionId: payload.connectionId, issueId: issue.ref.issueId, issueKey: issue.ref.issueKey },
          file,
        );
      });
    },
    async jiraListComments(payload: { ref: JiraWriteIssue }, windowId: string) {
      return jiraCommentDtoSchema
        .array()
        .max(JIRA_COMMENTS_MAX)
        .parse(await manager.comments(get(payload.ref.connectionId, windowId), payload.ref.issueId));
    },
    async jiraListTransitions(ref: JiraWriteIssue, windowId: string) {
      return jiraTransitionDtoSchema
        .array()
        .max(100)
        .parse(await manager.transitions(get(ref.connectionId, windowId), ref.issueId));
    },
    async jiraListQueries(connectionId: string, windowId: string) {
      const connection = get(connectionId, windowId);
      return jiraSavedQueryDtoSchema
        .array()
        .max(500)
        .parse(
          (ctx.getState().settings.integrations.jira.queries || []).filter(
            (query: any) => query.connectionId === connection.id && query.profileId === connection.profileId,
          ),
        );
    },
    async jiraListFavoriteFilters(connectionId: string, windowId: string) {
      return jiraSavedFilterDtoSchema
        .array()
        .max(50)
        .parse(await manager.favoriteFilters(get(connectionId, windowId)));
    },
    async jiraGetSavedFilter(input: { connectionId: string; filterId: string }, windowId: string) {
      return jiraSavedFilterDtoSchema.parse(
        await manager.savedFilter(get(input.connectionId, windowId), input.filterId),
      );
    },
    async jiraSaveQuery(
      input: { id?: string; connectionId: string; name: string; jql: string; notificationsEnabled?: boolean },
      windowId: string,
    ) {
      const connection = get(input.connectionId, windowId);
      const existing = input.id
        ? (ctx.getState().settings.integrations.jira.queries || []).find((query: any) => query.id === input.id)
        : undefined;
      if (
        input.id &&
        (!existing || existing.profileId !== connection.profileId || existing.connectionId !== connection.id)
      )
        throw new Error("Saved Jira query was not found in this profile and connection.");
      const query = {
        id: existing?.id || `jira-query-${randomUUID()}`,
        connectionId: connection.id,
        profileId: connection.profileId,
        name: input.name.trim(),
        jql: input.jql.trim(),
        notificationsEnabled: input.notificationsEnabled ?? existing?.notificationsEnabled ?? false,
        updatedAt: new Date().toISOString(),
      };
      if (!query.name || query.name.length > 100 || query.jql.length > 2000)
        throw new Error("Saved Jira query name/JQL is invalid.");
      await ctx.store.mutate((draft: any) => {
        const list = draft.settings.integrations.jira.queries;
        const index = list.findIndex((item: any) => item.id === query.id);
        if (index >= 0) list[index] = query;
        else list.push(query);
      });
      ctx.broadcastState?.();
      return jiraSavedQueryDtoSchema.parse(query);
    },
    async buildJiraOwnIssuesQuery(
      input: {
        connectionId: string;
        baseJql?: string;
        personalScope?: "open" | "all";
        projectKeys?: string[];
        smartFilters?: JiraSmartFilterId[];
      },
      windowId: string,
    ) {
      const connection = get(input.connectionId, windowId);
      const identity = connection.ownIdentity;
      if (input.smartFilters?.length) return smartFilterQuery(connection, input);
      if (
        !identity ||
        (identity.kind === "cloud" && !identity.accountId) ||
        (identity.kind === "data-center" && !identity.name)
      ) {
        throw new Error("Choose and verify a personal Jira identity before using My issues.");
      }
      const baseJql = typeof input.baseJql === "string" ? input.baseJql.trim() : "";
      return jiraOwnIssuesQueryDtoSchema.parse({
        jql: applyJiraProjectScope(
          ownIssuesJql(identity, baseJql, input.personalScope ?? "open"),
          input.projectKeys === undefined ? connection.projectKeys : input.projectKeys,
        ),
        identityLabel: identity.displayName,
      });
    },
    async jiraDeleteQuery(queryId: string, windowId: string) {
      const profileId = getViewerProfileId(windowId);
      await ctx.store.mutate((draft: any) => {
        draft.settings.integrations.jira.queries = draft.settings.integrations.jira.queries.filter(
          (query: any) => query.id !== queryId || query.profileId !== profileId,
        );
      });
      ctx.broadcastState?.();
      return { ok: true };
    },
    async jiraGetWriteHistory(input: { connectionId?: string; issueId?: string; limit?: number }, windowId: string) {
      const profileId = getViewerProfileId(windowId);
      if (input.connectionId) get(input.connectionId, windowId);
      return jiraWriteJournalEntryDtoSchema
        .array()
        .max(100)
        .parse(await writesFor(windowId).getHistory(profileId, input));
    },
    async jiraReconcileWrite(journalId: string, windowId: string) {
      const profileId = getViewerProfileId(windowId);
      return jiraWriteReconcileResultDtoSchema.parse(await writesFor(windowId).reconcileWrite(profileId, journalId));
    },
    async jiraPreviewTransition(
      payload: { ref: JiraWriteIssue; transitionId: string; intent: string; fields?: Record<string, unknown> },
      windowId: string,
    ) {
      const issue = await issueByRef(payload.ref, windowId);
      return jiraWriteConfirmationDtoSchema.parse(
        await writesFor(windowId).previewTransition(issue.ref, payload.transitionId, payload.intent, payload.fields),
      );
    },
    async jiraExecuteTransition(
      payload: {
        ref: JiraWriteIssue;
        transitionId: string;
        fields?: Record<string, unknown>;
        confirmation: JiraWriteConfirmation;
      },
      windowId: string,
    ) {
      const issue = await issueByRef(payload.ref, windowId);
      return invokeWrite(() =>
        writesFor(windowId).executeTransition(issue.ref, payload.transitionId, payload.confirmation, payload.fields),
      );
    },
    async jiraPreviewComment(payload: { ref: JiraWriteIssue; body: string; intent: string }, windowId: string) {
      const connection = get(payload.ref.connectionId, windowId);
      const issue = await issueByRef(payload.ref, windowId);
      return jiraWriteConfirmationDtoSchema.parse(
        await writesFor(windowId).previewComment(issue.ref, payload.body, payload.intent, connection.accountPurpose),
      );
    },
    async jiraExecuteComment(
      payload: { ref: JiraWriteIssue; body: string; confirmation: JiraWriteConfirmation },
      windowId: string,
    ) {
      const issue = await issueByRef(payload.ref, windowId);
      return invokeWrite(() => writesFor(windowId).executeComment(issue.ref, payload.body, payload.confirmation));
    },
    async jiraPreviewWorklog(
      payload: {
        ref: JiraWriteIssue;
        seconds: number;
        started: string;
        comment?: string;
        intent: string;
      },
      windowId: string,
    ) {
      const connection = get(payload.ref.connectionId, windowId);
      const issue = await issueByRef(payload.ref, windowId);
      const identity =
        connection.verifiedIdentity?.kind === "cloud"
          ? { kind: "cloud" as const, accountId: connection.verifiedIdentity.accountId }
          : connection.verifiedIdentity?.kind === "data-center"
            ? { kind: "data-center" as const, name: connection.verifiedIdentity.name }
            : undefined;
      return jiraWriteConfirmationDtoSchema.parse(
        await writesFor(windowId).previewWorklog(
          issue.ref,
          payload,
          payload.intent,
          connection.accountPurpose,
          identity,
        ),
      );
    },
    async jiraExecuteWorklog(
      payload: {
        ref: JiraWriteIssue;
        seconds: number;
        started: string;
        comment?: string;
        intent?: string;
        confirmation: JiraWriteConfirmation;
      },
      windowId: string,
    ) {
      const connection = get(payload.ref.connectionId, windowId);
      const issue = await issueByRef(payload.ref, windowId);
      const identity =
        connection.verifiedIdentity?.kind === "cloud"
          ? { kind: "cloud" as const, accountId: connection.verifiedIdentity.accountId }
          : connection.verifiedIdentity?.kind === "data-center"
            ? { kind: "data-center" as const, name: connection.verifiedIdentity.name }
            : undefined;
      return invokeWrite(() =>
        writesFor(windowId).executeWorklog(
          issue.ref,
          payload,
          payload.confirmation,
          connection.accountPurpose,
          identity,
        ),
      );
    },
    async jiraPreviewAssign(
      payload: { ref: JiraWriteIssue; assignee: JiraAssignRequest; intent: string },
      windowId: string,
    ) {
      const issue = await issueByRef(payload.ref, windowId);
      return jiraWriteConfirmationDtoSchema.parse(
        await writesFor(windowId).previewAssign(issue.ref, payload.assignee, payload.intent),
      );
    },
    async jiraExecuteAssign(
      payload: { ref: JiraWriteIssue; assignee: JiraAssignRequest; confirmation: JiraWriteConfirmation },
      windowId: string,
    ) {
      const issue = await issueByRef(payload.ref, windowId);
      return invokeWrite(() => writesFor(windowId).executeAssign(issue.ref, payload.assignee, payload.confirmation));
    },
    async jiraPreviewRemoteLink(
      payload: { ref: JiraWriteIssue; url: string; title: string; globalId: string; intent: string },
      windowId: string,
    ) {
      const issue = await issueByRef(payload.ref, windowId);
      return jiraWriteConfirmationDtoSchema.parse(
        writesFor(windowId).previewRemoteLink(issue.ref, payload, payload.intent),
      );
    },
    async jiraExecuteRemoteLink(
      payload: {
        ref: JiraWriteIssue;
        url: string;
        title: string;
        globalId: string;
        confirmation: JiraWriteConfirmation;
      },
      windowId: string,
    ) {
      const issue = await issueByRef(payload.ref, windowId);
      return invokeWrite(() => writesFor(windowId).executeRemoteLink(issue.ref, payload, payload.confirmation));
    },
    async jiraForgetCache(connectionId?: string) {
      manager.invalidate(connectionId);
      return { ok: true };
    },
  };
}
