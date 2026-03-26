function createEventHub() {
  return {
    stateUpdated: new Set(),
    terminalData: new Set(),
    terminalExit: new Set(),
    connectionState: new Set(),
  };
}

function bindElectronTransport() {
  return {
    ...window.strideterm,
    isRemote: false,
    getRemoteToken: () => "",
    setRemoteToken: () => {},
    regenerateRemoteToken: () => window.strideterm.regenerateRemoteToken(),
    saveProfile: (profile) => window.strideterm.saveProfile(profile),
    deleteProfile: (profileId) => window.strideterm.deleteProfile(profileId),
    activateProfile: (profileId) => window.strideterm.activateProfile(profileId),
    onConnectionState: () => {},
  };
}

function createRemoteTransport() {
  const listeners = createEventHub();
  const query = new URLSearchParams(window.location.search);
  let token = query.get("token") || window.sessionStorage.getItem("strideterm-token") || "";

  function persistToken(nextToken) {
    token = String(nextToken || "").trim();
    if (token) {
      window.sessionStorage.setItem("strideterm-token", token);
      query.set("token", token);
      window.history.replaceState({}, "", `${window.location.pathname}?${query.toString()}`);
      return;
    }

    window.sessionStorage.removeItem("strideterm-token");
    query.delete("token");
    window.history.replaceState({}, "", window.location.pathname);
  }

  if (token) {
    persistToken(token);
  }

  function emitConnectionState(payload) {
    listeners.connectionState.forEach((handler) => handler(payload));
  }

  function createRemoteIssue({ kind, statusCode = 0, rawMessage = "", recoverable = true } = {}) {
    const normalizedMessage = String(rawMessage || "").trim();
    let message = normalizedMessage;

    if (statusCode === 401) {
      message = "Remote token is missing or invalid.";
    } else if (statusCode === 530 || /origin has been unregistered from argo tunnel/i.test(normalizedMessage)) {
      message = "Cloudflare tunnel is no longer connected to the desktop app. Recreate the tunnel from the desktop app.";
    } else if ([502, 503, 504].includes(statusCode)) {
      message = "Remote workspace is temporarily unavailable. The desktop app or its local server may be restarting.";
    } else if (kind === "ws-closed" || kind === "ws-error") {
      message = "Remote connection was lost. The desktop app or tunnel may have stopped.";
    } else if (!message) {
      message = "Remote connection failed.";
    }

    const error = new Error(message);
    error.isRemoteTransport = true;
    error.statusCode = statusCode;
    error.kind = kind || "request-failed";
    error.recoverable = recoverable;
    error.rawMessage = normalizedMessage;
    return error;
  }

  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const ws = new WebSocket(`${protocol}//${window.location.host}/ws?token=${encodeURIComponent(token)}`);

  ws.addEventListener("open", () => {
    emitConnectionState({ connected: true, message: "" });
  });

  ws.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.type === "state:updated") {
      emitConnectionState({ connected: true, message: "" });
      listeners.stateUpdated.forEach((handler) => handler(message.payload));
    }
    if (message.type === "terminal:data") {
      listeners.terminalData.forEach((handler) => handler(message.payload));
    }
    if (message.type === "terminal:exit") {
      listeners.terminalExit.forEach((handler) => handler(message.payload));
    }
  });

  ws.addEventListener("close", (event) => {
    const error = createRemoteIssue({
      kind: "ws-closed",
      rawMessage: event.reason || "",
    });
    emitConnectionState({ connected: false, message: error.message, code: event.code || 0 });
  });

  ws.addEventListener("error", () => {
    const error = createRemoteIssue({ kind: "ws-error" });
    emitConnectionState({ connected: false, message: error.message, code: 0 });
  });

  async function fetchJson(pathname, payload) {
    if (!token) {
      throw new Error("Remote access token is required.");
    }

    let response;
    try {
      response = await fetch(pathname, {
        method: payload ? "POST" : "GET",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: payload ? JSON.stringify(payload) : undefined,
      });
    } catch (cause) {
      const error = createRemoteIssue({
        kind: "network",
        rawMessage: cause?.message || "",
      });
      emitConnectionState({ connected: false, message: error.message, code: 0 });
      throw error;
    }

    if (!response.ok) {
      const error = createRemoteIssue({
        kind: "http",
        statusCode: response.status,
        rawMessage: await response.text(),
      });
      emitConnectionState({ connected: false, message: error.message, code: response.status });
      throw error;
    }

    emitConnectionState({ connected: true, message: "" });
    return response.json();
  }

  function send(message) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(message));
      return;
    }

    ws.addEventListener(
      "open",
      () => {
        ws.send(JSON.stringify(message));
      },
      { once: true },
    );
  }

  return {
    isRemote: true,
    openExternal: (url) => {
      const nextUrl = String(url || "").trim();
      if (!nextUrl) {
        return;
      }
      window.open(nextUrl, "_blank", "noopener,noreferrer");
    },
    getState: () => fetchJson("/api/state"),
    activateWorkspace: (workspaceId) => fetchJson("/api/workspace/activate", { workspaceId }),
    activateProject: (projectId) => fetchJson("/api/project/activate", { projectId }),
    activateSession: (sessionId) => fetchJson("/api/session/activate", { sessionId }),
    syncAttentionContext: (payload) => fetchJson("/api/attention/sync", payload),
    clearAllAttention: () => fetchJson("/api/attention/clear-all", {}),
    saveWorkspace: (workspace) => fetchJson("/api/workspace/save", { workspace }),
    saveProject: (project) => fetchJson("/api/project/save", { project }),
    deleteWorkspace: (workspaceId, options) => fetchJson("/api/workspace/delete", { workspaceId, ...options }),
    deleteProject: (projectId) => fetchJson("/api/project/delete", { projectId }),
    reorderWorkspaces: (workspaceIds) => fetchJson("/api/workspace/reorder", { workspaceIds }),
    reorderProjects: (projectIds) => fetchJson("/api/project/reorder", { projectIds }),
    updateSettings: (settings) => fetchJson("/api/settings/update", { settings }),
    verifyAzureConnection: (connection) => fetchJson("/api/azure/verify-connection", { connection }),
    saveAzureConnection: (connection) => fetchJson("/api/azure/save-connection", { connection }),
    deleteAzureConnection: (connectionId) => fetchJson("/api/azure/delete-connection", { connectionId }),
    refreshAzure: () => fetchJson("/api/azure/refresh", {}),
    queryAzureAuditLog: (filters) => fetchJson("/api/azure/audit-log/query", filters),
    getAzureAuditStats: (filters) => fetchJson("/api/azure/audit-log/stats", filters),
    markAzurePullRequestSeen: (prKey) => fetchJson("/api/azure/pull-request/seen", { prKey }),
    openAzurePullRequest: (payload) => fetchJson("/api/azure/pull-request/open", payload),
    commentAzurePullRequest: (payload) => fetchJson("/api/azure/pull-request/comment", payload),
    createReviewBridgeDraftComment: (payload) => fetchJson("/api/review-bridge/draft-comment/create", payload),
    saveReviewBridgeDraft: (payload) => fetchJson("/api/review-bridge/draft/save", payload),
    deleteReviewBridgeDraft: (payload) => fetchJson("/api/review-bridge/draft/delete", payload),
    queueReviewBridgeDraft: (payload) => fetchJson("/api/review-bridge/draft/queue", payload),
    deleteReviewBridgeComment: (payload) => fetchJson("/api/review-bridge/comment/delete", payload),
    replyWithCodeChanges: (payload) => fetchJson("/api/review-bridge/comment/reply-with-changes", payload),
    resetAgentPrompts: () => fetchJson("/api/review-bridge/agent-prompt/reset", {}),
    syncReviewBridgePullRequest: (payload) => fetchJson("/api/review-bridge/pull-request/sync", payload),
    pushAndPublishReview: (payload) => fetchJson("/api/review-bridge/pull-request/push-and-publish", payload),
    updateAzureThreadStatus: (payload) => fetchJson("/api/azure/pull-request/thread-status", payload),
    voteAzurePullRequest: (payload) => fetchJson("/api/azure/pull-request/vote", payload),
    fetchAzureReviewWorkspace: (workspaceId) => fetchJson("/api/azure/workspace/fetch", { workspaceId }),
    rebaseAzureReviewWorkspace: (workspaceId) => fetchJson("/api/azure/workspace/rebase", { workspaceId }),
    pushAzureReviewWorkspace: (workspaceId, options) => fetchJson("/api/azure/workspace/push", { workspaceId, ...options }),
    azureCreatePullRequest: (payload) => fetchJson("/api/azure/create-pull-request", payload),
    azureListRemoteBranches: (payload) => fetchJson("/api/azure/list-remote-branches", payload),
    azureQuickFixListProjects: (payload) => fetchJson("/api/azure/quickfix/list-projects", payload),
    azureQuickFixListRepositories: (payload) => fetchJson("/api/azure/quickfix/list-repositories", payload),
    azureQuickFixListBranches: (payload) => fetchJson("/api/azure/quickfix/list-branches", payload),
    azureQuickFixCreate: (payload) => fetchJson("/api/azure/quickfix/create", payload),
    regenerateRemoteToken: () => fetchJson("/api/remote/token/regenerate", {}),
    refreshTunnel: () => fetchJson("/api/tunnel/refresh", {}),
    createCloudflareTunnel: () => fetchJson("/api/tunnel/create", {}),
    stopCloudflareTunnel: () => fetchJson("/api/tunnel/stop", {}),
    restartTerminal: (sessionId) => fetchJson("/api/terminal/restart", { sessionId }),
    refreshDocker: () => fetchJson("/api/docker/refresh", {}),
    refreshGit: (projectId) => fetchJson("/api/git/refresh", { projectId }),
    gitFetch: (payload) => fetchJson("/api/git/fetch", payload),
    gitPush: (payload) => fetchJson("/api/git/push", payload),
    gitMergeIntoCurrent: (payload) => fetchJson("/api/git/merge-into-current", payload),
    gitRebaseOnto: (payload) => fetchJson("/api/git/rebase-onto", payload),
    gitContinueOperation: (payload) => fetchJson("/api/git/continue", payload),
    gitAbortOperation: (payload) => fetchJson("/api/git/abort", payload),
    gitDiffPreview: (payload) => fetchJson("/api/git/diff-preview", payload),
    gitMergeCurrentIntoBase: (payload) => fetchJson("/api/git/merge-into-base", payload),
    gitRemoveWorktree: (payload) => fetchJson("/api/git/remove-worktree", payload),
    gitCommitAll: (payload) => fetchJson("/api/git/commit-all", payload),
    gitStash: (payload) => fetchJson("/api/git/stash", payload),
    gitStashPop: (payload) => fetchJson("/api/git/stash-pop", payload),
    gitCommitDiff: (payload) => fetchJson("/api/git/commit-diff", payload),
    dockerAction: (action, containerId) => fetchJson("/api/docker/action", { action, containerId }),
    openDockerSession: (payload) => fetchJson("/api/docker/open-session", payload),
    openLazydockerSession: (payload) => fetchJson("/api/docker/open-lazydocker", payload),
    openLazygitSession: (payload) => fetchJson("/api/git/open-lazygit", payload),
    createWorktree: (payload) => fetchJson("/api/git/create-worktree", payload),
    saveProfile: (profile) => fetchJson("/api/profile/save", { profile }),
    deleteProfile: (profileId) => fetchJson("/api/profile/delete", { profileId }),
    activateProfile: (profileId) => fetchJson("/api/profile/activate", { profileId }),
    resizeTerminal: (sessionId, size) => send({ type: "terminal:resize", sessionId, cols: size.cols, rows: size.rows }),
    writeTerminal: (sessionId, data) => send({ type: "terminal:input", sessionId, data }),
    onStateUpdated: (handler) => listeners.stateUpdated.add(handler),
    onTerminalData: (handler) => listeners.terminalData.add(handler),
    onTerminalExit: (handler) => listeners.terminalExit.add(handler),
    onConnectionState: (handler) => listeners.connectionState.add(handler),
    getRemoteToken: () => token,
    setRemoteToken: (nextToken) => {
      persistToken(nextToken);
      window.location.reload();
    },
  };
}

export function createTransport() {
  if (window.strideterm) {
    return bindElectronTransport();
  }

  return createRemoteTransport();
}
