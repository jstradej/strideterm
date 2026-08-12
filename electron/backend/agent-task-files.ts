import { access, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  CONTEXT_FILE,
  HANDOFF_FILE,
  JUDGE_PROMPT_FILE,
  MAX_OUTPUT_TAIL,
  TASK_FILE,
  TODO_FILE,
  VERDICT_FILE,
  VERIFICATION_FILE,
  WORK_LOCK_FILE,
  WORKER_FILE,
  activeItems,
  companionVerdictSchema,
  defaultJudgeEvaluationSteps,
  extractTaskDescription,
  parseTodoSections,
  tailLines,
  taskDir,
  taskDirRel,
  verdictSchema,
} from "./agent-task-utils.js";
import type { CompanionVerdict } from "./agent-task-utils.js";
import type { Logger } from "./logger.js";
import type { ExecResult } from "./agent-task-exec.js";
import type { CompanionRole, TaskState } from "../shared/types/task.js";

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

export async function runBuiltInChecks(
  cwd: string,
  taskId: string,
  { execCommand, log }: ExecDeps,
): Promise<CheckResult[]> {
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

/**
 * Read TASK.md and extract the user-authored description block.
 * Returns null when the file is missing or unreadable so callers can keep the
 * existing in-memory description; returns "" when the file has no description.
 */
export async function readTaskDescription(cwd: string, taskId: string): Promise<string | null> {
  const taskMdPath = path.join(taskDir(cwd, taskId), TASK_FILE);
  try {
    const content = await readFile(taskMdPath, "utf8");
    return extractTaskDescription(content);
  } catch {
    return null;
  }
}

/**
 * Read TASK.md verbatim. Used by the Companion evaluation prompt, which quotes
 * the whole file (focus + every appended "User clarification" section) rather
 * than the extracted description block — and must always quote what is on disk
 * NOW, not a cached copy from create time.
 */
export async function readTaskMd(cwd: string, taskId: string): Promise<string> {
  try {
    return await readFile(path.join(taskDir(cwd, taskId), TASK_FILE), "utf8");
  } catch {
    return "";
  }
}

/**
 * Returns true when the task uses the new split format (TASK.md = brief only,
 * WORKER.md = operational rules + verification). Falsy result means the task
 * was created before the split and still has rules embedded in TASK.md — both
 * paths must keep working.
 */
export async function taskHasWorkerFile(cwd: string, taskId: string): Promise<boolean> {
  try {
    await access(path.join(taskDir(cwd, taskId), WORKER_FILE));
    return true;
  } catch {
    return false;
  }
}

/**
 * Surgically replace just the user-authored description block in TASK.md.
 * Handles both formats:
 *   - New (split): TASK.md is `# Task` + `> Created:` + description. The whole
 *     post-header body is the description and is replaced wholesale.
 *   - Old (legacy): TASK.md has trailing system sections (`## Verification`,
 *     `## Rules`, `## Technology-specific checks`). Those are preserved and
 *     only the description block between the header and the first system
 *     section gets replaced.
 */
export async function updateTaskDescriptionFile(
  cwd: string,
  taskId: string,
  newDescription: string,
  log: Logger,
): Promise<void> {
  const taskMdPath = path.join(taskDir(cwd, taskId), TASK_FILE);
  const content = await readFile(taskMdPath, "utf8");
  const lines = content.split("\n");
  const endMarkers = new Set(["## Verification before completion", "## Rules", "## Technology-specific checks"]);

  let descStart = 0;
  for (; descStart < lines.length; descStart++) {
    const trimmed = lines[descStart].trim();
    if (!trimmed) continue;
    if (trimmed.startsWith("# ")) continue;
    if (trimmed.startsWith("> Created:")) continue;
    break;
  }

  let descEnd = lines.length;
  for (let i = descStart; i < lines.length; i++) {
    if (endMarkers.has(lines[i].trim())) {
      descEnd = i;
      break;
    }
  }

  const trimmedDescription = (newDescription || "").trim();
  const descriptionBlock = trimmedDescription
    ? trimmedDescription
    : `> No task description provided. Instruct the Worker directly in the terminal,
> or write your task here and press Start.`;

  // Preserve a trailing blank line before the next section so the file stays
  // readable and consistent with writeTaskFiles output.
  const before = lines.slice(0, descStart);
  const after = lines.slice(descEnd);
  const newLines = [...before, descriptionBlock, "", ...after];
  await writeFile(taskMdPath, newLines.join("\n"), "utf8");
  log.info("task description updated", { path: taskMdPath, length: trimmedDescription.length });
}

export async function writeTaskFiles(cwd: string, task: TaskState, log: Logger): Promise<void> {
  const dir = taskDir(cwd, task.taskId);
  const relDir = taskDirRel(task.taskId);
  await mkdir(dir, { recursive: true });

  const now = new Date().toISOString().replace("T", " ").slice(0, 19);

  const descriptionBlock = task.description
    ? task.description
    : `> No task description provided. Instruct the Worker directly in the terminal,
> or write your task here and press Start.`;

  // Single generic verification block, regardless of stack. Auto-detection
  // (npm/mvn/cargo/…) was actively harmful: forced tool-specific commands
  // even when the user's actual task didn't care about them, and got it
  // outright wrong on polyglot or non-standard repos. The agent reads the
  // project's own docs to figure out what "healthy" looks like; concrete
  // verification steps belong in the user's brief in TASK.md, not here.
  const verifySection = `## Verification before completion

> Before finishing, check the project's own documentation (README,
> agent guide such as CLAUDE.md or AGENTS.md) for what counts as a
> healthy state, and run those checks. If the user's brief in
> ${TASK_FILE} above lists concrete steps, those take precedence.
> If the project has no automated check setup, do a careful manual
> review of every file you changed.
`;

  // TASK.md (new split format) is just the user's brief — header + description.
  // Operational rules and verification live in WORKER.md so the user-facing
  // file stays focused on "what should the Worker do?".
  const taskMd = `# Task

> Created: ${now} | Project: ${cwd}

${descriptionBlock}
`;

  const workerMd = `# Worker

> Operational rules and verification checks for the Worker agent. The Worker
> reads this alongside ${TASK_FILE}. Edit only if you know what you're changing —
> these are the same rules the Worker prompt enforces internally.

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

${defaultJudgeEvaluationSteps({
  dir: relDir,
  readSources: `${relDir}/${TASK_FILE} (the user's brief) and ${relDir}/${WORKER_FILE} (operational rules + verification checklist)`,
  verificationFileRef: `${relDir}/${WORKER_FILE} (or ${relDir}/${TASK_FILE} for older tasks created before the split)`,
  variant: "file-template",
})}

