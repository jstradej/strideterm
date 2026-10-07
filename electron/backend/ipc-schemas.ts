import { z } from "zod";
export { remoteSessionRevokeSchema } from "../shared/remote-access.js";

import type { AccountUiState } from "./account/account-state.js";

/**
 * Zod schemas for IPC payload validation.
 * Only covers handlers that accept complex objects from the renderer.
 */

const nonEmptyString = z.string().min(1);
const sshLaunchViaSchema = z.enum(["default", "ssh2", "system-ssh", "wsl"]);

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
    agent: z.enum(["auto", "socket", "pageant", "pipe", "off"]).optional(),
  })
  .passthrough();

const sshInlineSchema = z
  .object({
    host: nonEmptyString,
    port: z.number().int().min(1).max(65535).optional(),
    username: z.string().optional(),
    hostKeyPolicy: z.enum(["strict", "warn", "accept-new"]).optional(),
    auth: sshInlineAuthSchema,
    advanced: z
      .object({
        launchVia: sshLaunchViaSchema.default("default"),
        portOverride: z.boolean().optional(),
        command: z.string().optional(),
        sshPath: z.string().nullable().optional(),
        agentForward: z.boolean().optional(),
        keepaliveIntervalMs: z.number().int().min(0).nullable().optional(),
        keepaliveCountMax: z.number().int().min(0).nullable().optional(),
        compression: z.boolean().nullable().optional(),
        wsl: z
          .object({
            distro: z.string().trim().min(1).nullable().optional(),
            user: z
              .string()
              .trim()
              .regex(/^[A-Za-z_][A-Za-z0-9_.-]*$/)
              .nullable()
              .optional(),
            exec: z
              .string()
              .trim()
              .min(1)
              .refine((value) => !value.startsWith("-") && !/[\0\r\n]/.test(value))
              .optional(),
          })
          .passthrough()
          .nullable()
          .optional(),
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
            sshMcpEnabled: z.boolean().optional(),
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

export const settingsSchema = z
  .object({
    remoteAccess: z.object({ paused: z.boolean().optional() }).passthrough().optional(),
    ssh: z
      .object({
        defaultLaunchVia: z.enum(["ssh2", "system-ssh", "wsl"]).optional(),
        systemSshPath: z.string().trim().optional(),
        wslDefaultDistro: z.string().trim().optional(),
        wslSshExec: z
          .string()
          .trim()
          .min(1)
          .refine((value) => !value.startsWith("-") && !/[\0\r\n]/.test(value))
          .optional(),
        agentPath: z.string().optional(),
        defaultAgentMode: z.enum(["auto", "socket", "pageant", "pipe", "off"]).optional(),
        requireEncryptedStorage: z.boolean().optional(),
      })
      .optional(),
  })
  .passthrough();
export type SettingsPayload = z.infer<typeof settingsSchema>;

export const azureConnectionSchema = z
  .object({
    organization: z.string().optional(),
    project: z.string().optional(),
    pat: z.string().optional(),
    /** Owning profile — validated against the caller viewer's profile in saveAzureConnection. */
    profileId: z.string().optional(),
  })
  .passthrough();
export type AzureConnectionPayload = z.infer<typeof azureConnectionSchema>;

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
  /** Ask for a managed review checkout instead of attaching the PR to the
   *  author's workspace that happens to sit on its source branch. */
  forceReview: z.boolean().optional(),
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
  lineSide: z.enum(["old", "new"]).optional(),
  priority: z.string().optional(),
  authorAgent: z.string().optional(),
  threadId: z.number().int().nullable().optional(),
  autoQueue: z.boolean().optional(),
});
export type ReviewBridgeDraftComment = z.infer<typeof reviewBridgeDraftCommentSchema>;

export const reviewBridgeQueueSchema = z
  .object({
    prKey: nonEmptyString,
    draftId: nonEmptyString.optional(),
    commentKey: nonEmptyString.optional(),
  })
  .refine(({ draftId, commentKey }) => Boolean(draftId) !== Boolean(commentKey), {
    message: "Provide exactly one of draftId or commentKey.",
  });
export type ReviewBridgeQueue = z.infer<typeof reviewBridgeQueueSchema>;

export const reviewBridgeDeleteDraftSchema = z.object({
  prKey: nonEmptyString,
  draftId: nonEmptyString,
});
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

export const gitPayloadSchema = z
  .object({
    workspaceId: nonEmptyString,
    baseBranch: safeGitRef.optional(),
    rootPath: z.string().optional(),
  })
  .passthrough();
export type GitPayload = z.infer<typeof gitPayloadSchema>;

// Permissive payload for the Azure DevOps Pipelines tab IPC calls. Only the
// connection is required; projectName / pipelineId / runId / branch /
// parameters / variables ride along via passthrough.
export const azurePipelinePayloadSchema = z
  .object({
    connectionId: nonEmptyString,
  })
  .passthrough();
export type AzurePipelinePayload = z.infer<typeof azurePipelinePayloadSchema>;

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
    // When present, commit only these repo-relative paths; otherwise commit the
    // whole working tree (git add -A). An empty array is an explicitly-scoped
    // request with no files, which the handler rejects rather than committing
    // everything. Entries must be non-empty.
    paths: z.array(nonEmptyString).optional(),
    // Old names of selected staged renames — committed (never staged) so the
    // delete side of a rename is recorded. Kept separate from `paths`.
    previousPaths: z.array(nonEmptyString).optional(),
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

// Hex-only commit hashes (short or full) — rules out option injection in the
// execFile args array the same way safeGitRef does, but stricter.
const commitHashString = z.string().regex(/^[0-9a-fA-F]{4,40}$/);

export const gitCherryPickSchema = z.object({
  workspaceId: nonEmptyString,
  hashes: z.array(commitHashString).min(1).max(200),
  rootPath: z.string().optional(),
});
export type GitCherryPick = z.infer<typeof gitCherryPickSchema>;

export const gitSquashSchema = z.object({
  workspaceId: nonEmptyString,
  hashes: z.array(commitHashString).min(2).max(200),
  message: nonEmptyString,
  rootPath: z.string().optional(),
});
export type GitSquash = z.infer<typeof gitSquashSchema>;

// --- Stash detail / lifecycle schemas ---
// A strict `stash@{N}` regex on `ref` defends the IPC layer against
// command-injection through the git CLI.
const stashRefString = z.string().regex(/^stash@\{\d+\}$/);

export const gitStashListSchema = z.object({
  workspaceId: nonEmptyString,
  projectId: z.string().optional(),
  rootPath: z.string().optional(),
});
export type GitStashList = z.infer<typeof gitStashListSchema>;

export const gitStashRefSchema = gitStashListSchema.extend({ ref: stashRefString });
export type GitStashRef = z.infer<typeof gitStashRefSchema>;

export const gitStashFilesSchema = gitStashRefSchema;
export const gitStashFileDiffSchema = gitStashRefSchema.extend({ relativePath: z.string().min(1) });
export type GitStashFileDiff = z.infer<typeof gitStashFileDiffSchema>;
export const gitStashApplySchema = gitStashRefSchema;
export const gitStashDropSchema = gitStashRefSchema;
export const gitStashBranchSchema = gitStashRefSchema.extend({
  branchName: z
    .string()
    .min(1)
    .regex(/^[A-Za-z0-9._/-]+$/),
  switchImmediately: z.boolean(),
});
export type GitStashBranch = z.infer<typeof gitStashBranchSchema>;
export const gitStashExportSchema = gitStashRefSchema;
export const gitStashImportSchema = gitStashListSchema.extend({
  // 64 MiB cap — anything larger is almost certainly a mistake.
  patch: z
    .string()
    .min(1)
    .max(64 * 1024 * 1024),
  message: z.string().optional(),
});
export type GitStashImport = z.infer<typeof gitStashImportSchema>;

export const gitBranchListSchema = z.object({
  workspaceId: nonEmptyString,
  rootPath: z.string().optional(),
});
export type GitBranchList = z.infer<typeof gitBranchListSchema>;

export const gitBranchDeleteSchema = z.object({
  workspaceId: nonEmptyString,
  branch: safeGitRef,
  force: z.boolean().optional(),
  rootPath: z.string().optional(),
});
export type GitBranchDelete = z.infer<typeof gitBranchDeleteSchema>;

export const gitRemoteBranchDeleteSchema = z.object({
  workspaceId: nonEmptyString,
  branch: safeGitRef,
  remote: safeGitRef.optional(),
  rootPath: z.string().optional(),
});
export type GitRemoteBranchDelete = z.infer<typeof gitRemoteBranchDeleteSchema>;

export const gitBranchRenameSchema = z.object({
  workspaceId: nonEmptyString,
  branch: safeGitRef.optional(),
  newName: safeGitRef,
  rootPath: z.string().optional(),
});
export type GitBranchRename = z.infer<typeof gitBranchRenameSchema>;

export const gitCheckoutRemoteSchema = z.object({
  workspaceId: nonEmptyString,
  remoteBranch: safeGitRef,
  localBranch: safeGitRef.optional(),
  rootPath: z.string().optional(),
});
export type GitCheckoutRemote = z.infer<typeof gitCheckoutRemoteSchema>;

// ISO 8601 date or git-friendly relative ("2 weeks ago"). Rejects flags to
// prevent injection — same defence as safeGitRef.
const safeDateExpr = z
  .string()
  .max(64)
  .refine((v) => !v.startsWith("-"), { message: "Date cannot start with '-'" });

// Repository-relative path. Reject "-" prefix and any "../" escape; keep
// max length sane.
const safeRepoPath = z
  .string()
  .min(1)
  .max(512)
  .refine((v) => !v.startsWith("-") && !v.includes(".."), {
    message: "Invalid repo-relative path",
  });

// Author filter for git log --author=<pattern>. Rejects leading '-' to keep
// the value from being interpreted as a flag once it lands in execFile argv.
const safeAuthorPattern = z
  .string()
  .max(128)
  .refine((v) => !v.startsWith("-"), { message: "Author cannot start with '-'" });

export const gitLogGraphSchema = z.object({
  workspaceId: nonEmptyString,
  rootPath: z.string().optional(),
  limit: z.number().int().min(1).max(2000).optional(),
  includeRemotes: z.boolean().optional(),
  branch: safeGitRef.optional(),
  sinceDate: safeDateExpr.optional(),
  untilDate: safeDateExpr.optional(),
  paths: z.array(safeRepoPath).max(32).optional(),
  topoOrder: z.boolean().optional(),
  author: safeAuthorPattern.optional(),
});
export type GitLogGraph = z.infer<typeof gitLogGraphSchema>;

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

export const terminalSessionSchema = z.object({
  sessionId: nonEmptyString,
});
export type TerminalSession = z.infer<typeof terminalSessionSchema>;

export const profileSchema = z
  .object({
    id: z.string().optional(),
    name: z.string(),
    sidebarWorkspaceViewMode: z.enum(["tree", "recent"]).optional(),
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

/**
 * Filters for the permission auto-approval log. Same shape as the provider
 * audit-log queries — the underlying store is the same factory.
 */
export const approvalAuditLogQuerySchema = z.object({
  from: z.string().optional(),
  to: z.string().optional(),
  /**
   * Exclusive keyset cursors on the row id — the column the store orders by.
   * The Notification Center back-fill pages with these because a timestamp
   * window cannot page an `id DESC` ordering losslessly (see `AuditLogFilters`).
   */
  afterId: z.number().int().positive().optional(),
  beforeId: z.number().int().positive().optional(),
  search: z.string().optional(),
  limit: z.number().int().positive().optional(),
  offset: z.number().int().min(0).optional(),
  /**
   * Scope the trail to one profile. Desktop IPC only — a remote caller's scope
   * comes from the SERVER's view of its bound session (see
   * `approvalAuditLogFilters` in remote-server.ts), never from the request, so
   * accepting the field here cannot widen anyone's reach.
   */
  profileId: z.string().optional(),
});
export type ApprovalAuditLogQuery = z.infer<typeof approvalAuditLogQuerySchema>;

/**
 * Rows the user asked to forget, from the Approvals tab in the notification
 * dock. Either an explicit `ids` list or `all: true` — see `deleteEntries`
 * in base-audit-log-store.ts for why there is no "delete what matches".
 *
 * Desktop IPC only. The remote server exposes no delete route: reading the
 * trail from a phone is fine, erasing the record of a bypass that ran on the
 * desktop is not — same reasoning as `autoApprovePermissions` itself, which
 * a remote caller may not arm.
 */
export const approvalAuditLogDeleteSchema = z
  .object({
    ids: z.array(z.number().int().positive()).max(500).optional(),
    all: z.boolean().optional(),
    /** Scope the clear to one profile. Omitted means the whole installation. */
    profileId: z.string().optional(),
  })
  .refine((value) => (value.ids?.length ?? 0) > 0 || value.all === true, {
    message: "approvals:audit-log:delete requires a non-empty ids list or all: true",
  });
export type ApprovalAuditLogDelete = z.infer<typeof approvalAuditLogDeleteSchema>;

export const approvalAuditLogStatsSchema = z.object({
  from: z.string().optional(),
});
export type ApprovalAuditLogStats = z.infer<typeof approvalAuditLogStatsSchema>;

export const githubConnectionSchema = z
  .object({
    hostUrl: z.string().optional(),
    pat: z.string().optional(),
    /** Owning profile — validated against the caller viewer's profile in saveGitHubConnection. */
    profileId: z.string().optional(),
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
    notificationsEnabled: z.boolean().optional(),
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

export const taskResendInstructionSchema = z.object({
  workspaceId: nonEmptyString,
  role: z.enum(["worker", "judge"]),
});
export type TaskResendInstruction = z.infer<typeof taskResendInstructionSchema>;

export const taskUpdateDescriptionSchema = z.object({
  workspaceId: nonEmptyString,
  description: z.string().max(TASK_BRIEF_MAX_CHARS),
});
export type TaskUpdateDescription = z.infer<typeof taskUpdateDescriptionSchema>;

export const taskRecoveryResolveSchema = z.object({
  decisions: z.record(z.string(), z.enum(["continue", "fresh", "skip"])),
});
export type TaskRecoveryResolve = z.infer<typeof taskRecoveryResolveSchema>;

// ---------------------------------------------------------------------------
// Attached mode (Companion loop) — plan §7. Separate create channel: the
// authoritative source workspace/panel/cwd/parent/profile are ALWAYS derived
// server-side from `sourceSessionId`, never accepted from the client.
// ---------------------------------------------------------------------------

export const taskCompanionCreateSchema = z.object({
  sourceSessionId: nonEmptyString,
  // Informational only — timeout/prompt-injection-style hint for the
  // existing Primary session. Never used to change its command/model/env.
  primaryProvider: providerConfigSchema.optional(),
  companionRole: z.enum(["reviewer", "planner", "consultant", "critic"]),
  companionProvider: providerConfigSchema,
  // Full CLI command, replacing the one built from companionProvider — the
  // same escape hatch a standard task's worker/judge already has.
  companionCommand: z.string().max(500).optional(),
  focus: z.string().max(5000).optional().default(""),
  maxRounds: z.number().int().min(1).max(100).optional(),
  // Skip the "Brief ready" confirmation and start the baseline evaluation as
  // soon as the capture validates. Absent means the manual gate is kept.
  autoStartAfterCapture: z.boolean().optional(),
});
export type TaskCompanionCreate = z.infer<typeof taskCompanionCreateSchema>;

export const taskCompanionAnswerSchema = z.object({
  workspaceId: nonEmptyString,
  questionIds: z
    .array(z.string().regex(/^Q-[0-9]+$/))
    .min(1)
    .max(5),
  answer: z.string().min(1).max(5000),
});
export type TaskCompanionAnswer = z.infer<typeof taskCompanionAnswerSchema>;

export const workspaceReorderSchema = z.array(nonEmptyString);
export type WorkspaceReorder = z.infer<typeof workspaceReorderSchema>;

export const workspaceIdSchema = z.string().min(1);
export type WorkspaceId = z.infer<typeof workspaceIdSchema>;

export const workspaceDeleteOptionsSchema = z
  .object({
    deleteFromDisk: z.boolean().optional(),
    diskPath: z.string().optional(),
  })
  .strict();
export type WorkspaceDeleteOptions = z.infer<typeof workspaceDeleteOptionsSchema>;

export const nativeWorkspaceProfileSchema = z
  .object({
    profileId: z.string().min(1).max(128),
    requestId: z.string().max(128).optional(),
  })
  .strict();
export const nativeWorkspaceDirectoryListSchema = nativeWorkspaceProfileSchema.extend({
  path: z.string().max(4096).optional(),
  query: z.string().max(256).optional(),
  sort: z.enum(["nameAsc", "nameDesc"]).optional(),
});
export const nativeWorkspaceDirectoryCreateSchema = nativeWorkspaceProfileSchema.extend({
  parentPath: z.string().min(1).max(4096),
  name: z.string().min(1).max(128),
});
export const nativeWorkspaceCreateSchema = nativeWorkspaceProfileSchema.extend({
  path: z.string().min(1).max(4096),
  name: z.string().max(120).optional(),
});
export const nativeScratchpadKeepSchema = nativeWorkspaceProfileSchema.extend({
  workspaceId: workspaceIdSchema,
  name: z.string().max(120).optional(),
  parentPath: z.string().max(4096).optional(),
  directoryName: z.string().max(128).optional(),
});
export const nativeScratchpadDiscardSchema = nativeWorkspaceProfileSchema.extend({
  workspaceId: workspaceIdSchema,
  confirmed: z.literal(true),
});

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
  /** Alert session key — dedupes identical OS popups fired by multiple windows of the same profile. */
  dedupeKey: z.string().optional(),
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
  /**
   * Workspace whose UI the viewer typed in. Only ever a HINT — the runtime
   * validates it against the session before crediting the workspace with
   * work, so a crafted value can at worst be ignored. Needed because an
   * attached task's Primary tab is presented in the task workspace while its
   * session id still names the source workspace.
   */
  originWorkspaceId: z.string().optional(),
});
export type WsTerminalInput = z.infer<typeof wsTerminalInputSchema>;

export const wsTerminalResizeSchema = z.object({
  type: z.literal("terminal:resize"),
  sessionId: nonEmptyString,
  cols: z.number().int().positive(),
  rows: z.number().int().positive(),
});
export type WsTerminalResize = z.infer<typeof wsTerminalResizeSchema>;

// The complete set of terminal sessions a remote client currently renders.
// Resending the same set is idempotent; an empty set means "render nothing".
// Bounded generously here; the server applies its own runtime cap as well.
export const wsTerminalSubscribeSchema = z.object({
  type: z.literal("terminal:subscribe"),
  sessionIds: z.array(nonEmptyString).max(256),
});
export type WsTerminalSubscribe = z.infer<typeof wsTerminalSubscribeSchema>;

// The complete set of slim-core DETAIL resources a remote client currently
// renders (git panes, docker pane, provider inbox/review panes across every
// visible grid cell). Analogous to terminal:subscribe: the client sends the
// whole set, the server pushes resource:invalidate for changed/new ones.
export const wsResourceInterestSchema = z.object({
  type: z.literal("resource:interest"),
  resources: z.array(nonEmptyString).max(256),
});
export type WsResourceInterest = z.infer<typeof wsResourceInterestSchema>;

// Client → server over the WS socket: keystrokes/resizes for a docker exec
// shell session. Mirrors wsTerminalInputSchema/wsTerminalResizeSchema above —
// a docker shell is a PTY-like stream just like a regular terminal, and
// write/resize are per-keystroke frequent, so they ride the socket instead of
// an HTTP POST per keystroke. `data`/cols/rows caps match the existing IPC-side
// dockerShellWriteSchema/dockerShellResizeSchema above.
export const wsDockerShellWriteSchema = z.object({
  type: z.literal("docker:shell:write"),
  sessionId: nonEmptyString,
  data: z.string().max(1024 * 1024),
});
export type WsDockerShellWrite = z.infer<typeof wsDockerShellWriteSchema>;

export const wsDockerShellResizeSchema = z.object({
  type: z.literal("docker:shell:resize"),
  sessionId: nonEmptyString,
  cols: z.number().int().positive().max(1000),
  rows: z.number().int().positive().max(1000),
});
export type WsDockerShellResize = z.infer<typeof wsDockerShellResizeSchema>;

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

export const fileGitIgnoreSchema = z.object({
  rootPath: z.string().min(1),
  relativePath: z.string().min(1),
  isDirectory: z.boolean().optional(),
});
export type FileGitIgnore = z.infer<typeof fileGitIgnoreSchema>;

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

const sshAuthSchema = z
  .object({
    methods: z.array(z.enum(["password", "publickey", "keyboard-interactive", "agent"])).min(1),
    keyRef: z.string().optional(),
    certRef: z.string().optional(),
    passwordRef: z.string().optional(),
    passphraseRef: z.string().optional(),
    agent: z.enum(["auto", "socket", "pageant", "pipe", "off"]).nullable().optional(),
  })
  .passthrough();

const sshWslSchema = z
  .object({
    distro: z.string().trim().min(1).nullable().optional(),
    user: z
      .string()
      .trim()
      .regex(/^[A-Za-z_][A-Za-z0-9_.-]*$/)
      .nullable()
      .optional(),
    exec: z
      .string()
      .trim()
      .min(1)
      .refine((value) => !value.startsWith("-") && !/[\0\r\n]/.test(value))
      .optional(),
    importFromWsl: z.boolean().optional(),
  })
  .passthrough();

const sshAdvancedSchema = z
  .object({
    keepaliveIntervalMs: z.number().int().min(0).nullable().optional(),
    keepaliveCountMax: z.number().int().min(0).nullable().optional(),
    compression: z.boolean().nullable().optional(),
    agentForward: z.boolean().optional(),
    env: z.record(z.string(), z.string()).nullable().optional(),
    command: z.string().nullable().optional(),
    sshPath: z.string().nullable().optional(),
    useSystemSsh: z.boolean().optional(),
    launchVia: sshLaunchViaSchema.optional(),
    portOverride: z.boolean().optional(),
    wsl: sshWslSchema.nullable().optional(),
  })
  .passthrough();

export const sshHostCreateSchema = z.object({
  name: z.string().min(1),
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535).optional(),
  username: z.string().optional(),
  auth: sshAuthSchema.optional(),
  jump: z.array(z.string()).optional(),
  hostKeyPolicy: z.enum(["strict", "warn", "accept-new"]).optional(),
  advanced: sshAdvancedSchema.optional(),
  tags: z.array(z.string()).optional(),
});
export type SshHostCreate = z.infer<typeof sshHostCreateSchema>;

export const sshTestStartSchema = z.object({
  profileId: nonEmptyString,
  draft: sshHostCreateSchema.extend({ name: z.string().optional() }),
});
export type SshTestStart = z.infer<typeof sshTestStartSchema>;

export const sshTestStopSchema = z.object({ sessionId: nonEmptyString });
export type SshTestStop = z.infer<typeof sshTestStopSchema>;

const sshHostPatchSchema = z
  .object({
    name: z.string().min(1).optional(),
    host: z.string().min(1).optional(),
    port: z.number().int().min(1).max(65535).nullable().optional(),
    username: z.string().nullable().optional(),
    auth: sshAuthSchema.partial().optional(),
    jump: z.array(z.string()).optional(),
    hostKeyPolicy: z.enum(["strict", "warn", "accept-new"]).nullable().optional(),
    advanced: sshAdvancedSchema.partial().nullable().optional(),
    tags: z.array(z.string()).optional(),
  })
  .passthrough();

export const sshHostUpdateSchema = z.object({
  id: z.string().min(1),
  patch: sshHostPatchSchema,
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
export const sshKeyRenameSchema = z.object({
  id: nonEmptyString,
  label: z.string().min(1).max(60),
});
export type SshKeyRename = z.infer<typeof sshKeyRenameSchema>;
export const sshKeyTransferStartSchema = z
  .object({
    profileId: nonEmptyString,
    hostId: nonEmptyString.optional(),
    draft: sshHostCreateSchema.extend({ name: z.string().optional() }).optional(),
    keyId: nonEmptyString,
  })
  .refine((value) => Boolean(value.hostId) !== Boolean(value.draft), {
    message: "Provide exactly one saved host ID or host draft.",
    path: ["hostId"],
  });
export type SshKeyTransferStart = z.infer<typeof sshKeyTransferStartSchema>;
export const sshKeyTransferStopSchema = z.object({ operationId: nonEmptyString });
export type SshKeyTransferStop = z.infer<typeof sshKeyTransferStopSchema>;
export const sshKeyGenerateSchema = z.object({
  kind: z.enum(["ed25519", "ecdsa", "rsa"]),
  bits: z.number().int().optional(),
  comment: z.string().default(""),
  passphrase: z.string().optional(),
});
export type SshKeyGenerate = z.infer<typeof sshKeyGenerateSchema>;

export const sshKeyDeleteSchema = z.object({ id: z.string().min(1) });
export const sshCertDeleteSchema = z.object({ id: z.string().min(1) });

export const sshCertImportSchema = z.object({
  keyId: z.string(),
  certificate: z.string().min(1),
});
export type SshCertImport = z.infer<typeof sshCertImportSchema>;

export const sshAuthAnswerSchema = z.object({
  sessionId: z.string(),
  answers: z.array(z.string()),
  // Generation token echoed from the prompt so a stale dialog's answer is not
  // applied to a newer connection that reused the sessionId. Mandatory: every
  // prompt carries a promptId, so a request without one can only be a stale or
  // spoofed client trying to hit the current prompt by sessionId alone.
  promptId: z.string(),
});
export type SshAuthAnswer = z.infer<typeof sshAuthAnswerSchema>;

export const sshAcceptHostKeySchema = z.object({
  sessionId: z.string(),
  mode: z.enum(["once", "permanent"]),
  // Mandatory generation token — see sshAuthAnswerSchema. Accepting a host key
  // for a superseded generation could pin a different server's key to the new
  // connection, so a request without a promptId is rejected at the boundary.
  promptId: z.string(),
});
export type SshAcceptHostKey = z.infer<typeof sshAcceptHostKeySchema>;

export const sshAuthCancelSchema = z.object({
  sessionId: z.string(),
  // Mandatory generation token — see sshAuthAnswerSchema. Cancelling by
  // sessionId alone would let a stale/spoofed client dismiss the CURRENT
  // prompt of a newer connection that reused the id, so the token is required
  // at the boundary and re-checked unconditionally in the manager.
  promptId: z.string(),
});
export type SshAuthCancel = z.infer<typeof sshAuthCancelSchema>;

export const sshRejectHostKeySchema = z.object({
  sessionId: z.string(),
  // Mandatory generation token — see sshAcceptHostKeySchema. Rejecting the
  // wrong generation would abort a newer connection's host-key decision, so a
  // request without a promptId is rejected at the boundary.
  promptId: z.string(),
});
export type SshRejectHostKey = z.infer<typeof sshRejectHostKeySchema>;

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
export const attachmentWorkspaceSchema = z.object({ workspaceId: workspaceIdSchema });
export const attachmentWorkspaceDeleteSchema = attachmentWorkspaceSchema.extend({
  transferId: z.string().uuid(),
  name: z.string().min(1),
});

// ----------------------------------------

/**
 * The grants the pairing dialog may hand out.
 *
 * A closed enum, not `z.string()`: these values become the device's `capabilities`, and the
 * desktop's COMMAND_POLICY table decides which one each command type requires. A free-form string
 * here could only ever be a grant that matches nothing — which reads on screen as "this device may
 * do X" while denying every X (review 2 §P0.3). It is duplicated from `MobileCapability` in
 * shared/types/state.ts rather than derived, because zod needs a value and that is a type; the two
 * are pinned together by `ipc-schemas.test.ts`.
 */
export const mobileCapabilitySchema = z.enum([
  "notifications",
  "status.read",
  "task.control",
  "task.destructive",
  "remote.request",
  "remote.webSession",
]);

/** `mobile:pairing:create` payload (plan §5.2/§10.5) — the allowlist/capabilities the user picks in the "Pair device" dialog. */
export const mobileCreatePairingInvitationSchema = z.object({
  profileAllowlist: z.array(nonEmptyString).min(1),
  capabilities: z.array(mobileCapabilitySchema).min(1),
});
export type MobileCreatePairingInvitation = z.infer<typeof mobileCreatePairingInvitationSchema>;

/** `mobile:device:rename` payload — desktop-local display label only. */
export const mobileRenameDeviceSchema = z.object({
  deviceId: nonEmptyString,
  label: z.string().min(1).max(60),
});
export type MobileRenameDevice = z.infer<typeof mobileRenameDeviceSchema>;

/**
 * `mobile:device:reject` payload (review 3 §P0.1).
 *
 * The reason is a closed enum, not free text: it is written to the durable audit log and shown to a
 * human during an incident, so a renderer must not be able to put arbitrary strings there.
 */
export const mobileRejectDeviceSchema = z.object({
  deviceId: nonEmptyString,
  reason: z.enum(["sas-mismatch", "dialog-dismissed", "key-proof-failed", "grant-mismatch", "timeout"]),
});
export type MobileRejectDevice = z.infer<typeof mobileRejectDeviceSchema>;

/** `mobile:device:update-allowlist` payload (plan §10.5 "update device capabilities/profile allowlist"). */
export const mobileUpdateDeviceAllowlistSchema = z.object({
  deviceId: nonEmptyString,
  capabilities: z.array(mobileCapabilitySchema).optional(),
  profileAllowlist: z.array(nonEmptyString).optional(),
  excludedProfileIds: z.array(nonEmptyString).optional(),
});
export type MobileUpdateDeviceAllowlist = z.infer<typeof mobileUpdateDeviceAllowlistSchema>;

/** `mobile:audit-log:query` payload — mirrors azureAuditLogQuerySchema's shape, scoped to MobileAuditLogFilters' fields. */
export const mobileAuditLogQuerySchema = z.object({
  from: z.string().optional(),
  to: z.string().optional(),
  deviceId: z.string().optional(),
  action: z.string().optional(),
  status: z.enum(["success", "failure"]).optional(),
  limit: z.number().int().positive().optional(),
  offset: z.number().int().min(0).optional(),
});
export type MobileAuditLogQuery = z.infer<typeof mobileAuditLogQuerySchema>;

// ----------------------------------------

/**
 * Body of the unauthenticated `POST /api/mobile/session/bootstrap` route
 * (remote-server.ts, plan §9.2/§10.6). The ticket IS the auth — no session
 * cookie or master token is required to call this route — so both fields
 * are validated as plain non-empty strings; the actual device/pair/profile
 * identity is read from the consumed ticket record, never trusted from here.
 */
export const mobileSessionBootstrapSchema = z.object({
  ticketId: nonEmptyString,
  secret: nonEmptyString,
});
export const mobileAttachmentEnvelopeSchema = z.object({
  version: z.literal(1),
  requestId: z.string().uuid(),
  pairId: z.string().min(1).max(256),
  sourceDeviceId: z.string().min(1).max(256),
  targetDeviceId: z.string().min(1).max(256),
  sessionKeyVersion: z.number().int().positive(),
  issuedAt: z.number().int().nonnegative(),
  expiresAt: z.number().int().nonnegative(),
  nonce: z.string().min(16).max(32),
  ciphertext: z
    .string()
    .min(22)
    .max(8 * 1024 * 1024),
});
const attachmentOperationTimes = {
  issuedAt: z.number().int().nonnegative(),
  expiresAt: z.number().int().nonnegative(),
};
const attachmentWorkspacePayload = { workspaceId: workspaceIdSchema };
const attachmentTransferPayload = { ...attachmentWorkspacePayload, transferId: z.string().uuid() };
const attachmentB64Url = z
  .string()
  .min(1)
  .max(1024 * 1024 * 2)
  .regex(/^[A-Za-z0-9_-]+={0,2}$/);
export const mobileAttachmentOperationSchema = z.discriminatedUnion("operation", [
  z
    .object({
      operation: z.literal("attachment.begin"),
      payload: z
        .object({
          ...attachmentWorkspacePayload,
          name: z.string().min(1).max(180),
          size: z
            .number()
            .int()
            .min(0)
            .max(25 * 1024 * 1024),
          sha256: z.string().regex(/^[a-f0-9]{64}$/),
          idempotencyKey: z.string().min(1).max(256).optional(),
        })
        .strict(),
      ...attachmentOperationTimes,
    })
    .strict(),
  z
    .object({
      operation: z.literal("attachment.chunk"),
      payload: z
        .object({ ...attachmentTransferPayload, offset: z.number().int().nonnegative(), data: attachmentB64Url })
        .strict(),
      ...attachmentOperationTimes,
    })
    .strict(),
  z
    .object({
      operation: z.literal("attachment.status"),
      payload: z.object(attachmentTransferPayload).strict(),
      ...attachmentOperationTimes,
    })
    .strict(),
  z
    .object({
      operation: z.literal("attachment.finish"),
      payload: z
        .object({
          ...attachmentTransferPayload,
          sha256: z
            .string()
            .regex(/^[a-f0-9]{64}$/)
            .optional(),
        })
        .strict(),
      ...attachmentOperationTimes,
    })
    .strict(),
  z
    .object({
      operation: z.literal("attachment.cancel"),
      payload: z.object(attachmentTransferPayload).strict(),
      ...attachmentOperationTimes,
    })
    .strict(),
  z
    .object({
      operation: z.literal("attachment.list"),
      payload: z.object(attachmentWorkspacePayload).strict(),
      ...attachmentOperationTimes,
    })
    .strict(),
  z
    .object({
      operation: z.literal("attachment.delete"),
      payload: z
        .object({ ...attachmentWorkspacePayload, transferId: z.string().uuid(), name: z.string().min(1) })
        .strict(),
      ...attachmentOperationTimes,
    })
    .strict(),
]);
export type MobileSessionBootstrap = z.infer<typeof mobileSessionBootstrapSchema>;

// ----------------------------------------
//
// ACCOUNT (plan §8.2, and the passwordless revision's §8 Fáze 3). Every one of these is
// DESKTOP-ONLY, including for the remote web renderer: `remote-server.ts` routes none of them and
// `src/transport.test.ts` lists them in `KNOWN_DESKTOP_ONLY_METHODS`. Signing in, paying and revoking
// are acts that belong at the machine whose consequences they land on.
//
// THERE IS NO PASSWORD FIELD ANY MORE, anywhere in this stack. What replaced it is an address and,
// for the manual fallback, the text of a sign-in link — and the link is the one payload here that
// carries a live credential, which is why it has its own schema, its own bound, and an explicit
// redaction test in `logger-redaction.test.ts`.
//
// NOTHING LOGS AN IPC PAYLOAD. `withOperationPromise` carries an `opId` and no arguments, and
// `validateIpc` names the CHANNEL rather than echoing what failed to parse — which matters most
// exactly here, because a link that failed validation is still a link (plan §8, Fáze 3: "Auth IPC
// nesmí logovat celý payload, ani když Zod validace selže").

const accountEmail = z.string().min(3).max(320);

export const accountEmailSchema = z.object({ email: accountEmail });
export type AccountEmail = z.infer<typeof accountEmailSchema>;

/**
 * `account:sign-in:start` — one address, one pinned purpose, and the operand of the one purpose that
 * has one.
 *
 * THE PURPOSE IS AN ENUM AND NOT FREE TEXT: it decides what happens once an identity is proved, and
 * the renderer names which of a closed set it wants rather than describing an action.
 */
export const accountSignInStartSchema = z
  .object({
    email: accountEmail,
    purpose: z.enum([
      "enrol",
      "enrol-with-trial",
      // The TRIAL ALONE, on a machine that is already registered — the resume of a half-finished
      // onboarding (follow-up F06). It is a purpose rather than a flag because it decides what
      // happens after the identity is proved, exactly like the others.
      "trial",
      "recover-uid",
      "reauth",
      "checkout",
      "portal",
      "change-email",
      "delete-account",
      // A revocation whose local recent-auth window had already lapsed (plan §7/C2). Carries the
      // packed revoke target the same way `checkout` carries an offer id — see `account-manager.ts`'s
      // `decodeRevokeTarget` and `SettingsAccountTab.vue`'s `revokeOrReauth`.
      "revoke-device",
    ]),
    offerId: z.string().min(1).max(128).optional(),
    // STRICT, so a field this channel does not have is a refusal rather than a silently dropped one.
    // Zod's default is to strip, which would let two builds of the renderer disagree about what a
    // request said while both were accepted.
  })
  .strict();
export type AccountSignInStart = z.infer<typeof accountSignInStartSchema>;

const bootstrapErrorOutputSchema = z
  .object({
    stage: z.enum(["fetch", "verify", "persist"]),
    category: z.enum([
      "dns",
      "timeout",
      "connection-refused",
      "connection-reset",
      "tls",
      "http",
      "redirect",
      "invalid-response",
      "verification",
      "not-configured",
      "storage",
      "network",
      "cancelled",
    ]),
    code: z.string().max(64).optional(),
    status: z.number().int().min(100).max(599).optional(),
    url: z.string().max(2048).optional(),
    retryAfterMs: z.number().finite().min(0).max(3_600_000).optional(),
    refusal: z
      .enum([
        "unsupported-version",
        "unknown-key",
        "bad-signature",
        "wrong-environment",
        "epoch-not-newer",
        "not-yet-valid",
        "insecure-endpoint",
        "malformed",
        "not-configured",
      ])
      .optional(),
    message: z.string().min(1).max(500),
  })
  .strict();

export const onlineBootstrapStateOutputSchema = z.discriminatedUnion("phase", [
  z.object({ phase: z.literal("idle") }).strict(),
  z
    .object({
      phase: z.literal("downloading"),
      purpose: z.enum(["sign-in", "refresh"]),
      url: z.string().max(2048),
    })
    .strict(),
  z
    .object({
      phase: z.literal("failed"),
      purpose: z.enum(["sign-in", "refresh"]),
      url: z.string().max(2048),
      error: bootstrapErrorOutputSchema,
      retryAt: z.number().finite().nonnegative().optional(),
    })
    .strict(),
  z
    .object({
      phase: z.literal("cache-warning"),
      purpose: z.enum(["sign-in", "refresh"]),
      url: z.string().max(2048),
      error: bootstrapErrorOutputSchema,
      retryAt: z.number().finite().nonnegative().optional(),
    })
    .strict(),
]);

/**
 * Validates the new dynamic bootstrap substate while preserving the account DTO's existing fields.
 * If a future or malformed bootstrap field is present, omit that field so the rest of Account stays
 * usable; never forward unchecked server or network text to a renderer.
 */
export function sanitizeAccountUiStateOutput(value: unknown): AccountUiState {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid account state output");
  }
  const state = value as Record<string, unknown>;
  if (state.onlineBootstrap === undefined) return state as unknown as AccountUiState;
  const onlineBootstrap = onlineBootstrapStateOutputSchema.safeParse(state.onlineBootstrap);
  if (onlineBootstrap.success) return { ...state, onlineBootstrap: onlineBootstrap.data } as unknown as AccountUiState;
  const { onlineBootstrap: _invalidBootstrapState, ...safeState } = state;
  return safeState as unknown as AccountUiState;
}

/**
 * `account:sign-in:link` — the whole link, pasted out of a mail client.
 *
 * The ONE payload in this file that carries a live credential. It is bounded before anything parses
 * it, it reaches exactly one backend method, and it is never broadcast, stored or logged. The parser
 * that reads it (`authlink-config.ts`) never fetches the URL it was given.
 */
export const accountSignInLinkSchema = z.object({ link: z.string().min(1).max(4096) }).strict();
export type AccountSignInLink = z.infer<typeof accountSignInLinkSchema>;

/**
 * `account:enrol` — `recover-uid` is the same-key re-enrolment after a lost installation token.
 *
 * The value is spelled EXACTLY as the generated server contract spells it. It used to be `recover`
 * all the way down this stack, and the server's `InstallationRegistrationRequestSchema` accepts only
 * `register` or `recover-uid` — so the one path that exists for a desktop that lost its refresh token
 * was refused as a malformed request against a correct backend.
 */
export const accountEnrolSchema = z.object({
  mode: z.enum(["register", "recover-uid"]).default("register"),
  /**
   * Pair ids this desktop already knows about, as LOCATOR HINTS only.
   *
   * The server re-reads each pair's `publicMeta` and accepts one only when its recorded desktop uid
   * is the challenge's own; a client-supplied id is never authority. Bounded, because an unbounded
   * hint list is an unbounded read somebody else pays for.
   */
  pairHints: z.array(nonEmptyString).max(32).optional(),
});
export type AccountEnrol = z.infer<typeof accountEnrolSchema>;

/** `account:recovery-refused:dismiss` — what the owner chose after a restore was refused. */
export const accountRecoveryAnswerSchema = z.object({ answer: z.enum(["register", "back"]) }).strict();
export type AccountRecoveryAnswer = z.infer<typeof accountRecoveryAnswerSchema>;

/** `account:checkout` — an opaque catalog offer id, never a provider price. */
export const accountCheckoutSchema = z.object({ offerId: nonEmptyString });
export type AccountCheckout = z.infer<typeof accountCheckoutSchema>;

/** `account:checkout:copy` — identifies which offer to copy; the URL never crosses IPC. */
export const accountCheckoutCopySchema = z.object({ offerId: nonEmptyString });

export const accountRevokeSchema = z.object({
  kind: z.enum(["installation", "mobile-device", "pair", "account-wide"]),
  targetId: nonEmptyString.optional(),
});
export type AccountRevoke = z.infer<typeof accountRevokeSchema>;

export const accountNoticeAckSchema = z.object({ noticeId: nonEmptyString });
export type AccountNoticeAck = z.infer<typeof accountNoticeAckSchema>;

/**
 * `account:sign-out` — `disconnect` is the deliberate second act.
 *
 * Sign-out is an online revocation: while this machine still has pairings or a live relay session
 * the UI offers "cancel" or "disconnect this installation", and only the second one proceeds. A
 * boolean the renderer must set explicitly is what stops a stray click disconnecting somebody's
 * phones.
 */
export const accountSignOutSchema = z.object({ disconnect: z.boolean() });
export type AccountSignOut = z.infer<typeof accountSignOutSchema>;

/**
 * `account:diagnostics:submit` / `account:diagnostics:export` — the note, and nothing else.
 *
 * The REPORT is not a payload: it is assembled in the main process from this installation's own
 * bounded log. A renderer that could hand over the entries would be a renderer that could put
 * anything in a document destined for the control plane, which is the opposite of what a redacted,
 * closed-vocabulary log is for. The note is the one thing the user actually wrote, bounded to the
 * same length the server keeps.
 */
export const accountDiagnosticsSchema = z.object({ note: z.string().max(500).optional() });
export type AccountDiagnostics = z.infer<typeof accountDiagnosticsSchema>;

/** `account:delete` — the phrase is compared server-side; nothing here is a confirmation on its own. */
export const accountDeleteSchema = z.object({ confirmationPhrase: z.string().min(1).max(64) });
export type AccountDelete = z.infer<typeof accountDeleteSchema>;

// ----------------------------------------

export function validateIpc<T extends z.ZodTypeAny>(schema: T, payload: unknown, channel: string): z.infer<T> {
  const result = schema.safeParse(payload);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`IPC validation failed on '${channel}': ${issues}`);
  }
  return result.data as z.infer<T>;
}
