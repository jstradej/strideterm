import { formatWorkspaceDisplayName } from "../../shared/workspace-display.js";
import { buildWorkspaceTree } from "../../shared/workspace-tree.js";
import type { WorkspaceState } from "../../shared/types/state.js";

export type MobileWorkspaceRow = Record<string, unknown> & { id: string };

interface RuntimeProjectionPayload {
  git?: { workspaces?: Record<string, GitWorkspaceSummary> };
  taskRunner?: Record<string, LiveTaskSummary>;
  attention?: {
    sessions?: Record<string, AttentionSession>;
    byWorkspace?: Record<string, AttentionSummary>;
    byProject?: Record<string, AttentionSummary>;
  };
  azureDevops?: { pullRequests?: Record<string, PullRequestSummary> };
  github?: { pullRequests?: Record<string, PullRequestSummary> };
}

interface GitWorkspaceSummary {
  available?: boolean;
  branch?: string;
  branchMerged?: boolean;
  dirtyCount?: number;
  lastChangeAt?: string;
}

interface LiveTaskSummary {
  state?: string;
  currentRound?: number;
  maxRounds?: number;
}

interface AttentionSession {
  workspaceId?: string;
  agentLike?: boolean;
  hasUserInput?: boolean;
  activity?: string;
}

interface AttentionSummary {
  count?: number;
  latestAt?: string;
}

interface PullRequestSummary {
  pullRequest?: {
    status?: string;
    closedDate?: string;
    mergedAt?: string;
    state?: string;
    closedAt?: string;
    updatedAt?: string;
  };
  checks?: { failedCount?: number; pendingCount?: number; passedCount?: number };
  lastActivityAt?: string;
}

