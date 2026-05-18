import { z } from "zod";

/**
 * Zod schemas for IPC payload validation.
 * Only covers handlers that accept complex objects from the renderer.
 */

const nonEmptyString = z.string().min(1);

// Git refs cannot start with '-' — prevents option injection in execFile args arrays.
const safeGitRef = z.string().refine((v) => !v.startsWith("-"), {
  message: "Git ref cannot start with '-'",
});

const sshInlineAuthSchema = z
  .object({
    methods: z.array(z.enum(["password", "publickey", "keyboard-interactive", "agent"])).default(["publickey"]),
    keyRef: z.string().optional(),
    certRef: z.string().optional(),
    passwordRef: z.string().optional(),
    passphraseRef: z.string().optional(),
    agent: z.enum(["auto", "socket", "pageant", "pipe", "off"]).default("auto"),
  })
  .passthrough();

const sshInlineSchema = z
  .object({
    host: nonEmptyString,
    port: z.number().int().min(1).max(65535).default(22),
    username: nonEmptyString,
    hostKeyPolicy: z.enum(["strict", "warn", "accept-new"]).default("warn"),
    auth: sshInlineAuthSchema,
    advanced: z
      .object({
        launchVia: z.enum(["ssh2", "system-ssh", "wsl"]).default("ssh2"),
        command: z.string().default(""),
        agentForward: z.boolean().default(false),
      })
      .partial()
      .default({}),
  })
  .passthrough();

const panelLaunchSchema = z
  .object({
    kind: z.string().optional(),
    file: z.string().optional(),
    args: z.array(z.string()).optional(),
    sshHostId: z.string().optional(),
    sshInline: sshInlineSchema.optional(),
  })
  .passthrough()
  .nullable()
  .optional();

export const workspaceSchema = z
  .object({
    id: nonEmptyString,
    name: z.string(),
    cwd: z.string().optional(),
    gitRoots: z.array(z.string()).optional(),
    kind: z.string().optional(),
    panels: z
      .array(
        z
          .object({
            id: nonEmptyString,
            title: z.string(),
            command: z.string().optional(),
            cwd: z.string().optional(),
            shell: z.boolean().optional(),
            startup: z.string().optional(),
            launch: panelLaunchSchema,
          })
          .passthrough(),
      )
      .optional(),
  })
  .passthrough();
export type Workspace = z.infer<typeof workspaceSchema>;

export const projectSchema = workspaceSchema;
export type Project = z.infer<typeof projectSchema>;

export const workspaceUIStateSchema = z.object({
  workspaceId: nonEmptyString,
  uiState: z.object({
    activeViewId: z.string().optional(),
    splitLayout: z.enum(["cols", "rows", "top-split", "left-split", "grid"]).nullable().optional(),
    splitViewIds: z.array(z.string()).optional(),
    activeRootPath: z.string().optional(),
  }),
});
export type WorkspaceUIState = z.infer<typeof workspaceUIStateSchema>;

export const settingsSchema = z.object({}).passthrough();
export type SettingsPayload = z.infer<typeof settingsSchema>;

export const azureConnectionSchema = z
  .object({
    organization: z.string().optional(),
    project: z.string().optional(),
    pat: z.string().optional(),
  })
  .passthrough();
export type AzureConnectionPayload = z.infer<typeof azureConnectionSchema>;

export const prKeySchema = nonEmptyString;
export type PrKey = z.infer<typeof prKeySchema>;

export const azureCommentSchema = z.object({
  prKey: nonEmptyString,
  content: z.string(),
  threadId: z.number().nullable().optional(),
  parentCommentId: z.number().optional(),
});
export type AzureComment = z.infer<typeof azureCommentSchema>;

export const azureVoteSchema = z.object({
  prKey: nonEmptyString,
  vote: z.number(),
});
export type AzureVote = z.infer<typeof azureVoteSchema>;

export const azureThreadStatusSchema = z.object({
  prKey: nonEmptyString,
  threadId: z.number(),
  status: z.enum(["active", "fixed", "closed", "wontFix", "pending", "byDesign"]),
});
export type AzureThreadStatus = z.infer<typeof azureThreadStatusSchema>;

