import type { StatePayload, Settings } from "./types/state.js";
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
  ReviewBridgePushAndPublish,
  AgentPromptSave,
  AgentPromptDelete,
  GitPayload,
  GitDiffPreview,
  GitCommit,
  GitTag,
  GitStashList,
  GitStashRef,
  GitStashFileDiff,
  GitStashBranch,
  GitStashImport,
  DockerAction,
  DockerSession,
  WorktreePayload,
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
  TaskUpdateDescription,
  TaskRecoveryResolve,
  ProfilePayload,
  NotificationShow,
  TelegramConnectionPayload,
  RerunCheck,
  SshHostCreate,
  SshHostUpdate,
  SshHostDelete,
  SshKeyImport,
  SshKeyGenerate,
  SshCertImport,
  SshAuthAnswer,
  SshAcceptHostKey,
  SshConfigImport,
  SshKnownHostsImport,
  FileList,
  FileRead,
  FileWrite,
  FileCreate,
  FileRename,
  FileDelete,
  FileMove,
  FileGitStatus,
  FileGitRefs,
  FileGitDiff,
  FileCommitFiles,
  FileCommitDiff,
  AzureAuditLogQuery,
  AzureAuditLogStats,
  WorkspacePushOptions,
} from "../backend/ipc-schemas.js";
import type { SshAuthRequest, SshConnectionState } from "./types/ssh.js";

export type { StatePayload };

export interface TerminalSize {
  cols: number;
  rows: number;
}

export interface TerminalDataPayload {
  sessionId: string;
  data: string;
}

export interface TerminalReplayPayload {
  data: string;
}

export interface TerminalExitPayload {
  sessionId: string;
  exitCode: number;
}

