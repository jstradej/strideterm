import os from "node:os";

/**
 * Pure utility functions and constants shared across runtime modules.
 * No state, no side effects — safe to import anywhere.
 */

// --- ANSI / terminal pattern matching ---

export const ANSI_ESCAPE_RE =
  /\u001B\[[0-?]*[ -/]*[@-~]|\u001B\][^\u0007]*(?:\u0007|\u001B\\)|\u009B[0-?]*[ -/]*[@-~]/g;
export const OSC133_COMMAND_FINISHED_RE = /\u001B\]133;D/;
export const AGENT_NAME_RE = /\b(claude|codex|opencode|aider|gemini)\b/i;
export const AGENT_OUTPUT_RE = /\b(claude code|openai codex|codex|claude|gemini|aider|opencode)\b/i;
export const AGENT_OUTPUT_BURST_THRESHOLD = 10;

// When hooks are active, bell/silence detection is suppressed. If no hook
// arrives and the terminal is silent for this long, raise an alert anyway.
export const HOOK_FALLBACK_SILENCE_MS = 120_000; // 2 minutes
export const ATTENTION_MIN_DISPLAY_MS = 3_000;
export const ATTENTION_VISIBILITY_GRACE_MS = 5_000;

export const WAITING_PATTERNS = [
  /\bwaiting for input\b/i,
  /\bneeds your input\b/i,
  /\brequires your input\b/i,
  /\bpermission required\b/i,
  /\bapproval required\b/i,
  /\bapprove\b/i,
  /\bpress enter\b/i,
  /\bpress any key\b/i,
  /\bcontinue\?\s*$/i,
  /\bselect an option\b/i,
  /\bchoose an option\b/i,
  /\bwould you like to\b/i,
  /\bdo you want to\b/i,
  /\[[ yYnN/]+\]/,
];

export const PROMPT_PATTERNS_SAFE = [
  /^PS [^\n>]{0,200}>\s*$/,
  /^[A-Za-z]:[^\n]{0,180}>\s*$/,
  /^(?:\([^)\n]{1,80}\)\s*)?[^$\n]{1,180}[$#]\s*$/,
  /^(?:\([^)\n]{1,80}\)\s*)?.{0,180}[›❯➜]\s*$/,
];

export const AGENT_IDLE_PATTERNS = [
  /^\s*>\s*$/, // Claude Code idle prompt
  /^\s*[$#>❯›➜]\s*$/, // Generic single-char prompts
  /^\s*╭─/, // Claude Code boxed prompt start
  /^\s*\$\s*$/, // Plain dollar prompt
  ...PROMPT_PATTERNS_SAFE, // Also accept regular shell prompts (agent exited back to shell)
];

// --- Helpers ---

export function clone(value) {
  return structuredClone(value);
}

export function findWorkspace(state, workspaceId) {
  return state.workspaces.find((workspace) => workspace.id === workspaceId) || null;
}

export function createAttentionContext() {
  return {
    visibleSessionIds: new Set(),
    recentlyVisibleUntil: new Map(),
  };
}

export function stripAnsi(value) {
  return String(value || "").replaceAll(ANSI_ESCAPE_RE, "");
}

export function lastNonEmptyLine(value) {
  const lines = String(value || "")
    .replaceAll("\r", "\n")
    .split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (lines[index].trim()) {
      return lines[index].trimEnd();
    }
  }
  return "";
}

export function matchesPrompt(line) {
  if (!line) {
    return false;
  }
  return PROMPT_PATTERNS_SAFE.some((pattern) => pattern.test(line));
}

export function matchesAgentIdle(line) {
  if (!line) {
    return true; // Empty line after silence = likely idle
  }
  return AGENT_IDLE_PATTERNS.some((pattern) => pattern.test(line.trimEnd()));
}

export function createSessionSignal(sessionId) {
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
  };
}

// --- Terminal environment detection ---

function parseWindowsBuildNumber(release) {
  const normalized = String(release || "").trim();
  if (!normalized) {
    return null;
  }
  const parts = normalized.split(".");
  const buildNumber = Number.parseInt(parts[parts.length - 1], 10);
  return Number.isInteger(buildNumber) ? buildNumber : null;
}

export function detectTerminalEnvironment({ platform = process.platform, release = os.release() } = {}) {
  const environment = { platform };
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
      backend: buildNumber >= 18309 ? "conpty" : "winpty",
      buildNumber,
    },
  };
}
