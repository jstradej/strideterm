export function summarizeAttention(payload) {
  const alerts = Object.values(payload?.attention?.byWorkspace || payload?.attention?.byProject || {})
    .flatMap((entry) => entry?.alerts || [])
    .sort((left, right) => new Date(right.at).getTime() - new Date(left.at).getTime());
  return {
    count: alerts.length,
    waitingCount: alerts.filter((alert) => alert.kind === "waiting").length,
  };
}

export function getWorkspaceAttention(payload, workspaceId) {
  return payload?.attention?.byWorkspace?.[workspaceId] || payload?.attention?.byProject?.[workspaceId] || null;
}

export function getTabAttention(payload, workspaceId, viewId, { isGitViewId, isDockerViewId }) {
  if (!workspaceId || !viewId || isGitViewId(viewId) || isDockerViewId(viewId)) {
    return null;
  }

  const workspaceAttention = getWorkspaceAttention(payload, workspaceId);
  if (!workspaceAttention?.alerts?.length) {
    return null;
  }

  const panelId = String(viewId).split(":").slice(1).join(":");
  return workspaceAttention.alerts.find((alert) => (
    alert.sessionId === viewId || alert.panelId === panelId
  )) || null;
}

export function getWorkspaceTabs({
  workspace,
  payload,
  hiddenViewIds,
  statusTone,
  isContainerRunning,
}) {
  if (!workspace) {
    return [];
  }

  const activeWorkspace = workspace.workspace || workspace.project;
  const panels = activeWorkspace.panels || [];
  const panelMap = new Map(panels.map((panel) => [panel.id, panel]));

  if (activeWorkspace.kind === "azure") {
    const azureTab = {
      id: `azure:${activeWorkspace.id}`,
      type: "azure",
      title: "Azure DevOps",
      status: `${payload?.azureDevops?.inbox?.needsMyReview?.length || 0} reviews waiting`,
      tone: (payload?.azureDevops?.inbox?.needsAttention?.length || 0) > 0 ? "error" : "running",
      persistent: true,
      closable: false,
    };
    return hiddenViewIds.has(azureTab.id) ? [] : [azureTab];
  }

  // Identify browser panels (URL commands) — these get virtual tabs, not terminal sessions
  const browserPanelIds = new Set(panels.filter((p) => /^https?:\/\//i.test(p.command || "")).map((p) => p.id));

  // Terminal tabs from real sessions (exclude sessions for browser panels)
  const tabs = [
    ...(activeWorkspace.review?.provider === "azure-devops"
      ? [{
          id: `review:${activeWorkspace.id}`,
          type: "review",
          title: "Review",
          status: activeWorkspace.review.pullRequest?.title || (activeWorkspace.quickfix ? "No PR yet" : "Azure review"),
          tone: activeWorkspace.review.pullRequest ? "running" : "idle",
          persistent: true,
          closable: false,
        }]
      : []),
    ...workspace.sessions
      .filter((session) => !browserPanelIds.has(session.panelId))
      .map((session) => ({
        id: session.sessionId,
        type: "terminal",
        title: session.title,
        status: session.status,
        tone: statusTone(session.status),
        persistent: panelMap.has(session.panelId),
        closable: true,
      })),
  ];

  // Browser tabs from panels directly (stable ID, no backend session dependency)
  for (const panel of panels) {
    if (browserPanelIds.has(panel.id)) {
      let domain = "";
      try {
        const h = new URL(panel.command).hostname;
        const p = h.split(".");
        domain = p.length <= 2 ? h : (p[p.length - 2].length <= 3 && p.length >= 3 ? p.slice(-3).join(".") : p.slice(-2).join("."));
      } catch {}
      tabs.push({
        id: `browser:${panel.id}`,
        type: "browser",
        title: panel.title,
        status: domain || "browser",
        tone: "running",
        persistent: true,
        closable: true,
        url: panel.command,
      });
    }
  }

  if (activeWorkspace.kind === "docker") {
    const dockerState = payload?.docker || {};
    const containers = dockerState.containers || [];
    const runningCount = containers.filter(isContainerRunning).length;
    tabs.push({
      id: `docker:${activeWorkspace.id}`,
      type: "docker",
      title: "Docker",
      status: `${containers.length} containers, ${runningCount} up`,
      tone: runningCount > 0 ? "running" : "idle",
      closable: true,
    });
  }

  const gitSnapshot = payload?.git?.workspaces?.[activeWorkspace.id] || payload?.git?.projects?.[activeWorkspace.id] || null;
  if (gitSnapshot?.available) {
    tabs.push({
      id: `git:${activeWorkspace.id}`,
      type: "git",
      title: "Git",
      status: gitSnapshot.dirty ? `${gitSnapshot.dirtyCount} dirty` : "clean",
      tone: gitSnapshot.dirty ? "error" : "running",
      closable: true,
    });
  }

  return tabs.filter((tab) => !hiddenViewIds.has(tab.id));
}

export function getVisibleTabs({
  tabs,
  activeViewId,
  splitGroup,
  isInSplitGroup,
}) {
  const validIds = new Set(tabs.map((tab) => tab.id));
  const next = {
    activeViewId,
    splitGroup: splitGroup ? { ...splitGroup, viewIds: [...splitGroup.viewIds] } : null,
  };

  if (!next.activeViewId || !validIds.has(next.activeViewId)) {
    next.activeViewId = tabs[0]?.id || null;
  }

  if (next.splitGroup) {
    next.splitGroup.viewIds = next.splitGroup.viewIds.filter((id) => validIds.has(id));
    if (next.splitGroup.viewIds.length < 2) {
      next.splitGroup = null;
    }
  }

  let visibleIds;
  if (next.splitGroup && isInSplitGroup(next.activeViewId, next.splitGroup)) {
    visibleIds = [...next.splitGroup.viewIds];
  } else {
    visibleIds = next.activeViewId ? [next.activeViewId] : [];
  }

  return {
    activeViewId: next.activeViewId,
    splitGroup: next.splitGroup,
    visibleTabs: visibleIds
      .map((viewId) => tabs.find((tab) => tab.id === viewId))
      .filter(Boolean),
  };
}

export function getWorkspacePanelByViewId(viewId, workspace, { isGitViewId, isDockerViewId, isAzureViewId, isReviewViewId }) {
  if (!workspace || isGitViewId(viewId) || isDockerViewId(viewId) || isAzureViewId(viewId) || isReviewViewId(viewId)) {
    return null;
  }

  const activeWorkspace = workspace.workspace || workspace.project;
  const panelId = String(viewId || "").split(":").slice(1).join(":");
  if (!panelId) {
    return null;
  }

  const panel = activeWorkspace?.panels?.find((entry) => entry.id === panelId) || null;
  if (!panel) {
    return null;
  }

  return { workspace: activeWorkspace, panel };
}
