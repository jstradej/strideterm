import type { TaskState } from "./task.js";
import type { SshHost, SshKey, SshCert } from "./ssh.js";
import type { Alert } from "./notifications.js";

// Re-export for convenience
export type { Alert };

// ------- Settings -------

export interface NotificationSettings {
  promptQuietMs: number;
  agentQuietMs: number;
  agentQuietFastMs: number;
  alertCooldownMs: number;
  userInteractionGraceMs: number;
  shellIntegration: boolean;
  agentHook: boolean;
  debug: boolean;
  /**
   * When true (default), shell-completion alerts (OSC 133;D, prompt-pattern,
   * shell exit) are suppressed — only AI agent sessions raise alerts. Users
   * can opt back in on a specific panel via PanelState.alertsForceOn.
   */
  agentsOnly: boolean;
}

export interface RemoteAccessSettings {
  enabled: boolean;
  host: string;
  port: number;
  token: string;
  customPublicUrl: string;
  cloudflaredPath: string;
}

export interface ProviderDefaultConfig {
  providerId: string;
  model: string;
}

export interface TaskDefaults {
  workerProvider: ProviderDefaultConfig;
  judgeProvider: ProviderDefaultConfig;
}

export interface AzureIntegrationSettings {
  enabled: boolean;
  reviewRoot: string;
  defaultPollSeconds: number;
  connections: AzureConnection[];
}

export interface GitHubIntegrationSettings {
  enabled: boolean;
  reviewRoot: string;
  defaultPollSeconds: number;
  connections: GitHubConnection[];
}

export interface TelegramConnection {
  id: string;
  label: string;
  botTokenRef: string;
  chatId: string;
  enabled: boolean;
  pollSeconds: number;
  /** Which notification kinds to forward (empty = all) */
  forwardKinds: string[];
}

export interface TelegramIntegrationSettings {
  enabled: boolean;
  defaultPollSeconds: number;
  connections: TelegramConnection[];
}

export interface IntegrationSettings {
  azureDevops: AzureIntegrationSettings;
  github: GitHubIntegrationSettings;
  telegram: TelegramIntegrationSettings;
}

export interface GitUiSettings {
  showAllActions: boolean;
}

export interface GitSettings {
  ui: GitUiSettings;
}

export interface Settings {
  theme: string;
  sidebarWidth: number;
  sidebarCollapsed: boolean;
  logLevel: "error" | "warn" | "info" | "debug" | "trace";
  notifications: NotificationSettings;
  remoteAccess: RemoteAccessSettings;
  taskDefaults: TaskDefaults;
  integrations: IntegrationSettings;
  git: GitSettings;
}

// ------- Tab templates -------

export interface TabTemplate {
  id: string;
  title: string;
  command: string;
  icon: string;
  platforms?: string[];
}

// ------- Profile -------

export interface Profile {
  id: string;
  name: string;
  color: string;
  workspaceIds: string[];
  projectIds?: string[];
}

// ------- Workspace / Panel -------

export interface PanelLaunch {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  /** Shell / binary override — when set the panel launches this file instead of the default shell */
  file?: string;
  /** SSH launch kind marker */
  kind?: string;
  /** Reference to a saved SSH host in the host book */
  sshHostId?: string;
  /** Inline ad-hoc SSH host config (quick-connect) */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sshInline?: Record<string, any>;
  skipCommandInjection?: boolean;
}

export interface PanelState {
  id: string;
  title: string;
  command: string;
  launch?: PanelLaunch | null;
  shell?: string;
  startup?: string;
  cwd?: string;
  /**
   * Per-panel override that re-enables alerts when the global
   * `notifications.agentsOnly` is on. Useful for shell tabs where the user
   * does want the "command finished" ping (e.g. a long build script).
   * Default false → panel inherits the global setting.
   */
  alertsForceOn?: boolean;
}

export interface ReviewPrInfo {
  id: number;
  number: number;
  title: string;
  status: string;
  mergeStatus: string;
  url: string;
  webUrl: string;
  sourceRefName: string;
  targetRefName: string;
}