export interface StridetermAPI {
  // Core app
  openExternal: (url: string) => Promise<unknown>;
  openTerminalPath: (request: { path: string; workspaceCwd?: string; line?: number; column?: number }) => Promise<{
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
  updateSettings: (settings: Partial<Settings>) => Promise<unknown>;

  // Azure integration
  verifyAzureConnection: (connection: AzureConnectionPayload) => Promise<unknown>;
  saveAzureConnection: (connection: AzureConnectionPayload) => Promise<unknown>;
  deleteAzureConnection: (connectionId: string) => Promise<unknown>;
  refreshAzure: () => Promise<unknown>;
  queryAzureAuditLog: (filters: AzureAuditLogQuery) => Promise<unknown>;
  getAzureAuditStats: (filters: AzureAuditLogStats) => Promise<unknown>;
  markAzurePullRequestSeen: (prKey: string) => Promise<unknown>;
  openAzurePullRequest: (payload: OpenPr) => Promise<unknown>;
  commentAzurePullRequest: (payload: AzureComment) => Promise<unknown>;
  updateAzureThreadStatus: (payload: AzureThreadStatus) => Promise<unknown>;
  voteAzurePullRequest: (payload: AzureVote) => Promise<unknown>;
  fetchAzureReviewWorkspace: (workspaceId: string) => Promise<unknown>;
  rebaseAzureReviewWorkspace: (workspaceId: string) => Promise<unknown>;
  pushAzureReviewWorkspace: (workspaceId: string, options?: WorkspacePushOptions) => Promise<unknown>;
  azureCreatePullRequest: (payload: Record<string, unknown>) => Promise<unknown>;
  azureListRemoteBranches: (payload: Record<string, unknown>) => Promise<unknown>;
  azureQuickFixListProjects: (payload: QuickFixListProjects) => Promise<unknown>;
  azureQuickFixListRepositories: (payload: QuickFixListRepositories) => Promise<unknown>;
  azureQuickFixListBranches: (payload: QuickFixListBranches) => Promise<unknown>;
  azureQuickFixCreate: (payload: QuickFixCreate) => Promise<unknown>;
  rerunAzureCheck: (prKey: string, checkItem: RerunCheck["checkItem"]) => Promise<unknown>;

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
  fetchGitHubReviewWorkspace: (workspaceId: string) => Promise<unknown>;
  rebaseGitHubReviewWorkspace: (workspaceId: string) => Promise<unknown>;
  pushGitHubReviewWorkspace: (workspaceId: string, options?: WorkspacePushOptions) => Promise<unknown>;
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
  pushAndPublishReview: (payload: ReviewBridgePushAndPublish) => Promise<unknown>;

  // Agent hooks
  regenerateRemoteToken: () => Promise<unknown>;
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
  updateTaskDescription: (payload: TaskUpdateDescription) => Promise<unknown>;
  resolveTaskRecovery: (decisions: TaskRecoveryResolve) => Promise<unknown>;
  getTaskStatus: (workspaceId: string) => Promise<unknown>;

  // Tunnel
  refreshTunnel: () => Promise<unknown>;
  createCloudflareTunnel: () => Promise<unknown>;
  stopCloudflareTunnel: () => Promise<unknown>;

  // Terminal
  restartTerminal: (sessionId: string) => Promise<unknown>;
  closeTerminal: (sessionId: string) => Promise<unknown>;
  getTerminalReplay: (sessionId: string) => Promise<TerminalReplayPayload>;
  resizeTerminal: (sessionId: string, size: TerminalSize) => void;
  writeTerminal: (sessionId: string, data: string) => void;

  // Docker
  refreshDocker: () => Promise<unknown>;
  dockerAction: (action: string, containerId: string) => Promise<unknown>;
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
  refreshGit: (projectId?: string) => Promise<unknown>;
  gitFetch: (payload: GitPayload) => Promise<unknown>;
  gitPull: (payload: GitPayload) => Promise<unknown>;
  gitPush: (payload: GitPayload) => Promise<unknown>;
  gitCheckoutBranch: (payload: GitPayload) => Promise<unknown>;
  gitCreateBranch: (payload: GitPayload) => Promise<unknown>;
  gitMergeIntoCurrent: (payload: GitPayload) => Promise<unknown>;
  gitRebaseOnto: (payload: GitPayload) => Promise<unknown>;
  gitContinueOperation: (payload: GitPayload) => Promise<unknown>;
  gitAbortOperation: (payload: GitPayload) => Promise<unknown>;
  gitDiffPreview: (payload: GitDiffPreview) => Promise<unknown>;
  gitCompareBranch: (payload: GitPayload) => Promise<unknown>;
  gitMergeCurrentIntoBase: (payload: GitPayload) => Promise<unknown>;
  gitRemoveWorktree: (payload: RemoveWorktree) => Promise<unknown>;
  gitCommitAll: (payload: GitCommit) => Promise<unknown>;
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
  gitCheckoutRemoteBranch: (payload: GitPayload & { remoteBranch: string; localBranch?: string }) => Promise<unknown>;
  gitLogGraph: (
    payload: GitPayload & {
      limit?: number;
      includeRemotes?: boolean;
      branch?: string;
      sinceDate?: string;
      untilDate?: string;
      paths?: string[];
      topoOrder?: boolean;
      author?: string;
    },
  ) => Promise<unknown>;
  openLazygitSession: (payload: GitPayload) => Promise<unknown>;
  createWorktree: (payload: WorktreePayload) => Promise<unknown>;

  // Plugins & profiles
  listPlugins: () => Promise<unknown>;
  getPluginWorkspaceTemplate: (pluginId: string) => Promise<unknown>;
  saveProfile: (profile: ProfilePayload) => Promise<unknown>;
  deleteProfile: (profileId: string) => Promise<unknown>;
  activateProfile: (profileId: string) => Promise<unknown>;
  getWindowId: () => string | Promise<string>;
  focusWindow: () => Promise<boolean>;
  createWindow: (profileId: string) => Promise<{ windowId?: string; error?: string }>;
  closeWindow: () => Promise<void>;
  /** Renderer's reply to a `window:confirm-close-request` from main. */
  respondConfirmClose: (confirmed: boolean) => Promise<void>;
  onNewWindowShortcut: (handler: () => void) => void;
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

  // File manager
  fileList: (p: FileList) => Promise<unknown>;
  fileTree: (p: FileList) => Promise<unknown>;
  filePreview: (p: FileRead) => Promise<unknown>;
  fileRead: (p: FileRead) => Promise<unknown>;
  fileWrite: (p: FileWrite) => Promise<unknown>;
  fileCreateFile: (p: FileCreate) => Promise<unknown>;
  fileCreateDir: (p: FileCreate) => Promise<unknown>;
  fileRename: (p: FileRename) => Promise<unknown>;
  fileDelete: (p: FileDelete) => Promise<unknown>;
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
  browseFile: (options?: Record<string, unknown>) => Promise<unknown>;
  saveFile: (options?: Record<string, unknown>) => Promise<unknown>;

  // SSH
  sshHostsList: () => Promise<unknown>;
  sshHostsCreate: (payload: SshHostCreate) => Promise<unknown>;
  sshHostsUpdate: (payload: SshHostUpdate) => Promise<unknown>;
  sshHostsDelete: (payload: SshHostDelete) => Promise<unknown>;
  sshHostsDuplicate: (payload: SshHostDelete) => Promise<unknown>;
  sshHostsTest: (payload: SshHostDelete) => Promise<unknown>;
  sshKeysList: () => Promise<unknown>;
  sshKeysImport: (payload: SshKeyImport) => Promise<unknown>;
  sshKeysGenerate: (payload: SshKeyGenerate) => Promise<unknown>;
  sshKeysDelete: (payload: SshHostDelete) => Promise<unknown>;
  sshCertsList: () => Promise<unknown>;
  sshCertsImport: (payload: SshCertImport) => Promise<unknown>;
  sshCertsDelete: (payload: SshHostDelete) => Promise<unknown>;
  sshAuthAnswer: (payload: SshAuthAnswer) => Promise<unknown>;
  sshAuthCancel: (payload: SshAuthAnswer) => Promise<unknown>;
  sshHostKeyAccept: (payload: SshAcceptHostKey) => Promise<unknown>;
  sshHostKeyReject: (payload: SshAcceptHostKey) => Promise<unknown>;
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
  onSwitchWorkspace: (handler: (index: number) => void) => void;
  onSwitchProject: (handler: (index: number) => void) => void;
  onSwitchTab: (handler: (direction: string) => void) => void;
  onSshAuthPrompt: (handler: (payload: SshAuthRequest) => void) => void;
  onSshHostKeyChange: (handler: (payload: Record<string, unknown>) => void) => void;
  onSshState: (handler: (payload: Record<string, unknown>) => void) => void;
  onSshConnectionState: (handler: (payload: SshConnectionState) => void) => void;
}

// Re-export payload types needed by AttentionSync consumers
export type { AttentionSync as AttentionSyncPayload };