export function projectMobileWorkspaces(
  workspaces: WorkspaceState[],
  runtimePayload: RuntimeProjectionPayload,
): MobileWorkspaceRow[] {
  const gitWorkspaces = runtimePayload.git?.workspaces ?? {};
  const taskRunner = runtimePayload.taskRunner ?? {};
  const attention = runtimePayload.attention;
  const azurePullRequests = runtimePayload.azureDevops?.pullRequests ?? {};
  const githubPullRequests = runtimePayload.github?.pullRequests ?? {};
  const attentionActivity = new Map<string, { runningCount: number; doneCount: number }>();
  for (const session of Object.values(attention?.sessions ?? {})) {
    if (
      !session.workspaceId ||
      !session.agentLike ||
      !session.hasUserInput ||
      (session.activity !== "running" && session.activity !== "done")
    )
      continue;
    const counts = attentionActivity.get(session.workspaceId) ?? { runningCount: 0, doneCount: 0 };
    if (session.activity === "running") counts.runningCount++;
    else counts.doneCount++;
    attentionActivity.set(session.workspaceId, counts);
  }
  const tree = buildWorkspaceTree(workspaces);
  const latestIso = (...values: Array<string | null | undefined>): string | undefined => {
    let latest: string | undefined;
    let latestTime = 0;
    for (const value of values) {
      if (!value) continue;
      const time = Date.parse(value);
      if (Number.isFinite(time) && time > latestTime) {
        latest = value;
        latestTime = time;
      }
    }
    return latest;
  };

  return workspaces.map((workspace) => {
    const workspaceId = workspace.id;
    const task = workspace.task;
    const liveTask = taskRunner[workspaceId];
    const gitSummary = gitWorkspaces[workspaceId];
    const workspaceAttention = attention?.byWorkspace?.[workspaceId] ?? attention?.byProject?.[workspaceId];
    const agentActivity = attentionActivity.get(workspaceId);
    const agentRunningCount = agentActivity?.runningCount ?? 0;
    const agentDoneCount = agentActivity?.doneCount ?? 0;
    const agentActivityState = agentRunningCount > 0 ? "running" : agentDoneCount > 0 ? "done" : undefined;
    const review = workspace.review;
    const reviewProvider = review?.provider;
    const reviewCheckoutMode = review?.checkout?.mode;
    const isReviewChild =
      (reviewProvider === "azure-devops" || reviewProvider === "github") && reviewCheckoutMode === "managed-worktree";
    const reviewSummary = review?.prKey
      ? reviewProvider === "github"
        ? githubPullRequests[review.prKey]
        : reviewProvider === "azure-devops"
          ? azurePullRequests[review.prKey]
          : undefined
      : undefined;
    const reviewPr = reviewSummary?.pullRequest;
    let prStatus: string | undefined;
    let prClosedAt: string | undefined;
    if (isReviewChild && review?.prKey) {
      if (reviewProvider === "azure-devops") {
        prStatus = reviewPr?.status === "completed" || reviewPr?.status === "abandoned" ? reviewPr.status : "active";
        if (prStatus !== "active" && reviewPr?.closedDate) prClosedAt = reviewPr.closedDate;
      } else if (reviewProvider === "github") {
        if (reviewPr?.mergedAt) {
          prStatus = "completed";
          prClosedAt = reviewPr.mergedAt;
        } else if (reviewPr && reviewPr.state !== "open") {
          prStatus = "abandoned";
          prClosedAt = reviewPr.closedAt || reviewPr.updatedAt;
        } else prStatus = "active";
      }
    } else if (!isReviewChild && gitSummary?.branchMerged) prStatus = "completed";
    const checks = reviewSummary?.checks;
    const checksState = checks?.failedCount
      ? "failed"
      : checks?.pendingCount
        ? "pending"
        : checks?.passedCount
          ? "passed"
          : undefined;
    const prLastActivityAt = reviewSummary?.lastActivityAt || undefined;
    const attentionLatestAt = workspaceAttention?.latestAt || undefined;
    const gitLastChangeAt = gitSummary?.lastChangeAt || undefined;
    const lastActivityAt = latestIso(isReviewChild ? prLastActivityAt : undefined, attentionLatestAt, gitLastChangeAt);

    return {
      id: workspaceId,
      name: formatWorkspaceDisplayName(workspace) || workspace.name,
      kind: workspace.kind || "terminal",
      ...(workspace.icon ? { icon: workspace.icon } : {}),
      ...(workspace.color ? { color: workspace.color } : {}),
      ...(workspace.starred ? { starred: true } : {}),
      ...(tree.parentOf(workspaceId) ? { parentWorkspaceId: tree.parentOf(workspaceId) } : {}),
      tabCount: workspace.panels?.length ?? 0,
      ...(task?.state || liveTask?.state ? { taskState: liveTask?.state || task?.state } : {}),
      ...(workspace.kind === "task"
        ? {
            taskCurrentRound: liveTask?.currentRound ?? task?.currentRound ?? 0,
            taskMaxRounds: liveTask?.maxRounds ?? task?.maxRounds ?? 10,
            ...(task?.createdAt ? { taskCreatedAt: task.createdAt } : {}),
          }
        : {}),
      ...(gitSummary
        ? {
            ...(typeof gitSummary.available === "boolean" ? { gitAvailable: gitSummary.available } : {}),
            ...(typeof gitSummary.branchMerged === "boolean" ? { branchMerged: gitSummary.branchMerged } : {}),
            ...(gitLastChangeAt ? { gitLastChangeAt } : {}),
          }
        : {}),
      ...(reviewProvider ? { reviewProvider } : {}),
      ...(reviewCheckoutMode ? { reviewCheckoutMode } : {}),
      ...(isReviewChild ? { reviewHasPullRequest: Boolean(review?.pullRequest) } : {}),
      ...(prStatus ? { prStatus } : {}),
      ...(prClosedAt ? { prClosedAt } : {}),
      ...(checksState ? { checksState } : {}),
      ...(prLastActivityAt ? { prLastActivityAt } : {}),
      ...(workspaceAttention?.count ? { attentionCount: workspaceAttention.count } : {}),
      ...(attentionLatestAt ? { attentionLatestAt } : {}),
      ...(agentActivityState ? { agentActivityState } : {}),
      ...(agentRunningCount > 0 ? { agentRunningCount } : {}),
      ...(agentDoneCount > 0 ? { agentDoneCount } : {}),
      ...(lastActivityAt ? { lastActivityAt } : {}),
      ...(gitWorkspaces[workspaceId]?.available
        ? {
            ...(gitWorkspaces[workspaceId].branch ? { branch: gitWorkspaces[workspaceId].branch } : {}),
            ...(typeof gitWorkspaces[workspaceId].dirtyCount === "number"
              ? { dirtyCount: gitWorkspaces[workspaceId].dirtyCount }
              : {}),
          }
        : {}),
      ...(workspace.lastWorkedAt ? { lastWorkedAt: workspace.lastWorkedAt } : {}),
    };
  });
}
