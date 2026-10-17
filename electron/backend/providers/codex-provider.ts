import { BaseProvider, checkBinaryOnPath } from "./base-provider.js";
import { catalogModels } from "./provider-catalog.js";
import type { ProviderConfig, BinaryCheckResult } from "./base-provider.js";

export class CodexProvider extends BaseProvider {
  static override id = "codex";
  static override displayName = "Codex CLI";
  static override models = catalogModels("codex");

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
