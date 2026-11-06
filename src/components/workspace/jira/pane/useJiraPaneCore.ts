import { computed, reactive, ref, type Ref } from "vue";
import { rlog } from "../../../../lib/renderer-log.js";
import { type JiraDoneWithinDays, type JiraIssueSort, type JiraViewPreferences } from "../jira-view-preferences.js";
import { useAppStore } from "../../../../stores/app.js";
import { useNotificationStore } from "../../../../stores/notifications.js";
import { type CallableTransport } from "../../../../transport.js";
import { type JiraWorkspaceViewInput } from "../../../../../electron/shared/types/jira-workspace-views.js";
import {
  type JiraConnection,
  type JiraIssue,
  type JiraRecentSearch,
  type JiraRecentIssue,
  type JiraCacheMetadata,
  type JiraBoard,
  type JiraBoardAssignee,
  type JiraRepoBindingPreference,
  type JiraUiApi,
  type JiraSavedQuery,
  type JiraTransition,
  type JiraUserRef,
  type JiraIssueRef,
  type JiraComment,
} from "./jira-pane-types.js";
import type { JiraPaneContext } from "./jira-pane-context.js";
import type { JiraInboxPaneProps } from "./jira-pane-types.js";
import {
  composeFailureText,
  formatJiraFailureStatus,
  isJiraAccessFailure,
  jiraErrorLabelFor,
  jiraFailureCode,
  jiraFailureReason,
  jiraFailureStatus,
  type JiraFailureStatus,
} from "./jira-failure.js";

/** Markers of reads that a connection, workspace, profile or view switch supersedes; writes and creates are not among them. */
export const LOAD_BUSY_KEYS = ["search", "search-more", "board", "board-more", "sprint", "sprint-more"] as const;

/**
 * A detached (pop-out) context reads Jira and writes issue changes; it never saves views, scopes, queries or history.
 * These methods look absent to it, which every optional caller in the pane already handles.
 */
const DETACHED_BLOCKED_METHODS: ReadonlySet<string> = new Set([
  "saveJiraWorkspaceView",
  "renameJiraWorkspaceView",
  "reorderJiraWorkspaceViews",
  "removeJiraWorkspaceView",
  "setJiraWorkspaceActiveView",
  "refreshJiraWorkspaceViews",
  "setJiraWorkspaceProjectScope",
  "rememberJiraSearch",
  "rememberJiraIssueViewed",
  "saveJiraQuery",
  "deleteJiraQuery",
]);

function withoutPersistence<T extends object>(api: T): T {
  return new Proxy(api, {
    get(target, name, receiver) {
      if (typeof name === "string" && DETACHED_BLOCKED_METHODS.has(name)) return undefined;
      return Reflect.get(target, name, receiver);
    },
  });
}

