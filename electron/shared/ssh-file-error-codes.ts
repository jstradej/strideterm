/**
 * The one list of SSH file-transfer failure codes. A failure crosses IPC and HTTP as `{ code, message }` (plus the
 * paths of a `conflict`) so the UI can word it; the message alone is for logs and the generic toast.
 *
 * Electron drops custom error fields on a rejected `ipcMain.handle`, so over IPC the failure travels as an ordinary
 * return value in the envelope below and the sandboxed preload (which cannot import this file) rethrows it.
 */
export const SSH_FILE_ERROR_CODES = [
  "auth-required",
  "unsupported-host",
  "not-connected",
  "conflict",
  "not-found",
  "permission-denied",
  "outside-roots",
  "denied-for-mobile",
  "cancelled",
  "limit-exceeded",
  "io",
] as const;

export type SshFileErrorCode = (typeof SSH_FILE_ERROR_CODES)[number];

export function isSshFileErrorCode(value: unknown): value is SshFileErrorCode {
  return typeof value === "string" && (SSH_FILE_ERROR_CODES as readonly string[]).includes(value);
}

export const SSH_FILE_IPC_FAILURE_MARKER = "__strideSshFileFailure";

export interface SshFileIpcFailure {
  [SSH_FILE_IPC_FAILURE_MARKER]: 1;
  message: string;
  code: SshFileErrorCode;
  conflicts?: string[];
}

export function toSshFileIpcFailure(error: {
  message: string;
  code: SshFileErrorCode;
  conflicts?: string[];
}): SshFileIpcFailure {
  return {
    [SSH_FILE_IPC_FAILURE_MARKER]: 1,
    message: error.message,
    code: error.code,
    ...(error.conflicts?.length ? { conflicts: error.conflicts } : {}),
  };
}