## Severity guide (informational — does NOT soften the completion rule)

- **Blocker** (must fix): broken functionality, security vulnerability, data loss risk, failing tests
- **Major** (should fix): missing error handling, logic bugs, missing edge cases, API contract violations
- **Minor** (still blocks completion if listed in the plan/TODO): naming inconsistencies, dead code, missing types
  Any minor item that was an explicit deliverable or plan bullet still counts as incomplete — severity does not grant a pass.
`;

  await Promise.all([
    writeFile(path.join(dir, TASK_FILE), taskMd, "utf8"),
    writeFile(path.join(dir, WORKER_FILE), workerMd, "utf8"),
    writeFile(path.join(dir, TODO_FILE), todoMd, "utf8"),
    writeFile(path.join(dir, JUDGE_PROMPT_FILE), judgePromptMd, "utf8"),
    writeFile(path.join(dir, WORK_LOCK_FILE), workLock, "utf8"),
  ]);

  log.info("task files written", { dir });
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

// ---------------------------------------------------------------------------
// Attached mode (Companion loop) file I/O — see plan §8.3 (capture),
// §4.14 (Worker verification artifact), §4.4 (companion verdict v1).
// ---------------------------------------------------------------------------

const COMPANION_ROLE_LABELS: Record<CompanionRole, string> = {
  reviewer: "Reviewer",
  planner: "Planner",
  consultant: "Consultant",
  critic: "Critic",
};

/**
 * Initial on-disk files for an attached task. Deliberately NOT the standard
 * writeTaskFiles set: no TODO.md/WORK_LOCK — there is no Worker panel to
 * instruct, and the baseline Companion review deliberately runs with
 * WORK_LOCK absent (plan §3.4/§8.4). TASK.md holds only the optional user
 * focus; CONTEXT.md/HANDOFF.md come later from the Primary capture. WORKER.md
 * *is* written here — plan §6's artifact table describes it as the durable
 * rules for the Primary across the whole loop, distinct from the per-round
 * feedback prompts (buildCompanionFeedbackPrompt etc.) which restate parts of
 * it in context.
 */
export async function writeCompanionInitialFiles(cwd: string, task: TaskState, log: Logger): Promise<void> {
  const dir = taskDir(cwd, task.taskId);
  await mkdir(dir, { recursive: true });
  const roleLabel = COMPANION_ROLE_LABELS[(task.companionRole as CompanionRole) || "reviewer"];

  const taskMd = `# Companion focus

