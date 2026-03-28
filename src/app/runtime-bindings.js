function readActiveAttention(payload, workspaceId) {
  return payload?.attention?.byWorkspace?.[workspaceId] || payload?.attention?.byProject?.[workspaceId] || null;
}

function readActiveGitSnapshot(payload, workspaceId) {
  return payload?.git?.workspaces?.[workspaceId] || payload?.git?.projects?.[workspaceId] || null;
}

function readActiveReviewBridge(payload, reviewPrKey) {
  const context = reviewPrKey ? payload?.reviewBridge?.pullRequests?.[reviewPrKey] || null : null;
  if (!context) {
    return null;
  }
  return {
    prKey: context.prKey,
    exportDir: context.exportDir,
    comments: (context.comments || []).map((c) => ({
      commentKey: c.commentKey,
      commentKind: c.commentKind,
      displayIndex: c.displayIndex,
      remoteThreadId: c.remoteThreadId,
      title: c.title,
      summary: c.summary,
      status: c.status,
      priority: c.priority,
      updatedAt: c.updatedAt,
      payload: c.payload || {},
    })),
    drafts: (context.drafts || []).map((draft) => ({
      draftId: draft.draftId,
      commentKey: draft.commentKey,
      body: draft.body,
      status: draft.status,
      authorAgent: draft.authorAgent,
      updatedAt: draft.updatedAt,
    })),
    syncQueue: (context.syncQueue || []).map((item) => ({
      queueId: item.queueId,
      operation: item.operation,
      status: item.status,
      attempts: item.attempts,
      lastError: item.lastError,
      updatedAt: item.updatedAt,
    })),
    briefMarkdownPath: context.briefMarkdownPath,
    briefJsonPath: context.briefJsonPath,
    threadsMarkdownPath: context.threadsMarkdownPath,
    draftsMarkdownPath: context.draftsMarkdownPath,
    syncStatusMarkdownPath: context.syncStatusMarkdownPath,
    databasePath: context.databasePath,
    cliPath: context.cliPath,
    agentInstructions: context.agentInstructions || null,
  };
}

function selectActiveWorkspaceRenderState(payload) {
  const activeWorkspaceId = payload?.appState?.activeWorkspaceId || "";
  const activeWorkspace =
    (payload?.appState?.workspaces || []).find((workspace) => workspace.id === activeWorkspaceId) || null;
  const reviewProvider = activeWorkspace?.review?.provider || "";
  const reviewPrKey = ["azure-devops", "github"].includes(reviewProvider) ? activeWorkspace.review.prKey : "";

  return {
    activeWorkspaceId,
    activeWorkspace,
    workspacePayload: payload?.workspace || null,
    attention: readActiveAttention(payload, activeWorkspaceId),
    git: readActiveGitSnapshot(payload, activeWorkspaceId),
    docker: activeWorkspace?.kind === "docker" ? payload?.docker || null : null,
    azureInbox: activeWorkspace?.kind === "azure" ? payload?.azureDevops || null : null,
    githubInbox: activeWorkspace?.kind === "github" ? payload?.github || null : null,
    azureReview:
      reviewProvider === "azure-devops" && reviewPrKey
        ? payload?.azureDevops?.pullRequests?.[reviewPrKey] || null
        : null,
    githubReview:
      reviewProvider === "github" && reviewPrKey ? payload?.github?.pullRequests?.[reviewPrKey] || null : null,
    reviewBridge: readActiveReviewBridge(payload, reviewPrKey),
  };
}

export function shouldRenderActiveWorkspace(nextPayload, previousPayload) {
  if (!previousPayload) {
    return true;
  }
  return (
    JSON.stringify(selectActiveWorkspaceRenderState(nextPayload)) !==
    JSON.stringify(selectActiveWorkspaceRenderState(previousPayload))
  );
}

const _splitGroupCache = new Map();

