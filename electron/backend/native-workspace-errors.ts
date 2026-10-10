export type NativeWorkspaceErrorCode =
  | "invalid-directory-path"
  | "directory-not-found"
  | "parent-directory-not-found"
  | "directory-access-denied"
  | "invalid-directory-name"
  | "directory-already-exists";

export class NativeWorkspaceError extends Error {
  constructor(readonly code: NativeWorkspaceErrorCode) {
    super(code);
    this.name = "NativeWorkspaceError";
  }
}

export async function nativeWorkspaceFs<T>(
  operation: () => Promise<T>,
  missingCode: "directory-not-found" | "parent-directory-not-found",
  existingCode?: "directory-already-exists",
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    const code = error !== null && typeof error === "object" ? (error as NodeJS.ErrnoException).code : undefined;
    if (code === "ENOENT" || code === "ENOTDIR") {
      throw new NativeWorkspaceError(missingCode);
    }
    if (code === "EACCES" || code === "EPERM") {
      throw new NativeWorkspaceError("directory-access-denied");
    }
    if (code === "EEXIST" && existingCode) {
      throw new NativeWorkspaceError(existingCode);
    }
    throw error;
  }
}
