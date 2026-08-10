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
// Attached mode (Companion loop) — see docs/agent-task-runner.md.
export const CONTEXT_FILE = "CONTEXT.md";
export const VERIFICATION_FILE = "VERIFICATION.md";

export const MAX_OUTPUT_TAIL = 30;
export const FILE_PROMPT_THRESHOLD = 400;
export const DEFAULT_SHOWER_INTERVAL = 5;

export const verdictSchema = z.object({
  verdict: z.enum(["complete", "continue"]),
  reason: z.string().optional().default(""),
});

// ---------------------------------------------------------------------------
// Companion verdict schema v1 (attached mode only). Deliberately separate
// from `verdictSchema` above — that one stays load-bearing for every standard
// task's `readVerdict` and must not be widened. See plan §4.4.
// ---------------------------------------------------------------------------

export const companionRoles = ["reviewer", "planner", "consultant", "critic"] as const;
export const companionRoleSchema = z.enum(companionRoles);

const findingIdSchema = z.string().regex(/^[A-Z]+-[0-9]+$/);
const questionIdSchema = z.string().regex(/^Q-[0-9]+$/);

export const companionFindingSchema = z.object({
  id: findingIdSchema,
  title: z.string().min(1).max(200),
  category: z.enum([
    "requirements",
    "correctness",
    "tests",
    "security",
    "performance",
    "architecture",
    "compatibility",
    "operability",
    "decision",
  ]),
  evidence: z.array(z.string().min(1).max(500)).min(1).max(10),
  impact: z.string().min(1).max(1000),
  requiredAction: z.string().min(1).max(1000),
});

export const companionAdvisorySchema = z.object({
  id: findingIdSchema,
  title: z.string().min(1).max(200),
  evidence: z.array(z.string().max(500)).max(10),
  recommendation: z.string().min(1).max(1000),
  tradeoff: z.string().max(1000).optional(),
});

export const companionQuestionSchema = z.object({
  id: questionIdSchema,
  question: z.string().min(1).max(1000),
  whyNeeded: z.string().min(1).max(1000),
  options: z.array(z.string().min(1).max(500)).max(4).optional(),
});

export const verificationReviewSchema = z.object({
  recordStatus: z.enum(["not-required", "missing", "stale", "fresh"]),
  evidenceReviewed: z.array(z.string().min(1).max(500)).max(20),
  workerActionsRequired: z
    .array(
      z.object({
        commandOrCheck: z.string().min(1).max(1000),
        expectedEvidence: z.string().min(1).max(1000),
        reason: z.string().min(1).max(1000),
      }),
    )
    .max(20),
});

export const companionRoleAnalysisSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("reviewer"),
    requirementAudit: z
      .array(
        z.object({
          requirement: z.string().min(1).max(1000),
          status: z.enum(["verified", "partial", "missing", "unclear"]),
          evidence: z.array(z.string().min(1).max(500)).max(10),
        }),
      )
      .min(1)
      .max(100),
  }),
  z.object({
    type: z.literal("critic"),
    steelman: z.string().min(1).max(2000),
    hypotheses: z
      .array(
        z.object({
          hypothesis: z.string().min(1).max(1000),
          strength: z.enum(["verified", "strong", "speculative"]),
          disposition: z.enum(["blocking", "advisory", "disproved"]),
          evidence: z.array(z.string().max(500)).max(10),
        }),
      )
      .max(50),
  }),
  z.object({
    type: z.literal("planner"),
    planDocument: z.string().min(1).max(1000),
    problemFrame: z.string().min(1).max(3000),
    userBenefitAssessment: z.string().min(1).max(3000),
    assumptions: z
      .array(
        z.object({
          assumption: z.string().min(1).max(1000),
          rationale: z.string().min(1).max(1000),
          riskIfWrong: z.string().min(1).max(1000),
        }),
      )
      .max(30),
    decisions: z
      .array(
        z.object({
          decision: z.string().min(1).max(1000),
          chosenDefault: z.string().min(1).max(1000),
          rationale: z.string().min(1).max(1500),
          userBenefit: z.string().min(1).max(1000),
          alternativesConsidered: z.array(z.string().max(500)).max(3),
        }),
      )
      .max(30),
    coverageAudit: z
      .array(
        z.object({
          area: z.enum([
            "problem",
            "ux",
            "scope",
            "architecture",
            "data-flow",
            "failure-recovery",
            "security",
            "compatibility",
            "mobile-remote",
            "testing",
            "delivery",
            "risks",
          ]),
          status: z.enum(["complete", "partial", "not-applicable"]),
          evidence: z.string().min(1).max(1000),
        }),
      )
      .min(1)
      .max(20),
    openQuestions: z
      .array(
        z.object({
          question: z.string().min(1).max(1000),
          whyUnresolved: z.string().min(1).max(1000),
          assumedDefault: z.string().min(1).max(1000),
          impactIfDifferent: z.string().min(1).max(1000),
          resolveBy: z.string().min(1).max(500),
        }),
      )
      .max(20),
  }),
  z.object({
    type: z.literal("consultant"),
    objective: z.string().min(1).max(2000),
    recommendedNextStep: z.string().min(1).max(2000),
    decisions: z
      .array(
        z.object({
          decision: z.string().min(1).max(1000),
          options: z
            .array(
              z.object({
                option: z.string().min(1).max(500),
                benefits: z.array(z.string().max(500)).max(5),
                costsAndRisks: z.array(z.string().max(500)).max(5),
                reversibility: z.enum(["easy", "moderate", "hard"]),
              }),
            )
            .min(1)
            .max(3),
          recommendation: z.string().min(1).max(1000),
        }),
      )
      .max(10),
  }),
]);

