import type { StatePayload, RecoveryResult } from "./types/state.js";
import type { JiraWorkspaceViewInput, JiraWorkspaceViewsState } from "./types/jira-workspace-views.js";
import type { JiraSmartFilterId } from "./jira-smart-filters.js";
import type {
  AzureClosedPrCleanupStarted,
  ReviewGitStarted,
  ReviewPrActionConfirmationResult,
} from "./types/ipc-results.js";
import type { StartPullRequestReviewInput, StartPullRequestReviewResult } from "./pull-request-review.js";
import type { StartPipelineAgentInput, StartPipelineAgentResult } from "./pipeline-agent.js";
import type { StartJiraDevelopmentInput, StartJiraDevelopmentResult } from "./jira-development.js";
import type {
  JiraAttachmentUploadResultDto,
  JiraWriteConfirmationDto,
  JiraWriteExecutePayload,
  JiraWriteInvokeResultDto,
  JiraWritePreviewPayload,
  StartReviewAgentPreparation,
} from "../backend/ipc-schemas.js";
import type {
  BrowsePaths,
  SshFileDelete,
  SshFileDownload,
  SshFileList,
  SshFileMkdir,
  SshFileRealpath,
  SshFileRename,
  SshFileTransferCancel,
  SshFileUpload,
} from "../backend/ipc-schemas.js";
import type { SshFileListing, SshFileTransferStarted } from "./ssh-file-events.js";
import type { MobileConnectedDevice } from "./mobile-session-events.js";
import type { RemoteBrowserSession } from "./remote-access.js";
import type {
  Workspace,
  WorkspaceUIState,
  AttentionSync,
  AzureConnectionPayload,
  AzureComment,
  AzureVote,
  AzureThreadStatus,
  OpenPr,
  ReviewBridgeDraft,
  ReviewBridgeDraftComment,
  ReviewBridgeQueue,
  ReviewBridgeDeleteDraft,
  ReviewBridgeDeleteComment,
  ReviewBridgeReplyWithChanges,
  ReviewBridgeSync,
  ReviewGitStart,
  AgentPromptSave,
  AgentPromptDelete,
  GitPayload,
  GitDiffPreview,
  GitCommit,
  GitTag,
  GitCherryPick,
  GitSquash,
  GitStashList,
  GitStashRef,
  GitStashFileDiff,
  GitStashBranch,
  GitStashImport,
  DockerAction,
  DockerSession,
  WorktreePayload,
  WorktreePathPreviewPayload,
  RemoveWorktree,
  QuickFixListProjects,
  QuickFixListRepositories,
  QuickFixListBranches,
  QuickFixCreate,
  GithubConnectionPayload,
  GithubComment,
  GithubReview,
  GithubAuditLogQuery,
  GithubAuditLogStats,
  GithubQuickFixListRepos,
  GithubQuickFixListBranches,
  GithubQuickFixCreate,
  TaskWorkspaceCreate,
  TaskWorkspaceAction,
  TaskRejectVerdict,
  TaskResendInstruction,
  TaskUpdateDescription,
  TaskRecoveryResolve,
  TaskCompanionCreate,
  TaskCompanionAnswer,
  ProfilePayload,
  NotificationShow,
  TelegramConnectionPayload,
  RerunCheck,
  SshHostCreate,
  SshHostUpdate,
  SshHostDelete,
  SshKeyImport,
  SshKeyRename,
  SshKeyGenerate,
  SshCertImport,
  SshAuthAnswer,
  SshAuthCancel,
  SshAcceptHostKey,
  SshRejectHostKey,
  SshConfigImport,
  SshKnownHostsImport,
  SshKeyTransferStart,
  SshKeyTransferStop,
  FileList,
  FileRead,
  FileWrite,
  FileCreate,
  FileRename,
  FileDelete,
  FileGitIgnore,
  FileMove,
  FileGitStatus,
  FileGitRefs,
  FileGitDiff,
  FileCommitFiles,
  FileCommitDiff,
  AzureAuditLogQuery,
  AzureAuditLogStats,
  ApprovalAuditLogQuery,
  ApprovalAuditLogDelete,
  ApprovalAuditLogStats,
  AccountCheckout,
  AccountDelete,
  AccountDiagnostics,
  AccountEmail,
  AccountEnrol,
  AccountNoticeAck,
  AccountRevoke,
  AccountSignInLink,
  AccountSignInStart,
  AccountSignOut,
  MobileCreatePairingInvitation,
  MobileRejectDevice,
  MobileRenameDevice,
  MobileUpdateDeviceAllowlist,
  MobileSetRemoteUiPaused,
  MobileAuditLogQuery,
  SettingsPayload,
} from "../backend/ipc-schemas.js";
import type { SshAuthRequest, SshAuthPromptCancel, SshConnectionState } from "./types/ssh.js";
import type { SshConnectionTestState, SshKey, SshKeyTransferState } from "./types/ssh.js";
import type { SshRuntimeCapabilities } from "./ssh-connection.js";
import type { PerformanceSnapshot, CpuProfileCaptureResult, RevealResult } from "./performance.js";
import type { AccountUiState } from "../backend/account/account-state.js";

export type { StatePayload };

export interface FilePopoutPayload {
  rootPath: string;
  relativePath: string;
  name: string;
  content?: string;
  dirty?: boolean;
}

export interface TerminalSize {
  cols: number;
  rows: number;
}

export interface TerminalDataPayload {
  sessionId: string;
  data: string;
  /**
   * Monotonic per-session sequence assigned by the runtime. Present on the
   * remote WS stream so a client can order a replay snapshot against the live
   * frames that follow it. Absent/ignored on the Electron IPC path.
   */
  seq?: number;
}

/**
 * Live progress frame emitted while a `git push` / force-push runs. Carries a
 * raw chunk of the git subprocess output (which includes any pre-push hook's
 * stdout+stderr) so the UI can show what a slow/blocking hook is doing instead
 * of a static "Pushing…" spinner.
 */
export interface GitPushProgressPayload {
  workspaceId: string;
  rootPath: string;
  chunk: string;
}

export interface TerminalReplayPayload {
  data: string;
  /** Present on the pushed WS `terminal:replay`; absent on the HTTP snapshot. */
  sessionId?: string;
  /** Newest sequence covered by this replay; live frames with seq <= this are duplicates. */
  throughSeq?: number;
  /** Renderer-local socket attempt; absent on Electron IPC and HTTP snapshots. */
  connectionGeneration?: number;
}

export interface TerminalExitPayload {
  sessionId: string;
  exitCode: number;
  /** True when the exit was deliberate (a restart), so consumers can skip
   *  crash-only handling such as exit alerts. */
  intentional?: boolean;
}

export interface StridetermAPI {
  // Core app
  openExternal: (url: string) => Promise<unknown>;
  openTerminalPath: (request: {
    path: string;
    workspaceCwd?: string;
    line?: number;
    column?: number;
    /**
     * Skip the configured opener and hand the path to the OS. Set by the
     * renderer when "internal" mode resolved a path the in-app Files pane
     * can't reach (anything outside the workspace root).
     */
    forceSystem?: boolean;
  }) => Promise<{
    ok: boolean;
    absPath?: string;
    error?: string;
    /** Set when the user's mode is "internal" — caller drives FileManager nav. */
    internal?: boolean;
    line?: number;
    column?: number;
  }>;
  /**
   * Resolve a paste-into-terminal request when the OS clipboard holds an
   * image. Returns a file path the renderer can type into the terminal —
   * either the existing path already in the clipboard (Snipping Tool /
   * ShareX etc.) or a freshly saved PNG in ~/Pictures/Screenshots.
   */
  pasteClipboardImageForTerminal: () => Promise<
    { ok: true; path: string; source: "clipboard-path" | "saved" } | { ok: false; reason?: string }
  >;
  showSystemNotification: (payload: NotificationShow) => Promise<unknown>;
  checkForUpdates: () => Promise<unknown>;
  checkCommand: (command: string) => Promise<unknown>;
  getState: () => Promise<StatePayload>;

