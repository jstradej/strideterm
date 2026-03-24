import { z } from "zod";

/**
 * Zod schemas for IPC payload validation.
 * Only covers handlers that accept complex objects from the renderer.
 */

const nonEmptyString = z.string().min(1);

export const workspaceSchema = z.object({
  id: nonEmptyString,
  name: z.string(),
  cwd: z.string().optional(),
  kind: z.string().optional(),
  panels: z.array(z.object({
    id: nonEmptyString,
    title: z.string(),
    command: z.string().optional(),
    shell: z.boolean().optional(),
    startup: z.string().optional(),
  })).optional(),
}).passthrough();

export const projectSchema = workspaceSchema;

export const settingsSchema = z.object({}).passthrough();

export const azureConnectionSchema = z.object({
  organization: z.string().optional(),
  project: z.string().optional(),
  pat: z.string().optional(),
}).passthrough();

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

export const reviewBridgeDraftSchema = z.object({
  prKey: nonEmptyString,
}).passthrough();

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

export const reviewBridgeReplyWithChangesSchema = z.object({
  prKey: nonEmptyString,
}).passthrough();

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

export const gitPayloadSchema = z.object({
  workspaceId: nonEmptyString,
}).passthrough();

export const gitDiffPreviewSchema = z.object({
  workspaceId: nonEmptyString,
  path: nonEmptyString,
  scope: z.string().optional(),
  baseBranch: z.string().optional(),
});

export const gitCommitSchema = z.object({
  workspaceId: nonEmptyString,
  message: z.string().optional(),
}).passthrough();

export const dockerActionSchema = z.object({
  action: nonEmptyString,
  containerId: nonEmptyString,
});

export const dockerSessionSchema = z.object({
  workspaceId: nonEmptyString,
  containerId: z.string().optional(),
  mode: z.string().optional(),
}).passthrough();

export const terminalResizeSchema = z.object({
  cols: z.number().int().positive(),
  rows: z.number().int().positive(),
});

export const profileSchema = z.object({
  id: z.string().optional(),
  name: z.string(),
}).passthrough();

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
