import type { JiraIssueRef } from "./types/task.js";
const TERMINAL_TASK_STATES = new Set(["completed", "done", "failed", "stopped"]);

export interface JiraTaskWorkspaceLike {
  id: string;
  name: string;
  kind: string;
  profileId?: string;
  task?: {
    jiraIssueRefs?: JiraIssueRef[];
    state?: string;
  } | null;
}

function profileIdOf(workspace: JiraTaskWorkspaceLike): string {
  return workspace.profileId || "default";
}

function issueIdentity(ref: Pick<JiraIssueRef, "connectionId" | "issueId">): string {
  return `${ref.connectionId}\0${ref.issueId}`;
}

export function findJiraTaskWorkspaces<T extends JiraTaskWorkspaceLike>(
  workspaces: T[],
  ref: Pick<JiraIssueRef, "connectionId" | "issueId">,
  profileId: string,
): T[] {
  const identity = issueIdentity(ref);
  return workspaces.filter(
    (workspace) =>
      workspace.kind === "task" &&
      profileIdOf(workspace) === (profileId || "default") &&
      workspace.task?.jiraIssueRefs?.some((linked) => issueIdentity(linked) === identity),
  );
}

export function isJiraTaskWorkspaceTerminal(workspace: JiraTaskWorkspaceLike): boolean {
  return TERMINAL_TASK_STATES.has(workspace.task?.state || "");
}

export interface JiraBranchWorkspaceLike {
  id: string;
  name: string;
  kind: string;
  profileId?: string;
  quickfix?: { repositoryName?: string; baseBranch?: string } | null;
  workItems?: Array<{ ref: Pick<JiraIssueRef, "connectionId" | "issueId"> }>;
}

/** A branch workspace is a New-branch (quick-fix) checkout linked to the issue through `workItems`; task workspaces are not. Keyed by `connectionId:issueId`. */
export function indexJiraBranchWorkspaces<T extends JiraBranchWorkspaceLike>(
  workspaces: T[],
  profileId: string,
): Map<string, T[]> {
  const index = new Map<string, T[]>();
  for (const workspace of workspaces) {
    if (workspace.kind === "task" || !workspace.quickfix) continue;
    if ((workspace.profileId || "default") !== (profileId || "default")) continue;
    for (const item of workspace.workItems || []) {
      const key = `${item.ref.connectionId}:${item.ref.issueId}`;
      const list = index.get(key);
      if (list) list.push(workspace);
      else index.set(key, [workspace]);
    }
  }
  return index;
}
