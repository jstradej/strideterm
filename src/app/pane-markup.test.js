import { describe, expect, test } from "vitest";
import { renderGitMarkup } from "./pane-markup.js";

function createSnapshot(overrides = {}) {
  return {
    available: true,
    repository: "demo",
    root: "/repo",
    branch: "feature-x",
    commitCount: 3,
    dirty: false,
    dirtyCount: 0,
    staged: [],
    unstaged: [],
    untracked: [],
    diffStat: { files: 0, insertions: 0, deletions: 0, renames: 0, deletes: 0 },
    log: [],
    lazygit: { available: false, backend: null, error: "", launch: null },
    isMainWorktree: true,
    worktreePath: "/repo",
    mainWorktreePath: "/repo",
    siblingWorktrees: [],
    upstream: "",
    baseBranch: "",
    aheadCount: 0,
    behindCount: 0,
    compareWithBase: {
      baseBranch: "",
      aheadCount: 0,
      behindCount: 0,
      commits: [],
      files: [],
      diffStat: { files: 0, insertions: 0, deletions: 0, renames: 0, deletes: 0 },
    },
    lastFetchAt: null,
    operationState: {
      kind: "idle",
      inProgress: false,
      label: "",
      details: "",
      conflicts: [],
      canContinue: false,
      canAbort: false,
    },
    ...overrides,
  };
}

describe("renderGitMarkup", () => {
  test("renders tab navigation with status tab active by default", () => {
    const markup = renderGitMarkup(createSnapshot(), "workspace-1", {}, []);

    expect(markup).toContain("git-tabs__item--active");
    expect(markup).toContain('data-tab="status"');
    expect(markup).toContain('data-tab="changes"');
    expect(markup).toContain('data-tab="history"');
    expect(markup).toContain('data-tab="worktrees"');
  });

  test("shows branch sync card on status tab with no-base-branch state", () => {
    const markup = renderGitMarkup(createSnapshot(), "workspace-1", { activeTab: "status" }, []);

    expect(markup).toContain("Merge Back");
    expect(markup).toContain("Base branch was not detected.");
  });

  test("renders pending action confirmation banner on status tab", () => {
    const gitUi = {
      activeTab: "status",
      pendingAction: {
        type: "merge",
        baseBranch: "main",
        stashDirty: false,
        message: "Merge main into feature-x?",
      },
    };
    const markup = renderGitMarkup(createSnapshot({ baseBranch: "main" }), "workspace-1", gitUi, []);

    expect(markup).toContain("Confirm action");
    expect(markup).toContain("Merge main into feature-x?");
    expect(markup).toContain('data-action="git-confirm-action"');
    expect(markup).toContain('data-action="git-cancel-action"');
  });

  test("renders changes tab with file lists and diff preview area", () => {
    const markup = renderGitMarkup(createSnapshot({
      dirty: true,
      dirtyCount: 1,
      untracked: [{ path: "docs/readme.md", code: "??" }],
      diffStat: { files: 1, insertions: 3, deletions: 0, renames: 0, deletes: 0 },
    }), "workspace-1", { activeTab: "changes" }, []);

    expect(markup).toContain('data-scope="untracked"');
    expect(markup).toContain("docs/readme.md");
    expect(markup).toContain("Diff Preview");
    expect(markup).toContain("Select a file");
  });

  test("renders worktrees tab with repository context", () => {
    const markup = renderGitMarkup(createSnapshot(), "workspace-1", { activeTab: "worktrees" }, []);

    expect(markup).toContain("Worktree Context");
    expect(markup).toContain("/repo");
  });

  test("shows dirty count badge on changes tab", () => {
    const markup = renderGitMarkup(createSnapshot({ dirty: true, dirtyCount: 5 }), "workspace-1", {}, []);

    expect(markup).toContain("git-tabs__badge");
    expect(markup).toContain("5");
  });
});
