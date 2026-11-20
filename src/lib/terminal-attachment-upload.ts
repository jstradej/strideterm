import type { PanelState, WorkspaceState } from "../../electron/shared/types/state.js";
import {
  attachmentsUnavailableReason,
  createAttachmentUploader,
  hasAttachmentUpload,
  type UploadItem,
} from "../composables/useAttachmentUpload.js";
import type { Transport } from "../transport.js";
import { formatDroppedPaths, runtimeAbsolutePath, terminalDropKind } from "./terminal-path-drop.js";

const TOAST_DELAY_MS = 400;
const TOAST_TITLE = "Uploading to the terminal";

export function canUploadToTerminal(api: { isRemote?: boolean } | null | undefined): boolean {
  return api?.isRemote === true && hasAttachmentUpload(api as Partial<Transport>);
}

export function pastedImageName(file: File, now = new Date()): string {
  if (file.name && !/^image\.\w+$/i.test(file.name)) return file.name;
  const extension = /^image\/(\w+)/.exec(file.type)?.[1]?.replace("jpeg", "jpg") || "png";
  const stamp = now
    .toISOString()
    .replace(/\.\d+Z$/, "")
    .replace(/[-:]/g, "")
    .replace("T", "-");
  return `pasted-${stamp}.${extension}`;
}

export interface TerminalUploadRequest {
  api: Partial<Transport>;
  sessionId: string;
  files: readonly File[];
  payload: { appState?: { workspaces?: unknown[] }; meta?: { platform?: string } } | null | undefined;
  write: (text: string) => boolean | void;
}

/** Sends the files to the active workspace's attachments on the machine behind this window and types their path THERE. */
export async function uploadFilesToTerminal(request: TerminalUploadRequest): Promise<void> {
  const { api, sessionId, files, payload, write } = request;
  const { useNotificationStore } = await import("../stores/notifications.js");
  const notifications = useNotificationStore();
  const separator = sessionId.indexOf(":");
  const workspaceId = separator > 0 ? sessionId.slice(0, separator) : sessionId;
  const workspace = ((payload?.appState?.workspaces || []) as WorkspaceState[]).find((ws) => ws?.id === workspaceId);
  const panel: PanelState | null = workspace?.panels?.find((p) => p?.id === sessionId.slice(separator + 1)) || null;
  const platform = payload?.meta?.platform || "";
  const kind = terminalDropKind(panel, platform);
  const refusal =
    kind === "ssh" ? "Attachments are not available in SSH terminals." : attachmentsUnavailableReason(workspace);
  const profileId = workspace?.profileId;
  if (refusal) {
    notifications.pushEphemeralToast({ title: "Cannot upload here", body: refusal, kind: "error", durationMs: 7000 });
    return;
  }
  if (!workspace?.cwd) {
    notifications.showError("Upload failed", "The workspace folder on the other computer is unknown.", {
      workspaceId,
      profileId,
    });
    return;
  }

  let toastId: string | null = null;
  let lastBucket = -1;
  let finished = false;
  const batch: UploadItem[] = [];
  const dismissToast = () => {
    if (toastId) notifications.dismissPersistentToast(toastId);
    toastId = null;
  };
  const showToast = (item: UploadItem) => {
    const percent = item.size ? Math.floor((item.sent / item.size) * 100) : 0;
    const bucket = item.finishing ? 11 : Math.floor(percent / 10);
    if (toastId && bucket === lastBucket) return;
    lastBucket = bucket;
    dismissToast();
    toastId = notifications.pushEphemeralToast({
      title: TOAST_TITLE,
      body: item.finishing ? `${item.name} (finishing…)` : `${item.name} (${percent} %)`,
      durationMs: 0,
      undo: { label: "Cancel", run: () => batch.forEach((entry) => uploader.cancel(entry)) },
    });
  };
  let armed = false;
  const timer = setTimeout(() => {
    armed = true;
    const active = batch.find((item) => item.state === "uploading");
    if (active && !finished) showToast(active);
  }, TOAST_DELAY_MS);

  const uploader = createAttachmentUploader(api, {
    onProgress: (item) => {
      if (armed && !finished) showToast(item);
    },
    onSettled: (item) => {
      if (item.state === "failed") {
        notifications.showError("Upload failed", item.error, { workspaceId, profileId });
        return;
      }
      const typed = formatDroppedPaths(
        [runtimeAbsolutePath(workspace.cwd, item.record!.path, platform)],
        platform,
        kind,
      );
      if (!typed.ok) {
        notifications.showError("Upload failed", typed.error, { workspaceId, profileId });
        return;
      }
      if (write(typed.text) === false)
        notifications.showError("Upload failed", "The terminal is not ready to receive input.", {
          workspaceId,
          profileId,
        });
    },
  });
  try {
    const queued = uploader.upload(files, workspaceId);
    batch.push(...uploader.items);
    await queued;
  } finally {
    finished = true;
    clearTimeout(timer);
    dismissToast();
  }
}
