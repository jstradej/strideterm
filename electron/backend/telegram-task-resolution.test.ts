import { describe, expect, test } from "vitest";
import { resolveTelegramTaskTarget } from "./telegram-task-resolution.js";

interface TestWs {
  id: string;
  name: string;
  cwd: string;
  kind: string;
  review?: { parentWorkspaceId?: string } | null;
  quickfix?: { parentWorkspaceId?: string } | null;
  task?: { parentWorkspaceId?: string } | null;
}

const main: TestWs = {
  id: "ws-main",
  name: "MyProject",
  cwd: "/proj",
  kind: "terminal",
};

const worktree: TestWs = {
  id: "ws-worktree",
  name: "MyProject / fix-bug",
  cwd: "/proj/.strideterm/tree/fix-bug",
  kind: "terminal",
};

const taskInWorktreeViaTelegram: TestWs = {
  // Telegram /task → "Existing worktree" path: the task workspace's
  // parentWorkspaceId points at the MAIN project, but its cwd is the
  // worktree path. This is the shape the user reported as buggy.
  id: "ws-task-via-tg",
  name: "Task: do thing",
  cwd: "/proj/.strideterm/tree/fix-bug",
  kind: "task",
  task: { parentWorkspaceId: "ws-main" },
};

const taskInWorktreeViaUI: TestWs = {
  // Desktop UI "Create task agent" from the worktree workspace: the task
  // workspace's parentWorkspaceId points at the worktree workspace, cwd
  // is the worktree path.
  id: "ws-task-via-ui",
  name: "Task: do other thing",
  cwd: "/proj/.strideterm/tree/fix-bug",
  kind: "task",
  task: { parentWorkspaceId: "ws-worktree" },
};

const taskInMain: TestWs = {
  id: "ws-task-main",
  name: "Task: refactor",
  cwd: "/proj",
  kind: "task",
  task: { parentWorkspaceId: "ws-main" },
};

describe("resolveTelegramTaskTarget", () => {
  test("explicit targetCwd always wins (user picked Existing worktree via /task)", () => {
    const result = resolveTelegramTaskTarget({
      workspaces: [main, worktree],
      sourceWorkspaceId: "ws-main",
      targetCwd: "/proj/.strideterm/tree/fix-bug",
    });
    expect(result.parentWorkspace?.id).toBe("ws-main");
    expect(result.taskCwd).toBe("/proj/.strideterm/tree/fix-bug");
    expect(result.cwdReason).toBe("explicit");
  });

  test("user replies to a completion notification from a task that ran in a worktree (via Telegram /task) — new task continues in the SAME worktree", () => {
    // Reproduces the user's bug report: the previous task's parentWorkspaceId
    // is the main project (because /task wires it that way), but its cwd is
    // the worktree path. Walking up to the main project naively would run
    // the new task in `/proj` instead of the worktree the user was clearly
    // working in. The fix preserves the source workspace's cwd in this case.
    const result = resolveTelegramTaskTarget({
      workspaces: [main, worktree, taskInWorktreeViaTelegram],
      sourceWorkspaceId: "ws-task-via-tg",
    });
    expect(result.parentWorkspace?.id).toBe("ws-main");
    expect(result.taskCwd).toBe("/proj/.strideterm/tree/fix-bug");
    expect(result.cwdReason).toBe("source-overrides-root");
  });

  test("user replies to completion from a task created via desktop UI inside a worktree — new task continues in the same worktree", () => {
    const result = resolveTelegramTaskTarget({
      workspaces: [main, worktree, taskInWorktreeViaUI],
      sourceWorkspaceId: "ws-task-via-ui",
    });
    // Walks up to the worktree workspace itself (which is a proper root
    // since it has no review/quickfix/task fields). Both source.cwd and
    // root.cwd are the worktree path — the new task naturally lands there.
    expect(result.parentWorkspace?.id).toBe("ws-worktree");
    expect(result.taskCwd).toBe("/proj/.strideterm/tree/fix-bug");
    expect(result.cwdReason).toBe("root");
  });

  test("user replies to a task that already ran directly in the main cwd — new task stays in main", () => {
    const result = resolveTelegramTaskTarget({
      workspaces: [main, taskInMain],
      sourceWorkspaceId: "ws-task-main",
    });
    expect(result.parentWorkspace?.id).toBe("ws-main");
    expect(result.taskCwd).toBe("/proj");
    expect(result.cwdReason).toBe("root");
  });

  test("source workspace not found returns parentWorkspace=null", () => {
    const result = resolveTelegramTaskTarget({
      workspaces: [main],
      sourceWorkspaceId: "ws-missing",
    });
    expect(result.parentWorkspace).toBeNull();
    expect(result.taskCwd).toBe("");
    expect(result.cwdReason).toBe("none");
  });

  test("falls back to source workspace when no proper root can be walked up to (e.g. PR review at the top of the chain)", () => {
    const reviewWs: TestWs = {
      id: "ws-review",
      name: "Review: PR #1",
      cwd: "/proj/reviews/pr-1",
      kind: "terminal",
      review: { parentWorkspaceId: "" },
    };
    const result = resolveTelegramTaskTarget({
      workspaces: [reviewWs],
      sourceWorkspaceId: "ws-review",
    });
    // Resolves to the review workspace itself — better than failing outright.
    expect(result.parentWorkspace?.id).toBe("ws-review");
    expect(result.taskCwd).toBe("/proj/reviews/pr-1");
  });

  test("inbox workspaces (azure/github) are never picked as roots — walks past them", () => {
    const azureInbox: TestWs = {
      id: "ws-azure",
      name: "Azure",
      cwd: "",
      kind: "azure",
    };
    // Source is a task whose chain dead-ends at an inbox; falls back to the
    // task's own cwd (since the inbox is not a usable root).
    const taskUnderInbox: TestWs = {
      id: "ws-task",
      name: "Task",
      cwd: "/proj",
      kind: "task",
      task: { parentWorkspaceId: "ws-azure" },
    };
    const result = resolveTelegramTaskTarget({
      workspaces: [azureInbox, taskUnderInbox],
      sourceWorkspaceId: "ws-task",
    });
    expect(result.parentWorkspace?.id).toBe("ws-task");
    expect(result.taskCwd).toBe("/proj");
  });
});
