import { describe, expect, test, vi } from "vitest";
import { createTaskHandlers } from "./runtime-task-handlers.js";

function createSourceWorkspace(overrides: Record<string, unknown> = {}) {
  return {
    id: "workspace-source",
    name: "Source workspace",
    kind: "manual",
    cwd: "/tmp/source-project",
    profileId: "default",
    panels: [{ id: "panel-source", title: "Claude", command: "claude", cwd: undefined }],
    task: null,
    ...overrides,
  };
}

function createCompanionWorkspace(overrides: Record<string, unknown> = {}) {
  return {
    id: "workspace-companion",
    name: "Reviewer: Source workspace",
    kind: "task",
    cwd: "/tmp/source-project",
    profileId: "default",
    panels: [
      { id: "panel-dashboard", title: "Dashboard", command: "__task-dashboard__" },
      { id: "panel-judge", title: "Reviewer", command: "codex" },
    ],
    task: {
      taskId: "companion-task-1",
      mode: "attached",
      workerWorkspaceId: "workspace-source",
      workerPanelId: "panel-source",
      judgePanelId: "panel-judge",
      companionRole: "reviewer",
      state: "idle",
    },
    ...overrides,
  };
}

// Builds a runtime-shaped object with the taskHandlers spread in, matching
// the exact pattern createTaskHandlers documents: "this" at call time must
// be the FULL merged object (with saveWorkspace/activateWorkspace etc.), not
// the factory's bare return value.
function createTestRuntime({
  workspaces = [],
  hasLiveSession = true,
  conflictGuardThrows = false,
  crossProfileThrows = false,
  recoveryCandidates = [],
}: {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  workspaces?: any[];
  hasLiveSession?: boolean;
  conflictGuardThrows?: boolean;
  crossProfileThrows?: boolean;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  recoveryCandidates?: any[];
} = {}) {
  const getState = () => ({ workspaces, activeProfileId: "default" });
  const saved: unknown[] = [];
  const taskRunner = {
    createCompanionTaskWorkspace: vi.fn((config) => {
      const ws = createCompanionWorkspace({
        task: {
          taskId: "companion-task-1",
          mode: "attached",
          workerWorkspaceId: config.workerWorkspaceId,
          workerPanelId: config.workerPanelId,
          judgePanelId: "panel-judge",
          companionRole: config.companionRole,
          companionFocus: config.focus || "",
          judgeProviderConfig: { ...config.companionProvider, skipPermissions: false },
          state: "idle",
        },
      });
      return ws;
    }),
    writeCompanionFiles: vi.fn(async () => {}),
    answerCompanionTask: vi.fn(async () => true),
    markAttachedSourceMissing: vi.fn(),
    resumeTask: vi.fn(() => true),
    resetTask: vi.fn(async () => true),
    onAgentIdle: vi.fn(() => true),
  };
  const taskHandlers = createTaskHandlers({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn() } as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    getState: getState as any,
    getPayload: () => ({ appState: getState() }),
    broadcastState: vi.fn(),
    store: { mutate: vi.fn(async () => {}) },
    taskRunner,
    sessions: { hasSession: vi.fn(() => hasLiveSession), ensureSession: vi.fn(async () => null) },
    execFileTextImpl: vi.fn(async () => ({ stdout: "", stderr: "" })),
    recheckClaudeAvailability: vi.fn(async () => true),
    assertWorkspaceInViewerProfile: vi.fn(() => {
      if (crossProfileThrows) throw new Error("Cross-profile refused");
    }),
    resolveCallerProfileId: vi.fn(() => "default"),
    assertNoConflictingActiveTask: vi.fn(() => {
      if (conflictGuardThrows) {
        throw new Error('Another task agent ("x") is currently running in this directory.');
      }
    }),
    worktreeTreePath: vi.fn(() => ""),
    ensureWorktree: vi.fn(async () => ""),
    getRecoveryCandidates: () => recoveryCandidates,
    setRecoveryCandidates: vi.fn(),
    recordWorkspaceWork: vi.fn(async () => {}),
  });

  const runtime = {
    ...taskHandlers,
    saveWorkspace: vi.fn(async (ws: unknown) => {
      saved.push(ws);
      workspaces.push(ws);
    }),
    activateWorkspaceInWindow: vi.fn(async () => {}),
    activateWorkspace: vi.fn(async () => {}),
  };

  return { runtime, taskRunner, saved, workspaces };
}

