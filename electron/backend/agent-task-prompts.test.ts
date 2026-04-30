import { describe, expect, test } from "vitest";
import { buildRecoveryPrompt } from "./agent-task-prompts.js";

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
