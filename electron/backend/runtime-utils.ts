/// <reference types="node" />
import os from "node:os";

/**
 * Pure utility functions and constants shared across runtime modules.
 * No state, no side effects — safe to import anywhere.
 */

// --- ANSI / terminal pattern matching ---

// Regexes below operate on terminal byte streams (ANSI/VT escape sequences).
// They are never applied to attacker-controlled network input, so ReDoS is
// not a realistic threat. safe-regex flags them on structural heuristics,
// not actual exploitability.
/* eslint-disable security/detect-unsafe-regex */
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

// ----------------------------------------------------------------------
// Rate-limit detection
//
// Different agents surface "you're rate-limited" in very different ways:
//
//   - Claude Code (plan/session limit): renders an interactive
//     `/rate-limit-options` dialog (Stop and wait / Upgrade your plan) with
//     option 1 highlighted by default. Session stays alive — pressing Enter
//     accepts the default. After the wait, Claude Code does NOT auto-resume;
//     the user (or us) must send a `continue`-style prompt.
//   - Codex CLI: prints "Rate limit reached for ..." and exits.
//   - Gemini CLI: prints "Quota exceeded ..." / "Please retry in Ns" and
//     exits or fails the request.
//   - GitHub Copilot CLI: prints "Sorry, you've hit a rate limit ... try
//     again in 2 hours." and exits.
//
// Each detector reports whether a confirm keypress is needed (Claude only)
// and a reset time when one can be parsed. When the agent has exited
// (`needsConfirm: false`), the runner restarts the session before resuming.
// When the reset time is unknown (`resetAt: null`), the runner uses an
// exponential fallback delay.
// ----------------------------------------------------------------------

export interface RateLimitMatch {
  /** When the rate-limit window resets, or null if not parseable. */
  resetAt: Date | null;
  /** True if the agent is paused at a confirm prompt (Claude Code dialog). */
  needsConfirm: boolean;
  /** Provider hint for logging — not authoritative. */
  providerHint: "claude" | "codex" | "gemini" | "copilot" | "generic";
}

type RateLimitDetector = (text: string, now: Date) => RateLimitMatch | null;

/** Parse "HH:MM(am|pm)?" → next occurrence in local time. */
function parseClockTime(hh: string, mm: string, meridiem: string | undefined, now: Date): Date | null {
  let hours = Number(hh);
  const minutes = Number(mm);
  const m = (meridiem || "").toLowerCase();
  if (!Number.isFinite(hours) || !Number.isFinite(minutes) || minutes < 0 || minutes > 59) return null;
  if (m === "pm" && hours < 12) hours += 12;
  if (m === "am" && hours === 12) hours = 0;
  if (hours < 0 || hours > 23) return null;
  const target = new Date(now);
  target.setHours(hours, minutes, 0, 0);
  if (target.getTime() <= now.getTime()) target.setDate(target.getDate() + 1);
  return target;
}

