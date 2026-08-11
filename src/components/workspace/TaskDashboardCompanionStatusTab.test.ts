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

  test("capturing-context drops the Open Primary CTA once the Primary is a pane on screen", () => {
    const wrapper = mount(TaskDashboardCompanionStatusTab, {
      props: {
        taskState: { state: "capturing-context", companionRole: "reviewer" },
        primaryVisible: true,
      },
      global: { provide: { [apiKey as unknown as string]: { fileRead: vi.fn() } } },
    });
    // Still explains what's happening — only the redundant call to action goes.
    expect(wrapper.text()).toContain("Capturing context");
    expect(wrapper.text()).not.toContain("Open Primary");
    expect(wrapper.text()).not.toContain("no longer available in this profile");
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

  test("the paused hint stops saying 'open' when the Primary is already on screen", () => {
    const wrapper = mount(TaskDashboardCompanionStatusTab, {
      props: {
        taskState: { state: "paused", pausedFromState: "capturing-context", companionRole: "reviewer" },
        primaryVisible: true,
      },
      global: { provide: { [apiKey as unknown as string]: { fileRead: vi.fn() } } },
    });
    expect(wrapper.text()).toContain("Check what the Primary wrote");
    expect(wrapper.text()).not.toContain("Open Primary to check");
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

  test("paused on a permission prompt names that as the reason, not the generic pause hint", () => {
    const wrapper = mountTab({
      state: "paused",
      pausedFromState: "judge-evaluating",
      judgePolicyViolation: true,
      companionRole: "critic",
    });
    expect(wrapper.text()).toContain("Paused: permission prompt");
    expect(wrapper.text()).toContain("Critic is waiting on a permission prompt");
    expect(wrapper.text()).toContain("Answer the prompt in the Critic's panel");
    expect(wrapper.text()).not.toContain("Continue to resume reading the verdict");
  });

  test("running shows the Capture -> Primary -> Verification -> Role pipeline", () => {
    const wrapper = mountTab({ state: "running", companionRole: "critic" });
    const labels = wrapper.findAll(".tdc__pipeline-label").map((l) => l.text());
    expect(labels).toEqual(["Capture", "Primary", "Verification", "Critic"]);
  });

  // The pipeline is the loop's position at a glance, so it has to be there in
  // states that aren't mid-round too — the position is exactly what a user
  // coming back to a paused or not-yet-started loop is missing.
  test.each([
    ["idle", ["waiting", "waiting", "waiting", "waiting"]],
    ["capturing-context", ["active", "waiting", "waiting", "waiting"]],
    ["brief-ready", ["done", "waiting", "waiting", "waiting"]],
    ["running", ["done", "active", "waiting", "waiting"]],
    ["evaluating", ["done", "done", "active", "waiting"]],
    ["judge-evaluating", ["done", "done", "done", "active"]],
    ["awaiting-user", ["done", "done", "done", "active"]],
    ["completed", ["done", "done", "done", "done"]],
    ["failed", ["done", "done", "done", "done"]],
  ])("%s places the pipeline correctly", (state, expected) => {
    const wrapper = mountTab({ state, companionRole: "reviewer", pendingQuestions: [] });
    const statuses = wrapper.findAll(".tdc__pipeline-step").map((step) => {
      const cls = step.classes().find((c) => c.startsWith("tdc__pipeline-step--")) || "";
      return cls.replace("tdc__pipeline-step--", "");
    });
    expect(statuses).toEqual(expected);
  });

  // "Paused" says nothing about where the loop will resume — the phase it was
  // paused in does, and that's what the user needs before pressing Continue.
  test("a paused loop keeps the pipeline position it was paused in", () => {
    const wrapper = mountTab({ state: "paused", pausedFromState: "judge-evaluating", companionRole: "reviewer" });
    const active = wrapper.find(".tdc__pipeline-step--active .tdc__pipeline-label");
    expect(active.text()).toBe("Reviewer");
  });

  test.each([
    ["capturing-context", "Waiting on Primary"],
    ["running", "Waiting on Primary"],
    ["judge-evaluating", "Waiting on Reviewer"],
    ["awaiting-user", "Waiting on you"],
    ["brief-ready", "Waiting on you"],
    ["idle", "Waiting on you"],
    ["paused", "Nothing running"],
    ["completed", "Finished"],
  ])("%s names who the loop is waiting on", (state, expected) => {
    const wrapper = mountTab({ state, companionRole: "reviewer" });
    expect(wrapper.find(".tdc__now-actor").text()).toBe(expected);
  });

  // Every state has to answer "why is it sitting here" — that's the half a
  // state badge can never carry.
  test.each(["idle", "capturing-context", "brief-ready", "running", "judge-evaluating", "paused", "completed"])(
    "%s explains why the loop is where it is and what comes next",
    (state) => {
      const wrapper = mountTab({ state, companionRole: "reviewer" });
      const keys = wrapper.findAll(".tdc__now-key").map((k) => k.text());
      expect(keys).toEqual(["Why", "Next"]);
      expect(wrapper.find(".tdc__now-what").text().length).toBeGreaterThan(10);
    },
  );

  // A round sent back is the one case where "why" is not generic: the reason it
  // came back is the single most useful line on the screen.
  test("running quotes the verdict that sent the round back", () => {
    const wrapper = mountTab({
      state: "running",
      companionRole: "reviewer",
      currentRound: 2,
      maxRounds: 10,
      rounds: [{ round: 1, judgeReason: "Tests do not cover the retry path." }],
    });
    expect(wrapper.find(".tdc__now-what").text()).toContain("Round 2/10");
    expect(wrapper.text()).toContain("Reviewer sent it back: Tests do not cover the retry path.");
  });

  // primaryMissing is the one state with no loop left to explain — its terminal
  // hero replaces the panel rather than sitting above it.
  test("primaryMissing shows no now-panel", () => {
    const wrapper = mountTab({ state: "paused", primaryMissing: true, companionRole: "reviewer" });
    expect(wrapper.find(".tdc__now").exists()).toBe(false);
    expect(wrapper.find(".tdc__pipeline").exists()).toBe(false);
  });
});
