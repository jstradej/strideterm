import { afterEach, describe, expect, it, vi } from "vitest";
import { createInternalMcpBroker, type AutomationInternalMcpApi } from "./internal-mcp-broker.js";
import type { TaskService } from "./task-service.js";

const brokers: Array<ReturnType<typeof createInternalMcpBroker>> = [];
afterEach(async () => {
  await Promise.all(brokers.splice(0).map((broker) => broker.close()));
});

describe("automation MCP broker", () => {
  it("invalidates an in-flight run's commit guard when its session is revoked", async () => {
    let guard: (() => void) | undefined;
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const runNow = vi.fn(async (_scope, _input, assertGrant: () => void) => {
      guard = assertGrant;
      await waiting;
      assertGrant();
      return { runId: "unexpected" };
    });
    const api = {
      catalog: vi.fn(),
      list: vi.fn(),
      get: vi.fn(),
      runNow,
      stopRun: vi.fn(),
    } as unknown as AutomationInternalMcpApi;
    const broker = createInternalMcpBroker({ service: {} as TaskService, automation: api, isGrantLive: () => true });
    brokers.push(broker);
    await broker.start();
    const grant = broker.mintGrant({
      profileId: "profile",
      workspaceId: "parent",
      sessionId: "session",
      panelId: "panel",
      command: "claude",
      tasksEnabled: true,
    });
    const response = fetch(grant.url, {
      method: "POST",
      headers: { Authorization: `Bearer ${grant.capability}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        operation: "automation_run_now",
        input: { workspaceId: "auto", idempotencyKey: "key-1234" },
      }),
    });
    await vi.waitFor(() => expect(guard).toBeDefined());
    broker.revokeSession("session");
    expect(guard).toThrow("expired");
    release();
    expect((await response).status).toBe(403);
  });
  it("uses the fixed grant scope, rejects extra input, and requires the task grant", async () => {
    const list = vi.fn(async () => ({ automations: [] }));
    const api = {
      catalog: vi.fn(),
      list,
      get: vi.fn(),
      runNow: vi.fn(),
      stopRun: vi.fn(),
    } as unknown as AutomationInternalMcpApi;
    const broker = createInternalMcpBroker({ service: {} as TaskService, automation: api, isGrantLive: () => true });
    brokers.push(broker);
    await broker.start();
    const grant = broker.mintGrant({
      profileId: "profile",
      workspaceId: "parent",
      sessionId: "session",
      panelId: "panel",
      command: "claude",
      tasksEnabled: true,
    });
    const restricted = broker.mintGrant({
      profileId: "profile",
      workspaceId: "parent",
      sessionId: "session",
      panelId: "panel",
      command: "claude",
      tasksEnabled: false,
      jiraEnabled: true,
    });
    const call = (capability: string, input: unknown) =>
      fetch(grant.url, {
        method: "POST",
        headers: { Authorization: `Bearer ${capability}`, "Content-Type": "application/json" },
        body: JSON.stringify({ operation: "automation_list", input }),
      });
    expect((await call(grant.capability, {})).status).toBe(200);
    expect(list).toHaveBeenCalledWith({ profileId: "profile", workspaceId: "parent" });
    expect((await call(grant.capability, { profileId: "foreign" })).status).toBe(400);
    expect((await call(restricted.capability, {})).status).toBe(403);
    expect(list).toHaveBeenCalledTimes(1);
    const invalid = await fetch(grant.url, {
      method: "POST",
      headers: { Authorization: `Bearer ${grant.capability}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        operation: "automation_create",
        input: { definition: { trigger: { type: "schedule", kind: "cron", expression: "bad" } } },
      }),
    });
    expect(invalid.status).toBe(422);
    expect(await invalid.json()).toMatchObject({ error: { code: "invalid_schedule" } });
  });
});
