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
  return records.map((entry) => {
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
  });
}
