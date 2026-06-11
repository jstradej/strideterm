import { attentionTitle, isFreshAttention, safeColor, tabAttentionTitle, isFreshAlert } from "./helpers.js";
import type { WorkspaceState, GitSnapshot } from "../../electron/shared/types/state.js";
import { formatWorkspaceDisplayName } from "../../electron/shared/workspace-display.js";
import { formatRelativeAge } from "./relative-age.js";

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
  lastActivityAt?: string | null;
}

interface LiveTask {
  state?: string;
  currentRound?: number;
  maxRounds?: number;
}

interface SessionActivityLike {
  workspaceId?: string;
  panelId?: string;
  activity?: string;
  agentLike?: boolean;
  hasUserInput?: boolean;
  lastCommandFinishedAt?: number;
  lastExitCode?: number | null;
}

interface WorkspaceAgentActivity {
  state: "running" | "done";
  panelTitle: string;
  runningCount: number;
  doneCount: number;
  latestDoneAt: number;
}

/**
 * Trim a task description for a hover tooltip. We want enough text to actually
 * tell two agents apart (one-liner descriptions don't cut it) but not so much
 * that the native title tooltip becomes a wall of text that browsers truncate
 * inconsistently. ~400 chars + ellipsis is a sweet spot.
 */
function truncateForTooltip(text: string, limit = 400): string {
  const trimmed = (text || "").trim();
  if (trimmed.length <= limit) return trimmed;
  return trimmed.slice(0, limit - 1).trimEnd() + "…";
}

/**
 * Pick the most recent of several ISO timestamps, ignoring missing /
 * unparseable values. Returns null when nothing usable is supplied. Used to
 * collapse a workspace's activity signals (remote PR activity, local session
 * alerts) into a single "last activity" instant.
 */
