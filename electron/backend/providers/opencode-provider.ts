import { BaseProvider, checkBinaryOnPath } from "./base-provider.js";
import type { ProviderConfig, BinaryCheckResult } from "./base-provider.js";

export class OpencodeProvider extends BaseProvider {
  static override id = "opencode";
  static override displayName = "OpenCode";
  static override models = [
    { id: "default", name: "Default", suggestedRole: null },
    { id: "anthropic/claude-sonnet-4-5", name: "Claude Sonnet 4.5", suggestedRole: "worker" },
    { id: "anthropic/claude-opus-4-5", name: "Claude Opus 4.5", suggestedRole: "judge" },
    { id: "openai/gpt-4o", name: "GPT-4o", suggestedRole: null },
    { id: "google/gemini-2.5-flash", name: "Gemini 2.5 Flash", suggestedRole: null },
  ];

  static defaultSkipPermissions = true;

  override buildCommand({ model, skipPermissions = true }: ProviderConfig = {}): string {
    const parts = ["opencode"];
    if (skipPermissions) parts.push("--yolo");
    if (model && model !== "default") parts.push("--model", model);
    return parts.join(" ");
  }

  override get idleDetection(): string {
    return "silence";
  }

  override get idleTimeoutMs(): number {
    return 8000;
  }

  override async checkAvailability(): Promise<BinaryCheckResult> {
    return checkBinaryOnPath("opencode");
  }
}
