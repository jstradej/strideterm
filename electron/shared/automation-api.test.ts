import { describe, expect, it } from "vitest";
import {
  automationCreateSchema,
  automationRunNowSchema,
  automationRunRefSchema,
  automationDeleteRunsSchema,
} from "./automation-api.js";

describe("automation transport schemas", () => {
  const definition = {
    enabled: true,
    trigger: { type: "schedule", kind: "interval", everyMinutes: 5, anchor: "2026-01-01T00:00:00Z" },
    executor: { type: "agent", agent: { providerId: "claude", model: "", skipPermissions: false } },
    prompt: "hello",
    location: "automation",
    policy: { maxRunMinutes: 60, catchUp: "skip", maxRunsPerHour: 6, subjectCooldownMinutes: 10 },
  };
  it("rejects fields outside the runtime-owned definition", () => {
    expect(automationCreateSchema.safeParse({ parentWorkspaceId: "ws", name: "Job", definition }).success).toBe(true);
    expect(
      automationCreateSchema.safeParse({
        parentWorkspaceId: "ws",
        name: "Job",
        definition: { ...definition, createdBy: { kind: "agent" } },
      }).success,
    ).toBe(false);
    expect(
      automationCreateSchema.safeParse({ parentWorkspaceId: "ws", name: "Job", definition, profileId: "other" })
        .success,
    ).toBe(false);
  });
  it("validates run identifiers and idempotency keys", () => {
    expect(automationRunNowSchema.safeParse({ workspaceId: "ws", idempotencyKey: "request-123" }).success).toBe(true);
    expect(automationRunNowSchema.safeParse({ workspaceId: "ws", idempotencyKey: "bad" }).success).toBe(false);
    expect(automationRunRefSchema.safeParse({ workspaceId: "ws", runId: "../result" }).success).toBe(false);
    expect(automationDeleteRunsSchema.safeParse({ workspaceId: "ws", runIds: [] }).success).toBe(false);
    expect(automationDeleteRunsSchema.safeParse({ workspaceId: "ws", runIds: ["../run"] }).success).toBe(false);
  });
  it("requires an idempotency key and a safe branch for worktree creation", () => {
    const base = { parentWorkspaceId: "ws", name: "Job", definition };
    expect(
      automationCreateSchema.safeParse({ ...base, checkout: { mode: "worktree", branch: "auto/job" } }).success,
    ).toBe(false);
    expect(
      automationCreateSchema.safeParse({
        ...base,
        checkout: { mode: "worktree", branch: "auto/job" },
        idempotencyKey: "request-123",
      }).success,
    ).toBe(true);
    expect(
      automationCreateSchema.safeParse({
        ...base,
        checkout: { mode: "worktree", branch: "../escape" },
        idempotencyKey: "request-123",
      }).success,
    ).toBe(false);
  });
});
