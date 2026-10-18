import { z } from "zod";
import type { OperationFinished } from "./operation-events.js";

/** Provider-owned key for a PR review request. Profile is always resolved by the backend. */
export const startPullRequestReviewSchema = z
  .object({
    provider: z.enum(["azure-devops", "github"]),
    prKey: z.string().trim().min(1).max(500),
    /** Stable per user action / mobile command so a retry does not spawn another agent. */
    idempotencyKey: z.string().trim().min(1).max(200),
  })
  .strict();

export type StartPullRequestReviewInput = z.infer<typeof startPullRequestReviewSchema>;

export const OPERATION_KIND_REVIEW_START = "review.start";
export const START_PULL_REQUEST_REVIEW_CHANNEL = "review:start";
export const START_PULL_REQUEST_REVIEW_ROUTE = "/api/review/start";

export interface StartPullRequestReviewResult {
  started: true;
  operationId: string;
  replayed: boolean;
  /** Present when an idempotent retry names an operation that already finished. */
  outcome?: OperationFinished;
}
