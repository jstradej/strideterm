import { z } from "zod";

/**
 * Copying an attachment of a paired desktop into a local workspace can outlast the 30 s a remote request may take
 * to START its response, so the start call returns a `copyId` at once. The runtime keeps "running" and the last runs
 * in the state payload (`peerAttachmentCopies`, for this machine's own windows only: `buildRemoteCore` hands a remote
 * client none) and ends each copy with ONE `PEER_ATTACHMENT_COPY_FINISHED_CHANNEL` event of the shape below — the
 * same object that becomes the payload's last run. Progress between those two moments travels as the small, throttled
 * `PEER_ATTACHMENT_COPY_PROGRESS_CHANNEL` event, never as a state broadcast.
 *
 * Both events belong to this machine's runtime and its local windows. The names sit outside the `peers:` / `peer:`
 * prefixes on purpose: those are pushed into a window attached to another desktop, and such a window must never
 * hear about a copy into a local workspace (pinned in `peer-window-channels.test.ts`).
 */
export const PEER_ATTACHMENT_COPY_FINISHED_CHANNEL = "attachment:peer-copy-finished";
export const PEER_ATTACHMENT_COPY_PROGRESS_CHANNEL = "attachment:peer-copy-progress";

export const peerAttachmentCopyProgressSchema = z
  .object({
    copyId: z.string().min(1),
    bytesDone: z.number().int().nonnegative(),
    bytesTotal: z.number().int().nonnegative(),
  })
  .strict();
export type PeerAttachmentCopyProgress = z.infer<typeof peerAttachmentCopyProgressSchema>;

export const peerAttachmentCopyStateSchema = z.enum(["queued", "running", "succeeded", "failed", "cancelled"]);
export type PeerAttachmentCopyState = z.infer<typeof peerAttachmentCopyStateSchema>;

const sourceSchema = z
  .object({
    workspaceId: z.string().min(1),
    transferId: z.string().min(1),
    name: z.string().min(1),
    size: z.number().int().nonnegative(),
    sha256: z.string(),
  })
  .strict();

/** The copy as the local attachment store holds it afterwards (`path` is relative to the workspace root). */
export const peerAttachmentCopyResultSchema = z
  .object({
    transferId: z.string().min(1),
    path: z.string().min(1),
    name: z.string().min(1),
    size: z.number().int().nonnegative(),
    sha256: z.string().min(1),
  })
  .strict();
export type PeerAttachmentCopyResult = z.infer<typeof peerAttachmentCopyResultSchema>;

export const peerAttachmentCopyErrorSchema = z.object({ message: z.string() }).strict();
export type PeerAttachmentCopyError = z.infer<typeof peerAttachmentCopyErrorSchema>;

export const peerAttachmentCopyRunSchema = z
  .object({
    copyId: z.string().min(1),
    /** Profile of the target workspace. */
    profileId: z.string().min(1),
    /** The local target workspace. */
    workspaceId: z.string().min(1),
    hostId: z.string().min(1),
    hostLabel: z.string(),
    source: sourceSchema,
    state: peerAttachmentCopyStateSchema,
    startedAt: z.string().min(1),
    finishedAt: z.string().nullable(),
    bytesDone: z.number().int().nonnegative(),
    bytesTotal: z.number().int().nonnegative(),
    result: peerAttachmentCopyResultSchema.optional(),
    error: peerAttachmentCopyErrorSchema.optional(),
  })
  .strict();
export type PeerAttachmentCopyRun = z.infer<typeof peerAttachmentCopyRunSchema>;

export const peerAttachmentCopyFinishedSchema = peerAttachmentCopyRunSchema
  .extend({
    state: z.enum(["succeeded", "failed", "cancelled"]),
    finishedAt: z.string().min(1),
  })
  .strict();
export type PeerAttachmentCopyFinished = z.infer<typeof peerAttachmentCopyFinishedSchema>;

/** Payload of `peerAttachmentCopies` in the runtime state: copies queued or running, and those finished within 24 h. */
export interface PeerAttachmentCopiesState {
  running: PeerAttachmentCopyRun[];
  lastResults: PeerAttachmentCopyRun[];
}

export interface PeerAttachmentCopyStarted {
  copyId: string;
}