export const openPrSchema = z.object({
  prKey: nonEmptyString,
  workspaceId: z.string().optional(),
});
export type OpenPr = z.infer<typeof openPrSchema>;

export const reviewBridgeDraftSchema = z
  .object({
    prKey: nonEmptyString,
  })
  .passthrough();
export type ReviewBridgeDraft = z.infer<typeof reviewBridgeDraftSchema>;

export const reviewBridgeDraftCommentSchema = z.object({
  prKey: nonEmptyString,
  body: z.string().min(1),
  title: z.string().optional(),
  filePath: z.string().optional(),
  lineNumber: z.number().int().positive().nullable().optional(),
  priority: z.string().optional(),
  authorAgent: z.string().optional(),
  threadId: z.number().int().nullable().optional(),
  autoQueue: z.boolean().optional(),
});
export type ReviewBridgeDraftComment = z.infer<typeof reviewBridgeDraftCommentSchema>;

export const reviewBridgeQueueSchema = z.object({
  prKey: nonEmptyString,
  draftId: nonEmptyString,
});
export type ReviewBridgeQueue = z.infer<typeof reviewBridgeQueueSchema>;

export const reviewBridgeDeleteDraftSchema = reviewBridgeQueueSchema;
export type ReviewBridgeDeleteDraft = z.infer<typeof reviewBridgeDeleteDraftSchema>;

export const reviewBridgeDeleteCommentSchema = z.object({
  prKey: nonEmptyString,
  commentKey: nonEmptyString,
});
export type ReviewBridgeDeleteComment = z.infer<typeof reviewBridgeDeleteCommentSchema>;

export const reviewBridgeReplyWithChangesSchema = z
  .object({
    prKey: nonEmptyString,
  })
  .passthrough();
export type ReviewBridgeReplyWithChanges = z.infer<typeof reviewBridgeReplyWithChangesSchema>;

export const reviewBridgeSyncSchema = z.object({
  prKey: nonEmptyString,
});
export type ReviewBridgeSync = z.infer<typeof reviewBridgeSyncSchema>;

export const reviewBridgePushAndPublishSchema = z.object({
  workspaceId: nonEmptyString,
});
export type ReviewBridgePushAndPublish = z.infer<typeof reviewBridgePushAndPublishSchema>;

export const agentPromptSaveSchema = z.object({}).passthrough();
export type AgentPromptSave = z.infer<typeof agentPromptSaveSchema>;

export const agentPromptDeleteSchema = z.object({
  promptId: nonEmptyString,
});
export type AgentPromptDelete = z.infer<typeof agentPromptDeleteSchema>;

export const gitWorkspaceRef = z.object({
  workspaceId: z.string().optional(),
  projectId: z.string().optional(),
  rootPath: z.string().optional(),
});
export type GitWorkspaceRef = z.infer<typeof gitWorkspaceRef>;

export const gitPayloadSchema = z
  .object({
    workspaceId: nonEmptyString,
    baseBranch: safeGitRef.optional(),
    rootPath: z.string().optional(),
  })
  .passthrough();
export type GitPayload = z.infer<typeof gitPayloadSchema>;

export const gitLogPageSchema = z.object({
  workspaceId: nonEmptyString,
  rootPath: z.string().optional(),
  baseBranch: safeGitRef.optional(),
  skip: z.number().int().min(0).default(0),
  limit: z.number().int().min(1).max(500).default(100),
});
export type GitLogPage = z.infer<typeof gitLogPageSchema>;

export const gitDiffPreviewSchema = z.object({
  workspaceId: nonEmptyString,
  path: nonEmptyString,
  scope: z.string().optional(),
  baseBranch: safeGitRef.optional(),
  rootPath: z.string().optional(),
});
export type GitDiffPreview = z.infer<typeof gitDiffPreviewSchema>;

export const gitCommitSchema = z
  .object({
    workspaceId: nonEmptyString,
    message: z.string().optional(),
  })
  .passthrough();
