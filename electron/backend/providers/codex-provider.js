import { BaseProvider, checkBinaryOnPath } from "./base-provider.js";

export class CodexProvider extends BaseProvider {
  static id = "codex";
  static displayName = "Codex CLI";
  static models = [
    { id: "o4-mini", name: "o4-mini", suggestedRole: "worker" },
    { id: "o3", name: "o3", suggestedRole: "judge" },
    { id: "gpt-4.1", name: "GPT-4.1", suggestedRole: null },
  ];

  static defaultSkipPermissions = true;

  buildCommand({ model, skipPermissions = true } = {}) {
    const parts = ["codex"];
    if (skipPermissions) parts.push("--dangerously-bypass-approvals-and-sandbox", "-s", "danger-full-access");
    if (model) parts.push("--model", model);
    return parts.join(" ");
  }

  get idleDetection() {
    return "silence";
  }

  get idleTimeoutMs() {
    return 8000;
  }

  async checkAvailability() {
    return checkBinaryOnPath("codex");
  }
}
