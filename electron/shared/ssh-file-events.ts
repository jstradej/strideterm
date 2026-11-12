import { z } from "zod";
import { SSH_FILE_ERROR_CODES } from "./ssh-file-error-codes.js";

/**
 * SSH file transfers (upload / download between the desktop's disk and an SSH host) can outlast the 30 s a remote
 * request may take to START its response over the mobile relay, so a transfer never answers the request that started
 * it. The start call returns a `transferId` at once; the runtime keeps "running" and the last runs in the
 * profile-scoped state payload (`sshFileTransfers`), streams `ssh-file:transfer-progress`, and ends each transfer
 * with ONE `ssh-file:transfer-finished` of the shape below — the same object that becomes the payload's last run.
 *
 * `profileId` is the EFFECTIVE profile of the workspace the transfer was started from: the remote server routes the
 * events only to clients bound to it.
 */
export const SSH_FILE_TRANSFER_PROGRESS_CHANNEL = "ssh-file:transfer-progress";
export const SSH_FILE_TRANSFER_FINISHED_CHANNEL = "ssh-file:transfer-finished";

export const sshFileDirectionSchema = z.enum(["upload", "download"]);
export type SshFileDirection = z.infer<typeof sshFileDirectionSchema>;

export const sshFileTransferProgressSchema = z
  .object({
    transferId: z.string().min(1),
    profileId: z.string().min(1),
    bytesDone: z.number().int().nonnegative(),
    bytesTotal: z.number().int().nonnegative(),
    filesDone: z.number().int().nonnegative(),
    filesTotal: z.number().int().nonnegative(),
    currentPath: z.string(),
  })
  .strict();
export type SshFileTransferProgress = z.infer<typeof sshFileTransferProgressSchema>;

export const sshFileTransferResultSchema = z
  .object({
    files: z.number().int().nonnegative(),
    bytes: z.number().int().nonnegative(),
    skipped: z.array(z.object({ path: z.string(), reason: z.string() }).strict()),
  })
  .strict();
export type SshFileTransferResult = z.infer<typeof sshFileTransferResultSchema>;

export const sshFileTransferErrorSchema = z
  .object({
    code: z.enum(SSH_FILE_ERROR_CODES),
    message: z.string(),
    conflicts: z.array(z.string()).optional(),
  })
  .strict();
export type SshFileTransferError = z.infer<typeof sshFileTransferErrorSchema>;

export const sshFileTransferStateSchema = z.enum(["running", "succeeded", "failed", "cancelled"]);
export type SshFileTransferState = z.infer<typeof sshFileTransferStateSchema>;

export const sshFileTransferRunSchema = z
  .object({
    transferId: z.string().min(1),
    profileId: z.string().min(1),
    workspaceId: z.string().min(1),
    direction: sshFileDirectionSchema,
    /** "ui" for a window or remote client, "mcp" for an agent's tool. */
    source: z.enum(["ui", "mcp"]),
    hostLabel: z.string(),
    state: sshFileTransferStateSchema,
    startedAt: z.string().min(1),
    finishedAt: z.string().nullable(),
    bytesDone: z.number().int().nonnegative(),
    bytesTotal: z.number().int().nonnegative(),
    filesDone: z.number().int().nonnegative(),
    filesTotal: z.number().int().nonnegative(),
    currentPath: z.string(),
    result: sshFileTransferResultSchema.optional(),
    error: sshFileTransferErrorSchema.optional(),
  })
  .strict();
export type SshFileTransferRun = z.infer<typeof sshFileTransferRunSchema>;

export const sshFileTransferFinishedSchema = z
  .object({
    transferId: z.string().min(1),
    profileId: z.string().min(1),
    workspaceId: z.string().min(1),
    direction: sshFileDirectionSchema,
    source: z.enum(["ui", "mcp"]),
    hostLabel: z.string(),
    state: z.enum(["succeeded", "failed", "cancelled"]),
    startedAt: z.string().min(1),
    finishedAt: z.string().min(1),
    result: sshFileTransferResultSchema.optional(),
    error: sshFileTransferErrorSchema.optional(),
  })
  .strict();
export type SshFileTransferFinished = z.infer<typeof sshFileTransferFinishedSchema>;

/** Payload of `sshFileTransfers` in the runtime state: what is running, and what finished within 24 h. */
export interface SshFileTransfersState {
  running: SshFileTransferRun[];
  lastRuns: SshFileTransferRun[];
}

/** One entry of a remote directory listing. */
export interface SshFileEntry {
  name: string;
  type: "file" | "dir" | "symlink" | "other";
  size: number;
  mtimeMs: number;
  mode: number;
  linkTarget?: string;
}

export interface SshFileListing {
  path: string;
  entries: SshFileEntry[];
  truncated: boolean;
}

export interface SshFileTransferStarted {
  started: true;
  transferId: string;
}