export type GitCommit = z.infer<typeof gitCommitSchema>;

export const gitTagSchema = z.object({
  workspaceId: nonEmptyString,
  tagName: nonEmptyString,
  message: z.string().optional(),
  commit: safeGitRef.optional(),
});
export type GitTag = z.infer<typeof gitTagSchema>;

// Safe identifier: alphanumeric + dash/underscore/colon, max 128 chars, cannot start with '-'.
const safeDockerId = z
  .string()
  .min(1)
  .max(128)
  .refine((v) => !v.startsWith("-"), { message: "Docker ID cannot start with '-'" });

// Docker volume names per docker source: `[a-zA-Z0-9][a-zA-Z0-9_.-]+`. We're a
// bit looser (allow leading underscore) but explicitly reject ':' so an
// attacker can't smuggle a host-path remount via `-v <name>:/_vol:ro`.
const safeDockerVolumeName = z
  .string()
  .min(1)
  .max(255)
  .refine((v) => !v.startsWith("-") && !v.includes(":") && !v.includes("/"), {
    message: "Volume name cannot start with '-' or contain ':' or '/'",
  });

export const dockerActionSchema = z.object({
  action: nonEmptyString,
  // Container IDs/names are alphanumeric (`[a-zA-Z0-9][a-zA-Z0-9_.-]+`) per
  // docker. Reuse safeDockerId so a `-rf`-style argv injection is blocked at
  // the IPC boundary even though execFile already prevents shell injection.
  containerId: safeDockerId,
  backendId: z.string().optional(),
  contextName: safeDockerId.optional(),
});
export type DockerAction = z.infer<typeof dockerActionSchema>;

export const dockerSessionSchema = z
  .object({
    workspaceId: nonEmptyString,
    containerId: z.string().optional(),
    mode: z.string().optional(),
    backendId: z.string().optional(),
    contextName: safeDockerId.optional(),
  })
  .passthrough();
export type DockerSession = z.infer<typeof dockerSessionSchema>;

/**
 * Tail param accepts either a positive integer (capped at 1_000_000 so we
 * don't accidentally start a "replay the whole log file" DoS) or the literal
 * "all". The default is filled in by DockerLogSession.
 */
const tailParam = z.union([z.literal("all"), z.number().int().positive().max(1_000_000)]);

export const dockerLogsOpenSchema = z.object({
  sessionId: nonEmptyString,
  containerId: safeDockerId,
  backendId: z.string().min(1),
  contextName: safeDockerId,
  timestamps: z.boolean().optional(),
  tail: tailParam.optional(),
});
export type DockerLogsOpen = z.infer<typeof dockerLogsOpenSchema>;

export const dockerLogsUpdateSchema = z.object({
  sessionId: nonEmptyString,
  timestamps: z.boolean().optional(),
  tail: tailParam.optional(),
});
export type DockerLogsUpdate = z.infer<typeof dockerLogsUpdateSchema>;

export const dockerLogsCloseSchema = z.object({
  sessionId: nonEmptyString,
});
export type DockerLogsClose = z.infer<typeof dockerLogsCloseSchema>;

export const dockerComposeActionSchema = z.object({
  action: z.enum(["start", "stop", "restart"]),
  backendId: z.string().min(1),
  contextName: safeDockerId,
  projectName: nonEmptyString,
});
export type DockerComposeAction = z.infer<typeof dockerComposeActionSchema>;

export const dockerInspectSchema = z.object({
  containerId: safeDockerId,
  backendId: z.string().min(1),
  contextName: safeDockerId,
});
export type DockerInspect = z.infer<typeof dockerInspectSchema>;

export const dockerTopSchema = dockerInspectSchema;
export type DockerTop = DockerInspect;

export const dockerStatsSchema = dockerInspectSchema;
export type DockerStats = DockerInspect;

