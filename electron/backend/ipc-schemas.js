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

export const workspaceSchema = z
  .object({
    id: nonEmptyString,
    name: z.string(),
    cwd: z.string().optional(),
    kind: z.string().optional(),
    panels: z
      .array(
        z.object({
          id: nonEmptyString,
          title: z.string(),
          command: z.string().optional(),
          shell: z.boolean().optional(),
          startup: z.string().optional(),
        }),
      )
      .optional(),
  })
  .passthrough();

export const projectSchema = workspaceSchema;

export const workspaceUIStateSchema = z.object({
  workspaceId: nonEmptyString,
  uiState: z.object({
    activeViewId: z.string().optional(),
    splitLayout: z.enum(["cols", "rows", "top-split"]).nullable().optional(),
    splitViewIds: z.array(z.string()).optional(),
  }),
});

export const settingsSchema = z.object({}).passthrough();

export const azureConnectionSchema = z
  .object({
    organization: z.string().optional(),
    project: z.string().optional(),
    pat: z.string().optional(),
  })
  .passthrough();

export const prKeySchema = nonEmptyString;

export const azureCommentSchema = z.object({
  prKey: nonEmptyString,
  content: z.string(),
  threadId: z.number().nullable().optional(),
  parentCommentId: z.number().optional(),
});

export const azureVoteSchema = z.object({
  prKey: nonEmptyString,
  vote: z.number(),
});

export const azureThreadStatusSchema = z.object({
  prKey: nonEmptyString,
  threadId: z.number(),
  status: z.enum(["active", "fixed", "closed", "wontFix", "pending", "byDesign"]),
});

export const openPrSchema = z.object({
  prKey: nonEmptyString,
  workspaceId: z.string().optional(),
});

export const reviewBridgeDraftSchema = z
  .object({
    prKey: nonEmptyString,
  })
  .passthrough();

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

export const reviewBridgeQueueSchema = z.object({
  prKey: nonEmptyString,
  draftId: nonEmptyString,
});

export const reviewBridgeDeleteDraftSchema = reviewBridgeQueueSchema;

export const reviewBridgeDeleteCommentSchema = z.object({
  prKey: nonEmptyString,
  commentKey: nonEmptyString,
});

export const reviewBridgeReplyWithChangesSchema = z
  .object({
    prKey: nonEmptyString,
  })
  .passthrough();

export const reviewBridgeSyncSchema = z.object({
  prKey: nonEmptyString,
});

export const reviewBridgePushAndPublishSchema = z.object({
  workspaceId: nonEmptyString,
});

export const agentPromptSaveSchema = z.object({}).passthrough();

export const agentPromptDeleteSchema = z.object({
  promptId: nonEmptyString,
});

export const gitPayloadSchema = z
  .object({
    workspaceId: nonEmptyString,
    baseBranch: safeGitRef.optional(),
  })
  .passthrough();

export const gitDiffPreviewSchema = z.object({
  workspaceId: nonEmptyString,
  path: nonEmptyString,
  scope: z.string().optional(),
  baseBranch: safeGitRef.optional(),
});

export const gitCommitSchema = z
  .object({
    workspaceId: nonEmptyString,
    message: z.string().optional(),
  })
  .passthrough();

export const gitTagSchema = z.object({
  workspaceId: nonEmptyString,
  tagName: nonEmptyString,
  message: z.string().optional(),
  commit: safeGitRef.optional(),
});

export const dockerActionSchema = z.object({
  action: nonEmptyString,
  containerId: nonEmptyString,
});

export const dockerSessionSchema = z
  .object({
    workspaceId: nonEmptyString,
    containerId: z.string().optional(),
    mode: z.string().optional(),
  })
  .passthrough();

export const terminalResizeSchema = z.object({
  cols: z.number().int().positive(),
  rows: z.number().int().positive(),
});

export const profileSchema = z
  .object({
    id: z.string().optional(),
    name: z.string(),
  })
  .passthrough();

export const worktreeSchema = z.object({
  workspaceId: nonEmptyString,
  name: nonEmptyString,
});

export const removeWorktreeSchema = z.object({
  workspaceId: nonEmptyString,
  worktreePath: nonEmptyString,
  deleteBranch: z.boolean().optional(),
});

export const quickFixListProjectsSchema = z.object({
  connectionId: nonEmptyString,
});

export const quickFixListRepositoriesSchema = z.object({
  connectionId: nonEmptyString,
  projectName: nonEmptyString,
});

export const quickFixListBranchesSchema = z.object({
  connectionId: nonEmptyString,
  projectName: nonEmptyString,
  repositoryId: nonEmptyString,
});

export const quickFixCreateSchema = z.object({
  connectionId: nonEmptyString,
  projectName: nonEmptyString,
  repositoryId: nonEmptyString,
  repositoryName: nonEmptyString,
  remoteUrl: nonEmptyString,
  baseBranch: nonEmptyString,
  newBranchName: nonEmptyString,
});

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