/**
 * Roles whose `complete` verdict may only be signed off against fresh durable
 * evidence Primary actually produced (the completion floor). Only Planner is
 * exempt: it is the one role that completes over a plan document, routinely
 * before any code — or any runnable check — exists at all.
 *
 * Consultant is NOT exempt even though it often rules on a decision rather
 * than code: it may equally well rule on implementation direction, and the
 * role alone does not say which. A decision-only round can still satisfy the
 * floor cheaply — Primary writes a fresh VERIFICATION.md whose "Checks not
 * run" section records why nothing was applicable.
 *
 * NOTE: this is only the *schema* half of the floor. It checks what the
 * Companion claims in verificationReview.recordStatus; the runner separately
 * checks that claim against the record it actually handed to the evaluation
 * (see #handleCompanionVerdict / task.companionEvidence).
 */
export const COMPLETION_REQUIRES_FRESH_VERIFICATION: ReadonlySet<string> = new Set([
  "reviewer",
  "critic",
  "consultant",
]);

export const companionVerdictSchema = z
  .object({
    schemaVersion: z.literal(1),
    role: companionRoleSchema,
    phase: z.enum(["baseline", "round-review", "recovery"]),
    round: z.number().int().min(1),
    // Which evaluation of that phase+round this answers. Optional in the
    // schema only so a verdict written before an in-flight task was upgraded
    // still parses; readCompanionVerdict requires it to match whenever the
    // runner knows which attempt it asked for.
    evaluationAttempt: z.number().int().min(1).optional(),
    verdict: z.enum(["complete", "continue", "needs-input"]),
    reason: z.string().min(1).max(4000),
    verificationReview: verificationReviewSchema,
    roleAnalysis: companionRoleAnalysisSchema,
    blockingFindings: z.array(companionFindingSchema).max(20),
    advisories: z.array(companionAdvisorySchema).max(20),
    questions: z.array(companionQuestionSchema).max(5),
  })
  .superRefine((value, ctx) => {
    if (value.roleAnalysis.type !== value.role) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `roleAnalysis.type ("${value.roleAnalysis.type}") must match role ("${value.role}")`,
        path: ["roleAnalysis", "type"],
      });
    }
    if (value.verdict === "complete") {
      if (value.blockingFindings.length > 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `verdict "complete" must not have blockingFindings`,
          path: ["blockingFindings"],
        });
      }
      if (value.questions.length > 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `verdict "complete" must not have questions`,
          path: ["questions"],
        });
      }
      if (value.verificationReview.workerActionsRequired.length > 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `verdict "complete" requires verificationReview.workerActionsRequired to be empty`,
          path: ["verificationReview", "workerActionsRequired"],
        });
      }
      // Completion floor: without this, "complete" was accepted alongside
      // recordStatus missing/stale/not-required, so an implementation task
      // could finish with no durable verification evidence at all. A record
      // that legitimately ran nothing is still expressible — Primary writes a
      // fresh VERIFICATION.md whose "Checks not run" section says why.
      if (COMPLETION_REQUIRES_FRESH_VERIFICATION.has(value.role) && value.verificationReview.recordStatus !== "fresh") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `role "${value.role}" may only return verdict "complete" with verificationReview.recordStatus "fresh" (got "${value.verificationReview.recordStatus}") — require the missing evidence from Primary with verdict "continue" instead`,
          path: ["verificationReview", "recordStatus"],
        });
      }
    }
    if (value.verdict === "continue") {
      if (value.blockingFindings.length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `verdict "continue" requires at least one blockingFinding`,
          path: ["blockingFindings"],
        });
      }
      if (value.questions.length > 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `verdict "continue" must not have questions`,
          path: ["questions"],
        });
      }
    }
    if (value.verdict === "needs-input" && value.questions.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `verdict "needs-input" requires at least one question`,
        path: ["questions"],
      });
    }
    if (value.role === "planner") {
      if (value.verdict === "needs-input") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `role "planner" must never return verdict "needs-input"`,
          path: ["verdict"],
        });
      }
      if (value.questions.length > 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `role "planner" must keep control "questions" empty — use roleAnalysis.openQuestions instead`,
          path: ["questions"],
        });
      }
    }
  });

export type CompanionVerdict = z.infer<typeof companionVerdictSchema>;
export type CompanionFinding = z.infer<typeof companionFindingSchema>;
export type CompanionAdvisory = z.infer<typeof companionAdvisorySchema>;
export type CompanionQuestion = z.infer<typeof companionQuestionSchema>;
export type VerificationReview = z.infer<typeof verificationReviewSchema>;

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
