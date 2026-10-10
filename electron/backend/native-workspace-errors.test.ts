import { describe, expect, test } from "vitest";
import { nativeWorkspaceFs } from "./native-workspace-errors.js";

describe("native workspace filesystem failures", () => {
  test("maps only missing and permission failures while preserving unexpected I/O errors", async () => {
    const missing = Object.assign(new Error("gone"), { code: "ENOENT" });
    await expect(nativeWorkspaceFs(async () => Promise.reject(missing), "directory-not-found")).rejects.toMatchObject({
      code: "directory-not-found",
    });

    const denied = Object.assign(new Error("private path text"), { code: "EACCES" });
    await expect(nativeWorkspaceFs(async () => Promise.reject(denied), "directory-not-found")).rejects.toMatchObject({
      name: "NativeWorkspaceError",
      code: "directory-access-denied",
    });

    const io = Object.assign(new Error("disk I/O failed"), { code: "EIO" });
    await expect(nativeWorkspaceFs(async () => Promise.reject(io), "directory-not-found")).rejects.toBe(io);

    const exists = Object.assign(new Error("already exists"), { code: "EEXIST" });
    await expect(
      nativeWorkspaceFs(async () => Promise.reject(exists), "parent-directory-not-found", "directory-already-exists"),
    ).rejects.toMatchObject({ code: "directory-already-exists" });

    await expect(
      nativeWorkspaceFs(async () => Promise.reject("non-object failure"), "directory-not-found"),
    ).rejects.toBe("non-object failure");
  });
});