  // Workspace management
  activateWorkspace: (workspaceId: string) => Promise<unknown>;
  activateProject: (projectId: string) => Promise<unknown>;
  activateSession: (sessionId: string) => Promise<unknown>;
  setWorkspaceUIState: (workspaceId: string, uiState: WorkspaceUIState["uiState"]) => Promise<unknown>;
  enableWorkspaceGrid: (layout: string, workspaceIds?: (string | null)[]) => Promise<unknown>;
  disableWorkspaceGrid: () => Promise<unknown>;
  setGridLayout: (layout: string) => Promise<unknown>;
  setGridCell: (cellIndex: number, workspaceId: string | null) => Promise<unknown>;
  swapGridCells: (a: number, b: number) => Promise<unknown>;
  syncAttentionContext: (payload: AttentionSync) => Promise<unknown>;
  clearAllAttention: () => Promise<unknown>;
  clearAlertForSession: (sessionId: string, options?: Record<string, unknown>) => Promise<unknown>;
  saveWorkspace: (workspace: Workspace) => Promise<unknown>;
  saveProject: (project: Workspace) => Promise<unknown>;
  deleteWorkspace: (workspaceId: string, options?: Record<string, unknown>) => Promise<unknown>;
  deleteProject: (projectId: string) => Promise<unknown>;
  reorderWorkspaces: (workspaceIds: string[]) => Promise<unknown>;
  reorderProjects: (projectIds: string[]) => Promise<unknown>;
  updateSettings: (settings: SettingsPayload) => Promise<unknown>;

  // Jira issue provider (read routes plus desktop-only Data Center connection setup).
  listJiraConnections: () => Promise<unknown>;
  nudgeJiraPolling: () => Promise<{ nudged: number }>;
  getJiraMyIssues: (payload: { refresh?: "cache-only" | "if-stale" | "force" }) => Promise<unknown>;
  getJiraRepoBindingPreference: (payload: { connectionId: string; projectKey: string }) => Promise<unknown>;
  ensureJiraWorkspace: () => Promise<unknown>;
  previewJiraTaskContext: (payload: {
    refs: Array<{ provider: "jira"; connectionId: string; issueId: string; issueKey: string }>;
    repo: {
      provider: "azure" | "github";
      connectionId: string;
      repoId: string;
      projectId?: string;
      repoName: string;
      remoteUrl: string;
      cwd: string;
    };
    baseBranch: string;
    branch: string;
    checkoutMode: "existing" | "worktree";
    taskConfig: { description: string; selectedFields: string[] };
  }) => Promise<unknown>;
  getJiraTaskContext: (workspaceId: string) => Promise<unknown>;
  attachJiraIssueToWorkspace: (payload: {
    workspaceId: string;
    ref: { connectionId: string; issueId: string; issueKey: string };
  }) => Promise<unknown>;
  detachJiraIssueFromWorkspace: (payload: {
    workspaceId: string;
    ref: { connectionId: string; issueId: string; issueKey: string };
  }) => Promise<unknown>;
  saveJiraCommentDraft: (payload: {
    sourceWorkspaceId: string;
    ref: { connectionId: string; issueId: string; issueKey: string };
    body: string;
  }) => Promise<unknown>;
  listJiraCommentDrafts: (workspaceId: string) => Promise<unknown>;
  deleteJiraCommentDraft: (payload: { sourceWorkspaceId: string; draftId: string }) => Promise<unknown>;
  saveJiraConnection: (connection: {
    id?: string;
    label: string;
    deployment: "cloud" | "data-center";
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
    accountPurpose?: "personal" | "technical";
  }) => Promise<unknown>;
  testJiraConnection: (connection: {
    id?: string;
    label: string;
    deployment: "cloud" | "data-center";
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
    accountPurpose?: "personal" | "technical";
  }) => Promise<unknown>;
  deleteJiraConnection: (connectionId: string) => Promise<unknown>;
  verifyJiraConnection: (connectionId: string) => Promise<unknown>;
  updateJiraConnectionMetadata: (payload: {
    connectionId: string;
    label: string;
    accountPurpose: "personal" | "technical";
    issueKeyPrefixes: string[];
    defaultJql: string;
    projectKeys: string[];
    pollSeconds: number;
  }) => Promise<unknown>;
  verifyJiraOwnIdentity: (payload: { connectionId: string; userId: string }) => Promise<unknown>;
  setJiraOwnIdentity: (payload: { connectionId: string; userId: string }) => Promise<unknown>;
  setJiraCommentAttribution: (payload: {
    enabled: boolean;
    text: string;
    position: "before" | "after";
  }) => Promise<unknown>;
  setJiraAgentAttachmentLimits: (payload: { maxFiles: number; maxMegabytes: number }) => Promise<unknown>;
  buildJiraOwnIssuesQuery: (payload: {
    connectionId: string;
    baseJql?: string;
    personalScope?: "open" | "all";
    projectKeys?: string[];
    smartFilters?: JiraSmartFilterId[];
  }) => Promise<{ jql: string; identityLabel: string }>;
  listJiraQueries: (connectionId: string) => Promise<unknown>;
  getJiraRecentSearches: (payload: { connectionId: string; limit?: number }) => Promise<unknown>;
  getJiraWorkspaceViews: (payload: { workspaceId: string }) => Promise<JiraWorkspaceViewsState>;
  saveJiraWorkspaceView: (payload: {
    workspaceId: string;
    view: JiraWorkspaceViewInput;
  }) => Promise<JiraWorkspaceViewsState>;
  getJiraWorkspaceProjectScope: (payload: { workspaceId: string; connectionId: string }) => Promise<string[] | null>;
  setJiraWorkspaceProjectScope: (payload: {
    workspaceId: string;
    connectionId: string;
    projectKeys: string[] | null;
  }) => Promise<string[] | null>;
  renameJiraWorkspaceView: (payload: {
    workspaceId: string;
    viewId: string;
    title: string;
  }) => Promise<JiraWorkspaceViewsState>;
  reorderJiraWorkspaceViews: (payload: { workspaceId: string; viewIds: string[] }) => Promise<JiraWorkspaceViewsState>;
  removeJiraWorkspaceView: (payload: { workspaceId: string; viewId: string }) => Promise<JiraWorkspaceViewsState>;
  setJiraWorkspaceActiveView: (payload: { workspaceId: string; viewId: string }) => Promise<JiraWorkspaceViewsState>;
  refreshJiraWorkspaceViews: (payload: { workspaceId: string; viewId?: string }) => Promise<JiraWorkspaceViewsState>;
  rememberJiraSearch: (payload: { connectionId: string; jql: string; label?: string }) => Promise<unknown>;
  getJiraRecentIssues: (payload: { connectionId: string; limit?: number }) => Promise<unknown>;
  rememberJiraIssueViewed: (payload: {
    ref: { provider: "jira"; connectionId: string; issueId: string; issueKey: string };
  }) => Promise<unknown>;
  listJiraFavoriteFilters: (connectionId: string) => Promise<unknown>;
  getJiraSavedFilter: (payload: { connectionId: string; filterId: string }) => Promise<unknown>;
  saveJiraQuery: (payload: {
    id?: string;
    connectionId: string;
    name: string;
    jql: string;
    notificationsEnabled?: boolean;
  }) => Promise<unknown>;
  deleteJiraQuery: (queryId: string) => Promise<unknown>;
  getJiraWriteHistory: (payload: { connectionId?: string; issueId?: string; limit?: number }) => Promise<unknown>;
  reconcileJiraWrite: (journalId: string) => Promise<{
    journalId: string;
    status: "reconciled" | "unknown";
    outcome: "applied" | "not-applied" | "unresolved";
  }>;
  listJiraProjects: (connectionId: string) => Promise<unknown>;
  listJiraBoards: (connectionId: string) => Promise<unknown>;
  searchJiraBoards: (payload: {
    connectionId: string;
    query?: string;
    cursor?: string;
    limit?: number;
    projectKeys?: string[];
  }) => Promise<unknown>;
  getJiraBoardView: (payload: {
    connectionId: string;
    boardId: number;
    mode?: "issues" | "backlog" | "sprints";
    cursor?: string;
    sprintId?: number;
    quickFilterIds?: number[];
    assignee?: { kind: "user"; id: string } | { kind: "unassigned" };
    doneWithinDays?: 7 | 14 | 30 | 90;
    cacheOnly?: boolean;
    forceRefresh?: boolean;
    refreshInBackground?: boolean;
    projectKeys?: string[];
  }) => Promise<unknown>;
  listJiraBoardQuickFilters: (payload: {
    connectionId: string;
    boardId: number;
    limit?: number;
    cursor?: string;
    cacheOnly?: boolean;
    forceRefresh?: boolean;
    refreshInBackground?: boolean;
  }) => Promise<unknown>;
  searchJiraUsers: (payload: { connectionId: string; query: string; limit?: number }) => Promise<unknown>;
  listJiraTransitions: (payload: {
    ref: { connectionId: string; issueId: string; issueKey: string };
  }) => Promise<unknown>;
  listJiraComments: (payload: { ref: { connectionId: string; issueId: string; issueKey: string } }) => Promise<unknown>;
  previewJiraWrite: (payload: JiraWritePreviewPayload) => Promise<JiraWriteConfirmationDto>;
  executeJiraWrite: (payload: JiraWriteExecutePayload) => Promise<JiraWriteInvokeResultDto>;
  searchJiraIssues: (payload: {
    connectionId: string;
    jql: string;
    limit?: number;
    cursor?: string;
    cacheOnly?: boolean;
    forceRefresh?: boolean;
    refreshInBackground?: boolean;
    projectKeys?: string[];
  }) => Promise<unknown>;
  getJiraIssue: (payload: {
    connectionId: string;
    issueId: string;
    cacheOnly?: boolean;
    forceRefresh?: boolean;
    refreshInBackground?: boolean;
  }) => Promise<unknown>;
  getJiraAttachmentContent: (payload: {
    connectionId: string;
    issueId: string;
    attachmentId: string;
  }) => Promise<{ mediaType: string; bytes: Uint8Array }>;
  saveJiraIssueAttachment: (payload: {
    connectionId: string;
    issueId: string;
    attachmentId: string;
  }) => Promise<{ saved: boolean; filePath?: string }>;
  uploadJiraIssueAttachment: (payload: {
    connectionId: string;
    issueId: string;
  }) => Promise<JiraAttachmentUploadResultDto>;

