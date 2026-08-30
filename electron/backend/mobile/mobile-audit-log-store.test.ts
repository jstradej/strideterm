import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { afterEach, describe, expect, test } from "vitest";
import { createMobileAuditLogStore } from "./mobile-audit-log-store.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function createTempStore() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "strideterm-mobile-audit-"));
  tempDirs.push(dir);
  return createMobileAuditLogStore(path.join(dir, "mobile-audit-log.db"));
}

describe("mobile audit log store", () => {
  test("logEntry + query round trip", async () => {
    const store = await createTempStore();
    store.logEntry({
      deviceId: "dev-1",
      pairId: "pair-1",
      actor: "device",
      action: "command.task.pause",
      status: "success",
      detail: "workspaceId=ws-1",
    });
    const { entries, total } = store.query();
    expect(total).toBe(1);
    expect(entries[0]).toMatchObject({
      deviceId: "dev-1",
      pairId: "pair-1",
      actor: "device",
      action: "command.task.pause",
      status: "success",
      detail: "workspaceId=ws-1",
    });
    store.close();
  });

  test("never has a column that could hold ciphertext/plaintext payload content", async () => {
    const store = await createTempStore();
    store.logEntry({ deviceId: "dev-1", pairId: "pair-1", actor: "device", action: "event.sent", status: "success" });
    const { entries } = store.query();
    const fields = Object.keys(entries[0]);
    expect(fields).toEqual(["id", "timestamp", "deviceId", "pairId", "actor", "action", "status", "detail"]);
    for (const field of fields) {
      expect(field.toLowerCase()).not.toContain("ciphertext");
      expect(field.toLowerCase()).not.toContain("payload");
      expect(field.toLowerCase()).not.toContain("plaintext");
    }
    store.close();
  });

  test("query filters by deviceId, action, and status", async () => {
    const store = await createTempStore();
    store.logEntry({
      deviceId: "dev-1",
      pairId: "pair-1",
      actor: "device",
      action: "command.task.pause",
      status: "success",
    });
    store.logEntry({
      deviceId: "dev-2",
      pairId: "pair-1",
      actor: "device",
      action: "command.task.resume",
      status: "failure",
    });
    expect(store.query({ deviceId: "dev-1" }).total).toBe(1);
    expect(store.query({ action: "command.task.resume" }).total).toBe(1);
    expect(store.query({ status: "failure" }).total).toBe(1);
    store.close();
  });

  test("getEntryCount reflects total rows", async () => {
    const store = await createTempStore();
    expect(store.getEntryCount()).toBe(0);
    store.logEntry({
      deviceId: "dev-1",
      pairId: "pair-1",
      actor: "desktop",
      action: "device.revoked",
      status: "success",
    });
    expect(store.getEntryCount()).toBe(1);
    store.close();
  });

  test("prune removes rows older than the retention window", async () => {
    const store = await createTempStore();
    const old = new Date(Date.now() - 40 * 86_400_000).toISOString();
    store.logEntry({
      timestamp: old,
      deviceId: "dev-1",
      pairId: "pair-1",
      actor: "desktop",
      action: "old",
      status: "success",
    });
    store.logEntry({ deviceId: "dev-2", pairId: "pair-1", actor: "desktop", action: "new", status: "success" });
    store.prune(30);
    expect(store.getEntryCount()).toBe(1);
    expect(store.query({ action: "new" }).total).toBe(1);
    store.close();
  });
});
