export const FILE_CHANGED_ON_DISK = "FILE_CHANGED_ON_DISK";

export function fileChangedOnDiskMessage(relativePath: string, deleted: boolean): string {
  return `${FILE_CHANGED_ON_DISK}: ${relativePath} ${deleted ? "was deleted" : "changed"} on disk since it was opened`;
}

/** The code survives IPC and HTTP only inside the message, so detection is by substring. */
export function isFileChangedOnDiskError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : typeof err === "string" ? err : "";
  return message.includes(FILE_CHANGED_ON_DISK);
}