export const dockerShellOpenSchema = z.object({
  sessionId: nonEmptyString,
  containerId: safeDockerId,
  backendId: z.string().min(1),
  contextName: safeDockerId,
  cols: z.number().int().positive().max(1000).optional(),
  rows: z.number().int().positive().max(1000).optional(),
});
export type DockerShellOpen = z.infer<typeof dockerShellOpenSchema>;

export const dockerShellWriteSchema = z.object({
  sessionId: nonEmptyString,
  data: z.string().max(1024 * 1024),
});
export type DockerShellWrite = z.infer<typeof dockerShellWriteSchema>;

export const dockerShellResizeSchema = z.object({
  sessionId: nonEmptyString,
  cols: z.number().int().positive().max(1000),
  rows: z.number().int().positive().max(1000),
});
export type DockerShellResize = z.infer<typeof dockerShellResizeSchema>;

export const dockerShellCloseSchema = z.object({
  sessionId: nonEmptyString,
});
export type DockerShellClose = z.infer<typeof dockerShellCloseSchema>;

export const dockerResourceRefSchema = z.object({
  /** Image ID, volume name, or network ID. Allow @, :, /, _, ., - in addition
   * to the strict alphanumeric set so we can target e.g. `repo/name:tag`. */
  resource: z
    .string()
    .min(1)
    .max(256)
    .refine((v) => !v.startsWith("-"), { message: "Resource ref cannot start with '-'" }),
  backendId: z.string().min(1),
  contextName: safeDockerId,
});
export type DockerResourceRef = z.infer<typeof dockerResourceRefSchema>;

export const dockerRemoveSchema = dockerResourceRefSchema.extend({
  force: z.boolean().optional(),
});
export type DockerRemove = z.infer<typeof dockerRemoveSchema>;

export const dockerSystemDfSchema = z.object({
  backendId: z.string().min(1).optional(),
  contextName: safeDockerId.optional(),
});
export type DockerSystemDf = z.infer<typeof dockerSystemDfSchema>;

/**
 * Prune actions (image / volume / network / builder). `all` is only meaningful
 * for image and builder prune; ignored for volume / network.
 */
export const dockerPruneSchema = z.object({
  backendId: z.string().min(1),
  contextName: safeDockerId,
  all: z.boolean().optional(),
});
export type DockerPrune = z.infer<typeof dockerPruneSchema>;

export const dockerVolumeBrowseSchema = z.object({
  volumeName: safeDockerVolumeName,
  backendId: z.string().min(1),
  contextName: safeDockerId,
  // Cap path length defensively. The deeper guard against `..` lives in
  // DockerManager.sanitizeVolumePath; here we only reject obviously bogus
  // input before it crosses the IPC boundary.
  subPath: z
    .string()
    .max(1024)
    .refine((v) => !v.includes("\0"), { message: "NUL bytes are not allowed in paths" })
    .default("/"),
});
export type DockerVolumeBrowse = z.infer<typeof dockerVolumeBrowseSchema>;

export const terminalResizeSchema = z.object({
  cols: z.number().int().positive(),
  rows: z.number().int().positive(),
});
export type TerminalResize = z.infer<typeof terminalResizeSchema>;

export const profileSchema = z
  .object({
    id: z.string().optional(),
    name: z.string(),
  })
  .passthrough();
export type ProfilePayload = z.infer<typeof profileSchema>;

export const worktreeSchema = z.object({
  workspaceId: nonEmptyString,
  name: nonEmptyString,
  rootPath: z.string().optional(),
});
export type WorktreePayload = z.infer<typeof worktreeSchema>;

export const removeWorktreeSchema = z.object({
  workspaceId: nonEmptyString,
  worktreePath: nonEmptyString,
  deleteBranch: z.boolean().optional(),
});
export type RemoveWorktree = z.infer<typeof removeWorktreeSchema>;

export const quickFixListProjectsSchema = z.object({
  connectionId: nonEmptyString,
});
export type QuickFixListProjects = z.infer<typeof quickFixListProjectsSchema>;

export const quickFixListRepositoriesSchema = z.object({
  connectionId: nonEmptyString,
  projectName: nonEmptyString,
});
export type QuickFixListRepositories = z.infer<typeof quickFixListRepositoriesSchema>;

