import { inject, reactive } from "vue";
import type { AttachmentRecord } from "../attachments.js";
import { rlog } from "../lib/renderer-log.js";
import type { Transport } from "../transport.js";
import { apiKey } from "../types/keys.js";

export type UploadState = "queued" | "uploading" | "done" | "failed" | "cancelled";

export interface UploadItem {
  id: string;
  workspaceId: string;
  name: string;
  size: number;
  sent: number;
  /** Every byte is sent; the host is verifying the file, which can take a while for a large one. */
  finishing: boolean;
  state: UploadState;
  error: string;
  record?: AttachmentRecord;
}

type UploadApi = Required<
  Pick<
    Transport,
    "attachmentUploadBegin" | "attachmentUploadChunk" | "attachmentUploadFinish" | "attachmentUploadCancel"
  >
>;

export interface AttachmentUploaderOptions {
  onProgress?: (item: UploadItem) => void;
  onSettled?: (item: UploadItem) => void;
  retryDelaysMs?: readonly number[];
}

const DEFAULT_RETRY_DELAYS_MS = [500, 1500] as const;
const BASE64_STEP = 3 * 4096;

export function hasAttachmentUpload(api: Partial<Transport> | null | undefined): api is Partial<Transport> & UploadApi {
  return (
    typeof api?.attachmentUploadBegin === "function" &&
    typeof api.attachmentUploadChunk === "function" &&
    typeof api.attachmentUploadFinish === "function" &&
    typeof api.attachmentUploadCancel === "function"
  );
}

export function attachmentsUnavailableReason(
  workspace: { kind?: string; panels?: Array<{ launch?: { kind?: string } | null }> } | null | undefined,
): string {
  if (!workspace) return "";
  if (workspace.kind === "docker") return "Attachments are not available in container workspaces.";
  const panels = workspace.panels ?? [];
  if (panels.length > 0 && panels.every((panel) => panel?.launch?.kind === "ssh"))
    return "Attachments are not available in SSH workspaces.";
  return "";
}

export function bytesToBase64(bytes: Uint8Array): string {
  const parts: string[] = [];
  for (let index = 0; index < bytes.length; index += BASE64_STEP) {
    parts.push(
      btoa(String.fromCharCode.apply(null, bytes.subarray(index, index + BASE64_STEP) as unknown as number[])),
    );
  }
  return parts.join("");
}

function messageOf(cause: unknown, fallback: string): string {
  return cause instanceof Error && cause.message ? cause.message : fallback;
}

function wait(ms: number): Promise<void> {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}

export function createAttachmentUploader(
  api: Partial<Transport> | null | undefined,
  options: AttachmentUploaderOptions = {},
) {
  const items = reactive<UploadItem[]>([]);
  const sources = new Map<string, { file: File; cancelled: boolean }>();
  const retryDelays = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
  let tail: Promise<unknown> = Promise.resolve();

  async function cancelOnServer(workspaceId: string, transferId: string): Promise<void> {
    try {
      await api?.attachmentUploadCancel?.({ workspaceId, transferId });
    } catch (cause) {
      rlog("warn", "[attachments] could not cancel an upload on the host", { transferId, error: messageOf(cause, "") });
    }
  }

  async function sendChunk(item: UploadItem, transferId: string, offset: number, data: string): Promise<number> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= retryDelays.length; attempt += 1) {
      if (attempt > 0) {
        await wait(retryDelays[attempt - 1]);
        if (sources.get(item.id)?.cancelled) throw new Error("cancelled");
      }
      try {
        const result = await api!.attachmentUploadChunk!({ workspaceId: item.workspaceId, transferId, offset, data });
        if (!Number.isSafeInteger(result?.received) || result.received <= offset || result.received > item.size)
          throw new Error("The other computer did not accept the data.");
        return result.received;
      } catch (cause) {
        lastError = cause;
      }
    }
    throw lastError;
  }

  async function run(item: UploadItem): Promise<void> {
    const source = sources.get(item.id);
    if (!source || source.cancelled) return;
    item.state = "uploading";
    let transferId = "";
    try {
      const begin = await api!.attachmentUploadBegin!({
        workspaceId: item.workspaceId,
        name: item.name,
        size: item.size,
        idempotencyKey: crypto.randomUUID(),
      });
      transferId = begin.transferId;
      let offset = begin.received;
      item.sent = offset;
      while (offset < item.size) {
        if (source.cancelled) {
          await cancelOnServer(item.workspaceId, transferId);
          return;
        }
        const end = Math.min(offset + begin.chunkBytes, item.size);
        const data = bytesToBase64(new Uint8Array(await source.file.slice(offset, end).arrayBuffer()));
        offset = await sendChunk(item, transferId, offset, data);
        item.sent = offset;
        options.onProgress?.(item);
      }
      if (source.cancelled) {
        await cancelOnServer(item.workspaceId, transferId);
        return;
      }
      item.finishing = true;
      options.onProgress?.(item);
      item.record = await api!.attachmentUploadFinish!({ workspaceId: item.workspaceId, transferId });
      item.state = "done";
    } catch (cause) {
      if (source.cancelled) {
        if (transferId) await cancelOnServer(item.workspaceId, transferId);
        return;
      }
      item.state = "failed";
      item.error = messageOf(cause, "The upload failed.");
      if (transferId) await cancelOnServer(item.workspaceId, transferId);
    } finally {
      item.finishing = false;
      if (item.state === "uploading") item.state = "cancelled";
    }
  }

  async function runItem(item: UploadItem): Promise<void> {
    await run(item);
    sources.delete(item.id);
    if (item.state === "done" || item.state === "failed") options.onSettled?.(item);
  }

  function upload(files: readonly File[], workspaceId: string): Promise<UploadItem[]> {
    const batch: UploadItem[] = [];
    for (const file of files) {
      const item = reactive<UploadItem>({
        id: crypto.randomUUID(),
        workspaceId,
        name: file.name,
        size: file.size,
        sent: 0,
        finishing: false,
        state: "queued",
        error: "",
      });
      items.push(item);
      batch.push(item);
      if (file.size < 1) {
        item.state = "failed";
        item.error = `"${file.name}" is empty. Empty files cannot be uploaded.`;
        options.onSettled?.(item);
        continue;
      }
      sources.set(item.id, { file, cancelled: false });
    }
    const queued = batch.filter((item) => item.state === "queued");
    const done = tail.then(async () => {
      for (const item of queued) await runItem(item);
      return batch;
    });
    tail = done.catch(() => undefined);
    return done;
  }

  function cancel(item: UploadItem): void {
    const source = sources.get(item.id);
    if (!source || (item.state !== "queued" && item.state !== "uploading")) return;
    source.cancelled = true;
    if (item.state === "queued") {
      item.state = "cancelled";
      sources.delete(item.id);
    }
  }

  function dismiss(item: UploadItem): void {
    const index = items.indexOf(item);
    if (index >= 0 && item.state !== "queued" && item.state !== "uploading") items.splice(index, 1);
  }

  return { items, upload, cancel, dismiss };
}

export function useAttachmentUpload(options: AttachmentUploaderOptions = {}) {
  const api = inject<Transport | null>(apiKey, null);
  return { api, canUpload: hasAttachmentUpload(api), ...createAttachmentUploader(api, options) };
}
