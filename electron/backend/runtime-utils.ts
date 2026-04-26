/// <reference types="node" />
import os from "node:os";

/**
 * Pure utility functions and constants shared across runtime modules.
 * No state, no side effects — safe to import anywhere.
 */

// --- ANSI / terminal pattern matching ---

export const ANSI_ESCAPE_RE =
  /\u001B\[[0-?]*[ -/]*[@-~]|\u001B\][^\u0007]*(?:\u0007|\u001B\\)|\u009B[0-?]*[ -/]*[@-~]/g;
export const OSC133_COMMAND_FINISHED_RE = /\u001B\]133;D(?:;(-?\d+))?/;
// OSC 133;C = command just submitted by the shell. Used as activity-start
// signal for the tab status chip. Kept separate from signal.busy which has
// different semantics (driven by output, governs notification eligibility).
export const OSC133_COMMAND_START_RE = /\u001B\]133;C/;
export const AGENT_NAME_RE = /\b(claude|codex|opencode|aider|gemini|copilot)\b/i;
export const AGENT_OUTPUT_RE =
  /\b(claude code|openai codex|codex|claude|gemini|aider|opencode|github copilot|copilot)\b/i;
export const AGENT_OUTPUT_BURST_THRESHOLD = 10;

// When hooks are active, bell/silence detection is suppressed. If no hook
// arrives and the terminal is silent for this long, raise an alert anyway.
export const HOOK_FALLBACK_SILENCE_MS = 120_000; // 2 minutes
export const ATTENTION_MIN_DISPLAY_MS = 3_000;
export const ATTENTION_VISIBILITY_GRACE_MS = 5_000;

// Plan § 3.2.3: end-of-line anchored only. Dropped /\bapprove\b/i and
// /\bdo you want to\b/i — they match anywhere in a line and fire on random
// log output / docs / commit messages.
export const WAITING_PATTERNS = [
  /\bwaiting for input\s*$/i,
  /\bneeds your input\s*$/i,
  /\brequires your input\s*$/i,
  /\bpermission (?:required|needed)\??\s*$/i,
  /\bapproval required\??\s*$/i,
  /\bpress (?:enter|any key)(?: to continue)?\s*$/i,
  /\bcontinue\?\s*$/i,
  /\b(?:select|choose) an option\s*$/i,
  /\[[yYnN/]+\]\s*\??\s*$/, // [y/N], [Y/n], [y/n] — only at end of line, no spaces inside
  /\?\s*\((?:yes\/no|y\/n)\)\s*$/i,
];

export const PROMPT_PATTERNS_SAFE = [
  /^PS [^\n>]{0,200}>\s*$/,
  /^[A-Za-z]:[^\n]{0,180}>\s*$/,
  /^(?:\([^)\n]{1,80}\)\s*)?[^$\n]{1,180}[$#]\s*$/,
  /^(?:\([^)\n]{1,80}\)\s*)?.{0,180}[›❯➜]\s*$/,
];

// Plan § 3.2.3: drop single-char catcher (`/^\s*>\s*$/` matched any grep /
// markdown line with just `>`). Require trailing space or full box closure.
export const AGENT_IDLE_PATTERNS = [
  /^> $/, // Claude Code idle prompt with trailing space
  /^❯ $/,
  /^➜ $/,
  /^› $/,
  /^╭─ .+ ─╮$/, // full Claude Code boxed prompt (opening + content + closing)
  ...PROMPT_PATTERNS_SAFE, // agent that exited back to shell
];

// Maximum length for idle / prompt pattern matching. Real prompts are short;
// long lines are output text that happened to match loosely.
export const MAX_PATTERN_LINE_LENGTH = 80;

// --- Helpers ---

export function clone<T>(value: T): T {
  return structuredClone(value);
}

export function findWorkspace(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  state: { workspaces: Array<any> },
  workspaceId: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): any {
  return state.workspaces.find((workspace) => workspace.id === workspaceId) || null;
}

export function createAttentionContext(): {
  visibleSessionIds: Set<string>;
  recentlyVisibleUntil: Map<string, number>;
} {
  return {
    visibleSessionIds: new Set(),
    recentlyVisibleUntil: new Map(),
  };
}

export function stripAnsi(value: unknown): string {
  return String(value || "").replaceAll(ANSI_ESCAPE_RE, "");
}

export function lastNonEmptyLine(value: unknown): string {
  const lines = String(value || "")
    .replaceAll("\r", "\n")
    .split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (lines[index].trim()) {
      // Preserve trailing spaces — Claude Code idle prompt is exactly "> "
      // (greater-than + space). Trimming here hid the space and broke
      // the tight AGENT_IDLE_PATTERNS that require it.
      return lines[index];
    }
  }
  return "";
}

export function matchesPrompt(line: string): boolean {
  if (!line) return false;
  // Long lines are not prompts — they're output text that happens to match.
  if (line.length > MAX_PATTERN_LINE_LENGTH) return false;
  return PROMPT_PATTERNS_SAFE.some((pattern) => pattern.test(line));
}

