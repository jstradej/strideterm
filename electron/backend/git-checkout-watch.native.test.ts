import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { expect, it, vi } from "vitest";
import { GitCheckoutWatch } from "./git-checkout-watch.js";

async function removeFixture(directory: string): Promise<void> {
  const resolved = path.resolve(directory);
  if (
    path.dirname(resolved) !== path.resolve(os.tmpdir()) ||
    !path.basename(resolved).startsWith("strideterm-git-native-watch-")
  )
    throw new Error("Invalid test cleanup path.");
  await fs.rm(resolved, { recursive: true, force: true });
}

it("observes native recursive create, repeated edits, rename and delete without waiting for polling", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "strideterm-git-native-watch-"));
  const gitDir = path.join(root, ".git");
  const directory = path.join(root, "nested");
  await Promise.all([fs.mkdir(gitDir), fs.mkdir(directory)]);
  const original = path.join(directory, "名 file.txt");
  const renamed = path.join(directory, "renamed.txt");
  const invalidations: string[] = [];
  let observed = "";
  const service = new GitCheckoutWatch({
    onInvalidate: (_key, _scope, _paths, reason) => invalidations.push(reason),
    onRefresh: async () => {
      observed = await fs.readFile(original, "utf8").catch(() => "absent");
    },
  });
  try {
    service.setTargets([{ key: root, root, gitDir, commonDir: gitDir }]);
    expect(service.getStats().watchers).toBe(2);
    await fs.writeFile(original, "first edit");
    await vi.waitFor(() => expect(observed).toBe("first edit"), { timeout: 5000 });
    await fs.writeFile(original, "second edit");
    await vi.waitFor(() => expect(observed).toBe("second edit"), { timeout: 5000 });
    await fs.rename(original, renamed);
    await vi.waitFor(() => expect(observed).toBe("absent"), { timeout: 5000 });
    const beforeDelete = invalidations.length;
    await fs.rm(renamed);
    await vi.waitFor(() => expect(invalidations.length).toBeGreaterThan(beforeDelete), { timeout: 5000 });
    expect(invalidations).not.toContain("poll");
  } finally {
    service.dispose();
    await removeFixture(root);
  }
});