${task.companionFocus?.trim() || "No additional focus specified."}
`;

  const workerMd = `# Worker

> Durable rules for you, the Primary, for the whole ${roleLabel} companion
> loop attached to this conversation. Unlike ${TASK_FILE}/${JUDGE_PROMPT_FILE},
> editing this file never changes your command, model, session, or
> permissions — it is guidance, not configuration. This loop never touches
> any of those either.

## Rules

- You are the same live conversation the user was already in before this
  companion loop started. Never restart yourself, run \`/clear\`, or resume a
  different session — the runner never does either of those to you.
- ${TASK_FILE} (the user's focus and later clarifications) and, once approved,
  ${CONTEXT_FILE} are the scope authority. ${HANDOFF_FILE} is your progress
  evidence, never scope.
- After making changes, run the checks relevant to this round yourself and
  record the exact commands, exit codes, and results in ${VERIFICATION_FILE}
  before removing ${WORK_LOCK_FILE} — the companion never runs project
  commands itself.
- Keep ${TODO_FILE} and ${HANDOFF_FILE} up to date as you work.
- Remove ${WORK_LOCK_FILE} only when you believe this round's work is
  genuinely done.
- The ${roleLabel} companion reviews independently once ${WORK_LOCK_FILE} is
  removed — don't ask whether to continue, keep working until the next
  evaluation.
- Do not push to any remote — the task runner works locally only.
- **Do not install new dependencies** unless the task explicitly requires it.
  If you must add a package, prefer an established version (not the latest
  release) and pin the exact version (no ^ or ~ prefix).
`;

  const judgePromptMd = `# ${roleLabel} customization

> This file is ADDITIONAL companion instructions only (plan §4.13). It can
> add focus — what to pay extra attention to — but can NEVER replace the
> runner contract or the ${roleLabel} role policy, and it can never enable
> the companion to execute project code, builds, tests, or writes outside
> this task's own artifact files (JUDGE_TODO.md / verdict.json).
>
> Leave this file empty (or restore this notice) to use the default
> ${roleLabel} policy with no extra focus.
`;

  await Promise.all([
    writeFile(path.join(dir, TASK_FILE), taskMd, "utf8"),
    writeFile(path.join(dir, WORKER_FILE), workerMd, "utf8"),
    writeFile(path.join(dir, JUDGE_PROMPT_FILE), judgePromptMd, "utf8"),
  ]);
  log.info("companion initial files written", { dir, role: task.companionRole });
}

const CONTEXT_HEADINGS = [
  "# Objective",
  "# Confirmed requirements",
  "# Acceptance criteria",
  "# Constraints",
  "# Decisions already made",
  "# Explicit non-goals",
  "# Open questions or ambiguities",
];

const HANDOFF_HEADINGS = [
  "# Current state",
  "# Work already completed",
  "# Work in progress",
  "# Files and commits touched",
  "# Verification already run",
  "# External or destructive side effects already performed",
  "# Known blockers",
  "# Recommended next step",
];

function missingHeadings(content: string, headings: string[]): string[] {
  return headings.filter((h) => !content.includes(h));
}

/** Cheap "is this real content, not a placeholder" heuristic — mirrors waitForFile's. */
function isSubstantive(content: string, minLength = 80): boolean {
  return content.trim().length >= minLength;
}

export async function readCaptureFiles(cwd: string, taskId: string): Promise<{ contextMd: string; handoffMd: string }> {
  const dir = taskDir(cwd, taskId);
  const [contextMd, handoffMd] = await Promise.all([
    readFile(path.join(dir, CONTEXT_FILE), "utf8").catch(() => ""),
    readFile(path.join(dir, HANDOFF_FILE), "utf8").catch(() => ""),
  ]);
  return { contextMd, handoffMd };
}