function mostRecentIso(...isos: Array<string | null | undefined>): string | null {
  let bestTime = 0;
  let bestIso: string | null = null;
  for (const iso of isos) {
    if (!iso) continue;
    const t = Date.parse(iso);
    if (Number.isNaN(t) || t <= bestTime) continue;
    bestTime = t;
    bestIso = iso;
  }
  return bestIso;
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
  sessionActivities,
}: {
  workspaces: WorkspaceState[];
  activeWorkspaceId: string;
  getGitSnapshot: (id: string) => GitSnapshot | null | undefined;
  getWorkspaceAttention: (id: string) => AttentionLike | null | undefined;
  getChecks?: ((workspace: WorkspaceState) => ChecksLike | null | undefined) | null;
  getPrStatus?: ((workspace: WorkspaceState) => PrStatusInfo | null | undefined) | null;
  taskRunnerSnapshot?: Record<string, LiveTask> | null;
  sessionActivities?: Record<string, SessionActivityLike> | null;
}): Array<Record<string, unknown>> {
  const byId = new Map(workspaces.map((w) => [w.id, w]));
  const agentActivityByWorkspace = new Map<string, WorkspaceAgentActivity>();
  for (const session of Object.values(sessionActivities || {})) {
    if (!session?.workspaceId || !session.agentLike || !session.hasUserInput) continue;
    if (session.activity !== "running" && session.activity !== "done") continue;
    const workspace = byId.get(session.workspaceId);
    const panelTitle =
      workspace?.panels?.find((panel) => panel.id === session.panelId)?.title || session.panelId || "Agent";
    const current = agentActivityByWorkspace.get(session.workspaceId);
    if (session.activity === "running") {
      agentActivityByWorkspace.set(session.workspaceId, {
        state: "running",
        panelTitle: current?.state === "running" ? current.panelTitle : panelTitle,
        runningCount: (current?.runningCount || 0) + 1,
        doneCount: current?.doneCount || 0,
        latestDoneAt: current?.latestDoneAt || 0,
      });
    } else {
      const finishedAt = Number(session.lastCommandFinishedAt || 0);
      agentActivityByWorkspace.set(session.workspaceId, {
        state: current?.state === "running" ? "running" : "done",
        panelTitle:
          !current || (current.state !== "running" && finishedAt >= current.latestDoneAt)
            ? panelTitle
            : current.panelTitle,
        runningCount: current?.runningCount || 0,
        doneCount: (current?.doneCount || 0) + 1,
        latestDoneAt: Math.max(current?.latestDoneAt || 0, finishedAt),
      });
    }
  }
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
    const agentActivity = agentActivityByWorkspace.get(workspace.id);
    const workspaceAgentState = workspace.kind === "task" ? null : agentActivity?.state || null;
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

    // Task-agent-specific affordances: stable "#N" suffix on the display name
    // (via shared helper so Telegram alerts use the same string) and a
    // relative-age chip so two agents on the same parent are visually
    // distinct. Persisted name stays unchanged — these are render-only.
    const isTask = workspace.kind === "task";
    const displayName = formatWorkspaceDisplayName(workspace);
    const relativeAge = isTask ? formatRelativeAge(workspace.task?.createdAt) : "";
    const taskDescription = isTask ? truncateForTooltip(workspace.task?.description || "") : "";

    const baseTitle = attention?.count ? attentionTooltip : displayName;
    const mergeOrPrSegment = worktreeMerged
      ? "\nBranch merged"
      : prStatus && prStatus !== "active"
        ? `\nPR ${prStatus}${prStatusInfo?.closedDate ? ` · ${new Date(prStatusInfo.closedDate).toLocaleDateString()}` : ""}`
        : "";
    const taskTooltipSegment = taskDescription ? `\n\n${taskDescription}` : "";
    const shortcutSegment = index < 9 ? ` (Ctrl+${index + 1})` : "";

    // "Last activity" = the most recent thing that happened on this workspace,
    // whichever signal it came from: remote PR activity (commit / comment /
    // creation, folded into the PR summary's lastActivityAt), a local session
    // alert (attention.latestAt), or the last local write (gitSnapshot's
    // lastChangeAt — newest of the last commit/checkout and any uncommitted
    // working-tree edit). The git log's own dates are --date=relative and not
    // parseable, which is why lastChangeAt is computed separately.
    const lastActivityAt = mostRecentIso(prStatusInfo?.lastActivityAt, attention?.latestAt, gitSnapshot?.lastChangeAt);
    const lastActivity = formatRelativeAge(lastActivityAt);
    let lastActivityTitle = "";
    if (lastActivityAt) {
      try {
        lastActivityTitle = `Last activity: ${new Date(lastActivityAt).toLocaleString()}`;
      } catch {
        lastActivityTitle = `Last activity: ${lastActivity}`;
      }
    }
    const lastActivitySegment = lastActivityTitle ? `\n${lastActivityTitle}` : "";

    return {
      id: workspace.id,
      index: index + 1,
      icon: workspace.icon,
      name: displayName,
      active,
      color: safeColor(workspace.color),
      summary,
      title: `${baseTitle}${mergeOrPrSegment}${lastActivitySegment}${taskTooltipSegment}${shortcutSegment}`,
      attentionCount: attention?.count || 0,
      attentionFresh: isFreshAttention(attention),
      attentionTooltip,
      kind: workspace.kind || "terminal",
      gitAvailable: !!gitSnapshot?.available,
      depth,
      checksState,
      prStatus,
      taskState: taskState || null,
      agentActivityState: workspaceAgentState,
      agentActivityLabel:
        workspaceAgentState === "running"
          ? (agentActivity?.runningCount || 0) > 1
            ? `${agentActivity?.runningCount} agents are working`
            : `${agentActivity?.panelTitle || "Agent"} is working`
          : workspaceAgentState === "done"
            ? (agentActivity?.doneCount || 0) > 1
              ? `${agentActivity?.doneCount} agents finished`
              : `${agentActivity?.panelTitle || "Agent"} finished`
            : "",
      starred: Boolean(workspace.starred),
      relativeAge,
      lastActivity,
      lastActivityTitle,
    };
  });
}
