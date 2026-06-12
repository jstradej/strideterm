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
      writable: false,
      checkout: { mode: "managed-worktree", rootPath: "", cacheRepoPath: "" },
    },
  });
}

describe("insertWorkspace", () => {
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
