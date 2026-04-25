import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  JUDGE_TODO_FILE,
  JUDGE_PROMPT_FILE,
  MAX_OUTPUT_TAIL,
  TASK_FILE,
  TODO_FILE,
  VERDICT_FILE,
  WORK_LOCK_FILE,
  activeItems,
  formatVerifyChecklist,
  parseTodoSections,
  tailLines,
  taskDir,
  taskDirRel,
  verdictSchema,
} from "./agent-task-utils.js";
import { detectProjectVerifyCommands, detectStackReviewHints } from "./agent-task-detection.js";
import type { Logger } from "./logger.js";
import type { ExecResult } from "./agent-task-exec.js";
import type { TaskState } from "../shared/types/task.js";

interface ExecDeps {
  execCommand: (command: string, cwd: string, timeoutMs: number) => Promise<ExecResult>;
  log: Logger;
}

interface CheckResult {
  label: string;
  passed: boolean;
  exitCode: number;
  outputTail: string;
}

export async function runBuiltInChecks(cwd: string, taskId: string, { execCommand, log }: ExecDeps): Promise<CheckResult[]> {
  const dir = taskDir(cwd, taskId);
  const results: CheckResult[] = [];

  let lockExists = false;
  try {
    await access(path.join(dir, WORK_LOCK_FILE));
    lockExists = true;
  } catch {
    // Good — no lock.
  }
  results.push({
    label: "WORK_LOCK absent",
    passed: !lockExists,
    exitCode: lockExists ? 1 : 0,
    outputTail: lockExists ? "WORK_LOCK exists — worker has not signaled completion. Remove it when done." : "",
  });

  try {
    const todoContent = await readFile(path.join(dir, TODO_FILE), "utf8");
    const sections = parseTodoSections(todoContent);

    const inProgress = activeItems(sections["In Progress"] || []);
    results.push({
      label: "TODO: In Progress empty",
      passed: inProgress.length === 0,
      exitCode: inProgress.length > 0 ? 1 : 0,
      outputTail: inProgress.length > 0 ? `Active items:\n${inProgress.join("\n")}` : "",
    });

    const blocked = activeItems(sections["Blocked"] || []);
    results.push({
      label: "TODO: Blocked empty",
      passed: blocked.length === 0,
      exitCode: blocked.length > 0 ? 1 : 0,
      outputTail: blocked.length > 0 ? `Blocked items:\n${blocked.join("\n")}` : "",
    });
  } catch {
    results.push({
      label: "TODO.md exists",
      passed: false,
      exitCode: 1,
      outputTail: "TODO.md not found — worker should create and maintain it.",
    });
  }

  const auditCheck = await checkLockfileAudit(cwd, { execCommand, log });
  if (auditCheck) {
    results.push(auditCheck);
  }

  return results;
}

async function checkLockfileAudit(cwd: string, { execCommand, log }: ExecDeps): Promise<CheckResult | null> {
  try {
    await access(path.join(cwd, "package-lock.json"));
  } catch {
    return null;
  }

  const checks = await Promise.all([
    execCommand("git diff --name-only HEAD -- package-lock.json", cwd, 10_000),
    execCommand("git diff --name-only --cached -- package-lock.json", cwd, 10_000),
  ]);
  const dirty = checks.some((result) => result.stdout.trim().includes("package-lock.json"));
  if (!dirty) return null;

  log.info("lockfile modified by agent, running npm audit", { cwd });
  const result = await execCommand("npm audit --audit-level=high", cwd, 60_000);
  return {
    label: "Lockfile security audit",
    passed: result.exitCode === 0,
    exitCode: result.exitCode,
    outputTail:
      result.exitCode === 0
        ? "package-lock.json changed — npm audit passed."
        : tailLines(result.stderr || result.stdout, MAX_OUTPUT_TAIL),
  };
}

interface VerdictResult {
  verdict: string;
  reason: string;
}

