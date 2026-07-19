/**
 * Shared PR-creation submit logic for GitPullRequestTab's inline form and
 * GitBranchesTab's CreatePullRequestDialog — both call
 * gitUiStore.azureCreatePullRequest and then read gitUi.lastResult the same
 * way; this normalizes that into one {ok, summary, url, pullRequestId} shape
 * so success/failure reporting can't drift between the two entry points.
 */

export interface CreatePullRequestPayload {
  title: string;
  description: string;
  sourceBranch: string;
  targetBranch: string;
  connectionId: string;
  isDraft?: boolean;
}

export interface PullRequestSubmitResult {
  ok: boolean;
  summary: string;
  url: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- MIGRATION-EXEMPT: pass-through of the raw backend id
  pullRequestId?: any;
}

export interface AzurePullRequestStore {
  azureCreatePullRequest: (workspaceId: string, payload: CreatePullRequestPayload) => Promise<unknown>;
}

export async function submitPullRequest(
  gitUiStore: AzurePullRequestStore,
  workspaceId: string,
  payload: CreatePullRequestPayload,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- MIGRATION-EXEMPT: gitUi prop is passed through untyped by both callers
  gitUi: Record<string, any>,
): Promise<PullRequestSubmitResult> {
  await gitUiStore.azureCreatePullRequest(workspaceId, payload);
  const result = gitUi.lastResult;
  if (result?.ok) {
    return {
      ok: true,
      summary: `PR #${result.pullRequestId ?? ""} created.`,
      url: result.url || "",
      pullRequestId: result.pullRequestId,
    };
  }
  return { ok: false, summary: result?.summary || "Failed to create pull request.", url: "" };
}
