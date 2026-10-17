import { describe, expect, test } from "vitest";
import { PROVIDER_CHOICES } from "./agent-provider-catalog.js";
import { internalMcpPrepareInputSchema } from "./internal-mcp.js";

describe("internal MCP provider ids", () => {
  test.each(PROVIDER_CHOICES.map((choice) => [choice.id]))("task_prepare accepts catalog provider %s", (id) => {
    const parsed = internalMcpPrepareInputSchema.safeParse({ worker: { providerId: id, model: "x" } });
    expect(parsed.success).toBe(true);
  });

  test("an id outside the catalog is rejected", () => {
    const parsed = internalMcpPrepareInputSchema.safeParse({ worker: { providerId: "nope", model: "x" } });
    expect(parsed.success).toBe(false);
  });
});
