import { z } from "zod";

/**
 * Review Git operations (refresh, rebase, push, force push, push-and-publish,
 * and the agent-facing stage / commit / conflict steps) can outlast the 30 s a
 * remote request may take to START its response over the mobile relay, so they
 * never answer the request that started them. The start call returns an
 * `operationId` at once; the runtime keeps "running" and the last outcome in
 * the profile-scoped state payload (`reviewGit`), and ends each operation with
 * ONE event of this shape — the same object that becomes the payload's last run,
 * so a client that was not connected when it ended still learns the outcome and
 * dedupes on `operationId`.
 *
 * `profileId` is always the EFFECTIVE id (`workspace.profileId || "default"`):
 * the remote server routes the event only to clients bound to that profile.
 * Exactly one of `result` or `error` is present once `state` is not "running".
 */
export const REVIEW_GIT_OPERATION_CHANNEL = "review-git:operation";

export const reviewGitOperationKindSchema = z.enum([
  "fetch",
  "refresh",
  "rebase",
  "push",
  "force-push",
  "push-and-publish",
  "stage",
  "unstage",
  "commit",
  "continue",
  "skip",
  "abort",
]);
export type ReviewGitOperationKind = z.infer<typeof reviewGitOperationKindSchema>;

const proposalFactValueSchema = z.union([
  z.string().max(2000),
  z.number(),
  z.boolean(),
  z.null(),
  z.array(z.string().max(2000)).max(1000),
]);

/**
 * The continuation of a proposal: its id, and — optionally — the repository facts
 * the caller was shown. The id alone already makes a stale answer impossible; the
 * facts only let the runtime say WHICH of them changed.
 */
export const reviewGitConfirmationSchema = z
  .object({
    proposalId: z.string().min(1).max(100),
    facts: z.record(z.string().max(100), proposalFactValueSchema).optional(),
  })
  .strict();

export const reviewGitOperationEventSchema = z
  .object({
    operationId: z.string().min(1),
    profileId: z.string().min(1),
    workspaceId: z.string().min(1),
    kind: z.string().min(1),
    /** "ui" for a window or remote client, "mcp" for an agent's tool. */
    source: z.enum(["ui", "mcp"]),
    state: z.enum(["running", "succeeded", "failed"]),
    startedAt: z.string().min(1),
    finishedAt: z.string().nullable(),
    result: z.unknown().optional(),
    error: z.string().optional(),
  })
  .strict()
  .describe(REVIEW_GIT_OPERATION_CHANNEL);

export type ReviewGitOperationEvent = z.infer<typeof reviewGitOperationEventSchema>;

/** Payload of `reviewGit` in the runtime state: what is running, and what finished within 24 h. */
export interface ReviewGitState {
  running: ReviewGitOperationEvent[];
  lastRuns: ReviewGitOperationEvent[];
}
