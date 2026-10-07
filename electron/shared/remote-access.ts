import { z } from "zod";

export const remoteBrowserSessionSchema = z
  .object({
    sessionRef: z.string().min(1),
    origin: z.enum(["token", "ticket"]),
    remoteAddress: z.string(),
    createdAt: z.number(),
    lastSeenAt: z.number(),
    expiresAt: z.number(),
    idleExpiresAt: z.number(),
  })
  .strict();
export type RemoteBrowserSession = z.infer<typeof remoteBrowserSessionSchema>;

export const remoteSessionRevokeSchema = z
  .object({ sessionRef: z.string().min(1).optional(), all: z.boolean().optional() })
  .strict()
  .refine((value) => value.all === true || Boolean(value.sessionRef), "Specify a session or all: true");
export type RemoteSessionRevoke = z.infer<typeof remoteSessionRevokeSchema>;

export const remoteAuthFailuresSchema = z
  .object({ address: z.string(), count: z.number().int().positive(), blockedUntil: z.number() })
  .strict();
export type RemoteAuthFailures = z.infer<typeof remoteAuthFailuresSchema>;
export const REMOTE_AUTH_FAILURES_CHANNEL = "remote:auth-failures";
