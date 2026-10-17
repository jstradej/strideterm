import { PROVIDER_CHOICES } from "../../shared/agent-provider-catalog.js";
import type { ModelDescriptor } from "./base-provider.js";

export function catalogModels(providerId: string): ModelDescriptor[] {
  const entry = PROVIDER_CHOICES.find((choice) => choice.id === providerId);
  if (!entry) throw new Error(`Provider ${providerId} is missing from the shared catalog.`);
  return entry.models.map((model) => ({ ...model }));
}
