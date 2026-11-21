import path from "node:path";
import {
  PEER_ATTACHMENT_LIST_DAYS,
  PEER_ATTACHMENT_LIST_MAX_ITEMS,
  PEER_ATTACHMENT_NAME_MAX,
  type PeerAttachmentItem,
  type PeerAttachmentList,
} from "../../shared/peers.js";
import type { AttachmentReadRequest, AttachmentReadResult } from "../../shared/attachment-upload.js";
import type { AppState } from "../../shared/types/state.js";
import * as attachments from "../attachments.js";
import * as attachmentTransfer from "../attachment-transfer.js";
import { localAttachmentRoot } from "../attachment-root.js";
import { getLogger } from "../logger.js";

const log = getLogger("peers");

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

const DAY_MS = 24 * 60 * 60 * 1000;

function rootKey(root: string): string {
  const resolved = path.resolve(root);
  return process.platform === "win32" || process.platform === "darwin" ? resolved.toLowerCase() : resolved;
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
      const state = deps.getState();
      const profileNames = new Map(state.profiles.map((profile) => [profile.id, profile.name]));
      const cutoff = now() - PEER_ATTACHMENT_LIST_DAYS * DAY_MS;
      const seenRoots = new Set<string>();
      const items: PeerAttachmentItem[] = [];
      for (const workspace of state.workspaces) {
        let root: string;
        try {
          root = localAttachmentRoot(workspace);
        } catch {
          continue;
        }
        const key = rootKey(root);
        if (seenRoots.has(key)) continue;
        seenRoots.add(key);
        let listed: Awaited<ReturnType<typeof attachments.list>>;
        try {
          listed = await attachments.list(root);
        } catch (error) {
          log.debug("peer attachment listing skipped a workspace", {
            workspaceId: workspace.id,
            err: error instanceof Error ? error.message : String(error),
          });
          continue;
        }
        const profileId = String(workspace.profileId || "default");
        for (const entry of listed) {
          if (typeof entry.uploadedAt !== "number" || entry.uploadedAt < cutoff) continue;
          items.push({
            profileId,
            profileName: (profileNames.get(profileId) ?? profileId).slice(0, PEER_ATTACHMENT_NAME_MAX),
            workspaceId: workspace.id,
            workspaceName: workspace.name.slice(0, PEER_ATTACHMENT_NAME_MAX),
            transferId: entry.transferId,
            name: entry.name,
            size: entry.size,
            sha256: entry.sha256,
            uploadedAt: entry.uploadedAt,
          });
        }
      }
      items.sort((a, b) => b.uploadedAt - a.uploadedAt);
      return {
        items: items.slice(0, PEER_ATTACHMENT_LIST_MAX_ITEMS),
        truncated: items.length > PEER_ATTACHMENT_LIST_MAX_ITEMS,
      };
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
