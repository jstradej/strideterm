import { defineStore } from "pinia";
import { ref, shallowRef, computed, watch } from "vue";
import {
  getWorkspaceTabs,
  getVisibleTabs,
  summarizeAttention,
  getWorkspacePanelByViewId,
  getWorkspaceAttention,
  getTabAttention,
} from "../app/selectors.js";
import { statusTone } from "../workspace-state.js";
import { readSidebarCollapsed, isContainerRunning, isGitViewId, isDockerViewId, isAzureViewId, isGitHubViewId, isReviewViewId } from "../app/helpers.js";
import { createDialogActions } from "./app-dialog-actions.js";
import { createWorkspaceActions } from "./app-workspace-actions.js";
import { createApiActions } from "./app-api-actions.js";

export const useAppStore = defineStore("app", () => {
  // --- Server payload (shallowRef for performance — never deeply reactive) ---
  const payload = shallowRef(null);

  // --- UI state ---
  const activeViewId = ref(null);
  const activeSessionId = ref(null);
  const splitGroup = ref(null); // { layout, viewIds } | null
  const hiddenViewIds = ref(new Set());
  const sidebarCollapsed = ref(readSidebarCollapsed());
  const overlay = ref(null);       // Vue component name string | null
  const overlayProps = ref({});
  const bootstrapError = ref("");
  const remoteConnectionIssue = ref("");
  const remoteAccessExpanded = ref(false);
  const remoteAccessMode = ref("lan"); // "lan" | "cloudflare" | "vps"
  const selectedLanUrl = ref("");
  const contextMenu = ref(null);    // { x, y, viewId } | null
  const layoutPickerAnchor = ref(null); // DOMRect | null (for positioning)

  // --- Race condition prevention ---
  const pendingWorkspaceActivationId = ref("");
  const pendingViewActivationId = ref("");
  const suppressBroadcast = ref(false);

  // --- Workspace state cache (avoids tab-status flicker on switch) ---
  // Stores workspace-specific payload parts keyed by workspace ID.
  // On switch-back, cached data is restored instantly during the optimistic phase,
  // so tabs keep their real statuses ("running"/"idle") instead of flashing to "idle".
  const _workspacePayloadCache = new Map();

  // --- Per-workspace split layout cache ---
  // Preserves split configuration when switching away from a workspace,
  // so the layout is restored when the user returns.
  const _splitGroupCache = new Map();

  // --- Error handling ---
  const lastError = ref(null); // { label, message, timestamp } | null

  function dismissError() {
    lastError.value = null;
  }

  // --- Internal api reference (set in init) ---
  let _api = null;

  /** Getter so action modules can access _api after init(). */
  function getApi() {
    return _api;
  }

  // --- Memoized computed ---
  // These computed properties return the same reference when the result is structurally
  // identical, preventing unnecessary downstream re-renders on every payload broadcast.

  // --- Memoized computed ---
  // These return the same reference when the result is structurally identical,
  // preventing unnecessary downstream re-renders on every payload broadcast.
  // Each fingerprint must include ALL fields that downstream consumers read.

  const activeWorkspace = computed(() => {
    const ws = payload.value?.workspace;
    return ws?.workspace || ws?.project || null;
  });

  let _prevFilteredWsKey = "";
  let _prevFilteredWs = [];
  const filteredWorkspaces = computed(() => {
    const workspaces = payload.value?.appState?.workspaces || [];
    const activeProfileId = payload.value?.appState?.activeProfileId || "default";
    const result = workspaces.filter((ws) => (ws.profileId || "default") === activeProfileId);
    // Include names and panel counts — these change on rename/add-tab/remove-tab
    const key = result.map((ws) => `${ws.id}:${ws.name}:${(ws.panels || []).length}:${ws.connectionId || ""}`).join(",");
    if (key === _prevFilteredWsKey) return _prevFilteredWs;
    _prevFilteredWsKey = key;
    _prevFilteredWs = result;
    return result;
  });

  let _prevProfileKey = "";
  let _prevProfile = null;
  const activeProfile = computed(() => {
    const profiles = payload.value?.appState?.profiles || [];
    const activeId = payload.value?.appState?.activeProfileId || "default";
    const found = profiles.find((p) => p.id === activeId) || { id: "default", name: "Default", color: "#ffa424" };
    const key = `${found.id}:${found.name}:${found.color}`;
    if (key === _prevProfileKey && _prevProfile) return _prevProfile;
    _prevProfileKey = key;
    _prevProfile = found;
    return found;
  });

  let _prevAttention = { count: 0, waitingCount: 0 };
  const attentionSummary = computed(() => {
    const next = summarizeAttention(payload.value);
    if (next.count === _prevAttention.count && next.waitingCount === _prevAttention.waitingCount) {
      return _prevAttention;
    }
    _prevAttention = next;
    return next;
  });

  let _prevTabsKey = "";
  let _prevTabs = [];
  const workspaceTabs = computed(() => {
    const workspace = payload.value?.workspace;
    if (!workspace) return [];
    const result = getWorkspaceTabs({
      workspace,
      payload: payload.value,
      hiddenViewIds: hiddenViewIds.value,
      statusTone,
      isContainerRunning,
    });
    // Fingerprint includes all visible fields: id, title, status, tone
    const key = result.map((t) => `${t.id}:${t.title}:${t.status}:${t.tone}`).join("|");
    if (key === _prevTabsKey) return _prevTabs;
    _prevTabsKey = key;
    _prevTabs = result;
    return result;
  });

  const visibleTabs = computed(() => {
    const result = getVisibleTabs({
      tabs: workspaceTabs.value,
      activeViewId: activeViewId.value,
      splitGroup: splitGroup.value,
      isInSplitGroup: (viewId, sg) => sg?.viewIds.includes(viewId) || false,
    });
    return result.visibleTabs;
  });

  // Auto-mark notifications as read when switching to the relevant tab
  watch(activeViewId, async (viewId) => {
    if (!viewId) return;
    try {
      const { useNotificationStore } = await import("./notifications.js");
      const notifStore = useNotificationStore();
      for (const item of notifStore.items) {
        if (!item.read && item.viewId && item.viewId === viewId) {
          notifStore.markRead(item.id);
        }
      }
    } catch {
      // Notification store may not be available during bootstrap
    }
  });

  // Keep per-workspace split cache in sync with current splitGroup
  watch(splitGroup, (next) => {
    const wsId = payload.value?.appState?.activeWorkspaceId;
    if (!wsId) return;
    if (next) {
      _splitGroupCache.set(wsId, next);
    } else {
      _splitGroupCache.delete(wsId);
    }
  });

  // Normalize activeViewId and splitGroup when tabs change
  watch(workspaceTabs, (tabs) => {
    const validIds = new Set(tabs.map((t) => t.id));
    if (!activeViewId.value || !validIds.has(activeViewId.value)) {
      activeViewId.value = tabs[0]?.id || null;
    }
    if (splitGroup.value) {
      const validSplitIds = splitGroup.value.viewIds.filter((id) => validIds.has(id));
      if (validSplitIds.length < 2) {
        splitGroup.value = null;
      } else if (validSplitIds.length !== splitGroup.value.viewIds.length) {
        splitGroup.value = { ...splitGroup.value, viewIds: validSplitIds };
      }
    }
  });

  // --- Helpers ---

  /** Save workspace-specific payload parts for the current workspace. */
  function _cacheCurrentWorkspace() {
    const p = payload.value;
    const wsId = p?.appState?.activeWorkspaceId;
    if (!wsId || !p?.workspace) return;
    _workspacePayloadCache.set(wsId, {
      workspace: p.workspace,
      docker: p.docker,
      attention: p.attention,
      activeWorkspaceGit: p.git?.activeWorkspace,
      activeProjectGit: p.git?.activeProject,
    });
  }

  function buildWorkspacePayloadSnapshot(workspaceId) {
    const appState = payload.value?.appState;
    if (!appState) return null;
    const workspace = (appState.workspaces || []).find((ws) => ws.id === workspaceId);
    if (!workspace) return null;

    // Strategy 2: return full cached workspace payload if available
    const cached = _workspacePayloadCache.get(workspaceId);
    if (cached?.workspace) return cached.workspace;

    // Strategy 1 fallback: build snapshot, no cache → status stays "idle"
    return {
      workspace,
      project: workspace,
      sessions: (workspace.panels || [])
        .filter((panel) => !/^https?:\/\//i.test(panel.command || ""))
        .map((panel) => ({
          sessionId: `${workspace.id}:${panel.id}`,
          panelId: panel.id,
          title: panel.title,
          command: panel.command,
          launch: panel.launch,
          startup: panel.startup,
          status: "idle",
        })),
    };
  }

  function applyOptimisticWorkspaceActivation(workspaceId) {
    const appState = payload.value?.appState;
    if (!appState || !(appState.workspaces || []).some((ws) => ws.id === workspaceId)) {
      return false;
    }

    // Cache current workspace state before switching away
    _cacheCurrentWorkspace();

    pendingWorkspaceActivationId.value = workspaceId;

    const cached = _workspacePayloadCache.get(workspaceId);
    const prevGit = payload.value.git;
    payload.value = {
      ...payload.value,
      appState: { ...appState, activeWorkspaceId: workspaceId, activeProjectId: workspaceId },
      workspace: buildWorkspacePayloadSnapshot(workspaceId),
      // Restore cached workspace-specific data (docker, attention, active git)
      ...(cached ? {
        docker: cached.docker ?? payload.value.docker,
        attention: cached.attention ?? payload.value.attention,
        git: {
          ...prevGit,
          activeWorkspace: cached.activeWorkspaceGit ?? prevGit?.activeWorkspace,
          activeProject: cached.activeProjectGit ?? prevGit?.activeProject,
        },
      } : {}),
    };
    return true;
  }

  // --- Broadcast handler ---
  function handleBroadcastPayload(nextPayload) {
    const pendingWsId = pendingWorkspaceActivationId.value;
    const incomingWsId = nextPayload?.appState?.activeWorkspaceId || "";
    const isBootstrap = Boolean(nextPayload?.meta?.bootstrap);

    if (pendingWsId && incomingWsId && incomingWsId !== pendingWsId) return;
    if (pendingWsId && incomingWsId === pendingWsId && !isBootstrap) {
      pendingWorkspaceActivationId.value = "";
    }

    bootstrapError.value = "";
    clearRemoteConnectionIssue();

    if (nextPayload?.appState?.activeWorkspaceId !== payload.value?.appState?.activeWorkspaceId) {
      const prevWsId = payload.value?.appState?.activeWorkspaceId;
      if (prevWsId && splitGroup.value) {
        _splitGroupCache.set(prevWsId, splitGroup.value);
      }
      const nextWsId = nextPayload?.appState?.activeWorkspaceId;
      splitGroup.value = (nextWsId && _splitGroupCache.get(nextWsId)) || null;
    }

    if (pendingViewActivationId.value) {
      const nextWorkspace = nextPayload?.workspace;
      const nextTabs = nextWorkspace
        ? getWorkspaceTabs({ workspace: nextWorkspace, payload: nextPayload, hiddenViewIds: hiddenViewIds.value, statusTone, isContainerRunning })
        : [];
      if (!nextTabs.some((tab) => tab.id === pendingViewActivationId.value)) return;
      activeViewId.value = pendingViewActivationId.value;
      activeSessionId.value = pendingViewActivationId.value;
      if (!isBootstrap) pendingViewActivationId.value = "";
    }

    if (suppressBroadcast.value) return;
    payload.value = nextPayload;
    // Keep workspace cache fresh on every broadcast for the active workspace
    _cacheCurrentWorkspace();
  }

  // --- Actions ---
  async function withSuppressedBroadcast(fn) {
    suppressBroadcast.value = true;
    try {
      return await fn();
    } finally {
      setTimeout(() => { suppressBroadcast.value = false; }, 200);
    }
  }

  async function activateWorkspace(workspaceId) {
    const prevWsId = payload.value?.appState?.activeWorkspaceId;
    if (prevWsId && splitGroup.value) {
      _splitGroupCache.set(prevWsId, splitGroup.value);
    }
    applyOptimisticWorkspaceActivation(workspaceId);
    splitGroup.value = _splitGroupCache.get(workspaceId) || null;
    activeViewId.value = null;
    activeSessionId.value = null;
    try {
      const nextPayload = await _api.activateWorkspace(workspaceId);
      if (!pendingWorkspaceActivationId.value || nextPayload?.appState?.activeWorkspaceId === pendingWorkspaceActivationId.value) {
        payload.value = nextPayload;
        // Update cache with fresh server data for the newly activated workspace
        _cacheCurrentWorkspace();
        if (!nextPayload?.meta?.bootstrap) pendingWorkspaceActivationId.value = "";
      }
    } catch {
      pendingWorkspaceActivationId.value = "";
    }
  }

  async function activateView(viewId, { focus = true } = {}) {
    if (!viewId || viewId === activeViewId.value) return;

    activeViewId.value = viewId;
    if (isGitViewId(viewId) || isDockerViewId(viewId) || isAzureViewId(viewId) || isReviewViewId(viewId)) {
      pendingViewActivationId.value = "";
      activeSessionId.value = null;
      // Refresh git data on-demand when the Git tab is activated
      if (isGitViewId(viewId) && _api) {
        const wsId = payload.value?.appState?.activeWorkspaceId;
        if (wsId) {
          _api.refreshGit(wsId).then((nextPayload) => {
            if (nextPayload && !pendingWorkspaceActivationId.value) {
              payload.value = nextPayload;
              _cacheCurrentWorkspace();
            }
          }).catch(() => {});
        }
      }
      return;
    }

    pendingViewActivationId.value = viewId;
    activeSessionId.value = viewId;

    try {
      const nextPayload = await _api.activateSession(viewId);
      if (pendingViewActivationId.value === viewId && !nextPayload?.meta?.bootstrap) {
        pendingViewActivationId.value = "";
      }
      payload.value = nextPayload;
    } catch {
      if (pendingViewActivationId.value === viewId) {
        pendingViewActivationId.value = "";
      }
    }
  }

  function setRemoteConnectionIssue(message) {
    remoteConnectionIssue.value = String(message || "").trim();
  }

  function clearRemoteConnectionIssue() {
    remoteConnectionIssue.value = "";
  }

  // --- Selectors exposed for components ---
  function getGitSnapshot(workspaceId) {
    return payload.value?.git?.workspaces?.[workspaceId] || payload.value?.git?.projects?.[workspaceId] || null;
  }

  function getWorkspaceAttentionForId(workspaceId) {
    return getWorkspaceAttention(payload.value, workspaceId);
  }

  function getTabAttentionForView(workspaceId, viewId) {
    return getTabAttention(payload.value, workspaceId, viewId, { isGitViewId, isDockerViewId });
  }

  function getPanelByViewId(viewId, workspace = payload.value?.workspace) {
    return getWorkspacePanelByViewId(viewId, workspace, { isGitViewId, isDockerViewId, isAzureViewId, isGitHubViewId, isReviewViewId });
  }

  // --- Delegated action groups ---
  const workspaceActions = createWorkspaceActions({
    payload, activeViewId, activeSessionId, splitGroup, hiddenViewIds,
    workspaceTabs, getApi, withSuppressedBroadcast,
  });

  const dialogActions = createDialogActions({
    overlay, overlayProps, contextMenu, layoutPickerAnchor,
    payload, activeViewId, activeSessionId, splitGroup, suppressBroadcast,
    hiddenViewIds, getApi, withSuppressedBroadcast, getPanelByViewId,
    createWorktree: workspaceActions.createWorktree,
  });

  // --- Init ---
  function init(api) {
    _api = api;

    api.onStateUpdated((nextPayload) => handleBroadcastPayload(nextPayload));

    api.onConnectionState?.((connection) => {
      if (connection?.connected) {
        clearRemoteConnectionIssue();
        return;
      }
      if (connection?.message) setRemoteConnectionIssue(connection.message);
    });

    window.addEventListener("unhandledrejection", (event) => {
      const error = event.reason;
      if (!error?.isRemoteTransport) return;
      if (error.message) setRemoteConnectionIssue(error.message);
      event.preventDefault();
    });

    api.getState()
      .then((nextPayload) => {
        const pendingWsId = pendingWorkspaceActivationId.value;
        const incomingWsId = nextPayload?.appState?.activeWorkspaceId || "";
        const isBootstrap = Boolean(nextPayload?.meta?.bootstrap);

        if (pendingWsId && incomingWsId && incomingWsId !== pendingWsId) return;
        if (pendingWsId && incomingWsId === pendingWsId && !isBootstrap) {
          pendingWorkspaceActivationId.value = "";
        }

        bootstrapError.value = "";
        clearRemoteConnectionIssue();

        if (pendingViewActivationId.value) {
          const nextWorkspace = nextPayload?.workspace;
          const nextTabs = nextWorkspace
            ? getWorkspaceTabs({ workspace: nextWorkspace, payload: nextPayload, hiddenViewIds: hiddenViewIds.value, statusTone, isContainerRunning })
            : [];
          if (nextTabs.some((tab) => tab.id === pendingViewActivationId.value)) {
            activeViewId.value = pendingViewActivationId.value;
            activeSessionId.value = pendingViewActivationId.value;
            if (!isBootstrap) pendingViewActivationId.value = "";
          }
        }

        payload.value = nextPayload;
        // Seed cache with the initial workspace state on bootstrap
        _cacheCurrentWorkspace();
      })
      .catch((error) => {
        const message = error?.message?.includes("401")
          ? "Remote token is missing or invalid. Use the token from the desktop strIDEterm state file."
          : error?.message || "Unknown startup error.";
        bootstrapError.value = message;
      });
  }

  // --- Domain API actions (azure, review, docker, remote, profile) ---
  const apiActions = createApiActions({
    payload, activeViewId, activeSessionId, splitGroup,
    remoteAccessExpanded, remoteAccessMode, selectedLanUrl,
    getApi, withSuppressedBroadcast,
  });

  return {
    // State
    payload, activeViewId, activeSessionId, splitGroup, hiddenViewIds,
    sidebarCollapsed, overlay, overlayProps, bootstrapError, remoteConnectionIssue,
    remoteAccessExpanded, remoteAccessMode, selectedLanUrl,
    contextMenu, layoutPickerAnchor,
    pendingWorkspaceActivationId, pendingViewActivationId, suppressBroadcast,
    lastError,
    // Computed
    activeWorkspace, filteredWorkspaces, activeProfile, attentionSummary,
    workspaceTabs, visibleTabs,
    // Core actions
    init, handleBroadcastPayload, withSuppressedBroadcast,
    activateWorkspace, activateView,
    setRemoteConnectionIssue, clearRemoteConnectionIssue,
    dismissError, getApi,
    // Delegated dialog actions
    ...dialogActions,
    // Delegated workspace actions
    ...workspaceActions,
    // Delegated API actions (azure, review, docker, remote, profile)
    ...apiActions,
    // Selectors
    getGitSnapshot, getWorkspaceAttentionForId, getTabAttentionForView, getPanelByViewId,
  };
});
