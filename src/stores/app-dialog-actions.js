import { cloneWorkspace } from "../workspace-state.js";

/**
 * Factory for dialog / overlay / context-menu / layout-picker actions.
 *
 * @param {object} ctx  Shared refs and helpers injected by the app store.
 *   overlay, overlayProps, contextMenu, layoutPickerAnchor,
 *   payload, activeViewId, activeSessionId, splitGroup, suppressBroadcast,
 *   hiddenViewIds, getApi, withSuppressedBroadcast, getPanelByViewId,
 *   createWorktree
 */
export function createDialogActions(ctx) {
  // --- Dialog / overlay --------------------------------------------------

  function openDialog(name, props = {}) {
    ctx.overlay.value = name;
    ctx.overlayProps.value = props;
  }

  function closeDialog() {
    ctx.overlay.value = null;
    ctx.overlayProps.value = {};
  }

  // --- Context menu ------------------------------------------------------

  function showContextMenu(x, y, viewId) {
    ctx.contextMenu.value = { x, y, viewId };
  }

  function hideContextMenu() {
    ctx.contextMenu.value = null;
  }

  // --- Layout picker -----------------------------------------------------

  function showLayoutPicker(anchorRect) {
    ctx.layoutPickerAnchor.value = anchorRect;
  }

  function hideLayoutPicker() {
    ctx.layoutPickerAnchor.value = null;
  }

  // --- Tab rename dialog -------------------------------------------------

  function renameTabWithDialog(viewId) {
    const target = ctx.getPanelByViewId(viewId);
    if (!target) return;
    openDialog("TextInputDialog", {
      eyebrow: "Workspace",
      title: "Rename tab",
      label: "Tab name",
      value: target.panel.title || "",
      submitLabel: "Rename",
      onCancel: closeDialog,
      onSubmit: async (nextTitle) => {
        const trimmedTitle = nextTitle.trim();
        if (!trimmedTitle || trimmedTitle === target.panel.title) {
          closeDialog();
          return;
        }
        const nextWorkspace = cloneWorkspace(target.workspace);
        nextWorkspace.panels = nextWorkspace.panels.map((p) =>
          p.id === target.panel.id ? { ...p, title: trimmedTitle } : p,
        );
        ctx.payload.value = await ctx.getApi().saveWorkspace(nextWorkspace);
        closeDialog();
      },
    });
  }

  // --- Workspace dialog --------------------------------------------------

  function isBrowserPanel(panel = {}) {
    return /^https?:\/\//i.test(String(panel.command || "").trim());
  }

  function openWorkspaceDialog(workspace = null) {
    const tabTemplates = ctx.payload.value?.appState?.tabTemplates || [];
    openDialog("WorkspaceDialog", {
      workspace,
      tabTemplates,
      onCancel: closeDialog,
      onSubmit: async (draft) => {
        try {
          const isNew = !workspace;
          if (isNew) draft.profileId = ctx.payload.value?.appState?.activeProfileId || "default";
          // Guard: preserve task workspace identity on edit (kind + task object must survive)
          if (!isNew && workspace.kind === "task" && workspace.task) {
            draft.kind = "task";
            draft.task = { ...workspace.task, description: draft.task?.description ?? workspace.task.description };
          }
          const firstPanel = draft.panels?.[0];
          if (draft.kind === "azure") {
            ctx.activeViewId.value = `azure:${draft.id}`;
          } else if (draft.kind === "github") {
            ctx.activeViewId.value = `github:${draft.id}`;
          } else if (firstPanel) {
            ctx.activeViewId.value = isBrowserPanel(firstPanel)
              ? `browser:${firstPanel.id}`
              : `${draft.id}:${firstPanel.id}`;
          }
          // Strip reactive proxies — IPC structuredClone cannot handle Vue Proxy objects
          const plain = JSON.parse(JSON.stringify(draft));
          await ctx.withSuppressedBroadcast(async () => {
            ctx.payload.value = await ctx.getApi().saveWorkspace(plain);
            if (isNew) {
              ctx.payload.value = await ctx.getApi().activateWorkspace(plain.id);
            }
          });
        } catch (err) {
          console.error("[workspace-dialog] save failed:", err);
        } finally {
          closeDialog();
        }
      },
    });
  }

  function openNewWorkspaceFlow() {
    const plugins = ctx.payload.value?.plugins || [];
    // Always show picker — it includes the Task Runner option alongside plugins and empty workspace
    openDialog("NewWorkspacePicker", {
      plugins,
      onCancel: closeDialog,
      onPickEmpty: () => {
        closeDialog();
        openWorkspaceDialog();
      },
      onPickTask: () => {
        closeDialog();
        openTaskWorkspaceDialog();
      },
      onPickPlugin: (pluginId) => {
        closeDialog();
        const plugin = plugins.find((p) => p.id === pluginId);
        if (!plugin?.workspaceDefaults) {
          openWorkspaceDialog();
          return;
        }
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
    });
  }

  // --- Settings / help / profiles / azure connection dialogs -------------

  function openSettingsDialog() {
    openDialog("SettingsDialog", {
      settings: ctx.payload.value?.appState?.settings || {},
      tabTemplates: ctx.payload.value?.appState?.tabTemplates || [],
      appVersion: ctx.payload.value?.meta?.appVersion || "",
      repositoryUrl: ctx.payload.value?.meta?.repositoryUrl || "",
      versionCheck: ctx.payload.value?.meta?.versionCheck || null,
      onCancel: closeDialog,
      onSave: async (patch) => {
        try {
          ctx.payload.value = await ctx.getApi().updateSettings(patch);
          closeDialog();
        } catch (err) {
          ctx.overlayProps.value = {
            ...ctx.overlayProps.value,
            saveError: err.message || "Failed to save settings",
          };
        }
      },
    });
  }

  function openHelpDialog() {
    openDialog("HelpDialog", { onClose: closeDialog });
  }

  function openProfilesDialog() {
    const appState = ctx.payload.value?.appState || {};
    openDialog("ProfilesDialog", {
      profiles: JSON.parse(JSON.stringify(appState.profiles || [])),
      activeProfileId: appState.activeProfileId || "default",
      workspaces: appState.workspaces || [],
      onCancel: closeDialog,
      onSave: async (profile) => {
        ctx.payload.value = await ctx.getApi().saveProfile(profile);
      },
      onActivate: async (profileId) => {
        ctx.suppressBroadcast.value = true;
        try {
          ctx.payload.value = await ctx.getApi().activateProfile(profileId);
        } catch (err) {
          ctx.suppressBroadcast.value = false;
          throw err;
        }
        ctx.activeViewId.value = null;
        ctx.activeSessionId.value = null;
        ctx.splitGroup.value = null;
        closeDialog();
        setTimeout(() => {
          ctx.suppressBroadcast.value = false;
        }, 200);
      },
      onDelete: async (profileId) => {
        ctx.payload.value = await ctx.getApi().deleteProfile(profileId);
      },
    });
  }

  function openAzureConnectionDialog(connectionId = "") {
    const azureSettings = ctx.payload.value?.appState?.settings?.integrations?.azureDevops || {};
    const connection = (azureSettings.connections || []).find((c) => c.id === connectionId) || null;
    openDialog("AzureConnectionDialog", {
      connection,
      defaultReviewRoot: azureSettings.reviewRoot || "",
      onCancel: closeDialog,
      onSave: async (draft) => {
        draft.profileId = ctx.payload.value?.appState?.activeProfileId || "default";
        const result = await ctx.getApi().saveAzureConnection(draft);
        ctx.payload.value = result.payload || result;
        closeDialog();
      },
    });
  }

  function openGitHubConnectionDialog(connectionId = "") {
    const ghSettings = ctx.payload.value?.appState?.settings?.integrations?.github || {};
    const connection = (ghSettings.connections || []).find((c) => c.id === connectionId) || null;
    openDialog("GitHubConnectionDialog", {
      connection,
      defaultReviewRoot: ghSettings.reviewRoot || "",
      onCancel: closeDialog,
      onSave: async (draft) => {
        draft.profileId = ctx.payload.value?.appState?.activeProfileId || "default";
        const result = await ctx.getApi().saveGitHubConnection(draft);
        ctx.payload.value = result.payload || result;
        closeDialog();
      },
    });
  }

  function openGitHubQuickFixWizard() {
    const ghSettings = ctx.payload.value?.appState?.settings?.integrations?.github || {};
    const connections = (ghSettings.connections || []).filter((c) => c.enabled !== false);
    if (!connections.length) {
      openGitHubConnectionDialog("");
      return;
    }
    openDialog("QuickFixWizardDialog", {
      provider: "github",
      connections,
      onCancel: closeDialog,
      onCreate: (result) => {
        closeDialog();
        if (result) {
          ctx.payload.value = result;
          ctx.activeViewId.value = null;
          ctx.splitGroup.value = null;
        }
      },
    });
  }

  // --- Quick Fix wizard ---------------------------------------------------

  function openQuickFixWizard() {
    const azureSettings = ctx.payload.value?.appState?.settings?.integrations?.azureDevops || {};
    const connections = (azureSettings.connections || []).filter((c) => c.enabled !== false);
    if (!connections.length) {
      openAzureConnectionDialog("");
      return;
    }
    openDialog("QuickFixWizardDialog", {
      connections,
      onCancel: closeDialog,
      onCreate: (result) => {
        closeDialog();
        if (result) {
          ctx.payload.value = result;
          ctx.activeViewId.value = null;
          ctx.splitGroup.value = null;
        }
      },
    });
  }

  // --- Worktree dialog ---------------------------------------------------

  function createWorktreeWithDialog(workspaceId) {
    openDialog("TextInputDialog", {
      eyebrow: "Git",
      title: "New worktree",
      label: "Branch name",
      value: "",
      submitLabel: "Create",
      onCancel: closeDialog,
      onSubmit: async (name) => {
        closeDialog();
        await ctx.createWorktree(workspaceId, name);
      },
    });
  }

  function openTaskWorkspaceDialog() {
    const ws = ctx.payload.value?.workspace;
    const activeWorkspace = ws?.workspace || ws?.project || null;
    // Re-check Claude CLI availability in the background so the dialog
    // shows up-to-date status (user may have installed claude mid-session)
    ctx
      .getApi()
      .recheckClaude?.()
      .then((result) => {
        if (result?.payload) ctx.payload.value = result.payload;
      })
      .catch(() => {});
    openDialog("TaskWorkspaceDialog", {
      initialCwd: activeWorkspace?.cwd || "",
      onCancel: closeDialog,
      onSubmit: async (config) => {
        try {
          // Auto-detect parent workspace by matching cwd within the active profile
          if (!config.parentWorkspaceId) {
            const normCwd = (config.cwd || "")
              .replace(/[\\/]+$/, "")
              .replace(/\\/g, "/")
              .toLowerCase();
            const activeProfileId = ctx.payload.value?.appState?.activeProfileId || "default";
            const workspaces = ctx.payload.value?.appState?.workspaces || [];
            const parent = workspaces.find(
              (ws) =>
                ws.kind !== "task" &&
                (ws.profileId || "default") === activeProfileId &&
                (ws.cwd || "")
                  .replace(/[\\/]+$/, "")
                  .replace(/\\/g, "/")
                  .toLowerCase() === normCwd,
            );
            if (parent) config.parentWorkspaceId = parent.id;
          }
          const result = await ctx.getApi().createTaskWorkspace(config);
          if (result?.payload) {
            ctx.payload.value = result.payload;
          }
          closeDialog();
          // Show warning if another task workspace uses the same directory
          if (result?.cwdWarning) {
            console.warn("[task-workspace] cwd conflict:", result.cwdWarning);
            // Surface the warning via a notification so the user sees it
            const notifStore = (await import("./notifications.js")).useNotificationStore();
            notifStore.add({
              title: "Task workspace warning",
              body: result.cwdWarning,
              kind: "warning",
              workspaceId: result.workspaceId || "",
              workspaceName: config.description || "Task workspace",
              tabName: "",
              viewId: "",
            });
          }
        } catch (err) {
          console.error("[task-workspace] create failed:", err);
        }
      },
    });
  }

  async function doStartTask(workspaceId) {
    const api = ctx.getApi();
    try {
      const result = await api.startTask({ workspaceId });
      if (result?.payload) ctx.payload.value = result.payload;
    } catch (err) {
      console.error("[task] start failed:", err);
    }
  }

  async function startTaskWithHookCheck(workspaceId) {
    const api = ctx.getApi();
    // Check if agent hook setting is enabled
    const settings = ctx.payload.value?.appState?.settings?.notifications;
    const hookSettingEnabled = settings?.agentHook !== false;

    // If setting is off, hooks can't work — show dialog immediately
    if (!hookSettingEnabled) {
      openDialog("TaskHookCheckDialog", {
        needsSettingEnable: true,
        onCancel: closeDialog,
        onSkip: () => {
          closeDialog();
          doStartTask(workspaceId);
        },
        onConfigure: async () => {
          closeDialog();
          try {
            // Enable the setting first
            const settingsResult = await api.updateSettings({
              notifications: { ...settings, agentHook: true },
            });
            if (settingsResult?.payload) ctx.payload.value = settingsResult.payload;
            // Then configure the hook in Claude Code
            await api.configureAgentHook();
          } catch (err) {
            console.error("[task] hook configure failed:", err);
          }
          await doStartTask(workspaceId);
        },
      });
      return;
    }

    // Setting is on — check if hook is actually configured in Claude Code
    try {
      const hookResult = await api.getAgentHookStatus();
      if (hookResult?.status === "configured") {
        // All good — start immediately
        await doStartTask(workspaceId);
        return;
      }
    } catch {
      // Can't check — start anyway, don't block
      await doStartTask(workspaceId);
      return;
    }

    // Hook not configured — show dialog
    openDialog("TaskHookCheckDialog", {
      needsSettingEnable: false,
      onCancel: closeDialog,
      onSkip: () => {
        closeDialog();
        doStartTask(workspaceId);
      },
      onConfigure: async () => {
        closeDialog();
        try {
          await api.configureAgentHook();
        } catch (err) {
          console.error("[task] hook configure failed:", err);
        }
        await doStartTask(workspaceId);
      },
    });
  }

  return {
    openDialog,
    closeDialog,
    showContextMenu,
    hideContextMenu,
    showLayoutPicker,
    hideLayoutPicker,
    renameTabWithDialog,
    openWorkspaceDialog,
    openNewWorkspaceFlow,
    openSettingsDialog,
    openHelpDialog,
    openProfilesDialog,
    openAzureConnectionDialog,
    openGitHubConnectionDialog,
    openGitHubQuickFixWizard,
    openQuickFixWizard,
    createWorktreeWithDialog,
    openTaskWorkspaceDialog,
    startTaskWithHookCheck,
  };
}
