import type { StatePayload } from "../../electron/shared/types/state.js";

// ---------------------------------------------------------------------------
// Local structural types
// ---------------------------------------------------------------------------

interface RuntimeTab {
  id: string;
  [key: string]: unknown;
}

interface RuntimeWorkspace {
  [key: string]: unknown;
}

interface RuntimeState {
  pendingWorkspaceActivationId: string;
  bootstrapError: string;
  payload: StatePayload | null;
  splitGroup: unknown;
  pendingViewActivationId: string;
  activeViewId: string | null;
  activeSessionId: string | null;
  overlay: unknown;
  _suppressBroadcastRender: boolean;
  [key: string]: unknown;
}

interface ConnectionState {
  connected: boolean;
  message?: string;
}

interface RuntimeApi {
  onStateUpdated: (handler: (payload: StatePayload) => void) => void;
  onTerminalData: (handler: (payload: { sessionId: string; data: string }) => void) => void;
  onTerminalExit: (handler: (payload: { sessionId: string; exitCode: number; intentional?: boolean }) => void) => void;
  onConnectionState?: (handler: (connection: ConnectionState) => void) => void;
  activateWorkspace: (workspaceId: string) => Promise<unknown>;
  restartTerminal: (sessionId: string) => Promise<unknown>;
  getState: () => Promise<StatePayload>;
}

interface TerminalControllerLike {
  handleTerminalData: (payload: { sessionId: string; data: string }) => void;
  handleTerminalExit: (payload: { sessionId: string; exitCode: number; intentional?: boolean }) => void;
}

// ---------------------------------------------------------------------------

function readActiveAttention(payload: StatePayload | null | undefined, workspaceId: string): unknown {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const att = payload?.attention as any;
  return att?.byWorkspace?.[workspaceId] || att?.byProject?.[workspaceId] || null;
}

function readActiveGitSnapshot(payload: StatePayload | null | undefined, workspaceId: string): unknown {
  return payload?.git?.workspaces?.[workspaceId] || payload?.git?.projects?.[workspaceId] || null;
}

function readActiveReviewBridge(payload: StatePayload | null | undefined, reviewPrKey: string): unknown {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pullRequests = (payload?.reviewBridge as any)?.pullRequests as Record<string, any> | undefined;
  const context: Record<string, unknown> | null = reviewPrKey ? pullRequests?.[reviewPrKey] || null : null;
  if (!context) {
    return null;
  }
  return {
    prKey: context.prKey,
    exportDir: context.exportDir,
    comments: ((context.comments as unknown[]) || []).map((c) => {
      const comment = c as Record<string, unknown>;
      return {
        commentKey: comment.commentKey,
        commentKind: comment.commentKind,
        displayIndex: comment.displayIndex,
        remoteThreadId: comment.remoteThreadId,
        title: comment.title,
        summary: comment.summary,
        status: comment.status,
        priority: comment.priority,
        updatedAt: comment.updatedAt,
        payload: comment.payload || {},
      };
    }),
    drafts: ((context.drafts as unknown[]) || []).map((d) => {
      const draft = d as Record<string, unknown>;
      return {
        draftId: draft.draftId,
        commentKey: draft.commentKey,
        body: draft.body,
        status: draft.status,
        authorAgent: draft.authorAgent,
        updatedAt: draft.updatedAt,
      };
    }),
    syncQueue: ((context.syncQueue as unknown[]) || []).map((it) => {
      const item = it as Record<string, unknown>;
      return {
        queueId: item.queueId,
        operation: item.operation,
        status: item.status,
        attempts: item.attempts,
        lastError: item.lastError,
        updatedAt: item.updatedAt,
      };
    }),
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

function selectActiveWorkspaceRenderState(payload: StatePayload | null | undefined): unknown {
  const activeWorkspaceId = payload?.appState?.activeWorkspaceId || "";
  const activeWorkspace =
    (payload?.appState?.workspaces || []).find((workspace) => workspace.id === activeWorkspaceId) || null;
  const reviewProvider = activeWorkspace?.review?.provider || "";
  const reviewPrKey = ["azure-devops", "github"].includes(reviewProvider) ? (activeWorkspace?.review?.prKey ?? "") : "";

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const azureDevops = payload?.azureDevops as any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const github = payload?.github as any;

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
      reviewProvider === "azure-devops" && reviewPrKey ? azureDevops?.pullRequests?.[reviewPrKey] || null : null,
    githubReview: reviewProvider === "github" && reviewPrKey ? github?.pullRequests?.[reviewPrKey] || null : null,
    reviewBridge: readActiveReviewBridge(payload, reviewPrKey),
  };
}

/**
 * Pull just the fields the active workspace's render decision depends on,
 * keeping the original references whenever the source payload still has them.
 * Used by `shouldRenderActiveWorkspace` to short-circuit on shallow reference
 * equality before falling back to a deeper compare. Building wrapper objects
 * (like `selectActiveWorkspaceRenderState` does for the bridge view) defeats
 * reference equality, so this variant intentionally avoids any per-call
 * allocation that creates fresh inner references.
 */
function selectActiveWorkspaceRenderRefs(payload: StatePayload | null | undefined): {
  activeWorkspaceId: string;
  activeWorkspace: unknown;
  workspacePayload: unknown;
  attention: unknown;
  git: unknown;
  docker: unknown;
  azureInbox: unknown;
  githubInbox: unknown;
  azureReview: unknown;
  githubReview: unknown;
  reviewBridgePr: unknown;
} {
  const activeWorkspaceId = payload?.appState?.activeWorkspaceId || "";
  const activeWorkspace =
    (payload?.appState?.workspaces || []).find((workspace) => workspace.id === activeWorkspaceId) || null;
  const reviewProvider = activeWorkspace?.review?.provider || "";
  const reviewPrKey = ["azure-devops", "github"].includes(reviewProvider) ? (activeWorkspace?.review?.prKey ?? "") : "";

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const azureDevops = payload?.azureDevops as any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const github = payload?.github as any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const reviewBridge = payload?.reviewBridge as any;

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
      reviewProvider === "azure-devops" && reviewPrKey ? azureDevops?.pullRequests?.[reviewPrKey] || null : null,
    githubReview: reviewProvider === "github" && reviewPrKey ? github?.pullRequests?.[reviewPrKey] || null : null,
    reviewBridgePr: reviewPrKey ? reviewBridge?.pullRequests?.[reviewPrKey] || null : null,
  };
}