  // Azure integration
  verifyAzureConnection: (connection: AzureConnectionPayload) => Promise<unknown>;
  saveAzureConnection: (connection: AzureConnectionPayload) => Promise<unknown>;
  deleteAzureConnection: (connectionId: string) => Promise<unknown>;
  refreshAzure: () => Promise<unknown>;
  /** Starts the cleanup and resolves at once; the outcome arrives via `onAzureClosedPrCleanupFinished`. */
  cleanupAzureClosedPullRequests: (parentWorkspaceId: string) => Promise<AzureClosedPrCleanupStarted>;
  /** Starts a review Git operation and resolves at once; the outcome arrives via `onReviewGitOperation`. */
  startReviewGitOperation: (payload: ReviewGitStart) => Promise<ReviewGitStarted>;
  confirmReviewPrAction: (payload: {
    proposalId: string;
    approved: boolean;
  }) => Promise<ReviewPrActionConfirmationResult>;
  startPullRequestReview: (payload: StartPullRequestReviewInput) => Promise<StartPullRequestReviewResult>;
  startReviewAgentPreparation: (payload: StartReviewAgentPreparation) => Promise<{ operationId: string }>;
  stopReviewAgentPreparation: (payload: { operationId?: string; sessionId?: string }) => Promise<{ ok: boolean }>;
  queryAzureAuditLog: (filters: AzureAuditLogQuery) => Promise<unknown>;
  getAzureAuditStats: (filters: AzureAuditLogStats) => Promise<unknown>;
  queryApprovalAuditLog: (filters: ApprovalAuditLogQuery) => Promise<unknown>;
  getApprovalAuditStats: (filters: ApprovalAuditLogStats) => Promise<unknown>;
  /**
   * Delete approval-trail rows. Desktop transport only — the remote transport
   * leaves it undefined, which is what the Approvals tab checks before it
   * offers a delete control at all.
   */
  deleteApprovalAuditEntries: (payload: ApprovalAuditLogDelete) => Promise<unknown>;
  /** Desktop only: drop a failed operation that created nothing, freeing its idempotency key. */
  discardOperation: (operationId: string) => Promise<boolean>;
  markAzurePullRequestSeen: (prKey: string) => Promise<unknown>;
  openAzurePullRequest: (payload: OpenPr) => Promise<unknown>;
  commentAzurePullRequest: (payload: AzureComment) => Promise<unknown>;
  updateAzureThreadStatus: (payload: AzureThreadStatus) => Promise<unknown>;
  voteAzurePullRequest: (payload: AzureVote) => Promise<unknown>;
  azureCreatePullRequest: (payload: Record<string, unknown>) => Promise<unknown>;
  azureListRemoteBranches: (payload: Record<string, unknown>) => Promise<unknown>;
  azureQuickFixListProjects: (payload: QuickFixListProjects) => Promise<unknown>;
  azureQuickFixListRepositories: (payload: QuickFixListRepositories) => Promise<unknown>;
  azureQuickFixListBranches: (payload: QuickFixListBranches) => Promise<unknown>;
  azureQuickFixCreate: (payload: QuickFixCreate) => Promise<unknown>;
  rerunAzureCheck: (prKey: string, checkItem: RerunCheck["checkItem"]) => Promise<unknown>;
  listAzurePipelines: (payload: { connectionId: string }) => Promise<unknown>;
  listAzurePipelineRuns: (payload: {
    connectionId: string;
    projectName: string;
    pipelineId: number | string;
  }) => Promise<unknown>;
  getAzurePipelineRunSeed: (payload: {
    connectionId: string;
    projectName: string;
    pipelineId: number | string;
    runId: number | string;
  }) => Promise<unknown>;
  getAzurePipelineRunParameters: (payload: {
    connectionId: string;
    projectName: string;
    pipelineId: number | string;
    branch?: string;
  }) => Promise<unknown>;
  getAzurePipelineRefs: (payload: {
    connectionId: string;
    projectName: string;
    pipelineId: number | string;
  }) => Promise<unknown>;
  getAzurePipelineCommits: (payload: {
    connectionId: string;
    projectName: string;
    repositoryId: string;
  }) => Promise<unknown>;
  runAzurePipeline: (payload: {
    connectionId: string;
    projectName: string;
    pipelineId: number | string;
    branch?: string;
    parameters?: Record<string, string>;
    variables?: Array<{ name: string; value: string; isSecret?: boolean }>;
  }) => Promise<unknown>;
  getAzurePipelineRunStatus: (payload: {
    connectionId: string;
    projectName: string;
    pipelineId: number | string;
    runId: number | string;
  }) => Promise<unknown>;
  cancelAzureBuild: (payload: {
    connectionId: string;
    projectName: string;
    buildId: number | string;
  }) => Promise<unknown>;
  getAzureBuildLog: (payload: {
    connectionId: string;
    projectName: string;
    buildId: number | string;
  }) => Promise<unknown>;
  getAzurePipelineRunDetail: (payload: {
    connectionId: string;
    projectName: string;
    buildId: number | string;
  }) => Promise<unknown>;
  /** Starts an agent on a finished run and resolves at once; the outcome arrives as `operation:finished`. */
  startAzurePipelineAgent: (payload: StartPipelineAgentInput) => Promise<StartPipelineAgentResult>;
  /** Starts development on a Jira issue and resolves at once; the outcome arrives as `operation:finished`. */
  startJiraDevelopment: (payload: StartJiraDevelopmentInput) => Promise<StartJiraDevelopmentResult>;