export interface CaptureValidationResult {
  ok: boolean;
  contextExists: boolean;
  handoffExists: boolean;
  contextMissingHeadings: string[];
  handoffMissingHeadings: string[];
  contextTooShort: boolean;
  handoffTooShort: boolean;
  /** True when the file on disk predates `sinceIso` — a leftover capture from
   * an earlier attempt, not something the current Primary turn produced. */
  contextStale: boolean;
  handoffStale: boolean;
}

/** True when the file exists and its mtime predates `sinceMs`. Mirrors the
 * freshness comparison readVerificationRecord uses for VERIFICATION.md. */
async function isOlderThan(filePath: string, sinceMs: number): Promise<boolean> {
  try {
    const st = await stat(filePath);
    return st.mtime.getTime() < sinceMs;
  } catch {
    // Missing/unreadable — the *Exists* checks already report that.
    return false;
  }
}

/**
 * Validates the two capture artifacts written by the Primary's
 * CONTEXT-CAPTURE-ONLY turn (plan §8.3). Checks structure (required
 * headings), a "not a placeholder" length heuristic, and — when `sinceIso` is
 * given — that both files were actually written after the capture started.
 * Never subjective content quality, which is left to the user's Brief-ready
 * review.
 */
export async function validateCaptureFiles(
  cwd: string,
  taskId: string,
  { sinceIso }: { sinceIso?: string | null } = {},
): Promise<CaptureValidationResult> {
  const dir = taskDir(cwd, taskId);
  const { contextMd, handoffMd } = await readCaptureFiles(cwd, taskId);
  const contextExists = contextMd.trim().length > 0;
  const handoffExists = handoffMd.trim().length > 0;
  const contextMissingHeadings = contextExists ? missingHeadings(contextMd, CONTEXT_HEADINGS) : CONTEXT_HEADINGS;
  const handoffMissingHeadings = handoffExists ? missingHeadings(handoffMd, HANDOFF_HEADINGS) : HANDOFF_HEADINGS;
  const contextTooShort = !isSubstantive(contextMd);
  const handoffTooShort = !isSubstantive(handoffMd);
  const sinceMs = sinceIso ? Date.parse(sinceIso) : NaN;
  const [contextStale, handoffStale] = Number.isFinite(sinceMs)
    ? await Promise.all([
        isOlderThan(path.join(dir, CONTEXT_FILE), sinceMs),
        isOlderThan(path.join(dir, HANDOFF_FILE), sinceMs),
      ])
    : [false, false];
  return {
    contextExists,
    handoffExists,
    contextMissingHeadings,
    handoffMissingHeadings,
    contextTooShort,
    handoffTooShort,
    contextStale,
    handoffStale,
    ok:
      contextExists &&
      handoffExists &&
      contextMissingHeadings.length === 0 &&
      handoffMissingHeadings.length === 0 &&
      !contextTooShort &&
      !handoffTooShort &&
      !contextStale &&
      !handoffStale,
  };
}

/**
 * The unfilled command lines the template ships with. A file still carrying
 * any of them is an untouched template, not a record — checked explicitly by
 * readVerificationRecord so the completion floor never rests on mtime ordering
 * alone. Kept as the template's own source text so the two can't drift.
 */
const VERIFICATION_PLACEHOLDERS = [
  "Command: `<exact command>`",
  "Result: PASS | FAIL | NOT-RUN",
  "Exit code: <number or n/a>",
];

/**
 * Atomically (write to temp + rename) create/overwrite the VERIFICATION.md
 * template for the next evaluation round. Written by the runner right after
 * a Companion "continue" (plan §4.14); the Primary then overwrites it with
 * real command results before removing WORK_LOCK.
 *
 * Every caller must write this BEFORE stamping the freshness baseline it hands
 * readVerificationRecord as `sinceIso` — a template that is newer than the
 * baseline would otherwise satisfy the freshness gate on its own.
 */
export async function writeVerificationTemplate(
  cwd: string,
  taskId: string,
  round: number,
  log: Logger,
): Promise<void> {
  const dir = taskDir(cwd, taskId);
  await mkdir(dir, { recursive: true });
  const filePath = path.join(dir, VERIFICATION_FILE);
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  const template = `# Verification

Evaluation target: ${round}
Recorded at: <fill in with an ISO timestamp when you write this>

## Commands

### V-1
${VERIFICATION_PLACEHOLDERS[0]}
${VERIFICATION_PLACEHOLDERS[1]}
${VERIFICATION_PLACEHOLDERS[2]}
Relevant output: <bounded summary or task-local log path>

## Checks not run

- \`<command or check>\` — <why it was unsafe, unavailable, or irrelevant>

## Current limitations

- <what these results do not prove>
`;
  await writeFile(tmpPath, template, "utf8");
  await rename(tmpPath, filePath);
  log.info("verification template written", { dir, round });
}

