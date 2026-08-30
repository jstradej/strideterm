import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { afterEach, describe, expect, test } from "vitest";
import { createMobileIdempotencyStore } from "./mobile-idempotency-store.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function createTempStore() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "strideterm-mobile-idempotency-"));
  tempDirs.push(dir);
  const store = createMobileIdempotencyStore(path.join(dir, "mobile-idempotency.db"));
  return store;
}

describe("mobile idempotency store", () => {
  test("recordClaimed then getByCommandId returns a claimed record", async () => {
    const store = await createTempStore();
    store.recordClaimed("cmd-1", "idem-1", "2026-01-01T00:00:00.000Z");
    const record = store.getByCommandId("cmd-1");
    expect(record).toMatchObject({
      commandId: "cmd-1",
      idempotencyKey: "idem-1",
      status: "claimed",
      resultData: null,
      completedAt: null,
    });
    store.close();
  });

  test("recordClaimed throws on a duplicate commandId (unique constraint)", async () => {
    const store = await createTempStore();
    store.recordClaimed("cmd-1", "idem-1");
    expect(() => store.recordClaimed("cmd-1", "idem-1")).toThrow();
    store.close();
  });

  test("recordResult transitions a claimed record to a terminal status with data", async () => {
    const store = await createTempStore();
    store.recordClaimed("cmd-1", "idem-1", "2026-01-01T00:00:00.000Z");
    store.recordResult("cmd-1", "succeeded", { paused: true }, null, "2026-01-01T00:00:05.000Z");
    const record = store.getByCommandId("cmd-1");
    expect(record).toMatchObject({
      status: "succeeded",
      resultData: { paused: true },
      errorCode: null,
      completedAt: "2026-01-01T00:00:05.000Z",
    });
    store.close();
  });

  test("recordResult can record outcome-unknown with an error code", async () => {
    const store = await createTempStore();
    store.recordClaimed("cmd-1", "idem-1");
    store.recordResult("cmd-1", "outcome-unknown", null, "process-crashed");
    const record = store.getByCommandId("cmd-1");
    expect(record).toMatchObject({ status: "outcome-unknown", resultData: null, errorCode: "process-crashed" });
    store.close();
  });

  test("getByIdempotencyKey finds the most recent record for a retried idempotency key", async () => {
    const store = await createTempStore();
    store.recordClaimed("cmd-1", "idem-shared", "2026-01-01T00:00:00.000Z");
    store.recordResult("cmd-1", "succeeded", { ok: true }, null);
    const record = store.getByIdempotencyKey("idem-shared");
    expect(record?.commandId).toBe("cmd-1");
    expect(record?.status).toBe("succeeded");
    store.close();
  });

  test("getByCommandId returns null for an unknown command", async () => {
    const store = await createTempStore();
    expect(store.getByCommandId("nonexistent")).toBeNull();
    expect(store.getByIdempotencyKey("nonexistent")).toBeNull();
    store.close();
  });

  test("prune removes rows older than the retention window", async () => {
    const store = await createTempStore();
    const old = new Date(Date.now() - 48 * 3_600_000).toISOString();
    store.recordClaimed("cmd-old", "idem-old", old);
    store.recordClaimed("cmd-new", "idem-new");
    store.prune(24);
    expect(store.getByCommandId("cmd-old")).toBeNull();
    expect(store.getByCommandId("cmd-new")).not.toBeNull();
    store.close();
  });
});
