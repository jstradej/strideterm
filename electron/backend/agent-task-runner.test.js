import { describe, expect, test, vi, beforeEach } from "vitest";
import { AgentTaskRunner, parseFinishCriteriaMd, checkCommandSafety } from "./agent-task-runner.js";

function createMockDeps(workspaces = []) {
  const written = [];
  const alerts = [];
  let broadcastCount = 0;

  return {
    writeToSession: vi.fn((sessionId, data) => written.push({ sessionId, data })),
    getState: () => ({ workspaces, activeProfileId: "default" }),
    broadcastState: vi.fn(() => broadcastCount++),
    raiseAlert: vi.fn((alert) => alerts.push(alert)),
    restartSession: vi.fn(async () => {}),
    written,
    alerts,
    get broadcastCount() {
      return broadcastCount;
    },
  };
}

function createTaskWorkspace(runner, overrides = {}) {
  const ws = runner.createTaskWorkspace({
    state: { activeProfileId: "default" },
    description: overrides.description || "Implement feature X",
    cwd: overrides.cwd || "/tmp/test-project",
    parentWorkspaceId: "",
    maxRounds: overrides.maxRounds || 3,
  });
  return ws;
}

describe("AgentTaskRunner", () => {
  let runner;
  let deps;
  let workspace;

  beforeEach(() => {
    runner = new AgentTaskRunner();
    workspace = createTaskWorkspace(runner);
    deps = createMockDeps([workspace]);
    runner.init(deps);
  });

  describe("createTaskWorkspace", () => {
    test("creates workspace with correct structure", () => {
      expect(workspace.kind).toBe("task");
      expect(workspace.panels).toHaveLength(3);
      expect(workspace.panels[0].title).toBe("Dashboard");
      expect(workspace.panels[0].command).toBe("__task-dashboard__");
      expect(workspace.panels[1].title).toBe("Worker");
      expect(workspace.panels[1].command).toBe("claude --dangerously-skip-permissions --model sonnet");
      expect(workspace.panels[2].title).toBe("Judge");
      expect(workspace.task).toBeDefined();
      expect(workspace.task.state).toBe("idle");
      expect(workspace.task.maxRounds).toBe(3);
      expect(workspace.task.workerPanelId).toBe(workspace.panels[1].id);
      expect(workspace.task.judgePanelId).toBe(workspace.panels[2].id);
    });

    test("truncates long descriptions in workspace name", () => {
      const ws = createTaskWorkspace(runner, {
        description: "A very long task description that exceeds the fifty character limit for names",
      });
      expect(ws.name.length).toBeLessThanOrEqual(50);
      expect(ws.name).toContain("...");
    });

    test("initializes worktree fields as empty strings", () => {
      expect(workspace.task.worktreeBase).toBe("");
      expect(workspace.task.worktreeBranch).toBe("");
    });

    test("uses custom name when provided", () => {
      const ws = runner.createTaskWorkspace({
        state: { activeProfileId: "default" },
        description: "Some task",
        cwd: "/tmp/test",
        parentWorkspaceId: "",
        maxRounds: 5,
        name: "My Custom Name",
      });
      expect(ws.name).toBe("My Custom Name");
    });

    test("falls back to description-based name when name is empty", () => {
      const ws = runner.createTaskWorkspace({
        state: { activeProfileId: "default" },
        description: "Build pagination",
        cwd: "/tmp/test",
        parentWorkspaceId: "",
        name: "",
      });
      expect(ws.name).toBe("Build pagination");
    });

    test("uses custom icon when provided", () => {
      const ws = runner.createTaskWorkspace({
        state: { activeProfileId: "default" },
        description: "Test",
        cwd: "/tmp/test",
        parentWorkspaceId: "",
        icon: "\u{1F680}",
      });
      expect(ws.icon).toBe("\u{1F680}");
    });

    test("uses default icon when not provided", () => {
      expect(workspace.icon).toBe("\u{1F916}");
    });

    test("uses custom color when provided", () => {
      const ws = runner.createTaskWorkspace({
        state: { activeProfileId: "default" },
        description: "Test",
        cwd: "/tmp/test",
        parentWorkspaceId: "",
        color: "#FF0000",
      });
      expect(ws.color).toBe("#FF0000");
    });

    test("uses custom notes when provided", () => {
      const ws = runner.createTaskWorkspace({
        state: { activeProfileId: "default" },
        description: "Test",
        cwd: "/tmp/test",
        parentWorkspaceId: "",
        notes: "Important context",
      });
      expect(ws.notes).toBe("Important context");
    });

    test("uses custom worker command when provided", () => {
      const ws = runner.createTaskWorkspace({
        state: { activeProfileId: "default" },
        description: "Test",
        cwd: "/tmp/test",
        parentWorkspaceId: "",
        workerCommand: "claude --model haiku",
      });
      expect(ws.panels[1].command).toBe("claude --model haiku");
    });

    test("uses custom judge command when provided", () => {
      const ws = runner.createTaskWorkspace({
        state: { activeProfileId: "default" },
        description: "Test",
        cwd: "/tmp/test",
        parentWorkspaceId: "",
        judgeCommand: "claude --model opus --verbose",
      });
      expect(ws.panels[2].command).toBe("claude --model opus --verbose");
    });

    test("uses default commands when custom commands are not provided", () => {
      expect(workspace.panels[1].command).toBe("claude --dangerously-skip-permissions --model sonnet");
      expect(workspace.panels[2].command).toContain("claude");
    });
  });

  describe("task lifecycle", () => {
    test("stopTask sets state to paused", () => {
      workspace.task.state = "running";
      const result = runner.stopTask(workspace.id);
      expect(result).toBe(true);
      expect(workspace.task.state).toBe("paused");
    });

    test("stopTask returns false for non-task workspace", () => {
      const result = runner.stopTask("nonexistent");
      expect(result).toBe(false);
    });

    test("pauseTask pauses a running task", () => {
      workspace.task.state = "running";
      const result = runner.pauseTask(workspace.id);
      expect(result).toBe(true);
      expect(workspace.task.state).toBe("paused");
    });

    test("pauseTask pauses during judge-evaluating", () => {
      workspace.task.state = "judge-evaluating";
      const result = runner.pauseTask(workspace.id);
      expect(result).toBe(true);
      expect(workspace.task.state).toBe("paused");
    });

    test("pauseTask pauses during refreshing", () => {
      workspace.task.state = "refreshing";
      const result = runner.pauseTask(workspace.id);
      expect(result).toBe(true);
      expect(workspace.task.state).toBe("paused");
    });

    test("pauseTask returns false if not running", () => {
      workspace.task.state = "idle";
      const result = runner.pauseTask(workspace.id);
      expect(result).toBe(false);
    });

    test("resumeTask resumes a paused task", () => {
      workspace.task.state = "paused";
      const result = runner.resumeTask(workspace.id);
      expect(result).toBe(true);
      expect(workspace.task.state).toBe("running");
    });

    test("resumeTask resumes to judge-evaluating when pausedFromState is judge-evaluating", () => {
      workspace.task.state = "paused";
      workspace.task.pausedFromState = "judge-evaluating";
      const result = runner.resumeTask(workspace.id);
      expect(result).toBe(true);
      expect(workspace.task.state).toBe("judge-evaluating");
      expect(workspace.task.pausedFromState).toBe("");
    });

    test("resumeTask resumes to running when pausedFromState is evaluating", () => {
      workspace.task.state = "paused";
      workspace.task.pausedFromState = "evaluating";
      const result = runner.resumeTask(workspace.id);
      expect(result).toBe(true);
      expect(workspace.task.state).toBe("running");
      expect(workspace.task.pausedFromState).toBe("");
    });

    test("resumeTask returns false if not paused", () => {
      workspace.task.state = "running";
      const result = runner.resumeTask(workspace.id);
      expect(result).toBe(false);
    });
  });

  describe("onAgentIdle", () => {
    test("returns false for non-task session", () => {
      const result = runner.onAgentIdle("someWorkspace:somePanel");
      expect(result).toBe(false);
    });

    test("returns false if task is not running", () => {
      workspace.task.state = "idle";
      const sessionId = `${workspace.id}:${workspace.task.workerPanelId}`;
      const result = runner.onAgentIdle(sessionId);
      expect(result).toBe(false);
    });

    test("returns true for worker session in running state", () => {
      workspace.task.state = "running";
      const sessionId = `${workspace.id}:${workspace.task.workerPanelId}`;
      const result = runner.onAgentIdle(sessionId);
      expect(result).toBe(true);
    });

    test("returns true for judge session in judge-evaluating state", () => {
      workspace.task.state = "judge-evaluating";
      const sessionId = `${workspace.id}:${workspace.task.judgePanelId}`;
      const result = runner.onAgentIdle(sessionId);
      expect(result).toBe(true);
    });

    test("returns false for judge session when not judge-evaluating", () => {
      workspace.task.state = "running";
      const sessionId = `${workspace.id}:${workspace.task.judgePanelId}`;
      const result = runner.onAgentIdle(sessionId);
      expect(result).toBe(false);
    });
  });

  describe("onSessionExit", () => {
    test("pauses task when worker session exits and clears pausedFromState", () => {
      workspace.task.state = "running";
      workspace.task.pausedFromState = "evaluating"; // stale value from before
      const sessionId = `${workspace.id}:${workspace.task.workerPanelId}`;
      runner.onSessionExit(sessionId);
      expect(workspace.task.state).toBe("paused");
      expect(workspace.task.pausedFromState).toBe("");
    });

    test("does not pause for judge session exit", () => {
      workspace.task.state = "running";
      const sessionId = `${workspace.id}:${workspace.task.judgePanelId}`;
      runner.onSessionExit(sessionId);
      expect(workspace.task.state).toBe("running");
    });

    test("does not pause if task is not running", () => {
      workspace.task.state = "idle";
      const sessionId = `${workspace.id}:${workspace.task.workerPanelId}`;
      runner.onSessionExit(sessionId);
      expect(workspace.task.state).toBe("idle");
    });
  });

  describe("onUserInput", () => {
    test("pauses task during evaluation when input targets worker panel", () => {
      workspace.task.state = "evaluating";
      const sessionId = `${workspace.id}:${workspace.task.workerPanelId}`;
      runner.onUserInput(sessionId);
      expect(workspace.task.state).toBe("paused");
      expect(workspace.task.pausedFromState).toBe("evaluating");
    });

    test("pauses task during judge evaluation when input targets judge panel", () => {
      workspace.task.state = "judge-evaluating";
      const sessionId = `${workspace.id}:${workspace.task.judgePanelId}`;
      runner.onUserInput(sessionId);
      expect(workspace.task.state).toBe("paused");
      expect(workspace.task.pausedFromState).toBe("judge-evaluating");
    });

    test("does not pause during running (worker is working)", () => {
      workspace.task.state = "running";
      const sessionId = `${workspace.id}:${workspace.task.workerPanelId}`;
      runner.onUserInput(sessionId);
      expect(workspace.task.state).toBe("running");
    });

    test("does not pause when input targets worker panel during judge-evaluating", () => {
      workspace.task.state = "judge-evaluating";
      const sessionId = `${workspace.id}:${workspace.task.workerPanelId}`;
      runner.onUserInput(sessionId);
      expect(workspace.task.state).toBe("judge-evaluating");
    });

    test("does not pause when input targets judge panel during evaluating", () => {
      workspace.task.state = "evaluating";
      const sessionId = `${workspace.id}:${workspace.task.judgePanelId}`;
      runner.onUserInput(sessionId);
      expect(workspace.task.state).toBe("evaluating");
    });
  });

  describe("getTaskSnapshot", () => {
    test("returns empty object when no task workspaces", () => {
      const runner2 = new AgentTaskRunner();
      runner2.init(createMockDeps([]));
      expect(runner2.getTaskSnapshot()).toEqual({});
    });

    test("returns task state for task workspaces", () => {
      workspace.task.state = "running";
      workspace.task.currentRound = 2;
      const snapshot = runner.getTaskSnapshot();
      expect(snapshot[workspace.id]).toBeDefined();
      expect(snapshot[workspace.id].state).toBe("running");
      expect(snapshot[workspace.id].currentRound).toBe(2);
      expect(snapshot[workspace.id].workerPanelId).toBe(workspace.task.workerPanelId);
      expect(snapshot[workspace.id].judgePanelId).toBe(workspace.task.judgePanelId);
    });
  });

  describe("getTaskState", () => {
    test("returns task state for valid workspace", () => {
      const state = runner.getTaskState(workspace.id);
      expect(state).toBeDefined();
      expect(state.description).toBe("Implement feature X");
    });

    test("returns null for non-task workspace", () => {
      const state = runner.getTaskState("nonexistent");
      expect(state).toBeNull();
    });
  });
});