export function shouldRenderActiveWorkspace(
  nextPayload: StatePayload | null | undefined,
  previousPayload: StatePayload | null | undefined,
): boolean {
  if (!previousPayload) {
    return true;
  }
  // Whole-payload reference identity: nothing changed at all.
  if (nextPayload === previousPayload) {
    return false;
  }
  // Fast path: compare only the source slices the active workspace reads, by
  // reference. This is enough for the common case (terminal output, telegram
  // poll, agent snapshots — all high-frequency unrelated subtrees) and avoids
  // a JSON.stringify of the entire workspace + review bridge subtree on every
  // broadcast.
  const nextRefs = selectActiveWorkspaceRenderRefs(nextPayload);
  const prevRefs = selectActiveWorkspaceRenderRefs(previousPayload);
  let allEqual = true;
  for (const key of Object.keys(nextRefs) as Array<keyof typeof nextRefs>) {
    if (nextRefs[key] !== prevRefs[key]) {
      allEqual = false;
      break;
    }
  }
  if (allEqual) {
    return false;
  }
  // Slow path: at least one slice changed by reference. The change might still
  // be cosmetic (e.g. the manager rebuilt an array but the contents are equal),
  // so fall back to a structural compare on just the wrapper shape — same
  // semantics as the previous implementation, just only when needed.
  return (
    JSON.stringify(selectActiveWorkspaceRenderState(nextPayload)) !==
    JSON.stringify(selectActiveWorkspaceRenderState(previousPayload))
  );
}

const _splitGroupCache = new Map<string, unknown>();

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
}: {
  api: RuntimeApi;
  state: RuntimeState;
  terminalStage: Element;
  focusActiveTerminal: () => void;
  render: () => void;
  renderBackground?: () => void;
  renderBootstrapError: (message: string) => void;
  clearRemoteConnectionIssue: () => void;
  setRemoteConnectionIssue: (message: string) => void;
  openNewWorkspaceFlow: () => Promise<void>;
  getFilteredWorkspaces: () => Array<{ id: string }>;
  shortcutTabDirection: (event: KeyboardEvent) => number;
  getWorkspace: () => RuntimeWorkspace | null;
  getWorkspaceTabs: (workspace: RuntimeWorkspace) => RuntimeTab[];
  activateView: (id: string) => Promise<void>;
  scheduleActiveResize: () => void;
  isGitViewId: (v: unknown) => boolean;
  isDockerViewId: (v: unknown) => boolean;
  isAzureViewId: (v: unknown) => boolean;
  isReviewViewId: (v: unknown) => boolean;
  isBrowserViewId: (v: unknown) => boolean;
  terminalController: TerminalControllerLike;
}): void {
  api.onStateUpdated((payload) => {
    const pendingWorkspaceId = state.pendingWorkspaceActivationId || "";
    const incomingWorkspaceId = payload?.appState?.activeWorkspaceId || "";
    const isBootstrapPayload = Boolean((payload?.meta as unknown as Record<string, unknown> | undefined)?.bootstrap);
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
      const nextWorkspace = payload?.workspace as RuntimeWorkspace | null;
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
    const error = event.reason as Record<string, unknown> | undefined;
    if (!error?.isRemoteTransport) {
      return;
    }

    if (error.message) {
      setRemoteConnectionIssue(String(error.message));
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
            state.payload = (await api.activateWorkspace(workspaces[index].id)) as StatePayload;
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
        state.payload = (await api.restartTerminal(state.activeSessionId)) as StatePayload;
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
    const mouseEvent = event as MouseEvent;
    const target = mouseEvent.target as Element | null;
    const pane = target?.closest(".workspace-pane") as HTMLElement | null;
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
        document.documentElement.style.height = `${window.visualViewport!.height}px`;
        scheduleActiveResize();
      });
    });
  }

  api
    .getState()
    .then((payload) => {
      const pendingWorkspaceId = state.pendingWorkspaceActivationId || "";
      const incomingWorkspaceId = payload?.appState?.activeWorkspaceId || "";
      const isBootstrapPayload = Boolean((payload?.meta as unknown as Record<string, unknown> | undefined)?.bootstrap);
      if (pendingWorkspaceId && incomingWorkspaceId && incomingWorkspaceId !== pendingWorkspaceId) {
        return;
      }
      if (pendingWorkspaceId && incomingWorkspaceId === pendingWorkspaceId && !isBootstrapPayload) {
        state.pendingWorkspaceActivationId = "";
      }
      state.bootstrapError = "";
      clearRemoteConnectionIssue();
      if (state.pendingViewActivationId) {
        const nextWorkspace = payload?.workspace as RuntimeWorkspace | null;
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
    .catch((error: unknown) => {
      const err = error as { message?: string } | null | undefined;
      const message = err?.message?.includes("401")
        ? "Remote token is missing or invalid. Use the token from the desktop strIDEterm state file."
        : err?.message || "Unknown startup error.";
      renderBootstrapError(message);
    });
}
