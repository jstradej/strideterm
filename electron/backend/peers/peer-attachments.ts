import type { PeerAttachmentItem, PeerAttachmentList } from "../../shared/peers.js";
import type { AttachmentReadRequest, AttachmentReadResult } from "../../shared/attachment-upload.js";
import type { AppState } from "../../shared/types/state.js";
import * as attachmentTransfer from "../attachment-transfer.js";
import { localAttachmentRoot } from "../attachment-root.js";
import { listRecentAttachments } from "../recent-attachments.js";

/** A refusal with a sentence the other desktop can show as it is. */
export class PeerAttachmentError extends Error {
  constructor(
    readonly status: 400 | 404,
    message: string,
  ) {
    super(message);
    this.name = "PeerAttachmentError";
  }
}

export interface PeerAttachmentsHostDeps {
  getState: () => Pick<AppState, "profiles" | "workspaces">;
  now?: () => number;
}

/**
 * What a paired desktop may see of this machine's attachments: every profile's, because a paired desktop already
 * sees every profile. Roots are found by the rule of a local window (`localAttachmentRoot`) minus the profile binding,
 * and the read path is the one the desktop IPC uses, so `attachments.read` still guards the file path.
 */
export function createPeerAttachmentsHost(deps: PeerAttachmentsHostDeps) {
  const now = deps.now ?? (() => Date.now());

  return {
    async list(): Promise<PeerAttachmentList> {
      const { items, truncated } = await listRecentAttachments(deps.getState(), now());
      // The other desktop gets no path of this machine.
      return { items: items.map(({ path: _path, root: _root, ...item }): PeerAttachmentItem => item), truncated };
    },

    async read(request: AttachmentReadRequest): Promise<AttachmentReadResult> {
      const workspace = deps.getState().workspaces.find((candidate) => candidate.id === request.workspaceId);
      if (!workspace) throw new PeerAttachmentError(404, "Attachment not found");
      let root: string;
      try {
        root = localAttachmentRoot(workspace);
      } catch {
        throw new PeerAttachmentError(404, "Attachment not found");
      }
      try {
        return await attachmentTransfer.read(root, request);
      } catch (error) {
        if (error instanceof Error && error.message === "Attachment not found") {
          throw new PeerAttachmentError(404, "Attachment not found");
        }
        throw error;
      }
    },
  };
}

export type PeerAttachmentsHost = ReturnType<typeof createPeerAttachmentsHost>;
