import { describe, expect, test } from "vitest";
import { cloneWorkspace, createEmptyWorkspace, statusTone } from "./workspace-state.js";

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
