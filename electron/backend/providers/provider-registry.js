import { ClaudeProvider } from "./claude-provider.js";
import { CodexProvider } from "./codex-provider.js";
import { GeminiProvider } from "./gemini-provider.js";

const providers = new Map();

export function registerProvider(ProviderClass) {
  providers.set(ProviderClass.id, ProviderClass);
}

/**
 * Get a provider instance by ID.
 * @param {string} id
 * @returns {import("./base-provider.js").BaseProvider}
 */
export function getProvider(id) {
  const Provider = providers.get(id);
  if (!Provider) throw new Error(`Unknown provider: ${id}`);
  return new Provider();
}

export function getAllProviders() {
  return [...providers.values()];
}

/**
 * Return serializable metadata for all registered providers.
 * Used by the frontend to populate provider/model dropdowns.
 */
export function getProviderChoices() {
  return [...providers.values()].map((P) => ({
    id: P.id,
    name: P.displayName,
    models: P.models,
  }));
}

/**
 * Infer a provider config from a legacy command string.
 * Used to migrate task workspaces that predate multi-provider support.
 */
export function parseProviderFromCommand(cmd) {
  if (!cmd) return { providerId: "claude", model: "sonnet" };
  const trimmed = cmd.trim();
  if (trimmed.startsWith("codex")) return { providerId: "codex", model: "o4-mini" };
  if (trimmed.startsWith("gemini")) return { providerId: "gemini", model: "gemini-2.5-flash" };
  const modelMatch = trimmed.match(/--model\s+(\S+)/);
  return { providerId: "claude", model: modelMatch?.[1] || "sonnet" };
}

// Auto-register built-in providers
registerProvider(ClaudeProvider);
registerProvider(CodexProvider);
registerProvider(GeminiProvider);
