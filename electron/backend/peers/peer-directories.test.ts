import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PeerDirectoryError, listPeerDirectories, probeWindowsDriveRoots } from "./peer-directories.js";

let root: string;
let home: string;

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "peer-dirs-")));
  home = path.join(root, "home");
  fs.mkdirSync(home);
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const options = () => ({ homeDir: () => home, driveRoots: async () => ["Z:\\"] });

async function refusal(requested: string): Promise<PeerDirectoryError> {
  const error = await listPeerDirectories(requested, options()).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(PeerDirectoryError);
  return error as PeerDirectoryError;
}

describe("listPeerDirectories", () => {
  it("lists sub-folders only, sorted case-insensitively, never files", async () => {
    const tree = path.join(root, "tree");
    for (const name of ["beta", "Alpha", "alpine", "Gamma"]) fs.mkdirSync(path.join(tree, name), { recursive: true });
    fs.writeFileSync(path.join(tree, "secret.txt"), "do not leak");
    const listing = await listPeerDirectories(tree, options());
    expect(listing.entries.map((entry) => entry.name)).toEqual(["Alpha", "alpine", "beta", "Gamma"]);
    expect(JSON.stringify(listing)).not.toContain("secret");
    expect(listing.path).toBe(tree);
    expect(listing.parent).toBe(root);
    expect(listing.separator).toBe(path.sep);
    expect(listing.truncated).toBe(false);
    expect(Object.keys(listing.entries[0]!)).toEqual(["name"]);
  });

  it("treats an empty path as the home folder and offers it as a root", async () => {
    fs.mkdirSync(path.join(home, "work"));
    const listing = await listPeerDirectories("", options());
    expect(listing.path).toBe(home);
    expect(listing.entries).toEqual([{ name: "work" }]);
    expect(listing.roots[0]).toBe(home);
    expect(listing.roots).toContain(process.platform === "win32" ? "Z:\\" : "/");
  });

  it("normalises the path, and a filesystem root has no parent", async () => {
    fs.mkdirSync(path.join(root, "a", "b"), { recursive: true });
    const listing = await listPeerDirectories(path.join(root, "a", "b", "..", "b") + path.sep, options());
    expect(listing.path).toBe(path.join(root, "a", "b"));
    const top = await listPeerDirectories(path.parse(root).root, options());
    expect(top.parent).toBeNull();
  });

  it("lists a link to a folder under its own name and skips a broken link", async () => {
    const tree = path.join(root, "links");
    fs.mkdirSync(path.join(tree, "real"), { recursive: true });
    fs.writeFileSync(path.join(root, "a-file"), "x");
    try {
      fs.symlinkSync(path.join(tree, "real"), path.join(tree, "to-real"), "junction");
      fs.symlinkSync(path.join(root, "missing-target"), path.join(tree, "broken"), "junction");
      fs.symlinkSync(path.join(root, "a-file"), path.join(tree, "to-file"));
    } catch {
      return;
    }
    const names = (await listPeerDirectories(tree, options())).entries.map((entry) => entry.name);
    expect(names).toEqual(["real", "to-real"]);
  });

  it("truncates at the cap and says so", async () => {
    const tree = path.join(root, "many");
    for (const name of ["a", "b", "c", "d", "e"]) fs.mkdirSync(path.join(tree, name), { recursive: true });
    const listing = await listPeerDirectories(tree, { ...options(), maxEntries: 3 });
    expect(listing.entries.map((entry) => entry.name)).toEqual(["a", "b", "c"]);
    expect(listing.truncated).toBe(true);
    expect((await listPeerDirectories(tree, { ...options(), maxEntries: 5 })).truncated).toBe(false);
  });

  it("refuses with a sentence, never an errno or a stack", async () => {
    expect(await refusal("relative/path")).toMatchObject({ status: 400, message: "The folder path must be absolute." });
    expect(await refusal(path.join(root, "x\0y"))).toMatchObject({
      status: 400,
      message: "The folder path is not valid.",
    });
    expect(await refusal(path.join(root, "nope"))).toMatchObject({
      status: 404,
      message: "That folder was not found.",
    });
    const file = path.join(root, "file.txt");
    fs.writeFileSync(file, "x");
    expect(await refusal(file)).toMatchObject({ status: 400, message: "That path is not a folder." });
    expect(await refusal(path.join(file, "inside"))).toMatchObject({ status: expect.any(Number) });
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)("refuses a folder it cannot read", async () => {
    const locked = path.join(root, "locked");
    fs.mkdirSync(locked);
    fs.chmodSync(locked, 0o000);
    try {
      expect(await refusal(locked)).toMatchObject({ status: 403, message: "That folder cannot be read." });
    } finally {
      fs.chmodSync(locked, 0o700);
    }
  });

  it.skipIf(process.platform !== "win32")(
    "rejects drive-relative and accepts drive and UNC absolute paths",
    async () => {
      expect(await refusal("C:relative")).toMatchObject({ status: 400 });
      expect((await listPeerDirectories(root, options())).path).toBe(root);
      expect(await refusal(String.raw`\\no-such-host-for-peer-test\share`)).toMatchObject({
        status: expect.any(Number),
      });
    },
  );
});

describe("probeWindowsDriveRoots", () => {
  it.skipIf(process.platform !== "win32")("finds the drive this process runs on without a shell", async () => {
    const roots = await probeWindowsDriveRoots();
    const ownDrive = path.parse(process.cwd()).root.slice(0, 1).toUpperCase() + ":\\";
    expect(roots).toContain(ownDrive);
    expect(roots.every((entry) => /^[A-Z]:\\$/.test(entry))).toBe(true);
  });
});