/**
 * `writeVerificationTemplate` plus an undo. Returns a callback that restores
 * whatever VERIFICATION.md was there before (removing the file if there was
 * none).
 *
 * Send back needs both halves: the template has to be on disk BEFORE the
 * prompt reaches the Primary — otherwise a Primary that starts recording
 * immediately has its record overwritten by a template landing behind it —
 * yet it overwrites the record the round was just signed off against, so a
 * send-back whose injection never landed must put that record back.
 *
 * Both halves fail loudly. Reading the previous record throws unless the file
 * is genuinely absent, so a transient EACCES/EBUSY can't be mistaken for "there
 * was nothing here" and have the rollback delete a record that was there all
 * along; and the undo callback rejects rather than swallowing, so a caller
 * never reports "the verdict stands" over evidence it failed to restore.
 */
export async function writeVerificationTemplateReversibly(
  cwd: string,
  taskId: string,
  round: number,
  log: Logger,
): Promise<() => Promise<void>> {
  const filePath = path.join(taskDir(cwd, taskId), VERIFICATION_FILE);
  let previous: string | null;
  try {
    previous = await readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
    previous = null;
  }
  await writeVerificationTemplate(cwd, taskId, round, log);
  return async () => {
    if (previous === null) {
      await rm(filePath, { force: true });
    } else {
      const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
      await writeFile(tmpPath, previous, "utf8");
      await rename(tmpPath, filePath);
    }
    log.info("verification template rolled back", { filePath, restored: previous !== null });
  };
}

export interface VerificationRecord {
  status: "missing" | "invalid" | "stale" | "fresh";
  round: number | null;
  content: string;
  mtimeIso: string | null;
}

/**
 * Read-only structural + freshness check of VERIFICATION.md — never runs a
 * project command (plan §8.4). "stale" covers both a wrong round tag and a
 * record written before `sinceIso` (the last time feedback was injected into
 * the Primary), so a record left over from a previous round can't pass.
 */
export async function readVerificationRecord(
  cwd: string,
  taskId: string,
  { expectedRound, sinceIso }: { expectedRound: number; sinceIso?: string | null },
): Promise<VerificationRecord> {
  const filePath = path.join(taskDir(cwd, taskId), VERIFICATION_FILE);
  let content: string;
  let mtimeIso: string | null;
  try {
    content = await readFile(filePath, "utf8");
    const stats = await stat(filePath);
    mtimeIso = stats.mtime.toISOString();
  } catch {
    return { status: "missing", round: null, content: "", mtimeIso: null };
  }
  const targetMatch = content.match(/Evaluation target:\s*(\d+)/i);
  const round = targetMatch ? Number(targetMatch[1]) : null;
  const hasCommandsHeading = /^##\s+Commands/m.test(content);
  if (!hasCommandsHeading || round === null) {
    return { status: "invalid", round, content, mtimeIso };
  }
  // The runner's own template satisfies every structural requirement above, so
  // structure + freshness alone would let an untouched one pass as evidence.
  // It is not a record until the placeholders are gone, whatever its mtime.
  if (VERIFICATION_PLACEHOLDERS.some((placeholder) => content.includes(placeholder))) {
    return { status: "invalid", round, content, mtimeIso };
  }
  if (round !== expectedRound) {
    return { status: "stale", round, content, mtimeIso };
  }
  if (sinceIso && mtimeIso) {
    const mtimeMs = Date.parse(mtimeIso);
    const sinceMs = Date.parse(sinceIso);
    // `<=`, not `<`: the baseline is stamped immediately after the template is
    // written, so on a coarse clock the two land on the same millisecond and a
    // strict comparison would call the template fresh. A real record is always
    // written a round's worth of work later, so nothing legitimate is lost.
    if (Number.isFinite(mtimeMs) && Number.isFinite(sinceMs) && mtimeMs <= sinceMs) {
      return { status: "stale", round, content, mtimeIso };
    }
  }
  return { status: "fresh", round, content, mtimeIso };
}

