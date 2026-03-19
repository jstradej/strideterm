import QRCode from "qrcode";
import { cloneWorkspace, normalizeWorkspaces, statusTone } from "./workspace-state.js";
import { APP_CONFIG } from "../config/app-config.js";
import {
  downloadTextFile,
  isAzureViewId,
  getWindowsPtyOptions,
  isBrowserViewId,
  isContainerRunning,
  isDockerViewId,
  isGitViewId,
  isReviewViewId,
  openTerminalLink,
  preferredRemoteUrl,
  readSidebarCollapsed,
  readSidebarWidth,
  safeFilenamePart,
  withRemoteToken,
  writeSidebarCollapsed,
  writeSidebarWidth,
} from "./app/helpers.js";
import { createTerminalController } from "./app/terminal-controller.js";
import {
  createAzureConnectionDialog,
  createHelpDialog,
  createNewWorkspacePicker,
  createProfilesDialog,
  createSettingsDialog,
  createTextAreaDialog,
  createTextInputDialog,
  createWorkspaceDialog,
} from "./app/dialogs.js";
import {
  getActiveRemoteShareUrl as getRemoteShareUrl,
  getRemoteQrTarget,
  renderRemoteAccessCard as renderRemoteAccessCardMarkup,
} from "./app/remote-access.js";
import { createActionHandlers } from "./app/action-handlers.js";
import {
  renderBrowserUrlBar,
  buildTabStripModel,
  buildWorkspaceCards,
  renderEmptyTerminalState,
  renderTabActions,
  renderWelcomeScreen,
  renderWorkspaceHero,
} from "./app/workspace-render.js";
import { wireRuntimeBindings } from "./app/runtime-bindings.js";
import { createChromeController } from "./app/chrome-controller.js";
import { createWorkspaceUiController } from "./app/workspace-ui-controller.js";
import { createDialogActionController } from "./app/dialog-action-controller.js";
import {
  getTabAttention as selectTabAttention,
  getVisibleTabs as selectVisibleTabs,
  getWorkspaceAttention as selectWorkspaceAttention,
  getWorkspacePanelByViewId as selectWorkspacePanelByViewId,
  getWorkspaceTabs as selectWorkspaceTabs,
  summarizeAttention as selectAttentionSummary,
} from "./app/selectors.js";
import {
  renderDockerMarkup as renderDockerPaneMarkup,
  renderGitMarkup as renderGitPaneMarkup,
} from "./app/pane-markup.js";
import {
  renderAzureInboxView as renderAzureInboxPaneMarkup,
  renderAzureReviewView as renderAzureReviewPaneMarkup,
} from "./ui/azure-devops-view.js";
import { renderSidebarFooter, renderSidebarList } from "./ui/sidebar-view.js";
import { renderTabStrip } from "./ui/tab-strip-view.js";
import { renderRemoteAccessMarkup } from "./ui/remote-access-view.js";
import { renderAppShell } from "./ui/app-shell-view.js";
import { renderPaneShell } from "./ui/pane-view.js";

