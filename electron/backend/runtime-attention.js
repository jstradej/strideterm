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
}) {
  const projectAlerts = new Map();
  const sessionSignals = new Map();

  function getAttentionSnapshot(state = getState()) {
    return {
      byWorkspace: Object.fromEntries(projectAlerts.entries()),
      byProject: Object.fromEntries(projectAlerts.entries()),
      activeWorkspace: projectAlerts.get(state.activeWorkspaceId) || null,
      activeProject: projectAlerts.get(state.activeProjectId) || null,
    };
  }

  function cancelPromptTimer(signal) {
    if (!signal?.promptTimer) {
      return;
    }
    clearTimeout(signal.promptTimer);
    signal.promptTimer = null;
  }

  function resetSessionSignal(sessionId) {
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

  function deleteSessionSignal(sessionId) {
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
  }) {
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

  function clearProjectAlerts(projectId, panelId = null) {
    if (!projectId || !projectAlerts.has(projectId)) {
      return;
    }

    if (!panelId) {
      log.trace("clearing all alerts for project", { projectId });
      projectAlerts.delete(projectId);
      return;
    }
    log.trace("clearing alert", { projectId, panelId });

    const current = projectAlerts.get(projectId);
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

  function clearAlertSession(sessionId) {
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

  function getSessionSignal(sessionId, project, panel) {
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
  }) {
    const signal = sessionSignals.get(sessionId);

    if (kind === "waiting" && urgency !== "urgent" && signal?.waitingRaised) {
      log.trace("raiseAlert skipped: waiting already raised", { sessionId, detail });
      return false;
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

  function raiseWaitingAlert({ sessionId, projectId, panelId, title, detail, urgency = "normal" }) {
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

  function ensureVisibleSession(workspaceId = getState().activeWorkspaceId) {
    const state = getState();
    const workspace = state.workspaces.find((item) => item.id === workspaceId);
    if (!workspace || workspace.kind === "azure") return null;
    for (const panel of workspace.panels) {
      if (panel.startup === APP_CONFIG.ui.defaultPanelStartup && !/^https?:\/\//i.test(panel.command || "")) {
        sessions.ensureSession(state, `${workspace.id}:${panel.id}`);
      }
    }
    return sessions.resolveDefaultSessionId(state, workspaceId);
  }

  function syncSessionSignalsWithState() {
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

  function shouldTrackProjectAlert(project, panel) {
    return Boolean(
      project &&
      panel &&
      (project.kind === "terminal" || project.kind === "task") &&
      !isKnownPluginProject(project) &&
      !panel.launch?.file &&
      panel.shell !== false,
    );
  }

  function updateVisibleSessions(nextIds) {
    const prev = attentionContext.visibleSessionIds;
    const next = new Set(nextIds);
    log.trace("updateVisibleSessions", { prev: [...prev], next: [...next] });
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

  function isSessionVisible(sessionId) {
    if (attentionContext.visibleSessionIds.has(sessionId)) return true;
    const until = attentionContext.recentlyVisibleUntil.get(sessionId);
    return until != null && Date.now() < until;
  }

  function markSessionPromptInjected(sessionId) {
    const signal = sessionSignals.get(sessionId);
    if (!signal) {
      return;
    }
    signal.busy = true;
    signal.hasUserInput = true;
    signal.waitingRaised = false;
  }

  function clearAllAttention() {
    projectAlerts.clear();
    for (const [, signal] of sessionSignals) {
      cancelPromptTimer(signal);
    }
    sessionSignals.clear();
    attentionContext.visibleSessionIds = new Set();
    attentionContext.recentlyVisibleUntil.clear();
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
    isSessionVisible,
    markSessionPromptInjected,
    clearAllAttention,
  };
}
