import { BaseProvider } from "./base-provider.js";
import type { ModelDescriptor } from "./base-provider.js";
import { ClaudeProvider } from "./claude-provider.js";
import { CodexProvider } from "./codex-provider.js";
import { GeminiProvider } from "./gemini-provider.js";
import { CopilotProvider } from "./copilot-provider.js";
import { OpencodeProvider } from "./opencode-provider.js";

interface ProviderClass {
  id: string;
  displayName: string;
  models: ModelDescriptor[];
  new (): BaseProvider;
}

export interface ProviderChoice {
  id: string;
  name: string;
  models: ModelDescriptor[];
  /** Attached-mode Judge capability level (plan §3.2/§7) — see
   * BaseProvider.inspectionIsolation for what each level means. */
  inspectionIsolation: "enforced" | "permission-gated" | "prompt-only";
}

export interface ParsedProviderConfig {
  providerId: string;
  model: string;
  /** Whether this agent launches with its provider's permission-bypass flag.
   * Absent on configs recovered by parsing a command line, where the flag isn't
   * recoverable — callers fall back to the provider default. */
  skipPermissions?: boolean;
}

const providers = new Map<string, ProviderClass>();

export function registerProvider(ProviderClass: ProviderClass): void {
  providers.set(ProviderClass.id, ProviderClass);
}

/**
 * Get a provider instance by ID.
 */
export function getProvider(id: string): BaseProvider {
  const Provider = providers.get(id);
  if (!Provider) throw new Error(`Unknown provider: ${id}`);
  return new Provider();
}

export function getAllProviders(): ProviderClass[] {
  return [...providers.values()];
}

/**
 * Return serializable metadata for all registered providers.
 * Used by the frontend to populate provider/model dropdowns.
 */
export function getProviderChoices(): ProviderChoice[] {
  return [...providers.values()].map((P) => ({
    id: P.id,
    name: P.displayName,
    models: P.models,
    inspectionIsolation: new P().inspectionIsolation,
  }));
}

/**
 * Infer a provider config from a legacy command string.
 * Used to migrate task workspaces that predate multi-provider support.
 */
export function parseProviderFromCommand(cmd: string | null | undefined): ParsedProviderConfig {
  if (!cmd) return { providerId: "claude", model: "sonnet" };
  const trimmed = cmd.trim();
  if (trimmed.startsWith("opencode")) {
    const m = trimmed.match(/--model\s+(\S+)/);
    return { providerId: "opencode", model: m?.[1] || "default" };
  }
  if (trimmed.startsWith("copilot")) {
    const m = trimmed.match(/--model\s+(\S+)/);
    return { providerId: "copilot", model: m?.[1] || "claude-sonnet-4.6" };
  }
  if (trimmed.startsWith("codex")) {
    const m = trimmed.match(/(?:--model|-m)\s+(\S+)/);
    return { providerId: "codex", model: m?.[1] || "gpt-5.4-mini" };
  }
  if (trimmed.startsWith("gemini")) {
    const m = trimmed.match(/(?:--model|-m)\s+(\S+)/);
    return { providerId: "gemini", model: m?.[1] || "gemini-2.5-flash" };
  }
  const modelMatch = trimmed.match(/--model\s+(\S+)/);
  return { providerId: "claude", model: modelMatch?.[1] || "sonnet" };
}

// Auto-register built-in providers
registerProvider(ClaudeProvider);
registerProvider(CodexProvider);
registerProvider(GeminiProvider);
registerProvider(CopilotProvider);
registerProvider(OpencodeProvider);
