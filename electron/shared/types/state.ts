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
  /**
   * When true, a sub-agent finishing within a turn (Claude Code SubagentStop)
   * raises a user-facing "finished" notification. Off by default — sub-agent
   * completions read as false "done" signals; most users only act on the
   * end-of-turn Stop.
   */
  subagentCompletion: boolean;
  /**
   * When true, strIDEterm answers Claude Code's `PermissionRequest` hook with
   * `allow` — the permission prompt never appears and the agent keeps going.
   * Off by default; it is a deliberate bypass, and every approval it makes is
   * recorded in the approval audit log.
   *
   * Writable from desktop IPC only: `sanitizeSettingsFromRemote()` drops it
   * from `/api/settings/update`, so a remote client (or a leaked token) can
   * never quietly arm what the desktop will then execute unattended.
   */
  autoApprovePermissions: boolean;
}

export interface RemoteAccessSettings {
  enabled: boolean;
  host: string;
  port: number;
  token: string;
  customPublicUrl: string;
  cloudflaredPath: string;
  autoTunnel: boolean;
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
  /** Profile this chat controls. Empty/undefined means ask when multiple profiles exist. */
  profileId?: string;
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

/**
 * How a path-link click in the terminal opens its target.
 *
 * - `system`: hand it to the OS default opener (`shell.openPath` —
 *   Finder/Explorer/xdg-open). Always works, never blocks the user on
 *   editor configuration, which is why it's the default. Executables (see
 *   `executable-paths.ts`) prompt first, because this is the one mode where
 *   the OS runs the target instead of showing it, and terminal output is not
 *   a trusted source of paths.
 * - `command`: run a user-supplied command template, e.g.
 *   `code -g \${path}:\${line}:\${column}` for VS Code or
 *   `nvim +\${line} \${path}` for Neovim. The template is parsed argv-style
 *   (no shell), so nothing gets evaluated by `sh -c`. Substitutable
 *   placeholders are `\${path}`, `\${line}`, `\${column}`. Missing line/
 *   column fall back to empty strings.
 * - `internal`: open inside strIDEterm — switch to the active workspace's
 *   Files tab (creating it if absent) and select the file there.
 */
export interface ExternalPathOpenerSettings {
  mode: "system" | "command" | "internal";
  /** Used only when `mode === "command"`. Empty for the other modes. */
  command: string;
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
  /**
   * Editor invoked when the user clicks on a *file* link in terminal output.
   * Tokenised argv-style (no shell): `code --wait` becomes
   * `spawn("code", ["--wait", <path>])`, with the resolved file path appended
   * as the final argv slot. Quote binaries that contain spaces
   * (`"C:\\Program Files\\App\\app.exe"`). Empty = fall through to
   * `externalPathOpener`. Directory clicks ignore this field.
   */
  externalEditor: string;
  externalPathOpener: ExternalPathOpenerSettings;
  /** Terminal font size for desktop (Electron) windows. Range 8–32, default 13. */
  terminalFontSizeLocal: number;
  /** Terminal font size for remote/mobile web clients. Range 8–32, default 13. */
  terminalFontSizeRemote: number;
  /**
   * Master switch for the image-aware terminal paste. When false, Ctrl+V
   * / Shift+Insert / right-click in a terminal behave like vanilla xterm
   * — bitmaps in the clipboard get silently dropped (xterm's text-only
   * paste) instead of being saved to disk and pathed into the terminal.
   * Default true.
   */
  clipboardImagePasteEnabled: boolean;
  /**
   * Folder where `clipboard:paste-image` saves PNGs when the user pastes
   * a screenshot into a terminal. Supports a leading `~/` for the home
   * directory. Empty string = use OS default (`~/Desktop` on macOS,
   * `~/Pictures/Screenshots` on Windows/Linux). Desktop-only: the
   * remote/HTTP transport blocks writes to this key — without that, a
   * remote attacker could repoint the path to a sensitive location and
   * trigger writes there on the next desktop paste.
   */
  clipboardImagePasteDir: string;
  /**
   * Ids of one-shot state migrations that have already run against this state
   * file (see `STATE_MIGRATIONS` in `default-state.ts`).
   *
   * `normalizeState` runs on load AND after every mutation, so a migration
   * expressed as "add X when Y" is not a migration at all — it is a rule that
   * keeps re-asserting itself, and the user can never undo what it did. A
   * migration that records having run can be undone the moment after it runs,
   * which is what "one-shot" has to mean.
   */
  appliedMigrations: string[];
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
  /**
   * @deprecated Legacy/default grid only. The authoritative grid is viewer-owned
   * (WindowSlot.workspaceGrid / remote client). Kept as the default seed when a
   * viewer opens this profile without its own grid, and for downgrade compat.
   */
  workspaceGrid?: WorkspaceGridState | null;
  /** Last workspace the user was viewing in this profile — restored on profile switch. */
  lastActiveWorkspaceId?: string;
  /** Last session the user was viewing in this profile — restored on profile switch. */
  lastActiveSessionId?: string;
  /**
   * Which sidebar workspace list layout this profile uses: the manually
   * ordered/hierarchical `tree` alone (default), or `recent` — the same tree
   * with a compact "Recently worked · 24h" shortcut list added above it.
   * `recent` is additive: it never hides, reorders or fragments the tree.
   * Purely a per-profile UI preference, not a security boundary; normalized
   * to "tree" when missing/invalid.
   */
  sidebarWorkspaceViewMode?: "tree" | "recent";
}

// ------- Window slot (per BrowserWindow persistent state) -------

export interface WindowSlotBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface WindowSlot {
  /** Stable UUID assigned at window creation; survives app restarts. */
  id: string;
  /** Profile shown in this window. NOT unique — multiple windows may show the same profile. */
  profileId: string;
  /** Workspace currently focused inside this window. */
  activeWorkspaceId: string;
  /** Session currently focused inside this window. */
  activeSessionId: string;
  /** Per-window workspace grid — viewer-owned; two windows of the same profile keep independent grids. */
  workspaceGrid?: WorkspaceGridState | null;
  /** Last persisted window bounds for restore. */
  bounds: WindowSlotBounds;
  /** Display ID for multi-monitor restore. */
  displayId?: number;
  isMaximized?: boolean;
  /** Timestamp (ms since epoch) of last focus event — used to pick primaryWindow. */
  lastFocusedAt?: number;
}

// ------- Remote client session (runtime-only, not persisted) -------

export interface RemoteClientSession {
  /** Cookie session ID — server-only identity; never sent to the browser. */
  id: string;
  profileId: string;
  activeWorkspaceId: string;
  activeSessionId: string;
  connectedAt: number;
  lastSeenAt: number;
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
  /**
   * Free-text scratchpad for this tab. Purely a note to self — nothing reads
   * it but the notes dialog, and an empty string is stored as absent.
   */
  notes?: string;
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
  /** User opted in to git write operations (rebase/merge/push) on a reviewer-role checkout. */
  writable: boolean;
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
  /**
   * ISO timestamp of the last CONFIRMED, workspace-scoped piece of user work
   * — meaningful terminal input that the backend accepted, creating this
   * workspace, a task lifecycle action, or a successful git/review mutation
   * driven from the built-in UI. Stamped only after the action succeeded,
   * never optimistically, and only through `markWorkspaceWorked()`.
   *
   * Explicitly NOT moved by: activating a workspace or session, switching a
   * tab, focusing a grid cell, opening a launch panel, searching, starring,
   * collapsing, reordering, passive terminal focus/mouse sequences, PTY
   * output, agent-internal writes, polling, hooks, running/progress/
   * completion signals, attention alerts, or background refreshes. An agent's
   * ongoing work therefore does not extend it — `RUNNING` already answers
   * "what is working"; this field answers "where did I work".
   *
   * Replaces the old `lastUsedAt`, which conflated navigation with work.
   * Deliberately NOT backfilled from it: the historical values are
   * contaminated by activations and cannot be told apart after the fact, so
   * the recent section starts empty after an upgrade and fills with real work.
   */
  lastWorkedAt?: string;
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
  /**
   * Owning profile. Connections are profile-owned (the provider inbox, PR
   * reviews and quickfix workspaces land in this profile); the credential
   * secret itself stays global per install. Empty/missing = "default".
   */
  profileId?: string;
}

export interface GitHubConnection {
  id: string;
  label: string;
  token?: string;
  enabled: boolean;
  /** Owning profile — see AzureConnection.profileId. */
  profileId?: string;
}

// ------- Workspace grid -------

export type WorkspaceGridLayout = "cols" | "rows" | "top-split" | "left-split" | "grid";

export interface WorkspaceGridState {
  layout: WorkspaceGridLayout;
  /** Length === LAYOUTS[layout].slots; null = empty slot */
  cellWorkspaceIds: (string | null)[];
}

// ------- AppState (persisted) -------

export interface AppState {
  activeWorkspaceId: string;
  settings: Settings;
  tabTemplates: TabTemplate[];
  profiles: Profile[];
  workspaces: WorkspaceState[];
  ssh: SshAppState;
  /** @deprecated Global grid moved to Profile.workspaceGrid; kept for downgrade compat. */
  workspaceGrid?: WorkspaceGridState | null;
  /** Per-window state slots. Replaces the single-window global state. */
  windowSlots: WindowSlot[];
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
      activity?: "idle" | "running" | "done" | string;
      /**
       * Epoch ms when the current "running" stretch began; 0 (or absent) when
       * the session is not running. Runtime-only — like the rest of this
       * snapshot it is never persisted into AppState.
       */
      activityStartedAt?: number;
      agentLike?: boolean;
      hasUserInput?: boolean;
      lastExitCode?: number | null;
      lastCommandFinishedAt?: number;
    }
  >;
  byWorkspace?: Record<string, AttentionBucket>;
  byProject?: Record<string, AttentionBucket>;
  activeWorkspace?: AttentionBucket | null;
  activeProject?: AttentionBucket | null;
  alerts?: Alert[];
}