export async function readVerdict(cwd: string, taskId: string, log: Logger): Promise<VerdictResult> {
  const verdictPath = path.join(taskDir(cwd, taskId), VERDICT_FILE);
  try {
    const raw = await readFile(verdictPath, "utf8");
    const data = JSON.parse(raw) as unknown;
    const parsed = verdictSchema.safeParse(data);
    if (!parsed.success) {
      log.warn("verdict file failed schema validation", {
        verdictPath,
        errors: parsed.error.issues.map((issue) => issue.message),
      });
      return {
        verdict: "continue",
        reason: `Verdict file has invalid format: ${parsed.error.issues.map((issue) => issue.message).join(", ")}`,
      };
    }
    log.debug("verdict file parsed", { verdictPath, verdict: parsed.data.verdict });
    return { verdict: parsed.data.verdict, reason: parsed.data.reason };
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === "ENOENT") {
      log.warn("verdict file missing — judge did not write it", { verdictPath });
      return { verdict: "continue", reason: "Judge did not produce a verdict file." };
    }
    log.error("verdict file malformed or unreadable", { verdictPath, err: err.message });
    return { verdict: "continue", reason: `Verdict file could not be parsed: ${err.message}` };
  }
}

export async function clearVerdict(cwd: string, taskId: string): Promise<void> {
  const verdictPath = path.join(taskDir(cwd, taskId), VERDICT_FILE);
  try {
    await rm(verdictPath, { force: true });
  } catch {
    // Ignore.
  }
}

export async function writeTaskFiles(cwd: string, task: TaskState, log: Logger): Promise<void> {
  const dir = taskDir(cwd, task.taskId);
  const relDir = taskDirRel(task.taskId);
  await mkdir(dir, { recursive: true });

  const detected = await detectProjectVerifyCommands(cwd);
  const stackHints = await detectStackReviewHints(cwd);
  const now = new Date().toISOString().replace("T", " ").slice(0, 19);

  const descriptionBlock = task.description
    ? task.description
    : `> No task description provided. Instruct the Worker directly in the terminal,
> or write your task here and press Start.`;

  const verifyChecklist = formatVerifyChecklist(detected);
  const verifySection = verifyChecklist
    ? `## Verification before completion

> Auto-detected from your project. Edit freely — add, remove, or rewrite in your own language.
> The Worker and Judge both read this section. The Worker must run these checks before finishing.

${verifyChecklist}
`
    : `## Verification before completion

> No commands auto-detected. Add your own checks here, for example:
>
> \`- [ ] Run \\\`npm test\\\` — must pass\`
> \`- [ ] Run \\\`npm run lint\\\` — no errors\`
>
> The Worker will run these before finishing. The Judge will verify them independently.
`;

  const taskMd = `# Task

> Created: ${now} | Project: ${cwd}

${descriptionBlock}

${verifySection}
## Rules

- **Commit your work** regularly with clear, descriptive messages (the judge reviews git diffs)
- Update ${relDir}/${TODO_FILE} as you work (move items between sections)
- Before finishing, complete every item in the "Verification before completion" section above
- The judge will independently verify your work
- Focus on completing the task fully — partial completions will be sent back
- Do not push to any remote — the task runner works locally only
- **Do not install new dependencies** unless the task explicitly requires it. If you must add a package, prefer an established version (not the latest release) and pin the exact version (no ^ or ~ prefix)
`;

  const todoMd = `# TODO

> Created: ${now}
>
> The Worker updates this file as it progresses. You can pre-fill items before starting.
> The Task Runner checks that "In Progress" and "Blocked" sections are empty before completion.

## To Do

- [ ] Complete the task described in ${relDir}/${TASK_FILE}

## In Progress

## Done
`;

  const workLock = "Work remains. Remove this file only when the task is complete and all verification steps pass.\n";

  const stackSection = stackHints.length
    ? `\n## Technology-specific checks\n\n${stackHints.map((hint) => `- ${hint}`).join("\n")}\n`
    : "";

  const judgePromptMd = `# Judge Instructions

> Edit this file to customize how the Judge evaluates the Worker's output.
> If this file exists, its content replaces the default judge instructions.
> The Judge always receives the task description, check results, git context,
> and the system-enforced hard rules regardless of what you write here —
> in particular the zero-tolerance completion rule and the forbidden-phrase
> list cannot be overridden.

## Guiding principle — bias toward "continue"

The cost of returning "continue" is a few extra minutes of agent time.
The cost of returning "complete" when something was missed is incomplete work
shipped to the user, who may never catch it. These costs are not symmetric.

Default to "continue" under any uncertainty. If you hedged ("seems", "appears",
"looks like", "probably", "should be", "I think"), if you accepted a worker claim
without verifying it in the code, if you could not produce a file:line citation, or
if you noticed an unexplored area of the change — return "continue". A single
unresolved "I'm not sure" anywhere in your evaluation is sufficient reason to
return "continue".

Judge the code on disk, not the worker's effort or reasoning. "The worker is
close" is an argument for "continue", not for "complete".

## Evaluation steps

1. Read ${relDir}/${TASK_FILE} completely. Also read any plan file referenced in the task (e.g. \`.private/plan-*.md\`). Extract EVERY requirement, acceptance criterion, plan bullet, verification-checklist item, and explicit deliverable into a single flat numbered list.

2. **Verification checklist**: If TASK.md contains a "Verification before completion" section, run each listed command yourself and confirm it passes — do not trust the Worker's claim.

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
   Include concrete file:line citations. A "complete" verdict with no citations, or with any phrase like "mostly", "substantially", "largely", "essentially", "close enough", "good enough", "small enough", or mentioning follow-up/deferred work is by definition wrong — change it to "continue".
${stackSection}
## Severity guide (informational — does NOT soften the completion rule)

- **Blocker** (must fix): broken functionality, security vulnerability, data loss risk, failing tests
- **Major** (should fix): missing error handling, logic bugs, missing edge cases, API contract violations
- **Minor** (still blocks completion if listed in the plan/TODO): naming inconsistencies, dead code, missing types
  Any minor item that was an explicit deliverable or plan bullet still counts as incomplete — severity does not grant a pass.
`;

  await Promise.all([
    writeFile(path.join(dir, TASK_FILE), taskMd, "utf8"),
    writeFile(path.join(dir, TODO_FILE), todoMd, "utf8"),
    writeFile(path.join(dir, JUDGE_PROMPT_FILE), judgePromptMd, "utf8"),
    writeFile(path.join(dir, WORK_LOCK_FILE), workLock, "utf8"),
  ]);

  log.info("task files written", { dir, detectedCommands: detected.length });
}

