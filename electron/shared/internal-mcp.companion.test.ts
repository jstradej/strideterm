import { describe, expect, test } from "vitest";
import { internalMcpRequestSchema } from "./internal-mcp.js";

describe("internal MCP companion request schema", () => {
  test("requires an explicit role, provider, model and idempotency key", () => {
    expect(
      internalMcpRequestSchema.safeParse({
        operation: "companion_create",
        input: {
          companionRole: "reviewer",
          providerId: "codex",
          model: "gpt-5.5",
          idempotencyKey: "companion-123",
        },
      }).success,
    ).toBe(true);
    expect(
      internalMcpRequestSchema.safeParse({
        operation: "companion_create",
        input: {
          companionRole: "reviewer",
          idempotencyKey: "companion-123",
        },
      }).success,
    ).toBe(false);
  });

  test("rejects unknown roles, unsupported effort and extra fields", () => {
    for (const input of [
      { companionRole: "worker", providerId: "codex", model: "gpt-5.5", idempotencyKey: "companion-123" },
      {
        companionRole: "critic",
        providerId: "codex",
        model: "gpt-5.5",
        effort: "wild",
        idempotencyKey: "companion-123",
      },
      {
        companionRole: "planner",
        providerId: "codex",
        model: "gpt-5.5",
        idempotencyKey: "companion-123",
        workspaceId: "other",
      },
    ])
      expect(internalMcpRequestSchema.safeParse({ operation: "companion_create", input }).success).toBe(false);
  });
});