describe("parseFinishCriteriaMd", () => {
  test("parses verify commands with label and command", () => {
    const result = parseFinishCriteriaMd(`# Finish Criteria

## Verify Commands
- Tests: \`npm test\`
- Lint: \`npm run lint\`
`);
    expect(result.verifyCommands).toHaveLength(2);
    expect(result.verifyCommands[0]).toEqual({ label: "Tests", command: "npm test", timeoutMs: 60_000 });
    expect(result.verifyCommands[1]).toEqual({ label: "Lint", command: "npm run lint", timeoutMs: 60_000 });
  });

  test("parses timeout from command line", () => {
    const result = parseFinishCriteriaMd(`## Verify Commands
- Build: \`npm run build\` (timeout: 120s)
`);
    expect(result.verifyCommands[0].timeoutMs).toBe(120_000);
  });

  test("parses required and forbidden files", () => {
    const result = parseFinishCriteriaMd(`## Required Files
- src/hello.js
- src/hello.test.js

## Forbidden Files
- tmp/debug.log
`);
    expect(result.requiredPaths).toEqual(["src/hello.js", "src/hello.test.js"]);
    expect(result.forbiddenPaths).toEqual(["tmp/debug.log"]);
  });

  test("returns empty for missing file", () => {
    const result = parseFinishCriteriaMd("");
    expect(result.verifyCommands).toEqual([]);
    expect(result.requiredPaths).toEqual([]);
    expect(result.forbiddenPaths).toEqual([]);
  });

  test("ignores HTML comments", () => {
    const result = parseFinishCriteriaMd(`## Verify Commands
<!-- - Tests: \`npm test\` -->
- Lint: \`npm run lint\`
`);
    expect(result.verifyCommands).toHaveLength(1);
    expect(result.verifyCommands[0].label).toBe("Lint");
  });

  test("handles bare backtick commands without label", () => {
    const result = parseFinishCriteriaMd(`## Verify Commands
- \`cargo test\`
`);
    expect(result.verifyCommands[0]).toEqual({ label: "cargo test", command: "cargo test", timeoutMs: 60_000 });
  });
});

