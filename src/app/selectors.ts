import type { StatePayload, WorkspaceState, PanelState } from "../../electron/shared/types/state.js";

// ---------------------------------------------------------------------------
// Local structural types used by selectors
// ---------------------------------------------------------------------------

interface SessionLike {
  sessionId: string;
  panelId: string;
  title: string;
  status: string;
  activity?: string;
  lastExitCode?: number | null;
}

interface WorkspaceContainer {
  workspace?: WorkspaceState;
  project?: WorkspaceState;
  sessions: SessionLike[];
}

interface AttentionAlert {
  sessionId?: string;
  panelId?: string;
  kind?: string;
  at?: string;
  [key: string]: unknown;
}

interface AttentionEntry {
  alerts?: AttentionAlert[];
}

interface SplitGroup {
  viewIds: string[];
  [key: string]: unknown;
}

interface WorkspaceTab {
  id: string;
  type: string;
  title: string;
  status: string;
  tone: string;
  persistent?: boolean;
  closable?: boolean;
  url?: string;
}

// ---------------------------------------------------------------------------

export function summarizeAttention(
  payload: StatePayload | null | undefined,
  profileId?: string | null,
): {
  count: number;
  waitingCount: number;
} {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const byWorkspace = (payload?.attention as any)?.byWorkspace as Record<string, AttentionEntry> | undefined;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const byProject = (payload?.attention as any)?.byProject as Record<string, AttentionEntry> | undefined;
  const buckets = (byWorkspace || byProject || {}) as Record<string, AttentionEntry>;

  // When a profileId is supplied, restrict the count to workspaces in that
  // profile. Without this filter the in-app title/badge in a multi-profile
  // setup includes alerts from profiles the window can't see — the user in
  // profile B sees "(5)" but only 3 are theirs.
  let visibleEntries: AttentionEntry[];
  if (profileId) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const workspaces = (payload?.appState?.workspaces as any[] | undefined) || [];
    const idsInProfile = new Set(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      workspaces.filter((ws: any) => (ws.profileId || "default") === profileId).map((ws: any) => ws.id),
    );
    visibleEntries = Object.entries(buckets)
      .filter(([wsId]) => idsInProfile.has(wsId))
      .map(([, entry]) => entry);
  } else {
    visibleEntries = Object.values(buckets);
  }

  const alerts = visibleEntries
    .flatMap((entry) => entry?.alerts || [])
    .sort((left, right) => new Date(right.at ?? "").getTime() - new Date(left.at ?? "").getTime());
  return {
    count: alerts.length,
    waitingCount: alerts.filter((alert) => alert.kind === "waiting").length,
  };
}

// Derive the status chip shown on a terminal tab. Backend sets activity to
// "running" between command start and end (OSC 133;C → ;D, or agent
// UserPromptSubmit → Stop), "done" for ~3 s after finish, then "idle".
// An idle tab gets no chip text — avoids the misleading permanent "running"
// label the old code showed for every open PTY.
function terminalStatusDisplay(session: SessionLike): { status: string; tone: string } {
  if (session.status === "exited") return { status: "exited", tone: "error" };
  const activity = session.activity || "idle";
  if (activity === "running") return { status: "running", tone: "running" };
  if (activity === "done") {
    const exit = session.lastExitCode;
    if (exit == null || exit === 0) return { status: "✓ done", tone: "running" };
    return { status: `✗ exit ${exit}`, tone: "error" };
  }
  return { status: "", tone: "idle" };
}

function getHeadlessJudgeTabMeta(
  activeWorkspace: WorkspaceState,
  payload: StatePayload | null | undefined,
  panelId: string,
): { type: string; status: string; tone: string } | null {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const liveTask = (payload?.taskRunner as any)?.[activeWorkspace?.id] as Record<string, unknown> | undefined;
  if (!liveTask || liveTask.judgeExecutionMode !== "headless-copilot" || panelId !== liveTask.judgePanelId) {
    return null;
  }

  const state = String(liveTask.state || "idle");
  const running = !!liveTask.judgeProgrammaticRunning;
  let status = "headless judge";
  if (running || state === "judge-evaluating") status = "headless judge";
  else if (state === "completed") status = "headless result";
  else if (state === "failed") status = "headless error";
  else if (state === "paused") status = "headless paused";
  else if (state === "idle") status = "headless ready";

  return {
    type: "headless-judge",
    status,
    tone: state === "failed" ? "error" : running || state === "judge-evaluating" ? "running" : "idle",
  };
}

export function getWorkspaceAttention(
  payload: StatePayload | null | undefined,
  workspaceId: string,
): AttentionEntry | null {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const byWorkspace = (payload?.attention as any)?.byWorkspace as Record<string, AttentionEntry> | undefined;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const byProject = (payload?.attention as any)?.byProject as Record<string, AttentionEntry> | undefined;
  return byWorkspace?.[workspaceId] || byProject?.[workspaceId] || null;
}