// Claude Code's "/rate-limit-options" dialog. The notice line precedes the
// menu and includes a wall-clock reset, e.g. "resets 5:50am (Europe/Prague)".
// The TZ suffix is intentionally ignored — Claude Code displays the user's
// local zone, which matches the host clock.
const claudeCodePromptDetector: RateLimitDetector = (text, now) => {
  const m = text.match(/You['’]ve hit your limit\s*[·.]?\s*resets\s+(\d{1,2})[:.](\d{2})\s*(am|pm)?/i);
  if (!m) return null;
  return {
    resetAt: parseClockTime(m[1]!, m[2]!, m[3], now),
    needsConfirm: true,
    providerHint: "claude",
  };
};

// Codex CLI exits with "Rate limit reached for <model> ... Limit X, Used Y,
// Requested Z" or wraps an OpenAI `rate_limit_exceeded` error. There's no
// reset time in the console output, so the runner falls back to a delay.
//
// Pattern is intentionally tight: the verb "reached" or "exceeded" must come
// between "rate limit" and "for", followed by a model-name token. Earlier
// looser variants matched any "rate-limit ... for ..." within 40 chars and
// false-positived on narrative mentions like "// rate-limit detection runs
// for any agent" — that locked up the worker via task.rateLimitedUntil.
const codexDetector: RateLimitDetector = (_text, _now) => {
  if (!/(?:rate[\s_-]?limit\s+(?:reached|exceeded)\s+for\s+[\w.-]+|rate_limit_exceeded)/i.test(_text)) return null;
  return { resetAt: null, needsConfirm: false, providerHint: "codex" };
};

// Gemini CLI / Code Assist surfaces 429s with a "retryDelay"-derived hint
// like "Please retry in 15.002s". Sometimes only a generic "Quota exceeded"
// is shown; in that case the runner uses a fallback delay.
const geminiDetector: RateLimitDetector = (text, now) => {
  const retry = text.match(/Please retry in\s+(\d+(?:\.\d+)?)\s*s/i);
  if (retry) {
    const seconds = Number(retry[1]);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return {
        resetAt: new Date(now.getTime() + Math.ceil(seconds * 1000)),
        needsConfirm: false,
        providerHint: "gemini",
      };
    }
  }
  if (/\b(?:Quota exceeded for|exceeded your current quota|generate_content_free_tier)\b/i.test(text)) {
    return { resetAt: null, needsConfirm: false, providerHint: "gemini" };
  }
  return null;
};

// GitHub Copilot CLI: "Sorry, you've hit a rate limit ... Please try again in
// 2 hours." Optional "N hours M minutes" form observed in the wild.
const copilotDetector: RateLimitDetector = (text, now) => {
  const wait = text.match(/try again in\s+(\d+)\s*hours?(?:\s+(\d+)\s*minutes?)?/i);
  if (wait) {
    const hours = Number(wait[1]) || 0;
    const minutes = wait[2] ? Number(wait[2]) || 0 : 0;
    return {
      resetAt: new Date(now.getTime() + (hours * 60 + minutes) * 60_000),
      needsConfirm: false,
      providerHint: "copilot",
    };
  }
  if (/Sorry,?\s+you['’]ve hit a rate limit|exceeded your Copilot token usage|user_weekly_rate_limited/i.test(text)) {
    return { resetAt: null, needsConfirm: false, providerHint: "copilot" };
  }
  return null;
};

// Catch-all for unfamiliar agents — but anchored only on tight error-shape
// patterns. Loose mentions like "the runner was rate-limited", "// rate-limit
// handling", or "test rate-limit retry cap" appear constantly in source code,
// test output, and agent narration of rate-limit-related work, and a false
// positive locks up the worker via task.rateLimitedUntil (which then makes
// onAgentIdle consume idle events and the judge never runs).
//
// Required signal shapes:
//   - HTTP/status framing: "HTTP 429", "status 429", "status_code = 429".
//   - Recognized JSON error codes: "rate_limit_exceeded", "too_many_requests".
//
// If a future provider surfaces rate limits in a different shape that these
// don't catch, add a dedicated detector for it (like the four above) rather
// than loosening this one.
const genericFallbackDetector: RateLimitDetector = (text, _now) => {
  const isHttpStatus = /\b(?:HTTP\s+429|status(?:[\s_]code)?\s*[:=]?\s*429)\b/i.test(text);
  const isJsonError = /"(?:rate_limit_exceeded|too_many_requests)"/i.test(text);
  if (!isHttpStatus && !isJsonError) return null;
  return { resetAt: null, needsConfirm: false, providerHint: "generic" };
};

const RATE_LIMIT_DETECTORS: RateLimitDetector[] = [
  claudeCodePromptDetector,
  codexDetector,
  geminiDetector,
  copilotDetector,
  genericFallbackDetector,
];

/**
 * Run all detectors in order; first match wins. Returns null if no detector
 * recognised a rate-limit signal in `text`.
 */
export function detectRateLimit(text: string, now: Date = new Date()): RateLimitMatch | null {
  for (const detector of RATE_LIMIT_DETECTORS) {
    const match = detector(text, now);
    if (match) return match;
  }
  return null;
}

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
  completionHookCapable: boolean;
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
    // hookCapable is set on any hook event; completionHookCapable is set only
    // once a user-facing completion/waiting hook arrives. UserPromptSubmit
    // alone must not disable fallback because it does not prove Stop works.
    hookCapable: false,
    completionHookCapable: false,
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
