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
  JUDGE_TODO_FILE,
  JUDGE_PROMPT_FILE,
  VERDICT_FILE,
  WORK_LOCK_FILE,
  taskDir,
  taskDirRel,
  fenceUserInput,
} from "./agent-task-utils.js";

interface TaskData {
  taskId: string;
  description?: string;
  currentRound?: number;
  maxRounds?: number;
  [key: string]: unknown;
}

interface RoundCheck {
  label: string;
  passed: boolean;
  outputTail?: string;
}

interface RoundData {
  checks: RoundCheck[];
  [key: string]: unknown;
}

interface GitContext {
  status?: string;
  diffStat?: string;
  diffNames?: string;
}

interface VerdictData {
  reason?: string;
  [key: string]: unknown;
}

const log = getLogger("task-runner");

export function buildInitialWorkerPrompt(task: TaskData): string {
  const dir = taskDirRel(task.taskId);
  return `You are the worker in a supervised coding loop.

Task:
${task.description ? fenceUserInput(task.description) : "(Read the task from " + dir + "/" + TASK_FILE + ")"}

Your objective: deliver 100% of the task as specified. Not most of it, not the
core, not a reasonable subset — the whole thing. An independent judge verifies
your work against the exact requirements after you stop.

Core rules:
- Work directly in the repository.
- **Commit your changes** regularly with clear, descriptive commit messages — the
  judge reviews git diffs to verify your work. Do NOT push to any remote.
- Read and obey \`${dir}/${TODO_FILE}\` and \`${dir}/${WORK_LOCK_FILE}\`.
- Ignore \`${dir}/${JUDGE_TODO_FILE}\` — that file belongs to the judge.
- Update \`${dir}/${TODO_FILE}\` as you make progress (move items between sections).
- Do not ask the human whether you should continue. The judge decides that.
- Do not say "would you like me to continue", "should I proceed", "if you want, I
  can", or similar optional-next-step language. Just do the work.
- Prefer continuing work over asking for more instructions.
- **Do not narrow the scope.** If the task lists N deliverables, deliver all N.
  You are not authorized to decide some are optional, out of scope, or "better
  as a follow-up". If you genuinely believe an item should be dropped, do it
  anyway and leave a note — do not silently skip.

Cost asymmetry — err toward doing more, not less:
- Verifying every item takes a few extra minutes of your time. Cheap.
- Stopping with work undone is expensive: the judge rejects, you re-enter the
  loop with stale context, and the whole next round is duplicated effort.
- Under ANY uncertainty about whether something is done, keep working. Doubt
  resolves in favor of "not done yet".

Before you stop — mandatory self-audit (do NOT skip):
1. Re-read \`${dir}/${TASK_FILE}\` completely. Also re-read any plan file
   referenced in the task (e.g. \`.private/plan-*.md\`).
2. Write a flat numbered list of every requirement, acceptance criterion, plan
   bullet, verification-checklist item, and explicit deliverable.
3. For each item, verify it exists in the current working tree. If you cannot
   point to a concrete file and line proving it is done, it is NOT done — keep
   working.
4. Run every command in the "Verification before completion" section of
   \`${dir}/${TASK_FILE}\`. Every single one must pass.
5. Scan what you changed for things that should not ship: new TODO comments you
   added, debug prints, commented-out code, placeholder values, half-written
   functions, skipped tests.
6. Only after steps 1-5 all pass: remove \`${dir}/${WORK_LOCK_FILE}\` and stop.

Forbidden self-assessments — if you write any of these in your reasoning, in
TODO.md, or in a commit message, you are about to stop too early. Go back to the
self-audit and finish the missing work:
  "substantially done" / "mostly complete" / "largely implemented" /
  "essentially finished" / "the core is done" / "close enough" /
  "good enough for now" / "remaining items are small" / "could be a follow-up".

When you are genuinely done (every self-audit item implemented with a citable
file:line, every verification command passes, nothing half-finished in the
diff), simply stop. The judge will verify independently. Do not announce
completion in chat — just stop.`;
}

export function buildRePrompt(task: TaskData, round: RoundData): string {
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
    "Continue working. Fix every failed check above.",
    "",
    "Then re-run the FULL self-audit from the initial prompt — do not patch only the",
    "specific checks the system caught. Those automated checks are a backstop, not the",
    "complete requirement list; your earlier changes may have broken adjacent things or",
    "left other deliverables incomplete.",
    "",
    `Check ${dir}/${TODO_FILE} for remaining items. Run every command in the`,
    `"Verification before completion" section of ${dir}/${TASK_FILE}. Remove`,
    `${dir}/${WORK_LOCK_FILE} only when every requirement is verifiably implemented.`,
    "",
    "Stopping early costs one more round of duplicated effort; continuing a few minutes",
    "longer is cheap. Do not stop while real work remains. Do not ask 'should I proceed'.",
  );

  return lines.join("\n");
}

