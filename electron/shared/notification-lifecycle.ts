import { z } from "zod";

/**
 * Authoritative "a notification target disappeared" lifecycle event.
 *
 * Notification history is owned by the renderer and persisted in localStorage,
 * but workspace and panel lifecycle is authoritative in the headless runtime.
 * Without an explicit event the renderer never learns that a thread's target is
 * gone, so dead threads linger, Jump lands on a workspace that no longer exists,
 * and an unstamped session loses the workspace its profile was inferred from and
 * leaks into every profile.
 *
 * The runtime emits this only AFTER the corresponding state mutation commits.
 * BroadcastChannel still synchronises renderers of the same origin, but it is
 * not the source of truth — a remote client shares no BroadcastChannel with the
 * desktop.
 *
 * `workspaceId` is present on both variants on purpose: filtering a view removal
 * by `viewId` alone can drop an unrelated session, because a legacy or custom
 * view id is not guaranteed unique across workspaces.
 *
 * `profileId` is carried in the payload rather than looked up on receipt: by the
 * time a renderer processes the event the workspace is already gone from state,
 * so its owning profile is no longer resolvable. It is always the EFFECTIVE
 * profile id (`workspace.profileId || "default"`), never an empty legacy value.
 */
export const notificationTargetRemovedSchema = z
  .discriminatedUnion("target", [
    z
      .object({
        target: z.literal("workspace"),
        workspaceId: z.string().min(1),
        profileId: z.string().min(1),
      })
      .strict(),
    z
      .object({
        target: z.literal("view"),
        workspaceId: z.string().min(1),
        viewId: z.string().min(1),
        profileId: z.string().min(1),
      })
      .strict(),
  ])
  .describe("notification:target-removed");

export type NotificationTargetRemoved = z.infer<typeof notificationTargetRemovedSchema>;

/** IPC / WebSocket channel name for the event above. */
export const NOTIFICATION_TARGET_REMOVED_CHANNEL = "notification:target-removed";
