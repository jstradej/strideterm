/**
 * Classify a user-typed command into one of a handful of categories so the
 * notification detector can apply tailored silence policies.
 *
 * Plan § 3.2.4 / Phase 2. Pure function — no state, no I/O.
 *
 * Classes:
 *   agent     — Claude Code / Codex / Aider / Gemini / Opencode / GitHub Copilot — hooks preferred
 *   streaming — long-running servers / watchers that idle by design; no T3 alerts
 *   tui       — full-screen interactive programs (vim, less, top); no alerts at all
 *   job       — one-shot build/install/test jobs; alert only on exit
 *   shell     — default for everything else
 *
 * The matching is intentionally lightweight. We want near-zero false
 * positives in the "no alert" direction — if classification is uncertain
 * we fall back to "shell" which keeps the full heuristic pipeline active.
 */

const AGENT_RE = /^\s*(?:env\s+\S+=\S+\s+)*(claude|codex|aider|opencode|gemini|copilot)(?:\s|$)/i;

const STREAMING_RE = new RegExp(
  [
    "^\\s*(?:",
    "npm\\s+(?:run\\s+)?(?:dev|start|watch)",
    "|next\\s+dev",
    "|vite",
    "|vitest\\s+(?:--watch|watch)",
    "|cargo\\s+watch",
    "|jest\\s+--watch",
    "|tail\\s+-f",
    "|docker\\s+(?:logs(?:\\s+-f)?|compose\\s+up(?!\\s+-d\\b))",
    "|kubectl\\s+logs(?:\\s+-f)?",
    "|pnpm\\s+(?:run\\s+)?(?:dev|start|watch)",
    "|yarn\\s+(?:run\\s+)?(?:dev|start|watch)",
    "|bun\\s+(?:run\\s+)?dev",
    "|ng\\s+serve",
    "|python\\s+-m\\s+http\\.server",
    ")(?:\\s|$)",
  ].join(""),
  "i",
);

const TUI_RE =
  /^\s*(?:vim|nvim|emacs|less|more|man|top|htop|btop|k9s|lazygit|lazydocker|tig|ranger|mc|nano|bat|fzf|glances|watch)(?:\s|$)/i;

const JOB_RE =
  /^\s*(?:npm\s+(?:install|ci|test|run\s+(?:build|test|lint|check|prepare|typecheck))|yarn\s+(?:install|test|build)|pnpm\s+(?:install|test|build|run\s+(?:build|test|lint))|cargo\s+(?:build|test|run|check|fmt|clippy)|go\s+(?:build|test|run|install|mod\s+tidy)|make(?:\s|$)|mvn(?:\s|$)|gradle(?:\s|$)|pytest(?:\s|$)|ruff|eslint|prettier|tsc(?:\s|$))(?:\s|$)/i;

export type CommandClass = "agent" | "streaming" | "tui" | "job" | "shell";

/**
 * @param input  raw command line as typed by the user (prompt-stripped)
 */
export function classifyCommand(input: unknown): CommandClass {
  const s = String(input || "").trim();
  if (!s) return "shell";

  if (AGENT_RE.test(s)) return "agent";
  if (TUI_RE.test(s)) return "tui";
  if (STREAMING_RE.test(s)) return "streaming";
  if (JOB_RE.test(s)) return "job";
  return "shell";
}

/**
 * Whether a given command class should ever fire T3 (silence-based) alerts.
 * Plan § 3.2.4 policy matrix.
 */
export function allowT3ForCommandClass(commandClass: string): boolean {
  switch (commandClass) {
    case "agent":
    case "shell":
      return true;
    case "streaming":
    case "tui":
    case "job":
      return false;
    default:
      return true;
  }
}

/**
 * Whether to fire exit alerts (non-intentional session exit) for the class.
 */
export function allowExitAlertForCommandClass(commandClass: string): boolean {
  // `shell` typically doesn't exit except when the user ran `exit` themselves,
  // so we suppress exit alerts there too.
  return commandClass !== "shell";
}
