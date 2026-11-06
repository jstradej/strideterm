import { describe, expect, it } from "vitest";
import type { JiraIssueRef } from "./types/task.js";
import type { WorkspaceState } from "./types/state.js";
import {
  findJiraTaskWorkspaces,
  indexJiraBranchWorkspaces,
  isJiraTaskWorkspaceTerminal,
} from "./jira-task-workspaces.js";

const ref: JiraIssueRef = {
  provider: "jira",
  connectionId: "jira-primary",
  issueId: "42",
  issueKey: "APP-42",
};

function workspace(
  id: string,
  profileId: string,
  kind: string,
  refs: JiraIssueRef[] = [],
  state?: string,
): WorkspaceState {
  return {
    id,
    profileId,
    kind,
    task: { jiraIssueRefs: refs, state },
  } as unknown as WorkspaceState;
}

describe("Jira linked development workspaces", () => {
  it("matches every ticket workspace by connection and issue id, within one profile", () => {
    const workspaces = [
      workspace("same-ticket-other-profile", "p2", "task", [ref]),
      workspace("other-connection", "p1", "task", [{ ...ref, connectionId: "jira-secondary" }]),
      workspace("matching-1", "p1", "task", [ref]),
      workspace("matching-2", "p1", "task", [ref]),
    ];

    expect(findJiraTaskWorkspaces(workspaces, ref, "p1").map((item) => item.id)).toEqual(["matching-1", "matching-2"]);
  });

  it("ignores non-task workspaces and treats a missing profile as default", () => {
    const unprofiled = workspace("default-task", "default", "task", [ref]);
    const nonTask = workspace("review", "default", "review", [ref]);

    expect(findJiraTaskWorkspaces([nonTask, unprofiled], ref, "default").map((item) => item.id)).toEqual([
      "default-task",
    ]);
    expect(findJiraTaskWorkspaces([nonTask], ref, "default")).toEqual([]);
  });

  it("keeps in-progress, prepared, and interrupted tasks non-terminal for duplicate protection", () => {
    for (const state of [undefined, "idle", "running", "paused", "interrupted"]) {
      expect(isJiraTaskWorkspaceTerminal(workspace("task", "p1", "task", [ref], state))).toBe(false);
    }
  });

  it("marks completed and failed attempts as history eligible for a new explicit attempt", () => {
    for (const state of ["completed", "done", "failed", "stopped"]) {
      expect(isJiraTaskWorkspaceTerminal(workspace("task", "p1", "task", [ref], state))).toBe(true);
    }
  });
});

describe("indexJiraBranchWorkspaces", () => {
  const branch = (id: string, profileId: string, overrides: Record<string, unknown> = {}) => ({
    id,
    name: id,
    kind: "terminal",
    profileId,
    quickfix: { repositoryName: "web" },
    workItems: [{ ref }],
    ...overrides,
  });

  it("indexes quick-fix workspaces of the profile by connection and issue", () => {
    const index = indexJiraBranchWorkspaces(
      [branch("a", "p1"), branch("b", "p1", { workItems: [{ ref: { ...ref, issueId: "7" } }] })],
      "p1",
    );
    expect(index.get("jira-primary:42")?.map((item) => item.id)).toEqual(["a"]);
    expect(index.get("jira-primary:7")?.map((item) => item.id)).toEqual(["b"]);
  });

  it("skips other profiles, task workspaces and workspaces that are only linked", () => {
    const index = indexJiraBranchWorkspaces(
      [
        branch("other", "p2"),
        branch("task", "p1", { kind: "task" }),
        branch("linked", "p1", { quickfix: null }),
        branch("default", undefined as unknown as string),
      ],
      "p1",
    );
    expect(index.size).toBe(0);
  });

  it("treats a missing profile id as the default profile", () => {
    expect(indexJiraBranchWorkspaces([branch("d", undefined as unknown as string)], "default").size).toBe(1);
  });
});
