/// <reference types="node" />
import { exec } from "node:child_process";

export interface BinaryCheckResult {
  available: boolean;
  path?: string;
  error?: string;
}

export interface ProviderConfig {
  model?: string;
  role?: "worker" | "judge";
  cwd?: string;
  skipPermissions?: boolean;
  extra?: Record<string, unknown>;
}

export interface ModelDescriptor {
  id: string;
  name: string;
  suggestedRole: string | null;
}

/**
 * Check if a binary is reachable on the system PATH.
 * Uses `where` on Windows and `which` on Unix — much faster and more reliable
 * than invoking the binary with --version (which can hang on first-run JS init
 * or auth prompts).
 */
export function checkBinaryOnPath(binary: string): Promise<BinaryCheckResult> {
  return new Promise((resolve) => {
    const cmd = process.platform === "win32" ? "where" : "which";
    exec(`${cmd} ${binary}`, { timeout: 5000 }, (err, stdout) => {
      if (err || !stdout.trim()) {
        return resolve({ available: false, error: `${binary} not found on PATH` });
      }
      resolve({ available: true, path: stdout.trim().split(/\r?\n/)[0].trim() });
    });
  });
}

export class BaseProvider {
  static id = "base";
  static displayName = "Base Provider";
  static models: ModelDescriptor[] = [];

  /**
   * Build the CLI command string for launching this provider.
   */
  buildCommand(_config: ProviderConfig = {}): string {
    throw new Error("not implemented");
  }

  /**
   * Return environment variables to set for the PTY session.
   */
  getEnvironment(_config: ProviderConfig = {}): Record<string, string> {
    return {};
  }

  /** How prompts are injected: "pty" (write to PTY stdin) — all providers use this. */
  get injectionMethod(): string {
    return "pty";
  }

  /**
   * Idle detection strategy:
   *   "osc133"  — shell integration sequences (Claude Code)
   *   "silence" — silence timeout heuristic (Codex, Gemini)
   */
  get idleDetection(): string {
    return "silence";
  }

  /** Whether the provider supports file-based prompt injection ("Read X and follow it"). */
  get supportsFileInjection(): boolean {
    return true;
  }

  /** Milliseconds of silence before the session is considered idle. */
  get idleTimeoutMs(): number {
    return 8000;
  }

  /**
   * Milliseconds to wait between pasting the prompt text and sending Enter.
   * TUIs that buffer paste input (Ink-based React CLIs) may drop the Enter
   * keystroke if it arrives while the paste is still being processed. Claude
   * and Codex are fine at 200ms; GitHub Copilot's TUI needs longer.
   */
  get promptSubmitDelayMs(): number {
    return 200;
  }

  /**
   * How to deliver prompt text into the PTY:
   *   "paste" — write the whole string in one chunk (default, fast).
   *   "type"  — stream character-by-character with a small gap, simulating
   *             keyboard input. Necessary for TUIs that treat fast bulk input
   *             as a paste event (Ink's `useInput({paste: true})`), which
   *             swallows the trailing \r as a literal character instead of
   *             interpreting it as the Enter key.
   * GitHub Copilot needs "type" — plain paste never submits.
   */
  get promptInjectionStyle(): string {
    return "paste";
  }

  /** Milliseconds between characters when promptInjectionStyle === "type". */
  get promptTypingGapMs(): number {
    return 8;
  }

  /**
   * Milliseconds to wait after submitting `/clear` before sending the next
   * prompt. This gives the CLI time to finish resetting its UI/state.
   */
  get clearCommandSettleMs(): number {
    return 800;
  }

  /**
   * How strongly this provider can enforce the attached-mode Judge's
   * read-only/no-execution contract (plan §3.2 "Capability význam") when
   * launched with `skipPermissions: false` (the attached-mode invariant —
   * never a bypass flag):
   *   "enforced"         — the provider has a documented hard project-tree
   *                         read-only / execution-disabled mode. None of the
   *                         current providers claim this — it would require
   *                         verified CLI support, not an assumption.
   *   "permission-gated" — no bypass flag means the CLI's own per-tool
   *                         approval prompt gates any write/execute; the
   *                         runner turns that prompt into a policy pause
   *                         (never auto-approved). This is the default for
   *                         every provider below, since it reflects their
   *                         actual out-of-the-box behavior without
   *                         `skipPermissions`.
   *   "prompt-only"       — the provider cannot demonstrably gate tool use
   *                         at all; only the prompt contract restrains it.
   * UI must show this truthfully rather than implying a hard OS sandbox.
   */
  get inspectionIsolation(): "enforced" | "permission-gated" | "prompt-only" {
    return "permission-gated";
  }

  /**
   * Hook called before the first prompt is injected.
   * Providers can write config files here (e.g. Gemini yolo policy).
   */
  async beforeStart(_cwd: string): Promise<void> {}

  /**
   * Check if the CLI binary is installed and reachable.
   */
  async checkAvailability(): Promise<BinaryCheckResult> {
    return { available: false, error: "not implemented" };
  }
}