export interface ReviewCheckout {
  mode: string;
  rootPath: string;
  cacheRepoPath: string;
}

export interface ReviewProject {
  id: string;
  name: string;
}

export interface ReviewRepository {
  id: string;
  name: string;
  remoteUrl: string;
}

export interface ReviewInfo {
  provider: string;
  prKey: string;
  connectionId: string;
  orgUrl: string;
  parentWorkspaceId: string;
  project: ReviewProject | null;
  repository: ReviewRepository | null;
  pullRequest: ReviewPrInfo | null;
  role: string;
  checkout: ReviewCheckout | null;
}

export interface QuickfixInfo {
  connectionId: string;
  projectName: string;
  repositoryId: string;
  repositoryName: string;
  remoteUrl: string;
  baseBranch: string;
  parentWorkspaceId: string;
}

export type WorkspaceKind = "docker" | "azure" | "github" | "task" | "manual" | string;
export type WorkspaceSource = "plugin" | "manual";

export interface WorkspaceState {
  id: string;
  name: string;
  icon: string;
  color: string;
  kind: WorkspaceKind;
  source: WorkspaceSource;
  pluginId: string;
  cwd: string;
  gitRoots: string[];
  activeRootPath: string;
  notes: string;
  profileId: string;
  connectionId: string;
  activePanelId: string | null;
  activeViewId: string | null;
  splitLayout: string | null;
  splitViewIds: string[];
  panels: PanelState[];
  review: ReviewInfo | null;
  quickfix: QuickfixInfo | null;
  starred: boolean;
  task: TaskState | null;
}

// ------- SSH app state -------

export interface SshSettings {
  defaultAgentMode: string;
  importedSshConfig: boolean;
}

export interface SshAppState {
  hosts: SshHost[];
  keys: SshKey[];
  certificates: SshCert[];
  knownHosts: Record<string, unknown>;
  settings: SshSettings;
}

// ------- Azure / GitHub connections -------

export interface AzureConnection {
  id: string;
  label: string;
  orgUrl: string;
  pat?: string;
  enabled: boolean;
}

export interface GitHubConnection {
  id: string;
  label: string;
  token?: string;
  enabled: boolean;
}

// ------- AppState (persisted) -------

export interface AppState {
  activeWorkspaceId: string;
  activeProfileId: string;
  settings: Settings;
  tabTemplates: TabTemplate[];
  profiles: Profile[];
  workspaces: WorkspaceState[];
  ssh: SshAppState;
  // Legacy aliases
  activeProjectId?: string;
  projects?: WorkspaceState[];
}

// ------- Runtime-only state pieces broadcast to frontend -------

export interface AttentionState {
  sessions: Record<
    string,
    {
      sessionId: string;
      workspaceId: string;
      panelId: string;
      lastActivity: string;
      alertKind: string | null;
      alertedAt: string | null;
    }
  >;
  alerts: Alert[];
}

export interface DockerContainer {
  ID: string;
  Names: string;
  Image: string;
  ImageID: string;
  Command: string;
  Created: number;
  RunningFor: string;
  Ports: string;
  Status: string;
  State: string;
  Size: string;
  [key: string]: unknown;
}

export interface DockerLazydockerState {
  available: boolean;
  backend: "host" | "wsl" | null;
  error: string;
}

export interface DockerState {
  available: boolean;
  backend: "host" | "wsl" | null;
  contexts: unknown[];
  containers: DockerContainer[];
  lazydocker: DockerLazydockerState;
  error: string;
  lastUpdatedAt: string | null;
}

export interface GitFileEntry {
  path: string;
  code: string;
  [key: string]: unknown;
}

export interface GitDiffStat {
  files: number;
  insertions: number;
  deletions: number;
  renames: number;
  deletes: number;
}

export interface GitChangeGroup {
  name: string;
  files: GitFileEntry[];
  diffStat: GitDiffStat;
}

export interface GitLogEntry {
  hash: string;
  date: string;
  author: string;
  refs: string;
  subject: string;
}