  // GitHub integration
  verifyGitHubConnection: (connection: GithubConnectionPayload) => Promise<unknown>;
  saveGitHubConnection: (connection: GithubConnectionPayload) => Promise<unknown>;
  deleteGitHubConnection: (connectionId: string) => Promise<unknown>;
  refreshGitHub: () => Promise<unknown>;
  queryGitHubAuditLog: (filters: GithubAuditLogQuery) => Promise<unknown>;
  getGitHubAuditStats: (filters: GithubAuditLogStats) => Promise<unknown>;
  markGitHubPullRequestSeen: (prKey: string) => Promise<unknown>;
  openGitHubPullRequest: (payload: OpenPr) => Promise<unknown>;
  commentGitHubPullRequest: (payload: GithubComment) => Promise<unknown>;
  submitGitHubPullRequestReview: (payload: GithubReview) => Promise<unknown>;
  rerunGitHubCheck: (prKey: string, checkItem: RerunCheck["checkItem"]) => Promise<unknown>;
  githubListRemoteBranches: (payload: Record<string, unknown>) => Promise<unknown>;
  githubCreatePullRequest: (payload: Record<string, unknown>) => Promise<unknown>;
  githubQuickFixListRepos: (payload: GithubQuickFixListRepos) => Promise<unknown>;
  githubQuickFixListBranches: (payload: GithubQuickFixListBranches) => Promise<unknown>;
  githubQuickFixCreate: (payload: GithubQuickFixCreate) => Promise<unknown>;

  // Telegram integration
  verifyTelegramConnection: (connection: TelegramConnectionPayload) => Promise<unknown>;
  detectTelegramChats: (connection: TelegramConnectionPayload) => Promise<unknown>;
  saveTelegramConnection: (connection: TelegramConnectionPayload) => Promise<unknown>;
  deleteTelegramConnection: (connectionId: string) => Promise<unknown>;
  refreshTelegram: () => Promise<unknown>;

  // Account (plan §8.2) — DESKTOP-ONLY, including for the remote web renderer. Signing in, paying
  // and revoking are acts whose consequences land at this machine, and `remote-server.ts` routes
  // none of them. `getAccountState` is a read and is desktop-only for the same reason: the state it
  // returns is this installation's.
  getAccountState: () => Promise<unknown>;
  onAccountUpdated: (handler: (payload: AccountUiState) => void) => () => void;
  /**
   * Starts a passwordless sign-in for one pinned purpose. Returns as soon as the link is requested.
   *
   * NOT a promise that resolves when somebody opens the link: a call held open for fifteen minutes
   * cannot be cancelled, cannot be resent, and dies with the window that made it. The continuation
   * arrives on `account:updated`.
   */
  accountBeginSignIn: (payload: AccountSignInStart) => Promise<unknown>;
  accountRetryOnlineBootstrap: () => Promise<unknown>;
  accountCancelOnlineBootstrap: () => Promise<unknown>;
  /** The final confirmation, ON THIS DESKTOP: redeem the code and do the thing it was started for. */
  accountConfirmSignIn: () => Promise<unknown>;
  accountResendSignIn: () => Promise<unknown>;
  accountCancelSignIn: () => Promise<unknown>;
  /**
   * The OWNING account panel is closing: end the flow it started, and nobody else's (F09).
   *
   * Not a cancel. The window is resolved in the main process from the sender, so a renderer cannot
   * name the owner — and a panel that never started a sign-in, or one in a second window, changes
   * nothing at all.
   */
  accountReleaseSignInFlow: () => Promise<unknown>;
  /** The manual fallback. The one payload in this interface that carries a live credential. */
  accountSubmitSignInLink: (payload: AccountSignInLink) => Promise<unknown>;
  /** Starts a LOGIN-address change. The old address keeps working until the new one is confirmed. */
  accountChangeLoginEmail: (payload: AccountEmail) => Promise<unknown>;
  accountClearPendingEmailChange: () => Promise<unknown>;
  /** Dismisses the note about the login address remembered on this computer. */
  accountDismissOwnerEmailNotice: () => Promise<unknown>;
  /** Answers the refused-restore prompt: register this computer instead, or go back. */
  accountDismissRecoveryRefused: (payload: { answer: "register" | "back" }) => Promise<unknown>;
  accountEnrolInstallation: (payload: AccountEnrol) => Promise<unknown>;
  accountStartTrial: () => Promise<unknown>;
  accountRefreshOverview: () => Promise<unknown>;
  /** Answers `opened` or `pending`. NEVER the URL: a URL here is a URL in a state diff. */
  accountOpenCheckout: (payload: AccountCheckout) => Promise<unknown>;
  /** Copies the recent checkout link in the main process; the link itself never crosses IPC. */
  accountCopyCheckoutUrl: (payload: AccountCheckout) => Promise<unknown>;
  accountOpenBillingPortal: () => Promise<unknown>;
  accountRevoke: (payload: AccountRevoke) => Promise<unknown>;
  accountAcknowledgeNotice: (payload: AccountNoticeAck) => Promise<unknown>;
  accountSignOut: (payload: AccountSignOut) => Promise<unknown>;
  accountDelete: (payload: AccountDelete) => Promise<unknown>;
  /** Opt-in. Answers with a report reference to quote — never the report. */
  accountSubmitDiagnostics: (payload?: AccountDiagnostics) => Promise<unknown>;
  /** The same document, for saving locally when the upload is not available. */
  accountExportDiagnostics: (payload?: AccountDiagnostics) => Promise<unknown>;

