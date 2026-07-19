import type { AppState, WorkspaceState, PanelState } from "../shared/types/state.js";
import type { Logger } from "./logger.js";

// Type returned by createSessionSignal in runtime-utils.ts
type SessionSignal = ReturnType<typeof import("./runtime-utils.js").createSessionSignal>;

interface ProjectAlertEntry {
  projectId: string;
  panelId: string;
  sessionId: string;
  title: string;
  exitCode: number | null;
  kind: string;
  tier: number;
  urgency: string;
  detail: string;
  at: string;
}

interface ProjectAlertBucket {
  count: number;
  latestAt: string | null;
  alerts: ProjectAlertEntry[];
}

interface AttentionContext {
  // Effective visible set — the UNION of visibleByViewer. Read by
  // isSessionVisible; never assigned directly except via recomputeVisibleUnion.
  visibleSessionIds: Set<string>;
  recentlyVisibleUntil: Map<string, number>;
  // Per-viewer visible sets keyed by windowId / remote viewer id. See
  // createAttentionContext for why a single global set was insufficient.
  visibleByViewer: Map<string, Set<string>>;
}

interface SessionsManager {
  ensureSession(state: AppState, sessionId: string): Promise<unknown>;
  resolveDefaultSessionId(state: AppState, workspaceId: string): string | null;
}

interface AppConfigShape {
  runtime: { projectAlertLimit: number };
  ui: { defaultPanelStartup: string };
}

interface RaiseAlertOptions {
  sessionId: string;
  projectId: string;
  panelId: string;
  title: string;
  kind?: string;
  tier?: number;
  urgency?: string;
  detail?: string;
  exitCode?: number | null;
}

interface AddProjectAlertOptions {
  projectId: string;
  panelId: string;
  sessionId: string;
  title: string;
  exitCode?: number | null;
  kind?: string;
  detail?: string;
  tier?: number;
  urgency?: string;
}

interface CreateRuntimeAttentionManagerOptions {
  log: Logger;
  getState: () => AppState;
  sessions: SessionsManager;
  createSessionId: (workspaceId: string, panelId: string) => string;
  parseSessionId: (sessionId: string) => { workspaceId: string; panelId: string } | null;
  getNotificationConfig: () => { debug?: boolean };
  createSessionSignal: (sessionId: string) => SessionSignal;
  adaptiveForget: (sessionId: string) => void;
  metricsRecordAlert: (opts: { tier: number; kind: string; urgency: string; commandClass: string }) => void;
  APP_CONFIG: AppConfigShape;
  AGENT_NAME_RE: RegExp;
  ATTENTION_VISIBILITY_GRACE_MS: number;
  attentionContext: AttentionContext;
  broadcastState: () => void;
  isKnownPluginProject: (project: WorkspaceState) => boolean;
  // Task workspaces flagged as recovery candidates must NOT auto-spawn their
  // worker/judge PTYs — the user picks resume/skip from the recovery dialog
  // and the runner handles the spawn itself. Returns an empty set when no
  // candidates are pending (the common case).
  getRecoveryCandidateIds?: () => Set<string>;
}

