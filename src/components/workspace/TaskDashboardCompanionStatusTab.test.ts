import { describe, expect, test, vi } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import TaskDashboardCompanionStatusTab from "./TaskDashboardCompanionStatusTab.vue";
import { apiKey } from "../../types/keys.js";

function mountTab(taskState: Record<string, unknown>, apiOverrides: Record<string, unknown> = {}) {
  return mount(TaskDashboardCompanionStatusTab, {
    props: { taskState, workspaceCwd: "/repo", taskId: "task-1" },
    global: {
      provide: {
        [apiKey as unknown as string]: {
          fileRead: vi.fn().mockResolvedValue({ content: "" }),
          ...apiOverrides,
        },
      },
    },
  });
}

describe("TaskDashboardCompanionStatusTab", () => {
  test("capturing-context shows an Open Primary CTA", () => {
    const wrapper = mountTab({ state: "capturing-context", companionRole: "reviewer" });
    expect(wrapper.text()).toContain("Capturing context");
    expect(wrapper.text()).toContain("Open Primary");
  });

  test("capturing-context hides Open Primary when the source workspace isn't in the payload", () => {
    const wrapper = mount(TaskDashboardCompanionStatusTab, {
      props: {
        taskState: { state: "capturing-context", companionRole: "reviewer" },
        sourceWorkspaceAvailable: false,
      },
      global: { provide: { [apiKey as unknown as string]: { fileRead: vi.fn() } } },
    });
    expect(wrapper.text()).not.toContain("Open Primary");
    expect(wrapper.text()).toContain("no longer available in this profile");
  });

  test("brief-ready loads and previews TASK.md/CONTEXT.md/HANDOFF.md and offers the role-specific Start CTA", async () => {
    const fileRead = vi.fn((args: { relativePath: string }) => {
      if (args.relativePath.endsWith("CONTEXT.md")) return Promise.resolve({ content: "# Objective\nDo X.\n" });
      if (args.relativePath.endsWith("HANDOFF.md"))
        return Promise.resolve({ content: "# Current state\nIn progress.\n" });
      return Promise.resolve({ content: "No additional focus specified." });
    });
    const wrapper = mountTab({ state: "brief-ready", companionRole: "planner" }, { fileRead });
    await flushPromises();
    expect(wrapper.text()).toContain("Start Planner loop");
    expect(wrapper.text()).toContain("Do X.");
    expect(wrapper.text()).toContain("In progress.");
  });

  test("brief-ready warns (without blocking) when CONTEXT.md still lists open questions", async () => {
    const fileRead = vi.fn((args: { relativePath: string }) => {
      if (args.relativePath.endsWith("CONTEXT.md")) {
        return Promise.resolve({ content: "# Open questions or ambiguities\nWhich database?\n" });
      }
      return Promise.resolve({ content: "" });
    });
    const wrapper = mountTab({ state: "brief-ready", companionRole: "reviewer" }, { fileRead });
    await flushPromises();
    expect(wrapper.text()).toContain("still lists open questions");
    const startBtn = wrapper.findAll("button").find((b) => b.text().includes("Start Reviewer loop"));
    expect(startBtn?.attributes("disabled")).toBeUndefined();
  });

  test("a withheld sign-off explains itself and reports the runner's own verification reading, not the claim", () => {
    const wrapper = mountTab({
      state: "running",
      companionRole: "reviewer",
      // The Companion claimed "fresh"; the runner had no record to give it.
      companionEvidence: { status: "not-provided", mtimeIso: null, round: null },
      lastCompanionVerdict: {
        verdict: "complete",
        verificationReview: { recordStatus: "fresh", evidenceReviewed: [], workerActionsRequired: [] },
        blockingFindings: [],
        advisories: [],
      },
      rounds: [{ round: 1, action: "verification-required" }],
    });
    expect(wrapper.text()).toContain("found no blockers");
    expect(wrapper.text()).toContain("this round was not consumed");
    expect(wrapper.text()).toContain("Verification: Not provided");
    expect(wrapper.text()).not.toContain("Verification: Fresh");
  });

  test("awaiting-user renders question cards and emits answer with the question ids on Send decision", async () => {
    const wrapper = mountTab({
      state: "awaiting-user",
      companionRole: "consultant",
      pendingQuestions: [{ id: "Q-1", question: "Which option?", whyNeeded: "Two valid designs." }],
    });
    expect(wrapper.text()).toContain("Which option?");
    await wrapper.find("textarea").setValue("Go with option B.");
    await wrapper.find(".tdc__send-decision").trigger("click");
    expect(wrapper.emitted("answer")?.[0][0]).toEqual({ questionIds: ["Q-1"], answer: "Go with option B." });
  });

  test("Send decision is disabled until the user types something", () => {
    const wrapper = mountTab({
      state: "awaiting-user",
      companionRole: "reviewer",
      pendingQuestions: [{ id: "Q-1", question: "x", whyNeeded: "x" }],
    });
    const btn = wrapper.find(".tdc__send-decision");
    expect((btn.element as HTMLButtonElement).disabled).toBe(true);
  });

  test("completed with advisories shows 'Completed with advice', not a bare 'Completed'", () => {
    const wrapper = mountTab({
      state: "completed",
      companionRole: "reviewer",
      lastCompanionVerdict: {
        reason: "All good.",
        advisories: [{ id: "ADV-1", title: "x", evidence: [], recommendation: "x" }],
        blockingFindings: [],
        questions: [],
        roleAnalysis: { type: "reviewer", requirementAudit: [] },
      },
    });
    expect(wrapper.text()).toContain("Completed with advice");
  });

  test("failed shows the max-rounds framing and the last blocking findings", () => {
    const wrapper = mountTab({
      state: "failed",
      companionRole: "reviewer",
      lastCompanionVerdict: {
        reason: "Missing tests.",
        blockingFindings: [
          { id: "REQ-1", title: "No tests", category: "tests", evidence: ["x"], impact: "x", requiredAction: "x" },
        ],
        advisories: [],
        questions: [],
        roleAnalysis: { type: "reviewer", requirementAudit: [] },
      },
    });
    expect(wrapper.text()).toContain("Failed — max rounds reached");
    expect(wrapper.text()).toContain("REQ-1");
  });

  test("paused hints at the correct next action based on pausedFromState", () => {
    const wrapper = mountTab({ state: "paused", pausedFromState: "capturing-context", companionRole: "reviewer" });
    expect(wrapper.text()).toContain("Open Primary to check");
  });

  test("primaryMissing replaces the paused hero with a terminal 'Primary no longer exists' hero", () => {
    const wrapper = mountTab({
      state: "paused",
      pausedFromState: "judge-evaluating",
      primaryMissing: true,
      companionRole: "reviewer",
    });
    expect(wrapper.text()).toContain("Primary no longer exists");
    expect(wrapper.text()).toContain("Delete task");
    expect(wrapper.text()).not.toContain("Continue to resume reading the verdict");
  });

  // Every state the backend can flag primaryMissing in has to say so — it used
  // to be shown only from "paused", so idle/brief-ready/awaiting-user kept
  // offering Start and Send decision, both of which the runner refuses.
  test.each(["idle", "brief-ready", "awaiting-user", "completed", "failed"])(
    "primaryMissing in %s offers Delete task and no action that injects into the Primary",
    (state) => {
      const wrapper = mountTab({
        state,
        primaryMissing: true,
        companionRole: "reviewer",
        pendingQuestions: [{ id: "Q-1", question: "Which option?", whyNeeded: "Two valid designs." }],
      });
      expect(wrapper.text()).toContain("Primary no longer exists");
      expect(wrapper.text()).toContain("Delete task");
      expect(wrapper.text()).not.toContain("Start Reviewer loop");
      expect(wrapper.text()).not.toContain("Send decision");
      expect(wrapper.text()).not.toContain("Send back with feedback");
      expect(wrapper.text()).not.toContain("Reset &");
    },
  );

  test("primaryMissing keeps the last verdict readable and emits delete-task", async () => {
    const wrapper = mountTab({
      state: "completed",
      primaryMissing: true,
      companionRole: "reviewer",
      lastCompanionVerdict: {
        reason: "All good.",
        blockingFindings: [
          { id: "REQ-1", title: "No tests", category: "tests", evidence: ["x"], impact: "x", requiredAction: "x" },
        ],
        advisories: [],
        questions: [],
        roleAnalysis: { type: "reviewer", requirementAudit: [] },
      },
    });
    expect(wrapper.text()).toContain("All good.");
    expect(wrapper.text()).toContain("REQ-1");
    const deleteBtn = wrapper.findAll("button").find((b) => b.text() === "Delete task");
    await deleteBtn?.trigger("click");
    expect(wrapper.emitted("delete-task")).toHaveLength(1);
  });

  test("paused with judgePolicyViolation shows a distinct policy-violation banner, not the generic pause hint", () => {
    const wrapper = mountTab({
      state: "paused",
      pausedFromState: "judge-evaluating",
      judgePolicyViolation: true,
      companionRole: "critic",
    });
    expect(wrapper.text()).toContain("Paused: policy violation");
    expect(wrapper.text()).toContain("Critic hit a permission prompt");
    expect(wrapper.text()).not.toContain("Continue to resume reading the verdict");
  });

  test("running shows the Primary -> Verification -> Role pipeline", () => {
    const wrapper = mountTab({ state: "running", companionRole: "critic" });
    const labels = wrapper.findAll(".tdc__pipeline-label").map((l) => l.text());
    expect(labels).toEqual(["Primary", "Verification", "Critic"]);
  });
});
