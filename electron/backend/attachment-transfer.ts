import * as attachments from "./attachments.js";
import {
  ATTACHMENT_UPLOAD_CHUNK_BYTES,
  type AttachmentReadRequest,
  type AttachmentReadResult,
  type AttachmentTransferRequest,
  type AttachmentUploadBeginRequest,
  type AttachmentUploadBeginResult,
  type AttachmentUploadChunkRequest,
  type AttachmentUploadChunkResult,
} from "../shared/attachment-upload.js";

/**
 * Upload and read for desktop-class callers, shared by the desktop IPC and the remote HTTP routes. `root` is
 * already resolved and authorized by the front door; `owner` is the window id or the remote viewer id that began
 * the transfer, and only it may continue, finish or cancel it.
 */
function requireOwner(owner: string): string {
  if (!owner) throw new Error("Attachment upload needs a caller identity");
  return owner;
}

export async function begin(
  root: string,
  request: AttachmentUploadBeginRequest,
  owner: string,
): Promise<AttachmentUploadBeginResult> {
  const started = await attachments.begin(
    root,
    request.name,
    request.size,
    "",
    requireOwner(owner),
    request.idempotencyKey,
    attachments.DESKTOP_LIMITS,
  );
  return { transferId: started.transferId, chunkBytes: ATTACHMENT_UPLOAD_CHUNK_BYTES, received: started.offset };
}

export async function chunk(
  root: string,
  request: AttachmentUploadChunkRequest,
  owner: string,
): Promise<AttachmentUploadChunkResult> {
  const result = await attachments.chunk(root, request.transferId, request.offset, request.data, requireOwner(owner));
  return { received: result.offset };
}

export async function finish(root: string, request: AttachmentTransferRequest, owner: string) {
  await attachments.finish(root, request.transferId, requireOwner(owner));
  return attachments.record(root, request.transferId);
}

export async function cancel(root: string, request: AttachmentTransferRequest, owner: string) {
  return attachments.cancel(root, request.transferId, requireOwner(owner));
}

export async function read(root: string, request: AttachmentReadRequest): Promise<AttachmentReadResult> {
  const { bytes, size } = await attachments.read(
    root,
    request.transferId,
    request.name,
    request.offset,
    request.length,
  );
  return { data: bytes.toString("base64"), size, eof: request.offset + bytes.length >= size };
}