export function wireRuntimeBindings({
  api,
  state,
  terminalStage,
  focusActiveTerminal,
  render,
  renderBackground,
  renderBootstrapError,
  clearRemoteConnectionIssue,
  setRemoteConnectionIssue,
  openNewWorkspaceFlow,
  getFilteredWorkspaces,
  shortcutTabDirection,
  getWorkspace,
  getWorkspaceTabs,
  activateView,
  scheduleActiveResize,
  isGitViewId,
  isDockerViewId,
  isAzureViewId,
  isReviewViewId,
  isBrowserViewId,
  terminalController,
}) {
  api.onStateUpdated((payload) => {
    const pendingWorkspaceId = state.pendingWorkspaceActivationId || "";
    const incomingWorkspaceId = payload?.appState?.activeWorkspaceId || "";
    const isBootstrapPayload = Boolean(payload?.meta?.bootstrap);
    if (pendingWorkspaceId && incomingWorkspaceId && incomingWorkspaceId !== pendingWorkspaceId) {
      return;
    }
    if (pendingWorkspaceId && incomingWorkspaceId === pendingWorkspaceId && !isBootstrapPayload) {
      state.pendingWorkspaceActivationId = "";
    }
    state.bootstrapError = "";
    clearRemoteConnectionIssue();
    const previousPayload = state.payload;
    const shouldRefreshActiveWorkspace = shouldRenderActiveWorkspace(payload, previousPayload);
    if (payload?.appState?.activeWorkspaceId !== previousPayload?.appState?.activeWorkspaceId) {
      const prevWsId = previousPayload?.appState?.activeWorkspaceId;
      if (prevWsId && state.splitGroup) _splitGroupCache.set(prevWsId, state.splitGroup);
      const nextWsId = payload?.appState?.activeWorkspaceId;
      state.splitGroup = (nextWsId && _splitGroupCache.get(nextWsId)) || null;
    }
    if (state.pendingViewActivationId) {
      const nextWorkspace = payload?.workspace;
      const nextTabs = nextWorkspace ? getWorkspaceTabs(nextWorkspace) : [];
      if (!nextTabs.some((tab) => tab.id === state.pendingViewActivationId)) {
        return;
      }
      state.activeViewId = state.pendingViewActivationId;
      state.activeSessionId = state.pendingViewActivationId;
      if (!isBootstrapPayload) {
        state.pendingViewActivationId = "";
      }
    }
    if (state._suppressBroadcastRender) {
      return;
    }
    state.payload = payload;
    if (shouldRefreshActiveWorkspace) {
      render();
      // Don't steal focus from open dialogs/overlays (e.g. user editing a draft)
      if (!state.overlay) {
        focusActiveTerminal();
      }
    } else {
      renderBackground?.();
    }
  });

  api.onTerminalData(({ sessionId, data }) => {
    terminalController.handleTerminalData({ sessionId, data });
  });

  api.onTerminalExit(({ sessionId, exitCode, intentional }) => {
    terminalController.handleTerminalExit({ sessionId, exitCode, intentional });
  });

  api.onConnectionState?.((connection) => {
    if (connection?.connected) {
      clearRemoteConnectionIssue();
      return;
    }

    if (connection?.message) {
      setRemoteConnectionIssue(connection.message);
    }
  });

  window.addEventListener("unhandledrejection", (event) => {
    const error = event.reason;
    if (!error?.isRemoteTransport) {
      return;
    }

    if (error.message) {
      setRemoteConnectionIssue(error.message);
    }
    event.preventDefault();
  });

  window.addEventListener(
    "keydown",
    async (event) => {
      if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey) {
        const digitMatch = event.code?.match(/^Digit([1-9])$/);
        if (digitMatch) {
          event.preventDefault();
          event.stopImmediatePropagation();
          const workspaces = getFilteredWorkspaces();
          const index = parseInt(digitMatch[1], 10) - 1;
          if (index < workspaces.length) {
            const prevId = state.payload?.appState?.activeWorkspaceId;
            if (prevId && state.splitGroup) _splitGroupCache.set(prevId, state.splitGroup);
            state.payload = await api.activateWorkspace(workspaces[index].id);
            state.splitGroup = _splitGroupCache.get(workspaces[index].id) || null;
            render();
            focusActiveTerminal();
          }
          return;
        }
      }
      if (!(event.ctrlKey || event.metaKey)) return;
      if (event.key.toLowerCase() === "n") {
        event.preventDefault();
        await openNewWorkspaceFlow();
        return;
      }
      if (event.key.toLowerCase() === "r" && state.activeSessionId) {
        event.preventDefault();
        state.payload = await api.restartTerminal(state.activeSessionId);
        render();
        focusActiveTerminal();
        return;
      }
      const direction = shortcutTabDirection(event);
      if (direction !== 0) {
        event.preventDefault();
        event.stopImmediatePropagation();
        const workspace = getWorkspace();
        if (!workspace) return;
        const tabs = getWorkspaceTabs(workspace);
        if (tabs.length < 2) return;
        const currentIndex = tabs.findIndex((tab) => tab.id === state.activeViewId);
        const nextIndex = (currentIndex + direction + tabs.length) % tabs.length;
        await activateView(tabs[nextIndex].id);
      }
    },
    true,
  );

  terminalStage.addEventListener("mousedown", (event) => {
    const pane = event.target.closest(".workspace-pane");
    if (!pane) {
      focusActiveTerminal();
      return;
    }

    state.activeViewId = pane.dataset.viewId || state.activeViewId;
    state.activeSessionId =
      isGitViewId(state.activeViewId) ||
      isDockerViewId(state.activeViewId) ||
      isAzureViewId(state.activeViewId) ||
      isReviewViewId(state.activeViewId) ||
      isBrowserViewId(state.activeViewId)
        ? null
        : state.activeViewId;
    focusActiveTerminal();
  });

  window.addEventListener("resize", () => {
    scheduleActiveResize();
  });

  if (window.visualViewport) {
    let viewportTimer = 0;
    window.visualViewport.addEventListener("resize", () => {
      cancelAnimationFrame(viewportTimer);
      viewportTimer = requestAnimationFrame(() => {
        document.documentElement.style.height = `${window.visualViewport.height}px`;
        scheduleActiveResize();
      });
    });
  }

  api
    .getState()
    .then((payload) => {
      const pendingWorkspaceId = state.pendingWorkspaceActivationId || "";
      const incomingWorkspaceId = payload?.appState?.activeWorkspaceId || "";
      const isBootstrapPayload = Boolean(payload?.meta?.bootstrap);
      if (pendingWorkspaceId && incomingWorkspaceId && incomingWorkspaceId !== pendingWorkspaceId) {
        return;
      }
      if (pendingWorkspaceId && incomingWorkspaceId === pendingWorkspaceId && !isBootstrapPayload) {
        state.pendingWorkspaceActivationId = "";
      }
      state.bootstrapError = "";
      clearRemoteConnectionIssue();
      if (state.pendingViewActivationId) {
        const nextWorkspace = payload?.workspace;
        const nextTabs = nextWorkspace ? getWorkspaceTabs(nextWorkspace) : [];
        if (nextTabs.some((tab) => tab.id === state.pendingViewActivationId)) {
          state.activeViewId = state.pendingViewActivationId;
          state.activeSessionId = state.pendingViewActivationId;
          if (!isBootstrapPayload) {
            state.pendingViewActivationId = "";
          }
        }
      }
      state.payload = payload;
      render();
      focusActiveTerminal();
    })
    .catch((error) => {
      const message = error?.message?.includes("401")
        ? "Remote token is missing or invalid. Use the token from the desktop strIDEterm state file."
        : error?.message || "Unknown startup error.";
      renderBootstrapError(message);
    });
}
