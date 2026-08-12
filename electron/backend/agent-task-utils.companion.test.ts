import { describe, expect, test } from "vitest";
import { companionVerdictContract, companionVerdictSchema } from "./agent-task-utils.js";

// Companion verdict v1 cross-field invariants (plan §4.4). Pure schema tests
// — no disk I/O, no runner — so the contract can be pinned down fast and
// exhaustively regardless of how the runner wires it up.

const reviewerAnalysis = {
  type: "reviewer" as const,
  requirementAudit: [{ requirement: "R1", status: "verified" as const, evidence: ["file.ts:10"] }],
};

function baseVerdict(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    role: "reviewer",
    phase: "baseline",
    round: 1,
    verdict: "complete",
    reason: "All good.",
    // "fresh" is the only recordStatus a reviewer/critic may complete on (the
    // completion floor — see the dedicated describe block below).
    verificationReview: { recordStatus: "fresh", evidenceReviewed: ["npm test"], workerActionsRequired: [] },
    roleAnalysis: reviewerAnalysis,
    blockingFindings: [],
    advisories: [],
    questions: [],
    ...overrides,
  };
}

describe("companionVerdictSchema", () => {
  test("accepts a valid complete verdict with no blockers/questions", () => {
    const result = companionVerdictSchema.safeParse(baseVerdict());
    expect(result.success).toBe(true);
  });

  test("accepts complete with advisories present", () => {
    const result = companionVerdictSchema.safeParse(
      baseVerdict({
        advisories: [{ id: "ADV-1", title: "Style nit", evidence: [], recommendation: "Consider X." }],
      }),
    );
    expect(result.success).toBe(true);
  });

  test("rejects complete with a non-empty blockingFindings", () => {
    const result = companionVerdictSchema.safeParse(
      baseVerdict({
        blockingFindings: [
          { id: "REQ-1", title: "x", category: "requirements", evidence: ["x"], impact: "x", requiredAction: "x" },
        ],
      }),
    );
    expect(result.success).toBe(false);
  });

  test("rejects complete with non-empty questions", () => {
    const result = companionVerdictSchema.safeParse(
      baseVerdict({ verdict: "complete", questions: [{ id: "Q-1", question: "x", whyNeeded: "x" }] }),
    );
    expect(result.success).toBe(false);
  });

  test("rejects complete with non-empty verificationReview.workerActionsRequired", () => {
    const result = companionVerdictSchema.safeParse(
      baseVerdict({
        verificationReview: {
          recordStatus: "missing",
          evidenceReviewed: [],
          workerActionsRequired: [{ commandOrCheck: "npm test", expectedEvidence: "PASS", reason: "required" }],
        },
      }),
    );
    expect(result.success).toBe(false);
  });

  test("rejects continue with zero blockingFindings", () => {
    const result = companionVerdictSchema.safeParse(baseVerdict({ verdict: "continue" }));
    expect(result.success).toBe(false);
  });

  test("accepts continue with at least one blockingFinding", () => {
    const result = companionVerdictSchema.safeParse(
      baseVerdict({
        verdict: "continue",
        blockingFindings: [
          { id: "REQ-1", title: "x", category: "requirements", evidence: ["x"], impact: "x", requiredAction: "x" },
        ],
      }),
    );
    expect(result.success).toBe(true);
  });

  test("rejects continue with non-empty questions", () => {
    const result = companionVerdictSchema.safeParse(
      baseVerdict({
        verdict: "continue",
        blockingFindings: [
          { id: "REQ-1", title: "x", category: "requirements", evidence: ["x"], impact: "x", requiredAction: "x" },
        ],
        questions: [{ id: "Q-1", question: "x", whyNeeded: "x" }],
      }),
    );
    expect(result.success).toBe(false);
  });

  test("rejects needs-input with zero questions", () => {
    const result = companionVerdictSchema.safeParse(baseVerdict({ verdict: "needs-input" }));
    expect(result.success).toBe(false);
  });

  test("accepts needs-input with at least one question", () => {
    const result = companionVerdictSchema.safeParse(
      baseVerdict({ verdict: "needs-input", questions: [{ id: "Q-1", question: "x", whyNeeded: "x" }] }),
    );
    expect(result.success).toBe(true);
  });

  test("rejects roleAnalysis.type mismatched with role", () => {
    const result = companionVerdictSchema.safeParse(
      baseVerdict({
        roleAnalysis: {
          type: "critic",
          steelman: "x",
          hypotheses: [],
        },
      }),
    );
    expect(result.success).toBe(false);
  });

  // Completion floor: the schema used to accept "complete" alongside any
  // recordStatus, so an implementation task could be signed off with no durable
  // verification evidence at all.
  describe("completion floor", () => {
    const criticAnalysis = {
      type: "critic" as const,
      steelman: "The approach is sound because...",
      hypotheses: [],
    };
    const consultantAnalysis = {
      type: "consultant" as const,
      objective: "Ship safely.",
      recommendedNextStep: "Do X.",
      decisions: [],
    };
    const plannerAnalysisForFloor = {
      type: "planner" as const,
      planDocument: "plan.md",
      problemFrame: "x",
      userBenefitAssessment: "x",
      assumptions: [],
      decisions: [],
      coverageAudit: [{ area: "scope" as const, status: "complete" as const, evidence: "x" }],
      openQuestions: [],
    };

    for (const recordStatus of ["missing", "stale", "not-required"] as const) {
      test(`rejects consultant complete on recordStatus "${recordStatus}"`, () => {
        const result = companionVerdictSchema.safeParse(
          baseVerdict({
            role: "consultant",
            roleAnalysis: consultantAnalysis,
            verificationReview: { recordStatus, evidenceReviewed: [], workerActionsRequired: [] },
          }),
        );
        expect(result.success).toBe(false);
      });

      test(`rejects reviewer complete on recordStatus "${recordStatus}"`, () => {
        const result = companionVerdictSchema.safeParse(
          baseVerdict({
            verificationReview: { recordStatus, evidenceReviewed: [], workerActionsRequired: [] },
          }),
        );
        expect(result.success).toBe(false);
        expect(JSON.stringify(result.error?.issues)).toContain("recordStatus");
      });

      test(`rejects critic complete on recordStatus "${recordStatus}"`, () => {
        const result = companionVerdictSchema.safeParse(
          baseVerdict({
            role: "critic",
            roleAnalysis: criticAnalysis,
            verificationReview: { recordStatus, evidenceReviewed: [], workerActionsRequired: [] },
          }),
        );
        expect(result.success).toBe(false);
      });
    }

    test("accepts reviewer complete on fresh evidence", () => {
      const result = companionVerdictSchema.safeParse(baseVerdict());
      expect(result.success).toBe(true);
    });

    // Planner is the only exemption: it completes over a plan document,
    // routinely before anything runnable exists.
    test("planner may complete without a verification record", () => {
      const result = companionVerdictSchema.safeParse(
        baseVerdict({
          role: "planner",
          roleAnalysis: plannerAnalysisForFloor,
          verificationReview: { recordStatus: "not-required", evidenceReviewed: [], workerActionsRequired: [] },
        }),
      );
      expect(result.success).toBe(true);
    });

    // Consultant is NOT exempt: the role alone doesn't say whether it ruled on
    // a decision or on implementation direction. A decision-only round still
    // satisfies the floor — a fresh record whose "Checks not run" section says
    // nothing was applicable.
    test("consultant may NOT complete without a verification record", () => {
      const result = companionVerdictSchema.safeParse(
        baseVerdict({
          role: "consultant",
          roleAnalysis: consultantAnalysis,
          verificationReview: { recordStatus: "not-required", evidenceReviewed: [], workerActionsRequired: [] },
        }),
      );
      expect(result.success).toBe(false);
      expect(JSON.stringify(result.error?.issues)).toContain("recordStatus");
    });

    test("consultant completes on a fresh record that ran no commands", () => {
      const result = companionVerdictSchema.safeParse(
        baseVerdict({
          role: "consultant",
          roleAnalysis: consultantAnalysis,
          verificationReview: {
            recordStatus: "fresh",
            evidenceReviewed: ["VERIFICATION.md: checks not applicable for a decision-only round"],
            workerActionsRequired: [],
          },
        }),
      );
      expect(result.success).toBe(true);
    });

    // The floor gates completion only — demanding the missing evidence is
    // exactly what a non-fresh record should produce instead.
    test("reviewer continue on a missing record stays valid", () => {
      const result = companionVerdictSchema.safeParse(
        baseVerdict({
          verdict: "continue",
          verificationReview: {
            recordStatus: "missing",
            evidenceReviewed: [],
            workerActionsRequired: [{ commandOrCheck: "npm test", expectedEvidence: "PASS", reason: "required" }],
          },
          blockingFindings: [
            { id: "VER-1", title: "x", category: "tests", evidence: ["x"], impact: "x", requiredAction: "x" },
          ],
        }),
      );
      expect(result.success).toBe(true);
    });
  });

  describe("planner-only invariants", () => {
    const plannerAnalysis = {
      type: "planner" as const,
      planDocument: "plan.md",
      problemFrame: "x",
      userBenefitAssessment: "x",
      assumptions: [],
      decisions: [],
      coverageAudit: [{ area: "scope" as const, status: "complete" as const, evidence: "x" }],
      openQuestions: [
        { question: "x", whyUnresolved: "x", assumedDefault: "x", impactIfDifferent: "x", resolveBy: "x" },
      ],
    };

    test("planner can never return needs-input", () => {
      const result = companionVerdictSchema.safeParse(
        baseVerdict({
          role: "planner",
          verdict: "needs-input",
          roleAnalysis: plannerAnalysis,
          questions: [{ id: "Q-1", question: "x", whyNeeded: "x" }],
        }),
      );
      expect(result.success).toBe(false);
    });

    test("planner's control `questions` must stay empty even on continue", () => {
      const result = companionVerdictSchema.safeParse(
        baseVerdict({
          role: "planner",
          verdict: "continue",
          roleAnalysis: plannerAnalysis,
          blockingFindings: [
            { id: "PLAN-1", title: "x", category: "requirements", evidence: ["x"], impact: "x", requiredAction: "x" },
          ],
          questions: [{ id: "Q-1", question: "x", whyNeeded: "x" }],
        }),
      );
      expect(result.success).toBe(false);
    });

    test("planner complete with documented open questions is valid", () => {
      const result = companionVerdictSchema.safeParse(
        baseVerdict({ role: "planner", verdict: "complete", roleAnalysis: plannerAnalysis }),
      );
      expect(result.success).toBe(true);
    });
  });

  describe("critic/consultant roleAnalysis shapes", () => {
    test("accepts a valid critic analysis", () => {
      const result = companionVerdictSchema.safeParse(
        baseVerdict({
          role: "critic",
          roleAnalysis: {
            type: "critic",
            steelman: "The approach is sound because...",
            hypotheses: [
              { hypothesis: "Race condition on X", strength: "speculative", disposition: "advisory", evidence: [] },
            ],
          },
        }),
      );
      expect(result.success).toBe(true);
    });

    test("accepts a valid consultant analysis with at most 3 options per decision", () => {
      const result = companionVerdictSchema.safeParse(
        baseVerdict({
          role: "consultant",
          roleAnalysis: {
            type: "consultant",
            objective: "Ship the feature safely.",
            recommendedNextStep: "Do X.",
            decisions: [
              {
                decision: "Which storage backend?",
                options: [
                  { option: "A", benefits: ["fast"], costsAndRisks: ["complex"], reversibility: "moderate" },
                  { option: "B", benefits: ["simple"], costsAndRisks: ["slow"], reversibility: "easy" },
                ],
                recommendation: "Go with B.",
              },
            ],
          },
        }),
      );
      expect(result.success).toBe(true);
    });

    test("rejects a consultant decision with more than 3 options", () => {
      const result = companionVerdictSchema.safeParse(
        baseVerdict({
          role: "consultant",
          roleAnalysis: {
            type: "consultant",
            objective: "x",
            recommendedNextStep: "x",
            decisions: [
              {
                decision: "x",
                options: [
                  { option: "A", benefits: [], costsAndRisks: [], reversibility: "easy" },
                  { option: "B", benefits: [], costsAndRisks: [], reversibility: "easy" },
                  { option: "C", benefits: [], costsAndRisks: [], reversibility: "easy" },
                  { option: "D", benefits: [], costsAndRisks: [], reversibility: "easy" },
                ],
                recommendation: "x",
              },
            ],
          },
        }),
      );
      expect(result.success).toBe(false);
    });
  });

  describe("id format enforcement", () => {
    test("rejects a finding id that doesn't match LETTERS-NUMBER", () => {
      const result = companionVerdictSchema.safeParse(
        baseVerdict({
          verdict: "continue",
          blockingFindings: [
            { id: "req_1", title: "x", category: "requirements", evidence: ["x"], impact: "x", requiredAction: "x" },
          ],
        }),
      );
      expect(result.success).toBe(false);
    });

    test("rejects a question id that isn't Q-<number>", () => {
      const result = companionVerdictSchema.safeParse(
        baseVerdict({ verdict: "needs-input", questions: [{ id: "QUESTION-1", question: "x", whyNeeded: "x" }] }),
      );
      expect(result.success).toBe(false);
    });
  });

  test("rejects an unknown top-level verdict value", () => {
    const result = companionVerdictSchema.safeParse(baseVerdict({ verdict: "maybe" }));
    expect(result.success).toBe(false);
  });
});

