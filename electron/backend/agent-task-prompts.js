/**
 * Prompt template builders for the agent task runner.
 * These build the text prompts injected into worker and judge sessions.
 *
 * Extracted from agent-task-runner.js to reduce file size.
 */
import path from "node:path";
import { readFile } from "node:fs/promises";
import { getLogger } from "./logger.js";
import {
  TASK_FILE,
  TODO_FILE,
  CRITERIA_FILE,
  JUDGE_TODO_FILE,
  JUDGE_PROMPT_FILE,
  VERDICT_FILE,
  WORK_LOCK_FILE,
  taskDir,
  taskDirRel,
  fenceUserInput,
} from "./agent-task-utils.js";

const log = getLogger("task-runner");

export function buildInitialWorkerPrompt(task) {
  const dir = taskDirRel(task.taskId);
  return `You are the worker in a supervised coding loop.

Task:
${task.description ? fenceUserInput(task.description) : "(Read the task from " + dir + "/" + TASK_FILE + ")"}

Rules:
- Work directly in the repository.
- **Commit your changes** regularly with clear, descriptive commit messages. The judge reviews git diffs to verify your work. Do NOT push to any remote.
- Read and obey \`${dir}/${TODO_FILE}\`, \`${dir}/${CRITERIA_FILE}\`, and \`${dir}/${WORK_LOCK_FILE}\`.
- Ignore \`${dir}/${JUDGE_TODO_FILE}\` — that file belongs to the judge.
- Do not ask the human whether you should continue. The judge decides that.
- Do not say "would you like me to continue", "should I proceed", "if you want, I can", or similar optional-next-step language.
- If you think the task is done, verify it against the finish criteria before stopping.
- Do not claim done just because you finished one slice. Return done only when the whole task is complete.
- Remove \`${dir}/${WORK_LOCK_FILE}\` only when the finish criteria genuinely pass.
- Update \`${dir}/${TODO_FILE}\` as you make progress (move items between sections).
- Prefer continuing work over asking for more instructions.
- When you are done, simply stop. Automated checks and a judge will verify your work.`;
}

export function buildRePrompt(task, round) {
  const dir = taskDirRel(task.taskId);
  const lines = [
    `The task is not yet complete. Round ${task.currentRound}/${task.maxRounds}.`,
    "",
    "Verification results:",
  ];

  for (const check of round.checks) {
    const icon = check.passed ? "\u2713" : "\u2717";
    lines.push(`${icon} ${check.label}: ${check.passed ? "PASSED" : "FAILED"}`);
    if (!check.passed && check.outputTail) {
      for (const line of check.outputTail.split("\n")) {
        lines.push(`  ${line}`);
      }
    }
  }

  lines.push(
    "",
    "Continue working. Do not stop while real work remains.",
    `Check ${dir}/${TODO_FILE} for remaining items.`,
    `Remove ${dir}/${WORK_LOCK_FILE} only when genuinely done.`,
  );

  return lines.join("\n");
}

export async function buildJudgePrompt(task, round, gitContext, cwd) {
  const dir = taskDirRel(task.taskId);
  const checkSummary = round.checks.map((c) => `- ${c.label}: ${c.passed ? "PASSED" : "FAILED"}`).join("\n");
  const git = gitContext || { status: "(unavailable)", diffStat: "", diffNames: "" };

  const context = `You are the independent judge evaluating whether a coding task is complete.

Task:
${task.description ? fenceUserInput(task.description) : "(See " + dir + "/" + TASK_FILE + ")"}

The worker has stopped. Automated check results:
${checkSummary}

Git status:
${git.status}

Git diff --stat:
${git.diffStat || "(no changes)"}

Git diff --name-only:
${git.diffNames || "(no changed files)"}`;

  let customInstructions = "";
  if (cwd && task.taskId) {
    const customPath = path.join(taskDir(cwd, task.taskId), JUDGE_PROMPT_FILE);
    try {
      customInstructions = (await readFile(customPath, "utf8")).trim();
      log.info("using custom judge prompt from JUDGE_PROMPT.md", {
        taskId: task.taskId,
        length: customInstructions.length,
      });
    } catch {
      // No custom prompt — use default
    }
  }

  // --- System preamble (always present, user cannot override) ---
  const systemPreamble = `${context}

Task files directory: ${dir}/
Verdict file: ${dir}/${VERDICT_FILE}
Judge scratchpad: ${dir}/${JUDGE_TODO_FILE}

Hard rules (system-enforced):
- Do not trust the worker's completion claim by default.
- Prefer "continue" over "complete" when uncertain.
- If any deterministic check failed, reject completion.
- Treat these worker phrases as red flags: "would you like me to continue", "should I proceed", "all set", "task complete", "done".
- Reject any stop that leaves active TODO items, WORK_LOCK present, or failing verify commands.
- You are not a second worker — do not expand scope or plan features.`;

  // --- Evaluation instructions (user-customizable via JUDGE_PROMPT.md) ---
  const evaluationInstructions =
    customInstructions ||
    `1. Read ${dir}/${TASK_FILE} for the full task description and requirements
2. **Requirements check**: Go through every requirement/acceptance criterion in the task description point by point — verify each one is actually implemented, not just claimed
3. **Code review**: Read the changed files. Check for:
   - Correctness: does the code actually do what the task asks?
   - Obvious bugs, edge cases, or error handling gaps
   - Code quality: no dead code, no debug leftovers, reasonable naming
   - Consistency with the existing codebase style
   Do NOT nitpick style preferences or demand perfection — focus on real issues that would matter in a code review
4. Run any relevant checks yourself if needed (read files, run commands)
5. Keep notes in ${dir}/${JUDGE_TODO_FILE} (tiny scratchpad — for each requirement, note whether it's verified or missing; note any code quality issues found)`;

  // --- Verdict delivery (always present, user cannot override) ---
  const verdictBlock = `FINAL STEP — write verdict (mandatory, system reads this file):
Write your verdict to ${dir}/${VERDICT_FILE} as a JSON file.
  If ALL requirements are met and code quality is acceptable:  {"verdict": "complete", "reason": "..."}
  If ANY requirement is missing or there are real issues:       {"verdict": "continue", "reason": "..."}
Your "reason" must be specific — file paths, what's wrong, what to fix.
Do NOT just print the verdict in text. You MUST write the JSON file. The system cannot read your conversation output.`;

  return `${systemPreamble}

Evaluation instructions${customInstructions ? " (from JUDGE_PROMPT.md)" : ""}:
${evaluationInstructions}

${verdictBlock}`;
}

export function buildJudgeFeedbackPrompt(task, verdict) {
  const dir = taskDirRel(task.taskId);
  return `The judge evaluated your work and found it incomplete.

Judge feedback: ${verdict.reason || "No specific feedback provided."}

Round ${task.currentRound}/${task.maxRounds}. Continue working.
Do not stop while real work remains. Do not ask "should I proceed".
Check ${dir}/${TODO_FILE} for remaining items.
Remove ${dir}/${WORK_LOCK_FILE} only when genuinely done.`;
}
