import { describe, expect, test } from "vitest";
import { applyDropPlacement, getWorktreeGroup, resolveDropPlacement } from "./useDragDrop.js";
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

describe("workspace groups — drag and drop", () => {
  const group = (id: string, extra: Record<string, unknown> = {}) =>
    makeWs({ id, name: id, profileId: "default", kind: "group", cwd: "", ...extra });
  const item = (id: string, extra: Record<string, unknown> = {}) =>
    makeWs({ id, name: id, profileId: "default", ...extra });
  // Sidebar order: loose-1, [G: m1, m2 (with a task child)], loose-2, [H: n1]
  const workspaces = () => [
    item("loose-1"),
    group("G"),
    item("m1", { groupId: "G" }),
    item("m2", { groupId: "G" }),
    item("m2-task", { kind: "task", task: { parentWorkspaceId: "m2" } }),
    item("loose-2"),
    group("H"),
    item("n1", { groupId: "H" }),
  ];
  const drop = (draggedId: string, targetId: string, fraction: number) => {
    const all = workspaces();
    const placement = resolveDropPlacement(all, draggedId, targetId, fraction);
    return placement && { placement, order: applyDropPlacement(all, draggedId, placement) };
  };

  test("a member drags only its own family; a group drags its whole block", () => {
    expect(getWorktreeGroup("m2", workspaces())).toEqual(["m2", "m2-task"]);
    expect(getWorktreeGroup("m2-task", workspaces())).toEqual(["m2", "m2-task"]);
    expect(getWorktreeGroup("G", workspaces()).sort()).toEqual(["G", "m1", "m2", "m2-task"]);
  });

  test("a legacy worktree is not pulled into a group that shares its parent's name", () => {
    const all = [group("alpha"), item("alpha-2", { name: "alpha / x", notes: "Worktree of alpha" })];
    expect(getWorktreeGroup("alpha", all)).toEqual(["alpha"]);
  });

  test("dropping a loose workspace on the middle of a group header files it as the last member", () => {
    const result = drop("loose-1", "G", 0.5)!;
    expect(result.placement).toMatchObject({ groupId: "G", into: true, indicatorId: "G" });
    expect(result.order).toEqual(["G", "m1", "m2", "m2-task", "loose-1", "loose-2", "H", "n1"]);
  });

  test("dropping on the top quarter of a group header places the workspace before the group instead", () => {
    const result = drop("loose-2", "G", 0.1)!;
    expect(result.placement).toMatchObject({ groupId: "", into: false, before: true });
    expect(result.order).toEqual(["loose-1", "loose-2", "G", "m1", "m2", "m2-task", "H", "n1"]);
  });

  test("dropping on a member files the workspace in that group next to the member", () => {
    const before = drop("loose-2", "m2", 0.2)!;
    expect(before.placement).toMatchObject({ groupId: "G", before: true });
    expect(before.order).toEqual(["loose-1", "G", "m1", "loose-2", "m2", "m2-task", "H", "n1"]);

    const after = drop("loose-2", "m2-task", 0.9)!;
    expect(after.placement).toMatchObject({ groupId: "G", before: false });
    expect(after.order).toEqual(["loose-1", "G", "m1", "m2", "m2-task", "loose-2", "H", "n1"]);
  });

  test("members reorder inside their group, and a member carries its family along", () => {
    const result = drop("m2", "m1", 0.1)!;
    expect(result.placement.groupId).toBe("G");
    expect(result.order).toEqual(["loose-1", "G", "m2", "m2-task", "m1", "loose-2", "H", "n1"]);
  });

  test("dropping a member on a loose workspace takes it out of its group", () => {
    const result = drop("m1", "loose-2", 0.9)!;
    expect(result.placement).toMatchObject({ groupId: "", before: false });
    expect(result.order).toEqual(["loose-1", "G", "m2", "m2-task", "loose-2", "m1", "H", "n1"]);
  });

  test("dropping a member on another group's header moves it there", () => {
    const result = drop("m1", "H", 0.6)!;
    expect(result.placement.groupId).toBe("H");
    expect(result.order).toEqual(["loose-1", "G", "m2", "m2-task", "loose-2", "H", "n1", "m1"]);
  });

  test("a group is only ever placed at root level, next to the block it is dropped on", () => {
    const onHeader = drop("G", "H", 0.6)!;
    expect(onHeader.placement).toMatchObject({ groupId: "", into: false, before: false });
    expect(onHeader.order).toEqual(["loose-1", "loose-2", "H", "n1", "G", "m1", "m2", "m2-task"]);

    const onMember = drop("H", "m1", 0.1)!;
    expect(onMember.placement.groupId).toBe("");
    expect(onMember.order).toEqual(["loose-1", "H", "n1", "G", "m1", "m2", "m2-task", "loose-2"]);
  });

  test("nothing happens when a family is dropped on itself or inside its own block", () => {
    expect(drop("G", "m1", 0.5)).toBeNull();
    expect(drop("m2", "m2-task", 0.5)).toBeNull();
    expect(drop("loose-1", "loose-1", 0.5)).toBeNull();
  });

  test("a groupId pointing into another profile does not make the member part of that group", () => {
    const all = [group("G", { profileId: "other" }), item("m", { groupId: "G" }), item("x")];
    expect(getWorktreeGroup("G", all)).toEqual(["G"]);
    const placement = resolveDropPlacement(all, "x", "m", 0.5)!;
    expect(placement.groupId).toBe("");
  });
});