export const quickFixListBranchesSchema = z.object({
  connectionId: nonEmptyString,
  projectName: nonEmptyString,
  repositoryId: nonEmptyString,
});
export type QuickFixListBranches = z.infer<typeof quickFixListBranchesSchema>;

export const quickFixCreateSchema = z.object({
  connectionId: nonEmptyString,
  projectName: nonEmptyString,
  repositoryId: nonEmptyString,
  repositoryName: nonEmptyString,
  remoteUrl: nonEmptyString,
  baseBranch: nonEmptyString,
  newBranchName: nonEmptyString,
});
export type QuickFixCreate = z.infer<typeof quickFixCreateSchema>;

export const azureAuditLogQuerySchema = z.object({
  from: z.string().optional(),
  to: z.string().optional(),
  category: z.string().optional(),
  connectionId: z.string().optional(),
  success: z.boolean().optional(),
  operation: z.string().optional(),
  userInitiated: z.boolean().optional(),
  search: z.string().optional(),
  limit: z.number().int().positive().optional(),
  offset: z.number().int().min(0).optional(),
});
export type AzureAuditLogQuery = z.infer<typeof azureAuditLogQuerySchema>;

export const azureAuditLogStatsSchema = z.object({
  from: z.string().optional(),
  connectionId: z.string().optional(),
});
export type AzureAuditLogStats = z.infer<typeof azureAuditLogStatsSchema>;

export const githubConnectionSchema = z
  .object({
    hostUrl: z.string().optional(),
    pat: z.string().optional(),
  })
  .passthrough();
export type GithubConnectionPayload = z.infer<typeof githubConnectionSchema>;

export const telegramConnectionSchema = z
  .object({
    id: z.string().optional(),
    label: z.string().optional(),
    botToken: z.string().optional(),
    botTokenRef: z.string().optional(),
    chatId: z.string().optional(),
    enabled: z.boolean().optional(),
    pollSeconds: z.number().int().min(1).max(3600).optional(),
    profileId: z.string().optional(),
    forwardKinds: z.array(z.string()).optional(),
  })
  .passthrough();
export type TelegramConnectionPayload = z.infer<typeof telegramConnectionSchema>;

export const githubCommentSchema = z.object({
  prKey: nonEmptyString,
  body: z.string().min(1),
});
export type GithubComment = z.infer<typeof githubCommentSchema>;

export const githubReviewSchema = z.object({
  prKey: nonEmptyString,
  event: z.enum(["APPROVE", "REQUEST_CHANGES", "COMMENT"]),
  body: z.string().optional(),
});
export type GithubReview = z.infer<typeof githubReviewSchema>;

export const githubAuditLogQuerySchema = z.object({
  from: z.string().optional(),
  to: z.string().optional(),
  category: z.string().optional(),
  connectionId: z.string().optional(),
  success: z.boolean().optional(),
  operation: z.string().optional(),
  userInitiated: z.boolean().optional(),
  search: z.string().optional(),
  limit: z.number().int().positive().optional(),
  offset: z.number().int().min(0).optional(),
});
export type GithubAuditLogQuery = z.infer<typeof githubAuditLogQuerySchema>;

export const githubAuditLogStatsSchema = z.object({
  from: z.string().optional(),
  connectionId: z.string().optional(),
});
export type GithubAuditLogStats = z.infer<typeof githubAuditLogStatsSchema>;

export const githubQuickFixListReposSchema = z.object({
  connectionId: nonEmptyString,
});
export type GithubQuickFixListRepos = z.infer<typeof githubQuickFixListReposSchema>;

export const githubQuickFixListBranchesSchema = z.object({
  connectionId: nonEmptyString,
  owner: nonEmptyString,
  repo: nonEmptyString,
});
export type GithubQuickFixListBranches = z.infer<typeof githubQuickFixListBranchesSchema>;

