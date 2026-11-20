import { z } from "zod";

/**
 * Upload and read of workspace attachments for desktop-class callers (a local window, a window attached to
 * another desktop, the web client). Every call is one short request; a file moves in blocks. The phone has its
 * own sealed path with its own limits and does not use any of this.
 */
export const ATTACHMENT_UPLOAD_CHUNK_BYTES = 512 * 1024;
export const ATTACHMENT_READ_MAX_BYTES = 512 * 1024;
export const ATTACHMENT_UPLOAD_MAX_FILE_BYTES = 1024 * 1024 * 1024;

export interface AttachmentUploadBeginRequest {
  workspaceId: string;
  name: string;
  size: number;
  idempotencyKey?: string;
}
export interface AttachmentUploadBeginResult {
  transferId: string;
  chunkBytes: number;
  received: number;
}
export interface AttachmentUploadChunkRequest {
  workspaceId: string;
  transferId: string;
  offset: number;
  data: string;
}
export interface AttachmentUploadChunkResult {
  received: number;
}
export interface AttachmentTransferRequest {
  workspaceId: string;
  transferId: string;
}
export interface AttachmentReadRequest {
  workspaceId: string;
  transferId: string;
  name: string;
  offset: number;
  length: number;
}
export interface AttachmentReadResult {
  data: string;
  size: number;
  eof: boolean;
}

const workspaceId = z.string().min(1);
const transferId = z.string().uuid();
const MAX_BASE64_CHUNK_CHARS = Math.ceil(ATTACHMENT_UPLOAD_CHUNK_BYTES / 3) * 4;

export const attachmentUploadBeginSchema = z
  .object({
    workspaceId,
    name: z.string().min(1).max(255),
    size: z.number().int().min(1).max(ATTACHMENT_UPLOAD_MAX_FILE_BYTES),
    idempotencyKey: z.string().min(1).max(256).optional(),
  })
  .strict();

export const attachmentUploadChunkSchema = z
  .object({
    workspaceId,
    transferId,
    offset: z.number().int().min(0),
    data: z
      .string()
      .min(4)
      .max(MAX_BASE64_CHUNK_CHARS)
      .regex(/^[A-Za-z0-9+/]+={0,2}$/),
  })
  .strict();

export const attachmentTransferSchema = z.object({ workspaceId, transferId }).strict();

export const attachmentReadSchema = z
  .object({
    workspaceId,
    transferId,
    name: z.string().min(1).max(255),
    offset: z.number().int().min(0),
    length: z.number().int().min(1).max(ATTACHMENT_READ_MAX_BYTES),
  })
  .strict();
