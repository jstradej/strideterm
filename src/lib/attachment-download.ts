import type { AttachmentRecord } from "../attachments.js";
import type { Transport } from "../transport.js";
import { ATTACHMENT_READ_MAX_BYTES } from "../../electron/shared/attachment-upload.js";

export class AttachmentDownloadCancelled extends Error {
  constructor() {
    super("Download cancelled");
  }
}

function base64ToBytes(data: string): Uint8Array {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

export async function readAttachment(
  api: Partial<Transport>,
  request: {
    workspaceId: string;
    attachment: AttachmentRecord;
    signal?: AbortSignal;
    onProgress?: (read: number) => void;
  },
): Promise<Blob> {
  if (typeof api.attachmentRead !== "function") throw new Error("Reading attachments is not available here.");
  const { workspaceId, attachment, signal, onProgress } = request;
  const parts: Uint8Array[] = [];
  let offset = 0;
  for (;;) {
    if (signal?.aborted) throw new AttachmentDownloadCancelled();
    const result = await api.attachmentRead({
      workspaceId,
      transferId: attachment.transferId,
      name: attachment.name,
      offset,
      length: ATTACHMENT_READ_MAX_BYTES,
    });
    const bytes = base64ToBytes(result.data);
    if (bytes.length === 0 && !result.eof) throw new Error("The other computer returned no data.");
    parts.push(bytes);
    offset += bytes.length;
    onProgress?.(offset);
    if (result.eof) break;
  }
  if (signal?.aborted) throw new AttachmentDownloadCancelled();
  return new Blob(parts as BlobPart[], { type: "application/octet-stream" });
}

export function saveBlobAsDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
