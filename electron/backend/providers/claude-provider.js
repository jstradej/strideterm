import { exec } from "node:child_process";
import { BaseProvider } from "./base-provider.js";

export class ClaudeProvider extends BaseProvider {
  static id = "claude";
  static displayName = "Claude Code";
  static models = [
    { id: "sonnet", name: "Claude Sonnet 4.6", suggestedRole: "worker" },
    { id: "opus", name: "Claude Opus 4.6", suggestedRole: "judge" },
    { id: "haiku", name: "Claude Haiku 4.5", suggestedRole: null },
  ];

  buildCommand({ model, extra } = {}) {
    const parts = ["claude", "--dangerously-skip-permissions"];
    if (model) parts.push("--model", model);
    if (extra?.mcpConfig) parts.push("--mcp-config", extra.mcpConfig);
    return parts.join(" ");
  }

  getEnvironment() {
    // Prevents Claude Code from spawning autonomous background tasks that
    // would interfere with the worker/judge evaluation cycle.
    return { CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1" };
  }

  get idleDetection() {
    return "osc133";
  }

  get idleTimeoutMs() {
    return 2000;
  }

  async checkAvailability() {
    return new Promise((resolve) => {
      exec("claude --version", { timeout: 5000 }, (err, stdout) => {
        if (err) return resolve({ available: false, error: err.message });
        resolve({ available: true, version: stdout.trim() });
      });
    });
  }
}