export const githubQuickFixCreateSchema = z.object({
  connectionId: nonEmptyString,
  owner: nonEmptyString,
  repo: nonEmptyString,
  remoteUrl: nonEmptyString,
  baseBranch: nonEmptyString,
  newBranchName: nonEmptyString,
});
export type GithubQuickFixCreate = z.infer<typeof githubQuickFixCreateSchema>;

export const providerConfigSchema = z.object({
  providerId: z.enum(["claude", "codex", "gemini", "copilot", "opencode"]),
  model: z.string().max(100),
  skipPermissions: z.boolean().optional(),
  extra: z.record(z.string(), z.unknown()).optional(),
});
export type ProviderConfigPayload = z.infer<typeof providerConfigSchema>;

// Kept aligned with src/app/task-brief.ts:TASK_BRIEF_MAX_CHARS so the UI
// maxlength and the IPC validator agree on the same ceiling.
const TASK_BRIEF_MAX_CHARS = 20000;

export const taskWorkspaceCreateSchema = z.object({
  cwd: nonEmptyString,
  description: z.string().max(TASK_BRIEF_MAX_CHARS).optional().default(""),
  parentWorkspaceId: z.string().optional(),
  maxRounds: z.number().int().min(1).max(100).optional(),
  useWorktree: z.boolean().optional(),
  worktreeBranch: z.string().optional(),
  gitRoots: z.array(z.string()).optional(),
  name: z.string().max(60).optional(),
  icon: z.string().max(4).optional(),
  color: z.string().max(20).optional(),
  notes: z.string().max(500).optional(),
  workerCommand: z.string().max(500).optional(),
  judgeCommand: z.string().max(500).optional(),
  workerProvider: providerConfigSchema.optional(),
  judgeProvider: providerConfigSchema.optional(),
});
export type TaskWorkspaceCreate = z.infer<typeof taskWorkspaceCreateSchema>;

export const taskWorkspaceActionSchema = z.object({
  workspaceId: nonEmptyString,
});
export type TaskWorkspaceAction = z.infer<typeof taskWorkspaceActionSchema>;

export const taskRejectVerdictSchema = z.object({
  workspaceId: nonEmptyString,
  feedback: z.string().min(1).max(5000),
});
export type TaskRejectVerdict = z.infer<typeof taskRejectVerdictSchema>;

export const taskUpdateDescriptionSchema = z.object({
  workspaceId: nonEmptyString,
  description: z.string().max(TASK_BRIEF_MAX_CHARS),
});
export type TaskUpdateDescription = z.infer<typeof taskUpdateDescriptionSchema>;

export const taskRecoveryResolveSchema = z.object({
  decisions: z.record(z.string(), z.enum(["continue", "fresh", "skip"])),
});
export type TaskRecoveryResolve = z.infer<typeof taskRecoveryResolveSchema>;

export const workspaceReorderSchema = z.array(nonEmptyString);
export type WorkspaceReorder = z.infer<typeof workspaceReorderSchema>;

export const attentionSyncSchema = z.object({
  visibleSessionIds: z.array(z.string()).optional(),
  windowFocused: z.boolean().optional(),
});
export type AttentionSync = z.infer<typeof attentionSyncSchema>;

export const notificationShowSchema = z.object({
  title: z.string().optional(),
  body: z.string().optional(),
  urgency: z.enum(["normal", "urgent"]).optional(),
  requireInteraction: z.boolean().optional(),
});
export type NotificationShow = z.infer<typeof notificationShowSchema>;

export const workspacePushOptionsSchema = z.object({
  force: z.boolean().optional(),
});
export type WorkspacePushOptions = z.infer<typeof workspacePushOptionsSchema>;

export const rerunCheckSchema = z.object({
  prKey: nonEmptyString,
  checkItem: z.object({
    id: z.string(),
    kind: z.string(),
    evaluationId: z.string().nullable().optional(),
    checkSuiteId: z.union([z.string(), z.number()]).nullable().optional(),
    name: z.string().optional(),
  }),
});
export type RerunCheck = z.infer<typeof rerunCheckSchema>;

