import { computed, nextTick, reactive, ref, watch, type ComputedRef } from "vue";
import { type CallableTransport } from "../../../../transport.js";
import { rlog } from "../../../../lib/renderer-log.js";
import type { JiraWriteExecutePayload, JiraWritePreviewPayload } from "../../../../../electron/backend/ipc-schemas.js";
import {
  findJiraTaskWorkspaces,
  indexJiraBranchWorkspaces,
  isJiraTaskWorkspaceTerminal,
} from "../../../../../electron/shared/jira-task-workspaces.js";
import {
  type JiraCommentDraft,
  type JiraIssue,
  type JiraComment,
  type JiraIssueRef,
  type JiraWorkspaceRecord,
  type JiraRepoBindingPreference,
  type JiraWritePreview,
  type JiraTransition,
} from "./jira-pane-types.js";
import type { JiraPaneContext } from "./jira-pane-context.js";
import { parseJiraDuration } from "./jira-duration.js";
import { localDateTimeInputValue } from "./jira-local-time.js";
import { isSupersededActivation, jiraFailureCode } from "./jira-failure.js";

type AssignRequest = { kind: "user"; id: string; displayName?: string } | { kind: "me" } | { kind: "unassigned" };
type AssignTarget = { request: AssignRequest; label: string };
type WriteSurface = "header" | "composer" | "form";
type JiraWriteJournal = { journalId: string; status: string; outcome?: string };
type WriteBody =
  | { action: "comment"; body: string }
  | { action: "transition"; transitionId: string; fields: Record<string, unknown> }
  | { action: "assign"; assignee: AssignRequest }
  | { action: "remote-link"; url: string; title: string; globalId: string }
  | { action: "worklog"; seconds: number; started: string; comment: string };

const WRITE_ACTION_NOUNS: Record<string, string> = {
  comment: "comment",
  assign: "assignee change",
  transition: "status change",
  "remote-link": "link",
  worklog: "work log entry",
};
const WRITE_INTENT_MIN = 8;
const WRITE_INTENT_MAX = 500;
const WRITE_BODY_MAX = 32_000;
const COPY_NOTICE_MS = 2500;
const ASSIGN_SEARCH_DEBOUNCE_MS = 250;
type IssueDraft = { commentBody: string; reasonText: string; reasonEdited: boolean };

export type JiraWriteReasonControl = ReturnType<typeof createReason>;
export type JiraAssignTarget = AssignTarget;
function createReason(defaultText: ComputedRef<string>) {
  const state = reactive({ text: "", edited: false, open: false });
  const error = computed(() => {
    const length = state.text.trim().length;
    if (length > WRITE_INTENT_MAX) return `Keep the reason under ${WRITE_INTENT_MAX} characters.`;
    if (state.edited && length < WRITE_INTENT_MIN)
      return `The reason needs at least ${WRITE_INTENT_MIN} characters (${length}/${WRITE_INTENT_MIN}). It is kept in the audit log.`;
    return "";
  });
  watch(
    defaultText,
    (text) => {
      if (!state.edited) state.text = text;
    },
    { immediate: true },
  );
  function input(value: string) {
    state.text = value;
    state.edited = true;
    if (error.value) state.open = true;
  }
  function reset() {
    state.edited = false;
    state.text = defaultText.value;
    state.open = false;
  }
  function toggle() {
    state.open = !state.open;
  }
  function settle() {
    if (!state.text.trim()) reset();
  }
  return { state, defaultText, error, input, reset, settle, toggle, min: WRITE_INTENT_MIN };
}

