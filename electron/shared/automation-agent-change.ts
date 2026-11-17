import { z } from "zod";

/** Metadata only: prompts and event contents must never enter the notification history. */
export const automationAgentChangeSchema = z
  .object({
    changeId: z.uuid(),
    workspaceId: z.string().min(1),
    profileId: z.string().min(1),
    workspaceName: z.string().min(1).max(200),
    action: z.enum(["created", "updated", "enabled", "disabled", "deleted"]),
    source: z.enum(["agent", "system"]).optional(),
    summary: z.string().max(500),
    at: z.iso.datetime({ offset: true }),
  })
  .strict();
export type AutomationAgentChange = z.infer<typeof automationAgentChangeSchema>;