export async function ensureGitIgnore(cwd: string, log: Logger): Promise<void> {
  const gitignorePath = path.join(cwd, ".gitignore");
  const entry = ".strideterm/";
  try {
    const content = await readFile(gitignorePath, "utf8");
    if (content.includes(entry)) {
      log.trace(".strideterm/ already in .gitignore", { cwd });
      return;
    }
    const separator = content.endsWith("\n") ? "" : "\n";
    await writeFile(gitignorePath, content + separator + entry + "\n", "utf8");
    log.debug("appended .strideterm/ to .gitignore", { cwd });
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === "ENOENT") {
      try {
        await writeFile(gitignorePath, entry + "\n", "utf8");
        log.debug("created .gitignore with .strideterm/ entry", { cwd });
      } catch (writeError) {
        const wErr = writeError as Error;
        log.warn("failed to create .gitignore", { cwd, err: wErr.message });
      }
    } else {
      log.warn("failed to read .gitignore", { cwd, err: err.message });
    }
  }
}

export async function cleanupTaskFiles(cwd: string, taskId: string, log: Logger): Promise<void> {
  if (!cwd || !taskId) {
    log.warn("cleanupTaskFiles: missing cwd or taskId, skipping cleanup", {
      cwd: cwd || "(empty)",
      taskId: taskId || "(empty)",
    });
    return;
  }
  const dir = taskDir(cwd, taskId);
  try {
    await rm(dir, { recursive: true, force: true });
    log.info("task files cleaned up", { dir });
  } catch (error) {
    const err = error as Error;
    log.warn("failed to clean up task files", { dir, err: err.message });
  }
}

export async function waitForFile(filePath: string, timeoutMs = 120_000): Promise<boolean> {
  const start = Date.now();
  const pollInterval = 3000;

  while (Date.now() - start < timeoutMs) {
    try {
      await access(filePath);
      const content = await readFile(filePath, "utf8");
      const trimmed = content.trim();
      if (trimmed.length > 10 && /\w/.test(trimmed)) {
        return true;
      }
    } catch {
      // File doesn't exist yet.
    }
    await new Promise((resolve) => setTimeout(resolve, pollInterval));
  }

  return false;
}
