import { describe, expect, test } from "vitest";
import { agentCommandWithModel, startJiraDevelopmentSchema } from "../../shared/jira-development.js";

const base = {
  jiraIssueRef: { connectionId: "c", issueId: "1", issueKey: "ENG-1" },
  target: {
    provider: "github",
    connectionId: "g",
    owner: "o",
    repo: "r",
    remoteUrl: "",
    baseBranch: "main",
    newBranchName: "feature/ENG-1",
  },
  idempotencyKey: "k",
};

describe("agentCommandWithModel", () => {
  test("keeps the template command when nothing is chosen", () => {
    expect(agentCommandWithModel("codex --yolo", "codex", {})).toBe("codex --yolo");
  });

  test("appends the model and the provider's effort flag", () => {
    expect(
      agentCommandWithModel("claude --dangerously-skip-permissions", "claude", { model: "opus", effort: "high" }),
    ).toBe("claude --dangerously-skip-permissions --model opus --effort high");
    expect(agentCommandWithModel("codex --yolo", "codex", { model: "gpt-6.1-sol", effort: "xhigh" })).toBe(
      "codex --yolo --model gpt-6.1-sol -c model_reasoning_effort=xhigh",
    );
  });

  test("replaces flags the template already sets instead of repeating them", () => {
    expect(
      agentCommandWithModel("codex -m old -c model_reasoning_effort=low --yolo", "codex", {
        model: "new",
        effort: "high",
      }),
    ).toBe("codex --yolo --model new -c model_reasoning_effort=high");
    expect(agentCommandWithModel("claude --model=sonnet --effort low", "claude", { model: "opus" })).toBe(
      "claude --effort low --model opus",
    );
  });

  test("keeps quoted template arguments quoted", () => {
    expect(agentCommandWithModel('claude --append-system-prompt "be brief"', "claude", { model: "opus" })).toBe(
      'claude --append-system-prompt "be brief" --model opus',
    );
  });
});

describe("startJiraDevelopmentSchema model and effort", () => {
  test("accepts an effort the agent lists", () => {
    expect(
      startJiraDevelopmentSchema.safeParse({ ...base, agent: "codex", model: "gpt-6.1-sol", effort: "xhigh" }).success,
    ).toBe(true);
  });

  test("refuses an effort the agent does not take, and a model without an agent", () => {
    expect(startJiraDevelopmentSchema.safeParse({ ...base, agent: "opencode", effort: "high" }).success).toBe(false);
    expect(startJiraDevelopmentSchema.safeParse({ ...base, agent: "claude", effort: "minimal" }).success).toBe(false);
    expect(startJiraDevelopmentSchema.safeParse({ ...base, agent: null, model: "opus" }).success).toBe(false);
  });

  test("refuses a model id that could carry shell syntax", () => {
    expect(startJiraDevelopmentSchema.safeParse({ ...base, agent: "claude", model: "opus; rm -rf /" }).success).toBe(
      false,
    );
  });
});