  // Mobile integration (plan §10.5) — Electron/desktop-only; the remote-HTTP
  // transport does not implement these (see src/transport.ts).
  createMobilePairingInvitation: (options: MobileCreatePairingInvitation) => Promise<unknown>;
  cancelMobilePairingInvitation: () => Promise<unknown>;
  listMobileDevices: () => Promise<unknown>;
  renameMobileDevice: (payload: MobileRenameDevice) => Promise<unknown>;
  revokeMobileDevice: (deviceId: string) => Promise<unknown>;
  /** Removes an already-revoked device from the local list. Refuses an active one. */
  forgetMobileDevice: (deviceId: string) => Promise<unknown>;
  /** Review 3 §P0.1, §3.6: the code the user typed from the phone. The only path to a usable device. */
  approveMobileDevice: (deviceId: string, sas: string) => Promise<unknown>;
  /** Review 3 §P0.1: the human said they do not match, or dismissed the dialog. Revokes. */
  rejectMobileDevice: (payload: MobileRejectDevice) => Promise<unknown>;
  /** Devices waiting for that decision, so a restart can re-present the prompt rather than lose it. */
  listMobileDevicesAwaitingApproval: () => Promise<unknown>;
  updateMobileDeviceAllowlist: (payload: MobileUpdateDeviceAllowlist) => Promise<unknown>;
  setMobileDeviceRemoteUiPaused: (payload: MobileSetRemoteUiPaused) => Promise<unknown>;
  setMobileEnabled: (enabled: boolean) => Promise<unknown>;
  /** The managed relay's own flag — independent of `setMobileEnabled` (relay plan §10). */
  setMobileRelayEnabled: (enabled: boolean) => Promise<unknown>;
  /** Whether a relay session may be issued to a phone that does not offer end-to-end encryption (false = it may). */
  setMobileRelayRequireE2e: (requireE2e: boolean) => Promise<unknown>;
  /** Relay state, counters and origin — never a grant, a cookie or a payload. */
  getMobileRelayStatus: () => Promise<unknown>;
  refreshMobileConnectionHealth: () => Promise<unknown>;
  sendMobileTestPush: (deviceId: string) => Promise<unknown>;
  queryMobileAuditLog: (filters: MobileAuditLogQuery) => Promise<unknown>;

  // Review bridge
  createReviewBridgeDraftComment: (payload: ReviewBridgeDraftComment) => Promise<unknown>;
  saveReviewBridgeDraft: (payload: ReviewBridgeDraft) => Promise<unknown>;
  queueReviewBridgeDraft: (payload: ReviewBridgeQueue) => Promise<unknown>;
  deleteReviewBridgeDraft: (payload: ReviewBridgeDeleteDraft) => Promise<unknown>;
  deleteReviewBridgeComment: (payload: ReviewBridgeDeleteComment) => Promise<unknown>;
  replyWithCodeChanges: (payload: ReviewBridgeReplyWithChanges) => Promise<unknown>;
  saveAgentPrompt: (payload: AgentPromptSave) => Promise<unknown>;
  deleteAgentPrompt: (payload: AgentPromptDelete) => Promise<unknown>;
  syncReviewBridgePullRequest: (payload: ReviewBridgeSync) => Promise<unknown>;

  // Agent hooks
  regenerateRemoteToken: () => Promise<unknown>;
  listRemoteSessions: () => Promise<RemoteBrowserSession[]>;
  revokeRemoteSessions: (payload: { sessionRef?: string; all?: boolean }) => Promise<{ revoked: number }>;
  configureClaudeHook: () => Promise<unknown>;
  removeClaudeHook: () => Promise<unknown>;
  getClaudeHookStatus: () => Promise<unknown>;
  testClaudeHook: () => Promise<unknown>;
  configureGeminiHook: () => Promise<unknown>;
  removeGeminiHook: () => Promise<unknown>;
  getGeminiHookStatus: () => Promise<unknown>;
  testGeminiHook: () => Promise<unknown>;
  configureCodexHook: () => Promise<unknown>;
  removeCodexHook: () => Promise<unknown>;
  getCodexHookStatus: () => Promise<unknown>;
  testCodexHook: () => Promise<unknown>;
  configureCopilotHook: () => Promise<unknown>;
  removeCopilotHook: () => Promise<unknown>;
  getCopilotHookStatus: () => Promise<unknown>;
  testCopilotHook: () => Promise<unknown>;
  configureOpencodeHook: () => Promise<unknown>;
  removeOpencodeHook: () => Promise<unknown>;
  getOpencodeHookStatus: () => Promise<unknown>;
  testOpencodeHook: () => Promise<unknown>;
  getNotificationMetrics: () => Promise<unknown>;

  // Task runner
  recheckClaude: () => Promise<unknown>;
  checkProviders: () => Promise<unknown>;
  checkIsGitRepo: (cwd: string) => Promise<unknown>;
  probeDirectory: (cwd: string) => Promise<unknown>;
  createTaskWorkspace: (payload: TaskWorkspaceCreate) => Promise<unknown>;
  startTask: (payload: TaskWorkspaceAction) => Promise<unknown>;
  stopTask: (payload: TaskWorkspaceAction) => Promise<unknown>;
  pauseTask: (payload: TaskWorkspaceAction) => Promise<unknown>;
  resumeTask: (payload: TaskWorkspaceAction) => Promise<unknown>;
  resetTask: (payload: TaskWorkspaceAction) => Promise<unknown>;
  rejectTaskVerdict: (payload: TaskRejectVerdict) => Promise<unknown>;
  resendTaskInstruction: (payload: TaskResendInstruction) => Promise<unknown>;
  updateTaskDescription: (payload: TaskUpdateDescription) => Promise<unknown>;
  /**
   * The recovery batch is one of the few calls whose RESULT the renderer
   * reasons about rather than just re-applying — which candidate settled and
   * which failed — so the contract is typed all the way across the transport
   * instead of being cast back from `unknown` on the far side (V5 review,
   * §"P2 — recovery kontrakt končí před transportní hranicí", oprava 1).
   */
  resolveTaskRecovery: (decisions: TaskRecoveryResolve) => Promise<RecoveryResult<StatePayload>>;
  getTaskStatus: (workspaceId: string) => Promise<unknown>;
  createCompanionTask: (payload: TaskCompanionCreate) => Promise<unknown>;
  answerCompanionTask: (payload: TaskCompanionAnswer) => Promise<unknown>;

  // Tunnel
  refreshTunnel: () => Promise<unknown>;
  createCloudflareTunnel: () => Promise<unknown>;
  stopCloudflareTunnel: () => Promise<unknown>;

  // Terminal
  restartTerminal: (sessionId: string, options?: { sshPasswordSignIn?: boolean }) => Promise<unknown>;
  closeTerminal: (sessionId: string) => Promise<unknown>;
  getTerminalReplay: (sessionId: string) => Promise<TerminalReplayPayload>;
  resizeTerminal: (sessionId: string, size: TerminalSize) => void;
  /**
   * `originWorkspaceId` names the workspace whose UI the user typed in. It is
   * a hint the backend validates against the session — needed because an
   * attached task's Primary tab is presented inside the task workspace while
   * its session id still names the source workspace.
   *
   * `pointerArrival` marks `data` as a click synthesised from a tap: the
   * motion report to deliver first (empty when the app tracks no motion). The
   * backend sequences focus, arrival and click at the PTY.
   */
  writeTerminal: (sessionId: string, data: string, originWorkspaceId?: string, pointerArrival?: string) => void;
  submitTerminal: (sessionId: string, text: string, originWorkspaceId?: string) => void;

