import { z } from "zod";

/**
 * "A long-running runtime operation finished."
 *
 * The generic form of the closed-PR cleanup event: an action that can outlive a
 * 30 s request answers at once with an `operationId`, runs inside the runtime,
 * and reports here. `profileId` is the EFFECTIVE profile the operation was
 * accepted in; the remote server routes the event to clients bound to it and a
 * renderer shows it only while viewing it.
 *
 * Exactly one of `result` or `error` is present. The same object is kept in the
 * state payload (`operations.lastResults`) for 24 h so a client that was not
 * connected when the run ended still learns the outcome; `operationId` is what
 * a client dedupes on.
 */
const operationOutcomeBase = {
  operationId: z.string().min(1),
  kind: z.string().min(1),
  profileId: z.string().min(1),
  /** The workspace the operation produced or acts on, when it has one. */
  workspaceId: z.string().optional(),
  /** Repository root for multi-root Git operations. */
  rootPath: z.string().optional(),
  /** ISO timestamp of the end of the run. */
  finishedAt: z.string().min(1),
};

export const operationFailureClassificationSchema = z.enum([
  "blocked",
  "cancelled",
  "partial",
  "failed",
  "interrupted",
]);
export type OperationFailureClassification = z.infer<typeof operationFailureClassificationSchema>;

export const operationFinishedSchema = z
  .union([
    z.object({ ...operationOutcomeBase, result: z.record(z.string(), z.unknown()) }).strict(),
    z
      .object({
        ...operationOutcomeBase,
        error: z
          .object({
            code: z.string().min(1),
            message: z.string(),
            classification: operationFailureClassificationSchema.optional(),
            warnings: z.array(z.string()).optional(),
            conflicts: z.array(z.string()).optional(),
            rawOutput: z.string().optional(),
          })
          .strict(),
      })
      .strict(),
  ])
  .describe("operation:finished");

export type OperationFinished = z.infer<typeof operationFinishedSchema>;

export const OPERATION_FINISHED_CHANNEL = "operation:finished";

/** A last result older than this is history, not news: the payload stops offering it. */
export const OPERATION_LAST_RESULT_TTL_MS = 24 * 60 * 60 * 1000;

export type OperationStatus = "accepted" | "running" | "succeeded" | "failed" | "interrupted";

/** One running operation as the state payload lists it. */
export interface OperationRunning {
  operationId: string;
  kind: string;
  profileId: string;
  step: string;
  workspaceId?: string;
  rootPath?: string;
  startedAt: string;
}

export interface OperationsState {
  running: OperationRunning[];
  lastResults: OperationFinished[];
}

export const OPERATION_KIND_TASK_PROVISION = "task.provision";
export const OPERATION_KIND_REVIEW_AGENT_PREPARE = "review-agent.prepare";
