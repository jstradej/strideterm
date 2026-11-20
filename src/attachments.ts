import type {
  AttachmentReadResult,
  AttachmentUploadBeginResult,
  AttachmentUploadChunkResult,
} from "../electron/shared/attachment-upload.js";

export interface AttachmentRecord {
  transferId: string;
  path: string;
  size: number;
  sha256: string;
  name: string;
  uploadedAt?: number;
}

export interface AttachmentWorkspaceRequest {
  workspaceId: string;
}

export interface AttachmentDeleteRequest extends AttachmentWorkspaceRequest {
  transferId: string;
  name: string;
}

export interface AttachmentDeleteResult {
  ok: boolean;
}

export type AttachmentListResponse = AttachmentRecord[] | { attachments: AttachmentRecord[] };

export function normalizeAttachmentList(value: unknown): AttachmentRecord[] {
  const records = Array.isArray(value)
    ? value
    : value && typeof value === "object" && Array.isArray((value as { attachments?: unknown }).attachments)
      ? (value as { attachments: unknown[] }).attachments
      : null;
  if (!records) throw new Error("Invalid attachment list response");
  return records.map(parseAttachmentRecord);
}

export function parseAttachmentRecord(entry: unknown): AttachmentRecord {
  if (!entry || typeof entry !== "object") throw new Error("Invalid attachment list response");
  const record = entry as Record<string, unknown>;
  if (
    typeof record.transferId !== "string" ||
    typeof record.path !== "string" ||
    typeof record.name !== "string" ||
    typeof record.sha256 !== "string" ||
    typeof record.size !== "number"
  ) {
    throw new Error("Invalid attachment list response");
  }
  const normalized: AttachmentRecord = {
    transferId: record.transferId,
    path: record.path,
    size: record.size,
    sha256: record.sha256,
    name: record.name,
  };
  if (Number.isSafeInteger(record.uploadedAt) && (record.uploadedAt as number) >= 0) {
    normalized.uploadedAt = record.uploadedAt as number;
  }
  return normalized;
}

export function parseUploadBegin(value: unknown): AttachmentUploadBeginResult {
  const v = value as Partial<AttachmentUploadBeginResult> | null;
  if (
    !v ||
    typeof v.transferId !== "string" ||
    !Number.isSafeInteger(v.chunkBytes) ||
    !Number.isSafeInteger(v.received)
  )
    throw new Error("Invalid attachment upload response");
  return { transferId: v.transferId, chunkBytes: v.chunkBytes as number, received: v.received as number };
}

export function parseUploadChunk(value: unknown): AttachmentUploadChunkResult {
  const v = value as Partial<AttachmentUploadChunkResult> | null;
  if (!v || !Number.isSafeInteger(v.received)) throw new Error("Invalid attachment upload response");
  return { received: v.received as number };
}

export function parseAttachmentRead(value: unknown): AttachmentReadResult {
  const v = value as Partial<AttachmentReadResult> | null;
  if (!v || typeof v.data !== "string" || !Number.isSafeInteger(v.size) || typeof v.eof !== "boolean")
    throw new Error("Invalid attachment read response");
  return { data: v.data, size: v.size as number, eof: v.eof };
}

export function parseOk(value: unknown): { ok: true } {
  if (!value || typeof value !== "object" || (value as { ok?: unknown }).ok !== true)
    throw new Error("Invalid attachment upload response");
  return { ok: true };
}
