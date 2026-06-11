import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { describe, expect, test, vi, beforeEach } from "vitest";
import {
  AgentTaskRunner,
  buildProgrammaticCopilotJudgeCommand,
  shouldUseProgrammaticCopilotJudge,
} from "./agent-task-runner.js";
import {
  HANDOFF_FILE,
  TASK_FILE,
  TASK_LOG_FILE,
  TODO_FILE,
  VERDICT_FILE,
  WORK_LOCK_FILE,
  extractTaskDescription,
  taskDir,
} from "./agent-task-utils.js";

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  { timeoutMs = 5000, intervalMs = 10 }: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`waitFor: predicate did not become true within ${timeoutMs}ms`);
}

// Read TASK_LOG.jsonl events for a task dir, tolerating an absent/partial file.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function readTaskLogEvents(cwd: string, taskId: string): Promise<any[]> {
  try {
    const raw = await fs.readFile(path.join(taskDir(cwd, taskId), TASK_LOG_FILE), "utf8");
    return raw
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

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
    state: {},
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
        state: {},
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
        state: {},
        description: "Build pagination",
        cwd: "/tmp/test",
        parentWorkspaceId: "",
        name: "",
      });
      expect(ws.name).toBe("Build pagination");
    });

    test("uses custom icon when provided", () => {
      const ws = runner.createTaskWorkspace({
        state: {},
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

    test("assigns sequenceNumber 1 for first task under a parent", () => {
      const ws = runner.createTaskWorkspace({
        state: { workspaces: [{ id: "ws-parent", kind: "terminal" }] },
        description: "First task",
        cwd: "/tmp/test",
        parentWorkspaceId: "ws-parent",
      });
      expect(ws.task.sequenceNumber).toBe(1);
    });

    test("assigns next sequenceNumber per parent and skips deleted siblings", () => {
      // Pre-existing siblings under the same parent: #1 and #3 (the user
      // deleted #2). Numbering must NOT renumber survivors, so the new task
      // gets #4, not #3.
      const parent = { id: "ws-parent", kind: "terminal" };
      const existing = [
        { id: "t1", kind: "task", task: { parentWorkspaceId: "ws-parent", sequenceNumber: 1 } },
        { id: "t3", kind: "task", task: { parentWorkspaceId: "ws-parent", sequenceNumber: 3 } },
      ];
      const ws = runner.createTaskWorkspace({
        state: { workspaces: [parent, ...existing] },
        description: "Fourth task",
        cwd: "/tmp/test",
        parentWorkspaceId: "ws-parent",
      });
      expect(ws.task.sequenceNumber).toBe(4);
    });

    test("counts unnumbered legacy siblings so the new task doesn't claim '#1'", () => {
      // A parent that pre-dates this feature has three unnumbered task
      // siblings. The new task must not get #1 — that would read as "the
      // first one" rather than "the newest one". Instead we count the
      // siblings and pick max(numbered max, sibling count) + 1 = 4.
      const parent = { id: "ws-parent", kind: "terminal" };
      const legacy = [
        { id: "tL1", kind: "task", task: { parentWorkspaceId: "ws-parent" } },
        { id: "tL2", kind: "task", task: { parentWorkspaceId: "ws-parent" } },
        { id: "tL3", kind: "task", task: { parentWorkspaceId: "ws-parent" } },
      ];
      const ws = runner.createTaskWorkspace({
        state: { workspaces: [parent, ...legacy] },
        description: "First post-feature task",
        cwd: "/tmp/test",
        parentWorkspaceId: "ws-parent",
      });
      expect(ws.task.sequenceNumber).toBe(4);
    });

    test("scopes sequenceNumber to parentWorkspaceId — different parents start at 1", () => {
      const existing = [
        { id: "t1", kind: "task", task: { parentWorkspaceId: "ws-parent-A", sequenceNumber: 1 } },
        { id: "t2", kind: "task", task: { parentWorkspaceId: "ws-parent-A", sequenceNumber: 2 } },
      ];
      const ws = runner.createTaskWorkspace({
        state: { workspaces: existing },
        description: "First task under B",
        cwd: "/tmp/test",
        parentWorkspaceId: "ws-parent-B",
      });
      expect(ws.task.sequenceNumber).toBe(1);
    });

    test("sets createdAt as an ISO timestamp", () => {
      const before = Date.now();
      const ws = createTaskWorkspace(runner);
      const after = Date.now();
      expect(typeof ws.task.createdAt).toBe("string");
      const parsed = Date.parse(ws.task.createdAt);
      expect(parsed).toBeGreaterThanOrEqual(before);
      expect(parsed).toBeLessThanOrEqual(after);
    });

    test("uses custom color when provided", () => {
      const ws = runner.createTaskWorkspace({
        state: {},
        description: "Test",
        cwd: "/tmp/test",
        parentWorkspaceId: "",
        color: "#FF0000",
      });
      expect(ws.color).toBe("#FF0000");
    });

    test("inherits parent workspace's color when parent exists and no explicit color is passed", () => {
      const parent = {
        id: "ws-parent",
        profileId: "default",
        color: "#00AA88",
        kind: "terminal",
      };
      const ws = runner.createTaskWorkspace({
        state: { workspaces: [parent] },
        description: "Task with parent",
        cwd: "/tmp/test",
        parentWorkspaceId: "ws-parent",
      });
      expect(ws.color).toBe("#00AA88");
    });

    test("explicit color overrides parent workspace's color", () => {
      const parent = {
        id: "ws-parent",
        profileId: "default",
        color: "#00AA88",
        kind: "terminal",
      };
      const ws = runner.createTaskWorkspace({
        state: { workspaces: [parent] },
        description: "Task with parent",
        cwd: "/tmp/test",
        parentWorkspaceId: "ws-parent",
        color: "#FF0000",
      });
      expect(ws.color).toBe("#FF0000");
    });

    test("falls back to default purple when there is no parent and no explicit color", () => {
      const ws = runner.createTaskWorkspace({
        state: {},
        description: "Test",
        cwd: "/tmp/test",
        parentWorkspaceId: "",
      });
      expect(ws.color).toBe("#7C4DFF");
    });

    test("uses custom notes when provided", () => {
      const ws = runner.createTaskWorkspace({
        state: {},
        description: "Test",
        cwd: "/tmp/test",
        parentWorkspaceId: "",
        notes: "Important context",
      });
      expect(ws.notes).toBe("Important context");
    });

    test("uses custom worker command when provided", () => {
      const ws = runner.createTaskWorkspace({
        state: {},
        description: "Test",
        cwd: "/tmp/test",
        parentWorkspaceId: "",
        workerCommand: "claude --model haiku",
      });
      expect(ws.panels[1].command).toBe("claude --model haiku");
    });

    test("uses custom judge command when provided", () => {
      const ws = runner.createTaskWorkspace({
        state: {},
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
        state: {},
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

    test("inherits parent workspace's profileId when parent exists", () => {
      const parent = {
        id: "ws-parent",
        profileId: "profile-b",
        kind: "terminal",
      };
      const ws = runner.createTaskWorkspace({
        state: {
          workspaces: [parent],
          windowSlots: [
            { id: "win-default", profileId: "default" },
            { id: "win-b", profileId: "profile-b" },
          ],
        },
        description: "Task with parent",
        cwd: "/tmp/test",
        parentWorkspaceId: "ws-parent",
        callerProfileId: "default", // intentionally mismatched — parent wins
      });
      expect(ws.profileId).toBe("profile-b");
    });

    test("falls back to callerProfileId when there is no parent (not windowSlots[0])", () => {
      // Multi-window: windowSlots[0]=default, windowSlots[1]=profile-b.
      // The user creates a task from window-b. Without the fix, the task
      // lands on "default" (windowSlots[0]), invisible from profile-b's
      // sidebar.
      const ws = runner.createTaskWorkspace({
        state: {
          workspaces: [],
          windowSlots: [
            { id: "win-default", profileId: "default" },
            { id: "win-b", profileId: "profile-b" },
          ],
        },
        description: "Task without parent",
        cwd: "/tmp/test",
        parentWorkspaceId: "",
        callerProfileId: "profile-b",
      });
      expect(ws.profileId).toBe("profile-b");
    });

    test("falls back to windowSlots[0] when no parent and no callerProfileId (legacy path)", () => {
      // Defensive fallback for callers that haven't been updated to pass
      // callerProfileId (e.g. tests, or legacy IPC paths without windowId).
      const ws = runner.createTaskWorkspace({
        state: {
          workspaces: [],
          windowSlots: [{ id: "win-only", profileId: "default" }],
        },
        description: "Legacy",
        cwd: "/tmp/test",
        parentWorkspaceId: "",
      });
      expect(ws.profileId).toBe("default");
    });

    test("parses copilot providerId from legacy workerCommand string", () => {
      const ws = runner.createTaskWorkspace({
        state: {},
        description: "Legacy-string task",
        cwd: "/tmp/test",
        parentWorkspaceId: "",
        workerCommand: "copilot --allow-all-tools --model gpt-5.4",
      });

      expect(ws.task.workerProviderConfig.providerId).toBe("copilot");
      expect(ws.task.workerProviderConfig.model).toBe("gpt-5.4");
    });
  });

  // writeInitialFiles is the only path that produces task files for new
  // workspaces. The split (TASK.md = brief, WORKER.md = rules+verification)
  // depends on this function (a) writing both files and (b) marking the task
  // with useWorkerFile=true so prompt builders pick the right file references.
  // If a future refactor accidentally bypasses one of those steps, the
  // user-facing TASK.md regrows the operational sections — exactly the bug
  // we just removed.
  describe("writeInitialFiles — split format", () => {
    test("creates both TASK.md and WORKER.md and flips useWorkerFile on the task", async () => {
      const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "strideterm-write-initial-"));
      try {
        const ws = createTaskWorkspace(runner, { cwd: tmp, description: "Some brief." });
        await runner.writeInitialFiles(tmp, ws.task);

        const dir = taskDir(tmp, ws.task.taskId);
        const taskMd = await fs.readFile(path.join(dir, TASK_FILE), "utf8");
        const workerMd = await fs.readFile(path.join(dir, "WORKER.md"), "utf8");

        expect(taskMd).toContain("Some brief.");
        expect(taskMd).not.toContain("## Verification");
        expect(taskMd).not.toContain("## Rules");
        expect(workerMd).toContain("## Verification before completion");
        expect(workerMd).toContain("## Rules");

        // Flag drives format-aware prompt building. Must be true for new tasks.
        expect(ws.task.useWorkerFile).toBe(true);
      } finally {
        await fs.rm(tmp, { recursive: true, force: true });
      }
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
      // Krok 4 / Test 8 — pausedFromState must capture judge-evaluating so a
      // later Continue resumes to read the verdict, not fall back to running.
      expect(workspace.task.pausedFromState).toBe("judge-evaluating");
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

    test("consumes idle when worker is in rate-limit hold (future rateLimitedUntil)", () => {
      // Worker hit a rate limit; runner is waiting for the reset window. We
      // must NOT try to evaluate the worker — its output is stale.
      workspace.task.state = "running";
      workspace.task.rateLimitedUntil = new Date(Date.now() + 60 * 60_000).toISOString();
      const sessionId = `${workspace.id}:${workspace.task.workerPanelId}`;
      const result = runner.onAgentIdle(sessionId);
      expect(result).toBe(true);
      // Marker untouched — only the resume timer should clear it.
      expect(workspace.task.rateLimitedUntil).not.toBeNull();
    });

    test("clears stale rateLimitedUntil and proceeds normally", () => {
      // App was sleeping or the timer never fired; the marker is in the past.
      // Don't keep blocking forever — clear it and let the runner re-evaluate.
      workspace.task.state = "running";
      workspace.task.promptSent = true; // skip the initial-inject branch
      workspace.task.rateLimitedUntil = new Date(Date.now() - 1_000).toISOString();
      const sessionId = `${workspace.id}:${workspace.task.workerPanelId}`;
      runner.onAgentIdle(sessionId);
      expect(workspace.task.rateLimitedUntil).toBeNull();
    });

    test("WORK_LOCK absent overrides rate-limit hold (worker actually finished)", async () => {
      // Regression: a false-positive rate-limit detection that survived the
      // 30 s confirmation window would lock up the judge — onAgentIdle would
      // suppress every subsequent idle event because rateLimitedUntil was set.
      // The override checks WORK_LOCK on disk; if the worker has already
      // signaled completion (lock file deleted), the hold is cleared and
      // evaluation runs.
      const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "strideterm-rl-override-"));
      try {
        const localRunner = new AgentTaskRunner();
        const ws = localRunner.createTaskWorkspace({
          state: {},
          description: "Override test",
          cwd: tmp,
          parentWorkspaceId: "",
          maxRounds: 3,
        });
        // Create the task dir but NOT the WORK_LOCK file — simulates the
        // post-completion state where the worker explicitly removed it.
        await fs.mkdir(taskDir(tmp, ws.task.taskId), { recursive: true });

        const localDeps = createMockDeps([ws]);
        localRunner.init(localDeps);

        ws.task.state = "running";
        ws.task.promptSent = true;
        ws.task.rateLimitedUntil = new Date(Date.now() + 60 * 60_000).toISOString();

        const sessionId = `${ws.id}:${ws.task.workerPanelId}`;
        const result = localRunner.onAgentIdle(sessionId);

        // Sync return: still consumed (hold present at call time).
        expect(result).toBe(true);
        expect(ws.task.rateLimitedUntil).not.toBeNull();

        // Wait for the deferred override timer (2 s) plus a small buffer for
        // the async fs probe + #evaluateWorker to run.
        await new Promise((resolve) => setTimeout(resolve, 2500));

        // Override fired: hold cleared.
        expect(ws.task.rateLimitedUntil).toBeNull();
      } finally {
        await fs.rm(tmp, { recursive: true, force: true });
      }
    });

    test("WORK_LOCK present preserves rate-limit hold (worker still working)", async () => {
      const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "strideterm-rl-keep-"));
      try {
        const localRunner = new AgentTaskRunner();
        const ws = localRunner.createTaskWorkspace({
          state: {},
          description: "No-override test",
          cwd: tmp,
          parentWorkspaceId: "",
          maxRounds: 3,
        });
        const dir = taskDir(tmp, ws.task.taskId);
        await fs.mkdir(dir, { recursive: true });
        await fs.writeFile(path.join(dir, WORK_LOCK_FILE), "Work remains.");

        const localDeps = createMockDeps([ws]);
        localRunner.init(localDeps);

        ws.task.state = "running";
        ws.task.promptSent = true;
        const heldUntil = new Date(Date.now() + 60 * 60_000).toISOString();
        ws.task.rateLimitedUntil = heldUntil;

        const sessionId = `${ws.id}:${ws.task.workerPanelId}`;
        localRunner.onAgentIdle(sessionId);

        // Wait past the deferred check.
        await new Promise((resolve) => setTimeout(resolve, 2500));

        // Hold preserved — worker is still working (lock file still present).
        expect(ws.task.rateLimitedUntil).toBe(heldUntil);
      } finally {
        await fs.rm(tmp, { recursive: true, force: true });
      }
    });
  });

  describe("onWorkerRateLimited", () => {
    function makeMatch(overrides: Partial<{ resetAt: Date | null; needsConfirm: boolean; providerHint: string }> = {}) {
      return {
        resetAt: overrides.resetAt ?? null,
        needsConfirm: overrides.needsConfirm ?? false,
        providerHint: (overrides.providerHint ?? "generic") as "claude" | "codex" | "gemini" | "copilot" | "generic",
      };
    }

    test("returns false for non-task session", () => {
      const result = runner.onWorkerRateLimited(
        "ghost:panel",
        makeMatch({ needsConfirm: true, providerHint: "claude" }),
      );
      expect(result).toBe(false);
    });

    test("returns false for judge panel (worker only)", () => {
      workspace.task.state = "running";
      const judgeSid = `${workspace.id}:${workspace.task.judgePanelId}`;
      const result = runner.onWorkerRateLimited(judgeSid, makeMatch({ needsConfirm: true, providerHint: "claude" }));
      expect(result).toBe(false);
    });

    test("Claude prompt-limit: presses Enter and stores rateLimitedUntil", () => {
      workspace.task.state = "running";
      const sessionId = `${workspace.id}:${workspace.task.workerPanelId}`;
      const resetAt = new Date(Date.now() + 60 * 60_000); // 1h
      const result = runner.onWorkerRateLimited(
        sessionId,
        makeMatch({ resetAt, needsConfirm: true, providerHint: "claude" }),
      );
      expect(result).toBe(true);
      expect(workspace.task.rateLimitedUntil).toBe(resetAt.toISOString());
      // Enter selects highlighted "1. Stop and wait for limit to reset"
      expect(deps.written).toContainEqual({ sessionId, data: "\r" });
    });

    test("CLI-exit (no resetAt, needsConfirm=false): falls back to 30 min and does NOT press Enter", () => {
      workspace.task.state = "running";
      const sessionId = `${workspace.id}:${workspace.task.workerPanelId}`;
      const before = Date.now();
      const result = runner.onWorkerRateLimited(
        sessionId,
        makeMatch({ resetAt: null, needsConfirm: false, providerHint: "codex" }),
      );
      expect(result).toBe(true);
      // No raw Enter — Codex CLI exited, there's nothing to confirm.
      expect(deps.written).toHaveLength(0);
      // First-tier fallback delay is 30 min (allow ±60s tolerance).
      const until = Date.parse(workspace.task.rateLimitedUntil!);
      expect(until - before).toBeGreaterThanOrEqual(30 * 60_000 - 60_000);
      expect(until - before).toBeLessThanOrEqual(30 * 60_000 + 60_000);
    });

    test("hard-stop ceiling: pauses task when reset is more than 12h away", () => {
      workspace.task.state = "running";
      const sessionId = `${workspace.id}:${workspace.task.workerPanelId}`;
      const resetAt = new Date(Date.now() + 13 * 60 * 60_000); // 13h
      const result = runner.onWorkerRateLimited(
        sessionId,
        makeMatch({ resetAt, needsConfirm: false, providerHint: "copilot" }),
      );
      expect(result).toBe(true);
      expect(workspace.task.state).toBe("paused");
      // Task-failed alert raised so the user notices. raiseTaskAlert maps
      // failed → kind="waiting" (urgent) with detail starting "task-failed:".
      const failedAlert = deps.alerts.find(
        (a: { kind: string; detail: string; urgency: string }) =>
          a.urgency === "urgent" && typeof a.detail === "string" && a.detail.startsWith("task-failed"),
      );
      expect(failedAlert).toBeDefined();
    });

    test("same-window dedup: redrawn dialog does not stack timers or re-press Enter", () => {
      workspace.task.state = "running";
      const sessionId = `${workspace.id}:${workspace.task.workerPanelId}`;
      const resetAt = new Date(Date.now() + 60 * 60_000);
      const match = makeMatch({ resetAt, needsConfirm: true, providerHint: "claude" });

      runner.onWorkerRateLimited(sessionId, match);
      const writesAfterFirst = deps.writeToSession.mock.calls.length;
      runner.onWorkerRateLimited(sessionId, match);
      // No additional writes — the second call is consumed by dedup.
      expect(deps.writeToSession.mock.calls.length).toBe(writesAfterFirst);
    });
  });

  describe("rate-limit retry cap and resume", () => {
    test("retry cap: pauses task after MAX_RATE_LIMIT_RETRIES consecutive hits", async () => {
      vi.useFakeTimers();
      try {
        workspace.task.state = "running";
        const sessionId = `${workspace.id}:${workspace.task.workerPanelId}`;
        // Each iteration: schedule a hit, fire its timer to clear, then loop.
        // The 6th call (retries=6) trips the cap (MAX=5).
        for (let i = 1; i <= AgentTaskRunner.MAX_RATE_LIMIT_RETRIES + 1; i++) {
          // 1-second windows + 60s margin keep the test fast.
          const resetAt = new Date(Date.now() + 1_000);
          runner.onWorkerRateLimited(sessionId, {
            resetAt,
            needsConfirm: true,
            providerHint: "claude" as const,
          });
          if (workspace.task.state === "paused") break;
          // Fire the resume timer so the next call counts as a fresh hit.
          // 1s reset + 60s margin + 200ms inject submit delay = ~62s.
          await vi.advanceTimersByTimeAsync(62_500);
        }
        expect(workspace.task.state).toBe("paused");
        // raiseTaskAlert maps failed → kind="waiting" with detail "task-failed: ...".
        const failed = deps.alerts.find(
          (a: { detail: string; urgency: string }) =>
            a.urgency === "urgent" && typeof a.detail === "string" && a.detail.startsWith("task-failed"),
        );
        expect(failed).toBeDefined();
      } finally {
        vi.useRealTimers();
      }
    });

    test("Claude resume: at the scheduled time, sends 'continue' via inject (not raw \\r)", async () => {
      vi.useFakeTimers();
      try {
        workspace.task.state = "running";
        const sessionId = `${workspace.id}:${workspace.task.workerPanelId}`;
        const resetAt = new Date(Date.now() + 1_000); // 1s window, fast test
        runner.onWorkerRateLimited(sessionId, {
          resetAt,
          needsConfirm: true,
          providerHint: "claude" as const,
        });
        // At submission, Enter was sent immediately; clear so we can assert
        // about the resume-time "continue" payload only.
        deps.writeToSession.mockClear();

        // Advance past resetAt + 60s margin + 200ms inject submit delay.
        await vi.advanceTimersByTimeAsync(62_500);

        // The resume injects "continue where you left off..." then \r.
        const writes = deps.writeToSession.mock.calls.map((c: [string, string]) => c[1]);
        const joined = writes.join("");
        expect(joined).toContain("continue where you left off");
        // And rateLimitedUntil cleared by the resume.
        expect(workspace.task.rateLimitedUntil).toBeNull();
      } finally {
        vi.useRealTimers();
      }
    });

    test("CLI-exit resume: at the scheduled time, calls restartSession and resets promptSent", async () => {
      vi.useFakeTimers();
      try {
        workspace.task.state = "running";
        workspace.task.promptSent = true; // simulate prior round
        const sessionId = `${workspace.id}:${workspace.task.workerPanelId}`;
        const resetAt = new Date(Date.now() + 1_000);
        runner.onWorkerRateLimited(sessionId, {
          resetAt,
          needsConfirm: false,
          providerHint: "codex" as const,
        });

        await vi.advanceTimersByTimeAsync(62_500);

        // Codex / Gemini / Copilot exited — must restart the worker session.
        expect(deps.restartSession).toHaveBeenCalledWith(sessionId);
        // promptSent cleared so the next idle re-injects the task prompt.
        expect(workspace.task.promptSent).toBe(false);
        expect(workspace.task.rateLimitedUntil).toBeNull();
      } finally {
        vi.useRealTimers();
      }
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

    test("alert title includes '#N' for task agents so Telegram notifications disambiguate siblings", () => {
      // Without this, three "mhub" task agents on the same parent all produce
      // identical "📍 mhub › Worker" Telegram alerts. The fix routes the
      // formatted display name (name + " #N") into the alert title.
      workspace.task.sequenceNumber = 3;
      workspace.task.state = "running";
      const sessionId = `${workspace.id}:${workspace.task.workerPanelId}`;
      runner.onSessionExit(sessionId);
      const alert = deps.alerts[deps.alerts.length - 1];
      expect(alert.title).toBe(`${workspace.name} #3`);
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
        state: {},
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

describe("createTaskWorkspace - worktree fields", () => {
  test("worktree fields can be set after creation (as runtime does)", () => {
    const runner = new AgentTaskRunner();
    const ws = runner.createTaskWorkspace({
      state: {},
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
      state: {},
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
      state: {},
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
      state: {},
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
      state: {},
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
    const written = deps.written // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
      state: {},
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

    const written = deps.written // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
      state: {},
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

    const writes = deps.written // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
      state: {},
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
      if (
        deps.written // eslint-disable-next-line @typescript-eslint/no-explicit-any
          .filter((w: any) => w.sessionId === sessionId).length >= 2
      )
        break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    const writes = deps.written // eslint-disable-next-line @typescript-eslint/no-explicit-any
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

  // Krok 3 — resume = active reconciliation from disk.
  test("resume (running, WORK_LOCK present, worker idle) injects a continuation prompt", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "strideterm-resume-cont-"));
    const runner = new AgentTaskRunner();
    const ws = runner.createTaskWorkspace({
      state: {},
      description: "Real task",
      cwd: tmp,
      parentWorkspaceId: "",
      maxRounds: 3,
    });
    await fs.mkdir(taskDir(tmp, ws.task.taskId), { recursive: true });
    await fs.writeFile(path.join(taskDir(tmp, ws.task.taskId), WORK_LOCK_FILE), "work remains");

    const deps = createMockDeps([ws]);
    runner.init(deps); // no isSessionBusy dep → worker treated as idle
    ws.task.state = "paused";
    ws.task.promptSent = true;
    ws.task.lastJudgeInstructions = "Fix the failing test.";
    deps.written.length = 0;

    runner.resumeTask(ws.id);

    const workerSessionId = `${ws.id}:${ws.task.workerPanelId}`;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await waitFor(() => deps.written.some((w: any) => w.sessionId === workerSessionId));
    await fs.rm(tmp, { recursive: true, force: true });
  });

  test("resume (running, WORK_LOCK present, worker busy) does NOT inject", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "strideterm-resume-busy-"));
    const runner = new AgentTaskRunner();
    const ws = runner.createTaskWorkspace({
      state: {},
      description: "Real task",
      cwd: tmp,
      parentWorkspaceId: "",
      maxRounds: 3,
    });
    await fs.mkdir(taskDir(tmp, ws.task.taskId), { recursive: true });
    await fs.writeFile(path.join(taskDir(tmp, ws.task.taskId), WORK_LOCK_FILE), "work remains");

    const deps = createMockDeps([ws]);
    deps.isSessionBusy = () => true; // worker provably still working
    runner.init(deps);
    ws.task.state = "paused";
    ws.task.promptSent = true;
    deps.written.length = 0;

    runner.resumeTask(ws.id);
    await new Promise((resolve) => setTimeout(resolve, 200));

    const workerSessionId = `${ws.id}:${ws.task.workerPanelId}`;
    const written = deps.written // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .filter((w: any) => w.sessionId === workerSessionId);
    expect(written.length).toBe(0);
    await fs.rm(tmp, { recursive: true, force: true });
  });

  test("resume processes an unread verdict on disk regardless of pausedFromState", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "strideterm-resume-verdict-"));
    const runner = new AgentTaskRunner();
    const ws = runner.createTaskWorkspace({
      state: {},
      description: "Real task",
      cwd: tmp,
      parentWorkspaceId: "",
      maxRounds: 3,
    });
    await fs.mkdir(taskDir(tmp, ws.task.taskId), { recursive: true });
    // A judge wrote a "complete" verdict that was never consumed (last round
    // has no judgeVerdict). Resuming must process it, not wait for an idle hook.
    await fs.writeFile(
      path.join(taskDir(tmp, ws.task.taskId), VERDICT_FILE),
      JSON.stringify({ verdict: "complete", reason: "All requirements met." }),
    );

    const deps = createMockDeps([ws]);
    runner.init(deps);
    ws.task.state = "paused";
    ws.task.pausedFromState = ""; // paused from running, yet verdict still handled
    ws.task.promptSent = true;
    ws.task.currentRound = 1;
    ws.task.rounds = [
      { round: 1, startedAt: "", checks: [], judgeVerdict: null, judgeReason: "", action: "judge-requested" },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ] as any;

    runner.resumeTask(ws.id);
    await waitFor(() => ws.task.state === "completed");
    await fs.rm(tmp, { recursive: true, force: true });
  });

  // Test 6 — resume(running) with the WORK_LOCK gone means the worker signalled
  // done while paused → reconcile must run #evaluateWorker (not wait for a hook).
  test("resume (running, WORK_LOCK absent) runs #evaluateWorker", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "strideterm-resume-eval-"));
    const runner = new AgentTaskRunner();
    const ws = runner.createTaskWorkspace({
      state: {},
      description: "Real task",
      cwd: tmp,
      parentWorkspaceId: "",
      maxRounds: 3,
    });
    // Task dir exists but NO WORK_LOCK file (worker removed it = "done") and NO
    // verdict.json (so branch 1 is skipped and we land on the WORK_LOCK branch).
    await fs.mkdir(taskDir(tmp, ws.task.taskId), { recursive: true });

    const deps = createMockDeps([ws]);
    runner.init(deps);
    ws.task.state = "paused";
    ws.task.pausedFromState = "running"; // resumeTo === "running"
    ws.task.promptSent = true;

    runner.resumeTask(ws.id);

    // Reconcile logs the WORK_LOCK-absent decision, then #evaluateWorker runs and
    // logs evaluation-complete after the built-in checks.
    await waitFor(async () => {
      const events = await readTaskLogEvents(tmp, ws.task.taskId);
      return (
        events.some((e) => e.event === "task-resumed-reconcile" && /WORK_LOCK absent/.test(e.detail || "")) &&
        events.some((e) => e.event === "evaluation-complete")
      );
    });
    await fs.rm(tmp, { recursive: true, force: true });
  });
});