describe("createTaskWorkspace - worktree fields", () => {
  test("worktree fields can be set after creation (as runtime does)", () => {
    const runner = new AgentTaskRunner();
    const ws = runner.createTaskWorkspace({
      state: { activeProfileId: "default" },
      description: "Test task",
      cwd: "/tmp/worktree-path",
      parentWorkspaceId: "",
      maxRounds: 5,
    });
    // Runtime sets these after createTaskWorkspace returns
    ws.task.worktreeBase = "/tmp/base-repo";
    ws.task.worktreeBranch = "task/test-branch";

    expect(ws.task.worktreeBase).toBe("/tmp/base-repo");
    expect(ws.task.worktreeBranch).toBe("task/test-branch");
    expect(ws.cwd).toBe("/tmp/worktree-path");
  });

  test("worktree fields default to empty strings", () => {
    const runner = new AgentTaskRunner();
    const ws = runner.createTaskWorkspace({
      state: { activeProfileId: "default" },
      description: "Regular task",
      cwd: "/tmp/project",
      parentWorkspaceId: "",
      maxRounds: 10,
    });
    expect(ws.task.worktreeBase).toBe("");
    expect(ws.task.worktreeBranch).toBe("");
  });
});

describe("createTaskWorkspace - shower mode defaults", () => {
  test("includes showerInterval and lastShowerRound", () => {
    const runner = new AgentTaskRunner();
    const ws = runner.createTaskWorkspace({
      state: { activeProfileId: "default" },
      description: "Test task",
      cwd: "/tmp/test",
      parentWorkspaceId: "",
      maxRounds: 10,
    });
    expect(ws.task.showerInterval).toBe(5);
    expect(ws.task.lastShowerRound).toBe(0);
    expect(ws.task.lastJudgeInstructions).toBe("");
  });
});

