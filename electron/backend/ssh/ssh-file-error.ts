import type { SshFileErrorCode } from "../../shared/ssh-file-error-codes.js";

export class SshFileError extends Error {
  readonly code: SshFileErrorCode;
  readonly conflicts?: string[];

  constructor(code: SshFileErrorCode, message: string, conflicts?: string[]) {
    super(message);
    this.name = "SshFileError";
    this.code = code;
    if (conflicts?.length) this.conflicts = conflicts;
  }
}

const SFTP_NO_SUCH_FILE = 2;
const SFTP_PERMISSION_DENIED = 3;

/** Maps whatever an SFTP / fs call threw onto a coded failure; an `SshFileError` passes through. */
export function toSshFileError(error: unknown, fallback = "SSH file operation failed."): SshFileError {
  if (error instanceof SshFileError) return error;
  const message = error instanceof Error && error.message ? error.message : fallback;
  const code = (error as { code?: unknown } | null)?.code;
  if (code === SFTP_NO_SUCH_FILE || code === "ENOENT") return new SshFileError("not-found", message);
  if (code === SFTP_PERMISSION_DENIED || code === "EACCES" || code === "EPERM") {
    return new SshFileError("permission-denied", message);
  }
  return new SshFileError("io", message);
}