export const azureAuditLogStatsSchema = z.object({
  from: z.string().optional(),
  connectionId: z.string().optional(),
});

// --- GitHub schemas ---

export const githubConnectionSchema = z
  .object({
    hostUrl: z.string().optional(),
    pat: z.string().optional(),
  })
  .passthrough();

export const githubCommentSchema = z.object({
  prKey: nonEmptyString,
  body: z.string().min(1),
});

export const githubReviewSchema = z.object({
  prKey: nonEmptyString,
  event: z.enum(["APPROVE", "REQUEST_CHANGES", "COMMENT"]),
  body: z.string().optional(),
});

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

export const githubAuditLogStatsSchema = z.object({
  from: z.string().optional(),
  connectionId: z.string().optional(),
});

export const githubQuickFixListReposSchema = z.object({
  connectionId: nonEmptyString,
});

export const githubQuickFixListBranchesSchema = z.object({
  connectionId: nonEmptyString,
  owner: nonEmptyString,
  repo: nonEmptyString,
});

export const githubQuickFixCreateSchema = z.object({
  connectionId: nonEmptyString,
  owner: nonEmptyString,
  repo: nonEmptyString,
  remoteUrl: nonEmptyString,
  baseBranch: nonEmptyString,
  newBranchName: nonEmptyString,
});

// --- Task runner schemas ---

export const providerConfigSchema = z.object({
  providerId: z.enum(["claude", "codex", "gemini", "copilot"]),
  model: z.string().max(100),
  skipPermissions: z.boolean().optional(),
  extra: z.record(z.unknown()).optional(),
});

export const taskWorkspaceCreateSchema = z.object({
  cwd: nonEmptyString,
  description: z.string().optional().default(""),
  parentWorkspaceId: z.string().optional(),
  maxRounds: z.number().int().min(1).max(100).optional(),
  useWorktree: z.boolean().optional(),
  worktreeBranch: z.string().optional(),
  name: z.string().max(60).optional(),
  icon: z.string().max(4).optional(),
  color: z.string().max(20).optional(),
  notes: z.string().max(500).optional(),
  workerCommand: z.string().max(500).optional(),
  judgeCommand: z.string().max(500).optional(),
  workerProvider: providerConfigSchema.optional(),
  judgeProvider: providerConfigSchema.optional(),
});

export const taskWorkspaceActionSchema = z.object({
  workspaceId: nonEmptyString,
});

export const taskRejectVerdictSchema = z.object({
  workspaceId: nonEmptyString,
  feedback: z.string().min(1).max(5000),
});

// --- Misc schemas ---

export const workspaceReorderSchema = z.array(nonEmptyString);

export const attentionSyncSchema = z.object({
  visibleSessionIds: z.array(z.string()).optional(),
  windowFocused: z.boolean().optional(),
});

export const notificationShowSchema = z.object({
  title: z.string().optional(),
  body: z.string().optional(),
  urgency: z.enum(["normal", "urgent"]).optional(),
  requireInteraction: z.boolean().optional(),
});

export const workspacePushOptionsSchema = z.object({
  force: z.boolean().optional(),
});

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

export const wsTerminalInputSchema = z.object({
  type: z.literal("terminal:input"),
  sessionId: nonEmptyString,
  data: z.string(),
});

export const wsTerminalResizeSchema = z.object({
  type: z.literal("terminal:resize"),
  sessionId: nonEmptyString,
  cols: z.number().int().positive(),
  rows: z.number().int().positive(),
});

// --- File manager schemas ---

export const fileListSchema = z.object({
  rootPath: z.string().min(1),
  relativePath: z.string(),
});

export const fileReadSchema = z.object({
  rootPath: z.string().min(1),
  relativePath: z.string().min(1),
});

export const fileWriteSchema = z.object({
  rootPath: z.string().min(1),
  relativePath: z.string().min(1),
  content: z.string(),
});

export const fileCreateSchema = z.object({
  rootPath: z.string().min(1),
  parentPath: z.string(),
  name: z.string().min(1),
});

export const fileRenameSchema = z.object({
  rootPath: z.string().min(1),
  relativePath: z.string().min(1),
  newName: z.string().min(1),
});

export const fileDeleteSchema = z.object({
  rootPath: z.string().min(1),
  relativePath: z.string().min(1),
});

export const fileMoveSchema = z.object({
  rootPath: z.string().min(1),
  fromPath: z.string().min(1),
  toPath: z.string().min(1),
});

/**
 * Validate an IPC payload against a Zod schema.
 * Returns { ok: true, data } or throws with a descriptive message.
 */
export function validateIpc(schema, payload, channel) {
  const result = schema.safeParse(payload);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`IPC validation failed on '${channel}': ${issues}`);
  }
  return result.data;
}
