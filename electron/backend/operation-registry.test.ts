import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  createOperationRegistry,
  OperationIdempotencyConflictError,
  type OperationRecord,
} from "./operation-registry.js";
import { operationFinishedSchema, type OperationFinished } from "../shared/operation-events.js";

const log = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn(), trace: vi.fn() };

describe("operation registry", () => {
  let dir: string;
  let clock: number;
  let events: OperationFinished[];
  let changes: number;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "operation-registry-"));
    clock = Date.parse("2026-10-17T10:00:00Z");
    events = [];
    changes = 0;
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  const create = () =>
    createOperationRegistry({
      dir,
      log: log as never,
      now: () => clock,
      emitFinished: (event) => events.push(event),
      onChange: () => {
        changes += 1;
      },
    });

  const input = (overrides: Record<string, unknown> = {}) => ({
    kind: "task.provision",
    profileId: "default",
    originWorkspaceId: "parent",
    idempotencyKey: "key-00000001",
    inputHash: "a".repeat(64),
    initialStep: "creating-workspace",
    intent: { reserved: "workspace-1" },
    ...overrides,
  });

  async function settle(registry: ReturnType<typeof create>, operationId: string) {
    for (let attempt = 0; attempt < 100 && registry.isRunning(operationId); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  test("writes the intent before answering and persists steps, artifacts and the outcome", async () => {
    const registry = create();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { record, replayed } = await registry.accept(input(), async (handle) => {
      await handle.update({ step: "starting", artifacts: { worktree: "/tmp/x" }, workspaceId: "workspace-1" });
      await gate;
      return { workspaceId: "workspace-1" };
    });
    expect(replayed).toBe(false);
    const onDisk = JSON.parse(
      await fs.readFile(path.join(dir, `${record.operationId}.json`), "utf8"),
    ) as OperationRecord;
    expect(["accepted", "running"]).toContain(onDisk.status);
    expect(onDisk).toMatchObject({ idempotencyKey: "key-00000001", intent: { reserved: "workspace-1" } });
    await fs.stat(path.join(dir, `${record.operationId}.json`));

    for (
      let attempt = 0;
      attempt < 100 && registry.get(record.operationId, "default")?.step !== "starting";
      attempt += 1
    ) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(registry.snapshot().running).toEqual([
      expect.objectContaining({ operationId: record.operationId, step: "starting", workspaceId: "workspace-1" }),
    ]);
    release();
    await settle(registry, record.operationId);

    await expect(fs.stat(path.join(dir, `${record.operationId}.json.tmp`))).rejects.toThrow();
    const done = registry.get(record.operationId, "default")!;
    expect(done).toMatchObject({ status: "succeeded", step: "ready", artifacts: { worktree: "/tmp/x" } });
    expect(events).toHaveLength(1);
    expect(operationFinishedSchema.safeParse(events[0]).success).toBe(true);
    expect(events[0]).toMatchObject({
      operationId: record.operationId,
      profileId: "default",
      result: { workspaceId: "workspace-1" },
    });
    expect(changes).toBeGreaterThan(2);
  });

  test("a throwing run becomes a failed outcome with the error's own code", async () => {
    log.warn.mockClear();
    const registry = create();
    const { record } = await registry.accept(input({ intent: { rootPath: "C:/repo" } }), async () => {
      clock += 1250;
      throw Object.assign(new Error("branch exists"), { code: "checkout_conflict" });
    });
    await settle(registry, record.operationId);
    expect(registry.get(record.operationId, "default")).toMatchObject({
      status: "failed",
      step: "failed",
      error: { code: "checkout_conflict", message: "branch exists" },
    });
    expect(events[0]).toMatchObject({ error: { code: "checkout_conflict", message: "branch exists" } });
    expect("result" in events[0]).toBe(false);
    expect(log.warn).toHaveBeenCalledWith(
      "operation failed",
      expect.objectContaining({
        operationId: record.operationId,
        kind: "task.provision",
        profileId: "default",
        originWorkspaceId: "parent",
        rootPath: "C:/repo",
        durationMs: 1250,
        code: "checkout_conflict",
      }),
    );
  });

  test("redacts credentials from persisted rejected-operation diagnostics", async () => {
    const registry = create();
    const { record } = await registry.accept(input(), async () => {
      throw Object.assign(new Error("request failed at https://example.test/?access_token=super-secret-token"), {
        code: "git_operation_failed",
        warnings: ["Authorization: Bearer abcdefghijklmnopqrstuvwxyz-secret"],
        rawOutput: "remote returned https://example.test/?auth=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.signature",
      });
    });
    await settle(registry, record.operationId);

    const outcome = registry.get(record.operationId, "default")!;
    expect(outcome.error?.message).toContain("access_token=[REDACTED]");
    expect(outcome.error?.message).not.toContain("super-secret-token");
    expect(outcome.error?.warnings?.[0]).toContain("Bearer [REDACTED]");
    expect(outcome.error?.rawOutput).toContain("auth=[REDACTED]");
    expect(JSON.stringify(outcome)).not.toContain("abcdefghijklmnopqrstuvwxyz-secret");
    expect(JSON.stringify(events)).not.toContain("super-secret-token");
  });

  test("the same key and input is one operation, even when the requests race; another input conflicts", async () => {
    const registry = create();
    const runner = vi.fn(async () => ({}));
    const [first, second] = await Promise.all([registry.accept(input(), runner), registry.accept(input(), runner)]);
    expect(second.record.operationId).toBe(first.record.operationId);
    expect([first.replayed, second.replayed].sort()).toEqual([false, true]);
    await settle(registry, first.record.operationId);
    expect(runner).toHaveBeenCalledTimes(1);
    await expect(registry.accept(input({ inputHash: "b".repeat(64) }), runner)).rejects.toBeInstanceOf(
      OperationIdempotencyConflictError,
    );
    // a different origin workspace or profile is a different scope
    const other = await registry.accept(input({ originWorkspaceId: "elsewhere" }), runner);
    expect(other.record.operationId).not.toBe(first.record.operationId);
    const otherProfile = await registry.accept(input({ profileId: "other" }), runner);
    expect(otherProfile.record.operationId).not.toBe(first.record.operationId);
  });

  test("the idempotency record is not dropped by the 24 h outcome window", async () => {
    const registry = create();
    const { record } = await registry.accept(input(), async () => ({ ok: true }));
    await settle(registry, record.operationId);
    expect(registry.snapshot().lastResults).toHaveLength(1);

    clock += 25 * 3600_000;
    expect(registry.snapshot().lastResults).toEqual([]);
    const again = await registry.accept(input(), async () => ({ ok: "second run" }));
    expect(again.replayed).toBe(true);
    expect(again.record.operationId).toBe(record.operationId);
  });

  test("profiles never see each other's operations", async () => {
    const registry = create();
    const { record } = await registry.accept(input(), async () => ({}));
    await settle(registry, record.operationId);
    expect(registry.get(record.operationId, "default")).not.toBeNull();
    expect(registry.get(record.operationId, "other")).toBeNull();
    expect(registry.list("other")).toEqual([]);
  });

  test("load settles what a restart cut off and keeps finished records as they were", async () => {
    const first = create();
    const finished = await first.accept(input({ idempotencyKey: "key-finished-1" }), async () => ({ done: true }));
    await settle(first, finished.record.operationId);
    let release!: () => void;
    const stuck = await first.accept(
      input({ idempotencyKey: "key-stuck-0001" }),
      () => new Promise<Record<string, unknown>>((resolve) => (release = () => resolve({}))),
    );
    events.length = 0;

    // a second registry over the same directory is the process after the restart
    const second = create();
    const reconcile = vi.fn(async (record: OperationRecord) => ({
      status: "interrupted" as const,
      workspaceId: "workspace-found",
      error: { code: "interrupted", message: `cut off in ${record.step}` },
    }));
    await second.load(reconcile);
    release();

    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(second.get(stuck.record.operationId, "default")).toMatchObject({
      status: "interrupted",
      workspaceId: "workspace-found",
      error: { message: "cut off in creating-workspace" },
    });
    expect(second.get(finished.record.operationId, "default")).toMatchObject({
      status: "succeeded",
      result: { done: true },
    });
    expect(events.map((event) => event.operationId)).toEqual([stuck.record.operationId]);
    const retry = await second.accept(input({ idempotencyKey: "key-stuck-0001" }), async () => ({}));
    expect(retry).toMatchObject({ replayed: true, record: { operationId: stuck.record.operationId } });
  });

  test("a record removes with the workspace it created and by explicit discard only when it produced nothing", async () => {
    const registry = create();
    const made = await registry.accept(input({ idempotencyKey: "key-made-00001" }), async (handle) => {
      await handle.update({ workspaceId: "workspace-made" });
      return {};
    });
    const failed = await registry.accept(input({ idempotencyKey: "key-failed-001" }), async () => {
      throw new Error("nope");
    });
    await settle(registry, made.record.operationId);
    await settle(registry, failed.record.operationId);

    expect(await registry.discard(made.record.operationId, "default")).toBe(false);
    expect(await registry.discard(failed.record.operationId, "other")).toBe(false);
    expect(await registry.discard(failed.record.operationId, "default")).toBe(true);
    await expect(fs.stat(path.join(dir, `${failed.record.operationId}.json`))).rejects.toThrow();
    // the freed key can be used again
    const reused = await registry.accept(input({ idempotencyKey: "key-failed-001" }), async () => ({}));
    expect(reused.replayed).toBe(false);

    await registry.removeForWorkspace("workspace-made");
    expect(registry.get(made.record.operationId, "default")).toBeNull();
    await expect(fs.stat(path.join(dir, `${made.record.operationId}.json`))).rejects.toThrow();
  });

  test("a running operation can be neither discarded nor removed", async () => {
    const registry = create();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { record } = await registry.accept(input(), async (handle) => {
      await handle.update({ workspaceId: "workspace-live" });
      await gate;
      return {};
    });
    for (let attempt = 0; attempt < 100 && !registry.get(record.operationId, "default")?.workspaceId; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(await registry.discard(record.operationId, "default")).toBe(false);
    await registry.removeForWorkspace("workspace-live");
    expect(registry.get(record.operationId, "default")).not.toBeNull();
    release();
    await settle(registry, record.operationId);
  });

  test("a workspace deleted while its operation is still running takes the record with it once it settles", async () => {
    const registry = create();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { record } = await registry.accept(
      input({ idempotencyKey: "key-orphan-0001", intent: { reservedWorkspaceId: "workspace-gone" } }),
      async () => {
        await gate;
        return {};
      },
    );
    await registry.removeForWorkspace("workspace-gone");
    expect(registry.get(record.operationId, "default")).not.toBeNull();
    release();
    await settle(registry, record.operationId);
    // The record leaves memory before its file is removed, so wait for both.
    const file = path.join(dir, `${record.operationId}.json`);
    const fileExists = () =>
      fs.stat(file).then(
        () => true,
        () => false,
      );
    for (
      let attempt = 0;
      attempt < 100 && (registry.get(record.operationId, "default") || (await fileExists()));
      attempt += 1
    ) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(registry.get(record.operationId, "default")).toBeNull();
    await expect(fs.stat(file)).rejects.toThrow();
    const reused = await registry.accept(input({ idempotencyKey: "key-orphan-0001" }), async () => ({}));
    expect(reused.replayed).toBe(false);
  });

  test("a failure carrying an errno code is reported with a stable code", async () => {
    const registry = create();
    const { record } = await registry.accept(input({ idempotencyKey: "key-errno-00001" }), async () => {
      throw Object.assign(new Error("EPERM: operation not permitted"), { code: "EPERM" });
    });
    await settle(registry, record.operationId);
    expect(registry.get(record.operationId, "default")?.error).toMatchObject({ code: "internal_error" });
    const catalogued = await registry.accept(input({ idempotencyKey: "key-errno-00002" }), async () => {
      throw Object.assign(new Error("busy"), { code: "checkout_conflict" });
    });
    await settle(registry, catalogued.record.operationId);
    expect(registry.get(catalogued.record.operationId, "default")?.error).toMatchObject({ code: "checkout_conflict" });
  });
});
