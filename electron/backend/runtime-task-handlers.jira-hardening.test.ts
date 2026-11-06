import { afterEach, describe, expect, it, vi } from "vitest";
import { createTaskHandlers } from "./runtime-task-handlers.js";
import { JiraRequestError } from "./jira/jira-manager.js";
import { createJiraIssueSnapshot } from "./jira/jira-workspace-context.js";
import { remoteViewerId } from "./viewer-id.js";
import type { AppState } from "../shared/types/state.js";

const ref = { provider: "jira" as const, connectionId: "j1", issueId: "7", issueKey: "APP-7" };
const issue = {
  ref,
  summary: "Fix",
  status: "Open",
  issueType: "Task",
  projectKey: "APP",
  updated: "2026-10-23T00:00:00Z",
};

function harness(options: { state?: () => AppState; assertNoConflictingActiveTask?: ReturnType<typeof vi.fn> } = {}) {
  const base = { settings: { integrations: {} }, workspaces: [], profiles: [{ id: "p1" }] } as unknown as AppState;
  const createTaskWorkspace = vi.fn(() => ({
    id: "task-ws",
    cwd: "C:/repo/app",
    task: { taskId: "task-1" },
  }));
  const startTask = vi.fn(async () => true);
  const assertNoConflictingActiveTask = options.assertNoConflictingActiveTask ?? vi.fn();
  const handlers = createTaskHandlers({
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn() },
    getState: options.state ?? (() => base),
    getPayload: () => ({}),
    broadcastState: vi.fn(),
    store: { mutate: vi.fn() },
    taskRunner: { createTaskWorkspace, startTask, writeInitialFiles: vi.fn(async () => undefined) },
    sessions: {},
    execFileTextImpl: vi.fn(),
    recheckClaudeAvailability: vi.fn(),
    assertWorkspaceInViewerProfile: vi.fn(),
    recordWorkspaceWork: vi.fn(),
    resolveCallerProfileId: vi.fn(() => "p1"),
    assertNoConflictingActiveTask,
    worktreeTreePath: vi.fn(),
    ensureWorktree: vi.fn(),
    getRecoveryCandidates: () => [],
    setRecoveryCandidates: vi.fn(),
    finalizeWorkspaceRemoval: vi.fn(),
  } as unknown as Parameters<typeof createTaskHandlers>[0]);
  const extended = handlers as unknown as Record<string, unknown> & {
    createTaskWorkspace(config: unknown, windowId?: string): Promise<unknown>;
    startTask(workspaceId: string, windowId?: string): Promise<unknown>;
  };
  extended.saveWorkspace = vi.fn(async () => undefined);
  return { handlers: extended, createTaskWorkspace, startTask, assertNoConflictingActiveTask };
}

afterEach(() => vi.useRealTimers());

describe("Jira lookups in task create and start share one 10 s budget", () => {
  it("create fails with a Jira network error before any side effect when Jira does not answer", async () => {
    vi.useFakeTimers();
    const { handlers, createTaskWorkspace } = harness();
    handlers.jiraGetIssue = vi.fn(() => new Promise(() => undefined));
    const outcome = handlers
      .createTaskWorkspace({ cwd: "C:/repo/app", activate: false, jiraIssueRefs: [ref, { ...ref, issueId: "8" }] })
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    await vi.advanceTimersByTimeAsync(10_001);
    const error = (await outcome) as JiraRequestError;
    expect(error).toBeInstanceOf(JiraRequestError);
    expect(error.code).toBe("network");
    expect(error.message).toMatch(/did not answer within the time limit/);
    expect(createTaskWorkspace).not.toHaveBeenCalled();
    // Both fetches were started together, not one after the other.
    expect(handlers.jiraGetIssue).toHaveBeenCalledTimes(2);
  });

  it("start fails the same way and does not start the task", async () => {
    vi.useFakeTimers();
    const state = {
      settings: { integrations: {} },
      profiles: [{ id: "p1" }],
      workspaces: [
        {
          id: "task-ws",
          kind: "task",
          profileId: "p1",
          cwd: "C:/repo/app",
          task: { jiraIssueSnapshots: [createJiraIssueSnapshot(issue)] },
        },
      ],
    } as unknown as AppState;
    const { handlers, startTask } = harness({ state: () => state });
    handlers.jiraGetIssue = vi.fn(() => new Promise(() => undefined));
    const outcome = handlers.startTask("task-ws", "window-1").then(
      () => undefined,
      (error: unknown) => error,
    );
    await vi.advanceTimersByTimeAsync(10_001);
    expect((await outcome) as JiraRequestError).toBeInstanceOf(JiraRequestError);
    expect(startTask).not.toHaveBeenCalled();
  });
});

