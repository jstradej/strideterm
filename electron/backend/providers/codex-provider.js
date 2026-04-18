import { exec } from "node:child_process";
import { BaseProvider } from "./base-provider.js";

export class CodexProvider extends BaseProvider {
  static id = "codex";
  static displayName = "Codex CLI";
  static models = [
    { id: "o4-mini", name: "o4-mini", suggestedRole: "worker" },
    { id: "o3", name: "o3", suggestedRole: "judge" },
    { id: "gpt-4.1", name: "GPT-4.1", suggestedRole: null },
  ];

  buildCommand({ model } = {}) {
    const parts = ["codex", "--dangerously-bypass-approvals-and-sandbox", "-s", "danger-full-access"];
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
    return new Promise((resolve) => {
      exec("codex --version", { timeout: 5000 }, (err, stdout) => {
        if (err) return resolve({ available: false, error: err.message });
        resolve({ available: true, version: stdout.trim() });
      });
    });
  }
}