// The prompt contract. Every field asserted here is one a Companion previously
// had to invent: the prompt described the verdict as `{"verificationReview":
// {...}, "roleAnalysis": {...}, ...}` and nothing more, so verdicts came back
// with `workerActionsRequired` as bare strings, no `requirementAudit` at all,
// and ids like "A1"/"Q1". The runner rejected them with zod messages that name
// the type but not the shape, and a Companion went reading strideterm's own
// sources to find this schema. Generating the contract from the schema is what
// keeps the two from drifting again — these tests keep it wired up.
describe("companionVerdictContract", () => {
  test("names every nested field the schema requires but the old prompt left to guesswork", () => {
    const contract = companionVerdictContract("reviewer");
    for (const field of [
      "verificationReview",
      "recordStatus",
      "evidenceReviewed",
      "workerActionsRequired",
      "commandOrCheck",
      "expectedEvidence",
      "roleAnalysis",
      "requirementAudit",
      "blockingFindings",
      "requiredAction",
      "advisories",
      "recommendation",
      "questions",
      "whyNeeded",
    ]) {
      expect(contract).toContain(`"${field}"`);
    }
    // The id patterns are the other half of what was guessed.
    expect(contract).toContain("^[A-Z]+-[0-9]+$");
    expect(contract).toContain("^Q-[0-9]+$");
  });

  test("is scoped to the asked role so three quarters of the union stay out of the prompt", () => {
    const reviewer = companionVerdictContract("reviewer");
    expect(reviewer).toContain("requirementAudit");
    // Planner/critic/consultant-only fields must not ride along.
    for (const foreign of ["planDocument", "coverageAudit", "steelman", "recommendedNextStep"]) {
      expect(reviewer).not.toContain(foreign);
    }
    expect(companionVerdictContract("planner")).toContain("planDocument");
    expect(companionVerdictContract("critic")).toContain("steelman");
    expect(companionVerdictContract("consultant")).toContain("recommendedNextStep");
  });

  test("requires the identity fields, including the attempt the schema keeps optional", () => {
    const contract = JSON.parse(companionVerdictContract("reviewer"));
    for (const field of ["schemaVersion", "role", "phase", "round", "evaluationAttempt", "verdict", "reason"]) {
      expect(contract.required).toContain(field);
    }
    expect(contract.properties.role.const).toBe("reviewer");
    expect(contract.properties.roleAnalysis.properties.type.const).toBe("reviewer");
  });

  test("carries the planner coverage areas verbatim, so the role policy cannot promise one the enum lacks", () => {
    const contract = JSON.parse(companionVerdictContract("planner"));
    const areas: string[] = contract.properties.roleAnalysis.properties.coverageAudit.items.properties.area.enum;
    expect(areas).toContain("testing");
    expect(areas).toContain("mobile-remote");
    // The policy used to list "acceptance criteria" as its own dimension; there
    // has never been a slot for it, so a planner obeying the prose failed the
    // enum. It is folded into `testing` in the policy text instead.
    expect(areas).not.toContain("acceptance-criteria");
  });

  test("drops the noise that carries no instruction (int upper bound, $schema banner)", () => {
    const contract = companionVerdictContract("reviewer");
    expect(contract).not.toContain(String(Number.MAX_SAFE_INTEGER));
    expect(contract).not.toContain("$schema");
  });
});
