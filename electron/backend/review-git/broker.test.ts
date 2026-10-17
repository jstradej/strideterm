import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { REVIEW_GIT_GRANT_IDLE_TTL_MS, createReviewGitBroker, type ReviewGitGrantContext } from "./broker.js";
import { createReviewGitOperationRegistry } from "./operations.js";

const baseGrant: ReviewGitGrantContext = {
  sessionId: "ws-1:panel-1",
  profileId: "default",
  workspaceId: "ws-1",
  panelId: "panel-1",
  prKey: "conn:repo:7",
  identityKey: "identity-1",
  agent: "claude",
  command: "claude",
};

function createFakeService() {
  const operations = createReviewGitOperationRegistry();
  const runs: Array<{ kind: string; release?: () => void }> = [];
  const service = {
    operations,
    start: vi.fn(
      (
        input: { kind: string; workspaceId: string; idempotencyKey?: string; confirmation?: unknown },
        caller: {
          profileId: string;
          requester: { source: "ui" | "mcp"; agent?: string; panelId?: string; consent?: string };
        },
      ) => {
        const entry: { kind: string; release?: () => void } = { kind: input.kind };
        const { operation } = operations.start({
          profileId: caller.profileId,
          workspaceId: input.workspaceId,
          kind: input.kind,
          source: caller.requester.source,
          idempotencyKey: input.idempotencyKey,
          run: () =>
            input.kind === "refresh"
              ? new Promise((resolve) => {
                  entry.release = () => resolve({ status: "pushed" });
                })
              : Promise.resolve({ status: "pushed", kind: input.kind }),
        });
        runs.push(entry);
        return { started: true as const, operationId: operation.operationId };
      },
    ),
    lookup: (operationId: string, profileId: string, workspaceId?: string) => {
      const found = operations.get(operationId, { profileId, workspaceId });
      if (!found.found) return { status: "unavailable" as const, reason: found.reason, message: "gone" };
      return { status: found.operation.state, operation: { ...found.operation } as never };
    },
    read: vi.fn(async (input: { operation: string }, workspaceId: string, profileId: string) => ({
      read: input.operation,
      workspaceId,
      profileId,
    })),
  };
  return { service, runs };
}

