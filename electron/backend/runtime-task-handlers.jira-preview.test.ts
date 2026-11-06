import { describe, expect, it, vi } from "vitest";
import { createTaskHandlers } from "./runtime-task-handlers.js";
import type { AppState } from "../shared/types/state.js";
import type { JiraIssue } from "./jira/jira-workspace-context.js";

interface TestHandlers {
  previewJiraTaskContext: (..._args: unknown[]) => Promise<{
    token: string;
    hash: string;
    issues: Array<{ ref: JiraIssue["ref"]; fields: Record<string, unknown> }>;
  }>;
  createTaskWorkspace: (..._args: unknown[]) => Promise<unknown>;
  githubQuickFixListRepos: ReturnType<typeof vi.fn>;
  githubQuickFixListBranches: ReturnType<typeof vi.fn>;
  jiraGetIssue: ReturnType<typeof vi.fn>;
}

describe("Jira task prepare token", () => {
  it("reuses a linked active or prepared task in the same profile before task side effects", async () => {
    const ref = { provider: "jira" as const, connectionId: "j1", issueId: "7", issueKey: "APP-7" };
    const state = {
      settings: { integrations: {} },
      workspaces: [
        {
          id: "existing-task",
          name: "APP-7 development",
          kind: "task",
          profileId: "p1",
          cwd: "C:/repo/app",
          task: { taskId: "task-7", state: "idle", jiraIssueRefs: [ref] },
        },
      ],
      profiles: [{ id: "p1" }],
    } as unknown as AppState;
    const createTaskWorkspace = vi.fn();
    const jiraIssue = {
      ref,
      summary: "Fix",
      status: "Open",
      issueType: "Task",
      projectKey: "APP",
      updated: "2026-10-23T00:00:00Z",
    };
    let resolveIssue!: (_issue: typeof jiraIssue) => void;
    const issueRequest = new Promise<typeof jiraIssue>((resolve) => {
      resolveIssue = resolve;
    });
    const jiraGetIssue = vi.fn(() => issueRequest);
    const handlers = createTaskHandlers({
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn() },
      getState: () => state,
      getPayload: () => ({}),
      broadcastState: vi.fn(),
      store: { mutate: vi.fn() },
      taskRunner: { createTaskWorkspace },
      sessions: {},
      execFileTextImpl: vi.fn(),
      recheckClaudeAvailability: vi.fn(),
      assertWorkspaceInViewerProfile: vi.fn(),
      recordWorkspaceWork: vi.fn(),
      resolveCallerProfileId: vi.fn(() => "p1"),
      assertNoConflictingActiveTask: vi.fn(),
      worktreeTreePath: vi.fn(),
      ensureWorktree: vi.fn(),
      getRecoveryCandidates: () => [],
      setRecoveryCandidates: vi.fn(),
      finalizeWorkspaceRemoval: vi.fn(),
    } as unknown as Parameters<typeof createTaskHandlers>[0]);
    (handlers as unknown as { jiraGetIssue: typeof jiraGetIssue }).jiraGetIssue = jiraGetIssue;

    const create = (config: unknown) =>
      (handlers as unknown as { createTaskWorkspace(_config: unknown): Promise<unknown> }).createTaskWorkspace(config);
    const input = { cwd: "C:/repo/app", activate: false, jiraIssueRefs: [ref] };
    const first = create(input);
    const second = create(input);
    resolveIssue(jiraIssue);
    const [firstResult, secondResult] = (await Promise.all([first, second])) as Array<Record<string, unknown>>;
    expect(firstResult).toMatchObject({
      workspaceId: "existing-task",
      taskId: "task-7",
      reused: true,
      alreadyExists: true,
    });
    expect(secondResult).toMatchObject({
      workspaceId: "existing-task",
      taskId: "task-7",
      reused: true,
      alreadyExists: true,
    });
    expect(createTaskWorkspace).not.toHaveBeenCalled();
  });

  it("does not reuse a task linked to only part of a multi-issue selection", async () => {
    const issueA = { provider: "jira" as const, connectionId: "j1", issueId: "7", issueKey: "APP-7" };
    const issueB = { provider: "jira" as const, connectionId: "j1", issueId: "8", issueKey: "APP-8" };
    const state = {
      settings: { integrations: {} },
      workspaces: [
        {
          id: "existing-task",
          name: "APP-7 development",
          kind: "task",
          profileId: "p1",
          cwd: "C:/repo/app",
          task: { taskId: "task-7", state: "idle", jiraIssueRefs: [issueA] },
        },
      ],
      profiles: [{ id: "p1" }],
    } as unknown as AppState;
    const createTaskWorkspace = vi.fn(() => {
      throw new Error("creation reached after refusing partial match");
    });
    const handlers = createTaskHandlers({
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn() },
      getState: () => state,
      getPayload: () => ({}),
      broadcastState: vi.fn(),
      store: { mutate: vi.fn() },
      taskRunner: { createTaskWorkspace },
      sessions: {},
      execFileTextImpl: vi.fn(),
      recheckClaudeAvailability: vi.fn(),
      assertWorkspaceInViewerProfile: vi.fn(),
      recordWorkspaceWork: vi.fn(),
      resolveCallerProfileId: vi.fn(() => "p1"),
      assertNoConflictingActiveTask: vi.fn(),
      worktreeTreePath: vi.fn(),
      ensureWorktree: vi.fn(),
      getRecoveryCandidates: () => [],
      setRecoveryCandidates: vi.fn(),
      finalizeWorkspaceRemoval: vi.fn(),
    } as unknown as Parameters<typeof createTaskHandlers>[0]);
    (handlers as unknown as { jiraGetIssue: (input: { issueId: string }) => Promise<unknown> }).jiraGetIssue = vi.fn(
      async ({ issueId }) => ({
        ref: issueId === "7" ? issueA : issueB,
        summary: `Fix ${issueId}`,
        status: "Open",
        issueType: "Task",
        projectKey: "APP",
      }),
    );

    await expect(
      (handlers as unknown as { createTaskWorkspace(input: unknown): Promise<unknown> }).createTaskWorkspace({
        cwd: "C:/repo/app",
        activate: false,
        jiraIssueRefs: [issueA, issueB],
      }),
    ).rejects.toThrow("creation reached after refusing partial match");
    expect(createTaskWorkspace).toHaveBeenCalledTimes(1);
  });

  it("prepares from trusted repo and issue data, then rejects a tampered token before side effects", async () => {
    const state = {
      settings: { integrations: { github: { connections: [{ id: "gh1", enabled: true, profileId: "p1" }] } } },
      workspaces: [],
      profiles: [{ id: "p1" }],
    } as unknown as AppState;
    const ensureWorktree = vi.fn(async () => "");
    const execFileTextImpl = vi.fn(async () => ({ stdout: "https://github.com/acme/app.git\n", stderr: "" }));
    const issue: JiraIssue & { description: string } = {
      ref: { provider: "jira", connectionId: "j1", issueId: "7", issueKey: "APP-7" },
      summary: "Fix",
      status: "Open",
      issueType: "Task",
      projectKey: "APP",
      updated: "2026-10-23T00:00:00Z",
      description: "Body",
    };
    const handlers = createTaskHandlers({
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn() },
      getState: () => state,
      getPayload: () => ({}),
      broadcastState: vi.fn(),
      store: { mutate: vi.fn() },
      taskRunner: {},
      sessions: {},
      execFileTextImpl,
      recheckClaudeAvailability: vi.fn(),
      assertWorkspaceInViewerProfile: vi.fn(),
      recordWorkspaceWork: vi.fn(),
      resolveCallerProfileId: vi.fn(() => "p1"),
      assertNoConflictingActiveTask: vi.fn(),
      worktreeTreePath: vi.fn(),
      ensureWorktree,
      getRecoveryCandidates: () => [],
      setRecoveryCandidates: vi.fn(),
      finalizeWorkspaceRemoval: vi.fn(),
    } as unknown as Parameters<typeof createTaskHandlers>[0]) as unknown as TestHandlers;
    handlers.githubQuickFixListRepos = vi.fn(async () => ({
      repositories: [
        { id: "42", owner: "acme", name: "app", remoteUrl: "https://github.com/acme/app.git", defaultBranch: "main" },
      ],
    }));
    handlers.githubQuickFixListBranches = vi.fn(async () => ({ branches: ["main", "feature/jira"] }));
    handlers.jiraGetIssue = vi.fn(async () => ({ ...issue }));

    const prepared = await handlers.previewJiraTaskContext(
      {
        refs: [{ provider: "jira", connectionId: "j1", issueId: "7", issueKey: "APP-7" }],
        repo: {
          provider: "github",
          connectionId: "gh1",
          repoId: "42",
          repoName: "acme/app",
          remoteUrl: "https://github.com/acme/app.git",
          cwd: "C:/repo/app",
        },
        baseBranch: "main",
        branch: "feature/jira",
        checkoutMode: "worktree",
        taskConfig: { description: "Fix APP-7", selectedFields: ["summary", "status"] },
      },
      "window-1",
    );
    expect(prepared.issues).toEqual([
      {
        ref: { provider: "jira", connectionId: "j1", issueId: "7", issueKey: "APP-7" },
        fields: { summary: "Fix", status: "Open" },
      },
    ]);

    const createPayload = {
      cwd: "C:/repo/app",
      description: "Fix APP-7",
      useWorktree: true,
      worktreeBranch: "feature/jira",
      jiraPreparedContext: { token: prepared.token, hash: "tampered" },
      repoBinding: {
        provider: "github",
        connectionId: "gh1",
        repoId: "42",
        repoName: "acme/app",
        remoteUrl: "https://github.com/acme/app.git",
        baseBranch: "main",
        branch: "feature/jira",
        checkoutMode: "worktree",
      },
      jiraIssueRefs: [{ provider: "jira", connectionId: "j1", issueId: "7", issueKey: "APP-7" }],
    };
    await expect(handlers.createTaskWorkspace(createPayload, "window-2")).rejects.toThrow(
      "preview expired or belongs to another window",
    );
    await expect(
      handlers.createTaskWorkspace(
        { ...createPayload, jiraPreparedContext: { token: prepared.token, hash: "tampered" } },
        "window-1",
      ),
    ).rejects.toThrow("preview expired or belongs to another window");
    issue.summary = "Changed after preview";
    await expect(
      handlers.createTaskWorkspace(
        { ...createPayload, jiraPreparedContext: { token: prepared.token, hash: prepared.hash } },
        "window-1",
      ),
    ).rejects.toThrow("issue details changed after preview");
    expect(ensureWorktree).not.toHaveBeenCalled();
    expect(execFileTextImpl).toHaveBeenCalledTimes(1);
    issue.summary = "Fix";
    ensureWorktree.mockRejectedValueOnce(new Error("controlled worktree failure"));
    await expect(
      handlers.createTaskWorkspace(
        { ...createPayload, jiraPreparedContext: { token: prepared.token, hash: prepared.hash } },
        "window-1",
      ),
    ).rejects.toThrow("controlled worktree failure");
    await expect(
      handlers.createTaskWorkspace(
        { ...createPayload, jiraPreparedContext: { token: prepared.token, hash: prepared.hash } },
        "window-1",
      ),
    ).rejects.toThrow("preview expired or belongs to another window");
  });

  it("does not charge slow repository listing against the Jira lookup budget", async () => {
    vi.useFakeTimers();
    try {
      const state = {
        settings: { integrations: { github: { connections: [{ id: "gh1", enabled: true, profileId: "p1" }] } } },
        workspaces: [],
        profiles: [{ id: "p1" }],
      } as unknown as AppState;
      const ensureWorktree = vi.fn(async () => {
        throw new Error("controlled worktree failure");
      });
      const issue = {
        ref: { provider: "jira", connectionId: "j1", issueId: "7", issueKey: "APP-7" },
        summary: "Fix",
        status: "Open",
        issueType: "Task",
        projectKey: "APP",
        updated: "2026-10-23T00:00:00Z",
      };
      const handlers = createTaskHandlers({
        log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn() },
        getState: () => state,
        getPayload: () => ({}),
        broadcastState: vi.fn(),
        store: { mutate: vi.fn() },
        taskRunner: {},
        sessions: {},
        execFileTextImpl: vi.fn(async () => ({ stdout: "https://github.com/acme/app.git\n", stderr: "" })),
        recheckClaudeAvailability: vi.fn(),
        assertWorkspaceInViewerProfile: vi.fn(),
        recordWorkspaceWork: vi.fn(),
        resolveCallerProfileId: vi.fn(() => "p1"),
        assertNoConflictingActiveTask: vi.fn(),
        worktreeTreePath: vi.fn(),
        ensureWorktree,
        getRecoveryCandidates: () => [],
        setRecoveryCandidates: vi.fn(),
        finalizeWorkspaceRemoval: vi.fn(),
      } as unknown as Parameters<typeof createTaskHandlers>[0]) as unknown as TestHandlers;
      let slow = false;
      handlers.githubQuickFixListRepos = vi.fn(async () => {
        if (slow) await new Promise((resolve) => setTimeout(resolve, 11_000));
        return {
          repositories: [
            {
              id: "42",
              owner: "acme",
              name: "app",
              remoteUrl: "https://github.com/acme/app.git",
              defaultBranch: "main",
            },
          ],
        };
      });
      handlers.githubQuickFixListBranches = vi.fn(async () => ({ branches: ["main", "feature/jira"] }));
      handlers.jiraGetIssue = vi.fn(async () => ({ ...issue }));
      (handlers as unknown as { jiraListComments: unknown }).jiraListComments = vi.fn(async () => []);
      const prepared = await handlers.previewJiraTaskContext(
        {
          refs: [issue.ref],
          repo: {
            provider: "github",
            connectionId: "gh1",
            repoId: "42",
            repoName: "acme/app",
            remoteUrl: "https://github.com/acme/app.git",
            cwd: "C:/repo/app",
          },
          baseBranch: "main",
          branch: "feature/jira",
          checkoutMode: "worktree",
          taskConfig: { description: "Fix APP-7", selectedFields: ["summary", "comments"] },
        },
        "window-1",
      );
      slow = true;
      const outcome = handlers
        .createTaskWorkspace(
          {
            cwd: "C:/repo/app",
            description: "Fix APP-7",
            useWorktree: true,
            worktreeBranch: "feature/jira",
            jiraPreparedContext: { token: prepared.token, hash: prepared.hash },
            repoBinding: {
              provider: "github",
              connectionId: "gh1",
              repoId: "42",
              repoName: "acme/app",
              remoteUrl: "https://github.com/acme/app.git",
              baseBranch: "main",
              branch: "feature/jira",
              checkoutMode: "worktree",
            },
            jiraIssueRefs: [issue.ref],
          },
          "window-1",
        )
        .then(
          () => undefined,
          (error: unknown) => error as Error,
        );
      await vi.advanceTimersByTimeAsync(11_001);
      const error = await outcome;
      expect(error?.message).not.toMatch(/time limit/);
      expect(error?.message).toMatch(/controlled worktree failure/);
    } finally {
      vi.useRealTimers();
    }
  });
});