export const wsTerminalInputSchema = z.object({
  type: z.literal("terminal:input"),
  sessionId: nonEmptyString,
  data: z.string(),
});
export type WsTerminalInput = z.infer<typeof wsTerminalInputSchema>;

export const wsTerminalResizeSchema = z.object({
  type: z.literal("terminal:resize"),
  sessionId: nonEmptyString,
  cols: z.number().int().positive(),
  rows: z.number().int().positive(),
});
export type WsTerminalResize = z.infer<typeof wsTerminalResizeSchema>;

export const fileListSchema = z.object({
  rootPath: z.string().min(1),
  relativePath: z.string(),
});
export type FileList = z.infer<typeof fileListSchema>;

export const fileReadSchema = z.object({
  rootPath: z.string().min(1),
  relativePath: z.string().min(1),
});
export type FileRead = z.infer<typeof fileReadSchema>;

export const fileWriteSchema = z.object({
  rootPath: z.string().min(1),
  relativePath: z.string().min(1),
  content: z.string(),
});
export type FileWrite = z.infer<typeof fileWriteSchema>;

export const fileCreateSchema = z.object({
  rootPath: z.string().min(1),
  parentPath: z.string(),
  name: z.string().min(1),
});
export type FileCreate = z.infer<typeof fileCreateSchema>;

export const fileRenameSchema = z.object({
  rootPath: z.string().min(1),
  relativePath: z.string().min(1),
  newName: z.string().min(1),
});
export type FileRename = z.infer<typeof fileRenameSchema>;

export const fileDeleteSchema = z.object({
  rootPath: z.string().min(1),
  relativePath: z.string().min(1),
});
export type FileDelete = z.infer<typeof fileDeleteSchema>;

export const fileMoveSchema = z.object({
  rootPath: z.string().min(1),
  fromPath: z.string().min(1),
  toPath: z.string().min(1),
});
export type FileMove = z.infer<typeof fileMoveSchema>;

export const fileGitStatusSchema = z.object({
  rootPath: z.string().min(1),
  includeIgnored: z.boolean().optional(),
});
export type FileGitStatus = z.infer<typeof fileGitStatusSchema>;

export const fileGitRefsSchema = z.object({
  rootPath: z.string().min(1),
  relativePath: z.string().optional(),
});
export type FileGitRefs = z.infer<typeof fileGitRefsSchema>;

export const fileGitDiffSchema = z.object({
  rootPath: z.string().min(1),
  relativePath: z.string().min(1),
  source: z.enum(["head", "staged", "commit", "branch", "tag"]).default("head"),
  revisionRef: z.string().optional(),
});
export type FileGitDiff = z.infer<typeof fileGitDiffSchema>;

export const fileCommitFilesSchema = z.object({
  rootPath: z.string().min(1),
  hash: z.string().min(1),
});
export type FileCommitFiles = z.infer<typeof fileCommitFilesSchema>;

export const fileCommitDiffSchema = z.object({
  rootPath: z.string().min(1),
  relativePath: z.string().min(1),
  hash: z.string().min(1),
});
export type FileCommitDiff = z.infer<typeof fileCommitDiffSchema>;

export const sshHostCreateSchema = z.object({
  name: z.string().min(1),
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535).default(22),
  username: z.string().min(1),
  auth: z.object({
    methods: z.array(z.enum(["password", "publickey", "keyboard-interactive", "agent"])).min(1),
    keyRef: z.string().optional(),
    certRef: z.string().optional(),
    passwordRef: z.string().optional(),
    passphraseRef: z.string().optional(),
    agent: z.enum(["auto", "socket", "pageant", "pipe", "off"]).default("auto"),
  }),
  jump: z.array(z.string()).default([]),
  hostKeyPolicy: z.enum(["strict", "warn", "accept-new"]).default("warn"),
  advanced: z
    .object({
      keepaliveIntervalMs: z.number().int().min(0).default(30000),
      keepaliveCountMax: z.number().int().min(0).default(3),
      compression: z.boolean().default(true),
      agentForward: z.boolean().default(false),
      env: z.record(z.string(), z.string()).default({}),
      command: z.string().default(""),
      useSystemSsh: z.boolean().default(false),
      launchVia: z.enum(["ssh2", "system-ssh", "wsl"]).default("ssh2"),
      wsl: z
        .object({
          distro: z.string().nullable().optional(),
          user: z.string().nullable().optional(),
          exec: z.string().default("ssh"),
          importFromWsl: z.boolean().default(false),
        })
        .optional(),
    })
    .partial()
    .default({}),
  tags: z.array(z.string()).default([]),
});
export type SshHostCreate = z.infer<typeof sshHostCreateSchema>;

