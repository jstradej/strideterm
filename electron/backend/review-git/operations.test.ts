import { describe, expect, test, vi } from "vitest";
import { REVIEW_GIT_OPERATION_RETENTION_MS, createReviewGitOperationRegistry } from "./operations.js";

const input = (
  overrides: Partial<Parameters<ReturnType<typeof createReviewGitOperationRegistry>["start"]>[0]> = {},
) => ({
  profileId: "default",
  workspaceId: "ws-1",
  kind: "push",
  source: "mcp" as const,
  run: async () => ({ status: "pushed" }),
  ...overrides,
});

describe("review Git operation registry", () => {
  test("start answers at once with a running record and settles with the result", async () => {
    const registry = createReviewGitOperationRegistry();
    let finish!: (value: unknown) => void;
    const { operation } = registry.start(
      input({
        run: () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      }),
    );
    expect(operation.state).toBe("running");
    expect(registry.running("default")).toHaveLength(1);

    await Promise.resolve();
    finish({ status: "pushed" });
    await registry.idle();

    const looked = registry.get(operation.operationId, { profileId: "default", workspaceId: "ws-1" });
    expect(looked.found && looked.operation).toMatchObject({ state: "succeeded", result: { status: "pushed" } });
    expect(registry.running("default")).toHaveLength(0);
  });

  test("a failing run is recorded as failed with its message", async () => {
    const registry = createReviewGitOperationRegistry();
    const { operation } = registry.start(
      input({
        run: async () => {
          throw new Error("lease rejected");
        },
      }),
    );
    await registry.idle();
    const looked = registry.get(operation.operationId, { profileId: "default" });
    expect(looked.found && looked.operation).toMatchObject({ state: "failed", error: "lease rejected" });
  });

  test("the same idempotency key returns the operation already started — never a second run", async () => {
    const registry = createReviewGitOperationRegistry();
    const run = vi.fn(async () => "done");
    const first = registry.start(input({ idempotencyKey: "key-12345678", run }));
    const retry = registry.start(input({ idempotencyKey: "key-12345678", run }));
    await registry.idle();

    expect(retry.reused).toBe(true);
    expect(retry.operation.operationId).toBe(first.operation.operationId);
    expect(run).toHaveBeenCalledTimes(1);
  });

  test("an idempotency key is scoped to its profile and workspace", async () => {
    const registry = createReviewGitOperationRegistry();
    const run = vi.fn(async () => "done");
    registry.start(input({ idempotencyKey: "key-12345678", run }));
    registry.start(input({ idempotencyKey: "key-12345678", workspaceId: "ws-2", run }));
    registry.start(input({ idempotencyKey: "key-12345678", profileId: "other", run }));
    await registry.idle();
    expect(run).toHaveBeenCalledTimes(3);
  });

  test("an operation is only visible to its own profile and workspace", async () => {
    const registry = createReviewGitOperationRegistry();
    const { operation } = registry.start(input());
    await registry.idle();

    expect(registry.get(operation.operationId, { profileId: "default", workspaceId: "ws-1" }).found).toBe(true);
    expect(registry.get(operation.operationId, { profileId: "other" })).toEqual({ found: false, reason: "unknown" });
    expect(registry.get(operation.operationId, { profileId: "default", workspaceId: "ws-2" })).toEqual({
      found: false,
      reason: "unknown",
    });
    expect(registry.listForProfile("other")).toEqual([]);
  });

  test("results are kept for 24 hours; afterwards a lookup says expired, never unknown-and-guess", async () => {
    let now = 1_000_000;
    const registry = createReviewGitOperationRegistry({ now: () => now });
    const { operation } = registry.start(input());
    await registry.idle();

    now += REVIEW_GIT_OPERATION_RETENTION_MS - 1_000;
    expect(registry.get(operation.operationId, { profileId: "default" }).found).toBe(true);

    now += 2_000;
    expect(registry.get(operation.operationId, { profileId: "default" })).toEqual({ found: false, reason: "expired" });
    expect(registry.get("never-existed", { profileId: "default" })).toEqual({ found: false, reason: "unknown" });
  });

  test("a running operation is never expired, however long it runs", async () => {
    let now = 1_000_000;
    const registry = createReviewGitOperationRegistry({ now: () => now });
    let finish!: () => void;
    const { operation } = registry.start(
      input({
        run: () =>
          new Promise<void>((resolve) => {
            finish = resolve;
          }),
      }),
    );
    now += REVIEW_GIT_OPERATION_RETENTION_MS * 3;
    expect(registry.get(operation.operationId, { profileId: "default" }).found).toBe(true);
    await Promise.resolve();
    finish();
    await registry.idle();
  });

  test("every state change is reported once, so the runtime can broadcast and emit the result", async () => {
    const changes: string[] = [];
    const registry = createReviewGitOperationRegistry({ onChange: (record) => changes.push(record.state) });
    registry.start(input());
    await registry.idle();
    expect(changes).toEqual(["running", "succeeded"]);
  });

  test("the record names who started it", async () => {
    const registry = createReviewGitOperationRegistry();
    const ui = registry.start(input({ source: "ui" }));
    const mcp = registry.start(input({ source: "mcp", workspaceId: "ws-2" }));
    await registry.idle();
    expect(ui.operation.source).toBe("ui");
    expect(mcp.operation.source).toBe("mcp");
  });
});
