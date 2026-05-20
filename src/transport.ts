import type {
  StridetermAPI,
  StatePayload,
  TerminalSize,
  TerminalDataPayload,
  TerminalReplayPayload,
  TerminalExitPayload,
} from "../electron/shared/ipc-bridge.js";
import type { ProfilePayload } from "../electron/backend/ipc-schemas.js";
import type { SshAuthRequest, SshConnectionState } from "../electron/shared/types/ssh.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Handler<T> = (payload: T) => void;

interface ConnectionStatePayload {
  connected: boolean;
  message?: string;
  code?: number;
  reconnecting?: boolean;
  reconnected?: boolean;
  attempt?: number;
}

interface EventHub {
  stateUpdated: Set<Handler<StatePayload>>;
  terminalData: Set<Handler<TerminalDataPayload>>;
  terminalExit: Set<Handler<TerminalExitPayload>>;
  connectionState: Set<Handler<ConnectionStatePayload>>;
  sshAuthPrompt: Set<Handler<SshAuthRequest>>;
  sshHostKeyChange: Set<Handler<Record<string, unknown>>>;
  sshState: Set<Handler<Record<string, unknown>>>;
  sshConnectionState: Set<Handler<SshConnectionState>>;
  dockerLogsWrite: Set<Handler<{ sessionId: string; data: string }>>;
  dockerLogsClose: Set<Handler<{ sessionId: string; code: number | null }>>;
}

/** Extended transport interface covering both Electron and remote modes.
 *  Intentionally a superset of StridetermAPI where both transports overlap;
 *  Electron-only methods (browseDirectory, showSystemNotification, etc.) are
 *  not present in the remote transport and are therefore excluded.
 */
export interface Transport extends Partial<
  Omit<StridetermAPI, "onConnectionState" | "onSwitchWorkspace" | "onSwitchProject" | "onSwitchTab">
> {
  isRemote: boolean;
  /** Manual state refresh — refetches /api/state and broadcasts the result.
   * Provided by the remote transport (no-op or absent for the Electron one,
   * where state is push-updated). Used by the mobile pull-up-to-refresh
   * gesture. */
  refresh?: () => Promise<void>;
  getRemoteToken: () => string;
  setRemoteToken: (token: string) => void;
  onConnectionState: (handler: Handler<ConnectionStatePayload>) => void;
  /** Legacy reset method not yet promoted to StridetermAPI */
  resetAgentPrompts?: () => Promise<unknown>;
  // Core required methods:
  getState: () => Promise<StatePayload>;
  onStateUpdated: (handler: (payload: StatePayload) => void) => void;
  onTerminalData: (handler: (payload: TerminalDataPayload) => void) => void;
  onTerminalExit: (handler: (payload: TerminalExitPayload) => void) => void;
  resizeTerminal: (sessionId: string, size: TerminalSize) => void;
  writeTerminal: (sessionId: string, data: string) => void;
  activateWorkspace: (workspaceId: string) => Promise<unknown>;
  restartTerminal: (sessionId: string) => Promise<unknown>;
  getTerminalReplay: (sessionId: string) => Promise<TerminalReplayPayload>;
  regenerateRemoteToken: () => Promise<unknown>;
  saveProfile: (profile: ProfilePayload) => Promise<unknown>;
  deleteProfile: (profileId: string) => Promise<unknown>;
  activateProfile: (profileId: string) => Promise<unknown>;
}

// ---------------------------------------------------------------------------

function createEventHub(): EventHub {
  return {
    stateUpdated: new Set(),
    terminalData: new Set(),
    terminalExit: new Set(),
    connectionState: new Set(),
    sshAuthPrompt: new Set(),
    sshHostKeyChange: new Set(),
    sshState: new Set(),
    sshConnectionState: new Set(),
    dockerLogsWrite: new Set(),
    dockerLogsClose: new Set(),
  };
}

