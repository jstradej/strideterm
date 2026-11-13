import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { createRootsLocalPolicy } from "./ssh-file-local-policy.js";
import { isSafeLocalName } from "./ssh-file-transfers.js";

const cleanups: string[] = [];
afterEach(async () => {
  for (const dir of cleanups.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

describe("isSafeLocalName", () => {
  test("refuses path tricks on every platform", () => {
    for (const platform of ["linux", "darwin", "win32"] as const) {
      for (const name of ["", ".", "..", "a/b", "a\\b", "a\0b"]) expect(isSafeLocalName(name, platform)).toBe(false);
      expect(isSafeLocalName("report.txt", platform)).toBe(true);
    }
  });

  test("on Windows also refuses streams, device names and names Windows would rename", () => {
    for (const name of ["a.txt:Zone.Identifier", "CON", "nul.txt", "COM1", "lpt9.log", ".git.", "x ", 'a"b', "a?b"]) {
      expect(isSafeLocalName(name, "win32"), name).toBe(false);
    }
    expect(isSafeLocalName("a.txt:Zone.Identifier", "linux")).toBe(true);
    expect(isSafeLocalName("console.log", "win32")).toBe(true);
  });
});

describe("createRootsLocalPolicy with protectGit", () => {
  async function workspace() {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "strideterm-sshfile-policy-")));
    cleanups.push(root);
    await fs.mkdir(path.join(root, ".git", "hooks"), { recursive: true });
    await fs.mkdir(path.join(root, "out"));
    return { root, policy: createRootsLocalPolicy({ roots: () => [root], protectGit: true }) };
  }

  test("refuses a destination that reaches .git through a link", async () => {
    const { root, policy } = await workspace();
    const link = path.join(root, "hooks-link");
    await fs.symlink(path.join(root, ".git", "hooks"), link, "junction");
    await expect(policy.assertWritableDir(link)).rejects.toThrow("never write into a .git directory");
    await expect(policy.assertWritableDir(path.join(root, "out"))).resolves.toBeUndefined();
  });

  test("refuses .git names Windows would map onto .git", () => {
    return workspace().then(({ policy }) => {
      for (const name of [".git", ".GIT", ".git.", ".git ", ".git.. "])
        expect(policy.rejectsName?.(name), name).toBeTruthy();
      expect(policy.rejectsName?.(".github")).toBeNull();
    });
  });
});
