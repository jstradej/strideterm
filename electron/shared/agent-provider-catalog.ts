// Task-agent CLI provider catalog: the single source of truth for provider ids,
// display names, model ids, default permission mode and Companion isolation
// level. Dependency-free so the renderer (src/lib/agent-providers.ts), the
// backend provider classes and the internal MCP prepare step read the same list.

export interface ProviderModelChoice {
  id: string;
  name: string;
  suggestedRole: "worker" | "judge" | null;
  /** Effort picked together with this model when it is auto-selected for its suggested role. */
  suggestedEffort?: string;
}

export interface ProviderChoice {
  id: string;
  name: string;
  defaultSkipPermissions: boolean;
  models: ProviderModelChoice[];
  /** Reasoning-effort levels the CLI's interactive launch accepts; empty when it has no such flag. */
  effortLevels: string[];
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
    effortLevels: ["low", "medium", "high", "xhigh", "max"],
    models: [
      // Aliases follow Claude Code's own latest per tier (code.claude.com/docs/en/model-config,
      // checked 2026-10-17: fable = Fable 5.1, opus = Opus 5.5, sonnet = Sonnet 5.5, haiku = Haiku 5.5).
      { id: "", name: "Default", suggestedRole: null },
      { id: "sonnet", name: "Sonnet", suggestedRole: "worker" },
      { id: "opus", name: "Opus", suggestedRole: "judge" },
      { id: "fable", name: "Fable", suggestedRole: null },
      { id: "haiku", name: "Haiku", suggestedRole: null },
    ],
  },
  {
    id: "codex",
    name: "Codex CLI",
    defaultSkipPermissions: true,
    inspectionIsolation: "permission-gated",
    effortLevels: ["minimal", "low", "medium", "high", "xhigh"],
    // Catalog per developers.openai.com/codex/models (checked 2026-10-17).
    // Dropped: gpt-5.3-codex-spark (retired 2026-09-14), gpt-5.5 (retired
    // 2026-10-14) and the older GPT-5.6 family. The worker keeps "Default":
    // Codex then runs its own recommended model.
    models: [
      { id: "", name: "Default", suggestedRole: null },
      { id: "gpt-6.1-sol", name: "GPT-6.1 Sol", suggestedRole: "judge", suggestedEffort: "xhigh" },
      { id: "gpt-6-astra", name: "GPT-6 Astra", suggestedRole: null },
      { id: "gpt-6-sol", name: "GPT-6 Sol", suggestedRole: null },
      { id: "gpt-6-luna", name: "GPT-6 Luna", suggestedRole: null },
    ],
  },
  {
    id: "gemini",
    name: "Gemini CLI",
    defaultSkipPermissions: false,
    inspectionIsolation: "permission-gated",
    effortLevels: [],
    // Per ai.google.dev/gemini-api/docs/models (checked 2026-10-17). Gemini 4
    // Argon is left out: Google steers it to Antigravity CLI, not Gemini CLI.
    models: [
      { id: "", name: "Default", suggestedRole: null },
      { id: "gemini-3.1-pro-preview", name: "3.1 Pro (preview)", suggestedRole: "judge" },
      { id: "gemini-3.8-flash", name: "3.8 Flash", suggestedRole: "worker" },
      { id: "gemini-3.5-flash-lite", name: "3.5 Flash-Lite", suggestedRole: null },
      { id: "gemini-2.5-pro", name: "2.5 Pro", suggestedRole: null },
    ],
  },
  {
    id: "copilot",
    name: "GitHub Copilot",
    defaultSkipPermissions: true,
    inspectionIsolation: "permission-gated",
    effortLevels: ["none", "minimal", "low", "medium", "high", "xhigh", "max"],
    // Per the Copilot CLI command reference (checked 2026-10-17).
    models: [
      { id: "", name: "Default", suggestedRole: null },
      { id: "claude-opus-5.5", name: "Claude Opus 5.5", suggestedRole: "judge" },
      { id: "claude-sonnet-5.5", name: "Claude Sonnet 5.5", suggestedRole: "worker" },
      { id: "gpt-6.1-sol", name: "GPT-6.1 Sol", suggestedRole: null },
      { id: "gpt-6-luna", name: "GPT-6 Luna", suggestedRole: null },
      { id: "gemini-3.8-flash", name: "Gemini 3.8 Flash", suggestedRole: null },
    ],
  },
  {
    id: "opencode",
    name: "OpenCode",
    defaultSkipPermissions: true,
    inspectionIsolation: "permission-gated",
    // `--variant` exists on `opencode run` only, not on the TUI a task launches.
    effortLevels: [],
    models: [
      { id: "default", name: "Default", suggestedRole: null },
      { id: "anthropic/claude-opus-5-5", name: "Claude Opus 5.5", suggestedRole: "judge" },
      { id: "anthropic/claude-sonnet-5-5", name: "Claude Sonnet 5.5", suggestedRole: "worker" },
      { id: "openai/gpt-6.1-sol", name: "GPT-6.1 Sol", suggestedRole: null },
      { id: "google/gemini-3.8-flash", name: "Gemini 3.8 Flash", suggestedRole: null },
    ],
  },
];

export const EFFORT_LEVELS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

/**
 * Launch arguments that set the reasoning effort. An effort the provider does
 * not list is dropped rather than passed through, so the command line only
 * ever carries a value from the catalog.
 */
export function effortArgs(providerId: string, effort: string | undefined): string[] {
  const levels = PROVIDER_CHOICES.find((choice) => choice.id === providerId)?.effortLevels ?? [];
  if (!effort || !levels.includes(effort)) return [];
  if (providerId === "claude") return ["--effort", effort];
  if (providerId === "codex") return ["-c", `model_reasoning_effort=${effort}`];
  if (providerId === "copilot") return ["--reasoning-effort", effort];
  return [];
}
