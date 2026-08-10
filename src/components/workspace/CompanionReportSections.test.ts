import { describe, expect, test } from "vitest";
import { mount } from "@vue/test-utils";
import CompanionReportSections from "./CompanionReportSections.vue";

describe("CompanionReportSections", () => {
  test("renders required findings and advisories as visually distinct sections", () => {
    const wrapper = mount(CompanionReportSections, {
      props: {
        role: "reviewer",
        verdict: {
          blockingFindings: [
            {
              id: "REQ-1",
              title: "Missing tests",
              category: "tests",
              evidence: ["grep found nothing"],
              impact: "risk",
              requiredAction: "add tests",
            },
          ],
          advisories: [
            { id: "ADV-1", title: "Style nit", evidence: [], recommendation: "Consider X.", tradeoff: "slower" },
          ],
          questions: [],
          roleAnalysis: {
            type: "reviewer",
            requirementAudit: [{ requirement: "R1", status: "verified", evidence: ["file.ts:1"] }],
          },
        },
      },
    });
    expect(wrapper.text()).toContain("Required findings");
    expect(wrapper.text()).toContain("REQ-1");
    expect(wrapper.text()).toContain("Advisories (1)");
    expect(wrapper.text()).toContain("optional, not required");
    // Advisories render inside a <details> so they read as collapsible/optional,
    // never as a pending required item.
    expect(wrapper.find(".crs__advisories").element.tagName).toBe("DETAILS");
  });

  test("flags a finding repeated across 3+ rounds with a 'Pause and review' hint, without hiding the finding itself", () => {
    const wrapper = mount(CompanionReportSections, {
      props: {
        role: "reviewer",
        repeatedFindingIds: ["REQ-1"],
        verdict: {
          blockingFindings: [
            {
              id: "REQ-1",
              title: "Missing tests",
              category: "tests",
              evidence: ["still nothing"],
              impact: "risk",
              requiredAction: "add tests",
            },
            {
              id: "REQ-2",
              title: "Missing docs",
              category: "requirements",
              evidence: ["no docs"],
              impact: "risk",
              requiredAction: "add docs",
            },
          ],
          advisories: [],
          questions: [],
          roleAnalysis: { type: "reviewer", requirementAudit: [] },
        },
      },
    });
    expect(wrapper.text()).toContain("Pause and review");
    // Only the repeated ID gets the hint — REQ-2 is a normal finding.
    const hints = wrapper.findAll(".crs__repeat-hint");
    expect(hints).toHaveLength(1);
  });

  test("reviewer role summary shows the requirement checklist", () => {
    const wrapper = mount(CompanionReportSections, {
      props: {
        role: "reviewer",
        verdict: {
          blockingFindings: [],
          advisories: [],
          questions: [],
          roleAnalysis: {
            type: "reviewer",
            requirementAudit: [{ requirement: "Feature X implemented", status: "verified", evidence: ["a.ts:1"] }],
          },
        },
      },
    });
    expect(wrapper.text()).toContain("Requirement checklist");
    expect(wrapper.text()).toContain("VERIFIED");
    expect(wrapper.text()).toContain("Feature X implemented");
  });

  test("critic role summary shows steelman and hypothesis strength/disposition", () => {
    const wrapper = mount(CompanionReportSections, {
      props: {
        role: "critic",
        verdict: {
          blockingFindings: [],
          advisories: [],
          questions: [],
          roleAnalysis: {
            type: "critic",
            steelman: "The approach is sound because it isolates state.",
            hypotheses: [
              {
                hypothesis: "Race on concurrent writes",
                strength: "speculative",
                disposition: "advisory",
                evidence: [],
              },
            ],
          },
        },
      },
    });
    expect(wrapper.text()).toContain("Steelman");
    expect(wrapper.text()).toContain("isolates state");
    expect(wrapper.text()).toContain("SPECULATIVE/advisory");
  });

  test("consultant role summary shows the recommended next step and at most 3 options per decision", () => {
    const wrapper = mount(CompanionReportSections, {
      props: {
        role: "consultant",
        verdict: {
          blockingFindings: [],
          advisories: [],
          questions: [],
          roleAnalysis: {
            type: "consultant",
            objective: "Ship safely",
            recommendedNextStep: "Adopt option B.",
            decisions: [
              {
                decision: "Storage backend",
                options: [
                  { option: "A", benefits: ["fast"], costsAndRisks: ["complex"], reversibility: "moderate" },
                  { option: "B", benefits: ["simple"], costsAndRisks: [], reversibility: "easy" },
                ],
                recommendation: "Go with B.",
              },
            ],
          },
        },
      },
    });
    expect(wrapper.text()).toContain("Adopt option B.");
    expect(wrapper.text()).toContain("Storage backend");
    expect(wrapper.text()).toContain("Go with B.");
  });

  test("planner role summary shows coverage, decisions, assumptions, and open questions as documentation only", () => {
    const wrapper = mount(CompanionReportSections, {
      props: {
        role: "planner",
        verdict: {
          blockingFindings: [],
          advisories: [],
          questions: [],
          roleAnalysis: {
            type: "planner",
            planDocument: "plan.md",
            problemFrame: "x",
            userBenefitAssessment: "x",
            assumptions: [
              { assumption: "Users are online", rationale: "SaaS product", riskIfWrong: "offline mode breaks" },
            ],
            decisions: [
              {
                decision: "Storage",
                chosenDefault: "SQLite",
                rationale: "simple",
                userBenefit: "fast MVP",
                alternativesConsidered: [],
              },
            ],
            coverageAudit: [{ area: "scope", status: "complete", evidence: "covered in section 2" }],
            openQuestions: [
              {
                question: "Which region?",
                whyUnresolved: "no data",
                assumedDefault: "us-east",
                impactIfDifferent: "latency",
                resolveBy: "before deploy",
              },
            ],
          },
        },
      },
    });
    expect(wrapper.text()).toContain("Plan coverage");
    expect(wrapper.text()).toContain("SQLite");
    expect(wrapper.text()).toContain("Users are online");
    expect(wrapper.text()).toContain("documentation only");
    expect(wrapper.text()).toContain("Which region?");
    // Never rendered as an awaiting-user "Send decision" card.
    expect(wrapper.text()).not.toContain("Send decision");
  });

  test("renders nothing extra when the verdict is null", () => {
    const wrapper = mount(CompanionReportSections, { props: { role: "reviewer", verdict: null } });
    expect(wrapper.find(".crs__section").exists()).toBe(false);
  });
});
