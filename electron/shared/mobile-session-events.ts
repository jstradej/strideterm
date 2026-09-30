import { z } from "zod";

/**
 * "A paired phone is connected right now."
 *
 * A mobile session is a bearer-cookie session minted from a ticket (remote-server.ts). Nothing on the
 * desktop used to say one was live — the device list only shows "last seen". These two shapes are how
 * the desktop user SEES it: `mobile:status` carries the current list (for an always-visible
 * indicator), `mobile:session-started` is the one-shot edge that becomes a Notification Center entry.
 *
 * Neither carries the session id (it is the bearer credential) or the pair id. `name` is the device's
 * desktop-local label.
 */
export const mobileConnectedDeviceSchema = z
  .object({
    deviceId: z.string().min(1),
    name: z.string(),
    profileId: z.string().min(1),
    /** Epoch ms of the oldest live session this device holds. */
    startedAt: z.number(),
  })
  .strict();

export type MobileConnectedDevice = z.infer<typeof mobileConnectedDeviceSchema>;

export const mobileSessionStartedSchema = mobileConnectedDeviceSchema
  .extend({
    /** Display name of `profileId`, or the id itself when the profile is unknown. */
    profileName: z.string(),
  })
  .strict()
  .describe("mobile:session-started");

export type MobileSessionStarted = z.infer<typeof mobileSessionStartedSchema>;

/** IPC channel for the event above. */
export const MOBILE_SESSION_STARTED_CHANNEL = "mobile:session-started";