  // Performance diagnostics (Electron-only; the remote transport does not
  // advertise these, so the Performance panel is hidden on remote clients).
  /** Point-in-time snapshot of Electron process CPU/memory metrics. */
  getPerformanceSnapshot: () => Promise<PerformanceSnapshot>;
  /** Capture a renderer CPU profile (same mechanism as Ctrl+Shift+F12). */
  captureRendererCpuProfile: () => Promise<CpuProfileCaptureResult>;
  /** Reveal a captured .cpuprofile in the OS file manager (Explorer/Finder/Files). */
  revealCpuProfile: (filePath: string) => Promise<RevealResult>;

  // Docker
  refreshDocker: () => Promise<unknown>;
  dockerAction: (payload: DockerAction) => Promise<unknown>;
  openDockerSession: (payload: DockerSession) => Promise<unknown>;
  openLazydockerSession: (payload: DockerSession) => Promise<unknown>;
  dockerLogsOpen: (payload: {
    sessionId: string;
    containerId: string;
    backendId: string;
    contextName: string;
    timestamps?: boolean;
    tail?: number | "all";
  }) => Promise<unknown>;
  dockerLogsUpdate: (payload: {
    sessionId: string;
    timestamps?: boolean;
    tail?: number | "all";
  }) => Promise<{ ok: boolean }>;
  dockerLogsClose: (payload: { sessionId: string }) => Promise<unknown>;
  dockerComposeAction: (payload: {
    action: string;
    backendId: string;
    contextName: string;
    projectName: string;
  }) => Promise<unknown>;
  dockerInspect: (payload: { containerId: string; backendId: string; contextName: string }) => Promise<string>;
  dockerTop: (payload: { containerId: string; backendId: string; contextName: string }) => Promise<string>;
  dockerStats: (payload: { containerId: string; backendId: string; contextName: string }) => Promise<{
    cpuPerc: string;
    memUsage: string;
    memPerc: string;
    netIO: string;
    blockIO: string;
    pids: string;
  } | null>;
  dockerShellOpen: (payload: {
    sessionId: string;
    containerId: string;
    backendId: string;
    contextName: string;
    cols?: number;
    rows?: number;
  }) => Promise<unknown>;
  dockerShellWrite: (payload: { sessionId: string; data: string }) => Promise<unknown>;
  dockerShellResize: (payload: { sessionId: string; cols: number; rows: number }) => Promise<unknown>;
  dockerShellClose: (payload: { sessionId: string }) => Promise<unknown>;
  dockerImageInspect: (payload: { resource: string; backendId: string; contextName: string }) => Promise<string>;
  dockerVolumeInspect: (payload: { resource: string; backendId: string; contextName: string }) => Promise<string>;
  dockerNetworkInspect: (payload: { resource: string; backendId: string; contextName: string }) => Promise<string>;
  dockerImageRemove: (payload: {
    resource: string;
    backendId: string;
    contextName: string;
    force?: boolean;
  }) => Promise<unknown>;
  dockerVolumeRemove: (payload: {
    resource: string;
    backendId: string;
    contextName: string;
    force?: boolean;
  }) => Promise<unknown>;
  dockerNetworkRemove: (payload: { resource: string; backendId: string; contextName: string }) => Promise<unknown>;
  dockerImagePull: (payload: { resource: string; backendId: string; contextName: string }) => Promise<unknown>;
  dockerImagePrune: (payload: { backendId: string; contextName: string; all?: boolean }) => Promise<unknown>;
  dockerVolumePrune: (payload: { backendId: string; contextName: string }) => Promise<unknown>;
  dockerNetworkPrune: (payload: { backendId: string; contextName: string }) => Promise<unknown>;
  dockerBuilderPrune: (payload: { backendId: string; contextName: string; all?: boolean }) => Promise<unknown>;
  dockerSystemDf: (payload: { backendId?: string; contextName?: string }) => Promise<string>;
  dockerVolumeList: (payload: {
    volumeName: string;
    backendId: string;
    contextName: string;
    subPath: string;
  }) => Promise<string>;
  dockerVolumeRead: (payload: {
    volumeName: string;
    backendId: string;
    contextName: string;
    subPath: string;
  }) => Promise<string>;
  // `data` is Buffer over Electron IPC but a utf8 string over the remote
  // WebSocket transport — the renderer's writeData() accepts both shapes.
  onDockerLogsWrite: (handler: (payload: { sessionId: string; data: Buffer | string }) => void) => void;
  onDockerLogsClose: (handler: (payload: { sessionId: string; code: number | null }) => void) => void;
  onDockerShellData: (handler: (payload: { sessionId: string; data: string }) => void) => void;
  onDockerShellClose: (handler: (payload: { sessionId: string; code: number | null }) => void) => void;