/**
 * Atomically append a dated "User clarification" section to TASK.md after
 * the user answers a companion `needs-input` question (plan §8.5 point 1).
 * The clarification becomes authoritative task scope, same as the original
 * description — this is the only writer of TASK.md besides the create flow.
 */
export async function appendUserClarification(
  cwd: string,
  taskId: string,
  { timestamp, questionIds, answer }: { timestamp: string; questionIds: string[]; answer: string },
  log: Logger,
): Promise<void> {
  const filePath = path.join(taskDir(cwd, taskId), TASK_FILE);
  const answerBlock = `Answers ${questionIds.join(", ")}:\n\n${answer.trim()}`;
  const section = `\n## User clarification (${timestamp})\n\n${answerBlock}\n`;
  let existing: string;
  try {
    existing = await readFile(filePath, "utf8");
  } catch {
    existing = "# Companion focus\n\nNo additional focus specified.\n";
  }
  // Idempotent: answering is retried when injecting the prompt into the Primary
  // fails, and the same answer to the same IDs must not stack up duplicate
  // sections in what is the task's authoritative scope document.
  if (existing.includes(answerBlock)) {
    log.info("user clarification already present in TASK.md — skipping append", { filePath, questionIds });
    return;
  }
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmpPath, existing.replace(/\n+$/, "\n") + section, "utf8");
  await rename(tmpPath, filePath);
  log.info("user clarification appended to TASK.md", { filePath, questionIds });
}

export interface CompanionVerdictReadResult {
  status: "valid" | "missing" | "invalid" | "stale";
  data: CompanionVerdict | null;
  errors: string[];
  /** Exactly the bytes read from disk, or null when there was no readable file.
   * The runner fingerprints this to tell "the Companion rewrote the verdict and
   * it is still wrong" (spend a repair attempt) from "the same rejected file is
   * being re-read by another idle signal" (spend nothing). */
  raw: string | null;
}

/**
 * Mode-aware companion verdict reader — the attached counterpart to
 * `readVerdict`. Reuses the same VERDICT_FILE name (plan §4.4: "Zachovat
 * filename verdict.json") but validates against `companionVerdictSchema` and
 * additionally requires role/phase/round/evaluationAttempt to match what the
 * runner actually requested, so a leftover verdict from a previous evaluation
 * is never mistaken for a fresh one.
 *
 * The attempt matters because role/phase/round do not identify an evaluation on
 * their own: a `needs-input` answer and a withheld completion both re-evaluate
 * the same phase and round. `expected.evaluationAttempt` is omitted only for a
 * task that was already mid-evaluation when it was upgraded to the
 * attempt-aware protocol — then the older identity check is all there is.
 */
export async function readCompanionVerdict(
  cwd: string,
  taskId: string,
  expected: { role: string; phase: string; round: number; evaluationAttempt?: number },
  log: Logger,
): Promise<CompanionVerdictReadResult> {
  const verdictPath = path.join(taskDir(cwd, taskId), VERDICT_FILE);
  let raw: string;
  try {
    raw = await readFile(verdictPath, "utf8");
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === "ENOENT") return { status: "missing", data: null, errors: [], raw: null };
    log.error("companion verdict file unreadable", { verdictPath, err: err.message });
    return { status: "invalid", data: null, errors: [err.message], raw: null };
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (error) {
    return { status: "invalid", data: null, errors: [(error as Error).message], raw };
  }
  const parsed = companionVerdictSchema.safeParse(json);
  if (!parsed.success) {
    const errors = parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`);
    log.warn("companion verdict failed schema validation", { verdictPath, errors });
    return { status: "invalid", data: null, errors, raw };
  }
  const data = parsed.data;
  const attemptMismatch =
    typeof expected.evaluationAttempt === "number" && data.evaluationAttempt !== expected.evaluationAttempt;
  if (
    data.role !== expected.role ||
    data.phase !== expected.phase ||
    data.round !== expected.round ||
    attemptMismatch
  ) {
    log.warn("companion verdict is stale (role/phase/round/attempt mismatch)", {
      verdictPath,
      expected,
      actual: {
        role: data.role,
        phase: data.phase,
        round: data.round,
        evaluationAttempt: data.evaluationAttempt ?? null,
      },
    });
    return { status: "stale", data, errors: [], raw };
  }
  return { status: "valid", data, errors: [], raw };
}
