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
import { readSidebarCollapsed, isContainerRunning, isGitViewId, isDockerViewId, isAzureViewId, isReviewViewId } from "../app/helpers.js";
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

  // --- Computed ---
  const activeWorkspace = computed(() => {
    const ws = payload.value?.workspace;
    return ws?.workspace || ws?.project || null;
  });

  const filteredWorkspaces = computed(() => {
    const workspaces = payload.value?.appState?.workspaces || [];
    const activeProfileId = payload.value?.appState?.activeProfileId || "default";
    return workspaces.filter((ws) => (ws.profileId || "default") === activeProfileId);
  });

  const activeProfile = computed(() => {
    const profiles = payload.value?.appState?.profiles || [];
    const activeId = payload.value?.appState?.activeProfileId || "default";
    return profiles.find((p) => p.id === activeId) || { id: "default", name: "Default", color: "#ffa424" };
  });

  const attentionSummary = computed(() => summarizeAttention(payload.value));

  const workspaceTabs = computed(() => {
    const workspace = payload.value?.workspace;
    if (!workspace) return [];
    return getWorkspaceTabs({
      workspace,
      payload: payload.value,
      hiddenViewIds: hiddenViewIds.value,
      statusTone,
      isContainerRunning,
    });
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
  function buildWorkspacePayloadSnapshot(workspaceId) {
    const appState = payload.value?.appState;
    if (!appState) return null;
    const workspace = (appState.workspaces || []).find((ws) => ws.id === workspaceId);
    if (!workspace) return null;
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
    pendingWorkspaceActivationId.value = workspaceId;
    payload.value = {
      ...payload.value,
      appState: { ...appState, activeWorkspaceId: workspaceId, activeProjectId: workspaceId },
      workspace: buildWorkspacePayloadSnapshot(workspaceId),
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
      splitGroup.value = null;
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
    applyOptimisticWorkspaceActivation(workspaceId);
    splitGroup.value = null;
    activeViewId.value = null;
    activeSessionId.value = null;
    try {
      const nextPayload = await _api.activateWorkspace(workspaceId);
      if (!pendingWorkspaceActivationId.value || nextPayload?.appState?.activeWorkspaceId === pendingWorkspaceActivationId.value) {
        payload.value = nextPayload;
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
    return getWorkspacePanelByViewId(viewId, workspace, { isGitViewId, isDockerViewId, isAzureViewId, isReviewViewId });
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
