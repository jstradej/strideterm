import path from "node:path";
import {
  PEER_ATTACHMENT_LIST_DAYS,
  PEER_ATTACHMENT_LIST_MAX_ITEMS,
  PEER_ATTACHMENT_NAME_MAX,
} from "../shared/peers.js";
import type { LocalAttachmentItem, LocalAttachmentList } from "../shared/attachment-upload.js";
import type { AppState } from "../shared/types/state.js";
import * as attachments from "./attachments.js";
import { localAttachmentRoot } from "./attachment-root.js";
import { getLogger } from "./logger.js";

const log = getLogger("attachments");
const DAY_MS = 24 * 60 * 60 * 1000;

function rootKey(root: string): string {
  const resolved = path.resolve(root);
  return process.platform === "win32" || process.platform === "darwin" ? resolved.toLowerCase() : resolved;
}

/**
 * Attachments of every profile's local workspaces uploaded in the last 14 days, newest first, at most 200.
 * Roots follow the rule of a local window (`localAttachmentRoot`) without the profile binding; SSH, container
 * and Docker workspaces have none and are skipped, as is a root another workspace already listed.
 * `root` and `path` are this machine's own paths: a paired desktop gets the list without them.
 */
export async function listRecentAttachments(
  state: Pick<AppState, "profiles" | "workspaces">,
  now: number = Date.now(),
): Promise<LocalAttachmentList> {
  const profileNames = new Map(state.profiles.map((profile) => [profile.id, profile.name]));
  const cutoff = now - PEER_ATTACHMENT_LIST_DAYS * DAY_MS;
  const seenRoots = new Set<string>();
  const items: LocalAttachmentItem[] = [];
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
      log.debug("attachment listing skipped a workspace", {
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
        path: entry.path,
        root,
      });
    }
  }
  items.sort((a, b) => b.uploadedAt - a.uploadedAt);
  return {
    items: items.slice(0, PEER_ATTACHMENT_LIST_MAX_ITEMS),
    truncated: items.length > PEER_ATTACHMENT_LIST_MAX_ITEMS,
  };
}
