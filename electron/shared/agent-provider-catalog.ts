// Task-agent CLI provider catalog: the single source of truth for provider ids,
// display names, model ids, default permission mode and Companion isolation
// level. Dependency-free so the renderer (src/lib/agent-providers.ts), the
// backend provider classes and the internal MCP prepare step read the same list.

export interface ProviderModelChoice {
  id: string;
  name: string;
  suggestedRole: "worker" | "judge" | null;
}

export interface ProviderChoice {
  id: string;
  name: string;
  defaultSkipPermissions: boolean;
  models: ProviderModelChoice[];
  /** Attached-mode Companion capability level (plan §3.2) — how strongly this
   * provider gates project execution/writes when launched without a
   * permission-bypass flag. Mirrors electron/backend/providers/base-provider.ts.
   * Every provider defaults to "permission-gated": no bypass flag means the
   * CLI's own per-tool approval prompt gates writes/execution, and the
   * runner turns that prompt into a policy pause rather than auto-approving
   * it. None claims "enforced" (a verified hard sandbox) or degrades to
   * "prompt-only" without a concrete reason. */
  inspectionIsolation: "enforced" | "permission-gated" | "prompt-only";
}

export const PROVIDER_CHOICES: ProviderChoice[] = [
  {
    id: "claude",
    name: "Claude Code",
    defaultSkipPermissions: true,
    inspectionIsolation: "permission-gated",
    models: [
      { id: "", name: "Default", suggestedRole: null },
      { id: "claude-fable-5", name: "Fable 5", suggestedRole: null },
      { id: "sonnet", name: "Sonnet", suggestedRole: "worker" },
      { id: "opus", name: "Opus", suggestedRole: "judge" },
      { id: "haiku", name: "Haiku", suggestedRole: null },
    ],
  },
  {
    id: "codex",
    name: "Codex CLI",
    defaultSkipPermissions: true,
    inspectionIsolation: "permission-gated",
    // Catalog per developers.openai.com/codex/models (checked 2026-08-11).
    // Dropped: gpt-5.3-codex (already deprecated), gpt-5.4 and gpt-5.4-mini
    // (retire from Codex 2026-08-31).
    models: [
      { id: "", name: "Default", suggestedRole: null },
      { id: "gpt-5.6-sol", name: "GPT-5.6 Sol", suggestedRole: "judge" },
      { id: "gpt-5.6-terra", name: "GPT-5.6 Terra", suggestedRole: "worker" },
      { id: "gpt-5.6-luna", name: "GPT-5.6 Luna", suggestedRole: null },
      { id: "gpt-5.3-codex-spark", name: "GPT-5.3 Codex Spark", suggestedRole: null },
      { id: "gpt-5.5", name: "GPT-5.5", suggestedRole: null },
    ],
  },
  {
    id: "gemini",
    name: "Gemini CLI",
    defaultSkipPermissions: false,
    inspectionIsolation: "permission-gated",
    models: [
      { id: "", name: "Default", suggestedRole: null },
      { id: "gemini-3.1-pro-preview", name: "3.1 Pro (preview)", suggestedRole: "judge" },
      { id: "gemini-3-flash-preview", name: "3 Flash (preview)", suggestedRole: "worker" },
      { id: "gemini-2.5-pro", name: "2.5 Pro", suggestedRole: null },
      { id: "gemini-2.5-flash", name: "2.5 Flash", suggestedRole: null },
    ],
  },
  {
    id: "copilot",
    name: "GitHub Copilot",
    defaultSkipPermissions: true,
    inspectionIsolation: "permission-gated",
    models: [
      { id: "", name: "Default", suggestedRole: null },
      { id: "claude-opus-4.8", name: "Claude Opus 4.8", suggestedRole: "judge" },
      { id: "claude-sonnet-5", name: "Claude Sonnet 5", suggestedRole: "worker" },
      { id: "gpt-5.6-sol", name: "GPT-5.6 Sol", suggestedRole: null },
      { id: "gpt-5.5", name: "GPT-5.5", suggestedRole: null },
      { id: "gpt-5.3-codex", name: "GPT-5.3 Codex", suggestedRole: null },
    ],
  },
  {
    id: "opencode",
    name: "OpenCode",
    defaultSkipPermissions: true,
    inspectionIsolation: "permission-gated",
    models: [
      { id: "default", name: "Default", suggestedRole: null },
      { id: "anthropic/claude-opus-4-7", name: "Claude Opus 4.7", suggestedRole: "judge" },
      { id: "anthropic/claude-sonnet-4-6", name: "Claude Sonnet 4.6", suggestedRole: "worker" },
      { id: "openai/gpt-5.4", name: "GPT-5.4", suggestedRole: null },
      { id: "google/gemini-3-flash-preview", name: "Gemini 3 Flash (preview)", suggestedRole: null },
    ],
  },
];
