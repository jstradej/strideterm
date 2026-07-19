import { describe, expect, test } from "vitest";
import { cloneWorkspace, createEmptyWorkspace, getParentWorkspaceId, statusTone } from "./workspace-state.js";

describe("workspace state helpers", () => {
  test("createEmptyWorkspace creates one shell panel", () => {
    const workspace = createEmptyWorkspace();
    expect(workspace.panels).toHaveLength(1);
    expect(workspace.panels[0].title).toBe("Shell");
    expect(workspace.activePanelId).toBe(workspace.panels[0].id);
  });

  test("cloneWorkspace deep clones panels", () => {
    const workspace = createEmptyWorkspace();
    const copy = cloneWorkspace(workspace);
    copy.panels[0].title = "Changed";
    expect(workspace.panels[0].title).toBe("Shell");
  });

  test("statusTone maps exited sessions to error tone", () => {
    expect(statusTone("exited")).toBe("error");
  });
});

// getParentWorkspaceId was duplicated in useDragDrop.ts (as getParentWorkspaceId)
// and workspace-render.ts (as getParentId). This is the shared implementation
// both were migrated to — it drives both drag-drop reparenting rules and the
// workspace-tree indent depth.
describe("getParentWorkspaceId", () => {
  test("resolves a managed-worktree review child's parent", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ws = { review: { checkout: { mode: "managed-worktree" }, parentWorkspaceId: "parent-1" } } as any;
    expect(getParentWorkspaceId(ws)).toBe("parent-1");
  });

  test("ignores a review parentWorkspaceId when checkout mode isn't managed-worktree", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ws = { review: { checkout: { mode: "manual" }, parentWorkspaceId: "parent-1" } } as any;
    expect(getParentWorkspaceId(ws)).toBeNull();
  });

  test("resolves a quickfix child's parent", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ws = { quickfix: { parentWorkspaceId: "parent-2" } } as any;
    expect(getParentWorkspaceId(ws)).toBe("parent-2");
  });

  test("resolves a task child's parent", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ws = { task: { parentWorkspaceId: "parent-3" } } as any;
    expect(getParentWorkspaceId(ws)).toBe("parent-3");
  });

  test("returns null for a workspace with no parent reference", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ws = { notes: "Worktree of Something" } as any;
    expect(getParentWorkspaceId(ws)).toBeNull();
  });
});
