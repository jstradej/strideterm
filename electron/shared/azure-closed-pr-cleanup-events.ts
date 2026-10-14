import { z } from "zod";

/**
 * "The closed-PR cleanup of an Azure DevOps workspace finished."
 *
 * The cleanup checks every closed PR against Azure DevOps before deleting its
 * workspace (1–2 s per PR), so it cannot answer the request that started it:
 * over the mobile relay a request whose response has not started within 30 s
 * is cancelled while the desktop keeps deleting, and the phone reported a
 * failure for a cleanup that was still running. The start call therefore
 * returns at once and the outcome arrives as this event.
 *
 * `profileId` travels in the payload for the same reason it does on
 * `approval:recorded`: the remote server routes the event only to clients bound
 * to that profile, and each renderer shows it only while it is viewing that
 * profile. It is always the EFFECTIVE id (`workspace.profileId || "default"`).
 *
 * Exactly one of `result` (the summary of a finished run) or `error` (the run
 * threw unexpectedly) is present.
 *
 * The same object is kept as the parent's last run in the runtime-only state
 * payload (`azureClosedPrCleanup.lastRuns`), so a client that was not connected
 * when the run finished still learns the outcome. `runId` is unique per run and
 * is what a client dedupes on: the live event and the payload name the same run.
 */
const azureClosedPrCleanupResultSchema = z
  .object({
    deleted: z.number().int().min(0),
    skipped: z.array(z.object({ workspaceId: z.string(), name: z.string(), reason: z.string() }).strict()),
    errors: z.array(z.object({ workspaceId: z.string(), name: z.string(), error: z.string() }).strict()),
  })
  .strict();

export const azureClosedPrCleanupFinishedSchema = z
  .union([
    z
      .object({
        runId: z.string().min(1),
        parentWorkspaceId: z.string().min(1),
        profileId: z.string().min(1),
        /** ISO timestamp of the end of the run. */
        finishedAt: z.string().min(1),
        result: azureClosedPrCleanupResultSchema,
      })
      .strict(),
    z
      .object({
        runId: z.string().min(1),
        parentWorkspaceId: z.string().min(1),
        profileId: z.string().min(1),
        finishedAt: z.string().min(1),
        error: z.string(),
      })
      .strict(),
  ])
  .describe("azure:closed-pr-cleanup:finished");

export type AzureClosedPrCleanupFinished = z.infer<typeof azureClosedPrCleanupFinishedSchema>;

/** IPC / WebSocket channel name for the event above. */
export const AZURE_CLOSED_PR_CLEANUP_FINISHED_CHANNEL = "azure:closed-pr-cleanup:finished";