export interface AttentionBucket {
  count: number;
  latestAt: string | null;
  alerts: AttentionAlert[];
}

export interface AttentionAlert {
  /**
   * Stable identity of ONE backend alert instance, minted once in
   * `addProjectAlert()` and never regenerated. A rebroadcast, a reconnect or a
   * renderer-side cache replay carries the same id, so the notification
   * capture can tell "the same alert again" from "a genuinely new alert for
   * the same panel" — the latter always gets a fresh id. V2 plan, Fáze 2.
   */
  alertId: string;
  projectId: string;
  panelId: string;
  sessionId: string;
  title: string;
  exitCode: number | null;
  kind: string;
  tier: number;
  urgency: string;
  detail: string;
  /**
   * Human-readable context for the alert, when the source provided any.
   * For `kind: "question"` this is what the agent is actually asking about —
   * either the summary strIDEterm derived from a `PermissionRequest` hook
   * (`"Bash: chmod +x deploy.sh"`) or, failing that, Claude's own hook
   * `message` (`"Claude needs your permission to use Bash"`). `detail` stays
   * the technical code; nothing human goes in there.
   */
  message?: string;
  /** Backend event time. The renderer uses it as the event's `occurredAt`. */
  at: string;
}

export type DockerBackendId = string;

export interface DockerBackend {
  id: DockerBackendId;
  type: "host" | "wsl";
  label: string;
  available: "pending" | "ok" | "error";
  error?: string;
}