describe("startTask", () => {
  const taskState = (extra: Record<string, unknown> = {}) =>
    ({
      settings: { integrations: {} },
      profiles: [{ id: "p1" }],
      workspaces: [
        {
          id: "task-ws",
          kind: "task",
          profileId: "p1",
          cwd: "C:/repo/app",
          task: { jiraIssueSnapshots: [createJiraIssueSnapshot(issue)] },
          ...extra,
        },
      ],
    }) as unknown as AppState;

  it("judges the conflict against the state after the Jira lookups, not before them", async () => {
    let current = taskState();
    const later = taskState();
    const { handlers, assertNoConflictingActiveTask } = harness({ state: () => current });
    handlers.jiraGetIssue = vi.fn(async () => {
      current = later;
      return issue;
    });
    await handlers.startTask("task-ws", "window-1");
    expect(assertNoConflictingActiveTask).toHaveBeenCalledTimes(1);
    expect(assertNoConflictingActiveTask.mock.calls[0][0]).toBe(later);
  });

  it("drift-checks a Telegram or MCP start (no window) through the task workspace's own profile", async () => {
    const { handlers, startTask } = harness({ state: () => taskState() });
    handlers.jiraGetIssue = vi.fn(async () => {
      throw new Error("requires a trusted desktop window context");
    });
    handlers.jiraRemoteGetIssue = vi.fn(async () => issue);
    await expect(handlers.startTask("task-ws")).resolves.toMatchObject({ ok: true });
    expect(handlers.jiraGetIssue).not.toHaveBeenCalled();
    expect(handlers.jiraRemoteGetIssue).toHaveBeenCalledWith({ connectionId: "j1", issueId: "7" }, "p1");
    expect(startTask).toHaveBeenCalled();
  });

  it.each([
    ["paused", { state: "paused" }],
    ["failed", { state: "failed" }],
    ["reset", { state: "idle", needsContextClear: true }],
  ])("restarts a %s task without asking Jira, even though the issue changed", async (_label, taskExtra) => {
    const state = taskState();
    Object.assign(state.workspaces[0].task as object, taskExtra);
    const { handlers, startTask } = harness({ state: () => state });
    handlers.jiraGetIssue = vi.fn(async () => ({ ...issue, status: "Done" }));
    handlers.jiraRemoteGetIssue = vi.fn(async () => ({ ...issue, status: "Done" }));
    await expect(handlers.startTask("task-ws", "window-1")).resolves.toMatchObject({ ok: true });
    expect(handlers.jiraGetIssue).not.toHaveBeenCalled();
    expect(handlers.jiraRemoteGetIssue).not.toHaveBeenCalled();
    expect(startTask).toHaveBeenCalled();
  });

  it("still refuses the first start of an idle task whose Jira issue drifted", async () => {
    const state = taskState();
    Object.assign(state.workspaces[0].task as object, { state: "idle" });
    const { handlers, startTask } = harness({ state: () => state });
    handlers.jiraGetIssue = vi.fn(async () => ({ ...issue, status: "Done" }));
    await expect(handlers.startTask("task-ws", "window-1")).rejects.toThrow("Jira task context changed");
    expect(startTask).not.toHaveBeenCalled();
  });

  it("still refuses a start whose Jira issue drifted, with no window", async () => {
    const { handlers, startTask } = harness({ state: () => taskState() });
    handlers.jiraRemoteGetIssue = vi.fn(async () => ({ ...issue, status: "Done" }));
    await expect(handlers.startTask("task-ws")).rejects.toThrow("Jira task context changed");
    expect(startTask).not.toHaveBeenCalled();
  });
});

describe("jiraMcpEnabled on task create", () => {
  const requested = async (windowId: string | undefined) => {
    const { handlers, createTaskWorkspace } = harness();
    await handlers.createTaskWorkspace({ cwd: "C:/repo/app", activate: false, jiraMcpEnabled: true }, windowId);
    return (createTaskWorkspace.mock.calls[0] as unknown as [{ jiraMcpEnabled: boolean }])[0].jiraMcpEnabled;
  };

  it("a desktop window may opt a task in", async () => {
    expect(await requested("window-1")).toBe(true);
  });

  it("a remote viewer, and a caller without a window, never can", async () => {
    expect(await requested(remoteViewerId("session-1"))).toBe(false);
    expect(await requested(undefined)).toBe(false);
  });
});
