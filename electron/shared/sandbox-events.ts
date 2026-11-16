import { z } from "zod";

/**
 * Events about a sandbox waiting on a destination no rule decides. Desktop windows only: arming and
 * widening isolation is a decision for the machine that runs the agents, so neither the browser remote
 * nor a paired phone receives them.
 */
export const SANDBOX_DENIED_CHANNEL = "sandbox:denied";
export const SANDBOX_DENIED_SETTLED_CHANNEL = "sandbox:denied-settled";

export const sandboxDeniedRequestSchema = z
  .object({
    id: z.string().min(1).max(128),
    workspaceId: z.string().min(1),
    sessionId: z.string().min(1),
    host: z.string().min(1).max(260),
    port: z.number().int().min(1).max(65535).nullable(),
    at: z.number(),
    state: z.enum(["pending", "allowed", "denied", "expired"]),
  })
  .strict();