  // Git
  refreshGit: (projectId?: string, options?: { force?: boolean; rootPath?: string }) => Promise<unknown>;
  gitInterest: (payload: {
    viewId: string;
    workspaceId: string;
    rootPath?: string;
    scope?: "summary" | "detail";
    active: boolean;
    generation: number;
  }) => Promise<unknown>;
  gitFetch: (payload: GitPayload) => Promise<unknown>;
  gitPull: (payload: GitPayload) => Promise<unknown>;
  gitPush: (payload: GitPayload) => Promise<unknown>;
  gitCheckoutBranch: (payload: GitPayload) => Promise<unknown>;
  gitCreateBranch: (payload: GitPayload) => Promise<unknown>;
  gitMergeIntoCurrent: (payload: GitPayload) => Promise<unknown>;
  gitRebaseOnto: (payload: GitPayload) => Promise<unknown>;
  gitCherryPick: (payload: GitCherryPick) => Promise<unknown>;
  gitSquashCommits: (payload: GitSquash) => Promise<unknown>;
  gitContinueOperation: (payload: GitPayload) => Promise<unknown>;
  gitAbortOperation: (payload: GitPayload) => Promise<unknown>;
  gitDiffPreview: (payload: GitDiffPreview) => Promise<unknown>;
  gitCompareBranch: (payload: GitPayload) => Promise<unknown>;
  gitMergeCurrentIntoBase: (payload: GitPayload) => Promise<unknown>;
  gitRemoveWorktree: (payload: RemoveWorktree) => Promise<unknown>;
  gitCommitAll: (payload: GitCommit) => Promise<unknown>;
  gitStageFile: (payload: { workspaceId: string; rootPath?: string; path: string }) => Promise<unknown>;
  gitStageHunk: (payload: {
    workspaceId: string;
    rootPath?: string;
    path: string;
    action: "stage" | "unstage";
    scope: "staged" | "unstaged";
    diffToken: string;
    hunk: string;
  }) => Promise<unknown>;
  gitUnstageFile: (payload: { workspaceId: string; rootPath?: string; path: string }) => Promise<unknown>;
  gitCommitStaged: (payload: { workspaceId: string; rootPath?: string; message: string }) => Promise<unknown>;
  gitStash: (payload: GitPayload) => Promise<unknown>;
  gitStashPop: (payload: GitPayload & { ref?: string }) => Promise<unknown>;
  gitListStashes: (payload: GitStashList) => Promise<unknown>;
  gitStashFiles: (payload: GitStashRef) => Promise<unknown>;
  gitStashFileDiff: (payload: GitStashFileDiff) => Promise<unknown>;
  gitStashApply: (payload: GitStashRef) => Promise<unknown>;
  gitStashDrop: (payload: GitStashRef) => Promise<unknown>;
  gitStashBranch: (payload: GitStashBranch) => Promise<unknown>;
  gitStashExport: (payload: GitStashRef) => Promise<unknown>;
  gitStashImport: (payload: GitStashImport) => Promise<unknown>;
  gitCommitDiff: (payload: GitPayload) => Promise<unknown>;
  gitCommitInfo: (payload: GitPayload) => Promise<unknown>;
  gitLogPage: (payload: GitPayload & { skip?: number; limit?: number }) => Promise<unknown>;
  gitListTags: (payload: GitPayload) => Promise<unknown>;
  gitCreateTag: (payload: GitTag) => Promise<unknown>;
  gitDeleteTag: (payload: GitTag) => Promise<unknown>;
  gitPushTag: (payload: GitTag) => Promise<unknown>;
  gitPushAllTags: (payload: GitPayload) => Promise<unknown>;
  gitDeleteRemoteTag: (payload: GitTag) => Promise<unknown>;
  gitForcePushWithLease: (payload: GitPayload) => Promise<unknown>;
  gitListBranches: (payload: GitPayload) => Promise<unknown>;
  gitDeleteBranch: (payload: GitPayload & { branch: string; force?: boolean }) => Promise<unknown>;
  gitDeleteRemoteBranch: (payload: GitPayload & { branch: string; remote?: string }) => Promise<unknown>;
  gitRenameBranch: (payload: GitPayload & { branch?: string; newName: string }) => Promise<unknown>;
  gitCheckoutRemoteBranch: (
    payload: GitPayload & { remoteBranch: string; localBranch?: string; reset?: boolean },
  ) => Promise<unknown>;
  gitLogGraph: (
    payload: GitPayload & {
      limit?: number;
      skip?: number;
      includeRemotes?: boolean;
      branch?: string;
      sinceDate?: string;
      untilDate?: string;
      paths?: string[];
      topoOrder?: boolean;
      author?: string;
    },
  ) => Promise<unknown>;
  gitSkipCommit: (payload: GitPayload) => Promise<unknown>;
  gitListConflicts: (payload: GitPayload) => Promise<unknown>;
  gitConflictDetail: (payload: GitPayload & { filePath: string }) => Promise<unknown>;
  gitResolveConflict: (payload: GitPayload & { filePath: string; mode: string; content?: string }) => Promise<unknown>;
  gitUnresolveConflict: (payload: GitPayload & { filePath: string }) => Promise<unknown>;
  openLazygitSession: (payload: GitPayload) => Promise<unknown>;
  createWorktree: (payload: WorktreePayload) => Promise<unknown>;
  previewWorktreePath: (payload: WorktreePathPreviewPayload) => Promise<string>;

  // Plugins & profiles
  listPlugins: () => Promise<unknown>;
  getPluginWorkspaceTemplate: (pluginId: string) => Promise<unknown>;
  saveProfile: (profile: ProfilePayload) => Promise<unknown>;
  /** options.taskAction confirms what happens to running task agents in the profile. */
  deleteProfile: (profileId: string, options?: { taskAction?: "pause" | "stop" }) => Promise<unknown>;
  activateProfile: (profileId: string) => Promise<unknown>;
  getWindowId: () => string | Promise<string>;
  focusWindow: () => Promise<boolean>;
  createWindow: (
    profileId: string,
    options?: { cloneFromWindowId?: string },
  ) => Promise<{ windowId?: string; error?: string }>;
  closeWindow: () => Promise<void>;
  /** Renderer's reply to a `window:confirm-close-request` from main. */
  respondConfirmClose: (confirmed: boolean) => Promise<void>;
  onNewWindowShortcut: (handler: () => void) => void;
  /**
   * Main reports that the window was minimized/hidden or came back. Stands in
   * for the Page Visibility API, which Electron pins to "visible" while
   * `backgroundThrottling` is disabled. Occlusion is not reported — Electron
   * exposes no API for it.
   */
  onWindowVisibility: (handler: (payload: { hidden: boolean }) => void) => void;
  /**
   * Main asks the renderer to confirm closing the last main window because
   * workspaces / running task agents would be lost. The renderer must reply
   * via {@link respondConfirmClose}; until it does, the window stays open.
   */
  onConfirmCloseRequest: (
    handler: (payload: {
      workspaceCount: number;
      runningTaskCount: number;
      runningTaskWorkspaceNames: string[];
    }) => void,
  ) => void;

  // Diff popout — open the current MonacoDiffPanel payload in its own Electron
  // window so it can live on a second monitor independent of the host view.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  openDiffPopout: (payload: Record<string, any>) => Promise<{ ok?: boolean; webContentsId?: number; error?: string }>;
  // Called from the popout window itself to fetch its initial payload.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getDiffPopoutInit: () => Promise<Record<string, any> | null>;

  // Editable file popout — one file in its own Monaco window (desktop only).
  openFilePopout: (payload: FilePopoutPayload) => Promise<{ ok?: boolean; error?: string }>;
  getFilePopoutInit: () => Promise<FilePopoutPayload | null>;

  // Absolute path of a file dropped from the OS file manager ("" when the File has none). Desktop only.
  getPathForDroppedFile: (file: File) => string;

  // Jira issue popout — show one issue in its own window. Desktop-only: the remote transport has neither method.
  openJiraIssuePopout: (payload: {
    workspaceId: string;
    ref: { connectionId: string; issueId: string; issueKey: string };
    summary?: string;
  }) => Promise<{ focused: boolean }>;
  // Called from the popout window itself: which issue, workspace and profile it was opened for.
  getJiraIssuePopoutInit: () => Promise<{
    openerWindowId: string;
    profileId: string;
    workspaceId: string;
    ref: { connectionId: string; issueId: string; issueKey: string };
    summary?: string;
  } | null>;

