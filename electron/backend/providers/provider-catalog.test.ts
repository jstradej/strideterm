import { describe, expect, test } from "vitest";
import { PROVIDER_CHOICES } from "../../shared/agent-provider-catalog.js";
import { getAllProviders, getProviderChoices } from "./provider-registry.js";

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
});