export const sshHostUpdateSchema = z.object({
  id: z.string(),
  patch: sshHostCreateSchema.partial(),
});
export type SshHostUpdate = z.infer<typeof sshHostUpdateSchema>;

export const sshHostDeleteSchema = z.object({ id: z.string() });
export type SshHostDelete = z.infer<typeof sshHostDeleteSchema>;

export const sshKeyImportSchema = z.object({
  label: z.string(),
  privateKey: z.string().min(1),
  passphrase: z.string().optional(),
});
export type SshKeyImport = z.infer<typeof sshKeyImportSchema>;

export const sshKeyGenerateSchema = z.object({
  kind: z.enum(["ed25519", "ecdsa", "rsa"]),
  bits: z.number().int().optional(),
  comment: z.string().default(""),
  passphrase: z.string().optional(),
});
export type SshKeyGenerate = z.infer<typeof sshKeyGenerateSchema>;

export const sshCertImportSchema = z.object({
  keyId: z.string(),
  certificate: z.string().min(1),
});
export type SshCertImport = z.infer<typeof sshCertImportSchema>;

export const sshAuthAnswerSchema = z.object({
  sessionId: z.string(),
  answers: z.array(z.string()),
});
export type SshAuthAnswer = z.infer<typeof sshAuthAnswerSchema>;

export const sshAcceptHostKeySchema = z.object({
  sessionId: z.string(),
  mode: z.enum(["once", "permanent"]),
});
export type SshAcceptHostKey = z.infer<typeof sshAcceptHostKeySchema>;

export const sshConfigImportSchema = z.object({
  path: z.string().optional(),
  hostIds: z.array(z.string()).optional(),
});
export type SshConfigImport = z.infer<typeof sshConfigImportSchema>;

export const sshKnownHostsImportSchema = z.object({
  path: z.string().optional(),
});
export type SshKnownHostsImport = z.infer<typeof sshKnownHostsImportSchema>;

// ------- Workspace grid schemas -------

const workspaceGridLayoutSchema = z.enum(["cols", "rows", "top-split", "left-split", "grid"]);

export const workspaceGridEnableSchema = z.object({
  layout: workspaceGridLayoutSchema,
  workspaceIds: z.array(z.string().nullable()).optional(),
});
export type WorkspaceGridEnable = z.infer<typeof workspaceGridEnableSchema>;

export const workspaceGridSetLayoutSchema = z.object({
  layout: workspaceGridLayoutSchema,
});
export type WorkspaceGridSetLayout = z.infer<typeof workspaceGridSetLayoutSchema>;

export const workspaceGridSetCellSchema = z.object({
  cellIndex: z.number().int().min(0).max(3),
  workspaceId: z.string().nullable(),
});
export type WorkspaceGridSetCell = z.infer<typeof workspaceGridSetCellSchema>;

export const workspaceGridSwapCellsSchema = z.object({
  a: z.number().int().min(0).max(3),
  b: z.number().int().min(0).max(3),
});
export type WorkspaceGridSwapCells = z.infer<typeof workspaceGridSwapCellsSchema>;

// ----------------------------------------

export function validateIpc<T extends z.ZodTypeAny>(schema: T, payload: unknown, channel: string): z.infer<T> {
  const result = schema.safeParse(payload);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`IPC validation failed on '${channel}': ${issues}`);
  }
  return result.data as z.infer<T>;
}