describe("startTask - prompt sent tracking", () => {
  test("sets promptSent to true when description is provided", async () => {
    const runner = new AgentTaskRunner();
    const ws = runner.createTaskWorkspace({
      state: { activeProfileId: "default" },
      description: "Test task",
      cwd: "/tmp/test",
      parentWorkspaceId: "",
      maxRounds: 3,
    });
    const deps = createMockDeps([ws]);
    runner.init(deps);

    await runner.startTask(ws.id);
    expect(ws.task.promptSent).toBe(true);
    expect(ws.task.state).toBe("running");
  });

  test("sets promptSent to false when no description", async () => {
    const runner = new AgentTaskRunner();
    const ws = runner.createTaskWorkspace({
      state: { activeProfileId: "default" },
      description: "",
      cwd: "/tmp/test",
      parentWorkspaceId: "",
      maxRounds: 3,
    });
    const deps = createMockDeps([ws]);
    runner.init(deps);

    await runner.startTask(ws.id);
    expect(ws.task.promptSent).toBe(false);
  });
});

describe("checkCommandSafety", () => {
  test("returns empty for safe commands", () => {
    expect(checkCommandSafety("npm test")).toEqual([]);
    expect(checkCommandSafety("npm run lint")).toEqual([]);
    expect(checkCommandSafety("cargo test")).toEqual([]);
    expect(checkCommandSafety("pytest -q")).toEqual([]);
    expect(checkCommandSafety("go vet ./...")).toEqual([]);
  });

  test("flags rm -rf", () => {
    const warnings = checkCommandSafety("rm -rf /tmp/test");
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings[0]).toContain("recursive");
  });

  test("flags git push", () => {
    const warnings = checkCommandSafety("git push origin main");
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings[0]).toContain("git push");
  });

  test("flags git reset --hard", () => {
    const warnings = checkCommandSafety("git reset --hard HEAD~1");
    expect(warnings.length).toBeGreaterThan(0);
  });

  test("flags command substitution", () => {
    const warnings = checkCommandSafety("echo $(whoami)");
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings[0]).toContain("injection");
  });

  test("flags backtick substitution", () => {
    const warnings = checkCommandSafety("echo `id`");
    expect(warnings.length).toBeGreaterThan(0);
  });
});

describe("resetTask", () => {
  test("resets a failed task to idle", async () => {
    const runner = new AgentTaskRunner();
    const ws = createTaskWorkspace(runner);
    const deps = createMockDeps([ws]);
    runner.init(deps);

    ws.task.state = "failed";
    ws.task.currentRound = 5;
    ws.task.rounds = [{ round: 1 }, { round: 2 }];
    ws.task.pausedFromState = "evaluating";

    const result = await runner.resetTask(ws.id);
    expect(result).toBe(true);
    expect(ws.task.state).toBe("idle");
    expect(ws.task.currentRound).toBe(0);
    expect(ws.task.rounds).toEqual([]);
    expect(ws.task.promptSent).toBe(false);
    expect(ws.task.pausedFromState).toBe("");
  });

  test("returns false for running task", async () => {
    const runner = new AgentTaskRunner();
    const ws = createTaskWorkspace(runner);
    const deps = createMockDeps([ws]);
    runner.init(deps);

    ws.task.state = "running";
    const result = await runner.resetTask(ws.id);
    expect(result).toBe(false);
  });
});
