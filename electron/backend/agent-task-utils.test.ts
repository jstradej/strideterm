import { describe, expect, test } from "vitest";
import { defaultJudgeEvaluationSteps, JUDGE_TODO_FILE, TASK_FILE, VERDICT_FILE, WORKER_FILE } from "./agent-task-utils.js";

// These two "golden" builders are verbatim copies of the pre-refactor inline
// text from agent-task-files.ts's writeTaskFiles (the on-disk JUDGE_PROMPT.md
// template) and agent-task-prompts.ts's buildJudgePrompt (the runtime fallback
// used when no custom JUDGE_PROMPT.md exists), captured via
// `git show HEAD:electron/backend/agent-task-files.ts` /
// `git show HEAD:electron/backend/agent-task-prompts.ts` before the
// defaultJudgeEvaluationSteps extraction. They exist ONLY so this test can
// assert the shared builder reproduces each call site's exact prior output —
// do not "fix" divergences here; the point is byte-for-byte parity with what
// shipped before the refactor.
function goldenFileTemplateSteps(relDir: string): string {
  return `1. Read ${relDir}/${TASK_FILE} (the user's brief) and ${relDir}/${WORKER_FILE} (operational rules + verification checklist) completely. Also read any plan file referenced in the task (e.g. \`.private/plan-*.md\`). Extract EVERY requirement, acceptance criterion, plan bullet, verification-checklist item, and explicit deliverable into a single flat numbered list.

2. **Verification before completion**: Read the project's own documentation (README, agent guide such as CLAUDE.md or AGENTS.md) to determine what counts as a healthy state for this codebase, and run the relevant checks yourself — do not trust the Worker's claim. Concrete steps from the user's brief in ${relDir}/${TASK_FILE} or the "Verification before completion" section of ${relDir}/${WORKER_FILE} (or ${relDir}/${TASK_FILE} for older tasks created before the split) take precedence over generic guidance. If the project has no automated check setup, do a careful manual review of every changed file instead.

3. **Per-requirement audit (mandatory, mechanical)**: For EACH numbered item from step 1, write one of these three labels with a concrete citation from the current working tree or committed diff:
   - \`IMPLEMENTED\` — cite file:line (or \`grep\`/\`git diff\` output) proving the deliverable exists right now. No citation → not allowed to mark it IMPLEMENTED.
   - \`PARTIAL\` — describe exactly what is present vs missing, with file:line references on both sides.
   - \`MISSING\` — the deliverable is not in the code. Cite the grep/search that came back empty.

4. **Code review** of the changed files. Flag only real issues (not style preferences):
   - Correctness: does the code actually do what the task asks?
   - Bugs, unhandled edge cases, missing error handling
   - Dead code, debug leftovers, placeholder values, new TODO comments introduced by the Worker (new TODOs = incomplete work)
   - Tests: if the task required tests, verify they exist and actually cover the behavior, not just smoke-test passes.

5. Run any additional commands needed to verify claims (grep, git diff, cat, test runners).

6. Write the full per-requirement audit from step 3 to ${relDir}/${JUDGE_TODO_FILE} — this is how the user audits your reasoning after the fact, so it must be complete.

7. **Verdict rule (mechanical — no judgment calls):**
   - ANY item from step 3 is PARTIAL or MISSING → verdict "continue"
   - ANY deterministic check failed → verdict "continue"
   - ANY code-review finding of the type in step 4 → verdict "continue"
   - Only if EVERY item is IMPLEMENTED with a concrete citation AND all checks pass AND no code-review findings → verdict "complete"

8. Write your verdict to ${relDir}/${VERDICT_FILE}:
   - Complete: \`{"verdict": "complete", "reason": "All <N> requirements verified implemented: ..."}\`
   - Continue: \`{"verdict": "continue", "reason": "Missing: ...; Partial: ..."}\`
   Include concrete file:line citations. A "complete" verdict with no citations, or with any phrase like "mostly", "substantially", "largely", "essentially", "close enough", "good enough", "small enough", or mentioning follow-up/deferred work is by definition wrong — change it to "continue".`;
}

function goldenRuntimeFallbackSteps(dir: string, readSources: string, opsFile: string): string {
  return `1. Read ${readSources} completely. Also read any plan or specification file the task references. Extract EVERY requirement, acceptance criterion, plan bullet, verification-checklist item, and explicit deliverable into a single flat numbered list.

2. **Verification before completion**: Read the project's own documentation (README, agent guide such as CLAUDE.md or AGENTS.md) to determine what counts as a healthy state for this codebase, and run the relevant checks yourself — do not trust the worker's claim. Concrete steps from the user's brief in ${dir}/${TASK_FILE} or the "Verification before completion" section of ${dir}/${opsFile} take precedence over generic guidance. If the project has no automated check setup, do a careful manual review of every changed file instead.

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
}

describe("defaultJudgeEvaluationSteps", () => {
  test("file-template variant matches the pre-refactor JUDGE_PROMPT.md steps text verbatim", () => {
    const relDir = ".strideterm/tasks/task-abc-123";
    const readSources = `${relDir}/${TASK_FILE} (the user's brief) and ${relDir}/${WORKER_FILE} (operational rules + verification checklist)`;
    const verificationFileRef = `${relDir}/${WORKER_FILE} (or ${relDir}/${TASK_FILE} for older tasks created before the split)`;

    const actual = defaultJudgeEvaluationSteps({
      dir: relDir,
      readSources,
      verificationFileRef,
      variant: "file-template",
    });

    expect(actual).toBe(goldenFileTemplateSteps(relDir));
  });

  test("runtime-fallback variant matches the pre-refactor buildJudgePrompt default instructions verbatim (split-format task)", () => {
    const dir = ".strideterm/tasks/task-fmt-001";
    const opsFile = WORKER_FILE;
    const readSources = `${dir}/${TASK_FILE} (the user's brief) and ${dir}/${WORKER_FILE} (operational rules + verification)`;

    const actual = defaultJudgeEvaluationSteps({
      dir,
      readSources,
      verificationFileRef: `${dir}/${opsFile}`,
      variant: "runtime-fallback",
    });

    expect(actual).toBe(goldenRuntimeFallbackSteps(dir, readSources, opsFile));
  });

  test("runtime-fallback variant matches the pre-refactor buildJudgePrompt default instructions verbatim (legacy task, no WORKER.md)", () => {
    const dir = ".strideterm/tasks/task-legacy-001";
    const opsFile = TASK_FILE;
    const readSources = `${dir}/${TASK_FILE}`;

    const actual = defaultJudgeEvaluationSteps({
      dir,
      readSources,
      verificationFileRef: `${dir}/${opsFile}`,
      variant: "runtime-fallback",
    });

    expect(actual).toBe(goldenRuntimeFallbackSteps(dir, readSources, opsFile));
  });
});
