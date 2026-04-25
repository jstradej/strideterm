import { attentionTitle, isFreshAttention, safeColor, tabAttentionTitle, isFreshAlert } from "./helpers.js";
import type { WorkspaceState, GitSnapshot } from "../../electron/shared/types/state.js";

// ---------------------------------------------------------------------------
// Local structural types
// ---------------------------------------------------------------------------

interface TabLike {
  id: string;
  title: string;
  status: string;
  tone: string;
  persistent?: boolean;
  closable?: boolean;
}

interface AttentionLike {
  count?: number;
  alerts?: Array<{ title?: string; kind?: string; exitCode?: number; at?: string }>;
  latestAt?: string;
}

interface ChecksLike {
  failedCount?: number;
  pendingCount?: number;
  passedCount?: number;
}

interface PrStatusInfo {
  status?: string;
  closedDate?: string;
}

interface LiveTask {
  state?: string;
  currentRound?: number;
  maxRounds?: number;
}

// ---------------------------------------------------------------------------

function getParentId(ws: WorkspaceState): string | null {
  if (ws.review?.checkout?.mode === "managed-worktree" && ws.review?.parentWorkspaceId)
    return ws.review.parentWorkspaceId;
  if (ws.quickfix?.parentWorkspaceId) return ws.quickfix.parentWorkspaceId;
  if (ws.task?.parentWorkspaceId) return ws.task.parentWorkspaceId ?? null;
  return null;
}

function computeDepth(workspace: WorkspaceState, byId: Map<string, WorkspaceState>, seen = new Set<string>()): number {
  const parentId = getParentId(workspace);
  if (parentId && !seen.has(parentId)) {
    const parent = byId.get(parentId);
    if (parent) {
      seen.add(parentId);
      return computeDepth(parent, byId, seen) + 1;
    }
    return 1;
  }
  if (
    ["azure-devops", "github"].includes(workspace.review?.provider ?? "") &&
    workspace.review?.checkout?.mode === "managed-worktree"
  )
    return 1;
  if ((workspace.notes || "").startsWith("Worktree of ")) return 1;
  return 0;
}

export function buildTabStripModel({
  tabs,
  activeViewId,
  isInSplitGroup,
  getTabAttention,
}: {
  tabs: TabLike[];
  activeViewId: string;
  isInSplitGroup: (id: string) => boolean;
  getTabAttention: (id: string) => AttentionLike | null | undefined;
}): Array<{
  id: string;
  title: string;
  status: string;
  tone: string;
  active: boolean;
  grouped: boolean;
  persistent: boolean;
  closable: boolean;
  attention: boolean;
  attentionFresh: boolean;
  attentionTooltip: string;
  titleTooltip: string;
}> {
  return tabs.map((session) => {
    const tabAttention = getTabAttention(session.id);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const attentionTooltip = tabAttentionTitle(tabAttention as any);
    return {
      id: session.id,
      title: session.title,
      status: session.status,
      tone: session.tone,
      active: session.id === activeViewId,
      grouped: isInSplitGroup(session.id),
      persistent: !!session.persistent,
      closable: session.closable !== false,
      attention: !!tabAttention,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      attentionFresh: isFreshAlert(tabAttention as any),
      attentionTooltip,
      titleTooltip:
        attentionTooltip ||
        (session.persistent
          ? "Double click to rename. Drag to reorder."
          : `${session.title}${session.status ? `\n${session.status}` : ""}`),
    };
  });
}

