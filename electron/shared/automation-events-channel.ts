import { z } from "zod";

export const AUTOMATION_RUN_FINISHED_CHANNEL = "automation:run-finished";
export const automationRunFinishedSchema = z
  .object({
    workspaceId: z.string().min(1),
    runId: z.uuid(),
    profileId: z.string().min(1),
    state: z.enum(["succeeded", "failed", "timed-out", "stopped", "interrupted"]),
    reason: z.string().optional(),
    resultExcerpt: z.string().optional(),
    disabledReason: z.literal("failures").optional(),
  })
  .strict();
export type AutomationRunFinished = z.infer<typeof automationRunFinishedSchema>;
