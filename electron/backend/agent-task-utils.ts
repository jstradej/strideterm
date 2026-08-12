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
/**
 * Prompt hand-off file, per role. A prompt over FILE_PROMPT_THRESHOLD is not
 * pasted into the PTY — the agent is told to go read this file, and the read
 * happens whenever it gets around to it. With one shared PROMPT.md, a prompt
 * written for the other role in that window replaced the one an agent had
 * been sent to read, and it would then follow the wrong role's instructions
 * with no error anywhere. The runner's own flow keeps the two roles a turn
 * apart, but a manual Resend or a dropout re-inject does not.
 */
export function promptFileFor(role: "worker" | "judge"): string {
  return role === "judge" ? "PROMPT.judge.md" : "PROMPT.worker.md";
}
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

const reviewerAnalysisSchema = z.object({
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
});

const criticAnalysisSchema = z.object({
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
});

const plannerAnalysisSchema = z.object({
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
});

const consultantAnalysisSchema = z.object({
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
});

/**
 * Per-role lookup for the four variants above. Only used to scope the prompt
 * contract (`companionVerdictContract`) to the role actually being asked —
 * validation always goes through the full union below.
 */
const ROLE_ANALYSIS_SCHEMAS = {
  reviewer: reviewerAnalysisSchema,
  critic: criticAnalysisSchema,
  planner: plannerAnalysisSchema,
  consultant: consultantAnalysisSchema,
} as const;

export const companionRoleAnalysisSchema = z.discriminatedUnion("type", [
  reviewerAnalysisSchema,
  criticAnalysisSchema,
  plannerAnalysisSchema,
  consultantAnalysisSchema,
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
 * NOTE: this is only the *schema* half of the floor, and it does not apply to
 * the `baseline` phase — see the carve-out in the superRefine below. It checks
 * what the Companion claims in verificationReview.recordStatus; the runner
 * separately checks that claim against the record it actually handed to the
 * evaluation (see #handleCompanionVerdict / task.companionEvidence), and that
 * runtime half is the one that actually holds the line.
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
      //
      // `baseline` is exempt. It is the FIRST evaluation and deliberately runs
      // before any Primary verification round exists, so there is never a
      // record for it to be fresh against. Enforcing the floor there made
      // "complete" unreachable for these roles: a clean baseline had to come
      // back as "continue" carrying an invented blocker whose entire content
      // was "now record the evidence" — a consumed round, an adversarial
      // message to Primary, and a finding for something that is not a defect.
      // Worse, it made the good path unreachable: #demandCompletionEvidence
      // keeps the review, invents nothing and consumes no round, but it only
      // triggers on a "complete" the schema was rejecting. The floor itself is
      // not weakened, because the runtime half never trusted this claim anyway
      // — it compares it against the record the runner actually read.
      if (
        COMPLETION_REQUIRES_FRESH_VERIFICATION.has(value.role) &&
        value.phase !== "baseline" &&
        value.verificationReview.recordStatus !== "fresh"
      ) {
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

type CompanionRoleName = (typeof companionRoles)[number];

/**
 * `.int()` lowers to `maximum: Number.MAX_SAFE_INTEGER`, and the `$schema`
 * banner says nothing an agent can act on. Both are pure noise in a prompt
 * that is already competing for attention, so they are dropped.
 */
function stripContractNoise(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(stripContractNoise);
  if (!node || typeof node !== "object") return node;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (key === "$schema") continue;
    if (key === "maximum" && value === Number.MAX_SAFE_INTEGER) continue;
    out[key] = stripContractNoise(value);
  }
  return out;
}

const verdictContractCache = new Map<CompanionRoleName, string>();

/**
 * The verdict's field-level shape as JSON Schema, scoped to ONE role, for
 * injection into the Companion's prompt and into a repair nudge.
 *
 * Why this is generated rather than hand-written: the prompt used to describe
 * the verdict as `{"verificationReview": {...}, "roleAnalysis": {...}, ...}`
 * and nothing else, so every nested field name, enum, and id pattern was a
 * guess. Companions guessed wrong, the runner rejected the file with bare zod
 * messages ("expected array, received undefined") that name the type but not
 * the shape, and at least one went reading the strideterm sources to find
 * `companionVerdictSchema` itself. Deriving the contract from that same schema
 * is the only version that cannot drift away from what the runner enforces.
 *
 * Scoped to one role because the full union is ~17KB and three quarters of it
 * describes roles this evaluation cannot use. `evaluationAttempt` is required
 * here even though the schema keeps it optional (that option exists only so a
 * verdict written before the attempt protocol still parses) — the runner always
 * tells the Companion which attempt it is asking about.
 *
 * Cross-field rules (complete ⇒ no blockers, continue ⇒ at least one, planner ⇒
 * never needs-input, …) live in `superRefine` and have no JSON Schema form.
 * They stay spelled out in the FINAL CONTRACT prose next to this block.
 */
export function companionVerdictContract(role: CompanionRoleName): string {
  const cached = verdictContractCache.get(role);
  if (cached) return cached;
  const scoped = companionVerdictSchema.safeExtend({
    role: z.literal(role),
    roleAnalysis: ROLE_ANALYSIS_SCHEMAS[role],
    evaluationAttempt: z.number().int().min(1),
  });
  const contract = JSON.stringify(stripContractNoise(z.toJSONSchema(scoped, { io: "input" })), null, 1);
  verdictContractCache.set(role, contract);
  return contract;
}

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