export function useJiraPaneCore(ctx: JiraPaneContext, props: JiraInboxPaneProps) {
  const vars = {
    workspaceViewSaveTimer: undefined as ReturnType<typeof setTimeout> | undefined,
    pendingNativeViewSave: null as { workspaceId: string; viewId: string; input: JiraWorkspaceViewInput } | null,
    lastSavedNativeViewSignature: "",
    projectCatalogGeneration: 0,
    projectCatalogLoadingFor: "",
    nativeBoardCardsScrollTop: new Map<string, number>(),
    nativeBoardScrollTop: 0,
    connectionDraftRevision: 0,
    connectionTestSession: 0,
    loadedQuickFilterBoardKey: "",
    assigneeSearchTimer: undefined as ReturnType<typeof setTimeout> | undefined,
    assigneeSearchGeneration: 0,
    issuePreviewTimer: undefined as ReturnType<typeof setTimeout> | undefined,
    issuePreviewTrigger: null as HTMLElement | null,
    issuePreviewObserver: undefined as ResizeObserver | undefined,
    issuePreviewRequest: 0,
    issueOpenGeneration: 0,
    allSearchGeneration: 0,
    boardSearchTimer: undefined as ReturnType<typeof setTimeout> | undefined,
    commentsGeneration: 0,
    humanIdentitySearchGeneration: 0,
    connectionLoadGeneration: 0,
    boardRefreshGeneration: 0,
    selectedRefreshTask: undefined as { key: string; generation: number; promise: Promise<void> } | undefined,
    visibleRefreshTask: undefined as Promise<void> | undefined,
    pendingBoardChooserSequence: null as number | null,
    lastHandledBoardChooserSequence: 0,
    lastHandledIssueOpenSequence: 0,
    jiraResizeObserver: undefined as ResizeObserver | undefined,
    jiraWindowResizeHandler: undefined as (() => void) | undefined,
  };
  const connectionsOnly = computed(() => props.connectionsOnly);
  const jiraViewId = computed(() => props.jiraViewId || "issues");
  const store = useAppStore();
  const api = store.getApi() as CallableTransport;
  const preferencesRestored = ref(false);
  const restoringPreferences = ref(false);
  const restoredPreferences = ref<JiraViewPreferences | null>(null);
  const projectScopeChoice = ref<string[] | null>(null);
  const projectScopeConfigured = ref(false);
  const preferencesProfileId = computed(() => store.myActiveProfileId || "default");
  const canUseAttachmentFileDialogs = computed(() => !api.isRemote && !store.isMobileSession());
  const jiraRootRef = ref<HTMLElement | null>(null);
  const nativeIssueListRef = ref<HTMLElement | null>(null);
  const activeView = ref<"issues" | "board" | "settings">(jiraViewId.value === "issues" ? "issues" : "board");
  const ownIssuesBoardMode = ref(false);
  const recentGeneration = ref(0);
  const branchDialogOpen = ref(false);
  const isCompactPane = ref(false);
  const jiraDetailHeadingRef = ref<HTMLElement | null>(null);
  const connections = ref<JiraConnection[]>([]);
  const issues = ref<JiraIssue[]>([]);
  const recentSearches = ref<JiraRecentSearch[]>([]);
  const recentViewedIssues = ref<JiraRecentIssue[]>([]);
  const ownSearchIdentityLabel = ref("");
  const searchHasMore = ref(false);
  const allMyIssueCursors = ref(new Map<string, { cursor: string; jql: string; sourceLabel: string }>());
  const searchHasRun = ref(false);
  const searchFailed = ref(false);
  const searchCache = ref<JiraCacheMetadata | null>(null);
  const boards = ref<JiraBoard[]>([]);
  const boardId = ref(0);
  const boardIssueDetailOpen = ref(false);
  const selectedQuickFilterIds = ref<number[]>([]);
  const selectedBoardAssignee = ref<JiraBoardAssignee | null>(null);
  const boardMode = ref<"issues" | "backlog" | "sprints">("issues");
  const selected = ref<JiraIssue | null>(null);
  const jiraResultsRef = ref<HTMLElement | null>(null);
  const savedRepoBinding = ref<JiraRepoBindingPreference | null>(null);
  const connectionId = ref("");
  const jql = ref("assignee = currentUser() ORDER BY updated DESC");
  const textSearch = ref("");
  const busyActions = reactive<Record<string, boolean>>({});
  const busyTokens = new Map<string, Set<symbol>>();
  /**
   * One flag per user action: only the control that started it shows progress, and nothing else is locked by it.
   * Every request holds its own token and releases it unconditionally, so a request that was superseded still frees
   * its marker without hiding a newer request of the same key that is still running.
   */
  function beginBusy(key: string): () => void {
    const token = Symbol(key);
    let tokens = busyTokens.get(key);
    if (!tokens) busyTokens.set(key, (tokens = new Set()));
    tokens.add(token);
    busyActions[key] = true;
    return () => {
      const held = busyTokens.get(key);
      if (!held?.delete(token)) return;
      if (!held.size) {
        busyTokens.delete(key);
        delete busyActions[key];
      }
    };
  }
  function isBusy(...keys: string[]) {
    return keys.length ? keys.some((key) => busyActions[key] === true) : Object.keys(busyActions).length > 0;
  }
  function clearBusy(options: { only?: readonly string[] } = {}) {
    const keys = options.only ?? Object.keys(busyActions);
    for (const key of keys) {
      busyTokens.delete(key);
      delete busyActions[key];
    }
  }
  const errorText = ref("");
  const errorStatus = ref<JiraFailureStatus | null>(null);
  /** The pane banner. Writing it drops the status of the previous failure; `reportFailure` sets both together. */
  const error = computed({
    get: () => errorText.value,
    set: (value: string) => {
      errorText.value = value;
      errorStatus.value = null;
    },
  });
  const detached = computed(() => props.detached === true);
  const dynamicApi = (detached.value ? withoutPersistence(api) : api) as unknown as Omit<
    CallableTransport,
    keyof JiraUiApi
  > &
    JiraUiApi;
  const canPopOutIssue = computed(
    () => !detached.value && Boolean(props.workspaceId) && typeof api.openJiraIssuePopout === "function",
  );
  async function popOutSelectedIssue() {
    const issue = selected.value;
    if (!issue?.ref || !canPopOutIssue.value) return;
    const label = issue.ref.issueKey || issue.key || "the issue";
    try {
      const { connectionId, issueId, issueKey } = issue.ref;
      await api.openJiraIssuePopout({
        workspaceId: props.workspaceId,
        ref: { connectionId, issueId, issueKey },
        ...(issue.summary ? { summary: issue.summary.slice(0, 500) } : {}),
      });
    } catch (cause) {
      logFailure(`Could not open ${label} in its own window`, cause);
      useNotificationStore().showError(`Could not open ${label} in its own window`, cause, {
        workspaceId: props.workspaceId,
      });
      return;
    }
    ctx.clearSelectedIssue();
  }
  const canManageConnections = computed(() => !api.isRemote);
  const canManageQueries = computed(() => !api.isRemote);
  const canWriteJira = computed(
    () => typeof api.previewJiraWrite === "function" && typeof api.executeJiraWrite === "function",
  );
  const canLinkWorkspaces = computed(() => !api.isRemote);
  const savedQueries = ref<JiraSavedQuery[]>([]);
  const queryId = ref("");
  const doneWithinDays = ref<JiraDoneWithinDays | null>(14);
  const issueSort = ref<JiraIssueSort>("updated");
  const issueFilterText = ref("");
  const selectedSprintId = ref<number | null>(null);
  const transitions = ref<JiraTransition[]>([]);
  const transitionId = ref("");
  const activeRequiredFields = computed(
    () => transitions.value.find((item) => item.id === transitionId.value)?.requiredFields || [],
  );
  const selectedConnection = computed(() =>
    connections.value.find((connection) => connection.id === (selected.value?.ref?.connectionId || connectionId.value)),
  );
  const syncClock = ref(Date.now());
  function formatSyncAge(fetchedAt: number) {
    const elapsedMinutes = Math.max(0, Math.floor((syncClock.value - fetchedAt) / 60_000));
    if (!elapsedMinutes) return "less than a minute";
    const days = Math.floor(elapsedMinutes / 1440);
    const hours = Math.floor((elapsedMinutes % 1440) / 60);
    const minutes = elapsedMinutes % 60;
    if (days) return `${days}d${hours ? ` ${hours}h` : ""}`;
    if (hours) return `${hours}h${minutes ? ` ${minutes}m` : ""}`;
    return `${elapsedMinutes}m`;
  }
  function updateSyncClock() {
    syncClock.value = Date.now();
  }
  const jiraDescriptionRoutes = computed(() =>
    connections.value.map((connection) => ({
      connectionId: connection.id,
      label: connection.label,
      webUrl: connection.webUrl,
      issueKeyPrefixes: connection.issueKeyPrefixes || [],
    })),
  );
  async function mapSettledBounded<T, R>(items: T[], limit: number, mapper: (item: T) => Promise<R>) {
    const results = new Array<PromiseSettledResult<R>>(items.length);
    let next = 0;
    await Promise.all(
      Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (next < items.length) {
          const index = next++;
          try {
            results[index] = { status: "fulfilled", value: await mapper(items[index]) };
          } catch (reason) {
            results[index] = { status: "rejected", reason };
          }
        }
      }),
    );
    return results;
  }
  function jiraUserIdentity(user: JiraUserRef): string {
    return user.kind === "cloud" ? user.accountId : user.name;
  }
  function jiraUserOptionKey(user: JiraUserRef): string {
    return user.kind === "cloud" ? user.accountId : user.key || user.name;
  }
  /**
   * The one place a failed user action is reported: text with the action first, a `[renderer]` log line (context and
   * code only, never issue content) and the error ref next to the control. Without a target it is the pane banner,
   * the only place that also shows the machine-readable status; a local target gets the status appended as text.
   */
  function logFailure(context: string, cause: unknown) {
    const status = jiraFailureStatus(cause);
    const code = jiraFailureCode(cause);
    const label = context.trim().replace(/[\s.:]+$/, "");
    rlog("warn", `[jira] ${label}`, {
      context: label,
      ...(code ? { code } : {}),
      ...(status?.retryAfterMs ? { retryAfterMs: status.retryAfterMs } : {}),
    });
    return status;
  }
  /** Logs like `reportFailure` and returns the text, for a caller that renders it through its own state. */
  function reportFailureText(context: string, cause: unknown): string {
    const status = logFailure(context, cause);
    const text = composeFailureText(context, cause);
    return status ? `${text} (${formatJiraFailureStatus(status)})` : text;
  }
  function reportFailure(context: string, cause: unknown, target?: Ref<string>): string {
    const status = logFailure(context, cause);
    const text = composeFailureText(context, cause);
    if (target) {
      target.value = status ? `${text} (${formatJiraFailureStatus(status)})` : text;
    } else {
      error.value = text;
      errorStatus.value = status;
    }
    return text;
  }
  /** Some sources of a multi-connection call failed: the banner names each one with its own reason. */
  function reportPartialFailures(prefix: string, failures: Array<{ label: string; cause: unknown }>, suffix = ".") {
    const details = failures.map(({ label, cause }) => {
      logFailure(`${prefix} ${label}`, cause);
      const reason = jiraFailureReason(cause);
      return reason ? `${label} (${reason})` : label;
    });
    error.value = `${prefix} ${details.join(", ")}${suffix}`;
    errorStatus.value = failures.length === 1 ? jiraFailureStatus(failures[0].cause) : null;
  }
  function clearPaneError() {
    error.value = "";
  }
  function friendlyConnectionError(cause: unknown, fallback: string) {
    return jiraFailureReason(cause) || fallback;
  }
  const jiraErrorLabel = jiraErrorLabelFor;
  /** IPC structured clone rejects Vue proxies; send a fresh plain copy of the reactive issue ref. */
  function plainIssueRef(ref: JiraIssueRef): JiraIssueRef {
    return { provider: "jira", connectionId: ref.connectionId, issueId: ref.issueId, issueKey: ref.issueKey };
  }
  function jiraCommentAuthor(comment: JiraComment) {
    return (typeof comment.author === "string" ? comment.author : comment.author?.displayName) || "Jira user";
  }
  function issueUrl(issueKey: string) {
    const base = selectedConnection.value?.webUrl;
    if (!base) return "#";
    try {
      const url = new URL(base);
      url.pathname = `${url.pathname.replace(/\/$/, "")}/browse/${encodeURIComponent(issueKey)}`;
      return url.toString();
    } catch {
      return "#";
    }
  }
  function formatJiraDate(value: string) {
    const date = new Date(value);
    return Number.isNaN(date.getTime())
      ? value
      : new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date);
  }
  function formatAttachmentSize(size: number) {
    if (!Number.isFinite(size) || size < 0) return "Size unavailable";
    if (size < 1024) return `${size} B`;
    if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
    return `${(size / (1024 * 1024)).toFixed(1)} MB`;
  }
  return {
    props,
    connectionsOnly,
    jiraViewId,
    store,
    api,
    preferencesRestored,
    restoringPreferences,
    restoredPreferences,
    projectScopeChoice,
    projectScopeConfigured,
    preferencesProfileId,
    canUseAttachmentFileDialogs,
    jiraRootRef,
    nativeIssueListRef,
    activeView,
    ownIssuesBoardMode,
    recentGeneration,
    branchDialogOpen,
    isCompactPane,
    jiraDetailHeadingRef,
    connections,
    issues,
    recentSearches,
    recentViewedIssues,
    ownSearchIdentityLabel,
    searchHasMore,
    allMyIssueCursors,
    searchHasRun,
    searchFailed,
    searchCache,
    boards,
    boardId,
    boardIssueDetailOpen,
    selectedQuickFilterIds,
    selectedBoardAssignee,
    boardMode,
    selected,
    jiraResultsRef,
    savedRepoBinding,
    connectionId,
    jql,
    textSearch,
    busyActions,
    beginBusy,
    isBusy,
    clearBusy,
    error,
    errorStatus,
    dynamicApi,
    detached,
    canPopOutIssue,
    popOutSelectedIssue,
    canManageConnections,
    canManageQueries,
    canWriteJira,
    canLinkWorkspaces,
    savedQueries,
    queryId,
    doneWithinDays,
    issueSort,
    issueFilterText,
    selectedSprintId,
    transitions,
    transitionId,
    activeRequiredFields,
    selectedConnection,
    syncClock,
    formatSyncAge,
    updateSyncClock,
    jiraDescriptionRoutes,
    mapSettledBounded,
    jiraUserIdentity,
    jiraUserOptionKey,
    reportFailure,
    reportFailureText,
    reportPartialFailures,
    clearPaneError,
    isJiraAccessFailure,
    friendlyConnectionError,
    jiraErrorLabel,
    plainIssueRef,
    jiraCommentAuthor,
    issueUrl,
    formatJiraDate,
    formatAttachmentSize,
    vars,
  };
}
