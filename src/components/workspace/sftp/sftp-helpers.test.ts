import { describe, expect, test } from "vitest";
import type { SshFileEntry } from "../../../../electron/shared/ssh-file-events.js";
import {
  breadcrumbs,
  formatMode,
  formatModified,
  isNavigable,
  isSafeRelativeFolder,
  joinLocal,
  joinRemote,
  parentPath,
  sortEntries,
} from "./sftp-helpers.js";

const entry = (name: string, overrides: Partial<SshFileEntry> = {}): SshFileEntry => ({
  name,
  type: "file",
  size: 1,
  mtimeMs: 0,
  mode: 0o644,
  ...overrides,
});

describe("sftp helpers", () => {
  test("remote paths are POSIX, including Windows OpenSSH drive paths", () => {
    expect(parentPath("/a/b/c")).toBe("/a/b");
    expect(parentPath("/a")).toBe("/");
    expect(parentPath("/")).toBe("/");
    expect(parentPath("/C:/Users/me")).toBe("/C:/Users");
    expect(joinRemote("/a/b/", "c")).toBe("/a/b/c");
    expect(joinRemote("/", "c")).toBe("/c");
    expect(breadcrumbs("/C:/Users")).toEqual([
      { name: "/", path: "/" },
      { name: "C:", path: "/C:" },
      { name: "Users", path: "/C:/Users" },
    ]);
  });

  test("folders stay on top for every sort, and the direction flips the rest", () => {
    const list = [entry("b", { size: 5 }), entry("a", { size: 9 }), entry("zdir", { type: "dir" })];
    expect(sortEntries(list, { key: "name", dir: "asc" }).map((e) => e.name)).toEqual(["zdir", "a", "b"]);
    expect(sortEntries(list, { key: "size", dir: "desc" }).map((e) => e.name)).toEqual(["zdir", "a", "b"]);
    expect(sortEntries(list, { key: "size", dir: "asc" }).map((e) => e.name)).toEqual(["zdir", "b", "a"]);
    expect(sortEntries([entry("file10"), entry("file2")], { key: "name", dir: "asc" }).map((e) => e.name)).toEqual([
      "file2",
      "file10",
    ]);
  });

  test("mode and time formatting", () => {
    expect(formatMode({ type: "dir", mode: 0o755 })).toBe("drwxr-xr-x");
    expect(formatMode({ type: "file", mode: 0o600 })).toBe("-rw-------");
    expect(formatMode({ type: "symlink", mode: 0o777 })).toBe("lrwxrwxrwx");
    expect(formatModified(0)).toBe("");
    expect(formatModified(new Date(2026, 0, 2, 3, 4).getTime())).toBe("2026-01-02 03:04");
  });

  test("a symbolic link may be opened, a plain file not", () => {
    expect(isNavigable(entry("l", { type: "symlink" }))).toBe(true);
    expect(isNavigable(entry("d", { type: "dir" }))).toBe(true);
    expect(isNavigable(entry("f"))).toBe(false);
  });

  test("a local target is joined in the root's own style and never climbs out", () => {
    expect(joinLocal("C:\\work\\app", "out/sub")).toBe("C:\\work\\app\\out\\sub");
    expect(joinLocal("/work/app/", "out")).toBe("/work/app/out");
    expect(joinLocal("/work/app", "")).toBe("/work/app");
    expect(joinLocal("/work/app", "./a//b/")).toBe("/work/app/a/b");
    expect(isSafeRelativeFolder("a/b")).toBe(true);
    expect(isSafeRelativeFolder("a/../b")).toBe(false);
    expect(isSafeRelativeFolder("..\\x")).toBe(false);
  });
});
