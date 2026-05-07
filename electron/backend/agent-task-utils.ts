/**
 * Shared constants, helpers, and parsers for the agent task runner system.
 * Extracted from agent-task-runner.js to reduce file size.
 */
import path from "node:path";
import { z } from "zod";

export const TASK_ROOT = ".strideterm/tasks";
export const VERDICT_FILE = "verdict.json";
export const TASK_FILE = "TASK.md";
export const WORKER_FILE = "WORKER.md";
export const TODO_FILE = "TODO.md";
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
export function taskDir(cwd: string, taskId: string): string {
  return path.join(cwd, TASK_ROOT, taskId);
}

/**
 * Returns the relative path from cwd for use in prompts shown to agents.
 */
export function taskDirRel(taskId: string): string {
  return `${TASK_ROOT}/${taskId}`;
}

/**
 * Wrap user-provided text in XML fence for prompt injection mitigation.
 */
export function fenceUserInput(text: string, tag = "user-task-description"): string {
  if (!text) return "";
  const sanitized = text.replace(new RegExp(`</${tag}>`, "gi"), `</${tag} >`);
  return `<${tag}>\n${sanitized}\n</${tag}>`;
}

export function tailLines(text: string, maxLines: number): string {
  if (!text) return "";
  const lines = text.split("\n");
  if (lines.length <= maxLines) return text;
  return lines.slice(-maxLines).join("\n");
}

/**
 * Parse TODO.md into sections.
 * Returns { "In Progress": ["- [ ] item", ...], "Done": [...], ... }
 */
export function parseTodoSections(text: string): Record<string, string[]> {
  const sections: Record<string, string[]> = {};
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
export function activeItems(lines: string[]): string[] {
  return lines.filter((line) => !line.toLowerCase().startsWith("- [x]"));
}

/**
 * Format auto-detected verify commands as a markdown checklist
 * for inclusion in TASK.md's verification section.
 */
export function formatVerifyChecklist(detected: Array<{ command: string }>): string {
  if (!detected?.length) return "";
  return detected.map((cmd) => `- [ ] Run \`${cmd.command}\` — must pass`).join("\n");
}

/**
 * Extract the user-authored description block from a TASK.md file.
 *
 * TASK.md is generated as: `# Task` heading, `> Created: ...` blockquote,
 * description, then system-generated sections (`## Verification before completion`,
 * `## Rules`, etc). This pulls just the description so the prompt picks up
 * manual edits the user made in the Assignment tab.
 *
 * Returns "" for the auto-generated "No task description provided" placeholder
 * so an unedited TASK.md doesn't masquerade as a real description.
 */
export function extractTaskDescription(taskMd: string): string {
  if (!taskMd) return "";

  const lines = taskMd.split("\n");
  const endMarkers = new Set(["## Verification before completion", "## Rules", "## Technology-specific checks"]);

  let start = 0;
  for (; start < lines.length; start++) {
    const line = lines[start].trim();
    if (!line) continue;
    if (line.startsWith("# ")) continue;
    if (line.startsWith("> Created:")) continue;
    break;
  }

  let end = lines.length;
  for (let i = start; i < lines.length; i++) {
    if (endMarkers.has(lines[i].trim())) {
      end = i;
      break;
    }
  }

  const desc = lines.slice(start, end).join("\n").trim();
  if (desc.startsWith("> No task description provided.")) return "";
  return desc;
}
