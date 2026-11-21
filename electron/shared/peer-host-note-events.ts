import { z } from "zod";

/**
 * A paired host's global note changed since this desktop last asked (its change counter in the attention poll moved).
 * Local desktop windows reload that host's card. Like the attachment copy event the name sits outside the `peers:` /
 * `peer:` prefixes on purpose: a window attached to another desktop must never hear about it (`peer-window-channels`).
 */
export const PEER_HOST_NOTE_CHANGED_CHANNEL = "sidebar-notes:host-note-changed";

export const peerHostNoteChangedSchema = z
  .object({ hostId: z.string().min(1).max(64), revision: z.int().min(0) })
  .strict();
export type PeerHostNoteChanged = z.infer<typeof peerHostNoteChangedSchema>;
