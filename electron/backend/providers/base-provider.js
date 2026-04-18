export class BaseProvider {
  static id = "base";
  static displayName = "Base Provider";
  /** @type {Array<{id: string, name: string, suggestedRole: string|null}>} */
  static models = [];

  /**
   * Build the CLI command string for launching this provider.
   * @param {{model: string, role: "worker"|"judge", cwd: string, extra?: object}} config
   * @returns {string}
   */
  buildCommand(_config) {
    throw new Error("not implemented");
  }

  /**
   * Return environment variables to set for the PTY session.
   * @param {object} _config
   * @returns {Record<string, string>}
   */
  getEnvironment(_config) {
    return {};
  }

  /** How prompts are injected: "pty" (write to PTY stdin) — all providers use this. */
  get injectionMethod() {
    return "pty";
  }

  /**
   * Idle detection strategy:
   *   "osc133"  — shell integration sequences (Claude Code)
   *   "silence" — silence timeout heuristic (Codex, Gemini)
   */
  get idleDetection() {
    return "silence";
  }

  /** Whether the provider supports file-based prompt injection ("Read X and follow it"). */
  get supportsFileInjection() {
    return true;
  }

  /** Milliseconds of silence before the session is considered idle. */
  get idleTimeoutMs() {
    return 8000;
  }

  /**
   * Hook called before the first prompt is injected.
   * Providers can write config files here (e.g. Gemini yolo policy).
   * @param {string} _cwd
   */
  async beforeStart(_cwd) {}

  /**
   * Check if the CLI binary is installed and reachable.
   * @returns {Promise<{available: boolean, version?: string, error?: string}>}
   */
  async checkAvailability() {
    return { available: false, error: "not implemented" };
  }
}
