export function wireRuntimeBindings({
  api,
  state,
  terminalStage,
  focusActiveTerminal,
  render,
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
  isBrowserViewId,
  terminalController,
}) {
  api.onStateUpdated((payload) => {
    state.bootstrapError = "";
    clearRemoteConnectionIssue();
    if (payload?.appState?.activeWorkspaceId !== state.payload?.appState?.activeWorkspaceId) {
      state.splitGroup = null;
    }
    state.payload = payload;
    if (!state._suppressBroadcastRender) {
      render();
      focusActiveTerminal();
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

  window.addEventListener("keydown", async (event) => {
    if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey) {
      const digitMatch = event.code?.match(/^Digit([1-9])$/);
      if (digitMatch) {
        event.preventDefault();
        event.stopImmediatePropagation();
        const workspaces = getFilteredWorkspaces();
        const index = parseInt(digitMatch[1], 10) - 1;
        if (index < workspaces.length) {
          state.payload = await api.activateWorkspace(workspaces[index].id);
          state.splitGroup = null;
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
  }, true);

  terminalStage.addEventListener("mousedown", (event) => {
    const pane = event.target.closest(".workspace-pane");
    if (!pane) {
      focusActiveTerminal();
      return;
    }

    state.activeViewId = pane.dataset.viewId || state.activeViewId;
    state.activeSessionId = (isGitViewId(state.activeViewId) || isDockerViewId(state.activeViewId) || isBrowserViewId(state.activeViewId)) ? null : state.activeViewId;
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

  api.getState().then((payload) => {
    state.bootstrapError = "";
    clearRemoteConnectionIssue();
    state.payload = payload;
    render();
    focusActiveTerminal();
  }).catch((error) => {
    const message = error?.message?.includes("401")
      ? "Remote token is missing or invalid. Use the token from the desktop strIDEterm state file."
      : error?.message || "Unknown startup error.";
    renderBootstrapError(message);
  });
}
