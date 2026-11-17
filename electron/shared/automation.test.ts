import { describe, expect, it } from "vitest";
import { automationStateSchema } from "./automation.js";

const definition = {
  parentWorkspaceId: "parent",
  enabled: true,
  trigger: { type: "schedule", kind: "interval", everyMinutes: 5, anchor: "2026-01-01T00:00:00Z" },
  executor: { type: "agent", agent: { providerId: "claude", model: "", skipPermissions: false } },
  prompt: "Do the work",
  location: "automation",
  policy: { maxRunMinutes: 60, catchUp: "skip", maxRunsPerHour: 6, subjectCooldownMinutes: 10 },
  createdBy: { kind: "desktop" },
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
  enabledAt: "2026-01-01T00:00:00Z",
};

describe("automation definition", () => {
  it("accepts a valid definition", () => {
    expect(automationStateSchema.safeParse(definition).success).toBe(true);
  });
  it("rejects extra agent arguments and short intervals", () => {
    expect(
      automationStateSchema.safeParse({
        ...definition,
        executor: { type: "agent", agent: { ...definition.executor.agent, extra: "--unsafe" } },
      }).success,
    ).toBe(false);
    expect(
      automationStateSchema.safeParse({ ...definition, trigger: { ...definition.trigger, everyMinutes: 4 } }).success,
    ).toBe(false);
  });
  it("rejects unsupported effort and PR-review combinations", () => {
    const agent = { ...definition.executor.agent, providerId: "gemini", effort: "high" };
    expect(automationStateSchema.safeParse({ ...definition, executor: { type: "agent", agent } }).success).toBe(false);
    expect(automationStateSchema.safeParse({ ...definition, location: "pr-review" }).success).toBe(false);
    expect(
      automationStateSchema.safeParse({
        ...definition,
        location: "pr-review",
        trigger: { type: "event", source: "github", kinds: ["pr-new"] },
      }).success,
    ).toBe(true);
    expect(
      automationStateSchema.safeParse({
        ...definition,
        location: "pr-review",
        trigger: { type: "event", source: "github", kinds: ["pr-merged"] },
      }).success,
    ).toBe(false);
  });
  it("does not allow a model id to become an extra CLI flag", () => {
    const agent = { ...definition.executor.agent, model: "--dangerously-bypass-approvals-and-sandbox" };
    expect(automationStateSchema.safeParse({ ...definition, executor: { type: "agent", agent } }).success).toBe(false);
  });
});
