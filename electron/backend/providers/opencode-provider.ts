import { BaseProvider, checkBinaryOnPath } from "./base-provider.js";
import { catalogModels } from "./provider-catalog.js";
import type { ProviderConfig, BinaryCheckResult } from "./base-provider.js";

export class OpencodeProvider extends BaseProvider {
  static override id = "opencode";
  static override displayName = "OpenCode";
  static override models = catalogModels("opencode");

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
