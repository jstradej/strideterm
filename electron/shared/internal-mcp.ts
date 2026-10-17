import { z } from "zod";
import { PROVIDER_CHOICES } from "./agent-provider-catalog.js";

export const INTERNAL_MCP_URL_ENV = "STRIDETERM_INTERNAL_MCP_URL";
export const INTERNAL_MCP_CAPABILITY_ENV = "STRIDETERM_INTERNAL_MCP_CAPABILITY";
export const INTERNAL_MCP_ENV_PREFIX = "STRIDETERM_INTERNAL_MCP_";
export const INTERNAL_MCP_SERVER_NAME = "strideterm";
export const INTERNAL_MCP_ROUTE = "/internal-mcp";

export const INTERNAL_MCP_MAX_SOURCES = 10;
export const INTERNAL_MCP_MAX_SOURCE_BYTES = 512 * 1024;
export const INTERNAL_MCP_MAX_ASSIGNMENT_CHARS = 16_000;
export const INTERNAL_MCP_PREPARATION_TTL_MS = 30 * 60 * 1000;
export const INTERNAL_MCP_TASK_LIST_MAX = 50;
export const INTERNAL_MCP_LOG_MAX_ENTRIES = 50;

export const INTERNAL_MCP_ERROR_CODES = [
  "invalid_request",
  "workspace_not_found",
  "scope_denied",
  "provider_unavailable",
  "checkout_conflict",
  "needs_reprepare",
  "unsupported_workspace",
  "preparation_not_found",
  "preparation_not_ready",
  "idempotency_conflict",
  "file_not_accessible",
  "operation_not_found",
  "task_not_found",
  "busy",
  "start_refused",
  "internal_error",
] as const;
export type InternalMcpErrorCode = (typeof INTERNAL_MCP_ERROR_CODES)[number];

const providerIdSchema = z
  .string()
  .refine((id) => PROVIDER_CHOICES.some((choice) => choice.id === id), "Unknown provider id.");
const modelIdSchema = z
  .string()
  .max(100)
  .regex(/^[A-Za-z0-9._:/@+-]*$/u, "Model ids contain letters, digits and . _ : / @ + - only.");
const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/u);

export const internalMcpSourceSchema = z
  .object({
    path: z.string().trim().min(1).max(1024),
    /** Bytes the host already read with its own tools. Absent → the runtime may read it only inside its own grant. */
    content: z.string().max(INTERNAL_MCP_MAX_SOURCE_BYTES).optional(),
    /** Host-computed hash of `content`; checked against the runtime's own. */
    sha256: sha256Schema.optional(),
    /** The machine the path resolves on, kept as metadata. */
    origin: z.string().trim().max(200).optional(),
  })
  .strict();
export type InternalMcpSource = z.infer<typeof internalMcpSourceSchema>;

const roleInputSchema = z
  .object({
    providerId: providerIdSchema.optional(),
    model: modelIdSchema.optional(),
  })
  .strict();

const branchSchema = z
  .string()
  .trim()
  .max(200)
  .regex(/^[a-zA-Z0-9._/-]+$/u);

export const internalMcpPrepareInputSchema = z
  .object({
    assignment: z.string().max(INTERNAL_MCP_MAX_ASSIGNMENT_CHARS).optional(),
    sources: z.array(internalMcpSourceSchema).max(INTERNAL_MCP_MAX_SOURCES).optional(),
    worker: roleInputSchema.optional(),
    judge: roleInputSchema.optional(),
    maxRounds: z.number().int().min(1).max(100).optional(),
    checkout: z
      .object({
        mode: z.enum(["here", "worktree"]).optional(),
        repository: z.string().trim().min(1).max(1024).optional(),
        branch: branchSchema.optional(),
      })
      .strict()
      .optional(),
    /** Must name the workspace the grant was minted for; it can never widen it. */
    workspaceId: z.string().trim().min(1).max(200).optional(),
  })
  .strict();
export type InternalMcpPrepareInput = z.infer<typeof internalMcpPrepareInputSchema>;

export const internalMcpStartInputSchema = z
  .object({
    preparationId: z.string().trim().min(1).max(100),
    approvedInputHash: sha256Schema,
    idempotencyKey: z
      .string()
      .trim()
      .min(8)
      .max(128)
      .regex(/^[A-Za-z0-9._:-]+$/u),
  })
  .strict();
export type InternalMcpStartInput = z.infer<typeof internalMcpStartInputSchema>;

export const internalMcpOperationGetInputSchema = z.object({ operationId: z.string().trim().min(1).max(100) }).strict();

export const internalMcpTaskListInputSchema = z
  .object({
    activeOnly: z.boolean().optional(),
    parentWorkspaceId: z.string().trim().min(1).max(200).optional(),
    limit: z.number().int().min(1).max(INTERNAL_MCP_TASK_LIST_MAX).optional(),
    cursor: z.string().trim().max(200).optional(),
  })
  .strict();

export const internalMcpTaskGetInputSchema = z
  .object({
    workspaceId: z.string().trim().min(1).max(200),
    logCursor: z.string().trim().max(50).optional(),
    logLimit: z.number().int().min(1).max(INTERNAL_MCP_LOG_MAX_ENTRIES).optional(),
  })
  .strict();

/** The one request envelope the stdio bridge sends to the broker. */
export const internalMcpRequestSchema = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("prepare"), input: internalMcpPrepareInputSchema }).strict(),
  z.object({ operation: z.literal("start"), input: internalMcpStartInputSchema }).strict(),
  z.object({ operation: z.literal("operation_get"), input: internalMcpOperationGetInputSchema }).strict(),
  z.object({ operation: z.literal("task_list"), input: internalMcpTaskListInputSchema }).strict(),
  z.object({ operation: z.literal("task_get"), input: internalMcpTaskGetInputSchema }).strict(),
]);
export type InternalMcpRequest = z.infer<typeof internalMcpRequestSchema>;

export type InternalMcpRoleRef = { providerId: string; model: string };

export interface InternalMcpSourceSummary {
  index: number;
  path: string;
  origin: string;
  sha256: string;
  bytes: number;
  access: "host-provided" | "runtime-read";
  snapshotPath: string;
  preview: string;
}

export interface InternalMcpPrepareResult {
  preparationId: string;
  status: "requires_input" | "ready";
  missingInputs: string[];
  errors: Array<{ code: InternalMcpErrorCode; field?: string; message: string }>;
  choices: {
    providers: Array<{
      id: string;
      name: string;
      available: boolean;
      models: Array<{ id: string; name: string; suggestedRole: string | null }>;
      customModelAllowed: true;
    }>;
    checkout: {
      modes: Array<"here" | "worktree">;
      repositories: Array<{ path: string; head: string; dirty: boolean }>;
      suggestedBranch: string;
    };
  };
  defaults: { worker: InternalMcpRoleRef; judge: InternalMcpRoleRef; maxRounds: number };
  summary: Record<string, unknown>;
  inputHash: string;
  expiresAt: string;
}

export interface InternalMcpTaskOverview {
  workspaceId: string;
  taskId: string;
  name: string;
  state: string;
  parentWorkspaceId: string;
  currentRound: number;
  maxRounds: number;
  startedAt: string | null;
  finishedAt: string | null;
  lastActivityAt: string | null;
  awaitingUserInTerminal: Array<"worker" | "judge">;
}

export type InternalMcpOperationStep =
  "preparing-worktree" | "creating-workspace" | "starting" | "ready" | "failed" | "interrupted";
