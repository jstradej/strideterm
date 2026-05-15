import { describe, expect, test } from "vitest";
import { getWorktreeGroup } from "./useDragDrop.js";
import type { WorkspaceState } from "../../electron/shared/types/state.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeWs(overrides: Partial<WorkspaceState> & { id: string; name: string; profileId: string }): any {
  return {
    icon: "",
    color: "",
    kind: "terminal",
    source: "manual",
    pluginId: "",
    cwd: "/p/x",
    gitRoots: [],
    activeRootPath: "",
    notes: "",
    connectionId: "",
    activePanelId: null,
    activeViewId: null,
    splitLayout: null,
    splitViewIds: [],
    panels: [],
    review: null,
    quickfix: null,
    starred: false,
    task: null,
    ...overrides,
  };
}

describe("getWorktreeGroup — profile scoping", () => {
  test("legacy worktree grouping stays within the dragged workspace's profile", () => {
    // Two profiles both have a workspace named "alpha". Profile-default
    // has a worktree "alpha / feat-default"; profile-b has "alpha /
    // feat-b". Dragging the profile-b parent must not collect the
    // profile-default worktree — the user's drop would otherwise reorder
    // a workspace they can't see.
    const workspaces = [
      makeWs({ id: "alpha-default", name: "alpha", profileId: "default" }),
      makeWs({
        id: "wt-default",
        name: "alpha / feat-default",
        profileId: "default",
        notes: "Worktree of alpha",
      }),
      makeWs({ id: "alpha-b", name: "alpha", profileId: "profile-b" }),
      makeWs({
        id: "wt-b",
        name: "alpha / feat-b",
        profileId: "profile-b",
        notes: "Worktree of alpha",
      }),
    ];

    const groupForB = getWorktreeGroup("alpha-b", workspaces);
    expect(groupForB.sort()).toEqual(["alpha-b", "wt-b"]);

    const groupForDefault = getWorktreeGroup("alpha-default", workspaces);
    expect(groupForDefault.sort()).toEqual(["alpha-default", "wt-default"]);
  });

  test("dragging a legacy worktree child resolves the same-profile parent only", () => {
    const workspaces = [
      makeWs({ id: "alpha-default", name: "alpha", profileId: "default" }),
      makeWs({ id: "alpha-b", name: "alpha", profileId: "profile-b" }),
      makeWs({
        id: "wt-b",
        name: "alpha / feat-b",
        profileId: "profile-b",
        notes: "Worktree of alpha",
      }),
    ];

    // Dragging the profile-b worktree should find the profile-b parent,
    // not the lexically-first "alpha" (which lives in profile-default).
    const group = getWorktreeGroup("wt-b", workspaces);
    expect(group.sort()).toEqual(["alpha-b", "wt-b"]);
  });
});