export function getTabAttention(
  payload: StatePayload | null | undefined,
  workspaceId: string,
  viewId: string,
  helpers: { isGitViewId: (v: unknown) => boolean; isDockerViewId: (v: unknown) => boolean },
): AttentionAlert | null {
  if (!workspaceId || !viewId || helpers.isGitViewId(viewId) || helpers.isDockerViewId(viewId)) {
    return null;
  }

  const workspaceAttention = getWorkspaceAttention(payload, workspaceId);
  if (!workspaceAttention?.alerts?.length) {
    return null;
  }

  const panelId = String(viewId).split(":").slice(1).join(":");
  return workspaceAttention.alerts.find((alert) => alert.sessionId === viewId || alert.panelId === panelId) || null;
}

export function getWorkspaceTabs({
  workspace,
  payload,
  hiddenViewIds,
  isContainerRunning,
}: {
  workspace: WorkspaceContainer | null | undefined;
  payload: StatePayload | null | undefined;
  hiddenViewIds: Set<string>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  isContainerRunning: (container: any) => boolean;
}): WorkspaceTab[] {
  if (!workspace) {
    return [];
  }

  const activeWorkspace = workspace.workspace ?? workspace.project;
  if (!activeWorkspace) {
    return [];
  }
  const panels: PanelState[] = activeWorkspace.panels || [];
  const panelMap = new Map(panels.map((panel) => [panel.id, panel]));

  if (activeWorkspace.kind === "azure") {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const azureData = (payload?.azureDevops as any) || {};
    const inbox = azureData.inbox;
    // Scope the tab's "N reviews waiting" status to PRs from this workspace's
    // own profile — the backend snapshot aggregates inbox across every open
    // profile, so without scoping a Default 2 workspace tab would still show
    // counts from an asdf-profile connection's PRs.
    const workspaceProfileId = activeWorkspace.profileId || "default";

    const myConnectionIds = new Set(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ((azureData.connections || []) as any[])
        .filter((c) => (c.profileId || "default") === workspaceProfileId)
        .map((c) => c.id),
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const scopePrs = (prs: any) =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      Array.isArray(prs) ? (prs as any[]).filter((pr) => myConnectionIds.has(pr.connectionId)) : [];
    const needsMyReview = scopePrs(inbox?.needsMyReview);
    const needsAttention = scopePrs(inbox?.needsAttention);
    const azureTab: WorkspaceTab = {
      id: `azure:${activeWorkspace.id}`,
      type: "azure",
      title: "Azure DevOps",
      status: `${needsMyReview.length} reviews waiting`,
      tone: needsAttention.length > 0 ? "error" : "running",
      persistent: true,
      closable: false,
    };
    return hiddenViewIds.has(azureTab.id) ? [] : [azureTab];
  }

  if (activeWorkspace.kind === "github") {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const githubData = (payload?.github as any) || {};
    const inbox = githubData.inbox;
    // See azure branch above for rationale.
    const workspaceProfileId = activeWorkspace.profileId || "default";
    const myConnectionIds = new Set(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ((githubData.connections || []) as any[])
        .filter((c) => (c.profileId || "default") === workspaceProfileId)
        .map((c) => c.id),
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const scopePrs = (prs: any) =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      Array.isArray(prs) ? (prs as any[]).filter((pr) => myConnectionIds.has(pr.connectionId)) : [];
    const needsMyReview = scopePrs(inbox?.needsMyReview);
    const needsAttention = scopePrs(inbox?.needsAttention);
    const githubTab: WorkspaceTab = {
      id: `github:${activeWorkspace.id}`,
      type: "github",
      title: "GitHub",
      status: `${needsMyReview.length} reviews waiting`,
      tone: needsAttention.length > 0 ? "error" : "running",
      persistent: true,
      closable: false,
    };
    return hiddenViewIds.has(githubTab.id) ? [] : [githubTab];
  }

  // Identify browser panels (URL commands), files panels, and task-dashboard panels — these get virtual tabs, not terminal sessions
  const browserPanelIds = new Set(panels.filter((p) => /^https?:\/\//i.test(p.command || "")).map((p) => p.id));
  const filesPanelIds = new Set(panels.filter((p) => p.command === "__files__").map((p) => p.id));
  const taskDashboardPanelIds = new Set(panels.filter((p) => p.command === "__task-dashboard__").map((p) => p.id));
  const nonTerminalPanelIds = new Set([...browserPanelIds, ...filesPanelIds, ...taskDashboardPanelIds]);

  // Terminal tabs from real sessions (exclude sessions for non-terminal panels)
  const tabs: WorkspaceTab[] = [
    ...(["azure-devops", "github"].includes(activeWorkspace.review?.provider ?? "")
      ? [
          {
            id: `review:${activeWorkspace.id}`,
            type: "review",
            title: "Review",
            status:
              activeWorkspace.review?.pullRequest?.title ||
              (activeWorkspace.quickfix
                ? "No PR yet"
                : `${activeWorkspace.review?.provider === "github" ? "GitHub" : "Azure"} review`),
            tone: activeWorkspace.review?.pullRequest ? "running" : "idle",
            persistent: true,
            closable: false,
          },
        ]
      : []),
    ...workspace.sessions
      .filter((session) => !nonTerminalPanelIds.has(session.panelId))
      .map((session) => {
        const headlessJudge = getHeadlessJudgeTabMeta(activeWorkspace, payload, session.panelId);
        const disp = terminalStatusDisplay(session);
        return {
          id: session.sessionId,
          type: headlessJudge?.type || "terminal",
          title: session.title,
          status: headlessJudge?.status ?? disp.status,
          tone: headlessJudge?.tone ?? disp.tone,
          persistent: panelMap.has(session.panelId),
          closable: true,
        };
      }),
  ];

  // Browser tabs from panels directly (stable ID, no backend session dependency)
  for (const panel of panels) {
    if (browserPanelIds.has(panel.id)) {
      let domain = "";
      try {
        const h = new URL(panel.command).hostname;
        const p = h.split(".");
        domain =
          p.length <= 2
            ? h
            : p[p.length - 2].length <= 3 && p.length >= 3
              ? p.slice(-3).join(".")
              : p.slice(-2).join(".");
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

  // Files tabs from panels with __files__ command
  for (const panel of panels) {
    if (filesPanelIds.has(panel.id)) {
      tabs.push({
        id: `files:${panel.id}`,
        type: "files",
        title: panel.title || "Files",
        status: "browse",
        tone: "running",
        persistent: true,
        closable: true,
      });
    }
  }

  // Task dashboard tabs from panels with __task-dashboard__ command
  for (const panel of panels) {
    if (taskDashboardPanelIds.has(panel.id)) {
      tabs.push({
        id: `task-dashboard:${panel.id}`,
        type: "task-dashboard",
        title: panel.title || "Dashboard",
        status: "dashboard",
        tone: "running",
        persistent: true,
        closable: false,
      });
    }
  }

  if (activeWorkspace.kind === "docker") {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const dockerState = (payload?.docker as any) || {};

    const containers: unknown[] = (dockerState.containers as unknown[] | undefined) || [];
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

  const gitSnapshot =
    payload?.git?.workspaces?.[activeWorkspace.id] || payload?.git?.projects?.[activeWorkspace.id] || null;
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
  forceSoloLayout = false,
}: {
  tabs: WorkspaceTab[];
  activeViewId: string | null;
  splitGroup: SplitGroup | null;
  isInSplitGroup: (viewId: string | null, group: SplitGroup) => boolean;
  /**
   * When true, only the active tab is rendered even if `splitGroup` is set.
   * The returned `splitGroup` is preserved so that flipping the flag back to
   * false (e.g. resizing from mobile to desktop) restores the original layout
   * without the caller having to re-create it.
   */
  forceSoloLayout?: boolean;
}): {
  activeViewId: string | null;
  splitGroup: SplitGroup | null;
  visibleTabs: WorkspaceTab[];
} {
  const validIds = new Set(tabs.map((tab) => tab.id));
  const next: { activeViewId: string | null; splitGroup: SplitGroup | null } = {
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

  let visibleIds: string[];
  if (forceSoloLayout) {
    // Phone-width viewport: hide every tab except the active one. The
    // splitGroup state is intentionally returned unchanged so that resizing
    // back to desktop re-renders the full split layout without the user
    // having to re-pick it.
    visibleIds = next.activeViewId ? [next.activeViewId] : [];
  } else if (next.splitGroup && isInSplitGroup(next.activeViewId, next.splitGroup)) {
    visibleIds = [...next.splitGroup.viewIds];
  } else {
    visibleIds = next.activeViewId ? [next.activeViewId] : [];
  }

  return {
    activeViewId: next.activeViewId,
    splitGroup: next.splitGroup,
    visibleTabs: visibleIds
      .map((viewId) => tabs.find((tab) => tab.id === viewId))
      .filter((t): t is WorkspaceTab => Boolean(t)),
  };
}

export function getWorkspacePanelByViewId(
  viewId: string,
  workspace: WorkspaceContainer | null | undefined,
  helpers: {
    isGitViewId: (v: unknown) => boolean;
    isDockerViewId: (v: unknown) => boolean;
    isAzureViewId: (v: unknown) => boolean;
    isGitHubViewId?: (v: unknown) => boolean;
    isReviewViewId: (v: unknown) => boolean;
  },
): { workspace: WorkspaceState; panel: PanelState } | null {
  if (
    !workspace ||
    helpers.isGitViewId(viewId) ||
    helpers.isDockerViewId(viewId) ||
    helpers.isAzureViewId(viewId) ||
    helpers.isGitHubViewId?.(viewId) ||
    helpers.isReviewViewId(viewId)
  ) {
    return null;
  }

  const activeWorkspace = workspace.workspace ?? workspace.project;
  const panelId = String(viewId || "")
    .split(":")
    .slice(1)
    .join(":");
  if (!panelId) {
    return null;
  }

  const panel = activeWorkspace?.panels?.find((entry) => entry.id === panelId) || null;
  if (!panel || !activeWorkspace) {
    return null;
  }

  return { workspace: activeWorkspace, panel };
}
