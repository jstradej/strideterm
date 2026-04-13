/**
 * Shared constants, helpers, and parsers for the agent task runner system.
 * Extracted from agent-task-runner.js to reduce file size.
 */
import path from "node:path";
import { z } from "zod";

export const TASK_ROOT = ".strideterm/tasks";
export const VERDICT_FILE = "verdict.json";
export const TASK_FILE = "TASK.md";
export const TODO_FILE = "TODO.md";
export const CRITERIA_FILE = "FINISH_CRITERIA.md";
export const JUDGE_TODO_FILE = "JUDGE_TODO.md";
export const JUDGE_PROMPT_FILE = "JUDGE_PROMPT.md";
export const WORK_LOCK_FILE = "WORK_LOCK";
export const TASK_LOG_FILE = "TASK_LOG.jsonl";
export const PROMPT_FILE = "PROMPT.md";
export const HANDOFF_FILE = "HANDOFF.md";

export const MAX_OUTPUT_TAIL = 30;
export const FILE_PROMPT_THRESHOLD = 400;
export const DEFAULT_SHOWER_INTERVAL = 5;

export const verdictSchema = z.object({
  verdict: z.enum(["complete", "continue"]),
  reason: z.string().optional().default(""),
});

/**
 * Returns the per-task directory path: .strideterm/tasks/{taskId}
 */
export function taskDir(cwd, taskId) {
  return path.join(cwd, TASK_ROOT, taskId);
}

/**
 * Returns the relative path from cwd for use in prompts shown to agents.
 */
export function taskDirRel(taskId) {
  return `${TASK_ROOT}/${taskId}`;
}

/**
 * Wrap user-provided text in XML fence for prompt injection mitigation.
 */
export function fenceUserInput(text, tag = "user-task-description") {
  if (!text) return "";
  const sanitized = text.replace(new RegExp(`</${tag}>`, "gi"), `</${tag} >`);
  return `<${tag}>\n${sanitized}\n</${tag}>`;
}

export function tailLines(text, maxLines) {
  if (!text) return "";
  const lines = text.split("\n");
  if (lines.length <= maxLines) return text;
  return lines.slice(-maxLines).join("\n");
}

/**
 * Parse TODO.md into sections.
 * Returns { "In Progress": ["- [ ] item", ...], "Done": [...], ... }
 */
export function parseTodoSections(text) {
  const sections = {};
  let current = "";
  for (const rawLine of String(text || "").split("\n")) {
    const line = rawLine.trimEnd();
    if (line.startsWith("## ")) {
      current = line.slice(3).trim();
      if (!sections[current]) sections[current] = [];
      continue;
    }
    if (current && line.trimStart().startsWith("- [")) {
      sections[current].push(line.trim());
    }
  }
  return sections;
}

/**
 * Filter active (unchecked) items — anything NOT starting with "- [x]".
 */
export function activeItems(lines) {
  return lines.filter((line) => !line.toLowerCase().startsWith("- [x]"));
}

/**
 * Parse FINISH_CRITERIA.md in simple markdown format.
 */
export function parseFinishCriteriaMd(text) {
  const sections = {};
  let current = "";
  for (const rawLine of String(text || "").split("\n")) {
    const line = rawLine.trim();
    if (line.startsWith("## ")) {
      current = line.slice(3).trim().toLowerCase();
      sections[current] = [];
      continue;
    }
    if (current && line.startsWith("- ") && !line.startsWith("<!--")) {
      sections[current].push(line.slice(2).trim());
    }
  }

  const verifyCommands = (sections["verify commands"] || []).map((entry) => {
    const cmdMatch = entry.match(/^(.+?):\s*`([^`]+)`(?:\s*\(timeout:\s*(\d+)s?\))?$/);
    if (cmdMatch) {
      return {
        label: cmdMatch[1].trim(),
        command: cmdMatch[2].trim(),
        timeoutMs: cmdMatch[3] ? Number(cmdMatch[3]) * 1000 : 60_000,
      };
    }
    const bareMatch = entry.match(/^`([^`]+)`/);
    if (bareMatch) {
      return { label: bareMatch[1], command: bareMatch[1], timeoutMs: 60_000 };
    }
    return { label: entry, command: entry, timeoutMs: 60_000 };
  });

  const requiredPaths = (sections["required files"] || []).filter(Boolean);
  const forbiddenPaths = (sections["forbidden files"] || []).filter(Boolean);

  return { verifyCommands, requiredPaths, forbiddenPaths };
}

const DANGEROUS_PATTERNS = [
  { pattern: /\brm\s+(-[a-z]*r|-[a-z]*f|--recursive|--force)/i, reason: "recursive/forced delete" },
  { pattern: /\bformat\b/i, reason: "disk format command" },
  { pattern: /\bmkfs\b/i, reason: "filesystem format" },
  { pattern: /\bdd\s+/i, reason: "low-level disk write" },
  { pattern: />\s*\/dev\/sd/i, reason: "writing to block device" },
  { pattern: /\bgit\s+push\b/i, reason: "git push" },
  { pattern: /\bgit\s+reset\s+--hard\b/i, reason: "destructive git reset" },
  { pattern: /\$\(.*\)|`[^`]+`/, reason: "command substitution (potential injection)" },
];

/**
 * Check a command string for dangerous patterns.
 * Returns an array of warning strings (empty if safe).
 */
export function checkCommandSafety(command) {
  const warnings = [];
  for (const { pattern, reason } of DANGEROUS_PATTERNS) {
    if (pattern.test(command)) {
      warnings.push(reason);
    }
  }
  return warnings;
}
