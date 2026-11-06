import { describe, expect, test } from "vitest";
import { resolvePaneProps } from "./pane-resolver.js";

describe("resolvePaneProps", () => {
  test("passes Jira view identity separately from workspace identity", () => {
    expect(resolvePaneProps("jira", "jira:profile:workspace:view:board%3A42", "profile:workspace")).toEqual({
      workspaceId: "profile:workspace",
      jiraViewId: "board:42",
    });
    expect(resolvePaneProps("jira", "jira:profile:workspace", "profile:workspace")).toEqual({
      workspaceId: "profile:workspace",
      jiraViewId: "issues",
    });
  });
});
