import { z } from "zod";

export const reviewPrProviderSchema = z.enum(["azure-devops", "github"]);
export const reviewPrActionSchema = z.enum([
  "approve",
  "complete",
  "enable_auto_complete",
  "disable_auto_complete",
  "merge",
  "enable_auto_merge",
  "disable_auto_merge",
  "set_draft",
  "set_ready",
  "abandon",
  "reactivate",
  "close",
  "reopen",
]);
export const reviewPrMergeMethodSchema = z.enum(["merge", "squash", "rebase"]);
export const reviewPrStateSchema = z.enum(["active", "completed", "abandoned", "open", "closed", "merged"]);
export const reviewPrCheckStateSchema = z.enum(["success", "failure", "pending", "unknown"]);
export const reviewPrMergeReadinessSchema = z
  .object({ state: z.enum(["ready", "blocked", "pending", "unknown"]), reason: z.string().optional() })
  .strict();

export const reviewPrCheckSchema = z
  .object({
    name: z.string(),
    state: reviewPrCheckStateSchema,
    kind: z.string().optional(),
    url: z.string().optional(),
    details: z.string().optional(),
  })
  .strict();

export const reviewPrCheckSummarySchema = z
  .object({
    state: reviewPrCheckStateSchema,
    total: z.number().int().nonnegative(),
    successful: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    pending: z.number().int().nonnegative(),
    items: z.array(reviewPrCheckSchema),
  })
  .strict();

const reviewPrRefSchema = z
  .object({
    repository: z.string(),
    branch: z.string(),
    sha: z.string(),
  })
  .strict();

export const reviewPrActionSnapshotSchema = z
  .object({
    provider: reviewPrProviderSchema,
    prKey: z.string().min(1),
    connectionId: z.string().min(1),
    repository: z.string().min(1),
    number: z.union([z.string(), z.number()]),
    url: z.string().optional(),
    title: z.string(),
    state: reviewPrStateSchema,
    isDraft: z.boolean(),
    autoMerge: z.boolean().nullable(),
    source: reviewPrRefSchema,
    target: reviewPrRefSchema,
    checks: reviewPrCheckSummarySchema,
    mergeReadiness: reviewPrMergeReadinessSchema,
    review: z
      .object({
        approvals: z.number().int().nonnegative(),
        changesRequested: z.number().int().nonnegative(),
        requiredApprovals: z.number().int().nonnegative().nullable(),
      })
      .strict(),
    supportedActions: z.array(reviewPrActionSchema),
  })
  .strict();

export const reviewPrActionOptionsSchema = z
  .object({
    mergeMethod: reviewPrMergeMethodSchema.optional(),
  })
  .strict();

export const reviewPrActionOutcomeStatusSchema = z.enum(["completed", "accepted", "queued", "stale", "failed"]);

export const reviewPrActionProposalSchema = z
  .object({
    proposalId: z.string().min(1),
    profileId: z.string().min(1),
    workspaceId: z.string().min(1),
    provider: reviewPrProviderSchema,
    prKey: z.string().min(1),
    action: reviewPrActionSchema,
    options: reviewPrActionOptionsSchema,
    title: z.string(),
    message: z.string(),
    snapshot: reviewPrActionSnapshotSchema,
    expiresAt: z.string().min(1),
  })
  .strict();

export const reviewPrActionOutcomeSchema = z
  .object({
    provider: reviewPrProviderSchema,
    prKey: z.string().min(1),
    action: reviewPrActionSchema,
    status: reviewPrActionOutcomeStatusSchema,
    message: z.string(),
    warning: z.string().optional(),
    snapshot: reviewPrActionSnapshotSchema.optional(),
  })
  .strict();

export const reviewPrActionsStateSchema = z
  .object({
    pending: z.array(reviewPrActionProposalSchema),
  })
  .strict();

export const REVIEW_PR_ACTION_OPERATION_KIND = "review-pr-action";
export const REVIEW_PR_ACTION_PROPOSAL_OPERATION_KIND = "review-pr-action-proposal";
export const REVIEW_PR_INSPECT_OPERATION_KIND = "review-pr-inspect";

export type ReviewPrProvider = z.infer<typeof reviewPrProviderSchema>;
export type ReviewPrAction = z.infer<typeof reviewPrActionSchema>;
export type ReviewPrMergeMethod = z.infer<typeof reviewPrMergeMethodSchema>;
export type ReviewPrState = z.infer<typeof reviewPrStateSchema>;
export type ReviewPrActionOptions = z.infer<typeof reviewPrActionOptionsSchema>;
export type ReviewPrCheck = z.infer<typeof reviewPrCheckSchema>;
export type ReviewPrCheckSummary = z.infer<typeof reviewPrCheckSummarySchema>;
export type ReviewPrActionSnapshot = z.infer<typeof reviewPrActionSnapshotSchema>;
export type ReviewPrActionProposal = z.infer<typeof reviewPrActionProposalSchema>;
export type ReviewPrActionOutcome = z.infer<typeof reviewPrActionOutcomeSchema>;
export type ReviewPrActionsState = z.infer<typeof reviewPrActionsStateSchema>;
