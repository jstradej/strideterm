import { BaseProvider, checkBinaryOnPath } from "./base-provider.js";
import type { ProviderConfig, BinaryCheckResult } from "./base-provider.js";

export class CodexProvider extends BaseProvider {
  static override id = "codex";
  static override displayName = "Codex CLI";
  static override models = [
    { id: "gpt-5.6-sol", name: "GPT-5.6 Sol", suggestedRole: "judge" },
    { id: "gpt-5.5", name: "GPT-5.5", suggestedRole: "worker" },
    { id: "gpt-5.4", name: "GPT-5.4", suggestedRole: null },
    { id: "gpt-5.4-mini", name: "GPT-5.4 mini", suggestedRole: null },
    { id: "gpt-5.3-codex", name: "GPT-5.3 Codex", suggestedRole: null },
  ];

  static defaultSkipPermissions = true;

  override buildCommand({ model, skipPermissions = true }: ProviderConfig = {}): string {
    const parts = ["codex"];
    if (skipPermissions) parts.push("--dangerously-bypass-approvals-and-sandbox", "-s", "danger-full-access");
    if (model) parts.push("--model", model);
    return parts.join(" ");
  }

  override get idleDetection(): string {
    return "silence";
  }

  override get idleTimeoutMs(): number {
    return 8000;
  }

  override async checkAvailability(): Promise<BinaryCheckResult> {
    return checkBinaryOnPath("codex");
  }
}