  // File manager
  fileList: (p: FileList) => Promise<unknown>;
  fileTree: (p: FileList) => Promise<unknown>;
  filePreview: (p: FileRead) => Promise<unknown>;
  fileRead: (p: FileRead) => Promise<unknown>;
  fileWrite: (p: FileWrite) => Promise<unknown>;
  attachmentList: (p: { workspaceId: string }) => Promise<unknown>;
  attachmentDelete: (p: { workspaceId: string; transferId: string; name: string }) => Promise<unknown>;
  fileCreateFile: (p: FileCreate) => Promise<unknown>;
  fileCreateDir: (p: FileCreate) => Promise<unknown>;
  fileRename: (p: FileRename) => Promise<unknown>;
  fileDelete: (p: FileDelete) => Promise<unknown>;
  fileGitIgnore: (p: FileGitIgnore) => Promise<unknown>;
  fileMove: (p: FileMove) => Promise<unknown>;
  fileCopy: (p: FileMove) => Promise<unknown>;
  fileOpenInExplorer: (p: FileRead) => Promise<unknown>;
  fileClipboardCopy: (p: FileRead) => Promise<unknown>;
  fileOpenInEditor: (p: FileRead) => Promise<unknown>;
  fileInfo: (p: FileRead) => Promise<unknown>;
  fileGitStatus: (p: FileGitStatus) => Promise<unknown>;
  fileGitRefs: (p: FileGitRefs) => Promise<unknown>;
  fileGitDiff: (p: FileGitDiff) => Promise<unknown>;
  fileCommitFiles: (p: FileCommitFiles) => Promise<unknown>;
  fileCommitDiff: (p: FileCommitDiff) => Promise<unknown>;
  browseDirectory: (defaultPath?: string) => Promise<unknown>;
  /** Desktop only: native picker for upload sources; resolves with the chosen absolute paths ([] when cancelled). */
  browsePaths: (options?: BrowsePaths) => Promise<string[]>;
  // SSH file browser and transfers. A failure rejects with an Error carrying `code` (and `conflicts`).
  sshFileRealpath: (payload: SshFileRealpath) => Promise<{ path: string }>;
  sshFileList: (payload: SshFileList) => Promise<SshFileListing>;
  sshFileMkdir: (payload: SshFileMkdir) => Promise<{ ok: true }>;
  sshFileRename: (payload: SshFileRename) => Promise<{ ok: true }>;
  sshFileDelete: (payload: SshFileDelete) => Promise<{ deleted: number }>;
  /** Starts an upload and resolves at once; the outcome arrives via `onSshFileTransferFinished`. */
  sshFileUpload: (payload: SshFileUpload) => Promise<SshFileTransferStarted>;
  /** Starts a download to the desktop's disk (never available to a mobile session). */
  sshFileDownload: (payload: SshFileDownload) => Promise<SshFileTransferStarted>;
  sshFileTransferCancel: (payload: SshFileTransferCancel) => Promise<{ ok: true }>;
  onSshFileTransferProgress: (handler: (payload: unknown) => void) => void;
  onSshFileTransferFinished: (handler: (payload: unknown) => void) => void;
  browseFile: (options?: Record<string, unknown>) => Promise<unknown>;
  saveFile: (options?: Record<string, unknown>) => Promise<unknown>;

  // SSH
  /** `refresh`: the user asked — skip the runtime's cached preflight (a running probe is still shared). */
  sshCapabilitiesGet: (payload?: { refresh?: boolean }) => Promise<SshRuntimeCapabilities>;
  sshHostsList: () => Promise<unknown>;
  sshHostsCreate: (payload: SshHostCreate) => Promise<unknown>;
  sshHostsUpdate: (payload: SshHostUpdate) => Promise<unknown>;
  sshHostsDelete: (payload: SshHostDelete) => Promise<unknown>;
  sshHostsDuplicate: (payload: SshHostDelete) => Promise<unknown>;
  sshHostsTest: (payload: SshHostDelete) => Promise<unknown>;
  sshTestStart: (payload: { profileId: string; draft: Record<string, unknown> }) => Promise<{
    sessionId: string;
    mode: "ssh2" | "system-ssh" | "wsl";
    status: SshConnectionTestState["status"];
  }>;
  sshTestStop: (payload: { sessionId: string }) => Promise<{ ok: boolean }>;
  onSshTestState: (handler: (payload: SshConnectionTestState) => void) => void;
  sshKeysRename: (payload: SshKeyRename) => Promise<SshKey | null>;
  sshKeysTransferStart: (payload: SshKeyTransferStart) => Promise<{ operationId: string; status: "connecting" }>;
  sshKeysTransferStop: (payload: SshKeyTransferStop) => Promise<{ ok: boolean }>;
  onSshKeyTransferState: (handler: (payload: SshKeyTransferState) => void) => void;
  sshKeysList: () => Promise<unknown>;
  sshKeysImport: (payload: SshKeyImport) => Promise<unknown>;
  sshKeysGenerate: (payload: SshKeyGenerate) => Promise<unknown>;
  sshKeysDelete: (payload: SshHostDelete) => Promise<unknown>;
  sshCertsList: () => Promise<unknown>;
  sshCertsImport: (payload: SshCertImport) => Promise<unknown>;
  sshCertsDelete: (payload: SshHostDelete) => Promise<unknown>;
  sshAuthAnswer: (payload: SshAuthAnswer) => Promise<unknown>;
  sshAuthCancel: (payload: SshAuthCancel) => Promise<unknown>;
  sshHostKeyAccept: (payload: SshAcceptHostKey) => Promise<unknown>;
  sshHostKeyReject: (payload: SshRejectHostKey) => Promise<unknown>;
  sshConfigPreview: (payload: SshConfigImport) => Promise<unknown>;
  sshConfigImport: (payload: SshConfigImport) => Promise<unknown>;
  sshKnownHostsImport: (payload: SshKnownHostsImport) => Promise<unknown>;

  // Startup flags resolved by main (CLI args + env vars). Read once at
  // preload time so the renderer can branch synchronously without an IPC
  // round-trip on hot paths (e.g. terminal mount).
  startupFlags: {
    disableWebgl: boolean;
    windowId: string;
  };

  // Fire-and-forget log shipping: the renderer routes diagnostic output
  // (e.g. WebGL pre-flight result) into the main-process winston logger
  // so it lands in ~/.strideterm/logs/strideterm.log alongside backend
  // events. Never throws.
  logRenderer: (level: "info" | "warn" | "error" | "debug", message: string, meta?: Record<string, unknown>) => void;

  // Event listeners
  onStateUpdated: (handler: (payload: StatePayload) => void) => void;
  onTerminalData: (handler: (payload: TerminalDataPayload) => void) => void;
  onTerminalExit: (handler: (payload: TerminalExitPayload) => void) => void;
  onGitPushProgress: (handler: (payload: GitPushProgressPayload) => void) => void;
  onSshAuthPrompt: (handler: (payload: SshAuthRequest) => void) => void;
  onSshAuthPromptCancel: (handler: (payload: SshAuthPromptCancel) => void) => void;
  onSshHostKeyChange: (handler: (payload: Record<string, unknown>) => void) => void;
  onSshState: (handler: (payload: Record<string, unknown>) => void) => void;
  onSshConnectionState: (handler: (payload: SshConnectionState) => void) => void;
  /**
   * Authoritative "a notification target disappeared" lifecycle event. The
   * payload is UNVALIDATED here; consumers parse it at the transport boundary.
   */
  onNotificationTargetRemoved: (handler: (payload: unknown) => void) => void;
  onApprovalRecorded: (handler: (payload: unknown) => void) => void;
  /** A background closed-PR cleanup finished. UNVALIDATED here; parsed at the transport boundary. */
  onAzureClosedPrCleanupFinished: (handler: (payload: unknown) => void) => void;
  /** A long-running runtime operation finished. UNVALIDATED here; parsed at the transport boundary. */
  onOperationFinished: (handler: (payload: unknown) => void) => () => void;
  onReviewGitOperation: (handler: (payload: unknown) => void) => void;
  onMobileStatus: (
    handler: (
      payload:
        | { running: boolean }
        | { pushLimitReached: true; suppressedCount: number; resetAt: number }
        | { connectedDevices: MobileConnectedDevice[] },
    ) => void,
  ) => void;
  /** A paired phone opened a session. The payload is UNVALIDATED here; consumers parse it at the transport boundary. */
  onMobileSessionStarted: (handler: (payload: unknown) => void) => void;
  onRemoteAuthFailures: (handler: (payload: unknown) => void) => void;
  onMobilePairingProgress: (handler: (payload: Record<string, unknown>) => void) => void;
  onMobileDeviceRevoked: (handler: (payload: { deviceId: string }) => void) => void;
}

// Re-export payload types needed by AttentionSync consumers
export type { AttentionSync as AttentionSyncPayload };
