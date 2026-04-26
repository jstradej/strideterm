import { BaseProvider, checkBinaryOnPath } from "./base-provider.js";
import type { ProviderConfig, BinaryCheckResult } from "./base-provider.js";

export class ClaudeProvider extends BaseProvider {
  static override id = "claude";
  static override displayName = "Claude Code";
  static override models = [
    { id: "sonnet", name: "Claude Sonnet 4.6", suggestedRole: "worker" },
    { id: "opus", name: "Claude Opus 4.7", suggestedRole: "judge" },
    { id: "haiku", name: "Claude Haiku 4.5", suggestedRole: null },
  ];

  static defaultSkipPermissions = true;

  override buildCommand({ model, extra, skipPermissions = true }: ProviderConfig = {}): string {
    const parts = ["claude"];
    if (skipPermissions) parts.push("--dangerously-skip-permissions");
    if (model) parts.push("--model", model);
    if (extra?.mcpConfig) parts.push("--mcp-config", extra.mcpConfig as string);
    return parts.join(" ");
  }

  override getEnvironment(): Record<string, string> {
    // Prevents Claude Code from spawning autonomous background tasks that
    // would interfere with the worker/judge evaluation cycle.
    return { CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1" };
  }

  override get idleDetection(): string {
    return "osc133";
  }

  override get idleTimeoutMs(): number {
    return 2000;
  }

  override async checkAvailability(): Promise<BinaryCheckResult> {
    return checkBinaryOnPath("claude");
  }
}
