import { BaseProvider, checkBinaryOnPath } from "./base-provider.js";
import type { ProviderConfig, BinaryCheckResult } from "./base-provider.js";

export class CopilotProvider extends BaseProvider {
  static override id = "copilot";
  static override displayName = "GitHub Copilot";
  // Curated subset of GitHub Copilot's model catalog. The full list changes
  // frequently as GitHub rotates model availability; keeping this short avoids
  // churn. Users can still override via --model in the command field.
  static override models = [
    { id: "claude-opus-4.8", name: "Claude Opus 4.8", suggestedRole: "judge" },
    { id: "claude-sonnet-5", name: "Claude Sonnet 5", suggestedRole: "worker" },
    { id: "gpt-5.6-sol", name: "GPT-5.6 Sol", suggestedRole: null },
    { id: "gpt-5.5", name: "GPT-5.5", suggestedRole: null },
    { id: "gpt-5.3-codex", name: "GPT-5.3 Codex", suggestedRole: null },
  ];

  static defaultSkipPermissions = true;

  override buildCommand({ model, skipPermissions = true }: ProviderConfig = {}): string {
    const parts = ["copilot"];
    if (skipPermissions) parts.push("--allow-all-tools");
    if (model) parts.push("--model", model);
    return parts.join(" ");
  }

  override getEnvironment(): Record<string, string> {
    // Env equivalent of --allow-all-tools; belt-and-braces so PTY children that
    // re-exec copilot (rare) still inherit the permissive mode.
    return { COPILOT_ALLOW_ALL: "true" };
  }

  override get idleDetection(): string {
    return "silence";
  }

  override get idleTimeoutMs(): number {
    return 8000;
  }

  /**
   * Copilot's Ink-based TUI treats fast bulk PTY writes as a paste event and
   * drops the content when the app's useInput handler doesn't opt into paste.
   * We stream character-by-character so each char is a distinct keystroke
   * event. Gap must exceed Ink's read-frame tick (~16ms on a 60Hz event
   * loop) — otherwise multiple chars land in the same `data` event and Ink
   * re-classifies them as paste. Empirically 8ms was too short (input never
   * appeared); 30ms sits safely above the frame threshold.
   *
   * Cost: ~3s typing for a ~90-char "Read PROMPT.md and follow ..." directive.
   * Worth it — paste-style and longer paste-to-Enter delays both failed.
   */
  override get promptInjectionStyle(): string {
    return "type";
  }

  override get promptTypingGapMs(): number {
    return 30;
  }

  /** With "type" style the final Enter fires right after the last char. */
  override get promptSubmitDelayMs(): number {
    return 150;
  }

  /**
   * Ink needs a moment to finish the `/clear` redraw before a new typed prompt
   * arrives, otherwise the next input can disappear into the refresh.
   */
  override get clearCommandSettleMs(): number {
    return 1200;
  }

  override async checkAvailability(): Promise<BinaryCheckResult> {
    return checkBinaryOnPath("copilot");
  }
}
