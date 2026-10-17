import { describe, expect, test } from "vitest";
import { PROVIDER_CHOICES, effortArgs } from "../../shared/agent-provider-catalog.js";
import { getAllProviders, getProvider, getProviderChoices } from "./provider-registry.js";

describe("provider catalog", () => {
  test("the backend registry offers exactly the models the shared catalog lists", () => {
    const backend = Object.fromEntries(getProviderChoices().map((choice) => [choice.id, choice]));
    expect(Object.keys(backend).sort()).toEqual(PROVIDER_CHOICES.map((choice) => choice.id).sort());
    for (const entry of PROVIDER_CHOICES) {
      expect(backend[entry.id].name).toBe(entry.name);
      expect(backend[entry.id].models).toEqual(entry.models);
      expect(backend[entry.id].inspectionIsolation).toBe(entry.inspectionIsolation);
    }
  });

  test("the default permission mode agrees with the catalog", () => {
    for (const Provider of getAllProviders()) {
      const entry = PROVIDER_CHOICES.find((choice) => choice.id === Provider.id)!;
      expect((Provider as unknown as { defaultSkipPermissions?: boolean }).defaultSkipPermissions ?? false).toBe(
        entry.defaultSkipPermissions,
      );
    }
  });

  test("effort maps to each CLI's own flag and only a listed level reaches the command line", () => {
    expect(effortArgs("claude", "xhigh")).toEqual(["--effort", "xhigh"]);
    expect(effortArgs("codex", "xhigh")).toEqual(["-c", "model_reasoning_effort=xhigh"]);
    expect(effortArgs("copilot", "max")).toEqual(["--reasoning-effort", "max"]);
    expect(effortArgs("codex", "max")).toEqual([]);
    expect(effortArgs("claude", "high; rm -rf /")).toEqual([]);
    expect(effortArgs("claude", "")).toEqual([]);
    expect(effortArgs("gemini", "high")).toEqual([]);
    expect(effortArgs("opencode", "high")).toEqual([]);
  });

  test("the backend providers put the effort flag into the launch command", () => {
    expect(getProvider("claude").buildCommand({ model: "opus", effort: "xhigh", skipPermissions: false })).toBe(
      "claude --model opus --effort xhigh",
    );
    expect(getProvider("codex").buildCommand({ model: "gpt-6.1-sol", effort: "xhigh", skipPermissions: false })).toBe(
      "codex --model gpt-6.1-sol -c model_reasoning_effort=xhigh",
    );
    expect(getProvider("copilot").buildCommand({ effort: "high", skipPermissions: false })).toBe(
      "copilot --reasoning-effort high",
    );
    expect(getProvider("gemini").buildCommand({ model: "gemini-3.8-flash", effort: "high" })).toBe(
      "gemini -m gemini-3.8-flash",
    );
  });
});
