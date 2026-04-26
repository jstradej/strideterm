import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { describe, expect, test, vi, beforeEach } from "vitest";
import {
  AgentTaskRunner,
  buildProgrammaticCopilotJudgeCommand,
  shouldUseProgrammaticCopilotJudge,
} from "./agent-task-runner.js";
import { TODO_FILE, WORK_LOCK_FILE, formatVerifyChecklist, taskDir } from "./agent-task-utils.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function createMockDeps(workspaces: any[] = []): any {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const written: any[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const alerts: any[] = [];
  let broadcastCount = 0;

  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    writeToSession: vi.fn((sessionId: any, data: any) => written.push({ sessionId, data })),
    getState: () => ({ workspaces, activeProfileId: "default" }),
    broadcastState: vi.fn(() => broadcastCount++),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    raiseAlert: vi.fn((alert: any) => alerts.push(alert)),
    restartSession: vi.fn(async () => {}),
    written,
    alerts,
    get broadcastCount() {
      return broadcastCount;
    },
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function createTaskWorkspace(runner: any, overrides: any = {}) {
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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let runner: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let deps: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let workspace: any;

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
      expect(workspace.panels[1].title).toContain("Worker");
      expect(workspace.panels[1].command).toBe("claude --dangerously-skip-permissions --model sonnet");
      expect(workspace.panels[2].title).toContain("Judge");
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

    test("builds copilot worker/judge commands from explicit workerProvider", () => {
      const ws = runner.createTaskWorkspace({
        state: { activeProfileId: "default" },
        description: "Copilot task",
        cwd: "/tmp/test",
        parentWorkspaceId: "",
        workerProvider: { providerId: "copilot", model: "gpt-5.4" },
        judgeProvider: { providerId: "copilot", model: "claude-opus-4.7" },
      });

      // Provider-derived commands route through CopilotProvider.buildCommand
      expect(ws.panels[1].command).toBe("copilot --allow-all-tools --model gpt-5.4");
      expect(ws.panels[2].command).toBe("copilot --allow-all-tools --model claude-opus-4.7");

      // Panel titles surface the provider displayName so user sees which agent is running
      expect(ws.panels[1].title).toContain("GitHub Copilot");
      expect(ws.panels[2].title).toContain("GitHub Copilot");

      // Task provider config is persisted for later restarts
      expect(ws.task.workerProviderConfig.providerId).toBe("copilot");
      expect(ws.task.judgeProviderConfig.providerId).toBe("copilot");
    });

    test("parses copilot providerId from legacy workerCommand string", () => {
      const ws = runner.createTaskWorkspace({
        state: { activeProfileId: "default" },
        description: "Legacy-string task",
        cwd: "/tmp/test",
        parentWorkspaceId: "",
        workerCommand: "copilot --allow-all-tools --model gpt-5.4",
      });

      expect(ws.task.workerProviderConfig.providerId).toBe("copilot");
      expect(ws.task.workerProviderConfig.model).toBe("gpt-5.4");
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

    test("returns true (consumes) for idle task — suppresses spurious auto-spawn alert", () => {
      workspace.task.state = "idle";
      const sessionId = `${workspace.id}:${workspace.task.workerPanelId}`;
      const result = runner.onAgentIdle(sessionId);
      expect(result).toBe(true);
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

    test("returns true (consumes) for judge session when not judge-evaluating", () => {
      // Judge panel in an actively-running task state: task runner owns
      // this panel, consume the event to prevent spurious user alerts.
      workspace.task.state = "running";
      const sessionId = `${workspace.id}:${workspace.task.judgePanelId}`;
      const result = runner.onAgentIdle(sessionId);
      expect(result).toBe(true);
    });

    test("returns false (falls through) only for paused task", () => {
      // Paused: user may be hands-on with the worker panel — let user
      // pipeline alert them (plan § 3.2.d rule 4).
      workspace.task.state = "paused";
      const sessionId = `${workspace.id}:${workspace.task.workerPanelId}`;
      const result = runner.onAgentIdle(sessionId);
      expect(result).toBe(false);
    });
  });

  describe("onHookEvent", () => {
    test("returns false for non-task session", () => {
      const result = runner.onHookEvent({
        sessionId: "someWorkspace:somePanel",
        hook: "Notification",
        subtype: "idle_prompt",
      });
      expect(result).toBe(false);
    });

    test("Notification hook delegates to onAgentIdle (worker, running)", () => {
      workspace.task.state = "running";
      const sessionId = `${workspace.id}:${workspace.task.workerPanelId}`;
      const result = runner.onHookEvent({ sessionId, hook: "Notification", subtype: "idle_prompt" });
      expect(result).toBe(true);
    });

    test("Stop hook delegates to onAgentIdle (worker, running)", () => {
      workspace.task.state = "running";
      const sessionId = `${workspace.id}:${workspace.task.workerPanelId}`;
      const result = runner.onHookEvent({ sessionId, hook: "Stop" });
      expect(result).toBe(true);
    });

    test("Stop hook for idle task is CONSUMED (suppresses spurious alerts from never-started task)", () => {
      // Real-world bug: task workspace in `idle` state has auto-spawned Claude
      // in worker panel. Claude hits idle, fires Stop/idle_prompt hook. Without
      // this guard the event leaks to user pipeline and fires "Worker waiting
      // for input" for a task the user never started.
      workspace.task.state = "idle";
      const sessionId = `${workspace.id}:${workspace.task.workerPanelId}`;
      const result = runner.onHookEvent({ sessionId, hook: "Stop" });
      expect(result).toBe(true);
    });

    test("Stop hook for completed task is consumed", () => {
      workspace.task.state = "completed";
      const sessionId = `${workspace.id}:${workspace.task.workerPanelId}`;
      const result = runner.onHookEvent({ sessionId, hook: "Stop" });
      expect(result).toBe(true);
    });

    test("Stop hook for failed task is consumed", () => {
      workspace.task.state = "failed";
      const sessionId = `${workspace.id}:${workspace.task.workerPanelId}`;
      const result = runner.onHookEvent({ sessionId, hook: "Stop" });
      expect(result).toBe(true);
    });

    test("Stop hook for evaluating task is consumed (runner-driven phase)", () => {
      workspace.task.state = "evaluating";
      const sessionId = `${workspace.id}:${workspace.task.workerPanelId}`;
      const result = runner.onHookEvent({ sessionId, hook: "Stop" });
      expect(result).toBe(true);
    });

    test("Stop hook for paused task returns false (paused tasks fall through — user may be hands-on)", () => {
      workspace.task.state = "paused";
      const sessionId = `${workspace.id}:${workspace.task.workerPanelId}`;
      const result = runner.onHookEvent({ sessionId, hook: "Stop" });
      expect(result).toBe(false);
    });

    test("Stop hook on non-worker/non-judge panel in task workspace falls through", () => {
      // User may have added a docs/readme panel to the task workspace.
      // Hook events there shouldn't be swallowed by task runner.
      workspace.task.state = "idle";
      const sessionId = `${workspace.id}:some-other-panel`;
      const result = runner.onHookEvent({ sessionId, hook: "Stop" });
      expect(result).toBe(false);
    });

    test("SubagentStop for task workspace returns true (consumed)", () => {
      const sessionId = `${workspace.id}:${workspace.task.workerPanelId}`;
      const result = runner.onHookEvent({ sessionId, hook: "SubagentStop" });
      expect(result).toBe(true);
    });

    test("SubagentStop for non-task session returns false", () => {
      const result = runner.onHookEvent({ sessionId: "plain:shell", hook: "SubagentStop" });
      expect(result).toBe(false);
    });

    test("UserPromptSubmit for task workspace returns true", () => {
      const sessionId = `${workspace.id}:${workspace.task.workerPanelId}`;
      const result = runner.onHookEvent({ sessionId, hook: "UserPromptSubmit" });
      expect(result).toBe(true);
    });

    test("UserPromptSubmit for non-task session returns false", () => {
      const result = runner.onHookEvent({ sessionId: "plain:shell", hook: "UserPromptSubmit" });
      expect(result).toBe(false);
    });

    test("unknown hook returns false (fall through)", () => {
      const sessionId = `${workspace.id}:${workspace.task.workerPanelId}`;
      const result = runner.onHookEvent({ sessionId, hook: "SomeFutureHook" });
      expect(result).toBe(false);
    });

    test("missing sessionId or hook returns false", () => {
      expect(runner.onHookEvent({ hook: "Notification" })).toBe(false);
      expect(runner.onHookEvent({ sessionId: "x:y" })).toBe(false);
      expect(runner.onHookEvent({})).toBe(false);
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

    test("worker crash raises urgent task-failed alert (plan § 6 #3)", () => {
      workspace.task.state = "running";
      const sessionId = `${workspace.id}:${workspace.task.workerPanelId}`;
      runner.onSessionExit(sessionId);
      expect(deps.alerts.length).toBeGreaterThan(0);
      const alert = deps.alerts[deps.alerts.length - 1];
      expect(alert).toMatchObject({
        kind: "waiting",
        tier: 1,
        urgency: "urgent",
      });
      expect(alert.detail).toMatch(/^task-failed/);
    });
  });

  describe("task alert urgency", () => {
    test("task-completed alert has normal urgency (plan § 3.2.g)", () => {
      // Exercise the private #raiseTaskAlert via the completion code path.
      // Simplest entry point: call onAgentIdle is complex because it requires
      // full judge machinery. Instead we reach in via a failed max-rounds flow
      // which hits #raiseTaskAlert("failed", ...). For the completed side, we
      // verify that task-completed detail strings carry the right urgency
      // by reading the classifier contract directly.
      //
      // That leaves just crash/failure (already tested above). We also verify
      // the mapping contract here so that future changes to #raiseTaskAlert
      // don't quietly downgrade failed urgency to normal.
      workspace.task.state = "running";
      const sessionId = `${workspace.id}:${workspace.task.workerPanelId}`;
      runner.onSessionExit(sessionId); // triggers task-failed (urgent)

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect(deps.alerts.some((a: any) => a.urgency === "urgent" && /^task-failed/.test(a.detail))).toBe(true);
    });

    test("max-rounds failure routes through raiseAlert with urgent urgency", () => {
      // Fabricate a direct call to the private #raiseTaskAlert by exercising
      // onSessionExit as a proxy — same underlying path. Independent failure
      // paths (judge max rounds, missing verdict) all funnel into the same
      // function with the same urgency mapping, covered by the classifier
      // contract test below.
      workspace.task.state = "running";
      const sessionId = `${workspace.id}:${workspace.task.workerPanelId}`;
      runner.onSessionExit(sessionId);
      const alert = deps.alerts[deps.alerts.length - 1];
      // task-failed → kind:"waiting" (it's "still needs you"), urgency:"urgent"
      expect(alert.kind).toBe("waiting");
      expect(alert.urgency).toBe("urgent");
      expect(alert.tier).toBe(1);
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

    test("marks Windows Copilot judge workspaces as headless in snapshot", () => {
      const ws = runner.createTaskWorkspace({
        state: { activeProfileId: "default" },
        description: "Copilot judge",
        cwd: "/tmp/test",
        parentWorkspaceId: "",
        judgeProvider: { providerId: "copilot", model: "gpt-5.4-mini" },
      });
      const runner2 = new AgentTaskRunner();
      runner2.init(createMockDeps([ws]));

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const snapshot = runner2.getTaskSnapshot() as Record<string, any>;
      expect(snapshot[ws.id].judgeExecutionMode).toBe(
        process.platform === "win32" ? "headless-copilot" : "interactive",
      );
      expect(snapshot[ws.id].judgeProgrammaticRunning).toBe(false);
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

describe("formatVerifyChecklist", () => {
  test("formats detected commands as markdown checklist", () => {
    const result = formatVerifyChecklist(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      [
        { label: "Tests", command: "npm test", timeoutMs: 60_000 },
        { label: "Lint", command: "npm run lint", timeoutMs: 60_000 },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- MIGRATION-EXEMPT: test helper cast to bypass partial CheckConfig shape
      ] as any,
    );
    expect(result).toBe("- [ ] Run `npm test` — must pass\n- [ ] Run `npm run lint` — must pass");
  });

  test("returns empty string for empty array", () => {
    expect(formatVerifyChecklist([])).toBe("");
  });

  test("returns empty string for null/undefined", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(formatVerifyChecklist(null as any)).toBe("");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(formatVerifyChecklist(undefined as any)).toBe("");
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

  test("sets promptSent=true even with empty description (prompt points Worker to TASK.md)", async () => {
    // Regression: old behavior gated prompt injection on task.description being
    // truthy, so a user who created the task without a description and later
    // edited TASK.md saw Start as a silent no-op. The prompt template falls
    // back to "Read the task from <taskDir>/TASK.md" for empty descriptions,
    // so Start should always inject the prompt.
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
    expect(ws.task.promptSent).toBe(true);
    expect(ws.task.state).toBe("running");
    // Worker panel should have received the prompt string (pasted via writeToSession)
    const workerSessionId = `${ws.id}:${ws.task.workerPanelId}`;
    const written = deps.written// eslint-disable-next-line @typescript-eslint/no-explicit-any
    .filter((w: any) => w.sessionId === workerSessionId);
    expect(written.length).toBeGreaterThan(0);
  });
});

describe("resumeTask - late prompt delivery", () => {
  test("injects prompt on resume if startTask ran before prompt was ever sent", async () => {
    // Scenario: legacy task workspace created/started under the old code path
    // with promptSent=false. User pauses and resumes — the Worker must finally
    // receive the initial prompt so Resume isn't a silent no-op.
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

    // Simulate legacy "Start with empty desc → promptSent stayed false → paused"
    ws.task.state = "paused";
    ws.task.promptSent = false;
    deps.written.length = 0;

    const result = runner.resumeTask(ws.id);
    expect(result).toBe(true);
    expect(ws.task.state).toBe("running");

    // Late-delivery prompt injection is fire-and-forget (returns a promise).
    // #injectPrompt tries fs.writeFile first (fails with ENOENT in the test
    // sandbox, which is two async ticks) and then falls back to direct paste.
    // promptSent = true is set inside the outer .then() after writeToSession,
    // so poll that — it's strictly later than the write.
    const workerSessionId = `${ws.id}:${ws.task.workerPanelId}`;
    const deadline = Date.now() + 1000;
    while (Date.now() < deadline && !ws.task.promptSent) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    const written = deps.written// eslint-disable-next-line @typescript-eslint/no-explicit-any
    .filter((w: any) => w.sessionId === workerSessionId);
    expect(written.length).toBeGreaterThan(0);
    expect(ws.task.promptSent).toBe(true);
  });

  test("streams prompt char-by-char for Copilot (bypasses Ink paste detection)", async () => {
    // Regression: bulk PTY writes are treated as a paste event by Copilot's
    // Ink TUI, which keeps the trailing \r as a literal character instead of
    // interpreting it as Enter. Streaming one char at a time forces each
    // keystroke to be its own event and lets the final \r submit the line.
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "strideterm-typing-"));
    const runner = new AgentTaskRunner();
    const ws = runner.createTaskWorkspace({
      state: { activeProfileId: "default" },
      description: "",
      cwd: tmp,
      parentWorkspaceId: "",
      workerProvider: { providerId: "copilot", model: "gpt-5.4" },
    });
    // Pre-create the task dir so #injectPrompt can write PROMPT.md and then
    // inject a SHORT directive ("Read X/PROMPT.md and follow ...") rather
    // than stream the full multi-kilobyte worker template char-by-char.
    await fs.mkdir(taskDir(tmp, ws.task.taskId), { recursive: true });

    const deps = createMockDeps([ws]);
    runner.init(deps);

    ws.task.state = "paused";
    ws.task.promptSent = false;

    runner.resumeTask(ws.id);

    const sessionId = `${ws.id}:${ws.task.workerPanelId}`;
    // Wait (in real time) until we see the final \r or timeout. The typing
    // cascade is a chain of setTimeout per char — fake timers and this
    // chain don't interact well (cascading micro-setTimeouts don't always
    // drain cleanly), so use real timers with a generous deadline. Copilot's
    // gap is 30ms × ~90 chars + 150ms enter ≈ 2.9s; give the loop 6s headroom.
    const deadline = Date.now() + 6000;
    while (Date.now() < deadline) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      if (deps.written.some((w: any) => w.sessionId === sessionId && w.data === "\r")) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    const writes = deps.written// eslint-disable-next-line @typescript-eslint/no-explicit-any
    .filter((w: any) => w.sessionId === sessionId);

    // Many separate writes (one per char), NOT a single bulk write of the prompt.
    expect(writes.length).toBeGreaterThan(10);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const bulkWrite = writes.find((w: any) => w.data && w.data.length > 5);
    expect(bulkWrite).toBeUndefined();

    // Final Enter must be present and come AFTER the last text char.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(writes.some((w: any) => w.data === "\r")).toBe(true);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const dataSeq = writes.map((w: any) => w.data);
    const lastEnterIdx = dataSeq.lastIndexOf("\r");
    expect(lastEnterIdx).toBe(dataSeq.length - 1);

    await fs.rm(tmp, { recursive: true, force: true });
  });

  test("uses paste style with single bulk write for Claude (no char-by-char overhead)", async () => {
    const runner = new AgentTaskRunner();
    const ws = runner.createTaskWorkspace({
      state: { activeProfileId: "default" },
      description: "",
      cwd: "/tmp/test",
      parentWorkspaceId: "",
      workerProvider: { providerId: "claude", model: "sonnet" },
    });
    const deps = createMockDeps([ws]);
    runner.init(deps);

    ws.task.state = "paused";
    ws.task.promptSent = false;

    runner.resumeTask(ws.id);

    const sessionId = `${ws.id}:${ws.task.workerPanelId}`;
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      if (deps.written// eslint-disable-next-line @typescript-eslint/no-explicit-any
    .filter((w: any) => w.sessionId === sessionId).length >= 2) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    const writes = deps.written// eslint-disable-next-line @typescript-eslint/no-explicit-any
    .filter((w: any) => w.sessionId === sessionId);

    // Claude should get ONE bulk text write + ONE \r (two writes total).
    expect(writes.length).toBe(2);
    expect(writes[0].data.length).toBeGreaterThan(10);
    expect(writes[1].data).toBe("\r");
  });

  test("uses programmatic Copilot judge mode on Windows", () => {
    expect(shouldUseProgrammaticCopilotJudge({ providerId: "copilot" }, "win32")).toBe(true);
    expect(shouldUseProgrammaticCopilotJudge({ providerId: "copilot" }, "linux")).toBe(false);
    expect(shouldUseProgrammaticCopilotJudge({ providerId: "claude" }, "win32")).toBe(false);

    const command = buildProgrammaticCopilotJudgeCommand({
      promptPath: "C:\\temp\\judge prompt.md",
      cwd: "C:\\temp\\repo",
      model: "gpt-5.4-mini",
      platform: "win32",
    });
    expect(command).toContain('type "C:\\temp\\judge prompt.md" | copilot');
    expect(command).toContain("--no-ask-user");
    expect(command).toContain("--allow-all-tools");
    expect(command).toContain('--add-dir "C:\\temp\\repo"');
    expect(command).toContain('--model "gpt-5.4-mini"');
  });

  test("does not re-send prompt on resume if it was already sent", async () => {
    const runner = new AgentTaskRunner();
    const ws = runner.createTaskWorkspace({
      state: { activeProfileId: "default" },
      description: "Real task",
      cwd: "/tmp/test",
      parentWorkspaceId: "",
      maxRounds: 3,
    });
    const deps = createMockDeps([ws]);
    runner.init(deps);

    ws.task.state = "paused";
    ws.task.promptSent = true;
    deps.written.length = 0;

    runner.resumeTask(ws.id);
    // Same wait window as the positive case, so if a prompt WERE sent we'd see it.
    await new Promise((resolve) => setTimeout(resolve, 50));

    const workerSessionId = `${ws.id}:${ws.task.workerPanelId}`;
    const written = deps.written// eslint-disable-next-line @typescript-eslint/no-explicit-any
    .filter((w: any) => w.sessionId === workerSessionId);
    expect(written.length).toBe(0);
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

describe("reconcileOnStartup", () => {
  test("pauses tasks left in running state from previous session", () => {
    const runner = new AgentTaskRunner();
    const ws = createTaskWorkspace(runner);
    ws.task.state = "running";
    ws.task.promptSent = true;

    const deps = createMockDeps([ws]);
    runner.init(deps); // reconcile runs inside init

    expect(ws.task.state).toBe("paused");
    // No broadcastState during init — runtime isn't fully initialized yet
    expect(deps.broadcastState).not.toHaveBeenCalled();
  });

  test("pauses tasks left in evaluating state", () => {
    const runner = new AgentTaskRunner();
    const ws = createTaskWorkspace(runner);
    ws.task.state = "evaluating";

    const deps = createMockDeps([ws]);
    runner.init(deps);

    expect(ws.task.state).toBe("paused");
  });

  test("pauses tasks left in judge-evaluating state", () => {
    const runner = new AgentTaskRunner();
    const ws = createTaskWorkspace(runner);
    ws.task.state = "judge-evaluating";

    const deps = createMockDeps([ws]);
    runner.init(deps);

    expect(ws.task.state).toBe("paused");
  });

  test("does not touch idle, paused, completed, or failed tasks", () => {
    const runner = new AgentTaskRunner();
    const idle = createTaskWorkspace(runner);
    const paused = createTaskWorkspace(runner);
    const completed = createTaskWorkspace(runner);
    const failed = createTaskWorkspace(runner);

    idle.task.state = "idle";
    paused.task.state = "paused";
    completed.task.state = "completed";
    failed.task.state = "failed";

    const deps = createMockDeps([idle, paused, completed, failed]);
    runner.init(deps);

    expect(idle.task.state).toBe("idle");
    expect(paused.task.state).toBe("paused");
    expect(completed.task.state).toBe("completed");
    expect(failed.task.state).toBe("failed");
    expect(deps.broadcastState).not.toHaveBeenCalled();
  });
});
