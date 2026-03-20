export function createDialogActionController({
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
}) {
  function openWorkspaceDialog(workspace = null) {
    closeOverlay();
    state.overlay = createWorkspaceDialog({
      workspace,
      api,
      tabTemplates: state.payload?.appState?.tabTemplates || [],
      onCancel: closeOverlay,
      onSubmit: async (draft) => {
        // Assign to active profile if creating new workspace
        if (!workspace) {
          draft.profileId = state.payload?.appState?.activeProfileId || "default";
        }
        // Suppress broadcastState render to prevent activeViewId race
        const firstPanel = draft.panels?.[0];
        if (firstPanel) {
          const isBrowser = /^https?:\/\//i.test(firstPanel.command || "");
          state.activeViewId = isBrowser ? `browser:${firstPanel.id}` : `${draft.id}:${firstPanel.id}`;
        }
        state._suppressBroadcastRender = true;
        state.payload = await api.saveWorkspace(draft);
        state._suppressBroadcastRender = false;
        closeOverlay();
        // Delay render to next frame after overlay is removed from DOM
        await new Promise((r) => requestAnimationFrame(r));
        render();
        focusActiveTerminal();
      },
    });
    document.body.append(state.overlay);
    requestAnimationFrame(() => {
      const firstInput = state.overlay?.querySelector('input[name="cwd"]') || state.overlay?.querySelector('input[name="name"]');
      if (firstInput) firstInput.focus();
    });
  }

  async function openNewWorkspaceFlow() {
    closeOverlay();
    const plugins = state.payload?.plugins || [];
    if (plugins.some((plugin) => plugin.workspaceDefaults && !plugin.error)) {
      state.overlay = createNewWorkspacePicker({
        plugins,
        onPickEmpty: () => { closeOverlay(); openWorkspaceDialog(); },
        onPickPlugin: async (pluginId) => {
          closeOverlay();
          const plugin = plugins.find((entry) => entry.id === pluginId);
          if (!plugin?.workspaceDefaults) { openWorkspaceDialog(); return; }
          const tpl = plugin.workspaceDefaults;
          const draft = {
            id: `workspace-${crypto.randomUUID()}`,
            name: tpl.name || plugin.name,
            icon: tpl.icon || plugin.icon || "PL",
            color: tpl.color || plugin.color || "#ffa424",
            kind: tpl.kind || "terminal",
            source: "plugin",
            pluginId,
            cwd: "",
            notes: tpl.notes || "",
            activePanelId: tpl.panels?.[0]?.id || "",
            panels: (tpl.panels || []).map((panel) => ({ ...panel })),
          };
          openWorkspaceDialog(draft);
        },
        onCancel: closeOverlay,
      });
      document.body.append(state.overlay);
      return;
    }

    openWorkspaceDialog();
  }

  function openSettingsDialog() {
    closeOverlay();
    state.overlay = createSettingsDialog({
      api,
      settings: state.payload.appState.settings,
      tabTemplates: state.payload.appState.tabTemplates || [],
      appVersion: state.payload.meta?.appVersion || "",
      repositoryUrl: state.payload.meta?.repositoryUrl || "",
      onCancel: closeOverlay,
      onSave: async (patch) => {
        state.payload = await api.updateSettings(patch);
        closeOverlay();
        render();
      },
    });
    document.body.append(state.overlay);
  }

  function openAzureConnectionDialog(connectionId = "") {
    closeOverlay();
    const azureSettings = state.payload?.appState?.settings?.integrations?.azureDevops || {};
    const connection = (azureSettings.connections || []).find((entry) => entry.id === connectionId) || null;
    state.overlay = createAzureConnectionDialog({
      connection,
      defaultReviewRoot: azureSettings.reviewRoot || "",
      api,
      onCancel: closeOverlay,
      onSave: async (draft) => {
        state.payload = await api.saveAzureConnection(draft);
        closeOverlay();
        render();
      },
    });
    document.body.append(state.overlay);
    requestAnimationFrame(() => {
      state.overlay?.querySelector('input[name="label"]')?.focus();
    });
  }

  function openHelpDialog() {
    closeOverlay();
    state.overlay = createHelpDialog({ onClose: closeOverlay });
    document.body.append(state.overlay);
  }

  function openProfilesDialog() {
    closeOverlay();
    const appState = state.payload.appState;
    state.overlay = createProfilesDialog({
      profiles: JSON.parse(JSON.stringify(appState.profiles || [])),
      activeProfileId: appState.activeProfileId || "default",
      workspaces: appState.workspaces,
      onCancel: closeOverlay,
      onSave: async (profile) => {
        state.payload = await api.saveProfile(profile);
        render();
      },
      onActivate: async (profileId) => {
        state._suppressBroadcastRender = true;
        try {
          state.payload = await api.activateProfile(profileId);
        } finally {
          state._suppressBroadcastRender = false;
        }
        state.activeViewId = null;
        state.activeSessionId = null;
        state.attachedSessionId = null;
        state.splitGroup = null;
        closeOverlay();
        render();
        focusActiveTerminal();
      },
      onDelete: async (profileId) => {
        state.payload = await api.deleteProfile(profileId);
        render();
      },
    });
    document.body.append(state.overlay);
  }

  async function renameWorkspacePanel(viewId) {
    const target = getWorkspacePanelByViewId(viewId);
    if (!target) {
      return;
    }

    closeOverlay();
    state.overlay = createTextInputDialog({
      eyebrow: "Workspace",
      title: "Rename tab",
      label: "Tab name",
      value: target.panel.title || "",
      submitLabel: "Rename",
      onCancel: closeOverlay,
      onSubmit: async (nextTitle) => {
        const trimmedTitle = nextTitle.trim();
        if (!trimmedTitle || trimmedTitle === target.panel.title) {
          closeOverlay();
          focusActiveTerminal();
          return;
        }

        const nextWorkspace = cloneWorkspace(target.workspace);
        nextWorkspace.panels = nextWorkspace.panels.map((panel) => (
          panel.id === target.panel.id
            ? { ...panel, title: trimmedTitle }
            : panel
        ));
        state.payload = await api.saveWorkspace(nextWorkspace);
        closeOverlay();
        render();
        focusActiveTerminal();
      },
    });
    document.body.append(state.overlay);
    requestAnimationFrame(() => {
      const input = state.overlay?.querySelector('input[name="value"]');
      input?.focus();
      input?.select();
    });
  }

  async function reorderWorkspacePanels(draggedViewId, dropViewId, insertBefore) {
    const draggedTarget = getWorkspacePanelByViewId(draggedViewId);
    const dropTarget = getWorkspacePanelByViewId(dropViewId);
    if (!draggedTarget || !dropTarget || draggedTarget.workspace.id !== dropTarget.workspace.id) {
      return false;
    }

    const nextWorkspace = cloneWorkspace(draggedTarget.workspace);
    const fromIndex = nextWorkspace.panels.findIndex((panel) => panel.id === draggedTarget.panel.id);
    const toIndex = nextWorkspace.panels.findIndex((panel) => panel.id === dropTarget.panel.id);
    if (fromIndex < 0 || toIndex < 0 || fromIndex === toIndex) {
      return;
    }

    const [movedPanel] = nextWorkspace.panels.splice(fromIndex, 1);
    const insertionIndex = insertBefore
      ? toIndex - (fromIndex < toIndex ? 1 : 0)
      : toIndex + (fromIndex < toIndex ? 0 : 1);
    nextWorkspace.panels.splice(Math.max(0, insertionIndex), 0, movedPanel);

    state.payload = await api.saveWorkspace(nextWorkspace);
    render();
    focusActiveTerminal();
    return true;
  }

  async function activateView(viewId, { focus = true } = {}) {
    if (!viewId) {
      return;
    }
    if (viewId === state.activeViewId) {
      if (focus) {
        focusActiveTerminal();
      }
      return;
    }

    state.activeViewId = viewId;
    if (isGitViewId(viewId) || isDockerViewId(viewId) || isAzureViewId(viewId) || isReviewViewId(viewId)) {
      state.pendingViewActivationId = "";
      state.activeSessionId = null;
      render();
      if (focus) {
        focusActiveTerminal();
      }
      return;
    }

    state.pendingViewActivationId = viewId;
    state.activeSessionId = viewId;
    render();
    if (focus) {
      focusActiveTerminal();
    }

    try {
      state.payload = await api.activateSession(viewId);
      if (state.pendingViewActivationId === viewId && !state.payload?.meta?.bootstrap) {
        state.pendingViewActivationId = "";
      }
      render();
      if (focus) {
        focusActiveTerminal();
      }
    } catch (error) {
      if (state.pendingViewActivationId === viewId) {
        state.pendingViewActivationId = "";
      }
      throw error;
    }
  }

  return {
    activateView,
    openAzureConnectionDialog,
    openHelpDialog,
    openNewWorkspaceFlow,
    openProfilesDialog,
    openSettingsDialog,
    openWorkspaceDialog,
    createTextAreaDialog,
    renameWorkspacePanel,
    reorderWorkspacePanels,
  };
}
