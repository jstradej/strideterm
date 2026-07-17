import { BaseProvider, checkBinaryOnPath } from "./base-provider.js";
import type { ProviderConfig, BinaryCheckResult } from "./base-provider.js";

export class OpencodeProvider extends BaseProvider {
  static override id = "opencode";
  static override displayName = "OpenCode";
  static override models = [
    { id: "default", name: "Default", suggestedRole: null },
    { id: "anthropic/claude-opus-4-7", name: "Claude Opus 4.7", suggestedRole: "judge" },
    { id: "anthropic/claude-sonnet-4-6", name: "Claude Sonnet 4.6", suggestedRole: "worker" },
    { id: "openai/gpt-5.4", name: "GPT-5.4", suggestedRole: null },
    { id: "google/gemini-3-flash-preview", name: "Gemini 3 Flash (preview)", suggestedRole: null },
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
