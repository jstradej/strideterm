import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createJiraAttachmentCache } from "./jira-attachment-cache.js";

const roots: string[] = [];
async function tempRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "strideterm-jira-attachment-cache-"));
  roots.push(root);
  return root;
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("Jira attachment cache", () => {
  it("round-trips bytes and media type, keyed by connection, issue and attachment", async () => {
    const cache = createJiraAttachmentCache(await tempRoot());
    await cache.put("c1", "b", "10", "5", { mediaType: "image/png", bytes: new Uint8Array([9, 8, 7, 10, 1]) });
    expect(await cache.get("c1", "b", "10", "5")).toEqual({
      mediaType: "image/png",
      bytes: new Uint8Array([9, 8, 7, 10, 1]),
    });
    expect(await cache.get("c1", "b", "11", "5")).toBeNull();
    expect(await cache.get("c2", "b", "10", "5")).toBeNull();
  });

  it("evicts the oldest files when over the cap", async () => {
    const root = await tempRoot();
    const cache = createJiraAttachmentCache(root, { maxTotalBytes: 100 });
    await cache.put("c", "b", "1", "1", { mediaType: "image/png", bytes: new Uint8Array(40) });
    await new Promise((resolve) => setTimeout(resolve, 20));
    await cache.put("c", "b", "1", "2", { mediaType: "image/png", bytes: new Uint8Array(40) });
    expect(await cache.get("c", "b", "1", "1")).toBeNull();
    expect(await cache.get("c", "b", "1", "2")).not.toBeNull();
  });

  it("removes a connection's entries and treats an unusable directory as a miss", async () => {
    const root = await tempRoot();
    const cache = createJiraAttachmentCache(root);
    await cache.put("c", "b", "1", "1", { mediaType: "image/gif", bytes: new Uint8Array([1]) });
    await cache.removeConnection("c");
    expect(await cache.get("c", "b", "1", "1")).toBeNull();
    const blocked = path.join(root, "file");
    await fs.writeFile(blocked, "x");
    const broken = createJiraAttachmentCache(path.join(blocked, "sub"));
    await expect(
      broken.put("c", "b", "1", "1", { mediaType: "image/gif", bytes: new Uint8Array([1]) }),
    ).resolves.toBeUndefined();
    expect(await broken.get("c", "b", "1", "1")).toBeNull();
  });

  it("misses for another credential binding and after the max age, and writes owner-only", async () => {
    const root = await tempRoot();
    let clock = 1_000;
    const cache = createJiraAttachmentCache(root, { maxAgeMs: 100, now: () => clock });
    await cache.put("c", "b1", "1", "1", { mediaType: "image/png", bytes: new Uint8Array([1]) });
    expect(await cache.get("c", "b2", "1", "1")).toBeNull();
    if (process.platform !== "win32") {
      const dir = path.join(root, (await fs.readdir(root))[0]!);
      expect((await fs.stat(dir)).mode & 0o777).toBe(0o700);
      expect((await fs.stat(path.join(dir, (await fs.readdir(dir))[0]!))).mode & 0o777).toBe(0o600);
    }
    clock += 99;
    expect(await cache.get("c", "b1", "1", "1")).not.toBeNull();
    clock += 1;
    expect(await cache.get("c", "b1", "1", "1")).toBeNull();
    const dir = path.join(root, (await fs.readdir(root))[0]!);
    expect(await fs.readdir(dir)).toEqual([]);
  });
});