function isHttpUrl(value: string) {
  try {
    const url = new URL(value.trim());
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function issueKeyOf(ref: { connectionId: string; issueId: string }) {
  return `${ref.connectionId}:${ref.issueId}`;
}

export function useJiraIssueDetail(ctx: JiraPaneContext) {
  const {
    activeRequiredFields,
    activeView,
    api,
    boardIssueDetailOpen,
    isBusy,
    canWriteJira,
    connectionId,
    connectionsOnly,
    dynamicApi,
    isCompactPane,
    isJiraAccessFailure,
    jiraDetailHeadingRef,
    jiraResultsRef,
    jiraRootRef,
    clearPaneError,
    nativeIssueListRef,
    plainIssueRef,
    preferencesProfileId,
    props,
    reportFailure,
    savedRepoBinding,
    selected,
    selectedConnection,
    beginBusy,
    store,
    branchDialogOpen,
    transitionId,
    transitions,
    vars,
  } = ctx;
  const issueReturnNativeIssueId = ref("");
  const commentComposerInput = ref<HTMLTextAreaElement | null>(null);
  const writeDetailsRef = ref<HTMLDetailsElement | null>(null);
  const jiraCommentDrafts = ref<JiraCommentDraft[]>([]);
  const issueTriggerRef = ref<HTMLButtonElement | null>(null);
  const issueReturnScrollTop = ref(0);
  const selectedRefreshError = ref("");
  const selectedRefreshing = ref(false);
  const workspaceLinksOpen = ref(false);
  const issuePreviewIssue = ref<JiraIssue | null>(null);
  const issuePreviewDetails = ref<JiraIssue | null>(null);
  const issuePreviewVisible = ref(false);
  const issuePreviewLoading = ref(false);
  const issuePreviewError = ref("");
  const issuePreviewRef = ref<HTMLElement | null>(null);
  const issuePreviewStyle = ref<Record<string, string>>({ top: "0px", left: "0px" });
  const issueLoading = ref(false);
  const issuePendingKey = ref("");
  const attachmentDownloads = reactive<Record<string, "saving" | "saved" | "cancelled">>({});
  const attachmentUploadState = ref<"idle" | "uploading" | "uploaded">("idle");
  const attachmentError = ref("");
  const workspaceLinkError = ref("");
  const commentDraftsError = ref("");
  const developmentError = ref("");
  const writeError = ref("");
  const writeSurface = ref<WriteSurface>("header");
  watch(writeError, (text) => {
    if (text && writeSurface.value === "form" && writeDetailsRef.value) writeDetailsRef.value.open = true;
  });
  const commentBody = ref("");
  const worklogComment = ref("");
  const writeCardKind = ref<"transition" | "assign" | null>(null);
  const assignTarget = ref<AssignTarget | null>(null);
  const statusMenuRef = ref<HTMLDetailsElement | null>(null);
  const assignMenuRef = ref<HTMLDetailsElement | null>(null);
  const statusPillRef = ref<HTMLElement | null>(null);
  const assignTriggerRef = ref<HTMLElement | null>(null);
  const writeCardRef = ref<HTMLElement | null>(null);
  const commentsListRef = ref<HTMLElement | null>(null);
  const transitionsError = ref("");
  const copyNotice = ref("");
  const copyError = ref("");
  const assignSearchText = ref("");
  const assignSearchResults = ref<Array<{ id: string; label: string }>>([]);
  const assignSearchLoading = ref(false);
  const assignSearchError = ref("");
  const issueDrafts = new Map<string, IssueDraft>();
  let focusNewCommentPending = false;
  const writeConfirmation = ref<{
    token: string;
    intent: string;
    preview: string;
    account?: { displayName: string; purpose: string };
  } | null>(null);
  const comments = ref<JiraComment[]>([]);
  const commentsLoading = ref(false);
  const commentsError = ref("");
  const writeAction = ref("comment");
  /** A compact pane leaves the issue to show the identity form; the pending assignment keeps the issue to come back to. */
  const pendingAssignIssue = ref<JiraIssue | null>(null);
  /** An agent-written comment waits for an explicit preview and Confirm; the user did not type that text. */
  const draftReviewActive = ref(false);
  const writeActionOptions = [
    { value: "remote-link", label: "Add link" },
    { value: "worklog", label: "Log work" },
  ];
  const transitionFields = reactive(new Map<string, string>());
  const remoteUrl = ref("");
  const remoteTitle = ref("");
  const worklogDuration = ref("1h");
  const worklogParsed = computed(() => parseJiraDuration(worklogDuration.value));
  const worklogSeconds = computed(() => (worklogParsed.value.ok ? worklogParsed.value.seconds : 0));
  const worklogStarted = ref(localDateTimeInputValue(new Date()));
  watch(writeAction, (action) => {
    if (action === "worklog") worklogStarted.value = localDateTimeInputValue(new Date());
  });
  const writeFieldError = computed(() => {
    if (writeAction.value === "remote-link" && remoteUrl.value.trim() && !isHttpUrl(remoteUrl.value))
      return "Enter a full link starting with http:// or https://.";
    if (writeAction.value === "worklog" && !worklogParsed.value.ok) return worklogParsed.value.error;
    if (writeAction.value === "worklog" && worklogComment.value.length > WRITE_BODY_MAX)
      return `Keep the text under ${WRITE_BODY_MAX.toLocaleString("en-US")} characters.`;
    if (writeAction.value === "worklog" && worklogStarted.value && Number.isNaN(Date.parse(worklogStarted.value)))
      return "Enter a valid start time.";
    return "";
  });
  const canPreviewWrite = computed(() => {
    if (writeFieldError.value || activeReason.value.error.value) return false;
    const intentOk = writeIntent.value.trim().length >= WRITE_INTENT_MIN;
    if (writeAction.value === "comment")
      return intentOk && Boolean(commentBody.value.trim()) && commentBody.value.length <= WRITE_BODY_MAX;
    if (writeAction.value === "assign") return intentOk && Boolean(assignTarget.value);
    if (writeAction.value === "transition")
      return (
        intentOk &&
        Boolean(transitionId.value) &&
        activeRequiredFields.value.every(
          (field) => !field.required || (field.supported && Boolean(transitionFields.get(field.id)?.trim())),
        )
      );
    if (writeAction.value === "remote-link")
      return intentOk && Boolean(remoteUrl.value.trim() && remoteTitle.value.trim());
    return (
      intentOk && Number.isInteger(worklogSeconds.value) && worklogSeconds.value > 0 && Boolean(worklogStarted.value)
    );
  });
  const writeMessage = ref("");
  const writeJournals = ref<Record<string, JiraWriteJournal>>({});
  const selectedIssueKey = computed(() => (selected.value?.ref ? issueKeyOf(selected.value.ref) : ""));
  const issueLabel = computed(() => selected.value?.ref?.issueKey || selected.value?.key || "this issue");
  const commentReason = createReason(computed(() => `Comment on ${issueLabel.value}`));
  const writeReason = createReason(
    computed(() => {
      const key = issueLabel.value;
      if (writeAction.value === "transition") {
        const transition = transitions.value.find((item) => item.id === transitionId.value);
        return transition ? `Move ${key} to ${transition.to}` : `Change the status of ${key}`;
      }
      if (writeAction.value === "assign") {
        const target = assignTarget.value;
        if (!target) return `Change the assignee of ${key}`;
        return target.request.kind === "unassigned" ? `Unassign ${key}` : `Assign ${key} to ${target.label}`;
      }
      if (writeAction.value === "remote-link") return `Add a link to ${key}`;
      if (writeAction.value === "worklog") return `Log work on ${key}`;
      return `Update ${key}`;
    }),
  );
  const activeReason = computed(() => (writeAction.value === "comment" ? commentReason : writeReason));
  const writeIntent = computed<string>({
    get: () => activeReason.value.state.text,
    set: (value) => activeReason.value.input(value),
  });
  const canSendComment = computed(
    () =>
      Boolean(commentBody.value.trim()) &&
      commentBody.value.length <= WRITE_BODY_MAX &&
      commentReason.state.text.trim().length >= WRITE_INTENT_MIN &&
      !commentReason.error.value,
  );
  /** Every field a preview was built from; an edit of any of them makes the confirmation stale. */
  const previewFieldsKey = computed(() =>
    JSON.stringify([
      writeAction.value,
      writeIntent.value,
      commentBody.value,
      transitionId.value,
      [...transitionFields.entries()],
      assignTarget.value?.request ?? null,
      remoteUrl.value,
      remoteTitle.value,
      worklogDuration.value,
      worklogStarted.value,
      worklogComment.value,
    ]),
  );
  /** The exact action the user saw in the preview; execute sends this and never rebuilds it from the live form. */
  let previewedWrite: {
    token: string;
    key: string;
    fieldsKey: string;
    body: WriteBody;
    ref: IssueScope["ref"];
  } | null = null;
  watch(previewFieldsKey, (fieldsKey) => {
    if (!writeConfirmation.value || previewedWrite?.fieldsKey === fieldsKey) return;
    writeConfirmation.value = null;
    draftReviewActive.value = false;
  });
  const commentBodyError = computed(() =>
    commentBody.value.length > WRITE_BODY_MAX
      ? `Keep the text under ${WRITE_BODY_MAX.toLocaleString("en-US")} characters.`
      : "",
  );
  function stashDraft() {
    const key = selectedIssueKey.value;
    if (!key) return;
    if (commentBody.value.trim())
      issueDrafts.set(key, {
        commentBody: commentBody.value,
        reasonText: commentReason.state.text,
        reasonEdited: commentReason.state.edited,
      });
    else issueDrafts.delete(key);
  }
  watch(
    selectedIssueKey,
    (_key, previousKey) => {
      if (previousKey && commentBody.value.trim())
        issueDrafts.set(previousKey, {
          commentBody: commentBody.value,
          reasonText: commentReason.state.text,
          reasonEdited: commentReason.state.edited,
        });
    },
    { flush: "sync" },
  );
  function restoreDraft() {
    const draft = issueDrafts.get(selectedIssueKey.value);
    if (!draft) return;
    commentBody.value = draft.commentBody;
    if (draft.reasonEdited) {
      commentReason.state.edited = true;
      commentReason.state.text = draft.reasonText;
    }
  }
  function setWriteJournal(key: string, journal: JiraWriteJournal | null) {
    if (!key) return;
    const next = { ...writeJournals.value };
    if (journal) next[key] = journal;
    else delete next[key];
    writeJournals.value = next;
  }
  /** Unresolved writes are kept per issue, so switching issues does not lose the Reconcile handle. */
  const writeJournal = computed<JiraWriteJournal | null>({
    get: () => writeJournals.value[selectedIssueKey.value] ?? null,
    set: (journal) => setWriteJournal(selectedIssueKey.value, journal),
  });
  /** What an async request must remember about the issue it was started for, to drop or redirect a stale answer. */
  function issueScope() {
    const ref = selected.value?.ref;
    if (!ref) return null;
    const key = issueKeyOf(ref);
    const generation = vars.issueOpenGeneration;
    return {
      key,
      ref: plainIssueRef(ref),
      label: ref.issueKey,
      isCurrent: () => selectedIssueKey.value === key && vars.issueOpenGeneration === generation,
    };
  }
  type IssueScope = NonNullable<ReturnType<typeof issueScope>>;
  /** A user action whose issue is no longer on screen: the form cannot show it any more, so the banner does. */
  function reportStaleFailure(scope: IssueScope, context: string, cause: unknown) {
    reportFailure(`${context} (${scope.label})`, cause);
  }
  function logStaleFailure(context: string, cause: unknown) {
    rlog("info", `[jira] ${context} (answer for an issue no longer shown)`, {
      context,
      ...(jiraFailureCode(cause) ? { code: jiraFailureCode(cause) } : {}),
    });
  }
  function clearIssueErrors() {
    writeError.value = "";
    attachmentError.value = "";
    workspaceLinkError.value = "";
    commentDraftsError.value = "";
    developmentError.value = "";
  }
  const linkWorkspaceId = ref("");
  const profileWorkspaces = computed(() => {
    const payload = store.payload as
      | {
          appState?: {
            workspaces?: Array<{
              id: string;
              name: string;
              profileId?: string;
              workItems?: Array<{ ref: JiraIssueRef }>;
            }>;
          };
        }
      | undefined;
    return (payload?.appState?.workspaces || []).filter(
      (workspace) => (workspace.profileId || "default") === store.myActiveProfileId,
    );
  });
  const workspaceOptions = computed(() =>
    profileWorkspaces.value.filter(
      (workspace) =>
        !workspace.workItems?.some(
          (item) =>
            item.ref.connectionId === selected.value?.ref?.connectionId &&
            item.ref.issueId === selected.value?.ref?.issueId,
        ),
    ),
  );
  const workspaceSelectOptions = computed(() =>
    workspaceOptions.value.map((workspace) => ({ value: workspace.id, label: workspace.name })),
  );
  const linkedWorkspaces = computed(() =>
    profileWorkspaces.value.filter((workspace) =>
      workspace.workItems?.some(
        (item) =>
          item.ref.connectionId === selected.value?.ref?.connectionId &&
          item.ref.issueId === selected.value?.ref?.issueId,
      ),
    ),
  );
  const matchingDevelopmentWorkspaces = computed(() => {
    const ref = selected.value?.ref;
    if (!ref) return [];
    return findJiraTaskWorkspaces(workspaceRecords.value, ref, store.myActiveProfileId || "default")
      .map((workspace) => ({
        id: workspace.id,
        name: workspace.name,
        terminal: isJiraTaskWorkspaceTerminal(workspace),
        status:
          workspace.task?.startedAt || (workspace.task?.state && workspace.task.state !== "idle")
            ? "started"
            : "prepared",
        statusLabel: isJiraTaskWorkspaceTerminal(workspace)
          ? workspace.task?.state === "failed"
            ? "Failed"
            : workspace.task?.state === "stopped"
              ? "Stopped"
              : "Completed"
          : workspace.task?.startedAt || (workspace.task?.state && workspace.task.state !== "idle")
            ? "Started"
            : "Prepared",
        summary:
          workspace.task?.jiraIssueSnapshots?.find(
            (snapshot) => snapshot.ref.connectionId === ref.connectionId && snapshot.ref.issueId === ref.issueId,
          )?.fields?.summary ||
          workspace.task?.description ||
          "Development task",
        activityAt: Date.parse(workspace.lastWorkedAt || workspace.task?.startedAt || "") || 0,
      }))
      .sort((left, right) => right.activityAt - left.activityAt);
  });
  const branchWorkspaceIndex = computed(() =>
    indexJiraBranchWorkspaces(workspaceRecords.value, store.myActiveProfileId || "default"),
  );
  const matchingBranchWorkspaces = computed(() => {
    const ref = selected.value?.ref;
    if (!ref) return [];
    return (branchWorkspaceIndex.value.get(`${ref.connectionId}:${ref.issueId}`) || [])
      .map((workspace) => ({
        id: workspace.id,
        name: workspace.name,
        repository: workspace.quickfix?.repositoryName || "",
        baseBranch: workspace.quickfix?.baseBranch || "",
        activityAt: Date.parse(workspace.lastWorkedAt || "") || 0,
      }))
      .sort((left, right) => right.activityAt - left.activityAt);
  });
  const primaryBranchWorkspace = computed(() => matchingBranchWorkspaces.value[0] ?? null);
  /** Names the branch workspaces of an issue for the marker on board cards and list rows; empty when it has none. */
  function branchWorkspaceTitle(ref: { connectionId: string; issueId: string } | undefined): string {
    if (!ref) return "";
    const names = (branchWorkspaceIndex.value.get(`${ref.connectionId}:${ref.issueId}`) || []).map(
      (workspace) => workspace.name,
    );
    if (!names.length) return "";
    return names.length === 1
      ? `Branch workspace: ${names[0]}`
      : `${names.length} branch workspaces: ${names.join(", ")}`;
  }
  const recentBranchWorkspaces = computed(() => {
    const connection = connectionId.value;
    if (!connection || connection === "__all__") return [];
    const profileId = store.myActiveProfileId || "default";
    return workspaceRecords.value
      .filter(
        (workspace) =>
          workspace.kind !== "task" && workspace.quickfix && (workspace.profileId || "default") === profileId,
      )
      .flatMap((workspace) =>
        (workspace.workItems || [])
          .filter((item) => item.ref.connectionId === connection && ctx.issueMatchesProjectScope(item.ref.issueKey))
          .map((item) => ({
            id: workspace.id,
            name: workspace.name,
            issueKey: item.ref.issueKey,
            summary: item.summary || "Branch workspace",
            statusLabel: "Branch",
            activityAt: Date.parse(workspace.lastWorkedAt || "") || 0,
          })),
      );
  });
  const recentDevelopmentWorkspaces = computed(() => {
    const connection = connectionId.value;
    if (!connection || connection === "__all__") return [];
    return [...recentBranchWorkspaces.value, ...recentTaskWorkspaces.value]
      .sort((left, right) => right.activityAt - left.activityAt)
      .slice(0, 5);
  });
  const recentTaskWorkspaces = computed(() => {
    const connection = connectionId.value;
    if (!connection || connection === "__all__") return [];
    return workspaceRecords.value
      .filter((workspace) => (workspace.profileId || "default") === (store.myActiveProfileId || "default"))
      .filter((workspace) => workspace.kind === "task" && workspace.task?.jiraIssueRefs?.length)
      .flatMap((workspace) => {
        const started = Boolean(
          workspace.task?.startedAt || (workspace.task?.state && workspace.task.state !== "idle"),
        );
        if (!started) return [];
        return (workspace.task?.jiraIssueRefs || [])
          .filter((ref) => ref.connectionId === connection && ctx.issueMatchesProjectScope(ref.issueKey))
          .map((ref) => ({
            id: workspace.id,
            name: workspace.name,
            issueKey: ref.issueKey,
            summary:
              workspace.task?.jiraIssueSnapshots?.find(
                (snapshot) => snapshot.ref.connectionId === ref.connectionId && snapshot.ref.issueId === ref.issueId,
              )?.fields?.summary ||
              workspace.task?.description ||
              "Development task",
            statusLabel: isJiraTaskWorkspaceTerminal(workspace)
              ? workspace.task?.state === "failed"
                ? "Failed"
                : workspace.task?.state === "stopped"
                  ? "Stopped"
                  : "Completed"
              : "Started",
            activityAt: Date.parse(workspace.lastWorkedAt || workspace.task?.startedAt || "") || 0,
          }));
      });
  });
  const hasExistingDevelopmentWorkspace = computed(() =>
    matchingDevelopmentWorkspaces.value.some((item) => !item.terminal),
  );
  const workspaceRecords = computed(() => {
    const payload = store.payload as { appState?: { workspaces?: JiraWorkspaceRecord[] } } | null;
    return payload?.appState?.workspaces || [];
  });
  async function openRecentDevelopment(workspaceId: string) {
    try {
      await store.activateWorkspace(workspaceId);
    } catch (cause) {
      if (!isSupersededActivation(cause)) reportFailure("Could not open the recent development workspace", cause);
    }
  }
  const currentWorkspace = computed(() =>
    workspaceRecords.value.find((workspace) => workspace.id === props.workspaceId),
  );
  function positionIssuePreview() {
    const trigger = vars.issuePreviewTrigger;
    const popup = issuePreviewRef.value;
    if (!trigger?.isConnected || !popup) return;
    const rect = trigger.getBoundingClientRect();
    const popupRect = popup.getBoundingClientRect();
    const width = Math.min(340, window.innerWidth - 24);
    const top =
      rect.bottom + popupRect.height + 8 <= window.innerHeight - 12
        ? rect.bottom + 8
        : Math.max(12, rect.top - popupRect.height - 8);
    const next = {
      top: `${Math.max(12, Math.min(top, window.innerHeight - popupRect.height - 12))}px`,
      left: `${Math.max(12, Math.min(rect.left, window.innerWidth - popupRect.width - 12))}px`,
      width: `${width}px`,
    };
    const current = issuePreviewStyle.value;
    if (current.top !== next.top || current.left !== next.left || current.width !== next.width)
      issuePreviewStyle.value = next;
  }
  /** The popover grows when the description arrives; it is placed again whenever its own size changes. */
  watch(issuePreviewRef, (element) => {
    vars.issuePreviewObserver?.disconnect();
    vars.issuePreviewObserver = undefined;
    if (!element || typeof ResizeObserver === "undefined") return;
    vars.issuePreviewObserver = new ResizeObserver(positionIssuePreview);
    vars.issuePreviewObserver.observe(element);
  });
  function scheduleIssuePreview(issue: JiraIssue, event: MouseEvent | FocusEvent) {
    if (!issue.ref?.issueId || !(event.currentTarget instanceof HTMLElement)) return;
    if (vars.issuePreviewTimer) clearTimeout(vars.issuePreviewTimer);
    const request = ++vars.issuePreviewRequest;
    const trigger = event.currentTarget;
    issuePreviewIssue.value = issue;
    issuePreviewDetails.value = null;
    issuePreviewError.value = "";
    issuePreviewLoading.value = true;
    issuePreviewVisible.value = false;
    vars.issuePreviewTimer = setTimeout(async () => {
      if (request !== vars.issuePreviewRequest || !trigger.isConnected) return;
      const rect = trigger.getBoundingClientRect();
      const width = Math.min(340, window.innerWidth - 24);
      const left = Math.max(12, Math.min(rect.left, window.innerWidth - width - 12));
      vars.issuePreviewTrigger = trigger;
      issuePreviewStyle.value = {
        top: `${Math.max(12, Math.min(rect.bottom + 8, window.innerHeight - 220))}px`,
        left: `${left}px`,
        width: `${width}px`,
      };
      issuePreviewVisible.value = true;
      await nextTick();
      if (request !== vars.issuePreviewRequest || !issuePreviewRef.value) return;
      positionIssuePreview();
      try {
        const detail = (await api.getJiraIssue({
          connectionId: issue.ref.connectionId,
          issueId: issue.ref.issueId,
          cacheOnly: true,
        } as Parameters<NonNullable<CallableTransport["getJiraIssue"]>>[0])) as JiraIssue | null;
        if (detail) {
          if (request === vars.issuePreviewRequest) issuePreviewDetails.value = detail;
        }
        if ((!detail || detail.cache?.stale) && request === vars.issuePreviewRequest) {
          const refreshed = (await api.getJiraIssue({
            connectionId: issue.ref.connectionId,
            issueId: issue.ref.issueId,
            forceRefresh: true,
          } as Parameters<NonNullable<CallableTransport["getJiraIssue"]>>[0])) as JiraIssue;
          if (request === vars.issuePreviewRequest) issuePreviewDetails.value = refreshed;
        }
      } catch (cause) {
        if (request === vars.issuePreviewRequest) {
          if (isJiraAccessFailure(cause)) dismissIssuePreview();
          else reportFailure("Issue preview unavailable", cause, issuePreviewError);
        }
      } finally {
        if (request === vars.issuePreviewRequest) issuePreviewLoading.value = false;
      }
    }, 350);
  }
  function dismissIssuePreview() {
    if (vars.issuePreviewTimer) clearTimeout(vars.issuePreviewTimer);
    vars.issuePreviewRequest++;
    issuePreviewVisible.value = false;
    issuePreviewIssue.value = null;
    issuePreviewDetails.value = null;
    issuePreviewLoading.value = false;
    issuePreviewError.value = "";
  }
  /** Drops everything that belongs to the issue being replaced; runs when the next issue arrives, not when it is asked for. */
  function resetIssueState() {
    workspaceLinksOpen.value = false;
    selectedRefreshError.value = "";
    if (writeDetailsRef.value) writeDetailsRef.value.open = false;
    branchDialogOpen.value = false;
    writeAction.value = "comment";
    draftReviewActive.value = false;
    agentDraftInUse = null;
    commentBody.value = "";
    worklogComment.value = "";
    commentReason.reset();
    writeReason.reset();
    writeCardKind.value = null;
    assignTarget.value = null;
    transitionId.value = "";
    transitions.value = [];
    transitionsLoading.value = false;
    transitionsError.value = "";
    transitionFields.clear();
    copyNotice.value = "";
    copyError.value = "";
    resetAssignSearch();
    statusMenuRef.value?.removeAttribute("open");
    assignMenuRef.value?.removeAttribute("open");
    writeConfirmation.value = null;
    writeMessage.value = "";
    ctx.repoPreferenceNotice.value = "";
    attachmentUploadState.value = "idle";
    for (const attachmentId of Object.keys(attachmentDownloads)) delete attachmentDownloads[attachmentId];
    comments.value = [];
    commentsError.value = "";
    vars.commentsGeneration++;
    commentsLoading.value = false;
    clearIssueErrors();
  }
  async function openIssue(issue: JiraIssue, event?: { currentTarget: EventTarget | null }) {
    const requestedIssueRef = {
      connectionId: issue.ref?.connectionId || connectionId.value,
      issueId: issue.ref?.issueId || issue.id || issue.key || "",
    };
    const generation = ++vars.issueOpenGeneration;
    if (event?.currentTarget instanceof HTMLButtonElement) issueTriggerRef.value = event.currentTarget;
    else issueTriggerRef.value = null;
    dismissIssuePreview();
    boardIssueDetailOpen.value = activeView.value === "board";
    if (ctx.isNativeSavedView.value || activeView.value === "board")
      issueReturnNativeIssueId.value = requestedIssueRef.issueId;
    if (!selected.value && (ctx.isNativeSavedView.value || activeView.value === "board")) {
      ctx.captureNativePresentationScroll(ctx.nativeListPresentation.value ? "list" : "board");
    } else if (!selected.value && jiraRootRef.value) {
      issueReturnScrollTop.value = jiraRootRef.value.scrollTop;
    }
    issuePendingKey.value = issueKeyOf(requestedIssueRef);
    issueLoading.value = true;
    clearPaneError();
    vars.commentsGeneration++;
    commentsLoading.value = false;
    /** The previous issue stays on screen, dimmed, until the next one is here. */
    const showIssue = (next: JiraIssue) => {
      stashDraft();
      resetIssueState();
      selected.value = next;
      restoreDraft();
      issueLoading.value = false;
      issuePendingKey.value = "";
    };
    try {
      const cached = await dynamicApi.getJiraIssue?.({ ...requestedIssueRef, cacheOnly: true });
      if (generation !== vars.issueOpenGeneration) return;
      if (cached) {
        showIssue(cached as JiraIssue);
        if (cached.cache?.stale) void refreshSelectedIssue(requestedIssueRef, generation);
      } else {
        const refreshed = (await dynamicApi.getJiraIssue?.({ ...requestedIssueRef, forceRefresh: true })) as JiraIssue;
        if (generation !== vars.issueOpenGeneration) return;
        if (!refreshed) throw new Error("The Jira issue was not returned.");
        showIssue(refreshed);
      }
      if (!selected.value) throw new Error("The Jira issue was not returned.");
      const viewedRef = selected.value.ref ? plainIssueRef(selected.value.ref) : null;
      const viewedProfileId = preferencesProfileId.value;
      if (viewedRef && dynamicApi.rememberJiraIssueViewed) {
        void dynamicApi
          .rememberJiraIssueViewed({ ref: viewedRef })
          .then(() => {
            if (
              generation === vars.issueOpenGeneration &&
              requestedIssueRef.connectionId === connectionId.value &&
              viewedProfileId === preferencesProfileId.value
            )
              void ctx.loadJiraRecents(requestedIssueRef.connectionId);
          })
          .catch(() => {});
      }
      void loadComments({ background: true });
      void loadUnresolvedWrites(generation);
      savedRepoBinding.value = null;
      if (selected.value?.ref && selected.value.projectKey && !api.isRemote) {
        try {
          const preference = (await api.getJiraRepoBindingPreference({
            connectionId: selected.value.ref.connectionId,
            projectKey: selected.value.projectKey,
          })) as JiraRepoBindingPreference | null;
          if (generation !== vars.issueOpenGeneration) return;
          savedRepoBinding.value = preference;
        } catch (cause) {
          if (generation !== vars.issueOpenGeneration) return;
          reportFailure("Could not load the saved repository target for this project", cause, ctx.repoPreferenceNotice);
        }
      }
      if (isCompactPane.value) {
        await nextTick();
        if (jiraRootRef.value) jiraRootRef.value.scrollTop = 0;
        jiraDetailHeadingRef.value?.focus();
      }
    } catch (cause) {
      if (generation === vars.issueOpenGeneration) {
        if (isJiraAccessFailure(cause)) {
          stashDraft();
          selected.value = null;
          boardIssueDetailOpen.value = false;
          vars.issueOpenGeneration++;
          issueLoading.value = false;
          issuePendingKey.value = "";
        }
        reportFailure("Could not load issue details", cause);
      }
    } finally {
      if (generation === vars.issueOpenGeneration) {
        issueLoading.value = false;
        issuePendingKey.value = "";
      }
    }
  }
  async function refreshSelectedIssue(
    ref: { connectionId: string; issueId: string },
    generation = vars.issueOpenGeneration,
    refreshAgainAfterInFlight = false,
  ) {
    const key = `${ref.connectionId}:${ref.issueId}`;
    const activeTask = vars.selectedRefreshTask;
    if (activeTask) {
      if (activeTask.key === key && activeTask.generation === generation && !refreshAgainAfterInFlight) {
        await activeTask.promise;
        return;
      }
      await activeTask.promise;
      if (generation !== vars.issueOpenGeneration) return;
      if (refreshAgainAfterInFlight) return refreshSelectedIssue(ref, generation, false);
    }
    if (generation !== vars.issueOpenGeneration) return;
    selectedRefreshing.value = true;
    const task = {
      key,
      generation,
      promise: (async () => {
        try {
          const refreshed = await dynamicApi.getJiraIssue?.({ ...ref, forceRefresh: true });
          if (!refreshed || generation !== vars.issueOpenGeneration) return;
          if (selected.value?.ref?.connectionId === ref.connectionId && selected.value.ref.issueId === ref.issueId) {
            selected.value = refreshed as JiraIssue;
            selectedRefreshError.value =
              refreshed.cache?.refreshError?.message ||
              (refreshed.cache?.stale ? "Jira returned saved issue details." : "");
          }
        } catch (cause) {
          if (generation === vars.issueOpenGeneration) {
            if (isJiraAccessFailure(cause)) {
              stashDraft();
              selected.value = null;
              selectedRefreshError.value = "";
              boardIssueDetailOpen.value = false;
              reportFailure("Jira issue access is no longer available", cause);
              vars.issueOpenGeneration++;
            } else {
              reportFailure("Could not refresh", cause, selectedRefreshError);
            }
          }
        }
      })(),
    };
    vars.selectedRefreshTask = task;
    try {
      await task.promise;
    } finally {
      if (vars.selectedRefreshTask === task) vars.selectedRefreshTask = undefined;
      if (!vars.selectedRefreshTask) selectedRefreshing.value = false;
    }
  }
  function clearSelectedIssue() {
    stashDraft();
    vars.issueOpenGeneration++;
    issueLoading.value = false;
    issuePendingKey.value = "";
    selected.value = null;
    selectedRefreshError.value = "";
    boardIssueDetailOpen.value = false;
    workspaceLinksOpen.value = false;
    attachmentUploadState.value = "idle";
    if (ctx.isNativeSavedView.value || activeView.value === "board") {
      ctx.restoreNativePresentationScroll(ctx.nativeListPresentation.value ? "list" : "board", true);
      return;
    }
    void nextTick(() => {
      if (jiraRootRef.value) jiraRootRef.value.scrollTop = issueReturnScrollTop.value;
      const trigger = issueTriggerRef.value;
      if (trigger?.isConnected) trigger.focus({ preventScroll: true });
      else if (ctx.nativeListPresentation.value) nativeIssueListRef.value?.focus({ preventScroll: true });
      else jiraResultsRef.value?.focus({ preventScroll: true });
    });
  }
  async function downloadIssueAttachment(attachment: NonNullable<JiraIssue["attachments"]>[number]) {
    const issue = selected.value;
    const scope = issueScope();
    if (!issue?.ref || !scope || typeof dynamicApi.saveJiraIssueAttachment !== "function") {
      attachmentError.value = "Attachment downloads are unavailable in this app session.";
      return;
    }
    if (attachmentDownloads[attachment.id] === "saving") return;
    attachmentDownloads[attachment.id] = "saving";
    attachmentError.value = "";
    try {
      const result = await dynamicApi.saveJiraIssueAttachment({
        connectionId: issue.ref.connectionId,
        issueId: issue.ref.issueId,
        attachmentId: attachment.id,
      });
      if (scope.isCurrent()) attachmentDownloads[attachment.id] = result.saved ? "saved" : "cancelled";
    } catch (cause) {
      const generic = "Could not download an attachment";
      if (!scope.isCurrent()) return reportStaleFailure(scope, generic, cause);
      delete attachmentDownloads[attachment.id];
      reportFailure(generic, cause, attachmentError);
      attachmentError.value = attachmentError.value.replace(generic, `Could not download ${attachment.fileName}`);
    }
  }
  async function uploadIssueAttachment() {
    const issue = selected.value;
    const scope = issueScope();
    if (!issue?.ref || !scope || typeof dynamicApi.uploadJiraIssueAttachment !== "function") {
      attachmentError.value = "Attachment uploads are unavailable in this app session.";
      return;
    }
    if (attachmentUploadState.value === "uploading") return;
    attachmentUploadState.value = "uploading";
    attachmentError.value = "";
    try {
      const result = await dynamicApi.uploadJiraIssueAttachment({
        connectionId: issue.ref.connectionId,
        issueId: issue.ref.issueId,
      });
      const context = "Could not upload the Jira attachment";
      if (!result.ok) {
        if (result.error.status === "unknown" && result.error.journalId)
          setWriteJournal(scope.key, { journalId: result.error.journalId, status: "unknown" });
        if (scope.isCurrent()) attachmentUploadState.value = "idle";
        const cause = writeResultCause(result.error);
        if (!scope.isCurrent()) reportStaleFailure(scope, context, cause);
        else reportFailure(context, cause, attachmentError);
        return;
      }
      if ("cancelled" in result) {
        if (scope.isCurrent()) attachmentUploadState.value = "idle";
        return;
      }
      const { status, journalId } = result.data;
      setWriteJournal(scope.key, { journalId, status });
      const uploaded = status === "succeeded";
      if (scope.isCurrent()) attachmentUploadState.value = uploaded ? "uploaded" : "idle";
      if (uploaded) {
        void ctx.refreshVisibleJiraData({ afterWrite: true });
        return;
      }
      const cause = new Error(
        status === "unknown"
          ? "Jira could not confirm whether the file was attached. Reconcile before uploading it again."
          : "Jira rejected the attachment.",
      );
      if (!scope.isCurrent()) reportStaleFailure(scope, context, cause);
      else reportFailure(context, cause, attachmentError);
    } catch (cause) {
      if (!scope.isCurrent()) return reportStaleFailure(scope, "Could not upload the Jira attachment", cause);
      attachmentUploadState.value = "idle";
      reportFailure("Could not upload the Jira attachment", cause, attachmentError);
    }
  }
  async function attachSelectedIssue() {
    const scope = issueScope();
    if (!scope || !linkWorkspaceId.value || isBusy("link")) return;
    workspaceLinkError.value = "";
    const endLink = beginBusy("link");
    try {
      await api.attachJiraIssueToWorkspace?.({ workspaceId: linkWorkspaceId.value, ref: scope.ref });
      await api.refresh?.();
    } catch (cause) {
      if (!scope.isCurrent()) reportStaleFailure(scope, "Could not link Jira issue to workspace", cause);
      else reportFailure("Could not link Jira issue to workspace", cause, workspaceLinkError);
    } finally {
      endLink();
    }
  }
  async function detachSelectedIssue(targetWorkspaceId: string) {
    const scope = issueScope();
    if (!scope || isBusy("link")) return;
    workspaceLinkError.value = "";
    const endLink = beginBusy("link");
    try {
      await api.detachJiraIssueFromWorkspace?.({ workspaceId: targetWorkspaceId, ref: scope.ref });
      await api.refresh?.();
    } catch (cause) {
      if (!scope.isCurrent()) reportStaleFailure(scope, "Could not unlink Jira issue from workspace", cause);
      else reportFailure("Could not unlink Jira issue from workspace", cause, workspaceLinkError);
    } finally {
      endLink();
    }
  }
  function writeBody(): WriteBody {
    const action = writeAction.value;
    if (action === "transition")
      return { action, transitionId: transitionId.value, fields: Object.fromEntries(transitionFields.entries()) };
    if (action === "remote-link")
      return { action, url: remoteUrl.value.trim(), title: remoteTitle.value, globalId: remoteUrl.value.trim() };
    if (action === "assign") {
      const target = assignTarget.value;
      if (!target) throw new Error("Choose who to assign this issue to.");
      return { action, assignee: { ...target.request } };
    }
    if (action === "worklog")
      return {
        action,
        seconds: worklogSeconds.value,
        started: new Date(worklogStarted.value).toISOString(),
        comment: worklogComment.value,
      };
    return { action: "comment", body: commentBody.value };
  }
  function previewPayload(scope: IssueScope, body: WriteBody): JiraWritePreviewPayload {
    return { ...body, ref: scope.ref, intent: writeIntent.value.trim() };
  }
  function executePayload(
    previewed: NonNullable<typeof previewedWrite>,
    confirmation: JiraWritePreview,
  ): JiraWriteExecutePayload {
    const proof = { token: confirmation.token, intent: confirmation.intent, preview: confirmation.preview };
    return { ...previewed.body, ref: previewed.ref, confirmation: proof };
  }
  async function previewWrite() {
    const scope = issueScope();
    if (!scope || isBusy("write-preview", "write-send")) return;
    const noun = WRITE_ACTION_NOUNS[writeAction.value] || "action";
    const endPreview = beginBusy("write-preview");
    writeError.value = "";
    writeMessage.value = "";
    try {
      const fieldsKey = previewFieldsKey.value;
      const body = writeBody();
      const confirmation = (await api.previewJiraWrite?.(previewPayload(scope, body))) as JiraWritePreview | undefined;
      if (!scope.isCurrent()) return;
      if (!confirmation) throw new Error("Jira did not return a preview.");
      if (previewFieldsKey.value !== fieldsKey) return;
      previewedWrite = { token: confirmation.token, key: scope.key, fieldsKey, body, ref: scope.ref };
      writeConfirmation.value = confirmation;
    } catch (cause) {
      if (!scope.isCurrent()) logStaleFailure(`Could not preview the ${noun}`, cause);
      else reportFailure(`Could not preview the ${noun}`, cause, writeError);
    } finally {
      endPreview();
    }
  }
  function writeResultCause(failure: { message: string; code: string; retryAfterMs?: number }) {
    return Object.assign(new Error(failure.message), {
      code: failure.code,
      jiraError: { code: failure.code, ...(failure.retryAfterMs ? { retryAfterMs: failure.retryAfterMs } : {}) },
    });
  }
  async function sendWrite() {
    const scope = issueScope();
    const confirmation = writeConfirmation.value;
    if (!scope || !confirmation || isBusy("write-send", "write-preview")) return;
    const previewed = previewedWrite;
    if (!previewed || previewed.token !== confirmation.token || previewed.key !== scope.key) {
      writeConfirmation.value = null;
      return;
    }
    const action = previewed.body.action;
    const postedBody = previewed.body.action === "comment" ? previewed.body.body : "";
    const agentDraft = action === "comment" && agentDraftInUse?.key === scope.key ? agentDraftInUse : null;
    const noun = WRITE_ACTION_NOUNS[action] || "action";
    const context = `Could not send the ${noun}`;
    const successText = writeSuccessText(action, scope.label);
    let refreshAfterSuccess = false;
    const endSend = beginBusy("write-send");
    writeError.value = "";
    try {
      const result = await api.executeJiraWrite?.(executePayload(previewed, confirmation));
      if (!result) throw new Error("Jira did not answer the write.");
      if (writeConfirmation.value?.token === confirmation.token) writeConfirmation.value = null;
      if (!result.ok) {
        const cause = writeResultCause(result.error);
        if (result.error.status === "unknown" && result.error.journalId) {
          setWriteJournal(scope.key, { journalId: result.error.journalId, status: "unknown" });
          if (scope.isCurrent()) writeMessage.value = "Jira could not confirm whether this write was applied.";
        }
        if (!scope.isCurrent()) reportStaleFailure(scope, context, cause);
        else reportFailure(context, cause, writeError);
        return;
      }
      const { status, journalId } = result.data;
      setWriteJournal(scope.key, { journalId, status });
      refreshAfterSuccess = status === "succeeded";
      if (selectedIssueKey.value !== scope.key) {
        if (status === "succeeded" && action === "comment") dropSavedDraft(scope.key, postedBody);
        if (status !== "succeeded")
          reportStaleFailure(
            scope,
            status === "unknown" ? "Jira could not confirm whether the write was applied" : "Jira rejected the write",
            new Error("Check the issue in Jira before repeating it."),
          );
        return;
      }
      if (status === "succeeded") finishSuccessfulWrite(action, scope.key, postedBody);
      if (status === "failed") {
        writeError.value = `${context}: Jira rejected the write.`;
        return;
      }
      writeMessage.value =
        status === "unknown" ? "Jira could not confirm whether this write was applied." : successText;
    } catch (cause) {
      if (writeConfirmation.value?.token === confirmation.token) writeConfirmation.value = null;
      if (!scope.isCurrent()) {
        reportStaleFailure(scope, context, cause);
      } else {
        reportFailure(context, cause, writeError);
        writeError.value += " Check Jira before retrying, then prepare a new preview.";
      }
    } finally {
      endSend();
      if (refreshAfterSuccess) {
        if (agentDraft) void retireAgentDraft(agentDraft);
        void ctx.refreshVisibleJiraData({ afterWrite: true, refreshComments: action === "comment" });
      }
    }
  }
  function writeSuccessText(action: string, key: string) {
    if (action === "transition") {
      const target = transitions.value.find((item) => item.id === transitionId.value)?.to;
      return target ? `Moved ${key} to ${target}.` : `Changed the status of ${key}.`;
    }
    if (action === "assign") {
      const target = assignTarget.value;
      return !target || target.request.kind === "unassigned"
        ? `Unassigned ${key}.`
        : `Assigned ${key} to ${target.label}.`;
    }
    if (action === "remote-link") return `Link added to ${key}.`;
    if (action === "worklog") return `Work logged on ${key}.`;
    return `Comment added to ${key}.`;
  }
  /** The posted text may have been stashed as the unsent draft while another issue was opening; it is sent, not unsent. */
  function dropSavedDraft(key: string, postedBody: string) {
    if (issueDrafts.get(key)?.commentBody === postedBody) issueDrafts.delete(key);
  }
  function finishSuccessfulWrite(action: string, key: string, postedBody = "") {
    if (action === "comment") {
      if (commentBody.value === postedBody) {
        commentBody.value = "";
        commentReason.reset();
      }
      dropSavedDraft(key, postedBody);
      focusNewCommentPending = true;
    } else if (action === "transition" || action === "assign") {
      closeWriteCard({ restoreFocus: true });
    } else if (action === "worklog") {
      worklogComment.value = "";
    }
  }
  async function reconcileWrite() {
    const scope = issueScope();
    const journal = scope ? writeJournals.value[scope.key] : undefined;
    if (!scope || !journal?.journalId || !dynamicApi.reconcileJiraWrite || isBusy("write-reconcile")) return;
    writeError.value = "";
    const endReconcile = beginBusy("write-reconcile");
    try {
      const result = await dynamicApi.reconcileJiraWrite(journal.journalId);
      setWriteJournal(scope.key, { journalId: result.journalId, status: result.status, outcome: result.outcome });
      if (!scope.isCurrent()) return;
      writeMessage.value =
        result.status === "reconciled"
          ? `Reconciliation completed: ${result.outcome}. No write was resent.`
          : "Jira still cannot confirm the outcome. Do not submit again; check the issue in Jira and retry reconciliation later.";
      if (result.status === "reconciled") {
        writeError.value = "";
        clearPaneError();
      }
    } catch (cause) {
      if (!scope.isCurrent()) reportStaleFailure(scope, "Could not reconcile Jira write status", cause);
      else reportFailure("Could not reconcile Jira write status", cause, writeError);
    } finally {
      endReconcile();
    }
  }
  /** An earlier session may have left an unknown write on this issue; the journal is the source of truth. */
  async function loadUnresolvedWrites(generation: number) {
    const scope = issueScope();
    if (!scope || scope.key in writeJournals.value || !dynamicApi.getJiraWriteHistory) return;
    try {
      const rows = await dynamicApi.getJiraWriteHistory({
        connectionId: scope.ref.connectionId,
        issueId: scope.ref.issueId,
        limit: 20,
      });
      if (!scope.isCurrent() || generation !== vars.issueOpenGeneration || scope.key in writeJournals.value) return;
      const unresolved = (Array.isArray(rows) ? rows : []).find(
        (row): row is { id: string; state: string } =>
          Boolean(row) &&
          typeof row === "object" &&
          (row as { state?: unknown }).state === "unknown" &&
          typeof (row as { id?: unknown }).id === "string",
      );
      if (!unresolved) return;
      setWriteJournal(scope.key, { journalId: unresolved.id, status: "unknown" });
      if (writeDetailsRef.value) writeDetailsRef.value.open = true;
    } catch (cause) {
      rlog("warn", "[jira] Could not load unresolved Jira writes", {
        context: "Could not load unresolved Jira writes",
        ...(jiraFailureCode(cause) ? { code: jiraFailureCode(cause) } : {}),
      });
    }
  }
  async function loadComments(_options: { background?: boolean } = {}) {
    if (!selected.value?.ref || !dynamicApi.listJiraComments) return;
    const generation = ++vars.commentsGeneration;
    commentsLoading.value = true;
    commentsError.value = "";
    try {
      const loaded = (await dynamicApi.listJiraComments({ ref: plainIssueRef(selected.value.ref) })) as JiraComment[];
      if (generation === vars.commentsGeneration) {
        comments.value = Array.isArray(loaded) ? loaded : [];
        if (focusNewCommentPending) {
          focusNewCommentPending = false;
          void nextTick(() => focusLastComment());
        }
      }
    } catch (cause) {
      if (generation !== vars.commentsGeneration) return;
      reportFailure("Could not load comments", cause, commentsError);
    } finally {
      if (generation === vars.commentsGeneration) commentsLoading.value = false;
    }
  }
  async function loadJiraCommentDrafts() {
    if (!props.workspaceId || connectionsOnly.value || !dynamicApi.listJiraCommentDrafts) {
      jiraCommentDrafts.value = [];
      return;
    }
    const requestedWorkspaceId = props.workspaceId;
    commentDraftsError.value = "";
    try {
      const drafts = (await dynamicApi.listJiraCommentDrafts(requestedWorkspaceId)) as JiraCommentDraft[];
      if (requestedWorkspaceId === props.workspaceId) jiraCommentDrafts.value = drafts;
    } catch (cause) {
      if (requestedWorkspaceId === props.workspaceId)
        reportFailure("Could not load agent comment drafts", cause, commentDraftsError);
    }
  }
  function jiraDraftSourceName(sourceWorkspaceId: string) {
    const payload = store.payload as { appState?: { workspaces?: Array<{ id?: string; name?: string }> } } | null;
    return (
      payload?.appState?.workspaces?.find((workspace) => workspace.id === sourceWorkspaceId)?.name || sourceWorkspaceId
    );
  }
  /** The agent draft whose text is in the composer; once a comment is posted on its issue it is no longer unsent. */
  let agentDraftInUse: { draft: JiraCommentDraft; key: string } | null = null;
  async function retireAgentDraft(used: NonNullable<typeof agentDraftInUse>) {
    if (agentDraftInUse === used) agentDraftInUse = null;
    if (!dynamicApi.deleteJiraCommentDraft) return;
    try {
      await dynamicApi.deleteJiraCommentDraft({
        sourceWorkspaceId: used.draft.sourceWorkspaceId,
        draftId: used.draft.id,
      });
      jiraCommentDrafts.value = jiraCommentDrafts.value.filter(
        (item) => item.id !== used.draft.id || item.sourceWorkspaceId !== used.draft.sourceWorkspaceId,
      );
    } catch (cause) {
      reportFailure("Could not clear the agent comment draft", cause, commentDraftsError);
    }
  }
  async function useJiraCommentDraft(draftItem: JiraCommentDraft) {
    const draftKey = issueKeyOf(draftItem.ref);
    const ownUnsent = selectedIssueKey.value === draftKey ? commentBody.value : issueDrafts.get(draftKey)?.commentBody;
    if (ownUnsent?.trim() && ownUnsent !== draftItem.body) {
      const replace = await store.confirmInApp({
        title: "Replace your unsent comment?",
        message: `You have an unsent comment on ${draftItem.ref.issueKey}. Using the agent draft replaces it.`,
        confirmLabel: "Replace",
        danger: true,
      });
      if (!replace) return;
    }
    if (connectionId.value !== draftItem.ref.connectionId) {
      if (!ctx.connections.value.some((connection) => connection.id === draftItem.ref.connectionId)) {
        reportFailure(
          `Could not open ${draftItem.ref.issueKey}`,
          new Error("Its Jira connection is unavailable in this profile."),
          commentDraftsError,
        );
        return;
      }
      connectionId.value = draftItem.ref.connectionId;
      try {
        await ctx.onConnectionChange();
      } catch (cause) {
        reportFailure(`Could not open ${draftItem.ref.issueKey}`, cause, commentDraftsError);
        return;
      }
    }
    resetWrite();
    writeAction.value = "comment";
    await openIssue({ ref: draftItem.ref, key: draftItem.ref.issueKey });
    if (
      selected.value?.ref?.issueId !== draftItem.ref.issueId ||
      selected.value?.ref?.connectionId !== draftItem.ref.connectionId
    )
      return;
    commentBody.value = draftItem.body;
    agentDraftInUse = { draft: draftItem, key: draftKey };
    commentReason.input("Review agent-proposed comment");
    await nextTick();
    await openJiraAction("comment");
    draftReviewActive.value = true;
    writeAction.value = "comment";
    writeSurface.value = "composer";
    writeConfirmation.value = null;
    writeMessage.value = "";
    await previewWrite();
    if (!writeConfirmation.value) draftReviewActive.value = false;
  }
  async function confirmDraftReview() {
    if (!draftReviewActive.value || !writeConfirmation.value) return;
    await sendWrite();
    if (!writeConfirmation.value) draftReviewActive.value = false;
  }
  function cancelDraftReview() {
    draftReviewActive.value = false;
    writeConfirmation.value = null;
  }
  watch(commentBody, () => {
    if (draftReviewActive.value) cancelDraftReview();
  });
  async function clearJiraCommentDraft(draftItem: JiraCommentDraft) {
    if (!dynamicApi.deleteJiraCommentDraft) return;
    commentDraftsError.value = "";
    const confirmed = await store.confirmInApp({
      title: "Clear agent comment draft?",
      message: `Remove the unsent draft for ${draftItem.ref.issueKey}?`,
      confirmLabel: "Clear draft",
      danger: true,
    });
    if (!confirmed) return;
    try {
      await dynamicApi.deleteJiraCommentDraft({
        sourceWorkspaceId: draftItem.sourceWorkspaceId,
        draftId: draftItem.id,
      });
      jiraCommentDrafts.value = jiraCommentDrafts.value.filter(
        (item) => item.id !== draftItem.id || item.sourceWorkspaceId !== draftItem.sourceWorkspaceId,
      );
    } catch (cause) {
      reportFailure("Could not clear the agent comment draft", cause, commentDraftsError);
    }
  }
  let transitionsRequest = 0;
  const transitionsLoading = ref(false);
  async function loadTransitions() {
    const scope = issueScope();
    if (!scope || !api.listJiraTransitions) return;
    const request = ++transitionsRequest;
    transitionsLoading.value = true;
    try {
      const loaded = (await api.listJiraTransitions({ ref: scope.ref })) as JiraTransition[];
      if (!scope.isCurrent() || request !== transitionsRequest) return;
      transitions.value = loaded;
      if (!loaded.some((transition) => transition.id === transitionId.value)) transitionId.value = "";
    } catch (cause) {
      if (!scope.isCurrent() || request !== transitionsRequest) logStaleFailure("Could not load transitions", cause);
      else reportFailure("Could not load transitions", cause, transitionsError);
    } finally {
      if (request === transitionsRequest) transitionsLoading.value = false;
    }
  }
  function resetWrite() {
    draftReviewActive.value = false;
    writeConfirmation.value = null;
    writeError.value = "";
  }
  function closeMenuOf(element: HTMLElement | null) {
    element?.closest("details")?.removeAttribute("open");
  }
  function onStatusMenuToggle(event: Event) {
    ctx.positionExtraActionsMenu(event);
    if (!(event.currentTarget as HTMLDetailsElement).open) return;
    transitionsError.value = "";
    void loadTransitions();
  }
  function onAssignMenuToggle(event: Event) {
    ctx.positionExtraActionsMenu(event);
    if (!(event.currentTarget as HTMLDetailsElement).open) return;
    resetAssignSearch();
  }
  /** Closes a menu only for a click on one of its items, so typing in a field inside the menu keeps it open. */
  function closeMenuOnItemClick(event: MouseEvent) {
    const target = event.target;
    if (target instanceof Element && target.closest("button, a")) closeMenuOf(event.currentTarget as HTMLElement);
  }
  /** Escape closes an open menu and keeps the event from also closing the issue; a closed menu lets it through. */
  function onMenuEscape(event: KeyboardEvent) {
    const details = event.currentTarget as HTMLDetailsElement;
    if (!details.open) return;
    event.preventDefault();
    event.stopPropagation();
    details.open = false;
    details.querySelector<HTMLElement>("summary")?.focus();
  }
  function onMenuKeydown(event: KeyboardEvent) {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const details = event.currentTarget as HTMLDetailsElement;
    if (!details.open) return;
    const items = Array.from(details.querySelectorAll<HTMLElement>("[role=menuitem], .jira-assign-search input"));
    if (!items.length) return;
    event.preventDefault();
    const index = items.indexOf(document.activeElement as HTMLElement);
    const next = event.key === "ArrowDown" ? index + 1 : index - 1;
    items[(next + items.length) % items.length]?.focus();
  }
  async function showWriteCard(kind: "transition" | "assign") {
    writeAction.value = kind;
    writeSurface.value = "header";
    writeCardKind.value = kind;
    writeConfirmation.value = null;
    writeError.value = "";
    writeMessage.value = "";
    writeReason.reset();
    await nextTick();
    writeCardRef.value?.scrollIntoView?.({ block: "nearest" });
    const target = writeCardRef.value?.querySelector<HTMLElement>(
      "input:not([type=hidden]), select, button.jira-write-card__confirm",
    );
    target?.focus();
  }
  async function pickTransition(transition: JiraTransition) {
    transitionId.value = transition.id;
    transitionFields.clear();
    closeMenuOf(statusPillRef.value);
    await showWriteCard("transition");
  }
  async function pickAssignee(request: AssignRequest, label: string) {
    assignTarget.value = { request, label };
    closeMenuOf(assignTriggerRef.value);
    await showWriteCard("assign");
  }
  function assignToMe() {
    if (!selectedConnection.value?.ownIdentity) {
      chooseIdentityFirst();
      return;
    }
    void pickAssignee({ kind: "me" }, "me");
  }
  function chooseIdentityFirst() {
    closeMenuOf(assignTriggerRef.value);
    ctx.openInlineHumanIdentitySetup("assign");
    pendingAssignIssue.value = selected.value ? { ...selected.value } : null;
    if (isCompactPane.value) clearSelectedIssue();
  }
  function resetAssignSearch() {
    if (vars.assigneeSearchTimer) clearTimeout(vars.assigneeSearchTimer);
    vars.assigneeSearchGeneration++;
    assignSearchText.value = "";
    assignSearchResults.value = [];
    assignSearchLoading.value = false;
    assignSearchError.value = "";
  }
  function queueAssignSearch() {
    if (vars.assigneeSearchTimer) clearTimeout(vars.assigneeSearchTimer);
    const query = assignSearchText.value.trim();
    const issueRef = selected.value?.ref;
    const generation = ++vars.assigneeSearchGeneration;
    assignSearchError.value = "";
    if (!query || !issueRef || !dynamicApi.searchJiraUsers) {
      assignSearchResults.value = [];
      assignSearchLoading.value = false;
      return;
    }
    assignSearchLoading.value = true;
    vars.assigneeSearchTimer = setTimeout(async () => {
      try {
        const users = await dynamicApi.searchJiraUsers!({ connectionId: issueRef.connectionId, query, limit: 25 });
        if (generation !== vars.assigneeSearchGeneration) return;
        assignSearchResults.value = users.map((user) => ({ id: ctx.jiraUserIdentity(user), label: user.displayName }));
      } catch (cause) {
        if (generation !== vars.assigneeSearchGeneration) return;
        assignSearchResults.value = [];
        reportFailure("Could not search Jira users", cause, assignSearchError);
      } finally {
        if (generation === vars.assigneeSearchGeneration) assignSearchLoading.value = false;
      }
    }, ASSIGN_SEARCH_DEBOUNCE_MS);
  }
  watch(assignSearchText, () => queueAssignSearch());
  function closeWriteCard(options: { restoreFocus?: boolean } = {}) {
    const kind = writeCardKind.value;
    writeCardKind.value = null;
    writeConfirmation.value = null;
    writeError.value = "";
    transitionId.value = "";
    transitionFields.clear();
    assignTarget.value = null;
    writeReason.reset();
    if (options.restoreFocus) {
      void nextTick(() => (kind === "assign" ? assignTriggerRef.value : statusPillRef.value)?.focus());
    }
  }
  /** The remote link / work log form keeps its own two-step flow: preview, read, then confirm. */
  async function previewFormWrite() {
    writeSurface.value = "form";
    writeMessage.value = "";
    await previewWrite();
  }
  async function confirmWriteCard() {
    const kind = writeCardKind.value;
    if (!kind || isBusy("write-preview", "write-send")) return;
    writeAction.value = kind;
    writeSurface.value = "header";
    writeConfirmation.value = null;
    writeMessage.value = "";
    await previewWrite();
    if (writeConfirmation.value) await sendWrite();
  }
  async function sendComment() {
    if (draftReviewActive.value || !canSendComment.value || isBusy("write-preview", "write-send")) return;
    writeAction.value = "comment";
    writeSurface.value = "composer";
    writeConfirmation.value = null;
    writeMessage.value = "";
    await previewWrite();
    if (writeConfirmation.value) await sendWrite();
  }
  async function discardCommentDraft() {
    if (!commentBody.value.trim()) return;
    const confirmed = await store.confirmInApp({
      title: "Discard this comment?",
      message: `The unsent comment on ${issueLabel.value} will be deleted.`,
      confirmLabel: "Discard",
      danger: true,
    });
    if (!confirmed) return;
    commentBody.value = "";
    commentReason.reset();
    issueDrafts.delete(selectedIssueKey.value);
    writeError.value = "";
    commentComposerInput.value?.focus();
  }
  function focusLastComment() {
    const items = commentsListRef.value?.querySelectorAll<HTMLElement>(".jira-comment");
    const last = items?.[items.length - 1];
    if (last) {
      last.scrollIntoView?.({ block: "nearest" });
      last.focus({ preventScroll: true });
    } else commentComposerInput.value?.focus();
  }
  async function focusComposer() {
    await nextTick();
    commentComposerInput.value?.scrollIntoView?.({ block: "nearest" });
    commentComposerInput.value?.focus();
  }
  async function openJiraAction(action: "comment" | "transition") {
    if (action === "comment") {
      writeSurface.value = "composer";
      await focusComposer();
      return;
    }
    if (statusMenuRef.value) statusMenuRef.value.open = true;
    await nextTick();
    statusPillRef.value?.focus();
  }
  async function openFormAction(action: "remote-link" | "worklog") {
    writeAction.value = action;
    if (action === "worklog") worklogStarted.value = localDateTimeInputValue(new Date());
    writeSurface.value = "form";
    writeConfirmation.value = null;
    writeError.value = "";
    writeReason.reset();
    if (writeDetailsRef.value) writeDetailsRef.value.open = true;
    await nextTick();
    const target = writeDetailsRef.value?.querySelector<HTMLElement>("input, textarea");
    target?.scrollIntoView?.({ block: "nearest" });
    target?.focus();
  }
  let copyNoticeTimer: ReturnType<typeof setTimeout> | undefined;
  async function copyIssueText(what: "key" | "link") {
    const issue = selected.value;
    if (!issue) return;
    const key = issue.ref?.issueKey || issue.key || "";
    const text = what === "key" ? key : issue.url || ctx.issueUrl(key);
    copyError.value = "";
    try {
      if (!text || text === "#") throw new Error("This issue has no link to copy.");
      await navigator.clipboard.writeText(text);
      copyNotice.value = what === "key" ? `Copied ${key}` : "Copied link";
      if (copyNoticeTimer) clearTimeout(copyNoticeTimer);
      copyNoticeTimer = setTimeout(() => {
        copyNotice.value = "";
      }, COPY_NOTICE_MS);
    } catch (cause) {
      copyNotice.value = "";
      reportFailure("Could not copy to the clipboard", cause, copyError);
    }
  }
  async function openDevelopmentWorkspace(workspaceId: string) {
    if (
      ![...matchingDevelopmentWorkspaces.value, ...matchingBranchWorkspaces.value].some(
        (workspace) => workspace.id === workspaceId,
      )
    )
      return;
    developmentError.value = "";
    try {
      await store.activateWorkspace(workspaceId);
    } catch (cause) {
      if (!isSupersededActivation(cause))
        reportFailure("Could not open the development workspace", cause, developmentError);
    }
  }
  return {
    issueReturnNativeIssueId,
    commentComposerInput,
    writeDetailsRef,
    worklogComment,
    writeSurface,
    writeCardKind,
    assignTarget,
    statusMenuRef,
    assignMenuRef,
    statusPillRef,
    assignTriggerRef,
    writeCardRef,
    commentsListRef,
    transitionsError,
    copyNotice,
    copyError,
    assignSearchText,
    assignSearchResults,
    assignSearchLoading,
    assignSearchError,
    commentReason,
    writeReason,
    canSendComment,
    commentBodyError,
    onStatusMenuToggle,
    onAssignMenuToggle,
    closeMenuOnItemClick,
    onMenuKeydown,
    onMenuEscape,
    pickTransition,
    pickAssignee,
    assignToMe,
    chooseIdentityFirst,
    closeWriteCard,
    confirmWriteCard,
    previewFormWrite,
    sendComment,
    discardCommentDraft,
    pendingAssignIssue,
    draftReviewActive,
    confirmDraftReview,
    cancelDraftReview,
    focusComposer,
    openFormAction,
    copyIssueText,
    jiraCommentDrafts,
    issueTriggerRef,
    issueReturnScrollTop,
    selectedRefreshError,
    selectedRefreshing,
    workspaceLinksOpen,
    issuePreviewIssue,
    issuePreviewDetails,
    issuePreviewVisible,
    issuePreviewLoading,
    issuePreviewError,
    issuePreviewRef,
    issuePreviewStyle,
    issueLoading,
    issuePendingKey,
    attachmentDownloads,
    attachmentUploadState,
    attachmentError,
    workspaceLinkError,
    commentDraftsError,
    developmentError,
    writeError,
    writeFieldError,
    clearIssueErrors,
    commentBody,
    writeIntent,
    writeConfirmation,
    comments,
    commentsLoading,
    commentsError,
    writeAction,
    writeActionOptions,
    transitionFields,
    remoteUrl,
    remoteTitle,
    worklogDuration,
    worklogSeconds,
    worklogStarted,
    canPreviewWrite,
    writeMessage,
    writeJournal,
    linkWorkspaceId,
    profileWorkspaces,
    workspaceOptions,
    workspaceSelectOptions,
    linkedWorkspaces,
    matchingDevelopmentWorkspaces,
    matchingBranchWorkspaces,
    primaryBranchWorkspace,
    branchWorkspaceTitle,
    recentDevelopmentWorkspaces,
    hasExistingDevelopmentWorkspace,
    workspaceRecords,
    openRecentDevelopment,
    currentWorkspace,
    scheduleIssuePreview,
    dismissIssuePreview,
    openIssue,
    refreshSelectedIssue,
    clearSelectedIssue,
    downloadIssueAttachment,
    uploadIssueAttachment,
    attachSelectedIssue,
    detachSelectedIssue,
    previewWrite,
    sendWrite,
    reconcileWrite,
    loadComments,
    loadJiraCommentDrafts,
    jiraDraftSourceName,
    useJiraCommentDraft,
    clearJiraCommentDraft,
    transitionsLoading,
    loadTransitions,
    resetWrite,
    openJiraAction,
    openDevelopmentWorkspace,
  };
}