export interface DockerLabels {
  composeProject?: string;
  composeService?: string;
  composeWorkingDir?: string;
  composeConfigFiles?: string;
  raw: Record<string, string>;
}

export interface DockerContext {
  Name: string;
  DockerEndpoint: string;
  Current: boolean;
  backendId: DockerBackendId;
  available: "pending" | "ok" | "error";
  error?: string;
  containerCount?: number;
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
  Labels: string;
  parsedLabels?: DockerLabels;
  health?: "healthy" | "unhealthy" | "starting" | "none";
  backendId: DockerBackendId;
  contextName: string;
  [key: string]: unknown;
}

export interface DockerImage {
  ID: string;
  Repository: string;
  Tag: string;
  CreatedSince: string;
  Size: string;
  backendId: DockerBackendId;
  contextName: string;
}

export interface DockerVolume {
  Name: string;
  Driver: string;
  Mountpoint?: string;
  Scope?: string;
  backendId: DockerBackendId;
  contextName: string;
}

export interface DockerNetwork {
  ID: string;
  Name: string;
  Driver: string;
  Scope?: string;
  CreatedAt?: string;
  backendId: DockerBackendId;
  contextName: string;
}

export interface DockerState {
  available: boolean;
  backends: DockerBackend[];
  contexts: DockerContext[];
  containers: DockerContainer[];
  images: DockerImage[];
  volumes: DockerVolume[];
  networks: DockerNetwork[];
  lazydocker: Record<DockerBackendId, { available: boolean; error: string }>;
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
  /**
   * ISO timestamp of the last write to this workspace — the newest of the last
   * commit/checkout (HEAD mtime) and any uncommitted working-tree edit. Null
   * when unknown. Drives the relative "last change" chip on the sidebar card.
   */
  lastChangeAt: string | null;
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

export interface RecoveryCandidate {
  taskId: string;
  workspaceId: string;
  workspaceName: string;
  profileId: string;
  currentRound: number;
  maxRounds: number;
  /** The task state at the time the app was closed (e.g. "running", "judge-evaluating"). */
  previousState: string;
}

/**
 * What actually happened to ONE recovery candidate.
 *
 * The recovery batch used to answer `{ ok: true }` unconditionally, so a
 * refused resume, a dangling attached Primary or a failed session spawn all
 * reported success — and an explicit Resume stamped `lastWorkedAt` on a
 * workspace whose agent never came back (V4 review, §"P1 — task recovery
 * hlásí úspěch"). Every processed candidate now reports its own result:
 *
 *   - "continued" — the agent was resumed AND the session it must re-orient in
 *     is up. The only outcome that counts as work.
 *   - "fresh"     — the round history was reset; the task is idle and startable.
 *   - "skipped"   — the user left it paused. Nothing was attempted.
 *   - "stale"     — the workspace was not (or no longer) a candidate: this
 *     window already settled it, or another window got there first. Settled,
 *     not failed — the renderer may drop it, and nothing is stamped. Without
 *     it the backend answered such a request by omitting the key, which the
 *     renderer read as success (V5 review, §"P2 — recovery kontrakt končí
 *     před transportní hranicí", oprava 2).
 *   - "failed"    — the decision could not be carried out. The candidate stays
 *     in the list so it can be retried or skipped, and never stamps work.
 */
export type RecoveryOutcome = "continued" | "fresh" | "skipped" | "stale" | "failed";

/** Every value the contract defines. A response carrying anything else is as
 *  unusable as one carrying nothing, so the renderer validates against this. */
export const RECOVERY_OUTCOMES: readonly RecoveryOutcome[] = ["continued", "fresh", "skipped", "stale", "failed"];

/** Every outcome that means "this candidate is done with"; the renderer may
 *  drop those from its local list. Anything else — `failed`, or a missing /
 *  unrecognised value — keeps the candidate. */
export const SETTLED_RECOVERY_OUTCOMES: readonly RecoveryOutcome[] = ["continued", "fresh", "skipped", "stale"];

/**
 * Who asked for a recovery batch.
 *
 * "interactive" is a person clicking Resume / Start fresh / Resume all, and is
 * the only origin that stamps `lastWorkedAt`. "internal" is a delegation from
 * another endpoint that owns its own stamp (`resumeTask`), or a future
 * automatic recovery, and stamps nothing.
 */
export type RecoveryOrigin = "interactive" | "internal";

/**
 * The result of one `resolveTaskRecovery` batch. `ok` is derived — it is false
 * as soon as ANY processed candidate failed — so a mixed batch can no longer
 * present itself as a clean success.
 */
export interface RecoveryResult<Payload = unknown> {
  ok: boolean;
  /** Keyed by workspace id. EVERY requested id gets an outcome. */
  outcomes: Record<string, RecoveryOutcome>;
  payload: Payload;
}

/**
 * What the renderer learned from one recovery batch.
 *
 * `unanswered` lists the requested ids the response carried no recognisable
 * outcome for. That is a PROTOCOL failure, not a success: those candidates
 * stay in the local list and the dialog says so, instead of the old
 * `ok: result?.ok !== false` / `outcomes[id] !== "failed"` pair silently
 * turning a missing or malformed response into "all done" (V5 review,
 * §"P2 — recovery kontrakt končí před transportní hranicí").
 */
export interface RecoveryDecisionReport {
  ok: boolean;
  outcomes: Record<string, RecoveryOutcome>;
  unanswered: string[];
}

export interface MetaState {
  appVersion: string;
  repositoryUrl: string;
  versionCheck: VersionCheckState;
  platform: string;
  recoveryCandidates: RecoveryCandidate[];
}

// ------- Remote slim-core contract -------

/**
 * The light git fields the always-on UI (sidebar cards, tab bar, hero) reads —
 * everything the heavy GitSnapshot carries beyond these is pane-only detail
 * fetched on demand. Pushed as `payload.gitSummaries[workspaceId]` in the slim
 * remote core (protocol 2); absent on the desktop full payload, where the same
 * six fields are read straight off `git.workspaces[id]`.
 */
export interface GitSummary {
  available: boolean;
  branch: string;
  dirty: boolean;
  dirtyCount: number;
  branchMerged?: boolean;
  lastChangeAt: string | null;
}

/**
 * Per-resource revision map in the slim remote core. Keys are resource ids
 * (`git:<workspaceId>`, `docker`, `azure-inbox`, `github-inbox`, …); values are
 * opaque change tokens the client compares to decide whether a cached detail is
 * stale. Purely a freshness signal — never a correctness boundary.
 */
export type RemoteResourceRevisions = Record<string, string>;

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
  remoteAccess: RemoteAccessState;
  taskRunner: Record<string, unknown>;
  /** Per-remote-client context — only set when the payload is composed for a specific remote session. */
  remoteClient?: RemoteClientContext;
}

