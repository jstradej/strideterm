import {
  attentionTitle,
  escapeHtml,
  isContainerRunning,
  isFreshAlert,
  isFreshAttention,
  safeColor,
  tabAttentionTitle,
} from "./helpers.js";

export function renderWorkspaceHero({
  workspace,
  dockerState = {},
  gitSnapshot,
  attention,
  remoteConnectionIssue = "",
  isRemote = false,
}) {
  if (!workspace) {
    return `
      ${isRemote && remoteConnectionIssue ? `<div class="workspace-remote-alert"><strong>Remote connection issue.</strong> ${escapeHtml(remoteConnectionIssue)}</div>` : ""}
      <p class="workspace-empty-copy">Select or create a workspace to open it.</p>
    `;
  }

  const activeWorkspace = workspace.workspace || workspace.project;
  const running = workspace.sessions.filter((session) => session.status === "running").length;
  const accent = safeColor(activeWorkspace.color);
  const gitBranchHtml = gitSnapshot?.available
    ? `<span class="workspace-chip" style="border-color:${gitSnapshot.dirty ? "rgba(255,111,141,0.4)" : "rgba(110,223,182,0.4)"};">
         <strong style="color:${gitSnapshot.dirty ? "#ff6f8d" : "#6edfb6"};">${escapeHtml(gitSnapshot.branch)}</strong>
         ${gitSnapshot.dirty ? `<span style="color:#ff6f8d;margin-left:4px;">${escapeHtml(String(gitSnapshot.dirtyCount))} uncommitted</span>` : '<span style="color:#6edfb6;margin-left:4px;">clean</span>'}
       </span>`
    : "";
  const dockerInfoHtml = activeWorkspace.kind === "docker" && dockerState.available
    ? `<span class="workspace-chip"><strong>${(dockerState.containers || []).filter(isContainerRunning).length}</strong>/${(dockerState.containers || []).length} containers up</span>`
    : "";
  const attentionFresh = isFreshAttention(attention);
  const attentionTooltip = attentionTitle(attention);

  return `
    ${isRemote && remoteConnectionIssue ? `<div class="workspace-remote-alert"><strong>Remote connection issue.</strong> ${escapeHtml(remoteConnectionIssue)}</div>` : ""}
    <div class="workspace-meta" style="--accent:${accent}">
      <div class="workspace-meta__main">
        <span class="workspace-meta__path" title="${escapeHtml(activeWorkspace.cwd || "")}">${escapeHtml(activeWorkspace.cwd || "Not set")}</span>
      </div>
      <div class="workspace-meta__stats">
        <span class="workspace-chip"><strong>${workspace.sessions.length}</strong> tabs</span>
        <span class="workspace-chip"><strong>${running}</strong> running</span>
        ${gitBranchHtml}
        ${dockerInfoHtml}
        ${
          attention?.count
            ? `<span class="workspace-chip workspace-chip--alert ${attentionFresh ? "workspace-chip--alert-fresh" : ""}" title="${escapeHtml(attentionTooltip)}"><strong>${escapeHtml(String(attention.count))}</strong> attention</span>`
            : ""
        }
      </div>
    </div>
  `;
}

export function buildTabStripModel({
  tabs,
  activeViewId,
  isInSplitGroup,
  getTabAttention,
}) {
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
      attention: !!tabAttention,
      attentionFresh: isFreshAlert(tabAttention),
      attentionTooltip,
      titleTooltip: attentionTooltip || (session.persistent ? "Double click to rename. Drag to reorder." : session.title),
    };
  });
}

export function renderTabActions({
  workspaceKind,
  splitGroup,
  currentLayout,
  layouts,
}) {
  return `
    ${
      workspaceKind !== "docker"
        ? '<button class="button button--ghost" data-action="toggle-tab-picker">+ Tab</button>'
        : ""
    }
    ${
      splitGroup
        ? '<button class="button button--ghost" data-action="disband-split">Unsplit</button>'
        : ""
    }
    <button class="button button--ghost ${currentLayout !== "solo" ? "button--active" : ""}" data-action="open-layout-picker" title="Layout">
      ${currentLayout !== "solo" ? escapeHtml(layouts[currentLayout]?.label || "Split") : "Split"}
    </button>
  `;
}

export function buildWorkspaceCards({
  workspaces,
  activeWorkspaceId,
  getGitSnapshot,
  getWorkspaceAttention,
}) {
  return workspaces.map((workspace, index) => {
    const active = workspace.id === activeWorkspaceId;
    const gitSnapshot = getGitSnapshot(workspace.id);
    const attention = getWorkspaceAttention(workspace.id);
    const attentionTooltip = attentionTitle(attention);
    const summary = workspace.kind === "docker"
      ? "Docker"
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
      title: `${attention?.count ? attentionTooltip : workspace.name}${index < 9 ? ` (Ctrl+${index + 1})` : ""}`,
      attentionCount: attention?.count || 0,
      attentionFresh: isFreshAttention(attention),
      attentionTooltip,
      gitAvailable: !!gitSnapshot?.available,
      isWorktree: (workspace.notes || "").startsWith("Worktree of "),
    };
  });
}
