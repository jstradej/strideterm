import { attentionTitle, isFreshAttention, safeColor, tabAttentionTitle, isFreshAlert } from "./helpers.js";

export function buildTabStripModel({ tabs, activeViewId, isInSplitGroup, getTabAttention }) {
  return tabs.map((session) => {
    const tabAttention = getTabAttention(session.id);
    const attentionTooltip = tabAttentionTitle(tabAttention);
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
      attentionFresh: isFreshAlert(tabAttention),
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
}) {
  return workspaces.map((workspace, index) => {
    const active = workspace.id === activeWorkspaceId;
    const gitSnapshot = getGitSnapshot(workspace.id);
    const attention = getWorkspaceAttention(workspace.id);
    const attentionTooltip = attentionTitle(attention);
    const isReviewChild =
      ["azure-devops", "github"].includes(workspace.review?.provider) &&
      workspace.review?.checkout?.mode === "managed-worktree";
    const isQuickFixChild = !!workspace.quickfix?.parentWorkspaceId;
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
    const summary =
      workspace.kind === "docker"
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
      isWorktree: (workspace.notes || "").startsWith("Worktree of ") || isReviewChild || isQuickFixChild,
      checksState,
      prStatus,
    };
  });
}