export function createRuntimeAttentionManager({
  log,
  getState,
  sessions,
  createSessionId,
  parseSessionId,
  getNotificationConfig,
  createSessionSignal,
  adaptiveForget,
  metricsRecordAlert,
  APP_CONFIG,
  AGENT_NAME_RE,
  ATTENTION_VISIBILITY_GRACE_MS,
  attentionContext,
  broadcastState,
  isKnownPluginProject,
  getRecoveryCandidateIds,
}: CreateRuntimeAttentionManagerOptions) {
  const projectAlerts = new Map<string, ProjectAlertBucket>();
  const sessionSignals = new Map<string, SessionSignal>();

  function getAttentionSnapshot() {
    const sessionsSnapshot: Record<string, unknown> = {};
    for (const [sessionId, signal] of sessionSignals) {
      const descriptor = parseSessionId(sessionId);
      if (!descriptor) continue;
      const workspaceAlerts = projectAlerts.get(descriptor.workspaceId)?.alerts || [];
      const panelAlert = workspaceAlerts.find((alert) => alert.panelId === descriptor.panelId);
      const lastActivityMs = Math.max(
        signal.lastOutputAt || 0,
        signal.lastPromptAt || 0,
        signal.lastCommandFinishedAt || 0,
        signal.lastUserInteractionAt || 0,
      );
      sessionsSnapshot[sessionId] = {
        sessionId,
        workspaceId: descriptor.workspaceId,
        panelId: descriptor.panelId,
        lastActivity: lastActivityMs ? new Date(lastActivityMs).toISOString() : "",
        alertKind: panelAlert?.kind ?? null,
        alertedAt: panelAlert?.at ?? null,
        activity: signal.activity || "idle",
        agentLike: Boolean(signal.agentLike),
        hasUserInput: Boolean(signal.hasUserInput),
        lastExitCode: signal.lastExitCode,
        lastCommandFinishedAt: signal.lastCommandFinishedAt || 0,
      };
    }
    const byWorkspace = Object.fromEntries(projectAlerts.entries());
    return {
      sessions: sessionsSnapshot,
      byWorkspace,
      // Wire-compat alias: older clients still read byProject.
      byProject: byWorkspace,
    };
  }

  function cancelPromptTimer(signal: SessionSignal | undefined): void {
    if (!signal?.promptTimer) {
      return;
    }
    clearTimeout(signal.promptTimer);
    signal.promptTimer = null;
  }

  function resetSessionSignal(sessionId: string): void {
    const signal = sessionSignals.get(sessionId);
    if (!signal) {
      return;
    }
    const wasBusy = signal.busy;
    const wasWaiting = signal.waitingRaised;
    cancelPromptTimer(signal);
    signal.busy = false;
    signal.waitingRaised = false;
    signal.outputBursts = 0;
    signal.lastOutputAt = 0;
    signal.lastHookAlertAt = 0;
    if (wasBusy || wasWaiting) {
      log.trace("session signal reset", { sessionId, wasBusy, wasWaiting });
    }
  }

  function deleteSessionSignal(sessionId: string): void {
    const signal = sessionSignals.get(sessionId);
    cancelPromptTimer(signal);
    sessionSignals.delete(sessionId);
    adaptiveForget(sessionId);
  }

  function addProjectAlert({
    projectId,
    panelId,
    sessionId,
    title,
    exitCode = null,
    kind = "completed",
    detail = "",
    tier = 1,
    urgency = "normal",
  }: AddProjectAlertOptions): void {
    log.debug("addProjectAlert", { projectId, panelId, sessionId, title, kind, tier, urgency, detail, exitCode });
    const current = projectAlerts.get(projectId) || {
      count: 0,
      latestAt: null,
      alerts: [],
    };
    const nextAlerts = [
      {
        projectId,
        panelId,
        sessionId,
        title,
        exitCode,
        kind,
        tier,
        urgency,
        detail,
        at: new Date().toISOString(),
      },
      ...current.alerts.filter((alert) => alert.panelId !== panelId),
    ].slice(0, APP_CONFIG.runtime.projectAlertLimit);

    projectAlerts.set(projectId, {
      count: nextAlerts.length,
      latestAt: nextAlerts[0]?.at || null,
      alerts: nextAlerts,
    });
  }

  function clearProjectAlerts(projectId: string, panelId: string | null = null): void {
    if (!projectId || !projectAlerts.has(projectId)) {
      return;
    }

    if (!panelId) {
      log.trace("clearing all alerts for project", { projectId });
      projectAlerts.delete(projectId);
      return;
    }
    log.trace("clearing alert", { projectId, panelId });

    const current = projectAlerts.get(projectId)!;
    const nextAlerts = current.alerts.filter((alert) => alert.panelId !== panelId);
    if (!nextAlerts.length) {
      projectAlerts.delete(projectId);
      return;
    }

    projectAlerts.set(projectId, {
      ...current,
      count: nextAlerts.length,
      alerts: nextAlerts,
    });
  }

  function clearAlertSession(sessionId: string): boolean {
    const descriptor = parseSessionId(sessionId);
    if (!descriptor) {
      return false;
    }

    const current = projectAlerts.get(descriptor.workspaceId);
    if (!current?.alerts?.some((alert) => alert.panelId === descriptor.panelId)) {
      return false;
    }

    clearProjectAlerts(descriptor.workspaceId, descriptor.panelId);
    resetSessionSignal(sessionId);
    return true;
  }

  function getSessionSignal(
    sessionId: string,
    project: WorkspaceState | null,
    panel: PanelState | null,
  ): SessionSignal {
    const isNew = !sessionSignals.has(sessionId);
    const current = sessionSignals.get(sessionId) || createSessionSignal(sessionId);
    if (!current.agentLike) {
      const wasAgent = current.agentLike;
      current.agentLike = AGENT_NAME_RE.test(panel?.command || "") || AGENT_NAME_RE.test(panel?.title || "");
      if (!wasAgent && current.agentLike) {
        log.debug("session classified as agent-like", { sessionId, command: panel?.command, title: panel?.title });
      }
    }
    if (isNew) {
      log.trace("session signal created", { sessionId, agentLike: current.agentLike });
    }
    sessionSignals.set(sessionId, current);
    return current;
  }

  function raiseAlert({
    sessionId,
    projectId,
    panelId,
    title,
    kind = "waiting",
    tier = 1,
    urgency = "normal",
    detail = "",
    exitCode = null,
  }: RaiseAlertOptions): boolean {
    const signal = sessionSignals.get(sessionId);

    if (kind === "waiting" && urgency !== "urgent" && signal?.waitingRaised) {
      log.trace("raiseAlert skipped: waiting already raised", { sessionId, detail });
      return false;
    }

    // Belt-and-suspenders: even if some upstream path forgets to ask the
    // task runner first (or a race lets a stale silence timer fire after
    // task state changed), suppress "waiting for input" alerts for the
    // worker/judge panels of task workspaces while the runner owns the
    // turn. The runner explicitly drives prompts, evaluations, re-prompts
    // and verdicts — a "waiting for input" toast there is always wrong.
    // Urgent (e.g. permission_prompt) bypasses since those genuinely need
    // user attention.
    if (kind === "waiting" && urgency !== "urgent") {
      const state = getState();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const ws = state.workspaces.find((w: any) => w.id === projectId);
      if (ws?.kind === "task" && ws.task) {
        const taskState = ws.task.state || "";
        const isWorker = panelId === ws.task.workerPanelId;
        const isJudge = panelId === ws.task.judgePanelId;
        const runnerOwnsTurn =
          taskState === "running" ||
          taskState === "evaluating" ||
          taskState === "judge-evaluating" ||
          taskState === "refreshing";
        if ((isWorker || isJudge) && runnerOwnsTurn) {
          log.debug("raiseAlert suppressed: task runner owns this turn", {
            sessionId,
            taskState,
            panelRole: isWorker ? "worker" : "judge",
          });
          return false;
        }
      }
    }

    log.info("ALERT raised", { sessionId, projectId, panelId, title, kind, tier, urgency, detail, exitCode });
    if (getNotificationConfig().debug) {
      log.info("[notif-debug] alert-raised", {
        sessionId,
        tier,
        urgency,
        kind,
        detail,
        commandClass: signal?.commandClass || "",
        hookCapable: signal?.hookCapable || false,
        completionHookCapable: signal?.completionHookCapable || false,
        outputBursts: signal?.outputBursts || 0,
        lastHookType: signal?.lastHookType || "",
      });
    }
    metricsRecordAlert({ tier, kind, urgency, commandClass: signal?.commandClass || "" });
    addProjectAlert({
      projectId,
      panelId,
      sessionId,
      title,
      kind,
      tier,
      urgency,
      detail,
      exitCode,
    });
    if (signal) {
      if (kind === "waiting") {
        signal.waitingRaised = true;
      }
      signal.busy = false;
      signal.lastAlertAt = Date.now();
      signal.everAlerted = true;
      signal.outputBursts = 0;
    }
    broadcastState();
    return true;
  }

  function raiseWaitingAlert({
    sessionId,
    projectId,
    panelId,
    title,
    detail,
    urgency = "normal",
  }: {
    sessionId: string;
    projectId: string;
    panelId: string;
    title: string;
    detail?: string;
    urgency?: string;
  }): boolean {
    return raiseAlert({
      sessionId,
      projectId,
      panelId,
      title,
      kind: "waiting",
      tier: 1,
      urgency,
      detail,
    });
  }

  function ensureVisibleSession(workspaceId = getState().activeWorkspaceId): string | null {
    const state = getState();
    const workspace = state.workspaces.find((item) => item.id === workspaceId);
    if (!workspace || workspace.kind === "azure") return null;
    const recoveryIds = getRecoveryCandidateIds?.() || new Set<string>();
    if (recoveryIds.has(workspace.id)) {
      // Task workspace pending recovery: the dialog owns the spawn decision.
      return sessions.resolveDefaultSessionId(state, workspaceId);
    }
    for (const panel of workspace.panels) {
      if (panel.startup === APP_CONFIG.ui.defaultPanelStartup && !/^https?:\/\//i.test(panel.command || "")) {
        const sessionId = `${workspace.id}:${panel.id}`;
        // ensureSession is fire-and-forget here. If it rejects synchronously
        // wrapped in an async, the unhandled rejection vanishes — and the
        // user sees "0 running" with no clue why. Surface it at error level
        // so it shows up even on a "error"-only log level.
        sessions.ensureSession(state, sessionId).catch((err: unknown) => {
          log.error("ensureVisibleSession: ensureSession failed", {
            sessionId,
            err: (err as Error)?.message || String(err),
          });
        });
      }
    }
    return sessions.resolveDefaultSessionId(state, workspaceId);
  }

  function syncSessionSignalsWithState(): void {
    const validSessionIds = new Set(
      getState().workspaces.flatMap((workspace) =>
        workspace.panels.map((panel) => createSessionId(workspace.id, panel.id)),
      ),
    );
    for (const sessionId of [...sessionSignals.keys()]) {
      if (!validSessionIds.has(sessionId)) {
        deleteSessionSignal(sessionId);
      }
    }
  }

  function shouldTrackProjectAlert(project: WorkspaceState | null, panel: PanelState | null): boolean {
    return Boolean(
      project &&
      panel &&
      (project.kind === "terminal" || project.kind === "task") &&
      !isKnownPluginProject(project) &&
      !panel.launch?.file &&
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (panel as any).shell !== false,
    );
  }

  // Bucket for callers that don't identify a viewer: tests, and the
  // viewer-less activation "primer" (activateWorkspace with no windowId, used
  // by a legacy remote endpoint and a few internal restore paths). The primer
  // marks a freshly-activated workspace's panels visible so PTY startup output
  // doesn't false-alert before a renderer reports visibility. Real desktop
  // windows and remote clients always pass their own key — and the moment any
  // of them syncs, this primer is dropped (see updateVisibleSessions) so a
  // viewer-less activation can't pin its panels "visible" forever.
  const DEFAULT_VIEWER_KEY = "__default__";

  // Recompute the effective visible set (union of all viewers) and roll the
  // grace window for any session that just dropped OUT of the union. Sessions
  // that leave the union get ATTENTION_VISIBILITY_GRACE_MS of lingering
  // "recently visible" so brief tab switches don't immediately re-arm alerts.
  function recomputeVisibleUnion(): void {
    const prev = attentionContext.visibleSessionIds;
    const next = new Set<string>();
    for (const ids of attentionContext.visibleByViewer.values()) {
      for (const id of ids) next.add(id);
    }
    const now = Date.now();
    for (const sessionId of prev) {
      if (!next.has(sessionId)) {
        attentionContext.recentlyVisibleUntil.set(sessionId, now + ATTENTION_VISIBILITY_GRACE_MS);
      }
    }
    for (const sessionId of next) {
      attentionContext.recentlyVisibleUntil.delete(sessionId);
    }
    for (const [sessionId, until] of attentionContext.recentlyVisibleUntil) {
      if (now >= until) attentionContext.recentlyVisibleUntil.delete(sessionId);
    }
    attentionContext.visibleSessionIds = next;
  }

  // Record one viewer's currently-visible sessions. The effective visible set
  // is the UNION across all viewers, so a panel visible in ANY viewer counts
  // as visible — two concurrent viewers no longer overwrite each other.
  function updateVisibleSessions(nextIds: string[], viewerKey: string = DEFAULT_VIEWER_KEY): void {
    const next = new Set(nextIds);
    if (next.size === 0) {
      // Viewer is showing no tracked sessions (e.g. an Azure/GitHub review
      // pane). Drop its bucket so it contributes nothing — but DON'T let that
      // wipe other viewers' visible sessions from the union.
      attentionContext.visibleByViewer.delete(viewerKey);
    } else {
      attentionContext.visibleByViewer.set(viewerKey, next);
    }
    // An identified viewer reporting its real visibility supersedes the
    // viewer-less activation primer — drop it so a legacy/internal
    // activateWorkspace() with no windowId can't keep its workspace's panels
    // counted visible after a real viewer has reported otherwise.
    if (viewerKey !== DEFAULT_VIEWER_KEY) {
      attentionContext.visibleByViewer.delete(DEFAULT_VIEWER_KEY);
    }
    log.trace("updateVisibleSessions", {
      viewerKey,
      next: [...next],
      union: [...attentionContext.visibleSessionIds],
      viewers: attentionContext.visibleByViewer.size,
    });
    recomputeVisibleUnion();
  }

  // A viewer went away (desktop window closed, remote socket fully dropped).
  // Remove its contribution so its sessions stop counting as visible — without
  // this a disconnected client would suppress alerts on its panels forever.
  function dropViewerVisibility(viewerKey: string): void {
    if (!attentionContext.visibleByViewer.has(viewerKey)) return;
    attentionContext.visibleByViewer.delete(viewerKey);
    log.trace("dropViewerVisibility", { viewerKey, viewers: attentionContext.visibleByViewer.size });
    recomputeVisibleUnion();
  }

  function isSessionVisible(sessionId: string): boolean {
    if (attentionContext.visibleSessionIds.has(sessionId)) return true;
    const until = attentionContext.recentlyVisibleUntil.get(sessionId);
    return until != null && Date.now() < until;
  }

  function markSessionPromptInjected(sessionId: string): void {
    const signal = sessionSignals.get(sessionId);
    if (!signal) {
      return;
    }
    signal.busy = true;
    signal.hasUserInput = true;
    signal.waitingRaised = false;
  }

  return {
    projectAlerts,
    sessionSignals,
    getAttentionSnapshot,
    cancelPromptTimer,
    resetSessionSignal,
    deleteSessionSignal,
    addProjectAlert,
    clearProjectAlerts,
    clearAlertSession,
    getSessionSignal,
    raiseAlert,
    raiseWaitingAlert,
    ensureVisibleSession,
    syncSessionSignalsWithState,
    shouldTrackProjectAlert,
    updateVisibleSessions,
    dropViewerVisibility,
    isSessionVisible,
    markSessionPromptInjected,
  };
}