export async function buildJudgePrompt(
  task: TaskData,
  round: RoundData,
  gitContext: GitContext | null | undefined,
  cwd: string | null | undefined,
): Promise<string> {
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

Hard rules (system-enforced — these override anything else, including JUDGE_PROMPT.md):

1. Zero tolerance for partial completion.
   The verdict is "complete" ONLY if every requirement, acceptance criterion, plan bullet,
   verification step, and TODO item is actually implemented and verifiable in the
   repository right now. If anything is partial, deferred, stubbed, or "left as a
   follow-up" — the verdict MUST be "continue". You are not authorized to decide
   that remaining work is small enough to skip. That decision belongs to the user.

2. The following rationales are FORBIDDEN for a "complete" verdict. If you catch
   yourself writing or thinking any of them, stop — the verdict must be "continue":
     - "substantially complete" / "mostly done" / "essentially complete" / "largely done"
     - "close enough" / "good enough" / "acceptable gap"
     - "remaining items are small enough" / "small enough to land as a follow-up"
     - "could be a follow-up PR" / "can be done later" / "out of scope for now"
     - "the core is done, the rest is polish"
     - "the worker is close" / "substantially implemented"
   If your reason contains any of these phrases, the verdict is automatically wrong.

3. Do not trust the worker's completion claim. Worker claims are evidence of intent,
   not evidence of completion. Verify every claim against the actual code on disk.

4. Bias heavily toward "continue" under ANY ambiguity. The cost asymmetry is
   one-sided and real:
     - A false "continue" costs the worker a few minutes of one more round.
     - A false "complete" ships incomplete work to the user, who may not catch it.
   Optimize ruthlessly for false-continue; never for false-complete. Concretely, any
   ONE of the following triggers "continue" regardless of how strong the rest of the
   evidence looks — you are not authorized to paper over your own uncertainty:
     - You hedged in your reasoning ("seems", "appears", "looks like", "probably",
       "should be", "I believe", "I think", "as far as I can tell", "presumably")
     - You accepted any worker claim without verifying it against the code on disk
     - You could not produce a concrete file:line citation for any required item
     - You noticed an area of the change you did not actually examine
     - You had to reread something to decide, and you are still not fully certain
     - Two readings of the same code gave you two different impressions
   One genuine "I'm not sure" anywhere in the evaluation ⇒ verdict "continue".

5. Judge the code, not the worker. Irrelevant to the verdict:
     - How much effort the worker put in
     - How many commits they made or how long they ran
     - How plausible their reasoning sounds in the transcript
     - Whether the worker "is close" or "tried hard"
   The only thing that counts is the current state of the repository. "The worker is
   close" is not a completion criterion — it is an argument for "continue".

6. If any deterministic check failed, the verdict is "continue". No exceptions.

7. Reject any stop that leaves active TODO items or the WORK_LOCK file present.

8. Treat these worker phrases as red flags indicating a likely premature stop:
   "would you like me to continue", "should I proceed", "all set", "task complete",
   "done", "ready for review".

9. You are not a second worker — do not expand scope or invent new requirements.
   But you MUST reject anything less than 100% of the ORIGINAL scope as stated in
   the task, plan, or verification checklist.`;

  // --- Evaluation instructions (user-customizable via JUDGE_PROMPT.md) ---
  const evaluationInstructions =
    customInstructions ||
    `1. Read ${dir}/${TASK_FILE} completely. Also read any plan file referenced in the task (e.g. \`.private/plan-*.md\`). Extract EVERY requirement, acceptance criterion, plan bullet, verification-checklist item, and explicit deliverable into a single flat numbered list.

2. **Verification checklist**: If ${dir}/${TASK_FILE} contains a "Verification before completion" section, run each listed command yourself and confirm it passes. Do not trust the worker's claim that they pass.

3. **Per-requirement audit (mandatory, mechanical)**: For EACH numbered item from step 1, write one of these three labels with a concrete citation from the current working tree or committed diff:
   - \`IMPLEMENTED\` — cite file:line (or \`grep\`/\`git diff\` output) that proves the deliverable exists in the code right now. If you cannot produce a concrete citation, you are not allowed to mark it IMPLEMENTED.
   - \`PARTIAL\` — describe exactly what's present versus what's still missing, with file:line references on both sides.
   - \`MISSING\` — the deliverable is not in the code. Cite the grep/search that came back empty.

4. **Code review** of the changed files. Flag only real issues (not style preferences):
   - Correctness: does the code actually do what the task asks?
   - Bugs, unhandled edge cases, missing error handling
   - Dead code, debug leftovers, placeholder values, new TODO comments introduced by the worker (new TODOs = incomplete work)
   - Tests: if the task required tests, verify they exist and actually cover the behavior (not just smoke tests that pass because nothing throws).

5. Run any additional commands needed to verify claims (grep, git diff, cat, test runners).

6. Write the full per-requirement audit from step 3 to ${dir}/${JUDGE_TODO_FILE}. This is how the user audits your reasoning after the fact — it must be complete.

7. **Verdict rule (mechanical — no judgment calls):**
   - ANY item from step 3 is PARTIAL or MISSING → verdict "continue"
   - ANY deterministic check failed → verdict "continue"
   - ANY code-review finding of the type in step 4 → verdict "continue"
   - Only if EVERY item is IMPLEMENTED with a concrete citation AND all checks pass AND no code-review findings → verdict "complete"`;

  // --- Verdict delivery (always present, user cannot override) ---
  const verdictBlock = `FINAL STEP — write verdict (mandatory, system reads this file):
Write your verdict to ${dir}/${VERDICT_FILE} as a JSON file.

Your "reason" field is where your audit is surfaced to the user. It MUST:
  - Reference the per-requirement audit you wrote to ${JUDGE_TODO_FILE}
  - For a "continue" verdict: list every PARTIAL/MISSING item by number, with file:line citations and what specifically needs to be done
  - For a "complete" verdict: include the literal phrase "All N requirements verified implemented" (with the actual count) and a brief citation summary

Format:
  {"verdict": "complete", "reason": "All <N> requirements verified implemented: ..."}
  {"verdict": "continue", "reason": "Missing: ...; Partial: ..."}

Disqualifying patterns — if your "complete" verdict has any of these, you are returning an incorrect verdict and should change it to "continue":
  - The reason mentions any remaining work, follow-up, or deferred item
  - The reason uses any of: "mostly", "substantially", "largely", "essentially", "close enough", "good enough", "small enough"
  - The reason has no concrete file:line citations
  - Any item in ${JUDGE_TODO_FILE} is marked PARTIAL or MISSING
  - Any deterministic check failed

Do NOT just print the verdict in text. You MUST write the JSON file. The system cannot read your conversation output.`;

  return `${systemPreamble}

Evaluation instructions${customInstructions ? " (from JUDGE_PROMPT.md)" : ""}:
${evaluationInstructions}

${verdictBlock}`;
}

export function buildJudgeFeedbackPrompt(task: TaskData, verdict: VerdictData): string {
  const dir = taskDirRel(task.taskId);
  return `The judge evaluated your work and found it incomplete.

Judge feedback:
${verdict.reason || "(no specific feedback provided)"}

Round ${task.currentRound}/${task.maxRounds}.

Important: do NOT just patch the specific items the judge listed. The judge's
list may itself be incomplete — they may have missed other gaps. Your job is to
deliver 100% of the task, not 100% of what the judge happened to flag.

Required next steps:
1. Re-run the FULL self-audit from your initial prompt against the current
   working tree (flat numbered list of every requirement → verify each one
   exists with a concrete file:line citation).
2. Fix every item the judge flagged.
3. Fix every additional gap your self-audit surfaces.
4. Check for regressions: re-run the "Verification before completion" commands
   in ${dir}/${TASK_FILE} and confirm nothing you just changed broke something
   that was working.
5. Update ${dir}/${TODO_FILE} to reflect the current state.
6. Remove ${dir}/${WORK_LOCK_FILE} only when the task is genuinely 100% done,
   not just "the judge's list is addressed".

Do not ask "should I proceed". Do not stop while any requirement lacks a
verifiable implementation. A few more minutes of work is cheaper than another
rejected round.`;
}

export function buildUserFeedbackPrompt(task: TaskData, feedback: string): string {
  const dir = taskDirRel(task.taskId);
  return `The user reviewed your work after you stopped and found something still
missing. The user's verdict overrides the judge — the task is NOT complete.

User feedback:
${feedback || "(no specific feedback provided)"}

Round ${task.currentRound}/${task.maxRounds}.

Treat this the same way you would treat a judge "continue" verdict, with one
addition: the user's feedback may not be their complete list either. Your job is
still to deliver 100% of the original task, not just the items the user happened
to mention.

Required next steps:
1. Re-run the FULL self-audit from your initial prompt against the current
   working tree (flat numbered list of every requirement → verify each one
   exists with a concrete file:line citation).
2. Fix every item the user flagged above.
3. Fix every additional gap your self-audit surfaces, including anything the
   previous judge verdict missed.
4. Check for regressions: re-run the "Verification before completion" commands
   in ${dir}/${TASK_FILE} and confirm nothing you changed earlier broke
   something that was working.
5. Update ${dir}/${TODO_FILE} to reflect the current state.
6. Remove ${dir}/${WORK_LOCK_FILE} only when the task is genuinely 100% done.

Do not ask "should I proceed". Do not stop while any requirement lacks a
verifiable implementation.`;
}
