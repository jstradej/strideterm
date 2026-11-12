import { describe, expect, test } from "vitest";
import { SshFileError, toSshFileError } from "./ssh-file-error.js";

describe("toSshFileError", () => {
  test("replaces the bare SFTP 'Failure' text with a reason the user can read", () => {
    const failure = Object.assign(new Error("Failure"), { code: 4 });
    expect(toSshFileError(failure)).toMatchObject({
      code: "io",
      message: "The server refused the operation without giving a reason.",
    });
  });

  test("keeps other messages and passes a coded error through unchanged", () => {
    expect(toSshFileError(new Error("Disk full"))).toMatchObject({ code: "io", message: "Disk full" });
    const coded = new SshFileError("conflict", "x already exists.");
    expect(toSshFileError(coded)).toBe(coded);
  });
});