export function createApp(root, { api }) {
  const LAYOUTS = {
    solo:         { slots: 1, label: "Solo" },
    cols:         { slots: 2, label: "Side by side" },
    rows:         { slots: 2, label: "Stacked" },
    "top-split":  { slots: 3, label: "Top + 2 bottom" },
    "left-split": { slots: 3, label: "Left + 2 right" },
    grid:         { slots: 4, label: "Grid" },
  };

  const AREA_NAMES = ["a", "b", "c", "d"];
  const AREA_LAYOUTS = new Set(["top-split", "left-split"]);

  function isInSplitGroup(viewId) {
    return state.splitGroup?.viewIds.includes(viewId) || false;
  }

  function activeSplitLayout() {
    return isInSplitGroup(state.activeViewId) ? state.splitGroup.layout : "solo";
  }

  const state = {
    payload: null,
    activeViewId: null,
    activeSessionId: null,
    attachedSessionId: null,
    splitGroup: null, // { layout: "cols", viewIds: ["id1", "id2"] } | null
    hiddenViewIds: new Set(),
    overlay: null,
    bootstrapError: "",
    remoteConnectionIssue: "",
    remoteAccessExpanded: false,
    remoteAccessMode: "lan", // "lan" | "cloudflare" | "vps"
    selectedLanUrl: "", // user-picked LAN URL override
    remoteQrUrl: "",
    remoteQrKey: "",
    attentionSyncKey: "",
    browserBadgeKey: "",
    documentTitleBase: document.title || "strIDEterm",
    sidebarCollapsed: readSidebarCollapsed(),
    gitUiState: {},
    tabOrder: [],
    terminalViews: new Map(),
    terminalBuffers: new Map(),
    lastBackendViewId: null,
    pendingWorkspaceActivationId: "",
    pendingViewActivationId: "",
  };

  const terminalController = createTerminalController({
    state,
    api,
    appConfig: APP_CONFIG,
    openTerminalLink,
    getWindowsPtyOptions,
    shortcutTabDirection,
    downloadTextFile,
    safeFilenamePart,
  });

  function setRemoteConnectionIssue(message) {
    const nextMessage = String(message || "").trim();
    if (state.remoteConnectionIssue === nextMessage) {
      return;
    }
    state.remoteConnectionIssue = nextMessage;
    if (state.payload && !state.bootstrapError) {
      render();
    }
  }

  function clearRemoteConnectionIssue() {
    if (!state.remoteConnectionIssue) {
      return;
    }
    state.remoteConnectionIssue = "";
    if (state.payload && !state.bootstrapError) {
      render();
    }
  }

  function summarizeAttention() {
    return selectAttentionSummary(state.payload);
  }

  function getActiveProfile() {
    const profiles = state.payload?.appState?.profiles || [];
    const activeId = state.payload?.appState?.activeProfileId || "default";
    return profiles.find((p) => p.id === activeId) || { id: "default", name: "Default", color: "#ffa424" };
  }

  function syncBrowserAttentionBadge() {
    const { count, waitingCount } = summarizeAttention();
    const profile = getActiveProfile();
    const profileLabel = profile.id !== "default" ? ` [${profile.name}]` : "";
    const base = state.documentTitleBase + profileLabel;
    document.title = count > 0 ? `(${count}) ${base}` : base;

    const nextKey = `${count}:${waitingCount}:${profile.id}`;
    if (state.browserBadgeKey === nextKey) {
      return;
    }

    state.browserBadgeKey = nextKey;
    if (typeof navigator.setAppBadge === "function") {
      const action = count > 0
        ? navigator.setAppBadge(count)
        : navigator.clearAppBadge?.();
      action?.catch?.(() => {});
    }

  }

  renderAppShell(root, {
    isRemote: api.isRemote,
    sidebarCollapsed: state.sidebarCollapsed,
  });

  const workspaceList = root.querySelector('[data-role="workspace-list"]');
  const remoteAccess = root.querySelector('[data-role="remote-access"]');
  const sidebarFooter = root.querySelector('[data-role="sidebar-footer"]');
  const workspaceHero = root.querySelector('[data-role="workspace-hero"]');
  const tabStrip = root.querySelector('[data-role="tab-strip"]');
  const tabActions = root.querySelector('[data-role="tab-actions"]');
  const terminalStage = root.querySelector('[data-role="terminal-stage"]');
  const frame = root.querySelector(".frame");

  const savedSidebarWidth = readSidebarWidth();
  if (savedSidebarWidth) {
    frame.style.setProperty("--sidebar-width", `${savedSidebarWidth}px`);
  }

  // ── Mobile sidebar toggle ──
  const sidebar = root.querySelector(".sidebar");
  const sidebarBackdrop = root.querySelector('[data-role="sidebar-backdrop"]');
  const sidebarCollapseButton = root.querySelector('[data-role="sidebar-collapse"]');
  const chromeController = createChromeController({
    state,
    api,
    root,
    frame,
    sidebar,
    sidebarBackdrop,
    sidebarCollapseButton,
    workspaceList,
    tabStrip,
    terminalStage,
    layouts: LAYOUTS,
    writeSidebarCollapsed,
    writeSidebarWidth,
    isInSplitGroup,
    activeSplitLayout,
    isGitViewId,
    isDockerViewId,
    getWorkspacePanelByViewId,
    openWorkspaceDialog: (workspace) => openWorkspaceDialog(workspace),
    renameWorkspacePanel: (viewId) => renameWorkspacePanel(viewId),
    reorderWorkspacePanels: (draggedViewId, dropViewId, insertBefore) => reorderWorkspacePanels(draggedViewId, dropViewId, insertBefore),
    scheduleActiveResize: (options) => scheduleActiveResize(options),
    render,
  });
  const openSidebar = () => chromeController.openSidebar();
  const closeSidebar = () => chromeController.closeSidebar();
  const syncSidebarCollapsed = () => chromeController.syncSidebarCollapsed();
  const hideContextMenu = () => chromeController.hideContextMenu();
  const hideLayoutPicker = () => chromeController.hideLayoutPicker();
  const showLayoutPicker = (anchorElement) => chromeController.showLayoutPicker(anchorElement);
  const closeOverlay = () => chromeController.closeOverlay();
  const clearBootstrapError = () => chromeController.clearBootstrapError();
  const renderBootstrapError = (message) => chromeController.renderBootstrapError(message);
  chromeController.wireChromeInteractions();

  function getWorkspace() {
    return state.payload?.workspace || null;
  }

  function getActiveWorkspace() {
    return getWorkspace()?.workspace || getWorkspace()?.project || null;
  }

  function getGitSnapshot(workspaceId) {
    return state.payload?.git?.workspaces?.[workspaceId] || state.payload?.git?.projects?.[workspaceId] || null;
  }

  function getWorkspaceAttention(workspaceId) {
    return selectWorkspaceAttention(state.payload, workspaceId);
  }

  function getTabAttention(workspaceId, viewId) {
    return selectTabAttention(state.payload, workspaceId, viewId, { isGitViewId, isDockerViewId });
  }

  function getWorkspaceTabs(workspace) {
    return selectWorkspaceTabs({
      workspace,
      payload: state.payload,
      hiddenViewIds: state.hiddenViewIds,
      statusTone,
      isContainerRunning,
    });
  }

  function getVisibleTabs(tabs) {
    const next = selectVisibleTabs({
      tabs,
      activeViewId: state.activeViewId,
      splitGroup: state.splitGroup,
      isInSplitGroup: (viewId, splitGroup) => splitGroup?.viewIds.includes(viewId) || false,
    });
    state.activeViewId = next.activeViewId;
    state.splitGroup = next.splitGroup;
    return next.visibleTabs;
  }

  function shortcutTabDirection(event) {
    const key = String(event?.key || "");
    const code = String(event?.code || "");
    if (key === "PageDown" || key === "Next" || code === "PageDown") {
      return 1;
    }
    if (key === "PageUp" || key === "Prior" || code === "PageUp") {
      return -1;
    }
    return 0;
  }

  function getWorkspacePanelByViewId(viewId, workspace = getWorkspace()) {
    return selectWorkspacePanelByViewId(viewId, workspace, { isGitViewId, isDockerViewId, isAzureViewId, isReviewViewId });
  }
  const dialogActionController = createDialogActionController({
    state,
    api,
    closeOverlay,
    focusActiveTerminal,
    render,
    getWorkspace,
    getWorkspacePanelByViewId,
    getWorkspaceTabs,
    isGitViewId,
    isDockerViewId,
    isAzureViewId,
    isReviewViewId,
    cloneWorkspace,
    createAzureConnectionDialog,
    createWorkspaceDialog,
    createNewWorkspacePicker,
    createSettingsDialog,
    createHelpDialog,
    createProfilesDialog,
    createTextAreaDialog,
    createTextInputDialog,
  });

  function openWorkspaceDialog(workspace = null) {
    return dialogActionController.openWorkspaceDialog(workspace);
  }

  async function openNewWorkspaceFlow() {
    return dialogActionController.openNewWorkspaceFlow();
  }

  function openSettingsDialog() {
    return dialogActionController.openSettingsDialog();
  }

  function openHelpDialog() {
    return dialogActionController.openHelpDialog();
  }

  function openProfilesDialog() {
    return dialogActionController.openProfilesDialog();
  }

  async function renameWorkspacePanel(viewId) {
    return dialogActionController.renameWorkspacePanel(viewId);
  }

  async function reorderWorkspacePanels(draggedViewId, dropViewId, insertBefore) {
    return dialogActionController.reorderWorkspacePanels(draggedViewId, dropViewId, insertBefore);
  }

  async function activateView(viewId, options = {}) {
    return dialogActionController.activateView(viewId, options);
  }


  async function copyText(text) {
    if (!text) {
      return;
    }

    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return;
    }

    const helper = document.createElement("textarea");
    helper.value = text;
    helper.setAttribute("readonly", "readonly");
    helper.style.position = "absolute";
    helper.style.left = "-9999px";
    document.body.append(helper);
    helper.select();
    document.execCommand("copy");
    helper.remove();
  }


  function focusActiveTerminal() {
    terminalController.focusActiveTerminal();
  }

  function scheduleActiveResize(options) {
    terminalController.scheduleActiveResize(options);
  }

  const workspaceUiController = createWorkspaceUiController({
    state,
    api,
    appConfig: APP_CONFIG,
      root,
      workspaceList,
      remoteAccess,
      sidebarFooter,
      workspaceHero,
    tabStrip,
    tabActions,
    terminalStage,
    layouts: LAYOUTS,
    areaNames: AREA_NAMES,
    areaLayouts: AREA_LAYOUTS,
    qrCode: QRCode,
    terminalController,
    renderPaneShell,
    renderAzureInboxPaneMarkup,
    renderAzureReviewPaneMarkup,
    renderGitPaneMarkup,
    renderDockerPaneMarkup,
      renderRemoteAccessMarkup,
      renderRemoteAccessCardMarkup,
      renderSidebarList,
      renderSidebarFooter,
      getRemoteQrTarget,
    renderBrowserUrlBar,
    renderEmptyTerminalState,
    renderWelcomeScreen,
    renderWorkspaceHero,
    renderTabActions,
    renderTabStrip,
    buildTabStripModel,
    buildWorkspaceCards,
    normalizeWorkspaces,
    summarizeAttention,
    syncBrowserAttentionBadge,
    isInSplitGroup,
    activeSplitLayout,
    getWorkspace,
    getGitSnapshot,
    getGitUiState: (workspaceId) => state.gitUiState[workspaceId] || {},
    getWorkspaceAttention,
    getTabAttention,
    getWorkspaceTabs,
    getVisibleTabs,
    isGitViewId,
    isDockerViewId,
    isAzureViewId,
    isReviewViewId,
  });
  function getFilteredWorkspaces() {
    return workspaceUiController.getFilteredWorkspaces();
  }

  function readCustomPublicUrl() {
    return workspaceUiController.readCustomPublicUrl();
  }

  function renderRemoteAccess() {
    return workspaceUiController.renderRemoteAccess();
  }

  function renderBackground() {
    return workspaceUiController.renderBackground();
  }

  function render() {
    if (!state.bootstrapError) {
      clearBootstrapError();
    }
    return workspaceUiController.render(renderBootstrapError);
  }

  const actionHandlers = createActionHandlers({
    state,
    api,
    appConfig: APP_CONFIG,
    layouts: LAYOUTS,
    root,
    remoteAccess,
    openSidebar,
    closeSidebar,
    syncSidebarCollapsed,
    closeOverlay,
    hideContextMenu,
    showLayoutPicker,
    hideLayoutPicker,
    openWorkspaceDialog,
    openNewWorkspaceFlow,
    openSettingsDialog,
    openHelpDialog,
    openProfilesDialog,
    openAzureConnectionDialog: dialogActionController.openAzureConnectionDialog,
    activateView,
    renameWorkspacePanel,
    exportTerminalTranscript: terminalController.exportTerminalTranscript,
    clearTerminalViewport: terminalController.clearTerminalViewport,
    focusActiveTerminal,
    getWorkspace,
    getActiveWorkspace,
    getGitSnapshot,
    getWorkspaceTabs,
    render,
    renderRemoteAccess,
    readCustomPublicUrl,
    copyText,
    getRemoteShareUrl: () => getRemoteShareUrl({
      payload: state.payload,
      selectedLanUrl: state.selectedLanUrl,
      remoteAccessExpanded: state.remoteAccessExpanded,
      remoteAccessMode: state.remoteAccessMode,
    }),
    isGitViewId,
    isDockerViewId,
    isAzureViewId,
    isReviewViewId,
    createTextAreaDialog,
    createTextInputDialog,
  });

  remoteAccess.addEventListener("change", async (event) => {
    const input = event.target;
    if (input.dataset.role === "cloudflared-path") {
      const newPath = input.value.trim();
      state.payload = await api.updateSettings({
        remoteAccess: { cloudflaredPath: newPath },
      });
      render();
    }
  });

  root.addEventListener("click", async (event) => {
    const actionElement = event.target.closest("[data-action]");
    const action = actionElement?.dataset.action;
    if (!action) {
      return;
    }

    await actionHandlers.handleRootAction(action, actionElement);
  });
  root.addEventListener("input", async (event) => {
    const actionElement = event.target.closest("[data-action]");
    const action = actionElement?.dataset.action;
    if (action) {
      await actionHandlers.handleRootAction(action, actionElement);
    }
  });
  wireRuntimeBindings({
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
  });
}