/** Per-remote-client view context injected by the registry when composing. */
export interface RemoteClientContext {
  id: string;
  profileId: string;
  activeWorkspaceId: string;
  activeSessionId: string;
  workspaceGrid?: WorkspaceGridState | null;
}

// ------- Remote slim-core payload (protocol 2) -------

/**
 * The slim `appState` the remote core carries — an explicit ALLOWLIST, not the
 * full persisted `AppState`. Built by `buildRemoteCoreAppState`. Deliberately
 * omits the legacy `projects`/`activeProjectId` aliases (unread by the
 * renderer) and reduces `ssh` to non-secret host metadata (private key material
 * in `keys`/`certificates`/`knownHosts` never reaches a browser). `settings`
 * keeps the shape the remote Settings dialog reads but with provider PATs /
 * GitHub tokens / Telegram connections and the tunnel token+binary path
 * stripped (see `slimRemoteSettings`).
 */
export interface RemoteCoreAppState {
  /** VIEWER-scoped (from `remoteClient`), NOT the desktop-global selection — the
   *  remote renderer reads its own `remoteClient.activeWorkspaceId`; empty for an
   *  unbound socket. */
  activeWorkspaceId: string;
  settings: Settings;
  tabTemplates: TabTemplate[];
  profiles: Profile[];
  /** Only the workspaces in the client's active profile. */
  workspaces: WorkspaceState[];
  /** profileId → workspace count, computed from the FULL workspace list BEFORE
   *  profile-filtering. Lets the remote Profiles dialog show an accurate count
   *  for every profile even though `workspaces` above carries only the viewer's
   *  one profile — a bare count leaks no workspace data. */
  profileWorkspaceCounts: Record<string, number>;
  /** Reduced per-window slots ({ id, profileId, windowIndex }). */
  windowSlots: unknown[];
  /** Host metadata only — keys/certificates/knownHosts are stripped. */
  ssh?: Pick<SshAppState, "hosts" | "settings">;
  /** VIEWER-scoped (from `remoteClient.workspaceGrid`), NOT the desktop-global
   *  grid — the remote renderer reads its own per-client grid; absent for an
   *  unbound socket. */
  workspaceGrid?: WorkspaceGridState | null;
}

