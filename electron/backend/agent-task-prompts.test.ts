import { describe, expect, test } from "vitest";
import {
  buildInitialWorkerPrompt,
  buildJudgeFeedbackPrompt,
  buildRePrompt,
  buildRecoveryPrompt,
  buildUserFeedbackPrompt,
  buildCompanionUserFeedbackPrompt,
} from "./agent-task-prompts.js";

describe("buildRecoveryPrompt", () => {
  test("worker variant references the worker handoff hint", () => {
    const out = buildRecoveryPrompt({ role: "worker", round: 3, taskId: "task-abc" });

    // Role + round are surfaced so the agent knows where it is in the loop
    expect(out).toContain("WORKER");
    expect(out).toContain("round 3");

    // Task directory is referenced so the agent can re-read its artifacts
    expect(out).toContain("task-abc");

    // Worker-specific note: handoff may already be done
    expect(out).toMatch(/HANDOFF\.md|hand off to the judge/);

    // Pure-prompt invariant: must NOT instruct the agent to use any provider's
    // context-restore feature. If a future edit accidentally adds "--continue"
    // or "--resume", this test catches it.
    expect(out).not.toContain("--continue");
    expect(out).not.toContain("--resume");
  });

  test("judge variant references writing the verdict file", () => {
    const out = buildRecoveryPrompt({ role: "judge", round: 1, taskId: "task-xyz" });

    expect(out).toContain("JUDGE");
    expect(out).toContain("round 1");
    expect(out).toContain("task-xyz");

    // Judge-specific note: continue evaluation, write verdict
    expect(out).toMatch(/verdict\.json/);
  });

  test("includes git-safety guard so the agent does not rewrite existing commits", () => {
    const out = buildRecoveryPrompt({ role: "worker", round: 2, taskId: "task-abc" });
    // Restart-recovery is the one moment when the agent is most tempted to
    // "redo from scratch". The prompt must explicitly forbid touching commits
    // that already exist on the branch.
    expect(out.toLowerCase()).toMatch(/revert|rebase|force-push|rewrite/);
    expect(out.toLowerCase()).toContain("git");
  });

  test("includes side-effect guard for external operations", () => {
    const out = buildRecoveryPrompt({ role: "worker", round: 2, taskId: "task-abc" });
    // PRs created, releases tagged, external API calls — the agent must check
    // before redoing those.
    expect(out.toLowerCase()).toMatch(/side effect|destructive|external/);
  });
});

// Tasks created before the TASK.md/WORKER.md split keep their rules embedded
// in TASK.md and have no WORKER.md on disk; new tasks split the operational
// content into WORKER.md. The prompts must point each role at the right file
// for both formats — losing the verification reference would leave the worker
// or judge running blind on legacy tasks.
describe("prompt builders — format-aware references", () => {
  const baseTask = {
    taskId: "task-fmt-001",
    description: "Refactor auth.",
    currentRound: 1,
    maxRounds: 5,
  };

  const round = {
    checks: [{ label: "Tests", passed: false }],
  };

  test("legacy task (no useWorkerFile) references TASK.md for verification", () => {
    const prompt = buildInitialWorkerPrompt(baseTask);
    expect(prompt).toContain("Re-read `.strideterm/tasks/task-fmt-001/TASK.md`");
    // The format-aware switch routes the verification step at the right
    // ops file. Wording around it is generic by design — what we pin is
    // the path, not the prose, so future copy edits don't break this test.
    expect(prompt).toMatch(/"Verification before completion"[^`]*`\.strideterm\/tasks\/task-fmt-001\/TASK\.md`/s);
    expect(prompt).not.toContain("WORKER.md");
  });

  test("split task (useWorkerFile=true) references WORKER.md for verification + re-read", () => {
    const prompt = buildInitialWorkerPrompt({ ...baseTask, useWorkerFile: true });
    expect(prompt).toContain(".strideterm/tasks/task-fmt-001/TASK.md`");
    expect(prompt).toContain(".strideterm/tasks/task-fmt-001/WORKER.md`");
    expect(prompt).toMatch(/"Verification before completion"[^`]*`\.strideterm\/tasks\/task-fmt-001\/WORKER\.md`/s);
  });

  test("buildRePrompt switches verification source by format", () => {
    const legacy = buildRePrompt(baseTask, round);
    expect(legacy).toContain(".strideterm/tasks/task-fmt-001/TASK.md");
    expect(legacy).not.toContain("WORKER.md");

    const split = buildRePrompt({ ...baseTask, useWorkerFile: true }, round);
    expect(split).toContain(".strideterm/tasks/task-fmt-001/WORKER.md");
  });

  test("feedback prompts switch verification source by format", () => {
    const legacy = buildJudgeFeedbackPrompt(baseTask, { reason: "missing X" });
    expect(legacy).toContain(".strideterm/tasks/task-fmt-001/TASK.md");

    const split = buildJudgeFeedbackPrompt({ ...baseTask, useWorkerFile: true }, { reason: "missing X" });
    expect(split).toContain(".strideterm/tasks/task-fmt-001/WORKER.md");

    const userLegacy = buildUserFeedbackPrompt(baseTask, "still incomplete");
    expect(userLegacy).toContain(".strideterm/tasks/task-fmt-001/TASK.md");

    const userSplit = buildUserFeedbackPrompt({ ...baseTask, useWorkerFile: true }, "still incomplete");
    expect(userSplit).toContain(".strideterm/tasks/task-fmt-001/WORKER.md");
  });
});

// Judge round-4 finding (item 69): the Dashboard's "Send back" control on an
// attached task injected the standard buildUserFeedbackPrompt, which never
// mentions VERIFICATION.md/CONTEXT.md and talks in Worker/judge terms that
// don't apply to a companion loop's externally-owned Primary.
describe("buildCompanionUserFeedbackPrompt", () => {
  const companionTask = {
    taskId: "task-companion-001",
    mode: "attached",
    companionRole: "critic" as const,
    currentRound: 3,
    maxRounds: 5,
  };

  test("speaks in Primary/companion terms and points at CONTEXT.md + VERIFICATION.md", () => {
    const prompt = buildCompanionUserFeedbackPrompt(companionTask, "The retry logic still isn't idempotent.");

    expect(prompt).toContain("The retry logic still isn't idempotent.");
    expect(prompt).toContain("Critic companion");
    expect(prompt).toContain(".strideterm/tasks/task-companion-001/CONTEXT.md");
    expect(prompt).toContain(".strideterm/tasks/task-companion-001/VERIFICATION.md");
    expect(prompt).toContain(".strideterm/tasks/task-companion-001/WORK_LOCK");
    expect(prompt).toContain("Round 3/5");

    // Never the standard-mode vocabulary — this is the externally-owned
    // Primary, not a disposable Worker, and there is no "judge" role here.
    expect(prompt).not.toContain("Worker");
    expect(prompt).not.toContain("the judge");

    // Must never instruct the Primary to reset its own session (plan §8.6).
    expect(prompt).not.toContain("resend");
    expect(prompt.toLowerCase()).toMatch(/do not restart yourself|never restart yourself/);
  });

  test("falls back to a generic placeholder when no feedback text is given", () => {
    const prompt = buildCompanionUserFeedbackPrompt(companionTask, "");
    expect(prompt).toContain("(no specific feedback provided)");
  });

  test("defaults to Reviewer when companionRole is missing", () => {
    const prompt = buildCompanionUserFeedbackPrompt({ ...companionTask, companionRole: undefined }, "feedback");
    expect(prompt).toContain("Reviewer companion");
  });
});
