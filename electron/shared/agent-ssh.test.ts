import { describe, expect, test } from "vitest";
import { getAgentSshMcpEligibility, parseAgentCommand } from "./agent-ssh.js";

describe("agent SSH MCP eligibility", () => {
  test.each([
    "claude",
    "claude --dangerously-skip-permissions --model sonnet",
    '"C:\\Program Files\\Claude\\claude.exe" --model opus',
  ])("accepts direct Claude launch %s", (command) => {
    expect(getAgentSshMcpEligibility(command)).toMatchObject({ supported: true, provider: "claude", reason: null });
  });

  test("accepts direct Codex paths and preserves argument values", () => {
    expect(parseAgentCommand('C:\\tools\\codex.cmd -s danger-full-access -c model="gpt-5.5"')).toEqual({
      provider: "codex",
      executable: "C:\\tools\\codex.cmd",
      args: ["-s", "danger-full-access", "-c", "model=gpt-5.5"],
    });
  });

  test("preserves empty quoted arguments and supports literal single-quoted shell characters", () => {
    expect(parseAgentCommand("claude --append-system-prompt '' --model '$HOME'")?.args).toEqual([
      "--append-system-prompt",
      "",
      "--model",
      "$HOME",
    ]);
  });

  test.each([
    "",
    "pwsh -Command claude",
    "cmd.exe /c codex",
    "wsl claude",
    "claude && echo done",
    "claude | cat",
    "claude; codex",
    "claude --model $MODEL",
    'claude --model "$MODEL"',
    'claude --model "$(whoami)"',
    'claude --model "unmatched',
    "claude mcp list",
    "codex mcp add",
    "gemini",
    "claude\n--model sonnet",
  ])("rejects unsupported/wrapped command %s", (command) => {
    expect(getAgentSshMcpEligibility(command)).toMatchObject({
      supported: false,
      provider: null,
      reason: expect.stringContaining("directly launches"),
    });
  });
});
