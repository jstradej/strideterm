import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { AgentTaskRunner } from "./agent-task-runner.js";
import { HANDOFF_FILE, WORK_LOCK_FILE, taskDir } from "./agent-task-utils.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyApi = any;

const tempDirs: string[] = [];
const runners: AgentTaskRunner[] = [];

async function makeRunner() {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "strideterm-restart-edge-"));
  tempDirs.push(cwd);
  const runner = new AgentTaskRunner();
  runners.push(runner);
  const workspace = runner.createTaskWorkspace({
    state: {},
    description: "Restart edge task",
    cwd,
    parentWorkspaceId: "",
    maxRounds: 3,
  });
  const state = { workspaces: [workspace], activeProfileId: "default", profiles: [{ id: "default" }] };
  const deps = {
    getState: () => state,
    writeToSession: vi.fn(),
    broadcastState: vi.fn(),
    raiseAlert: vi.fn(),
    restartSession: vi.fn(async () => {}),
    isSessionBusy: vi.fn(() => false),
    isAgentDroppedToShell: vi.fn(() => false),
  };
  runner.init(deps as AnyApi);
  return { cwd, runner, workspace, deps };
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for task-runner continuation");
}

afterEach(async () => {
  for (const runner of runners.splice(0)) runner.dispose();
  for (const dir of tempDirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

describe("AgentTaskRunner managed restart exit", () => {
  test("intentional old-session exit and runtime lifecycle callbacks preserve the managed task operation", async () => {
    const { cwd, runner, workspace, deps } = await makeRunner();
    const sessionId = `${workspace.id}:${workspace.task.workerPanelId}`;
    const taskPath = taskDir(cwd, workspace.task.taskId);
    await fs.mkdir(taskPath, { recursive: true });
    await fs.writeFile(path.join(taskPath, WORK_LOCK_FILE), "work remains", "utf8");
    await fs.writeFile(path.join(taskPath, HANDOFF_FILE), "Progress so far.", "utf8");
    workspace.task.state = "running";
    workspace.task.promptSent = true;
    workspace.task.currentRound = 1;
    workspace.task.showerInterval = 1;
    workspace.task.lastShowerRound = 0;

    let managedOperationRemainedCurrent = false;
    deps.restartSession.mockImplementation(async () => {
      // These are the runtime callbacks around SessionManager.restartSession:
      // cancel before restart, intentional old PTY exit, retire, then spawn.
      const isCurrent = runner.captureSessionTaskOperation(sessionId, "managed-restart");
      runner.cancelPendingInput(sessionId);
      runner.onSessionExit(sessionId, true);
      runner.cancelPendingInput(sessionId);
      runner.cancelPendingInput(sessionId);
      managedOperationRemainedCurrent = isCurrent?.() ?? false;
    });

    runner.onAgentIdle(sessionId, "hook:stop");
    await waitFor(() => workspace.task.lastShowerRound === 1 && workspace.task.state === "running");

    expect(deps.restartSession).toHaveBeenCalledWith(sessionId);
    expect(managedOperationRemainedCurrent).toBe(true);
    expect(workspace.task.state).toBe("running");
    expect(workspace.task.lastShowerRound).toBe(1);
    expect(workspace.task.showerResumePrompt).toContain("Progress so far.");
    expect(deps.raiseAlert).not.toHaveBeenCalled();
  });

  test("intentional exit outside a managed restart still pauses the active task", async () => {
    const { runner, workspace } = await makeRunner();
    workspace.task.state = "running";

    runner.onSessionExit(`${workspace.id}:${workspace.task.workerPanelId}`, true);

    expect(workspace.task.state).toBe("paused");
  });

  test("unexpected judge exit during a managed restart still crosses the session generation", async () => {
    const { runner, workspace, deps } = await makeRunner();
    const sessionId = `${workspace.id}:${workspace.task.judgePanelId}`;
    workspace.task.state = "judge-evaluating";
    deps.isAgentDroppedToShell.mockReturnValue(true);
    let operationRemainedCurrent = true;
    deps.restartSession.mockImplementation(async () => {
      runner.cancelPendingInput(sessionId);
      const isCurrent = runner.captureSessionTaskOperation(sessionId, "unexpected-managed-exit");
      runner.onSessionExit(sessionId, false);
      runner.cancelPendingInput(sessionId);
      runner.cancelPendingInput(sessionId);
      operationRemainedCurrent = isCurrent?.() ?? true;
    });

    runner.onAgentIdle(sessionId, "hook:stop");
    await waitFor(() => deps.restartSession.mock.calls.length > 0);

    expect(deps.restartSession).toHaveBeenCalledWith(sessionId);
    expect(operationRemainedCurrent).toBe(false);
    expect(workspace.task.state).toBe("judge-evaluating");
  });
});