export interface GitOperationState {
  kind: "idle" | "rebase" | "merge" | "cherry-pick" | "revert";
  inProgress: boolean;
  label: string;
  details: string;
  conflicts: Array<{ path: string; ours: string; theirs: string }>;
  canContinue: boolean;
  canAbort: boolean;
}

export interface GitLazygitState {
  available: boolean;
  backend: "host" | "wsl" | null;
  error: string;
  launch?: string;
}

export interface GitWorktreeEntry {
  path: string;
  branch: string;
  head: string;
  isCurrent: boolean;
  isMainWorktree: boolean;
  dirty: boolean;
  dirtyCount: number;
  detached: boolean;
  bare: boolean;
  locked: boolean;
  prunable: boolean;
  branchMerged?: boolean;
}

export interface GitCompareWithBase {
  baseBranch: string;
  aheadCount: number;
  behindCount: number;
  commits: GitLogEntry[];
  files: GitFileEntry[];
  diffStat: GitDiffStat;
  potentialConflicts: string[];
  baseChangedFiles: string[];
}

export interface GitSnapshot {
  workspaceId: string;
  projectId?: string;
  cwd: string;
  rootPath?: string;
  available: boolean;
  root: string;
  repository: string;
  branch: string;
  remotes: Record<string, string[]>;
  commitCount: number;
  dirty: boolean;
  dirtyCount: number;
  status: GitFileEntry[];
  staged: GitFileEntry[];
  unstaged: GitFileEntry[];
  untracked: GitFileEntry[];
  changes: {
    staged: GitChangeGroup;
    unstaged: GitChangeGroup;
    untracked: GitChangeGroup;
  };
  diffStat: GitDiffStat;
  log: GitLogEntry[];
  lazygit: GitLazygitState;
  gitDir: string;
  gitCommonDir: string;
  isWorktree: boolean;
  isMainWorktree: boolean;
  branchMerged?: boolean;
  worktreePath: string;
  mainWorktreePath: string;
  siblingWorktrees: GitWorktreeEntry[];
  upstream: string;
  baseBranch: string;
  branchNames: string[];
  stashCount: number;
  aheadCount: number;
  behindCount: number;
  compareWithBase: GitCompareWithBase;
  lastFetchAt: string | null;
  operationState: GitOperationState;
  error: string;
  lastUpdatedAt: string;
}

export interface GitConnectionInfo {
  id: string;
  label: string;
  provider: string;
  enabled: boolean;
}

export interface GitState {
  workspaces: Record<string, GitSnapshot>;
  projects?: Record<string, GitSnapshot>;
  activeWorkspace: GitSnapshot | null;
  activeProject?: GitSnapshot | null;
  connections: GitConnectionInfo[];
}

export interface AzureDevopsState {
  inboxItems: unknown[];
  connections: AzureConnection[];
  lastUpdatedAt: string | null;
  error: string;
}

export interface ReviewBridgeState {
  sessions: Record<string, unknown>;
  enabled: boolean;
}

export interface RemoteAccessState {
  enabled: boolean;
  host: string;
  port: number;
  tunnel: {
    active: boolean;
    url: string | null;
    error: string | null;
  };
}

export interface VersionCheckState {
  latestVersion: string | null;
  latestUrl?: string;
  currentVersion: string;
  updateAvailable: boolean;
  versionsBehind?: number;
  lastCheckedAt: string | null;
  error: string | null;
}

export interface MetaState {
  appVersion: string;
  repositoryUrl: string;
  versionCheck: VersionCheckState;
  platform: string;
}

// ------- Full payload broadcast to frontend -------

export interface StatePayload {
  meta: MetaState;
  appState: AppState;
  workspace: WorkspaceState | null;
  attention: AttentionState;
  docker: DockerState;
  git: GitState;
  azureDevops: AzureDevopsState;
  github: AzureDevopsState;
  reviewBridge: ReviewBridgeState;
  plugins: unknown[];
  environment: Record<string, unknown>;
  themeSource: string;
  remoteAccess: RemoteAccessState;
  agentNotifyHook: { enabled: boolean; port: number };
  taskRunner: Record<string, unknown>;
}