/**
 * Reduced provider (Azure DevOps / GitHub) snapshot in the core: badge +
 * notification fields only, profile-filtered. Per-PR entries drop the heavy
 * detail collections (threads / issueComments / reviews / changedFiles), which
 * are fetched on demand via the PR detail endpoint.
 */
export interface RemoteProviderSummary {
  connections: unknown[];
  pullRequests: Record<string, unknown>;
  reviewActivity: unknown[];
  trackedPullRequests: Record<string, unknown>;
  sync?: unknown;
  lastUpdatedAt: string | null;
  error: string;
}

/**
 * The explicit slim remote-state contract (protocol 2). NOT a partially
 * populated desktop `StatePayload`: the remote transport and app store treat it
 * as its own type so a summary field is never confused with a full snapshot.
 * Full git logs, provider PR threads, review-bridge contexts and Docker lists
 * live behind the on-demand detail resources, never in here.
 */
export interface RemoteStateV2 {
  /** Slim-core contract version (== 2). Lets an old tab detect the shape. */
  stateProtocol: number;
  /** Capabilities the server selected for this client (intersection of what the
   *  client advertised and what the server supports). */
  capabilities: string[];
  /** Monotonic per-broadcast revision. The client applies a snapshot only when
   *  its revision is newer than the last applied one (bootstrap→WS handoff). */
  coreRevision: number;
  meta: MetaState;
  appState: RemoteCoreAppState;
  workspace: WorkspaceState | null;
  attention: AttentionState;
  taskRunner: Record<string, unknown>;
  plugins: unknown[];
  environment: Record<string, unknown>;
  /** Share-URL surface only (token blanked). */
  remoteAccess: Partial<RemoteAccessState>;
  /** Light git fields per profile workspace; full snapshots are detail. */
  gitSummaries: Record<string, GitSummary>;
  git: { connections: unknown[] };
  azureDevops: RemoteProviderSummary;
  github: RemoteProviderSummary;
  /** Per-PR badge counts/status only. agentPrompts + full contexts are detail. */
  reviewBridge: { pullRequests: Record<string, unknown> };
  docker: Record<string, unknown>;
  /** Per-resource change tokens (freshness signal, never a correctness boundary). */
  revisions: RemoteResourceRevisions;
  remoteClient?: RemoteClientContext;
}