describe("createCompanionTask", () => {
  test("happy path: derives source workspace/panel/cwd, creates and activates the companion workspace", async () => {
    const source = createSourceWorkspace();
    const { runtime, taskRunner, saved } = createTestRuntime({ workspaces: [source] });

    const result = await runtime.createCompanionTask(
      {
        sourceSessionId: "workspace-source:panel-source",
        companionRole: "reviewer",
        companionProvider: { providerId: "codex", model: "gpt-5.5" },
        focus: "Pay attention to X.",
      },
      "window-1",
    );

    expect(taskRunner.createCompanionTaskWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({
        workerWorkspaceId: "workspace-source",
        workerPanelId: "panel-source",
        companionRole: "reviewer",
        focus: "Pay attention to X.",
      }),
    );
    expect(taskRunner.writeCompanionFiles).toHaveBeenCalled();
    expect(saved).toHaveLength(1);
    expect(runtime.activateWorkspaceInWindow).toHaveBeenCalledWith("workspace-companion", "window-1");
    expect(result.workspaceId).toBe("workspace-companion");
  });

  test("rejects when the source panel has no live session", async () => {
    const source = createSourceWorkspace();
    const { runtime } = createTestRuntime({ workspaces: [source], hasLiveSession: false });

    await expect(
      runtime.createCompanionTask(
        {
          sourceSessionId: "workspace-source:panel-source",
          companionRole: "reviewer",
          companionProvider: { providerId: "codex", model: "gpt-5.5" },
        },
        "window-1",
      ),
    ).rejects.toThrow(/isn't currently running/i);
  });

  test("rejects when the source workspace no longer exists", async () => {
    const { runtime } = createTestRuntime({ workspaces: [] });
    await expect(
      runtime.createCompanionTask(
        {
          sourceSessionId: "workspace-missing:panel-missing",
          companionRole: "reviewer",
          companionProvider: { providerId: "codex", model: "gpt-5.5" },
        },
        "window-1",
      ),
    ).rejects.toThrow(/workspace no longer exists/i);
  });

  test("rejects when the source panel no longer exists on the (still-present) source workspace", async () => {
    const source = createSourceWorkspace({ panels: [] });
    const { runtime } = createTestRuntime({ workspaces: [source] });
    await expect(
      runtime.createCompanionTask(
        {
          sourceSessionId: "workspace-source:panel-source",
          companionRole: "reviewer",
          companionProvider: { providerId: "codex", model: "gpt-5.5" },
        },
        "window-1",
      ),
    ).rejects.toThrow(/panel no longer exists/i);
  });

  // The bypass is the user's decision, made in the companion dialog — the
  // handler carries it through rather than rejecting or stripping it.
  test("passes companionProvider.skipPermissions:true through instead of rejecting or stripping it", async () => {
    const source = createSourceWorkspace();
    const { runtime, taskRunner } = createTestRuntime({ workspaces: [source] });
    await runtime.createCompanionTask(
      {
        sourceSessionId: "workspace-source:panel-source",
        companionRole: "reviewer",
        companionProvider: { providerId: "codex", model: "gpt-5.6-terra", skipPermissions: true },
      },
      "window-1",
    );

    expect(taskRunner.createCompanionTaskWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({
        companionProvider: expect.objectContaining({ skipPermissions: true }),
      }),
    );
  });

  test("refuses a second active companion loop over the same source session", async () => {
    const source = createSourceWorkspace();
    const existingCompanion = createCompanionWorkspace({
      task: { ...createCompanionWorkspace().task, state: "running" },
    });
    const { runtime } = createTestRuntime({ workspaces: [source, existingCompanion] });

    await expect(
      runtime.createCompanionTask(
        {
          sourceSessionId: "workspace-source:panel-source",
          companionRole: "critic",
          companionProvider: { providerId: "codex", model: "gpt-5.5" },
        },
        "window-1",
      ),
    ).rejects.toThrow(/already attached/i);
  });

  test("allows a new companion loop once the previous one over the same session has completed", async () => {
    const source = createSourceWorkspace();
    const finishedCompanion = createCompanionWorkspace({
      task: { ...createCompanionWorkspace().task, state: "completed" },
    });
    const { runtime, taskRunner } = createTestRuntime({ workspaces: [source, finishedCompanion] });

    await runtime.createCompanionTask(
      {
        sourceSessionId: "workspace-source:panel-source",
        companionRole: "critic",
        companionProvider: { providerId: "codex", model: "gpt-5.5" },
      },
      "window-1",
    );
    expect(taskRunner.createCompanionTaskWorkspace).toHaveBeenCalled();
  });

  test("re-uses the same profile-aware same-cwd guard as the standard create path", async () => {
    const source = createSourceWorkspace();
    const { runtime } = createTestRuntime({ workspaces: [source], conflictGuardThrows: true });
    await expect(
      runtime.createCompanionTask(
        {
          sourceSessionId: "workspace-source:panel-source",
          companionRole: "reviewer",
          companionProvider: { providerId: "codex", model: "gpt-5.5" },
        },
        "window-1",
      ),
    ).rejects.toThrow(/currently running in this directory/i);
  });

  test("cross-profile refusal is checked before any workspace/session lookup", async () => {
    const source = createSourceWorkspace();
    const { runtime } = createTestRuntime({ workspaces: [source], crossProfileThrows: true });

    await expect(
      runtime.createCompanionTask(
        {
          sourceSessionId: "workspace-source:panel-source",
          companionRole: "reviewer",
          companionProvider: { providerId: "codex", model: "gpt-5.5" },
        },
        "window-b",
      ),
    ).rejects.toThrow(/cross-profile/i);
  });
});

describe("answerCompanionTask", () => {
  test("delegates to taskRunner.answerCompanionTask with normalized args", async () => {
    const { runtime, taskRunner } = createTestRuntime();
    const result = await runtime.answerCompanionTask("workspace-companion", ["Q-1", "Q-2"], "Go with B.", "window-1");
    expect(taskRunner.answerCompanionTask).toHaveBeenCalledWith("workspace-companion", ["Q-1", "Q-2"], "Go with B.");
    expect(result.ok).toBe(true);
  });
});

describe("resolveTaskRecovery — attached mode dangling source (plan §8.7 step 5)", () => {
  const recoveryCandidate = {
    taskId: "companion-task-1",
    workspaceId: "workspace-companion",
    workspaceName: "Reviewer: Source workspace",
    profileId: "default",
    currentRound: 1,
    maxRounds: 5,
    previousState: "judge-evaluating",
  };

  test("source workspace gone entirely: never respawns an unrelated panel, marks the Primary missing instead", async () => {
    const companion = createCompanionWorkspace({ task: { ...createCompanionWorkspace().task, state: "paused" } });
    const { runtime, taskRunner } = createTestRuntime({
      workspaces: [companion],
      recoveryCandidates: [recoveryCandidate],
    });

    await runtime.resolveTaskRecovery({ "workspace-companion": "continue" });

    expect(taskRunner.markAttachedSourceMissing).toHaveBeenCalledWith("workspace-companion");
    expect(taskRunner.resumeTask).not.toHaveBeenCalled();
  });

  test("source workspace exists but the bound panel was removed: same dangling handling", async () => {
    const source = createSourceWorkspace({ panels: [] });
    const companion = createCompanionWorkspace({ task: { ...createCompanionWorkspace().task, state: "paused" } });
    const { runtime, taskRunner } = createTestRuntime({
      workspaces: [source, companion],
      recoveryCandidates: [recoveryCandidate],
    });

    await runtime.resolveTaskRecovery({ "workspace-companion": "continue" });

    expect(taskRunner.markAttachedSourceMissing).toHaveBeenCalledWith("workspace-companion");
    expect(taskRunner.resumeTask).not.toHaveBeenCalled();
  });

  test("source workspace and panel both still present: does not mark anything missing, resumes normally", async () => {
    const source = createSourceWorkspace();
    const companion = createCompanionWorkspace({ task: { ...createCompanionWorkspace().task, state: "paused" } });
    const { runtime, taskRunner } = createTestRuntime({
      workspaces: [source, companion],
      recoveryCandidates: [recoveryCandidate],
    });

    await runtime.resolveTaskRecovery({ "workspace-companion": "continue" });

    expect(taskRunner.markAttachedSourceMissing).not.toHaveBeenCalled();
    expect(taskRunner.resumeTask).toHaveBeenCalledWith("workspace-companion");
  });
});
