import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { AutomationCreateKeys } from "./automation-create-keys.js";

it("reserves an id before creation, joins retries, and reconciles a crash without duplicating", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "automation-create-"));
  try {
    const file = path.join(dir, "keys.json");
    const workspaces = new Set<string>();
    const store = new AutomationCreateKeys(file, (item) => workspaces.has(item.workspaceId));
    const effect = vi.fn(async (id: string) => {
      const records = JSON.parse(await readFile(file, "utf8"));
      expect(records[0]).toMatchObject({ workspaceId: id, status: "pending" });
      workspaces.add(id);
    });
    const [first, second] = await Promise.all([
      store.create("p", "parent", "key-1234", "hash", effect),
      store.create("p", "parent", "key-1234", "hash", effect),
    ]);
    expect(first).toBe(second);
    expect(effect).toHaveBeenCalledOnce();
    await expect(store.create("p", "parent", "key-1234", "other", effect)).rejects.toThrow("different request");
    const failed = new AutomationCreateKeys(path.join(dir, "crash.json"), (item) => workspaces.has(item.workspaceId));
    let reserved = "";
    await expect(
      failed.create("p", "parent", "crashkey", "hash", async (id) => {
        reserved = id;
        workspaces.add(id);
        throw new Error("crash");
      }),
    ).rejects.toThrow("crash");
    const resumed = new AutomationCreateKeys(path.join(dir, "crash.json"), (item) => workspaces.has(item.workspaceId));
    await resumed.load();
    expect(await resumed.create("p", "parent", "crashkey", "hash", effect)).toBe(reserved);
    expect(effect).toHaveBeenCalledOnce();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
