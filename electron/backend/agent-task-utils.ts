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

/**
 * Shared "judge evaluation steps" builder, used by both:
 *  - agent-task-files.ts's `writeTaskFiles` — the on-disk JUDGE_PROMPT.md
 *    template written for every new (always split-format) task.
 *  - agent-task-prompts.ts's `buildJudgePrompt` — the runtime fallback used
 *    when no custom JUDGE_PROMPT.md exists on disk (must also support legacy
 *    single-file tasks).
 *
 * These two call sites independently accumulated near-identical but NOT
 * byte-identical text (capitalization of "Worker"/"worker", a few differently
 * worded clauses, and the file-template site's extra step 8 covering verdict
 * delivery — the runtime site handles that separately via its always-appended
 * verdictBlock). `variant` reproduces each call site's exact prior wording
 * rather than normalizing it away; `dir`, `readSources`, and
 * `verificationFileRef` are already resolved by the caller (each site
 * computes these differently for split vs. legacy tasks).
 */
export function defaultJudgeEvaluationSteps({
  dir,
  readSources,
  verificationFileRef,
  variant,
}: {
  /** Task directory prefix, e.g. taskDirRel(taskId). */
  dir: string;
  /** How step 1 describes which file(s) to read as the source of truth. */
  readSources: string;
  /** File reference step 2 cites for the "Verification before completion" section. */
  verificationFileRef: string;
  /** Which call site is asking — selects the small wording differences below. */
  variant: "file-template" | "runtime-fallback";
}): string {
  const isTemplate = variant === "file-template";
  const worker = isTemplate ? "Worker" : "worker";
  const planNote = isTemplate
    ? "Also read any plan file referenced in the task (e.g. `.private/plan-*.md`)."
    : "Also read any plan or specification file the task references.";
  const step3Implemented = isTemplate
    ? "cite file:line (or `grep`/`git diff` output) proving the deliverable exists right now. No citation → not allowed to mark it IMPLEMENTED."
    : "cite file:line (or `grep`/`git diff` output) that proves the deliverable exists in the code right now. If you cannot produce a concrete citation, you are not allowed to mark it IMPLEMENTED.";
  const step3Partial = isTemplate
    ? "describe exactly what is present vs missing, with file:line references on both sides."
    : "describe exactly what's present versus what's still missing, with file:line references on both sides.";
  const step4Tests = isTemplate
    ? "verify they exist and actually cover the behavior, not just smoke-test passes."
    : "verify they exist and actually cover the behavior (not just smoke tests that pass because nothing throws).";
  const step6 = isTemplate
    ? `Write the full per-requirement audit from step 3 to ${dir}/${JUDGE_TODO_FILE} — this is how the user audits your reasoning after the fact, so it must be complete.`
    : `Write the full per-requirement audit from step 3 to ${dir}/${JUDGE_TODO_FILE}. This is how the user audits your reasoning after the fact — it must be complete.`;

  const steps = [
    `1. Read ${readSources} completely. ${planNote} Extract EVERY requirement, acceptance criterion, plan bullet, verification-checklist item, and explicit deliverable into a single flat numbered list.`,
    "",
    `2. **Verification before completion**: Read the project's own documentation (README, agent guide such as CLAUDE.md or AGENTS.md) to determine what counts as a healthy state for this codebase, and run the relevant checks yourself — do not trust the ${worker}'s claim. Concrete steps from the user's brief in ${dir}/${TASK_FILE} or the "Verification before completion" section of ${verificationFileRef} take precedence over generic guidance. If the project has no automated check setup, do a careful manual review of every changed file instead.`,
    "",
    `3. **Per-requirement audit (mandatory, mechanical)**: For EACH numbered item from step 1, write one of these three labels with a concrete citation from the current working tree or committed diff:
   - \`IMPLEMENTED\` — ${step3Implemented}
   - \`PARTIAL\` — ${step3Partial}
   - \`MISSING\` — the deliverable is not in the code. Cite the grep/search that came back empty.`,
    "",
    `4. **Code review** of the changed files. Flag only real issues (not style preferences):
   - Correctness: does the code actually do what the task asks?
   - Bugs, unhandled edge cases, missing error handling
   - Dead code, debug leftovers, placeholder values, new TODO comments introduced by the ${worker} (new TODOs = incomplete work)
   - Tests: if the task required tests, ${step4Tests}`,
    "",
    "5. Run any additional commands needed to verify claims (grep, git diff, cat, test runners).",
    "",
    `6. ${step6}`,
    "",
    `7. **Verdict rule (mechanical — no judgment calls):**
   - ANY item from step 3 is PARTIAL or MISSING → verdict "continue"
   - ANY deterministic check failed → verdict "continue"
   - ANY code-review finding of the type in step 4 → verdict "continue"
   - Only if EVERY item is IMPLEMENTED with a concrete citation AND all checks pass AND no code-review findings → verdict "complete"`,
  ];

  if (isTemplate) {
    steps.push(
      "",
      `8. Write your verdict to ${dir}/${VERDICT_FILE}:
   - Complete: \`{"verdict": "complete", "reason": "All <N> requirements verified implemented: ..."}\`
   - Continue: \`{"verdict": "continue", "reason": "Missing: ...; Partial: ..."}\`
   Include concrete file:line citations. A "complete" verdict with no citations, or with any phrase like "mostly", "substantially", "largely", "essentially", "close enough", "good enough", "small enough", or mentioning follow-up/deferred work is by definition wrong — change it to "continue".`,
    );
  }

  return steps.join("\n");
}