function createRemoteClientId(): string {
  const cryptoApi = globalThis.crypto;
  if (cryptoApi?.randomUUID) return cryptoApi.randomUUID();
  if (cryptoApi?.getRandomValues) {
    const bytes = new Uint8Array(16);
    cryptoApi.getRandomValues(bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0"));
    return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex
      .slice(8, 10)
      .join("")}-${hex.slice(10, 16).join("")}`;
  }
  return `client-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

function bindElectronTransport(): Transport {
  return {
    ...window.strideterm,
    isRemote: false,
    getRemoteToken: () => "",
    setRemoteToken: () => {},
    regenerateRemoteToken: () => window.strideterm.regenerateRemoteToken(),
    saveProfile: (profile: ProfilePayload) => window.strideterm.saveProfile(profile),
    deleteProfile: (profileId: string) => window.strideterm.deleteProfile(profileId),
    activateProfile: (profileId: string) => window.strideterm.activateProfile(profileId),
    onConnectionState: () => {},
  };
}

export function createRemoteTransport(): Transport {
  const listeners = createEventHub();
  const query = new URLSearchParams(window.location.search);
  let token = query.get("token") || window.sessionStorage.getItem("strideterm-token") || "";
  const clientIdStorageKey = "strideterm-remote-client-id";
  let remoteClientId = window.sessionStorage.getItem(clientIdStorageKey) || "";
  if (!remoteClientId) {
    remoteClientId = createRemoteClientId();
    window.sessionStorage.setItem(clientIdStorageKey, remoteClientId);
  }

  function persistToken(nextToken: string): void {
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

  function emitConnectionState(payload: ConnectionStatePayload): void {
    listeners.connectionState.forEach((handler) => handler(payload));
  }

  interface RemoteIssueOptions {
    kind?: string;
    statusCode?: number;
    rawMessage?: string;
    recoverable?: boolean;
  }

  interface RemoteError extends Error {
    isRemoteTransport: boolean;
    statusCode: number;
    kind: string;
    recoverable: boolean;
    rawMessage: string;
  }

  function createRemoteIssue({
    kind,
    statusCode = 0,
    rawMessage = "",
    recoverable = true,
  }: RemoteIssueOptions = {}): RemoteError {
    const normalizedMessage = String(rawMessage || "").trim();
    let message = normalizedMessage;

    if (statusCode === 401) {
      message = "Remote token is missing or invalid.";
    } else if (statusCode === 530 || /origin has been unregistered from argo tunnel/i.test(normalizedMessage)) {
      message =
        "Cloudflare tunnel is no longer connected to the desktop app. Recreate the tunnel from the desktop app.";
    } else if ([502, 503, 504].includes(statusCode)) {
      message = "Remote workspace is temporarily unavailable. The desktop app or its local server may be restarting.";
    } else if (kind === "ws-closed" || kind === "ws-error") {
      message = "Remote connection was lost. The desktop app or tunnel may have stopped.";
    } else if (!message) {
      message = "Remote connection failed.";
    }

    const error = new Error(message) as RemoteError;
    error.isRemoteTransport = true;
    error.statusCode = statusCode;
    error.kind = kind || "request-failed";
    error.recoverable = recoverable;
    error.rawMessage = normalizedMessage;
    return error;
  }

  interface WsMessage {
    type: string;
    sessionId: string;
    cols?: number;
    rows?: number;
    data?: string;
  }

  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const reconnectBaseDelayMs = 500;
  const reconnectMaxDelayMs = 10_000;
  const pendingWsMessages: WsMessage[] = [];
  let ws: WebSocket | null = null;
  let reconnectTimer = 0;
  let reconnectAttempt = 0;
  let openedOnce = false;

  function buildWsUrl(): string {
    // After the share-URL bootstrap, the token is gone from the URL and a
    // session cookie has taken over (server: SESSION_COOKIE_NAME). The
    // browser attaches that cookie to WS upgrade requests automatically,
    // so dropping the `?token=` segment is enough to keep working without
    // re-emitting the master token. External callers that still hold the
    // token (e.g. API clients) keep the old `?token=` form.
    const wsQuery = new URLSearchParams();
    if (token) wsQuery.set("token", token);
    wsQuery.set("clientId", remoteClientId);
    const wsSuffix = wsQuery.toString();
    return `${protocol}//${window.location.host}/ws${wsSuffix ? `?${wsSuffix}` : ""}`;
  }

  function flushPendingWsMessages(): void {
    const current = ws;
    if (!current || current.readyState !== WebSocket.OPEN) {
      return;
    }
    while (pendingWsMessages.length > 0 && current.readyState === WebSocket.OPEN) {
      current.send(JSON.stringify(pendingWsMessages.shift()));
    }
  }

  function refreshStateAfterReconnect(): void {
    void fetchJson("/api/state")
      .then((payload) => {
        listeners.stateUpdated.forEach((handler) => handler(payload as StatePayload));
      })
      .catch(() => {
        // fetchJson already emits the remote connection issue.
      });
  }

  function scheduleReconnect(error: RemoteError, code = 0): void {
    if (reconnectTimer) {
      return;
    }
    reconnectAttempt += 1;
    const delay = Math.min(reconnectMaxDelayMs, reconnectBaseDelayMs * 2 ** Math.min(reconnectAttempt - 1, 5));
    emitConnectionState({
      connected: false,
      reconnecting: true,
      message: `${error.message} Reconnecting in ${Math.round(delay / 1000)}s...`,
      code,
      attempt: reconnectAttempt,
    });
    reconnectTimer = window.setTimeout(() => {
      reconnectTimer = 0;
      connectWebSocket();
    }, delay);
  }

  function handleWsMessage(event: MessageEvent): void {
    const message = JSON.parse(event.data as string) as { type: string; payload: unknown };
    if (message.type === "state:updated") {
      emitConnectionState({ connected: true, message: "" });
      listeners.stateUpdated.forEach((handler) => handler(message.payload as StatePayload));
    }
    if (message.type === "terminal:data") {
      listeners.terminalData.forEach((handler) => handler(message.payload as TerminalDataPayload));
    }
    if (message.type === "terminal:exit") {
      listeners.terminalExit.forEach((handler) => handler(message.payload as TerminalExitPayload));
    }
    if (message.type === "ssh:auth-prompt") {
      listeners.sshAuthPrompt.forEach((handler) => handler(message.payload as SshAuthRequest));
    }
    if (message.type === "ssh:host-key-change") {
      listeners.sshHostKeyChange.forEach((handler) => handler(message.payload as Record<string, unknown>));
    }
    if (message.type === "ssh:state") {
      listeners.sshState.forEach((handler) => handler(message.payload as Record<string, unknown>));
    }
    if (message.type === "ssh:connection-state") {
      listeners.sshConnectionState.forEach((handler) => handler(message.payload as SshConnectionState));
    }
    if (message.type === "docker:logs:write") {
      listeners.dockerLogsWrite.forEach((handler) => handler(message.payload as { sessionId: string; data: string }));
    }
    if (message.type === "docker:logs:close") {
      listeners.dockerLogsClose.forEach((handler) =>
        handler(message.payload as { sessionId: string; code: number | null }),
      );
    }
  }

  function connectWebSocket(): void {
    const nextWs = new WebSocket(buildWsUrl());
    ws = nextWs;

    nextWs.addEventListener("open", () => {
      if (ws !== nextWs) return;
      const reconnected = openedOnce;
      openedOnce = true;
      reconnectAttempt = 0;
      emitConnectionState({ connected: true, message: "", reconnected });
      flushPendingWsMessages();
      if (reconnected) {
        refreshStateAfterReconnect();
      }
    });

    nextWs.addEventListener("message", (event) => {
      if (ws !== nextWs) return;
      handleWsMessage(event);
    });

    nextWs.addEventListener("close", (event: CloseEvent) => {
      if (ws !== nextWs) return;
      const error = createRemoteIssue({
        kind: "ws-closed",
        rawMessage: event.reason || "",
      });
      scheduleReconnect(error, event.code || 0);
    });

    nextWs.addEventListener("error", () => {
      if (ws !== nextWs) return;
      const error = createRemoteIssue({ kind: "ws-error" });
      emitConnectionState({
        connected: false,
        reconnecting: true,
        message: error.message,
        code: 0,
        attempt: reconnectAttempt + 1,
      });
    });
  }

  connectWebSocket();

  // --------------------------------------------------------------------
  // Resume-from-background handling.
  //
  // Mobile Safari and Chrome aggressively suspend JS in backgrounded tabs.
  // While suspended:
  //  - WebSocket pings/pongs don't process. The server's heartbeat fires
  //    at MAX_MISSED_PONGS and terminates the socket; the close event
  //    queues but the renderer is frozen and can't run scheduleReconnect.
  //  - The kernel may drop the underlying TCP connection silently — when
  //    the tab thaws, ws.readyState is still OPEN but no traffic flows.
  //
  // Without active recovery the UI appears frozen on return: no terminal
  // output arrives, the cached payload is stale, sends queue forever.
  //
  // We listen to both visibilitychange→visible and pageshow (the latter
  // fires after bfcache restore where the page literally was suspended).
  // The probe is: if the socket isn't OPEN, trigger a reconnect; if it
  // is OPEN, do a /api/state round-trip to verify the connection is
  // genuinely alive AND to flush whatever state we missed while away.
  // If the probe fails, close the socket so the existing close→reconnect
  // path kicks in.
  // --------------------------------------------------------------------
  // visibilitychange, pageshow, and focus can all fire within ~50 ms of
  // each other when a backgrounded tab regains focus. Without throttling
  // that's 3 simultaneous /api/state requests on every tab-switch —
  // wasteful on mobile data and creates a small thundering-herd on the
  // notify server. 2 s window dedupes them without delaying a genuine
  // resume probe perceptibly.
  const PROBE_THROTTLE_MS = 2_000;
  let lastProbeAt = 0;
  function probeAfterResume(): void {
    if (typeof document === "undefined") return;
    if (document.visibilityState !== "visible") return;
    const now = Date.now();
    if (now - lastProbeAt < PROBE_THROTTLE_MS) return;
    lastProbeAt = now;
    const current = ws;
    if (!current) {
      // No socket at all — shouldn't happen post-construction, but be safe.
      connectWebSocket();
      return;
    }
    if (current.readyState === WebSocket.CLOSED || current.readyState === WebSocket.CLOSING) {
      // Browser delivered the close event but the reconnect timer may
      // have been suspended along with the renderer. Kick one off if
      // there isn't already a pending reconnect.
      if (!reconnectTimer) {
        const error = createRemoteIssue({ kind: "ws-closed", rawMessage: "Resumed from suspended tab" });
        scheduleReconnect(error);
      }
      return;
    }
    if (current.readyState !== WebSocket.OPEN) {
      // CONNECTING — the existing open/close handlers will resolve it.
      return;
    }
    // Technically OPEN but might be a zombie. Verify via /api/state and
    // re-sync the payload in one shot. On failure, close the socket so
    // the close handler queues a reconnect.
    void fetchJson("/api/state")
      .then((payload) => {
        emitConnectionState({ connected: true, message: "" });
        listeners.stateUpdated.forEach((handler) => handler(payload as StatePayload));
      })
      .catch(() => {
        // fetchJson already emitted a connection-issue state. Close the
        // zombie socket; close handler will schedule reconnect.
        try {
          current.close();
        } catch {
          // Already gone — close handler will fire (or already did).
        }
      });
  }

  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", probeAfterResume);
  }
  if (typeof window !== "undefined") {
    // pageshow fires on bfcache restore — visibilitychange may NOT fire in
    // that path on some browsers, so we listen to both.
    window.addEventListener("pageshow", probeAfterResume);
    // focus event covers desktop alt-tab back to a stale tab.
    window.addEventListener("focus", probeAfterResume);
  }

  async function fetchJson(pathname: string, payload?: unknown): Promise<unknown> {
    // Without a token we fall through to the cookie-based path: the
    // bootstrap redirect set `strideterm_session=…; HttpOnly` and the
    // browser attaches it to every same-origin fetch. The server's
    // `isAuthorized` accepts either, so dropping the Authorization
    // header is correct here. If both are missing the server will
    // 401 and the existing error path surfaces it.
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    headers["X-Strideterm-Client-Id"] = remoteClientId;
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }

    let response: Response;
    try {
      response = await fetch(pathname, {
        method: payload ? "POST" : "GET",
        headers,
        body: payload ? JSON.stringify(payload) : undefined,
      });
    } catch (cause) {
      const error = createRemoteIssue({
        kind: "network",
        rawMessage: (cause as { message?: string })?.message || "",
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
    return response.json() as Promise<unknown>;
  }

  function send(message: WsMessage): void {
    const current = ws;
    if (current?.readyState === WebSocket.OPEN) {
      current.send(JSON.stringify(message));
      return;
    }
    pendingWsMessages.push(message);
  }

  return {
    isRemote: true,
    /**
     * Manual state refresh. Fetches /api/state from the server and emits
     * the result through the standard stateUpdated listeners, same as a
     * reconnect would. Used by the mobile pull-to-refresh gesture (swipe
     * up at end of terminal) and by any future "refresh" UI affordance.
     *
     * Also kicks the WebSocket if it isn't currently OPEN — a refresh
     * gesture is the strongest user-initiated "something looks wrong"
     * signal we get, so we use it to push reconnect along instead of
     * waiting for the next heartbeat / visibility probe.
     *
     * Failures are swallowed: fetchJson already emitted a connection-
     * issue state, and the close → reconnect path will recover. Nothing
     * more to do at this layer.
     */
    refresh: async (): Promise<void> => {
      const current = ws;
      if (!current) {
        connectWebSocket();
      } else if (current.readyState !== WebSocket.OPEN && current.readyState !== WebSocket.CONNECTING) {
        // CLOSED/CLOSING: schedule a reconnect if one isn't already queued.
        if (!reconnectTimer) {
          const error = createRemoteIssue({ kind: "ws-closed", rawMessage: "Manual refresh requested" });
          scheduleReconnect(error);
        }
      }
      try {
        const payload = (await fetchJson("/api/state")) as StatePayload;
        emitConnectionState({ connected: true, message: "" });
        listeners.stateUpdated.forEach((handler) => handler(payload));
      } catch {
        // fetchJson already emitted a connection-issue state; the resume
        // probe / reconnect path will recover. Nothing more to do here.
      }
    },
    openExternal: (url: string) => {
      const nextUrl = String(url || "").trim();
      if (!nextUrl) {
        return Promise.resolve();
      }
      window.open(nextUrl, "_blank", "noopener,noreferrer");
      return Promise.resolve();
    },
    getState: () => fetchJson("/api/state") as Promise<StatePayload>,
    activateProject: (projectId) => fetchJson("/api/project/activate", { projectId }),
    activateSession: (sessionId) => {
      // sessionId format is "workspaceId:panelId" — derive workspaceId from it.
      const workspaceId = String(sessionId || "").split(":")[0];
      return fetchJson("/api/remote-client/session/activate", { workspaceId, sessionId });
    },
    setWorkspaceUIState: (workspaceId, uiState) => fetchJson("/api/workspace/set-ui-state", { workspaceId, uiState }),
    enableWorkspaceGrid: (layout, workspaceIds) => fetchJson("/api/workspace-grid/enable", { layout, workspaceIds }),
    disableWorkspaceGrid: () => fetchJson("/api/workspace-grid/disable", {}),
    setGridLayout: (layout) => fetchJson("/api/workspace-grid/set-layout", { layout }),
    setGridCell: (cellIndex, workspaceId) => fetchJson("/api/workspace-grid/set-cell", { cellIndex, workspaceId }),
    swapGridCells: (a, b) => fetchJson("/api/workspace-grid/swap-cells", { a, b }),
    syncAttentionContext: (payload) => fetchJson("/api/attention/sync", payload),
    clearAllAttention: () => fetchJson("/api/attention/clear-all", {}),
    clearAlertForSession: (sessionId, options) =>
      fetchJson("/api/attention/clear-session", {
        sessionId,
        dismissed: options?.dismissed === true,
      }),
    saveWorkspace: (workspace) => fetchJson("/api/workspace/save", { workspace }),
    saveProject: (project) => fetchJson("/api/project/save", { project }),
    deleteWorkspace: (workspaceId, options) => fetchJson("/api/workspace/delete", { workspaceId, ...options }),
    deleteProject: (projectId) => fetchJson("/api/project/delete", { projectId }),
    reorderWorkspaces: (workspaceIds) => fetchJson("/api/workspace/reorder", { workspaceIds }),
    reorderProjects: (projectIds) => fetchJson("/api/project/reorder", { projectIds }),
    updateSettings: (settings) => fetchJson("/api/settings/update", { settings }),
    configureClaudeHook: () => fetchJson("/api/claude-hook/configure", {}),
    removeClaudeHook: () => fetchJson("/api/claude-hook/remove", {}),
    getClaudeHookStatus: () => fetchJson("/api/claude-hook/status", {}),
    testClaudeHook: () => fetchJson("/api/claude-hook/test", {}),
    configureGeminiHook: () => fetchJson("/api/gemini-hook/configure", {}),
    removeGeminiHook: () => fetchJson("/api/gemini-hook/remove", {}),
    getGeminiHookStatus: () => fetchJson("/api/gemini-hook/status", {}),
    testGeminiHook: () => fetchJson("/api/gemini-hook/test", {}),
    configureCodexHook: () => fetchJson("/api/codex-hook/configure", {}),
    removeCodexHook: () => fetchJson("/api/codex-hook/remove", {}),
    getCodexHookStatus: () => fetchJson("/api/codex-hook/status", {}),
    testCodexHook: () => fetchJson("/api/codex-hook/test", {}),
    configureCopilotHook: () => fetchJson("/api/copilot-hook/configure", {}),
    removeCopilotHook: () => fetchJson("/api/copilot-hook/remove", {}),
    getCopilotHookStatus: () => fetchJson("/api/copilot-hook/status", {}),
    testCopilotHook: () => fetchJson("/api/copilot-hook/test", {}),
    configureOpencodeHook: () => fetchJson("/api/opencode-hook/configure", {}),
    removeOpencodeHook: () => fetchJson("/api/opencode-hook/remove", {}),
    getOpencodeHookStatus: () => fetchJson("/api/opencode-hook/status", {}),
    testOpencodeHook: () => fetchJson("/api/opencode-hook/test", {}),
    checkCommand: (command) => fetchJson("/api/check-command", { command }),
    // Task runner
    recheckClaude: () => fetchJson("/api/task/recheck-claude", {}),
    checkProviders: () => fetchJson("/api/task/check-providers", {}),
    checkIsGitRepo: (cwd) => fetchJson("/api/task/check-git-repo", { cwd }),
    probeDirectory: (cwd) => fetchJson("/api/fs/probe-directory", { cwd }),
    createTaskWorkspace: (payload) => fetchJson("/api/task/create", payload),
    startTask: (payload) => fetchJson("/api/task/start", payload),
    stopTask: (payload) => fetchJson("/api/task/stop", payload),
    pauseTask: (payload) => fetchJson("/api/task/pause", payload),
    resumeTask: (payload) => fetchJson("/api/task/resume", payload),
    resetTask: (payload) => fetchJson("/api/task/reset", payload),
    rejectTaskVerdict: (payload) => fetchJson("/api/task/reject-verdict", payload),
    updateTaskDescription: (payload) => fetchJson("/api/task/update-description", payload),
    resolveTaskRecovery: (decisions) => fetchJson("/api/task-recovery/resolve", decisions),
    getTaskStatus: (workspaceId) => fetchJson("/api/task/status", { workspaceId }),
    getTerminalReplay: (sessionId) =>
      fetchJson("/api/terminal/replay", { sessionId }) as Promise<TerminalReplayPayload>,
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
    pushAzureReviewWorkspace: (workspaceId, options) =>
      fetchJson("/api/azure/workspace/push", { workspaceId, ...options }),
    azureCreatePullRequest: (payload) => fetchJson("/api/azure/create-pull-request", payload),
    azureListRemoteBranches: (payload) => fetchJson("/api/azure/list-remote-branches", payload),
    azureQuickFixListProjects: (payload) => fetchJson("/api/azure/quickfix/list-projects", payload),
    azureQuickFixListRepositories: (payload) => fetchJson("/api/azure/quickfix/list-repositories", payload),
    azureQuickFixListBranches: (payload) => fetchJson("/api/azure/quickfix/list-branches", payload),
    azureQuickFixCreate: (payload) => fetchJson("/api/azure/quickfix/create", payload),
    rerunAzureCheck: (prKey, checkItem) => fetchJson("/api/azure/rerun-check", { prKey, checkItem }),
    verifyGitHubConnection: (connection) => fetchJson("/api/github/verify-connection", { connection }),
    saveGitHubConnection: (connection) => fetchJson("/api/github/save-connection", { connection }),
    deleteGitHubConnection: (connectionId) => fetchJson("/api/github/delete-connection", { connectionId }),
    refreshGitHub: () => fetchJson("/api/github/refresh", {}),
    queryGitHubAuditLog: (filters) => fetchJson("/api/github/audit-log/query", filters),
    getGitHubAuditStats: (filters) => fetchJson("/api/github/audit-log/stats", filters),
    markGitHubPullRequestSeen: (prKey) => fetchJson("/api/github/pull-request/seen", { prKey }),
    openGitHubPullRequest: (payload) => fetchJson("/api/github/pull-request/open", payload),
    commentGitHubPullRequest: (payload) => fetchJson("/api/github/pull-request/comment", payload),
    submitGitHubPullRequestReview: (payload) => fetchJson("/api/github/pull-request/review", payload),
    rerunGitHubCheck: (prKey, checkItem) => fetchJson("/api/github/rerun-check", { prKey, checkItem }),
    fetchGitHubReviewWorkspace: (workspaceId) => fetchJson("/api/github/workspace/fetch", { workspaceId }),
    rebaseGitHubReviewWorkspace: (workspaceId) => fetchJson("/api/github/workspace/rebase", { workspaceId }),
    pushGitHubReviewWorkspace: (workspaceId, options) =>
      fetchJson("/api/github/workspace/push", { workspaceId, ...options }),
    githubListRemoteBranches: (payload) => fetchJson("/api/github/list-remote-branches", payload),
    githubCreatePullRequest: (payload) => fetchJson("/api/github/create-pull-request", payload),
    githubQuickFixListRepos: (payload) => fetchJson("/api/github/quickfix/list-repos", payload),
    githubQuickFixListBranches: (payload) => fetchJson("/api/github/quickfix/list-branches", payload),
    githubQuickFixCreate: (payload) => fetchJson("/api/github/quickfix/create", payload),
    verifyTelegramConnection: (connection) => fetchJson("/api/telegram/verify-connection", { connection }),
    detectTelegramChats: (connection) => fetchJson("/api/telegram/detect-chats", { connection }),
    saveTelegramConnection: (connection) => fetchJson("/api/telegram/save-connection", { connection }),
    deleteTelegramConnection: (connectionId) => fetchJson("/api/telegram/delete-connection", { connectionId }),
    refreshTelegram: () => fetchJson("/api/telegram/refresh", {}),
    regenerateRemoteToken: () => fetchJson("/api/remote/token/regenerate", {}),
    refreshTunnel: () => fetchJson("/api/tunnel/refresh", {}),
    createCloudflareTunnel: () => fetchJson("/api/tunnel/create", {}),
    stopCloudflareTunnel: () => fetchJson("/api/tunnel/stop", {}),
    restartTerminal: (sessionId) => fetchJson("/api/terminal/restart", { sessionId }),
    refreshDocker: () => fetchJson("/api/docker/refresh", {}),
    refreshGit: (projectId) => fetchJson("/api/git/refresh", { projectId }),
    gitFetch: (payload) => fetchJson("/api/git/fetch", payload),
    gitPull: (payload) => fetchJson("/api/git/pull", payload),
    gitPush: (payload) => fetchJson("/api/git/push", payload),
    gitCheckoutBranch: (payload) => fetchJson("/api/git/checkout-branch", payload),
    gitCreateBranch: (payload) => fetchJson("/api/git/create-branch", payload),
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
    gitCommitInfo: (payload) => fetchJson("/api/git/commit-info", payload),
    gitLogPage: (payload) => fetchJson("/api/git/log-page", payload),
    gitListTags: (payload) => fetchJson("/api/git/list-tags", payload),
    gitCreateTag: (payload) => fetchJson("/api/git/create-tag", payload),
    gitDeleteTag: (payload) => fetchJson("/api/git/delete-tag", payload),
    gitPushTag: (payload) => fetchJson("/api/git/push-tag", payload),
    gitPushAllTags: (payload) => fetchJson("/api/git/push-all-tags", payload),
    gitDeleteRemoteTag: (payload) => fetchJson("/api/git/delete-remote-tag", payload),
    gitForcePushWithLease: (payload) => fetchJson("/api/git/force-push-with-lease", payload),
    gitListBranches: (payload) => fetchJson("/api/git/list-branches", payload),
    gitDeleteBranch: (payload) => fetchJson("/api/git/delete-branch", payload),
    gitDeleteRemoteBranch: (payload) => fetchJson("/api/git/delete-remote-branch", payload),
    gitRenameBranch: (payload) => fetchJson("/api/git/rename-branch", payload),
    gitCheckoutRemoteBranch: (payload) => fetchJson("/api/git/checkout-remote-branch", payload),
    gitLogGraph: (payload) => fetchJson("/api/git/log-graph", payload),
    // Forward the whole payload so backendId/contextName/workspaceId reach the
    // server (the desktop preload does the same). The HTTP handler picks the
    // fields it cares about; extras like workspaceId are ignored harmlessly.
    dockerAction: (payload: unknown) => fetchJson("/api/docker/action", payload),
    openDockerSession: (payload) => fetchJson("/api/docker/open-session", payload),
    openLazydockerSession: (payload) => fetchJson("/api/docker/open-lazydocker", payload),
    dockerLogsOpen: (payload) => fetchJson("/api/docker/logs/open", payload),
    dockerLogsUpdate: (payload) => fetchJson("/api/docker/logs/update", payload) as Promise<{ ok: boolean }>,
    dockerLogsClose: (payload) => fetchJson("/api/docker/logs/close", payload),
    dockerComposeAction: (payload) => fetchJson("/api/docker/compose-action", payload),
    // `fetchJson` returns `Promise<unknown>`; the StridetermAPI signatures
    // are stricter (Promise<string>, Promise<{...}>). We cast at the boundary
    // — runtime types match because the server returns the same JSON shape
    // that the Electron preload exposes.
    dockerInspect: (payload) => fetchJson("/api/docker/inspect", payload) as Promise<string>,
    dockerTop: (payload) => fetchJson("/api/docker/top", payload) as Promise<string>,
    dockerStats: (payload) =>
      fetchJson("/api/docker/stats", payload) as Promise<{
        cpuPerc: string;
        memUsage: string;
        memPerc: string;
        netIO: string;
        blockIO: string;
        pids: string;
      } | null>,
    dockerImageInspect: (payload) => fetchJson("/api/docker/image/inspect", payload) as Promise<string>,
    dockerVolumeInspect: (payload) => fetchJson("/api/docker/volume/inspect", payload) as Promise<string>,
    dockerNetworkInspect: (payload) => fetchJson("/api/docker/network/inspect", payload) as Promise<string>,
    dockerImageRemove: (payload) => fetchJson("/api/docker/image/remove", payload),
    dockerVolumeRemove: (payload) => fetchJson("/api/docker/volume/remove", payload),
    dockerNetworkRemove: (payload) => fetchJson("/api/docker/network/remove", payload),
    dockerImagePull: (payload) => fetchJson("/api/docker/image/pull", payload),
    dockerImagePrune: (payload) => fetchJson("/api/docker/image/prune", payload),
    dockerVolumePrune: (payload) => fetchJson("/api/docker/volume/prune", payload),
    dockerNetworkPrune: (payload) => fetchJson("/api/docker/network/prune", payload),
    dockerBuilderPrune: (payload) => fetchJson("/api/docker/builder/prune", payload),
    dockerSystemDf: (payload) => fetchJson("/api/docker/system/df", payload) as Promise<string>,
    dockerVolumeList: (payload) => fetchJson("/api/docker/volume/list", payload) as Promise<string>,
    dockerVolumeRead: (payload) => fetchJson("/api/docker/volume/read", payload) as Promise<string>,
    // Log stream subscription — the server pushes "docker:logs:write" and
    // "docker:logs:close" messages over the WS for every connected client.
    onDockerLogsWrite: (handler: (payload: { sessionId: string; data: string }) => void) =>
      listeners.dockerLogsWrite.add(handler),
    onDockerLogsClose: (handler: (payload: { sessionId: string; code: number | null }) => void) =>
      listeners.dockerLogsClose.add(handler),
    openLazygitSession: (payload) => fetchJson("/api/git/open-lazygit", payload),
    createWorktree: (payload) => fetchJson("/api/git/create-worktree", payload),
    saveProfile: (profile) => fetchJson("/api/profile/save", { profile }),
    deleteProfile: (profileId) => fetchJson("/api/profile/delete", { profileId }),
    activateProfile: (profileId) => fetchJson("/api/remote-client/profile/activate", { profileId }),
    activateWorkspace: (workspaceId) => fetchJson("/api/remote-client/workspace/activate", { workspaceId }),
    fileList: (p) => fetchJson("/api/file/list", p),
    fileTree: (p) => fetchJson("/api/file/tree", p),
    filePreview: (p) => fetchJson("/api/file/preview", p),
    fileRead: (p) => fetchJson("/api/file/read", p),
    fileWrite: (p) => fetchJson("/api/file/write", p),
    fileCreateFile: (p) => fetchJson("/api/file/create-file", p),
    fileCreateDir: (p) => fetchJson("/api/file/create-dir", p),
    fileRename: (p) => fetchJson("/api/file/rename", p),
    fileDelete: (p) => fetchJson("/api/file/delete", p),
    fileMove: (p) => fetchJson("/api/file/move", p),
    fileCopy: (p) => fetchJson("/api/file/copy", p),
    fileOpenInExplorer: (p) => fetchJson("/api/file/open-in-explorer", p),
    fileClipboardCopy: (p) => fetchJson("/api/file/clipboard-copy", p),
    fileOpenInEditor: (p) => fetchJson("/api/file/open-in-editor", p),
    fileInfo: (p) => fetchJson("/api/file/info", p),
    fileGitStatus: (p) => fetchJson("/api/file/git-status", p),
    fileGitRefs: (p) => fetchJson("/api/file/git-refs", p),
    fileGitDiff: (p) => fetchJson("/api/file/git-diff", p),
    fileCommitFiles: (p) => fetchJson("/api/file/commit-files", p),
    fileCommitDiff: (p) => fetchJson("/api/file/commit-diff", p),

    sshHostsList: () => fetchJson("/api/ssh/hosts/list", {}),
    sshHostsCreate: (payload) => fetchJson("/api/ssh/hosts/create", payload),
    sshHostsUpdate: (payload) => fetchJson("/api/ssh/hosts/update", payload),
    sshHostsDelete: (payload) => fetchJson("/api/ssh/hosts/delete", payload),
    sshHostsDuplicate: (payload) => fetchJson("/api/ssh/hosts/duplicate", payload),
    sshHostsTest: (payload) => fetchJson("/api/ssh/hosts/test", payload),
    sshKeysList: () => fetchJson("/api/ssh/keys/list", {}),
    sshKeysImport: (payload) => fetchJson("/api/ssh/keys/import", payload),
    sshKeysGenerate: (payload) => fetchJson("/api/ssh/keys/generate", payload),
    sshKeysDelete: (payload) => fetchJson("/api/ssh/keys/delete", payload),
    sshCertsList: () => fetchJson("/api/ssh/certs/list", {}),
    sshCertsImport: (payload) => fetchJson("/api/ssh/certs/import", payload),
    sshCertsDelete: (payload) => fetchJson("/api/ssh/certs/delete", payload),
    sshAuthAnswer: (payload) => fetchJson("/api/ssh/auth/answer", payload),
    sshAuthCancel: (payload) => fetchJson("/api/ssh/auth/cancel", payload),
    sshHostKeyAccept: (payload) => fetchJson("/api/ssh/host-key/accept", payload),
    sshHostKeyReject: (payload) => fetchJson("/api/ssh/host-key/reject", payload),
    sshConfigPreview: (payload) => fetchJson("/api/ssh/config/preview", payload),
    sshConfigImport: (payload) => fetchJson("/api/ssh/config/import", payload),
    sshKnownHostsImport: (payload) => fetchJson("/api/ssh/known-hosts/import", payload),

    resizeTerminal: (sessionId: string, size: TerminalSize) =>
      send({ type: "terminal:resize", sessionId, cols: size.cols, rows: size.rows }),
    writeTerminal: (sessionId: string, data: string) => send({ type: "terminal:input", sessionId, data }),
    onStateUpdated: (handler: Handler<StatePayload>) => listeners.stateUpdated.add(handler),
    onTerminalData: (handler: Handler<TerminalDataPayload>) => listeners.terminalData.add(handler),
    onTerminalExit: (handler: Handler<TerminalExitPayload>) => listeners.terminalExit.add(handler),
    onConnectionState: (handler: Handler<ConnectionStatePayload>) => listeners.connectionState.add(handler),
    onSshAuthPrompt: (handler: Handler<SshAuthRequest>) => listeners.sshAuthPrompt.add(handler),
    onSshHostKeyChange: (handler: Handler<Record<string, unknown>>) => listeners.sshHostKeyChange.add(handler),
    onSshState: (handler: Handler<Record<string, unknown>>) => listeners.sshState.add(handler),
    onSshConnectionState: (handler: Handler<SshConnectionState>) => listeners.sshConnectionState.add(handler),
    getRemoteToken: () => token,
    setRemoteToken: (nextToken: string) => {
      persistToken(nextToken);
      window.location.reload();
    },
  };
}

export function createTransport(): Transport {
  if (window.strideterm) {
    return bindElectronTransport();
  }

  return createRemoteTransport();
}