describe("review Git broker", () => {
  let live: boolean;
  let fake: ReturnType<typeof createFakeService>;
  let broker: ReturnType<typeof createReviewGitBroker>;
  let url = "";

  beforeEach(async () => {
    live = true;
    fake = createFakeService();
    broker = createReviewGitBroker({
      service: fake.service as never,
      isGrantLive: () => live,
    });
    ({ url } = await broker.start());
  });

  afterEach(async () => {
    await broker.close();
  });

  async function call(capability: string | null, body: unknown, init: { method?: string; path?: string } = {}) {
    const target = init.path ? url.replace("/review-git", init.path) : url;
    const response = await fetch(target, {
      method: init.method || "POST",
      headers: {
        "Content-Type": "application/json",
        ...(capability ? { Authorization: `Bearer ${capability}` } : {}),
      },
      body: init.method === "GET" ? undefined : typeof body === "string" ? body : JSON.stringify(body),
    });
    return { status: response.status, body: (await response.json()) as { result?: any; error?: { code: string } } }; // eslint-disable-line @typescript-eslint/no-explicit-any
  }

  test("listens on loopback only and routes nothing but POST /review-git", async () => {
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/review-git$/u);
    const { capability } = broker.mintGrant(baseGrant);
    expect((await call(capability, { operation: "identity" }, { path: "/other" })).status).toBe(404);
    expect((await call(capability, {}, { method: "GET" })).status).toBe(404);
  });

  test("refuses a missing, malformed or unknown capability", async () => {
    expect((await call(null, { operation: "identity" })).status).toBe(401);
    expect((await call("short", { operation: "identity" })).status).toBe(401);
    expect((await call("A".repeat(43), { operation: "identity" })).status).toBe(401);
  });

  test("a read is scoped to the workspace and profile the capability was minted for, never to the request body", async () => {
    const { capability } = broker.mintGrant(baseGrant);
    const ok = await call(capability, { operation: "status" });
    expect(ok.status).toBe(200);
    expect(ok.body.result).toEqual({ read: "status", workspaceId: "ws-1", profileId: "default" });

    // A request cannot name another workspace or profile: the schema is strict.
    const smuggled = await call(capability, { operation: "status", workspaceId: "ws-2", profileId: "other" });
    expect(smuggled.status).toBe(400);
    expect(fake.service.read).toHaveBeenCalledTimes(1);
  });

  test("rejects invalid JSON and invalid operations", async () => {
    const { capability } = broker.mintGrant(baseGrant);
    expect((await call(capability, "{not json")).status).toBeGreaterThanOrEqual(400);
    expect((await call(capability, { operation: "shell", command: "rm -rf /" })).status).toBe(400);
    expect((await call(capability, { operation: "start", kind: "reset", idempotencyKey: "key-12345678" })).status).toBe(
      400,
    );
    expect((await call(capability, { operation: "start", kind: "push" })).status).toBe(400);
  });

  test("an agent can never start publishing queued comments — that stays the user's own action", async () => {
    const { capability } = broker.mintGrant(baseGrant);
    const refused = await call(capability, {
      operation: "start",
      kind: "push-and-publish",
      idempotencyKey: "key-12345678",
    });
    expect(refused.status).toBe(400);
    expect(fake.service.start).not.toHaveBeenCalled();
  });

  test("a capability that is no longer entitled is refused, and stays refused", async () => {
    const { capability } = broker.mintGrant(baseGrant);
    live = false;
    const refused = await call(capability, { operation: "status" });
    expect(refused.status).toBe(403);
    expect(refused.body.error?.code).toBe("grant_expired");
    live = true;
    // Revoked for good: coming back to life elsewhere does not resurrect it.
    expect((await call(capability, { operation: "status" })).status).toBe(401);
    expect(fake.service.read).not.toHaveBeenCalled();
  });

  test("revoking a session or sweeping invalid grants removes the capability", async () => {
    const first = broker.mintGrant(baseGrant);
    const second = broker.mintGrant({ ...baseGrant, sessionId: "ws-2:panel-1", workspaceId: "ws-2" });
    broker.revokeSession(baseGrant.sessionId);
    expect((await call(first.capability, { operation: "status" })).status).toBe(401);
    expect((await call(second.capability, { operation: "status" })).status).toBe(200);

    live = false;
    expect(await broker.revokeInvalid()).toBe(1);
    expect(broker.grantCount()).toBe(0);
  });

  test("start answers with the operation and the requester is the agent, with its reported consent", async () => {
    const { capability } = broker.mintGrant(baseGrant);
    const started = await call(capability, {
      operation: "start",
      kind: "push",
      idempotencyKey: "key-12345678",
      confirmation: { proposalId: "p-1" },
      consent: "yes, go ahead",
    });
    expect(started.status).toBe(200);
    expect(started.body.result).toMatchObject({ started: true, operationId: expect.any(String) });
    expect(fake.service.start).toHaveBeenCalledWith(
      { kind: "push", workspaceId: "ws-1", idempotencyKey: "key-12345678", confirmation: { proposalId: "p-1" } },
      {
        profileId: "default",
        requester: { source: "mcp", agent: "claude", panelId: "panel-1", consent: "yes, go ahead" },
      },
    );
  });

  test("a retried start with the same idempotency key finds the operation, it does not start another", async () => {
    const { capability } = broker.mintGrant(baseGrant);
    const body = { operation: "start", kind: "push", idempotencyKey: "key-12345678" };
    const first = await call(capability, body);
    const retry = await call(capability, body);
    expect(retry.body.result.operationId).toBe(first.body.result.operationId);
    expect(fake.service.start).toHaveBeenCalledTimes(2);
    expect(fake.runs).toHaveLength(2);
    // ...but the registry ran the work once.
    expect(fake.service.operations.listForProfile("default")).toHaveLength(1);
  });

  test("waitMs returns a finished operation's result inline; otherwise status can be polled by id", async () => {
    const { capability } = broker.mintGrant(baseGrant);
    const inline = await call(capability, {
      operation: "start",
      kind: "push",
      idempotencyKey: "key-aaaaaaaa",
      waitMs: 2000,
    });
    expect(inline.body.result).toMatchObject({ status: "succeeded", operation: { result: { status: "pushed" } } });

    const hung = await call(capability, { operation: "start", kind: "refresh", idempotencyKey: "key-bbbbbbbb" });
    const { operationId } = hung.body.result;
    const running = await call(capability, { operation: "operation-status", operationId });
    expect(running.body.result).toMatchObject({ status: "running" });
    fake.runs.find((entry) => entry.kind === "refresh")!.release!();
    await fake.service.operations.idle();
    const done = await call(capability, { operation: "operation-status", operationId });
    expect(done.body.result).toMatchObject({ status: "succeeded" });
  });

  test("an operation that started keeps running and stays queryable after its capability is revoked", async () => {
    const first = broker.mintGrant(baseGrant);
    const hung = await call(first.capability, { operation: "start", kind: "refresh", idempotencyKey: "key-cccccccc" });
    const { operationId } = hung.body.result;

    broker.revokeSession(baseGrant.sessionId);
    expect((await call(first.capability, { operation: "status" })).status).toBe(401);
    expect(fake.service.operations.running("default")).toHaveLength(1);

    // The reconnected tab (a new capability for the same workspace) can still see it finish.
    const second = broker.mintGrant(baseGrant);
    fake.runs.find((entry) => entry.kind === "refresh")!.release!();
    await fake.service.operations.idle();
    const done = await call(second.capability, { operation: "operation-status", operationId });
    expect(done.body.result).toMatchObject({ status: "succeeded" });
  });

  test("an operation id is not visible through a capability for another workspace or profile", async () => {
    const mine = broker.mintGrant(baseGrant);
    const other = broker.mintGrant({ ...baseGrant, sessionId: "ws-2:panel-1", workspaceId: "ws-2" });
    const foreign = broker.mintGrant({ ...baseGrant, sessionId: "p:panel-1", profileId: "other" });
    const started = await call(mine.capability, { operation: "start", kind: "push", idempotencyKey: "key-dddddddd" });
    const { operationId } = started.body.result;
    await fake.service.operations.idle();

    for (const probe of [other, foreign]) {
      const result = await call(probe.capability, { operation: "operation-status", operationId });
      expect(result.body.result).toMatchObject({ status: "unavailable" });
    }
  });

  test("limits concurrent requests per capability", async () => {
    const { capability } = broker.mintGrant(baseGrant);
    const hung = await call(capability, { operation: "start", kind: "refresh", idempotencyKey: "key-eeeeeeee" });
    const { operationId } = hung.body.result;
    const waits = Array.from({ length: 4 }, () =>
      call(capability, { operation: "operation-status", operationId, waitMs: 800 }),
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    const over = await call(capability, { operation: "operation-status", operationId });
    expect(over.status).toBe(429);
    fake.runs.find((entry) => entry.kind === "refresh")!.release!();
    await Promise.all(waits);
  });

  test("a capability is a lease: it lapses after long idleness, and every request renews it", async () => {
    let clock = 1_000_000;
    const leased = createReviewGitBroker({
      service: fake.service as never,
      isGrantLive: () => true,
      now: () => clock,
    });
    const { url: leasedUrl } = await leased.start();
    const post = async (capability: string) =>
      (
        await fetch(leasedUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${capability}` },
          body: JSON.stringify({ operation: "status" }),
        })
      ).status;
    try {
      const { capability } = leased.mintGrant(baseGrant);
      clock += REVIEW_GIT_GRANT_IDLE_TTL_MS - 1_000;
      expect(await post(capability)).toBe(200);
      // Used just now: another nearly-TTL of silence is still fine.
      clock += REVIEW_GIT_GRANT_IDLE_TTL_MS - 1_000;
      expect(await post(capability)).toBe(200);

      clock += REVIEW_GIT_GRANT_IDLE_TTL_MS + 1_000;
      expect(await post(capability)).toBe(403);
      expect(await post(capability)).toBe(401);
    } finally {
      await leased.close();
    }
  });

  test("minting before the broker listens is an error", async () => {
    const cold = createReviewGitBroker({ service: fake.service as never, isGrantLive: () => true });
    expect(() => cold.mintGrant(baseGrant)).toThrow("has not started");
  });
});