describe("Plan 3 — reliability (verified inject, judge cycle, judge rate-limit)", () => {
  // Krok 1 — verified injection.
  test("hook-capable inject sends one Enter and no retry when UserPromptSubmit confirms", async () => {
    const runner = new AgentTaskRunner();
    const ws = runner.createTaskWorkspace({
      state: {},
      description: "",
      cwd: "/tmp/test",
      parentWorkspaceId: "",
      maxRounds: 3,
    });
    const deps = createMockDeps([ws]);
    deps.isSessionHookCapable = () => true;
    runner.init(deps);
    ws.task.state = "paused";
    ws.task.promptSent = false;
    deps.written.length = 0;

    const workerSessionId = `${ws.id}:${ws.task.workerPanelId}`;
    runner.resumeTask(ws.id);
    // First text + Enter go out, then the inject waits for confirmation.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await waitFor(() => deps.written.some((w: any) => w.sessionId === workerSessionId && w.data === "\r"));
    // Provider confirms by firing its UserPromptSubmit hook.
    runner.onUserPromptSubmit(workerSessionId);
    await waitFor(() => ws.task.promptSent === true);

    const enters = deps.written // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .filter((w: any) => w.sessionId === workerSessionId && w.data === "\r");
    expect(enters.length).toBe(1); // confirmed → no re-send
  });

  // Krok 2 — idle_prompt is not a turn boundary.
  test("judge idle_prompt with no verdict does NOT nudge or pause", async () => {
    const runner = new AgentTaskRunner();
    const ws = runner.createTaskWorkspace({
      state: {},
      description: "",
      cwd: "/tmp/test",
      parentWorkspaceId: "",
      maxRounds: 3,
    });
    const deps = createMockDeps([ws]);
    runner.init(deps);
    ws.task.state = "judge-evaluating";
    ws.task.judgeNudged = false;
    ws.task.promptSent = true;
    deps.written.length = 0;

    const judgeSessionId = `${ws.id}:${ws.task.judgePanelId}`;
    runner.onAgentIdle(judgeSessionId, "hook:idle_prompt");
    await new Promise((resolve) => setTimeout(resolve, 60));

    expect(ws.task.judgeNudged).toBe(false);
    expect(ws.task.state).toBe("judge-evaluating");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(deps.written.filter((w: any) => w.sessionId === judgeSessionId).length).toBe(0);
  });

  test("judge Stop with no verdict nudges once (real turn end)", async () => {
    const runner = new AgentTaskRunner();
    const ws = runner.createTaskWorkspace({
      state: {},
      description: "",
      cwd: "/tmp/test",
      parentWorkspaceId: "",
      maxRounds: 3,
    });
    const deps = createMockDeps([ws]);
    runner.init(deps);
    ws.task.state = "judge-evaluating";
    ws.task.judgeNudged = false;
    ws.task.promptSent = true;
    deps.written.length = 0;

    const judgeSessionId = `${ws.id}:${ws.task.judgePanelId}`;
    runner.onAgentIdle(judgeSessionId, "hook:stop");
    await waitFor(() => ws.task.judgeNudged === true);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(deps.written.some((w: any) => w.sessionId === judgeSessionId)).toBe(true);
  });

  // Krok 9 — judge rate-limit handling.
  test("judge rate-limit presses Enter on the dialog and holds verdict reading", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "strideterm-judge-rl-"));
    const runner = new AgentTaskRunner();
    const ws = runner.createTaskWorkspace({
      state: {},
      description: "",
      cwd: tmp,
      parentWorkspaceId: "",
      maxRounds: 3,
    });
    await fs.mkdir(taskDir(tmp, ws.task.taskId), { recursive: true });
    const deps = createMockDeps([ws]);
    runner.init(deps);
    ws.task.state = "judge-evaluating";
    ws.task.judgeNudged = false;
    ws.task.promptSent = true;
    const judgeSessionId = `${ws.id}:${ws.task.judgePanelId}`;
    deps.written.length = 0;

    const handled = runner.onAgentRateLimited(
      judgeSessionId,
      { resetAt: new Date(Date.now() + 3_600_000), needsConfirm: true, providerHint: "claude" },
      "test",
    );
    expect(handled).toBe(true);
    // Enter pressed so the dialog turn ends.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(deps.written.some((w: any) => w.sessionId === judgeSessionId && w.data === "\r")).toBe(true);

    // Verdict still missing + hold active → a Stop must NOT nudge.
    deps.written.length = 0;
    runner.onAgentIdle(judgeSessionId, "hook:stop");
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(ws.task.judgeNudged).toBe(false);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(deps.written.filter((w: any) => w.sessionId === judgeSessionId).length).toBe(0);
    await fs.rm(tmp, { recursive: true, force: true });
  });

  test("judge rate-limit with a verdict already on disk processes it immediately", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "strideterm-judge-rl-verdict-"));
    const runner = new AgentTaskRunner();
    const ws = runner.createTaskWorkspace({
      state: {},
      description: "",
      cwd: tmp,
      parentWorkspaceId: "",
      maxRounds: 3,
    });
    await fs.mkdir(taskDir(tmp, ws.task.taskId), { recursive: true });
    await fs.writeFile(
      path.join(taskDir(tmp, ws.task.taskId), VERDICT_FILE),
      JSON.stringify({ verdict: "complete", reason: "Looks done." }),
    );
    const deps = createMockDeps([ws]);
    runner.init(deps);
    ws.task.state = "judge-evaluating";
    ws.task.promptSent = true;
    ws.task.currentRound = 1;
    ws.task.rounds = [
      { round: 1, startedAt: "", checks: [], judgeVerdict: null, judgeReason: "", action: "judge-requested" },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ] as any;
    const judgeSessionId = `${ws.id}:${ws.task.judgePanelId}`;

    runner.onAgentRateLimited(
      judgeSessionId,
      { resetAt: new Date(Date.now() + 3_600_000), needsConfirm: true, providerHint: "claude" },
      "test",
    );
    // A verdict is on disk — the next Stop processes it regardless of the hold.
    runner.onAgentIdle(judgeSessionId, "hook:stop");
    await waitFor(() => ws.task.state === "completed");
    await fs.rm(tmp, { recursive: true, force: true });
  });

  // Krok 1 — the missing-confirmation → retry path (complements the confirm test above).
  test("hook-capable inject re-sends Enter and logs unconfirmed when no UserPromptSubmit arrives", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "strideterm-inject-retry-"));
    const prevTimeout = AgentTaskRunner.SUBMIT_CONFIRM_TIMEOUT_MS;
    AgentTaskRunner.SUBMIT_CONFIRM_TIMEOUT_MS = 50; // keep the 3-attempt path fast
    const runner = new AgentTaskRunner();
    try {
      const ws = runner.createTaskWorkspace({
        state: {},
        description: "Short task",
        cwd: tmp,
        parentWorkspaceId: "",
        maxRounds: 3,
        workerProvider: { providerId: "claude", model: "sonnet" }, // paste style
      });
      await fs.mkdir(taskDir(tmp, ws.task.taskId), { recursive: true });

      const deps = createMockDeps([ws]);
      deps.isSessionHookCapable = () => true; // hook-capable → verified-inject path
      runner.init(deps);
      ws.task.state = "paused";
      ws.task.promptSent = false;
      deps.written.length = 0;

      const workerSessionId = `${ws.id}:${ws.task.workerPanelId}`;
      runner.resumeTask(ws.id);

      // Confirmation never arrives → the inject re-sends Enter MAX_RESUBMITS times,
      // then records prompt-submit-unconfirmed.
      await waitFor(async () => {
        const events = await readTaskLogEvents(tmp, ws.task.taskId);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return events.some((e: any) => e.event === "prompt-submit-unconfirmed");
      });

      // Initial submit Enter (attempt 0) + MAX_RESUBMITS re-sends, none confirmed.
      const enters = deps.written // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .filter((w: any) => w.sessionId === workerSessionId && w.data === "\r");
      expect(enters.length).toBe(1 + AgentTaskRunner.MAX_RESUBMITS);
      expect(ws.task.promptSent).toBe(true);
    } finally {
      AgentTaskRunner.SUBMIT_CONFIRM_TIMEOUT_MS = prevTimeout;
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  // Krok 5 — an unconsumed verdict is logged (verdict-discarded), not blind-cleared.
  test("evaluateWorkerBody logs verdict-discarded for an unconsumed verdict before a fresh judge run", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "strideterm-verdict-discard-"));
    const runner = new AgentTaskRunner();
    try {
      const ws = runner.createTaskWorkspace({
        state: {},
        description: "Real task",
        cwd: tmp,
        parentWorkspaceId: "",
        maxRounds: 3,
      });
      const dir = taskDir(tmp, ws.task.taskId);
      await fs.mkdir(dir, { recursive: true });
      // Checks pass: no WORK_LOCK, TODO sections empty.
      await fs.writeFile(
        path.join(dir, TODO_FILE),
        "# TODO\n\n## To Do\n\n## In Progress\n\n## Blocked\n\n## Done\n",
        "utf8",
      );
      // A judge wrote a verdict that was never consumed (e.g. it landed during a pause).
      await fs.writeFile(
        path.join(dir, VERDICT_FILE),
        JSON.stringify({ verdict: "continue", reason: "leftover from a previous round" }),
        "utf8",
      );

      const deps = createMockDeps([ws]);
      runner.init(deps);
      ws.task.state = "running";
      ws.task.promptSent = true;
      ws.task.currentRound = 1;

      const workerSessionId = `${ws.id}:${ws.task.workerPanelId}`;
      runner.onAgentIdle(workerSessionId, "hook:stop");

      // The discard is logged (so an hour of judge work isn't lost silently)…
      await waitFor(async () => {
        const events = await readTaskLogEvents(tmp, ws.task.taskId);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return events.some((e: any) => e.event === "verdict-discarded");
      });
      const events = await readTaskLogEvents(tmp, ws.task.taskId);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const discarded = events.find((e: any) => e.event === "verdict-discarded");
      expect(discarded.detail).toContain("continue");
      // …and the stale verdict is then cleared so the fresh judge run starts clean.
      await waitFor(() =>
        fs
          .access(path.join(dir, VERDICT_FILE))
          .then(() => false)
          .catch(() => true),
      );
      // Let the judge phase settle so teardown doesn't race the eval flow.
      await waitFor(() => ws.task.state === "judge-evaluating", { timeoutMs: 8000 });
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  // Krok 8 — fs.watch backstop processes a verdict written without an idle hook.
  test("watcher backstop processes a verdict.json written with no judge idle hook", async () => {
    const prevGrace = AgentTaskRunner.WATCH_VERDICT_GRACE_MS;
    AgentTaskRunner.WATCH_VERDICT_GRACE_MS = 50; // short grace for the test
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "strideterm-watch-verdict-"));
    const runner = new AgentTaskRunner();
    try {
      const ws = runner.createTaskWorkspace({
        state: {},
        description: "Real task",
        cwd: tmp,
        parentWorkspaceId: "",
        maxRounds: 3,
      });
      const dir = taskDir(tmp, ws.task.taskId);
      await fs.mkdir(dir, { recursive: true });
      // Checks pass → judge gets invoked → state becomes judge-evaluating and the
      // watcher arms over the task dir.
      await fs.writeFile(
        path.join(dir, TODO_FILE),
        "# TODO\n\n## To Do\n\n## In Progress\n\n## Blocked\n\n## Done\n",
        "utf8",
      );

      const deps = createMockDeps([ws]);
      runner.init(deps);
      ws.task.state = "running";
      ws.task.promptSent = true;
      ws.task.currentRound = 1;

      const workerSessionId = `${ws.id}:${ws.task.workerPanelId}`;
      runner.onAgentIdle(workerSessionId, "hook:stop");
      await waitFor(() => ws.task.state === "judge-evaluating");

      // The judge writes a verdict but NO idle hook fires (incident C: judge stuck
      // at a rate-limit dialog). Only the watcher can rescue it.
      await fs.writeFile(
        path.join(dir, VERDICT_FILE),
        JSON.stringify({ verdict: "complete", reason: "All good." }),
        "utf8",
      );

      await waitFor(() => ws.task.state === "completed", { timeoutMs: 8000 });
      const events = await readTaskLogEvents(tmp, ws.task.taskId);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect(events.some((e: any) => e.event === "watcher-verdict")).toBe(true);
    } finally {
      AgentTaskRunner.WATCH_VERDICT_GRACE_MS = prevGrace;
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  // Krok 8 — when the idle hook arrives first, the watcher must NOT double-process.
  test("watcher backstop does not duplicate a verdict already handled by an idle hook", async () => {
    const prevGrace = AgentTaskRunner.WATCH_VERDICT_GRACE_MS;
    AgentTaskRunner.WATCH_VERDICT_GRACE_MS = 50;
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "strideterm-watch-dup-"));
    const runner = new AgentTaskRunner();
    try {
      const ws = runner.createTaskWorkspace({
        state: {},
        description: "Real task",
        cwd: tmp,
        parentWorkspaceId: "",
        maxRounds: 3,
      });
      const dir = taskDir(tmp, ws.task.taskId);
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(
        path.join(dir, TODO_FILE),
        "# TODO\n\n## To Do\n\n## In Progress\n\n## Blocked\n\n## Done\n",
        "utf8",
      );

      const deps = createMockDeps([ws]);
      runner.init(deps);
      ws.task.state = "running";
      ws.task.promptSent = true;
      ws.task.currentRound = 1;

      const workerSessionId = `${ws.id}:${ws.task.workerPanelId}`;
      runner.onAgentIdle(workerSessionId, "hook:stop");
      await waitFor(() => ws.task.state === "judge-evaluating");

      // Verdict written AND the idle hook fires immediately → the hook processes it.
      await fs.writeFile(
        path.join(dir, VERDICT_FILE),
        JSON.stringify({ verdict: "complete", reason: "All good." }),
        "utf8",
      );
      const judgeSessionId = `${ws.id}:${ws.task.judgePanelId}`;
      runner.onAgentIdle(judgeSessionId, "hook:stop");
      await waitFor(() => ws.task.state === "completed");

      // Let the (debounced 500ms + 50ms grace) watcher window elapse; it must
      // re-check disk/state and no-op since the round is already judged.
      await new Promise((resolve) => setTimeout(resolve, 800));
      const events = await readTaskLogEvents(tmp, ws.task.taskId);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const verdictEvents = events.filter((e: any) => e.event === "judge-verdict");
      expect(verdictEvents.length).toBe(1); // processed exactly once
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect(events.some((e: any) => e.event === "watcher-verdict")).toBe(false);
    } finally {
      AgentTaskRunner.WATCH_VERDICT_GRACE_MS = prevGrace;
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  // Krok 11 — the shower directive goes through #injectPrompt, so it respects the
  // per-provider injection strategy (Copilot = type style, char-by-char).
  test("shower directive is injected via #injectPrompt with the per-provider strategy", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "strideterm-shower-inject-"));
    const runner = new AgentTaskRunner();
    try {
      const ws = runner.createTaskWorkspace({
        state: {},
        description: "Real task",
        cwd: tmp,
        parentWorkspaceId: "",
        maxRounds: 5,
        workerProvider: { providerId: "copilot", model: "gpt-5.4" }, // type style
      });
      const dir = taskDir(tmp, ws.task.taskId);
      await fs.mkdir(dir, { recursive: true });
      // WORK_LOCK present → checks fail → re-prompt branch; showerInterval forces
      // a shower this round. Pre-write the handoff so the shower wait resolves.
      await fs.writeFile(path.join(dir, WORK_LOCK_FILE), "work remains", "utf8");
      await fs.writeFile(path.join(dir, HANDOFF_FILE), "## Handoff\nProgress so far.", "utf8");

      const deps = createMockDeps([ws]);
      runner.init(deps);
      ws.task.state = "running";
      ws.task.promptSent = true;
      ws.task.currentRound = 1;
      ws.task.showerInterval = 1; // shower every round
      ws.task.lastShowerRound = 0;
      deps.written.length = 0;

      const workerSessionId = `${ws.id}:${ws.task.workerPanelId}`;
      runner.onAgentIdle(workerSessionId, "hook:stop");

      // The directive is streamed character-by-character (type style). Wait
      // until enough has been typed to spell out the SHOWER_REQUEST reference.
      await waitFor(
        () => {
          const reconstructed = deps.written // eslint-disable-next-line @typescript-eslint/no-explicit-any
            .filter((w: any) => w.sessionId === workerSessionId)
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            .map((w: any) => w.data)
            .join("");
          return reconstructed.includes("SHOWER_REQUEST");
        },
        { timeoutMs: 10000 },
      );
      const writes = deps.written // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .filter((w: any) => w.sessionId === workerSessionId);
      // Many single-char writes, never one bulk write — proves type style was
      // used. The old raw write would have been one bulk write regardless of
      // provider, so this is what distinguishes "via #injectPrompt" from before.
      expect(writes.length).toBeGreaterThan(12);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const bulk = writes.find((w: any) => typeof w.data === "string" && w.data.length > 5);
      expect(bulk).toBeUndefined();

      // Let the shower complete before teardown so no async touches a removed dir.
      await waitFor(() => ws.task.lastShowerRound === ws.task.currentRound, { timeoutMs: 20000 });
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  }, 25000);

  // Krok 12 — judge-requested → pause → resume must reactivate the same-round chip,
  // not push a duplicate (the "ROUNDS 1 1" bug).
  test("ensureRunningRound reactivates the same-round chip after pause/resume (no duplicate)", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "strideterm-round-dup-"));
    const runner = new AgentTaskRunner();
    try {
      const ws = runner.createTaskWorkspace({
        state: {},
        description: "Real task",
        cwd: tmp,
        parentWorkspaceId: "",
        maxRounds: 3,
      });
      const dir = taskDir(tmp, ws.task.taskId);
      await fs.mkdir(dir, { recursive: true });
      // WORK_LOCK present → re-prompt branch (fast, no judge/clear); no shower.
      await fs.writeFile(path.join(dir, WORK_LOCK_FILE), "work remains", "utf8");

      const deps = createMockDeps([ws]);
      runner.init(deps);
      // Round 1 ended judge-requested; the task was then paused (incident A).
      ws.task.currentRound = 1;
      ws.task.showerInterval = 0; // disable shower
      ws.task.promptSent = true;
      ws.task.state = "paused";
      ws.task.pausedFromState = "judge-evaluating";
      ws.task.rounds = [
        {
          round: 1,
          startedAt: new Date().toISOString(),
          checks: [],
          judgeVerdict: null,
          judgeReason: "",
          action: "judge-requested",
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ] as any;
      deps.written.length = 0;

      const workerSessionId = `${ws.id}:${ws.task.workerPanelId}`;
      runner.resumeTask(ws.id); // → re-run evaluation → ensureRunningRound

      // Wait until eval finishes re-prompting the worker: the round settles back
      // to "running" (set right after the re-prompt inject) with state "running".
      await waitFor(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        () => ws.task.state === "running" && (ws.task.rounds[0] as any)?.action === "running",
      );
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect(deps.written.some((w: any) => w.sessionId === workerSessionId)).toBe(true);

      // Exactly one chip for round 1 — reactivated, not duplicated.
      expect(ws.task.rounds.length).toBe(1);
      expect(ws.task.rounds[0].round).toBe(1);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  // Krok 2 / Test 3 — once nudged, a real Stop while the judge is provably busy
  // must NOT give up and pause (premature pause was incident A).
  test("judge busy at verdict-missing give-up does NOT pause", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "strideterm-judge-busy-"));
    const runner = new AgentTaskRunner();
    try {
      const ws = runner.createTaskWorkspace({
        state: {},
        description: "Real task",
        cwd: tmp,
        parentWorkspaceId: "",
        maxRounds: 3,
      });
      await fs.mkdir(taskDir(tmp, ws.task.taskId), { recursive: true });
      const deps = createMockDeps([ws]);
      const judgeSessionId = `${ws.id}:${ws.task.judgePanelId}`;
      deps.isSessionBusy = (sid: string) => sid === judgeSessionId; // judge still working
      runner.init(deps);
      ws.task.state = "judge-evaluating";
      ws.task.judgeNudged = true; // already nudged; this is the give-up gate
      ws.task.promptSent = true;

      // Real Stop, verdict still missing, but judge is busy → keep waiting.
      runner.onAgentIdle(judgeSessionId, "hook:stop");
      await new Promise((resolve) => setTimeout(resolve, 80));
      expect(ws.task.state).toBe("judge-evaluating"); // not paused
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  // Krok 3 / Test 5 — resume from paused(judge-evaluating) with no verdict re-runs
  // the evaluation and injects a fresh, self-contained JUDGE prompt (not a nudge,
  // not a worker re-prompt) because the checks pass (WORK_LOCK is gone).
  test("resume from judge-evaluating with no verdict re-injects a fresh judge prompt", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "strideterm-resume-judge-prompt-"));
    const runner = new AgentTaskRunner();
    try {
      const ws = runner.createTaskWorkspace({
        state: {},
        description: "Real task",
        cwd: tmp,
        parentWorkspaceId: "",
        maxRounds: 3,
      });
      const dir = taskDir(tmp, ws.task.taskId);
      await fs.mkdir(dir, { recursive: true });
      // Checks pass: no WORK_LOCK, empty TODO sections. No verdict on disk.
      await fs.writeFile(
        path.join(dir, TODO_FILE),
        "# TODO\n\n## To Do\n\n## In Progress\n\n## Blocked\n\n## Done\n",
        "utf8",
      );

      const deps = createMockDeps([ws]);
      runner.init(deps);
      ws.task.currentRound = 1;
      ws.task.promptSent = true;
      ws.task.state = "paused";
      ws.task.pausedFromState = "judge-evaluating";
      ws.task.rounds = [
        {
          round: 1,
          startedAt: new Date().toISOString(),
          checks: [],
          judgeVerdict: null,
          judgeReason: "",
          action: "judge-requested",
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ] as any;
      deps.written.length = 0;

      const workerSessionId = `${ws.id}:${ws.task.workerPanelId}`;
      const judgeSessionId = `${ws.id}:${ws.task.judgePanelId}`;
      runner.resumeTask(ws.id);

      // The judge session receives a fresh prompt and the task lands in
      // judge-evaluating — i.e. the evaluation was re-run, not a context-less nudge.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await waitFor(() => deps.written.some((w: any) => w.sessionId === judgeSessionId), { timeoutMs: 8000 });
      await waitFor(() => ws.task.state === "judge-evaluating", { timeoutMs: 8000 });
      // The worker is NOT re-prompted (checks passed → judge, not worker).
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect(deps.written.some((w: any) => w.sessionId === workerSessionId)).toBe(false);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  // Krok 9b / Test 12b — when the judge rate-limit hold expires and the verdict is
  // still missing, the judge is re-prompted to continue its evaluation.
  test("judge rate-limit resume re-injects a continue-evaluation prompt when the verdict is missing", async () => {
    const prevMargin = AgentTaskRunner.RATE_LIMIT_RESUME_MARGIN_MS;
    AgentTaskRunner.RATE_LIMIT_RESUME_MARGIN_MS = 30; // fire the scheduled resume fast
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "strideterm-judge-rl-resume-"));
    const runner = new AgentTaskRunner();
    try {
      const ws = runner.createTaskWorkspace({
        state: {},
        description: "Real task",
        cwd: tmp,
        parentWorkspaceId: "",
        maxRounds: 3,
      });
      await fs.mkdir(taskDir(tmp, ws.task.taskId), { recursive: true });
      const deps = createMockDeps([ws]);
      runner.init(deps);
      ws.task.state = "judge-evaluating";
      ws.task.promptSent = true;
      const judgeSessionId = `${ws.id}:${ws.task.judgePanelId}`;

      runner.onAgentRateLimited(
        judgeSessionId,
        { resetAt: new Date(Date.now() + 10), needsConfirm: true, providerHint: "claude" },
        "test",
      );
      deps.written.length = 0; // drop the Enter press; watch only the resume inject

      // Hold expires (margin shortened) → no verdict on disk → continue-eval re-inject.
      await waitFor(
        () =>
          deps.written.some(
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (w: any) =>
              w.sessionId === judgeSessionId &&
              typeof w.data === "string" &&
              w.data.includes("Continue your evaluation"),
          ),
        { timeoutMs: 4000 },
      );
      expect(ws.task.state).toBe("judge-evaluating");
    } finally {
      AgentTaskRunner.RATE_LIMIT_RESUME_MARGIN_MS = prevMargin;
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  // Krok 9b — the judge shares the worker's retry cap + hard-stop via a per-role
  // #rateLimitCtx. After MAX_RATE_LIMIT_RETRIES consecutive judge limit hits the
  // task pauses from judge-evaluating with an urgent alert (no infinite re-prompt).
  test("judge rate-limit retry cap pauses the task after MAX consecutive hits", async () => {
    const prevMargin = AgentTaskRunner.RATE_LIMIT_RESUME_MARGIN_MS;
    AgentTaskRunner.RATE_LIMIT_RESUME_MARGIN_MS = 20; // fire each scheduled resume fast
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "strideterm-judge-rl-cap-"));
    const runner = new AgentTaskRunner();
    try {
      const ws = runner.createTaskWorkspace({
        state: {},
        description: "Real task",
        cwd: tmp,
        parentWorkspaceId: "",
        maxRounds: 3,
      });
      await fs.mkdir(taskDir(tmp, ws.task.taskId), { recursive: true }); // verdict stays missing
      const deps = createMockDeps([ws]);
      runner.init(deps);
      ws.task.state = "judge-evaluating";
      ws.task.promptSent = true;
      const judgeSessionId = `${ws.id}:${ws.task.judgePanelId}`;

      // Each hit increments the judge retry counter; the scheduled resume between
      // hits clears the judge timer so the next hit counts as a fresh retry. The
      // (MAX+1)th hit trips the cap.
      for (let i = 1; i <= AgentTaskRunner.MAX_RATE_LIMIT_RETRIES + 1; i++) {
        runner.onAgentRateLimited(
          judgeSessionId,
          { resetAt: new Date(Date.now() + 10), needsConfirm: true, providerHint: "claude" },
          "test",
        );
        if (ws.task.state === "paused") break;
        await new Promise((r) => setTimeout(r, 200));
      }

      expect(ws.task.state).toBe("paused");
      // Krok 4 — paused from judge-evaluating so a Continue reads the verdict.
      expect(ws.task.pausedFromState).toBe("judge-evaluating");
      // raiseTaskAlert maps failed → urgent alert with detail "task-failed: ...".
      const failed = deps.alerts.find(
        (a: { detail: string; urgency: string }) =>
          a.urgency === "urgent" && typeof a.detail === "string" && a.detail.startsWith("task-failed"),
      );
      expect(failed).toBeDefined();
    } finally {
      AgentTaskRunner.RATE_LIMIT_RESUME_MARGIN_MS = prevMargin;
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  // Krok 9c — detection-independent backstop: a run of near-instant worker turns
  // ("Cogitated/Worked for 0s") logs a heuristic warning even without detection.
  test("worker short-turn streak logs a heuristic rate-limit warning", async () => {
    const prevMs = AgentTaskRunner.SHORT_WORKER_TURN_MS;
    AgentTaskRunner.SHORT_WORKER_TURN_MS = 60_000; // any quick test turn counts as "short"
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "strideterm-short-turns-"));
    const runner = new AgentTaskRunner();
    try {
      const ws = runner.createTaskWorkspace({
        state: {},
        description: "Real task",
        cwd: tmp,
        parentWorkspaceId: "",
        maxRounds: 99,
      });
      const dir = taskDir(tmp, ws.task.taskId);
      await fs.mkdir(dir, { recursive: true });
      // WORK_LOCK present → checks fail → worker re-prompt loop (no judge, no shower).
      await fs.writeFile(path.join(dir, WORK_LOCK_FILE), "work remains", "utf8");
      const deps = createMockDeps([ws]);
      runner.init(deps);
      ws.task.state = "running";
      ws.task.promptSent = true;
      ws.task.currentRound = 1;
      ws.task.showerInterval = 0;
      const workerSessionId = `${ws.id}:${ws.task.workerPanelId}`;

      // Drive several quick worker turns; each idle → eval → re-prompt → next idle.
      // Wait for the full cycle (re-prompt written, then state back to "running")
      // so the next idle isn't swallowed mid-evaluation.
      for (let i = 0; i < 6; i++) {
        const before = deps.written // eslint-disable-next-line @typescript-eslint/no-explicit-any
          .filter((w: any) => w.sessionId === workerSessionId).length;
        runner.onAgentIdle(workerSessionId, "hook:stop");
        await waitFor(
          () =>
            deps.written // eslint-disable-next-line @typescript-eslint/no-explicit-any
              .filter((w: any) => w.sessionId === workerSessionId).length > before,
          { timeoutMs: 5000 },
        );
        await waitFor(() => ws.task.state === "running", { timeoutMs: 5000 });
        await new Promise((resolve) => setTimeout(resolve, 30)); // let #evaluating release
      }

      const events = await readTaskLogEvents(tmp, ws.task.taskId);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect(events.some((e: any) => e.event === "worker-short-turns")).toBe(true);
    } finally {
      AgentTaskRunner.SHORT_WORKER_TURN_MS = prevMs;
      await fs.rm(tmp, { recursive: true, force: true });
    }
  }, 20000);
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

  test("flags the task to clear Worker + Judge context on next start", async () => {
    // Reset by itself doesn't kill agent sessions (we keep them warm to avoid
    // a slow restart), so we mark the task and let startTask emit /clear once
    // — otherwise the agents would re-run with stale memory of the previous
    // attempt, which is confusing especially if the user edited the brief.
    const runner = new AgentTaskRunner();
    const ws = createTaskWorkspace(runner);
    const deps = createMockDeps([ws]);
    runner.init(deps);

    ws.task.state = "completed";
    expect(ws.task.needsContextClear).toBeFalsy();

    const result = await runner.resetTask(ws.id);
    expect(result).toBe(true);
    expect(ws.task.needsContextClear).toBe(true);
  });
});

describe("startTask after reset — context clearing", () => {
  test("emits /clear to both Worker and Judge sessions before injecting the initial prompt, then unsets the flag", async () => {
    const runner = new AgentTaskRunner();
    const ws = createTaskWorkspace(runner);
    // Simulate post-reset state: idle, no rounds, flag set.
    ws.task.state = "idle";
    ws.task.rounds = [];
    ws.task.promptSent = false;
    ws.task.needsContextClear = true;

    const deps = createMockDeps([ws]);
    runner.init(deps);

    await runner.startTask(ws.id);

    const workerSessionId = `${ws.id}:${ws.task.workerPanelId}`;
    const judgeSessionId = `${ws.id}:${ws.task.judgePanelId}`;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const workerWrites = deps.written.filter((w: any) => w.sessionId === workerSessionId);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const judgeWrites = deps.written.filter((w: any) => w.sessionId === judgeSessionId);

    // Both sessions saw `/clear` before any other content.
    expect(workerWrites[0]?.data).toContain("/clear");
    expect(judgeWrites[0]?.data).toContain("/clear");
    // Flag was consumed so a follow-up start (e.g. user runs another task or
    // resumes mid-flight) doesn't double-clear and wipe in-flight context.
    expect(ws.task.needsContextClear).toBe(false);
  });

  test("does NOT clear context on a fresh start (flag never set)", async () => {
    const runner = new AgentTaskRunner();
    const ws = createTaskWorkspace(runner);
    const deps = createMockDeps([ws]);
    runner.init(deps);

    expect(ws.task.needsContextClear).toBeFalsy();
    await runner.startTask(ws.id);

    const workerSessionId = `${ws.id}:${ws.task.workerPanelId}`;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const workerWrites = deps.written.filter((w: any) => w.sessionId === workerSessionId);
    // First write should be the prompt itself (or its file-injection
    // directive), not a `/clear`.
    expect(workerWrites[0]?.data ?? "").not.toContain("/clear");
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

  test("pauses tasks left in refreshing state", () => {
    const runner = new AgentTaskRunner();
    const ws = createTaskWorkspace(runner);
    ws.task.state = "refreshing";

    const deps = createMockDeps([ws]);
    runner.init(deps);

    expect(ws.task.state).toBe("paused");
  });

  test("records pausedFromState so resume returns to the right phase", () => {
    const runner = new AgentTaskRunner();
    const judgeWs = createTaskWorkspace(runner);
    const workerWs = createTaskWorkspace(runner);
    judgeWs.task.state = "judge-evaluating";
    workerWs.task.state = "running";

    const deps = createMockDeps([judgeWs, workerWs]);
    runner.init(deps);

    // Both are paused, but pausedFromState lets resumeTask drop back into the
    // correct phase — judge resumes to judge-evaluating, worker to running.
    expect(judgeWs.task.pausedFromState).toBe("judge-evaluating");
    expect(workerWs.task.pausedFromState).toBe("running");
  });

  test("getStartupRecoveryCandidates returns one record per recovered task", () => {
    const runner = new AgentTaskRunner();
    const a = createTaskWorkspace(runner);
    const b = createTaskWorkspace(runner);
    const inert = createTaskWorkspace(runner);
    a.task.state = "running";
    a.task.currentRound = 2;
    a.task.maxRounds = 7;
    b.task.state = "judge-evaluating";
    b.task.currentRound = 5;
    b.task.maxRounds = 8;
    inert.task.state = "completed";

    const deps = createMockDeps([a, b, inert]);
    runner.init(deps);

    const candidates = runner.getStartupRecoveryCandidates();
    expect(candidates).toHaveLength(2);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const byWs = new Map<string, any>(candidates.map((c: any) => [c.workspaceId, c]));
    const ca = byWs.get(a.id);
    expect(ca).toBeDefined();
    expect(ca.taskId).toBe(a.task.taskId);
    expect(ca.previousState).toBe("running");
    expect(ca.currentRound).toBe(2);
    expect(ca.maxRounds).toBe(7);
    expect(ca.profileId).toBe("default");

    const cb = byWs.get(b.id);
    expect(cb.previousState).toBe("judge-evaluating");
    expect(cb.currentRound).toBe(5);
  });
});

describe("extractTaskDescription", () => {
  test("extracts description between header and Verification section", () => {
    const md = `# Task

> Created: 2026-04-26 12:00:00 | Project: /tmp/x

Build the user login form.

Make sure errors are inline.

## Verification before completion

> Auto-detected from your project.

- [ ] Run \`npm test\` — must pass

## Rules

- Commit your work
`;
    expect(extractTaskDescription(md)).toBe("Build the user login form.\n\nMake sure errors are inline.");
  });

  test("returns empty string for the no-description placeholder", () => {
    const md = `# Task

> Created: 2026-04-26 12:00:00 | Project: /tmp/x

> No task description provided. Instruct the Worker directly in the terminal,
> or write your task here and press Start.

## Verification before completion

> ...
`;
    expect(extractTaskDescription(md)).toBe("");
  });

  test("falls back to Rules marker when Verification section is removed", () => {
    const md = `# Task

> Created: 2026-04-26 12:00:00 | Project: /tmp/x

Direct task body without verification section.

## Rules

- Commit your work
`;
    expect(extractTaskDescription(md)).toBe("Direct task body without verification section.");
  });

  test("returns full body when no system markers are present", () => {
    const md = `# Task

> Created: 2026-04-26 12:00:00 | Project: /tmp/x

Just the description, nothing else.`;
    expect(extractTaskDescription(md)).toBe("Just the description, nothing else.");
  });

  test("returns empty string for empty input", () => {
    expect(extractTaskDescription("")).toBe("");
  });
});

describe("startTask refreshes description from TASK.md", () => {
  test("uses the on-disk description when the user edits TASK.md after Reset", async () => {
    // Regression: pressing Reset → editing the Assignment tab → pressing Start
    // sent the worker the ORIGINAL description because task.description in
    // memory never picked up the file edit. The fix re-reads TASK.md and
    // updates task.description before building the prompt.
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "strideterm-start-refresh-"));
    try {
      // Pre-create .git so ensureGitRepo skips real git operations
      await fs.mkdir(path.join(tmp, ".git"), { recursive: true });

      const localRunner = new AgentTaskRunner();
      const ws = createTaskWorkspace(localRunner, { cwd: tmp, description: "Original task description" });

      const dir = taskDir(tmp, ws.task.taskId);
      await fs.mkdir(dir, { recursive: true });
      // Simulate the user rewriting TASK.md via the Assignment tab.
      const newTaskMd = `# Task

> Created: 2026-04-26 12:00:00 | Project: ${tmp}

Brand new task — implement feature Y instead.

## Verification before completion

- [ ] Run \`npm test\` — must pass

## Rules

- Commit your work
`;
      await fs.writeFile(path.join(dir, TASK_FILE), newTaskMd, "utf8");

      const localDeps = createMockDeps([ws]);
      localRunner.init(localDeps);

      // Idle → start
      ws.task.state = "idle";

      const result = await localRunner.startTask(ws.id);
      expect(result).toBe(true);
      expect(ws.task.description).toBe("Brand new task — implement feature Y instead.");
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  test("keeps in-memory description when TASK.md is missing", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "strideterm-start-no-task-"));
    try {
      await fs.mkdir(path.join(tmp, ".git"), { recursive: true });

      const localRunner = new AgentTaskRunner();
      const ws = createTaskWorkspace(localRunner, { cwd: tmp, description: "Original task description" });

      // No task dir, no TASK.md
      const localDeps = createMockDeps([ws]);
      localRunner.init(localDeps);

      ws.task.state = "idle";
      const result = await localRunner.startTask(ws.id);
      expect(result).toBe(true);
      // Stale description preserved — better than wiping it to empty.
      expect(ws.task.description).toBe("Original task description");
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });
});

describe("WORK_LOCK lifecycle across rounds", () => {
  test("recreates WORK_LOCK before re-prompting worker on judge 'continue' verdict", async () => {
    // Regression: when judge says "continue", the runtime re-prompts the
    // worker for round 2 — but the worker had removed WORK_LOCK at the end of
    // round 1 (that's how it signaled completion). Without recreating it,
    // the worker reads an absent lock at round 2 start and concludes the task
    // is already done. Runtime owns the lock between rounds.
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "strideterm-worklock-continue-"));
    try {
      await fs.mkdir(path.join(tmp, ".git"), { recursive: true });

      const localRunner = new AgentTaskRunner();
      const ws = createTaskWorkspace(localRunner, { cwd: tmp });

      const dir = taskDir(tmp, ws.task.taskId);
      await fs.mkdir(dir, { recursive: true });
      // Worker finished round 1: WORK_LOCK removed.
      // Judge wrote a "continue" verdict.
      await fs.writeFile(
        path.join(dir, "verdict.json"),
        JSON.stringify({ verdict: "continue", reason: "Missing test for edge case" }),
        "utf8",
      );

      const localDeps = createMockDeps([ws]);
      localRunner.init(localDeps);

      // Set up state as if worker just stopped and judge just finished writing verdict.
      ws.task.state = "paused";
      ws.task.pausedFromState = "judge-evaluating";
      ws.task.currentRound = 1;
      ws.task.promptSent = true;
      ws.task.rounds = [
        { round: 1, startedAt: new Date().toISOString(), checks: [], judgeVerdict: null, judgeReason: "", action: "" },
      ];

      // resumeTask transitions to judge-evaluating and proactively reads the
      // verdict — which routes through #handleJudgeVerdict's continue path.
      const result = localRunner.resumeTask(ws.id);
      expect(result).toBe(true);

      // #handleJudgeVerdict is fire-and-forget; poll until round 2 has started.
      await waitFor(() => ws.task.currentRound === 2);

      // WORK_LOCK must exist — round 2's worker reads it as the "work remains" signal.
      const lockExists = await fs
        .access(path.join(dir, WORK_LOCK_FILE))
        .then(() => true)
        .catch(() => false);
      expect(lockExists).toBe(true);

      expect(ws.task.currentRound).toBe(2);
      expect(ws.task.state).toBe("running");
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  test("does NOT recreate WORK_LOCK on judge 'complete' verdict", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "strideterm-worklock-complete-"));
    try {
      await fs.mkdir(path.join(tmp, ".git"), { recursive: true });

      const localRunner = new AgentTaskRunner();
      const ws = createTaskWorkspace(localRunner, { cwd: tmp });

      const dir = taskDir(tmp, ws.task.taskId);
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(
        path.join(dir, "verdict.json"),
        JSON.stringify({ verdict: "complete", reason: "All requirements met" }),
        "utf8",
      );

      const localDeps = createMockDeps([ws]);
      localRunner.init(localDeps);

      ws.task.state = "paused";
      ws.task.pausedFromState = "judge-evaluating";
      ws.task.currentRound = 1;
      ws.task.promptSent = true;
      ws.task.rounds = [
        { round: 1, startedAt: new Date().toISOString(), checks: [], judgeVerdict: null, judgeReason: "", action: "" },
      ];

      localRunner.resumeTask(ws.id);
      await waitFor(() => ws.task.state === "completed");

      const lockExists = await fs
        .access(path.join(dir, WORK_LOCK_FILE))
        .then(() => true)
        .catch(() => false);
      expect(lockExists).toBe(false);
      expect(ws.task.state).toBe("completed");
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });
});
