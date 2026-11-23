import { describe, expect, test } from "vitest";
import type { WorkspaceState } from "../shared/types/state.js";
import { insertWorkspace } from "./workspace-order.js";

function workspace(id: string, profileId = "default", extra: Partial<WorkspaceState> = {}): WorkspaceState {
  return {
    id,
    name: id,
    icon: "",
    color: "",
    kind: "terminal",
    source: "manual",
    pluginId: "",
    profileId,
    cwd: "",
    gitRoots: [],
    activeRootPath: "",
    connectionId: "",
    notes: "",
    activePanelId: null,
    activeViewId: null,
    splitLayout: null,
    splitViewIds: [],
    panels: [],
    review: null,
    quickfix: null,
    starred: false,
    task: null,
    ...extra,
  };
}

function review(id: string, parentWorkspaceId: string, profileId = "default"): WorkspaceState {
  return workspace(id, profileId, {
    review: {
      provider: "azure-devops",
      prKey: id,
      connectionId: "ado",
      orgUrl: "",
      parentWorkspaceId,
      project: { id: "", name: "" },
      repository: { id: "", name: "", remoteUrl: "" },
      pullRequest: {
        id: 1,
        number: 1,
        title: id,
        status: "active",
        mergeStatus: "",
        url: "",
        webUrl: "",
        sourceRefName: "",
        targetRefName: "",
      },
      role: "reviewer",
      checkout: { mode: "managed-worktree", rootPath: "", cacheRepoPath: "" },
    },
  });
}

describe("insertWorkspace", () => {
  test("inserts a pinned Jira board directly after its inbox", () => {
    const inbox = workspace("jira-inbox", "default", { kind: "jira" });
    const oldBoard = workspace("old-board", "default", {
      kind: "jira-board",
      jiraBoard: { parentWorkspaceId: inbox.id, connectionId: "jira-1", boardId: "1", boardName: "Old" },
    });
    const workspaces = [inbox, oldBoard, workspace("after")];
    const newBoard = workspace("new-board", "default", {
      kind: "jira-board",
      jiraBoard: { parentWorkspaceId: inbox.id, connectionId: "jira-1", boardId: "2", boardName: "New" },
    });

    insertWorkspace(workspaces, newBoard, "after");

    expect(workspaces.map((item) => item.id)).toEqual(["jira-inbox", "new-board", "old-board", "after"]);
  });

  test("inserts a new child directly below its parent before older children", () => {
    const workspaces = [workspace("before"), workspace("parent"), review("old-child", "parent"), workspace("after")];

    insertWorkspace(workspaces, review("new-child", "parent"), "after");

    expect(workspaces.map((item) => item.id)).toEqual(["before", "parent", "new-child", "old-child", "after"]);
  });

  test("inserts a top-level workspace after the active root and its child block", () => {
    const workspaces = [workspace("before"), workspace("active"), review("active-child", "active"), workspace("after")];

    insertWorkspace(workspaces, workspace("new"), "active");

    expect(workspaces.map((item) => item.id)).toEqual(["before", "active", "active-child", "new", "after"]);
  });

  test("uses the active child's root as the insertion anchor", () => {
    const workspaces = [
      workspace("parent"),
      review("active-child", "parent"),
      review("sibling", "parent"),
      workspace("after"),
    ];

    insertWorkspace(workspaces, workspace("new"), "active-child");

    expect(workspaces.map((item) => item.id)).toEqual(["parent", "active-child", "sibling", "new", "after"]);
  });

  test("falls back to the start of the target profile without using another profile's active workspace", () => {
    const workspaces = [workspace("a-1", "profile-a"), workspace("b-1", "profile-b"), workspace("b-2", "profile-b")];

    insertWorkspace(workspaces, workspace("b-new", "profile-b"), "a-1");

    expect(workspaces.map((item) => item.id)).toEqual(["a-1", "b-new", "b-1", "b-2"]);
  });
});

describe("insertWorkspace with groups", () => {
  const group = (id: string, profileId = "default") => workspace(id, profileId, { kind: "group" });

  test("a new group member lands right after its group", () => {
    const workspaces = [group("g"), workspace("m1", "default", { groupId: "g" }), workspace("other")];

    insertWorkspace(workspaces, workspace("m2", "default", { groupId: "g" }));

    expect(workspaces.map((item) => item.id)).toEqual(["g", "m2", "m1", "other"]);
  });

  test("a new root workspace created while a member is active goes after the whole group", () => {
    const workspaces = [group("g"), workspace("m1", "default", { groupId: "g" }), workspace("other")];

    insertWorkspace(workspaces, workspace("new"), "m1");

    expect(workspaces.map((item) => item.id)).toEqual(["g", "m1", "new", "other"]);
  });

  test("a groupId pointing into another profile does not file the workspace anywhere", () => {
    const workspaces = [group("g", "profile-a"), workspace("x", "profile-b")];

    insertWorkspace(workspaces, workspace("m", "profile-b", { groupId: "g" }));

    expect(workspaces.map((item) => item.id)).toEqual(["g", "m", "x"]);
  });
});