// Plan § 3.2.3: empty line is NOT idle by default. Previous behavior fired
// false positives whenever lastOutputLine failed to capture a non-empty line.
//
// IMPORTANT: we do NOT trim trailing whitespace here — a genuine idle prompt
// is exactly `"> "` (greater-than + space). Trimming it away would match
// lines that just happen to end with `>`, which is the loose behavior the
// tightened patterns were designed to prevent.
export function matchesAgentIdle(line: string): boolean {
  if (!line) return false;
  if (line.length > MAX_PATTERN_LINE_LENGTH) return false;
  return AGENT_IDLE_PATTERNS.some((pattern) => pattern.test(line));
}

export function matchesWaitingPattern(line: string): boolean {
  if (!line) return false;
  if (line.length > MAX_PATTERN_LINE_LENGTH) return false;
  return WAITING_PATTERNS.some((pattern) => pattern.test(line));
}

export function createSessionSignal(sessionId: string): {
  sessionId: string;
  busy: boolean;
  waitingRaised: boolean;
  agentLike: boolean;
  hasUserInput: boolean;
  outputBursts: number;
  promptTimer: ReturnType<typeof setTimeout> | null;
  lastOutputAt: number;
  lastOutputLine: string;
  lastAlertAt: number;
  lastHookAlertAt: number;
  everAlerted: boolean;
  hookCapable: boolean;
  lastHookAt: number;
  lastHookType: string;
  lastPromptAt: number;
  lastUserInteractionAt: number;
  commandClass: string;
  currentCommand: string;
  inputBuffer: string;
  lastAnimationAt: number;
  activity: string;
  lastExitCode: number | null;
  lastCommandFinishedAt: number;
} {
  return {
    sessionId,
    busy: false,
    waitingRaised: false,
    agentLike: false,
    hasUserInput: false,
    outputBursts: 0,
    promptTimer: null,
    lastOutputAt: 0,
    lastOutputLine: "",
    lastAlertAt: Date.now(),
    lastHookAlertAt: 0,
    // True once a user-facing alert has actually been raised for this
    // session. Distinct from `lastAlertAt` (which starts at signal creation
    // time to seed the initial-warmup cooldown). Used by the repeat-idle
    // suppression in dispatcher to tell "first alert ever" apart from
    // "second alert without anything new happening".
    everAlerted: false,
    // Hook-first pipeline tracking (Phase 0 § 3.2.d).
    // Set to true by dispatcher on first hook event; disables silence-based
    // fallback entirely for agent sessions that have proven hooks work.
    hookCapable: false,
    lastHookAt: 0,
    lastHookType: "", // e.g. "Notification:idle_prompt", "Stop"
    lastPromptAt: 0, // UserPromptSubmit timestamp
    // Plan Phase 1 § 4.7 / Phase 2 § 3.2.5:
    // Updated on any user input / when session becomes visible + focused.
    // T3 (heuristic) alerts suppressed while within userInteractionGraceMs.
    lastUserInteractionAt: 0,
    // Phase 2 § 3.2.4: detected command class for current invocation.
    // null / "" until classified; reset by OSC 133;C or by shell prompt match.
    commandClass: "",
    // Name of the currently-running command (best-effort, for diagnostics).
    currentCommand: "",
    // Keystroke accumulator for command classification on Enter.
    inputBuffer: "",
    // Phase 3 § 3.2.2: timestamp of last cursor-movement / spinner / progress
    // animation in PTY output. T3 alerts suppress if this was recent — the
    // program is still redrawing, not idle.
    lastAnimationAt: 0,
    // Tab-status chip state — purely UI, independent of busy/alert logic.
    // "idle"    — at prompt, nothing executing (no chip shown)
    // "running" — command executing (shell OSC 133;C → ;D, or agent UserPromptSubmit → Stop)
    // "done"    — recently finished; lastExitCode drives tone; fades to "idle" after ~3 s
    activity: "idle",
    lastExitCode: null,
    lastCommandFinishedAt: 0,
  };
}

// --- Terminal environment detection ---

function parseWindowsBuildNumber(release: string): number | null {
  const normalized = String(release || "").trim();
  if (!normalized) {
    return null;
  }
  const parts = normalized.split(".");
  const buildNumber = Number.parseInt(parts[parts.length - 1], 10);
  return Number.isInteger(buildNumber) ? buildNumber : null;
}

export function detectTerminalEnvironment({
  platform = process.platform,
  release = os.release(),
}: { platform?: string; release?: string } = {}): {
  platform: string;
  windowsPty?: { backend: string; buildNumber: number };
} {
  const environment: { platform: string } = { platform };
  if (platform !== "win32") {
    return environment;
  }
  const buildNumber = parseWindowsBuildNumber(release);
  if (!Number.isInteger(buildNumber)) {
    return environment;
  }
  return {
    ...environment,
    windowsPty: {
      backend: (buildNumber as number) >= 18309 ? "conpty" : "winpty",
      buildNumber: buildNumber as number,
    },
  };
}
