import { BaseProvider, checkBinaryOnPath } from "./base-provider.js";

export class CodexProvider extends BaseProvider {
  static id = "codex";
  static displayName = "Codex CLI";
  static models = [
    { id: "gpt-5.4", name: "GPT-5.4", suggestedRole: "judge" },
    { id: "gpt-5.4-mini", name: "GPT-5.4 mini", suggestedRole: "worker" },
    { id: "gpt-5.3-codex", name: "GPT-5.3 Codex", suggestedRole: null },
    { id: "gpt-5.2", name: "GPT-5.2", suggestedRole: null },
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
