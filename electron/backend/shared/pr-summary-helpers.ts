import { normalizeRemoteUrl, stripRefsPrefix } from "./provider-utils.js";

interface WorkspaceEntry {
  id: string;
  cwd?: string;
  kind?: string;
  profileId?: string;
  review?: { provider?: string; prKey?: string };
  [key: string]: unknown;
}

export interface GitSnapshot {
  branch?: string;
  remotes?: Record<string, string>;
  [key: string]: unknown;
}

interface PrMatchSummary {
  repository?: { remoteUrl?: string };
  pullRequest?: { sourceRefName?: string };
  role?: string;
}

/**
 * Find a workspace that was created for a specific pull request.
 */
export function findWorkspaceForPullRequest(
  workspaces: WorkspaceEntry[],
  prKey: string,
  providerName: string,
): WorkspaceEntry | null {
  return (
    (workspaces || []).find(
      (workspace) => workspace.review?.provider === providerName && workspace.review?.prKey === prKey,
    ) || null
  );
}

/**
 * Find an existing workspace whose git remote and branch match a pull request summary.
 */
export function findMatchingWorkspace(
  summary: PrMatchSummary,
  workspaces: WorkspaceEntry[] = [],
  gitSnapshots: Record<string, GitSnapshot> = {},
): WorkspaceEntry | null {
  const targetRemote = normalizeRemoteUrl(summary.repository?.remoteUrl || "");
  const targetBranch = stripRefsPrefix(summary.pullRequest?.sourceRefName || "");
  return (
    workspaces.find((workspace) => {
      if (workspace.kind === "docker" || !workspace.cwd) return false;
      const snapshot = gitSnapshots?.[workspace.id];
      const origin = normalizeRemoteUrl(snapshot?.remotes?.origin || "");
      if (targetRemote && origin && origin !== targetRemote) return false;
      if (summary.role === "author" && snapshot?.branch && targetBranch) {
        return snapshot.branch === targetBranch;
      }
      return origin && origin === targetRemote;
    }) || null
  );
}
