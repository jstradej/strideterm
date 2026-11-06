import { z } from "zod";
import type { OperationFinished } from "./operation-events.js";

const positiveId = z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER);

/** Start an agent on a finished Azure Pipelines run. Profile is always resolved by the backend. */
export const startPipelineAgentSchema = z
  .object({
    connectionId: z.string().trim().min(1).max(200),
    projectName: z.string().trim().min(1).max(300),
    pipelineId: positiveId,
    buildId: positiveId,
    /** Stable per user action so a retry does not create a second workspace. */
    idempotencyKey: z.string().trim().min(1).max(200),
  })
  .strict();

export type StartPipelineAgentInput = z.infer<typeof startPipelineAgentSchema>;

export const OPERATION_KIND_PIPELINE_AGENT = "pipeline.agent";
export const START_PIPELINE_AGENT_CHANNEL = "azure:pipelines:agent-start";
export const START_PIPELINE_AGENT_ROUTE = "/api/azure/pipelines/agent-start";

export interface StartPipelineAgentResult {
  started: true;
  operationId: string;
  replayed: boolean;
  /** Present when an idempotent retry names an operation that already finished. */
  outcome?: OperationFinished;
}

/** Run results an agent can be started on: something went wrong and the run is over. */
export const PIPELINE_AGENT_RESULTS = ["failed", "partiallySucceeded", "canceled"] as const;

export function isPipelineAgentCandidate(run: { state?: string; status?: string; result?: string }): boolean {
  const status = String(run.state || run.status || "").toLowerCase();
  const result = String(run.result || "");
  return status === "completed" && (PIPELINE_AGENT_RESULTS as readonly string[]).includes(result);
}

export const PIPELINE_RUN_DIR = ".strideterm/pipeline-run";

export function pipelineRunRelativeDir(buildId: number): string {
  return `${PIPELINE_RUN_DIR}/${buildId}`;
}

export function pipelineRunBriefPath(buildId: number): string {
  return `${pipelineRunRelativeDir(buildId)}/BRIEF.md`;
}