export function buildWorkspaceCards({
  workspaces,
  activeWorkspaceId,
  getGitSnapshot,
  getWorkspaceAttention,
  getChecks,
  getPrStatus,
  taskRunnerSnapshot,
}: {
  workspaces: WorkspaceState[];
  activeWorkspaceId: string;
  getGitSnapshot: (id: string) => GitSnapshot | null | undefined;
  getWorkspaceAttention: (id: string) => AttentionLike | null | undefined;
  getChecks?: ((workspace: WorkspaceState) => ChecksLike | null | undefined) | null;
  getPrStatus?: ((workspace: WorkspaceState) => PrStatusInfo | null | undefined) | null;
  taskRunnerSnapshot?: Record<string, LiveTask> | null;
}): Array<Record<string, unknown>> {
  const byId = new Map(workspaces.map((w) => [w.id, w]));
  return workspaces.map((workspace, index) => {
    const active = workspace.id === activeWorkspaceId;
    const gitSnapshot = getGitSnapshot(workspace.id);
    const attention = getWorkspaceAttention(workspace.id);
    const attentionTooltip = attentionTitle(attention);
    const depth = computeDepth(workspace, byId);
    const isReviewChild =
      ["azure-devops", "github"].includes(workspace.review?.provider ?? "") &&
      workspace.review?.checkout?.mode === "managed-worktree";
    const checks = typeof getChecks === "function" ? getChecks(workspace) : null;
    const checksState = checks?.failedCount
      ? "failed"
      : checks?.pendingCount
        ? "pending"
        : checks?.passedCount
          ? "passed"
          : null;
    const prStatusInfo = isReviewChild && typeof getPrStatus === "function" ? getPrStatus(workspace) : null;
    const worktreeMerged = !isReviewChild && gitSnapshot?.branchMerged;
    const prStatus = prStatusInfo?.status || (worktreeMerged ? "completed" : null);
    const reviewProviderLabel = workspace.review?.provider === "github" ? "GitHub review" : "Azure review";
    const liveTask = taskRunnerSnapshot?.[workspace.id];
    const taskState = liveTask?.state || workspace.task?.state;
    const taskCurrentRound = liveTask?.currentRound ?? workspace.task?.currentRound ?? 0;
    const taskMaxRounds = liveTask?.maxRounds ?? workspace.task?.maxRounds ?? 10;
    const taskSummary = taskState
      ? `${taskState === "running" ? "Running" : taskState === "evaluating" ? "Evaluating" : taskState === "judge-evaluating" ? "Judge evaluating" : taskState === "refreshing" ? "Refreshing" : taskState === "completed" ? "Completed" : taskState === "failed" ? "Failed" : taskState === "paused" ? "Paused" : "Idle"} \u00B7 R${taskCurrentRound}/${taskMaxRounds}`
      : null;
    const summary =
      workspace.kind === "task" && taskSummary
        ? taskSummary
        : workspace.kind === "docker"
          ? "Docker"
          : workspace.kind === "azure"
            ? `${workspace.cwd || "Azure inbox"}${workspace.panels?.length ? ` \u00B7 ${workspace.panels.length} review tabs` : ""}`
            : workspace.kind === "github"
              ? `${workspace.cwd || "GitHub inbox"}${workspace.panels?.length ? ` \u00B7 ${workspace.panels.length} review tabs` : ""}`
              : isReviewChild
                ? `${workspace.review?.pullRequest ? reviewProviderLabel : "New branch"} \u00B7 ${gitSnapshot?.branch || `${workspace.panels.length} tabs`}${gitSnapshot?.dirty ? ` \u00B7 ${gitSnapshot.dirtyCount} dirty` : ""}`
                : gitSnapshot?.available
                  ? `${gitSnapshot.branch}${gitSnapshot.dirty ? ` \u00B7 ${gitSnapshot.dirtyCount} dirty` : ""}`
                  : `${workspace.panels.length} tabs`;

    return {
      id: workspace.id,
      index: index + 1,
      icon: workspace.icon,
      name: workspace.name,
      active,
      color: safeColor(workspace.color),
      summary,
      title: `${attention?.count ? attentionTooltip : workspace.name}${worktreeMerged ? "\nBranch merged" : prStatus && prStatus !== "active" ? `\nPR ${prStatus}${prStatusInfo?.closedDate ? ` · ${new Date(prStatusInfo.closedDate).toLocaleDateString()}` : ""}` : ""}${index < 9 ? ` (Ctrl+${index + 1})` : ""}`,
      attentionCount: attention?.count || 0,
      attentionFresh: isFreshAttention(attention),
      attentionTooltip,
      kind: workspace.kind || "terminal",
      gitAvailable: !!gitSnapshot?.available,
      depth,
      checksState,
      prStatus,
      taskState: taskState || null,
      starred: Boolean(workspace.starred),
    };
  });
}
